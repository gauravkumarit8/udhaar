"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";
import { requestJson } from "@/lib/http";
import { UNREAD_EVENT } from "@/lib/client-cache";

/**
 * Every loan on the account, a page at a time.
 *
 * The dashboard prints five rows of "Your Loans" and says how many more there
 * are; this is where "see all" goes. It is also the first screen that has ever
 * shown a person their whole history: the dashboard was the only list, and it
 * either showed everything (119 loans on the test account) or, once its payload
 * was capped, would have shown five with nowhere to go.
 *
 * Paging is done by the server (`?limit=&offset=`, clamped in src/lib/paging.ts)
 * because the answer has to stay one page of JSON no matter how many years of
 * records are behind it.
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
}

/** A screenful and then some - the button below loads the next one. */
const PAGE_SIZE = 20;

function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number) => {
    const result = await requestJson<LoansPayload>(
      `/api/loans?limit=${PAGE_SIZE}&offset=${offset}`
    );

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
    // Page one replaces, later pages append - the offset is the server's, so a
    // loan created while this screen is open cannot shift rows between pages.
    setLoans((previous) => (offset === 0 ? result.data!.loans : [...previous, ...result.data!.loans]));

    // The badge rides along in this response; the tab bar need not ask.
    if (typeof result.data.unread === "number") {
      window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: result.data.unread }));
    }
    setLoadError(null);
  }, []);

  useEffect(() => {
    void (async () => {
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

  return (
    <MobileShell title="All Loans">
      <div className="px-4 py-4 pb-24 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {total === 0
              ? "No loans yet"
              : loans.length < total
                ? `Showing ${loans.length} of ${total}`
                : `${total} ${total === 1 ? "loan" : "loans"}`}
          </p>
          <Link
            href="/loans/new"
            className="text-xs text-emerald-600 font-semibold tap-highlight"
          >
            + New
          </Link>
        </div>

        {loadError && (
          <div className="bg-red-50 border border-red-100 rounded-2xl p-4 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {loading && !loadError && (
          <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
            <p className="text-slate-400 text-sm">Loading your loans…</p>
          </div>
        )}

        {!loading && !loadError && loans.length === 0 && (
          <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
            <div className="text-4xl mb-2">🤝</div>
            <p className="text-slate-500 text-sm">No loans yet</p>
            <Link
              href="/loans/new"
              className="inline-flex items-center gap-2 mt-4 bg-emerald-600 text-white px-6 py-2.5 rounded-2xl font-semibold text-sm tap-highlight"
            >
              <span>+</span> Add Your First Loan
            </Link>
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
