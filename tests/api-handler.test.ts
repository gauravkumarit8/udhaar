import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { withErrors } from "@/lib/api-handler";

/** withErrors only reads method + url, so a plain Request is enough. */
function req(path = "/api/test", method = "GET") {
  return new Request(`http://localhost${path}`, { method }) as unknown as NextRequest;
}

/** The shape Drizzle throws: a wrapper whose `cause` holds the pg error. */
function drizzleWrapped(code: string, message: string) {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new Error("Failed query: select 1\nparams: "), { cause });
}

describe("withErrors", () => {
  let logged: unknown[];

  beforeEach(() => {
    // Keep the expected error logs out of the test output.
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a successful response straight through", async () => {
    const handler = withErrors(async () => Response.json({ ok: true }, { status: 201 }));
    const res = await handler(req(), {});

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("turns a dead database into a 503 that says so", async () => {
    const handler = withErrors(async () => {
      throw drizzleWrapped("ENOTFOUND", "getaddrinfo ENOTFOUND db.example.invalid");
    });
    const res = await handler(req("/api/auth/send-otp", "POST"), {});
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toMatch(/can't reach its database/i);
    expect(body.action).toMatch(/api\/health/);
    expect(body.reference).toBeTruthy();
    // The user never sees the raw driver text or a stack trace.
    expect(JSON.stringify(body)).not.toContain("getaddrinfo");
    expect(JSON.stringify(body)).not.toContain("Failed query");
  });

  it("explains a refused connection differently from a bad host", async () => {
    const handler = withErrors(async () => {
      throw drizzleWrapped("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432");
    });
    const body = await (await handler(req(), {})).json();
    expect(body.error).toMatch(/connection refused/i);
  });

  it("explains missing tables as a migration problem", async () => {
    const handler = withErrors(async () => {
      throw drizzleWrapped("42P01", 'relation "users" does not exist');
    });
    const res = await handler(req(), {});
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.action).toMatch(/db:migrate/);
  });

  it("turns malformed JSON into a 400", async () => {
    const handler = withErrors(async () => {
      // What `await req.json()` throws on a broken body
      throw new SyntaxError("Unexpected end of JSON input");
    });
    const res = await handler(req("/api/loans", "POST"), {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Request body must be valid JSON." });
  });

  it("falls back to a generic 500 without leaking internals", async () => {
    const handler = withErrors(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    });
    const res = await handler(req(), {});
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Something went wrong on the server.");
    expect(JSON.stringify(body)).not.toContain("Cannot read properties");
  });

  it("still logs the real error for whoever runs the server", async () => {
    const handler = withErrors(async () => {
      throw drizzleWrapped("ENOTFOUND", "getaddrinfo ENOTFOUND db.example.invalid");
    });
    await handler(req(), {});

    expect(logged.length).toBe(1);
    expect(String(logged[0])).toContain("ENOTFOUND");
  });

  it("passes the params context through to dynamic routes", async () => {
    const handler = withErrors<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
      const { id } = await ctx.params;
      return Response.json({ id });
    });

    const res = await handler(req("/api/loans/123"), { params: Promise.resolve({ id: "123" }) });
    await expect(res.json()).resolves.toEqual({ id: "123" });
  });
});

/**
 * The net under a route that forgets to check its id.
 *
 * The seven routes that take an id in their path check it themselves and answer
 * 404 (see isUuid). This is what happens if a later one does not: Postgres
 * raises 22P02 and the client gets a 400 it can act on, not a 500 that reads
 * like an outage and fills the logs with database errors.
 */
describe("a malformed id reaching the database", () => {
  let logged: unknown[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 400, not 500", async () => {
    const handler = withErrors(async () => {
      throw drizzleWrapped("22P02", 'invalid input syntax for type uuid: "abc"');
    });

    const res = await handler(req(), {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reference?: string };
    expect(body.error).toMatch(/id/i);
    expect(body.error).not.toMatch(/went wrong/i);
    // Still logged, with the reference, so the cause stays findable.
    expect(body.reference).toBeTruthy();
    expect(logged.length).toBe(1);
  });
});
