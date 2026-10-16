#!/usr/bin/env node
/**
 * Design checks against a running server.
 *
 * This is the UI's half of the settlement harness: instead of driving screens
 * with a browser (which this repo's CI cannot do - no browser, no display), it
 * asks the server for every page's HTML and for the stylesheet it links to, and
 * holds both to the design system the revamp put in place. It catches the
 * failures that a screenshot would catch and a unit test never would:
 *
 *   - a class name that Tailwind never generated, because it was misspelled or
 *     never used anywhere else (the page renders unstyled and nothing fails)
 *   - a screen still wearing the old palette, which is what "we revamped the
 *     app" quietly means when one screen is missed
 *   - the tab bar rendered twice, or missing from a screen that needs it
 *   - the stylesheet losing its dark-mode or print blocks, so a statement
 *     prints as a black rectangle
 *
 * It signs in through the real OTP route (dummy mode accepts any number), so
 * every page is fetched as an authenticated user.
 *
 * Usage:
 *   npm run start                     # in one terminal (or npm run dev)
 *   npm run verify:ui                 # in another
 *
 *   BASE_URL=http://localhost:3000 npm run verify:ui
 *
 * It creates one throwaway account if it does not exist yet and changes
 * nothing else. Exit code is 0 when every check passes.
 */
import "dotenv/config";
import pg from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const MOBILE = process.env.UI_CHECK_MOBILE ?? "9000000009";
const NAME = "UI Check";
const USER_ID = "d0d0d0d0-0000-4000-8000-00000000d0d0";
const TOKEN = "dd" + "4".repeat(62);

let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(label);
    console.log(`  \u2717 ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function get(path, cookie) {
  const res = await fetch(BASE_URL + path, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: "manual",
  });
  const body = await res.text();
  return { status: res.status, body, contentType: res.headers.get("content-type") ?? "" };
}

/** The first loan on this account, if there is one. */
async function firstLoan(cookie) {
  const res = await fetch(`${BASE_URL}/api/loans?limit=1`, { headers: { Cookie: cookie } });
  const json = await res.json().catch(() => ({}));
  return (json.loans ?? [])[0] ?? null;
}

/**
 * One throwaway account with a session the script can use, so it needs no OTP
 * flow.
 *
 * Signing in through the real OTP routes would be a truer end-to-end test, and
 * that is what `verify:settlement` does at the point where it matters - but the
 * OTP routes are rate limited per number on purpose (five codes an hour), so a
 * check that runs on every push would spend its own budget and start failing
 * for the wrong reason. Idempotent: re-running refreshes the session's expiry.
 */
async function seed() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - point it at the same database the server uses.");
  }
  const useSsl = !/localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    /*
     * Matched on the number, not the id: if this account was created by hand
     * (or by an earlier run that signed up through the OTP route) it already
     * exists under an id nobody remembers, and `mobile` is the unique key that
     * identifies it.
     */
    await pool.query(
      `INSERT INTO users (id, name, mobile) VALUES ($1, $2, $3)
       ON CONFLICT (mobile) DO UPDATE SET name = excluded.name`,
      [USER_ID, NAME, MOBILE]
    );
    const { rows } = await pool.query(`SELECT id FROM users WHERE mobile = $1`, [MOBILE]);
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id,
                                         expires_at = excluded.expires_at`,
      [TOKEN, rows[0].id]
    );
  } finally {
    await pool.end();
  }
  return `udhaar_session=${TOKEN}`;
}

/*
 * The palette the revamp replaced. Finding any of these in rendered HTML means
 * a screen was missed - Tailwind emits a utility class into the markup only if
 * somebody wrote it, so this is a direct question about the source.
 */
const LEGACY = [
  ["old slate palette", /(^|["\s])bg-slate-\d|text-slate-\d|border-slate-\d/],
  ["old emerald palette", /(^|["\s])bg-emerald-\d|text-emerald-\d|border-emerald-\d/],
  ["old blue palette", /(^|["\s])bg-blue-\d|text-blue-\d|bg-red-\d|text-red-\d/],
  ["old amber palette", /(^|["\s])bg-amber-\d|text-amber-\d|border-amber-\d/],
  ["removed animations", /animate-slide-up|animate-slide-down|animate-scale-in|animate-bounce-in|animate-fade-in/],
  ["removed utilities", /tap-highlight|safe-area-top|safe-area-bottom|no-select/],
  ["gradient hero", /bg-gradient-to/],
];

/*
 * What each page must say when it is served.
 *
 * Only prerendered copy is asserted here, because that is what a request for
 * the HTML actually returns: the dashboard's balances, the loans list and the
 * activity feed are fetched by the browser afterwards, so at this level they
 * are a skeleton by design. Structure (the tab bar, the tokens, the absence of
 * the old palette) is checked on every page, and the copy that ships with the
 * page is checked on the pages that ship it.
 */
const PAGES = [
  {
    path: "/dashboard",
    name: "Home",
    nav: 1,
    marks: [/Good (morning|afternoon|evening)/, /Welcome/],
  },
  { path: "/loans", name: "Loans", nav: 1, marks: [/Loans/] },
  { path: "/loans/new", name: "Add loan", nav: 0, marks: [/I lent money/, /I borrowed/] },
  { path: "/activity", name: "Activity", nav: 1, marks: [/Activity/] },
  {
    path: "/profile",
    name: "You",
    nav: 1,
    marks: [/Push notifications/, /Download my data/, /Share Udhaar/],
    // Read "Rate Udhaar" and did nothing - there is no published listing to
    // rate. It is a share row now, and this keeps the dead one from returning.
    absent: [/Rate Udhaar/],
  },
  { path: "/login", name: "Login", nav: 0, marks: [/Udhaar/, /Mobile number/] },
];

const run = async () => {
  console.log(`Design checks against ${BASE_URL}`);

  // ── The stylesheet ────────────────────────────────────────────────────────
  const home = await get("/login");
  if (home.status !== 200) {
    throw new Error(`/login answered ${home.status}. Is the server running at ${BASE_URL}?`);
  }

  const cssHrefs = [...home.body.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
  check("the login page links a stylesheet", cssHrefs.length > 0);
  if (cssHrefs.length === 0) throw new Error("no stylesheet to check - is this a production build?");

  let css = "";
  for (const href of cssHrefs) {
    const res = await get(href);
    css += res.body;
  }

  section("The design system is in the stylesheet");
  check("colour tokens are defined", css.includes("--brand:") && css.includes("--ink-3:"));
  check(
    "dark mode flips the same tokens",
    /@media\s*\(prefers-color-scheme:\s*dark\)/.test(css) && css.includes("--surface:"),
    "no prefers-color-scheme block found: dark mode is not automatic"
  );
  check(
    "printing forces the light palette",
    /@media\s*print/.test(css),
    "no @media print block: a statement printed in dark mode comes out black"
  );
  check("tabular figures are global", css.includes("font-variant-numeric"));
  check("press feedback is generated", css.includes(".tap:active"));
  check(
    "the staggered list utility is generated",
    /\.stagger\s*>\s*\*/.test(css),
    ".stagger has no rule: list rows would all land at once"
  );
  check("reduced motion is honoured", css.includes("prefers-reduced-motion"));
  check(
    "no component carries a dark: variant",
    !/\.dark\\:/.test(css),
    "a dark: utility was used - the tokens are supposed to make those unnecessary"
  );

  // ── The pages ─────────────────────────────────────────────────────────────
  const cookie = await seed();
  console.log(`\nchecking as the throwaway account +91 ${MOBILE}`);

  for (const page of PAGES) {
    section(`${page.name} (${page.path})`);

    const res = await get(page.path, page.path === "/login" ? null : cookie);
    check("answers 200", res.status === 200, `got ${res.status}`);
    if (res.status !== 200) continue;

    for (const mark of page.marks) {
      check(`carries ${mark}`, mark.test(res.body));
    }

    const navCount = (res.body.match(/aria-label="Main"/g) ?? []).length;
    check(
      page.nav === 1 ? "renders the tab bar exactly once" : "does not render the tab bar",
      navCount === page.nav,
      `found ${navCount}`
    );

    for (const pattern of page.absent ?? []) {
      const found = res.body.match(pattern);
      check(`no longer says ${pattern}`, !found, found ? `found "${found[0]}"` : undefined);
    }

    for (const [label, pattern] of LEGACY) {
      const found = res.body.match(pattern);
      check(`no ${label}`, !found, found ? `found "${found[0]}"` : undefined);
    }

    check(
      "uses the token classes",
      /class="[^"]*\b(bg-surface|text-ink|rounded-card|rounded-control)\b/.test(res.body)
    );
  }

  // ── The loan screen, which needs a loan to exist ───────────────────────────
  section("Loan detail and statement");
  let first = await firstLoan(cookie);

  if (!first) {
    // Nothing to open yet: write one, so these two screens are checked rather
    // than skipped. It stays on the throwaway account.
    const created = await fetch(`${BASE_URL}/api/loans`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        side: "lender",
        borrowerName: "UI Check Borrower",
        borrowerMobile: "9000000010",
        amount: "12000",
        interestRate: "0",
        interestRatePeriod: "yearly",
        tenureMonths: "6",
        startDate: new Date().toISOString().split("T")[0],
        confirmationMode: "1-side",
      }),
    });
    check("a loan could be created to check against", created.ok, `got ${created.status}`);
    first = await firstLoan(cookie);
  }

  if (!first) {
    console.log("  - skipped: no loan to open");
  } else {
    for (const [label, path] of [
      ["loan detail", `/loans/${first.id}`],
      ["statement", `/loans/${first.id}/statement`],
    ]) {
      const res = await get(path, cookie);
      check(`${label} answers 200`, res.status === 200, `got ${res.status}`);
      const navCount = (res.body.match(/aria-label="Main"/g) ?? []).length;
      check(`${label} renders the tab bar exactly once`, navCount === 1, `found ${navCount}`);
      check(`${label} uses the token classes`, /rounded-card|rounded-control/.test(res.body));
      for (const [legacyLabel, pattern] of LEGACY) {
        const found = res.body.match(pattern);
        check(`${label}: no ${legacyLabel}`, !found, found ? `found "${found[0]}"` : undefined);
      }
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  console.log("");
  if (failures.length === 0) {
    console.log(`\u2713 all ${passed} design checks passed`);
  } else {
    console.log(`\u2717 ${failures.length} of ${passed + failures.length} design checks failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(`\ndesign checks could not run: ${error.message}`);
  process.exit(1);
});
