import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sql from 'mssql';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import dns from 'node:dns';
import nodemailer from 'nodemailer';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const mobileAppDir = path.join(projectRoot, 'mobile-app');

const app = express();
// Behind a load balancer (AWS ALB), set TRUST_PROXY=1 so req.ip is the visitor's
// address (from X-Forwarded-For) instead of the load balancer's. Leave it unset
// when the server is reached directly, or visitors could fake their address.
const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
const port = Number(process.env.PORT || 3001);
const configuredServer = process.env.DB_SERVER || 'localhost\\SQLEXPRESS';
const [serverName, configuredInstance] = configuredServer.split('\\', 2);
const configuredInstanceName = process.env.DB_INSTANCE || configuredInstance;
const configuredDatabase = process.env.DB_DATABASE || 'sidekick_db';
const useWindowsAuthentication = (process.env.DB_AUTH || 'windows').toLowerCase() === 'windows';
const rateLimits = new Map();
const routeCache = new Map();
const placesSearchCache = new Map();
const placesSearchInFlight = new Map();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isDevelopmentMode = String(process.env.SIDEKICK_API_MODE || 'production').trim().toLowerCase() === 'development';

const config = {
  ...(useWindowsAuthentication ? { driver: 'msnodesqlv8' } : {}),
  ...(useWindowsAuthentication
    ? {
        connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${configuredInstanceName ? `${serverName}\\${configuredInstanceName}` : `${serverName},${Number(process.env.DB_PORT || 1433)}`};Database=${configuredDatabase};Trusted_Connection=Yes;TrustServerCertificate=Yes;`,
      }
    : {}),
  server: serverName || 'localhost',
  database: configuredDatabase,
  // A small database server (e.g. RDS db.t3.micro) can pause for several seconds
  // when it is short on memory; 30 s (instead of the 15 s default) rides that out
  // instead of showing an error.
  requestTimeout: 30000,
  connectionTimeout: 30000,
  ...(useWindowsAuthentication
    ? { options: { trustedConnection: true } }
    : {
        user: process.env.DB_USERNAME || 'sa',
        password: process.env.DB_PASSWORD || '',
      }),
  ...(!configuredInstanceName
    ? { port: Number(process.env.DB_PORT || 1433) }
    : {}),
  options: {
    // DB_ENCRYPT=true encrypts the connection (recommended for Amazon RDS).
    encrypt: ['1', 'true', 'yes'].includes(String(process.env.DB_ENCRYPT || '').trim().toLowerCase()),
    trustServerCertificate: true,
    enableArithAbort: true,
    ...(useWindowsAuthentication ? { trustedConnection: true } : {}),
    ...(configuredInstanceName
      ? { instanceName: configuredInstanceName }
      : {}),
  },
};

// ---- Security settings --------------------------------------------------------
// Production values live on the server, never in the app or website:
//   NODE_ENV=production   FORCE_HTTPS=1   TRUST_PROXY=1
//   CORS_ALLOWED_ORIGINS=https://your-domain,https://localhost,capacitor://localhost
// Left unset (local development), the server behaves as before.
const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const isEnabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
const forceHttps = isEnabled(process.env.FORCE_HTTPS);
const corsAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.disable('x-powered-by');

// Send plain-HTTP visitors to HTTPS. The load balancer's health check (/health)
// stays on HTTP. Non-GET requests over HTTP are refused rather than redirected,
// so passwords and tokens are never sent unencrypted twice.
if (forceHttps) {
  app.use((req, res, next) => {
    const secure = req.secure || String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https';
    if (secure || req.path === '/health') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      const origin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '') || `https://${req.get('host')}`;
      return res.redirect(301, `${origin}${req.originalUrl}`);
    }
    return res.status(403).json({ error: 'HTTPS is required.' });
  });
}

// Security headers. The admin website gets a strict Content-Security-Policy (it
// loads only its own scripts); API responses are never cached or framed.
const ADMIN_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  if (forceHttps) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // In production every page on the site is the admin website (served at /).
  if (req.path === '/admin' || req.path.startsWith('/admin/') || (isProduction && !req.path.startsWith('/api/'))) {
    res.set('Content-Security-Policy', ADMIN_CONTENT_SECURITY_POLICY);
    res.set('X-Frame-Options', 'DENY');
  }
  if (req.path.startsWith('/api/')) {
    // Routes such as /api/maps/photo may replace this with their own caching.
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  next();
});

// CORS: with CORS_ALLOWED_ORIGINS set, only those websites and the mobile app may
// call the API from a browser. Requests without an Origin header (the app's own
// page navigation, health checks, server tools) are unaffected. Logins use
// Authorization/X-Admin-Token headers, never cookies, so cross-site request
// forgery (CSRF) cannot use a visitor's login.
app.use(cors(corsAllowedOrigins.length ? {
  origin(origin, callback) {
    callback(null, !origin || corsAllowedOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
  maxAge: 600,
} : undefined));
// 2 MB comfortably fits the largest request (a 14-day itinerary) and limits abuse.
app.use(express.json({ limit: '2mb' }));

// Spam protection: an overall per-visitor limit for the whole API, on top of the
// per-route limits (sign-in, registration, AI, maps).
app.use('/api', (req, res, next) => {
  if (isRateLimited(`api:${req.ip}`, 3000, 15 * 60 * 1000)) {
    res.set('Retry-After', '900');
    return sendJson(res, 429, { error: 'Too many requests. Please wait a few minutes and try again.' });
  }
  return next();
});
// In production only the admin website is public: the phone app ships inside the APK
// and talks to /api only. Locally the app's pages stay available for browser testing.
if (!isProduction) app.use(express.static(mobileAppDir, { index: false }));
// The admin website is static files; serving them here means no separate web server
// is needed. /admin redirects to /admin/, whose index page opens the admin sign-in.
const adminWebsiteDir = path.join(projectRoot, 'admin-website');
if (isProduction) {
  // Production: the admin website lives at the site root with clean addresses
  // (app.sidekickph.me/users instead of /admin/admin-users.html). Old .html and
  // /admin/... addresses redirect to the clean ones, and only the pages below plus
  // the css, js and assets folders are public.
  const ADMIN_PAGES = {
    '/': 'admin-login.html',
    '/dashboard': 'admin.html',
    '/users': 'admin-users.html',
    '/travel-plans': 'admin-itineraries.html',
    '/reports': 'admin-analytics.html',
    '/reviews': 'admin-reviews.html',
    '/activity': 'admin-activity.html',
    '/system': 'admin-integrations.html',
  };
  const ADMIN_PAGE_ROUTES = Object.fromEntries(Object.entries(ADMIN_PAGES).map(([route, file]) => [file, route]));
  ADMIN_PAGE_ROUTES['index.html'] = '/';
  // "Connections" and "App setup" were merged into one System status page.
  ADMIN_PAGE_ROUTES['admin-settings.html'] = '/system';
  const RENAMED_ROUTES = { '/connections': '/system', '/setup': '/system' };
  const queryOf = (req) => {
    const index = req.originalUrl.indexOf('?');
    return index === -1 ? '' : req.originalUrl.slice(index);
  };

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Old addresses: /admin/... and /<page>.html -> the clean address.
    if (req.path === '/admin' || req.path.startsWith('/admin/')) {
      const rest = req.path.slice('/admin'.length) || '/';
      const file = rest.replace(/^\/+/, '');
      return res.redirect(302, (ADMIN_PAGE_ROUTES[file] || rest) + queryOf(req));
    }
    const file = req.path.replace(/^\/+/, '');
    if (ADMIN_PAGE_ROUTES[file]) return res.redirect(302, ADMIN_PAGE_ROUTES[file] + queryOf(req));
    // "/users/" -> "/users", so the page's relative css/js links still resolve.
    const trimmed = req.path.replace(/\/+$/, '');
    if (RENAMED_ROUTES[trimmed || req.path]) return res.redirect(302, RENAMED_ROUTES[trimmed || req.path] + queryOf(req));
    if (trimmed && trimmed !== req.path && ADMIN_PAGES[trimmed]) return res.redirect(302, trimmed + queryOf(req));
    return next();
  });

  // Links inside the pages point at the clean addresses, so clicking around never
  // shows ".html" (the files themselves keep their names for local development).
  const toCleanLinks = (html) => html.replace(/href="([a-z-]+\.html)(#[^"]*)?"/g,
    (match, file, hash = '') => (ADMIN_PAGE_ROUTES[file] ? `href="${ADMIN_PAGE_ROUTES[file]}${hash}"` : match));
  Object.entries(ADMIN_PAGES).forEach(([route, file]) => {
    app.get(route, async (req, res, next) => {
      try {
        const html = await readFile(path.join(adminWebsiteDir, file), 'utf8');
        res.set('Cache-Control', 'no-cache');
        return res.type('html').send(toCleanLinks(html));
      } catch (error) {
        return next(error);
      }
    });
  });
  ['css', 'js', 'assets'].forEach((folder) => {
    app.use(`/${folder}`, express.static(path.join(adminWebsiteDir, folder), { index: false }));
  });
} else {
  app.use('/admin', express.static(adminWebsiteDir));
}

// ---- Maintenance mode -----------------------------------------------------------
// MAINTENANCE_MODE=true in backend/.env pauses the app's API with a friendly
// message (restart the backend after changing it). App pages still load, saved
// data is untouched, and the admin website (/api/admin/*) keeps working.
function isMaintenanceMode() {
  return String(process.env.MAINTENANCE_MODE || '').trim().toLowerCase() === 'true';
}

function getMaintenanceMessage() {
  return String(process.env.MAINTENANCE_MESSAGE || '').trim().slice(0, 300)
    || 'Sidekick is under maintenance right now. Your saved trips are safe. Please try again later.';
}

app.use('/api', (req, res, next) => {
  if (!isMaintenanceMode()) return next();
  if (req.path === '/maintenance-status' || req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  res.set('Retry-After', '3600');
  return sendJson(res, 503, { error: getMaintenanceMessage(), maintenance: true });
});

app.get('/api/maintenance-status', (req, res) => {
  const maintenance = isMaintenanceMode();
  return sendJson(res, 200, { maintenance, message: maintenance ? getMaintenanceMessage() : '' });
});

app.get('/', (req, res) => {
  return res.sendFile(path.join(mobileAppDir, 'index.html'));
});

const adminSessions = new Map();
const appSessions = new Map();
let expiredItineraryCleanupInProgress = false;
const appPresence = new Map();
const APP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APP_PRESENCE_TTL_MS = 90 * 1000;

function getAppTokenFromRequest(req) {
  const authorization = String(req.headers.authorization || '').trim();
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

// ---- Shared login sessions ---------------------------------------------------
// After backend/migrations/004_shared_sessions.sql, sessions are stored in SQL
// Server so every server behind a load balancer recognises them, and restarts or
// deployments do not sign anyone out. Until then they stay in this process's
// memory (the original behaviour). Only a SHA-256 hash of each token is stored.
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
let sessionTablesKnown = false;
let sessionTablesCheckedAt = 0;

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function hasSessionTables() {
  // Once present they stay; while missing, re-check at most once a minute so
  // running the migration takes effect without a restart.
  if (sessionTablesKnown || Date.now() - sessionTablesCheckedAt < 60 * 1000) return sessionTablesKnown;
  const pool = await getPool();
  const result = await pool.query`
    SELECT CASE WHEN OBJECT_ID(N'dbo.app_sessions', N'U') IS NOT NULL
                 AND OBJECT_ID(N'dbo.admin_api_sessions', N'U') IS NOT NULL THEN 1 ELSE 0 END AS available
  `;
  sessionTablesKnown = Boolean(result.recordset[0]?.available);
  sessionTablesCheckedAt = Date.now();
  return sessionTablesKnown;
}

async function createAppSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    userId: Number(user.user_id),
    email: String(user.email || ''),
    name: String(user.name || ''),
    expiresAt: Date.now() + APP_SESSION_TTL_MS,
  };
  if (await hasSessionTables()) {
    await new sql.Request()
      .input('tokenHash', sql.Char(64), hashSessionToken(token))
      .input('userId', sql.Int, session.userId)
      .input('email', sql.NVarChar(255), session.email.slice(0, 255))
      .input('name', sql.NVarChar(150), session.name.slice(0, 150))
      .input('expiresAt', sql.DateTime2, new Date(session.expiresAt))
      .query(`
        INSERT INTO dbo.app_sessions (token_hash, user_id, email, name, expires_at)
        VALUES (@tokenHash, @userId, @email, @name, @expiresAt)
      `);
  } else {
    appSessions.set(token, session);
  }
  return { token, expiresAt: session.expiresAt };
}

// Returns { userId, email, name, expiresAt } or null. Throws only if the database fails.
async function findAppSession(token) {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const local = appSessions.get(token);
  if (local) {
    if (local.expiresAt > Date.now()) return local;
    appSessions.delete(token);
    return null;
  }
  if (!await hasSessionTables()) return null;
  const result = await new sql.Request()
    .input('tokenHash', sql.Char(64), hashSessionToken(token))
    .query(`
      SELECT user_id, email, name, expires_at
      FROM dbo.app_sessions
      WHERE token_hash = @tokenHash AND expires_at > SYSUTCDATETIME()
    `);
  const row = result.recordset[0];
  return row ? {
    userId: Number(row.user_id),
    email: String(row.email || ''),
    name: String(row.name || ''),
    expiresAt: new Date(row.expires_at).getTime(),
  } : null;
}

async function deleteAppSession(token) {
  appSessions.delete(token);
  if (SESSION_TOKEN_PATTERN.test(token) && await hasSessionTables()) {
    await new sql.Request()
      .input('tokenHash', sql.Char(64), hashSessionToken(token))
      .query('DELETE FROM dbo.app_sessions WHERE token_hash = @tokenHash');
  }
}

// Signs a user out everywhere (password reset, account deletion).
async function deleteUserAppSessions(userId) {
  const id = Number(userId);
  for (const [token, session] of appSessions) {
    if (session.userId === id) appSessions.delete(token);
  }
  if (Number.isSafeInteger(id) && await hasSessionTables()) {
    await new sql.Request()
      .input('userId', sql.Int, id)
      .query('DELETE FROM dbo.app_sessions WHERE user_id = @userId');
  }
}

async function requireAppAuth(req, res, next) {
  const token = getAppTokenFromRequest(req);
  let session = null;
  try {
    session = token ? await findAppSession(token) : null;
  } catch (error) {
    // A database problem is not an expired login: do not sign the user out.
    console.error('App session check failed:', error.message);
    return sendJson(res, 503, { error: 'Sidekick could not check your sign-in right now. Please try again.' });
  }
  if (!session) {
    return sendJson(res, 401, { error: 'Your app session has expired. Please sign in again.' });
  }
  req.appUser = session;
  return next();
}

// For legacy routes keyed by email: the signed-in user may only use their own email.
function requireOwnEmail(req, res, next) {
  if (normalizeEmail(req.params.email) !== normalizeEmail(req.appUser?.email)) {
    return sendJson(res, 403, { error: 'You can only access your own account data.' });
  }
  return next();
}

function getOnlineAppUserCount() {
  const now = Date.now();
  for (const [userId, lastSeenAt] of appPresence) {
    if (now - lastSeenAt >= APP_PRESENCE_TTL_MS) appPresence.delete(userId);
  }
  return appPresence.size;
}

function isAppUserOnline(userId) {
  const lastSeenAt = appPresence.get(Number(userId));
  if (!lastSeenAt || Date.now() - lastSeenAt >= APP_PRESENCE_TTL_MS) {
    appPresence.delete(Number(userId));
    return false;
  }
  return true;
}

function getAdminCredentials() {
  return {
    username: String(process.env.ADMIN_USERNAME || '').trim(),
    password: String(process.env.ADMIN_PASSWORD || '').trim(),
  };
}

function getAdminTokenFromRequest(req) {
  const headerToken = String(req.headers.authorization || '').trim();
  if (headerToken.startsWith('Bearer ')) {
    return headerToken.slice(7).trim();
  }
  return String(req.headers['x-admin-token'] || '').trim();
}

function matchesAdminSecret(provided, configured) {
  const providedBuffer = Buffer.from(String(provided || ''));
  const configuredBuffer = Buffer.from(String(configured || ''));
  return providedBuffer.length === configuredBuffer.length
    && crypto.timingSafeEqual(providedBuffer, configuredBuffer);
}

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

async function createAdminSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = { username, role: 'super-admin', issuedAt: Date.now(), expiresAt: Date.now() + ADMIN_SESSION_TTL_MS };
  if (await hasSessionTables()) {
    await new sql.Request()
      .input('tokenHash', sql.Char(64), hashSessionToken(token))
      .input('username', sql.NVarChar(128), String(username).slice(0, 128))
      .input('role', sql.NVarChar(32), session.role)
      .input('expiresAt', sql.DateTime2, new Date(session.expiresAt))
      .query(`
        INSERT INTO dbo.admin_api_sessions (token_hash, username, role, expires_at)
        VALUES (@tokenHash, @username, @role, @expiresAt)
      `);
  } else {
    adminSessions.set(token, session);
  }
  return token;
}

// Returns { username, role, expiresAt } or null. Throws only if the database fails.
async function findAdminSession(token) {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const local = adminSessions.get(token);
  if (local) {
    if (local.expiresAt > Date.now()) return local;
    adminSessions.delete(token);
    return null;
  }
  if (!await hasSessionTables()) return null;
  const result = await new sql.Request()
    .input('tokenHash', sql.Char(64), hashSessionToken(token))
    .query(`
      SELECT username, role, expires_at
      FROM dbo.admin_api_sessions
      WHERE token_hash = @tokenHash AND expires_at > SYSUTCDATETIME()
    `);
  const row = result.recordset[0];
  return row ? { username: row.username, role: row.role, expiresAt: new Date(row.expires_at).getTime() } : null;
}

async function deleteAdminSession(token) {
  adminSessions.delete(token);
  if (SESSION_TOKEN_PATTERN.test(token) && await hasSessionTables()) {
    await new sql.Request()
      .input('tokenHash', sql.Char(64), hashSessionToken(token))
      .query('DELETE FROM dbo.admin_api_sessions WHERE token_hash = @tokenHash');
  }
}

async function requireAdminAuth(req, res, next) {
  const providedToken = getAdminTokenFromRequest(req);
  if (providedToken) {
    let session = null;
    try {
      session = await findAdminSession(providedToken);
    } catch (error) {
      // A database problem is not an expired login: do not sign the admin out.
      console.error('Admin session check failed:', error.message);
      return sendJson(res, 503, { error: 'Sidekick could not check your admin sign-in right now. Please try again.' });
    }
    if (session) {
      req.admin = session;
      return next();
    }
  }

  const configured = getAdminCredentials();
  if (!configured.username || !configured.password) {
    return sendJson(res, 503, {
      error: 'Admin authentication is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in backend/.env before enabling the admin portal.',
    });
  }

  return sendJson(res, 401, { error: 'Admin authentication failed.' });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAiApiKey() {
  return String(process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
}

function getMapsApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
}

function getAiModel() {
  return String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
}

function mapPriceRange(range) {
  const toAmount = (money) => (money && money.units !== undefined
    ? Number(money.units || 0) + Number(money.nanos || 0) / 1e9
    : null);
  const start = range?.startPrice;
  if (!start || String(start.currencyCode || '').toUpperCase() !== 'PHP') return null;
  const lowPhp = toAmount(start);
  const end = range.endPrice;
  const highPhp = end && String(end.currencyCode || '').toUpperCase() === 'PHP' ? toAmount(end) : null;
  if (!Number.isFinite(lowPhp) || lowPhp < 0) return null;
  const high = Number.isFinite(highPhp) && highPhp >= lowPhp ? Math.round(highPhp) : null;
  // Google's cheapest spending band starts at ₱1 ("₱1–200"), which really means
  // "under ₱200". Report it as 0 so the app shows "Under ₱200", never "₱1".
  if (lowPhp < 50) return high ? { lowPhp: 0, highPhp: high } : null;
  return { lowPhp: Math.round(lowPhp), highPhp: high };
}

function haversineKm(a, b) {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every((value) => Number.isFinite(Number(value)))) return Infinity;
  const dLat = toRad(b.lat) - toRad(a.lat);
  const dLng = toRad(b.lng) - toRad(a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function mapPlace(place) {
  const location = place.location || place.geometry?.location;
  const photo = place.photos?.[0];
  const photoResource = photo?.name || null;
  const photoAttributions = Array.isArray(photo?.authorAttributions)
    ? photo.authorAttributions.map((attribution) => ({
      name: attribution.displayName || '',
      uri: attribution.uri || '',
    }))
    : [];
  return {
    placeId: place.id || place.place_id || place.placeId || null,
    name: place.displayName?.text || place.name || 'Unnamed place',
    address: place.formattedAddress || place.formatted_address || place.vicinity || '',
    lat: location?.latitude ?? location?.lat ?? place.lat ?? null,
    lng: location?.longitude ?? location?.lng ?? place.lng ?? null,
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? place.ratingCount ?? null,
    priceLevel: place.priceLevel ?? null,
    priceRange: mapPriceRange(place.priceRange),
    openingHours: place.regularOpeningHours?.weekdayDescriptions || [],
    types: Array.isArray(place.types) ? place.types.slice(0, 6) : [],
    photoResource,
    photoAttribution: photoAttributions[0] || null,
    photoAttributions,
    photoGoogleMapsUri: photo?.googleMapsUri || '',
  };
}

const developmentPlaceCatalog = [
  { name: 'Tokyo National Museum', address: '13-9 Ueno Park, Taito City, Tokyo', category: 'museum', lat: 35.7188, lng: 139.7765, cost: 1000 },
  { name: 'Toyota Automobile Museum', address: '41-100 Yokomakura, Nagakute, Aichi', category: 'cars', lat: 35.1736, lng: 137.0878, cost: 1200 },
  { name: 'Shibuya Sky', address: '2-24-1 Shibuya, Tokyo', category: 'photography', lat: 35.6585, lng: 139.7013, cost: 2200 },
  { name: 'Tsukiji Outer Market', address: '4-16-2 Tsukiji, Chuo City, Tokyo', category: 'restaurant', lat: 35.6655, lng: 139.7708, cost: 1800 },
  { name: 'Asakusa Senso-ji', address: '2-3-1 Asakusa, Taito City, Tokyo', category: 'attraction', lat: 35.7148, lng: 139.7967, cost: 0 },
  { name: 'teamLab Borderless', address: 'Azabudai Hills, Minato City, Tokyo', category: 'photography', lat: 35.6627, lng: 139.7396, cost: 3800 },
  { name: 'Odaiba Seaside Park', address: '1-4 Daiba, Minato City, Tokyo', category: 'attraction', lat: 35.6295, lng: 139.7754, cost: 0 },
  { name: 'Tokyo Ramen Street', address: '1-9-1 Marunouchi, Chiyoda City, Tokyo', category: 'restaurant', lat: 35.6812, lng: 139.7671, cost: 1400 },
  { name: 'Shibuya Crossing', address: 'Shibuya City, Tokyo', category: 'photography', lat: 35.6595, lng: 139.7005, cost: 0 },
];

function developmentPlace(query, index = 0) {
  const text = String(query || '').toLowerCase();
  const namedMatch = developmentPlaceCatalog.find((place) => text.includes(place.name.toLowerCase()));
  const match = namedMatch || developmentPlaceCatalog.find((place) => (
    text.includes(place.category) ||
    (text.includes('food') && place.category === 'restaurant') ||
    (text.includes('photo') && place.category === 'photography') ||
    (text.includes('car') && place.category === 'cars') ||
    (text.includes('museum') && place.category === 'museum')
  )) || developmentPlaceCatalog[index % developmentPlaceCatalog.length];
  return {
    placeId: `mock-place-${match.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: match.name,
    address: match.address,
    lat: match.lat,
    lng: match.lng,
    category: match.category,
    types: [match.category],
    rating: 4.5,
    ratingCount: 120,
    priceLevel: match.cost > 2500 ? 'PRICE_LEVEL_EXPENSIVE' : 'PRICE_LEVEL_MODERATE',
    openingHours: ['Open daily (development sample)'],
    photoResource: null,
    photoAttribution: null,
    isDevelopmentMock: true,
    estimatedCostPhp: match.cost,
  };
}

function developmentPlaces(query, limit = 8) {
  const text = String(query || '').toLowerCase();
  const matches = developmentPlaceCatalog.filter((place) => (
    !text ||
    text.includes(place.name.toLowerCase()) ||
    text.includes(place.category) ||
    (text.includes('food') && place.category === 'restaurant') ||
    (text.includes('photo') && place.category === 'photography') ||
    (text.includes('car') && place.category === 'cars') ||
    (text.includes('museum') && place.category === 'museum')
  ));
  const source = matches.length ? matches : developmentPlaceCatalog;
  return source.slice(0, limit).map((_, index) => developmentPlace(matches.length ? _.name : query, index));
}

function developmentRoute(from, to, travelMode = 'DRIVE') {
  const latDistance = (Number(to.lat) - Number(from.lat)) * 111;
  const lngDistance = (Number(to.lng) - Number(from.lng)) * 91;
  const distanceKm = Math.max(0.4, Math.sqrt(latDistance ** 2 + lngDistance ** 2));
  return {
    distanceMeters: Math.round(distanceKm * 1000),
    durationMinutes: Math.max(8, Math.round(distanceKm * 5)),
    travelMode: String(travelMode || 'DRIVE').toUpperCase(),
    isDevelopmentMock: true,
  };
}

function parseLocation(value) {
  const [latitude, longitude] = String(value || '').split(',').map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('A location must be provided as latitude,longitude.');
  }
  return { latitude, longitude };
}

async function callGooglePlacesApi(path, payload) {
  const apiKey = getMapsApiKey();
  if (!apiKey) throw new Error('Google Maps is not configured on the backend. Add GOOGLE_MAPS_API_KEY to backend/.env.');
  const cacheKey = JSON.stringify([path, payload]);
  const cached = placesSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) placesSearchCache.delete(cacheKey);
  if (placesSearchInFlight.has(cacheKey)) return placesSearchInFlight.get(cacheKey);

  const request = (async () => {
    const response = await fetch('https://places.googleapis.com/v1/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.priceRange,places.regularOpeningHours.weekdayDescriptions,places.types,places.photos.name,places.photos.authorAttributions,places.photos.googleMapsUri',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      const reason = data?.error?.message || data?.error?.status;
      throw new Error(reason ? 'Google Places request failed: ' + reason : 'Google Maps is currently unavailable.');
    }
    if (placesSearchCache.size >= 500) {
      const now = Date.now();
      for (const [key, entry] of placesSearchCache) {
        if (entry.expiresAt <= now || placesSearchCache.size >= 450) placesSearchCache.delete(key);
      }
    }
    placesSearchCache.set(cacheKey, { value: data, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    return data;
  })();
  placesSearchInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    placesSearchInFlight.delete(cacheKey);
  }
}

async function callGoogleRoutesApi(payload) {
  const apiKey = getMapsApiKey();
  if (!apiKey) throw new Error('Google Maps is not configured on the backend. Add GOOGLE_MAPS_API_KEY to backend/.env.');
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation,routes.legs.distanceMeters,routes.legs.duration',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        const reason = data?.error?.message || data?.error?.status;
        const error = new Error(reason ? `Google Routes request failed: ${reason}` : 'Google Maps is currently unavailable.');
        error.statusCode = response.status === 429 || response.status >= 500 ? 503 : 502;
        if (response.status < 500 && response.status !== 429) throw error;
        if (attempt === maxAttempts) throw error;
      } else {
        return data;
      }
    } catch (error) {
      if (error.statusCode === 502 || attempt === maxAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error('Google Routes is temporarily unavailable. Please try again.');
}

function getKnownDestinationCatalog() {
  return [
    'Banaue Rice Terraces',
    'Batangas',
    'Boracay',
    'Cebu',
    'Coron',
    'El Nido',
    'Intramuros',
    'Makati',
    'Palawan',
    'Rizal Park',
    'Sagada',
    'Siargao',
    'Tagaytay',
    'Taal Volcano',
    'Bohol',
    'Davao',
    'Ilocos Norte',
  ];
}

async function getUserProfileContext(email) {
  if (!email) {
    return {
      travelTypes: [],
      interests: [],
      preferredPlaces: [],
      recentTrips: [],
    };
  }

  const pool = await getPool();
  const userResult = await pool.query`SELECT user_id FROM dbo.users WHERE email = ${normalizeEmail(email)}`;
  if (!userResult.recordset.length) {
    return {
      travelTypes: [],
      interests: [],
      preferredPlaces: [],
      recentTrips: [],
    };
  }

  const userId = userResult.recordset[0].user_id;

  const [travelTypes, interests, preferredPlaces, recentTrips] = await Promise.all([
    pool.query`
      SELECT ts.style_name AS name
      FROM dbo.user_travel_styles uts
      JOIN dbo.travel_styles ts ON uts.style_id = ts.style_id
      WHERE uts.user_id = ${userId}
    `,
    pool.query`
      SELECT i.interest_name AS name
      FROM dbo.user_interests ui
      JOIN dbo.interests i ON ui.interest_id = i.interest_id
      WHERE ui.user_id = ${userId}
    `,
    pool.query`
      SELECT pp.place_name AS name
      FROM dbo.user_preferred_places upp
      JOIN dbo.preferred_places pp ON upp.place_id = pp.place_id
      WHERE upp.user_id = ${userId}
    `,
    pool.query`
      SELECT TOP 5 trip_title, destination, start_date, end_date, budget, status
      FROM dbo.trips
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `,
  ]);

  return {
    travelTypes: (travelTypes.recordset || []).map((row) => row.name),
    interests: (interests.recordset || []).map((row) => row.name),
    preferredPlaces: (preferredPlaces.recordset || []).map((row) => row.name),
    recentTrips: (recentTrips.recordset || []).map((row) => ({
      trip_title: row.trip_title,
      destination: row.destination,
      start_date: row.start_date,
      end_date: row.end_date,
      budget: row.budget,
      status: row.status,
    })),
  };
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

function sanitizePlanText(text) {
  return String(text || '').replace(/```json|```/gi, '').trim();
}

function createItineraryFallback(userProfile, prompt) {
  const destination = userProfile?.preferredPlaces?.[0] || 'Bohol';
  const budgetLabel = userProfile?.budget || 'Mid-Range';
  const dayCount = Number(prompt?.dayCount || 3);
  const itinerary = [];

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const dayNumber = dayIndex + 1;
    const activities = [
      {
        id: `fallback-${dayNumber}-1`,
        timeLabel: 'Morning',
        title: `Explore ${destination}`,
        location: `${destination}, Philippines`,
        note: 'Start the day with an easy sightseeing route and a local meal.',
        transportMode: 'Jeepney / Grab',
        travelMinutes: 25,
        travelDistanceKm: 12,
        estimatedActivityCostPhp: 450,
        estimatedTransportCostPhp: 240,
        estimatedTotalCostPhp: 690,
        dueAt: Date.now() + dayIndex * 86400000 + 9 * 3600000,
        iso: new Date(Date.now() + dayIndex * 86400000 + 9 * 3600000).toISOString(),
      },
      {
        id: `fallback-${dayNumber}-2`,
        timeLabel: 'Afternoon',
        title: 'Local food and scenic stops',
        location: `${destination}, Philippines`,
        note: 'Balance your travel day with a scenic stop and food spots that match the trip budget.',
        transportMode: 'Tricycle',
        travelMinutes: 18,
        travelDistanceKm: 8,
        estimatedActivityCostPhp: 620,
        estimatedTransportCostPhp: 160,
        estimatedTotalCostPhp: 780,
        dueAt: Date.now() + dayIndex * 86400000 + 14 * 3600000,
        iso: new Date(Date.now() + dayIndex * 86400000 + 14 * 3600000).toISOString(),
      },
      {
        id: `fallback-${dayNumber}-3`,
        timeLabel: 'Evening',
        title: 'Relax and prepare for the next day',
        location: `${destination}, Philippines`,
        note: 'Keep the evening relaxed with a low-stress dinner and rest period.',
        transportMode: 'Walk / Tricycle',
        travelMinutes: 15,
        travelDistanceKm: 5,
        estimatedActivityCostPhp: 520,
        estimatedTransportCostPhp: 120,
        estimatedTotalCostPhp: 640,
        dueAt: Date.now() + dayIndex * 86400000 + 18 * 3600000,
        iso: new Date(Date.now() + dayIndex * 86400000 + 18 * 3600000).toISOString(),
      },
    ];

    itinerary.push({
      dayNumber,
      dateLabel: `Day ${dayNumber}`,
      estimatedDayCostPhp: activities.reduce((sum, activity) => sum + Number(activity.estimatedTotalCostPhp || 0), 0),
      estimatedDayCostLowPhp: 0,
      estimatedDayCostHighPhp: 0,
      activities,
    });
  }

  return {
    itinerary,
    meta: {
      destination,
      budget: budgetLabel,
      source: 'backend-fallback',
      generatedAt: new Date().toISOString(),
    },
  };
}

async function callGeminiApi({ message, contextText, systemInstruction, responseMimeType = 'text/plain', maxOutputTokens = 1200, thinkingLevel = '' }) {
  const apiKey = getAiApiKey();
  if (!apiKey) {
    throw new Error('AI_API_KEY is missing. Add your Gemini API key in backend/.env.');
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: `${contextText}\n\nUser request:\n${message}` }],
      },
    ],
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    generationConfig: {
      maxOutputTokens,
      responseMimeType,
      // Gemini 3 models accept a thinking level; older models would reject it.
      ...(thinkingLevel && /^gemini-3/i.test(getAiModel()) ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getAiModel())}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' , 'x-goog-api-key': apiKey},
    body: JSON.stringify(payload),
  });

  const errorPayload = response.ok ? null : await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error(errorPayload?.error?.message || 'AI authentication failed. Check the API key in backend/.env.');
  }

  if (response.status === 429) {
    throw new Error('The AI service is rate limited. Please try again in a moment.');
  }

  if (!response.ok) {
    const reason = errorPayload?.error?.message || errorPayload?.error?.status;
    throw new Error(reason ? `Gemini request failed (${response.status}): ${reason}` : 'The AI service is currently unavailable. Please try again later.');
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';

  if (!rawText) {
    throw new Error('AI returned an empty response.');
  }

  return rawText.trim();
}

function tripBudgetSearchResponseSchema() {
  return {
    type: 'object',
    properties: {
      activityCosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            placeId: { type: 'string' },
            lowPhp: { type: ['number', 'null'] },
            highPhp: { type: ['number', 'null'] },
            basis: { type: 'string' },
            sourceUrls: { type: 'array', items: { type: 'string' } },
          },
          required: ['placeId', 'lowPhp', 'highPhp', 'basis', 'sourceUrls'],
        },
      },
    },
    required: ['activityCosts'],
  };
}

async function callGeminiSearchApi({ message, contextText = '', systemInstruction = '', responseSchema = null }) {
  const apiKey = getAiApiKey();
  if (!apiKey) throw new Error('AI_API_KEY is missing. Add your Gemini API key in backend/.env.');
  const model = getAiModel();
  const supportsSearchStructuredOutput = /^gemini-(?:3\.8-flash|3\.1-pro-preview)(?:$|-)/i.test(model);
  const generationConfig = { maxOutputTokens: 5000 };
  if (responseSchema && supportsSearchStructuredOutput) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    generationConfig.responseFormat = {
      // generateContent's responseFormat.text.mimeType is a proto enum, not
      // the free-form MIME string used by some of the other Gemini endpoints.
      text: { mimeType: 'APPLICATION_JSON', schema: responseSchema },
    };
  }
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getAiModel())}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' , 'x-goog-api-key': apiKey},
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${contextText}\n\n${message}` }] }],
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      tools: [{ google_search: {} }],
      generationConfig,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.message || data?.error?.status;
    throw new Error(reason ? `Grounded price search failed: ${reason}` : 'Grounded price search is currently unavailable.');
  }
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text || '').join('') || '';
  const groundingMetadata = candidate?.groundingMetadata || candidate?.grounding_metadata || {};
  const groundingChunks = groundingMetadata.groundingChunks || groundingMetadata.grounding_chunks || [];
  const sources = groundingChunks
    .map((chunk) => chunk.web)
    .filter((web) => web?.uri && /^https?:\/\//i.test(web.uri))
    .map((web) => ({ title: String(web.title || web.uri), url: web.uri }));
  return {
    text,
    sources: Array.from(new Map(sources.map((source) => [source.url, source])).values()),
    searchSuggestionHtml: String(groundingMetadata.searchEntryPoint?.renderedContent || groundingMetadata.search_entry_point?.rendered_content || ''),
    searchedAt: new Date().toISOString(),
  };
}

function normalizePriceBand(value) {
  if (value?.lowPhp === null || value?.lowPhp === undefined || value?.highPhp === null || value?.highPhp === undefined) return null;
  if ((typeof value.lowPhp === 'string' && !value.lowPhp.trim()) || (typeof value.highPhp === 'string' && !value.highPhp.trim())) return null;
  const lowPhp = Number(value?.lowPhp);
  const highPhp = Number(value?.highPhp);
  if (!Number.isFinite(lowPhp) || !Number.isFinite(highPhp) || lowPhp < 0 || highPhp < lowPhp || highPhp > 10000000) return null;
  return { lowPhp: Math.round(lowPhp), highPhp: Math.round(highPhp) };
}

function normalizeSourcedPriceBand(value, allowedSources) {
  const band = normalizePriceBand(value);
  if (!band) return null;
  const citedUrls = Array.isArray(value?.sourceUrls)
    ? Array.from(new Set(value.sourceUrls.map((url) => String(url || '')).filter((url) => /^https?:\/\//i.test(url))))
    : [];
  const verifiedUrls = citedUrls.filter((url) => allowedSources.has(url));
  // Prefer the exact Google grounding URL where available. Some API responses
  // omit grounding metadata, so retain direct source URLs supplied in the
  // structured result as citations rather than silently dropping the estimate.
  const sourceUrls = verifiedUrls.length
    ? verifiedUrls
    : allowedSources.size
      ? Array.from(allowedSources).slice(0, 8)
      : citedUrls;
  return sourceUrls.length ? { ...band, sourceUrls } : null;
}

function addPriceBands(bands) {
  const usable = bands.filter(Boolean);
  if (!usable.length) return null;
  return usable.reduce((sum, band) => ({
    lowPhp: sum.lowPhp + band.lowPhp,
    highPhp: sum.highPhp + band.highPhp,
  }), { lowPhp: 0, highPhp: 0 });
}

async function estimateVerifiedTripBudget({ itinerary, destination, startDate, endDate }) {
  const places = itinerary.flatMap((day) => day.activities || []).map((activity) => ({
    placeId: activity.placeId,
    name: activity.title,
    address: activity.location,
    category: activity.category || 'activity',
  }));
  const contextText = [
    `Destination: ${destination}`,
    `Dates: ${startDate} through ${endDate}`,
    `Places already selected and verified by Google Places: ${JSON.stringify(places)}`,
    'Search current web results for each listed place’s admission or activity fee. Prefer official venue pages and ticket sellers; if an official price is unavailable, use a clearly identified estimate supported by a reputable current source. The entered budget is context only and must not change the researched prices. Keep currency in PHP and convert using a current source if necessary.',
    'Return null only when you cannot find enough evidence to give a useful estimate. Do not price meals, lodging, or travel to the destination; this estimate covers the listed activities only.',
  ].join('\n');
  const prompt = `Search the web now and return one JSON object only, without markdown, shaped as {"activityCosts":[{"placeId":"exact supplied placeId","lowPhp":null,"highPhp":null,"basis":"brief price basis or why unavailable","sourceUrls":[]}]}. Return one activityCosts item per supplied place, preserving each exact placeId. Search each place by its exact name plus admission, entrance, or activity fee. For confirmed free entry use 0 for both price bounds. Include a realistic low and high range in PHP when a current source supports an exact price or reasonable estimate; explain whether it is an official price or estimate in basis. If a venue is a restaurant or shop, use 0 for activity admission unless a cover or entry fee applies. For each non-null price, include the canonical web page URL(s) that support that specific price in sourceUrls. Use direct page URLs from your search results; never invent an official price or source URL.`;
  const grounded = await callGeminiSearchApi({
    message: prompt,
    contextText,
    responseSchema: tripBudgetSearchResponseSchema(),
  });
  const parsed = extractJsonObject(grounded.text);
  if (!parsed) throw new Error('Web price search returned data that could not be read.');

  const allowedSources = new Set(grounded.sources.map((source) => source.url));
  const citationSources = new Map(grounded.sources.map((source) => [source.url, source]));
  const activityCostByPlaceId = new Map();
  for (const entry of Array.isArray(parsed.activityCosts) ? parsed.activityCosts : []) {
    const placeId = String(entry?.placeId || '');
    const band = normalizeSourcedPriceBand(entry, allowedSources);
    if (placeId && band) {
      for (const url of band.sourceUrls) {
        if (!citationSources.has(url)) {
          let title = url;
          try { title = new URL(url).hostname.replace(/^www\./, ''); } catch (error) { /* Keep the URL as its label. */ }
          citationSources.set(url, { title, url });
        }
      }
      activityCostByPlaceId.set(placeId, { ...band, basis: String(entry.basis || '') });
    }
  }
  const activityBands = places.map((place) => activityCostByPlaceId.get(String(place.placeId))).filter(Boolean);
  const activityTotal = addPriceBands(activityBands);
  const complete = places.length > 0 && activityBands.length === places.length;

  return {
    activityCosts: places.map((place) => {
      const cost = activityCostByPlaceId.get(String(place.placeId || ''));
      return cost ? {
        placeId: place.placeId,
        ...cost,
        currency: 'PHP',
        searchedAt: grounded.searchedAt,
        sources: cost.sourceUrls.map((url) => citationSources.get(url)).filter(Boolean),
      } : { placeId: place.placeId, lowPhp: null, highPhp: null, sourceUrls: [] };
    }),
    tripBudget: {
    status: complete ? 'complete-estimate' : 'partial-estimate',
    currency: 'PHP',
    startDate,
    endDate,
    searchedAt: grounded.searchedAt,
    searchSuggestionHtml: grounded.searchSuggestionHtml,
    totalLowPhp: activityTotal?.lowPhp ?? null,
    totalHighPhp: activityTotal?.highPhp ?? null,
    pricedActivityCount: activityBands.length,
    totalActivityCount: places.length,
    sources: Array.from(citationSources.values()).slice(0, 12),
    missingActivityPriceCount: Math.max(0, places.length - activityBands.length),
    },
  };
}

const sidekickToolDeclarations = [
  { name: 'getCurrentUser', description: 'Read the authenticated Sidekick user name and email.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'getUserPreferences', description: 'Read the current user travel styles, interests, and preferred places.', parameters: { type: 'OBJECT', properties: {} } },
  {
    name: 'updateUserPreferences',
    description: 'Replace the current user travel preferences.',
    parameters: {
      type: 'OBJECT',
      properties: {
        travelTypes: { type: 'ARRAY', items: { type: 'STRING' } },
        interests: { type: 'ARRAY', items: { type: 'STRING' } },
        preferredPlaces: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    },
  },
  { name: 'getTrips', description: 'Read the current user trips.', parameters: { type: 'OBJECT', properties: {} } },
  {
    name: 'createTrip',
    description: 'Create a trip owned by the current user.',
    parameters: {
      type: 'OBJECT',
      properties: {
        trip_title: { type: 'STRING' }, destination: { type: 'STRING' }, start_date: { type: 'STRING' }, end_date: { type: 'STRING' }, budget: { type: 'STRING' },
      },
      required: ['trip_title', 'destination', 'start_date'],
    },
  },
  {
    name: 'updateTrip',
    description: 'Update a trip owned by the current user.',
    parameters: {
      type: 'OBJECT',
      properties: {
        trip_id: { type: 'INTEGER' }, trip_title: { type: 'STRING' }, destination: { type: 'STRING' }, start_date: { type: 'STRING' }, end_date: { type: 'STRING' }, budget: { type: 'STRING' }, status: { type: 'STRING' },
      },
      required: ['trip_id'],
    },
  },
  {
    name: 'deleteTrip',
    description: 'Delete a trip owned by the current user after the user has confirmed.',
    parameters: { type: 'OBJECT', properties: { trip_id: { type: 'INTEGER' }, confirmed: { type: 'BOOLEAN' } }, required: ['trip_id', 'confirmed'] },
  },
  {
    name: 'searchPlaces',
    description: 'Search Google Maps for places matching a query and optional location.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING' }, location: { type: 'STRING' } },
      required: ['query'],
    },
  },
  {
    name: 'getNearbyPlaces',
    description: 'Find nearby Google Maps places by category and location.',
    parameters: {
      type: 'OBJECT',
      properties: { category: { type: 'STRING' }, location: { type: 'STRING' }, radiusMeters: { type: 'INTEGER' } },
      required: ['category', 'location'],
    },
  },
  {
    name: 'getDirections',
    description: 'Get a route, distance, and travel time between two places.',
    parameters: {
      type: 'OBJECT',
      properties: { origin: { type: 'STRING' }, destination: { type: 'STRING' }, travelMode: { type: 'STRING' } },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'addPlaceToItinerary',
    description: 'Request adding a place to the user itinerary through the existing Sidekick UI.',
    parameters: {
      type: 'OBJECT',
      properties: {       name: { type: 'STRING' }, location: { type: 'STRING' }, placeId: { type: 'STRING' }, photoResource: { type: 'STRING' }, dayNumber: { type: 'INTEGER' }, note: { type: 'STRING' } },
      required: ['name', 'location', 'dayNumber'],
    },
  },
];

async function executeSidekickTool(name, args, email) {
  const pool = await getPool();
  const normalizedEmail = normalizeEmail(email);
  const userResult = await pool.query`
    SELECT user_id, name, email
    FROM dbo.users
    WHERE email = ${normalizedEmail} AND is_verified = 1
  `;
  const user = userResult.recordset[0];
  if (!user) throw new Error('Authenticated user was not found.');

  if (name === 'getCurrentUser') return { user_id: user.user_id, name: user.name, email: user.email };
  if (name === 'getUserPreferences') return getUserProfileContext(normalizedEmail);

  if (name === 'updateUserPreferences') {
    const travelTypes = Array.isArray(args.travelTypes) ? args.travelTypes : [];
    const interests = Array.isArray(args.interests) ? args.interests : [];
    const preferredPlaces = Array.isArray(args.preferredPlaces) ? args.preferredPlaces : [];
    await pool.query`DELETE FROM dbo.user_travel_styles WHERE user_id = ${user.user_id}`;
    await pool.query`DELETE FROM dbo.user_interests WHERE user_id = ${user.user_id}`;
    await pool.query`DELETE FROM dbo.user_preferred_places WHERE user_id = ${user.user_id}`;
    for (const value of travelTypes) {
      const row = await pool.query`SELECT style_id FROM dbo.travel_styles WHERE style_name = ${String(value)}`;
      if (row.recordset[0]?.style_id) await pool.query`INSERT INTO dbo.user_travel_styles (user_id, style_id) VALUES (${user.user_id}, ${row.recordset[0].style_id})`;
    }
    for (const value of interests) {
      const row = await pool.query`SELECT interest_id FROM dbo.interests WHERE interest_name = ${String(value)}`;
      if (row.recordset[0]?.interest_id) await pool.query`INSERT INTO dbo.user_interests (user_id, interest_id) VALUES (${user.user_id}, ${row.recordset[0].interest_id})`;
    }
    for (const value of preferredPlaces) {
      const row = await pool.query`SELECT place_id FROM dbo.preferred_places WHERE place_name = ${String(value)}`;
      if (row.recordset[0]?.place_id) await pool.query`INSERT INTO dbo.user_preferred_places (user_id, place_id) VALUES (${user.user_id}, ${row.recordset[0].place_id})`;
    }
    return { travelTypes, interests, preferredPlaces };
  }

  if (name === 'getTrips') {
    const result = await pool.query`SELECT * FROM dbo.trips WHERE user_id = ${user.user_id} ORDER BY created_at DESC`;
    return result.recordset;
  }
  if (name === 'createTrip') {
    const result = await pool.query`
      INSERT INTO dbo.trips (user_id, trip_title, destination, start_date, end_date, budget, status)
      OUTPUT INSERTED.*
      VALUES (${user.user_id}, ${String(args.trip_title)}, ${String(args.destination)}, ${String(args.start_date)}, ${args.end_date || null}, ${args.budget || null}, 'draft')
    `;
    return result.recordset[0];
  }
  if (name === 'updateTrip') {
    const result = await pool.query`
      UPDATE dbo.trips
      SET trip_title = COALESCE(${args.trip_title || null}, trip_title), destination = COALESCE(${args.destination || null}, destination), start_date = COALESCE(${args.start_date || null}, start_date), end_date = COALESCE(${args.end_date || null}, end_date), budget = COALESCE(${args.budget || null}, budget), status = COALESCE(${args.status || null}, status)
      OUTPUT INSERTED.*
      WHERE trip_id = ${Number(args.trip_id)} AND user_id = ${user.user_id}
    `;
    if (!result.recordset.length) throw new Error('Trip was not found for the authenticated user.');
    return result.recordset[0];
  }
  if (name === 'deleteTrip') {
    if (args.confirmed !== true) return { requiresConfirmation: true, message: 'Please confirm before permanently deleting this trip.' };
    const tripId = Number(args.trip_id);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const ownedTrip = await new sql.Request(transaction)
        .input('tripId', sql.Int, tripId)
        .input('userId', sql.Int, user.user_id)
        .query('SELECT trip_id FROM dbo.trips WITH (UPDLOCK, HOLDLOCK) WHERE trip_id = @tripId AND user_id = @userId');
      if (!ownedTrip.recordset.length) throw new Error('Trip was not found for the authenticated user.');
      const optionalTables = await new sql.Request(transaction).query(`
        SELECT CASE WHEN OBJECT_ID(N'dbo.reminders', N'U') IS NULL THEN 0 ELSE 1 END AS reminders_available
      `);
      if (optionalTables.recordset[0]?.reminders_available) {
        await new sql.Request(transaction)
          .input('tripId', sql.Int, tripId)
          .query(`
            DELETE FROM dbo.reminders
            WHERE trip_id = @tripId
               OR activity_id IN (
                 SELECT a.activity_id
                 FROM dbo.itinerary_activities a
                 JOIN dbo.trip_days d ON d.trip_day_id = a.trip_day_id
                 WHERE d.trip_id = @tripId
               )
          `);
      }
      await new sql.Request(transaction)
        .input('tripId', sql.Int, tripId)
        .query(`
          DELETE FROM dbo.itinerary_activities
          WHERE trip_day_id IN (SELECT trip_day_id FROM dbo.trip_days WHERE trip_id = @tripId);
          DELETE FROM dbo.trip_days WHERE trip_id = @tripId;
        `);
      await new sql.Request(transaction)
        .input('tripId', sql.Int, tripId)
        .input('userId', sql.Int, user.user_id)
        .query('DELETE FROM dbo.trips WHERE trip_id = @tripId AND user_id = @userId');
      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error('AI itinerary deletion rollback failed:', rollbackError.message);
      }
      throw error;
    }
    return { deleted: true, trip_id: Number(args.trip_id) };
  }
  if (name === 'searchPlaces') {
    const data = await callGooglePlacesApi('places:searchText', {
      textQuery: String(args.query),
      ...(args.location ? { locationBias: { circle: { center: parseLocation(args.location), radius: 50000 } } } : {}),
      maxResultCount: 8,
    });
    const places = (data.places || []).slice(0, 8).map(mapPlace);
    return { places, uiAction: { type: 'SHOW_PLACES', places } };
  }
  if (name === 'getNearbyPlaces') {
    const data = await callGooglePlacesApi('places:searchNearby', {
      includedTypes: [String(args.category)],
      locationRestriction: { circle: { center: parseLocation(args.location), radius: Math.min(50000, Math.max(100, Number(args.radiusMeters) || 5000)) } },
      maxResultCount: 8,
    });
    const places = (data.places || []).slice(0, 8).map(mapPlace);
    return { places, uiAction: { type: 'SHOW_PLACES', places } };
  }
  if (name === 'getDirections') {
    const data = await callGoogleRoutesApi({
      origin: { address: String(args.origin) },
      destination: { address: String(args.destination) },
      travelMode: String(args.travelMode || 'DRIVE').toUpperCase(),
      computeAlternativeRoutes: false,
    });
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) throw new Error('No route was found between those locations.');
    return {
      origin: String(args.origin),
      destination: String(args.destination),
      distance: leg.localizedValues?.distance?.text || `${Math.round(Number(leg.distanceMeters || 0) / 1000)} km`,
      duration: leg.localizedValues?.duration?.text || leg.duration || null,
      uiAction: { type: 'SHOW_ROUTE', origin: leg.start_address, destination: leg.end_address },
    };
  }
  if (name === 'addPlaceToItinerary') {
    return {
      added: false,
      uiAction: {
        type: 'ADD_ITINERARY_ACTIVITY',
        activity: {
          title: String(args.name),
          location: String(args.location),
          placeId: String(args.placeId || ''),
          photoResource: String(args.photoResource || ''),
          dayNumber: Math.max(1, Number(args.dayNumber) || 1),
          note: String(args.note || 'Added by Sidekick AI.'),
        },
      },
    };
  }
  throw new Error(`Unsupported Sidekick tool: ${name}`);
}

async function fetchGooglePlaceReviewData(placeId) {
  const normalizedPlaceId = String(placeId || '').trim();
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(normalizedPlaceId)) throw new Error('A valid Google Place ID is required to look up reviews.');
  const apiKey = getMapsApiKey();
  if (!apiKey) throw new Error('Google Maps is not configured on the backend.');
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,reviews.rating,reviews.text,reviews.publishTime,googleMapsUri',
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.message || data?.error?.status;
    throw new Error(reason ? `Google review lookup failed: ${reason}` : 'Google reviews are currently unavailable.');
  }
  const reviews = (Array.isArray(data.reviews) ? data.reviews : []).slice(0, 5).map((review) => ({
    rating: review.rating != null && Number.isFinite(Number(review.rating)) ? Number(review.rating) : null,
    publishTime: String(review.publishTime || ''),
    text: String(review.text?.text || '').slice(0, 1200),
  })).filter((review) => review.text);
  return {
    available: true,
    rating: data.rating != null && Number.isFinite(Number(data.rating)) ? Number(data.rating) : null,
    ratingCount: data.userRatingCount != null && Number.isFinite(Number(data.userRatingCount)) ? Number(data.userRatingCount) : null,
    reviewsReturnedCount: Array.isArray(data.reviews) ? Math.min(data.reviews.length, 5) : 0,
    reviews,
    googleMapsUri: String(data.googleMapsUri || ''),
  };
}

// Picks up to four verified places from the agent's map searches for photo cards:
// places named in the reply first, otherwise the top search results.
function pickChatPlaces(uiActions, replyText) {
  const found = Array.from(new Map((uiActions || [])
    .filter((action) => action?.type === 'SHOW_PLACES' && Array.isArray(action.places))
    .flatMap((action) => action.places)
    .filter((place) => place?.placeId && place?.name)
    .map((place) => [place.placeId, place])).values());
  if (!found.length) return [];
  const text = String(replyText || '').toLowerCase();
  const nameKey = (name) => String(name || '').split(/[-,(|]/)[0].trim().toLowerCase();
  const mentioned = found.filter((place) => {
    const key = nameKey(place.name);
    return key.length >= 4 && text.includes(key);
  });
  return (mentioned.length ? mentioned : found).slice(0, 4).map((place) => ({
    placeId: place.placeId,
    name: place.name,
    address: place.address || '',
    lat: place.lat,
    lng: place.lng,
    rating: place.rating,
    ratingCount: place.ratingCount,
    priceLevel: place.priceLevel,
    types: Array.isArray(place.types) ? place.types.slice(0, 6) : [],
    openingHours: Array.isArray(place.openingHours) ? place.openingHours.slice(0, 7) : [],
    photoResource: place.photoResource || '',
    photoAttribution: place.photoAttribution || null,
  }));
}

async function generateAgentReply({ email, message, selectedDestination, history, profile }) {
  const currentProfile = await getUserProfileContext(email);
  const effectiveProfile = {
    ...currentProfile,
    ...(profile || {}),
    travelTypes: Array.isArray(profile?.travelTypes) && profile.travelTypes.length ? profile.travelTypes : currentProfile.travelTypes,
    interests: Array.isArray(profile?.interests) && profile.interests.length ? profile.interests : currentProfile.interests,
    preferredPlaces: Array.isArray(profile?.preferredPlaces) && profile.preferredPlaces.length ? profile.preferredPlaces : currentProfile.preferredPlaces,
  };
  const lowerMessage = String(message || '').toLowerCase();
  const currentUser = await executeSidekickTool('getCurrentUser', {}, email);

  if (isDevelopmentMode) {
    const actions = [];
    if (/\b(?:reviews?|reviewed|ratings?|visitor feedback|worth visiting|what do (?:visitors|people) think)\b/i.test(lowerMessage)) {
      return {
        reply: `I can’t access live visitor reviews for ${selectedDestination?.name || 'this place'} in development mode, so I can’t give a review-based assessment here.`,
        actions,
        meta: { source: 'development-mock', isDevelopmentMock: true },
      };
    }
    const replacingMuseum = /\breplace\b.*\b(cheaper|museum)\b/.test(lowerMessage);
    if (/\bremove\b.*\bmuseum\b/.test(lowerMessage) && !replacingMuseum) actions.push({ type: 'REMOVE_ITINERARY_ACTIVITY', match: 'museum' });
    if (replacingMuseum) actions.push({ type: 'REPLACE_ITINERARY_ACTIVITY', match: 'museum', activity: { title: 'Tokyo Ramen Street', location: '1-9-1 Marunouchi, Chiyoda City, Tokyo', placeId: 'mock-place-tokyo-ramen-street', dayNumber: 1, note: 'Cheaper development replacement.' } });
    if (/\bmove\b.*\bday\s*3\b/.test(lowerMessage)) actions.push({ type: 'MOVE_ITINERARY_ACTIVITY', match: 'ramen|museum', dayNumber: 3 });
    const relaxMatch = lowerMessage.match(/day\s*(\d+)[^.!?]{0,24}less tiring|less tiring[^.!?]{0,24}day\s*(\d+)|make day\s*(\d+)[^.!?]{0,24}relaxed/);
    if (relaxMatch) actions.push({ type: 'RELAX_ITINERARY_DAY', dayNumber: Number(relaxMatch[1] || relaxMatch[2] || relaxMatch[3] || 2) });
    if (/\badd\b.*\brestaurant|restaurant\b.*\bnear\b/.test(lowerMessage)) actions.push({ type: 'ADD_ITINERARY_ACTIVITY', activity: { title: 'Tokyo Ramen Street', location: '1-9-1 Marunouchi, Chiyoda City, Tokyo', placeId: 'mock-place-tokyo-ramen-street', dayNumber: 2, note: 'Development restaurant near the next activity.' } });
    return {
      reply: actions.length
        ? 'I updated your development itinerary using the requested change. Open the Itinerary tab to review it.'
        : `I captured your trip request for ${selectedDestination?.name || 'Tokyo'}. Your preferences include ${(effectiveProfile.interests || []).join(', ') || 'your saved interests'} and a ${profile?.budget || 'Mid-Range'} budget.`,
      actions,
      meta: { source: 'development-mock', isDevelopmentMock: true, preferences: effectiveProfile },
    };
  }

  // "What's my name?" / "What's my email?": answer only what was asked. Only
  // clear questions about the user's own details match ("my name", "who am I"),
  // not travel questions that merely contain "name" and "I".
  const asksOwnName = /\bmy\s+(?:full\s+)?name\b|\bwho\s+am\s+i\b/.test(lowerMessage);
  const asksOwnEmail = /\bmy\s+(?:e-?mail|email\s+address)\b|\bmy\s+(?:full\s+)?name\s+(?:and|&)\s+e-?mail\b/.test(lowerMessage);
  if ((asksOwnName || asksOwnEmail) && message.trim().length <= 80) {
    const parts = [];
    if (asksOwnName) parts.push(currentUser.name ? `Your name is ${currentUser.name}.` : 'I don\'t have a name saved for your account.');
    if (asksOwnEmail) parts.push(`Your email is ${currentUser.email}.`);
    return { reply: parts.join(' '), meta: { source: 'sidekick-direct' } };
  }

  if (/\b(saved|current|my)\b.*\b(preferences?|travel style|interests?)\b/.test(lowerMessage)) {
    const styles = currentProfile.travelTypes?.join(', ') || 'none saved';
    const interests = currentProfile.interests?.join(', ') || 'none saved';
    const places = currentProfile.preferredPlaces?.join(', ') || 'none saved';
    return { reply: `Your travel styles are ${styles}. Your interests are ${interests}. Your preferred places are ${places}.`, meta: { source: 'sidekick-direct' } };
  }

  const reviewData = selectedDestination?.reviewData || null;
  const reviewContext = reviewData?.available
    ? [
      `Google rating: ${reviewData.rating != null && Number.isFinite(Number(reviewData.rating)) ? `${reviewData.rating}/5` : 'not available'}`,
      `Google rating count: ${reviewData.ratingCount != null && Number.isFinite(Number(reviewData.ratingCount)) ? reviewData.ratingCount : 'not available'}`,
      `Review excerpts available: ${Number(reviewData.reviewsReturnedCount) || 0} (Google returns at most five, sorted by relevance).`,
      `Review excerpts: ${JSON.stringify((reviewData.reviews || []).map((review) => ({ rating: review.rating, date: review.publishTime, text: review.text })))}`,
      `Google Maps listing: ${reviewData.googleMapsUri || 'not available'}`,
    ].join('\n')
    : 'Google review data: unavailable; do not infer review themes or claim a review-based recommendation.';
  const contextText = [
    'You are Sidekick AI, the authenticated user\'s travel app agent.',
    `Current screen context: ${selectedDestination?.name || 'not selected'}`,
    `Destination review data:\n${reviewContext}`,
    `Current preferences: ${JSON.stringify(currentProfile)}`,
    `Conversation history: ${(history || []).slice(-3).map((item) => `${item.role}: ${String(item.content || '').slice(0, 500)}`).join(' | ') || 'none'}`,
  ].join('\n');
  const systemInstruction = 'You are Sidekick, a friendly Philippine travel companion. Write so anyone can understand on a phone screen: simple, everyday words, short sentences, no jargon. Start with the direct answer. Keep most replies to 2-4 short sentences; when listing options or steps, use at most 5 bullets of one short line each, with the place name in **bold** at the start. Only give longer answers when the user asks for a plan, comparison, or detailed explanation. Do not greet again in the middle of a conversation, avoid canned phrases such as "How can I help?", and do not repeat what the user said. Ask at most one short question, only when you truly need it. When the user asks about tourist spots, places to visit, or what a place is like, call searchPlaces with a precise query that includes the area (for example "Kawasan Falls, Badian, Cebu") so the app can show real photos, and mention those places by their exact names. For itinerary requests, include specific places and times, and route durations only when verified. Do not invent prices, opening hours, or route times; say plainly when they are unavailable. Never output headings for short replies, raw JSON, Markdown fences, or decorative symbols. Use Sidekick tools for current user data and mutations. Never claim a mutation succeeded unless its tool succeeds. Ask for confirmation before destructive deletion. Do not reveal credentials or internal tool details. When the user asks about their own details, answer only the item they asked for (for example, only the name for "what is my name"); never add their email or other personal details they did not ask for.';
  const reviewSystemInstruction = `${systemInstruction} When asked what visitors think or to assess a place from reviews, use only supplied Google rating and review excerpts, summarize praise or criticism only when supported, distinguish the aggregate rating from the sample of up to five excerpts, and clearly say when review details are unavailable. Paraphrase reviews rather than quoting them, and include the supplied Google Maps listing link when available.`;
  const contents = [{ role: 'user', parts: [{ text: `${contextText}\n\nUser request:\n${message}` }] }];
  const uiActions = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const apiKey = getAiApiKey();
    if (!apiKey) throw new Error('AI_API_KEY is missing. Add your Gemini API key in backend/.env.');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getAiModel())}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: reviewSystemInstruction }] }, tools: [{ functionDeclarations: sidekickToolDeclarations }], generationConfig: { maxOutputTokens: 2400, responseMimeType: 'text/plain' } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.message || data?.error?.status;
      throw new Error(reason ? `Gemini request failed (${response.status}): ${reason}` : 'The AI service is currently unavailable. Please try again later.');
    }
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const calls = parts.filter((part) => part.functionCall?.name);
    if (!calls.length) {
      let reply = parts.map((part) => part.text || '').join('').trim();
      if (!reply) throw new Error('AI returned an empty response.');
      const trimmedReply = reply.trim();
      const looksCutOff = candidate?.finishReason === 'MAX_TOKENS'
        || (trimmedReply.length >= 100 && /[\p{L}\p{N}]$/u.test(trimmedReply) && !/[.!?…][\]})"'’”]*$/u.test(trimmedReply));
      if (looksCutOff) {
        const continuationContents = [
          ...contents,
          candidate.content,
          { role: 'user', parts: [{ text: `Your previous answer ended abruptly at: "${trimmedReply.slice(-180)}". Continue directly from those final words without repeating any earlier text, and finish the thought clearly. Keep the same level of detail.` }] },
        ];
        let continuation = '';
        let continuationFinishReason = '';
        try {
          const continuationResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getAiModel())}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({ contents: continuationContents, systemInstruction: { parts: [{ text: reviewSystemInstruction }] }, generationConfig: { maxOutputTokens: 1200, responseMimeType: 'text/plain' } }),
          });
          const continuationData = await continuationResponse.json().catch(() => ({}));
          const continuationCandidate = continuationData?.candidates?.[0];
          if (continuationResponse.ok) {
            continuation = (continuationCandidate?.content?.parts || []).map((part) => part.text || '').join('').trim();
            continuationFinishReason = continuationCandidate?.finishReason || '';
          }
        } catch (error) {}
        if (continuation) {
          reply = `${trimmedReply} ${continuation}`;
          if (continuationFinishReason === 'MAX_TOKENS') reply += '\n\nI may still have been cut off. Ask me to continue for the rest.';
        } else {
          reply = `${trimmedReply}\n\nI was interrupted before I could finish. Ask me to continue and I’ll pick up from here.`;
        }
      }
      const finalReply = sanitizePlanText(reply);
      return { reply: finalReply, actions: uiActions, places: pickChatPlaces(uiActions, finalReply), meta: { source: 'gemini-agent', model: getAiModel() } };
    }
    contents.push(candidate.content);
    const functionResponses = [];
    for (const part of calls) {
      let result;
      try { result = await executeSidekickTool(part.functionCall.name, part.functionCall.args || {}, email); } catch (error) { result = { error: error.message }; }
      if (result?.uiAction) uiActions.push(result.uiAction);
      const responseValue = result && typeof result === 'object' && !Array.isArray(result)
        ? result
        : { result: result ?? null };
      functionResponses.push({
        functionResponse: {
          name: part.functionCall.name,
          ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
          response: responseValue,
        },
      });
    }
    contents.push({ role: 'user', parts: functionResponses });
  }
  throw new Error('The AI agent reached its tool-call limit.');
}

async function generateItineraryFromAi({ email, message, selectedDestination, profile, tripContext }) {
  const userProfile = profile || (email ? await getUserProfileContext(email) : { travelTypes: [], interests: [], preferredPlaces: [] });
  const destinationCatalog = getKnownDestinationCatalog();
  const selectedDestinationName = selectedDestination?.name || selectedDestination?.destination || userProfile.preferredPlaces?.[0] || 'Batangas';
  const destinationList = Array.from(new Set([selectedDestinationName, ...(userProfile.preferredPlaces || []), ...destinationCatalog])).slice(0, 12);
  const contextText = [
    'You are the Sidekick travel assistant for the Philippine travel app.',
    'Use only practical, budget-aware, itinerary planning knowledge for local destinations and activities.',
    `User interests: ${userProfile.interests?.join(', ') || 'not provided'}`,
    `Travel style: ${userProfile.travelTypes?.join(', ') || 'not provided'}`,
    `Preferred places: ${userProfile.preferredPlaces?.join(', ') || 'not provided'}`,
    `Recent trips: ${userProfile.recentTrips?.map((trip) => `${trip.trip_title || trip.destination} (${trip.destination})`).join('; ') || 'none'}`,
    `Selected destination context: ${selectedDestinationName}`,
    `Available destination catalog: ${destinationList.join(', ')}`,
    `Trip request: ${message}`,
  ].join('\n');

  const systemInstruction = `You are Sidekick AI, a Philippine travel planner. Return valid JSON only. Format: {"destination":"...","days":[{"day":1,"activities":[{"name":"...","type":"attraction|food|transport|activity","description":"...","location":"...","estimatedCost":500}]}]} . Keep costs in PHP. Use Philippine destinations and keep the plan realistic. Use the user's interests and budget when known. Do not include markdown fences. If destination is missing, infer from the user's profile or selected destination. Keep activities practical and varied.`;

  const raw = await callGeminiApi({
    message,
    contextText,
    systemInstruction,
    responseMimeType: 'application/json',
  });

  const parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.days) || !parsed.days.length) {
    throw new Error('The AI returned an invalid itinerary format.');
  }

  const itinerary = parsed.days.map((dayEntry, index) => ({
    dayNumber: Number(dayEntry.day || index + 1),
    dateLabel: `Day ${Number(dayEntry.day || index + 1)}`,
    estimatedDayCostPhp: Array.isArray(dayEntry.activities)
      ? dayEntry.activities.reduce((sum, activity) => sum + Number(activity.estimatedCost || 0), 0)
      : 0,
    estimatedDayCostLowPhp: 0,
    estimatedDayCostHighPhp: 0,
    activities: (dayEntry.activities || []).map((activity, activityIndex) => ({
      id: `ai-${index + 1}-${activityIndex + 1}`,
      timeLabel: ['Morning', 'Afternoon', 'Evening', 'Night'][activityIndex % 4] || 'Morning',
      title: String(activity.name || 'Activity'),
      location: String(activity.location || parsed.destination || 'Philippines'),
      note: String(activity.description || 'This stop fits your itinerary goals.'),
      transportMode: 'Jeepney / Grab',
      travelMinutes: 20 + activityIndex * 10,
      travelDistanceKm: 8 + activityIndex * 6,
      estimatedActivityCostPhp: Number(activity.estimatedCost || 0),
      estimatedTransportCostPhp: Math.round(Number(activity.estimatedCost || 0) * 0.28),
      estimatedTotalCostPhp: Number(activity.estimatedCost || 0) + Math.round(Number(activity.estimatedCost || 0) * 0.28),
      dueAt: Date.now() + index * 86400000 + activityIndex * 1800000,
      iso: new Date(Date.now() + index * 86400000 + activityIndex * 1800000).toISOString(),
    })),
  }));

  return {
    itinerary,
    meta: {
      destination: parsed.destination || selectedDestinationName,
      source: 'gemini-ai',
      generatedAt: new Date().toISOString(),
      budget: profile?.budget || 'Mid-Range',
      interests: profile?.interests || [],
      travelTypes: profile?.travelTypes || [],
    },
  };
}

function routeDurationMinutes(route) {
  const routeSeconds = Number.parseFloat(String(route?.duration || '').replace('s', ''));
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const seconds = Number.isFinite(routeSeconds)
    ? routeSeconds
    : legs.reduce((total, leg) => total + (Number.parseFloat(String(leg.duration || '').replace('s', '')) || 0), 0);
  return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : null;
}

function dateOnly(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
}

function inclusiveDayCount(startValue, endValue) {
  const start = dateOnly(startValue);
  const end = dateOnly(endValue);
  if (!start || !end || end < start) throw new Error('A valid start date and an end date on or after it are required.');
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

function labelDate(value) {
  const date = dateOnly(value);
  return date ? date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) : '';
}

function routeCacheKey(origin, destination, travelMode) {
  return JSON.stringify([origin, destination, String(travelMode || 'DRIVE').toUpperCase()]);
}

function hasRouteCoordinates(value) {
  const { lat, lng } = value || {};
  return lat !== null && lat !== undefined && lat !== ''
    && lng !== null && lng !== undefined && lng !== ''
    && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Number(lat) >= -90 && Number(lat) <= 90
    && Number(lng) >= -180 && Number(lng) <= 180;
}

async function calculateRoute({ origin, destination, travelMode = 'DRIVE' }) {
  const mode = String(travelMode || 'DRIVE').toUpperCase();
  const allowedModes = new Set(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT', 'TWO_WHEELER']);
  const inputError = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!allowedModes.has(mode)) throw inputError('Choose a supported travel mode.');
  if (!origin || !destination) throw inputError('Origin and destination are required to calculate a route.');
  const key = routeCacheKey(origin, destination, mode);
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result;
  if (isDevelopmentMode) {
    const knownCoords = (value) => {
      if (hasRouteCoordinates(value)) return { lat: Number(value.lat), lng: Number(value.lng) };
      const name = String(value?.name || value?.address || '').toLowerCase();
      if (name.includes('manila')) return { lat: 14.5995, lng: 120.9842 };
      if (name.includes('cebu')) return { lat: 10.3157, lng: 123.8854 };
      if (name.includes('davao')) return { lat: 7.1907, lng: 125.4553 };
      const mock = developmentPlace(name);
      return { lat: mock.lat, lng: mock.lng };
    };
    result = developmentRoute(knownCoords(origin), knownCoords(destination), mode);
  } else {
    const toWaypoint = (value) => {
      if (value.placeId) return { placeId: String(value.placeId) };
      if (hasRouteCoordinates(value)) {
        return { location: { latLng: { latitude: Number(value.lat), longitude: Number(value.lng) } } };
      }
      if (value.address || value.name) return { address: String(value.address || value.name) };
      throw inputError('Provide an address, place ID, or coordinates for both route endpoints.');
    };
    const routeRequest = {
      origin: toWaypoint(origin),
      destination: toWaypoint(destination),
      computeAlternativeRoutes: false,
    };
    let resolvedMode = mode;
    let data = await callGoogleRoutesApi({ ...routeRequest, travelMode: resolvedMode });
    let route = data.routes?.[0];
    if (!route && mode === 'DRIVE') {
      resolvedMode = 'TRANSIT';
      data = await callGoogleRoutesApi({ ...routeRequest, travelMode: resolvedMode });
      route = data.routes?.[0];
    }
    if (!route) {
      throw Object.assign(
        new Error('Google Maps could not find a driving or public-transit route between these locations. Try a different starting point or destination.'),
        { statusCode: 422 },
      );
    }
    const legs = Array.isArray(route.legs) ? route.legs : [];
    const distanceMeters = Number(route.distanceMeters ?? legs.reduce((sum, leg) => sum + Number(leg.distanceMeters || 0), 0));
    const durationMinutes = routeDurationMinutes(route);
    if (!(distanceMeters > 0) || !durationMinutes) {
      throw Object.assign(new Error('The Routes API returned incomplete distance or duration data.'), { statusCode: 502 });
    }
    result = {
      distanceMeters,
      durationMinutes,
      travelMode: resolvedMode,
      encodedPolyline: route.polyline?.encodedPolyline || null,
      source: 'google-routes',
    };
  }
  if (routeCache.size >= 500) routeCache.delete(routeCache.keys().next().value);
  routeCache.set(key, { value: result, expiresAt: Date.now() + 10 * 60 * 1000 });
  return result;
}

async function findVerifiedPlaces(query, destination) {
  if (isDevelopmentMode) return developmentPlaces(`${query} ${destination}`, 5);
  const data = await callGooglePlacesApi('places:searchText', {
    textQuery: `${String(query).trim()} in ${String(destination).trim()}`,
    maxResultCount: 5,
  });
  return (data.places || [])
    .map(mapPlace)
    .filter((place) => place.placeId && Number.isFinite(place.lat) && Number.isFinite(place.lng));
}

async function calculateVerifiedRoute(from, to, travelMode = 'DRIVE') {
  return calculateRoute({ origin: from, destination: to, travelMode });
}

async function generateVerifiedItineraryFromAi({ email, message, selectedDestination, profile, origin, includeBudgetResearch = false }) {
  const userProfile = profile || (email ? await getUserProfileContext(email) : {});
  const destination = selectedDestination?.name || selectedDestination?.destination || userProfile.preferredPlaces?.[0];
  if (!destination) throw new Error('Please provide a destination before generating an itinerary.');
  const startDate = profile?.startDate || new Date().toISOString().slice(0, 10);
  if (!dateOnly(startDate)) throw new Error('A valid trip start date is required.');
  const durationDays = profile?.endDate
    ? inclusiveDayCount(startDate, profile.endDate)
    : Math.max(1, Math.min(14, Number(profile?.durationDays || profile?.dayCount || String(message || '').match(/\b(\d{1,2})\s*day/i)?.[1] || 3)));
  const endDate = profile?.endDate || new Date(Date.parse(`${startDate}T00:00:00Z`) + (durationDays - 1) * 86400000).toISOString().slice(0, 10);
  if (durationDays < 1 || durationDays > 14) throw new Error('Itineraries can cover between 1 and 14 days.');
  const maxActivitiesPerDay = Math.max(2, Math.min(3, Math.floor(32 / durationDays)));
  const requestedMode = String(profile?.transportation || '').toUpperCase();
  const travelMode = ['DRIVE', 'TRANSIT', 'WALK', 'BICYCLE'].includes(requestedMode) ? requestedMode : 'DRIVE';
  const parsedBudgetAmount = Number(String(profile?.budgetAmountPhp ?? '').replace(/[₱,\s]/g, ''));
  const budgetAmountPhp = Number.isSafeInteger(parsedBudgetAmount) && parsedBudgetAmount > 0 && parsedBudgetAmount <= 100000000
    ? parsedBudgetAmount
    : null;
  const activityBudgetTargetPhp = budgetAmountPhp ? Math.floor(budgetAmountPhp * 0.25) : null;
  const dailyActivityBudgetTargetPhp = activityBudgetTargetPhp ? Math.floor(activityBudgetTargetPhp / durationDays) : null;
  const stay = profile?.stay && String(profile.stay.name || '').trim() ? {
    name: String(profile.stay.name).trim().slice(0, 160),
    address: String(profile.stay.address || '').trim().slice(0, 240),
    placeId: String(profile.stay.placeId || '').slice(0, 180),
    lat: Number.isFinite(Number(profile.stay.lat)) ? Number(profile.stay.lat) : null,
    lng: Number.isFinite(Number(profile.stay.lng)) ? Number(profile.stay.lng) : null,
    nightlyLowPhp: Number.isFinite(Number(profile.stay.nightlyLowPhp)) ? Number(profile.stay.nightlyLowPhp) : null,
    nightlyHighPhp: Number.isFinite(Number(profile.stay.nightlyHighPhp)) ? Number(profile.stay.nightlyHighPhp) : null,
  } : null;

  if (isDevelopmentMode) {
    const request = String(message || '').toLowerCase();
    const activityQueriesByDay = [
      ['Tokyo National Museum museum', 'Shibuya Sky photography'],
      ['Toyota Automobile Museum cars', 'Tsukiji Outer Market restaurant'],
      ['Asakusa Senso-ji attraction', 'teamLab Borderless photography'],
      ['Tokyo Ramen Street restaurant', 'Odaiba Seaside Park attraction'],
    ];
    const activitiesByDay = Array.from({ length: durationDays }, (_, dayIndex) => {
      const count = String(profile?.pace || '').toLowerCase() === 'relaxed' || request.includes('relaxed') ? 2 : 3;
      const dayQueries = activityQueriesByDay[dayIndex % activityQueriesByDay.length];
      return dayQueries.slice(0, count).map((query, activityIndex) => {
        const place = developmentPlace(query, dayIndex + activityIndex);
        const dueAt = Date.parse(`${startDate}T09:00:00Z`) + dayIndex * 86400000 + activityIndex * 3600000;
        return {
          id: `mock-${dayIndex + 1}-${activityIndex + 1}`,
          timeLabel: ['Morning', 'Afternoon', 'Evening'][activityIndex] || 'Flexible',
          title: place.name,
          location: place.address,
          locationAddress: place.address,
          placeId: place.placeId,
          locationCoords: { lat: place.lat, lng: place.lng },
          photoResource: null,
          note: `Development itinerary activity matching ${place.category} and your preferences.`,
          transportMode: 'MOCK_ROUTE',
          travelMinutes: activityIndex ? developmentRoute(developmentPlace(dayQueries[activityIndex - 1]), place).durationMinutes : 0,
          travelDistanceKm: activityIndex ? developmentRoute(developmentPlace(dayQueries[activityIndex - 1]), place).distanceMeters / 1000 : 0,
          estimatedActivityCostPhp: place.estimatedCostPhp,
          estimatedTransportCostPhp: activityIndex ? 180 : 0,
          estimatedTotalCostPhp: place.estimatedCostPhp + (activityIndex ? 180 : 0),
          dueAt,
          iso: new Date(dueAt).toISOString(),
        };
      });
    });
    return {
      itinerary: activitiesByDay.map((activities, index) => ({
        dayNumber: index + 1,
        dateLabel: labelDate(new Date(Date.parse(`${startDate}T00:00:00Z`) + index * 86400000).toISOString()),
        estimatedDayCostPhp: activities.reduce((sum, activity) => sum + activity.estimatedTotalCostPhp, 0),
        estimatedDayCostLowPhp: activities.reduce((sum, activity) => sum + activity.estimatedTotalCostPhp, 0),
        estimatedDayCostHighPhp: activities.reduce((sum, activity) => sum + activity.estimatedTotalCostPhp, 0),
        activities,
      })),
      meta: {
        destination,
        startDate,
        endDate,
        durationDays,
        source: 'development-mock',
        generatedAt: new Date().toISOString(),
        budget: profile?.budget || userProfile.budget || 'Mid-Range',
        currency: 'PHP',
        preferences: {
          interests: userProfile.interests || [],
          travelTypes: userProfile.travelTypes || [],
          preferredPlaces: userProfile.preferredPlaces || [],
        },
        isDevelopmentMock: true,
      },
    };
  }

  const planningContext = [
    'You are preparing a preliminary travel itinerary plan.',
    `Destination: ${destination}`,
    `Interests: ${(userProfile.interests || []).join(', ') || 'not provided'}`,
    `Travel style: ${(userProfile.travelTypes || []).join(', ') || 'not provided'}`,
    `Whole-trip budget: ${budgetAmountPhp ? `PHP ${budgetAmountPhp.toLocaleString()} total, including travel to/from, lodging, meals, local transport, activities, and a contingency` : userProfile.budget || 'not provided'}`,
    ...(activityBudgetTargetPhp ? [
      `Activity ticket/admission planning allowance: about PHP ${activityBudgetTargetPhp.toLocaleString()} total, roughly PHP ${dailyActivityBudgetTargetPhp.toLocaleString()} per day. This is an initial allocation of about 25% of the whole-trip budget, not a quote. Preserve the rest for transport, lodging, meals, and contingency; lower the activity allowance if destination travel or lodging is unusually costly.`,
    ] : []),
    `Dates: ${startDate} through ${endDate}, inclusive (${durationDays} days).`,
    `Pace: ${profile?.pace || 'not provided'}`,
    `Must-see: ${(profile?.mustSee || []).join(', ') || 'none'}`,
    `Avoid: ${(profile?.avoid || []).join(', ') || 'none'}`,
    ...(stay ? [`Lodging: the traveler is staying at ${stay.name}${stay.address ? ` (${stay.address})` : ''}. Prefer stops that are practical to reach from there.`] : []),
    `Request: ${message}`,
  ].join('\n');
  const preliminaryText = await callGeminiApi({
    message,
    contextText: planningContext,
    systemInstruction: `Return JSON only: {"destination":"...","durationDays":${durationDays},"days":[{"day":1,"theme":"...","activities":[{"searchQuery":"exact name of one real place","category":"attraction|museum|park|beach|landmark|activity|shopping","durationMinutes":90,"notes":"..."}]}]}. Return exactly ${durationDays} days from ${startDate} through ${endDate}, with 2-${maxActivitiesPerDay} activities per day. Every searchQuery must be the exact, official name of one specific, real, currently operating tourist spot in or near the selected destination (never a generic category such as "beach" or "museum"), because it is looked up on Google Maps and the top match is used. Do not include restaurants, cafes, or hotels; the traveler picks meals and lodging separately. Order each day's activities so consecutive stops are close to each other. Keep activities within the selected destination area and match the user's interests.`
      + ` Treat the stated budget as the ceiling for the whole trip, not just admission tickets. When the user provided a numeric budget, use the activity allowance as a target across the days: favor worthwhile free or low-cost places, then include the best paid experiences that fit. Use the allowance deliberately without forcing the user to spend it all; leave the rest for transport, lodging, meals, and contingency. Avoid repeating places. Never invent place IDs, addresses, ratings, opening hours, ticket prices, transportation fares, or travel times. Leave unverified prices unavailable.`,
    responseMimeType: 'application/json',
    maxOutputTokens: 3000,
    thinkingLevel: 'low',
  });
  const preliminary = extractJsonObject(preliminaryText);
  if (!preliminary?.days?.length) throw new Error('The AI returned an invalid preliminary itinerary.');
  if (preliminary.days.length !== durationDays) throw new Error(`The AI returned ${preliminary.days.length} days, but ${durationDays} days were requested.`);

  const requestedActivities = preliminary.days.flatMap((day, dayIndex) => (day.activities || []).slice(0, maxActivitiesPerDay).map((activity, activityIndex) => ({
    ...activity,
    day: dayIndex + 1,
    activityIndex,
    sourceKey: `d${dayIndex + 1}a${activityIndex + 1}`,
    theme: String(day.theme || ''),
  })));
  const placeResults = await Promise.all(requestedActivities.map(async (activity) => {
    try {
      return { activity, places: await findVerifiedPlaces(activity.searchQuery || activity.category, destination) };
    } catch (error) {
      return { activity, places: [], lookupError: error.message };
    }
  }));
  const verifiedPlaces = Array.from(new Map(placeResults.flatMap((result) => result.places).map((place) => [place.placeId, place])).values());
  if (!verifiedPlaces.length) throw new Error('Google Places could not verify any locations for this itinerary.');

  const candidateSets = placeResults.map(({ activity, places }) => ({
    sourceKey: activity.sourceKey,
    day: activity.day,
    searchQuery: activity.searchQuery,
    category: activity.category,
    candidates: places.slice(0, 3).map((place) => ({
      placeId: place.placeId, name: place.name, address: place.address,
      lat: place.lat, lng: place.lng, rating: place.rating,
      ratingCount: place.ratingCount, types: place.types, priceLevel: place.priceLevel,
    })),
  }));
  let candidatePriceResearch = null;
  const candidatePriceByPlaceId = new Map();
  if (includeBudgetResearch && budgetAmountPhp) {
    const researchCandidates = [];
    const seenCandidateIds = new Set();
    // Price each activity's best candidate first, then alternatives, with a
    // bounded request so long trips do not create an unbounded Search call.
    for (let candidateRank = 0; candidateRank < 2 && researchCandidates.length < 30; candidateRank++) {
      for (const set of candidateSets) {
        const place = set.candidates[candidateRank];
        if (!place || seenCandidateIds.has(place.placeId) || researchCandidates.length >= 30) continue;
        seenCandidateIds.add(place.placeId);
        researchCandidates.push({
          placeId: place.placeId,
          title: place.name,
          location: place.address,
          category: set.category || 'activity',
        });
      }
    }
    if (researchCandidates.length) {
      try {
        candidatePriceResearch = await estimateVerifiedTripBudget({
          itinerary: [{ activities: researchCandidates }],
          destination,
          startDate,
          endDate,
        });
        for (const cost of candidatePriceResearch.activityCosts || []) {
          if (cost?.placeId) candidatePriceByPlaceId.set(String(cost.placeId), cost);
        }
      } catch (error) {
        console.warn('Budget-aware candidate price research was unavailable:', error.message);
      }
    }
  }
  const pricedCandidateSets = candidateSets.map((set) => ({
    ...set,
    candidates: set.candidates.map((place) => {
      const cost = candidatePriceByPlaceId.get(String(place.placeId));
      return {
        ...place,
        admissionEstimate: cost && Number.isFinite(cost.lowPhp) && Number.isFinite(cost.highPhp)
          ? { lowPhp: cost.lowPhp, highPhp: cost.highPhp, basis: cost.basis || 'web estimate' }
          : null,
      };
    }),
  }));
  const candidateSetsByKey = new Map(pricedCandidateSets.map((item) => [item.sourceKey, item]));

  // Choose each stop without a second AI call. The planning call already named a
  // specific real place per slot, so Google's top verified match for that exact
  // name is used, skipping duplicates and results of the wrong kind (for example a
  // hotel returned for an attraction search). Stops are then ordered by distance.
  const isLodging = (place) => (place.types || []).some((type) => /(^|_)(lodging|hotel|motel|hostel|guest_house|bed_and_breakfast)$/.test(String(type)));
  const isFood = (place) => (place.types || []).some((type) => /restaurant|cafe|food|bakery|meal_/.test(String(type)));
  const fitsSlot = (place, category) => {
    const wanted = String(category || '').toLowerCase();
    if (/hotel/.test(wanted)) return true;
    if (/restaurant|cafe|food/.test(wanted)) return !isLodging(place);
    return !isLodging(place) && !isFood(place);
  };
  const orderByProximity = (entries) => {
    if (entries.length < 3) return entries;
    const remaining = entries.slice(1);
    const ordered = [entries[0]];
    while (remaining.length) {
      const last = ordered[ordered.length - 1].place;
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((entry, index) => {
        const distance = haversineKm(last, entry.place);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      ordered.push(remaining.splice(bestIndex, 1)[0]);
    }
    return ordered;
  };
  const verifiedById = new Map(verifiedPlaces.map((place) => [place.placeId, place]));
  const requestedByKey = new Map(requestedActivities.map((activity) => [activity.sourceKey, activity]));
  const usedPlaces = new Set();
  const selectedDays = preliminary.days.map((day, dayIndex) => {
    const selected = [];
    for (const set of pricedCandidateSets.filter((item) => item.day === dayIndex + 1)) {
      const requested = requestedByKey.get(set.sourceKey) || {};
      const place = set.candidates.find((candidate) => !usedPlaces.has(candidate.placeId) && fitsSlot(candidate, set.category))
        || set.candidates.find((candidate) => !usedPlaces.has(candidate.placeId) && !isLodging(candidate));
      if (!place || !verifiedById.has(place.placeId)) continue;
      usedPlaces.add(place.placeId);
      selected.push({
        activity: { durationMinutes: requested.durationMinutes, category: set.category || requested.category || '', notes: requested.notes || '' },
        // Keep the full verified record (photo, etc.) together with the priced candidate fields.
        place: { ...verifiedById.get(place.placeId), ...place },
        sourceKey: set.sourceKey,
      });
    }
    if (!selected.length) throw new Error(`Google Places could not verify activities for day ${dayIndex + 1}.`);
    return orderByProximity(selected);
  });

  if (candidatePriceResearch && activityBudgetTargetPhp) {
    const rebalanceWithinLimit = (entries, limit) => {
      const totalHigh = () => entries.reduce((sum, entry) => {
        const cost = candidatePriceByPlaceId.get(String(entry.place.placeId));
        return sum + (cost && Number.isFinite(cost.highPhp) ? cost.highPhp : 0);
      }, 0);
      let currentTotalHigh = totalHigh();
      if (currentTotalHigh <= limit) return;
      const selectedByCost = entries
        .map((entry) => ({ entry, cost: candidatePriceByPlaceId.get(String(entry.place.placeId)) }))
        .filter(({ cost }) => cost && Number.isFinite(cost.highPhp))
        .sort((a, b) => b.cost.highPhp - a.cost.highPhp);
      for (const { entry, cost: currentCost } of selectedByCost) {
        if (currentTotalHigh <= limit) break;
        const set = candidateSetsByKey.get(entry.sourceKey);
        const alternatives = (set?.candidates || [])
          .filter((candidate) => candidate.placeId !== entry.place.placeId && !usedPlaces.has(candidate.placeId))
          .map((candidate) => ({ candidate, cost: candidatePriceByPlaceId.get(String(candidate.placeId)) }))
          .filter(({ candidate, cost }) => cost && Number.isFinite(cost.highPhp)
            && cost.highPhp < currentCost.highPhp
            && (!entry.place.rating || !candidate.rating || candidate.rating >= entry.place.rating - 0.7))
          .sort((a, b) => a.cost.highPhp - b.cost.highPhp || Number(b.candidate.rating || 0) - Number(a.candidate.rating || 0));
        const replacement = alternatives[0];
        if (!replacement) continue;
        const projectedTotal = currentTotalHigh - currentCost.highPhp + replacement.cost.highPhp;
        if (projectedTotal >= currentTotalHigh) continue;
        usedPlaces.delete(entry.place.placeId);
        usedPlaces.add(replacement.candidate.placeId);
        entry.place = replacement.candidate;
        currentTotalHigh = projectedTotal;
      }
    };
    if (dailyActivityBudgetTargetPhp) {
      for (const day of selectedDays) rebalanceWithinLimit(day, dailyActivityBudgetTargetPhp);
    }
    rebalanceWithinLimit(selectedDays.flat(), activityBudgetTargetPhp);
  }

  let selectedBudgetResearch = null;
  if (candidatePriceResearch) {
    const selectedActivities = selectedDays.flat();
    const liveActivityCosts = selectedActivities.map(({ place }) => {
      const cost = candidatePriceByPlaceId.get(String(place.placeId));
      return cost || { placeId: place.placeId, lowPhp: null, highPhp: null, sourceUrls: [] };
    });
    const pricedBands = liveActivityCosts.filter((cost) => Number.isFinite(cost.lowPhp) && Number.isFinite(cost.highPhp));
    {
      const total = pricedBands.length ? addPriceBands(pricedBands) : null;
      const sourceMap = new Map(liveActivityCosts.flatMap((cost) => cost.sources || []).map((source) => [source.url, source]));
      selectedBudgetResearch = {
        liveActivityCosts,
        liveTripBudget: {
          status: pricedBands.length && pricedBands.length === selectedActivities.length ? 'complete-estimate' : 'partial-estimate',
          currency: 'PHP',
          startDate,
          endDate,
          searchedAt: candidatePriceResearch.tripBudget.searchedAt,
          searchSuggestionHtml: candidatePriceResearch.tripBudget.searchSuggestionHtml,
          totalLowPhp: total?.lowPhp ?? null,
          totalHighPhp: total?.highPhp ?? null,
          pricedActivityCount: pricedBands.length,
          totalActivityCount: selectedActivities.length,
          missingActivityPriceCount: Math.max(0, selectedActivities.length - pricedBands.length),
          sources: Array.from(sourceMap.values()).slice(0, 12),
        },
      };
    }
  }

  const routePairs = selectedDays.flatMap((activities, dayIndex) => activities.slice(1).map((entry, index) => ({
    day: dayIndex + 1,
    from: activities[index].place,
    to: entry.place,
  })));
  const routeResults = await Promise.all(routePairs.map(async (pair) => {
    try {
      const route = await calculateVerifiedRoute(pair.from, pair.to, travelMode);
      return { ...pair, route, unavailableReason: '' };
    } catch (error) {
      return { ...pair, route: null, unavailableReason: 'Route time unavailable; schedule uses a 30-minute transfer buffer.' };
    }
  }));
  const routeByEdge = new Map(routeResults.map((entry) => [`${entry.day}:${entry.from.placeId}:${entry.to.placeId}`, entry]));
  const formatScheduleTime = (minutes) => {
    const hour24 = Math.floor(minutes / 60) % 24;
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    return `${hour24 % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
  };
  const itinerary = selectedDays.map((activities, dayIndex) => {
    let scheduleMinute = 9 * 60;
    const scheduledActivities = activities.map(({ activity, place }, activityIndex) => {
      const previous = activityIndex ? activities[activityIndex - 1].place : null;
      const routeEntry = previous ? routeByEdge.get(`${dayIndex + 1}:${previous.placeId}:${place.placeId}`) : null;
      if (previous) scheduleMinute += (routeEntry?.route?.durationMinutes || 30) + 15;
      const dueAt = Date.parse(`${startDate}T00:00:00Z`) + dayIndex * 86400000 + scheduleMinute * 60000;
      const durationMinutes = Math.max(30, Math.min(240, Math.round(Number(activity.durationMinutes) || 90)));
      const result = {
        id: `verified-${dayIndex + 1}-${activityIndex + 1}`,
        timeLabel: formatScheduleTime(scheduleMinute),
        durationMinutes,
        title: place.name,
        location: place.address,
        category: String(activity.category || ''),
        placeId: place.placeId,
        photoResource: place.photoResource || '',
        locationCoords: { lat: place.lat, lng: place.lng },
        note: String(activity.notes || ''),
        routeStatus: routeEntry?.unavailableReason || '',
        transportMode: routeEntry?.route?.travelMode || travelMode,
        travelMinutes: routeEntry?.route?.durationMinutes ?? null,
        travelDistanceKm: routeEntry?.route ? routeEntry.route.distanceMeters / 1000 : null,
        estimatedActivityCostPhp: null,
        estimatedTransportCostPhp: null,
        estimatedTotalCostPhp: null,
        dueAt,
        iso: new Date(dueAt).toISOString(),
      };
      scheduleMinute += durationMinutes;
      return result;
    });
    return {
      dayNumber: dayIndex + 1,
      dateLabel: labelDate(new Date(Date.parse(`${startDate}T00:00:00Z`) + dayIndex * 86400000).toISOString()),
      estimatedDayCostPhp: null,
      estimatedDayCostLowPhp: null,
      estimatedDayCostHighPhp: null,
      activities: scheduledActivities,
    };
  });

  return {
    itinerary,
    meta: {
      destination,
      startDate,
      endDate,
      durationDays,
      source: 'gemini-google-verified',
      generatedAt: new Date().toISOString(),
      budget: budgetAmountPhp ? `PHP ${budgetAmountPhp.toLocaleString()} total` : userProfile.budget || null,
      budgetAmountPhp,
      activityBudgetTargetPhp,
      dailyActivityBudgetTargetPhp,
      ...(selectedBudgetResearch || {}),
      currency: 'PHP',
      verifiedPlaceCount: verifiedPlaces.length,
      ...(stay ? { stay } : {}),
      origin: origin ? {
        name: String(origin.name || '').slice(0, 120),
        address: String(origin.address || '').slice(0, 240),
        placeId: String(origin.placeId || '').slice(0, 160),
        lat: Number.isFinite(Number(origin.lat)) ? Number(origin.lat) : null,
        lng: Number.isFinite(Number(origin.lng)) ? Number(origin.lng) : null,
      } : null,
      travelMode,
    },
  };
}

async function generateChatReply({ email, message, selectedDestination, history, profile }) {
  const userProfile = profile || (email ? await getUserProfileContext(email) : { travelTypes: [], interests: [], preferredPlaces: [] });
  const destinationName = selectedDestination?.name || selectedDestination?.destination || userProfile.preferredPlaces?.[0] || '';
  const contextText = [
    'You are the Sidekick AI travel assistant for the Philippines.',
    'Use the user profile and destination context when available and avoid asking for information the user already supplied.',
    `User travel style: ${userProfile.travelTypes?.join(', ') || 'not provided'}`,
    `User interests: ${userProfile.interests?.join(', ') || 'not provided'}`,
    `Preferred places: ${userProfile.preferredPlaces?.join(', ') || 'not provided'}`,
    `Selected destination: ${destinationName || 'not selected'}`,
    `Conversation history: ${(history || []).slice(-6).map((item) => `${item.role}: ${item.content}`).join(' | ') || 'none'}`,
  ].join('\n');

  const systemInstruction = `You are Sidekick AI, a helpful Philippine travel planner. Match the answer length to the request: simple questions can be brief, while travel planning, budgets, comparisons, and explanations should include enough specific detail to be useful. For itinerary information, use verified places, scheduled times, estimated visit durations, and route durations only when available. Do not invent prices or travel times; state clearly when information is unavailable. Keep the answer practical, friendly, and specific to Philippine destinations, food, beaches, attractions, and transportation. Do not reveal API keys or internal implementation details.`;

  let reply = '';
  try {
    reply = await callGeminiApi({ message, contextText, systemInstruction, responseMimeType: 'text/plain' });
  } catch (error) {
    throw error;
  }

  const itineraryIntent = /(plan|itinerary|trip|travel plan|day trip|2-day|3-day|4-day)/i.test(message) && (destinationName || userProfile.preferredPlaces?.length || userProfile.interests?.length);
  if (!itineraryIntent) {
    return { reply: sanitizePlanText(reply) };
  }

  const generated = await generateVerifiedItineraryFromAi({ email, message, selectedDestination, profile: userProfile });
  return {
    reply: `${sanitizePlanText(reply)}\n\nI built a structured itinerary for ${generated.meta.destination || destinationName || 'your trip'}. Open the Itinerary tab to review it.`,
    itinerary: generated.itinerary,
    meta: generated.meta,
  };
}

function sendJson(res, status, payload) {
  // In production, unexpected server errors (500) never reveal internal details
  // such as SQL messages; the details go to the server log instead.
  if (isProduction && status === 500 && payload && typeof payload === 'object') {
    const internal = payload.error || payload.meta?.error;
    if (internal) console.error('Server error (hidden from client):', internal);
    const { meta, ...rest } = payload;
    payload = {
      ...rest,
      ...(payload.error ? { error: 'Something went wrong on the server. Please try again.' } : {}),
      ...(meta ? { meta: { ...meta, error: undefined } } : {}),
    };
  }
  return res.status(status).json(payload);
}

function parseAdminPagination(query) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) return null;
  const boundedLimit = Math.min(50, limit);
  const offset = (page - 1) * boundedLimit;
  if (!Number.isSafeInteger(offset) || offset > 2147483647) return null;
  return { page, limit: boundedLimit, offset };
}

async function getPool() {
  return sql.connect(config);
}

async function hasAdminAuditLogTable(pool) {
  const result = await pool.query`
    SELECT CASE WHEN OBJECT_ID(N'dbo.admin_auth_audit_log', N'U') IS NULL THEN 0 ELSE 1 END AS available
  `;
  return Boolean(result.recordset[0]?.available);
}

async function hasAppReviewsTable(pool) {
  const result = await pool.query`
    SELECT CASE WHEN OBJECT_ID(N'dbo.app_reviews', N'U') IS NULL THEN 0 ELSE 1 END AS available
  `;
  return Boolean(result.recordset[0]?.available);
}

async function hasUserLastActiveColumn(pool) {
  const result = await pool.query`
    SELECT CASE WHEN COL_LENGTH(N'dbo.users', N'last_active_at') IS NULL THEN 0 ELSE 1 END AS available
  `;
  return Boolean(result.recordset[0]?.available);
}

// Usage events (sign-ins and chatbot messages) need
// backend/migrations/003_app_usage_events.sql. Until it is run, nothing is
// recorded and the admin site shows these metrics as not tracked.
const APP_USAGE_EVENT_TYPES = new Set(['sign_in', 'chat_message']);
let appUsageEventsTableKnown = false;
let appUsageEventsCheckedAt = 0;

async function hasAppUsageEventsTable(pool) {
  // Once the table exists it stays; while missing, re-check at most once a minute
  // so running the migration takes effect without a restart.
  if (appUsageEventsTableKnown || Date.now() - appUsageEventsCheckedAt < 60 * 1000) {
    return appUsageEventsTableKnown;
  }
  const result = await pool.query`
    SELECT CASE WHEN OBJECT_ID(N'dbo.app_usage_events', N'U') IS NULL THEN 0 ELSE 1 END AS available
  `;
  appUsageEventsTableKnown = Boolean(result.recordset[0]?.available);
  appUsageEventsCheckedAt = Date.now();
  return appUsageEventsTableKnown;
}

// Fire-and-forget: a failed write is logged and never affects the user's request.
function recordAppUsageEvent(userId, eventType) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1 || !APP_USAGE_EVENT_TYPES.has(eventType)) return;
  void (async () => {
    try {
      const pool = await getPool();
      if (!await hasAppUsageEventsTable(pool)) return;
      await new sql.Request()
        .input('userId', sql.Int, id)
        .input('eventType', sql.VarChar(32), eventType)
        .query('INSERT INTO dbo.app_usage_events (user_id, event_type) VALUES (@userId, @eventType)');
    } catch (error) {
      console.warn(`Usage event (${eventType}) was not recorded:`, error.message);
    }
  })();
}

async function recordAdminAudit(req, eventType, outcome, username = null) {
  try {
    const pool = await getPool();
    if (!await hasAdminAuditLogTable(pool)) return false;
    await new sql.Request()
      .input('actorUsername', sql.NVarChar(128), username)
      .input('eventType', sql.NVarChar(80), eventType)
      .input('outcome', sql.NVarChar(32), outcome)
      .input('ipAddress', sql.NVarChar(64), String(req.ip || '').slice(0, 64))
      .query(`
        INSERT INTO dbo.admin_auth_audit_log (actor_username, event_type, outcome, ip_address)
        VALUES (@actorUsername, @eventType, @outcome, @ipAddress)
      `);
    return true;
  } catch (error) {
    console.error('Admin audit event could not be recorded:', error.message);
    return false;
  }
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Per-user limit for costly routes (AI and Google Maps). Use after requireAppAuth.
function limitPerUser(name, limit, windowMs) {
  return (req, res, next) => {
    if (isRateLimited(`${name}:${req.appUser.userId}`, limit, windowMs)) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return sendJson(res, 429, { error: 'You’re doing that too often. Please wait a few minutes and try again.' });
    }
    return next();
  };
}

// Forget rate-limit history older than the longest window (1 hour) so memory stays small.
setInterval(() => {
  const cutoff = Date.now() - HOUR_MS;
  for (const [key, times] of rateLimits) {
    if (!times.length || times[times.length - 1] < cutoff) rateLimits.delete(key);
  }
}, 10 * MINUTE_MS).unref();

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const entries = (rateLimits.get(key) || []).filter((time) => now - time < windowMs);
  if (entries.length >= limit) {
    rateLimits.set(key, entries);
    return true;
  }
  entries.push(now);
  rateLimits.set(key, entries);
  return false;
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function createOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function getMailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    throw new Error('Email service is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM.');
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
}

async function sendOtpEmail(email, otp) {
  await getMailer().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Your Sidekick verification code',
    text: `Your Sidekick verification code is ${otp}. It expires in 10 minutes.`,
  });
}

async function sendPasswordResetEmail(email, otp) {
  await getMailer().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Your Sidekick password reset code',
    text: `Your Sidekick password reset code is ${otp}. It expires in 10 minutes. If you did not ask to reset your password, you can ignore this email.`,
  });
}

async function validateRegistrationEmail(email) {
  const apiKey = String(process.env.ZEROBOUNCE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Email validation is not configured. Set ZEROBOUNCE_API_KEY on the backend.');
  }

  const url = new URL('https://api.zerobounce.net/v2/validate');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('email', email);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Email verification timed out.');
    }
    throw new Error('Email verification service is unreachable.');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`Email verification service returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result?.error || !['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail'].includes(result?.status)) {
    throw new Error('Email verification service returned an unexpected response.');
  }
  return { status: result.status, subStatus: result.sub_status || '' };
}

// ---- Registration email checks ------------------------------------------------
// 1) Free DNS check of the domain, 2) Reoon "power" mailbox check, 3) ZeroBounce
// only as a backup. A check that fails or times out never blocks sign-up: the
// emailed code still proves the inbox exists.
const registrationEmailCheckCache = new Map();
const REGISTRATION_EMAIL_REJECTIONS = {
  domain: 'This email address does not exist. Check the part after "@" for typos and try again.',
  mailbox: 'This email address does not exist. Check it for typos and try again.',
  disabled: 'This email account has been disabled and cannot receive email. Please use another address.',
  disposable: 'Temporary or disposable email addresses cannot be used. Please use your regular email.',
  blocked: 'This email address cannot be used for registration. Please use another address.',
};

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out.`), { code: 'ETIMEOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Public DNS used when the computer's configured DNS server does not answer
// (some machines point Node at a local DNS proxy that refuses these queries).
const publicDnsResolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
publicDnsResolver.setServers(['1.1.1.1', '8.8.8.8']);

// Runs a DNS query on the system resolver, then on public DNS if the system one fails.
async function resolveWithFallback(method, domain) {
  try {
    return await withTimeout(dns.promises[method](domain), 5000, 'DNS lookup');
  } catch (error) {
    if (['ENODATA', 'ENOTFOUND'].includes(error?.code)) throw error;
    return withTimeout(publicDnsResolver[method](domain), 5000, 'DNS lookup');
  }
}

// 'ok' when the domain can receive mail, 'no-mail' when it provably cannot,
// 'unknown' when DNS could not answer.
async function checkEmailDomain(domain) {
  const missing = (error) => ['ENODATA', 'ENOTFOUND'].includes(error?.code);
  try {
    const records = await resolveWithFallback('resolveMx', domain);
    const usable = records.filter((record) => record.exchange && record.exchange !== '.');
    if (usable.length) return 'ok';
    // A "null MX" record means the domain explicitly accepts no mail.
    if (records.length) return 'no-mail';
  } catch (error) {
    if (!missing(error)) return 'unknown';
  }
  // Without MX records, mail falls back to the domain's own address.
  for (const method of ['resolve4', 'resolve6']) {
    try {
      const addresses = await resolveWithFallback(method, domain);
      if (addresses.length) return 'ok';
    } catch (error) {
      if (!missing(error)) return 'unknown';
    }
  }
  return 'no-mail';
}

async function verifyEmailWithReoon(email, apiKey) {
  const url = new URL('https://emailverifier.reoon.com/api/v1/verify');
  url.searchParams.set('email', email);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('mode', 'power');
  const controller = new AbortController();
  // Power mode can be slow for some mail servers; do not keep the user waiting too long.
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    const status = String(data?.status || '').toLowerCase();
    if (!response.ok || !status || status === 'error') {
      throw new Error(data?.reason || data?.message || `Reoon returned HTTP ${response.status}.`);
    }
    return status;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Reoon verification timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Returns { ok: true } or { ok: false, error } with a message for the user.
async function checkRegistrationEmail(email) {
  const cached = registrationEmailCheckCache.get(email);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const remember = (result) => {
    if (registrationEmailCheckCache.size >= 1000) {
      registrationEmailCheckCache.delete(registrationEmailCheckCache.keys().next().value);
    }
    registrationEmailCheckCache.set(email, { result, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return result;
  };
  const reject = (reason) => remember({ ok: false, error: REGISTRATION_EMAIL_REJECTIONS[reason] });

  const domain = email.split('@')[1] || '';
  if (await checkEmailDomain(domain) === 'no-mail') return reject('domain');

  const reoonKey = String(process.env.REOON_API_KEY || '').trim();
  if (reoonKey) {
    try {
      const status = await verifyEmailWithReoon(email, reoonKey);
      if (status === 'invalid') return reject('mailbox');
      if (status === 'disabled') return reject('disabled');
      if (status === 'disposable') return reject('disposable');
      if (status === 'spamtrap') return reject('blocked');
      // safe, catch_all, role_account, inbox_full: the address exists or cannot be
      // disproven. unknown is not cached so a later attempt can check again.
      return status === 'unknown' ? { ok: true } : remember({ ok: true });
    } catch (error) {
      console.warn('Reoon email check unavailable:', error.message);
    }
  }

  if (String(process.env.ZEROBOUNCE_API_KEY || '').trim()) {
    try {
      const check = await validateRegistrationEmail(email);
      if (check.status === 'invalid') return reject(check.subStatus === 'mailbox_not_found' || !check.subStatus ? 'mailbox' : 'blocked');
      if (['spamtrap', 'abuse', 'do_not_mail'].includes(check.status)) {
        return reject(check.subStatus === 'disposable' ? 'disposable' : 'blocked');
      }
      return check.status === 'unknown' ? { ok: true } : remember({ ok: true });
    } catch (error) {
      console.warn('ZeroBounce email check unavailable:', error.message);
    }
  }

  return { ok: true };
}

function isUndeliverableEmailError(error) {
  const responseCode = Number(error?.responseCode || 0);
  const message = `${error?.code || ''} ${error?.response || ''} ${error?.message || ''}`;
  return [550, 551, 553].includes(responseCode)
    || /5\.1\.1|5\.1\.0|unknown user|user unknown|mailbox.*not found|recipient.*not found|address.*not found/i.test(message);
}

// Removes expired login sessions from the database (hourly).
async function cleanExpiredSessions() {
  try {
    if (!await hasSessionTables()) return;
    const pool = await getPool();
    await pool.query`
      DELETE FROM dbo.app_sessions WHERE expires_at <= SYSUTCDATETIME();
      DELETE FROM dbo.admin_api_sessions WHERE expires_at <= SYSUTCDATETIME();
    `;
  } catch (error) {
    console.error('Expired session cleanup failed:', error.message);
  }
}

async function cleanUnverifiedUsers() {
  try {
    const pool = await getPool();
    await pool.query`
      DELETE FROM dbo.otp_verifications
      WHERE user_id IN (
        SELECT user_id FROM dbo.users
        WHERE is_verified = 0 AND created_at < DATEADD(hour, -24, SYSUTCDATETIME())
      )
    `;
    await pool.query`
      DELETE FROM dbo.users
      WHERE is_verified = 0 AND created_at < DATEADD(hour, -24, SYSUTCDATETIME())
    `;
  } catch (error) {
    console.error('Unverified-account cleanup failed:', error.message);
  }
}

app.post('/api/admin/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const configured = getAdminCredentials();

  if (isRateLimited(`admin-login:${req.ip}`, 10, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many admin login attempts. Please wait a few minutes and try again.' });
  }

  if (!configured.username || !configured.password) {
    return sendJson(res, 503, {
      error: 'Admin authentication is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in backend/.env.',
    });
  }

  // A short admin password is too easy to guess on a public website.
  if (isProduction && configured.password.length < 12) {
    return sendJson(res, 503, {
      error: 'Admin sign-in is turned off: ADMIN_PASSWORD must be at least 12 characters in production.',
    });
  }

  if (!username || !password
    || !matchesAdminSecret(username, configured.username)
    || !matchesAdminSecret(password, configured.password)) {
    await recordAdminAudit(req, 'admin_login', 'failure');
    return sendJson(res, 401, { error: 'Invalid administrator credentials.' });
  }

  let token;
  try {
    token = await createAdminSession(username);
  } catch (error) {
    console.error('Admin session could not be created:', error.message);
    return sendJson(res, 503, { error: 'Sidekick could not start your admin session right now. Please try again.' });
  }
  await recordAdminAudit(req, 'admin_login', 'success', username);

  return sendJson(res, 200, { token, user: { username, role: 'super-admin' } });
});

app.post('/api/admin/logout', requireAdminAuth, async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  try {
    if (token) await deleteAdminSession(token);
  } catch (error) {
    console.error('Admin session could not be ended:', error.message);
    return sendJson(res, 503, { error: 'Sidekick could not end your admin session right now. Please try again.' });
  }
  await recordAdminAudit(req, 'admin_logout', 'success', req.admin?.username || null);
  return sendJson(res, 200, { ok: true, message: 'Admin session closed.' });
});

app.get('/api/admin/session', requireAdminAuth, (req, res) => {
  return sendJson(res, 200, {
    ok: true,
    user: { username: req.admin?.username || 'admin', role: req.admin?.role || 'super-admin' },
  });
});

app.get('/api/admin/summary', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    const lastActiveTrackingAvailable = await hasUserLastActiveColumn(pool);
    const usageTrackingAvailable = await hasAppUsageEventsTable(pool);
    const [userSummary, tripSummary, itinerarySummary, adminAuditAvailable, recentActivitySummary, usageSummary] = await Promise.all([
      pool.query`SELECT COUNT_BIG(*) AS total_users, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users, SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive_users, SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) AS verified_users, SUM(CASE WHEN is_verified = 0 THEN 1 ELSE 0 END) AS unverified_users FROM dbo.users`,
      pool.query`SELECT COUNT_BIG(*) AS total_trips, SUM(CASE WHEN created_at >= DATEADD(day, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS trips_last_30_days FROM dbo.trips`,
      pool.query`SELECT (SELECT COUNT_BIG(*) FROM dbo.trip_days) AS total_trip_days, (SELECT COUNT_BIG(*) FROM dbo.itinerary_activities) AS total_activities`,
      hasAdminAuditLogTable(pool),
      lastActiveTrackingAvailable
        // Online = checked in within 90 seconds. Read from the database so it is
        // correct when several servers share the load.
        ? pool.query(`
            SELECT COUNT_BIG(*) AS recently_active_users,
                   SUM(CASE WHEN last_active_at >= DATEADD(second, -90, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS online_users
            FROM dbo.users WHERE last_active_at >= DATEADD(day, -30, SYSUTCDATETIME())
          `)
        : Promise.resolve(null),
      usageTrackingAvailable
        ? pool.query(`
            SELECT
              SUM(CASE WHEN event_type = 'sign_in' THEN 1 ELSE 0 END) AS total_sign_ins,
              SUM(CASE WHEN event_type = 'sign_in' AND created_at >= DATEADD(day, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS sign_ins_last_30_days,
              SUM(CASE WHEN event_type = 'chat_message' THEN 1 ELSE 0 END) AS total_chat_messages,
              SUM(CASE WHEN event_type = 'chat_message' AND created_at >= DATEADD(day, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS chat_messages_last_30_days,
              COUNT(DISTINCT CASE WHEN event_type = 'chat_message' AND created_at >= DATEADD(day, -30, SYSUTCDATETIME()) THEN user_id END) AS chat_users_last_30_days,
              MIN(created_at) AS first_event_at
            FROM dbo.app_usage_events
          `)
        : Promise.resolve(null),
    ]);

    const userRow = userSummary.recordset[0] || {};
    const tripRow = tripSummary.recordset[0] || {};
    const itineraryRow = itinerarySummary.recordset[0] || {};
    const recentActivityRow = recentActivitySummary?.recordset?.[0] || {};
    const usageRow = usageSummary?.recordset?.[0] || {};
    const usageCount = (value) => (usageTrackingAvailable ? Number(value || 0) : null);

    return sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      database: {
        connected: true,
        name: config.database,
      },
      metrics: {
        totalUsers: Number(userRow.total_users || 0),
        activeUsers: Number(userRow.active_users || 0),
        inactiveUsers: Number(userRow.inactive_users || 0),
        onlineUsers: lastActiveTrackingAvailable ? Number(recentActivityRow.online_users || 0) : getOnlineAppUserCount(),
        verifiedUsers: Number(userRow.verified_users || 0),
        unverifiedUsers: Number(userRow.unverified_users || 0),
        totalTrips: Number(tripRow.total_trips || 0),
        tripsLast30Days: Number(tripRow.trips_last_30_days || 0),
        totalTripDays: Number(itineraryRow.total_trip_days || 0),
        totalActivities: Number(itineraryRow.total_activities || 0),
        // null when dbo.users.last_active_at has not been added yet.
        recentlyActiveUsers30Days: lastActiveTrackingAvailable
          ? Number(recentActivityRow.recently_active_users || 0)
          : null,
        // null when backend/migrations/003_app_usage_events.sql has not been run.
        totalSignIns: usageCount(usageRow.total_sign_ins),
        signInsLast30Days: usageCount(usageRow.sign_ins_last_30_days),
        totalChatMessages: usageCount(usageRow.total_chat_messages),
        chatMessagesLast30Days: usageCount(usageRow.chat_messages_last_30_days),
        chatUsersLast30Days: usageCount(usageRow.chat_users_last_30_days),
      },
      lastActiveTrackingAvailable,
      usageTracking: {
        available: usageTrackingAvailable,
        firstEventAt: usageRow.first_event_at || null,
      },
      flags: {
        aiConfigured: Boolean(getAiApiKey()),
        mapsConfigured: Boolean(getMapsApiKey()),
        developmentMode: isDevelopmentMode,
      },
      notes: {
        userStatusDefinition: 'Account enabled and verified statuses are reported independently using dbo.users.is_active and dbo.users.is_verified; these are not live presence.',
        onlinePresenceDefinition: 'Online users have an authenticated app session that sent a heartbeat while the app page was visible and focused within the last 90 seconds. Presence is in-memory and resets when the backend restarts.',
        activityDefinition: 'Registration and trip creation history is derived from row created_at timestamps. The database does not record AI usage, route calculations, or per-user activity events.',
        adminAuthenticationAuditAvailable: adminAuditAvailable,
        unavailableMetrics: ['AI requests', 'route calculations', 'itinerary generation method', 'per-user activity events', 'administrator data-change history'],
      },
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to retrieve the admin summary.' });
  }
});

app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    const lastActiveTrackingAvailable = await hasUserLastActiveColumn(pool);
    const usageTrackingAvailable = await hasAppUsageEventsTable(pool);
    const search = String(req.query.search || '').trim();
    const pagination = parseAdminPagination(req.query);
    const status = String(req.query.status || 'all').trim().toLowerCase();
    if (!pagination) return sendJson(res, 400, { error: 'Page and limit must be positive integers.' });
    if (search.length > 100) return sendJson(res, 400, { error: 'Search must be 100 characters or fewer.' });
    if (!['all', 'active', 'inactive', 'verified', 'unverified'].includes(status)) {
      return sendJson(res, 400, { error: 'Choose a supported user status filter.' });
    }
    // Optional sort for the Reports page. Every value maps to a fixed ORDER BY clause.
    const sort = String(req.query.sort || 'newest').trim().toLowerCase();
    const sortClauses = {
      newest: 'u.created_at DESC, u.user_id DESC',
      oldest: 'u.created_at ASC, u.user_id ASC',
      name: 'u.name ASC, u.user_id ASC',
      itineraries: 'ts.saved_itinerary_count DESC, u.created_at DESC, u.user_id DESC',
      'recent-itinerary': 'ts.last_itinerary_saved_at DESC, u.created_at DESC, u.user_id DESC',
      ...(lastActiveTrackingAvailable ? { 'last-active': 'u.last_active_at DESC, u.user_id DESC' } : {}),
      ...(usageTrackingAvailable ? {
        chat: 'us.chat_message_count DESC, u.created_at DESC, u.user_id DESC',
        'sign-ins': 'us.sign_in_count DESC, u.created_at DESC, u.user_id DESC',
        'last-sign-in': 'us.last_sign_in_at DESC, u.user_id DESC',
      } : {}),
    };
    if (!sortClauses[sort]) {
      return sendJson(res, 400, { error: 'Choose a supported sort order.' });
    }

    const request = new sql.Request();
    const filters = [];
    if (search) {
      filters.push('(name LIKE @search OR email LIKE @search)');
      request.input('search', sql.NVarChar(202), `%${search}%`);
    }
    if (status === 'active') filters.push('is_active = 1');
    if (status === 'inactive') filters.push('is_active = 0');
    if (status === 'verified') filters.push('is_verified = 1');
    if (status === 'unverified') filters.push('is_verified = 0');
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    // OUTER APPLY aggregates each user's trips separately, so one user is never
    // repeated (or double-counted) because they own several trips.
    const query = `
      SELECT u.user_id, u.name, u.email, u.created_at, u.is_active, u.is_verified,
             ${lastActiveTrackingAvailable
    ? 'u.last_active_at, CASE WHEN u.last_active_at >= DATEADD(second, -90, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS is_online'
    : 'CAST(NULL AS datetime2(7)) AS last_active_at, CAST(0 AS int) AS is_online'},
             ts.saved_itinerary_count, ts.last_itinerary_saved_at,
             ${usageTrackingAvailable
    ? 'us.chat_message_count, us.sign_in_count, us.last_sign_in_at'
    : 'CAST(NULL AS bigint) AS chat_message_count, CAST(NULL AS bigint) AS sign_in_count, CAST(NULL AS datetime2(7)) AS last_sign_in_at'}
      FROM dbo.users u
      OUTER APPLY (
        SELECT COUNT_BIG(*) AS saved_itinerary_count, MAX(t.created_at) AS last_itinerary_saved_at
        FROM dbo.trips t
        WHERE t.user_id = u.user_id
      ) ts
      ${usageTrackingAvailable ? `OUTER APPLY (
        SELECT SUM(CASE WHEN e.event_type = 'chat_message' THEN 1 ELSE 0 END) AS chat_message_count,
               SUM(CASE WHEN e.event_type = 'sign_in' THEN 1 ELSE 0 END) AS sign_in_count,
               MAX(CASE WHEN e.event_type = 'sign_in' THEN e.created_at END) AS last_sign_in_at
        FROM dbo.app_usage_events e
        WHERE e.user_id = u.user_id
      ) us` : ''}
      ${where}
      ORDER BY ${sortClauses[sort]}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    request.input('offset', sql.Int, pagination.offset);
    request.input('limit', sql.Int, pagination.limit);
    const rows = await request.query(query);

    const countRequest = new sql.Request();
    if (search) countRequest.input('search', sql.NVarChar(202), `%${search}%`);
    const countSql = `SELECT COUNT_BIG(*) AS total FROM dbo.users ${where}`;
    const countResult = await countRequest.query(countSql);

    return sendJson(res, 200, {
      page: pagination.page,
      limit: pagination.limit,
      total: Number(countResult.recordset[0]?.total || 0),
      lastActiveTrackingAvailable,
      users: (rows.recordset || []).map((user) => ({
        userId: user.user_id,
        name: user.name,
        email: user.email,
        createdAt: user.created_at,
        isActive: Boolean(user.is_active),
        isVerified: Boolean(user.is_verified),
        lastActiveAt: user.last_active_at,
        isOnline: lastActiveTrackingAvailable ? Boolean(user.is_online) : isAppUserOnline(user.user_id),
        accountState: user.is_active ? 'active' : 'inactive',
        savedItineraryCount: Number(user.saved_itinerary_count || 0),
        lastItinerarySavedAt: user.last_itinerary_saved_at || null,
        chatMessageCount: usageTrackingAvailable ? Number(user.chat_message_count || 0) : null,
        signInCount: usageTrackingAvailable ? Number(user.sign_in_count || 0) : null,
        lastSignInAt: user.last_sign_in_at || null,
      })),
      usageTrackingAvailable,
      sort,
      availableSorts: Object.keys(sortClauses),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to list users.' });
  }
});

app.get('/api/admin/app-reviews', requireAdminAuth, async (req, res) => {
  const pagination = parseAdminPagination(req.query);
  if (!pagination) return sendJson(res, 400, { error: 'Page and limit must be positive integers.' });

  try {
    const pool = await getPool();
    if (!await hasAppReviewsTable(pool)) {
      return sendJson(res, 503, { error: 'App reviews are not set up yet. Run backend/migrations/001_create_app_reviews.sql manually in SSMS.' });
    }

    const [summary, rows, count, distribution] = await Promise.all([
      pool.query`
        SELECT COUNT_BIG(*) AS total_reviews, AVG(CAST(rating AS decimal(4,2))) AS average_rating
        FROM dbo.app_reviews
      `,
      new sql.Request()
        .input('offset', sql.Int, pagination.offset)
        .input('limit', sql.Int, pagination.limit)
        .query(`
          SELECT r.review_id, r.rating, r.review_text, r.created_at, r.updated_at, u.name, u.email
          FROM dbo.app_reviews r
          JOIN dbo.users u ON u.user_id = r.user_id
          ORDER BY r.updated_at DESC, r.review_id DESC
          OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `),
      pool.query`SELECT COUNT_BIG(*) AS total FROM dbo.app_reviews`,
      pool.query`SELECT rating, COUNT_BIG(*) AS reviews FROM dbo.app_reviews GROUP BY rating`,
    ]);
    const summaryRow = summary.recordset[0] || {};
    // How many reviews gave each star rating (5 down to 1), for the breakdown bars.
    const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const row of distribution.recordset || []) {
      const stars = Math.round(Number(row.rating));
      if (stars >= 1 && stars <= 5) ratingCounts[stars] += Number(row.reviews || 0);
    }
    return sendJson(res, 200, {
      page: pagination.page,
      limit: pagination.limit,
      total: Number(count.recordset[0]?.total || 0),
      averageRating: summaryRow.average_rating == null ? null : Number(summaryRow.average_rating),
      ratingCounts,
      reviews: (rows.recordset || []).map((review) => ({
        reviewId: review.review_id,
        rating: Number(review.rating),
        review: review.review_text,
        createdAt: review.created_at,
        updatedAt: review.updated_at,
        userName: review.name || 'Unnamed user',
        userEmail: review.email,
      })),
    });
  } catch (error) {
    console.error('Admin app review listing failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to load app reviews.' });
  }
});

app.get('/api/admin/users/:userId', requireAdminAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return sendJson(res, 400, { error: 'A valid user ID is required.' });

  try {
    const pool = await getPool();
    const lastActiveTrackingAvailable = await hasUserLastActiveColumn(pool);
    const [userResult, travelStyles, interests, preferredPlaces, tripCount] = await Promise.all([
      new sql.Request().input('userId', sql.Int, userId).query(`
        SELECT user_id, name, email, created_at, updated_at, is_active, is_verified,
               ${lastActiveTrackingAvailable
    ? 'last_active_at, CASE WHEN last_active_at <= DATEADD(day, -180, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS inactive_longer_than_180_days'
    : 'CAST(NULL AS datetime2(7)) AS last_active_at, CAST(0 AS bit) AS inactive_longer_than_180_days'}
        FROM dbo.users WHERE user_id = @userId
      `),
      new sql.Request().input('userId', sql.Int, userId).query(`
        SELECT ts.style_name AS name
        FROM dbo.user_travel_styles uts
        JOIN dbo.travel_styles ts ON ts.style_id = uts.style_id
        WHERE uts.user_id = @userId ORDER BY ts.style_name
      `),
      new sql.Request().input('userId', sql.Int, userId).query(`
        SELECT i.interest_name AS name
        FROM dbo.user_interests ui
        JOIN dbo.interests i ON i.interest_id = ui.interest_id
        WHERE ui.user_id = @userId ORDER BY i.interest_name
      `),
      new sql.Request().input('userId', sql.Int, userId).query(`
        SELECT pp.place_name AS name
        FROM dbo.user_preferred_places upp
        JOIN dbo.preferred_places pp ON pp.place_id = upp.place_id
        WHERE upp.user_id = @userId ORDER BY pp.place_name
      `),
      new sql.Request().input('userId', sql.Int, userId).query(`
        SELECT COUNT_BIG(*) AS total FROM dbo.trips WHERE user_id = @userId
      `),
    ]);
    const user = userResult.recordset[0];
    if (!user) return sendJson(res, 404, { error: 'User not found.' });
    // Saved itinerary history for the Reports page (most recent 100 records).
    const itineraryHistory = await new sql.Request().input('userId', sql.Int, userId).query(`
      SELECT TOP 100 t.trip_id, t.trip_title, t.destination, t.start_date, t.budget,
             COALESCE(t.end_date, (SELECT MAX(d.day_date) FROM dbo.trip_days d WHERE d.trip_id = t.trip_id)) AS end_date,
             t.created_at, t.updated_at,
             (SELECT COUNT_BIG(*) FROM dbo.trip_days d WHERE d.trip_id = t.trip_id) AS day_count,
             (SELECT COUNT_BIG(*) FROM dbo.trip_days d
              JOIN dbo.itinerary_activities a ON a.trip_day_id = d.trip_day_id
              WHERE d.trip_id = t.trip_id) AS activity_count
      FROM dbo.trips t
      WHERE t.user_id = @userId
      ORDER BY t.created_at DESC, t.trip_id DESC
    `);
    // This user's picks from their saved itineraries (same rules as /api/admin/insights).
    const userPicks = (typeFilter, nameSql) => new sql.Request().input('userId', sql.Int, userId).query(`
      SELECT TOP 50 ${nameSql} AS name, COUNT_BIG(*) AS picks, MAX(t.created_at) AS last_picked_at
      FROM dbo.itinerary_activities a
      JOIN dbo.trip_days d ON d.trip_day_id = a.trip_day_id
      JOIN dbo.trips t ON t.trip_id = d.trip_id
      WHERE t.user_id = @userId AND ${typeFilter} AND ${nameSql} <> ''
      GROUP BY ${nameSql}
      ORDER BY picks DESC, last_picked_at DESC, name ASC
    `);
    const [pickedActivities, pickedRestaurants, pickedHotels, plannedDestinations] = await Promise.all([
      userPicks(`${PICK_TYPE_SQL} NOT IN ('restaurant', 'hotel')`, 'LTRIM(RTRIM(a.title))'),
      userPicks(`${PICK_TYPE_SQL} = 'restaurant'`, PICK_NAME_SQL),
      userPicks(`${PICK_TYPE_SQL} = 'hotel'`, PICK_NAME_SQL),
      new sql.Request().input('userId', sql.Int, userId).query(`
        SELECT TOP 50 LTRIM(RTRIM(t.destination)) AS name, COUNT_BIG(*) AS picks, MAX(t.created_at) AS last_picked_at
        FROM dbo.trips t
        WHERE t.user_id = @userId AND LTRIM(RTRIM(ISNULL(t.destination, ''))) <> ''
        GROUP BY LTRIM(RTRIM(t.destination))
        ORDER BY picks DESC, last_picked_at DESC, name ASC
      `),
    ]);
    const pickList = (result) => (result.recordset || []).map((row) => ({
      name: row.name, picks: Number(row.picks || 0), lastPickedAt: row.last_picked_at,
    }));
    const usageTrackingAvailable = await hasAppUsageEventsTable(pool);
    const [usageTotals, usageByDay] = usageTrackingAvailable
      ? await Promise.all([
        new sql.Request().input('userId', sql.Int, userId).query(`
          SELECT SUM(CASE WHEN event_type = 'chat_message' THEN 1 ELSE 0 END) AS chat_messages,
                 SUM(CASE WHEN event_type = 'sign_in' THEN 1 ELSE 0 END) AS sign_ins,
                 MAX(CASE WHEN event_type = 'sign_in' THEN created_at END) AS last_sign_in_at,
                 MAX(CASE WHEN event_type = 'chat_message' THEN created_at END) AS last_chat_message_at
          FROM dbo.app_usage_events
          WHERE user_id = @userId
        `),
        new sql.Request().input('userId', sql.Int, userId).query(`
          SELECT CONVERT(date, created_at) AS day,
                 SUM(CASE WHEN event_type = 'chat_message' THEN 1 ELSE 0 END) AS chat_messages,
                 SUM(CASE WHEN event_type = 'sign_in' THEN 1 ELSE 0 END) AS sign_ins
          FROM dbo.app_usage_events
          WHERE user_id = @userId AND created_at >= DATEADD(day, -89, CONVERT(date, SYSUTCDATETIME()))
          GROUP BY CONVERT(date, created_at)
          ORDER BY day ASC
        `),
      ])
      : [null, null];
    const usageRow = usageTotals?.recordset?.[0] || {};

    return sendJson(res, 200, {
      user: {
        name: user.name,
        email: user.email,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        isActive: Boolean(user.is_active),
        isVerified: Boolean(user.is_verified),
        lastActiveAt: user.last_active_at,
        lastActiveTrackingAvailable,
        inactiveLongerThan180Days: Boolean(user.inactive_longer_than_180_days),
        tripCount: Number(tripCount.recordset[0]?.total || 0),
        travelStyles: travelStyles.recordset.map((row) => row.name),
        interests: interests.recordset.map((row) => row.name),
        preferredPlaces: preferredPlaces.recordset.map((row) => row.name),
        itineraries: (itineraryHistory.recordset || []).map((trip) => ({
          tripId: trip.trip_id,
          title: trip.trip_title,
          destination: trip.destination,
          startDate: trip.start_date,
          endDate: trip.end_date,
          budget: trip.budget,
          createdAt: trip.created_at,
          updatedAt: trip.updated_at,
          dayCount: Number(trip.day_count || 0),
          activityCount: Number(trip.activity_count || 0),
        })),
        picks: {
          activities: pickList(pickedActivities),
          restaurants: pickList(pickedRestaurants),
          hotels: pickList(pickedHotels),
          destinations: pickList(plannedDestinations),
        },
        // null when backend/migrations/003_app_usage_events.sql has not been run.
        usageTrackingAvailable,
        chatMessageCount: usageTrackingAvailable ? Number(usageRow.chat_messages || 0) : null,
        signInCount: usageTrackingAvailable ? Number(usageRow.sign_ins || 0) : null,
        lastSignInAt: usageRow.last_sign_in_at || null,
        lastChatMessageAt: usageRow.last_chat_message_at || null,
        usageByDay: usageTrackingAvailable
          ? (usageByDay.recordset || []).map((row) => ({
            date: new Date(row.day).toISOString().slice(0, 10),
            chatMessages: Number(row.chat_messages || 0),
            signIns: Number(row.sign_ins || 0),
          }))
          : null,
      },
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load user profile.' });
  }
});

app.delete('/api/admin/users/:userId', requireAdminAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  const confirmationEmail = normalizeEmail(req.body?.confirmationEmail);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return sendJson(res, 400, { error: 'A valid user ID is required.' });
  }
  if (!confirmationEmail) {
    return sendJson(res, 400, { error: 'Enter the account email to confirm permanent deletion.' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const pool = await getPool();
    const lastActiveTrackingAvailable = await hasUserLastActiveColumn(pool);
    const optionalTables = await pool.query`
      SELECT
        CASE WHEN OBJECT_ID(N'dbo.reminders', N'U') IS NULL THEN 0 ELSE 1 END AS reminders_available,
        CASE WHEN OBJECT_ID(N'dbo.app_reviews', N'U') IS NULL THEN 0 ELSE 1 END AS app_reviews_available,
        CASE WHEN OBJECT_ID(N'dbo.otp_verifications', N'U') IS NULL THEN 0 ELSE 1 END AS otp_verifications_available
    `;
    const optionalTableState = optionalTables.recordset[0] || {};

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;
    const targetResult = await new sql.Request(transaction)
      .input('userId', sql.Int, userId)
      .query(`
        SELECT user_id, email,
               ${lastActiveTrackingAvailable
    ? 'last_active_at, CASE WHEN last_active_at <= DATEADD(day, -180, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS inactive_longer_than_180_days'
    : 'CAST(NULL AS datetime2(7)) AS last_active_at, CAST(0 AS bit) AS inactive_longer_than_180_days'}
        FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
        WHERE user_id = @userId
      `);
    const target = targetResult.recordset[0];
    if (!target) {
      await transaction.rollback();
      transactionStarted = false;
      return sendJson(res, 404, { error: 'User not found.' });
    }
    if (normalizeEmail(target.email) !== confirmationEmail) {
      await transaction.rollback();
      transactionStarted = false;
      return sendJson(res, 400, { error: 'The confirmation email does not match this account.' });
    }
    const deleteRequest = new sql.Request(transaction).input('userId', sql.Int, userId);
    const deleteStatements = [
      ...(optionalTableState.reminders_available ? ['DELETE FROM dbo.reminders WHERE user_id = @userId;'] : []),
      `
        DELETE FROM dbo.itinerary_activities
        WHERE trip_day_id IN (
          SELECT d.trip_day_id
          FROM dbo.trip_days d
          JOIN dbo.trips t ON t.trip_id = d.trip_id
          WHERE t.user_id = @userId
        );
        DELETE FROM dbo.trip_days
        WHERE trip_id IN (SELECT trip_id FROM dbo.trips WHERE user_id = @userId);
        DELETE FROM dbo.trips WHERE user_id = @userId;
        DELETE FROM dbo.user_travel_styles WHERE user_id = @userId;
        DELETE FROM dbo.user_interests WHERE user_id = @userId;
        DELETE FROM dbo.user_preferred_places WHERE user_id = @userId;
      `,
      ...(optionalTableState.app_reviews_available ? ['DELETE FROM dbo.app_reviews WHERE user_id = @userId;'] : []),
      ...(optionalTableState.otp_verifications_available ? ['DELETE FROM dbo.otp_verifications WHERE user_id = @userId;'] : []),
      'DELETE FROM dbo.users WHERE user_id = @userId;',
    ];
    await deleteRequest.query(deleteStatements.join('\n'));
    await transaction.commit();
    transactionStarted = false;

    try {
      await deleteUserAppSessions(userId);
    } catch (error) {
      // Stored sessions were already removed with the account (ON DELETE CASCADE).
      console.error('Session cleanup after account deletion failed:', error.message);
    }
    appPresence.delete(userId);
    await recordAdminAudit(req, `user_delete_${userId}`, 'success', req.admin?.username || null);
    return sendJson(res, 200, { ok: true, message: 'The account and its linked Sidekick data were permanently deleted.' });
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error('Admin user deletion rollback failed:', rollbackError.message);
      }
    }
    console.error('Admin user deletion failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to delete this account. The database may contain additional linked records; no partial deletion was committed.' });
  }
});

async function cleanExpiredItineraries() {
  if (expiredItineraryCleanupInProgress) return 0;
  expiredItineraryCleanupInProgress = true;
  let deletedCount = 0;
  const batchSize = 50;
  try {
    const pool = await getPool();
    const request = pool.request();
    request.timeout = 8000;
    const result = await request.query(`
        SET NOCOUNT ON;
        SET XACT_ABORT ON;
        SET LOCK_TIMEOUT 2500;
        DECLARE @expiredCount int = 0;
        BEGIN TRY
          BEGIN TRANSACTION;
          IF OBJECT_ID(N'tempdb..#expired_trips') IS NOT NULL DROP TABLE #expired_trips;
          SELECT TOP (${batchSize}) trip_id
          INTO #expired_trips
          FROM dbo.trips t WITH (UPDLOCK, READPAST, ROWLOCK)
          WHERE DATEADD(day, 2, CONVERT(datetime2, COALESCE(
            t.end_date,
            (SELECT MAX(d.day_date) FROM dbo.trip_days d WHERE d.trip_id = t.trip_id)
          ))) <= SYSUTCDATETIME();

          SELECT @expiredCount = COUNT(*) FROM #expired_trips;
          IF @expiredCount > 0
          BEGIN
            IF OBJECT_ID(N'dbo.reminders', N'U') IS NOT NULL
            BEGIN
              DECLARE @reminderPredicates nvarchar(max) = N'';
              IF COL_LENGTH(N'dbo.reminders', N'trip_id') IS NOT NULL
                SET @reminderPredicates = N'r.trip_id IN (SELECT trip_id FROM #expired_trips)';
              IF COL_LENGTH(N'dbo.reminders', N'activity_id') IS NOT NULL
                SET @reminderPredicates = @reminderPredicates
                  + CASE WHEN @reminderPredicates = N'' THEN N'' ELSE N' OR ' END
                  + N'r.activity_id IN (
                      SELECT a.activity_id
                      FROM dbo.itinerary_activities a
                      JOIN dbo.trip_days d ON d.trip_day_id = a.trip_day_id
                      WHERE d.trip_id IN (SELECT trip_id FROM #expired_trips)
                    )';
              IF @reminderPredicates <> N''
              BEGIN
                DECLARE @deleteReminders nvarchar(max) =
                  N'DELETE r FROM dbo.reminders r WHERE ' + @reminderPredicates;
                EXEC sys.sp_executesql @deleteReminders;
              END
            END

            DELETE FROM dbo.itinerary_activities
            WHERE trip_day_id IN (
              SELECT trip_day_id FROM dbo.trip_days
              WHERE trip_id IN (SELECT trip_id FROM #expired_trips)
            );
            DELETE FROM dbo.trip_days
            WHERE trip_id IN (SELECT trip_id FROM #expired_trips);
            DELETE FROM dbo.trips
            WHERE trip_id IN (SELECT trip_id FROM #expired_trips);
          END
          DROP TABLE #expired_trips;
          COMMIT TRANSACTION;
          SET LOCK_TIMEOUT -1;
          SELECT @expiredCount AS expired_count;
        END TRY
        BEGIN CATCH
          IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
          IF OBJECT_ID(N'tempdb..#expired_trips') IS NOT NULL DROP TABLE #expired_trips;
          SET LOCK_TIMEOUT -1;
          THROW;
        END CATCH
      `);
    const batchCount = Number(result.recordset?.[0]?.expired_count || 0);
    deletedCount += batchCount;
    if (deletedCount) console.info(`Automatically removed ${deletedCount} expired itinerary record(s).`);
    return deletedCount;
  } catch (error) {
    console.error('Expired itinerary cleanup failed:', error.message);
    throw error;
  } finally {
    expiredItineraryCleanupInProgress = false;
  }
}

app.get('/api/admin/itineraries', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    const pagination = parseAdminPagination(req.query);
    const search = String(req.query.search || '').trim();
    if (!pagination) return sendJson(res, 400, { error: 'Page and limit must be positive integers.' });
    if (search.length > 100) return sendJson(res, 400, { error: 'Search must be 100 characters or fewer.' });

    const request = new sql.Request();
    const filters = [];
    if (search) {
      filters.push('(t.trip_title LIKE @search OR t.destination LIKE @search OR u.name LIKE @search OR u.email LIKE @search)');
      request.input('search', sql.NVarChar(202), `%${search}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const query = `
      SELECT t.trip_id, t.trip_title, t.destination, t.start_date,
             COALESCE(t.end_date, (SELECT MAX(d.day_date) FROM dbo.trip_days d WHERE d.trip_id = t.trip_id)) AS end_date,
             t.budget, t.created_at, t.updated_at,
             u.name AS user_name, u.email AS user_email,
             (SELECT COUNT_BIG(*) FROM dbo.trip_days d WHERE d.trip_id = t.trip_id) AS day_count,
             (SELECT COUNT_BIG(*) FROM dbo.trip_days d
              JOIN dbo.itinerary_activities a ON a.trip_day_id = d.trip_day_id
              WHERE d.trip_id = t.trip_id) AS activity_count
      FROM dbo.trips t
      JOIN dbo.users u ON u.user_id = t.user_id
      ${where}
      ORDER BY t.created_at DESC, t.trip_id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    request.input('offset', sql.Int, pagination.offset);
    request.input('limit', sql.Int, pagination.limit);
    const rows = await request.query(query);
    const countRequest = new sql.Request();
    if (search) countRequest.input('search', sql.NVarChar(202), `%${search}%`);
    const countSql = `SELECT COUNT_BIG(*) AS total FROM dbo.trips t JOIN dbo.users u ON u.user_id = t.user_id ${where}`;
    const countResult = await countRequest.query(countSql);

    return sendJson(res, 200, {
      page: pagination.page,
      limit: pagination.limit,
      total: Number(countResult.recordset[0]?.total || 0),
      itineraries: (rows.recordset || []).map((trip) => ({
        tripId: trip.trip_id,
        title: trip.trip_title,
        destination: trip.destination,
        startDate: trip.start_date,
        endDate: trip.end_date,
        budget: trip.budget,
        createdAt: trip.created_at,
        updatedAt: trip.updated_at,
        dayCount: Number(trip.day_count || 0),
        activityCount: Number(trip.activity_count || 0),
        userName: trip.user_name || 'Unnamed user',
        userEmail: trip.user_email,
      })),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to list itineraries.' });
  }
});

app.get('/api/admin/itineraries/:tripId', requireAdminAuth, async (req, res) => {
  const tripId = Number(req.params.tripId);
  if (!Number.isSafeInteger(tripId) || tripId < 1) return sendJson(res, 400, { error: 'A valid trip ID is required.' });

  try {
    const pool = await getPool();
    const [tripResult, daysResult] = await Promise.all([
      new sql.Request().input('tripId', sql.Int, tripId).query(`
        SELECT t.trip_id, t.trip_title, t.destination, t.start_date,
               COALESCE(t.end_date, (SELECT MAX(d.day_date) FROM dbo.trip_days d WHERE d.trip_id = t.trip_id)) AS end_date,
               t.created_at, t.updated_at, u.name AS user_name, u.email AS user_email
        FROM dbo.trips t
        JOIN dbo.users u ON u.user_id = t.user_id
        WHERE t.trip_id = @tripId
      `),
      new sql.Request().input('tripId', sql.Int, tripId).query(`
        SELECT d.trip_day_id, d.day_number, d.day_date, d.title AS day_title,
               a.activity_id, a.title AS activity_title, a.location, a.activity_type,
               a.start_time, a.end_time, a.estimated_cost
        FROM dbo.trip_days d
        LEFT JOIN dbo.itinerary_activities a ON a.trip_day_id = d.trip_day_id
        WHERE d.trip_id = @tripId
        ORDER BY d.day_number, a.start_time, a.activity_id
      `),
    ]);
    const trip = tripResult.recordset[0];
    if (!trip) return sendJson(res, 404, { error: 'Trip not found.' });

    const days = new Map();
    for (const row of daysResult.recordset || []) {
      if (!days.has(row.trip_day_id)) {
        days.set(row.trip_day_id, {
          dayNumber: row.day_number,
          date: row.day_date,
          title: row.day_title,
          activities: [],
        });
      }
      if (row.activity_id !== null) {
        days.get(row.trip_day_id).activities.push({
          title: row.activity_title,
          location: row.location,
          type: row.activity_type,
          startTime: row.start_time,
          endTime: row.end_time,
          estimatedCost: row.estimated_cost,
        });
      }
    }

    return sendJson(res, 200, {
      itinerary: {
        title: trip.trip_title,
        destination: trip.destination,
        startDate: trip.start_date,
        endDate: trip.end_date,
        budget: trip.budget,
        createdAt: trip.created_at,
        updatedAt: trip.updated_at,
        userName: trip.user_name || 'Unnamed user',
        userEmail: trip.user_email,
        days: [...days.values()],
      },
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load itinerary details.' });
  }
});

app.get('/api/admin/analytics', requireAdminAuth, async (req, res) => {
  // Optional window for the dashboard range picker; defaults to the original 30 days.
  const windowDays = req.query.days === undefined ? 30 : Number(req.query.days);
  if (![7, 30, 90].includes(windowDays)) {
    return sendJson(res, 400, { error: 'Choose a 7, 30, or 90 day range.' });
  }
  try {
    const pool = await getPool();
    const today = new Date();
    const toDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const fromDate = new Date(toDate.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
    const trendRequest = () => new sql.Request().input('fromDate', sql.Date, fromDate);
    const [registrationTrend, tripTrend, travelStyles, interests, preferredPlaces, tripBudgets, preferenceCoverage] = await Promise.all([
      trendRequest().query('SELECT CONVERT(date, created_at) AS day, COUNT_BIG(*) AS count_value FROM dbo.users WHERE created_at >= @fromDate GROUP BY CONVERT(date, created_at) ORDER BY day ASC'),
      trendRequest().query('SELECT CONVERT(date, created_at) AS day, COUNT_BIG(*) AS count_value FROM dbo.trips WHERE created_at >= @fromDate GROUP BY CONVERT(date, created_at) ORDER BY day ASC'),
      pool.query`
        SELECT TOP 8 ts.style_name AS name, COUNT(DISTINCT uts.user_id) AS user_count
        FROM dbo.user_travel_styles uts
        JOIN dbo.travel_styles ts ON ts.style_id = uts.style_id
        GROUP BY ts.style_name
        ORDER BY user_count DESC, ts.style_name ASC
      `,
      pool.query`
        SELECT TOP 8 i.interest_name AS name, COUNT(DISTINCT ui.user_id) AS user_count
        FROM dbo.user_interests ui
        JOIN dbo.interests i ON i.interest_id = ui.interest_id
        GROUP BY i.interest_name
        ORDER BY user_count DESC, i.interest_name ASC
      `,
      pool.query`
        SELECT TOP 8 pp.place_name AS name, COUNT(DISTINCT upp.user_id) AS user_count
        FROM dbo.user_preferred_places upp
        JOIN dbo.preferred_places pp ON pp.place_id = upp.place_id
        GROUP BY pp.place_name
        ORDER BY user_count DESC, pp.place_name ASC
      `,
      pool.query`
        SELECT TOP 6 LTRIM(RTRIM(budget)) AS name, COUNT_BIG(*) AS trip_count
        FROM dbo.trips
        WHERE budget IS NOT NULL AND LTRIM(RTRIM(budget)) <> ''
        GROUP BY LTRIM(RTRIM(budget))
        ORDER BY trip_count DESC, name ASC
      `,
      pool.query`
        SELECT COUNT(*) AS users_with_preferences FROM (
          SELECT user_id FROM dbo.user_travel_styles
          UNION SELECT user_id FROM dbo.user_interests
          UNION SELECT user_id FROM dbo.user_preferred_places
        ) p
      `,
    ]);
    const toCounts = (result, key = 'user_count') => (result.recordset || []).map((row) => ({
      name: row.name,
      count: Number(row[key] || 0),
    }));
    const usageTrackingAvailable = await hasAppUsageEventsTable(pool);
    const usageTrend = usageTrackingAvailable
      ? await trendRequest().query(`
          SELECT CONVERT(date, created_at) AS day,
                 SUM(CASE WHEN event_type = 'sign_in' THEN 1 ELSE 0 END) AS sign_ins,
                 SUM(CASE WHEN event_type = 'chat_message' THEN 1 ELSE 0 END) AS chat_messages
          FROM dbo.app_usage_events
          WHERE created_at >= @fromDate
          GROUP BY CONVERT(date, created_at)
          ORDER BY day ASC
        `)
      : null;
    const usageSeries = (key) => (usageTrend?.recordset || [])
      .map((row) => ({ label: new Date(row.day).toISOString().slice(0, 10), value: Number(row[key] || 0) }))
      .filter((point) => point.value > 0);

    return sendJson(res, 200, {
      registrationTrend: (registrationTrend.recordset || []).map((row) => ({
        label: row.day ? new Date(row.day).toISOString().slice(0, 10) : 'unknown',
        value: Number(row.count_value || 0),
      })),
      itineraryTrend: (tripTrend.recordset || []).map((row) => ({
        label: row.day ? new Date(row.day).toISOString().slice(0, 10) : 'unknown',
        value: Number(row.count_value || 0),
      })),
      availableMetrics: ['user registrations by record creation date', 'saved trip records by record creation date'],
      unavailableMetrics: ['AI requests', 'route calculations', 'itinerary generation method', 'per-user activity'],
      // null when backend/migrations/003_app_usage_events.sql has not been run.
      signInTrend: usageTrackingAvailable ? usageSeries('sign_ins') : null,
      chatTrend: usageTrackingAvailable ? usageSeries('chat_messages') : null,
      usageTrackingAvailable,
      windowDays,
      rangeStart: fromDate.toISOString().slice(0, 10),
      rangeEnd: toDate.toISOString().slice(0, 10),
      profileSummary: {
        usersWithPreferences: Number(preferenceCoverage.recordset[0]?.users_with_preferences || 0),
        travelStyles: toCounts(travelStyles),
        interests: toCounts(interests),
        preferredPlaces: toCounts(preferredPlaces),
        savedItineraryBudgets: toCounts(tripBudgets, 'trip_count'),
      },
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load analytics.' });
  }
});

// What users plan: most planned activities, picked restaurants and hotels, and
// destinations. Source: saved itineraries in SQL Server. Restaurants and hotels
// are itinerary items the user added with category 'restaurant' or 'hotel' (the
// AI never adds them itself). Itineraries are removed after the trip ends, so
// these figures describe itineraries currently stored.
const PICK_NAME_SQL = "COALESCE(NULLIF(LTRIM(RTRIM(a.location)), ''), LTRIM(RTRIM(a.title)))";
const PICK_TYPE_SQL = "LOWER(LTRIM(RTRIM(ISNULL(a.activity_type, ''))))";

app.get('/api/admin/insights', requireAdminAuth, async (req, res) => {
  const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return sendJson(res, 400, { error: 'Limit must be a whole number from 1 to 50.' });
  }
  try {
    await getPool();
    const ranked = (sqlText) => new sql.Request().input('limit', sql.Int, limit).query(sqlText);
    // users = distinct users who planned it; picks = how many times it appears in itineraries.
    const pickRanking = (typeFilter, nameSql) => ranked(`
      SELECT TOP (@limit) ${nameSql} AS name,
             COUNT(DISTINCT t.user_id) AS users, COUNT_BIG(*) AS picks
      FROM dbo.itinerary_activities a
      JOIN dbo.trip_days d ON d.trip_day_id = a.trip_day_id
      JOIN dbo.trips t ON t.trip_id = d.trip_id
      WHERE ${typeFilter} AND ${nameSql} <> ''
      GROUP BY ${nameSql}
      ORDER BY users DESC, picks DESC, name ASC
    `);
    const [activities, activityTypes, restaurants, hotels, destinations, preferredDestinations, medians, perUserMedian, totals] = await Promise.all([
      pickRanking(`${PICK_TYPE_SQL} NOT IN ('restaurant', 'hotel')`, 'LTRIM(RTRIM(a.title))'),
      ranked(`
        SELECT TOP (@limit) COALESCE(NULLIF(${PICK_TYPE_SQL}, ''), 'custom') AS name,
               COUNT(DISTINCT t.user_id) AS users, COUNT_BIG(*) AS picks
        FROM dbo.itinerary_activities a
        JOIN dbo.trip_days d ON d.trip_day_id = a.trip_day_id
        JOIN dbo.trips t ON t.trip_id = d.trip_id
        WHERE ${PICK_TYPE_SQL} NOT IN ('restaurant', 'hotel')
        GROUP BY COALESCE(NULLIF(${PICK_TYPE_SQL}, ''), 'custom')
        ORDER BY picks DESC, users DESC, name ASC
      `),
      pickRanking(`${PICK_TYPE_SQL} = 'restaurant'`, PICK_NAME_SQL),
      pickRanking(`${PICK_TYPE_SQL} = 'hotel'`, PICK_NAME_SQL),
      ranked(`
        SELECT TOP (@limit) LTRIM(RTRIM(t.destination)) AS name,
               COUNT(DISTINCT t.user_id) AS users, COUNT_BIG(*) AS picks
        FROM dbo.trips t
        WHERE LTRIM(RTRIM(ISNULL(t.destination, ''))) <> ''
        GROUP BY LTRIM(RTRIM(t.destination))
        ORDER BY users DESC, picks DESC, name ASC
      `),
      ranked(`
        SELECT TOP (@limit) pp.place_name AS name, COUNT(DISTINCT upp.user_id) AS users, COUNT(DISTINCT upp.user_id) AS picks
        FROM dbo.user_preferred_places upp
        JOIN dbo.preferred_places pp ON pp.place_id = upp.place_id
        GROUP BY pp.place_name
        ORDER BY users DESC, name ASC
      `),
      // Medians per saved itinerary. Each trip is counted once (per-trip subtotals first).
      new sql.Request().query(`
        WITH per_trip AS (
          SELECT t.trip_id,
                 COUNT(DISTINCT d.trip_day_id) AS days,
                 SUM(CASE WHEN a.activity_id IS NOT NULL AND ${PICK_TYPE_SQL} NOT IN ('restaurant', 'hotel') THEN 1 ELSE 0 END) AS activities,
                 SUM(CASE WHEN ${PICK_TYPE_SQL} = 'restaurant' THEN 1 ELSE 0 END) AS restaurants,
                 SUM(CASE WHEN ${PICK_TYPE_SQL} = 'hotel' THEN 1 ELSE 0 END) AS hotels
          FROM dbo.trips t
          LEFT JOIN dbo.trip_days d ON d.trip_id = t.trip_id
          LEFT JOIN dbo.itinerary_activities a ON a.trip_day_id = d.trip_day_id
          GROUP BY t.trip_id
        )
        SELECT DISTINCT
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY activities) OVER () AS activities,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY restaurants) OVER () AS restaurants,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hotels) OVER () AS hotels,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days) OVER () AS days
        FROM per_trip
      `),
      new sql.Request().query(`
        SELECT DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY itineraries) OVER () AS itineraries
        FROM (SELECT user_id, COUNT(*) AS itineraries FROM dbo.trips GROUP BY user_id) per_user
      `),
      new sql.Request().query('SELECT COUNT_BIG(*) AS itineraries, COUNT(DISTINCT user_id) AS users FROM dbo.trips'),
    ]);
    const list = (result) => (result.recordset || []).map((row) => ({
      name: row.name, users: Number(row.users || 0), picks: Number(row.picks || 0),
    }));
    const medianRow = medians.recordset?.[0] || null;
    const median = (value) => (value === null || value === undefined ? null : Number(value));
    const totalsRow = totals.recordset?.[0] || {};
    return sendJson(res, 200, {
      totals: {
        savedItineraries: Number(totalsRow.itineraries || 0),
        usersWithItineraries: Number(totalsRow.users || 0),
      },
      // null when there are no saved itineraries to take a median of.
      medians: {
        activitiesPerItinerary: median(medianRow?.activities),
        restaurantsPerItinerary: median(medianRow?.restaurants),
        hotelsPerItinerary: median(medianRow?.hotels),
        daysPerItinerary: median(medianRow?.days),
        itinerariesPerUser: median(perUserMedian.recordset?.[0]?.itineraries),
      },
      activities: list(activities),
      activityTypes: list(activityTypes),
      restaurants: list(restaurants),
      hotels: list(hotels),
      destinations: list(destinations),
      preferredDestinations: list(preferredDestinations),
      limit,
    });
  } catch (error) {
    console.error('Admin insights failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to load what users plan.' });
  }
});

app.get('/api/admin/integrations', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    const startedAt = Date.now();
    await pool.query`SELECT 1 AS connected`;
    const latencyMs = Date.now() - startedAt;
    return sendJson(res, 200, {
      database: {
        connected: true,
        name: config.database,
        authMode: useWindowsAuthentication ? 'windows' : 'sql-user',
        latencyMs,
      },
      email: {
        configured: Boolean(String(process.env.SMTP_HOST || '').trim() && String(process.env.SMTP_USER || '').trim()),
      },
      maintenanceMode: isMaintenanceMode(),
      adminAuditAvailable: await hasAdminAuditLogTable(pool),
      uptimeSeconds: Math.round(process.uptime()),
      ai: {
        configured: Boolean(getAiApiKey()),
        model: getAiModel(),
        status: getAiApiKey() ? 'configured' : 'missing-api-key',
      },
      maps: {
        configured: Boolean(getMapsApiKey()),
        status: getMapsApiKey() ? 'configured' : 'missing-api-key',
      },
      mode: isDevelopmentMode ? 'development' : 'production',
      healthCheckTime: new Date().toISOString(),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to check integration status.' });
  }
});

app.get('/api/admin/activity', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    const [users, trips, last24] = await Promise.all([
      pool.query`SELECT TOP 10 user_id, name, created_at FROM dbo.users ORDER BY created_at DESC, user_id DESC`,
      pool.query`
        SELECT TOP 10 t.trip_id, t.destination, t.created_at, u.name
        FROM dbo.trips t LEFT JOIN dbo.users u ON u.user_id = t.user_id
        ORDER BY t.created_at DESC, t.trip_id DESC`,
      pool.query`
        SELECT
          (SELECT COUNT_BIG(*) FROM dbo.users WHERE created_at >= DATEADD(hour, -24, SYSUTCDATETIME())) AS signups,
          (SELECT COUNT_BIG(*) FROM dbo.trips WHERE created_at >= DATEADD(hour, -24, SYSUTCDATETIME())) AS trips`,
    ]);
    const usageAvailable = await hasAppUsageEventsTable(pool);
    const [signIns, chats, usage24] = usageAvailable
      ? await Promise.all([
        pool.query`
          SELECT TOP 10 e.created_at, u.name
          FROM dbo.app_usage_events e LEFT JOIN dbo.users u ON u.user_id = e.user_id
          WHERE e.event_type = 'sign_in'
          ORDER BY e.created_at DESC, e.event_id DESC`,
        // Chatbot messages are grouped per user per day, so one busy chat is one line.
        pool.query`
          SELECT TOP 10 MAX(u.name) AS name, COUNT_BIG(*) AS messages, MAX(e.created_at) AS last_at
          FROM dbo.app_usage_events e LEFT JOIN dbo.users u ON u.user_id = e.user_id
          WHERE e.event_type = 'chat_message'
          GROUP BY e.user_id, CAST(e.created_at AS date)
          ORDER BY MAX(e.created_at) DESC`,
        pool.query`
          SELECT
            SUM(CASE WHEN event_type = 'sign_in' THEN 1 ELSE 0 END) AS sign_ins,
            SUM(CASE WHEN event_type = 'chat_message' THEN 1 ELSE 0 END) AS chat_messages
          FROM dbo.app_usage_events WHERE created_at >= DATEADD(hour, -24, SYSUTCDATETIME())`,
      ])
      : [null, null, null];
    const counts = last24.recordset[0] || {};
    const usageCounts = usage24?.recordset?.[0] || {};

    // "label" and "timestamp" are what older pages read; the rest adds who/what.
    // Chat contents are never stored or returned.
    return sendJson(res, 200, {
      last24Hours: {
        signups: Number(counts.signups || 0),
        trips: Number(counts.trips || 0),
        signIns: usageAvailable ? Number(usageCounts.sign_ins || 0) : null,
        chatMessages: usageAvailable ? Number(usageCounts.chat_messages || 0) : null,
      },
      recentUsage: [
        ...(signIns?.recordset || []).map((event) => ({
          kind: 'sign_in', label: 'User signed in', name: event.name || null, timestamp: event.created_at,
        })),
        ...(chats?.recordset || []).map((row) => ({
          kind: 'chat',
          label: Number(row.messages) === 1 ? 'Chatbot message sent' : `${Number(row.messages)} chatbot messages sent`,
          name: row.name || null,
          count: Number(row.messages),
          timestamp: row.last_at,
        })),
      ],
      recentUsers: (users.recordset || []).map((user) => ({
        kind: 'signup', label: 'User account registered', name: user.name || null, timestamp: user.created_at,
      })),
      recentTrips: (trips.recordset || []).map((trip) => ({
        kind: 'trip', label: 'Trip record saved', name: trip.name || null, detail: trip.destination || null, timestamp: trip.created_at,
      })),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load recent activity.' });
  }
});

app.get('/api/admin/audit', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    if (!await hasAdminAuditLogTable(pool)) {
      return sendJson(res, 200, {
        available: false,
        events: [],
        message: 'Admin audit logging is unavailable. Run database/admin/03_admin_auth_audit_log.sql manually in SSMS.',
      });
    }
    const result = await pool.query`
      SELECT TOP 100 actor_username, event_type, outcome, created_at
      FROM dbo.admin_auth_audit_log
      ORDER BY created_at DESC, audit_id DESC
    `;
    return sendJson(res, 200, {
      available: true,
      events: (result.recordset || []).map((row) => ({
        actor: row.actor_username,
        eventType: row.event_type,
        outcome: row.outcome,
        timestamp: row.created_at,
      })),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load administrator audit history.' });
  }
});

app.get('/api/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    return sendJson(res, 200, {
      appMode: isDevelopmentMode ? 'development' : 'production',
      maintenanceMode: isMaintenanceMode(),
      aiModel: getAiModel(),
      googleMapsConfigured: Boolean(getMapsApiKey()),
      geminiConfigured: Boolean(getAiApiKey()),
      adminConfigured: Boolean(getAdminCredentials().username && getAdminCredentials().password),
      adminAuditLoggingAvailable: await hasAdminAuditLogTable(pool),
      recordedAdminEvents: ['successful administrator login', 'administrator logout', 'invalid-credential login attempts when audit storage is available'],
      unrecordedAdminEvents: ['rate-limited login attempts', 'read-only admin page/API views', 'administrator data changes'],
      recommendations: [
        'Use unique ADMIN_USERNAME and ADMIN_PASSWORD values in backend/.env for admin access.',
        'Keep database connection details in backend/.env and avoid committing secrets to source control.',
      ],
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load admin settings.' });
  }
});

app.get('/health', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.query('SELECT 1 AS ok');
    return sendJson(res, 200, { ok: true, database: 'SQL Server connected' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
});

app.post('/api/register/start', async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (isRateLimited(`register-start:${req.ip}`, 5, 15 * 60 * 1000)
    || isRateLimited(`register-start-email:${email}`, 3, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many verification requests. Please try again later.' });
  }
  if (!emailPattern.test(email)) {
    return sendJson(res, 400, { error: 'Please enter a valid email address.' });
  }

  let stagedUserId = null;
  let createdPendingUser = false;
  try {
    const emailCheck = await checkRegistrationEmail(email);
    if (!emailCheck.ok) return sendJson(res, 422, { error: emailCheck.error });

    const pool = await getPool();
    const existing = await pool.query`
      SELECT user_id, is_verified FROM dbo.users WHERE email = ${email}
    `;
    if (existing.recordset[0]?.is_verified) {
      return sendJson(res, 409, { error: 'An account already exists for this email. Please log in instead.' });
    }

    stagedUserId = existing.recordset[0]?.user_id || null;
    if (!stagedUserId) {
      const unusedPasswordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 10);
      const insert = await pool.query`
        INSERT INTO dbo.users (name, email, password_hash, is_verified, terms_accepted, terms_accepted_at)
        OUTPUT INSERTED.user_id
        VALUES ('Pending registration', ${email}, ${unusedPasswordHash}, 0, 0, NULL)
      `;
      stagedUserId = insert.recordset?.[0]?.user_id || null;
      createdPendingUser = true;
    }
    if (!stagedUserId) throw new Error('Unable to create the pending email verification.');

    const otp = createOtp();
    await pool.query`
      UPDATE dbo.otp_verifications SET is_used = 1
      WHERE user_id = ${stagedUserId} AND is_used = 0
    `;
    const otpInsert = await pool.query`
      INSERT INTO dbo.otp_verifications (user_id, otp_code_hash, expires_at)
      OUTPUT INSERTED.otp_id
      VALUES (${stagedUserId}, ${hashOtp(otp)}, DATEADD(minute, 10, SYSUTCDATETIME()))
    `;
    const otpId = otpInsert.recordset?.[0]?.otp_id;
    try {
      await sendOtpEmail(email, otp);
    } catch (error) {
      if (otpId) {
        await pool.query`UPDATE dbo.otp_verifications SET is_used = 1 WHERE otp_id = ${otpId}`;
      }
      if (createdPendingUser) {
        await pool.query`DELETE FROM dbo.otp_verifications WHERE user_id = ${stagedUserId}`;
        await pool.query`DELETE FROM dbo.users WHERE user_id = ${stagedUserId} AND is_verified = 0`;
      }
      if (isUndeliverableEmailError(error)) {
        return sendJson(res, 422, { error: 'That email address does not appear to exist or cannot receive email. Check it and try again.' });
      }
      console.error('Registration verification email failed:', error.message);
      return sendJson(res, 503, { error: 'We could not send a verification code right now. Please try again later.' });
    }

    return sendJson(res, 200, { email, verification_required: true });
  } catch (error) {
    console.error('Registration verification setup failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to start registration right now. Please try again.' });
  }
});

app.post('/api/register/verify-code', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  if (isRateLimited(`register-verify:${req.ip}`, 10, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many verification attempts. Please try again later.' });
  }
  if (!emailPattern.test(email) || !/^\d{6}$/.test(otp)) {
    return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
  }

  try {
    const pool = await getPool();
    const result = await pool.query`
      SELECT TOP 1 o.otp_id, o.otp_code_hash, o.expires_at, o.is_used, o.verification_attempts
      FROM dbo.otp_verifications o
      JOIN dbo.users u ON u.user_id = o.user_id
      WHERE u.email = ${email} AND u.is_verified = 0
      ORDER BY o.created_at DESC
    `;
    const verification = result.recordset[0];
    const isValid = verification
      && !verification.is_used
      && verification.verification_attempts < 5
      && new Date(verification.expires_at).getTime() > Date.now()
      && crypto.timingSafeEqual(Buffer.from(verification.otp_code_hash), Buffer.from(hashOtp(otp)));
    if (!isValid) {
      if (verification && !verification.is_used) {
        await pool.query`
          UPDATE dbo.otp_verifications
          SET verification_attempts = verification_attempts + 1
          WHERE otp_id = ${verification.otp_id}
        `;
      }
      return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
    }
    return sendJson(res, 200, { verified: true });
  } catch (error) {
    console.error('Registration email code verification failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to verify that code right now. Please try again.' });
  }
});

app.post('/api/register/complete', async (req, res) => {
  const { name, password, termsAccepted } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  const trimmedName = String(name || '').trim();
  if (isRateLimited(`register-complete:${req.ip}`, 5, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many registration attempts. Please try again later.' });
  }
  if (!emailPattern.test(email) || !/^\d{6}$/.test(otp)) {
    return sendJson(res, 400, { error: 'Verify your email before completing registration.' });
  }
  if (!trimmedName || !password) return sendJson(res, 400, { error: 'Name and password are required.' });
  if (trimmedName.length > 200) return sendJson(res, 400, { error: 'Name must be 200 characters or less.' });
  if (String(password).length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
  if (termsAccepted !== true) return sendJson(res, 400, { error: 'You must agree to the Terms and Conditions to register.' });
  if (req.body?.ageConfirmed !== true) return sendJson(res, 400, { error: 'You must be 18 or older to use Sidekick.' });

  const passwordHash = await bcrypt.hash(String(password), 10);
  const transaction = new sql.Transaction(await getPool());
  let transactionStarted = false;
  let transactionCommitted = false;
  try {
    await transaction.begin();
    transactionStarted = true;
    const lookup = new sql.Request(transaction);
    const verificationResult = await lookup.input('email', email).query(`
      SELECT TOP 1 o.otp_id, o.user_id, o.otp_code_hash, o.expires_at, o.is_used, o.verification_attempts
      FROM dbo.otp_verifications o WITH (UPDLOCK, HOLDLOCK)
      JOIN dbo.users u WITH (UPDLOCK, HOLDLOCK) ON u.user_id = o.user_id
      WHERE u.email = @email AND u.is_verified = 0
      ORDER BY o.created_at DESC
    `);
    const verification = verificationResult.recordset[0];
    const isValid = verification
      && !verification.is_used
      && verification.verification_attempts < 5
      && new Date(verification.expires_at).getTime() > Date.now()
      && crypto.timingSafeEqual(Buffer.from(verification.otp_code_hash), Buffer.from(hashOtp(otp)));
    if (!isValid) {
      if (verification && !verification.is_used) {
        const invalid = new sql.Request(transaction);
        await invalid.input('otpId', verification.otp_id).query(`
          UPDATE dbo.otp_verifications
          SET verification_attempts = verification_attempts + 1
          WHERE otp_id = @otpId
        `);
      }
      await transaction.commit();
      return sendJson(res, 400, { error: 'Invalid or expired code. Request a new code and try again.' });
    }

    const finalize = new sql.Request(transaction);
    const updateResult = await finalize
      .input('userId', verification.user_id)
      .input('otpId', verification.otp_id)
      .input('name', trimmedName)
      .input('passwordHash', passwordHash)
      .query(`
        UPDATE dbo.users
        SET name = @name, password_hash = @passwordHash, is_verified = 1,
            terms_accepted = 1, terms_accepted_at = SYSUTCDATETIME()
        OUTPUT INSERTED.user_id, INSERTED.name, INSERTED.email
        WHERE user_id = @userId AND is_verified = 0;
        UPDATE dbo.otp_verifications SET is_used = 1 WHERE otp_id = @otpId;
      `);
    if (!updateResult.recordset?.length) {
      await transaction.rollback();
      return sendJson(res, 409, { error: 'This registration is no longer pending. Please start again.' });
    }
    await transaction.commit();
    transactionCommitted = true;
    const user = updateResult.recordset[0];
    const session = await createAppSession(user);
    return sendJson(res, 201, { user, verified: true, session });
  } catch (error) {
    if (transactionStarted && !transactionCommitted) {
      try { await transaction.rollback(); } catch (rollbackError) {
        console.error('Registration transaction rollback failed:', rollbackError.message);
      }
    }
    console.error('Registration completion failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to complete registration right now. Please try again.' });
  }
});

app.post('/api/register', async (req, res) => {
  return sendJson(res, 410, { error: 'Registration now requires email verification first. Restart signup from the registration page.' });
});

app.post('/api/verify-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();

  if (isRateLimited(`verify:${req.ip}`, 10, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many verification attempts. Please try again later.' });
  }
  if (!emailPattern.test(email) || !/^\d{6}$/.test(otp)) {
    return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
  }

  try {
    const pool = await getPool();
    const result = await pool.query`
      SELECT TOP 1 o.otp_id, o.user_id, o.otp_code_hash, o.expires_at, o.is_used, o.verification_attempts
      FROM dbo.otp_verifications o
      JOIN dbo.users u ON u.user_id = o.user_id
      WHERE u.email = ${email} AND u.is_verified = 0
        AND u.terms_accepted = 1 AND u.name <> 'Pending registration'
      ORDER BY o.created_at DESC
    `;
    const verification = result.recordset[0];
    const isValid = verification
      && !verification.is_used
      && verification.verification_attempts < 5
      && new Date(verification.expires_at).getTime() > Date.now()
      && crypto.timingSafeEqual(Buffer.from(verification.otp_code_hash), Buffer.from(hashOtp(otp)));

    if (!isValid) {
      if (verification && !verification.is_used) {
        await pool.query`
          UPDATE dbo.otp_verifications
          SET verification_attempts = verification_attempts + 1
          WHERE otp_id = ${verification.otp_id}
        `;
      }
      return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
    }

    await pool.query`UPDATE dbo.otp_verifications SET is_used = 1 WHERE otp_id = ${verification.otp_id}`;
    const userResult = await pool.query`
      UPDATE dbo.users SET is_verified = 1
      OUTPUT INSERTED.user_id, INSERTED.name, INSERTED.email
      WHERE user_id = ${verification.user_id} AND is_verified = 0
    `;
    if (!userResult.recordset.length) {
      return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
    }
    const user = userResult.recordset[0];
    const session = await createAppSession(user);
    return sendJson(res, 200, { verified: true, user, session });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.post('/api/resend-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!emailPattern.test(email)) {
    return sendJson(res, 400, { error: 'Please enter a valid email address.' });
  }
  if (isRateLimited(`resend:${email}`, 3, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many resend attempts. Please try again later.' });
  }

  try {
    const pool = await getPool();
    const userResult = await pool.query`
      SELECT user_id FROM dbo.users WHERE email = ${email} AND is_verified = 0
    `;
    if (!userResult.recordset.length) {
      return sendJson(res, 404, { error: 'No pending verification was found for this email.' });
    }
    const userId = userResult.recordset[0].user_id;
    const otp = createOtp();
    await pool.query`UPDATE dbo.otp_verifications SET is_used = 1 WHERE user_id = ${userId} AND is_used = 0`;
    await pool.query`
      INSERT INTO dbo.otp_verifications (user_id, otp_code_hash, expires_at, resend_count)
      VALUES (${userId}, ${hashOtp(otp)}, DATEADD(minute, 10, SYSUTCDATETIME()), 1)
    `;
    try {
      await sendOtpEmail(email, otp);
    } catch (error) {
      console.error('Verification email resend failed:', error.message);
      if (isUndeliverableEmailError(error)) {
        return sendJson(res, 422, { error: 'That email address does not appear to exist or cannot receive email. Check it and try again.' });
      }
      return sendJson(res, 503, { error: 'We could not send a verification code right now. Please try again later.' });
    }
    return sendJson(res, 200, { sent: true });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

// ---- Password reset (verified accounts) -------------------------------------
// Reset codes use the same otp_verifications table as registration, but only for
// verified users; registration codes only ever belong to unverified users.
async function findPasswordResetCode(requestOrPool, email, lock = false) {
  const query = `
    SELECT TOP 1 o.otp_id, o.user_id, o.otp_code_hash, o.expires_at, o.is_used, o.verification_attempts
    FROM dbo.otp_verifications o${lock ? ' WITH (UPDLOCK, HOLDLOCK)' : ''}
    JOIN dbo.users u${lock ? ' WITH (UPDLOCK, HOLDLOCK)' : ''} ON u.user_id = o.user_id
    WHERE u.email = @email AND u.is_verified = 1
    ORDER BY o.created_at DESC
  `;
  const result = await requestOrPool.input('email', sql.NVarChar(255), email).query(query);
  return result.recordset[0] || null;
}

function isPasswordResetCodeValid(code, otp) {
  return Boolean(code)
    && !code.is_used
    && code.verification_attempts < 5
    && new Date(code.expires_at).getTime() > Date.now()
    && crypto.timingSafeEqual(Buffer.from(code.otp_code_hash), Buffer.from(hashOtp(otp)));
}

app.post('/api/password/forgot', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!emailPattern.test(email)) {
    return sendJson(res, 400, { error: 'Please enter a valid email address.' });
  }
  if (isRateLimited(`password-forgot:${req.ip}`, 5, 15 * 60 * 1000)
    || isRateLimited(`password-forgot-email:${email}`, 3, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many reset requests. Please try again later.' });
  }
  // The same reply is sent whether or not the account exists, so this cannot be
  // used to find out which emails are registered.
  const genericReply = { sent: true, message: 'If an account exists for this email, a 6-digit code has been sent.' };
  try {
    const pool = await getPool();
    const userResult = await pool.query`
      SELECT user_id FROM dbo.users WHERE email = ${email} AND is_verified = 1
    `;
    const userId = userResult.recordset[0]?.user_id;
    if (!userId) return sendJson(res, 200, genericReply);

    const otp = createOtp();
    await pool.query`UPDATE dbo.otp_verifications SET is_used = 1 WHERE user_id = ${userId} AND is_used = 0`;
    const otpInsert = await pool.query`
      INSERT INTO dbo.otp_verifications (user_id, otp_code_hash, expires_at)
      OUTPUT INSERTED.otp_id
      VALUES (${userId}, ${hashOtp(otp)}, DATEADD(minute, 10, SYSUTCDATETIME()))
    `;
    try {
      await sendPasswordResetEmail(email, otp);
    } catch (error) {
      const otpId = otpInsert.recordset?.[0]?.otp_id;
      if (otpId) await pool.query`UPDATE dbo.otp_verifications SET is_used = 1 WHERE otp_id = ${otpId}`;
      console.error('Password reset email failed:', error.message);
      return sendJson(res, 503, { error: 'We could not send a reset code right now. Please try again later.' });
    }
    return sendJson(res, 200, genericReply);
  } catch (error) {
    console.error('Password reset request failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to start a password reset right now. Please try again.' });
  }
});

app.post('/api/password/verify-code', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  if (isRateLimited(`password-verify:${req.ip}`, 10, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many attempts. Please try again later.' });
  }
  if (!emailPattern.test(email) || !/^\d{6}$/.test(otp)) {
    return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
  }
  try {
    const pool = await getPool();
    const code = await findPasswordResetCode(pool.request(), email);
    if (!isPasswordResetCodeValid(code, otp)) {
      if (code && !code.is_used) {
        await pool.query`UPDATE dbo.otp_verifications SET verification_attempts = verification_attempts + 1 WHERE otp_id = ${code.otp_id}`;
      }
      return sendJson(res, 400, { error: 'Invalid or expired code. Please try again.' });
    }
    return sendJson(res, 200, { verified: true });
  } catch (error) {
    console.error('Password reset code check failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to check that code right now. Please try again.' });
  }
});

app.post('/api/password/reset', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  const password = String(req.body?.password || '');
  if (isRateLimited(`password-reset:${req.ip}`, 5, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many attempts. Please try again later.' });
  }
  if (!emailPattern.test(email) || !/^\d{6}$/.test(otp)) {
    return sendJson(res, 400, { error: 'Invalid or expired code. Request a new code and try again.' });
  }
  if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });

  const passwordHash = await bcrypt.hash(password, 10);
  const transaction = new sql.Transaction(await getPool());
  let transactionStarted = false;
  let transactionFinished = false;
  try {
    const clearStoredSessions = await hasSessionTables();
    await transaction.begin();
    transactionStarted = true;
    const code = await findPasswordResetCode(new sql.Request(transaction), email, true);
    if (!isPasswordResetCodeValid(code, otp)) {
      if (code && !code.is_used) {
        await new sql.Request(transaction).input('otpId', sql.Int, code.otp_id)
          .query('UPDATE dbo.otp_verifications SET verification_attempts = verification_attempts + 1 WHERE otp_id = @otpId');
      }
      await transaction.commit();
      transactionFinished = true;
      return sendJson(res, 400, { error: 'Invalid or expired code. Request a new code and try again.' });
    }
    await new sql.Request(transaction)
      .input('userId', sql.Int, code.user_id)
      .input('otpId', sql.Int, code.otp_id)
      .input('passwordHash', sql.NVarChar(255), passwordHash)
      .query(`
        UPDATE dbo.users SET password_hash = @passwordHash WHERE user_id = @userId AND is_verified = 1;
        UPDATE dbo.otp_verifications SET is_used = 1 WHERE otp_id = @otpId;
        ${clearStoredSessions ? 'DELETE FROM dbo.app_sessions WHERE user_id = @userId;' : ''}
      `);
    await transaction.commit();
    transactionFinished = true;
    // Sign the account out everywhere so an old session cannot keep using it.
    for (const [token, session] of appSessions) {
      if (session.userId === Number(code.user_id)) appSessions.delete(token);
    }
    return sendJson(res, 200, { reset: true });
  } catch (error) {
    if (transactionStarted && !transactionFinished) {
      try { await transaction.rollback(); } catch (rollbackError) {
        console.error('Password reset rollback failed:', rollbackError.message);
      }
    }
    console.error('Password reset failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to change the password right now. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return sendJson(res, 400, { error: 'Email and password are required.' });
  }
  if (isRateLimited(`login:${req.ip}`, 20, 15 * 60 * 1000)
    || isRateLimited(`login-email:${normalizedEmail}`, 10, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' });
  }

  try {
    const pool = await getPool();
    const result = await pool.query`SELECT * FROM dbo.users WHERE email = ${normalizedEmail}`;

    if (!result.recordset.length) {
      return sendJson(res, 404, { error: 'Incorrect email or password.' });
    }

    const user = result.recordset[0];
    if (!user.is_verified) {
      return sendJson(res, 403, { error: 'Please verify your email before logging in.' });
    }
    const valid = await bcrypt.compare(String(password), user.password_hash);

    if (!valid) {
      return sendJson(res, 401, { error: 'Incorrect email or password.' });
    }

    if (await hasUserLastActiveColumn(pool)) {
      await new sql.Request()
        .input('userId', sql.Int, user.user_id)
        .query('UPDATE dbo.users SET last_active_at = SYSUTCDATETIME() WHERE user_id = @userId');
    }
    recordAppUsageEvent(user.user_id, 'sign_in');
    const session = await createAppSession(user);

    return sendJson(res, 200, {
      user: {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
      },
      session,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.post('/api/app-presence/heartbeat', requireAppAuth, async (req, res) => {
  appPresence.set(req.appUser.userId, Date.now());
  try {
    const pool = await getPool();
    if (await hasUserLastActiveColumn(pool)) {
      await new sql.Request()
        .input('userId', sql.Int, req.appUser.userId)
        .query('UPDATE dbo.users SET last_active_at = SYSUTCDATETIME() WHERE user_id = @userId');
    }
  } catch (error) {
    console.error('App last-active timestamp update failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to record app activity right now.' });
  }
  return sendJson(res, 200, { online: true });
});

// Lets a signed-in user permanently delete their own account and linked data
// (Data Privacy Act right to erasure). Same cleanup as the admin delete action.
app.post('/api/account/delete', requireAppAuth, async (req, res) => {
  const userId = Number(req.appUser.userId);
  const password = String(req.body?.password || '');
  if (!password) return sendJson(res, 400, { error: 'Enter your password to confirm.' });
  if (isRateLimited(`account-delete:${userId}`, 5, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many attempts. Please try again later.' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const pool = await getPool();
    const userResult = await new sql.Request()
      .input('userId', sql.Int, userId)
      .query('SELECT user_id, password_hash FROM dbo.users WHERE user_id = @userId AND is_verified = 1');
    const user = userResult.recordset[0];
    if (!user) return sendJson(res, 404, { error: 'Account not found.' });
    // 403 (not 401) so the app does not treat a wrong password as an expired session.
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return sendJson(res, 403, { error: 'Incorrect password. Please try again.' });
    }

    const optionalTables = await pool.query`
      SELECT
        CASE WHEN OBJECT_ID(N'dbo.reminders', N'U') IS NULL THEN 0 ELSE 1 END AS reminders_available,
        CASE WHEN OBJECT_ID(N'dbo.app_reviews', N'U') IS NULL THEN 0 ELSE 1 END AS app_reviews_available,
        CASE WHEN OBJECT_ID(N'dbo.otp_verifications', N'U') IS NULL THEN 0 ELSE 1 END AS otp_verifications_available
    `;
    const optionalTableState = optionalTables.recordset[0] || {};

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;
    const deleteStatements = [
      ...(optionalTableState.reminders_available ? ['DELETE FROM dbo.reminders WHERE user_id = @userId;'] : []),
      `
        DELETE FROM dbo.itinerary_activities
        WHERE trip_day_id IN (
          SELECT d.trip_day_id
          FROM dbo.trip_days d
          JOIN dbo.trips t ON t.trip_id = d.trip_id
          WHERE t.user_id = @userId
        );
        DELETE FROM dbo.trip_days
        WHERE trip_id IN (SELECT trip_id FROM dbo.trips WHERE user_id = @userId);
        DELETE FROM dbo.trips WHERE user_id = @userId;
        DELETE FROM dbo.user_travel_styles WHERE user_id = @userId;
        DELETE FROM dbo.user_interests WHERE user_id = @userId;
        DELETE FROM dbo.user_preferred_places WHERE user_id = @userId;
      `,
      ...(optionalTableState.app_reviews_available ? ['DELETE FROM dbo.app_reviews WHERE user_id = @userId;'] : []),
      ...(optionalTableState.otp_verifications_available ? ['DELETE FROM dbo.otp_verifications WHERE user_id = @userId;'] : []),
      'DELETE FROM dbo.users WHERE user_id = @userId;',
    ];
    await new sql.Request(transaction).input('userId', sql.Int, userId).query(deleteStatements.join('\n'));
    await transaction.commit();
    transactionStarted = false;

    try {
      await deleteUserAppSessions(userId);
    } catch (error) {
      // Stored sessions were already removed with the account (ON DELETE CASCADE).
      console.error('Session cleanup after account deletion failed:', error.message);
    }
    appPresence.delete(userId);
    return sendJson(res, 200, { ok: true, deleted: true });
  } catch (error) {
    if (transactionStarted) {
      try { await transaction.rollback(); } catch (rollbackError) {
        console.error('Account deletion rollback failed:', rollbackError.message);
      }
    }
    console.error('Account deletion failed:', error.message);
    return sendJson(res, 500, { error: 'Your account could not be deleted right now. Nothing was deleted; please try again.' });
  }
});

app.post('/api/app-session/logout', requireAppAuth, async (req, res) => {
  const token = getAppTokenFromRequest(req);
  try {
    if (token) await deleteAppSession(token);
  } catch (error) {
    console.error('App session could not be ended:', error.message);
    return sendJson(res, 503, { error: 'Sidekick could not sign you out on the server right now. Please try again.' });
  }
  const hasLiveSession = [...appSessions.values()].some((session) => (
    session.userId === req.appUser.userId && session.expiresAt > Date.now()
  ));
  if (!hasLiveSession) appPresence.delete(req.appUser.userId);
  return sendJson(res, 200, { ok: true });
});

async function persistItineraryForUser(userId, itinerary, meta = {}, existingTripId = null) {
  const destination = String(meta.destination || '').trim().slice(0, 200);
  // Users can rename their itinerary; fall back to the default title otherwise.
  const tripTitle = String(meta.title || '').trim().slice(0, 200) || `${destination} itinerary`.slice(0, 200);
  const startDateText = String(meta.startDate || '').slice(0, 10);
  let endDateText = String(meta.endDate || '').slice(0, 10);
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!destination) throw badRequest('A destination is required to save an itinerary.');
  if (!Array.isArray(itinerary) || itinerary.length < 1 || itinerary.length > 14) {
    throw badRequest('A saved itinerary must contain between 1 and 14 days.');
  }
  if (!datePattern.test(startDateText) || Number.isNaN(Date.parse(`${startDateText}T00:00:00Z`))) {
    throw badRequest('A valid itinerary start date is required.');
  }
  if (endDateText && (!datePattern.test(endDateText) || Number.isNaN(Date.parse(`${endDateText}T00:00:00Z`)))) {
    throw badRequest('The itinerary end date is invalid.');
  }
  if (itinerary.some((day) => !day || !Array.isArray(day.activities) || day.activities.length > 30)) {
    throw badRequest('Each itinerary day must have a valid activity list.');
  }
  if (!endDateText) {
    const startDate = new Date(`${startDateText}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() + itinerary.length - 1);
    endDateText = startDate.toISOString().slice(0, 10);
  }

  const parseActivityTime = (value) => {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (minute > 59 || hour > (match[3] ? 12 : 23) || (match[3] && hour < 1)) return null;
    if (match[3]) {
      hour %= 12;
      if (match[3].toUpperCase() === 'PM') hour += 12;
    }
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  };

  let transaction;
  let transactionStarted = false;
  const existingDays = new Map();
  let remindersAvailable = false;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;
    if (endDateText) {
      const expiryResult = await new sql.Request(transaction)
        .input('endDate', sql.Date, new Date(`${endDateText}T00:00:00Z`))
        .query(`
          SELECT CASE
            WHEN DATEADD(day, 2, CONVERT(datetime2, @endDate)) <= SYSUTCDATETIME() THEN 1
            ELSE 0
          END AS expired
        `);
      if (expiryResult.recordset[0]?.expired) {
        throw Object.assign(new Error('This itinerary has expired and can no longer be saved.'), { statusCode: 410 });
      }
    }

    let tripId = existingTripId;
    if (existingTripId) {
      const ownedTrip = await new sql.Request(transaction)
        .input('tripId', sql.Int, existingTripId)
        .input('userId', sql.Int, userId)
        .query('SELECT trip_id FROM dbo.trips WITH (UPDLOCK, HOLDLOCK) WHERE trip_id = @tripId AND user_id = @userId');
      if (!ownedTrip.recordset.length) {
        throw Object.assign(new Error('This itinerary was not found for your account.'), { statusCode: 404 });
      }
      await new sql.Request(transaction)
        .input('tripId', sql.Int, existingTripId)
        .input('title', sql.NVarChar(200), tripTitle)
        .input('destination', sql.NVarChar(200), destination)
        .input('startDate', sql.Date, new Date(`${startDateText}T00:00:00Z`))
        .input('endDate', sql.Date, new Date(`${endDateText}T00:00:00Z`))
        .input('budget', sql.NVarChar(100), String(meta.budget || '').slice(0, 100) || null)
        .query(`
          UPDATE dbo.trips
          SET trip_title = @title,
              destination = @destination,
              start_date = @startDate,
              end_date = @endDate,
              budget = @budget,
              updated_at = SYSUTCDATETIME()
          WHERE trip_id = @tripId
        `);
      const optionalTables = await new sql.Request(transaction).query(`
        SELECT CASE WHEN OBJECT_ID(N'dbo.reminders', N'U') IS NULL THEN 0 ELSE 1 END AS reminders_available
      `);
      remindersAvailable = Boolean(optionalTables.recordset[0]?.reminders_available);
      const existingDayResult = await new sql.Request(transaction)
        .input('tripId', sql.Int, existingTripId)
        .query(`
          SELECT d.trip_day_id, d.day_number, a.activity_id, a.title, a.location,
                 a.activity_type, a.start_time, a.end_time, a.estimated_cost
          FROM dbo.trip_days d
          LEFT JOIN dbo.itinerary_activities a ON a.trip_day_id = d.trip_day_id
          WHERE d.trip_id = @tripId
          ORDER BY d.day_number, a.activity_id
        `);
      for (const row of existingDayResult.recordset || []) {
        if (!existingDays.has(row.day_number)) {
          existingDays.set(row.day_number, { tripDayId: row.trip_day_id, activities: [] });
        }
        if (row.activity_id !== null) {
          existingDays.get(row.day_number).activities.push(row);
        }
      }
    } else {
      const tripResult = await new sql.Request(transaction)
        .input('userId', sql.Int, userId)
        .input('title', sql.NVarChar(200), tripTitle)
        .input('destination', sql.NVarChar(200), destination)
        .input('startDate', sql.Date, new Date(`${startDateText}T00:00:00Z`))
        .input('endDate', sql.Date, new Date(`${endDateText}T00:00:00Z`))
        .input('budget', sql.NVarChar(100), String(meta.budget || '').slice(0, 100) || null)
        .input('status', sql.NVarChar(30), 'draft')
        .query(`
          INSERT INTO dbo.trips (user_id, trip_title, destination, start_date, end_date, budget, status)
          OUTPUT INSERTED.trip_id
          VALUES (@userId, @title, @destination, @startDate, @endDate, @budget, @status)
        `);
      tripId = tripResult.recordset[0]?.trip_id;
    }
    if (!tripId) throw new Error('The saved trip did not return an ID.');

    const firstDay = new Date(`${startDateText}T00:00:00Z`);
    const retainedDayIds = new Set();
    for (const [dayIndex, day] of itinerary.entries()) {
      const dayDate = new Date(firstDay.getTime() + dayIndex * 24 * 60 * 60 * 1000);
      const dayNumber = Number(day.dayNumber) || dayIndex + 1;
      const oldDay = existingDays.get(dayNumber);
      let tripDayId = oldDay?.tripDayId;
      if (oldDay) {
        await new sql.Request(transaction)
          .input('tripDayId', sql.Int, tripDayId)
          .input('dayDate', sql.Date, dayDate)
          .input('title', sql.NVarChar(200), String(day.title || '').slice(0, 200) || null)
          .query('UPDATE dbo.trip_days SET day_date = @dayDate, title = @title WHERE trip_day_id = @tripDayId');
      } else {
        const dayResult = await new sql.Request(transaction)
          .input('tripId', sql.Int, tripId)
          .input('dayNumber', sql.Int, dayNumber)
          .input('dayDate', sql.Date, dayDate)
          .input('title', sql.NVarChar(200), String(day.title || '').slice(0, 200) || null)
          .query(`
            INSERT INTO dbo.trip_days (trip_id, day_number, day_date, title)
            OUTPUT INSERTED.trip_day_id
            VALUES (@tripId, @dayNumber, @dayDate, @title)
          `);
        tripDayId = dayResult.recordset[0]?.trip_day_id;
      }
      if (!tripDayId) throw new Error('A saved itinerary day did not return an ID.');
      retainedDayIds.add(tripDayId);

      const activities = day.activities
        .map((activity) => ({ activity, title: String(activity?.title || '').trim().slice(0, 200) }))
        .filter((entry) => entry.title);
      for (const [activityIndex, entry] of activities.entries()) {
        const { activity, title } = entry;
        const rawCost = activity.estimatedTotalCostPhp ?? activity.estimatedActivityCostPhp;
        const cost = rawCost == null || rawCost === '' ? null : Number(rawCost);
        const oldActivity = oldDay?.activities[activityIndex];
        const activityRequest = new sql.Request(transaction)
          .input('tripDayId', sql.Int, tripDayId)
          .input('title', sql.NVarChar(200), title)
          .input('location', sql.NVarChar(500), String(activity.location || '').slice(0, 500) || null)
          .input('activityType', sql.NVarChar(100), String(activity.category || activity.activityType || '').slice(0, 100) || null)
          .input('startTime', sql.NVarChar(8), parseActivityTime(activity.startTime || activity.timeLabel))
          .input('endTime', sql.NVarChar(8), null)
          .input('estimatedCost', sql.Decimal(12, 2), Number.isFinite(cost) ? cost : null);
        if (oldActivity) {
          await activityRequest
            .input('activityId', sql.Int, oldActivity.activity_id)
            .query(`
              UPDATE dbo.itinerary_activities
              SET title = @title, location = @location, activity_type = @activityType,
                  start_time = @startTime, end_time = @endTime, estimated_cost = @estimatedCost
              WHERE activity_id = @activityId AND trip_day_id = @tripDayId
            `);
        } else {
          await activityRequest.query(`
            INSERT INTO dbo.itinerary_activities
              (trip_day_id, title, location, activity_type, start_time, end_time, estimated_cost)
            VALUES
              (@tripDayId, @title, @location, @activityType, @startTime, @endTime, @estimatedCost)
          `);
        }
      }
      for (const oldActivity of oldDay?.activities.slice(activities.length) || []) {
        if (remindersAvailable) {
          await new sql.Request(transaction)
            .input('activityId', sql.Int, oldActivity.activity_id)
            .query('DELETE FROM dbo.reminders WHERE activity_id = @activityId');
        }
        await new sql.Request(transaction)
          .input('activityId', sql.Int, oldActivity.activity_id)
          .query('DELETE FROM dbo.itinerary_activities WHERE activity_id = @activityId');
      }
    }
    if (existingTripId) {
      for (const oldDay of existingDays.values()) {
        if (retainedDayIds.has(oldDay.tripDayId)) continue;
        for (const oldActivity of oldDay.activities) {
          if (remindersAvailable) {
            await new sql.Request(transaction)
              .input('activityId', sql.Int, oldActivity.activity_id)
              .query('DELETE FROM dbo.reminders WHERE activity_id = @activityId');
          }
        }
        await new sql.Request(transaction)
          .input('tripDayId', sql.Int, oldDay.tripDayId)
          .query(`
            DELETE FROM dbo.itinerary_activities WHERE trip_day_id = @tripDayId;
            DELETE FROM dbo.trip_days WHERE trip_day_id = @tripDayId;
          `);
      }
    }

    await transaction.commit();
    transactionStarted = false;
    return tripId;
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error('App itinerary save rollback failed:', rollbackError.message);
      }
    }
    console.error('App itinerary save failed:', error.message);
    throw error;
  }
}

app.post('/api/app-itineraries', requireAppAuth, async (req, res) => {
  try {
    const tripId = await persistItineraryForUser(req.appUser.userId, req.body?.itinerary, req.body?.meta || {});
    return sendJson(res, 201, { ok: true, tripId });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Unable to save this itinerary to your Sidekick account.',
    });
  }
});

app.post('/api/app-itineraries/sync', requireAppAuth, async (req, res) => {
  try {
    const meta = req.body?.meta || {};
    const destination = String(meta.destination || '').trim().slice(0, 200);
    const startDate = String(meta.startDate || '').slice(0, 10);
    if (!destination || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return sendJson(res, 400, { error: 'A destination and valid itinerary start date are required.' });
    }
    const pool = await getPool();
    const matchingTrip = await pool.request()
      .input('userId', sql.Int, req.appUser.userId)
      .input('destination', sql.NVarChar(200), destination)
      .input('startDate', sql.Date, new Date(`${startDate}T00:00:00Z`))
      .input('budget', sql.NVarChar(100), String(meta.budget || '').slice(0, 100))
      .query(`
        SELECT TOP 1 trip_id
        FROM dbo.trips
        WHERE user_id = @userId
          AND LOWER(LTRIM(RTRIM(destination))) = LOWER(@destination)
          AND CAST(start_date AS date) = @startDate
          AND ISNULL(budget, '') = @budget
        ORDER BY created_at DESC, trip_id DESC
      `);
    const tripId = await persistItineraryForUser(
      req.appUser.userId,
      req.body?.itinerary,
      meta,
      matchingTrip.recordset[0]?.trip_id || null,
    );
    return sendJson(res, matchingTrip.recordset.length ? 200 : 201, { ok: true, tripId });
  } catch (error) {
    console.error('App itinerary sync failed:', error.message);
    return sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Unable to synchronize this itinerary with your Sidekick account.',
    });
  }
});

app.get('/api/app-itineraries/retention', requireAppAuth, async (req, res) => {
  const rawTripId = req.query.tripId;
  const tripId = rawTripId === undefined ? null : Number(rawTripId);
  if (tripId !== null && (!Number.isSafeInteger(tripId) || tripId < 1)) {
    return sendJson(res, 400, { error: 'A valid itinerary ID is required.' });
  }
  try {
    const pool = await getPool();
    const request = pool.request()
      .input('userId', sql.Int, req.appUser.userId)
      .input('tripId', sql.Int, tripId);
    const result = await request.query(`
      SELECT
        CONVERT(varchar(10), DATEADD(day, -1, SYSUTCDATETIME()), 23) AS expiredBeforeDate,
        CASE WHEN @tripId IS NULL OR EXISTS (
          SELECT 1 FROM dbo.trips WHERE trip_id = @tripId AND user_id = @userId
        ) THEN 1 ELSE 0 END AS tripAvailable
    `);
    return sendJson(res, 200, {
      expiredBeforeDate: result.recordset[0]?.expiredBeforeDate,
      tripAvailable: Boolean(result.recordset[0]?.tripAvailable),
    });
  } catch (error) {
    console.error('App itinerary retention check failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to verify itinerary retention with your Sidekick account.' });
  }
});

app.put('/api/app-itineraries/:tripId', requireAppAuth, async (req, res) => {
  const tripId = Number(req.params.tripId);
  if (!Number.isSafeInteger(tripId) || tripId < 1) return sendJson(res, 400, { error: 'A valid itinerary ID is required.' });
  try {
    const updatedTripId = await persistItineraryForUser(req.appUser.userId, req.body?.itinerary, req.body?.meta || {}, tripId);
    return sendJson(res, 200, { ok: true, tripId: updatedTripId });
  } catch (error) {
    console.error('App itinerary update failed:', error.message);
    return sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Unable to update this itinerary in your Sidekick account.',
    });
  }
});

app.delete('/api/app-itineraries/:tripId', requireAppAuth, async (req, res) => {
  const tripId = Number(req.params.tripId);
  if (!Number.isSafeInteger(tripId) || tripId < 1) return sendJson(res, 400, { error: 'A valid itinerary ID is required.' });
  let transaction;
  let transactionStarted = false;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;
    const ownedTrip = await new sql.Request(transaction)
      .input('tripId', sql.Int, tripId)
      .input('userId', sql.Int, req.appUser.userId)
      .query('SELECT trip_id FROM dbo.trips WITH (UPDLOCK, HOLDLOCK) WHERE trip_id = @tripId AND user_id = @userId');
    if (!ownedTrip.recordset.length) {
      await transaction.rollback();
      transactionStarted = false;
      return sendJson(res, 404, { error: 'This itinerary was not found for your account.' });
    }
    const optionalTables = await new sql.Request(transaction).query(`
      SELECT CASE WHEN OBJECT_ID(N'dbo.reminders', N'U') IS NULL THEN 0 ELSE 1 END AS reminders_available
    `);
    if (optionalTables.recordset[0]?.reminders_available) {
      await new sql.Request(transaction)
        .input('tripId', sql.Int, tripId)
        .query(`
          DELETE FROM dbo.reminders
          WHERE trip_id = @tripId
             OR activity_id IN (
               SELECT a.activity_id
               FROM dbo.itinerary_activities a
               JOIN dbo.trip_days d ON d.trip_day_id = a.trip_day_id
               WHERE d.trip_id = @tripId
             )
        `);
    }
    await new sql.Request(transaction)
      .input('tripId', sql.Int, tripId)
      .query(`
        DELETE FROM dbo.itinerary_activities
        WHERE trip_day_id IN (SELECT trip_day_id FROM dbo.trip_days WHERE trip_id = @tripId);
        DELETE FROM dbo.trip_days WHERE trip_id = @tripId;
      `);
    const deletedTrip = await new sql.Request(transaction)
      .input('tripId', sql.Int, tripId)
      .input('userId', sql.Int, req.appUser.userId)
      .query(`
        DELETE FROM dbo.trips
        OUTPUT DELETED.trip_id
        WHERE trip_id = @tripId AND user_id = @userId
      `);
    if (!deletedTrip.recordset.length) throw new Error('The itinerary could not be deleted.');
    await transaction.commit();
    transactionStarted = false;
    return sendJson(res, 200, { ok: true, tripId });
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error('App itinerary deletion rollback failed:', rollbackError.message);
      }
    }
    console.error('App itinerary deletion failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to delete this itinerary from your Sidekick account.' });
  }
});

async function upsertAppReview(pool, userId, rating, reviewText) {
  await pool.query`
    BEGIN TRY
      BEGIN TRANSACTION;
      IF EXISTS (
        SELECT 1 FROM dbo.app_reviews WITH (UPDLOCK, HOLDLOCK) WHERE user_id = ${userId}
      )
      BEGIN
        UPDATE dbo.app_reviews
        SET rating = ${rating}, review_text = ${reviewText}, updated_at = SYSUTCDATETIME()
        WHERE user_id = ${userId};
      END
      ELSE
      BEGIN
        INSERT INTO dbo.app_reviews (user_id, rating, review_text)
        VALUES (${userId}, ${rating}, ${reviewText});
      END;
      COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
      THROW;
    END CATCH;
  `;
}

app.get('/api/app-reviews/me', requireAppAuth, async (req, res) => {
  try {
    const pool = await getPool();
    if (!await hasAppReviewsTable(pool)) {
      return sendJson(res, 503, { error: 'App reviews are not set up yet. Contact the app administrator.' });
    }
    const [reviewResult, summaryResult] = await Promise.all([
      pool.query`
        SELECT TOP 1 rating, review_text, created_at, updated_at
        FROM dbo.app_reviews WHERE user_id = ${req.appUser.userId}
      `,
      pool.query`
        SELECT COUNT_BIG(*) AS total_reviews, AVG(CAST(rating AS decimal(4,2))) AS average_rating
        FROM dbo.app_reviews
      `,
    ]);
    const review = reviewResult.recordset[0];
    const summary = summaryResult.recordset[0] || {};
    return sendJson(res, 200, {
      review: review ? {
        rating: Number(review.rating),
        review: review.review_text,
        createdAt: review.created_at,
        updatedAt: review.updated_at,
      } : null,
      totalReviews: Number(summary.total_reviews || 0),
      averageRating: summary.average_rating == null ? null : Number(summary.average_rating),
    });
  } catch (error) {
    console.error('App review profile lookup failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to load app reviews.' });
  }
});

app.post('/api/app-reviews/me', requireAppAuth, async (req, res) => {
  const rating = Number(req.body?.rating);
  const rawReview = req.body?.review;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: 'Choose a rating from 1 to 5 stars.' });
  }
  if (rawReview !== null && rawReview !== undefined && typeof rawReview !== 'string') {
    return sendJson(res, 400, { error: 'The review must be text.' });
  }
  const trimmedReview = typeof rawReview === 'string' ? rawReview.trim() : '';
  if (trimmedReview.length > 2000) return sendJson(res, 400, { error: 'Reviews must be 2,000 characters or less.' });
  if (isRateLimited(`app-review:${req.appUser.userId}`, 10, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many review attempts. Please try again later.' });
  }

  try {
    const pool = await getPool();
    if (!await hasAppReviewsTable(pool)) {
      return sendJson(res, 503, { error: 'App reviews are not set up yet. Contact the app administrator.' });
    }
    const reviewText = trimmedReview || null;
    await upsertAppReview(pool, req.appUser.userId, rating, reviewText);
    return sendJson(res, 200, { saved: true });
  } catch (error) {
    console.error('App review save failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to save your rating right now.' });
  }
});

app.get('/api/app-reviews/status/:email', requireAppAuth, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  if (email !== normalizeEmail(req.appUser.email)) {
    return sendJson(res, 403, { error: 'You can only access your own app review.' });
  }
  if (!emailPattern.test(email)) return sendJson(res, 400, { error: 'A valid email address is required.' });
  try {
    const pool = await getPool();
    const reviewResult = await pool.query`
      SELECT TOP 1 review_id FROM dbo.app_reviews WHERE user_id = ${req.appUser.userId}
    `;
    return sendJson(res, 200, { submitted: reviewResult.recordset.length > 0 });
  } catch (error) {
    console.error('App review status lookup failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to check app review status.' });
  }
});

app.post('/api/app-reviews', requireAppAuth, async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.appUser.email);
  if (email !== normalizeEmail(req.appUser.email)) {
    return sendJson(res, 403, { error: 'You can only submit a review for your own account.' });
  }
  const rating = Number(req.body?.rating);
  const rawReview = req.body?.review;
  if (!emailPattern.test(email)) return sendJson(res, 400, { error: 'A valid email address is required.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: 'Choose a rating from 1 to 5 stars.' });
  }
  if (rawReview !== null && rawReview !== undefined && typeof rawReview !== 'string') {
    return sendJson(res, 400, { error: 'The review must be text.' });
  }
  const trimmedReview = typeof rawReview === 'string' ? rawReview.trim() : '';
  if (trimmedReview.length > 2000) return sendJson(res, 400, { error: 'Reviews must be 2,000 characters or less.' });
  if (isRateLimited(`app-review:${req.appUser.userId}`, 10, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many review attempts. Please try again later.' });
  }

  try {
    const pool = await getPool();
    const reviewText = trimmedReview || null;
    await upsertAppReview(pool, req.appUser.userId, rating, reviewText);
    return sendJson(res, 200, { saved: true });
  } catch (error) {
    console.error('App review save failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to save your rating right now.' });
  }
});

app.get('/api/preferences/:email', requireAppAuth, requireOwnEmail, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  try {
    const pool = await getPool();
    const userResult = await pool.query`SELECT user_id FROM dbo.users WHERE email = ${email}`;
    if (!userResult.recordset.length) {
      return sendJson(res, 404, { error: 'User not found.' });
    }

    const userId = userResult.recordset[0].user_id;

    const styleRows = await pool.query`
      SELECT ts.style_name
      FROM dbo.user_travel_styles uts
      JOIN dbo.travel_styles ts ON uts.style_id = ts.style_id
      WHERE uts.user_id = ${userId}
    `;

    const interestRows = await pool.query`
      SELECT i.interest_name
      FROM dbo.user_interests ui
      JOIN dbo.interests i ON ui.interest_id = i.interest_id
      WHERE ui.user_id = ${userId}
    `;

    const placeRows = await pool.query`
      SELECT pp.place_name
      FROM dbo.user_preferred_places upp
      JOIN dbo.preferred_places pp ON upp.place_id = pp.place_id
      WHERE upp.user_id = ${userId}
    `;

    return sendJson(res, 200, {
      travelTypes: styleRows.recordset.map((row) => row.style_name),
      interests: interestRows.recordset.map((row) => row.interest_name),
      preferredPlaces: placeRows.recordset.map((row) => row.place_name),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.put('/api/preferences/:email', requireAppAuth, requireOwnEmail, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  // Clean each list: strings only, trimmed, no duplicates, bounded.
  const cleanList = (value, max) => Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim().slice(0, 200))
    .filter(Boolean))).slice(0, max);
  const travelTypes = cleanList(req.body?.travelTypes, 20);
  const interests = cleanList(req.body?.interests, 30);
  const preferredPlaces = cleanList(req.body?.preferredPlaces, 10);

  let transaction;
  let transactionStarted = false;
  try {
    const pool = await getPool();
    const userResult = await pool.query`SELECT user_id FROM dbo.users WHERE email = ${email}`;
    if (!userResult.recordset.length) {
      return sendJson(res, 404, { error: 'User not found.' });
    }
    const userId = userResult.recordset[0].user_id;

    // Replace the saved preferences in one transaction so a failure never leaves them half-written.
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;
    const run = () => new sql.Request(transaction).input('userId', sql.Int, userId);
    await run().query(`
      DELETE FROM dbo.user_travel_styles WHERE user_id = @userId;
      DELETE FROM dbo.user_interests WHERE user_id = @userId;
      DELETE FROM dbo.user_preferred_places WHERE user_id = @userId;
    `);
    for (const styleName of travelTypes) {
      await run().input('name', sql.NVarChar(200), styleName).query(`
        INSERT INTO dbo.user_travel_styles (user_id, style_id)
        SELECT @userId, style_id FROM dbo.travel_styles WHERE style_name = @name
      `);
    }
    for (const interestName of interests) {
      await run().input('name', sql.NVarChar(200), interestName).query(`
        INSERT INTO dbo.user_interests (user_id, interest_id)
        SELECT @userId, interest_id FROM dbo.interests WHERE interest_name = @name
      `);
    }
    for (const placeName of preferredPlaces) {
      // Users can pick any destination, so add new place names to the list first.
      await run().input('name', sql.NVarChar(200), placeName).query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.preferred_places WITH (UPDLOCK, HOLDLOCK) WHERE place_name = @name)
          INSERT INTO dbo.preferred_places (place_name, country) VALUES (@name, N'Philippines');
        INSERT INTO dbo.user_preferred_places (user_id, place_id)
        SELECT @userId, place_id FROM dbo.preferred_places WHERE place_name = @name;
      `);
    }
    await transaction.commit();
    transactionStarted = false;

    return sendJson(res, 200, { travelTypes, interests, preferredPlaces });
  } catch (error) {
    if (transactionStarted) {
      try { await transaction.rollback(); } catch (rollbackError) {
        console.error('Preference save rollback failed:', rollbackError.message);
      }
    }
    console.error('Preference save failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to save your preferences right now.' });
  }
});

app.get('/api/trips/:email', requireAppAuth, requireOwnEmail, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  try {
    const pool = await getPool();
    const result = await pool.query`
      SELECT t.*
      FROM dbo.trips t
      JOIN dbo.users u ON t.user_id = u.user_id
      WHERE u.email = ${email}
      ORDER BY t.created_at DESC
    `;

    return sendJson(res, 200, result.recordset);
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.post('/api/trips/:email', requireAppAuth, requireOwnEmail, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  const { trip_title, destination, start_date, end_date, budget, status } = req.body || {};

  if (!trip_title || !destination || !start_date) {
    return sendJson(res, 400, { error: 'Trip title, destination and start date are required.' });
  }

  try {
    const pool = await getPool();
    const userResult = await pool.query`SELECT user_id FROM dbo.users WHERE email = ${email}`;
    if (!userResult.recordset.length) {
      return sendJson(res, 404, { error: 'User not found.' });
    }

    const userId = userResult.recordset[0].user_id;

    const result = await pool.query`
      INSERT INTO dbo.trips (user_id, trip_title, destination, start_date, end_date, budget, status)
      VALUES (${userId}, ${trip_title}, ${destination}, ${start_date}, ${end_date || null}, ${budget || null}, ${status || 'draft'})
    `;

    return sendJson(res, 201, { trip_id: result.recordset?.[0]?.trip_id ?? null, ok: true });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.get('/api/reminders/:email', requireAppAuth, requireOwnEmail, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  try {
    const pool = await getPool();
    const result = await pool.query`
      SELECT r.*
      FROM dbo.reminders r
      JOIN dbo.users u ON r.user_id = u.user_id
      WHERE u.email = ${email}
      ORDER BY r.reminder_datetime DESC
    `;

    return sendJson(res, 200, result.recordset);
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.post('/api/reminders/:email', requireAppAuth, requireOwnEmail, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  const reminder = req.body || {};

  if (!reminder.reminder_title || !reminder.reminder_datetime) {
    return sendJson(res, 400, { error: 'Reminder title and datetime are required.' });
  }

  try {
    const pool = await getPool();
    const userResult = await pool.query`SELECT user_id FROM dbo.users WHERE email = ${email}`;
    if (!userResult.recordset.length) {
      return sendJson(res, 404, { error: 'User not found.' });
    }

    const userId = userResult.recordset[0].user_id;

    const result = await pool.query`
      INSERT INTO dbo.reminders (
        user_id,
        trip_id,
        activity_id,
        reminder_title,
        reminder_message,
        reminder_datetime,
        is_sent,
        is_recurring,
        recurrence_pattern
      )
      VALUES (
        ${userId},
        ${reminder.trip_id || null},
        ${reminder.activity_id || null},
        ${reminder.reminder_title},
        ${reminder.reminder_message || null},
        ${reminder.reminder_datetime},
        ${Boolean(reminder.is_sent) ? 1 : 0},
        ${Boolean(reminder.is_recurring) ? 1 : 0},
        ${reminder.recurrence_pattern || null}
      )
    `;

    return sendJson(res, 201, {
      reminder_id: result.recordset?.[0]?.reminder_id ?? null,
      ok: true,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.post('/api/maps/places', requireAppAuth, limitPerUser('maps-places', 600, HOUR_MS), async (req, res) => {
  const { queries = [], seeds = [], touristOnly = false } = req.body || {};
  // Recommendation searches ask Google to prefer tourist attractions. If Google rejects
  // the type filter, fall back to the plain search so results still load.
  const searchText = (payload) => (touristOnly === true
    ? callGooglePlacesApi('places:searchText', { ...payload, includedType: 'tourist_attraction' })
      .catch(() => callGooglePlacesApi('places:searchText', payload))
    : callGooglePlacesApi('places:searchText', payload));
  const safeQueries = Array.isArray(queries) ? queries.map((query) => String(query || '').trim()).filter(Boolean).slice(0, 4) : [];
  const safeSeeds = Array.isArray(seeds) ? seeds.slice(0, 3) : [];

  if (!safeQueries.length) {
    return sendJson(res, 400, { error: 'At least one place search query is required.' });
  }

  try {
    if (isDevelopmentMode) {
      const places = Array.from(new Map(safeQueries.flatMap((query) => developmentPlaces(query, 8)).map((place) => [place.placeId, place])).values()).slice(0, 40);
      return sendJson(res, 200, { places, source: 'development-mock', isDevelopmentMock: true });
    }
    const jobs = [];
    for (const query of safeQueries) {
      if (safeSeeds.length) {
        for (const seed of safeSeeds) {
          jobs.push(searchText({
            textQuery: `${query} in Philippines`,
            locationBias: { circle: { center: { latitude: Number(seed.lat), longitude: Number(seed.lng) }, radius: 50000 } },
            maxResultCount: 8,
          }));
        }
      } else {
        jobs.push(searchText({ textQuery: `${query} in Philippines`, maxResultCount: 8 }));
      }
    }

    const results = await Promise.all(jobs);
    const places = Array.from(new Map(
      results.flatMap((result) => result.places || []).filter((place) => place.id).map((place) => [place.id, mapPlace(place)])
    ).values()).filter((place) => place.lat !== null && place.lng !== null).slice(0, 40);

    return sendJson(res, 200, { places });
  } catch (error) {
    return sendJson(res, 503, { error: error.message || 'Google Maps is currently unavailable.' });
  }
});

app.post('/api/maps/place-suggestions', requireAppAuth, limitPerUser('maps-suggestions', 1200, HOUR_MS), async (req, res) => {
  const input = String(req.body?.input || '').trim().slice(0, 160);
  const suppliedSessionToken = String(req.body?.sessionToken || '');
  const sessionToken = /^[A-Za-z0-9_-]{1,36}$/.test(suppliedSessionToken) ? suppliedSessionToken : '';
  if (input.length < 2) return sendJson(res, 200, { suggestions: [] });
  try {
    if (isDevelopmentMode) {
      const needle = input.toLowerCase();
      const matches = developmentPlaceCatalog.filter((place) => (
        place.name.toLowerCase().includes(needle) || place.address.toLowerCase().includes(needle)
      )).slice(0, 5);
      const suggestions = matches.map((match) => {
        const place = developmentPlace(match.name);
        return ({
        placeId: place.placeId,
        text: `${place.name}, ${place.address}`,
        name: place.name,
        secondaryText: place.address,
        types: place.types || [],
        isDevelopmentMock: true,
      });
      });
      return sendJson(res, 200, { suggestions, isDevelopmentMock: true });
    }
    const apiKey = getMapsApiKey();
    if (!apiKey) throw new Error('Google Maps is not configured on the backend.');
    const touristTypeOrder = ['tourist_attraction', 'landmark', 'national_park', 'museum', 'park'];
    const requestSuggestions = async (includedPrimaryTypes) => {
      const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types',
        },
        body: JSON.stringify({
          input,
          ...(sessionToken ? { sessionToken } : {}),
          includedRegionCodes: ['PH'],
          includedPrimaryTypes,
          languageCode: 'en',
          regionCode: 'PH',
          includeQueryPredictions: false,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = data?.error?.message || data?.error?.status;
        throw new Error(reason ? `Google place suggestions failed: ${reason}` : 'Google place suggestions are unavailable.');
      }
      return data;
    };
    const mapSuggestions = (data) => (data.suggestions || []).map((item, index) => {
      const prediction = item.placePrediction;
      if (!prediction?.placeId) return null;
      const types = Array.isArray(prediction.types) ? prediction.types : [];
      const mainText = prediction.structuredFormat?.mainText?.text || prediction.text?.text || '';
      const secondaryText = prediction.structuredFormat?.secondaryText?.text || '';
      const rank = touristTypeOrder.findIndex((type) => types.includes(type));
      return {
        placeId: prediction.placeId,
        text: prediction.text?.text || [mainText, secondaryText].filter(Boolean).join(', '),
        name: mainText,
        secondaryText,
        types,
        touristRank: rank < 0 ? touristTypeOrder.length : rank,
        originalRank: index,
      };
    }).filter(Boolean).sort((a, b) => a.touristRank - b.touristRank || a.originalRank - b.originalRank);

    let suggestions;
    if (req.body?.scope === 'destination') {
      // Onboarding destination picker: allow cities/towns as well as attractions.
      const [attractionData, cityData] = await Promise.all([
        requestSuggestions(touristTypeOrder),
        requestSuggestions(['(cities)']).catch(() => ({})),
      ]);
      const merged = [...mapSuggestions(cityData), ...mapSuggestions(attractionData)];
      suggestions = Array.from(new Map(merged.map((item) => [item.placeId, item])).values())
        .slice(0, 6).map(({ touristRank, originalRank, ...suggestion }) => suggestion);
    } else {
      suggestions = mapSuggestions(await requestSuggestions(touristTypeOrder))
        .slice(0, 5).map(({ touristRank, originalRank, ...suggestion }) => suggestion);
    }
    return sendJson(res, 200, { suggestions });
  } catch (error) {
    return sendJson(res, 503, { error: error.message || 'Google place suggestions are unavailable.' });
  }
});

app.post('/api/maps/place-details', requireAppAuth, limitPerUser('maps-details', 600, HOUR_MS), async (req, res) => {
  const placeId = String(req.body?.placeId || '').trim();
  const suppliedSessionToken = String(req.body?.sessionToken || '');
  const sessionToken = /^[A-Za-z0-9_-]{1,36}$/.test(suppliedSessionToken) ? suppliedSessionToken : '';
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(placeId)) {
    return sendJson(res, 400, { error: 'A valid place ID is required.' });
  }
  try {
    if (isDevelopmentMode) {
      const match = developmentPlaceCatalog.find((place) => `mock-place-${place.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` === placeId);
      if (!match) return sendJson(res, 404, { error: 'That sample place was not found.' });
      return sendJson(res, 200, { place: developmentPlace(match.name), isDevelopmentMock: true });
    }
    const apiKey = getMapsApiKey();
    if (!apiKey) throw new Error('Google Maps is not configured on the backend.');
    const detailsUrl = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
    if (sessionToken) detailsUrl.searchParams.set('sessionToken', sessionToken);
    const response = await fetch(detailsUrl, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,formattedAddress,location,types,photos.name,photos.authorAttributions,photos.googleMapsUri',
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.message || data?.error?.status;
      throw new Error(reason ? `Google place details failed: ${reason}` : 'Google place details are unavailable.');
    }
    return sendJson(res, 200, { place: mapPlace(data) });
  } catch (error) {
    return sendJson(res, 503, { error: error.message || 'Google place details are unavailable.' });
  }
});

app.post('/api/maps/route', requireAppAuth, limitPerUser('maps-route', 1200, HOUR_MS), async (req, res) => {
  const { origin, destination, travelMode = 'DRIVE' } = req.body || {};
  try {
    const route = await calculateRoute({ origin, destination, travelMode });
    return sendJson(res, 200, {
      route,
      source: isDevelopmentMode ? 'development-mock' : 'google-routes',
      isDevelopmentMock: isDevelopmentMode,
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 503, { error: error.message || 'Route information is currently unavailable.' });
  }
});

app.get('/api/maps/photo', async (req, res) => {
  if (isRateLimited(`maps-photo:${req.ip}`, 3000, HOUR_MS)) {
    return sendJson(res, 429, { error: 'Too many photo requests. Please try again later.' });
  }
  const resourceName = String(req.query.name || '');
  if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(resourceName)) {
    return sendJson(res, 400, { error: 'Invalid Google photo resource.' });
  }

  try {
    const apiKey = getMapsApiKey();
    if (!apiKey) throw new Error('Google Maps is not configured on the backend.');
    const response = await fetch(`https://places.googleapis.com/v1/${resourceName}/media?maxWidthPx=800&key=${apiKey}`);
    if (!response.ok) return sendJson(res, 502, { error: 'Google photo is currently unavailable.' });
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    return sendJson(res, 503, { error: 'Google photo is currently unavailable.' });
  }
});

app.post('/api/chat', requireAppAuth, limitPerUser('chat', 60, 10 * MINUTE_MS), async (req, res) => {
  const { email, message = '', selectedDestination, history = [], profile = {} } = req.body || {};
  const normalizedEmail = normalizeEmail(req.appUser.email);
  if (email && normalizeEmail(email) !== normalizedEmail) {
    return sendJson(res, 403, { error: 'You can only chat using your signed-in account.' });
  }
  const userMessage = String(message || '').trim();
  let chatDestination = selectedDestination && typeof selectedDestination === 'object' ? { ...selectedDestination } : null;
  const asksDestinationReviews = /\b(?:reviews?|reviewed|ratings?|visitor feedback|worth visiting|what do (?:visitors|people) think)\b/i.test(userMessage);

  if (!userMessage) {
    return sendJson(res, 400, { error: 'Please enter a message for the assistant.' });
  }
  if (req.body?.kind !== 'continuation') recordAppUsageEvent(req.appUser.userId, 'chat_message');

  try {
    if (asksDestinationReviews) {
      if (!isDevelopmentMode && chatDestination?.placeId) {
        try {
          chatDestination.reviewData = await fetchGooglePlaceReviewData(chatDestination.placeId);
        } catch (error) {
          chatDestination.reviewData = { available: false };
        }
      } else {
        chatDestination = { ...(chatDestination || {}), reviewData: { available: false } };
      }
    }

    const storedProfile = await getUserProfileContext(normalizedEmail);
    const userProfile = {
      ...storedProfile,
      ...profile,
      travelTypes: Array.isArray(profile.travelTypes) && profile.travelTypes.length ? profile.travelTypes : storedProfile.travelTypes,
      interests: Array.isArray(profile.interests) && profile.interests.length ? profile.interests : storedProfile.interests,
      preferredPlaces: Array.isArray(profile.preferredPlaces) && profile.preferredPlaces.length ? profile.preferredPlaces : storedProfile.preferredPlaces,
      budget: profile.budget || storedProfile.budget || 'Mid-Range',
    };

    const response = await generateAgentReply({
      email: normalizedEmail,
      message: userMessage,
      selectedDestination: chatDestination,
      history,
      profile: userProfile,
    });

    if (Array.isArray(response?.itinerary)) {
      response.tripId = await persistItineraryForUser(req.appUser.userId, response.itinerary, response.meta || {});
    }
    return sendJson(res, 200, response);
  } catch (error) {
    console.error('Chat error:', error.message);
    return sendJson(res, 500, {
      reply: 'Sorry, I hit a temporary issue while planning. Please try again in a moment.',
      meta: { error: error.message || 'AI unavailable' },
    });
  }
});

app.post('/api/itinerary/generate', requireAppAuth, limitPerUser('itinerary-generate', 20, HOUR_MS), async (req, res) => {
  const { email, message = '', selectedDestination, profile = {}, origin = null } = req.body || {};
  const normalizedEmail = normalizeEmail(req.appUser.email);
  if (email && normalizeEmail(email) !== normalizedEmail) {
    return sendJson(res, 403, { error: 'You can only generate an itinerary for your signed-in account.' });
  }
  const userMessage = String(message || '').trim();

  if (!userMessage) {
    return sendJson(res, 400, { error: 'Please describe the itinerary you want to generate.' });
  }
  if (!normalizedEmail) {
    return sendJson(res, 401, { error: 'Authentication is required to generate an itinerary.' });
  }

  try {
    const pool = await getPool();
    const userResult = await pool.query`
      SELECT user_id
      FROM dbo.users
      WHERE user_id = ${req.appUser.userId} AND email = ${normalizedEmail} AND is_verified = 1
    `;
    if (!userResult.recordset.length) {
      return sendJson(res, 401, { error: 'Authenticated user was not found.' });
    }
    if (req.body?.source === 'chat') recordAppUsageEvent(req.appUser.userId, 'chat_message');
    const storedProfile = await getUserProfileContext(normalizedEmail);
    const userProfile = {
      ...storedProfile,
      ...profile,
      travelTypes: Array.isArray(profile.travelTypes) && profile.travelTypes.length ? profile.travelTypes : storedProfile.travelTypes,
      interests: Array.isArray(profile.interests) && profile.interests.length ? profile.interests : storedProfile.interests,
      preferredPlaces: Array.isArray(profile.preferredPlaces) && profile.preferredPlaces.length ? profile.preferredPlaces : storedProfile.preferredPlaces,
      budget: profile.budget || 'Mid-Range',
    };

    const generated = await generateVerifiedItineraryFromAi({
      email: normalizedEmail,
      message: userMessage,
      selectedDestination,
      profile: userProfile,
      includeBudgetResearch: true,
      origin: origin && (origin.address || origin.name) ? {
        name: String(origin.name || '').slice(0, 120),
        address: String(origin.address || origin.name || '').slice(0, 240),
      } : null,
    });
    const tripId = await persistItineraryForUser(req.appUser.userId, generated.itinerary, generated.meta);

    return sendJson(res, 200, {
      ok: true,
      itinerary: generated.itinerary,
      meta: generated.meta,
      tripId,
    });
  } catch (error) {
    console.error('Itinerary generation error:', error.message);
    return sendJson(res, 503, { error: error.message || 'Verified itinerary generation is currently unavailable.' });
  }
});

const hotelRateCache = new Map();
const HOTEL_TYPE_PATTERN = /(^|_)(lodging|hotel|resort_hotel|motel|hostel|inn|guest_house|bed_and_breakfast|extended_stay_hotel|cottage|villa)(_|$)/;

function hotelRateResponseSchema() {
  return {
    type: 'object',
    properties: {
      hotelRates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            placeId: { type: 'string' },
            lowPhp: { type: ['number', 'null'] },
            highPhp: { type: ['number', 'null'] },
            basis: { type: 'string' },
            sourceUrls: { type: 'array', items: { type: 'string' } },
          },
          required: ['placeId', 'lowPhp', 'highPhp', 'basis', 'sourceUrls'],
        },
      },
    },
    required: ['hotelRates'],
  };
}

function coordinatesOrNull(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && lat !== null && lng !== null && lat !== '' && lng !== ''
    ? { lat: Number(lat), lng: Number(lng) }
    : null;
}

// Up to 12 well-rated hotels near the destination, from Google Places. The Places
// requests are cached by callGooglePlacesApi, so repeated calls cost nothing extra.
async function findHotelCandidates(destination, lat, lng) {
  let center = coordinatesOrNull(lat, lng);
  if (!center) {
    const located = await callGooglePlacesApi('places:searchText', { textQuery: `${destination}, Philippines`, maxResultCount: 1 });
    const first = (located.places || []).map(mapPlace).find((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
    if (first) center = { lat: first.lat, lng: first.lng };
  }
  const bias = center ? { locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 30000 } } } : {};
  const searches = await Promise.all(['hotels', 'resorts', 'budget hotels and inns'].map((query) => (
    callGooglePlacesApi('places:searchText', { textQuery: `${query} in ${destination}`, maxResultCount: 10, ...bias }).catch(() => ({ places: [] }))
  )));
  const candidates = Array.from(new Map(searches.flatMap((data) => data.places || []).map(mapPlace)
    .filter((place) => place.placeId && Number.isFinite(place.lat) && Number.isFinite(place.lng))
    .filter((place) => place.types.some((type) => HOTEL_TYPE_PATTERN.test(String(type).toLowerCase())))
    .filter((place) => !center || haversineKm(center, place) <= 40)
    .map((place) => [place.placeId, place])).values())
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || (Number(b.ratingCount) || 0) - (Number(a.ratingCount) || 0))
    .slice(0, 12);
  return { center, candidates };
}

// Nightly rates for the candidate hotels from one grounded web search (the costly
// step), cached for 6 hours per destination, dates and hotel list. The budget check
// and the hotel picker share this cache, so a check followed by the picker searches once.
async function researchHotelRates({ destination, startDate, endDate, nights, candidates }) {
  const cacheKey = JSON.stringify([destination.toLowerCase(), startDate, endDate, candidates.map((place) => place.placeId)]);
  const cached = hotelRateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const grounded = await callGeminiSearchApi({
    contextText: [
      `Destination: ${destination}, Philippines`,
      `Stay: ${startDate} to ${endDate} (${nights} night${nights === 1 ? '' : 's'})`,
      `Hotels verified by Google Places: ${JSON.stringify(candidates.map((place) => ({ placeId: place.placeId, name: place.name, address: place.address })))}`,
    ].join('\n'),
    message: 'Search the web now for the current price of a standard room for one night at each listed hotel, for stays around these dates. Prefer the hotel\'s official site and major booking sites. Return one JSON object only, without markdown, shaped as {"hotelRates":[{"placeId":"exact supplied placeId","lowPhp":null,"highPhp":null,"basis":"brief price basis","sourceUrls":[]}]}, one item per supplied hotel, preserving each exact placeId. Give a realistic low and high nightly rate in PHP (convert with a current rate if needed) only when a current source supports it, and include the URL(s) of the pages that support it. Use null for both bounds when you cannot find evidence. Never invent a price or a source URL.',
    responseSchema: hotelRateResponseSchema(),
  });
  const parsed = extractJsonObject(grounded.text);
  if (!parsed) throw new Error('Hotel price search returned data that could not be read.');
  const allowedSources = new Set(grounded.sources.map((source) => source.url));
  const byPlaceId = {};
  for (const entry of Array.isArray(parsed.hotelRates) ? parsed.hotelRates : []) {
    const band = normalizeSourcedPriceBand(entry, allowedSources);
    const placeId = String(entry?.placeId || '');
    // A room under ₱300 a night is not a real hotel rate (usually a misread
    // fee or per-person figure), so it is treated as "no evidence".
    if (placeId && band && band.lowPhp >= MIN_REALISTIC_ROOM_PHP) byPlaceId[placeId] = { ...band, basis: String(entry.basis || '').slice(0, 200) };
  }
  const rates = { byPlaceId, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  if (hotelRateCache.size >= 200) hotelRateCache.delete(hotelRateCache.keys().next().value);
  hotelRateCache.set(cacheKey, rates);
  return rates;
}

// Budget check thresholds (PHP).
const MIN_REALISTIC_ROOM_PHP = 300;    // the cheapest real room rate accepted anywhere
const COMFORTABLE_ROOM_PHP = 2500;     // most areas have rooms at or under this
const FALLBACK_MEAL_PHP = 100;         // a basic meal when no restaurant prices are listed
const MIN_MEAL_PHP = 80;
const MEALS_PER_DAY = 2;
const PRICE_LEVEL_MEAL_PHP = { PRICE_LEVEL_INEXPENSIVE: 100, PRICE_LEVEL_MODERATE: 300, PRICE_LEVEL_EXPENSIVE: 700, PRICE_LEVEL_VERY_EXPENSIVE: 1500 };
const FOOD_TYPE_PATTERN = /(restaurant|cafe|coffee|food|bakery|bar_and_grill|diner|eatery|meal_takeaway)/;

// Per-person meal price from Google's price data (cheapest realistic figure).
function mealPricePhp(place) {
  const range = place.priceRange;
  if (range && Number.isFinite(Number(range.lowPhp)) && range.lowPhp > 0) return Math.max(MIN_MEAL_PHP, range.lowPhp);
  // "Under ₱200" style bands report a low of 0: count half the upper bound.
  if (range && Number.isFinite(Number(range.highPhp)) && range.highPhp > 0) return Math.max(MIN_MEAL_PHP, Math.round(range.highPhp / 2));
  return PRICE_LEVEL_MEAL_PHP[place.priceLevel] || null;
}

// Checks whether a trip budget is realistic before an itinerary is built: the
// cheapest priced restaurant for two meals a day, plus the cheapest priced hotel
// for every night. To save credits, the hotel price web search runs only when the
// answer depends on it; clearly-enough and clearly-too-small budgets are decided
// from cheap Google Places data alone. Its results are shared with the hotel picker.
app.post('/api/trip/budget-check', requireAppAuth, async (req, res) => {
  const destination = String(req.body?.destination || '').trim().slice(0, 180);
  const startDate = String(req.body?.startDate || '').slice(0, 10);
  const endDate = String(req.body?.endDate || '').slice(0, 10);
  const budgetAmountPhp = Number(req.body?.budgetAmountPhp);
  if (!destination) return sendJson(res, 400, { error: 'A destination is required to check the budget.' });
  let days;
  try {
    days = inclusiveDayCount(startDate, endDate);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  if (days < 1 || days > 14) return sendJson(res, 400, { error: 'Trips can cover between 1 and 14 days.' });
  if (!Number.isSafeInteger(budgetAmountPhp) || budgetAmountPhp < 1 || budgetAmountPhp > 100000000) {
    return sendJson(res, 400, { error: 'A whole-number trip budget in PHP is required.' });
  }
  const nights = days - 1; // a day trip needs no hotel
  const meals = days * MEALS_PER_DAY;
  if (isDevelopmentMode) {
    return sendJson(res, 200, { checked: false, realistic: true, isDevelopmentMock: true });
  }
  if (isRateLimited(`budget-check:${req.appUser.userId}`, 30, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many budget checks. Please try again later.' });
  }
  try {
    const { center, candidates } = await findHotelCandidates(destination, req.body?.lat, req.body?.lng);

    // Cheapest restaurant near the destination (one cached Places search, no web search).
    const bias = center ? { locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 20000 } } } : {};
    const food = await callGooglePlacesApi('places:searchText', { textQuery: `restaurants in ${destination}`, maxResultCount: 20, ...bias }).catch(() => ({ places: [] }));
    const pricedFood = (food.places || []).map(mapPlace)
      .filter((place) => place.types.some((type) => FOOD_TYPE_PATTERN.test(String(type).toLowerCase())))
      .map((place) => ({ place, perMealPhp: mealPricePhp(place) }))
      .filter((item) => item.perMealPhp)
      .sort((a, b) => a.perMealPhp - b.perMealPhp);
    const cheapestFood = pricedFood[0] || null;
    const perMealPhp = cheapestFood ? cheapestFood.perMealPhp : FALLBACK_MEAL_PHP;
    const mealsTotal = perMealPhp * meals;
    const mealsInfo = { name: cheapestFood?.place.name || '', perMealPhp, mealsPerDay: MEALS_PER_DAY, totalPhp: mealsTotal, estimated: !cheapestFood };

    let lodging = { needed: nights > 0, nights, nightlyLowPhp: 0, totalPhp: 0, name: '', source: 'not-needed' };
    if (nights > 0) {
      const leftForRooms = budgetAmountPhp - mealsTotal;
      if (leftForRooms < MIN_REALISTIC_ROOM_PHP * nights) {
        // Below even the cheapest real room rate: no need to search hotel prices.
        lodging = { ...lodging, nightlyLowPhp: MIN_REALISTIC_ROOM_PHP, totalPhp: MIN_REALISTIC_ROOM_PHP * nights, source: 'minimum-rate' };
      } else if (leftForRooms >= COMFORTABLE_ROOM_PHP * nights || !candidates.length) {
        // Plenty left for rooms (or no hotels listed to price): no search needed.
        lodging = { ...lodging, source: candidates.length ? 'comfortable' : 'unpriced' };
      } else {
        // The answer depends on real prices: research them (shared, cached result).
        const rates = await researchHotelRates({ destination, startDate, endDate, nights, candidates });
        const cheapest = candidates
          .map((place) => ({ place, rate: rates.byPlaceId[place.placeId] }))
          .filter((item) => item.rate)
          .sort((a, b) => a.rate.lowPhp - b.rate.lowPhp)[0];
        lodging = cheapest
          ? { ...lodging, name: cheapest.place.name, nightlyLowPhp: cheapest.rate.lowPhp, totalPhp: cheapest.rate.lowPhp * nights, source: 'researched' }
          : { ...lodging, source: 'unpriced' };
      }
    }

    const minimumPhp = mealsTotal + lodging.totalPhp;
    const realistic = budgetAmountPhp >= minimumPhp;
    // Longest trip this budget covers at the cheapest prices found.
    let maxAffordableDays = 0;
    for (let d = 1; d <= 14; d += 1) {
      if (perMealPhp * MEALS_PER_DAY * d + lodging.nightlyLowPhp * (d - 1) <= budgetAmountPhp) maxAffordableDays = d;
    }
    return sendJson(res, 200, {
      checked: true,
      realistic,
      budgetAmountPhp,
      days,
      nights,
      minimumPhp,
      maxAffordableDays,
      meals: mealsInfo,
      lodging,
    });
  } catch (error) {
    console.error('Budget check error:', error.message);
    return sendJson(res, 503, { error: error.message || 'The budget check is currently unavailable.' });
  }
});

// Lists real hotels near the destination whose researched nightly rate fits the
// lodging share of the user's budget. Uses one grounded web search per hotel list,
// cached for 6 hours so changing the budget does not search again.
app.post('/api/hotels/budget-options', requireAppAuth, async (req, res) => {
  const destination = String(req.body?.destination || '').trim().slice(0, 180);
  const startDate = String(req.body?.startDate || '').slice(0, 10);
  const endDate = String(req.body?.endDate || '').slice(0, 10);
  const budgetAmountPhp = Number(req.body?.budgetAmountPhp);
  if (!destination) return sendJson(res, 400, { error: 'A destination is required to find hotels.' });
  let days;
  try {
    days = inclusiveDayCount(startDate, endDate);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  if (days < 1 || days > 14) return sendJson(res, 400, { error: 'Trips can cover between 1 and 14 days.' });
  if (!Number.isSafeInteger(budgetAmountPhp) || budgetAmountPhp < 1 || budgetAmountPhp > 100000000) {
    return sendJson(res, 400, { error: 'A whole-number trip budget in PHP is required.' });
  }
  const nights = Math.max(1, days - 1);
  // About 40% of a whole-trip budget is a common lodging share; the rest covers
  // activities, meals, transport, and contingency.
  const lodgingAllowancePhp = Math.floor(budgetAmountPhp * 0.4);
  const nightlyCapPhp = Math.floor(lodgingAllowancePhp / nights);
  const base = { nights, lodgingAllowancePhp, nightlyCapPhp };
  if (isDevelopmentMode) {
    return sendJson(res, 200, { ...base, hotels: [], isDevelopmentMock: true, message: 'Hotel prices need live Google data, which is not available in development mode.' });
  }
  if (isRateLimited(`hotel-options:${req.appUser.userId}`, 12, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many hotel searches. Please try again later.' });
  }
  try {
    const { candidates } = await findHotelCandidates(destination, req.body?.lat, req.body?.lng);
    if (!candidates.length) {
      return sendJson(res, 200, { ...base, hotels: [], message: 'No hotels were found near this destination.' });
    }
    const rates = await researchHotelRates({ destination, startDate, endDate, nights, candidates });

    const priced = candidates
      .map((place) => ({ place, rate: rates.byPlaceId[place.placeId] }))
      .filter(({ rate }) => rate);
    const affordable = priced.filter(({ rate }) => rate.lowPhp <= nightlyCapPhp);
    // Best-rated hotels the budget can cover come first; cheaper wins a tie.
    affordable.sort((a, b) => (Number(b.place.rating) || 0) - (Number(a.place.rating) || 0) || a.rate.lowPhp - b.rate.lowPhp);
    const toHotel = ({ place, rate }) => ({
      placeId: place.placeId,
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      rating: place.rating,
      ratingCount: place.ratingCount,
      types: place.types,
      photoResource: place.photoResource,
      photoAttribution: place.photoAttribution,
      nightlyLowPhp: rate.lowPhp,
      nightlyHighPhp: rate.highPhp,
      stayLowPhp: rate.lowPhp * nights,
      stayHighPhp: rate.highPhp * nights,
      fullyWithinBudget: rate.highPhp <= nightlyCapPhp,
      basis: rate.basis,
      sourceUrls: rate.sourceUrls.slice(0, 3),
    });
    const hotels = affordable.map(toHotel);
    // Priced hotels above the nightly cap, cheapest first, so the app can show them last.
    const overBudgetHotels = priced
      .filter(({ rate }) => rate.lowPhp > nightlyCapPhp)
      .sort((a, b) => a.rate.lowPhp - b.rate.lowPhp)
      .map(toHotel);
    return sendJson(res, 200, {
      ...base,
      hotels,
      overBudgetHotels,
      overBudgetCount: priced.length - affordable.length,
      unpricedCount: candidates.length - priced.length,
    });
  } catch (error) {
    console.error('Hotel budget search error:', error.message);
    return sendJson(res, 503, { error: error.message || 'Hotel search is currently unavailable.' });
  }
});

// Photos and details for one place in the hotel and restaurant pickers. Separate
// from /api/maps/place-details so that endpoint keeps its smaller (cheaper) field mask.
const hotelDetailsCache = new Map();
const GOOGLE_PHOTO_NAME_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
const httpsUrlOrEmpty = (value) => {
  const text = String(value || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text.slice(0, 500) : '';
};

async function sendPlaceDetails(req, res) {
  const placeId = String(req.body?.placeId || '').trim();
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(placeId)) {
    return sendJson(res, 400, { error: 'A valid place ID is required.' });
  }
  if (isDevelopmentMode) {
    return sendJson(res, 200, { place: null, isDevelopmentMock: true });
  }
  const cached = hotelDetailsCache.get(placeId);
  if (cached && cached.expiresAt > Date.now()) return sendJson(res, 200, { place: cached.place });
  if (isRateLimited(`hotel-details:${req.appUser.userId}`, 60, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many place detail requests. Please try again later.' });
  }
  try {
    const apiKey = getMapsApiKey();
    if (!apiKey) throw new Error('Google Maps is not configured on the backend.');
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'id', 'displayName', 'formattedAddress', 'rating', 'userRatingCount', 'types', 'businessStatus',
          'photos.name', 'photos.authorAttributions', 'websiteUri', 'nationalPhoneNumber', 'googleMapsUri',
          'editorialSummary', 'regularOpeningHours.weekdayDescriptions',
          'reviews.rating', 'reviews.text', 'reviews.relativePublishTimeDescription', 'reviews.authorAttribution',
        ].join(','),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.message || data?.error?.status;
      throw new Error(reason ? `Google place details failed: ${reason}` : 'Place details are unavailable.');
    }
    const finiteOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
    const place = {
      placeId: String(data.id || placeId),
      name: String(data.displayName?.text || '').slice(0, 200),
      address: String(data.formattedAddress || '').slice(0, 300),
      rating: finiteOrNull(data.rating),
      ratingCount: finiteOrNull(data.userRatingCount),
      types: Array.isArray(data.types) ? data.types.slice(0, 8).map((type) => String(type).slice(0, 60)) : [],
      businessStatus: String(data.businessStatus || ''),
      summary: String(data.editorialSummary?.text || '').slice(0, 600),
      website: httpsUrlOrEmpty(data.websiteUri),
      phone: String(data.nationalPhoneNumber || '').slice(0, 40),
      googleMapsUri: httpsUrlOrEmpty(data.googleMapsUri),
      openingHours: Array.isArray(data.regularOpeningHours?.weekdayDescriptions)
        ? data.regularOpeningHours.weekdayDescriptions.slice(0, 7).map((line) => String(line).slice(0, 120))
        : [],
      // Up to 6 photos, each with the author credit Google requires to be shown.
      photos: (Array.isArray(data.photos) ? data.photos : [])
        .filter((photo) => GOOGLE_PHOTO_NAME_PATTERN.test(String(photo?.name || '')))
        .slice(0, 6)
        .map((photo) => {
          const author = Array.isArray(photo.authorAttributions) ? photo.authorAttributions[0] : null;
          return {
            resource: String(photo.name),
            authorName: String(author?.displayName || '').slice(0, 120),
            authorUri: httpsUrlOrEmpty(author?.uri),
          };
        }),
      reviews: (Array.isArray(data.reviews) ? data.reviews : []).slice(0, 3).map((review) => ({
        rating: finiteOrNull(review.rating),
        text: String(review.text?.text || '').slice(0, 600),
        when: String(review.relativePublishTimeDescription || '').slice(0, 60),
        authorName: String(review.authorAttribution?.displayName || '').slice(0, 120),
        authorUri: httpsUrlOrEmpty(review.authorAttribution?.uri),
      })).filter((review) => review.text),
    };
    if (hotelDetailsCache.size >= 300) hotelDetailsCache.delete(hotelDetailsCache.keys().next().value);
    hotelDetailsCache.set(placeId, { place, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    return sendJson(res, 200, { place });
  } catch (error) {
    console.error('Place details error:', error.message);
    return sendJson(res, 503, { error: 'Place details are unavailable right now.' });
  }
}

// Both paths share one handler, cache and per-user rate limit.
app.post('/api/hotels/details', requireAppAuth, sendPlaceDetails);
app.post('/api/places/details', requireAppAuth, sendPlaceDetails);

app.post('/api/itinerary/estimate-budget', requireAppAuth, limitPerUser('estimate-budget', 30, HOUR_MS), async (req, res) => {
  const { email, itinerary, destination, startDate, endDate } = req.body || {};
  const normalizedEmail = normalizeEmail(email || req.appUser.email);
  if (!normalizedEmail) return sendJson(res, 401, { error: 'Authentication is required to estimate a trip budget.' });
  if (normalizedEmail !== normalizeEmail(req.appUser.email)) {
    return sendJson(res, 403, { error: 'You can only estimate costs for your own itinerary.' });
  }
  if (!Array.isArray(itinerary) || itinerary.length < 1 || itinerary.length > 14) {
    return sendJson(res, 400, { error: 'The itinerary must contain between 1 and 14 days.' });
  }
  if (!dateOnly(startDate) || !dateOnly(endDate) || inclusiveDayCount(startDate, endDate) !== itinerary.length) {
    return sendJson(res, 400, { error: 'Valid trip dates matching the itinerary length are required.' });
  }
  const safeItinerary = itinerary.map((day) => ({
    activities: (Array.isArray(day?.activities) ? day.activities : []).slice(0, 8).map((activity) => ({
      placeId: String(activity?.placeId || '').slice(0, 180),
      title: String(activity?.title || '').slice(0, 180),
      location: String(activity?.location || '').slice(0, 240),
      category: String(activity?.category || 'activity').slice(0, 80),
    })),
  }));
  if (safeItinerary.reduce((count, day) => count + day.activities.length, 0) > 40) {
    return sendJson(res, 400, { error: 'The itinerary contains too many activities to price at once.' });
  }
  try {
    const pool = await getPool();
    const userResult = await pool.query`
      SELECT user_id
      FROM dbo.users
      WHERE email = ${normalizedEmail} AND is_verified = 1
    `;
    if (!userResult.recordset.length) return sendJson(res, 401, { error: 'Authenticated user was not found.' });
    const estimate = await estimateVerifiedTripBudget({
      itinerary: safeItinerary,
      destination: String(destination || '').slice(0, 180),
      startDate,
      endDate,
    });
    return sendJson(res, 200, { ok: true, ...estimate });
  } catch (error) {
    console.error('Trip cost research error:', error.message);
    return sendJson(res, 503, { error: error.message || 'Live trip cost research is currently unavailable.' });
  }
});

// ---- Not found and error responses (registered after every route) -------------
// Unknown API routes answer in JSON so the app and admin site can show a message.
app.use('/api', (req, res) => sendJson(res, 404, { error: 'This Sidekick API endpoint does not exist.' }));

// Unknown pages show the app's "Page not found" page instead of Express's default text.
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) {
    if (isProduction) {
      return res.status(404).type('html').send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found · Sidekick</title></head>'
        + '<body><h1>Page not found</h1><p><a href="/">Go to Sidekick Admin</a></p></body></html>');
    }
    return res.status(404).sendFile(path.join(mobileAppDir, '404.html'));
  }
  return sendJson(res, 404, { error: 'Not found.' });
});

// Errors never reveal stack traces or server file paths to the caller.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error?.type === 'entity.parse.failed' ? 400
    : error?.type === 'entity.too.large' ? 413
      : Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
  const message = status === 400 ? 'The request was not valid. Please try again.'
    : status === 413 ? 'The request is too large.'
      : 'Something went wrong on the server. Please try again.';
  if (status >= 500) console.error('Unhandled server error:', error?.message || error);
  return sendJson(res, status, { error: message });
});

setInterval(cleanUnverifiedUsers, 60 * 60 * 1000).unref();
setInterval(() => {
  void cleanExpiredSessions();
}, 60 * 60 * 1000).unref();
setInterval(() => {
  void cleanExpiredItineraries().catch(() => {});
}, 5 * 60 * 1000).unref();

// Production self-check: warn (in the server log) about missing security settings.
if (isProduction) {
  const warnings = [
    !forceHttps && 'FORCE_HTTPS is not set, so plain HTTP is allowed.',
    !String(process.env.TRUST_PROXY || '').trim() && 'TRUST_PROXY is not set; behind a load balancer every visitor will share one rate limit.',
    !corsAllowedOrigins.length && 'CORS_ALLOWED_ORIGINS is not set, so any website may call the API from a browser.',
    getAdminCredentials().password.length < 12 && 'ADMIN_PASSWORD is shorter than 12 characters; admin sign-in is turned off.',
    !['1', 'true', 'yes'].includes(String(process.env.DB_ENCRYPT || '').trim().toLowerCase()) && 'DB_ENCRYPT is not set; the database connection is not encrypted.',
    isDevelopmentMode && 'SIDEKICK_API_MODE is development; set it to production.',
  ].filter(Boolean);
  for (const warning of warnings) console.warn(`[security] ${warning}`);
}

app.listen(port, () => {
  console.log(`Sidekick backend listening on http://localhost:${port}`);
});
