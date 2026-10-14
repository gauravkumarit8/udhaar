/**
 * Who is allowed to do what on a loan.
 *
 * There are three relationships a person can have with a loan, and they are
 * not interchangeable:
 *
 *   - the **lender** - the money is theirs. Only they can forgive a debt:
 *     waive interest at settlement, or write a loan off.
 *   - the **borrower** - they owe it. They can record what they pay.
 *   - the **author** (`createdByUserId`) - whoever typed the record in. This
 *     exists because a borrower can enter a loan naming a lender who has never
 *     used Udhaar; without it, nobody could fix a typo in their own record.
 *
 * The rule that shaped this file: **a waiver is never granted by the borrower
 * alone.** A borrower-entered loan stays un-forgivable until the lender joins,
 * because otherwise someone could forgive their own debt by tapping a button.
 */
export interface LoanParties {
  lenderId: string | null;
  borrowerId: string | null;
  createdByUserId?: string | null;
}

/** The lender's account, when they have one on Udhaar. */
export function isLoanLender(loan: LoanParties, userId: string): boolean {
  return loan.lenderId === userId;
}

export function isLoanBorrower(loan: LoanParties, userId: string): boolean {
  return loan.borrowerId === userId;
}

export function isLoanAuthor(loan: LoanParties, userId: string): boolean {
  return loan.createdByUserId === userId;
}

/** Can this person see the loan at all? */
export function isLoanParty(loan: LoanParties, userId: string): boolean {
  return isLoanLender(loan, userId) || isLoanBorrower(loan, userId) || isLoanAuthor(loan, userId);
}

/** "lender" | "borrower" - as the person viewing it experiences the loan. */
export function loanRole(loan: LoanParties, userId: string): "lender" | "borrower" {
  return isLoanLender(loan, userId) ? "lender" : "borrower";
}

/**
 * The other side is not on Udhaar, so nobody can countersign.
 *
 * For a loan the lender entered: the borrower may not have signed up yet.
 * For a loan the borrower entered: the lender may never sign up at all.
 */
export function hasNoCounterparty(loan: LoanParties, userId: string): boolean {
  if (isLoanLender(loan, userId)) return !loan.borrowerId;
  if (isLoanBorrower(loan, userId)) return !loan.lenderId;
  return false;
}

/**
 * A borrower-entered loan whose lender has not joined yet. Interest cannot be
 * waived on one of these, and it cannot be written off - see the note above.
 */
export function isUnclaimedBorrowerLoan(loan: LoanParties): boolean {
  return !loan.lenderId && Boolean(loan.borrowerId) && loan.createdByUserId === loan.borrowerId;
}

/** What to tell someone who asks for a concession they cannot give. */
export function waiverRefusal(loan: LoanParties & { lenderName?: string | null }): string {
  const name = loan.lenderName?.trim() || "The lender";
  return (
    `Only ${name} can reduce what you owe, and they haven't joined Udhaar yet. ` +
    `Pay the full amount (or ask them to sign up with the same mobile number, and they can settle ` +
    `it for you).`
  );
}
