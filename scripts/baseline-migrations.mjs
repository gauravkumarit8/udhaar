#!/usr/bin/env node
/**
 * Baselines Drizzle migrations on a database that was created with
 * `drizzle-kit push` (i.e. one that already has the tables but no record of
 * having run any migration).
 *
 * Why this exists: the project's real database was built with `db:push`. If
 * you then point `db:migrate` at it, Drizzle replays 0000_initial_schema.sql
 * from the beginning and fails with `relation "users" already exists`. This
 * script marks the existing migrations as already applied, so future
 * migrations apply cleanly on top.
 *
 * It is safe to run repeatedly: it does nothing when there are no app tables,
 * and nothing when the migration journal is already populated.
 *
 * Usage:
 *   npm run db:baseline               # uses DATABASE_URL from .env
 *   DATABASE_URL="postgresql://..." npm run db:baseline
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve("drizzle");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

const APP_TABLES = [
  "users",
  "sessions",
  "otps",
  "loans",
  "installments",
  "payments",
  "reminders",
  "device_tokens",
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Nothing to do.");
  process.exit(1);
}

if (!fs.existsSync(JOURNAL_PATH)) {
  console.error(`No migration journal at ${JOURNAL_PATH} - run "npm run db:generate" first.`);
  process.exit(1);
}

const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));

const client = new pg.Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
  ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
});

/** Drizzle stores sha256 of the migration file's bytes. */
function hashOf(tag) {
  const sqlPath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
  if (!fs.existsSync(sqlPath)) throw new Error(`Migration file missing: ${sqlPath}`);
  return crypto.createHash("sha256").update(fs.readFileSync(sqlPath)).digest("hex");
}

try {
  await client.connect();

  const { rows: tableRows } = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`
  );
  const present = new Set(tableRows.map((r) => r.table_name));
  const appTablesPresent = APP_TABLES.filter((t) => present.has(t));

  if (appTablesPresent.length === 0) {
    console.log("This database has no Udhaar tables yet.");
    console.log('Nothing to baseline - run "npm run db:migrate" to create the schema from scratch.');
    process.exit(0);
  }

  await client.query(`create schema if not exists "drizzle"`);
  await client.query(`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);

  const { rows: applied } = await client.query(
    `select hash from "drizzle"."__drizzle_migrations"`
  );
  const appliedHashes = new Set(applied.map((r) => r.hash));

  const pending = journal.entries.filter((entry) => !appliedHashes.has(hashOf(entry.tag)));

  if (pending.length === 0) {
    console.log(`Already baselined - all ${journal.entries.length} migration(s) are recorded as applied.`);
    process.exit(0);
  }

  for (const entry of pending) {
    await client.query(
      `insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ($1, $2)`,
      [hashOf(entry.tag), entry.when]
    );
    console.log(`  marked as applied: ${entry.tag}`);
  }

  console.log(
    `\nBaselined ${pending.length} migration(s) on a database that already had ` +
      `${appTablesPresent.length} table(s).\n` +
      'From now on use "npm run db:migrate" for schema changes.'
  );
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
