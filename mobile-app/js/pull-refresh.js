// Pull to refresh: on the main tabs, pulling the screen down from the very top shows the
// Sidekick logo; pulling far enough and letting go reloads the screen.
// Ignored while typing, while a pop-up or dialog is open, and on maps.
(function () {
  var PULL_TO_RELOAD = 70; // indicator distance (px) needed to reload
  var MAX_PULL = 110;
  var START_SLOP = 10;     // finger movement before deciding pull vs. sideways swipe

  var start = null;
  var pulling = false;
  var distance = 0;
  var reloading = false;
  var indicator = null;

  function getIndicator() {
    if (indicator && indicator.isConnected) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'sk-ptr';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = '<span class="sk-ptr-ring"></span><img src="assets/sidekick-logo-192.png" alt="" width="30" height="30">';
    document.body.appendChild(indicator);
    return indicator;
  }

  // True when the page and every scrollable box under the finger are scrolled to the top.
  function atTop(target) {
    for (var el = target; el; el = el.parentElement) {
      if (el.scrollTop > 0) return false;
    }
    var page = document.scrollingElement || document.documentElement;
    return !page || page.scrollTop <= 0;
  }

  function blocked(target) {
    if (!target || !target.closest) return true;
    if (document.querySelector('dialog[open], .sk-dialog')) return true; // a pop-up is open
    if (target.closest('input, textarea, select, [contenteditable="true"], .gm-style, [data-no-pull-refresh]')) return true;
    var active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true; // typing
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      var style = window.getComputedStyle(el);
      // Sheets and full-screen pop-ups (e.g. destination details, "See all") scroll on their own.
      if (style.position === 'fixed' && !el.classList.contains('bottom-nav')) return true;
    }
    return false;
  }

  function show(dist, dragging) {
    var el = getIndicator();
    el.classList.toggle('is-dragging', Boolean(dragging));
    el.classList.toggle('is-ready', dist >= PULL_TO_RELOAD);
    el.style.opacity = dist > 4 ? String(Math.min(1, dist / 40)) : '0';
    el.style.transform = 'translateY(' + (dist - 56) + 'px) rotate(' + Math.round(dist * 3) + 'deg)';
  }

  function reset() {
    start = null;
    pulling = false;
    distance = 0;
    if (indicator && !reloading) show(0, false);
  }

  document.addEventListener('touchstart', function (event) {
    if (reloading || event.touches.length !== 1) { start = null; return; }
    var target = event.target;
    if (blocked(target) || !atTop(target)) { start = null; return; }
    var touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
    pulling = false;
    distance = 0;
  }, { passive: true });

  document.addEventListener('touchmove', function (event) {
    if (!start || event.touches.length !== 1) return;
    var touch = event.touches[0];
    var dx = touch.clientX - start.x;
    var dy = touch.clientY - start.y;
    if (!pulling) {
      if (dy > START_SLOP && dy > Math.abs(dx) * 1.5) pulling = true;
      else if (dy < -START_SLOP || Math.abs(dx) > START_SLOP) { start = null; return; } // scroll up or swipe
      else return;
    }
    // Resistance: the indicator moves about half as far as the finger.
    distance = Math.max(0, Math.min(MAX_PULL, dy * 0.5));
    if (event.cancelable) event.preventDefault(); // no page bounce while pulling
    show(distance, true);
  }, { passive: false });

  function finish() {
    if (!start) return;
    var ready = pulling && distance >= PULL_TO_RELOAD;
    start = null;
    pulling = false;
    if (!ready) { reset(); return; }
    reloading = true;
    var el = getIndicator();
    el.classList.remove('is-dragging');
    el.classList.add('is-ready', 'is-refreshing');
    el.style.opacity = '1';
    el.style.transform = 'translateY(' + (PULL_TO_RELOAD - 56) + 'px)';
    // Home keeps its place lists for the session; refreshing Home loads them fresh.
    if (document.body && document.body.getAttribute('data-tab') === 'dashboard') {
      try { sessionStorage.setItem('sidekick.refreshRequested', '1'); } catch (e) { /* storage unavailable */ }
    }
    window.setTimeout(function () { window.location.reload(); }, 250);
  }

  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', reset, { passive: true });

  // Coming back to a page restored by the Back button: hide the indicator again.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) { reloading = false; reset(); }
  });
})();
