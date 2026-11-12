CREATE TABLE "golive_draft_runs" (
	"trading_day" date PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"plan_version" integer NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"candidate_count" integer NOT NULL,
	CONSTRAINT "golive_draft_runs_fields_check" CHECK ("golive_draft_runs"."candidate_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "golive_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"plan_version" integer NOT NULL,
	"trading_day" date NOT NULL,
	"kind" text NOT NULL,
	"sleeve_key" text NOT NULL,
	"symbol" text NOT NULL,
	"structure" text NOT NULL,
	"expiry" text NOT NULL,
	"long_strike" double precision NOT NULL,
	"short_strike" double precision NOT NULL,
	"entry_basis" text,
	"exit_reason" text,
	"parent_draft_id" text,
	"signal_facts" jsonb NOT NULL,
	"quote" jsonb,
	"exit_rule" text NOT NULL,
	"state" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"node_badge_at_decision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "golive_drafts_fields_check" CHECK ("golive_drafts"."kind" in ('entry', 'exit') and "golive_drafts"."structure" in ('callDebitVertical', 'putDebitVertical', 'putCreditVertical', 'callCreditVertical') and "golive_drafts"."state" in ('proposed', 'approved', 'rejected', 'expired') and ("golive_drafts"."entry_basis" is null or "golive_drafts"."entry_basis" in ('signal_today', 'model_holds_account_does_not')) and ("golive_drafts"."exit_reason" is null or "golive_drafts"."exit_reason" in ('loser_3_trading_days_before_expiry', 'winner_expiry_day_1545_et', 'monthly_roll')) and ("golive_drafts"."node_badge_at_decision" is null or "golive_drafts"."node_badge_at_decision" in ('running-disarmed', 'running-armed', 'down', 'unknown')) and "golive_drafts"."exit_rule" = 'owner_standing_rule_v1' and "golive_drafts"."expiry" ~ '^[0-9]{8}$' and "golive_drafts"."long_strike" > 0 and "golive_drafts"."long_strike" < 'Infinity'::double precision and "golive_drafts"."short_strike" > 0 and "golive_drafts"."short_strike" < 'Infinity'::double precision and "golive_drafts"."long_strike" <> "golive_drafts"."short_strike" and char_length("golive_drafts"."sleeve_key") between 1 and 40 and char_length("golive_drafts"."symbol") between 1 and 10 and jsonb_typeof("golive_drafts"."signal_facts") = 'array'),
	CONSTRAINT "golive_drafts_kind_check" CHECK (("golive_drafts"."kind" <> 'entry' or ("golive_drafts"."entry_basis" is not null and "golive_drafts"."exit_reason" is null and "golive_drafts"."parent_draft_id" is null)) and ("golive_drafts"."kind" <> 'exit' or ("golive_drafts"."exit_reason" is not null and "golive_drafts"."entry_basis" is null and "golive_drafts"."parent_draft_id" is not null))),
	CONSTRAINT "golive_drafts_decision_check" CHECK (("golive_drafts"."state" in ('approved', 'rejected')) = ("golive_drafts"."decided_by" is not null) and ("golive_drafts"."state" in ('approved', 'rejected')) = ("golive_drafts"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "golive_plans" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"approval_basis" text,
	"owner_message_url" text,
	"evidence_url" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"limits" jsonb NOT NULL,
	"sleeves" jsonb NOT NULL,
	"exit_rule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "golive_plans_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "golive_plans_fields_check" CHECK (char_length("golive_plans"."id") between 1 and 128 and char_length("golive_plans"."name") between 1 and 120 and "golive_plans"."version" >= 1 and "golive_plans"."status" in ('proposed', 'approved', 'retired') and ("golive_plans"."approval_basis" is null or "golive_plans"."approval_basis" in ('owner_decision', 'owner_delegation')) and "golive_plans"."exit_rule" = 'owner_standing_rule_v1' and jsonb_typeof("golive_plans"."limits") = 'object' and jsonb_typeof("golive_plans"."sleeves") = 'array'),
	CONSTRAINT "golive_plans_approval_check" CHECK (("golive_plans"."status" <> 'proposed' or "golive_plans"."approval_basis" is null) and ("golive_plans"."status" <> 'approved' or ("golive_plans"."approval_basis" is not null and "golive_plans"."owner_message_url" is not null and "golive_plans"."approved_by" is not null and "golive_plans"."approved_at" is not null)) and ("golive_plans"."approval_basis" is distinct from 'owner_delegation' or "golive_plans"."evidence_url" is not null) and (("golive_plans"."status" = 'retired') = ("golive_plans"."retired_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "golive_draft_runs" ADD CONSTRAINT "golive_draft_runs_plan_fk" FOREIGN KEY ("plan_id","plan_version") REFERENCES "public"."golive_plans"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golive_drafts" ADD CONSTRAINT "golive_drafts_plan_fk" FOREIGN KEY ("plan_id","plan_version") REFERENCES "public"."golive_plans"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "golive_drafts_trading_day_idx" ON "golive_drafts" USING btree ("trading_day");--> statement-breakpoint
CREATE UNIQUE INDEX "golive_plans_version_idx" ON "golive_plans" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "golive_plans_in_force_idx" ON "golive_plans" USING btree ("exit_rule") WHERE "golive_plans"."status" in ('proposed', 'approved');--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the go-live drafts repository
-- uses. No DELETE: plans are retired and drafts expire; no row is removed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "golive_plans" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "golive_draft_runs" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "golive_drafts" TO "vertex_research";
  END IF;
END
$$;
