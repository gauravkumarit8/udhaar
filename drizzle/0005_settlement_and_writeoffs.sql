ALTER TABLE "installments" ADD COLUMN "principal_waived" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "installments" ADD COLUMN "interest_waived" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "unapplied_amount" numeric(12, 2) DEFAULT '0' NOT NULL;