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
    // In the phone app the screen reaches behind the status bar, so its clock and
    // battery icons switch to light (dark theme) or dark (light theme) to stay readable.
    try {
      var bars = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemBars;
      if (bars && bars.setStyle) {
        var result = bars.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' });
        if (result && result.catch) result.catch(function () {});
      }
    } catch (error) { /* not in the phone app */ }
  }
  apply(current());
  // Page name (dashboard, profile, ...) so css/dark.css can match each page's own styles.
  if (!root.getAttribute('data-page')) {
    var file = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');
    root.setAttribute('data-page', file || 'index');
  }
  // Smooth tab changes (styles in css/tab-motion.css, behaviour in js/tab-motion.js).
  // Where the WebView supports page-to-page view transitions, the old and new screens
  // are swapped by the browser itself as two pictures sliding on the graphics chip, so
  // a screen that is still loading cannot make the slide stutter. The slide direction
  // follows the tabs' order in the bottom bar. This runs in <head> because the
  // 'pagereveal' event fires before the new screen is first drawn.
  try {
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion && 'CSSViewTransitionRule' in window) {
      root.classList.add('sk-vt');
      var TAB_ORDER = { dashboard: 0, itinerary: 1, chat: 2, alerts: 3, profile: 4, settings: 4.5, 'past-trips': 4.5 };
      window.addEventListener('pagereveal', function (event) {
        if (!event.viewTransition) return;
        var here = TAB_ORDER[root.getAttribute('data-page')];
        var last = null;
        try {
          last = JSON.parse(sessionStorage.getItem('sidekick.tab.last') || 'null');
          sessionStorage.removeItem('sidekick.tab.last');
        } catch (error) { /* no direction: plain cross-fade */ }
        if (here === undefined || !last || typeof last.index !== 'number' || last.index === here) return;
        if (Date.now() - Number(last.time || 0) > 4000) return;
        if (event.viewTransition.types) event.viewTransition.types.add(here > last.index ? 'sk-next' : 'sk-prev');
      });
    }
  } catch (error) { /* older WebView: js/tab-motion.js slides the screen instead */ }

  window.SidekickTheme = {
    get: current,
    set: function (theme) {
      try { localStorage.setItem(KEY, theme); } catch (error) { /* still applies to this page */ }
      apply(theme);
    },
  };
})();
