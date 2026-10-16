// Selected place storage for the Places API (New) search results.
let _selectedPlace = null;
// Budget-check key of a trip that Home already checked (see the Build handler).
let preCheckedBudgetKey = '';
let _destinationMarker = null;
let _itineraryMap = null;
let _itineraryMapMarkers = [];
let _itineraryMapLoadPromise = null;
let _liveTripBudget = null;
let _liveActivityCostsByPlaceId = new Map();
let _activeBudgetTargetPhp = null;
let _activeActivityBudgetTargetPhp = null;
let _activeActivityDailyBudgetTargetPhp = null;
const TRIP_BUDGET_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const _freshActivityPhotosByPlaceId = new Map();
const _activityPhotoRequestsByPlaceId = new Map();

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
    // loading=async needs a callback: it fires once the API is ready to use.
    window.__sidekickItineraryMapsReady = () => resolve();
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&callback=__sidekickItineraryMapsReady`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps failed to load. Check the browser key, billing, and Maps JavaScript API configuration."));
    document.head.appendChild(script);
  });
  return _itineraryMapLoadPromise;
}

async function initializeItineraryMap() {
  const mapEl = document.getElementById("itinerary-map");
  if (!mapEl) return;
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
  if (_destinationMarker) _destinationMarker.setMap(null);
  _destinationMarker = new google.maps.Marker({
    map: _itineraryMap,
    position,
    title: place.name || 'Selected destination',
    animation: google.maps.Animation.DROP,
  });
  requestAnimationFrame(() => google.maps.event.trigger(_itineraryMap, "resize"));
}

async function showDestinationSuggestionOnMap(suggestion) {
  const searchPanel = document.getElementById("itinerary-place-search");
  if (searchPanel) searchPanel.open = true;
  await initializeItineraryMap();

  let place = suggestion;
  if (!hasPlaceCoordinates(place) && place.placeId) {
    try {
      const data = await window.SidekickCore.apiRequest("/api/maps/place-details", {
        method: "POST",
        body: JSON.stringify({ placeId: place.placeId }),
      });
      place = data.place || place;
    } catch (error) {
      // Support a backend process that has not been restarted with place-details yet.
      try {
        const data = await window.SidekickCore.apiRequest("/api/maps/places", {
          method: "POST",
          body: JSON.stringify({ queries: [`${suggestion.name || suggestion.text} tourist attractions`] }),
        });
        const results = Array.isArray(data.places) ? data.places : [];
        place = results.find((item) => item.placeId === suggestion.placeId)
          || results.find((item) => item.name?.toLowerCase() === suggestion.name?.toLowerCase())
          || results[0]
          || place;
      } catch (_) {
        // Keep the selected destination even if its coordinates cannot be resolved.
      }
    }
  }

  if (hasPlaceCoordinates(place)) {
    _selectedPlace = place;
    displayPlaceOnItineraryMap(place);
  }
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
      // Show the spot's details in front of the user.
      window.SidekickStayEat?.openPlace?.(place);
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

function normalizeItineraryDateMetadata(itineraryData) {
  const dayCount = Array.isArray(itineraryData?.itinerary) ? itineraryData.itinerary.length : 0;
  if (!dayCount) return null;

  const meta = itineraryData.meta && typeof itineraryData.meta === 'object' ? itineraryData.meta : {};
  let start = meta.startDate ? parseItineraryDate(meta.startDate) : new Date(Number.NaN);
  if (!Number.isFinite(start.getTime())) start = new Date();
  start = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  const savedEnd = meta.endDate ? parseItineraryDate(meta.endDate) : new Date(Number.NaN);
  const savedDuration = Number.isFinite(savedEnd.getTime())
    ? Math.floor((Date.UTC(savedEnd.getFullYear(), savedEnd.getMonth(), savedEnd.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000) + 1
    : 0;
  const end = savedDuration === dayCount
    ? new Date(savedEnd.getFullYear(), savedEnd.getMonth(), savedEnd.getDate())
    : new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayCount - 1);
  const startValue = formatDateInput(start);
  const endValue = formatDateInput(end);
  const changed = meta.startDate !== startValue || meta.endDate !== endValue || Number(meta.durationDays) !== dayCount;

  itineraryData.meta = { ...meta, startDate: startValue, endDate: endValue, durationDays: dayCount };
  return { start, end, startDate: startValue, endDate: endValue, durationDays: dayCount, changed };
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
        // Show the spot's details in front of the user.
        window.SidekickStayEat?.openPlace?.(place);
      });
      mapEl.appendChild(button);
    });
  } catch (error) {
    mapEl.textContent = error.message || "Google Places is currently unavailable.";
  }
}

function getPlacePhotoUrl(place) {
  if (String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return "";
  const placeId = String(place?.placeId || "");
  const freshPhoto = _freshActivityPhotosByPlaceId.get(placeId);
  if (_freshActivityPhotosByPlaceId.has(placeId) && !freshPhoto) return "";
  const resource = String(freshPhoto?.photoResource || place?.photoResource || "").trim();
  const baseUrl = window.SidekickCore?.getApiBaseUrl?.() || "";
  return resource && baseUrl
    ? `${baseUrl}/api/maps/photo?name=${encodeURIComponent(resource)}`
    : "";
}

function getPhotoAttributionMarkup(place) {
  const freshPhoto = _freshActivityPhotosByPlaceId.get(String(place?.placeId || ""));
  if (_freshActivityPhotosByPlaceId.has(String(place?.placeId || "")) && !freshPhoto) return "";
  const attributions = freshPhoto?.photoAttributions || place?.photoAttributions
    || (freshPhoto?.photoAttribution || place?.photoAttribution ? [freshPhoto?.photoAttribution || place?.photoAttribution] : []);
  const mapsPhotoUrl = freshPhoto?.photoGoogleMapsUri || place?.photoGoogleMapsUri || "";
  const authorLinks = attributions.filter((attribution) => attribution?.name).map((attribution) => {
    const name = window.SidekickCore.escapeHtml(attribution.name);
    const uri = /^https:\/\//i.test(String(attribution.uri || "")) ? String(attribution.uri) : "";
    return uri
      ? `<a href="${window.SidekickCore.escapeHtml(uri)}" target="_blank" rel="noopener noreferrer">Photo: ${name}</a>`
      : `<span>Photo: ${name}</span>`;
  });
  const safeMapsPhotoUrl = /^https:\/\//i.test(String(mapsPhotoUrl)) ? String(mapsPhotoUrl) : "";
  if (safeMapsPhotoUrl) {
    authorLinks.push(`<a href="${window.SidekickCore.escapeHtml(safeMapsPhotoUrl)}" target="_blank" rel="noopener noreferrer">View on Google Maps</a>`);
  }
  return authorLinks.length ? `<span class="activity-photo-credit">${authorLinks.join(' · ')}</span>` : "";
}

async function getFreshActivityPhoto(placeId) {
  const key = String(placeId || "");
  if (!key || String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return null;
  if (_freshActivityPhotosByPlaceId.has(key)) return _freshActivityPhotosByPlaceId.get(key);
  if (_activityPhotoRequestsByPlaceId.has(key)) return _activityPhotoRequestsByPlaceId.get(key);

  const request = window.SidekickCore.apiRequest("/api/maps/place-details", {
    method: "POST",
    body: JSON.stringify({ placeId: key }),
  }).then((response) => {
    const place = response?.place || null;
    const photo = place?.photoResource ? {
      photoResource: place.photoResource,
      photoAttribution: place.photoAttribution || null,
      photoAttributions: place.photoAttributions || [],
      photoGoogleMapsUri: place.photoGoogleMapsUri || "",
    } : null;
    _freshActivityPhotosByPlaceId.set(key, photo);
    return photo;
  }).catch(() => {
    _freshActivityPhotosByPlaceId.set(key, null);
    return null;
  }).finally(() => {
    _activityPhotoRequestsByPlaceId.delete(key);
  });
  _activityPhotoRequestsByPlaceId.set(key, request);
  return request;
}

function replaceWithPhotoPlaceholder(container) {
  container.replaceChildren(createPhotoPlaceholder());
}

async function refreshActivityPhoto(container, activity) {
  if (!container || container.dataset.photoRefreshAttempted === "true") return;
  const placeId = String(activity?.placeId || "");
  if (!placeId || String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return;
  container.dataset.photoRefreshAttempted = "true";

  const photo = await getFreshActivityPhoto(placeId);
  if (!photo?.photoResource) {
    replaceWithPhotoPlaceholder(container);
    return;
  }

  const image = document.createElement("img");
  image.alt = `Photo of ${String(activity.title || "this place")}`;
  image.loading = "lazy";
  image.addEventListener("error", () => replaceWithPhotoPlaceholder(container), { once: true });
  image.src = getPlacePhotoUrl({ placeId });
  container.replaceChildren(image);
  const attributionMarkup = getPhotoAttributionMarkup({ placeId });
  if (attributionMarkup) {
    const attributionTemplate = document.createElement("template");
    attributionTemplate.innerHTML = attributionMarkup;
    container.appendChild(attributionTemplate.content);
  }
}

function attachActivityPhotoHandlers(container, itinerary) {
  const activitiesByPlaceId = new Map((itinerary || []).flatMap((day) => day.activities || [])
    .filter((activity) => activity?.placeId)
    .map((activity) => [String(activity.placeId), activity]));
  container.querySelectorAll(".activity-photo[data-place-id]").forEach((photoContainer) => {
    const activity = activitiesByPlaceId.get(String(photoContainer.dataset.placeId || ""));
    if (!activity) return;
    const image = photoContainer.querySelector("img");
    if (image) {
      image.addEventListener("error", () => refreshActivityPhoto(photoContainer, activity), { once: true });
    } else {
      refreshActivityPhoto(photoContainer, activity);
    }
  });
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
  const timeText = activity?.dueAt ? new Date(Number(activity.dueAt)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : window.SidekickCore.escapeHtml(activity.timeLabel || '');
  const distance = typeof activity?.travelDistanceKm === 'number' ? `${activity.travelDistanceKm.toFixed(1)} km from the last stop` : '';
  const mins = typeof activity?.travelMinutes === 'number' ? `about ${Math.round(activity.travelMinutes)} min travel` : '';
  const routeSummary = [distance, mins, activity.routeStatus ? 'Travel time unavailable' : '']
    .filter(Boolean)
    .join(' · ');
  const costEstimate = _liveActivityCostsByPlaceId.get(String(activity?.placeId || ''));
  const hasActivityCostEstimate = costEstimate
    && Number.isFinite(costEstimate.lowPhp)
    && Number.isFinite(costEstimate.highPhp);
  const activityCostText = hasActivityCostEstimate
    ? (costEstimate.lowPhp === 0 && costEstimate.highPhp === 0
      ? (/restaurant|cafe/i.test(String(activity?.category || '')) ? 'No entry fee' : 'Free entry')
      : `Entry fee: PHP ${Number(costEstimate.lowPhp).toLocaleString()}–${Number(costEstimate.highPhp).toLocaleString()}`)
    : '';
  const durationMinutes = Math.round(Number(activity.durationMinutes));
  const durationText = durationMinutes >= 60
    ? `${Math.floor(durationMinutes / 60)} hr${Math.floor(durationMinutes / 60) === 1 ? '' : 's'}${durationMinutes % 60 ? ` ${durationMinutes % 60} min` : ''}`
    : `${durationMinutes} min`;
  const photoUrl = getPlacePhotoUrl(activity);
  const photoPlaceId = window.SidekickCore.escapeHtml(String(activity?.placeId || ''));
  const photoMarkup = photoUrl
    ? `<img src="${window.SidekickCore.escapeHtml(photoUrl)}" alt="Photo of ${window.SidekickCore.escapeHtml(activity.title || 'this place')}" loading="lazy" />${getPhotoAttributionMarkup(activity)}`
    : `<span class="activity-photo-placeholder">${svgPin()}</span>`;
  return `
    <div class="activity-card">
      <div class="activity-photo"${photoPlaceId ? ` data-place-id="${photoPlaceId}"` : ''}>${photoMarkup}</div>
      <div class="activity-time">
        ${svgClock()}
        <span>${timeText ? `Start around ${timeText}` : 'Time not set'}</span>
      </div>
      <h3>${window.SidekickCore.escapeHtml(activity.title)}</h3>
      <div class="activity-location">
        ${svgPin()}
        <span>${window.SidekickCore.escapeHtml(activity.location)}</span>
      </div>
      ${routeSummary ? `<div class="activity-route-meta">${routeSummary}${typeof activity?.travelMinutes === 'number' ? ' · Traffic may change this' : ''}</div>` : ''}
      ${Number.isFinite(durationMinutes) && durationMinutes > 0 ? `<div class="activity-note">Plan about ${durationText} here.</div>` : ''}
      ${activityCostText ? `<div class="activity-cost-estimate">${window.SidekickCore.escapeHtml(activityCostText)}</div>` : ''}
      ${activity.note ? `<div class="activity-note">${window.SidekickCore.escapeHtml(activity.note)}</div>` : ''}
    </div>
  `;
}

// True while the signed-in user has a saved itinerary with at least one day.
function hasStoredItinerary() {
  try {
    const owner = window.SidekickCore?.getAuthSession?.()?.email;
    const saved = owner ? window.SidekickCore.getItineraryByEmail()[owner] : null;
    return Array.isArray(saved?.itinerary) && saved.itinerary.length > 0;
  } catch (error) {
    return false;
  }
}

// Hide the cost estimate as soon as the itinerary is removed (or expires).
document.addEventListener('sidekick:itinerary-updated', () => {
  if (hasStoredItinerary()) return;
  _liveTripBudget = null;
  _liveActivityCostsByPlaceId = new Map();
  renderTripBudget(null);
});

function renderTripBudget(budget) {
  const summary = document.getElementById('itinerary-budget-summary');
  if (!summary) return;
  if (!budget || !hasStoredItinerary()) {
    summary.hidden = true;
    summary.replaceChildren();
    return;
  }
  const hasActivityEstimate = Number.isFinite(budget.totalLowPhp) && Number.isFinite(budget.totalHighPhp);
  const total = hasActivityEstimate
    ? `PHP ${Number(budget.totalLowPhp).toLocaleString()}–${Number(budget.totalHighPhp).toLocaleString()}`
    : 'No price estimate found';
  const targetNote = Number.isFinite(_activeBudgetTargetPhp)
    ? `<p class="itinerary-budget-note">Your trip budget: PHP ${Number(_activeBudgetTargetPhp).toLocaleString()}.</p>`
    : '';
  const activityTargetNote = Number.isFinite(_activeActivityBudgetTargetPhp)
    ? `<p class="itinerary-budget-note">About PHP ${Number(_activeActivityBudgetTargetPhp).toLocaleString()} is set aside for activity entry fees${Number.isFinite(_activeActivityDailyBudgetTargetPhp) ? ` (about PHP ${Number(_activeActivityDailyBudgetTargetPhp).toLocaleString()} per day)` : ''}. The rest is for travel, rooms, food, local transport, and extra costs.</p>`
    : '';
  const activityOverTargetNote = hasActivityEstimate && Number.isFinite(_activeActivityBudgetTargetPhp)
    && budget.totalHighPhp > _activeActivityBudgetTargetPhp
    ? '<p class="itinerary-budget-note">Activity entry fees are over the planned amount. Try lower-cost places or raise your budget.</p>'
    : '';
  const sourceHtml = (budget.sources || []).map((source) => {
    const url = String(source.url || '');
    if (!/^https?:\/\//i.test(url)) return '';
    return `<a href="${window.SidekickCore.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${window.SidekickCore.escapeHtml(source.title || 'Price source')}</a>`;
  }).join('');
  const sourceCount = (budget.sources || []).filter((source) => /^https?:\/\//i.test(String(source.url || ''))).length;
  const searchedDate = budget.searchedAt ? new Date(budget.searchedAt).toLocaleDateString() : '';
  const notes = [
    `Prices found for ${Number(budget.pricedActivityCount || 0)} of ${Number(budget.totalActivityCount || 0)} activities.`,
    budget.missingActivityPriceCount ? `${budget.missingActivityPriceCount} activities have no price, so they are not in the total.` : '',
    'Prices may change.',
    searchedDate ? `Last checked ${searchedDate}.` : '',
  ].filter(Boolean).map((note) => `<p class="itinerary-budget-note">${window.SidekickCore.escapeHtml(note)}</p>`).join('');
  const suggestionHtml = typeof budget.searchSuggestionHtml === 'string' ? budget.searchSuggestionHtml : '';
  const sourcesToggle = sourceHtml
    ? `<button class="itinerary-sources-toggle" type="button" aria-expanded="false" aria-controls="itinerary-budget-sources">Show sources (${sourceCount})</button><div class="itinerary-budget-sources" id="itinerary-budget-sources" hidden>${sourceHtml}</div>`
    : '<p class="itinerary-budget-note">No source links found.</p>';
  summary.innerHTML = `<h2>Activity costs (estimate)</h2><p class="itinerary-budget-total">${window.SidekickCore.escapeHtml(total)}</p>${targetNote}${activityTargetNote}${activityOverTargetNote}${notes}${sourcesToggle}${suggestionHtml ? `<div class="itinerary-search-suggestions">${suggestionHtml}</div>` : ''}`;
  const sourceToggle = summary.querySelector('.itinerary-sources-toggle');
  const sourcePanel = summary.querySelector('.itinerary-budget-sources');
  sourceToggle?.addEventListener('click', () => {
    const expanded = sourceToggle.getAttribute('aria-expanded') === 'true';
    sourceToggle.setAttribute('aria-expanded', String(!expanded));
    sourceToggle.textContent = `${expanded ? 'Show' : 'Hide'} sources (${sourceCount})`;
    sourcePanel.hidden = expanded;
  });
  summary.hidden = false;
}

function getTripBudgetCacheKey(itineraryData) {
  const meta = itineraryData?.meta || {};
  const input = JSON.stringify({
    destination: String(meta.destination || meta.focusedPlace || ''),
    startDate: String(meta.startDate || ''),
    endDate: String(meta.endDate || ''),
    itinerary: (itineraryData?.itinerary || []).map((day) => ({
      activities: (day.activities || []).map((activity) => ({
        placeId: String(activity.placeId || ''),
        title: String(activity.title || ''),
        location: String(activity.location || ''),
        category: String(activity.category || 'activity'),
      })),
    })),
  });

  let firstHash = 0x811c9dc5;
  let secondHash = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ code, 0x01000193);
    secondHash = Math.imul(secondHash ^ code, 0x85ebca6b);
  }
  return `trip-budget-v3-${(firstHash >>> 0).toString(16)}-${(secondHash >>> 0).toString(16)}`;
}

function normalizeTripBudgetCounts(budget, itinerary, activityCosts) {
  if (!budget) return null;
  const activities = (Array.isArray(itinerary) ? itinerary : []).flatMap((day) => day?.activities || []);
  const costByPlaceId = new Map((Array.isArray(activityCosts) ? activityCosts : [])
    .map((cost) => [String(cost?.placeId || ''), cost]));
  const pricedActivityCount = activities.filter((activity) => {
    const cost = costByPlaceId.get(String(activity?.placeId || ''));
    return cost && Number.isFinite(cost.lowPhp) && Number.isFinite(cost.highPhp);
  }).length;
  const totalActivityCount = activities.length;
  return {
    ...budget,
    pricedActivityCount: Number.isFinite(budget.pricedActivityCount) ? budget.pricedActivityCount : pricedActivityCount,
    totalActivityCount: Number.isFinite(budget.totalActivityCount) ? budget.totalActivityCount : totalActivityCount,
    missingActivityPriceCount: Number.isFinite(budget.missingActivityPriceCount)
      ? budget.missingActivityPriceCount
      : Math.max(0, totalActivityCount - pricedActivityCount),
  };
}

async function loadLiveTripBudget(itineraryData, email) {
  _liveTripBudget = null;
  _liveActivityCostsByPlaceId = new Map();
  renderTripBudget(null);
  const normalizedDates = normalizeItineraryDateMetadata(itineraryData);
  if (normalizedDates?.changed) setItineraryForEmail(email, itineraryData);
  const meta = itineraryData?.meta || {};
  const cacheKey = getTripBudgetCacheKey(itineraryData);
  const cachedAt = Number(meta.liveTripBudgetCachedAt);
  const cachedBudgetIsFresh = Boolean(meta.liveTripBudget)
    && meta.liveTripBudgetCacheKey === cacheKey
    && Number.isFinite(cachedAt)
    && Date.now() - cachedAt >= 0
    && Date.now() - cachedAt < TRIP_BUDGET_CACHE_MAX_AGE_MS;
  _activeBudgetTargetPhp = Number.isFinite(Number(meta.budgetAmountPhp)) && Number(meta.budgetAmountPhp) > 0 ? Number(meta.budgetAmountPhp) : null;
  _activeActivityBudgetTargetPhp = Number.isFinite(Number(meta.activityBudgetTargetPhp)) && Number(meta.activityBudgetTargetPhp) > 0
    ? Number(meta.activityBudgetTargetPhp)
    : (_activeBudgetTargetPhp ? Math.floor(_activeBudgetTargetPhp * 0.25) : null);
  _activeActivityDailyBudgetTargetPhp = Number.isFinite(Number(meta.dailyActivityBudgetTargetPhp)) && Number(meta.dailyActivityBudgetTargetPhp) > 0
    ? Number(meta.dailyActivityBudgetTargetPhp)
    : (_activeActivityBudgetTargetPhp && itineraryData.itinerary?.length
      ? Math.floor(_activeActivityBudgetTargetPhp / itineraryData.itinerary.length)
      : null);
  if (!itineraryData?.itinerary?.length || meta.isDevelopmentMock) return;
  if (cachedBudgetIsFresh) {
    _liveActivityCostsByPlaceId = new Map((Array.isArray(meta.liveActivityCosts) ? meta.liveActivityCosts : []).map((cost) => [String(cost.placeId), cost]));
    _liveTripBudget = normalizeTripBudgetCounts(meta.liveTripBudget, itineraryData.itinerary, meta.liveActivityCosts);
    renderTripBudget(_liveTripBudget);
    renderItinerary(itineraryData.itinerary, false);
    return;
  }
  const summary = document.getElementById('itinerary-budget-summary');
  const knownCosts = new Map((Array.isArray(meta.liveActivityCosts) ? meta.liveActivityCosts : [])
    .filter((cost) => cost && cost.placeId)
    .map((cost) => [String(cost.placeId), cost]));
  const canReusePrices = knownCosts.size > 0 && Boolean(meta.liveTripBudget);
  const unpricedPlaceIds = new Set((itineraryData.itinerary || []).flatMap((day) => day?.activities || [])
    .map((activity) => String(activity?.placeId || ''))
    .filter((placeId) => placeId && !knownCosts.has(placeId)));
  if (summary && (!canReusePrices || unpricedPlaceIds.size)) {
    summary.hidden = false;
    summary.innerHTML = '<h2>Estimated activity costs</h2><p class="itinerary-budget-note">Searching current activity prices and sources…</p>';
  }
  try {
    let activityCosts;
    let tripBudget;
    if (canReusePrices) {
      // Prices already researched for this trip are kept; only new places are searched.
      let response = null;
      if (unpricedPlaceIds.size) {
        response = await window.SidekickCore.apiRequest('/api/itinerary/estimate-budget', {
          method: 'POST',
          body: JSON.stringify({
            email,
            itinerary: itineraryData.itinerary.map((day) => ({
              ...day,
              activities: (day.activities || []).filter((activity) => unpricedPlaceIds.has(String(activity?.placeId || ''))),
            })),
            destination: meta.destination || meta.focusedPlace || '',
            startDate: normalizedDates?.startDate || meta.startDate,
            endDate: normalizedDates?.endDate || meta.endDate,
          }),
        });
        (Array.isArray(response.activityCosts) ? response.activityCosts : []).forEach((cost) => {
          if (cost?.placeId) knownCosts.set(String(cost.placeId), cost);
        });
      }
      const usedPlaceIds = new Set((itineraryData.itinerary || []).flatMap((day) => day?.activities || [])
        .map((activity) => String(activity?.placeId || '')).filter(Boolean));
      activityCosts = Array.from(knownCosts.values()).filter((cost) => usedPlaceIds.has(String(cost.placeId)));
      const sources = Array.from(new Map([...(meta.liveTripBudget.sources || []), ...(response?.tripBudget?.sources || [])]
        .filter((source) => source?.url).map((source) => [source.url, source])).values()).slice(0, 12);
      tripBudget = buildLocalTripBudget(itineraryData, activityCosts, {
        startDate: normalizedDates?.startDate || meta.startDate,
        endDate: normalizedDates?.endDate || meta.endDate,
        searchedAt: response?.tripBudget?.searchedAt || meta.liveTripBudget.searchedAt,
        searchSuggestionHtml: response?.tripBudget?.searchSuggestionHtml || meta.liveTripBudget.searchSuggestionHtml || '',
        sources,
      });
    } else {
      const response = await window.SidekickCore.apiRequest('/api/itinerary/estimate-budget', {
        method: 'POST',
        body: JSON.stringify({
          email,
          itinerary: itineraryData.itinerary,
          destination: meta.destination || meta.focusedPlace || '',
          startDate: normalizedDates?.startDate || meta.startDate,
          endDate: normalizedDates?.endDate || meta.endDate,
        }),
      });
      activityCosts = Array.isArray(response.activityCosts) ? response.activityCosts : [];
      tripBudget = response.tripBudget || null;
    }
    // The itinerary may have been removed while prices were being searched.
    if (!hasStoredItinerary()) {
      renderTripBudget(null);
      return;
    }
    _liveActivityCostsByPlaceId = new Map(activityCosts.map((cost) => [String(cost.placeId), cost]));
    _liveTripBudget = normalizeTripBudgetCounts(tripBudget, itineraryData.itinerary, activityCosts);
    if (_liveTripBudget) {
      itineraryData.meta = {
        ...(itineraryData.meta || {}),
        liveTripBudget: _liveTripBudget,
        liveActivityCosts: activityCosts,
        liveTripBudgetCacheKey: cacheKey,
        liveTripBudgetCachedAt: Date.now(),
      };
      try {
        setItineraryForEmail(email, itineraryData);
      } catch (storageError) {
        console.warn('Unable to save the trip price estimate locally:', storageError);
      }
    }
    renderTripBudget(_liveTripBudget);
    renderItinerary(itineraryData.itinerary, Boolean(meta.isDevelopmentMock));
  } catch (error) {
    if (summary && hasStoredItinerary()) {
      summary.hidden = false;
      summary.innerHTML = `<h2>Estimated activity costs</h2><p class="itinerary-budget-note">Live price search is unavailable right now: ${window.SidekickCore.escapeHtml(error.message || 'Please try again later.')}</p>`;
    }
  }
}

// Builds the trip cost summary from per-place prices without another web search.
function buildLocalTripBudget(itineraryData, activityCosts, { startDate, endDate, searchedAt, searchSuggestionHtml, sources }) {
  const costByPlaceId = new Map((activityCosts || []).map((cost) => [String(cost.placeId), cost]));
  const activities = (itineraryData?.itinerary || []).flatMap((day) => day?.activities || []);
  const priced = activities
    .map((activity) => costByPlaceId.get(String(activity?.placeId || '')))
    .filter((cost) => cost && Number.isFinite(cost.lowPhp) && Number.isFinite(cost.highPhp));
  return {
    status: priced.length && priced.length === activities.length ? 'complete-estimate' : 'partial-estimate',
    currency: 'PHP',
    startDate,
    endDate,
    searchedAt,
    searchSuggestionHtml,
    totalLowPhp: priced.length ? priced.reduce((sum, cost) => sum + cost.lowPhp, 0) : null,
    totalHighPhp: priced.length ? priced.reduce((sum, cost) => sum + cost.highPhp, 0) : null,
    pricedActivityCount: priced.length,
    totalActivityCount: activities.length,
    missingActivityPriceCount: Math.max(0, activities.length - priced.length),
    sources: sources || [],
  };
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

  renderTripBudget(_liveTripBudget);
  container.innerHTML = "";

  for (const day of itinerary) {
    const activitiesHtml = (day.activities || []).map(renderActivity).join("");
    const dayActivities = day.activities || [];
    const dayCostBands = isDevelopmentMock
      ? null
      : dayActivities
        .map((activity) => _liveActivityCostsByPlaceId.get(String(activity?.placeId || '')))
        .filter((cost) => cost && Number.isFinite(cost.lowPhp) && Number.isFinite(cost.highPhp));
    const dayCostLow = isDevelopmentMock
      ? Number(day.estimatedDayCostLowPhp ?? day.estimatedDayCostPhp)
      : (dayCostBands || []).reduce((sum, cost) => sum + cost.lowPhp, 0);
    const dayCostHigh = isDevelopmentMock
      ? Number(day.estimatedDayCostHighPhp ?? day.estimatedDayCostPhp)
      : (dayCostBands || []).reduce((sum, cost) => sum + cost.highPhp, 0);
    const dayPricedActivityCount = isDevelopmentMock
      ? (Number.isFinite(dayCostLow) && Number.isFinite(dayCostHigh) ? dayActivities.length : 0)
      : (dayCostBands || []).length;
    const hasDayCostEstimate = dayActivities.length > 0 && (isDevelopmentMock
      ? (typeof day.estimatedDayCostPhp === 'number'
        || typeof day.estimatedDayCostLowPhp === 'number'
        || typeof day.estimatedDayCostHighPhp === 'number')
        && Number.isFinite(dayCostLow) && Number.isFinite(dayCostHigh)
      : true);
    const dayCostText = hasDayCostEstimate
      ? (dayPricedActivityCount
        ? `Entry fees: PHP ${dayCostLow.toLocaleString()}–${dayCostHigh.toLocaleString()} (${dayPricedActivityCount}/${dayActivities.length} prices found)${Number.isFinite(_activeActivityDailyBudgetTargetPhp) ? ` · daily target ~PHP ${_activeActivityDailyBudgetTargetPhp.toLocaleString()}` : ''}`
        : `No activity prices found${Number.isFinite(_activeActivityDailyBudgetTargetPhp) ? ` · daily target ~PHP ${_activeActivityDailyBudgetTargetPhp.toLocaleString()}` : ''}`)
      : '';

    const dayHtml = `
      <div class="day-section">
        <div class="day-header">
          <div class="day-number">${window.SidekickCore.escapeHtml(day.dayNumber)}</div>
          <div class="day-info">
            <h2>Day ${window.SidekickCore.escapeHtml(day.dayNumber)}</h2>
            <p>${window.SidekickCore.escapeHtml(day.dateLabel)}</p>
            ${dayCostText ? `<p class="day-cost-estimate">${window.SidekickCore.escapeHtml(dayCostText)}</p>` : ''}
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
  attachActivityPhotoHandlers(container, itinerary);
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

async function syncExistingItineraryForMonitoring(email, itineraryData) {
  if (!itineraryData?.itinerary?.length || itineraryData.meta?.serverTripId) return;
  const status = document.getElementById('itinerary-monitoring-status');
  if (status) {
    status.hidden = false;
    status.textContent = 'Recording this itinerary for account monitoring…';
  }
  try {
    await window.SidekickCore.ensureItineraryMonitored(email, itineraryData);
    if (status) status.textContent = 'This itinerary is recorded for admin monitoring.';
  } catch (error) {
    if (error.statusCode === 410) {
      window.SidekickCore.clearExpiredItineraryForEmail(email, null, itineraryData);
      return;
    }
    if (status) status.textContent = `This itinerary could not be synced for admin monitoring: ${error.message || 'Please try again later.'}`;
  }
}

function updateHeaderDate(prefs, itineraryData) {
  const dateEl = document.getElementById("itinerary-date");
  if (!dateEl) return;

  const normalizedDates = normalizeItineraryDateMetadata(itineraryData);
  const startDate = normalizedDates?.start || new Date();
  const endDate = normalizedDates?.end || startDate;
  const dayCount = normalizedDates?.durationDays || 1;
  const format = { month: "short", day: "numeric", year: "numeric" };
  const range = `${startDate.toLocaleDateString([], format)} - ${endDate.toLocaleDateString([], format)}`;
  const extra = dayCount === 1 ? "Day" : "Days";
  dateEl.textContent = `${range} • ${dayCount} ${extra}`;
}

function updateBuilderDatePreview(startValue, endValue) {
  const dateEl = document.getElementById('itinerary-date');
  if (!dateEl) return;
  try {
    const { start, end, durationDays } = itineraryDates(startValue, endValue);
    updateHeaderDate(null, {
      itinerary: Array.from({ length: durationDays }),
      meta: { startDate: formatDateInput(start), endDate: formatDateInput(end) },
    });
  } catch (error) {
    dateEl.textContent = 'Choose your trip dates';
  }
}

function attachAddActivityHandler(itineraryData, prefs, email, startDate) {
  const addBtn = document.getElementById("add-activity-btn");
  if (!addBtn) return;

  addBtn.onclick = async () => {
    const dayCount = Math.max(1, itineraryData.itinerary?.length || 1);
    const picked = (typeof _selectedPlace === 'object' && _selectedPlace
      && Number.isFinite(Number(_selectedPlace.lat)) && Number.isFinite(Number(_selectedPlace.lng))) ? _selectedPlace : null;
    // One themed form instead of four separate phone pop-ups.
    const values = await window.SidekickUI.form({
      title: "Add an activity",
      confirmText: "Add activity",
      fields: [
        { name: "day", label: "Day", type: "select", value: "1", options: Array.from({ length: dayCount }, (_, i) => [String(i + 1), `Day ${i + 1}`]) },
        { name: "title", label: "What will you do?", placeholder: "e.g. Sunset at the view deck", maxLength: 120 },
        { name: "location", label: "Where is it?", placeholder: "e.g. Kibungan View Deck", value: picked?.name || "", maxLength: 160 },
        { name: "time", label: "Time (optional)", type: "time", hint: "Leave empty to use the next open time slot." },
        ...(picked ? [{ name: "attach", label: `Pin it to "${picked.name || "the selected place"}" on the map?`, type: "select", value: "yes", options: [["yes", "Yes, use that place"], ["no", "No"]] }] : []),
      ],
      validate: (v) => {
        if (!v.title) return "Enter what you will do.";
        if (!v.location) return "Enter where it is.";
        if (v.time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v.time)) return "Choose a valid time.";
        return "";
      },
    });
    if (!values) return;
    const dayNumber = Number(values.day);
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > dayCount) return;
    const title = values.title;
    const location = values.location;

    const dayIdx = dayNumber - 1;
    if (!itineraryData.itinerary?.[dayIdx]) return;

    // Put it into the next available slot label.
    const nextTime = ["Morning", "Afternoon", "Evening", "Night"][itineraryData.itinerary[dayIdx].activities.length % 4];

    // Specific time (optional, HH:MM 24h from the time picker), otherwise derive from slot
    const timeInput = String(values.time || "").trim();
    const timeMap = { Morning: 9, Afternoon: 14, Evening: 18, Night: 21 };
    const dayDate = new Date(startDate);
    dayDate.setDate(dayDate.getDate() + dayIdx);
    let dueAt = null;
    if (timeInput && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(timeInput)) return;
    if (timeInput) {
      const [hh, mm] = timeInput.split(":").map((v) => Number(v));
      dayDate.setHours(hh, mm, 0, 0);
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
    // Attach the place picked on the map, when the user chose to.
    try{
      if (picked && values.attach === 'yes') {
        activityObj.location = picked.name || activityObj.location;
        activityObj.locationCoords = { lat: picked.lat, lng: picked.lng };
        activityObj.locationAddress = picked.address || '';
        activityObj.placeId = picked.placeId || '';
        activityObj.photoResource = picked.photoResource || '';
      }
    }catch(e){}

    itineraryData.itinerary[dayIdx].activities.push(activityObj);

    setItineraryForEmail(email, itineraryData);
    updateHeaderDate(prefs, itineraryData);
    renderItinerary(itineraryData.itinerary, Boolean(itineraryData.meta?.isDevelopmentMock));
    loadLiveTripBudget(itineraryData, email);
    try {
      if (window.SidekickCore && window.SidekickCore.syncRemindersFromItinerary) {
        window.SidekickCore.syncRemindersFromItinerary(email);
        if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(email);
      }
    } catch (e) {}
  };
}

document.addEventListener("DOMContentLoaded", () => {
  const session = window.SidekickCore.requireAuth();
  if (!session?.email) return;

  const prefs = window.SidekickCore.requirePreferences();
  if (!prefs) return;

  const email = session.email;
  const existing = getItineraryForEmail(email);
  const builderEl = document.getElementById('itinerary-builder');
  const destinationInput = document.getElementById('itinerary-destination');
  const destinationSuggestions = document.getElementById('itinerary-destination-suggestions');
  const destinationAttribution = document.querySelector('.destination-suggestions-attribution');
  const startInput = document.getElementById('itinerary-start');
  const endInput = document.getElementById('itinerary-end');
  const budgetInput = document.getElementById('itinerary-budget');
  const originInput = document.getElementById('itinerary-origin');
  const buildBtn = document.getElementById('build-itinerary');
  const monitoringStatus = document.getElementById('itinerary-monitoring-status');
  document.addEventListener('sidekick:itinerary-sync-error', (event) => {
    const tripId = Number(getItineraryForEmail(email)?.meta?.serverTripId);
    if (!monitoringStatus || Number(event.detail?.tripId) !== tripId) return;
    monitoringStatus.hidden = false;
    monitoringStatus.textContent = `Your itinerary is saved on this device, but the admin monitoring record could not be updated: ${event.detail.message}`;
  });
  const showBuilderBtn = document.getElementById('show-builder');
  const placeSearchInput = document.getElementById("place-search");

  let destinationSearchTimer = null;
  let destinationSearchRequestId = 0;
  let activeDestinationSuggestion = -1;
  const closeDestinationSuggestions = () => {
    if (destinationSuggestions) destinationSuggestions.hidden = true;
    if (destinationAttribution) destinationAttribution.hidden = true;
    if (destinationInput) {
      destinationInput.setAttribute('aria-expanded', 'false');
      destinationInput.removeAttribute('aria-activedescendant');
    }
    activeDestinationSuggestion = -1;
  };
  const chooseDestinationSuggestion = async (suggestion) => {
    if (!destinationInput) return;
    destinationInput.value = suggestion.text || suggestion.name || '';
    destinationInput.dataset.placeId = suggestion.placeId || '';
    destinationInput.dataset.placeTypes = JSON.stringify(suggestion.types || []);
    destinationSuggestions?.replaceChildren();
    closeDestinationSuggestions();
    await showDestinationSuggestionOnMap(suggestion);
    document.dispatchEvent(new CustomEvent('sidekick:destination-chosen', { detail: suggestion }));
  };
  const renderDestinationSuggestions = (suggestions, isDevelopmentMock = false, emptyMessage = 'No tourist places found') => {
    if (!destinationSuggestions) return;
    activeDestinationSuggestion = -1;
    destinationSuggestions.replaceChildren();
    const touristTypeOrder = ['tourist_attraction', 'landmark', 'national_park', 'museum', 'park'];
    const rankedSuggestions = suggestions.slice().sort((a, b) => {
      const aRank = touristTypeOrder.findIndex((type) => (a.types || []).includes(type));
      const bRank = touristTypeOrder.findIndex((type) => (b.types || []).includes(type));
      return (aRank < 0 ? touristTypeOrder.length : aRank) - (bRank < 0 ? touristTypeOrder.length : bRank);
    });
    if (!rankedSuggestions.length) {
      const empty = document.createElement('div');
      empty.className = 'destination-suggestion-status';
      empty.textContent = emptyMessage;
      destinationSuggestions.appendChild(empty);
    } else {
      const typeLabels = [
        ['tourist_attraction', 'Tourist spot'], ['landmark', 'Landmark'],
        ['national_park', 'National park'], ['museum', 'Museum'], ['park', 'Park'],
      ];
      rankedSuggestions.slice(0, 6).forEach((suggestion, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'destination-suggestion';
        button.id = `destination-suggestion-${index}`;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        const copy = document.createElement('span');
        copy.className = 'destination-suggestion-copy';
        const name = document.createElement('strong');
        name.textContent = suggestion.name || suggestion.text || '';
        copy.appendChild(name);
        if (suggestion.secondaryText) {
          const location = document.createElement('small');
          location.textContent = suggestion.secondaryText;
          copy.appendChild(location);
        }
        const types = Array.isArray(suggestion.types) ? suggestion.types : [];
        const label = typeLabels.find(([type]) => types.includes(type))?.[1] || 'Tourist place';
        const tag = document.createElement('span');
        tag.className = 'destination-suggestion-tag';
        tag.textContent = isDevelopmentMock ? 'Sample' : label;
        button.append(copy, tag);
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => { void chooseDestinationSuggestion(suggestion); });
        destinationSuggestions.appendChild(button);
      });
    }
    destinationSuggestions.hidden = false;
    if (destinationAttribution) destinationAttribution.hidden = !suggestions.length || isDevelopmentMock;
    if (destinationInput) destinationInput.setAttribute('aria-expanded', 'true');
  };

  if (destinationInput) {
    destinationInput.addEventListener('input', () => {
      delete destinationInput.dataset.placeId;
      delete destinationInput.dataset.placeTypes;
      destinationInput.removeAttribute('aria-activedescendant');
      activeDestinationSuggestion = -1;
      const query = destinationInput.value.trim();
      const requestId = ++destinationSearchRequestId;
      clearTimeout(destinationSearchTimer);
      if (query.length < 2) {
        closeDestinationSuggestions();
        return;
      }
      destinationSearchTimer = setTimeout(async () => {
        if (destinationSuggestions) {
          destinationSuggestions.replaceChildren();
          const loading = document.createElement('div');
          loading.className = 'destination-suggestion-status';
          loading.textContent = 'Searching…';
          destinationSuggestions.appendChild(loading);
          destinationSuggestions.hidden = false;
          destinationInput.setAttribute('aria-expanded', 'true');
        }
        try {
          let response;
          try {
            response = await window.SidekickCore.apiRequest('/api/maps/place-suggestions', {
              method: 'POST',
              body: JSON.stringify({ input: query }),
            });
          } catch (suggestionError) {
            // Older backend processes may not have the autocomplete route yet.
            const legacy = await window.SidekickCore.apiRequest('/api/maps/places', {
              method: 'POST',
              body: JSON.stringify({ queries: [`${query} tourist attractions`] }),
            });
            response = {
              isDevelopmentMock: Boolean(legacy.isDevelopmentMock),
              suggestions: (legacy.places || []).map((place) => ({
                placeId: place.placeId,
                text: [place.name, place.address].filter(Boolean).join(', '),
                name: place.name,
                secondaryText: place.address || '',
                types: place.types || [],
                lat: place.lat,
                lng: place.lng,
              })),
            };
          }
          if (requestId !== destinationSearchRequestId || destinationInput.value.trim() !== query) return;
          renderDestinationSuggestions(response.suggestions || [], Boolean(response.isDevelopmentMock));
        } catch (error) {
          if (requestId !== destinationSearchRequestId) return;
          renderDestinationSuggestions([], false, 'Suggestions are unavailable right now');
        }
      }, 280);
    });
    destinationInput.addEventListener('keydown', (event) => {
      if (destinationSuggestions?.hidden) return;
      const options = Array.from(destinationSuggestions.querySelectorAll('.destination-suggestion'));
      if (event.key === 'ArrowDown' && options.length) {
        event.preventDefault();
        activeDestinationSuggestion = (activeDestinationSuggestion + 1) % options.length;
      } else if (event.key === 'ArrowUp' && options.length) {
        event.preventDefault();
        activeDestinationSuggestion = (activeDestinationSuggestion - 1 + options.length) % options.length;
      } else if (event.key === 'Enter' && options.length) {
        event.preventDefault();
        options[Math.max(0, activeDestinationSuggestion)].click();
        return;
      } else if (event.key === 'Escape') {
        closeDestinationSuggestions();
        return;
      } else {
        return;
      }
      options.forEach((option, index) => {
        const active = index === activeDestinationSuggestion;
        option.classList.toggle('active', active);
        option.setAttribute('aria-selected', String(active));
      });
      destinationInput.setAttribute('aria-activedescendant', options[activeDestinationSuggestion]?.id || '');
    });
    destinationInput.addEventListener('blur', () => setTimeout(closeDestinationSuggestions, 120));
    destinationInput.addEventListener('focus', () => {
      if (destinationSuggestions?.childElementCount && destinationInput.value.trim().length >= 2) {
        destinationSuggestions.hidden = false;
        if (destinationAttribution) destinationAttribution.hidden = false;
        destinationInput.setAttribute('aria-expanded', 'true');
      }
    });
  }

  if (placeSearchInput) {
    placeSearchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const searchPanel = document.getElementById('itinerary-place-search');
      if (searchPanel) searchPanel.open = true;
      searchPlacesForBuilder(placeSearchInput.value);
    });
  }

  const searchPanel = document.getElementById('itinerary-place-search');
  if (searchPanel) searchPanel.addEventListener('toggle', () => {
    if (!searchPanel.open) return;
    initializeItineraryMap().then(() => {
      if (_itineraryMap) requestAnimationFrame(() => google.maps.event.trigger(_itineraryMap, 'resize'));
    });
  });

  function showBuilder(show = true) {
    if (!builderEl) return;
    builderEl.style.display = show ? 'block' : 'none';
    // Keep the Customize button in step: it looks pressed while the builder is open.
    if (showBuilderBtn) {
      showBuilderBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
      showBuilderBtn.setAttribute('aria-controls', 'itinerary-builder');
      showBuilderBtn.classList.toggle('is-open', show);
    }
    if (show) {
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
      updateBuilderDatePreview(startInput.value, endInput.value);
    });
    endInput.addEventListener('change', () => updateBuilderDatePreview(startInput.value, endInput.value));
  }
  // Customize opens the builder; tapping it again hides it.
  if (showBuilderBtn) showBuilderBtn.addEventListener('click', () => showBuilder(builderEl?.style.display === 'none'));
  const removeAllBtn = document.getElementById('remove-all-itinerary');
  if (removeAllBtn) {
    removeAllBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await window.SidekickUI.confirm('Every day and activity in this itinerary, and its reminders, will be removed. This cannot be undone.', { title: 'Remove your itinerary?', confirmText: 'Remove', tone: 'danger' });
      if (!ok) return;
      removeAllBtn.disabled = true;
      try {
        await window.SidekickCore.clearItineraryForEmail(email);
        const all = JSON.parse(localStorage.getItem('sidekick.remindersByEmail.v1') || '{}');
        all[email] = (all[email] || []).filter((reminder) => (
          reminder.type !== 'Itinerary' && typeof reminder.parentDueAt === 'undefined'
        ));
        localStorage.setItem('sidekick.remindersByEmail.v1', JSON.stringify(all));
        document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email } }));
      } catch (error) {
        window.SidekickUI.alert(error.message || 'Unable to remove the itinerary. Please try again.', { title: 'Not removed' });
        removeAllBtn.disabled = false;
        return;
      }

      const container = document.getElementById('itinerary-content');
      if (container) {
        container.innerHTML = `<div id="no-itinerary-message" style="padding:24px;color:#6B7280">You don't have an itinerary yet. Use the builder above to create one.</div><button class="add-activity-btn" id="add-activity-btn" type="button" style="display:none">+ Add Activity</button>`;
      }
      if (monitoringStatus) monitoringStatus.hidden = true;
      window.SidekickItineraryEdit?.setCurrent(null);
      removeAllBtn.disabled = false;
      showBuilder(true);
    });
  }

  // If user already has an itinerary, show it; otherwise show the builder so user opts in.
  if (existing?.itinerary) {
    const normalizedDates = normalizeItineraryDateMetadata(existing);
    const startDate = normalizedDates?.start || new Date();
    const endDate = normalizedDates?.end || startDate;
    if (normalizedDates?.changed) setItineraryForEmail(email, existing);
    if (startInput) startInput.value = formatDateInput(startDate);
    if (destinationInput) destinationInput.value = existing.meta?.destination || existing.meta?.focusedPlace || '';
    if (endInput) {
      endInput.min = formatDateInput(startDate);
      endInput.value = formatDateInput(endDate);
    }
    updateHeaderDate(prefs, existing);
    renderItinerary(existing.itinerary, Boolean(existing.meta?.isDevelopmentMock));
    void syncExistingItineraryForMonitoring(email, existing);
    loadLiveTripBudget(existing, email);
    enrichItineraryWithLiveRoutes(existing, email);
    // show add activity button for existing itineraries
    const addBtn = document.getElementById('add-activity-btn');
    if (addBtn) addBtn.style.display = 'block';
    attachAddActivityHandler(existing, prefs, email, startDate);
    window.SidekickItineraryEdit?.setCurrent(existing);
    showBuilder(false);
  } else {
    // show builder UI so user explicitly builds the itinerary
    // prefill start date to today
    const today = new Date();
    const todayValue = formatDateInput(today);
    if (destinationInput) destinationInput.value = '';
    if (startInput) startInput.value = todayValue;
    if (endInput) {
      endInput.min = todayValue;
      const defaultEnd = new Date(today);
      defaultEnd.setDate(defaultEnd.getDate() + 2);
      endInput.value = formatDateInput(defaultEnd);
    }
    updateBuilderDatePreview(startInput?.value, endInput?.value);
    showBuilder(true);
  }

  if (buildBtn) buildBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    // A second tap while the confirmation is open must not start a second build.
    if (document.querySelector('.sk-dialog')) return;
    const destinationName = String(destinationInput?.value || '').trim();
    if (!destinationName) {
      await window.SidekickUI.alert('Enter a destination before building your itinerary.', { title: 'Where to?' });
      destinationInput?.focus();
      return;
    }
    let tripDates;
    try {
      tripDates = itineraryDates(startInput?.value, endInput?.value);
    } catch (error) {
      window.SidekickUI.alert(error.message, { title: 'Check your dates' });
      return;
    }
    const rawBudget = Number(budgetInput?.value);
    if (!Number.isFinite(rawBudget) || rawBudget <= 0 || !Number.isSafeInteger(rawBudget)) {
      await window.SidekickUI.alert('Enter a whole-number trip budget in Philippine pesos.', { title: 'Add your budget' });
      budgetInput?.focus();
      return;
    }
    const { start: startVal, end: endVal, durationDays } = tripDates;
    if (durationDays > 14) {
      window.SidekickUI.alert('Itinerary plans can cover up to 14 days. Choose a shorter date range.', { title: 'Trip too long' });
      return;
    }
    const originText = String(originInput?.value || '').trim().slice(0, 180);
    const budgetLabel = `PHP ${rawBudget.toLocaleString()} total`;
    const tempPrefs = { ...prefs, preferredPlaces: [destinationName], budget: budgetLabel, budgetAmountPhp: rawBudget, transportation: 'DRIVE' };
    const shortDate = (date) => date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const confirmed = await window.SidekickUI.confirm('', {
      title: `Build your ${durationDays}-day trip?`,
      confirmText: 'Build itinerary',
      cancelText: 'Not yet',
      details: [
        ['Destination', destinationName],
        ['Dates', durationDays === 1 ? shortDate(startVal) : `${shortDate(startVal)} – ${shortDate(endVal)}`],
        ['Budget', `₱${rawBudget.toLocaleString()} total`],
        ...(originText ? [['Starting from', originText]] : []),
      ],
    });
    if (!confirmed) return;

    // Check the budget against the cheapest restaurants and hotels found before
    // generating anything. Skipped when Home already checked this exact trip.
    const budgetKey = window.SidekickCore.tripBudgetKey({
      destination: destinationName, startDate: formatDateInput(startVal), endDate: formatDateInput(endVal), budgetAmountPhp: rawBudget,
    });
    if (budgetKey !== preCheckedBudgetKey) {
      const pickedId = destinationInput?.dataset.placeId || '';
      const knownPlace = pickedId && _selectedPlace?.placeId === pickedId && hasPlaceCoordinates(_selectedPlace) ? _selectedPlace : null;
      buildBtn.disabled = true;
      buildBtn.textContent = 'Checking your budget…';
      let budgetCheck = null;
      try {
        budgetCheck = await window.SidekickCore.checkTripBudget({
          destination: destinationName,
          lat: knownPlace ? Number(knownPlace.lat) : null,
          lng: knownPlace ? Number(knownPlace.lng) : null,
          startDate: formatDateInput(startVal),
          endDate: formatDateInput(endVal),
          budgetAmountPhp: rawBudget,
        });
      } finally {
        buildBtn.disabled = false;
        buildBtn.textContent = 'Build Itinerary';
      }
      if (budgetCheck?.checked && !budgetCheck.realistic) {
        const problem = window.SidekickCore.describeUnrealisticBudget(budgetCheck, destinationName);
        showBuilder(true);
        await window.SidekickUI.alert(problem.message, { title: problem.title, details: problem.details, confirmText: 'Edit my trip' });
        budgetInput?.focus();
        return;
      }
    }
    preCheckedBudgetKey = '';

    // Offer hotels that fit the budget before generating.
    let chosenStay = null;
    if (window.SidekickBudgetPickers?.askHotel) {
      const pickedPlaceId = destinationInput?.dataset.placeId || '';
      const destinationPlace = pickedPlaceId && _selectedPlace?.placeId === pickedPlaceId && hasPlaceCoordinates(_selectedPlace) ? _selectedPlace : null;
      buildBtn.disabled = true;
      let choice;
      try {
        choice = await window.SidekickBudgetPickers.askHotel({
          destination: destinationName,
          lat: destinationPlace ? Number(destinationPlace.lat) : null,
          lng: destinationPlace ? Number(destinationPlace.lng) : null,
          startDate: formatDateInput(startVal),
          endDate: formatDateInput(endVal),
          budgetAmountPhp: rawBudget,
        });
      } finally {
        buildBtn.disabled = false;
      }
      if (choice?.status === 'cancel') return;
      if (choice?.status === 'chosen' && choice.hotel) {
        const hotel = choice.hotel;
        chosenStay = {
          name: hotel.name,
          address: hotel.address || '',
          placeId: hotel.placeId || '',
          lat: hotel.lat,
          lng: hotel.lng,
          rating: hotel.rating,
          photoResource: hotel.photoResource || '',
          nightlyLowPhp: hotel.nightlyLowPhp,
          nightlyHighPhp: hotel.nightlyHighPhp,
        };
      }
    }

    buildBtn.disabled = true;
    buildBtn.textContent = 'Building itinerary (this might take a while)…';
    try {
      const generated = await window.SidekickCore.apiRequest('/api/itinerary/generate', {
        method: 'POST',
        body: JSON.stringify({
          email,
          message: `Plan a ${durationDays}-day trip to ${destinationName}. Total budget: PHP ${rawBudget}. Keep the full trip within this budget when possible. Start date: ${formatDateInput(startVal)}. End date: ${formatDateInput(endVal)}.`,
          selectedDestination: { name: destinationName, placeId: destinationInput?.dataset.placeId || '' },
          profile: { ...tempPrefs, startDate: formatDateInput(startVal), endDate: formatDateInput(endVal), durationDays, ...(chosenStay ? { stay: chosenStay } : {}) },
          origin: originText ? { name: originText, address: originText } : null,
        }),
      });
      generated.itinerary = applyLocalScheduleTimes(generated.itinerary, startVal);
      const itineraryData = {
        itinerary: generated.itinerary,
        meta: {
          ...generated.meta,
          destination: generated.meta?.destination || destinationName,
          startDate: formatDateInput(startVal),
          endDate: formatDateInput(endVal),
          durationDays,
          budget: budgetLabel,
          budgetAmountPhp: rawBudget,
          serverTripId: generated.tripId,
          ...(chosenStay ? { stay: { ...chosenStay, ...(generated.meta?.stay || {}) } } : {}),
        },
      };
      if (itineraryData.meta.liveTripBudget && Array.isArray(itineraryData.meta.liveActivityCosts)) {
        itineraryData.meta.liveTripBudgetCacheKey = getTripBudgetCacheKey(itineraryData);
        itineraryData.meta.liveTripBudgetCachedAt = Date.now();
      }
      setItineraryForEmail(email, itineraryData);
      updateHeaderDate(tempPrefs, itineraryData);
      renderItinerary(itineraryData.itinerary, Boolean(itineraryData.meta?.isDevelopmentMock));
      loadLiveTripBudget(itineraryData, email);
      enrichItineraryWithLiveRoutes(itineraryData, email);
      const addBtn = document.getElementById('add-activity-btn');
      if (addBtn) addBtn.style.display = 'block';
      attachAddActivityHandler(itineraryData, tempPrefs, email, startVal);
      window.SidekickItineraryEdit?.setCurrent(itineraryData);
      if (chosenStay) window.SidekickStayEat?.setStay(chosenStay, destinationName);
      showBuilder(false);
      window.SidekickAppRating?.afterItineraryGenerated();
      try { window.SidekickCore?.syncRemindersFromItinerary?.(email); } catch (error) {}
      try { window.SidekickCore?.scheduleAllFor?.(email); } catch (error) {}
    } catch (error) {
      window.SidekickUI.alert(error.message || 'Verified itinerary generation failed.', { title: 'Itinerary not built' });
    } finally {
      buildBtn.disabled = false;
      buildBtn.textContent = 'Build Itinerary';
    }
  });

  if (existing?.meta?.budgetAmountPhp && budgetInput) budgetInput.value = existing.meta.budgetAmountPhp;
  if (existing?.meta?.origin && originInput) originInput.value = existing.meta.origin.address || existing.meta.origin.name || '';

  // "Generate itinerary" on a Home destination hands its trip here: fill the
  // builder with it and run the same Build Itinerary flow as tapping the button.
  let pendingBuild = null;
  try {
    pendingBuild = JSON.parse(sessionStorage.getItem('sidekick.itinerary.pendingBuild') || 'null');
    sessionStorage.removeItem('sidekick.itinerary.pendingBuild');
  } catch (error) {}
  if (pendingBuild && pendingBuild.destination && Date.now() - Number(pendingBuild.createdAt || 0) < 2 * 60 * 1000 && buildBtn) {
    // Home already checked this trip's budget; don't check (or pay for) it again.
    if (pendingBuild.budgetCheckedKey) preCheckedBudgetKey = pendingBuild.budgetCheckedKey;
    if (destinationInput) {
      destinationInput.value = pendingBuild.destination;
      destinationInput.dataset.placeId = pendingBuild.placeId || '';
    }
    const pendingPlace = { name: pendingBuild.destination, placeId: pendingBuild.placeId || '', lat: pendingBuild.lat, lng: pendingBuild.lng };
    if (pendingPlace.placeId && hasPlaceCoordinates(pendingPlace)) _selectedPlace = pendingPlace;
    if (startInput) startInput.value = pendingBuild.startDate;
    if (endInput) {
      endInput.min = pendingBuild.startDate;
      endInput.value = pendingBuild.endDate;
    }
    if (budgetInput) budgetInput.value = pendingBuild.budgetAmountPhp;
    if (originInput) originInput.value = pendingBuild.origin || '';
    updateBuilderDatePreview(startInput?.value, endInput?.value);
    showBuilder(true);
    buildBtn.click();
  }
});

function applyLocalScheduleTimes(itinerary, firstDay) {
  if (!Array.isArray(itinerary)) return itinerary;
  return itinerary.map((day, dayIndex) => ({
    ...day,
    activities: (day.activities || []).map((activity) => {
      const match = String(activity.timeLabel || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) return activity;
      let hour = Number(match[1]) % 12;
      if (match[3].toUpperCase() === 'PM') hour += 12;
      const date = new Date(firstDay);
      date.setDate(date.getDate() + dayIndex);
      date.setHours(hour, Number(match[2]), 0, 0);
      return { ...activity, dueAt: date.getTime(), iso: date.toISOString() };
    }),
  }));
}
