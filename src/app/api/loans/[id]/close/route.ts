import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getOutstanding } from "@/lib/loans";
import { eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";
import { loanClosedNotice, notifyCounterparty } from "@/lib/notify";

async function handlePOST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  // Only the lender can close a loan
  if (loan.lenderId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const outstanding = await getOutstanding(id);

  // A loan is settled once the principal is repaid (this is the app's stated
  // rule). Interest that is still owed is a *warning*, not a blocker - but we
  // report it instead of pretending the loan is square.
  if (outstanding.principal > 0.01) {
    return NextResponse.json(
      {
        error: "Cannot close loan: principal not fully paid",
        totalPrincipal: outstanding.totalPrincipal,
        paidPrincipal: outstanding.paidPrincipal,
        principalRemaining: outstanding.principal,
      },
      { status: 400 }
    );
  }

  // Closing twice used to notify twice, and to wipe the loan's notification
  // history. It is a no-op now: the first close already said everything.
  if (loan.status === "closed") {
    return NextResponse.json({
      success: true,
      message: "Loan was already closed",
      interestOutstanding: outstanding.interest,
    });
  }

  await db.update(loans).set({ status: "closed" }).where(eq(loans.id, id));

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
        interestOutstanding: outstanding.interest,
      }),
    });
  }

  return NextResponse.json({
    success: true,
    message: "Loan closed",
    interestOutstanding: outstanding.interest,
    warning:
      outstanding.interest > 0.01
        ? `Loan closed with ₹${outstanding.interest.toFixed(2)} interest still unpaid.`
        : undefined,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
