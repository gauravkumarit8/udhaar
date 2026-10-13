import {
  pgTable,
  uuid,
  varchar,
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
  lenderId: uuid("lender_id")
    .references(() => users.id)
    .notNull(),
  borrowerId: uuid("borrower_id").references(() => users.id),
  borrowerName: varchar("borrower_name", { length: 100 }).notNull(),
  borrowerMobile: varchar("borrower_mobile", { length: 15 }).notNull(),
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
});

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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
  paymentType: varchar("payment_type", { length: 20 }).notNull(), // interest | principal | both
  proofUrl: text("proof_url"),
  markedByUserId: uuid("marked_by_user_id")
    .references(() => users.id)
    .notNull(),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | confirmed | rejected
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
}, (table) => [uniqueIndex("reminders_dedupe_key_unique").on(table.dedupeKey)]);

// ─── Device Tokens (for push notifications via FCM) ─────────────
export const deviceTokens = pgTable("device_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  token: varchar("token", { length: 512 }).notNull().unique(),
  platform: varchar("platform", { length: 10 }).notNull(), // android | ios | web
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});