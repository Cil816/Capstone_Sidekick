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
    clearItineraryBtn.addEventListener('click', () => {
      if (!confirm('Remove your itinerary and itinerary reminders?')) return;
      window.SidekickCore.clearItineraryForEmail(session.email);
      window.SidekickCore.clearRemindersForEmail(session.email);
      showMessage('Itinerary removed.');
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
    logoutBtn.addEventListener('click', () => {
      window.SidekickCore.clearAuthSession();
      localStorage.removeItem('userName');
      localStorage.removeItem('name');
      localStorage.removeItem('userEmail');
      localStorage.removeItem('email');
      window.location.href = 'login.html';
    });
  }

  loadPreferences();
});
