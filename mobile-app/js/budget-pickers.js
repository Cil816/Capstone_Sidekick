// Budget-aware pickers on the itinerary screen:
//  - askHotel(): before an itinerary is generated, offers hotels near the destination
//    whose researched nightly rate fits the lodging share of the user's budget.
//  - openRestaurants(): after generation, lists restaurants near a day's stops whose
//    price per person fits the meal share of the budget, and adds the chosen one.
(function () {
  // Shares of the whole-trip budget. They match the backend: 40% lodging, 25% activities.
  const MEAL_SHARE = 0.2;
  const MEALS_OUT_PER_DAY = 2;
  const NEARBY_KM = 10;
  // Rough PHP per-person ranges for Google's price levels, used only when a place has
  // no exact price range.
  const PRICE_LEVEL_PHP = {
    PRICE_LEVEL_FREE: [0, 0],
    PRICE_LEVEL_INEXPENSIVE: [100, 300],
    PRICE_LEVEL_MODERATE: [300, 700],
    PRICE_LEVEL_EXPENSIVE: [700, 1500],
    PRICE_LEVEL_VERY_EXPENSIVE: [1500, 4000],
  };
  const FOOD_TYPE = /(restaurant|cafe|coffee|food|bakery|bar_and_grill|diner|eatery|meal_takeaway|meal_delivery)/;
  const LODGING_TYPE = /(^|_)(lodging|hotel|motel|hostel|guest_house|bed_and_breakfast)$/;

  const $ = (id) => document.getElementById(id);
  const esc = (text) => window.SidekickCore.escapeHtml(text);
  const peso = (amount) => `₱${Math.round(Number(amount)).toLocaleString()}`;
  const restaurantCache = new Map();
  let onClose = null;

  function distanceKm(a, b) {
    const toRad = (deg) => (Number(deg) * Math.PI) / 180;
    const dLat = toRad(b.lat) - toRad(a.lat);
    const dLng = toRad(b.lng) - toRad(a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function hasCoords(place) {
    return place && place.lat != null && place.lng != null && place.lat !== "" && place.lng !== ""
      && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng));
  }

  // ---- shared modal -------------------------------------------------------------
  function ensureModal() {
    let modal = $("budget-picker-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "budget-picker-modal";
    modal.className = "budget-picker-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="budget-picker-backdrop" data-picker-close="1"></div>
      <div class="budget-picker-panel" role="dialog" aria-modal="true" aria-labelledby="budget-picker-title">
        <div class="budget-picker-head">
          <h3 id="budget-picker-title"></h3>
          <button type="button" class="budget-picker-x" data-picker-close="1" aria-label="Close">×</button>
        </div>
        <div id="budget-picker-body" class="budget-picker-body"></div>
        <div id="budget-picker-actions" class="budget-picker-actions"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target?.dataset?.pickerClose === "1") close("cancel");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.classList.contains("open")) close("cancel");
    });
    return modal;
  }

  function open(title) {
    const modal = ensureModal();
    $("budget-picker-title").textContent = title;
    $("budget-picker-body").replaceChildren();
    $("budget-picker-actions").replaceChildren();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function close(reason) {
    const modal = $("budget-picker-modal");
    if (!modal || !modal.classList.contains("open")) return;
    if (modal.contains(document.activeElement)) document.activeElement.blur();
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    const callback = onClose;
    onClose = null;
    if (callback) callback(reason);
  }

  function setBody(html) {
    $("budget-picker-body").innerHTML = html;
  }

  function setActions(buttons) {
    const wrap = $("budget-picker-actions");
    wrap.replaceChildren();
    buttons.forEach(({ label, kind = "outline", onClick, id }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn btn-${kind}`;
      button.textContent = label;
      if (id) button.id = id;
      button.addEventListener("click", onClick);
      wrap.appendChild(button);
    });
  }

  function ratingText(place) {
    const rating = Number(place.rating);
    if (!Number.isFinite(rating) || rating <= 0) return "";
    const count = Number(place.ratingCount);
    return `★ ${rating.toFixed(1)}${Number.isFinite(count) && count > 0 ? ` (${count.toLocaleString()})` : ""}`;
  }

  // ---- hotel details (photos and information) ----------------------------------
  const hotelDetailsCache = new Map(); // placeId -> Promise of details (or null)
  let detailsShownFor = "";

  function photoUrl(resource) {
    const name = String(resource || "").trim();
    if (!name || String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return "";
    let base = "";
    try { base = window.SidekickCore.getApiBaseUrl() || ""; } catch (error) { base = ""; }
    if (!base && !window.location.protocol.startsWith("http")) return "";
    return `${base}/api/maps/photo?name=${encodeURIComponent(name)}`;
  }

  function safeLink(url, text) {
    const href = String(url || "");
    return /^https:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
  }

  function priceLines(hotel) {
    const nightly = hotel.nightlyHighPhp > hotel.nightlyLowPhp ? `${peso(hotel.nightlyLowPhp)}–${peso(hotel.nightlyHighPhp)}` : peso(hotel.nightlyLowPhp);
    const stay = hotel.stayHighPhp > hotel.stayLowPhp ? `${peso(hotel.stayLowPhp)}–${peso(hotel.stayHighPhp)}` : peso(hotel.stayLowPhp);
    return { nightly, stay };
  }

  // A photo that fails to load is removed instead of showing a broken image.
  function wirePhotoErrors(container) {
    container?.querySelectorAll(".hotel-photo img").forEach((img) => {
      img.addEventListener("error", () => {
        const figure = img.closest(".hotel-photo");
        const gallery = figure?.parentElement;
        figure?.remove();
        if (gallery && !gallery.children.length) gallery.remove();
      }, { once: true });
    });
  }

  function galleryHtml(photos) {
    const items = photos
      .map((photo) => ({ ...photo, url: photoUrl(photo.resource) }))
      .filter((photo) => photo.url);
    if (!items.length) return "";
    return `<div class="hotel-gallery" role="list" aria-label="Hotel photos">${items.map((photo, index) => `
      <figure class="hotel-photo" role="listitem">
        <img src="${esc(photo.url)}" alt="Photo ${index + 1} of ${items.length}" loading="${index ? "lazy" : "eager"}" />
        ${photo.authorName ? `<figcaption>Photo: ${safeLink(photo.authorUri, photo.authorName)}</figcaption>` : ""}
      </figure>`).join("")}</div>`;
  }

  // Detail view shown at once from what the list already has; fillHotelDetails adds
  // the gallery, description, contact details, hours and reviews.
  // metaText is plain text; fitHtml and noteHtml are markup built with esc()/safeLink().
  function placeDetailsHtml(place, { backLabel, metaText, fitHtml = "", noteHtml = "" }) {
    const firstPhoto = place.photoResource ? [{
      resource: place.photoResource,
      authorName: place.photoAttribution?.name || "",
      authorUri: place.photoAttribution?.uri || "",
    }] : [];
    return `
      <div class="hotel-detail">
        <button type="button" class="hotel-detail-back">‹ ${esc(backLabel)}</button>
        <div id="hotel-detail-gallery">${galleryHtml(firstPhoto)}</div>
        <h4 class="hotel-detail-name">${esc(place.name)}</h4>
        <p class="hotel-detail-meta">${esc(metaText)}</p>
        ${fitHtml}
        ${place.address ? `<p class="hotel-detail-address">${esc(place.address)}</p>` : ""}
        <div id="hotel-detail-extra" class="hotel-detail-extra" aria-live="polite"><p class="budget-picker-status">Loading photos and details…</p></div>
        ${noteHtml}
      </div>`;
  }

  function hotelDetailsHtml(hotel) {
    const { nightly, stay } = priceLines(hotel);
    const sources = (Array.isArray(hotel.sourceUrls) ? hotel.sourceUrls : []).filter((url) => /^https:\/\//i.test(String(url))).slice(0, 3);
    return placeDetailsHtml(hotel, {
      backLabel: "Back to hotels",
      metaText: [ratingText(hotel), `${nightly} / night`, `about ${stay} total`].filter(Boolean).join(" • "),
      fitHtml: hotel.fullyWithinBudget ? '<p class="hotel-detail-fit">Fits your nightly budget</p>' : '<p class="budget-picker-warn">Some room types cost more than your nightly budget</p>',
      noteHtml: `<p class="budget-picker-note">Price${hotel.basis ? ` (${esc(hotel.basis)})` : ""} comes from current web results and may change.${sources.length ? ` Sources: ${sources.map((url, index) => safeLink(url, String(index + 1))).join(", ")}.` : ""}</p>`,
    });
  }

  function loadHotelDetails(placeId, endpoint = "/api/hotels/details") {
    if (!hotelDetailsCache.has(placeId)) {
      const request = window.SidekickCore.apiRequest(endpoint, {
        method: "POST",
        body: JSON.stringify({ placeId }),
      }).then((data) => data?.place || null);
      // Failed lookups are not kept, so opening the hotel again retries.
      request.catch(() => hotelDetailsCache.delete(placeId));
      hotelDetailsCache.set(placeId, request);
    }
    return hotelDetailsCache.get(placeId);
  }

  async function fillHotelDetails(hotel, endpoint = "/api/hotels/details") {
    const placeId = String(hotel.placeId || "");
    detailsShownFor = placeId;
    const extra = () => (detailsShownFor === placeId ? $("hotel-detail-extra") : null);
    if (!placeId) {
      if (extra()) extra().innerHTML = "";
      return;
    }
    let place = null;
    try {
      place = await loadHotelDetails(placeId, endpoint);
    } catch (error) {
      if (extra()) extra().innerHTML = '<p class="budget-picker-status">More photos and details are unavailable right now.</p>';
      return;
    }
    const target = extra();
    if (!target) return; // The user went back or opened another hotel.
    if (!place) {
      target.innerHTML = "";
      return;
    }
    const gallery = $("hotel-detail-gallery");
    if (gallery && place.photos?.length) {
      gallery.innerHTML = galleryHtml(place.photos);
      wirePhotoErrors(gallery);
    }

    const facts = [
      place.phone && `<li><span>Phone</span><a href="tel:${esc(place.phone.replace(/[^\d+]/g, ""))}">${esc(place.phone)}</a></li>`,
      place.website && `<li><span>Website</span>${safeLink(place.website, place.website.replace(/^https:\/\/(www\.)?/i, "").replace(/\/$/, ""))}</li>`,
      place.googleMapsUri && `<li><span>Map</span>${safeLink(place.googleMapsUri, "Open in Google Maps")}</li>`,
      place.businessStatus && place.businessStatus !== "OPERATIONAL" && `<li><span>Status</span><strong class="budget-picker-warn">${esc(place.businessStatus === "CLOSED_TEMPORARILY" ? "Temporarily closed" : "Permanently closed")}</strong></li>`,
    ].filter(Boolean);
    const stars = (rating) => (Number.isFinite(Number(rating)) && rating !== null ? `★ ${Number(rating).toFixed(0)}` : "");
    target.innerHTML = `
      ${place.summary ? `<p class="hotel-detail-summary">${esc(place.summary)}</p>` : ""}
      ${facts.length ? `<ul class="hotel-detail-facts">${facts.join("")}</ul>` : ""}
      ${place.openingHours?.length ? `<details class="hotel-detail-hours"><summary>Opening hours</summary><ul>${place.openingHours.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></details>` : ""}
      ${place.reviews?.length ? `
        <h5 class="hotel-detail-subhead">Recent Google reviews</h5>
        <ul class="hotel-detail-reviews">${place.reviews.map((review) => `
          <li>
            <p class="hotel-review-head">${esc([stars(review.rating), review.when].filter(Boolean).join(" • "))}${review.authorName ? ` — ${safeLink(review.authorUri, review.authorName)}` : ""}</p>
            <p class="hotel-review-text">${esc(review.text)}</p>
          </li>`).join("")}
        </ul>` : ""}
      <p class="budget-picker-note">Photos, reviews and details from Google Maps.</p>`;
  }

  // ---- hotels (before generating) ------------------------------------------------
  // Resolves to { status: "chosen", hotel } | { status: "skip" } | { status: "cancel" }.
  function askHotel({ destination, lat = null, lng = null, startDate, endDate, budgetAmountPhp }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      open("Choose a hotel?");
      onClose = () => finish({ status: "cancel" });
      setBody(`<p class="budget-picker-text">Would you like to pick a hotel near <strong>${esc(destination)}</strong> before your itinerary is built? We'll only show hotels whose nightly rate fits your budget.</p>`);
      setActions([
        { label: "No, build without a hotel", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
        { label: "Yes, show hotels", kind: "primary", onClick: () => { void loadHotels(); } },
      ]);

      let selected = null;
      async function loadHotels() {
        setActions([]);
        setBody('<p class="budget-picker-status">Finding hotels within your budget… this can take a moment.</p>');
        let data;
        try {
          data = await window.SidekickCore.apiRequest("/api/hotels/budget-options", {
            method: "POST",
            body: JSON.stringify({ destination, lat, lng, startDate, endDate, budgetAmountPhp }),
          });
        } catch (error) {
          if (settled) return;
          setBody(`<p class="budget-picker-status">${esc(error.message || "Hotel search is unavailable right now.")}</p>`);
          setActions([
            { label: "Try again", onClick: () => { void loadHotels(); } },
            { label: "Continue without a hotel", kind: "primary", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
          ]);
          return;
        }
        if (settled) return;
        const hotels = Array.isArray(data.hotels) ? data.hotels : [];
        const nights = Number(data.nights) || 1;
        const summary = `<p class="budget-picker-text">Up to <strong>${peso(data.nightlyCapPhp)} per night</strong> (about 40% of your ${peso(budgetAmountPhp)} budget over ${nights} night${nights === 1 ? "" : "s"}). Best-rated first.</p>`;
        if (!hotels.length) {
          const reason = data.message
            || (data.overBudgetCount ? `${data.overBudgetCount} hotel${data.overBudgetCount === 1 ? " was" : "s were"} found, but none fit this budget.` : "No hotels with a confirmed price fit this budget.");
          setBody(`${summary}<p class="budget-picker-status">${esc(reason)}</p>`);
          setActions([{ label: "Continue without a hotel", kind: "primary", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } }]);
          return;
        }
        const rows = hotels.map((hotel, index) => {
          const nightly = hotel.nightlyHighPhp > hotel.nightlyLowPhp ? `${peso(hotel.nightlyLowPhp)}–${peso(hotel.nightlyHighPhp)}` : peso(hotel.nightlyLowPhp);
          const stay = hotel.stayHighPhp > hotel.stayLowPhp ? `${peso(hotel.stayLowPhp)}–${peso(hotel.stayHighPhp)}` : peso(hotel.stayLowPhp);
          return `<button type="button" class="budget-picker-item" data-index="${index}">
              <span class="budget-picker-item-text">
                <strong>${esc(hotel.name)}</strong>
                <small>${esc(hotel.address || "")}</small>
                <small class="budget-picker-meta">${esc([ratingText(hotel), `${nightly} / night`, `about ${stay} total`].filter(Boolean).join(" • "))}</small>
                ${hotel.fullyWithinBudget ? "" : '<small class="budget-picker-warn">Some room types cost more than your nightly budget</small>'}
                <small class="budget-picker-more">Photos &amp; details ›</small>
              </span>
            </button>`;
        }).join("");
        const extra = [
          data.overBudgetCount ? `${data.overBudgetCount} over budget` : "",
          data.unpricedCount ? `${data.unpricedCount} without a confirmed price` : "",
        ].filter(Boolean).join(", ");
        const listHtml = `${summary}<div class="budget-picker-list" role="list">${rows}</div>${extra ? `<p class="budget-picker-note">Not shown: ${esc(extra)}. Prices come from current web results and may change.</p>` : '<p class="budget-picker-note">Prices come from current web results and may change.</p>'}`;
        const chooseSelected = () => {
          if (!selected) return;
          onClose = null;
          close();
          finish({ status: "chosen", hotel: selected });
        };
        let listScrollTop = 0;

        // List view. Tapping a hotel selects it (as before) and opens its details.
        function showList() {
          setBody(listHtml);
          const body = $("budget-picker-body");
          body.querySelectorAll(".budget-picker-item").forEach((row) => {
            const hotel = hotels[Number(row.dataset.index)];
            row.classList.toggle("selected", Boolean(selected) && hotel === selected);
            row.addEventListener("click", () => {
              selected = hotel || null;
              if (!selected) return;
              listScrollTop = body.scrollTop;
              showDetails(selected);
            });
          });
          setActions([
            { label: "Skip hotel", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
            { label: "Continue with this hotel", kind: "primary", id: "budget-picker-confirm", onClick: chooseSelected },
          ]);
          $("budget-picker-confirm").disabled = !selected;
          body.scrollTop = listScrollTop;
        }

        // Detail view: photos and information for the selected hotel.
        function showDetails(hotel) {
          const body = $("budget-picker-body");
          setBody(hotelDetailsHtml(hotel));
          wirePhotoErrors($("hotel-detail-gallery"));
          body.scrollTop = 0;
          body.querySelector(".hotel-detail-back")?.addEventListener("click", showList);
          setActions([
            { label: "Back to hotels", onClick: showList },
            { label: "Continue with this hotel", kind: "primary", id: "budget-picker-confirm", onClick: chooseSelected },
          ]);
          body.querySelector(".hotel-detail-back")?.focus({ preventScroll: true });
          void fillHotelDetails(hotel);
        }

        showList();
      }
    });
  }

  // ---- restaurants (after generating) ------------------------------------------
  function restaurantPrice(place) {
    const range = place.priceRange;
    if (range && Number.isFinite(Number(range.lowPhp))) {
      // Google's cheapest band starts at ₱1 ("₱1–200" means "under ₱200").
      const low = Number(range.lowPhp) < 50 ? 0 : Number(range.lowPhp);
      const high = Number.isFinite(Number(range.highPhp)) && range.highPhp !== null ? Number(range.highPhp) : null;
      if (!(low === 0 && !(high > 0))) return { low, high, exact: true };
    }
    const level = PRICE_LEVEL_PHP[place.priceLevel];
    return level ? { low: level[0], high: level[1], exact: false } : null;
  }

  function priceText(price) {
    if (!price) return "";
    const range = price.low === 0 && price.high > 0 ? `Under ${peso(price.high)}`
      : price.high !== null && price.high > price.low ? `${peso(price.low)}–${peso(price.high)}`
      : price.high === null ? `${peso(price.low)}+` : peso(price.low);
    return `${price.exact ? "" : "about "}${range} per person`;
  }

  async function fetchRestaurants(center, anchorName) {
    const key = `${center ? `${center.lat.toFixed(3)},${center.lng.toFixed(3)}` : ""}|${anchorName}`;
    if (restaurantCache.has(key)) return restaurantCache.get(key);
    const area = anchorName || "the area";
    const data = await window.SidekickCore.apiRequest("/api/maps/places", {
      method: "POST",
      body: JSON.stringify({
        queries: [`restaurants near ${area}`, `local restaurants near ${area}`],
        seeds: center ? [{ lat: center.lat, lng: center.lng }] : [],
      }),
    });
    const result = { places: data.places || [], isDevelopmentMock: Boolean(data.isDevelopmentMock) };
    restaurantCache.set(key, result);
    return result;
  }

  // dayIndex: itinerary day; center: {lat,lng} or null; anchorName: a nearby stop name.
  async function openRestaurants({ dayIndex, dayLabel, center, anchorName, budgetAmountPhp, durationDays }) {
    open(`Where to eat – ${dayLabel}`);
    onClose = null;
    const mealCap = Number.isFinite(Number(budgetAmountPhp)) && budgetAmountPhp > 0
      ? Math.floor((budgetAmountPhp * MEAL_SHARE) / (Math.max(1, durationDays) * MEALS_OUT_PER_DAY))
      : null;
    setBody('<p class="budget-picker-status">Finding restaurants near this day’s stops…</p>');
    let result;
    try {
      result = await fetchRestaurants(center, anchorName);
    } catch (error) {
      setBody(`<p class="budget-picker-status">${esc(error.message || "Restaurant search is unavailable right now.")}</p>`);
      setActions([{ label: "Close", onClick: () => close() }]);
      return;
    }
    if (!$("budget-picker-modal")?.classList.contains("open")) return;
    if (result.isDevelopmentMock) {
      setBody('<p class="budget-picker-status">Restaurant search needs live Google Places data, which is not available in development mode.</p>');
      setActions([{ label: "Close", onClick: () => close() }]);
      return;
    }
    const seen = new Set();
    const nearby = result.places
      .filter((place) => place.placeId && hasCoords(place) && !seen.has(place.placeId) && seen.add(place.placeId))
      .filter((place) => {
        const types = (place.types || []).map((type) => String(type).toLowerCase());
        return types.some((type) => FOOD_TYPE.test(type)) && !types.some((type) => LODGING_TYPE.test(type));
      })
      .map((place) => ({ ...place, distanceKm: center ? distanceKm(center, place) : null, price: restaurantPrice(place) }))
      .filter((place) => place.distanceKm === null || place.distanceKm <= NEARBY_KM);
    const priced = nearby.filter((place) => place.price);
    const affordable = mealCap === null ? priced : priced.filter((place) => place.price.low <= mealCap);
    // Best-rated places the budget covers come first; cheaper wins a tie.
    affordable.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || a.price.low - b.price.low);

    const summary = mealCap !== null
      ? `<p class="budget-picker-text">Up to <strong>${peso(mealCap)} per meal</strong> (about 20% of your ${peso(budgetAmountPhp)} budget, ${MEALS_OUT_PER_DAY} meals a day). Best-rated first.</p>`
      : '<p class="budget-picker-text">No budget was set for this trip, so all priced restaurants are shown. Best-rated first.</p>';
    const hidden = [
      priced.length - affordable.length ? `${priced.length - affordable.length} over budget` : "",
      nearby.length - priced.length ? `${nearby.length - priced.length} without a listed price` : "",
    ].filter(Boolean).join(", ");
    const note = `<p class="budget-picker-note">${hidden ? `Not shown: ${esc(hidden)}. ` : ""}Prices are Google Maps estimates per person and may change.</p>`;
    if (!affordable.length) {
      setBody(`${summary}<p class="budget-picker-status">No restaurants near this day's stops fit the budget.</p>${note}`);
      setActions([{ label: "Close", onClick: () => close() }]);
      return;
    }
    const metaText = (place) => [ratingText(place), priceText(place.price), place.distanceKm !== null ? `${place.distanceKm.toFixed(1)} km away` : ""].filter(Boolean).join(" • ");
    const listHtml = `${summary}<div class="budget-picker-list" role="list">${affordable.map((place, index) => `
      <button type="button" class="budget-picker-item" data-index="${index}">
        <span class="budget-picker-item-text">
          <strong>${esc(place.name)}</strong>
          <small>${esc(place.address || "")}</small>
          <small class="budget-picker-meta">${esc(metaText(place))}</small>
          <small class="budget-picker-more">Photos &amp; details ›</small>
        </span>
      </button>`).join("")}</div>${note}`;
    // Same action as before this view existed: close and open the add form for this day.
    const addToDay = (place) => {
      close();
      window.SidekickItineraryEdit?.openAddPlace({ ...place, note: [place.address, priceText(place.price)].filter(Boolean).join(" • ") }, "restaurant", dayIndex);
    };
    let listScrollTop = 0;

    function showList() {
      setBody(listHtml);
      const body = $("budget-picker-body");
      body.querySelectorAll(".budget-picker-item").forEach((row) => {
        row.addEventListener("click", () => {
          const place = affordable[Number(row.dataset.index)];
          if (!place) return;
          listScrollTop = body.scrollTop;
          showDetails(place);
        });
      });
      setActions([{ label: "Close", onClick: () => close() }]);
      body.scrollTop = listScrollTop;
    }

    // Detail view: photos and information for the tapped restaurant.
    function showDetails(place) {
      const body = $("budget-picker-body");
      const fitsFully = mealCap !== null && place.price?.high !== null && place.price?.high !== undefined && place.price.high <= mealCap;
      setBody(placeDetailsHtml(place, {
        backLabel: "Back to restaurants",
        metaText: metaText(place),
        fitHtml: mealCap === null ? ""
          : fitsFully ? '<p class="hotel-detail-fit">Fits your per-meal budget</p>'
            : '<p class="budget-picker-warn">Starts within your per-meal budget; some meals may cost more</p>',
        noteHtml: `<p class="budget-picker-note">${place.price?.exact ? "Price range from Google Maps" : "Price estimated from Google’s price level"}, per person. Prices may change.</p>`,
      }));
      wirePhotoErrors($("hotel-detail-gallery"));
      body.scrollTop = 0;
      body.querySelector(".hotel-detail-back")?.addEventListener("click", showList);
      setActions([
        { label: "Back to restaurants", onClick: showList },
        { label: `Add to ${dayLabel}`, kind: "primary", onClick: () => addToDay(place) },
      ]);
      body.querySelector(".hotel-detail-back")?.focus({ preventScroll: true });
      void fillHotelDetails(place, "/api/places/details");
    }

    showList();
  }

  window.SidekickBudgetPickers = { askHotel, openRestaurants };
})();
