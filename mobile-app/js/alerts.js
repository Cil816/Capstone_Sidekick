document.addEventListener('DOMContentLoaded', () => {
  const session = window.SidekickCore?.getAuthSession?.();
  if (!session?.email) {
    window.location.href = 'login.html';
    return;
  }

  if (window.SidekickCore?.ensureReminderNotificationsReady) {
    window.SidekickCore.ensureReminderNotificationsReady(session.email).then((granted) => {
      if (!granted) {
        console.warn('[Alerts] Local notification permission is not granted. Reminders may not appear outside the app.');
        // Tell the user (not just the console) so they know why alerts won't pop up.
        const note = document.getElementById('alerts-permission-note');
        if (note && window.Capacitor?.isNativePlatform?.()) note.hidden = false;
      }
    }).catch(() => {});
  }

  const core = window.SidekickCore;
  const ui = window.SidekickUI;
  const email = session.email;
  const esc = (value) => core.escapeHtml(String(value ?? ''));
  const titleEl = document.getElementById('title');
  const dateEl = document.getElementById('date');
  const timeEl = document.getElementById('time');
  const setEarliestDay = () => { dateEl.min = toDatetimeLocalValue(Date.now()).slice(0, 10); };
  setEarliestDay();
  dateEl.addEventListener('focus', setEarliestDay); // the screen may stay open past midnight
  // "2026-10-31" + "15:05" -> a time; the date and time are picked in separate boxes.
  const joinWhen = (day, time) => (day && time ? new Date(`${day}T${time}`).getTime() : NaN);
  const dayPart = (ms) => toDatetimeLocalValue(ms).slice(0, 10);
  const timePart = (ms) => toDatetimeLocalValue(ms).slice(11, 16);
  const typeEl = document.getElementById('type');
  const addBtn = document.getElementById('add');
  const syncBtn = document.getElementById('sync-itinerary');
  const listEl = document.getElementById('reminders');
  const bulkActionsEl = document.getElementById('reminder-bulk-actions');
  const turnOffAllBtn = document.getElementById('turn-off-all-reminders');
  const removeAllBtn = document.getElementById('remove-all-reminders');
  const OPEN_DAYS_KEY = 'sidekick.alerts.openDays';
  const CUSTOM_TYPES = ['Schedule', 'Booking', 'Advisory'];
  // Extra alerts before a reminder the traveler adds (1 day, 10 hours, 5 hours, 1 hour).
  const OFFSETS = [
    { label: '1 day before', ms: 24 * 60 * 60 * 1000 },
    { label: '10 hours before', ms: 10 * 60 * 60 * 1000 },
    { label: '5 hours before', ms: 5 * 60 * 60 * 1000 },
    { label: '1 hour before', ms: 1 * 60 * 60 * 1000 },
  ];

  const ICONS = {
    Itinerary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    Booking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 0 0 6v3h20v-3a3 3 0 0 0 0-6V6H2Z"/><path d="M13 6v2M13 16v2M13 11v2"/></svg>',
    Advisory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    Schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  };

  // "Thu, Oct 15 · 11:00 PM" (no seconds, easy to scan)
  function formatWhen(timestamp) {
    const date = new Date(Number(timestamp));
    if (!Number.isFinite(date.getTime())) return '';
    const day = date.toLocaleDateString("en-US", { weekday: 'short', month: "long", day: 'numeric', year: "numeric" });
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${day} · ${time}`;
  }

  function toDatetimeLocalValue(timestamp) {
    const date = new Date(Number(timestamp || Date.now()));
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // ---- dates ------------------------------------------------------------------------
  const dayKey = (timestamp) => core.localDateValue(new Date(Number(timestamp)));

  // "Sat, Oct 24".
  function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: 'short', month: "long", day: 'numeric', year: "numeric" });
  }

  // Which date drop-downs are open (kept while the app is open). null: none chosen yet.
  // Which list is showing: "upcoming" or "expired" (reminders that already popped or passed).
  const VIEW_KEY = 'sidekick.alerts.view';
  let view = 'upcoming';
  try { if (sessionStorage.getItem(VIEW_KEY) === 'expired') view = 'expired'; } catch (error) {}
  function setView(next) {
    view = next;
    try { sessionStorage.setItem(VIEW_KEY, next); } catch (error) {}
    render();
  }

  function viewTabs(upcomingCount, expiredCount) {
    const tabs = document.createElement('div');
    tabs.className = 'sk-reminder-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Reminders');
    [['upcoming', 'Upcoming', upcomingCount], ['expired', 'Expired', expiredCount]].forEach(([key, label, count]) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `sk-reminder-tab${view === key ? ' active' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(view === key));
      tab.innerHTML = `${esc(label)} <span>${count}</span>`;
      tab.addEventListener('click', () => { if (view !== key) setView(key); });
      tabs.appendChild(tab);
    });
    return tabs;
  }

  function readOpenDays() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(OPEN_DAYS_KEY) || 'null');
      return Array.isArray(saved) ? new Set(saved) : null;
    } catch (error) { return null; }
  }

  function writeOpenDays(days) {
    try { sessionStorage.setItem(OPEN_DAYS_KEY, JSON.stringify(Array.from(days))); } catch (error) {}
  }

  // ---- names --------------------------------------------------------------------------
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  // A reminder already using this name (its own extra alerts don't count when editing).
  // Only reminders still coming up block a name; an expired one can be reused.
  function reminderNamed(title, ignoreIds = new Set()) {
    const now = Date.now();
    return (core.getRemindersFor(email) || []).find((reminder) => !ignoreIds.has(reminder.id)
      && Number(reminder.parentDueAt || reminder.dueAt || 0) > now
      && sameName(reminder.title, title)) || null;
  }

  function duplicateNameMessage(existing) {
    const when = formatWhen(existing.parentDueAt || existing.dueAt);
    return `You already have a reminder called “${existing.title}”${when ? ` (${when})` : ''}. Use a different name, or edit that one.`;
  }

  // ---- reminders the traveler added -------------------------------------------------
  const isItineraryReminder = (reminder) => reminder.type === 'Itinerary' || Boolean(reminder.itineraryActivityId);

  // A reminder and its extra "before" alerts.
  function customGroup(reminder) {
    const eventAt = Number(reminder.parentDueAt || reminder.dueAt);
    return (core.getRemindersFor(email) || []).filter((item) => !isItineraryReminder(item)
      && Number(item.parentDueAt || item.dueAt) === eventAt
      && item.title === reminder.title
      && item.type === reminder.type);
  }

  function addCustomReminder(title, type, dueAt, suppressed = false) {
    core.addReminderFor(email, { title, type, dueAt, note: type, parentDueAt: dueAt, suppressed });
    OFFSETS.forEach((off) => {
      const when = dueAt - off.ms;
      if (when > Date.now()) {
        core.addReminderFor(email, { title, type, dueAt: when, note: type, parentDueAt: dueAt, offsetLabel: off.label, offsetMs: off.ms, suppressed });
      }
    });
  }

  // ---- list -------------------------------------------------------------------------
  function heading(text, count) {
    const el = document.createElement('h2');
    el.className = 'sk-reminders-heading';
    el.innerHTML = `${esc(text)} <span>${count}</span>`;
    return el;
  }

  // One drop-down per date ("Sat, Oct 24  11"), holding that day's upcoming reminders.
  function dayGroup(key, items, open) {
    const group = document.createElement('details');
    group.className = 'sk-day-group';
    group.open = open;
    group.dataset.day = key;
    group.innerHTML = `<summary><span class="sk-day-group-date">${esc(dayLabel(key))}</span><span class="sk-day-group-count">${items.length} reminder${items.length === 1 ? '' : 's'}</span></summary><div class="sk-day-group-body"></div>`;
    const body = group.querySelector('.sk-day-group-body');
    items.forEach((r) => body.appendChild(renderReminderRow(r, false)));
    group.addEventListener('toggle', () => {
      const openDays = new Set(Array.from(listEl.querySelectorAll('.sk-day-group[open]')).map((el) => el.dataset.day));
      writeOpenDays(openDays);
    });
    return group;
  }

  function render() {
    // The bulk buttons sit inside the first heading; move them out before clearing.
    if (bulkActionsEl && listEl.contains(bulkActionsEl)) listEl.before(bulkActionsEl);
    listEl.innerHTML = '';
    const reminders = (core.getRemindersFor(email) || []).slice();
    reminders.sort((a, b) => (Number(a.dueAt || 0) - Number(b.dueAt || 0)));
    if (bulkActionsEl) bulkActionsEl.hidden = reminders.length === 0;
    if (turnOffAllBtn) turnOffAllBtn.disabled = reminders.length === 0 || reminders.every((reminder) => reminder.suppressed);

    const now = Date.now();
    const upcoming = reminders.filter((r) => !r.firedAt && Number(r.dueAt || 0) >= now);
    const past = reminders.filter((r) => r.firedAt || Number(r.dueAt || 0) < now);

    if (upcoming.length === 0 && past.length === 0) {
      listEl.innerHTML = '<div class="sk-reminders-empty"><strong>No reminders yet</strong>Add one above, or sync the stops from your itinerary.</div>';
      return;
    }

    listEl.appendChild(viewTabs(upcoming.length, past.length));
    shownUpcomingIds = upcoming.map((r) => r.id).join('|');

    if (view === 'upcoming' && !upcoming.length) {
      listEl.insertAdjacentHTML('beforeend', '<div class="sk-reminders-empty"><strong>Nothing coming up</strong>Reminders that already popped are under Expired.</div>');
    }
    if (view === 'expired' && !past.length) {
      listEl.insertAdjacentHTML('beforeend', '<div class="sk-reminders-empty"><strong>No expired reminders</strong>Reminders move here after they pop up.</div>');
    }

    if (view === 'upcoming' && upcoming.length) {
      // Grouped by date, earliest first; the first date starts open.
      const byDay = new Map();
      upcoming.forEach((r) => {
        const key = dayKey(r.dueAt);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(r);
      });
      const days = Array.from(byDay.keys());
      const openDays = readOpenDays() || new Set([days[0]]);
      listEl.appendChild(heading('Upcoming', upcoming.length));
      days.forEach((key) => listEl.appendChild(dayGroup(key, byDay.get(key), openDays.has(key))));
    }

    if (view === 'expired' && past.length) {
      // Latest first: the one that just popped is on top.
      listEl.appendChild(heading('Expired', past.length));
      past.slice().reverse().forEach((r) => listEl.appendChild(renderReminderRow(r, true)));
    }

    // "Turn off all" / "Remove all" on the same line as the first heading.
    const firstHeading = listEl.querySelector('.sk-reminders-heading');
    if (bulkActionsEl && firstHeading) firstHeading.appendChild(bulkActionsEl);
  }

  // A reminder that pops while this screen is open moves to Expired without a reload.
  let shownUpcomingIds = '';
  window.setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    const ids = (core.getRemindersFor(email) || []).slice()
      .sort((a, b) => (Number(a.dueAt || 0) - Number(b.dueAt || 0)))
      .filter((r) => !r.firedAt && Number(r.dueAt || 0) >= now)
      .map((r) => r.id).join('|');
    if (ids !== shownUpcomingIds) render();
  }, 30000);

  function renderReminderRow(r, isPast) {
    const el = document.createElement('article');
    el.className = `sk-reminder-card${r.suppressed ? ' is-off' : ''}${isPast ? ' is-past' : ''}`;
    const chips = [
      r.type === 'Itinerary' ? '<span class="sk-chip">From itinerary</span>' : `<span class="sk-chip">${esc(r.type || 'Reminder')}</span>`,
      r.offsetLabel ? `<span class="sk-chip is-warm">${esc(r.offsetLabel)}</span>` : '',
      r.suppressed ? '<span class="sk-chip is-off">Off</span>' : '',
    ].join('');
    const eventLine = r.parentDueAt && Number(r.parentDueAt) !== Number(r.dueAt)
      ? `<p class="sk-reminder-when"><b>Event</b> ${esc(formatWhen(r.parentDueAt))}</p>`
      : '';
    el.innerHTML = `
      <div class="sk-reminder-icon" aria-hidden="true">${ICONS[r.type] || ICONS.Schedule}</div>
      <div>
        <h3 class="sk-reminder-title">${esc(r.title || r.type)}</h3>
        <div class="sk-reminder-chips">${chips}</div>
        <p class="sk-reminder-when"><b>Alert</b> ${esc(formatWhen(r.dueAt))}</p>
        ${eventLine}
      </div>
      <div class="sk-reminder-actions"></div>`;
    const actions = el.querySelector('.sk-reminder-actions');
    const button = (label, onClick, className = '') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (className) btn.className = className;
      btn.setAttribute('aria-label', `${label}: ${r.title || r.type}`);
      btn.addEventListener('click', onClick);
      actions.appendChild(btn);
    };
    // Reminders from an itinerary follow its activities: their times change on the
    // Itinerary tab, so only reminders the traveler added can be edited here.
    if (!isItineraryReminder(r)) button('Edit', () => editCustomReminder(r));
    button(r.suppressed ? 'Turn on' : 'Turn off', () => {
      try {
        core.setReminderSuppressed(email, r.id, !r.suppressed);
        if (!r.suppressed && core.scheduleAllFor) core.scheduleAllFor(email);
      } catch (e) {}
      render();
    });
    button('Remove', async () => {
      const which = r.offsetLabel ? `the “${r.offsetLabel}” alert for “${r.title || r.type}”` : `“${r.title || r.type}”`;
      const ok = await ui.confirm(`Remove ${which} (${formatWhen(r.dueAt)})? This cannot be undone.`, {
        title: 'Remove this reminder?', confirmText: 'Remove', cancelText: 'Keep it', tone: 'danger',
      });
      if (!ok) return;
      core.removeReminderFor(email, r.id);
      render();
      ui.toast('Reminder removed');
    }, 'is-danger');
    return el;
  }

  // ---- add --------------------------------------------------------------------------
  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const title = String(titleEl.value || '').trim();
    const type = typeEl.value;
    if (!title || !dateEl.value || !timeEl.value) {
      ui.alert(!title ? 'Give your reminder a short title, like "Bus to Batangas City".' : 'Choose the date and time for this reminder.', { title: 'Almost there' });
      return;
    }
    const dueAt = joinWhen(dateEl.value, timeEl.value);
    if (!Number.isFinite(dueAt)) {
      ui.alert('Choose a valid date and time.', { title: 'Check the date' });
      return;
    }
    if (dueAt <= Date.now()) {
      ui.alert('That time has already passed. Choose a later date and time.', { title: 'Check the date' });
      return;
    }
    const existing = reminderNamed(title);
    if (existing) {
      ui.alert(duplicateNameMessage(existing), { title: 'That reminder already exists' });
      titleEl.focus();
      return;
    }
    addCustomReminder(title, type, dueAt);
    titleEl.value = '';
    dateEl.value = '';
    timeEl.value = '';
    render();
    ui.toast('Reminder added');
  });

  // ---- edit -------------------------------------------------------------------------
  // A reminder the traveler added: its name, time and type. Its extra alerts are made
  // again for the new time.
  async function editCustomReminder(reminder) {
    const group = customGroup(reminder);
    const groupIds = new Set(group.map((item) => item.id));
    const eventAt = Number(reminder.parentDueAt || reminder.dueAt);
    const values = await ui.form({
      title: 'Edit reminder',
      fields: [
        { name: 'title', label: 'What should we remind you about?', type: 'text', value: reminder.title || '', maxLength: 120 },
        { name: 'day', label: 'Date', type: 'date', value: dayPart(eventAt), min: dayPart(Date.now()) },
        { name: 'time', label: 'Time', type: 'time', value: timePart(eventAt) },
        { name: 'type', label: 'Type', type: 'select', value: CUSTOM_TYPES.includes(reminder.type) ? reminder.type : 'Schedule', options: CUSTOM_TYPES.map((type) => [type, type]) },
      ],
      confirmText: 'Save',
      validate: ({ title, day, time }) => {
        if (!title) return 'Give your reminder a short title.';
        const dueAt = joinWhen(day, time);
        if (!Number.isFinite(dueAt)) return 'Choose a valid date and time.';
        if (dueAt <= Date.now()) return 'That time has already passed. Choose a later date and time.';
        const existing = reminderNamed(title, groupIds);
        return existing ? duplicateNameMessage(existing) : '';
      },
    });
    if (!values) return;
    const dueAt = joinWhen(values.day, values.time);
    const suppressed = group.length > 0 && group.every((item) => item.suppressed);
    group.forEach((item) => core.removeReminderFor(email, item.id));
    addCustomReminder(values.title.trim(), values.type, dueAt, suppressed);
    render();
    ui.toast('Reminder updated');
  }

  // ---- sync / bulk ------------------------------------------------------------------
  if (syncBtn) {
    syncBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (core && core.syncRemindersFromItinerary) {
          core.syncRemindersFromItinerary(email);
          if (core.scheduleAllFor) core.scheduleAllFor(email);
          render();
          ui.toast('Synced with your itinerary');
        } else {
          ui.alert('Itinerary sync is not available right now.', { title: 'Sync unavailable' });
        }
      } catch (err) { }
    });
  }

  if (turnOffAllBtn) {
    turnOffAllBtn.addEventListener('click', () => {
      const reminders = core.getRemindersFor(email) || [];
      if (!reminders.some((reminder) => !reminder.suppressed)) return;
      core.turnOffAllRemindersFor(email);
      render();
      ui.toast('All reminders turned off');
    });
  }

  if (removeAllBtn) {
    removeAllBtn.addEventListener('click', async () => {
      const reminders = core.getRemindersFor(email) || [];
      if (!reminders.length) return;
      const ok = await ui.confirm(`All ${reminders.length} reminders will be removed from this phone. This cannot be undone.`, {
        title: 'Remove all reminders?', confirmText: 'Remove all', tone: 'danger',
      });
      if (!ok) return;
      core.removeAllRemindersFor(email);
      render();
    });
  }

  render();

  // Refresh when reminders change elsewhere
  document.addEventListener('sidekick:reminders-updated', () => render());
});
