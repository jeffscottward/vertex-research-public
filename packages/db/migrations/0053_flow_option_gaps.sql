CREATE TABLE "flow_option_gaps" (
	"created_at" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_option_gaps_symbol_start_time_pk" PRIMARY KEY("symbol","start_time"),
	CONSTRAINT "flow_option_gaps_check" CHECK ("flow_option_gaps"."symbol" in ('SPY', 'ES') and "flow_option_gaps"."end_time" >= "flow_option_gaps"."start_time")
);
--> statement-breakpoint
-- App-role privileges, as in 0052_flow_pipeline: when an operator applies migrations as another role,
-- the app role "vertex_research" still gets the privileges the flow repository uses (flow.collect
-- reads, inserts, moves and deletes option gaps; prune deletes gaps older than 14 days).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_option_gaps" TO "vertex_research";
  END IF;
END
$$;
