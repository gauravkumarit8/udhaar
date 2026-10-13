import { db } from "@/db";
import { sql } from "drizzle-orm";

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
 * Nothing secret is echoed back - only whether a variable is set, plus the
 * database host (never the password or the full connection string).
 */

type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

/** Columns added by a migration, so a stale schema is caught by name. */
const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "reminders", column: "dedupe_key" },
  { table: "reminders", column: "recipient_id" },
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

export async function GET() {
  const checks: Check[] = [];

  // 1. Is the app configured at all?
  const hasDbUrl = Boolean(process.env.DATABASE_URL);
  checks.push({
    name: "DATABASE_URL",
    status: hasDbUrl ? "ok" : "fail",
    detail: hasDbUrl ? `set → ${describeDbTarget()}` : "not set",
    fix: hasDbUrl
      ? undefined
      : "Set DATABASE_URL on the service (Render → Environment) to your Postgres connection string.",
  });

  // 2 & 3. Can we actually query, and is the schema applied?
  if (hasDbUrl) {
    try {
      await db.execute(sql`select 1`);
      checks.push({ name: "database connection", status: "ok", detail: "query succeeded (select 1)" });

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
          fix:
            schemaProblems.length === 0
              ? undefined
              : "npm run db:push   (reconciles the database with the schema in one step; or npm run db:baseline then npm run db:migrate)",
        });
      } catch (error) {
        const { detail, fix } = explainDbError(error);
        checks.push({ name: "schema", status: "fail", detail, fix });
      }
    } catch (error) {
      const { detail, fix } = explainDbError(error);
      checks.push({ name: "database connection", status: "fail", detail, fix });
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
  let otpStatus: Status = "ok";
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
    fix:
      otpStatus === "fail"
        ? "Set OTP_MODE=dummy to accept the dummy code for now, or configure MSG91_AUTH_KEY + MSG91_FLOW_ID."
        : undefined,
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
    fix: cronSecret
      ? undefined
      : "Set CRON_SECRET on the service to a long random string, and add the same value as a GitHub Actions secret (see README → Scheduled reminders).",
  });

  checks.push({
    name: "optional integrations",
    status: "ok",
    detail: `payment proofs: ${cloudinary ? "configured" : "not configured (uploads return 503)"}, push: ${push ? "configured" : "not configured"}`,
  });

  const failed = checks.filter((c) => c.status === "fail");
  const healthy = failed.length === 0;

  return Response.json(
    {
      ok: healthy,
      // Kept for existing monitors that only read `ok`.
      checks,
      ...(healthy
        ? {}
        : {
            firstProblem: failed[0].name,
            action: failed[0].fix,
          }),
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
