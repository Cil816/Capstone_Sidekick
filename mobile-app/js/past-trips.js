// Past trips screen (past-trips.html, opened from Profile): finished itineraries, read from the server (the archive copy
// made when a trip ends). Each trip is a drop-down named after the itinerary, showing
// every day's activities exactly as last planned, edits and added activities included.
(function () {
  const esc = (value) => window.SidekickCore.escapeHtml(String(value ?? ""));

  // "2026-10-21" -> a local date (no time-zone shift).
  function localDate(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }

  function dayText(text, withWeekday = true) {
    const date = localDate(text);
    return date ? date.toLocaleDateString("en-US", { ...(withWeekday ? { weekday: "short" } : {}), month: "long", day: "numeric", year: "numeric" }) : "";
  }

  function rangeText(start, end) {
    if (!start) return "";
    if (!end || end === start) return dayText(start, false);
    const first = localDate(start);
    const last = localDate(end);
    const sameYear = first && last && first.getFullYear() === last.getFullYear();
    const year = last ? `, ${last.getFullYear()}` : "";
    return `${dayText(start, false)} – ${dayText(end, false)}${sameYear ? year : ""}`;
  }

  // "14:30" -> "2:30 PM".
  function timeText(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
    if (!match) return "";
    const hour = Number(match[1]);
    return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
  }

  // The name the app showed for the itinerary (its own default is "<destination> trip").
  function tripName(trip) {
    const title = String(trip.title || "").trim();
    const destination = String(trip.destination || "").trim();
    if (!title || (destination && title.toLowerCase() === `${destination} itinerary`.toLowerCase())) {
      return destination ? `${destination} trip` : "My trip";
    }
    return title;
  }

  function renderTrip(trip) {
    const count = trip.days.reduce((sum, day) => sum + day.activities.length, 0);
    const kept = trip.keptUntil ? new Date(trip.keptUntil).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
    const details = [trip.destination, trip.budget ? `Budget: ${trip.budget}` : "", kept ? `Kept until ${kept}` : ""].filter(Boolean).join(" · ");
    const days = trip.days.map((day) => `
      <div class="past-trip-day">
        <h3>Day ${esc(day.dayNumber)}${day.date ? ` · ${esc(dayText(day.date))}` : ""}</h3>
        <ol>
          ${day.activities.map((activity) => `
            <li>
              <span class="past-trip-time">${esc(timeText(activity.time) || "—")}</span>
              <span class="past-trip-stop"><strong>${esc(activity.title)}</strong>${activity.location ? `<small>${esc(activity.location)}</small>` : ""}</span>
            </li>`).join("")}
        </ol>
      </div>`).join("");
    return `
      <details class="past-trip" data-past-trip="${esc(trip.id)}">
        <summary>
          <input type="checkbox" class="past-trip-check" data-select-past-trip="${esc(trip.id)}" aria-label="Select ${esc(tripName(trip))}" tabindex="-1">
          <span class="past-trip-head">
            <span class="past-trip-name">${esc(tripName(trip))}</span>
            <small>${esc(rangeText(trip.startDate, trip.endDate))}${count ? ` · ${count} activit${count === 1 ? "y" : "ies"}` : ""}</small>
          </span>
        </summary>
        <div class="past-trip-body">
          ${details ? `<p class="past-trip-meta">${esc(details)}</p>` : ""}
          ${days || '<p class="past-trip-meta">No activities were saved for this trip.</p>'}
          <div class="past-trip-actions">
            ${count ? `<button type="button" class="past-trip-repeat" data-repeat-past-trip="${esc(trip.id)}">Do this trip again</button>` : ""}
            <button type="button" class="past-trip-remove" data-remove-past-trip="${esc(trip.id)}" aria-label="Remove ${esc(tripName(trip))} from Past trips">Remove</button>
          </div>
        </div>
      </details>`;
  }

  let retentionDays = 30;
  // The Past trips entries from the server, by archive ID ("Do this trip again" uses them).
  const pastById = new Map();

  // A removed past trip's full copy on this phone goes too.
  function forgetCopies(archiveIds) {
    const email = window.SidekickCore.getAuthSession?.()?.email;
    const tripIds = archiveIds.map((id) => pastById.get(Number(id))?.tripId).filter(Boolean);
    if (email && tripIds.length) window.SidekickCore.forgetFinishedTripCopies?.(email, tripIds);
  }

  function showEmpty(list) {
    setSelecting(false);
    const toolbar = document.getElementById("past-trips-toolbar");
    if (toolbar) toolbar.hidden = true;
    list.innerHTML = '<p class="past-trips-empty">No past trips yet. When a trip ends, it will appear here.</p>';
  }

  // ---- Edit: select trips with check boxes, then remove them together ----------------
  const $ = (id) => document.getElementById(id);
  let selecting = false;

  function checks() {
    return Array.from(document.querySelectorAll("#past-trips-list .past-trip-check"));
  }

  function updateSelection() {
    const all = checks();
    const chosen = all.filter((box) => box.checked);
    const count = $("past-trips-count");
    if (count) count.textContent = `${chosen.length} selected`;
    const remove = $("past-trips-delete");
    if (remove) {
      remove.disabled = !chosen.length;
      remove.textContent = chosen.length ? `Remove (${chosen.length})` : "Remove";
    }
    const selectAll = $("past-trips-select-all");
    if (selectAll) {
      selectAll.checked = Boolean(all.length) && chosen.length === all.length;
      selectAll.indeterminate = chosen.length > 0 && chosen.length < all.length;
    }
    all.forEach((box) => box.closest(".past-trip")?.classList.toggle("is-selected", box.checked));
  }

  function setSelecting(on) {
    selecting = Boolean(on);
    const list = $("past-trips-list");
    list?.classList.toggle("is-selecting", selecting);
    const edit = $("past-trips-edit");
    const bar = $("past-trips-select-bar");
    if (edit) edit.hidden = selecting;
    if (bar) bar.hidden = !selecting;
    checks().forEach((box) => {
      box.checked = false;
      box.tabIndex = selecting ? 0 : -1;
    });
    updateSelection();
  }

  async function removeSelected() {
    const chosen = checks().filter((box) => box.checked);
    const ids = chosen.map((box) => Number(box.dataset.selectPastTrip)).filter(Number.isSafeInteger);
    if (!ids.length) return;
    const many = ids.length > 1;
    const ok = await window.SidekickUI.confirm(`${many ? "They" : "It"} will be removed from your app. A secure copy is kept for up to ${retentionDays} day${retentionDays === 1 ? "" : "s"} for support, then deleted for good.`, {
      title: many ? `Remove ${ids.length} trips?` : `Remove “${chosen[0].closest(".past-trip")?.querySelector(".past-trip-name")?.textContent || "this trip"}”?`,
      confirmText: "Remove", cancelText: "Keep", tone: "danger",
    });
    if (!ok) return;
    const button = $("past-trips-delete");
    if (button) button.disabled = true;
    window.SidekickUI.loading.show();
    try {
      const result = await window.SidekickCore.apiRequest("/api/app-itineraries/past/remove", { method: "POST", body: JSON.stringify({ ids }) });
      forgetCopies(ids);
      chosen.forEach((box) => box.closest(".past-trip")?.remove());
      const list = $("past-trips-list");
      if (list && !list.querySelector(".past-trip")) showEmpty(list);
      else setSelecting(false);
      window.SidekickUI.toast(result?.message || `${ids.length} trip${many ? "s" : ""} removed from Past trips.`);
    } catch (error) {
      updateSelection();
      window.SidekickUI.alert(window.SidekickCore.friendlyError(error, "These trips couldn’t be removed right now. Please try again."), { title: "Not removed" });
    } finally {
      window.SidekickUI.loading.hide();
    }
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("#past-trips-edit")) { setSelecting(true); return; }
    if (event.target.closest("#past-trips-done")) { setSelecting(false); return; }
    if (event.target.closest("#past-trips-delete")) { void removeSelected(); return; }
    // While selecting, tapping a trip's title row ticks its box instead of opening it.
    const summary = selecting && event.target.closest("#past-trips-list .past-trip > summary");
    if (summary) {
      event.preventDefault();
      const box = summary.querySelector(".past-trip-check");
      if (box && event.target !== box) box.checked = !box.checked;
      updateSelection();
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "past-trips-select-all") {
      checks().forEach((box) => { box.checked = event.target.checked; });
      updateSelection();
    } else if (event.target.classList?.contains("past-trip-check")) {
      updateSelection();
    }
  });

  // Removes a trip from this list. The server keeps its archive copy (marked as removed
  // by the traveler) until the archive's retention period ends.
  async function removeTrip(button) {
    const card = button.closest(".past-trip");
    const id = Number(button.dataset.removePastTrip);
    if (!card || !Number.isSafeInteger(id)) return;
    const name = card.querySelector(".past-trip-name")?.textContent || "this trip";
    const ok = await window.SidekickUI.confirm(`It will be removed from your app. A secure copy is kept for up to ${retentionDays} day${retentionDays === 1 ? "" : "s"} for support, then deleted for good.`, {
      title: `Remove “${name}”?`, confirmText: "Remove", cancelText: "Keep it", tone: "danger",
    });
    if (!ok) return;
    button.disabled = true;
    window.SidekickUI.loading.show();
    try {
      await window.SidekickCore.apiRequest(`/api/app-itineraries/past/${id}`, { method: "DELETE" });
      forgetCopies([id]);
      const list = card.parentElement;
      card.remove();
      if (list && !list.querySelector(".past-trip")) showEmpty(list);
      window.SidekickUI.toast("Trip removed from Past trips.");
    } catch (error) {
      button.disabled = false;
      window.SidekickUI.alert(window.SidekickCore.friendlyError(error, "This trip couldn’t be removed right now. Please try again."), { title: "Not removed" });
    } finally {
      window.SidekickUI.loading.hide();
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-past-trip]");
    if (button && !button.disabled) void removeTrip(button);
    const repeat = event.target.closest("[data-repeat-past-trip]");
    if (repeat && !repeat.disabled) void repeatTrip(repeat);
  });

  // "Do this trip again": asks for a new start date, then opens the same trip on the
  // Itinerary tab as an unsaved itinerary (same days, stops and times), ready to edit and
  // save. Start dates that have passed, a day 1 that is already too late today, and
  // dates taken by another planned trip are refused, as when building a trip.
  async function repeatTrip(button) {
    const core = window.SidekickCore;
    const trip = pastById.get(Number(button.dataset.repeatPastTrip));
    const email = core.getAuthSession?.()?.email;
    if (!trip || !email) return;
    const full = trip.tripId ? core.getFinishedTripCopy(email, trip.tripId) : null;
    const preview = core.repeatTripData(trip, full, core.localDateValue());
    if (!preview) {
      window.SidekickUI.alert("This trip has no activities to copy.", { title: "Nothing to copy" });
      return;
    }
    const dayCount = preview.itinerary.length;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    let start = core.localDateValue(tomorrow);
    const oldBudget = Number(preview.meta?.budgetAmountPhp) > 0 ? Math.floor(Number(preview.meta.budgetAmountPhp)) : null;
    let budgetText = oldBudget ? String(oldBudget) : "";
    let data = null;
    let budget = null;
    for (;;) {
      const values = await window.SidekickUI.form({
        title: "Do this trip again",
        icon: "question",
        message: `When do you want to go? “${tripName(trip)}” (${dayCount} day${dayCount === 1 ? "" : "s"}) keeps its activities and times. You can edit it before saving.`,
        fields: [
          { name: "start", label: "New start date", type: "date", value: start, min: core.localDateValue() },
          { name: "budget", label: "Total budget (PHP)", type: "number", value: budgetText, min: 1, hint: oldBudget ? `Last time: ₱${oldBudget.toLocaleString()}` : "" },
        ],
        confirmText: "Plan this trip",
        validate: ({ start: value, budget: amount }) => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Choose a start date.";
          const number = Number(amount);
          if (!amount || !Number.isFinite(number) || number < 1) return "Enter your total budget in pesos.";
          return "";
        },
      });
      if (!values) return;
      start = values.start;
      budgetText = values.budget;
      budget = Math.floor(Number(values.budget));
      data = core.repeatTripData(trip, full, start);
      const problem = data ? core.repeatTripProblem(email, data) : { title: "Not a valid date", message: "Choose a valid start date." };
      if (problem) {
        await window.SidekickUI.alert(problem.message, { title: problem.title, confirmText: "Change date" });
        continue;
      }
      // The same budget check as building a trip: far too much, or too little for the
      // cheapest hotel and meals at this destination for these dates.
      const range = core.tripDateRange(data);
      const destination = String(data.meta?.destination || trip.destination || "").trim();
      const spot = data.itinerary.flatMap((day) => day.activities || []).find((activity) => Number.isFinite(Number(activity?.locationCoords?.lat)) && Number.isFinite(Number(activity?.locationCoords?.lng)));
      let check = null;
      window.SidekickUI.loading.show("Checking your budget…");
      try {
        check = await core.checkTripBudget({
          destination,
          lat: spot ? Number(spot.locationCoords.lat) : null,
          lng: spot ? Number(spot.locationCoords.lng) : null,
          startDate: range.start,
          endDate: range.end,
          budgetAmountPhp: budget,
          travelers: data.meta?.travelers || 1,
        });
      } finally {
        window.SidekickUI.loading.hide();
      }
      if (check?.checked && !check.realistic) {
        const issue = core.describeUnrealisticBudget(check, destination || "this destination");
        await window.SidekickUI.alert(issue.message, { title: issue.title, details: issue.details, confirmText: "Change budget" });
        continue;
      }
      break;
    }
    // The new budget; targets worked out for a different amount are dropped so they
    // follow the new one.
    if (budget !== oldBudget) {
      delete data.meta.activityBudgetTargetPhp;
      delete data.meta.dailyActivityBudgetTargetPhp;
    }
    data.meta.budgetAmountPhp = budget;
    data.meta.budget = `PHP ${budget.toLocaleString()} total`;
    const draft = core.getItineraryDraft(email);
    if (draft) {
      const ok = await window.SidekickUI.confirm(`You have an itinerary that isn’t saved yet, “${core.tripDisplayName(draft)}”. This trip will take its place.`, {
        title: "Replace your unsaved itinerary?", confirmText: "Replace it", cancelText: "Keep it", tone: "danger",
      });
      if (!ok) return;
    }
    try {
      core.openRepeatedTrip(email, data);
    } catch (error) {
      window.SidekickUI.alert("This trip couldn’t be copied on this device. Free up some storage and try again.", { title: "Not copied" });
      return;
    }
    try {
      sessionStorage.removeItem("sidekick.itinerary.openCollapsed");
      sessionStorage.setItem("sidekick.itinerary.scrollToOpen", "draft");
      sessionStorage.setItem("sidekick.itinerary.flash", `“${core.tripDisplayName(data)}” is planned again for ${core.shortDateRangeText(core.tripDateRange(data))}. Look it over, then save it.`);
    } catch (error) {}
    window.SidekickUI.loading.show();
    window.location.href = "itinerary.html";
  }

  async function load() {
    const list = document.getElementById("past-trips-list");
    const intro = document.getElementById("past-trips-intro");
    if (!list) return;
    const session = window.SidekickCore?.requireAuth?.();
    if (!session) return; // requireAuth has already gone to the login screen
    if (!session?.apiToken) {
      list.innerHTML = '<p class="past-trips-empty">Log out and log in again to see your past trips.</p>';
      return;
    }
    try {
      const data = await window.SidekickCore.apiRequest("/api/app-itineraries/past");
      const trips = Array.isArray(data?.trips) ? data.trips : [];
      const days = Number(data?.retentionDays) || 30;
      retentionDays = days;
      if (intro) intro.textContent = `Finished trips, with every activity as planned. Each appears 2 days after it ends and stays for ${days} day${days === 1 ? "" : "s"}.`;
      pastById.clear();
      trips.forEach((trip) => pastById.set(Number(trip.id), trip));
      if (trips.length) {
        list.innerHTML = trips.map(renderTrip).join("");
        const toolbar = document.getElementById("past-trips-toolbar");
        if (toolbar) toolbar.hidden = false;
        setSelecting(false);
      } else {
        showEmpty(list);
      }
    } catch (error) {
      list.innerHTML = `<p class="past-trips-empty">${esc(window.SidekickCore.friendlyError(error, "Your past trips couldn’t be loaded right now. Pull down to try again."))}</p>`;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
