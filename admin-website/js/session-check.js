// Runs on the "Page not found" page the server shows for an admin page link whose
// session key no longer works (signed out, expired, or the server restarted). In the
// admin's own browser tab it reopens the same page with a fresh key, or goes back to
// the sign-in page the admin used. Anyone else just sees "Page not found".
(function () {
  var PAGES = ['dashboard', 'users', 'travel-plans', 'reports', 'reviews', 'popular-places', 'activity', 'system', 'api-usage', 'settings'];
  var token = null;
  var loginUrl = null;
  var lastTry = 0;
  try {
    token = window.sessionStorage.getItem('admin.sessionToken');
    loginUrl = window.sessionStorage.getItem('admin.loginUrl');
    lastTry = Number(window.sessionStorage.getItem('admin.pageKeyRetry')) || 0;
  } catch (error) { return; }
  // Never bounce between pages: one try every few seconds at most.
  if (Date.now() - lastTry < 5000) return;
  try { window.sessionStorage.setItem('admin.pageKeyRetry', String(Date.now())); } catch (error) { return; }

  function toSignIn() {
    if (loginUrl && loginUrl.charAt(0) === '/' && loginUrl.charAt(1) !== '/') window.location.replace(loginUrl);
  }
  if (!token) { toSignIn(); return; }

  var page = window.location.pathname.replace(/\/+$/, '').split('/').pop();
  if (PAGES.indexOf(page) === -1) page = 'dashboard';
  window.fetch('/api/admin/session', { headers: { 'X-Admin-Token': token }, cache: 'no-store' })
    .then(function (response) {
      if (response.status === 401) {
        try { window.sessionStorage.removeItem('admin.sessionToken'); } catch (error) { /* ignore */ }
        toSignIn();
        return null;
      }
      return response.ok ? response.json() : null;
    })
    .then(function (data) {
      var base = data && data.pagesBase;
      if (typeof base === 'string' && /^\/s\/[A-Za-z0-9_-]{91}\/$/.test(base)) {
        window.location.replace(base + page + window.location.search + window.location.hash);
      }
    })
    .catch(function () { /* offline or server down: stay on this page */ });
})();
