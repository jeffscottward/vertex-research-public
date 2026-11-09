CREATE TABLE "academy_lesson_sources" (
	"source_id" text PRIMARY KEY NOT NULL,
	"course" text NOT NULL,
	"url" text NOT NULL,
	"caption" text NOT NULL,
	"published_at" text NOT NULL,
	"duration_seconds" double precision NOT NULL,
	"transcript" jsonb NOT NULL,
	"duplicate_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_lesson_sources_source_course_key" UNIQUE("source_id","course"),
	CONSTRAINT "academy_lesson_sources_fields_check" CHECK ("academy_lesson_sources"."source_id" ~ '^[A-Za-z0-9_-]{5,20}$' and "academy_lesson_sources"."course" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("academy_lesson_sources"."course") <= 40 and "academy_lesson_sources"."url" ~ '^https://' and length("academy_lesson_sources"."url") <= 500 and length("academy_lesson_sources"."caption") <= 5000 and "academy_lesson_sources"."published_at" ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$' and "academy_lesson_sources"."duration_seconds" >= 0 and "academy_lesson_sources"."duration_seconds" <= 86400 and ("academy_lesson_sources"."duplicate_of" is null or "academy_lesson_sources"."duplicate_of" <> "academy_lesson_sources"."source_id")),
	CONSTRAINT "academy_lesson_sources_transcript_check" CHECK (jsonb_typeof("academy_lesson_sources"."transcript") = 'array' and octet_length("academy_lesson_sources"."transcript"::text) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "academy_lesson_specs" (
	"slug" text PRIMARY KEY NOT NULL,
	"course" text NOT NULL,
	"source_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_lesson_specs_fields_check" CHECK ("academy_lesson_specs"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("academy_lesson_specs"."slug") <= 60 and "academy_lesson_specs"."spec_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "academy_lesson_specs_spec_check" CHECK (jsonb_typeof("academy_lesson_specs"."spec") = 'object' and octet_length("academy_lesson_specs"."spec"::text) <= 131072 and coalesce("academy_lesson_specs"."spec" ->> 'slug', '') = "academy_lesson_specs"."slug" and coalesce("academy_lesson_specs"."spec" ->> 'sourceId', '') = "academy_lesson_specs"."source_id" and coalesce("academy_lesson_specs"."spec" ->> 'course', '') = "academy_lesson_specs"."course")
);
--> statement-breakpoint
ALTER TABLE "academy_lesson_specs" ADD CONSTRAINT "academy_lesson_specs_source_fk" FOREIGN KEY ("source_id","course") REFERENCES "public"."academy_lesson_sources"("source_id","course") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "academy_lesson_sources_course_idx" ON "academy_lesson_sources" USING btree ("course");--> statement-breakpoint
CREATE UNIQUE INDEX "academy_lesson_specs_source_idx" ON "academy_lesson_specs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "academy_lesson_specs_course_idx" ON "academy_lesson_specs" USING btree ("course");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the Academy content repository uses
-- (reads for academy.lessons and academy.lesson; insert, update and, with --prune, delete for
-- `bun run vertex:academy:import`). No seed: the import CLI loads each database course.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "academy_lesson_sources" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "academy_lesson_specs" TO "vertex_research";
  END IF;
END
$$;
