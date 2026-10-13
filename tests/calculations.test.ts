import { describe, expect, it } from "vitest";
import {
  calculateEMI,
  calculateTotalInterest,
  computeInstallmentStatus,
  generateInstallmentSchedule,
} from "@/lib/calculations";

type AmountKey = "principalAmount" | "interestAmount" | "totalAmount";

const sum = (rows: readonly Record<AmountKey, number>[], key: AmountKey) =>
  Math.round(rows.reduce((acc, r) => acc + r[key], 0) * 100) / 100;

describe("calculateEMI", () => {
  it("matches the reducing-balance closed form", () => {
    // Textbook values: 1,00,000 @ 12% p.a. for 12 months
    expect(calculateEMI(100000, 12, 12, "yearly")).toBeCloseTo(8884.88, 2);
    // 2% per month for 6 months on 10,000
    expect(calculateEMI(10000, 2, 6, "monthly")).toBeCloseTo(1785.26, 2);
    // 18% p.a. for 1 month is simply principal + 1.5%
    expect(calculateEMI(50000, 18, 1, "yearly")).toBeCloseTo(50750, 2);
  });

  it("falls back to an equal split with no interest", () => {
    expect(calculateEMI(12000, 0, 12)).toBe(1000);
  });
});

describe("generateInstallmentSchedule", () => {
  it("sums exactly to the principal borrowed (no paise drift)", () => {
    const cases: Array<[number, number, number, string, "yearly" | "monthly"]> = [
      [100000, 12, 12, "2026-01-15", "yearly"],
      [10000, 2, 6, "2026-05-01", "monthly"],
      [999, 0, 7, "2026-02-28", "yearly"],
      [24000, 0, 4, "2028-02-29", "yearly"],
      [123456.78, 13.5, 36, "2026-06-30", "yearly"],
    ];

    for (const [principal, rate, tenure, start, period] of cases) {
      const schedule = generateInstallmentSchedule(principal, rate, tenure, start, period);
      expect(schedule, `${principal} @ ${rate} for ${tenure} from ${start}`).toHaveLength(tenure);
      expect(sum(schedule, "principalAmount"), `${principal} @ ${rate} for ${tenure}`).toBe(principal);
    }
  });

  it("keeps the due date on the same day of the month", () => {
    const schedule = generateInstallmentSchedule(12000, 0, 3, "2026-01-15", "yearly");
    expect(schedule.map((i) => i.dueDate)).toEqual([
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
    ]);
  });

  it("clamps instead of overflowing when starting on the 29th-31st", () => {
    // The old implementation used Date.setMonth(), which turned "Feb 31" into
    // Mar 3 and silently skipped a month.
    const fromJan31 = generateInstallmentSchedule(12000, 0, 4, "2026-01-31", "yearly");
    expect(fromJan31.map((i) => i.dueDate)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);

    const fromMar31 = generateInstallmentSchedule(12000, 0, 4, "2026-03-31", "yearly");
    expect(fromMar31.map((i) => i.dueDate)).toEqual([
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
    ]);

    // 31st -> February in a leap year
    const leap = generateInstallmentSchedule(12000, 0, 2, "2028-01-31", "yearly");
    expect(leap.map((i) => i.dueDate)).toEqual(["2028-02-29", "2028-03-31"]);
  });

  it("produces identical schedules regardless of host timezone", () => {
    const schedule = generateInstallmentSchedule(100000, 12, 12, "2026-01-15", "yearly");
    // Dates are ISO strings built from UTC parts, so nothing here should ever
    // shift by a day when the server's TZ changes. (Checked against
    // Asia/Kolkata and America/New_York when this fix landed.)
    expect(schedule[0].dueDate).toBe("2026-02-15");
    expect(schedule.at(-1)!.dueDate).toBe("2027-01-15");
  });

  it("leaves a zero balance on the final row and clears the loan exactly once", () => {
    const schedule = generateInstallmentSchedule(100000, 12, 12, "2026-01-15", "yearly");
    const nonFinal = schedule.slice(0, -1);
    expect(nonFinal.every((i) => i.remainingPrincipal > 0)).toBe(true);
    expect(schedule.at(-1)!.remainingPrincipal).toBe(0);
  });

  it("returns nothing for a non-positive tenure instead of looping forever", () => {
    expect(generateInstallmentSchedule(1000, 12, 0, "2026-01-01", "yearly")).toEqual([]);
    expect(generateInstallmentSchedule(1000, 12, -3, "2026-01-01", "yearly")).toEqual([]);
  });

  it("gives one month's interest for a one-month loan", () => {
    const [only] = generateInstallmentSchedule(50000, 18, 1, "2026-08-31", "yearly");
    expect(only.dueDate).toBe("2026-09-30");
    expect(only.principalAmount).toBe(50000);
    expect(only.interestAmount).toBe(750);
    expect(only.totalAmount).toBe(50750);
  });
});

describe("calculateTotalInterest", () => {
  it("matches the sum of the schedule's interest rows", () => {
    const schedule = generateInstallmentSchedule(100000, 12, 12, "2026-01-15", "yearly");
    expect(calculateTotalInterest(100000, 12, 12, "yearly")).toBe(sum(schedule, "interestAmount"));
  });

  it("is zero without interest", () => {
    expect(calculateTotalInterest(50000, 0, 10, "yearly")).toBe(0);
  });
});

describe("computeInstallmentStatus", () => {
  const past = "2020-01-01";
  const future = "2099-01-01";

  it("reports paid when both buckets are covered", () => {
    expect(computeInstallmentStatus(past, 1000, 100, 1000, 100)).toBe("paid");
  });

  it("tolerates a paisa of float noise on the paid check", () => {
    expect(computeInstallmentStatus(past, 1000, 100, 1000, 99.995)).toBe("paid");
  });

  it("distinguishes overdue, partial and pending", () => {
    expect(computeInstallmentStatus(past, 1000, 100, 0, 0)).toBe("overdue");
    expect(computeInstallmentStatus(past, 1000, 100, 500, 0)).toBe("partially_paid");
    expect(computeInstallmentStatus(future, 1000, 100, 0, 0)).toBe("pending");
  });
});
