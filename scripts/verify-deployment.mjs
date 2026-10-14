#!/usr/bin/env node
/**
 * Is the deploy actually done?
 *
 * A green deploy job means "the code was built and a host was told about it",
 * not "the new code is answering" - and definitely not "the database behind it
 * is the one this code needs". On 2026-10-14 both of those were untrue while
 * every workflow on main was green: the release was live and its migration had
 * never been applied, so every loan screen answered 503 until it was fixed by
 * hand.
 *
 * This script is the missing last step. It polls `/api/health` on the deployed
 * app until it answers *healthy* AND reports the commit that was just released,
 * and it fails - in the workflow, where it is visible - when that does not
 * happen in time, printing the app's own explanation (`firstProblem` + the
 * `action` telling you how to fix it).
 *
 * Usage:
 *   PRODUCTION_URL=https://example.onrender.com EXPECTED_SHA=$(git rev-parse HEAD) \
 *     node scripts/verify-deployment.mjs
 *
 *   BASE_URL / TIMEOUT_MS / POLL_MS also work as names, so this can be pointed
 *   at a local server while you are testing it.
 *
 * Exit code 0 = the released commit is live and healthy.
 */
const BASE_URL = (
  process.env.PRODUCTION_URL ??
  process.env.BASE_URL ??
  "http://localhost:3000"
).replace(/\/+$/, "");
const EXPECTED_SHA = (process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "").trim();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 12 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS ?? 15 * 1000);
/** Escape hatch: accept a healthy deploy that cannot name its commit. */
const ALLOW_UNSTAMPED = /^(1|true|yes)$/i.test(process.env.ALLOW_UNSTAMPED ?? "");

const started = Date.now();

function elapsed() {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function say(message) {
  console.log(`[${elapsed()}] ${message}`);
}

function fail(message) {
  console.error(`\n::error::${message}`);
  process.exit(1);
}

function explain(health) {
  const problem = health.firstProblem
    ? health.checks?.find((c) => c.name === health.firstProblem)
    : health.checks?.find((c) => c.status === "fail");
  if (!problem) return "the app did not say why";
  return `${problem.name}: ${problem.detail}${problem.fix ? ` → ${problem.fix}` : ""}`;
}

async function readHealth() {
  const res = await fetch(`${BASE_URL}/api/health`, {
    headers: { "cache-control": "no-cache", "user-agent": "udhaar-deploy-verifier" },
    signal: AbortSignal.timeout(20_000),
  });
  // A failing health check answers 503 *with a body* - that body is the reason.
  try {
    return { status: res.status, health: await res.json() };
  } catch {
    return { status: res.status, health: null };
  }
}

console.log(
  `Checking ${BASE_URL} for ${EXPECTED_SHA ? `commit ${EXPECTED_SHA.slice(0, 7)}` : "a healthy build"} ` +
    `(up to ${Math.round(TIMEOUT_MS / 1000)}s)`
);

let lastWord = "";
let sawHealthyWrongCommit = false;

while (Date.now() - started < TIMEOUT_MS) {
  let result;
  try {
    result = await readHealth();
  } catch (error) {
    // The app is not answering yet: the host may still be rolling the new
    // container out, which is exactly what this loop is for.
    const message = `no answer yet (${error instanceof Error ? error.cause?.message ?? error.message : error})`;
    if (message !== lastWord) say(message);
    lastWord = message;
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }

  const { status, health } = result;
  if (!health) {
    say(`answer was not JSON (HTTP ${status}) - still waiting`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }

  const commit = typeof health.commit === "string" ? health.commit : null;
  const word = `HTTP ${status} · ok=${health.ok} · commit=${commit ? commit.slice(0, 7) : "unknown"}`;

  if (!health.ok) {
    // Print the reason once, then keep polling: a brand-new container may be
    // up before its migration has landed.
    if (word !== lastWord) {
      say(`${word} · ${explain(health)}`);
      lastWord = word;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }

  // Healthy. Is it *our* build?
  if (!EXPECTED_SHA) {
    say(`${word} - healthy, and no commit was given to match against`);
    console.log("\n✓ the deployed app reports healthy");
    process.exit(0);
  }

  if (!commit) {
    // Healthy but anonymous. This is a failure by default: on 2026-10-14 a
    // release reported exactly this and the tick went green while the app was
    // still serving the previous build - the release was never verified at all.
    const why =
      "the app is healthy but cannot say which commit it is running. " +
      "Set RENDER_GIT_COMMIT (Render does this itself on services it builds) or build the " +
      "image with --build-arg GIT_SHA, which the Dockerfile now bakes in as GIT_COMMIT. " +
      "Until the deployed app can name its commit, no deploy can be told apart from the one before it.";
    if (ALLOW_UNSTAMPED) {
      say(`${word} - healthy, but the app cannot say which commit it is`);
      console.log(`\n::warning::ALLOW_UNSTAMPED=1 - ${why}`);
      console.log("\n✓ the deployed app reports healthy (commit unverified)");
      process.exit(0);
    }
    fail(`${word} - ${why}`);
  }

  if (commit.startsWith(EXPECTED_SHA) || EXPECTED_SHA.startsWith(commit)) {
    say(`${word} - that is the released commit`);
    console.log("\n✓ the released commit is live and healthy");
    process.exit(0);
  }

  if (!sawHealthyWrongCommit) {
    say(`${word} - healthy, but that is not this release - waiting for the rollout`);
    sawHealthyWrongCommit = true;
  }
  lastWord = word;
  await new Promise((r) => setTimeout(r, POLL_MS));
}

// Out of time. Ask once more so the failure message is current, not stale.
say("timed out");
try {
  const { status, health } = await readHealth();
  if (!health) {
    fail(`${BASE_URL} is not answering with a health report (HTTP ${status}).`);
  }
  if (!health.ok) {
    fail(`the deployed app reports a problem: ${explain(health)}`);
  }
  fail(
    `the app is healthy but still serving ${health.commit ? health.commit.slice(0, 7) : "an unknown commit"}; ` +
      `this release (${EXPECTED_SHA.slice(0, 7)}) never became live. Check the host's deploy log.`
  );
} catch (error) {
  fail(`${BASE_URL} could not be reached: ${error instanceof Error ? error.message : error}`);
}
