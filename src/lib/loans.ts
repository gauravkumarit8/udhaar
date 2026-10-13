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
      COALESCE(SUM(interest_amount), 0)  AS total_interest,
      COALESCE(SUM(interest_paid), 0)    AS paid_interest
    FROM installments
    WHERE loan_id = ${loanId}
  `);

  const row = parseRows(result);
  const totalPrincipal = round2(parseFloat(row.total_principal ?? "0"));
  const paidPrincipal = round2(parseFloat(row.paid_principal ?? "0"));
  const totalInterest = round2(parseFloat(row.total_interest ?? "0"));
  const paidInterest = round2(parseFloat(row.paid_interest ?? "0"));
  const principal = Math.max(0, round2(totalPrincipal - paidPrincipal));
  const interest = Math.max(0, round2(totalInterest - paidInterest));

  return {
    totalPrincipal,
    paidPrincipal,
    principal,
    totalInterest,
    paidInterest,
    interest,
    total: round2(principal + interest),
  };
}

export interface CloseResult {
  closed: boolean;
  outstanding: Outstanding;
}

/**
 * Marks the loan closed once the principal is fully repaid. Safe to call after
 * every payment; a no-op while money is still owed. Pass the current
 * transaction as `run` so the close commits atomically with the payment.
 */
export async function closeLoanIfSettled(
  loanId: string,
  run: SqlRunner = runOnDb
): Promise<CloseResult> {
  const outstanding = await getOutstanding(loanId, run);

  if (outstanding.principal > 0.01) {
    return { closed: false, outstanding };
  }

  await run(sql`UPDATE loans SET status = 'closed' WHERE id = ${loanId}`);

  return { closed: true, outstanding };
}
