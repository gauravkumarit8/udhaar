import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { eq, sql } from "drizzle-orm";

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

  // Check if all installments are fully paid
  const [result] = await db
    .select({
      totalPrincipal: sql<string>`COALESCE(SUM(${installments.principalAmount}), 0)`,
      paidPrincipal: sql<string>`COALESCE(SUM(${installments.principalPaid}), 0)`,
    })
    .from(installments)
    .where(eq(installments.loanId, id));

  const totalP = parseFloat(result.totalPrincipal);
  const paidP = parseFloat(result.paidPrincipal);

  if (paidP < totalP) {
    return NextResponse.json(
      { error: "Cannot close loan: principal not fully paid", totalPrincipal: totalP, paidPrincipal: paidP },
      { status: 400 }
    );
  }

  // Close the loan
  await db.update(loans).set({ status: "closed" }).where(eq(loans.id, id));

  return NextResponse.json({ success: true, message: "Loan closed" });
}