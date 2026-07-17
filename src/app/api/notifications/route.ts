import { NextResponse } from "next/server";
import { db } from "@/db";
import { reminders, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { eq, or, desc } from "drizzle-orm";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Reminders for any loan where the user is either the lender or the borrower
  const rows = await db
    .select({
      id: reminders.id,
      installmentId: reminders.installmentId,
      loanId: reminders.loanId,
      channel: reminders.channel,
      message: reminders.message,
      sentAt: reminders.sentAt,
      status: reminders.status,
      lenderId: loans.lenderId,
      borrowerId: loans.borrowerId,
    })
    .from(reminders)
    .innerJoin(loans, eq(loans.id, reminders.loanId))
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)))
    .orderBy(desc(reminders.sentAt))
    .limit(30);

  const notifications = rows.map((r) => ({
    id: r.id,
    installmentId: r.installmentId,
    loanId: r.loanId,
    channel: r.channel,
    message: r.message,
    sentAt: r.sentAt,
    status: r.status,
    viewerRole: r.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
  }));

  return NextResponse.json({ notifications });
}
