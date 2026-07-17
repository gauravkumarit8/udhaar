"use client";

import { useState, useEffect, useCallback } from "react";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";
import { useAppResume, useHaptics } from "@/hooks/useNative";

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

interface Loan {
  id: string;
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
  summary: {
    youWillReceive: number;
    youWillPay: number; // now computed from loans where you're the borrower
    dueThisWeek: number;
    totalInterestEarned: number;
    activeLoans: number;
    totalLoans: number;
  };
  dueItems: DueItem[];
  loans: Loan[];
}

function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.floor((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [user, setUser] = useState<{ name: string; mobile: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [greeting, setGreeting] = useState("Good morning");
  const haptics = useHaptics();

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting("Good morning");
    else if (hour < 17) setGreeting("Good afternoon");
    else setGreeting("Good evening");
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [dashRes, meRes] = await Promise.all([
        fetch("/api/dashboard"),
        fetch("/api/auth/me"),
      ]);

      if (meRes.status === 401) {
        window.location.href = "/login";
        return;
      }

      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData.user) setUser(meData.user);
      }

      if (dashRes.ok) {
        const dashData = await dashRes.json();
        setData(dashData);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh data when app comes to foreground
  useAppResume(() => { loadData(); });

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center max-w-lg mx-auto">
        <div className="text-center animate-scale-in">
          <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4 animate-bounce">
            💰
          </div>
          <p className="text-slate-400 text-sm">Loading your dashboard...</p>
          <div className="mt-4 w-32 h-1.5 bg-slate-200 rounded-full mx-auto overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full animate-[shimmer_1.5s_infinite]" style={{ width: "60%" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center max-w-lg mx-auto">
        <div className="text-center">
          <div className="text-5xl mb-4">😕</div>
          <p className="text-slate-600 font-medium">Failed to load dashboard</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 bg-emerald-600 text-white px-8 py-3 rounded-2xl font-semibold tap-highlight"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { summary, dueItems, loans } = data;

  return (
    <MobileShell>
      {/* Header Section */}
      <div className="bg-gradient-to-b from-emerald-700 via-emerald-700 to-emerald-800 px-5 pt-5 pb-8 -mb-4">
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-emerald-200 text-sm">{greeting} 👋</p>
            <h1 className="text-2xl font-extrabold text-white mt-0.5">
              {user?.name || "User"}
            </h1>
          </div>
          <div className="w-11 h-11 bg-white/20 backdrop-blur rounded-full flex items-center justify-center text-lg">
            {user?.name?.charAt(0).toUpperCase() || "U"}
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white/15 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 bg-emerald-400/30 rounded-lg flex items-center justify-center text-sm">📥</div>
              <span className="text-emerald-200 text-xs font-medium">You&apos;ll Receive</span>
            </div>
            <p className="text-2xl font-extrabold text-white">
              {formatINR(summary.youWillReceive)}
            </p>
          </div>
          <div className="bg-white/15 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 bg-red-400/30 rounded-lg flex items-center justify-center text-sm">📤</div>
              <span className="text-emerald-200 text-xs font-medium">You&apos;ll Pay</span>
            </div>
            <p className="text-2xl font-extrabold text-white">
              {formatINR(summary.youWillPay)}
            </p>
          </div>
          <div className="bg-white/15 backdrop-blur-md rounded-2xl p-4 border border-white/10 col-span-2">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 bg-amber-400/30 rounded-lg flex items-center justify-center text-sm">⏰</div>
              <span className="text-emerald-200 text-xs font-medium">Due This Week (both sides)</span>
            </div>
            <p className="text-2xl font-extrabold text-white">
              {formatINR(summary.dueThisWeek)}
            </p>
          </div>
        </div>
      </div>

      <div className="px-5 space-y-6 pb-8">
        {/* Quick Stats */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center justify-around">
          <div className="text-center">
            <p className="text-2xl font-extrabold text-emerald-600">{summary.activeLoans}</p>
            <p className="text-xs text-slate-400 font-medium">Active</p>
          </div>
          <div className="w-px h-8 bg-slate-100" />
          <div className="text-center">
            <p className="text-2xl font-extrabold text-slate-700">{summary.totalLoans}</p>
            <p className="text-xs text-slate-400 font-medium">Total</p>
          </div>
          <div className="w-px h-8 bg-slate-100" />
          <div className="text-center">
            <p className="text-2xl font-extrabold text-amber-600">{formatINR(summary.totalInterestEarned)}</p>
            <p className="text-xs text-slate-400 font-medium">Interest</p>
          </div>
        </div>

        {/* Due Items */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-slate-800">Upcoming & Overdue</h2>
            {dueItems.length > 3 && (
              <span className="text-xs text-emerald-600 font-semibold">{dueItems.length} items</span>
            )}
          </div>

          {dueItems.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <div className="text-5xl mb-3">🎉</div>
              <p className="text-slate-700 font-semibold">All caught up!</p>
              <p className="text-slate-400 text-sm mt-1">No pending payments right now</p>
              <a
                href="/loans/new"
                className="inline-flex items-center gap-2 mt-4 bg-emerald-600 text-white px-6 py-2.5 rounded-2xl font-semibold text-sm tap-highlight"
              >
                <span>+</span> Add Your First Loan
              </a>
            </div>
          ) : (
            <div className="space-y-2.5">
              {dueItems.slice(0, 5).map((item, idx) => {
                const days = daysUntil(item.dueDate);
                const isOverdue = item.computedStatus === "overdue";
                const isDueSoon = item.computedStatus === "due_soon";
                const displayName =
                  item.viewerRole === "lender" ? item.borrowerName : item.lenderName || "Lender";
                const dayLabel =
                  days < 0
                    ? `${Math.abs(days)}d overdue`
                    : days === 0
                    ? "Today"
                    : days === 1
                    ? "Tomorrow"
                    : `${days}d left`;

                return (
                  <a
                    key={idx}
                    href={`/loans/${item.loanId}`}
                    className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center gap-3.5 tap-highlight active:bg-slate-50 transition-all"
                  >
                    <div
                      className={`w-11 h-11 rounded-2xl flex items-center justify-center font-bold text-sm text-white shrink-0 ${
                        isOverdue
                          ? "bg-red-500"
                          : isDueSoon
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                      }`}
                    >
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-semibold text-slate-800 text-[15px] truncate">
                          {displayName}
                        </p>
                        <span
                          className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                            item.viewerRole === "lender"
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-orange-100 text-orange-700"
                          }`}
                        >
                          {item.viewerRole === "lender" ? "OWED TO YOU" : "YOU OWE"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <div
                          className={`w-1.5 h-1.5 rounded-full ${
                            isOverdue
                              ? "bg-red-500"
                              : isDueSoon
                              ? "bg-amber-400"
                              : "bg-slate-300"
                          }`}
                        />
                        <span
                          className={`text-xs font-medium ${
                            isOverdue
                              ? "text-red-600"
                              : isDueSoon
                              ? "text-amber-600"
                              : "text-slate-400"
                          }`}
                        >
                          {dayLabel}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-slate-800 text-[15px]">
                        {formatINR(item.amount)}
                      </p>
                      <p className="text-xs text-slate-400">
                        {isOverdue ? "Overdue" : isDueSoon ? "Due soon" : "Upcoming"}
                      </p>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </div>

        {/* Your Loans */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-slate-800">Your Loans</h2>
            <a href="/loans/new" className="text-xs text-emerald-600 font-semibold tap-highlight">
              + New
            </a>
          </div>

          {loans.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <div className="text-4xl mb-2">🤝</div>
              <p className="text-slate-500 text-sm">No loans yet</p>
              <p className="text-slate-400 text-xs mt-1">Tap + to add your first loan</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {loans.map((loan) => {
                const displayName =
                  loan.viewerRole === "lender" ? loan.borrowerName : loan.lenderName || "Lender";
                return (
                <a
                  key={loan.id}
                  href={`/loans/${loan.id}`}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center gap-3.5 tap-highlight active:bg-slate-50 transition-all"
                >
                  <div
                    className={`w-11 h-11 rounded-2xl flex items-center justify-center font-bold text-sm text-white shrink-0 ${
                      loan.status === "active" ? "bg-emerald-500" : "bg-slate-400"
                    }`}
                  >
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-slate-800 text-[15px] truncate">
                        {displayName}
                      </p>
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
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          loan.status === "active"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {loan.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {formatINR(parseFloat(loan.amount))} · {loan.interestRate}%{loan.interestRatePeriod === "monthly" ? "/mo" : "/yr"} · {loan.tenureMonths}mo
                    </p>
                  </div>
                  <svg
                    className="w-5 h-5 text-slate-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <BottomNav />
    </MobileShell>
  );
}
