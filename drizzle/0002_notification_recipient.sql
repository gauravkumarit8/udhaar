ALTER TABLE "reminders" ADD COLUMN "recipient_id" uuid;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "type" varchar(24);--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;