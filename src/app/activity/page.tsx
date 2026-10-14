"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";
import { readApi, requestJson } from "@/lib/http";

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
  dueDate: string;
  amount: number;
  computedStatus: string;
  viewerRole: "lender" | "borrower";
}

export default function ActivityPage() {
  const [dueItems, setDueItems] = useState<DueItem[]>([]);
  const [notifications, setNotifications] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [justArrived, setJustArrived] = useState(0);
  /** Notification ids already rendered, so arrivals mid-session can be called out. */
  const knownIds = useRef<Set<string>>(new Set());

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
      const [dashRes, notifRes] = await Promise.all([
        fetch("/api/dashboard"),
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

  const [reminderNote, setReminderNote] = useState<string | null>(null);
  /** Fallback when the browser blocks the WhatsApp/SMS pop-up after an await. */
  const [reminderLink, setReminderLink] = useState<{ href: string; label: string } | null>(null);

  /**
   * Same rule as the loan screen: WhatsApp first, because the borrower may
   * never have installed this app. Push is attempted alongside it when they
   * have an account, but it is no longer the only thing we can offer.
   */
  const handleRemind = async (installmentId: string, channel: "whatsapp" | "sms" | "push" = "whatsapp") => {
    try {
      const result = await requestJson<{
        delivered?: boolean;
        reason?: string;
        share?: { whatsappUrl: string; smsUrl: string };
      }>(`/api/installments/${installmentId}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });

      if (!result.ok) {
        setReminderNote(result.error || "Reminder not sent");
      } else if (channel === "push") {
        setReminderNote(
          result.data?.delivered ? "✓ Delivered to their phone" : result.data?.reason || "Not delivered"
        );
      } else {
        const url = channel === "whatsapp" ? result.data?.share?.whatsappUrl : result.data?.share?.smsUrl;
        const appName = channel === "whatsapp" ? "WhatsApp" : "your messages";
        const opened = url ? window.open(url, "_blank") : null;
        setReminderNote(
          opened ? `Reminder ready in ${appName} - press send there` : `Reminder recorded - tap below to open ${appName}`
        );
        setReminderLink(!opened && url ? { href: url, label: `Open ${appName}` } : null);
      }
    } catch {
      setReminderNote("Network error - reminder not sent");
    }
    setTimeout(() => {
      setReminderNote(null);
      setReminderLink(null);
    }, 8000);
  };

  const overdue = dueItems.filter((d) => d.computedStatus === "overdue");
  const dueSoon = dueItems.filter((d) => d.computedStatus === "due_soon");

  return (
    <MobileShell title="Activity">
      <div className="px-5 pb-24">
        {reminderNote && (
          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-2xl p-3.5 text-xs text-blue-800 animate-scale-in">
            {reminderNote}
            {reminderLink && (
              <a
                href={reminderLink.href}
                target="_blank"
                rel="noreferrer"
                className="block mt-1.5 font-semibold text-blue-700 underline"
              >
                {reminderLink.label}
              </a>
            )}
          </div>
        )}
        {/* Overdue Section */}
        {overdue.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <h2 className="text-base font-bold text-red-600">Overdue ({overdue.length})</h2>
            </div>
            <div className="space-y-2.5">
              {overdue.map((item, idx) => (
                <div
                  key={idx}
                  className="bg-red-50 rounded-2xl p-4 border border-red-100"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-slate-800">{item.viewerRole === "lender" ? item.borrowerName : (item.lenderName || "Lender")}</p>
                      <p className="text-xs text-red-600 mt-0.5">
                        Due {new Date(item.dueDate + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ₹{item.amount.toLocaleString("en-IN")}
                        {item.viewerRole === "borrower" && (
                          <span className="ml-1.5 text-[10px] font-bold bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">YOU OWE</span>
                        )}
                      </p>
                    </div>
                    {item.viewerRole === "lender" ? (
                      <button
                        onClick={() => handleRemind(item.installmentId)}
                        className="bg-red-600 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                      >
                        🔔 Remind Now
                      </button>
                    ) : (
                      <a
                        href={`/loans/${item.loanId}`}
                        className="bg-red-600 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                      >
                        Pay Now
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Due Soon Section */}
        {dueSoon.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 bg-amber-400 rounded-full" />
              <h2 className="text-base font-bold text-amber-600">Due Soon ({dueSoon.length})</h2>
            </div>
            <div className="space-y-2.5">
              {dueSoon.map((item, idx) => (
                <div
                  key={idx}
                  className="bg-amber-50 rounded-2xl p-4 border border-amber-100"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-slate-800">{item.viewerRole === "lender" ? item.borrowerName : (item.lenderName || "Lender")}</p>
                      <p className="text-xs text-amber-600 mt-0.5">
                        Due {new Date(item.dueDate + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ₹{item.amount.toLocaleString("en-IN")}
                        {item.viewerRole === "borrower" && (
                          <span className="ml-1.5 text-[10px] font-bold bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">YOU OWE</span>
                        )}
                      </p>
                    </div>
                    {item.viewerRole === "lender" ? (
                      <button
                        onClick={() => handleRemind(item.installmentId)}
                        className="bg-amber-500 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                      >
                        🔔 Remind
                      </button>
                    ) : (
                      <a
                        href={`/loans/${item.loanId}`}
                        className="bg-amber-500 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                      >
                        Pay Now
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* A failed load used to look like an empty page */}
        {loadError && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <p className="text-sm text-amber-800">{loadError}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 text-xs font-semibold text-amber-900 underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {overdue.length === 0 && dueSoon.length === 0 && (
          <div className="text-center py-16">
            <div className="text-6xl mb-4">🔔</div>
            <h3 className="text-xl font-bold text-slate-700">All Quiet!</h3>
            <p className="text-slate-400 text-sm mt-1">No overdue or upcoming reminders</p>
          </div>
        )}

        {/* Notifications: loans added, payments marked/confirmed/rejected,
            reminders sent. Always rendered - an empty section that says so is
            how you know nothing is wrong. */}
        {!loading && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 bg-blue-400 rounded-full" />
              <h2 className="text-base font-bold text-slate-700">Notifications</h2>
              {justArrived > 0 && (
                <span className="text-[10px] font-bold bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full animate-scale-in">
                  {justArrived} new
                </span>
              )}
            </div>
            {notifications.length === 0 && (
              <p className="text-xs text-slate-400 bg-white rounded-2xl border border-slate-100 p-4">
                Nothing here yet. When someone adds a loan for you, marks a payment, confirms or
                rejects one, or changes the loan, it shows up here - and on your phone if you&apos;ve
                turned notifications on.
              </p>
            )}
            <div className="space-y-2.5">
              {notifications.map((n) => (
                <a
                  key={n.id}
                  href={`/loans/${n.loanId}`}
                  className="block bg-white rounded-2xl p-4 border border-slate-100 tap-highlight active:bg-slate-50 transition-all"
                >
                  <p className="text-sm text-slate-700">{n.message}</p>
                  <p className="text-[11px] text-slate-400 mt-1.5">
                    {new Date(n.sentAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  </p>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Smart Reminder Info */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 mt-4">
          <h3 className="font-bold text-sm text-slate-700 mb-2">⏰ Smart Reminders</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="w-8 h-8 bg-emerald-100 rounded-xl flex items-center justify-center text-sm shrink-0">T-2</span>
              <span>2 days before due date</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="w-8 h-8 bg-amber-100 rounded-xl flex items-center justify-center text-sm shrink-0">T-1</span>
              <span>1 day before due date</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="w-8 h-8 bg-red-100 rounded-xl flex items-center justify-center text-sm shrink-0">T0</span>
              <span>On due date</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="w-8 h-8 bg-red-100 rounded-xl flex items-center justify-center text-sm shrink-0">7d</span>
              <span>Daily nag for 7 days if overdue</span>
            </div>
          </div>
        </div>
      </div>

      <BottomNav />
    </MobileShell>
  );
}
