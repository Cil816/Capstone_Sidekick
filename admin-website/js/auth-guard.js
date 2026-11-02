// Runs in <head>, before a protected admin page is drawn. Without an admin
// sign-in in this browser tab, it hides the page and goes straight to the sign-in
// page, so the dashboard never flashes on screen. (admin.js still checks the
// session with the server; an expired sign-in is handled there.)
(function () {
  var token = null;
  var loginUrl = null;
  try {
    token = window.sessionStorage.getItem('admin.sessionToken');
    loginUrl = window.sessionStorage.getItem('admin.loginUrl');
  } catch (error) { token = null; }
  if (token) return;
  document.documentElement.style.visibility = 'hidden';
  // The sign-in page this tab used (the private link); otherwise the file next to this page.
  var target = loginUrl && loginUrl.charAt(0) === '/' && loginUrl.charAt(1) !== '/' ? loginUrl : 'admin-login.html';
  window.location.replace(target);
})();
