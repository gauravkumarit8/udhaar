/**
 * What the boot migration did, read back by `/api/health`.
 *
 * The failure this exists for, observed on 2026-10-15: a release went live
 * whose migration had not been applied. `/api/health` said "schema: not up to
 * date" - which was true and useless. It could not say *why*: whether the boot
 * migration was never run, ran and failed, or ran against a different database
 * altogether. All three look identical from the app's side, and all three need
 * different fixes.
 *
 * So `scripts/migrate-at-boot.mjs` writes down what happened, and the health
 * endpoint reads it. The file lives beside the app in the same container; when
 * it is missing, that itself is the diagnostic - the host is not running the
 * migration at boot.
 *
 * Nothing here reads the file: parsing and describing are pure so they can be
 * tested, and the route owns the filesystem.
 */
import { readFileSync } from "node:fs";

export interface BootMigrationReport {
  /** When the boot migration finished, ISO. */
  at: string;
  /** True when every migration is applied. */
  ok: boolean;
  /** Migration tags applied during *that* run (empty when nothing was pending). */
  applied: string[];
  /** How many attempts it took (1 unless the first one hit a connection error). */
  attempts: number;
  /** One sentence a person can read, with the real reason on failure. */
  message: string;
}

/** Where the boot script writes it. Overridable for tests and odd hosts. */
export function bootMigrationReportPath(): string {
  return process.env.MIGRATION_REPORT_PATH || "/tmp/udhaar-migration-report.json";
}

export function parseBootMigrationReport(raw: string | null | undefined): BootMigrationReport | null {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value !== "object" || value === null) return null;
    if (typeof value.at !== "string" || typeof value.ok !== "boolean") return null;

    return {
      at: value.at,
      ok: value.ok,
      applied: Array.isArray(value.applied) ? value.applied.filter((t): t is string => typeof t === "string") : [],
      attempts: typeof value.attempts === "number" ? value.attempts : 1,
      message: typeof value.message === "string" ? value.message : value.ok ? "up to date" : "no reason given",
    };
  } catch {
    // A truncated file (the container died mid-write) is "no report", not a
    // crash - the caller has to survive a host being killed at any moment.
    return null;
  }
}

/** Reads the report from disk, or null when there isn't one. Never throws. */
export function readBootMigrationReport(path: string = bootMigrationReportPath()): BootMigrationReport | null {
  try {
    return parseBootMigrationReport(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface BootMigrationExplanation {
  status: "warn" | "fail";
  detail: string;
  /** Safe to show a stranger: no paths, no hostnames, no raw driver errors. */
  publicDetail: string;
}

/**
 * Says what the boot migration did, in the one situation anybody cares: the
 * schema is not up to date, so the app needs to know why.
 *
 * The four cases are deliberately distinguished, because they have four
 * different fixes: it never ran, it ran and failed, it ran and thought it was
 * already done (wrong database, or a stale journal), or it applied things and
 * the app is still looking at a database without them (definitely two
 * databases).
 */
export function describeBootMigration(report: BootMigrationReport | null): BootMigrationExplanation {
  if (!report) {
    return {
      status: "warn",
      detail:
        "No report from the boot migration. On a host, the start command is supposed to run " +
        "`node scripts/migrate-at-boot.mjs` before the server (render.yaml and the container entrypoint both do) " +
        "- if this file is absent, it is not being run, so the schema is whatever the last manual migration left.",
      publicDetail: "no report - the host may not be migrating at start-up",
    };
  }

  if (!report.ok) {
    return {
      status: "fail",
      detail: `The boot migration tried ${report.attempts} time(s) at ${report.at} and failed: ${report.message}`,
      publicDetail: "the boot migration failed - send the health token for the reason",
    };
  }

  if (report.applied.length > 0) {
    return {
      status: "fail",
      detail:
        `The boot migration applied ${report.applied.join(", ")} at ${report.at} and reported success - ` +
        "yet this app still cannot see it. That means the app is reading a different database than the " +
        "one that was migrated: compare DATABASE_URL on the service with the one the migration used.",
      publicDetail: "a migration was applied to a different database than the one serving this app",
    };
  }

  return {
    status: "warn",
    detail:
      `The boot migration ran at ${report.at} and found nothing to apply - but this app cannot see a ` +
      "required table or column. Either the journal (`drizzle.__drizzle_migrations`) records a migration " +
      "that never actually ran, or the app is reading a different database. " +
      "`npm run check-deploy` against that DATABASE_URL will say which objects are missing.",
    publicDetail: "the boot migration found nothing to apply, yet the schema is behind",
  };
}
