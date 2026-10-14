import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans, payments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getOutstanding, waiveRemaining } from "@/lib/loans";
import { and, eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";
import { loanClosedNotice, notifyCounterparty } from "@/lib/notify";

/**
 * Closes a loan. Two ways, because real loans end two ways:
 *
 *   • **settled** (default) - the principal has been repaid. The interest the
 *     schedule still showed is forgiven, since nobody owes interest on a loan
 *     that no longer exists.
 *   • **written off** (`{ writeOff: true }`) - the borrower is not going to
 *     repay the rest. The lender closes it deliberately, and the balance given
 *     up is recorded on the EMIs as written-off rather than left looking owed
 *     (which, before this, meant such a loan could never be closed at all: the
 *     endpoint refused with "principal not fully paid" for ever).
 *
 * Only the lender may close either way.
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

  // Body is optional: `POST /close` with nothing at all still means "settled".
  let payload: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const writeOff = payload.writeOff === true;
  const reason = typeof payload.reason === "string" ? payload.reason.trim().slice(0, 300) : "";

  const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  // Only the lender can close a loan - and only the lender can give up money.
  if (loan.lenderId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const outstanding = await getOutstanding(id);

  // A claim in flight is somebody's real payment. Closing underneath it would
  // either strand it or throw it away, so settle that first - explicitly.
  const [pending] = await db
    .select({ id: payments.id, amount: payments.amount, type: payments.paymentType })
    .from(payments)
    .where(and(eq(payments.loanId, id), eq(payments.status, "pending")))
    .limit(1);

  if (pending) {
    return NextResponse.json(
      {
        error:
          "A payment on this loan is still waiting to be confirmed. Confirm or reject it, then close the loan.",
      },
      { status: 409 }
    );
  }

  // Closing twice used to notify twice, and to wipe the loan's notification
  // history. It is a no-op now: the first close already said everything.
  if (loan.status === "closed") {
    return NextResponse.json({
      success: true,
      message: "Loan was already closed",
      waivedInterest: outstanding.waivedInterest,
      waivedPrincipal: outstanding.waivedPrincipal,
      interestOutstanding: outstanding.interest,
    });
  }

  if (!writeOff && outstanding.principal > 0.01) {
    return NextResponse.json(
      {
        error: "Cannot close loan: principal not fully paid",
        totalPrincipal: outstanding.totalPrincipal,
        paidPrincipal: outstanding.paidPrincipal,
        principalRemaining: outstanding.principal,
        hint:
          "Record the remaining payment, or close the loan as a write-off if it is never going to be repaid.",
      },
      { status: 400 }
    );
  }

  // Everything that follows is one unit: the write-off numbers on the EMIs and
  // the loan's status must never disagree.
  const closed = await db.transaction(async (tx) => {
    const waived = await waiveRemaining(id, (q) => tx.execute(q), {
      // A write-off gives up the whole balance; a normal close only cleans up
      // the interest that was never earned (plus a rounding paisa of principal).
      principal: writeOff ? "all" : "tiny",
    });

    await tx.update(loans).set({ status: "closed" }).where(eq(loans.id, id));

    return waived;
  });

  // Rows for this loan are its history, so they stay: the Activity screen is
  // where the borrower reads what happened, and the scheduler only ever looks
  // at active loans, so a closed one is never nagged again.
  const [firstInst] = await db
    .select({ id: installments.id })
    .from(installments)
    .where(eq(installments.loanId, id))
    .orderBy(installments.installmentNumber)
    .limit(1);

  if (firstInst) {
    await notifyCounterparty({
      userId: loan.borrowerId,
      installmentId: firstInst.id,
      loanId: loan.id,
      notice: loanClosedNotice({
        actorName: session.name,
        amount: parseFloat(loan.amount),
        interestWaived: closed.interest,
        principalWaived: closed.principal,
      }),
    });
  }

  const writtenOff = closed.principal + closed.interest;

  if (writeOff) {
    return NextResponse.json({
      success: true,
      message:
        writtenOff > 0
          ? `Loan closed with ₹${writtenOff.toFixed(2)} written off.`
          : "Loan closed.",
      writtenOffPrincipal: closed.principal,
      writtenOffInterest: closed.interest,
      writtenOff,
      reason: reason || undefined,
    });
  }

  return NextResponse.json({
    success: true,
    message: "Loan closed",
    waivedInterest: closed.interest,
    waivedPrincipal: closed.principal,
    // Kept for callers of the old shape: interest on a closed loan is now
    // recorded as waived, so this reads as the same number.
    interestOutstanding: closed.interest,
    warning:
      writtenOff > 0.01
        ? `Loan closed with ₹${writtenOff.toFixed(2)} written off.`
        : undefined,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
