"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import BottomSheet from "@/components/BottomSheet";
import MobileShell from "@/components/MobileShell";
import ProofUpload from "@/components/ProofUpload";
import ShareButton from "@/components/ShareButton";
import { useHaptics, useReminders, useAppResume } from "@/hooks/useNative";

interface Loan {
  id: string;
  borrowerName: string;
  borrowerMobile: string;
  amount: string;
  interestRate: string;
  interestRatePeriod: string;
  tenureMonths: number;
  startDate: string;
  upiId: string | null;
  accountNumber: string | null;
  notes: string | null;
  status: string;
  confirmationMode: string;
  createdAt: string;
}

interface Installment {
  id: string;
  installmentNumber: number;
  dueDate: string;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  principalPaid: string;
  interestPaid: string;
  computedStatus: string;
}

interface Payment {
  id: string;
  installmentId: string;
  amount: string;
  paymentType: string;
  proofUrl: string | null;
  markedByUserId: string;
  confirmedByUserId: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
}

function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.floor((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function LoanDetailPage() {
  const params = useParams();
  const loanId = params.id as string;

  const [loan, setLoan] = useState<Loan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [payModal, setPayModal] = useState<{
    installment: Installment;
    type: "interest" | "principal" | "both";
  } | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [payProof, setPayProof] = useState<string | null>(null);
  const [payLoading, setPayLoading] = useState(false);
  const [reminderSent, setReminderSent] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"schedule" | "payments">("schedule");
  const [showUPI, setShowUPI] = useState(false);
  const [editForm, setEditForm] = useState<{
    borrowerName: string;
    borrowerMobile: string;
    amount: string;
    interestRate: string;
    interestRatePeriod: "monthly" | "yearly";
    tenureMonths: string;
    startDate: string;
    upiId: string;
    accountNumber: string;
    notes: string;
    confirmationMode: "1-side" | "2-side";
  } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  // Native hooks
  const haptics = useHaptics();
  const reminders = useReminders();
  const handleResume = useCallback(() => { loadData(); }, []);
  useAppResume(handleResume);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/loans/${loanId}`);
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (res.ok) {
          const data = await res.json();
          setLoan(data.loan);
          setInstallments(data.installments);
          setPayments(data.payments);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [loanId]);

  const loadData = async () => {
    const res = await fetch(`/api/loans/${loanId}`);
    if (res.ok) {
      const data = await res.json();
      setLoan(data.loan);
      setInstallments(data.installments);
      setPayments(data.payments);
    }
  };

  const handlePay = async () => {
    if (!payModal || !payAmount) return;
    setPayLoading(true);
    try {
      const res = await fetch(`/api/installments/${payModal.installment.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: payAmount,
          paymentType: payModal.type,
          notes: payNotes || undefined,
          proofUrl: payProof || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        haptics.notification("success");
        setPayModal(null);
        setPayAmount("");
        setPayNotes("");
        setPayProof(null);
        // Cancel reminders for this installment if fully paid
        if (data.applied) {
          const inst = payModal.installment;
          const pRemaining = parseFloat(inst.principalAmount) - data.applied.principal;
          const iRemaining = parseFloat(inst.interestAmount) - data.applied.interest;
          if (pRemaining <= 0 && iRemaining <= 0) {
            reminders.cancel(inst.id);
          }
        }
        await loadData();
      }
    } catch {
      // ignore
    } finally {
      setPayLoading(false);
    }
  };

  const handleRemind = async (installmentId: string) => {
    haptics.tap();
    try {
      const res = await fetch(`/api/installments/${installmentId}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "sms" }),
      });
      const data = await res.json();
      if (data.success) {
        setReminderSent(installmentId);
        haptics.notification("success");
        // Also schedule native local notifications
        const inst = installments.find((i) => i.id === installmentId);
        if (inst && loan) {
          const remaining = parseFloat(inst.totalAmount) - parseFloat(inst.principalPaid) - parseFloat(inst.interestPaid);
          reminders.schedule(installmentId, inst.dueDate, loan.borrowerName, remaining);
        }
        setTimeout(() => setReminderSent(null), 3000);
      }
    } catch {
      // ignore
    }
  };

  const handleCloseLoan = async () => {
    if (!confirm("Close this loan? All principal must be paid.")) return;
    try {
      const res = await fetch(`/api/loans/${loanId}/close`, { method: "POST" });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        await loadData();
      }
    } catch {
      // ignore
    }
  };

  const openEditForm = () => {
    if (!loan) return;
    setEditError("");
    setEditForm({
      borrowerName: loan.borrowerName,
      borrowerMobile: loan.borrowerMobile,
      amount: loan.amount,
      interestRate: loan.interestRate,
      interestRatePeriod: loan.interestRatePeriod === "monthly" ? "monthly" : "yearly",
      tenureMonths: String(loan.tenureMonths),
      startDate: loan.startDate,
      upiId: loan.upiId || "",
      accountNumber: loan.accountNumber || "",
      notes: loan.notes || "",
      confirmationMode: loan.confirmationMode === "2-side" ? "2-side" : "1-side",
    });
  };

  const handleSaveEdit = async () => {
    if (!editForm) return;
    setSavingEdit(true);
    setEditError("");

    try {
      const res = await fetch(`/api/loans/${loanId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setEditError(data.error || "Unable to update loan");
        return;
      }

      setEditForm(null);
      await loadData();
    } catch {
      setEditError("Something went wrong while updating the loan");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteLoan = async () => {
    if (!confirm("Delete this loan and all associated records? This action cannot be undone.")) return;

    try {
      const res = await fetch(`/api/loans/${loanId}`, { method: "DELETE" });
      const data = await res.json();

      if (!res.ok || data.error) {
        alert(data.error || "Unable to delete loan");
        return;
      }

      window.location.href = "/dashboard";
    } catch {
      alert("Something went wrong while deleting the loan");
    }
  };

  const handleConfirmPayment = async (paymentId: string, action: "confirm" | "reject") => {
    try {
      await fetch(`/api/payments/${paymentId}/confirm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await loadData();
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center max-w-lg mx-auto">
        <div className="text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4 animate-bounce">
            💰
          </div>
          <p className="text-slate-400 text-sm">Loading loan details...</p>
        </div>
      </div>
    );
  }

  if (!loan) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center max-w-lg mx-auto">
        <div className="text-center">
          <div className="text-5xl mb-4">😕</div>
          <p className="text-slate-600 font-medium">Loan not found</p>
          <a href="/dashboard" className="text-emerald-600 mt-4 inline-block font-semibold">
            ← Back to Dashboard
          </a>
        </div>
      </div>
    );
  }

  const paidInstallments = installments.filter((i) => i.computedStatus === "paid").length;
  const progressPercent = installments.length > 0
    ? Math.round((paidInstallments / installments.length) * 100)
    : 0;
  const totalPrincipalPaid = installments.reduce((sum, i) => sum + parseFloat(i.principalPaid), 0);
  const totalPrincipal = installments.reduce((sum, i) => sum + parseFloat(i.principalAmount), 0);
  const principalProgressPercent = totalPrincipal > 0 ? Math.round((totalPrincipalPaid / totalPrincipal) * 100) : 0;

  const upiLink = loan.upiId
    ? `upi://pay?pa=${loan.upiId}&pn=${encodeURIComponent(loan.borrowerName)}`
    : null;

  return (
    <MobileShell
      title={loan.borrowerName}
      showNav={false}
      rightAction={
        <button
          onClick={() => setShowUPI(true)}
          className="text-sm text-emerald-600 font-medium tap-highlight"
        >
          ℹ️
        </button>
      }
    >
      {/* Back button */}
      <div className="px-5 pt-2">
        <a
          href="/dashboard"
          className="text-emerald-600 text-sm font-medium tap-highlight inline-flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Dashboard
        </a>
      </div>

      {/* Loan Summary Card */}
      <div className="mx-5 mt-3 bg-gradient-to-br from-emerald-600 to-emerald-700 rounded-3xl p-5 shadow-lg shadow-emerald-600/20">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center text-xl text-white font-bold">
              {loan.borrowerName.charAt(0).toUpperCase()}
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">{loan.borrowerName}</h2>
              <p className="text-emerald-200 text-xs">+91 {loan.borrowerMobile}</p>
            </div>
          </div>
          <span
            className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${
              loan.status === "active"
                ? "bg-emerald-400/30 text-emerald-100"
                : "bg-slate-400/30 text-slate-200"
            }`}
          >
            {loan.status.toUpperCase()}
          </span>
        </div>

        {/* Amount Grid */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="text-center">
            <p className="text-2xl font-extrabold text-white">{formatINR(parseFloat(loan.amount))}</p>
            <p className="text-emerald-200 text-[10px] font-medium">PRINCIPAL</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-extrabold text-white">{loan.interestRate}%</p>
            <p className="text-emerald-200 text-[10px] font-medium">{loan.interestRatePeriod === "monthly" ? "MONTHLY" : "YEARLY"}</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-extrabold text-white">{loan.tenureMonths}</p>
            <p className="text-emerald-200 text-[10px] font-medium">MONTHS</p>
          </div>
        </div>

        {/* Progress */}
        <div>
          <div className="flex justify-between text-xs text-emerald-200 mb-1.5">
            <span>{paidInstallments}/{installments.length} EMIs</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-2 bg-emerald-500/50 rounded-full overflow-hidden">
            <div
              className="h-full bg-white rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-emerald-200 text-[10px] mt-1.5">
            Principal: {formatINR(totalPrincipalPaid)} of {formatINR(totalPrincipal)} ({principalProgressPercent}%)
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mt-4">
          {upiLink && (
            <a
              href={upiLink}
              className="flex-1 bg-white text-emerald-700 font-semibold py-2.5 rounded-2xl text-sm text-center tap-highlight active:bg-emerald-50 transition"
            >
              📱 Pay via UPI
            </a>
          )}
          {loan.status === "active" && (
            <button
              onClick={handleCloseLoan}
              className="flex-1 bg-emerald-500/40 text-white font-semibold py-2.5 rounded-2xl text-sm tap-highlight active:bg-emerald-500/60 transition"
            >
              🔒 Close Loan
            </button>
          )}
        </div>


        {/* Share / Invite */}
        <div className="mt-3">
          <ShareButton
            borrowerName={loan.borrowerName}
            borrowerMobile={loan.borrowerMobile}
            amount={loan.amount}
            upiId={loan.upiId}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="mx-5 mt-5 mb-4 flex bg-slate-100 rounded-2xl p-1">
        <button
          onClick={() => setActiveTab("schedule")}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            activeTab === "schedule"
              ? "bg-white text-emerald-700 shadow-sm"
              : "text-slate-400"
          }`}
        >
          📅 EMI Schedule
        </button>
        <button
          onClick={() => setActiveTab("payments")}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            activeTab === "payments"
              ? "bg-white text-emerald-700 shadow-sm"
              : "text-slate-400"
          }`}
        >
          💳 Payments ({payments.length})
        </button>
      </div>

      {/* Schedule */}
      {activeTab === "schedule" && (
        <div className="px-5 pb-24 space-y-2.5">
          {installments.map((inst) => {
            const days = daysUntil(inst.dueDate);
            const principalRemaining = parseFloat(inst.principalAmount) - parseFloat(inst.principalPaid);
            const interestRemaining = parseFloat(inst.interestAmount) - parseFloat(inst.interestPaid);
            const totalRemaining = principalRemaining + interestRemaining;
            const isPaid = inst.computedStatus === "paid";
            const isOverdue = inst.computedStatus === "overdue";
            const isDueSoon = inst.computedStatus === "due_soon";

            const bgColors: Record<string, string> = {
              paid: "bg-emerald-50 border-emerald-200",
              overdue: "bg-red-50 border-red-200",
              due_soon: "bg-amber-50 border-amber-200",
              partially_paid: "bg-blue-50 border-blue-200",
              pending: "bg-white border-slate-100",
            };

            const dotColors: Record<string, string> = {
              paid: "bg-emerald-500",
              overdue: "bg-red-500",
              due_soon: "bg-amber-400",
              partially_paid: "bg-blue-400",
              pending: "bg-slate-300",
            };

            const statusLabel: Record<string, string> = {
              paid: "PAID ✓",
              overdue: "OVERDUE",
              due_soon: days === 0 ? "TODAY" : `${days}d`,
              partially_paid: "PARTIAL",
              pending: `${days}d`,
            };

            return (
              <div
                key={inst.id}
                className={`rounded-2xl p-4 border ${bgColors[inst.computedStatus]} transition-all`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-2.5 h-2.5 rounded-full mt-1.5 ${dotColors[inst.computedStatus]}`}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-slate-800 text-[15px]">
                          EMI #{inst.installmentNumber}
                        </p>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            isPaid
                              ? "bg-emerald-100 text-emerald-700"
                              : isOverdue
                              ? "bg-red-100 text-red-700"
                              : isDueSoon
                              ? "bg-amber-100 text-amber-700"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {statusLabel[inst.computedStatus]}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">{formatDate(inst.dueDate)}</p>
                      <div className="mt-2 space-y-0.5">
                        <p className="text-xs text-slate-500">
                          Interest: ₹{parseFloat(inst.interestAmount).toLocaleString("en-IN")}
                          {parseFloat(inst.interestPaid) > 0 && (
                            <span className="text-emerald-600"> (₹{parseFloat(inst.interestPaid).toLocaleString("en-IN")} paid)</span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500">
                          Principal: ₹{parseFloat(inst.principalAmount).toLocaleString("en-IN")}
                          {parseFloat(inst.principalPaid) > 0 && (
                            <span className="text-emerald-600"> (₹{parseFloat(inst.principalPaid).toLocaleString("en-IN")} paid)</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  {!isPaid && (
                    <p className="font-bold text-slate-800 text-lg shrink-0">
                      {formatINR(totalRemaining)}
                    </p>
                  )}
                </div>

                {/* Action buttons */}
                {!isPaid && (
                  <div className="flex gap-2 mt-3 ml-5">
                    <button
                      onClick={() => {
                        setPayModal({ installment: inst, type: "both" });
                        setPayAmount(totalRemaining.toFixed(2));
                      }}
                      className="bg-emerald-600 active:bg-emerald-800 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                    >
                      Mark Paid
                    </button>
                    {interestRemaining > 0 && (
                      <button
                        onClick={() => {
                          setPayModal({ installment: inst, type: "interest" });
                          setPayAmount(interestRemaining.toFixed(2));
                        }}
                        className="bg-blue-600 active:bg-blue-800 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                      >
                        Interest Only
                      </button>
                    )}
                    <button
                      onClick={() => handleRemind(inst.id)}
                      className="bg-white active:bg-slate-100 text-slate-600 text-xs font-semibold px-4 py-2 rounded-xl border border-slate-200 tap-highlight"
                    >
                      {reminderSent === inst.id ? "✓ Sent!" : "🔔 Remind"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Payments Tab */}
      {activeTab === "payments" && (
        <div className="px-5 pb-24 space-y-2.5">
          {payments.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
              <div className="text-4xl mb-2">💳</div>
              <p className="text-slate-400 text-sm">No payments recorded yet</p>
            </div>
          ) : (
            payments.map((payment) => (
              <div
                key={payment.id}
                className={`bg-white rounded-2xl p-4 border ${
                  payment.status === "confirmed"
                    ? "border-emerald-200"
                    : payment.status === "rejected"
                    ? "border-red-200"
                    : "border-amber-200"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-bold text-slate-800">
                      {formatINR(parseFloat(payment.amount))}
                      <span className="text-xs text-slate-400 font-normal ml-1.5">
                        {payment.paymentType}
                      </span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      EMI #{installments.find((i) => i.id === payment.installmentId)?.installmentNumber ?? "?"}
                      {" · "}
                      {new Date(payment.createdAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                      payment.status === "confirmed"
                        ? "bg-emerald-100 text-emerald-700"
                        : payment.status === "rejected"
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {payment.status.toUpperCase()}
                  </span>
                </div>
                {payment.status === "pending" && (
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => handleConfirmPayment(payment.id, "confirm")}
                      className="flex-1 bg-emerald-600 text-white text-xs font-semibold py-2 rounded-xl tap-highlight"
                    >
                      ✓ Confirm
                    </button>
                    <button
                      onClick={() => handleConfirmPayment(payment.id, "reject")}
                      className="flex-1 bg-red-50 text-red-600 text-xs font-semibold py-2 rounded-xl border border-red-200 tap-highlight"
                    >
                      ✗ Reject
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Pay Bottom Sheet */}
      <BottomSheet
        open={!!payModal}
        onClose={() => { setPayModal(null); setPayProof(null); }}
        title="Record Payment"
        subtitle={
          payModal
            ? `EMI #${payModal.installment.installmentNumber} · ${payModal.type === "interest" ? "Interest" : payModal.type === "principal" ? "Principal" : "Full Payment"}`
            : ""
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Amount (₹)
            </label>
            <input
              type="number"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none text-2xl font-bold"
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            {(["both", "interest", "principal"] as const).map((t) => {
              const labels = { both: "Full", interest: "Interest", principal: "Principal" };
              const icons = { both: "💰", interest: "📊", principal: "🏦" };
              return (
                <button
                  key={t}
                  onClick={() => {
                    if (!payModal) return;
                    setPayModal({ ...payModal, type: t });
                    const p = parseFloat(payModal.installment.principalAmount) - parseFloat(payModal.installment.principalPaid);
                    const i = parseFloat(payModal.installment.interestAmount) - parseFloat(payModal.installment.interestPaid);
                    if (t === "both") setPayAmount((p + i).toFixed(2));
                    else if (t === "interest") setPayAmount(i.toFixed(2));
                    else setPayAmount(p.toFixed(2));
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all tap-highlight ${
                    payModal?.type === t
                      ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                      : "border-slate-200 text-slate-400"
                  }`}
                >
                  <div className="text-base mb-0.5">{icons[t]}</div>
                  {labels[t]}
                </button>
              );
            })}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Notes (optional)
            </label>
            <input
              type="text"
              value={payNotes}
              onChange={(e) => setPayNotes(e.target.value)}
              placeholder="Paid via UPI, cheque #123..."
              className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none"
            />
          </div>

          {/* Proof Upload */}
          <ProofUpload onCapture={(url) => setPayProof(url)} currentProof={payProof} />

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setPayModal(null)}
              className="flex-1 py-3.5 rounded-2xl border border-slate-200 text-slate-600 font-semibold tap-highlight"
            >
              Cancel
            </button>
            <button
              onClick={handlePay}
              disabled={payLoading || !payAmount}
              className="flex-[2] bg-emerald-600 active:bg-emerald-800 disabled:bg-slate-200 text-white font-bold py-3.5 rounded-2xl tap-highlight"
            >
              {payLoading ? "Recording..." : "Record Payment ✓"}
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* Edit Loan Bottom Sheet */}
      <div className="fixed left-0 right-0 z-40 px-3" style={{ bottom: "calc(4rem + env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur-xl">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={openEditForm}
              className="bg-emerald-600 text-white font-semibold py-3 rounded-xl text-sm tap-highlight"
            >
              ✏️ Edit Loan
            </button>
            <button
              onClick={handleDeleteLoan}
              className="bg-red-50 text-red-600 font-semibold py-3 rounded-xl border border-red-200 text-sm tap-highlight"
            >
              🗑️ Delete Loan
            </button>
          </div>
        </div>
      </div>

      <BottomSheet
        open={!!editForm}
        onClose={() => { setEditForm(null); setEditError(""); }}
        title="Edit Loan"
        subtitle="Update borrower and repayment details"
      >
        {editForm && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Borrower Name</label>
              <input
                value={editForm.borrowerName}
                onChange={(e) => setEditForm({ ...editForm, borrowerName: e.target.value })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Mobile Number</label>
              <input
                value={editForm.borrowerMobile}
                onChange={(e) => setEditForm({ ...editForm, borrowerMobile: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Amount (₹)</label>
              <input
                type="number"
                value={editForm.amount}
                onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Interest Rate</label>
                <input
                  type="number"
                  value={editForm.interestRate}
                  onChange={(e) => setEditForm({ ...editForm, interestRate: e.target.value })}
                  className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Tenure (months)</label>
                <input
                  type="number"
                  value={editForm.tenureMonths}
                  onChange={(e) => setEditForm({ ...editForm, tenureMonths: e.target.value })}
                  className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setEditForm({ ...editForm, interestRatePeriod: "yearly" })}
                className={`py-2.5 rounded-xl text-sm font-semibold border ${
                  editForm.interestRatePeriod === "yearly"
                    ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                    : "border-slate-200 text-slate-400"
                }`}
              >
                Yearly
              </button>
              <button
                onClick={() => setEditForm({ ...editForm, interestRatePeriod: "monthly" })}
                className={`py-2.5 rounded-xl text-sm font-semibold border ${
                  editForm.interestRatePeriod === "monthly"
                    ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                    : "border-slate-200 text-slate-400"
                }`}
              >
                Monthly
              </button>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Start Date</label>
              <input
                type="date"
                value={editForm.startDate}
                onChange={(e) => setEditForm({ ...editForm, startDate: e.target.value })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">UPI ID</label>
              <input
                value={editForm.upiId}
                onChange={(e) => setEditForm({ ...editForm, upiId: e.target.value })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Account Number</label>
              <input
                value={editForm.accountNumber}
                onChange={(e) => setEditForm({ ...editForm, accountNumber: e.target.value })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Notes</label>
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                rows={3}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setEditForm({ ...editForm, confirmationMode: "1-side" })}
                className={`py-2.5 rounded-xl text-sm font-semibold border ${
                  editForm.confirmationMode === "1-side"
                    ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                    : "border-slate-200 text-slate-400"
                }`}
              >
                1-side
              </button>
              <button
                onClick={() => setEditForm({ ...editForm, confirmationMode: "2-side" })}
                className={`py-2.5 rounded-xl text-sm font-semibold border ${
                  editForm.confirmationMode === "2-side"
                    ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                    : "border-slate-200 text-slate-400"
                }`}
              >
                2-side
              </button>
            </div>

            {editError && (
              <div className="bg-red-50 text-red-600 text-sm rounded-2xl p-3">{editError}</div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setEditForm(null); setEditError(""); }}
                className="flex-1 py-3.5 rounded-2xl border border-slate-200 text-slate-600 font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={savingEdit}
                className="flex-[2] bg-emerald-600 text-white font-bold py-3.5 rounded-2xl"
              >
                {savingEdit ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        )}
      </BottomSheet>

      {/* UPI/Info Bottom Sheet */}
      <BottomSheet
        open={showUPI}
        onClose={() => setShowUPI(false)}
        title="Loan Details"
        subtitle={`${loan.borrowerName} · +91 ${loan.borrowerMobile}`}
      >
        <div className="space-y-3 text-sm">
          {loan.upiId && (
            <div className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
              <span className="text-slate-500">UPI ID</span>
              <span className="font-mono font-semibold text-slate-800">{loan.upiId}</span>
            </div>
          )}
          {loan.accountNumber && (
            <div className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
              <span className="text-slate-500">Account</span>
              <span className="font-mono font-semibold text-slate-800">{loan.accountNumber}</span>
            </div>
          )}
          <div className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
            <span className="text-slate-500">Start Date</span>
            <span className="font-semibold text-slate-800">{formatDate(loan.startDate)}</span>
          </div>
          <div className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
            <span className="text-slate-500">Confirmation</span>
            <span className="font-semibold text-slate-800">{loan.confirmationMode}</span>
          </div>
          {loan.notes && (
            <div className="bg-slate-50 rounded-xl p-3">
              <p className="text-slate-500 mb-1">Notes</p>
              <p className="text-slate-800">{loan.notes}</p>
            </div>
          )}

          {upiLink && (
            <a
              href={upiLink}
              className="block w-full bg-emerald-600 text-white font-bold py-3.5 rounded-2xl text-center mt-4 tap-highlight"
            >
              📱 Open UPI App to Pay
            </a>
          )}
        </div>
      </BottomSheet>

      <BottomNav />
    </MobileShell>
  );
}
