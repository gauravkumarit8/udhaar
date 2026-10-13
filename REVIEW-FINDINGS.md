# Udhaar — Code Review Findings

> **Status:** fixed in PR #5 (branch `arena/ea943d9f-udhaar`) plus a second
> pass on branch `arena/f92976fc-udhaar`.
>
> | Fixed | Still open |
> |-------|-----------|
> | **C1, C2** (sessions, OTP_MODE incl. explicit dummy mode) | Low: Capacitor remote-URL shell (`server.url` points at the hosted app) |
> | **H1–H6** (FK 500s, payment allocation, 2-side dead-end, Render static assets, release workflows, lint/CI) | |
> | **M1–M8, M10, M11, M13, M14** | |
> | **M9** — server-side scheduled reminders: `POST /api/reminders/run` + the free `.github/workflows/reminders.yml` clock (09:00 IST daily), `CRON_SECRET`-guarded, idempotent per EMI per day via `reminders.dedupe_key` | |
> | **M12** — SQL migrations now exist in `drizzle/`, generated from `schema.ts`, applied by CI and by the deploy boot command; `scripts/baseline-migrations.mjs` adopts an existing `db:push` database | |
> | **Notifications** — every money event tells the other side (`src/lib/notify.ts`): payment marked / recorded / confirmed / rejected, loan added, loan claimed at signup, loan edited (schedule rebuilt or payment details changed), loan closed; `GET /api/notifications` is scoped per person via `reminders.recipient_id` (migration 0002), and a notification can never fail the payment that caused it | |
| Low: unbounded amount/rate/tenure validation → `src/lib/validation.ts` (NaN, negatives, `numeric(12,2)` overflow, impossible dates, 100M-month tenures all rejected; live-tested) | |
> | Low: unvalidated `proofUrl` → must now be an https URL on the app's own Cloudinary account | |
> | `/api/health` now diagnoses *which* layer is broken (env var / connection / schema / OTP / integrations) and names the fix; `npm run check-deploy` does the same from a terminal | |
> | API routes are wrapped (`src/lib/api-handler.ts`): a database outage now returns `503 {error, action, reference}` JSON instead of an empty 500, and the login screen shows that text instead of "Something went wrong" | |
>
> M9 was verified against a production build with 12 seeded EMIs spanning the
> whole window: it picked exactly T-2/T-1/T0 and overdue days 1-7, and skipped an
> EMI 3 days early, one 8 days late, a settled EMI, a closed loan and a borrower
> with no account. **Six sweeps fired simultaneously wrote 7 rows in total** (one
> per EMI, no duplicates); a second sweep the same day sent nothing while the
> next day's did. `CRON_SECRET` unset → 503, wrong secret → 401, `?dryRun=1`
> plans without writing, and a database missing migration 0001 → 503 naming the
> missing column and the command that fixes it.
>
> Verification for the second pass: `67` unit tests, `tsc` clean, `eslint`
> clean, `next build` green, migrations diffed against `drizzle-kit push`
> output on two fresh databases, and every failure mode exercised against a
> production build (deleted DB host, refused port, empty schema, unset
> `DATABASE_URL`).
>
> Notifications were verified the same way — against a live server over HTTP,
> not by reading the code: a lender adds a loan for a registered borrower; the
> borrower marks a payment and the lender is asked to confirm; the lender
> confirms (borrower told), rejects (borrower told), and edits the terms
> (borrower told the schedule was rebuilt); a loan paid in full reports "the
> loan is settled" and a second `close` is a no-op instead of a duplicate
> notice; and a loan recorded for a mobile number with no account is announced
> the moment that person signs up. Each side's feed was checked to contain only
> what was addressed to it. On a database still missing migration 0002 the loan
> is created anyway (201) while the feed answers 503 naming the column and the
> fix — the notification failure is logged, never surfaced as a failed payment.
> The rest of this document is the original review, kept as written.

**Reviewed:** `main` @ `4219ee8` (working branch `arena/ea943d9f-udhaar`)
**Scope:** full repo — 39 TypeScript files / ~5.7k LOC in `src/`, 15 API routes, 7 pages, Capacitor mobile layer, 5 GitHub Actions workflows, deploy configs.
**How it was verified:** `npm install` + `npx tsc --noEmit` + `npx next build` + `npx eslint .` run locally; the EMI engine (`src/lib/calculations.ts`) executed directly under 3 different `TZ` values and checked against closed-form EMI values; GitHub Actions run history inspected via `gh`.

---

## TL;DR

This is a well-shaped, genuinely functional MVP: strict TypeScript, clean API-route structure, server-side authorisation on every route, and a nice mobile-first UI with Capacitor bridges and web fallbacks. `tsc` and `next build` are green.

But it is **not safe to put in front of real users yet**. Three things stand out:

1. **Auth is a forgeable cookie.** The session cookie is the *raw user UUID* — no signature, no server-side session. Any user who shares a loan with you receives your `lenderId`/`borrowerId` in the API payload and can set `udhaar_session=<your uuid>` to become you.
2. **Production auth is bypassable by design right now.** `send-otp` returns the OTP in the HTTP response whenever MSG91 isn't configured — and the deployed config (`render.yaml`, `.env.example`) never sets the MSG91 vars. As configured, anyone can log in as any mobile number.
3. **Core flows break on real data.** Editing a loan that already has a reminder row throws a foreign-key error (500); the payment split silently drops money from the ledger; 2-side loans with an unregistered borrower get permanently stuck. The EMI engine also produces wrong dates for loans starting on the 29th–31st.

Plus hygiene gaps that will bite later: **zero tests**, `npm run lint` fails with 10 errors, the `v*` release pipeline can't work as written, and the Render deploy command is missing static assets.

---

## What's in good shape

- **Authorisation is actually enforced server-side** — every route re-checks the session and the lender/borrower relationship (`loans/[id]/route.ts:26`, `pay/route.ts:52`, `remind/route.ts:35`, `payments/[id]/confirm/route.ts:39`). Most MVPs forget this; this one doesn't.
- **Sensible defensive touches already present:** OTP expiry + attempt lockout + 30 s resend cooldown (`send-otp/route.ts:22-33`, `verify-otp/route.ts:37-55`), overpayment rejection with a helpful message (`pay/route.ts:63-72`), schedule edits blocked once money has moved (`loans/[id]/route.ts:135-145`), base64 blobs pushed to Cloudinary instead of Postgres (`lib/storage.ts`), stale FCM tokens cleaned up (`lib/push.ts:85-95`), graceful no-op when SMS/Firebase/Cloudinary aren't configured.
- **Clean layering:** `lib/` = business logic, `db/schema.ts` = one readable source of truth, API routes = thin controllers, `native.ts` = one Capacitor boundary with browser fallbacks.
- **Build is healthy:** `tsc --noEmit` clean, `next build` succeeds (17 routes), Docker image builds in CI, web + Android workflows are green on `main`.

---

## Findings

### 🔴 Critical

#### C1. Session cookie is an unsigned, forgeable user ID → account takeover
`src/lib/auth.ts:12-38`

```ts
cookieStore.set(SESSION_COOKIE, userId, { httpOnly: true, ... })   // raw UUID
// getSession(): eq(users.id, userId)  <-- whatever the client sent
```

The cookie *is* the identity. There is no signature, no server-side session row, no rotation. A UUID is unguessable *in isolation* — but the app hands it out:

- `GET /api/loans` returns full loan rows (`db.select().from(loans)`) including `lenderId` and `borrowerId` (`loans/route.ts:15-22`).
- `GET /api/loans/[id]` returns the same, to both parties (`loans/[id]/route.ts:22-26`).

So: borrower B opens a loan → reads `lenderId` from the JSON → sets `udhaar_session=<lenderId>` in devtools → is now lender A, with full power to edit/delete loans, record payments, and close them. The same works in reverse.

**Fix:** store a random 256-bit session token in a `sessions` table (or sign the cookie with an HMAC secret), resolve the user server-side, and support revocation on logout. Never treat a client-supplied value as an authoritative user id. While you're there, validate that the cookie looks like a UUID (see M7).

#### C2. OTP is returned in the API response whenever SMS isn't configured — and prod isn't configured
`src/app/api/auth/send-otp/route.ts:52-60`, `src/lib/sms.ts:3-21`

```ts
if (result.sent) return NextResponse.json({ success: true, message: "OTP sent" });
return NextResponse.json({ success: true, message: `... dev mode ...`, devCode: code });
```

`result.sent` is false whenever `MSG91_AUTH_KEY` / `MSG91_FLOW_ID` are missing — and those variables appear **nowhere** in `.env.example` or `render.yaml`. So a deploy that follows the repo's own instructions silently runs in "hand me the OTP" mode: `POST /api/auth/send-otp {"mobile":"<victim>"}` → read `devCode` → `POST /api/auth/verify-otp` → you are that user. Combined with C1 there is effectively no auth boundary.

**Fix:** gate the echo behind `process.env.NODE_ENV !== "production"`, and in production fail closed (500 + loud log) if SMS isn't configured. Add `MSG91_*` to `.env.example` and to `render.yaml` so the failure is visible at deploy time.

---

### 🟠 High

#### H1. Editing a loan that has any reminder row fails with a 500 (foreign key)
`src/app/api/loans/[id]/route.ts:118-190`

When the schedule changes (amount/rate/period/tenure/start date), the route does:

```ts
hasProgress = existingInstallments.some(paid > 0)   // only checks MONEY
if (scheduleChanged && hasProgress) reject
...
await tx.delete(installments).where(eq(installments.loanId, id));
```

But `reminders.installmentId` and `payments.installmentId` both have hard FKs to `installments` with no `ON DELETE CASCADE` (`db/schema.ts:83-84` payments, `:104-105` reminders). So:

- `POST /api/loans` writes a reminder row for EMI #1 whenever the borrower already has an account (`loans/route.ts:121-140`).
- Also `POST /api/installments/[id]/remind` writes one on every "🔔 Remind" tap.
- Now the lender fixes a typo'd amount → `DELETE FROM installments` → `23503 foreign key violation` → unhandled → 500, and the UI shows "Something went wrong while updating the loan" with no clue why.

**Fix:** add `onDelete: "cascade"` to both FKs (and to `installments.loanId`), delete child rows explicitly inside the same transaction, and extend the guard to "has progress **or** has reminders/payments".

#### H2. The payment split silently discards money — ledger and audit trail disagree
`src/app/api/installments/[id]/pay/route.ts:63-85`

The overpayment guard only compares against the **EMI total**:

```ts
if (payAmount > totalRemaining + EPSILON) reject;
if (paymentType === "principal") principalPayment = Math.min(payAmount, principalRemaining);
```

…then the `payments` row is written with the raw `payAmount`. The two can disagree. Verified with the real logic:

| scenario (EMI: principal ₹1000, interest ₹100) | accepted? | applied to ledger | recorded in `payments` | lost |
|---|---|---|---|---|
| pay **₹1100** as "Principal" | ✅ | ₹1000 principal | ₹1100 | **₹100** |
| principal already paid, pay **₹100** as "Principal" | ✅ | ₹0 | ₹100 | **₹100** |
| interest already paid, pay **₹1000** as "Interest" | ✅ | ₹0 | ₹1000 | **₹1000** |

Result: the EMI never reaches `paid`, the borrower's payment history says they paid, and the loan can't auto-close. The comment at line 55-62 explicitly says this class of drift was fixed — the per-bucket case was missed.

**Fix:** validate against the *selected bucket's* remaining amount, or auto-route the excess (interest → principal) and return what was actually applied. Reject when `applied === 0`.

#### H3. 2-side loans with an unregistered borrower can never be confirmed
`src/app/api/payments/[id]/confirm/route.ts:43-47`, schema `loans.borrowerId` nullable

In `2-side` mode a marked payment starts `pending` and only updates the ledger once confirmed. But:

- the marker can't confirm their own payment (`payments/.../confirm:43`);
- if `borrowerId` is `NULL` (borrower hasn't signed up — the normal case for a lender adding a loan for a friend), **the lender is the only party**.

⇒ the payment is stuck `pending` forever, the EMI stays unpaid, and there's no cancel/undo path. Default is `1-side` so it isn't hit by every loan, but it's a hard dead-end for anyone who picks "2-Side" before the borrower installs the app.

**Fix:** block `2-side` until the borrower is linked (grey it out in the wizard), or let the marker confirm when the counterparty has no account, flagging it as self-confirmed in `notes`.

#### H4. The Render deploy command serves the app without CSS/JS (and with no tables)
`render.yaml:6-7`

```yaml
buildCommand: npm ci && npm run build
startCommand: node .next/standalone/server.js
```

`output: "standalone"` does **not** copy static assets into the standalone folder — verified: `.next/standalone/.next/` contains `server/` and manifests but **no `static/`** (the Dockerfile compensates with an explicit `COPY --from=builder /app/.next/static ./.next/static`, and `public/` too). On Render the HTML will 404 every JS/CSS chunk.

Second problem: nothing runs migrations. There's no `drizzle/` migrations folder, CI runs `drizzle-kit push` but deploys never do — a fresh Render/Fly/Vercel database comes up with zero tables.

**Fix:** either add `cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/` to the build command, or drop `output: standalone` for the Render target; and add a real `drizzle-kit generate` + `migrate` step to the deploy.

#### H5. The `v*` release pipeline cannot run as written
`.github/workflows/release.yml:8-30`

```yaml
release-web:     uses: ./.github/workflows/deploy-web.yml
release-android: uses: ./.github/workflows/build-android.yml
                 with: { build_type: debug, app_url: ... }
release-ios:     uses: ./.github/workflows/build-ios.yml
```

Reusable workflows require an `on: workflow_call:` trigger (with declared `inputs`). **None of the three called workflows declares `workflow_call`** — they only have `push`/`workflow_dispatch`. The first `v*` tag will fail validation; no tag has ever been pushed, so this has never run.

Related CI observations from `gh run list`:
- **iOS build is red on every push to `main`** — it fails at `🔑 Install Apple Certificate` (`gh api .../jobs` shows the failure; the `IOS_P12_*`/`APPLE_TEAM_ID` secrets aren't set) and then skips everything else. It also runs on *every* push to `main`, which is pure noise.
- `build-android.yml` likewise builds a full APK on every push to `main`.
- The workflow is named "CI — Lint, Typecheck, Build" but **never runs lint** (see H6).

**Fix:** add `on: workflow_call:` + `inputs` to the three workflows (or inline the steps into `release.yml`), scope mobile builds to tags/manual dispatch, and make the iOS job conditional on the secrets existing.

#### H6. `npm run lint` fails; CI doesn't run it
`npx eslint .` → **10 errors, 3 warnings** (build and typecheck are clean):

| File | Problem |
|---|---|
| `dashboard/page.tsx:73,110` | `react-hooks/set-state-in-effect` (setState directly in effect body) |
| `hooks/useNative.ts:30`, `MobileShell.tsx:38` | same rule |
| `dashboard/page.tsx:229,327`, `Navbar.tsx:34,68` | `@next/next/no-html-link-for-pages` — `<a href>` instead of `<Link>` |
| `loans/[id]/page.tsx:119` | `loadData` accessed before declaration (`useCallback` referencing a `const` defined below) |
| `ProofUpload.tsx:72` | `<img>` warning |
| `lib/native.ts:21` | stale `eslint-disable` directive |

**Fix:** add `npm run lint` to `ci.yml` (it's in the workflow name, after all) and clear the 10 errors.

---

### 🟡 Medium

#### M1. EMI dates are wrong for loans starting on the 29th–31st, and depend on the server timezone
`src/lib/calculations.ts:166-170`

```ts
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + months);      // Jan 31 + 1 → "Feb 31" → Mar 3
  return d.toISOString().split("T")[0];   // local midnight → UTC, can shift a day back
}
```

Executed the real function:

| start date | due dates produced (TZ=UTC) |
|---|---|
| 2026-01-15 | 02-15, 03-15, 04-15, 05-15 ✅ |
| **2026-01-31** | **03-03**, 03-31, **05-01**, 05-31 ❌ (no Feb, no Apr) |
| **2026-03-31** | **05-01**, 05-31, **07-01**, 07-31 ❌ (April skipped) |

And the same call under `TZ=Asia/Kolkata` returns `2026-02-14, 03-14, …` for the 01-15 case — **every EMI one day early**, i.e. the schedule silently depends on the host timezone (a dev machine in IST won't reproduce production UTC dates).

**Fix:** clamp to the last day of the target month (`Math.min(day, daysInMonth)`), build dates with `Date.UTC`/`date-fns`-style arithmetic, and format with `toISOString()` only on a UTC-constructed date.

#### M2. Rounding drift between the schedule total and the loan principal
Verified with the real engine: ₹1,00,000 @ 12% / 12 months → schedule principal sums to **₹1,00,000.01**; ₹10,000 @ 2%/mo / 6 months → **₹9,999.99**. Closed-form EMI and total interest match to ~2 paise, so the math is right — it's `roundTo2` applied per row (`calculations.ts:90`) without a reconciliation sweep. Also `interestAmount = Math.max(0, principalAmount + interestAmount - principalAmount)` on the final row (`calculations.ts:87`) is a no-op. Fix by carrying the residual into the last installment so the schedule sums exactly to the principal.

#### M3. "Due This Week" on the dashboard actually means "everything overdue, ever"
`src/app/api/dashboard/route.ts:92-99` — `return diff <= 7;` has no lower bound, so an EMI 8 months overdue is counted in "Due This Week (both sides)". Fix: `diff >= 0 && diff <= 7` and surface overdue as its own number.

#### M4. A loan can be closed with interest unpaid
`loans/[id]/close/route.ts:40-47` and `pay/route.ts:132-145` only compare **principal**, while `computeInstallmentStatus` requires principal *and* interest (`calculations.ts:144`). So the app will happily close a loan and still render an EMI as "overdue"/unpaid. Decide which rule wins and make both paths agree (and cancel pending reminders on close).

#### M5. The service worker caches authenticated API JSON
`public/sw.js:29-39` — the fetch handler caches *every* GET response, including `/api/dashboard`, `/api/loans`, `/api/auth/me`, and serves the cache when offline. On a shared device that means the previous user's loan data survives logout; and cached API responses can be served as if fresh. Fix: bypass `event.request.url.includes("/api/")`, or use a network-first/stale-while-revalidate strategy with an explicit user-scoped cache that's purged on logout. (Note the identical `sw.js` at the repo root is dead weight — only `public/` is served.)

#### M6. PWA icons are missing → 404s
`public/manifest.json` and `src/app/layout.tsx:29` (`apple-touch-icon`) and `lib/native.ts:70,77` all reference `/icons/icon-192.png` and `/icons/icon-512.png`, but `public/` contains only `manifest.json` and `sw.js`. The install banner in `MobileShell` therefore advertises an install that has no icon, and notifications render without one.

#### M7. A malformed session cookie returns 500 instead of 401
`src/lib/auth.ts:20-30` passes the cookie straight into `eq(users.id, userId)` on a `uuid` column. `udhaar_session=abc` → Postgres `22P02 invalid input syntax for type uuid` → unhandled exception → 500 on every API route. Cheap to fix: regex-validate the UUID and treat anything else as "not logged in" (and wrap `getSession` in a try/catch).

#### M8. Push-token registration races and can hang forever
`src/lib/native.ts:160-185` — `await PushNotifications.register()` fires **before** `addListener("registration", …)` is attached, so a fast native callback is missed; and the returned promise has no timeout, so `usePushRegistration()` can leave a pending promise for the life of the session. Attach listeners first, then register, and add a timeout/fallback.

#### M9. "Smart T-2/T-1/T0 reminders" never reach the borrower
`lib/native.ts:92-142` schedules reminders **locally, on the device that taps "Remind"** — i.e. the lender's phone — with copy like `"Rahul owes ₹5,000"`. The README/Activity screen promise T-2/T-1/T0 delivery *to the borrower*; in reality that only happens through the FCM/SMS path, which is a single manual push triggered by the tap. Server-side scheduling (cron/queue + FCM/SMS) is needed to make the headline feature real. Worth flagging as a product/architecture gap rather than a bug.

#### M10. Reminder copy names the wrong person, claims a channel it didn't use
`src/app/api/installments/[id]/remind/route.ts:44,48-58,73`
- `"...for loan from ${loan.borrowerName}"` — the reminder is sent *to* the borrower, so it should name the **lender**.
- `channel` is accepted unvalidated and the row is written as `status: "sent"` even when only a push (or nothing) was actually delivered — the Activity feed then overstates what happened. Validate the channel against `push|sms|whatsapp` and record the real delivery outcome.
- The `upiLink` is string-concatenated without `encodeURIComponent` (the `generateUPILink` helper in `lib/calculations.ts:179-190` already does this correctly — use it).

#### M11. Profile notification settings do nothing
`src/app/profile/page.tsx:117-145` — `SettingToggle` is local `useState` only; nothing is persisted or read by the reminder logic, yet the UI implies real preferences (including "SMS Reminders" and "WhatsApp Reminders", which have no sender at all).

#### M12. No migration story
No `drizzle/` folder, no `drizzle-kit generate`/`migrate` anywhere; schema changes rely on someone remembering `drizzle-kit push`. `drizzle.config.json` duplicates `drizzle.config.ts` with a hard-coded localhost URL (the `.ts` file wins, so the JSON is dead config that will confuse whoever edits it next). The Dockerfile even copies `drizzle.config.json` into the image without using it. Committing generated SQL migrations and running them on deploy is the fix.

#### M13. Zero tests
No test runner, no `test` script, no test files — and the riskiest logic in the repo is pure, side-effect-free money math (`lib/calculations.ts`) that would take an afternoon to cover with the 3 cases above (zero-rate, yearly, monthly, month-end start, rounding residual). This is the cheapest quality win available.

#### M14. N+1 queries on the dashboard
`src/app/api/dashboard/route.ts:45-50` runs one `SELECT` per active loan inside a loop. Fine at MVP scale, but it's a single join/`inArray` away from being linear-time. `loans/[id]` similarly issues 3 sequential queries where 2 would do.

---

### 🔵 Low / cleanup

- **`Math.random()` for OTP codes** (`send-otp/route.ts:37`) — use `crypto.randomInt(100000, 1000000)`.
- **`otps` is never pruned** — every request inserts a row; nothing deletes expired ones. Add a cleanup (index on `mobile, created_at` would help too).
- **Unvalidated bounds** — `amount` and `interestRate` are unbounded in `POST/PATCH /api/loans`; `numeric(12,2)` / `numeric(5,2)` overflow → 500 instead of a 400.
- **`proofUrl` is accepted as an arbitrary string** from the client (`pay/route.ts:35`) — it's rendered as an `<img src>`; restrict to your Cloudinary host.
- **Cloudinary proofs are public objects** — anyone holding the URL can view someone's payment screenshot. Consider signed/private delivery or an auth-gated proxy.
- **Template leftovers:** `package.json` name is `nextjs-postgresql-template`; `src/db/index.ts:8` uses `__arenaNextJsPostgresqlPool`; `src/components/Navbar.tsx` is exported but imported nowhere (dead code); root `manifest.json` + root `sw.js` duplicate `public/`; `.dockerignore` only excludes `docker-compose.yml`, so `node_modules/` and `.next/` are shipped into the Docker build context.
- **Docs drift:** README says "OTP: `123456`" (it's random + `devCode` now), badges still contain literal `${GITHUB_REPOSITORY}` / `YOUR_USERNAME` placeholders, and neither README nor `.env.example` mentions `MSG91_AUTH_KEY`/`MSG91_FLOW_ID` even though the code depends on them (see C2).
- **`loans/new` preview uses `setTimeout(calculatePreview, 50)`** reading stale closure state (`new/page.tsx:64,247,284,298`) — the EMI preview can lag a keystroke behind. A `useMemo` over the form state is both simpler and correct.
- **`payments/[id]/confirm` runs a dead query** (`confirm/route.ts:93-99` — `result` is selected and never used).
- **`handleConfirmPayment` ignores the response** (`loans/[id]/page.tsx:309-320`) — a 403 from the "can't confirm your own payment" rule silently does nothing.
- **Capacitor app is a remote-URL shell** — `capacitor.config.ts` hard-codes `server.url: "https://udhaar-y94f.onrender.com"` and `webDir: "public"` (which contains no `index.html`), so the "native app" is entirely dependent on that one deployment and has no offline story, while both build workflows rewrite the URL by regex.
- **`mobile-build.sh` chained commands don't do what they look like**: `npx cap copy android 2>/dev/null || npx cap add android && npx cap copy android` parses as `(A || B) && C`, not "if not added, add then copy".
- **`vercel.json` uses the legacy `@database_url` reference** while README lists four deploy targets (Docker/Render/Fly/Vercel) — pick one primary path and make it the documented, tested one.
- **`deploy-web.yml` sets `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION: true`** to work around a runner issue — worth removing once the underlying action is updated.

---

## Evidence log

```
$ npx tsc --noEmit                      # exit 0 — clean
$ npx next build                        # ✓ compiled, 17 routes, no errors
$ npx eslint .                          # ✖ 13 problems (10 errors, 3 warnings)
$ gh run list --limit 10                # Build iOS IPA: failure on main (x2); CI/Android/Deploy: success
$ gh api .../runs/33512645494/jobs      # iOS fails at step "🔑 Install Apple Certificate"
$ ls .next/standalone/.next             # BUILD_ID, manifests, server/ — NO static/  → render.yaml is broken
$ grep -l workflow_call .github/workflows/*.yml   # no matches → release.yml is unusable
$ node (real calculations.ts)           # 2026-01-31 start → 03-03, 03-31, 05-01, 05-31   (months skipped)
                                        # TZ=Asia/Kolkata → every due date shifts a day earlier
$ node (real pay-route split logic)     # 3 of 3 mixed-bucket cases silently drop money
$ git log --all -p | grep -i secret     # no committed credentials found ✅
```

---

## Suggested order of work

1. **Stop the bleeding on auth** — server-side/signed sessions (C1), fail-closed OTP (C2). Nothing else matters until this is done.
2. **Fix the money paths** — per-bucket payment validation (H2), 2-side dead-end (H3), FK cascade on schedule edits (H1). These corrupt real records.
3. **Fix dates** — month-end clamping + UTC-safe arithmetic (M1), then lock the behaviour down with the first unit tests for `calculations.ts` (M13).
4. **Make deploys trustworthy** — Render static assets + migrations (H4), reusable workflows / tag-scoped mobile builds (H5), lint in CI (H6).
5. **Then polish** — dashboard semantics (M3), close-vs-interest rule (M4), SW cache scoping (M5), icons (M6), and the mobile/reminder architecture questions (M8–M11) once the foundation is solid.
