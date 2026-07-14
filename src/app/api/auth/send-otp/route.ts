import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { otps } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const { mobile } = await req.json();

  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return NextResponse.json({ error: "Valid 10-digit mobile required" }, { status: 400 });
  }

  // Generate OTP — in dev mode always "123456"
  const code = "123456";
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  // Invalidate previous OTPs for this mobile
  await db
    .update(otps)
    .set({ verified: true }) // mark old ones as used
    .where(eq(otps.mobile, mobile));

  await db.insert(otps).values({ mobile, code, expiresAt });

  return NextResponse.json({ success: true, message: "OTP sent (dev: 123456)" });
}
