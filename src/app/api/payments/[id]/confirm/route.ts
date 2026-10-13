import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { payments, installments, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { allocatePayment, remainingFor, type PaymentType } from "@/lib/payments";
import { closeLoanIfSettled } from "@/lib/loans";
import { eq, and, lte, sql } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";
import { notifyCounterparty, paymentNotice } from "@/lib/notify";

async function handlePATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { action } = await req.json(); // "confirm" | "reject"

  if (!action || !["confirm", "reject"].includes(action)) {
    return NextResponse.json({ error: "Action must be 'confirm' or 'reject'" }, { status: 400 });
  }

  // Get payment
  const [payment] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  if (!payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  if (payment.status !== "pending") {
    return NextResponse.json({ error: "Payment already processed" }, { status: 400 });
  }

  // Only the lender or the linked borrower on this loan may act on the payment
  const [loan] = await db.select().from(loans).where(eq(loans.id, payment.loanId)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }
  if (loan.lenderId !== session.id && loan.borrowerId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Normally the person who marked a payment can't also confirm it - the
  // whole point of 2-side mode is that the other party signs off. But if the
  // counterparty has no Udhaar account yet (e.g. the lender added a loan for
  // a friend who hasn't installed the app), there is nobody else who *can*
  // confirm, and the payment would be stuck pending forever. In that single
  // case we let the marker confirm, and say so on the record.
  const counterpartyId = session.id === loan.lenderId ? loan.borrowerId : loan.lenderId;
  const selfConfirm = payment.markedByUserId === session.id && !counterpartyId;

  const [inst] = await db
    .select()
    .from(installments)
    .where(eq(installments.id, payment.installmentId))
    .limit(1);

  if (!inst) {
    return NextResponse.json({ error: "Installment not found" }, { status: 404 });
  }

  // The person who marked the payment is the one who needs to hear the
  // outcome - unless that is the same person acting now (self-confirmation
  // on a loan whose borrower has no account).
  const markerId = payment.markedByUserId === session.id ? null : payment.markedByUserId;

  if (payment.markedByUserId === session.id && counterpartyId) {
    return NextResponse.json(
      { error: "You can't confirm a payment you marked yourself. Ask the other party to confirm." },
      { status: 403 }
    );
  }

  if (action === "reject") {
    await db
      .update(payments)
      .set({ status: "rejected", confirmedByUserId: session.id })
      .where(eq(payments.id, id));

    await notifyCounterparty({
      userId: markerId,
      installmentId: payment.installmentId,
      loanId: payment.loanId,
      notice: paymentNotice({
        event: "rejected",
        actorName: session.name,
        actorRole: session.id === loan.lenderId ? "lender" : "borrower",
        amount: parseFloat(payment.amount),
        installmentNumber: inst.installmentNumber,
        dueDate: inst.dueDate,
      }),
    });

    return NextResponse.json({ success: true, action });
  }

  // ── Confirm ────────────────────────────────────────────────────────────
  const { principalRemaining, interestRemaining } = remainingFor(inst);

  const allocation = allocatePayment({
    amount: parseFloat(payment.amount),
    paymentType: payment.paymentType as PaymentType,
    principalRemaining,
    interestRemaining,
  });

  if (!allocation.ok) {
    // The EMI moved on since this payment was marked (someone paid it, or an
    // earlier pending payment was confirmed first). Reject it loudly rather
    // than silently applying zero and leaving a "confirmed" row behind.
    await db
      .update(payments)
      .set({ status: "rejected", confirmedByUserId: session.id })
      .where(eq(payments.id, id));

    await notifyCounterparty({
      userId: markerId,
      installmentId: payment.installmentId,
      loanId: payment.loanId,
      notice: paymentNotice({
        event: "rejected",
        actorName: session.name,
        actorRole: session.id === loan.lenderId ? "lender" : "borrower",
        amount: parseFloat(payment.amount),
        installmentNumber: inst.installmentNumber,
        dueDate: inst.dueDate,
        reason: `${allocation.error} The EMI had already moved on, so the payment was marked rejected.`,
      }),
    });

    return NextResponse.json(
      {
        error: `This payment can't be applied any more: ${allocation.error} It has been marked rejected.`,
      },
      { status: 409 }
    );
  }

  let settled = false;
  try {
    settled = await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "confirmed",
          confirmedByUserId: session.id,
          notes: selfConfirm
            ? [payment.notes, "Self-confirmed: borrower has no account yet"]
                .filter(Boolean)
                .join(" | ")
            : payment.notes,
        })
        .where(eq(payments.id, id));

      const [updated] = await tx
        .update(installments)
        .set({
          principalPaid: sql`${installments.principalPaid} + ${allocation.principalPayment.toFixed(2)}::numeric`,
          interestPaid: sql`${installments.interestPaid} + ${allocation.interestPayment.toFixed(2)}::numeric`,
        })
        .where(
          and(
            eq(installments.id, payment.installmentId),
            lte(
              sql`${installments.principalPaid} + ${allocation.principalPayment.toFixed(2)}::numeric`,
              sql`${installments.principalAmount} + 0.01`
            ),
            lte(
              sql`${installments.interestPaid} + ${allocation.interestPayment.toFixed(2)}::numeric`,
              sql`${installments.interestAmount} + 0.01`
            )
          )
        )
        .returning({ id: installments.id });

      if (!updated) throw new Error("PAYMENT_CONFLICT");

      const close = await closeLoanIfSettled(payment.loanId, (q) => tx.execute(q));

      return close.closed;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "PAYMENT_CONFLICT") {
      return NextResponse.json(
        { error: "This EMI was updated at the same time. Reload and try again." },
        { status: 409 }
      );
    }
    throw err;
  }

  await notifyCounterparty({
    userId: markerId,
    installmentId: payment.installmentId,
    loanId: payment.loanId,
    notice: paymentNotice({
      event: "confirmed",
      actorName: session.name,
      actorRole: session.id === loan.lenderId ? "lender" : "borrower",
      amount: parseFloat(payment.amount),
      installmentNumber: inst.installmentNumber,
      dueDate: inst.dueDate,
      settled,
    }),
  });

  return NextResponse.json({ success: true, action, selfConfirmed: selfConfirm, loanSettled: settled });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const PATCH = withErrors(handlePATCH);
