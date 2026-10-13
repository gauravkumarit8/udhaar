import { db } from "@/db";
import { deviceTokens, pushSubscriptions, users } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { isWebPushConfigured, sendWebPush } from "@/lib/webpush";

// Lazily initialized so this module can be imported even when Firebase
// isn't configured yet (local dev, CI, etc) without throwing at import time.
let messaging: any = null;
let attemptedInit = false;
let configWarningLogged = false;

async function getMessaging() {
  if (attemptedInit) return messaging;
  attemptedInit = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    if (!configWarningLogged) {
      console.warn(
        "[push] FIREBASE_SERVICE_ACCOUNT_KEY is not set - push notifications will be skipped. " +
          "Set up a Firebase project and add the service account JSON (base64-encoded) to enable real pushes."
      );
      configWarningLogged = true;
    }
    return null;
  }

  try {
    const admin = await import("firebase-admin");
    const serviceAccount = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    messaging = admin.messaging();
    return messaging;
  } catch (err) {
    console.error("[push] Failed to initialize Firebase Admin:", err);
    return null;
  }
}

/**
 * Registers (or refreshes) a device's FCM push token for a user.
 * Safe to call repeatedly - upserts on the unique token.
 */
export async function registerDeviceToken(
  userId: string,
  token: string,
  platform: "android" | "ios" | "web"
): Promise<void> {
  await db
    .insert(deviceTokens)
    .values({ userId, token, platform })
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: { userId, platform },
    });
}

/**
 * Sends a push notification to every device registered to a user - the native
 * app through FCM, and browsers/installed PWAs through Web Push. Both are
 * best-effort: a failure here must never surface as a failed payment.
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<{ sent: number; failed: number }> {
  // Honour the user's notification preference before touching any channel.
  const [recipient] = await db
    .select({ pushEnabled: users.pushEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (recipient && !recipient.pushEnabled) return { sent: 0, failed: 0 };

  const web = await sendWebPushToUser(userId, { title, body, data });

  const fcm = await getMessaging();
  if (!fcm) return web;

  const tokens = await db
    .select({ id: deviceTokens.id, token: deviceTokens.token })
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId));

  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const response = await fcm.sendEachForMulticast({
    tokens: tokens.map((t) => t.token),
    notification: { title, body },
    data,
  });

  // Clean up tokens that are no longer valid (app uninstalled, token rotated, etc)
  const staleTokenIds: string[] = [];
  response.responses.forEach((r: { success: boolean; error?: { code?: string } }, i: number) => {
    if (!r.success && (r.error?.code === "messaging/registration-token-not-registered" || r.error?.code === "messaging/invalid-registration-token")) {
      staleTokenIds.push(tokens[i].id);
    }
  });
  if (staleTokenIds.length > 0) {
    await db.delete(deviceTokens).where(inArray(deviceTokens.id, staleTokenIds));
  }

  return {
    sent: web.sent + response.successCount,
    failed: web.failed + response.failureCount,
  };
}

/**
 * Notifies every browser this user has subscribed with.
 *
 * Dead subscriptions are deleted as they are discovered rather than left to
 * fail forever - that is the whole cleanup story for uninstalled PWAs.
 */
async function sendWebPushToUser(
  userId: string,
  payload: { title: string; body: string; data: Record<string, string> }
): Promise<{ sent: number; failed: number }> {
  if (!isWebPushConfigured()) return { sent: 0, failed: 0 };

  const subscriptions = await db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subscriptions.length === 0) return { sent: 0, failed: 0 };

  const results = await Promise.all(
    subscriptions.map((subscription) =>
      sendWebPush(subscription, { ...payload.data, title: payload.title, body: payload.body })
    )
  );

  const dead = subscriptions.filter((_, i) => results[i] === "gone").map((s) => s.id);
  if (dead.length > 0) {
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, dead));
  }

  return {
    sent: results.filter((r) => r === "sent").length,
    failed: results.filter((r) => r === "failed").length,
  };
}
