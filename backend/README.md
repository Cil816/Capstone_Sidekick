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
```

## Run locally

```bash
npm start
```

## Endpoints

- GET /health
- POST /api/register
- POST /api/login
- GET /api/preferences/:email
- PUT /api/preferences/:email
- GET /api/trips/:email
- POST /api/trips/:email
- GET /api/reminders/:email
- POST /api/reminders/:email

## Notes

This is designed to replace the app's current localStorage-only storage with a proper relational database.
