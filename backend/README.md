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

## Notes

This is designed to replace the app's current localStorage-only storage with a proper relational database.
