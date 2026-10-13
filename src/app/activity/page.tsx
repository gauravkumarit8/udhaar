"use client";

import { useState, useEffect } from "react";
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

  useEffect(() => {
    async function load() {
      try {
        const [dashRes, notifRes] = await Promise.all([
          fetch("/api/dashboard"),
          fetch("/api/notifications"),
        ]);
        const [dashResult, notifResult] = await Promise.all([
          readApi<{ dueItems?: DueItem[] }>(dashRes),
          readApi<{ notifications?: Reminder[] }>(notifRes),
        ]);

        if (dashResult.ok) setDueItems(dashResult.data?.dueItems ?? []);
        if (notifResult.ok) setNotifications(notifResult.data?.notifications ?? []);

        // A silent failure used to leave this page looking merely empty.
        setLoadError(dashResult.error ?? notifResult.error ?? null);
      } catch {
        setLoadError("Couldn't load your activity. Check your connection and try again.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const [reminderNote, setReminderNote] = useState<string | null>(null);

  const handleRemind = async (installmentId: string) => {
    try {
      const result = await requestJson<{ delivered?: boolean; reason?: string }>(
        `/api/installments/${installmentId}/remind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: "push" }),
        }
      );

      setReminderNote(
        result.ok && result.data?.delivered
          ? "✓ Reminder delivered"
          : result.data?.reason || result.error || "Reminder recorded, but not delivered"
      );
    } catch {
      setReminderNote("Network error - reminder not sent");
    }
    setTimeout(() => setReminderNote(null), 5000);
  };

  const overdue = dueItems.filter((d) => d.computedStatus === "overdue");
  const dueSoon = dueItems.filter((d) => d.computedStatus === "due_soon");

  return (
    <MobileShell title="Activity">
      <div className="px-5 pb-24">
        {reminderNote && (
          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-2xl p-3.5 text-xs text-blue-800 animate-scale-in">
            {reminderNote}
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

        {/* Notifications (e.g. "loan added for you", reminders sent) */}
        {notifications.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 bg-blue-400 rounded-full" />
              <h2 className="text-base font-bold text-slate-700">Notifications</h2>
            </div>
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
