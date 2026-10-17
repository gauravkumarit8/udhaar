/**
 * Whether this *device* can receive an app push - and therefore whether the
 * native push plugin may be touched at all.
 *
 * Why this is not a nicety.
 *
 * `PushNotifications.register()` opens with
 * `FirebaseMessaging.getInstance()`. In an APK built without
 * `google-services.json` the google-services Gradle plugin never runs, so no
 * `FirebaseApp` is initialized, and that call throws `IllegalStateException`.
 * Capacitor does not turn it into a rejected promise: `Bridge.callPluginMethod`
 * catches it and does `throw new RuntimeException(ex)` inside a main-thread
 * Runnable, which kills the process. There is no `try`/`catch`, no `.catch()`
 * and no error boundary that can survive it - the call must not be made.
 *
 * The server cannot answer this question. `pushAvailable` says "the server has
 * credentials to send", which was true while the APK had none - the exact
 * combination that crashed the app on the first screen after login. Only the
 * build knows whether it shipped Firebase, so the build says so, by appending a
 * marker to the WebView's user agent:
 *
 *   android.appendUserAgent = " UdhaarPush/1"   (only when google-services.json
 *                                                was added to the APK)
 *
 * The APK that is already installed on a phone carries no marker, so this
 * refuses to call the plugin there - which is why the fix reaches an installed
 * app without a rebuild.
 *
 * Bump the marker version if the contract changes; an old APK advertising an
 * old marker then stops being trusted, which errs towards not crashing.
 */

/** The token a Capacitor build appends to its user agent when it has Firebase. */
export const PUSH_CAPABLE_MARKER = "UdhaarPush/1";

/** Does this user agent belong to a build that can receive a push? */
export function userAgentAdvertisesPush(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return userAgent.includes(PUSH_CAPABLE_MARKER);
}

export interface PushRegistrationInput {
  /** Running inside the Capacitor shell, not a browser tab. */
  native: boolean;
  /** `navigator.userAgent` of the WebView. */
  userAgent: string | null | undefined;
  /** `pushAvailable` from the server: it has credentials to send. */
  serverCanSend: boolean;
}

/**
 * The one place that decides whether registering for push is safe *and*
 * useful. Both halves have to be true:
 *
 *   - the build has Firebase (marker), or the plugin call kills the process;
 *   - the server has credentials (pushAvailable), or the token is minted and
 *     can never be used.
 */
export function shouldRegisterForPush({
  native,
  userAgent,
  serverCanSend,
}: PushRegistrationInput): boolean {
  return native && serverCanSend && userAgentAdvertisesPush(userAgent);
}
