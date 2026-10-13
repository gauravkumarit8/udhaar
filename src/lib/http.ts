/**
 * Client-side API helpers.
 *
 * The old pattern was `const data = await res.json(); if (data.error) ...`,
 * which threw on any non-JSON response (a 500 renders Next.js's HTML error
 * page) and landed in a bare `catch` that showed "Something went wrong".
 * A dead database therefore looked like a UI bug, and the real reason was
 * invisible. These helpers always produce a message worth showing.
 */

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

interface ErrorBody {
  error?: string;
  action?: string;
  firstProblem?: string;
}

function fallbackMessage(status: number, body: ErrorBody | null, rawText: string): string {
  if (body?.error) return body.error;
  if (body?.action) return body.action;

  if (status === 0) return "Network error — you may be offline.";
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That record no longer exists.";
  if (status === 429) return "Too many attempts. Please wait a moment and try again.";
  if (status >= 500) {
    // Point at the health endpoint, which now explains itself.
    return `The server couldn't complete that request (HTTP ${status}). Open /api/health to see what's misconfigured.`;
  }

  // Last resort: a short, safe slice of whatever came back.
  const snippet = rawText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return snippet ? `Unexpected response: ${snippet}` : `Request failed (HTTP ${status}).`;
}

/** Reads a Response without ever throwing on a non-JSON body. */
export async function readApi<T = unknown>(res: Response): Promise<ApiResult<T>> {
  const rawText = await res.text().catch(() => "");

  let body: unknown = null;
  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }
  }

  const errorBody = (body ?? null) as ErrorBody | null;
  const payload = body as T | null;
  const hasError = Boolean(errorBody && typeof errorBody === "object" && errorBody.error);

  if (res.ok && !hasError) {
    return { ok: true, status: res.status, data: payload };
  }

  return {
    ok: false,
    status: res.status,
    data: payload,
    error: fallbackMessage(res.status, errorBody, rawText),
  };
}

/** fetch + readApi in one call - keeps call sites short. */
export async function requestJson<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(input, init);
    return await readApi<T>(res);
  } catch {
    return { ok: false, status: 0, data: null, error: "Network error — you may be offline." };
  }
}
