import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sql from 'mssql';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const configuredServer = process.env.DB_SERVER || 'localhost\\SQLEXPRESS';
const [serverName, configuredInstance] = configuredServer.split('\\', 2);
const useWindowsAuthentication = (process.env.DB_AUTH || 'windows').toLowerCase() === 'windows';
const rateLimits = new Map();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const config = {
  ...(useWindowsAuthentication ? { driver: 'msnodesqlv8' } : {}),
  ...(useWindowsAuthentication
    ? {
        connectionString: 'Driver={ODBC Driver 18 for SQL Server};Server=localhost,1433;Database=sidekick_db;Trusted_Connection=Yes;TrustServerCertificate=Yes;',
      }
    : {}),
  server: serverName || 'localhost',
  database: process.env.DB_DATABASE || 'sidekick_db',
  ...(useWindowsAuthentication
    ? { options: { trustedConnection: true } }
    : {
        user: process.env.DB_USERNAME || 'sa',
        password: process.env.DB_PASSWORD || '',
      }),
  ...(!(process.env.DB_INSTANCE || configuredInstance)
    ? { port: Number(process.env.DB_PORT || 1433) }
    : {}),
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    ...(useWindowsAuthentication ? { trustedConnection: true } : {}),
    ...(process.env.DB_INSTANCE || configuredInstance
      ? { instanceName: process.env.DB_INSTANCE || configuredInstance }
      : {}),
  },
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAiApiKey() {
  return String(process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
}

function getMapsApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
}

function mapPlace(place) {
  const location = place.location || place.geometry?.location;
  return {
    placeId: place.id || place.place_id || place.placeId || null,
    name: place.displayName?.text || place.name || 'Unnamed place',
    address: place.formattedAddress || place.formatted_address || place.vicinity || '',
    lat: location?.latitude ?? location?.lat ?? place.lat ?? null,
    lng: location?.longitude ?? location?.lng ?? place.lng ?? null,
    rating: place.rating ?? null,
    types: Array.isArray(place.types) ? place.types.slice(0, 6) : [],
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
  const response = await fetch(`https://places.googleapis.com/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error('Google Maps is currently unavailable.');
  }
  return data;
}

async function callGoogleRoutesApi(payload) {
  const apiKey = getMapsApiKey();
  if (!apiKey) throw new Error('Google Maps is not configured on the backend. Add GOOGLE_MAPS_API_KEY to backend/.env.');
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.legs.startLocation,routes.legs.endLocation,routes.legs.distanceMeters,routes.legs.duration,routes.legs.localizedValues',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Google Maps is currently unavailable.');
  return data;
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

async function callGeminiApi({ message, contextText, systemInstruction, responseMimeType = 'text/plain' }) {
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
      temperature: 0.6,
      maxOutputTokens: 1200,
      responseMimeType,
    },
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    throw new Error('AI authentication failed. Check the API key in backend/.env.');
  }

  if (response.status === 429) {
    throw new Error('The AI service is rate limited. Please try again in a moment.');
  }

  if (!response.ok) {
    throw new Error('The AI service is currently unavailable. Please try again later.');
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';

  if (!rawText) {
    throw new Error('AI returned an empty response.');
  }

  return rawText.trim();
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
      properties: { name: { type: 'STRING' }, location: { type: 'STRING' }, dayNumber: { type: 'INTEGER' }, note: { type: 'STRING' } },
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
    const result = await pool.query`DELETE FROM dbo.trips WHERE trip_id = ${Number(args.trip_id)} AND user_id = ${user.user_id}`;
    if (!result.rowsAffected[0]) throw new Error('Trip was not found for the authenticated user.');
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
        activity: { title: String(args.name), location: String(args.location), dayNumber: Math.max(1, Number(args.dayNumber) || 1), note: String(args.note || 'Added by Sidekick AI.') },
      },
    };
  }
  throw new Error(`Unsupported Sidekick tool: ${name}`);
}

async function generateAgentReply({ email, message, selectedDestination, history, profile }) {
  const currentProfile = await getUserProfileContext(email);
  const lowerMessage = String(message || '').toLowerCase();
  const currentUser = await executeSidekickTool('getCurrentUser', {}, email);

  if (/\b(name|email)\b/.test(lowerMessage) && /\b(my|i)\b/.test(lowerMessage)) {
    return { reply: `Your name is ${currentUser.name} and your email is ${currentUser.email}.`, meta: { source: 'sidekick-direct' } };
  }

  if (/\b(saved|current|my)\b.*\b(preferences?|travel style|interests?)\b/.test(lowerMessage)) {
    const styles = currentProfile.travelTypes?.join(', ') || 'none saved';
    const interests = currentProfile.interests?.join(', ') || 'none saved';
    const places = currentProfile.preferredPlaces?.join(', ') || 'none saved';
    return { reply: `Your travel styles are ${styles}. Your interests are ${interests}. Your preferred places are ${places}.`, meta: { source: 'sidekick-direct' } };
  }

  const contextText = [
    'You are Sidekick AI, the authenticated user\'s travel app agent.',
    `Current screen context: ${selectedDestination?.name || 'not selected'}`,
    `Current preferences: ${JSON.stringify(currentProfile)}`,
    `Conversation history: ${(history || []).slice(-3).map((item) => `${item.role}: ${String(item.content || '').slice(0, 500)}`).join(' | ') || 'none'}`,
  ].join('\n');
  const systemInstruction = 'Use Sidekick tools for current user data and mutations. Never claim a mutation succeeded unless its tool succeeds. Ask for confirmation before destructive deletion. Do not reveal credentials or internal tool details. For ordinary questions, answer directly and concisely.';
  const contents = [{ role: 'user', parts: [{ text: `${contextText}\n\nUser request:\n${message}` }] }];
  const uiActions = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const apiKey = getAiApiKey();
    if (!apiKey) throw new Error('AI_API_KEY is missing. Add your Gemini API key in backend/.env.');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemInstruction }] }, tools: [{ functionDeclarations: sidekickToolDeclarations }], generationConfig: { temperature: 0.5, maxOutputTokens: 900, responseMimeType: 'text/plain' } }),
    });
    if (!response.ok) throw new Error('The AI service is currently unavailable. Please try again later.');
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const calls = parts.filter((part) => part.functionCall?.name);
    if (!calls.length) {
      const reply = parts.map((part) => part.text || '').join('').trim();
      if (!reply) throw new Error('AI returned an empty response.');
      return { reply: sanitizePlanText(reply), actions: uiActions, meta: { source: 'gemini-agent', model: 'gemini-3.6-flash' } };
    }
    contents.push(candidate.content);
    const functionResponses = [];
    for (const part of calls) {
      let result;
      try { result = await executeSidekickTool(part.functionCall.name, part.functionCall.args || {}, email); } catch (error) { result = { error: error.message }; }
      if (result?.uiAction) uiActions.push(result.uiAction);
      functionResponses.push({ functionResponse: { name: part.functionCall.name, response: result } });
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

  const systemInstruction = `You are Sidekick AI, a helpful Philippine travel planner. Answer in concise, natural language. If the user asks to generate an itinerary, propose a realistic plan and say that the app can create it. Keep the answer practical, friendly, and specific to Philippine destinations, food, beaches, attractions, and transportation. Do not reveal API keys or internal implementation details.`;

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

  const generated = await generateItineraryFromAi({ email, message, selectedDestination, profile: userProfile });
  return {
    reply: `${sanitizePlanText(reply)}\n\nI built a structured itinerary for ${generated.meta.destination || destinationName || 'your trip'}. Open the Itinerary tab to review it.`,
    itinerary: generated.itinerary,
    meta: generated.meta,
  };
}

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

async function getPool() {
  await sql.connect(config);
  return sql;
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

app.get('/health', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.query('SELECT 1 AS ok');
    return sendJson(res, 200, { ok: true, database: 'SQL Server connected' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { name, email, password, termsAccepted } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (isRateLimited(`register:${req.ip}`, 5, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Too many registration attempts. Please try again later.' });
  }

  if (!name || !normalizedEmail || !password) {
    return sendJson(res, 400, { error: 'Name, email and password are required.' });
  }

  if (!emailPattern.test(normalizedEmail)) {
    return sendJson(res, 400, { error: 'Please enter a valid email address.' });
  }

  if (termsAccepted !== true) {
    return sendJson(res, 400, { error: 'You must agree to the Terms and Conditions to register.' });
  }

  if (String(password).length < 8) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
  }

  try {
    const pool = await getPool();
    const passwordHash = await bcrypt.hash(String(password), 10);

    const existing = await pool.query`SELECT user_id, is_verified FROM dbo.users WHERE email = ${normalizedEmail}`;
    if (existing.recordset.length > 0) {
      return sendJson(res, 409, {
        error: existing.recordset[0].is_verified
          ? 'User already exists.'
          : 'A verification is already pending for this email.',
      });
    }

    const result = await pool.query`
      INSERT INTO dbo.users (name, email, password_hash, is_verified, terms_accepted, terms_accepted_at)
      OUTPUT INSERTED.user_id
      VALUES (${String(name).trim()}, ${normalizedEmail}, ${passwordHash}, 0, 1, SYSUTCDATETIME())
    `;
    const userId = result.recordset?.[0]?.user_id;
    const otp = createOtp();

    await pool.query`
      INSERT INTO dbo.otp_verifications (user_id, otp_code_hash, expires_at)
      VALUES (${userId}, ${hashOtp(otp)}, DATEADD(minute, 10, SYSUTCDATETIME()))
    `;
    await sendOtpEmail(normalizedEmail, otp);

    return sendJson(res, 201, {
      user_id: userId ?? null,
      email: normalizedEmail,
      verification_required: true,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
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
    return sendJson(res, 200, { verified: true, user: userResult.recordset[0] });
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
    await sendOtpEmail(email, otp);
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

    return sendJson(res, 200, {
      user: {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
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

app.post('/api/chat', async (req, res) => {
  const { email, message = '', selectedDestination, history = [], profile = {} } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const userMessage = String(message || '').trim();

  if (!userMessage) {
    return sendJson(res, 400, { error: 'Please enter a message for the assistant.' });
  }

  try {
    const userProfile = {
      ...profile,
      travelTypes: Array.isArray(profile.travelTypes) ? profile.travelTypes : [],
      interests: Array.isArray(profile.interests) ? profile.interests : [],
      preferredPlaces: Array.isArray(profile.preferredPlaces) ? profile.preferredPlaces : [],
      budget: profile.budget || 'Mid-Range',
    };

    const response = await generateAgentReply({
      email: normalizedEmail,
      message: userMessage,
      selectedDestination,
      history,
      profile: userProfile,
    });

    return sendJson(res, 200, response);
  } catch (error) {
    console.error('Chat error:', error.message);
    return sendJson(res, 500, {
      reply: 'Sorry, I hit a temporary issue while planning. Please try again in a moment.',
      meta: { error: error.message || 'AI unavailable' },
    });
  }
});

app.post('/api/itinerary/generate', async (req, res) => {
  const { email, message = '', selectedDestination, profile = {} } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const userMessage = String(message || '').trim();

  if (!userMessage) {
    return sendJson(res, 400, { error: 'Please describe the itinerary you want to generate.' });
  }

  try {
    const userProfile = {
      ...profile,
      travelTypes: Array.isArray(profile.travelTypes) ? profile.travelTypes : [],
      interests: Array.isArray(profile.interests) ? profile.interests : [],
      preferredPlaces: Array.isArray(profile.preferredPlaces) ? profile.preferredPlaces : [],
      budget: profile.budget || 'Mid-Range',
    };

    const generated = await generateItineraryFromAi({
      email: normalizedEmail,
      message: userMessage,
      selectedDestination,
      profile: userProfile,
    });

    return sendJson(res, 200, {
      ok: true,
      itinerary: generated.itinerary,
      meta: generated.meta,
    });
  } catch (error) {
    console.error('Itinerary generation error:', error.message);
    return sendJson(res, 200, {
      ok: true,
      itinerary: createItineraryFallback(profile || { preferredPlaces: [] }, { dayCount: 3 }).itinerary,
      meta: {
        destination: selectedDestination?.name || selectedDestination?.destination || 'Philippines',
        source: 'backend-fallback',
        generatedAt: new Date().toISOString(),
      },
      fallback: true,
    });
  }
});

setInterval(cleanUnverifiedUsers, 60 * 60 * 1000).unref();

app.listen(port, () => {
  console.log(`Sidekick backend listening on http://localhost:${port}`);
});
