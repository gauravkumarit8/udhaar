"use client";

/**
 * The two things people actually come here to do, as sheets that can be opened
 * from anywhere: record a payment, and chase one.
 *
 * Both lived inside the loan screen before this - 1,600 lines of them - so the
 * only way to record a payment was to open the loan, find the right EMI, and
 * tap. The home screen could describe a payment that was due but not let anyone
 * make it. These are the same requests to the same endpoints, moved somewhere
 * both screens can reach, so home can do the job in one tap and a reminder can
 * be sent without leaving the dashboard.
 *
 * Nothing here decides money. The server works out how a payment is applied
 * (`allocatePayment`) and what a reminder says (`buildReminderShare`); these
 * sheets collect the intent, show what came back, and get out of the way.
 */

import { useState } from "react";
import {
  BellRing,
  Check,
  IndianRupee,
  Loader2,
  MessageCircle,
  MessageSquare,
  Smartphone,
} from "lucide-react";
import {
  Button,
  Notice,
  Sheet,
  buttonClasses,
  cx,
  formatMoney,
} from "@/components/ui";
import ProofUpload from "@/components/ProofUpload";
import { useHaptics, useReminders } from "@/hooks/useNative";
import { requestJson } from "@/lib/http";
import { generateUPILink } from "@/lib/calculations";

/** Which payment is being recorded. Built by the screen that opens the sheet. */
export interface PayTarget {
  installmentId: string;
  installmentNumber: number;
  dueDate: string;
  principalRemaining: number;
  interestRemaining: number;
  /** The other side of this loan: the borrower when you lent, else the lender. */
  counterparty: string;
  viewerRole: "lender" | "borrower";
  /**
   * The lender's UPI id. Only ever used to help a *borrower* pay - a lender
   * looking at their own loan has nothing to pay into.
   */
  upiId?: string | null;
}

type PaymentType = "both" | "interest" | "principal";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Record a payment against one installment.
 *
 * The amount is filled in with everything that is still owed on that EMI, which
 * is what "mark it paid" means nine times out of ten - the old screen made you
 * tap a compact button, read a modal, and then confirm the number it had
 * already put there. The part-payment case is still one keystroke away: the
 * field is editable and the chips switch what the money is being applied to.
 */
export function PaySheet({
  target,
  onClose,
  onRecorded,
  initialType = "both",
}: {
  /**
   * Which installment to record against. Rendering this component at all *is*
   * opening the sheet - the screen mounts it with the row that was tapped and
   * unmounts it on close, so the form starts fresh each time without an effect
   * to reset it (and without a re-render up the tree wiping a half-typed
   * amount, which is what keying the reset on the `target` object would do).
   */
  target: PayTarget;
  onClose: () => void;
  /** Called after the server accepted it, with how much went where. */
  onRecorded?: (applied: { principal: number; interest: number }, amount: number) => void;
  /**
   * What the money is being applied to, before anyone taps. "both" is the
   * default because that is what "pay this EMI" means; the loan screen's
   * "Interest only" shortcut opens the same sheet saying so, rather than
   * opening it on the full amount and making the person correct it.
   */
  initialType?: PaymentType;
}) {
  const haptics = useHaptics();
  const reminders = useReminders();

  const fullAmount = target.principalRemaining + target.interestRemaining;
  const initialAmount =
    initialType === "interest"
      ? target.interestRemaining
      : initialType === "principal"
        ? target.principalRemaining
        : fullAmount;

  const [type, setType] = useState<PaymentType>(initialType);
  // Filled in with everything still owed on that EMI: what "mark it paid"
  // means nine times out of ten, and the old screen made you confirm a number
  // it had already put there.
  const [amount, setAmount] = useState(() => round2(initialAmount).toFixed(2));
  const [notes, setNotes] = useState("");
  const [proofId, setProofId] = useState<string | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseFloat(amount);
  const usable = Number.isFinite(parsed) && parsed > 0;

  const applyType = (next: PaymentType) => {
    setType(next);
    setError(null);
    if (next === "both") setAmount(fullAmount.toFixed(2));
    else if (next === "interest") setAmount(round2(target.interestRemaining).toFixed(2));
    else setAmount(round2(target.principalRemaining).toFixed(2));
  };

  const upiLink =
    target.viewerRole === "borrower" && target.upiId && usable
      ? generateUPILink(
          target.upiId,
          parsed,
          `Payment for ${target.counterparty}`,
          target.counterparty
        )
      : null;

  const record = async () => {
    if (!usable) {
      setError("Enter an amount greater than 0");
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const result = await requestJson<{ applied: { principal: number; interest: number } }>(
        `/api/installments/${target.installmentId}/pay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount,
            paymentType: type,
            notes: notes || undefined,
            proofId: proofId || undefined,
          }),
        }
      );

      if (!result.ok) {
        setError(result.error ?? "Couldn't record the payment. Try again.");
        haptics.notification("error");
        return;
      }

      const applied = result.data?.applied ?? { principal: 0, interest: 0 };
      haptics.notification("success");

      /*
       * If this installment is now fully paid, the phone has no reason to keep
       * its local reminder - the same bookkeeping the loan screen did when the
       * payment was recorded from there. Left undone, paying from home would
       * leave a scheduled notification behind saying the EMI is still due.
       */
      const principalLeft = round2(target.principalRemaining - applied.principal);
      const interestLeft = round2(target.interestRemaining - applied.interest);
      if (principalLeft <= 0 && interestLeft <= 0) reminders.cancel(target.installmentId);

      onRecorded?.(applied, parsed);
      onClose();
    } catch {
      setError("Network error - couldn't reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Record payment"
      subtitle={`EMI #${target.installmentNumber} · due ${new Date(
        `${target.dueDate}T00:00:00`
      ).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ${formatMoney(
        fullAmount
      )} outstanding`}
      footer={
        <Button
          block
          size="lg"
          loading={loading}
          disabled={!usable}
          onClick={record}
          data-autofocus
        >
          {usable ? `Record ${formatMoney(parsed)}` : "Record payment"}
        </Button>
      }
    >
      <div className="space-y-4 pt-1">
        {/* What the money is being applied to. "Full payment" is the default
            because it is what "I paid this EMI" means. */}
        <div className="flex gap-2">
          {(
            [
              ["both", "Full"],
              ["interest", "Interest"],
              ["principal", "Principal"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => applyType(value)}
              aria-pressed={type === value}
              className={cx(
                "tap h-9 flex-1 rounded-control border text-[13px] font-semibold",
                type === value
                  ? "border-transparent bg-ink text-surface"
                  : "border-line bg-surface text-ink-2 hover:bg-surface-2"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Amount</span>
          <div className="flex items-center gap-2 rounded-control border border-line bg-surface px-3.5 focus-within:border-brand focus-within:ring-4 focus-within:ring-[var(--ring)]">
            <IndianRupee className="size-4 shrink-0 text-ink-3" />
            <input
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(null);
              }}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              aria-label="Payment amount"
              className="h-12 w-full bg-transparent text-[17px] font-semibold tabular-nums text-ink placeholder:font-normal placeholder:text-ink-3 focus:outline-none"
            />
            {type !== "both" && (
              <span className="shrink-0 text-[11px] font-semibold text-ink-3">
                {type === "interest" ? "interest only" : "principal only"}
              </span>
            )}
          </div>
        </label>

        <p className="text-[13px] text-ink-2">
          {target.viewerRole === "lender"
            ? `Received from ${target.counterparty}`
            : `Paying ${target.counterparty}`}
        </p>

        {upiLink && (
          <div className="rounded-control bg-brand-soft px-3.5 py-3">
            <a
              href={upiLink}
              className={buttonClasses("secondary", "md", "w-full bg-surface")}
              onClick={() => haptics.tap()}
            >
              <Smartphone className="size-4" />
              Pay {formatMoney(parsed)} in a UPI app
            </a>
            <p className="mt-2 text-[11px] leading-snug text-brand-strong">
              Opens your UPI app with {target.counterparty}
              {"'"}s id {target.upiId} and this amount filled in. After you have paid,
              come back and record it here so the loan stays up to date.
            </p>
          </div>
        )}

        {showExtras ? (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">
                Note <span className="font-medium text-ink-3">optional</span>
              </span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="e.g. paid in cash at the shop"
                className="w-full resize-none rounded-control border border-line bg-surface px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)]"
              />
            </label>
            <ProofUpload onCapture={(id) => setProofId(id || null)} onClear={() => setProofId(null)} />
          </div>
        ) : (
          <button
            onClick={() => setShowExtras(true)}
            className="tap text-[13px] font-semibold text-brand-strong"
          >
            + Add a note or payment proof
          </button>
        )}

        {error && <Notice tone="bad">{error}</Notice>}
      </div>
    </Sheet>
  );
}

/** Which installment a reminder is about, and who receives it. */
export interface RemindTarget {
  installmentId: string;
  installmentNumber: number;
  dueDate: string;
  /** Still owed on this installment - the number the reminder quotes. */
  remaining: number;
  borrowerName: string;
  /** True when the borrower has an account, so a push can reach their phone. */
  canPush: boolean;
}

type Channel = "whatsapp" | "sms" | "push";

interface RemindResult {
  delivered?: boolean;
  reason?: string;
  upiLink?: string;
  share?: { text: string; whatsappUrl: string; smsUrl: string };
}

/**
 * Ask for the money back.
 *
 * Channels are the buttons, not a choice you make before you can send: tapping
 * one sends. WhatsApp is first because that is where these conversations
 * happen, and because the reminder arrives as a message the lender sends from
 * their own number rather than something that reaches the borrower only if they
 * happen to have the app.
 *
 * What each channel can honestly promise differs, and the sheet says which:
 * a push is the only one whose delivery the server learns about, so it is the
 * only one the sheet describes as delivered.
 */
export function RemindSheet({
  target,
  onClose,
  onSent,
}: {
  /** Which installment to chase. Rendering this mounts the sheet - see PaySheet. */
  target: RemindTarget;
  onClose: () => void;
  onSent?: () => void;
}) {
  const haptics = useHaptics();
  const reminders = useReminders();
  const [sending, setSending] = useState<Channel | null>(null);
  const [result, setResult] = useState<{ channel: Channel; data: RemindResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (channel: Channel) => {
    haptics.tap();
    setSending(channel);
    setError(null);

    try {
      const res = await requestJson<RemindResult>(
        `/api/installments/${target.installmentId}/remind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel }),
        }
      );

      if (!res.ok) {
        setError(res.error ?? "Couldn't send that reminder.");
        haptics.notification("error");
        return;
      }

      const data = res.data ?? {};

      if (channel === "push") {
        haptics.notification(data.delivered ? "success" : "warning");
        if (data.delivered) {
          // Same schedule the loan screen kept, so the borrower's own phone
          // notification and this app's reminder do not disagree.
          reminders.schedule(
            target.installmentId,
            target.dueDate,
            target.borrowerName,
            target.remaining
          );
        }
      } else {
        // The lender's own app opens with the message ready; they press send.
        const url = channel === "whatsapp" ? data.share?.whatsappUrl : data.share?.smsUrl;
        haptics.notification("success");
        if (url) window.open(url, "_blank");
      }

      setResult({ channel, data });
      onSent?.();
    } catch {
      setError("Network error - the reminder wasn't sent.");
    } finally {
      setSending(null);
    }
  };

  const appName = (channel: Channel) =>
    channel === "whatsapp" ? "WhatsApp" : channel === "sms" ? "your messages" : "their phone";

  const channels: Array<{ id: Channel; label: string; detail: string; icon: React.ReactNode }> = [
    {
      id: "whatsapp",
      label: "Send on WhatsApp",
      detail: "Opens WhatsApp with the message ready - you press send",
      icon: <MessageCircle className="size-5" />,
    },
    {
      id: "sms",
      label: "Send as a text message",
      detail: "Opens your messages app with the same wording",
      icon: <MessageSquare className="size-5" />,
    },
    {
      id: "push",
      label: "Notify in the app",
      detail: target.canPush
        ? "Free, instant, and lands on their phone - but only if they have Udhaar open"
        : "They have no Udhaar account, so this will only be recorded",
      icon: <BellRing className="size-5" />,
    },
  ];

  return (
    <Sheet
      open
      onClose={onClose}
      title="Send a reminder"
      subtitle={`${target.borrowerName} · EMI #${target.installmentNumber} · ${formatMoney(
        target.remaining
      )} due ${new Date(`${target.dueDate}T00:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      })}`}
    >
      {result ? (
        <div className="space-y-3 pt-1">
          <Notice
            tone={result.channel === "push" && !result.data.delivered ? "warn" : "good"}
            icon={<Check className="size-4" />}
          >
            {result.channel === "push"
              ? result.data.delivered
                ? "Reminder delivered to their phone."
                : result.data.reason || "Reminder recorded, but it couldn't be delivered."
              : `Reminder recorded. It opened in ${appName(result.channel)}${
                  result.channel === "whatsapp" && result.data.share?.smsUrl
                    ? " - press send there."
                    : "."
                }`}
          </Notice>

          {result.data.upiLink && (
            <div className="space-y-2">
              <p className="text-[13px] text-ink-2">
                The message carries your UPI id, so they can pay you straight from it.
              </p>
              <a href={result.data.upiLink} className={buttonClasses("secondary", "md", "w-full")}>
                <IndianRupee className="size-4" />
                Open my UPI app to collect
              </a>
            </div>
          )}

          <Button block variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-2.5 pt-1">
          {channels.map((channel) => {
            return (
              <button
                key={channel.id}
                disabled={sending !== null}
                onClick={() => send(channel.id)}
                className={cx(
                  "tap flex w-full items-center gap-3 rounded-card border border-line bg-surface p-3.5 text-left",
                  "hover:bg-surface-2 disabled:opacity-60",
                  channel.id === "whatsapp" && "border-brand/30 bg-brand-soft"
                )}
              >
                <span
                  className={cx(
                    "flex size-10 shrink-0 items-center justify-center rounded-control",
                    channel.id === "whatsapp" ? "bg-brand text-brand-ink" : "bg-surface-3 text-ink-2"
                  )}
                >
                  {sending === channel.id ? (
                    <Loader2 className="size-5 animate-spin-slow" />
                  ) : (
                    channel.icon
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink">{channel.label}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">
                    {channel.detail}
                  </span>
                </span>
              </button>
            );
          })}

          {error && <Notice tone="bad">{error}</Notice>}

          <p className="pt-1 text-[11px] leading-relaxed text-ink-3">
            Nothing here pretends a message was delivered unless the server said so.
            WhatsApp and text messages are sent by you, from your own number.
          </p>
        </div>
      )}
    </Sheet>
  );
}
