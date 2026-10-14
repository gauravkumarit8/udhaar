/**
 * How many notifications this person has not seen yet.
 *
 * One query, and the `users` row is joined rather than fetched first so the
 * "seen since" cutoff costs nothing extra. It lives here because three routes
 * need the same number: the Activity badge (`/api/notifications?summary=1`),
 * the feed itself, and now the screens that answer it in passing (dashboard,
 * loan detail) so the tab bar does not have to ask a second time from the
 * browser - one request from the phone instead of two.
 */
import { db } from "@/db";
import { reminders, loans, users } from "@/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";

export async function countUnreadNotifications(userId: string): Promise<number> {
  const [counted] = await db
    .select({ unread: sql<number>`count(*)::int` })
    .from(reminders)
    .innerJoin(loans, eq(loans.id, reminders.loanId))
    .innerJoin(users, eq(users.id, userId))
    .where(
      and(
        or(eq(loans.lenderId, userId), eq(loans.borrowerId, userId)),
        or(eq(reminders.recipientId, userId), isNull(reminders.recipientId)),
        sql`${users.notificationsSeenAt} is null or ${reminders.sentAt} > ${users.notificationsSeenAt}`
      )
    );

  return counted?.unread ?? 0;
}
