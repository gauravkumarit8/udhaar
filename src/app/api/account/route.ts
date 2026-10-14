import { NextResponse } from "next/server";
import { eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { loans, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { withErrors } from "@/lib/api-handler";

/**
 * Deleting your account, and why it can say no.
 *
 * A loan is the one thing here that belongs to two people. Erasing it while
 * money is still moving would destroy the counterparty's record of a real
 * debt - so the rule is: **close or settle everything first, then go.** Once
 * no loan is open, deleting the account removes the person and their loans,
 * because by then every loan is finished business.
 *
 * What goes: the profile, sessions (all devices), OTPs, notification
 * subscriptions, and every loan the person is on, which cascades to its
 * installments, payments and notifications.
 *
 * What cannot go, and is said out loud in the response: proof images already
 * uploaded to storage live outside this database. Their ids vanish with the
 * payment rows, so nothing can find them through Udhaar any more - the files
 * themselves are removed by the operator (README → Cloudinary).
 */
async function handleDELETE() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const myLoans = await db
    .select({ id: loans.id, status: loans.status })
    .from(loans)
    .where(or(eq(loans.lenderId, session.id), eq(loans.borrowerId, session.id)));

  const open = myLoans.filter((loan) => loan.status !== "closed");

  if (open.length > 0) {
    return NextResponse.json(
      {
        error:
          open.length === 1
            ? "One of your loans is still open, so the account can't be deleted yet."
            : `${open.length} of your loans are still open, so the account can't be deleted yet.`,
        action:
          "Settle each open loan, or close it as a write-off (open the loan → Close & write off). " +
          "A loan is shared with another person, so it can't be erased while money is still owed. " +
          "Nothing is changed until you come back and delete.",
        openLoans: open.length,
        totalLoans: myLoans.length,
      },
      { status: 409 }
    );
  }

  const loanIds = myLoans.map((loan) => loan.id);

  await db.transaction(async (tx) => {
    if (loanIds.length > 0) {
      // Cascades to installments → payments, and to reminders/notifications.
      await tx.delete(loans).where(inArray(loans.id, loanIds));
    }
    // Cascades to sessions, otps, push subscriptions and device tokens.
    await tx.delete(users).where(eq(users.id, session.id));
  });

  return NextResponse.json({
    success: true,
    deleted: { loans: loanIds.length, account: true },
    message: "Your account and its loan records have been deleted.",
  });
}

export const DELETE = withErrors(handleDELETE);
