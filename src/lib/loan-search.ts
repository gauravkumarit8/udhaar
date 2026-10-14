/**
 * What a person typed into the search box, turned into something a query can
 * use safely.
 *
 * Two jobs, and the second is the one that bites:
 *
 *   1. Normalise. Trim it, collapse runs of whitespace, drop control characters
 *      and cap the length - a 10,000-character "search" is a denial-of-service
 *      dressed as a query string, and nobody searches for a tab character.
 *   2. Neutralise LIKE wildcards. `%` and `_` are operators in a pattern, not
 *      text: a search for `%` would otherwise match every loan ever recorded,
 *      and `_` would match any single character. They are escaped here and the
 *      pattern is always passed as a *parameter* (`ILIKE $1`), so nothing a
 *      person types can change the shape of the statement.
 */
import type { SQL } from "drizzle-orm";
import { ilike, or, sql } from "drizzle-orm";
import { loans, users } from "@/db/schema";

export type LoanStatusFilter = "active" | "closed" | "all";
export type LoanRoleFilter = "lender" | "borrower" | "all";

export interface LoanQuery {
  /** Normalised search text; empty string means "no search". */
  q: string;
  status: LoanStatusFilter;
  role: LoanRoleFilter;
}

/** Longest search string worth running. */
export const SEARCH_MAX_LENGTH = 60;

export function parseLoanQuery(params: URLSearchParams): LoanQuery {
  return {
    q: normaliseSearch(params.get("q")),
    status: oneOf(params.get("status"), ["active", "closed"], "all"),
    role: oneOf(params.get("role"), ["lender", "borrower"], "all"),
  };
}

function normaliseSearch(raw: string | null): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, SEARCH_MAX_LENGTH);
}

function oneOf<T extends string>(raw: string | null, allowed: T[], fallback: "all"): T | "all" {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  return (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/** `%search%` with the LIKE operators inside the text escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The search side of a loan list: the pattern matched against the fields a
 * person would actually recognise a loan by - both names, both mobile numbers,
 * the note they left, and the counterparty's account name where there is one.
 */
export function loanSearchCondition(q: string): SQL | undefined {
  if (!q) return undefined;
  const pattern = likePattern(q);

  return or(
    ilike(loans.borrowerName, pattern),
    ilike(loans.lenderName, pattern),
    ilike(loans.borrowerMobile, pattern),
    ilike(loans.lenderMobile, pattern),
    ilike(loans.notes, pattern),
    ilike(users.name, pattern)
  );
}

/** `active`, `closed`, or everything - the status chip on the list screen. */
export function loanStatusCondition(status: LoanStatusFilter): SQL | undefined {
  if (status === "all") return undefined;
  // Anything that is not running is finished: `active` is the only state a loan
  // is in while money is still moving.
  return status === "active"
    ? sql`${loans.status} = 'active'`
    : sql`${loans.status} <> 'active'`;
}

/** `lent` or `borrowed` - the role chip on the list screen. */
export function loanRoleCondition(role: LoanRoleFilter, userId: string): SQL | undefined {
  if (role === "all") return undefined;
  return role === "lender"
    ? sql`${loans.lenderId} = ${userId}`
    : sql`${loans.borrowerId} = ${userId}`;
}
