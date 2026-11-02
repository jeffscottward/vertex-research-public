CREATE TABLE "market_bar_series" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"source" text NOT NULL,
	"source_sha256" text NOT NULL,
	"bar_count" integer NOT NULL,
	"first_t" bigint NOT NULL,
	"last_t" bigint NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_bar_series_text_check" CHECK ("market_bar_series"."symbol" ~ '^[A-Z0-9.^-]{1,20}$' and "market_bar_series"."timeframe" in ('1d', '1m') and char_length(trim("market_bar_series"."source")) between 1 and 300 and "market_bar_series"."source_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "market_bar_series_range_check" CHECK ("market_bar_series"."bar_count" >= 2 and "market_bar_series"."first_t" < "market_bar_series"."last_t")
);
--> statement-breakpoint
CREATE TABLE "market_bars" (
	"series_id" text NOT NULL,
	"t" bigint NOT NULL,
	"o" double precision NOT NULL,
	"h" double precision NOT NULL,
	"l" double precision NOT NULL,
	"c" double precision NOT NULL,
	"v" double precision,
	CONSTRAINT "market_bars_series_id_t_pk" PRIMARY KEY("series_id","t"),
	CONSTRAINT "market_bars_price_check" CHECK ("market_bars"."o" > 0 and "market_bars"."h" > 0 and "market_bars"."l" > 0 and "market_bars"."c" > 0 and "market_bars"."l" <= least("market_bars"."o", "market_bars"."c") and "market_bars"."h" >= greatest("market_bars"."o", "market_bars"."c") and ("market_bars"."v" is null or "market_bars"."v" >= 0))
);
--> statement-breakpoint
ALTER TABLE "market_bars" ADD CONSTRAINT "market_bars_series_id_market_bar_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."market_bar_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_bar_series_symbol_timeframe_idx" ON "market_bar_series" USING btree ("symbol","timeframe");