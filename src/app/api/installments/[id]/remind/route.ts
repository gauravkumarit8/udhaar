import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans, reminders, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { sendPushToUser } from "@/lib/push";
import { formatDate, generateUPILink } from "@/lib/calculations";
import { remainingFor } from "@/lib/payments";
import { buildReminderShare } from "@/lib/share-reminder";
import { eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

const VALID_CHANNELS = ["push", "sms", "whatsapp"] as const;
type ReminderChannel = (typeof VALID_CHANNELS)[number];

/**
 * WhatsApp is the default because it is the one channel that reaches a
 * borrower who has never installed this app - the message comes from the
 * lender's own phone, so there is nothing for the borrower to sign up for.
 * Push stays available for borrowers who did install it.
 */
const DEFAULT_CHANNEL: ReminderChannel = "whatsapp";

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const channel: ReminderChannel = (VALID_CHANNELS as readonly string[]).includes(body?.channel)
    ? (body.channel as ReminderChannel)
    : DEFAULT_CHANNEL;

  // Get installment
  const [inst] = await db.select().from(installments).where(eq(installments.id, id)).limit(1);
  if (!inst) {
    return NextResponse.json({ error: "Installment not found" }, { status: 404 });
  }

  // Get loan details
  const [loan] = await db.select().from(loans).where(eq(loans.id, inst.loanId)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  // Only the lender can send a payment reminder to the borrower
  if (loan.lenderId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { totalRemaining } = remainingFor(inst);

  if (totalRemaining <= 0) {
    return NextResponse.json(
      { error: "Nothing left to remind about - this EMI is already settled." },
      { status: 400 }
    );
  }

  const dueDateStr = formatDate(inst.dueDate);

  const upiLink = loan.upiId
    ? generateUPILink(loan.upiId, totalRemaining, `Payment for ${loan.borrowerName}`, session.name)
    : null;

  // The message the lender will actually send, plus the deep links that send
  // it. Built for every channel: the UI offers it either way.
  const share = buildReminderShare({
    lenderName: session.name,
    borrowerName: loan.borrowerName,
    borrowerMobile: loan.borrowerMobile,
    amount: totalRemaining,
    dueDate: dueDateStr,
    upiId: loan.upiId,
    upiLink,
  });
  const shareMessage = share.text.replace(/\n/g, " ");

  // A push is still worth attempting whenever the borrower has an account - it
  // is free, instant, and lands in the app if they have it. It is no longer
  // the only honest option, just the automatic one.
  let pushResult: { sent: number; failed: number } | null = null;
  if (loan.borrowerId) {
    pushResult = await sendPushToUser(loan.borrowerId, "💰 Payment Reminder", shareMessage, {
      type: "reminder",
      installmentId: id,
      loanId: inst.loanId,
    });
  }

  const pushDelivered = (pushResult?.sent ?? 0) > 0;

  /*
   * What actually happened, recorded honestly:
   *
   *   "sent"   - a device accepted a push. The only case we *know* arrived.
   *   "shared" - the lender sent it themselves through WhatsApp/SMS. The app
   *              prepared the message and handed it to their phone; whether
   *              they tapped send is between them and WhatsApp, so this is a
   *              record of a reminder the lender sent, not a delivery receipt.
   *   "failed" - nothing left the phone (kept only for the audit trail).
   */
  const sharesOutsideTheApp = channel === "whatsapp" || channel === "sms";
  const status = pushDelivered ? "sent" : sharesOutsideTheApp ? "shared" : "failed";

  const [reminder] = await db
    .insert(reminders)
    .values({
      installmentId: id,
      loanId: inst.loanId,
      recipientId: loan.borrowerId,
      type: "reminder",
      channel,
      // The same words the borrower receives on WhatsApp. It names the lender
      // (this used to name the recipient) and it no longer tells someone to
      // pay "in the Udhaar app" - the whole point is that they may not have it.
      message: shareMessage,
      status,
    })
    .returning();

  return NextResponse.json({
    success: true,
    reminder,
    /** True only when a device accepted a push - never claimed for a share. */
    delivered: pushDelivered,
    status,
    pushSent: pushResult?.sent ?? 0,
    /**
     * The reminder the lender can send themselves, on whichever app they
     * already use. This is the path that needs nothing installed on the
     * borrower's phone, so the UI leads with it.
     */
    share,
    reason: pushDelivered
      ? undefined
      : loan.borrowerId
        ? "The borrower has the app but hasn't allowed notifications on any device."
        : "The borrower hasn't joined Udhaar yet - send it on WhatsApp instead.",
    upiLink,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
