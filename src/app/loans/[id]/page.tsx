"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  BadgeIndianRupee,
  BellRing,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  Info,
  Pencil,
  PenLine,
  Receipt,
  RotateCw,
  Share2,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import MobileShell from "@/components/MobileShell";
import ProofUpload from "@/components/ProofUpload";
import { PaySheet, RemindSheet, type PayTarget } from "@/components/ActionSheets";
import {
  Avatar,
  Badge,
  Button,
  Card,
  DetailRow,
  EmptyState,
  Field,
  Input,
  Notice,
  Progress,
  Sheet,
  Skeleton,
  buttonClasses,
  cx,
  formatMoney,
} from "@/components/ui";
import { useShare, useHaptics, useReminders, useAppResume } from "@/hooks/useNative";
import { requestJson } from "@/lib/http";
import { UNREAD_EVENT } from "@/lib/client-cache";
import { awaitingConfirmation, summarizeSettlement } from "@/lib/payments";
import { paymentReceiptText, statementText } from "@/lib/loan-statement";

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

/** The per-installment figures, netted of anything written off. */
interface InstalmentView {
  inst: Installment;
  principalRemaining: number;
  interestRemaining: number;
  totalRemaining: number;
  waived: number;
  isPaid: boolean;
}

function viewOf(inst: Installment): InstalmentView {
  const principalRemaining =
    parseFloat(inst.principalAmount) -
    parseFloat(inst.principalPaid) -
    parseFloat(inst.principalWaived || "0");
  const interestRemaining =
    parseFloat(inst.interestAmount) -
    parseFloat(inst.interestPaid) -
    parseFloat(inst.interestWaived || "0");

  return {
    inst,
    principalRemaining: Math.max(0, principalRemaining),
    interestRemaining: Math.max(0, interestRemaining),
    totalRemaining: Math.max(0, principalRemaining) + Math.max(0, interestRemaining),
    waived: parseFloat(inst.principalWaived || "0") + parseFloat(inst.interestWaived || "0"),
    isPaid: inst.computedStatus === "paid",
  };
}

export default function LoanDetailPage() {
  const params = useParams();
  const loanId = params.id as string;

  const [loan, setLoan] = useState<Loan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  /** The payment whose receipt was just shared, so the row can say so. */
  const [sharedReceiptId, setSharedReceiptId] = useState<string | null>(null);
  /** True for a few seconds after the statement was shared from here. */
  const [sharedStatement, setSharedStatement] = useState(false);
  /** The pending payment whose Confirm/Reject is in flight. */
  const [busyPaymentId, setBusyPaymentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Which EMI the payment sheet is open for, and what it starts out applying. */
  const [payFor, setPayFor] = useState<{
    view: InstalmentView;
    type: "both" | "interest";
  } | null>(null);
  /** Which EMI the reminder sheet is open for. */
  const [remindFor, setRemindFor] = useState<Installment | null>(null);
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
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
  /** A line that confirms something just happened (a payment, a reminder). */
  const [flash, setFlash] = useState<string | null>(null);

  // Native hooks
  const haptics = useHaptics();
  const reminders = useReminders();
  const { share, shared } = useShare();

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

  /**
   * Say that something worked, then stop saying it.
   *
   * The sheets close on success, so without this a recorded payment looks like
   * nothing happened until the numbers behind it are read. Cleared on a timer
   * from the handler that set it, rather than from an effect watching it.
   */
  const flashMessage = useCallback((text: string) => {
    setFlash(text);
    setTimeout(() => setFlash((current) => (current === text ? null : current)), 4000);
  }, []);

  /**
   * Closing is two different things and the button says which one it is:
   * settling a loan that is paid up, or deliberately giving up on the balance.
   */
  const handleCloseLoan = async (outstanding: number, totalLoaned: number) => {
    const writeOff = outstanding > 0.01;

    const question = writeOff
      ? `Close this loan and write off ${formatMoney(outstanding)}?\n\n` +
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
      flashMessage(
        writeOff
          ? `Loan closed - ${formatMoney(totalLoaned)} written off.`
          : "Loan closed. Reminders stop here."
      );
      await loadData();
    } catch {
      alert("Network error - the loan wasn't closed.");
    }
  };

  /** Record one payment that settles the whole loan. */
  const handlePayoff = async (outstanding: number) => {
    const amountNum = parseFloat(payoffAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setPayoffError("Enter an amount greater than 0");
      return;
    }

    const extra = Math.round((amountNum - outstanding) * 100) / 100;
    if (extra > 0.01 && !acceptExtra) {
      setPayoffError(
        `That is ${formatMoney(extra)} more than this loan still owes. ` +
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

  const openEditForm = (current: Loan) => {
    setEditError("");
    setEditForm({
      borrowerName: current.borrowerName,
      borrowerMobile: current.borrowerMobile,
      amount: current.amount,
      interestRate: current.interestRate,
      interestRatePeriod: current.interestRatePeriod === "monthly" ? "monthly" : "yearly",
      tenureMonths: String(current.tenureMonths),
      startDate: current.startDate,
      upiId: current.upiId || "",
      accountNumber: current.accountNumber || "",
      notes: current.notes || "",
      confirmationMode: current.confirmationMode === "2-side" ? "2-side" : "1-side",
    });
    setEditOpen(true);
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

      setEditOpen(false);
      setEditForm(null);
      flashMessage("Loan updated.");
      await loadData();
    } catch {
      setEditError("Something went wrong while updating the loan");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteLoan = async () => {
    if (!confirm("Delete this loan and all associated records? This action cannot be undone."))
      return;

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
    setBusyPaymentId(paymentId);
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
    } finally {
      setBusyPaymentId(null);
    }
  };

  if (loading) {
    return (
      <MobileShell title="Loan">
        <div className="space-y-3 px-4 pt-3">
          <Skeleton className="h-40 rounded-card" />
          <Skeleton className="h-12 rounded-control" />
          <Skeleton className="h-24 rounded-card" />
          <Skeleton className="h-24 rounded-card" />
        </div>
      </MobileShell>
    );
  }

  if (!loan) {
    return (
      <MobileShell title="Loan" back="/dashboard" showNav={false}>
        <div className="px-4 pt-3">
          <Card padded={false}>
            <EmptyState
              icon={<Info className="size-6" />}
              title={loadError ?? "Loan not found"}
              body="It may have been deleted, or the link may belong to another account."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {/* A loan that could not be *fetched* is worth another try; one
                      that does not exist is not, so the retry only appears when
                      there was a failure to retry. */}
                  {loadError && (
                    <Button onClick={() => void loadData()} icon={<RotateCw className="size-4" />}>
                      Try again
                    </Button>
                  )}
                  <Link
                    href="/loans"
                    className={buttonClasses(loadError ? "secondary" : "primary", "md")}
                  >
                    Back to loans
                  </Link>
                </div>
              }
            />
          </Card>
        </div>
      </MobileShell>
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
  const counterpartyMobile = isLender ? loan.borrowerMobile : loan.lenderMobile;
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

  const views = installments.map(viewOf);
  const paidInstallments = views.filter((v) => v.isPaid).length;
  const progressPercent =
    installments.length > 0 ? Math.round((paidInstallments / installments.length) * 100) : 0;
  // All of this is derived in one tested place (summarizeSettlement) rather
  // than inline: waivers must be netted out everywhere, consistently.
  const summary = summarizeSettlement(installments, loan.status);
  const {
    principalTotal: totalPrincipal,
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

  /**
   * Payments sitting on this viewer's yes.
   *
   * In 2-side mode a marked payment only reaches the schedule once the other
   * side confirms it, which makes this the most time-sensitive thing on the
   * screen: the money is claimed, the EMI is still open, and whoever paid is
   * waiting. It used to be four taps from the notification that said so -
   * open the loan, switch to Payments, scroll, tap - so it is now the first
   * card on the page, and the buttons say what each outcome does.
   */
  const awaitingMe = awaitingConfirmation(payments, currentUserId, noCounterparty);

  /** The same summary the statement screen sends, without opening it first. */
  const shareStatement = async () => {
    haptics.tap();
    const text = statementText(loan, installments, payments, loan.viewerRole);
    await share({ title: `Loan statement — ${counterpartyName}`, text });
    setSharedStatement(true);
    setTimeout(() => setSharedStatement(false), 4000);
  };

  /** The receipt for one confirmed payment, sent from the row that shows it. */
  const sendReceipt = async (payment: Payment) => {
    haptics.tap();
    const text = paymentReceiptText(loan, payment, loan.viewerRole);
    await share({ title: `Payment receipt — ${counterpartyName}`, text });
    setSharedReceiptId(payment.id);
    setTimeout(
      () => setSharedReceiptId((current) => (current === payment.id ? null : current)),
      4000
    );
  };

  /**
   * The next thing to pay, so the screen's main button never makes anybody
   * scan a list to find out what it should say. Overdue first, then soonest.
   */
  const nextDue =
    views
      .filter((v) => !v.isPaid && v.totalRemaining > 0.01)
      .sort(
        (a, b) =>
          daysUntil(a.inst.dueDate) - daysUntil(b.inst.dueDate) ||
          a.inst.installmentNumber - b.inst.installmentNumber
      )[0] ?? null;

  const statusTone: Record<string, "neutral" | "good" | "warn" | "bad" | "brand"> = {
    paid: "good",
    overdue: "bad",
    due_soon: "warn",
    partially_paid: "brand",
    pending: "neutral",
  };

  const shareInvite = () =>
    share({
      title: "Join me on Udhaar",
      text:
        `Hey! I'm tracking our loan on Udhaar - an easy way to manage EMIs and payments.\n\n` +
        `Loan: ₹${parseFloat(loan.amount).toLocaleString("en-IN")} from ${loan.borrowerName}\n` +
        `Mobile: ${loan.borrowerMobile}` +
        (loan.upiId ? `\nUPI: ${loan.upiId}` : "") +
        `\n\nDownload Udhaar to track your loans with auto-reminders!`,
      url: typeof window === "undefined" ? undefined : window.location.origin,
    });

  return (
    <MobileShell
      title={counterpartyName}
      subtitle={counterpartyMobile ? `+91 ${counterpartyMobile}` : undefined}
      back="/loans"
      rightAction={
        <Button size="sm" variant="ghost" onClick={() => setDetailsOpen(true)}>
          Details
        </Button>
      }
    >
      <div className="px-4 pb-8 pt-3">
        {flash && (
          <Notice
            tone="good"
            icon={<Check className="size-4" />}
            onDismiss={() => setFlash(null)}
            className="mb-3"
          >
            {flash}
          </Notice>
        )}

        {payoffMessage && (
          <Notice tone="brand" onDismiss={() => setPayoffMessage(null)} className="mb-3">
            {payoffMessage}
          </Notice>
        )}

        {!isLender && (
          <Notice tone="neutral" icon={<Info className="size-4" />} className="mb-3">
            This loan was added by the lender. You can record your payments and they confirm them -
            only the lender can edit or close the loan.
          </Notice>
        )}

        {awaitingMe.length > 0 && (
          <Card padded={false} className="mb-3 overflow-hidden border-warn bg-warn-soft">
            <div className="flex items-center gap-2 px-4 pb-1 pt-3.5">
              <PenLine className="size-4 text-warn" />
              <h2 className="text-[13px] font-bold text-ink">
                {awaitingMe.length === 1
                  ? "One payment is waiting for your yes"
                  : `${awaitingMe.length} payments are waiting for your yes`}
              </h2>
            </div>

            <div className="divide-y divide-line">
              {awaitingMe.map((payment) => (
                <div key={payment.id} className="px-4 py-3.5">
                  <p className="text-[18px] font-bold leading-none tabular-nums text-ink">
                    {formatMoney(parseFloat(payment.amount))}
                    <span className="ml-2 text-[12px] font-medium text-ink-3">
                      {payment.paymentType === "payoff" ? "full settlement" : payment.paymentType}
                      {payment.markedByUserId === currentUserId
                        ? " · recorded by you"
                        : ` · marked by ${counterpartyName}`}
                    </span>
                  </p>
                  <p className="mt-2 text-[12px] leading-snug text-ink-2">
                    {payment.markedByUserId === currentUserId
                      ? "Nobody else has an account on this loan, so your word is what records it against the schedule."
                      : `Confirming records it against the schedule and tells ${counterpartyName} it went through. Rejecting leaves the EMI open.`}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      loading={busyPaymentId === payment.id}
                      onClick={() => handleConfirmPayment(payment.id, "confirm")}
                    >
                      <Check className="size-3.5" />
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="flex-1"
                      onClick={() => handleConfirmPayment(payment.id, "reject")}
                    >
                      <X className="size-3.5" />
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/*
         * The one number that matters, then the two it is made of, then the
         * action. The old card showed six figures of equal weight and put the
         * buttons underneath them, so the outstanding balance was the same size
         * as the interest rate.
         */}
        <Card padded={false} className="overflow-hidden bg-brand text-brand-ink">
          <div className="px-5 pb-4 pt-5">
            <div className="flex items-start gap-3">
              <Avatar name={counterpartyName} size={40} className="bg-black/15 text-brand-ink" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[15px] font-bold">{counterpartyName}</p>
                  <Badge
                    className={cx(
                      "bg-black/15 text-brand-ink",
                      loan.status === "active" && "bg-black/20"
                    )}
                  >
                    {loan.status === "active" ? (isLender ? "OWED TO YOU" : "YOU OWE") : "CLOSED"}
                  </Badge>
                </div>
                <p className="text-[11px] opacity-70">
                  {loan.interestRate}% {loan.interestRatePeriod === "monthly" ? "monthly" : "yearly"}{" "}
                  · {loan.tenureMonths} months · from {formatDate(loan.startDate)}
                </p>
              </div>
            </div>

            <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide opacity-70">
              Outstanding
            </p>
            <p className="mt-0.5 text-[34px] font-bold leading-none tracking-tight tabular-nums">
              {formatMoney(loanOutstanding)}
            </p>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
              <span className="opacity-80">
                Principal <span className="font-bold tabular-nums">{formatMoney(principalOutstanding)}</span>
              </span>
              <span className="opacity-80">
                Interest <span className="font-bold tabular-nums">{formatMoney(interestOutstanding)}</span>
              </span>
              <span className="opacity-80">
                Paid <span className="font-bold tabular-nums">{paidInstallments}/{installments.length} EMIs</span>
              </span>
            </div>

            <Progress value={progressPercent} tone="good" className="mt-3 bg-black/20" />
            <p className="mt-1.5 text-[11px] opacity-70">
              Principal repaid {principalProgressPercent}% ({formatMoney(totalPrincipal)} borrowed)
            </p>
          </div>

          <div className="grid gap-px bg-black/10 sm:grid-cols-2">
            {!isLender && upiLink && (
              <a
                href={upiLink}
                className="tap flex items-center justify-center gap-2 bg-brand/95 px-4 py-3.5 text-[14px] font-semibold hover:bg-brand-strong"
              >
                <Wallet className="size-4" />
                Pay via UPI
              </a>
            )}
            {isLender && loan.status === "active" && mayManageRecord && (
              <button
                onClick={() => handleCloseLoan(principalOutstanding, loanOutstanding)}
                className="tap flex items-center justify-center gap-2 bg-brand/95 px-4 py-3.5 text-[14px] font-semibold hover:bg-brand-strong"
              >
                {principalOutstanding > 0.01 ? "Close & write off" : "Close loan"}
              </button>
            )}
            {canSettleInFull && loan.status === "active" && (
              <button
                onClick={() => {
                  haptics.tap();
                  setPayoffOpen(true);
                  setPayoffAmount(loanOutstanding.toFixed(2));
                  setPayoffError(null);
                  setAcceptExtra(false);
                }}
                className="tap flex items-center justify-center gap-2 bg-brand/95 px-4 py-3.5 text-[14px] font-semibold hover:bg-brand-strong"
              >
                <BadgeIndianRupee className="size-4" />
                Settle in full
              </button>
            )}
          </div>
        </Card>

        {/*
         * One tap to the thing this screen exists for. Before, paying the next
         * EMI meant finding it in the list and tapping "Mark Paid" on the row -
         * which then opened another sheet asking how much. The sheet that opens
         * from here is already filled in with the amount, has the UPI shortcut
         * inside it, and lets the amount be changed if it is a part payment.
         */}
        {nextDue && loan.status === "active" && (
          <div className="mt-3 flex items-center gap-2">
            <Button
              block
              size="lg"
              onClick={() => {
                haptics.tap();
                setPayFor({ view: nextDue, type: "both" });
              }}
              className={cx(daysUntil(nextDue.inst.dueDate) < 0 && "bg-bad hover:bg-bad/90")}
            >
              <Receipt className="size-4" />
              {isLender ? "Record" : "Pay"} EMI #{nextDue.inst.installmentNumber} ·{" "}
              {formatMoney(nextDue.totalRemaining)}
            </Button>
          </div>
        )}
        {nextDue && loan.status === "active" && (
          <p className="mt-1.5 px-1 text-[11px] text-ink-3">
            {daysUntil(nextDue.inst.dueDate) < 0
              ? `Overdue since ${formatDate(nextDue.inst.dueDate)}`
              : `Due ${formatDate(nextDue.inst.dueDate)}`}
            {views.filter((v) => !v.isPaid).length > 1
              ? ` · ${views.filter((v) => !v.isPaid).length} EMIs still open`
              : ""}
          </p>
        )}

        {loan.status === "closed" && totalWaived > 0.01 && (
          <Notice tone="warn" className="mt-3">
            Closed with {formatMoney(totalWaived)} written off
            {totalPrincipalWaived > 0.01 && totalInterestWaived > 0.01
              ? ` (${formatMoney(totalPrincipalWaived)} principal, ${formatMoney(totalInterestWaived)} interest)`
              : totalPrincipalWaived > 0.01
                ? " (principal)"
                : " (interest)"}
            .
          </Notice>
        )}

        {/* The whole record on one sheet: printable, and sendable as a summary. */}
        <div className="mt-4 flex items-stretch gap-2">
          <Link
            href={`/loans/${loan.id}/statement`}
            className="tap flex min-w-0 flex-1 items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 shadow-card hover:bg-surface-2"
          >
            <span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-ink-2">
              <FileText className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">
                Statement &amp; receipts
              </span>
              <span className="block text-[11px] text-ink-3">
                Every EMI, payment and waiver - printable and sendable
              </span>
            </span>
            <ChevronRight className="size-4 text-ink-3" />
          </Link>

          {/* Sending the summary is the common job; reading it is the rare one. */}
          <Button
            variant="secondary"
            className="shrink-0"
            aria-label="Share this loan statement"
            onClick={shareStatement}
            icon={<Share2 className="size-4" />}
          >
            {sharedStatement ? "Sent" : "Share"}
          </Button>
        </div>

        {isLender && (
          <Button
            block
            variant="secondary"
            className="mt-2.5"
            onClick={shareInvite}
            icon={<Share2 className="size-4" />}
          >
            {shared ? "Shared" : "Invite them to Udhaar"}
          </Button>
        )}

        {/* Tabs */}
        <div className="mt-5 flex rounded-control bg-surface-2 p-1">
          {(
            [
              ["schedule", `EMIs (${installments.length})`, <CalendarDays key="i" className="size-4" />],
              ["payments", `Payments (${payments.length})`, <Receipt key="i" className="size-4" />],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              aria-pressed={activeTab === id}
              className={cx(
                "tap flex flex-1 items-center justify-center gap-1.5 rounded-[10px] py-2 text-[13px] font-semibold",
                activeTab === id ? "bg-surface text-ink shadow-card" : "text-ink-3"
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        {/* Schedule */}
        {activeTab === "schedule" && (
          <div className="stagger mt-3 space-y-2.5">
            {views.map((view) => {
              const { inst } = view;
              const days = daysUntil(inst.dueDate);
              const paid = parseFloat(inst.principalPaid) + parseFloat(inst.interestPaid);
              const label =
                inst.computedStatus === "paid"
                  ? view.waived > 0
                    ? "SETTLED"
                    : "PAID"
                  : inst.computedStatus === "overdue"
                    ? `${Math.abs(days)}d overdue`
                    : inst.computedStatus === "due_soon"
                      ? days === 0
                        ? "TODAY"
                        : `IN ${days}D`
                      : inst.computedStatus === "partially_paid"
                        ? "PARTIAL"
                        : `IN ${days}D`;

              return (
                <Card key={inst.id} padded={false} className="overflow-hidden">
                  <div className="flex items-start gap-3 px-4 pt-3.5">
                    <span
                      className={cx(
                        "mt-1 size-2.5 shrink-0 rounded-full",
                        inst.computedStatus === "paid"
                          ? "bg-good"
                          : inst.computedStatus === "overdue"
                            ? "bg-bad"
                            : inst.computedStatus === "due_soon"
                              ? "bg-warn"
                              : inst.computedStatus === "partially_paid"
                                ? "bg-brand"
                                : "bg-line-strong"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[14px] font-semibold text-ink">
                          EMI #{inst.installmentNumber}
                        </p>
                        <Badge tone={statusTone[inst.computedStatus] ?? "neutral"}>{label}</Badge>
                      </div>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        Due {formatDate(inst.dueDate)}
                      </p>

                      <div className="mt-2 space-y-0.5 text-[12px] text-ink-2">
                        <p>
                          Interest <span className="tabular-nums">{formatMoney(parseFloat(inst.interestAmount))}</span>
                          {parseFloat(inst.interestPaid) > 0 && (
                            <span className="font-semibold text-good">
                              {" "}
                              · <span className="tabular-nums">{formatMoney(parseFloat(inst.interestPaid))}</span> paid
                            </span>
                          )}
                        </p>
                        <p>
                          Principal{" "}
                          <span className="tabular-nums">
                            {formatMoney(parseFloat(inst.principalAmount))}
                          </span>
                          {parseFloat(inst.principalPaid) > 0 && (
                            <span className="font-semibold text-good">
                              {" "}
                              · <span className="tabular-nums">{formatMoney(parseFloat(inst.principalPaid))}</span> paid
                            </span>
                          )}
                        </p>
                        {view.waived > 0 && (
                          <p className="font-semibold text-warn">
                            Written off <span className="tabular-nums">{formatMoney(view.waived)}</span>
                          </p>
                        )}
                        {paid > 0 && !view.isPaid && (
                          <p className="text-ink-3">
                            Part paid: <span className="tabular-nums">{formatMoney(paid)}</span> of{" "}
                            <span className="tabular-nums">
                              {formatMoney(
                                parseFloat(inst.principalAmount) + parseFloat(inst.interestAmount)
                              )}
                            </span>
                          </p>
                        )}
                      </div>
                    </div>

                    {!view.isPaid && (
                      <p className="shrink-0 text-[17px] font-bold tabular-nums text-ink">
                        {formatMoney(view.totalRemaining)}
                      </p>
                    )}
                  </div>

                  {!view.isPaid && loan.status === "active" && (
                    <div className="mt-3 flex items-center gap-2 border-t border-line px-4 py-2.5">
                      <Button
                        size="sm"
                        onClick={() => {
                          haptics.tap();
                          setPayFor({ view, type: "both" });
                        }}
                      >
                        {isLender ? "Record payment" : "Pay this EMI"}
                      </Button>
                      {view.interestRemaining > 0 && view.principalRemaining > 0 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            haptics.tap();
                            setPayFor({ view, type: "interest" });
                          }}
                        >
                          Interest only
                        </Button>
                      )}
                      {isLender && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto"
                          onClick={() => {
                            haptics.tap();
                            setRemindFor(inst);
                          }}
                        >
                          <BellRing className="size-3.5" />
                          Remind
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Payments Tab */}
        {activeTab === "payments" && (
          <div className="stagger mt-3 space-y-2.5">
            {paymentError && <Notice tone="bad">{paymentError}</Notice>}

            {payments.length === 0 ? (
              <Card padded={false}>
                <EmptyState
                  icon={<Receipt className="size-6" />}
                  title="No payments recorded yet"
                  body="When either of you records a payment it appears here, with its status and any proof attached."
                />
              </Card>
            ) : (
              payments.map((payment) => {
                const confirmed = payment.status === "confirmed";
                const rejected = payment.status === "rejected";
                const mine = payment.markedByUserId === currentUserId;

                return (
                  <Card key={payment.id} padded={false} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[16px] font-bold tabular-nums text-ink">
                          {formatMoney(parseFloat(payment.amount))}
                          <span className="ml-1.5 text-[12px] font-medium text-ink-3">
                            {payment.paymentType === "payoff"
                              ? "full settlement"
                              : payment.paymentType}
                          </span>
                        </p>
                        <p className="mt-0.5 text-[12px] text-ink-3">
                          EMI #
                          {installments.find((i) => i.id === payment.installmentId)
                            ?.installmentNumber ?? "?"}{" "}
                          ·{" "}
                          {new Date(payment.createdAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                          })}
                          {payment.notes ? ` · ${payment.notes}` : ""}
                        </p>
                      </div>
                      <Badge tone={confirmed ? "good" : rejected ? "bad" : "warn"}>
                        {payment.status.toUpperCase()}
                      </Badge>
                    </div>

                    {parseFloat(payment.unappliedAmount || "0") > 0.01 && (
                      <p className="mt-2 text-[12px] font-medium text-warn">
                        {formatMoney(parseFloat(payment.unappliedAmount))} was received but not
                        applied to this loan.
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      {(payment.proofPublicId || payment.proofUrl) && (
                        <a
                          href={`/api/payments/${payment.id}/proof`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-strong"
                        >
                          <Receipt className="size-3.5" />
                          View proof
                        </a>
                      )}
                      {confirmed && (
                        <button
                          type="button"
                          onClick={() => sendReceipt(payment)}
                          className="tap inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-strong"
                        >
                          <Share2 className="size-3.5" />
                          {sharedReceiptId === payment.id ? "Receipt shared" : "Send receipt"}
                        </button>
                      )}
                    </div>

                    {payment.status === "pending" && (!mine || noCounterparty) && (
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          className="flex-1"
                          loading={busyPaymentId === payment.id}
                          onClick={() => handleConfirmPayment(payment.id, "confirm")}
                        >
                          <Check className="size-3.5" />
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="flex-1 text-bad"
                          onClick={() => handleConfirmPayment(payment.id, "reject")}
                        >
                          <X className="size-3.5" />
                          Reject
                        </Button>
                      </div>
                    )}

                    {payment.status === "pending" && mine && !noCounterparty && (
                      /* Marked by mistake? Take it back rather than waiting for
                         the other side to act - a pending claim blocks every
                         later payment on the loan. */
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <p className="text-[12px] font-medium text-warn">
                          Waiting for {isLender ? "the borrower" : "the lender"} to confirm
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleConfirmPayment(payment.id, "withdraw")}
                        >
                          Withdraw
                        </Button>
                      </div>
                    )}

                    {payment.status === "pending" && mine && noCounterparty && (
                      <p className="mt-3 text-[12px] font-medium text-warn">
                        {loan.borrowerName} hasn&apos;t joined Udhaar yet, so you can confirm this
                        yourself.
                      </p>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        )}

        {mayManageRecord && (
          <div className="mt-6 flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              icon={<Pencil className="size-4" />}
              onClick={() => openEditForm(loan)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              className="flex-1 text-bad"
              icon={<Trash2 className="size-4" />}
              onClick={handleDeleteLoan}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {/*
       * The payment sheet: the same component the home screen opens, so
       * "record a payment" means one thing everywhere. Its target carries the
       * per-installment figures this screen already worked out (net of waivers)
       * rather than making the sheet derive them again.
       */}
      {payFor && (
        <PaySheet
          key={payFor.view.inst.id}
          initialType={payFor.type}
          target={
            {
              installmentId: payFor.view.inst.id,
              installmentNumber: payFor.view.inst.installmentNumber,
              dueDate: payFor.view.inst.dueDate,
              principalRemaining: payFor.view.principalRemaining,
              interestRemaining: payFor.view.interestRemaining,
              counterparty: counterpartyName,
              viewerRole: loan.viewerRole,
              upiId: isLender ? null : loan.upiId,
            } satisfies PayTarget
          }
          onClose={() => setPayFor(null)}
          onRecorded={(_applied, amount) => {
            flashMessage(`Payment of ${formatMoney(amount)} recorded.`);
            void loadData();
          }}
        />
      )}

      {remindFor && (
        <RemindSheet
          key={remindFor.id}
          target={{
            installmentId: remindFor.id,
            installmentNumber: remindFor.installmentNumber,
            dueDate: remindFor.dueDate,
            remaining: viewOf(remindFor).totalRemaining,
            borrowerName: loan.borrowerName,
            canPush: Boolean(loan.borrowerId),
          }}
          onClose={() => setRemindFor(null)}
          onSent={() => {
            void loadData();
          }}
        />
      )}

      {/* Settle in full - one payment for the whole loan */}
      <Sheet
        open={payoffOpen}
        onClose={() => {
          setPayoffOpen(false);
          setPayoffProofId(null);
          setPayoffError(null);
        }}
        title="Settle in full"
        subtitle={`${formatMoney(principalOutstanding)} principal + ${formatMoney(interestOutstanding)} interest outstanding`}
        size="tall"
        footer={
          <Button
            block
            size="lg"
            loading={payoffLoading}
            disabled={!payoffAmount}
            onClick={() => handlePayoff(loanOutstanding)}
          >
            {payoffLoading ? "Recording" : `Settle loan · ${formatMoney(parseFloat(payoffAmount) || 0)}`}
          </Button>
        }
      >
        <div className="space-y-4 pt-1">
          <div className={cx("grid gap-2", canWaiveOnSettle ? "grid-cols-2" : "grid-cols-1")}>
            {canWaiveOnSettle && (
              <button
                onClick={() => {
                  setPayoffAmount(principalOutstanding.toFixed(2));
                  setPayoffError(null);
                }}
                className={cx(
                  "tap rounded-control border p-3 text-left",
                  Math.abs(parseFloat(payoffAmount || "0") - principalOutstanding) < 0.005
                    ? "border-brand bg-brand-soft"
                    : "border-line bg-surface"
                )}
              >
                <span className="block text-[14px] font-bold tabular-nums text-ink">
                  {formatMoney(principalOutstanding)}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-2">
                  Settle the principal
                  {interestOutstanding > 0.01
                    ? ` · waives ${formatMoney(interestOutstanding)} interest`
                    : ""}
                </span>
              </button>
            )}
            <button
              onClick={() => {
                setPayoffAmount(loanOutstanding.toFixed(2));
                setPayoffError(null);
              }}
              className={cx(
                "tap rounded-control border p-3 text-left",
                Math.abs(parseFloat(payoffAmount || "0") - loanOutstanding) < 0.005
                  ? "border-brand bg-brand-soft"
                  : "border-line bg-surface"
              )}
            >
              <span className="block text-[14px] font-bold tabular-nums text-ink">
                {formatMoney(loanOutstanding)}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-2">
                Pay everything, interest included
              </span>
            </button>
          </div>

          {!canWaiveOnSettle && interestOutstanding > 0.01 && (
            <p className="text-[12px] text-ink-3">
              Only {counterpartyName} can waive the interest - pay the full amount and they can
              settle it from their side.
            </p>
          )}

          <Field label="Amount received" hint="₹">
            <Input
              inputMode="decimal"
              value={payoffAmount}
              onChange={(event) => {
                setPayoffAmount(event.target.value);
                setPayoffError(null);
                setAcceptExtra(false);
              }}
              className="text-[20px] font-bold"
            />
          </Field>

          {parseFloat(payoffAmount || "0") - loanOutstanding > 0.01 && (
            <label className="flex items-start gap-2.5 rounded-control bg-warn-soft p-3">
              <input
                type="checkbox"
                checked={acceptExtra}
                onChange={(event) => {
                  setAcceptExtra(event.target.checked);
                  setPayoffError(null);
                }}
                className="mt-0.5 size-4 accent-[var(--brand)]"
              />
              <span className="text-[12px] font-medium text-warn">
                {formatMoney(parseFloat(payoffAmount) - loanOutstanding)} more arrived than the loan
                owes. It will be recorded as received but not applied, so the history matches the
                bank statement.
              </span>
            </label>
          )}

          <Field label="Notes" hint="optional">
            <Input
              value={payoffNotes}
              onChange={(event) => setPayoffNotes(event.target.value)}
              placeholder="Cleared the balance by UPI..."
            />
          </Field>

          <ProofUpload
            onCapture={(id) => setPayoffProofId(id || null)}
            onClear={() => setPayoffProofId(null)}
          />

          {payoffError && <Notice tone="bad">{payoffError}</Notice>}
        </div>
      </Sheet>

      {/* Edit - whoever entered the record, while it is only theirs */}
      <Sheet
        open={editOpen && Boolean(editForm)}
        onClose={() => {
          setEditOpen(false);
          setEditError("");
        }}
        title="Edit loan"
        subtitle="Borrower and repayment details"
        size="tall"
        footer={
          <Button
            block
            size="lg"
            loading={savingEdit}
            onClick={handleSaveEdit}
          >
            {savingEdit ? "Saving" : "Save changes"}
          </Button>
        }
      >
        {editForm && (
          <div className="space-y-3.5 pt-1">
            <Field label="Name">
              <Input
                value={editForm.borrowerName}
                onChange={(event) =>
                  setEditForm({ ...editForm, borrowerName: event.target.value })
                }
              />
            </Field>

            <Field label="Mobile number">
              <Input
                inputMode="numeric"
                value={editForm.borrowerMobile}
                onChange={(event) =>
                  setEditForm({
                    ...editForm,
                    borrowerMobile: event.target.value.replace(/\D/g, "").slice(0, 10),
                  })
                }
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount" hint="₹">
                <Input
                  inputMode="decimal"
                  value={editForm.amount}
                  onChange={(event) => setEditForm({ ...editForm, amount: event.target.value })}
                />
              </Field>
              <Field label="Tenure" hint="months">
                <Input
                  inputMode="numeric"
                  value={editForm.tenureMonths}
                  onChange={(event) =>
                    setEditForm({ ...editForm, tenureMonths: event.target.value })
                  }
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Interest rate" hint="%">
                <Input
                  inputMode="decimal"
                  value={editForm.interestRate}
                  onChange={(event) =>
                    setEditForm({ ...editForm, interestRate: event.target.value })
                  }
                />
              </Field>
              <Field label="Charged">
                <div className="flex gap-2">
                  {(["yearly", "monthly"] as const).map((period) => (
                    <button
                      key={period}
                      onClick={() => setEditForm({ ...editForm, interestRatePeriod: period })}
                      aria-pressed={editForm.interestRatePeriod === period}
                      className={cx(
                        "tap h-[46px] flex-1 rounded-control border text-[13px] font-semibold capitalize",
                        editForm.interestRatePeriod === period
                          ? "border-brand bg-brand-soft text-brand-strong"
                          : "border-line text-ink-3"
                      )}
                    >
                      {period === "yearly" ? "Yearly" : "Monthly"}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            <Field label="Start date">
              <Input
                type="date"
                value={editForm.startDate}
                onChange={(event) => setEditForm({ ...editForm, startDate: event.target.value })}
              />
            </Field>

            <Field label="UPI id" hint="for payments">
              <Input
                value={editForm.upiId}
                onChange={(event) => setEditForm({ ...editForm, upiId: event.target.value })}
                placeholder="name@bank"
              />
            </Field>

            <Field label="Account number" hint="optional">
              <Input
                value={editForm.accountNumber}
                onChange={(event) =>
                  setEditForm({ ...editForm, accountNumber: event.target.value })
                }
              />
            </Field>

            <Field label="Notes" hint="optional">
              <Input
                value={editForm.notes}
                onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })}
                placeholder="Why the money was borrowed"
              />
            </Field>

            <Field label="Confirmation" hint="who signs off a payment">
              <div className="flex gap-2">
                {(["1-side", "2-side"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setEditForm({ ...editForm, confirmationMode: mode })}
                    aria-pressed={editForm.confirmationMode === mode}
                    className={cx(
                      "tap h-[46px] flex-1 rounded-control border text-[13px] font-semibold",
                      editForm.confirmationMode === mode
                        ? "border-brand bg-brand-soft text-brand-strong"
                        : "border-line text-ink-3"
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </Field>

            {editError && <Notice tone="bad">{editError}</Notice>}
          </div>
        )}
      </Sheet>

      {/* Details: the record itself - ids, dates, notes, invite */}
      <Sheet
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="Loan details"
        subtitle={`${loan.borrowerName} · +91 ${loan.borrowerMobile}`}
      >
        <div className="pt-1">
          {loan.upiId && <DetailRow label="UPI id" value={<span className="font-mono">{loan.upiId}</span>} />}
          {loan.accountNumber && (
            <DetailRow
              label="Account"
              value={<span className="font-mono">{loan.accountNumber}</span>}
            />
          )}
          <DetailRow label="Start date" value={formatDate(loan.startDate)} />
          <DetailRow
            label="Confirmation"
            value={loan.confirmationMode}
            note={loan.confirmationMode === "2-side" ? "Both sides sign off" : "One side records"}
          />
          <DetailRow label="Interest" value={`${loan.interestRate}% ${loan.interestRatePeriod}`} />
          <DetailRow label="Tenure" value={`${loan.tenureMonths} months`} />
          {loan.notes && <DetailRow label="Notes" value={loan.notes} />}

          {upiLink && (
            <a href={upiLink} className={buttonClasses("primary", "lg", "mt-4 w-full")}>
              <Wallet className="size-4" />
              Open UPI app to pay
            </a>
          )}

          {isLender && (
            <Button
              block
              variant="secondary"
              className="mt-2"
              icon={<Share2 className="size-4" />}
              onClick={shareInvite}
            >
              {shared ? "Shared" : "Invite them to Udhaar"}
            </Button>
          )}
        </div>
      </Sheet>
    </MobileShell>
  );
}
