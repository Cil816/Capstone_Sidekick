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
    lists: {}, // kind -> places
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
  function rankPlaces(places, area) {
    const hasArea = area && hasCoords(area);
    const scored = places.map((place) => {
      const rating = Number(place.rating) || 0;
      const count = Number(place.ratingCount) || 0;
      const quality = count ? (rating * count + 4.2 * 25) / (count + 25) : rating * 0.8;
      const dist = hasArea && hasCoords(place) ? distanceKm(area, place) : null;
      return { place: { ...place, distanceKm: dist }, score: quality + Math.log10(count + 1) * 0.35 - (dist === null ? 0 : dist / 25) };
    });
    // Highest rated first; more reviews, then closer to the destination, break ties.
    scored.sort((a, b) => {
      const ar = Number(a.place.rating) || 0;
      const br = Number(b.place.rating) || 0;
      if (br !== ar) return br - ar;
      const ac = Number(a.place.ratingCount) || 0;
      const bc = Number(b.place.ratingCount) || 0;
      if (bc !== ac) return bc - ac;
      return (a.place.distanceKm ?? Infinity) - (b.place.distanceKm ?? Infinity);
    });
    return scored.map((entry) => entry.place);
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
    return { places: rankPlaces(places, area), isDevelopmentMock: false };
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
      const result = state.lists[cacheKey];
      state.loadedKey = cacheKey;
      state.stale = false;
      state.shown = 0;
      const subtitle = $("stay-eat-area");
      if (subtitle) subtitle.textContent = `Near ${area.name} \u2022 Highest rated first`;
      if (result.isDevelopmentMock) {
        setStatus("Hotel and restaurant search needs live Google Places data, which is not available in development mode.");
        return;
      }
      if (!result.places.length) {
        setStatus(KINDS[kind].empty);
        return;
      }
      setStatus("");
      showMore();
    } catch (error) {
      if (requestId !== state.requestId) return;
      setStatus(error?.message || "Unable to load nearby places right now.");
    }
  }

  function currentResult() {
    return state.lists[state.loadedKey] || null;
  }

  function rowMarkup(place, index) {
    const detail = [
      ratingLabel(place),
      priceLabel(place.priceLevel),
      place.distanceKm != null ? `${place.distanceKm < 10 ? place.distanceKm.toFixed(1) : Math.round(place.distanceKm)} km away` : "",
    ].filter(Boolean).join(" • ");
    const chosen = state.kind === "hotels" && isChosenStay(place);
    return `<button type="button" class="stay-eat-item${chosen ? " chosen" : ""}" role="listitem" data-index="${index}">`
      + `<span class="stay-eat-text"><strong>${esc(place.name)}</strong>`
      + `<small>${esc(place.address || "Address unavailable")}</small>`
      + `<small class="stay-eat-meta">${esc(detail)}${chosen ? ' <b class="stay-eat-badge">Your stay</b>' : ""}</small></span>`
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
      const chosen = state.kind === "hotels" && isChosenStay(place);
      row.classList.toggle("chosen", chosen);
      const meta = row.querySelector(".stay-eat-meta");
      if (!meta) return;
      meta.querySelector(".stay-eat-badge")?.remove();
      if (chosen) meta.insertAdjacentHTML("beforeend", ' <b class="stay-eat-badge">Your stay</b>');
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
        window.alert("Build your itinerary first, then you can add hotels and restaurants to it.");
        return;
      }
      closeModal();
      editor.openAddPlace(place, state.modalKind === "hotels" ? "hotel" : "restaurant");
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

    const facts = [
      ratingLabel(place) && ["Rating", ratingLabel(place)],
      priceLabel(place.priceLevel) && ["Price", priceLabel(place.priceLevel)],
      place.distanceKm != null && ["Distance", `${place.distanceKm < 10 ? place.distanceKm.toFixed(1) : Math.round(place.distanceKm)} km from ${state.area?.name || "destination"}`],
    ].filter(Boolean);
    $("stay-eat-modal-facts").innerHTML = facts.map(([label, value]) => `<div class="stay-eat-fact"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");

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

    // The destination changed: mark stale and reload right away if the section is open.
    let reloadTimer = null;
    const onDestinationChanged = () => {
      state.stale = true;
      if (!section.open) return;
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
    getChosenStay: () => (state.email ? getChosenStay() : null),
    setStay(place, areaName) {
      if (!state.email || !place?.name) return;
      setChosenStay(place, String(areaName || ""));
      refreshRowStates();
    },
  };
})();
