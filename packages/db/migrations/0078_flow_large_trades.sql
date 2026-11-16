CREATE TABLE "flow_large_trades" (
	"capture" text NOT NULL,
	"limit_size" double precision NOT NULL,
	"price" double precision NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"second" timestamp with time zone NOT NULL,
	"seq" integer NOT NULL,
	"side" text NOT NULL,
	"signing" text NOT NULL,
	"size" double precision NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_large_trades_symbol_second_seq_pk" PRIMARY KEY("symbol","second","seq"),
	CONSTRAINT "flow_large_trades_check" CHECK ("flow_large_trades"."symbol" in ('ES', 'NQ') and "flow_large_trades"."side" in ('buy', 'sell') and "flow_large_trades"."signing" in ('quote', 'tick') and "flow_large_trades"."capture" in ('sampled') and "flow_large_trades"."seq" >= 0 and "flow_large_trades"."price" > 0 and "flow_large_trades"."limit_size" > 0 and "flow_large_trades"."size" >= "flow_large_trades"."limit_size")
);
--> statement-breakpoint
-- App-role privileges, as in 0053_flow_option_gaps: when an operator applies migrations as another role,
-- the app role "vertex_research" still gets the privileges the flow repository uses (flow.collect
-- inserts deep trades, flow.control reads them, prune deletes rows older than 730 days).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_large_trades" TO "vertex_research";
  END IF;
END
$$;
