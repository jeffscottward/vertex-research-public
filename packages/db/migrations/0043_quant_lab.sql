CREATE TABLE "paper_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"doi" text NOT NULL,
	"ssrn_id" text NOT NULL,
	"version" text NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posted" text,
	"abstract" text,
	"url" text NOT NULL,
	"metadata_source" text NOT NULL,
	"pdf_status" text NOT NULL,
	"pdf_sha256" text,
	"pdf_bytes" integer,
	"pdf_source_url" text,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_captures_text_check" CHECK ("paper_captures"."doi" ~ '^10\.2139/ssrn\.[0-9]+$' and "paper_captures"."ssrn_id" ~ '^[0-9]+$' and char_length("paper_captures"."version") between 1 and 120 and char_length(trim("paper_captures"."topic")) between 1 and 200 and char_length(trim("paper_captures"."title")) between 1 and 300 and ("paper_captures"."abstract" is null or char_length("paper_captures"."abstract") <= 10000) and char_length("paper_captures"."url") <= 2000 and ("paper_captures"."pdf_source_url" is null or char_length("paper_captures"."pdf_source_url") <= 2000)),
	CONSTRAINT "paper_captures_pdf_check" CHECK (("paper_captures"."pdf_status" = 'retained' and "paper_captures"."pdf_sha256" ~ '^[0-9a-f]{64}$' and "paper_captures"."pdf_bytes" > 0) or ("paper_captures"."pdf_status" like 'metadata_only:%' and "paper_captures"."pdf_sha256" is null and "paper_captures"."pdf_bytes" is null)),
	CONSTRAINT "paper_captures_authors_check" CHECK (jsonb_typeof("paper_captures"."authors") = 'array' and jsonb_array_length("paper_captures"."authors") <= 100 and octet_length("paper_captures"."authors"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "strategy_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"spec_key" text NOT NULL,
	"spec_sha256" text NOT NULL,
	"paper_id" text,
	"capture_id" text,
	"strategy_id" text,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"paper_claims" jsonb NOT NULL,
	"our_reading" jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_specs_text_check" CHECK ("strategy_specs"."spec_sha256" ~ '^[0-9a-f]{64}$' and "strategy_specs"."spec_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("strategy_specs"."spec_key") <= 80 and char_length(trim("strategy_specs"."name")) between 1 and 200 and char_length(trim("strategy_specs"."hypothesis")) between 1 and 4000),
	CONSTRAINT "strategy_specs_json_check" CHECK (jsonb_typeof("strategy_specs"."paper_claims") = 'array' and jsonb_array_length("strategy_specs"."paper_claims") between 1 and 50 and jsonb_typeof("strategy_specs"."our_reading") = 'object' and jsonb_typeof("strategy_specs"."spec") = 'object' and octet_length("strategy_specs"."spec"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "paper_captures" ADD CONSTRAINT "paper_captures_paper_id_research_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."research_papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_specs" ADD CONSTRAINT "strategy_specs_paper_id_research_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."research_papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_specs" ADD CONSTRAINT "strategy_specs_capture_id_paper_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."paper_captures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_specs" ADD CONSTRAINT "strategy_specs_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_captures_doi_version_unique_idx" ON "paper_captures" USING btree ("doi","version");--> statement-breakpoint
CREATE INDEX "paper_captures_paper_idx" ON "paper_captures" USING btree ("paper_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_specs_sha_unique_idx" ON "strategy_specs" USING btree ("spec_sha256");--> statement-breakpoint
CREATE INDEX "strategy_specs_paper_idx" ON "strategy_specs" USING btree ("paper_id");--> statement-breakpoint
-- App-role privileges (see 0039_app_role_grants): only when the app role exists. The Quant Lab store
-- only inserts (idempotent, ON CONFLICT DO NOTHING) and reads these research records.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT ON TABLE "paper_captures" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "strategy_specs" TO "vertex_research";
  END IF;
END
$$;
