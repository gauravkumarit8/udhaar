"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import BottomSheet from "@/components/BottomSheet";
import MobileShell from "@/components/MobileShell";
import ProofUpload from "@/components/ProofUpload";
import ShareButton from "@/components/ShareButton";
import { useHaptics, useReminders, useAppResume } from "@/hooks/useNative";
import { requestJson } from "@/lib/http";
import { UNREAD_EVENT } from "@/lib/client-cache";
import { summarizeSettlement } from "@/lib/payments";

interface Loan {
  id: string;
  /** Null when the borrower entered the loan and the lender has no account. */
  lenderId: string | null;
  borrowerId: string | null;
  lenderName: string | null;
  lenderMobile: string | null;
  createdByUserId: string | null;
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
  viewerRole: "lender" | "borrower";
  /** The server's verdict: nobody on the other side to countersign. */
  noCounterparty?: boolean;
  isLender?: boolean;
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
  /** Forgiven by the lender: a write-off, or the interest left at settlement. */
  principalWaived: string;
  interestWaived: string;
  computedStatus: string;
}

interface Payment {
  id: string;
  installmentId: string;
  amount: string;
  paymentType: string;
  proofUrl: string | null;
  /** Private asset id (uploads made after proofs became private). */
  proofPublicId: string | null;
  markedByUserId: string;
  confirmedByUserId: string | null;
  status: string;
  notes: string | null;
  /** Received but not applied to anything (payoffs that were rounded up). */
  unappliedAmount: string;
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
  const [payProofId, setPayProofId] = useState<string | null>(null);
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [reminderSent, setReminderSent] = useState<string | null>(null);
  const [reminderNote, setReminderNote] = useState<{
    installmentId: string;
    text: string;
    upiLink?: string;
    /**
     * Set when a WhatsApp/SMS link could not be opened automatically - a
     * browser is entitled to block a pop-up that follows an `await`, so the
     * lender always gets a link they can tap instead.
     */
    link?: { href: string; label: string };
  } | null>(null);
  /**
   * Which EMI the reminder sheet is open for. The sheet exists because a
   * reminder is something the *lender* sends, from their own phone: WhatsApp
   * needs no app on the borrower's side, which is the only way this reaches
   * someone who has never heard of Udhaar.
   */
  const [remindFor, setRemindFor] = useState<string | null>(null);
  const [remindLoading, setRemindLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"schedule" | "payments">("schedule");
  const [paymentError, setPaymentError] = useState<string | null>(null);
  // "Settle in full" - one payment for the whole loan, which is how people
  // actually clear a loan: a single transfer, not one per EMI.
  const [payoffOpen, setPayoffOpen] = useState(false);
  const [payoffAmount, setPayoffAmount] = useState("");
  const [payoffNotes, setPayoffNotes] = useState("");
  const [payoffProofId, setPayoffProofId] = useState<string | null>(null);
  const [payoffError, setPayoffError] = useState<string | null>(null);
  const [payoffLoading, setPayoffLoading] = useState(false);
  const [payoffMessage, setPayoffMessage] = useState<string | null>(null);
  const [acceptExtra, setAcceptExtra] = useState(false);
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
  const [loadError, setLoadError] = useState<string | null>(null);

  // Native hooks
  const haptics = useHaptics();
  const reminders = useReminders();

  // Declared before anything that calls it (it used to be referenced above its
  // own declaration, which the react-hooks lint rule flags).
  const loadData = useCallback(
    async (opts: { redirectOn401?: boolean } = {}) => {
      try {
        const result = await requestJson<{
          loan: Loan;
          installments: Installment[];
          payments: Payment[];
          /** Carried so the tab bar need not ask again - see UNREAD_EVENT. */
          unread?: number;
        }>(`/api/loans/${loanId}`);

        if (opts.redirectOn401 && result.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (result.ok && result.data) {
          setLoan(result.data.loan);
          setInstallments(result.data.installments);
          setPayments(result.data.payments);
          setLoadError(null);
          if (typeof result.data.unread === "number") {
            window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: result.data.unread }));
          }
        } else if (result.error) {
          setLoadError(result.error);
        }
      } catch {
        setLoadError("Couldn't load this loan. Check your connection and try again.");
      } finally {
        setLoading(false);
      }
    },
    [loanId]
  );

  const handleResume = useCallback(() => {
    void loadData();
  }, [loadData]);
  useAppResume(handleResume);

  useEffect(() => {
    void (async () => {
      await loadData({ redirectOn401: true });
    })();
  }, [loadData]);

  const handlePay = async () => {
    if (!payModal || !payAmount) return;

    const amountNum = parseFloat(payAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setPayError("Enter an amount greater than 0");
      return;
    }

    setPayError(null);
    setPayLoading(true);
    try {
      const result = await requestJson<{ applied: { principal: number; interest: number } }>(
        `/api/installments/${payModal.installment.id}/pay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: payAmount,
            paymentType: payModal.type,
            notes: payNotes || undefined,
            proofId: payProofId || undefined,
          }),
        }
      );

      if (!result.ok) {
        setPayError(result.error ?? "Couldn't record the payment. Try again.");
        haptics.notification("error");
        return;
      }

      const data = result.data ?? { applied: { principal: 0, interest: 0 } };
      haptics.notification("success");
      setPayModal(null);
      setPayAmount("");
      setPayNotes("");
      setPayProofId(null);
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
    } catch {
      setPayError("Network error - couldn't reach the server. Try again.");
      haptics.notification("error");
    } finally {
      setPayLoading(false);
    }
  };

  /**
   * Records the reminder and hands back the message to send.
   *
   * `channel` decides what actually goes out: WhatsApp/SMS open the lender's
   * own app with the text ready (nothing for the borrower to install), while
   * push is the automatic path for a borrower who does have the app.
   */
  const handleRemind = async (installmentId: string, channel: "whatsapp" | "sms" | "push") => {
    haptics.tap();
    setRemindLoading(true);

    try {
      const result = await requestJson<{
        delivered?: boolean;
        reason?: string;
        upiLink?: string;
        share?: { text: string; whatsappUrl: string; smsUrl: string };
      }>(`/api/installments/${installmentId}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const data = result.data ?? {};

      if (!result.ok) {
        setReminderNote({ installmentId, text: result.error ?? "Couldn't send that reminder." });
        haptics.notification("error");
        return;
      }

      setRemindFor(null);
      setReminderSent(installmentId);

      if (channel === "push") {
        // The one case where delivery is knowable, so say exactly that.
        haptics.notification(data.delivered ? "success" : "warning");
        setReminderNote({
          installmentId,
          text: data.delivered
            ? "Reminder delivered to the borrower's phone."
            : data.reason || "Reminder recorded, but it couldn't be delivered.",
          upiLink: data.upiLink ?? undefined,
        });
        if (data.delivered) {
          const inst = installments.find((i) => i.id === installmentId);
          if (inst && loan) {
            const remaining =
              parseFloat(inst.totalAmount) - parseFloat(inst.principalPaid) - parseFloat(inst.interestPaid);
            reminders.schedule(installmentId, inst.dueDate, loan.borrowerName, remaining);
          }
        }
      } else {
        // Opened the lender's own app: honest wording, and a fallback link in
        // case the browser blocked the pop-up or they changed their mind.
        const url = channel === "whatsapp" ? data.share?.whatsappUrl : data.share?.smsUrl;
        haptics.notification("success");

        const opened = url ? window.open(url, "_blank") : null;
        const appName = channel === "whatsapp" ? "WhatsApp" : "your messages";
        setReminderNote({
          installmentId,
          text: opened
            ? `Reminder ready in ${appName} - press send there.`
            : `Reminder recorded. Tap below to open ${appName}.`,
          link: !opened && url ? { href: url, label: `Open ${appName}` } : undefined,
        });
      }

      setTimeout(() => setReminderSent(null), 3000);
    } catch {
      setReminderNote({ installmentId, text: "Network error - the reminder wasn't sent." });
    } finally {
      setRemindLoading(false);
    }
  };

  /**
   * Closing is two different things and the button says which one it is:
   * settling a loan that is paid up, or deliberately giving up on the balance.
   */
  const handleCloseLoan = async () => {
    const writeOff = principalOutstanding > 0.01;

    const question = writeOff
      ? `Close this loan and write off ${formatINR(loanOutstanding)}?\n\n` +
        `The unpaid balance is recorded as written off (not as paid), the loan stops ` +
        `reminding, and ${loan?.borrowerName ?? "the borrower"} is told. This cannot be undone.`
      : "Close this loan? Reminders stop and no further payments can be recorded.";

    if (!confirm(question)) return;

    try {
      const result = await requestJson(`/api/loans/${loanId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(writeOff ? { writeOff: true } : {}),
      });
      if (!result.ok) {
        alert(result.error ?? "Couldn't close the loan.");
        haptics.notification("error");
        return;
      }
      haptics.notification("success");
      await loadData();
    } catch {
      alert("Network error - the loan wasn't closed.");
    }
  };

  /** Record one payment that settles the whole loan. */
  const handlePayoff = async () => {
    const amountNum = parseFloat(payoffAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setPayoffError("Enter an amount greater than 0");
      return;
    }

    const extra = Math.round((amountNum - loanOutstanding) * 100) / 100;
    if (extra > 0.01 && !acceptExtra) {
      setPayoffError(
        `That is ${formatINR(extra)} more than this loan still owes. ` +
          `Tick the box below to record the extra as received but not applied.`
      );
      return;
    }

    setPayoffError(null);
    setPayoffLoading(true);
    try {
      const result = await requestJson<{ message?: string; awaitingConfirmation?: boolean }>(
        `/api/loans/${loanId}/payoff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: payoffAmount,
            notes: payoffNotes || undefined,
            proofId: payoffProofId || undefined,
          }),
        }
      );

      if (!result.ok) {
        setPayoffError(result.error ?? "Couldn't record the payoff. Try again.");
        haptics.notification("error");
        return;
      }

      haptics.notification("success");
      setPayoffMessage(
        result.data?.message ??
          (result.data?.awaitingConfirmation
            ? "Payoff recorded - waiting for the other person to confirm."
            : "Payoff recorded.")
      );
      setPayoffOpen(false);
      setPayoffAmount("");
      setPayoffNotes("");
      setPayoffProofId(null);
      setAcceptExtra(false);
      await loadData();
    } catch {
      setPayoffError("Network error - couldn't reach the server. Try again.");
      haptics.notification("error");
    } finally {
      setPayoffLoading(false);
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
      const result = await requestJson(`/api/loans/${loanId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });

      if (!result.ok) {
        setEditError(result.error ?? "Unable to update loan");
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
      const result = await requestJson(`/api/loans/${loanId}`, { method: "DELETE" });

      if (!result.ok) {
        alert(result.error ?? "Unable to delete loan");
        return;
      }

      window.location.assign("/dashboard");
    } catch {
      alert("Something went wrong while deleting the loan");
    }
  };

  const handleConfirmPayment = async (
    paymentId: string,
    action: "confirm" | "reject" | "withdraw"
  ) => {
    try {
      const result = await requestJson(`/api/payments/${paymentId}/confirm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!result.ok) {
        // Errors here are meaningful ("you can't confirm your own payment",
        // "this EMI already moved on") and used to be swallowed silently.
        haptics.notification("error");
        setPaymentError(result.error ?? "Couldn't update that payment.");
        setTimeout(() => setPaymentError(null), 6000);
      } else {
        haptics.notification("success");
      }

      await loadData();
    } catch {
      setPaymentError("Network error - the payment wasn't updated.");
      setTimeout(() => setPaymentError(null), 6000);
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
          <p className="text-slate-600 font-medium">
            {loadError ?? "Loan not found"}
          </p>
          {loadError && (
            <button
              onClick={() => window.location.reload()}
              className="mt-3 block mx-auto text-emerald-600 font-semibold"
            >
              Retry
            </button>
          )}
          <a href="/dashboard" className="text-emerald-600 mt-4 inline-block font-semibold">
            ← Back to Dashboard
          </a>
        </div>
      </div>
    );
  }

  const isLender = loan.viewerRole === "lender";
  const currentUserId = isLender ? loan.lenderId : loan.borrowerId;
  // In 2-side mode a payment normally needs the *other* party to confirm it.
  // When that party has no account - the borrower never joined, or the lender
  // on a loan the borrower entered never joined - the marker must be able to
  // confirm their own payment, or it would sit pending forever.
  const noCounterparty = loan.noCounterparty ?? (isLender ? !loan.borrowerId : !loan.lenderId);
  // Who the loan is *with*, from this viewer's side.
  const counterpartyName = isLender ? loan.borrowerName : loan.lenderName || "the lender";
  // Whoever typed the loan in may fix it, while nobody else depends on it.
  const mayManageRecord =
    loan.createdByUserId === currentUserId && (isLender || !loan.lenderId);
  /**
   * Can this viewer settle by paying the principal and have the rest waived?
   *
   * The lender always can. A borrower can *only* when the lender is on Udhaar
   * to be asked (in 2-side mode their confirmation is the signature; in
   * 1-side they chose to trust the other person's word). On a loan the
   * borrower entered for a lender who never joined, nobody can grant a
   * waiver, so the borrower pays what they owe in full.
   */
  const canWaiveOnSettle = isLender || Boolean(loan.lenderId);

  const paidInstallments = installments.filter((i) => i.computedStatus === "paid").length;
  const progressPercent = installments.length > 0
    ? Math.round((paidInstallments / installments.length) * 100)
    : 0;
  // All of this is derived in one tested place (summarizeSettlement) rather
  // than inline: waivers must be netted out everywhere, consistently.
  const summary = summarizeSettlement(installments, loan.status);
  const {
    principalTotal: totalPrincipal,
    principalPaid: totalPrincipalPaid,
    principalOutstanding,
    interestOutstanding,
    loanOutstanding,
    totalWaived,
    principalWaived: totalPrincipalWaived,
    interestWaived: totalInterestWaived,
    principalProgressPercent,
    canSettleInFull,
  } = summary;

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

      {!isLender && (
        <div className="mx-5 mt-3 bg-blue-50 border border-blue-200 rounded-2xl px-4 py-2.5 text-xs font-medium text-blue-700 flex items-center gap-2">
          <span>👤</span>
          <span>This loan was added by the lender. You&apos;re viewing it as the borrower — you can mark payments, but only the lender can edit or close it.</span>
        </div>
      )}

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

        {payoffMessage && (
          <div className="mt-3 bg-white/15 border border-white/25 rounded-xl px-3 py-2 flex items-start gap-2">
            <p className="text-[11px] text-white font-medium flex-1">{payoffMessage}</p>
            <button
              onClick={() => setPayoffMessage(null)}
              className="text-[11px] font-bold text-emerald-100 shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

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

        {loan.status === "closed" && totalWaived > 0.01 && (
          <div className="mt-3 bg-amber-400/20 border border-amber-200/40 rounded-xl px-3 py-2">
            <p className="text-[11px] text-amber-50 font-medium">
              ⚖️ Closed with {formatINR(totalWaived)} written off
              {totalPrincipalWaived > 0.01 && totalInterestWaived > 0.01
                ? ` (${formatINR(totalPrincipalWaived)} principal, ${formatINR(totalInterestWaived)} interest)`
                : totalPrincipalWaived > 0.01
                  ? " (principal)"
                  : " (interest)"}
              .
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 mt-4">
          {upiLink && !isLender && (
            <a
              href={upiLink}
              className="flex-1 bg-white text-emerald-700 font-semibold py-2.5 rounded-2xl text-sm text-center tap-highlight active:bg-emerald-50 transition"
            >
              📱 Pay via UPI
            </a>
          )}
          {canSettleInFull && (
            <button
              onClick={() => {
                haptics.tap();
                setPayoffOpen(true);
                setPayoffAmount(loanOutstanding.toFixed(2));
                setPayoffError(null);
                setAcceptExtra(false);
              }}
              className="flex-1 bg-white text-emerald-700 font-semibold py-2.5 rounded-2xl text-sm tap-highlight active:bg-emerald-50 transition"
            >
              💸 Settle in full
            </button>
          )}
          {isLender && loan.status === "active" && (
            <button
              onClick={handleCloseLoan}
              className="flex-1 bg-emerald-500/40 text-white font-semibold py-2.5 rounded-2xl text-sm tap-highlight active:bg-emerald-500/60 transition"
            >
              {principalOutstanding > 0.01 ? "🔒 Close & write off" : "🔒 Close Loan"}
            </button>
          )}
        </div>


        {/* Share / Invite - lender only, used to send loan details to the borrower */}
        {isLender && (
          <div className="mt-3">
            <ShareButton
              borrowerName={loan.borrowerName}
              borrowerMobile={loan.borrowerMobile}
              amount={loan.amount}
              upiId={loan.upiId}
            />
          </div>
        )}
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
          {reminderNote && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-3.5 animate-scale-in">
              <p className="text-xs text-blue-800">{reminderNote.text}</p>
              <div className="flex items-center gap-3 mt-2">
                {reminderNote.link && (
                  <a
                    href={reminderNote.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-semibold text-blue-700 underline"
                  >
                    {reminderNote.link.label}
                  </a>
                )}
                {reminderNote.upiLink && (
                  <a
                    href={reminderNote.upiLink}
                    className="text-xs font-semibold text-blue-700 underline"
                  >
                    Open UPI link
                  </a>
                )}
                <button
                  onClick={() => setReminderNote(null)}
                  className="text-xs font-semibold text-slate-500"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {installments.map((inst) => {
            const days = daysUntil(inst.dueDate);
            const waived =
              parseFloat(inst.principalWaived || "0") + parseFloat(inst.interestWaived || "0");
            const principalRemaining =
              parseFloat(inst.principalAmount) -
              parseFloat(inst.principalPaid) -
              parseFloat(inst.principalWaived || "0");
            const interestRemaining =
              parseFloat(inst.interestAmount) -
              parseFloat(inst.interestPaid) -
              parseFloat(inst.interestWaived || "0");
            const totalRemaining = Math.max(0, principalRemaining) + Math.max(0, interestRemaining);
            // "Settled" covers both: money received, and money the lender gave up.
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
              paid: waived > 0 ? "SETTLED" : "PAID ✓",
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
                        {waived > 0 && (
                          <p className="text-xs text-amber-600 font-medium">
                            ⚖️ ₹{waived.toLocaleString("en-IN")} written off
                          </p>
                        )}
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
                        setPayError(null);
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
                          setPayError(null);
                        }}
                        className="bg-blue-600 active:bg-blue-800 text-white text-xs font-semibold px-4 py-2 rounded-xl tap-highlight"
                      >
                        Interest Only
                      </button>
                    )}
                    {isLender && (
                      <button
                        onClick={() => {
                          haptics.tap();
                          setRemindFor(inst.id);
                        }}
                        className="bg-white active:bg-slate-100 text-slate-600 text-xs font-semibold px-4 py-2 rounded-xl border border-slate-200 tap-highlight"
                      >
                        {reminderSent === inst.id ? "✓ Sent!" : "🔔 Remind"}
                      </button>
                    )}
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
          {paymentError && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-3.5 text-xs text-red-700 animate-scale-in">
              {paymentError}
            </div>
          )}
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
                        {payment.paymentType === "payoff" ? "full settlement" : payment.paymentType}
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
                {parseFloat(payment.unappliedAmount || "0") > 0.01 && (
                  <p className="text-[11px] text-amber-600 font-medium mt-2">
                    ₹{parseFloat(payment.unappliedAmount).toFixed(2)} was received but not applied to
                    this loan.
                  </p>
                )}
                {(payment.proofPublicId || payment.proofUrl) && (
                  <a
                    href={`/api/payments/${payment.id}/proof`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 mt-3 text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-xl tap-highlight"
                  >
                    🧾 View proof
                  </a>
                )}
                {payment.status === "pending" &&
                  (payment.markedByUserId !== currentUserId || noCounterparty) && (
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
                {payment.status === "pending" &&
                  payment.markedByUserId === currentUserId &&
                  !noCounterparty && (
                    /* Marked by mistake? Take it back rather than waiting for
                       the other side to act - a pending claim blocks every
                       later payment on the loan. */
                    <div className="flex items-center justify-between gap-2 mt-3">
                      <p className="text-[11px] text-amber-600 font-medium">
                        ⏳ Waiting for {isLender ? "borrower" : "lender"} to confirm
                      </p>
                      <button
                        onClick={() => handleConfirmPayment(payment.id, "withdraw")}
                        className="shrink-0 text-[11px] font-semibold text-slate-600 bg-slate-100 px-3 py-1.5 rounded-xl tap-highlight active:bg-slate-200"
                      >
                        Withdraw
                      </button>
                    </div>
                  )}
                {payment.status === "pending" &&
                  payment.markedByUserId === currentUserId &&
                  noCounterparty && (
                    <p className="text-[11px] text-amber-600 font-medium mt-3">
                      {loan.borrowerName} hasn&apos;t joined Udhaar yet, so you can confirm this
                      yourself.
                    </p>
                  )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Reminder sheet: the lender sends it, from their own phone */}
      <BottomSheet
        open={!!remindFor}
        onClose={() => setRemindFor(null)}
        title="Send a reminder"
        subtitle={
          loan
            ? `To ${loan.borrowerName} · ${loan.borrowerMobile}`
            : undefined
        }
      >
        <div className="space-y-2.5">
          <p className="text-xs text-slate-500">
            {loan?.borrowerId
              ? "WhatsApp needs nothing installed on their phone - the message comes from yours."
              : `${loan?.borrowerName ?? "The borrower"} hasn't joined Udhaar, so notifications can't reach them. WhatsApp works on any phone.`}
          </p>

          <button
            onClick={() => remindFor && handleRemind(remindFor, "whatsapp")}
            disabled={remindLoading}
            className="w-full flex items-center gap-3 py-3.5 px-4 rounded-2xl bg-[#25D366] text-white font-semibold tap-highlight disabled:opacity-60"
          >
            <span className="text-xl">💬</span>
            <span className="flex-1 text-left">
              WhatsApp
              <span className="block text-[11px] font-normal opacity-90">
                Opens WhatsApp with the amount, due date and UPI link written out
              </span>
            </span>
          </button>

          <button
            onClick={() => remindFor && handleRemind(remindFor, "sms")}
            disabled={remindLoading}
            className="w-full flex items-center gap-3 py-3.5 px-4 rounded-2xl border border-slate-200 text-slate-700 font-semibold tap-highlight disabled:opacity-60"
          >
            <span className="text-xl">✉️</span>
            <span className="flex-1 text-left">
              Text message
              <span className="block text-[11px] font-normal text-slate-500">
                Opens your messages app with the same text
              </span>
            </span>
          </button>

          <button
            onClick={() => remindFor && handleRemind(remindFor, "push")}
            disabled={remindLoading}
            className="w-full flex items-center gap-3 py-3.5 px-4 rounded-2xl border border-slate-200 text-slate-700 font-semibold tap-highlight disabled:opacity-60"
          >
            <span className="text-xl">🔔</span>
            <span className="flex-1 text-left">
              In-app notification
              <span className="block text-[11px] font-normal text-slate-500">
                {loan?.borrowerId
                  ? "Free and instant - only if they installed Udhaar and allowed notifications"
                  : "They haven't joined Udhaar yet, so this can't reach them"}
              </span>
            </span>
          </button>

          {remindLoading && (
            <p className="text-xs text-slate-400 text-center">Preparing the reminder…</p>
          )}

          <button
            onClick={() => setRemindFor(null)}
            className="w-full py-3 rounded-2xl text-slate-500 font-semibold text-sm"
          >
            Cancel
          </button>
        </div>
      </BottomSheet>

      {/* Settle in full - one payment for the whole loan */}
      <BottomSheet
        open={payoffOpen}
        onClose={() => { setPayoffOpen(false); setPayoffProofId(null); setPayoffError(null); }}
        title="Settle in full"
        subtitle={`${formatINR(principalOutstanding)} principal + ${formatINR(interestOutstanding)} interest outstanding`}
      >
        <div className="space-y-4">
          <div className={`grid gap-2 ${canWaiveOnSettle ? "grid-cols-2" : "grid-cols-1"}`}>
            {canWaiveOnSettle && (
            <button
              onClick={() => {
                setPayoffAmount(principalOutstanding.toFixed(2));
                setPayoffError(null);
              }}
              className={`py-3 px-3 rounded-2xl border text-left tap-highlight ${
                Math.abs(parseFloat(payoffAmount || "0") - principalOutstanding) < 0.005
                  ? "bg-emerald-50 border-emerald-500"
                  : "border-slate-200"
              }`}
            >
              <div className="text-sm font-bold text-slate-800">
                {formatINR(principalOutstanding)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {canWaiveOnSettle ? (
                  <>
                    Settle the principal
                    {interestOutstanding > 0.01
                      ? ` · waives ${formatINR(interestOutstanding)} interest`
                      : ""}
                  </>
                ) : (
                  <>Only {counterpartyName} can waive interest — pay the full amount</>
                )}
              </div>
            </button>
            )}
            <button
              onClick={() => {
                setPayoffAmount(loanOutstanding.toFixed(2));
                setPayoffError(null);
              }}
              className={`py-3 px-3 rounded-2xl border text-left tap-highlight ${
                Math.abs(parseFloat(payoffAmount || "0") - loanOutstanding) < 0.005
                  ? "bg-emerald-50 border-emerald-500"
                  : "border-slate-200"
              }`}
            >
              <div className="text-sm font-bold text-slate-800">{formatINR(loanOutstanding)}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Pay everything, interest included
              </div>
            </button>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Amount received (₹)
            </label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={payoffAmount}
              onChange={(e) => {
                setPayoffAmount(e.target.value);
                setPayoffError(null);
                setAcceptExtra(false);
              }}
              className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none text-2xl font-bold"
              autoFocus
            />
            {payoffError && (
              <p className="text-xs text-red-500 font-medium mt-1.5">{payoffError}</p>
            )}
          </div>

          {parseFloat(payoffAmount || "0") - loanOutstanding > 0.01 && (
            <label className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl p-3">
              <input
                type="checkbox"
                checked={acceptExtra}
                onChange={(e) => {
                  setAcceptExtra(e.target.checked);
                  setPayoffError(null);
                }}
                className="mt-0.5 w-4 h-4 accent-emerald-600"
              />
              <span className="text-[11px] text-amber-800 font-medium">
                {formatINR(parseFloat(payoffAmount) - loanOutstanding)} more arrived than the loan
                owes. It will be recorded as received but not applied, so the history matches the
                bank statement.
              </span>
            </label>
          )}

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Notes (optional)
            </label>
            <input
              type="text"
              value={payoffNotes}
              onChange={(e) => setPayoffNotes(e.target.value)}
              placeholder="Cleared the balance by UPI..."
              className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none"
            />
          </div>

          {/* Proof Upload */}
          <ProofUpload onCapture={setPayoffProofId} />

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setPayoffOpen(false)}
              className="flex-1 py-3.5 rounded-2xl border border-slate-200 text-slate-600 font-semibold tap-highlight"
            >
              Cancel
            </button>
            <button
              onClick={handlePayoff}
              disabled={payoffLoading || !payoffAmount}
              className="flex-[2] bg-emerald-600 active:bg-emerald-800 disabled:bg-slate-200 text-white font-bold py-3.5 rounded-2xl tap-highlight"
            >
              {payoffLoading ? "Recording..." : "Settle loan ✓"}
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* Pay Bottom Sheet */}
      <BottomSheet
        open={!!payModal}
        onClose={() => { setPayModal(null); setPayProofId(null); setPayError(null); }}
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
              min="0.01"
              step="0.01"
              value={payAmount}
              onChange={(e) => { setPayAmount(e.target.value); setPayError(null); }}
              className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none text-2xl font-bold"
              autoFocus
            />
            {payError && (
              <p className="text-xs text-red-500 font-medium mt-1.5">{payError}</p>
            )}
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
          <ProofUpload onCapture={setPayProofId} />

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

      {/* Edit/Delete - whoever entered the record, while it is only theirs */}
      {mayManageRecord && (
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
      )}

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
