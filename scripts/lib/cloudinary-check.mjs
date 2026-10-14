/**
 * Is Cloudinary actually *working*, not just configured?
 *
 * `check-deploy` used to say "Cloudinary configured" whenever the three
 * environment variables were non-empty - which is exactly the state you are in
 * when you have pasted a wrong API secret. The first proof upload then failed
 * with a 502, and the reason (a rejected credential) only appeared in the
 * response to a user who was mid-payment.
 *
 * So this module makes one read-only, signed Admin API request and turns the
 * answer into something a human can act on. It is split out from the script so
 * the interpretation - which status means "your credentials are wrong" versus
 * "this machine cannot reach Cloudinary" - is unit-tested rather than
 * discovered in production.
 *
 * Deliberately read-only: listing one resource needs no upload, creates
 * nothing, and costs nothing.
 */

export const CLOUDINARY_API_BASE = "https://api.cloudinary.com";

/**
 * Decide what an attempt to reach Cloudinary means.
 *
 * `level` is what the caller should print:
 *   - "ok"   credentials are good
 *   - "warn" cannot be determined from here (network, rate limit, restriction)
 *           - or nothing is configured, which is fine
 *   - "fail" the credentials are demonstrably wrong
 *
 * Being careful about "fail": a 401 means the key/secret pair was refused, no
 * matter where you run this from. Everything less certain - a 403 (the key may
 * be restricted to upload endpoints), a 5xx, a firewall - must not tell someone
 * their working setup is broken.
 */
export function interpretCloudinaryCheck({ status, cloudName, error } = {}) {
  if (error) {
    const message = typeof error === "string" ? error : error.message || String(error);
    return {
      level: "warn",
      detail: `could not reach Cloudinary from here (${message}) — credentials were not verified`,
      hint: "If this is your own machine, a firewall or proxy may be blocking api.cloudinary.com; proof uploads still work when the server can reach it.",
    };
  }

  if (status === 200) {
    return {
      level: "ok",
      detail: `credentials work — a signed request to cloud "${cloudName}" was accepted`,
    };
  }

  if (status === 401) {
    return {
      level: "fail",
      detail: "Cloudinary rejected the credentials (401)",
      hint: "CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are wrong or were rotated. Copy them again from Cloudinary → Settings → API Keys (the API secret is not your account password).",
    };
  }

  if (status === 403) {
    return {
      level: "warn",
      detail: "Cloudinary accepted the account but refused this request (403)",
      hint: "The key may be restricted to upload endpoints, in which case proofs still work. Check Settings → API Keys if uploads fail too.",
    };
  }

  if (status === 404) {
    return {
      level: "fail",
      detail: `no Cloudinary cloud named "${cloudName}" (404)`,
      hint: "CLOUDINARY_CLOUD_NAME must be the cloud name at the top of the Cloudinary dashboard, not the account email or the API key.",
    };
  }

  if (status === 429) {
    return {
      level: "warn",
      detail: "Cloudinary rate-limited this check (429) — credentials were not verified",
      hint: "Nothing to fix; try again in a minute.",
    };
  }

  if (typeof status === "number" && status >= 500) {
    return {
      level: "warn",
      detail: `Cloudinary returned ${status} — credentials were not verified`,
      hint: "Cloudinary was having a bad moment; try again shortly.",
    };
  }

  return {
    level: "warn",
    detail: `unexpected response from Cloudinary (${status ?? "no status"}) — credentials were not verified`,
  };
}

/**
 * One signed, read-only request to the Cloudinary Admin API.
 *
 * Basic auth with the API key and secret is the documented scheme for the
 * Admin API; nothing here uploads, lists more than one row, or mutates state.
 *
 * `apiBase` exists so tests can point this at a local server (or a closed
 * port) instead of the real internet.
 */
export async function verifyCloudinaryCredentials({
  cloudName,
  apiKey,
  apiSecret,
  apiBase = CLOUDINARY_API_BASE,
  timeoutMs = 10_000,
} = {}) {
  if (!cloudName || !apiKey || !apiSecret) {
    return { level: "warn", detail: "Cloudinary is not configured" };
  }

  const url = `${apiBase}/v1_1/${encodeURIComponent(cloudName)}/resources/image?max_results=1`;
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const result = interpretCloudinaryCheck({ status: response.status, cloudName });
    if (result.level === "warn" && response.status !== 200) {
      // A 403 from a restricted key is worth distinguishing from a 500.
      try {
        const body = await response.json();
        const message = body?.error?.message;
        if (message) result.raw = message;
      } catch {
        /* body is optional */
      }
    }
    return result;
  } catch (error) {
    return interpretCloudinaryCheck({ cloudName, error });
  }
}
