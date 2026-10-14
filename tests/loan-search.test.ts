import { describe, expect, it } from "vitest";
import { likePattern, parseLoanQuery, SEARCH_MAX_LENGTH } from "@/lib/loan-search";

/**
 * The search box, on its way to SQL.
 *
 * Two things are being pinned here. The dull one: a person's typing gets
 * normalised (trim, collapse, cap) so a query string cannot carry a megabyte of
 * spaces into the database. The sharp one: `%` and `_` are LIKE operators, so a
 * search for `%` must look for a percent sign, not match every loan recorded.
 */
const params = (query: string) => new URLSearchParams(query);

describe("parseLoanQuery", () => {
  it("defaults to everything, unfiltered", () => {
    expect(parseLoanQuery(params(""))).toEqual({ q: "", status: "all", role: "all" });
  });

  it("reads a search, a status and a role", () => {
    expect(parseLoanQuery(params("q=Sunita&status=active&role=lender"))).toEqual({
      q: "Sunita",
      status: "active",
      role: "lender",
    });
  });

  it("tidies what was typed", () => {
    expect(parseLoanQuery(params("q=%20%20Sunit%20%20%20Devi%20")).q).toBe("Sunit Devi");
    expect(parseLoanQuery(params("q=shop%09stock")).q).toBe("shop stock");
  });

  it("caps the search at a length worth running", () => {
    const long = "a".repeat(SEARCH_MAX_LENGTH + 500);
    expect(parseLoanQuery(params(`q=${long}`)).q).toBe("a".repeat(SEARCH_MAX_LENGTH));
  });

  it("turns control characters into spaces, not into SQL", () => {
    // A pasted newline should read as a word break; a NUL byte should not reach
    // the driver at all.
    expect(parseLoanQuery(params("q=shop%0Astock")).q).toBe("shop stock");
    expect(parseLoanQuery(params("q=Ra%00mesh")).q).toBe("Ra mesh");
  });

  it("treats an unknown chip as 'all' rather than erroring", () => {
    expect(parseLoanQuery(params("status=deleted&role=cosigner"))).toEqual({
      q: "",
      status: "all",
      role: "all",
    });
    expect(parseLoanQuery(params("status=ACTIVE")).status).toBe("active");
    expect(parseLoanQuery(params("role=Borrower")).role).toBe("borrower");
  });
});

describe("likePattern", () => {
  it("wraps the search in wildcards so it matches anywhere in the field", () => {
    expect(likePattern("Sunita")).toBe("%Sunita%");
  });

  it("treats LIKE operators in the search as text", () => {
    // Without this, `%` matches every loan on the account.
    expect(likePattern("%")).toBe("%\\%%");
    expect(likePattern("_")).toBe("%\\_%");
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
  });

  it("escapes the escape character itself", () => {
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });

  it("has no wildcard of its own outside the wrap", () => {
    expect(likePattern("")).toBe("%%");
  });
});
