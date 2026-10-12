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
    showMessage('Notification settings saved.');
  }

  [prefEnabledEl, prefSoundEl, prefVibrationEl].forEach((el) => {
    if (el) el.addEventListener('change', savePreferences);
  });

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
    clearChatBtn.addEventListener('click', () => {
      if (!confirm('Clear all chat history?')) return;
      window.SidekickCore.clearChatForEmail(session.email);
      showMessage('Chat history cleared.');
    });
  }

  const clearItineraryBtn = document.getElementById('clear-itinerary-btn');
  if (clearItineraryBtn) {
    clearItineraryBtn.addEventListener('click', async () => {
      if (!confirm('Remove your itinerary and itinerary reminders?')) return;
      clearItineraryBtn.disabled = true;
      try {
        await window.SidekickCore.clearItineraryForEmail(session.email);
        window.SidekickCore.clearRemindersForEmail(session.email);
        showMessage('Itinerary removed.');
      } catch (error) {
        showMessage(error.message || 'The itinerary could not be removed. Please try again.');
      } finally {
        clearItineraryBtn.disabled = false;
      }
    });
  }

  const resetPrefsBtn = document.getElementById('reset-prefs-btn');
  if (resetPrefsBtn) {
    resetPrefsBtn.addEventListener('click', () => {
      if (!confirm('Reset your onboarding preferences and go to onboarding now?')) return;
      window.SidekickCore.resetPreferencesForEmail(session.email);
      localStorage.removeItem('userPreferences');
      try { sessionStorage.removeItem('sidekick.onboarding.v1'); } catch (error) {}
      window.location.href = 'onboarding.html';
    });
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        if (session?.apiToken) {
          await window.SidekickCore.apiRequest('/api/app-session/logout', { method: 'POST' });
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
      'sidekick.itineraryByEmail.v1',
      'sidekick.pendingItineraryByEmail.v1',
      'sidekick.preferencesByEmail.v1',
      'sidekick.remindersByEmail.v1',
      'sidekick.aiCompanionByEmail.v2',
      'sidekick.stayByEmail.v1',
    ];
    try { window.SidekickCore.removeAllRemindersFor?.(email); } catch (error) {}
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
        setDeleteError('Enter your password to confirm.');
        deletePassword?.focus();
        return;
      }
      setDeleteError('');
      deleteConfirm.disabled = true;
      deleteConfirm.textContent = 'Deleting…';
      try {
        await window.SidekickCore.apiRequest('/api/account/delete', {
          method: 'POST',
          body: JSON.stringify({ password }),
        });
        clearLocalAccountData(session.email);
        window.SidekickCore.clearAuthSession();
        window.location.href = 'login.html?account=deleted';
      } catch (error) {
        setDeleteError(error.message || 'Your account could not be deleted. Please try again.');
        deleteConfirm.disabled = false;
        deleteConfirm.textContent = 'Delete permanently';
      }
    });
  }

  loadPreferences();
});
