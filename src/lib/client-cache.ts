/**
 * The little bit of client state the app keeps between screens.
 *
 * Both caches exist for the same reason: this app talks to a database in
 * another region, so an empty screen for a second is the difference between
 * "fast" and "slow". Neither is a source of truth - the server is always asked,
 * and whatever it answers replaces what was cached.
 *
 * `sessionStorage`, deliberately, not `localStorage`: a shared phone should not
 * hand the next person yesterday's balances after the tab is closed. And both
 * keys are cleared on sign-in and sign-out, so a second person using the same
 * browser never sees a flash of the first person's numbers.
 */
export const DASHBOARD_CACHE_KEY = "udhaar:dashboard";
export const UNREAD_CACHE_KEY = "udhaar:unread";
/** When the cached unread count was last confirmed with the server. */
export const UNREAD_AT_KEY = "udhaar:unread:at";

/**
 * Fired by a screen that was already told the unread count by its own request,
 * so the tab bar does not have to ask the server again from the browser.
 * `detail` is the count.
 */
export const UNREAD_EVENT = "udhaar:unread";

/**
 * How long a count this device already has is treated as good enough.
 *
 * The screens that fetch their own data now come back with the unread count in
 * the same response, so asking the server again from the browser is a second
 * round trip for a number we were just handed. Short enough that a count is
 * never visibly stale, long enough to cover the tab switches that each used to
 * cost a request.
 */
export const UNREAD_FRESH_MS = 30_000;

/** Is a count confirmed at `at` still good enough to show at `now`? */
export function isUnreadFresh(
  at: number,
  now: number = Date.now(),
  freshMs: number = UNREAD_FRESH_MS
): boolean {
  // No timestamp (or a clock that moved backwards) means "ask".
  if (!Number.isFinite(at) || at <= 0) return false;
  const age = now - at;
  if (age < 0) return false;
  return age <= freshMs;
}

/** When the cached unread count was last confirmed, or 0 if unknown. */
export function readUnreadAt(): number {
  try {
    return Number(sessionStorage.getItem(UNREAD_AT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Called when the person using this device changes. */
export function clearClientCaches(): void {
  try {
    sessionStorage.removeItem(DASHBOARD_CACHE_KEY);
    sessionStorage.removeItem(UNREAD_CACHE_KEY);
    sessionStorage.removeItem(UNREAD_AT_KEY);
  } catch {
    // Storage unavailable (private mode) - there was nothing cached anyway.
  }
}
