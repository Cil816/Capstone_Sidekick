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
  const dtEl = document.getElementById('datetime');
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
    const day = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Which date drop-downs are open (kept while the app is open). null: none chosen yet.
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
  function reminderNamed(title, ignoreIds = new Set()) {
    return (core.getRemindersFor(email) || []).find((reminder) => !ignoreIds.has(reminder.id) && sameName(reminder.title, title)) || null;
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

    if (upcoming.length) {
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

    if (past.length) {
      listEl.appendChild(heading('Past', past.length));
      past.forEach((r) => listEl.appendChild(renderReminderRow(r, true)));
    }

    // "Turn off all" / "Remove all" on the same line as the first heading.
    const firstHeading = listEl.querySelector('.sk-reminders-heading');
    if (bulkActionsEl && firstHeading) firstHeading.appendChild(bulkActionsEl);
  }

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
    button('Edit', () => (isItineraryReminder(r) ? editItineraryReminder(r) : editCustomReminder(r)));
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
    const dt = dtEl.value;
    const type = typeEl.value;
    if (!title || !dt) {
      ui.alert(!title ? 'Give your reminder a short title, like "Bus to Batangas City".' : 'Choose the date and time for this reminder.', { title: 'Almost there' });
      return;
    }
    const dueAt = new Date(dt).getTime();
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
    dtEl.value = '';
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
        { name: 'when', label: 'Date and time', type: 'datetime-local', value: toDatetimeLocalValue(eventAt), min: toDatetimeLocalValue(Date.now()) },
        { name: 'type', label: 'Type', type: 'select', value: CUSTOM_TYPES.includes(reminder.type) ? reminder.type : 'Schedule', options: CUSTOM_TYPES.map((type) => [type, type]) },
      ],
      confirmText: 'Save',
      validate: ({ title, when }) => {
        if (!title) return 'Give your reminder a short title.';
        const dueAt = new Date(when).getTime();
        if (!when || !Number.isFinite(dueAt)) return 'Choose a valid date and time.';
        if (dueAt <= Date.now()) return 'That time has already passed. Choose a later date and time.';
        const existing = reminderNamed(title, groupIds);
        return existing ? duplicateNameMessage(existing) : '';
      },
    });
    if (!values) return;
    const dueAt = new Date(values.when).getTime();
    const suppressed = group.length > 0 && group.every((item) => item.suppressed);
    group.forEach((item) => core.removeReminderFor(email, item.id));
    addCustomReminder(values.title.trim(), values.type, dueAt, suppressed);
    render();
    ui.toast('Reminder updated');
  }

  // The trip (open itinerary or planned trip) an activity belongs to.
  function tripOfActivity(activityId, title, eventAt) {
    const open = core.getItineraryByEmail()[email];
    const trips = [open, ...(core.getPlannedTrips?.(email) || [])].filter(Boolean);
    return trips.find((trip) => (trip.itinerary || []).some((day) => (day.activities || []).some((activity) => (
      activityId ? activity.id === activityId : Number(activity.dueAt) === Number(eventAt) && activity.title === title
    )))) || null;
  }

  // An itinerary reminder: moves its activity (all of that stop's alerts follow). The
  // new time must be ahead and inside that trip's dates.
  async function editItineraryReminder(reminder) {
    const eventAt = Number(reminder.parentDueAt || reminder.dueAt);
    const name = reminder.parentTitle || reminder.title || 'this activity';
    const trip = tripOfActivity(reminder.itineraryActivityId, name, eventAt);
    if (!trip) {
      ui.alert('This activity is no longer in your itinerary. Sync from your itinerary to refresh your reminders.', { title: 'Activity not found' });
      return;
    }
    const range = core.tripDateRange(trip);
    const rangeText = core.shortDateRangeText(range);
    const values = await ui.form({
      title: 'Edit activity time',
      message: `“${name}” is part of ${core.tripDisplayName(trip)} (${rangeText}). Changing its time also moves it on your itinerary, and its alerts follow.`,
      fields: [
        { name: 'when', label: 'Activity date and time', type: 'datetime-local', value: toDatetimeLocalValue(eventAt), min: toDatetimeLocalValue(Math.max(Date.now(), new Date(`${range.start}T00:00`).getTime())), max: `${range.end}T23:59` },
      ],
      confirmText: 'Save',
      validate: ({ when }) => {
        const dueAt = new Date(when).getTime();
        if (!when || !Number.isFinite(dueAt)) return 'Choose a valid date and time.';
        if (dueAt <= Date.now()) return 'That time has already passed. Choose a later date and time.';
        const day = dayKey(dueAt);
        if (day < range.start || day > range.end) return `Choose a time during this trip (${rangeText}). To move the whole trip, use Change dates on the Itinerary tab.`;
        return '';
      },
    });
    if (!values) return;
    const updated = core.updateItineraryActivitySchedule?.(email, {
      activityId: reminder.itineraryActivityId,
      parentDueAt: eventAt,
      parentTitle: name,
      newDueAt: new Date(values.when).getTime(),
    });
    if (!updated) {
      ui.alert('That activity’s time couldn’t be changed. Please try again.', { title: 'Not saved' });
      return;
    }
    try { core.syncRemindersFromItinerary?.(email); core.scheduleAllFor?.(email); } catch (e) {}
    render();
    ui.toast('Activity time updated');
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
