-- Agent-recorded optimizer runs (services/research/backtesting/optimizer.py results mapped to camelCase)
-- linked to agent_tasks (cascade) and optionally strategies (ON DELETE SET NULL). Values are
-- agent-reported; importance and score profiles are derived at read time and never stored.
-- Idempotent (IF NOT EXISTS) like 0015-0019.
CREATE TABLE IF NOT EXISTS "optimization_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "strategy_id" text,
  "method" text NOT NULL,
  "objectives" jsonb NOT NULL,
  "validation" jsonb NOT NULL,
  "markets" jsonb NOT NULL,
  "seed" bigint,
  "trial_count" integer NOT NULL,
  "stop_reason" text NOT NULL,
  "best" jsonb,
  "pareto_front" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "trials" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "folds" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "market_ranking" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "oos" jsonb,
  "diagnostics" jsonb,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "optimization_runs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "optimization_runs_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "optimization_runs_enum_check" CHECK ("optimization_runs"."method" in ('grid', 'random', 'tpe', 'evolution', 'pareto', 'market_only') and "optimization_runs"."stop_reason" in ('completed', 'budget', 'time_budget', 'exhausted')),
  CONSTRAINT "optimization_runs_text_check" CHECK ("optimization_runs"."notes" is null or char_length("optimization_runs"."notes") <= 4000),
  CONSTRAINT "optimization_runs_json_check" CHECK (jsonb_typeof("optimization_runs"."objectives") = 'array' and jsonb_array_length("optimization_runs"."objectives") between 1 and 8 and octet_length("optimization_runs"."objectives"::text) <= 4096 and jsonb_typeof("optimization_runs"."validation") = 'object' and "optimization_runs"."validation"->>'mode' in ('single', 'is_oos', 'walk_forward') and octet_length("optimization_runs"."validation"::text) <= 4096 and jsonb_typeof("optimization_runs"."markets") = 'array' and jsonb_array_length("optimization_runs"."markets") between 1 and 40 and octet_length("optimization_runs"."markets"::text) <= 8192 and ("optimization_runs"."best" is null or (jsonb_typeof("optimization_runs"."best") = 'object' and octet_length("optimization_runs"."best"::text) <= 32768)) and jsonb_typeof("optimization_runs"."pareto_front") = 'array' and jsonb_array_length("optimization_runs"."pareto_front") <= 500 and octet_length("optimization_runs"."pareto_front"::text) <= 2097152 and jsonb_typeof("optimization_runs"."folds") = 'array' and jsonb_array_length("optimization_runs"."folds") <= 100 and octet_length("optimization_runs"."folds"::text) <= 4194304 and jsonb_typeof("optimization_runs"."market_ranking") = 'array' and jsonb_array_length("optimization_runs"."market_ranking") <= 40 and octet_length("optimization_runs"."market_ranking"::text) <= 131072 and ("optimization_runs"."oos" is null or (jsonb_typeof("optimization_runs"."oos") = 'object' and octet_length("optimization_runs"."oos"::text) <= 1048576)) and ("optimization_runs"."diagnostics" is null or (jsonb_typeof("optimization_runs"."diagnostics") = 'object' and octet_length("optimization_runs"."diagnostics"::text) <= 32768))),
  CONSTRAINT "optimization_runs_trials_check" CHECK (jsonb_typeof("optimization_runs"."trials") = 'array' and jsonb_array_length("optimization_runs"."trials") <= 5000 and octet_length("optimization_runs"."trials"::text) <= 16777216 and "optimization_runs"."trial_count" between 0 and 1000000 and "optimization_runs"."trial_count" >= jsonb_array_length("optimization_runs"."trials"))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "optimization_runs_created_idx" ON "optimization_runs" USING btree ("created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "optimization_runs_task_idx" ON "optimization_runs" USING btree ("task_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "optimization_runs_strategy_idx" ON "optimization_runs" USING btree ("strategy_id","created_at" DESC NULLS LAST);
