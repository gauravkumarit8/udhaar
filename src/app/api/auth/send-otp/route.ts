import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { otps } from "@/db/schema";
import { eq, desc, lt } from "drizzle-orm";
import { getOtpPolicy, generateOtpCode, deliverOtp, warnOnceIfNeeded } from "@/lib/otp";

const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds between requests per number

export async function POST(req: NextRequest) {
  const policy = getOtpPolicy();
  warnOnceIfNeeded(policy);

  // Fail closed rather than silently issuing codes nobody can receive.
  if (policy.misconfigured) {
    console.error(`[otp] ${policy.misconfigured}`);
    return NextResponse.json({ error: policy.misconfigured }, { status: 503 });
  }

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

  const code = generateOtpCode(policy);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  // Invalidate previous OTPs for this mobile
  await db
    .update(otps)
    .set({ verified: true }) // mark old ones as used
    .where(eq(otps.mobile, mobile));

  await db.insert(otps).values({ mobile, code, expiresAt });

  // Best-effort cleanup of long-expired rows for this number so the table
  // doesn't grow forever (one row per OTP request, per user).
  await db
    .delete(otps)
    .where(lt(otps.expiresAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));

  const delivery = await deliverOtp(mobile, code, policy);

  if (delivery.delivered) {
    return NextResponse.json({ success: true, message: "OTP sent" });
  }

  // Dummy mode only. `hideCode` is false just for explicit/dev dummy mode,
  // so the code is never echoed on a normally-configured deployment.
  if (delivery.exposeCode) {
    return NextResponse.json({
      success: true,
      dummyOtp: true,
      message: "OTP not sent by SMS (dummy mode) - use the code below.",
      devCode: delivery.code,
    });
  }

  return NextResponse.json(
    { error: "Couldn't send the OTP right now. Please try again in a moment." },
    { status: 502 }
  );
}
