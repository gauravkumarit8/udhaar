import { describe, expect, it } from "vitest";
import { allocatePayment, remainingFor } from "@/lib/payments";

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
    ).toEqual({ principalRemaining: 750, interestRemaining: 100, totalRemaining: 850 });
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
