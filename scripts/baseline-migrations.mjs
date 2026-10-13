#!/usr/bin/env node
/**
 * Adopts Drizzle migrations on a database that was created with
 * `drizzle-kit push` instead of `drizzle-kit migrate`.
 *
 * Why this exists: the project's original database was built with `db:push`.
 * Pointing `db:migrate` at it replays 0000_initial_schema.sql from the start
 * and fails with `relation "users" already exists`. This records the
 * migrations the database already reflects, so the remaining ones apply
 * cleanly on top.
 *
 * It verifies each migration against the database rather than trusting the
 * journal:
 *
 *   - a migration whose tables/columns/indexes are all present is recorded as
 *     already applied;
 *   - the first migration whose effect is missing stops the walk - it stays
 *     pending, and `npm run db:migrate` applies it;
 *   - if the journal claims a migration is applied but the database doesn't
 *     have its changes (what happens when an earlier `db:baseline` marked too
 *     much), that entry is removed, so `db:migrate` can actually run it.
 *
 * Safe to run repeatedly: it does nothing when there are no app tables, and
 * nothing when the journal already agrees with the database.
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
import {
  buildDbState,
  describeMissing,
  missingFrom,
  requirementsFromSnapshot,
} from "./lib/db-schema-check.mjs";

const MIGRATIONS_DIR = path.resolve("drizzle");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

/** Tables that mean "this database is already set up". */
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

/** Snapshot files are named by index: 0000_snapshot.json, 0001_snapshot.json … */
function snapshotFor(entry) {
  const file = path.join(MIGRATIONS_DIR, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

try {
  await client.connect();

  const { rows: tableRows } = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`
  );
  const presentTables = tableRows.map((r) => r.table_name);
  const appTablesPresent = APP_TABLES.filter((t) => presentTables.includes(t));

  if (appTablesPresent.length === 0) {
    console.log("This database has no Udhaar tables yet.");
    console.log('Nothing to baseline - run "npm run db:migrate" to create the schema from scratch.');
    process.exit(0);
  }

  // Everything the comparison needs, in one round trip each.
  const { rows: columnRows } = await client.query(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`
  );
  const { rows: indexRows } = await client.query(
    `select indexname from pg_indexes where schemaname = 'public'`
  );

  const dbState = buildDbState({
    tables: presentTables,
    columns: columnRows.map((r) => `${r.table_name}.${r.column_name}`),
    indexes: indexRows.map((r) => r.indexname),
  });

  await client.query(`create schema if not exists "drizzle"`);
  await client.query(`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);

  const { rows: appliedRows } = await client.query(
    `select hash from "drizzle"."__drizzle_migrations"`
  );
  const appliedHashes = new Set(appliedRows.map((r) => r.hash));

  const marked = [];
  const repaired = [];
  let firstPending = null;

  for (const entry of journal.entries) {
    const snapshot = snapshotFor(entry);

    // A snapshot we can't read is treated as "cannot verify" - stop and let
    // the user decide, rather than recording something we can't check.
    const missing = snapshot
      ? missingFrom(dbState, requirementsFromSnapshot(snapshot))
      : { tables: [], columns: [], indexes: [], total: 1, unknown: true };

    const hash = hashOf(entry.tag);
    const alreadyRecorded = appliedHashes.has(hash);

    if (missing.total === 0) {
      if (!alreadyRecorded) {
        await client.query(
          `insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ($1, $2)`,
          [hash, entry.when]
        );
        marked.push(entry.tag);
        appliedHashes.add(hash);
      }
      continue;
    }

    // The database does not have this migration's changes.
    if (!firstPending) {
      firstPending = { entry, missing, snapshotAvailable: Boolean(snapshot) };
    }

    // …but an earlier run recorded it as applied anyway. Remove that claim so
    // `db:migrate` will actually run it.
    if (alreadyRecorded) {
      await client.query(`delete from "drizzle"."__drizzle_migrations" where hash = $1`, [hash]);
      appliedHashes.delete(hash);
      repaired.push(entry.tag);
    }
  }

  if (marked.length > 0) {
    for (const tag of marked) console.log(`  recorded as already applied: ${tag}`);
  }
  if (repaired.length > 0) {
    for (const tag of repaired) console.log(`  removed an incorrect "applied" record: ${tag}`);
  }

  if (marked.length === 0 && repaired.length === 0 && !firstPending) {
    console.log(
      `Up to date - the database matches all ${journal.entries.length} migration(s) and the journal agrees.`
    );
    process.exit(0);
  }

  if (!firstPending) {
    console.log(
      `\nDone. The database matches all ${journal.entries.length} migration(s); ` +
        `they are now recorded as applied, so future migrations apply on top.`
    );
    process.exit(0);
  }

  const { entry, missing, snapshotAvailable } = firstPending;
  console.log(
    snapshotAvailable
      ? `\nStill to apply: ${entry.tag} (${describeMissing(missing)})`
      : `\nStill to apply: ${entry.tag} (could not verify - no snapshot file)`
  );
  console.log('Run "npm run db:migrate" to apply it.');
  console.log(
    'If that migration fails because some of its objects already exist, run "npm run db:push" ' +
      'instead - it reconciles the database with src/db/schema.ts in one step.'
  );
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
