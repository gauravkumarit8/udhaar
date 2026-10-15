"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, HandCoins, ShieldCheck } from "lucide-react";
import { Button, Field, Input, Notice, cx } from "@/components/ui";
import { requestJson } from "@/lib/http";
import { clearClientCaches } from "@/lib/client-cache";

/**
 * Signing in: name and number, then six digits.
 *
 * The whole screen is two fields and one button. It keeps the properties that
 * matter from the screen it replaces: the OTP box verifies itself the moment
 * the sixth digit lands (nothing to tap), backspacing out of an empty box goes
 * to the one before it, and while the deployment is in dummy-OTP mode the code
 * is shown and can be filled in with one tap - because a mode where anyone can
 * log in as any number has no business looking like a secret.
 */
export default function LoginPage() {
  const [step, setStep] = useState<"mobile" | "otp">("mobile");
  const [mobile, setMobile] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [dummyOtp, setDummyOtp] = useState(false);

  const handleSendOTP = async () => {
    setError("");
    setDevCode(null);
    setDummyOtp(false);
    if (!/^\d{10}$/.test(mobile)) {
      setError("Enter a valid 10-digit mobile number");
      return;
    }
    setLoading(true);
    // requestJson never throws on a non-JSON body, so a 500 from the server
    // shows what actually went wrong instead of a generic message.
    const result = await requestJson<{ devCode?: string; dummyOtp?: boolean }>(
      "/api/auth/send-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile }),
      }
    );

    if (!result.ok) {
      setError(result.error ?? "Couldn't send the OTP. Try again.");
    } else {
      const data = result.data ?? {};
      if (data.devCode) setDevCode(data.devCode);
      setDummyOtp(Boolean(data.dummyOtp));
      setStep("otp");
    }
    setLoading(false);
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newOtp = otp.map((digit, i) => (i === index ? value.slice(-1) : digit));
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
    const result = await requestJson("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile, code, name: name || undefined }),
    });

    if (!result.ok) {
      setError(result.error ?? "Couldn't verify the code. Try again.");
      setLoading(false);
      return;
    }

    // A new session never inherits the previous one's cached screens.
    clearClientCaches();
    window.location.assign("/dashboard");
  };

  return (
    <div className="relative mx-auto flex min-h-screen w-full max-w-lg flex-col bg-bg">
      {/* A quiet brand band at the top rather than a full-height gradient: the
          card below it is where everything happens. */}
      <div className="safe-top relative overflow-hidden bg-brand px-6 pb-16 pt-10 text-brand-ink">
        <div
          aria-hidden
          className="absolute -right-16 -top-20 size-56 rounded-full bg-black/10 blur-2xl"
        />
        <div className="relative flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-black/15">
            <HandCoins className="size-6" />
          </span>
          <div>
            <h1 className="text-[26px] font-bold leading-none tracking-tight">Udhaar</h1>
            <p className="mt-1 text-[13px] opacity-80">Track loans. Get paid. No awkward calls.</p>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col px-5 pb-8">
        {step === "mobile" ? (
          <div className="animate-rise -mt-10 rounded-card border border-line bg-surface p-5 shadow-float">
            <h2 className="text-[17px] font-bold tracking-tight text-ink">Welcome</h2>
            <p className="mt-0.5 text-[13px] text-ink-2">
              Your number is your account - no password to remember.
            </p>

            <div className="mt-5 space-y-4">
              <Field label="Your name">
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Rahul Sharma"
                  autoComplete="name"
                />
              </Field>

              <Field label="Mobile number">
                <div className="flex items-center gap-2.5 rounded-control border border-line bg-surface px-3.5 focus-within:border-brand focus-within:ring-4 focus-within:ring-[var(--ring)]">
                  <span className="text-[15px] font-semibold text-ink-3">+91</span>
                  <span className="h-6 w-px bg-line" />
                  <input
                    type="tel"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    placeholder="9876543210"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    maxLength={10}
                    className="w-full bg-transparent py-3 text-[15px] text-ink outline-none placeholder:text-ink-3"
                  />
                  {mobile.length === 10 && <Check className="size-4 shrink-0 text-good" />}
                </div>
              </Field>

              {error && <Notice tone="bad">{error}</Notice>}

              <Button
                block
                size="lg"
                loading={loading}
                disabled={mobile.length !== 10}
                onClick={handleSendOTP}
                icon={loading ? undefined : <ArrowRight className="size-4" />}
              >
                {loading ? "Sending OTP" : "Continue"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="animate-rise -mt-10 rounded-card border border-line bg-surface p-5 shadow-float">
            <button
              onClick={() => {
                setStep("mobile");
                setOtp(["", "", "", "", "", ""]);
                setError("");
                setDevCode(null);
              }}
              className="tap -ml-1 mb-3 flex items-center gap-1 rounded-control px-1 py-1 text-[13px] font-semibold text-ink-3 hover:bg-surface-2"
            >
              <ArrowLeft className="size-4" />
              Back
            </button>

            <h2 className="text-[17px] font-bold tracking-tight text-ink">Verify OTP</h2>
            <p className="mt-0.5 text-[13px] text-ink-2">
              {dummyOtp
                ? `Dummy mode - no SMS is sent. The code for +91 ${mobile} is below.`
                : `We sent a 6-digit code to +91 ${mobile}`}
            </p>

            <div className="mt-5 flex gap-1.5">
              {otp.map((digit, idx) => (
                <input
                  key={idx}
                  id={`otp-${idx}`}
                  type="tel"
                  inputMode="numeric"
                  value={digit}
                  onChange={(e) => handleOtpChange(idx, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                  aria-label={`Digit ${idx + 1}`}
                  maxLength={1}
                  autoFocus={idx === 0}
                  className={cx(
                    "size-12 rounded-control border bg-surface text-center text-[20px] font-bold tabular-nums text-ink",
                    "focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)]",
                    digit ? "border-brand" : "border-line"
                  )}
                />
              ))}
            </div>

            {devCode && (
              <Notice tone="warn" className="mt-4" icon={<ShieldCheck className="size-4" />}>
                <p className="text-[12px] font-semibold">
                  Dummy OTP mode · code {devCode}
                </p>
                <p className="mt-0.5">
                  SMS isn&apos;t configured yet, so anyone can log in as any number until real SMS
                  is switched on.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOtp(devCode.split(""));
                    void verifyOtp(devCode);
                  }}
                  className="tap mt-1.5 rounded-full bg-surface px-3 py-1 text-[11px] font-bold text-warn"
                >
                  Fill {devCode} and continue
                </button>
              </Notice>
            )}

            {error && (
              <Notice tone="bad" className="mt-4">
                {error}
              </Notice>
            )}

            <Button
              block
              size="lg"
              className="mt-4"
              loading={loading}
              disabled={otp.some((d) => !d)}
              onClick={() => verifyOtp(otp.join(""))}
            >
              {loading ? "Verifying" : "Verify and log in"}
            </Button>

            <Button block variant="ghost" className="mt-1.5" onClick={handleSendOTP}>
              Didn&apos;t get it? Resend
            </Button>
          </div>
        )}

        <p className="mt-auto pt-8 text-center text-[11px] text-ink-3">
          By continuing you agree to the Terms of Service, and to money being recorded accurately -
          what the app shows is what both sides see.
        </p>
      </div>
    </div>
  );
}
