/**
 * Loan-level ledger helpers shared by the payment and close routes.
 *
 * Rule of record for this app (and the one the README documents):
 *   • A loan is **settled** when the principal is fully repaid.
 *   • Interest that is still outstanding is reported back to the caller so the
 *     UI can say "closed with ₹X interest outstanding" instead of quietly
 *     leaving stale OVERDUE rows on a CLOSED loan.
 */
import { db } from "@/db";
import { sql, type SQL } from "drizzle-orm";

/**
 * Anything that can run a raw SQL statement - the pool or a transaction.
 *
 * Every statement in this module goes through the runner. An earlier version
 * read the totals through the supplied transaction but issued the "mark the
 * loan closed" UPDATE through the global pool, which meant the close could
 * commit separately from the payment that triggered it (and blew up entirely
 * on a single-connection database).
 */
export type SqlRunner = (query: SQL) => Promise<unknown>;

const runOnDb: SqlRunner = (query) => db.execute(query);

export interface Outstanding {
  totalPrincipal: number;
  paidPrincipal: number;
  principal: number;
  totalInterest: number;
  paidInterest: number;
  interest: number;
  total: number;
  /** Money the lender gave up: written off, or interest forgiven at settlement. */
  waivedPrincipal: number;
  waivedInterest: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseRows(result: unknown): Record<string, string> {
  const rows = (result as { rows?: Record<string, string>[] })?.rows;
  return rows?.[0] ?? {};
}

export async function getOutstanding(
  loanId: string,
  run: SqlRunner = runOnDb
): Promise<Outstanding> {
  const result = await run(sql`
    SELECT
      COALESCE(SUM(principal_amount), 0) AS total_principal,
      COALESCE(SUM(principal_paid), 0)   AS paid_principal,
      COALESCE(SUM(principal_waived), 0) AS waived_principal,
      COALESCE(SUM(interest_amount), 0)  AS total_interest,
      COALESCE(SUM(interest_paid), 0)    AS paid_interest,
      COALESCE(SUM(interest_waived), 0)  AS waived_interest
    FROM installments
    WHERE loan_id = ${loanId}
  `);

  const row = parseRows(result);
  const totalPrincipal = round2(parseFloat(row.total_principal ?? "0"));
  const paidPrincipal = round2(parseFloat(row.paid_principal ?? "0"));
  const totalInterest = round2(parseFloat(row.total_interest ?? "0"));
  const paidInterest = round2(parseFloat(row.paid_interest ?? "0"));
  const waivedPrincipal = round2(parseFloat(row.waived_principal ?? "0"));
  const waivedInterest = round2(parseFloat(row.waived_interest ?? "0"));
  // Waived money is settled money: it must never come back as something owed.
  const principal = Math.max(0, round2(totalPrincipal - paidPrincipal - waivedPrincipal));
  const interest = Math.max(0, round2(totalInterest - paidInterest - waivedInterest));

  return {
    totalPrincipal,
    paidPrincipal,
    principal,
    totalInterest,
    paidInterest,
    interest,
    total: round2(principal + interest),
    waivedPrincipal,
    waivedInterest,
  };
}

export interface WaivedAmounts {
  principal: number;
  interest: number;
}

/**
 * Forgive what is still owed, on every EMI of a loan.
 *
 * Two callers, one mechanism:
 *   • settling a loan — the interest that was never earned is waived, and any
 *     rounding tail on the principal (a paisa, the app's own tolerance) is
 *     cleaned up so a closed loan never advertises a balance.
 *   • writing a loan off — the lender gives up the whole outstanding balance.
 *
 * The amounts are written onto the installments rather than just abandoning
 * them, so the record says "₹4,000 written off" instead of leaving numbers that
 * look like they are still owed. Returns what this call actually forgave.
 */
export async function waiveRemaining(
  loanId: string,
  run: SqlRunner = runOnDb,
  options: { principal: "all" | "tiny" } = { principal: "tiny" }
): Promise<WaivedAmounts> {
  const before = parseRows(
    await run(sql`
      SELECT
        COALESCE(SUM(principal_waived), 0) AS principal,
        COALESCE(SUM(interest_waived), 0)  AS interest
      FROM installments WHERE loan_id = ${loanId}
    `)
  );

  if (options.principal === "all") {
    await run(sql`
      UPDATE installments SET
        principal_waived = GREATEST(0, principal_amount - principal_paid - principal_waived),
        interest_waived  = GREATEST(0, interest_amount - interest_paid - interest_waived)
      WHERE loan_id = ${loanId}
    `);
  } else {
    // Settling: the interest left over is forgiven outright, and a principal
    // remainder within a paisa is treated as paid (the same tolerance the rest
    // of the app uses) rather than blocking the close.
    await run(sql`
      UPDATE installments SET
        interest_waived  = GREATEST(0, interest_amount - interest_paid - interest_waived),
        principal_waived = CASE
          WHEN principal_amount - principal_paid - principal_waived <= 0.01
            THEN GREATEST(0, principal_amount - principal_paid - principal_waived)
          ELSE principal_waived
        END
      WHERE loan_id = ${loanId}
    `);
  }

  const after = parseRows(
    await run(sql`
      SELECT
        COALESCE(SUM(principal_waived), 0) AS principal,
        COALESCE(SUM(interest_waived), 0)  AS interest
      FROM installments WHERE loan_id = ${loanId}
    `)
  );

  return {
    principal: round2(parseFloat(after.principal ?? "0") - parseFloat(before.principal ?? "0")),
    interest: round2(parseFloat(after.interest ?? "0") - parseFloat(before.interest ?? "0")),
  };
}

export interface CloseResult {
  closed: boolean;
  outstanding: Outstanding;
  /** Interest forgiven by this close (zero when the loan was closed early). */
  waivedInterest: number;
  /** Principal forgiven by this close - only ever a rounding paisa. */
  waivedPrincipal: number;
}

/**
 * Marks the loan closed once the principal is fully repaid. Safe to call after
 * every payment; a no-op while money is still owed. Pass the current
 * transaction as `run` so the close commits atomically with the payment.
 *
 * Closing is also where interest stops being owed: whatever interest the
 * schedule still shows is forgiven (see `waiveRemaining`), because a closed
 * loan that keeps advertising a balance is exactly the kind of half-truth this
 * app is not allowed to tell. The caller reports the amount.
 */
export async function closeLoanIfSettled(
  loanId: string,
  run: SqlRunner = runOnDb
): Promise<CloseResult> {
  const outstanding = await getOutstanding(loanId, run);

  if (outstanding.principal > 0.01) {
    return { closed: false, outstanding, waivedInterest: 0, waivedPrincipal: 0 };
  }

  const waived = await waiveRemaining(loanId, run, { principal: "tiny" });
  await run(sql`UPDATE loans SET status = 'closed' WHERE id = ${loanId}`);

  return {
    closed: true,
    outstanding,
    waivedInterest: waived.interest,
    waivedPrincipal: waived.principal,
  };
}
