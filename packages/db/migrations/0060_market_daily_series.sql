-- Daily research series of the QuantConnect idea ports (card vertex-qc-ports): ETFs, continuous
-- futures, volatility and rate indices and derived series (EY_TNX_RATIO), imported by
-- `bun run vertex:series:import`. Research input only; nothing here places orders.
CREATE TABLE "market_daily_points" (
	"series_id" text NOT NULL,
	"date" date NOT NULL,
	"open" double precision,
	"high" double precision,
	"low" double precision,
	"close" double precision NOT NULL,
	"adj_close" double precision,
	CONSTRAINT "market_daily_points_series_id_date_pk" PRIMARY KEY("series_id","date"),
	CONSTRAINT "market_daily_points_finite_check" CHECK ("market_daily_points"."close" > '-Infinity'::float8 and "market_daily_points"."close" < 'Infinity'::float8 and ("market_daily_points"."open" is null or ("market_daily_points"."open" > '-Infinity'::float8 and "market_daily_points"."open" < 'Infinity'::float8)) and ("market_daily_points"."high" is null or ("market_daily_points"."high" > '-Infinity'::float8 and "market_daily_points"."high" < 'Infinity'::float8)) and ("market_daily_points"."low" is null or ("market_daily_points"."low" > '-Infinity'::float8 and "market_daily_points"."low" < 'Infinity'::float8)) and ("market_daily_points"."adj_close" is null or ("market_daily_points"."adj_close" > '-Infinity'::float8 and "market_daily_points"."adj_close" < 'Infinity'::float8)))
);
--> statement-breakpoint
CREATE TABLE "market_daily_series" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"source_sha256" text NOT NULL,
	"point_count" integer NOT NULL,
	"first_date" date NOT NULL,
	"last_date" date NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_daily_series_text_check" CHECK ("market_daily_series"."id" ~ '^[A-Z0-9._^=-]{1,20}$' and "market_daily_series"."kind" in ('etf', 'future', 'index', 'derived') and char_length(trim("market_daily_series"."source")) between 1 and 300 and "market_daily_series"."source_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "market_daily_series_range_check" CHECK ("market_daily_series"."point_count" >= 1 and "market_daily_series"."first_date" <= "market_daily_series"."last_date" and ("market_daily_series"."point_count" > 1 or "market_daily_series"."first_date" = "market_daily_series"."last_date"))
);
--> statement-breakpoint
ALTER TABLE "market_daily_points" ADD CONSTRAINT "market_daily_points_series_id_market_daily_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."market_daily_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the market daily series repository
-- uses (reads for loadSeries and listSeries; delete and insert for replaceSeries, which
-- `bun run vertex:series:import` calls).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, DELETE ON TABLE "market_daily_series", "market_daily_points" TO "vertex_research";
  END IF;
END
$$;
