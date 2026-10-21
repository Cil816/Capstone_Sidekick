// Itinerary tab → "Planned trips": every saved trip, plus the itinerary that isn't saved
// yet, as drop-downs named after the trip. The open one shows the full itinerary under
// its drop-down (photos, costs, map and editing, all from js/itinerary.js); an unsaved
// itinerary ends with "Save itinerary" / "Discard". Opening another trip makes it the
// open itinerary (SidekickCore.openTripForEmail) and reloads the screen with it.
(function () {
  const core = () => window.SidekickCore;
  const $ = (id) => document.getElementById(id);
  const COLLAPSED_KEY = "sidekick.itinerary.openCollapsed";
  const SCROLL_KEY = "sidekick.itinerary.scrollToOpen";
  const FLASH_KEY = "sidekick.itinerary.flash";

  const email = () => core()?.getAuthSession?.()?.email || "";
  const esc = (value) => core().escapeHtml(String(value ?? ""));

  function isCollapsed() {
    try { return sessionStorage.getItem(COLLAPSED_KEY) === "1"; } catch (error) { return false; }
  }

  function setCollapsed(value) {
    try {
      if (value) sessionStorage.setItem(COLLAPSED_KEY, "1");
      else sessionStorage.removeItem(COLLAPSED_KEY);
    } catch (error) { /* storage unavailable */ }
  }

  function openKeyOf(data) {
    if (!data) return null;
    return data.meta?.isDraft ? "draft" : data.meta?.planId || null;
  }

  function activityCount(data) {
    return (data?.itinerary || []).reduce((sum, day) => sum + (day?.activities || []).length, 0);
  }

  function rowHtml(data, key, openKey) {
    const range = core().shortDateRangeText(core().tripDateRange(data));
    const count = activityCount(data);
    const expanded = key === openKey && !isCollapsed();
    return `
      <button type="button" class="planned-trip-row${key === "draft" ? " is-draft" : ""}${expanded ? " is-open" : ""}" data-trip-key="${esc(key)}" aria-expanded="${expanded}" aria-controls="active-trip-view">
        <span class="planned-trip-head">
          <span class="planned-trip-name">${esc(core().tripDisplayName(data))}</span>
          <small>${esc(range)}${count ? ` · ${count} activit${count === 1 ? "y" : "ies"}` : ""}</small>
        </span>
        ${key === "draft" ? '<span class="planned-trip-badge">Not saved</span>' : ""}
        <span class="planned-trip-chevron" aria-hidden="true"></span>
      </button>`;
  }

  function render() {
    const section = $("planned-trips");
    const list = $("planned-trips-list");
    const view = $("active-trip-view");
    if (!section || !list || !view) return;
    const who = email();
    const trips = core().getPlannedTrips(who);
    const draft = core().getItineraryDraft(who);
    const open = core().getItineraryByEmail()[who] || null;
    const openKey = openKeyOf(open);

    section.hidden = !trips.length && !draft;
    list.innerHTML = [
      ...(draft ? [rowHtml(draft, "draft", openKey)] : []),
      ...trips.map((trip) => rowHtml(trip, trip.meta?.planId, openKey)),
    ].join("");

    // The open trip's full view goes right under its drop-down.
    const openRow = openKey ? list.querySelector(`[data-trip-key="${CSS.escape(openKey)}"]`) : null;
    if (openRow) openRow.insertAdjacentElement("afterend", view);
    else section.insertAdjacentElement("afterend", view);
    view.hidden = !openRow || isCollapsed();
    view.classList.toggle("is-in-list", Boolean(openRow));
    view.classList.toggle("is-draft", openKey === "draft");

    const saveBar = $("itinerary-save-bar");
    if (saveBar) saveBar.hidden = openKey !== "draft" || !activityCount(open);
  }

  let renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function reloadShowing(key) {
    try { sessionStorage.setItem(SCROLL_KEY, key || "1"); } catch (error) {}
    window.SidekickUI?.loading.show();
    window.location.reload();
  }

  async function onRowClick(row) {
    const key = row.dataset.tripKey;
    const open = core().getItineraryByEmail()[email()] || null;
    if (key === openKeyOf(open)) {
      // The open trip: show or hide its itinerary.
      setCollapsed(!isCollapsed());
      render();
      return;
    }
    if (core().openTripForEmail(email(), key)) {
      setCollapsed(false);
      reloadShowing(key);
    }
  }

  async function saveDraft() {
    const button = $("itinerary-save-btn");
    if (button) button.disabled = true;
    window.SidekickUI.loading.show("Saving your itinerary…");
    try {
      const saved = await core().savePlannedTrip(email());
      core().syncRemindersFromItinerary?.(email());
      core().scheduleAllFor?.(email());
      try { sessionStorage.setItem(FLASH_KEY, `“${core().tripDisplayName(saved)}” is saved to your planned trips.`); } catch (error) {}
      setCollapsed(false);
      reloadShowing(saved.meta?.planId);
    } catch (error) {
      window.SidekickUI.loading.hide(true);
      if (button) button.disabled = false;
      window.SidekickUI.alert(
        error?.overlap ? error.message : core().friendlyError(error, "Your itinerary couldn’t be saved right now. Please try again."),
        { title: error?.overlap ? "Those dates are taken" : "Not saved" },
      );
    }
  }

  async function discardDraft() {
    const draft = core().getItineraryDraft(email());
    const ok = await window.SidekickUI.confirm(`“${core().tripDisplayName(draft)}” hasn’t been saved, so it will be gone for good.`, {
      title: "Discard this itinerary?", confirmText: "Discard", cancelText: "Keep it", tone: "danger",
    });
    if (!ok) return;
    core().discardItineraryDraft(email());
    reloadShowing("");
  }

  document.addEventListener("click", (event) => {
    const row = event.target.closest("#planned-trips-list .planned-trip-row");
    if (row) { void onRowClick(row); return; }
    if (event.target.closest("#itinerary-save-btn")) { void saveDraft(); return; }
    if (event.target.closest("#itinerary-discard-btn")) void discardDraft();
  });

  document.addEventListener("sidekick:itinerary-updated", queueRender);
  document.addEventListener("sidekick:planned-trips-updated", queueRender);
  document.addEventListener("sidekick:draft-built", () => {
    setCollapsed(false);
    render();
    $("planned-trips-list")?.querySelector('[data-trip-key="draft"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.addEventListener("DOMContentLoaded", () => {
    if (!email()) return;
    render();
    let scrollTo = "";
    let flash = "";
    try {
      scrollTo = sessionStorage.getItem(SCROLL_KEY) || "";
      sessionStorage.removeItem(SCROLL_KEY);
      flash = sessionStorage.getItem(FLASH_KEY) || "";
      sessionStorage.removeItem(FLASH_KEY);
    } catch (error) {}
    if (scrollTo && scrollTo !== "1") {
      requestAnimationFrame(() => $("planned-trips-list")?.querySelector(`[data-trip-key="${CSS.escape(scrollTo)}"]`)?.scrollIntoView({ block: "start" }));
    }
    if (flash) window.SidekickUI?.toast(flash, 3200);
  });
})();
