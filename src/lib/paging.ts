/**
 * "Give me a page of it", safely.
 *
 * Every list endpoint that can grow with use answers with a page and says how
 * much is left, instead of handing back everything the account has ever
 * recorded. The dashboard used to return all 119 loans of a test account (92 KB
 * of JSON, every installment behind them read out of Postgres) so that the
 * screen could print five rows.
 *
 * The parsing is a pure function because the edge cases are the whole job:
 * `?limit=abc`, `?limit=-5`, `?limit=99999` and a missing parameter all have to
 * end somewhere sane rather than in a query with no LIMIT.
 */

/** How many rows a list endpoint sends when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 50;

/** Hard ceiling, whatever the caller asks for - one request cannot pull the table. */
export const MAX_PAGE_SIZE = 200;

export interface Paging {
  limit: number;
  offset: number;
}

/** Read `limit` / `offset` from a query string, clamped to something sane. */
export function parsePaging(params: URLSearchParams, fallback = DEFAULT_PAGE_SIZE): Paging {
  return {
    limit: clampInt(params.get("limit"), fallback, 1, MAX_PAGE_SIZE),
    offset: clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
