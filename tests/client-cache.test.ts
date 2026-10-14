import { describe, expect, it } from "vitest";
import { isUnreadFresh, UNREAD_FRESH_MS } from "@/lib/client-cache";

/**
 * The rule that decides whether the tab bar asks the server for the badge
 * count, or trusts what a screen's own response already handed it.
 *
 * Getting this wrong is either a wasted round trip on every tab switch (too
 * strict) or a badge that lags behind reality (too loose), and it is invisible
 * in a browser - so it is pinned here.
 */
describe("isUnreadFresh", () => {
  const now = 1_000_000_000_000;

  it("trusts a count confirmed moments ago", () => {
    expect(isUnreadFresh(now - 1_000, now)).toBe(true);
    expect(isUnreadFresh(now, now)).toBe(true);
  });

  it("stops trusting it once the window passes", () => {
    expect(isUnreadFresh(now - UNREAD_FRESH_MS, now)).toBe(true); // exactly at the edge
    expect(isUnreadFresh(now - UNREAD_FRESH_MS - 1, now)).toBe(false);
  });

  it("asks when nothing has ever been confirmed", () => {
    expect(isUnreadFresh(0, now)).toBe(false);
  });

  it("asks when the stored value is nonsense", () => {
    expect(isUnreadFresh(Number.NaN, now)).toBe(false);
    expect(isUnreadFresh(-1, now)).toBe(false);
  });

  it("asks when the clock went backwards rather than trusting a future stamp", () => {
    expect(isUnreadFresh(now + 60_000, now)).toBe(false);
  });

  it("takes the window as a parameter, for callers with different needs", () => {
    expect(isUnreadFresh(now - 5_000, now, 1_000)).toBe(false);
    expect(isUnreadFresh(now - 5_000, now, 10_000)).toBe(true);
  });
});
