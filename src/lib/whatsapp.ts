/**
 * Reminders sent *by the app*, through WhatsApp - the official Cloud API.
 *
 * Why this exists next to `share-reminder.ts`: that module hands the lender a
 * `wa.me` link and the lender taps send. It is free, it needs no provider, and
 * it stays the fallback - but it only works when a human remembers to tap, and
 * the person who owes the money is exactly the one who won't be nagged by an
 * app they never installed. WhatsApp is where these reminders already go; this
 * sends them on a schedule instead of by hand.
 *
 * What it deliberately is not:
 *
 *   - **Not a bulk-message pipe.** Meta only allows business-initiated
 *     messages as a pre-approved *template*, one per EMI per day (the sweep's
 *     dedupe key already guarantees that), with a daily ceiling and an opt-out
 *     list checked before every send.
 *   - **Not a claim of delivery.** A 200 from Meta means "accepted for
 *     delivery", nothing more. Only the webhook can say `delivered`, and that
 *     is the only thing that ever writes it.
 *   - **Not required.** Unconfigured, everything behaves exactly as before:
 *     push to the people who have the app, and the one-tap share for everyone
 *     else.
 *
 * Provider seam: `WHATSAPP_PROVIDER=meta` (default `off`) with the Cloud API
 * implemented below. A second provider means another `sendTemplate`
 * implementation, not a rewrite - the sweep only knows `sendWhatsAppTemplate`.
 */
import { toE164India } from "@/lib/share-reminder";

export type WhatsAppProvider = "meta" | "off";

export interface WhatsAppConfig {
  provider: WhatsAppProvider;
  /** Permanent (System User) token - temporary ones expire in 24 hours. */
  token: string;
  /** The *phone number id* from Meta, not the phone number itself. */
  phoneNumberId: string;
  /** WhatsApp Business Account id - only used by the template health check. */
  wabaId: string;
  /** Meta app secret, for verifying webhook signatures. */
  appSecret: string;
  /** The value Meta echoes back on the webhook handshake, of your choosing. */
  verifyToken: string;
  templateName: string;
  templateLanguage: string;
  apiVersion: string;
  /** Base URL, overridable for tests and for an on-prem proxy. */
  apiBase: string;
}

const DEFAULTS = {
  templateName: "udhaar_emi_reminder",
  templateLanguage: "en",
  apiVersion: "v23.0",
  apiBase: "https://graph.facebook.com",
};

const env = (name: string): string => (process.env[name] ?? "").trim();

export function readWhatsAppConfig(): WhatsAppConfig {
  const provider = (env("WHATSAPP_PROVIDER").toLowerCase() || "off") as WhatsAppProvider;
  return {
    provider: provider === "meta" ? "meta" : "off",
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    wabaId: env("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    templateName: env("WHATSAPP_TEMPLATE_NAME") || DEFAULTS.templateName,
    templateLanguage: env("WHATSAPP_TEMPLATE_LANGUAGE") || DEFAULTS.templateLanguage,
    apiVersion: env("WHATSAPP_API_VERSION") || DEFAULTS.apiVersion,
    /*
     * Pointing the API somewhere else is for a local stub and for providers
     * that front the Graph API. In a deployed app it would mean messages - and
     * the access token - go wherever the environment says, so it is ignored
     * there rather than trusted.
     */
    apiBase:
      process.env.NODE_ENV === "production"
        ? DEFAULTS.apiBase
        : env("WHATSAPP_API_BASE") || DEFAULTS.apiBase,
  };
}

/** Which of the required variables are missing, in the order to set them. */
export function whatsappMissing(config: WhatsAppConfig = readWhatsAppConfig()): string[] {
  const missing: string[] = [];
  if (config.provider !== "meta") missing.push("WHATSAPP_PROVIDER=meta");
  if (!config.token) missing.push("WHATSAPP_TOKEN");
  if (!config.phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  return missing;
}

export function isWhatsAppConfigured(config: WhatsAppConfig = readWhatsAppConfig()): boolean {
  return whatsappMissing(config).length === 0;
}

/**
 * Should this particular EMI be sent by WhatsApp?
 *
 * Pure, so the rules can be tested without a provider:
 *
 *   - a number that opted out is never messaged again, whatever else is true
 *   - the borrower having an account is the default requirement, because
 *     signing up is the consent. `WHATSAPP_TO_UNREGISTERED=true` widens it to
 *     numbers the lender typed in - a compliance decision for the operator,
 *     which is why it is not the default.
 */
export function shouldWhatsApp(input: {
  hasAccount: boolean;
  optedOut: boolean;
  includeUnregistered: boolean;
  remaining: number;
  /** True once this run has used up its share of the day's budget. */
  budgetLeft: boolean;
}): { send: boolean; reason?: string } {
  if (input.optedOut) return { send: false, reason: "this number replied STOP" };
  if (input.remaining <= 0) return { send: false, reason: "nothing left to remind about" };
  if (!input.budgetLeft) return { send: false, reason: "the daily WhatsApp budget is spent" };
  if (!input.hasAccount && !input.includeUnregistered) {
    return { send: false, reason: "borrower has no Udhaar account (consent)" };
  }
  return { send: true };
}

/**
 * The five values the approved template expects, in order.
 *
 * Meta requires the parameter *count* to match the approved template exactly,
 * so every parameter is always filled - including the last one, which says how
 * to pay when the lender has a UPI id and what to do when they don't. An
 * optional trailing parameter that is sometimes absent is the classic way to
 * get a template rejected mid-send.
 */
export function buildReminderTemplateParams(input: {
  borrowerName: string;
  lenderName: string;
  amount: number;
  dueDateLabel: string;
  upiId?: string | null;
}): string[] {
  const firstName = (input.borrowerName || "").trim().split(/\s+/)[0] || "there";
  const payLine = input.upiId
    ? `Pay by UPI to ${input.upiId}.`
    : `Ask ${input.lenderName} for their UPI id to pay.`;

  return [
    firstName,
    formatRupees(input.amount),
    input.lenderName,
    input.dueDateLabel,
    payLine,
  ];
}

/** ₹1,23,456.00, the way the rest of the app writes money. */
function formatRupees(amount: number): string {
  return `₹${Number(amount).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface WhatsAppSendResult {
  ok: boolean;
  /** WhatsApp's message id, for the delivery webhook to correlate. */
  messageId?: string;
  /** A sentence for the owner - never a raw provider dump. */
  error?: string;
  /** Worth trying again later (rate limit, provider hiccup) vs. never (bad token). */
  retryable?: boolean;
}

/**
 * Turns a Graph API error into something an operator can act on.
 *
 * Exported because it is the part worth testing: the difference between "your
 * token expired" and "that template was rejected last Tuesday" is the
 * difference between a five-minute fix and an afternoon.
 */
export function describeProviderError(
  httpStatus: number,
  payload: unknown
): { message: string; retryable: boolean } {
  const error = (payload as { error?: { message?: string; code?: number; error_subcode?: number } })
    ?.error;
  const code = error?.code;
  const sub = error?.error_subcode;

  if (httpStatus === 401 || code === 190) {
    return {
      message:
        "WhatsApp rejected the access token (expired or wrong). A temporary token lasts 24 hours - create a System User token with whatsapp_business_messaging permission.",
      retryable: false,
    };
  }
  if (httpStatus === 404 || code === 100) {
    return {
      message:
        "WhatsApp did not recognise the phone number id. WHATSAPP_PHONE_NUMBER_ID is the *id* from Meta's dashboard, not the phone number.",
      retryable: false,
    };
  }
  if (code === 132001 || code === 132000) {
    return {
      message: `The template "${error?.message ?? ""}" is not approved for this account under that name and language. Check the template's status in Meta, and match WHATSAPP_TEMPLATE_NAME / WHATSAPP_TEMPLATE_LANGUAGE to it.`,
      retryable: false,
    };
  }
  if (code === 131047 || sub === 131047) {
    return {
      message:
        "WhatsApp refused a business-initiated message to this number (24-hour rule): an approved template is required, and this one was not accepted. Re-submit the template.",
      retryable: false,
    };
  }
  if (httpStatus === 429 || code === 130429 || code === 80007) {
    return {
      message: "WhatsApp is rate limiting this number. Reminders will go out on the next run.",
      retryable: true,
    };
  }
  if (httpStatus >= 500) {
    return { message: "WhatsApp's API is having trouble - not your configuration.", retryable: true };
  }
  return {
    message: `WhatsApp refused the message: ${error?.message ?? `HTTP ${httpStatus}`}`,
    retryable: false,
  };
}

/**
 * Sends one approved template message. Never throws: the caller is a scheduled
 * sweep, and a provider outage must not fail the push reminders that follow it.
 */
export async function sendWhatsAppTemplate(input: {
  to: string;
  params: string[];
  config?: WhatsAppConfig;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}): Promise<WhatsAppSendResult> {
  const config = input.config ?? readWhatsAppConfig();
  const missing = whatsappMissing(config);
  if (missing.length > 0) {
    return { ok: false, error: `WhatsApp is not configured (missing ${missing.join(", ")})` };
  }

  const to = toE164India(input.to);
  if (!/^91\d{10}$/.test(to)) {
    return { ok: false, error: `"${input.to}" is not a usable Indian mobile number` };
  }

  const url = `${config.apiBase}/${config.apiVersion}/${config.phoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: config.templateName,
      language: { code: config.templateLanguage },
      components: [
        {
          type: "body",
          parameters: input.params.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };

  const doFetch = input.fetchImpl ?? fetch;

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const { message, retryable } = describeProviderError(res.status, payload);
      return { ok: false, error: message, retryable };
    }

    const messageId = (payload as { messages?: { id?: string }[] })?.messages?.[0]?.id;
    if (!messageId) {
      return { ok: false, error: "WhatsApp accepted the request but returned no message id", retryable: true };
    }

    return { ok: true, messageId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    return { ok: false, error: `Could not reach WhatsApp: ${reason}`, retryable: true };
  }
}

/**
 * Verifies Meta's `X-Hub-Signature-256` over the *raw* request body.
 *
 * Meta signs the bytes it sent; re-serialising the JSON and comparing that is
 * the standard way this check silently stops working (key order, spacing,
 * unicode escapes). The caller must therefore hand over the body as received.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  header: string | null,
  appSecret: string
): Promise<boolean> {
  if (!appSecret || !header) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(provided.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Words that mean "stop messaging me".
 *
 * Matched as whole words in a *short* message. Two things this deliberately
 * gets wrong in the safe direction:
 *
 *   - It only looks at short messages. "I stopped the payment" is a sentence
 *     about a payment, not an unsubscribe - and a rule that reads it as one
 *     silently drops reminders for someone who never asked.
 *   - It does not act on a negated request. "please don't stop my reminders" is
 *     somebody asking to *keep* being reminded; honouring it would do the exact
 *     opposite of what they said.
 *
 * Anything longer than a few words is left for a human to read in the logs
 * rather than guessed at. `STOP` (what WhatsApp's own UI offers) is two words or
 * fewer every time.
 */
export const OPT_OUT_KEYWORDS = [
  "stop",
  "unsubscribe",
  "opt out",
  "optout",
  "don't message",
  "do not message",
  "band karo",
  "बंद",
];

/** Words that flip a "stop" into "don't stop". */
const NEGATIONS = ["don't", "dont", "do not", "not", "never", "मत", "नहीं"];

/** How far around the keyword a negation can sit and still count. */
const NEGATION_WINDOW_BEFORE = 24;
const NEGATION_WINDOW_AFTER = 10;

function isNegated(message: string, start: number, end: number): boolean {
  const window = message.slice(
    Math.max(0, start - NEGATION_WINDOW_BEFORE),
    Math.min(message.length, end + NEGATION_WINDOW_AFTER)
  );
  return NEGATIONS.some((negation) => window.includes(negation));
}

export function isOptOutMessage(text: string | null | undefined): boolean {
  const message = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!message || message.length > 40) return false;

  // An explicit phrase ("stop reminders", "do not message") is never negated
  // by accident - it is already a complete request.
  const phrases = OPT_OUT_KEYWORDS.filter((keyword) => keyword.includes(" "));
  if (phrases.some((phrase) => message.includes(phrase))) return true;

  const singles = OPT_OUT_KEYWORDS.filter((keyword) => !keyword.includes(" "));
  for (const keyword of singles) {
    const pattern = new RegExp(`(^|[^a-z\\u0900-\\u097f])${keyword}([^a-z\\u0900-\\u097f]|$)`, "i");
    const match = pattern.exec(message);
    if (!match) continue;

    const start = match.index + match[1].length;
    if (!isNegated(message, start, start + keyword.length)) return true;
  }

  return false;
}

/** WhatsApp's delivery statuses, in the order they arrive. */
export type WhatsAppStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

export interface ParsedWebhook {
  statuses: Array<{
    messageId: string;
    status: WhatsAppStatus;
    error?: string;
  }>;
  /** Inbound replies that mean "stop", with the number they came from. */
  optOuts: Array<{ mobile: string; text: string }>;
  /** Inbound messages that don't mean stop - counted so the log isn't silent. */
  otherReplies: number;
}

/**
 * Reads Meta's webhook payload without trusting its shape.
 *
 * Everything is optional in that JSON, and a malformed payload must never throw
 * inside a webhook (Meta retries a non-200 forever).
 */
export function parseWebhook(payload: unknown): ParsedWebhook {
  const result: ParsedWebhook = { statuses: [], optOuts: [], otherReplies: 0 };

  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return result;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value || typeof value !== "object") continue;

      const statuses = (value as { statuses?: unknown[] }).statuses;
      if (Array.isArray(statuses)) {
        for (const status of statuses) {
          const id = (status as { id?: unknown }).id;
          const state = (status as { status?: unknown }).status;
          if (typeof id !== "string" || typeof state !== "string") continue;
          if (!["sent", "delivered", "read", "failed"].includes(state)) continue;

          const errorMessage = Array.isArray((status as { errors?: unknown[] }).errors)
            ? ((status as { errors: Array<{ title?: string; message?: string; code?: number }> }).errors[0]
                ?.title ??
              (status as { errors: Array<{ message?: string }> }).errors[0]?.message)
            : undefined;

          result.statuses.push({
            messageId: id,
            status: state as WhatsAppStatus,
            ...(errorMessage ? { error: String(errorMessage).slice(0, 300) } : {}),
          });
        }
      }

      const messages = (value as { messages?: unknown[] }).messages;
      if (Array.isArray(messages)) {
        for (const message of messages) {
          const from = (message as { from?: unknown }).from;
          const text = (message as { text?: { body?: unknown } })?.text?.body;
          if (typeof from !== "string") continue;

          if (isOptOutMessage(typeof text === "string" ? text : "")) {
            result.optOuts.push({ mobile: from, text: String(text).slice(0, 120) });
          } else {
            result.otherReplies += 1;
          }
        }
      }
    }
  }

  return result;
}

/** Indian mobiles are stored as 10 digits; the webhook sends 12 with the 91. */
export function normaliseMobile(mobile: string): string {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}
