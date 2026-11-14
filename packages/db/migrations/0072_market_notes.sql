CREATE TABLE "market_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"as_of" date NOT NULL,
	"source_kind" text NOT NULL,
	"source_url" text,
	"source_author" text,
	"raw_text" text NOT NULL,
	"theme" text NOT NULL,
	"claims" jsonb NOT NULL,
	"affected" jsonb NOT NULL,
	"stance" text NOT NULL,
	"stance_confidence" text NOT NULL,
	"review_by" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_message_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_notes_fields_check" CHECK ("market_notes"."source_kind" in ('reel', 'article', 'owner-text') and "market_notes"."stance" in ('risk-on', 'risk-off', 'neutral') and "market_notes"."stance_confidence" in ('low', 'medium', 'high') and "market_notes"."status" in ('active', 'retired') and char_length("market_notes"."raw_text") between 1 and 200000),
	CONSTRAINT "market_notes_content_check" CHECK (case when jsonb_typeof("market_notes"."claims") = 'array' then jsonb_array_length("market_notes"."claims") between 1 and 12 else false end and jsonb_typeof("market_notes"."affected") = 'object' and char_length("market_notes"."theme") between 1 and 300 and "market_notes"."review_by" >= "market_notes"."as_of"),
	CONSTRAINT "market_notes_source_check" CHECK (("market_notes"."source_kind" = 'owner-text' and "market_notes"."source_url" is null) or ("market_notes"."source_kind" in ('reel', 'article') and "market_notes"."source_url" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_notes_source_key_idx" ON "market_notes" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "market_notes_received_at_idx" ON "market_notes" USING btree ("received_at");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the market-notes repository uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "market_notes" TO "vertex_research";
  END IF;
END
$$;
