import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, payments, reminders, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus, generateInstallmentSchedule } from "@/lib/calculations";
import { and, eq } from "drizzle-orm";
import { parseLoanInput } from "@/lib/validation";
import { withErrors } from "@/lib/api-handler";
import { loanAddedNotice, loanUpdatedNotice, notifyCounterparty } from "@/lib/notify";

async function handleGET(
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

  // Only the lender or the linked borrower may view this loan
  if (loan.lenderId !== session.id && loan.borrowerId !== session.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const viewerRole = loan.lenderId === session.id ? "lender" : "borrower";

  // Get installments with computed status
  const rawInstallments = await db
    .select()
    .from(installments)
    .where(eq(installments.loanId, id))
    .orderBy(installments.installmentNumber);

  const enrichedInstallments = rawInstallments.map((inst) => ({
    ...inst,
    // Waived money is settled money: an EMI the lender wrote off must read as
    // finished rather than sitting there OVERDUE for ever. The row itself still
    // shows what was paid and what was written off, so the two never blur.
    computedStatus: computeInstallmentStatus(
      inst.dueDate,
      parseFloat(inst.principalAmount),
      parseFloat(inst.interestAmount),
      parseFloat(inst.principalPaid) + parseFloat(inst.principalWaived),
      parseFloat(inst.interestPaid) + parseFloat(inst.interestWaived)
    ),
  }));

  // Get payments for this loan
  const loanPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.loanId, id))
    .orderBy(payments.createdAt);

  return NextResponse.json({
    loan: { ...loan, viewerRole },
    installments: enrichedInstallments,
    payments: loanPayments,
  });
}

async function handlePATCH(
  req: NextRequest,
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

  // A payment that's still awaiting confirmation refers to specific EMIs.
  // Rebuilding the schedule under it would orphan it, so make the caller
  // resolve it first.
  if (scheduleChanged) {
    const [pendingPayment] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.loanId, id), eq(payments.status, "pending")))
      .limit(1);

    if (pendingPayment) {
      return NextResponse.json(
        {
          error:
            "This loan has a payment waiting for confirmation. Confirm or reject it before changing the EMI schedule.",
        },
        { status: 400 }
      );
    }
  }

  // Re-resolve the borrower's account if the mobile number changed (or was
  // never linked in the first place) - otherwise fixing a typo'd number
  // would leave the loan permanently invisible to the borrower.
  let borrowerId = loan.borrowerId;
  if (borrowerMobile !== loan.borrowerMobile) {
    const [matchedBorrower] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.mobile, borrowerMobile))
      .limit(1);
    borrowerId = matchedBorrower?.id ?? null;
  }

  const updatedLoan = await db.transaction(async (tx) => {
    const [loanRecord] = await tx
      .update(loans)
      .set({
        borrowerId,
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
      // Reminders were generated from the old schedule, so they go with it.
      // (The child FKs also cascade, but being explicit keeps this correct
      // even on a database that hasn't picked up the new constraint yet.)
      await tx.delete(reminders).where(eq(reminders.loanId, id));
      await tx.delete(payments).where(eq(payments.loanId, id));
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

  // Tell the borrower, after the transaction: a rebuilt schedule deletes the
  // old installments (and the notification rows anchored to them) inside it,
  // so the notice has to be written against the new schedule, not the old one.
  const [firstInst] = await db
    .select({ id: installments.id, totalAmount: installments.totalAmount, dueDate: installments.dueDate })
    .from(installments)
    .where(eq(installments.loanId, id))
    .orderBy(installments.installmentNumber)
    .limit(1);

  const paymentDetailsChanged =
    loan.upiId !== (upiId || null) || loan.accountNumber !== (accountNumber || null);
  // A loan that only now found its owner (the mobile number was corrected, or
  // the person just signed up) is news to them - same notice as a new loan,
  // because that is what it is from their side.
  const linkedNow = borrowerId !== loan.borrowerId;
  const worthTelling = linkedNow || scheduleChanged || paymentDetailsChanged;

  if (firstInst && borrowerId && worthTelling) {

    await notifyCounterparty({
      userId: borrowerId,
      installmentId: firstInst.id,
      loanId: id,
      notice: linkedNow
        ? loanAddedNotice({
            actorName: session.name,
            amount: principalAmount,
            firstDueAmount: parseFloat(firstInst.totalAmount),
            firstDueDate: firstInst.dueDate,
            waiting: true,
          })
        : loanUpdatedNotice({
            actorName: session.name,
            amount: principalAmount,
            tenureMonths: tenure,
            startDate,
            scheduleRebuilt: scheduleChanged,
            paymentDetailsChanged,
          }),
    });
  }

  return NextResponse.json({ success: true, loan: updatedLoan });
}

async function handleDELETE(
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

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
export const PATCH = withErrors(handlePATCH);
export const DELETE = withErrors(handleDELETE);
