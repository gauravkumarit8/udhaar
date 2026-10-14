import { NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus, daysUntil } from "@/lib/calculations";
import { pickNextDuePerLoan, type DueItem } from "@/lib/due-items";
import { or, eq, sql } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /*
   * Loans and their installments in **one** query.
   *
   * This was two sequential round trips (loans, then installments for those
   * loan ids). Against a database in another region - Neon, ~40ms per trip -
   * the second one is a whole economy of latency for data the join already
   * has, and the dashboard is the screen everybody opens first.
   *
   * LEFT JOIN on users and not an inner one: a loan a borrower entered names a
   * lender who may have no account at all, and that loan must still appear.
   * The stored name wins over the account name when both exist.
   */
  const rows = await db
    .select({ loan: loans, accountName: users.name, installment: installments })
    .from(loans)
    .leftJoin(users, eq(users.id, loans.lenderId))
    .leftJoin(installments, eq(installments.loanId, loans.id))
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)));

  const loansById = new Map<string, (typeof rows)[number]["loan"] & { lenderName: string | null }>();
  type Installment = NonNullable<(typeof rows)[number]["installment"]>;
  const installmentsByLoan = new Map<string, Installment[]>();

  for (const row of rows) {
    if (!loansById.has(row.loan.id)) {
      loansById.set(row.loan.id, {
        ...row.loan,
        lenderName: row.loan.lenderName || row.accountName,
      });
    }
    // The join is a LEFT one, so a loan with no schedule still arrives - once,
    // with a null installment instead of no row at all.
    if (!row.installment) continue;
    const list = installmentsByLoan.get(row.loan.id);
    if (list) list.push(row.installment);
    else installmentsByLoan.set(row.loan.id, [row.installment]);
  }

  const taggedLoans = [...loansById.values()].map((loan) => ({
    ...loan,
    viewerRole: loan.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
  }));

  const activeLoans = taggedLoans.filter((l) => l.status === "active");

  let youWillReceive = 0; // remaining on loans where you're the lender
  let youWillPay = 0; // remaining on loans where you're the borrower
  let totalInterestEarned = 0; // interest remaining on loans where you're the lender
  const dueCandidates: Parameters<typeof pickNextDuePerLoan>[0] = [];

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
        dueCandidates.push({
          loanId: loan.id,
          borrowerName: loan.borrowerName,
          lenderName: loan.lenderName,
          installmentId: inst.id,
          installmentNumber: inst.installmentNumber,
          dueDate: inst.dueDate,
          amount: remaining,
          computedStatus: status,
          viewerRole: loan.viewerRole,
        });
      }
    }
  }

  /*
   * The summary numbers are about *all* outstanding money, so they are
   * computed from every unpaid installment - the list is narrowed to one row
   * per loan only for display (see src/lib/due-items.ts).
   *
   * Due in the next 7 days, and everything overdue: these used to be one
   * number, which made "Due This Week" mean "everything overdue, ever".
   */
  let dueThisWeek = 0;
  let overdueAmount = 0;
  for (const item of dueCandidates) {
    const days = daysUntil(item.dueDate);
    if (days < 0) overdueAmount += item.amount;
    else if (days <= 7) dueThisWeek += item.amount;
  }

  const dueItems: DueItem[] = pickNextDuePerLoan(dueCandidates);

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return NextResponse.json({
    // The dashboard already knows who is asking (its session was the first
    // query), so the page no longer needs a second request to /api/auth/me
    // just to print a name in the greeting.
    user: { name: session.name, mobile: session.mobile },
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
