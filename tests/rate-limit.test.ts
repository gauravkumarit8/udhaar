import { describe, expect, it } from "vitest";
import { clientIp, RateLimiter, tooManyRequests } from "@/lib/rate-limit";

/**
 * The limiter behind OTP sending and uploads.
 *
 * Two ways to get this wrong and both are silent: allow too much (the limit
 * does nothing) or count the wrong thing (a shared bucket locks out everybody
 * at once). The window arithmetic is pinned here; the durable,
 * database-backed caps that back it up are exercised against the running app.
 */
describe("RateLimiter", () => {
  const t0 = 1_700_000_000_000;

  it("allows exactly the limit inside the window", () => {
    const limiter = new RateLimiter({ name: "t", limit: 3, windowMs: 1000 });
    expect(limiter.check("a", t0).allowed).toBe(true);
    expect(limiter.check("a", t0 + 1).allowed).toBe(true);
    expect(limiter.check("a", t0 + 2).allowed).toBe(true);
    const blocked = limiter.check("a", t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // ~1s left, measured from the oldest hit in the window.
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  it("slides the window rather than resetting on a clock edge", () => {
    const limiter = new RateLimiter({ name: "t", limit: 2, windowMs: 1000 });
    limiter.check("a", t0);
    limiter.check("a", t0 + 500);
    expect(limiter.check("a", t0 + 700).allowed).toBe(false);
    // The first hit has aged out at t0+1001, so one slot is free again.
    expect(limiter.check("a", t0 + 1001).allowed).toBe(true);
    expect(limiter.check("a", t0 + 1002).allowed).toBe(false);
  });

  it("does not let a blocked caller extend their own lockout", () => {
    const limiter = new RateLimiter({ name: "t", limit: 1, windowMs: 1000 });
    limiter.check("a", t0);
    for (let i = 0; i < 20; i++) limiter.check("a", t0 + i);
    // Still unblocked exactly one window after the *first* request.
    expect(limiter.check("a", t0 + 1001).allowed).toBe(true);
  });

  it("keeps callers independent", () => {
    const limiter = new RateLimiter({ name: "t", limit: 1, windowMs: 1000 });
    expect(limiter.check("a", t0).allowed).toBe(true);
    expect(limiter.check("b", t0).allowed).toBe(true);
    expect(limiter.check("a", t0).allowed).toBe(false);
    expect(limiter.check("b", t0).allowed).toBe(false);
  });

  it("reports remaining requests", () => {
    const limiter = new RateLimiter({ name: "t", limit: 3, windowMs: 1000 });
    expect(limiter.check("a", t0).remaining).toBe(2);
    expect(limiter.check("a", t0).remaining).toBe(1);
    expect(limiter.check("a", t0).remaining).toBe(0);
  });

  it("forgets keys once their window passes, so memory does not grow forever", () => {
    const limiter = new RateLimiter({ name: "t", limit: 5, windowMs: 1000 });
    for (let i = 0; i < 100; i++) limiter.check(`key-${i}`, t0);
    expect(limiter.size).toBe(100);

    // A different window: every old bucket is expired, so they are swept.
    // (Eviction runs once the map is large, which is the point of the cap.)
    for (let i = 0; i < 5_100; i++) limiter.check(`fresh-${i}`, t0 + 10_000);
    expect(limiter.size).toBeLessThan(2_000);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) => ({
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  });

  it("takes the first entry of x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("ignores a header that is not an address", () => {
    // A spoofed header must not become a key that can be anything at all.
    expect(clientIp(req({ "x-forwarded-for": "not-an-ip" }))).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "<script>alert(1)</script>" }))).toBe("unknown");
  });
});

describe("tooManyRequests", () => {
  it("says when to try again, in the body and the header", async () => {
    const response = tooManyRequests({ allowed: false, remaining: 0, retryAfterSeconds: 42 }, "Too many.");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect((await response.json()).error).toContain("42s");
  });
});
