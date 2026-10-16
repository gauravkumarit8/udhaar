# 💰 Udhaar — Track Loans & EMIs

> **Splitwise + EMI Tracker + Auto Reminder** for informal loans in India

[![CI](https://github.com/gauravkumarit8/udhaar/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravkumarit8/udhaar/actions/workflows/ci.yml)
[![Release](https://github.com/gauravkumarit8/udhaar/actions/workflows/release.yml/badge.svg)](https://github.com/gauravkumarit8/udhaar/actions/workflows/release.yml)
[![Android Build](https://github.com/gauravkumarit8/udhaar/actions/workflows/build-android.yml/badge.svg)](https://github.com/gauravkumarit8/udhaar/actions/workflows/build-android.yml)

---

## 🎯 What is Udhaar?

People in India lend money to friends and family, but tracking it is awkward. Udhaar solves this:

- ✅ **Both directions** — record a loan you lent, or one you owe (naming a lender who has never used the app; their account attaches when they sign up)
- ✅ **Add loans** with interest (monthly or yearly rate) and auto-generate EMI schedule
- ✅ **Smart reminders** — T-2, T-1, T0 notifications + 7-day overdue nag mode
- ✅ **Mark payments** — partial interest/principal payments with proof upload
- ✅ **UPI deep links** — one-tap pay buttons inside reminders
- ✅ **1-side or 2-side confirmation** — flexible payment verification
- ✅ **Settle in full** — one payment clears the whole loan, not one EMI at a time
- ✅ **Close & write off** — give up on a balance without pretending it was paid
- ✅ **Auto-close loan** — when the loan is fully settled

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
npm run verify:settlement # drives the real routes on a running server (needs a scratch DB)
npm run verify:ui        # holds every screen to the design system (needs a running server)
```

`verify:settlement` is the check that would have caught the "can't close a paid-up
loan" bug: it seeds three users and a session each, then settles loans over HTTP
- full payment, early settlement, overpayment, part payment, write-off, 2-side
confirmation, permissions and rejected amounts. Start `npm run dev` first, and
point both the server and the script at the same **scratch** database.

It also needs the app it is pointed at to be able to sign someone in: the checks
read the dummy code back from `/api/auth/send-otp`, which only answers with one
when the app runs with `OTP_MODE=dummy`, and they drive the reminder sweep, which
needs the same `CRON_SECRET` the server has. Point `BASE_URL` at a deployment
without either and the harness says so in one line and stops, rather than
failing two hundred checks for one reason. CI sets both for its own container.

```powershell
$env:DATABASE_URL = "postgresql://user:pass@host/scratch"
$env:OTP_MODE     = "dummy"     # so the harness can sign itself in
$env:CRON_SECRET  = "any-long-string-the-server-also-has"
npm run dev                                          # other terminal
npm run verify:settlement                            # 215 checks, exit 1 on failure
```

`verify:ui` is the same idea for the interface. It asks the server for every
page's HTML and for the stylesheet the pages link to, and checks the things a
screenshot would catch and a unit test never will: a class name Tailwind never
generated, a screen still wearing the palette the revamp replaced, the tab bar
rendered twice or missing, the stylesheet losing its dark-mode or print rules.
It seeds one throwaway account and one loan of its own, so it needs nothing but
a running server:

```powershell
npm run verify:ui                                    # 99 checks, exit 1 on failure
```

### When something is broken

Two commands answer "why doesn't it work?" without reading any logs:

| Command / URL | What it tells you |
|---|---|
| `npm run check-deploy` | Whether `DATABASE_URL` is set, the database is reachable, the schema is applied, and OTP delivery is configured - with the fix for each problem. Exits non-zero when something is wrong, so it can gate a deploy. |
| `GET /api/health` | The same checks as JSON, for a browser or an uptime monitor. Returns **503** when unhealthy, and names the first problem plus the command that fixes it. |
| `POST /api/reminders/run` | Runs the scheduled reminder sweep by hand (needs `CRON_SECRET`). Add `?dryRun=1` to see what it would send. |

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

#### "A migration is recorded as applied, but the column is missing"

Symptom: `npm run db:baseline` said it baselined everything, `npm run db:migrate`
says `migrations applied successfully!`, but `npm run check-deploy` still reports
`missing columns: reminders.dedupe_key`.

That means the database was created with `db:push` *before* that migration
existed, and an older `db:baseline` recorded it as applied without checking.
Two ways out:

```bash
npm run db:baseline   # re-run it: it now removes the incorrect record
npm run db:migrate    # and this actually applies the missing migration

# …or in one step, which reconciles the database directly with schema.ts:
npm run db:push
```

Either way, finish with `npm run check-deploy` — it should print **Ready.**

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
> fails with `relation "users" already exists`.
>
> `db:baseline` **verifies** each migration against the database before
> recording it: a migration is only marked as applied if its tables, columns
> and indexes are really there. The first one that isn't stays pending, and
> `db:migrate` applies it. It also repairs a journal that claims more than the
> database actually has (see the troubleshooting note below).

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

### Rate limits

A login screen that sends an SMS is a way to spend somebody else's money, so OTP
sending is capped three ways. They are layered on purpose: the first one is
cheap and stops the common case, and the others are counted in the database so
they survive a restart.

| Cap | Default | Counted where | Stops |
|---|---|---|---|
| Per caller | 10 per 10 minutes | in memory (`src/lib/rate-limit.ts`) | one connection walking a list of numbers |
| Per number | `OTP_PER_MOBILE_DAILY_MAX`, 10 a day | `otps` table | SMS-bombing one number, and burning your budget on it |
| Service-wide | `OTP_GLOBAL_HOURLY_MAX`, 300 an hour | `otps` table | a botnet rotating `X-Forwarded-For`, which the per-caller cap cannot see |
| Proof uploads | 20 per 10 minutes per account | in memory | one account filling your proof storage |

Hitting a cap answers `429` with a `retry-after` header and a sentence a person
can read ("Too many OTP requests from this connection. Try again in 600s."),
rather than a generic failure. Guessing an OTP wrong five times locks that code
out entirely, and re-requesting an OTP invalidates the previous one.

The per-number and service-wide caps are deliberately *not* resettable by
restarting the app or by making the request look like it came from somewhere
new, which is the whole point of keeping them in the database.

### Sessions

Login sets an opaque 32-byte random token in an `httpOnly` cookie and stores it
in the `sessions` table. The cookie never contains a user id, so a tampered or
forged cookie is simply "not logged in", and logging out revokes the session
server-side. Sessions expire after 30 days.

---

## 📱 Mobile App (Android/iOS)

Udhaar runs as a native app using **Capacitor** with these native features:

> **The app loads the hosted web app, on purpose.** `server.url` in
> `capacitor.config.ts` points at the deployment, so a bug fix reaches every
> installed app the moment it is deployed — no store review, no rebuild. The
> trade-offs are real and worth knowing:
> - With no connection the app cannot show your data (there is no local copy).
>   The WebView now displays `public/offline.html` instead of a blank screen —
>   including the "the site may be waking up" hint, which matters on a free
>   Render instance that sleeps.
> - Stores can be strict about an app that is only a website wrapper. If you
>   ever publish to the Play Store or App Store, switch to a bundled build:
>   `npx next build` with `output: "export"`, point `webDir` at the exported
>   directory, drop `server.url`, and give the API calls an absolute base URL
>   (the app then talks to the deployed backend instead of its own origin).
>   That also makes the app work offline for anything cached.

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

Or from CI: **Actions → Build Android APK/AAB → Run workflow** (it also runs on
a `v*` tag). It is deliberately *not* wired to every push to `main`.

Worth knowing before rebuilding: because the app loads the hosted site, a rebuild
does **not** change any screen in the app - the screens come from the deployment
and update the moment it does. A rebuild changes the shell only:

- the offline page shown when the site cannot be reached (`public/offline.html`),
- splash screen / status bar / icon settings,
- **push notifications** - the Firebase `google-services.json` has to be in the
  project for FCM registration to work, and it is added from the
  `ANDROID_GOOGLE_SERVICES_JSON` secret. Without that secret the build succeeds
  and push silently does nothing.

So: rebuild when the shell changed or when push was newly configured, not to ship
a feature.

### Build iOS IPA

```bash
./mobile-build.sh ios
# Then in Xcode: Product → Archive
```

**No iOS build has ever succeeded on CI.** The last runs fail at *Install Apple
Certificate* with the signing secrets unset or invalid, so nothing after that
step runs. An iOS build needs a paid Apple Developer account, a distribution
certificate (`.p12`) and a provisioning profile; add them as
`IOS_P12_BASE64`, `IOS_P12_PASSWORD`, `IOS_PROVISION_PROFILE_BASE64` and
`APPLE_TEAM_ID` (see *GitHub Secrets* below) - or run it locally from Xcode with
your own signing team. Until then the iOS job is a red X on every tag, which is
worth knowing rather than rediscovering.

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

## 📋 What the home screen lists

The **Upcoming & Overdue** list shows **one row per loan** - the earliest payment
still owed on it - not one row per EMI. A loan with ten installments used to
produce ten near-identical rows ("23 items" on a two-loan account); now it shows
the next one, and anything else already late on the same loan is summarised on
that line (`· 2 more overdue ₹4,240`). The counter beside the heading counts
loans for the same reason.

Money is unaffected by the collapse: the header totals still add up **every**
unpaid installment, and the per-loan figure on each row is the next payment only.
The rule lives in `src/lib/due-items.ts` (`pickNextDuePerLoan`) with unit tests in
`tests/due-items.test.ts`, so the list and the totals can't drift apart.

### Payloads are pages, not archives

Both lists the dashboard prints are one page of five rows by default, and both say
how much is behind them (`hasMoreLoans`, `dueItemCount`). The numbers behind the
list are summed in SQL - three `sum(case ...)` over the active loans' installments
- instead of being folded in Node from every installment of every loan.
`?limit=` asks for a bigger page (clamped to 200); the dashboard page leaves it
alone and links to `/loans`, which lists every loan a page at a time through
`GET /api/loans?limit=&offset=` (see `src/lib/paging.ts`). The Activity screen is
the one that asks for the whole due list (`?limit=200`), because it renders all of
it - it is the see-everything view for payments, and beyond 200 loans with
something due it will need paging of its own.

Measured on an account with 143 loans (63 active) in one sitting, old build
against new, same data:

| | before | after |
| --- | --- | --- |
| `/api/dashboard` response | 110,672 bytes | **5,180 bytes** |
| warm latency (local Postgres) | 12.0 ms | **7.7 ms** |
| installments read out of Postgres | 453 rows / 138 KB | **201 rows / 15 KB** |
| loan rows read out of Postgres | 143 | **5** |

The seven summary figures are identical to the last paisa (checked by diffing the
two payloads, and by the harness folding the raw rows itself:
`npm run verify:settlement`).

### Searching a long history

The list screen (`/loans`) is where the dashboard's "see all" goes, and it is
searchable: `GET /api/loans?q=&status=&role=` filters server-side, so a search
only sees what it should rather than whatever pages happen to be loaded. The
search text is normalised and its LIKE wildcards are escaped
(`src/lib/loan-search.ts`, with tests) - searching for `%` looks for a percent
sign and finds nothing, instead of matching every loan on the account - and it
is always passed as a query parameter, never spliced into SQL.

### The design system

Colour, radius, elevation and motion are declared once, as tokens in
`src/app/globals.css`, and every screen spends them through the primitives in
`src/components/ui.tsx` (Button, Card, Sheet, Notice, Badge, Chip, Field,
Progress, Avatar, Skeleton, DetailRow, EmptyState) and `src/components/ActionSheets.tsx`
(recording a payment, sending a reminder - the two things both the home screen
and the loan screen need to be able to open).

Two rules keep it honest:

- **No `dark:` variants.** Light and dark are the same tokens with different
  values, and `@theme inline` points the utilities straight at the variables, so
  a component that needs a `dark:` class is a component that has hard-coded a
  colour. `verify:ui` fails if one appears.
- **Money is formatted in one place.** `formatMoney` (Indian digit grouping, no
  decimal tail on whole rupees, two decimals when there is a fraction) replaced
  four copies of `formatINR`; `tests/money.test.ts` holds it to those rules.

Printing is treated as a document rather than a screen: `@media print`
re-declares the light palette, so a statement printed from a phone in dark mode
comes out on white paper instead of as a black rectangle.

### A statement you can hand over

`/loans/[id]/statement` is the whole record on one sheet: the schedule with each
EMI's paid/waived/balance, the payment ledger, and the totals. It prints (or
saves as PDF) with the app chrome hidden, and *Share* turns it into a
WhatsApp-sized summary - plus a per-payment receipt. The arithmetic lives in
`src/lib/loan-statement.ts` and is unit-tested, including the rule that matters
most: **waived money is not owed**, so a written-off or early-settled loan reads
as settled rather than as a lingering balance.

### Why it is quick on a slow connection

The database is usually in another region, so every query round-trip is felt.

- `/api/dashboard` runs its four queries (summary, due list, one page of loans,
  badge count) **together** and returns the signed-in person, so the page makes
  one request instead of two.
- `/api/notifications?summary=1` (the bottom-bar badge) is a single `count(*)`
  joined on `users`; the unread count in the feed comes from SQL too.
- `/api/loans/[id]` fetches installments and payments **in parallel**.
- The bank of hot-path indexes is `drizzle/0007_hot_path_indexes.sql`, and the
  connection pool keeps connections alive between requests.
- The dashboard and the badge paint from `sessionStorage` (`src/lib/client-cache.ts`)
  while the fresh copy is on its way - cleared on sign-in and sign-out, so a shared
  phone never flashes the previous person's balances.

Measured warm against a 40 ms-per-round-trip proxy: dashboard **137 → 96 ms**
(3,078 → 1,084 bytes), badge **183 → 93 ms**, loan detail **181 → 139 ms**,
notifications **178 → 134 ms**.

---

## 🔄 GitHub Actions Workflows

### CI (every PR)
Runs on every push to `main` and every PR:
- ✅ ESLint
- ✅ TypeScript type checking
- ✅ Vitest unit tests
- ✅ Next.js build
- ✅ Docker image build

### Web Deploy (on tag `v*`, on every push to `main`, or manually)
- Builds the Docker image → pushes it to GitHub Container Registry
- Then triggers the Render deploy hook (`RENDER_DEPLOY_HOOK`), unless the secret
  is unset, in which case the job says so and passes
- **Manual runs deploy by default** — Actions → *Deploy Web* → *Run workflow* is
  the button for "update the live app now" without pushing a commit
- A rejected hook fails the job (it used to pass silently)

> **Two deploys per commit?** If Render's own *Auto-Deploy* is also on for this
> service, a push to `main` queues one deploy from Render and one from here.
> Pick one: keep Render's (it still deploys when Actions is broken or the
> workflow is disabled), or turn Auto-Deploy off and let this job own it.

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

## ⏰ Scheduled reminders (free)

Borrowers get a push when an EMI is coming up or late — T-2, T-1, T0, then one a
day for the first week overdue — without the lender having to open the app and
tap "Remind". This is the same cadence the app already schedules *locally* on
the lender's own phone (`src/lib/native.ts`), moved to the server so the person
who owes the money actually hears about it.

**It costs nothing.** Push delivery is Firebase Cloud Messaging (free and
unlimited), and the clock is a GitHub Actions schedule — the same free minutes
as any other workflow.

### How it works

```
.github/workflows/reminders.yml   →   POST /api/reminders/run   →   FCM push
   09:00 IST daily (03:30 UTC)         one reminder per EMI          to the borrower
   + a manual "Run workflow"           per day, deduplicated
```

`POST /api/reminders/run` refuses to run unless `CRON_SECRET` is set, so it can
never be used by a stranger to spam every borrower. It is also **idempotent**:
`reminders.dedupe_key` is unique, so a scheduler that fires twice (retry, a
manual run, two overlapping crons) sends one notification, not two. Six
simultaneous sweeps still produce exactly one reminder per EMI per day.

### Setup (2 steps, ~2 minutes)

1. **Generate a secret** and set it on the service as `CRON_SECRET`:

   ```powershell
   # PowerShell - or use any long random string
   $secret = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})
   $secret
   ```

   Render → your service → Environment → add `CRON_SECRET`.

2. **Add the same value to GitHub** → Settings → Secrets and variables →
   Actions → New repository secret → name `CRON_SECRET`.

That's it — the workflow runs every morning. Press **Actions → Reminders sweep →
Run workflow** to trigger one by hand; tick *dry_run* to see what it *would*
send without sending anything.

Pinned somewhere else? Set a repository **variable** `UDHAAR_APP_URL` and the
workflow will use it instead of the default deployment URL.

### If the schedule ever stops

GitHub silently disables schedules in a **public** repository after 60 days with
no activity (one push re-enables it), and its timer can run late under load —
which is fine for a reminder. Any other free clock works too, because the
endpoint is just HTTP:

| Fallback | Notes |
|---|---|
| [cron-job.org](https://cron-job.org) | Free, unlimited jobs, down to once a minute. 30-second timeout — a sleeping free Render service may need a retry. |
| Cloudflare Worker cron trigger | Free tier allows 5 triggers per account. |
| Any uptime monitor | Point it at the URL below. |

```
POST https://<your-app>/api/reminders/run
Authorization: Bearer <CRON_SECRET>
```

`/api/health` reports whether `CRON_SECRET` is configured, and
`npm run check-deploy` says the same from a terminal.

> **Delivery caveat.** A push only lands if the borrower has opened the app at
> least once and allowed notifications. Until then the reminder is still
> recorded and shows up in their Activity feed, and the sweep tells you how many
> went undelivered (`"note"` in its JSON response).

## 🔔 Who gets notified, and when

Every event that matters to the *other* side of a loan now tells them about it —
not just the scheduled reminders. The notification lands in their Activity feed
always, and on their phone whenever the app is installed and push is configured
(`FIREBASE_SERVICE_ACCOUNT_KEY`).

| Event | Who is told | What they read |
| --- | --- | --- |
| A loan is added for them | the borrower | "Gaurav added a loan of ₹5,000 for you … first payment of ₹1,000 due on 15 Oct 2026." |
| They sign up after a loan was recorded | the borrower | the same notice, the first time they log in |
| A borrower records a debt to them | the lender, once they join | "Sneha had recorded owing you ₹20,000 on Udhaar, and it is now linked to your account." |
| A payment is marked (2-side loan) | whoever has to confirm it | "Rahul marked ₹1,000 as paid for EMI 1 (due 15 Nov). Confirm it once the money reaches you." |
| A payment is recorded (1-side loan) | the other side | "Gaurav recorded a payment of ₹1,000 for EMI 1." — plus "the loan is settled 🎉" when it was the last one |
| A payment is confirmed | the person who marked it | "Gaurav confirmed your ₹1,000 payment for EMI 1." |
| A payment is rejected — including one that can no longer be applied | the person who marked it | "Gaurav rejected the ₹1,000 payment you marked for EMI 2." |
| The loan terms change | the borrower | "Gaurav updated your loan: ₹6,000 over 6 months from 1 Nov 2026. The EMI schedule has been rebuilt…" |
| The loan is closed | the borrower | "Gaurav closed the loan of ₹5,000." (interest still owed is spelled out) |
| T-2 / T-1 / T0 / first week overdue | the borrower | the scheduled reminders above |

Three rules keep it predictable:

- **Nobody is told about what they did themselves.** The actor knows; only the
  counterparty is notified.
- **A notification never breaks the money.** If push fails, or the row cannot be
  written, the payment or the loan still commits — the failure is logged, and
  the feed row keeps an honest `sent` / `failed` status rather than claiming
  delivery.
- **The feed is per-person.** The copy is written in the second person ("your
  loan"), so `GET /api/notifications` only returns what was addressed to the
  caller (`reminders.recipient_id`). Rows written before that column existed are
  shown to both sides of the loan, as they always were.

A borrower who has no Udhaar account yet is not forgotten: their notifications
are delivered the moment they sign up (`backfillBorrowerLoans` links the loans
recorded against their mobile number, and announces them). The same is true in
the other direction: a **lender** who was named in a debt someone else recorded
is linked and told about it by `backfillLenderLoans` on first login.

Not covered, deliberately: **deleting a loan** notifies nobody, because the
notification rows belong to the loan and go with it — and a payment "reminder"
for a loan that no longer exists would be noise.

> `reminders.recipient_id` and `reminders.type` come from
> `drizzle/0002_notification_recipient.sql`. On an existing database run
> `npm run db:migrate` (or `npm run db:push`); until then `npm run check-deploy`
> reports the missing column, the Activity feed answers 503 with the fix, and
> everything else — including the loan and payment that triggered the
> notification — keeps working.

## 📲 Making notifications actually arrive

Udhaar notifies people about money two ways, and **both are off by default** -
that is the whole reason "I can see the dashboard updating but no notification"
was possible even when everything on the server worked.

| Channel | Reaches | Needs |
| --- | --- | --- |
| **In-app** (always on) | the Activity screen, with a badge on the 🔔 tab | nothing |
| **Browser push** (Web Push) | this browser / an installed PWA, even when it's closed | `npm run generate:vapid` → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` on the service |
| **App push** (FCM) | the native Android/iOS app | `FIREBASE_SERVICE_ACCOUNT_KEY` **and** `google-services.json` inside the Android build |

### Turning on browser push (2 minutes, free)

```bash
npm run generate:vapid     # prints the two keys
```

Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on the service (Render →
Environment; `render.yaml` already declares them), optionally
`VAPID_SUBJECT=mailto:you@example.com`, then deploy once.

The next person to open the app sees a **"Turn on notifications"** card on the
dashboard - one tap subscribes that browser. It can also be toggled later in
**Profile → Push Notifications**, which subscribes or unsubscribes *that device*
as well as saving the preference.

`npm run check-deploy` and `/api/health` both report the channel state: with no
keys they say `push (browser): not configured`, and nothing silently pretends to
work.

**Notes**
- The private key is a secret. Don't regenerate the pair once people have
  subscribed - existing subscriptions are bound to it and would stop working.
- iOS only allows web push for a PWA that has been **added to the Home Screen**
  (iOS 16.4+). In an ordinary Safari tab there is nothing to deliver to, and the
  app says so rather than failing silently.
- Dead subscriptions (browser data cleared, PWA uninstalled, permission
  revoked) are deleted automatically the first time a send returns 404/410.
- The in-app feed is not a fallback you can be lazy about: it is the record.
  Every notification is written there with an honest `sent` / `failed` status,
  whether or not a device accepted it.

### Turning on push for the Android app

FCM cannot register without a Firebase config file *inside the Android project*.
Add `google-services.json` (Firebase console → Project settings → Your apps) as
the repository secret `ANDROID_GOOGLE_SERVICES_JSON`, base64-encoded:

```bash
base64 -w0 google-services.json    # Windows: [Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))
```

`build-android.yml` writes it to `android/app/` on the next build. Without the
secret the step is skipped and the build still succeeds - it just can't receive
push.

### Where notifications show up

- **🔔 Activity tab** - every notification addressed to you, newest first, with
  an unread count badge on the tab itself. Opening the screen clears the badge.
- **Phone/browser** - a real notification, if a channel above is configured and
  enabled for that device. Tapping it opens the loan it is about.

## 🧾 Payment proofs are private

A proof screenshot is a bank or UPI receipt - names, amounts, sometimes an
account number. So a payment proof is visible to exactly the two people on the
loan, and to nobody else:

- **Uploads are stored privately.** `POST /api/upload` sends the image to
  Cloudinary as an `authenticated` asset - one that cannot be fetched without a
  signature - and returns the asset's **id**. The payment row stores that id
  (`payments.proof_public_id`); no fetchable URL is ever written to the
  database.
- **Reading one goes through the app.** `GET /api/payments/[id]/proof` checks
  the session against the loan the payment belongs to, signs a delivery URL
  *server-side*, fetches the bytes and streams them back. Your browser never
  sees a Cloudinary URL, so there is no link to forward, leak, or find later in
  a log. Anyone else - logged in or not - gets the same `404` as a payment that
  doesn't exist, so a stranger can't even probe for one.
- **Failures say what happened** instead of rendering a broken image: `503`
  names the missing `CLOUDINARY_*` variables, `502` reports what the proof store
  answered (a rejected credential is called out by name).
- **A proof has to actually be a photo.** Uploads are checked twice: the data
  URL must declare a raster type (JPEG, PNG, GIF, WebP, HEIC, AVIF), and the
  decoded bytes must match that type's signature. An **SVG is refused by name**,
  because an SVG is not a picture - it is a document the browser parses and runs
  scripts in, and proofs are served from the app's own origin. The response that
  hands back the bytes also declares its own content type and carries
  `Content-Security-Policy: default-src 'none'; sandbox`, so nothing in a stored
  file can act even if the checks above were ever wrong.

`CLOUDINARY_DELIVERY_HOST` is optional - set it only if your Cloudinary account
serves assets from a custom domain.

Proofs uploaded before this change stored a public Cloudinary URL
(`payments.proof_url`). Those keep working: the route redirects to the stored
URL, since that link was public already and rewriting it would need the
original file. Re-upload is the only way to make an old proof private.

## 📲 Reminding someone who will never install this app

The uncomfortable truth about reminders: a borrower will not install an app to
be told they owe money. So the reminder is designed around that.

- **WhatsApp is the default.** Tapping **🔔 Remind** (on a loan, or in the
  Activity tab) opens a small sheet: WhatsApp first, then SMS, then in-app. The
  first two open *your own* phone's app with the message already written -
  amount, due date, and your UPI link, addressed to the borrower. You press
  send. Nothing has to be installed on their side, and it works for someone who
  has never heard of Udhaar.
- **In-app notification** stays available, and is the only channel where
  delivery is knowable: it reaches the borrower if they installed the app and
  allowed notifications, and the app says so honestly either way.
- **The record never overstates.** A reminder sent through your WhatsApp is
  stored with `status: "shared"` - a message *you* sent - and is never reported
  as "delivered". Only a push that a device accepted is. That distinction is
  visible in the API and in the notification history, because an app that
  claims to have reminded someone when it didn't is worse than no reminder.
- **No provider, no cost.** Deep links (`wa.me/<number>?text=…`,
  `sms:+91…?&body=…`) need no SMS gateway, no DLT registration, and no plan.
  Automatic SMS stays a later upgrade on top of this.

The scheduled T-2/T-1/T0 sweep still pushes to anyone with the app; for
everyone else the lender now has a one-tap way to send it themselves.

### Sending them automatically (WhatsApp Business API)

The one-tap share needs a human to tap, every day, for every loan. If you want
the T-2/T-1/T0 sweep to actually send the WhatsApp message itself, the app
supports Meta's **WhatsApp Cloud API** - the official one, no middleman, no
unofficial libraries (those get numbers banned, and a banned number takes the
whole reminder channel with it).

**It is off until you configure it.** With nothing set, everything above works
exactly as it does today: push to the people who have the app, one-tap share for
everyone else.

**What it costs.** Meta bills per *delivered* message, on its own INR rate
card: a **utility** template to an Indian number is **₹0.115** (about ₹0.136
with 18% GST) at the time of writing - a reminder template is a utility
template, and since 1 October 2026 utility templates are billed whether or not
the person messaged you first. A refused or undelivered template is not
charged. There is no per-message middleman markup here because this talks to
Meta directly rather than through a BSP: **100 reminders a month is about
₹14.** (Rates change - check Meta's published rate card before budgeting on
this.)

The app also caps itself, because an unbounded loop that costs money per
iteration is how a bug becomes a bill: `WHATSAPP_MAX_PER_RUN` (50) per sweep and
`WHATSAPP_DAILY_MAX` (200) per day, counted from the reminder rows themselves -
so a restart cannot reset the counter, and the ceiling holds across workers.
When the day's budget is spent, reminders still go out by push; WhatsApp is just
skipped, with the reason recorded on the reminder.

**Setup** (about 20 minutes, most of it Meta's own forms):

1. Create a **Meta Business account** and a **WhatsApp Business Account**, and
   add a phone number you can receive an SMS or call on. A number already used
   in the normal WhatsApp app has to be deleted from it first.
2. Meta → **WhatsApp → API Setup**: copy the **Phone number ID**, and create a
   **System User** token with `whatsapp_business_messaging` (a temporary token
   from that page expires in 24 hours - the check below says so if you use one).
3. Submit the **template** below and wait for *Approved*. Business-initiated
   messages can only use an approved template; that is Meta's rule, not this
   app's.
4. Set the variables (locally in `.env`, on the host in its environment):
   `WHATSAPP_PROVIDER=meta`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`,
   `WHATSAPP_VERIFY_TOKEN`, and the template's name/language if you changed it.
5. Point Meta's webhook at `https://your-app/api/whatsapp/webhook` with the
   verify token from step 4, subscribed to the **messages** field. That is what
   makes delivery reports and STOP replies work.
6. Verify before trusting it:

   ```powershell
   npm run check-whatsapp
   ```

   It makes two read-only calls to Meta and tells you exactly which of the four
   usual mistakes you made: an expired token, a phone *number* pasted where the
   *id* belongs, a template that isn't approved yet (or is named slightly
   differently), or a missing app secret. It never sends a message.

**The template to submit** (name `udhaar_emi_reminder`, category **Utility**,
language English) - the parameter order is fixed, because the app fills these
five values in this order and Meta rejects a send whose parameter count or order
doesn't match:

```
Hi {{1}}, {{2}} is due to {{3}} on {{4}}.
{{5}}
Reply STOP to stop these reminders.
```

| # | Filled with | Example |
|---|---|---|
| 1 | the borrower's first name | `Ravi` |
| 2 | what is still owed on that EMI | `₹4,500.00` |
| 3 | the lender's name | `Aunty Kamla` |
| 4 | the due date | `14 Sep 2026` |
| 5 | how to pay, or what to ask for | `Pay by UPI to kamla@okhdfcbank.` |

**Who gets messaged, and who doesn't.** This part is deliberate:

- **Borrowers who have an account** - signing up is the consent. The sweep
  sends them the template *and* still pushes (push is free, and this is about
  reach, not either/or).
- **Numbers the lender typed in for someone who never signed up** are *not*
  messaged unless you set `WHATSAPP_TO_UNREGISTERED=true`. Messaging a third
  party about money they never asked this app to track is a compliance decision
  and yours to make - the flag exists so you can make it knowingly.
- **Anyone who replies STOP** is recorded in `whatsapp_opt_outs` and is never
  messaged again - by any run, from any worker, immediately. The sweep checks
  that table before every send, and `npm run check-whatsapp`/`/api/health` show
  whether the webhook is wired up at all.

**What the app will and won't claim.** A `200` from Meta means *accepted*, so
that is what gets stored (`provider_status: accepted`), and a reminder is only
marked **delivered** when the webhook says so. The provider's word and the app's
are kept in separate columns precisely so a pushed reminder can never inherit
"delivered" from a WhatsApp message about the same EMI.

**Nothing else changes without it.** No provider, no cost, no configuration:
the app behaves exactly as it did before this existed.

## 🆓 Most loans between people are interest-free

The loan form defaults to **interest-free** - no rate, equal instalments, and
the borrower repays exactly what was lent. That is not a simplification: in
India the vast majority of loans from friends and family are interest-free, and
asking for a rate first makes the app feel like a bank when the user is lending
to their brother.

Charge interest only when it is actually charged: flip the toggle and the rate
appears. The form also offers the amounts people actually lend (₹1,000 – ₹50,000)
and the durations they actually say ("3 months", "1 year") as one-tap chips, so
a whole loan can be entered without the keyboard. A 0% schedule is exact - the
instalments sum to the principal to the paisa, with the last one absorbing the
rounding (₹1,000 over 3 months is 333.33 + 333.33 + 333.34).

## 🧾 Your data, and leaving

- **Download everything**: Profile → *Your data* → **Download my data**, or
  `GET /api/account/export`. One JSON file with the profile, every loan on both
  sides, its instalments, payments (including waivers and unapplied amounts)
  and the notification history. No asking, no waiting.
- **Delete your account**: Profile → *Your data* → **Delete my account**. The
  server refuses while any loan is still open, and says why: a loan is a shared
  record of a real debt, so erasing it mid-flight would destroy the other
  person's evidence. Close or settle each loan (a write-off counts), then
  delete - and the account, its loans, payments, notifications, sessions and
  device registrations go with it.
- **Proof images are the one exception**, and the response says so: uploaded
  screenshots live in storage, not in the database. Their ids vanish with the
  payment rows, so nothing can find them through Udhaar again - but if you want
  the files themselves gone, delete them in Cloudinary (Media Library →
  `udhaar/proofs` → select all → delete). Until proofs are configured there is
  nothing there to delete.

## 🤝 Settling a loan

People rarely pay an EMI schedule line by line - they wait until they have the
money and clear the whole thing in one transfer. Two actions cover that, and
both are on the loan screen for anyone on the loan:

### Settle in full

`POST /api/loans/[id]/payoff` applies **one** payment across the whole schedule,
oldest EMI first (interest before principal inside each EMI, so interest is
never skipped and left behind). What happens next depends on how much arrived:

| Amount received | What the app does |
|-----------------|-------------------|
| the **principal**, or more | loan is **settled**: unpaid interest is recorded as **waived** (early settlement), never as paid |
| more than what is owed | the loan is settled and the excess is kept on the payment as `unapplied_amount` - "₹500 received, not applied to the loan" |
| less than the principal | an ordinary part payment: EMIs fill up oldest-first, nothing is waived |

The sheet defaults to the principal - that is the early-settlement deal - with a
second button to pay the interest too, and it asks before saving an overpayment.

Waived interest is *not* money the borrower paid. It is stored separately
(`installments.interest_waived` / `principal_waived`) and shown as
"₹240.80 written off", so a settled loan never reads as though it was fully
repaid, and the reminders stop chasing it.

### Close & write off

`POST /api/loans/[id]/close` with `{writeOff: true}` closes a loan that will
never be repaid, recording the unpaid balance as written off. Without
`writeOff`, closing still requires the principal to be paid - the response says
so and points at the write-off option instead of failing vaguely. Both paths
refuse to act while a payment claim is still pending (the other person could
confirm it a second later), and closing an already-closed loan is a quiet
success, so a double tap changes nothing.

The borrower is told either way; the message says what was waived or written
off, so nobody is surprised later by a smaller number than the schedule showed.

## 🙋 The other direction: recording what *you* owe

The app started from the lender's side ("I lent ₹5,000 to Rahul"), which left
out half of real life: the same person who lent ₹5,000 has usually borrowed
something themselves. `POST /api/loans` now takes a `side`:

| `side` | Who is asking | Named in the form | Whose account links later |
| --- | --- | --- | --- |
| `"lender"` (default) | the person lending | the borrower | the borrower, on signup (`backfillBorrowerLoans`) |
| `"borrower"` | the person who owes | the lender | the lender, on signup (`backfillLenderLoans`) |

A borrower-entered loan is a **real loan row** with the same schedule, reminders
and settlement rules - the only difference is that `loans.lender_id` stays
`NULL` until the lender signs up with the mobile number that was recorded. Until
then the loan shows a **NOT ON UDHAAR** tag, and the borrower's own reminders
(paid by WhatsApp/SMS share) still work, because the message names the lender
from the loan record rather than from a user row.

### Who is allowed to forgive a debt

This is the rule the whole feature is built around, and it is enforced on the
server, not in the UI:

> **A waiver is never the borrower's to grant.** Closing a loan writes off what
> is left, and settling in full forgives unpaid interest. Neither can be done by
> a borrower on a loan whose lender has no account - there is nobody who could
> grant it, so the borrower pays what they owe in full, and the refusal names
> the lender and says what to do instead.

| Action | Borrower-entered loan, lender not on Udhaar | Once the lender joins |
| --- | --- | --- |
| pay part of what is owed | ✅ | ✅ |
| pay the whole amount | ✅ | ✅ |
| pay the principal and have the rest waived | ❌ refused, with the lender's name | ✅ (the lender chose the confirmation mode) |
| close / write off the loan | ❌ always lender-only | ✅ lender only |
| correct a typo in the entry | ✅ (they typed it) | ❌ now a shared record |
| delete the entry | ✅ while nobody else relies on it | ❌ |

The roles are computed in one place, `src/lib/loan-access.ts`, and every route
that touches a loan or a payment goes through it.

> Requires `drizzle/0006_borrower_side_loans.sql` - run `npm run db:migrate`.
> It makes `loans.lender_id` nullable and adds `created_by_user_id`,
> `lender_name` and `lender_mobile`, backfilling the name and number of every
> existing loan from its lender's account. `npm run verify:settlement` covers the
> whole flow, including a lender signing up and the debt finding them.

## 🔐 Turning on proof uploads (Cloudinary, free)

Proofs are **optional**: with nothing configured the app still records payments,
and a screenshot upload answers `503` naming the missing variables instead of
failing mysteriously. Switching them on takes about five minutes:

1. Create a free account at <https://cloudinary.com/users/register/free>
   (no card required).
2. Open **Dashboard → Product Environment Credentials** (same values under
   *Settings → API Keys*) and copy three things: **Cloud name**, **API Key**,
   **API Secret**.

   > The API secret is *not* your account password. It is the 20-odd character
   > string next to the API key, and it can be rotated there - if you ever
   > rotate it, update it everywhere you set it below.

3. Set the three variables. Locally, put them in `.env`. On a host, add them as
   environment variables (`render.yaml` already declares all three, so on Render
   they are simply blank values waiting in the dashboard).

   ```powershell
   # .env  (or Render → your service → Environment)
   CLOUDINARY_CLOUD_NAME=your-cloud
   CLOUDINARY_API_KEY=123456789012345
   CLOUDINARY_API_SECRET=abcdefghijklmnopqrstuvwxyz
   ```

4. **Verify before trusting it.** This is the step that catches a typo now
   rather than mid-payment:

   ```powershell
   npm run check-deploy
   # ✓ payment proofs  credentials work — a signed request to cloud "your-cloud" was accepted
   ```

   It makes one read-only, signed request to Cloudinary, so it distinguishes
   *"credentials are fine"* from the two mistakes people actually make:

   | What you did | What the check says |
   |---|---|
   | pasted an old/rotated API secret | `✗ Cloudinary rejected the credentials (401)` + how to re-copy them |
   | typed the account email or API key as the cloud name | `✗ no Cloudinary cloud named "…" (404)` + which value to use instead |
   | configured nothing at all | `! Cloudinary not configured — proof uploads return 503` (not a failure) |

   On a deployment the same answer is one request away: `/api/health` reports
   `payment proofs: configured` (or `not configured (uploads and proof views
   return 503)`).

5. **Prove it end to end**: open a loan → **Record Payment** → attach a
   screenshot → save, then tap **🧾 View proof**. The image is stored privately
   and streamed back through the app; there is no public link (see the section
   above).

`CLOUDINARY_DELIVERY_HOST` is optional - set it only if your account serves
assets from a custom domain or a proxy. The free plan (25 monthly credits,
managed storage) is far more than proofs need: each one is a ~100 KB JPEG after
the app's 1600px resize, so tens of thousands fit comfortably.

## 🛡️ Security headers, and the health endpoint

Every response carries the same header set: a Content-Security-Policy that
allows no third-party scripts and no `eval`, HSTS (two years), `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that
turns off the cameras, microphones, geolocation and payment APIs the app never
uses, `Cross-Origin-Resource-Policy: same-origin`, and no `X-Powered-By`.

They are set in `next.config.ts`, so they apply to pages and API responses
alike, in every environment - there is nothing to turn on.

### Where the app may be framed (`FRAME_ANCESTORS`)

`frame-ancestors` is the one header that is *not* runtime configuration:
Next.js bakes it into the routes manifest **at build time**. Changing it on a
running server has no effect at all.

```powershell
# Local build that a workspace preview is allowed to frame
$env:FRAME_ANCESTORS="'self' https://*.e2b.app"; npm run build; npm run start
```

The default is `'none'` - nobody may frame the app - and when it is exactly
`'none'` the app also sends `X-Frame-Options: DENY` for older browsers. Set it
in whatever builds your image (a Docker build arg, the CI job, your host's build
command), not in the running service's environment.

### Seeing the full health detail (`HEALTH_TOKEN`)

`/api/health` is public by design: an uptime ping and the deploy verifier both
call it without credentials, and both need the verdicts. What they do *not* need
is the database host, which integrations are configured, or the sentence that
says the dummy OTP is `123456` for every number.

So the public body has the verdicts (`ok`, `checks[].status`, `firstProblem`),
a plain `set` / `up to date` / `not configured`, and - importantly - the
**remedy** for anything that failed, because that is what makes a red CI run
actionable:

```jsonc
// anonymous, with the database unreachable
{ "ok": false, "firstProblem": "database connection",
  "action": "The database is unreachable — on Render's free tier a Postgres
             instance is deleted 30 days after creation...",
  "checks": [{ "name": "database connection", "status": "fail",
               "detail": "hidden - send the health token for the full detail",
               "fix": "The database is unreachable — ..." }] }
```

Set `HEALTH_TOKEN` on the service (a long random string) and send it as
`x-health-token` to get the real detail - the host, the error text, which
integrations are set. Without the variable set, *nobody* sees the detail, and a
wrong token is indistinguishable from no token. It is compared in constant time,
so it cannot be guessed one character at a time.

```powershell
curl -s -H "x-health-token: $env:HEALTH_TOKEN" https://your-app/api/health
```

The deploy workflow deliberately verifies the deployment **anonymously**, on the
same view any stranger gets, and that view names the fix - so a failed deploy
prints the reason without a secret having to exist in the repository.

## 🚢 Deployment notes

- **The database is migrated at boot, and the boot says what it did.** Every
  boot runs `node scripts/migrate-at-boot.mjs` first (`render.yaml`'s start
  command and the container entrypoint both do it), which retries three times -
  a suspended Neon database can refuse the first connection while it wakes - and
  writes what happened to `MIGRATION_REPORT_PATH`
  (`/tmp/udhaar-migration-report.json` by default). When the schema is behind,
  `/api/health` reads that file back and says **which of four things happened**:

  | `/api/health` says | What it means | What to do |
  |---|---|---|
  | `no report - the host may not be migrating at start-up` | the start command is not running the script | fix the host's start command, or run `npm run db:migrate` once |
  | `the boot migration failed: <reason>` | it ran and could not connect (or DDL failed) | the reason is in the line: unreachable host, refused password, and so on |
  | `applied ... yet this app still cannot see it` | it migrated a *different* database | compare `DATABASE_URL` on the service with the one the migration used |
  | `found nothing to apply, yet the schema is behind` | the journal claims a migration that never ran | `npm run check-deploy` names every missing table and column |

  The reason itself is detail, so it is only shown to a caller who sends the
  health token; the public line stays generic and carries the fix.
- **A data export never fails wholesale.** `GET /api/account/export` reads whole
  rows, so a column added by a migration the database has not applied would
  otherwise turn "download my data" into a 503 for every account with a loan -
  which is exactly what happened on 2026-10-15. Each section is now fetched
  independently: whatever cannot be read is named in the payload's `warnings`
  array and the rest still exports. The data is not lost, and the export says so
  rather than silently returning less.
- **A deploy is not finished until the app says it is.** The `verify-production`
  job in `deploy-web.yml` polls the deployed `/api/health` until it reports the
  commit that was just released *and* a healthy schema, and fails the workflow
  (printing every check that failed, and the command that fixes each) if that
  does not happen within 15 minutes.
- **A failure that cannot heal fails fast.** Migrations run *before* the server
  starts, so once the released commit is answering traffic its migration has
  either been applied or given up - waiting the remaining fourteen minutes only
  reaches the same conclusion more slowly. If that commit is live and its
  `schema` check is red, the verifier gives it `SCHEMA_FAIL_FAST_MS` (two
  minutes) and then fails with the reason and the one-off command that heals it.
  A database that is merely unreachable is *not* treated this way (`schema` is
  `skip` then, not `fail`) because that can come good on its own. Set
  `SCHEMA_FAIL_FAST_MS=0` to wait the whole timeout as before. Observed on
  2026-10-15: a 15-minute red run whose conclusion was already certain after 70
  seconds.
- **An app that cannot name its commit is a failure, not a warning.** Until
  2026-10-14 the verifier printed a warning and exited **0** when the deployed
  app answered healthy without a commit - and `/api/health` never actually put
  the commit in its response in the first place, so *every* deploy took that
  branch. A release merged to `main` could therefore look verified while the
  previous build was still serving. Now: the route reports `commit` /
  `shortCommit` (in the failing 503 body too), the image bakes the release in as
  `GIT_COMMIT` for hosts that do not inject one themselves, and a healthy body
  without a commit **fails** the job with the reason. If a host genuinely cannot
  stamp a build, set `ALLOW_UNSTAMPED=1` on the job to downgrade it back to a
  warning - deliberately explicit, so it cannot be silent. This exists because of a real outage: on
  2026-10-14 the borrower-side release went live on Render with its migration
  never applied - every loan screen answered 503 while every workflow on `main`
  was green. Run the same check by hand against any deployment:

  ```powershell
  $env:PRODUCTION_URL="https://udhaar-y94f.onrender.com"
  npm run verify:deployment
  ```

  It needs no secrets: `/api/health` is public and deliberately vague about
  everything except what is broken.
- **Every start path applies its own migrations.** `render.yaml`'s start command
  runs `scripts/migrate-at-boot.mjs` before the server, and the Docker image does
  the same through `docker-entrypoint.sh` (the image used to start with a bare
  `node server.js`, which is how a container can serve new code against an old
  schema). Both run the baseline check and then `db:migrate`, are no-ops once
  applied, and *report* rather than block: a database that is behind leaves the
  app running with `/api/health` naming the missing column.
- **Static assets with `output: standalone`.** Next.js does *not* copy
  `.next/static` or `public/` into `.next/standalone`, so any start command that
  runs `node .next/standalone/server.js` must stage them first (the Dockerfile
  and `render.yaml` both do). Skipping this serves HTML with no CSS or JS.
- **Apply the migrations on a fresh database.** `npm run db:migrate` runs the
  SQL in `drizzle/` (generated from `src/db/schema.ts`). CI applies them to an
  empty Postgres, and `render.yaml` runs `db:baseline && db:migrate` on every
  boot — a no-op once applied. The baseline step matters on a database that
  predates the journal (created by `db:push`): it records the migrations whose
  objects actually exist and verifies the rest, so `db:migrate` has only the
  genuinely missing ones to apply. On a fresh database it does nothing at all.
  A start-command change in `render.yaml` reaches an existing service on the
  next Blueprint sync (Dashboard → Blueprints → Sync), or edit the Start Command
  in the service's Settings directly.
- **Render owns deploys on `main`.** Render's own **Auto-Deploy** is the single
  main-branch path - one push, one deploy. The `deploy-render` job in
  `deploy-web.yml` deliberately does *not* cover `main` any more (it did, and
  each commit queued two deploys of identical code); it is reserved for what
  Render cannot do itself: deploy a `v*` **tag** (a release) or a manual run
  from the Actions tab. Keep Auto-Deploy **on** in the service's Settings -
  with it off, pushing to `main` would deploy nothing. The Docker image still
  builds on every `main` push, since a `main`-tagged image is an artifact
  people pull; building is not deploying.
  `/api/health` verifies this for you: it names any migration column that is
  still missing (a database without migration 0005 reports `missing columns:
  installments.principal_waived, …` and answers **503**), so "did the
  migrations run in production?" is one web request, not a guess. It also
  reports the commit the app is running (`commit` / `shortCommit`, from
  `RENDER_GIT_COMMIT`, `GITHUB_SHA`, the image's `GIT_SHA` build arg or
  `GIT_COMMIT`), which is how the verification job tells the new container apart
  from the old one.

  **If a release ever goes out ahead of its migration** - the app answers, but
  the loan screens say *"The database is missing a column this version of the
  app needs"* - apply it from anywhere using the database URL (Render dashboard
  → service → Environment → `DATABASE_URL`; never paste it into a chat or a
  commit):

  ```powershell
  cd C:\Users\gaura\OneDrive\Desktop\learn\udhaar
  git pull
  $env:DATABASE_URL="postgresql://…from the host's dashboard…"
  npm run db:baseline
  npm run db:migrate
  npm run check-deploy      # should end with "Ready."
  ```

  Then confirm from the outside: with `PRODUCTION_URL` set,
  `npm run verify:deployment` should print **"✓ the released commit is live and
  healthy"**.
- **Don't use Render's free Postgres for real data.** Free instances are
  deleted 30 days after creation, with no backups: that is what silently broke
  production login once. Use any external Postgres (Neon, Supabase, Aiven) and
  set `DATABASE_URL` in the host's dashboard.
- **Run `npm run check-deploy` before blaming the app.** It distinguishes a
  missing environment variable from an unreachable database from a missing
  schema, and prints the command that fixes each.
- **Workflow actions are on the Node 24 line.** `checkout@v7`, `setup-node@v7`,
  `setup-java@v6`, `upload-artifact@v7`, `download-artifact@v8`,
  `docker/*@v4–v7`, `action-gh-release@v3`, `setup-android@v4`. GitHub retires
  the older Node runtimes on its own schedule and warns for months first — if a
  workflow ever starts printing "…targets Node.js 20…", that action is the one
  to bump (`gh api repos/<owner>/<repo>/releases/latest`).
- **`OTP_MODE`.** Set it deliberately on every deployment: `auto` (default)
  fails closed in production until MSG91 is configured, `dummy` opts into the
  insecure-but-testable code.
- **Render / Fly / Vercel.** `render.yaml` and `Dockerfile` are kept working;
  `vercel.json` is a plain Next.js config, so any of them works as long as the
  two points above are handled.

## 🔧 GitHub Secrets (Required for Mobile Builds)

Go to **Settings → Secrets and variables → Actions**

| Secret | Used by | Notes |
| --- | --- | --- |
| `CRON_SECRET` | reminders sweep | same value as the one set on the service |
| `ANDROID_GOOGLE_SERVICES_JSON` | Android build | base64 `google-services.json`; without it the APK can't receive push |

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
│   ├── reminders.yml       # Daily reminder sweep (free cron)
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
│   │   ├── profile/        # Settings (incl. per-device notification toggle)
│   │   └── api/            # Backend routes
│   ├── components/         # UI components
│   ├── hooks/              # React hooks (native bridge)
│   ├── lib/                # Business logic (calculations, payments, auth,
│   │                       #   validation, input/http helpers)
│   └── db/                 # Database schema
├── drizzle/                # Generated SQL migrations + journal
├── scripts/                # dev-db.mjs (local Postgres), check-deploy.mjs,
│                           #   baseline-migrations.mjs, generate-vapid-keys.mjs
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
