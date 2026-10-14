import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { installments, loans, reminders, users } from "@/db/schema";
import { sendPushToUser } from "@/lib/push";
import { remainingFor } from "@/lib/payments";
import { formatDate, generateUPILink } from "@/lib/calculations";
import { withErrors } from "@/lib/api-handler";
import {
  OVERDUE_NAG_DAYS,
  composeReminderBody,
  extractSecret,
  planReminder,
  reminderDedupeKey,
  secretsMatch,
  todayInIndia,
} from "@/lib/reminders";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Safety valve: never fire an unbounded number of pushes in one sweep. */
const MAX_PER_RUN = 200;

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return date.toISOString().slice(0, 10);
}

/**
 * Server-side reminder sweep (the missing half of M9).
 *
 * Called on a schedule by a free external clock - `.github/workflows/
 * reminders.yml` every morning at 09:00 IST - and never by a browser. It walks
 * the EMIs that are due soon or recently missed and pushes a reminder to the
 * borrower, using exactly the cadence the app already uses for the lender's
 * own device notifications (T-2, T-1, T0, then a daily nag for 7 days).
 *
 * Safe to call twice: `reminders.dedupe_key` is unique, so the second run
 * loses the insert and skips (see src/lib/reminders.ts).
 *
 *   POST /api/reminders/run
 *   Authorization: Bearer $CRON_SECRET
 *   ?dryRun=1   → report what would be sent, send nothing
 *
 * Answers 503 when CRON_SECRET isn't configured rather than acting as an open
 * relay that anyone can use to spam every borrower.
 */
async function handlePOST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return NextResponse.json(
      {
        error: "Scheduled reminders are not configured on this deployment.",
        action:
          "Set CRON_SECRET on the service (a long random string), then add the same value as a GitHub Actions secret named CRON_SECRET.",
      },
      { status: 503 }
    );
  }

  if (!secretsMatch(extractSecret(req.headers), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun =
    req.nextUrl.searchParams.get("dryRun") === "1" ||
    req.nextUrl.searchParams.get("dryRun") === "true";

  const today = todayInIndia();
  const from = addDays(today, -(OVERDUE_NAG_DAYS + 1)); // a little slack past the nag window
  const to = addDays(today, 2);

  // Candidate EMIs: active loans with an installment due in the reminder
  // window. Filtering in SQL keeps the sweep cheap on a big database.
  const candidates = await db
    .select({
      installmentId: installments.id,
      loanId: installments.loanId,
      dueDate: installments.dueDate,
      principalAmount: installments.principalAmount,
      interestAmount: installments.interestAmount,
      principalPaid: installments.principalPaid,
      interestPaid: installments.interestPaid,
      // Waived money is settled money. A closed loan is already filtered out
      // below, so today this only matters if a waiver ever happens on an
      // active loan - but the sweep must never be the one place that forgets,
      // or it will chase a debt that has been forgiven.
      principalWaived: installments.principalWaived,
      interestWaived: installments.interestWaived,
      borrowerId: loans.borrowerId,
      lenderName: users.name,
      lenderUpiId: loans.upiId,
      borrowerName: loans.borrowerName,
    })
    .from(installments)
    .innerJoin(loans, eq(loans.id, installments.loanId))
    .innerJoin(users, eq(users.id, loans.lenderId))
    .where(
      and(
        eq(loans.status, "active"),
        gte(installments.dueDate, from),
        lte(installments.dueDate, to)
      )
    )
    .limit(MAX_PER_RUN + 1);

  const truncated = candidates.length > MAX_PER_RUN;
  const pool = truncated ? candidates.slice(0, MAX_PER_RUN) : candidates;

  // Which of today's reminders have already gone out?
  const ids = pool.map((c) => c.installmentId);
  const alreadySent = new Set<string>();

  if (ids.length > 0) {
    const existing = await db
      .select({ dedupeKey: reminders.dedupeKey })
      .from(reminders)
      .where(and(inArray(reminders.installmentId, ids), sql`${reminders.dedupeKey} is not null`));

    for (const row of existing) {
      if (row.dedupeKey) alreadySent.add(row.dedupeKey);
    }
  }

  const skipped: Array<{ installmentId: string; reason: string }> = [];
  const sent: Array<{
    installmentId: string;
    kind: string;
    delivered: boolean;
    pushSent: number;
    reason?: string;
  }> = [];
  let notDueToday = 0;

  for (const candidate of pool) {
    const { totalRemaining, interestRemaining } = remainingFor(candidate);

    // Nothing left to chase on this EMI.
    if (totalRemaining <= 0) {
      notDueToday += 1;
      continue;
    }

    const plan = planReminder(candidate.dueDate, today);
    if (!plan) {
      notDueToday += 1;
      continue;
    }

    const dedupeKey = reminderDedupeKey(candidate.installmentId, plan.kind, today);

    if (alreadySent.has(dedupeKey)) {
      skipped.push({ installmentId: candidate.installmentId, reason: "already reminded today" });
      continue;
    }

    // Nobody to push to yet: the borrower hasn't joined Udhaar, so there is no
    // user row and no device token. The lender still sees it in Activity.
    if (!candidate.borrowerId) {
      skipped.push({ installmentId: candidate.installmentId, reason: "borrower has no Udhaar account" });
      continue;
    }

    const body = composeReminderBody({
      lenderName: candidate.lenderName,
      amount: totalRemaining,
      dueDateLabel: formatDate(candidate.dueDate),
      urgency: plan.urgency,
    });

    if (dryRun) {
      sent.push({
        installmentId: candidate.installmentId,
        kind: plan.kind,
        delivered: false,
        pushSent: 0,
        reason: "dry run",
      });
      continue;
    }

    // Claim the slot *before* sending: the unique index is what makes a
    // double-fired scheduler harmless. If this returns nothing, another worker
    // (or an earlier run) already took today's reminder for this EMI.
    const [claim] = await db
      .insert(reminders)
      .values({
        installmentId: candidate.installmentId,
        loanId: candidate.loanId,
        recipientId: candidate.borrowerId,
        type: "reminder",
        channel: "push",
        message: body,
        dedupeKey,
        status: "failed", // flipped to "sent" once a device actually accepted it
      })
      .onConflictDoNothing({ target: reminders.dedupeKey })
      .returning({ id: reminders.id });

    if (!claim) {
      skipped.push({ installmentId: candidate.installmentId, reason: "already reminded today" });
      continue;
    }

    const upiLink = candidate.lenderUpiId
      ? generateUPILink(
          candidate.lenderUpiId,
          totalRemaining,
          `Payment for ${candidate.borrowerName}`,
          candidate.lenderName
        )
      : null;

    const pushResult = await sendPushToUser(candidate.borrowerId, plan.title, body, {
      type: "reminder",
      kind: plan.kind,
      installmentId: candidate.installmentId,
      loanId: candidate.loanId,
      ...(upiLink ? { upiLink } : {}),
    });

    const delivered = pushResult.sent > 0;

    await db
      .update(reminders)
      .set({ status: delivered ? "sent" : "failed" })
      .where(eq(reminders.id, claim.id));

    sent.push({
      installmentId: candidate.installmentId,
      kind: plan.kind,
      delivered,
      pushSent: pushResult.sent,
      reason: delivered
        ? undefined
        : "the borrower has no device registered for push notifications",
    });
  }

  const deliveredCount = sent.filter((s) => s.delivered).length;

  return NextResponse.json({
    ran: true,
    dryRun,
    date: today,
    window: { from, to },
    checked: pool.length,
    candidates: pool.length - notDueToday,
    delivered: deliveredCount,
    recorded: sent.length,
    skipped: skipped.length,
    skippedDetail: skipped.slice(0, 20),
    sent: sent.slice(0, 50),
    truncated,
    note:
      deliveredCount === 0 && sent.length > 0
        ? "Reminders were recorded, but no push reached a device. Borrowers need to open the app once and allow notifications."
        : undefined,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
