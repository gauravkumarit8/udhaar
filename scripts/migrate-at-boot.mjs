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
import { existsSync } from "node:fs";
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  warn("DATABASE_URL is not set - skipping migrations. /api/health will explain.");
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

try {
  log("applying migrations");
  await migrate(drizzle(pool), { migrationsFolder: path.join(projectRoot, "drizzle") });
  log("migrations applied - the database matches the code");
  process.exit(0);
} catch (error) {
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
  warn(`migrations did NOT apply: ${detail}`);
  warn("the app will still start; check /api/health, then run npm run db:migrate or npm run db:push");
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
