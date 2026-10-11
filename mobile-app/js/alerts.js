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
      }
    }).catch(() => {});
  }

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
  }

  function render() {
    listEl.innerHTML = '';
    const reminders = (window.SidekickCore.getRemindersFor(session.email) || []).slice();
    reminders.sort((a,b) => (Number(a.dueAt||0) - Number(b.dueAt||0)));
    if (bulkActionsEl) bulkActionsEl.hidden = reminders.length === 0;
    if (turnOffAllBtn) turnOffAllBtn.disabled = reminders.length === 0 || reminders.every((reminder) => reminder.suppressed);

    const now = Date.now();
    const upcoming = reminders.filter(r => !r.firedAt && Number(r.dueAt||0) >= now);
    const past = reminders.filter(r => r.firedAt || Number(r.dueAt||0) < now);

    if (upcoming.length === 0 && past.length === 0) {
      listEl.innerHTML = `<div style="color:#6b7280;padding:16px">No reminders yet. Create one above or sync your itinerary.</div>`;
      return;
    }

    if (upcoming.length) {
      const upHeader = document.createElement('div'); upHeader.style.marginTop = '6px'; upHeader.innerHTML = '<strong>Upcoming</strong>';
      listEl.appendChild(upHeader);
      upcoming.forEach(r => listEl.appendChild(renderReminderRow(r)));
    }

    if (past.length) {
      const pastHeader = document.createElement('div'); pastHeader.style.marginTop = '10px'; pastHeader.innerHTML = '<strong>Past / Fired</strong>';
      listEl.appendChild(pastHeader);
      past.forEach(r => listEl.appendChild(renderReminderRow(r)));
    }
  }

  function renderReminderRow(r) {
    const el = document.createElement('div'); el.className = 'reminder';
    el.style.display = 'flex'; el.style.justifyContent = 'space-between'; el.style.alignItems = 'center'; el.style.padding = '10px'; el.style.borderRadius='10px'; el.style.border='1px solid #eee'; el.style.background='#fff'; el.style.marginTop='6px';
    const left = document.createElement('div');
    const whenText = new Date(Number(r.dueAt)).toLocaleString();
    const eventText = r.parentDueAt ? new Date(Number(r.parentDueAt)).toLocaleString() : '';
    const offsetText = r.offsetLabel ? ` <small style="color:#6b7280;margin-left:6px">(${window.SidekickCore.escapeHtml(r.offsetLabel)})</small>` : '';
    const suppressedBadge = r.suppressed ? ` <span style="color:#b91c1c;margin-left:8px;font-size:12px">(disabled)</span>` : '';
    const eventMeta = r.type === 'Itinerary' && eventText
      ? `<div class='meta' style='color:#6b7280;font-size:13px'>Event: ${window.SidekickCore.escapeHtml(eventText)}</div>`
      : '';
    left.innerHTML = `<div style="font-weight:600">${window.SidekickCore.escapeHtml(r.title || r.type)} ${r.type==='Itinerary'?'<small style="color:#6b7280;margin-left:6px">(From itinerary)</small>':''}${suppressedBadge}</div><div class='meta' style='color:#6b7280;font-size:13px'>Alert: ${window.SidekickCore.escapeHtml(whenText)}${offsetText}</div>${eventMeta}`;
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.style.flexWrap = 'wrap';
    if (r.type === 'Itinerary') {
      const editBtn = document.createElement('button'); editBtn.className='btn'; editBtn.style.padding='6px 8px'; editBtn.textContent = 'Edit';
      editBtn.onclick = () => openItineraryEditor(r);
      right.appendChild(editBtn);
    }
    const toggleBtn = document.createElement('button'); toggleBtn.className='btn'; toggleBtn.style.padding='6px 8px'; toggleBtn.textContent = r.suppressed ? 'Enable' : 'Turn off';
    toggleBtn.onclick = () => { try { window.SidekickCore.setReminderSuppressed(session.email, r.id, !r.suppressed); if (!r.suppressed && window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(session.email); } catch(e){}; render(); };
    const del = document.createElement('button'); del.className='btn'; del.style.padding='6px 8px'; del.textContent = 'Remove';
    del.onclick = () => { window.SidekickCore.removeReminderFor(session.email, r.id); render(); };
    right.appendChild(toggleBtn);
    right.appendChild(del);
    el.appendChild(left); el.appendChild(right);
    return el;
  }

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const title = String(titleEl.value || '').trim();
    const dt = dtEl.value;
    const type = typeEl.value;
    if (!title || !dt) return alert('Provide title and datetime');
    const dueAt = new Date(dt).getTime();
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
  });

  if (syncBtn) {
    syncBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.SidekickCore && window.SidekickCore.syncRemindersFromItinerary) {
          window.SidekickCore.syncRemindersFromItinerary(session.email);
          if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(session.email);
          render();
        } else {
          alert('Itinerary sync not available.');
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
    });
  }

  if (removeAllBtn) {
    removeAllBtn.addEventListener('click', () => {
      const reminders = window.SidekickCore.getRemindersFor(session.email) || [];
      if (!reminders.length) return;
      if (!confirm(`Remove all ${reminders.length} reminders? This cannot be undone.`)) return;
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
        alert('Provide a valid date and time.');
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
        alert('Unable to update that itinerary schedule.');
        return;
      }

      try {
        if (window.SidekickCore.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(session.email);
      } catch (e) {}

      closeItineraryEditor();
      render();
    });
  }

  if (cancelItineraryEditBtn) {
    cancelItineraryEditBtn.addEventListener('click', () => closeItineraryEditor());
  }

  render();

  // Refresh when reminders change elsewhere
  document.addEventListener('sidekick:reminders-updated', () => render());
});
