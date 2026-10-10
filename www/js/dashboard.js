const GOOGLE_MAPS_API_KEY = (window.SIDEKICK_CONFIG && window.SIDEKICK_CONFIG.googleMapsApiKey) || "YOUR_RESTRICTED_GOOGLE_MAPS_KEY";
const SELECTED_DESTINATION_KEY = "sidekick.selectedDestination.v1";

let _gmapsLoadPromise = null;
let _modalMap = null;
let _marker = null;
let _routePolyline = null;
let _selectedPlace = null;
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
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=geometry`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
  return _gmapsLoadPromise;
}

function buildPreferenceKeywords(prefs, searchQuery = "") {
  if (String(searchQuery || "").trim()) {
    return [String(searchQuery).trim()];
  }

  const byInterest = {
    Beaches: "beach attractions",
    Hiking: "hiking trails",
    "Historical Sites": "historical landmarks",
    "Local Cuisine": "local food market",
    Nightlife: "nightlife district",
    Shopping: "shopping market",
    Photography: "scenic viewpoint",
    "Nature & Wildlife": "nature park",
    Mountains: "mountain attractions",
    "Water Sports": "water sports attractions",
  };

  const byTravelType = {
    "Food Tour": "food spots",
    Adventure: "adventure attractions",
    Cultural: "heritage attractions",
    "Beach & Relaxation": "beach resorts",
    "Nature & Wildlife": "nature attractions",
    "City Exploration": "city attractions",
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

function getPhilippinesSeedLocations() {
  return [
    { lat: 14.5995, lng: 120.9842, name: "Manila" },
    { lat: 10.3157, lng: 123.8854, name: "Cebu" },
    { lat: 7.1907, lng: 125.4553, name: "Davao" },
  ];
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
    museum: "Historical Sites",
    church: "Historical Sites",
    park: "Nature & Wildlife",
    natural_feature: "Nature & Wildlife",
    beach: "Beaches",
    lodging: "Relaxation",
    restaurant: "Local Cuisine",
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
  return attribution.uri
    ? `<small class="photo-attribution"><a href="${window.SidekickCore.escapeHtml(attribution.uri)}" target="_blank" rel="noopener">${label}</a></small>`
    : `<small class="photo-attribution">${label}</small>`;
}

function preferenceScore(place, prefs) {
  const text = `${place.name} ${place.region} ${(place.tags || []).join(" ")}`.toLowerCase();
  let score = (place.rating || 0) * 1.8 + Math.min(3, (place.ratingCount || 0) / 2000);

  const interests = (prefs?.interests || []).map((x) => String(x).toLowerCase());
  const travelTypes = (prefs?.travelTypes || []).map((x) => String(x).toLowerCase());

  for (const i of interests) {
    if (text.includes(i)) score += 3;
  }
  for (const t of travelTypes) {
    if (text.includes(t)) score += 2;
  }

  return score;
}

async function fetchPlacesFromGoogle(prefs, searchQuery = "") {
  const keywords = buildPreferenceKeywords(prefs, searchQuery);
  const seeds = getPhilippinesSeedLocations();

  try {
    const data = await window.SidekickCore.apiRequest("/api/maps/places", {
      method: "POST",
      body: JSON.stringify({ queries: keywords, seeds }),
    });
    const allPlaces = (data.places || []).map(toBackendDashboardPlace)
      .map((place) => ({ ...place, isDevelopmentMock: Boolean(data.isDevelopmentMock) }))
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
    if (allPlaces.length) {
      const recommended = allPlaces
        .slice()
        .sort((a, b) => preferenceScore(b, prefs) - preferenceScore(a, prefs))
        .slice(0, IS_PERF_LITE ? 5 : 8);
      const popularDestinations = allPlaces
        .slice()
        .sort((a, b) => b.rating - a.rating)
        .slice(0, IS_PERF_LITE ? 5 : 8);
      return { recommended, popularDestinations, allPlaces };
    }
  } catch (backendError) {
    throw new Error(backendError?.message || "Google Places is currently unavailable.");
  }
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
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
  const modal = document.getElementById("destination-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

async function showDestinationDetails(place, prefs, session) {
  _selectedPlace = place;
  persistSelectedDestination(place);
  openModal();

  const imageEl = document.getElementById("destination-image");
  if (imageEl) {
    imageEl.innerHTML = place.photoUrl
      ? `<img src="${place.photoUrl}" alt="${window.SidekickCore.escapeHtml(place.name)}" loading="lazy" />`
      : `<div class="destination-photo-fallback">${svgPin()}</div>`;
  }

  setText("destination-title", place.name);
  setText("destination-subtitle", `${place.region}, Philippines${place.isDevelopmentMock ? " • Development sample" : ""}`);
  setText("destination-route-mode", "Enter an origin and calculate a route.");
  setText("destination-route-time", "Unavailable");
  setText("destination-route-distance", "Unavailable");
  setText("destination-route-cost", "Unavailable (no verified fare data)");
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
    _marker = new google.maps.Marker({ map: _modalMap, position: destinationPosition, title: place.name });
    requestAnimationFrame(() => google.maps.event.trigger(_modalMap, "resize"));
  } catch (err) {
    const message = err && err.message === "No API"
      ? "Interactive map is not configured. Add a browser-restricted Google Maps key in www/js/config.local.js."
      : err.message || "Interactive map is unavailable right now.";
    mapEl.innerHTML = `<div class="destination-map-message">${window.SidekickCore.escapeHtml(message)}</div>`;
  }

  const routeButton = document.getElementById("destination-calculate-route");
  if (routeButton) {
    routeButton.onclick = () => calculateDestinationRoute(place);
  }
  const generateBtn = document.getElementById("destination-generate");
  if (generateBtn) {
    generateBtn.onclick = () => generateFocusedItinerary(place, prefs, session);
  }

  async function calculateDestinationRoute(place) {
    const originInput = document.getElementById("destination-origin");
    const modeSelect = document.getElementById("destination-travel-mode");
    const origin = String(originInput?.value || "").trim();
    const travelMode = modeSelect?.value || "DRIVE";
    if (!origin) {
      setText("destination-route-mode", "Enter your starting location to calculate this route.");
      setText("destination-route-time", "Unavailable");
      setText("destination-route-distance", "Unavailable");
      if (routeError) routeError.hidden = true;
      return;
    }
    const button = document.getElementById("destination-calculate-route");
    if (button) button.disabled = true;
    setText("destination-route-mode", "Calculating route...");
    setText("destination-route-time", "Calculating...");
    setText("destination-route-distance", "Calculating...");
    setText("destination-route-cost", "Unavailable (fare data is not provided by Routes API)");
    if (routeError) routeError.hidden = true;
    try {
      const response = await window.SidekickCore.apiRequest("/api/maps/route", {
        method: "POST",
        body: JSON.stringify({
          origin: { address: origin },
          destination: { placeId: place.placeId, lat: place.lat, lng: place.lng, address: place.address, name: place.name },
          travelMode,
        }),
      });
      const route = response.route;
      setText("destination-route-mode", `${route.travelMode}${response.isDevelopmentMock ? " (development estimate)" : ""}`);
      setText("destination-route-time", `${route.durationMinutes} min`);
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
      setText("destination-route-time", "Unavailable");
      setText("destination-route-distance", "Unavailable");
      setText("destination-route-cost", "Unavailable");
      if (routeError) {
        routeError.hidden = false;
        setText("destination-route-error-message", "The route could not be retrieved. Check your Google Routes API setup and try again.");
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
      window.location.href = "chat.html";
    };
  }
}

async function generateFocusedItinerary(place, prefs, session) {
  if (!session?.email || !place?.name) return;
  const button = document.getElementById("destination-generate");
  if (button) {
    button.disabled = true;
    button.textContent = "Verifying itinerary...";
  }
  try {
    const response = await window.SidekickCore.apiRequest("/api/itinerary/generate", {
      method: "POST",
      body: JSON.stringify({
        email: session.email,
        message: `Plan a practical trip to ${place.name}. Use my saved preferences and suggest a balanced itinerary.`,
        selectedDestination: { name: place.name, placeId: place.placeId, lat: place.lat, lng: place.lng },
        profile: {
          ...(prefs || {}),
          preferredPlaces: [place.name, ...(prefs?.preferredPlaces || [])],
          startDate: new Date().toISOString().slice(0, 10),
        },
      }),
    });
    if (!Array.isArray(response.itinerary)) throw new Error("The itinerary service returned no itinerary.");
    const byEmail = window.SidekickCore.getItineraryByEmail();
    byEmail[session.email] = {
      itinerary: response.itinerary,
      meta: {
        ...(response.meta || {}),
        focusedPlace: place.name,
        startDate: response.meta?.startDate || new Date().toISOString(),
      },
    };
    window.SidekickCore.setItineraryByEmail(byEmail);
    window.location.href = "itinerary.html";
  } catch (error) {
    setSearchStatus(error.message || "Unable to generate a verified itinerary.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Generate itinerary for this place";
    }
  }
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
  const rec = recommended.filter((p) => placeMatches(p, q)).slice(0, IS_PERF_LITE ? 4 : 6);
  const pop = popular.filter((p) => placeMatches(p, q)).slice(0, IS_PERF_LITE ? 4 : 6);

  recommendedRow.innerHTML = rec.map(renderPlaceCard).join("");
  destinationsGrid.innerHTML = pop.map(renderDestinationCard).join("");

  if (!IS_PERF_LITE) {
    [...recommendedRow.children].forEach((child, idx) => {
      child.style.animationDelay = `${idx * 40}ms`;
      child.style.animation = "cardIn 420ms ease both";
    });
    [...destinationsGrid.children].forEach((child, idx) => {
      child.style.animationDelay = `${idx * 35}ms`;
      child.style.animation = "cardIn 420ms ease both";
    });
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
  const closeBtn = document.getElementById("destination-close");
  const modal = document.getElementById("destination-modal");

  if (nameEl) nameEl.textContent = session.name || "Traveler";

  let recommended = [];
  let popular = [];

  // Render local recommendations first for faster first paint on mobile.
  const initial = window.SidekickCore.buildDashboardRecommendations(prefs);
  recommended = initial.recommended;
  popular = initial.popularDestinations;
  renderDestinationLists(recommended, popular, "", prefs, session);

  try {
    const model = await fetchPlacesFromGoogle(prefs, "");
    if (model.recommended.length) recommended = model.recommended;
    if (model.popularDestinations.length) popular = model.popularDestinations;
  } catch (e) {
    // Keep local recommendations already rendered.
  }

  renderDestinationLists(recommended, popular, "", prefs, session);

  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value || "";
      clearTimeout(searchTimer);
      renderDestinationLists(recommended, popular, q, prefs, session);

      if (normalizeQuery(q).length >= 3) {
        setSearchStatus("Searching places...");
        searchTimer = setTimeout(async () => {
          try {
            const dynamic = await fetchPlacesFromGoogle(prefs, q);
            if (dynamic.recommended.length || dynamic.popularDestinations.length) {
              recommended = dynamic.recommended;
              popular = dynamic.popularDestinations;
              renderDestinationLists(recommended, popular, q, prefs, session);
              setSearchStatus("");
            } else {
              setSearchStatus("No places found. Try a different search.");
            }
          } catch (e) {
            setSearchStatus(e?.message || "Unable to load places right now. Please try again.");
          }
        }, 380);
      } else if (!normalizeQuery(q)) {
        setSearchStatus("");
      }
    });
  }

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      const target = e.target;
      if (target && target.getAttribute && target.getAttribute("data-close-modal") === "1") closeModal();
    });
  }
});
