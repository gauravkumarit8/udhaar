/**
 * OTP delivery policy.
 *
 * Udhaar doesn't have a real SMS provider wired up yet, so "dummy" mode is a
 * first-class, *explicit* mode rather than an accident of missing env vars.
 * The difference matters: previously the API echoed the OTP back to whoever
 * asked whenever MSG91 simply wasn't configured - which meant a production
 * deploy silently ran with no authentication at all.
 *
 *   OTP_MODE=auto   (default) real SMS if MSG91 is configured; otherwise
 *                   dummy mode in development; in production it fails closed
 *                   with a clear 503 instead of handing out the code.
 *   OTP_MODE=dummy  always dummy mode, in every environment. Logs a loud
 *                   warning (and the login screen shows a badge) because
 *                   anyone who can reach the API can log in as any number.
 *   OTP_MODE=sms    always real SMS; refuses to serve requests if MSG91
 *                   isn't configured.
 */
import { randomInt } from "node:crypto";
import { sendOtpSms as sendViaMsg91 } from "@/lib/sms";

/** The code dummy mode always accepts. Also what the login screen displays. */
export const DUMMY_OTP_CODE = "123456";

export type OtpMode = "dummy" | "sms";

export interface OtpPolicy {
  mode: OtpMode;
  /** true when the code must not be included in the API response. */
  hideCode: boolean;
  /** Set when the server is misconfigured and cannot send OTPs at all. */
  misconfigured?: string;
  warning?: string;
}

function isSmsConfigured(): boolean {
  return Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_FLOW_ID);
}

export function getOtpPolicy(): OtpPolicy {
  const requested = (process.env.OTP_MODE || "auto").toLowerCase();
  const isProduction = process.env.NODE_ENV === "production";
  const smsReady = isSmsConfigured();

  if (requested === "dummy") {
    return {
      mode: "dummy",
      hideCode: false,
      warning:
        "OTP_MODE=dummy - OTPs are NOT sent by SMS and the code is returned in the API response. " +
        "Anyone who can reach /api/auth can log in as any mobile number. Do not use this for a public launch.",
    };
  }

  if (requested === "sms") {
    if (!smsReady) {
      return {
        mode: "sms",
        hideCode: true,
        misconfigured:
          "OTP_MODE=sms but MSG91_AUTH_KEY / MSG91_FLOW_ID are not set. Configure the SMS provider or set OTP_MODE=dummy.",
      };
    }
    return { mode: "sms", hideCode: true };
  }

  if (requested !== "auto") {
    return {
      mode: "sms",
      hideCode: true,
      misconfigured: `OTP_MODE="${requested}" is not recognised. Use "auto", "dummy" or "sms".`,
    };
  }

  // auto
  if (smsReady) return { mode: "sms", hideCode: true };

  if (!isProduction) {
    return {
      mode: "dummy",
      hideCode: false,
      warning: "No SMS provider configured - falling back to dummy OTP mode (development only).",
    };
  }

  return {
    mode: "dummy",
    hideCode: true,
    misconfigured:
      "No OTP delivery configured in production. Set MSG91_AUTH_KEY + MSG91_FLOW_ID to send real SMS, " +
      "or set OTP_MODE=dummy to explicitly accept the insecure dummy code.",
  };
}

let warningLogged = false;

/** Logs the mode warning once per process. */
export function warnOnceIfNeeded(policy: OtpPolicy): void {
  if (warningLogged || !policy.warning) return;
  warningLogged = true;
  console.warn(`[otp] ${policy.warning}`);
}

export interface OtpDeliveryResult {
  delivered: boolean;
  /** Included in the API response only when policy.hideCode is false. */
  exposeCode: boolean;
  code?: string;
  error?: string;
}

/**
 * Generates the code that the `otps` table will hold for this request.
 * In dummy mode it is always DUMMY_OTP_CODE so testing is predictable.
 */
export function generateOtpCode(policy: OtpPolicy): string {
  if (policy.mode === "dummy") return DUMMY_OTP_CODE;
  // crypto.randomInt is not predictable like Math.random()
  return String(randomInt(100000, 1000000));
}

/**
 * Attempts to deliver `code`. Never throws - callers decide what to do with
 * a failed delivery based on the policy (fail closed in production, echo the
 * code in dummy/dev mode).
 */
export async function deliverOtp(
  mobile: string,
  code: string,
  policy: OtpPolicy
): Promise<OtpDeliveryResult> {
  if (policy.mode === "dummy") {
    warnOnceIfNeeded(policy);
    return { delivered: false, exposeCode: !policy.hideCode, code };
  }

  const result = await sendViaMsg91(mobile, code);
  return {
    delivered: result.sent,
    exposeCode: false,
    error: result.error,
  };
}
