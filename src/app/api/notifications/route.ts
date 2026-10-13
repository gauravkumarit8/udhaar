import { NextResponse } from "next/server";
import { db } from "@/db";
import { reminders, loans } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { and, eq, isNull, or, desc } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only the notifications *addressed to* this user: the copy is written in
  // the second person ("your loan", "for you"), so showing the other side's
  // would read as though it were about them. Rows written before recipient_id
  // existed are shown to both sides of the loan, as they used to be.
  //
  // The loan join still runs, so a notification for a loan the viewer is no
  // longer part of cannot leak in.
  const rows = await db
    .select({
      id: reminders.id,
      installmentId: reminders.installmentId,
      loanId: reminders.loanId,
      channel: reminders.channel,
      message: reminders.message,
      sentAt: reminders.sentAt,
      status: reminders.status,
      type: reminders.type,
      recipientId: reminders.recipientId,
      lenderId: loans.lenderId,
      borrowerId: loans.borrowerId,
    })
    .from(reminders)
    .innerJoin(loans, eq(loans.id, reminders.loanId))
    .where(
      and(
        or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)),
        or(eq(reminders.recipientId, session.id), isNull(reminders.recipientId))
      )
    )
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
    type: r.type,
    viewerRole: r.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
  }));

  return NextResponse.json({ notifications });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
