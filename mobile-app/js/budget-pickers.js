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
              </span>
            </button>`;
        }).join("");
        const extra = [
          data.overBudgetCount ? `${data.overBudgetCount} over budget` : "",
          data.unpricedCount ? `${data.unpricedCount} without a confirmed price` : "",
        ].filter(Boolean).join(", ");
        setBody(`${summary}<div class="budget-picker-list" role="list">${rows}</div>${extra ? `<p class="budget-picker-note">Not shown: ${esc(extra)}. Prices come from current web results and may change.</p>` : '<p class="budget-picker-note">Prices come from current web results and may change.</p>'}`);
        $("budget-picker-body").querySelectorAll(".budget-picker-item").forEach((row) => {
          row.addEventListener("click", () => {
            selected = hotels[Number(row.dataset.index)] || null;
            $("budget-picker-body").querySelectorAll(".budget-picker-item").forEach((item) => item.classList.toggle("selected", item === row));
            const confirmButton = $("budget-picker-confirm");
            if (confirmButton) confirmButton.disabled = !selected;
          });
        });
        setActions([
          { label: "Skip hotel", onClick: () => { onClose = null; close(); finish({ status: "skip" }); } },
          { label: "Continue with this hotel", kind: "primary", id: "budget-picker-confirm", onClick: () => {
            if (!selected) return;
            onClose = null;
            close();
            finish({ status: "chosen", hotel: selected });
          } },
        ]);
        $("budget-picker-confirm").disabled = true;
      }
    });
  }

  // ---- restaurants (after generating) ------------------------------------------
  function restaurantPrice(place) {
    const range = place.priceRange;
    if (range && Number.isFinite(Number(range.lowPhp))) {
      const low = Number(range.lowPhp);
      const high = Number.isFinite(Number(range.highPhp)) && range.highPhp !== null ? Number(range.highPhp) : null;
      return { low, high, exact: true };
    }
    const level = PRICE_LEVEL_PHP[place.priceLevel];
    return level ? { low: level[0], high: level[1], exact: false } : null;
  }

  function priceText(price) {
    if (!price) return "";
    const range = price.high !== null && price.high > price.low ? `${peso(price.low)}–${peso(price.high)}` : price.high === null ? `${peso(price.low)}+` : peso(price.low);
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
    setBody(`${summary}<div class="budget-picker-list" role="list">${affordable.map((place, index) => `
      <button type="button" class="budget-picker-item" data-index="${index}">
        <span class="budget-picker-item-text">
          <strong>${esc(place.name)}</strong>
          <small>${esc(place.address || "")}</small>
          <small class="budget-picker-meta">${esc([ratingText(place), priceText(place.price), place.distanceKm !== null ? `${place.distanceKm.toFixed(1)} km away` : ""].filter(Boolean).join(" • "))}</small>
        </span>
      </button>`).join("")}</div>${note}`);
    $("budget-picker-body").querySelectorAll(".budget-picker-item").forEach((row) => {
      row.addEventListener("click", () => {
        const place = affordable[Number(row.dataset.index)];
        if (!place) return;
        close();
        window.SidekickItineraryEdit?.openAddPlace({ ...place, note: [place.address, priceText(place.price)].filter(Boolean).join(" • ") }, "restaurant", dayIndex);
      });
    });
    setActions([{ label: "Close", onClick: () => close() }]);
  }

  window.SidekickBudgetPickers = { askHotel, openRestaurants };
})();
