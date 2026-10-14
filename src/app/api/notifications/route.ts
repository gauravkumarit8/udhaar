import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reminders, loans, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { countUnreadNotifications } from "@/lib/unread-count";
import { and, eq, isNull, or, desc, sql } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

async function handleGET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /*
   * The bottom-nav badge asks for the count alone - and it asks on every screen
   * mount, so it is the most frequently run request in the app. This used to
   * fall through the *whole* feed query (30 rows, joined twice) plus a second
   * query for "seen at" and a third for the rows to count, then throw all of it
   * away and return a single number: four database round trips to render one
   * digit. Against a remote database that was the slowest thing on every
   * screen. Now it is one query after the session.
   */
  const summaryOnly = new URL(req.url).searchParams.get("summary") === "1";

  if (summaryOnly) {
    return NextResponse.json(
      { unread: await countUnreadNotifications(session.id) },
      { headers: { "cache-control": "no-store" } }
    );
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

  /*
   * "Unread" is everything addressed to the viewer since they last opened the
   * Activity screen - measured on the server, so the badge is the same on
   * every device and survives a reinstall.
   *
   * The count comes from the database as a count, and uses the same
   * `users`-joined trick as the summary path above, so this screen also costs
   * one query fewer than it did.
   */
  const unreadCount = await countUnreadNotifications(session.id);

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

  return NextResponse.json(
    { notifications, unread: unreadCount },
    { headers: { "cache-control": "no-store" } }
  );
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
