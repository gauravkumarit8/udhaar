import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DUMMY_OTP_CODE, generateOtpCode, getOtpPolicy } from "@/lib/otp";

const ENV_KEYS = ["OTP_MODE", "NODE_ENV", "MSG91_AUTH_KEY", "MSG91_FLOW_ID"] as const;

/** process.env is readonly-typed by @types/node; tests need to poke at it. */
const env = process.env as unknown as Record<string, string | undefined>;

describe("OTP policy", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    for (const key of ENV_KEYS) delete env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete env[key];
      else env[key] = original[key];
    }
  });

  it("never echoes the code when MSG91 is configured", () => {
    env.MSG91_AUTH_KEY = "key";
    env.MSG91_FLOW_ID = "flow";
    env.NODE_ENV = "production";

    const policy = getOtpPolicy();
    expect(policy.mode).toBe("sms");
    expect(policy.hideCode).toBe(true);
    expect(policy.misconfigured).toBeUndefined();
  });

  it("uses dummy mode in development when no provider is set", () => {
    env.NODE_ENV = "development";
    const policy = getOtpPolicy();
    expect(policy.mode).toBe("dummy");
    expect(policy.hideCode).toBe(false);
    expect(generateOtpCode(policy)).toBe(DUMMY_OTP_CODE);
    expect(policy.warning).toBeTruthy();
  });

  it("fails closed in production when nothing is configured", () => {
    env.NODE_ENV = "production";
    const policy = getOtpPolicy();
    expect(policy.misconfigured).toBeTruthy();
    expect(policy.hideCode).toBe(true);
    // Even if the route ignored `misconfigured`, the code must not leak.
    expect(policy.hideCode).toBe(true);
  });

  it("honours an explicit OTP_MODE=dummy in production, with a warning", () => {
    env.NODE_ENV = "production";
    env.OTP_MODE = "dummy";
    const policy = getOtpPolicy();
    expect(policy.mode).toBe("dummy");
    expect(policy.hideCode).toBe(false);
    expect(policy.misconfigured).toBeUndefined();
    expect(policy.warning).toMatch(/dummy/i);
  });

  it("refuses OTP_MODE=sms without provider credentials", () => {
    env.OTP_MODE = "sms";
    const policy = getOtpPolicy();
    expect(policy.misconfigured).toMatch(/MSG91/);
  });

  it("rejects an unrecognised OTP_MODE instead of guessing", () => {
    env.OTP_MODE = "nonsense";
    expect(getOtpPolicy().misconfigured).toMatch(/not recognised/i);
  });

  it("generates a 6-digit code in sms mode", () => {
    env.MSG91_AUTH_KEY = "key";
    env.MSG91_FLOW_ID = "flow";
    const code = generateOtpCode(getOtpPolicy());
    expect(code).toMatch(/^\d{6}$/);
    expect(code).not.toBe(DUMMY_OTP_CODE);
  });
});
