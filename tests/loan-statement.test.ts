import { describe, expect, it } from "vitest";
import {
  paymentReceiptText,
  statementText,
  statementTotals,
  type StatementInstallment,
} from "@/lib/loan-statement";

/**
 * The statement's arithmetic.
 *
 * This is the sheet a person may show someone else, so the edges are the whole
 * point: money written off must stop being owed, a part payment must leave a
 * remainder rather than vanish, and an overpayment must not create a credit
 * against the next EMI.
 */
const inst = (overrides: Partial<StatementInstallment> = {}): StatementInstallment => ({
  installmentNumber: 1,
  dueDate: "2026-01-01",
  principalAmount: "1000.00",
  interestAmount: "100.00",
  totalAmount: "1100.00",
  principalPaid: "0",
  interestPaid: "0",
  principalWaived: "0",
  interestWaived: "0",
  ...overrides,
});

const loan = {
  borrowerName: "Sunita Devi",
  lenderName: "Settlement Test Lender",
  amount: "2000",
  interestRate: "12",
  interestRatePeriod: "yearly",
  tenureMonths: 2,
  startDate: "2026-01-01",
  status: "active",
};

describe("statementTotals", () => {
  it("nothing paid: everything scheduled is outstanding", () => {
    const totals = statementTotals([inst(), inst({ installmentNumber: 2 })]);
    expect(totals).toEqual({
      scheduled: 2200,
      paid: 0,
      waived: 0,
      outstanding: 2200,
      principal: 2000,
      interest: 200,
    });
  });

  it("a part payment leaves the rest owed", () => {
    const totals = statementTotals([
      inst({ principalPaid: "400", interestPaid: "100" }),
      inst({ installmentNumber: 2 }),
    ]);
    expect(totals.paid).toBe(500);
    expect(totals.outstanding).toBe(600 + 1100);
  });

  it("waived money is not owed", () => {
    // Interest given up when a loan is settled early.
    const totals = statementTotals([inst({ interestWaived: "100", principalPaid: "1000" })]);
    expect(totals.waived).toBe(100);
    expect(totals.outstanding).toBe(0);
  });

  it("a written-off loan totals zero, not the balance", () => {
    const totals = statementTotals([
      inst({ principalWaived: "1000", interestWaived: "100" }),
      inst({ installmentNumber: 2, principalWaived: "1000", interestWaived: "100" }),
    ]);
    expect(totals.outstanding).toBe(0);
    expect(totals.waived).toBe(2200);
    expect(totals.paid).toBe(0);
  });

  it("an overpayment on one EMI is not a credit against the next", () => {
    const totals = statementTotals([
      inst({ principalPaid: "1500", interestPaid: "200" }), // ₹600 over
      inst({ installmentNumber: 2 }),
    ]);
    expect(totals.outstanding).toBe(1100); // still the whole second EMI
  });

  it("rounds to paise, once, at the end", () => {
    const totals = statementTotals([
      inst({ principalAmount: "333.33", interestAmount: "33.33", totalAmount: "366.66" }),
      inst({ principalAmount: "333.33", interestAmount: "33.33", totalAmount: "366.66" }),
      inst({ principalAmount: "333.34", interestAmount: "33.34", totalAmount: "366.68" }),
    ]);
    expect(totals.principal).toBe(1000);
    expect(totals.interest).toBe(100);
    expect(totals.scheduled).toBe(1100);
  });

  it("survives a missing waiver field", () => {
    const totals = statementTotals([
      {
        installmentNumber: 1,
        dueDate: "2026-01-01",
        principalAmount: "500",
        interestAmount: "0",
        totalAmount: "500",
        principalPaid: "500",
        interestPaid: "0",
      },
    ]);
    expect(totals.outstanding).toBe(0);
    expect(totals.paid).toBe(500);
  });
});

describe("statementText", () => {
  it("reads as a message and names the counterparty", () => {
    const text = statementText(loan, [inst(), inst({ installmentNumber: 2 })], [], "lender");
    expect(text).toContain("lent to Sunita Devi");
    expect(text).toContain("Still owed: ₹2,200");
    expect(text).toContain("Status: running");
  });

  it("switches sides for a borrower", () => {
    const text = statementText(loan, [inst()], [], "borrower");
    expect(text).toContain("borrowed from Settlement Test Lender");
  });

  it("counts only confirmed payments as paid", () => {
    const text = statementText(
      loan,
      [inst()],
      [
        { amount: "1100", paymentType: "both", status: "pending", createdAt: "2026-02-01T00:00:00Z" },
        { amount: "500", paymentType: "both", status: "confirmed", createdAt: "2026-02-02T00:00:00Z" },
      ],
      "lender"
    );
    expect(text).toContain("(1 payment)");
  });

  it("mentions a waiver only when there was one", () => {
    expect(statementText(loan, [inst()], [], "lender")).not.toContain("Waived:");
    expect(
      statementText(loan, [inst({ interestWaived: "100", principalPaid: "1000" })], [], "lender")
    ).toContain("Waived: ₹100");
  });
});

describe("paymentReceiptText", () => {
  it("says who paid whom and when", () => {
    const text = paymentReceiptText(
      loan,
      {
        amount: "1100",
        paymentType: "both",
        status: "confirmed",
        notes: "cash",
        createdAt: "2026-02-01T10:00:00.000Z",
      },
      "lender"
    );
    expect(text).toContain("Received from Sunita Devi: ₹1,100");
    expect(text).toContain("Date: 2026-02-01");
    expect(text).toContain("Note: cash");
  });

  it("speaks from the payer's side too", () => {
    const text = paymentReceiptText(
      loan,
      { amount: "500", paymentType: "interest", status: "pending", createdAt: "not-a-date" },
      "borrower"
    );
    expect(text).toContain("Paid to Settlement Test Lender: ₹500");
    expect(text).toContain("Date: not-a-date");
  });
});
