/**
 * The reminder the *lender* sends, through their own phone.
 *
 * The finding that shaped this: a borrower will not install an app to be
 * reminded about money they owe. So the reminder has to work for someone who
 * has never heard of Udhaar - which means WhatsApp or SMS, sent from the
 * lender's phone, with the amount, the due date and a UPI link written out
 * ready to send.
 *
 * Two consequences worth keeping:
 *
 *   - We do **not** claim to have delivered it. The lender sends it; all the
 *     app can honestly say is that it prepared the message. `delivered` is
 *     reserved for a push that a device actually accepted.
 *   - Everything here is pure and offline: building the message must not need
 *     a network call, a provider, or a paid plan. Deep links only.
 */

/** Indian mobiles are stored as 10 digits; wa.me and SMS both want +91. */
export function toE164India(mobile: string): string {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return digits;
  return digits; // something the caller already qualified - pass it through
}

function formatAmount(amount: number): string {
  return `₹${Number(amount).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface ReminderShareInput {
  lenderName: string;
  borrowerName: string;
  borrowerMobile: string;
  /** What is still owed on this EMI. */
  amount: number;
  /** Already formatted for reading, e.g. "14 Sep 2026". */
  dueDate: string;
  upiId?: string | null;
  /** Built with generateUPILink when the lender has a UPI id. */
  upiLink?: string | null;
}

export interface ReminderShare {
  /** What the borrower reads, in the app and in the message body. */
  text: string;
  /** One tap: opens WhatsApp with this text addressed to the borrower. */
  whatsappUrl: string;
  /** One tap: opens the phone's SMS composer. */
  smsUrl: string;
  upiLink: string | null;
}

/**
 * Builds the message once, so WhatsApp, SMS and the in-app copy are the same
 * words - a reminder that says something different depending on the channel is
 * how arguments start.
 */
export function buildReminderShare(input: ReminderShareInput): ReminderShare {
  const { lenderName, borrowerName, borrowerMobile, amount, dueDate, upiLink } = input;

  const firstName = (borrowerName || "").trim().split(/\s+/)[0] || "there";
  const lines = [
    `Hi ${firstName}, ${lenderName} here.`,
    `Gentle reminder: ${formatAmount(amount)} is due on ${dueDate}.`,
  ];
  if (upiLink) lines.push(`Pay by UPI: ${upiLink}`);

  const text = lines.join("\n");
  const encoded = encodeURIComponent(text);
  const e164 = toE164India(borrowerMobile);

  return {
    text,
    whatsappUrl: `https://wa.me/${e164}?text=${encoded}`,
    // `?body=` works on Android; iOS wants `&body=`. Both ignore the other.
    smsUrl: `sms:+${e164}?&body=${encoded}`,
    upiLink: upiLink ?? null,
  };
}
