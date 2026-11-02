-- Workspace-scoped agent operations ledger and research paper library (single-operator fund).
-- Rows carry no user owner. Idempotent (IF NOT EXISTS, ON CONFLICT DO NOTHING) so it can be applied
-- directly ahead of unapplied 0009-0013 and a later full migrate is a no-op.
CREATE TABLE IF NOT EXISTS "research_papers" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "authors" text,
  "year" integer,
  "source_url" text,
  "identifier" text,
  "kind" text DEFAULT 'paper' NOT NULL,
  "stage" text DEFAULT 'queued' NOT NULL,
  "verdict" text DEFAULT 'pending' NOT NULL,
  "blockers" text,
  "notes" text,
  "reported_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reproduced_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "research_papers_title_check" CHECK (char_length(trim("research_papers"."title")) between 1 and 300),
  CONSTRAINT "research_papers_kind_check" CHECK ("research_papers"."kind" in ('paper', 'article')),
  CONSTRAINT "research_papers_stage_check" CHECK ("research_papers"."stage" in ('queued', 'ingested', 'spec_extracted', 'implemented', 'backtested', 'forward_tested', 'verdict')),
  CONSTRAINT "research_papers_verdict_check" CHECK ("research_papers"."verdict" in ('pending', 'promising', 'inconclusive', 'rejected')),
  CONSTRAINT "research_papers_year_check" CHECK ("research_papers"."year" is null or "research_papers"."year" between 1900 and 2100),
  CONSTRAINT "research_papers_text_check" CHECK (("research_papers"."authors" is null or char_length("research_papers"."authors") <= 500) and ("research_papers"."source_url" is null or char_length("research_papers"."source_url") <= 2000) and ("research_papers"."identifier" is null or char_length("research_papers"."identifier") <= 200) and ("research_papers"."blockers" is null or char_length("research_papers"."blockers") <= 4000) and ("research_papers"."notes" is null or char_length("research_papers"."notes") <= 4000)),
  CONSTRAINT "research_papers_metrics_check" CHECK (jsonb_typeof("research_papers"."reported_metrics") = 'object' and jsonb_typeof("research_papers"."reproduced_metrics") = 'object' and octet_length("research_papers"."reported_metrics"::text) <= 8192 and octet_length("research_papers"."reproduced_metrics"::text) <= 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_papers_identifier_unique_idx" ON "research_papers" USING btree ("identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_papers_stage_updated_idx" ON "research_papers" USING btree ("stage","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "agent" text NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "links" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "paper_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "agent_tasks_paper_id_research_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."research_papers"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "agent_tasks_kind_check" CHECK ("agent_tasks"."kind" in ('research', 'paper', 'strategy', 'backtest', 'forward_test', 'optimization', 'deployment', 'data', 'ops')),
  CONSTRAINT "agent_tasks_status_check" CHECK ("agent_tasks"."status" in ('queued', 'running', 'needs_review', 'blocked', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "agent_tasks_agent_check" CHECK (char_length(trim("agent_tasks"."agent")) between 1 and 100),
  CONSTRAINT "agent_tasks_title_check" CHECK (char_length(trim("agent_tasks"."title")) between 1 and 300),
  CONSTRAINT "agent_tasks_summary_check" CHECK ("agent_tasks"."summary" is null or char_length("agent_tasks"."summary") <= 4000),
  CONSTRAINT "agent_tasks_metrics_check" CHECK (jsonb_typeof("agent_tasks"."metrics") = 'object' and octet_length("agent_tasks"."metrics"::text) <= 8192),
  CONSTRAINT "agent_tasks_links_check" CHECK (jsonb_typeof("agent_tasks"."links") = 'array' and jsonb_array_length("agent_tasks"."links") <= 20 and octet_length("agent_tasks"."links"::text) <= 8192)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_status_updated_idx" ON "agent_tasks" USING btree ("status","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_kind_updated_idx" ON "agent_tasks" USING btree ("kind","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_updated_idx" ON "agent_tasks" USING btree ("updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_paper_idx" ON "agent_tasks" USING btree ("paper_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_task_events" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "level" text DEFAULT 'info' NOT NULL,
  "message" text NOT NULL,
  CONSTRAINT "agent_task_events_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "agent_task_events_level_check" CHECK ("agent_task_events"."level" in ('info', 'warn', 'error')),
  CONSTRAINT "agent_task_events_message_check" CHECK (char_length(trim("agent_task_events"."message")) between 1 and 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_task_events_task_at_idx" ON "agent_task_events" USING btree ("task_id","at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_task_events_at_idx" ON "agent_task_events" USING btree ("at" DESC NULLS LAST);
--> statement-breakpoint
-- Seed: the four supplied regime references (private/basic-assembly/macro-regime-primary-research-20260928.md).
-- Stable ids and identifiers; existing rows are never overwritten.
INSERT INTO "research_papers" ("id", "title", "authors", "year", "source_url", "identifier", "kind", "stage", "verdict", "blockers", "notes") VALUES
  ('paper-orca-2604-17251', 'ORCA — Online Regime Correlation Analyzer', 'Boris Kriuk; Fedor Kriuk', 2026, 'https://arxiv.org/abs/2604.17251v1', 'arXiv:2604.17251v1', 'paper', 'queued', 'pending',
   'No ordered 206-column feature manifest; spectral feature count (127) does not reconcile with the described dynamics; expanding-window vs 3-year training folds and exact fold dates unresolved; rally target text ("at any point") conflicts with endpoint equation; F1 thresholds chosen on out-of-sample predictions; complete regime boundaries and intermediate exposure mapping not enumerated; no close-to-execution lag; EWM/GARCH initialization and seed not supplied; no author code.',
   'Supervised 10-day rally/crash event forecast (Random Forest) on 24 ETFs, EODHD adjusted closes 2009-2024. Source-reported, unverified: Sharpe 1.13, CAGR 15.6%, max drawdown -7.5%, BCD-AUC 0.741. DOI 10.48550/arXiv.2604.17251.'),
  ('paper-hmm-rl-2605-27848', 'Regime-Based Portfolio Allocation Using Hidden Markov Models and Reinforcement Learning', 'Ajay Kumar Verma; Nunik Srikandi Putri; Neo Paul Lesupi', 2026, 'https://arxiv.org/abs/2605.27848v1', 'arXiv:2605.27848v1', 'paper', 'queued', 'pending',
   'HMM emission input array (ETF return combination, VIX transformation, dimensionality, scaling) not specified; trade-time predicted-regime routine not supplied; discount factor gamma and the seven discrete actions not listed; exact split date, quantile cutoffs, EM initializations, state-label ordering and refit schedule missing; adjusted vs unadjusted closes unstated; zero transaction costs.',
   'Three-state Gaussian HMM on SPY, TLT, GLD, VIX (Yahoo, 2004-2025) then tabular policy iteration over seven portfolios; 70/30 chronological split; action at t applied to t+1. Source-reported, unverified (test window): RL Sharpe 0.83, annual return 14.3%, max drawdown -23.5%. DOI 10.48550/arXiv.2605.27848.'),
  ('paper-jump-model-2402-05272', 'Downside Risk Reduction Using Regime-Switching Signals: A Statistical Jump Model Approach', 'Yizhan Shu; Chenyu Yu; John M. Mulvey', 2024, 'https://arxiv.org/abs/2402.05272v3', 'arXiv:2402.05272v3', 'paper', 'spec_extracted', 'pending',
   'Downside-deviation definition differs between paper (E[R^2 1(R<0)]) and author code (sqrt of EWM min(r,0)^2); rate-to-daily conversion, EWM warmup, zero-downside handling and scaler scope not fixed; candidate lambda grid and dated schedule not enumerated; Bloomberg total-return and GFD T-bill data not acquired.',
   'Fixed-centroid online inference variant is implemented (source-verified against Yizhan-Oliver-Shu/jump-models commit d0fa00ce, Apache-2.0) but not fitted and not backtested. Two-state discrete jump model; 3,000-day fit window, 6-month refit; signal executed end of t+1. Source-reported, unverified (1990-2023, S&P 500): JM Sharpe 0.68, CAGR 11.2%, max drawdown -26.6%. Journal DOI 10.1057/s41260-024-00376-x.'),
  ('article-ruuj-hmm-regimes-20260707', 'How To Use The Hidden Markov Model To Detect Market Regimes (Complete Framework)', 'Ruuj (@RuujSs)', 2026, 'https://x.com/ruujss/status/2074503360208884204', 'x:ruujss/2074503360208884204', 'article', 'queued', 'pending',
   'Educational article, not a whitepaper: no fit/refit schedule, asset universe, execution lag or data calendar; no license for inline code; no reproduced performance experiment.',
   'Supplies causal forward-recursion semantics and hmmlearn GaussianHMM examples (3 states, 10 restarts, BIC scan 2-6). Use as inference guidance for the HMM+RL paper, not as an independent result.')
ON CONFLICT DO NOTHING;
