import { db } from "@/db";
import { deviceTokens } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

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
 * Sends a push notification to every device registered to a user.
 * No-ops quietly (logs a warning once) if Firebase isn't configured,
 * so the rest of the app keeps working without it.
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<{ sent: number; failed: number }> {
  const fcm = await getMessaging();
  if (!fcm) return { sent: 0, failed: 0 };

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

  return { sent: response.successCount, failed: response.failureCount };
}
