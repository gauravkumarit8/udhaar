/**
 * Applying a payoff plan to the ledger.
 *
 * Shared by the two places a whole-loan payment can land: `POST
 * /api/loans/[id]/payoff` (1-side, applied immediately) and `PATCH
 * /api/payments/[id]/confirm` (2-side, applied when the other side confirms).
 * Both must move money the same way, or the two modes would disagree about what
 * a settlement means.
 */
import { sql } from "drizzle-orm";
import { closeLoanIfSettled, getOutstanding, type Outstanding, type SqlRunner } from "@/lib/loans";
import type { PayoffPlan } from "@/lib/payments";

/** Thrown when a concurrent payment took the money first. */
export const PAYMENT_CONFLICT = "PAYMENT_CONFLICT";

export interface PayoffTarget {
  id: string;
  installmentNumber: number;
}

export interface AppliedPayoff {
  /** What actually reached the ledger. */
  applied: number;
  /** Interest forgiven because the loan settled. */
  waivedInterest: number;
  /** Principal forgiven - only ever a rounding paisa. */
  waivedPrincipal: number;
  closed: boolean;
  outstanding: Outstanding;
}

/**
 * Applies `plan` to the installments it targets, then closes the loan when the
 * plan settles it (which is also what forgives the interest that was never
 * earned).
 *
 * Every update is a conditional SQL UPDATE, so two payments racing on the same
 * EMI cannot both win and overpay it - the loser raises PAYMENT_CONFLICT and the
 * caller turns that into a 409 rather than a ledger that disagrees with itself.
 */
export async function applyPayoff(
  loanId: string,
  plan: PayoffPlan,
  targets: PayoffTarget[],
  run: SqlRunner
): Promise<AppliedPayoff> {
  let applied = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const interest = plan.interest[i];
    const principal = plan.principal[i];
    if (interest <= 0 && principal <= 0) continue;

    const result = await run(sql`
      UPDATE installments SET
        interest_paid  = interest_paid  + ${interest.toFixed(2)}::numeric,
        principal_paid = principal_paid + ${principal.toFixed(2)}::numeric
      WHERE id = ${targets[i].id}
        AND interest_paid  + ${interest.toFixed(2)}::numeric  <= interest_amount  + 0.01
        AND principal_paid + ${principal.toFixed(2)}::numeric <= principal_amount + 0.01
      RETURNING id
    `);

    const rows = (result as { rows?: unknown[] })?.rows ?? [];
    if (rows.length === 0) throw new Error(PAYMENT_CONFLICT);

    applied += interest + principal;
  }

  if (!plan.settlesLoan) {
    const outstanding = await getOutstanding(loanId, run);
    return { applied, waivedInterest: 0, waivedPrincipal: 0, closed: false, outstanding };
  }

  const close = await closeLoanIfSettled(loanId, run);
  return {
    applied,
    waivedInterest: close.waivedInterest,
    waivedPrincipal: close.waivedPrincipal,
    closed: close.closed,
    outstanding: close.outstanding,
  };
}
