/**
 * Answering a claim, from any of the three screens that offer it.
 *
 * All three send the same PATCH and must report it the same way, so the parsing
 * lives here. The cases that matter are the failures: the API's refusals are
 * specific and useful ("you can't confirm your own payment", "the EMI already
 * moved on") and replacing them with a generic apology would hide the one piece
 * of information that tells somebody what to do next.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { answerClaim } from "@/lib/claims";

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    ...response,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("answerClaim", () => {
  it("PATCHes the confirm route with the action", async () => {
    const spy = mockFetch({ ok: true });
    const result = await answerClaim("pay-1", "confirm");

    expect(result).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/payments/pay-1/confirm");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ action: "confirm" });
  });

  it("sends a rejection as a rejection", async () => {
    const spy = mockFetch({ ok: true });
    await answerClaim("pay-2", "reject");
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ action: "reject" });
  });

  it("passes the API's own refusal through instead of apologising", async () => {
    mockFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: "You cannot confirm your own payment" }),
    });

    const result = await answerClaim("pay-3", "confirm");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("You cannot confirm your own payment");
  });

  it("still says something useful when the body is not JSON", async () => {
    mockFetch({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });

    const result = await answerClaim("pay-4", "confirm");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("reports a network failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const result = await answerClaim("pay-5", "confirm");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network/i);
  });
});
