CREATE TABLE "backtest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"strategy_id" text,
	"strategy_revision" text,
	"strategy_snapshot" jsonb,
	"spec" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"requested_by" text NOT NULL,
	"error" text,
	"report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "backtest_runs_status_check" CHECK ("backtest_runs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "backtest_runs_revision_check" CHECK (("backtest_runs"."strategy_revision" is null or "backtest_runs"."strategy_revision" ~ '^[0-9a-f]{64}$') and ("backtest_runs"."strategy_revision" is null) = ("backtest_runs"."strategy_snapshot" is null)),
	CONSTRAINT "backtest_runs_outcome_check" CHECK (("backtest_runs"."status" <> 'succeeded' or "backtest_runs"."report" is not null) and ("backtest_runs"."status" <> 'failed' or "backtest_runs"."error" is not null))
);
--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_runs_created_idx" ON "backtest_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backtest_runs_strategy_idx" ON "backtest_runs" USING btree ("strategy_id","created_at" DESC NULLS LAST);