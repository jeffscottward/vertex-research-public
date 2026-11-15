CREATE TABLE "breadth90_days" (
	"date" date PRIMARY KEY NOT NULL,
	"uvol" double precision NOT NULL,
	"dvol" double precision NOT NULL,
	"adv" integer NOT NULL,
	"decl" integer NOT NULL,
	"up_pct" double precision NOT NULL,
	"adv_pct" double precision,
	"kind" text NOT NULL,
	"final" boolean NOT NULL,
	"source" text NOT NULL,
	"source_as_of" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breadth90_days_fields_check" CHECK ("breadth90_days"."kind" in ('UP_90', 'UP_80', 'NEUTRAL', 'DOWN_80', 'DOWN_90') and char_length("breadth90_days"."source") between 1 and 40 and char_length("breadth90_days"."source_as_of") between 1 and 64),
	CONSTRAINT "breadth90_days_values_check" CHECK ("breadth90_days"."uvol" >= 0 and "breadth90_days"."uvol" < 'Infinity'::double precision and "breadth90_days"."dvol" >= 0 and "breadth90_days"."dvol" < 'Infinity'::double precision and "breadth90_days"."adv" >= 0 and "breadth90_days"."decl" >= 0 and "breadth90_days"."up_pct" between 0 and 100 and ("breadth90_days"."adv_pct" is null or "breadth90_days"."adv_pct" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "breadth90_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"tier" text NOT NULL,
	"up_pct" double precision NOT NULL,
	"adv_pct" double precision,
	"armed_on" date,
	"strict" boolean NOT NULL,
	"trigger" text,
	"grade" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breadth90_events_fields_check" CHECK ("breadth90_events"."kind" in ('ARMED', 'FORMING', 'FIRED', 'THRUST') and "breadth90_events"."tier" in ('strict', 'standard', 'major', 'volume-only') and ("breadth90_events"."trigger" is null or "breadth90_events"."trigger" in ('UP_90', 'UP_80_X2')) and ("breadth90_events"."grade" is null or "breadth90_events"."grade" in ('major', 'volume-only')) and "breadth90_events"."up_pct" between 0 and 100 and ("breadth90_events"."adv_pct" is null or "breadth90_events"."adv_pct" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "breadth90_status" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"armed_on" date,
	"strict" boolean NOT NULL,
	"sessions_left" integer,
	"as_of" timestamp with time zone NOT NULL,
	"basket" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breadth90_status_fields_check" CHECK ("breadth90_status"."id" = 'nyse' and "breadth90_status"."state" in ('IDLE', 'ARMED', 'FORMING', 'FIRED') and ("breadth90_status"."sessions_left" is null or "breadth90_status"."sessions_left" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "breadth90_events_kind_date_tier_idx" ON "breadth90_events" USING btree ("kind","date","tier");--> statement-breakpoint
CREATE INDEX "breadth90_events_date_idx" ON "breadth90_events" USING btree ("date");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the breadth-90 repository uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "breadth90_days" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "breadth90_events" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "breadth90_status" TO "vertex_research";
  END IF;
END
$$;
