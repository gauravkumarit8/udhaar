import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, payments, reminders, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus, generateInstallmentSchedule } from "@/lib/calculations";
import { and, eq } from "drizzle-orm";
import { parseLoanInput } from "@/lib/validation";
import { hasNoCounterparty, isLoanAuthor, isLoanLender, isLoanParty, loanRole } from "@/lib/loan-access";
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

  // A party to the loan, or whoever typed it in.
  if (!isLoanParty(loan, session.id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const viewerRole = loanRole(loan, session.id);
  /**
   * Is there nobody on the other side to countersign?
   *
   * For a loan I lent, that is "the borrower hasn't joined". For one I owe -
   * which only I could have entered - it is "the lender has no account", and
   * the screen has to say so instead of offering them a button that 403s.
   */
  const noCounterparty = hasNoCounterparty(loan, session.id);

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
    loan: { ...loan, viewerRole, noCounterparty, isLender: viewerRole === "lender" },
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

  /*
   * Who may change the record itself?
   *
   *   - Whoever typed it in (so a borrower who entered "I owe ₹5,000" can fix
   *     a typo in their own entry).
   *   - But only while nobody else is relying on it: once the lender has an
   *     account, the loan is shared and only they can rewrite or remove it.
   *
   * Money is a different question - waiving and writing off live in the close
   * and payoff routes and stay lender-only, always.
   */
  const mayManageRecord = isLoanAuthor(loan, session.id) && (isLoanLender(loan, session.id) || !loan.lenderId);

  if (!mayManageRecord) {
    return NextResponse.json(
      {
        error: loan.lenderId
          ? "This loan is shared with its lender now, so only they can change it."
          : "Forbidden",
      },
      { status: 403 }
    );
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

  /*
   * Which way round is the loan *already*? An edit must not flip a debt
   * somebody owes into one they are owed; it only corrects the details. So the
   * direction is read off the stored row, not off the request body - and the
   * name and number being edited are the other person's, whichever side that
   * happens to be.
   */
  const storedAsBorrower =
    Boolean(loan.borrowerId) && loan.createdByUserId === loan.borrowerId && !loan.lenderId;
  const editAsBorrower = storedAsBorrower || (parsed.value.side === "borrower" && !loan.lenderId);

  const partnerName = editAsBorrower ? (parsed.value.lenderName ?? "") : parsed.value.borrowerName;
  const partnerMobile = editAsBorrower
    ? (parsed.value.lenderMobile ?? "")
    : parsed.value.borrowerMobile;

  // Re-resolve the other side's account if the mobile number changed (or was
  // never linked in the first place) - otherwise fixing a typo'd number would
  // leave the loan permanently invisible to them, for ever.
  let borrowerId = loan.borrowerId;
  let lenderId = loan.lenderId;
  let lenderName = loan.lenderName;
  let lenderMobile = loan.lenderMobile;

  if (editAsBorrower) {
    lenderName = partnerName;
    lenderMobile = partnerMobile;
    if (partnerMobile !== loan.lenderMobile || !loan.lenderId) {
      const [matchedLender] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.mobile, partnerMobile))
        .limit(1);
      lenderId = matchedLender?.id ?? null;
    }
    // The borrower is the person editing: their own name and number stand.
    borrowerId = loan.borrowerId ?? session.id;
  } else if (partnerMobile !== loan.borrowerMobile || !loan.borrowerId) {
    const [matchedBorrower] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.mobile, partnerMobile))
      .limit(1);
    borrowerId = matchedBorrower?.id ?? null;
  }

  const updatedLoan = await db.transaction(async (tx) => {
    const [loanRecord] = await tx
      .update(loans)
      .set({
        borrowerId,
        lenderId,
        lenderName,
        lenderMobile,
        // On a borrower-entered loan these two stay as the borrower typed
        // them; the partner fields above are the lender's.
        borrowerName: editAsBorrower ? loan.borrowerName : partnerName,
        borrowerMobile: editAsBorrower ? loan.borrowerMobile : partnerMobile,
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
  /*
   * A loan that only now found its owner (the mobile number was corrected, or
   * the person just signed up) is news to them - same notice as a new loan,
   * because that is what it is from their side. Either side can be the one
   * that just appeared: the borrower on a loan I lent, or the lender on a loan
   * I owed and entered myself.
   */
  const linkedNow = borrowerId !== loan.borrowerId || lenderId !== loan.lenderId;
  const notifyUserId = editAsBorrower ? lenderId : borrowerId;
  const worthTelling = linkedNow || scheduleChanged || paymentDetailsChanged;

  if (firstInst && notifyUserId && worthTelling) {

    await notifyCounterparty({
      userId: notifyUserId,
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

  const mayDeleteRecord = isLoanAuthor(loan, session.id) && (isLoanLender(loan, session.id) || !loan.lenderId);

  if (!mayDeleteRecord) {
    return NextResponse.json(
      {
        error: loan.lenderId
          ? "This loan is shared with its lender now, so only they can delete it."
          : "Forbidden",
      },
      { status: 403 }
    );
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
