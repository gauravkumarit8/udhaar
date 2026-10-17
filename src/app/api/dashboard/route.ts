import { NextRequest, NextResponse } from "next/server";
import { db, rawRows } from "@/db";
import { loans, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { countUnreadNotifications } from "@/lib/unread-count";
import { computeInstallmentStatus, daysUntil, localToday } from "@/lib/calculations";
import { pickNextDuePerLoan, type DueCandidate, type DueItem } from "@/lib/due-items";
import { ownClaimOn, type OwnClaimRef } from "@/lib/payments";
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

/** A pending payment somebody else marked, waiting on this viewer's answer. */
interface ClaimRow {
  payment_id: string;
  loan_id: string;
  installment_id: string;
  amount: string;
  payment_type: string;
  borrower_name: string;
  lender_name: string | null;
  viewer_is_lender: boolean;
  total_count: string;
  total_amount: string;
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
  /**
   * This viewer's own unanswered payments on the installment, as JSON.
   *
   * In 2-side mode a marked payment does not move the ledger until the other
   * side agrees, so an EMI this viewer has already claimed still reads as
   * unpaid - and every screen that offered "Pay" on it walked them into a
   * sheet, a submit, and "This EMI is already fully paid". `ownClaimOn` turns
   * this into what is honestly still payable.
   */
  my_pending: OwnClaimRef[] | null;
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
  const [totalsRows, dueRows, loanRows, claimRows, unread] = await Promise.all([
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
          -- What this viewer has already marked on this very installment and
          -- is still waiting on, so the row can stop offering to pay it again.
          (
            select coalesce(
              json_agg(
                json_build_object(
                  'id', p.id,
                  'installmentId', p.installment_id,
                  'markedByUserId', p.marked_by_user_id,
                  'status', p.status,
                  'amount', p.amount,
                  'paymentType', p.payment_type,
                  'createdAt', p.created_at
                )
                order by p.created_at
              ),
              '[]'::json
            )
            from payments p
            where p.installment_id = i.id
              and p.status = 'pending'
              and p.marked_by_user_id = ${me}
          ) as my_pending,
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
        principal_amount, interest_amount, principal_paid, interest_paid, lender_upi_id,
        my_pending
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

    // 4. Claims waiting on this viewer's answer.
    //
    //    A payment marked by the *other* side in 2-side mode is a claim: the
    //    money is spent, the EMI is still open, and somebody is waiting. On the
    //    loan screen it is the first card and in Activity it is answerable in the
    //    notification, but the home screen - where people actually land - said
    //    nothing about it at all, so a claim could sit unconfirmed while the app
    //    kept showing the same overdue number.
    //
    //    `count(*) over ()` gives the totals across every waiting claim while
    //    the rows themselves stay a short strip, so the count is honest even
    //    when only the first few are sent.
    rawRows<ClaimRow>(sql`
      select
        p.id as payment_id,
        p.loan_id,
        p.installment_id,
        p.amount,
        p.payment_type,
        l.borrower_name,
        coalesce(nullif(l.lender_name, ''), u.name) as lender_name,
        (l.lender_id is not distinct from ${me}) as viewer_is_lender,
        count(*) over () as total_count,
        sum(p.amount) over () as total_amount
      from payments p
      join loans l on l.id = p.loan_id
      left join users u on u.id = l.lender_id
      where p.status = 'pending'
        and p.marked_by_user_id is distinct from ${me}
        and (l.lender_id = ${me} or l.borrower_id = ${me})
      order by p.created_at
      limit 3
    `),

    // 5. The badge, in passing - the tab bar asks for nothing of its own.
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

    /*
     * What is left to pay after this viewer's own unanswered claims. Computed
     * by the same tested rule the loan screen uses, so the home screen and the
     * loan screen cannot disagree about who still owes a tap here.
     */
    const mine = ownClaimOn(row.my_pending ?? [], row.installment_id, me, {
      principalRemaining,
      interestRemaining,
    });

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
      // "You already marked this, and nobody has answered yet" - so the due
      // card shows the wait instead of a Pay button that cannot succeed.
      claimedByYou: mine.claimed,
      claimedPaymentId: mine.paymentId,
      payable: mine.payable,
      payablePrincipal: mine.payablePrincipal,
      payableInterest: mine.payableInterest,
    });
  }

  const dueItems: DueItem[] = pickNextDuePerLoan(candidates).slice(0, limit);

  const taggedLoans = loanRows.map(({ loan, accountName }) => ({
    ...loan,
    lenderName: loan.lenderName || accountName,
    viewerRole: loan.lenderId === me ? ("lender" as const) : ("borrower" as const),
  }));

  const totalLoans = parseInt(totals?.total_loans ?? "0", 10);

  /*
   * The claims, as the strip will print them: who marked it, for how much, and
   * the loan to answer it on. Additive and optional, like the due rows' UPI id -
   * an older client simply ignores the field.
   */
  const awaitingYou = {
    count: parseInt(claimRows[0]?.total_count ?? "0", 10),
    amount: round2(num(claimRows[0]?.total_amount)),
    items: claimRows.map((row) => ({
      paymentId: row.payment_id,
      loanId: row.loan_id,
      installmentId: row.installment_id,
      amount: round2(num(row.amount)),
      paymentType: row.payment_type,
      // Who is waiting on the answer, from this viewer's side of the loan.
      counterpartyName: row.viewer_is_lender
        ? row.borrower_name
        : row.lender_name || "The lender",
    })),
  };

  /*
   * Can this deployment send a push at all?
   *
   * The app used to call PushNotifications.register() on every dashboard load,
   * assuming it could. When the APK is built without google-services.json -
   * which is how builds work unless the ANDROID_GOOGLE_SERVICES_JSON secret is
   * set - FirebaseApp is never initialized, FirebaseMessaging.getInstance()
   * throws IllegalStateException, and Capacitor rethrows plugin failures on the
   * main thread. That is not a rejected promise the page can catch: the process
   * dies. It crashed the app on the first screen after login.
   *
   * With no service account key the server cannot deliver a push, so asking a
   * device for a token is pointless as well as fatal. Additive and optional,
   * like the other fields here - an older client ignores it.
   */
  const pushAvailable = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

  return NextResponse.json({
    unread,
    pushAvailable,
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
    /**
     * Payments the other side has marked and are waiting on this viewer to
     * confirm or reject. Additive and optional.
     */
    awaitingYou,
    /** How many loans have a payment outstanding - `dueItems` is one page of them. */
    dueItemCount,
    loans: taggedLoans,
    /** True when `loans` is a page and there are more behind it. */
    hasMoreLoans: totalLoans > taggedLoans.length,
  });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
