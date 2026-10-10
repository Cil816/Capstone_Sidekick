// Selected place storage for the Places API (New) search results.
let _selectedPlace = null;
let _itineraryMap = null;
let _itineraryMapMarkers = [];
let _itineraryMapLoadPromise = null;

function loadGoogleMapsForItinerary() {
  if (window.google?.maps) return Promise.resolve();
  if (_itineraryMapLoadPromise) return _itineraryMapLoadPromise;
  const apiKey = String(window.SIDEKICK_CONFIG?.googleMapsApiKey || "").trim();
  if (!apiKey) return Promise.reject(new Error("Google Maps JavaScript key is not configured."));
  _itineraryMapLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-sidekick-maps="1"]');
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), { once: true });
      return;
    }
    window.gm_authFailure = () => {
      const map = document.getElementById("itinerary-map");
      if (map) map.innerHTML = '<div class="itinerary-map-message">Google Maps could not authenticate this key. Check its website restrictions, billing, and Maps JavaScript API configuration.</div>';
    };
    const script = document.createElement("script");
    script.dataset.sidekickMaps = "1";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Maps failed to load. Check the browser key, billing, and Maps JavaScript API configuration."));
    document.head.appendChild(script);
  });
  return _itineraryMapLoadPromise;
}

async function initializeItineraryMap() {
  const mapEl = document.getElementById("itinerary-map");
  if (!mapEl || String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") {
    if (mapEl) mapEl.innerHTML = '<div class="itinerary-map-message">Development map preview is unavailable; mock place search and coordinates remain available.</div>';
    return;
  }
  try {
    await loadGoogleMapsForItinerary();
    if (!_itineraryMap) {
      _itineraryMap = new google.maps.Map(mapEl, {
        center: { lat: 14.5995, lng: 120.9842 },
        zoom: 6,
        mapTypeControl: false,
        streetViewControl: false,
      });
    } else {
      google.maps.event.trigger(_itineraryMap, "resize");
    }
  } catch (error) {
    mapEl.innerHTML = `<div class="itinerary-map-message">${window.SidekickCore.escapeHtml(error.message || "The map is unavailable.")}</div>`;
  }
}

function displayPlaceOnItineraryMap(place) {
  if (!_itineraryMap || !hasPlaceCoordinates(place)) return;
  const position = { lat: Number(place.lat), lng: Number(place.lng) };
  _itineraryMap.setCenter(position);
  _itineraryMap.setZoom(15);
  requestAnimationFrame(() => google.maps.event.trigger(_itineraryMap, "resize"));
}

function displayPlacesOnItineraryMap(places) {
  if (!_itineraryMap) return;
  _itineraryMapMarkers.forEach((marker) => marker.setMap(null));
  _itineraryMapMarkers = [];
  const validPlaces = places.filter(hasPlaceCoordinates);
  if (!validPlaces.length) return;
  const bounds = new google.maps.LatLngBounds();
  validPlaces.forEach((place) => {
    const position = { lat: Number(place.lat), lng: Number(place.lng) };
    const marker = new google.maps.Marker({ map: _itineraryMap, position, title: place.name || "Place result" });
    marker.addListener("click", () => {
      _selectedPlace = place;
      document.dispatchEvent(new CustomEvent("sidekick:selected-place", { detail: place }));
    });
    _itineraryMapMarkers.push(marker);
    bounds.extend(position);
  });
  if (validPlaces.length === 1) {
    _itineraryMap.setCenter(bounds.getCenter());
    _itineraryMap.setZoom(15);
  } else {
    _itineraryMap.fitBounds(bounds);
  }
}

function hasPlaceCoordinates(place) {
  const { lat, lng } = place || {};
  return lat !== null && lat !== undefined && lat !== ""
    && lng !== null && lng !== undefined && lng !== ""
    && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Number(lat) >= -90 && Number(lat) <= 90
    && Number(lng) >= -180 && Number(lng) <= 180;
}

function formatDateInput(date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function parseItineraryDate(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return new Date(Number.NaN);
    return date;
  }
  const timestamp = new Date(text);
  return Number.isFinite(timestamp.getTime())
    ? new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate())
    : new Date(Number.NaN);
}

function itineraryDates(startValue, endValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startValue || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endValue || ""))) {
    throw new Error("Select both a valid start date and a valid end date.");
  }
  const start = parseItineraryDate(startValue);
  const end = parseItineraryDate(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error("Enter valid trip dates.");
  if (end < start) throw new Error("End date must be on or after the start date.");
  const durationDays = Math.floor((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000) + 1;
  return { start, end, durationDays };
}

async function searchPlacesForBuilder(query) {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;
  if (!String(query || "").trim()) {
    mapEl.textContent = "Enter a place name to search.";
    displayPlacesOnItineraryMap([]);
    return;
  }
  mapEl.textContent = "Searching places...";
  try {
    const data = await window.SidekickCore.apiRequest("/api/maps/places", {
      method: "POST",
      body: JSON.stringify({ queries: [String(query).trim()] }),
    });
    if (String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() !== "development" && !_itineraryMap) {
      await initializeItineraryMap();
    }
    const places = Array.isArray(data.places) ? data.places.slice(0, 8) : [];
    mapEl.innerHTML = "";
    displayPlacesOnItineraryMap(places);
    if (!places.length) {
      mapEl.textContent = data.isDevelopmentMock ? "No development places matched that search." : "No places found.";
      return;
    }
    if (data.isDevelopmentMock) {
      const note = document.createElement("small");
      note.className = "place-search-source";
      note.textContent = "Development sample places (not Google results)";
      mapEl.appendChild(note);
    }
    places.forEach((place) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-place-result";
      const photoUrl = getPlacePhotoUrl(place);
      button.innerHTML = `
        <span class="map-place-result-media">
          ${photoUrl
            ? `<img src="${window.SidekickCore.escapeHtml(photoUrl)}" alt="" loading="lazy" />`
            : svgPin()}
        </span>
        <span class="map-place-result-copy">
          <strong>${window.SidekickCore.escapeHtml(place.name)}</strong>
          <span>${window.SidekickCore.escapeHtml(place.address || "Address unavailable")}</span>
        </span>
      `;
      const image = button.querySelector("img");
      if (image) image.addEventListener("error", () => image.replaceWith(createPhotoPlaceholder()));
      button.addEventListener("click", () => {
        _selectedPlace = place;
        displayPlaceOnItineraryMap(place);
        document.dispatchEvent(new CustomEvent("sidekick:selected-place", { detail: place }));
        mapEl.querySelectorAll(".map-place-result").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
      });
      mapEl.appendChild(button);
    });
  } catch (error) {
    mapEl.textContent = error.message || "Google Places is currently unavailable.";
  }
}

function getPlacePhotoUrl(place) {
  if (String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return "";
  const resource = String(place?.photoResource || "").trim();
  const baseUrl = window.SidekickCore?.getApiBaseUrl?.() || "";
  return resource && baseUrl
    ? `${baseUrl}/api/maps/photo?name=${encodeURIComponent(resource)}`
    : "";
}

function createPhotoPlaceholder() {
  const placeholder = document.createElement("span");
  placeholder.className = "activity-photo-placeholder";
  placeholder.innerHTML = svgPin();
  return placeholder;
}

function svgClock() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  `;
}

function svgPin() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
      <circle cx="12" cy="10" r="3"></circle>
    </svg>
  `;
}

function renderActivity(activity) {
  const timeText = activity?.dueAt ? new Date(Number(activity.dueAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : window.SidekickCore.escapeHtml(activity.timeLabel || '');
  const hasRouteMeta = typeof activity?.travelMinutes === 'number' || typeof activity?.estimatedTotalCostPhp === 'number';
  const mode = window.SidekickCore.escapeHtml(activity?.transportMode || 'Suggested transport');
  const distance = typeof activity?.travelDistanceKm === 'number' ? `${activity.travelDistanceKm.toFixed(1)} km` : 'distance unavailable';
  const mins = typeof activity?.travelMinutes === 'number' ? `${Math.round(activity.travelMinutes)} min` : 'time n/a';
  const cost = typeof activity?.estimatedTotalCostPhp === 'number' ? `PHP ${Number(activity.estimatedTotalCostPhp).toLocaleString()}` : 'fare unavailable';
  const photoUrl = getPlacePhotoUrl(activity);
  return `
    <div class="activity-card">
      <div class="activity-photo">
        ${photoUrl
          ? `<img src="${window.SidekickCore.escapeHtml(photoUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><span class="activity-photo-placeholder" style="display:none">${svgPin()}</span>`
          : `<span class="activity-photo-placeholder">${svgPin()}</span>`}
      </div>
      <div class="activity-time">
        ${svgClock()}
        <span>${timeText}</span>
      </div>
      <h3>${window.SidekickCore.escapeHtml(activity.title)}</h3>
      <div class="activity-location">
        ${svgPin()}
        <span>${window.SidekickCore.escapeHtml(activity.location)}</span>
      </div>
      ${hasRouteMeta || activity.routeStatus ? `<div class="activity-route-meta">${mode} • ${distance} • ${mins}${typeof activity?.estimatedTotalCostPhp === 'number' ? ` • ~${cost}` : ''}${activity.routeStatus ? ` • ${window.SidekickCore.escapeHtml(activity.routeStatus)}` : ''}</div>` : ''}
      ${activity.note ? `<div class="activity-note">${window.SidekickCore.escapeHtml(activity.note)}</div>` : ""}
    </div>
  `;
}

function lookupPlaceByActivity(activity) {
  if (!activity) return null;
  if (activity.locationCoords && typeof activity.locationCoords.lat === 'number' && typeof activity.locationCoords.lng === 'number') {
    return { lat: activity.locationCoords.lat, lng: activity.locationCoords.lng };
  }
  const name = String(activity.location || '').split(',')[0].trim().toLowerCase();
  if (!name) return null;
  const places = window.SidekickCore?.PLACES || [];
  const match = places.find((p) => String(p.name || '').toLowerCase() === name);
  if (!match || typeof match.lat !== 'number' || typeof match.lng !== 'number') return null;
  return { lat: match.lat, lng: match.lng };
}

async function enrichItineraryWithLiveRoutes(itineraryData, email) {
  if (!itineraryData?.itinerary?.length) return;
  if (String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return;
  let changed = false;

  for (const day of itineraryData.itinerary) {
    const activities = day.activities || [];
    let dayTotal = 0;

    for (let i = 0; i < activities.length; i++) {
      const current = activities[i];
      const prev = i > 0 ? activities[i - 1] : null;
      const fromCoord = lookupPlaceByActivity(prev);
      const toCoord = lookupPlaceByActivity(current);

      if (prev && fromCoord && toCoord && !(Number.isFinite(current.travelMinutes) && Number.isFinite(current.travelDistanceKm))) {
        try {
          const response = await window.SidekickCore.apiRequest("/api/maps/route", {
            method: "POST",
            body: JSON.stringify({ origin: fromCoord, destination: toCoord, travelMode: "DRIVE" }),
          });
          const route = response.route;
          current.travelDistanceKm = route.distanceMeters / 1000;
          current.travelMinutes = route.durationMinutes;
          current.transportMode = route.travelMode;
          current.routeStatus = response.isDevelopmentMock ? "Development route estimate" : "";
          changed = true;
        } catch (error) {
          current.travelDistanceKm = null;
          current.travelMinutes = null;
          current.transportMode = "Route unavailable";
          current.routeStatus = error.message || "Route information could not be retrieved.";
          changed = true;
        }
      }

      if (typeof current.estimatedTotalCostPhp === 'number') dayTotal += current.estimatedTotalCostPhp;
    }

    if (dayTotal > 0 && itineraryData.meta?.isDevelopmentMock) day.estimatedDayCostPhp = dayTotal;
  }

  if (changed) {
    setItineraryForEmail(email, itineraryData);
    renderItinerary(itineraryData.itinerary, Boolean(itineraryData.meta?.isDevelopmentMock));
  }
}

function renderItinerary(itinerary, isDevelopmentMock = false) {
  const container = document.getElementById("itinerary-content");
  if (!container) return;

  container.innerHTML = "";

  for (const day of itinerary) {
    const activitiesHtml = (day.activities || []).map(renderActivity).join("");

    const dayHtml = `
      <div class="day-section">
        <div class="day-header">
          <div class="day-number">${day.dayNumber}</div>
          <div class="day-info">
            <h2>Day ${day.dayNumber}</h2>
            <p>${window.SidekickCore.escapeHtml(day.dateLabel)}</p>
            ${typeof day.estimatedDayCostPhp === 'number' ? `<p style="font-size:12px;color:#0f766e;margin-top:4px;">${isDevelopmentMock ? 'Development sample budget' : 'Estimated daily budget'}: PHP ${Number(day.estimatedDayCostLowPhp ?? day.estimatedDayCostPhp).toLocaleString()} - PHP ${Number(day.estimatedDayCostHighPhp ?? day.estimatedDayCostPhp).toLocaleString()}</p>` : ''}
          </div>
        </div>
        <div class="activities-list">
          ${activitiesHtml}
        </div>
      </div>
    `;

    container.insertAdjacentHTML("beforeend", dayHtml);
  }

  // Animate after layout is updated.
  [...container.querySelectorAll(".day-section")].forEach((el, idx) => {
    el.style.animation = "cardIn 460ms ease both";
    el.style.animationDelay = `${idx * 40}ms`;
  });
}

function getItineraryForEmail(email) {
  const map = window.SidekickCore.getItineraryByEmail();
  return map[email] ?? null;
}

function setItineraryForEmail(email, itineraryData) {
  const map = window.SidekickCore.getItineraryByEmail();
  map[email] = itineraryData;
  window.SidekickCore.setItineraryByEmail(map);
}

function updateHeaderDate(prefs, itineraryData) {
  const dateEl = document.getElementById("itinerary-date");
  if (!dateEl) return;

  let startDate = itineraryData?.meta?.startDate
    ? parseItineraryDate(itineraryData.meta.startDate)
    : new Date();
  const dayCount = Math.max(1, Number(itineraryData?.itinerary?.length || 1));
  if (!Number.isFinite(startDate.getTime())) startDate = new Date();
  let endDate = itineraryData?.meta?.endDate
    ? parseItineraryDate(itineraryData.meta.endDate)
    : new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + dayCount - 1);
  if (!Number.isFinite(endDate.getTime()) || endDate < startDate) {
    endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + dayCount - 1);
  }
  const format = { month: "short", day: "numeric", year: "numeric" };
  const range = `${startDate.toLocaleDateString([], format)} - ${endDate.toLocaleDateString([], format)}`;
  const extra = dayCount === 1 ? "Day" : "Days";
  dateEl.textContent = `${range} • ${dayCount} ${extra}`;
}

function attachAddActivityHandler(itineraryData, prefs, email, startDate) {
  const addBtn = document.getElementById("add-activity-btn");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => {
    const dayStr = window.prompt("Add activity for which day? (1-3)", "1");
    const dayNumber = Math.max(1, Math.min(3, Number(dayStr || 1)));
    const title = String(window.prompt("Activity title", "New experience") || "").trim();
    const location = String(window.prompt("Where is it?", "Near your travel area") || "").trim();
    if (!title || !location) return;

    const dayIdx = dayNumber - 1;
    if (!itineraryData.itinerary?.[dayIdx]) return;

    // Put it into the next available slot label.
    const nextTime = ["Morning", "Afternoon", "Evening", "Night"][itineraryData.itinerary[dayIdx].activities.length % 4];

    // Ask user for specific time (optional) in HH:MM 24h format, otherwise derive from slot
    const timeInput = String(window.prompt("Time (HH:MM) optional — leave empty to use slot time:", "")).trim();
    const timeMap = { Morning: 9, Afternoon: 14, Evening: 18, Night: 21 };
    const dayDate = new Date(startDate);
    dayDate.setDate(dayDate.getDate() + dayIdx);
    let dueAt = null;
    if (timeInput && /^\d{1,2}:\d{2}$/.test(timeInput)) {
      const [hh, mm] = timeInput.split(":").map((v) => Number(v));
      dayDate.setHours(hh % 24, Math.min(59, Math.max(0, mm)), 0, 0);
      dueAt = dayDate.getTime();
    } else {
      const hour = timeMap[nextTime] ?? 12;
      dayDate.setHours(hour, 0, 0, 0);
      dueAt = dayDate.getTime();
    }

    const activityObj = {
      timeLabel: nextTime,
      title,
      location,
      note: "",
      dueAt,
      iso: new Date(dueAt).toISOString(),
    };
    // Offer to attach coordinates from selected place (if available)
    try{
      if (typeof _selectedPlace === 'object' && _selectedPlace &&
          Number.isFinite(Number(_selectedPlace.lat)) && Number.isFinite(Number(_selectedPlace.lng))) {
        const attach = confirm('Attach coordinates from the selected place to this activity?');
        if (attach) {
          activityObj.location = _selectedPlace.name || activityObj.location;
          activityObj.locationCoords = { lat: _selectedPlace.lat, lng: _selectedPlace.lng };
          activityObj.locationAddress = _selectedPlace.address || '';
          activityObj.placeId = _selectedPlace.placeId || '';
          activityObj.photoResource = _selectedPlace.photoResource || '';
        }
      }
    }catch(e){}

    itineraryData.itinerary[dayIdx].activities.push(activityObj);

    setItineraryForEmail(email, itineraryData);
    updateHeaderDate(prefs, itineraryData);
    renderItinerary(itineraryData.itinerary, Boolean(itineraryData.meta?.isDevelopmentMock));
    try {
      if (window.SidekickCore && window.SidekickCore.syncRemindersFromItinerary) {
        window.SidekickCore.syncRemindersFromItinerary(email);
        if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(email);
      }
    } catch (e) {}
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const session = window.SidekickCore.requireAuth();
  if (!session?.email) return;

  const prefs = window.SidekickCore.requirePreferences();
  if (!prefs) return;

  const email = session.email;
  const existing = getItineraryForEmail(email);
  const builderEl = document.getElementById('itinerary-builder');
  const preferredPlacesEl = document.getElementById('preferred-places');
  const startInput = document.getElementById('itinerary-start');
  const endInput = document.getElementById('itinerary-end');
  const budgetSelect = document.getElementById('itinerary-budget');
  const buildBtn = document.getElementById('build-itinerary');
  const showBuilderBtn = document.getElementById('show-builder');
  const placeSearchInput = document.getElementById("place-search");

  if (placeSearchInput) {
    placeSearchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      searchPlacesForBuilder(placeSearchInput.value);
    });
  }

  function populatePlaces() {
    try {
      const places = window.SidekickCore?.PLACES || [];
      preferredPlacesEl.innerHTML = '';
      places.forEach((p) => {
        const id = `place-${p.name.replace(/[^a-z0-9]/gi, '')}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.textContent = `${p.name} — ${p.region}`;
        btn.dataset.place = p.name;
        btn.onclick = () => btn.classList.toggle('selected');
        preferredPlacesEl.appendChild(btn);
      });
    } catch (e) {}
  }

  function showBuilder(show = true) {
    if (!builderEl) return;
    builderEl.style.display = show ? 'block' : 'none';
    if (show) {
      initializeItineraryMap().then(() => {
        if (_itineraryMap) requestAnimationFrame(() => google.maps.event.trigger(_itineraryMap, "resize"));
      });
      if (startInput?.value && endInput) {
        endInput.min = startInput.value;
        if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
      }
    }
  }

  if (startInput && endInput) {
    startInput.addEventListener('change', () => {
      endInput.min = startInput.value;
      if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
    });
  }
  if (showBuilderBtn) showBuilderBtn.addEventListener('click', () => showBuilder(true));

  const removeAllBtn = document.getElementById('remove-all-itinerary');
  if (removeAllBtn) {
    removeAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!window.confirm('Remove your entire itinerary? This cannot be undone.')) return;
      try {
        const map = window.SidekickCore.getItineraryByEmail();
        delete map[email];
        window.SidekickCore.setItineraryByEmail(map);
        const all = JSON.parse(localStorage.getItem('sidekick.remindersByEmail.v1') || '{}');
        all[email] = (all[email] || []).filter((reminder) => (
          reminder.type !== 'Itinerary' && typeof reminder.parentDueAt === 'undefined'
        ));
        localStorage.setItem('sidekick.remindersByEmail.v1', JSON.stringify(all));
        document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email } }));
      } catch (error) {
        console.error('Unable to remove itinerary', error);
      }

      const container = document.getElementById('itinerary-content');
      if (container) {
        container.innerHTML = `<div id="no-itinerary-message" style="padding:24px;color:#6B7280">You don't have an itinerary yet. Use the builder above to create one.</div><button class="add-activity-btn" id="add-activity-btn" type="button" style="display:none">+ Add Activity</button>`;
      }
      showBuilder(true);
    });
  }

  // If user already has an itinerary, show it; otherwise show the builder so user opts in.
  if (existing?.itinerary) {
    let startDate = existing?.meta?.startDate ? parseItineraryDate(existing.meta.startDate) : new Date();
    if (!Number.isFinite(startDate.getTime())) startDate = new Date();
    let endDate = existing?.meta?.endDate
      ? parseItineraryDate(existing.meta.endDate)
      : new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + Math.max(0, existing.itinerary.length - 1));
    if (!Number.isFinite(endDate.getTime()) || endDate < startDate) {
      endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + Math.max(0, existing.itinerary.length - 1));
    }
    if (!existing.meta?.endDate || !Number.isFinite(parseItineraryDate(existing.meta.endDate).getTime())) {
      existing.meta = { ...(existing.meta || {}), startDate: formatDateInput(startDate), endDate: formatDateInput(endDate) };
      setItineraryForEmail(email, existing);
    }
    if (startInput) startInput.value = formatDateInput(startDate);
    if (endInput) {
      endInput.min = formatDateInput(startDate);
      endInput.value = formatDateInput(endDate);
    }
    updateHeaderDate(prefs, existing);
    renderItinerary(existing.itinerary, Boolean(existing.meta?.isDevelopmentMock));
    enrichItineraryWithLiveRoutes(existing, email);
    // show add activity button for existing itineraries
    const addBtn = document.getElementById('add-activity-btn');
    if (addBtn) addBtn.style.display = 'block';
    attachAddActivityHandler(existing, prefs, email, startDate);
    showBuilder(false);
  } else {
    // show builder UI so user explicitly builds the itinerary
    populatePlaces();
    // prefill start date to today
    const today = new Date();
    const todayValue = formatDateInput(today);
    if (startInput) startInput.value = todayValue;
    if (endInput) {
      endInput.min = todayValue;
      const defaultEnd = new Date(today);
      defaultEnd.setDate(defaultEnd.getDate() + 2);
      endInput.value = formatDateInput(defaultEnd);
    }
    if (budgetSelect) budgetSelect.value = prefs?.budget || 'Mid-Range';
    showBuilder(true);

    if (buildBtn) {
      buildBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const selected = Array.from(preferredPlacesEl.querySelectorAll('.chip.selected')).map((b) => b.dataset.place);
        let tripDates;
        try {
          tripDates = itineraryDates(startInput?.value, endInput?.value);
        } catch (error) {
          window.alert(error.message);
          return;
        }
        const { start: startVal, end: endVal, durationDays } = tripDates;
        const budgetVal = budgetSelect?.value || prefs?.budget || 'Mid-Range';

        // merge into a temporary prefs object for itinerary generation
        const tempPrefs = Object.assign({}, prefs, { preferredPlaces: selected, budget: budgetVal });

        // Confirm with user before building
        const summary = `Build a ${durationDays}-day itinerary from ${startVal.toDateString()} through ${endVal.toDateString()}?\nBudget: ${budgetVal}\nPreferred places: ${selected.length ? selected.join(', ') : 'None'}`;
        if (!window.confirm(summary)) return;

        buildBtn.disabled = true;
        buildBtn.textContent = "Verifying places...";
        let generated;
        try {
          generated = await window.SidekickCore.apiRequest("/api/itinerary/generate", {
            method: "POST",
            body: JSON.stringify({
              email,
              message: `Plan a ${durationDays}-day trip to ${selected[0] || prefs?.preferredPlaces?.[0] || "my preferred destination"}. Budget: ${budgetVal}. Start date: ${formatDateInput(startVal)}. End date: ${formatDateInput(endVal)}.`,
              selectedDestination: { name: selected[0] || prefs?.preferredPlaces?.[0] || "" },
              profile: { ...tempPrefs, startDate: formatDateInput(startVal), endDate: formatDateInput(endVal), durationDays },
            }),
          });
        } catch (error) {
          window.alert(error.message || "Verified itinerary generation failed.");
          return;
        } finally {
          buildBtn.disabled = false;
          buildBtn.textContent = "Build Itinerary";
        }
        const itineraryData = { itinerary: generated.itinerary, meta: { ...generated.meta, startDate: formatDateInput(startVal), endDate: formatDateInput(endVal), durationDays } };

        setItineraryForEmail(email, itineraryData);
        updateHeaderDate(tempPrefs, itineraryData);
        renderItinerary(itineraryData.itinerary, Boolean(itineraryData.meta?.isDevelopmentMock));
        enrichItineraryWithLiveRoutes(itineraryData, email);
        // show add activity button and attach handler
        const addBtn = document.getElementById('add-activity-btn');
        if (addBtn) addBtn.style.display = 'block';
        attachAddActivityHandler(itineraryData, tempPrefs, email, startVal);
        // hide builder after building
        showBuilder(false);
        // sync reminders and schedule
        try { if (window.SidekickCore?.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(email); } catch (e) {}
        try { if (window.SidekickCore?.scheduleAllFor) window.SidekickCore.scheduleAllFor(email); } catch (e) {}
      });
    }
  }
  initializeItineraryMap();
});
