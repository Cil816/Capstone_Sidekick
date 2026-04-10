const GOOGLE_MAPS_API_KEY = "YOUR_GOOGLE_MAPS_API_KEY_HERE";

let _gmapsLoadPromise = null;
let _placesService = null;
let _modalMap = null;
let _marker = null;
let _directionsService = null;
let _directionsRenderer = null;
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

function budgetMultiplier(budget) {
  if (budget === "Budget-Friendly") return 0.85;
  if (budget === "Luxury") return 1.35;
  if (budget === "Ultra Luxury") return 1.8;
  return 1;
}

function estimateModeByDistanceKm(distanceKm) {
  if (distanceKm <= 8) return "Walk / Tricycle";
  if (distanceKm <= 35) return "Jeepney / Grab";
  if (distanceKm <= 180) return "Bus / Van";
  if (distanceKm <= 480) return "Bus + Ferry";
  return "Flight + Local Transfer";
}

function estimateCostByDistance(distanceKm, budget) {
  let base;
  if (distanceKm <= 8) base = 80;
  else if (distanceKm <= 35) base = 90 + distanceKm * 25;
  else if (distanceKm <= 180) base = 120 + distanceKm * 4.8;
  else if (distanceKm <= 480) base = 350 + distanceKm * 3.9;
  else base = 1800 + distanceKm * 5.2;
  return Math.round(base * budgetMultiplier(budget));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function getDefaultOriginCoord() {
  return { lat: 14.5995, lng: 120.9842, label: "Manila" };
}

function getCurrentLocationCoord() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(getDefaultOriginCoord());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Your current location" }),
      () => resolve(getDefaultOriginCoord()),
      { timeout: 3500, maximumAge: 600000 }
    );
  });
}

function ensureGoogleMapsLoaded() {
  if (_gmapsLoadPromise) return _gmapsLoadPromise;
  _gmapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.places) {
      resolve();
      return;
    }
    if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY_HERE") {
      reject(new Error("Google Maps API key is not configured"));
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
  return _gmapsLoadPromise;
}

function ensurePlacesService() {
  if (_placesService) return _placesService;
  const holder = document.createElement("div");
  _placesService = new google.maps.places.PlacesService(holder);
  return _placesService;
}

function textSearchAsync(service, request) {
  return new Promise((resolve) => {
    service.textSearch(request, (results, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && Array.isArray(results)) {
        resolve(results);
      } else {
        resolve([]);
      }
    });
  });
}

function buildPreferenceKeywords(prefs, searchQuery = "") {
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
  await ensureGoogleMapsLoaded();
  const service = ensurePlacesService();
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  const maxKeywordCount = IS_PERF_LITE ? 1 : isMobile ? 2 : 4;
  const maxSeedCount = IS_PERF_LITE ? 1 : isMobile ? 2 : 3;
  const keywords = buildPreferenceKeywords(prefs, searchQuery).slice(0, maxKeywordCount);
  const seeds = getPhilippinesSeedLocations().slice(0, maxSeedCount);

  const jobs = [];
  for (const keyword of keywords) {
    for (const seed of seeds) {
      jobs.push(
        textSearchAsync(service, {
          query: `${keyword} in Philippines`,
          location: new google.maps.LatLng(seed.lat, seed.lng),
          radius: 250000,
          region: "ph",
        })
      );
    }
  }

  const results = await Promise.all(jobs.slice(0, IS_PERF_LITE ? 3 : jobs.length));
  const allRaw = results.flat();

  const dedup = new Map();
  for (const g of allRaw) {
    if (!g || !g.place_id || !g.geometry || !g.geometry.location) continue;
    if (!dedup.has(g.place_id)) dedup.set(g.place_id, toDashboardPlace(g));
  }

  const allPlaces = Array.from(dedup.values()).filter((p) => p.lat && p.lng);
  const recommended = allPlaces
    .slice()
    .sort((a, b) => preferenceScore(b, prefs) - preferenceScore(a, prefs))
    .slice(0, IS_PERF_LITE ? 5 : 8);

  const popularDestinations = allPlaces
    .slice()
    .sort((a, b) => (b.rating * 1000 + b.ratingCount) - (a.rating * 1000 + a.ratingCount))
    .slice(0, IS_PERF_LITE ? 5 : 8);

  return { recommended, popularDestinations, allPlaces };
}

function renderPlaceCard(place) {
  const safeName = window.SidekickCore.escapeHtml(place.name);
  const safeRegion = window.SidekickCore.escapeHtml(place.region);
  const imgPart = place.photoUrl
    ? `<img src="${place.photoUrl}" alt="${safeName}" loading="lazy" />`
    : svgPin();
  return `
    <div class="place-card" data-place-id="${window.SidekickCore.escapeHtml(place.placeId)}">
      <div class="place-image">${imgPart}</div>
      <div class="place-info">
        <h3>${safeName}</h3>
        <p>${safeRegion}</p>
      </div>
    </div>
  `;
}

function renderDestinationCard(place) {
  const safeName = window.SidekickCore.escapeHtml(place.name);
  const safeRegion = window.SidekickCore.escapeHtml(place.region);
  const imgPart = place.photoUrl
    ? `<img src="${place.photoUrl}" alt="${safeName}" loading="lazy" />`
    : svgPin();
  return `
    <div class="destination-card" data-place-id="${window.SidekickCore.escapeHtml(place.placeId)}">
      <div class="destination-image">${imgPart}</div>
      <div class="destination-info">
        <h3>${safeName}</h3>
        <p>${safeRegion}</p>
      </div>
    </div>
  `;
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
  openModal();

  setText("destination-title", place.name);
  setText("destination-subtitle", `${place.region}, Philippines`);
  setText("destination-route-mode", "Calculating...");
  setText("destination-route-time", "Calculating...");
  setText("destination-route-distance", "Calculating...");
  setText("destination-route-cost", "Calculating...");

  const tagsEl = document.getElementById("destination-tags");
  if (tagsEl) {
    tagsEl.innerHTML = (place.tags || [])
      .slice(0, 5)
      .map((tag) => `<span class="tag">${window.SidekickCore.escapeHtml(tag)}</span>`)
      .join("");
  }

  const mapEl = document.getElementById("destination-map");
  if (!mapEl) return;
  mapEl.textContent = "Loading map...";

  const origin = await getCurrentLocationCoord();

  try {
    await ensureGoogleMapsLoaded();

    _modalMap = new google.maps.Map(mapEl, {
      center: { lat: place.lat, lng: place.lng },
      zoom: 8,
      disableDefaultUI: true,
    });

    _marker = new google.maps.Marker({
      map: _modalMap,
      position: { lat: place.lat, lng: place.lng },
      title: place.name,
    });

    _directionsService = new google.maps.DirectionsService();
    _directionsRenderer = new google.maps.DirectionsRenderer({
      map: _modalMap,
      suppressMarkers: false,
      preserveViewport: false,
      polylineOptions: { strokeColor: "#6B8CAE", strokeWeight: 5 },
    });

    const result = await _directionsService.route({
      origin: { lat: origin.lat, lng: origin.lng },
      destination: { lat: place.lat, lng: place.lng },
      travelMode: google.maps.TravelMode.DRIVING,
    });

    _directionsRenderer.setDirections(result);

    const leg = result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs[0];
    if (leg) {
      const distanceKm = Math.max(1, Math.round((leg.distance && leg.distance.value ? leg.distance.value : 0) / 1000));
      const durationMin = Math.max(5, Math.round((leg.duration && leg.duration.value ? leg.duration.value : 0) / 60));
      const mode = estimateModeByDistanceKm(distanceKm);
      const cost = estimateCostByDistance(distanceKm, prefs && prefs.budget ? prefs.budget : "Mid-Range");

      setText("destination-route-mode", `${mode} (${origin.label} to ${place.name})`);
      setText("destination-route-time", `${durationMin} min`);
      setText("destination-route-distance", `${distanceKm} km`);
      setText("destination-route-cost", `~PHP ${cost.toLocaleString()}`);
    }
  } catch (err) {
    const mode = estimateModeByDistanceKm(120);
    const cost = estimateCostByDistance(120, prefs && prefs.budget ? prefs.budget : "Mid-Range");
    mapEl.innerHTML = "Google Maps unavailable. Add your API key in dashboard.js to view live route map and destinations.";
    setText("destination-route-mode", mode);
    setText("destination-route-time", "about 3-5 hours");
    setText("destination-route-distance", "estimated");
    setText("destination-route-cost", `~PHP ${cost.toLocaleString()}`);
  }

  const generateBtn = document.getElementById("destination-generate");
  if (generateBtn) {
    generateBtn.onclick = () => generateFocusedItinerary(place, prefs, session);
  }
}

function generateFocusedItinerary(place, prefs, session) {
  if (!session || !session.email) return;

  const currentPrefs = prefs || {};
  const preferredPlaces = Array.isArray(currentPrefs.preferredPlaces) ? currentPrefs.preferredPlaces.slice() : [];
  const boosted = Array.from(new Set([place.name, place.region, ...preferredPlaces]));
  const tempPrefs = Object.assign({}, currentPrefs, { preferredPlaces: boosted });

  const generated = window.SidekickCore.generateItinerary(tempPrefs, { startDate: new Date() });
  if (generated && generated.itinerary && generated.itinerary[0] && generated.itinerary[0].activities && generated.itinerary[0].activities[0]) {
    generated.itinerary[0].activities[0].title = `Start your trip at ${place.name}`;
    generated.itinerary[0].activities[0].location = `${place.name}, ${place.region}`;
    generated.itinerary[0].activities[0].note = `Focused destination plan based on your preferences and budget capability (${tempPrefs.budget || "Mid-Range"}).`;
    generated.itinerary[0].activities[0].locationCoords = { lat: place.lat, lng: place.lng };
  }

  const itineraryData = {
    itinerary: generated.itinerary,
    meta: { ...generated.meta, startDate: new Date().toISOString(), focusedPlace: place.name },
  };

  const byEmail = window.SidekickCore.getItineraryByEmail();
  byEmail[session.email] = itineraryData;
  window.SidekickCore.setItineraryByEmail(byEmail);

  try {
    if (window.SidekickCore && window.SidekickCore.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(session.email);
    if (window.SidekickCore && window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(session.email);
  } catch (e) {}

  window.location.href = "itinerary.html";
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

      if (!IS_PERF_LITE && normalizeQuery(q).length >= 3) {
        searchTimer = setTimeout(async () => {
          try {
            const dynamic = await fetchPlacesFromGoogle(prefs, q);
            if (dynamic.recommended.length || dynamic.popularDestinations.length) {
              recommended = dynamic.recommended;
              popular = dynamic.popularDestinations;
              renderDestinationLists(recommended, popular, q, prefs, session);
            }
          } catch (e) {
            // ignore live search failures and keep current list
          }
        }, 380);
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
