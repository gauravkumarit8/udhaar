/**
 * Payment allocation.
 *
 * One EMI has two buckets - interest and principal - and a payment can be
 * aimed at either or both. The rule this module enforces is simple and
 * non-negotiable: **the amount applied to the ledger always equals the amount
 * recorded**. Earlier versions checked only the combined EMI total and then
 * clamped each bucket with Math.min(), which let money vanish: paying ₹1,100
 * against an EMI of ₹1,000 principal + ₹100 interest while selecting
 * "Principal" recorded ₹1,100 in the payments audit trail but only applied
 * ₹1,000 - so the EMI never closed and the two records disagreed forever.
 */

export type PaymentType = "interest" | "principal" | "both";

/** Tolerance for float noise (a paisa). */
const EPSILON = 0.01;

export interface AllocationInput {
  amount: number;
  paymentType: PaymentType;
  principalRemaining: number;
  interestRemaining: number;
}

export interface Allocation {
  ok: boolean;
  /** User-facing explanation when ok === false. */
  error?: string;
  /** What's still owed in the bucket the caller aimed at (for the message). */
  remaining?: number;
  interestPayment: number;
  principalPayment: number;
  applied: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function allocatePayment({
  amount,
  paymentType,
  principalRemaining: rawPrincipalRemaining,
  interestRemaining: rawInterestRemaining,
}: AllocationInput): Allocation {
  const empty: Allocation = {
    ok: false,
    interestPayment: 0,
    principalPayment: 0,
    applied: 0,
  };

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ...empty, error: "Amount must be a positive number" };
  }

  // Never let a stored value push a remaining balance below zero.
  const principalRemaining = Math.max(0, round2(rawPrincipalRemaining));
  const interestRemaining = Math.max(0, round2(rawInterestRemaining));
  const totalRemaining = round2(principalRemaining + interestRemaining);

  const remainingForBucket =
    paymentType === "interest"
      ? interestRemaining
      : paymentType === "principal"
        ? principalRemaining
        : totalRemaining;

  if (remainingForBucket <= 0) {
    return {
      ...empty,
      remaining: 0,
      error:
        paymentType === "interest"
          ? "Interest on this EMI is already fully paid."
          : paymentType === "principal"
            ? "Principal on this EMI is already fully paid."
            : "This EMI is already fully paid.",
    };
  }

  // Validate against the bucket the user actually selected, not just the total.
  if (amount > remainingForBucket + EPSILON) {
    return {
      ...empty,
      remaining: remainingForBucket,
      error:
        paymentType === "both"
          ? `Amount exceeds what's remaining on this EMI (₹${totalRemaining.toFixed(2)}). If they overpaid, record the extra against the next EMI instead.`
          : paymentType === "interest"
            ? `Amount exceeds the interest still due on this EMI (₹${interestRemaining.toFixed(2)}). Use "Full" or "Principal" for the rest.`
            : `Amount exceeds the principal still due on this EMI (₹${principalRemaining.toFixed(2)}). Use "Full" or "Interest" for the rest.`,
    };
  }

  let interestPayment = 0;
  let principalPayment = 0;

  if (paymentType === "interest") {
    interestPayment = Math.min(amount, interestRemaining);
  } else if (paymentType === "principal") {
    principalPayment = Math.min(amount, principalRemaining);
  } else {
    // "both" - settle interest first, then principal.
    interestPayment = Math.min(amount, interestRemaining);
    principalPayment = Math.min(round2(amount - interestPayment), principalRemaining);
  }

  interestPayment = round2(interestPayment);
  principalPayment = round2(principalPayment);
  const applied = round2(interestPayment + principalPayment);

  // Belt and braces: if clamping ever makes the two disagree, refuse the
  // payment instead of writing an audit row that doesn't match the ledger.
  if (applied <= 0) {
    return { ...empty, remaining: remainingForBucket, error: "Nothing left to pay on this EMI." };
  }
  if (Math.abs(applied - amount) > EPSILON) {
    return {
      ...empty,
      remaining: remainingForBucket,
      error: `Only ₹${applied.toFixed(2)} of ₹${amount.toFixed(2)} could be applied to this EMI. Adjust the amount and try again.`,
    };
  }

  return {
    ok: true,
    interestPayment,
    principalPayment,
    applied,
  };
}

/**
 * Remaining amounts for an installment row, safely parsed and clamped at zero
 * (an over-paid bucket must never read as "negative money still owed").
 */
export function remainingFor(inst: {
  principalAmount: string;
  interestAmount: string;
  principalPaid: string;
  interestPaid: string;
}): { principalRemaining: number; interestRemaining: number; totalRemaining: number } {
  const principalRemaining = Math.max(
    0,
    round2(parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid))
  );
  const interestRemaining = Math.max(
    0,
    round2(parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid))
  );
  return {
    principalRemaining,
    interestRemaining,
    totalRemaining: round2(principalRemaining + interestRemaining),
  };
}
