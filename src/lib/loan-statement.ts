/**
 * The loan statement: what was promised, what has been paid, what is left.
 *
 * Kept pure and separate from the screen for the same reason the due-list rule
 * is (src/lib/due-items.ts): the arithmetic is the part that must be right, and
 * it is the part a browser cannot check. The screen renders whatever this
 * returns; the tests pin the edges (part payments, written-off interest, an
 * overpayment, rounding to paise).
 *
 * The one rule that matters and is easy to get wrong: **waived money is not
 * owed**. When a lender settles a loan early or writes it off, the interest (or
 * the balance) they gave up lands in `interestWaived` / `principalWaived` - it
 * must never be counted as outstanding, or a closed loan would still read as a
 * debt.
 */

export interface StatementInstallment {
  installmentNumber: number;
  dueDate: string;
  totalAmount: string | number;
  principalAmount: string | number;
  interestAmount: string | number;
  principalPaid: string | number;
  interestPaid: string | number;
  principalWaived?: string | number | null;
  interestWaived?: string | number | null;
  computedStatus?: string;
}

export interface StatementPayment {
  amount: string | number;
  paymentType: string;
  status: string;
  notes?: string | null;
  createdAt: string;
}

export interface StatementLoan {
  borrowerName: string;
  lenderName: string | null;
  amount: string | number;
  interestRate: string | number;
  interestRatePeriod: string;
  tenureMonths: number;
  startDate: string;
  status: string;
}

export interface StatementTotals {
  /** Everything the schedule asks for, principal + interest. */
  scheduled: number;
  /** Money actually received (paid fields only, never waivers). */
  paid: number;
  /** Money given up by the lender: settled early, or written off. */
  waived: number;
  /** Still owed, waivers netted out, floored at zero per installment. */
  outstanding: number;
  principal: number;
  interest: number;
}

const num = (value: string | number | null | undefined): number => {
  const parsed = typeof value === "number" ? value : parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function statementTotals(installments: StatementInstallment[]): StatementTotals {
  let scheduled = 0;
  let paid = 0;
  let waived = 0;
  let outstanding = 0;
  let principal = 0;
  let interest = 0;

  for (const inst of installments) {
    const principalAmount = num(inst.principalAmount);
    const interestAmount = num(inst.interestAmount);
    const principalPaid = num(inst.principalPaid);
    const interestPaid = num(inst.interestPaid);
    const principalWaived = num(inst.principalWaived);
    const interestWaived = num(inst.interestWaived);

    scheduled += num(inst.totalAmount) || principalAmount + interestAmount;
    principal += principalAmount;
    interest += interestAmount;
    paid += principalPaid + interestPaid;
    waived += principalWaived + interestWaived;

    // Per installment, and never negative: overpaying one EMI does not create
    // a credit against another, which is the rule the rest of the app uses.
    outstanding += Math.max(0, principalAmount - principalPaid - principalWaived);
    outstanding += Math.max(0, interestAmount - interestPaid - interestWaived);
  }

  return {
    scheduled: round2(scheduled),
    paid: round2(paid),
    waived: round2(waived),
    outstanding: round2(outstanding),
    principal: round2(principal),
    interest: round2(interest),
  };
}

/** Rupees, the way they are written in India. */
export function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * The statement as a message someone can send.
 *
 * Deliberately short enough for WhatsApp, and deliberately without the other
 * person's phone number or any internal id: this text is for the counterparty,
 * who may have no account here and should not be handed a database key.
 */
export function statementText(
  loan: StatementLoan,
  installments: StatementInstallment[],
  payments: StatementPayment[],
  viewerRole: "lender" | "borrower"
): string {
  const totals = statementTotals(installments);
  const counterparty =
    viewerRole === "lender" ? loan.borrowerName : loan.lenderName || "the lender";
  const youAre = viewerRole === "lender" ? "lent to" : "borrowed from";
  const settled = payments.filter((p) => p.status === "confirmed").length;

  const lines = [
    `📄 Loan statement`,
    `${viewerRole === "lender" ? "You" : "I"} ${youAre} ${counterparty}`,
    ``,
    `Amount: ${formatINR(num(loan.amount))}`,
    `Interest: ${num(loan.interestRate)}% ${loan.interestRatePeriod === "monthly" ? "per month" : "per year"}`,
    `Tenure: ${loan.tenureMonths} month${loan.tenureMonths === 1 ? "" : "s"} from ${loan.startDate}`,
    ``,
    `Scheduled: ${formatINR(totals.scheduled)}`,
    `Paid: ${formatINR(totals.paid)}${settled ? ` (${settled} payment${settled === 1 ? "" : "s"})` : ""}`,
  ];

  if (totals.waived > 0) lines.push(`Waived: ${formatINR(totals.waived)}`);
  lines.push(`Still owed: ${formatINR(totals.outstanding)}`);
  lines.push(``, loan.status === "active" ? `Status: running` : `Status: ${loan.status}`);

  return lines.join("\n");
}

/** One payment, as a receipt the payer or the payee can keep. */
export function paymentReceiptText(
  loan: StatementLoan,
  payment: StatementPayment,
  viewerRole: "lender" | "borrower"
): string {
  const counterparty =
    viewerRole === "lender" ? loan.borrowerName : loan.lenderName || "the lender";
  const received = viewerRole === "lender" ? "Received from" : "Paid to";
  const when = new Date(payment.createdAt);
  const date = Number.isNaN(when.getTime()) ? payment.createdAt : when.toISOString().slice(0, 10);

  return [
    `🧾 Payment receipt`,
    `${received} ${counterparty}: ${formatINR(num(payment.amount))}`,
    `Against: the loan of ${formatINR(num(loan.amount))}`,
    `Date: ${date}`,
    `Type: ${payment.paymentType}`,
    `Status: ${payment.status}`,
    payment.notes ? `Note: ${payment.notes}` : ``,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
