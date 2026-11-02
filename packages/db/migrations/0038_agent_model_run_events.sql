CREATE TABLE "agent_model_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"agent" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"model" text,
	"tool_name" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"duration_ms" integer,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce("title", '') || ' ' || coalesce("body", ''))) STORED NOT NULL,
	CONSTRAINT "agent_model_run_events_kind_check" CHECK ("agent_model_run_events"."kind" in ('llm_call', 'tool_call', 'tool_result', 'reasoning', 'message', 'decision', 'status', 'flag') and ("agent_model_run_events"."kind" <> 'flag' or "agent_model_run_events"."title" ~ '^[a-z][a-z0-9_-]{0,39}$')),
	CONSTRAINT "agent_model_run_events_text_check" CHECK (char_length(trim("agent_model_run_events"."agent")) between 1 and 100 and char_length(trim("agent_model_run_events"."title")) between 1 and 300 and ("agent_model_run_events"."body" is null or char_length("agent_model_run_events"."body") <= 16000) and ("agent_model_run_events"."model" is null or char_length(trim("agent_model_run_events"."model")) between 1 and 200) and ("agent_model_run_events"."tool_name" is null or char_length(trim("agent_model_run_events"."tool_name")) between 1 and 100)),
	CONSTRAINT "agent_model_run_events_numbers_check" CHECK ("agent_model_run_events"."seq" >= 0 and ("agent_model_run_events"."input_tokens" is null or "agent_model_run_events"."input_tokens" >= 0) and ("agent_model_run_events"."output_tokens" is null or "agent_model_run_events"."output_tokens" >= 0) and ("agent_model_run_events"."cost_usd" is null or ("agent_model_run_events"."cost_usd" >= 0 and "agent_model_run_events"."cost_usd" <= 1000000)) and ("agent_model_run_events"."duration_ms" is null or "agent_model_run_events"."duration_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "agent_model_run_events" ADD CONSTRAINT "agent_model_run_events_run_id_agent_model_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_model_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_model_run_events_run_seq_idx" ON "agent_model_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_model_run_events_search_idx" ON "agent_model_run_events" USING gin ("search");