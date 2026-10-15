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

  const ui = window.SidekickUI;
  const esc = (value) => window.SidekickCore.escapeHtml(String(value ?? ''));
  const titleEl = document.getElementById('title');
  const dtEl = document.getElementById('datetime');
  const typeEl = document.getElementById('type');
  const addBtn = document.getElementById('add');
  const syncBtn = document.getElementById('sync-itinerary');
  const listEl = document.getElementById('reminders');
  const bulkActionsEl = document.getElementById('reminder-bulk-actions');
  const turnOffAllBtn = document.getElementById('turn-off-all-reminders');
  const removeAllBtn = document.getElementById('remove-all-reminders');
  const itineraryEditorEl = document.getElementById('itinerary-editor');
  const itineraryEditorTitleEl = document.getElementById('itinerary-editor-title');
  const itineraryEditorNoteEl = document.getElementById('itinerary-editor-note');
  const itineraryEditorDtEl = document.getElementById('itinerary-editor-datetime');
  const saveItineraryEditBtn = document.getElementById('save-itinerary-edit');
  const cancelItineraryEditBtn = document.getElementById('cancel-itinerary-edit');
  let editingReminder = null;

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

  function closeItineraryEditor() {
    editingReminder = null;
    if (itineraryEditorEl) itineraryEditorEl.style.display = 'none';
    if (itineraryEditorDtEl) itineraryEditorDtEl.value = '';
  }

  function openItineraryEditor(reminder) {
    editingReminder = reminder;
    if (!itineraryEditorEl || !itineraryEditorDtEl) return;
    itineraryEditorTitleEl.textContent = `Edit schedule: ${reminder.parentTitle || reminder.title || 'Itinerary activity'}`;
    itineraryEditorNoteEl.textContent = reminder.offsetLabel
      ? `Editing this ${reminder.offsetLabel} alert. The itinerary event time will adjust automatically.`
      : `Editing this itinerary schedule and refreshing synced reminder offsets.`;
    itineraryEditorDtEl.value = toDatetimeLocalValue(reminder.dueAt);
    itineraryEditorEl.style.display = 'block';
    itineraryEditorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function heading(text, count) {
    const el = document.createElement('h2');
    el.className = 'sk-reminders-heading';
    el.innerHTML = `${esc(text)} <span>${count}</span>`;
    return el;
  }

  function render() {
    // The bulk buttons sit inside the first heading; move them out before clearing.
    if (bulkActionsEl && listEl.contains(bulkActionsEl)) listEl.before(bulkActionsEl);
    listEl.innerHTML = '';
    const reminders = (window.SidekickCore.getRemindersFor(session.email) || []).slice();
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
      listEl.appendChild(heading('Upcoming', upcoming.length));
      upcoming.forEach((r) => listEl.appendChild(renderReminderRow(r, false)));
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
    if (r.type === 'Itinerary') button('Edit', () => openItineraryEditor(r));
    button(r.suppressed ? 'Turn on' : 'Turn off', () => {
      try {
        window.SidekickCore.setReminderSuppressed(session.email, r.id, !r.suppressed);
        if (!r.suppressed && window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(session.email);
      } catch (e) {}
      render();
    });
    button('Remove', () => {
      window.SidekickCore.removeReminderFor(session.email, r.id);
      render();
      ui.toast('Reminder removed');
    }, 'is-danger');
    return el;
  }

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const title = String(titleEl.value || '').trim();
    const dt = dtEl.value;
    const type = typeEl.value;
    if (!title || !dt) {
      ui.alert(!title ? 'Give your reminder a short title, like "Flight to Cebu".' : 'Choose the date and time for this reminder.', { title: 'Almost there' });
      return;
    }
    const dueAt = new Date(dt).getTime();
    if (!Number.isFinite(dueAt)) {
      ui.alert('Choose a valid date and time.', { title: 'Check the date' });
      return;
    }
    // add main reminder
    window.SidekickCore.addReminderFor(session.email, { title, type, dueAt, note: type, parentDueAt: dueAt });
    // also create pre-alert offsets (1d,10h,5h,1h)
    const offsets = [
      { label: '1 day before', ms: 24 * 60 * 60 * 1000 },
      { label: '10 hours before', ms: 10 * 60 * 60 * 1000 },
      { label: '5 hours before', ms: 5 * 60 * 60 * 1000 },
      { label: '1 hour before', ms: 1 * 60 * 60 * 1000 },
    ];
    offsets.forEach((off) => {
      const when = dueAt - off.ms;
      if (when > Date.now()) {
        window.SidekickCore.addReminderFor(session.email, { title, type, dueAt: when, note: type, parentDueAt: dueAt, offsetLabel: off.label, offsetMs: off.ms });
      }
    });
    titleEl.value = '';
    dtEl.value = '';
    render();
    ui.toast('Reminder added');
  });

  if (syncBtn) {
    syncBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.SidekickCore && window.SidekickCore.syncRemindersFromItinerary) {
          window.SidekickCore.syncRemindersFromItinerary(session.email);
          if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(session.email);
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
      const reminders = window.SidekickCore.getRemindersFor(session.email) || [];
      if (!reminders.some((reminder) => !reminder.suppressed)) return;
      window.SidekickCore.turnOffAllRemindersFor(session.email);
      render();
      ui.toast('All reminders turned off');
    });
  }

  if (removeAllBtn) {
    removeAllBtn.addEventListener('click', async () => {
      const reminders = window.SidekickCore.getRemindersFor(session.email) || [];
      if (!reminders.length) return;
      const ok = await ui.confirm(`All ${reminders.length} reminders will be removed from this phone. This cannot be undone.`, {
        title: 'Remove all reminders?', confirmText: 'Remove all', tone: 'danger',
      });
      if (!ok) return;
      window.SidekickCore.removeAllRemindersFor(session.email);
      closeItineraryEditor();
      render();
    });
  }

  if (saveItineraryEditBtn) {
    saveItineraryEditBtn.addEventListener('click', () => {
      if (!editingReminder || !itineraryEditorDtEl?.value) return;
      const newAlertDueAt = new Date(itineraryEditorDtEl.value).getTime();
      if (!Number.isFinite(newAlertDueAt)) {
        ui.alert('Choose a valid date and time.', { title: 'Check the date' });
        return;
      }

      const offsetMs = Number(editingReminder.offsetMs || 0);
      const newParentDueAt = offsetMs > 0 ? newAlertDueAt + offsetMs : newAlertDueAt;

      const updated = window.SidekickCore?.updateItineraryActivitySchedule?.(session.email, {
        activityId: editingReminder.itineraryActivityId,
        parentDueAt: editingReminder.parentDueAt,
        parentTitle: editingReminder.parentTitle || editingReminder.title,
        newDueAt: newParentDueAt,
      });

      if (!updated) {
        ui.alert('That itinerary schedule could not be updated.', { title: 'Not saved' });
        return;
      }

      try {
        if (window.SidekickCore.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(session.email);
      } catch (e) {}

      closeItineraryEditor();
      render();
      ui.toast('Schedule updated');
    });
  }

  if (cancelItineraryEditBtn) {
    cancelItineraryEditBtn.addEventListener('click', () => closeItineraryEditor());
  }

  render();

  // Refresh when reminders change elsewhere
  document.addEventListener('sidekick:reminders-updated', () => render());
});
