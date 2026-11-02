CREATE TABLE "forward_drift_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"check_key" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"forward_value" double precision,
	"baseline_value" double precision,
	"ratio" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	CONSTRAINT "forward_drift_alerts_check_check" CHECK ("forward_drift_alerts"."check_key" in ('drawdown', 'losingStreak', 'profitFactor', 'sharpe', 'winRate')),
	CONSTRAINT "forward_drift_alerts_level_check" CHECK ("forward_drift_alerts"."level" in ('warn', 'alert')),
	CONSTRAINT "forward_drift_alerts_message_check" CHECK (char_length("forward_drift_alerts"."message") between 1 and 500),
	CONSTRAINT "forward_drift_alerts_ack_check" CHECK (("forward_drift_alerts"."acknowledged_at" is null) = ("forward_drift_alerts"."acknowledged_by" is null))
);
--> statement-breakpoint
CREATE TABLE "forward_drift_monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"baseline_run_id" text NOT NULL,
	"strategy_revision" text,
	"thresholds" jsonb NOT NULL,
	"points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"level" text DEFAULT 'insufficient' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forward_drift_monitors_label_check" CHECK (char_length("forward_drift_monitors"."label") between 1 and 120),
	CONSTRAINT "forward_drift_monitors_revision_check" CHECK ("forward_drift_monitors"."strategy_revision" is null or "forward_drift_monitors"."strategy_revision" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forward_drift_monitors_level_check" CHECK ("forward_drift_monitors"."level" in ('ok', 'warn', 'alert', 'insufficient')),
	CONSTRAINT "forward_drift_monitors_version_check" CHECK ("forward_drift_monitors"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "forward_drift_alerts" ADD CONSTRAINT "forward_drift_alerts_monitor_id_forward_drift_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."forward_drift_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_drift_monitors" ADD CONSTRAINT "forward_drift_monitors_baseline_run_id_backtest_runs_id_fk" FOREIGN KEY ("baseline_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forward_drift_alerts_created_idx" ON "forward_drift_alerts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forward_drift_alerts_monitor_idx" ON "forward_drift_alerts" USING btree ("monitor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forward_drift_monitors_created_idx" ON "forward_drift_monitors" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forward_drift_monitors_baseline_idx" ON "forward_drift_monitors" USING btree ("baseline_run_id");