/* App tour on the Home screen (styles in css/tour.css).
   - Runs once for a new user right after onboarding, and again from Settings
     ("Show app tour"); both set PENDING_KEY and open dashboard.html.
   - Each step highlights one part of the screen; the rest is dimmed and blurred.
   - Skip, Back and Next; Escape also skips. Taps outside the card do nothing. */
(function () {
  'use strict';

  var PENDING_KEY = 'sidekick.tour.pending';

  var STEPS = [
    { target: '.search-section .search-bar', title: 'Search places', text: 'Find beaches, food and stays anywhere in Batangas.' },
    { target: '#recommended-row', section: true, title: 'Picked for you', text: 'Places that match your travel style. Tap one to see its route and details.' },
    { target: '#destinations-grid', section: true, title: 'Popular destinations', text: 'Where other travelers are going.' },
    { target: '.bottom-nav .nav-item[href="itinerary.html"]', nav: true, title: 'Plan a trip', text: 'Build a day-by-day itinerary from your dates, budget and group size.' },
    { target: '.bottom-nav .nav-item[href="chat.html"]', nav: true, title: 'Ask Sidekick', text: 'Ask the AI about places and food, or have it plan a trip for you.' },
    { target: '.bottom-nav .nav-item[href="alerts.html"]', nav: true, title: 'Reminders', text: 'Get a reminder before each activity of your saved trips.' },
    { target: '.bottom-nav .nav-item[href="profile.html"]', nav: true, title: 'Profile and settings', text: 'Past trips, dark mode, and this tour again in Settings.' },
  ];

  // A section step highlights the whole section (its heading and its list).
  function targetOf(step) {
    var el = document.querySelector(step.target);
    return el && step.section ? (el.closest('.section') || el) : el;
  }

  function isPending() {
    try { return localStorage.getItem(PENDING_KEY) === '1'; } catch (error) { return false; }
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (error) { /* nothing saved */ }
  }

  // A rounded hole in the dim layer leaves the highlighted part sharp and bright.
  var canCutHole = !!(window.CSS && CSS.supports && CSS.supports('clip-path', 'path(evenodd, "M0 0H1V1H0Z")'));
  function holePath(w, h, r) {
    var x = r.left, y = r.top, rw = r.width, rh = r.height, c = Math.min(16, rw / 2, rh / 2);
    return 'path(evenodd, "M0 0H' + w + 'V' + h + 'H0Z'
      + 'M' + (x + c) + ' ' + y + 'H' + (x + rw - c) + 'A' + c + ' ' + c + ' 0 0 1 ' + (x + rw) + ' ' + (y + c)
      + 'V' + (y + rh - c) + 'A' + c + ' ' + c + ' 0 0 1 ' + (x + rw - c) + ' ' + (y + rh)
      + 'H' + (x + c) + 'A' + c + ' ' + c + ' 0 0 1 ' + x + ' ' + (y + rh - c)
      + 'V' + (y + c) + 'A' + c + ' ' + c + ' 0 0 1 ' + (x + c) + ' ' + y + 'Z")';
  }

  function start() {
    clearPending();
    var steps = STEPS.filter(function (step) { return document.querySelector(step.target); });
    if (!steps.length) return;

    var blocker = document.createElement('div');
    blocker.className = 'sk-tour-blocker';
    var shade = document.createElement('div');
    shade.className = 'sk-tour-shade' + (canCutHole ? '' : ' sk-tour-shade-plain');
    var ring = document.createElement('div');
    ring.className = 'sk-tour-ring' + (canCutHole ? '' : ' sk-tour-ring-dim');
    var card = document.createElement('div');
    card.className = 'sk-tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'sk-tour-title');
    card.tabIndex = -1;
    card.innerHTML = '<p class="sk-tour-count" id="sk-tour-count"></p>'
      + '<h2 class="sk-tour-title" id="sk-tour-title"></h2>'
      + '<p class="sk-tour-text" id="sk-tour-text"></p>'
      + '<div class="sk-tour-actions">'
      + '<button type="button" class="sk-tour-skip">Skip</button>'
      + '<span class="sk-tour-spacer"></span>'
      + '<button type="button" class="sk-tour-back">Back</button>'
      + '<button type="button" class="sk-tour-next">Next</button>'
      + '</div>';
    [blocker, shade, ring, card].forEach(function (el) { document.body.appendChild(el); });
    document.body.classList.add('sk-tour-active');

    var index = 0;
    var current = null;
    var backBtn = card.querySelector('.sk-tour-back');
    var nextBtn = card.querySelector('.sk-tour-next');

    function place() {
      if (!current) return;
      var pad = current.nav ? 4 : 8;
      var box = targetOf(current).getBoundingClientRect();
      var w = window.innerWidth, h = window.innerHeight;
      // A part taller than about half the screen is shown from its top (heading and
      // first items), so the card still fits beside it.
      var r = {
        left: Math.max(4, box.left - pad), top: Math.max(4, box.top - pad),
        width: Math.min(w - 8, box.width + pad * 2), height: Math.min(Math.round(h * 0.45), box.height + pad * 2),
      };
      ring.style.left = r.left + 'px';
      ring.style.top = r.top + 'px';
      ring.style.width = r.width + 'px';
      ring.style.height = r.height + 'px';
      if (canCutHole) shade.style.clipPath = holePath(w, h, r);
      ring.classList.remove('sk-tour-moving');
      card.classList.remove('sk-tour-moving');

      // The card sits below the highlight when there is room, otherwise above it.
      var cardH = card.offsetHeight, gap = 14;
      var below = r.top + r.height + gap;
      var top = below + cardH <= h - 12 ? below : Math.max(12, r.top - gap - cardH);
      card.style.top = top + 'px';
    }

    function show(i) {
      index = i;
      current = steps[i];
      ring.classList.add('sk-tour-moving');
      card.classList.add('sk-tour-moving');
      var el = targetOf(current);
      card.querySelector('#sk-tour-count').textContent = (i + 1) + ' of ' + steps.length;
      card.querySelector('#sk-tour-title').textContent = current.title;
      card.querySelector('#sk-tour-text').textContent = current.text;
      backBtn.hidden = i === 0;
      nextBtn.textContent = i === steps.length - 1 ? 'Done' : 'Next';
      // Keep the bottom bar showing (it hides while scrolling).
      var nav = document.querySelector('.bottom-nav.overlay');
      if (nav) nav.classList.remove('navbar-hidden');
      if (!current.nav) {
        // Short parts are centred; tall ones start just below the top of the screen.
        var tall = el.getBoundingClientRect().height > window.innerHeight * 0.45;
        el.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'auto' });
        if (tall) window.scrollBy(0, -24);
      }
      // Let the scroll settle before measuring.
      requestAnimationFrame(function () { requestAnimationFrame(place); });
      nextBtn.focus({ preventScroll: true });
    }

    // Scrolling or turning the phone re-places the highlight once per frame at most.
    var frame = 0;
    function placeSoon() {
      if (!frame) frame = requestAnimationFrame(function () { frame = 0; place(); });
    }

    function end() {
      window.removeEventListener('resize', placeSoon);
      window.removeEventListener('scroll', placeSoon, true);
      document.removeEventListener('keydown', onKey);
      [blocker, shade, ring, card].forEach(function (el) { el.remove(); });
      document.body.classList.remove('sk-tour-active');
      current = null;
    }

    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); end(); }
    }

    card.querySelector('.sk-tour-skip').addEventListener('click', end);
    backBtn.addEventListener('click', function () { if (index > 0) show(index - 1); });
    nextBtn.addEventListener('click', function () {
      if (index < steps.length - 1) show(index + 1); else end();
    });
    window.addEventListener('resize', placeSoon);
    window.addEventListener('scroll', placeSoon, true);
    document.addEventListener('keydown', onKey);
    show(0);
  }

  function startWhenReady() {
    if (!isPending()) return;
    // Give Home a moment to draw its sections first.
    setTimeout(start, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWhenReady);
  else startWhenReady();

  window.SidekickTour = { start: start, PENDING_KEY: PENDING_KEY };
})();
