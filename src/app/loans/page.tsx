"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";
import { requestJson } from "@/lib/http";
import { UNREAD_EVENT } from "@/lib/client-cache";
// Type-only: the filter values are shared with the API, but importing the
// module itself would drag drizzle and the schema into the browser bundle.
import type { LoanRoleFilter, LoanStatusFilter } from "@/lib/loan-search";

/**
 * Every loan on the account, a page at a time, searchable.
 *
 * This is where "see all" goes from the dashboard. The dashboard prints five
 * rows and a count; this screen answers the other question - "where is the loan
 * from Vikram in 2024?" - by searching the fields a person recognises a loan by
 * (both names, both mobile numbers, the note they left) and filtering by the
 * two things that cut a long list in half: whether it is still running, and
 * whether you lent or borrowed.
 *
 * Search happens on the server (`?q=&status=&role=`), not in the browser over
 * whatever pages happen to be loaded: a filter that only saw the first 20 of 143
 * loans would quietly lie.
 */

interface Loan {
  id: string;
  borrowerName: string;
  lenderName: string | null;
  lenderId: string | null;
  amount: string;
  interestRate: string;
  interestRatePeriod: string;
  tenureMonths: number;
  status: string;
  startDate: string;
  viewerRole: "lender" | "borrower";
}

interface LoansPayload {
  loans: Loan[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  unread?: number;
  query?: { q: string; status: LoanStatusFilter; role: LoanRoleFilter };
}

/** A screenful and then some - the button below loads the next one. */
const PAGE_SIZE = 20;

/** How long typing pauses before a search runs. */
const SEARCH_DEBOUNCE_MS = 300;

function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold tap-highlight transition-colors ${
        active ? "bg-emerald-600 text-white" : "bg-white text-slate-600 border border-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<LoanStatusFilter>("all");
  const [role, setRole] = useState<LoanRoleFilter>("all");

  // What is actually being searched for is the settled text, not every keystroke.
  const q = useDebounced(typed, SEARCH_DEBOUNCE_MS);

  /**
   * Only the newest request may write to the screen.
   *
   * Type "sunit" quickly and three searches are in flight; the slowest one
   * finishing last would leave the list showing results for "sun" under a box
   * that says "sunit".
   */
  const requestSeq = useRef(0);

  const search = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status !== "all") params.set("status", status);
    if (role !== "all") params.set("role", role);
    return params.toString();
  }, [q, status, role]);

  const loadPage = useCallback(
    async (offset: number) => {
      const seq = (requestSeq.current += 1);
      const result = await requestJson<LoansPayload>(
        `/api/loans?limit=${PAGE_SIZE}&offset=${offset}${search ? `&${search}` : ""}`
      );

      if (seq !== requestSeq.current) return; // a newer search has overtaken this one

      if (result.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!result.ok || !result.data) {
        setLoadError(result.error ?? "Couldn't load your loans. Check your connection and try again.");
        return;
      }

      setTotal(result.data.total);
      setHasMore(result.data.hasMore);
      setLoans((previous) => (offset === 0 ? result.data!.loans : [...previous, ...result.data!.loans]));

      // The badge rides along in this response; the tab bar need not ask.
      if (typeof result.data.unread === "number") {
        window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: result.data.unread }));
      }
      setLoadError(null);
    },
    [search]
  );

  // Every change of search or filter restarts from page one.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      await loadPage(0);
      setLoading(false);
    })();
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      await loadPage(loans.length);
    } finally {
      setLoadingMore(false);
    }
  }, [loans.length, loadPage]);

  const filtering = Boolean(q) || status !== "all" || role !== "all";

  return (
    <MobileShell title="All Loans">
      <div className="px-4 py-4 pb-24 space-y-3">
        {/* Search */}
        <div className="relative">
          <input
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Name, mobile number or note"
            aria-label="Search loans"
            className="w-full bg-white border border-slate-200 rounded-2xl pl-10 pr-9 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
          />
          <svg
            className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
            />
          </svg>
          {typed && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setTyped("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg leading-none tap-highlight"
            >
              ×
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={status === "all"} onClick={() => setStatus("all")}>
            All
          </Chip>
          <Chip active={status === "active"} onClick={() => setStatus("active")}>
            Running
          </Chip>
          <Chip active={status === "closed"} onClick={() => setStatus("closed")}>
            Closed
          </Chip>
          <span className="w-px h-4 bg-slate-200 mx-0.5" />
          <Chip active={role === "all"} onClick={() => setRole("all")}>
            Both sides
          </Chip>
          <Chip active={role === "lender"} onClick={() => setRole("lender")}>
            I lent
          </Chip>
          <Chip active={role === "borrower"} onClick={() => setRole("borrower")}>
            I borrowed
          </Chip>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {loading
              ? "Loading…"
              : total === 0
                ? "No loans yet"
                : loans.length < total
                  ? `Showing ${loans.length} of ${total}`
                  : `${total} ${total === 1 ? "loan" : "loans"}`}
          </p>
          <Link href="/loans/new" className="text-xs text-emerald-600 font-semibold tap-highlight">
            + New
          </Link>
        </div>

        {loadError && (
          <div className="bg-red-50 border border-red-100 rounded-2xl p-4 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {loading && !loadError && loans.length === 0 && (
          <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
            <p className="text-slate-400 text-sm">Loading your loans…</p>
          </div>
        )}

        {!loading && !loadError && loans.length === 0 && (
          <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
            <div className="text-4xl mb-2">{filtering ? "🔍" : "🤝"}</div>
            <p className="text-slate-500 text-sm">
              {filtering ? "No loans match that" : "No loans yet"}
            </p>
            {filtering ? (
              <button
                type="button"
                onClick={() => {
                  setTyped("");
                  setStatus("all");
                  setRole("all");
                }}
                className="text-emerald-600 font-semibold text-sm mt-3 tap-highlight"
              >
                Clear the search
              </button>
            ) : (
              <Link
                href="/loans/new"
                className="inline-flex items-center gap-2 mt-4 bg-emerald-600 text-white px-6 py-2.5 rounded-2xl font-semibold text-sm tap-highlight"
              >
                <span>+</span> Add Your First Loan
              </Link>
            )}
          </div>
        )}

        <div className="space-y-2.5">
          {loans.map((loan) => {
            const displayName =
              loan.viewerRole === "lender" ? loan.borrowerName : loan.lenderName || "Lender";
            const active = loan.status === "active";

            return (
              <Link
                key={loan.id}
                href={`/loans/${loan.id}`}
                className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center gap-3.5 tap-highlight active:bg-slate-50 transition-all"
              >
                <div
                  className={`w-11 h-11 rounded-2xl flex items-center justify-center font-bold text-sm text-white shrink-0 ${
                    active ? "bg-emerald-500" : "bg-slate-400"
                  }`}
                >
                  {displayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-slate-800 text-[15px] truncate">{displayName}</p>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                        loan.viewerRole === "lender"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-orange-100 text-orange-700"
                      }`}
                    >
                      {loan.viewerRole === "lender" ? "LENT" : "BORROWED"}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                        active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {loan.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {formatINR(parseFloat(loan.amount))} · {loan.interestRate}%
                    {loan.interestRatePeriod === "monthly" ? "/mo" : "/yr"} · {loan.tenureMonths}mo
                    {loan.startDate ? ` · from ${loan.startDate}` : ""}
                  </p>
                </div>
                <svg
                  className="w-5 h-5 text-slate-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            );
          })}
        </div>

        {hasMore && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full bg-white border border-slate-200 text-emerald-700 font-semibold text-sm py-3 rounded-2xl tap-highlight disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : `Show more (${total - loans.length} left)`}
          </button>
        )}
      </div>

      <BottomNav />
    </MobileShell>
  );
}
