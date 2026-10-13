import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans, reminders, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { sendPushToUser } from "@/lib/push";
import { formatINR, formatDate, generateUPILink } from "@/lib/calculations";
import { remainingFor } from "@/lib/payments";
import { eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

const VALID_CHANNELS = ["push", "sms", "whatsapp"] as const;
type ReminderChannel = (typeof VALID_CHANNELS)[number];

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
  const channel: ReminderChannel = VALID_CHANNELS.includes(body?.channel)
    ? body.channel
    : "push";

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

  const { principalRemaining, interestRemaining, totalRemaining } = remainingFor(inst);

  if (totalRemaining <= 0) {
    return NextResponse.json(
      { error: "Nothing left to remind about - this EMI is already settled." },
      { status: 400 }
    );
  }

  const dueDateStr = formatDate(inst.dueDate);

  // The reminder goes to the borrower, so it should name the *lender*
  // (it previously said "loan from <borrower>", i.e. the recipient's own name).
  const message = `${session.name} is reminding you: ${formatINR(totalRemaining)} is due on ${dueDateStr} (interest ${formatINR(interestRemaining)}, principal ${formatINR(principalRemaining)}). Pay via UPI in the Udhaar app.`;

  const upiLink = loan.upiId
    ? generateUPILink(loan.upiId, totalRemaining, `Payment for ${loan.borrowerName}`, session.name)
    : null;

  // Send a real push notification if the borrower has an account and a
  // registered device. SMS/WhatsApp channels still need a provider wired up,
  // so record what actually happened rather than claiming "sent".
  let pushResult: { sent: number; failed: number } | null = null;
  if (loan.borrowerId) {
    pushResult = await sendPushToUser(loan.borrowerId, "💰 Payment Reminder", message, {
      type: "reminder",
      installmentId: id,
      loanId: inst.loanId,
    });
  }

  const delivered = (pushResult?.sent ?? 0) > 0;
  const status = delivered ? "sent" : "failed";

  const [reminder] = await db
    .insert(reminders)
    .values({
      installmentId: id,
      loanId: inst.loanId,
      recipientId: loan.borrowerId,
      type: "reminder",
      channel,
      message,
      status,
    })
    .returning();

  return NextResponse.json({
    success: true,
    reminder,
    delivered,
    /** Who actually received something - the UI uses this to be honest. */
    pushSent: pushResult?.sent ?? 0,
    reason: delivered
      ? undefined
      : channel !== "push"
        ? `The ${channel} channel isn't connected yet - share the link below instead.`
        : loan.borrowerId
          ? "The borrower hasn't enabled notifications on any device yet."
          : "The borrower hasn't joined Udhaar yet - share the link below instead.",
    upiLink,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
