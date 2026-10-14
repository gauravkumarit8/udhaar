"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import { requestJson } from "@/lib/http";
import { useHaptics, useShare } from "@/hooks/useNative";
import {
  formatINR,
  paymentReceiptText,
  statementText,
  statementTotals,
  type StatementInstallment,
  type StatementPayment,
} from "@/lib/loan-statement";

/**
 * A loan statement a person can hand to somebody.
 *
 * Everything here is the record both sides have been looking at all along: the
 * schedule, what has been paid, what was waived, and what is left. It exists
 * because informal lending runs on "send me the details" - and the details were
 * previously spread across two tabs of a phone screen, one of which the other
 * person may not even have installed.
 *
 * Two ways out that matter: *Share* (a short WhatsApp-sized summary, plus a
 * per-payment receipt) and *Print / Save as PDF* (the whole sheet, for a
 * printout or a file). The arithmetic comes from src/lib/loan-statement.ts,
 * which is unit-tested, rather than being computed in the render below.
 */

interface LoanDetail {
  loan: {
    id: string;
    borrowerName: string;
    lenderName: string | null;
    amount: string;
    interestRate: string;
    interestRatePeriod: string;
    tenureMonths: number;
    startDate: string;
    status: string;
    viewerRole: "lender" | "borrower";
    upiId?: string | null;
  };
  installments: StatementInstallment[];
  payments: StatementPayment[];
}

export default function LoanStatementPage() {
  const params = useParams<{ id: string }>();
  const loanId = params?.id;

  const [data, setData] = useState<LoanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sharedWhat, setSharedWhat] = useState<string | null>(null);

  const { share } = useShare();
  const haptics = useHaptics();

  const load = useCallback(async () => {
    if (!loanId) return;
    try {
      const result = await requestJson<LoanDetail>(`/api/loans/${loanId}`);
      if (result.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!result.ok || !result.data) {
        setLoadError(result.error ?? "Couldn't load this loan.");
        return;
      }
      setData(result.data);
    } catch {
      setLoadError("Couldn't load this loan. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [loanId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const loan = data?.loan;
  const installments = data?.installments ?? [];
  const payments = data?.payments ?? [];
  const totals = statementTotals(installments);

  const counterpartyName = loan
    ? loan.viewerRole === "lender"
      ? loan.borrowerName
      : loan.lenderName || "Lender"
    : "";

  const onShareStatement = async () => {
    if (!loan) return;
    haptics.tap();
    const text = statementText(loan, installments, payments, loan.viewerRole);
    await share({ title: `Loan statement — ${counterpartyName}`, text });
    setSharedWhat("statement");
    setTimeout(() => setSharedWhat(null), 4000);
  };

  const onShareReceipt = async (payment: StatementPayment, index: number) => {
    if (!loan) return;
    haptics.tap();
    const text = paymentReceiptText(loan, payment, loan.viewerRole);
    await share({ title: `Payment receipt — ${counterpartyName}`, text });
    setSharedWhat(`payment-${index}`);
    setTimeout(() => setSharedWhat(null), 4000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-8">
        <p className="text-center text-slate-400 text-sm">Loading statement…</p>
      </div>
    );
  }

  if (loadError || !loan) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-8 space-y-4">
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 text-sm text-red-700">
          {loadError ?? "This loan could not be loaded."}
        </div>
        <Link
          href={loanId ? `/loans/${loanId}` : "/dashboard"}
          className="block text-center text-emerald-600 font-semibold text-sm"
        >
          ← Back to the loan
        </Link>
        <BottomNav />
      </div>
    );
  }

  const statusChip = (status: string) => {
    const tone =
      status === "paid" || status === "confirmed"
        ? "bg-emerald-100 text-emerald-700"
        : status === "overdue" || status === "rejected"
          ? "bg-red-100 text-red-700"
          : status === "partially_paid" || status === "pending"
            ? "bg-amber-100 text-amber-700"
            : "bg-slate-100 text-slate-500";
    return (
      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tone}`}>
        {status.replace("_", " ").toUpperCase()}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 print:bg-white pb-24 print:pb-0">
      <div className="max-w-2xl mx-auto px-4 py-4 space-y-3">
        {/* Toolbar - never printed */}
        <div className="flex items-center justify-between print:hidden">
          <Link href={`/loans/${loan.id}`} className="text-sm text-slate-500 tap-highlight">
            ← Back
          </Link>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onShareStatement}
              className="px-3 py-2 bg-white border border-emerald-200 text-emerald-700 rounded-xl text-xs font-semibold tap-highlight"
            >
              {sharedWhat === "statement" ? "✓ Shared" : "📤 Share"}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3 py-2 bg-emerald-600 text-white rounded-xl text-xs font-semibold tap-highlight"
            >
              🖨 Print / PDF
            </button>
          </div>
        </div>

        {/* Header */}
        <div className="bg-white rounded-2xl border border-slate-100 p-5 print:border-0 print:rounded-none">
          <p className="text-[10px] font-bold tracking-widest text-emerald-600 uppercase">
            Udhaar · loan statement
          </p>
          <h1 className="text-xl font-extrabold text-slate-800 mt-1">{counterpartyName}</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {loan.viewerRole === "lender" ? "You lent" : "You borrowed"} · statement dated{" "}
            {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
          </p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 text-sm">
            <div>
              <dt className="text-xs text-slate-400">Amount</dt>
              <dd className="font-semibold text-slate-800">{formatINR(parseFloat(loan.amount))}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Interest</dt>
              <dd className="font-semibold text-slate-800">
                {loan.interestRate}% {loan.interestRatePeriod === "monthly" ? "per month" : "per year"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Tenure</dt>
              <dd className="font-semibold text-slate-800">
                {loan.tenureMonths} month{loan.tenureMonths === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Started</dt>
              <dd className="font-semibold text-slate-800">{loan.startDate}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Status</dt>
              <dd className="font-semibold text-slate-800">
                {loan.status === "active" ? "Running" : loan.status}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">EMIs</dt>
              <dd className="font-semibold text-slate-800">{installments.length}</dd>
            </div>
          </dl>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[
            { label: "Scheduled", value: totals.scheduled, tone: "text-slate-800" },
            { label: "Paid", value: totals.paid, tone: "text-emerald-600" },
            ...(totals.waived > 0
              ? [{ label: "Waived", value: totals.waived, tone: "text-slate-400" }]
              : []),
            { label: "Still owed", value: totals.outstanding, tone: "text-amber-600" },
          ].map((tile) => (
            <div
              key={tile.label}
              className="bg-white rounded-2xl border border-slate-100 p-3.5 print:border print:border-slate-200"
            >
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                {tile.label}
              </p>
              <p className={`text-lg font-extrabold ${tile.tone}`}>{formatINR(tile.value)}</p>
            </div>
          ))}
        </div>

        {/* Schedule */}
        <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden print:border print:border-slate-200">
          <h2 className="text-sm font-bold text-slate-800 px-4 pt-4 pb-2">Schedule</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-2 font-semibold">#</th>
                  <th className="px-2 py-2 font-semibold">Due</th>
                  <th className="px-2 py-2 font-semibold text-right">Amount</th>
                  <th className="px-2 py-2 font-semibold text-right">Paid</th>
                  <th className="px-2 py-2 font-semibold text-right">Balance</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {installments.map((inst) => {
                  const paid = Number(inst.principalPaid) + Number(inst.interestPaid);
                  const waived = Number(inst.principalWaived ?? 0) + Number(inst.interestWaived ?? 0);
                  const balance =
                    Math.max(0, Number(inst.principalAmount) - Number(inst.principalPaid) - Number(inst.principalWaived ?? 0)) +
                    Math.max(0, Number(inst.interestAmount) - Number(inst.interestPaid) - Number(inst.interestWaived ?? 0));
                  return (
                    <tr key={inst.installmentNumber} className="border-b border-slate-50 last:border-0">
                      <td className="px-4 py-2 text-slate-400">{inst.installmentNumber}</td>
                      <td className="px-2 py-2 text-slate-600">{inst.dueDate}</td>
                      <td className="px-2 py-2 text-right text-slate-700">
                        {formatINR(Number(inst.totalAmount))}
                      </td>
                      <td className="px-2 py-2 text-right text-emerald-600">
                        {paid > 0 ? formatINR(paid) : "—"}
                        {waived > 0 && <span className="text-slate-400"> (+{formatINR(waived)} waived)</span>}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-800">
                        {balance > 0 ? formatINR(balance) : "—"}
                      </td>
                      <td className="px-4 py-2">{statusChip(inst.computedStatus ?? "pending")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Payments */}
        <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden print:border print:border-slate-200">
          <h2 className="text-sm font-bold text-slate-800 px-4 pt-4 pb-2">
            Payments ({payments.length})
          </h2>
          {payments.length === 0 ? (
            <p className="text-xs text-slate-400 px-4 pb-4">No payments recorded yet.</p>
          ) : (
            <ul>
              {payments.map((payment, index) => (
                <li
                  key={index}
                  className="px-4 py-3 border-t border-slate-50 first:border-0 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">
                      {formatINR(Number(payment.amount))}
                      <span className="text-xs font-normal text-slate-400">
                        {" "}
                        · {payment.paymentType}
                      </span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {new Date(payment.createdAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {payment.notes ? ` · ${payment.notes}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {statusChip(payment.status)}
                    <button
                      type="button"
                      onClick={() => onShareReceipt(payment, index)}
                      className="text-xs text-emerald-600 font-semibold tap-highlight print:hidden"
                    >
                      {sharedWhat === `payment-${index}` ? "✓" : "Receipt"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-slate-400 text-center px-4">
          This statement is a record of what both sides entered in Udhaar. It is not a legal
          document, and it does not move money.
        </p>
      </div>

      <div className="print:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
