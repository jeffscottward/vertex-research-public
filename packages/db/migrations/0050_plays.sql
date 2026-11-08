CREATE TABLE "plays" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"structure" text NOT NULL,
	"legs" jsonb NOT NULL,
	"max_loss_usd" numeric NOT NULL,
	"defined_risk" boolean DEFAULT true NOT NULL,
	"thesis" text NOT NULL,
	"trigger" text NOT NULL,
	"exit_rule" text NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plays_max_loss_check" CHECK ("plays"."max_loss_usd" > 0),
	CONSTRAINT "plays_defined_risk_check" CHECK ("plays"."defined_risk" = true),
	CONSTRAINT "plays_status_check" CHECK ("plays"."status" in ('idea', 'armed', 'taken', 'dropped')),
	CONSTRAINT "plays_legs_check" CHECK (case when jsonb_typeof("plays"."legs") = 'array' then jsonb_array_length("plays"."legs") between 1 and 8 else false end),
	CONSTRAINT "plays_fields_check" CHECK ("plays"."ticker" ~ '^[A-Z][A-Z0-9.\-]{0,9}$' and char_length(trim("plays"."structure")) between 1 and 80 and char_length(trim("plays"."thesis")) between 1 and 2000 and char_length(trim("plays"."trigger")) between 1 and 500 and char_length(trim("plays"."exit_rule")) between 1 and 500 and ("plays"."notes" is null or char_length("plays"."notes") <= 2000) and ("plays"."source_url" is null or "plays"."source_url" ~ '^https://'))
);
--> statement-breakpoint
CREATE INDEX "plays_updated_at_idx" ON "plays" USING btree ("updated_at");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the plays repository uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "plays" TO "vertex_research";
  END IF;
END
$$;
