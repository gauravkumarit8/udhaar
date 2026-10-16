import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reminders, loans, payments, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { countUnreadNotifications } from "@/lib/unread-count";
import { pendingPaymentByInstallment } from "@/lib/payments";
import { and, eq, inArray, isNull, or, desc, sql } from "drizzle-orm";
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

  /*
   * Does any of this need an answer? A "payment_marked" notification is how
   * somebody finds out that money has been claimed against their loan and that
   * it is their turn to confirm or reject it. The row has no payment id - the
   * reminders table records what was said, not what it was about - so the
   * pending payment is looked up by the installment it belongs to, in one
   * query for the whole page rather than one per row.
   *
   * Only claims marked by *someone else* are attached: offering Confirm on your
   * own payment gets a 403 from the API, which reads as a bug. That rule lives
   * in pendingPaymentByInstallment(), next to the loan screen's version of it.
   */
  const installmentIds = [...new Set(rows.map((r) => r.installmentId).filter(Boolean))];
  const pending = installmentIds.length
    ? await db
        .select({
          id: payments.id,
          installmentId: payments.installmentId,
          amount: payments.amount,
          paymentType: payments.paymentType,
          markedByUserId: payments.markedByUserId,
        })
        .from(payments)
        .where(and(inArray(payments.installmentId, installmentIds), eq(payments.status, "pending")))
    : [];
  const waiting = pendingPaymentByInstallment(pending, session.id);

  const notifications = rows.map((r) => {
    const claim = r.installmentId ? waiting.get(r.installmentId) : undefined;
    return {
      id: r.id,
      installmentId: r.installmentId,
      loanId: r.loanId,
      channel: r.channel,
      message: r.message,
      sentAt: r.sentAt,
      status: r.status,
      type: r.type,
      viewerRole: r.lenderId === session.id ? ("lender" as const) : ("borrower" as const),
      // Additive and optional: the payment this notification is waiting on, if
      // it is waiting on one, so the feed can answer it without opening the loan.
      paymentId: claim?.id ?? null,
      paymentAmount: claim ? Number(claim.amount) : null,
      paymentType: claim?.paymentType ?? null,
    };
  });

  return NextResponse.json(
    { notifications, unread: unreadCount },
    { headers: { "cache-control": "no-store" } }
  );
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
