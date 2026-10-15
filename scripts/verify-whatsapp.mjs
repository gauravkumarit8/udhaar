#!/usr/bin/env node
/**
 * Proves the WhatsApp reminder path end to end - without a Meta account.
 *
 * A stub stands in for the Cloud API (in this process, port 3103), and every
 * step of the real path runs over real HTTP:
 *
 *   sweep -> provider -> stored message id -> signed delivery webhook ->
 *   delivered -> STOP reply -> opt-out -> the next sweep refuses to send
 *
 * What it cannot prove: that Meta will accept *your* template and token. That
 * is what `npm run check-whatsapp` is for - it does the same two calls Meta
 * would, against the real API.
 *
 * Two terminals (the app must be running against the stub, which means the
 * development server: a production build ignores WHATSAPP_API_BASE on purpose):
 *
 *   # terminal 1 - the app, pointed at the stub
 *   WHATSAPP_PROVIDER=meta WHATSAPP_TOKEN=stub-token \
 *   WHATSAPP_PHONE_NUMBER_ID=999123 WHATSAPP_APP_SECRET=test-app-secret \
 *   WHATSAPP_VERIFY_TOKEN=verify-me WHATSAPP_API_BASE=http://127.0.0.1:3103 \
 *   npm run dev -- -p 3102 -H 127.0.0.1
 *
 *   # terminal 2
 *   npm run verify:whatsapp
 *
 * PowerShell (Windows):
 *   $env:WHATSAPP_PROVIDER="meta"; $env:WHATSAPP_TOKEN="stub-token"
 *   $env:WHATSAPP_PHONE_NUMBER_ID="999123"; $env:WHATSAPP_APP_SECRET="test-app-secret"
 *   $env:WHATSAPP_VERIFY_TOKEN="verify-me"; $env:WHATSAPP_API_BASE="http://127.0.0.1:3103"
 *   npm run dev -- -p 3102 -H 127.0.0.1
 *
 * Exit code 0 only when every check passes. It cleans up after itself: the
 * loans it created and the opt-out it recorded are deleted at the end.
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import "dotenv/config";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3102").replace(/\/+$/, "");
const CRON = process.env.CRON_SECRET;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "test-app-secret";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "verify-me";
const TEMPLATE = process.env.WHATSAPP_TEMPLATE_NAME || "udhaar_emi_reminder";

const SURFACE = "http://127.0.0.1:3103";
const BORROWER_ID = "22222222-2222-2222-2222-222222222222";
const BORROWER_MOBILE = "9876500022";
const UPI_ID = "kamla@okhdfcbank";

let pass = 0;
const failures = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(label);
    console.log(`  \u2717 ${label}\n      got      ${JSON.stringify(got)}\n      wanted   ${JSON.stringify(want)}`);
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set - point it at the same database the server uses.");
  process.exit(1);
}
if (!CRON) {
  console.error("CRON_SECRET is not set - the sweep cannot be called. Add it to .env.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// ── the stub, standing in for Meta ──────────────────────────────────────────
/*
 * Message ids carry this run's stamp. Meta's are globally unique, and a stub
 * whose ids repeat across runs makes the delivery webhook look like it matched
 * two reminders when it matched one - a bug in the test, reported as a bug in
 * the app, which is worse than no test.
 */
const runStamp = Date.now().toString(36);
const received = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    received.push({
      url: req.url,
      auth: req.headers.authorization ?? null,
      body: body ? JSON.parse(body) : null,
    });
    const id = `wamid.STUB.${runStamp}.${received.length}`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: [{ id }] }));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(3103, "127.0.0.1", resolve);
});

const app = await fetch(`${BASE_URL}/api/health`)
  .then((res) => res.json())
  .catch(() => null);

if (!app) {
  console.error(`No answer from ${BASE_URL}. Start the app first (see the header of this file).`);
  server.close();
  process.exit(1);
}

const wa = (app.checks ?? []).find((c) => c.name === "whatsapp reminders");
if (!wa || wa.detail === "off") {
  console.error(
    `The app at ${BASE_URL} has WhatsApp switched off.\n` +
      `Start it with WHATSAPP_PROVIDER=meta and WHATSAPP_API_BASE=${SURFACE} (see the header of this file).`
  );
  server.close();
  process.exit(1);
}

// ── helpers ────────────────────────────────────────────────────────────────
const sweep = async () =>
  (await fetch(`${BASE_URL}/api/reminders/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON}` },
  })).json();

function webhook(payload, { signed = true, secret = APP_SECRET } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`${BASE_URL}/api/whatsapp/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signed
        ? { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex") }
        : {}),
    },
    body,
  });
}

async function seedDueEmi(tag) {
  const { rows } = await pool.query(
    `insert into loans (borrower_id, borrower_name, borrower_mobile, lender_name, lender_mobile,
                        amount, interest_rate, tenure_months, start_date, status, upi_id, created_by_user_id)
     values ($1, 'Settlement Test Borrower', $2, $3, '9876500099', 6000, 0, 3, $4, 'active', $5, $1)
     returning id`,
    [BORROWER_ID, BORROWER_MOBILE, `Aunty Kamla ${tag}`, today, UPI_ID]
  );
  await pool.query(
    `insert into installments (loan_id, installment_number, due_date, principal_amount, interest_amount, total_amount)
     values ($1, 1, $2, 2000, 0, 2000), ($1, 2, $2::date + 30, 2000, 0, 2000), ($1, 3, $2::date + 60, 2000, 0, 2000)`,
    [rows[0].id, today]
  );
  return rows[0].id;
}

const created = [];
const cleanup = async () => {
  await pool.query(`delete from loans where id = any($1::uuid[])`, [created]);
  await pool.query(`delete from whatsapp_opt_outs where mobile = $1`, [BORROWER_MOBILE]);
};

// A previous run may have died before cleaning up.
await pool.query(`delete from whatsapp_opt_outs where mobile = $1`, [BORROWER_MOBILE]);

console.log(`\nVerifying WhatsApp reminders against ${BASE_URL} (stub provider on ${SURFACE})\n`);

console.log("The sweep sends the approved template, through the provider");
created.push(await seedDueEmi("A"));
const first = await sweep();

check("the sweep ran", first.ran, true);
check("WhatsApp is configured for this run", first.whatsapp.configured, true);

/*
 * Other active loans in the same scratch database may be due today too (the
 * settlement harness leaves probe loans behind), so pick out the message for
 * the loan this script created rather than assuming it is the only one.
 */
const mine = received.filter((call) =>
  String(call.body?.template?.components?.[0]?.parameters?.[4]?.text ?? "").includes(UPI_ID)
);
check("our loan produced exactly one WhatsApp message", mine.length, 1);

const sent = mine[0]?.body ?? {};
check("to the borrower's number, with the country code", sent.to, "919876500022");
check("as an approved template, not free text", sent.type, "template");
check("named as documented", sent.template?.name, TEMPLATE);
check("with the token the app was configured with", mine[0]?.auth, "Bearer " + (process.env.WHATSAPP_TOKEN || "stub-token"));

const params = sent.template?.components?.[0]?.parameters?.map((p) => p.text) ?? [];
check("five parameters, always five", params.length, 5);
check("...the borrower's first name", params[0], "Settlement");
check("...what is owed, written the app's way", params[1], "\u20b92,000.00");
check("...the lender's name", params[2], "Aunty Kamla A");
check("...the due date", /\d{4}$/.test(String(params[3])), true);
check("...and how to pay, from the lender's UPI id", params[4], `Pay by UPI to ${UPI_ID}.`);

const { rows: rows1 } = await pool.query(
  `select channel, status, provider_status, provider_message_id from reminders
   where loan_id = $1 and dedupe_key is not null`,
  [created[0]]
);
check("the reminder is recorded as carried by WhatsApp", rows1[0]?.channel, "whatsapp");
check("...accepted, not delivered - nothing can know that yet", rows1[0]?.provider_status, "accepted");
check(
  "...with the provider's message id kept for the webhook",
  rows1[0]?.provider_message_id === `wamid.STUB.${runStamp}.1`,
  true
);

console.log("\nOnly the webhook may say delivered");
const messageId = rows1[0].provider_message_id;
const receipt = await webhook({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "555",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            statuses: [{ id: messageId, status: "delivered", recipient_id: "919876500022" }],
          },
        },
      ],
    },
  ],
});
const receiptBody = await receipt.json().catch(() => null);

check("the signed webhook is accepted", receipt.status, 200);
check("...and found the reminder", receiptBody?.statusUpdates, 1);

const { rows: rows2 } = await pool.query(
  `select status, provider_status from reminders where provider_message_id = $1`,
  [messageId]
);
check("the reminder is now delivered", rows2[0]?.status, "delivered");
check("...and the provider's own word is kept beside ours", rows2[0]?.provider_status, "delivered");

console.log("\nSTOP is honoured, immediately and permanently");
const stop = await webhook({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "555",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            messages: [{ from: "919876500022", type: "text", text: { body: "STOP" } }],
          },
        },
      ],
    },
  ],
});
const stopBody = await stop.json().catch(() => null);

check("the reply is accepted", stop.status, 200);
check("...and recorded as an opt-out", stopBody?.optOutsRecorded, 1);

const { rows: optOut } = await pool.query(`select mobile, reason from whatsapp_opt_outs where mobile = $1`, [
  BORROWER_MOBILE,
]);
check("the number is on the do-not-message list", optOut[0]?.mobile, BORROWER_MOBILE);
check("...with where that was learned", optOut[0]?.reason, "stop reply");

created.push(await seedDueEmi("B"));
const before = received.length;
const second = await sweep();
const entry = (second.sent ?? []).find((s) => s.kind === "T0");

check("the next sweep ran", second.ran, true);
check("...and sent nothing more to the provider", received.length - before, 0);
check("...naming the opt-out as the reason", String(entry?.whatsapp ?? "").includes("replied STOP"), true);

const { rows: rows3 } = await pool.query(
  `select channel from reminders where loan_id = $1 and dedupe_key is not null`,
  [created[1]]
);
check("nothing was recorded as carried by WhatsApp", rows3[0]?.channel, "push");

/*
 * The day's budget, when this app was started with WHATSAPP_DAILY_MAX=1 and a
 * reminder has already gone out today: the send must be refused, not attempted.
 */
if (first.whatsapp.budgetLeft === 0) {
  console.log("\nThe daily budget is spent, so it refuses to spend more");
  check("the budget is reported as spent", first.whatsapp.budgetLeft, 0);
  check(
    "...and WhatsApp was skipped for a reason that names it",
    String((first.sent ?? []).find((s) => s.kind === "T0")?.whatsapp ?? "").includes("budget"),
    true
  );
}

console.log("\nNobody without the app secret can move any of that");
check("an unsigned payload is refused", (await webhook({ entry: [] }, { signed: false })).status, 401);
check(
  "a payload signed with the wrong secret is refused",
  (await webhook({ entry: [] }, { secret: "not-the-secret" })).status,
  401
);

const body = '{"a":2}';
const flipped = await fetch(`${BASE_URL}/api/whatsapp/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", APP_SECRET).update('{"a":1}').digest("hex"),
  },
  body,
});
check("a body changed after signing is refused", flipped.status, 401);

console.log("\nThe handshake Meta does when you paste the callback URL");
const handshake = await fetch(
  `${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=12345`
);
check("the right verify token gets the challenge back", [handshake.status, await handshake.text()], [200, "12345"]);

const wrong = await fetch(`${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`);
check("a wrong one gets nothing", wrong.status, 403);

await cleanup();
server.close();
await pool.end();

console.log(`\n${failures.length === 0 ? "\u2713" : "\u2717"} ${pass} checks passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
