/**
 * Scheduled reminder logic (M9).
 *
 * The reminder cadence lived only in the client: `scheduleInstallmentReminders`
 * in `src/lib/native.ts` books local notifications on the *lender's* device for
 * T-2, T-1, T0 and then a daily nag for a week. That works while the lender is
 * using the app, but the person who actually owes the money was only ever
 * reminded when the lender opened the app and tapped "Remind".
 *
 * This module is the same cadence, but for the server: given an EMI's due date
 * and today's date, it says whether a reminder is due now. `POST
 * /api/reminders/run` calls it; a free scheduler (GitHub Actions) calls that.
 *
 * Everything here is pure so it can be tested without a database, and dates are
 * plain "YYYY-MM-DD" strings compared in India time - the due dates are Indian
 * calendar dates, so "today" has to be too.
 */

export type ReminderUrgency = "upcoming" | "due" | "overdue";

export interface ReminderPlan {
  /** Stable identifier for the day's nudge: "T-2" | "T-1" | "T0" | "overdue-3". */
  kind: string;
  /** Days until the due date. Negative means it hasn't arrived yet. */
  daysUntilDue: number;
  urgency: ReminderUrgency;
  /** Notification title, matching the wording the client already uses. */
  title: string;
}

/** How many days past due the daily nag keeps going (same as the client). */
export const OVERDUE_NAG_DAYS = 7;

/** Today's date in India, as "YYYY-MM-DD". */
export function todayInIndia(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we compare.
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Whole days between two YYYY-MM-DD dates (b - a), ignoring time and DST. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Should this EMI be reminded about today?
 *
 * T-2 and T-1 (before due), T0 (on the day), then one a day for the first
 * week it's late. After that we stop: an EMI that's months overdue is a
 * conversation, not a notification.
 */
export function planReminder(dueDate: string, today: string): ReminderPlan | null {
  const daysUntilDue = daysBetween(today, dueDate);

  if (daysUntilDue === 2) {
    return { kind: "T-2", daysUntilDue, urgency: "upcoming", title: "💰 Payment Reminder — 2 days away" };
  }
  if (daysUntilDue === 1) {
    return { kind: "T-1", daysUntilDue, urgency: "upcoming", title: "💰 Payment Reminder — Tomorrow" };
  }
  if (daysUntilDue === 0) {
    return { kind: "T0", daysUntilDue, urgency: "due", title: "💰 Payment Reminder — Due today" };
  }
  if (daysUntilDue <= -1 && daysUntilDue >= -OVERDUE_NAG_DAYS) {
    const days = -daysUntilDue;
    return {
      kind: `overdue-${days}`,
      daysUntilDue,
      urgency: "overdue",
      title: `🔴 Overdue — ${days} day${days > 1 ? "s" : ""} past due`,
    };
  }

  return null;
}

/**
 * A key that makes the sweep idempotent.
 *
 * The scheduler can fire twice (retries, a manual run, a misconfigured cron,
 * GitHub's timer landing twice). The unique index on `reminders.dedupe_key`
 * means the second attempt to remind about the same EMI on the same day loses
 * the insert and is skipped, instead of buzzing the borrower's phone twice.
 */
export function reminderDedupeKey(installmentId: string, kind: string, day: string): string {
  return `${installmentId}:${kind}:${day}`;
}

/** The body of the notification - names the lender, not the recipient. */
export function composeReminderBody(input: {
  lenderName: string;
  amount: number;
  dueDateLabel: string;
  urgency: ReminderUrgency;
}): string {
  const { lenderName, amount, dueDateLabel, urgency } = input;
  const money = formatRupees(amount);

  if (urgency === "overdue") {
    return `${lenderName} is waiting for ${money}, which was due on ${dueDateLabel}. Pay via UPI in the Udhaar app.`;
  }
  if (urgency === "due") {
    return `${money} to ${lenderName} is due today. Pay via UPI in the Udhaar app.`;
  }
  return `${money} to ${lenderName} is due on ${dueDateLabel}. Pay via UPI in the Udhaar app.`;
}

/** ₹ formatting without pulling the whole calculations module in. */
export function formatRupees(amount: number): string {
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(amount)}`;
}

/**
 * Constant-time string comparison, so the sweep's secret can't be guessed a
 * character at a time.
 */
export function secretsMatch(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  if (provided.length !== expected.length) return false;

  // Imported lazily: this module is also used by client-side code paths that
  // never see the secret.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Pulls the secret out of `Authorization: Bearer …` or `x-cron-secret`. */
export function extractSecret(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();

  const direct = headers.get("x-cron-secret");
  if (direct) return direct.trim();

  return null;
}
