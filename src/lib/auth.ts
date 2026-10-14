/**
 * Cookie-based auth for Udhaar.
 *
 * The session cookie holds a random, opaque 32-byte token - never a user id.
 * The token is looked up in the `sessions` table to resolve the user, which
 * means:
 *   - a tampered/garbage cookie is simply "not logged in" (never a 500),
 *   - sessions can be revoked server-side (logout deletes the row),
 *   - knowing another user's id (which the app *does* expose in loan
 *     payloads) gives you nothing.
 */
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { users, sessions, loans, installments } from "@/db/schema";
import { eq, and, isNull, lt } from "drizzle-orm";
import { loanAddedNotice, loanClaimedNotice, notifyCounterparty } from "@/lib/notify";

const SESSION_COOKIE = "udhaar_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export interface SessionUser {
  id: string;
  name: string;
  mobile: string;
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  // Anything that isn't the exact token format (including legacy cookies that
  // held a raw user id, or a user poking at the cookie) is treated as
  // "logged out" rather than being handed to Postgres as a uuid.
  if (!token || !TOKEN_PATTERN.test(token)) return null;

  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      mobile: users.mobile,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .limit(1);

  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return null;
  }

  return { id: row.id, name: row.name, mobile: row.mobile };
}

export async function setSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({ token, userId, expiresAt });

  // Opportunistic cleanup: drop this user's expired sessions so the table
  // doesn't grow forever on a long-lived deployment.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token && TOKEN_PATTERN.test(token)) {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  cookieStore.delete(SESSION_COOKIE);
}

export async function getOrCreateUser(
  mobile: string,
  name?: string
): Promise<SessionUser> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.mobile, mobile))
    .limit(1);

  if (existing) {
    await backfillBorrowerLoans(existing.id, existing.mobile);
    // ...and the reverse: loans someone else entered naming *them* as lender.
    await backfillLenderLoans(existing.id, existing.mobile);
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({ mobile, name: name || `User ${mobile.slice(-4)}` })
    .returning();

  await backfillBorrowerLoans(created.id, created.mobile);
  await backfillLenderLoans(created.id, created.mobile);

  return created;
}

/**
 * Links any loans that were created against this mobile number before the
 * borrower had an account (or before they'd ever logged in). Safe to call
 * on every login — it's a no-op once a loan's borrowerId is already set.
 * Also notifies the borrower about each loan that just got linked.
 */
export async function backfillBorrowerLoans(userId: string, mobile: string): Promise<void> {
  const linkedLoans = await db
    .update(loans)
    .set({ borrowerId: userId })
    .where(and(eq(loans.borrowerMobile, mobile), isNull(loans.borrowerId)))
    .returning();

  for (const loan of linkedLoans) {
    const [firstInst] = await db
      .select()
      .from(installments)
      .where(eq(installments.loanId, loan.id))
      .orderBy(installments.installmentNumber)
      .limit(1);

    if (!firstInst) continue;

    const [lender] = loan.lenderId
      ? await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, loan.lenderId))
          .limit(1)
      : [undefined];

    await notifyCounterparty({
      userId,
      installmentId: firstInst.id,
      loanId: loan.id,
      notice: loanAddedNotice({
        actorName: lender?.name || "Someone",
        amount: parseFloat(loan.amount),
        firstDueAmount: parseFloat(firstInst.totalAmount),
        firstDueDate: firstInst.dueDate,
        waiting: true,
      }),
    });
  }
}

/**
 * The mirror of `backfillBorrowerLoans`, for loans a *borrower* entered.
 *
 * Someone signs up and it turns out another person had already written down a
 * loan to their number: "I owe my uncle ₹5,000". This attaches their account
 * as the lender, so from that moment they can see it, confirm payments and -
 * the reason it matters - settle or write it off. Without it, a debt recorded
 * by the borrower could never be forgiven by anyone, because a waiver is never
 * the borrower's to give.
 *
 * Returns the linked loan ids so the caller can report what happened.
 */
export async function backfillLenderLoans(userId: string, mobile: string): Promise<string[]> {
  const linkedLoans = await db
    .update(loans)
    .set({ lenderId: userId })
    .where(and(eq(loans.lenderMobile, mobile), isNull(loans.lenderId)))
    .returning();

  for (const loan of linkedLoans) {
    const [firstInst] = await db
      .select()
      .from(installments)
      .where(eq(installments.loanId, loan.id))
      .orderBy(installments.installmentNumber)
      .limit(1);

    if (!firstInst) continue;

    await notifyCounterparty({
      userId,
      installmentId: firstInst.id,
      loanId: loan.id,
      notice: loanClaimedNotice({
        borrowerName: loan.borrowerName,
        amount: parseFloat(loan.amount),
        firstDueAmount: parseFloat(firstInst.totalAmount),
      }),
    });
  }

  return linkedLoans.map((loan) => loan.id);
}

