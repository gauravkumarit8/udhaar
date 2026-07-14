import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, payments, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { eq, sql } from "drizzle-orm";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();
  const { amount, paymentType, proofUrl, notes } = body;

  // paymentType: "interest" | "principal" | "both"
  if (!amount || !paymentType) {
    return NextResponse.json({ error: "Amount and payment type required" }, { status: 400 });
  }

  const payAmount = parseFloat(amount);

  // Get installment
  const [inst] = await db.select().from(installments).where(eq(installments.id, id)).limit(1);
  if (!inst) {
    return NextResponse.json({ error: "Installment not found" }, { status: 404 });
  }

  // Get loan for confirmation mode
  const [loan] = await db.select().from(loans).where(eq(loans.id, inst.loanId)).limit(1);

  const principalRemaining = parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid);
  const interestRemaining = parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid);

  let principalPayment = 0;
  let interestPayment = 0;

  if (paymentType === "interest") {
    interestPayment = Math.min(payAmount, interestRemaining);
  } else if (paymentType === "principal") {
    principalPayment = Math.min(payAmount, principalRemaining);
  } else {
    // "both" - pay interest first, then principal
    interestPayment = Math.min(payAmount, interestRemaining);
    const remaining = payAmount - interestPayment;
    principalPayment = Math.min(remaining, principalRemaining);
  }

  // For 1-side mode, confirm immediately
  const paymentStatus = loan?.confirmationMode === "1-side" ? "confirmed" : "pending";

  // Create payment record
  const [payment] = await db
    .insert(payments)
    .values({
      installmentId: id,
      loanId: inst.loanId,
      amount: payAmount.toFixed(2),
      paymentType,
      proofUrl: proofUrl || null,
      markedByUserId: session.id,
      status: paymentStatus,
      notes: notes || null,
    })
    .returning();

  // If 1-side mode, update installment immediately
  if (paymentStatus === "confirmed") {
    const newPrincipalPaid = (parseFloat(inst.principalPaid) + principalPayment).toFixed(2);
    const newInterestPaid = (parseFloat(inst.interestPaid) + interestPayment).toFixed(2);

    await db
      .update(installments)
      .set({ principalPaid: newPrincipalPaid, interestPaid: newInterestPaid })
      .where(eq(installments.id, id));

    // Check if loan should be auto-closed
    await autoCloseLoanIfPaid(inst.loanId);
  }

  return NextResponse.json({
    success: true,
    payment,
    applied: {
      interest: interestPayment,
      principal: principalPayment,
    },
    autoConfirmed: paymentStatus === "confirmed",
  });
}

async function autoCloseLoanIfPaid(loanId: string) {
  const [result] = await db
    .select({
      totalPrincipal: sql<string>`COALESCE(SUM(${installments.principalAmount}), 0)`,
      paidPrincipal: sql<string>`COALESCE(SUM(${installments.principalPaid}), 0)`,
    })
    .from(installments)
    .where(eq(installments.loanId, loanId));

  const totalP = parseFloat(result.totalPrincipal);
  const paidP = parseFloat(result.paidPrincipal);

  if (paidP >= totalP) {
    await db.update(loans).set({ status: "closed" }).where(eq(loans.id, loanId));
  }
}
