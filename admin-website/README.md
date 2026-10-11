# Sidekick Admin Website

This frontend is separate from the Capacitor mobile app. It calls the existing
Sidekick backend; it does not connect directly to SQL Server and contains no
administrator credentials or backend secrets.

## Local development

Serve this directory with a static web server, for example VS Code Live Server
or `npx http-server admin-website -p 3301`, and run the backend on port 3001.
Create your ignored local config from the example:

```powershell
Copy-Item js/config.example.js js/config.js
```

The example points to `http://localhost:3001` for development.
Open `http://localhost:3301/` (or the URL printed by the selected static server)
to reach the login page.

## Production configuration

Before publishing the static site, prepare its deployment-specific `js/config.js`
with `apiMode: 'production'` and `apiBaseUrl` set to the backend's HTTPS origin,
for example `https://api.example.com`. Production configuration without an HTTPS
API URL is rejected by the admin client. Never commit this file or put
administrator credentials, backend secrets, or session tokens in it.

Production CORS allowlisting, the production API URL, HTTPS certificates, and
S3/CloudFront configuration must be reviewed and completed before deployment.
