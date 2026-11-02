CREATE TABLE "agent_model_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_key" text NOT NULL,
	"task_id" text,
	"framework" text NOT NULL,
	"framework_version" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"models_served" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ticker" text NOT NULL,
	"decision_date" date NOT NULL,
	"analysts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rating" text,
	"rating_source" text DEFAULT 'missing' NOT NULL,
	"entry_price" double precision,
	"stop_price" double precision,
	"target_price" double precision,
	"horizon" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"batch" text,
	"purpose" text DEFAULT 'live' NOT NULL,
	"variant" text,
	"memory" boolean DEFAULT false NOT NULL,
	"data_source" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_runs_enum_check" CHECK ("agent_model_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled') and "agent_model_runs"."purpose" in ('live', 'backtest', 'benchmark', 'imported') and (("agent_model_runs"."rating" is null and "agent_model_runs"."rating_source" = 'missing') or ("agent_model_runs"."rating" in ('buy', 'overweight', 'hold', 'underweight', 'sell') and "agent_model_runs"."rating_source" in ('stated', 'mapped')))),
	CONSTRAINT "agent_model_runs_text_check" CHECK ("agent_model_runs"."run_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and "agent_model_runs"."framework" ~ '^[a-z][a-z0-9_-]{0,39}$' and "agent_model_runs"."ticker" ~ '^[A-Z0-9][A-Z0-9.=/-]{0,19}$' and char_length(trim("agent_model_runs"."provider")) between 1 and 64 and char_length(trim("agent_model_runs"."model")) between 1 and 200 and ("agent_model_runs"."framework_version" is null or char_length(trim("agent_model_runs"."framework_version")) between 1 and 64) and ("agent_model_runs"."horizon" is null or char_length(trim("agent_model_runs"."horizon")) between 1 and 64) and ("agent_model_runs"."error" is null or char_length("agent_model_runs"."error") <= 2000) and ("agent_model_runs"."batch" is null or "agent_model_runs"."batch" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$') and ("agent_model_runs"."variant" is null or "agent_model_runs"."variant" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$') and ("agent_model_runs"."data_source" is null or char_length(trim("agent_model_runs"."data_source")) between 1 and 120)),
	CONSTRAINT "agent_model_runs_numbers_check" CHECK ("agent_model_runs"."input_tokens" >= 0 and "agent_model_runs"."output_tokens" >= 0 and "agent_model_runs"."llm_calls" >= 0 and "agent_model_runs"."tool_calls" >= 0 and "agent_model_runs"."cost_usd" >= 0 and "agent_model_runs"."cost_usd" <= 1000000 and ("agent_model_runs"."duration_ms" is null or "agent_model_runs"."duration_ms" >= 0) and ("agent_model_runs"."entry_price" is null or ("agent_model_runs"."entry_price" > 0 and "agent_model_runs"."entry_price" < 1e12)) and ("agent_model_runs"."stop_price" is null or ("agent_model_runs"."stop_price" > 0 and "agent_model_runs"."stop_price" < 1e12)) and ("agent_model_runs"."target_price" is null or ("agent_model_runs"."target_price" > 0 and "agent_model_runs"."target_price" < 1e12))),
	CONSTRAINT "agent_model_runs_json_check" CHECK (jsonb_typeof("agent_model_runs"."analysts") = 'array' and jsonb_array_length("agent_model_runs"."analysts") <= 16 and not jsonb_path_exists("agent_model_runs"."analysts", '$[*] ? (@.type() != "string")') and jsonb_typeof("agent_model_runs"."flags") = 'array' and jsonb_array_length("agent_model_runs"."flags") <= 16 and not jsonb_path_exists("agent_model_runs"."flags", '$[*] ? (@.type() != "string")') and jsonb_typeof("agent_model_runs"."models_served") = 'array' and jsonb_array_length("agent_model_runs"."models_served") <= 16 and not jsonb_path_exists("agent_model_runs"."models_served", '$[*] ? (@.type() != "object")') and octet_length("agent_model_runs"."analysts"::text) <= 2048 and octet_length("agent_model_runs"."flags"::text) <= 1024 and octet_length("agent_model_runs"."models_served"::text) <= 8192)
);
--> statement-breakpoint
ALTER TABLE "agent_model_runs" ADD CONSTRAINT "agent_model_runs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_model_runs_run_key_idx" ON "agent_model_runs" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX "agent_model_runs_decision_idx" ON "agent_model_runs" USING btree ("decision_date" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_model_runs_framework_idx" ON "agent_model_runs" USING btree ("framework","decision_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_model_runs_provider_model_idx" ON "agent_model_runs" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX "agent_model_runs_ticker_idx" ON "agent_model_runs" USING btree ("ticker","decision_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_model_runs_status_idx" ON "agent_model_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_model_runs_rating_idx" ON "agent_model_runs" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "agent_model_runs_batch_idx" ON "agent_model_runs" USING btree ("batch");--> statement-breakpoint
CREATE INDEX "agent_model_runs_variant_idx" ON "agent_model_runs" USING btree ("variant");--> statement-breakpoint
CREATE INDEX "agent_model_runs_task_idx" ON "agent_model_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_model_runs_flags_idx" ON "agent_model_runs" USING gin ("flags");