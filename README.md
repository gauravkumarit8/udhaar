# 💰 Udhaar — Track Loans & EMIs

> **Splitwise + EMI Tracker + Auto Reminder** for informal loans in India

[![CI](https://github.com/gauravkumarit8/udhaar/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravkumarit8/udhaar/actions/workflows/ci.yml)
[![Release](https://github.com/gauravkumarit8/udhaar/actions/workflows/release.yml/badge.svg)](https://github.com/gauravkumarit8/udhaar/actions/workflows/release.yml)
[![Android Build](https://github.com/gauravkumarit8/udhaar/actions/workflows/build-android.yml/badge.svg)](https://github.com/gauravkumarit8/udhaar/actions/workflows/build-android.yml)

---

## 🎯 What is Udhaar?

People in India lend money to friends and family, but tracking it is awkward. Udhaar solves this:

- ✅ **Add loans** with interest (monthly or yearly rate) and auto-generate EMI schedule
- ✅ **Smart reminders** — T-2, T-1, T0 notifications + 7-day overdue nag mode
- ✅ **Mark payments** — partial interest/principal payments with proof upload
- ✅ **UPI deep links** — one-tap pay buttons inside reminders
- ✅ **1-side or 2-side confirmation** — flexible payment verification
- ✅ **Auto-close loan** — when principal is fully repaid

---

## 🚀 Quick Start

### Option 1: GitHub Codespace (Fastest)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/gauravkumarit8/udhaar)

1. Click the badge above → creates a full dev environment
2. PostgreSQL + Node.js are pre-configured
3. App auto-starts on port 3000

### Option 2: Local Development

```bash
# Clone
git clone https://github.com/<your-username>/udhaar.git
cd udhaar

# Install
npm install

# Configure
cp .env.example .env

# Create the tables (applies the SQL migrations in drizzle/)
npm run db:migrate

# Check that everything the app needs is actually in place
npm run check-deploy

# Run
npm run dev
```

Open http://localhost:3000 → enter any 10-digit mobile → the login screen shows
the **dummy OTP** and a "Tap to fill" button, because no SMS provider is
configured yet. See [OTP delivery](#-otp-delivery) below before you launch.

No Postgres installed? `node scripts/dev-db.mjs` runs one in-process (PGlite)
that speaks the normal Postgres protocol on `127.0.0.1:5432`:

```bash
node scripts/dev-db.mjs &                       # terminal 1
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npm run db:migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npm run dev
```

> PGlite serves a **single connection at a time**. The dashboard fires two
> requests in parallel, so a browser session against it will fail with
> `Connection terminated unexpectedly`. Use it for one-off scripts; for a real
> preview, run actual Postgres (`pgserver`, or the Docker compose file).

### Tests & checks

```bash
npm test                 # vitest - EMI maths, payments, OTP policy, input validation
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run build            # production build
npm run check-deploy     # is the database + config actually usable?
```

### When something is broken

Two commands answer "why doesn't it work?" without reading any logs:

| Command / URL | What it tells you |
|---|---|
| `npm run check-deploy` | Whether `DATABASE_URL` is set, the database is reachable, the schema is applied, and OTP delivery is configured - with the fix for each problem. Exits non-zero when something is wrong, so it can gate a deploy. |
| `GET /api/health` | The same checks as JSON, for a browser or an uptime monitor. Returns **503** when unhealthy, and names the first problem plus the command that fixes it. |

`/api/health` is also the path Render health-checks, so a deployment with a
broken database reports *why* instead of a bare `{"ok":false}`.

Every API route also wraps its handler (`src/lib/api-handler.ts`), so an
unexpected failure comes back as JSON the UI can display:

```json
{
  "error": "The server can't reach its database (the host in DATABASE_URL doesn't resolve).",
  "action": "Open /api/health for the full check, or re-copy the database connection string.",
  "reference": "2026-10-13T09:10:19.140Z"
}
```

Previously a database outage produced an **empty 500**, the login screen
flagged `res.json()` as a failure and showed "Something went wrong" — the real
reason was invisible. Now the login screen (and every other page) shows that
`error` text, the server logs the underlying driver error, and `reference`
ties the two together.

### Database changes (migrations)

The schema lives in `src/db/schema.ts`; the SQL in `drizzle/` is generated from
it and applied in order.

```bash
npm run db:generate   # after editing schema.ts - writes drizzle/NNNN_*.sql
npm run db:migrate    # apply pending migrations (CI + deploy run this)
npm run db:baseline   # one-off: adopt migrations on a database created by db:push
npm run db:push       # still works, but prefer migrations - they're versioned
```

> **Already have a database from `db:push`?** Run `npm run db:baseline` once
> before `db:migrate`. Without it, Drizzle replays the initial migration and
> fails with `relation "users" already exists`. The baseline command records
> the existing migrations as already applied and does nothing otherwise.

### Option 3: Docker

```bash
docker compose up
```

---

## 🔐 OTP delivery

Udhaar doesn't assume an SMS provider. `OTP_MODE` decides what happens:

| `OTP_MODE` | Behaviour |
|-----------|-----------|
| `auto` *(default)* | Real SMS when `MSG91_AUTH_KEY` + `MSG91_FLOW_ID` are set. Otherwise: **development** falls back to the dummy OTP, **production refuses to issue OTPs** (503) instead of handing the code to whoever asks. |
| `dummy` | Always the dummy OTP (`123456`), in every environment, and the code is returned in the API response. Convenient for testing and demos — **anyone who can reach the API can log in as any mobile number.** |
| `sms` | Always MSG91; fails loudly if it isn't configured. |

Set `OTP_MODE=dummy` explicitly if you want the dummy code on a deployed
instance (it logs a warning on every boot and the login screen shows a badge).
Leave it on `auto` and configure MSG91 before real users arrive.

Upgrade path: create a DLT-approved MSG91 Flow template with a variable named
`OTP`, then set `MSG91_AUTH_KEY`, `MSG91_FLOW_ID` and `OTP_MODE=sms`. Codes are
generated with `crypto.randomInt`, expire after 5 minutes, and lock out after 5
wrong attempts.

### Sessions

Login sets an opaque 32-byte random token in an `httpOnly` cookie and stores it
in the `sessions` table. The cookie never contains a user id, so a tampered or
forged cookie is simply "not logged in", and logging out revokes the session
server-side. Sessions expire after 30 days.

---

## 📱 Mobile App (Android/iOS)

Udhaar runs as a native app using **Capacitor** with these native features:

| Feature | Plugin | Web Fallback |
|---------|--------|-------------|
| Smart Reminders | LocalNotifications | Browser Notifications |
| Camera (Proof) | Camera | File input |
| Haptics | Haptics | Silent |
| Share/Invite | Share | Web Share API |
| Offline Detection | Network | navigator.onLine |
| Status Bar | StatusBar | CSS safe-area |
| Splash Screen | SplashScreen | CSS loader |

### Build Android APK

```bash
# One command:
./mobile-build.sh android

# Or manual:
npx cap add android
npx cap copy android
npx cap open android
# Then in Android Studio: Build → Build APK
```

### Build iOS IPA

```bash
./mobile-build.sh ios
# Then in Xcode: Product → Archive
```

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────┐
│             Mobile / Web Frontend            │
│  Next.js (React) + Tailwind CSS + Capacitor  │
├──────────────────────────────────────────────┤
│               API Routes (SSR)               │
│  Auth · Loans · Installments · Payments      │
├──────────────────────────────────────────────┤
│              Business Logic                  │
│  EMI Calculator · Status Engine · Reminders  │
├──────────────────────────────────────────────┤
│           PostgreSQL (Drizzle ORM)           │
│  Users · Loans · Installments · Payments     │
└──────────────────────────────────────────────┘
```

---

## 🔄 GitHub Actions Workflows

### CI (every PR)
Runs on every push to `main` and every PR:
- ✅ ESLint
- ✅ TypeScript type checking
- ✅ Vitest unit tests
- ✅ Next.js build
- ✅ Docker image build

### Web Deploy (on tag `v*`)
- Builds Docker image → pushes to GitHub Container Registry
- Deploys to Render / Fly.io / Vercel

### Android Build (on tag `v*` or manual dispatch)
- Sets Capacitor server URL to production
- Builds debug APK or release AAB
- Uploads APK to GitHub Releases

### iOS Build (on tag `v*` or manual dispatch; skipped with a warning until the Apple secrets are set)
- Builds on macOS runner with Xcode
- Signs with Apple certificate
- Uploads IPA artifact
- Submits to App Store Connect

### Full Release (on tag `v*`)
Triggers all three builds + creates a GitHub Release with:
- Web Docker image
- Android APK
- Release notes from git log

---

## 🚢 Deployment notes

- **Static assets with `output: standalone`.** Next.js does *not* copy
  `.next/static` or `public/` into `.next/standalone`, so any start command that
  runs `node .next/standalone/server.js` must stage them first (the Dockerfile
  and `render.yaml` both do). Skipping this serves HTML with no CSS or JS.
- **Apply the migrations on a fresh database.** `npm run db:migrate` runs the
  SQL in `drizzle/` (generated from `src/db/schema.ts`). CI applies them to an
  empty Postgres, and `render.yaml` runs them on every boot — a no-op once
  applied.
- **Don't use Render's free Postgres for real data.** Free instances are
  deleted 30 days after creation, with no backups: that is what silently broke
  production login once. Use any external Postgres (Neon, Supabase, Aiven) and
  set `DATABASE_URL` in the host's dashboard.
- **Run `npm run check-deploy` before blaming the app.** It distinguishes a
  missing environment variable from an unreachable database from a missing
  schema, and prints the command that fixes each.
- **`OTP_MODE`.** Set it deliberately on every deployment: `auto` (default)
  fails closed in production until MSG91 is configured, `dummy` opts into the
  insecure-but-testable code.
- **Render / Fly / Vercel.** `render.yaml` and `Dockerfile` are kept working;
  `vercel.json` is a plain Next.js config, so any of them works as long as the
  two points above are handled.

## 🔧 GitHub Secrets (Required for Mobile Builds)

Go to **Settings → Secrets and variables → Actions**

| Secret | Purpose |
|--------|---------|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded Android keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias name |
| `ANDROID_KEY_PASSWORD` | Key password |
| `IOS_P12_BASE64` | Base64-encoded Apple distribution certificate |
| `IOS_P12_PASSWORD` | Certificate password |
| `IOS_PROVISION_PROFILE_BASE64` | Base64-encoded provisioning profile |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APP_STORE_API_KEY_ID` | App Store Connect API key ID |
| `APP_STORE_API_ISSUER_ID` | App Store Connect API issuer ID |
| `RENDER_DEPLOY_HOOK` | Render.com deploy webhook URL |
| `FLY_API_TOKEN` | Fly.io API token |

### GitHub Variables

| Variable | Purpose |
|----------|---------|
| `APP_URL` | Production URL (e.g. `https://udhaar.vercel.app`) |

---

## 📁 Project Structure

```
├── .devcontainer/          # GitHub Codespace config
├── .github/workflows/      # CI/CD pipelines
│   ├── ci.yml              # PR checks
│   ├── deploy-web.yml      # Docker build + deploy
│   ├── build-android.yml   # Android APK/AAB
│   ├── build-ios.yml       # iOS IPA
│   └── release.yml         # Full release (all platforms)
├── src/
│   ├── app/                # Next.js App Router
│   │   ├── login/          # OTP auth
│   │   ├── dashboard/      # Home
│   │   ├── loans/          # Add + detail
│   │   ├── activity/       # Reminders
│   │   ├── profile/        # Settings
│   │   └── api/            # Backend routes
│   ├── components/         # UI components
│   ├── hooks/              # React hooks (native bridge)
│   ├── lib/                # Business logic (calculations, payments, auth,
│   │                       #   validation, input/http helpers)
│   └── db/                 # Database schema
├── drizzle/                # Generated SQL migrations + journal
├── scripts/                # dev-db.mjs (local Postgres), check-deploy.mjs,
│                           #   baseline-migrations.mjs
├── tests/                  # Vitest suites
├── public/                 # Static assets + PWA
├── capacitor.config.ts     # Capacitor native config
├── docker-compose.yml      # Local Docker setup
├── Dockerfile              # Production container
├── fly.toml                # Fly.io deployment
├── render.yaml             # Render.com deployment
├── vercel.json             # Vercel deployment
└── mobile-build.sh         # Mobile build helper
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Backend** | Next.js API Routes (Serverless) |
| **Database** | PostgreSQL 15 + Drizzle ORM |
| **Auth** | Cookie-based session (mock OTP) |
| **Mobile** | Capacitor 6 (Android + iOS) |
| **Notifications** | Capacitor LocalNotifications |
| **Camera** | Capacitor Camera |
| **CI/CD** | GitHub Actions |
| **Deploy** | Docker, Vercel, Render, Fly.io |

---

## 📜 License

MIT
