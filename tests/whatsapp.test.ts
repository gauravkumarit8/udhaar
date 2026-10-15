import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildReminderTemplateParams,
  describeProviderError,
  isOptOutMessage,
  isWhatsAppConfigured,
  normaliseMobile,
  parseWebhook,
  readWhatsAppConfig,
  sendWhatsAppTemplate,
  shouldWhatsApp,
  verifyWebhookSignature,
  whatsappMissing,
  type WhatsAppConfig,
} from "@/lib/whatsapp";

/** A config with everything set, without touching process.env. */
function config(overrides: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    provider: "meta",
    token: "EAAG-token",
    phoneNumberId: "1234567890",
    wabaId: "999",
    appSecret: "app-secret",
    verifyToken: "verify-me",
    templateName: "udhaar_emi_reminder",
    templateLanguage: "en",
    apiVersion: "v23.0",
    apiBase: "https://graph.example",
    ...overrides,
  };
}

describe("building the template parameters", () => {
  it("fills all five, in the order the template expects", () => {
    const params = buildReminderTemplateParams({
      borrowerName: "Ravi Kumar",
      lenderName: "Aunty Kamla",
      amount: 4500,
      dueDateLabel: "14 Sep 2026",
      upiId: "kamla@okhdfcbank",
    });

    expect(params).toEqual([
      "Ravi", // first name only - "Hi Ravi", never "Hi Ravi Kumar"
      "₹4,500.00",
      "Aunty Kamla",
      "14 Sep 2026",
      "Pay by UPI to kamla@okhdfcbank.",
    ]);
  });

  it("still fills the pay line when the lender has no UPI id", () => {
    const params = buildReminderTemplateParams({
      borrowerName: "Ravi",
      lenderName: "Sunita",
      amount: 500,
      dueDateLabel: "1 Oct 2026",
      upiId: null,
    });

    // A missing trailing parameter is how a template send gets rejected, so
    // the fifth value is always present - it just says something else.
    expect(params).toHaveLength(5);
    expect(params[4]).toBe("Ask Sunita for their UPI id to pay.");
  });

  it("writes money the way the rest of the app does", () => {
    const params = buildReminderTemplateParams({
      borrowerName: "Ravi",
      lenderName: "Sunita",
      amount: 123456.5,
      dueDateLabel: "1 Oct 2026",
    });
    expect(params[1]).toBe("₹1,23,456.50");
  });

  it("falls back to a usable greeting when the name is blank", () => {
    const params = buildReminderTemplateParams({
      borrowerName: "   ",
      lenderName: "Sunita",
      amount: 1,
      dueDateLabel: "1 Oct 2026",
    });
    expect(params[0]).toBe("there");
  });
});

describe("who may be messaged", () => {
  const base = { hasAccount: true, optedOut: false, includeUnregistered: false, remaining: 100, budgetLeft: true };

  it("messages a borrower who has an account", () => {
    expect(shouldWhatsApp(base).send).toBe(true);
  });

  it("never messages a number that replied STOP", () => {
    const result = shouldWhatsApp({ ...base, optedOut: true });
    expect(result.send).toBe(false);
    expect(result.reason).toContain("STOP");
  });

  it("leaves a number the lender typed in alone, unless the operator says otherwise", () => {
    const held = shouldWhatsApp({ ...base, hasAccount: false });
    expect(held.send).toBe(false);
    expect(held.reason).toContain("consent");

    const allowed = shouldWhatsApp({ ...base, hasAccount: false, includeUnregistered: true });
    expect(allowed.send).toBe(true);
  });

  it("stops when the day's budget is spent", () => {
    expect(shouldWhatsApp({ ...base, budgetLeft: false }).send).toBe(false);
  });

  it("does not chase an EMI that is already paid", () => {
    expect(shouldWhatsApp({ ...base, remaining: 0 }).send).toBe(false);
  });
});

describe("what a refusal means", () => {
  it("names an expired token as the problem", () => {
    const { message, retryable } = describeProviderError(401, { error: { code: 190 } });
    expect(message).toContain("access token");
    expect(retryable).toBe(false);
  });

  it("distinguishes the phone number id from the phone number", () => {
    expect(describeProviderError(404, { error: { code: 100 } }).message).toContain(
      "WHATSAPP_PHONE_NUMBER_ID"
    );
  });

  it("says a template is not approved, rather than 'bad request'", () => {
    expect(describeProviderError(400, { error: { code: 132001, message: "no such template" } }).message).toContain(
      "not approved"
    );
  });

  it("marks a rate limit as worth retrying", () => {
    const { retryable } = describeProviderError(429, { error: { code: 130429 } });
    expect(retryable).toBe(true);
  });

  it("does not blame the operator for the provider being down", () => {
    const { message, retryable } = describeProviderError(503, {});
    expect(message).toContain("not your configuration");
    expect(retryable).toBe(true);
  });

  it("passes through a message it has no special case for", () => {
    expect(describeProviderError(400, { error: { message: "recipient not on WhatsApp" } }).message).toContain(
      "recipient not on WhatsApp"
    );
  });
});

describe("sending", () => {
  it("posts the template with the parameters, and returns the message id", async () => {
    let seen: { url: string; body: unknown; auth: string | null } | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ABC123" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendWhatsAppTemplate({
      to: "9876543210",
      params: ["Ravi", "₹500.00", "Sunita", "1 Oct 2026", "Pay by UPI to sunita@upi."],
      config: config(),
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, messageId: "wamid.ABC123" });
    const request = seen as unknown as { url: string; body: { to: string; template: { name: string; components: Array<{ parameters: unknown[] }> } }; auth: string | null };
    expect(request.url).toBe("https://graph.example/v23.0/1234567890/messages");
    expect(request.auth).toBe("Bearer EAAG-token");
    expect(request.body.to).toBe("919876543210");
    expect(request.body.template.name).toBe("udhaar_emi_reminder");
    expect(request.body.template.components[0].parameters).toHaveLength(5);
  });

  it("adds the country code when the stored number lacks one", async () => {
    let sentTo = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentTo = JSON.parse(String(init?.body)).to;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendWhatsAppTemplate({ to: "+91 98765 43210", params: [], config: config(), fetchImpl });
    expect(sentTo).toBe("919876543210");
  });

  it("refuses a number that is not an Indian mobile, without calling out", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendWhatsAppTemplate({ to: "12345", params: [], config: config(), fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a usable Indian mobile");
    expect(called).toBe(false);
  });

  it("says what is missing instead of calling with a blank token", async () => {
    const result = await sendWhatsAppTemplate({
      to: "9876543210",
      params: [],
      config: config({ provider: "off", token: "", phoneNumberId: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("WHATSAPP_PROVIDER=meta");
    expect(result.error).toContain("WHATSAPP_TOKEN");
  });

  it("survives the network being down", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const result = await sendWhatsAppTemplate({ to: "9876543210", params: [], config: config(), fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("Could not reach WhatsApp");
  });

  it("treats a 200 with no message id as a failure worth retrying", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const result = await sendWhatsAppTemplate({ to: "9876543210", params: [], config: config(), fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

describe("configuration", () => {
  it("is off unless asked for", () => {
    const saved = { ...process.env };
    delete process.env.WHATSAPP_PROVIDER;
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;

    expect(readWhatsAppConfig().provider).toBe("off");
    expect(isWhatsAppConfigured()).toBe(false);

    process.env = saved;
  });

  it("lists what to set, in order", () => {
    const missing = whatsappMissing(config({ provider: "off", token: "", phoneNumberId: "" }));
    expect(missing).toEqual(["WHATSAPP_PROVIDER=meta", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]);
  });

  it("is configured once the three are set", () => {
    expect(isWhatsAppConfigured(config())).toBe(true);
  });
});

describe("the webhook signature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const secret = "app-secret";
  const sign = (text: string, key = secret) =>
    "sha256=" + createHmac("sha256", key).update(text, "utf8").digest("hex");

  it("accepts a signature Meta would have sent", async () => {
    expect(await verifyWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a body that was changed after signing", async () => {
    expect(await verifyWebhookSignature(body + " ", sign(body), secret)).toBe(false);
  });

  it("rejects a signature made with a different secret", async () => {
    expect(await verifyWebhookSignature(body, sign(body, "not-the-secret"), secret)).toBe(false);
  });

  it("rejects a missing, malformed, or unsigned header", async () => {
    expect(await verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(await verifyWebhookSignature(body, "sha1=abc", secret)).toBe(false);
    expect(await verifyWebhookSignature(body, "sha256=not-hex", secret)).toBe(false);
  });

  it("rejects everything when no app secret is configured", async () => {
    expect(await verifyWebhookSignature(body, sign(body), "")).toBe(false);
  });

  it("accepts the bare hex form too", async () => {
    const bare = sign(body).slice(7);
    expect(await verifyWebhookSignature(body, bare, secret)).toBe(true);
  });
});

describe("reading a webhook payload", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "999",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              statuses: [
                { id: "wamid.1", status: "delivered", recipient_id: "919876543210" },
                { id: "wamid.2", status: "failed", errors: [{ title: "Message undeliverable" }] },
                { id: "wamid.3", status: "deleted" }, // not a status we act on
              ],
            },
          },
          {
            field: "messages",
            value: {
              messages: [
                { from: "919876543210", type: "text", text: { body: "STOP" } },
                { from: "919876543211", type: "text", text: { body: "ok thanks" } },
                { from: "919876543212", type: "image" },
              ],
            },
          },
        ],
      },
    ],
  };

  it("pulls out the statuses worth acting on, with the reason for a failure", () => {
    const { statuses } = parseWebhook(payload);
    expect(statuses).toEqual([
      { messageId: "wamid.1", status: "delivered" },
      { messageId: "wamid.2", status: "failed", error: "Message undeliverable" },
    ]);
  });

  it("finds the STOP reply and ignores the rest", () => {
    const { optOuts, otherReplies } = parseWebhook(payload);
    expect(optOuts).toEqual([{ mobile: "919876543210", text: "STOP" }]);
    expect(otherReplies).toBe(2);
  });

  it("does not throw on the shapes a real payload actually takes", () => {
    expect(parseWebhook(null)).toEqual({ statuses: [], optOuts: [], otherReplies: 0 });
    expect(parseWebhook({})).toEqual({ statuses: [], optOuts: [], otherReplies: 0 });
    expect(parseWebhook({ entry: [{ changes: [{ value: { statuses: "nope" } }] }] })).toEqual({
      statuses: [],
      optOuts: [],
      otherReplies: 0,
    });
    expect(parseWebhook({ entry: "nope" }).statuses).toEqual([]);
  });
});

describe("recognising an opt-out", () => {
  it("accepts the words people actually send", () => {
    for (const text of ["STOP", "stop", "Stop.", "unsubscribe", "opt out", "STOP reminders", "बंद"]) {
      expect(isOptOutMessage(text), text).toBe(true);
    }
  });

  it("does not read a sentence about stopping as an opt-out", () => {
    for (const text of [
      "please don't stop my reminders", // asking to KEEP them
      "do not stop", // same, spelled out
      "I stopped the payment", // a sentence about a payment
      "this is a very long message that mentions the word stop somewhere in it",
      "",
    ]) {
      expect(isOptOutMessage(text), text).toBe(false);
    }
  });

  it("still opts someone out who asked to stop, in as many words", () => {
    for (const text of ["please stop sending these", "stop.", "STOP reminders please", "बंद"]) {
      expect(isOptOutMessage(text), text).toBe(true);
    }
  });

  it("normalises the numbers Meta sends", () => {
    expect(normaliseMobile("919876543210")).toBe("9876543210");
    expect(normaliseMobile("09876543210")).toBe("9876543210");
    expect(normaliseMobile("9876543210")).toBe("9876543210");
  });
});
