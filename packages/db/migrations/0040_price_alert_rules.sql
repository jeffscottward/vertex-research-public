CREATE TABLE "price_alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"level" numeric NOT NULL,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"triggered_at" timestamp with time zone,
	"trigger_price" numeric,
	"delivery" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_alert_rules_fields_check" CHECK ("price_alert_rules"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}$' and "price_alert_rules"."kind" in ('above', 'below') and "price_alert_rules"."role" in ('price', 'stop', 'target') and "price_alert_rules"."level" > 0 and ("price_alert_rules"."note" is null or char_length("price_alert_rules"."note") <= 200)),
	CONSTRAINT "price_alert_rules_state_check" CHECK (("price_alert_rules"."status" = 'active' and "price_alert_rules"."triggered_at" is null and "price_alert_rules"."trigger_price" is null and "price_alert_rules"."delivery" is null) or ("price_alert_rules"."status" = 'triggered' and "price_alert_rules"."triggered_at" is not null and "price_alert_rules"."trigger_price" > 0 and "price_alert_rules"."delivery" in ('pending', 'sent', 'not-configured', 'failed')))
);
--> statement-breakpoint
ALTER TABLE "price_alert_rules" ADD CONSTRAINT "price_alert_rules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_alert_rules_user_created_idx" ON "price_alert_rules" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "price_alert_rules_status_updated_idx" ON "price_alert_rules" USING btree ("status","updated_at");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the price alert repository uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "price_alert_rules" TO "vertex_research";
  END IF;
END
$$;
