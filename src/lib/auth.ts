/**
 * Simple cookie-based auth for Udhaar MVP
 * Uses Next.js cookies() API
 */
import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

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

  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({ mobile, name: name || `User ${mobile.slice(-4)}` })
    .returning();

  return created;
}
