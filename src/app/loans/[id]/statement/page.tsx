"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, FileText, Printer, RotateCw, Share2 } from "lucide-react";
import BottomNav from "@/components/BottomNav";
import { Badge, Button, Card, EmptyState, Notice, Skeleton, cx } from "@/components/ui";
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
 *
 * It keeps its own wider frame rather than the app's phone-width shell: this is
 * a document, and a document reads better at the width of paper. Printing
 * always comes out light, whatever theme the phone is in.
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

  const statusTone = (status: string): "good" | "bad" | "warn" | "neutral" =>
    status === "paid" || status === "confirmed"
      ? "good"
      : status === "overdue" || status === "rejected"
        ? "bad"
        : status === "partially_paid" || status === "pending"
          ? "warn"
          : "neutral";

  const statusChip = (status: string) => (
    <Badge tone={statusTone(status)}>{status.replace("_", " ").toUpperCase()}</Badge>
  );

  if (loading) {
    // The tab bar is here too: a document that takes a moment to load is still
    // a screen in an app, and leaving the bottom of it empty makes it look
    // like the app fell over.
    return (
      <div className="mx-auto w-full max-w-2xl px-4 pb-28 py-5">
        <Skeleton className="h-8 w-40 rounded-control" />
        <Skeleton className="mt-4 h-44 rounded-card" />
        <Skeleton className="mt-3 h-24 rounded-card" />
        <BottomNav />
      </div>
    );
  }

  if (loadError || !loan) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-5">
        <Card padded={false}>
          <EmptyState
            icon={<FileText className="size-6" />}
            title="Couldn't open the statement"
            body={loadError ?? "This loan could not be loaded."}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {loadError && (
                  <Button onClick={() => void load()} icon={<RotateCw className="size-4" />}>
                    Try again
                  </Button>
                )}
                <Link href={loanId ? `/loans/${loanId}` : "/dashboard"} className="tap">
                  <Button variant="secondary">Back to the loan</Button>
                </Link>
              </div>
            }
          />
        </Card>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl px-4 pb-28 pt-3 print:max-w-none print:bg-white print:pb-0 print:pt-0">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/loans/${loan.id}`}
          className="tap -ml-2 flex items-center gap-0.5 rounded-control px-2 py-2 text-[13px] font-semibold text-ink-2 hover:bg-surface-2"
        >
          <ChevronLeft className="size-4" />
          Loan
        </Link>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onShareStatement}>
            <Share2 className="size-3.5" />
            {sharedWhat === "statement" ? "Shared" : "Share"}
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="size-3.5" />
            Print / PDF
          </Button>
        </div>
      </div>

      {/* Header */}
      <Card className="mt-3 print:border-0 print:shadow-none">
        <p className="text-[10px] font-bold uppercase tracking-widest text-brand-strong">
          Udhaar · loan statement
        </p>
        <h1 className="mt-1 text-[22px] font-bold tracking-tight text-ink">{counterpartyName}</h1>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {loan.viewerRole === "lender" ? "You lent" : "You borrowed"} · statement dated{" "}
          {new Date().toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          {[
            ["Amount", formatINR(parseFloat(loan.amount))],
            [
              "Interest",
              `${loan.interestRate}% ${loan.interestRatePeriod === "monthly" ? "per month" : "per year"}`,
            ],
            ["Tenure", `${loan.tenureMonths} month${loan.tenureMonths === 1 ? "" : "s"}`],
            ["Started", loan.startDate],
            ["Status", loan.status === "active" ? "Running" : loan.status],
            ["EMIs", String(installments.length)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] text-ink-3">{label}</dt>
              <dd className="text-[13px] font-semibold tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {/* Totals */}
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: "Scheduled", value: totals.scheduled, tone: "text-ink" },
          { label: "Paid", value: totals.paid, tone: "text-good" },
          ...(totals.waived > 0
            ? [{ label: "Waived", value: totals.waived, tone: "text-warn" }]
            : []),
          { label: "Still owed", value: totals.outstanding, tone: "text-bad" },
        ].map((tile) => (
          <Card key={tile.label} className="p-3.5 print:border print:border-line print:shadow-none">
            <p className="text-[10px] font-bold uppercase tracking-wide text-ink-3">{tile.label}</p>
            <p className={cx("text-[17px] font-bold tabular-nums", tile.tone)}>
              {formatINR(tile.value)}
            </p>
          </Card>
        ))}
      </div>

      {/* Schedule */}
      <Card padded={false} className="mt-3 overflow-hidden print:border print:border-line print:shadow-none">
        <h2 className="px-4 pb-2 pt-4 text-[14px] font-semibold text-ink">Schedule</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="px-4 py-2 font-semibold">#</th>
                <th className="px-2 py-2 font-semibold">Due</th>
                <th className="px-2 py-2 text-right font-semibold">Amount</th>
                <th className="px-2 py-2 text-right font-semibold">Paid</th>
                <th className="px-2 py-2 text-right font-semibold">Balance</th>
                <th className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {installments.map((inst) => {
                const paid = Number(inst.principalPaid) + Number(inst.interestPaid);
                const waived =
                  Number(inst.principalWaived ?? 0) + Number(inst.interestWaived ?? 0);
                const balance =
                  Math.max(
                    0,
                    Number(inst.principalAmount) -
                      Number(inst.principalPaid) -
                      Number(inst.principalWaived ?? 0)
                  ) +
                  Math.max(
                    0,
                    Number(inst.interestAmount) -
                      Number(inst.interestPaid) -
                      Number(inst.interestWaived ?? 0)
                  );
                return (
                  <tr key={inst.installmentNumber} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2 text-ink-3">{inst.installmentNumber}</td>
                    <td className="px-2 py-2 text-ink-2">{inst.dueDate}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink-2">
                      {formatINR(Number(inst.totalAmount))}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-good">
                      {paid > 0 ? formatINR(paid) : "—"}
                      {waived > 0 && (
                        <span className="text-ink-3"> (+{formatINR(waived)} waived)</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums text-ink">
                      {balance > 0 ? formatINR(balance) : "—"}
                    </td>
                    <td className="px-4 py-2">{statusChip(inst.computedStatus ?? "pending")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Payments */}
      <Card padded={false} className="mt-3 overflow-hidden print:border print:border-line print:shadow-none">
        <h2 className="px-4 pb-2 pt-4 text-[14px] font-semibold text-ink">
          Payments ({payments.length})
        </h2>
        {payments.length === 0 ? (
          <p className="px-4 pb-4 text-[12px] text-ink-3">No payments recorded yet.</p>
        ) : (
          <ul>
            {payments.map((payment, index) => (
              <li
                key={index}
                className="flex items-start justify-between gap-3 border-t border-line px-4 py-3 first:border-0"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold tabular-nums text-ink">
                    {formatINR(Number(payment.amount))}
                    <span className="text-[12px] font-normal text-ink-3">
                      {" "}
                      · {payment.paymentType}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {new Date(payment.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {payment.notes ? ` · ${payment.notes}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {statusChip(payment.status)}
                  <button
                    type="button"
                    onClick={() => onShareReceipt(payment, index)}
                    className="tap text-[12px] font-semibold text-brand-strong print:hidden"
                  >
                    {sharedWhat === `payment-${index}` ? "Sent" : "Receipt"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Notice tone="neutral" className="mt-3 print:bg-transparent">
        This statement is a record of what both sides entered in Udhaar. It is not a legal document,
        and it does not move money.
      </Notice>

      <div className="print:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
