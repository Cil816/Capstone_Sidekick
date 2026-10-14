(function () {
  const ADMIN_TOKEN_KEY = 'admin.sessionToken';
  const LEGACY_ADMIN_TOKEN_KEY = 'sidekick.adminToken';

  function getApiBaseUrl() {
    const config = window.SIDEKICK_ADMIN_CONFIG || {};
    const configuredBase = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
    const apiMode = String(config.apiMode || 'production').trim().toLowerCase();
    if (configuredBase) {
      if (apiMode !== 'development' && !/^https:\/\//i.test(configuredBase)) {
        throw new Error('Production SIDEKICK_ADMIN_CONFIG.apiBaseUrl must use HTTPS.');
      }
      return configuredBase;
    }
    if (apiMode === 'development') return 'http://localhost:3001';
    throw new Error('Configure SIDEKICK_ADMIN_CONFIG.apiBaseUrl with the HTTPS backend URL for production.');
  }

  // The sign-in page is recognised by its form, so it works at /admin/admin-login.html
  // (local) and at the site root with clean addresses (production).
  function isLoginPage() {
    return Boolean(document.getElementById('admin-login-form'))
      || window.location.pathname.endsWith('admin-login.html');
  }

  function ensureAdminSession() {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (!token && !isLoginPage()) {
      window.location.href = 'admin-login.html';
      return false;
    }
    return Boolean(token);
  }

  function setStatus(message, kind = 'info') {
    const node = document.getElementById('admin-status-banner');
    if (!node) return;
    node.textContent = message;
    node.classList.add('visible');
    node.style.background = kind === 'error' ? '#fff0f0' : '#edf6ff';
    node.style.color = kind === 'error' ? '#9f1239' : '#165e8a';
    node.style.borderColor = kind === 'error' ? 'rgba(159,18,57,0.15)' : 'rgba(21, 94, 138, 0.15)';
  }

  function getReadableError(error) {
    if (error instanceof TypeError || /failed to fetch|networkerror/i.test(String(error?.message || ''))) {
      return "We couldn't connect to Sidekick. Check your connection and try again.";
    }
    return error?.message || "Something went wrong. Please try again.";
  }

  function getLoginErrorMessage(error) {
    const message = String(error?.message || '');
    if (message === 'Admin authentication failed.') {
      return "We couldn't sign you in. Check your username and password, then try again.";
    }
    if (message.startsWith('Admin authentication is not configured.')) {
      return "Admin sign-in isn't set up yet. Contact your system administrator.";
    }
    return getReadableError(error);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  async function request(path, options = {}) {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Admin-Token': token } : {}),
        ...(options.headers || {}),
      },
    });

    const payloadText = await response.text();
    let payload = {};
    try { payload = payloadText ? JSON.parse(payloadText) : {}; } catch (error) { payload = {}; }
    if (!response.ok) {
      const message = payload?.error || "We couldn't complete that request. Please try again.";
      if (response.status === 401) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        if (!isLoginPage()) {
          window.location.replace('admin-login.html');
        }
      }
      throw new Error(message);
    }
    return payload;
  }

  async function logout() {
    try {
      const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
      if (token) {
        await fetch(`${getApiBaseUrl()}/api/admin/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': token,
          },
        }).catch(() => undefined);
      }
    } finally {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
      sessionStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
      window.location.href = 'admin-login.html';
    }
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatDateOnly(value) {
    if (!value) return '—';
    const dateText = String(value).slice(0, 10);
    const date = new Date(`${dateText}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? dateText
      : date.toLocaleDateString([], { dateStyle: 'medium' });
  }

  function renderTableBody(targetId, rows, columns) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="100%" class="empty-state">Nothing to show yet. Try changing your search or filters.</td></tr>';
      return;
    }

    const html = rows.map((row) => `
      <tr>
        ${columns.map((column) => {
          const value = typeof column.value === 'function' ? column.value(row) : row[column.key];
          return `<td>${column.html ? value ?? '—' : escapeHtml(value ?? '—')}</td>`;
        }).join('')}
      </tr>
    `).join('');
    target.innerHTML = html;
  }

  // ---- Line charts (dependency-free SVG) ------------------------------------

  const DAY_MS = 24 * 60 * 60 * 1000;
  const CHART_COLORS = { itineraries: '#2c91b0', registrations: '#6b8cae', signIns: '#4f8a6e', chat: '#7a6bb0' };
  const chartRegistry = new Map();

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '—';
  }

  function toUtcDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }

  function formatChartDate(dateKey, withYear = false) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return dateKey;
    return date.toLocaleDateString([], {
      month: 'short', day: 'numeric', timeZone: 'UTC', ...(withYear ? { year: 'numeric' } : {}),
    });
  }

  // One point per UTC day from rangeStart to rangeEnd; days without records are 0.
  function buildDailySeries(counts, rangeStart, rangeEnd) {
    const start = Date.parse(`${rangeStart}T00:00:00Z`);
    const end = Date.parse(`${rangeEnd}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const series = [];
    for (let time = start; time <= end; time += DAY_MS) {
      const date = new Date(time).toISOString().slice(0, 10);
      series.push({ date, value: Number(counts.get(date) || 0) });
    }
    return series;
  }

  function trendToCounts(points) {
    return new Map((points || []).map((point) => [String(point.label || '').slice(0, 10), Number(point.value || 0)]));
  }

  function getNiceScale(maxValue) {
    if (maxValue <= 4) return { max: 4, step: 1 };
    const magnitude = 10 ** Math.floor(Math.log10(maxValue));
    const normalized = maxValue / magnitude;
    const niceMax = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
    return { max: niceMax, step: niceMax <= 5 ? 1 : niceMax / 5 };
  }

  function showChartTooltip(clientX, clientY, html) {
    const tooltip = document.getElementById('chart-tooltip');
    if (!tooltip) return;
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const { width, height } = tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, clientX - width / 2));
    const top = clientY - height - 14 < 8 ? clientY + 18 : clientY - height - 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideChartTooltip() {
    const tooltip = document.getElementById('chart-tooltip');
    if (tooltip) tooltip.hidden = true;
  }

  // data: [{ date: 'YYYY-MM-DD', value }]; options: { label, unit, color, emptyText }
  function renderLineChart(targetId, data, options = {}) {
    const target = document.getElementById(targetId);
    if (!target) return;
    chartRegistry.set(targetId, { data, options });
    const total = data.reduce((sum, point) => sum + point.value, 0);
    if (!data.length || total === 0) {
      target.innerHTML = `<div class="empty-state chart-empty">${escapeHtml(options.emptyText || 'Nothing recorded in this period.')}</div>`;
      target.setAttribute('aria-label', `${options.label || 'Chart'}: nothing recorded in this period.`);
      return;
    }

    const width = Math.max(280, Math.round(target.clientWidth || 600));
    const height = options.height || 260;
    const pad = { top: 18, right: 18, bottom: 36, left: 44 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const maxValue = Math.max(...data.map((point) => point.value));
    const scale = getNiceScale(maxValue);
    const stepX = data.length > 1 ? plotWidth / (data.length - 1) : 0;
    const xFor = (index) => pad.left + (data.length > 1 ? index * stepX : plotWidth / 2);
    const yFor = (value) => pad.top + plotHeight - (value / scale.max) * plotHeight;
    const color = options.color || CHART_COLORS.itineraries;

    const gridLines = [];
    for (let tick = 0; tick <= scale.max; tick += scale.step) {
      const y = yFor(tick).toFixed(1);
      gridLines.push(`
        <line class="chart-grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}"></line>
        <text class="chart-axis-label" x="${pad.left - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(formatNumber(tick))}</text>
      `);
    }

    const maxLabels = Math.max(2, Math.floor(plotWidth / 78));
    const labelEvery = Math.max(1, Math.ceil(data.length / maxLabels));
    const xLabels = data.map((point, index) => {
      const isLast = index === data.length - 1;
      if (index % labelEvery !== 0 && !isLast) return '';
      if (!isLast && data.length - 1 - index < labelEvery / 2) return '';
      return `<text class="chart-axis-label" x="${xFor(index).toFixed(1)}" y="${height - 12}" text-anchor="${index === 0 ? 'start' : isLast ? 'end' : 'middle'}">${escapeHtml(formatChartDate(point.date))}</text>`;
    }).join('');

    const linePoints = data.map((point, index) => `${xFor(index).toFixed(1)},${yFor(point.value).toFixed(1)}`);
    const baseline = yFor(0).toFixed(1);
    const areaPath = `M${xFor(0).toFixed(1)},${baseline} L${linePoints.join(' L')} L${xFor(data.length - 1).toFixed(1)},${baseline} Z`;
    const dots = data.length <= 31
      ? data.map((point, index) => (point.value > 0
        ? `<circle class="chart-dot" cx="${xFor(index).toFixed(1)}" cy="${yFor(point.value).toFixed(1)}" r="3.5" fill="${color}"></circle>`
        : '')).join('')
      : '';
    const peak = data.reduce((best, point) => (point.value > best.value ? point : best), data[0]);

    target.innerHTML = `
      <svg class="line-chart-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" aria-hidden="true" focusable="false">
        ${gridLines.join('')}
        <line class="chart-axis-line" x1="${pad.left}" x2="${width - pad.right}" y1="${baseline}" y2="${baseline}"></line>
        <path d="${areaPath}" fill="${color}" fill-opacity="0.08"></path>
        <polyline points="${linePoints.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${dots}
        ${xLabels}
        <line class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${baseline}" visibility="hidden"></line>
        <circle class="chart-hover-dot" r="6" fill="#fff" stroke="${color}" stroke-width="3" visibility="hidden"></circle>
      </svg>
    `;
    target.setAttribute('aria-label', `${options.label || 'Chart'}: ${formatNumber(total)} ${options.unit || 'records'} from ${formatChartDate(data[0].date, true)} to ${formatChartDate(data[data.length - 1].date, true)}. Highest: ${formatNumber(peak.value)} on ${formatChartDate(peak.date, true)}.`);

    const svg = target.querySelector('svg');
    const hoverLine = svg.querySelector('.chart-hover-line');
    const hoverDot = svg.querySelector('.chart-hover-dot');
    const highlight = (index, clientX, clientY) => {
      const activeIndex = Math.min(data.length - 1, Math.max(0, index));
      const point = data[activeIndex];
      const x = xFor(activeIndex);
      const y = yFor(point.value);
      hoverLine.setAttribute('x1', x); hoverLine.setAttribute('x2', x); hoverLine.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', x); hoverDot.setAttribute('cy', y); hoverDot.setAttribute('visibility', 'visible');
      showChartTooltip(
        clientX,
        clientY,
        `<strong>${escapeHtml(formatChartDate(point.date, true))}</strong><span>${escapeHtml(formatNumber(point.value))} ${escapeHtml(point.value === 1 ? (options.unitSingular || options.unit || '') : (options.unit || ''))}</span>`,
      );
    };
    const clear = () => {
      hoverLine.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      hideChartTooltip();
    };
    svg.addEventListener('pointermove', (event) => {
      const rect = svg.getBoundingClientRect();
      const localX = ((event.clientX - rect.left) / rect.width) * width;
      highlight(stepX ? Math.round((localX - pad.left) / stepX) : 0, event.clientX, event.clientY);
    });
    svg.addEventListener('pointerleave', clear);
  }

  let chartResizeTimer = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(chartResizeTimer);
    chartResizeTimer = window.setTimeout(() => {
      hideChartTooltip();
      for (const [targetId, chart] of chartRegistry) renderLineChart(targetId, chart.data, chart.options);
    }, 150);
  });

  function readStoredRange(key, allowed, fallback) {
    try {
      const value = Number(localStorage.getItem(key));
      return allowed.includes(value) ? value : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function storeRange(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (error) { /* optional convenience only */ }
  }

  // ---- Dashboard -------------------------------------------------------------

  const DASHBOARD_RANGE_KEY = 'admin.dashboardRangeDays';
  let dashboardRangeDays = readStoredRange(DASHBOARD_RANGE_KEY, [7, 30, 90], 30);

  const ICONS = {
    users: '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    verified: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
    enabled: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>',
    pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6H21"/>',
    online: '<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4"/><path d="M17.7 6.3a8 8 0 0 1 0 11.4"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    signin: '<path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5"/><path d="M15 12H4"/>',
    restaurant: '<path d="M7 3v8"/><path d="M4 3v5a3 3 0 0 0 6 0V3"/><path d="M7 11v10"/><path d="M17 21V3c-2 0-3.5 2.5-3.5 6s1.5 4 3.5 4"/>',
    hotel: '<path d="M3 20V6"/><path d="M3 16h18v4"/><path d="M21 16v-4a3 3 0 0 0-3-3h-7v7"/><circle cx="7" cy="12" r="2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function renderStatCards(target, cards) {
    target.innerHTML = cards.map((card) => `
      <article class="admin-card stat-card${card.untracked ? ' is-untracked' : ''}">
        <div class="stat-head">
          <span class="stat-icon">${icon(card.icon)}</span>
          <h3 class="stat-label">${escapeHtml(card.label)}</h3>
        </div>
        <div class="stat-value">${escapeHtml(card.value)}</div>
        <p class="stat-detail">${escapeHtml(card.detail)}</p>
      </article>
    `).join('');
  }

  function renderDashboardSummary(summary) {
    const target = document.getElementById('dashboard-summary');
    if (!target) return;
    const metrics = summary?.metrics || {};
    const recentlyActiveTracked = summary?.lastActiveTrackingAvailable && metrics.recentlyActiveUsers30Days != null;
    const usageTracked = Boolean(summary?.usageTracking?.available) && metrics.totalChatMessages != null;
    const trackedSince = describeTrackingStart(summary?.usageTracking?.firstEventAt);
    renderStatCards(target, [
      {
        icon: 'users', label: 'Registered users', value: formatNumber(metrics.totalUsers),
        detail: 'Every Sidekick account in the database, verified or not.',
      },
      {
        icon: 'verified', label: 'Verified users', value: formatNumber(metrics.verifiedUsers),
        detail: `Confirmed their email address. ${formatNumber(metrics.unverifiedUsers)} still unverified.`,
      },
      {
        icon: 'enabled', label: 'Active accounts', value: formatNumber(metrics.activeUsers),
        detail: `Accounts that are enabled and allowed to sign in. ${formatNumber(metrics.inactiveUsers)} disabled.`,
      },
      {
        icon: 'pulse', label: 'Active in last 30 days',
        value: recentlyActiveTracked ? formatNumber(metrics.recentlyActiveUsers30Days) : 'Not tracked',
        untracked: !recentlyActiveTracked,
        detail: recentlyActiveTracked
          ? 'Users who signed in or had the app open in the past 30 days.'
          : 'Needs the last-active tracking migration (002_user_last_active.sql).',
      },
      {
        icon: 'online', label: 'Online now', value: formatNumber(metrics.onlineUsers),
        detail: 'Users with the app open in the past 90 seconds. Resets if the server restarts.',
      },
      {
        icon: 'compass', label: 'Saved itineraries', value: formatNumber(metrics.totalTrips),
        detail: `Itineraries currently stored in user accounts. ${formatNumber(metrics.tripsLast30Days)} saved in the past 30 days.`,
      },
      usageTracked
        ? {
          icon: 'chat', label: 'Chatbot messages', value: formatNumber(metrics.totalChatMessages),
          detail: `${formatNumber(metrics.chatMessagesLast30Days)} in the past 30 days, from ${formatNumber(metrics.chatUsersLast30Days)} ${metrics.chatUsersLast30Days === 1 ? 'user' : 'users'}. ${trackedSince}`,
        }
        : {
          icon: 'chat', label: 'Chatbot messages', value: 'Not tracked', untracked: true,
          detail: 'Run backend/migrations/003_app_usage_events.sql to start recording.',
        },
      usageTracked
        ? {
          icon: 'signin', label: 'User sign-ins', value: formatNumber(metrics.totalSignIns),
          detail: `${formatNumber(metrics.signInsLast30Days)} in the past 30 days. ${trackedSince}`,
        }
        : {
          icon: 'signin', label: 'User sign-ins', value: 'Not tracked', untracked: true,
          detail: 'Run backend/migrations/003_app_usage_events.sql to start recording.',
        },
    ]);
  }

  function renderRankedList(title, items, { denominator, unit, emptyText }) {
    const max = Math.max(1, ...items.map((item) => item.count));
    return `
      <article class="admin-card insight-card">
        <h3>${escapeHtml(title)}</h3>
        ${items.length ? `
          <ol class="ranked-list">
            ${items.map((item) => {
              const share = denominator ? Math.round((item.count / denominator) * 100) : null;
              return `
                <li>
                  <div class="ranked-row">
                    <span class="ranked-name">${escapeHtml(item.name)}</span>
                    <span class="ranked-count">${escapeHtml(formatNumber(item.count))} ${escapeHtml(item.count === 1 ? unit[0] : unit[1])}${share !== null ? ` <span class="ranked-share">· ${escapeHtml(share)}%</span>` : ''}</span>
                  </div>
                  <div class="ranked-bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round((item.count / max) * 100))}%"></span></div>
                </li>
              `;
            }).join('')}
          </ol>
        ` : `<div class="empty-state">${escapeHtml(emptyText)}</div>`}
      </article>
    `;
  }

  function renderUserBaseSummary(profileSummary, summary) {
    const target = document.getElementById('user-base-summary');
    const coverage = document.getElementById('user-base-coverage');
    if (!target) return;
    const usersWithPreferences = Number(profileSummary?.usersWithPreferences || 0);
    const totalUsers = Number(summary?.metrics?.totalUsers);
    if (coverage) {
      coverage.textContent = Number.isFinite(totalUsers)
        ? `Preferences are based on the ${formatNumber(usersWithPreferences)} of ${formatNumber(totalUsers)} users who saved them during onboarding.`
        : `Preferences are based on the ${formatNumber(usersWithPreferences)} users who saved them during onboarding.`;
    }
    const userUnit = ['user', 'users'];
    target.innerHTML = [
      renderRankedList('Top travel interests', profileSummary?.interests || [], { denominator: usersWithPreferences, unit: userUnit, emptyText: 'No interests saved yet.' }),
      renderRankedList('Travel styles', profileSummary?.travelStyles || [], { denominator: usersWithPreferences, unit: userUnit, emptyText: 'No travel styles saved yet.' }),
      renderRankedList('Preferred destinations', profileSummary?.preferredPlaces || [], { denominator: usersWithPreferences, unit: userUnit, emptyText: 'No preferred destinations saved yet.' }),
      renderRankedList('Budgets on saved itineraries', profileSummary?.savedItineraryBudgets || [], { denominator: null, unit: ['itinerary', 'itineraries'], emptyText: 'No budgets recorded on saved itineraries.' }),
    ].join('');
  }

  function renderRecentActivity(activityList, activities, limit = 8) {
    const items = [...(activities?.recentUsers || []), ...(activities?.recentTrips || []), ...(activities?.recentUsage || [])]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
    activityList.innerHTML = items.length
      ? items.map((item) => `
          <div class="logger-item">
            <div class="logger-text">${escapeHtml(item.label)}</div>
            <div class="logger-time">${escapeHtml(formatDate(item.timestamp))}</div>
          </div>
        `).join('')
      : '<div class="empty-state">Nothing to show yet. New sign-ups and saved itineraries will appear here.</div>';
  }

  // ---- What users plan (activities, restaurants, hotels, destinations) -------

  // Ranked horizontal bars. items: [{ name, users, picks }]. Bar length = users.
  function renderBarChart(targetId, items, { emptyText, label }) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!items.length) {
      target.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
      return;
    }
    const max = Math.max(1, ...items.map((item) => item.users));
    target.innerHTML = `
      <ol class="hbar-chart" aria-label="${escapeHtml(label)}">
        ${items.map((item, index) => {
          const users = `${formatNumber(item.users)} ${item.users === 1 ? 'user' : 'users'}`;
          const picks = `${formatNumber(item.picks)} ${item.picks === 1 ? 'pick' : 'picks'}`;
          return `
            <li class="hbar-row" tabindex="0" data-tip-name="${escapeHtml(item.name)}" data-tip-detail="${escapeHtml(`${users} · ${picks}`)}">
              <span class="hbar-rank" aria-hidden="true">${index + 1}</span>
              <span class="hbar-label">${escapeHtml(item.name)}</span>
              <span class="hbar-track" aria-hidden="true"><span class="hbar-fill" style="width:${Math.max(2, (item.users / max) * 100).toFixed(1)}%"></span></span>
              <span class="hbar-value">${escapeHtml(users)}<span class="hbar-sub"> · ${escapeHtml(picks)}</span></span>
            </li>`;
        }).join('')}
      </ol>`;
  }

  // One delegated tooltip for every bar chart on the page (hover and keyboard focus).
  function initBarTooltips() {
    const show = (row, clientX, clientY) => {
      const rect = row.getBoundingClientRect();
      showChartTooltip(clientX ?? rect.left + rect.width / 2, clientY ?? rect.top,
        `<strong>${escapeHtml(row.dataset.tipName)}</strong><span>${escapeHtml(row.dataset.tipDetail)}</span>`);
    };
    document.addEventListener('pointermove', (event) => {
      const row = event.target.closest?.('.hbar-row');
      if (row) show(row, event.clientX, event.clientY);
    });
    document.addEventListener('pointerout', (event) => {
      if (event.target.closest?.('.hbar-row') && !event.relatedTarget?.closest?.('.hbar-row')) hideChartTooltip();
    });
    document.addEventListener('focusin', (event) => {
      const row = event.target.closest?.('.hbar-row');
      if (row) show(row);
    });
    document.addEventListener('focusout', (event) => {
      if (event.target.closest?.('.hbar-row')) hideChartTooltip();
    });
  }

  function formatMedian(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    return Number.isInteger(number) ? formatNumber(number) : number.toFixed(1);
  }

  function renderPlanMedians(insights) {
    const target = document.getElementById('plan-medians');
    if (!target) return;
    const medians = insights?.medians || {};
    const totals = insights?.totals || {};
    if (!totals.savedItineraries) {
      target.innerHTML = '<div class="admin-card empty-state">No saved itineraries yet, so there is nothing to take a median of.</div>';
      return;
    }
    const across = `Across ${formatNumber(totals.savedItineraries)} saved ${totals.savedItineraries === 1 ? 'itinerary' : 'itineraries'}.`;
    renderStatCards(target, [
      { icon: 'pin', label: 'Activities per itinerary', value: formatMedian(medians.activitiesPerItinerary), detail: `Planned stops, not counting restaurants or hotels. ${across}` },
      { icon: 'restaurant', label: 'Restaurants per itinerary', value: formatMedian(medians.restaurantsPerItinerary), detail: `Restaurants the user added. ${across}` },
      { icon: 'hotel', label: 'Hotels per itinerary', value: formatMedian(medians.hotelsPerItinerary), detail: `Hotels the user added. ${across}` },
      { icon: 'calendar', label: 'Days per itinerary', value: formatMedian(medians.daysPerItinerary), detail: `Trip length in days. ${across}` },
      { icon: 'users', label: 'Itineraries per user', value: formatMedian(medians.itinerariesPerUser), detail: `Among the ${formatNumber(totals.usersWithItineraries)} ${totals.usersWithItineraries === 1 ? 'user' : 'users'} with a saved itinerary.` },
    ]);
  }

  const PLAN_CHARTS = [
    { key: 'activities', label: 'Most planned activities', empty: 'No activities in saved itineraries yet.' },
    { key: 'restaurants', label: 'Most picked restaurants', empty: 'No restaurants have been added to itineraries yet.' },
    { key: 'hotels', label: 'Most picked hotels', empty: 'No hotels have been added to itineraries yet.' },
    { key: 'destinations', label: 'Most planned destinations', empty: 'No saved itineraries yet.' },
    { key: 'activityTypes', label: 'Activity types', empty: 'No activities in saved itineraries yet.' },
    { key: 'preferredDestinations', label: 'Destinations chosen at onboarding', empty: 'No preferred destinations saved yet.' },
  ];

  // prefix: 'plan' on the Dashboard, 'picks' on the Users page.
  async function loadPlanInsights(prefix, limit, { silent = false } = {}) {
    const ids = {
      activities: `${prefix}-activities`, restaurants: `${prefix}-restaurants`, hotels: `${prefix}-hotels`,
      destinations: `${prefix}-destinations`, activityTypes: `${prefix}-activity-types`, preferredDestinations: `${prefix}-preferred`,
    };
    const present = PLAN_CHARTS.filter((chart) => document.getElementById(ids[chart.key]));
    if (!present.length) return;
    if (!silent) {
      present.forEach((chart) => { document.getElementById(ids[chart.key]).innerHTML = '<div class="empty-state">Loading…</div>'; });
      const medians = document.getElementById('plan-medians');
      if (medians && prefix === 'plan') medians.innerHTML = '<div class="admin-card empty-state">Loading medians…</div>';
    }
    try {
      const insights = await request(`/api/admin/insights?limit=${encodeURIComponent(limit)}`);
      if (prefix === 'plan') renderPlanMedians(insights);
      present.forEach((chart) => renderBarChart(ids[chart.key], insights?.[chart.key] || [], { emptyText: chart.empty, label: chart.label }));
    } catch (error) {
      present.forEach((chart) => { document.getElementById(ids[chart.key]).innerHTML = '<div class="empty-state">We couldn’t load this list. Try again.</div>'; });
      const medians = document.getElementById('plan-medians');
      if (medians && prefix === 'plan') medians.innerHTML = '<div class="admin-card empty-state">We couldn’t load the medians. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  function updateRangeControls(days) {
    document.querySelectorAll('[data-range]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.range) === days));
    });
    document.querySelectorAll('[data-range-label]').forEach((node) => {
      node.textContent = `last ${days} days`;
    });
  }

  function renderDashboardCharts(analytics) {
    const itineraries = buildDailySeries(trendToCounts(analytics?.itineraryTrend), analytics?.rangeStart, analytics?.rangeEnd);
    const registrations = buildDailySeries(trendToCounts(analytics?.registrationTrend), analytics?.rangeStart, analytics?.rangeEnd);
    const sum = (series) => series.reduce((total, point) => total + point.value, 0);
    const setTotal = (id, value, unit) => {
      const node = document.getElementById(id);
      if (node) node.innerHTML = `<strong>${escapeHtml(formatNumber(value))}</strong><span>${escapeHtml(unit)}</span>`;
    };
    setTotal('chart-itineraries-total', sum(itineraries), 'in this period');
    setTotal('chart-registrations-total', sum(registrations), 'in this period');
    renderLineChart('chart-itineraries', itineraries, {
      label: 'Itineraries saved per day', unit: 'itineraries saved', unitSingular: 'itinerary saved',
      color: CHART_COLORS.itineraries, emptyText: 'No itineraries were saved in this period.',
    });
    renderLineChart('chart-registrations', registrations, {
      label: 'New registrations per day', unit: 'new accounts', unitSingular: 'new account',
      color: CHART_COLORS.registrations, emptyText: 'No new accounts were registered in this period.',
    });

    const usageCharts = [
      { id: 'chart-signins', card: 'card-signins', trend: analytics?.signInTrend, label: 'User sign-ins per day', unit: 'sign-ins', unitSingular: 'sign-in', color: CHART_COLORS.signIns, emptyText: 'No sign-ins were recorded in this period.' },
      { id: 'chart-chat', card: 'card-chat', trend: analytics?.chatTrend, label: 'Chatbot messages per day', unit: 'chatbot messages', unitSingular: 'chatbot message', color: CHART_COLORS.chat, emptyText: 'No chatbot messages were recorded in this period.' },
    ];
    for (const chart of usageCharts) {
      const card = document.getElementById(chart.card);
      const tracked = Boolean(analytics?.usageTrackingAvailable) && Array.isArray(chart.trend);
      card?.classList.toggle('chart-card-untracked', !tracked);
      if (!tracked) {
        chartRegistry.delete(chart.id);
        const total = document.getElementById(`${chart.id}-total`);
        if (total) total.innerHTML = '<span class="badge neutral">Not tracked yet</span>';
        const target = document.getElementById(chart.id);
        if (target) {
          target.innerHTML = '<div class="untracked-state"><p>Recording hasn’t been set up yet.</p><p>Run backend/migrations/003_app_usage_events.sql in SSMS, then restart the backend. Counting starts from that point; earlier activity can’t be recovered.</p></div>';
          target.setAttribute('aria-label', `${chart.label}: not tracked yet.`);
        }
        continue;
      }
      const series = buildDailySeries(trendToCounts(chart.trend), analytics?.rangeStart, analytics?.rangeEnd);
      setTotal(`${chart.id}-total`, sum(series), 'in this period');
      renderLineChart(chart.id, series, chart);
    }
  }

  function describeTrackingStart(firstEventAt) {
    if (!firstEventAt) return 'Nothing recorded yet.';
    return `Counted since ${formatChartDate(toUtcDateKey(firstEventAt), true)}.`;
  }

  async function loadDashboard({ silent = false } = {}) {
    const summaryTarget = document.getElementById('dashboard-summary');
    const activityList = document.getElementById('recent-activity-list');
    const userBase = document.getElementById('user-base-summary');
    if (!summaryTarget) return;
    updateRangeControls(dashboardRangeDays);
    if (!silent) {
      summaryTarget.innerHTML = '<div class="admin-card empty-state">Loading key numbers…</div>';
      ['chart-itineraries', 'chart-registrations', 'chart-signins', 'chart-chat'].forEach((id) => {
        const node = document.getElementById(id);
        if (node) node.innerHTML = '<div class="empty-state chart-empty">Loading graph…</div>';
      });
      if (userBase) userBase.innerHTML = '<div class="admin-card empty-state">Loading user summary…</div>';
      if (activityList) activityList.innerHTML = '<div class="empty-state">Loading recent sign-ups and saved itineraries…</div>';
    }

    const requestedRange = dashboardRangeDays;
    const [summaryResult, analyticsResult, activityResult] = await Promise.allSettled([
      request('/api/admin/summary'),
      request(`/api/admin/analytics?days=${encodeURIComponent(requestedRange)}`),
      activityList ? request('/api/admin/activity') : Promise.resolve(null),
    ]);
    // Ignore a slow response if the admin already picked another range.
    if (requestedRange !== dashboardRangeDays) return;

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    if (summary) {
      renderDashboardSummary(summary);
    } else {
      summaryTarget.innerHTML = '<div class="admin-card empty-state">We couldn’t load the key numbers. Try again.</div>';
    }

    if (analyticsResult.status === 'fulfilled') {
      renderDashboardCharts(analyticsResult.value);
      renderUserBaseSummary(analyticsResult.value?.profileSummary, summary);
    } else {
      ['chart-itineraries', 'chart-registrations', 'chart-signins', 'chart-chat'].forEach((id) => {
        chartRegistry.delete(id);
        const node = document.getElementById(id);
        if (node) node.innerHTML = '<div class="empty-state chart-empty">We couldn’t load this graph. Try again.</div>';
      });
      ['chart-itineraries-total', 'chart-registrations-total', 'chart-signins-total', 'chart-chat-total'].forEach((id) => {
        const node = document.getElementById(id);
        if (node) node.textContent = '';
      });
      if (userBase) userBase.innerHTML = '<div class="admin-card empty-state">We couldn’t load the user summary. Try again.</div>';
    }

    if (activityList) {
      if (activityResult.status === 'fulfilled') {
        renderRecentActivity(activityList, activityResult.value);
      } else {
        activityList.innerHTML = '<div class="empty-state">We couldn’t load recent activity. Try again.</div>';
      }
    }

    const failure = [summaryResult, analyticsResult, activityResult].find((result) => result.status === 'rejected');
    if (failure) {
      setStatus(getReadableError(failure.reason), 'error');
    } else {
      const updated = document.getElementById('dashboard-updated');
      if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
  }

  async function loadActivityFeed() {
    const activityList = document.getElementById('recent-activity-list');
    if (!activityList) return;
    const auditList = document.getElementById('admin-audit-list');
    activityList.innerHTML = '<div class="empty-state">Loading recent sign-ups and saved plans…</div>';
    if (auditList) auditList.innerHTML = '<div class="empty-state">Checking admin sign-in history…</div>';
    try {
      const [activities, audit] = await Promise.all([
        request('/api/admin/activity'),
        auditList ? request('/api/admin/audit') : Promise.resolve(null),
      ]);
      const items = [...(activities?.recentUsers || []), ...(activities?.recentTrips || []), ...(activities?.recentUsage || [])]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 12);
      activityList.innerHTML = items.length
        ? items.map((item) => `
            <div class="logger-item">
            <div class="logger-text">${escapeHtml(item.label)}</div>
            <div class="logger-time">${escapeHtml(formatDate(item.timestamp))}</div>
            </div>
          `).join('')
        : '<div class="empty-state">Nothing to show yet. New sign-ups and saved plans will appear here.</div>';
      if (auditList) {
        auditList.innerHTML = audit?.available
        ? (audit.events || []).length
          ? audit.events.map((event) => `
              <div class="logger-item">
                <div class="logger-text">${escapeHtml(event.actor || 'Administrator')} · ${escapeHtml(event.eventType)} (${escapeHtml(event.outcome)})</div>
                <div class="logger-time">${escapeHtml(formatDate(event.timestamp))}</div>
              </div>
            `).join('')
          : '<div class="empty-state">No admin sign-ins have been recorded yet.</div>'
        : '<div class="empty-state">Admin sign-in history isn’t set up yet.</div>';
      }
    } catch (error) {
      activityList.innerHTML = '<div class="empty-state">We couldn’t load recent activity. Try again.</div>';
      if (auditList) auditList.innerHTML = '<div class="empty-state">We couldn’t load admin sign-in history. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  const userTableState = { page: 1, total: 0, limit: 25 };
  let userLastActiveTrackingAvailable = false;
  const itineraryTableState = { page: 1, total: 0, limit: 25 };
  const appReviewTableState = { page: 1, total: 0, limit: 25 };
  let selectedItineraryTripId = null;

  function updatePagination(summaryId, previousId, nextId, state) {
    const summary = document.getElementById(summaryId);
    const previous = document.getElementById(previousId);
    const next = document.getElementById(nextId);
    const pageCount = Math.max(1, Math.ceil(state.total / state.limit));
    if (summary) summary.textContent = `Page ${state.page} of ${pageCount} · ${state.total} records`;
    if (previous) previous.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= pageCount;
  }

  async function loadUserTable(page = userTableState.page) {
    const tableBody = document.getElementById('user-table-body');
    if (!tableBody) return;
    tableBody.innerHTML = '<tr><td colspan="100%" class="empty-state">Loading users…</td></tr>';
    try {
      const search = document.getElementById('user-search')?.value.trim() || '';
      const status = document.getElementById('user-status-filter')?.value || 'all';
      const params = new URLSearchParams({ page: String(page), limit: String(userTableState.limit), search, status });
      const payload = await request(`/api/admin/users?${params}`);
      const users = payload?.users || [];
      userLastActiveTrackingAvailable = Boolean(payload?.lastActiveTrackingAvailable);
      const lastActiveNote = document.getElementById('user-last-active-note');
      if (lastActiveNote && !userLastActiveTrackingAvailable) {
        lastActiveNote.textContent = 'Last-active tracking is not set up yet. Run backend/migrations/002_user_last_active.sql manually in SSMS to display activity dates. Account deletion remains available.';
      }
      userTableState.page = payload?.page || page;
      userTableState.total = payload?.total || 0;
      renderTableBody('user-table-body', users, [
        { key: 'name', value: (row) => row.name || 'Unnamed user' },
        { key: 'email', value: (row) => row.email || '—' },
        { key: 'createdAt', value: (row) => formatDate(row.createdAt) },
        { key: 'lastActiveAt', value: (row) => {
          if (!row.lastActiveAt) return userLastActiveTrackingAvailable ? '—' : 'Tracking unavailable';
          const lastActive = new Date(row.lastActiveAt);
          const inactiveLongerThan180Days = Number.isFinite(lastActive.getTime())
            && Date.now() - lastActive.getTime() >= 180 * 24 * 60 * 60 * 1000;
          return `${formatDate(row.lastActiveAt)}${inactiveLongerThan180Days ? ' · 180+ days inactive' : ''}`;
        } },
        { key: 'accountState', html: true, value: (row) => `<span class="badge ${row.isActive ? 'success' : 'neutral'}">${row.isActive ? 'active' : 'inactive'}</span>` },
        { key: 'presence', html: true, value: (row) => `<span class="badge ${row.isOnline ? 'success' : 'neutral'}">${row.isOnline ? 'online' : 'offline'}</span>` },
        { key: 'verification', html: true, value: (row) => `<span class="badge ${row.isVerified ? 'success' : 'warning'}">${row.isVerified ? 'verified' : 'unverified'}</span>` },
        { key: 'details', html: true, value: (row) => `<button class="admin-button-secondary" type="button" data-user-detail="${Number(row.userId)}">Details</button>` },
      ]);
      updatePagination('user-page-summary', 'user-page-previous', 'user-page-next', userTableState);
    } catch (error) {
      tableBody.innerHTML = '<tr><td colspan="100%" class="empty-state">We couldn’t load users. Try again.</td></tr>';
      setStatus(getReadableError(error), 'error');
    }
  }

  // One user's picks: name, how many times it appears, and when it was last saved.
  function pickTable(title, rows, [singular, plural]) {
    const items = Array.isArray(rows) ? rows : [];
    return `
      <div class="user-picks-block">
        <h4>${escapeHtml(title)}</h4>
        ${items.length ? `
          <table class="pick-table">
            <thead><tr><th scope="col">Name</th><th scope="col" class="numeric">Count</th><th scope="col">Last saved</th></tr></thead>
            <tbody>
              ${items.map((item) => `
                <tr>
                  <td>${escapeHtml(item.name)}</td>
                  <td class="numeric">${escapeHtml(`${formatNumber(item.picks)} ${item.picks === 1 ? singular : plural}`)}</td>
                  <td>${escapeHtml(formatDateOnly(item.lastPickedAt))}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : '<p class="stat-detail">None saved.</p>'}
      </div>`;
  }

  function renderUserDetails(user) {
    const target = document.getElementById('user-detail-content');
    if (!target) return;
    const fields = [
      ['Name', user.name],
      ['Email', user.email],
      ['Joined', formatDate(user.createdAt)],
      ['Last app activity', formatDate(user.lastActiveAt)],
      ['Profile updated', formatDate(user.updatedAt)],
      ['Account status', user.isActive ? 'Active' : 'Inactive'],
      ['Verification', user.isVerified ? 'Verified' : 'Unverified'],
      ['Saved travel plans', user.tripCount],
    ];
    const list = (label, values) => `
      <section class="admin-detail-section">
        <h3>${escapeHtml(label)}</h3>
        <div>${values.length ? values.map((value) => `<span class="badge neutral">${escapeHtml(value)}</span>`).join(' ') : '<span class="stat-detail">None recorded</span>'}</div>
      </section>
    `;
    target.innerHTML = `
      <div class="admin-detail-grid">
        ${fields.map(([label, value]) => `<div><span class="stat-label">${escapeHtml(label)}</span><div class="admin-detail-value">${escapeHtml(value ?? '—')}</div></div>`).join('')}
      </div>
      ${list('Travel styles', user.travelStyles || [])}
      ${list('Interests', user.interests || [])}
      ${list('Preferred places', user.preferredPlaces || [])}
      ${user.picks ? `
        <section class="admin-detail-section">
          <h3>What this user picks</h3>
          <p class="stat-detail">From this user's itineraries currently saved in their account. Itineraries are removed after the trip ends.</p>
          <div class="user-picks-grid">
            ${pickTable('Destinations in itineraries', user.picks.destinations, ['itinerary', 'itineraries'])}
            ${pickTable('Activities planned', user.picks.activities, ['time', 'times'])}
            ${pickTable('Restaurants picked', user.picks.restaurants, ['time', 'times'])}
            ${pickTable('Hotels picked', user.picks.hotels, ['time', 'times'])}
          </div>
        </section>` : ''}
      <section class="admin-detail-section">
        <h3>Permanent account deletion</h3>
        <p class="stat-detail">${user.lastActiveTrackingAvailable
          ? user.inactiveLongerThan180Days
            ? 'No recorded app activity for at least 180 days. You may delete this account now, but the inactivity period is only a reference. Deletion permanently removes linked trips, itinerary activities, reviews, reminders, preferences, and account data.'
            : 'The 180-day inactivity period is a reference only. You may delete this account at any time. Deletion permanently removes linked Sidekick data.'
          : 'Last-active tracking is unavailable, but you may still delete this account at any time. Deletion permanently removes linked Sidekick data.'}</p>
        <button class="admin-button-danger" type="button" data-delete-user="${Number(user.userId)}" data-user-email="${escapeHtml(user.email || '')}">Delete account permanently</button>
      </section>
    `;
  }

  async function loadUserDetails(userId) {
    const panel = document.getElementById('user-detail-panel');
    const target = document.getElementById('user-detail-content');
    if (!panel || !target) return;
    panel.hidden = false;
    target.innerHTML = '<div class="empty-state">Loading user profile…</div>';
    try {
      const payload = await request(`/api/admin/users/${encodeURIComponent(userId)}`);
      renderUserDetails({
        ...(payload?.user || {}),
        userId,
        lastActiveTrackingAvailable: Boolean(payload?.user?.lastActiveTrackingAvailable),
        inactiveLongerThan180Days: Boolean(payload?.user?.inactiveLongerThan180Days),
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      target.innerHTML = '<div class="empty-state">We couldn’t load this user. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  async function deleteUserPermanently(userId, userEmail) {
    const confirmationEmail = window.prompt(
      `This permanently deletes ${userEmail} and their linked Sidekick data. This cannot be undone.\n\nType the account email to confirm:`,
    );
    if (confirmationEmail === null) return;
    if (confirmationEmail.trim().toLowerCase() !== String(userEmail || '').trim().toLowerCase()) {
      setStatus('The email did not match. The account was not deleted.', 'error');
      return;
    }

    try {
      await request(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmationEmail }),
      });
      document.getElementById('user-detail-panel').hidden = true;
      await loadUserTable(userTableState.page);
      setStatus('The account and its linked Sidekick data were permanently deleted.', 'info');
    } catch (error) {
      setStatus(getReadableError(error), 'error');
    }
  }

  async function loadAppReviews(page = appReviewTableState.page) {
    const tableBody = document.getElementById('app-reviews-table-body');
    const summary = document.getElementById('review-summary');
    if (!tableBody || !summary) return;
    tableBody.innerHTML = '<tr><td colspan="4" class="empty-state">Loading app reviews…</td></tr>';
    summary.innerHTML = '<div class="admin-card empty-state">Loading rating summary…</div>';
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(appReviewTableState.limit) });
      const payload = await request(`/api/admin/app-reviews?${params}`);
      appReviewTableState.page = payload?.page || page;
      appReviewTableState.total = payload?.total || 0;
      summary.innerHTML = `
        <div class="admin-card stat-card">
          <span class="stat-label">Average rating</span>
          <div class="stat-value">${payload.averageRating == null ? 'Not available' : `${escapeHtml(Number(payload.averageRating).toFixed(1))} / 5`}</div>
        </div>
        <div class="admin-card stat-card">
          <span class="stat-label">Ratings received</span>
          <div class="stat-value">${escapeHtml(payload.total ?? 0)}</div>
        </div>
      `;
      const reviews = payload?.reviews || [];
      tableBody.innerHTML = reviews.length
        ? reviews.map((review) => `
            <tr>
              <td><span class="badge neutral">${escapeHtml(review.rating)} / 5</span></td>
              <td class="review-text-cell">${escapeHtml(review.review || 'Rating only')}</td>
              <td>${escapeHtml(review.userName)}<br><span class="stat-detail">${escapeHtml(review.userEmail)}</span></td>
              <td>${escapeHtml(formatDate(review.updatedAt || review.createdAt))}</td>
            </tr>
          `).join('')
        : '<tr><td colspan="4" class="empty-state">No app ratings have been submitted yet.</td></tr>';
      updatePagination('app-reviews-page-summary', 'app-reviews-page-previous', 'app-reviews-page-next', appReviewTableState);
    } catch (error) {
      summary.innerHTML = '<div class="admin-card empty-state">Rating summary is unavailable.</div>';
      tableBody.innerHTML = '<tr><td colspan="4" class="empty-state">We couldn’t load app reviews. Check the database setup and try again.</td></tr>';
      setStatus(getReadableError(error), 'error');
    }
  }

  async function loadItineraryTable(page = itineraryTableState.page) {
    const tableBody = document.getElementById('itinerary-table-body');
    if (!tableBody) return;
    tableBody.innerHTML = '<tr><td colspan="100%" class="empty-state">Loading saved travel plans…</td></tr>';
    try {
      const search = document.getElementById('itinerary-search')?.value.trim() || '';
      const params = new URLSearchParams({ page: String(page), limit: String(itineraryTableState.limit), search });
      const payload = await request(`/api/admin/itineraries?${params}`);
      const itineraries = payload?.itineraries || [];
      itineraryTableState.page = payload?.page || page;
      itineraryTableState.total = payload?.total || 0;
      renderTableBody('itinerary-table-body', itineraries, [
        { key: 'title', value: (row) => row.title || 'Untitled plan' },
        { key: 'traveler', value: (row) => `${row.userName || 'Unnamed user'} · ${row.userEmail || '—'}` },
        { key: 'destination', value: (row) => row.destination || '—' },
        { key: 'dates', value: (row) => `${formatDateOnly(row.startDate)} – ${formatDateOnly(row.endDate)}` },
        { key: 'dayCount', value: (row) => row.dayCount },
        { key: 'activityCount', value: (row) => row.activityCount },
        { key: 'createdAt', value: (row) => formatDate(row.createdAt) },
        { key: 'details', html: true, value: (row) => `<button class="admin-button-secondary" type="button" data-itinerary-detail="${Number(row.tripId)}">Details</button>` },
      ]);
      updatePagination('itinerary-page-summary', 'itinerary-page-previous', 'itinerary-page-next', itineraryTableState);
    } catch (error) {
      tableBody.innerHTML = '<tr><td colspan="100%" class="empty-state">We couldn’t load travel plans. Try again.</td></tr>';
      setStatus(getReadableError(error), 'error');
    }
  }

  function renderItineraryDetails(itinerary) {
    const target = document.getElementById('itinerary-detail-content');
    if (!target) return;
    const fields = [
      ['Plan', itinerary.title],
      ['Traveler', itinerary.userName],
      ['Traveler email', itinerary.userEmail],
      ['Destination', itinerary.destination],
      ['Dates', `${formatDateOnly(itinerary.startDate)} – ${formatDateOnly(itinerary.endDate)}`],
      ['Budget', itinerary.budget],
      ['Saved', formatDate(itinerary.createdAt)],
      ['Last updated', formatDate(itinerary.updatedAt)],
      ['Travel days', itinerary.days?.length || 0],
    ];
    const days = itinerary.days || [];
    target.innerHTML = `
      <div class="admin-detail-grid">
        ${fields.map(([label, value]) => `<div><span class="stat-label">${escapeHtml(label)}</span><div class="admin-detail-value">${escapeHtml(value ?? '—')}</div></div>`).join('')}
      </div>
      ${days.length ? days.map((day) => `
        <section class="admin-detail-section">
          <h3>Day ${escapeHtml(day.dayNumber)} · ${escapeHtml(formatDateOnly(day.date))}</h3>
          ${day.title ? `<p>${escapeHtml(day.title)}</p>` : ''}
          ${day.activities?.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Activity</th><th>Location</th><th>Type</th><th>Time</th><th>Est. cost</th></tr></thead><tbody>
            ${day.activities.map((activity) => `<tr>
              <td>${escapeHtml(activity.title)}</td>
              <td>${escapeHtml(activity.location)}</td>
              <td>${escapeHtml(activity.type)}</td>
              <td>${escapeHtml(activity.startTime)}${activity.endTime ? ` – ${escapeHtml(activity.endTime)}` : ''}</td>
              <td>${escapeHtml(activity.estimatedCost ?? '—')}</td>
            </tr>`).join('')}
          </tbody></table></div>` : '<div class="empty-state">No activities planned for this day.</div>'}
        </section>
      `).join('') : '<div class="admin-detail-section empty-state">No day-by-day plans have been added yet.</div>'}
    `;
  }

  async function loadItineraryDetails(tripId) {
    const panel = document.getElementById('itinerary-detail-panel');
    const target = document.getElementById('itinerary-detail-content');
    if (!panel || !target) return;
    selectedItineraryTripId = String(tripId);
    panel.hidden = false;
    target.innerHTML = '<div class="empty-state">Loading travel plan…</div>';
    try {
      const payload = await request(`/api/admin/itineraries/${encodeURIComponent(tripId)}`);
      renderItineraryDetails(payload?.itinerary || {});
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      target.innerHTML = '<div class="empty-state">We couldn’t load this travel plan. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  // ---- Reports (per-user usage) ---------------------------------------------

  const reportTableState = { page: 1, total: 0, limit: 25 };
  let reportLastActiveTrackingAvailable = false;
  let selectedReportUser = null;
  const USER_REPORT_RANGE_KEY = 'admin.userReportRangeDays';
  let userReportRangeDays = readStoredRange(USER_REPORT_RANGE_KEY, [30, 90], 90);
  const USER_REPORT_CHART_IDS = ['user-report-chart', 'user-chat-chart'];

  function notTracked(label = 'Not tracked') {
    return `<span class="not-tracked">${escapeHtml(label)}</span>`;
  }

  function lastActivityText(value, trackingAvailable) {
    if (!trackingAvailable) return null;
    return value ? formatDate(value) : 'No activity recorded';
  }

  async function loadReportTable(page = reportTableState.page) {
    const tableBody = document.getElementById('report-table-body');
    if (!tableBody) return;
    tableBody.innerHTML = '<tr><td colspan="10" class="empty-state">Loading user reports…</td></tr>';
    try {
      const search = document.getElementById('report-search')?.value.trim() || '';
      const status = document.getElementById('report-status-filter')?.value || 'all';
      const sortSelect = document.getElementById('report-sort');
      const sort = sortSelect?.value || 'newest';
      const params = new URLSearchParams({ page: String(page), limit: String(reportTableState.limit), search, status, sort });
      const payload = await request(`/api/admin/users?${params}`);
      reportLastActiveTrackingAvailable = Boolean(payload?.lastActiveTrackingAvailable);
      const usageTracked = Boolean(payload?.usageTrackingAvailable);
      if (sortSelect && Array.isArray(payload?.availableSorts)) {
        Array.from(sortSelect.options).forEach((option) => {
          option.disabled = !payload.availableSorts.includes(option.value);
          if (option.disabled && !/\(not tracked\)$/.test(option.textContent)) option.textContent += ' (not tracked)';
        });
      }
      reportTableState.page = payload?.page || page;
      reportTableState.total = payload?.total || 0;
      const users = payload?.users || [];
      tableBody.innerHTML = users.length
        ? users.map((user) => {
          const lastActivity = lastActivityText(user.lastActiveAt, reportLastActiveTrackingAvailable);
          const isSelected = selectedReportUser && String(selectedReportUser) === String(user.userId);
          return `
            <tr${isSelected ? ' class="is-selected"' : ''}>
              <td>
                <div class="cell-primary">${escapeHtml(user.name || 'Unnamed user')}</div>
                <div class="cell-secondary">${escapeHtml(user.email || '—')}</div>
              </td>
              <td><span class="badge ${user.isVerified ? 'success' : 'warning'}">${user.isVerified ? 'Verified' : 'Unverified'}</span>${user.isActive ? '' : ' <span class="badge neutral">Disabled</span>'}</td>
              <td>${escapeHtml(formatDate(user.createdAt))}</td>
              <td>${lastActivity === null ? notTracked() : escapeHtml(lastActivity)}</td>
              <td>${!usageTracked ? notTracked() : user.lastSignInAt ? escapeHtml(formatDate(user.lastSignInAt)) : '<span class="cell-secondary">None recorded</span>'}</td>
              <td class="numeric">${usageTracked ? `<strong>${escapeHtml(formatNumber(user.signInCount))}</strong>` : notTracked()}</td>
              <td class="numeric">${usageTracked ? `<strong>${escapeHtml(formatNumber(user.chatMessageCount))}</strong>` : notTracked()}</td>
              <td class="numeric"><strong>${escapeHtml(formatNumber(user.savedItineraryCount))}</strong></td>
              <td>${user.lastItinerarySavedAt ? escapeHtml(formatDate(user.lastItinerarySavedAt)) : '<span class="cell-secondary">None saved</span>'}</td>
              <td><button class="admin-button-secondary" type="button" data-report-user="${Number(user.userId)}">View report</button></td>
            </tr>
          `;
        }).join('')
        : '<tr><td colspan="10" class="empty-state">No users match these filters. Try a different search or reset the filters.</td></tr>';
      updatePagination('report-page-summary', 'report-page-previous', 'report-page-next', reportTableState);
    } catch (error) {
      tableBody.innerHTML = '<tr><td colspan="10" class="empty-state">We couldn’t load user reports. Try again.</td></tr>';
      setStatus(getReadableError(error), 'error');
    }
  }

  function resetReportFilters() {
    const search = document.getElementById('report-search');
    const status = document.getElementById('report-status-filter');
    const sort = document.getElementById('report-sort');
    if (search) search.value = '';
    if (status) status.value = 'all';
    if (sort) sort.value = 'newest';
    void loadReportTable(1);
  }

  function selectReportTab(name, { focus = false } = {}) {
    document.querySelectorAll('[data-report-tab]').forEach((tab) => {
      const isActive = tab.dataset.reportTab === name;
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
      if (isActive && focus) tab.focus();
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !isActive;
    });
    // Charts measure their container, so draw them once their tab is visible.
    if (name === 'summary') {
      for (const id of USER_REPORT_CHART_IDS) {
        const chart = chartRegistry.get(id);
        if (chart) renderLineChart(id, chart.data, chart.options);
      }
    }
  }

  function renderUserReportChart(user) {
    const itineraries = user.itineraries || [];
    const days = userReportRangeDays;
    const today = toUtcDateKey(new Date());
    const rangeStart = toUtcDateKey(new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS));
    const counts = new Map();
    for (const itinerary of itineraries) {
      const key = toUtcDateKey(itinerary.createdAt);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const series = buildDailySeries(counts, rangeStart, today);
    const inRange = series.reduce((sum, point) => sum + point.value, 0);
    const totalNode = document.getElementById('user-report-chart-total');
    if (totalNode) totalNode.innerHTML = `<strong>${escapeHtml(formatNumber(inRange))}</strong><span>in the last ${escapeHtml(days)} days</span>`;
    document.querySelectorAll('[data-user-range]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.userRange) === days));
    });
    renderLineChart('user-report-chart', series, {
      label: 'Itineraries saved by this user per day', unit: 'itineraries saved', unitSingular: 'itinerary saved',
      color: CHART_COLORS.itineraries, height: 220,
      emptyText: `This user hasn’t saved any itineraries that still exist from the last ${days} days.`,
    });

    // Chatbot messages per day, from the backend's 90-day daily usage counts.
    const chatTotalNode = document.getElementById('user-chat-chart-total');
    if (!user.usageTrackingAvailable || !Array.isArray(user.usageByDay)) {
      chartRegistry.delete('user-chat-chart');
      if (chatTotalNode) chatTotalNode.innerHTML = '<span class="badge neutral">Not tracked yet</span>';
      const target = document.getElementById('user-chat-chart');
      if (target) target.innerHTML = '<div class="untracked-state"><p>Chatbot usage isn’t being recorded yet. Run backend/migrations/003_app_usage_events.sql in SSMS, then restart the backend.</p></div>';
      return;
    }
    const chatCounts = new Map(user.usageByDay.map((day) => [day.date, Number(day.chatMessages || 0)]));
    const chatSeries = buildDailySeries(chatCounts, rangeStart, today);
    const chatInRange = chatSeries.reduce((sum, point) => sum + point.value, 0);
    if (chatTotalNode) chatTotalNode.innerHTML = `<strong>${escapeHtml(formatNumber(chatInRange))}</strong><span>in the last ${escapeHtml(days)} days</span>`;
    renderLineChart('user-chat-chart', chatSeries, {
      label: 'Chatbot messages sent by this user per day', unit: 'chatbot messages', unitSingular: 'chatbot message',
      color: CHART_COLORS.chat, height: 220,
      emptyText: `This user hasn’t sent any chatbot messages in the last ${days} days.`,
    });
  }

  function renderReportDetails(user) {
    const title = document.getElementById('report-detail-title');
    const subtitle = document.getElementById('report-detail-subtitle');
    const summaryPanel = document.getElementById('report-panel-summary');
    const itineraryPanel = document.getElementById('report-panel-itineraries');
    const preferencePanel = document.getElementById('report-panel-preferences');
    if (!summaryPanel || !itineraryPanel || !preferencePanel) return;
    const itineraries = user.itineraries || [];
    const savedCount = Number(user.tripCount || 0);
    const lastActivity = lastActivityText(user.lastActiveAt, user.lastActiveTrackingAvailable);

    if (title) title.textContent = user.name || 'Unnamed user';
    if (subtitle) subtitle.textContent = `${user.email || 'No email'} · Registered ${formatDate(user.createdAt)}`;

    const usageTracked = Boolean(user.usageTrackingAvailable) && user.chatMessageCount != null;
    const tiles = [
      ['Saved itineraries', escapeHtml(formatNumber(savedCount)), 'Currently stored in this account'],
      ['Chatbot messages', usageTracked ? escapeHtml(formatNumber(user.chatMessageCount)) : notTracked(),
        usageTracked ? (user.lastChatMessageAt ? `Last message ${formatDate(user.lastChatMessageAt)}` : 'No messages recorded') : 'Usage tracking isn’t set up'],
      ['Sign-ins', usageTracked ? escapeHtml(formatNumber(user.signInCount)) : notTracked(),
        usageTracked ? (user.lastSignInAt ? `Last sign-in ${formatDate(user.lastSignInAt)}` : 'No sign-ins recorded') : 'Usage tracking isn’t set up'],
      ['Last app activity', lastActivity === null ? notTracked() : escapeHtml(lastActivity), 'Latest sign-in or app check-in'],
      ['Latest itinerary saved', escapeHtml(itineraries[0] ? formatDate(itineraries[0].createdAt) : 'None saved'), ''],
      ['Verification', `<span class="badge ${user.isVerified ? 'success' : 'warning'}">${user.isVerified ? 'Verified' : 'Unverified'}</span>`, ''],
      ['Account status', `<span class="badge ${user.isActive ? 'success' : 'neutral'}">${user.isActive ? 'Enabled' : 'Disabled'}</span>`, ''],
    ];
    summaryPanel.innerHTML = `
      <div class="report-tiles">
        ${tiles.map(([label, valueHtml, note]) => `
          <div class="report-tile">
            <span class="stat-label">${escapeHtml(label)}</span>
            <div class="report-tile-value">${valueHtml}</div>
            ${note ? `<p class="cell-secondary">${escapeHtml(note)}</p>` : ''}
          </div>
        `).join('')}
      </div>
      <article class="chart-card report-chart-card">
        <header class="chart-card-header">
          <div>
            <h3>Itineraries saved over time</h3>
            <p class="chart-caption">Per day, by the date each itinerary was saved.</p>
          </div>
          <div class="chart-header-side">
            <div class="range-picker" role="group" aria-label="Date range for this user's graph">
              <button type="button" class="range-option" data-user-range="30" aria-pressed="false">30 days</button>
              <button type="button" class="range-option" data-user-range="90" aria-pressed="false">90 days</button>
            </div>
            <div class="chart-total" id="user-report-chart-total"></div>
          </div>
        </header>
        <div id="user-report-chart" class="line-chart" role="img" aria-label="Itineraries saved by this user per day"></div>
        ${savedCount > itineraries.length ? `<p class="chart-footnote">Only the ${escapeHtml(formatNumber(itineraries.length))} most recent itineraries are included.</p>` : ''}
      </article>
      <article class="chart-card report-chart-card">
        <header class="chart-card-header">
          <div>
            <h3>Chatbot messages over time</h3>
            <p class="chart-caption">Messages this user sent to the chatbot per day. Uses the same date range.</p>
          </div>
          <div class="chart-total" id="user-chat-chart-total"></div>
        </header>
        <div id="user-chat-chart" class="line-chart" role="img" aria-label="Chatbot messages sent by this user per day"></div>
        <p class="chart-footnote">Counted from the day usage tracking was set up. Message text is never stored.</p>
      </article>
    `;

    itineraryPanel.innerHTML = itineraries.length ? `
      <p class="admin-subtitle report-note">Itineraries currently saved in this account, newest first. Plans removed after the trip ended or deleted by the user aren’t listed.</p>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Itinerary</th>
              <th scope="col">Destination</th>
              <th scope="col">Travel dates</th>
              <th scope="col">Budget</th>
              <th scope="col" class="numeric">Days</th>
              <th scope="col" class="numeric">Activities</th>
              <th scope="col">Saved</th>
            </tr>
          </thead>
          <tbody>
            ${itineraries.map((itinerary) => `
              <tr>
                <td class="cell-primary">${escapeHtml(itinerary.title || 'Untitled itinerary')}</td>
                <td>${escapeHtml(itinerary.destination || '—')}</td>
                <td>${escapeHtml(`${formatDateOnly(itinerary.startDate)} – ${formatDateOnly(itinerary.endDate)}`)}</td>
                <td>${escapeHtml(itinerary.budget || '—')}</td>
                <td class="numeric">${escapeHtml(formatNumber(itinerary.dayCount))}</td>
                <td class="numeric">${escapeHtml(formatNumber(itinerary.activityCount))}</td>
                <td>${escapeHtml(formatDate(itinerary.createdAt))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<div class="empty-state">This user has no saved itineraries right now.</div>';

    const preferenceList = (label, values) => `
      <section class="admin-detail-section">
        <h3>${escapeHtml(label)}</h3>
        <div class="badge-list">${values.length ? values.map((value) => `<span class="badge neutral">${escapeHtml(value)}</span>`).join('') : '<span class="cell-secondary">None saved</span>'}</div>
      </section>
    `;
    preferencePanel.innerHTML = `
      <p class="admin-subtitle report-note">Chosen during onboarding or in profile settings. Profile last updated ${escapeHtml(formatDate(user.updatedAt))}.</p>
      ${preferenceList('Travel styles', user.travelStyles || [])}
      ${preferenceList('Interests', user.interests || [])}
      ${preferenceList('Preferred destinations', user.preferredPlaces || [])}
    `;

    selectReportTab('summary');
    renderUserReportChart(user);
  }

  async function loadReportDetails(userId) {
    const panel = document.getElementById('report-detail-panel');
    const summaryPanel = document.getElementById('report-panel-summary');
    if (!panel || !summaryPanel) return;
    selectedReportUser = String(userId);
    document.querySelectorAll('#report-table-body tr').forEach((row) => {
      row.classList.toggle('is-selected', Boolean(row.querySelector(`[data-report-user="${Number(userId)}"]`)));
    });
    panel.hidden = false;
    selectReportTab('summary');
    USER_REPORT_CHART_IDS.forEach((id) => chartRegistry.delete(id));
    summaryPanel.innerHTML = '<div class="empty-state">Loading user report…</div>';
    document.getElementById('report-panel-itineraries').innerHTML = '';
    document.getElementById('report-panel-preferences').innerHTML = '';
    try {
      const payload = await request(`/api/admin/users/${encodeURIComponent(userId)}`);
      if (selectedReportUser !== String(userId)) return;
      panel.currentUser = payload?.user || {};
      renderReportDetails(panel.currentUser);
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      summaryPanel.innerHTML = '<div class="empty-state">We couldn’t load this user’s report. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  function closeReportDetails() {
    const panel = document.getElementById('report-detail-panel');
    if (panel) panel.hidden = true;
    selectedReportUser = null;
    USER_REPORT_CHART_IDS.forEach((id) => chartRegistry.delete(id));
    hideChartTooltip();
    document.querySelectorAll('#report-table-body tr.is-selected').forEach((row) => row.classList.remove('is-selected'));
  }

  function initReports() {
    document.getElementById('report-filters')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void loadReportTable(1);
    });
    document.getElementById('report-status-filter')?.addEventListener('change', () => loadReportTable(1));
    document.getElementById('report-sort')?.addEventListener('change', () => loadReportTable(1));
    document.getElementById('report-reset')?.addEventListener('click', resetReportFilters);
    document.getElementById('report-page-previous')?.addEventListener('click', () => loadReportTable(reportTableState.page - 1));
    document.getElementById('report-page-next')?.addEventListener('click', () => loadReportTable(reportTableState.page + 1));
    document.getElementById('report-table-body')?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-report-user]');
      if (button) void loadReportDetails(button.dataset.reportUser);
    });
    document.getElementById('report-detail-close')?.addEventListener('click', closeReportDetails);
    const tabList = document.querySelector('.report-tabs');
    tabList?.addEventListener('click', (event) => {
      const tab = event.target.closest?.('[data-report-tab]');
      if (tab) selectReportTab(tab.dataset.reportTab);
    });
    tabList?.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = Array.from(tabList.querySelectorAll('[data-report-tab]'));
      const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      selectReportTab(tabs[next].dataset.reportTab, { focus: true });
    });
    document.getElementById('report-panel-summary')?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-user-range]');
      const panel = document.getElementById('report-detail-panel');
      if (!button || !panel?.currentUser) return;
      userReportRangeDays = Number(button.dataset.userRange);
      storeRange(USER_REPORT_RANGE_KEY, userReportRangeDays);
      renderUserReportChart(panel.currentUser);
    });
    void loadReportTable(1);
  }

  async function loadIntegrations() {
    const target = document.getElementById('integration-grid');
    if (!target) return;
    target.innerHTML = '<div class="admin-card empty-state">Checking Sidekick connections…</div>';
    try {
      const payload = await request('/api/admin/integrations');
      const items = [
        ['Data storage', payload?.database?.connected ? 'Connected' : 'Unavailable', payload?.database?.connected ? 'success' : 'warning'],
        ['AI assistant', payload?.ai?.configured ? 'Ready' : 'Needs setup', payload?.ai?.configured ? 'success' : 'warning'],
        ['Maps', payload?.maps?.configured ? 'Ready' : 'Needs setup', payload?.maps?.configured ? 'success' : 'warning'],
        ['App environment', payload?.mode === 'production' ? 'Production' : payload?.mode === 'development' ? 'Development' : 'Not available', 'neutral'],
      ];
      target.innerHTML = items.map(([label, value, status]) => `
        <div class="admin-card">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-value" style="font-size:1.25rem; margin-top:10px;">${escapeHtml(value)}</div>
          <div class="stat-detail"><span class="badge ${status}">${status === 'success' ? 'Ready' : status === 'warning' ? 'Needs setup' : 'Not available'}</span></div>
        </div>
      `).join('');
    } catch (error) {
      target.innerHTML = '<div class="admin-card empty-state">We couldn’t load connection details. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  async function loadSettings() {
    const target = document.getElementById('settings-summary');
    if (!target) return;
    target.innerHTML = '<div class="admin-card empty-state">Loading app setup…</div>';
    try {
      const payload = await request('/api/admin/settings');
      const settings = [
        ['App environment', payload?.appMode === 'production' ? 'Production' : payload?.appMode === 'development' ? 'Development' : 'Not available'],
        ['Maintenance', payload?.maintenanceMode ? 'On' : 'Off'],
        ['AI assistant', payload?.geminiConfigured ? 'Ready' : 'Needs setup'],
        ['Maps', payload?.googleMapsConfigured ? 'Ready' : 'Needs setup'],
        ['Admin sign-in', payload?.adminConfigured ? 'Ready' : 'Not set up'],
        ['Admin sign-in history', payload?.adminAuditLoggingAvailable ? 'Available' : 'Not set up'],
      ];
      target.innerHTML = settings.map(([label, value]) => `
        <div class="admin-card">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-value" style="font-size:1.2rem; margin-top:12px;">${escapeHtml(value)}</div>
        </div>
      `).join('');
    } catch (error) {
      target.innerHTML = '<div class="admin-card empty-state">We couldn’t load app setup. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);

    const logoutButton = document.querySelector('[data-admin-logout]');
    if (logoutButton) {
      logoutButton.addEventListener('click', logout);
    }

    const loginForm = document.getElementById('admin-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const username = document.getElementById('admin-username')?.value || '';
        const password = document.getElementById('admin-password')?.value || '';
        const submitButton = document.getElementById('admin-login-submit');
        if (submitButton) submitButton.disabled = true;
        try {
          const payload = await fetch(`${getApiBaseUrl()}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
          });
          const data = await payload.json().catch(() => ({}));
          if (!payload.ok) throw new Error(data?.error || 'Admin login failed.');
          sessionStorage.setItem(ADMIN_TOKEN_KEY, data.token);
          window.location.href = 'admin.html';
        } catch (error) {
          setStatus(getLoginErrorMessage(error), 'error');
        } finally {
          if (submitButton) submitButton.disabled = false;
        }
      });
      return;
    }

    const currentPage = document.body.dataset.page;
    if (!ensureAdminSession()) return;

    const userSearchButton = document.getElementById('user-search-submit');
    const userSearchInput = document.getElementById('user-search');
    const userStatusFilter = document.getElementById('user-status-filter');
    if (userSearchButton) userSearchButton.addEventListener('click', () => loadUserTable(1));
    if (userSearchInput) userSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadUserTable(1);
    });
    if (userStatusFilter) userStatusFilter.addEventListener('change', () => loadUserTable(1));
    document.getElementById('user-page-previous')?.addEventListener('click', () => loadUserTable(userTableState.page - 1));
    document.getElementById('user-page-next')?.addEventListener('click', () => loadUserTable(userTableState.page + 1));
    document.getElementById('user-table-body')?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-user-detail]');
      if (button) loadUserDetails(button.dataset.userDetail);
    });
    document.getElementById('user-detail-content')?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-delete-user]');
      if (button && !button.disabled) {
        void deleteUserPermanently(button.dataset.deleteUser, button.dataset.userEmail);
      }
    });
    document.getElementById('user-detail-close')?.addEventListener('click', () => {
      document.getElementById('user-detail-panel').hidden = true;
    });

    const itinerarySearchButton = document.getElementById('itinerary-search-submit');
    const itinerarySearchInput = document.getElementById('itinerary-search');
    if (itinerarySearchButton) itinerarySearchButton.addEventListener('click', () => loadItineraryTable(1));
    if (itinerarySearchInput) itinerarySearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadItineraryTable(1);
    });
    document.getElementById('itinerary-page-previous')?.addEventListener('click', () => loadItineraryTable(itineraryTableState.page - 1));
    document.getElementById('itinerary-page-next')?.addEventListener('click', () => loadItineraryTable(itineraryTableState.page + 1));
    document.getElementById('itinerary-table-body')?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-itinerary-detail]');
      if (button) void loadItineraryDetails(button.dataset.itineraryDetail);
    });
    document.getElementById('itinerary-detail-close')?.addEventListener('click', () => {
      document.getElementById('itinerary-detail-panel').hidden = true;
      selectedItineraryTripId = null;
    });
    initBarTooltips();
    if (currentPage === 'dashboard') {
      void loadPlanInsights('plan', 5);
      document.querySelectorAll('[data-range]').forEach((button) => {
        button.addEventListener('click', () => {
          const days = Number(button.dataset.range);
          if (days === dashboardRangeDays) return;
          dashboardRangeDays = days;
          storeRange(DASHBOARD_RANGE_KEY, days);
          void loadDashboard();
        });
      });
      loadDashboard();
    }
    if (currentPage === 'activity') {
      loadActivityFeed();
    }
    if (currentPage === 'users') {
      loadUserTable();
      void loadPlanInsights('picks', 10);
    }
    if (currentPage === 'reviews') {
      loadAppReviews();
      document.getElementById('app-reviews-page-previous')?.addEventListener('click', () => loadAppReviews(appReviewTableState.page - 1));
      document.getElementById('app-reviews-page-next')?.addEventListener('click', () => loadAppReviews(appReviewTableState.page + 1));
    }
    if (currentPage === 'itineraries') {
      loadItineraryTable();
    }
    if (currentPage === 'analytics') {
      initReports();
    }
    if (currentPage === 'integrations') {
      loadIntegrations();
    }
    if (currentPage === 'settings') {
      loadSettings();
    }

    if (document.getElementById('admin-status-banner')) {
      setStatus('You’re connected. Some reports may be unavailable if Sidekick doesn’t collect that information.', 'info');
    }
    if (currentPage === 'dashboard' || currentPage === 'users' || currentPage === 'itineraries') {
      window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (currentPage === 'dashboard') {
          loadDashboard({ silent: true });
          void loadPlanInsights('plan', 5, { silent: true });
        }
        if (currentPage === 'users') loadUserTable(userTableState.page);
        if (currentPage === 'itineraries') {
          loadItineraryTable(itineraryTableState.page);
          if (selectedItineraryTripId) void loadItineraryDetails(selectedItineraryTripId);
        }
      }, 30_000);
    }
  });
})();
