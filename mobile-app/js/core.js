// Capacitor WebView localStorage persistence fix
(function() {
    if (typeof window === 'undefined') return;
    
    const _set = Storage.prototype.setItem;
    const _remove = Storage.prototype.removeItem;
    
    Storage.prototype.setItem = function(key, value) {
        try {
            _set.call(this, key, value);
            // Also store in sessionStorage as backup
        if (this === localStorage) _set.call(sessionStorage, key, value);
        } catch(e) {}
    };
    
    Storage.prototype.removeItem = function(key) {
        try {
            _remove.call(this, key);
        if (this === localStorage) _remove.call(sessionStorage, key);
        } catch(e) {}
    };
    
    // Restore from sessionStorage if localStorage is empty
    function restoreFromSession() {
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('sidekick.') && !localStorage.getItem(key)) {
                    localStorage.setItem(key, sessionStorage.getItem(key));
                }
            }
        } catch(e) {}
    }
    
    restoreFromSession();
})();

/* Sidekick Core (no backend): auth, user preferences, itinerary + chat generation */

window.SIDEKICK_CONFIG = {
  apiMode: "production",
  googleMapsApiKey: "",
  ...(window.SIDEKICK_CONFIG || {}),
};

const SIDEKICK_KEYS = {
  users: "sidekick.users.v1",
  auth: "sidekick.auth.v1",
  preferencesByEmail: "sidekick.preferencesByEmail.v1",
  chatByEmail: "sidekick.chatByEmail.v1",
  itineraryByEmail: "sidekick.itineraryByEmail.v1",
  remindersByEmail: "sidekick.remindersByEmail.v1",
  notificationPrefsByEmail: "sidekick.notificationPrefs",
};
const itinerarySyncStates = new Map();
const itineraryMonitoringPromises = new Map();

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function getUsers() {
  return safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.users), []);
}

function setUsers(users) {
  localStorage.setItem(SIDEKICK_KEYS.users, JSON.stringify(users));
}

function getAuthSession() {
  return safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.auth), null);
}

function setAuthSession(session) {
  localStorage.setItem(SIDEKICK_KEYS.auth, JSON.stringify(session));
}

function clearAuthSession() {
  localStorage.removeItem(SIDEKICK_KEYS.auth);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getPreferencesByEmail() {
  return safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.preferencesByEmail), {});
}

function setPreferencesForEmail(email, prefs) {
  const all = getPreferencesByEmail();
  all[email] = prefs;
  localStorage.setItem(SIDEKICK_KEYS.preferencesByEmail, JSON.stringify(all));
  void syncPreferencesToServer(email, prefs);
}

// Saves the user's travel preferences to their account so the admin website shows
// the same preferences the app uses. Skips the request when nothing changed.
const PREFS_SYNCED_KEY = "sidekick.prefsSynced.v1";
const preferenceSyncsInFlight = new Map();
function syncPreferencesToServer(email, prefs) {
  const session = getAuthSession();
  if (!email || !prefs || !session?.apiToken || normalizeEmail(session.email) !== normalizeEmail(email)) return Promise.resolve(false);
  const payload = {
    travelTypes: Array.isArray(prefs.travelTypes) ? prefs.travelTypes : [],
    interests: Array.isArray(prefs.interests) ? prefs.interests : [],
    preferredPlaces: Array.isArray(prefs.preferredPlaces) ? prefs.preferredPlaces : [],
  };
  const snapshot = JSON.stringify(payload);
  const synced = safeJsonParse(localStorage.getItem(PREFS_SYNCED_KEY), {});
  if (synced[email] === snapshot) return Promise.resolve(true);
  if (preferenceSyncsInFlight.get(email)?.snapshot === snapshot) return preferenceSyncsInFlight.get(email).request;
  const request = apiRequest(`/api/preferences/${encodeURIComponent(email)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  }).then(() => {
    const latest = safeJsonParse(localStorage.getItem(PREFS_SYNCED_KEY), {});
    latest[email] = snapshot;
    localStorage.setItem(PREFS_SYNCED_KEY, JSON.stringify(latest));
    return true;
  }).catch((error) => {
    console.warn("Unable to save preferences to your account:", error.message);
    return false;
  }).finally(() => {
    if (preferenceSyncsInFlight.get(email)?.request === request) preferenceSyncsInFlight.delete(email);
  });
  preferenceSyncsInFlight.set(email, { snapshot, request });
  return request;
}

function resetPreferencesForEmail(email) {
  const all = getPreferencesByEmail();
  delete all[email];
  localStorage.setItem(SIDEKICK_KEYS.preferencesByEmail, JSON.stringify(all));
}

// ---- Fresh onboarding for a re-created account ------------------------------
// Deleting an account removes its preferences on the server, but this device keeps
// its own copy keyed by email. A new account with the same email gets a new user ID,
// so a changed ID (or a registration) means that copy is stale and is cleared.
const ACCOUNT_ID_KEY = "sidekick.accountIdByEmail.v1";

function deleteEmailEntries(storageKey, email) {
  const target = normalizeEmail(email);
  const all = safeJsonParse(localStorage.getItem(storageKey), {});
  if (!all || typeof all !== "object") return;
  let changed = false;
  for (const key of Object.keys(all)) {
    if (normalizeEmail(key) === target) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) localStorage.setItem(storageKey, JSON.stringify(all));
}

// Removes this email's saved onboarding answers so onboarding starts fresh,
// including the "already synced" marker so new answers are always sent to the server.
function clearOnboardingStateForEmail(email) {
  if (!normalizeEmail(email)) return;
  try {
    deleteEmailEntries(SIDEKICK_KEYS.preferencesByEmail, email);
    deleteEmailEntries(PREFS_SYNCED_KEY, email);
    for (const key of [...preferenceSyncsInFlight.keys()]) {
      if (normalizeEmail(key) === normalizeEmail(email)) preferenceSyncsInFlight.delete(key);
    }
    localStorage.removeItem("userPreferences"); // legacy key, also cleared by Settings' reset
  } catch (error) {}
  try { sessionStorage.removeItem("sidekick.onboarding.v1"); } catch (error) {}
}

// Call after the server confirms a sign-in or registration. newAccount: true right
// after registering. Returns true when this email's onboarding answers were cleared.
function recordAccountForEmail(email, userId, { newAccount = false } = {}) {
  const normalized = normalizeEmail(email);
  const id = Number(userId);
  if (!normalized) return false;
  let ids = {};
  try { ids = safeJsonParse(localStorage.getItem(ACCOUNT_ID_KEY), {}) || {}; } catch (error) { ids = {}; }
  const previous = Number(ids[normalized]);
  const validId = Number.isSafeInteger(id) && id > 0;
  const recreated = newAccount || (validId && Number.isSafeInteger(previous) && previous > 0 && previous !== id);
  if (recreated) clearOnboardingStateForEmail(email);
  if (validId) {
    ids[normalized] = id;
    try { localStorage.setItem(ACCOUNT_ID_KEY, JSON.stringify(ids)); } catch (error) {}
  }
  return recreated;
}

function forgetAccountForEmail(email) {
  try { deleteEmailEntries(ACCOUNT_ID_KEY, email); } catch (error) {}
}

function getPreferences() {
  const session = getAuthSession();
  if (!session?.email) return null;
  const all = getPreferencesByEmail();
  return all[session.email] ?? null;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

async function hashPasswordSHA256(password) {
  const pwd = String(password);

  // Prefer WebCrypto when available (typical for HTTPS/local secure contexts).
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const encoder = new TextEncoder();
      const data = encoder.encode(pwd);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const bytes = Array.from(new Uint8Array(digest));
      return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  // Fallback: deterministic non-cryptographic hash for local demos.
  // This keeps login functional if WebCrypto is blocked by the browser context.
  function fnv1a32(input, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  const h1 = fnv1a32(pwd, 0x811c9dc5);
  const h2 = fnv1a32(pwd.split("").reverse().join("") + pwd.length, 0x9e3779b9);
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function getApiBaseUrl() {
  const config = window.SIDEKICK_CONFIG || {};
  const configuredBase = String(config.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const apiMode = String(config.apiMode || "production").trim().toLowerCase();
  if (configuredBase) {
    const parsedBase = new URL(configuredBase);
    const localHttpHosts = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);
    const isLocalHttp = parsedBase.protocol === "http:" && localHttpHosts.has(parsedBase.hostname);
    if (apiMode !== "development" && !/^https:\/\//i.test(configuredBase) && !isLocalHttp) {
      throw new Error("Production SIDEKICK_CONFIG.apiBaseUrl must use HTTPS.");
    }
    return configuredBase;
  }

  if (apiMode !== "development") {
    if (window.Capacitor?.isNativePlatform?.()) {
      throw new Error("Configure SIDEKICK_CONFIG.apiBaseUrl with the HTTPS backend URL for production mobile builds.");
    }
    return "";
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  const isLocalDevelopment = window.location.protocol === "file:"
    || localHosts.has(window.location.hostname);
  const isAndroidApp = /Android/i.test(navigator.userAgent) && window.location.protocol === "https:";
  if (isAndroidApp) return "http://10.0.2.2:3001";
  return isLocalDevelopment ? "http://localhost:3001" : "";
}

async function apiRequest(path, options = {}) {
  const apiBaseUrl = getApiBaseUrl();
  const sessionToken = String(getAuthSession()?.apiToken || "");
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Unable to connect to the Sidekick server. Check the API server address and your connection.");
  }

  const responseText = await response.text();
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    // Use the HTTP status below rather than exposing an HTML error page.
  }
  if (!response.ok) {
    if (payload.maintenance === true) showMaintenanceBanner(payload.error);
    const message = typeof payload.error === "string" && payload.error.trim()
      ? payload.error
      : response.status === 404
        ? `The configured server does not provide this API endpoint (HTTP 404): ${path}. Deploy the current Sidekick backend and set SIDEKICK_CONFIG.apiBaseUrl to its public URL.`
        : `The Sidekick server returned HTTP ${response.status} for ${path}.`;
    const error = new Error(message);
    error.statusCode = response.status;
    if (response.status === 401 && sessionToken && !window.location.pathname.endsWith("/login.html")) {
      invalidateAppSession(sessionToken);
    }
    throw error;
  }
  return payload;
}

// Shown on every screen while the backend is in maintenance mode.
function showMaintenanceBanner(message) {
  if (!document.body) return;
  let banner = document.getElementById("maintenance-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "maintenance-banner";
    banner.className = "maintenance-banner";
    banner.setAttribute("role", "status");
    document.body.prepend(banner);
  }
  banner.textContent = String(message || "").trim()
    || "Sidekick is under maintenance right now. Please try again later.";
}

async function checkMaintenanceStatus() {
  try {
    const status = await apiRequest("/api/maintenance-status");
    if (status?.maintenance) showMaintenanceBanner(status.message);
  } catch (error) {
    // Older backend or offline: nothing to show.
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { void checkMaintenanceStatus(); }, { once: true });
} else {
  void checkMaintenanceStatus();
}

let appSessionInvalidationInProgress = false;

function invalidateAppSession(rejectedToken) {
  if (appSessionInvalidationInProgress) return;
  const currentSession = getAuthSession();
  if (!currentSession?.apiToken || currentSession.apiToken !== rejectedToken) return;
  appSessionInvalidationInProgress = true;
  clearAuthSession();
  window.location.replace("login.html?session=expired");
}

function redirect(path) {
  window.location.href = path;
}

function requireAuth() {
  const session = getAuthSession();
  if (!session?.email) {
    redirect("login.html");
    return null;
  }
  return session;
}

function requirePreferences() {
  const prefs = getPreferences();
  if (!prefs) {
    redirect("onboarding.html");
    return null;
  }
  return prefs;
}

function getChatByEmail() {
  return safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.chatByEmail), {});
}

function setChatByEmail(map) {
  localStorage.setItem(SIDEKICK_KEYS.chatByEmail, JSON.stringify(map));
}

function clearChatForEmail(email) {
  const map = getChatByEmail();
  delete map[email];
  setChatByEmail(map);
}

function getItineraryByEmail() {
  return safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.itineraryByEmail), {});
}

function getItinerarySyncPayload(itineraryData) {
  const meta = itineraryData?.meta || {};
  return {
    itinerary: (Array.isArray(itineraryData?.itinerary) ? itineraryData.itinerary : []).map((day, index) => ({
      dayNumber: Number(day?.dayNumber) || index + 1,
      title: day?.title || null,
      activities: (Array.isArray(day?.activities) ? day.activities : []).map((activity) => ({
        title: activity?.title || "",
        location: activity?.location || "",
        category: activity?.category || activity?.activityType || "",
        timeLabel: activity?.timeLabel || "",
        startTime: activity?.dueAt != null && Number.isFinite(Number(activity.dueAt))
          ? `${String(new Date(Number(activity.dueAt)).getHours()).padStart(2, "0")}:${String(new Date(Number(activity.dueAt)).getMinutes()).padStart(2, "0")}`
          : "",
        estimatedTotalCostPhp: activity?.estimatedTotalCostPhp ?? activity?.estimatedActivityCostPhp ?? null,
      })),
    })),
    meta: {
      destination: meta.destination || meta.focusedPlace || "",
      startDate: String(meta.startDate || new Date().toISOString()).slice(0, 10),
      endDate: meta.endDate ? String(meta.endDate).slice(0, 10) : "",
      budget: meta.budget || "",
      title: meta.title ? String(meta.title).slice(0, 200) : "",
    },
  };
}

function ensureItineraryMonitored(email, itineraryData) {
  const currentTripId = Number(itineraryData?.meta?.serverTripId);
  if (Number.isSafeInteger(currentTripId) && currentTripId > 0) {
    return Promise.resolve({ ...itineraryData, meta: { ...itineraryData.meta, serverTripId: currentTripId } });
  }
  const key = `${email}:${JSON.stringify(getItinerarySyncPayload(itineraryData))}`;
  const pending = itineraryMonitoringPromises.get(key);
  if (pending) return pending;

  const request = (async () => {
    const result = await apiRequest("/api/app-itineraries/sync", {
      method: "POST",
      body: JSON.stringify(getItinerarySyncPayload(itineraryData)),
    });
    const monitored = {
      ...itineraryData,
      meta: { ...itineraryData.meta, serverTripId: result.tripId },
    };
    const map = getItineraryByEmail();
    if (JSON.stringify(map[email]) === JSON.stringify(itineraryData)) {
      map[email] = monitored;
      const state = itinerarySyncStates.get(Number(result.tripId))
        || { lastSynced: "", timer: null, inFlight: false, attempts: 0 };
      state.lastSynced = JSON.stringify(getItinerarySyncPayload(monitored));
      itinerarySyncStates.set(Number(result.tripId), state);
      setItineraryByEmail(map);
    }
    return monitored;
  })();
  itineraryMonitoringPromises.set(key, request);
  request.finally(() => {
    if (itineraryMonitoringPromises.get(key) === request) itineraryMonitoringPromises.delete(key);
  }).catch(() => {});
  return request;
}

function reportItinerarySyncError(error, tripId) {
  console.error("Unable to sync itinerary changes to the server:", error);
  document.dispatchEvent(new CustomEvent("sidekick:itinerary-sync-error", {
    detail: { tripId, message: error?.message || "The itinerary could not be synced to the server." },
  }));
}

function scheduleItinerarySync(email, itineraryData, delay = 500) {
  const tripId = Number(itineraryData?.meta?.serverTripId);
  if (!email || !Number.isSafeInteger(tripId) || tripId < 1) return;
  const state = itinerarySyncStates.get(tripId) || { lastSynced: "", timer: null, inFlight: false, attempts: 0 };
  itinerarySyncStates.set(tripId, state);
  if (state.deleting) return;
  const payload = getItinerarySyncPayload(itineraryData);
  const snapshot = JSON.stringify(payload);
  if (snapshot === state.lastSynced) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = window.setTimeout(async () => {
    state.timer = null;
    if (state.inFlight) return;
    const current = getItineraryByEmail()[email];
    if (Number(current?.meta?.serverTripId) !== tripId) return;
    const latestPayload = getItinerarySyncPayload(current);
    const latestSnapshot = JSON.stringify(latestPayload);
    if (latestSnapshot === state.lastSynced) return;

    state.inFlight = true;
    try {
      await apiRequest(`/api/app-itineraries/${encodeURIComponent(tripId)}`, {
        method: "PUT",
        body: JSON.stringify(latestPayload),
      });
      state.lastSynced = latestSnapshot;
      state.attempts = 0;
    } catch (error) {
      state.attempts += 1;
      if (state.attempts < 3) {
        state.timer = window.setTimeout(() => scheduleItinerarySync(email, current, 1000 * state.attempts), 1000 * state.attempts);
      } else {
        state.attempts = 0;
        reportItinerarySyncError(error, tripId);
      }
    } finally {
      state.inFlight = false;
      const latest = getItineraryByEmail()[email];
      if (Number(latest?.meta?.serverTripId) === tripId
        && JSON.stringify(getItinerarySyncPayload(latest)) !== state.lastSynced
        && !state.timer) {
        scheduleItinerarySync(email, latest);
      }
    }
  }, delay);
}

function setItineraryByEmail(map) {
  const priorMap = getItineraryByEmail();
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  const session = getAuthSession();
  const email = session?.email;
  if (email && JSON.stringify(priorMap[email]) !== JSON.stringify(map?.[email]) && map?.[email]) {
    scheduleItinerarySync(email, map[email]);
  }
  try {
    document.dispatchEvent(new CustomEvent('sidekick:itinerary-updated'));
  } catch (e) {}
}

async function clearItineraryForEmail(email) {
  let map = getItineraryByEmail();
  let itineraryData = map[email];
  if (itineraryData?.itinerary?.length && !itineraryData.meta?.serverTripId) {
    itineraryData = await ensureItineraryMonitored(email, itineraryData);
    map = getItineraryByEmail();
    if (map[email]?.meta?.serverTripId) itineraryData = map[email];
  }
  const tripId = Number(itineraryData?.meta?.serverTripId);
  if (Number.isSafeInteger(tripId) && tripId > 0) {
    const state = itinerarySyncStates.get(tripId) || { lastSynced: "", timer: null, inFlight: false, attempts: 0 };
    state.deleting = true;
    itinerarySyncStates.set(tripId, state);
    if (state?.timer) clearTimeout(state.timer);
    while (state?.inFlight) await new Promise((resolve) => window.setTimeout(resolve, 50));
    if (state.timer) clearTimeout(state.timer);
    try {
      await apiRequest(`/api/app-itineraries/${encodeURIComponent(tripId)}`, { method: "DELETE" });
    } catch (error) {
      state.deleting = false;
      throw error;
    }
    itinerarySyncStates.delete(tripId);
  }
  delete map[email];
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  try {
    document.dispatchEvent(new CustomEvent('sidekick:itinerary-updated'));
  } catch (e) {}
}

function clearExpiredItineraryForEmail(email, expectedTripId = null, expectedItinerary = null) {
  const map = getItineraryByEmail();
  const current = map[email];
  if (!current) return false;
  const currentTripId = Number(current.meta?.serverTripId);
  if (expectedTripId !== null && currentTripId !== Number(expectedTripId)) return false;
  if (expectedTripId === null && Number.isSafeInteger(currentTripId) && currentTripId > 0) return false;
  if (expectedItinerary && JSON.stringify(current) !== JSON.stringify(expectedItinerary)) return false;

  if (Number.isSafeInteger(currentTripId) && currentTripId > 0) {
    const state = itinerarySyncStates.get(currentTripId);
    if (state?.timer) clearTimeout(state.timer);
    itinerarySyncStates.delete(currentTripId);
  }
  delete map[email];
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  window.SidekickCore?.clearItineraryRemindersForEmail?.(email);
  document.dispatchEvent(new CustomEvent('sidekick:itinerary-updated', { detail: { email } }));
  if (window.location.pathname.endsWith('/itinerary.html')) {
    window.setTimeout(() => window.location.reload(), 0);
  }
  return true;
}

function getNotificationPreferences(email) {
  const prefs = safeJsonParse(localStorage.getItem(`${SIDEKICK_KEYS.notificationPrefsByEmail}.${email}`), {});
  return {
    enabled: prefs.enabled !== false,
    soundEnabled: prefs.soundEnabled !== false,
    vibrationEnabled: prefs.vibrationEnabled !== false,
    ...prefs,
  };
}

function setNotificationPreferences(email, prefs) {
  localStorage.setItem(`${SIDEKICK_KEYS.notificationPrefsByEmail}.${email}`, JSON.stringify(prefs));
}

function clearRemindersForEmail(email) {
  const all = safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.remindersByEmail), {});
  delete all[email];
  localStorage.setItem(SIDEKICK_KEYS.remindersByEmail, JSON.stringify(all));
  try {
    document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email } }));
  } catch (e) {}
}

function formatDateRange(startDate, dayCount) {
  const end = new Date(startDate);
  end.setDate(end.getDate() + (dayCount - 1));
  const fmt = { month: "short", day: "numeric", year: "numeric" };
  return `${startDate.toLocaleDateString([], fmt)} - ${end.toLocaleDateString([], fmt)}`;
}

function pickWeighted(items, weightFn, rng = Math.random) {
  const weights = items.map((x) => Math.max(0, Number(weightFn(x)) || 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return items[Math.floor(rng() * items.length)];
  let roll = rng() * sum;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

const INTEREST_KEYWORDS = [
  { interest: "Beaches", words: ["beach", "island", "coron", "boracay", "el nido", "palawan"] },
  { interest: "Water Sports", words: ["snorkel", "scuba", "kayak", "water", "diving", "boat"] },
  { interest: "Island Hopping", words: ["hop", "hopping", "cruise", "tour"] },
  { interest: "Mountains", words: ["mountain", "hike", "hiking", "banaue", "rice terraces", "scenery"] },
  { interest: "Hiking", words: ["trail", "hiking", "trek", "walk"] },
  { interest: "Historical Sites", words: ["history", "museum", "intramuros", "heritage"] },
  { interest: "Local Cuisine", words: ["food", "eat", "cuisine", "street food", "restaurant"] },
  { interest: "Nightlife", words: ["night", "bar", "music", "nightlife", "party"] },
  { interest: "Shopping", words: ["shop", "mall", "market", "souvenir"] },
  { interest: "Photography", words: ["photo", "photography", "instagram", "pictures", "sunset"] },
  { interest: "Nature & Wildlife", words: ["wildlife", "nature", "park", "forest"] },
];

function inferInterestsFromMessage(message, selectedInterests) {
  const text = String(message || "").toLowerCase();
  const selected = new Set((selectedInterests || []).map(String));
  const hits = new Map();
  for (const entry of INTEREST_KEYWORDS) {
    if (!selected.has(entry.interest)) continue;
    if (entry.words.some((w) => text.includes(String(w).toLowerCase()))) {
      hits.set(entry.interest, (hits.get(entry.interest) || 0) + 1);
    }
  }
  const ordered = Array.from(hits.entries())
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0]);
  return ordered.length ? ordered : (selectedInterests || []).slice(0, 3);
}

// Simple, offline “knowledge base” tagged by interests.
const PLACES = [
  { name: "El Nido", region: "Palawan", lat: 11.2022, lng: 119.4573, tags: ["Beaches", "Island Hopping", "Photography", "Water Sports"] },
  { name: "Coron", region: "Palawan", lat: 12.0022, lng: 120.2043, tags: ["Island Hopping", "Beaches", "Water Sports"] },
  { name: "Boracay", region: "Aklan", lat: 11.9674, lng: 121.9248, tags: ["Beaches", "Nightlife", "Water Sports", "Shopping"] },
  { name: "Banaue Rice Terraces", region: "Ifugao", lat: 16.9230, lng: 121.0561, tags: ["Mountains", "Hiking", "Photography", "Nature & Wildlife"] },
  { name: "Sagada", region: "Mountain Province", lat: 17.0833, lng: 120.9000, tags: ["Mountains", "Hiking", "Photography", "Historical Sites"] },
  { name: "Intramuros", region: "Manila", lat: 14.5896, lng: 120.9747, tags: ["Historical Sites", "Photography", "Local Cuisine"] },
  { name: "Rizal Park", region: "Manila", lat: 14.5826, lng: 120.9790, tags: ["Historical Sites", "Photography", "Nature & Wildlife"] },
  { name: "Binondo Food Walk", region: "Manila", lat: 14.6017, lng: 120.9736, tags: ["Local Cuisine", "Shopping", "Historical Sites"] },
  { name: "Makati Food District", region: "Metro Manila", lat: 14.5547, lng: 121.0244, tags: ["Local Cuisine", "Nightlife"] },
  { name: "Cebu Waterfront", region: "Cebu", lat: 10.3157, lng: 123.8854, tags: ["Beaches", "Photography", "Shopping"] },
  { name: "Siargao Cloud 9", region: "Surigao del Norte", lat: 9.8135, lng: 126.1610, tags: ["Beaches", "Water Sports", "Nightlife", "Photography"] },
  { name: "Chocolate Hills (Bohol)", region: "Bohol", lat: 9.8293, lng: 124.1694, tags: ["Nature & Wildlife", "Photography", "Mountains"] },
];

function scorePlaceByInterests(place, interests) {
  const tags = new Set(place.tags || []);
  let score = 0;
  for (const i of interests || []) score += tags.has(i) ? 2 : 0;
  if (interests?.length) score += Math.min(2, (place.tags || []).filter((t) => (interests || []).includes(t)).length);
  return score;
}

// Top, widely known tourist spots across the Philippines. Used for the general
// "Popular destinations" section (independent of the user's preferences).
const POPULAR_PH_SPOTS = [
  { name: "Boracay", region: "Aklan", lat: 11.9674, lng: 121.9248 },
  { name: "El Nido", region: "Palawan", lat: 11.1784, lng: 119.3932 },
  { name: "Puerto Princesa Underground River", region: "Palawan", lat: 10.1666, lng: 118.9201 },
  { name: "Chocolate Hills", region: "Bohol", lat: 9.8293, lng: 124.1694 },
  { name: "Banaue Rice Terraces", region: "Ifugao", lat: 16.9230, lng: 121.0561 },
  { name: "Mayon Volcano", region: "Albay", lat: 13.2574, lng: 123.6856 },
  { name: "Vigan Heritage Village", region: "Ilocos Sur", lat: 17.5747, lng: 120.3869 },
  { name: "Intramuros", region: "Manila", lat: 14.5896, lng: 120.9747 },
  { name: "Siargao Island", region: "Surigao del Norte", lat: 9.8482, lng: 126.0458 },
  { name: "Coron Island", region: "Palawan", lat: 11.9986, lng: 120.2043 },
  { name: "Taal Volcano", region: "Batangas", lat: 14.0113, lng: 120.9980 },
  { name: "Kawasan Falls", region: "Cebu", lat: 9.8000, lng: 123.3750 },
];

function buildPopularDestinations() {
  return POPULAR_PH_SPOTS.map((spot) => ({ ...spot, tags: ["Tourist Attraction"] }));
}

// Normalizes a user's selected destinations. Supports the newer
// preferredDestinations objects and the legacy preferredPlaces name list.
function getPreferredDestinations(prefs) {
  const out = [];
  const seen = new Set();
  const push = (dest) => {
    const key = String(dest.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(dest);
  };
  for (const d of Array.isArray(prefs?.preferredDestinations) ? prefs.preferredDestinations : []) {
    if (d && d.name) push({ ...d, name: String(d.name) });
  }
  for (const name of Array.isArray(prefs?.preferredPlaces) ? prefs.preferredPlaces : []) {
    const label = String(name || "").trim();
    if (!label) continue;
    const known = PLACES.find((p) => p.name.toLowerCase() === label.toLowerCase() || p.region.toLowerCase() === label.toLowerCase());
    push(known ? { name: label, region: known.region, lat: known.lat, lng: known.lng } : { name: label });
  }
  return out.slice(0, 5);
}

function buildDashboardRecommendations(prefs) {
  const interests = prefs?.interests || [];
  const budget = prefs?.budget || "";
  const travelTypes = prefs?.travelTypes || [];

  // The user's chosen destinations come first, then interest-matched places.
  const preferredDestinations = getPreferredDestinations(prefs).map((d) => ({
    ...d,
    region: d.region || "Philippines",
    tags: d.tags || ["Preferred destination"],
  }));
  const preferredNames = new Set(preferredDestinations.map((d) => d.name.toLowerCase()));
  const recommended = preferredDestinations.concat(
    PLACES
      .filter((p) => !preferredNames.has(p.name.toLowerCase()))
      .sort((a, b) => scorePlaceByInterests(b, interests) - scorePlaceByInterests(a, interests)),
  ).slice(0, 8);

  // "Popular" is a general list of top Philippine tourist spots.
  const popularDestinations = buildPopularDestinations();

  return { recommended, popularDestinations };
}

const REGION_CLUSTER = {
  Manila: "Luzon",
  "Metro Manila": "Luzon",
  Ifugao: "Luzon",
  "Mountain Province": "Luzon",
  Palawan: "Luzon",
  Aklan: "Visayas",
  Cebu: "Visayas",
  Bohol: "Visayas",
  "Surigao del Norte": "Mindanao",
};

function stableSeed(text) {
  return String(text || "")
    .split("")
    .reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
}

function estimateDistanceKm(fromPlace, toPlace) {
  if (!fromPlace || !toPlace) return 6;
  if (fromPlace.name === toPlace.name) return 4;

  const sameRegion = fromPlace.region === toPlace.region;
  const fromCluster = REGION_CLUSTER[fromPlace.region] || "Other";
  const toCluster = REGION_CLUSTER[toPlace.region] || "Other";
  const sameCluster = fromCluster === toCluster;
  const seed = stableSeed(`${fromPlace.name}-${toPlace.name}`);

  if (sameRegion) return 8 + (seed % 18); // 8-25 km local movement
  if (sameCluster) return 45 + (seed % 170); // 45-214 km inter-city within island group
  return 260 + (seed % 700); // 260-959 km inter-island / long-haul
}

function estimateTransport(distanceKm) {
  if (distanceKm <= 8) {
    return {
      mode: "Walk / Tricycle",
      minutes: Math.max(12, Math.round((distanceKm / 4.5) * 60)),
      costPhp: 80,
    };
  }
  if (distanceKm <= 35) {
    return {
      mode: "Jeepney / Grab",
      minutes: Math.round((distanceKm / 20) * 60 + 18),
      costPhp: Math.round(90 + distanceKm * 25),
    };
  }
  if (distanceKm <= 180) {
    return {
      mode: "Bus / Van",
      minutes: Math.round((distanceKm / 42) * 60 + 20),
      costPhp: Math.round(120 + distanceKm * 4.8),
    };
  }
  if (distanceKm <= 480) {
    return {
      mode: "Bus + Ferry",
      minutes: Math.round((distanceKm / 32) * 60 + 70),
      costPhp: Math.round(350 + distanceKm * 3.9),
    };
  }
  return {
    mode: "Flight + Local Transfer",
    minutes: Math.round((distanceKm / 520) * 60 + 170),
    costPhp: Math.round(1800 + distanceKm * 5.2),
  };
}

function budgetMultiplier(budget) {
  if (budget === "Budget-Friendly") return 0.85;
  if (budget === "Luxury") return 1.35;
  if (budget === "Ultra Luxury") return 1.8;
  return 1;
}

function estimateActivitySpend(slot, budget) {
  const baseBySlot = {
    Morning: 280,
    Afternoon: 520,
    Evening: 680,
    Night: 430,
    Activity: 400,
  };
  const base = baseBySlot[slot] || 400;
  return Math.round(base * budgetMultiplier(budget));
}

function createItineraryActivityId() {
  return `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function inferTimeLabelFromTimestamp(timestamp) {
  const hours = new Date(Number(timestamp)).getHours();
  if (hours < 12) return "Morning";
  if (hours < 17) return "Afternoon";
  if (hours < 21) return "Evening";
  return "Night";
}

function formatItineraryDayLabel(date) {
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function startOfLocalDay(timestamp) {
  const date = new Date(Number(timestamp));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function deriveActivityDueAt(activity, fallbackDate) {
  const current = Number(activity?.dueAt || 0);
  if (Number.isFinite(current) && current > 0) return current;

  const timeMap = { Morning: 9, Afternoon: 14, Evening: 18, Night: 21 };
  const derived = new Date(fallbackDate);
  derived.setHours(timeMap[activity?.timeLabel] ?? 12, 0, 0, 0);
  return derived.getTime();
}

function estimateDayBudgetRange(activities) {
  const estimatedDayCostPhp = (activities || []).reduce((sum, activity) => sum + Number(activity?.estimatedTotalCostPhp || 0), 0);
  return {
    estimatedDayCostPhp,
    estimatedDayCostLowPhp: Math.round(estimatedDayCostPhp * 0.9),
    estimatedDayCostHighPhp: Math.round(estimatedDayCostPhp * 1.15),
  };
}

function normalizeItineraryData(itineraryData) {
  if (!itineraryData || !Array.isArray(itineraryData.itinerary)) return itineraryData;

  const originalMeta = itineraryData.meta || {};
  const baseStart = originalMeta.startDate ? new Date(originalMeta.startDate) : new Date();
  const dayGroups = new Map();

  itineraryData.itinerary.forEach((day, dayIndex) => {
    const fallbackDate = new Date(baseStart);
    fallbackDate.setDate(baseStart.getDate() + dayIndex);

    (day?.activities || []).forEach((activity) => {
      const dueAt = deriveActivityDueAt(activity, fallbackDate);
      const normalizedActivity = {
        ...activity,
        id: activity?.id || createItineraryActivityId(),
        dueAt,
        iso: new Date(dueAt).toISOString(),
        timeLabel: inferTimeLabelFromTimestamp(dueAt),
      };
      const dayKey = startOfLocalDay(dueAt);
      if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
      dayGroups.get(dayKey).push(normalizedActivity);
    });
  });

  const sortedDayKeys = Array.from(dayGroups.keys()).sort((a, b) => a - b);
  // Keep empty days between the first and last day so dates stay consecutive (as the
  // server stores them), but only while the trip fits the 14-day limit.
  let orderedDayKeys = sortedDayKeys;
  if (sortedDayKeys.length > 1) {
    const lastKey = sortedDayKeys[sortedDayKeys.length - 1];
    if (Math.round((lastKey - sortedDayKeys[0]) / 86400000) + 1 <= 14) {
      const filled = [];
      const cursor = new Date(sortedDayKeys[0]);
      while (cursor.getTime() <= lastKey && filled.length < 15) {
        filled.push(cursor.getTime());
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      }
      if (sortedDayKeys.every((key) => filled.includes(key))) orderedDayKeys = filled;
    }
  }
  const normalizedDays = orderedDayKeys.map((dayKey, index) => {
    const activities = (dayGroups.get(dayKey) || []).slice().sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
    return {
      dayNumber: index + 1,
      dateLabel: formatItineraryDayLabel(new Date(dayKey)),
      ...estimateDayBudgetRange(activities),
      activities,
    };
  });

  return {
    ...itineraryData,
    meta: {
      ...originalMeta,
      startDate: sortedDayKeys.length ? new Date(sortedDayKeys[0]).toISOString() : (originalMeta.startDate || baseStart.toISOString()),
    },
    itinerary: normalizedDays,
  };
}

// The backend labels generated activities with local clock times ("9:00 AM") but
// computes their timestamps in UTC. Rebuild each timestamp from its label on the
// trip's local dates so times, reminders and the synced admin record match.
function applyLocalScheduleTimes(itinerary, startDate) {
  if (!Array.isArray(itinerary)) return itinerary;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startDate || ""));
  if (!dateMatch) return itinerary;
  return itinerary.map((day, dayIndex) => ({
    ...day,
    activities: (Array.isArray(day?.activities) ? day.activities : []).map((activity) => {
      const match = String(activity?.timeLabel || "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) return activity;
      let hour = Number(match[1]) % 12;
      if (match[3].toUpperCase() === "PM") hour += 12;
      const date = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]) + dayIndex, hour, Number(match[2]), 0, 0);
      return { ...activity, dueAt: date.getTime(), iso: date.toISOString() };
    }),
  }));
}

function updateItineraryActivitySchedule(email, { activityId, parentDueAt, parentTitle, newDueAt } = {}) {
  if (!email || !newDueAt) return null;

  const map = getItineraryByEmail();
  const itineraryData = normalizeItineraryData(map[email]);
  if (!itineraryData?.itinerary?.length) return null;

  let matchedActivity = null;
  for (const day of itineraryData.itinerary) {
    for (const activity of day.activities || []) {
      const sameId = activityId && activity.id === activityId;
      const sameSchedule = !activityId
        && Number(activity?.dueAt || 0) === Number(parentDueAt || 0)
        && String(activity?.title || '') === String(parentTitle || '');
      if (!sameId && !sameSchedule) continue;
      activity.dueAt = Number(newDueAt);
      activity.iso = new Date(Number(newDueAt)).toISOString();
      activity.timeLabel = inferTimeLabelFromTimestamp(newDueAt);
      matchedActivity = activity;
      break;
    }
    if (matchedActivity) break;
  }

  if (!matchedActivity) return null;

  map[email] = normalizeItineraryData(itineraryData);
  setItineraryByEmail(map);
  return {
    activityId: matchedActivity.id,
    dueAt: matchedActivity.dueAt,
  };
}

function generateItinerary(prefs, { startDate = new Date() } = {}) {
  const interests = prefs?.interests || [];
  const travelTypes = prefs?.travelTypes || [];
  const budget = prefs?.budget || "";

  // Allow user schedule preferences to reorder or limit time slots.
  const defaultSlots = ["Morning", "Afternoon", "Evening", "Night"];
  const preferredTimes = Array.isArray(prefs?.schedule?.preferredTimes) ? prefs.schedule.preferredTimes : null;
  const timeSlots = preferredTimes && preferredTimes.length
    ? Array.from(new Set([...preferredTimes, ...defaultSlots]))
    : defaultSlots;
  const dayCount = 3;
  const itinerary = [];

  // Use travelTypes as extra weights.
  const typeBoost = new Set(
    travelTypes.includes("Food Tour") ? ["Local Cuisine"] : []
  );
  if (travelTypes.includes("Beach & Relaxation")) typeBoost.add("Beaches");
  if (travelTypes.includes("Adventure")) typeBoost.add("Hiking");
  if (travelTypes.includes("Cultural")) typeBoost.add("Historical Sites");
  if (travelTypes.includes("Nature & Wildlife")) typeBoost.add("Nature & Wildlife");
  if (travelTypes.includes("City Exploration")) typeBoost.add("Shopping");

  const baseInterests = Array.from(new Set([...(interests || []), ...Array.from(typeBoost)]));

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + dayIndex);
    const dateLabel = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

    const dayTags = baseInterests.slice(dayIndex, dayIndex + 4).concat(baseInterests.slice(0, 2));
    const uniqueTags = Array.from(new Set(dayTags)).slice(0, 5);

    const activities = [];
    let previousPlace = null;
    let dayEstimatedCostPhp = 0;
    for (let k = 0; k < 4; k++) {
      const pool = PLACES.map((p) => {
        // Create an “activity” by mapping place to a tagged experience.
        // boost if the user prefers specific places or regions
        const placeBoost = (Array.isArray(prefs?.preferredPlaces) && prefs.preferredPlaces.includes(p.name)) ? 3 : 0;
        const regionBoost = (Array.isArray(prefs?.preferredPlaces) && prefs.preferredPlaces.includes(p.region)) ? 2 : 0;
        const score = scorePlaceByInterests(p, uniqueTags) + (p.tags.some((t) => uniqueTags.includes(t)) ? 1 : 0) + placeBoost + regionBoost;
        return { place: p, score };
      });
      const chosen = pickWeighted(pool, (x) => x.score);
      const slot = timeSlots[k] || "Activity";

      const place = chosen.place;
      const activityTitle = (() => {
        const tags = new Set(place.tags || []);
        if (tags.has("Local Cuisine")) return `Taste local favorites in ${place.region}`;
        if (tags.has("Historical Sites")) return `Explore history around ${place.name}`;
        if (tags.has("Water Sports")) return `Try a water experience near ${place.name}`;
        if (tags.has("Hiking") || tags.has("Mountains")) return `A scenic walk with views of ${place.name}`;
        if (tags.has("Nightlife")) return `Evening vibes and relaxed stops near ${place.name}`;
        if (tags.has("Shopping")) return `Markets and souvenirs in ${place.region}`;
        return `Discover ${place.name} (great for ${uniqueTags[0] || "travel"})`;
      })();

      const location = `${place.name}, ${place.region}`;

      const distanceKm = estimateDistanceKm(previousPlace, place);
      const transport = estimateTransport(distanceKm);
      const transportCostPhp = Math.round(transport.costPhp * budgetMultiplier(budget));
      const activitySpendPhp = estimateActivitySpend(slot, budget);
      const totalSegmentCostPhp = transportCostPhp + activitySpendPhp;
      dayEstimatedCostPhp += totalSegmentCostPhp;

      // Add a light budget hint so content feels personalized.
      const budgetHint =
        budget === "Budget-Friendly"
          ? "Keep it simple and save for experiences."
          : budget === "Luxury"
            ? "Choose comfortable spots and guided moments."
            : budget === "Ultra Luxury"
              ? "Treat yourself to premium routes."
              : "Balance comfort with local finds.";

      // derive an approximate timestamp for the activity so we can map reminders precisely
      const timeMap = { Morning: 9, Afternoon: 14, Evening: 18, Night: 21 };
      const hour = timeMap[slot] ?? 12;
      const activityDate = new Date(date);
      activityDate.setHours(hour, 0, 0, 0);
      const dueAt = activityDate.getTime();

      activities.push({
        id: createItineraryActivityId(),
        timeLabel: slot,
        title: activityTitle,
        location,
        note: `${budgetHint} Route: ${transport.mode} (~${transport.minutes} min). Estimated stop spend: ~PHP ${totalSegmentCostPhp.toLocaleString()}.`,
        transportMode: transport.mode,
        travelMinutes: transport.minutes,
        travelDistanceKm: Math.round(distanceKm),
        estimatedTransportCostPhp: transportCostPhp,
        estimatedActivityCostPhp: activitySpendPhp,
        estimatedTotalCostPhp: totalSegmentCostPhp,
        dueAt,
        iso: activityDate.toISOString(),
      });

      previousPlace = place;
    }

    itinerary.push({
      dayNumber: dayIndex + 1,
      dateLabel,
      estimatedDayCostPhp: dayEstimatedCostPhp,
      estimatedDayCostLowPhp: Math.round(dayEstimatedCostPhp * 0.9),
      estimatedDayCostHighPhp: Math.round(dayEstimatedCostPhp * 1.15),
      activities,
    });
  }

  return { itinerary, meta: { interests, travelTypes, budget } };
}

function buildAssistantReply(userText, prefs) {
  const selectedInterests = prefs?.interests || [];
  const topInterests = inferInterestsFromMessage(userText, selectedInterests);
  const travelTypes = prefs?.travelTypes || [];
  const budget = prefs?.budget || "";

  const mention = topInterests.slice(0, 3).join(", ");

  const styleLine = (() => {
    if (travelTypes.includes("Food Tour")) return "For food, we can build a day around signature local spots and street bites.";
    if (travelTypes.includes("Adventure")) return "For adventure, I’ll focus on outdoor time and scenic routes.";
    if (travelTypes.includes("Cultural")) return "For culture, we’ll prioritize neighborhoods, museums, and heritage walks.";
    if (travelTypes.includes("Beach & Relaxation")) return "For beach mode, we’ll keep the plan flexible around water time and viewpoints.";
    return "We’ll tailor the plan to your vibe and keep it easy to follow.";
  })();

  const budgetLine =
    budget === "Budget-Friendly"
      ? "Budget-friendly idea: mix paid attractions with free scenic walks."
      : budget === "Ultra Luxury"
        ? "Luxury idea: add a guided experience and comfortable transport between stops."
        : "Mid/upper budget idea: prioritize fewer locations, higher quality experiences.";

  return `Based on your interests (${mention}), here are a few ideas to match what you want:\n\n- ${topInterests[0] ? `A highlight built around ${topInterests[0]}.` : "A custom highlight for you."}\n- ${topInterests[1] ? `A second stop that leans into ${topInterests[1]}.` : "A second stop that balances your day."}\n- ${topInterests[2] ? `A photo-worthy moment for ${topInterests[2]}.` : "A photo-worthy moment."}\n\n${styleLine}\n${budgetLine}\n\nQuick question: what day/time are you most focused on (morning, afternoon, or evening)?`;
}

function getInitialAssistantMessage(prefs) {
  const interests = prefs?.interests || [];
  const picks = interests.slice(0, 3);
  const mention = picks.length ? picks.join(", ") : "your travel style";
  return `Hi! I’m your Sidekick AI. Tell me what you want to do next in the Philippines, and I’ll tailor ideas to ${mention}.`;
}

function isPerfLiteMode() {
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const saveData = Boolean(conn && conn.saveData);
    const weakNetwork = Boolean(conn && (conn.effectiveType === "2g" || conn.effectiveType === "slow-2g"));
    const lowMemory = typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
    const lowCpu = typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 4;
    const mobileViewport = window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
    return saveData || weakNetwork || lowMemory || lowCpu || mobileViewport;
  } catch (e) {
    return false;
  }
}

function applyPerfModeClass() {
  if (!document || !document.documentElement) return;
  const isLite = isPerfLiteMode();
  document.documentElement.classList.toggle("perf-lite", isLite);
}

// Expose a small namespace for page scripts (keeps globals cleaner).
window.SidekickCore = {
  SIDEKICK_KEYS,
  escapeHtml,
  hashPasswordSHA256,
  apiRequest,
  getUsers,
  setUsers,
  getAuthSession,
  setAuthSession,
  clearAuthSession,
  normalizeEmail,
  getPreferences,
  setPreferencesForEmail,
  syncPreferencesToServer,
  resetPreferencesForEmail,
  clearOnboardingStateForEmail,
  recordAccountForEmail,
  forgetAccountForEmail,
  requireAuth,
  requirePreferences,
  getChatByEmail,
  setChatByEmail,
  clearChatForEmail,
  getItineraryByEmail,
  ensureItineraryMonitored,
  setItineraryByEmail,
  clearItineraryForEmail,
  clearExpiredItineraryForEmail,
  getNotificationPreferences,
  setNotificationPreferences,
  clearRemindersForEmail,
  getApiBaseUrl,
  formatDateRange,
  buildDashboardRecommendations,
  buildPopularDestinations,
  getPreferredDestinations,
  POPULAR_PH_SPOTS,
  getApiBaseUrl,
  generateItinerary,
  updateItineraryActivitySchedule,
  normalizeItineraryData,
  applyLocalScheduleTimes,
  // expose place database for UI builders
  PLACES,
  buildAssistantReply,
  getInitialAssistantMessage,
  isPerfLiteMode,
};

function startAppPresenceHeartbeat() {
  let requestInProgress = false;
  let lastErrorAt = 0;
  let itineraryCheckInProgress = false;
  let lastItineraryCheckErrorAt = 0;

  async function verifyStoredItinerary() {
    const session = getAuthSession();
    if (!session?.email || !session?.apiToken || document.visibilityState !== "visible" || itineraryCheckInProgress) return;
    const itinerary = getItineraryByEmail()[session.email];
    const tripId = Number(itinerary?.meta?.serverTripId);
    const hasServerTripId = Number.isSafeInteger(tripId) && tripId > 0;
    itineraryCheckInProgress = true;
    try {
      const query = hasServerTripId ? `?tripId=${encodeURIComponent(tripId)}` : '';
      const retention = await apiRequest(`/api/app-itineraries/retention${query}`);
      const endDate = String(itinerary?.meta?.endDate || '').slice(0, 10);
      const passedRetentionDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
        && endDate < String(retention.expiredBeforeDate || '');
      if (!retention.tripAvailable || passedRetentionDate) {
        clearExpiredItineraryForEmail(
          session.email,
          hasServerTripId ? tripId : null,
          hasServerTripId ? null : itinerary,
        );
      }
      lastItineraryCheckErrorAt = 0;
    } catch (error) {
      if (Date.now() - lastItineraryCheckErrorAt > 60_000) {
        console.warn("Unable to verify the saved itinerary's retention status:", error.message);
        lastItineraryCheckErrorAt = Date.now();
      }
    } finally {
      itineraryCheckInProgress = false;
    }
  }

  async function sendHeartbeat() {
    const session = getAuthSession();
    if (!session?.email || !session?.apiToken || document.visibilityState !== "visible" || !document.hasFocus() || requestInProgress) return;
    requestInProgress = true;
    try {
      await apiRequest("/api/app-presence/heartbeat", { method: "POST" });
      lastErrorAt = 0;
    } catch (error) {
      if (Date.now() - lastErrorAt > 60_000) {
        console.warn("Unable to update app presence:", error.message);
        lastErrorAt = Date.now();
      }
    } finally {
      requestInProgress = false;
    }
  }

  void sendHeartbeat();
  void verifyStoredItinerary();
  try {
    const session = getAuthSession();
    const prefs = session?.email ? getPreferencesByEmail()[session.email] : null;
    if (prefs) void syncPreferencesToServer(session.email, prefs);
  } catch (error) {}
  window.setInterval(sendHeartbeat, 30_000);
  window.setInterval(verifyStoredItinerary, 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void sendHeartbeat();
      void verifyStoredItinerary();
    }
  });
  window.addEventListener("focus", () => {
    void sendHeartbeat();
    void verifyStoredItinerary();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startAppPresenceHeartbeat, { once: true });
} else {
  startAppPresenceHeartbeat();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyPerfModeClass);
} else {
  applyPerfModeClass();
}

// Auto-adjust app container padding for fixed bottom overlays (navs, footers, inputs)
(function () {
  let rafId = 0;

  function scheduleApplyPadding() {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      applyPadding();
    });
  }

  function computeBottomOverlayHeight() {
    try {
      const candidates = document.querySelectorAll('.bottom-nav, .onboarding-footer, .chat-input-container');
      let total = 0;

      for (const el of candidates) {
        try {
          const cs = getComputedStyle(el);
          const isFixed = cs.position === 'fixed';
          const isVisible = cs.display !== 'none' && cs.visibility !== 'hidden';
          const isBottomAnchored = cs.bottom !== 'auto' || el.classList.contains('onboarding-footer') || el.classList.contains('chat-input-container');
          if (!isFixed || !isVisible || !isBottomAnchored) continue;

          const rect = el.getBoundingClientRect();
          if (rect.height > 0) total = Math.max(total, rect.height);
        } catch (e) {
          // Ignore elements that cannot be measured.
        }
      }

      return total;
    } catch (e) {
      return 0;
    }
  }

  function applyPadding() {
    const container = document.querySelector('.app-container');
    if (!container) return;
    const overlayHeight = computeBottomOverlayHeight();
    // expose a CSS variable so page-specific components can react too
    try {
      document.documentElement.style.setProperty('--bottom-overlay-height', `${overlayHeight}px`);
    } catch (e) {}

    if (overlayHeight > 0) {
      container.style.paddingBottom = `calc(${overlayHeight}px + env(safe-area-inset-bottom) + 12px)`;
    } else {
      // restore default padding from CSS (remove inline override)
      container.style.paddingBottom = '';
    }
  }

  // Run on load, resize, and observe DOM changes that may introduce overlays.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleApplyPadding);
  } else {
    scheduleApplyPadding();
  }

  window.addEventListener('resize', scheduleApplyPadding, { passive: true });

  try {
    const mo = new MutationObserver(() => scheduleApplyPadding());
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) {
    // ignore if MutationObserver unavailable
  }
})();

// Keyboard scroll-into-view handler for mobile form inputs
(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachInputScrollHandlers);
  } else {
    attachInputScrollHandlers();
  }

  function attachInputScrollHandlers() {
    const inputs = document.querySelectorAll('input, textarea, select');
    inputs.forEach((input) => {
      input.addEventListener('focus', function () {
        // Use smooth scroll with a small delay to ensure keyboard has started appearing
        setTimeout(() => {
          this.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      });
    });
  }
})();

// Reminders / Alerts (Objective 4 compact implementation)
(function () {
  const KEY = SIDEKICK_KEYS.remindersByEmail;
  const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications || null;
  let localListenersAttached = false;
  let reminderChannelsReady = false;
  // Android 8+ fixes a notification's sound and vibration in its channel when the
  // channel is created, so each combination of the Settings switches gets its own
  // channel. With sound on, no sound file is given, so the phone's normal
  // notification sound plays. With sound off, a silent file
  // (android/app/src/main/res/raw/sidekick_silent.wav) is used, because the plugin
  // cannot create a channel without any sound.
  const REMINDER_CHANNELS = {
    'sound|vibrate': { id: 'sidekick_alerts_sound_vibrate', name: 'Reminders: sound and vibration', vibration: true },
    'sound|still': { id: 'sidekick_alerts_sound', name: 'Reminders: sound only', vibration: false },
    'quiet|vibrate': { id: 'sidekick_alerts_vibrate', name: 'Reminders: vibration only', vibration: true, sound: 'sidekick_silent.wav' },
    'quiet|still': { id: 'sidekick_alerts_silent', name: 'Reminders: silent', vibration: false, sound: 'sidekick_silent.wav' },
  };
  const TEST_NOTIFICATION_ID = 2147480001;
  const reminderTimeoutHandles = new Map();

  function reminderChannelFor(prefs) {
    const sound = prefs?.soundEnabled !== false ? 'sound' : 'quiet';
    const vibrate = prefs?.vibrationEnabled !== false ? 'vibrate' : 'still';
    return REMINDER_CHANNELS[`${sound}|${vibrate}`];
  }

  // Pre-alert offsets to create per event (label + milliseconds)
  const PRE_ALERT_OFFSETS = [
    { label: '1 day before', ms: 24 * 60 * 60 * 1000 },
    { label: '10 hours before', ms: 10 * 60 * 60 * 1000 },
    { label: '5 hours before', ms: 5 * 60 * 60 * 1000 },
    { label: '1 hour before', ms: 1 * 60 * 60 * 1000 },
  ];

  function hasLocalNotifications() {
    return !!(LocalNotifications && typeof LocalNotifications.schedule === 'function');
  }

  async function ensureReminderChannels() {
    if (!hasLocalNotifications() || reminderChannelsReady) return;
    if (typeof LocalNotifications.createChannel !== 'function') {
      reminderChannelsReady = true;
      return;
    }
    for (const channel of Object.values(REMINDER_CHANNELS)) {
      try {
        await LocalNotifications.createChannel({
          id: channel.id,
          name: channel.name,
          description: 'Sidekick travel reminders and alerts',
          importance: 4, // high: makes a sound (if any) and shows a heads-up banner
          visibility: 1, // public: shown on the lock screen
          lights: true,
          vibration: channel.vibration,
          ...(channel.sound ? { sound: channel.sound } : {}),
        });
      } catch (e) {
        // Creating an existing channel is harmless; non-Android platforms have no channels.
      }
    }
    reminderChannelsReady = true;
  }

  function reminderNotificationId(email, reminderId) {
    const seed = `${email || ''}|${reminderId || ''}`;
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    // Keep inside signed 32-bit positive range.
    return (h % 2147483000) + 1;
  }

  function reminderTimerKey(email, reminderId) {
    return `${email || ''}::${reminderId || ''}`;
  }

  function clearReminderTimeout(email, reminderId) {
    const key = reminderTimerKey(email, reminderId);
    const handle = reminderTimeoutHandles.get(key);
    if (!handle) return;
    clearTimeout(handle);
    reminderTimeoutHandles.delete(key);
  }

  function clearReminderTimeoutsForEmail(email, keepIds) {
    const prefix = `${email || ''}::`;
    const keep = keepIds ? new Set(keepIds) : null;
    Array.from(reminderTimeoutHandles.keys()).forEach((key) => {
      if (!key.startsWith(prefix)) return;
      const reminderId = key.slice(prefix.length);
      if (keep && keep.has(reminderId)) return;
      clearReminderTimeout(email, reminderId);
    });
  }

  function markReminderFired(email, reminderId) {
    try {
      const list = getRemindersFor(email).map((r) => {
        if (r.id !== reminderId) return r;
        if (r.firedAt) return r;
        return { ...r, firedAt: Date.now() };
      });
      setRemindersFor(email, list);
    } catch (e) {}
  }

  function bindLocalNotificationListeners() {
    if (!hasLocalNotifications() || localListenersAttached) return;

    const onEvent = (notification) => {
      try {
        const extra = notification?.extra || {};
        if (!extra.email || !extra.reminderId) return;
        markReminderFired(String(extra.email), String(extra.reminderId));
      } catch (e) {}
    };

    LocalNotifications.addListener('localNotificationReceived', (event) => onEvent(event?.notification));
    LocalNotifications.addListener('localNotificationActionPerformed', (event) => onEvent(event?.notification));
    localListenersAttached = true;
  }

  async function ensureNotificationPermission() {
    if (!hasLocalNotifications()) return false;
    try {
      const current = await LocalNotifications.checkPermissions();
      if (current?.display === 'granted') return true;
      const requested = await LocalNotifications.requestPermissions();
      return requested?.display === 'granted';
    } catch (e) {
      return false;
    }
  }

  // The notification text: itinerary and pre-alert reminders say how far ahead they are.
  function reminderNotificationBody(reminder) {
    const detail = String(reminder.note || reminder.type || 'Reminder from Sidekick').replace(/\s*•\s*$/, '').trim();
    const lead = reminder.offsetLabel ? `Starts in ${String(reminder.offsetLabel).replace(/\s*before$/i, '')}` : '';
    return [lead, detail].filter(Boolean).join(' · ') || 'Reminder from Sidekick';
  }

  // Makes the phone's scheduled notifications match the saved reminders exactly.
  // Only one sync runs per account at a time; changes made meanwhile trigger one more
  // pass, so an older pass can never re-schedule a reminder that was just removed.
  const deviceSyncs = new Map();
  function syncDeviceNotificationsForEmail(email) {
    if (!hasLocalNotifications() || !email) return Promise.resolve();
    const running = deviceSyncs.get(email);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const state = { again: false, promise: null };
    deviceSyncs.set(email, state);
    state.promise = (async () => {
      try {
        while (true) {
          state.again = false;
          await syncDeviceNotificationsOnce(email);
          if (!state.again) break;
        }
      } finally {
        deviceSyncs.delete(email);
      }
    })();
    return state.promise;
  }

  async function syncDeviceNotificationsOnce(email) {
    bindLocalNotificationListeners();
    await ensureReminderChannels();
    const granted = await ensureNotificationPermission();
    if (!granted) return;

    const list = getRemindersFor(email) || [];
    const prefs = getNotificationPrefs(email);
    const owner = normalizeEmail(email);

    // Cancel everything already scheduled for this account, including reminders that
    // were deleted since (their IDs are no longer in the list), then schedule afresh.
    const cancelIds = new Set(list.map((r) => reminderNotificationId(email, r.id)));
    try {
      const pending = await LocalNotifications.getPending();
      (pending?.notifications || []).forEach((notification) => {
        const extra = notification?.extra || {};
        if (!extra.test && normalizeEmail(extra.email) === owner) cancelIds.add(Number(notification.id));
      });
    } catch (e) {}
    try {
      if (cancelIds.size) {
        await LocalNotifications.cancel({ notifications: [...cancelIds].map((id) => ({ id })) });
      }
    } catch (e) {}

    if (!prefs.enabled) return;

    const channel = reminderChannelFor(prefs);
    const now = Date.now();
    const notifications = list
      .filter((r) => !r.firedAt && !r.suppressed && Number(r.dueAt || 0) > now)
      .map((r) => ({
        id: reminderNotificationId(email, r.id),
        title: String(r.title || 'Sidekick Alert'),
        body: reminderNotificationBody(r),
        channelId: channel.id,
        // Android 7 has no channels and reads this per notification instead.
        ...(channel.sound ? { sound: channel.sound } : {}),
        schedule: {
          at: new Date(Number(r.dueAt)),
          allowWhileIdle: true,
        },
        extra: {
          email,
          reminderId: r.id,
          type: r.type || '',
        },
      }));

    try {
      if (notifications.length) {
        await LocalNotifications.schedule({ notifications });
      }
    } catch (e) {
      console.warn('[Reminders] Could not schedule phone notifications:', e?.message || e);
    }
  }

  // Sends one notification a few seconds from now with the current Settings, so the
  // user can check sound, vibration and the lock screen. Returns { ok, message }.
  async function sendTestNotification(email) {
    if (!hasLocalNotifications()) {
      return { ok: false, message: 'Test notifications work in the Sidekick phone app.' };
    }
    const prefs = getNotificationPrefs(email);
    if (!prefs.enabled) {
      return { ok: false, message: 'Turn on “Enable reminders” first.' };
    }
    bindLocalNotificationListeners();
    await ensureReminderChannels();
    const granted = await ensureNotificationPermission();
    if (!granted) {
      return { ok: false, message: 'Notifications are blocked. Allow them for Sidekick in your phone’s Settings → Apps → Sidekick → Notifications.' };
    }
    const channel = reminderChannelFor(prefs);
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: TEST_NOTIFICATION_ID,
          title: 'Sidekick test notification',
          body: 'Reminders will look and sound like this.',
          channelId: channel.id,
          ...(channel.sound ? { sound: channel.sound } : {}),
          schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true },
          extra: { email, test: true },
        }],
      });
    } catch (e) {
      return { ok: false, message: `The test notification could not be scheduled: ${e?.message || 'unknown error'}` };
    }
    let exactNote = '';
    try {
      if (typeof LocalNotifications.checkExactNotificationSetting === 'function') {
        const exact = await LocalNotifications.checkExactNotificationSetting();
        if (exact?.exact_alarm && exact.exact_alarm !== 'granted') {
          exactNote = ' “Alarms & reminders” is off for Sidekick in your phone settings, so reminders may arrive a few minutes late.';
        }
      }
    } catch (e) {}
    return { ok: true, message: `A test notification will arrive in about 5 seconds. You can leave the app to see it.${exactNote}` };
  }

  async function ensureReminderNotificationsReady(email) {
    if (!hasLocalNotifications()) return false;
    bindLocalNotificationListeners();
    await ensureReminderChannels();
    const granted = await ensureNotificationPermission();
    if (granted && email) {
      await syncDeviceNotificationsForEmail(email);
    }
    return granted;
  }

  function getAllReminders() {
    return safeJsonParse(localStorage.getItem(KEY), {});
  }

  function getRemindersFor(email) {
    const all = getAllReminders();
    return all[email] || [];
  }

  function setRemindersFor(email, list) {
    const all = getAllReminders();
    all[email] = list;
    localStorage.setItem(KEY, JSON.stringify(all));
    clearReminderTimeoutsForEmail(email, (list || []).map((reminder) => reminder.id));
    try {
      document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email } }));
    } catch (e) {}
  }

  function addReminderFor(email, reminder) {
    const list = getRemindersFor(email);
    reminder.id = reminder.id || `r_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    // ensure suppressed flag exists
    if (typeof reminder.suppressed === 'undefined') reminder.suppressed = false;
    list.push(reminder);
    setRemindersFor(email, list);
    scheduleReminder(email, reminder);
    void syncDeviceNotificationsForEmail(email);
    return reminder;
  }

  function removeReminderFor(email, id) {
    clearReminderTimeout(email, id);
    const list = getRemindersFor(email).filter((r) => r.id !== id);
    setRemindersFor(email, list);
    void syncDeviceNotificationsForEmail(email);
  }

  function removeAllRemindersFor(email) {
    const reminders = getRemindersFor(email);
    const scheduledIds = reminders.map((reminder) => ({ id: reminderNotificationId(email, reminder.id) }));
    setRemindersFor(email, []);
    if (hasLocalNotifications() && scheduledIds.length) {
      try {
        const cancellation = LocalNotifications.cancel({ notifications: scheduledIds });
        cancellation?.catch?.(() => {});
      } catch (e) {}
    }
  }

  function clearItineraryRemindersForEmail(email) {
    const existing = getRemindersFor(email);
    const itineraryReminders = existing.filter((reminder) => (
      reminder.type === 'Itinerary' || reminder.itineraryActivityId
    ));
    if (!itineraryReminders.length) return;
    const itineraryIds = new Set(itineraryReminders.map((reminder) => reminder.id));
    const retained = existing.filter((reminder) => !itineraryIds.has(reminder.id));
    setRemindersFor(email, retained);
    if (hasLocalNotifications()) {
      const notifications = itineraryReminders.map((reminder) => ({
        id: reminderNotificationId(email, reminder.id),
      }));
      try {
        const cancellation = LocalNotifications.cancel({ notifications });
        cancellation?.catch?.((error) => console.warn('Unable to cancel expired itinerary notifications:', error));
      } catch (error) {
        console.warn('Unable to cancel expired itinerary notifications:', error);
      }
    }
    void syncDeviceNotificationsForEmail(email);
  }

  function turnOffAllRemindersFor(email) {
    const reminders = getRemindersFor(email).map((reminder) => ({ ...reminder, suppressed: true }));
    setRemindersFor(email, reminders);
    scheduleAllFor(email);
  }

  function getUpcomingRemindersCount(email, withinMs = 24 * 60 * 60 * 1000) {
    try {
      const list = getRemindersFor(email) || [];
      const now = Date.now();
      return list.filter((r) => !r.firedAt && Number(r.dueAt) > now && Number(r.dueAt) <= now + withinMs).length;
    } catch (e) { return 0; }
  }

  // Get notification preferences (from window scope set by notification prefs IIFE)
  function getNotificationPrefs(email) {
    return getNotificationPreferences(email) || {
      enabled: true,
      soundEnabled: true,
      vibrationEnabled: true,
    };
  }

  function playNotificationTone() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  }

  // Enhanced trigger function with Capacitor LocalNotifications support
  function triggerReminder(reminder, email) {
    try {
      // re-read latest reminder state and preferences
      const current = getRemindersFor(email).find((r) => r.id === reminder.id) || reminder;
      const prefs = getNotificationPrefs(email);
      
      if (!current) return;
      if (current.suppressed) return;
      if (current.firedAt) return;
      if (!prefs.enabled) return; // skip if notifications disabled
      
      reminder = current;
      const title = reminder.title || 'Sidekick Alert';
      const body = reminder.note || reminder.type || 'Reminder from Sidekick';
      
      // Mobile-friendly effects (no browser notification APIs).
      if (prefs.vibrationEnabled && navigator.vibrate) navigator.vibrate([120, 80, 120]);
      if (prefs.soundEnabled) playNotificationTone();
    } catch (e) {}

    // Show in-app overlay
    try {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.left = '0';
      overlay.style.top = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.zIndex = 99999;
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.background = 'rgba(0,0,0,0.45)';

      const card = document.createElement('div');
      card.style.background = '#fff';
      card.style.padding = '20px';
      card.style.borderRadius = '12px';
      card.style.maxWidth = '420px';
      card.style.width = '90%';
      card.style.boxShadow = '0 8px 32px rgba(0,0,0,0.2)';

      const h = document.createElement('div');
      h.style.fontSize = '18px';
      h.style.fontWeight = 600;
      h.style.marginBottom = '6px';
      h.style.color = '#2C3E50';
      h.textContent = reminder.title || 'Sidekick Alert';
      
      const p = document.createElement('div');
      p.style.color = '#374151';
      p.style.marginBottom = '12px';
      p.style.fontSize = '14px';
      p.textContent = reminder.note || reminder.type || '';

      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '8px';
      btnRow.style.justifyContent = 'flex-end';
      
      const offBtn = document.createElement('button');
      offBtn.textContent = 'Turn off';
      offBtn.className = 'btn btn-outline';
      offBtn.style.padding = '8px 12px';
      offBtn.style.fontSize = '14px';
      
      const okBtn = document.createElement('button');
      okBtn.textContent = 'Dismiss';
      okBtn.className = 'btn btn-primary';
      okBtn.style.padding = '8px 12px';
      okBtn.style.fontSize = '14px';

      offBtn.onclick = () => {
        try { setReminderSuppressed(email, reminder.id, true); } catch (e) {}
        try { document.body.removeChild(overlay); } catch (e) {}
      };
      okBtn.onclick = () => {
        try { document.body.removeChild(overlay); } catch (e) {}
      };

      btnRow.appendChild(offBtn);
      btnRow.appendChild(okBtn);
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(btnRow);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    } catch (e) {}

    // Mark as fired
    try {
      const list = getRemindersFor(email).map((r) => (r.id === reminder.id ? { ...r, firedAt: Date.now() } : r));
      setRemindersFor(email, list);
    } catch (e) {}
  }

  function scheduleReminder(email, reminder) {
    try {
      if (hasLocalNotifications()) return;
      clearReminderTimeout(email, reminder.id);
      // do not schedule suppressed reminders
      if (reminder.suppressed) return;
      const when = Number(reminder.dueAt || 0);
      const now = Date.now();
      const delta = when - now;
      if (delta <= 0) {
        // due now or past
        triggerReminder(reminder, email);
        return;
      }
      // cap to 2^31-1 for setTimeout
      const MAX = 2147483647;
      const ms = Math.min(delta, MAX);
      const handle = setTimeout(() => {
        reminderTimeoutHandles.delete(reminderTimerKey(email, reminder.id));
        triggerReminder(reminder, email);
      }, ms);
      reminderTimeoutHandles.set(reminderTimerKey(email, reminder.id), handle);
    } catch (e) {}
  }

  function scheduleAllFor(email) {
    const list = getRemindersFor(email);
    clearReminderTimeoutsForEmail(email);
    void syncDeviceNotificationsForEmail(email);
    list.forEach((r) => {
      if (!r.firedAt && !r.suppressed) scheduleReminder(email, r);
    });
  }

  function syncRemindersFromItinerary(email) {
    try {
      const map = getItineraryByEmail();
      const data = normalizeItineraryData(map[email]);
      if (!data || !data.itinerary || !Array.isArray(data.itinerary)) return;
      map[email] = data;
      setItineraryByEmail(map);

      const existing = getRemindersFor(email) || [];
      const manualReminders = existing.filter((r) => r.type !== 'Itinerary' && !r.itineraryActivityId);
      const existingItineraryReminders = existing.filter((r) => r.type === 'Itinerary' || r.itineraryActivityId);
      const preservedState = new Map(
        existingItineraryReminders.map((r) => [`${r.itineraryActivityId || ''}|${Number(r.offsetMs || 0)}`, r])
      );
      const now = Date.now();
      const nextItineraryReminders = [];

      data.itinerary.forEach((day) => {
        const activities = day.activities || [];
        activities.forEach((act) => {
          const dueAt = Number(act?.dueAt || 0);
          if (dueAt < now - 60000) return;

          const title = act.title || `Activity: ${act.location || act.timeLabel}`;
          const note = `${act.location || ''} • ${data?.meta?.budget || ''}`.trim();

          PRE_ALERT_OFFSETS.forEach((off) => {
            const reminderDue = Number(dueAt) - off.ms;
            if (reminderDue <= now) return;
            const stateKey = `${act.id || ''}|${off.ms}`;
            const preserved = preservedState.get(stateKey);
            nextItineraryReminders.push({
              id: preserved?.id || `r_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
              title,
              type: 'Itinerary',
              dueAt: reminderDue,
              note,
              parentDueAt: Number(dueAt),
              parentTitle: title,
              itineraryActivityId: act.id,
              offsetLabel: off.label,
              offsetMs: off.ms,
              suppressed: Boolean(preserved?.suppressed),
            });
          });
        });
      });

      const list = manualReminders.concat(nextItineraryReminders).sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
      setRemindersFor(email, list);
      scheduleAllFor(email);
    } catch (e) {
      // swallow errors to keep app robust
    }
  }

  if (window.SidekickCore) {
    window.SidekickCore.getRemindersFor = getRemindersFor;
    window.SidekickCore.addReminderFor = addReminderFor;
    window.SidekickCore.removeReminderFor = removeReminderFor;
    window.SidekickCore.removeAllRemindersFor = removeAllRemindersFor;
    window.SidekickCore.clearItineraryRemindersForEmail = clearItineraryRemindersForEmail;
    window.SidekickCore.turnOffAllRemindersFor = turnOffAllRemindersFor;
    window.SidekickCore.scheduleAllFor = scheduleAllFor;
    window.SidekickCore.syncRemindersFromItinerary = syncRemindersFromItinerary;
    window.SidekickCore.updateItineraryActivitySchedule = updateItineraryActivitySchedule;
    window.SidekickCore.getUpcomingRemindersCount = getUpcomingRemindersCount;
    window.SidekickCore.ensureReminderNotificationsReady = ensureReminderNotificationsReady;
    window.SidekickCore.sendTestNotification = sendTestNotification;
    window.SidekickCore.setReminderSuppressed = function(email, id, value){ setReminderSuppressed(email, id, value); };
  }

  function setReminderSuppressed(email, id, value){
    try{
      const list = getRemindersFor(email).map((r) => (r.id === id ? { ...r, suppressed: !!value } : r));
      setRemindersFor(email, list);
      void syncDeviceNotificationsForEmail(email);
    }catch(e){}
  }

  // Any change to saved reminders (added, edited, removed, cleared) re-syncs the phone's
  // scheduled notifications, including paths that only edit storage.
  document.addEventListener('sidekick:reminders-updated', (event) => {
    const email = event?.detail?.email;
    if (email) void syncDeviceNotificationsForEmail(email);
  });

  // auto-schedule when a user is authenticated and DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    const s = getAuthSession();
    if (s?.email) {
      bindLocalNotificationListeners();
      scheduleAllFor(s.email);
    }
  });
})();

// Ensure sync of itinerary-derived reminders on page load as well
// NOTE: do not automatically create or sync itineraries on page load.
// Itineraries should only be created when the user explicitly builds them.
// Scheduling of existing reminders still occurs elsewhere on DOMContentLoaded.
