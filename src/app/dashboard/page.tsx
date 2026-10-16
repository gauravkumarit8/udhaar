"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BellRing,
  ChevronRight,
  HandCoins,
  Plus,
  RotateCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import MobileShell from "@/components/MobileShell";
import EnableNotifications from "@/components/EnableNotifications";
import { PaySheet, RemindSheet, type PayTarget, type RemindTarget } from "@/components/ActionSheets";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  Skeleton,
  buttonClasses,
  cx,
  formatMoney,
} from "@/components/ui";
import { useAppResume, useHaptics, usePushRegistration } from "@/hooks/useNative";
import { requestJson } from "@/lib/http";
import { DASHBOARD_CACHE_KEY, UNREAD_EVENT } from "@/lib/client-cache";

interface DueItem {
  loanId: string;
  borrowerName: string;
  lenderName: string | null;
  installmentId: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  computedStatus: string;
  viewerRole: "lender" | "borrower";
  /** Further installments on the same loan that are also overdue. */
  moreOverdueCount: number;
  moreOverdueAmount: number;
  /** Days until this one is due; negative when it is late. */
  daysUntilDue: number;
  /** More than one installment unpaid on this loan (so the row can say so). */
  installmentsOutstanding?: number;
  /** The lender's UPI id, so a borrower can pay from here. */
  lenderUpiId?: string | null;
  /** This installment's outstanding split, so "Interest only" is one tap. */
  principalRemaining?: number;
  interestRemaining?: number;
}

interface Loan {
  id: string;
  lenderId: string | null;
  borrowerName: string;
  borrowerMobile: string;
  amount: string;
  interestRate: string;
  interestRatePeriod: string;
  tenureMonths: number;
  status: string;
  startDate: string;
  createdAt: string;
  viewerRole: "lender" | "borrower";
  lenderName: string | null;
}

interface DashboardData {
  user?: { name: string; mobile: string };
  /** Notifications not opened yet - the tab bar's badge, answered in passing. */
  unread?: number;
  summary: {
    youWillReceive: number;
    youWillPay: number; // now computed from loans where you're the borrower
    dueThisWeek: number;
    overdueAmount: number;
    totalInterestEarned: number;
    activeLoans: number;
    totalLoans: number;
  };
  /** One page of the due list; `dueItemCount` is how many there are in total. */
  dueItems: DueItem[];
  dueItemCount?: number;
  loans: Loan[];
  /** True when the loan list is a page and the rest is behind "see all". */
  hasMoreLoans?: boolean;
}

/**
 * The dashboard, remembered on this device.
 *
 * sessionStorage and not localStorage: this is money, and a shared phone should
 * not show yesterday's balances to whoever opens it next after the tab is
 * closed. The server is always asked anyway - this is the first paint only.
 */
function readCachedDashboard(): DashboardData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; data?: DashboardData };
    // Ten minutes is long enough to cover a wander through the app and short
    // enough that a stale balance cannot be mistaken for the current one if
    // the request fails.
    if (!parsed?.data || !parsed.at || Date.now() - parsed.at > 10 * 60 * 1000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function rememberDashboard(data: DashboardData): void {
  try {
    sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Storage unavailable (private mode, quota) - the app works, uncached.
  }
}

/**
 * Hand the badge count to the tab bar.
 *
 * The dashboard's own response already contains it, so the tab bar does not
 * have to spend a second round trip asking. BottomNav (src/components) listens
 * for this and treats it as freshly confirmed.
 */
function publishUnread(count: number | undefined): void {
  if (typeof count !== "number") return;
  window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: count }));
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.floor((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/** "3d overdue" / "Today" / "in 5 days" - short enough for a card row. */
function dueLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days}d`;
}

function shortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

export default function DashboardPage() {
  /*
   * Start from what this device showed last time, then replace it when the
   * server answers.
   *
   * Home is the screen every session begins on, and it used to be blank for as
   * long as two round trips to a database in another region took. The figures
   * are the same ones the server is about to send - the request still runs, and
   * whatever comes back wins - so this costs nothing but makes the app feel
   * like it opened, rather than like it is thinking about opening.
   */
  const [data, setData] = useState<DashboardData | null>(() => readCachedDashboard());
  const [user, setUser] = useState<{ name: string; mobile: string } | null>(
    () => readCachedDashboard()?.user ?? null
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [greeting] = useState(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  });
  /**
   * The row being acted on, not a flag: which payment is being recorded and
   * which reminder is being sent is the whole of this screen's state, and
   * holding the row means the sheet cannot open against a stale one.
   */
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [remindTarget, setRemindTarget] = useState<RemindTarget | null>(null);
  const haptics = useHaptics();
  usePushRegistration();
  /*
   * A note on loans whose lender has no account: they appear in the list like
   * any other, tagged "NOT ON UDHAAR" (see the badge below). Before this they
   * were filtered out, so a borrower who had only ever *borrowed* saw an empty
   * dashboard listing nothing they owed - quietly wrong.
   */

  const loadData = useCallback(async () => {
    try {
      // One request. The payload carries the viewer's name, so the second call
      // to /api/auth/me - a whole extra round trip to the database before the
      // greeting could render - is gone.
      const dashResult = await requestJson<DashboardData>("/api/dashboard");

      if (dashResult.status === 401) {
        window.location.assign("/login");
        return;
      }

      if (dashResult.ok && dashResult.data) {
        setData(dashResult.data);
        if (dashResult.data.user) setUser(dashResult.data.user);
        rememberDashboard(dashResult.data);
        publishUnread(dashResult.data.unread);
        setLoadError(null);
      } else if (dashResult.error) {
        // Previously this failed silently and the dashboard just looked empty.
        setLoadError(dashResult.error);
      }
    } catch {
      setLoadError("Couldn't load your dashboard. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh data when app comes to foreground
  useAppResume(() => {
    loadData();
  });

  useEffect(() => {
    // Kicked off inside an async IIFE so the state updates all happen after an
    // await (fetch), never synchronously during the effect.
    void (async () => {
      await loadData();
    })();
  }, [loadData]);

  const header = (
    <div className="flex items-center gap-3 px-4 pb-1 pt-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink-3">{greeting}</p>
        <h1 className="truncate text-[22px] font-bold tracking-tight text-ink">
          {user?.name || "Welcome"}
        </h1>
      </div>
      <Link
        href="/activity"
        aria-label="Activity and notifications"
        className="tap flex size-10 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2"
      >
        <BellRing className="size-5" />
      </Link>
      <Link href="/profile" aria-label="Your profile" className="tap">
        <Avatar name={user?.name || "?"} size={40} />
      </Link>
    </div>
  );

  if (loading && !data) {
    return (
      <MobileShell bare>
        {header}
        <div className="space-y-3 px-4 pt-3">
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-20 rounded-card" />
          <Skeleton className="h-20 rounded-card" />
          <Skeleton className="h-20 rounded-card" />
        </div>
      </MobileShell>
    );
  }

  if (!data) {
    return (
      <MobileShell bare>
        {header}
        <div className="px-4 pt-4">
          <Card>
            <EmptyState
              icon={<ShieldCheck className="size-6" />}
              title="Couldn't load your dashboard"
              body={loadError ?? "Something went wrong reaching the server."}
              action={
                <Button
                  onClick={() => {
                    setLoading(true);
                    void loadData();
                  }}
                >
                  Try again
                </Button>
              }
            />
          </Card>
          {loadError && (
            <p className="mt-3 text-center text-[11px] text-ink-3">
              Server status: <span className="font-mono">/api/health</span>
            </p>
          )}
        </div>
      </MobileShell>
    );
  }

  const { summary, dueItems, loans } = data;
  // Both lists arrive as one page. The counts say whether there is more
  // behind them, so the headers can offer somewhere to go.
  const dueItemCount = data.dueItemCount ?? dueItems.length;
  const moreDueItems = dueItemCount > dueItems.length;
  const hasMoreLoans = data.hasMoreLoans ?? summary.totalLoans > loans.length;
  const net = summary.youWillReceive - summary.youWillPay;
  const settled = summary.youWillReceive <= 0 && summary.youWillPay <= 0;

  const openPay = (item: DueItem) => {
    haptics.tap();
    setPayTarget({
      installmentId: item.installmentId,
      installmentNumber: item.installmentNumber,
      dueDate: item.dueDate,
      principalRemaining: item.principalRemaining ?? item.amount,
      interestRemaining: item.interestRemaining ?? 0,
      counterparty: item.viewerRole === "lender" ? item.borrowerName : item.lenderName || "Lender",
      viewerRole: item.viewerRole,
      upiId: item.lenderUpiId ?? null,
    });
  };

  const openRemind = (item: DueItem) => {
    haptics.tap();
    setRemindTarget({
      installmentId: item.installmentId,
      installmentNumber: item.installmentNumber,
      dueDate: item.dueDate,
      remaining: item.amount,
      borrowerName: item.borrowerName,
      canPush: true,
    });
  };

  return (
    <MobileShell bare>
      {header}

      <div className="space-y-6 px-4 pb-8 pt-3">
        {loadError && (
          <Notice
            tone="warn"
            onDismiss={() => setLoadError(null)}
            action={
              /* Offline, a flaky connection, or a deploy in flight: the way out
                 is one tap, not a trip to another tab and back. */
              <Button size="sm" variant="secondary" onClick={() => void loadData()}>
                <RotateCw className="size-3.5" />
                Try again
              </Button>
            }
          >
            {loadError}
          </Notice>
        )}

        {/*
         * Where you stand, in one card: what is coming in, what is going out.
         * These used to be two dashboard tiles plus a separate row of stats,
         * three blocks of numbers with no relationship drawn between them. The
         * centre of the card is the net - the single figure somebody opens this
         * app to see - and the two halves beside it are tappable filters, so
         * "who owes me" is a tap rather than a hunt.
         */}
        <Card padded={false} className="overflow-hidden bg-brand text-brand-ink">
          <div className="px-5 pb-4 pt-5">
            <p className="text-[12px] font-semibold uppercase tracking-wide opacity-70">
              {settled ? "All settled up" : net >= 0 ? "You are owed" : "You owe"}
            </p>
            <p className="mt-1 text-[34px] font-bold leading-none tracking-tight tabular-nums">
              {formatMoney(Math.abs(net))}
            </p>
            <div className="mt-4 flex items-center gap-2 text-[12px]">
              <span className="rounded-full bg-black/10 px-2 py-0.5 font-semibold">
                {summary.activeLoans} active
              </span>
              <span className="rounded-full bg-black/10 px-2 py-0.5 font-semibold">
                {summary.totalLoans} total
              </span>
              {summary.overdueAmount > 0 && (
                <span className="rounded-full bg-black/20 px-2 py-0.5 font-semibold">
                  {formatMoney(summary.overdueAmount)} overdue
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-px bg-black/10">
            <Link
              href="/loans?role=lender"
              className="tap flex flex-col gap-0.5 bg-brand/95 px-5 py-3.5 hover:bg-brand-strong"
            >
              <span className="flex items-center gap-1.5 text-[11px] font-semibold opacity-70">
                <ArrowUpRight className="size-3.5" /> You&apos;ll receive
              </span>
              <span className="text-[17px] font-bold tabular-nums">
                {formatMoney(summary.youWillReceive)}
              </span>
            </Link>
            <Link
              href="/loans?role=borrower"
              className="tap flex flex-col gap-0.5 bg-brand/95 px-5 py-3.5 hover:bg-brand-strong"
            >
              <span className="flex items-center gap-1.5 text-[11px] font-semibold opacity-70">
                <Wallet className="size-3.5" /> You&apos;ll pay
              </span>
              <span className="text-[17px] font-bold tabular-nums">
                {formatMoney(summary.youWillPay)}
              </span>
            </Link>
          </div>
        </Card>

        {/*
         * The tap-count argument for this screen lives here. Every row carries
         * the one action its reader actually wants: a borrower pays (the sheet
         * opens with the full amount filled in and their UPI app one tap
         * away), a lender chases. Before this, both jobs were two screens deep.
         */}
        <section>
          <SectionHeader
            title="Payments"
            count={
              dueItemCount > 0
                ? moreDueItems
                  ? `showing ${dueItems.length} of ${dueItemCount} loans`
                  : `${dueItemCount} ${dueItemCount === 1 ? "loan" : "loans"}`
                : undefined
            }
            action={
              moreDueItems ? (
                <Link
                  href="/loans?status=active"
                  className="tap text-[12px] font-semibold text-brand-strong"
                >
                  See all
                </Link>
              ) : undefined
            }
          />

          {dueItems.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon={<HandCoins className="size-6" />}
                title="Nothing due right now"
                body={
                  summary.totalLoans === 0
                    ? "Add the first loan and Udhaar keeps track of what is owed, and when."
                    : "Every installment on your loans is paid up. We'll tell you when the next one is due."
                }
                action={
                  <Link href="/loans/new" className={buttonClasses("primary", "md")}>
                    <Plus className="size-4" />
                    {summary.totalLoans === 0 ? "Add your first loan" : "Add a loan"}
                  </Link>
                }
              />
            </Card>
          ) : (
            <ul className="stagger space-y-2.5">
              {dueItems.map((item) => {
                const days = item.daysUntilDue ?? daysUntil(item.dueDate);
                const isOverdue = item.computedStatus === "overdue" || days < 0;
                                const displayName =
                  item.viewerRole === "lender" ? item.borrowerName : item.lenderName || "Lender";
                const received = item.viewerRole === "lender";

                return (
                  <Card as="li" key={item.loanId} padded={false} className="overflow-hidden">
                    <Link href={`/loans/${item.loanId}`} className="tap block px-4 pt-4">
                      <div className="flex items-start gap-3">
                        <Avatar name={displayName} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[15px] font-semibold text-ink">
                              {displayName}
                            </p>
                            <Badge tone={received ? "good" : "warn"}>
                              {received ? "OWED TO YOU" : "YOU OWE"}
                            </Badge>
                          </div>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-3">
                            <span className={cx("font-semibold", isOverdue && "text-bad")}>
                              <span className="tabular-nums">{formatMoney(item.amount)}</span> ·{" "}
                              {dueLabel(days)}
                            </span>
                            <span>
                              EMI #{item.installmentNumber} · {shortDate(item.dueDate)}
                            </span>
                          </p>
                          {item.moreOverdueCount > 0 && (
                            <p className="mt-0.5 text-[11px] font-semibold text-bad">
                              plus {item.moreOverdueCount} more overdue ·{" "}
                              <span className="tabular-nums">
                                {formatMoney(item.moreOverdueAmount)}
                              </span>
                            </p>
                          )}
                        </div>
                      </div>
                    </Link>

                    <div className="mt-3 flex items-center gap-2 border-t border-line px-4 py-2.5">
                      <Link
                        href={`/loans/${item.loanId}`}
                        className="tap flex-1 text-[12px] font-semibold text-ink-3"
                      >
                        View loan
                      </Link>
                      {received ? (
                        <Button size="sm" variant="secondary" onClick={() => openRemind(item)}>
                          <BellRing className="size-3.5" />
                          Remind
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => openPay(item)}>
                          Pay now
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </ul>
          )}
        </section>

        <EnableNotifications />

        {/*
         * One page of loans, newest and still-running first, with the count of
         * the rest behind "see all". The row no longer needs to carry every
         * figure: the screen above it already answered "how much, and when",
         * so this is a directory entry - who, how much, and which way.
         */}
        <section>
          <SectionHeader
            title="Your loans"
            action={
              <Link href="/loans" className="tap text-[12px] font-semibold text-brand-strong">
                {hasMoreLoans ? `See all ${summary.totalLoans}` : "See all"}
              </Link>
            }
          />

          {loans.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon={<HandCoins className="size-6" />}
                title="No loans yet"
                body="Udhaar tracks the money between you and the people you actually lend to or borrow from."
                action={
                  <Link href="/loans/new" className={buttonClasses("primary", "md")}>
                    <Plus className="size-4" />
                    Add a loan
                  </Link>
                }
              />
            </Card>
          ) : (
            <Card padded={false} className="divide-y divide-line">
              {loans.map((loan) => {
                const displayName =
                  loan.viewerRole === "lender" ? loan.borrowerName : loan.lenderName || "Lender";
                const closed = loan.status !== "active";
                return (
                  <Link
                    key={loan.id}
                    href={`/loans/${loan.id}`}
                    className="tap flex items-center gap-3 px-4 py-3.5 hover:bg-surface-2"
                  >
                    <Avatar name={displayName} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-ink">{displayName}</p>
                      <p className="truncate text-[12px] text-ink-3">
                        {formatMoney(parseFloat(loan.amount))} · {loan.interestRate}%
                        {loan.interestRatePeriod === "monthly" ? "/mo" : "/yr"} ·{" "}
                        {loan.tenureMonths}mo
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {loan.viewerRole === "borrower" && !loan.lenderId && (
                        <Badge>NOT ON UDHAAR</Badge>
                      )}
                      {closed ? (
                        <Badge>CLOSED</Badge>
                      ) : (
                        <Badge tone={loan.viewerRole === "lender" ? "good" : "warn"}>
                          {loan.viewerRole === "lender" ? "LENT" : "BORROWED"}
                        </Badge>
                      )}
                      <ChevronRight className="size-4 text-ink-3" />
                    </div>
                  </Link>
                );
              })}
            </Card>
          )}
        </section>

        {summary.totalInterestEarned > 0 && (
          <p className="px-1 text-center text-[11px] leading-relaxed text-ink-3">
            Interest earned so far:{" "}
            <span className="font-semibold tabular-nums text-ink-2">
              {formatMoney(summary.totalInterestEarned)}
            </span>
            . Due in the next 7 days:{" "}
            <span className="font-semibold tabular-nums text-ink-2">
              {formatMoney(summary.dueThisWeek)}
            </span>
            .
          </p>
        )}
      </div>

      {payTarget && (
        <PaySheet
          key={payTarget.installmentId}
          target={payTarget}
          onClose={() => setPayTarget(null)}
          onRecorded={() => {
            void loadData();
          }}
        />
      )}

      {remindTarget && (
        <RemindSheet
          key={remindTarget.installmentId}
          target={remindTarget}
          onClose={() => setRemindTarget(null)}
          onSent={() => {
            void loadData();
          }}
        />
      )}
    </MobileShell>
  );
}
