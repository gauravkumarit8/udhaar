#!/usr/bin/env node
/**
 * Settlement checks against a running server.
 *
 * Unit tests cover the arithmetic; this covers the thing that was actually
 * broken - whether a borrower who pays the whole loan ends up with a *closed*
 * loan. It drives the real HTTP routes with real sessions, so it exercises the
 * database, the transactions and the responses, not just the helpers.
 *
 * Usage:
 *   npm run dev                      # in one terminal
 *   npm run verify:settlement        # in another
 *
 *   BASE_URL=http://localhost:3000 npm run verify:settlement
 *
 * The server must point at a database you can afford to write to: the script
 * seeds three fixed test users (a lender, a borrower and a stranger) with
 * sessions, then creates a handful of loans under them. Point it at a scratch
 * database, not at production. Exit code is 0 when every check passes.
 */
import "dotenv/config";
import pg from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const LENDER_TOKEN = "aa" + "1".repeat(62);
const BORROWER_TOKEN = "bb" + "2".repeat(62);
const STRANGER_TOKEN = "cc" + "3".repeat(62);

let passed = 0;
const failures = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push({ label, got, want });
    console.log(`  \u2717 ${label}\n      got      ${JSON.stringify(got)}\n      wanted   ${JSON.stringify(want)}`);
  }
}

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      ...(token ? { Cookie: `udhaar_session=${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers) };
}

const money = (v) => Number(Number(v).toFixed(2));

/**
 * Ask for an OTP, waiting out the per-number cooldown if we hit it.
 *
 * The app refuses a second OTP for the same number within 30 seconds (by
 * design - it is what stops SMS bombing). Without this, running the harness
 * twice in a row fails on the *second* run for a reason that has nothing to do
 * with the code being tested, which is how it behaved until 2026-10-15.
 */
async function sendOtp(mobile, { headers } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE_URL}/api/auth/send-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": RUN_IP, ...headers },
      body: JSON.stringify({ mobile }),
    });
    if (res.status !== 429) return { status: res.status, json: await res.json().catch(() => null) };
    const body = await res.json().catch(() => ({}));
    const wait = Number(String(body.error ?? "").match(/wait (\d+)s/)?.[1] ?? 0);
    // Only the cooldown is worth waiting for. A per-caller or per-day limit will
    // not clear in seconds, so report it instead of hanging.
    if (!wait || !/before requesting another OTP/.test(String(body.error))) {
      return { status: res.status, json: body };
    }
    await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
  }
  return { status: 429, json: { error: "still rate limited after waiting" } };
}

/** A caller address of this run's own, so runs don't share a rate-limit bucket. */
const RUN_IP = `198.18.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

/** A mobile number nothing else in this run has used. */
const freshMobile = (tag) =>
  `9${String(tag % 10)}${String(Date.now() % 100000000).padStart(8, "0")}`.slice(0, 10);

const LENDER_ID = "11111111-1111-1111-1111-111111111111";
const BORROWER_ID = "22222222-2222-2222-2222-222222222222";
const STRANGER_ID = "33333333-3333-3333-3333-333333333333";

/** Read-only SQL, for the handful of checks that read what the API stores. */
async function query(sql, params = []) {
  const connectionString = process.env.DATABASE_URL;
  const useSsl = !/localhost|127\.0\.0\.1/.test(connectionString ?? "");
  const pool = new pg.Pool({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } finally {
    await pool.end();
  }
}

/**
 * Three accounts with sessions the script can use, so it needs no OTP flow.
 * Idempotent: re-running it just refreshes the names and the expiry.
 */
async function seed() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set - point it at the same database the server uses.");
    process.exit(1);
  }
  const useSsl = !/localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new pg.Pool({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
  try {
    await pool.query(
      `INSERT INTO users (id, name, mobile) VALUES
         ($1, 'Settlement Test Lender',   '9876500021'),
         ($2, 'Settlement Test Borrower', '9876500022'),
         ($3, 'Settlement Test Stranger', '9876500033')
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, mobile = excluded.mobile`,
      [LENDER_ID, BORROWER_ID, STRANGER_ID]
    );
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES
         ($1, $4, now() + interval '1 day'),
         ($2, $5, now() + interval '1 day'),
         ($3, $6, now() + interval '1 day')
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id,
                                         expires_at = excluded.expires_at`,
      [LENDER_TOKEN, BORROWER_TOKEN, STRANGER_TOKEN, LENDER_ID, BORROWER_ID, STRANGER_ID]
    );
    console.log("seeded: a lender, a borrower and a stranger, each with a session");
  } finally {
    await pool.end();
  }
}

/**
 * The other direction: the borrower (or anyone) records "I owe ₹N to <name>"
 * for a lender who may have no Udhaar account at all.
 */
async function newBorrowedLoan(overrides = {}) {
  const { status, json } = await call("POST", "/api/loans", {
    token: BORROWER_TOKEN,
    body: {
      side: "borrower",
      lenderName: "Uncle Suresh",
      lenderMobile: "9876500099",
      amount: "10000",
      interestRate: "12",
      interestRatePeriod: "yearly",
      tenureMonths: "3",
      startDate: "2026-01-01",
      confirmationMode: "1-side",
      ...overrides,
    },
  });
  if (status !== 201) throw new Error(`could not create borrowed loan: ${status} ${JSON.stringify(json)}`);
  const id = json.loan.id;
  const detail = await call("GET", `/api/loans/${id}`, { token: BORROWER_TOKEN });
  return { id, loan: json.loan, detail: detail.json };
}

async function newLoan(overrides = {}) {
  const { status, json } = await call("POST", "/api/loans", {
    token: LENDER_TOKEN,
    body: {
      borrowerName: "Settlement Test Borrower",
      borrowerMobile: "9876500022",
      amount: "12000",
      interestRate: "12",
      interestRatePeriod: "yearly",
      tenureMonths: "3",
      startDate: "2026-01-01",
      confirmationMode: "1-side",
      ...overrides,
    },
  });
  if (status !== 201) throw new Error(`could not create loan: ${status} ${JSON.stringify(json)}`);
  const id = json.loan.id;
  const detail = await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN });
  return { id, detail: detail.json };
}

/** What the loan still owes, waivers netted out. */
function owed(detail) {
  let principal = 0;
  let interest = 0;
  for (const inst of detail.installments) {
    principal += Number(inst.principalAmount) - Number(inst.principalPaid) - Number(inst.principalWaived);
    interest += Number(inst.interestAmount) - Number(inst.interestPaid) - Number(inst.interestWaived);
  }
  return { principal: money(principal), interest: money(interest), total: money(principal + interest) };
}

/**
 * Can this deployment do the two things this harness assumes?
 *
 * Everything below signs in over OTP and drives the reminder sweep, so a server
 * started without OTP_MODE=dummy (a production build with no SMS provider
 * answers 503 on /api/auth/send-otp) or without CRON_SECRET turns one missing
 * variable into two hundred unrelated-looking failures. CI did exactly that the
 * first time these checks ran there. One sentence up front is worth all of it.
 *
 * The probe uses its own caller address and its own number, so it does not
 * spend the OTP budget the rate-limit checks below depend on.
 */
async function preflight() {
  const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  const sent = await sendOtp(freshMobile(9), { headers: { "x-forwarded-for": ip } });

  if (sent.status !== 200 || !sent.json?.devCode) {
    const why = sent.json?.error ?? `HTTP ${sent.status}`;
    console.error(
      `\n\u2717 this deployment cannot issue a test login, so there is nothing to check here.\n` +
        `  POST /api/auth/send-otp said: ${why}\n\n` +
        `  This harness signs in with the OTP the app hands back, which only happens when the app\n` +
        `  runs with OTP_MODE=dummy. Start it that way (and with CRON_SECRET set, which the reminder\n` +
        `  sweep checks need), or point BASE_URL at a deployment that already does.`
    );
    process.exit(1);
  }

  if (!process.env.CRON_SECRET) {
    console.error(
      `\n\u2717 CRON_SECRET is not set for this harness run.\n` +
        `  The reminder-sweep checks post to /api/reminders/run with it, so export the same value\n` +
        `  the server has and run again.`
    );
    process.exit(1);
  }

  console.log("  \u2713 preflight: the deployment issues test logins, and the sweep secret is set");
}

async function main() {
  const ping = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!ping) {
    console.error(`Nothing is answering at ${BASE_URL}. Start the app first (npm run dev).`);
    process.exit(1);
  }

  await preflight();
  await seed();

  console.log("\nThe reported bug: the borrower clears the whole loan in one transfer");
  {
    const { id, detail } = await newLoan();
    const { principal, interest, total } = owed(detail);
    console.log(`  schedule: ${detail.installments.length} EMIs, principal \u20b9${principal} + interest \u20b9${interest}`);
    check("a single payoff is accepted", (await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: total.toFixed(2), notes: "Cleared the whole loan" },
    })).status, 200);

    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("the loan is closed", after.loan.status, "closed");
    check("nothing is owed any more", owed(after), { principal: 0, interest: 0, total: 0 });
    check(
      "every EMI reads as paid",
      after.installments.map((i) => i.computedStatus),
      after.installments.map(() => "paid")
    );
    check("a second payoff on a closed loan is refused", (await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: "100" },
    })).status, 409);
  }

  console.log("\nEarly settlement waives the unpaid interest");
  {
    const { id, detail } = await newLoan();
    const { principal } = owed(detail);
    const res = await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: principal.toFixed(2) },
    });
    check("accepted", res.status, 200);
    check("the loan settled", res.json.settled, true);
    check("the unpaid interest is reported as waived", res.json.waivedInterest > 0, true);

    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("nothing is owed", owed(after), { principal: 0, interest: 0, total: 0 });
    check(
      "the waived interest is on the schedule, not marked paid",
      money(after.installments.reduce((sum, i) => sum + Number(i.interestWaived), 0)),
      money(res.json.waivedInterest)
    );
    check(
      "no interest was recorded as received",
      money(after.installments.reduce((sum, i) => sum + Number(i.interestPaid), 0)),
      0
    );
  }

  console.log("\nAn overpayment is recorded as received but not applied");
  {
    const { id, detail } = await newLoan({ amount: "5000", tenureMonths: "1" });
    const { total } = owed(detail);
    const res = await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: (total + 100).toFixed(2) },
    });
    check("accepted", res.status, 200);
    check("the excess is reported", res.json.unapplied, 100);
    check("...and still settles the loan", res.json.settled, true);

    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    const payoff = after.payments.find((p) => p.paymentType === "payoff");
    check("the payment row keeps the full amount received", money(payoff.amount), money(total + 100));
    check("with the unapplied part called out", money(payoff.unappliedAmount), 100);
  }

  console.log("\nA part payment at the loan level fills the oldest EMI first");
  {
    const { id } = await newLoan();
    const res = await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: "5000" },
    });
    check("accepted", res.status, 200);
    check("the loan is not closed", res.json.settled, false);
    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check(
      "EMI 1 paid, EMI 2 partial, EMI 3 untouched",
      after.installments.map((i) => i.computedStatus),
      ["paid", "partially_paid", "overdue"]
    );
  }

  console.log("\nWrite-off closes a loan that will never be repaid");
  {
    const { id, detail } = await newLoan();
    const first = detail.installments[0];
    await call("POST", `/api/installments/${first.id}/pay`, {
      token: BORROWER_TOKEN,
      body: { amount: Number(first.principalAmount).toFixed(2), paymentType: "principal" },
    });
    const refused = await call("POST", `/api/loans/${id}/close`, { token: LENDER_TOKEN, body: {} });
    check("closing with money owed is still refused", refused.status, 400);
    check("...and the response points at the write-off option", typeof refused.json.hint === "string", true);

    const done = await call("POST", `/api/loans/${id}/close`, {
      token: LENDER_TOKEN,
      body: { writeOff: true },
    });
    check("the write-off close is accepted", done.status, 200);

    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("the loan is closed", after.loan.status, "closed");
    check("nothing is owed", owed(after), { principal: 0, interest: 0, total: 0 });
    check(
      "nothing was mislabelled as paid",
      money(after.installments.reduce((sum, i) => sum + Number(i.principalPaid), 0)),
      money(first.principalAmount)
    );
    check(
      "the rest is recorded as written off",
      money(after.installments.reduce((sum, i) => sum + Number(i.principalWaived), 0)) > 0,
      true
    );
  }

  console.log("\nA 2-side payoff is a claim until the other side confirms");
  {
    const { id, detail } = await newLoan({ confirmationMode: "2-side" });
    const { total } = owed(detail);
    const marked = await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: total.toFixed(2) },
    });
    check("recorded by the borrower", marked.status, 200);
    check("...as a claim, not as settled money", marked.json.awaitingConfirmation, true);

    const mid = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("the loan is still open", mid.loan.status, "active");
    check("the ledger has not moved", owed(mid).total > 0, true);
    check("closing underneath the claim is refused", (await call("POST", `/api/loans/${id}/close`, {
      token: LENDER_TOKEN,
      body: { writeOff: true },
    })).status, 409);

    const confirmed = await call("PATCH", `/api/payments/${marked.json.payment.id}/confirm`, {
      token: LENDER_TOKEN,
      body: { action: "confirm" },
    });
    check("the lender can confirm it", confirmed.status, 200);
    check("...which settles the loan", confirmed.json.loanSettled, true);
    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("the loan is closed", after.loan.status, "closed");
    check("nothing is owed", owed(after), { principal: 0, interest: 0, total: 0 });
  }

  console.log("\nA payment marked by mistake can be withdrawn, not just stuck");
  {
    // The dead-end this fixes: a pending claim blocks every later payment on
    // the loan, and if the other side never acts it blocks it for good.
    const { id, detail } = await newLoan({ confirmationMode: "2-side" });
    const emi = detail.installments[0];
    const emiTotal = Number(emi.totalAmount);

    const marked = await call("POST", `/api/installments/${emi.id}/pay`, {
      token: BORROWER_TOKEN,
      body: { amount: "1000", paymentType: "both" },
    });
    check("the borrower marks a payment", marked.status, 200);
    check("...which waits for the lender", marked.json.payment?.status, "pending");

    /*
     * The feed is where that news arrives, so the feed is where it can be
     * answered: the notification carries the payment it is waiting on (additive
     * and optional - the reminders table has no payment id, so it is matched on
     * the installment) and the amount, so the buttons need no second request.
     */
    const claimId = marked.json.payment.id;
    const lenderFeed = await call("GET", "/api/notifications", { token: LENDER_TOKEN });
    const waitingOn = (lenderFeed.json.notifications ?? []).find((n) => n.paymentId === claimId);
    check("the claim reaches the lender's feed as a payable row", Boolean(waitingOn), true);
    check("...naming the payment", waitingOn?.paymentId, claimId);
    check("...and what it is for", Number(waitingOn?.paymentAmount ?? 0), 1000);
    check("...on the installment the claim is against", waitingOn?.installmentId, emi.id);

    /*
     * Home is where people land, and it used to say nothing about a claim: the
     * same screen that prints an overdue number would show it unchanged while
     * money sat waiting to be confirmed.
     */
    const lenderDash = await call("GET", "/api/dashboard", { token: LENDER_TOKEN });
    check("the lender's home screen counts the claim", lenderDash.json.awaitingYou?.count, 1);
    check("...and what it is worth", Number(lenderDash.json.awaitingYou?.amount ?? 0), 1000);
    check("...naming the payment to answer", lenderDash.json.awaitingYou?.items?.[0]?.paymentId, claimId);
    check("...and who is waiting on it", lenderDash.json.awaitingYou?.items?.[0]?.counterpartyName, "Settlement Test Borrower");

    const borrowerDash = await call("GET", "/api/dashboard", { token: BORROWER_TOKEN });
    check("the marker's own home screen does not ask them to confirm it", borrowerDash.json.awaitingYou?.count, 0);

    /*
     * The flag that stopped the app crashing on the screen after login.
     *
     * The client may only call the native PushNotifications plugin when the
     * server can actually deliver a push. Without this gate the app asked for a
     * token unconditionally, and in an APK built without google-services.json
     * that native call throws and Capacitor rethrows it on the main thread -
     * killing the process, which no amount of try/catch in the page can stop.
     */
    check(
      "the home screen says whether push can be delivered",
      typeof lenderDash.json.pushAvailable,
      "boolean"
    );
    check(
      "...and it is false when the server has no Firebase key",
      lenderDash.json.pushAvailable,
      Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    );

    /*
     * The other half of the same situation, from the marker's side. In 2-side
     * mode the ledger has not moved, so the EMI still reads as unpaid - and
     * every screen that offered "Pay" on it walked the person into a sheet, a
     * submit, and "This EMI is already fully paid" (the 400 checked below).
     *
     * So the due row now carries what the marker has already claimed on it and
     * what is honestly still payable: ownClaimOn() does the arithmetic, and
     * this is where the two surfaces are held to the same answer.
     */
    /*
     * Read with an explicit page size: these accounts accumulate loans every
     * time the harness runs (21 due rows on the day this was written), and the
     * default page is five - so the row under test can sit past the page even
     * though the API is behaving perfectly. The limit is what "see all" uses.
     */
    const markerAll = await call("GET", "/api/dashboard?limit=200", { token: BORROWER_TOKEN });
    const markerDue = (markerAll.json.dueItems ?? []).find((i) => i.installmentId === emi.id);
    check("the marker's own due row knows about their claim", Boolean(markerDue), true);
    check("...reporting what they have claimed on it", Number(markerDue?.claimedByYou ?? 0), 1000);
    check("...naming the claim to withdraw", markerDue?.claimedPaymentId, claimId);
    check(
      "...and only the remainder as payable",
      Number(markerDue?.payable ?? -1),
      money(emiTotal - 1000)
    );
    check(
      "...split into buckets the pay sheet can fill in from",
      money(Number(markerDue?.payablePrincipal ?? 0) + Number(markerDue?.payableInterest ?? 0)),
      money(emiTotal - 1000)
    );

    /*
     * The loan screen asks the same question of its own payload - "has this
     * viewer already claimed this EMI?" - so the fields it needs to answer it
     * (who marked each payment, and whether it is still pending) are held here.
     * A rename there would silently stop hiding the button, and nothing else
     * would notice.
     */
    const detailForRow = await call("GET", `/api/loans/${id}`, { token: BORROWER_TOKEN });
    check(
      "the loan screen's own payload carries the claim its rows check",
      (detailForRow.json.payments ?? []).some(
        (p) => p.id === claimId && p.status === "pending" && p.markedByUserId === BORROWER_ID
      ),
      true
    );

    /*
     * And the lender's row for the same EMI must NOT carry it: paying around
     * someone else's claim is not this side's job - answering it is, which is
     * what awaitingYou (checked above) is for.
     */
    const lenderAll = await call("GET", "/api/dashboard?limit=200", { token: LENDER_TOKEN });
    const lenderDue = (lenderAll.json.dueItems ?? []).find((i) => i.installmentId === emi.id);
    check("the other side's due row carries no claim of its own", Number(lenderDue?.claimedByYou ?? 0), 0);

    /*
     * The rule that must never bend: the marker is not offered their own claim,
     * because confirming it is a 403 - offered anyway it reads as a broken
     * button. pendingPaymentByInstallment() is where that lives.
     */
    const markerFeed = await call("GET", "/api/notifications", { token: BORROWER_TOKEN });
    check(
      "the marker's own feed is not offered the claim",
      (markerFeed.json.notifications ?? []).some((n) => n.paymentId === claimId),
      false
    );

    const blocked = await call("POST", `/api/installments/${emi.id}/pay`, {
      token: BORROWER_TOKEN,
      body: { amount: emiTotal.toFixed(2), paymentType: "both" },
    });
    check("while the claim stands, a second payment is refused", blocked.status, 400);
    check(
      "...and the refusal names the claim, not the balance",
      String(blocked.json.error).includes("awaiting confirmation"),
      true
    );

    const pendingId = marked.json.payment.id;

    check(
      "the other side cannot withdraw it on their behalf",
      (
        await call("PATCH", `/api/payments/${pendingId}/confirm`, {
          token: LENDER_TOKEN,
          body: { action: "withdraw" },
        })
      ).status,
      403
    );

    const withdrawn = await call("PATCH", `/api/payments/${pendingId}/confirm`, {
      token: BORROWER_TOKEN,
      body: { action: "withdraw" },
    });
    check("the person who marked it can withdraw it", withdrawn.status, 200);
    check("...recorded as cancelled, not rejected", withdrawn.json.status, "cancelled");

    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    // The EMI itself, not the loan: the loan has other EMIs outstanding too.
    const emiRow = after.installments.find((row) => row.id === emi.id);
    const emiRemaining = money(
      Number(emiRow.principalAmount) -
        Number(emiRow.principalPaid) -
        Number(emiRow.principalWaived) +
        Number(emiRow.interestAmount) -
        Number(emiRow.interestPaid) -
        Number(emiRow.interestWaived)
    );
    check("the EMI is owed again", emiRemaining, money(emiTotal));
    check(
      "...and the claim is not counted as money",
      after.payments.find((row) => row.id === pendingId)?.status,
      "cancelled"
    );

    const again = await call("POST", `/api/installments/${emi.id}/pay`, {
      token: BORROWER_TOKEN,
      body: { amount: emiTotal.toFixed(2), paymentType: "both" },
    });
    check("the payment it was blocking now goes through", again.status, 200);

    // Settle it, so this section does not leave an open loan behind - the
    // account-deletion check at the end of this file looks at all of them.
    const confirmedAgain = await call("PATCH", `/api/payments/${again.json.payment.id}/confirm`, {
      token: LENDER_TOKEN,
      body: { action: "confirm" },
    });
    check("the lender can still confirm the replacement", confirmedAgain.status, 200);

    const mid = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    const claim = await call("POST", `/api/loans/${id}/payoff`, {
      token: LENDER_TOKEN,
      body: { amount: owed(mid).total.toFixed(2) },
    });
    check("the rest settles normally after a withdrawal", claim.status, 200);
    await call("PATCH", `/api/payments/${claim.json.payment.id}/confirm`, {
      token: BORROWER_TOKEN,
      body: { action: "confirm" },
    });
    const done = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("...and the loan closes", done.loan.status, "closed");

    const settledFeed = await call("GET", "/api/notifications", { token: LENDER_TOKEN });
    check(
      "an answered claim is no longer offered as a payment to act on",
      (settledFeed.json.notifications ?? []).some((n) => n.paymentId === pendingId),
      false
    );

    const settledDash = await call("GET", "/api/dashboard", { token: LENDER_TOKEN });
    check("...and the home screen stops counting it", settledDash.json.awaitingYou?.count, 0);

    check(
      "a withdrawn claim cannot be confirmed afterwards",
      (
        await call("PATCH", `/api/payments/${pendingId}/confirm`, {
          token: LENDER_TOKEN,
          body: { action: "confirm" },
        })
      ).status,
      400
    );
  }

  console.log("\nA reminder that reaches a borrower who never installed the app");
  {
    const { id, detail } = await newLoan({ amount: "6000", interestRate: "0", upiId: "test@ybl" });
    const emi = detail.installments[0].id;

    const def = await call("POST", `/api/installments/${emi}/remind`, { token: LENDER_TOKEN, body: {} });
    check("WhatsApp is the default channel", def.json.reminder?.channel, "whatsapp");
    check("a WhatsApp deep link comes back", def.json.share?.whatsappUrl?.startsWith("https://wa.me/91"), true);
    check("...and an SMS one", def.json.share?.smsUrl?.startsWith("sms:+91"), true);

    const body = decodeURIComponent(String(def.json.share?.whatsappUrl).split("?text=")[1] ?? "");
    check("the message names the lender", body.includes("Settlement Test Lender here"), true);
    check("...and carries the amount and UPI link", body.includes("₹2,000.00") && body.includes("upi://pay"), true);

    // The distinguishing claim: a share is *not* a delivery.
    check("a share is never reported as delivered", def.json.delivered, false);
    check("...and the status says which it was", def.json.status, "shared");

    const push = await call("POST", `/api/installments/${emi}/remind`, { token: LENDER_TOKEN, body: { channel: "push" } });
    check("push is still available", push.status, 200);
    check("...and admits when nothing was delivered", push.json.delivered, false);

    check("a stranger cannot send a reminder", (await call("POST", `/api/installments/${emi}/remind`, {
      token: STRANGER_TOKEN, body: { channel: "whatsapp" },
    })).status, 403);
  }

  console.log("\nAn interest-free loan is the easy path, and adds up exactly");
  {
    const { id } = await newLoan({ amount: "1000", interestRate: "0", tenureMonths: "3" });
    const detail = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    const principal = money(detail.installments.reduce((sum, i) => sum + Number(i.principalAmount), 0));
    const interest = money(detail.installments.reduce((sum, i) => sum + Number(i.interestAmount), 0));
    check("no interest anywhere in the schedule", interest, 0);
    check("the schedule sums to exactly what was lent", principal, 1000);
    check("each EMI is just its principal",
      detail.installments.every((i) => Number(i.totalAmount) === Number(i.principalAmount)), true);
  }

  console.log("\nYour data: take it with you, and delete the account when nothing is open");
  {
    check("an export downloads as a file", Boolean((await call("GET", "/api/account/export", {
      token: LENDER_TOKEN,
    })).headers?.["content-disposition"]?.includes("attachment")), true);

    const exportRes = await call("GET", "/api/account/export", { token: LENDER_TOKEN });
    check("it names the person it belongs to", exportRes.json.profile?.mobile, "9876500021");
    check("it includes loans, installments and payments",
      exportRes.json.counts?.loans > 0 &&
        exportRes.json.counts?.installments > 0 &&
        "payments" in (exportRes.json.counts ?? {}), true);
    check("no cookie, no export", (await call("GET", "/api/account/export", {})).status, 401);

    const refused = await call("DELETE", "/api/account", { token: LENDER_TOKEN });
    check("deleting is refused while a loan is open", refused.status, 409);
    check("...and says what to do instead", String(refused.json.action ?? "").includes("write-off"), true);
    check("nothing was deleted", (await call("GET", "/api/loans", { token: LENDER_TOKEN })).status, 200);
  }

  console.log("\nA malformed id names nothing, so it is a 404 and not a 500");
  {
    /*
     * A link with a mangled id used to reach Postgres as-is, which rejected it
     * with 22P02 - "something went wrong on the server", a 500, for a request
     * that names nothing at all (and a database error in the logs that looks
     * like an outage). Every id-taking route now checks first.
     */
    const malformed = "not-a-uuid";
    for (const [label, method, path] of [
      ["a payment to answer", "PATCH", `/api/payments/${malformed}/confirm`],
      ["a payment's proof", "GET", `/api/payments/${malformed}/proof`],
      ["an installment to pay", "POST", `/api/installments/${malformed}/pay`],
      ["an installment to remind", "POST", `/api/installments/${malformed}/remind`],
      ["a loan to read", "GET", `/api/loans/${malformed}`],
      ["a loan to close", "POST", `/api/loans/${malformed}/close`],
      ["a loan to settle", "POST", `/api/loans/${malformed}/payoff`],
    ]) {
      // A GET may not carry a body (fetch refuses), and these routes only need
      // the id in the path to prove the point.
      const res = await call(method, path, method === "GET" ? { token: LENDER_TOKEN } : { token: LENDER_TOKEN, body: {} });
      check(`${label}: ${method} ${path.replace(malformed, "<bad>")} answers 404`, res.status, 404);
    }
    check(
      "...and never leaks that the database refused it",
      (await call("GET", `/api/loans/${malformed}`, { token: LENDER_TOKEN })).json.error,
      "Loan not found"
    );
  }

  console.log("\nWho may do what");
  {
    const { id } = await newLoan();
    check("a stranger cannot pay off the loan", (await call("POST", `/api/loans/${id}/payoff`, {
      token: STRANGER_TOKEN,
      body: { amount: "100" },
    })).status, 403);
    check("a borrower cannot write a loan off", (await call("POST", `/api/loans/${id}/close`, {
      token: BORROWER_TOKEN,
      body: { writeOff: true },
    })).status, 403);
    for (const amount of ["0", "-5", "1.234", "99999999999"]) {
      check(`"${amount}" is refused`, (await call("POST", `/api/loans/${id}/payoff`, {
        token: LENDER_TOKEN,
        body: { amount },
      })).status, 400);
    }
  }

  console.log("\nA borrower's own record of what they owe - and what they are not allowed to do");
  {
    const { id, loan, detail } = await newBorrowedLoan();

    check("the borrower is recorded as the borrower", loan.borrowerId, BORROWER_ID);
    check("the lender has no account yet, so lenderId is empty", loan.lenderId, null);
    check("...but their name is kept", loan.lenderName, "Uncle Suresh");
    check("...and their mobile, for when they join", loan.lenderMobile, "9876500099");
    check("the borrower wrote the record, so they can fix it", loan.createdByUserId, BORROWER_ID);

    const seen = await call("GET", "/api/loans", { token: BORROWER_TOKEN });
    const mine = (seen.json.loans ?? []).find((l) => l.id === id);
    check("it shows up in their own list", Boolean(mine), true);
    check("...on the borrowing side of the screen", mine?.viewerRole, "borrower");

    // The invariant: a waiver is never the borrower's to grant.
    const writeOff = await call("POST", `/api/loans/${id}/close`, {
      token: BORROWER_TOKEN,
      body: { writeOff: true },
    });
    check("they cannot write off their own debt", writeOff.status, 403);
    check("...and are told who can", String(writeOff.json.error).includes("Uncle Suresh"), true);
    check("...and that it needs the other person", String(writeOff.json.error).includes("haven't joined Udhaar"), true);

    const principal = money(detail.installments.reduce((sum, i) => sum + Number(i.principalAmount), 0));
    const total = money(detail.installments.reduce((sum, i) => sum + Number(i.totalAmount), 0));

    const forgive = await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: String(principal) },
    });
    check("they cannot cancel their own interest", forgive.status, 403);
    check("...and are told the full amount instead", String(forgive.json.error).includes("full amount"), true);
    check("...with the interest spelled out", forgive.json.interestOutstanding > 0, true);

    const still = await call("GET", `/api/loans/${id}`, { token: BORROWER_TOKEN });
    check("nothing moved on the loan", still.json.loan.status, "active");
    check("no payment was recorded", still.json.payments.length, 0);

    // Paying everything, though, is theirs to do.
    const payAll = await call("POST", `/api/loans/${id}/payoff`, {
      token: BORROWER_TOKEN,
      body: { amount: String(total) },
    });
    check("they can pay the whole amount", payAll.status, 200);
    check("...which settles the loan", payAll.json.settled, true);
    check("no interest was waived to make that happen", payAll.json.waivedInterest, 0);

    const closed = await call("GET", `/api/loans/${id}`, { token: BORROWER_TOKEN });
    check("the loan reads closed", closed.json.loan.status, "closed");
    check("nothing is owed", owed(closed.json), { principal: 0, interest: 0, total: 0 });
    check("and the lender was not consulted", closed.json.loan.lenderId, null);

    // Fixing a typo in their own entry is allowed while nobody else is on it.
    const typo = await newBorrowedLoan({ lenderName: "Aunty Kamla", amount: "500" });
    const fix = await call("PATCH", `/api/loans/${typo.id}`, {
      token: BORROWER_TOKEN,
      body: {
        side: "borrower",
        lenderName: "Aunty Kamla",
        lenderMobile: "9876500099",
        amount: "5000",
        interestRate: "0",
        tenureMonths: "3",
        startDate: "2026-01-01",
        confirmationMode: "1-side",
      },
    });
    check("the author can correct their own entry", fix.status, 200);
    check("...without flipping who owes whom", fix.json.loan.borrowerId, BORROWER_ID);
    check("...and their lender is still the one they named", fix.json.loan.lenderName, "Aunty Kamla");
    check("...while their own details are untouched",
      [fix.json.loan.borrowerName, fix.json.loan.borrowerMobile], ["Settlement Test Borrower", "9876500022"]);
    const remove = await call("DELETE", `/api/loans/${typo.id}`, { token: BORROWER_TOKEN });
    check("...and delete it while it is only theirs", remove.status, 200);

    // Once the lender is on Udhaar it is no longer the borrower's record to rewrite.
    const claimed = await newBorrowedLoan({ lenderName: "Settlement Test Lender", lenderMobile: "9876500021" });
    check("a lender who already has an account is attached straight away", claimed.loan.lenderId, LENDER_ID);
    check("...so the borrower is no longer the only one on it", claimed.loan.lenderId !== null, true);
    check("the borrower cannot delete it now",
      (await call("DELETE", `/api/loans/${claimed.id}`, { token: BORROWER_TOKEN })).status, 403);
    check("...nor rewrite it",
      (await call("PATCH", `/api/loans/${claimed.id}`, {
        token: BORROWER_TOKEN,
        body: {
          side: "borrower",
          lenderName: "Settlement Test Lender",
          lenderMobile: "9876500021",
          amount: "1",
          interestRate: "0",
          tenureMonths: "3",
          startDate: "2026-01-01",
        },
      })).status, 403);
    check("the lender can still waive interest on it",
      (await call("POST", `/api/loans/${claimed.id}/close`, { token: LENDER_TOKEN, body: { writeOff: true } })).status, 200);
  }

  console.log("\nThe nightly sweep still reaches a loan whose lender has no account");
  {
    // The first EMI falls one month after the start date, so starting a month
    // and two days ago puts EMI 1 two days past due - overdue enough for the
    // sweep to act today, but inside the nag window.
    const startedOverdue = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { id } = await newBorrowedLoan({
      lenderName: "Uncle Suresh",
      lenderMobile: "9876500099",
      amount: "3000",
      interestRate: "0",
      tenureMonths: "1",
      startDate: startedOverdue,
      upiId: "uncle@ybl",
    });

    const secret = process.env.CRON_SECRET;
    check("the sweep is configured on this deployment", Boolean(secret), true);

    // Re-runs must still be able to prove the sweep reaches this loan: the
    // dedupe key makes a second sweep on the same day a no-op, so clear today's
    // rows for this loan first. (The key itself is covered by unit tests.)
    await query(`DELETE FROM reminders WHERE loan_id = $1`, [id]);

    const sweep = await call("POST", "/api/reminders/run", {
      headers: { "x-cron-secret": secret },
    });
    check("the sweep runs", sweep.status, 200);

    check("it looked at installments that exist", sweep.json.checked > 0, true);
    check("nothing was reported as delivered without a device", sweep.json.delivered, 0);

    // The reminder row is the proof: a borrower-entered loan names its lender
    // from the loan record, not from a users row that does not exist.
    const reminderRows = await query(
      `SELECT recipient_id, message, status FROM reminders
        WHERE loan_id = $1 AND type = 'reminder' ORDER BY sent_at DESC`,
      [id]
    );
    check("the borrower-entered loan got a reminder of its own", reminderRows.length > 0, true);
    check("...composed with the lender's stored name",
      String(reminderRows[0]?.message ?? "").includes("Uncle Suresh"), true);
    check("...addressed to the borrower", reminderRows[0]?.recipient_id, BORROWER_ID);
    check("...and it is not marked delivered", reminderRows[0]?.status, "failed");

    // The borrower can see it in Activity - that is the point of recording it.
    const activity = await call("GET", "/api/notifications", { token: BORROWER_TOKEN });
    check("the borrower can see the reminder in their Activity",
      (activity.json.notifications ?? []).some((n) => n.loanId === id), true);
  }

  console.log("\nThe dashboard lists the next payment per loan, not every EMI");
  {
    // A loan with an overdue EMI, a second overdue one, and five upcoming: the
    // list must show one line for it, not seven.
    const startedLongAgo = new Date(Date.now() - 5 * 31 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { id } = await newLoan({
      amount: "7000",
      interestRate: "0",
      tenureMonths: "7",
      startDate: startedLongAgo,
    });
    const detail = await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN });
    const unpaid = detail.json.installments.filter(
      (i) => Number(i.principalPaid) + Number(i.interestPaid) === 0
    );
    check("the loan has several installments outstanding", unpaid.length >= 5, true);

    // A big page: the dashboard sends five rows by default now, and this check
    // is about a specific loan that may not be in the first five.
    const board = await call("GET", "/api/dashboard?limit=200", { token: LENDER_TOKEN });
    const rows = (board.json.dueItems ?? []).filter((item) => item.loanId === id);
    check("the dashboard shows it once", rows.length, 1);
    check("...on its earliest unpaid installment", rows[0]?.installmentId, unpaid[0].id);
    check("...which is the one that is overdue", (rows[0]?.daysUntilDue ?? 1) < 0, true);
    check("...with the rest of the arrears summarised, not repeated",
      rows[0]?.moreOverdueCount >= 1 && rows[0]?.moreOverdueAmount > 0, true);
    check("...and no installment row is repeated for the same loan",
      new Set((board.json.dueItems ?? []).map((i) => i.loanId)).size,
      (board.json.dueItems ?? []).length);

    // The money still adds up over everything outstanding, not just the row.
    const stated = board.json.summary.overdueAmount;
    const actual = unpaid
      .filter((i) => new Date(`${i.dueDate}T00:00:00Z`) < new Date())
      .reduce((sum, i) => sum + Number(i.totalAmount), 0);
    check("the overdue total still counts every overdue EMI",
      money(Number(stated)) >= money(actual), true);

    // The dashboard carries the viewer, so the page needs no second request.
    check("the payload names the viewer once", board.json.user?.mobile, "9876500021");

    // The badge rides along in the screens' own responses, so the tab bar does
    // not have to spend a second round trip asking for it.
    check("the dashboard carries the badge count", typeof board.json.unread, "number");
    const loanPayload = await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN });
    check("...and so does a loan screen", typeof loanPayload.json.unread, "number");

    // The badge and the feed must agree about what is unread.
    const badge = await call("GET", "/api/notifications?summary=1", { token: BORROWER_TOKEN });
    const feed = await call("GET", "/api/notifications", { token: BORROWER_TOKEN });
    check("the badge count is a number", typeof badge.json.unread, "number");
    check("...and matches the feed's own count", badge.json.unread, feed.json.unread);
  }

  console.log("\nThe dashboard answers with a page, and the arithmetic still adds up");
  {
    /*
     * Six identical \u20b91,000 loans at 0%, entered today.
     *
     * Chosen so every figure below is arithmetic a reader can do in their head:
     * nothing overdue, nothing due this week, no interest. The account is also
     * guaranteed to hold more than one page of loans whatever ran before this,
     * which is what makes the cap assertions deterministic instead of a
     * comment about what the database happens to contain.
     */
    const today = new Date().toLocaleDateString("en-CA");
    // Before any of it, so the six loans below can be measured as a difference.
    const before = (await call("GET", "/api/dashboard", { token: LENDER_TOKEN })).json;
    const created = [];
    for (let i = 0; i < 6; i += 1) {
      const { id } = await newLoan({
        amount: "1000",
        interestRate: "0",
        tenureMonths: "6",
        startDate: today,
      });
      created.push(id);
    }

    const page = (await call("GET", "/api/dashboard", { token: LENDER_TOKEN })).json;
    const full = (await call("GET", "/api/dashboard?limit=200", { token: LENDER_TOKEN })).json;

    /*
     * The equivalence check: every money figure the route reports has to equal
     * what a plain fold over the raw installment rows says - the loop the route
     * used to run in Node, run here instead. The route computes these in SQL
     * now; this is the same question asked a second way, from the outside.
     */
    const rows = await query(
      `select l.lender_id, i.principal_amount, i.principal_paid, i.interest_amount, i.interest_paid
         from loans l join installments i on i.loan_id = l.id
        where l.status = 'active' and (l.lender_id = $1 or l.borrower_id = $1)`,
      [LENDER_ID]
    );
    let expectReceive = 0;
    let expectPay = 0;
    let expectInterest = 0;
    for (const row of rows) {
      const principal = Math.max(0, Number(row.principal_amount) - Number(row.principal_paid));
      const interest = Math.max(0, Number(row.interest_amount) - Number(row.interest_paid));
      if (row.lender_id === LENDER_ID) {
        expectReceive += principal + interest;
        expectInterest += interest;
      } else {
        expectPay += principal + interest;
      }
    }
    check("the dashboard's receivable equals a fold of the raw rows",
      full.summary.youWillReceive, money(expectReceive));
    check("...its payable too", full.summary.youWillPay, money(expectPay));
    check("...and the interest on top", full.summary.totalInterestEarned, money(expectInterest));
    check("the six new loans are \u20b96,000 more receivable",
      money(full.summary.youWillReceive - before.summary.youWillReceive), 6000);
    check("...and six more active loans",
      full.summary.activeLoans - before.summary.activeLoans, 6);
    check("...with no interest, because they are interest-free",
      full.summary.totalInterestEarned, before.summary.totalInterestEarned);
    check("...and nothing overdue or due this week",
      [full.summary.overdueAmount, full.summary.dueThisWeek],
      [before.summary.overdueAmount, before.summary.dueThisWeek]);

    // The page a phone gets: five rows, and the counts of everything behind them.
    check("the dashboard sends five loans, not every loan", page.loans.length, 5);
    check("...and says there are more", page.hasMoreLoans, true);
    check("...while still counting them all", page.summary.totalLoans, full.summary.totalLoans);
    check("...and the five it sends are the live ones",
      page.loans.filter((l) => l.status === "active").length,
      Math.min(5, page.summary.activeLoans));
    check("the due list is a page as well", page.dueItems.length, 5);
    check("...and carries the count of the whole list", page.dueItemCount, full.dueItems.length);
    check("asking for more of it returns the same rows", full.dueItems.length, full.dueItemCount);

    // The same accounting underneath, on the list endpoint the see-all screen uses.
    const firstPage = await call("GET", "/api/loans?limit=2&offset=0", { token: LENDER_TOKEN });
    const secondPage = await call("GET", "/api/loans?limit=2&offset=2", { token: LENDER_TOKEN });
    check("the full list takes a page size", firstPage.json.loans.length, 2);
    check("...and reports how many there are in total", firstPage.json.total, full.summary.totalLoans);
    check("...and that there is more behind it", firstPage.json.hasMore, true);
    check("...so page two is a different pair of loans",
      firstPage.json.loans[0].id !== secondPage.json.loans[0].id, true);
    check("...and the badge rides along on a list screen", typeof firstPage.json.unread, "number");

    const junk = await call("GET", "/api/loans?limit=abc&offset=-5", { token: LENDER_TOKEN });
    check("a nonsense page size is a page, not an error", junk.status, 200);
    check("...clamped to the default page", junk.json.limit, 50);
    check("...and a negative offset to the start", junk.json.offset, 0);

    // Leave the database as it was found, so a re-run starts from the same place.
    await query("DELETE FROM loans WHERE id = ANY($1::uuid[])", [created]);
    const [{ n }] = await query("select count(*)::int as n from loans where id = ANY($1::uuid[])", [created]);
    check("the probe loans are cleaned up", n, 0);
  }

  console.log("\nThe loan list searches, filters, and answers in pages");
  {
    const everything = (await call("GET", "/api/loans?limit=200", { token: LENDER_TOKEN })).json;
    check("the list reports how many there are", typeof everything.total, "number");
    check("...and whether a page is all of it", typeof everything.hasMore, "boolean");

    const sample = everything.loans[0];
    const firstName = sample.borrowerName.split(" ")[0];
    const byName = (
      await call("GET", `/api/loans?limit=200&q=${encodeURIComponent(firstName)}`, {
        token: LENDER_TOKEN,
      })
    ).json;
    check("a search by name finds that loan", byName.loans.some((l) => l.id === sample.id), true);
    check("...and never claims more results than the account has", byName.total <= everything.total, true);

    // The important one: `%` is an operator in a LIKE pattern, not text, so a
    // search for it must find nothing rather than every loan on the account.
    const percent = (
      await call("GET", "/api/loans?limit=200&q=%25", { token: LENDER_TOKEN })
    ).json;
    check("a search for '%' looks for a percent sign, not everything", percent.total, 0);
    const underscore = (
      await call("GET", "/api/loans?limit=200&q=_", { token: LENDER_TOKEN })
    ).json;
    check("...and so does '_'", underscore.total, 0);

    const nothing = (
      await call("GET", "/api/loans?limit=200&q=zzznotaloan", { token: LENDER_TOKEN })
    ).json;
    check("a search that matches nothing returns nothing", nothing.total, 0);

    const running = (
      await call("GET", "/api/loans?limit=200&status=active", { token: LENDER_TOKEN })
    ).json;
    check("filtering to running loans returns only running loans",
      running.loans.every((l) => l.status === "active"), true);
    check("...and counts what it filtered", running.total <= everything.total, true);

    const closed = (
      await call("GET", "/api/loans?limit=200&status=closed", { token: LENDER_TOKEN })
    ).json;
    check("filtering to closed loans returns no running ones",
      closed.loans.every((l) => l.status !== "active"), true);

    const borrowed = (
      await call("GET", "/api/loans?limit=200&role=borrower", { token: LENDER_TOKEN })
    ).json;
    check("filtering to the borrowed side returns only borrowed loans",
      borrowed.loans.every((l) => l.viewerRole === "borrower"), true);

    const nonsense = (
      await call("GET", "/api/loans?limit=200&status=deleted&role=cosigner", { token: LENDER_TOKEN })
    ).json;
    check("an unknown filter is ignored, not obeyed", nonsense.total, everything.total);
  }

  console.log("\nA loan can be printed out as a statement");
  {
    // A fresh three-month loan: a schedule to print, and a ledger to add to.
    const { id } = await newLoan({
      amount: "6000",
      interestRate: "12",
      tenureMonths: "3",
      startDate: "2026-01-01",
    });

    const sheet = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    check("the statement has every EMI on it", sheet.installments.length, 3);
    check("...each with a status the sheet can print",
      sheet.installments.every((i) => typeof i.computedStatus === "string"), true);
    check("...the loan's own terms",
      [typeof sheet.loan.startDate, typeof sheet.loan.interestRate, sheet.loan.tenureMonths],
      ["string", "string", 3]);
    check("...which side the reader is on", sheet.loan.viewerRole, "lender");
    check("...and an empty ledger to start", sheet.payments.length, 0);

    // Pay something, and the receipt has to show up on the sheet.
    const paid = await call("POST", `/api/installments/${sheet.installments[0].id}/pay`, {
      token: LENDER_TOKEN,
      body: { amount: "1", paymentType: "both", notes: "statement check" },
    });
    check("a payment can be recorded", paid.status, 200); // this route answers 200, not 201

    const after = (await call("GET", `/api/loans/${id}`, { token: LENDER_TOKEN })).json;
    const entry = after.payments[after.payments.length - 1];
    check("it appears in the statement's ledger", after.payments.length, 1);
    check("...with its amount", Number(entry?.amount), 1);
    check("...its note", entry?.notes, "statement check");
    check("...and a status (pending until the other side confirms)", typeof entry?.status, "string");
    check("...and the EMI it was paid against", Boolean(entry?.installmentId), true);

    // The counterparty sees the same sheet, from their side of it.
    const theirSheet = (await call("GET", `/api/loans/${id}`, { token: BORROWER_TOKEN })).json;
    check("the borrower can open the same statement", theirSheet.installments.length, 3);
    check("...and it is labelled from their side", theirSheet.loan.viewerRole, "borrower");
  }

  console.log("\nThe app refuses the things it should refuse");
  {
    /*
     * The upload gate, which is where a stored XSS got in.
     *
     * An SVG is not a photo: it is a document the browser parses and runs, and
     * this app serves proofs back from its own origin. It used to pass a check
     * that only looked at the `data:image/` prefix. Both halves are tested here
     * against the running server - the declared type, and the bytes themselves.
     */
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    ).toString("base64");
    const jpegBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...Array(40).fill(0x30),
    ]).toString("base64");

    /*
     * Probed with a throwaway account, signed up through the real OTP flow.
     *
     * The upload cap is 20 per account per 10 minutes, so probing with a
     * long-lived test account would answer 429 after a couple of runs and the
     * gate would go untested. A fresh account per run keeps this honest without
     * weakening the cap itself.
     */
    const probeMobile = freshMobile(Math.floor(Math.random() * 10));
    const probeSent = await sendOtp(probeMobile);
    check("a throwaway account can ask for an OTP", probeSent.status, 200);
    const probeSignup = await call("POST", "/api/auth/verify-otp", {
      body: { mobile: probeMobile, code: String(probeSent.json?.devCode ?? "123456"), name: "Upload Probe" },
    });
    const probeToken = probeSignup.headers["set-cookie"]?.match(/udhaar_session=([^;]+)/)?.[1];
    check("...and gets a session of its own", Boolean(probeToken), true);

    const upload = (image) => call("POST", "/api/upload", { token: probeToken, body: { image } });

    const asSvg = await upload(`data:image/svg+xml;base64,${svg}`);
    check("an SVG uploaded as an image is refused", asSvg.status, 400);
    check("...and the message says why, in words a person can act on",
      /document that can run code/.test(String(asSvg.json?.error ?? "")), true);

    const disguised = await upload(`data:image/png;base64,${svg}`);
    check("markup wearing an image mime type is refused", disguised.status, 400);
    check("...because the bytes are not that image",
      /bytes don't match/.test(String(disguised.json?.error ?? "")), true);

    const rawMarkup = await upload("data:image/svg+xml,<svg onload=alert(1)></svg>");
    check("a non-base64 data URL is refused", rawMarkup.status, 400);

    const realJpeg = await upload(`data:image/jpeg;base64,${jpegBytes}`);
    check("a real JPEG passes the gate (Cloudinary may still refuse it)",
      realJpeg.status === 503 || realJpeg.status === 200, true);

    // The response that serves those bytes declares its own type - never the
    // store's, which is how an SVG reached the browser as a document.
    const proof = await call("GET", `/api/payments/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/proof`, {
      token: LENDER_TOKEN,
    });
    check("an unknown payment has no proof to serve", proof.status, 404);

    await query("DELETE FROM users WHERE mobile = $1", [probeMobile]);
  }

  console.log("\nEvery response carries the headers that were missing");
  {
    // Anonymous, because this is what a browser and a scanner both see.
    const page = await fetch(`${BASE_URL}/login`);
    const h = (name) => page.headers.get(name);

    check("a page is served", page.status, 200);
    check("HSTS is set", /max-age=\d{6,}/.test(String(h("strict-transport-security"))), true);
    check("...for at least a year", Number(String(h("strict-transport-security")).match(/max-age=(\d+)/)?.[1] ?? 0) >= 31_536_000, true);
    check("nosniff is set", h("x-content-type-options"), "nosniff");
    check("a referrer policy is set", h("referrer-policy"), "strict-origin-when-cross-origin");
    check("framing is refused", /frame-ancestors/.test(String(h("content-security-policy"))), true);
    check("a permissions policy is set", /camera=/.test(String(h("permissions-policy"))), true);
    check("the framework is not advertised", h("x-powered-by"), null);

    const api = await fetch(`${BASE_URL}/api/health`);
    check("API responses are nosniff too", api.headers.get("x-content-type-options"), "nosniff");
    check("...and not embeddable elsewhere", api.headers.get("cross-origin-resource-policy"), "same-origin");
  }

  console.log("\nThe health endpoint tells a stranger nothing useful");
  {
    const publicBody = await (await fetch(`${BASE_URL}/api/health`)).json();
    const asText = JSON.stringify(publicBody);

    check("it still answers anonymously", typeof publicBody.ok, "boolean");
    check("...and names the build", typeof publicBody.shortCommit === "object" || typeof publicBody.shortCommit === "string", true);
    check("...with every check's verdict", Array.isArray(publicBody.checks), true);
    check("but not the database host", /neon\.tech|127\.0\.0\.1|localhost/.test(asText), false);
    check("...nor that the dummy OTP is 123456", asText.includes("123456"), false);
    check("...nor which integrations are configured",
      /proofs: configured|push \(app\): configured/.test(asText), false);

    // With the health token (when the deployment has one) the diagnosis is back.
    if (process.env.HEALTH_TOKEN) {
      const withToken = await (
        await fetch(`${BASE_URL}/api/health`, { headers: { "x-health-token": process.env.HEALTH_TOKEN } })
      ).json();
      check("the token holder sees the full detail",
        JSON.stringify(withToken).length > asText.length, true);
      check("...including details the public body lacks",
        JSON.stringify(withToken) !== asText, true);
    }
  }

  console.log("\nOTP sending is capped by more than the number itself");
  {
    // Per caller: 10 requests per 10 minutes from one address. Distinct numbers,
    // so the per-number cooldown is not what stops it.
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    const tag = Math.floor(Math.random() * 10);
    let blocked = null;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/send-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ mobile: freshMobile(tag + i) }),
      });
      if (res.status === 429) {
        blocked = { at: i + 1, retryAfter: res.headers.get("retry-after") };
        break;
      }
    }
    check("one address is cut off after ten OTP requests", blocked?.at, 11);
    check("...and is told how long to wait", Number(blocked?.retryAfter ?? 0) > 0, true);

    // A different address is unaffected, so the cap is per caller and not a
    // global outage (the global budget is enforced separately, in the database).
    const otherIp = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const other = await sendOtp(freshMobile(9), { headers: { "x-forwarded-for": otherIp } });
    check("a different caller is not punished for it", other.status, 200);
  }

  console.log("\nWhen the lender finally signs up, the debt they were owed finds them");
  {
    /*
     * Clear this phone's history first.
     *
     * The section ends by deleting this account, and deleting is refused while
     * any of its loans is still open - so a run that dies halfway (an OTP rate
     * limit, a dropped connection) leaves an open loan behind and *every* later
     * run fails at the last check for a reason that has nothing to do with the
     * code. Observed for real on 2026-10-14. Scratch database, hence raw SQL.
     */
    await query("DELETE FROM loans WHERE lender_mobile = $1 OR borrower_mobile = $1", [
      "9876500077",
    ]);

    // A loan the borrower recorded against a number nobody has used yet.
    const { id } = await newBorrowedLoan({
      lenderName: "Aunty Kamla",
      lenderMobile: "9876500077",
      amount: "4000",
      interestRate: "0",
      tenureMonths: "2",
      startDate: "2026-01-01",
      confirmationMode: "1-side",
    });

    /*
     * A number can only ask for ten OTPs a day (a real cap, added 2026-10-14),
     * and this section signs up the same number on every run - so clear that
     * number's OTP history first, or the eleventh run of the day meets its own
     * rate limit and reports a failure that says nothing about the code.
     */
    await query("DELETE FROM otps WHERE mobile = $1", ["9876500077"]);

    // The real signup path: ask for an OTP, then verify it. The dummy OTP
    // (123456) is the deployment's own testing mode, and this is exactly the
    // flow that has to attach the loan.
    const sent = await sendOtp("9876500077");
    check("the lender can ask for an OTP", sent.status, 200);
    check("...and in this mode the code comes back", String(sent.json.devCode ?? ""), "123456");

    const verified = await call("POST", "/api/auth/verify-otp", {
      body: { mobile: "9876500077", code: "123456", name: "Aunty Kamla" },
    });
    check("they can sign up", verified.status, 200);
    const lenderSession = verified.headers["set-cookie"]
      ?.match(/udhaar_session=([^;]+)/)?.[1];
    check("...and get a session", Boolean(lenderSession), true);

    const detail = await call("GET", `/api/loans/${id}`, { token: lenderSession });
    check("the loan they were owed is theirs now", detail.json.loan?.lenderId !== null, true);
    check("...without the borrower having to re-enter anything", detail.json.loan?.amount, "4000.00");
    check("...and it shows on their lending side", detail.json.loan?.viewerRole, "lender");

    const activity = await call("GET", "/api/notifications", { token: lenderSession });
    const notices = activity.json.notifications ?? [];
    check("they are told a debt was recorded for them",
      notices.some((n) => n.loanId === id && n.type === "loan_added"), true);
    check("...naming the borrower who wrote it down",
      notices.some((n) => String(n.message).includes("Settlement Test Borrower")), true);

    // Now that the lender exists, the borrower is answering to someone again:
    // no more forgiving their own debt.
    check("the borrower can no longer write it off",
      (await call("POST", `/api/loans/${id}/close`, { token: BORROWER_TOKEN, body: { writeOff: true } })).status, 403);
    check("the lender can settle it early, waiving what is left",
      (await call("POST", `/api/loans/${id}/payoff`, { token: lenderSession, body: { amount: "4000" } })).status, 200);

    // Leave the account in a state the next run can repeat: the loan is closed,
    // so the account can go.
    check("and the lender's account can then be deleted",
      (await call("DELETE", "/api/account", { token: lenderSession })).status, 200);
  }

  console.log(
    failures.length
      ? `\n\u2717 ${failures.length} check(s) failed, ${passed} passed`
      : `\n\u2713 all ${passed} settlement checks passed`
  );

  // A failure here is a wall of red in a CI log, and the log is not always
  // reachable - a job's log lives in storage a sandbox like ours cannot open,
  // while check-run annotations can be read with `gh api`. So publish each
  // failure as an annotation too.
  if (process.env.GITHUB_ACTIONS && failures.length) {
    for (const failure of failures) {
      const oneLine = (value) => JSON.stringify(value).slice(0, 180);
      console.log(`::error::${failure.label} - got ${oneLine(failure.got)}, wanted ${oneLine(failure.want)}`);
    }
  }

  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
