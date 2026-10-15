import { NextRequest, NextResponse } from "next/server";
import { db, rawRows } from "@/db";
import { loans, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { countUnreadNotifications } from "@/lib/unread-count";
import { computeInstallmentStatus, daysUntil, localToday } from "@/lib/calculations";
import { pickNextDuePerLoan, type DueCandidate, type DueItem } from "@/lib/due-items";
import { parsePaging } from "@/lib/paging";
import { activeLoansFirst } from "@/lib/loan-order";
import { or, eq, sql } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

/**
 * What the phone is allowed to be sent.
 *
 * The screen prints five rows of each list, so five rows of each list is what
 * it gets. It used to get everything: on a test account with 119 loans the
 * dashboard answered with 92 KB of JSON - 119 loan objects and 53 due rows -
 * and every installment of those loans was read out of Postgres and added up in
 * Node to print three numbers. `?limit=` asks for more of it (the see-all
 * screens and the verification script use it); the default is the screen.
 */
const DASHBOARD_PAGE = 5;

/** One row as Postgres returns it: numerics and counts arrive as strings. */
interface TotalsRow {
  you_will_receive: string;
  you_will_pay: string;
  total_interest_earned: string;
  due_this_week: string;
  overdue_amount: string;
  total_loans: string;
  active_loans: string;
  due_loan_count: string;
}

/** One unpaid installment, joined to the loan it belongs to. */
interface DueRow {
  loan_id: string;
  borrower_name: string;
  lender_name: string | null;
  viewer_is_lender: boolean;
  installment_id: string;
  installment_number: number;
  due_date: string;
  principal_amount: string;
  interest_amount: string;
  principal_paid: string;
  interest_paid: string;
  /** The lender's UPI id, so the borrower can pay from the due row directly. */
  lender_upi_id: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: string | null | undefined) => (v === null || v === undefined ? 0 : parseFloat(v));

/*
 * An installment is "unpaid" when the app's own status rule would not call it
 * paid, and something is still owed on it. Both halves matter and both mirror
 * `computeInstallmentStatus` / the `remaining` arithmetic below:
 *
 *   - the epsilon: a payment within half a paisa of the full amount is "paid",
 *     and must not come back as a 0.004-rupee due row;
 *   - the remaining > 0 test: nothing is due on an installment that is already
 *     covered.
 *
 * Written once, used by both statements below so the totals and the list can
 * never disagree about which installments count.
 */
const UNPAID_INSTALLMENT = sql`(
  (i.principal_amount > i.principal_paid or i.interest_amount > i.interest_paid)
  and not (i.principal_paid >= i.principal_amount - 0.01 and i.interest_paid >= i.interest_amount - 0.01)
)`;

/** What is still owed on an installment, with nothing due on an overpayment. */
const INSTALLMENT_REMAINING = sql`(
  greatest(0, i.principal_amount - i.principal_paid)
  + greatest(0, i.interest_amount - i.interest_paid)
)`;

async function handleGET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { limit } = parsePaging(new URL(req.url).searchParams, DASHBOARD_PAGE);
  const today = localToday();
  const me = session.id;

  /*
   * Four questions, asked at the same time.
   *
   * They were one query - every loan joined to every installment, the whole
   * grid read into Node, then three sums and a due list computed by looping
   * over it - plus a sequential count for the badge. The sums are what SQL is
   * for, and the rows nobody would display were paid for on every single
   * screen open, over a connection to a database in another region.
   *
   * `is not distinct from` and not `=`: a loan the borrower recorded against a
   * lender with no account has a null lender_id, and the viewer is the borrower
   * on it. `null = $1` is null, which would silently drop those loans from all
   * three totals.
   */
  const [totalsRows, dueRows, loanRows, unread] = await Promise.all([
    // 1. The numbers, added up where the rows live.
    //
    //    One aggregate over the join answers the three money totals, and the
    //    `unpaid` set (materialised once, scanned by each of the small
    //    subqueries that need it) answers "due this week" and "overdue". The
    //    only thing that comes back is one row of numbers.
    rawRows<TotalsRow>(sql`
      with unpaid as (
        select l.id as loan_id, i.due_date, ${INSTALLMENT_REMAINING} as remaining
        from loans l
        join installments i on i.loan_id = l.id
        where l.status = 'active'
          and (l.lender_id = ${me} or l.borrower_id = ${me})
          and ${UNPAID_INSTALLMENT}
      )
      select
        coalesce(sum(case when l.lender_id is not distinct from ${me}
          then ${INSTALLMENT_REMAINING} end), 0) as you_will_receive,
        coalesce(sum(case when l.lender_id is not distinct from ${me}
          then greatest(0, i.interest_amount - i.interest_paid) end), 0) as total_interest_earned,
        coalesce(sum(case when l.lender_id is not distinct from ${me} then 0
          else ${INSTALLMENT_REMAINING} end), 0) as you_will_pay,
        (select coalesce(sum(remaining), 0) from unpaid
          where due_date < ${today}::date) as overdue_amount,
        (select coalesce(sum(remaining), 0) from unpaid
          where due_date >= ${today}::date and due_date <= ${today}::date + 7) as due_this_week,
        (select count(*) from loans m
          where m.lender_id = ${me} or m.borrower_id = ${me}) as total_loans,
        (select count(*) from loans m
          where m.status = 'active'
            and (m.lender_id = ${me} or m.borrower_id = ${me})) as active_loans,
        (select count(distinct loan_id) from unpaid) as due_loan_count
      from loans l
      join installments i on i.loan_id = l.id
      where l.status = 'active'
        and (l.lender_id = ${me} or l.borrower_id = ${me})
    `),

    // 2. The due list: the next unpaid installment of each loan, and the
    //    arrears behind it - not every unpaid installment of every loan.
    //
    //    `pickNextDuePerLoan` picks one row per loan (oldest unpaid first) and
    //    summarises that loan's *other overdue* rows on it. So the only rows it
    //    can possibly need are the first unpaid row of each loan, plus every
    //    overdue row - everything else would be read and thrown away.
    rawRows<DueRow>(sql`
      with unpaid as (
        select
          l.id as loan_id,
          l.borrower_name,
          coalesce(nullif(l.lender_name, ''), u.name) as lender_name,
          (l.lender_id is not distinct from ${me}) as viewer_is_lender,
          i.id as installment_id,
          i.installment_number,
          i.due_date,
          i.principal_amount,
          i.interest_amount,
          i.principal_paid,
          i.interest_paid,
          -- The lender's UPI id travels with the due row so a borrower can pay
          -- from the home screen in one tap, without opening the loan first.
          l.upi_id as lender_upi_id,
          row_number() over (
            partition by l.id order by i.due_date, i.installment_number
          ) as rn
        from loans l
        join installments i on i.loan_id = l.id
        left join users u on u.id = l.lender_id
        where l.status = 'active'
          and (l.lender_id = ${me} or l.borrower_id = ${me})
          and ${UNPAID_INSTALLMENT}
      )
      select
        loan_id, borrower_name, lender_name, viewer_is_lender,
        installment_id, installment_number,
        to_char(due_date, 'YYYY-MM-DD') as due_date,
        principal_amount, interest_amount, principal_paid, interest_paid, lender_upi_id
      from unpaid
      where rn = 1 or due_date < ${today}::date
      order by due_date, installment_number
    `),

    // 3. The loans the screen will print: the ones still running first, newest
    //    first - five of them, with the count of the rest in the payload.
    db
      .select({ loan: loans, accountName: users.name })
      .from(loans)
      .leftJoin(users, eq(users.id, loans.lenderId))
      .where(or(eq(loans.lenderId, me), eq(loans.borrowerId, me)))
      .orderBy(...activeLoansFirst())
      .limit(limit),

    // 4. The badge, in passing - the tab bar asks for nothing of its own.
    countUnreadNotifications(me),
  ]);

  const totals = totalsRows[0];
  const dueItemCount = parseInt(totals?.due_loan_count ?? "0", 10);

  /*
   * The due rows are already the only ones the pick can use, but the rule
   * itself stays in `pickNextDuePerLoan` - pure, unit-tested, and the single
   * place that decides what "next payment per loan" means.
   */
  const candidates: DueCandidate[] = [];
  for (const row of dueRows) {
    const principalRemaining = Math.max(0, num(row.principal_amount) - num(row.principal_paid));
    const interestRemaining = Math.max(0, num(row.interest_amount) - num(row.interest_paid));
    const amount = principalRemaining + interestRemaining;
    const computedStatus = computeInstallmentStatus(
      row.due_date,
      num(row.principal_amount),
      num(row.interest_amount),
      num(row.principal_paid),
      num(row.interest_paid)
    );
    if (computedStatus === "paid" || amount <= 0) continue;

    candidates.push({
      loanId: row.loan_id,
      borrowerName: row.borrower_name,
      lenderName: row.lender_name,
      installmentId: row.installment_id,
      installmentNumber: row.installment_number,
      dueDate: row.due_date,
      amount,
      computedStatus,
      viewerRole: row.viewer_is_lender ? "lender" : "borrower",
      // The row as it will be shown, ready to be acted on: the UPI id to pay
      // into, and the principal/interest split so "Interest only" is one tap.
      lenderUpiId: row.lender_upi_id ?? null,
      principalRemaining,
      interestRemaining,
    });
  }

  const dueItems: DueItem[] = pickNextDuePerLoan(candidates).slice(0, limit);

  const taggedLoans = loanRows.map(({ loan, accountName }) => ({
    ...loan,
    lenderName: loan.lenderName || accountName,
    viewerRole: loan.lenderId === me ? ("lender" as const) : ("borrower" as const),
  }));

  const totalLoans = parseInt(totals?.total_loans ?? "0", 10);

  return NextResponse.json({
    unread,
    // The dashboard already knows who is asking (its session was the first
    // query), so the page no longer needs a second request to /api/auth/me
    // just to print a name in the greeting.
    user: { name: session.name, mobile: session.mobile },
    summary: {
      youWillReceive: round2(num(totals?.you_will_receive)),
      youWillPay: round2(num(totals?.you_will_pay)),
      dueThisWeek: round2(num(totals?.due_this_week)),
      overdueAmount: round2(num(totals?.overdue_amount)),
      totalInterestEarned: round2(num(totals?.total_interest_earned)),
      activeLoans: parseInt(totals?.active_loans ?? "0", 10),
      totalLoans,
    },
    dueItems,
    /** How many loans have a payment outstanding - `dueItems` is one page of them. */
    dueItemCount,
    loans: taggedLoans,
    /** True when `loans` is a page and there are more behind it. */
    hasMoreLoans: totalLoans > taggedLoans.length,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
