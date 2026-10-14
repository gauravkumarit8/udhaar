import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePaging } from "@/lib/paging";

/**
 * How much of a list a request is allowed to ask for.
 *
 * The dashboard used to send everything it had - 119 loans, 92 KB of JSON - to
 * print five rows, and `GET /api/loans` answered with every loan ever recorded.
 * Both now answer with a page, which means these numbers are between a user and
 * an unbounded query: a caller that sends `limit=abc`, `limit=-1` or
 * `limit=100000` must land somewhere sane rather than in a query with no LIMIT.
 */
const params = (query: string) => new URLSearchParams(query);

describe("parsePaging", () => {
  it("uses the caller's page size when it is reasonable", () => {
    expect(parsePaging(params("limit=20&offset=40"))).toEqual({ limit: 20, offset: 40 });
  });

  it("falls back to the default when nothing is asked for", () => {
    expect(parsePaging(params(""))).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(parsePaging(params("limit=&offset="))).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it("takes a smaller default for a screen that shows fewer rows", () => {
    expect(parsePaging(params(""), 5).limit).toBe(5);
  });

  it("refuses to go over the ceiling", () => {
    expect(parsePaging(params(`limit=${MAX_PAGE_SIZE + 1}`)).limit).toBe(MAX_PAGE_SIZE);
    expect(parsePaging(params("limit=100000")).limit).toBe(MAX_PAGE_SIZE);
  });

  it("never returns a page of nothing or less", () => {
    expect(parsePaging(params("limit=0")).limit).toBe(1);
    expect(parsePaging(params("limit=-5")).limit).toBe(1);
    expect(parsePaging(params("offset=-100")).offset).toBe(0);
  });

  it("ignores a limit that is not a number, rather than passing it to SQL", () => {
    expect(parsePaging(params("limit=abc")).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePaging(params("limit=NaN")).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePaging(params("limit=Infinity")).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePaging(params("offset=nope")).offset).toBe(0);
  });

  it("rounds a fractional limit down, so the row count is an integer", () => {
    expect(parsePaging(params("limit=12.7")).limit).toBe(12);
    expect(parsePaging(params("offset=3.9")).offset).toBe(3);
  });
});
