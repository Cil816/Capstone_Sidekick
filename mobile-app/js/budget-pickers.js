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
  // Set by a step that would lose the traveler's work if closed by mistake (the hotel and
  // stop choices while building): resolves true when they confirm leaving.
  let confirmCancel = null;
  let confirming = false;

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
      if (event.target?.dataset?.pickerClose === "1") void requestCancel();
    });
    document.addEventListener("keydown", (event) => {
      // (Not while the confirmation itself is open: Escape there answers it.)
      if (event.key === "Escape" && modal.classList.contains("open") && !confirming) void requestCancel();
    });
    return modal;
  }

  function open(title) {
    // A picker still open (or still waiting for its answer) ends as cancelled first, so
    // its leftover state can never answer for the new one.
    if ($("budget-picker-modal")?.classList.contains("open")) close("cancel");
    else if (onClose) { const pending = onClose; onClose = null; pending("cancel"); }
    const modal = ensureModal();
    $("budget-picker-title").textContent = title;
    $("budget-picker-body").replaceChildren();
    $("budget-picker-actions").replaceChildren();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  // The app's own themed confirmation (ui.js) for leaving an itinerary being built.
  async function askToStopBuilding(lost) {
    if (!window.SidekickUI?.confirm) return true;
    return window.SidekickUI.confirm(`${lost} You can start again any time.`, {
      title: "Stop building this itinerary?", confirmText: "Stop building", cancelText: "Keep going", tone: "danger", icon: "question",
    });
  }

  // ×, tapping outside, Escape or Cancel: asks first when the open step would lose work.
  async function requestCancel() {
    if (confirming) return;
    if (confirmCancel) {
      confirming = true;
      let leave = false;
      try { leave = await confirmCancel(); } finally { confirming = false; }
      if (!leave) return;
    }
    close("cancel");
  }

  function close(reason) {
    const modal = $("budget-picker-modal");
    if (!modal || !modal.classList.contains("open")) return;
    confirmCancel = null;
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

  function setActions(buttons, { pair = false } = {}) {
    const wrap = $("budget-picker-actions");
    wrap.replaceChildren();
    wrap.classList.toggle("is-pair", pair);
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
        <div id="hotel-detail-extra" class="hotel-detail-extra" aria-live="polite">${window.SidekickUI?.skeleton?.lines(3) || '<p class="budget-picker-status">Loading photos and details…</p>'}</div>
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
      // Checked: the page the price came from was opened and shows that price.
      noteHtml: `<p class="budget-picker-note">${hotel.priceCheckedOn
        ? `Price${hotel.basis ? ` (${esc(hotel.basis)})` : ""} checked on ${esc(hotel.priceCheckedOn)}; it may change.`
        : `Price${hotel.basis ? ` (${esc(hotel.basis)})` : ""} is from a web search${hotel.priceSite ? ` (${esc(hotel.priceSite)})` : ""} and couldn’t be checked on the page, so confirm it before booking.`}${sources.length ? ` Sources: ${sources.map((url, index) => safeLink(url, String(index + 1))).join(", ")}.` : ""}</p>`,
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

  // ---- "Edit trip budget" (hotels and restaurants) -------------------------------
  // Asks for a new total budget and checks it like the builder does (far too much, or
  // too little for the cheapest hotel and meals). Resolves to the new amount, or null.
  async function askNewBudget({ current, destination, lat = null, lng = null, startDate, endDate, kind, travelers = 1 }) {
    let value = current ? String(current) : "";
    for (;;) {
      const values = await window.SidekickUI.form({
        title: "Edit trip budget",
        icon: "edit",
        message: `Want more ${kind}? Raise your total budget to see more, including higher-end ones. Your trip will use the new budget.`,
        fields: [{ name: "budget", label: "Total budget (PHP)", type: "number", value, min: 1, hint: current ? `Current budget: ${peso(current)}` : "" }],
        confirmText: "Update budget",
        validate: ({ budget }) => {
          const amount = Number(budget);
          return Number.isFinite(amount) && amount >= 1 ? "" : "Enter your total budget in pesos.";
        },
      });
      if (!values) return null;
      value = values.budget;
      const amount = Math.floor(Number(values.budget));
      if (amount === Number(current)) return null;
      let check = null;
      if (destination && startDate && endDate && window.SidekickCore.checkTripBudget) {
        window.SidekickUI.loading.show("Checking your budget…");
        try {
          check = await window.SidekickCore.checkTripBudget({ destination, lat, lng, startDate, endDate, budgetAmountPhp: amount, travelers });
        } finally {
          window.SidekickUI.loading.hide();
        }
      }
      if (check?.checked && !check.realistic) {
        const problem = window.SidekickCore.describeUnrealisticBudget(check, destination);
        await window.SidekickUI.alert(problem.message, { title: problem.title, details: problem.details, confirmText: "Change budget" });
        continue;
      }
      return amount;
    }
  }

  // ---- hotels (before generating) ------------------------------------------------
  // Resolves to { status: "chosen", hotel } | { status: "skip" } | { status: "cancel" },
  // each with budgetAmountPhp: the trip budget, changed with "Edit trip budget" or not.
  function askHotel({ destination, lat = null, lng = null, startDate, endDate, budgetAmountPhp: startingBudget, travelers = 1 }) {
    // A group needs a room for every two people; the nightly rate shown is per room.
    const people = window.SidekickCore.normalizeTravelers?.(travelers) || 1;
    let budgetAmountPhp = startingBudget;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ ...result, budgetAmountPhp });
      };
      const editBudget = async () => {
        const amount = await askNewBudget({ current: budgetAmountPhp, destination, lat, lng, startDate, endDate, kind: "hotels", travelers: people });
        if (settled || amount === null) return;
        budgetAmountPhp = amount;
        selected = null;
        void loadHotels();
      };
      open("Choose a hotel?");
      onClose = () => finish({ status: "cancel" });
      confirmCancel = () => askToStopBuilding("The itinerary won’t be built.");
      setBody(`<p class="budget-picker-text">Pick a hotel near <strong>${esc(destination)}</strong> before building? Only hotels within your budget are shown.</p>`);
      setActions([
        { label: "No", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
        { label: "Yes", kind: "primary", onClick: () => { void loadHotels(); } },
      ], { pair: true });

      let selected = null;
      async function loadHotels() {
        setActions([]);
        setBody('<p class="budget-picker-status">Finding hotels within your budget… this can take a moment.</p>' + (window.SidekickUI?.skeleton?.list(3) || ''));
        let data;
        try {
          data = await window.SidekickCore.apiRequest("/api/hotels/budget-options", {
            method: "POST",
            // v: 2, hotels found around the destination too (answers saved before aren't reused).
            body: JSON.stringify({ destination, lat, lng, startDate, endDate, budgetAmountPhp, travelers: people, v: 2 }),
          });
        } catch (error) {
          if (settled) return;
          setBody(`<p class="budget-picker-status">${esc(window.SidekickCore.friendlyError(error, "Hotel search is unavailable right now."))}</p>`);
          setActions([
            { label: "Try again", onClick: () => { void loadHotels(); } },
            { label: "Continue without a hotel", kind: "primary", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
          ]);
          return;
        }
        if (settled) return;
        const hotels = Array.isArray(data.hotels) ? data.hotels : [];
        const nights = Number(data.nights) || 1;
        const rooms = Number(data.rooms) || 1;
        const roomText = rooms > 1 ? ` per room (${rooms} rooms for ${people} travelers)` : ' per night';
        const summary = `<p class="budget-picker-text">Up to <strong>${peso(data.nightlyCapPhp)}${rooms > 1 ? ' a night' : ''}${roomText}</strong> (about 40% of your ${peso(budgetAmountPhp)} budget over ${nights} night${nights === 1 ? "" : "s"}). Best-rated first.</p>`;
        if (!hotels.length) {
          const reason = data.message
            || (data.overBudgetCount ? `${data.overBudgetCount} hotel${data.overBudgetCount === 1 ? " was" : "s were"} found, but none fit this budget.` : "No hotels with a confirmed price fit this budget.");
          setBody(`${summary}<p class="budget-picker-status">${esc(reason)}</p>`);
          setActions([
            { label: "Edit trip budget", onClick: () => { void editBudget(); } },
            { label: "Continue without a hotel", kind: "primary", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
          ]);
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
                <small class="budget-picker-meta">${hotel.priceCheckedOn ? `Price checked on ${esc(hotel.priceCheckedOn)}` : "Price from a web search, not checked"}</small>
                <small class="budget-picker-more">Photos &amp; details ›</small>
              </span>
            </button>`;
        }).join("");
        const extra = [
          data.overBudgetCount ? `${data.overBudgetCount} over budget` : "",
          data.unpricedCount ? `${data.unpricedCount} without a confirmed price` : "",
        ].filter(Boolean).join(", ");
        const pricesNote = "Prices come from a web search and may change. “Checked” means the page the price came from shows it.";
        const listHtml = `${summary}<div class="budget-picker-list" role="list">${rows}</div><p class="budget-picker-note">${extra ? `Not shown: ${esc(extra)}. ` : ""}${pricesNote}</p>`;
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
          addEditBudgetLink(editBudget, "hotels");
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
        seeds: center ? [{ lat: center.lat, lng: center.lng, radius: NEARBY_KM * 1000 }] : [],
      }),
    });
    const result = { places: data.places || [], isDevelopmentMock: Boolean(data.isDevelopmentMock) };
    restaurantCache.set(key, result);
    return result;
  }

  // "Want higher-end hotels? Edit trip budget" above a hotel or restaurant list.
  function addEditBudgetLink(onClick, kind) {
    const body = $("budget-picker-body");
    if (!body || body.querySelector(".budget-picker-budget-row")) return;
    const row = document.createElement("div");
    row.className = "budget-picker-budget-row";
    const text = document.createElement("span");
    text.textContent = kind === "hotels" ? "Want higher-end hotels?" : "Want more restaurant choices?";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "budget-picker-budget-btn";
    button.textContent = "Edit trip budget";
    button.addEventListener("click", onClick);
    row.append(text, button);
    body.insertBefore(row, body.querySelector(".budget-picker-list"));
  }

  // dayIndex: itinerary day; center: {lat,lng} or null; anchorName: a nearby stop name.
  // onBudgetChange(amount): saves a new trip budget chosen with "Edit trip budget".
  async function openRestaurants({ dayIndex, dayLabel, center, anchorName, budgetAmountPhp, durationDays, destination = "", startDate = "", endDate = "", onBudgetChange = null, travelers = 1 }) {
    // Menu prices are per person: a group shares the meal budget.
    const people = window.SidekickCore.normalizeTravelers?.(travelers) || 1;
    open(`Where to eat – ${dayLabel}`);
    onClose = null;
    let currentBudget = budgetAmountPhp;
    setBody('<p class="budget-picker-status">Finding restaurants near this day’s stops…</p>' + (window.SidekickUI?.skeleton?.list(3) || ''));
    let result;
    try {
      result = await fetchRestaurants(center, anchorName);
    } catch (error) {
      setBody(`<p class="budget-picker-status">${esc(window.SidekickCore.friendlyError(error, "Restaurant search is unavailable right now."))}</p>`);
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
    const metaText = (place) => [ratingText(place), priceText(place.price), place.distanceKm !== null ? `${place.distanceKm.toFixed(1)} km away` : ""].filter(Boolean).join(" • ");
    // Same action as before this view existed: close and open the add form for this day.
    const addToDay = (place) => {
      close();
      window.SidekickItineraryEdit?.openAddPlace({ ...place, note: [place.address, priceText(place.price)].filter(Boolean).join(" • ") }, "restaurant", dayIndex);
    };
    let listScrollTop = 0;
    // "Edit trip budget": a new budget is saved to the trip, then the list is shown again.
    const editBudget = typeof onBudgetChange === "function" ? async () => {
      const amount = await askNewBudget({ current: currentBudget, destination, lat: center?.lat ?? null, lng: center?.lng ?? null, startDate, endDate, kind: "restaurants", travelers: people });
      if (amount === null || !$("budget-picker-modal")?.classList.contains("open")) return;
      if (onBudgetChange(amount) === false) return;
      currentBudget = amount;
      listScrollTop = 0;
      showList();
      window.SidekickUI.toast(`Trip budget updated to ${peso(amount)}`);
    } : null;

    function showList() {
      const mealCap = Number.isFinite(Number(currentBudget)) && currentBudget > 0
        ? Math.floor((currentBudget * MEAL_SHARE) / (Math.max(1, durationDays) * MEALS_OUT_PER_DAY * people))
        : null;
      const affordable = mealCap === null ? priced.slice() : priced.filter((place) => place.price.low <= mealCap);
      // Best-rated places the budget covers come first; cheaper wins a tie.
      affordable.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || a.price.low - b.price.low);
      const summary = mealCap !== null
        ? `<p class="budget-picker-text">Up to <strong>${peso(mealCap)} per meal${people > 1 ? " per person" : ""}</strong> (about 20% of your ${peso(currentBudget)} budget, ${MEALS_OUT_PER_DAY} meals a day${people > 1 ? ` for ${people} travelers` : ""}). Best-rated first.</p>`
        : '<p class="budget-picker-text">No budget was set for this trip, so all priced restaurants are shown. Best-rated first.</p>';
      const hidden = [
        priced.length - affordable.length ? `${priced.length - affordable.length} over budget` : "",
        nearby.length - priced.length ? `${nearby.length - priced.length} without a listed price` : "",
      ].filter(Boolean).join(", ");
      const note = `<p class="budget-picker-note">${hidden ? `Not shown: ${esc(hidden)}. ` : ""}Prices are Google Maps estimates per person and may change.</p>`;
      if (!affordable.length) {
        setBody(`${summary}<p class="budget-picker-status">No restaurants near this day's stops fit the budget.</p>${note}`);
        setActions([
          ...(editBudget ? [{ label: "Edit trip budget", onClick: () => { void editBudget(); } }] : []),
          { label: "Close", onClick: () => close() },
        ]);
        return;
      }
      setBody(`${summary}<div class="budget-picker-list" role="list">${affordable.map((place, index) => `
        <button type="button" class="budget-picker-item" data-index="${index}">
          <span class="budget-picker-item-text">
            <strong>${esc(place.name)}</strong>
            <small>${esc(place.address || "")}</small>
            <small class="budget-picker-meta">${esc(metaText(place))}</small>
            <small class="budget-picker-more">Photos &amp; details ›</small>
          </span>
        </button>`).join("")}</div>${note}`);
      const body = $("budget-picker-body");
      body.querySelectorAll(".budget-picker-item").forEach((row) => {
        row.addEventListener("click", () => {
          const place = affordable[Number(row.dataset.index)];
          if (!place) return;
          listScrollTop = body.scrollTop;
          showDetails(place, mealCap);
        });
      });
      setActions([{ label: "Close", onClick: () => close() }]);
      if (editBudget) addEditBudgetLink(editBudget, "restaurants");
      body.scrollTop = listScrollTop;
    }

    // Detail view: photos and information for the tapped restaurant.
    function showDetails(place, mealCap) {
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
      body.querySelector(".hotel-detail-back")?.addEventListener("click", () => showList());
      setActions([
        { label: "Back to restaurants", onClick: () => showList() },
        { label: `Add to ${dayLabel}`, kind: "primary", onClick: () => addToDay(place) },
      ]);
      body.querySelector(".hotel-detail-back")?.focus({ preventScroll: true });
      void fillHotelDetails(place, "/api/places/details");
    }

    showList();
  }

  // ---- stops (before building) ---------------------------------------------------
  // Each stop of the plan has up to three verified places near the destination; the
  // traveler picks one per stop (the first is picked to start). Resolves to the picks,
  // { stopKey: placeId }, or null when closed without building.
  const STOP_TIMES = {
    "early-morning": "Early morning", morning: "Morning", midday: "Midday", afternoon: "Afternoon",
    sunset: "Sunset", evening: "Evening", night: "Night",
  };
  const capitalize = (text) => String(text || "").replace(/^\w/, (c) => c.toUpperCase());

  // Resolves to { choices: { stopKey: placeId, or "" for a removed stop }, extraStops:
  // [{ day, placeId }] for places the traveler added, searchedStops: [{ key, placeId }]
  // for stops whose pick is a place the traveler searched for }, or null when closed.
  function askStops(plan) {
    // Copies, since added stops are put into these lists.
    const days = (Array.isArray(plan?.days) ? plan.days : []).filter((day) => Array.isArray(day.stops) && day.stops.length)
      .map((day) => ({ ...day, stops: day.stops.slice() }));
    if (!days.length) return Promise.resolve({ choices: {}, extraStops: [], searchedStops: [] });
    const picks = {};
    days.forEach((day) => day.stops.forEach((stop) => { if (stop.options?.[0]) picks[stop.key] = stop.options[0].placeId; }));
    let dayIndex = 0;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      open("Choose your stops");
      onClose = () => finish(null);
      confirmCancel = () => askToStopBuilding("Your stop picks will be lost.");

      // A place already picked for another stop can't be picked again.
      const takenElsewhere = (placeId, stopKey) => Object.entries(picks).some(([key, id]) => key !== stopKey && id === placeId);
      // A default pick that another stop already has moves to that stop's next free option.
      days.forEach((day) => day.stops.forEach((stop) => {
        if (!takenElsewhere(picks[stop.key], stop.key)) return;
        const free = (stop.options || []).find((option) => !takenElsewhere(option.placeId, stop.key));
        if (free) picks[stop.key] = free.placeId; else delete picks[stop.key];
      }));
      // Distances follow the picks: the first stop from the start (day 1) or the stay (or
      // the day before's last stop), each next stop from the stop picked before it, and
      // the trip's last stop also to the end point. Straight-line, so roads run a bit longer.
      const point = (place) => (place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng)) && place.lat !== null && place.lng !== null
        ? { lat: Number(place.lat), lng: Number(place.lng), name: place.name || "" } : null);
      const kmBetween = (a, b) => {
        const rad = (deg) => deg * Math.PI / 180;
        const dLat = rad(b.lat - a.lat);
        const dLng = rad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      };
      // A place the traveler searched for and picked for a stop, by stop key: shown first in
      // that stop's list, and sent as the stop's place (searchedStops).
      const searchedOptions = {};
      const optionsOf = (stop) => [...(searchedOptions[stop.key] ? [searchedOptions[stop.key]] : []), ...(stop?.options || [])];
      // A removed stop has "" as its pick, so it has no picked option.
      const pickedOption = (stop) => optionsOf(stop).find((option) => option.placeId === picks[stop.key]) || null;
      const isRemoved = (stop) => picks[stop.key] === "";
      const activeCount = (day) => day.stops.filter((stop) => !isRemoved(stop)).length;
      const startPoint = point(plan.startPoint);
      const stayPoint = point(plan.stay);
      const endPoint = point(plan.endPoint) || startPoint;
      // { at, label } for where the traveler comes from before this stop (removed stops skipped);
      // sameDay: it is the day's stop picked before this one (not the start or the stay).
      const comingFrom = (dayIdx, stopIdx) => {
        const day = days[dayIdx];
        const before = day.stops.slice(0, stopIdx).map(pickedOption).filter((option) => point(option)).pop();
        if (before) return { at: point(before), label: "from last stop", sameDay: true };
        if (dayIdx === 0) return startPoint ? { at: startPoint, label: "from your start" } : null;
        if (stayPoint) return { at: stayPoint, label: "from your stay" };
        const lastBefore = days[dayIdx - 1].stops.map(pickedOption).filter((option) => point(option)).pop();
        return lastBefore ? { at: point(lastBefore), label: "from last stop" } : null;
      };
      // "~": a straight-line distance (roads run a bit longer).
      const kmText = (km) => `~${km < 10 ? km.toFixed(1) : Math.round(km)} km`;

      // Adding a stop: the day whose search is open, and the scroll to keep on re-render.
      let addingDay = null;
      let keepScroll = null;
      let addedCount = 0;
      const MAX_ADDED_STOPS = 10;
      const ADD_SESSION = `add-${Date.now().toString(36)}`;
      // Searching for another place for one stop: that stop's key while its search is open.
      let searchingKey = null;
      // A searched place farther than this from the day's stop before it gets a warning, and
      // a later day's first stop farther than FAR_FROM_STAY_KM from where the traveler stays.
      const FAR_SEARCH_KM = 20;
      const FAR_FROM_STAY_KM = 30;
      // Place search for the picker (5 results at most): near ({ lat, lng }) puts the places
      // closest to it first, each with its distance from there. Resolves to the results.
      async function searchPlaces(text, near) {
        const data = await window.SidekickCore.apiRequest("/api/maps/place-suggestions", {
          method: "POST",
          body: JSON.stringify({ input: text, scope: "activity", sessionToken: ADD_SESSION, ...(near ? { near: { lat: near.lat, lng: near.lng } } : {}) }),
        });
        return (Array.isArray(data?.suggestions) ? data.suggestions : []).filter((item) => item?.placeId).slice(0, 5);
      }
      // A search box (input, status line, results) that lists places as the traveler types
      // and calls onPick(place, status) for the one tapped. fromLabel ("from Laiya White Cove")
      // goes with each result's distance.
      function wireSearchBox({ inputId, statusId, resultsId, near, fromLabel, onPick }) {
        const input = $(inputId);
        const status = $(statusId);
        const results = $(resultsId);
        if (!input || !status || !results) return;
        let timer = null;
        let requestId = 0;
        input.addEventListener("input", () => {
          const text = input.value.trim();
          const id = ++requestId;
          clearTimeout(timer);
          results.replaceChildren();
          if (text.length < 2) { status.textContent = ""; return; }
          status.textContent = "Searching…";
          timer = setTimeout(async () => {
            try {
              const found = await searchPlaces(text, near);
              if (id !== requestId) return;
              status.textContent = found.length ? "" : "No places found in Batangas.";
              results.innerHTML = found.map((item, index) => {
                const distance = Number.isFinite(Number(item.distanceKm)) && item.distanceKm !== null && fromLabel ? `${kmText(Number(item.distanceKm))} ${fromLabel}` : "";
                return `<button type="button" class="budget-picker-item stop-add-result" data-index="${index}">
                  <span class="budget-picker-item-text"><strong>${esc(item.name || item.text)}</strong>${item.secondaryText ? `<small>${esc(item.secondaryText)}</small>` : ""}${distance ? `<small class="budget-picker-meta">${esc(distance)}</small>` : ""}</span>
                </button>`;
              }).join("");
              results.querySelectorAll(".stop-add-result").forEach((button) => button.addEventListener("click", () => {
                void onPick(found[Number(button.dataset.index)], status);
              }));
            } catch (error) {
              if (id === requestId) status.textContent = "Search is unavailable right now.";
            }
          }, 300);
        });
      }
      function wireAddSearch(day, dayIdx, rerender) {
        // Places near the day's last pick come first.
        const last = day.stops.map(pickedOption).filter((option) => point(option)).pop();
        const from = last ? { at: point(last), label: `from ${last.name}` } : comingFrom(dayIdx, 0);
        wireSearchBox({
          inputId: "stop-add-input", statusId: "stop-add-status", resultsId: "stop-add-results",
          near: from?.at || null, fromLabel: from?.label || "",
          onPick: (place, status) => addPlace(day, place, rerender, status),
        });
      }
      // A searched place for one stop: shown first in its list and picked.
      async function pickSearched(stop, suggestion, rerender, status) {
        if (!suggestion?.placeId) return;
        if (takenElsewhere(suggestion.placeId, stop.key)) { status.textContent = "That place is already in your trip."; return; }
        status.textContent = "Adding…";
        // Its location and photo, for the distances shown; it's picked even without them.
        const details = await loadHotelDetails(suggestion.placeId, "/api/places/details").catch(() => null);
        searchedOptions[stop.key] = {
          placeId: suggestion.placeId,
          name: details?.name || suggestion.name || suggestion.text || "Your pick",
          address: details?.address || suggestion.secondaryText || "",
          lat: details?.lat ?? null,
          lng: details?.lng ?? null,
          rating: details?.rating ?? null,
          ratingCount: details?.ratingCount ?? null,
          photoResource: details?.photos?.[0]?.resource || null,
          searched: true,
        };
        picks[stop.key] = suggestion.placeId;
        searchingKey = null;
        rerender();
      }
      async function addPlace(day, suggestion, rerender, status) {
        if (!suggestion?.placeId) return;
        if (Object.values(picks).includes(suggestion.placeId)) { status.textContent = "That place is already in your trip."; return; }
        if (addedCount >= MAX_ADDED_STOPS) { status.textContent = `You can add up to ${MAX_ADDED_STOPS} stops.`; return; }
        status.textContent = "Adding…";
        // Its location and photo, for the distances shown; it's added even without them.
        const details = await loadHotelDetails(suggestion.placeId, "/api/places/details").catch(() => null);
        addedCount += 1;
        const key = `added${addedCount}`;
        day.stops.push({
          key,
          added: true,
          category: "added by you",
          bestTime: "",
          options: [{
            placeId: suggestion.placeId,
            name: details?.name || suggestion.name || suggestion.text || "Your stop",
            address: details?.address || suggestion.secondaryText || "",
            lat: details?.lat ?? null,
            lng: details?.lng ?? null,
            rating: details?.rating ?? null,
            ratingCount: details?.ratingCount ?? null,
            photoResource: details?.photos?.[0]?.resource || null,
          }],
        });
        picks[key] = suggestion.placeId;
        addingDay = null;
        rerender();
      }
      const optionHtml = (stop, option, dayIdx, stopIdx) => {
        const photo = photoUrl(option.photoResource);
        const admission = option.admission && Number.isFinite(Number(option.admission.lowPhp))
          ? `Entry ₱${Number(option.admission.lowPhp).toLocaleString()}${Number(option.admission.highPhp) > Number(option.admission.lowPhp) ? `–₱${Number(option.admission.highPhp).toLocaleString()}` : ""}`
          : "";
        const from = comingFrom(dayIdx, stopIdx);
        const here = point(option);
        const distance = from && here ? `${kmText(kmBetween(from.at, here))} ${from.label}`
          : Number.isFinite(Number(option.distanceKm)) && option.distanceKm !== null ? `${Number(option.distanceKm).toFixed(1)} km away` : "";
        // A place the traveler searched for that is far: from the day's stop before it, or, as
        // a later day's first stop, from where they stay (the drive from the start to day 1's
        // first stop is the trip's own drive, so it isn't counted).
        const km = from && here ? kmBetween(from.at, here) : 0;
        const far = !option.searched || !from || !here ? ""
          : from.sameDay ? (km > FAR_SEARCH_KM ? "Far from your other stops: a long drive for this stop" : "")
            : dayIdx > 0 && km > FAR_FROM_STAY_KM ? "Far from where you stay: a long drive for this day" : "";
        const lastDayStops = days[days.length - 1].stops;
        let lastKept = lastDayStops.length - 1;
        while (lastKept >= 0 && isRemoved(lastDayStops[lastKept])) lastKept -= 1;
        const isTripLastStop = dayIdx === days.length - 1 && lastKept === stopIdx;
        const toEnd = isTripLastStop && endPoint && here ? `${kmText(kmBetween(here, endPoint))} to your end point` : "";
        const meta = [ratingText(option), distance, admission].filter(Boolean).join(" • ");
        // Places already picked for another stop aren't shown; the stop's other options are.
        if (takenElsewhere(option.placeId, stop.key)) return "";
        const selected = picks[stop.key] === option.placeId;
        // Two branches with the same name (two "Cafe de Lipa"s) say where each one is.
        const sameName = optionsOf(stop).filter((other) => other !== option && String(other.name).trim().toLowerCase() === String(option.name).trim().toLowerCase()).length > 0;
        const area = sameName ? shortArea(option.address) : "";
        return `<div class="stop-option-row">
          <button type="button" class="budget-picker-item stop-option${selected ? " selected" : ""}" data-stop="${esc(stop.key)}" data-place="${esc(option.placeId)}" aria-pressed="${selected}">
            ${photo ? `<img class="stop-option-photo" src="${esc(photo)}" alt="" loading="lazy" />` : ""}
            <span class="budget-picker-item-text">
              ${option.searched ? '<small class="stop-option-tag">Your search</small>' : ""}
              <strong>${esc(option.name)}</strong>
              ${area ? `<small class="stop-option-area">${esc(area)}</small>` : ""}
              ${meta ? `<small class="budget-picker-meta">${esc(meta)}</small>` : ""}
              ${toEnd ? `<small class="budget-picker-meta">${esc(toEnd)}</small>` : ""}
              ${far ? `<small class="budget-picker-warn">${esc(far)}</small>` : ""}
              ${option.hasRooms ? '<small>Has rooms to stay in</small>' : ""}
            </span>
          </button>
          <button type="button" class="stop-option-info" data-info-stop="${esc(stop.key)}" data-info-place="${esc(option.placeId)}" aria-label="Details about ${esc(option.name)}">Details ›</button>
        </div>`;
      };
      // The part of an address that tells branches apart: the street or barangay and town,
      // without the country, province or postal code.
      function shortArea(address) {
        return String(address || "").split(",").map((part) => part.trim())
          .filter((part) => part && !/^(philippines|batangas|\d{4}\s*batangas|\d{4})$/i.test(part))
          .slice(0, 2).join(", ");
      }

      // A stop option's photos, description, hours and reviews (Google Maps), to compare
      // the suggestions before picking one; "Pick this place" picks it for that stop.
      function showOptionDetails(stop, option, label, meta) {
        const body = $("budget-picker-body");
        keepScroll = body.scrollTop;
        setBody(placeDetailsHtml(option, { backLabel: "Back to stops", metaText: [label, meta].filter(Boolean).join(" • ") }));
        wirePhotoErrors($("hotel-detail-gallery"));
        body.scrollTop = 0;
        const back = () => { const scroll = keepScroll; render(); body.scrollTop = scroll ?? 0; };
        body.querySelector(".hotel-detail-back")?.addEventListener("click", back);
        const picked = picks[stop.key] === option.placeId;
        setActions([
          { label: "Back to stops", onClick: back },
          picked
            ? { label: "Picked for this stop", kind: "primary", onClick: back }
            : { label: "Pick this place", kind: "primary", onClick: () => { picks[stop.key] = option.placeId; back(); } },
        ], { pair: true });
        body.querySelector(".hotel-detail-back")?.focus({ preventScroll: true });
        void fillHotelDetails(option, "/api/places/details");
      }

      // The picks for the server's stops, the added places as their own list, and the
      // stops whose pick is a place the traveler searched for.
      function result() {
        const choices = {};
        const extraStops = [];
        const searchedStops = [];
        days.forEach((day) => day.stops.forEach((stop) => {
          if (!Object.hasOwn(picks, stop.key)) return;
          if (stop.added) {
            if (picks[stop.key]) extraStops.push({ day: Number(day.day), placeId: picks[stop.key] });
          } else {
            choices[stop.key] = picks[stop.key];
            if (picks[stop.key] && picks[stop.key] === searchedOptions[stop.key]?.placeId) searchedStops.push({ key: stop.key, placeId: picks[stop.key] });
          }
        }));
        return { choices, extraStops, searchedStops };
      }

      function render() {
        const day = days[dayIndex];
        const tabs = days.length > 1
          ? `<div class="day-tabs stop-day-tabs" role="tablist">${days.map((item, index) => `<button type="button" class="day-tab${index === dayIndex ? " active" : ""}" role="tab" aria-selected="${index === dayIndex}" data-day-index="${index}">Day ${esc(item.day)}</button>`).join("")}</div>`
          : "";
        // One line: what to do here. Sidekick sets the times and route after this.
        const intro = '<p class="budget-picker-text">Pick a place for each stop. Tap <strong>Details</strong> to compare photos, hours and reviews.</p>';
        const stops = day.stops.map((stop, index) => {
          const label = [`Stop ${index + 1}`, STOP_TIMES[String(stop.bestTime || "").toLowerCase()] || "", capitalize(stop.category)].filter(Boolean).join(" · ");
          // Each day keeps at least one stop.
          const canRemove = !isRemoved(stop) && activeCount(day) > 1;
          const head = `<div class="stop-choice-head"><h4>${esc(label)}</h4>${isRemoved(stop)
            ? `<button type="button" class="stop-choice-toggle" data-restore="${esc(stop.key)}">Add back</button>`
            : canRemove ? `<button type="button" class="stop-choice-toggle" data-remove="${esc(stop.key)}">Remove stop</button>` : ""}</div>`;
          if (isRemoved(stop)) return `<section class="stop-choice removed">${head}<p class="stop-choice-removed">Removed: this stop won’t be in your trip.</p></section>`;
          // Searching for another place for this stop (not the destination's own stop, and
          // not a stop the traveler added: that is already their own pick).
          const search = stop.home || stop.added ? ""
            : searchingKey === stop.key
              ? `<div class="stop-search">
                  <div class="stop-search-head"><span>Search for a place for this stop</span><button type="button" class="stop-choice-toggle" data-search-cancel>Cancel</button></div>
                  <input type="search" class="stop-add-input" id="stop-search-input" placeholder="Search a place in Batangas" autocomplete="off" aria-label="Search a place for this stop" />
                  <p class="stop-add-status" id="stop-search-status" aria-live="polite"></p>
                  <div class="budget-picker-list" id="stop-search-results" role="list"></div>
                </div>`
              : `<button type="button" class="stop-search-open" data-search-open="${esc(stop.key)}">Search for another place</button>`;
          return `<section class="stop-choice">${head}<div class="budget-picker-list" role="list">${optionsOf(stop).map((option) => optionHtml(stop, option, dayIndex, index)).join("")}</div>${search}</section>`;
        }).join("");
        const addStop = addingDay === dayIndex
          ? `<section class="stop-choice stop-add"><div class="stop-choice-head"><h4>Add a stop</h4><button type="button" class="stop-choice-toggle" data-add-cancel>Cancel</button></div>
              <input type="search" class="stop-add-input" id="stop-add-input" placeholder="Search a place in Batangas" autocomplete="off" aria-label="Search a place to add" />
              <p class="stop-add-status" id="stop-add-status" aria-live="polite"></p>
              <div class="budget-picker-list" id="stop-add-results" role="list"></div></section>`
          : `<button type="button" class="stop-add-open" data-add-open>+ Add a stop to Day ${esc(day.day)}</button>`;
        setBody(`${intro}${tabs}<p class="stop-day-label">Day ${esc(day.day)}${day.dateLabel ? ` · ${esc(day.dateLabel)}` : ""}</p>${stops}${addStop}`);
        const body = $("budget-picker-body");
        body.scrollTop = keepScroll ?? 0;
        keepScroll = null;
        const rerender = () => { keepScroll = body.scrollTop; render(); };
        body.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
          picks[button.dataset.remove] = "";
          if (searchingKey === button.dataset.remove) searchingKey = null;
          rerender();
        }));
        body.querySelectorAll("[data-restore]").forEach((button) => button.addEventListener("click", () => {
          const stop = day.stops.find((item) => item.key === button.dataset.restore);
          const free = (stop?.options || []).find((option) => !takenElsewhere(option.placeId, stop.key));
          if (free) picks[stop.key] = free.placeId; else delete picks[stop.key];
          rerender();
        }));
        body.querySelector("[data-add-open]")?.addEventListener("click", () => {
          addingDay = dayIndex;
          searchingKey = null;
          rerender();
          $("stop-add-input")?.focus();
        });
        body.querySelector("[data-add-cancel]")?.addEventListener("click", () => {
          addingDay = null;
          rerender();
        });
        wireAddSearch(day, dayIndex, rerender);
        body.querySelectorAll("[data-search-open]").forEach((button) => button.addEventListener("click", () => {
          searchingKey = button.dataset.searchOpen;
          addingDay = null;
          rerender();
          $("stop-search-input")?.focus();
        }));
        body.querySelector("[data-search-cancel]")?.addEventListener("click", () => {
          searchingKey = null;
          rerender();
        });
        // The open search looks near where the traveler comes from before this stop.
        const searchIndex = searchingKey ? day.stops.findIndex((stop) => stop.key === searchingKey) : -1;
        if (searchIndex >= 0) {
          const stop = day.stops[searchIndex];
          const from = comingFrom(dayIndex, searchIndex);
          const first = point(stop.options?.[0]);
          wireSearchBox({
            inputId: "stop-search-input", statusId: "stop-search-status", resultsId: "stop-search-results",
            near: from?.at || first, fromLabel: from ? from.label : first ? `from ${first.name}` : "",
            onPick: (place, status) => pickSearched(stop, place, rerender, status),
          });
        }
        body.querySelectorAll(".stop-day-tabs .day-tab").forEach((tab) => tab.addEventListener("click", () => {
          dayIndex = Number(tab.dataset.dayIndex) || 0;
          addingDay = null;
          searchingKey = null;
          render();
        }));
        body.querySelectorAll(".stop-option").forEach((button) => button.addEventListener("click", () => {
          if (button.disabled) return;
          const scroll = body.scrollTop;
          picks[button.dataset.stop] = button.dataset.place;
          render();
          body.scrollTop = scroll;
        }));
        body.querySelectorAll(".stop-option-photo").forEach((img) => img.addEventListener("error", () => img.remove()));
        body.querySelectorAll(".stop-option-info").forEach((button) => button.addEventListener("click", () => {
          const stopIdx = day.stops.findIndex((item) => item.key === button.dataset.infoStop);
          const stop = day.stops[stopIdx];
          const option = stop ? optionsOf(stop).find((item) => item.placeId === button.dataset.infoPlace) : null;
          if (!option) return;
          const label = [`Stop ${stopIdx + 1}`, STOP_TIMES[String(stop.bestTime || "").toLowerCase()] || "", capitalize(stop.category)].filter(Boolean).join(" · ");
          showOptionDetails(stop, option, label, ratingText(option));
        }));
        const last = dayIndex === days.length - 1;
        setActions([
          { label: "Cancel", onClick: () => { void requestCancel(); } },
          last
            ? { label: "Build itinerary", kind: "primary", onClick: () => { onClose = null; close(); finish(result()); } }
            : { label: `Next: Day ${days[dayIndex + 1].day}`, kind: "primary", onClick: () => { dayIndex += 1; addingDay = null; searchingKey = null; render(); } },
        ], { pair: true });
      }
      render();
    });
  }

  window.SidekickBudgetPickers = { askHotel, openRestaurants, askStops };
})();
