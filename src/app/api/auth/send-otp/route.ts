import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { otps } from "@/db/schema";
import { eq, desc, lt, gte, and, sql } from "drizzle-orm";
import { getOtpPolicy, generateOtpCode, deliverOtp, warnOnceIfNeeded } from "@/lib/otp";
import { clientIp, SEND_OTP_PER_IP, tooManyRequests } from "@/lib/rate-limit";
import { withErrors } from "@/lib/api-handler";

const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds between requests per number

/*
 * The caps that cost money if they are missing.
 *
 * A per-number cooldown alone meant an attacker could walk a list of numbers:
 * every request sends a real SMS once MSG91 is configured, paid for by this
 * account, to people who never asked (and eventually a burnt-out sender ID).
 *
 * Two of the three caps below are counted in the database, which is the point:
 * they cannot be escaped by spoofing a header or by landing on a different
 * instance. `OTP_GLOBAL_HOURLY_MAX` is the backstop for the whole service;
 * `OTP_PER_MOBILE_DAILY_MAX` stops one number being spammed (and someone
 * else's phone being used as a weapon against them).
 */
const GLOBAL_HOURLY_MAX = Number(process.env.OTP_GLOBAL_HOURLY_MAX ?? 300);
const PER_MOBILE_DAILY_MAX = Number(process.env.OTP_PER_MOBILE_DAILY_MAX ?? 10);

async function countRecentOtps(since: Date, mobile?: string): Promise<number> {
  const where = mobile
    ? and(gte(otps.createdAt, since), eq(otps.mobile, mobile))
    : gte(otps.createdAt, since);

  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(otps)
    .where(where);

  return Number(row?.n ?? 0);
}

async function handlePOST(req: NextRequest) {
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

  /*
   * 1. The service-wide ceiling, counted in the database.
   *
   * Anything above this is either an attack or a runaway client, and either way
   * the right answer is to stop sending SMS rather than to keep paying for
   * them. This is checked first because it is the cheapest to satisfy and the
   * most expensive to get wrong.
   */
  const lastHour = await countRecentOtps(new Date(Date.now() - 60 * 60 * 1000));
  if (lastHour >= GLOBAL_HOURLY_MAX) {
    console.error(`[otp] hourly ceiling reached (${lastHour}/${GLOBAL_HOURLY_MAX}) - refusing to send more`);
    return NextResponse.json(
      {
        error:
          "Too many OTP requests have been made in the last hour, so no more can be sent right now. Please try again later.",
      },
      { status: 429, headers: { "retry-after": "600" } }
    );
  }

  /*
   * 2. Per caller (best effort), then 3. per number per day (durable).
   *
   * The per-IP key comes from a header a caller can fake, so it is a speed bump
   * and not the wall - the daily-per-number and hourly-global counts above and
   * below are what actually cap the damage.
   */
  const ipLimit = SEND_OTP_PER_IP.check(clientIp(req));
  if (!ipLimit.allowed) {
    return tooManyRequests(ipLimit, "Too many OTP requests from this connection.");
  }

  const lastDay = await countRecentOtps(new Date(Date.now() - 24 * 60 * 60 * 1000), mobile);
  if (lastDay >= PER_MOBILE_DAILY_MAX) {
    return NextResponse.json(
      {
        error:
          "This number has requested too many OTPs today. Please try again tomorrow, or contact support if you are stuck.",
      },
      { status: 429, headers: { "retry-after": "3600" } }
    );
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

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
