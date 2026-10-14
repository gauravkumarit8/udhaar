import { describe, expect, it, vi, afterEach } from "vitest";
import { pickNextDuePerLoan, type DueCandidate } from "@/lib/due-items";

/** A date `days` from today, as the API sends it (YYYY-MM-DD). */
function inDays(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function installment(overrides: Partial<DueCandidate> = {}): DueCandidate {
  return {
    loanId: "loan-1",
    borrowerName: "Rahul",
    lenderName: "Gaurav",
    installmentId: "inst-1",
    installmentNumber: 1,
    dueDate: inDays(30),
    amount: 2120,
    computedStatus: "pending",
    viewerRole: "lender",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pickNextDuePerLoan", () => {
  it("shows one row per loan instead of every installment", () => {
    const items = pickNextDuePerLoan([
      installment({ installmentId: "a", installmentNumber: 1, dueDate: inDays(30) }),
      installment({ installmentId: "b", installmentNumber: 2, dueDate: inDays(60) }),
      installment({ installmentId: "c", installmentNumber: 3, dueDate: inDays(91) }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].installmentId).toBe("a");
    expect(items[0].dueDate).toBe(inDays(30));
  });

  it("keeps a row for each separate loan", () => {
    const items = pickNextDuePerLoan([
      installment({ loanId: "loan-1", installmentId: "a", dueDate: inDays(10) }),
      installment({ loanId: "loan-1", installmentId: "b", dueDate: inDays(40) }),
      installment({ loanId: "loan-2", borrowerName: "Sneha", installmentId: "c", dueDate: inDays(5) }),
    ]);

    expect(items).toHaveLength(2);
    // Soonest first, across loans.
    expect(items.map((i) => i.loanId)).toEqual(["loan-2", "loan-1"]);
  });

  it("picks the oldest installment when a loan is behind", () => {
    const items = pickNextDuePerLoan([
      installment({ installmentId: "late-2", installmentNumber: 2, dueDate: inDays(-5), amount: 1000 }),
      installment({ installmentId: "late-1", installmentNumber: 1, dueDate: inDays(-35), amount: 2000, computedStatus: "overdue" }),
      installment({ installmentId: "future", installmentNumber: 3, dueDate: inDays(25), amount: 3000 }),
    ]);

    expect(items).toHaveLength(1);
    // The one that has been waiting longest is the one to pay.
    expect(items[0].installmentId).toBe("late-1");
    expect(items[0].amount).toBe(2000);
    expect(items[0].daysUntilDue).toBeLessThan(0);
  });

  it("summarises the further arrears on the row instead of repeating them", () => {
    const items = pickNextDuePerLoan([
      installment({ installmentId: "late-1", installmentNumber: 1, dueDate: inDays(-35), amount: 2000 }),
      installment({ installmentId: "late-2", installmentNumber: 2, dueDate: inDays(-5), amount: 1000 }),
      installment({ installmentId: "late-3", installmentNumber: 3, dueDate: inDays(-1), amount: 500.55 }),
    ]);

    expect(items[0].moreOverdueCount).toBe(2);
    expect(items[0].moreOverdueAmount).toBe(1500.55);
  });

  it("reports no further arrears on a loan that is on time", () => {
    const items = pickNextDuePerLoan([
      installment({ installmentId: "soon", dueDate: inDays(3) }),
      installment({ installmentId: "later", installmentNumber: 2, dueDate: inDays(33) }),
    ]);

    expect(items[0].moreOverdueCount).toBe(0);
    expect(items[0].moreOverdueAmount).toBe(0);
  });

  it("puts overdue loans above upcoming ones, even when due later", () => {
    const items = pickNextDuePerLoan([
      installment({ loanId: "on-time", installmentId: "a", dueDate: inDays(2) }),
      installment({ loanId: "behind", installmentId: "b", dueDate: inDays(-1), computedStatus: "overdue" }),
    ]);

    expect(items.map((i) => i.loanId)).toEqual(["behind", "on-time"]);
  });

  it("orders by due date, not by installment number", () => {
    // A re-ordered schedule (edited loan) can number an earlier date higher.
    const items = pickNextDuePerLoan([
      installment({ installmentId: "a", installmentNumber: 9, dueDate: inDays(1) }),
      installment({ installmentId: "b", installmentNumber: 2, dueDate: inDays(45) }),
    ]);

    expect(items[0].installmentId).toBe("a");
  });

  it("handles the same due date without shuffling between loads", () => {
    const candidates = [
      installment({ loanId: "loan-b", installmentId: "b", dueDate: inDays(10) }),
      installment({ loanId: "loan-a", installmentId: "a", dueDate: inDays(10) }),
    ];

    expect(pickNextDuePerLoan(candidates).map((i) => i.loanId)).toEqual(["loan-a", "loan-b"]);
    expect(pickNextDuePerLoan([...candidates].reverse()).map((i) => i.loanId)).toEqual([
      "loan-a",
      "loan-b",
    ]);
  });

  it("returns nothing for a loan with nothing outstanding", () => {
    expect(pickNextDuePerLoan([])).toEqual([]);
  });

  it("passes the party details through, so the row can be labelled", () => {
    const [item] = pickNextDuePerLoan([
      installment({ viewerRole: "borrower", lenderName: "Uncle Suresh", borrowerName: "Me" }),
    ]);

    expect(item.viewerRole).toBe("borrower");
    expect(item.lenderName).toBe("Uncle Suresh");
  });
});
