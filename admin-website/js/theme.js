// Light/dark theme for the admin website. Loaded in <head> so the saved theme is
// applied before the page draws (no white flash). With no saved choice it follows
// the computer's own light/dark setting.
(function () {
  var KEY = 'sidekick.admin.theme';
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (error) { return null; }
  }

  function current() {
    var choice = saved();
    if (choice === 'dark' || choice === 'light') return choice;
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (error) { return 'light'; }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', String(theme === 'dark'));
      var label = buttons[i].querySelector('span');
      if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    }
  }

  apply(current());

  document.addEventListener('DOMContentLoaded', function () {
    apply(current());
    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-theme-toggle]');
      if (!button) return;
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (error) { /* still switches for this page */ }
      apply(next);
    });
  });
})();
