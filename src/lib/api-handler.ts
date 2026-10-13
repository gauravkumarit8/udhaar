import type { NextRequest } from "next/server";

/**
 * Every API route wraps its handler in this so an unexpected failure still
 * produces a JSON body the UI can display.
 *
 * Without it, an unhandled error (a dead database, a bug) makes Next return an
 * empty 500. The browser then showed "Something went wrong" and the real cause
 * - "getaddrinfo ENOTFOUND <dead database host>" - was nowhere to be found.
 * That is exactly how a whole afternoon got spent debugging a production login
 * that only said "the server said no".
 *
 * Sensitive details are never leaked: driver errors are mapped to a short,
 * actionable message, and the full stack stays in the server logs.
 */

/** Shape of the params context Next passes to dynamic routes. */
type RouteContext = { params?: Promise<Record<string, string | string[]>> };

interface ErrorPayload {
  error: string;
  action?: string;
  reference?: string;
}

function rootError(error: unknown): { code?: string; message: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let best: { code?: string; message: string } | null = null;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: string; message?: string; errors?: unknown[]; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";

    if (message && !message.startsWith("Failed query:")) {
      best = { code: candidate.code, message };
      if (candidate.code) return best;
    }
    if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      current = candidate.errors[0];
      continue;
    }
    current = candidate.cause;
  }

  return best ?? { message: error instanceof Error ? error.message : String(error) };
}

function classify(error: unknown): { status: number; payload: ErrorPayload } {
  const { code = "", message } = rootError(error);

  // `await req.json()` on a malformed body throws a SyntaxError; that's the
  // client's fault, not the server's.
  if (error instanceof SyntaxError && /json/i.test(message)) {
    return { status: 400, payload: { error: "Request body must be valid JSON." } };
  }

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message) || code === "ENOTFOUND") {
    return {
      status: 503,
      payload: {
        error: "The server can't reach its database (the host in DATABASE_URL doesn't resolve).",
        action: "Open /api/health for the full check, or re-copy the database connection string.",
      },
    };
  }

  if (/ECONNREFUSED|ETIMEDOUT|Connection terminated|timeout expired/.test(message) || code === "ECONNREFUSED") {
    return {
      status: 503,
      payload: {
        error: "The server can't reach its database (connection refused).",
        action: "Open /api/health - on a free host the database is often deleted or still waking up.",
      },
    };
  }

  if (/password authentication failed|role .* does not exist/.test(message)) {
    return {
      status: 503,
      payload: {
        error: "The server's database credentials are wrong.",
        action: "Re-copy the connection string and update DATABASE_URL on the host.",
      },
    };
  }

  // 42703: a database that hasn't had the latest migration applied.
  if (code === "42703" || /column .* does not exist/.test(message)) {
    return {
      status: 503,
      payload: {
        error: "The database is missing a column this version of the app needs.",
        action:
          "Run npm run db:push against that database, or npm run db:baseline then npm run db:migrate (see /api/health).",
      },
    };
  }

  if (code === "42P01" || /relation .* does not exist/.test(message) || /database .* does not exist/.test(message)) {
    return {
      status: 503,
      payload: {
        error: "The database is missing its tables or the database itself.",
        action: "Run npm run db:migrate against that database (see /api/health).",
      },
    };
  }

  if (code === "23505") {
    return { status: 409, payload: { error: "That record already exists." } };
  }
  if (code === "23503") {
    return { status: 409, payload: { error: "That record references something that no longer exists." } };
  }

  return {
    status: 500,
    payload: {
      error: "Something went wrong on the server.",
      action: "Open /api/health to check the deployment, and try again.",
    },
  };
}

/**
 * Wraps a route handler. `handler(req, ctx)` keeps Next's usual signature, so
 * dynamic routes can still read `await ctx.params`.
 *
 * Usage:
 *   async function listLoans() { ... }
 *   export const GET = withErrors(listLoans);
 */
export function withErrors<C extends RouteContext = RouteContext>(
  handler: (req: NextRequest, ctx: C) => Promise<Response> | Response
) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      const { status, payload } = classify(error);
      const { message } = rootError(error);

      // The full error stays in the host logs - it just isn't sent to the
      // browser (stack traces and connection strings are not the user's
      // business).
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} failed:`, message);

      return Response.json(
        {
          ...payload,
          // Correlates a user-visible message with a log line.
          reference: new Date().toISOString(),
        },
        { status, headers: { "cache-control": "no-store" } }
      );
    }
  };
}
