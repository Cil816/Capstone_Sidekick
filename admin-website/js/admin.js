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
    // Colours come from the stylesheet (is-error / is-info), so dark mode can restyle them.
    node.classList.toggle('is-error', kind === 'error');
    node.classList.toggle('is-info', kind !== 'error');
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

  // Compact overview tile: icon, label, big number, one short line.
  function renderKpis(target, tiles) {
    target.innerHTML = tiles.map((tile) => `
      <article class="ax-kpi${tile.live ? ' is-live' : ''}" title="${escapeHtml(tile.help || '')}">
        <span class="ax-kpi-icon">${icon(tile.icon)}</span>
        <div class="ax-kpi-body">
          <span class="ax-kpi-label">${escapeHtml(tile.label)}</span>
          <span class="ax-kpi-value">${tile.live && tile.value !== '—' ? '<span class="ax-live-dot" aria-hidden="true"></span>' : ''}${escapeHtml(tile.value)}</span>
          <span class="ax-kpi-sub">${escapeHtml(tile.sub || '')}</span>
        </div>
      </article>`).join('');
  }

  // Five numbers an admin checks first. Verified/enabled counts were dropped:
  // every user must verify their email to use the app.
  function renderDashboardSummary(summary) {
    const target = document.getElementById('dashboard-summary');
    if (!target) return;
    const metrics = summary?.metrics || {};
    const recentlyActiveTracked = summary?.lastActiveTrackingAvailable && metrics.recentlyActiveUsers30Days != null;
    const usageTracked = Boolean(summary?.usageTracking?.available) && metrics.totalChatMessages != null;
    const plural = (n, one, many) => `${formatNumber(n)} ${Number(n) === 1 ? one : many}`;
    renderKpis(target, [
      {
        icon: 'users', label: 'Users', value: formatNumber(metrics.totalUsers),
        sub: recentlyActiveTracked ? `${formatNumber(metrics.recentlyActiveUsers30Days)} active in 30 days` : 'Registered accounts',
        help: 'Every Sidekick account.',
      },
      {
        icon: 'online', label: 'Online now', value: formatNumber(metrics.onlineUsers), live: true,
        sub: 'App open in the last 90 s',
        help: 'Users with the app open in the past 90 seconds.',
      },
      {
        icon: 'signin', label: 'Sign-ins', value: usageTracked ? formatNumber(metrics.signInsLast30Days) : '—',
        sub: usageTracked ? 'Last 30 days' : 'Not tracked yet',
        help: usageTracked ? `${formatNumber(metrics.totalSignIns)} in total. ${describeTrackingStart(summary?.usageTracking?.firstEventAt)}` : 'Run backend/migrations/003_app_usage_events.sql to start recording.',
      },
      {
        icon: 'chat', label: 'Chatbot messages', value: usageTracked ? formatNumber(metrics.chatMessagesLast30Days) : '—',
        sub: usageTracked ? `Last 30 days · ${plural(metrics.chatUsersLast30Days, 'user', 'users')}` : 'Not tracked yet',
        help: usageTracked ? `${formatNumber(metrics.totalChatMessages)} in total.` : 'Run backend/migrations/003_app_usage_events.sql to start recording.',
      },
      {
        icon: 'compass', label: 'Saved itineraries', value: formatNumber(metrics.totalTrips),
        sub: `${formatNumber(metrics.tripsLast30Days)} in the last 30 days`,
        help: 'Itineraries currently stored in user accounts.',
      },
    ]);
  }

  // Simple ranked list with bars (used for interests, styles, budgets).
  function rankList(items, { denominator, unit, emptyText, limit = 5 }) {
    const list = (items || []).slice(0, limit);
    if (!list.length) return `<div class="ax-empty">${escapeHtml(emptyText)}</div>`;
    const max = Math.max(1, ...list.map((item) => item.count));
    return `<ol class="ax-rank">${list.map((item) => {
      const share = denominator ? Math.round((item.count / denominator) * 100) : null;
      return `<li>
        <div class="ax-rank-row"><span class="ax-rank-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><span class="ax-rank-count">${share !== null ? `${escapeHtml(share)}%` : `${escapeHtml(formatNumber(item.count))} ${escapeHtml(item.count === 1 ? unit[0] : unit[1])}`}</span></div>
        <div class="ax-rank-bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round((item.count / max) * 100))}%"></span></div>
      </li>`;
    }).join('')}</ol>`;
  }

  // Dashboard: top 5 interests. Reports: the full audience breakdown.
  function renderUserBaseSummary(profileSummary, summary) {
    const usersWithPreferences = Number(profileSummary?.usersWithPreferences || 0);
    const totalUsers = Number(summary?.metrics?.totalUsers);
    const userUnit = ['user', 'users'];
    const dashboardTarget = document.getElementById('user-base-summary');
    if (dashboardTarget) {
      dashboardTarget.innerHTML = rankList(profileSummary?.interests, { denominator: usersWithPreferences, unit: userUnit, emptyText: 'No interests saved yet.' });
    }
    const coverage = document.getElementById('user-base-coverage');
    if (coverage) {
      coverage.textContent = Number.isFinite(totalUsers)
        ? `Based on the ${formatNumber(usersWithPreferences)} of ${formatNumber(totalUsers)} users who saved preferences at onboarding.`
        : `Based on the ${formatNumber(usersWithPreferences)} users who saved preferences at onboarding.`;
    }
    const reportTarget = document.getElementById('report-audience');
    if (reportTarget) {
      const block = (title, note, body) => `<article class="admin-card"><div class="ax-card-head"><div><h3 class="ax-card-title">${escapeHtml(title)}</h3><p class="ax-card-note">${escapeHtml(note)}</p></div></div>${body}</article>`;
      reportTarget.innerHTML = [
        block('Travel interests', 'Share of users', rankList(profileSummary?.interests, { denominator: usersWithPreferences, unit: userUnit, emptyText: 'No interests saved yet.', limit: 8 })),
        block('Travel styles', 'Share of users', rankList(profileSummary?.travelStyles, { denominator: usersWithPreferences, unit: userUnit, emptyText: 'No travel styles saved yet.', limit: 8 })),
        block('Trip budgets', 'On saved itineraries', rankList(profileSummary?.savedItineraryBudgets, { denominator: null, unit: ['itinerary', 'itineraries'], emptyText: 'No budgets recorded yet.', limit: 8 })),
      ].join('');
    }
  }

  const FEED_ICONS = {
    signup: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    trip: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    sign_in: '<path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5"/><path d="M15 12H4"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  };

  function relativeTime(value) {
    const date = new Date(value);
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff)) return '';
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days < 7 ? `${days} d ago` : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Merges the activity lists into one feed item list, newest first.
  function activityItems(activities) {
    const kindOf = (item, fallback) => item.kind || fallback;
    return [
      ...(activities?.recentUsers || []).map((item) => ({ ...item, kind: kindOf(item, 'signup') })),
      ...(activities?.recentTrips || []).map((item) => ({ ...item, kind: kindOf(item, 'trip') })),
      ...(activities?.recentUsage || []).map((item) => ({ ...item, kind: kindOf(item, /sign/i.test(item.label) ? 'sign_in' : 'chat') })),
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  function feedText(item) {
    const who = item.name ? `<b>${escapeHtml(item.name)}</b>` : 'A user';
    if (item.kind === 'signup') return `${who} created an account`;
    if (item.kind === 'trip') return `${who} saved an itinerary${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}`;
    if (item.kind === 'sign_in') return `${who} signed in`;
    if (item.kind === 'chat') return `${who} chatted with Sidekick${item.count > 1 ? `<small>${escapeHtml(formatNumber(item.count))} messages that day</small>` : ''}`;
    return escapeHtml(item.label || 'Activity');
  }

  function renderFeed(list, items, emptyText) {
    list.innerHTML = items.length
      ? items.map((item, index) => `
          <li style="animation-delay:${Math.min(index, 8) * 30}ms">
            <span class="ax-feed-icon k-${escapeHtml(item.kind)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FEED_ICONS[item.kind] || FEED_ICONS.trip}</svg></span>
            <span class="ax-feed-text">${feedText(item)}</span>
            <time class="ax-feed-time" datetime="${escapeHtml(item.timestamp)}" title="${escapeHtml(formatDate(item.timestamp))}">${escapeHtml(relativeTime(item.timestamp))}</time>
          </li>`).join('')
      : `<li class="ax-empty" style="display:block">${escapeHtml(emptyText)}</li>`;
  }

  function renderRecentActivity(activityList, activities, limit = 7) {
    renderFeed(activityList, activityItems(activities).slice(0, limit), 'Nothing yet. New sign-ups and saved itineraries will appear here.');
  }

  // ---- What users plan (activities, restaurants, hotels, destinations) -------

  // Ranked horizontal bars. items: [{ name, users, picks }]. Bar length = users.
  function renderBarChart(targetId, items, { emptyText, label }) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!items.length) {
      target.innerHTML = `<div class="ax-empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    const max = Math.max(1, ...items.map((item) => item.users));
    // Name on its own line with the bar underneath, so names fit narrow cards.
    target.innerHTML = `
      <ol class="ax-rank" aria-label="${escapeHtml(label)}">
        ${items.map((item, index) => {
          const users = `${formatNumber(item.users)} ${item.users === 1 ? 'user' : 'users'}`;
          const picks = `${formatNumber(item.picks)} ${item.picks === 1 ? 'pick' : 'picks'}`;
          return `
            <li class="ax-tip" tabindex="0" data-tip-name="${escapeHtml(item.name)}" data-tip-detail="${escapeHtml(`${users} · ${picks}`)}">
              <div class="ax-rank-row"><span class="ax-rank-pos" aria-hidden="true">${index + 1}</span><span class="ax-rank-name">${escapeHtml(item.name)}</span><span class="ax-rank-count">${escapeHtml(users)}</span></div>
              <div class="ax-rank-bar" aria-hidden="true"><span style="width:${Math.max(4, (item.users / max) * 100).toFixed(1)}%"></span></div>
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
      const row = event.target.closest?.('.ax-tip, .hbar-row');
      if (row) show(row, event.clientX, event.clientY);
    });
    document.addEventListener('pointerout', (event) => {
      if (event.target.closest?.('.ax-tip, .hbar-row') && !event.relatedTarget?.closest?.('.ax-tip, .hbar-row')) hideChartTooltip();
    });
    document.addEventListener('focusin', (event) => {
      const row = event.target.closest?.('.ax-tip, .hbar-row');
      if (row) show(row);
    });
    document.addEventListener('focusout', (event) => {
      if (event.target.closest?.('.ax-tip, .hbar-row')) hideChartTooltip();
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
      target.innerHTML = '<div class="ax-empty" style="grid-column:1/-1">No saved itineraries yet.</div>';
      return;
    }
    const facts = [
      ['Days', formatMedian(medians.daysPerItinerary)],
      ['Activities', formatMedian(medians.activitiesPerItinerary)],
      ['Restaurants', formatMedian(medians.restaurantsPerItinerary)],
      ['Hotels', formatMedian(medians.hotelsPerItinerary)],
    ];
    target.innerHTML = facts.map(([label, value]) => `<div class="ax-fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')
      + `<p class="ax-card-note" style="grid-column:1/-1;margin-top:2px">Across ${escapeHtml(formatNumber(totals.savedItineraries))} saved ${totals.savedItineraries === 1 ? 'itinerary' : 'itineraries'}.</p>`;
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
      if (medians && prefix === 'plan') medians.innerHTML = '<div class="ax-empty" style="grid-column:1/-1">Loading…</div>';
    }
    try {
      const insights = await request(`/api/admin/insights?limit=${encodeURIComponent(limit)}`);
      if (prefix === 'plan') renderPlanMedians(insights);
      present.forEach((chart) => renderBarChart(ids[chart.key], insights?.[chart.key] || [], { emptyText: chart.empty, label: chart.label }));
    } catch (error) {
      present.forEach((chart) => { document.getElementById(ids[chart.key]).innerHTML = '<div class="empty-state">We couldn’t load this list. Try again.</div>'; });
      const medians = document.getElementById('plan-medians');
      if (medians && prefix === 'plan') medians.innerHTML = '<div class="ax-empty" style="grid-column:1/-1">We couldn’t load this. Try again.</div>';
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

  const DASHBOARD_SERIES = [
    { key: 'registrations', tab: 'New users', trend: 'registrationTrend', label: 'New registrations per day', unit: 'new accounts', unitSingular: 'new account', color: CHART_COLORS.registrations, emptyText: 'No new accounts in this period.', foot: 'Unverified accounts are removed after 24 hours, so they only appear briefly.' },
    { key: 'itineraries', tab: 'Itineraries', trend: 'itineraryTrend', label: 'Itineraries saved per day', unit: 'itineraries saved', unitSingular: 'itinerary saved', color: CHART_COLORS.itineraries, emptyText: 'No itineraries were saved in this period.', foot: 'Counts saved itineraries that still exist (trips are removed after they end).' },
    { key: 'signins', tab: 'Sign-ins', trend: 'signInTrend', usage: true, label: 'User sign-ins per day', unit: 'sign-ins', unitSingular: 'sign-in', color: CHART_COLORS.signIns, emptyText: 'No sign-ins in this period.', foot: 'Email-and-password sign-ins.' },
    { key: 'chat', tab: 'Chatbot', trend: 'chatTrend', usage: true, label: 'Chatbot messages per day', unit: 'chatbot messages', unitSingular: 'chatbot message', color: CHART_COLORS.chat, emptyText: 'No chatbot messages in this period.', foot: 'Messages users sent to Sidekick. Message text is never stored.' },
  ];
  const CHART_TAB_KEY = 'admin.dashboardChartTab';
  let dashboardChartTab = (() => { try { return localStorage.getItem(CHART_TAB_KEY) || 'registrations'; } catch (error) { return 'registrations'; } })();
  let lastDashboardAnalytics = null;

  function renderDashboardCharts(analytics) {
    lastDashboardAnalytics = analytics;
    const tabs = document.getElementById('chart-tabs');
    if (!tabs) return;
    const sum = (series) => series.reduce((total, point) => total + point.value, 0);
    const prepared = DASHBOARD_SERIES.map((series) => {
      const tracked = !series.usage || (Boolean(analytics?.usageTrackingAvailable) && Array.isArray(analytics?.[series.trend]));
      const points = tracked ? buildDailySeries(trendToCounts(analytics?.[series.trend]), analytics?.rangeStart, analytics?.rangeEnd) : [];
      return { ...series, tracked, points, total: sum(points) };
    });
    if (!prepared.some((series) => series.key === dashboardChartTab)) dashboardChartTab = 'registrations';
    tabs.innerHTML = prepared.map((series) => `
      <button type="button" class="ax-tab" role="tab" data-chart-tab="${series.key}" aria-selected="${series.key === dashboardChartTab}">
        ${escapeHtml(series.tab)} <strong>${series.tracked ? escapeHtml(formatNumber(series.total)) : '—'}</strong>
      </button>`).join('');
    const active = prepared.find((series) => series.key === dashboardChartTab);
    const foot = document.getElementById('chart-foot');
    if (foot) foot.textContent = active.foot;
    const target = document.getElementById('chart-main');
    if (!active.tracked) {
      chartRegistry.delete('chart-main');
      if (target) {
        target.innerHTML = '<div class="untracked-state"><p>Recording hasn’t been set up yet.</p><p>Run backend/migrations/003_app_usage_events.sql, then restart the backend.</p></div>';
        target.setAttribute('aria-label', `${active.label}: not tracked yet.`);
      }
      return;
    }
    if (target) target.setAttribute('aria-label', active.label);
    renderLineChart('chart-main', active.points, { ...active, height: 240 });
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
      summaryTarget.innerHTML = '<div class="ax-empty" style="grid-column:1/-1">Loading…</div>';
      const chart = document.getElementById('chart-main');
      if (chart) chart.innerHTML = '<div class="empty-state chart-empty">Loading graph…</div>';
      if (userBase) userBase.innerHTML = '<div class="ax-empty">Loading…</div>';
      if (activityList) activityList.innerHTML = '<li class="ax-empty" style="display:block">Loading…</li>';
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
      summaryTarget.innerHTML = '<div class="ax-empty" style="grid-column:1/-1">We couldn’t load the key numbers. Try again.</div>';
    }

    if (analyticsResult.status === 'fulfilled') {
      renderDashboardCharts(analyticsResult.value);
      renderUserBaseSummary(analyticsResult.value?.profileSummary, summary);
    } else {
      chartRegistry.delete('chart-main');
      const chart = document.getElementById('chart-main');
      if (chart) chart.innerHTML = '<div class="empty-state chart-empty">We couldn’t load this graph. Try again.</div>';
      if (userBase) userBase.innerHTML = '<div class="ax-empty">We couldn’t load this. Try again.</div>';
    }

    if (activityList) {
      if (activityResult.status === 'fulfilled') {
        renderRecentActivity(activityList, activityResult.value);
      } else {
        activityList.innerHTML = '<li class="ax-empty" style="display:block">We couldn’t load recent activity. Try again.</li>';
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

  let activityFilter = 'all';
  let activityCache = [];

  function renderActivityFeed() {
    const list = document.getElementById('recent-activity-list');
    if (!list) return;
    const items = activityFilter === 'all' ? activityCache : activityCache.filter((item) => item.kind === activityFilter);
    renderFeed(list, items.slice(0, 30), 'Nothing to show for this filter yet.');
  }

  async function loadActivityFeed() {
    const activityList = document.getElementById('recent-activity-list');
    if (!activityList) return;
    const today = document.getElementById('activity-today');
    activityList.innerHTML = '<li class="ax-empty" style="display:block">Loading…</li>';
    try {
      const activities = await request('/api/admin/activity');
      activityCache = activityItems(activities);
      renderActivityFeed();
      if (today) {
        const counts = activities?.last24Hours || {};
        const tile = (iconName, label, value) => ({ icon: iconName, label, value: value == null ? '—' : formatNumber(value), sub: value == null ? 'Not tracked yet' : 'Last 24 hours' });
        renderKpis(today, [
          tile('users', 'New users', counts.signups),
          tile('compass', 'Itineraries saved', counts.trips),
          tile('signin', 'Sign-ins', counts.signIns),
          tile('chat', 'Chatbot messages', counts.chatMessages),
        ]);
      }
    } catch (error) {
      activityList.innerHTML = '<li class="ax-empty" style="display:block">We couldn’t load recent activity. Try again.</li>';
      if (today) today.innerHTML = '';
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

  function initials(name, email) {
    const source = String(name || email || '?').trim();
    const parts = source.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function personCell(name, email) {
    return `<div class="ax-person"><span class="ax-avatar" aria-hidden="true">${escapeHtml(initials(name, email))}</span><span class="ax-person-text"><strong>${escapeHtml(name || 'Unnamed user')}</strong><small>${escapeHtml(email || '—')}</small></span></div>`;
  }

  let userSearchToken = 0;
  async function loadUserTable(page = userTableState.page) {
    const tableBody = document.getElementById('user-table-body');
    if (!tableBody) return;
    const token = ++userSearchToken;
    if (!tableBody.children.length) tableBody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading users…</td></tr>';
    try {
      const search = document.getElementById('user-search')?.value.trim() || '';
      const status = document.getElementById('user-status-filter')?.value || 'all';
      const params = new URLSearchParams({ page: String(page), limit: String(userTableState.limit), search, status });
      const payload = await request(`/api/admin/users?${params}`);
      if (token !== userSearchToken) return; // a newer search is on its way
      const users = payload?.users || [];
      userLastActiveTrackingAvailable = Boolean(payload?.lastActiveTrackingAvailable);
      userTableState.page = payload?.page || page;
      userTableState.total = payload?.total || 0;
      const note = document.getElementById('user-last-active-note');
      if (note) note.textContent = `${formatNumber(userTableState.total)} ${userTableState.total === 1 ? 'account' : 'accounts'}${search ? ` matching “${search}”` : ''}`;
      tableBody.innerHTML = users.length ? users.map((row) => {
        let lastActive = '—';
        let inactiveNote = '';
        if (row.lastActiveAt) {
          lastActive = relativeTime(row.lastActiveAt);
          const ms = Date.now() - new Date(row.lastActiveAt).getTime();
          if (Number.isFinite(ms) && ms >= 180 * 24 * 60 * 60 * 1000) inactiveNote = '<span class="ax-sub">180+ days inactive</span>';
        } else if (!userLastActiveTrackingAvailable) {
          lastActive = 'Not tracked';
        }
        return `<tr>
          <td>${personCell(row.name, row.email)}</td>
          <td class="hide-sm">${escapeHtml(formatDateOnly(row.createdAt))}</td>
          <td class="hide-sm"><span title="${escapeHtml(row.lastActiveAt ? formatDate(row.lastActiveAt) : '')}">${escapeHtml(lastActive)}</span>${inactiveNote}</td>
          <td>${row.isOnline ? '<span class="ax-pill ok live">Online</span>' : row.isActive ? '<span class="ax-pill">Active</span>' : '<span class="ax-pill off">Disabled</span>'}</td>
          <td class="act"><button class="admin-button-secondary ax-btn-sm" type="button" data-user-detail="${Number(row.userId)}">View</button></td>
        </tr>`;
      }).join('') : `<tr><td colspan="5" class="empty-state">${search ? 'No users match that search.' : 'No users yet.'}</td></tr>`;
      updatePagination('user-page-summary', 'user-page-previous', 'user-page-next', userTableState);
    } catch (error) {
      if (token !== userSearchToken) return;
      tableBody.innerHTML = '<tr><td colspan="5" class="empty-state">We couldn’t load users. Try again.</td></tr>';
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
      ['Account status', user.isActive ? 'Active' : 'Disabled'],
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
    openDrawer(panel);
    target.innerHTML = '<div class="empty-state">Loading user profile…</div>';
    try {
      const payload = await request(`/api/admin/users/${encodeURIComponent(userId)}`);
      renderUserDetails({
        ...(payload?.user || {}),
        userId,
        lastActiveTrackingAvailable: Boolean(payload?.user?.lastActiveTrackingAvailable),
        inactiveLongerThan180Days: Boolean(payload?.user?.inactiveLongerThan180Days),
      });
    } catch (error) {
      target.innerHTML = '<div class="empty-state">We couldn’t load this user. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  // Themed confirmation (the browser's grey prompt looked out of place).
  // Resolves with the typed text, or null when cancelled.
  function askTypedConfirmation({ title, message, label, expected, confirmText }) {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'ax-dialog';
      root.innerHTML = `
        <div class="ax-dialog-backdrop" data-dialog-cancel></div>
        <form class="ax-dialog-panel" role="alertdialog" aria-modal="true" aria-labelledby="ax-dialog-title" novalidate>
          <h2 id="ax-dialog-title">${escapeHtml(title)}</h2>
          <p>${escapeHtml(message)}</p>
          <label for="ax-dialog-input">${escapeHtml(label)}</label>
          <input id="ax-dialog-input" type="text" autocomplete="off" />
          <p class="ax-dialog-error" role="alert" hidden></p>
          <div class="ax-dialog-actions">
            <button type="button" class="admin-button-secondary" data-dialog-cancel>Cancel</button>
            <button type="submit" class="admin-button-danger">${escapeHtml(confirmText)}</button>
          </div>
        </form>`;
      const input = root.querySelector('input');
      const error = root.querySelector('.ax-dialog-error');
      const finish = (value) => { document.removeEventListener('keydown', onKey, true); root.remove(); resolve(value); };
      const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } };
      root.addEventListener('click', (event) => { if (event.target.closest('[data-dialog-cancel]')) finish(null); });
      root.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (input.value.trim().toLowerCase() !== String(expected || '').trim().toLowerCase()) {
          error.textContent = 'That doesn’t match. Type the account email exactly.';
          error.hidden = false;
          input.focus();
          return;
        }
        finish(input.value.trim());
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(root);
      input.focus();
    });
  }

  async function deleteUserPermanently(userId, userEmail) {
    const confirmationEmail = await askTypedConfirmation({
      title: 'Delete this account?',
      message: `This permanently deletes ${userEmail} and their linked Sidekick data (trips, reviews, preferences). This cannot be undone.`,
      label: 'Type the account email to confirm',
      expected: userEmail,
      confirmText: 'Delete permanently',
    });
    if (confirmationEmail === null) return;

    try {
      await request(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmationEmail }),
      });
      closeDrawer(document.getElementById('user-detail-panel'));
      await loadUserTable(userTableState.page);
      setStatus('The account and its linked Sidekick data were permanently deleted.', 'info');
    } catch (error) {
      setStatus(getReadableError(error), 'error');
    }
  }

  const STAR = '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" fill="currentColor"/>';
  function stars(rating, large = false) {
    const value = Math.max(0, Math.min(5, Number(rating) || 0));
    // Each star fills by its share of the rating (4.5 -> four full, one half).
    return `<span class="ax-stars${large ? ' lg' : ''}" role="img" aria-label="${escapeHtml(value.toFixed(1).replace(/.0$/, ''))} out of 5 stars">${[1, 2, 3, 4, 5].map((n) => {
      const fill = Math.round(Math.max(0, Math.min(1, value - (n - 1))) * 100);
      return `<span class="ax-star" aria-hidden="true"><svg viewBox="0 0 24 24">${STAR}</svg><span class="ax-star-fill" style="width:${fill}%"><svg viewBox="0 0 24 24">${STAR}</svg></span></span>`;
    }).join('')}</span>`;
  }

  async function loadAppReviews(page = appReviewTableState.page) {
    const list = document.getElementById('app-reviews-list');
    const summary = document.getElementById('review-summary');
    if (!list || !summary) return;
    list.innerHTML = '<div class="admin-card ax-empty">Loading reviews…</div>';
    summary.innerHTML = '<div class="admin-card ax-empty" style="grid-column:1/-1">Loading rating summary…</div>';
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(appReviewTableState.limit) });
      const payload = await request(`/api/admin/app-reviews?${params}`);
      appReviewTableState.page = payload?.page || page;
      appReviewTableState.total = payload?.total || 0;
      const total = Number(payload?.total || 0);
      const average = payload?.averageRating == null ? null : Number(payload.averageRating);
      const counts = payload?.ratingCounts || {};
      const maxCount = Math.max(1, ...[5, 4, 3, 2, 1].map((n) => Number(counts[n] || 0)));
      summary.innerHTML = `
        <article class="admin-card ax-rating-big">
          <strong>${average == null ? '—' : escapeHtml(average.toFixed(1))}</strong>
          ${stars(average, true)}
          <small>${escapeHtml(formatNumber(total))} ${total === 1 ? 'rating' : 'ratings'}</small>
        </article>
        <article class="admin-card ax-dist" aria-label="Ratings by number of stars">
          ${[5, 4, 3, 2, 1].map((n) => {
            const count = Number(counts[n] || 0);
            return `<div class="ax-dist-row"><span>${n} star${n === 1 ? '' : 's'}</span><span class="ax-dist-bar"><span style="width:${count ? Math.max(3, Math.round((count / maxCount) * 100)) : 0}%"></span></span><b>${escapeHtml(formatNumber(count))}</b></div>`;
          }).join('')}
        </article>`;
      const reviews = payload?.reviews || [];
      list.innerHTML = reviews.length
        ? reviews.map((review, index) => `
            <article class="ax-review" style="animation-delay:${Math.min(index, 8) * 30}ms">
              <div class="ax-review-top">${stars(review.rating)}<span class="ax-review-date">${escapeHtml(formatDateOnly(review.updatedAt || review.createdAt))}</span></div>
              <p class="ax-review-text${review.review ? '' : ' is-empty'}">${review.review ? `“${escapeHtml(review.review)}”` : 'Rated without a comment.'}</p>
              ${personCell(review.userName, review.userEmail)}
            </article>`).join('')
        : '<div class="admin-card ax-empty">No app ratings have been submitted yet.</div>';
      updatePagination('app-reviews-page-summary', 'app-reviews-page-previous', 'app-reviews-page-next', appReviewTableState);
    } catch (error) {
      summary.innerHTML = '<div class="admin-card ax-empty" style="grid-column:1/-1">Rating summary is unavailable.</div>';
      list.innerHTML = '<div class="admin-card ax-empty">We couldn’t load app reviews. Check the database setup and try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
  }

  let itinerarySearchToken = 0;
  async function loadItineraryTable(page = itineraryTableState.page) {
    const tableBody = document.getElementById('itinerary-table-body');
    if (!tableBody) return;
    const token = ++itinerarySearchToken;
    if (!tableBody.children.length) tableBody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading saved travel plans…</td></tr>';
    try {
      const search = document.getElementById('itinerary-search')?.value.trim() || '';
      const params = new URLSearchParams({ page: String(page), limit: String(itineraryTableState.limit), search });
      const payload = await request(`/api/admin/itineraries?${params}`);
      if (token !== itinerarySearchToken) return;
      const itineraries = payload?.itineraries || [];
      itineraryTableState.page = payload?.page || page;
      itineraryTableState.total = payload?.total || 0;
      tableBody.innerHTML = itineraries.length ? itineraries.map((row) => {
        const destination = row.destination || row.title || 'Untitled plan';
        const stops = `${formatNumber(row.dayCount)} ${Number(row.dayCount) === 1 ? 'day' : 'days'} · ${formatNumber(row.activityCount)} ${Number(row.activityCount) === 1 ? 'stop' : 'stops'}`;
        return `<tr>
          <td><strong>${escapeHtml(destination)}</strong><span class="ax-sub">${escapeHtml(stops)}</span></td>
          <td>${personCell(row.userName, row.userEmail)}</td>
          <td class="hide-sm">${escapeHtml(formatDateOnly(row.startDate))}<span class="ax-sub">to ${escapeHtml(formatDateOnly(row.endDate))}</span></td>
          <td class="hide-sm"><span title="${escapeHtml(formatDate(row.createdAt))}">${escapeHtml(relativeTime(row.createdAt))}</span></td>
          <td class="act"><button class="admin-button-secondary ax-btn-sm" type="button" data-itinerary-detail="${Number(row.tripId)}">View</button></td>
        </tr>`;
      }).join('') : `<tr><td colspan="5" class="empty-state">${search ? 'No travel plans match that search.' : 'No travel plans saved yet.'}</td></tr>`;
      updatePagination('itinerary-page-summary', 'itinerary-page-previous', 'itinerary-page-next', itineraryTableState);
    } catch (error) {
      if (token !== itinerarySearchToken) return;
      tableBody.innerHTML = '<tr><td colspan="5" class="empty-state">We couldn’t load travel plans. Try again.</td></tr>';
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
    openDrawer(panel);
    target.innerHTML = '<div class="empty-state">Loading travel plan…</div>';
    try {
      const payload = await request(`/api/admin/itineraries/${encodeURIComponent(tripId)}`);
      renderItineraryDetails(payload?.itinerary || {});
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

  function uptimeText(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s)) return '—';
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
  }

  async function loadIntegrations() {
    const target = document.getElementById('integration-grid');
    if (!target) return;
    const auditList = document.getElementById('admin-audit-list');
    target.innerHTML = '<div class="admin-card ax-empty" style="grid-column:1/-1">Checking Sidekick services…</div>';
    if (auditList) auditList.innerHTML = '<li class="ax-empty" style="display:block">Loading…</li>';
    const [statusResult, auditResult] = await Promise.allSettled([
      request('/api/admin/integrations'),
      auditList ? request('/api/admin/audit') : Promise.resolve(null),
    ]);

    if (statusResult.status === 'fulfilled') {
      const p = statusResult.value || {};
      const latency = Number(p?.database?.latencyMs);
      const items = [
        { title: 'Database', ok: p?.database?.connected, value: p?.database?.connected ? 'Connected' : 'Unavailable',
          note: Number.isFinite(latency) ? `Answered in ${latency} ms${latency > 2000 ? ' (slow right now)' : ''}.` : 'Stores accounts, trips and reviews.', warn: latency > 2000 },
        { title: 'AI assistant', ok: p?.ai?.configured, value: p?.ai?.configured ? 'Ready' : 'Needs an API key',
          note: p?.ai?.configured ? `Model: ${p.ai.model || '—'}` : 'Add AI_API_KEY to the server settings.' },
        { title: 'Maps and places', ok: p?.maps?.configured, value: p?.maps?.configured ? 'Ready' : 'Needs an API key',
          note: p?.maps?.configured ? 'Place search, photos and routes.' : 'Add GOOGLE_MAPS_API_KEY to the server settings.' },
        { title: 'Email codes', ok: p?.email?.configured, value: p?.email?.configured ? 'Ready' : 'Not set up',
          note: p?.email?.configured ? 'Sign-up and password-reset codes can be sent.' : 'Add the SMTP settings so users can verify their email.' },
        { title: 'Maintenance mode', ok: !p?.maintenanceMode, warn: Boolean(p?.maintenanceMode), value: p?.maintenanceMode ? 'On' : 'Off',
          note: p?.maintenanceMode ? 'The app is paused for users. Turn it off in Settings to reopen it.' : 'The app is open to users.' },
        { title: 'Server', ok: true, value: p?.mode === 'production' ? 'Production' : 'Development',
          note: `Running for ${uptimeText(p?.uptimeSeconds)}. Checked ${new Date(p?.healthCheckTime || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`, warn: p?.mode !== 'production' },
      ];
      target.innerHTML = items.map((item) => `
        <article class="admin-card ax-status ${item.warn ? 'warn' : item.ok ? 'ok' : 'bad'}">
          <span class="ax-status-dot" aria-hidden="true"></span>
          <div><h3>${escapeHtml(item.title)}</h3><strong>${escapeHtml(item.value)}</strong><p>${escapeHtml(item.note)}</p></div>
        </article>`).join('');
    } else {
      target.innerHTML = `<article class="admin-card ax-status bad" style="grid-column:1/-1"><span class="ax-status-dot" aria-hidden="true"></span><div><h3>Server</h3><strong>Can’t reach the database</strong><p>${escapeHtml(getReadableError(statusResult.reason))}</p></div></article>`;
    }

    if (auditList) {
      if (auditResult.status === 'fulfilled') {
        const audit = auditResult.value;
        const events = (audit?.events || []).slice(0, 8);
        auditList.innerHTML = !audit?.available
          ? '<li class="ax-empty" style="display:block">Admin sign-in history isn’t set up yet.</li>'
          : events.length
            ? events.map((event) => {
              const ok = /success/i.test(String(event.outcome));
              const what = /logout/i.test(String(event.eventType)) ? 'signed out' : ok ? 'signed in' : 'failed sign-in attempt';
              return `<li>
                <span class="ax-feed-icon ${ok ? 'k-signup' : 'k-trip'}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FEED_ICONS.sign_in}</svg></span>
                <span class="ax-feed-text"><b>${escapeHtml(event.actor || 'Administrator')}</b> ${escapeHtml(what)}</span>
                <time class="ax-feed-time" title="${escapeHtml(formatDate(event.timestamp))}">${escapeHtml(relativeTime(event.timestamp))}</time>
              </li>`;
            }).join('')
            : '<li class="ax-empty" style="display:block">No admin sign-ins recorded yet.</li>';
      } else {
        auditList.innerHTML = '<li class="ax-empty" style="display:block">We couldn’t load admin sign-ins.</li>';
      }
    }
    if (statusResult.status === 'rejected') setStatus(getReadableError(statusResult.reason), 'error');
  }

  // ---- Settings: maintenance, API access, budget, archive --------------------------
  function usd(value, digits = 2) {
    const amount = Number(value) || 0;
    return `$${amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function budgetMeterHtml(costUsd, budgetUsd, paused) {
    if (!(budgetUsd > 0)) {
      return `<p class="ax-budget-text"><strong>${usd(costUsd)}</strong> estimated so far this month. No budget is set.</p>`;
    }
    const percent = Math.min(100, Math.round((costUsd / budgetUsd) * 100));
    const level = paused || percent >= 100 ? 'over' : percent >= 80 ? 'near' : 'ok';
    return `
      <p class="ax-budget-text"><strong>${usd(costUsd)}</strong> of ${usd(budgetUsd)} used this month (${percent}%)${paused ? ' — AI and maps are paused until next month or a higher budget.' : level === 'near' ? ' — getting close to the budget.' : '.'}</p>
      <div class="ax-budget-bar ${level}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="Monthly budget used"><span style="width:${percent}%"></span></div>`;
  }

  let settingsData = null;

  function renderSettings(data) {
    settingsData = data;
    const s = data?.settings || {};
    const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = Boolean(value); };
    setChecked('setting-maintenance', s.maintenanceMode || data?.maintenanceFromEnv);
    setChecked('setting-ai', s.aiEnabled);
    setChecked('setting-maps', s.mapsEnabled);
    setChecked('setting-autopause', s.autoPauseOnBudget);
    const maintenanceToggle = document.getElementById('setting-maintenance');
    if (maintenanceToggle) maintenanceToggle.disabled = Boolean(data?.maintenanceFromEnv) || !data?.available;
    ['setting-ai', 'setting-maps', 'setting-autopause', 'setting-maintenance-message', 'setting-budget', 'setting-retention',
      'save-maintenance-message', 'save-budget', 'save-retention'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !data?.available;
    });
    const message = document.getElementById('setting-maintenance-message');
    if (message && document.activeElement !== message) message.value = s.maintenanceMessage || '';
    const budget = document.getElementById('setting-budget');
    if (budget && document.activeElement !== budget) budget.value = String(s.monthlyBudgetUsd ?? 0);
    const retention = document.getElementById('setting-retention');
    if (retention && document.activeElement !== retention) retention.value = String(s.archiveRetentionDays ?? 30);
    const detail = document.getElementById('maintenance-detail');
    if (detail) {
      const changed = data?.lastChanged?.maintenance_mode;
      detail.textContent = data?.maintenanceFromEnv
        ? 'Turned on by the developer in the server settings (MAINTENANCE_MODE), so it can’t be turned off here.'
        : (s.maintenanceMode ? 'On: users see your message.' : 'Off: the app is open to users.')
          + (changed?.updatedAt ? ` Last changed by ${changed.updatedBy || 'an administrator'} ${relativeTime(changed.updatedAt)}.` : '');
    }
    const meter = document.getElementById('budget-meter');
    if (meter) meter.innerHTML = budgetMeterHtml(data?.monthCostUsd, s.monthlyBudgetUsd, data?.budgetPaused);
    const note = document.getElementById('settings-setup-note');
    if (note) {
      note.hidden = Boolean(data?.available);
      note.textContent = data?.available ? '' : 'These settings can’t be saved until the database is updated. Run backend/migrations/006_settings_usage_archive.sql in SSMS, then reload this page.';
    }
  }

  async function saveSettings(changes, successText) {
    try {
      const data = await request('/api/admin/app-settings', { method: 'PUT', body: JSON.stringify(changes) });
      renderSettings(data);
      setStatus(successText, 'info');
      return true;
    } catch (error) {
      setStatus(getReadableError(error), 'error');
      if (settingsData) renderSettings(settingsData); // put the switches back as they were
      return false;
    }
  }

  async function loadArchive() {
    const list = document.getElementById('archive-list');
    const counts = document.getElementById('archive-counts');
    if (!list) return;
    try {
      const data = await request('/api/admin/archive');
      const names = { users: 'accounts', trips: 'trips', trip_days: 'trip days', itinerary_activities: 'activities', reminders: 'reminders', app_reviews: 'app reviews', user_preferences: 'preference sets' };
      if (!data.available) {
        if (counts) counts.textContent = '';
        list.innerHTML = '<li class="ax-empty" style="display:block">The archive isn’t set up yet. Run migration 006 to start keeping copies of deleted data.</li>';
        return;
      }
      if (counts) {
        counts.innerHTML = data.counts.length
          ? data.counts.map((item) => `<span class="ax-pill">${escapeHtml(formatNumber(item.total))} ${escapeHtml(names[item.table] || item.table)}</span>`).join('')
          : '';
      }
      list.innerHTML = data.recent.length
        ? data.recent.map((item) => `<li>
            <span class="ax-feed-icon ${item.deletedByType === 'admin' ? 'k-trip' : 'k-chat'}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6"/></svg></span>
            <span class="ax-feed-text"><b>${escapeHtml(names[item.table] || item.table)} #${escapeHtml(item.sourceId)}</b> — ${escapeHtml(item.reason || 'Deleted')}${item.deletedBy ? ` <span class="ax-muted">(${escapeHtml(item.deletedBy)})</span>` : ''}</span>
            <time class="ax-feed-time" title="${escapeHtml(formatDate(item.deletedAt))}">${escapeHtml(relativeTime(item.deletedAt))}</time>
          </li>`).join('')
        : `<li class="ax-empty" style="display:block">Nothing has been deleted in the last ${escapeHtml(String(data.retentionDays))} days.</li>`;
    } catch (error) {
      list.innerHTML = `<li class="ax-empty" style="display:block">${escapeHtml(getReadableError(error))}</li>`;
    }
  }

  async function loadSettings() {
    try {
      renderSettings(await request('/api/admin/app-settings'));
    } catch (error) {
      setStatus(getReadableError(error), 'error');
    }
    void loadArchive();
  }

  function initSettingsPage() {
    const toggle = (id, key, onText, offText) => {
      document.getElementById(id)?.addEventListener('change', (event) => {
        const on = event.target.checked;
        void saveSettings({ [key]: on }, on ? onText : offText);
      });
    };
    document.getElementById('setting-maintenance')?.addEventListener('change', async (event) => {
      const on = event.target.checked;
      if (on && !window.confirm('Pause the app for all users now? They will see your maintenance message until you turn this off.')) {
        event.target.checked = false;
        return;
      }
      await saveSettings({ maintenanceMode: on }, on ? 'Maintenance mode is on. The app is paused for users.' : 'Maintenance mode is off. The app is open again.');
    });
    toggle('setting-ai', 'aiEnabled', 'AI features are on.', 'AI features are off. The app will not make Gemini calls.');
    toggle('setting-maps', 'mapsEnabled', 'Maps and places are on.', 'Maps and places are off. The app will not make Google Maps calls.');
    toggle('setting-autopause', 'autoPauseOnBudget', 'AI and maps will pause when the monthly budget is reached.', 'Automatic pausing is off.');
    document.getElementById('save-maintenance-message')?.addEventListener('click', () => {
      void saveSettings({ maintenanceMessage: document.getElementById('setting-maintenance-message')?.value || '' }, 'Maintenance message saved.');
    });
    document.getElementById('save-budget')?.addEventListener('click', () => {
      const value = Number(document.getElementById('setting-budget')?.value);
      if (!Number.isFinite(value) || value < 0) { setStatus('Enter a budget of 0 or more US dollars.', 'error'); return; }
      void saveSettings({ monthlyBudgetUsd: value }, value > 0 ? `Monthly budget set to ${usd(value)}.` : 'Monthly budget removed.');
    });
    document.getElementById('save-retention')?.addEventListener('click', async () => {
      const value = Number(document.getElementById('setting-retention')?.value);
      if (!Number.isInteger(value) || value < 1 || value > 3650) { setStatus('Enter a whole number of days from 1 to 3650.', 'error'); return; }
      if (await saveSettings({ archiveRetentionDays: value }, `Deleted data will be kept for ${value} day${value === 1 ? '' : 's'}.`)) void loadArchive();
    });
    void loadSettings();
  }

  // ---- API usage ------------------------------------------------------------------------
  let usageRangeDays = Number(readStoredRange('sidekick.admin.usageRange', [7, 30, 90], 30));

  function renderUsageChart(daily) {
    const target = document.getElementById('usage-chart');
    if (!target) return;
    const max = Math.max(...daily.map((day) => day.costUsd), 0);
    if (!max) {
      target.innerHTML = '<p class="ax-empty" style="display:block">No paid API calls in this period.</p>';
      return;
    }
    target.innerHTML = `<div class="ax-usage-bars">${daily.map((day) => {
      const height = Math.max(2, Math.round((day.costUsd / max) * 100));
      const label = `${formatChartDate(day.date)}: ${usd(day.costUsd, 3)} from ${formatNumber(day.calls)} call${day.calls === 1 ? '' : 's'}`;
      return `<span class="ax-usage-bar" style="height:${height}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`;
    }).join('')}</div>
      <div class="ax-usage-axis"><span>${escapeHtml(formatChartDate(daily[0].date))}</span><span>${escapeHtml(formatChartDate(daily[daily.length - 1].date))}</span></div>`;
  }

  async function loadUsage() {
    const body = document.getElementById('usage-table-body');
    const summary = document.getElementById('usage-summary');
    document.querySelectorAll('[data-usage-range]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.usageRange) === usageRangeDays));
    });
    try {
      const data = await request(`/api/admin/api-usage?days=${usageRangeDays}`);
      const groups = { ai: 'AI', maps: 'Maps', email: 'Email' };
      const featureState = (on) => (on ? '<span class="ax-pill ok">On</span>' : '<span class="ax-pill off">Off</span>');
      if (summary) {
        summary.innerHTML = `
          <article class="admin-card ax-usage-tile"><h3>Last ${data.days} days</h3><strong>${usd(data.totalCostUsd)}</strong><p>Estimated cost</p></article>
          <article class="admin-card ax-usage-tile"><h3>This month</h3>${budgetMeterHtml(data.month.costUsd, data.month.budgetUsd, data.month.paused)}</article>
          <article class="admin-card ax-usage-tile"><h3>API access</h3><p class="ax-usage-access">AI ${featureState(data.features.ai && !data.month.paused)} Maps ${featureState(data.features.maps && !data.month.paused)}</p><p><a href="admin-controls.html">Change in Settings</a></p></article>`;
      }
      const note = document.getElementById('usage-chart-note');
      if (note) {
        note.textContent = data.storage === 'database'
          ? 'In US dollars, by Philippine date.'
          : `Counting since the server started (${formatDate(data.trackingSince)}). Run migration 006 to keep usage history.`;
      }
      renderUsageChart(data.daily);
      if (body) {
        const rows = data.apis.filter((api) => api.calls || api.blocked);
        body.innerHTML = rows.length
          ? rows.sort((a, b) => b.costUsd - a.costUsd).map((api) => `<tr>
              <td><b>${escapeHtml(api.label)}</b> <span class="ax-muted">${escapeHtml(groups[api.group] || '')}</span></td>
              <td>${escapeHtml(formatNumber(api.calls))}</td>
              <td>${api.blocked ? escapeHtml(formatNumber(api.blocked)) : '—'}</td>
              <td>${api.group === 'ai' ? `${escapeHtml(formatNumber(api.inputTokens))} / ${escapeHtml(formatNumber(api.outputTokens))}` : '—'}</td>
              <td><b>${usd(api.costUsd, 3)}</b></td>
            </tr>`).join('')
          : '<tr><td colspan="5" class="empty-state">No paid API calls in this period.</td></tr>';
      }
    } catch (error) {
      setStatus(getReadableError(error), 'error');
      if (body) body.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(getReadableError(error))}</td></tr>`;
    }
  }

  function initUsagePage() {
    document.querySelectorAll('[data-usage-range]').forEach((button) => {
      button.addEventListener('click', () => {
        const days = Number(button.dataset.usageRange);
        if (days === usageRangeDays) return;
        usageRangeDays = days;
        storeRange('sidekick.admin.usageRange', days);
        void loadUsage();
      });
    });
    document.getElementById('usage-refresh')?.addEventListener('click', () => loadUsage());
    void loadUsage();
  }

  // ---- Reports: audience, what users plan, most engaged users -------------------
  async function loadEngagedUsers() {
    const body = document.getElementById('engaged-table-body');
    if (!body) return;
    const sortSelect = document.getElementById('engaged-sort');
    body.innerHTML = '<tr><td colspan="5" class="empty-state">Loading…</td></tr>';
    try {
      const params = new URLSearchParams({ page: '1', limit: '10', search: '', status: 'all', sort: sortSelect?.value || 'chat' });
      let payload;
      try {
        payload = await request(`/api/admin/users?${params}`);
      } catch (error) {
        // Usage tracking not set up yet: fall back to itineraries.
        params.set('sort', 'itineraries');
        if (sortSelect) sortSelect.value = 'itineraries';
        payload = await request(`/api/admin/users?${params}`);
      }
      if (sortSelect && Array.isArray(payload?.availableSorts)) {
        Array.from(sortSelect.options).forEach((option) => { option.disabled = !payload.availableSorts.includes(option.value); });
      }
      const tracked = Boolean(payload?.usageTrackingAvailable);
      const users = payload?.users || [];
      body.innerHTML = users.length ? users.map((user) => `<tr>
          <td>${personCell(user.name, user.email)}</td>
          <td class="num">${tracked ? `<strong>${escapeHtml(formatNumber(user.chatMessageCount))}</strong>` : '—'}</td>
          <td class="num">${tracked ? `<strong>${escapeHtml(formatNumber(user.signInCount))}</strong>` : '—'}</td>
          <td class="num"><strong>${escapeHtml(formatNumber(user.savedItineraryCount))}</strong></td>
          <td class="hide-sm">${user.lastActiveAt ? `<span title="${escapeHtml(formatDate(user.lastActiveAt))}">${escapeHtml(relativeTime(user.lastActiveAt))}</span>` : '—'}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No users yet.</td></tr>';
    } catch (error) {
      body.innerHTML = '<tr><td colspan="5" class="empty-state">We couldn’t load this list. Try again.</td></tr>';
      setStatus(getReadableError(error), 'error');
    }
  }

  async function initReportsPage() {
    const audience = document.getElementById('report-audience');
    if (audience) audience.innerHTML = '<div class="admin-card ax-empty" style="grid-column:1/-1">Loading…</div>';
    document.getElementById('engaged-sort')?.addEventListener('change', () => void loadEngagedUsers());
    void loadPlanInsights('picks', 8);
    void loadEngagedUsers();
    const [summaryResult, analyticsResult] = await Promise.allSettled([
      request('/api/admin/summary'),
      request('/api/admin/analytics?days=30'),
    ]);
    if (analyticsResult.status === 'fulfilled') {
      renderUserBaseSummary(analyticsResult.value?.profileSummary, summaryResult.status === 'fulfilled' ? summaryResult.value : null);
    } else if (audience) {
      audience.innerHTML = '<div class="admin-card ax-empty" style="grid-column:1/-1">We couldn’t load this. Try again.</div>';
      setStatus(getReadableError(analyticsResult.reason), 'error');
    }
  }

  // ---- Slide-in drawers ------------------------------------------------------------
  let drawerReturnFocus = null;
  function openDrawer(drawer) {
    if (!drawer) return;
    if (drawer.hidden) drawerReturnFocus = document.activeElement;
    drawer.hidden = false;
    document.body.style.overflow = 'hidden';
    drawer.querySelector('.ax-close')?.focus({ preventScroll: true });
  }

  function closeDrawer(drawer) {
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    if (!document.querySelector('.ax-drawer:not([hidden])')) document.body.style.removeProperty('overflow');
    try { drawerReturnFocus?.focus?.({ preventScroll: true }); } catch (error) {}
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
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

    // On phones the page links are one sideways-scrolling row: start with the
    // current page's link in view. (Only the row scrolls, never the page.)
    const navRow = document.querySelector('.admin-sidebar nav');
    const activeLink = navRow?.querySelector('.admin-nav-link.active');
    if (navRow && activeLink && navRow.scrollWidth > navRow.clientWidth) {
      navRow.scrollLeft = Math.max(0, activeLink.offsetLeft - navRow.offsetLeft - (navRow.clientWidth - activeLink.offsetWidth) / 2);
    }

    // Live search: results update as the admin types (no "Find" button).
    const userSearchInput = document.getElementById('user-search');
    const userStatusFilter = document.getElementById('user-status-filter');
    if (userSearchInput) {
      const liveUserSearch = debounce(() => loadUserTable(1), 250);
      userSearchInput.addEventListener('input', liveUserSearch);
      userSearchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); loadUserTable(1); }
      });
    }
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
      closeDrawer(document.getElementById('user-detail-panel'));
    });

    const itinerarySearchInput = document.getElementById('itinerary-search');
    if (itinerarySearchInput) {
      const liveItinerarySearch = debounce(() => loadItineraryTable(1), 250);
      itinerarySearchInput.addEventListener('input', liveItinerarySearch);
      itinerarySearchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); loadItineraryTable(1); }
      });
    }
    document.getElementById('itinerary-page-previous')?.addEventListener('click', () => loadItineraryTable(itineraryTableState.page - 1));
    document.getElementById('itinerary-page-next')?.addEventListener('click', () => loadItineraryTable(itineraryTableState.page + 1));
    document.getElementById('itinerary-table-body')?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-itinerary-detail]');
      if (button) void loadItineraryDetails(button.dataset.itineraryDetail);
    });
    document.getElementById('itinerary-detail-close')?.addEventListener('click', () => {
      closeDrawer(document.getElementById('itinerary-detail-panel'));
      selectedItineraryTripId = null;
    });
    // Drawers close on the backdrop and with Escape.
    document.addEventListener('click', (event) => {
      const backdrop = event.target.closest?.('[data-drawer-close]');
      if (!backdrop) return;
      const drawer = backdrop.closest('.ax-drawer');
      closeDrawer(drawer);
      if (drawer?.id === 'itinerary-detail-panel') selectedItineraryTripId = null;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || document.querySelector('.ax-dialog')) return;
      const open = document.querySelector('.ax-drawer:not([hidden])');
      if (!open) return;
      closeDrawer(open);
      if (open.id === 'itinerary-detail-panel') selectedItineraryTripId = null;
    });
    initBarTooltips();
    if (currentPage === 'dashboard') {
      void loadPlanInsights('plan', 5);
      document.getElementById('chart-tabs')?.addEventListener('click', (event) => {
        const tab = event.target.closest?.('[data-chart-tab]');
        if (!tab || tab.dataset.chartTab === dashboardChartTab) return;
        dashboardChartTab = tab.dataset.chartTab;
        try { localStorage.setItem(CHART_TAB_KEY, dashboardChartTab); } catch (error) {}
        if (lastDashboardAnalytics) renderDashboardCharts(lastDashboardAnalytics);
      });
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
      document.getElementById('activity-filters')?.addEventListener('click', (event) => {
        const chip = event.target.closest?.('[data-activity-filter]');
        if (!chip) return;
        activityFilter = chip.dataset.activityFilter;
        document.querySelectorAll('[data-activity-filter]').forEach((node) => node.setAttribute('aria-selected', String(node === chip)));
        renderActivityFeed();
      });
    }
    if (currentPage === 'users') {
      loadUserTable();
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
      void initReportsPage();
    }
    if (currentPage === 'integrations') {
      loadIntegrations();
      document.getElementById('system-refresh')?.addEventListener('click', () => loadIntegrations());
    }
    if (currentPage === 'settings') {
      initSettingsPage();
    }
    if (currentPage === 'usage') {
      initUsagePage();
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
