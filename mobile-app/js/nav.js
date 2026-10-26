document.addEventListener('DOMContentLoaded', function () {
  const nav = document.querySelector('.bottom-nav.overlay');
  if (!nav) return;

  // Active link highlighting
  try {
    const links = Array.from(nav.querySelectorAll('.nav-item'));
    let current = window.location.pathname.split('/').pop() || 'dashboard.html';
    // Screens opened from a tab (Settings and Past trips belong to Profile) keep
    // that tab highlighted; they name it with <body data-tab="...">.
    const tab = document.body && document.body.getAttribute('data-tab');
    if (tab && !links.some((a) => (a.getAttribute('href') || '').split('/').pop() === current)) {
      current = `${tab}.html`;
    }
    links.forEach((a) => {
      const href = (a.getAttribute('href') || '').split('/').pop();
      if (!href) return;
      if (href === current) {
        a.classList.add('active');
      } else {
        a.classList.remove('active');
      }
    });
  } catch (e) {
    // ignore
  }
  // Make navbar responsive to scroll direction: hide on scroll down, show on scroll up
  nav.classList.add('navbar-visible');

  // ---- Screens without the tab bar ---------------------------------------------
  // Settings and Past trips (<body data-nav="away">) are screens of their own: the bar
  // slides down out of view, and slides back up on the next tab screen. In-page
  // screens (Home's "See all") use SidekickNav.hide() / show(). Styles: tab-motion.css.
  const NAV_KEY = 'sidekick.nav.last';
  const away = document.body.getAttribute('data-nav') === 'away';
  const setReachable = (reachable) => {
    if (reachable) { nav.removeAttribute('inert'); nav.removeAttribute('aria-hidden'); }
    else { nav.setAttribute('inert', ''); nav.setAttribute('aria-hidden', 'true'); }
  };
  if (away) setReachable(false);

  // Where the browser swaps pages with a view transition (theme-init.js), it moves the
  // bar itself; otherwise the bar plays the slide when the page opens.
  function playArrival() {
    let last = null;
    try {
      last = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null');
      sessionStorage.removeItem(NAV_KEY);
    } catch (e) {}
    if (document.documentElement.classList.contains('sk-vt')) return;
    if (!last || Date.now() - Number(last.time || 0) > 4000 || last.shown === !away) return;
    const name = away ? 'sk-nav-leave' : 'sk-nav-return';
    nav.classList.remove('sk-nav-leave', 'sk-nav-return');
    void nav.offsetWidth;
    nav.classList.add(name);
    const done = () => nav.classList.remove(name);
    nav.addEventListener('animationend', done, { once: true });
    window.setTimeout(done, 700);
  }
  playArrival();
  window.addEventListener('pagehide', function () {
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify({ shown: !away, time: Date.now() })); } catch (e) {}
  });
  window.addEventListener('pageshow', function (event) { if (event.persisted) playArrival(); });

  window.SidekickNav = {
    hide() { nav.classList.add('nav-away'); setReachable(false); },
    show() { nav.classList.remove('nav-away'); if (!away) setReachable(true); },
  };

  // Add alerts badge element and keep it updated
  try {
    const alertsLink = nav.querySelector('a[href$="alerts.html"]');
    if (alertsLink && !alertsLink.querySelector('.reminders-badge')) {
      const badge = document.createElement('span');
      badge.className = 'reminders-badge';
      badge.style.cssText = 'display:none;';
      badge.textContent = '';
      alertsLink.appendChild(badge);

      function updateBadge() {
        try {
          const session = window.SidekickCore?.getAuthSession?.();
          if (!session?.email) { badge.style.display = 'none'; return; }
          const cnt = window.SidekickCore?.getUpcomingRemindersCount ? window.SidekickCore.getUpcomingRemindersCount(session.email) : 0;
          if (cnt > 0) { badge.style.display = 'inline-block'; badge.textContent = String(cnt > 9 ? '9+' : cnt); }
          else { badge.style.display = 'none'; }
        } catch (e) { badge.style.display = 'none'; }
      }

      document.addEventListener('sidekick:reminders-updated', (ev) => { updateBadge(); });
      window.addEventListener('focus', updateBadge);
      
      setTimeout(updateBadge, 300);
    }
  } catch (e) {}

  // Red count on the Sidekick tab: replies that arrived while on another screen.
  try {
    const chatLink = nav.querySelector('a[href$="chat.html"]');
    if (chatLink && !chatLink.querySelector('.chat-unread-badge')) {
      const badge = document.createElement('span');
      badge.className = 'reminders-badge chat-unread-badge';
      badge.style.display = 'none';
      badge.setAttribute('aria-label', 'Unread Sidekick replies');
      chatLink.appendChild(badge);
      const updateChatBadge = () => {
        const count = window.SidekickCore?.chatUnread?.count?.() || 0;
        badge.style.display = count > 0 ? 'inline-block' : 'none';
        badge.textContent = count > 9 ? '9+' : String(count || '');
      };
      document.addEventListener('sidekick:chat-unread', updateChatBadge);
      window.addEventListener('focus', updateChatBadge);
      window.addEventListener('storage', updateChatBadge);
      setTimeout(updateChatBadge, 300);
    }
  } catch (e) {}

  let lastY = window.scrollY || 0;
  let ticking = false;

  function onScroll() {
    ticking = false;
    if (away) return;
    const currentY = window.scrollY || 0;
    const delta = currentY - lastY;

    // small threshold to avoid flicker
    const THRESHOLD = 10;

    if (Math.abs(delta) < THRESHOLD) {
      // do nothing
      return;
    }

    if (delta > 0 && currentY > 60) {
      // scrolling down -> hide nav
      nav.classList.add('navbar-hidden');
      nav.classList.remove('navbar-visible');
    } else if (delta < 0) {
      // scrolling up -> show nav
      nav.classList.remove('navbar-hidden');
      nav.classList.add('navbar-visible');
    }

    lastY = currentY;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      window.requestAnimationFrame(onScroll);
      ticking = true;
    }
  }, { passive: true });
});
