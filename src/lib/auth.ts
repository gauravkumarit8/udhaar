/**
 * Simple cookie-based auth for Udhaar MVP
 * Uses Next.js cookies() API
 */
import { cookies } from "next/headers";
import { db } from "@/db";
import { users, loans, installments, reminders } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { formatINR, formatDate } from "@/lib/calculations";

const SESSION_COOKIE = "udhaar_session";

export async function getSession(): Promise<{
  id: string;
  name: string;
  mobile: string;
} | null> {
  const cookieStore = await cookies();
  const userId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!userId) return null;

  const [user] = await db
    .select({ id: users.id, name: users.name, mobile: users.mobile })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

export async function setSession(userId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, userId, {
    httpOnly: true,
    secure: false, // sandbox has no HTTPS
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function getOrCreateUser(
  mobile: string,
  name?: string
): Promise<{ id: string; name: string; mobile: string }> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.mobile, mobile))
    .limit(1);

  if (existing) {
    await backfillBorrowerLoans(existing.id, existing.mobile);
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({ mobile, name: name || `User ${mobile.slice(-4)}` })
    .returning();

  await backfillBorrowerLoans(created.id, created.mobile);

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

    const [lender] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, loan.lenderId))
      .limit(1);

    const message = `${lender?.name || "Someone"} added a loan of ${formatINR(loan.amount)} for you on Udhaar. First payment of ${formatINR(firstInst.totalAmount)} due on ${formatDate(firstInst.dueDate)}.`;

    await db.insert(reminders).values({
      installmentId: firstInst.id,
      loanId: loan.id,
      channel: "push",
      message,
      status: "sent",
    });
  }
}
