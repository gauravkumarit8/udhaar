ALTER TABLE "reminders" ADD COLUMN "dedupe_key" varchar(120);--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_dedupe_key_unique" ON "reminders" USING btree ("dedupe_key");