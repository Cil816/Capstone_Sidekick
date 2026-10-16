/* ==========================================================================
   Tab navigation motion for the main screens (styles in css/tab-motion.css).

   - Swiping left goes to the next tab in the bottom bar; swiping right goes
     to the previous one. This does exactly what tapping that tab icon does.
   - Tapping a tab icon and swiping both play the same slide: moving to a tab
     further right slides the page left, moving back slides it right.
   - Swipes are ignored where a sideways gesture already means something:
     carousels and other sideways-scrolling areas, maps, text fields, pop-ups,
     and the screen edges (used by Android's own back gesture).

   Each page opts in with <body data-tab="dashboard"> (settings uses "profile",
   since it opens from the Profile tab).
   ========================================================================== */
(function () {
  'use strict';

  var TABS = ['dashboard', 'itinerary', 'chat', 'alerts', 'profile'];
  // The tab the user just left and when, so the next tab page can slide in from
  // the correct side however it was opened: swipe, tab icon, a link, or the
  // phone's Back gesture (which walks through visit order, not bar order).
  var LAST_KEY = 'sidekick.tab.last';
  var ARRIVAL_WINDOW = 4000; // ms; older records are from an earlier visit
  var MIN_DISTANCE = 70;   // px the finger must travel sideways
  var MAX_TIME = 800;      // ms; slower drags are treated as scrolling or reading
  var EDGE = 28;           // px from each screen edge left to the system Back gesture

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var body = document.body;
  var tab = body && body.getAttribute('data-tab');
  var index = TABS.indexOf(tab);
  if (index < 0) return;

  var navigating = false;

  function screenEl() {
    return document.querySelector('.screen');
  }

  function clearMotion(el) {
    if (el) el.classList.remove('sk-tab-in-next', 'sk-tab-in-prev', 'sk-tab-out-next', 'sk-tab-out-prev');
  }

  // Leave the page with a short slide, then open the target tab.
  function go(targetIndex) {
    if (navigating || targetIndex < 0 || targetIndex >= TABS.length || targetIndex === index) return;
    navigating = true;
    var dir = targetIndex > index ? 'next' : 'prev';
    var href = TABS[targetIndex] + '.html';
    var el = screenEl();
    if (reduceMotion || !el) { window.location.href = href; return; }
    clearMotion(el);
    void el.offsetWidth;
    el.classList.add('sk-tab-out-' + dir);
    window.setTimeout(function () { window.location.href = href; }, 160);
  }

  // ---- Background ---------------------------------------------------------
  var bg = document.createElement('div');
  bg.className = 'sk-tab-bg';
  bg.setAttribute('aria-hidden', 'true');
  bg.innerHTML = '<span></span><span></span><span></span><span></span>';
  body.insertBefore(bg, body.firstChild);

  // ---- Entering slide -----------------------------------------------------
  // The direction comes from where the two tabs sit in the bottom bar: a tab
  // to the right always arrives from the right, a tab to the left from the left.
  function arrivalDirection() {
    var last = null;
    try { last = JSON.parse(sessionStorage.getItem(LAST_KEY) || 'null'); } catch (e) {}
    if (!last || typeof last.index !== 'number' || Date.now() - Number(last.time || 0) > ARRIVAL_WINDOW) return null;
    if (last.index === index) return null;
    return index > last.index ? 'next' : 'prev';
  }

  function playArrival() {
    var el = screenEl();
    var dir = arrivalDirection();
    try { sessionStorage.removeItem(LAST_KEY); } catch (e) {}
    clearMotion(el);
    if (!el || reduceMotion || !dir) return;
    void el.offsetWidth;
    el.classList.add('sk-tab-in-' + dir);
    // Remove the class once the slide is over (the timer covers a cancelled or
    // missed animationend event).
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      el.classList.remove('sk-tab-in-next', 'sk-tab-in-prev');
    };
    el.addEventListener('animationend', function (event) { if (event.target === el) finish(); });
    el.addEventListener('animationcancel', function (event) { if (event.target === el) finish(); });
    window.setTimeout(finish, 700);
  }

  playArrival();

  // Record this tab whenever the page is left, by any route.
  window.addEventListener('pagehide', function () {
    try { sessionStorage.setItem(LAST_KEY, JSON.stringify({ index: index, time: Date.now() })); } catch (e) {}
  });

  // Back/Forward can restore this page from memory exactly as it was left
  // (mid slide-out); reset it and slide in from the correct side.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      navigating = false;
      playArrival();
    }
  });

  // ---- Tab icons ----------------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('.bottom-nav .nav-item'), function (link) {
    var target = TABS.indexOf(String(link.getAttribute('href') || '').replace(/\.html.*$/, ''));
    if (target < 0) return;
    link.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (target === index) return; // same tab: let it behave as before
      event.preventDefault();
      go(target);
    });
  });

  // ---- Swipes -------------------------------------------------------------
  // True if the touch began somewhere a sideways swipe already has a meaning.
  function blocked(target) {
    if (document.documentElement.style.overflow === 'hidden' || body.style.overflow === 'hidden') return true; // a pop-up is open
    if (document.querySelector('dialog[open]')) return true;
    for (var el = target; el && el !== body && el.nodeType === 1; el = el.parentElement) {
      if (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, canvas, video, .gm-style, [data-no-swipe]')) return true;
      var style = window.getComputedStyle(el);
      if (style.position === 'fixed' && !el.classList.contains('bottom-nav')) return true; // sheets and pop-ups
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2) return true;
    }
    return false;
  }

  var start = null;

  document.addEventListener('touchstart', function (event) {
    start = null;
    if (navigating || event.touches.length !== 1) return;
    var t = event.touches[0];
    var width = window.innerWidth || document.documentElement.clientWidth;
    if (t.clientX < EDGE || t.clientX > width - EDGE) return;
    if (blocked(event.target)) return;
    start = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });

  document.addEventListener('touchmove', function (event) {
    if (!start || event.touches.length !== 1) return;
    var t = event.touches[0];
    // A clearly vertical movement is a scroll: stop tracking this touch.
    if (Math.abs(t.clientY - start.y) > 40 && Math.abs(t.clientY - start.y) > Math.abs(t.clientX - start.x)) start = null;
  }, { passive: true });

  document.addEventListener('touchend', function (event) {
    if (!start) return;
    var t = event.changedTouches[0];
    var dx = t.clientX - start.x;
    var dy = t.clientY - start.y;
    var elapsed = Date.now() - start.time;
    start = null;
    if (elapsed > MAX_TIME || Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    var selection = window.getSelection && String(window.getSelection());
    if (selection) return; // the user was selecting text
    go(dx < 0 ? index + 1 : index - 1);
  }, { passive: true });

  document.addEventListener('touchcancel', function () { start = null; }, { passive: true });

  window.SidekickTabs = { go: function (name) { go(TABS.indexOf(name)); } };
})();
