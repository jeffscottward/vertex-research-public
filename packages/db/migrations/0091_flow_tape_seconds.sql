CREATE TABLE "flow_tape_seconds" (
	"contract" text NOT NULL,
	"contracts" integer[] NOT NULL,
	"covered" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"symbol" text NOT NULL,
	"total_trades" integer NOT NULL,
	"trades" integer[] NOT NULL,
	CONSTRAINT "flow_tape_seconds_symbol_minute_pk" PRIMARY KEY("symbol","minute"),
	CONSTRAINT "flow_tape_seconds_check" CHECK ("flow_tape_seconds"."symbol" in ('ES', 'NQ') and cardinality("flow_tape_seconds"."trades") = 60 and cardinality("flow_tape_seconds"."contracts") = 60 and array_position("flow_tape_seconds"."trades", NULL) is null and array_position("flow_tape_seconds"."contracts", NULL) is null and 0 <= all("flow_tape_seconds"."trades") and 0 <= all("flow_tape_seconds"."contracts") and "flow_tape_seconds"."covered" ~ '^[01]{60}$' and "flow_tape_seconds"."total_trades" >= 0 and length("flow_tape_seconds"."contract") between 1 and 20)
);
--> statement-breakpoint
-- App-role privileges, as in 0078_flow_large_trades: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the flow repository uses
-- (flow.collect upserts the per-second counts: INSERT and UPDATE; flow.tapeSpeed reads them: SELECT;
-- DELETE is for the write probe of the deploy steps and for a later prune).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_tape_seconds" TO "vertex_research";
  END IF;
END
$$;
