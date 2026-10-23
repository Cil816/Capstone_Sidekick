// Itinerary editing: rename, add/edit/remove activities, add hotels & restaurants,
// and reschedule activities, days, or the whole trip.
//
// It edits the same in-memory itinerary object that itinerary.js renders from
// (registered through SidekickItineraryEdit.setCurrent), then re-normalizes it with
// SidekickCore.normalizeItineraryData so days, ids and times stay consistent with
// reminders and server sync.
(function () {
  const MAX_DAYS = 14;
  const MAX_PER_DAY = 30;
  const DAY_MS = 86400000;
  const SLOT_HOURS = { Morning: 9, Afternoon: 14, Evening: 18, Night: 21 };
  const ROUTE_FIELDS = ["travelDistanceKm", "travelMinutes", "transportMode", "routeStatus", "routeNoneKey", "routeRetryKey", "routeRetryAfter"];

  let current = null;
  let activeForm = null;

  const $ = (id) => document.getElementById(id);
  const core = () => window.SidekickCore;
  const email = () => core()?.getAuthSession?.()?.email || "";
  const pad = (n) => String(n).padStart(2, "0");

  function localMidnight(ts) {
    const d = new Date(Number(ts));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dateValue(ts) {
    const d = new Date(Number(ts));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function timeValue(ts) {
    const d = new Date(Number(ts));
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function parseDateValue(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function buildDueAt(dateText, timeText) {
    const date = parseDateValue(dateText);
    const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(timeText || ""));
    if (!date || !time) return null;
    date.setHours(Number(time[1]), Number(time[2]), 0, 0);
    return date.getTime();
  }

  function shiftDays(ts, delta) {
    const d = new Date(Number(ts));
    d.setDate(d.getDate() + delta);
    return d.getTime();
  }

  function newActivityId() {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function isMock() {
    return Boolean(current?.meta?.isDevelopmentMock);
  }

  function hasItinerary() {
    return Boolean(current && Array.isArray(current.itinerary) && current.itinerary.length);
  }

  function tripStartDate() {
    const text = current?.meta?.startDate;
    const parsed = typeof parseItineraryDate === "function" ? parseItineraryDate(text) : new Date(text);
    return parsed && Number.isFinite(parsed.getTime()) ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) : new Date(new Date().setHours(0, 0, 0, 0));
  }

  // The activity's scheduled time, deriving one the same way core.js does when it is missing.
  function activityDueAt(activity, dayIndex) {
    const saved = Number(activity?.dueAt);
    if (Number.isFinite(saved) && saved > 0) return saved;
    const base = tripStartDate();
    base.setDate(base.getDate() + dayIndex);
    base.setHours(SLOT_HOURS[activity?.timeLabel] ?? 12, 0, 0, 0);
    return base.getTime();
  }

  function dayDate(dayIndex) {
    const day = current.itinerary[dayIndex];
    const first = day?.activities?.[0];
    if (first) return localMidnight(activityDueAt(first, dayIndex));
    const base = tripStartDate();
    base.setDate(base.getDate() + dayIndex);
    return base.getTime();
  }

  function allDueAts(overrides = new Map()) {
    const list = [];
    current.itinerary.forEach((day, d) => (day.activities || []).forEach((activity) => {
      list.push(overrides.has(activity) ? overrides.get(activity) : activityDueAt(activity, d));
    }));
    return list;
  }

  // Returns an error message when a schedule would break the 14-day / 30-per-day limits.
  function checkPlan(dueAts) {
    if (!dueAts.length) return "";
    const counts = new Map();
    dueAts.forEach((ts) => {
      const key = localMidnight(ts);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const keys = Array.from(counts.keys());
    const span = Math.round((Math.max(...keys) - Math.min(...keys)) / DAY_MS) + 1;
    if (span > MAX_DAYS) return `An itinerary can cover up to ${MAX_DAYS} days. Choose dates closer together.`;
    if (Math.max(...counts.values()) > MAX_PER_DAY) return `A day can have up to ${MAX_PER_DAY} activities.`;
    return "";
  }

  function isBeforeToday(ts) {
    return localMidnight(ts) < localMidnight(Date.now());
  }

  // First and last day of the trip (local midnights).
  function tripRange() {
    return { first: dayDate(0), last: dayDate(current.itinerary.length - 1) };
  }

  function shortDay(ts) {
    return new Date(Number(ts)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  // Why an activity can't be planned at this time ("" when it can): not in the past
  // (a day or a time that has already gone by today) and within the trip's dates.
  // The trip itself is lengthened or moved with "Change dates".
  function scheduleProblem(dueAt) {
    if (isBeforeToday(dueAt)) return "Choose today or a later date.";
    if (dueAt < Date.now()) return "That time has already passed today. Choose a later time.";
    const { first, last } = tripRange();
    const day = localMidnight(dueAt);
    if (day < first || day > last) {
      const range = first === last ? shortDay(first) : `${shortDay(first)} – ${shortDay(last)}`;
      return `Choose a date within your trip (${range}). To move your trip to other dates, use “Change dates” at the top.`;
    }
    return "";
  }

  // The trip's dates for a date picker: today at the earliest, the trip's last day at the latest.
  function tripDateLimits() {
    const { first, last } = tripRange();
    return { min: dateValue(Math.max(first, localMidnight(Date.now()))), max: dateValue(last) };
  }

  function ensureIds() {
    current.itinerary.forEach((day) => (day.activities || []).forEach((activity) => {
      if (!activity.id) activity.id = newActivityId();
    }));
  }

  // activity id -> id of the activity before it in the same day (null for the first).
  function previousMap() {
    const map = new Map();
    current.itinerary.forEach((day) => (day.activities || []).forEach((activity, index) => {
      map.set(activity.id, index > 0 ? day.activities[index - 1].id : null);
    }));
    return map;
  }

  function clearRoute(activity) {
    ROUTE_FIELDS.forEach((field) => { delete activity[field]; });
  }

  // Regroups activities into days by their time, then drops stale travel estimates.
  function normalizeAndReset(before, forceReset = new Set()) {
    const normalized = core().normalizeItineraryData(current);
    if (!normalized || !Array.isArray(normalized.itinerary) || !normalized.itinerary.length) return false;
    current.itinerary = normalized.itinerary;
    current.meta = { ...(current.meta || {}), startDate: normalized.meta.startDate };
    delete current.meta.endDate;
    if (typeof normalizeItineraryDateMetadata === "function") normalizeItineraryDateMetadata(current);
    const after = previousMap();
    current.itinerary.forEach((day) => (day.activities || []).forEach((activity) => {
      if (forceReset.has(activity.id) || !before.has(activity.id) || before.get(activity.id) !== after.get(activity.id)) {
        clearRoute(activity);
      }
    }));
    return true;
  }

  function finish() {
    const owner = email();
    try {
      setItineraryForEmail(owner, current);
    } catch (error) {
      window.SidekickUI.alert("Your changes could not be saved on this device. Free up some storage and try again.", { title: "Not saved" });
      return;
    }
    try { updateHeaderDate(null, current); } catch (error) {}
    if (typeof setActiveTravelers === "function") setActiveTravelers(current.meta);
    renderItinerary(current.itinerary, isMock());
    renderEditBar();
    try { loadLiveTripBudget(current, owner); } catch (error) {}
    try {
      core().syncRemindersFromItinerary?.(owner);
      core().scheduleAllFor?.(owner);
    } catch (error) {}
    try { enrichItineraryWithLiveRoutes(current, owner); } catch (error) {}
  }

  // ---- title / action bar -----------------------------------------------------
  function displayTitle() {
    const custom = String(current?.meta?.title || "").trim();
    if (custom) return custom;
    const destination = String(current?.meta?.destination || current?.meta?.focusedPlace || "").trim();
    return destination ? `${destination} trip` : "My trip";
  }

  function renderEditBar() {
    const bar = $("itinerary-edit-bar");
    if (!bar) return;
    bar.hidden = !hasItinerary();
    const title = $("itinerary-title-text");
    if (title && hasItinerary()) title.textContent = displayTitle();
  }

  // ---- generic form modal -----------------------------------------------------
  function ensureModal() {
    let modal = $("itinerary-edit-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "itinerary-edit-modal";
    modal.className = "itinerary-edit-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="itinerary-edit-backdrop" data-close="1"></div>
      <form class="itinerary-edit-panel" id="itinerary-edit-form" role="dialog" aria-modal="true" aria-labelledby="itinerary-edit-title" novalidate>
        <div class="itinerary-edit-head">
          <h3 id="itinerary-edit-title">Edit</h3>
          <button type="button" class="itinerary-edit-x" data-close="1" aria-label="Close">×</button>
        </div>
        <p id="itinerary-edit-intro" class="itinerary-edit-intro" hidden></p>
        <div id="itinerary-edit-fields"></div>
        <p id="itinerary-edit-error" class="itinerary-edit-error" role="alert" hidden></p>
        <div class="itinerary-edit-buttons">
          <button type="button" class="btn btn-outline" data-close="1">Cancel</button>
          <button type="submit" class="btn btn-primary" id="itinerary-edit-submit">Save</button>
        </div>
      </form>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target?.dataset?.close === "1") closeForm();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.classList.contains("open")) closeForm();
    });
    let submitting = false;
    $("itinerary-edit-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!activeForm || submitting) return;
      const values = {};
      for (const field of activeForm.fields) {
        const raw = activeForm.inputs[field.name].value;
        const value = field.type === "textarea" || field.type === "text" || field.type === "place" ? raw.trim() : raw;
        if (field.required && !value) return showFormError(`${field.label} is required.`);
        values[field.name] = value;
        // The place picked from the search results (null when only a name was typed).
        if (field.type === "place") values[`${field.name}Place`] = activeForm.inputs[field.name]._place || null;
      }
      // A check may ask the traveler first (for example, a place already in the trip).
      submitting = true;
      let message = "";
      try {
        message = await activeForm.onSubmit(values);
      } finally {
        submitting = false;
      }
      if (message === null) return; // the traveler chose to change something first
      if (message) return showFormError(message);
      closeForm();
    });
    return modal;
  }

  // ---- place search field ---------------------------------------------------------
  // A "Where is it?" box that searches Google Maps as the traveler types. Picking a
  // result attaches the place (ID, address, map pin and photo) to the activity; a typed
  // name without picking still works for places that aren't on the map.
  function tripCenter() {
    for (const day of current?.itinerary || []) {
      for (const activity of day.activities || []) {
        const coords = activity.locationCoords;
        if (coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lng))) return { lat: Number(coords.lat), lng: Number(coords.lng) };
      }
    }
    const stay = current?.meta?.stay;
    return stay && Number.isFinite(Number(stay.lat)) && Number.isFinite(Number(stay.lng)) ? { lat: Number(stay.lat), lng: Number(stay.lng) } : null;
  }

  function newSessionToken() {
    const bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function placePhotoUrl(place) {
    const resource = String(place?.photoResource || "").trim();
    let base = "";
    try { base = core()?.getApiBaseUrl?.() || ""; } catch (error) { return ""; }
    // An empty base means the API is on this same site (a web preview): use a relative URL.
    if (!resource || (!base && !window.location.protocol.startsWith("http")) || String(window.SIDEKICK_CONFIG?.apiMode || "").toLowerCase() === "development") return "";
    return `${base}/api/maps/photo?name=${encodeURIComponent(resource)}`;
  }

  function buildPlaceField(input, field) {
    const esc = (value) => core().escapeHtml(String(value ?? ""));
    const box = document.createElement("div");
    box.className = "place-field";
    const results = document.createElement("div");
    results.className = "place-field-results";
    results.setAttribute("role", "listbox");
    results.hidden = true;
    const chosen = document.createElement("div");
    chosen.className = "place-field-chosen";
    chosen.hidden = true;
    const status = document.createElement("small");
    status.className = "place-field-status";
    status.setAttribute("aria-live", "polite");
    input.type = "search";
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.placeholder = field.placeholder || "Search a place, e.g. Laiya Beach";
    input._place = field.place || null;
    const sessionToken = newSessionToken();
    let timer = 0;
    let requestId = 0;

    function showChosen(place) {
      if (!place) { chosen.hidden = true; chosen.replaceChildren(); return; }
      const photo = placePhotoUrl(place);
      chosen.innerHTML = `${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" decoding="async">` : '<span class="place-field-pin" aria-hidden="true">📍</span>'}<span><strong>${esc(place.name)}</strong><small>${esc(place.address || "Pinned on the map")}</small></span>`;
      chosen.querySelector("img")?.addEventListener("error", (event) => event.target.remove());
      chosen.hidden = false;
    }

    async function choose(suggestion) {
      results.hidden = true;
      results.replaceChildren();
      input.value = suggestion.name || suggestion.text || "";
      status.textContent = "Getting the place’s details…";
      try {
        const data = await core().apiRequest("/api/maps/place-details", {
          method: "POST",
          body: JSON.stringify({ placeId: suggestion.placeId, sessionToken }),
        });
        const place = data?.place || {};
        // Sidekick covers Batangas only.
        if (place.inBatangas === false) {
          input._place = null;
          input.value = "";
          status.textContent = "That place isn’t in Batangas. Sidekick covers the province of Batangas only, so choose a place there.";
          return;
        }
        input._place = {
          placeId: suggestion.placeId,
          name: suggestion.name || place.name || input.value,
          address: place.address || suggestion.secondaryText || "",
          lat: Number.isFinite(Number(place.lat)) ? Number(place.lat) : null,
          lng: Number.isFinite(Number(place.lng)) ? Number(place.lng) : null,
          photoResource: place.photoResource || "",
          photoAttribution: place.photoAttribution || null,
          photoAttributions: Array.isArray(place.photoAttributions) ? place.photoAttributions : [],
          photoGoogleMapsUri: place.photoGoogleMapsUri || "",
        };
        status.textContent = "";
        showChosen(input._place);
      } catch (error) {
        // Still use the place without its details (no photo or pin).
        input._place = { placeId: suggestion.placeId, name: suggestion.name || input.value, address: suggestion.secondaryText || "" };
        status.textContent = "Couldn’t load this place’s photo right now, but it was added.";
        showChosen(input._place);
      }
    }

    async function search(text) {
      const id = ++requestId;
      if (text.length < 2) { results.hidden = true; results.replaceChildren(); status.textContent = ""; return; }
      status.textContent = "Searching…";
      try {
        const near = tripCenter();
        const data = await core().apiRequest("/api/maps/place-suggestions", {
          method: "POST",
          body: JSON.stringify({ input: text, sessionToken, scope: "activity", ...(near ? { near } : {}) }),
        });
        if (id !== requestId) return; // a newer search is on its way
        const suggestions = Array.isArray(data?.suggestions) ? data.suggestions.slice(0, 5) : [];
        status.textContent = suggestions.length ? "" : "No places found. You can keep the name you typed.";
        results.replaceChildren(...suggestions.map((suggestion) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "place-field-result";
          button.setAttribute("role", "option");
          button.innerHTML = `<strong>${esc(suggestion.name || suggestion.text)}</strong><small>${esc(suggestion.secondaryText || "")}</small>`;
          button.addEventListener("click", () => { void choose(suggestion); });
          return button;
        }));
        results.hidden = !suggestions.length;
      } catch (error) {
        if (id !== requestId) return;
        results.hidden = true;
        status.textContent = core().friendlyError(error, "Place search isn’t available right now. You can type the name instead.");
      }
    }

    input.addEventListener("input", () => {
      input._place = null; // typing again means a new place
      showChosen(null);
      clearTimeout(timer);
      const text = input.value.trim();
      timer = setTimeout(() => { void search(text); }, 350);
    });
    input.addEventListener("keydown", (event) => {
      // Enter picks the first result instead of submitting the form half-filled.
      if (event.key === "Enter" && !results.hidden && results.firstElementChild) {
        event.preventDefault();
        results.firstElementChild.click();
      }
    });
    if (input._place) showChosen(input._place);
    box.append(input, results, chosen, status);
    return box;
  }

  function showFormError(message) {
    const el = $("itinerary-edit-error");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  function closeForm() {
    const modal = $("itinerary-edit-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    activeForm = null;
  }

  function openForm({ title, intro = "", fields, submitText = "Save", onSubmit }) {
    const modal = ensureModal();
    $("itinerary-edit-title").textContent = title;
    const introEl = $("itinerary-edit-intro");
    introEl.textContent = intro;
    introEl.hidden = !intro;
    $("itinerary-edit-submit").textContent = submitText;
    showFormError("");
    const container = $("itinerary-edit-fields");
    container.replaceChildren();
    const inputs = {};
    fields.forEach((field, index) => {
      const wrap = document.createElement("div");
      wrap.className = "itinerary-edit-field";
      const id = `itinerary-edit-input-${index}`;
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = field.label + (field.required ? "" : " (optional)");
      const input = document.createElement(field.type === "textarea" ? "textarea" : "input");
      input.id = id;
      if (field.type === "textarea") input.rows = 3;
      else input.type = field.type;
      if (field.maxLength) input.maxLength = field.maxLength;
      if (field.min) input.min = field.min;
      if (field.max) input.max = field.max;
      if (field.placeholder) input.placeholder = field.placeholder;
      input.value = field.value ?? "";
      if (field.readOnly) input.readOnly = true;
      wrap.append(label, field.type === "place" && !field.readOnly ? buildPlaceField(input, field) : input);
      if (field.hint) {
        const hint = document.createElement("small");
        hint.textContent = field.hint;
        wrap.appendChild(hint);
      }
      container.appendChild(wrap);
      inputs[field.name] = input;
    });
    activeForm = { fields, inputs, onSubmit };
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    const first = container.querySelector("input:not([readonly]), textarea");
    if (first) setTimeout(() => first.focus(), 50);
  }

  // ---- actions ----------------------------------------------------------------
  function rename() {
    if (!hasItinerary()) return;
    openForm({
      title: "Rename itinerary",
      fields: [{ name: "title", label: "Itinerary name", type: "text", required: true, maxLength: 100, value: displayTitle() }],
      onSubmit: ({ title }) => {
        current.meta = { ...(current.meta || {}), title };
        try { setItineraryForEmail(email(), current); } catch (error) { return "Could not save the new name. Please try again."; }
        renderEditBar();
        return "";
      },
    });
  }

  function defaultTimeFor(kind) {
    if (kind === "hotel") return "14:00";
    if (kind === "restaurant") return "12:00";
    return "10:00";
  }

  // Copies a place picked in the search box onto an activity: name and address as its
  // location, plus the Google place ID, map pin and photo (with its credit).
  function attachPlace(activity, place) {
    const name = String(place.name || "").trim();
    const address = String(place.address || "").trim();
    activity.location = (address && !address.toLowerCase().startsWith(name.toLowerCase()) ? `${name}, ${address}` : address || name).slice(0, 500);
    activity.placeId = String(place.placeId || "");
    if (address) activity.locationAddress = address;
    if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) activity.locationCoords = { lat: place.lat, lng: place.lng };
    if (place.photoResource) activity.photoResource = place.photoResource;
    if (place.photoAttribution) activity.photoAttribution = place.photoAttribution;
    if (Array.isArray(place.photoAttributions) && place.photoAttributions.length) activity.photoAttributions = place.photoAttributions;
    if (place.photoGoogleMapsUri) activity.photoGoogleMapsUri = place.photoGoogleMapsUri;
  }

  // ---- the same place twice -----------------------------------------------------
  // A place already in the trip: same Google place, or the same name.
  function placeNameOf(activity) {
    const fromLocation = String(activity?.location || "").split(",")[0];
    const fromTitle = String(activity?.title || "").replace(/^(stay at|eat at|visit|explore|tour)\s+/i, "");
    return (fromLocation || fromTitle).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function findSamePlace(candidate, skip = null) {
    const id = String(candidate.placeId || "");
    const name = placeNameOf(candidate);
    for (const [dayIndex, day] of (current?.itinerary || []).entries()) {
      for (const activity of day?.activities || []) {
        if (activity === skip) continue;
        const sameId = id && activity.placeId && String(activity.placeId) === id;
        const sameName = name.length >= 4 && placeNameOf(activity) === name;
        if (sameId || sameName) return { activity, dayIndex };
      }
    }
    return null;
  }

  // Asks before adding a place that is already planned. true = add it anyway.
  async function confirmSamePlace(candidate, skip = null) {
    const found = findSamePlace(candidate, skip);
    if (!found) return true;
    const when = activityDueAt(found.activity, found.dayIndex);
    const time = Number.isFinite(when) ? new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const day = Number.isFinite(when) ? shortDay(when) : "";
    const name = String(found.activity.title || found.activity.location || "This place");
    const message = `“${name}” is already in your trip on Day ${found.dayIndex + 1}${day ? ` (${day})` : ""}${time ? ` at ${time}` : ""}. Do you want to add it again?`;
    if (!window.SidekickUI?.confirm) return window.confirm(message);
    return window.SidekickUI.confirm(message, { title: "Already in your trip", confirmText: "Add anyway", cancelText: "Go back" });
  }

  // Adds an activity. `place` (a hotel/restaurant from the nearby list) pre-fills the form.
  function openAdd({ dayIndex = 0, place = null, kind = "" } = {}) {
    if (!hasItinerary()) return;
    const safeDay = current.itinerary[dayIndex] ? dayIndex : 0;
    const label = kind === "hotel" ? "Stay at" : kind === "restaurant" ? "Eat at" : "";
    const fields = [
      { name: "title", label: "Activity", type: "text", required: true, maxLength: 200, value: place ? `${label} ${place.name}`.trim() : "" },
      {
        name: "date", label: "Date", type: "date", required: true, value: dateValue(Math.max(dayDate(safeDay), localMidnight(Date.now()))),
        ...tripDateLimits(),
        hint: `Your trip: ${tripRange().first === tripRange().last ? shortDay(tripRange().first) : `${shortDay(tripRange().first)} – ${shortDay(tripRange().last)}`}`,
      },
      { name: "time", label: "Time", type: "time", required: true, value: defaultTimeFor(kind) },
      { name: "location", label: "Where is it?", type: "place", required: true, maxLength: 500, value: place ? place.name : "", readOnly: Boolean(place),
        hint: place ? "" : "Search and pick a place to add its photo and map pin." },
      { name: "note", label: "Notes", type: "textarea", maxLength: 300, value: place ? String(place.note || place.address || "") : "" },
    ];
    openForm({
      title: place ? (kind === "hotel" ? "Add hotel to itinerary" : kind === "restaurant" ? "Add restaurant to itinerary" : "Add to itinerary") : "Add activity",
      fields,
      submitText: "Add",
      onSubmit: async (values) => {
        const dueAt = buildDueAt(values.date, values.time);
        if (dueAt === null) return "Enter a valid date and time.";
        const problem = scheduleProblem(dueAt);
        if (problem) return problem;
        const activity = {
          id: newActivityId(),
          title: values.title.slice(0, 200),
          location: values.location.slice(0, 500),
          note: values.note.slice(0, 300),
          dueAt,
          iso: new Date(dueAt).toISOString(),
        };
        if (place) {
          if (kind) activity.category = kind;
          activity.placeId = place.placeId || "";
          activity.locationAddress = place.address || "";
          if (place.lat != null && place.lng != null && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))) {
            activity.locationCoords = { lat: Number(place.lat), lng: Number(place.lng) };
          }
          activity.photoResource = place.photoResource || "";
        } else if (values.locationPlace) {
          attachPlace(activity, values.locationPlace);
        }
        const planError = checkPlan([...allDueAts(), dueAt]);
        if (planError) return planError;
        if (!(await confirmSamePlace(activity))) return null;
        ensureIds();
        const before = previousMap();
        current.itinerary[safeDay].activities = [...(current.itinerary[safeDay].activities || []), activity];
        if (!normalizeAndReset(before, new Set([activity.id]))) return "Could not add this activity.";
        finish();
        return "";
      },
    });
  }

  function edit(dayIndex, activityIndex) {
    const activity = current?.itinerary?.[dayIndex]?.activities?.[activityIndex];
    if (!activity) return;
    const originalDueAt = activityDueAt(activity, dayIndex);
    const originalLocation = String(activity.location || "");
    openForm({
      title: "Edit activity",
      fields: [
        { name: "title", label: "Activity", type: "text", required: true, maxLength: 200, value: activity.title || "" },
        { name: "date", label: "Date", type: "date", required: true, value: dateValue(originalDueAt), max: tripDateLimits().max },
        { name: "time", label: "Time", type: "time", required: true, value: timeValue(originalDueAt) },
        {
          name: "location", label: "Where is it?", type: "place", required: true, maxLength: 500, value: originalLocation,
          // The stop's current place stays attached unless a different one is searched.
          place: activity.placeId ? { placeId: activity.placeId, name: originalLocation, address: activity.locationAddress || "", photoResource: activity.photoResource || "" } : null,
          hint: "Search and pick a place to add its photo and map pin.",
        },
        { name: "note", label: "Notes", type: "textarea", maxLength: 300, value: activity.note || "" },
      ],
      onSubmit: async (values) => {
        const dueAt = buildDueAt(values.date, values.time);
        if (dueAt === null) return "Enter a valid date and time.";
        // Moving this stop to a place that is already planned elsewhere: ask first.
        const newPlace = values.locationPlace;
        if (newPlace ? newPlace.placeId !== activity.placeId : values.location !== originalLocation) {
          const candidate = newPlace ? { placeId: newPlace.placeId, location: newPlace.name, title: newPlace.name } : { location: values.location, title: values.title };
          if (!(await confirmSamePlace(candidate, activity))) return null;
        }
        // An activity whose time isn't changed can always be edited (even one that has
        // already happened); a new time must be ahead and within the trip.
        if (dueAt !== originalDueAt) {
          const problem = scheduleProblem(dueAt);
          if (problem) return problem;
        }
        const planError = checkPlan(allDueAts(new Map([[activity, dueAt]])));
        if (planError) return planError;
        ensureIds();
        const before = previousMap();
        const reset = new Set();
        activity.title = values.title.slice(0, 200);
        activity.note = values.note.slice(0, 300);
        activity.dueAt = dueAt;
        activity.iso = new Date(dueAt).toISOString();
        const pickedPlace = values.locationPlace;
        const placeChanged = pickedPlace ? pickedPlace.placeId !== activity.placeId : values.location !== originalLocation;
        if (placeChanged) {
          // A different place replaces the saved coordinates, photo and travel estimates.
          ["locationCoords", "locationAddress", "placeId", "photoResource", "photoAttribution", "photoAttributions", "photoGoogleMapsUri"].forEach((field) => { delete activity[field]; });
          if (pickedPlace) attachPlace(activity, pickedPlace);
          else activity.location = values.location.slice(0, 500);
          reset.add(activity.id);
        }
        if (!normalizeAndReset(before, reset)) return "Could not save this activity.";
        finish();
        return "";
      },
    });
  }

  async function remove(dayIndex, activityIndex) {
    const day = current?.itinerary?.[dayIndex];
    const activity = day?.activities?.[activityIndex];
    if (!activity) return;
    const total = current.itinerary.reduce((sum, d) => sum + (d.activities || []).length, 0);
    if (total <= 1) {
      await window.SidekickUI.alert("An itinerary needs at least one activity. Use the trash button at the top to remove the whole itinerary.", { title: "Keep one activity" });
      return;
    }
    const ok = await window.SidekickUI.confirm(`"${activity.title || "This activity"}" will be removed from your itinerary.`, {
      title: "Remove this activity?", confirmText: "Remove", tone: "danger",
    });
    // The itinerary may have changed while the dialog was open.
    if (!ok || current?.itinerary?.[dayIndex]?.activities?.[activityIndex] !== activity) return;
    ensureIds();
    const before = previousMap();
    day.activities.splice(activityIndex, 1);
    if (!normalizeAndReset(before)) return;
    finish();
  }

  function shiftActivities(activities, dayIndex, delta, overrides) {
    activities.forEach((activity) => overrides.set(activity, shiftDays(activityDueAt(activity, dayIndex), delta)));
  }

  function applyOverrides(overrides) {
    ensureIds();
    const before = previousMap();
    overrides.forEach((dueAt, activity) => {
      activity.dueAt = dueAt;
      activity.iso = new Date(dueAt).toISOString();
    });
    if (!normalizeAndReset(before)) return false;
    finish();
    return true;
  }

  const PASSED_TIMES_MESSAGE = "Some activities would be at times that have already passed today. Choose a later date.";

  // Moving days must not run into another planned trip's dates.
  function overlapProblem(dueAts) {
    if (!dueAts.length) return "";
    const first = dateValue(Math.min(...dueAts));
    const last = dateValue(Math.max(...dueAts));
    const clash = core()?.findOverlappingTrip?.(email(), first, last, current?.meta?.planId || null);
    return clash ? core().tripOverlapMessage(clash) : "";
  }

  function changeDayDate(dayIndex) {
    const day = current?.itinerary?.[dayIndex];
    if (!day?.activities?.length) return;
    const oldMidnight = dayDate(dayIndex);
    openForm({
      title: `Change date for Day ${day.dayNumber || dayIndex + 1}`,
      intro: "All activities on this day move to the new date and keep their times. If that date already has activities, they are combined.",
      fields: [{ name: "date", label: "New date", type: "date", required: true, value: dateValue(oldMidnight), min: dateValue(Date.now()) }],
      onSubmit: ({ date }) => {
        const target = parseDateValue(date);
        if (!target) return "Enter a valid date.";
        const delta = Math.round((target.getTime() - oldMidnight) / DAY_MS);
        if (delta === 0) return "";
        if (isBeforeToday(target.getTime())) return "Choose today or a later date.";
        const overrides = new Map();
        shiftActivities(day.activities, dayIndex, delta, overrides);
        if (Array.from(overrides.values()).some((dueAt) => dueAt < Date.now())) return PASSED_TIMES_MESSAGE;
        const planError = checkPlan(allDueAts(overrides)) || overlapProblem(allDueAts(overrides));
        if (planError) return planError;
        return applyOverrides(overrides) ? "" : "Could not change this date.";
      },
    });
  }

  function shiftTrip() {
    if (!hasItinerary()) return;
    const oldMidnight = dayDate(0);
    openForm({
      title: "Change trip dates",
      intro: "Move the whole itinerary to a new start date. Every activity keeps its time and its day order.",
      fields: [{ name: "date", label: "New start date", type: "date", required: true, value: dateValue(oldMidnight), min: dateValue(Date.now()) }],
      onSubmit: ({ date }) => {
        const target = parseDateValue(date);
        if (!target) return "Enter a valid date.";
        const delta = Math.round((target.getTime() - oldMidnight) / DAY_MS);
        if (delta === 0) return "";
        if (isBeforeToday(target.getTime())) return "Choose today or a later date.";
        const overrides = new Map();
        current.itinerary.forEach((d, index) => shiftActivities(d.activities || [], index, delta, overrides));
        if (Array.from(overrides.values()).some((dueAt) => dueAt < Date.now())) return PASSED_TIMES_MESSAGE;
        const clash = overlapProblem(allDueAts(overrides));
        if (clash) return clash;
        return applyOverrides(overrides) ? "" : "Could not change the trip dates.";
      },
    });
  }

  // Restaurants near the day's stops (falls back to the hotel, then the destination).
  function openEat(dayIndex) {
    const day = current?.itinerary?.[dayIndex];
    if (!day) return;
    const withCoords = (day.activities || []).find((activity) => {
      const coords = activity?.locationCoords;
      return coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lng));
    });
    const stay = current.meta?.stay;
    const stayHasCoords = stay && stay.lat != null && stay.lng != null && Number.isFinite(Number(stay.lat)) && Number.isFinite(Number(stay.lng));
    const center = withCoords
      ? { lat: Number(withCoords.locationCoords.lat), lng: Number(withCoords.locationCoords.lng) }
      : stayHasCoords ? { lat: Number(stay.lat), lng: Number(stay.lng) } : null;
    const anchorName = withCoords?.title
      || (stayHasCoords ? stay.name : "")
      || String(current.meta?.destination || current.meta?.focusedPlace || "").trim();
    const budget = Number(current.meta?.budgetAmountPhp);
    window.SidekickBudgetPickers.openRestaurants({
      dayIndex,
      dayLabel: `Day ${day.dayNumber || dayIndex + 1}`,
      center,
      anchorName,
      budgetAmountPhp: Number.isFinite(budget) && budget > 0 ? budget : null,
      durationDays: current.itinerary.length,
      travelers: current.meta?.travelers || 1,
      destination: String(current.meta?.destination || current.meta?.focusedPlace || "").trim(),
      startDate: core()?.tripDateRange?.(current)?.start || "",
      endDate: core()?.tripDateRange?.(current)?.end || "",
      onBudgetChange: changeTripBudget,
    });
  }

  // "Edit trip budget" (restaurant picker): the trip's new total budget. Targets worked
  // out for the old amount are dropped, so the cost summary follows the new one.
  function changeTripBudget(amount) {
    if (!hasItinerary() || !(Number(amount) > 0)) return false;
    const before = { ...(current.meta || {}) };
    current.meta = { ...(current.meta || {}), budgetAmountPhp: amount, budget: `PHP ${Number(amount).toLocaleString()} total` };
    delete current.meta.activityBudgetTargetPhp;
    delete current.meta.dailyActivityBudgetTargetPhp;
    try {
      setItineraryForEmail(email(), current);
    } catch (error) {
      current.meta = before;
      window.SidekickUI.alert("The new budget couldn’t be saved on this device. Free up some storage and try again.", { title: "Not saved" });
      return false;
    }
    try { loadLiveTripBudget(current, email()); } catch (error) {}
    return true;
  }

  // ---- per-card / per-day buttons ---------------------------------------------
  function makeButton(label, action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.editAction = action;
    button.textContent = label;
    return button;
  }

  // ---- done / missed checklist (saved trips only) ---------------------------------
  // Each stop of a saved trip shows how it went. Before it starts: "Upcoming". From its
  // start time the traveler is asked "Did you do this?" and chooses Done or Missed
  // (nothing is decided for them); the answer shows on the card, with "Change" to pick
  // again. Kept with the trip on this phone (activity.doneAt / activity.missedAt).
  const DEFAULT_STOP_MINUTES = 60; // a stop without a planned length

  function isSavedTrip() {
    return hasItinerary() && !current.meta?.isDraft && Boolean(current.meta?.planId || current.meta?.serverTripId);
  }

  // upcoming | now (started, not over) | ask (over, no answer yet) | done | missed
  function activityStatus(activity, dayIndex) {
    if (Number(activity?.doneAt) > 0) return "done";
    if (Number(activity?.missedAt) > 0) return "missed";
    const start = activityDueAt(activity, dayIndex);
    const now = Date.now();
    if (now < start) return "upcoming";
    const minutes = Number(activity?.durationMinutes) > 0 ? Number(activity.durationMinutes) : DEFAULT_STOP_MINUTES;
    return now > start + minutes * 60000 ? "ask" : "now";
  }

  function paintStatus(row, activity, dayIndex) {
    const status = activityStatus(activity, dayIndex);
    if (row.dataset.status === status) return;
    row.dataset.status = status;
    const name = core().escapeHtml(String(activity?.title || "this activity"));
    if (status === "upcoming") {
      row.innerHTML = '<span class="activity-status-text">Upcoming</span>';
    } else if (status === "done" || status === "missed") {
      row.innerHTML = `<span class="activity-status-box" aria-hidden="true"></span><span class="activity-status-text">${status === "done" ? "Done" : "Missed"}</span>`
        + `<button type="button" class="activity-status-change" data-edit-action="status-clear" aria-label="Change whether you did ${name}">Change</button>`;
    } else {
      // Just the two buttons; the question is read out to screen readers.
      row.innerHTML = '<span class="activity-status-choices">'
        + `<button type="button" class="activity-status-choice done" data-edit-action="status-done" aria-label="Done: I did ${name}">Done</button>`
        + `<button type="button" class="activity-status-choice missed" data-edit-action="status-missed" aria-label="Missed: I didn’t do ${name}">Missed</button>`
        + '</span>';
    }
    if (status === "now" || status === "ask") row.setAttribute("aria-label", `Did you do ${String(activity?.title || "this activity")}?`);
    else row.removeAttribute("aria-label");
    const card = row.closest(".activity-card");
    card?.classList.toggle("is-done", status === "done");
    card?.classList.toggle("is-missed", status === "missed");
  }

  function statusRow() {
    const row = document.createElement("div");
    row.className = "activity-status";
    row.setAttribute("role", "group");
    row.setAttribute("aria-live", "polite");
    return row;
  }

  // answer: "done", "missed", or "" to choose again.
  function setActivityResult(dayIndex, activityIndex, answer, row) {
    const activity = current?.itinerary?.[dayIndex]?.activities?.[activityIndex];
    if (!activity || !row || !isSavedTrip()) return;
    if (answer && activityStatus({ ...activity, doneAt: 0, missedAt: 0 }, dayIndex) === "upcoming") return;
    const before = { doneAt: activity.doneAt, missedAt: activity.missedAt };
    delete activity.doneAt;
    delete activity.missedAt;
    if (answer === "done") activity.doneAt = Date.now();
    if (answer === "missed") activity.missedAt = Date.now();
    try {
      setItineraryForEmail(email(), current);
    } catch (error) {
      Object.entries(before).forEach(([key, value]) => { if (value) activity[key] = value; else delete activity[key]; });
      window.SidekickUI.alert("This couldn’t be saved on this device. Free up some storage and try again.", { title: "Not saved" });
      return;
    }
    paintStatus(row, activity, dayIndex);
    row.querySelector("button")?.focus({ preventScroll: true });
  }

  function enhance() {
    const container = $("itinerary-content");
    if (!container || !hasItinerary()) return;
    const saved = isSavedTrip();
    container.querySelectorAll(".day-section").forEach((section, dayIndex) => {
      const day = current.itinerary[dayIndex];
      if (!day) return;
      const list = section.querySelector(".activities-list");
      if (!list) return;
      const cards = Array.from(list.querySelectorAll(":scope > .activity-card"));
      // Only decorate DOM that matches the data it was rendered from.
      if (cards.length !== (day.activities || []).length) return;

      const info = section.querySelector(".day-info");
      if (info && cards.length && !info.querySelector(".day-edit-actions")) {
        const actions = document.createElement("div");
        actions.className = "day-edit-actions";
        actions.appendChild(makeButton("Change date", "day-date", "itinerary-edit-link"));
        info.appendChild(actions);
      }
      cards.forEach((card, activityIndex) => {
        let row = card.querySelector(":scope > .activity-status");
        if (saved) {
          if (!row) {
            row = statusRow();
            card.insertBefore(row, card.querySelector(":scope > .activity-edit-actions"));
          }
          paintStatus(row, day.activities[activityIndex], dayIndex);
        } else if (row) {
          row.remove();
        }
        if (card.querySelector(".activity-edit-actions")) return;
        const actions = document.createElement("div");
        actions.className = "activity-edit-actions";
        actions.append(makeButton("Edit", "edit", "itinerary-edit-link"), makeButton("Remove", "remove", "itinerary-edit-link danger"));
        card.appendChild(actions);
      });
      if (!list.querySelector(":scope > .day-add-row")) {
        const row = document.createElement("div");
        row.className = "day-add-row";
        row.appendChild(makeButton("+ Add to this day", "day-add", "itinerary-edit-chip"));
        if (window.SidekickBudgetPickers?.openRestaurants) {
          row.appendChild(makeButton("Where to eat", "day-eat", "itinerary-edit-chip"));
        }
        list.appendChild(row);
      }
    });
  }

  function handleClick(event) {
    const button = event.target.closest("[data-edit-action]");
    if (!button || !hasItinerary()) return;
    const section = button.closest(".day-section");
    const container = $("itinerary-content");
    const dayIndex = section ? Array.from(container.querySelectorAll(".day-section")).indexOf(section) : -1;
    if (dayIndex < 0) return;
    const action = button.dataset.editAction;
    if (action === "day-date") return changeDayDate(dayIndex);
    if (action === "day-add") return openAdd({ dayIndex });
    if (action === "day-eat") return openEat(dayIndex);
    const card = button.closest(".activity-card");
    const cards = Array.from(section.querySelectorAll(".activities-list > .activity-card"));
    const activityIndex = cards.indexOf(card);
    if (activityIndex < 0) return;
    if (action === "status-done") return setActivityResult(dayIndex, activityIndex, "done", button.closest(".activity-status"));
    if (action === "status-missed") return setActivityResult(dayIndex, activityIndex, "missed", button.closest(".activity-status"));
    if (action === "status-clear") return setActivityResult(dayIndex, activityIndex, "", button.closest(".activity-status"));
    if (action === "edit") return edit(dayIndex, activityIndex);
    if (action === "remove") return remove(dayIndex, activityIndex);
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("itinerary-rename-btn")?.addEventListener("click", rename);
    $("itinerary-shift-btn")?.addEventListener("click", shiftTrip);
    $("itinerary-add-btn")?.addEventListener("click", () => openAdd({ dayIndex: 0 }));
    const container = $("itinerary-content");
    if (container) {
      container.addEventListener("click", handleClick);
      new MutationObserver(() => enhance()).observe(container, { childList: true });
      // Upcoming stops become "Mark as done", then "Missed", as time passes.
      window.setInterval(() => { if (document.visibilityState === "visible") enhance(); }, 60000);
    }
  });

  window.SidekickItineraryEdit = {
    setCurrent(data) {
      current = data && Array.isArray(data.itinerary) ? data : null;
      renderEditBar();
      enhance();
    },
    hasItinerary,
    openAddPlace(place, kind, dayIndex = 0) {
      if (place) openAdd({ dayIndex: Number.isInteger(dayIndex) ? dayIndex : 0, place, kind });
    },
    // The "Add activity" form with its place search (used by the + Add Activity button).
    openAddActivity(dayIndex = 0) {
      if (!hasItinerary()) return false;
      openAdd({ dayIndex: Number.isInteger(dayIndex) ? dayIndex : 0 });
      return true;
    },
  };
})();
