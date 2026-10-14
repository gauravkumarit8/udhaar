ALTER TABLE "loans" ALTER COLUMN "lender_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "lender_name" varchar(100);--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "lender_mobile" varchar(15);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

-- Backfill: before this migration every loan was created by its lender, and
-- that lender always had an account. Copy the name and number across so
-- nothing has to special-case "lenderName is null because the row is old",
-- and record who typed it in.
--> statement-breakpoint
UPDATE "loans" SET
  "lender_name" = COALESCE("lender_name", (SELECT "name" FROM "users" WHERE "users"."id" = "loans"."lender_id")),
  "lender_mobile" = COALESCE("lender_mobile", (SELECT "mobile" FROM "users" WHERE "users"."id" = "loans"."lender_id")),
  "created_by_user_id" = COALESCE("created_by_user_id", "lender_id");
