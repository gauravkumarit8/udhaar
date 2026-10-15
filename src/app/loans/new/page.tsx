"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Info, Sparkles, TrendingUp } from "lucide-react";
import MobileShell from "@/components/MobileShell";
import {
  Badge,
  Button,
  Card,
  Chip,
  Field,
  Input,
  Notice,
  cx,
  formatMoney,
} from "@/components/ui";
import { generateInstallmentSchedule } from "@/lib/calculations";
import { requestJson } from "@/lib/http";

/**
 * Adding a loan, in three short steps.
 *
 * The order is the order the conversation happens in: who, then how much and
 * on what terms, then how the money travels. Two things on this screen exist
 * purely to save typing on a phone - the quick amount chips (₹5,000, ₹10,000,
 * ₹50,000) and the quick durations (3 months, 1 year) - and the EMI preview
 * updates as you type, so the terms are agreed before the record is written
 * rather than discovered on the next screen.
 *
 * Interest-free is the default: most loans between friends and family in India
 * carry none (CMIE, 2024), so charging it is the deliberate act.
 */
export default function NewLoanPage() {
  const [form, setForm] = useState({
    borrowerName: "",
    borrowerMobile: "",
    lenderName: "",
    lenderMobile: "",
    amount: "",
    interestRate: "12",
    interestRatePeriod: "yearly" as "monthly" | "yearly",
    tenureMonths: "12",
    startDate: new Date().toISOString().split("T")[0],
    upiId: "",
    accountNumber: "",
    notes: "",
    confirmationMode: "1-side",
  });
  const [chargeInterest, setChargeInterest] = useState(false);
  /**
   * Which way round the loan is: "lender" (I lent money) or "borrower" (I owe
   * money and I am writing it down myself). Real people sit on both sides of
   * this - the same person who lent ₹5,000 to a cousin has borrowed ₹20,000
   * from a brother-in-law.
   */
  const [side, setSide] = useState<"lender" | "borrower">("lender");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(1); // 1: borrower, 2: loan, 3: payment

  // Derived straight from the form, not from a setTimeout that read a stale
  // closure - the preview used to lag one keystroke behind the inputs.
  const preview = useMemo(() => {
    const principal = parseFloat(form.amount) || 0;
    const rate = chargeInterest ? parseFloat(form.interestRate) || 0 : 0;
    const tenure = parseInt(form.tenureMonths) || 0;

    if (principal <= 0 || tenure <= 0) return null;

    const schedule = generateInstallmentSchedule(
      principal,
      rate,
      tenure,
      form.startDate || new Date().toISOString().split("T")[0],
      form.interestRatePeriod
    );

    const emi = rate === 0 ? principal / tenure : (schedule[0]?.totalAmount ?? principal / tenure);
    const totalInterest =
      rate === 0 ? 0 : schedule.reduce((sum, installment) => sum + installment.interestAmount, 0);
    const totalAmount =
      rate === 0
        ? principal
        : schedule.reduce((sum, installment) => sum + installment.totalAmount, 0);

    return {
      emi: Math.round(emi * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
    };
  }, [
    form.amount,
    form.interestRate,
    form.tenureMonths,
    form.startDate,
    form.interestRatePeriod,
    chargeInterest,
  ]);

  const updateField = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const nextStep = () => {
    const partnerName = side === "lender" ? form.borrowerName : form.lenderName;
    const partnerMobile = side === "lender" ? form.borrowerMobile : form.lenderMobile;
    const who = side === "lender" ? "borrower" : "lender";

    if (step === 1 && (!partnerName || !/^\d{10}$/.test(partnerMobile))) {
      setError(`Enter the ${who}'s name and valid 10-digit mobile`);
      return;
    }
    if (step === 2 && (!form.amount || parseFloat(form.amount) <= 0 || !form.tenureMonths)) {
      setError("Enter valid loan amount and tenure");
      return;
    }
    setError("");
    setStep(step + 1);
  };

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    const result = await requestJson<{ loan: { id: string } }>("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        side,
        interestRate: chargeInterest ? form.interestRate : "0",
      }),
    });

    if (!result.ok) {
      // Surfaces the server's own validation message ("Amount looks too
      // large", "Borrower mobile must be exactly 10 digits", ...)
      setError(result.error ?? "Couldn't save the loan. Try again.");
      setLoading(false);
      return;
    }

    window.location.href = `/loans/${result.data?.loan.id}`;
  };

  const steps = ["Who", "Terms", "Payment"];
  const partnerName = side === "lender" ? form.borrowerName : form.lenderName;

  return (
    <MobileShell
      title="New loan"
      subtitle={`Step ${step} of 3 · ${steps[step - 1]}`}
      back="/dashboard"
      showNav={false}
    >
      <div className="px-4 pb-8 pt-3">
        {/* Where you are, in one line, with the parts already answered ticked. */}
        <div className="mb-5 flex items-center gap-1.5">
          {steps.map((label, idx) => {
            const num = idx + 1;
            const done = step > num;
            const current = step === num;
            return (
              <div key={label} className="flex flex-1 items-center gap-1.5">
                <span
                  className={cx(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                    done
                      ? "bg-good text-white"
                      : current
                        ? "bg-brand text-brand-ink"
                        : "bg-surface-3 text-ink-3"
                  )}
                >
                  {done ? <Check className="size-3.5" /> : num}
                </span>
                <span
                  className={cx(
                    "text-[11px] font-semibold",
                    current ? "text-ink" : "text-ink-3"
                  )}
                >
                  {label}
                </span>
                {idx < steps.length - 1 && (
                  <span className={cx("h-px flex-1", done ? "bg-good" : "bg-line")} />
                )}
              </div>
            );
          })}
        </div>

        {step === 1 && (
          <div className="animate-rise space-y-4">
            <div>
              <h2 className="text-[19px] font-bold tracking-tight text-ink">
                {side === "lender" ? "Who are you lending to?" : "Who did you borrow from?"}
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {side === "lender"
                  ? "We'll set the reminders up for you - they don't need the app."
                  : "Keep your own record of what you owe - they don't need the app."}
              </p>
            </div>

            {/* Which side of the loan this is. Both are useful: the lender
                tracks what's coming back, the borrower tracks what they owe. */}
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "lender" as const, label: "I lent money" },
                  { value: "borrower" as const, label: "I borrowed" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setSide(option.value);
                    setError("");
                  }}
                  aria-pressed={side === option.value}
                  className={cx(
                    "tap rounded-card border py-3 text-[14px] font-semibold",
                    side === option.value
                      ? "border-brand bg-brand-soft text-brand-strong"
                      : "border-line bg-surface text-ink-2"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <Field label={side === "lender" ? "Their name" : "Lender's name"}>
              <Input
                type="text"
                value={partnerName}
                onChange={(e) =>
                  updateField(side === "lender" ? "borrowerName" : "lenderName", e.target.value)
                }
                placeholder={side === "lender" ? "Rahul Sharma" : "Uncle Suresh"}
                autoComplete="off"
              />
            </Field>

            <Field label="Mobile number">
              <div className="flex items-center gap-2.5 rounded-control border border-line bg-surface px-3.5 focus-within:border-brand focus-within:ring-4 focus-within:ring-[var(--ring)]">
                <span className="text-[15px] font-semibold text-ink-3">+91</span>
                <span className="h-6 w-px bg-line" />
                <input
                  type="tel"
                  inputMode="numeric"
                  value={side === "lender" ? form.borrowerMobile : form.lenderMobile}
                  onChange={(e) =>
                    updateField(
                      side === "lender" ? "borrowerMobile" : "lenderMobile",
                      e.target.value.replace(/\D/g, "").slice(0, 10)
                    )
                  }
                  placeholder="9876543210"
                  maxLength={10}
                  className="w-full bg-transparent py-3 text-[15px] text-ink outline-none placeholder:text-ink-3"
                />
              </div>
            </Field>

            {error && <Notice tone="bad">{error}</Notice>}

            <Button block size="lg" onClick={nextStep} icon={<ArrowRight className="size-4" />}>
              Continue
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="animate-rise space-y-4">
            <div>
              <h2 className="text-[19px] font-bold tracking-tight text-ink">Loan details</h2>
              <p className="mt-1 text-[13px] text-ink-2">Amount, interest and how long for.</p>
            </div>

            <Field label="Loan amount" hint="₹">
              <Input
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => updateField("amount", e.target.value)}
                placeholder="50000"
                className="text-[20px] font-bold"
              />
            </Field>

            {/* The amounts people actually lend each other. Typing "10000" on a
                phone keypad is the slowest part of this screen. */}
            <div className="-mt-1 flex flex-wrap gap-2">
              {["1000", "2000", "5000", "10000", "25000", "50000"].map((quick) => (
                <Chip
                  key={quick}
                  active={form.amount === quick}
                  onClick={() => updateField("amount", quick)}
                >
                  {formatMoney(Number(quick))}
                </Chip>
              ))}
            </div>

            {/* Interest: off by default, because most loans between friends and
                family are interest-free. */}
            <Card>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className={cx(
                      "flex size-10 items-center justify-center rounded-control",
                      chargeInterest ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-2"
                    )}
                  >
                    <TrendingUp className="size-5" />
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-ink">
                      {chargeInterest ? "Interest is charged" : "Interest-free"}
                    </p>
                    <p className="text-[11px] leading-snug text-ink-3">
                      {chargeInterest
                        ? "Set the rate below"
                        : "You get back exactly what you lend - the usual loan between friends and family"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setChargeInterest((prev) => !prev)}
                  aria-pressed={chargeInterest}
                  aria-label="Charge interest"
                  className={cx(
                    "tap relative h-7 w-12 shrink-0 rounded-full transition-colors",
                    chargeInterest ? "bg-good" : "bg-line-strong"
                  )}
                >
                  <span
                    className={cx(
                      "absolute top-1 size-5 rounded-full bg-white shadow transition-transform",
                      chargeInterest ? "translate-x-6" : "translate-x-1"
                    )}
                  />
                </button>
              </div>

              {chargeInterest && (
                <div className="animate-rise mt-4 space-y-3">
                  <Field label="Interest rate" hint="%">
                    <Input
                      inputMode="decimal"
                      value={form.interestRate}
                      onChange={(e) => updateField("interestRate", e.target.value)}
                      placeholder={form.interestRatePeriod === "yearly" ? "12" : "1"}
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-2">
                    {(["yearly", "monthly"] as const).map((period) => (
                      <button
                        key={period}
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, interestRatePeriod: period }))}
                        aria-pressed={form.interestRatePeriod === period}
                        className={cx(
                          "tap rounded-control border py-2.5 text-[13px] font-semibold capitalize",
                          form.interestRatePeriod === period
                            ? "border-brand bg-brand-soft text-brand-strong"
                            : "border-line text-ink-3"
                        )}
                      >
                        {period === "yearly" ? "Per year" : "Per month"}
                      </button>
                    ))}
                  </div>

                  <Notice tone="neutral" icon={<Info className="size-4" />}>
                    {form.interestRatePeriod === "yearly" ? (
                      <>
                        <span className="font-semibold">Yearly</span> - 12% a year is 1% a month,
                        like a bank home loan.
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">Monthly</span> - 2% a month is 24% a year,
                        common for informal loans.
                      </>
                    )}
                  </Notice>
                </div>
              )}
            </Card>

            <div className="grid grid-cols-2 gap-3">
              <Field label="How long" hint="months">
                <Input
                  inputMode="numeric"
                  value={form.tenureMonths}
                  onChange={(e) => updateField("tenureMonths", e.target.value)}
                  placeholder="12"
                />
              </Field>
              <Field label="First EMI from">
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => updateField("startDate", e.target.value)}
                />
              </Field>
            </div>

            {/* "Return it in 3 months" is how the borrower actually says it. */}
            <div className="-mt-1 flex flex-wrap gap-2">
              {[
                { months: "1", label: "1 month" },
                { months: "3", label: "3 months" },
                { months: "6", label: "6 months" },
                { months: "12", label: "1 year" },
                { months: "24", label: "2 years" },
              ].map((quick) => (
                <Chip
                  key={quick.months}
                  active={form.tenureMonths === quick.months}
                  onClick={() => updateField("tenureMonths", quick.months)}
                >
                  {quick.label}
                </Chip>
              ))}
            </div>

            {preview && (
              <Card className="animate-pop border-brand/25 bg-brand-soft">
                <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-brand-strong">
                  <Sparkles className="size-3.5" />
                  What this works out to
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[17px] font-bold tabular-nums text-brand-strong">
                      {formatMoney(preview.emi)}
                    </p>
                    <p className="text-[11px] font-medium text-brand-strong/75">Each month</p>
                  </div>
                  <div>
                    <p className="text-[17px] font-bold tabular-nums text-brand-strong">
                      {formatMoney(preview.totalInterest)}
                    </p>
                    <p className="text-[11px] font-medium text-brand-strong/75">Interest</p>
                  </div>
                  <div>
                    <p className="text-[17px] font-bold tabular-nums text-brand-strong">
                      {formatMoney(preview.totalAmount)}
                    </p>
                    <p className="text-[11px] font-medium text-brand-strong/75">Repaid in all</p>
                  </div>
                </div>
                <p className="mt-2.5 text-[11px] leading-snug text-brand-strong/80">
                  {chargeInterest
                    ? `${form.interestRate}% ${form.interestRatePeriod} · ${
                        form.interestRatePeriod === "monthly"
                          ? `${(parseFloat(form.interestRate) * 12).toFixed(1)}% a year`
                          : `${(parseFloat(form.interestRate) / 12).toFixed(2)}% a month`
                      }`
                    : "Interest-free, so the total repaid equals the amount lent."}
                </p>
              </Card>
            )}

            {error && <Notice tone="bad">{error}</Notice>}

            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="lg"
                icon={<ArrowLeft className="size-4" />}
                onClick={() => {
                  setStep(1);
                  setError("");
                }}
              >
                Back
              </Button>
              <Button
                block
                size="lg"
                icon={<ArrowRight className="size-4" />}
                onClick={nextStep}
                className="flex-1"
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="animate-rise space-y-4">
            <div>
              <h2 className="text-[19px] font-bold tracking-tight text-ink">Payment details</h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {side === "lender"
                  ? "How should they pay you back? Optional - it can be added later."
                  : "Where does the money go when you pay them back? Optional."}
              </p>
            </div>

            <Field label={side === "lender" ? "Your UPI id" : "Their UPI id"} hint="optional">
              <Input
                type="text"
                value={form.upiId}
                onChange={(e) => updateField("upiId", e.target.value)}
                placeholder={side === "lender" ? "yourname@paytm" : "theirname@paytm"}
                autoComplete="off"
              />
            </Field>

            <Field label="Account number" hint="optional">
              <Input
                type="text"
                value={form.accountNumber}
                onChange={(e) => updateField("accountNumber", e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="off"
              />
            </Field>

            <Card>
              <p className="text-[13px] font-semibold text-ink">Who signs off a payment</p>
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                {(["1-side", "2-side"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, confirmationMode: mode }))}
                    aria-pressed={form.confirmationMode === mode}
                    className={cx(
                      "tap rounded-control border py-2.5 text-[13px] font-semibold",
                      form.confirmationMode === mode
                        ? "border-brand bg-brand-soft text-brand-strong"
                        : "border-line text-ink-3"
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-ink-3">
                {form.confirmationMode === "1-side"
                  ? "Either of you can record a payment and it counts straight away."
                  : "A payment waits for the other person to confirm it - the safer choice when the amounts are large."}
              </p>
              {side === "borrower" && (
                // Honest about what a 2-side choice means before the lender has
                // an account: there is nobody else to confirm, so the borrower
                // records their own payments until the lender joins.
                <p className="mt-1.5 text-[11px] leading-snug text-ink-3">
                  {form.lenderName || "Your lender"} isn&apos;t on Udhaar yet - until they join, you
                  record your own payments.
                </p>
              )}
            </Card>

            <Field label="Notes" hint="optional">
              <textarea
                value={form.notes}
                onChange={(e) => updateField("notes", e.target.value)}
                placeholder="Why the money was borrowed, anything agreed verbally..."
                rows={3}
                maxLength={500}
                className="w-full resize-none rounded-control border border-line bg-surface px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)]"
              />
            </Field>

            {/* The terms, repeated once more at the end: this is the last
                screen before the record exists, and the numbers are the point. */}
            {preview && (
              <Card className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-ink">
                    {partnerName} · {formatMoney(parseFloat(form.amount) || 0)}
                  </p>
                  <p className="text-[11px] text-ink-3">
                    {form.tenureMonths} months ·{" "}
                    {chargeInterest ? `${form.interestRate}% ${form.interestRatePeriod}` : "no interest"}{" "}
                    · {form.confirmationMode}
                  </p>
                </div>
                <Badge tone="brand">{formatMoney(preview.emi)}/mo</Badge>
              </Card>
            )}

            {error && <Notice tone="bad">{error}</Notice>}

            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="lg"
                icon={<ArrowLeft className="size-4" />}
                onClick={() => {
                  setStep(2);
                  setError("");
                }}
              >
                Back
              </Button>
              <Button
                block
                size="lg"
                loading={loading}
                onClick={handleSubmit}
                className="flex-1"
                icon={loading ? undefined : <Check className="size-4" />}
              >
                {loading ? "Creating" : "Create loan"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </MobileShell>
  );
}
