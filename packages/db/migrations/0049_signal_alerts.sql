CREATE TABLE "signal_alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bar_at" timestamp with time zone NOT NULL,
	"price" numeric NOT NULL,
	"delivery" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_alert_events_delivery_check" CHECK ("signal_alert_events"."delivery" in ('pending', 'sent', 'not-configured', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "signal_alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"condition" jsonb NOT NULL,
	"frequency" text NOT NULL,
	"status" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_bar_at" timestamp with time zone,
	"last_fired_bar_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"fire_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_alert_rules_fields_check" CHECK ("signal_alert_rules"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}(=F)?$' and "signal_alert_rules"."kind" in ('alert', 'watch') and "signal_alert_rules"."origin" in ('manual', 'strategy', 'quant') and "signal_alert_rules"."status" in ('proposed', 'active', 'done', 'dismissed') and "signal_alert_rules"."frequency" in ('once', 'per-bar', 'per-bar-close') and "signal_alert_rules"."timeframe" in ('5m', '15m', '1h', '1d') and char_length("signal_alert_rules"."name") between 1 and 120 and "signal_alert_rules"."fire_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "signal_alert_events" ADD CONSTRAINT "signal_alert_events_rule_id_signal_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."signal_alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_alert_events" ADD CONSTRAINT "signal_alert_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_alert_rules" ADD CONSTRAINT "signal_alert_rules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_alert_events_rule_bar_idx" ON "signal_alert_events" USING btree ("rule_id","bar_at");--> statement-breakpoint
CREATE INDEX "signal_alert_events_user_fired_idx" ON "signal_alert_events" USING btree ("user_id","fired_at");--> statement-breakpoint
CREATE INDEX "signal_alert_rules_user_created_idx" ON "signal_alert_rules" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "signal_alert_rules_status_updated_idx" ON "signal_alert_rules" USING btree ("status","updated_at");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the signal alert repository uses.
-- Events are never deleted by the app (only by the rule's ON DELETE CASCADE).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "signal_alert_rules" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "signal_alert_events" TO "vertex_research";
  END IF;
END
$$;
