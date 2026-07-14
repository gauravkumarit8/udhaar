import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { payments, installments, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { eq } from "drizzle-orm";

export async function PATCH(
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

  // Update payment status
  await db
    .update(payments)
    .set({
      status: action === "confirm" ? "confirmed" : "rejected",
      confirmedByUserId: session.id,
    })
    .where(eq(payments.id, id));

  // If confirmed, update installment paid amounts
  if (action === "confirm") {
    const [inst] = await db
      .select()
      .from(installments)
      .where(eq(installments.id, payment.installmentId))
      .limit(1);

    if (inst) {
      const payAmount = parseFloat(payment.amount);
      const interestRemaining = parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid);
      const principalRemaining = parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid);

      let interestPayment = 0;
      let principalPayment = 0;

      if (payment.paymentType === "interest") {
        interestPayment = Math.min(payAmount, interestRemaining);
      } else if (payment.paymentType === "principal") {
        principalPayment = Math.min(payAmount, principalRemaining);
      } else {
        interestPayment = Math.min(payAmount, interestRemaining);
        principalPayment = Math.min(payAmount - interestPayment, principalRemaining);
      }

      const newPrincipalPaid = (parseFloat(inst.principalPaid) + principalPayment).toFixed(2);
      const newInterestPaid = (parseFloat(inst.interestPaid) + interestPayment).toFixed(2);

      await db
        .update(installments)
        .set({ principalPaid: newPrincipalPaid, interestPaid: newInterestPaid })
        .where(eq(installments.id, payment.installmentId));

      // Check auto-close
      const [result] = await db
        .select({
          totalPrincipal: installments.principalAmount,
          paidPrincipal: installments.principalPaid,
        })
        .from(installments)
        .where(eq(installments.loanId, payment.loanId));

      // Simple check - if all installments have principalPaid >= principalAmount
      const allInstallments = await db
        .select()
        .from(installments)
        .where(eq(installments.loanId, payment.loanId));

      const allPaid = allInstallments.every(
        (i) => parseFloat(i.principalPaid) >= parseFloat(i.principalAmount)
      );

      if (allPaid) {
        await db.update(loans).set({ status: "closed" }).where(eq(loans.id, payment.loanId));
      }
    }
  }

  return NextResponse.json({ success: true, action });
}
