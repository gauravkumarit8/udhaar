import { NextResponse } from "next/server";
import { db } from "@/db";
import { loans, installments } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { computeInstallmentStatus, formatINR } from "@/lib/calculations";
import { eq, sql } from "drizzle-orm";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get all active loans for this user
  const userLoans = await db
    .select()
    .from(loans)
    .where(eq(loans.lenderId, session.id));

  const activeLoans = userLoans.filter((l) => l.status === "active");

  // Compute summary
  let youWillReceive = 0;
  let youWillPay = 0;
  let totalInterestEarned = 0;
  const dueItems: Array<{
    loanId: string;
    borrowerName: string;
    installmentId: string;
    dueDate: string;
    amount: number;
    computedStatus: string;
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

      youWillReceive += remaining;
      totalInterestEarned += interestRemaining;

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
          installmentId: inst.id,
          dueDate: inst.dueDate,
          amount: remaining,
          computedStatus: status,
        });
      }
    }
  }

  // Sort due items: overdue first, then due_soon, then pending
  const statusOrder: Record<string, number> = { overdue: 0, due_soon: 1, partially_paid: 2, pending: 3 };
  dueItems.sort((a, b) => (statusOrder[a.computedStatus] ?? 4) - (statusOrder[b.computedStatus] ?? 4));

  // Due this week (next 7 days)
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
      youWillPay: 0, // MVP: user is always lender
      dueThisWeek: Math.round(dueThisWeek * 100) / 100,
      totalInterestEarned: Math.round(totalInterestEarned * 100) / 100,
      activeLoans: activeLoans.length,
      totalLoans: userLoans.length,
    },
    dueItems,
    loans: userLoans,
  });
}
