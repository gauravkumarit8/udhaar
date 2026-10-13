import { describe, it, expect } from "vitest";
import {
  OVERDUE_NAG_DAYS,
  composeReminderBody,
  daysBetween,
  extractSecret,
  planReminder,
  reminderDedupeKey,
  secretsMatch,
  todayInIndia,
} from "@/lib/reminders";

describe("planReminder", () => {
  const today = "2026-10-13";

  it("fires on T-2, T-1 and T0, matching the cadence the app already used locally", () => {
    expect(planReminder("2026-10-15", today)).toMatchObject({ kind: "T-2", urgency: "upcoming" });
    expect(planReminder("2026-10-14", today)).toMatchObject({ kind: "T-1", urgency: "upcoming" });
    expect(planReminder("2026-10-13", today)).toMatchObject({ kind: "T0", urgency: "due" });
  });

  it("stays quiet more than two days ahead", () => {
    expect(planReminder("2026-10-16", today)).toBeNull();
    expect(planReminder("2026-11-13", today)).toBeNull();
  });

  it("nags once a day for the first week overdue, then stops", () => {
    expect(planReminder("2026-10-12", today)).toMatchObject({ kind: "overdue-1", urgency: "overdue" });
    expect(planReminder("2026-10-07", today)).toMatchObject({ kind: "overdue-6" });
    expect(planReminder("2026-10-06", today)).toMatchObject({ kind: "overdue-7" });

    // Day 8 and beyond: an EMI that old is a conversation, not a notification.
    expect(planReminder("2026-10-05", today)).toBeNull();
    expect(planReminder("2026-08-01", today)).toBeNull();
  });

  it("titles the overdue nags with a day count", () => {
    expect(planReminder("2026-10-12", today)?.title).toContain("1 day past due");
    expect(planReminder("2026-10-10", today)?.title).toContain("3 days past due");
    expect(planReminder("2026-10-15", today)?.title).toContain("2 days away");
  });

  it("crosses month and year boundaries", () => {
    expect(planReminder("2026-11-01", "2026-10-30")).toMatchObject({ kind: "T-2" });
    expect(planReminder("2027-01-02", "2026-12-31")).toMatchObject({ kind: "T-2" });
    expect(planReminder("2026-12-31", "2027-01-01")).toMatchObject({ kind: "overdue-1" });
  });

  it("keeps the 7-day nag window in one place", () => {
    expect(OVERDUE_NAG_DAYS).toBe(7);
    expect(planReminder("2026-10-06", today)).not.toBeNull();
    expect(planReminder("2026-10-05", today)).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-10-13", "2026-10-15")).toBe(2);
    expect(daysBetween("2026-10-15", "2026-10-13")).toBe(-2);
    expect(daysBetween("2026-10-13", "2026-10-13")).toBe(0);
  });

  it("includes leap days", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });
});

describe("todayInIndia", () => {
  // 03:00 UTC is already 08:30 in India - the sweep runs at 09:00 IST, so a
  // UTC-based "today" would be a day behind for part of every day.
  it("uses the Indian calendar date, not UTC", () => {
    expect(todayInIndia(new Date("2026-10-13T03:00:00Z"))).toBe("2026-10-13");
    expect(todayInIndia(new Date("2026-10-13T20:00:00Z"))).toBe("2026-10-14");
    expect(todayInIndia(new Date("2026-10-13T23:59:00Z"))).toBe("2026-10-14");
    expect(todayInIndia(new Date("2026-10-13T18:29:00Z"))).toBe("2026-10-13"); // 23:59 IST
  });
});

describe("reminderDedupeKey", () => {
  it("is stable and distinguishes EMI, day and kind", () => {
    const key = reminderDedupeKey("emi-1", "T-1", "2026-10-13");
    expect(key).toBe("emi-1:T-1:2026-10-13");
    expect(key).toBe(reminderDedupeKey("emi-1", "T-1", "2026-10-13"));

    expect(key).not.toBe(reminderDedupeKey("emi-2", "T-1", "2026-10-13"));
    expect(key).not.toBe(reminderDedupeKey("emi-1", "T0", "2026-10-13"));
    expect(key).not.toBe(reminderDedupeKey("emi-1", "T-1", "2026-10-14"));
  });

  it("fits the column it is stored in", () => {
    // varchar(120) in the reminders table
    expect(reminderDedupeKey("f".repeat(36), "overdue-7", "2026-10-13").length).toBeLessThanOrEqual(120);
  });
});

describe("composeReminderBody", () => {
  it("names the lender, not the recipient", () => {
    const body = composeReminderBody({
      lenderName: "Gaurav",
      amount: 4442.44,
      dueDateLabel: "15 Oct 2026",
      urgency: "upcoming",
    });
    expect(body).toContain("Gaurav");
    expect(body).toContain("15 Oct 2026");
    expect(body).toContain("4,442.44");
  });

  it("reads differently once the date has passed", () => {
    const overdue = composeReminderBody({
      lenderName: "Gaurav",
      amount: 1000,
      dueDateLabel: "10 Oct 2026",
      urgency: "overdue",
    });
    const due = composeReminderBody({
      lenderName: "Gaurav",
      amount: 1000,
      dueDateLabel: "13 Oct 2026",
      urgency: "due",
    });

    expect(overdue).toMatch(/was due on/);
    expect(due).toMatch(/due today/);
  });
});

describe("sweep secret", () => {
  it("accepts only an exact match", () => {
    expect(secretsMatch("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretsMatch("s3cret-valu", "s3cret-value")).toBe(false); // length differs
    expect(secretsMatch("s3cret-valuf", "s3cret-value")).toBe(false); // same length, differs
    expect(secretsMatch("", "s3cret-value")).toBe(false);
    expect(secretsMatch(null, "s3cret-value")).toBe(false);
    expect(secretsMatch(undefined, "s3cret-value")).toBe(false);
  });

  it("reads a bearer token or the explicit header", () => {
    expect(extractSecret(new Headers({ authorization: "Bearer abc123" }))).toBe("abc123");
    expect(extractSecret(new Headers({ authorization: "bearer abc123" }))).toBe("abc123");
    expect(extractSecret(new Headers({ "x-cron-secret": "abc123" }))).toBe("abc123");
    expect(extractSecret(new Headers({ authorization: "Basic abc123" }))).toBeNull();
    expect(extractSecret(new Headers({}))).toBeNull();
  });
});
