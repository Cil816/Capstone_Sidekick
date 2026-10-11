import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sql from 'mssql';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const mobileAppDir = path.join(projectRoot, 'mobile-app');

const app = express();
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
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    ...(useWindowsAuthentication ? { trustedConnection: true } : {}),
    ...(configuredInstanceName
      ? { instanceName: configuredInstanceName }
      : {}),
  },
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(mobileAppDir, { index: false }));

app.get('/', (req, res) => {
  res.sendFile(path.join(mobileAppDir, 'index.html'));
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

function createAppSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    userId: Number(user.user_id),
    email: String(user.email || ''),
    name: String(user.name || ''),
    expiresAt: Date.now() + APP_SESSION_TTL_MS,
  };
  appSessions.set(token, session);
  return { token, expiresAt: session.expiresAt };
}

function requireAppAuth(req, res, next) {
  const token = getAppTokenFromRequest(req);
  const session = token ? appSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) appSessions.delete(token);
    return sendJson(res, 401, { error: 'Your app session has expired. Please sign in again.' });
  }
  req.appUser = session;
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

function requireAdminAuth(req, res, next) {
  const providedToken = getAdminTokenFromRequest(req);
  if (providedToken) {
    const session = adminSessions.get(providedToken);
    if (session && session.expiresAt > Date.now()) {
      req.admin = session;
      return next();
    }
    adminSessions.delete(providedToken);
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
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours.weekdayDescriptions,places.types,places.photos.name,places.photos.authorAttributions,places.photos.googleMapsUri',
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

async function callGeminiApi({ message, contextText, systemInstruction, responseMimeType = 'text/plain', maxOutputTokens = 1200 }) {
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

  if (/\b(name|email)\b/.test(lowerMessage) && /\b(my|i)\b/.test(lowerMessage)) {
    return { reply: `Your name is ${currentUser.name} and your email is ${currentUser.email}.`, meta: { source: 'sidekick-direct' } };
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
  const systemInstruction = 'You are Sidekick, a friendly and practical Philippine travel companion. Sound natural and conversational, like a helpful person. Avoid canned greetings, repeated "How can I help?" questions, stiff phrases, and unnecessary recaps. Do not greet again in the middle of a conversation. If the user already named a destination, respond to it with useful, specific information instead of asking what they want to do. Ask at most one focused question when needed. Match answer length to the request: answer simple questions briefly, but give enough detail for planning, comparisons, budgets, and explanations. For itinerary requests, include specific places, scheduled times, estimated time at each stop, and route durations only when verified. Do not invent prices or route times; say when they are unavailable. Format answers with short paragraphs separated by blank lines, simple bullet lists for multiple options or steps, and **bold** sparingly for important places, times, or decisions. Avoid headings for short replies and never output raw JSON, Markdown fences, or decorative symbols. Use Sidekick tools for current user data and mutations. Never claim a mutation succeeded unless its tool succeeds. Ask for confirmation before destructive deletion. Do not reveal credentials or internal tool details.';
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
      return { reply: sanitizePlanText(reply), actions: uiActions, meta: { source: 'gemini-agent', model: getAiModel() } };
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
    `Request: ${message}`,
  ].join('\n');
  const preliminaryText = await callGeminiApi({
    message,
    contextText: planningContext,
    systemInstruction: `Return JSON only: {"destination":"...","durationDays":${durationDays},"days":[{"day":1,"theme":"...","activities":[{"searchQuery":"specific real place or category","category":"attraction|restaurant|cafe|museum|hotel|shopping|activity","durationMinutes":90,"notes":"..."}]}]}. Return exactly ${durationDays} days from ${startDate} through ${endDate}, with 2-${maxActivitiesPerDay} activities per day. Keep activities within the selected destination area and match the user's interests. Treat the stated budget as the ceiling for the whole trip, not just admission tickets. When the user provided a numeric budget, use the activity allowance as a target across the days: favor worthwhile free or low-cost places, then include the best paid experiences that fit. Use the allowance deliberately without forcing the user to spend it all; leave the rest for transport, lodging, meals, and contingency. Avoid repeating places. Never invent place IDs, addresses, ratings, opening hours, ticket prices, transportation fares, or travel times. Leave unverified prices unavailable.`,
    responseMimeType: 'application/json',
    maxOutputTokens: 3000,
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
    for (let candidateRank = 0; candidateRank < 3 && researchCandidates.length < 40; candidateRank++) {
      for (const set of candidateSets) {
        const place = set.candidates[candidateRank];
        if (!place || seenCandidateIds.has(place.placeId) || researchCandidates.length >= 40) continue;
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

  const finalBudgetContext = budgetAmountPhp
    ? `The user's whole-trip ceiling is PHP ${budgetAmountPhp.toLocaleString()}. Keep admission and ticket spending around PHP ${activityBudgetTargetPhp.toLocaleString()} total (about PHP ${dailyActivityBudgetTargetPhp.toLocaleString()} per day), leaving the remaining budget for intercity travel, lodging, meals, local transport, and contingency. This activity allowance is an initial planning allocation, not a verified full-trip quote.`
    : `Budget style: ${userProfile.budget || 'not provided'}. Prefer good value and include free/low-cost alternatives when a venue's price is unknown.`;

  const finalText = await callGeminiApi({
    message: JSON.stringify({ preliminary, candidateSets: pricedCandidateSets }),
    contextText: `Create the final structured itinerary only from the Google Places candidates grouped under each sourceKey for the user's selected destination: ${destination}. ${finalBudgetContext} A candidate can only be used for its own sourceKey. Candidate admission estimates, when present, come from web price research; unknown prices are not free. Group each day geographically, avoid duplicates, and use each day's activity allowance as a target while staying within the total allowance where verified prices make that possible. Prefer well-rated, worthwhile activities and use the available budget intentionally; do not add weak stops just to spend more. If the budget is tight, choose publicly free or lower-priced activities and reduce paid experiences while keeping the user's must-see places where possible. For restaurants, use Google price level only as a rough meal-cost signal, not as an admission fee. Do not invent business hours, prices, addresses, or travel times. Route times will be calculated separately from the final chosen stop order.`,
    systemInstruction: `Return JSON only with {"trip":{"destination":"","startDate":"${startDate}","endDate":"${endDate}","durationDays":${durationDays},"budget":"","currency":"PHP"},"days":[{"day":1,"theme":"","activities":[{"sourceKey":"d1a1","placeId":"exact candidate id","durationMinutes":90,"category":"attraction|restaurant|cafe|museum|hotel|shopping|activity","notes":""}]}]}. Return exactly ${durationDays} days and 1-${maxActivitiesPerDay} activities per day. Every placeId must be one of the candidates listed under that activity's sourceKey. Treat the budget as a whole-trip ceiling, not permission to spend it all on attractions. Use supplied admission estimates to plan paid activities around both the daily and total allowance, favoring the best experiences for the money. For unknown admission prices, prefer publicly free places and never assume an unknown price is free. For restaurants, Google price level is only a rough meal-cost signal, not an admission price. Preserve time and money for transport, lodging, meals, and contingency. Use the allowance intentionally without forcing the user to spend it all. Return no cost or schedule times; the app will add estimated schedules and researched costs. Do not include unsupported factual claims.`,
    responseMimeType: 'application/json',
    maxOutputTokens: 5000,
  });
  const finalPlan = extractJsonObject(finalText);
  if (!finalPlan?.days?.length) throw new Error('The AI returned an invalid final itinerary.');
  if (finalPlan.days.length !== durationDays) throw new Error(`The AI returned ${finalPlan.days.length} final days, but ${durationDays} days were requested.`);

  const verifiedById = new Map(verifiedPlaces.map((place) => [place.placeId, place]));
  const usedPlaces = new Set();
  const selectedDays = finalPlan.days.map((day, dayIndex) => {
    const selected = [];
    for (const activity of (Array.isArray(day.activities) ? day.activities : []).slice(0, maxActivitiesPerDay)) {
      const candidateSet = candidateSetsByKey.get(String(activity.sourceKey || ''));
      if (candidateSet?.day !== dayIndex + 1) continue;
      const candidates = candidateSet.candidates;
      const requestedId = String(activity.placeId || '');
      const place = candidates.find((candidate) => candidate.placeId === requestedId && !usedPlaces.has(candidate.placeId))
        || candidates.find((candidate) => !usedPlaces.has(candidate.placeId));
      if (!place || !verifiedById.has(place.placeId)) continue;
      usedPlaces.add(place.placeId);
      selected.push({ activity, place, sourceKey: String(activity.sourceKey || '') });
    }
    if (!selected.length) {
      const fallback = candidateSets.find((set) => set.day === dayIndex + 1 && set.candidates.some((place) => !usedPlaces.has(place.placeId)));
      const place = fallback?.candidates.find((candidate) => !usedPlaces.has(candidate.placeId));
      if (place) {
        usedPlaces.add(place.placeId);
        selected.push({ activity: { durationMinutes: 90, category: fallback.category, notes: '' }, place, sourceKey: fallback.sourceKey });
      }
    }
    if (!selected.length) throw new Error(`Google Places could not verify activities for day ${dayIndex + 1}.`);
    return selected;
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
    if (pricedBands.length) {
      const total = addPriceBands(pricedBands);
      const sourceMap = new Map(liveActivityCosts.flatMap((cost) => cost.sources || []).map((source) => [source.url, source]));
      selectedBudgetResearch = {
        liveActivityCosts,
        liveTripBudget: {
          status: pricedBands.length === selectedActivities.length ? 'complete-estimate' : 'partial-estimate',
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
      budget: finalPlan.trip?.budget || (budgetAmountPhp ? `PHP ${budgetAmountPhp.toLocaleString()} total` : userProfile.budget || null),
      budgetAmountPhp,
      activityBudgetTargetPhp,
      dailyActivityBudgetTargetPhp,
      ...(selectedBudgetResearch || {}),
      currency: finalPlan.trip?.currency || 'PHP',
      verifiedPlaceCount: verifiedPlaces.length,
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

function isUndeliverableEmailError(error) {
  const responseCode = Number(error?.responseCode || 0);
  const message = `${error?.code || ''} ${error?.response || ''} ${error?.message || ''}`;
  return [550, 551, 553].includes(responseCode)
    || /5\.1\.1|5\.1\.0|unknown user|user unknown|mailbox.*not found|recipient.*not found|address.*not found/i.test(message);
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

  if (!username || !password
    || !matchesAdminSecret(username, configured.username)
    || !matchesAdminSecret(password, configured.password)) {
    await recordAdminAudit(req, 'admin_login', 'failure');
    return sendJson(res, 401, { error: 'Invalid administrator credentials.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    username,
    role: 'super-admin',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  await recordAdminAudit(req, 'admin_login', 'success', username);

  return sendJson(res, 200, { token, user: { username, role: 'super-admin' } });
});

app.post('/api/admin/logout', requireAdminAuth, async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  if (token) adminSessions.delete(token);
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
    const [userSummary, tripSummary, itinerarySummary, adminAuditAvailable] = await Promise.all([
      pool.query`SELECT COUNT_BIG(*) AS total_users, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users, SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive_users, SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) AS verified_users, SUM(CASE WHEN is_verified = 0 THEN 1 ELSE 0 END) AS unverified_users FROM dbo.users`,
      pool.query`SELECT COUNT_BIG(*) AS total_trips, SUM(CASE WHEN created_at >= DATEADD(day, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS trips_last_30_days FROM dbo.trips`,
      pool.query`SELECT (SELECT COUNT_BIG(*) FROM dbo.trip_days) AS total_trip_days, (SELECT COUNT_BIG(*) FROM dbo.itinerary_activities) AS total_activities`,
      hasAdminAuditLogTable(pool),
    ]);

    const userRow = userSummary.recordset[0] || {};
    const tripRow = tripSummary.recordset[0] || {};
    const itineraryRow = itinerarySummary.recordset[0] || {};

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
        onlineUsers: getOnlineAppUserCount(),
        verifiedUsers: Number(userRow.verified_users || 0),
        unverifiedUsers: Number(userRow.unverified_users || 0),
        totalTrips: Number(tripRow.total_trips || 0),
        tripsLast30Days: Number(tripRow.trips_last_30_days || 0),
        totalTripDays: Number(itineraryRow.total_trip_days || 0),
        totalActivities: Number(itineraryRow.total_activities || 0),
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
    const search = String(req.query.search || '').trim();
    const pagination = parseAdminPagination(req.query);
    const status = String(req.query.status || 'all').trim().toLowerCase();
    if (!pagination) return sendJson(res, 400, { error: 'Page and limit must be positive integers.' });
    if (search.length > 100) return sendJson(res, 400, { error: 'Search must be 100 characters or fewer.' });
    if (!['all', 'active', 'inactive', 'verified', 'unverified'].includes(status)) {
      return sendJson(res, 400, { error: 'Choose a supported user status filter.' });
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
    const query = `
      SELECT user_id, name, email, created_at, is_active, is_verified,
             ${lastActiveTrackingAvailable ? 'last_active_at' : 'CAST(NULL AS datetime2(7)) AS last_active_at'}
      FROM dbo.users
      ${where}
      ORDER BY created_at DESC, user_id DESC
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
        isOnline: isAppUserOnline(user.user_id),
        accountState: user.is_active ? 'active' : 'inactive',
      })),
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

    const [summary, rows, count] = await Promise.all([
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
    ]);
    const summaryRow = summary.recordset[0] || {};
    return sendJson(res, 200, {
      page: pagination.page,
      limit: pagination.limit,
      total: Number(count.recordset[0]?.total || 0),
      averageRating: summaryRow.average_rating == null ? null : Number(summaryRow.average_rating),
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

    for (const [token, session] of appSessions) {
      if (session.userId === userId) appSessions.delete(token);
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
  try {
    const pool = await getPool();
    const [registrationTrend, tripTrend] = await Promise.all([
      pool.query`SELECT CONVERT(date, created_at) AS day, COUNT_BIG(*) AS count_value FROM dbo.users WHERE created_at >= DATEADD(day, -29, CONVERT(date, SYSUTCDATETIME())) GROUP BY CONVERT(date, created_at) ORDER BY day ASC`,
      pool.query`SELECT CONVERT(date, created_at) AS day, COUNT_BIG(*) AS count_value FROM dbo.trips WHERE created_at >= DATEADD(day, -29, CONVERT(date, SYSUTCDATETIME())) GROUP BY CONVERT(date, created_at) ORDER BY day ASC`,
    ]);

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
      windowDays: 30,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unable to load analytics.' });
  }
});

app.get('/api/admin/integrations', requireAdminAuth, async (req, res) => {
  try {
    const pool = await getPool();
    await pool.query`SELECT 1 AS connected`;
    return sendJson(res, 200, {
      database: {
        connected: true,
        name: config.database,
        authMode: useWindowsAuthentication ? 'windows' : 'sql-user',
      },
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
    const [users, trips] = await Promise.all([
      pool.query`SELECT TOP 8 user_id, created_at FROM dbo.users ORDER BY created_at DESC, user_id DESC`,
      pool.query`SELECT TOP 8 trip_id, created_at FROM dbo.trips ORDER BY created_at DESC, trip_id DESC`,
    ]);

    return sendJson(res, 200, {
      recentUsers: (users.recordset || []).map((user) => ({
        label: 'User account registered',
        timestamp: user.created_at,
      })),
      recentTrips: (trips.recordset || []).map((trip) => ({
        label: 'Trip record saved',
        timestamp: trip.created_at,
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
      maintenanceMode: Boolean(process.env.MAINTENANCE_MODE === 'true'),
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
    let emailCheck;
    try {
      emailCheck = await validateRegistrationEmail(email);
    } catch (error) {
      console.error('Registration email validation failed:', error.message);
      return sendJson(res, 503, { error: 'We could not check this email address right now. Please try again shortly.' });
    }
    if (emailCheck.status === 'invalid') {
      const error = emailCheck.subStatus === 'mailbox_not_found'
        ? 'This email address does not exist. Check it and try again.'
        : 'This email address appears unable to receive email. Check it and try another address.';
      return sendJson(res, 422, { error });
    }
    if (['spamtrap', 'abuse', 'do_not_mail'].includes(emailCheck.status)) {
      return sendJson(res, 422, { error: 'This email address cannot be used for registration. Please use another address.' });
    }

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
    return sendJson(res, 201, { user, verified: true, session: createAppSession(user) });
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
    return sendJson(res, 200, { verified: true, user, session: createAppSession(user) });
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

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return sendJson(res, 400, { error: 'Email and password are required.' });
  }

  try {
    const pool = await getPool();
    const result = await pool.query`SELECT * FROM dbo.users WHERE email = ${normalizedEmail}`;

    if (!result.recordset.length) {
      return sendJson(res, 404, { error: 'User not found.' });
    }

    const user = result.recordset[0];
    if (!user.is_verified) {
      return sendJson(res, 403, { error: 'Please verify your email before logging in.' });
    }
    const valid = await bcrypt.compare(String(password), user.password_hash);

    if (!valid) {
      return sendJson(res, 401, { error: 'Invalid password.' });
    }

    if (await hasUserLastActiveColumn(pool)) {
      await new sql.Request()
        .input('userId', sql.Int, user.user_id)
        .query('UPDATE dbo.users SET last_active_at = SYSUTCDATETIME() WHERE user_id = @userId');
    }

    return sendJson(res, 200, {
      user: {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
      },
      session: createAppSession(user),
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

app.post('/api/app-session/logout', requireAppAuth, (req, res) => {
  const token = getAppTokenFromRequest(req);
  if (token) appSessions.delete(token);
  const hasLiveSession = [...appSessions.values()].some((session) => (
    session.userId === req.appUser.userId && session.expiresAt > Date.now()
  ));
  if (!hasLiveSession) appPresence.delete(req.appUser.userId);
  return sendJson(res, 200, { ok: true });
});

async function persistItineraryForUser(userId, itinerary, meta = {}, existingTripId = null) {
  const destination = String(meta.destination || '').trim().slice(0, 200);
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
        .input('title', sql.NVarChar(200), `${destination} itinerary`.slice(0, 200))
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
        .input('title', sql.NVarChar(200), `${destination} itinerary`.slice(0, 200))
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

app.get('/api/preferences/:email', async (req, res) => {
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

app.put('/api/preferences/:email', async (req, res) => {
  const email = normalizeEmail(req.params.email);
  const { travelTypes = [], interests = [], preferredPlaces = [] } = req.body || {};

  try {
    const pool = await getPool();
    const userResult = await pool.query`SELECT user_id FROM dbo.users WHERE email = ${email}`;
    if (!userResult.recordset.length) {
      return sendJson(res, 404, { error: 'User not found.' });
    }

    const userId = userResult.recordset[0].user_id;

    await pool.query`DELETE FROM dbo.user_travel_styles WHERE user_id = ${userId}`;
    await pool.query`DELETE FROM dbo.user_interests WHERE user_id = ${userId}`;
    await pool.query`DELETE FROM dbo.user_preferred_places WHERE user_id = ${userId}`;

    for (const styleName of travelTypes) {
      const result = await pool.query`SELECT style_id FROM dbo.travel_styles WHERE style_name = ${String(styleName)}`;
      const styleId = result.recordset[0]?.style_id;
      if (styleId) {
        await pool.query`INSERT INTO dbo.user_travel_styles (user_id, style_id) VALUES (${userId}, ${styleId})`;
      }
    }

    for (const interestName of interests) {
      const result = await pool.query`SELECT interest_id FROM dbo.interests WHERE interest_name = ${String(interestName)}`;
      const interestId = result.recordset[0]?.interest_id;
      if (interestId) {
        await pool.query`INSERT INTO dbo.user_interests (user_id, interest_id) VALUES (${userId}, ${interestId})`;
      }
    }

    for (const placeName of preferredPlaces) {
      const result = await pool.query`SELECT place_id FROM dbo.preferred_places WHERE place_name = ${String(placeName)}`;
      const placeId = result.recordset[0]?.place_id;
      if (placeId) {
        await pool.query`INSERT INTO dbo.user_preferred_places (user_id, place_id) VALUES (${userId}, ${placeId})`;
      }
    }

    return sendJson(res, 200, {
      travelTypes,
      interests,
      preferredPlaces,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

app.get('/api/trips/:email', async (req, res) => {
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

app.post('/api/trips/:email', async (req, res) => {
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

app.get('/api/reminders/:email', async (req, res) => {
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

app.post('/api/reminders/:email', async (req, res) => {
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

app.post('/api/maps/places', async (req, res) => {
  const { queries = [], seeds = [] } = req.body || {};
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
          jobs.push(callGooglePlacesApi('places:searchText', {
            textQuery: `${query} in Philippines`,
            locationBias: { circle: { center: { latitude: Number(seed.lat), longitude: Number(seed.lng) }, radius: 50000 } },
            maxResultCount: 8,
          }));
        }
      } else {
        jobs.push(callGooglePlacesApi('places:searchText', { textQuery: `${query} in Philippines`, maxResultCount: 8 }));
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

app.post('/api/maps/place-suggestions', async (req, res) => {
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
        includedPrimaryTypes: ['tourist_attraction', 'landmark', 'national_park', 'museum', 'park'],
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
    const touristTypeOrder = ['tourist_attraction', 'landmark', 'national_park', 'museum', 'park'];
    const suggestions = (data.suggestions || []).map((item, index) => {
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
    }).filter(Boolean).sort((a, b) => a.touristRank - b.touristRank || a.originalRank - b.originalRank)
      .slice(0, 5).map(({ touristRank, originalRank, ...suggestion }) => suggestion);
    return sendJson(res, 200, { suggestions });
  } catch (error) {
    return sendJson(res, 503, { error: error.message || 'Google place suggestions are unavailable.' });
  }
});

app.post('/api/maps/place-details', async (req, res) => {
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

app.post('/api/maps/route', async (req, res) => {
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

app.post('/api/chat', requireAppAuth, async (req, res) => {
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

app.post('/api/itinerary/generate', requireAppAuth, async (req, res) => {
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

app.post('/api/itinerary/estimate-budget', async (req, res) => {
  const { email, itinerary, destination, startDate, endDate } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return sendJson(res, 401, { error: 'Authentication is required to estimate a trip budget.' });
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

setInterval(cleanUnverifiedUsers, 60 * 60 * 1000).unref();
setInterval(() => {
  void cleanExpiredItineraries().catch(() => {});
}, 5 * 60 * 1000).unref();

app.listen(port, () => {
  console.log(`Sidekick backend listening on http://localhost:${port}`);
});
