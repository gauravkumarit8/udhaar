"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BellRing, Check, Clock, HandCoins, Receipt, RotateCw } from "lucide-react";
import MobileShell, { ListSkeleton } from "@/components/MobileShell";
import { PaySheet, RemindSheet, type PayTarget, type RemindTarget } from "@/components/ActionSheets";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  cx,
  formatMoney,
} from "@/components/ui";
import { readApi } from "@/lib/http";
import { UNREAD_EVENT } from "@/lib/client-cache";

interface Reminder {
  id: string;
  installmentId: string;
  loanId: string;
  channel: string;
  message: string;
  sentAt: string;
  status: string;
  viewerRole: "lender" | "borrower";
}

interface DueItem {
  loanId: string;
  borrowerName: string;
  lenderName: string | null;
  installmentId: string;
  installmentNumber?: number;
  dueDate: string;
  amount: number;
  computedStatus: string;
  viewerRole: "lender" | "borrower";
  /** Carried by the dashboard API so a payment can start from this screen. */
  lenderUpiId?: string | null;
  principalRemaining?: number;
  interestRemaining?: number;
}

/**
 * Everything that has happened, and everything that needs to happen.
 *
 * Overdue first, then due soon, then the notifications feed. The rows are
 * actionable where they are: a lender sends the reminder from here, and a
 * borrower pays from here - the same sheets the home screen uses - instead of
 * each row being a signpost to the loan screen, where the same job then needed
 * two more taps.
 */
export default function ActivityPage() {
  const [dueItems, setDueItems] = useState<DueItem[]>([]);
  const [notifications, setNotifications] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [justArrived, setJustArrived] = useState(0);
  /** Notification ids already rendered, so arrivals mid-session can be called out. */
  const knownIds = useRef<Set<string>>(new Set());

  const [payFor, setPayFor] = useState<DueItem | null>(null);
  const [remindFor, setRemindFor] = useState<DueItem | null>(null);

  // Marks the feed read, which is what the tab badge counts. Fire-and-forget:
  // the badge is a convenience, and the screen must render whether or not this
  // request lands.
  const markSeen = useCallback(async () => {
    try {
      await fetch("/api/notifications/seen", { method: "POST" });
      window.dispatchEvent(new Event("udhaar:notifications-seen"));
    } catch {
      // Ignore - the count simply stays until the next successful call.
    }
  }, []);

  // Bumping this re-runs the fetch below. Coming back to the tab, or a minute
  // passing, is exactly when something new is likely to have happened on the
  // other side of the loan.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        /*
         * `limit=200` on purpose: this screen *is* the full list of what is
         * overdue and what is due soon, so it asks for the whole due list rather
         * than the dashboard's page of five. (The dashboard, which prints five
         * rows and a count, asks for neither.) Beyond 200 loans with a payment
         * due this needs paging of its own - see the note in README.
         */
        const [dashRes, notifRes] = await Promise.all([
          fetch("/api/dashboard?limit=200"),
          fetch("/api/notifications"),
        ]);
        const [dashResult, notifResult] = await Promise.all([
          readApi<{ dueItems?: DueItem[] }>(dashRes),
          readApi<{ notifications?: Reminder[]; unread?: number }>(notifRes),
        ]);

        if (dashResult.ok) setDueItems(dashResult.data?.dueItems ?? []);
        if (notifResult.ok) {
          const list = notifResult.data?.notifications ?? [];
          // Anything that arrived while this screen was open is called out, so a
          // notification that lands mid-session isn't silently mixed in.
          const fresh = list.filter((n) => !knownIds.current.has(n.id)).length;
          const wasLoaded = knownIds.current.size > 0;
          knownIds.current = new Set(list.map((n) => n.id));
          setNotifications(list);
          if (wasLoaded && fresh > 0) setJustArrived(fresh);

          // The badge comes from this same response; the tab bar need not ask.
          if (typeof notifResult.data?.unread === "number") {
            window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: notifResult.data.unread }));
          }
          if ((notifResult.data?.unread ?? 0) > 0) void markSeen();
        }

        // A silent failure used to leave this page looking merely empty.
        setLoadError(dashResult.error ?? notifResult.error ?? null);
      } catch {
        setLoadError("Couldn't load your activity. Check your connection and try again.");
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [refreshKey, markSeen]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setRefreshKey((key) => key + 1);
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 60_000);

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
    };
  }, []);

  const overdue = dueItems.filter((d) => d.computedStatus === "overdue");
  const dueSoon = dueItems.filter((d) => d.computedStatus === "due_soon");

  const openPay = (item: DueItem) => {
    setPayFor(item);
  };

  const openRemind = (item: DueItem) => {
    setRemindFor(item);
  };

  const payTarget: PayTarget | null = payFor
    ? {
        installmentId: payFor.installmentId,
        installmentNumber: payFor.installmentNumber ?? 0,
        dueDate: payFor.dueDate,
        principalRemaining: payFor.principalRemaining ?? payFor.amount,
        interestRemaining: payFor.interestRemaining ?? 0,
        counterparty: payFor.lenderName || "Lender",
        viewerRole: payFor.viewerRole,
        upiId: payFor.lenderUpiId ?? null,
      }
    : null;

  const remindTarget: RemindTarget | null = remindFor
    ? {
        installmentId: remindFor.installmentId,
        installmentNumber: remindFor.installmentNumber ?? 0,
        dueDate: remindFor.dueDate,
        remaining: remindFor.amount,
        borrowerName: remindFor.borrowerName,
        canPush: true,
      }
    : null;

  /** One row of "what needs doing", in whichever direction it is going. */
  const dueRow = (item: DueItem, tone: "bad" | "warn") => {
    const receiving = item.viewerRole === "lender";
    const displayName = receiving ? item.borrowerName : item.lenderName || "Lender";

    return (
      <Card key={`${item.loanId}-${item.installmentId}`} className="overflow-hidden p-0">
        <Link href={`/loans/${item.loanId}`} className="tap flex items-center gap-3 p-4">
          <Avatar name={displayName} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-[14px] font-semibold text-ink">{displayName}</p>
              <Badge tone={receiving ? "good" : "warn"}>
                {receiving ? "OWED TO YOU" : "YOU OWE"}
              </Badge>
            </div>
            <p className="mt-0.5 text-[12px] text-ink-3">
              <span className={cx("font-semibold tabular-nums", tone === "bad" && "text-bad")}>
                {formatMoney(item.amount)}
              </span>{" "}
              · due{" "}
              {new Date(item.dueDate + "T00:00:00").toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })}
              {tone === "bad" ? " - overdue" : ""}
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          {receiving ? (
            <Button size="sm" variant="secondary" onClick={() => openRemind(item)}>
              <BellRing className="size-3.5" />
              Remind
            </Button>
          ) : (
            <Button size="sm" onClick={() => openPay(item)}>
              <Receipt className="size-3.5" />
              Pay now
            </Button>
          )}
          <Link
            href={`/loans/${item.loanId}`}
            className="tap ml-auto px-2 text-[12px] font-semibold text-ink-3"
          >
            View loan
          </Link>
        </div>
      </Card>
    );
  };

  return (
    <MobileShell title="Activity">
      <div className="px-4 pb-8 pt-3">
        {loadError && (
          <Notice
            tone="warn"
            className="mb-4"
            onDismiss={() => setLoadError(null)}
            action={
              <Button size="sm" variant="secondary" onClick={() => setRefreshKey((key) => key + 1)}>
                <RotateCw className="size-3.5" />
                Try again
              </Button>
            }
          >
            {loadError}
          </Notice>
        )}

        {loading && dueItems.length === 0 && !loadError && <ListSkeleton rows={4} />}

        {overdue.length > 0 && (
          <section className="mb-6">
            <SectionHeader
              title="Overdue"
              count={overdue.length}
              action={<Badge tone="bad">needs action</Badge>}
            />
            <div className="stagger space-y-2.5">{overdue.map((item) => dueRow(item, "bad"))}</div>
          </section>
        )}

        {dueSoon.length > 0 && (
          <section className="mb-6">
            <SectionHeader title="Due soon" count={dueSoon.length} />
            <div className="stagger space-y-2.5">{dueSoon.map((item) => dueRow(item, "warn"))}</div>
          </section>
        )}

        {!loading && overdue.length === 0 && dueSoon.length === 0 && !loadError && (
          <Card padded={false} className="mb-6">
            <EmptyState
              icon={<Check className="size-6" />}
              title="All quiet"
              body="Nothing is overdue and nothing is due in the next week. We'll tell you when something is."
            />
          </Card>
        )}

        {/* Notifications: loans added, payments marked/confirmed/rejected,
            reminders sent. Always rendered - an empty section that says so is
            how you know nothing is wrong. */}
        {!loading && (
          <section className="mb-6">
            <SectionHeader
              title="Notifications"
              action={
                justArrived > 0 ? (
                  <Badge tone="brand">{justArrived} new</Badge>
                ) : undefined
              }
            />

            {notifications.length === 0 ? (
              <Card>
                <p className="text-[13px] leading-relaxed text-ink-3">
                  Nothing here yet. When someone adds a loan for you, marks a payment, confirms or
                  rejects one, or changes the loan, it shows up here - and on your phone if
                  you&apos;ve turned notifications on.
                </p>
              </Card>
            ) : (
              <ul className="stagger space-y-2.5">
                {notifications.map((n) => (
                  <Card as="li" key={n.id} className="p-0">
                    <Link
                      href={`/loans/${n.loanId}`}
                      className="tap block px-4 py-3.5 hover:bg-surface-2"
                    >
                      <p className="text-[13px] leading-snug text-ink-2">{n.message}</p>
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                        <Clock className="size-3" />
                        {new Date(n.sentAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {n.status && n.status !== "sent" ? ` · ${n.status}` : ""}
                      </p>
                    </Link>
                  </Card>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* What the app will do on its own, so nobody has to guess. */}
        <Card className="mt-4">
          <div className="flex items-center gap-2">
            <HandCoins className="size-4 text-ink-2" />
            <h3 className="text-[13px] font-semibold text-ink">Reminders you don&apos;t send</h3>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {[
              ["T-2", "2 days before it is due"],
              ["T-1", "1 day before it is due"],
              ["T0", "on the due date"],
              ["7d", "daily while overdue"],
            ].map(([tag, text]) => (
              <div key={tag} className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-[11px] font-bold text-ink-2">
                  {tag}
                </span>
                <span className="text-[11px] leading-snug text-ink-3">{text}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {payTarget && (
        <PaySheet
          key={payTarget.installmentId}
          target={payTarget}
          onClose={() => setPayFor(null)}
          onRecorded={() => {
            setRefreshKey((key) => key + 1);
          }}
        />
      )}

      {remindTarget && (
        <RemindSheet
          key={remindTarget.installmentId}
          target={remindTarget}
          onClose={() => setRemindFor(null)}
          onSent={() => {
            setRefreshKey((key) => key + 1);
          }}
        />
      )}
    </MobileShell>
  );
}
