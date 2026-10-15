/**
 * Server-side input validation.
 *
 * The API used to trust `parseFloat`/`parseInt` with a single `<= 0` guard.
 * That let three classes of bad input through:
 *
 *   - NaN: `parseFloat("abc") <= 0` is false, so "abc" passed validation and
 *     was written as `"NaN"` into a numeric column (or blew up at insert time).
 *   - Absurd magnitudes: nothing stopped a 1e15 principal, or a tenure of
 *     100000000 months, which the schedule generator would then happily try to
 *     materialise row-by-row.
 *   - Missing fields: interestRate was never range-checked at all, so a
 *     negative rate silently reduced the money owed.
 *
 * Every rule below returns a message written for the person who typed it.
 */

/** Upper bounds sized to the domain: informal loans in India. */
export const LIMITS = {
  AMOUNT_MAX: 1_000_000_000, // ₹100 crore - far beyond any informal loan
  INTEREST_RATE_MAX: 100, // percent per month or per year
  TENURE_MAX_MONTHS: 600, // 50 years
  NAME_MAX: 100,
  NOTES_MAX: 1000,
  UPI_MAX: 100,
  ACCOUNT_MAX: 50,
  PROOF_URL_MAX: 500,
  PUSH_ENDPOINT_MAX: 500, // push service URLs are long, but not this long
  PROOF_ID_MAX: 200, // "udhaar/proofs/" + a Cloudinary id
} as const;

export interface LoanInput {
  /**
   * Who is entering the loan. "lender" is the original flow (I lent money to
   * someone); "borrower" is the reverse - I owe money, and I am recording it
   * against a lender who may never have used this app.
   */
  side: "lender" | "borrower";
  /** Empty when side === "borrower" - the route fills these from the session. */
  borrowerName: string;
  borrowerMobile: string;
  /** Set only when side === "borrower". */
  lenderName: string | null;
  lenderMobile: string | null;
  amount: number;
  interestRate: number;
  interestRatePeriod: "monthly" | "yearly";
  tenureMonths: number;
  startDate: string;
  upiId: string | null;
  accountNumber: string | null;
  notes: string | null;
  confirmationMode: "1-side" | "2-side";
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Strict number parse: rejects "", "abc", "12abc", NaN, Infinity. */
export function toNumber(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (!trimmed) return null;
  // Number() (unlike parseFloat) rejects trailing garbage: "12abc" -> NaN
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True only for a real calendar date in YYYY-MM-DD form. */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  // Round-trip catches things like 2026-02-30.
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function optionalString(value: unknown, max: number, label: string): ValidationResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${label} must be text` };

  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: `${label} must be ${max} characters or fewer` };

  return { ok: true, value: trimmed };
}

/**
 * Validates a payment-proof id: the Cloudinary asset id returned by
 * `POST /api/upload`, e.g. `udhaar/proofs/xyz.jpg`.
 *
 * It is a path inside one folder, so it must look like one - no scheme, no
 * host, no query string, no traversal. Anything else is rejected rather than
 * stored and later handed to the signing code.
 */
export function validateProofId(value: unknown): ValidationResult<string | null> {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "proofId must be a string" };

  const trimmed = value.trim();

  if (trimmed.length > LIMITS.PROOF_ID_MAX) {
    return { ok: false, error: "That proof reference is too long to be real" };
  }
  if (!trimmed.startsWith("udhaar/proofs/")) {
    return { ok: false, error: "That proof reference is not one of ours" };
  }
  if (!/^[A-Za-z0-9/_.-]+$/.test(trimmed) || trimmed.includes("..")) {
    return { ok: false, error: "That proof reference contains characters we don't accept" };
  }

  return { ok: true, value: trimmed };
}

/**
 * Validates and normalises the body shared by "create loan" and "edit loan".
 * Anything the client can leave out gets a safe default.
 */
export function parseLoanInput(body: unknown): ValidationResult<LoanInput> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const raw = body as Record<string, unknown>;

  // Which way round is this loan? `side: "borrower"` means the person entering
  // it is the one who owes, so the *lender's* name and number are required.
  // Anything else keeps the original lender-entered behaviour.
  const side: "lender" | "borrower" = raw.side === "borrower" ? "borrower" : "lender";
  if (raw.side !== undefined && raw.side !== null && !["lender", "borrower"].includes(String(raw.side))) {
    return { ok: false, error: 'side must be either "lender" or "borrower"' };
  }

  // ── Required text ────────────────────────────────────────────────────────
  const counterpartyLabel = side === "borrower" ? "Lender" : "Borrower";
  const nameField = side === "borrower" ? raw.lenderName : raw.borrowerName;
  const mobileField = side === "borrower" ? raw.lenderMobile : raw.borrowerMobile;

  const partnerName = typeof nameField === "string" ? nameField.trim() : "";
  if (!partnerName) return { ok: false, error: `${counterpartyLabel} name is required` };
  if (partnerName.length > LIMITS.NAME_MAX) {
    return {
      ok: false,
      error: `${counterpartyLabel} name must be ${LIMITS.NAME_MAX} characters or fewer`,
    };
  }

  const partnerMobileRaw = typeof mobileField === "string" ? mobileField.trim() : "";
  // Must match the format enforced at login, or the other person's account
  // will never auto-link to this loan.
  if (!/^\d{10}$/.test(partnerMobileRaw)) {
    return {
      ok: false,
      error: `${counterpartyLabel} mobile must be exactly 10 digits (no spaces, +91, or dashes)`,
    };
  }

  // For a borrower-entered loan the borrower is the person asking, so the
  // route fills these two in from the session.
  const borrowerName = side === "borrower" ? "" : partnerName;
  const borrowerMobile = side === "borrower" ? "" : partnerMobileRaw;

  // ── Amount ───────────────────────────────────────────────────────────────
  const amount = toNumber(raw.amount);
  if (amount === null) {
    return { ok: false, error: "Amount must be a number, e.g. 50000" };
  }
  if (amount <= 0) return { ok: false, error: "Amount must be greater than 0" };
  if (amount > LIMITS.AMOUNT_MAX) {
    return { ok: false, error: `Amount looks too large (max ₹${LIMITS.AMOUNT_MAX.toLocaleString("en-IN")})` };
  }
  // numeric(12,2) in Postgres - reject rather than silently round.
  if (Math.round(amount * 100) !== amount * 100) {
    return { ok: false, error: "Amount can have at most 2 decimal places" };
  }

  // ── Interest rate ────────────────────────────────────────────────────────
  const hasRate = raw.interestRate !== undefined && raw.interestRate !== null && raw.interestRate !== "";
  const interestRate = hasRate ? toNumber(raw.interestRate) : 0;
  if (interestRate === null) {
    return { ok: false, error: "Interest rate must be a number, e.g. 12 (or leave it empty for an interest-free loan)" };
  }
  if (interestRate < 0) return { ok: false, error: "Interest rate cannot be negative" };
  if (interestRate > LIMITS.INTEREST_RATE_MAX) {
    return { ok: false, error: `Interest rate looks too high (max ${LIMITS.INTEREST_RATE_MAX}% per period)` };
  }

  const interestRatePeriod: "monthly" | "yearly" =
    raw.interestRatePeriod === "monthly" ? "monthly" : "yearly";
  if (
    raw.interestRatePeriod !== undefined &&
    raw.interestRatePeriod !== null &&
    raw.interestRatePeriod !== "" &&
    !["monthly", "yearly"].includes(String(raw.interestRatePeriod))
  ) {
    return { ok: false, error: "Interest rate period must be either monthly or yearly" };
  }

  // ── Tenure ───────────────────────────────────────────────────────────────
  const tenureMonths = toNumber(raw.tenureMonths);
  if (tenureMonths === null) return { ok: false, error: "Tenure must be a number of months" };
  if (!Number.isInteger(tenureMonths)) {
    return { ok: false, error: "Tenure must be a whole number of months" };
  }
  if (tenureMonths <= 0) return { ok: false, error: "Tenure must be at least 1 month" };
  if (tenureMonths > LIMITS.TENURE_MAX_MONTHS) {
    return { ok: false, error: `Tenure looks too long (max ${LIMITS.TENURE_MAX_MONTHS} months)` };
  }

  // ── Start date ───────────────────────────────────────────────────────────
  if (!isValidDateString(raw.startDate)) {
    return { ok: false, error: "Start date must be a real date in YYYY-MM-DD format" };
  }
  const startDate = raw.startDate;

  // ── Optional fields ──────────────────────────────────────────────────────
  const upiId = optionalString(raw.upiId, LIMITS.UPI_MAX, "UPI ID");
  if (!upiId.ok) return upiId;
  const accountNumber = optionalString(raw.accountNumber, LIMITS.ACCOUNT_MAX, "Account number");
  if (!accountNumber.ok) return accountNumber;
  const notes = optionalString(raw.notes, LIMITS.NOTES_MAX, "Notes");
  if (!notes.ok) return notes;

  const confirmationMode: "1-side" | "2-side" =
    raw.confirmationMode === "2-side" ? "2-side" : "1-side";
  if (
    raw.confirmationMode !== undefined &&
    raw.confirmationMode !== null &&
    !["1-side", "2-side"].includes(String(raw.confirmationMode))
  ) {
    return { ok: false, error: "confirmationMode must be either 1-side or 2-side" };
  }

  return {
    ok: true,
    value: {
      side,
      borrowerName,
      borrowerMobile,
      lenderName: side === "borrower" ? partnerName : null,
      lenderMobile: side === "borrower" ? partnerMobileRaw : null,
      amount,
      interestRate,
      interestRatePeriod,
      tenureMonths,
      startDate,
      upiId: upiId.value,
      accountNumber: accountNumber.value,
      notes: notes.value,
      confirmationMode,
    },
  };
}

/**
 * Payment proof links come from the client, and are shown to the other party
 * as a clickable link. Without this check a caller could store `javascript:`,
 * a `data:` blob, or a tracking URL under someone else's EMI.
 *
 * Accepted: an https URL on the app's own Cloudinary account - always, whether
 * or not Cloudinary is configured here. The "any https URL when unconfigured"
 * branch this replaces was a hole in two directions: the proof route redirects
 * the *other* party to whatever is stored, so it let a signed-in user park an
 * arbitrary link behind "view proof", and a missing environment variable
 * silently changed a security rule.
 */
export function validateProofUrl(value: unknown): ValidationResult<string | null> {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "proofUrl must be a URL string" };

  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > LIMITS.PROOF_URL_MAX) {
    return { ok: false, error: `Proof link must be ${LIMITS.PROOF_URL_MAX} characters or fewer` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Proof link must be a full URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "Proof link must start with https://" };
  }

  /*
   * The host has to be Cloudinary's delivery host for *this account*, or the
   * custom delivery host when one is configured. Checked unconditionally: an
   * unset variable must never widen what is allowed.
   */
  const deliveryHost = process.env.CLOUDINARY_DELIVERY_HOST?.trim().toLowerCase();
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();

  const allowedHost = deliveryHost
    ? url.hostname === deliveryHost
    : url.hostname === "res.cloudinary.com" && Boolean(cloudName) && url.pathname.startsWith(`/${cloudName}/`);

  if (!allowedHost) {
    return {
      ok: false,
      error: "Proof link must be an image uploaded through this app",
    };
  }

  // Data URLs never reach here (they aren't https), which also keeps large
  // blobs out of Postgres.
  return { ok: true, value: url.toString() };
}
