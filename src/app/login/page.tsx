"use client";

import { useState } from "react";

export default function LoginPage() {
  const [step, setStep] = useState<"mobile" | "otp">("mobile");
  const [mobile, setMobile] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSendOTP = async () => {
    setError("");
    if (!/^\d{10}$/.test(mobile)) {
      setError("Enter a valid 10-digit mobile number");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setStep("otp");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);

    // Auto-focus next input
    if (value && index < 5) {
      const nextInput = document.getElementById(`otp-${index + 1}`);
      nextInput?.focus();
    }

    // Auto-verify when all digits entered
    if (newOtp.every((d) => d !== "") && newOtp.join("").length === 6) {
      verifyOtp(newOtp.join(""));
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      const prevInput = document.getElementById(`otp-${index - 1}`);
      prevInput?.focus();
    }
  };

  const verifyOtp = async (code: string) => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, code, name: name || undefined }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        window.location.href = "/dashboard";
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-700 via-emerald-800 to-teal-900 flex flex-col max-w-lg mx-auto relative overflow-hidden">
      {/* Decorative circles */}
      <div className="absolute top-[-100px] right-[-80px] w-64 h-64 bg-emerald-600/30 rounded-full blur-3xl" />
      <div className="absolute bottom-[-60px] left-[-60px] w-48 h-48 bg-teal-500/20 rounded-full blur-3xl" />

      {/* Content */}
      <div className="relative flex-1 flex flex-col justify-end pb-8 px-6">
        {step === "mobile" ? (
          <div className="animate-slide-down">
            {/* Hero */}
            <div className="text-center mb-10">
              <div className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center text-4xl mx-auto mb-4 shadow-2xl shadow-emerald-900/50 animate-bounce-in">
                💰
              </div>
              <h1 className="text-4xl font-extrabold text-white tracking-tight">Udhaar</h1>
              <p className="text-emerald-200 mt-2 text-base">
                Track loans. Get paid. No awkward calls.
              </p>
            </div>

            {/* Form Card */}
            <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-black/20">
              <h2 className="text-xl font-bold text-slate-800 mb-1">Welcome</h2>
              <p className="text-slate-500 text-sm mb-6">
                Enter your details to get started
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                    Your Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Rahul Sharma"
                    className="w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none text-slate-800 placeholder:text-slate-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                    Mobile Number
                  </label>
                  <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-1 focus-within:ring-2 focus-within:ring-emerald-500 focus-within:border-transparent">
                    <span className="text-slate-500 font-semibold text-sm">+91</span>
                    <div className="w-px h-6 bg-slate-200" />
                    <input
                      type="tel"
                      value={mobile}
                      onChange={(e) =>
                        setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))
                      }
                      placeholder="9876543210"
                      className="w-full py-2.5 bg-transparent outline-none text-slate-800 placeholder:text-slate-400"
                      maxLength={10}
                    />
                    {mobile.length === 10 && (
                      <span className="text-emerald-500 text-lg">✓</span>
                    )}
                  </div>
                </div>

                {error && (
                  <div className="bg-red-50 text-red-600 text-sm p-3.5 rounded-2xl animate-scale-in">
                    {error}
                  </div>
                )}

                <button
                  onClick={handleSendOTP}
                  disabled={loading || mobile.length !== 10}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-4 rounded-2xl text-base transition-all tap-highlight"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Sending OTP...
                    </span>
                  ) : (
                    "Continue →"
                  )}
                </button>
              </div>
            </div>

            <p className="text-emerald-300/60 text-xs text-center mt-6">
              By continuing, you agree to our Terms of Service
            </p>
          </div>
        ) : (
          <div className="animate-slide-up">
            {/* Back button */}
            <button
              onClick={() => {
                setStep("mobile");
                setOtp(["", "", "", "", "", ""]);
                setError("");
              }}
              className="text-emerald-300 mb-6 flex items-center gap-1 text-sm font-medium tap-highlight"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>

            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-emerald-600/50 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4">
                📱
              </div>
              <h2 className="text-2xl font-bold text-white">Verify OTP</h2>
              <p className="text-emerald-200 mt-1 text-sm">
                We sent a 6-digit code to +91 {mobile}
              </p>
            </div>

            <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-black/20">
              {/* OTP Input Boxes */}
              <div className="flex gap-2.5 justify-center mb-6">
                {otp.map((digit, idx) => (
                  <input
                    key={idx}
                    id={`otp-${idx}`}
                    type="tel"
                    inputMode="numeric"
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    className="w-12 h-14 text-center text-2xl font-bold bg-slate-50 border-2 border-slate-200 rounded-2xl outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 transition-all"
                    maxLength={1}
                    autoFocus={idx === 0}
                  />
                ))}
              </div>

              <p className="text-xs text-slate-400 text-center mb-4">
                Dev mode: Use <span className="font-mono font-bold text-slate-600">123456</span>
              </p>

              {error && (
                <div className="bg-red-50 text-red-600 text-sm p-3.5 rounded-2xl mb-4 animate-scale-in">
                  {error}
                </div>
              )}

              <button
                onClick={() => verifyOtp(otp.join(""))}
                disabled={loading || otp.some((d) => !d)}
                className="w-full bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-4 rounded-2xl text-base transition-all tap-highlight"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Verifying...
                  </span>
                ) : (
                  "Verify & Login"
                )}
              </button>

              <button
                onClick={handleSendOTP}
                className="w-full text-slate-500 hover:text-slate-700 text-sm py-3 mt-2 tap-highlight"
              >
                Didn&apos;t get it? <span className="text-emerald-600 font-semibold">Resend OTP</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
