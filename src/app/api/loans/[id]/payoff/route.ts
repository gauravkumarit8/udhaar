import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans, payments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { remainingFor, planPayoff, type PayoffInstallment } from "@/lib/payments";
import { notifyCounterparty, payoffNotice } from "@/lib/notify";
import { applyPayoff, PAYMENT_CONFLICT } from "@/lib/settle";
import { toNumber, validateProofId, validateProofUrl, LIMITS } from "@/lib/validation";
import { withErrors } from "@/lib/api-handler";
import { and, eq } from "drizzle-orm";

/**
 * Records one payment that settles a whole loan - what actually happens when
 * someone clears the balance in a single transfer.
 *
 * Until this existed, money could only be recorded against one EMI at a time
 * and any amount above that EMI's remainder was refused, so a borrower who paid
 * everything in one go left a loan that could never be marked paid - and a
 * lender staring at "Cannot close loan: principal not fully paid" with the
 * money already in their account.
 *
 * The amount is allocated oldest-EMI-first, exactly (see `planPayoff`), and the
 * plan decides the shape of the settlement:
 *   • covers everything       → all EMIs settled, loan closed
 *   • covers the principal    → loan settled early, remaining interest waived
 *   • covers only part of it  → an ordinary part payment, oldest first
 * Anything received above what is owed is *recorded* as `unappliedAmount` on
 * the payment row rather than silently dropped or applied somewhere it doesn't
 * belong.
 */
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

  const { amount, proofUrl, proofId, notes } = body as Record<string, unknown>;

  const paidAmount = toNumber(amount);
  if (paidAmount === null || paidAmount <= 0) {
    return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
  }
  if (paidAmount > LIMITS.AMOUNT_MAX) {
    return NextResponse.json(
      { error: `Amount looks too large (max ₹${LIMITS.AMOUNT_MAX.toLocaleString("en-IN")})` },
      { status: 400 }
    );
  }
  if (Math.round(paidAmount * 100) !== paidAmount * 100) {
    return NextResponse.json(
      { error: "Amount can have at most 2 decimal places" },
      { status: 400 }
    );
  }

  const proofRef = validateProofId(proofId);
  if (!proofRef.ok) return NextResponse.json({ error: proofRef.error }, { status: 400 });
  const proof = validateProofUrl(proofUrl);
  if (!proof.ok) return NextResponse.json({ error: proof.error }, { status: 400 });

  const cleanNotes =
    typeof notes === "string" && notes.trim() ? notes.trim().slice(0, LIMITS.NOTES_MAX) : null;

  const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  // Either side of the loan may pay it off - the lender often records the
  // transfer the borrower sent.
  if (loan.lenderId !== session.id && loan.borrowerId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const actorRole = loan.lenderId === session.id ? "lender" : "borrower";
  const counterpartyId = actorRole === "lender" ? loan.borrowerId : loan.lenderId;

  const schedule = await db
    .select()
    .from(installments)
    .where(eq(installments.loanId, id))
    .orderBy(installments.installmentNumber);

  if (schedule.length === 0) {
    return NextResponse.json({ error: "This loan has no schedule to settle" }, { status: 400 });
  }

  if (loan.status === "closed") {
    return NextResponse.json(
      {
        error:
          "This loan is already closed, so there is nothing left to settle. Record the money as a payment on another loan, or add it as a new loan.",
      },
      { status: 409 }
    );
  }

  const rows: PayoffInstallment[] = schedule.map((inst) => {
    const { principalRemaining, interestRemaining } = remainingFor(inst);
    return { installmentNumber: inst.installmentNumber, principalRemaining, interestRemaining };
  });

  const plan = planPayoff(paidAmount, rows);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.error }, { status: 400 });
  }

  // In 2-side mode the ledger only moves on confirmation, so a second claim on
  // the same loan would compete with the first. One at a time, and say why.
  const [existingClaim] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.loanId, id), eq(payments.status, "pending")))
    .limit(1);

  if (loan.confirmationMode !== "1-side" && existingClaim) {
    return NextResponse.json(
      {
        error:
          "A payment on this loan is still waiting to be confirmed. Confirm or reject it first, then record the payoff.",
      },
      { status: 409 }
    );
  }

  // The payment row hangs off the first EMI the money actually touched, so the
  // schedule and the history agree about where it landed.
  const firstTarget = schedule.find((inst, i) => plan.interest[i] > 0 || plan.principal[i] > 0) ?? schedule[0];

  const paymentValues = {
    installmentId: firstTarget.id,
    loanId: id,
    amount: paidAmount.toFixed(2),
    paymentType: "payoff",
    unappliedAmount: plan.unapplied.toFixed(2),
    proofUrl: proof.value,
    proofPublicId: proofRef.value,
    markedByUserId: session.id,
    notes: cleanNotes,
  };

  // ── 2-side: a claim the other person confirms. No ledger movement yet. ──
  if (loan.confirmationMode !== "1-side") {
    const [payment] = await db
      .insert(payments)
      .values({ ...paymentValues, status: "pending" })
      .returning();

    await notifyCounterparty({
      userId: counterpartyId,
      installmentId: firstTarget.id,
      loanId: id,
      notice: payoffNotice({
        event: "marked",
        actorName: session.name,
        amount: paidAmount,
        waivedInterest: plan.waivedInterest,
      }),
    });

    return NextResponse.json({
      success: true,
      payment,
      awaitingConfirmation: true,
      plan: {
        settlesLoan: plan.settlesLoan,
        applied: plan.applied,
        unapplied: plan.unapplied,
        waivedInterest: plan.waivedInterest,
      },
      message:
        "Payoff recorded - the other person has to confirm it before the loan closes.",
    });
  }

  // ── 1-side: the row and the ledger move together, or not at all. ──
  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(payments)
        .values({ ...paymentValues, status: "confirmed" })
        .returning();

      const settlement = await applyPayoff(
        id,
        plan,
        schedule.map((inst) => ({ id: inst.id, installmentNumber: inst.installmentNumber })),
        (q) => tx.execute(q)
      );

      return { created, settlement };
    });

    await notifyCounterparty({
      userId: counterpartyId,
      installmentId: firstTarget.id,
      loanId: id,
      notice: payoffNotice({
        event: result.settlement.closed ? "settled" : "recorded",
        actorName: session.name,
        amount: paidAmount,
        waivedInterest: result.settlement.waivedInterest,
        remaining:
          result.settlement.outstanding.principal + result.settlement.outstanding.interest,
      }),
    });

    return NextResponse.json({
      success: true,
      payment: result.created,
      settled: result.settlement.closed,
      applied: result.settlement.applied,
      unapplied: plan.unapplied,
      waivedInterest: result.settlement.waivedInterest,
      waivedPrincipal: result.settlement.waivedPrincipal,
      remaining: {
        principal: result.settlement.outstanding.principal,
        interest: result.settlement.outstanding.interest,
      },
      message:
        result.settlement.closed || plan.settlesLoan
          ? result.settlement.waivedInterest > 0
            ? `Loan settled. ₹${result.settlement.waivedInterest.toFixed(2)} interest waived.`
            : "Loan settled in full."
          : `Part payment recorded. ₹${(result.settlement.outstanding.principal + result.settlement.outstanding.interest).toFixed(2)} still outstanding.`,
    });
  } catch (err) {
    if (err instanceof Error && err.message === PAYMENT_CONFLICT) {
      return NextResponse.json(
        {
          error:
            "This loan was updated at the same time (another payment just landed). Reload and try again.",
        },
        { status: 409 }
      );
    }
    throw err;
  }
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
