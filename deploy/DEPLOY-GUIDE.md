# Deploying Sidekick on AWS (EC2 + Auto Scaling + placement group)

This guide puts the Sidekick backend and admin website on AWS, and builds the Android
APK that talks to it. Follow the parts in order. Each step says **what** to do and
**why**, in plain words.

**What you'll end up with**

```
Phone app (APK) ─┐
                 ├─ https://sidekick.yourdomain.com ─► Load balancer ─► 2+ EC2 servers ─► RDS SQL Server
Admin website ───┘        (HTTPS certificate)          (Auto Scaling,     (Node.js backend,
                                                         Spread group)     also serves admin) 
```

- The admin website is at `https://sidekick.yourdomain.com/` with clean addresses
  (`/dashboard`, `/users`, `/reports`, ...). The phone app's screens are not served
  online; they ship only inside the APK. (Old `/admin/...` links redirect.)
- The phone app calls the API at `https://sidekick.yourdomain.com/api/...`.
- No nginx, no SSH, no PuTTY. Servers set themselves up from a startup script.

**Before you start, you need**

- An AWS account.
- A domain name you own (about $10/year from Route 53, Namecheap, etc.).
  HTTPS needs a domain, and the app and admin site refuse to use an API without HTTPS.
- SSMS (SQL Server Management Studio) on your PC, which you already use.

**Cost warning:** the load balancer and two servers are not free (roughly $30–50 a month
at small sizes). For a capstone demo, set it up, demo it, and then delete it (Part G).

---

## Part A — Prepare on your PC (15 minutes)

**A1. Run migration 004 on your local database.**
Open `backend/migrations/004_shared_sessions.sql` in SSMS and run it.
*Why:* logins are then stored in the database, the same as they will be on AWS, so you
can test the exact production behaviour locally. (The app also works without it.)

**A2. Restart your local backend and check that sign-in still works.**
Sign in on the app and on the admin site at `http://localhost:3001/admin/`.
*Why:* this confirms the new session storage works before you deploy.

**A3. Build the upload package.**
In PowerShell, from the project folder:
```
powershell -ExecutionPolicy Bypass -File deploy\package.ps1
```
This creates `deploy\sidekick.zip`.
*Why:* it bundles the backend, admin site, and app files, and leaves out secrets
(`backend\.env`), local settings, and `node_modules`. It refuses to build if a secret slips in.

**A4. Choose a long admin password (at least 12 characters).**
*Why:* on the public server, admin sign-in refuses to work with a short password.
Your current one is 5 characters.

---

## Part B — Database on Amazon RDS (30 minutes)

Pick one AWS **region** for everything, close to your users (for example
**Asia Pacific (Singapore) ap-southeast-1**). Use it in every step.

**B1. Create the security groups first** (EC2 → Security Groups → Create). They act
as firewalls. Create three, in the default VPC:

| Name | Inbound rule | Why |
|---|---|---|
| `sidekick-alb-sg` | HTTP 80 and HTTPS 443 from `0.0.0.0/0` | The public can reach the load balancer |
| `sidekick-app-sg` | Custom TCP **3001** from source `sidekick-alb-sg` | Only the load balancer can reach the servers |
| `sidekick-db-sg` | MS SQL **1433** from source `sidekick-app-sg`, and from **My IP** (temporary) | Only the servers (and you, for setup) can reach the database |

**B2. Create the database** (RDS → Create database).
- Engine: **Microsoft SQL Server**, edition **Express**.
- Template: **Free tier** (if offered), instance `db.t3.micro`.
- Master username: e.g. `sidekickadmin`, with a strong password. Write it down.
- Public access: **Yes** for now (so SSMS on your PC can connect); security group:
  `sidekick-db-sg`.
- Wait until the status is **Available**, then copy the **Endpoint** (looks like
  `xxxx.ap-southeast-1.rds.amazonaws.com`).

**B3. Copy your database to RDS.**
1. In SSMS, connect to your **local** server. Right-click `sidekick_db` → **Tasks** →
   **Generate Scripts** → *Script entire database* → **Advanced** → set
   *Types of data to script* = **Schema and data**, and *Script for Server Version* =
   the version RDS shows for your database (for example *SQL Server 2022*) → save to a file.
2. In SSMS, connect to the **RDS endpoint** (SQL Server Authentication, master user).
3. Run `CREATE DATABASE sidekick_db;` then open the generated file, make sure the
   database dropdown says `sidekick_db`, and run it. If the file contains
   `CREATE DATABASE` or `USE [sidekick_db]` lines at the top that fail, remove them and
   run the rest with `sidekick_db` selected.
4. Check that these tables now exist on RDS: `app_sessions`, `admin_api_sessions`,
   `app_usage_events`, `app_reviews`. If `app_sessions` is missing (you skipped step A1),
   run `backend/migrations/004_shared_sessions.sql` against RDS now.

*Why:* your tables were created by hand, so copying the whole database (structure and
data) is the most reliable way. The session tables are essential: without them each
server keeps its own logins and users get signed out at random.

**B4. Create the app's own limited login.**
Open `backend/migrations/005_app_login_least_privilege.sql`, replace
`CHANGE_ME_to_a_long_random_password` with a long random password (20+ characters),
and run it against RDS as the master user.
*Why:* the app then connects with an account that can only read and write data. If
the app were ever compromised, the attacker couldn't drop tables or take over the database.

**B5. After setup, remove "My IP" from `sidekick-db-sg`.**
*Why:* then only your servers can reach the database.

---

## Part C — Settings and code in AWS (15 minutes)

**C1. Store the settings in Parameter Store** (Systems Manager → Parameter Store →
Create parameter). Create one parameter per line below. Use type **SecureString** for
passwords and keys, **String** for the rest. Values must not contain a `'` character.

| Name | Value |
|---|---|
| `/sidekick/prod/PUBLIC_ORIGIN` | `https://sidekick.yourdomain.com` |
| `/sidekick/prod/CORS_ALLOWED_ORIGINS` | `https://sidekick.yourdomain.com,https://localhost,capacitor://localhost` |
| `/sidekick/prod/FORCE_HTTPS` | `1` |
| `/sidekick/prod/TRUST_PROXY` | `1` |
| `/sidekick/prod/PORT` | `3001` |
| `/sidekick/prod/SIDEKICK_API_MODE` | `production` |
| `/sidekick/prod/DB_SERVER` | your RDS endpoint |
| `/sidekick/prod/DB_PORT` | `1433` |
| `/sidekick/prod/DB_DATABASE` | `sidekick_db` |
| `/sidekick/prod/DB_AUTH` | `sql` |
| `/sidekick/prod/DB_USERNAME` | `sidekick_app` |
| `/sidekick/prod/DB_PASSWORD` | the password from step B4 (SecureString) |
| `/sidekick/prod/DB_ENCRYPT` | `true` |
| `/sidekick/prod/ADMIN_USERNAME` | your admin username |
| `/sidekick/prod/ADMIN_PASSWORD` | your 12+ character admin password (SecureString) |
| `/sidekick/prod/MAINTENANCE_MODE` | `false` |
| Every other line of your `backend/.env` | the same value (e.g. `AI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_MAPS_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `REOON_API_KEY`) |

*Why:* secrets live only in AWS (encrypted), never in the code, the zip, or the app.
`https://localhost` and `capacitor://localhost` are how the Android and iOS apps
identify themselves; listing them lets the phone app call the API while other
websites can't.

**C2. Upload the code.** S3 → Create bucket (e.g. `sidekick-deploy-yourname`, keep
"Block all public access" **on**) → upload `deploy\sidekick.zip` as `sidekick.zip`.

**C3. Give the servers permission to read those** (IAM → Roles → Create role).
- Trusted entity: **AWS service → EC2**.
- Attach policy **AmazonSSMManagedInstanceCore** (lets you open a browser terminal later).
- Then **Add permissions → Create inline policy → JSON**, paste and adjust the bucket name,
  region, and your account ID:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::sidekick-deploy-yourname/sidekick.zip" },
    { "Effect": "Allow", "Action": "ssm:GetParametersByPath", "Resource": "arn:aws:ssm:ap-southeast-1:YOUR_ACCOUNT_ID:parameter/sidekick/prod" },
    { "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*" }
  ]
}
```
- Name the role `sidekick-ec2-role`.

*Why:* each server can download only this zip and read only these settings, nothing else.

---

## Part D — Servers, placement group, and Auto Scaling (30 minutes)

**D1. Create the placement group** (EC2 → Placement groups → Create).
Name `sidekick-spread`, strategy **Spread**, spread level **Rack**.
*Why:* Spread puts each server on different hardware, so one hardware failure can't
take down all of them, and it works across Availability Zones. (A *Cluster* group
would pack servers into one zone, which removes that protection.)

**D2. Create the launch template** (EC2 → Launch templates → Create).
- Name `sidekick-template`.
- AMI: **Amazon Linux 2023**. Instance type: `t3.small` (or `t3.micro` to save cost).
- Key pair: **Don't include** (you won't need SSH).
- Security group: `sidekick-app-sg`.
- **Advanced details:**
  - IAM instance profile: `sidekick-ec2-role`.
  - Placement group: `sidekick-spread`.
  - User data: open `deploy/user-data.sh`, change the three values at the top
    (`REGION`, `BUCKET`, and keep `PARAM_PATH`), and paste the whole file.

*Why:* the template is the recipe every new server follows. The user-data script
installs Node.js, downloads your zip, builds the settings file from Parameter Store,
and starts the backend as a service that restarts itself if it stops.

**D3. Create the target group** (EC2 → Target groups → Create).
- Type **Instances**, protocol **HTTP**, port **3001**, default VPC.
- Health check path: `/health`.
- Don't register instances yourself (Auto Scaling will).

*Why:* the load balancer sends visitors to healthy servers in this group, and checks
each server's `/health` page (which also confirms the database connection).

**D4. Get an HTTPS certificate** (Certificate Manager → Request → public certificate)
for `sidekick.yourdomain.com`, validation **DNS**. Click **Create records in Route 53**
(or add the shown CNAME at your domain registrar). Wait until it says **Issued**.

**D5. Create the load balancer** (EC2 → Load balancers → Create → **Application**).
- Internet-facing, IPv4, default VPC, select **at least two** subnets (different zones).
- Security group: `sidekick-alb-sg`.
- Listener **HTTPS 443** → forward to the target group, certificate from D4.
- Add listener **HTTP 80** → action **Redirect to HTTPS 443**.
- After it's created: **Attributes → Edit → Idle timeout = 300 seconds.**

*Why:* the load balancer is the one public front door, handles HTTPS, and spreads
traffic. The longer idle timeout matters because AI itinerary generation can take more
than the default 60 seconds.

**D6. Create the Auto Scaling group** (EC2 → Auto Scaling groups → Create).
- Launch template `sidekick-template`.
- Network: the **same two (or more) subnets** as the load balancer.
- Attach to the existing load balancer → choose your target group.
- Turn on **Elastic Load Balancing health checks**, grace period **300** seconds.
- Group size: desired **2**, minimum **2**, maximum **4**.
- Scaling policy: **Target tracking**, metric *Average CPU utilization*, target **60**.

*Why:* two servers always run (in different zones and racks). If one fails, it's
replaced automatically, and more are added when traffic grows.

**D7. Point your domain at the load balancer.**
Route 53 → your domain → Create record `sidekick` → **Alias** → Application Load
Balancer → your region → your load balancer. (At another registrar: a CNAME record to
the load balancer's DNS name.)

---

## Part E — Check that it works (10 minutes)

1. Wait about 5 minutes for the servers to set up. In **Target groups → Targets**, both
   should become **healthy**.
2. Open `https://sidekick.yourdomain.com/health` → `{"ok":true,...}`.
3. Open `https://sidekick.yourdomain.com/` → sign in → `/dashboard` loads.
4. Open `http://sidekick.yourdomain.com/` (plain http) → it switches to https.

**If something is wrong:** EC2 → select an instance → **Connect → Session Manager**
(a terminal in your browser), then:
```
sudo cat /var/log/sidekick-setup.log      # what the startup script did
sudo journalctl -u sidekick -n 100        # the backend's own log
```
Look for lines starting with `[security]`: they name any missing production setting.

---

## Part F — The Android APK

**F1. Point the app at your server.** In `mobile-app/js/config.local.js`:
```js
window.SIDEKICK_CONFIG = {
  apiMode: "production",
  apiBaseUrl: "https://sidekick.yourdomain.com",
  googleMapsApiKey: "YOUR_APP_MAPS_KEY",
};
```

**F2. Lock down both Google keys** (Google Cloud Console → APIs & Services → Credentials).

- **The app's key** (the one in `config.local.js`):
  - Application restriction: **Websites**, and add `https://localhost/*` and
    `https://sidekick.yourdomain.com/*`.
    (Use *Websites*, not *Android apps*: the map runs the Maps JavaScript API inside the
    app's web view, which identifies itself as `https://localhost`. An *Android apps*
    restriction only works for Google's native Android SDKs and would break the map.)
  - API restriction: only **Maps JavaScript API**.
- **The server's key** (`GOOGLE_MAPS_API_KEY` in Parameter Store):
  - API restriction: only **Places API (New)** and **Routes API**.
  - Application restriction: none (the servers' addresses change as Auto Scaling
    replaces them). This key never leaves the servers.

*Why:* a key inside an app can always be extracted; restrictions make a stolen key useless
for anything except showing your map on your own pages.

**F3. Build the APK.**
```
npx cap sync android
npx cap open android
```
In Android Studio: **Build → Generate Signed App Bundle / APK → APK → release**.
Create a keystore the first time and **back it up**; you need the same keystore for
every update, and raise `versionCode` in `android/app/build.gradle` each release.

**F4. Share the APK** (Google Drive or a link). On the phone, allow *Install unknown
apps* and open it. The release build only talks to the server over HTTPS.

---

## Part G — Updating and shutting down

**Update the server code:** run `deploy\package.ps1` again → upload the new
`sidekick.zip` to S3 (same name) → Auto Scaling group → **Instance refresh → Start**.
Servers are replaced one at a time; users stay signed in (sessions are in the database).

**Change a setting:** edit it in Parameter Store, then start an Instance refresh.

**Update the app:** rebuild the APK (F3) with a higher `versionCode` and share it again.

**Database changes:** run new migration scripts against RDS in SSMS as the master user.

**Delete everything after your demo** (to stop charges): Auto Scaling group → load
balancer → target group → launch template → RDS database → S3 bucket.

---

## What protects the live site (for your documentation)

| Protection | How |
|---|---|
| HTTPS only | Load balancer certificate; HTTP redirects to HTTPS; HSTS header; Android release blocks plain HTTP |
| Secrets off the frontend | All keys and passwords live in Parameter Store; the app and admin site hold only the public address |
| Protected admin routes | Every `/api/admin/*` route requires a signed-in admin; 8-hour sessions; 12+ character password required |
| Spam and abuse limits | Per-visitor limit on the whole API; per-route limits on sign-in, registration, password reset, AI, and maps |
| XSS | All user and Google data is escaped before display; strict Content-Security-Policy on the admin site; only https links are clickable |
| SQL injection | Every query uses parameters; dynamic parts are fixed text or allow-listed values |
| CSRF | Logins use request headers, not cookies, so other sites can't act as a signed-in user |
| CORS | Only your domain and the phone app may call the API from a browser |
| Security headers | nosniff, frame protection, referrer policy, permissions policy, no caching of API data |
| Errors | Production hides internal error details from users |
| Database | Limited app login (read/write only); encrypted connection; reachable only from the servers |
| Sessions | Stored hashed; sign-out and password reset end sessions on every server |
