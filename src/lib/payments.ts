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
 *
 * Waived money counts as settled: it is no longer owed by anyone, so an EMI the
 * lender wrote off must stop showing up as overdue in the schedule and in the
 * reminder sweep. `principalWaived`/`interestWaived` are optional so callers
 * holding a pre-0005 row (or a test fixture) still work.
 */
/**
 * The payments sitting on this viewer's confirmation.
 *
 * In 2-side mode a marked payment is a *claim*: it reaches the schedule only
 * once the other side confirms, and until then the EMI is still open and the
 * person who paid is waiting on an answer. The marker may confirm their own
 * payment in exactly one case - when there is nobody else on the loan to ask
 * (the counterparty never joined Udhaar), because otherwise it would sit
 * pending forever. Both the loan screen's payment list and the "waiting for
 * your yes" card at the top of it come from here, so they can never disagree
 * about what is waiting.
 */
export function awaitingConfirmation<T extends { markedByUserId: string; status: string }>(
  payments: T[],
  viewerId: string | null | undefined,
  noCounterparty: boolean
): T[] {
  return payments.filter(
    (payment) =>
      payment.status === "pending" && (payment.markedByUserId !== viewerId || noCounterparty)
  );
}

/**
 * Which notification carries a payment this viewer has to answer.
 *
 * A "payment_marked" notification is the moment someone learns that money has
 * been claimed against their loan and that it is their turn. The notification
 * row itself has no payment id (the reminders table records *what was said*,
 * not what it was about), so the API finds the pending payment on the same
 * installment and attaches it - but only when answering is actually this
 * viewer's job, because offering Confirm on a payment you made yourself gets a
 * 403 from the API and would read as a bug.
 *
 * Pure, and tested, because "whose turn is it" is the same question
 * awaitingConfirmation() answers on the loan screen; the two must agree.
 */
export interface PendingPaymentRef {
  installmentId: string | null;
  markedByUserId: string;
}

export function pendingPaymentByInstallment<T extends PendingPaymentRef>(
  pending: T[],
  viewerId: string | null | undefined
): Map<string, T> {
  const byInstallment = new Map<string, T>();
  for (const payment of pending) {
    // Someone else's claim on this installment: it is waiting for this viewer.
    if (!payment.installmentId || payment.markedByUserId === viewerId) continue;
    byInstallment.set(payment.installmentId, payment);
  }
  return byInstallment;
}

export function remainingFor(inst: {
  principalAmount: string;
  interestAmount: string;
  principalPaid: string;
  interestPaid: string;
  principalWaived?: string | null;
  interestWaived?: string | null;
}): {
  principalRemaining: number;
  interestRemaining: number;
  totalRemaining: number;
  principalWaived: number;
  interestWaived: number;
} {
  const principalWaived = Math.max(0, round2(parseFloat(inst.principalWaived ?? "0") || 0));
  const interestWaived = Math.max(0, round2(parseFloat(inst.interestWaived ?? "0") || 0));
  const principalRemaining = Math.max(
    0,
    round2(parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid) - principalWaived)
  );
  const interestRemaining = Math.max(
    0,
    round2(parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid) - interestWaived)
  );
  return {
    principalRemaining,
    interestRemaining,
    totalRemaining: round2(principalRemaining + interestRemaining),
    principalWaived,
    interestWaived,
  };
}

/** One EMI as the payoff planner sees it (already net of payments and waivers). */
export interface PayoffInstallment {
  installmentNumber: number;
  principalRemaining: number;
  interestRemaining: number;
}

export interface PayoffPlan {
  ok: boolean;
  error?: string;
  /** Interest to apply, index-aligned with the installments passed in. */
  interest: number[];
  /** Principal to apply, index-aligned with the installments passed in. */
  principal: number[];
  /** Amount that will be applied to the ledger (never more than what's owed). */
  applied: number;
  /** Money received that nothing is owed against - recorded, not applied. */
  unapplied: number;
  /**
   * Interest forgiven because this payment settles the principal. This is the
   * app's settlement rule, and the caller records it on the EMIs so the close
   * report can say "₹X interest waived" instead of pretending it vanished.
   */
  waivedInterest: number;
  /** True when this payment leaves no principal outstanding. */
  settlesLoan: boolean;
}

/** Distributes `left` (in paise) across `targets` (paise), left to right. */
function takeCents(left: number, targets: number[]): { taken: number[]; left: number } {
  const taken = targets.map(() => 0);
  let remaining = left;
  for (let i = 0; i < targets.length && remaining > 0; i += 1) {
    const amount = Math.min(remaining, targets[i]);
    taken[i] = amount;
    remaining -= amount;
  }
  return { taken, left: remaining };
}

/**
 * Plans a single payment that settles a whole loan - the thing a borrower does
 * when they clear everything in one UPI transfer, and which the per-EMI payment
 * screen cannot express (any amount above one EMI's remainder is refused).
 *
 * Oldest EMI first, exactly to the paisa, and the plan always accounts for
 * every rupee received: applied + unapplied === amount. Three outcomes:
 *
 *   • covers everything owed      → every EMI settled, nothing waived
 *   • covers the principal        → principal settled, the interest left over
 *                                   is waived (settling early shouldn't bill
 *                                   for interest that never accrued)
 *   • covers only part of it      → an ordinary partial payment, oldest first
 */
export function planPayoff(amount: number, installments: PayoffInstallment[]): PayoffPlan {
  const empty: PayoffPlan = {
    ok: false,
    interest: installments.map(() => 0),
    principal: installments.map(() => 0),
    applied: 0,
    unapplied: 0,
    waivedInterest: 0,
    settlesLoan: false,
  };

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ...empty, error: "Amount must be a positive number" };
  }

  const principalTargets = installments.map((i) => Math.max(0, Math.round(i.principalRemaining * 100)));
  const interestTargets = installments.map((i) => Math.max(0, Math.round(i.interestRemaining * 100)));
  const totalPrincipal = principalTargets.reduce((a, b) => a + b, 0);
  const totalInterest = interestTargets.reduce((a, b) => a + b, 0);

  if (totalPrincipal + totalInterest <= 0) {
    return { ...empty, error: "Nothing is owed on this loan any more." };
  }

  // Interleaved oldest-first, interest before principal on each EMI - the same
  // order the per-EMI "Full" button uses, so one big payment and many small
  // ones leave the ledger in the same shape.
  const interleaved: number[] = [];
  for (let i = 0; i < installments.length; i += 1) {
    interleaved.push(interestTargets[i], principalTargets[i]);
  }

  const amountCents = Math.round(amount * 100);

  // Everything (or more than everything) they owe.
  if (amountCents >= totalPrincipal + totalInterest) {
    const { taken, left } = takeCents(amountCents, interleaved);
    const interest: number[] = [];
    const principal: number[] = [];
    for (let i = 0; i < installments.length; i += 1) {
      interest.push(taken[i * 2] / 100);
      principal.push(taken[i * 2 + 1] / 100);
    }
    return {
      ok: true,
      interest,
      principal,
      applied: (amountCents - left) / 100,
      unapplied: left / 100,
      waivedInterest: 0,
      settlesLoan: true,
    };
  }

  // The principal is covered, so the loan is settled. Whatever the payment does
  // not reach of the interest is waived rather than left hanging over a loan
  // that is about to close.
  if (amountCents >= totalPrincipal) {
    const principalPass = takeCents(amountCents, principalTargets);
    const interestPass = takeCents(principalPass.left, interestTargets);
    const interestPaid = interestPass.taken.reduce((a, b) => a + b, 0);
    return {
      ok: true,
      interest: interestPass.taken.map((c) => c / 100),
      principal: principalPass.taken.map((c) => c / 100),
      applied: (principalPass.taken.reduce((a, b) => a + b, 0) + interestPaid) / 100,
      unapplied: 0,
      waivedInterest: round2((totalInterest - interestPaid) / 100),
      settlesLoan: true,
    };
  }

  // A part payment against the whole loan: clear the oldest EMI first.
  const { taken, left } = takeCents(amountCents, interleaved);
  const interest: number[] = [];
  const principal: number[] = [];
  for (let i = 0; i < installments.length; i += 1) {
    interest.push(taken[i * 2] / 100);
    principal.push(taken[i * 2 + 1] / 100);
  }
  return {
    ok: true,
    interest,
    principal,
    applied: (amountCents - left) / 100,
    unapplied: left / 100,
    waivedInterest: 0,
    settlesLoan: false,
  };
}

/** One EMI as the loan screen sees it (amounts arrive as strings from the API). */
export interface SummaryInstallment {
  principalAmount: string | number;
  interestAmount: string | number;
  principalPaid: string | number;
  interestPaid: string | number;
  principalWaived?: string | number | null;
  interestWaived?: string | number | null;
}

export interface SettlementSummary {
  /** Scheduled totals, for the "₹X of ₹Y" line. */
  principalTotal: number;
  interestTotal: number;
  principalPaid: number;
  principalWaived: number;
  interestPaid: number;
  interestWaived: number;
  totalWaived: number;
  principalOutstanding: number;
  interestOutstanding: number;
  loanOutstanding: number;
  /** Share of the principal that is settled (paid *or* waived), 0-100. */
  principalProgressPercent: number;
  /** Is there still something to settle, on a loan that is not closed? */
  canSettleInFull: boolean;
}

function num(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : parseFloat(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/**
 * The numbers the loan screen shows.
 *
 * Two rules keep it honest:
 *
 *   - **waived money counts as settled, never as paid.** A loan that was
 *     written off is finished, but the waiver is reported separately so a
 *     glance at the screen cannot mistake it for money that arrived.
 *   - **nothing reads as owed once it is settled.** Outstanding amounts are
 *     clamped at zero, so float noise (or a stored value from before a
 *     waiver) can never show "₹0.01 still due" on a finished loan, or keep a
 *     "Settle in full" button on a closed one.
 */
export function summarizeSettlement(
  installments: SummaryInstallment[],
  loanStatus: string
): SettlementSummary {
  let principalAmount = 0;
  let interestAmount = 0;
  let principalPaid = 0;
  let interestPaid = 0;
  let principalWaived = 0;
  let interestWaived = 0;

  for (const inst of installments) {
    principalAmount += num(inst.principalAmount);
    interestAmount += num(inst.interestAmount);
    principalPaid += num(inst.principalPaid);
    interestPaid += num(inst.interestPaid);
    // An EMI that carries a negative waiver is not a thing the app writes,
    // but a hand-edited row must not turn into free money on screen either.
    principalWaived += Math.max(0, num(inst.principalWaived));
    interestWaived += Math.max(0, num(inst.interestWaived));
  }

  const principalOutstanding = Math.max(0, round2(principalAmount - principalPaid - principalWaived));
  const interestOutstanding = Math.max(0, round2(interestAmount - interestPaid - interestWaived));

  return {
    principalTotal: round2(principalAmount),
    interestTotal: round2(interestAmount),
    principalPaid: round2(principalPaid),
    principalWaived: round2(principalWaived),
    interestPaid: round2(interestPaid),
    interestWaived: round2(interestWaived),
    totalWaived: round2(principalWaived + interestWaived),
    principalOutstanding,
    interestOutstanding,
    loanOutstanding: round2(principalOutstanding + interestOutstanding),
    principalProgressPercent:
      principalAmount > 0
        ? Math.round(((principalPaid + principalWaived) / principalAmount) * 100)
        : 0,
    canSettleInFull: loanStatus === "active" && principalOutstanding + interestOutstanding > EPSILON,
  };
}
