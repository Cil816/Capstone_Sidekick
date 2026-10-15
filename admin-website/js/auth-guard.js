// Runs in <head>, before a protected admin page is drawn. Without an admin
// sign-in in this browser tab, it hides the page and goes straight to the sign-in
// page, so the dashboard never flashes on screen. (admin.js still checks the
// session with the server; an expired sign-in is handled there.)
(function () {
  var token = null;
  try { token = window.sessionStorage.getItem('admin.sessionToken'); } catch (error) { token = null; }
  if (token) return;
  document.documentElement.style.visibility = 'hidden';
  window.location.replace('admin-login.html');
})();
