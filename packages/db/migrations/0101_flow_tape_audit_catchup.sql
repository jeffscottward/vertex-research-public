CREATE TABLE "flow_tape_audits" (
	"checked_at" timestamp with time zone NOT NULL,
	"compared_seconds" integer NOT NULL,
	"contract" text NOT NULL,
	"from_second" timestamp with time zone NOT NULL,
	"history_contracts" integer NOT NULL,
	"history_trades" integer NOT NULL,
	"matched_seconds" integer NOT NULL,
	"symbol" text NOT NULL,
	"tape_contracts" integer NOT NULL,
	"tape_trades" integer NOT NULL,
	"to_second" timestamp with time zone NOT NULL,
	CONSTRAINT "flow_tape_audits_symbol_from_second_pk" PRIMARY KEY("symbol","from_second"),
	CONSTRAINT "flow_tape_audits_check" CHECK ("flow_tape_audits"."symbol" in ('ES', 'NQ') and "flow_tape_audits"."to_second" >= "flow_tape_audits"."from_second" and "flow_tape_audits"."compared_seconds" > 0 and "flow_tape_audits"."matched_seconds" between 0 and "flow_tape_audits"."compared_seconds" and "flow_tape_audits"."history_trades" >= 0 and "flow_tape_audits"."tape_trades" >= 0 and "flow_tape_audits"."history_contracts" >= 0 and "flow_tape_audits"."tape_contracts" >= 0 and length("flow_tape_audits"."contract") between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "flow_tape_gaps" (
	"created_at" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_tape_gaps_symbol_start_time_pk" PRIMARY KEY("symbol","start_time"),
	CONSTRAINT "flow_tape_gaps_check" CHECK ("flow_tape_gaps"."symbol" in ('ES', 'NQ') and "flow_tape_gaps"."end_time" > "flow_tape_gaps"."start_time")
);
--> statement-breakpoint
-- App-role privileges, as in 0091_flow_tape_seconds: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the flow repository uses
-- (flow.collect adds, moves, reads and deletes tape gaps; it inserts tape checks, and flow.control
-- reads them; DELETE on flow_tape_audits is for the write probe of the deploy steps and a later
-- prune).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_tape_gaps" TO "vertex_research";
    GRANT SELECT, INSERT, DELETE ON TABLE "flow_tape_audits" TO "vertex_research";
  END IF;
END
$$;
