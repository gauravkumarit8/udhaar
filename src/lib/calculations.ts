/**
 * EMI & Installment Calculations for Udhaar
 * Uses standard reducing-balance EMI formula.
 * Supports both monthly and yearly interest rate inputs.
 */

export type InterestRatePeriod = "monthly" | "yearly";

export interface InstallmentPlan {
  installmentNumber: number;
  dueDate: string; // YYYY-MM-DD
  principalAmount: number;
  interestAmount: number;
  totalAmount: number;
  remainingPrincipal: number;
}

/**
 * Convert any rate period to the effective monthly rate (as a decimal).
 * - If yearly: r_monthly = r_yearly / 12
 * - If monthly: r_monthly = r_monthly (already monthly)
 */
function toMonthlyRate(
  ratePercent: number,
  period: InterestRatePeriod
): number {
  return period === "yearly"
    ? ratePercent / 12 / 100
    : ratePercent / 100;
}

/**
 * Calculate EMI using the reducing balance formula
 * EMI = P × r × (1+r)^n / ((1+r)^n – 1)
 * If rate = 0, EMI = P / n (simple equal split)
 *
 * @param principal  Loan principal
 * @param ratePercent  Interest rate as a percentage (e.g. 12 for 12%)
 * @param tenureMonths  Number of monthly installments
 * @param ratePeriod  Whether ratePercent is "monthly" or "yearly"
 */
export function calculateEMI(
  principal: number,
  ratePercent: number,
  tenureMonths: number,
  ratePeriod: InterestRatePeriod = "yearly"
): number {
  if (ratePercent === 0) {
    return principal / tenureMonths;
  }
  const r = toMonthlyRate(ratePercent, ratePeriod);
  const n = tenureMonths;
  const emi = (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return emi;
}

/**
 * Generate full installment schedule for a loan
 */
export function generateInstallmentSchedule(
  principal: number,
  ratePercent: number,
  tenureMonths: number,
  startDate: string, // YYYY-MM-DD
  ratePeriod: InterestRatePeriod = "yearly"
): InstallmentPlan[] {
  const schedule: InstallmentPlan[] = [];
  const monthlyRate = toMonthlyRate(ratePercent, ratePeriod);
  let remainingPrincipal = principal;

  for (let i = 1; i <= tenureMonths; i++) {
    const dueDate = addMonths(startDate, i);
    let interestAmount: number;
    let principalAmount: number;

    if (ratePercent === 0) {
      interestAmount = 0;
      principalAmount = principal / tenureMonths;
    } else {
      interestAmount = remainingPrincipal * monthlyRate;
      const emi = calculateEMI(principal, ratePercent, tenureMonths, ratePeriod);
      principalAmount = emi - interestAmount;
    }

    if (i === tenureMonths) {
      principalAmount = remainingPrincipal;
      interestAmount = ratePercent === 0 ? 0 : Math.max(0, principalAmount + interestAmount - principalAmount);
    }

    const roundedPrincipal = roundTo2(principalAmount);
    const roundedInterest = roundTo2(interestAmount);
    const totalAmount = roundTo2(roundedPrincipal + roundedInterest);

    if (i === tenureMonths) {
      schedule.push({
        installmentNumber: i,
        dueDate,
        principalAmount: roundedPrincipal,
        interestAmount: roundedInterest,
        totalAmount,
        remainingPrincipal: 0,
      });
    } else {
      remainingPrincipal = remainingPrincipal - principalAmount;
      schedule.push({
        installmentNumber: i,
        dueDate,
        principalAmount: roundedPrincipal,
        interestAmount: roundedInterest,
        totalAmount,
        remainingPrincipal: roundTo2(remainingPrincipal),
      });
    }
  }

  return schedule;
}


/**
 * Calculate total interest over the loan tenure
 */
export function calculateTotalInterest(
  principal: number,
  ratePercent: number,
  tenureMonths: number,
  ratePeriod: InterestRatePeriod = "yearly"
): number {
  const schedule = generateInstallmentSchedule(principal, ratePercent, tenureMonths, "2024-01-01", ratePeriod);
  const totalInterest = schedule.reduce((sum, inst) => sum + inst.interestAmount, 0);
  return Math.round(totalInterest * 100) / 100;
}

/**
 * Compute installment status based on payments and due date
 */
export function computeInstallmentStatus(
  dueDate: string,
  principalAmount: number,
  interestAmount: number,
  principalPaid: number,
  interestPaid: number
): "paid" | "overdue" | "due_soon" | "partially_paid" | "pending" {
  const isFullyPaid = principalPaid >= principalAmount && interestPaid >= interestAmount;
  if (isFullyPaid) return "paid";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + "T00:00:00");
  const diffDays = Math.floor((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  const hasPartialPayment = principalPaid > 0 || interestPaid > 0;

  if (diffDays < 0) {
    return hasPartialPayment ? "partially_paid" : "overdue";
  }
  if (diffDays <= 3) {
    return hasPartialPayment ? "partially_paid" : "due_soon";
  }
  return hasPartialPayment ? "partially_paid" : "pending";
}

/**
 * Add N months to a date string (YYYY-MM-DD)
 */
function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Generate UPI deep link
 */
export function generateUPILink(
  upiId: string,
  amount: number,
  note: string,
  name: string
): string {
  const params = new URLSearchParams({
    pa: upiId,
    am: amount.toFixed(2),
    tn: note,
    pn: name,
  });
  return `upi://pay?${params.toString()}`;
}

/**
 * Format currency in INR
 */
export function formatINR(amount: number | string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num);
}

/**
 * Format date in Indian style
 */
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Days until a given date
 */
export function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.floor((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
