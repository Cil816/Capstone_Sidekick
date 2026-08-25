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

setInterval(cleanUnverifiedUsers, 60 * 60 * 1000).unref();

app.listen(port, () => {
  console.log(`Sidekick backend listening on http://localhost:${port}`);
});
