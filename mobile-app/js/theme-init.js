// Light/dark theme for the Sidekick app. Loaded in <head> on every page so the saved
// theme applies before the page draws (no white flash). With no saved choice the
// app follows the phone's own light/dark setting. Settings has the switch.
(function () {
  var KEY = 'sidekick.theme';
  var root = document.documentElement;
  function saved() {
    try { return localStorage.getItem(KEY); } catch (error) { return null; }
  }
  function systemDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (error) { return false; }
  }
  function current() {
    var choice = saved();
    return choice === 'dark' || choice === 'light' ? choice : (systemDark() ? 'dark' : 'light');
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  }
  apply(current());
  // Page name (dashboard, profile, ...) so css/dark.css can match each page's own styles.
  if (!root.getAttribute('data-page')) {
    var file = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');
    root.setAttribute('data-page', file || 'index');
  }
  window.SidekickTheme = {
    get: current,
    set: function (theme) {
      try { localStorage.setItem(KEY, theme); } catch (error) { /* still applies to this page */ }
      apply(theme);
    },
  };
})();
