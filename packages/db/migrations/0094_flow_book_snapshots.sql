CREATE TABLE "flow_book_snapshots" (
	"ask_prices" double precision[] NOT NULL,
	"ask_sizes" double precision[] NOT NULL,
	"best_ask" double precision,
	"best_bid" double precision,
	"bid_prices" double precision[] NOT NULL,
	"bid_sizes" double precision[] NOT NULL,
	"capture" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"contract" text NOT NULL,
	"min_tick" double precision NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_book_snapshots_symbol_captured_at_pk" PRIMARY KEY("symbol","captured_at"),
	CONSTRAINT "flow_book_snapshots_check" CHECK ("flow_book_snapshots"."symbol" in ('ES', 'NQ') and "flow_book_snapshots"."capture" in ('sampled', 'streamed') and "flow_book_snapshots"."min_tick" > 0 and "flow_book_snapshots"."min_tick" < 'Infinity'::double precision and length("flow_book_snapshots"."contract") between 1 and 20 and coalesce(array_ndims("flow_book_snapshots"."bid_prices"), 0) <= 1 and coalesce(array_ndims("flow_book_snapshots"."bid_sizes"), 0) <= 1 and coalesce(array_ndims("flow_book_snapshots"."ask_prices"), 0) <= 1 and coalesce(array_ndims("flow_book_snapshots"."ask_sizes"), 0) <= 1 and cardinality("flow_book_snapshots"."bid_prices") = cardinality("flow_book_snapshots"."bid_sizes") and cardinality("flow_book_snapshots"."bid_prices") <= 20 and cardinality("flow_book_snapshots"."ask_prices") = cardinality("flow_book_snapshots"."ask_sizes") and cardinality("flow_book_snapshots"."ask_prices") <= 20 and cardinality("flow_book_snapshots"."bid_prices") + cardinality("flow_book_snapshots"."ask_prices") > 0 and array_position("flow_book_snapshots"."bid_prices", NULL) is null and array_position("flow_book_snapshots"."bid_sizes", NULL) is null and array_position("flow_book_snapshots"."ask_prices", NULL) is null and array_position("flow_book_snapshots"."ask_sizes", NULL) is null and 0 < all("flow_book_snapshots"."bid_prices") and 'Infinity'::double precision > all("flow_book_snapshots"."bid_prices") and 0 < all("flow_book_snapshots"."bid_sizes") and 'Infinity'::double precision > all("flow_book_snapshots"."bid_sizes") and 0 < all("flow_book_snapshots"."ask_prices") and 'Infinity'::double precision > all("flow_book_snapshots"."ask_prices") and 0 < all("flow_book_snapshots"."ask_sizes") and 'Infinity'::double precision > all("flow_book_snapshots"."ask_sizes") and ("flow_book_snapshots"."best_bid" is null) = (cardinality("flow_book_snapshots"."bid_prices") = 0) and ("flow_book_snapshots"."best_bid" is null or ("flow_book_snapshots"."best_bid" > 0 and "flow_book_snapshots"."best_bid" < 'Infinity'::double precision)) and ("flow_book_snapshots"."best_ask" is null) = (cardinality("flow_book_snapshots"."ask_prices") = 0) and ("flow_book_snapshots"."best_ask" is null or ("flow_book_snapshots"."best_ask" > 0 and "flow_book_snapshots"."best_ask" < 'Infinity'::double precision)))
);
--> statement-breakpoint
-- App-role privileges, as in 0091_flow_tape_seconds: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the flow repository uses
-- (flow.collect upserts L2 snapshots and prunes old rows; flow.liquidityHeatmap reads them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_book_snapshots" TO "vertex_research";
  END IF;
END
$$;
