import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, payments, reminders } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus, generateInstallmentSchedule } from "@/lib/calculations";
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

  if (loan.lenderId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();

  const [loan] = await db.select().from(loans).where(eq(loans.id, id)).limit(1);
  if (!loan) {
    return NextResponse.json({ error: "Loan not found" }, { status: 404 });
  }

  if (loan.lenderId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const {
    borrowerName,
    borrowerMobile,
    amount,
    interestRate,
    interestRatePeriod,
    tenureMonths,
    startDate,
    upiId,
    accountNumber,
    notes,
    confirmationMode,
  } = body;

  if (!borrowerName || !borrowerMobile || !amount || !tenureMonths || !startDate) {
    return NextResponse.json(
      { error: "Borrower name, mobile, amount, tenure, and start date are required" },
      { status: 400 }
    );
  }

  const principalAmount = parseFloat(amount);
  const rate = interestRate ? parseFloat(interestRate) : 0;
  const tenure = parseInt(tenureMonths, 10);

  if (principalAmount <= 0 || tenure <= 0) {
    return NextResponse.json({ error: "Amount and tenure must be positive" }, { status: 400 });
  }

  const ratePeriod = (interestRatePeriod === "monthly" ? "monthly" : "yearly") as "monthly" | "yearly";
  const scheduleChanged =
    loan.amount !== principalAmount.toFixed(2) ||
    loan.interestRate !== rate.toFixed(2) ||
    loan.interestRatePeriod !== ratePeriod ||
    loan.tenureMonths !== tenure ||
    loan.startDate !== startDate;

  const existingInstallments = await db
    .select({
      id: installments.id,
      principalPaid: installments.principalPaid,
      interestPaid: installments.interestPaid,
    })
    .from(installments)
    .where(eq(installments.loanId, id));

  const hasProgress = existingInstallments.some(
    (inst) => parseFloat(inst.principalPaid) > 0 || parseFloat(inst.interestPaid) > 0
  );

  if (scheduleChanged && hasProgress) {
    return NextResponse.json(
      {
        error: "You can only edit borrower/contact details after payments are recorded. Clear payments first or keep the schedule unchanged.",
      },
      { status: 400 }
    );
  }

  const updatedLoan = await db.transaction(async (tx) => {
    const [loanRecord] = await tx
      .update(loans)
      .set({
        borrowerName,
        borrowerMobile,
        amount: principalAmount.toFixed(2),
        interestRate: rate.toFixed(2),
        interestRatePeriod: ratePeriod,
        tenureMonths: tenure,
        startDate,
        upiId: upiId || null,
        accountNumber: accountNumber || null,
        notes: notes || null,
        confirmationMode: confirmationMode || "1-side",
      })
      .where(eq(loans.id, id))
      .returning();

    if (scheduleChanged) {
      await tx.delete(installments).where(eq(installments.loanId, id));
      const schedule = generateInstallmentSchedule(principalAmount, rate, tenure, startDate, ratePeriod);
      const installmentValues = schedule.map((inst) => ({
        loanId: id,
        installmentNumber: inst.installmentNumber,
        dueDate: inst.dueDate,
        principalAmount: inst.principalAmount.toFixed(2),
        interestAmount: inst.interestAmount.toFixed(2),
        totalAmount: inst.totalAmount.toFixed(2),
      }));

      if (installmentValues.length > 0) {
        await tx.insert(installments).values(installmentValues);
      }
    }

    return loanRecord;
  });

  return NextResponse.json({ success: true, loan: updatedLoan });
}

export async function DELETE(
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

  if (loan.lenderId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.delete(reminders).where(eq(reminders.loanId, id));
  await db.delete(payments).where(eq(payments.loanId, id));
  await db.delete(installments).where(eq(installments.loanId, id));
  await db.delete(loans).where(eq(loans.id, id));

  return NextResponse.json({ success: true, message: "Loan deleted" });
}
