document.addEventListener('DOMContentLoaded', function () {
  const nav = document.querySelector('.bottom-nav.overlay');
  if (!nav) return;

  const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';
  if (currentPage !== 'chat.html' && !document.querySelector('.sidekick-launcher')) {
    const launcher = document.createElement('button');
    launcher.className = 'sidekick-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Open Sidekick assistant');
    launcher.title = 'Open Sidekick';
    launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg><span>Sidekick</span>';
    const panel = document.createElement('div');
    panel.className = 'sidekick-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Sidekick assistant');
    const frame = document.createElement('iframe');
    frame.title = 'Sidekick assistant';
    frame.src = 'chat.html';
    panel.appendChild(frame);
    launcher.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      launcher.setAttribute('aria-expanded', String(open));
    });
    document.body.append(launcher, panel);
  }

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
