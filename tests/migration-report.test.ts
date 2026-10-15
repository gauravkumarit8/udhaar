import { describe, expect, it } from "vitest";
import {
  describeBootMigration,
  parseBootMigrationReport,
  type BootMigrationReport,
} from "@/lib/migration-report";

const report = (over: Partial<BootMigrationReport> = {}): BootMigrationReport => ({
  at: "2026-10-15T06:50:00.000Z",
  ok: true,
  applied: [],
  attempts: 1,
  message: "nothing was pending - the schema already matched the code",
  ...over,
});

describe("reading the boot migration's report", () => {
  it("accepts what the boot script writes", () => {
    const parsed = parseBootMigrationReport(
      JSON.stringify({ at: "2026-10-15T06:50:00.000Z", ok: true, applied: ["0008_whatsapp_reminders"], attempts: 2, message: "applied 1 migration(s)" })
    );
    expect(parsed).toEqual({
      at: "2026-10-15T06:50:00.000Z",
      ok: true,
      applied: ["0008_whatsapp_reminders"],
      attempts: 2,
      message: "applied 1 migration(s)",
    });
  });

  it("treats a truncated file as no report, not as a crash", () => {
    // The container can be killed mid-write; the app has to survive that.
    expect(parseBootMigrationReport('{"at":"2026-10-15T06:50:00.000Z","ok":tr')).toBeNull();
    expect(parseBootMigrationReport("")).toBeNull();
    expect(parseBootMigrationReport(null)).toBeNull();
  });

  it("refuses a file that is not a report", () => {
    expect(parseBootMigrationReport('{"hello":"world"}')).toBeNull();
    expect(parseBootMigrationReport("[1,2,3]")).toBeNull();
    expect(parseBootMigrationReport('{"at":123,"ok":"yes"}')).toBeNull();
  });

  it("tolerates a missing or unreadable message rather than inventing one", () => {
    const parsed = parseBootMigrationReport('{"at":"2026-10-15T06:50:00Z","ok":false}');
    expect(parsed?.message).toBe("no reason given");
    expect(parsed?.applied).toEqual([]);
  });
});

describe("what the report means when the schema is behind", () => {
  it("the failure nobody can see: the migration was never run", () => {
    const explained = describeBootMigration(null);
    expect(explained.status).toBe("warn");
    expect(explained.detail).toContain("migrate-at-boot");
    expect(explained.detail).toContain("not being run");
    expect(explained.publicDetail).not.toContain("/tmp");
  });

  it("ran and failed: the reason is carried through", () => {
    const explained = describeBootMigration(report({ ok: false, attempts: 3, message: "connect ECONNREFUSED 10.0.0.1:5432" }));
    expect(explained.status).toBe("fail");
    expect(explained.detail).toContain("3 time(s)");
    expect(explained.detail).toContain("ECONNREFUSED");
  });

  it("ran, applied something, and the app still cannot see it: two databases", () => {
    const explained = describeBootMigration(report({ applied: ["0008_whatsapp_reminders"] }));
    expect(explained.status).toBe("fail");
    expect(explained.detail).toContain("different database");
  });

  it("ran, found nothing to do, and the app is still behind: a lying journal", () => {
    const explained = describeBootMigration(report());
    expect(explained.status).toBe("warn");
    expect(explained.detail).toContain("nothing to apply");
    expect(explained.detail).toContain("check-deploy");
  });

  it("never leaks a path or a hostname into the public line", () => {
    for (const explained of [
      describeBootMigration(null),
      describeBootMigration(report({ ok: false, message: "connect ECONNREFUSED 10.1.2.3:5432" })),
      describeBootMigration(report({ applied: ["0008_whatsapp_reminders"] })),
      describeBootMigration(report()),
    ]) {
      expect(explained.publicDetail).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|\/tmp|5432/);
    }
  });
});
