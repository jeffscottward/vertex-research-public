-- Agent-reported backtest results linked to agent_tasks (cascade) and optionally research_papers.
-- Values are agent-reported and unverified; drawdown and max_drawdown are derived server-side from
-- equity. Idempotent (IF NOT EXISTS) so it can be applied directly ahead of unapplied migrations.
CREATE TABLE IF NOT EXISTS "backtest_results" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "paper_id" text,
  "strategy" text NOT NULL,
  "instruments" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "data_source" text NOT NULL,
  "is_split" jsonb,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "equity" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "drawdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "max_drawdown" double precision,
  "trades" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "trade_count" integer DEFAULT 0 NOT NULL,
  "folds" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "backtest_results_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "backtest_results_paper_id_research_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."research_papers"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "backtest_results_text_check" CHECK (char_length(trim("backtest_results"."strategy")) between 1 and 200 and char_length(trim("backtest_results"."instruments")) between 1 and 500 and char_length(trim("backtest_results"."data_source")) between 1 and 300 and ("backtest_results"."notes" is null or char_length("backtest_results"."notes") <= 4000)),
  CONSTRAINT "backtest_results_period_check" CHECK ("backtest_results"."period_start" <= "backtest_results"."period_end"),
  CONSTRAINT "backtest_results_json_check" CHECK (jsonb_typeof("backtest_results"."metrics") = 'object' and octet_length("backtest_results"."metrics"::text) <= 8192 and ("backtest_results"."is_split" is null or (jsonb_typeof("backtest_results"."is_split") = 'object' and octet_length("backtest_results"."is_split"::text) <= 32768)) and jsonb_typeof("backtest_results"."equity") = 'array' and jsonb_array_length("backtest_results"."equity") <= 5000 and jsonb_typeof("backtest_results"."drawdown") = 'array' and jsonb_array_length("backtest_results"."drawdown") = jsonb_array_length("backtest_results"."equity") and jsonb_typeof("backtest_results"."trades") = 'array' and jsonb_array_length("backtest_results"."trades") <= 2000 and "backtest_results"."trade_count" = jsonb_array_length("backtest_results"."trades") and jsonb_typeof("backtest_results"."folds") = 'array' and jsonb_array_length("backtest_results"."folds") <= 100 and octet_length("backtest_results"."folds"::text) <= 524288),
  CONSTRAINT "backtest_results_max_drawdown_check" CHECK ("backtest_results"."max_drawdown" is null or ("backtest_results"."max_drawdown" <= 0 and "backtest_results"."max_drawdown" > -1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_results_created_idx" ON "backtest_results" USING btree ("created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_results_task_idx" ON "backtest_results" USING btree ("task_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_results_paper_idx" ON "backtest_results" USING btree ("paper_id");
