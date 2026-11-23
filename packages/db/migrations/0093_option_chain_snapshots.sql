CREATE TABLE "option_chain_snapshot_quotes" (
	"ask" double precision,
	"bid" double precision,
	"iv" double precision,
	"last" double precision,
	"open_interest" integer,
	"right" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"source" text NOT NULL,
	"strike" double precision NOT NULL,
	"volume" integer,
	CONSTRAINT "option_chain_snapshot_quotes_pk" PRIMARY KEY("snapshot_id","strike","right"),
	CONSTRAINT "option_chain_snapshot_quotes_check" CHECK ("option_chain_snapshot_quotes"."strike" > 0 and "option_chain_snapshot_quotes"."strike" < 'Infinity'::float8 and "option_chain_snapshot_quotes"."right" in ('call', 'put') and ("option_chain_snapshot_quotes"."bid" is null or ("option_chain_snapshot_quotes"."bid" >= 0 and "option_chain_snapshot_quotes"."bid" < 'Infinity'::float8)) and ("option_chain_snapshot_quotes"."ask" is null or ("option_chain_snapshot_quotes"."ask" >= 0 and "option_chain_snapshot_quotes"."ask" < 'Infinity'::float8)) and ("option_chain_snapshot_quotes"."last" is null or ("option_chain_snapshot_quotes"."last" >= 0 and "option_chain_snapshot_quotes"."last" < 'Infinity'::float8)) and ("option_chain_snapshot_quotes"."volume" is null or "option_chain_snapshot_quotes"."volume" >= 0) and ("option_chain_snapshot_quotes"."open_interest" is null or "option_chain_snapshot_quotes"."open_interest" >= 0) and ("option_chain_snapshot_quotes"."iv" is null or ("option_chain_snapshot_quotes"."iv" >= 0 and "option_chain_snapshot_quotes"."iv" < 'Infinity'::float8)) and "option_chain_snapshot_quotes"."source" in ('ibkr', 'yahoo', 'quantdata', 'mixed'))
);
--> statement-breakpoint
CREATE TABLE "option_chain_snapshots" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expiry" date NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"quote_count" integer NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"spot" double precision,
	"trading_day" date NOT NULL,
	"underlying" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_chain_snapshots_check" CHECK (char_length(trim("option_chain_snapshots"."id")) between 1 and 128 and "option_chain_snapshots"."underlying" ~ '^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$' and char_length(trim("option_chain_snapshots"."source")) between 1 and 64 and "option_chain_snapshots"."quote_count" > 0 and ("option_chain_snapshots"."spot" is null or ("option_chain_snapshots"."spot" > 0 and "option_chain_snapshots"."spot" < 'Infinity'::float8)))
);
--> statement-breakpoint
ALTER TABLE "option_chain_snapshot_quotes" ADD CONSTRAINT "option_chain_snapshot_quotes_snapshot_id_option_chain_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."option_chain_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "option_chain_snapshots_at_underlying_expiry_idx" ON "option_chain_snapshots" USING btree ("snapshot_at","underlying","expiry");--> statement-breakpoint
CREATE INDEX "option_chain_snapshots_underlying_at_idx" ON "option_chain_snapshots" USING btree ("underlying","snapshot_at");--> statement-breakpoint
CREATE INDEX "option_chain_snapshots_underlying_day_idx" ON "option_chain_snapshots" USING btree ("underlying","trading_day","snapshot_at");--> statement-breakpoint
-- App-role privileges, as in 0066_breadth_90 and 0091_flow_tape_seconds: when an operator applies
-- migrations as another role, the app role "vertex_research" still gets the privileges the option
-- chain snapshots repository uses (optionsChain.ingestSnapshot upserts headers and replaces quote
-- rows: SELECT, INSERT, UPDATE, DELETE; optionsChain.snapshot reads them: SELECT).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "option_chain_snapshots" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "option_chain_snapshot_quotes" TO "vertex_research";
  END IF;
END
$$;
