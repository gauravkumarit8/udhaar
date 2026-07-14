import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans, reminders } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { formatINR, formatDate } from "@/lib/calculations";
import { eq } from "drizzle-orm";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { channel = "sms" } = await req.json(); // push | sms | whatsapp

  // Get installment
  const [inst] = await db.select().from(installments).where(eq(installments.id, id)).limit(1);
  if (!inst) {
    return NextResponse.json({ error: "Installment not found" }, { status: 404 });
  }

  // Get loan details
  const [loan] = await db.select().from(loans).where(eq(loans.id, inst.loanId)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  // Generate reminder message
  const interestDue = formatINR(parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid));
  const principalDue = formatINR(parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid));
  const totalDue = formatINR(parseFloat(inst.totalAmount) - parseFloat(inst.principalPaid) - parseFloat(inst.interestPaid));
  const dueDateStr = formatDate(inst.dueDate);

  const message = `Reminder: Payment of ${totalDue} (Interest: ${interestDue}, Principal: ${principalDue}) due on ${dueDateStr} for loan from ${loan.borrowerName}. Pay now via UPI.`;

  // Store reminder record (in production, this would trigger actual SMS/push/WhatsApp)
  const [reminder] = await db
    .insert(reminders)
    .values({
      installmentId: id,
      loanId: inst.loanId,
      channel,
      message,
      status: "sent",
    })
    .returning();

  return NextResponse.json({
    success: true,
    reminder,
    upiLink: loan.upiId
      ? `upi://pay?pa=${loan.upiId}&am=${(parseFloat(inst.totalAmount) - parseFloat(inst.principalPaid) - parseFloat(inst.interestPaid)).toFixed(2)}&tn=Payment+for+${loan.borrowerName}&pn=${loan.borrowerName}`
      : null,
  });
}
