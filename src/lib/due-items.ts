/**
 * What "Upcoming & Overdue" should show: one line per loan, not one per EMI.
 *
 * The dashboard used to list every unpaid installment, so a ten-month loan
 * filled the screen with ten near-identical rows for the same person - "23
 * items" for a handful of loans, in the order the database happened to return
 * them. What a person actually needs from that list is *the next thing to pay*
 * on each loan, and whether they are behind on it.
 *
 * The rule: per loan, the earliest unpaid installment. Its amount is what will
 * be paid next; when the loan is behind on more than that one, the row carries
 * how much more is overdue so the list never hides arrears - it just stops
 * repeating them.
 *
 * Kept pure (no database, no dates taken from the clock except through
 * `daysUntil`) so the rule can be unit-tested and reused.
 */
import { daysUntil } from "@/lib/calculations";

export interface DueCandidate {
  loanId: string;
  borrowerName: string;
  lenderName: string | null;
  installmentId: string;
  installmentNumber: number;
  dueDate: string;
  /** What is still owed on *this* installment. */
  amount: number;
  computedStatus: string;
  viewerRole: "lender" | "borrower";
  /*
   * Everything below is optional and does not affect the pick rule. It is what
   * the dashboard's single query already has in hand, carried through untouched
   * so the due card can act on the row it is showing - pay without opening the
   * loan, or send a reminder without leaving home - instead of sending the
   * person into a detail screen to fetch the same numbers again. Any other
   * caller can ignore them, and the unit tests below build candidates without
   * them exactly as before.
   */
  /** The lender's UPI id, when the lender has one. */
  lenderUpiId?: string | null;
  /** What is still owed on this installment, split the way a payment is applied. */
  principalRemaining?: number;
  interestRemaining?: number;
  /**
   * This viewer's own unanswered claim on the installment, and what is still
   * payable after it (`payable` + its split).
   *
   * In 2-side mode the ledger does not move until the other side agrees, so an
   * EMI this viewer has already claimed still reads as unpaid here. Without
   * these the due card offered "Pay now" on money that was already claimed, and
   * the API answered "This EMI is already fully paid" - a dead end the row
   * itself could have avoided. `payable === 0` means nothing is left to pay.
   */
  claimedByYou?: number;
  claimedPaymentId?: string | null;
  payable?: number;
  payablePrincipal?: number;
  payableInterest?: number;
}

export interface DueItem extends DueCandidate {
  /** How many further installments on this loan are overdue (not just this one). */
  moreOverdueCount: number;
  /** What those further overdue installments add up to. */
  moreOverdueAmount: number;
  /** Days until this installment is due; negative when overdue. */
  daysUntilDue: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One row per loan: the next unpaid installment, with the rest of that loan's
 * arrears summarised on it.
 */
export function pickNextDuePerLoan(candidates: DueCandidate[]): DueItem[] {
  const byLoan = new Map<string, DueCandidate[]>();

  for (const candidate of candidates) {
    const list = byLoan.get(candidate.loanId);
    if (list) list.push(candidate);
    else byLoan.set(candidate.loanId, [candidate]);
  }

  const items: DueItem[] = [];

  for (const list of byLoan.values()) {
    // Oldest first: the installment that has been waiting longest is the one
    // to pay, whether it is overdue or simply the earliest upcoming.
    const ordered = [...list].sort((a, b) => {
      const byDate = a.dueDate.localeCompare(b.dueDate);
      return byDate !== 0 ? byDate : a.installmentNumber - b.installmentNumber;
    });

    const [next, ...rest] = ordered;
    if (!next) continue;

    // Everything else that is already late, summarised rather than repeated.
    const overdueRest = rest.filter((item) => daysUntil(item.dueDate) < 0);
    const moreOverdueAmount = round2(
      overdueRest.reduce((sum, item) => sum + item.amount, 0)
    );

    items.push({
      ...next,
      moreOverdueCount: overdueRest.length,
      moreOverdueAmount,
      daysUntilDue: daysUntil(next.dueDate),
    });
  }

  // Overdue first, then soonest due. Same ordering the list had, now with one
  // row per loan to order.
  return items.sort((a, b) => {
    const aOverdue = a.daysUntilDue < 0 ? 0 : 1;
    const bOverdue = b.daysUntilDue < 0 ? 0 : 1;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;
    if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    // Stable fallback, so two loans due the same day don't shuffle between loads.
    return a.loanId.localeCompare(b.loanId);
  });
}
