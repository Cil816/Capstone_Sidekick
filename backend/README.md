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
SIDEKICK_API_MODE=production
ADMIN_USERNAME=<choose-a-unique-admin-name>
ADMIN_PASSWORD=<choose-a-long-unique-random-password>
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASSWORD=your_smtp_password
SMTP_FROM=no-reply@example.com
AI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
GOOGLE_MAPS_API_KEY=your_google_maps_key
MAINTENANCE_MODE=false
```

Admin login is disabled until `ADMIN_USERNAME` and `ADMIN_PASSWORD` are explicitly set to unique values in the private backend `.env` file. Do not deploy placeholder values. The backend accepts only random eight-hour sessions issued at login; these sessions are revoked by logout and held in process memory. The admin UI keeps a session token in `sessionStorage` for the active browser tab.

For a new database, run `schema.sql` once against `sidekick_db` before starting the backend. For an existing database that is missing only the app-rating table, run `migrations/001_create_app_reviews.sql` in SSMS instead; it creates only `dbo.app_reviews` if absent and makes no changes to existing rows. The SMTP settings are required for registration verification emails.

App sign-in and verified registration issue a revocable 30-day in-memory app session for app reviews and online-presence heartbeats. The app reports online while a signed-in page is visible and focused; presence expires after 90 seconds without a heartbeat and is reset whenever the backend restarts. App-review reads and writes require that session and are scoped to the signed-in account. The regular account-enabled flag in `dbo.users.is_active` is separate from online presence.

Admin authentication audit storage is optional and is not created at startup. Run `../database/admin/03_admin_auth_audit_log.sql` manually in SSMS to record successful logins, logout, and invalid-credential attempts; rate-limited attempts, read-only page/API views, and administrator data changes are not recorded. The script uses a separate table name from the older optional admin action-log script. Registration and SQL trip-record activity is derived from `created_at`. The frontend also stores itinerary state in browser `localStorage`; those client-local itineraries are not included in admin SQL counts or listings. AI usage, route calculations, and itinerary generation method are not recorded by the current schema.

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
- POST /api/app-presence/heartbeat (app session required)
- POST /api/app-session/logout (app session required)
- POST /api/app-itineraries (app session required; records a generated or legacy local itinerary)
- POST /api/app-itineraries/sync (app session required; reconciles an older local itinerary with its existing account-owned trip)
- GET /api/app-itineraries/retention (app session required; returns the retention cutoff and optionally checks a trip ID)
- PUT /api/app-itineraries/:tripId (app session required; updates the signed-in user's existing itinerary)
- DELETE /api/app-itineraries/:tripId (app session required; deletes the signed-in user's itinerary)
- POST /api/itinerary/generate (app session required; persists the generated itinerary before returning it)
- POST /api/chat (app session required; itinerary responses are persisted before returning them)
- GET /api/app-reviews/me (app session required)
- POST /api/app-reviews/me (app session required)
- GET /api/app-reviews/status/:email
- POST /api/app-reviews
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
- POST /api/admin/login
- GET /api/admin/session
- GET /api/admin/summary
- GET /api/admin/users
- GET /api/admin/app-reviews
- GET /api/admin/itineraries
- GET /api/admin/analytics
- GET /api/admin/integrations
- GET /api/admin/activity
- GET /api/admin/audit
- GET /api/admin/settings
- GET /api/admin/users/:userId
- DELETE /api/admin/users/:userId — permanently deletes any account after the administrator confirms its email. The 180-day inactivity period is informational only.
- GET /api/admin/itineraries/:tripId

## Notes

Persistent user last-active tracking and inactive-account deletion require
`backend/migrations/002_user_last_active.sql` to be run manually in SSMS for activity timestamps and the 180-day reference. Account deletion does not depend on this migration. Existing
accounts start their tracking timestamp at migration time because historical
activity was not recorded. App heartbeat requests update this timestamp. The
delete operation removes known user-owned reminders, itinerary activities, trip
days, trips, preference links, reviews, OTP records, and the user in one
transaction. If another database relationship prevents deletion, the transaction
rolls back rather than partially deleting the account. Do not run the SQL script
automatically from the backend.

The admin Travel plans view lists generated SQL-backed itineraries and their
account owners. Every itinerary returned from authenticated chat or itinerary
generation is persisted immediately, before the API reports successful
generation. Chat drafts remain in the app's working copy so the user can choose
whether to keep them in My Itinerary, but discarding a draft does not remove its
admin monitoring record. Existing local-only itineraries are synced when opened
in the itinerary screen. Persistence uses the existing trips, trip_days, and
itinerary_activities tables; no new table is required. Plans with a non-null
`end_date` are automatically deleted, with their linked days, activities, and
available reminder rows, once the end date has passed by 24 hours. Cleanup runs
at backend startup and every five minutes; opening the admin itinerary list or
details also triggers cleanup. The mobile app checks its saved trip ID when
active and removes expired plans and their itinerary reminders from local
storage, including dated local-only plans. New records without an explicit end
date derive one from their start date and itinerary duration. For older records
with a null end date, the latest dated trip day is used when one exists; records
with neither an end date nor a dated trip day are retained because no expiration
date can be determined.

This is designed to replace the app's current localStorage-only storage with a proper relational database.

`POST /api/itinerary/generate` uses a two-stage Gemini flow: the preliminary plan is
resolved through Google Places and Google Routes, then Gemini formats the final
itinerary from only the verified locations and route data. Configure
`GOOGLE_MAPS_API_KEY` and `GEMINI_MODEL` before using it. If verification fails,
the endpoint returns an error instead of returning invented locations or travel times.
