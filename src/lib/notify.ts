/**
 * Everything the app tells a user about money, in one place.
 *
 * `reminders` doubles as the notification log that the Activity screen reads
 * (`GET /api/notifications` joins it to loans for whichever side is asking),
 * so an event that matters to the *other* party is recorded there, and pushed
 * on a best-effort basis.
 *
 * Two rules hold for every call:
 *
 *   1. A notification never fails the operation that caused it. By the time we
 *      get here the money has already moved, so a failed push or insert is
 *      logged and swallowed - the user's payment must not 500 because FCM was
 *      unreachable.
 *   2. Only the counterparty is notified. Nobody gets a push about their own
 *      tap; the actor already knows what they did.
 *
 * The copy lives in the `*Notice` functions, which are pure and unit-tested.
 * `notifyCounterparty` is the only part that touches the database.
 */
import { db } from "@/db";
import { reminders } from "@/db/schema";
import { formatINR, formatDate } from "@/lib/calculations";
import { sendPushToUser } from "@/lib/push";

export interface Notice {
  /** Push title, also the first line the user sees. */
  title: string;
  /** One sentence, reused verbatim in the Activity feed. */
  message: string;
  /** Payload `type` handed to the client alongside the push. */
  type: string;
}

/**
 * "Gaurav added a loan of ₹5,000 for you."
 *
 * Covers both the moment a loan is created for an existing account and the
 * moment a loan recorded earlier is linked to one (`waiting: true`).
 */
export function loanAddedNotice(p: {
  actorName: string;
  amount: number;
  firstDueAmount: number;
  firstDueDate: string;
  waiting?: boolean;
}): Notice {
  return {
    title: p.waiting ? "💸 A loan is waiting for you" : "💸 New loan added",
    message:
      `${p.actorName} added a loan of ${formatINR(p.amount)} for you on Udhaar. ` +
      `First payment of ${formatINR(p.firstDueAmount)} due on ${formatDate(p.firstDueDate)}.`,
    type: "loan_added",
  };
}

/**
 * A lender who just joined, about a loan a borrower had already recorded
 * against their number. The copy leads with what they can now do, because the
 * point of attaching the account is that *they* are the only one who can
 * settle or forgive it.
 */
export function loanClaimedNotice(p: {
  borrowerName: string;
  amount: number;
  firstDueAmount: number;
}): Notice {
  return {
    title: "💸 A loan was already recorded for you",
    message:
      `${p.borrowerName} had recorded owing you ${formatINR(p.amount)} on Udhaar, and it is now ` +
      `linked to your account. First payment of ${formatINR(p.firstDueAmount)}. ` +
      `You can confirm payments, settle it early, or write it off.`,
    type: "loan_added",
  };
}

/**
 * What one side is told when the other side touches an EMI.
 *
 * - `marked`    - recorded but awaiting the recipient's confirmation (2-side)
 * - `recorded`  - applied to the ledger straight away (1-side)
 * - `confirmed` - the recipient's earlier mark was accepted
 * - `rejected`  - the recipient's earlier mark was turned down
 * - `withdrawn` - the person who marked it took it back before anyone acted
 */
export type PaymentEvent = "marked" | "recorded" | "confirmed" | "rejected" | "withdrawn";

export function paymentNotice(p: {
  event: PaymentEvent;
  /** Who did the thing - never the recipient. */
  actorName: string;
  /** Which side of the loan the actor is on. */
  actorRole: "lender" | "borrower";
  amount: number;
  installmentNumber: number;
  dueDate: string;
  /** The loan became fully repaid with this payment. */
  settled?: boolean;
  /** Why a payment was turned down, when the reason isn't obvious. */
  reason?: string;
}): Notice {
  const amount = formatINR(p.amount);
  const emi = `EMI ${p.installmentNumber}`;
  const settled = p.settled ? " This was the final payment - the loan is settled. 🎉" : "";

  switch (p.event) {
    case "marked": {
      // The recipient has to sign it off, so say that - the whole point of
      // 2-side mode is that money only moves when both sides agree.
      const fromBorrower = p.actorRole === "borrower";
      return {
        title: fromBorrower ? "💰 Payment marked for you to confirm" : "🧾 Payment recorded - please confirm",
        message: fromBorrower
          ? `${p.actorName} marked ${amount} as paid for ${emi} (due ${formatDate(p.dueDate)}). ` +
            `Confirm it once the money reaches you.`
          : `${p.actorName} recorded ${amount} against ${emi} (due ${formatDate(p.dueDate)}). ` +
            `It counts towards the ledger once you confirm.`,
        type: "payment_marked",
      };
    }
    case "recorded":
      return {
        title: "✅ Payment recorded",
        message:
          `${p.actorName} recorded a payment of ${amount} for ${emi} ` +
          `(due ${formatDate(p.dueDate)}).${settled}`,
        type: "payment_recorded",
      };
    case "confirmed":
      return {
        title: "✅ Payment confirmed",
        message: `${p.actorName} confirmed your ${amount} payment for ${emi}.${settled}`,
        type: "payment_confirmed",
      };
    case "rejected":
      return {
        title: "❌ Payment not accepted",
        message: p.reason
          ? `The ${amount} payment you marked for ${emi} was not accepted: ${p.reason}`
          : `${p.actorName} rejected the ${amount} payment you marked for ${emi}.`,
        type: "payment_rejected",
      };
    case "withdrawn":
      // Nothing moved - say so plainly, or the recipient will wonder whether
      // they missed money.
      return {
        title: "↩️ Payment withdrawn",
        message:
          `${p.actorName} withdrew the ${amount} payment they had marked for ${emi} ` +
          `(due ${formatDate(p.dueDate)}). Nothing was recorded against it, so it is owed again.`,
        type: "payment_withdrawn",
      };
  }
}

/** "Gaurav updated your loan: ₹6,000 over 12 months from 1 Nov 2026." */
export function loanUpdatedNotice(p: {
  actorName: string;
  amount: number;
  tenureMonths: number;
  startDate: string;
  /** The EMI schedule was rebuilt, so the old due dates are gone. */
  scheduleRebuilt: boolean;
  /** Where to pay changed - worth saying, since that is how they pay. */
  paymentDetailsChanged?: boolean;
}): Notice {
  return {
    title: "✏️ Loan updated",
    message:
      `${p.actorName} updated your loan: ${formatINR(p.amount)} over ${p.tenureMonths} ` +
      `month${p.tenureMonths === 1 ? "" : "s"} from ${formatDate(p.startDate)}.` +
      (p.scheduleRebuilt ? " The EMI schedule has been rebuilt, so any earlier due dates no longer apply." : "") +
      (p.paymentDetailsChanged ? " The payment details (UPI / account) have been updated." : ""),
    type: "loan_updated",
  };
}

/**
 * "Gaurav closed the loan of ₹5,000."
 *
 * Closing a loan forgives whatever interest the schedule still showed (see
 * `waiveRemaining`), so the tail reports that instead of leaving a number that
 * reads as though it were still owed.
 */
export function loanClosedNotice(p: {
  actorName: string;
  amount: number;
  /** Interest forgiven by the close. */
  interestWaived?: number;
  /** Outstanding balance the lender gave up on (a write-off). */
  principalWaived?: number;
}): Notice {
  const waived = (p.interestWaived ?? 0) + (p.principalWaived ?? 0);
  const tail =
    waived > 0.01 ? ` ${formatINR(waived)} was written off.` : "";

  return {
    title: "🎉 Loan closed",
    message: `${p.actorName} closed the loan of ${formatINR(p.amount)}.${tail}`,
    type: "loan_closed",
  };
}

/**
 * What one side is told when the other side settles the whole loan in one go.
 *
 * - `marked`   - a claim waiting for the recipient's confirmation (2-side)
 * - `recorded` - applied straight away, but only part of the loan
 * - `settled`  - applied straight away and the loan is now closed
 */
export type PayoffEvent = "marked" | "recorded" | "settled";

export function payoffNotice(p: {
  event: PayoffEvent;
  /** Who did the thing - never the recipient. */
  actorName: string;
  amount: number;
  /** Interest forgiven because the loan settled early. */
  waivedInterest?: number;
  /** Still outstanding, when this was only a part payment. */
  remaining?: number;
}): Notice {
  const amount = formatINR(p.amount);
  const waived =
    p.waivedInterest && p.waivedInterest > 0.01
      ? ` ${formatINR(p.waivedInterest)} interest was waived.`
      : "";

  switch (p.event) {
    case "marked":
      return {
        title: "🎉 Full payoff to confirm",
        message:
          `${p.actorName} recorded a payoff of ${amount} that settles the loan.${waived} ` +
          `Confirm it once the money reaches you.`,
        type: "payment_marked",
      };
    case "settled":
      return {
        title: "🎉 Loan settled",
        message: `${p.actorName} settled the whole loan with ${amount}.${waived}`,
        type: "loan_closed",
      };
    case "recorded":
    default:
      return {
        title: "✅ Payoff recorded",
        message:
          `${p.actorName} recorded ${amount} against the loan.` +
          (p.remaining && p.remaining > 0.01
            ? ` ${formatINR(p.remaining)} is still outstanding.`
            : ""),
        type: "payment_recorded",
      };
  }
}

export interface NotifyResult {
  /** A row was written, so the Activity screen will show it. */
  recorded: boolean;
  /** At least one device accepted the push. */
  delivered: boolean;
}

/**
 * Records a notice for one user and pushes it to their devices.
 *
 * Pass `userId: null` when the counterparty has no account yet - there is
 * nobody to tell, and the loan is picked up by `backfillBorrowerLoans` the
 * first time that person logs in.
 */
export async function notifyCounterparty(target: {
  userId: string | null | undefined;
  /** Anchors the row to an EMI, which is what the Activity feed links to. */
  installmentId: string;
  loanId: string;
  notice: Notice;
}): Promise<NotifyResult> {
  const { userId, installmentId, loanId, notice } = target;

  if (!userId) return { recorded: false, delivered: false };

  try {
    let delivered = false;
    try {
      const result = await sendPushToUser(userId, notice.title, notice.message, {
        type: notice.type,
        loanId,
        installmentId,
      });
      delivered = result.sent > 0;
    } catch (err) {
      // Push is best-effort; the feed below is the record of what happened.
      console.error("[notify] push delivery failed:", err);
    }

    // Recorded even when nothing was delivered: the recipient sees it in the
    // Activity feed, and a `failed` status keeps the sender honest about what
    // actually reached the other person.
    await db.insert(reminders).values({
      installmentId,
      loanId,
      recipientId: userId,
      type: notice.type,
      channel: "push",
      message: notice.message,
      status: delivered ? "sent" : "failed",
    });

    return { recorded: true, delivered };
  } catch (err) {
    console.error("[notify] could not record notification:", err);
    return { recorded: false, delivered: false };
  }
}
