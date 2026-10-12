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
  const ROUTE_FIELDS = ["travelDistanceKm", "travelMinutes", "transportMode", "routeStatus"];

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
      window.alert("Your changes could not be saved on this device. Free up some storage and try again.");
      return;
    }
    try { updateHeaderDate(null, current); } catch (error) {}
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
    $("itinerary-edit-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!activeForm) return;
      const values = {};
      for (const field of activeForm.fields) {
        const raw = activeForm.inputs[field.name].value;
        const value = field.type === "textarea" || field.type === "text" ? raw.trim() : raw;
        if (field.required && !value) return showFormError(`${field.label} is required.`);
        values[field.name] = value;
      }
      const message = activeForm.onSubmit(values);
      if (message) return showFormError(message);
      closeForm();
    });
    return modal;
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
      if (field.placeholder) input.placeholder = field.placeholder;
      input.value = field.value ?? "";
      if (field.readOnly) input.readOnly = true;
      wrap.append(label, input);
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

  // Adds an activity. `place` (a hotel/restaurant from the nearby list) pre-fills the form.
  function openAdd({ dayIndex = 0, place = null, kind = "" } = {}) {
    if (!hasItinerary()) return;
    const safeDay = current.itinerary[dayIndex] ? dayIndex : 0;
    const label = kind === "hotel" ? "Stay at" : kind === "restaurant" ? "Eat at" : "";
    const fields = [
      { name: "title", label: "Activity", type: "text", required: true, maxLength: 200, value: place ? `${label} ${place.name}`.trim() : "" },
      {
        name: "date", label: "Date", type: "date", required: true, value: dateValue(dayDate(safeDay)),
        hint: `Trip: ${dateValue(dayDate(0))} to ${dateValue(dayDate(current.itinerary.length - 1))}`,
      },
      { name: "time", label: "Time", type: "time", required: true, value: defaultTimeFor(kind) },
      { name: "location", label: "Location", type: "text", required: true, maxLength: 500, value: place ? place.name : "", readOnly: Boolean(place) },
      { name: "note", label: "Notes", type: "textarea", maxLength: 300, value: place ? String(place.note || place.address || "") : "" },
    ];
    openForm({
      title: place ? (kind === "hotel" ? "Add hotel to itinerary" : "Add restaurant to itinerary") : "Add activity",
      fields,
      submitText: "Add",
      onSubmit: (values) => {
        const dueAt = buildDueAt(values.date, values.time);
        if (dueAt === null) return "Enter a valid date and time.";
        if (isBeforeToday(dueAt)) return "Choose today or a later date.";
        const activity = {
          id: newActivityId(),
          title: values.title.slice(0, 200),
          location: values.location.slice(0, 500),
          note: values.note.slice(0, 300),
          dueAt,
          iso: new Date(dueAt).toISOString(),
        };
        if (place) {
          activity.category = kind;
          activity.placeId = place.placeId || "";
          activity.locationAddress = place.address || "";
          if (place.lat != null && place.lng != null && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))) {
            activity.locationCoords = { lat: Number(place.lat), lng: Number(place.lng) };
          }
          activity.photoResource = place.photoResource || "";
        }
        const planError = checkPlan([...allDueAts(), dueAt]);
        if (planError) return planError;
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
        { name: "date", label: "Date", type: "date", required: true, value: dateValue(originalDueAt) },
        { name: "time", label: "Time", type: "time", required: true, value: timeValue(originalDueAt) },
        { name: "location", label: "Location", type: "text", required: true, maxLength: 500, value: originalLocation },
        { name: "note", label: "Notes", type: "textarea", maxLength: 300, value: activity.note || "" },
      ],
      onSubmit: (values) => {
        const dueAt = buildDueAt(values.date, values.time);
        if (dueAt === null) return "Enter a valid date and time.";
        // Only block moving to a past date when the date itself was changed.
        if (localMidnight(dueAt) !== localMidnight(originalDueAt) && isBeforeToday(dueAt)) return "Choose today or a later date.";
        const planError = checkPlan(allDueAts(new Map([[activity, dueAt]])));
        if (planError) return planError;
        ensureIds();
        const before = previousMap();
        const reset = new Set();
        activity.title = values.title.slice(0, 200);
        activity.note = values.note.slice(0, 300);
        activity.dueAt = dueAt;
        activity.iso = new Date(dueAt).toISOString();
        if (values.location !== originalLocation) {
          // A different place invalidates the saved coordinates, photo and travel estimates.
          activity.location = values.location.slice(0, 500);
          ["locationCoords", "locationAddress", "placeId", "photoResource"].forEach((field) => { delete activity[field]; });
          reset.add(activity.id);
        }
        if (!normalizeAndReset(before, reset)) return "Could not save this activity.";
        finish();
        return "";
      },
    });
  }

  function remove(dayIndex, activityIndex) {
    const day = current?.itinerary?.[dayIndex];
    const activity = day?.activities?.[activityIndex];
    if (!activity) return;
    const total = current.itinerary.reduce((sum, d) => sum + (d.activities || []).length, 0);
    if (total <= 1) {
      window.alert("An itinerary needs at least one activity. Use the trash button at the top to remove the whole itinerary.");
      return;
    }
    if (!window.confirm(`Remove "${activity.title || "this activity"}" from your itinerary?`)) return;
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

  function changeDayDate(dayIndex) {
    const day = current?.itinerary?.[dayIndex];
    if (!day?.activities?.length) return;
    const oldMidnight = dayDate(dayIndex);
    openForm({
      title: `Change date for Day ${day.dayNumber || dayIndex + 1}`,
      intro: "All activities on this day move to the new date and keep their times. If that date already has activities, they are combined.",
      fields: [{ name: "date", label: "New date", type: "date", required: true, value: dateValue(oldMidnight) }],
      onSubmit: ({ date }) => {
        const target = parseDateValue(date);
        if (!target) return "Enter a valid date.";
        const delta = Math.round((target.getTime() - oldMidnight) / DAY_MS);
        if (delta === 0) return "";
        if (isBeforeToday(target.getTime())) return "Choose today or a later date.";
        const overrides = new Map();
        shiftActivities(day.activities, dayIndex, delta, overrides);
        const planError = checkPlan(allDueAts(overrides));
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
      fields: [{ name: "date", label: "New start date", type: "date", required: true, value: dateValue(oldMidnight) }],
      onSubmit: ({ date }) => {
        const target = parseDateValue(date);
        if (!target) return "Enter a valid date.";
        const delta = Math.round((target.getTime() - oldMidnight) / DAY_MS);
        if (delta === 0) return "";
        if (isBeforeToday(target.getTime())) return "Choose today or a later date.";
        const overrides = new Map();
        current.itinerary.forEach((d, index) => shiftActivities(d.activities || [], index, delta, overrides));
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
    });
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

  function enhance() {
    const container = $("itinerary-content");
    if (!container || !hasItinerary()) return;
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
      cards.forEach((card) => {
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
  };
})();
