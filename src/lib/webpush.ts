/**
 * Browser push (the Web Push protocol), for the website and the installed PWA.
 *
 * Why this exists separately from `push.ts`: Firebase Cloud Messaging only
 * reaches the *native* app, and only once `google-services.json` is part of the
 * Android build. Someone using Udhaar in a browser - which is how it is opened
 * most of the time - could never be notified about anything. This channel fixes
 * that with no Firebase project and no app install: the browser hands us a
 * subscription endpoint, and we POST an encrypted payload to it.
 *
 * Configuration is a VAPID key pair (`npm run generate:vapid`). Without it the
 * channel is simply off, and everything else keeps working.
 */
import webpush from "web-push";

let configured: boolean | null = null;

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function readConfig(): WebPushConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;

  // `mailto:` is what a push service uses to reach the sender about abuse; it
  // has to be a real-looking URL or the services reject the VAPID header.
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:noreply@example.com";

  return { publicKey, privateKey, subject };
}

/** The public key the browser needs to subscribe. Safe to hand to clients. */
export function webPushPublicKey(): string | null {
  return readConfig()?.publicKey ?? null;
}

export function isWebPushConfigured(): boolean {
  if (configured === null) configured = readConfig() !== null;
  return configured;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type WebPushOutcome = "sent" | "gone" | "failed";

/**
 * Sends one notification to one browser.
 *
 * `gone` (404/410) means the subscription is dead - the browser was
 * uninstalled, the permission revoked, or the endpoint rotated - and the only
 * correct response is to delete the row. Everything else is a transient
 * failure, reported so the caller can be honest about delivery.
 */
export async function sendWebPush(
  subscription: PushSubscriptionRecord,
  payload: Record<string, unknown>
): Promise<WebPushOutcome> {
  const config = readConfig();
  if (!config) return "failed";

  try {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      // The payload is small; the default TTL keeps a phone that is offline
      // right now from being notified about something stale days later.
      { TTL: 60 * 60 * 12 }
    );

    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) return "gone";
    console.error("[webpush] send failed:", (err as Error)?.message ?? err);
    return "failed";
  }
}
