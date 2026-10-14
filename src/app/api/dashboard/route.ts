import { NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus, daysUntil } from "@/lib/calculations";
import { or, eq, inArray, sql } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Everything in one pass: the loans this user is party to, plus the
  // lender's name (useful when the viewer is the borrower).
  // LEFT JOIN, and the stored name wins: a loan a borrower entered names a
  // lender who may have no account at all, and that loan must still appear.
  const rows = await db
    .select({ loan: loans, accountName: users.name })
    .from(loans)
    .leftJoin(users, eq(users.id, loans.lenderId))
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)));

  const taggedLoans = rows.map(({ loan, accountName }) => ({
    ...loan,
    lenderName: loan.lenderName || accountName,
    viewerRole: loan.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
  }));

  const activeLoans = taggedLoans.filter((l) => l.status === "active");
  const activeLoanIds = activeLoans.map((l) => l.id);

  // One query for every installment across those loans instead of one query
  // per loan inside the loop (which grew with the number of loans).
  const allInstallments =
    activeLoanIds.length > 0
      ? await db.select().from(installments).where(inArray(installments.loanId, activeLoanIds))
      : [];

  const installmentsByLoan = new Map<string, typeof allInstallments>();
  for (const inst of allInstallments) {
    const list = installmentsByLoan.get(inst.loanId);
    if (list) list.push(inst);
    else installmentsByLoan.set(inst.loanId, [inst]);
  }

  let youWillReceive = 0; // remaining on loans where you're the lender
  let youWillPay = 0; // remaining on loans where you're the borrower
  let totalInterestEarned = 0; // interest remaining on loans where you're the lender
  const dueItems: Array<{
    loanId: string;
    borrowerName: string;
    lenderName: string | null;
    installmentId: string;
    dueDate: string;
    amount: number;
    computedStatus: string;
    viewerRole: "lender" | "borrower";
  }> = [];

  for (const loan of activeLoans) {
    const insts = installmentsByLoan.get(loan.id) ?? [];

    for (const inst of insts) {
      const principalRemaining = parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid);
      const interestRemaining = parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid);
      const remaining = Math.max(0, principalRemaining) + Math.max(0, interestRemaining);

      if (loan.viewerRole === "lender") {
        youWillReceive += remaining;
        totalInterestEarned += Math.max(0, interestRemaining);
      } else {
        youWillPay += remaining;
      }

      const status = computeInstallmentStatus(
        inst.dueDate,
        parseFloat(inst.principalAmount),
        parseFloat(inst.interestAmount),
        parseFloat(inst.principalPaid),
        parseFloat(inst.interestPaid)
      );

      if (status !== "paid" && remaining > 0) {
        dueItems.push({
          loanId: loan.id,
          borrowerName: loan.borrowerName,
          lenderName: loan.lenderName,
          installmentId: inst.id,
          dueDate: inst.dueDate,
          amount: remaining,
          computedStatus: status,
          viewerRole: loan.viewerRole,
        });
      }
    }
  }

  // Sort due items: overdue first, then the soonest due date.
  const statusOrder: Record<string, number> = { overdue: 0, due_soon: 1, partially_paid: 2, pending: 3 };
  dueItems.sort((a, b) => {
    const byStatus = (statusOrder[a.computedStatus] ?? 4) - (statusOrder[b.computedStatus] ?? 4);
    return byStatus !== 0 ? byStatus : a.dueDate.localeCompare(b.dueDate);
  });

  // Due in the next 7 days (overdue money already being chased is reported
  // separately - it used to be lumped into this number, which made
  // "Due This Week" mean "everything overdue, ever").
  let dueThisWeek = 0;
  let overdueAmount = 0;
  for (const item of dueItems) {
    const days = daysUntil(item.dueDate);
    if (days < 0) overdueAmount += item.amount;
    else if (days <= 7) dueThisWeek += item.amount;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return NextResponse.json({
    summary: {
      youWillReceive: round2(youWillReceive),
      youWillPay: round2(youWillPay),
      dueThisWeek: round2(dueThisWeek),
      overdueAmount: round2(overdueAmount),
      totalInterestEarned: round2(totalInterestEarned),
      activeLoans: activeLoans.length,
      totalLoans: taggedLoans.length,
    },
    dueItems,
    loans: taggedLoans,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
