import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reminders, whatsappOptOuts } from "@/db/schema";
import { withErrors } from "@/lib/api-handler";
import { secretsMatch } from "@/lib/reminders";
import {
  normaliseMobile,
  parseWebhook,
  readWhatsAppConfig,
  verifyWebhookSignature,
} from "@/lib/whatsapp";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * WhatsApp's delivery receipts and replies.
 *
 * Two things arrive here and nothing else:
 *
 *   - **Delivery statuses.** A 200 from the send API means "accepted", not
 *     "delivered" - the phone may be off, the number may not be on WhatsApp at
 *     all. This is the only place that learns the difference, and the only
 *     place allowed to write `delivered` on a reminder.
 *   - **STOP.** Someone replying STOP has to be out, permanently, from that
 *     moment - not at the end of the month, not "next release". It becomes a
 *     row the sweep checks before every single send.
 *
 * Unsigned payloads are rejected outright: without the app secret this endpoint
 * would let anyone mark reminders delivered, or unsubscribe every borrower.
 *
 *   GET  /api/whatsapp/webhook   Meta's subscription handshake
 *   POST /api/whatsapp/webhook   statuses + incoming messages
 */
function handleGET(req: NextRequest) {
  const config = readWhatsAppConfig();

  if (!config.verifyToken) {
    return NextResponse.json(
      {
        error: "This deployment has not configured WhatsApp.",
        action: "Set WHATSAPP_VERIFY_TOKEN (any long random string) and paste the same value into Meta's webhook setup.",
      },
      { status: 503 }
    );
  }

  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge") ?? "";

  if (mode !== "subscribe" || !secretsMatch(token, config.verifyToken)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Meta expects the challenge back as plain text, not JSON.
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

async function handlePOST(req: NextRequest) {
  const config = readWhatsAppConfig();

  if (!config.appSecret) {
    return NextResponse.json(
      {
        error: "WhatsApp webhooks are not configured on this deployment.",
        action:
          "Set WHATSAPP_APP_SECRET (Meta → App settings → Basic → App secret). Without it, delivery confirmations and STOP replies cannot be trusted, so nothing is accepted.",
      },
      { status: 503 }
    );
  }

  // The signature covers the bytes Meta sent, so read them raw and verify
  // before parsing - never re-serialise the JSON and compare that.
  const rawBody = await req.text();

  if (!(await verifyWebhookSignature(rawBody, req.headers.get("x-hub-signature-256"), config.appSecret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but not JSON: acknowledge, so Meta stops retrying, and move on.
    return NextResponse.json({ received: true, ignored: "unparseable body" });
  }

  const { statuses, optOuts, otherReplies } = parseWebhook(payload);

  let statusUpdates = 0;
  let optOutsRecorded = 0;

  for (const status of statuses) {
    /*
     * `status` is this app's word ("did we get it out at all?"), `providerStatus`
     * is WhatsApp's. Only a message this app actually sent carries a
     * provider_message_id, so a status for someone else's message updates
     * nothing rather than corrupting a push reminder's record.
     */
    const updated = await db
      .update(reminders)
      .set({
        providerStatus: status.status,
        status:
          status.status === "delivered" || status.status === "read"
            ? "delivered"
            : status.status === "failed"
              ? "failed"
              : "sent",
        ...(status.error ? { providerError: status.error } : {}),
      })
      .where(eq(reminders.providerMessageId, status.messageId))
      .returning({ id: reminders.id });

    statusUpdates += updated.length;
  }

  for (const optOut of optOuts) {
    const mobile = normaliseMobile(optOut.mobile);
    if (!/^\d{10}$/.test(mobile)) continue;

    // Idempotent: WhatsApp can redeliver a webhook, and a person can say STOP
    // twice. Neither should be an error.
    const inserted = await db
      .insert(whatsappOptOuts)
      .values({ mobile, reason: "stop reply" })
      .onConflictDoNothing({ target: whatsappOptOuts.mobile })
      .returning({ id: whatsappOptOuts.id });

    if (inserted.length > 0) {
      optOutsRecorded += 1;
      console.warn(`[whatsapp] ${mobile} replied "${optOut.text}" - reminders to them stop now`);
    }
  }

  // Always 2xx for a well-signed payload: Meta retries anything else, forever.
  return NextResponse.json({ received: true, statusUpdates, optOutsRecorded, otherReplies });
}

export const GET = withErrors(handleGET);
export const POST = withErrors(handlePOST);
