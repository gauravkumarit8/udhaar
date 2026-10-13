/**
 * Pure comparison logic for `scripts/baseline-migrations.mjs`.
 *
 * The first version of that script marked *every* migration in `drizzle/` as
 * already applied. That is only correct when the database really does match
 * the schema those migrations describe. On a database created with
 * `drizzle-kit push` *before* a later migration existed, it recorded a
 * migration that had never run - so `db:migrate` then did nothing and the
 * column was simply missing. That is exactly how `reminders.dedupe_key` ended
 * up absent while the journal claimed it was applied.
 *
 * These helpers answer the question the script should have asked: "is this
 * migration's effect actually present in the database?" They compare the
 * structural requirements of a migration's snapshot (tables, columns, index
 * names) against what the database reports.
 *
 * Deliberately not compared: column types, defaults, constraints and
 * expression indexes. Name-level structure is enough to tell "table created"
 * and "column added" apart, and being conservative here is safer than
 * replaying a migration that would fail with "already exists".
 */

/** Shape of the parts of a Drizzle snapshot we rely on. */
export function requirementsFromSnapshot(snapshot) {
  const tables = [];
  const columns = [];
  const indexes = [];

  for (const [qualifiedName, table] of Object.entries(snapshot.tables ?? {})) {
    // Snapshots key tables as "public.users".
    const tableName = qualifiedName.includes(".") ? qualifiedName.split(".").pop() : qualifiedName;
    tables.push(tableName);

    for (const columnName of Object.keys(table.columns ?? {})) {
      columns.push(`${tableName}.${columnName}`);
    }
    for (const indexName of Object.keys(table.indexes ?? {})) {
      indexes.push(indexName);
    }
  }

  return { tables, columns, indexes };
}

/** What does the database currently have? */
export function buildDbState({ tables = [], columns = [], indexes = [] }) {
  return {
    tables: new Set(tables),
    columns: new Set(columns), // "table.column"
    indexes: new Set(indexes),
  };
}

/**
 * Which of a snapshot's requirements are absent from the database?
 * An empty array means the database already reflects that migration.
 */
export function missingFrom(dbState, requirements) {
  const missing = {
    tables: requirements.tables.filter((t) => !dbState.tables.has(t)),
    columns: requirements.columns.filter((c) => !dbState.columns.has(c)).map((c) => c),
    indexes: requirements.indexes.filter((i) => !dbState.indexes.has(i)),
  };

  return {
    tables: missing.tables,
    columns: missing.columns,
    indexes: missing.indexes,
    total: missing.tables.length + missing.columns.length + missing.indexes.length,
  };
}

/** Human-readable one-liner for a `missingFrom` result. */
export function describeMissing(missing, limit = 4) {
  const parts = [];
  if (missing.tables.length) parts.push(`tables: ${missing.tables.slice(0, limit).join(", ")}`);
  if (missing.columns.length) parts.push(`columns: ${missing.columns.slice(0, limit).join(", ")}`);
  if (missing.indexes.length) parts.push(`indexes: ${missing.indexes.slice(0, limit).join(", ")}`);

  const hidden =
    missing.tables.length + missing.columns.length + missing.indexes.length - limit * parts.length;
  const suffix = hidden > 0 ? ` (+${hidden} more)` : "";
  return parts.join("; ") + suffix;
}
