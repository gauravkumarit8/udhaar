import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { otps } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { sendOtpSms } from "@/lib/sms";

const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds between requests per number

export async function POST(req: NextRequest) {
  const { mobile } = await req.json();

  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return NextResponse.json({ error: "Valid 10-digit mobile required" }, { status: 400 });
  }

  // Rate-limit how often a single number can request a new OTP, to stop
  // SMS-bombing abuse (and keep your SMS provider bill sane).
  const [lastOtp] = await db
    .select()
    .from(otps)
    .where(eq(otps.mobile, mobile))
    .orderBy(desc(otps.createdAt))
    .limit(1);

  if (lastOtp) {
    const elapsed = Date.now() - new Date(lastOtp.createdAt).getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return NextResponse.json(
        { error: `Please wait ${waitSeconds}s before requesting another OTP` },
        { status: 429 }
      );
    }
  }

  // Generate a real random 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  // Invalidate previous OTPs for this mobile
  await db
    .update(otps)
    .set({ verified: true }) // mark old ones as used
    .where(eq(otps.mobile, mobile));

  await db.insert(otps).values({ mobile, code, expiresAt });

  const result = await sendOtpSms(mobile, code);

  // Only echo the code back in the response when SMS delivery isn't
  // configured (local dev) - never leak it once real delivery is live.
  if (result.sent) {
    return NextResponse.json({ success: true, message: "OTP sent" });
  }

  return NextResponse.json({
    success: true,
    message: `OTP sent (dev mode - SMS not configured, code: ${code})`,
    devCode: code,
  });
}
