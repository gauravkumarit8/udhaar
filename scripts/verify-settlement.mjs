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
    failures.push(label);
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

async function main() {
  const ping = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!ping) {
    console.error(`Nothing is answering at ${BASE_URL}. Start the app first (npm run dev).`);
    process.exit(1);
  }

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

    const board = await call("GET", "/api/dashboard", { token: LENDER_TOKEN });
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

    // The badge and the feed must agree about what is unread.
    const badge = await call("GET", "/api/notifications?summary=1", { token: BORROWER_TOKEN });
    const feed = await call("GET", "/api/notifications", { token: BORROWER_TOKEN });
    check("the badge count is a number", typeof badge.json.unread, "number");
    check("...and matches the feed's own count", badge.json.unread, feed.json.unread);
  }

  console.log("\nWhen the lender finally signs up, the debt they were owed finds them");
  {
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

    // The real signup path: ask for an OTP, then verify it. The dummy OTP
    // (123456) is the deployment's own testing mode, and this is exactly the
    // flow that has to attach the loan.
    const sent = await call("POST", "/api/auth/send-otp", { body: { mobile: "9876500077" } });
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
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
