import { describe, expect, it } from "vitest";
import {
  hasNoCounterparty,
  isLoanAuthor,
  isLoanBorrower,
  isLoanLender,
  isLoanParty,
  isUnclaimedBorrowerLoan,
  loanRole,
  waiverRefusal,
} from "../src/lib/loan-access";

const LENDER = "user-lender";
const BORROWER = "user-borrower";
const STRANGER = "user-stranger";

/** A loan the lender typed in, for a borrower who has not joined Udhaar. */
const lenderEnteredUnclaimed = {
  lenderId: LENDER,
  borrowerId: null,
  createdByUserId: LENDER,
};

/** A loan the borrower typed in, naming a lender with no account. */
const borrowerEntered = {
  lenderId: null,
  borrowerId: BORROWER,
  createdByUserId: BORROWER,
};

/** A loan the borrower typed in, which the lender has since claimed. */
const borrowerEnteredClaimed = {
  lenderId: LENDER,
  borrowerId: BORROWER,
  createdByUserId: BORROWER,
};

describe("who is party to a loan", () => {
  it("knows the lender and the borrower apart", () => {
    expect(isLoanLender(borrowerEnteredClaimed, LENDER)).toBe(true);
    expect(isLoanLender(borrowerEnteredClaimed, BORROWER)).toBe(false);
    expect(isLoanBorrower(borrowerEnteredClaimed, BORROWER)).toBe(true);
    expect(isLoanBorrower(borrowerEnteredClaimed, LENDER)).toBe(false);
  });

  it("counts the author as a party even when they are only the borrower", () => {
    // Without this the borrower could not open the loan they just entered.
    expect(isLoanAuthor(borrowerEntered, BORROWER)).toBe(true);
    expect(isLoanParty(borrowerEntered, BORROWER)).toBe(true);
  });

  it("keeps strangers out", () => {
    for (const loan of [lenderEnteredUnclaimed, borrowerEntered, borrowerEnteredClaimed]) {
      expect(isLoanParty(loan, STRANGER)).toBe(false);
      expect(isLoanLender(loan, STRANGER)).toBe(false);
      expect(isLoanBorrower(loan, STRANGER)).toBe(false);
    }
  });

  it("reports the role as the viewer experiences it", () => {
    expect(loanRole(borrowerEnteredClaimed, LENDER)).toBe("lender");
    expect(loanRole(borrowerEnteredClaimed, BORROWER)).toBe("borrower");
    // The borrower entered it and the lender has no account, so from their
    // side of the screen this is a loan they owe.
    expect(loanRole(borrowerEntered, BORROWER)).toBe("borrower");
  });
});

describe("hasNoCounterparty", () => {
  it("is true when the other side has no account", () => {
    expect(hasNoCounterparty(lenderEnteredUnclaimed, LENDER)).toBe(true);
    expect(hasNoCounterparty(borrowerEntered, BORROWER)).toBe(true);
  });

  it("is false once both sides have accounts", () => {
    expect(hasNoCounterparty(borrowerEnteredClaimed, LENDER)).toBe(false);
    expect(hasNoCounterparty(borrowerEnteredClaimed, BORROWER)).toBe(false);
  });

  it("says nothing about a stranger", () => {
    expect(hasNoCounterparty(borrowerEntered, STRANGER)).toBe(false);
  });
});

describe("isUnclaimedBorrowerLoan", () => {
  it("recognises a debt someone wrote down for a lender who never joined", () => {
    expect(isUnclaimedBorrowerLoan(borrowerEntered)).toBe(true);
  });

  it("stops being true the moment the lender signs up", () => {
    // The lender is on Udhaar now, so the concession is theirs to give again.
    expect(isUnclaimedBorrowerLoan(borrowerEnteredClaimed)).toBe(false);
  });

  it("is not about loans the lender entered", () => {
    expect(isUnclaimedBorrowerLoan(lenderEnteredUnclaimed)).toBe(false);
  });

  it("is false for a loan with no borrower at all", () => {
    expect(isUnclaimedBorrowerLoan({ lenderId: LENDER, borrowerId: null, createdByUserId: LENDER })).toBe(false);
  });
});

describe("waiverRefusal", () => {
  it("names the lender, so the refusal is actionable", () => {
    const message = waiverRefusal({ ...borrowerEntered, lenderName: "Uncle Suresh" });
    expect(message).toContain("Uncle Suresh");
    expect(message).toContain("haven't joined Udhaar");
    expect(message).toContain("full amount");
  });

  it("still reads sensibly without a name on file", () => {
    expect(waiverRefusal(borrowerEntered)).toContain("Only The lender can reduce");
  });

  it("falls back rather than printing an empty name", () => {
    expect(waiverRefusal({ ...borrowerEntered, lenderName: "   " })).toContain("Only The lender");
  });
});
