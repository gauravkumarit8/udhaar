CREATE TABLE "whatsapp_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile" varchar(15) NOT NULL,
	"reason" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_opt_outs_mobile_unique" UNIQUE("mobile")
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "provider_message_id" varchar(128);--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "provider_status" varchar(24);--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "provider_error" varchar(300);--> statement-breakpoint
CREATE INDEX "reminders_provider_message_id_idx" ON "reminders" USING btree ("provider_message_id");