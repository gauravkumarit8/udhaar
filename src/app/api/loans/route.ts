import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, users, reminders } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { generateInstallmentSchedule, formatINR, formatDate } from "@/lib/calculations";
import { sendPushToUser } from "@/lib/push";
import { parseLoanInput } from "@/lib/validation";
import { eq, or, desc } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get loans where the user is either the lender or the borrower
  const userLoans = await db
    .select()
    .from(loans)
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)))
    .orderBy(desc(loans.createdAt));

  // Tag each loan with the viewer's role so the UI can render
  // "You lent" vs "You borrowed"
  const taggedLoans = userLoans.map((loan) => ({
    ...loan,
    viewerRole: loan.lenderId === session.id ? "lender" : "borrower",
  }));

  return NextResponse.json({ loans: taggedLoans });
}

async function handlePOST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const parsed = parseLoanInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const {
    borrowerName,
    borrowerMobile,
    amount: principalAmount,
    interestRate: rate,
    interestRatePeriod,
    tenureMonths: tenure,
    startDate,
    upiId,
    accountNumber,
    notes,
    confirmationMode,
  } = parsed.value;

  // Resolve the borrower's user account, if they've already signed up
  const [existingBorrower] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.mobile, borrowerMobile))
    .limit(1);

  // Create loan
  const [loan] = await db
    .insert(loans)
    .values({
      lenderId: session.id,
      borrowerId: existingBorrower?.id ?? null,
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

  const insertedInstallments = await db.insert(installments).values(installmentValues).returning();

  // Notify the borrower if they already have an account - attach the
  // notification to the first installment since `reminders` is scoped
  // to a specific EMI.
  if (existingBorrower && insertedInstallments.length > 0) {
    const firstInst = insertedInstallments[0];
    const message = `${session.name} added a loan of ${formatINR(principalAmount)} for you on Udhaar. First payment of ${formatINR(firstInst.totalAmount)} due on ${formatDate(firstInst.dueDate)}.`;

    await db.insert(reminders).values({
      installmentId: firstInst.id,
      loanId: loan.id,
      channel: "push",
      message,
      status: "sent",
    });

    await sendPushToUser(existingBorrower.id, "💸 New loan added", message, {
      type: "loan_added",
      loanId: loan.id,
    });
  }

  return NextResponse.json({ loan, installmentsGenerated: schedule.length }, { status: 201 });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
export const POST = withErrors(handlePOST);
