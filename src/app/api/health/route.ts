import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { resolveBuildInfo } from "@/lib/build-info";

export const dynamic = "force-dynamic";

/**
 * Deployment health check.
 *
 * A bare `{"ok": false}` was genuinely hard to debug: it looked identical
 * whether the env var was missing, the database was unreachable, the tables
 * had never been created, or the app simply couldn't reach Postgres from the
 * host. This walks the chain in order and reports the first thing that's
 * actually broken, with the command that fixes it.
 *
 * The verdict is public on purpose: an uptime ping monitors it and the deploy
 * workflow checks it after every release. The *details* are not. A caller who
 * does not present `HEALTH_TOKEN` (their own header `x-health-token`) gets each
 * check's name and status and nothing else - no database host, no statement
 * about which integrations are configured, no explanation of the OTP mode. With
 * the token, the full diagnosis comes back as before.
 */

import { buildHealthReport, type HealthCheck as Check } from "@/lib/health-report";
import { readWhatsAppConfig, whatsappMissing } from "@/lib/whatsapp";

/** Columns added by a migration, so a stale schema is caught by name. */
const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "reminders", column: "dedupe_key" },
  { table: "reminders", column: "recipient_id" },
  { table: "users", column: "notifications_seen_at" },
  { table: "payments", column: "proof_public_id" },
  // Settlement (migration 0005). A database missing these still reports every
  // table as present, so without them here the endpoint would call a schema
  // healthy that cannot close a loan at all.
  { table: "installments", column: "principal_waived" },
  { table: "installments", column: "interest_waived" },
  { table: "payments", column: "unapplied_amount" },
  // Borrower-side entry (migration 0006). A database without these can still
  // serve the app's original direction, but every loan query selects them -
  // and the "I borrowed" screen writes them - so a half-migrated database has
  // to say so rather than 500 on the first loan the borrower records.
  { table: "loans", column: "created_by_user_id" },
  { table: "loans", column: "lender_name" },
  { table: "loans", column: "lender_mobile" },
];

/** The tables the app cannot run without. */
const REQUIRED_TABLES = [
  "users",
  "sessions",
  "otps",
  "loans",
  "installments",
  "payments",
  "reminders",
  "device_tokens",
  "whatsapp_opt_outs",
];

function describeDbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "(not set)";
  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}


/**
 * Drizzle wraps driver errors: the thrown message is just "Failed query:
 * select 1" and the real reason (ENOTFOUND, ECONNREFUSED, 28P01...) sits on
 * `cause`. pg additionally aggregates per-address errors. Walk both so the
 * diagnosis isn't reduced to "check the logs".
 */
function rootError(error: unknown): { code?: string; message: string; detail?: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let best: { code?: string; message: string; detail?: string } | null = null;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);

    const candidate = current as { code?: string; message?: string; errors?: unknown[]; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";

    // Ignore drizzle's own envelope when a richer error exists deeper down.
    if (message && !message.startsWith("Failed query:")) {
      best = { code: candidate.code, message, detail: String((candidate as { detail?: string }).detail ?? "") };
      if (candidate.code) return best;
    }

    if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      current = candidate.errors[0];
      continue;
    }
    current = candidate.cause;
  }

  return best ?? { message: error instanceof Error ? error.message : String(error) };
}

/** Turn a driver error into something actionable. */
function explainDbError(error: unknown): { detail: string; fix: string } {
  const { code = "", message } = rootError(error);

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message) || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      detail: `Database host could not be resolved: ${message}`,
      fix: "The hostname in DATABASE_URL is wrong, or the database was deleted. Re-copy the connection string from your provider (Neon: project → Connect).",
    };
  }
  if (/ECONNREFUSED|Connection terminated|ETIMEDOUT|timeout expired/.test(message)) {
    return {
      detail: `Could not open a connection: ${message}`,
      fix: "The database is unreachable — on Render's free tier a Postgres instance is deleted 30 days after creation. Point DATABASE_URL at a database that is still alive.",
    };
  }
  if (/password authentication failed|role .* does not exist/.test(message)) {
    return {
      detail: `Authentication failed: ${message}`,
      fix: "The username/password in DATABASE_URL is wrong or was rotated. Re-copy the connection string.",
    };
  }
  if (/database .* does not exist/.test(message)) {
    return {
      detail: `Database not found: ${message}`,
      fix: "The database name in DATABASE_URL doesn't exist on that host. Create it, or fix the path in the URL.",
    };
  }
  if (code === "42P01" || /relation .* does not exist/.test(message)) {
    return {
      detail: `Connected, but the tables are missing: ${message}`,
      fix: "npm run db:migrate   (or npx drizzle-kit push on an existing database)",
    };
  }
  return {
    detail: `Unexpected database error: ${message}`,
    fix: "Check the host's logs for the full stack trace.",
  };
}

/**
 * Is the caller allowed the full detail?
 *
 * `HEALTH_TOKEN` is optional: when it is unset nobody gets details (fail
 * closed), and when it is set the header must match exactly. The comparison is
 * constant-time so the header cannot be probed a byte at a time.
 */
function maySeeDetails(req: NextRequest): boolean {
  const expected = process.env.HEALTH_TOKEN;
  if (!expected) return false;

  const presented = req.headers.get("x-health-token");
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/*
 * Remedies, hoisted because each one is now said twice: to the owner (with the
 * real detail) and to everyone else (remedy only). They hold commands and
 * variable *names*, all of which are in the README - no hosts, no secrets.
 */
const SCHEMA_FIX =
  "npm run db:push   (reconciles the database with the schema in one step; or npm run db:baseline then npm run db:migrate)";
const OTP_FIX =
  "Set OTP_MODE=dummy to accept the dummy code for now, or configure MSG91_AUTH_KEY + MSG91_FLOW_ID.";
const REMINDERS_FIX =
  "Set CRON_SECRET on the service to a long random string, and add the same value as a GitHub Actions secret (see README → Scheduled reminders).";
const VAPID_FIX =
  "Run npm run generate:vapid and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY so browsers can be notified (README → Notifications).";

export async function GET(req: NextRequest) {
  const checks: Check[] = [];

  // 1. Is the app configured at all?
  const hasDbUrl = Boolean(process.env.DATABASE_URL);
  checks.push({
    name: "DATABASE_URL",
    status: hasDbUrl ? "ok" : "fail",
    detail: hasDbUrl ? `set → ${describeDbTarget()}` : "not set",
    // The host is infrastructure detail: "set" is all a stranger needs.
    publicDetail: hasDbUrl ? "set" : "not set",
    fix: hasDbUrl
      ? undefined
      : "Set DATABASE_URL on the service (Render → Environment) to your Postgres connection string.",
  });

  // 2 & 3. Can we actually query, and is the schema applied?
  if (hasDbUrl) {
    try {
      await db.execute(sql`select 1`);
      checks.push({
        name: "database connection",
        status: "ok",
        detail: "query succeeded (select 1)",
        publicDetail: "query succeeded (select 1)",
      });

      try {
        const result = await db.execute<{ table_name: string }>(sql`
          select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        `);
        const rows = (result as unknown as { rows?: { table_name: string }[] }).rows ?? [];
        const present = new Set(rows.map((r) => r.table_name));
        const missing = REQUIRED_TABLES.filter((t) => !present.has(t));

        // Columns, not just tables: a database created before a migration can
        // have every table and still be missing a column.
        let missingColumns: string[] = [];
        if (missing.length === 0) {
          const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
            select table_name, column_name from information_schema.columns
            where table_schema = 'public'
          `);
          const columnRows = (columns as unknown as { rows?: { table_name: string; column_name: string }[] }).rows ?? [];
          const has = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
          missingColumns = REQUIRED_COLUMNS.filter((c) => !has.has(`${c.table}.${c.column}`)).map(
            (c) => `${c.table}.${c.column}`
          );
        }

        const schemaProblems = [...missing, ...missingColumns];

        checks.push({
          name: "schema",
          status: schemaProblems.length === 0 ? "ok" : "fail",
          detail:
            missing.length > 0
              ? `missing table${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`
              : missingColumns.length > 0
                ? `missing column${missingColumns.length > 1 ? "s" : ""}: ${missingColumns.join(", ")}`
                : `all ${REQUIRED_TABLES.length} tables present`,
          // Present-or-not is the useful half; the names of what is missing
          // describe the schema to whoever asks.
          publicDetail: schemaProblems.length === 0 ? "up to date" : "not up to date",
          fix: schemaProblems.length === 0 ? undefined : SCHEMA_FIX,
          // The missing table/column names stay hidden (they describe the
          // schema); the command that fixes them is in the README.
          publicFix: schemaProblems.length === 0 ? undefined : SCHEMA_FIX,
        });
      } catch (error) {
        const { detail, fix } = explainDbError(error);
        // The remedy is public documentation; the error text (which names the
        // host) is not. Publishing the remedy is what lets the deploy verifier
        // print an actionable reason for a redacted failure - the 2026-10-14
        // outage was "schema: not up to date" with nothing to act on.
        checks.push({ name: "schema", status: "fail", detail, fix, publicFix: fix });
      }
    } catch (error) {
      const { detail, fix } = explainDbError(error);
      checks.push({ name: "database connection", status: "fail", detail, fix, publicFix: fix });
      checks.push({
        name: "schema",
        status: "skip",
        detail: "not checked - no connection",
      });
    }
  } else {
    checks.push({ name: "database connection", status: "skip", detail: "not checked - DATABASE_URL unset" });
    checks.push({ name: "schema", status: "skip", detail: "not checked - DATABASE_URL unset" });
  }

  // 4. Login configuration. This is a warning, never a failure: dummy mode is
  // a legitimate choice, it just isn't private.
  const otpMode = (process.env.OTP_MODE || "auto").toLowerCase();
  const smsConfigured = Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_FLOW_ID);
  const isProduction = process.env.NODE_ENV === "production";

  let otpDetail: string;
  let otpStatus: Check["status"] = "ok";
  if (otpMode === "dummy") {
    otpDetail = "dummy mode - the OTP is 123456 for every number, and is returned by the API";
  } else if (smsConfigured) {
    otpDetail = "real SMS via MSG91";
  } else if (isProduction) {
    otpStatus = "fail";
    otpDetail = "production with no SMS provider and no explicit OTP_MODE";
  } else {
    otpDetail = "development fallback to the dummy OTP";
  }

  checks.push({
    name: "OTP delivery",
    status: otpStatus,
    detail: `${otpMode} → ${otpDetail}`,
    // The mode is the part an owner reads at a glance; the sentence explaining
    // that any number can be logged into with 123456 is not for strangers.
    publicDetail: `mode: ${otpMode}`,
    fix: otpStatus === "fail" ? OTP_FIX : undefined,
    publicFix: otpStatus === "fail" ? OTP_FIX : undefined,
  });

  // 5. Optional integrations - informational only.
  const cloudinary = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
  );
  const push = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

  // 6. Scheduled reminders (M9). Not configured is a warning, not a failure:
  // the app works, borrowers just aren't nudged automatically.
  const cronSecret = Boolean(process.env.CRON_SECRET);
  checks.push({
    name: "scheduled reminders",
    status: cronSecret ? "ok" : "warn",
    detail: cronSecret
      ? "CRON_SECRET is set - the sweep can be triggered by .github/workflows/reminders.yml"
      : "CRON_SECRET is not set, so POST /api/reminders/run answers 503 and nobody is reminded automatically",
    publicDetail: cronSecret ? "set" : "not set",
    fix: cronSecret ? undefined : REMINDERS_FIX,
    publicFix: cronSecret ? undefined : REMINDERS_FIX,
  });

  // Browser push needs its own key pair; without it a website visitor can
  // never be notified, even though the native app's FCM credentials are set.
  const webPush = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  checks.push({
    name: "optional integrations",
    // Not a failure - the app works. But with neither channel configured,
    // nobody can be notified about anything, which is worth saying out loud.
    status: push || webPush ? "ok" : "warn",
    detail:
      `payment proofs: ${cloudinary ? "configured (private; served only through the app)" : "not configured (uploads and proof views return 503)"}, ` +
      `push (app): ${push ? "configured" : "not configured"}, ` +
      `push (browser): ${webPush ? "configured" : "not configured (websites can't be notified)"}`,
    fix: webPush || push ? undefined : VAPID_FIX,
    // Only the remedy, never the per-integration state above it: a stranger
    // learns what to run, not what is (or isn't) configured.
    publicFix: webPush || push ? undefined : VAPID_FIX,
  });

  /*
   * 7. WhatsApp reminders. Off is a legitimate choice (push and the lender's
   * one-tap share still work), but a half-configured provider is not: it looks
   * enabled and silently sends nothing.
   */
  const wa = readWhatsAppConfig();
  const waMissing = whatsappMissing(wa);
  if (wa.provider !== "meta") {
    checks.push({
      name: "whatsapp reminders",
      status: "ok",
      detail: "off - reminders go out by push, and by the lender's own one-tap WhatsApp share",
      publicDetail: "off",
    });
  } else if (waMissing.length > 0) {
    const fix = `Set ${waMissing.join(", ")} on the service (see README → WhatsApp reminders).`;
    checks.push({
      name: "whatsapp reminders",
      status: "fail",
      detail: `WHATSAPP_PROVIDER=meta but ${waMissing.join(", ")} ${waMissing.length > 1 ? "are" : "is"} not set, so no reminder would be sent`,
      publicDetail: "misconfigured",
      fix,
      publicFix: fix,
    });
  } else if (!wa.appSecret || !wa.verifyToken) {
    const missing = [!wa.appSecret ? "WHATSAPP_APP_SECRET" : null, !wa.verifyToken ? "WHATSAPP_VERIFY_TOKEN" : null]
      .filter(Boolean)
      .join(", ");
    const fix = `Set ${missing} and point Meta's webhook at /api/whatsapp/webhook. Without them, messages are sent but nothing learns whether they arrived, and STOP replies are not honoured.`;
    checks.push({
      name: "whatsapp reminders",
      status: "warn",
      detail: `sending works (template "${wa.templateName}", ${wa.templateLanguage}, up to ${wa.dailyMax}/day), but ${missing} is not set - delivery reports and STOP replies are off`,
      publicDetail: "configured (no delivery reports)",
      fix,
      publicFix: fix,
    });
  } else {
    checks.push({
      name: "whatsapp reminders",
      status: "ok",
      detail: `template "${wa.templateName}" (${wa.templateLanguage}), up to ${wa.maxPerRun}/run and ${wa.dailyMax}/day, delivery reports and STOP replies on`,
      publicDetail: "configured",
    });
  }

  const { status, body } = buildHealthReport(checks, resolveBuildInfo(), new Date(), {
    redact: !maySeeDetails(req),
  });

  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
