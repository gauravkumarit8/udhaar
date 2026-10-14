import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loanAddedNotice,
  loanClaimedNotice,
  loanClosedNotice,
  payoffNotice,
  loanUpdatedNotice,
  notifyCounterparty,
  paymentNotice,
} from "@/lib/notify";

// vi.mock factories are hoisted above the imports, so the spies they close
// over have to be hoisted too.
const mocks = vi.hoisted(() => ({
  values: vi.fn(async (_row: Record<string, unknown>) => {}),
  insert: vi.fn(),
  sendPushToUser: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: { insert: (...args: unknown[]) => mocks.insert(...args) },
}));
vi.mock("@/lib/push", () => ({
  sendPushToUser: (...args: unknown[]) => mocks.sendPushToUser(...args),
}));

beforeEach(() => {
  mocks.values.mockReset().mockResolvedValue(undefined);
  mocks.insert.mockReset().mockReturnValue({ values: mocks.values });
  mocks.sendPushToUser.mockReset().mockResolvedValue({ sent: 1, failed: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loanClaimedNotice", () => {
  const base = { borrowerName: "Sneha", amount: 20000, firstDueAmount: 3400 };

  it("says the debt was already written down, and by whom", () => {
    const notice = loanClaimedNotice(base);

    expect(notice.title).toBe("💸 A loan was already recorded for you");
    expect(notice.message).toContain("Sneha had recorded owing you ₹20,000");
    expect(notice.message).toContain("First payment of ₹3,400");
    expect(notice.type).toBe("loan_added");
  });

  it("tells the new lender what they can now do about it", () => {
    // Signing up should not feel like a notification with nothing behind it.
    const message = loanClaimedNotice(base).message;
    expect(message).toMatch(/confirm payments/);
    expect(message).toMatch(/settle it early/);
    expect(message).toMatch(/write it off/);
  });
});

describe("loanAddedNotice", () => {
  const base = {
    actorName: "Gaurav",
    amount: 5000,
    firstDueAmount: 1000,
    firstDueDate: "2026-10-15",
  };

  it("names the lender, the amount and the first due date", () => {
    const notice = loanAddedNotice(base);

    expect(notice.title).toBe("💸 New loan added");
    expect(notice.message).toBe(
      "Gaurav added a loan of ₹5,000 for you on Udhaar. First payment of ₹1,000 due on 15 Oct 2026."
    );
    expect(notice.type).toBe("loan_added");
  });

  it("uses the 'waiting for you' wording when the borrower only sees it at login", () => {
    const notice = loanAddedNotice({ ...base, waiting: true });

    expect(notice.title).toBe("💸 A loan is waiting for you");
    expect(notice.message).toContain("added a loan of ₹5,000");
  });
});

describe("paymentNotice", () => {
  const base = {
    actorName: "Rahul",
    actorRole: "borrower" as const,
    amount: 5000,
    installmentNumber: 3,
    dueDate: "2026-10-15",
  };

  it("asks the lender to confirm when the borrower marks a payment", () => {
    const notice = paymentNotice({ ...base, event: "marked" });

    expect(notice.title).toBe("💰 Payment marked for you to confirm");
    expect(notice.message).toBe(
      "Rahul marked ₹5,000 as paid for EMI 3 (due 15 Oct 2026). Confirm it once the money reaches you."
    );
  });

  it("tells the borrower to confirm when the lender records a payment", () => {
    const notice = paymentNotice({ ...base, event: "marked", actorRole: "lender" });

    expect(notice.title).toBe("🧾 Payment recorded - please confirm");
    expect(notice.message).toBe(
      "Rahul recorded ₹5,000 against EMI 3 (due 15 Oct 2026). It counts towards the ledger once you confirm."
    );
  });

  it("describes a payment that was applied immediately", () => {
    const notice = paymentNotice({ ...base, event: "recorded", actorRole: "lender" });

    expect(notice.title).toBe("✅ Payment recorded");
    expect(notice.message).toBe("Rahul recorded a payment of ₹5,000 for EMI 3 (due 15 Oct 2026).");
    expect(notice.type).toBe("payment_recorded");
  });

  it("confirms the marker's own payment back to them", () => {
    const notice = paymentNotice({ ...base, event: "confirmed", actorRole: "lender" });

    expect(notice.message).toBe("Rahul confirmed your ₹5,000 payment for EMI 3.");
  });

  it("says so when the payment settled the loan", () => {
    const recorded = paymentNotice({ ...base, event: "recorded", settled: true });
    const confirmed = paymentNotice({ ...base, event: "confirmed", settled: true });

    expect(recorded.message).toContain("the loan is settled");
    expect(confirmed.message).toContain("the loan is settled");
  });

  it("reports a rejection, with the reason when there is one", () => {
    const plain = paymentNotice({ ...base, event: "rejected", actorRole: "lender" });
    const explained = paymentNotice({
      ...base,
      event: "rejected",
      actorRole: "lender",
      reason: "This payment is more than the EMI's remaining amount.",
    });

    expect(plain.message).toBe("Rahul rejected the ₹5,000 payment you marked for EMI 3.");
    expect(explained.message).toContain("was not accepted:");
    expect(explained.message).toContain("more than the EMI's remaining amount");
  });
});

describe("loanUpdatedNotice", () => {
  it("describes the new terms", () => {
    const notice = loanUpdatedNotice({
      actorName: "Gaurav",
      amount: 6000,
      tenureMonths: 12,
      startDate: "2026-11-01",
      scheduleRebuilt: false,
    });

    expect(notice.message).toBe("Gaurav updated your loan: ₹6,000 over 12 months from 1 Nov 2026.");
  });

  it("uses the singular for a one-month loan", () => {
    const notice = loanUpdatedNotice({
      actorName: "Gaurav",
      amount: 6000,
      tenureMonths: 1,
      startDate: "2026-11-01",
      scheduleRebuilt: false,
    });

    expect(notice.message).toContain("over 1 month from");
  });

  it("warns that old due dates no longer apply when the schedule was rebuilt", () => {
    const notice = loanUpdatedNotice({
      actorName: "Gaurav",
      amount: 6000,
      tenureMonths: 12,
      startDate: "2026-11-01",
      scheduleRebuilt: true,
      paymentDetailsChanged: true,
    });

    expect(notice.message).toContain("schedule has been rebuilt");
    expect(notice.message).toContain("payment details");
  });
});

describe("loanClosedNotice", () => {
  it("reports the closure", () => {
    const notice = loanClosedNotice({ actorName: "Gaurav", amount: 5000 });

    expect(notice.title).toBe("🎉 Loan closed");
    expect(notice.message).toBe("Gaurav closed the loan of ₹5,000.");
  });

  it("reports interest forgiven by the settlement", () => {
    const notice = loanClosedNotice({ actorName: "Gaurav", amount: 5000, interestWaived: 250.5 });

    expect(notice.message).toBe("Gaurav closed the loan of ₹5,000. ₹250.5 was written off.");
  });

  it("reports a write-off of principal too, as one number", () => {
    const notice = loanClosedNotice({
      actorName: "Gaurav",
      amount: 5000,
      interestWaived: 120,
      principalWaived: 380,
    });

    expect(notice.message).toBe("Gaurav closed the loan of ₹5,000. ₹500 was written off.");
  });

  it("stays quiet about a rounding-error of interest", () => {
    const notice = loanClosedNotice({ actorName: "Gaurav", amount: 5000, interestWaived: 0.004 });

    expect(notice.message).toBe("Gaurav closed the loan of ₹5,000.");
  });
});

describe("payoffNotice", () => {
  const base = { actorName: "Gaurav", amount: 12240.8 };

  it("asks the other side to confirm a 2-side payoff", () => {
    const notice = payoffNotice({ ...base, event: "marked" });

    expect(notice.title).toBe("🎉 Full payoff to confirm");
    expect(notice.message).toBe(
      "Gaurav recorded a payoff of ₹12,240.8 that settles the loan. " +
        "Confirm it once the money reaches you."
    );
  });

  it("names the interest it waives", () => {
    const notice = payoffNotice({ ...base, event: "marked", waivedInterest: 240.8 });

    expect(notice.message).toContain("₹240.8 interest was waived.");
  });

  it("announces a settlement that already happened", () => {
    const notice = payoffNotice({ ...base, event: "settled", waivedInterest: 240.8 });

    expect(notice.title).toBe("🎉 Loan settled");
    expect(notice.message).toBe(
      "Gaurav settled the whole loan with ₹12,240.8. ₹240.8 interest was waived."
    );
  });

  it("says what is still outstanding when it was only a part payment", () => {
    const notice = payoffNotice({ ...base, event: "recorded", remaining: 5000 });

    expect(notice.title).toBe("✅ Payoff recorded");
    expect(notice.message).toBe(
      "Gaurav recorded ₹12,240.8 against the loan. ₹5,000 is still outstanding."
    );
  });
});

describe("notifyCounterparty", () => {
  const target = {
    installmentId: "11111111-1111-1111-1111-111111111111",
    loanId: "22222222-2222-2222-2222-222222222222",
    notice: loanClosedNotice({ actorName: "Gaurav", amount: 5000 }),
  };

  it("does nothing when the counterparty has no account", async () => {
    const result = await notifyCounterparty({ ...target, userId: null });

    expect(result).toEqual({ recorded: false, delivered: false });
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("pushes and records a delivered notice", async () => {
    mocks.sendPushToUser.mockResolvedValue({ sent: 2, failed: 0 });

    const result = await notifyCounterparty({ ...target, userId: "user-1" });

    expect(result).toEqual({ recorded: true, delivered: true });
    expect(mocks.sendPushToUser).toHaveBeenCalledWith(
      "user-1",
      "🎉 Loan closed",
      "Gaurav closed the loan of ₹5,000.",
      { type: "loan_closed", loanId: target.loanId, installmentId: target.installmentId }
    );
    expect(mocks.values).toHaveBeenCalledWith({
      installmentId: target.installmentId,
      loanId: target.loanId,
      // The feed is filtered on this, so the copy can never be shown to the
      // side it was not written for.
      recipientId: "user-1",
      type: "loan_closed",
      channel: "push",
      message: "Gaurav closed the loan of ₹5,000.",
      status: "sent",
    });
  });

  it("still records the notice for the Activity feed when push fails", async () => {
    mocks.sendPushToUser.mockRejectedValue(new Error("FCM exploded"));

    const result = await notifyCounterparty({ ...target, userId: "user-1" });

    expect(result).toEqual({ recorded: true, delivered: false });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("records a notice that no device accepted, rather than claiming it was sent", async () => {
    mocks.sendPushToUser.mockResolvedValue({ sent: 0, failed: 0 });

    const result = await notifyCounterparty({ ...target, userId: "user-1" });

    expect(result).toEqual({ recorded: true, delivered: false });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("never fails the caller when the notification cannot even be recorded", async () => {
    mocks.values.mockRejectedValue(new Error("insert failed"));

    // The payment that triggered this has already been committed - throwing
    // here would turn a successful payment into a 500.
    await expect(notifyCounterparty({ ...target, userId: "user-1" })).resolves.toEqual({
      recorded: false,
      delivered: false,
    });
  });
});
