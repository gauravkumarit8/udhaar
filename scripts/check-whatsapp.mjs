#!/usr/bin/env node
/**
 * Pre-flight check for WhatsApp reminders.
 *
 * The failure this exists to prevent: a template name typo, a 24-hour token
 * that expired overnight, or a phone-number id copied from the wrong screen.
 * All three look identical from the outside - WhatsApp reminders silently stop
 * going out - and all three take seconds to see here.
 *
 * It makes two read-only requests to Meta (never sends a message):
 *   1. the phone number id, to prove the token and the id are real
 *   2. the message template, to prove it exists and is APPROVED
 *
 * Usage:
 *   npm run check-whatsapp
 *   WHATSAPP_PROVIDER=meta WHATSAPP_TOKEN=... npm run check-whatsapp
 *
 * Exit code is 1 only when WhatsApp is switched on *and* broken. Not
 * configured is not a failure - push and the one-tap share still work.
 */
import "dotenv/config";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ok = (label, detail) => console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
const bad = (label, detail) => console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
const warn = (label, detail) => console.log(`  ${YELLOW}!${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);

const env = (name) => (process.env[name] ?? "").trim();

const provider = (env("WHATSAPP_PROVIDER").toLowerCase() || "off") === "meta" ? "meta" : "off";
const token = env("WHATSAPP_TOKEN");
const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
const wabaId = env("WHATSAPP_BUSINESS_ACCOUNT_ID");
const templateName = env("WHATSAPP_TEMPLATE_NAME") || "udhaar_emi_reminder";
const templateLanguage = env("WHATSAPP_TEMPLATE_LANGUAGE") || "en";
const apiVersion = env("WHATSAPP_API_VERSION") || "v23.0";

console.log(`\nWhatsApp reminders\n`);

if (provider !== "meta") {
  warn(
    "not configured - reminders go out by push, and by the lender's own one-tap WhatsApp share",
    "(set WHATSAPP_PROVIDER=meta to send them automatically)"
  );
  console.log(
    `\n${DIM}Setup guide: README → WhatsApp reminders. Nothing here is a failure:${RESET}\n` +
      `${DIM}the app is fully functional without it.${RESET}\n`
  );
  process.exit(0);
}

const missing = [];
if (!token) missing.push("WHATSAPP_TOKEN");
if (!phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");

if (missing.length > 0) {
  bad(`WHATSAPP_PROVIDER=meta but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set`, "");
  console.log(`\n${DIM}Copy both from Meta → WhatsApp → API Setup, and paste them into .env (or the host's environment).${RESET}\n`);
  process.exit(1);
}

const base = `https://graph.facebook.com/${apiVersion}`;

async function get(path) {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body };
  } catch (error) {
    // A network failure - no internet, a proxy, blocked egress - is not a
    // credential problem and must not be reported as one.
    return {
      status: 0,
      body: null,
      networkError: error instanceof Error ? error.message : "network error",
    };
  }
}

// 1. The token and the phone number id.
const number = await get(`/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);

if (number.status === 0) {
  bad("could not reach Meta from here", number.networkError);
  console.log(`\n${DIM}Nothing in the configuration was tested. Check this machine's network egress${RESET}\n${DIM}(or run the check on the host itself).${RESET}\n`);
  process.exit(1);
}

if (number.status === 401 || number.body?.error?.code === 190) {
  bad("the access token was rejected (expired or wrong)", "HTTP 401");
  console.log(
    `\n${DIM}A temporary token from the API Setup page lasts 24 hours. Create a System User token${RESET}\n` +
      `${DIM}with whatsapp_business_messaging permission - that one does not expire.${RESET}\n`
  );
  process.exit(1);
}

if (number.status === 404 || (number.status === 400 && number.body?.error?.code === 100)) {
  bad("no WhatsApp phone number with that id on this account", `WHATSAPP_PHONE_NUMBER_ID=${phoneNumberId}`);
  console.log(
    `\n${DIM}This must be the *phone number id* from Meta → WhatsApp → API Setup, not the phone${RESET}\n` +
      `${DIM}number itself, and not the WhatsApp Business Account id.${RESET}\n`
  );
  process.exit(1);
}

if (number.status !== 200) {
  bad("Meta refused the request", `HTTP ${number.status}: ${number.body?.error?.message ?? "no message"}`);
  process.exit(1);
}

ok(
  "the token works and the number is real",
  `${number.body.display_phone_number} (${number.body.verified_name})${number.body.quality_rating ? `, quality: ${number.body.quality_rating}` : ""}`
);

// 2. The template, which is what business-initiated messages must use.
if (!wabaId) {
  warn("WHATSAPP_BUSINESS_ACCOUNT_ID is not set, so the template could not be checked", "");
  console.log(
    `\n${DIM}Find it under Meta → WhatsApp → API Setup (WhatsApp Business Account ID). Setting it${RESET}\n` +
      `${DIM}lets this check confirm the template is approved before a reminder needs it.${RESET}\n`
  );
} else {
  const templates = await get(
    `/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}&fields=name,language,status,rejected_reason,components`
  );

  const match = (templates.body?.data ?? []).find(
    (t) => t.name === templateName && String(t.language).startsWith(templateLanguage)
  );

  if (!match) {
    const found = (templates.body?.data ?? []).map((t) => `${t.name} (${t.language})`).join(", ");
    bad(
      `no template named "${templateName}" in language "${templateLanguage}"`,
      found ? `this account has: ${found}` : "this account has no templates at all"
    );
    console.log(
      `\n${DIM}Create it in Meta → WhatsApp → Message Templates with the body shown in the README,${RESET}\n` +
        `${DIM}then set WHATSAPP_TEMPLATE_NAME / WHATSAPP_TEMPLATE_LANGUAGE to match it exactly.${RESET}\n`
    );
    process.exit(1);
  }

  if (match.status === "APPROVED") {
    ok(`the template "${match.name}" is approved`, `language ${match.language}`);
  } else if (match.status === "PENDING") {
    warn(`the template "${match.name}" is still under review`, "Meta usually decides within minutes to 24 hours");
  } else {
    bad(
      `the template "${match.name}" is ${match.status}`,
      match.rejected_reason ? `reason: ${match.rejected_reason}` : ""
    );
    process.exit(1);
  }
}

// 3. The parts that make delivery reports and STOP replies possible.
const appSecret = env("WHATSAPP_APP_SECRET");
const verifyToken = env("WHATSAPP_VERIFY_TOKEN");

if (!appSecret || !verifyToken) {
  warn(
    `delivery reports and STOP replies are off`,
    [!appSecret ? "WHATSAPP_APP_SECRET" : null, !verifyToken ? "WHATSAPP_VERIFY_TOKEN" : null].filter(Boolean).join(", ") + " not set"
  );
  console.log(
    `\n${DIM}Messages will send, but nothing learns whether they arrived, and somebody replying STOP${RESET}\n` +
      `${DIM}would keep getting reminders. Meta → App settings → Basic has the app secret; the verify${RESET}\n` +
      `${DIM}token is any long random string you paste into the webhook setup at${RESET}\n` +
      `${DIM}${DIM}Meta → WhatsApp → Configuration → Callback URL: https://your-app/api/whatsapp/webhook${RESET}\n`
  );
} else {
  ok("delivery reports and STOP replies are wired up", "webhook secret and verify token are set");
}

console.log("");
