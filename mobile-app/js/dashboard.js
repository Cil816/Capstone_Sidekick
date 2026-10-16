const GOOGLE_MAPS_API_KEY = (window.SIDEKICK_CONFIG && window.SIDEKICK_CONFIG.googleMapsApiKey) || "YOUR_RESTRICTED_GOOGLE_MAPS_KEY";
const SELECTED_DESTINATION_KEY = "sidekick.selectedDestination.v1";
const PENDING_CHAT_MESSAGE_KEY = "sidekick.pendingChatMessage.v1";

let _gmapsLoadPromise = null;
let _modalMap = null;
let _marker = null;
let _originMarker = null;
let _routePolyline = null;
let _selectedPlace = null;
let _selectedOriginPlace = null;
let _originSearchTimer = null;
let _originSearchRequestId = 0;
const IS_PERF_LITE = Boolean(window.SidekickCore && window.SidekickCore.isPerfLiteMode && window.SidekickCore.isPerfLiteMode());

function svgPin() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
      <circle cx="12" cy="10" r="3"></circle>
    </svg>
  `;
}

function normalizeQuery(q) {
  return String(q || "").trim().toLowerCase();
}

function placeMatches(place, query) {
  if (!query) return true;
  const text = `${place.name} ${place.region} ${(place.tags || []).join(" ")}`.toLowerCase();
  return text.includes(query);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setSearchStatus(text = "") {
  const status = document.getElementById("destination-search-status");
  if (status) status.textContent = text;
}

function ensureGoogleMapsLoaded() {
  if (_gmapsLoadPromise) return _gmapsLoadPromise;
  _gmapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.places) {
      resolve();
      return;
    }
      if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === "YOUR_RESTRICTED_GOOGLE_MAPS_KEY") {
      reject(new Error("No API"));
      return;
    }
    const script = document.createElement("script");
    window.gm_authFailure = () => {
      const map = document.getElementById("destination-map");
      if (map) map.innerHTML = '<div class="destination-map-message">Google Maps could not authenticate this key. Check its website restrictions, billing, and Maps JavaScript API configuration.</div>';
    };
    // loading=async needs a callback: it fires once the API and the geometry library are ready.
    window.__sidekickDashboardMapsReady = () => resolve();
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=geometry&loading=async&callback=__sidekickDashboardMapsReady`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
  return _gmapsLoadPromise;
}

function buildPreferenceKeywords(prefs, searchQuery = "") {
  if (String(searchQuery || "").trim()) {
    return [String(searchQuery).trim()];
  }

  // Every keyword targets tourist attractions; interests only steer which kind.
  const byInterest = {
    Beaches: "famous beaches",
    Hiking: "hiking trails and peaks",
    "Historical Sites": "historical landmarks",
    "Local Cuisine": "cultural heritage attractions",
    Nightlife: "scenic city landmarks",
    Shopping: "heritage districts and landmarks",
    Photography: "scenic viewpoints",
    "Nature & Wildlife": "nature parks and waterfalls",
    Mountains: "mountain attractions",
    "Water Sports": "diving and snorkeling spots",
    "Island Hopping": "island hopping destinations",
  };

  const byTravelType = {
    "Food Tour": "cultural heritage attractions",
    Adventure: "adventure attractions",
    Cultural: "heritage sites",
    "Beach & Relaxation": "famous beaches",
    "Nature & Wildlife": "nature attractions",
    "City Exploration": "city landmarks",
  };

  const interestKeywords = (prefs?.interests || []).map((i) => byInterest[i]).filter(Boolean);
  const typeKeywords = (prefs?.travelTypes || []).map((t) => byTravelType[t]).filter(Boolean);
  const base = [
    ...interestKeywords,
    ...typeKeywords,
    "tourist attractions",
    "best places to visit",
  ];

  if (searchQuery) base.unshift(searchQuery);

  return Array.from(new Set(base)).slice(0, 4);
}

function normalizeRegion(rawAddress) {
  const addr = String(rawAddress || "");
  if (!addr) return "Philippines";
  const parts = addr.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || "Philippines";
}

function extractTags(types) {
  const map = {
    tourist_attraction: "Tourist Attraction",
    landmark: "Historical Sites",
    museum: "Historical Sites",
    church: "Historical Sites",
    historical_landmark: "Historical Sites",
    park: "Nature & Wildlife",
    natural_feature: "Nature & Wildlife",
    beach: "Beaches",
    national_park: "Nature & Wildlife",
    hiking_area: "Hiking",
    campground: "Nature & Wildlife",
    lodging: "Relaxation",
    restaurant: "Local Cuisine",
    food: "Local Cuisine",
    bar: "Nightlife",
    shopping_mall: "Shopping",
    point_of_interest: "Point of Interest",
  };
  const tags = (types || []).map((t) => map[t]).filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 5);
}

function toDashboardPlace(gPlace) {
  const loc = gPlace.geometry && gPlace.geometry.location;
  const lat = loc && typeof loc.lat === "function" ? loc.lat() : null;
  const lng = loc && typeof loc.lng === "function" ? loc.lng() : null;
  const photo = Array.isArray(gPlace.photos) && gPlace.photos[0]
    ? gPlace.photos[0].getUrl({ maxWidth: 800, maxHeight: 500 })
    : "";

  return {
    id: gPlace.place_id,
    placeId: gPlace.place_id,
    name: gPlace.name || "Unknown Place",
    region: normalizeRegion(gPlace.formatted_address || gPlace.vicinity),
    address: gPlace.formatted_address || gPlace.vicinity || "Philippines",
    lat,
    lng,
    tags: extractTags(gPlace.types),
    rating: Number(gPlace.rating || 0),
    ratingCount: Number(gPlace.user_ratings_total || 0),
    photoUrl: photo,
  };
}

function toBackendDashboardPlace(place) {
  const photoUrl = place.photoResource && window.SidekickCore.getApiBaseUrl
    ? `${window.SidekickCore.getApiBaseUrl()}/api/maps/photo?name=${encodeURIComponent(place.photoResource)}`
    : "";
  return {
    id: place.placeId,
    placeId: place.placeId,
    name: place.name || "Unknown Place",
    region: normalizeRegion(place.address),
    address: place.address || "Philippines",
    lat: place.lat == null ? Number.NaN : Number(place.lat),
    lng: place.lng == null ? Number.NaN : Number(place.lng),
    tags: extractTags(place.types),
    types: Array.isArray(place.types) ? place.types : [],
    rating: Number(place.rating || 0),
    ratingCount: Number(place.ratingCount || 0),
    photoUrl,
    photoAttribution: place.photoAttribution || null,
    isDevelopmentMock: Boolean(place.isDevelopmentMock),
  };
}

function renderPhotoAttribution(place) {
  const attribution = place.photoAttribution;
  if (!attribution?.name) return "";
  const label = window.SidekickCore.escapeHtml(attribution.name);
  // Only https links are made clickable (never javascript: or other schemes).
  const uri = /^https:\/\//i.test(String(attribution.uri || "")) ? String(attribution.uri) : "";
  return uri
    ? `<small class="photo-attribution"><a href="${window.SidekickCore.escapeHtml(uri)}" target="_blank" rel="noopener noreferrer">${label}</a></small>`
    : `<small class="photo-attribution">${label}</small>`;
}

function preferenceScore(place, prefs) {
  const text = (place.name + " " + place.region + " " + (place.tags || []).join(" ")).toLowerCase();
  const types = new Set((place.types || []).map((type) => String(type).toLowerCase()));
  const rating = Math.max(0, Math.min(5, Number(place.rating) || 0));
  const reviewCount = Math.max(0, Number(place.ratingCount) || 0);
  const qualityRating = reviewCount
    ? (rating * reviewCount + 4.2 * 25) / (reviewCount + 25)
    : rating * 0.8;
  let score = qualityRating + Math.log10(reviewCount + 1) * 0.35;

  const interestSignals = {
    "beaches": { words: ["beach", "island", "coast", "surf", "snorkel", "diving"], types: ["beach", "island", "surfing_school"] },
    "hiking": { words: ["hiking", "trail", "mountain", "falls", "volcano", "trek"], types: ["hiking_area", "mountain_peak", "national_park", "waterfall"] },
    "historical sites": { words: ["historical", "history", "heritage", "museum", "landmark", "church", "fort"], types: ["museum", "church", "historical_landmark", "landmark"] },
    "local cuisine": { words: ["food", "restaurant", "market", "cuisine", "food walk"], types: ["restaurant", "food", "market", "meal_takeaway"] },
    "nightlife": { words: ["nightlife", "bar", "club", "entertainment", "night market"], types: ["bar", "night_club"] },
    "shopping": { words: ["shopping", "market", "mall", "souvenir"], types: ["shopping_mall", "market"] },
    "photography": { words: ["scenic", "viewpoint", "photography", "landscape", "photo", "lookout"], types: ["observation_deck", "scenic_spot"] },
    "nature & wildlife": { words: ["nature", "wildlife", "park", "forest", "river", "falls", "island", "garden"], types: ["park", "national_park", "natural_feature", "wildlife_park", "zoo", "aquarium"] },
    "mountains": { words: ["mountain", "hill", "hiking", "volcano", "terrace", "peak"], types: ["mountain_peak", "hiking_area"] },
    "water sports": { words: ["water sports", "beach", "surf", "diving", "snorkel", "island", "falls", "waterfall"], types: ["beach", "surfing_school", "marina"] },
  };
  const typeSignals = {
    "food tour": ["local cuisine"],
    adventure: ["hiking", "water sports", "mountains"],
    cultural: ["historical sites"],
    "beach & relaxation": ["beaches", "nature & wildlife"],
    "nature & wildlife": ["nature & wildlife", "hiking", "mountains"],
    "city exploration": ["historical sites", "shopping", "local cuisine"],
  };
  const matchesSignal = (key) => {
    const signal = interestSignals[key];
    return Boolean(signal && (
      (place.tags || []).some((tag) => String(tag).toLowerCase() === key)
      || signal.types.some((type) => types.has(type))
      || signal.words.some((word) => text.includes(word))
    ));
  };

  for (const interest of prefs?.interests || []) {
    const key = String(interest).toLowerCase();
    if (matchesSignal(key)) score += 4;
  }
  for (const travelType of prefs?.travelTypes || []) {
    const relatedInterests = typeSignals[String(travelType).toLowerCase()] || [];
    if (relatedInterests.some(matchesSignal)) score += 2.5;
  }

  if (["tourist_attraction", "landmark", "national_park", "museum", "monument"].some((type) => types.has(type))) score += 1.25;
  return score;
}

function getPhilippinesSeedLocations() {
  return [{ lat: 14.5995, lng: 120.9842 }, { lat: 10.3157, lng: 123.8854 }, { lat: 7.1907, lng: 125.4553 }];
}

// Types that mark a place as a real tourist spot, and types/names that mark it as an
// everyday business (markets, malls, hotels, restaurants, terminals...) to leave out.
const TOURIST_SPOT_TYPES = new Set([
  "tourist_attraction", "natural_feature", "beach", "park", "national_park", "state_park", "museum",
  "historical_landmark", "historical_place", "landmark", "monument", "cultural_landmark", "church",
  "place_of_worship", "hindu_temple", "mosque", "synagogue", "zoo", "aquarium", "amusement_park",
  "water_park", "hiking_area", "garden", "botanical_garden", "observation_deck", "scenic_spot",
  "art_gallery", "wildlife_park", "wildlife_refuge", "island", "campground", "plaza", "cultural_center",
  "picnic_ground", "marina", "visitor_center", "adventure_sports_center",
]);
const NON_TOURIST_TYPES = new Set([
  "market", "shopping_mall", "store", "supermarket", "grocery_store", "convenience_store", "department_store",
  "clothing_store", "home_goods_store", "hardware_store", "electronics_store", "food_store", "lodging", "hotel",
  "resort_hotel", "motel", "hostel", "inn", "guest_house", "bed_and_breakfast", "restaurant", "cafe", "bar",
  "food", "meal_takeaway", "meal_delivery", "bakery", "spa", "gym", "travel_agency", "real_estate_agency",
  "bank", "atm", "hospital", "pharmacy", "drugstore", "school", "gas_station", "car_rental", "bus_station",
  "transit_station", "airport", "local_government_office", "police", "post_office", "finance", "doctor",
]);
const NON_TOURIST_NAME = /\b(wet market|public market|fish market|meat market|talipapa|palengke|mall|supermarket|grocery|terminal|hospital|pharmacy|drugstore|bank|pawnshop|gas station|gasoline|hardware)\b/i;

function isTouristSpot(place) {
  if (!place) return false;
  // Development samples use placeholder types, so keep the old behaviour for them.
  if (place.isDevelopmentMock) return true;
  if (NON_TOURIST_NAME.test(String(place.name || ""))) return false;
  const types = (place.types || []).map((type) => String(type).toLowerCase());
  if (types.some((type) => NON_TOURIST_TYPES.has(type))) return false;
  return !types.length || types.some((type) => TOURIST_SPOT_TYPES.has(type));
}

function getInterestKeywords(prefs) {
  // Same interest/travel-style keywords used for general recommendations, without the generic fallbacks.
  return buildPreferenceKeywords(prefs).filter((kw) => kw !== "tourist attractions" && kw !== "best places to visit");
}

function getRecommendedLimit(prefs) {
  const destinationCount = (window.SidekickCore.getPreferredDestinations?.(prefs) || []).length;
  return Math.max(IS_PERF_LITE ? 5 : 8, destinationCount);
}

async function fetchDestinationPlaces(destination, index, prefs, interestKeywords, destinationCount) {
  const interestKeyword = interestKeywords.length ? interestKeywords[index % interestKeywords.length] : "";
  // Always search for top tourist spots; with few destinations add an interest-based query too.
  const queries = Array.from(new Set(["top tourist spots", interestKeyword].filter(Boolean)))
    .slice(0, destinationCount <= 3 ? 2 : 1)
    .map((keyword) => keyword + " in " + destination.name);
  const lat = Number(destination.lat);
  const lng = Number(destination.lng);
  const seeds = destination.lat != null && destination.lng != null && Number.isFinite(lat) && Number.isFinite(lng) ? [{ lat, lng }] : [];
  const data = await window.SidekickCore.apiRequest("/api/maps/places", {
    method: "POST", body: JSON.stringify({ queries, seeds, touristOnly: true }),
  });
  return (data.places || []).map(toBackendDashboardPlace)
    .map((place) => ({ ...place, isDevelopmentMock: Boolean(data.isDevelopmentMock), preferredFor: destination.name }))
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .filter(isTouristSpot)
    .sort((a, b) => preferenceScore(b, prefs) - preferenceScore(a, prefs));
}

async function fetchRecommendedPlaces(prefs, searchQuery = "") {
  const limit = getRecommendedLimit(prefs);
  const destinations = String(searchQuery || "").trim() ? [] : (window.SidekickCore.getPreferredDestinations?.(prefs) || []);

  if (!destinations.length) {
    const keywords = buildPreferenceKeywords(prefs, searchQuery);
    const data = await window.SidekickCore.apiRequest("/api/maps/places", {
      method: "POST", body: JSON.stringify({ queries: keywords, seeds: getPhilippinesSeedLocations(), touristOnly: true }),
    });
    const allPlaces = (data.places || []).map(toBackendDashboardPlace)
      .map((place) => ({ ...place, isDevelopmentMock: Boolean(data.isDevelopmentMock) }))
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
      .filter(isTouristSpot);
    return allPlaces.sort((a, b) => preferenceScore(b, prefs) - preferenceScore(a, prefs)).slice(0, limit);
  }

  // Search around each of the user's chosen destinations, then interleave so every
  // destination is represented before any one of them contributes a second spot.
  const interestKeywords = getInterestKeywords(prefs);
  const settled = await Promise.allSettled(
    destinations.map((destination, index) => fetchDestinationPlaces(destination, index, prefs, interestKeywords, destinations.length)),
  );
  const lists = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const seen = new Set();
  const recommended = [];
  for (let round = 0; recommended.length < limit && lists.some((list) => round < list.length); round += 1) {
    for (const list of lists) {
      const place = list[round];
      if (!place || seen.has(place.placeId) || recommended.length >= limit) continue;
      seen.add(place.placeId);
      recommended.push(place);
    }
  }
  return recommended;
}

async function fetchPopularPlaces() {
  const data = await window.SidekickCore.apiRequest("/api/maps/places", {
    method: "POST",
    body: JSON.stringify({ queries: ["top tourist attractions", "famous landmarks", "must visit destinations", "best beaches and islands"], touristOnly: true }),
  });
  // Development mode only returns sample places for another country; use the curated list instead.
  if (data.isDevelopmentMock) return [];
  const popularity = (place) => (place.rating || 0) * Math.log10((place.ratingCount || 0) + 10);
  return (data.places || []).map(toBackendDashboardPlace)
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .filter((place) => place.rating > 0 && place.ratingCount >= 100)
    .filter(isTouristSpot)
    .sort((a, b) => popularity(b) - popularity(a))
    .slice(0, IS_PERF_LITE ? 5 : 8);
}

async function fetchPlacesFromGoogle(prefs, searchQuery = "") {
  // Recommended follows the user's preferences; popular is a general list of top
  // Philippine tourist spots. They are fetched independently so one failing
  // does not hide the other.
  const [recommendedResult, popularResult] = await Promise.allSettled([
    fetchRecommendedPlaces(prefs, searchQuery),
    fetchPopularPlaces(),
  ]);
  const recommended = recommendedResult.status === "fulfilled" ? recommendedResult.value : [];
  const popularDestinations = popularResult.status === "fulfilled" && popularResult.value.length >= 4 ? popularResult.value : [];
  return { recommended, popularDestinations, allPlaces: recommended.concat(popularDestinations) };
}

function renderPlaceCard(place) {
  const safeName = window.SidekickCore.escapeHtml(place.name);
  const safeRegion = window.SidekickCore.escapeHtml(place.region);
  const mockLabel = place.isDevelopmentMock ? '<small class="development-place-label">Development sample</small>' : '';
  const imgPart = place.photoUrl
    ? `<img src="${place.photoUrl}" alt="${safeName}" loading="lazy" />`
    : svgPin();
  return `
    <div class="place-card" data-place-id="${window.SidekickCore.escapeHtml(place.placeId)}">
      <div class="place-image">${place.photoUrl ? `<img src="${window.SidekickCore.escapeHtml(place.photoUrl)}" alt="${safeName}" loading="lazy" onerror="this.style.display='none'" />` : imgPart}${renderPhotoAttribution(place)}</div>
      <div class="place-info">
        <h3>${safeName}</h3>
        <p>${safeRegion}</p>
        ${mockLabel}
      </div>
    </div>
  `;
}

function renderDestinationCard(place) {
  const safeName = window.SidekickCore.escapeHtml(place.name);
  const safeRegion = window.SidekickCore.escapeHtml(place.region);
  const mockLabel = place.isDevelopmentMock ? '<small class="development-place-label">Development sample</small>' : '';
  const imgPart = place.photoUrl
    ? `<img src="${place.photoUrl}" alt="${safeName}" loading="lazy" />`
    : svgPin();
  return `
    <div class="destination-card" data-place-id="${window.SidekickCore.escapeHtml(place.placeId)}">
      <div class="destination-image">${place.photoUrl ? `<img src="${window.SidekickCore.escapeHtml(place.photoUrl)}" alt="${safeName}" loading="lazy" onerror="this.style.display='none'" />` : imgPart}${renderPhotoAttribution(place)}</div>
      <div class="destination-info">
        <h3>${safeName}</h3>
        <p>${safeRegion}</p>
        ${mockLabel}
      </div>
    </div>
  `;
}

function persistSelectedDestination(place) {
  if (!place) return;
  localStorage.setItem(SELECTED_DESTINATION_KEY, JSON.stringify(place));
}

function getSelectedDestination() {
  try {
    const raw = localStorage.getItem(SELECTED_DESTINATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function openModal() {
  const modal = document.getElementById("destination-modal");
  if (!modal) return;
  // Keep the pop-up at the top level of the page so it always opens in view.
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  // Start at the top of the details (name and photo first), not mid-scroll.
  const panel = modal.querySelector(".destination-modal-panel");
  if (panel) panel.scrollTop = 0;
  // The page behind should not scroll while the details are open.
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
}

function closeModal() {
  const modal = document.getElementById("destination-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.documentElement.style.removeProperty("overflow");
  document.body.style.removeProperty("overflow");
}

async function showDestinationDetails(place, prefs, session) {
  _selectedPlace = place;
  persistSelectedDestination(place);
  openModal();

  const imageEl = document.getElementById("destination-image");
  if (imageEl) {
    imageEl.innerHTML = place.photoUrl
      ? `<img src="${window.SidekickCore.escapeHtml(place.photoUrl)}" alt="${window.SidekickCore.escapeHtml(place.name)}" loading="lazy" />${renderPhotoAttribution(place)}`
      : `<div class="destination-photo-fallback">${svgPin()}</div>`;
  }

  setText("destination-title", place.name);
  setText("destination-subtitle", `${place.region}, Philippines${place.isDevelopmentMock ? " • Development sample" : ""}`);
  setText("destination-route-mode", "Not calculated");
  setText("destination-route-distance", "Unavailable");
  const routeError = document.getElementById("destination-route-error");
  if (routeError) routeError.hidden = true;

  const tagsEl = document.getElementById("destination-tags");
  if (tagsEl) {
    tagsEl.innerHTML = (place.tags || [])
      .slice(0, 5)
      .map((tag) => `<span class="tag">${window.SidekickCore.escapeHtml(tag)}</span>`)
      .join("");
  }

  const mapEl = document.getElementById("destination-map");
  if (!mapEl) return;
  const originInput = document.getElementById("destination-origin");
  if (originInput) originInput.value = "";
  _selectedOriginPlace = null;
  if (_originMarker) {
    _originMarker.setMap(null);
    _originMarker = null;
  }
  const originStatus = document.getElementById("destination-origin-status");
  const originResults = document.getElementById("destination-origin-results");
  _originSearchRequestId += 1;
  clearTimeout(_originSearchTimer);
  if (originStatus) originStatus.textContent = "";
  if (originResults) {
    originResults.replaceChildren();
    originResults.hidden = true;
  }
  const routeButton = document.getElementById("destination-calculate-route");
  if (routeButton) routeButton.disabled = true;

  if (_routePolyline) {
    _routePolyline.setMap(null);
    _routePolyline = null;
  }
  try {
    await ensureGoogleMapsLoaded();
    const destinationPosition = { lat: Number(place.lat), lng: Number(place.lng) };
    if (!Number.isFinite(destinationPosition.lat) || !Number.isFinite(destinationPosition.lng)) {
      throw new Error("This destination has no coordinates for mapping.");
    }
    _modalMap = new google.maps.Map(mapEl, { center: destinationPosition, zoom: 8, disableDefaultUI: true });
    _marker = new google.maps.Marker({ map: _modalMap, position: destinationPosition, title: place.name, label: { text: "B", color: "#fff" } });
    requestAnimationFrame(() => google.maps.event.trigger(_modalMap, "resize"));
  } catch (err) {
    const message = err && err.message === "No API"
      ? "Interactive map is not configured. Add a browser-restricted Google Maps key in mobile-app/js/config.local.js."
      : err.message || "Interactive map is unavailable right now.";
    mapEl.innerHTML = `<div class="destination-map-message">${window.SidekickCore.escapeHtml(message)}</div>`;
  }

  if (routeButton) {
    routeButton.onclick = () => calculateDestinationRoute(place);
  }
  if (originInput) {
    originInput.oninput = () => {
      _selectedOriginPlace = null;
      delete originInput.dataset.verifiedOrigin;
      if (_originMarker) {
        _originMarker.setMap(null);
        _originMarker = null;
      }
      if (_modalMap && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))) {
        _modalMap.panTo({ lat: Number(place.lat), lng: Number(place.lng) });
        _modalMap.setZoom(8);
      }
      if (routeButton) routeButton.disabled = true;
      setText("destination-route-mode", "Not calculated");
      setText("destination-route-distance", "Unavailable");
      if (originResults) {
        originResults.replaceChildren();
        originResults.hidden = true;
      }
      if (originStatus) originStatus.textContent = "";
      const query = originInput.value.trim();
      const requestId = ++_originSearchRequestId;
      clearTimeout(_originSearchTimer);
      if (query.length < 2) return;

      _originSearchTimer = setTimeout(async () => {
        if (originStatus) originStatus.textContent = "Searching…";
        try {
          const response = await window.SidekickCore.apiRequest("/api/maps/places", {
            method: "POST",
            body: JSON.stringify({ queries: [query] }),
          });
          if (requestId !== _originSearchRequestId) return;
          const matches = (response.places || [])
            .filter((candidate) => candidate.lat != null && candidate.lng != null && Number.isFinite(Number(candidate.lat)) && Number.isFinite(Number(candidate.lng)))
            .slice(0, 8);
          if (!matches.length) {
            if (originStatus) originStatus.textContent = "No matching places found.";
            return;
          }
          if (originResults) {
            matches.forEach((candidate) => {
              const resultButton = document.createElement("button");
              resultButton.type = "button";
              resultButton.className = "destination-origin-result";
              resultButton.setAttribute("role", "option");
              resultButton.setAttribute("aria-selected", "false");
              resultButton.innerHTML = `<strong>${window.SidekickCore.escapeHtml(candidate.name || "Unknown place")}</strong><span>${window.SidekickCore.escapeHtml(candidate.address || "Address unavailable")}</span>`;
              resultButton.addEventListener("click", () => {
                _selectedOriginPlace = candidate;
                originInput.value = candidate.address || candidate.name || query;
                if (routeButton) routeButton.disabled = false;
                if (originStatus) originStatus.textContent = `✓ ${candidate.name || candidate.address}${candidate.address ? ` — ${candidate.address}` : ""}`;
                originResults.replaceChildren();
                originResults.hidden = true;

                if (_modalMap) {
                  const originPosition = { lat: Number(candidate.lat), lng: Number(candidate.lng) };
                  if (_originMarker) _originMarker.setMap(null);
                  _originMarker = new google.maps.Marker({
                    map: _modalMap,
                    position: originPosition,
                    title: `Starting location: ${candidate.name || candidate.address}`,
                    label: { text: "A", color: "#fff" },
                  });
                  const destinationPosition = { lat: Number(place.lat), lng: Number(place.lng) };
                  if (originPosition.lat === destinationPosition.lat && originPosition.lng === destinationPosition.lng) {
                    _modalMap.panTo(originPosition);
                    _modalMap.setZoom(13);
                  } else {
                    const bounds = new google.maps.LatLngBounds();
                    bounds.extend(originPosition);
                    bounds.extend(destinationPosition);
                    _modalMap.fitBounds(bounds, 48);
                  }
                }
              });
              originResults.appendChild(resultButton);
            });
            originResults.hidden = false;
          }
          if (originStatus) originStatus.textContent = "";
        } catch (error) {
          if (requestId === _originSearchRequestId && originStatus) {
            originStatus.textContent = error.message || "Location search failed.";
          }
        }
      }, 300);
    };
    originInput.onfocus = () => {
      if (_selectedOriginPlace || !originInput.value.trim() || !originResults?.childElementCount) return;
      originResults.hidden = false;
    };
    originInput.onkeydown = (event) => {
      if (event.key === "Escape" && originResults) {
        originResults.hidden = true;
      }
    };
  }
  const generateBtn = document.getElementById("destination-generate");
  if (generateBtn) {
    generateBtn.onclick = () => generateFocusedItinerary(place, prefs, session);
  }

  async function calculateDestinationRoute(place) {
    const origin = _selectedOriginPlace;
    const travelMode = "DRIVE";
    if (!origin) {
      return;
    }
    const button = document.getElementById("destination-calculate-route");
    if (button) button.disabled = true;
    setText("destination-route-mode", "Calculating route...");
    setText("destination-route-distance", "Calculating...");
    if (routeError) routeError.hidden = true;
    try {
      const response = await window.SidekickCore.apiRequest("/api/maps/route", {
        method: "POST",
        body: JSON.stringify({
          origin: { placeId: origin.placeId, lat: origin.lat, lng: origin.lng, address: origin.address, name: origin.name },
          destination: { placeId: place.placeId, lat: place.lat, lng: place.lng, address: place.address, name: place.name },
          travelMode,
        }),
      });
      const route = response.route;
      setText("destination-route-mode", `${route.travelMode}${response.isDevelopmentMock ? " (development estimate)" : ""}`);
      setText("destination-route-distance", `${(route.distanceMeters / 1000).toFixed(1)} km`);
      if (route.encodedPolyline && _modalMap && google.maps.geometry?.encoding) {
        if (_routePolyline) _routePolyline.setMap(null);
        const path = google.maps.geometry.encoding.decodePath(route.encodedPolyline);
        _routePolyline = new google.maps.Polyline({ map: _modalMap, path, strokeColor: "#2c91b0", strokeWeight: 5 });
        const bounds = new google.maps.LatLngBounds();
        path.forEach((point) => bounds.extend(point));
        _modalMap.fitBounds(bounds);
      }
    } catch (error) {
      setText("destination-route-mode", "Route unavailable");
      setText("destination-route-distance", "Unavailable");
      if (routeError) {
        routeError.hidden = false;
        const noRouteExists = error.statusCode === 422;
        setText(
          "destination-route-error-message",
          noRouteExists
            ? "Google Maps could not find a driving or public-transit route between these locations. Try a different starting point or destination."
            : "The route service is temporarily unavailable. Please try again later.",
        );
        setText("destination-route-error-details", error.message || "No additional error details were provided.");
        routeError.querySelector("details")?.removeAttribute("open");
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  const askAiBtn = document.getElementById("destination-ask-ai");
  if (askAiBtn) {
    askAiBtn.onclick = () => {
      persistSelectedDestination(place);
      const question = `What do visitors think of ${place.name}?`;
      try {
        sessionStorage.setItem(PENDING_CHAT_MESSAGE_KEY, question);
      } catch (error) {}
      window.location.href = "chat.html";
    };
  }
}

// "Generate itinerary" hands the trip to the Itinerary screen, which builds it
// with its own Build Itinerary flow (trip confirmation, budget hotel choice,
// generation, budget estimate and reminders), so both buttons give the same result.
const PENDING_BUILD_KEY = "sidekick.itinerary.pendingBuild";

async function generateFocusedItinerary(place, prefs, session) {
  if (!session?.email || !place?.name) return;
  const button = document.getElementById("destination-generate");
  if (button?.disabled) return;
  const budgetInput = document.getElementById("destination-plan-budget");
  const daysInput = document.getElementById("destination-plan-days");
  const errorEl = document.getElementById("destination-plan-error");
  const budgetAmountPhp = Number(budgetInput?.value);
  const durationDays = Number(daysInput?.value);
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (!Number.isSafeInteger(budgetAmountPhp) || budgetAmountPhp < 1) {
    if (errorEl) {
      errorEl.textContent = "Enter a whole-number budget in Philippine pesos.";
      errorEl.hidden = false;
    }
    budgetInput?.focus();
    return;
  }
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 14) {
    if (errorEl) {
      errorEl.textContent = "Choose a trip length from 1 to 14 days.";
      errorEl.hidden = false;
    }
    daysInput?.focus();
    return;
  }
  // The trip starts today and lasts the chosen number of days.
  const dateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + durationDays - 1);
  const origin = _selectedOriginPlace
    ? String(_selectedOriginPlace.address || _selectedOriginPlace.name || "").trim()
    : String(document.getElementById("destination-origin")?.value || "").trim();

  // Check the budget against the cheapest restaurants and hotels before leaving,
  // so an unrealistic budget can be fixed right here.
  const trip = { destination: place.name, startDate: dateValue(start), endDate: dateValue(end), budgetAmountPhp };
  if (button) {
    button.disabled = true;
    button.textContent = "Checking budget…";
  }
  let budgetCheck = null;
  try {
    budgetCheck = await window.SidekickCore.checkTripBudget({
      ...trip,
      lat: Number.isFinite(Number(place.lat)) ? Number(place.lat) : null,
      lng: Number.isFinite(Number(place.lng)) ? Number(place.lng) : null,
    });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Generate itinerary";
    }
  }
  if (budgetCheck?.checked && !budgetCheck.realistic) {
    const problem = window.SidekickCore.describeUnrealisticBudget(budgetCheck, place.name);
    await window.SidekickUI.alert(problem.message, { title: problem.title, details: problem.details, confirmText: "Edit my trip" });
    if (errorEl) {
      errorEl.textContent = `Budget too low for ${durationDays} day${durationDays === 1 ? "" : "s"}. Enter at least ₱${Math.round(budgetCheck.minimumPhp).toLocaleString()}${budgetCheck.maxAffordableDays >= 1 && budgetCheck.maxAffordableDays < durationDays ? ` or choose ${budgetCheck.maxAffordableDays} day${budgetCheck.maxAffordableDays === 1 ? "" : "s"}` : ""}.`;
      errorEl.hidden = false;
    }
    budgetInput?.focus();
    return;
  }

  try {
    sessionStorage.setItem(PENDING_BUILD_KEY, JSON.stringify({
      budgetCheckedKey: budgetCheck?.checked ? window.SidekickCore.tripBudgetKey(trip) : "",
      destination: place.name,
      placeId: place.placeId || "",
      lat: Number.isFinite(Number(place.lat)) ? Number(place.lat) : null,
      lng: Number.isFinite(Number(place.lng)) ? Number(place.lng) : null,
      startDate: dateValue(start),
      endDate: dateValue(end),
      budgetAmountPhp,
      origin: origin.slice(0, 180),
      createdAt: Date.now(),
    }));
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = "Unable to open the itinerary builder. Please try again.";
      errorEl.hidden = false;
    }
    return;
  }
  window.location.href = "itinerary.html";
}

// ---- "See all" list screen -------------------------------------------------
const SEE_ALL_PAGE_SIZE = 20;
const SEE_ALL_MAX_ITEMS = 60;
const _seeAllCache = {};
const _seeAllState = { kind: "", items: [], shown: 0, prefs: null, session: null, open: false };

function placeNameKey(place) {
  return String(place?.name || "").trim().toLowerCase();
}

function dedupePlaces(places) {
  const seenIds = new Set();
  const seenNames = new Set();
  const out = [];
  for (const place of places) {
    const id = place.placeId ? String(place.placeId) : "";
    const nameKey = placeNameKey(place);
    if ((id && seenIds.has(id)) || (nameKey && seenNames.has(nameKey))) continue;
    if (id) seenIds.add(id);
    if (nameKey) seenNames.add(nameKey);
    out.push(place);
  }
  return out;
}

async function fetchDestinationPool(destination, interestKeywords) {
  const queries = Array.from(new Set(["top tourist spots", ...interestKeywords.slice(0, 3)]))
    .slice(0, 4).map((keyword) => keyword + " in " + destination.name);
  const lat = Number(destination.lat);
  const lng = Number(destination.lng);
  const seeds = destination.lat != null && destination.lng != null && Number.isFinite(lat) && Number.isFinite(lng) ? [{ lat, lng }] : [];
  const data = await window.SidekickCore.apiRequest("/api/maps/places", {
    method: "POST", body: JSON.stringify({ queries, seeds, touristOnly: true }),
  });
  return (data.places || []).map(toBackendDashboardPlace)
    .map((place) => ({ ...place, isDevelopmentMock: Boolean(data.isDevelopmentMock), preferredFor: destination.name }))
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .filter(isTouristSpot);
}

// Builds the full recommended list ordered from most to least preferred.
async function buildRecommendedPool(prefs, initial) {
  const destinations = window.SidekickCore.getPreferredDestinations?.(prefs) || [];
  const interestKeywords = getInterestKeywords(prefs);
  const generalQueries = Array.from(new Set([...buildPreferenceKeywords(prefs), "tourist attractions"])).slice(0, 4);
  const jobs = destinations.map((destination) => fetchDestinationPool(destination, interestKeywords));
  jobs.push(window.SidekickCore.apiRequest("/api/maps/places", {
    method: "POST", body: JSON.stringify({ queries: generalQueries, seeds: getPhilippinesSeedLocations(), touristOnly: true }),
  }).then((data) => (data.places || []).map(toBackendDashboardPlace)
    .map((place) => ({ ...place, isDevelopmentMock: Boolean(data.isDevelopmentMock) }))
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .filter(isTouristSpot)));
  const settled = await Promise.allSettled(jobs);
  const fetched = settled.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  const destinationIndex = (place) => destinations.findIndex((d) => d.name === place.preferredFor);
  // Places found for a chosen destination outrank general ones; earlier picks outrank later ones.
  const scored = dedupePlaces([...(initial || []), ...fetched]).filter(isTouristSpot).map((place) => {
    const index = destinationIndex(place);
    const bonus = index > -1 ? 6 - index * 0.4 : 0;
    return { place, score: preferenceScore(place, prefs) + bonus };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SEE_ALL_MAX_ITEMS).map((entry) => entry.place);
}

// Builds the full popular list: the most generally well-known Philippine spots first.
async function buildPopularPool(initial) {
  const searches = [
    ["top tourist attractions", "famous landmarks", "must visit destinations", "best beaches and islands"],
    ["best waterfalls", "mountains and hiking spots", "historical sites and churches", "top islands"],
  ];
  const settled = await Promise.allSettled(searches.map((queries) => window.SidekickCore.apiRequest("/api/maps/places", {
    method: "POST", body: JSON.stringify({ queries, touristOnly: true }),
  })));
  const responses = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  // Development mode returns sample places from another country, so ignore them.
  const usable = responses.filter((data) => !data.isDevelopmentMock);
  const popularity = (place) => (place.rating || 0) * Math.log10((place.ratingCount || 0) + 10);
  const ranked = usable.flatMap((data) => data.places || []).map(toBackendDashboardPlace)
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .filter((place) => place.rating > 0 && place.ratingCount >= 100)
    .filter(isTouristSpot)
    .sort((a, b) => popularity(b) - popularity(a));
  const curated = window.SidekickCore.buildPopularDestinations?.() || [];
  const merged = dedupePlaces([...ranked, ...(initial || []), ...curated]);
  // Drop curated spots that a ranked result already covers under a slightly different name.
  const rankedKeys = ranked.map(placeNameKey);
  return merged.filter((place) => {
    if (ranked.includes(place)) return true;
    const key = placeNameKey(place);
    return !rankedKeys.some((other) => other.includes(key) || key.includes(other));
  }).slice(0, SEE_ALL_MAX_ITEMS);
}

function formatRatingLabel(place) {
  const rating = Number(place.rating);
  return Number.isFinite(rating) && rating > 0 ? "★ " + rating.toFixed(1) : "";
}

function renderSeeAllItems(startIndex, endIndex) {
  const list = document.getElementById("see-all-list");
  if (!list) return;
  const esc = window.SidekickCore.escapeHtml;
  const html = _seeAllState.items.slice(startIndex, endIndex).map((place, offset) => {
    const index = startIndex + offset;
    const detail = [place.region, place.preferredFor ? "Near " + place.preferredFor : ""]
      .filter(Boolean).filter((part, i, arr) => arr.indexOf(part) === i).join(" • ");
    return '<button type="button" class="see-all-item" role="listitem" data-index="' + index + '">'
      + '<span class="see-all-rank">' + (index + 1) + "</span>"
      + '<span class="see-all-text"><strong>' + esc(place.name) + "</strong><small>" + esc(detail) + "</small></span>"
      + '<span class="see-all-rating">' + esc(formatRatingLabel(place)) + "</span>"
      + '<svg class="see-all-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'
      + "</button>";
  }).join("");
  list.insertAdjacentHTML("beforeend", html);
}

function updateSeeAllMore() {
  const more = document.getElementById("see-all-more");
  if (!more) return;
  const remaining = _seeAllState.items.length - _seeAllState.shown;
  more.hidden = remaining <= 0;
  if (remaining > 0) more.textContent = "Show more (" + remaining + " left)";
}

function showMoreSeeAll() {
  const start = _seeAllState.shown;
  const end = Math.min(start + SEE_ALL_PAGE_SIZE, _seeAllState.items.length);
  renderSeeAllItems(start, end);
  _seeAllState.shown = end;
  updateSeeAllMore();
}

function setSeeAllVisible(visible) {
  const screen = document.getElementById("see-all-screen");
  if (!screen) return;
  if (!visible && screen.contains(document.activeElement)) {
    // Focus must leave the screen before it is hidden from assistive technology.
    const opener = document.getElementById(_seeAllState.kind === "popular" ? "see-all-popular" : "see-all-recommended");
    if (opener) opener.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  screen.hidden = !visible;
  screen.setAttribute("aria-hidden", String(!visible));
  document.body.style.overflow = visible ? "hidden" : "";
  _seeAllState.open = visible;
}

function closeSeeAll() {
  if (!_seeAllState.open) return;
  setSeeAllVisible(false);
}

async function openSeeAll(kind, prefs, session, initialPlaces) {
  const list = document.getElementById("see-all-list");
  const status = document.getElementById("see-all-status");
  const more = document.getElementById("see-all-more");
  const screen = document.getElementById("see-all-screen");
  if (!list || !status || !more || !screen) return;

  _seeAllState.kind = kind;
  _seeAllState.items = [];
  _seeAllState.shown = 0;
  _seeAllState.prefs = prefs;
  _seeAllState.session = session;
  list.replaceChildren();
  more.hidden = true;
  setText("see-all-title", kind === "recommended" ? "Recommended for you" : "Popular destinations");
  setText("see-all-subtitle", kind === "recommended"
    ? "Ordered from most to least preferred"
    : "Top tourist spots across the Philippines");
  setSeeAllVisible(true);
  screen.scrollTop = 0;
  try { history.pushState({ seeAll: true }, ""); } catch (error) {}

  status.textContent = "Loading destinations…";
  let items = _seeAllCache[kind];
  if (!items) {
    try {
      items = kind === "recommended"
        ? await buildRecommendedPool(prefs, initialPlaces)
        : await buildPopularPool(initialPlaces);
    } catch (error) {
      items = [];
    }
    if (!items.length) {
      // Offline/failed lookups: fall back to what the dashboard already shows plus the local lists.
      const local = window.SidekickCore.buildDashboardRecommendations(prefs);
      items = dedupePlaces([...(initialPlaces || []), ...(kind === "recommended" ? local.recommended : local.popularDestinations)]);
    }
    _seeAllCache[kind] = items;
  }
  // The user may have closed this screen or opened the other list while loading.
  if (!_seeAllState.open || _seeAllState.kind !== kind) return;
  _seeAllState.items = items;
  status.textContent = items.length ? "" : "No destinations to show right now.";
  showMoreSeeAll();
}

function attachCardHandlers(recPlaces, popPlaces, prefs, session) {
  const recCards = document.querySelectorAll("#recommended-row .place-card");
  recCards.forEach((card, idx) => {
    const place = recPlaces[idx];
    if (!place) return;
    card.addEventListener("click", () => showDestinationDetails(place, prefs, session));
  });

  const popCards = document.querySelectorAll("#destinations-grid .destination-card");
  popCards.forEach((card, idx) => {
    const place = popPlaces[idx];
    if (!place) return;
    card.addEventListener("click", () => showDestinationDetails(place, prefs, session));
  });
}

function renderDestinationLists(recommended, popular, query, prefs, session) {
  const recommendedRow = document.getElementById("recommended-row");
  const destinationsGrid = document.getElementById("destinations-grid");
  if (!recommendedRow || !destinationsGrid) return;
  const q = normalizeQuery(query);
  const preferredCount = (window.SidekickCore.getPreferredDestinations?.(prefs) || []).length;
  const rec = recommended.filter((p) => placeMatches(p, q)).slice(0, Math.max(IS_PERF_LITE ? 4 : 6, preferredCount));
  const pop = popular.filter((p) => placeMatches(p, q)).slice(0, IS_PERF_LITE ? 4 : 6);
  recommendedRow.innerHTML = rec.map(renderPlaceCard).join("");
  destinationsGrid.innerHTML = pop.map(renderDestinationCard).join("");
  if (!IS_PERF_LITE) {
    [...recommendedRow.children].forEach((child, idx) => { child.style.animationDelay = (idx * 40) + "ms"; child.style.animation = "cardIn 420ms ease both"; });
    [...destinationsGrid.children].forEach((child, idx) => { child.style.animationDelay = (idx * 35) + "ms"; child.style.animation = "cardIn 420ms ease both"; });
  }
  attachCardHandlers(rec, pop, prefs, session);
}

document.addEventListener("DOMContentLoaded", async () => {
  const session = window.SidekickCore.requireAuth();
  if (!session) return;
  const prefs = window.SidekickCore.requirePreferences();
  if (!prefs) return;

  const nameEl = document.getElementById("user-name");
  const searchInput = document.getElementById("destination-search");
  const searchSuggestions = document.getElementById("destination-search-suggestions");
  const closeBtn = document.getElementById("destination-close");
  const modal = document.getElementById("destination-modal");

  if (nameEl) nameEl.textContent = session.name || "Traveler";

  let recommended = [];
  let popular = [];
  const recommendedRow = document.getElementById("recommended-row");
  const destinationsGrid = document.getElementById("destinations-grid");
  [recommendedRow, destinationsGrid].forEach((container) => {
    if (!container) return;
    container.setAttribute("aria-busy", "true");
    container.innerHTML = '<p class="dashboard-loading">Loading destinations…</p>';
  });

  const initial = window.SidekickCore.buildDashboardRecommendations(prefs);
  recommended = initial.recommended;
  popular = initial.popularDestinations;
  try {
    const model = await fetchPlacesFromGoogle(prefs, "");
    if (model.recommended.length) recommended = model.recommended;
    if (model.popularDestinations.length) popular = model.popularDestinations;
  } catch (error) {
    // Show local results only after the initial Places request has settled.
  }
  renderDestinationLists(recommended, popular, "", prefs, session);

  const seeAllList = document.getElementById("see-all-list");
  const seeAllBack = document.getElementById("see-all-back");
  const seeAllMore = document.getElementById("see-all-more");
  const bindSeeAll = (id, kind, getInitial) => {
    const link = document.getElementById(id);
    if (link) link.addEventListener("click", (event) => { event.preventDefault(); void openSeeAll(kind, prefs, session, getInitial()); });
  };
  bindSeeAll("see-all-recommended", "recommended", () => recommended);
  bindSeeAll("see-all-popular", "popular", () => popular);
  if (seeAllList) {
    seeAllList.addEventListener("click", (event) => {
      const row = event.target.closest(".see-all-item");
      const place = row ? _seeAllState.items[Number(row.dataset.index)] : null;
      if (place) void showDestinationDetails(place, prefs, session);
    });
  }
  if (seeAllMore) seeAllMore.addEventListener("click", showMoreSeeAll);
  if (seeAllBack) {
    seeAllBack.addEventListener("click", () => {
      if (history.state && history.state.seeAll) history.back();
      else closeSeeAll();
    });
  }
  window.addEventListener("popstate", closeSeeAll);
  document.addEventListener("keydown", (event) => {
    const modalOpen = document.getElementById("destination-modal")?.classList.contains("open");
    if (event.key === "Escape" && _seeAllState.open && !modalOpen) closeSeeAll();
  });

  let suggestionTimer = null;
  let suggestionRequestId = 0;
  let placeSuggestionSessionToken = null;
  let activeSuggestionIndex = -1;
  const closeSuggestions = () => {
    if (searchSuggestions) searchSuggestions.hidden = true;
    if (searchInput) {
      searchInput.setAttribute("aria-expanded", "false");
      searchInput.removeAttribute("aria-activedescendant");
    }
    activeSuggestionIndex = -1;
  };
  const selectSuggestion = async (suggestion) => {
    if (!suggestion?.placeId) return;
    const requestId = ++suggestionRequestId;
    const sessionToken = placeSuggestionSessionToken;
    placeSuggestionSessionToken = null;
    clearTimeout(suggestionTimer);
    closeSuggestions();
    searchInput.value = suggestion.name || suggestion.text || "";
    setSearchStatus("Loading destination…");
    try {
      const data = await window.SidekickCore.apiRequest("/api/maps/place-details", {
        method: "POST", body: JSON.stringify({ placeId: suggestion.placeId, sessionToken }),
      });
      if (requestId !== suggestionRequestId) return;
      const place = toBackendDashboardPlace({ ...(data.place || {}), name: suggestion.name || data.place?.name });
      if (!place.name || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) throw new Error("Destination details are unavailable right now.");
      setSearchStatus("");
      await showDestinationDetails(place, prefs, session);
    } catch (error) {
      if (requestId === suggestionRequestId) {
        const message = error?.message || "Unable to load this destination.";
        setSearchStatus(message === "The server request failed."
          ? "Could not load this place. Restart the backend server and try again."
          : message);
      }
    }
  };
  if (searchInput && searchSuggestions) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim();
      const requestId = ++suggestionRequestId;
      activeSuggestionIndex = -1;
      clearTimeout(suggestionTimer);
      searchSuggestions.replaceChildren();
      closeSuggestions();
      if (query.length < 2) { placeSuggestionSessionToken = null; setSearchStatus(""); return; }
      if (!placeSuggestionSessionToken) {
        placeSuggestionSessionToken = window.crypto?.randomUUID?.()
          || (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14));
      }
      const sessionToken = placeSuggestionSessionToken;
      setSearchStatus("Searching destinations…");
      suggestionTimer = setTimeout(async () => {
        try {
          const data = await window.SidekickCore.apiRequest("/api/maps/place-suggestions", {
            method: "POST", body: JSON.stringify({ input: query, sessionToken }),
          });
          if (requestId !== suggestionRequestId || searchInput.value.trim() !== query) return;
          const suggestions = (data.suggestions || []).filter((item) => item?.placeId && item?.name).slice(0, 6);
          suggestions.forEach((suggestion, index) => {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "destination-search-suggestion";
            option.id = "destination-search-suggestion-" + index;
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", "false");
            option.textContent = suggestion.name;
            option.addEventListener("mousedown", (event) => event.preventDefault());
            option.addEventListener("click", () => { void selectSuggestion(suggestion); });
            searchSuggestions.appendChild(option);
          });
          searchSuggestions.hidden = suggestions.length === 0;
          searchInput.setAttribute("aria-expanded", String(suggestions.length > 0));
          setSearchStatus(suggestions.length ? "" : "No destinations found.");
        } catch (error) {
          if (requestId !== suggestionRequestId) return;
          closeSuggestions();
          setSearchStatus(error?.message || "Unable to load destination suggestions.");
        }
      }, 320);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (searchSuggestions.hidden) return;
      const options = Array.from(searchSuggestions.querySelectorAll(".destination-search-suggestion"));
      if (event.key === "ArrowDown" && options.length) activeSuggestionIndex = (activeSuggestionIndex + 1) % options.length;
      else if (event.key === "ArrowUp" && options.length) activeSuggestionIndex = (activeSuggestionIndex - 1 + options.length) % options.length;
      else if (event.key === "Enter" && options.length) { event.preventDefault(); options[Math.max(0, activeSuggestionIndex)].click(); return; }
      else if (event.key === "Escape") { closeSuggestions(); return; }
      else return;
      event.preventDefault();
      options.forEach((option, index) => {
        const active = index === activeSuggestionIndex;
        option.setAttribute("aria-selected", String(active));
        option.classList.toggle("active", active);
      });
      searchInput.setAttribute("aria-activedescendant", options[activeSuggestionIndex]?.id || "");
    });
    searchInput.addEventListener("blur", () => setTimeout(closeSuggestions, 120));
    document.addEventListener("click", (event) => { if (!event.target.closest(".search-section")) closeSuggestions(); });
  }

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      const target = e.target;
      if (target && target.getAttribute && target.getAttribute("data-close-modal") === "1") closeModal();
    });
  }
});
