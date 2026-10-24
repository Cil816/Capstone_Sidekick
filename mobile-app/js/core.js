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

// Passwords: at least 8 characters, with both letters and numbers (the server checks too).
function isStrongEnoughPassword(password) {
  const text = String(password || "");
  return text.length >= 8 && /\p{L}/u.test(text) && /\d/.test(text);
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
  // Quotes too, so escaped text is also safe inside an attribute such as a link's href.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

// Messages written for people pass through; anything technical (browser, network,
// database or library text) is replaced with a plain message the traveler understands.
const TECHNICAL_ERROR_PATTERN = /\b(?:typeerror|referenceerror|syntaxerror|rangeerror|undefined|is not a function|is not defined|cannot read|cannot set|unexpected token|json|failed to fetch|fetch failed|networkerror|load failed|econn\w*|etimedout|enotfound|socket|sql|tedious|mssql|constraint|deadlock|invalid column|invalid object|stack|status code|http \d{3}|api key|api_key|backend|endpoint|server address|not configured|config\.local|quota|errno|exception|no api)\b|\b[A-Z]{2,}_[A-Z_]{2,}\b|https?:\/\//i;

function friendlyError(error, fallback = "Something went wrong. Please try again.") {
  const message = String(error?.message || error || "").trim();
  if (!message || message.length > 300 || TECHNICAL_ERROR_PATTERN.test(message)) return fallback;
  return message;
}

// ---- Internet connection ---------------------------------------------------------
// Without internet, requests wait for the connection to come back instead of failing,
// so screens keep their loading placeholders and finish loading by themselves.
function isOnline() {
  return navigator.onLine !== false;
}

// Resolves when the device is online (right away if it already is). Rejects with an
// AbortError if the given AbortSignal is aborted first.
function waitForOnline(signal) {
  if (isOnline()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("online", onOnline);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onOnline = () => { cleanup(); resolve(); };
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new DOMException("The request was cancelled.", "AbortError"));
    };
    if (signal?.aborted) { onAbort(); return; }
    window.addEventListener("online", onOnline);
    signal?.addEventListener?.("abort", onAbort);
  });
}

// ---- Saved answers for Google-backed requests ---------------------------------------------
// Place searches, place details, routes and price checks are saved on the phone for a while,
// so the same lookup isn't paid for again (whichever server answers). Only these public
// lookups are saved, never sign-in, trips, chats or AI answers. Lifetimes stay within
// Google's terms (place data refreshed at least daily, prices every few hours).
const API_CACHE_KEY = "sidekick.apiCache.v1";
const API_CACHE_MAX_ENTRIES = 250;
const API_CACHE_MAX_CHARS = 1500000; // about 1.5 MB on the phone
const API_CACHE_HOUR_MS = 60 * 60 * 1000;
const API_CACHE_RULES = [
  { prefix: "/api/maps/place-suggestions", ttl: 24 * API_CACHE_HOUR_MS },
  { prefix: "/api/maps/place-details", ttl: 24 * API_CACHE_HOUR_MS },
  { prefix: "/api/maps/places", ttl: 24 * API_CACHE_HOUR_MS },
  { prefix: "/api/maps/route", ttl: 12 * API_CACHE_HOUR_MS },
  { prefix: "/api/hotels/budget-options", ttl: 6 * API_CACHE_HOUR_MS },
  { prefix: "/api/trip/budget-check", ttl: 6 * API_CACHE_HOUR_MS },
  { prefix: "/api/places/popular", ttl: 0.5 * API_CACHE_HOUR_MS },
];

function apiCacheTtl(path) {
  const pathOnly = String(path || "").split("?")[0];
  const rule = API_CACHE_RULES.find((item) => pathOnly === item.prefix || pathOnly.startsWith(`${item.prefix}/`));
  return rule ? rule.ttl : 0;
}

function apiCacheEntryKey(path, options) {
  let body = typeof options.body === "string" ? options.body : "";
  // A search's Google session token changes every time the traveler types, so it is left
  // out: the same search text finds the saved answer.
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "sessionToken" in parsed) {
      delete parsed.sessionToken;
      body = JSON.stringify(parsed);
    }
  } catch (error) { /* not JSON: used as is */ }
  const text = `${String(options.method || "GET").toUpperCase()} ${path} ${body}`;
  // A short hash keeps the saved keys small.
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return `${hash.toString(36)}:${text.length}`;
}

function readApiCache() {
  try { return JSON.parse(localStorage.getItem(API_CACHE_KEY) || "{}") || {}; } catch (error) { return {}; }
}

function cachedApiAnswer(key) {
  const entry = readApiCache()[key];
  return entry && entry.expiresAt > Date.now() ? entry.value : null;
}

function saveApiAnswer(key, value, ttl) {
  try {
    const now = Date.now();
    const cache = readApiCache();
    cache[key] = { value, expiresAt: now + ttl, savedAt: now };
    // Drop expired answers, then the oldest ones, to stay small.
    let keys = Object.keys(cache).filter((item) => cache[item]?.expiresAt > now);
    keys.sort((a, b) => cache[a].savedAt - cache[b].savedAt);
    while (keys.length > API_CACHE_MAX_ENTRIES) keys.shift();
    let text = JSON.stringify(Object.fromEntries(keys.map((item) => [item, cache[item]])));
    while (text.length > API_CACHE_MAX_CHARS && keys.length > 1) {
      keys = keys.slice(Math.ceil(keys.length / 4));
      text = JSON.stringify(Object.fromEntries(keys.map((item) => [item, cache[item]])));
    }
    localStorage.setItem(API_CACHE_KEY, text);
  } catch (error) { /* the phone is out of space: the answer just isn't saved */ }
}

async function apiRequest(path, options = {}) {
  const cacheTtl = apiCacheTtl(path);
  const cacheKey = cacheTtl ? apiCacheEntryKey(path, options) : "";
  if (cacheKey) {
    const saved = cachedApiAnswer(cacheKey);
    if (saved) return saved;
  }
  const payload = await apiRequestFromServer(path, options);
  // Only complete answers are saved: not error notes, development samples, or empty lists
  // (a search that briefly found nothing is asked again next time).
  const emptyList = ["suggestions", "places", "hotels"].some((field) => Array.isArray(payload?.[field]) && !payload[field].length);
  if (cacheKey && payload && typeof payload === "object" && !payload.error && !payload.isDevelopmentMock && !emptyList) {
    saveApiAnswer(cacheKey, payload, cacheTtl);
  }
  return payload;
}

async function apiRequestFromServer(path, options = {}) {
  // options.waitForConnection = false makes a request fail right away when offline.
  const waitForConnection = options.waitForConnection !== false;
  if (waitForConnection) await waitForOnline(options.signal);
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
    // The connection dropped during the request: try again once it is back.
    if (waitForConnection && !isOnline()) return apiRequest(path, options);
    throw new Error("We couldn’t connect to Sidekick. Check your internet connection and try again.");
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
    const fallback = response.status === 404
      ? "This feature isn’t available right now. Please try again later."
      : response.status >= 500
        ? "Something went wrong on our side. Please try again in a moment."
        : "Something went wrong. Please try again.";
    const serverMessage = typeof payload.error === "string" ? payload.error.trim() : "";
    // The maintenance message is written by the administrator, so it is shown as is.
    const message = payload.maintenance === true && serverMessage
      ? serverMessage
      : friendlyError({ message: serverMessage }, fallback);
    const error = new Error(message);
    error.statusCode = response.status;
    // A verification code was already sent recently (no new one is sent).
    if (payload.alreadySent === true) error.alreadySent = true;
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

// AI and Maps can be turned off from the admin website (to control API costs). The
// last known state is kept for this session so screens can skip those features
// (for example, not loading Google Maps) and show a short notice.
const FEATURES_KEY = "sidekick.features";

function isFeatureOn(name) {
  try {
    const features = JSON.parse(sessionStorage.getItem(FEATURES_KEY) || "{}");
    return features[name] !== false;
  } catch (error) {
    return true;
  }
}

function showFeatureNotice(features) {
  const aiOff = features?.ai === false;
  const mapsOff = features?.maps === false;
  if (!aiOff && !mapsOff) return;
  const message = aiOff && mapsOff
    ? "AI and map features are paused right now. Your saved trips and reminders still work."
    : aiOff
      ? "AI features (Sidekick chat and AI itineraries) are paused right now. Your saved trips still work."
      : "Maps and place search are paused right now. Your saved trips and reminders still work.";
  showMaintenanceBanner(message);
}

// While the monthly API budget has paused AI and Maps, travelers are told once per
// visit that Sidekick isn't available, and a banner stays at the top of each screen.
const PAUSED_MESSAGE = "Sidekick isn’t available right now. Please try again later.";
const PAUSED_SHOWN_KEY = "sidekick.pausedNoticeShown";

function showPausedNotice() {
  showMaintenanceBanner(PAUSED_MESSAGE);
  let shown = false;
  try { shown = sessionStorage.getItem(PAUSED_SHOWN_KEY) === "1"; } catch (error) {}
  if (shown || !window.SidekickUI?.alert) return;
  try { sessionStorage.setItem(PAUSED_SHOWN_KEY, "1"); } catch (error) {}
  window.SidekickUI.alert("Please try again later. Your saved trips and reminders still work.", {
    title: "Sidekick isn’t available right now",
    confirmText: "OK",
  });
}

async function checkMaintenanceStatus() {
  try {
    const status = await apiRequest("/api/maintenance-status");
    if (status?.features) {
      try { sessionStorage.setItem(FEATURES_KEY, JSON.stringify(status.features)); } catch (error) {}
    }
    if (status?.maintenance) showMaintenanceBanner(status.message);
    else if (status?.paused) showPausedNotice();
    else showFeatureNotice(status?.features);
    if (!status?.paused) {
      try { sessionStorage.removeItem(PAUSED_SHOWN_KEY); } catch (error) {}
    }
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

// Removes this account's whole chat history on this phone: the current conversation,
// the archived sessions (and their numbering), what Sidekick remembered from the chats,
// a trip it proposed but wasn't saved yet, and the saved scroll position. Saved trips
// and preferences are kept.
function clearChatForEmail(email) {
  const map = getChatByEmail();
  delete map[email];
  setChatByEmail(map);
  [
    "sidekick.chatArchiveByEmail.v1",
    "sidekick.chatCurrentSession.v1",
    "sidekick.aiCompanionByEmail.v2",
    "sidekick.pendingItineraryByEmail.v1",
  ].forEach((key) => {
    try {
      const all = safeJsonParse(localStorage.getItem(key), {});
      if (all && typeof all === "object" && Object.hasOwn(all, email)) {
        delete all[email];
        localStorage.setItem(key, JSON.stringify(all));
      }
    } catch (error) {}
  });
  try { localStorage.removeItem(`sidekick.chatScrollPosition.v1:${String(email || "").trim().toLowerCase()}`); } catch (error) {}
}

function getItineraryByEmail() {
  return safeJsonParse(localStorage.getItem(SIDEKICK_KEYS.itineraryByEmail), {});
}

function getItinerarySyncPayload(itineraryData) {
  const meta = itineraryData?.meta || {};
  const clock = (timestamp) => `${String(new Date(timestamp).getHours()).padStart(2, "0")}:${String(new Date(timestamp).getMinutes()).padStart(2, "0")}`;
  // The trip's own local dates (from its activities). A saved start date can be a UTC
  // timestamp, whose first 10 characters are the day before in the Philippines.
  const range = tripDateRange(itineraryData);
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
        // When the stop ends: its start plus the time planned there. A late stop (a night
        // out) may end after midnight; it is read back as ending the next morning.
        endTime: (() => {
          const start = Number(activity?.dueAt);
          const minutes = Number(activity?.durationMinutes);
          if (!Number.isFinite(start) || !(minutes > 0) || minutes >= 24 * 60) return "";
          return clock(start + minutes * 60000);
        })(),
        estimatedTotalCostPhp: activity?.estimatedTotalCostPhp ?? activity?.estimatedActivityCostPhp ?? null,
        // The Google place, so the server can count how often each place is used
        // (Home's "Popular destinations").
        placeId: activity?.placeId || "",
        lat: Number.isFinite(Number(activity?.locationCoords?.lat)) ? Number(activity.locationCoords.lat) : null,
        lng: Number.isFinite(Number(activity?.locationCoords?.lng)) ? Number(activity.locationCoords.lng) : null,
        photoResource: activity?.photoResource || "",
      })),
    })),
    meta: {
      destination: meta.destination || meta.focusedPlace || "",
      startDate: range.start || String(meta.startDate || new Date().toISOString()).slice(0, 10),
      endDate: range.end || (meta.endDate ? String(meta.endDate).slice(0, 10) : ""),
      budget: meta.budget || "",
      title: meta.title ? String(meta.title).slice(0, 200) : "",
    },
  };
}

function ensureItineraryMonitored(email, itineraryData) {
  // An unsaved draft is not recorded on the server until it is saved.
  if (itineraryData?.meta?.isDraft) return Promise.resolve(itineraryData);
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
    detail: { tripId, message: friendlyError(error, "The itinerary could not be saved online. It is still saved on this phone.") },
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
    const current = findTripByServerId(email, tripId);
    if (!current) return;
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
      const latest = findTripByServerId(email, tripId);
      if (latest
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
  if (email && map?.[email]) mirrorOpenItinerary(email, map[email]);
  if (email && JSON.stringify(priorMap[email]) !== JSON.stringify(map?.[email]) && map?.[email]) {
    scheduleItinerarySync(email, map[email]);
  }
  try {
    document.dispatchEvent(new CustomEvent('sidekick:itinerary-updated'));
  } catch (e) {}
}

// ---- Planned trips ---------------------------------------------------------------------
// A traveler can keep several saved ("planned") trips and one unsaved draft:
//   sidekick.plannedTripsByEmail.v1    email -> [itinerary, ...]  saved (meta.planId)
//   sidekick.itineraryDraftByEmail.v1  email -> itinerary         not saved yet (meta.isDraft)
// The itinerary the rest of the app works with (sidekick.itineraryByEmail.v1) is the one
// open on the Itinerary tab: the draft or one planned trip. Changes to it are copied back
// to its planned trip or to the draft (mirrorOpenItinerary), so editing, reminders, server
// sync, Alerts, chat and the hotel and restaurant lists keep working on it as before.
// A draft has no server record and no reminders until it is saved.
const PLANNED_TRIPS_KEY = "sidekick.plannedTripsByEmail.v1";
const ITINERARY_DRAFT_KEY = "sidekick.itineraryDraftByEmail.v1";

function readEmailMap(key) {
  const map = safeJsonParse(localStorage.getItem(key), {});
  return map && typeof map === "object" ? map : {};
}

function isItineraryData(value) {
  return Boolean(value && Array.isArray(value.itinerary));
}

// "2026-10-21" for a date-only value; a timestamp or ISO date-time -> its local date.
function localDayText(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? localDateValue(date) : "";
}

// The trip's first and last day (local dates, YYYY-MM-DD), from its activities' times
// when it has any, otherwise from its saved dates.
function tripDateRange(data) {
  const dueAts = (data?.itinerary || []).flatMap((day) => (day?.activities || []).map((activity) => Number(activity?.dueAt)))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (dueAts.length) {
    return { start: localDateValue(new Date(Math.min(...dueAts))), end: localDateValue(new Date(Math.max(...dueAts))) };
  }
  const start = localDayText(data?.meta?.startDate);
  let end = localDayText(data?.meta?.endDate);
  if (start && !end) {
    const [y, m, d] = start.split("-").map(Number);
    end = localDateValue(new Date(y, m - 1, d + Math.max(0, (data?.itinerary?.length || 1) - 1)));
  }
  return { start, end: end || start };
}

function tripDisplayName(data) {
  const title = String(data?.meta?.title || "").trim();
  if (title) return title;
  const destination = String(data?.meta?.destination || data?.meta?.focusedPlace || "").trim();
  return destination ? `${destination} trip` : "My trip";
}

function shortDateRangeText(range) {
  const show = (text) => {
    const [y, m, d] = String(text || "").split("-").map(Number);
    return y ? new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  };
  if (!range?.start) return "";
  return range.end && range.end !== range.start ? `${show(range.start)} – ${show(range.end)}` : show(range.start);
}

function getPlannedTrips(email) {
  const list = readEmailMap(PLANNED_TRIPS_KEY)[email];
  return Array.isArray(list) ? list.filter(isItineraryData) : [];
}

function setPlannedTrips(email, list) {
  const map = readEmailMap(PLANNED_TRIPS_KEY);
  const sorted = (Array.isArray(list) ? list.filter(isItineraryData) : [])
    .sort((a, b) => String(tripDateRange(a).start).localeCompare(String(tripDateRange(b).start)));
  if (sorted.length) map[email] = sorted;
  else delete map[email];
  localStorage.setItem(PLANNED_TRIPS_KEY, JSON.stringify(map));
  try { document.dispatchEvent(new CustomEvent("sidekick:planned-trips-updated", { detail: { email } })); } catch (e) {}
}

function getItineraryDraft(email) {
  const draft = readEmailMap(ITINERARY_DRAFT_KEY)[email];
  return isItineraryData(draft) ? draft : null;
}

function setItineraryDraft(email, data) {
  const map = readEmailMap(ITINERARY_DRAFT_KEY);
  if (isItineraryData(data)) map[email] = data;
  else delete map[email];
  localStorage.setItem(ITINERARY_DRAFT_KEY, JSON.stringify(map));
  try { document.dispatchEvent(new CustomEvent("sidekick:planned-trips-updated", { detail: { email } })); } catch (e) {}
}

function newPlanId() {
  return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Copies the open itinerary back to where it belongs: its planned trip, or the draft.
function mirrorOpenItinerary(email, data) {
  if (!isItineraryData(data)) return;
  const planId = data.meta?.planId;
  if (planId) {
    const list = getPlannedTrips(email);
    const index = list.findIndex((trip) => trip.meta?.planId === planId);
    if (index >= 0 && JSON.stringify(list[index]) !== JSON.stringify(data)) {
      list[index] = data;
      setPlannedTrips(email, list);
    }
  } else if (data.meta?.isDraft) {
    if (JSON.stringify(getItineraryDraft(email)) !== JSON.stringify(data)) setItineraryDraft(email, data);
  }
}

// Makes a planned trip (by planId) or the draft (planId "draft") the open itinerary.
function openTripForEmail(email, planId) {
  const trip = planId === "draft" ? getItineraryDraft(email) : getPlannedTrips(email).find((item) => item.meta?.planId === planId);
  if (!trip) return false;
  const map = getItineraryByEmail();
  map[email] = trip;
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  try { document.dispatchEvent(new CustomEvent("sidekick:itinerary-updated")); } catch (e) {}
  return true;
}

// The planned trip whose dates overlap start–end (YYYY-MM-DD), apart from excludePlanId.
function findOverlappingTrip(email, start, end, excludePlanId = null) {
  if (!start) return null;
  const last = end || start;
  return getPlannedTrips(email).find((trip) => {
    if (excludePlanId && trip.meta?.planId === excludePlanId) return false;
    const range = tripDateRange(trip);
    return range.start && !(last < range.start || start > (range.end || range.start));
  }) || null;
}

function tripOverlapMessage(trip) {
  return `These dates overlap your planned trip “${tripDisplayName(trip)}” (${shortDateRangeText(tripDateRange(trip))}). Choose dates that don’t overlap your other trips.`;
}

// Saves an itinerary (the draft, by default) as a planned trip: its dates must not
// overlap another planned trip; it is recorded on the server first (this is when the
// admin's records and reminders start), then moved from the draft into the planned
// trips and kept open.
async function savePlannedTrip(email, data = getItineraryByEmail()[email]) {
  if (!email || !isItineraryData(data) || !data.itinerary.some((day) => (day?.activities || []).length)) {
    throw new Error("There is no itinerary to save yet.");
  }
  const range = tripDateRange(data);
  const clash = findOverlappingTrip(email, range.start, range.end, data.meta?.planId);
  if (clash) throw Object.assign(new Error(tripOverlapMessage(clash)), { overlap: true });
  const result = await apiRequest("/api/app-itineraries/sync", {
    method: "POST",
    body: JSON.stringify(getItinerarySyncPayload(data)),
  });
  const meta = { ...(data.meta || {}), serverTripId: result.tripId, planId: data.meta?.planId || newPlanId(), savedAt: new Date().toISOString() };
  delete meta.isDraft;
  const saved = { ...data, meta };
  setPlannedTrips(email, [...getPlannedTrips(email).filter((trip) => trip.meta?.planId !== meta.planId), saved]);
  if (data.meta?.isDraft || !data.meta?.planId) setItineraryDraft(email, null);
  const state = itinerarySyncStates.get(Number(result.tripId)) || { lastSynced: "", timer: null, inFlight: false, attempts: 0 };
  state.lastSynced = JSON.stringify(getItinerarySyncPayload(saved));
  itinerarySyncStates.set(Number(result.tripId), state);
  const map = getItineraryByEmail();
  map[email] = saved;
  setItineraryByEmail(map);
  return saved;
}

// Removes the unsaved draft (nothing was recorded on the server for it).
function discardItineraryDraft(email) {
  setItineraryDraft(email, null);
  const map = getItineraryByEmail();
  if (map[email]?.meta?.isDraft) {
    delete map[email];
    localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  }
  try { document.dispatchEvent(new CustomEvent("sidekick:itinerary-updated", { detail: { email } })); } catch (e) {}
}

// Removes a planned trip from this phone (and closes it if it was open).
function removePlannedTripLocally(email, planId) {
  if (!planId) return;
  setPlannedTrips(email, getPlannedTrips(email).filter((trip) => trip.meta?.planId !== planId));
  const map = getItineraryByEmail();
  if (map[email]?.meta?.planId === planId) {
    delete map[email];
    localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  }
}

// ---- "Do this trip again" (Past trips) ---------------------------------------------
// When a saved trip finishes, this phone keeps a full copy of it (places, photos, map
// points, costs) so Past trips can plan it again; the server's archive copy only has each
// stop's name, place and times. Kept by server trip ID: the newest 10, for 60 days.
const FINISHED_TRIPS_KEY = "sidekick.finishedTripsByEmail.v1";
const FINISHED_TRIP_LIMIT = 10;
const FINISHED_TRIP_KEEP_MS = 60 * 86400000;

function keepFinishedTripCopy(email, trip) {
  const tripId = Number(trip?.meta?.serverTripId);
  if (!email || !isItineraryData(trip) || !Number.isSafeInteger(tripId) || tripId < 1) return;
  if (!(tripDateRange(trip).end < localDateValue())) return; // only trips that are over
  try {
    const map = readEmailMap(FINISHED_TRIPS_KEY);
    const now = Date.now();
    const kept = Object.entries(map[email] || {})
      .filter(([id, entry]) => Number(id) !== tripId && entry && now - Number(entry.keptAt || 0) < FINISHED_TRIP_KEEP_MS)
      .concat([[String(tripId), { keptAt: now, trip }]])
      .sort((a, b) => Number(b[1].keptAt || 0) - Number(a[1].keptAt || 0))
      .slice(0, FINISHED_TRIP_LIMIT);
    map[email] = Object.fromEntries(kept);
    localStorage.setItem(FINISHED_TRIPS_KEY, JSON.stringify(map));
  } catch (error) { /* storage full or unavailable: Past trips uses the archive copy */ }
}

function getFinishedTripCopy(email, tripId) {
  const entry = readEmailMap(FINISHED_TRIPS_KEY)[email]?.[String(Number(tripId))];
  return isItineraryData(entry?.trip) ? entry.trip : null;
}

function forgetFinishedTripCopies(email, tripIds) {
  try {
    const map = readEmailMap(FINISHED_TRIPS_KEY);
    if (!map[email]) return;
    (tripIds || []).forEach((id) => { delete map[email][String(Number(id))]; });
    if (!Object.keys(map[email]).length) delete map[email];
    localStorage.setItem(FINISHED_TRIPS_KEY, JSON.stringify(map));
  } catch (error) { /* storage unavailable */ }
}

function dateFromValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

// Day `index` of a trip that starts on start (a local date), at hours:minutes.
function tripDayTime(start, index, hours, minutes) {
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + index, hours, minutes, 0, 0).getTime();
}

// An unsaved copy of a finished trip that starts on startDate (YYYY-MM-DD). Every stop
// keeps its day, its order and its time of day. `full` is the copy kept on this phone
// (keepFinishedTripCopy); without it, the Past trips entry from the server is used
// (names, places and times; photos and map points come back as stops are edited).
function repeatTripData(pastTrip, full, startDate) {
  const start = dateFromValue(startDate);
  if (!start) return null;
  let itinerary;
  let meta;
  if (isItineraryData(full)) {
    const oldStart = dateFromValue(tripDateRange(full).start) || dateFromValue(localDayText(full.meta?.startDate)) || start;
    itinerary = full.itinerary.map((day, dayIndex) => ({
      ...day,
      activities: (day?.activities || []).map((activity) => {
        const was = new Date(deriveActivityDueAt(activity, new Date(oldStart.getFullYear(), oldStart.getMonth(), oldStart.getDate() + dayIndex)));
        const dayOffset = Math.round((Date.UTC(was.getFullYear(), was.getMonth(), was.getDate()) - Date.UTC(oldStart.getFullYear(), oldStart.getMonth(), oldStart.getDate())) / 86400000);
        const dueAt = tripDayTime(start, dayOffset, was.getHours(), was.getMinutes());
        // A new trip: last time's "done" / "missed" answers don't carry over.
        const { doneAt, missedAt, ...copy } = activity;
        return { ...copy, id: createItineraryActivityId(), dueAt, iso: new Date(dueAt).toISOString() };
      }),
    }));
    meta = { ...(full.meta || {}) };
  } else {
    const firstDay = dateFromValue(pastTrip?.startDate);
    const days = Array.isArray(pastTrip?.days) ? pastTrip.days : [];
    itinerary = days.map((day, dayIndex) => {
      const dayDate = dateFromValue(day?.date);
      const offset = firstDay && dayDate
        ? Math.round((Date.UTC(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate()) - Date.UTC(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate())) / 86400000)
        : Math.max(0, Number(day?.dayNumber || dayIndex + 1) - 1);
      return {
        activities: (day?.activities || []).filter((activity) => String(activity?.title || "").trim()).map((activity) => {
          const begins = /^(\d{1,2}):(\d{2})/.exec(String(activity.time || ""));
          const ends = /^(\d{1,2}):(\d{2})/.exec(String(activity.endTime || ""));
          const hours = begins ? Number(begins[1]) : 9;
          const minutes = begins ? Number(begins[2]) : 0;
          let length = begins && ends ? (Number(ends[1]) * 60 + Number(ends[2])) - (hours * 60 + minutes) : 0;
          // An end time earlier than the start is after midnight (a night out).
          if (begins && ends && length < 0) length += 24 * 60;
          const dueAt = tripDayTime(start, offset, hours, minutes);
          return {
            id: createItineraryActivityId(),
            title: String(activity.title).trim(),
            location: String(activity.location || "").trim(),
            category: String(activity.type || "").trim() || "activity",
            ...(length > 0 ? { durationMinutes: length } : {}),
            dueAt,
            iso: new Date(dueAt).toISOString(),
          };
        }),
      };
    });
    meta = {
      destination: String(pastTrip?.destination || "").trim(),
      ...(pastTrip?.budget ? { budget: String(pastTrip.budget) } : {}),
    };
    const title = String(pastTrip?.title || "").trim();
    if (title && title.toLowerCase() !== `${meta.destination} itinerary`.toLowerCase()) meta.title = title;
  }
  if (!itinerary.some((day) => day.activities.length)) return null;
  const normalized = normalizeItineraryData({ itinerary, meta: { ...meta, startDate } });
  const range = tripDateRange(normalized);
  const newMeta = {
    ...meta,
    startDate: range.start,
    endDate: range.end,
    durationDays: normalized.itinerary.length,
    // Not saved yet: no server record and no reminders until "Save itinerary".
    isDraft: true,
    repeatedFromPastTrip: true,
  };
  // The archive keeps the budget as a label ("PHP 5,000 total"): its amount sets the
  // budget targets and the hotel and restaurant price limits.
  if (!(Number(newMeta.budgetAmountPhp) > 0)) {
    const amount = Number(String(newMeta.budget || "").replace(/,/g, "").match(/\d+(\.\d+)?/)?.[0]);
    if (amount > 0) newMeta.budgetAmountPhp = Math.floor(amount);
  }
  // Prices already researched for these places are reused (only new places are searched);
  // the totals are worked out again for the new dates.
  ["serverTripId", "planId", "savedAt", "liveTripBudgetCacheKey", "liveTripBudgetCachedAt"].forEach((key) => { delete newMeta[key]; });
  return { ...normalized, meta: newMeta };
}

// Why a repeated trip can't start on its dates, or null: the start date has passed,
// day 1's first stop is already too soon today, or it overlaps a planned trip.
function repeatTripProblem(email, data) {
  const range = tripDateRange(data);
  const today = localDateValue();
  if (!range.start || range.start < today) {
    return { title: "Start date has passed", message: "That date has already passed. Choose today or a later date to start your trip." };
  }
  const earliest = firstDayStartMinute(range.start);
  if (earliest !== null) {
    const firstStop = Math.min(...(data.itinerary || []).flatMap((day) => (day.activities || []).map((activity) => Number(activity.dueAt)))
      .filter((dueAt) => Number.isFinite(dueAt) && localDateValue(new Date(dueAt)) === today));
    const first = new Date(firstStop);
    if (Number.isFinite(firstStop) && first.getHours() * 60 + first.getMinutes() < earliest) {
      const shown = first.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return { title: "Too late to start today", message: `Day 1 of this trip starts at ${shown}, which is too soon or has already passed. Start it tomorrow or later.` };
    }
  }
  const clash = findOverlappingTrip(email, range.start, range.end);
  if (clash) return { title: "Those dates are taken", message: tripOverlapMessage(clash) };
  return null;
}

// Opens a repeated trip as the unsaved itinerary (it replaces any earlier unsaved one).
function openRepeatedTrip(email, data) {
  if (!email || !isItineraryData(data)) return false;
  setItineraryDraft(email, data);
  const map = getItineraryByEmail();
  map[email] = data;
  setItineraryByEmail(map);
  return true;
}

// An itinerary from before planned trips existed counts as a saved planned trip.
function migrateOpenItineraryToPlannedTrips(email) {
  const map = getItineraryByEmail();
  const open = map[email];
  if (!isItineraryData(open) || open.meta?.planId || open.meta?.isDraft) return;
  const planId = newPlanId();
  const trip = { ...open, meta: { ...(open.meta || {}), planId } };
  const list = getPlannedTrips(email);
  const tripId = Number(open.meta?.serverTripId);
  const already = Number.isSafeInteger(tripId) && tripId > 0 && list.some((item) => Number(item.meta?.serverTripId) === tripId);
  if (!already) setPlannedTrips(email, [...list, trip]);
  map[email] = already ? list.find((item) => Number(item.meta?.serverTripId) === tripId) : trip;
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
}

try {
  const signedIn = getAuthSession();
  if (signedIn?.email) migrateOpenItineraryToPlannedTrips(signedIn.email);
} catch (error) { /* storage unavailable */ }

// The open itinerary, or the planned trip, with this server trip ID.
function findTripByServerId(email, tripId) {
  const open = getItineraryByEmail()[email];
  if (Number(open?.meta?.serverTripId) === Number(tripId)) return open;
  return getPlannedTrips(email).find((trip) => Number(trip.meta?.serverTripId) === Number(tripId)) || null;
}

async function clearItineraryForEmail(email) {
  let map = getItineraryByEmail();
  let itineraryData = map[email];
  if (itineraryData?.meta?.isDraft) {
    discardItineraryDraft(email);
    return;
  }
  const planId = itineraryData?.meta?.planId || null;
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
  map = getItineraryByEmail();
  delete map[email];
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  if (planId) removePlannedTripLocally(email, planId);
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
  keepFinishedTripCopy(email, current);
  delete map[email];
  localStorage.setItem(SIDEKICK_KEYS.itineraryByEmail, JSON.stringify(map));
  if (current.meta?.planId) removePlannedTripLocally(email, current.meta.planId);
  // Reminders for the other planned trips stay; only this trip's are dropped.
  if (getPlannedTrips(email).length) window.SidekickCore?.syncRemindersFromItinerary?.(email);
  else window.SidekickCore?.clearItineraryRemindersForEmail?.(email);
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
  { interest: "Beaches", words: ["beach", "island", "laiya", "nasugbu", "calatagan", "masasa", "fortune island"] },
  { interest: "Water Sports", words: ["snorkel", "scuba", "kayak", "water", "diving", "boat"] },
  { interest: "Island Hopping", words: ["hop", "hopping", "cruise", "tour"] },
  { interest: "Mountains", words: ["mountain", "hike", "hiking", "batulao", "maculot", "taal volcano", "scenery"] },
  { interest: "Hiking", words: ["trail", "hiking", "trek", "walk"] },
  { interest: "Historical Sites", words: ["history", "museum", "taal", "heritage", "church", "basilica", "lighthouse"] },
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

// Simple, offline “knowledge base” tagged by interests. Sidekick covers the province of
// Batangas only, so every place here is in Batangas.
const PLACES = [
  { name: "Taal Volcano", region: "Batangas", lat: 14.0113, lng: 120.9980, tags: ["Mountains", "Hiking", "Photography", "Nature & Wildlife"] },
  { name: "Anilao, Mabini", region: "Batangas", lat: 13.7603, lng: 120.9254, tags: ["Water Sports", "Beaches", "Island Hopping", "Photography"] },
  { name: "Laiya Beach, San Juan", region: "Batangas", lat: 13.6697, lng: 121.4022, tags: ["Beaches", "Water Sports", "Nightlife"] },
  { name: "Fortune Island, Nasugbu", region: "Batangas", lat: 14.0581, lng: 120.4956, tags: ["Island Hopping", "Beaches", "Photography"] },
  { name: "Masasa Beach, Tingloy", region: "Batangas", lat: 13.6550, lng: 120.8960, tags: ["Beaches", "Island Hopping", "Water Sports"] },
  { name: "Mount Batulao, Nasugbu", region: "Batangas", lat: 14.0400, lng: 120.8000, tags: ["Mountains", "Hiking", "Photography", "Nature & Wildlife"] },
  { name: "Mount Maculot, Cuenca", region: "Batangas", lat: 13.9200, lng: 121.0450, tags: ["Mountains", "Hiking", "Photography"] },
  { name: "Taal Heritage Town", region: "Batangas", lat: 13.8800, lng: 120.9230, tags: ["Historical Sites", "Photography", "Local Cuisine", "Shopping"] },
  { name: "Basilica of St. Martin de Tours, Taal", region: "Batangas", lat: 13.8817, lng: 120.9236, tags: ["Historical Sites", "Photography"] },
  { name: "Cape Santiago Lighthouse, Calatagan", region: "Batangas", lat: 13.7660, lng: 120.6560, tags: ["Historical Sites", "Photography", "Beaches"] },
  { name: "Lipa City Food Trip", region: "Batangas", lat: 13.9411, lng: 121.1631, tags: ["Local Cuisine", "Shopping", "Nightlife"] },
  { name: "Batangas City Lomi Houses", region: "Batangas", lat: 13.7565, lng: 121.0583, tags: ["Local Cuisine"] },
];

function scorePlaceByInterests(place, interests) {
  const tags = new Set(place.tags || []);
  let score = 0;
  for (const i of interests || []) score += tags.has(i) ? 2 : 0;
  if (interests?.length) score += Math.min(2, (place.tags || []).filter((t) => (interests || []).includes(t)).length);
  return score;
}

// Top, widely known tourist spots in Batangas. Used for the general
// "Popular destinations" section (independent of the user's preferences).
// Most people on one trip (see normalizeTravelers). Defined before window.SidekickCore,
// which exports it.
const MAX_TRAVELERS = 10;

// Well-known Batangas spots, each tagged with the onboarding interests it suits, so
// onboarding can suggest the places that match what the traveler picked.
const POPULAR_PH_SPOTS = [
  { name: "Taal Volcano", region: "Batangas", lat: 14.0113, lng: 120.9980, interests: ["Hiking", "Mountains", "Photography"] },
  { name: "Anilao, Mabini", region: "Batangas", lat: 13.7603, lng: 120.9254, interests: ["Water Sports", "Beaches", "Island Hopping"] },
  { name: "Laiya Beach, San Juan", region: "Batangas", lat: 13.6697, lng: 121.4022, interests: ["Beaches", "Water Sports", "Nightlife"] },
  { name: "Fortune Island, Nasugbu", region: "Batangas", lat: 14.0581, lng: 120.4956, interests: ["Island Hopping", "Beaches", "Photography", "Water Sports"] },
  { name: "Masasa Beach, Tingloy", region: "Batangas", lat: 13.6550, lng: 120.8960, interests: ["Beaches", "Island Hopping"] },
  { name: "Taal Heritage Town", region: "Batangas", lat: 13.8800, lng: 120.9230, interests: ["Historical Sites", "Local Cuisine", "Photography", "Shopping"] },
  { name: "Mount Batulao, Nasugbu", region: "Batangas", lat: 14.0400, lng: 120.8000, interests: ["Hiking", "Mountains"] },
  { name: "Mount Maculot, Cuenca", region: "Batangas", lat: 13.9200, lng: 121.0450, interests: ["Hiking", "Mountains", "Photography"] },
  { name: "Cape Santiago Lighthouse, Calatagan", region: "Batangas", lat: 13.7660, lng: 120.6560, interests: ["Historical Sites", "Photography", "Beaches"] },
  { name: "Malabrigo Lighthouse, Lobo", region: "Batangas", lat: 13.5960, lng: 121.2610, interests: ["Historical Sites", "Photography", "Beaches"] },
  { name: "San Sebastian Cathedral, Lipa", region: "Batangas", lat: 13.9411, lng: 121.1631, interests: ["Historical Sites", "Photography"] },
  { name: "Nasugbu Beaches", region: "Batangas", lat: 14.0670, lng: 120.6330, interests: ["Beaches", "Water Sports"] },
  { name: "Pico de Loro, Nasugbu", region: "Batangas", lat: 14.2140, lng: 120.6400, interests: ["Hiking", "Mountains", "Photography"] },
  { name: "Mount Gulugod Baboy, Mabini", region: "Batangas", lat: 13.7180, lng: 120.9130, interests: ["Hiking", "Mountains", "Photography"] },
  { name: "Verde Island, Batangas City", region: "Batangas", lat: 13.5500, lng: 121.0700, interests: ["Water Sports", "Island Hopping", "Beaches"] },
  { name: "Calatagan Beaches", region: "Batangas", lat: 13.8320, lng: 120.6300, interests: ["Beaches", "Photography"] },
  { name: "Lipa City", region: "Batangas", lat: 13.9411, lng: 121.1631, interests: ["Local Cuisine", "Shopping", "Historical Sites"], town: true },
  { name: "Batangas City", region: "Batangas", lat: 13.7565, lng: 121.0583, interests: ["Local Cuisine", "Nightlife", "Shopping"], town: true },
];

// ---- Onboarding choices -------------------------------------------------------------
// Each travel style leads to the interests that fit it; each interest to the Batangas
// spots above. Onboarding shows only what follows from the earlier answers, and Home
// recommends places from the same answers.
const TRAVEL_STYLE_OPTIONS = [
  { name: "Adventure", detail: "Hikes, volcano treks and water sports", interests: ["Hiking", "Mountains", "Water Sports", "Island Hopping", "Photography"] },
  { name: "Beach & Relaxation", detail: "White sand, clear water, slow days", interests: ["Beaches", "Island Hopping", "Water Sports", "Photography"] },
  { name: "Cultural", detail: "Heritage towns, churches and history", interests: ["Historical Sites", "Local Cuisine", "Photography", "Shopping"] },
  { name: "Food Tour", detail: "Lomi, bulalo, kapeng barako and more", interests: ["Local Cuisine", "Nightlife", "Shopping"] },
  { name: "Nature & Wildlife", detail: "Mountains, reefs, islands and views", interests: ["Mountains", "Hiking", "Beaches", "Island Hopping", "Photography"] },
  { name: "City Exploration", detail: "Town centers, shops and night spots", interests: ["Shopping", "Nightlife", "Local Cuisine", "Historical Sites"] },
];

const INTEREST_OPTIONS = [
  { name: "Beaches", detail: "Laiya, Nasugbu, Calatagan, Masasa" },
  { name: "Island Hopping", detail: "Fortune Island, Verde Island, Tingloy" },
  { name: "Water Sports", detail: "Diving and snorkeling in Anilao" },
  { name: "Hiking", detail: "Trails to Batulao, Maculot, Pico de Loro" },
  { name: "Mountains", detail: "Taal Volcano and ridge views" },
  { name: "Historical Sites", detail: "Taal Heritage Town, old churches, lighthouses" },
  { name: "Photography", detail: "Lighthouses, sunsets and viewpoints" },
  { name: "Local Cuisine", detail: "Batangas lomi, bulalo, kapeng barako" },
  { name: "Shopping", detail: "Pasalubong, embroidery and local crafts" },
  { name: "Nightlife", detail: "Night markets, beach parties, city nights" },
];

// Interests that fit the chosen travel styles (all of them when none is chosen).
function interestsForTravelStyles(styles) {
  const chosen = TRAVEL_STYLE_OPTIONS.filter((option) => (styles || []).includes(option.name));
  if (!chosen.length) return INTEREST_OPTIONS.slice();
  const wanted = new Set(chosen.flatMap((option) => option.interests));
  return INTEREST_OPTIONS.filter((option) => wanted.has(option.name));
}

// Batangas spots for the chosen interests, best match first: { matches, others }.
function spotsForInterests(interests) {
  const wanted = new Set(interests || []);
  const scored = POPULAR_PH_SPOTS.map((spot, index) => ({
    spot,
    index,
    score: (spot.interests || []).filter((interest) => wanted.has(interest)).length,
  }));
  const matches = scored.filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.spot);
  const others = scored.filter((item) => item.score === 0).map((item) => item.spot);
  return { matches, others };
}

function buildPopularDestinations() {
  // Whole towns (picked in onboarding for food, shopping and nights out) aren't spots.
  return POPULAR_PH_SPOTS.filter((spot) => !spot.town).map((spot) => ({ ...spot, tags: ["Tourist Attraction"] }));
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
  // Sidekick covers Batangas only: destinations picked elsewhere (before the app was
  // limited to Batangas) are left out of Home.
  return out.filter(isBatangasDestination).slice(0, 5);
}

// A saved destination in Batangas: its name or area says Batangas, its pin is in the
// province's box, or it is one of the app's own Batangas places.
function isBatangasDestination(dest) {
  const text = `${dest?.name || ""} ${dest?.region || ""} ${dest?.address || ""}`;
  if (/\bbatangas\b/i.test(text)) return true;
  const lat = Number(dest?.lat);
  const lng = Number(dest?.lng);
  if (dest?.lat != null && dest?.lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    return lat >= 13.45 && lat <= 14.30 && lng >= 120.45 && lng <= 121.55
      && !/\b(cavite|laguna|quezon|mindoro|manila|rizal)\b/i.test(text);
  }
  return PLACES.some((place) => place.name.toLowerCase() === String(dest?.name || "").trim().toLowerCase());
}

function buildDashboardRecommendations(prefs) {
  const interests = prefs?.interests || [];
  const budget = prefs?.budget || "";
  const travelTypes = prefs?.travelTypes || [];

  // The user's chosen destinations come first, then interest-matched places.
  const preferredDestinations = getPreferredDestinations(prefs).map((d) => ({
    ...d,
    region: d.region || "Batangas",
    tags: d.tags || ["Preferred destination"],
  }));
  const preferredNames = new Set(preferredDestinations.map((d) => d.name.toLowerCase()));
  const recommended = preferredDestinations.concat(
    PLACES
      .filter((p) => !preferredNames.has(p.name.toLowerCase()))
      .sort((a, b) => scorePlaceByInterests(b, interests) - scorePlaceByInterests(a, interests)),
  ).slice(0, 8);

  // "Popular" is a general list of top tourist spots in Batangas.
  const popularDestinations = buildPopularDestinations();

  return { recommended, popularDestinations };
}

const REGION_CLUSTER = {
  Batangas: "Luzon",
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
  // Meal and rest breaks belong to a day, not to a stop: remember which original day
  // each stop came from, so the breaks can follow their day after regrouping.
  const originalDayOf = new Map();

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
      originalDayOf.set(normalizedActivity, dayIndex);
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
  const usedBreakDays = new Set();
  const normalizedDays = orderedDayKeys.map((dayKey, index) => {
    const activities = (dayGroups.get(dayKey) || []).slice().sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
    // The breaks of the original day most of these stops came from (each used once).
    const counts = new Map();
    activities.forEach((activity) => {
      const from = originalDayOf.get(activity);
      if (from !== undefined) counts.set(from, (counts.get(from) || 0) + 1);
    });
    const source = Array.from(counts.entries())
      .filter(([from]) => !usedBreakDays.has(from) && Array.isArray(itineraryData.itinerary[from]?.breaks))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (source !== undefined) usedBreakDays.add(source);
    return {
      dayNumber: index + 1,
      dateLabel: formatItineraryDayLabel(new Date(dayKey)),
      ...estimateDayBudgetRange(activities),
      activities,
      ...(source !== undefined ? { breaks: itineraryData.itinerary[source].breaks } : {}),
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
  // The activity is in the open itinerary or in one of the planned trips.
  const containsActivity = (data) => (data?.itinerary || []).some((day) => (day.activities || []).some((activity) => (
    activityId ? activity.id === activityId
      : Number(activity?.dueAt || 0) === Number(parentDueAt || 0) && String(activity?.title || "") === String(parentTitle || "")
  )));
  const source = containsActivity(map[email]) ? map[email] : getPlannedTrips(email).find(containsActivity);
  const isOpen = source === map[email];
  const itineraryData = normalizeItineraryData(source);
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

  const updated = normalizeItineraryData(itineraryData);
  if (isOpen) {
    map[email] = updated;
    setItineraryByEmail(map);
  } else {
    setPlannedTrips(email, getPlannedTrips(email).map((trip) => (trip.meta?.planId === updated.meta?.planId ? updated : trip)));
    scheduleItinerarySync(email, updated);
  }
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

// Sidekick's first chat message: a short, friendly welcome with the user's first name.
function getInitialAssistantMessage() {
  const name = String(getAuthSession()?.name || "").trim();
  const firstName = name && name !== "Pending registration" ? name.split(/\s+/)[0] : "";
  return `Hello${firstName ? `, ${firstName}` : ""}! Welcome to Sidekick. Where would you like to go today?`;
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
  friendlyError,
  isOnline,
  waitForOnline,
  getUsers,
  setUsers,
  getAuthSession,
  setAuthSession,
  clearAuthSession,
  normalizeEmail,
  isStrongEnoughPassword,
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
  MAX_TRAVELERS,
  normalizeTravelers,
  roomsForTravelers,
  travelersLabel,
  TRAVEL_STYLE_OPTIONS,
  INTEREST_OPTIONS,
  interestsForTravelStyles,
  spotsForInterests,
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
  isFeatureOn,
  checkTripBudget,
  startBuildProgress,
  getPlannedTrips,
  getItineraryDraft,
  openTripForEmail,
  savePlannedTrip,
  discardItineraryDraft,
  findOverlappingTrip,
  tripOverlapMessage,
  tripDateRange,
  tripDisplayName,
  shortDateRangeText,
  getFinishedTripCopy,
  forgetFinishedTripCopies,
  repeatTripData,
  repeatTripProblem,
  openRepeatedTrip,
  firstDayStartMinute,
  localDateValue,
  describeUnrealisticBudget,
  tripBudgetKey,
};

// ---- Trip budget check -------------------------------------------------------
// Used by every "Build itinerary" button before anything is generated. The backend
// compares the budget with the cheapest restaurant and hotel prices it finds.
const tripBudgetResults = new Map();

function tripBudgetKey({ destination, startDate, endDate, budgetAmountPhp, travelers = 1 }) {
  const people = normalizeTravelers(travelers);
  return [String(destination || "").trim().toLowerCase(), startDate, endDate, Number(budgetAmountPhp), ...(people > 1 ? [people] : [])].join("|");
}

// ---- Group trips --------------------------------------------------------------------
// How many people travel together: 1 to 10 (the usual barkada or family trip). Budgets,
// rooms, meals and entrance fees are worked out for the whole group. The server uses
// the same rules (normalizeTravelers in server.js).

function normalizeTravelers(value) {
  const count = Math.round(Number(value));
  return Number.isFinite(count) && count >= 1 ? Math.min(MAX_TRAVELERS, count) : 1;
}

// Rooms a group needs: two people share a room.
function roomsForTravelers(travelers) {
  return Math.ceil(normalizeTravelers(travelers) / 2);
}

function travelersLabel(travelers) {
  const count = normalizeTravelers(travelers);
  return count === 1 ? "1 traveler" : `${count} travelers`;
}

// Resolves to the backend's result, or null when the check could not run
// (offline, rate limited...). A failed check never blocks building a trip.
// The most a trip budget may be per day. Anything above it (₱1,000,000 for 3 days, say)
// is not a real budget, so no itinerary is built for it. The server checks this too.
const MAX_BUDGET_PER_DAY_PHP = 100000;

// Today's date on this phone, as YYYY-MM-DD.
function localDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// For a trip that starts today: the earliest time day 1 can begin, in minutes after
// midnight (about half an hour from now, on the quarter hour). null for a later start
// date. A value of 1440 or more means today is already over.
function firstDayStartMinute(startDate, now = new Date()) {
  if (String(startDate || "").slice(0, 10) !== localDateValue(now)) return null;
  return Math.ceil((now.getHours() * 60 + now.getMinutes() + 30) / 15) * 15;
}

function inclusiveTripDays(startDate, endDate) {
  const start = Date.parse(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${String(endDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

async function checkTripBudget({ destination, placeId = "", lat = null, lng = null, startDate, endDate, budgetAmountPhp, travelers = 1 }) {
  const people = normalizeTravelers(travelers);
  const key = tripBudgetKey({ destination, startDate, endDate, budgetAmountPhp, travelers: people });
  if (tripBudgetResults.has(key)) return tripBudgetResults.get(key);
  // Far too much money for the trip: decided right here, without asking the server.
  const days = inclusiveTripDays(startDate, endDate);
  const amount = Number(budgetAmountPhp);
  if (days >= 1 && Number.isFinite(amount) && amount > MAX_BUDGET_PER_DAY_PHP * days * people) {
    return { checked: true, realistic: false, tooHigh: true, budgetAmountPhp: amount, days, travelers: people, maximumPhp: MAX_BUDGET_PER_DAY_PHP * days * people };
  }
  try {
    const result = await apiRequest("/api/trip/budget-check", {
      method: "POST",
      body: JSON.stringify({ destination, placeId, lat, lng, startDate, endDate, budgetAmountPhp, travelers: people }),
    });
    if (result && result.checked) tripBudgetResults.set(key, result);
    return result || null;
  } catch (error) {
    console.warn("Budget check unavailable:", error.message);
    return null;
  }
}

// ---- Itinerary build progress --------------------------------------------------------
// While an itinerary is built, the loading screen shows a percentage and what is
// happening. The server reports its stage (GET /api/itinerary/progress); between reports
// the number keeps creeping toward the next stage, and it never goes back. Without
// reports (offline, an older server) it follows the time a build usually takes, up to 90%.
// Returns { id, finish(success) }: send id as progressId with the build request.
function startBuildProgress(label = "Building your itinerary…") {
  const ui = window.SidekickUI?.loading;
  const rawId = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const id = String(rawId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const startedAt = Date.now();
  let shown = 0;
  let server = null;
  let serverAt = 0;
  let text = label;
  let stopped = false;
  let polling = false;
  ui?.show(label);
  ui?.progress?.(0, label);
  const tick = () => {
    if (stopped) return;
    let target;
    if (server) {
      const since = (Date.now() - serverAt) / 1000;
      const span = Math.max(0, server.next - server.percent - 1);
      target = server.percent + span * (1 - Math.exp(-since / 12));
    } else {
      target = 90 * (1 - Math.exp(-(Date.now() - startedAt) / 30000));
    }
    shown = Math.max(shown, Math.min(99, target));
    ui?.progress?.(shown, text);
  };
  const frameTimer = setInterval(tick, 250);
  const pollTimer = setInterval(async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const data = await apiRequest(`/api/itinerary/progress?id=${encodeURIComponent(id)}`, { waitForConnection: false });
      const percent = Number(data?.percent);
      if (!stopped && data?.found && Number.isFinite(percent)) {
        if (!server || server.percent !== percent) {
          server = { percent, next: Number.isFinite(Number(data.next)) ? Number(data.next) : percent + 5 };
          serverAt = Date.now();
        }
        if (data.label) text = `${data.label}…`;
      }
    } catch (error) {
      // No report this time: the estimate keeps the number moving.
    } finally {
      polling = false;
    }
  }, 800);
  return {
    id,
    async finish(success = true) {
      if (stopped) return;
      stopped = true;
      clearInterval(frameTimer);
      clearInterval(pollTimer);
      if (success) {
        ui?.progress?.(100, "Your itinerary is ready");
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      ui?.hide();
    },
  };
}

// Plain-language explanation of an unrealistic budget for an error message.
function describeUnrealisticBudget(result, destination) {
  const peso = (amount) => `₱${Math.round(Number(amount) || 0).toLocaleString()}`;
  if (result.outOfScope) {
    return { title: "Batangas only", message: result.message || "Sidekick plans trips in the province of Batangas only. Choose a place in Batangas.", details: [] };
  }
  const days = Number(result.days) || 1;
  const people = normalizeTravelers(result.travelers);
  const group = people > 1 ? ` for ${people} travelers` : "";
  if (result.tooHigh) {
    const maximum = Number(result.maximumPhp) || MAX_BUDGET_PER_DAY_PHP * days * people;
    return {
      title: "This budget is too high",
      message: `${peso(result.budgetAmountPhp)} is far more than ${days} day${days === 1 ? "" : "s"} in ${destination}${group} could use, so Sidekick can’t plan a realistic trip with it. Enter a budget of up to ${peso(maximum)} (${peso(MAX_BUDGET_PER_DAY_PHP * people)} a day${group}).`,
      details: [["Your budget", peso(result.budgetAmountPhp)], ["Trip length", `${days} day${days === 1 ? "" : "s"}`], ...(people > 1 ? [["Group", travelersLabel(people)]] : []), ["Highest budget Sidekick plans for", peso(maximum)]],
    };
  }
  const meals = result.meals || {};
  const lodging = result.lodging || {};
  const details = [["Your budget", peso(result.budgetAmountPhp)]];
  if (lodging.needed && lodging.totalPhp > 0) {
    const label = lodging.source === "researched" && lodging.name ? `Cheapest hotel found (${lodging.name})` : "Cheapest rooms";
    const rooms = Number(lodging.rooms) || 1;
    details.push([label, `${peso(lodging.nightlyLowPhp)} a night × ${lodging.nights} night${lodging.nights === 1 ? "" : "s"}${rooms > 1 ? ` × ${rooms} rooms` : ""}`]);
  }
  const mealLabel = meals.estimated ? "Basic meals" : `Cheapest meals found${meals.name ? ` (${meals.name})` : ""}`;
  details.push([mealLabel, `${peso(meals.perMealPhp)} × ${meals.mealsPerDay || 2} a day × ${days} day${days === 1 ? "" : "s"}${people > 1 ? ` × ${people} people` : ""}`]);
  details.push(["Lowest realistic cost", peso(result.minimumPhp)]);
  const shorter = result.maxAffordableDays >= 1 && result.maxAffordableDays < days
    ? ` or shorten the trip to ${result.maxAffordableDays} day${result.maxAffordableDays === 1 ? "" : "s"}`
    : "";
  return {
    title: "This budget isn't realistic",
    message: `${peso(result.budgetAmountPhp)} isn't enough for ${days} day${days === 1 ? "" : "s"} in ${destination}${group}, even at the cheapest prices we found. Raise your budget to at least ${peso(result.minimumPhp)}${shorter}.`,
    details,
  };
}

// "I'm online" heartbeat and the saved-trip check. Each tab is its own page, so this
// starts again on every tab change: the last times are kept for the browsing session,
// so switching tabs (or coming back to the app, which fires two events) doesn't send
// them again until they are due.
const HEARTBEAT_EVERY_MS = 60_000;
const ITINERARY_CHECK_EVERY_MS = 5 * 60_000;
const HEARTBEAT_LAST_KEY = "sidekick.presence.lastSent";
const ITINERARY_CHECK_LAST_KEY = "sidekick.itineraryCheck.lastRun";

function dueSince(key, everyMs) {
  try {
    const last = Number(sessionStorage.getItem(key) || 0);
    return !(last > 0 && Date.now() - last < everyMs);
  } catch (error) {
    return true;
  }
}

function markDone(key) {
  try { sessionStorage.setItem(key, String(Date.now())); } catch (error) { /* storage unavailable */ }
}

function startAppPresenceHeartbeat() {
  let requestInProgress = false;
  let lastErrorAt = 0;
  let itineraryCheckInProgress = false;
  let lastItineraryCheckErrorAt = 0;

  async function verifyStoredItinerary() {
    const session = getAuthSession();
    if (!session?.email || !session?.apiToken || document.visibilityState !== "visible" || itineraryCheckInProgress) return;
    if (!dueSince(ITINERARY_CHECK_LAST_KEY, ITINERARY_CHECK_EVERY_MS - 5_000)) return;
    const email = session.email;
    const trips = getPlannedTrips(email);
    const draft = getItineraryDraft(email);
    if (!trips.length && !draft) return;
    itineraryCheckInProgress = true;
    markDone(ITINERARY_CHECK_LAST_KEY);
    try {
      let removed = false;
      // Each planned trip: gone from the server (expired or deleted), or past its last day + retention.
      for (const trip of trips) {
        const tripId = Number(trip.meta?.serverTripId);
        const hasServerTripId = Number.isSafeInteger(tripId) && tripId > 0;
        const retention = await apiRequest(`/api/app-itineraries/retention${hasServerTripId ? `?tripId=${encodeURIComponent(tripId)}` : ""}`);
        const endDate = tripDateRange(trip).end;
        const passedRetentionDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate < String(retention.expiredBeforeDate || "");
        if ((hasServerTripId && !retention.tripAvailable) || passedRetentionDate) {
          keepFinishedTripCopy(email, trip);
          removePlannedTripLocally(email, trip.meta?.planId);
          removed = true;
        }
      }
      // A draft whose last day has already gone by is no longer useful.
      if (draft && tripDateRange(draft).end && tripDateRange(draft).end < localDateValue()) {
        discardItineraryDraft(email);
        removed = true;
      }
      if (removed) {
        if (getPlannedTrips(email).length) window.SidekickCore?.syncRemindersFromItinerary?.(email);
        else window.SidekickCore?.clearItineraryRemindersForEmail?.(email);
        document.dispatchEvent(new CustomEvent("sidekick:itinerary-updated", { detail: { email } }));
        if (window.location.pathname.endsWith("/itinerary.html")) window.setTimeout(() => window.location.reload(), 0);
      }
      lastItineraryCheckErrorAt = 0;
    } catch (error) {
      if (Date.now() - lastItineraryCheckErrorAt > 60_000) {
        console.warn("Unable to verify the saved itineraries' retention status:", error.message);
        lastItineraryCheckErrorAt = Date.now();
      }
    } finally {
      itineraryCheckInProgress = false;
    }
  }

  async function sendHeartbeat() {
    const session = getAuthSession();
    if (!session?.email || !session?.apiToken || document.visibilityState !== "visible" || !document.hasFocus() || requestInProgress) return;
    // Sent within the last minute (on this or the previous screen): not due yet.
    if (!dueSince(HEARTBEAT_LAST_KEY, HEARTBEAT_EVERY_MS - 5_000)) return;
    requestInProgress = true;
    markDone(HEARTBEAT_LAST_KEY);
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
  window.setInterval(sendHeartbeat, HEARTBEAT_EVERY_MS);
  window.setInterval(verifyStoredItinerary, ITINERARY_CHECK_EVERY_MS);
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
          // Screens without the tab bar (Settings, Past trips) need no room for it.
          if (el.classList.contains('bottom-nav') && document.body?.getAttribute('data-nav') === 'away') continue;
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
      container.style.paddingBottom = `calc(${overlayHeight}px + var(--sk-safe-bottom, env(safe-area-inset-bottom)) + 12px)`;
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
  // Test notifications rotate through their own IDs (above every reminder ID, which
  // stays at or below 2147483000). Reusing one ID made repeated taps silent: the
  // plugin alerts only once per ID, so a new test just replaced the one still in
  // the tray without sound, and each tap also pushed the pending one back.
  const TEST_NOTIFICATION_ID_BASE = 2147483100;
  const TEST_NOTIFICATION_ID_COUNT = 40;
  const TEST_SEQUENCE_KEY = 'sidekick.testNotificationSeq';

  function nextTestNotificationId() {
    let seq = 0;
    try { seq = (Number(localStorage.getItem(TEST_SEQUENCE_KEY)) || 0) + 1; } catch (e) { seq = Date.now(); }
    seq %= TEST_NOTIFICATION_ID_COUNT;
    try { localStorage.setItem(TEST_SEQUENCE_KEY, String(seq)); } catch (e) {}
    return TEST_NOTIFICATION_ID_BASE + seq;
  }

  // True when the phone has switched off this reminder channel in its settings
  // (Android keeps the channel but drops its notifications silently).
  async function isChannelBlocked(channelId) {
    try {
      if (typeof LocalNotifications.listChannels !== 'function') return false;
      const result = await LocalNotifications.listChannels();
      const channel = (result?.channels || []).find((item) => item.id === channelId);
      return Boolean(channel) && Number(channel.importance) === 0;
    } catch (e) {
      return false;
    }
  }
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

    // Cancel what is still waiting to fire for this account, including reminders that
    // were deleted since (they show up as pending), then schedule afresh. Reminders
    // whose time has passed are left alone: cancelling them also removed notifications
    // the user had already received from the phone's notification tray.
    const now = Date.now();
    const cancelIds = new Set(list
      .filter((r) => Number(r.dueAt || 0) > now)
      .map((r) => reminderNotificationId(email, r.id)));
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
    if (await isChannelBlocked(channel.id)) {
      return { ok: false, message: `Sidekick’s “${channel.name}” notifications are turned off on this phone. Turn them on in Settings → Apps → Sidekick → Notifications.` };
    }
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: nextTestNotificationId(),
          title: 'Sidekick test notification',
          body: 'Reminders will look and sound like this.',
          channelId: channel.id,
          ...(channel.sound ? { sound: channel.sound } : {}),
          schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true },
          extra: { email, test: true },
        }],
      });
    } catch (e) {
      return { ok: false, message: 'The test notification could not be sent. Please check that notifications are allowed for Sidekick, then try again.' };
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
      // Reminders come from every planned (saved) trip; an unsaved draft has none.
      const map = getItineraryByEmail();
      if (map[email]?.meta?.planId) {
        map[email] = normalizeItineraryData(map[email]);
        setItineraryByEmail(map);
      }
      const stored = getPlannedTrips(email);
      const trips = stored.map((trip) => normalizeItineraryData(trip)).filter((trip) => trip && Array.isArray(trip.itinerary));
      // Activities given an ID just now keep it, so each reminder keeps its on/off state.
      if (stored.some((trip) => trip.itinerary.some((day) => (day?.activities || []).some((activity) => !activity?.id)))) {
        setPlannedTrips(email, trips);
      }

      const existing = getRemindersFor(email) || [];
      const manualReminders = existing.filter((r) => r.type !== 'Itinerary' && !r.itineraryActivityId);
      const existingItineraryReminders = existing.filter((r) => r.type === 'Itinerary' || r.itineraryActivityId);
      const preservedState = new Map(
        existingItineraryReminders.map((r) => [`${r.itineraryActivityId || ''}|${Number(r.offsetMs || 0)}`, r])
      );
      const now = Date.now();
      const nextItineraryReminders = [];

      trips.forEach((data) => data.itinerary.forEach((day) => {
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
      }));

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
