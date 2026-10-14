import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { generateInstallmentSchedule } from "@/lib/calculations";
import { loanAddedNotice, notifyCounterparty } from "@/lib/notify";
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
  // "You lent" vs "You borrowed". A loan the viewer entered for a lender who
  // has no account is still theirs, so it must not vanish from the list.
  const taggedLoans = userLoans.map((loan) => ({
    ...loan,
    viewerRole: loan.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
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
    side,
    borrowerName: inputBorrowerName,
    borrowerMobile: inputBorrowerMobile,
    lenderName: inputLenderName,
    lenderMobile: inputLenderMobile,
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

  /*
   * Two directions, one table.
   *
   *   side "lender"   - I lent money: I am the lender, and I name the borrower.
   *   side "borrower" - I owe money: I am the borrower, and I name the lender,
   *                     who may never have used Udhaar (lenderId stays null
   *                     until they sign up with that number).
   *
   * Either way the person asking is recorded as the author of the record, so
   * they can fix their own typo - and only the *lender* can forgive anything.
   */
  const asBorrower = side === "borrower";

  const borrowerName = asBorrower ? session.name : inputBorrowerName;
  const borrowerMobile = asBorrower ? session.mobile : inputBorrowerMobile;
  const lenderName = asBorrower ? inputLenderName : session.name;
  const lenderMobile = asBorrower ? inputLenderMobile : session.mobile;

  // Resolve the counterparty's account, if they've already signed up.
  const counterpartyMobile = asBorrower ? lenderMobile : borrowerMobile;
  const [existingCounterparty] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.mobile, counterpartyMobile!))
    .limit(1);

  const existingBorrower = asBorrower ? { id: session.id } : existingCounterparty;
  const existingLender = asBorrower ? (existingCounterparty ?? null) : { id: session.id };

  // Create loan
  const [loan] = await db
    .insert(loans)
    .values({
      lenderId: existingLender?.id ?? null,
      borrowerId: existingBorrower?.id ?? null,
      createdByUserId: session.id,
      lenderName,
      lenderMobile,
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

  // Tell the other person, if they already have an account - the borrower on a
  // loan I lent, or the lender on a loan I owe. The row is anchored to the
  // first EMI because that is what the Activity feed links to; anyone who
  // signs up later is picked up by the backfill helpers on first login.
  const notifyUserId = asBorrower ? existingLender?.id : existingBorrower?.id;
  if (notifyUserId && insertedInstallments.length > 0) {
    const firstInst = insertedInstallments[0];

    await notifyCounterparty({
      userId: notifyUserId,
      installmentId: firstInst.id,
      loanId: loan.id,
      notice: loanAddedNotice({
        actorName: session.name,
        amount: principalAmount,
        firstDueAmount: parseFloat(firstInst.totalAmount),
        firstDueDate: firstInst.dueDate,
      }),
    });
  }

  return NextResponse.json({ loan, installmentsGenerated: schedule.length }, { status: 201 });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
export const POST = withErrors(handlePOST);
