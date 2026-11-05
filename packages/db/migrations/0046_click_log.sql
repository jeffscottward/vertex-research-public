CREATE TABLE "ui_click_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tab_id" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"label" text NOT NULL,
	"test_id" text,
	"route" text NOT NULL,
	"target_route" text,
	"important" boolean NOT NULL,
	"request_ids" text[] NOT NULL,
	"record_request_id" text NOT NULL,
	"build_sha" text NOT NULL,
	CONSTRAINT "ui_click_events_kind_check" CHECK ("ui_click_events"."kind" in ('click', 'submit') and "ui_click_events"."role" in ('button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch', 'summary', 'form')),
	CONSTRAINT "ui_click_events_text_check" CHECK (char_length("ui_click_events"."label") <= 80 and char_length("ui_click_events"."route") between 1 and 300 and ("ui_click_events"."test_id" is null or char_length("ui_click_events"."test_id") <= 80) and ("ui_click_events"."target_route" is null or char_length("ui_click_events"."target_route") <= 300) and cardinality("ui_click_events"."request_ids") <= 8)
);
--> statement-breakpoint
ALTER TABLE "ui_click_events" ADD CONSTRAINT "ui_click_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ui_click_events_user_occurred_idx" ON "ui_click_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ui_click_events_occurred_idx" ON "ui_click_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ui_click_events_received_idx" ON "ui_click_events" USING btree ("received_at");--> statement-breakpoint
-- App-role privileges (see 0039_app_role_grants): only when the app role exists.
-- The web app inserts clicks, reads them for operators and deletes rows older than 14 days.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, DELETE ON TABLE "ui_click_events" TO "vertex_research";
  END IF;
END
$$;
