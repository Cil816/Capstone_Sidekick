// "Plan your trip style": asked just before an itinerary is built (styles in css/theme.css).
//   SidekickTripStyle.ask({ destination, days, preferences, firstDayStartMinute }) -> Promise<{ timeOfDay, pace, focus } | null>
// firstDayStartMinute is set when the trip starts today (see SidekickCore.firstDayStartMinute):
// on a one-day trip, times of day that are already over today can't be picked. On a
// longer trip every time of day can be picked: if it is over for today, day 1 (today)
// gets the next time of day that still has time left, and later days keep the choice.
// The focus choices start with the traveler's onboarding preferences (already
// selected), followed by other ideas they can add. null means the traveler went back.
(function () {
  const LAST_KEY = "sidekick.tripStyle.last";

  const TIMES = [
    { value: "morning", end: 17 * 60, title: "Morning & daytime", detail: "7 AM – 5 PM · early sights, cooler hours", icon: '<path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 2v7"/><path d="m4.22 10.22 1.42 1.42"/><path d="M1 18h2"/><path d="M21 18h2"/><path d="m18.36 11.64 1.42-1.42"/><path d="M23 22H1"/><path d="m8 6 4-4 4 4"/>' },
    { value: "fullday", end: 21 * 60, title: "Full day", detail: "8 AM – 9 PM · the most stops", icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>' },
    { value: "afternoon", end: 23 * 60, title: "Afternoon to night", detail: "1 PM – 11 PM · sunsets and evening spots", icon: '<path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 9V2"/><path d="m4.22 10.22 1.42 1.42"/><path d="M1 18h2"/><path d="M21 18h2"/><path d="m18.36 11.64 1.42-1.42"/><path d="M23 22H1"/><path d="m16 5-4 4-4-4"/>' },
    { value: "night", end: 24 * 60, title: "Night out", detail: "4 PM – midnight · night markets, views, nightlife", icon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' },
  ];

  const PACES = [
    { value: "packed", title: "Packed", detail: "As many stops as fit" },
    { value: "balanced", title: "Balanced", detail: "Full, with breathing room" },
    { value: "relaxed", title: "Relaxed", detail: "Fewer, longer visits" },
  ];

  // Same choices as onboarding, plus a few ideas onboarding doesn't ask about.
  const ONBOARDING_CHOICES = [
    "Adventure", "Beach & Relaxation", "Cultural", "Food Tour", "Nature & Wildlife", "City Exploration",
    "Beaches", "Mountains", "Historical Sites", "Local Cuisine", "Nightlife", "Shopping",
    "Photography", "Water Sports", "Hiking", "Island Hopping",
  ];
  const EXTRA_CHOICES = ["Hidden gems", "Sunset spots", "Family-friendly", "Wellness & spa"];

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  function lastChoice() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
      return saved && typeof saved === "object" ? saved : null;
    } catch (error) {
      return null;
    }
  }

  // At least an hour and a half of the chosen time of day must be left when the trip
  // starts today (the server needs an hour, so the app is always the stricter one).
  const MIN_FIRST_DAY_MINUTES = 90;
  const fitsToday = (item, firstDayStartMinute) => !Number.isFinite(firstDayStartMinute) || firstDayStartMinute <= item.end - MIN_FIRST_DAY_MINUTES;
  const clockText = (minutes) => {
    const hour = Math.floor(minutes / 60) % 24;
    return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
  };

  // True when no time of day has enough of today left (the trip should start tomorrow).
  function tooLateToday(firstDayStartMinute) {
    return Number.isFinite(firstDayStartMinute) && !TIMES.some((item) => fitsToday(item, firstDayStartMinute));
  }

  function ask({ destination = "", days = 1, preferences = {}, firstDayStartMinute = null } = {}) {
    return new Promise((resolve) => {
      const mine = Array.from(new Set([...(preferences.travelTypes || []), ...(preferences.interests || [])]
        .map((item) => String(item || "").trim()).filter(Boolean)));
      const others = [...ONBOARDING_CHOICES, ...EXTRA_CHOICES].filter((item) => !mine.includes(item));
      const last = lastChoice();
      // Only a one-day trip is limited to what is left of today.
      const multiDay = Number(days) > 1;
      const canPick = (item) => multiDay || fitsToday(item, firstDayStartMinute);
      const usable = TIMES.filter(canPick);
      let timeOfDay = usable.some((item) => item.value === last?.timeOfDay) ? last.timeOfDay
        : usable.some((item) => item.value === "fullday") ? "fullday" : (usable[0]?.value || "night");
      const lateNote = Number.isFinite(firstDayStartMinute) && firstDayStartMinute > 7 * 60
        ? `Your trip starts today, so day 1 begins around ${clockText(firstDayStartMinute)}.${multiDay
          ? (TIMES.some((item) => !fitsToday(item, firstDayStartMinute)) ? " If you pick a time that’s over for today, day 1 becomes an evening plan and your choice starts on day 2." : "")
          : (usable.length < TIMES.length ? " Times of day that are over for today can’t be picked." : "")}`
        : "";
      let pace = PACES.some((item) => item.value === last?.pace) ? last.pace : "packed";
      // The traveler's own preferences start selected; extra picks from last time stay picked.
      const picked = new Set([...mine, ...(Array.isArray(last?.extraFocus) ? last.extraFocus.filter((item) => others.includes(item)) : [])]);

      const chip = (item) => `<button type="button" class="sk-style-chip" data-focus="${esc(item)}" aria-pressed="${picked.has(item)}">${esc(item)}</button>`;
      const root = document.createElement("div");
      root.className = "sk-dialog sk-style-dialog";
      root.innerHTML = `
        <div class="sk-dialog-backdrop" data-style-cancel></div>
        <div class="sk-dialog-panel sk-style-panel" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="sk-style-title">
          <h2 class="sk-dialog-title" id="sk-style-title">Plan your trip style</h2>
          <p class="sk-dialog-message">${esc(destination ? `How do you want to spend your ${days} day${days === 1 ? "" : "s"} in ${destination}?` : "How do you want to spend your trip?")}</p>
          <div class="sk-style-body">
            <fieldset class="sk-style-group">
              <legend>When do you want to explore?</legend>
              ${lateNote ? `<p class="sk-style-late-note">${esc(lateNote)}</p>` : ""}
              <div class="sk-style-times" role="radiogroup" aria-label="When do you want to explore?">
                ${TIMES.map((item) => `
                  <button type="button" class="sk-style-time" role="radio" data-time="${item.value}" aria-checked="${item.value === timeOfDay}"${canPick(item) ? "" : " disabled aria-disabled=\"true\""}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>
                    <span><strong>${esc(item.title)}</strong><small>${esc(fitsToday(item, firstDayStartMinute) ? item.detail : multiDay ? `${item.detail} · from day 2` : "Over for today")}</small></span>
                  </button>`).join("")}
              </div>
            </fieldset>
            <fieldset class="sk-style-group">
              <legend>How busy should each day be?</legend>
              <div class="sk-style-paces" role="radiogroup" aria-label="How busy should each day be?">
                ${PACES.map((item) => `
                  <button type="button" class="sk-style-pace" role="radio" data-pace="${item.value}" aria-checked="${item.value === pace}">
                    <strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small>
                  </button>`).join("")}
              </div>
            </fieldset>
            <fieldset class="sk-style-group">
              <legend>What should this trip focus on?</legend>
              ${mine.length ? `<p class="sk-style-sub">From your preferences</p><div class="sk-style-chips">${mine.map(chip).join("")}</div>` : ""}
              <p class="sk-style-sub">${mine.length ? "Try something different" : "Pick what you’d like more of"}</p>
              <div class="sk-style-chips">${others.map(chip).join("")}</div>
            </fieldset>
          </div>
          <p class="sk-style-note">Meal times and nights stay free in your plan.</p>
          <div class="sk-dialog-actions">
            <button type="button" class="btn btn-outline" data-style-cancel>Back</button>
            <button type="button" class="btn btn-primary" data-style-ok>Build itinerary</button>
          </div>
        </div>`;

      const previousFocus = document.activeElement;
      let done = false;
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        root.remove();
        document.documentElement.style.removeProperty("overflow");
        try { previousFocus?.focus?.({ preventScroll: true }); } catch (error) {}
        resolve(value);
      }

      function selectRadio(selector, attribute, value) {
        root.querySelectorAll(selector).forEach((button) => button.setAttribute("aria-checked", String(button.dataset[attribute] === value)));
      }

      function onKey(event) {
        if (event.key === "Escape") { event.preventDefault(); close(null); }
      }

      root.addEventListener("click", (event) => {
        const time = event.target.closest("[data-time]");
        const paceButton = event.target.closest("[data-pace]");
        const focusButton = event.target.closest("[data-focus]");
        if (time) { timeOfDay = time.dataset.time; selectRadio("[data-time]", "time", timeOfDay); return; }
        if (paceButton) { pace = paceButton.dataset.pace; selectRadio("[data-pace]", "pace", pace); return; }
        if (focusButton) {
          const item = focusButton.dataset.focus;
          if (picked.has(item)) picked.delete(item); else picked.add(item);
          focusButton.setAttribute("aria-pressed", String(picked.has(item)));
          return;
        }
        if (event.target.closest("[data-style-ok]")) {
          const focus = [...mine, ...others].filter((item) => picked.has(item));
          try {
            localStorage.setItem(LAST_KEY, JSON.stringify({ timeOfDay, pace, extraFocus: focus.filter((item) => others.includes(item)) }));
          } catch (error) {}
          close({ timeOfDay, pace, focus });
          return;
        }
        if (event.target.closest("[data-style-cancel]")) close(null);
      });

      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(root);
      document.documentElement.style.overflow = "hidden";
      root.querySelector(".sk-style-panel")?.focus({ preventScroll: true });
    });
  }

  window.SidekickTripStyle = { ask, tooLateToday };
})();
