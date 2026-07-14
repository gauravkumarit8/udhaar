import { NextResponse } from "next/server";
import { db } from "@/db";
import { otps } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { setSession, getOrCreateUser } from "@/lib/auth";

export async function POST(req: Request) {
  const { mobile, code, name } = await req.json();

  if (!mobile || !code) {
    return NextResponse.json({ error: "Mobile and OTP required" }, { status: 400 });
  }

  // Find latest unverified OTP for this mobile
  const [otp] = await db
    .select()
    .from(otps)
    .where(and(eq(otps.mobile, mobile), eq(otps.verified, false)))
    .orderBy(desc(otps.createdAt))
    .limit(1);

  if (!otp) {
    return NextResponse.json({ error: "No OTP found. Request a new one." }, { status: 400 });
  }

  if (new Date() > otp.expiresAt) {
    return NextResponse.json({ error: "OTP expired. Request a new one." }, { status: 400 });
  }

  if (otp.code !== code) {
    return NextResponse.json({ error: "Invalid OTP" }, { status: 400 });
  }

  // Mark OTP as verified
  await db.update(otps).set({ verified: true }).where(eq(otps.id, otp.id));

  // Get or create user
  const user = await getOrCreateUser(mobile, name);

  // Set session cookie
  await setSession(user.id);

  return NextResponse.json({ success: true, user: { id: user.id, name: user.name, mobile: user.mobile } });
}
