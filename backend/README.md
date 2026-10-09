# Sidekick SQL Server backend

This backend connects the Sidekick app to SQL Server Express.

## Install dependencies

```bash
npm install
```

## Setup environment

Create a `.env` file based on `.env.example`.

Example:

```env
DB_SERVER=localhost\SQLEXPRESS
DB_DATABASE=sidekick_db
DB_USERNAME=sa
DB_PASSWORD=your_password_here
DB_PORT=1433
PORT=3001
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASSWORD=your_smtp_password
SMTP_FROM=no-reply@example.com
AI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.6-flash
GOOGLE_MAPS_API_KEY=your_google_maps_key
```

Run `schema.sql` once against `sidekick_db` before starting the backend. The SMTP settings are required for registration verification emails.

## Run locally

```bash
npm start
```

## Endpoints

- GET /health
- POST /api/register
- POST /api/verify-otp
- POST /api/resend-otp
- POST /api/login
- GET /api/preferences/:email
- PUT /api/preferences/:email
- GET /api/trips/:email
- POST /api/trips/:email
- GET /api/reminders/:email
- POST /api/reminders/:email
- POST /api/maps/places
- GET /api/maps/photo
- POST /api/chat
- POST /api/itinerary/generate

## Notes

This is designed to replace the app's current localStorage-only storage with a proper relational database.

`POST /api/itinerary/generate` uses a two-stage Gemini flow: the preliminary plan is
resolved through Google Places and Google Routes, then Gemini formats the final
itinerary from only the verified locations and route data. Configure
`GOOGLE_MAPS_API_KEY` and `GEMINI_MODEL` before using it. If verification fails,
the endpoint returns an error instead of returning invented locations or travel times.
