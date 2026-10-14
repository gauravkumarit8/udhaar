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

/** Called when the person using this device changes. */
export function clearClientCaches(): void {
  try {
    sessionStorage.removeItem(DASHBOARD_CACHE_KEY);
    sessionStorage.removeItem(UNREAD_CACHE_KEY);
  } catch {
    // Storage unavailable (private mode) - there was nothing cached anyway.
  }
}
