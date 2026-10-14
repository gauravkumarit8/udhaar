import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, payments, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { allocatePayment, remainingFor, type PaymentType } from "@/lib/payments";
import { getOutstanding, closeLoanIfSettled } from "@/lib/loans";
import { eq, sql, and, lte } from "drizzle-orm";
import { toNumber, validateProofId, validateProofUrl, LIMITS } from "@/lib/validation";
import { withErrors } from "@/lib/api-handler";
import { notifyCounterparty, paymentNotice } from "@/lib/notify";

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const { amount, paymentType, proofUrl, proofId, notes } = body as Record<string, unknown>;

  // paymentType: "interest" | "principal" | "both"
  if (!amount || !paymentType) {
    return NextResponse.json({ error: "Amount and payment type required" }, { status: 400 });
  }

  if (!["interest", "principal", "both"].includes(String(paymentType))) {
    return NextResponse.json(
      { error: "paymentType must be one of: interest, principal, both" },
      { status: 400 }
    );
  }

  // Strict parse: "12abc" and "abc" are rejected instead of becoming NaN.
  const payAmount = toNumber(amount);

  if (payAmount === null || payAmount <= 0) {
    return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
  }
  if (payAmount > LIMITS.AMOUNT_MAX) {
    return NextResponse.json(
      { error: `Amount looks too large (max ₹${LIMITS.AMOUNT_MAX.toLocaleString("en-IN")})` },
      { status: 400 }
    );
  }

  // Proofs uploaded by the current app are private assets referenced by id.
  // A URL is still accepted for proofs stored before that changed; either way
  // it is validated rather than stored as given, because the other party ends
  // up fetching it.
  const proofRef = validateProofId(proofId);
  if (!proofRef.ok) {
    return NextResponse.json({ error: proofRef.error }, { status: 400 });
  }

  const proof = validateProofUrl(proofUrl);
  if (!proof.ok) {
    return NextResponse.json({ error: proof.error }, { status: 400 });
  }

  const cleanNotes =
    typeof notes === "string" && notes.trim() ? notes.trim().slice(0, LIMITS.NOTES_MAX) : null;

  // Get installment
  const [inst] = await db.select().from(installments).where(eq(installments.id, id)).limit(1);
  if (!inst) {
    return NextResponse.json({ error: "Installment not found" }, { status: 404 });
  }

  // Get loan for confirmation mode
  const [loan] = await db.select().from(loans).where(eq(loans.id, inst.loanId)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  // Only the lender or the linked borrower can mark a payment
  if (loan.lenderId !== session.id && loan.borrowerId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Whoever did *not* tap the button is told about it. Null when the borrower
  // has no account yet - there is nobody to notify.
  const isLender = session.id === loan.lenderId;
  const counterpartyId = isLender ? loan.borrowerId : loan.lenderId;
  const actorRole = isLender ? ("lender" as const) : ("borrower" as const);

  const { principalRemaining, interestRemaining, totalRemaining } = remainingFor(inst);

  // In 2-side mode the ledger only moves once a payment is confirmed, so two
  // people marking the same EMI would otherwise both "claim" the same money
  // and only find out at confirmation time. Subtract what other pending
  // payments already claim before validating this one.
  let reservedInterest = 0;
  let reservedPrincipal = 0;

  if (loan.confirmationMode !== "1-side") {
    const pending = await db
      .select({ amount: payments.amount, paymentType: payments.paymentType })
      .from(payments)
      .where(and(eq(payments.installmentId, id), eq(payments.status, "pending")));

    for (const claim of pending) {
      const claimed = parseFloat(claim.amount) || 0;
      if (claim.paymentType === "interest") reservedInterest += claimed;
      else if (claim.paymentType === "principal") reservedPrincipal += claimed;
      else {
        // "both" settles interest first, same as allocation does
        const toInterest = Math.min(claimed, Math.max(0, interestRemaining - reservedInterest));
        reservedInterest += toInterest;
        reservedPrincipal += claimed - toInterest;
      }
    }
  }

  const availableInterest = Math.max(0, interestRemaining - reservedInterest);
  const availablePrincipal = Math.max(0, principalRemaining - reservedPrincipal);

  // Never record more than actually gets applied to the ledger: validate
  // against the bucket the caller aimed at, not just the EMI total.
  const allocation = allocatePayment({
    amount: payAmount,
    paymentType: paymentType as PaymentType,
    principalRemaining: availablePrincipal,
    interestRemaining: availableInterest,
  });

  if (!allocation.ok) {
    const hasPendingClaims = reservedInterest > 0 || reservedPrincipal > 0;
    return NextResponse.json(
      {
        error: hasPendingClaims
          ? `${allocation.error} (₹${(reservedInterest + reservedPrincipal).toFixed(2)} on this EMI is already claimed by ${loan.confirmationMode === "2-side" ? "a payment awaiting confirmation" : "another payment"}.)`
          : allocation.error,
        remaining: allocation.remaining ?? totalRemaining,
      },
      { status: 400 }
    );
  }

  const { principalPayment, interestPayment } = allocation;

  const paymentValues = {
    installmentId: id,
    loanId: inst.loanId,
    amount: allocation.applied.toFixed(2),
    paymentType: paymentType as PaymentType,
    proofUrl: proof.value,
    proofPublicId: proofRef.value,
    markedByUserId: session.id,
    notes: cleanNotes,
  };

  // ── 2-side mode: record the claim only. The ledger moves on confirmation. ──
  if (loan.confirmationMode !== "1-side") {
    const [payment] = await db
      .insert(payments)
      .values({ ...paymentValues, status: "pending" })
      .returning();

    await notifyCounterparty({
      userId: counterpartyId,
      installmentId: id,
      loanId: inst.loanId,
      notice: paymentNotice({
        event: "marked",
        actorName: session.name,
        actorRole,
        amount: allocation.applied,
        installmentNumber: inst.installmentNumber,
        dueDate: inst.dueDate,
      }),
    });

    return NextResponse.json({
      success: true,
      payment,
      applied: { interest: interestPayment, principal: principalPayment, total: allocation.applied },
      autoConfirmed: false,
    });
  }

  // ── 1-side mode: the payment row and the ledger update are one unit. ──
  // The balance is incremented in SQL inside a conditional UPDATE, so two
  // payments racing on the same EMI can't both win and overpay it.
  let payment: typeof payments.$inferSelect;
  let settled = false;
  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(payments)
        .values({ ...paymentValues, status: "confirmed" })
        .returning();

      const [updated] = await tx
        .update(installments)
        .set({
          principalPaid: sql`${installments.principalPaid} + ${principalPayment.toFixed(2)}::numeric`,
          interestPaid: sql`${installments.interestPaid} + ${interestPayment.toFixed(2)}::numeric`,
        })
        .where(
          and(
            eq(installments.id, id),
            lte(
              sql`${installments.principalPaid} + ${principalPayment.toFixed(2)}::numeric`,
              sql`${installments.principalAmount} + 0.01`
            ),
            lte(
              sql`${installments.interestPaid} + ${interestPayment.toFixed(2)}::numeric`,
              sql`${installments.interestAmount} + 0.01`
            )
          )
        )
        .returning({ id: installments.id });

      if (!updated) {
        throw new Error("PAYMENT_CONFLICT");
      }

      const close = await closeLoanIfSettled(inst.loanId, (q) => tx.execute(q));

      return { created, settled: close.closed };
    });

    payment = result.created;
    settled = result.settled;
  } catch (err) {
    if (err instanceof Error && err.message === "PAYMENT_CONFLICT") {
      const outstanding = await getOutstanding(inst.loanId);
      return NextResponse.json(
        {
          error:
            "This EMI was updated at the same time (another payment just landed). Check the schedule and try again.",
          remaining: outstanding.principal + outstanding.interest,
        },
        { status: 409 }
      );
    }
    throw err;
  }

  await notifyCounterparty({
    userId: counterpartyId,
    installmentId: id,
    loanId: inst.loanId,
    notice: paymentNotice({
      event: "recorded",
      actorName: session.name,
      actorRole,
      amount: allocation.applied,
      installmentNumber: inst.installmentNumber,
      dueDate: inst.dueDate,
      settled,
    }),
  });

  return NextResponse.json({
    success: true,
    payment,
    applied: {
      interest: interestPayment,
      principal: principalPayment,
      total: allocation.applied,
    },
    autoConfirmed: true,
    loanSettled: settled,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
