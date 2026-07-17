import { NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus } from "@/lib/calculations";
import { or, eq } from "drizzle-orm";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get all loans where the user is either the lender or the borrower,
  // joined with the lender's name (useful when the viewer is the borrower)
  const rows = await db
    .select({ loan: loans, lenderName: users.name })
    .from(loans)
    .leftJoin(users, eq(users.id, loans.lenderId))
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)));

  const taggedLoans = rows.map(({ loan, lenderName }) => ({
    ...loan,
    lenderName,
    viewerRole: loan.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
  }));

  const activeLoans = taggedLoans.filter((l) => l.status === "active");

  // Compute summary
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
    const insts = await db
      .select()
      .from(installments)
      .where(eq(installments.loanId, loan.id))
      .orderBy(installments.installmentNumber);

    for (const inst of insts) {
      const principalRemaining = parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid);
      const interestRemaining = parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid);
      const remaining = principalRemaining + interestRemaining;

      if (loan.viewerRole === "lender") {
        youWillReceive += remaining;
        totalInterestEarned += interestRemaining;
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

  // Sort due items: overdue first, then due_soon, then pending
  const statusOrder: Record<string, number> = { overdue: 0, due_soon: 1, partially_paid: 2, pending: 3 };
  dueItems.sort((a, b) => (statusOrder[a.computedStatus] ?? 4) - (statusOrder[b.computedStatus] ?? 4));

  // Due this week (next 7 days), across both roles
  const dueThisWeek = dueItems
    .filter((d) => {
      const due = new Date(d.dueDate + "T00:00:00");
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const diff = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return diff <= 7;
    })
    .reduce((sum, d) => sum + d.amount, 0);

  return NextResponse.json({
    summary: {
      youWillReceive: Math.round(youWillReceive * 100) / 100,
      youWillPay: Math.round(youWillPay * 100) / 100,
      dueThisWeek: Math.round(dueThisWeek * 100) / 100,
      totalInterestEarned: Math.round(totalInterestEarned * 100) / 100,
      activeLoans: activeLoans.length,
      totalLoans: taggedLoans.length,
    },
    dueItems,
    loans: taggedLoans,
  });
}
