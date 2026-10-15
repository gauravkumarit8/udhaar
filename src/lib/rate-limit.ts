/**
 * Rate limiting: how many times, in how long, from one caller.
 *
 * The window logic is pure so it can be tested; the store is a Map in the
 * process, which is honest about what it is: on a single instance it is exact,
 * and across instances it is per-instance. Anything that costs real money (an
 * SMS, a Cloudinary upload) therefore *also* has a durable, database-backed cap
 * - see the OTP route - because a per-instance counter cannot be the only
 * defence against a caller who can rotate the key they are counted by.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 once blocked). */
  remaining: number;
  /** Seconds the caller should wait; 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** For messages and metrics. */
  name: string;
}

/** Most keys tracked at once, so a caller rotating keys cannot grow memory unbounded. */
const MAX_KEYS = 5_000;

interface Bucket {
  /** Timestamps of the requests in the current window, oldest first. */
  hits: number[];
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimiterOptions) {}

  /**
   * Record one request from `key` and say whether it is allowed.
   *
   * A blocked request is *not* recorded, so a caller hammering the endpoint
   * cannot extend their own lockout indefinitely.
   */
  check(key: string, now = Date.now()): RateLimitResult {
    const { limit, windowMs } = this.options;
    const cutoff = now - windowMs;

    this.evictIfNeeded(now);

    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((at) => at > cutoff);

    if (bucket.hits.length >= limit) {
      const oldest = bucket.hits[0];
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    bucket.hits.push(now);
    this.buckets.set(key, bucket);

    return {
      allowed: true,
      remaining: Math.max(0, limit - bucket.hits.length),
      retryAfterSeconds: 0,
    };
  }

  /** Drop expired keys; if that is not enough, drop the oldest half. */
  private evictIfNeeded(now: number): void {
    if (this.buckets.size < MAX_KEYS) return;

    const cutoff = now - this.options.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every((at) => at <= cutoff) || bucket.hits.length === 0) {
        this.buckets.delete(key);
      }
    }

    // Still full: a burst of unique keys. Clearing is the safe direction for
    // availability (the alternative is unbounded memory on a small instance),
    // and the durable caps elsewhere do not depend on this map.
    if (this.buckets.size >= MAX_KEYS) this.buckets.clear();
  }

  /** Visible for tests. */
  get size(): number {
    return this.buckets.size;
  }
}

/** The limiters this app uses, with the numbers written down in one place. */
export const SEND_OTP_PER_IP = new RateLimiter({
  name: "send-otp per ip",
  limit: 10,
  windowMs: 10 * 60 * 1000,
});

export const UPLOAD_PER_USER = new RateLimiter({
  name: "upload per user",
  limit: 20,
  windowMs: 10 * 60 * 1000,
});

/**
 * The caller's IP, as far as the platform tells us.
 *
 * `x-forwarded-for` is client-writable unless a proxy in front overwrites it,
 * and the first entry is the one a proxy appends *its* client's address to -
 * so this is a best-effort key, not an identity. Render sets it; a caller who
 * can send their own header can rotate this key, which is exactly why every
 * limiter keyed on it is paired with a durable cap that is not.
 */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first && /^[0-9a-fA-F.:]+$/.test(first)) return first;

  const real = req.headers.get("x-real-ip");
  if (real && /^[0-9a-fA-F.:]+$/.test(real)) return real;

  return "unknown";
}

/** A 429 the UI can show as-is, with the wait in the body and the header. */
export function tooManyRequests(result: RateLimitResult, message: string): Response {
  return Response.json(
    { error: `${message} Try again in ${result.retryAfterSeconds}s.` },
    { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } }
  );
}
