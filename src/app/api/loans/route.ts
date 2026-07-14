import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { generateInstallmentSchedule } from "@/lib/calculations";
import { eq, or, desc } from "drizzle-orm";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get loans where user is the lender
  const userLoans = await db
    .select()
    .from(loans)
    .where(eq(loans.lenderId, session.id))
    .orderBy(desc(loans.createdAt));

  return NextResponse.json({ loans: userLoans });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
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

  // Validation
  if (!borrowerName || !borrowerMobile || !amount || !tenureMonths || !startDate) {
    return NextResponse.json(
      { error: "Borrower name, mobile, amount, tenure, and start date are required" },
      { status: 400 }
    );
  }

  const principalAmount = parseFloat(amount);
  const rate = interestRate ? parseFloat(interestRate) : 0;
  const tenure = parseInt(tenureMonths);

  if (principalAmount <= 0 || tenure <= 0) {
    return NextResponse.json({ error: "Amount and tenure must be positive" }, { status: 400 });
  }

  // Create loan
  const [loan] = await db
    .insert(loans)
    .values({
      lenderId: session.id,
      borrowerName,
      borrowerMobile,
      amount: principalAmount.toFixed(2),
      interestRate: rate.toFixed(2),
      tenureMonths: tenure,
      startDate,
      upiId: upiId || null,
      accountNumber: accountNumber || null,
      notes: notes || null,
      confirmationMode: confirmationMode || "1-side",
      interestRatePeriod: interestRatePeriod || "yearly",
    })
    .returning();

  // Auto-generate installment schedule
  const ratePeriod = (interestRatePeriod === "monthly" ? "monthly" : "yearly") as "monthly" | "yearly";
  const schedule = generateInstallmentSchedule(principalAmount, rate, tenure, startDate, ratePeriod);

  const installmentValues = schedule.map((inst) => ({
    loanId: loan.id,
    installmentNumber: inst.installmentNumber,
    dueDate: inst.dueDate,
    principalAmount: inst.principalAmount.toFixed(2),
    interestAmount: inst.interestAmount.toFixed(2),
    totalAmount: inst.totalAmount.toFixed(2),
  }));

  await db.insert(installments).values(installmentValues);

  return NextResponse.json({ loan, installmentsGenerated: schedule.length }, { status: 201 });
}
