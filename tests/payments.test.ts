import { describe, expect, it } from "vitest";
import {
  allocatePayment,
  awaitingConfirmation,
  pendingPaymentByInstallment,
  planPayoff,
  remainingFor,
  summarizeSettlement,
} from "@/lib/payments";

/**
 * These are the exact scenarios that used to silently lose money: the API
 * validated the payment against the combined EMI total and then clamped each
 * bucket with Math.min(), so a payment could be recorded in full while only
 * part (or none) of it reached the ledger.
 */
describe("allocatePayment", () => {
  const emi = { principalRemaining: 1000, interestRemaining: 100 };

  it("rejects a 'principal' payment that eats into the interest bucket", () => {
    const result = allocatePayment({ amount: 1100, paymentType: "principal", ...emi });
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(1000);
    expect(result.error).toMatch(/principal/i);
  });

  it("rejects a payment against an already-cleared bucket", () => {
    const interest = allocatePayment({
      amount: 100,
      paymentType: "principal",
      principalRemaining: 0,
      interestRemaining: 100,
    });
    expect(interest.ok).toBe(false);
    expect(interest.error).toMatch(/already fully paid/i);

    const principal = allocatePayment({
      amount: 1000,
      paymentType: "interest",
      principalRemaining: 1000,
      interestRemaining: 0,
    });
    expect(principal.ok).toBe(false);
    expect(principal.error).toMatch(/already fully paid/i);
  });

  it("records exactly what it applies for every accepted payment", () => {
    const accepted = [
      { amount: 100, paymentType: "interest" as const, principalRemaining: 1000, interestRemaining: 100 },
      { amount: 1000, paymentType: "principal" as const, principalRemaining: 1000, interestRemaining: 100 },
      { amount: 1100, paymentType: "both" as const, principalRemaining: 1000, interestRemaining: 100 },
      { amount: 250, paymentType: "both" as const, principalRemaining: 1000, interestRemaining: 100 },
      { amount: 40, paymentType: "interest" as const, principalRemaining: 350, interestRemaining: 60 },
    ];

    for (const case_ of accepted) {
      const result = allocatePayment(case_);
      expect(result.ok, JSON.stringify(case_)).toBe(true);
      expect(result.applied, JSON.stringify(case_)).toBeCloseTo(case_.amount, 2);
      expect(result.principalPayment + result.interestPayment).toBeCloseTo(result.applied, 2);
    }
  });

  it("settles interest first on a 'both' payment", () => {
    const result = allocatePayment({
      amount: 250,
      paymentType: "both",
      principalRemaining: 1000,
      interestRemaining: 100,
    });
    expect(result.interestPayment).toBe(100);
    expect(result.principalPayment).toBe(150);
  });

  it("allows paying the exact remainder of the EMI", () => {
    const result = allocatePayment({ amount: 1100, paymentType: "both", ...emi });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1100);
  });

  it("rejects zero, negative and non-numeric amounts", () => {
    for (const amount of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(allocatePayment({ amount, paymentType: "both", ...emi }).ok).toBe(false);
    }
  });

  it("treats an over-paid bucket as empty rather than negative", () => {
    const result = allocatePayment({
      amount: 10,
      paymentType: "interest",
      principalRemaining: 0,
      interestRemaining: -0.004,
    });
    expect(result.ok).toBe(false);
  });
});

describe("remainingFor", () => {
  it("subtracts paid amounts and keeps two decimals", () => {
    expect(
      remainingFor({
        principalAmount: "1000.00",
        interestAmount: "100.00",
        principalPaid: "250.005",
        interestPaid: "0.00",
      })
    ).toMatchObject({ principalRemaining: 750, interestRemaining: 100, totalRemaining: 850 });
  });

  it("treats waived money as settled, not as still owed", () => {
    const remaining = remainingFor({
      principalAmount: "1000.00",
      interestAmount: "100.00",
      principalPaid: "1000.00",
      interestPaid: "0.00",
      principalWaived: "0.00",
      interestWaived: "100.00",
    });

    expect(remaining.interestRemaining).toBe(0);
    expect(remaining.totalRemaining).toBe(0);
    expect(remaining.interestWaived).toBe(100);
  });

  it("never lets paid + waived read as more than the EMI", () => {
    const remaining = remainingFor({
      principalAmount: "1000.00",
      interestAmount: "100.00",
      principalPaid: "1200.00",
      interestPaid: "0.00",
      principalWaived: "0.00",
      interestWaived: "0.00",
    });

    expect(remaining.principalRemaining).toBe(0);
  });

  it("never reports a negative remainder", () => {
    const { principalRemaining, interestRemaining } = remainingFor({
      principalAmount: "1000.00",
      interestAmount: "100.00",
      principalPaid: "1200.00",
      interestPaid: "100.00",
    });
    expect(principalRemaining + interestRemaining).toBe(0);
  });
});

describe("planPayoff", () => {
  // ₹12,000 over 3 months at 12%/yr - the shape of a real informal loan.
  const schedule = [
    { installmentNumber: 1, principalRemaining: 3960.27, interestRemaining: 120 },
    { installmentNumber: 2, principalRemaining: 3999.87, interestRemaining: 80.4 },
    { installmentNumber: 3, principalRemaining: 4039.86, interestRemaining: 40.4 },
  ];
  const total = 12240.8;

  it("settles every EMI when the whole loan is paid", () => {
    const plan = planPayoff(total, schedule);

    expect(plan.ok).toBe(true);
    expect(plan.settlesLoan).toBe(true);
    expect(plan.waivedInterest).toBe(0);
    expect(plan.unapplied).toBe(0);
    expect(plan.applied).toBeCloseTo(total, 2);
    expect(plan.interest).toEqual([120, 80.4, 40.4]);
    expect(plan.principal).toEqual([3960.27, 3999.87, 4039.86]);
  });

  it("settles the principal alone and waives the interest it never reached", () => {
    const plan = planPayoff(12000, schedule);

    expect(plan.settlesLoan).toBe(true);
    expect(plan.applied).toBe(12000);
    expect(plan.principal).toEqual([3960.27, 3999.87, 4039.86]);
    expect(plan.waivedInterest).toBeCloseTo(240.8, 2);
    expect(plan.unapplied).toBe(0);
  });

  it("puts anything above the principal towards the interest, not the void", () => {
    const plan = planPayoff(12100, schedule);

    expect(plan.settlesLoan).toBe(true);
    expect(plan.applied).toBe(12100);
    // ₹100 of the ₹240.80 interest is paid, the rest is forgiven.
    expect(plan.interest.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
    expect(plan.waivedInterest).toBeCloseTo(140.8, 2);
  });

  it("records money it cannot apply instead of swallowing it", () => {
    const plan = planPayoff(12250, schedule);

    expect(plan.settlesLoan).toBe(true);
    expect(plan.applied).toBeCloseTo(total, 2);
    expect(plan.unapplied).toBeCloseTo(9.2, 2);
    // The invariant the whole money path rests on.
    expect(plan.applied + plan.unapplied).toBeCloseTo(12250, 2);
  });

  it("is an ordinary part payment below the principal, oldest EMI first", () => {
    const plan = planPayoff(5000, schedule);

    expect(plan.settlesLoan).toBe(false);
    expect(plan.waivedInterest).toBe(0);
    expect(plan.unapplied).toBe(0);
    expect(plan.applied).toBe(5000);
    // EMI 1 cleared entirely (interest then principal), then EMI 2's interest,
    // and what is left goes on EMI 2's principal. Same order as one EMI at a
    // time would have produced.
    expect(plan.interest[0]).toBe(120);
    expect(plan.principal[0]).toBe(3960.27);
    expect(plan.interest[1]).toBe(80.4);
    expect(plan.principal[1]).toBeCloseTo(839.33, 2);
    expect(plan.interest[2]).toBe(0);
    expect(plan.principal[2]).toBe(0);
  });

  it("keeps every paisa accounted for, whatever the amount", () => {
    for (const amount of [0.01, 1, 999.99, 4080.27, 12000, 12240.8, 12240.81, 20000]) {
      const plan = planPayoff(amount, schedule);
      const applied = plan.applied + plan.unapplied;
      expect(applied, `amount ${amount}`).toBeCloseTo(amount, 2);
      if (!plan.settlesLoan) expect(plan.waivedInterest).toBe(0);
    }
  });

  it("refuses an amount that is not money, and a loan with nothing left", () => {
    expect(planPayoff(0, schedule).ok).toBe(false);
    expect(planPayoff(-5, schedule).ok).toBe(false);
    expect(
      planPayoff(100, [{ installmentNumber: 1, principalRemaining: 0, interestRemaining: 0 }]).ok
    ).toBe(false);
  });

  it("handles a single-EMI loan and an interest-free one", () => {
    const oneEmi = [{ installmentNumber: 1, principalRemaining: 5000, interestRemaining: 0 }];
    const plan = planPayoff(5000, oneEmi);
    expect(plan.settlesLoan).toBe(true);
    expect(plan.waivedInterest).toBe(0);
    expect(plan.principal).toEqual([5000]);
  });

  it("leaves a one-paisa-short payment open for the close tolerance to settle", () => {
    // The app treats a paisa as float noise (see closeLoanIfSettled), so this
    // stays a part payment here and the tiny remainder is cleaned up on close.
    const plan = planPayoff(11999.99, schedule);
    expect(plan.settlesLoan).toBe(false);
    expect(plan.applied).toBe(11999.99);
  });
});

/**
 * What the loan screen shows. The bug being guarded against is a settled or
 * written-off loan still looking like it owes money - an "OVERDUE" EMI, a
 * non-100% progress bar, or a "Settle in full" button that refuses to go away.
 */
describe("summarizeSettlement", () => {
  const emi = (over: Partial<Record<string, string>> = {}) => ({
    principalAmount: "4000",
    interestAmount: "80.40",
    principalPaid: "0",
    interestPaid: "0",
    principalWaived: "0",
    interestWaived: "0",
    ...over,
  });

  it("adds up an untouched loan", () => {
    const s = summarizeSettlement([emi(), emi(), emi()], "active");
    expect(s.principalTotal).toBe(12000);
    expect(s.interestTotal).toBe(241.2);
    expect(s.principalOutstanding).toBe(12000);
    expect(s.interestOutstanding).toBe(241.2);
    expect(s.loanOutstanding).toBe(12241.2);
    expect(s.principalProgressPercent).toBe(0);
    expect(s.canSettleInFull).toBe(true);
  });

  it("counts waived money as settled without calling it paid", () => {
    const s = summarizeSettlement(
      [emi({ interestWaived: "80.40" }), emi({ interestWaived: "80.40" }), emi({ interestWaived: "80.40" })],
      "closed"
    );
    expect(s.principalPaid).toBe(0);
    expect(s.interestPaid).toBe(0);
    expect(s.interestWaived).toBe(241.2);
    expect(s.totalWaived).toBe(241.2);
    expect(s.interestOutstanding).toBe(0);
    expect(s.loanOutstanding).toBe(12000);
  });

  it("reports a written-off loan as settled, and remembers what was forgiven", () => {
    const s = summarizeSettlement(
      [
        emi({ principalPaid: "4000", interestPaid: "80.40" }),
        emi({ principalWaived: "4000", interestWaived: "80.40" }),
        emi({ principalWaived: "4000", interestWaived: "80.40" }),
      ],
      "closed"
    );
    expect(s.loanOutstanding).toBe(0);
    expect(s.principalOutstanding).toBe(0);
    expect(s.totalWaived).toBe(8160.8);
    expect(s.principalProgressPercent).toBe(100);
    expect(s.canSettleInFull).toBe(false);
  });

  it("shows a fully repaid loan as fully paid, with nothing waived", () => {
    const s = summarizeSettlement(
      [
        emi({ principalPaid: "4000", interestPaid: "80.40" }),
        emi({ principalPaid: "4000", interestPaid: "80.40" }),
        emi({ principalPaid: "4000", interestPaid: "80.40" }),
      ],
      "closed"
    );
    expect(s.loanOutstanding).toBe(0);
    expect(s.totalWaived).toBe(0);
    expect(s.principalProgressPercent).toBe(100);
  });

  it("never lets a settled loan read as owing a paisa", () => {
    // Float noise on a fully settled schedule must not resurrect a debt.
    const s = summarizeSettlement(
      [emi({ principalPaid: "3999.996", interestPaid: "80.4", principalWaived: "0.004" })],
      "closed"
    );
    expect(s.principalOutstanding).toBe(0);
    expect(s.interestOutstanding).toBe(0);
    expect(s.loanOutstanding).toBe(0);
  });

  it("clamps an overpaid row at zero instead of showing a negative debt", () => {
    const s = summarizeSettlement([emi({ principalPaid: "4001", interestPaid: "100" })], "closed");
    expect(s.principalOutstanding).toBe(0);
    expect(s.interestOutstanding).toBe(0);
  });

  it("ignores a negative waiver rather than treating it as free money", () => {
    const s = summarizeSettlement([emi({ principalWaived: "-1000" })], "active");
    expect(s.principalWaived).toBe(0);
    expect(s.principalOutstanding).toBe(4000);
  });

  it("offers 'settle in full' only while the loan is open and owes something", () => {
    expect(summarizeSettlement([emi()], "active").canSettleInFull).toBe(true);
    expect(summarizeSettlement([emi()], "closed").canSettleInFull).toBe(false);
    expect(
      summarizeSettlement([emi({ principalPaid: "4000", interestPaid: "80.40" })], "active")
        .canSettleInFull
    ).toBe(false);
  });

  it("handles an empty schedule without dividing by zero", () => {
    const s = summarizeSettlement([], "active");
    expect(s.principalProgressPercent).toBe(0);
    expect(s.loanOutstanding).toBe(0);
    expect(s.canSettleInFull).toBe(false);
  });

  it("accepts the strings and numbers the API mixes together", () => {
    const s = summarizeSettlement(
      [{ ...emi({ principalPaid: "2000" }), interestPaid: 80.4, principalWaived: null, interestWaived: undefined }],
      "active"
    );
    expect(s.principalOutstanding).toBe(2000);
    expect(s.interestOutstanding).toBe(0);
    expect(s.totalWaived).toBe(0);
  });
});

/**
 * What is waiting on someone's yes. Worth its own tests because getting it
 * wrong is invisible in the worst way: too strict and a claim sits pending
 * forever against a counterparty who will never answer; too loose and a person
 * is offered a Confirm button for their own payment, which the API refuses.
 */
describe("awaitingConfirmation", () => {
  const pending = (markedBy: string) => ({ markedByUserId: markedBy, status: "pending" });
  const confirmed = (markedBy: string) => ({ markedByUserId: markedBy, status: "confirmed" });
  const LENDER = "user-lender";
  const BORROWER = "user-borrower";

  it("waits on the other side, not on whoever marked it", () => {
    const rows = [pending(BORROWER)];
    expect(awaitingConfirmation(rows, LENDER, false)).toEqual(rows);
    expect(awaitingConfirmation(rows, BORROWER, false)).toEqual([]);
  });

  it("waits on the marker when there is nobody else to ask", () => {
    const rows = [pending(BORROWER)];
    expect(awaitingConfirmation(rows, BORROWER, true)).toEqual(rows);
  });

  it("says nothing about payments that are already settled or rejected", () => {
    const rows = [confirmed(BORROWER), { markedByUserId: BORROWER, status: "rejected" }];
    expect(awaitingConfirmation(rows, LENDER, false)).toEqual([]);
  });

  it("ignores a payment marked by someone who is no longer a party", () => {
    // A session id that has since changed hands, or a viewer whose loan record
    // no longer names them: it is not theirs to confirm either way, but the
    // filter must not fall over deciding.
    expect(awaitingConfirmation([pending("someone-else")], LENDER, false)).toHaveLength(1);
    expect(awaitingConfirmation([pending("someone-else")], "someone-else", false)).toEqual([]);
  });

  it("copes with a viewer id that is null (a loan with one side)", () => {
    expect(awaitingConfirmation([pending("anyone")], null, true)).toHaveLength(1);
    expect(awaitingConfirmation([pending("anyone")], null, false)).toHaveLength(1);
  });
});

/**
 * The bridge between a notification and the payment it is about.
 *
 * The reminders table has no payment id, so the API matches on the installment
 * - and the only thing that must never happen is offering somebody the Confirm
 * button for their own claim, which the API answers with 403. That rule lives
 * here, in one place, next to the loan screen's version of the same question.
 */
describe("pendingPaymentByInstallment", () => {
  const claim = (installmentId: string | null, markedByUserId: string) => ({
    installmentId,
    markedByUserId,
  });
  const ME = "user-me";
  const THEM = "user-them";

  it("matches a claim waiting on this viewer", () => {
    const map = pendingPaymentByInstallment([claim("emi-1", THEM)], ME);
    expect(map.get("emi-1")).toEqual(claim("emi-1", THEM));
  });

  it("leaves out the viewer's own claim, which is not theirs to confirm", () => {
    const map = pendingPaymentByInstallment([claim("emi-1", ME)], ME);
    expect(map.size).toBe(0);
  });

  it("ignores a payment with no installment to match on", () => {
    expect(pendingPaymentByInstallment([claim(null, THEM)], ME).size).toBe(0);
  });

  it("keeps one claim per installment, so two emis do not collide", () => {
    const map = pendingPaymentByInstallment(
      [claim("emi-1", THEM), claim("emi-2", THEM), claim("emi-2", ME)],
      ME
    );
    expect([...map.keys()].sort()).toEqual(["emi-1", "emi-2"]);
    expect(map.get("emi-2")).toEqual(claim("emi-2", THEM));
  });

  it("does nothing at all when there are no pending payments", () => {
    expect(pendingPaymentByInstallment([], ME).size).toBe(0);
  });
});
