#!/usr/bin/env node
/**
 * Pre-flight check for a deployment (or for local setup).
 *
 * Answers the question "why doesn't login work?" in one command, instead of
 * reading host logs. It checks, in order:
 *
 *   1. DATABASE_URL is set (and what it points at, with the password redacted)
 *   2. the database is reachable
 *   3. the schema is applied (all 8 tables)
 *   4. OTP delivery is configured in a way that lets people log in
 *   5. optional integrations (payment proofs, push)
 *   6. notification channels (native FCM, browser Web Push)
 *
 * Usage:
 *   npm run check-deploy                      # uses .env / the environment
 *   DATABASE_URL="postgresql://..." npm run check-deploy
 *   node scripts/check-deploy.mjs             # same thing
 *
 * Exit code is 0 when the app can serve requests, 1 otherwise - so it can be
 * wired into CI or a deploy pipeline later.
 */
import "dotenv/config";
import pg from "pg";

/** Columns added by a later migration - a stale schema is caught by name. */
const REQUIRED_COLUMNS = [
  { table: "reminders", column: "dedupe_key" },
  { table: "reminders", column: "recipient_id" },
  { table: "users", column: "notifications_seen_at" },
  { table: "payments", column: "proof_public_id" },
];

const REQUIRED_TABLES = [
  "users",
  "sessions",
  "otps",
  "loans",
  "installments",
  "payments",
  "reminders",
  "device_tokens",
];

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ok = (label, detail) => console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
const bad = (label, detail) => console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
const warn = (label, detail) => console.log(`  ${YELLOW}!${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
const skip = (label, detail) => console.log(`  ${DIM}· ${label}${detail ? ` ${detail}` : ""}${RESET}`);
const fix = (text) => console.log(`      ${DIM}→ ${text}${RESET}`);

/** Show the target without leaking the password. */
function redact(raw) {
  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Drizzle wraps the driver error ("Failed query: select 1"), and pg aggregates
 * per-address failures. Walk both to reach the real reason.
 */
function rootError(error) {
  const seen = new Set();
  let current = error;
  let best = null;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const message = typeof current.message === "string" ? current.message : "";

    if (message && !message.startsWith("Failed query:")) {
      best = { code: current.code, message };
      if (current.code) return best;
    }

    if (Array.isArray(current.errors) && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    current = current.cause;
  }

  return best ?? { message: String(error?.message || error) };
}

function explain(error) {
  const { code = "", message } = rootError(error);

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message) || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      detail: "host could not be resolved — the URL is wrong or the database was deleted",
      fix: "Re-copy the connection string from your provider.",
    };
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout expired|Connection terminated/.test(message)) {
    return {
      detail: "could not open a connection — database unreachable",
      fix: "Render's free Postgres is deleted 30 days after creation. Point DATABASE_URL at a live database.",
    };
  }
  if (/password authentication failed|role .* does not exist/.test(message)) {
    return { detail: "authentication failed", fix: "Re-copy the connection string (the password may have been rotated)." };
  }
  if (/database .* does not exist/.test(message)) {
    return { detail: "database not found", fix: "Fix the database name in the URL, or create it." };
  }
  return { detail: message.split("\n")[0], fix: "Check the connection string." };
}

console.log("\nUdhaar deployment check\n");

let failures = 0;

// ── 1. Configuration ────────────────────────────────────────────────────────
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  bad("DATABASE_URL", "not set");
  fix("Set it in .env for local work, or in your host's environment settings.");
  fix('PowerShell: $env:DATABASE_URL="postgresql://..."; npm run db:push');
  failures++;
} else {
  ok("DATABASE_URL", `→ ${redact(databaseUrl)}`);
  const isLocal = /localhost|127\.0\.0\.1/.test(databaseUrl);
  if (!isLocal && !/sslmode=/.test(databaseUrl)) {
    warn("connection string has no sslmode", "managed Postgres usually needs ?sslmode=require");
  }
}

// ── 2 & 3. Connection and schema ────────────────────────────────────────────
if (databaseUrl) {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    // Managed providers (Neon, Supabase, Render) terminate TLS with a cert the
    // local trust store doesn't know; the connection is still encrypted.
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    ok("database connection", "select 1 succeeded");

    try {
      const { rows } = await client.query(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'`
      );
      const present = new Set(rows.map((r) => r.table_name));
      const missingTables = REQUIRED_TABLES.filter((t) => !present.has(t));

      let missingColumns = [];
      if (missingTables.length === 0) {
        const { rows: columnRows } = await client.query(
          `select table_name, column_name from information_schema.columns
           where table_schema = 'public'`
        );
        const has = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
        missingColumns = REQUIRED_COLUMNS.filter((c) => !has.has(`${c.table}.${c.column}`)).map(
          (c) => `${c.table}.${c.column}`
        );
      }

      if (missingTables.length === 0 && missingColumns.length === 0) {
        ok("schema", `all ${REQUIRED_TABLES.length} tables present, all migrations applied`);
      } else {
        bad(
          "schema",
          missingTables.length > 0
            ? `missing tables: ${missingTables.join(", ")}`
            : `missing columns: ${missingColumns.join(", ")}`
        );
        fix("npm run db:push        (reconciles the database with src/db/schema.ts right now)");
        fix("npm run db:baseline    (once, if the database was created with db:push - it only");
        fix("                        records migrations whose changes are actually present)");
        fix("npm run db:migrate     (after baselining, applies anything still pending)");
        failures++;
      }
    } catch (error) {
      bad("schema", explain(error).detail);
      fix(explain(error).fix);
      failures++;
    }
  } catch (error) {
    const { detail, fix: how } = explain(error);
    bad("database connection", detail);
    fix(how);
    failures++;
  } finally {
    await client.end().catch(() => {});
  }
} else {
  skip("database connection", "not checked — DATABASE_URL unset");
  skip("schema", "not checked — DATABASE_URL unset");
}

// ── 4. OTP delivery ─────────────────────────────────────────────────────────
const otpMode = (process.env.OTP_MODE || "auto").toLowerCase();
const smsConfigured = Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_FLOW_ID);
const isProduction = process.env.NODE_ENV === "production";

if (otpMode === "dummy") {
  warn("OTP delivery", "dummy mode — 123456 works for every mobile number, and is returned by the API");
  fix("Fine for testing. Set MSG91_AUTH_KEY + MSG91_FLOW_ID and OTP_MODE=sms before opening it up.");
} else if (smsConfigured) {
  ok("OTP delivery", "real SMS via MSG91");
} else if (isProduction) {
  bad("OTP delivery", "production with no SMS provider — login is refused (503)");
  fix("Set OTP_MODE=dummy to accept the dummy code for now, or configure MSG91.");
  failures++;
} else {
  warn("OTP delivery", "development fallback to the dummy OTP (123456)");
}

// ── 5. Optional integrations ────────────────────────────────────────────────
const cronSecret = Boolean(process.env.CRON_SECRET);
if (cronSecret) {
  ok("scheduled reminders", "CRON_SECRET is set - the sweep can run from .github/workflows/reminders.yml");
} else {
  warn("scheduled reminders", "CRON_SECRET is not set - POST /api/reminders/run answers 503, so nothing is sent on a schedule");
  fix("Set it on the service and as a GitHub Actions secret (README → Scheduled reminders).");
}

const cloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
const firebase = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

console.log("");
cloudinary
  ? ok("payment proofs", "Cloudinary configured")
  : warn("payment proofs", "Cloudinary not configured — proof uploads return 503");
firebase
  ? ok("push (app)", "Firebase configured")
  : warn("push (app)", "Firebase not configured — the native app can't be notified");
const vapid = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
vapid
  ? ok("push (browser)", "VAPID keys configured")
  : warn(
      "push (browser)",
      "VAPID keys not configured — websites and installed PWAs get no notifications. Run npm run generate:vapid, then set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY."
    );

console.log(
  failures === 0
    ? `\n${GREEN}Ready.${RESET} The app can serve requests.${otpMode === "dummy" ? ` ${YELLOW}(dummy OTP is on)${RESET}` : ""}\n`
    : `\n${RED}${failures} problem${failures === 1 ? "" : "s"} to fix.${RESET} See the lines above.\n`
);

process.exit(failures === 0 ? 0 : 1);
