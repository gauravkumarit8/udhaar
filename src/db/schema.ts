import {
  pgTable,
  uuid,
  varchar,
  index,
  uniqueIndex,
  numeric,
  integer,
  date,
  timestamp,
  boolean,
  text,
} from "drizzle-orm/pg-core";

// ─── Users ───────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  mobile: varchar("mobile", { length: 15 }).notNull().unique(),
  /** Opt-out switch honoured by sendPushToUser. */
  pushEnabled: boolean("push_enabled").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /**
   * When the user last opened the Activity screen. Everything addressed to
   * them after this is "unread", which is what the tab badge counts. Null
   * until they look once - so the badge is right from the very first login.
   */
  notificationsSeenAt: timestamp("notifications_seen_at", { withTimezone: true }),
});

// ─── Web Push subscriptions (browser/installed-PWA notifications) ─
// FCM only covers the native app, and only once google-services.json is in
// the Android build. A browser (or an installed PWA) subscribes through the
// Web Push protocol instead: one row per device, deleted as soon as the push
// service reports it is gone (410), which is how uninstalling cleans up.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  endpoint: text("endpoint").notNull().unique(),
  /** Public key + auth secret from `PushSubscription.toJSON()`. */
  p256dh: varchar("p256dh", { length: 255 }).notNull(),
  auth: varchar("auth", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Sessions ────────────────────────────────────────────────────
// The cookie holds a random opaque token - never a user id. The token is
// looked up here to resolve the user, so it can be revoked (logout) and it
// leaks nothing if a client tampers with it.
export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── OTPs (mock login flow) ─────────────────────────────────────
export const otps = pgTable("otps", {
  id: uuid("id").defaultRandom().primaryKey(),
  mobile: varchar("mobile", { length: 15 }).notNull(),
  code: varchar("code", { length: 6 }).notNull(),
  verified: boolean("verified").default(false).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Loans ───────────────────────────────────────────────────────
export const loans = pgTable("loans", {
  id: uuid("id").defaultRandom().primaryKey(),
  /**
   * The lender's account, when they have one.
   *
   * Nullable because a borrower can record a loan themselves - "I owe my
   * uncle ₹5,000" - naming a lender who has never used Udhaar. The name and
   * mobile are stored either way (`lenderName` / `lenderMobile`), and the
   * account is attached later by `backfillLenderLoans` the first time someone
   * signs up with that number.
   */
  lenderId: uuid("lender_id").references(() => users.id),
  borrowerId: uuid("borrower_id").references(() => users.id),
  borrowerName: varchar("borrower_name", { length: 100 }).notNull(),
  borrowerMobile: varchar("borrower_mobile", { length: 15 }).notNull(),
  /**
   * Who typed this in. Separate from the parties because a loan entered by the
   * borrower has no lender account yet, and *someone* has to be able to fix a
   * typo in their own record.
   */
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  /** The lender as named by whoever entered the loan (or copied from their account). */
  lenderName: varchar("lender_name", { length: 100 }),
  lenderMobile: varchar("lender_mobile", { length: 15 }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  interestRate: numeric("interest_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  interestRatePeriod: varchar("interest_rate_period", { length: 8 })
    .notNull()
    .default("yearly"), // monthly | yearly
  tenureMonths: integer("tenure_months").notNull(),
  startDate: date("start_date").notNull(),
  upiId: varchar("upi_id", { length: 100 }),
  accountNumber: varchar("account_number", { length: 50 }),
  notes: text("notes"),
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | closed
  confirmationMode: varchar("confirmation_mode", { length: 10 })
    .notNull()
    .default("1-side"), // 1-side | 2-side
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  /*
   * The dashboard, the loans list and the reminder sweep all filter on "loans
   * this person is on", and every loan screen filters by id. Postgres indexes
   * primary keys but nothing else, so these were sequential scans of the whole
   * table - invisible at ten loans, not at ten thousand.
   */
  index("loans_lender_id_idx").on(table.lenderId),
  index("loans_borrower_id_idx").on(table.borrowerId),
  // The one lookup that decides whether a debt finds its owner at signup.
  index("loans_lender_mobile_idx").on(table.lenderMobile),
]);

// ─── Installments ────────────────────────────────────────────────
export const installments = pgTable("installments", {
  id: uuid("id").defaultRandom().primaryKey(),
  loanId: uuid("loan_id")
    .references(() => loans.id, { onDelete: "cascade" })
    .notNull(),
  installmentNumber: integer("installment_number").notNull(),
  dueDate: date("due_date").notNull(),
  principalAmount: numeric("principal_amount", { precision: 12, scale: 2 }).notNull(),
  interestAmount: numeric("interest_amount", { precision: 12, scale: 2 }).notNull(),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  principalPaid: numeric("principal_paid", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  interestPaid: numeric("interest_paid", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  /**
   * Money the lender gave up on this EMI, kept separate from what was actually
   * received so "paid" never lies. Two things land here: the interest left on
   * a loan when it is settled early (the app's settlement rule), and the whole
   * outstanding balance when a lender closes a loan as a write-off.
   */
  principalWaived: numeric("principal_waived", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  interestWaived: numeric("interest_waived", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // Every installment query is "for this loan" - including the join the
  // dashboard now does in one round trip.
  index("installments_loan_id_idx").on(table.loanId),
]);

// ─── Payments (audit trail) ─────────────────────────────────────
export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  installmentId: uuid("installment_id")
    .references(() => installments.id, { onDelete: "cascade" })
    .notNull(),
  loanId: uuid("loan_id")
    .references(() => loans.id, { onDelete: "cascade" })
    .notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentType: varchar("payment_type", { length: 20 }).notNull(), // interest | principal | both | payoff
  proofUrl: text("proof_url"),
  /**
   * Cloudinary public id of the proof (with its extension), for uploads made
   * after proofs became private. Deliberately *not* a URL: the asset is
   * uploaded as `type: authenticated`, so it cannot be fetched without a
   * signature, and the app mints one per request in
   * GET /api/payments/[id]/proof after checking the caller is on the loan.
   * `proofUrl` is kept for proofs uploaded before that change.
   */
  proofPublicId: text("proof_public_id"),
  markedByUserId: uuid("marked_by_user_id")
    .references(() => users.id)
    .notNull(),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | confirmed | rejected | cancelled
  /**
   * Money received but not applied to anything (`paymentType: "payoff"` only):
   * the borrower rounded up, or sent more than the loan still owed. Recorded
   * rather than swallowed, so the audit trail matches the bank statement.
   */
  unappliedAmount: numeric("unapplied_amount", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // The payment history on a loan screen, and the "confirm or reject" lookup.
  index("payments_loan_id_idx").on(table.loanId),
  index("payments_status_idx").on(table.status),
]);

// ─── Reminders ──────────────────────────────────────────────────
export const reminders = pgTable("reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  installmentId: uuid("installment_id")
    .references(() => installments.id, { onDelete: "cascade" })
    .notNull(),
  loanId: uuid("loan_id")
    .references(() => loans.id, { onDelete: "cascade" })
    .notNull(),
  channel: varchar("channel", { length: 20 }).notNull(), // push | sms | whatsapp
  message: text("message").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar("status", { length: 20 }).notNull().default("sent"), // sent | delivered | failed
  /**
   * Idempotency key for the scheduled sweep: "<installment>:<kind>:<day>".
   * Unique, so a scheduler that fires twice (retry, manual run, overlapping
   * cron) cannot ring the borrower's phone twice for the same EMI on the
   * same day. NULL for reminders sent by hand.
   */
  dedupeKey: varchar("dedupe_key", { length: 120 }),
  /**
   * Who this notification is *for*. The copy is written in the second person
   * ("your loan", "for you"), so it is only ever shown to that person: the
   * Activity feed filters on it. NULL on rows written before this existed -
   * those are shown to both sides of the loan, which is what used to happen.
   */
  recipientId: uuid("recipient_id").references(() => users.id, { onDelete: "cascade" }),
  /** loan_added | payment_marked | payment_recorded | loan_closed | … | reminder. */
  type: varchar("type", { length: 24 }),
}, (table) => [
  uniqueIndex("reminders_dedupe_key_unique").on(table.dedupeKey),
  // The Activity feed and the badge filter by recipient and by loan.
  index("reminders_recipient_id_idx").on(table.recipientId),
  index("reminders_loan_id_idx").on(table.loanId),
]);

// ─── Device Tokens (for push notifications via FCM) ─────────────
export const deviceTokens = pgTable("device_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  token: varchar("token", { length: 512 }).notNull().unique(),
  platform: varchar("platform", { length: 10 }).notNull(), // android | ios | web
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("device_tokens_user_id_idx").on(table.userId)]);