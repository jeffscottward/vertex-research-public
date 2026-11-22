CREATE TABLE "price_freshness_state" (
	"active_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_transition_at" timestamp with time zone,
	"monitor" text PRIMARY KEY NOT NULL,
	"pending_delivery" text,
	"pending_event_id" text,
	"pending_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"pending_kind" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_freshness_state_check" CHECK ("price_freshness_state"."monitor" ~ '^[a-z0-9-]{1,40}$' and array_position("price_freshness_state"."active_keys", NULL) is null and array_position("price_freshness_state"."pending_keys", NULL) is null and (("price_freshness_state"."pending_event_id" is null and "price_freshness_state"."pending_kind" is null and "price_freshness_state"."pending_delivery" is null and "price_freshness_state"."pending_keys" = '{}'::text[]) or ("price_freshness_state"."pending_event_id" is not null and "price_freshness_state"."pending_kind" is not null and "price_freshness_state"."pending_delivery" is not null and char_length(trim("price_freshness_state"."pending_event_id")) between 1 and 80 and char_length("price_freshness_state"."pending_event_id") <= 80 and "price_freshness_state"."pending_kind" in ('alert', 'recovery') and "price_freshness_state"."pending_delivery" in ('pending', 'not-configured', 'failed') and (("price_freshness_state"."pending_kind" = 'alert' and cardinality("price_freshness_state"."pending_keys") > 0) or ("price_freshness_state"."pending_kind" = 'recovery' and "price_freshness_state"."pending_keys" = '{}'::text[])))))
);
--> statement-breakpoint
-- App-role privileges, as in 0091_flow_tape_seconds: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the freshness repository uses
-- (openbb.priceFreshness reads state: SELECT; openbb.checkPriceFreshness and
-- openbb.recordPriceFreshnessChat upsert/update state: INSERT, UPDATE; DELETE is for cleanup).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "price_freshness_state" TO "vertex_research";
  END IF;
END
$$;
