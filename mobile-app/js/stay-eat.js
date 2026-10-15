// Hotels & restaurants near the chosen trip destination (itinerary screen).
// Self-contained: uses the existing /api/maps/* endpoints and keeps the chosen
// hotel in its own storage key so the itinerary data is never modified.
(function () {
  const STAY_KEY = "sidekick.stayByEmail.v1";
  const SELECTED_DESTINATION_KEY = "sidekick.selectedDestination.v1";
  const PENDING_CHAT_MESSAGE_KEY = "sidekick.pendingChatMessage.v1";
  const NEARBY_RADIUS_KM = 40;
  const PAGE_SIZE = 10;

  const HOTEL_TYPE = /(^|_)(lodging|hotel|resort|hostel|inn|motel|homestay|guest_house|bed_and_breakfast|cottage|villa|extended_stay_hotel)(_|$)/;
  const FOOD_TYPE = /(restaurant|cafe|coffee|food|bakery|bar_and_grill|diner|eatery|meal_takeaway|meal_delivery|ice_cream|pizza|seafood|steak)/;

  const KINDS = {
    hotels: {
      label: "Hotels",
      queries: (area) => [`hotels in ${area}`, `resorts in ${area}`, `hostels and inns in ${area}`],
      matches: (place) => (place.types || []).some((type) => HOTEL_TYPE.test(String(type).toLowerCase())),
      empty: "No hotels found near this destination.",
    },
    restaurants: {
      label: "Restaurants",
      queries: (area) => [`restaurants in ${area}`, `local food in ${area}`, `cafes in ${area}`],
      matches: (place) => (place.types || []).some((type) => FOOD_TYPE.test(String(type).toLowerCase())),
      empty: "No restaurants found near this destination.",
    },
  };

  const state = {
    email: "",
    kind: "hotels",
    areaKey: "",
    area: null, // { name, lat, lng }
    lists: {}, // `${kind}|${areaKey}` -> unranked search results
    ranked: null, // { kind, trip, places } currently shown, ranked against the budget
    rateCache: new Map(), // `${areaKey}|${start}|${end}` -> researched hotel rates
    ratesNote: "",
    shown: 0,
    loadedKey: "", // `${kind}|${areaKey}` of the list currently rendered
    requestId: 0,
    stale: true,
    modalPlace: null,
    modalKind: "hotels",
    map: null,
  };

  const esc = (text) => window.SidekickCore.escapeHtml(text);
  const $ = (id) => document.getElementById(id);

  function isDevMode() {
    return String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development";
  }

  function hasCoords(place) {
    return place && place.lat != null && place.lng != null && place.lat !== "" && place.lng !== ""
      && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng));
  }

  function distanceKm(a, b) {
    const toRad = (deg) => (Number(deg) * Math.PI) / 180;
    const dLat = toRad(b.lat) - toRad(a.lat);
    const dLng = toRad(b.lng) - toRad(a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function photoUrl(place) {
    const resource = String(place?.photoResource || "").trim();
    if (!resource || isDevMode()) return "";
    let base = "";
    try { base = window.SidekickCore.getApiBaseUrl() || ""; } catch (error) { base = ""; }
    if (!base && !window.location.protocol.startsWith("http")) return "";
    return `${base}/api/maps/photo?name=${encodeURIComponent(resource)}`;
  }

  function priceLabel(level) {
    const map = {
      PRICE_LEVEL_FREE: "Free",
      PRICE_LEVEL_INEXPENSIVE: "₱",
      PRICE_LEVEL_MODERATE: "₱₱",
      PRICE_LEVEL_EXPENSIVE: "₱₱₱",
      PRICE_LEVEL_VERY_EXPENSIVE: "₱₱₱₱",
    };
    return map[level] || "";
  }

  function ratingLabel(place) {
    const rating = Number(place.rating);
    if (!Number.isFinite(rating) || rating <= 0) return "";
    const count = Number(place.ratingCount);
    return `★ ${rating.toFixed(1)}${Number.isFinite(count) && count > 0 ? ` (${count.toLocaleString()})` : ""}`;
  }

  // ---- budget fit ------------------------------------------------------------
  // Shares of the whole-trip budget, matching the backend and the budget pickers:
  // 40% for lodging and 20% for meals eaten out (two a day).
  const LODGING_SHARE = 0.4;
  const MEAL_SHARE = 0.2;
  const MEALS_OUT_PER_DAY = 2;
  // Rough PHP ranges for Google's price levels, used only when there is no
  // researched rate or Google price range. Hotels: per night. Restaurants: per person.
  const PRICE_LEVEL_PHP = {
    hotels: {
      PRICE_LEVEL_INEXPENSIVE: [800, 2000],
      PRICE_LEVEL_MODERATE: [2000, 4500],
      PRICE_LEVEL_EXPENSIVE: [4500, 9000],
      PRICE_LEVEL_VERY_EXPENSIVE: [9000, null],
    },
    restaurants: {
      PRICE_LEVEL_FREE: [0, 0],
      PRICE_LEVEL_INEXPENSIVE: [100, 300],
      PRICE_LEVEL_MODERATE: [300, 700],
      PRICE_LEVEL_EXPENSIVE: [700, 1500],
      PRICE_LEVEL_VERY_EXPENSIVE: [1500, 4000],
    },
  };
  const FIT_ORDER = { within: 0, partial: 1, unknown: 2, over: 3 };
  const FIT_LABEL = { within: "Within budget", partial: "May fit budget", unknown: "Price unknown", over: "Over budget" };
  const peso = (amount) => `₱${Math.round(Number(amount)).toLocaleString()}`;

  function parseDay(value) {
    const text = String(value || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? text : "";
  }

  // The trip budget and dates: the form first, then the saved itinerary.
  function readTrip() {
    let meta = {};
    try { meta = window.SidekickCore.getItineraryByEmail()[state.email]?.meta || {}; } catch (error) {}
    const typedBudget = Number($("itinerary-budget")?.value);
    const budget = Number.isFinite(typedBudget) && typedBudget > 0 ? Math.floor(typedBudget)
      : Number(meta.budgetAmountPhp) > 0 ? Math.floor(Number(meta.budgetAmountPhp)) : null;
    const startDate = parseDay($("itinerary-start")?.value) || parseDay(meta.startDate);
    const endDate = parseDay($("itinerary-end")?.value) || parseDay(meta.endDate);
    let days = null;
    if (startDate && endDate) {
      const span = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
      if (span >= 1 && span <= 14) days = span;
    }
    // Per-night and per-meal amounts need the trip length; without dates, rank by stars only.
    if (!budget || !days) return { budget, days, startDate, endDate };
    const nights = Math.max(1, days - 1);
    return {
      budget, days, startDate, endDate, nights,
      hotelCap: Math.floor((budget * LODGING_SHARE) / nights),
      mealCap: Math.floor((budget * MEAL_SHARE) / (days * MEALS_OUT_PER_DAY)),
    };
  }

  // { low, high, source } in PHP: per night for hotels, per person for restaurants.
  function placePrice(place, kind) {
    const rate = place.researchedRate;
    if (kind === "hotels" && rate && Number(rate.lowPhp) > 0) {
      return { low: Number(rate.lowPhp), high: Number(rate.highPhp) || null, source: "researched" };
    }
    // Google's price range is what people spend per person (a meal), not a room
    // rate, so it is only used for restaurants.
    const range = kind === "hotels" ? null : place.priceRange;
    if (range && Number.isFinite(Number(range.lowPhp))) {
      const high = range.highPhp == null ? null : Number(range.highPhp);
      // Google's cheapest band starts at ₱1 ("₱1–200" means "under ₱200").
      const low = Number(range.lowPhp) < 50 ? 0 : Number(range.lowPhp);
      if (low === 0 && !(high > 0)) return null;
      return { low, high: Number.isFinite(high) ? high : null, source: "google" };
    }
    const level = PRICE_LEVEL_PHP[kind]?.[place.priceLevel];
    return level ? { low: level[0], high: level[1], source: "estimate" } : null;
  }

  function budgetFit(price, cap) {
    if (!price) return "unknown";
    if (price.low > cap) return "over";
    // An open-ended range ("₱9,000+") can't be confirmed as fully within budget.
    return price.high != null && price.high <= cap ? "within" : "partial";
  }

  function priceText(price, kind) {
    if (!price) return "";
    const range = price.low === 0 && price.high > 0 ? `Under ${peso(price.high)}`
      : price.high != null && price.high > price.low ? `${peso(price.low)}–${peso(price.high)}`
      : price.high == null ? `${peso(price.low)}+` : peso(price.low);
    return `${price.source === "estimate" ? "about " : ""}${range} ${kind === "hotels" ? "/ night" : "/ person"}`;
  }

  // Stars weighted by review count: a 4.9 from 8 reviews ranks below a 4.7 from 2,000.
  function starScore(place) {
    const rating = Number(place.rating) || 0;
    const count = Number(place.ratingCount) || 0;
    if (!rating) return 0;
    return (rating * count + 4.0 * 20) / (count + 20);
  }

  // ---- chosen hotel storage ------------------------------------------------
  function readStayMap() {
    try { return JSON.parse(localStorage.getItem(STAY_KEY) || "{}") || {}; } catch (error) { return {}; }
  }

  function getChosenStay() {
    return readStayMap()[state.email] || null;
  }

  function setChosenStay(place, areaName = state.area?.name || "") {
    const all = readStayMap();
    if (place) {
      all[state.email] = {
        placeId: place.placeId || "",
        name: place.name,
        address: place.address || "",
        lat: place.lat,
        lng: place.lng,
        rating: place.rating,
        area: areaName,
        chosenAt: Date.now(),
      };
    } else {
      delete all[state.email];
    }
    try { localStorage.setItem(STAY_KEY, JSON.stringify(all)); } catch (error) {}
    renderStayBanner();
  }

  function isChosenStay(place) {
    const stay = getChosenStay();
    if (!stay) return false;
    return (stay.placeId && stay.placeId === place.placeId) || (!stay.placeId && stay.name === place.name);
  }

  function renderStayBanner() {
    const stay = getChosenStay();
    const summary = $("stay-eat-summary-stay");
    if (summary) summary.textContent = stay ? `Staying at ${stay.name}` : "";
    const banner = $("stay-eat-banner");
    if (!banner) return;
    banner.replaceChildren();
    banner.hidden = !stay;
    if (!stay) return;
    const text = document.createElement("span");
    text.innerHTML = `<small>Your stay</small><strong>${esc(stay.name)}</strong>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "stay-eat-link";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      setChosenStay(null);
      refreshRowStates();
    });
    banner.append(text, remove);
  }

  // ---- destination / area --------------------------------------------------
  function currentDestination() {
    const input = $("itinerary-destination");
    const typed = String(input?.value || "").trim();
    if (typed) return { name: typed, placeId: input?.dataset?.placeId || "" };
    try {
      const meta = window.SidekickCore.getItineraryByEmail()[state.email]?.meta || {};
      const name = String(meta.destination || meta.focusedPlace || "").trim();
      if (name) return { name, placeId: "" };
    } catch (error) {}
    return null;
  }

  async function resolveArea(destination) {
    const key = `${destination.placeId || ""}|${destination.name.toLowerCase()}`;
    if (state.area && state.areaKey === key) return state.area;
    const area = { name: destination.name, lat: null, lng: null };
    try {
      if (destination.placeId) {
        const data = await window.SidekickCore.apiRequest("/api/maps/place-details", {
          method: "POST", body: JSON.stringify({ placeId: destination.placeId }),
        });
        if (hasCoords(data?.place)) {
          area.lat = Number(data.place.lat);
          area.lng = Number(data.place.lng);
        }
      }
      if (area.lat === null) {
        const data = await window.SidekickCore.apiRequest("/api/maps/places", {
          method: "POST", body: JSON.stringify({ queries: [destination.name] }),
        });
        if (!data.isDevelopmentMock) {
          const first = (data.places || []).find(hasCoords);
          if (first) {
            area.lat = Number(first.lat);
            area.lng = Number(first.lng);
          }
        }
      }
    } catch (error) {
      // Fall back to a name-only search below.
    }
    state.area = area;
    state.areaKey = key;
    return area;
  }

  // ---- search --------------------------------------------------------------
  // With a budget: places that fit come first, then unknown prices, then over budget.
  // Within each group, better stars (weighted by review count) come first.
  // Without a budget (or dates), it is simply best stars first.
  function rankPlaces(places, kind, trip) {
    const cap = kind === "hotels" ? trip?.hotelCap : trip?.mealCap;
    const ranked = places.map((place) => {
      const price = placePrice(place, kind);
      return { ...place, price, fit: cap ? budgetFit(price, cap) : null, stars: starScore(place) };
    });
    ranked.sort((a, b) => (cap ? FIT_ORDER[a.fit] - FIT_ORDER[b.fit] : 0)
      || b.stars - a.stars
      || (Number(b.ratingCount) || 0) - (Number(a.ratingCount) || 0)
      || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    return ranked;
  }

  // Researched nightly rates from the backend (web-sourced, cached there for 6 hours).
  async function fetchHotelRates(area, trip) {
    const key = `${state.areaKey}|${trip.startDate}|${trip.endDate}`;
    if (state.rateCache.has(key)) return state.rateCache.get(key);
    try {
      const data = await window.SidekickCore.apiRequest("/api/hotels/budget-options", {
        method: "POST",
        body: JSON.stringify({
          destination: area.name, startDate: trip.startDate, endDate: trip.endDate,
          budgetAmountPhp: trip.budget, lat: area.lat, lng: area.lng,
        }),
      });
      if (data.isDevelopmentMock) return { hotels: [], failed: true };
      const result = { hotels: [...(data.hotels || []), ...(data.overBudgetHotels || [])], failed: false };
      state.rateCache.set(key, result);
      return result;
    } catch (error) {
      // Not cached, so a later attempt can try again (for example after a rate limit).
      return { hotels: [], failed: true };
    }
  }

  function withHotelRates(places, rateResult, area) {
    const byId = new Map(rateResult.hotels.map((hotel) => [hotel.placeId, hotel]));
    const rateOf = (hotel) => ({
      lowPhp: hotel.nightlyLowPhp, highPhp: hotel.nightlyHighPhp, basis: hotel.basis || "", sourceUrls: hotel.sourceUrls || [],
    });
    const merged = places.map((place) => (byId.has(place.placeId) ? { ...place, researchedRate: rateOf(byId.get(place.placeId)) } : place));
    const known = new Set(places.map((place) => place.placeId));
    // Priced hotels the general search missed are added too.
    for (const hotel of rateResult.hotels) {
      if (known.has(hotel.placeId) || !hasCoords(hotel)) continue;
      merged.push({
        ...hotel,
        distanceKm: hasCoords(area) ? distanceKm(area, hotel) : null,
        researchedRate: rateOf(hotel),
      });
    }
    return merged;
  }

  async function searchKind(kind, area) {
    const config = KINDS[kind];
    const seeds = hasCoords(area) ? [{ lat: Number(area.lat), lng: Number(area.lng) }] : [];
    const data = await window.SidekickCore.apiRequest("/api/maps/places", {
      method: "POST", body: JSON.stringify({ queries: config.queries(area.name), seeds }),
    });
    if (data.isDevelopmentMock) return { places: [], isDevelopmentMock: true };
    const seen = new Set();
    let places = (data.places || []).filter((place) => place.placeId && hasCoords(place) && !seen.has(place.placeId) && seen.add(place.placeId));
    const typed = places.filter(config.matches);
    // Result types are truncated, so fall back to the specific search results if nothing matched.
    if (typed.length) places = typed;
    if (hasCoords(area)) {
      const near = places.filter((place) => distanceKm(area, place) <= NEARBY_RADIUS_KM);
      if (near.length >= 3) places = near;
    }
    places = places.map((place) => ({ ...place, distanceKm: hasCoords(area) ? distanceKm(area, place) : null }));
    return { places, isDevelopmentMock: false };
  }

  function setStatus(text) {
    const status = $("stay-eat-status");
    if (status) status.textContent = text || "";
  }

  async function loadKind(kind, { force = false } = {}) {
    const list = $("stay-eat-list");
    const more = $("stay-eat-more");
    if (!list) return;
    const destination = currentDestination();
    if (!destination) {
      list.replaceChildren();
      if (more) more.hidden = true;
      setStatus("Choose a destination above to see hotels and restaurants nearby.");
      state.loadedKey = "";
      state.ranked = null;
      return;
    }
    const requestId = ++state.requestId;
    list.replaceChildren();
    if (more) more.hidden = true;
    setStatus("Finding places near " + destination.name + "…");
    try {
      const area = await resolveArea(destination);
      if (requestId !== state.requestId) return;
      // A stay chosen for a different destination is stale unless a trip already exists.
      const stay = getChosenStay();
      if (stay?.area && stay.area.toLowerCase() !== area.name.toLowerCase()
        && !window.SidekickCore.getItineraryByEmail()[state.email]) {
        setChosenStay(null);
      }
      const cacheKey = `${kind}|${state.areaKey}`;
      if (force || !state.lists[cacheKey]) {
        const result = await searchKind(kind, area);
        if (requestId !== state.requestId) return;
        state.lists[cacheKey] = result;
      }
      state.loadedKey = cacheKey;
      state.stale = false;
      const result = state.lists[cacheKey];
      if (result.isDevelopmentMock) {
        state.ranked = null;
        setStatus("Hotel and restaurant search needs live Google Places data, which is not available in development mode.");
        return;
      }
      renderRanked();

      // Hotels: fetch researched nightly rates in the background, then re-rank.
      const trip = readTrip();
      if (kind === "hotels" && trip.hotelCap && result.places.length) {
        const rateKey = `${state.areaKey}|${trip.startDate}|${trip.endDate}`;
        if (!state.rateCache.has(rateKey)) {
          state.ratesNote = "Checking current hotel prices… Estimates are shown until then.";
          renderSubtitle();
          const rates = await fetchHotelRates(area, trip);
          if (requestId !== state.requestId) return;
          state.ratesNote = rates.failed
            ? "Live hotel prices are unavailable right now, so prices are estimated from Google’s price levels."
            : "";
          renderRanked();
        }
      }
    } catch (error) {
      if (requestId !== state.requestId) return;
      setStatus(error?.message || "Unable to load nearby places right now.");
    }
  }

  // Ranks the loaded list against the current budget and redraws it.
  // Budget and date edits only call this; no new search is made.
  function renderRanked() {
    const result = state.lists[state.loadedKey];
    const list = $("stay-eat-list");
    if (!result || !list || result.isDevelopmentMock) return;
    const kind = state.loadedKey.split("|")[0];
    const trip = readTrip();
    let places = result.places;
    if (kind === "hotels" && trip.startDate && trip.endDate) {
      const rates = state.rateCache.get(`${state.areaKey}|${trip.startDate}|${trip.endDate}`);
      if (rates) places = withHotelRates(places, rates, state.area);
    }
    state.ranked = { kind, trip, places: rankPlaces(places, kind, trip) };
    list.replaceChildren();
    state.shown = 0;
    renderSubtitle();
    if (!state.ranked.places.length) {
      setStatus(KINDS[kind].empty);
      if ($("stay-eat-more")) $("stay-eat-more").hidden = true;
      return;
    }
    setStatus("");
    showMore();
  }

  function renderSubtitle() {
    const subtitle = $("stay-eat-area");
    if (!subtitle || !state.area) return;
    const trip = readTrip();
    const kind = state.kind;
    let text = `Near ${state.area.name}`;
    if (trip.budget && trip.days) {
      const cap = kind === "hotels" ? trip.hotelCap : trip.mealCap;
      text += kind === "hotels"
        ? ` • Up to ${peso(cap)} a night (40% of your budget over ${trip.nights} night${trip.nights === 1 ? "" : "s"})`
        : ` • Up to ${peso(cap)} a meal per person (20% of your budget, 2 meals a day)`;
      text += " • Fits your budget first, then best rated";
    } else if (trip.budget) {
      text += " • Add trip dates to rank by your budget • Best rated first";
    } else {
      text += " • Enter a budget to see what fits • Best rated first";
    }
    subtitle.textContent = text;
    const note = $("stay-eat-rates-note");
    if (note) {
      note.textContent = kind === "hotels" ? state.ratesNote : "";
      note.hidden = !note.textContent;
    }
  }

  function currentResult() {
    return state.ranked;
  }

  function rowMarkup(place, index) {
    const kind = state.ranked?.kind || state.kind;
    const detail = [
      ratingLabel(place),
      priceText(place.price, kind) || priceLabel(place.priceLevel),
      place.distanceKm != null ? `${place.distanceKm < 10 ? place.distanceKm.toFixed(1) : Math.round(place.distanceKm)} km away` : "",
    ].filter(Boolean).join(" • ");
    const chosen = kind === "hotels" && isChosenStay(place);
    const fit = place.fit ? `<b class="stay-eat-fit fit-${place.fit}">${esc(FIT_LABEL[place.fit])}</b>` : "";
    return `<button type="button" class="stay-eat-item${chosen ? " chosen" : ""}" role="listitem" data-index="${index}">`
      + `<span class="stay-eat-text"><strong>${esc(place.name)}</strong>`
      + `<small>${esc(place.address || "Address unavailable")}</small>`
      + `<small class="stay-eat-meta">${esc(detail)}</small>`
      + (fit || chosen ? `<span class="stay-eat-tags">${fit}${chosen ? '<b class="stay-eat-badge">Your stay</b>' : ""}</span>` : "")
      + "</span>"
      + '<svg class="stay-eat-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'
      + "</button>";
  }

  function showMore() {
    const result = currentResult();
    const list = $("stay-eat-list");
    const more = $("stay-eat-more");
    if (!result || !list) return;
    const start = state.shown;
    const end = Math.min(start + PAGE_SIZE, result.places.length);
    list.insertAdjacentHTML("beforeend", result.places.slice(start, end).map((place, offset) => rowMarkup(place, start + offset)).join(""));
    state.shown = end;
    if (more) {
      const remaining = result.places.length - end;
      more.hidden = remaining <= 0;
      if (remaining > 0) more.textContent = `Show more (${remaining} left)`;
    }
  }

  function refreshRowStates() {
    const result = currentResult();
    const list = $("stay-eat-list");
    if (!result || !list) return;
    list.querySelectorAll(".stay-eat-item").forEach((row) => {
      const place = result.places[Number(row.dataset.index)];
      if (!place) return;
      const chosen = result.kind === "hotels" && isChosenStay(place);
      row.classList.toggle("chosen", chosen);
      let tags = row.querySelector(".stay-eat-tags");
      tags?.querySelector(".stay-eat-badge")?.remove();
      if (!chosen) return;
      if (!tags) {
        tags = document.createElement("span");
        tags.className = "stay-eat-tags";
        row.querySelector(".stay-eat-text")?.appendChild(tags);
      }
      tags.insertAdjacentHTML("beforeend", '<b class="stay-eat-badge">Your stay</b>');
    });
  }

  function setKind(kind) {
    state.kind = kind;
    document.querySelectorAll(".stay-eat-tab").forEach((tab) => {
      const active = tab.dataset.kind === kind;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    void loadKind(kind);
  }

  // ---- detail modal --------------------------------------------------------
  function ensureModal() {
    let modal = $("stay-eat-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "stay-eat-modal";
    modal.className = "stay-eat-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="stay-eat-modal-backdrop" data-close="1"></div>
      <div class="stay-eat-modal-panel" role="dialog" aria-modal="true" aria-labelledby="stay-eat-modal-title">
        <div class="stay-eat-modal-header">
          <h3 id="stay-eat-modal-title">Place</h3>
          <button type="button" class="stay-eat-modal-close" id="stay-eat-modal-close" aria-label="Close details">×</button>
        </div>
        <div id="stay-eat-modal-photo" class="stay-eat-modal-photo"></div>
        <p id="stay-eat-modal-address" class="stay-eat-modal-address"></p>
        <div id="stay-eat-modal-facts" class="stay-eat-modal-facts"></div>
        <div id="stay-eat-modal-tags" class="stay-eat-modal-tags"></div>
        <details id="stay-eat-modal-hours" class="stay-eat-modal-hours"><summary>Opening hours</summary><ul id="stay-eat-modal-hours-list"></ul></details>
        <div id="stay-eat-modal-map" class="stay-eat-modal-map"></div>
        <div class="stay-eat-modal-actions">
          <button type="button" class="btn btn-primary" id="stay-eat-modal-choose" hidden>Choose as my stay</button>
          <button type="button" class="btn btn-outline" id="stay-eat-modal-add">Add to itinerary</button>
          <a class="btn btn-outline" id="stay-eat-modal-maps" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>
          <button type="button" class="btn btn-outline" id="stay-eat-modal-ask">Ask AI</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target?.dataset?.close === "1") closeModal();
    });
    $("stay-eat-modal-close").addEventListener("click", closeModal);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.classList.contains("open")) closeModal();
    });
    $("stay-eat-modal-choose").addEventListener("click", () => {
      const place = state.modalPlace;
      if (!place) return;
      setChosenStay(isChosenStay(place) ? null : place);
      refreshRowStates();
      updateChooseButton();
    });
    $("stay-eat-modal-add").addEventListener("click", () => {
      const place = state.modalPlace;
      const editor = window.SidekickItineraryEdit;
      if (!place) return;
      if (!editor?.hasItinerary?.()) {
        window.SidekickUI.alert("Build your itinerary first, then you can add places to it.", { title: "No itinerary yet" });
        return;
      }
      closeModal();
      editor.openAddPlace(place, state.modalKind === "hotels" ? "hotel" : state.modalKind === "restaurants" ? "restaurant" : "");
    });
    $("stay-eat-modal-ask").addEventListener("click", () => {
      const place = state.modalPlace;
      if (!place) return;
      try {
        localStorage.setItem(SELECTED_DESTINATION_KEY, JSON.stringify({
          name: place.name, placeId: place.placeId, lat: place.lat, lng: place.lng, address: place.address || "",
        }));
        sessionStorage.setItem(PENDING_CHAT_MESSAGE_KEY, `What do visitors think of ${place.name}?`);
      } catch (error) {}
      window.location.href = "chat.html";
    });
    return modal;
  }

  function updateChooseButton() {
    const button = $("stay-eat-modal-choose");
    if (!button) return;
    const isHotel = state.modalKind === "hotels";
    button.hidden = !isHotel;
    if (isHotel && state.modalPlace) {
      button.textContent = isChosenStay(state.modalPlace) ? "Remove as my stay" : "Choose as my stay";
    }
  }

  function closeModal() {
    const modal = $("stay-eat-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  async function openModal(place, kind) {
    const modal = ensureModal();
    state.modalPlace = place;
    state.modalKind = kind;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    modal.querySelector(".stay-eat-modal-panel").scrollTop = 0;

    $("stay-eat-modal-title").textContent = place.name;
    $("stay-eat-modal-address").textContent = place.address || "Address unavailable";

    const photoBox = $("stay-eat-modal-photo");
    const url = photoUrl(place);
    photoBox.replaceChildren();
    photoBox.hidden = !url;
    if (url) {
      const img = document.createElement("img");
      img.alt = `Photo of ${place.name}`;
      img.loading = "lazy";
      img.addEventListener("error", () => { photoBox.hidden = true; }, { once: true });
      img.src = url;
      photoBox.appendChild(img);
      const credit = place.photoAttribution;
      if (credit?.name) {
        const small = document.createElement("small");
        small.className = "stay-eat-photo-credit";
        const uri = /^https:\/\//i.test(String(credit.uri || "")) ? String(credit.uri) : "";
        if (uri) {
          const link = document.createElement("a");
          link.href = uri;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = `Photo: ${credit.name}`;
          small.appendChild(link);
        } else {
          small.textContent = `Photo: ${credit.name}`;
        }
        photoBox.appendChild(small);
      }
    }

    const priceSource = {
      researched: "Current rate found online",
      google: "Price range from Google",
      estimate: "Estimated from Google’s price level",
    }[place.price?.source] || "";
    const facts = [
      ratingLabel(place) && ["Rating", ratingLabel(place)],
      place.price ? ["Price", priceText(place.price, kind)] : priceLabel(place.priceLevel) && ["Price", priceLabel(place.priceLevel)],
      place.fit && ["Your budget", FIT_LABEL[place.fit]],
      place.distanceKm != null && ["Distance", `${place.distanceKm < 10 ? place.distanceKm.toFixed(1) : Math.round(place.distanceKm)} km from ${state.area?.name || "destination"}`],
    ].filter(Boolean);
    const sources = (place.researchedRate?.sourceUrls || []).filter((url) => /^https:\/\//i.test(String(url))).slice(0, 3);
    $("stay-eat-modal-facts").innerHTML = facts.map(([label, value]) => `<div class="stay-eat-fact"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")
      + (priceSource ? `<p class="stay-eat-price-note">${esc(priceSource)}${place.researchedRate?.basis ? `: ${esc(place.researchedRate.basis)}` : ""}.`
        + (sources.length ? ` Sources: ${sources.map((url, i) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${i + 1}</a>`).join(", ")}` : "")
        + " Check the price before booking.</p>" : "");

    const tagLabels = (place.types || [])
      .filter((type) => !["point_of_interest", "establishment"].includes(type))
      .slice(0, 4).map((type) => String(type).replace(/_/g, " "));
    $("stay-eat-modal-tags").innerHTML = tagLabels.map((tag) => `<span class="stay-eat-tag">${esc(tag)}</span>`).join("");

    const hours = Array.isArray(place.openingHours) ? place.openingHours.filter(Boolean) : [];
    const hoursBox = $("stay-eat-modal-hours");
    hoursBox.hidden = !hours.length;
    hoursBox.open = false;
    $("stay-eat-modal-hours-list").innerHTML = hours.map((line) => `<li>${esc(line)}</li>`).join("");

    const mapsLink = $("stay-eat-modal-maps");
    mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.lat},${place.lng}`)}${place.placeId ? `&query_place_id=${encodeURIComponent(place.placeId)}` : ""}`;
    updateChooseButton();

    const mapEl = $("stay-eat-modal-map");
    mapEl.replaceChildren();
    mapEl.style.display = "";
    mapEl.textContent = "Map loading…";
    try {
      if (typeof loadGoogleMapsForItinerary !== "function") throw new Error("The map is unavailable.");
      await loadGoogleMapsForItinerary();
      if (state.modalPlace !== place) return;
      mapEl.textContent = "";
      mapEl.style.display = "block";
      const position = { lat: Number(place.lat), lng: Number(place.lng) };
      state.map = new google.maps.Map(mapEl, { center: position, zoom: 15, disableDefaultUI: true });
      new google.maps.Marker({ map: state.map, position, title: place.name });
      requestAnimationFrame(() => google.maps.event.trigger(state.map, "resize"));
    } catch (error) {
      mapEl.textContent = "Interactive map is unavailable. Use “Open in Google Maps” instead.";
    }
  }

  // ---- init ----------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    const section = $("stay-eat");
    const session = window.SidekickCore?.getAuthSession?.();
    if (!section || !session?.email) return;
    state.email = session.email;

    renderStayBanner();

    section.addEventListener("toggle", () => {
      if (!section.open) return;
      const destination = currentDestination();
      const key = destination ? `${destination.placeId || ""}|${destination.name.toLowerCase()}` : "";
      // Load on first open, or when the destination changed since the last load.
      if (state.stale || state.areaKey !== key || !state.loadedKey) setKind(state.kind);
    });

    document.querySelectorAll(".stay-eat-tab").forEach((tab) => {
      tab.addEventListener("click", () => setKind(tab.dataset.kind));
    });

    const list = $("stay-eat-list");
    if (list) {
      list.addEventListener("click", (event) => {
        const row = event.target.closest(".stay-eat-item");
        const place = row ? currentResult()?.places[Number(row.dataset.index)] : null;
        if (place) void openModal(place, state.kind);
      });
    }
    $("stay-eat-more")?.addEventListener("click", showMore);

    // Show recommendations as soon as both a destination and a budget are entered.
    const maybeAutoOpen = () => {
      if (section.open || !currentDestination() || !readTrip().budget) return;
      section.open = true; // fires "toggle", which loads the list
    };

    // Budget or dates changed: re-rank the loaded list (no new place search).
    // New dates may also need researched hotel rates for those nights.
    let rerankTimer = null;
    const onBudgetOrDatesChanged = () => {
      clearTimeout(rerankTimer);
      rerankTimer = setTimeout(() => {
        if (!section.open) {
          maybeAutoOpen();
          return;
        }
        if (!state.loadedKey) return;
        const trip = readTrip();
        const needsRates = state.kind === "hotels" && trip.hotelCap
          && !state.rateCache.has(`${state.areaKey}|${trip.startDate}|${trip.endDate}`);
        if (needsRates) void loadKind(state.kind);
        else renderRanked();
      }, 500);
    };
    ["itinerary-budget", "itinerary-start", "itinerary-end"].forEach((id) => {
      $(id)?.addEventListener("input", onBudgetOrDatesChanged);
      $(id)?.addEventListener("change", onBudgetOrDatesChanged);
    });

    // The destination changed: mark stale and reload right away if the section is open.
    let reloadTimer = null;
    const onDestinationChanged = () => {
      state.stale = true;
      if (!section.open) {
        maybeAutoOpen();
        return;
      }
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => setKind(state.kind), 400);
    };
    document.addEventListener("sidekick:destination-chosen", onDestinationChanged);
    $("itinerary-destination")?.addEventListener("input", () => { state.stale = true; });

    // Removing the whole itinerary also clears the chosen stay.
    document.addEventListener("sidekick:itinerary-updated", () => {
      try {
        if (!window.SidekickCore.getItineraryByEmail()[state.email] && getChosenStay()) {
          setChosenStay(null);
          refreshRowStates();
        }
      } catch (error) {}
    });
  });

  window.SidekickStayEat = {
    // Details pop-up for any spot (e.g. "Explore places" results and map pins).
    openPlace(place) {
      if (place?.name) void openModal(place, "places");
    },
    getChosenStay: () => (state.email ? getChosenStay() : null),
    setStay(place, areaName) {
      if (!state.email || !place?.name) return;
      setChosenStay(place, String(areaName || ""));
      refreshRowStates();
    },
  };
})();
