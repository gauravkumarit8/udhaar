CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "installments_loan_id_idx" ON "installments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loans_lender_id_idx" ON "loans" USING btree ("lender_id");--> statement-breakpoint
CREATE INDEX "loans_borrower_id_idx" ON "loans" USING btree ("borrower_id");--> statement-breakpoint
CREATE INDEX "loans_lender_mobile_idx" ON "loans" USING btree ("lender_mobile");--> statement-breakpoint
CREATE INDEX "payments_loan_id_idx" ON "payments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reminders_recipient_id_idx" ON "reminders" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "reminders_loan_id_idx" ON "reminders" USING btree ("loan_id");