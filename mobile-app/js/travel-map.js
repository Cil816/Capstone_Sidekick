/* ==========================================================================
   Travel map behaviour for the welcome, login, register and onboarding
   screens (styles in css/travel-map.css).

   - Each screen and step is a "stop" on one shared map. The map pans to the
     current stop, starting from the stop of the previous screen, so moving
     between screens feels like travelling along the same route.
   - Content slides in from the right when moving forward and from the left
     when going back.
   - On the welcome screen, a pin drops before Login or Register opens.

   Pages opt in with attributes only, so no page logic changes:
     <body data-map-stop="login">      the screen's main stop
     [data-map-slide]                  content that slides in on page load
     [data-map-step="reset-email"]     a step that becomes active when shown
     [data-map-counter="onb-"]         "Step N of M" text -> stop onb-N
     [data-map-pin]                    link that drops a pin before opening
   ========================================================================== */
(function () {
  'use strict';

  var STOPS = {"index":[600,330],"login":[330,560],"reset-email":[250,790],"reset-code":[330,960],"reset-password":[470,1080],"register-email":[880,560],"register-code":[960,760],"register-details":[870,930],"onb-1":[720,1100],"onb-2":[610,1210],"onb-3":[500,1320]};
  var MAP_W = 1200, MAP_H = 1600;
  var ORDER = ['index', 'login', 'reset-email', 'reset-code', 'reset-password',
    'register-email', 'register-code', 'register-details', 'onb-1', 'onb-2', 'onb-3'];
  var STORE_KEY = 'sidekick.map.stop';
  var VIEW_Y = 0.55; // where the current stop sits, as a fraction of screen height
  // The welcome screen keeps its start pin in the open space above the logo.
  var VIEW_Y_BY_STOP = { 'index': 0.17 };

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var canvas = null;
  var current = null;

  function readStop() {
    try { return sessionStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  function saveStop(stop) {
    try { sessionStorage.setItem(STORE_KEY, stop); } catch (e) {}
  }

  function rank(stop) {
    var i = ORDER.indexOf(stop);
    return i < 0 ? 0 : i;
  }

  function direction(from, to) {
    return rank(to) < rank(from) ? 'prev' : 'next';
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // Size the map relative to the screen and centre the stop horizontally.
  function place(stop, animate) {
    if (!canvas || !STOPS[stop]) return;
    var vw = window.innerWidth || 360;
    var vh = window.innerHeight || 640;
    var w = Math.max(vw * 2.6, vh * 2.1 * (MAP_W / MAP_H));
    var h = w * (MAP_H / MAP_W);
    var p = STOPS[stop];
    var x = clamp(vw / 2 - (p[0] / MAP_W) * w, vw - w, 0);
    var viewY = VIEW_Y_BY_STOP[stop] || VIEW_Y;
    var y = clamp(vh * viewY - (p[1] / MAP_H) * h, vh - h, 0);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    if (!animate || reduceMotion) canvas.classList.add('sk-no-anim');
    else canvas.classList.remove('sk-no-anim');
    canvas.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  function slide(el, dir) {
    if (!el || reduceMotion) return;
    el.classList.remove('sk-slide-next', 'sk-slide-prev');
    void el.offsetWidth; // restart the animation
    el.classList.add(dir === 'prev' ? 'sk-slide-prev' : 'sk-slide-next');
    el.addEventListener('animationend', function done() {
      el.classList.remove('sk-slide-next', 'sk-slide-prev');
      el.removeEventListener('animationend', done);
    });
  }

  // Move the map to a stop. Returns the travel direction, or null if unchanged.
  function goTo(stop) {
    if (!STOPS[stop] || stop === current) return null;
    var dir = current ? direction(current, stop) : 'next';
    current = stop;
    // Commit the starting position first so the move animates from it.
    if (canvas) void canvas.offsetWidth;
    place(stop, true);
    saveStop(stop);
    return dir;
  }

  function isShown(el) {
    return !el.hidden && !el.closest('[hidden]');
  }

  // The stop for the step currently on screen (the last visible step wins).
  function activeStop() {
    var counter = document.querySelector('[data-map-counter]');
    if (counter) {
      var m = /(\d+)/.exec(counter.textContent || '');
      var s = counter.getAttribute('data-map-counter') + (m ? m[1] : '1');
      if (STOPS[s]) return { stop: s, el: document.querySelector('[data-map-slide]') };
    }
    var steps = Array.prototype.filter.call(document.querySelectorAll('[data-map-step]'), isShown);
    if (steps.length) {
      var last = steps[steps.length - 1];
      return { stop: last.getAttribute('data-map-step'), el: last };
    }
    return { stop: document.body.getAttribute('data-map-stop'), el: null };
  }

  function watchSteps() {
    // Runs once per batch of changes (a step switch changes several elements).
    var observer = new MutationObserver(function () {
      var a = activeStop();
      var dir = goTo(a.stop);
      if (dir && a.el) slide(a.el, dir);
    });
    var counter = document.querySelector('[data-map-counter]');
    if (counter) observer.observe(counter, { childList: true, characterData: true, subtree: true });
    Array.prototype.forEach.call(document.querySelectorAll('[data-map-step]'), function (el) {
      observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
      // Steps can also be hidden through a parent (for example the reset flow).
      if (el.parentElement) observer.observe(el.parentElement, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  var PIN_SVG = '<svg viewBox="0 0 44 58" aria-hidden="true"><path d="M22 57C9 41 2 31 2 21a20 20 0 0 1 40 0c0 10-7 20-20 36z" fill="#ef8a69"/><circle cx="22" cy="21" r="8" fill="#fff"/></svg>';

  function wirePinLinks() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-map-pin]'), function (link) {
      link.addEventListener('click', function (event) {
        if (reduceMotion || event.defaultPrevented || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (document.querySelector('.sk-pin-drop')) { event.preventDefault(); return; }
        event.preventDefault();
        var pin = document.createElement('div');
        pin.className = 'sk-pin-drop';
        pin.setAttribute('aria-hidden', 'true');
        pin.innerHTML = PIN_SVG;
        // Land the pin's tip exactly on the map's start pin for this screen.
        var stopPoint = STOPS[current];
        if (canvas && stopPoint) {
          var r = canvas.getBoundingClientRect();
          pin.style.left = Math.round(r.left + (stopPoint[0] / MAP_W) * r.width - 22) + 'px';
          pin.style.top = Math.round(r.top + (stopPoint[1] / MAP_H) * r.height - 58) + 'px';
          pin.style.marginLeft = '0';
        }
        document.body.appendChild(pin);
        var href = link.href;
        window.setTimeout(function () { window.location.href = href; }, 680);
      });
    });
  }

  function init() {
    var pageStop = document.body.getAttribute('data-map-stop');
    if (!pageStop || !STOPS[pageStop]) return;

    var layer = document.createElement('div');
    layer.className = 'sk-map';
    layer.setAttribute('aria-hidden', 'true');
    canvas = document.createElement('div');
    canvas.className = 'sk-map-canvas';
    var wash = document.createElement('div');
    wash.className = 'sk-map-wash';
    layer.appendChild(canvas);
    layer.appendChild(wash);
    document.body.insertBefore(layer, document.body.firstChild);

    var previous = readStop();
    var target = activeStop().stop || pageStop;
    if (previous && STOPS[previous] && previous !== target) {
      // Start where the last screen left off, then travel to this screen.
      current = previous;
      place(previous, false);
      goTo(target);
      slide(document.querySelector('[data-map-slide]'), direction(previous, target));
    } else {
      current = target;
      place(target, false);
      saveStop(target);
    }

    window.addEventListener('resize', function () { place(current, false); });
    watchSteps();
    wirePinLinks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SidekickMap = { goTo: goTo };
})();
