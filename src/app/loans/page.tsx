"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, HandCoins, Plus, Search, X } from "lucide-react";
import MobileShell, { ListSkeleton } from "@/components/MobileShell";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Notice,
  buttonClasses,
  cx,
  formatMoney,
} from "@/components/ui";
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
 * things that cut a long list in half.
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

/**
 * The five things anybody actually wants out of a long list of loans, as one
 * row of filters instead of the two independent chip rows this screen used to
 * have (status × role, six chips, and no way to say "what do I owe" without
 * knowing to combine two of them).
 */
const FILTERS = [
  { id: "all", label: "All", status: "all", role: "all" },
  { id: "running", label: "Running", status: "active", role: "all" },
  { id: "lent", label: "Owed to you", status: "all", role: "lender" },
  { id: "borrowed", label: "You owe", status: "all", role: "borrower" },
  { id: "closed", label: "Closed", status: "closed", role: "all" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

/** The filter a URL is asking for, so the dashboard's chips can link here. */
function filterFromParams(status: string | null, role: string | null): FilterId {
  const match = FILTERS.find((f) => f.status === (status ?? "all") && f.role === (role ?? "all"));
  return match?.id ?? "all";
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

function LoansScreen() {
  const params = useSearchParams();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [typed, setTyped] = useState("");
  /*
   * The URL is read once, when the screen mounts, and the chips own the choice
   * from then on. That is deliberate: writing every chip tap back into the URL
   * would send the router off to re-render a static route on each one, and a
   * filter is not a navigation - the dashboard's two chips ("you'll receive" /
   * "you'll pay") land here already filtered, which is the only inbound link
   * with a filter in it.
   */
  const [filter, setFilter] = useState<FilterId>(() =>
    filterFromParams(params.get("status"), params.get("role"))
  );

  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];

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
    if (active.status !== "all") params.set("status", active.status);
    if (active.role !== "all") params.set("role", active.role);
    return params.toString();
  }, [q, active]);

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
        setLoadError(
          result.error ?? "Couldn't load your loans. Check your connection and try again."
        );
        return;
      }

      setTotal(result.data.total);
      setHasMore(result.data.hasMore);
      setLoans((previous) =>
        offset === 0 ? result.data!.loans : [...previous, ...result.data!.loans]
      );

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

  const filtering = Boolean(q) || filter !== "all";

  return (
    <MobileShell
      title="Loans"
      subtitle={loading ? "Loading…" : total === 1 ? "1 loan" : `${total} loans`}
      rightAction={
        <Link
          href="/loans/new"
          aria-label="Add a loan"
          className="tap flex size-10 items-center justify-center rounded-full bg-brand text-brand-ink"
        >
          <Plus className="size-5" />
        </Link>
      }
    >
      <div className="space-y-3 px-4 pb-8 pt-3">
        {/* Search: the box and its filters travel together at the top, because
            both answer the same question - which loans am I looking at. */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Name, mobile number or note"
            aria-label="Search loans"
            className="w-full rounded-control border border-line bg-surface py-3 pl-10 pr-9 text-[15px] text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)]"
          />
          {typed && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setTyped("")}
              className="tap absolute right-2.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:bg-surface-2"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5">
          {FILTERS.map((option) => (
            <Chip
              key={option.id}
              active={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </Chip>
          ))}
        </div>

        {loadError && <Notice tone="bad">{loadError}</Notice>}

        {loading && loans.length === 0 && !loadError && <ListSkeleton rows={5} />}

        {!loading && !loadError && loans.length === 0 && (
          <Card padded={false}>
            <EmptyState
              icon={<HandCoins className="size-6" />}
              title={filtering ? "No loans match that" : "No loans yet"}
              body={
                filtering
                  ? "Try a different name, or clear the filters to see everything."
                  : "Udhaar keeps track of what is owed, by whom, and when it is due."
              }
              action={
                filtering ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTyped("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Link href="/loans/new" className={buttonClasses("primary", "md")}>
                    <Plus className="size-4" />
                    Add your first loan
                  </Link>
                )
              }
            />
          </Card>
        )}

        {loans.length > 0 && (
          <ul className="stagger space-y-2.5">
            {loans.map((loan) => {
              const displayName =
                loan.viewerRole === "lender" ? loan.borrowerName : loan.lenderName || "Lender";
              const running = loan.status === "active";
              return (
                <Card as="li" key={loan.id} padded={false}>
                  <Link
                    href={`/loans/${loan.id}`}
                    className="tap flex items-center gap-3 px-4 py-3.5 hover:bg-surface-2"
                  >
                    <Avatar name={displayName} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[15px] font-semibold text-ink">{displayName}</p>
                        <Badge tone={loan.viewerRole === "lender" ? "good" : "warn"}>
                          {loan.viewerRole === "lender" ? "LENT" : "BORROWED"}
                        </Badge>
                        {!running && <Badge>CLOSED</Badge>}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-ink-3">
                        {loan.interestRate}%
                        {loan.interestRatePeriod === "monthly" ? "/mo" : "/yr"} ·{" "}
                        {loan.tenureMonths}mo
                        {loan.startDate ? ` · from ${loan.startDate}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[15px] font-bold tabular-nums text-ink">
                        {formatMoney(parseFloat(loan.amount))}
                      </span>
                      <ChevronRight className="size-4 text-ink-3" />
                    </div>
                  </Link>
                </Card>
              );
            })}
          </ul>
        )}

        {hasMore && (
          <Button
            block
            variant="secondary"
            size="lg"
            loading={loadingMore}
            onClick={loadMore}
            className={cx(loadingMore && "opacity-70")}
          >
            {loadingMore ? "Loading" : `Show more (${total - loans.length} left)`}
          </Button>
        )}
      </div>
    </MobileShell>
  );
}

/**
 * `useSearchParams` has to sit inside a Suspense boundary on a prerendered
 * page, so the screen is split out and the whole route is the boundary. The
 * fallback is the same skeleton the screen shows while its first request is in
 * flight - arriving at a list of rows that resolve, rather than a spinner that
 * becomes one.
 */
export default function LoansPage() {
  return (
    <Suspense
      fallback={
        <MobileShell title="Loans" subtitle="Loading…">
          <div className="px-4 pt-3">
            <ListSkeleton rows={5} />
          </div>
        </MobileShell>
      }
    >
      <LoansScreen />
    </Suspense>
  );
}
