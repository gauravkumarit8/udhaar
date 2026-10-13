import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, reminders } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getOutstanding } from "@/lib/loans";
import { eq } from "drizzle-orm";

export async function POST(
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

  await db.update(loans).set({ status: "closed" }).where(eq(loans.id, id));

  // Reminders for a settled loan are noise - drop the ones still queued for it.
  await db.delete(reminders).where(eq(reminders.loanId, id));

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
