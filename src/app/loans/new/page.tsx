"use client";

import { useState } from "react";
import BottomNav from "@/components/BottomNav";
import MobileShell from "@/components/MobileShell";

export default function NewLoanPage() {
  const [form, setForm] = useState({
    borrowerName: "",
    borrowerMobile: "",
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(1); // 1: borrower, 2: loan, 3: payment
  const [preview, setPreview] = useState<{
    emi: number;
    totalInterest: number;
    totalAmount: number;
  } | null>(null);

  const calculatePreview = () => {
    const principal = parseFloat(form.amount) || 0;
    const rate = chargeInterest ? parseFloat(form.interestRate) || 0 : 0;
    const tenure = parseInt(form.tenureMonths) || 1;

    if (principal <= 0) {
      setPreview(null);
      return;
    }

    let emi: number;
    let totalInterest: number;

    if (rate === 0) {
      emi = principal / tenure;
      totalInterest = 0;
    } else {
      const r = form.interestRatePeriod === "yearly" ? rate / 12 / 100 : rate / 100;
      emi = (principal * r * Math.pow(1 + r, tenure)) / (Math.pow(1 + r, tenure) - 1);
      totalInterest = emi * tenure - principal;
    }

    setPreview({
      emi: Math.round(emi * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      totalAmount: Math.round(emi * tenure * 100) / 100,
    });
  };

  const updateField = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (["amount", "interestRate", "tenureMonths", "interestRatePeriod"].includes(field)) {
      setTimeout(calculatePreview, 50);
    }
  };

  const nextStep = () => {
    if (step === 1 && (!form.borrowerName || !form.borrowerMobile || !/^\d{10}$/.test(form.borrowerMobile))) {
      setError("Enter borrower name and valid 10-digit mobile");
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
    try {
      const res = await fetch("/api/loans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          interestRate: chargeInterest ? form.interestRate : "0",
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        window.location.href = `/loans/${data.loan.id}`;
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { num: 1, label: "Borrower" },
    { num: 2, label: "Loan" },
    { num: 3, label: "Payment" },
  ];

  return (
    <MobileShell
      title="New Loan"
      showNav={false}
      rightAction={
        <a href="/dashboard" className="text-sm text-emerald-600 font-medium tap-highlight">
          Cancel
        </a>
      }
    >
      <div className="px-5 py-4">
        {/* Step Indicator */}
        <div className="flex items-center gap-2 mb-6">
          {steps.map((s, idx) => (
            <div key={s.num} className="flex items-center flex-1">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold shrink-0 transition-all ${
                  step >= s.num
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-200 text-slate-400"
                }`}
              >
                {step > s.num ? "✓" : s.num}
              </div>
              {idx < steps.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-2 rounded-full transition-all ${
                    step > s.num ? "bg-emerald-500" : "bg-slate-200"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Borrower Details */}
        {step === 1 && (
          <div className="space-y-4 animate-fade-in">
            <div className="text-center mb-4">
              <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3">
                👤
              </div>
              <h2 className="text-xl font-bold text-slate-800">Who are you lending to?</h2>
              <p className="text-slate-400 text-sm mt-1">We&apos;ll send them reminders automatically</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                Friend&apos;s Name *
              </label>
              <input
                type="text"
                value={form.borrowerName}
                onChange={(e) => updateField("borrowerName", e.target.value)}
                placeholder="Rahul Sharma"
                className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                Mobile Number *
              </label>
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-1 focus-within:ring-2 focus-within:ring-emerald-500 focus-within:border-transparent">
                <span className="text-slate-500 font-semibold text-sm">+91</span>
                <div className="w-px h-6 bg-slate-200" />
                <input
                  type="tel"
                  value={form.borrowerMobile}
                  onChange={(e) =>
                    updateField("borrowerMobile", e.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                  placeholder="9876543210"
                  className="w-full py-2.5 bg-transparent outline-none"
                  maxLength={10}
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 text-sm p-3.5 rounded-2xl animate-scale-in">
                {error}
              </div>
            )}

            <button
              onClick={nextStep}
              className="w-full bg-emerald-600 active:bg-emerald-800 text-white font-bold py-4 rounded-2xl text-base tap-highlight"
            >
              Continue →
            </button>
          </div>
        )}

        {/* Step 2: Loan Details */}
        {step === 2 && (
          <div className="space-y-4 animate-fade-in">
            <div className="text-center mb-4">
              <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3">
                💵
              </div>
              <h2 className="text-xl font-bold text-slate-800">Loan Details</h2>
              <p className="text-slate-400 text-sm mt-1">Set the amount, interest and tenure</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                Loan Amount (₹) *
              </label>
              <input
                type="number"
                value={form.amount}
                onChange={(e) => updateField("amount", e.target.value)}
                placeholder="50000"
                min="1"
                className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none text-2xl font-bold"
              />
            </div>

            {/* Interest Toggle */}
            <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center text-lg">
                    📊
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700 text-sm">Charge Interest</p>
                    <p className="text-xs text-slate-400">Enable to set annual rate</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setChargeInterest(!chargeInterest);
                    setTimeout(calculatePreview, 50);
                  }}
                  className={`relative w-14 h-8 rounded-full transition-colors ${
                    chargeInterest ? "bg-emerald-500" : "bg-slate-300"
                  }`}
                >
                  <div
                    className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                      chargeInterest ? "translate-x-7" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {chargeInterest && (
                <div className="mt-4 animate-scale-in space-y-3">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                      Interest Rate (%)
                    </label>
                    <input
                      type="number"
                      value={form.interestRate}
                      onChange={(e) => updateField("interestRate", e.target.value)}
                      placeholder={form.interestRatePeriod === "yearly" ? "12" : "1"}
                      step="0.5"
                      min="0"
                      className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
                    />
                  </div>

                  {/* Monthly / Yearly Toggle */}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setForm((p) => ({ ...p, interestRatePeriod: "yearly" }));
                        setTimeout(calculatePreview, 50);
                      }}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-all tap-highlight ${
                        form.interestRatePeriod === "yearly"
                          ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                          : "border-slate-200 text-slate-400"
                      }`}
                    >
                      📅 Yearly
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setForm((p) => ({ ...p, interestRatePeriod: "monthly" }));
                        setTimeout(calculatePreview, 50);
                      }}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-all tap-highlight ${
                        form.interestRatePeriod === "monthly"
                          ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                          : "border-slate-200 text-slate-400"
                      }`}
                    >
                      📆 Monthly
                    </button>
                  </div>

                  <p className="text-xs text-slate-400 bg-slate-50 rounded-xl p-2.5">
                    {form.interestRatePeriod === "yearly" ? (
                      <>💡 <span className="font-semibold">Yearly rate</span> — e.g. 12% yearly = 1% per month. This is the standard bank rate (like home loans).</>
                    ) : (
                      <>💡 <span className="font-semibold">Monthly rate</span> — e.g. 2% monthly = 24% yearly. Common for informal loans between friends.</>
                    )}
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Tenure (months)
                </label>
                <input
                  type="number"
                  value={form.tenureMonths}
                  onChange={(e) => updateField("tenureMonths", e.target.value)}
                  placeholder="12"
                  min="1"
                  className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Start Date
                </label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => updateField("startDate", e.target.value)}
                  className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
                />
              </div>
            </div>

            {/* EMI Preview */}
            {preview && (
              <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-200 animate-scale-in">
                <p className="text-xs font-bold text-emerald-700 uppercase tracking-wide mb-3">
                  💡 EMI Preview
                </p>
                <p className="text-[11px] text-emerald-600 mb-3">
                  {form.interestRate}% {form.interestRatePeriod} rate
                  {form.interestRatePeriod === "monthly" && (
                    <span className="text-slate-400"> (effective {(parseFloat(form.interestRate) * 12).toFixed(1)}% yearly)</span>
                  )}
                  {form.interestRatePeriod === "yearly" && (
                    <span className="text-slate-400"> ({(parseFloat(form.interestRate) / 12).toFixed(2)}% monthly)</span>
                  )}
                </p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-xl font-extrabold text-emerald-700">
                      ₹{Math.round(preview.emi).toLocaleString("en-IN")}
                    </p>
                    <p className="text-[10px] text-emerald-600 font-medium">Monthly EMI</p>
                  </div>
                  <div>
                    <p className="text-xl font-extrabold text-amber-600">
                      ₹{Math.round(preview.totalInterest).toLocaleString("en-IN")}
                    </p>
                    <p className="text-[10px] text-amber-500 font-medium">Total Interest</p>
                  </div>
                  <div>
                    <p className="text-xl font-extrabold text-slate-700">
                      ₹{Math.round(preview.totalAmount).toLocaleString("en-IN")}
                    </p>
                    <p className="text-[10px] text-slate-500 font-medium">Total Amount</p>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 text-red-600 text-sm p-3.5 rounded-2xl animate-scale-in">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setStep(1);
                  setError("");
                }}
                className="flex-1 py-4 rounded-2xl border border-slate-200 text-slate-600 font-semibold tap-highlight"
              >
                ← Back
              </button>
              <button
                onClick={nextStep}
                className="flex-[2] bg-emerald-600 active:bg-emerald-800 text-white font-bold py-4 rounded-2xl tap-highlight"
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Payment Info */}
        {step === 3 && (
          <div className="space-y-4 animate-fade-in">
            <div className="text-center mb-4">
              <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3">
                🏦
              </div>
              <h2 className="text-xl font-bold text-slate-800">Payment Info</h2>
              <p className="text-slate-400 text-sm mt-1">How should they pay you back?</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                UPI ID
              </label>
              <input
                type="text"
                value={form.upiId}
                onChange={(e) => updateField("upiId", e.target.value)}
                placeholder="yourname@paytm"
                className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                Account Number
              </label>
              <input
                type="text"
                value={form.accountNumber}
                onChange={(e) => updateField("accountNumber", e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
              />
            </div>

            {/* Confirmation Mode */}
            <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
              <p className="font-semibold text-slate-700 text-sm mb-3">Confirmation Mode</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, confirmationMode: "1-side" }))}
                  className={`flex-1 py-3 rounded-xl text-sm font-semibold border transition-all tap-highlight ${
                    form.confirmationMode === "1-side"
                      ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                      : "border-slate-200 text-slate-400"
                  }`}
                >
                  <div className="text-lg mb-1">👤</div>
                  1-Side
                </button>
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, confirmationMode: "2-side" }))}
                  className={`flex-1 py-3 rounded-xl text-sm font-semibold border transition-all tap-highlight ${
                    form.confirmationMode === "2-side"
                      ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                      : "border-slate-200 text-slate-400"
                  }`}
                >
                  <div className="text-lg mb-1">👥</div>
                  2-Side
                </button>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                {form.confirmationMode === "1-side"
                  ? "Either party can confirm payments"
                  : "Both lender and borrower must confirm"}
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                Notes
              </label>
              <textarea
                value={form.notes}
                onChange={(e) => updateField("notes", e.target.value)}
                placeholder="Any notes about this loan..."
                rows={2}
                className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none resize-none"
              />
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 text-sm p-3.5 rounded-2xl animate-scale-in">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setStep(2);
                  setError("");
                }}
                className="flex-1 py-4 rounded-2xl border border-slate-200 text-slate-600 font-semibold tap-highlight"
              >
                ← Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-[2] bg-emerald-600 active:bg-emerald-800 disabled:bg-slate-300 text-white font-bold py-4 rounded-2xl tap-highlight"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Creating...
                  </span>
                ) : (
                  "Create Loan ✓"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </MobileShell>
  );
}
