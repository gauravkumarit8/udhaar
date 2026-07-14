import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, payments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus } from "@/lib/calculations";
import { eq } from "drizzle-orm";

export async function GET(
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

  // Get installments with computed status
  const rawInstallments = await db
    .select()
    .from(installments)
    .where(eq(installments.loanId, id))
    .orderBy(installments.installmentNumber);

  const enrichedInstallments = rawInstallments.map((inst) => ({
    ...inst,
    computedStatus: computeInstallmentStatus(
      inst.dueDate,
      parseFloat(inst.principalAmount),
      parseFloat(inst.interestAmount),
      parseFloat(inst.principalPaid),
      parseFloat(inst.interestPaid)
    ),
  }));

  // Get payments for this loan
  const loanPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.loanId, id))
    .orderBy(payments.createdAt);

  return NextResponse.json({ loan, installments: enrichedInstallments, payments: loanPayments });
}
