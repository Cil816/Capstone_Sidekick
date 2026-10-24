document.addEventListener('DOMContentLoaded', () => {
  const session = window.SidekickCore?.requireAuth?.();
  if (!session?.email) return;

  const prefEnabledEl = document.getElementById('pref-enabled');
  const prefSoundEl = document.getElementById('pref-sound');
  const prefVibrationEl = document.getElementById('pref-vibration');
  const messageEl = document.getElementById('settings-message');

  function showMessage(text) {
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.removeAttribute('hidden');
    setTimeout(() => messageEl.setAttribute('hidden', 'hidden'), 1800);
  }

  function loadPreferences() {
    const prefs = window.SidekickCore.getNotificationPreferences(session.email);
    if (prefEnabledEl) prefEnabledEl.checked = prefs.enabled !== false;
    if (prefSoundEl) prefSoundEl.checked = prefs.soundEnabled !== false;
    if (prefVibrationEl) prefVibrationEl.checked = prefs.vibrationEnabled !== false;
  }

  function savePreferences() {
    window.SidekickCore.setNotificationPreferences(session.email, {
      enabled: prefEnabledEl?.checked ?? true,
      soundEnabled: prefSoundEl?.checked ?? true,
      vibrationEnabled: prefVibrationEl?.checked ?? true,
    });
    // Re-schedule the phone's reminders so the new sound/vibration (or "off") applies now.
    try { window.SidekickCore.scheduleAllFor?.(session.email); } catch (error) {}
    showMessage('Notification settings saved.');
  }

  const testBtn = document.getElementById('test-notification-btn');
  const testStatusEl = document.getElementById('test-notification-status');
  if (testBtn) {
    const testLabel = testBtn.textContent;
    testBtn.addEventListener('click', async () => {
      if (testBtn.disabled) return;
      testBtn.disabled = true;
      let result;
      try {
        result = await window.SidekickCore.sendTestNotification(session.email);
      } catch (error) {
        result = { ok: false, message: window.SidekickCore.friendlyError(error, 'The test notification could not be sent.') };
      }
      if (result?.ok) {
        // Brief pause between tests: Android drops notifications an app posts in
        // rapid bursts, so very fast repeated taps could otherwise go missing.
        testBtn.textContent = 'Test sent';
        window.setTimeout(() => {
          testBtn.textContent = testLabel;
          testBtn.disabled = false;
        }, 2000);
      } else {
        testBtn.disabled = false;
      }
      if (testStatusEl) {
        testStatusEl.textContent = result?.message || '';
        testStatusEl.classList.toggle('is-error', !result?.ok);
        testStatusEl.hidden = !testStatusEl.textContent;
      }
    });
  }

  [prefEnabledEl, prefSoundEl, prefVibrationEl].forEach((el) => {
    if (el) el.addEventListener('change', savePreferences);
  });

  // Dark mode (js/theme-init.js applies and remembers it on every screen).
  const darkModeEl = document.getElementById('pref-dark-mode');
  if (darkModeEl && window.SidekickTheme) {
    darkModeEl.checked = window.SidekickTheme.get() === 'dark';
    darkModeEl.addEventListener('change', () => {
      window.SidekickTheme.set(darkModeEl.checked ? 'dark' : 'light');
    });
  }

  const syncBtn = document.getElementById('sync-reminders-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      window.SidekickCore.syncRemindersFromItinerary(session.email);
      window.SidekickCore.scheduleAllFor(session.email);
      showMessage('Reminders synced from itinerary.');
    });
  }

  const clearChatBtn = document.getElementById('clear-chat-btn');
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', async () => {
      const ok = await window.SidekickUI.confirm('All your chats with Sidekick on this phone will be deleted, including archived sessions. Your trips are kept.', { title: 'Clear chat history?', confirmText: 'Clear chat', tone: 'danger' });
      if (!ok) return;
      // A second, final check: this can't be undone.
      const sure = await window.SidekickUI.confirm('This can’t be undone. Your current chat and every archived session will be gone for good.', { title: 'Are you sure?', confirmText: 'Yes, delete all chats', cancelText: 'Keep my chats', tone: 'danger' });
      if (!sure) return;
      window.SidekickCore.clearChatForEmail(session.email);
      showMessage('Chat history cleared.');
    });
  }

  const clearItineraryBtn = document.getElementById('clear-itinerary-btn');
  if (clearItineraryBtn) {
    clearItineraryBtn.addEventListener('click', async () => {
      const ok = await window.SidekickUI.confirm('All your planned trips, any unsaved itinerary, and their reminders will be removed. This cannot be undone.', { title: 'Remove all trips?', confirmText: 'Remove', tone: 'danger' });
      if (!ok) return;
      clearItineraryBtn.disabled = true;
      try {
        // Each planned trip is opened, then deleted (on the server too); then the draft.
        for (const trip of window.SidekickCore.getPlannedTrips?.(session.email) || []) {
          if (window.SidekickCore.openTripForEmail?.(session.email, trip.meta?.planId)) {
            await window.SidekickCore.clearItineraryForEmail(session.email);
          }
        }
        window.SidekickCore.discardItineraryDraft?.(session.email);
        if (window.SidekickCore.getItineraryByEmail()[session.email]) await window.SidekickCore.clearItineraryForEmail(session.email);
        window.SidekickCore.clearRemindersForEmail(session.email);
        showMessage('All trips removed.');
      } catch (error) {
        showMessage(window.SidekickCore.friendlyError(error, 'The itinerary could not be removed. Please try again.'));
      } finally {
        clearItineraryBtn.disabled = false;
      }
    });
  }

  // Help: replays the app tour on Home (js/tour.js).
  const appTourBtn = document.getElementById('app-tour-btn');
  if (appTourBtn) {
    appTourBtn.addEventListener('click', () => {
      try { localStorage.setItem('sidekick.tour.pending', '1'); } catch (error) {}
      window.location.href = 'dashboard.html';
    });
  }

  const resetPrefsBtn = document.getElementById('reset-prefs-btn');
  if (resetPrefsBtn) {
    resetPrefsBtn.addEventListener('click', async () => {
      const ok = await window.SidekickUI.confirm('You will choose your travel style and interests again.', { title: 'Reset your preferences?', confirmText: 'Reset' });
      if (!ok) return;
      window.SidekickCore.resetPreferencesForEmail(session.email);
      localStorage.removeItem('userPreferences');
      try { sessionStorage.removeItem('sidekick.onboarding.v1'); } catch (error) {}
      window.location.href = 'onboarding.html';
    });
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const ok = await window.SidekickUI.confirm('You’ll need to log in again to use Sidekick. Your trips and chats stay on this phone.', { title: 'Log out?', confirmText: 'Log out', cancelText: 'Stay logged in', tone: 'danger', icon: 'logout' });
      if (!ok) return;
      try {
        if (session?.apiToken) {
          // Logging out also works offline: no waiting for the connection.
          await window.SidekickCore.apiRequest('/api/app-session/logout', { method: 'POST', waitForConnection: false });
        }
      } catch (error) {
        console.warn('Unable to revoke app session on the server:', error.message);
      } finally {
        window.SidekickCore.clearAuthSession();
        localStorage.removeItem('userName');
        localStorage.removeItem('name');
        localStorage.removeItem('userEmail');
        localStorage.removeItem('email');
        window.location.href = 'login.html';
      }
    });
  }

  // ---- Delete account (right to erasure) ----
  const deleteBtn = document.getElementById('delete-account-btn');
  const deleteDialog = document.getElementById('delete-account-dialog');
  const deleteForm = document.getElementById('delete-account-form');
  const deletePassword = document.getElementById('delete-account-password');
  const deleteError = document.getElementById('delete-account-error');
  const deleteConfirm = document.getElementById('delete-account-confirm');

  function setDeleteError(text) {
    if (!deleteError) return;
    deleteError.textContent = text || '';
    deleteError.hidden = !text;
  }

  // Removes everything Sidekick saved on this device for this account.
  function clearLocalAccountData(email) {
    const perEmailKeys = [
      'sidekick.chatByEmail.v1',
      'sidekick.chatArchiveByEmail.v1',
      'sidekick.chatCurrentSession.v1',
      'sidekick.itineraryByEmail.v1',
      'sidekick.plannedTripsByEmail.v1',
      'sidekick.itineraryDraftByEmail.v1',
      'sidekick.finishedTripsByEmail.v1',
      'sidekick.pendingItineraryByEmail.v1',
      'sidekick.preferencesByEmail.v1',
      'sidekick.remindersByEmail.v1',
      'sidekick.aiCompanionByEmail.v2',
      'sidekick.stayByEmail.v1',
    ];
    try { window.SidekickCore.removeAllRemindersFor?.(email); } catch (error) {}
    // Onboarding answers, the "already synced" marker, and the remembered account ID,
    // so registering again with this email starts onboarding fresh.
    try { window.SidekickCore.clearOnboardingStateForEmail?.(email); } catch (error) {}
    try { window.SidekickCore.forgetAccountForEmail?.(email); } catch (error) {}
    perEmailKeys.forEach((key) => {
      try {
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        if (all && typeof all === 'object' && email in all) {
          delete all[email];
          localStorage.setItem(key, JSON.stringify(all));
        }
      } catch (error) {}
    });
    [
      `sidekick.notificationPrefs.${email}`,
      'sidekick.selectedDestination.v1',
      'sidekick.aiPlaces.v1',
      'sidekick.aiRoute.v1',
      'sidekick.appReviewItineraryOpportunity.v1',
      'sidekick.appReviewLastPromptAt.v1',
      'sidekick.appReviewSnoozedUntil.v1',
      'userPreferences',
      'userName',
      'name',
      'userEmail',
      'email',
    ].forEach((key) => {
      try { localStorage.removeItem(key); } catch (error) {}
    });
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key && (key.startsWith('sidekick.chatScrollPosition') || key === 'sidekick.pendingChatMessage.v1' || key === 'sidekick.onboarding.v1')) {
          sessionStorage.removeItem(key);
        }
      }
    } catch (error) {}
  }

  if (deleteBtn && deleteDialog && deleteForm) {
    // An account made with Google has no password: it confirms by typing its email.
    const passwordless = Boolean(window.SidekickCore.getAuthSession?.()?.passwordless);
    if (passwordless && deletePassword) {
      const label = deleteForm.querySelector('label[for="delete-account-password"]');
      if (label) label.textContent = 'Type your email address to confirm';
      deletePassword.type = 'email';
      deletePassword.autocomplete = 'off';
      deletePassword.placeholder = session.email || '';
    }
    deleteBtn.addEventListener('click', () => {
      setDeleteError('');
      if (deletePassword) deletePassword.value = '';
      deleteDialog.showModal();
      deletePassword?.focus();
    });
    document.getElementById('delete-account-cancel')?.addEventListener('click', () => deleteDialog.close());
    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = String(deletePassword?.value || '');
      if (!password) {
        setDeleteError(passwordless ? 'Type your email address to confirm.' : 'Enter your password to confirm.');
        deletePassword?.focus();
        return;
      }
      setDeleteError('');
      deleteConfirm.disabled = true;
      window.SidekickUI?.loading.show('Deleting your account…');
      try {
        await window.SidekickCore.apiRequest('/api/account/delete', {
          method: 'POST',
          body: JSON.stringify({ password }),
        });
        clearLocalAccountData(session.email);
        window.SidekickCore.clearAuthSession();
        window.location.href = 'login.html?account=deleted';
      } catch (error) {
        window.SidekickUI?.loading.hide(true);
        setDeleteError(window.SidekickCore.friendlyError(error, 'Your account could not be deleted. Please try again.'));
        deleteConfirm.disabled = false;
      }
    });
  }

  loadPreferences();
});
