-- Operator strategy library: strategies with a typed params schema, named presets, and an optional
-- strategy link on agent-reported backtests (ON DELETE SET NULL). Idempotent (IF NOT EXISTS,
-- ON CONFLICT DO NOTHING) like 0015-0018.
CREATE TABLE IF NOT EXISTS "strategies" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "kind" text NOT NULL,
  "status" text DEFAULT 'idea' NOT NULL,
  "source_ref" text,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "favorite" boolean DEFAULT false NOT NULL,
  "section" text,
  "params" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "strategies_slug_check" CHECK ("strategies"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("strategies"."slug") <= 80),
  CONSTRAINT "strategies_name_check" CHECK (char_length(trim("strategies"."name")) between 1 and 200),
  CONSTRAINT "strategies_kind_check" CHECK ("strategies"."kind" in ('python', 'native', 'external')),
  CONSTRAINT "strategies_status_check" CHECK ("strategies"."status" in ('idea', 'researching', 'backtested', 'paper', 'live_candidate', 'retired')),
  CONSTRAINT "strategies_text_check" CHECK (("strategies"."description" is null or char_length("strategies"."description") <= 2000) and ("strategies"."source_ref" is null or char_length("strategies"."source_ref") between 1 and 300) and ("strategies"."section" is null or char_length(trim("strategies"."section")) between 1 and 80)),
  CONSTRAINT "strategies_json_check" CHECK (jsonb_typeof("strategies"."tags") = 'array' and jsonb_array_length("strategies"."tags") <= 20 and octet_length("strategies"."tags"::text) <= 2048 and jsonb_typeof("strategies"."params") = 'array' and jsonb_array_length("strategies"."params") <= 60 and octet_length("strategies"."params"::text) <= 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_slug_unique_idx" ON "strategies" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategies_updated_idx" ON "strategies" USING btree ("updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategies_section_idx" ON "strategies" USING btree ("section");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_presets" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "name" text NOT NULL,
  "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "strategy_presets_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "strategy_presets_name_check" CHECK (char_length(trim("strategy_presets"."name")) between 1 and 80),
  CONSTRAINT "strategy_presets_values_check" CHECK (jsonb_typeof("strategy_presets"."values") = 'object' and octet_length("strategy_presets"."values"::text) <= 16384)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_presets_strategy_name_unique_idx" ON "strategy_presets" USING btree ("strategy_id","name");
--> statement-breakpoint
ALTER TABLE "backtest_results" ADD COLUMN IF NOT EXISTS "strategy_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_results_strategy_id_strategies_id_fk') THEN
    ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_results_strategy_idx" ON "backtest_results" USING btree ("strategy_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- Seed: Vertex's own research strategy modules under services/research/strategies/ (helpers, gates,
-- publication and metrics modules excluded). Descriptions restate each module docstring. No module
-- declares a typed config with defaults, so params stay empty. Existing slugs are never overwritten.
INSERT INTO "strategies" ("id", "slug", "name", "description", "kind", "status", "source_ref", "tags", "params") VALUES
  ('strategy-seed-hmm', 'hmm', 'HMM forward filter', 'Fixed-parameter diagonal Gaussian HMM, forward filtering only; no fitting, smoothing or allocation.', 'python', 'researching', 'services/research/strategies/hmm.py', '["regime"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-jump', 'jump', 'Jump model', 'Fixed-centroid discrete statistical jump model, online inference only (arXiv:2402.05272v3 source variant).', 'python', 'researching', 'services/research/strategies/jump.py', '["regime"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-composite', 'composite', 'HMM and jump agreement envelope', 'Per-timestamp stance table over reviewed HMM and jump results; not an average, vote or weight.', 'python', 'researching', 'services/research/strategies/composite.py', '["regime"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-macro', 'macro', 'Macro regime policy', 'Vintage-aware macro regime classification and rebalance planning under a caller-authored policy.', 'python', 'researching', 'services/research/strategies/macro.py', '["macro", "regime"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-quant', 'quant', 'Quant experiment orchestration', 'Hypothesis, spec and experiment orchestration without running research code.', 'python', 'researching', 'services/research/strategies/quant.py', '["experiments"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-swing', 'swing', 'Swing momentum', 'Completed-bar swing and momentum research plus session studies.', 'python', 'researching', 'services/research/strategies/swing.py', '["momentum"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-wheel', 'wheel', 'Options wheel', 'Wheel research projection over supplied simulated or observed events; not an account ledger.', 'python', 'researching', 'services/research/strategies/wheel.py', '["options"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-zero-dte', 'zero-dte', 'Zero-DTE research capability', 'Same-day options research capability with eight unmet readiness gates; not a funded sleeve.', 'python', 'researching', 'services/research/strategies/zero_dte.py', '["options"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-options-payoff', 'options-payoff', 'Credit condor payoff', 'Four-leg credit condor intrinsic payoff at expiry.', 'python', 'researching', 'services/research/strategies/options_payoff.py', '["options"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-fundamental', 'fundamental', 'Fundamental thesis', 'Point-in-time fundamental research with explicitly versioned thesis decisions.', 'python', 'researching', 'services/research/strategies/fundamental.py', '["fundamental"]'::jsonb, '[]'::jsonb),
  ('strategy-seed-paper-lab', 'paper-lab', 'Paper claim mapping', 'Maps reviewed paper claims to Hypothesis and ExperimentRequest contracts; does not download or run papers.', 'python', 'researching', 'services/research/strategies/paper_lab.py', '["papers"]'::jsonb, '[]'::jsonb)
ON CONFLICT ("slug") DO NOTHING;
