CREATE TABLE "research_screen_bars" (
	"bars" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provider_symbol" text NOT NULL,
	"report_id" text PRIMARY KEY NOT NULL,
	"session_date" date NOT NULL,
	CONSTRAINT "research_screen_bars_check" CHECK (jsonb_typeof("research_screen_bars"."bars") = 'array' and jsonb_array_length("research_screen_bars"."bars") <= 300)
);
--> statement-breakpoint
CREATE TABLE "research_screen_rows" (
	"attempt_at" timestamp with time zone,
	"attempt_run_id" uuid,
	"bars_source" text,
	"error_code" text,
	"error_message" text,
	"good_at" timestamp with time zone,
	"good_run_id" uuid,
	"history_at" timestamp with time zone,
	"observation" jsonb,
	"provider_symbol" text NOT NULL,
	"quote_at" timestamp with time zone,
	"quote_source" text,
	"report_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "research_screen_rows_source_check" CHECK (("research_screen_rows"."bars_source" is null or "research_screen_rows"."bars_source" in ('ibkr', 'yahoo')) and ("research_screen_rows"."quote_source" is null or "research_screen_rows"."quote_source" in ('ibkr', 'yahoo'))),
	CONSTRAINT "research_screen_rows_error_check" CHECK (("research_screen_rows"."error_code" is null or "research_screen_rows"."error_code" in ('identity-unverified', 'metadata-invalid', 'provider-http', 'provider-timeout', 'rate-limited', 'identity-mismatch', 'quote-missing', 'too-few-bars', 'invalid-ohlc')) and ("research_screen_rows"."error_message" is null or char_length("research_screen_rows"."error_message") <= 300))
);
--> statement-breakpoint
CREATE TABLE "research_screen_runs" (
	"bars_from_ibkr" integer DEFAULT 0 NOT NULL,
	"bars_from_yahoo" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"ibkr_failures_in_row" integer DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"message" text,
	"not_reached" integer DEFAULT 0 NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"slot_labels" jsonb NOT NULL,
	"status" text NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"yahoo_rate_limits_in_row" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "research_screen_runs_status_check" CHECK ("research_screen_runs"."status" in ('running', 'completed', 'partial', 'failed', 'interrupted')),
	CONSTRAINT "research_screen_runs_shape_check" CHECK (jsonb_typeof("research_screen_runs"."slot_labels") = 'array' and ("research_screen_runs"."message" is null or char_length("research_screen_runs"."message") <= 300))
);
--> statement-breakpoint
CREATE TABLE "research_screen_scheduler" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone NOT NULL,
	"last_tick_decision" text NOT NULL,
	CONSTRAINT "research_screen_scheduler_check" CHECK ("research_screen_scheduler"."id" = 1 and "research_screen_scheduler"."last_tick_decision" in ('not-due', 'claimed', 'resumed', 'busy'))
);
--> statement-breakpoint
CREATE TABLE "research_screen_swinglytics" (
	"generated_at" timestamp with time zone,
	"id" integer PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_attempt_status" text,
	"last_error" text,
	"retrieved_at" timestamp with time zone,
	"snapshot" jsonb,
	CONSTRAINT "research_screen_swinglytics_check" CHECK ("research_screen_swinglytics"."id" = 1 and ("research_screen_swinglytics"."last_attempt_status" is null or "research_screen_swinglytics"."last_attempt_status" in ('ok', 'error')))
);
--> statement-breakpoint
ALTER TABLE "research_screen_bars" ADD CONSTRAINT "research_screen_bars_report_id_research_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_screen_rows" ADD CONSTRAINT "research_screen_rows_attempt_run_id_research_screen_runs_id_fk" FOREIGN KEY ("attempt_run_id") REFERENCES "public"."research_screen_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_screen_rows" ADD CONSTRAINT "research_screen_rows_good_run_id_research_screen_runs_id_fk" FOREIGN KEY ("good_run_id") REFERENCES "public"."research_screen_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_screen_rows" ADD CONSTRAINT "research_screen_rows_report_id_research_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_screen_runs_slot_at_idx" ON "research_screen_runs" USING btree ("slot_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_screen_runs_running_idx" ON "research_screen_runs" USING btree ("status") WHERE "research_screen_runs"."status" = 'running';--> statement-breakpoint
-- App-role privileges (see 0039_app_role_grants): only when the app role exists.
-- The web app reads and writes the screen state. No DELETE: rows and bars leave only through the
-- cascade from research_reports.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_runs" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_rows" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_bars" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_scheduler" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_swinglytics" TO "vertex_research";
  END IF;
END
$$;
