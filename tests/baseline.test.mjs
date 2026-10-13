import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildDbState,
  describeMissing,
  missingFrom,
  requirementsFromSnapshot,
} from "../scripts/lib/db-schema-check.mjs";

/** A miniature snapshot in the shape Drizzle writes to drizzle/meta/. */
const snapshot = {
  tables: {
    "public.users": { columns: { id: {}, mobile: {} }, indexes: {} },
    "public.reminders": {
      columns: { id: {}, installment_id: {}, dedupe_key: {} },
      indexes: { reminders_dedupe_key_unique: { name: "reminders_dedupe_key_unique" } },
    },
  },
};

describe("requirementsFromSnapshot", () => {
  it("strips the schema prefix and lists tables, columns and index names", () => {
    const req = requirementsFromSnapshot(snapshot);

    expect(req.tables).toEqual(["users", "reminders"]);
    expect(req.columns).toContain("reminders.dedupe_key");
    expect(req.columns).toContain("users.mobile");
    expect(req.indexes).toEqual(["reminders_dedupe_key_unique"]);
  });

  it("copes with a snapshot that has no tables", () => {
    expect(requirementsFromSnapshot({})).toEqual({ tables: [], columns: [], indexes: [] });
  });
});

describe("missingFrom", () => {
  const db = buildDbState({
    tables: ["users"],
    columns: ["users.id", "users.mobile"],
    indexes: [],
  });

  it("reports nothing missing when the database satisfies the snapshot", () => {
    const req = requirementsFromSnapshot({
      tables: { "public.users": { columns: { id: {}, mobile: {} }, indexes: {} } },
    });
    expect(missingFrom(db, req).total).toBe(0);
  });

  it("names the exact table, column and index that are absent", () => {
    const missing = missingFrom(db, requirementsFromSnapshot(snapshot));

    expect(missing.tables).toEqual(["reminders"]);
    expect(missing.columns).toContain("reminders.dedupe_key");
    // The index is checked separately: a migration that only adds an index
    // changes no columns, so columns alone cannot detect it.
    expect(missing.indexes).toEqual(["reminders_dedupe_key_unique"]);
    expect(missing.total).toBeGreaterThan(0);
  });

  it("detects an index-only migration", () => {
    const req = requirementsFromSnapshot({
      tables: { "public.users": { columns: { id: {} }, indexes: { users_mobile_unique: {} } } },
    });
    const state = buildDbState({ tables: ["users"], columns: ["users.id"], indexes: [] });

    expect(missingFrom(state, req)).toMatchObject({ indexes: ["users_mobile_unique"], total: 1 });
  });
});

describe("describeMissing", () => {
  it("summarises what is missing in one line", () => {
    const missing = { tables: [], columns: ["reminders.dedupe_key"], indexes: [], total: 1 };
    expect(describeMissing(missing)).toBe("columns: reminders.dedupe_key");
  });

  it("truncates long lists", () => {
    const missing = { tables: [], columns: ["a", "b", "c", "d", "e"], indexes: [], total: 5 };
    expect(describeMissing(missing, 2)).toContain("(+3 more)");
  });
});

// ── The regression test for the bug this module exists to prevent ───────────
describe("real migration snapshots", () => {
  const metaDir = path.resolve("drizzle/meta");
  const read = (name) => JSON.parse(fs.readFileSync(path.join(metaDir, name), "utf8"));

  it("sees 0001's requirements as unsatisfied on a database that is only at 0000", () => {
    // A database created by `db:push` before migration 0001 existed has
    // exactly the schema 0000 describes - nothing more.
    const at0000 = requirementsFromSnapshot(read("0000_snapshot.json"));
    const at0001 = requirementsFromSnapshot(read("0001_snapshot.json"));

    const db = buildDbState({
      tables: at0000.tables,
      columns: at0000.columns,
      indexes: at0000.indexes,
    });

    expect(missingFrom(db, at0000).total).toBe(0);

    // This is what the old baseline script got wrong: it recorded 0001 as
    // applied, so `db:migrate` skipped it and reminders.dedupe_key never
    // existed.
    const missing = missingFrom(db, at0001);
    expect(missing.columns).toContain("reminders.dedupe_key");
    expect(missing.indexes).toContain("reminders_dedupe_key_unique");
  });

  it("is satisfied once the database has the column and the index", () => {
    const at0001 = requirementsFromSnapshot(read("0001_snapshot.json"));
    const db = buildDbState({
      tables: at0001.tables,
      columns: at0001.columns,
      indexes: at0001.indexes,
    });

    expect(missingFrom(db, at0001).total).toBe(0);
  });
});
