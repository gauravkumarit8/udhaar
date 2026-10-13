import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { registerDeviceToken } from "@/lib/push";
import { webPushPublicKey } from "@/lib/webpush";
import { and, eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";
import { LIMITS } from "@/lib/validation";

/**
 * Registers where this user can be notified.
 *
 * Two shapes, because there are two channels:
 *   { token, platform: "android" | "ios" }   native app (FCM)
 *   { subscription: { endpoint, keys } }     browser / installed PWA (Web Push)
 */
async function handlePOST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const { token, platform, subscription } = body as Record<string, unknown>;

  // ── Browser subscription ─────────────────────────────────────────────────
  if (subscription) {
    const sub = subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
    const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
    const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";

    // A push endpoint is always https; anything else is not a real
    // subscription and would just sit in the table failing every send.
    if (!endpoint.startsWith("https://") || !p256dh || !auth) {
      return NextResponse.json(
        { error: "subscription needs an https endpoint and both keys" },
        { status: 400 }
      );
    }
    if (endpoint.length > LIMITS.PUSH_ENDPOINT_MAX || p256dh.length > 255 || auth.length > 255) {
      return NextResponse.json({ error: "subscription looks too large to be real" }, { status: 400 });
    }

    // The same browser can be re-subscribed (key rotation) or move between
    // accounts on a shared device - the endpoint is unique, so it follows the
    // session that last used it.
    await db
      .insert(pushSubscriptions)
      .values({ userId: session.id, endpoint, p256dh, auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: session.id, p256dh, auth },
      });

    return NextResponse.json({ success: true, channel: "web" });
  }

  // ── Native device token ──────────────────────────────────────────────────
  if (!token || !["android", "ios", "web"].includes(String(platform))) {
    return NextResponse.json({ error: "token and a valid platform are required" }, { status: 400 });
  }

  await registerDeviceToken(session.id, String(token), platform as "android" | "ios" | "web");

  return NextResponse.json({ success: true, channel: "native" });
}

/** Unsubscribe this browser (used when the user turns notifications off). */
async function handleDELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let endpoint: unknown;
  try {
    ({ endpoint } = await req.json());
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (typeof endpoint !== "string" || !endpoint) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  // Scoped to the session's own rows: this cannot be used to unsubscribe
  // somebody else's device.
  await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, session.id))
    );

  return NextResponse.json({ success: true });
}

/**
 * What the client needs before it can subscribe: whether the server can send
 * browser push at all, and the key to subscribe with. Both are public values.
 */
async function handleGET() {
  const publicKey = webPushPublicKey();

  return NextResponse.json(
    {
      webPush: {
        configured: publicKey !== null,
        publicKey,
      },
    },
    { headers: { "cache-control": "no-store" } }
  );
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
export const POST = withErrors(handlePOST);
export const DELETE = withErrors(handleDELETE);
