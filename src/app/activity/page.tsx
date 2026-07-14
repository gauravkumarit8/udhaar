"use client";

import { useState, useEffect } from "react";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";

interface Reminder {
  id: string;
  installmentId: string;
  loanId: string;
  channel: string;
  message: string;
  sentAt: string;
  status: string;
}

interface DueItem {
  loanId: string;
  borrowerName: string;
  installmentId: string;
  dueDate: string;
  amount: number;
  computedStatus: string;
}

export default function ActivityPage() {
  const [dueItems, setDueItems] = useState<DueItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/dashboard");
        if (res.ok) {
          const data = await res.json();
          setDueItems(data.dueItems || []);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleRemind = async (installmentId: string) => {
    await fetch(`/api/installments/${installmentId}/remind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "sms" }),
    });
  };

  const overdue = dueItems.filter((d) => d.computedStatus === "overdue");
  const dueSoon = dueItems.filter((d) => d.computedStatus === "due_soon");

  return (
    <MobileShell title="Activity">
      <div className="px-5 pb-24">
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
                      <p className="font-bold text-slate-800">{item.borrowerName}</p>
                      <p className="text-xs text-red-600 mt-0.5">
                        Due {new Date(item.dueDate + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ₹{item.amount.toLocaleString("en-IN")}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemind(item.installmentId)}
                      className="bg-red-600 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                    >
                      🔔 Remind Now
                    </button>
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
                      <p className="font-bold text-slate-800">{item.borrowerName}</p>
                      <p className="text-xs text-amber-600 mt-0.5">
                        Due {new Date(item.dueDate + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ₹{item.amount.toLocaleString("en-IN")}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemind(item.installmentId)}
                      className="bg-amber-500 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                    >
                      🔔 Remind
                    </button>
                  </div>
                </div>
              ))}
            </div>
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
