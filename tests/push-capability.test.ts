import { describe, expect, it } from "vitest";
import {
  PUSH_CAPABLE_MARKER,
  shouldRegisterForPush,
  userAgentAdvertisesPush,
} from "@/lib/push-capability";

/**
 * A real Android WebView user agent, and the same one after a build that
 * shipped google-services.json has appended its marker.
 */
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36";
const CAPABLE_UA = `${ANDROID_UA} ${PUSH_CAPABLE_MARKER}`;

describe("userAgentAdvertisesPush", () => {
  it("accepts the user agent of a build that shipped Firebase", () => {
    expect(userAgentAdvertisesPush(CAPABLE_UA)).toBe(true);
  });

  it("rejects the APK that is already installed - the one that crashed", () => {
    expect(userAgentAdvertisesPush(ANDROID_UA)).toBe(false);
  });

  it("rejects a near miss rather than trusting it", () => {
    expect(userAgentAdvertisesPush(`${ANDROID_UA} UdhaarPush/0`)).toBe(false);
    expect(userAgentAdvertisesPush(`${ANDROID_UA} udhaarpush/1`)).toBe(false);
  });

  it("rejects an empty or missing user agent", () => {
    expect(userAgentAdvertisesPush("")).toBe(false);
    expect(userAgentAdvertisesPush(null)).toBe(false);
    expect(userAgentAdvertisesPush(undefined)).toBe(false);
  });
});

describe("shouldRegisterForPush", () => {
  it("registers only when the build has Firebase and the server can send", () => {
    expect(shouldRegisterForPush({ native: true, userAgent: CAPABLE_UA, serverCanSend: true })).toBe(
      true
    );
  });

  it("refuses on the installed APK, which is what crashed after login", () => {
    expect(
      shouldRegisterForPush({ native: true, userAgent: ANDROID_UA, serverCanSend: true })
    ).toBe(false);
  });

  it("refuses when the server has no credentials, even on a capable build", () => {
    expect(
      shouldRegisterForPush({ native: true, userAgent: CAPABLE_UA, serverCanSend: false })
    ).toBe(false);
  });

  it("refuses in a browser tab, which has no native plugin to call", () => {
    expect(shouldRegisterForPush({ native: false, userAgent: CAPABLE_UA, serverCanSend: true })).toBe(
      false
    );
  });
});
