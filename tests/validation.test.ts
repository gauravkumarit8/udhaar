import { describe, it, expect, afterEach } from "vitest";
import {
  parseLoanInput,
  validateProofUrl,
  validateProofId,
  toNumber,
  isValidDateString,
  LIMITS,
} from "@/lib/validation";
import { readApi, requestJson } from "@/lib/http";

/** A valid create-loan body, so each test only changes what it's testing. */
function validLoan(overrides: Record<string, unknown> = {}) {
  return {
    borrowerName: "Amit Sharma",
    borrowerMobile: "9876543210",
    amount: "50000",
    interestRate: "12",
    interestRatePeriod: "yearly",
    tenureMonths: "12",
    startDate: "2026-07-15",
    ...overrides,
  };
}

describe("parseLoanInput", () => {
  it("accepts a well-formed loan and normalises the numbers", () => {
    const result = parseLoanInput(validLoan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.amount).toBe(50000);
    expect(result.value.interestRate).toBe(12);
    expect(result.value.tenureMonths).toBe(12);
    expect(result.value.interestRatePeriod).toBe("yearly");
    expect(result.value.confirmationMode).toBe("1-side");
    expect(result.value.notes).toBeNull();
  });

  it("treats an omitted interest rate as an interest-free loan", () => {
    const result = parseLoanInput(validLoan({ interestRate: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.interestRate).toBe(0);
  });

  // The original bug: parseFloat("abc") is NaN, and `NaN <= 0` is false,
  // so garbage slipped past validation and reached the numeric column.
  it.each(["abc", "", " ", "12abc", "1e999", {}])(
    "rejects a non-numeric amount (%j)",
    (amount) => {
      const result = parseLoanInput(validLoan({ amount }));
      expect(result.ok).toBe(false);
    }
  );

  it("rejects a non-numeric tenure", () => {
    expect(parseLoanInput(validLoan({ tenureMonths: "abc" })).ok).toBe(false);
  });

  it("rejects zero, negative and fractional amounts", () => {
    expect(parseLoanInput(validLoan({ amount: "0" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ amount: "-500" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ amount: "100.555" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ amount: "100.55" })).ok).toBe(true);
  });

  it("caps the amount instead of overflowing numeric(12,2)", () => {
    const result = parseLoanInput(validLoan({ amount: "9999999999999" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too large/i);
  });

  it("rejects a negative interest rate and an absurd one", () => {
    expect(parseLoanInput(validLoan({ interestRate: "-5" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ interestRate: "5000" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ interestRate: "0" })).ok).toBe(true);
    expect(parseLoanInput(validLoan({ interestRate: String(LIMITS.INTEREST_RATE_MAX) })).ok).toBe(true);
  });

  // 100 million monthly installments would be generated row by row.
  it("caps the tenure so the schedule can't be weaponised", () => {
    const result = parseLoanInput(validLoan({ tenureMonths: "100000000" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too long/i);

    expect(parseLoanInput(validLoan({ tenureMonths: "0" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ tenureMonths: "-12" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ tenureMonths: "600" })).ok).toBe(true);
    expect(parseLoanInput(validLoan({ tenureMonths: "601" })).ok).toBe(false);
  });

  it("rejects impossible or malformed start dates", () => {
    expect(parseLoanInput(validLoan({ startDate: "2026-02-30" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ startDate: "2026-13-01" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ startDate: "15/07/2026" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ startDate: "garbage" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ startDate: "2024-02-29" })).ok).toBe(true); // leap year
    expect(parseLoanInput(validLoan({ startDate: "2026-02-28" })).ok).toBe(true);
  });

  it("keeps the 10-digit mobile rule so accounts still auto-link", () => {
    expect(parseLoanInput(validLoan({ borrowerMobile: "+91 98765 43210" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ borrowerMobile: "9876" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ borrowerMobile: "" })).ok).toBe(false);
  });

  it("requires a borrower name", () => {
    expect(parseLoanInput(validLoan({ borrowerName: "   " })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ borrowerName: "x".repeat(101) })).ok).toBe(false);
  });

  it("rejects unknown enum values instead of guessing", () => {
    expect(parseLoanInput(validLoan({ interestRatePeriod: "weekly" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ confirmationMode: "3-side" })).ok).toBe(false);
    expect(parseLoanInput(validLoan({ confirmationMode: "2-side" })).ok).toBe(true);
  });

  it("rejects non-object bodies", () => {
    expect(parseLoanInput(null).ok).toBe(false);
    expect(parseLoanInput("hello").ok).toBe(false);
  });
});

describe("validateProofUrl", () => {
  afterEach(() => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
  });

  it("accepts https links and treats empty input as no proof", () => {
    expect(validateProofUrl("https://example.com/receipt.jpg")).toEqual({
      ok: true,
      value: "https://example.com/receipt.jpg",
    });
    expect(validateProofUrl(undefined)).toEqual({ ok: true, value: null });
    expect(validateProofUrl("")).toEqual({ ok: true, value: null });
  });

  // A proof link is rendered as a clickable link for the other party.
  it("blocks script and data URLs", () => {
    expect(validateProofUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateProofUrl("data:image/svg+xml;base64,PHN2Zz4=").ok).toBe(false);
    expect(validateProofUrl("http://example.com/receipt.jpg").ok).toBe(false);
    expect(validateProofUrl("not a url").ok).toBe(false);
  });

  it("blocks oversized links", () => {
    expect(validateProofUrl(`https://example.com/${"a".repeat(600)}`).ok).toBe(false);
  });

  it("pins uploads to the app's own Cloudinary account when configured", () => {
    process.env.CLOUDINARY_CLOUD_NAME = "udhaar-app";

    expect(
      validateProofUrl("https://res.cloudinary.com/udhaar-app/image/upload/v1/udhaar/proofs/a.jpg").ok
    ).toBe(true);
    // Someone else's account, or a lookalike host
    expect(
      validateProofUrl("https://res.cloudinary.com/attacker/image/upload/v1/a.jpg").ok
    ).toBe(false);
    expect(validateProofUrl("https://res.cloudinary.com.evil.com/a.jpg").ok).toBe(false);
    expect(validateProofUrl("https://example.com/a.jpg").ok).toBe(false);
  });
});

describe("helpers", () => {
  it("toNumber rejects trailing garbage that parseFloat accepts", () => {
    expect(toNumber("50000")).toBe(50000);
    expect(toNumber(" 12.50 ")).toBe(12.5);
    expect(toNumber("-3")).toBe(-3);
    expect(toNumber("12abc")).toBeNull(); // parseFloat would return 12
    expect(toNumber("")).toBeNull();
    expect(toNumber("Infinity")).toBeNull();
    expect(toNumber(NaN)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it("isValidDateString round-trips real calendar dates", () => {
    expect(isValidDateString("2026-10-13")).toBe(true);
    expect(isValidDateString("2026-2-3")).toBe(false);
    expect(isValidDateString("2026-04-31")).toBe(false);
  });
});

describe("readApi", () => {
  it("returns the parsed body on success", async () => {
    const res = Response.json({ loan: { id: "abc" } });
    const result = await readApi<{ loan: { id: string } }>(res);
    expect(result.ok).toBe(true);
    expect(result.data?.loan.id).toBe("abc");
  });

  it("surfaces the server's error field", async () => {
    const res = Response.json({ error: "Amount looks too large" }, { status: 400 });
    const result = await readApi(res);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Amount looks too large");
  });

  // This is the login-page bug: a Next.js HTML error page made res.json()
  // throw, so every failure showed "Something went wrong".
  it("does not throw on an HTML error page and still explains it", async () => {
    const res = new Response("<!DOCTYPE html><html><body><h1>Internal Server Error</h1></body></html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
    const result = await readApi(res);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 500");
    expect(result.error).toContain("/api/health");
    expect(result.error).not.toContain("<h1>");
  });

  it("explains known status codes", async () => {
    expect((await readApi(new Response("", { status: 401 }))).error).toMatch(/session has expired/i);
    expect((await readApi(new Response("", { status: 429 }))).error).toMatch(/too many attempts/i);
  });

  it("reports a network failure from requestJson instead of throwing", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("boom"))) as typeof fetch;
    try {
      const result = await requestJson("/api/dashboard");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.error).toMatch(/offline/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("validateProofId", () => {
  it("accepts an id produced by our own upload route", () => {
    const result = validateProofId("udhaar/proofs/abc123.jpg");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("udhaar/proofs/abc123.jpg");
  });

  it("treats a missing id as 'no proof' rather than an error", () => {
    for (const value of [undefined, null, ""]) {
      const result = validateProofId(value);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    }
  });

  it("rejects anything that is not one of our asset ids", () => {
    const bad = [
      "https://evil.example.com/tracker.jpg", // a URL, not an id
      "udhaar/proofs/../../etc/passwd",
      "other-folder/proofs/abc.jpg", // wrong folder
      "udhaar/proofs/a b.jpg", // whitespace inside
      "udhaar/proofs/abc.jpg?x=1", // query string
      "udhaar/proofs/abc.jpg#frag",
      "udhaar/proofs/abc;rm -rf.jpg",
    ];
    for (const value of bad) {
      expect(validateProofId(value).ok, value).toBe(false);
    }
  });

  it("rejects non-strings and absurdly long ids", () => {
    expect(validateProofId(42).ok).toBe(false);
    expect(validateProofId({}).ok).toBe(false);
    expect(validateProofId("udhaar/proofs/" + "a".repeat(LIMITS.PROOF_ID_MAX)).ok).toBe(false);
  });
});
