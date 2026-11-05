CREATE TABLE "sector_rotation_alerts" (
	"symbol" text NOT NULL,
	"quadrant" text NOT NULL,
	"entered_on" date NOT NULL,
	"line" text NOT NULL,
	"delivery" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sector_rotation_alerts_symbol_quadrant_entered_on_pk" PRIMARY KEY("symbol","quadrant","entered_on"),
	CONSTRAINT "sector_rotation_alerts_fields_check" CHECK ("sector_rotation_alerts"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}$' and "sector_rotation_alerts"."quadrant" in ('leading', 'weakening', 'lagging', 'improving') and char_length("sector_rotation_alerts"."line") between 1 and 300 and "sector_rotation_alerts"."delivery" in ('pending', 'sent', 'not-configured', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sector_rotation_points" (
	"timeframe" text NOT NULL,
	"symbol" text NOT NULL,
	"benchmark" text NOT NULL,
	"date" date NOT NULL,
	"ratio" double precision NOT NULL,
	"momentum" double precision NOT NULL,
	"quadrant" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sector_rotation_points_timeframe_symbol_date_pk" PRIMARY KEY("timeframe","symbol","date"),
	CONSTRAINT "sector_rotation_points_fields_check" CHECK ("sector_rotation_points"."timeframe" in ('daily', 'weekly') and "sector_rotation_points"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}$' and "sector_rotation_points"."benchmark" ~ '^[A-Z][A-Z0-9.\-]{0,9}$' and "sector_rotation_points"."quadrant" in ('leading', 'weakening', 'lagging', 'improving')),
	CONSTRAINT "sector_rotation_points_values_check" CHECK ("sector_rotation_points"."ratio" > 0 and "sector_rotation_points"."ratio" < 'Infinity'::double precision and "sector_rotation_points"."momentum" > 0 and "sector_rotation_points"."momentum" < 'Infinity'::double precision)
);
--> statement-breakpoint
CREATE INDEX "sector_rotation_points_timeframe_date_idx" ON "sector_rotation_points" USING btree ("timeframe","date");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the sector rotation repository uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "sector_rotation_points" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "sector_rotation_alerts" TO "vertex_research";
  END IF;
END
$$;
