document.addEventListener('DOMContentLoaded', function () {
  const nav = document.querySelector('.bottom-nav.overlay');
  if (!nav) return;

  // Active link highlighting
  try {
    const links = Array.from(nav.querySelectorAll('.nav-item'));
    const current = window.location.pathname.split('/').pop() || 'dashboard.html';
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

  // Add alerts badge element and keep it updated
  try {
    const alertsLink = nav.querySelector('a[href$="alerts.html"]');
    if (alertsLink && !alertsLink.querySelector('.reminders-badge')) {
      const badge = document.createElement('span');
      badge.className = 'reminders-badge';
      badge.style.cssText = 'display:inline-block;min-width:18px;height:18px;padding:0 6px;border-radius:12px;background:#ef4444;color:white;font-size:12px;line-height:18px;text-align:center;margin-left:6px;';
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
      // initial update
      setTimeout(updateBadge, 300);
    }
  } catch (e) {}

  let lastY = window.scrollY || 0;
  let ticking = false;

  function onScroll() {
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
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      window.requestAnimationFrame(onScroll);
      ticking = true;
    }
  }, { passive: true });
});
