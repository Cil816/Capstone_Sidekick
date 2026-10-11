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

  function ensureAdminSession() {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (!token && !window.location.pathname.endsWith('admin-login.html')) {
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
        if (!window.location.pathname.endsWith('admin-login.html')) {
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

  async function loadDashboard() {
    const summaryCard = document.getElementById('dashboard-summary');
    const activityList = document.getElementById('recent-activity-list');
    if (!summaryCard) return;
    summaryCard.innerHTML = '<div class="admin-card empty-state">Loading your overview…</div>';
    if (activityList) activityList.innerHTML = '<div class="empty-state">Loading recent sign-ups and saved plans…</div>';

    try {
      const summary = await request('/api/admin/summary');
      const metrics = summary?.metrics || {};
      const cards = [
        { label: 'User accounts', value: metrics.totalUsers ?? 'Not available', detail: `${metrics.activeUsers ?? 0} enabled · ${metrics.inactiveUsers ?? 0} disabled` },
        { label: 'Online now', value: metrics.onlineUsers ?? 0, detail: 'Seen using the app in the past 90 seconds' },
        { label: 'Verified users', value: metrics.verifiedUsers ?? 'Not available', detail: `${metrics.unverifiedUsers ?? 0} not verified` },
        { label: 'Saved travel plans', value: metrics.totalTrips ?? 'Not available', detail: `${metrics.tripsLast30Days ?? 0} saved in the past 30 days` },
        { label: 'Activities in plans', value: metrics.totalActivities ?? 'Not available', detail: `${metrics.totalTripDays ?? 0} travel days planned` },
      ];

      summaryCard.innerHTML = cards.map((card) => `
        <div class="admin-card stat-card">
          <span class="stat-label">${escapeHtml(card.label)}</span>
          <div class="stat-value">${escapeHtml(card.value)}</div>
          <div class="stat-detail">${escapeHtml(card.detail)}</div>
        </div>
      `).join('');

    } catch (error) {
      summaryCard.innerHTML = '<div class="empty-state">We couldn’t load the overview. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }

    if (activityList) {
      try {
        const activities = await request('/api/admin/activity');
        const items = [...(activities?.recentUsers || []), ...(activities?.recentTrips || [])]
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
          .slice(0, 8);
        activityList.innerHTML = items.length
          ? items.map((item) => `
              <div class="logger-item">
                <div class="logger-text">${escapeHtml(item.label)}</div>
                <div class="logger-time">${escapeHtml(formatDate(item.timestamp))}</div>
              </div>
            `).join('')
            : '<div class="empty-state">Nothing to show yet. New sign-ups and saved plans will appear here.</div>';
      } catch (error) {
        activityList.innerHTML = '<div class="empty-state">We couldn’t load recent activity. Try again.</div>';
        setStatus(getReadableError(error), 'error');
      }
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
      const items = [...(activities?.recentUsers || []), ...(activities?.recentTrips || [])]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 8);
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

  function renderMiniChart(targetId, data, color = '#6d8fb8') {
    const target = document.getElementById(targetId);
    if (!target || !Array.isArray(data)) return;
    if (!data.length) {
      target.innerHTML = '<div class="empty-state">Nothing to show for this period yet.</div>';
      return;
    }
    const values = data.map((point) => Number(point.value || 0));
    const max = Math.max(...values, 1);
    const html = data.slice(0, 8).map((point) => {
      const height = Math.max(18, (Number(point.value || 0) / max) * 100);
      return `
        <div class="chart-bar-wrap">
          <span class="chart-value">${escapeHtml(point.value ?? 0)}</span>
          <div class="chart-bar" style="height:${height}%; background:${color};"></div>
          <span class="chart-label">${escapeHtml(String(point.label || '').slice(5))}</span>
        </div>
      `;
    }).join('');
    target.innerHTML = html;
  }

  async function loadAnalytics() {
    const chartUsers = document.getElementById('analytics-user-chart');
    const chartTrips = document.getElementById('analytics-itinerary-chart');
    if (!chartUsers || !chartTrips) return;
    chartUsers.innerHTML = '<div class="empty-state">Loading new sign-ups…</div>';
    chartTrips.innerHTML = '<div class="empty-state">Loading saved plans…</div>';
    try {
      const payload = await request('/api/admin/analytics');
      renderMiniChart('analytics-user-chart', payload?.registrationTrend || [], '#6d8fb8');
      renderMiniChart('analytics-itinerary-chart', payload?.itineraryTrend || [], '#a7c3dd');
    } catch (error) {
      chartUsers.innerHTML = '<div class="empty-state">We couldn’t load sign-up reports. Try again.</div>';
      chartTrips.innerHTML = '<div class="empty-state">We couldn’t load travel plan reports. Try again.</div>';
      setStatus(getReadableError(error), 'error');
    }
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
    if (currentPage === 'dashboard') {
      loadDashboard();
    }
    if (currentPage === 'activity') {
      loadActivityFeed();
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
      loadAnalytics();
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
        if (currentPage === 'dashboard') loadDashboard();
        if (currentPage === 'users') loadUserTable(userTableState.page);
        if (currentPage === 'itineraries') {
          loadItineraryTable(itineraryTableState.page);
          if (selectedItineraryTripId) void loadItineraryDetails(selectedItineraryTripId);
        }
      }, 30_000);
    }
  });
})();
