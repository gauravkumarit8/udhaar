#!/usr/bin/env node
/**
 * Apply the database migrations, from wherever the app is starting.
 *
 * `npm run db:migrate` (drizzle-kit) is the developer path and stays the one
 * the README documents. This script exists for the *container* boot and for
 * any host that cannot run npm scripts: it does the same two steps the Render
 * service does in `render.yaml` (`db:baseline` then `db:migrate`), using only
 * packages that are present in the runtime image.
 *
 * Why it is needed: on 2026-10-14 the borrower-side release (PR #17) went live
 * on Render while its migration had not been applied. The app answered 503 on
 * every loan screen - honest, but an outage. A container whose start command
 * does not migrate will always be able to outrun its own schema, so the boot
 * itself has to do it.
 *
 * Deliberately not fatal: if the database is unreachable, the app still starts
 * and `/api/health` explains what is wrong, which is the same policy as
 * `render.yaml`. The exit code says what happened (0 = up to date, 1 = not) so
 * a caller can tell the difference in its logs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function log(message) {
  console.log(`[migrate] ${message}`);
}

function warn(message) {
  console.warn(`[migrate] ${message}`);
}

/*
 * Write down what happened, where the app can read it.
 *
 * `/api/health` is the only thing anybody looks at when a deploy goes wrong,
 * and "schema: not up to date" does not distinguish "the migration was never
 * run" from "it ran and failed" from "it ran against another database" - three
 * failures with three different fixes. This file is the difference. It is
 * best-effort: a host that cannot write it still boots.
 */
const reportPath = process.env.MIGRATION_REPORT_PATH || "/tmp/udhaar-migration-report.json";

function writeReport(report) {
  try {
    writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2));
    log(`wrote the boot migration report to ${reportPath}`);
  } catch (error) {
    warn(`could not write the boot migration report (${error.message}) - continuing`);
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  warn("DATABASE_URL is not set - skipping migrations. /api/health will explain.");
  writeReport({ ok: false, applied: [], attempts: 0, message: "DATABASE_URL is not set" });
  process.exit(1);
}

/*
 * Step 1, when it is available: adopt a database that predates the migration
 * journal (one created with `db:push`). Without this, a replay of the initial
 * migration would fail with "already exists", and the real pending migration
 * behind it would never run. Not present in the runtime image, which is why
 * this is a check rather than a hard dependency.
 *
 * A failure here is reported, not fatal: it usually means the database is
 * unreachable, and the migrate step below will say so in its own words.
 */
const baselineScript = path.join(projectRoot, "scripts", "baseline-migrations.mjs");
if (existsSync(baselineScript)) {
  log("checking the migration journal against the database (db:baseline)");
  const baseline = spawnSync(process.execPath, [baselineScript], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (baseline.status !== 0) {
    warn(
      `the baseline check exited with ${baseline.status ?? "no status"} - continuing to the migration step`
    );
  }
} else {
  log("baseline check not present in this image - applying migrations only");
}

// `sslmode=require` (Neon, Supabase, Render's own Postgres) is part of the URL
// and is handled by pg; local databases without TLS keep working unchanged.
const useSsl = !/localhost|127\.0\.0\.1/.test(databaseUrl);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

/**
 * How many rows the journal holds, so we can say whether anything was applied
 * rather than assuming it. Returns null when the table is not there yet, which
 * itself means "nothing has ever been applied".
 */
async function appliedCount() {
  try {
    const { rows } = await pool.query('select count(*)::int as count from "drizzle"."__drizzle_migrations"');
    return rows[0]?.count ?? 0;
  } catch {
    return null;
  }
}

const ATTEMPTS = 3;
const RETRY_DELAY_MS = [3_000, 10_000];

let lastError = null;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const before = await appliedCount();

  try {
    log(`applying migrations${attempt > 1 ? ` (attempt ${attempt} of ${ATTEMPTS})` : ""}`);
    await migrate(drizzle(pool), { migrationsFolder: path.join(projectRoot, "drizzle") });

    const after = await appliedCount();
    const applied = before !== null && after !== null && after > before ? [`${after - before} migration(s)`] : [];

    log("migrations applied - the database matches the code");
    writeReport({
      ok: true,
      applied,
      attempts: attempt,
      message: applied.length > 0 ? `applied ${applied[0]}` : "nothing was pending - the schema already matched the code",
    });
    await pool.end().catch(() => {});
    process.exit(0);
  } catch (error) {
    lastError = error;

    /*
     * Retry: the first connection to a suspended Neon database (or any host
     * that cold-starts its database alongside the app) can fail while the
     * compute wakes. Postgres DDL is transactional, so a failed attempt left
     * nothing half-applied - trying again is safe rather than hopeful.
     */
    if (attempt < ATTEMPTS) {
      const wait = RETRY_DELAY_MS[attempt - 1] ?? 10_000;
      const reason = error instanceof Error ? error.message : String(error);
      warn(`migrations did not apply on attempt ${attempt} (${reason}) - retrying in ${wait / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

{
  const error = lastError;
  // The message is the whole point: a boot log that says "failed" with no
  // reason is how a deploy reaches production with the schema behind it.
  // drizzle wraps the driver error, so the cause is where "connection refused"
  // or "password authentication failed" actually lives.
  const detail =
    error instanceof Error
      ? [error.message, error.cause instanceof Error ? `— ${error.cause.message}` : ""]
          .filter(Boolean)
          .join(" ")
      : String(error);
  warn(`migrations did NOT apply after ${ATTEMPTS} attempt(s): ${detail}`);
  warn("the app will still start; check /api/health, then run npm run db:migrate or npm run db:push");
  writeReport({ ok: false, applied: [], attempts: ATTEMPTS, message: detail });
  await pool.end().catch(() => {});
  process.exit(1);
}
