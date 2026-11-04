CREATE TABLE "research_company_research" (
	"revision" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"body" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_company_research_check" CHECK ("research_company_research"."revision" ~ '^[0-9a-f]{64}$' and "research_company_research"."report_id" ~ '^[A-Z0-9]{1,10}$')
);
--> statement-breakpoint
CREATE TABLE "research_report_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"report_ids" jsonb NOT NULL,
	"source_ids" jsonb NOT NULL,
	CONSTRAINT "research_report_categories_check" CHECK (char_length("research_report_categories"."id") between 1 and 80 and "research_report_categories"."position" >= 0 and jsonb_typeof("research_report_categories"."report_ids") = 'array' and jsonb_typeof("research_report_categories"."source_ids") = 'array')
);
--> statement-breakpoint
CREATE TABLE "research_report_datasets" (
	"report_id" text NOT NULL,
	"data_revision" text NOT NULL,
	"dataset" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_length" integer NOT NULL,
	"body" text,
	CONSTRAINT "research_report_datasets_report_id_data_revision_dataset_pk" PRIMARY KEY("report_id","data_revision","dataset"),
	CONSTRAINT "research_report_datasets_check" CHECK ("research_report_datasets"."dataset" in ('market', 'portfolio', 'fundamentals', 'news', 'technicals', 'options-analysis', 'committee') and "research_report_datasets"."sha256" ~ '^[0-9a-f]{64}$' and "research_report_datasets"."byte_length" >= 0),
	CONSTRAINT "research_report_datasets_private_check" CHECK (("research_report_datasets"."dataset" = 'portfolio') = ("research_report_datasets"."body" is null))
);
--> statement-breakpoint
CREATE TABLE "research_report_revisions" (
	"report_id" text NOT NULL,
	"data_revision" text NOT NULL,
	"source" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_report_revisions_report_id_data_revision_pk" PRIMARY KEY("report_id","data_revision"),
	CONSTRAINT "research_report_revisions_check" CHECK ("research_report_revisions"."data_revision" ~ '^[0-9a-f]{64}$' and "research_report_revisions"."source" in ('revision', 'flat'))
);
--> statement-breakpoint
CREATE TABLE "research_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"position" integer NOT NULL,
	"symbol" text NOT NULL,
	"provider_symbol" text NOT NULL,
	"name" text NOT NULL,
	"asset_type" text,
	"status" text NOT NULL,
	"identity_status" text NOT NULL,
	"data_revision" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"company_research_revision" text,
	"company_research_report_revision" text,
	"company_research_accepted_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_reports_id_check" CHECK ("research_reports"."id" ~ '^[A-Z0-9]{1,10}$' and "research_reports"."position" >= 0),
	CONSTRAINT "research_reports_revision_check" CHECK ("research_reports"."data_revision" ~ '^[0-9a-f]{64}$' and ("research_reports"."company_research_revision" is null or "research_reports"."company_research_revision" ~ '^[0-9a-f]{64}$') and ("research_reports"."company_research_report_revision" is null or "research_reports"."company_research_report_revision" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "research_report_datasets" ADD CONSTRAINT "research_report_datasets_revision_fk" FOREIGN KEY ("report_id","data_revision") REFERENCES "public"."research_report_revisions"("report_id","data_revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_report_revisions" ADD CONSTRAINT "research_report_revisions_report_id_research_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_company_research_report_idx" ON "research_company_research" USING btree ("report_id");--> statement-breakpoint
-- App-role privileges (see 0039_app_role_grants): only when the app role exists.
-- The web app reads; the importer (run as the app role) replaces the catalog and categories.
-- Revisions, datasets and company research are immutable: read and insert only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "research_reports" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "research_report_categories" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "research_report_revisions" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "research_report_datasets" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "research_company_research" TO "vertex_research";
  END IF;
END
$$;
