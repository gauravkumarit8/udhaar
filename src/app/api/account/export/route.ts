import { NextResponse } from "next/server";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { installments, loans, payments, reminders, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { withErrors } from "@/lib/api-handler";

/**
 * Everything the app knows about you, as one JSON file.
 *
 * Both the DPDP Act and plain decency point the same way: a person should be
 * able to take their data out without asking anyone. This is deliberately a
 * download rather than a screen - it is for keeping, and it includes the
 * audit trail (payments, waivers, who marked what and when) because that is
 * the part that matters if a loan is ever disputed.
 *
 * What is *not* in here: proof images, which live in private storage and are
 * fetched through the loan screen; and anything belonging to the other person
 * (their profile, their other loans) - only the shared loan records.
 */
/** A query whose failure is reported, not fatal - see the comment in the handler. */
async function readOrWarn<T>(label: string, query: Promise<T[]>): Promise<{ rows: T[]; warnings: string[] }> {
  try {
    return { rows: await query, warnings: [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The driver's message names the column; that is what makes this fixable.
    console.error(`[export] ${label} could not be read: ${detail}`);
    return {
      rows: [],
      warnings: [
        `${label} could not be included: the database is missing something this version of the app needs ` +
          `(transient - it does not mean the data is gone; it is still on the loan). Run npm run db:migrate against the database.`,
      ],
    };
  }
}

async function fetchSections(loanIds: string[]) {
  const [installmentsResult, paymentsResult, remindersResult] = await Promise.all([
    readOrWarn("instalments", db.select().from(installments).where(inArray(installments.loanId, loanIds))),
    readOrWarn("payments", db.select().from(payments).where(inArray(payments.loanId, loanIds))),
    readOrWarn("notifications", db.select().from(reminders).where(inArray(reminders.loanId, loanIds))),
  ]);

  return {
    installments: installmentsResult.rows,
    payments: paymentsResult.rows,
    notifications: remindersResult.rows,
    warnings: [...installmentsResult.warnings, ...paymentsResult.warnings, ...remindersResult.warnings],
  };
}

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [profile] = await db
    .select({
      id: users.id,
      name: users.name,
      mobile: users.mobile,
      pushEnabled: users.pushEnabled,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const myLoans = await db
    .select()
    .from(loans)
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)))
    .orderBy(desc(loans.createdAt));

  const loanIds = myLoans.map((l) => l.id);

  /*
   * Each section is fetched on its own so that one unreadable table cannot take
   * the whole export with it.
   *
   * Why this exists: on 2026-10-15 a release shipped a migration for a column
   * this query reads only incidentally - it selects whole rows - and every
   * account with a loan got a 503 from "download my data" until the migration
   * was applied. Failing honestly is right for a *write* path; for a data
   * export it means the person gets nothing at all, over a column some other
   * feature happens to own. So the export still answers, and says in the
   * payload what it could not include - the same principle as the reminder
   * feed: never overstate, never silently drop.
   */
  const empty = { installments: [], payments: [], notifications: [], warnings: [] as string[] };
  const sections = loanIds.length > 0 ? await fetchSections(loanIds) : empty;
  const { installments: myInstallments, payments: myPayments, notifications: myNotifications, warnings } = sections;

  // Rows written before recipient_id existed have NULL there, and belong to
  // whichever side of the loan the viewer is - the same rule the feed uses.
  const notifications = myNotifications.filter(
    (n) =>
      n.recipientId === session.id ||
      n.recipientId === null ||
      myLoans.some((l) => l.id === n.loanId && l.lenderId === n.recipientId)
  );

  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Udhaar",
    about:
      "Your Udhaar data. Loans are shared records: the other person on a loan sees the same " +
      "amounts and payments. Payment proof images are not included here - open the loan in the " +
      "app to view them.",
    profile: {
      name: profile.name,
      mobile: profile.mobile,
      memberSince: profile.createdAt,
      pushEnabled: profile.pushEnabled,
    },
    loans: myLoans.map((loan) => ({
      ...loan,
      role: loan.lenderId === session.id ? "lender" : "borrower",
      installments: myInstallments
        .filter((i) => i.loanId === loan.id)
        .sort((a, b) => a.installmentNumber - b.installmentNumber),
      payments: myPayments
        .filter((p) => p.loanId === loan.id)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    })),
    notifications: notifications.sort(
      (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    counts: {
      loans: myLoans.length,
      installments: myInstallments.length,
      payments: myPayments.length,
      notifications: notifications.length,
    },
  };

  const filename = `udhaar-data-${new Date().toISOString().slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

export const GET = withErrors(handleGET);
