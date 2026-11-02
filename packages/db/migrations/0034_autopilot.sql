CREATE TABLE "autopilot_campaigns" (
	"best_candidate_id" text,
	"best_fitness" double precision,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"config" jsonb NOT NULL,
	"cpu_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"finished_at" timestamp with time zone,
	"gated_count" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"started_at" timestamp with time zone,
	"status" text NOT NULL,
	"symbol" text NOT NULL,
	"ticked_at" timestamp with time zone,
	"timeframe" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "autopilot_campaigns_status_check" CHECK ("autopilot_campaigns"."status" in ('running', 'stopped', 'completed', 'failed')),
	CONSTRAINT "autopilot_campaigns_counts_check" CHECK ("autopilot_campaigns"."generation" >= 0 and "autopilot_campaigns"."candidate_count" >= 0 and "autopilot_campaigns"."gated_count" >= 0 and "autopilot_campaigns"."verified_count" >= 0 and "autopilot_campaigns"."cpu_ms" >= 0 and "autopilot_campaigns"."version" >= 0),
	CONSTRAINT "autopilot_campaigns_text_check" CHECK (char_length(trim("autopilot_campaigns"."name")) between 1 and 120 and char_length("autopilot_campaigns"."symbol") between 1 and 64 and char_length("autopilot_campaigns"."timeframe") between 1 and 16 and ("autopilot_campaigns"."note" is null or char_length("autopilot_campaigns"."note") between 1 and 500)),
	CONSTRAINT "autopilot_campaigns_config_check" CHECK (jsonb_typeof("autopilot_campaigns"."config") = 'object' and octet_length("autopilot_campaigns"."config"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "autopilot_candidates" (
	"campaign_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"definition" jsonb NOT NULL,
	"deployment_request_id" text,
	"first_t" timestamp with time zone NOT NULL,
	"fitness" double precision,
	"gate" jsonb,
	"gated_at" timestamp with time zone,
	"generation" integer NOT NULL,
	"genome" jsonb NOT NULL,
	"genome_key" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"in_sample" jsonb NOT NULL,
	"label" text NOT NULL,
	"last_t" timestamp with time zone NOT NULL,
	"oos_sharpe" double precision,
	"origin" text NOT NULL,
	"parent_ids" jsonb NOT NULL,
	"returns_count" integer NOT NULL,
	"returns_mean" double precision NOT NULL,
	"returns_std" double precision NOT NULL,
	"series" text NOT NULL,
	"status" text DEFAULT 'evaluated' NOT NULL,
	"strategy_id" text,
	CONSTRAINT "autopilot_candidates_status_check" CHECK ("autopilot_candidates"."status" in ('evaluated', 'rejected', 'verified')),
	CONSTRAINT "autopilot_candidates_origin_check" CHECK ("autopilot_candidates"."origin" in ('random', 'crossover', 'mutation', 'neighbour')),
	CONSTRAINT "autopilot_candidates_gate_check" CHECK (("autopilot_candidates"."status" = 'evaluated') = ("autopilot_candidates"."gated_at" is null) and ("autopilot_candidates"."gate" is null or (jsonb_typeof("autopilot_candidates"."gate") = 'object' and octet_length("autopilot_candidates"."gate"::text) <= 65536))),
	CONSTRAINT "autopilot_candidates_json_check" CHECK (jsonb_typeof("autopilot_candidates"."genome") = 'object' and jsonb_typeof("autopilot_candidates"."definition") = 'object' and jsonb_typeof("autopilot_candidates"."in_sample") = 'object' and jsonb_typeof("autopilot_candidates"."parent_ids") = 'array' and octet_length("autopilot_candidates"."definition"::text) <= 65536),
	CONSTRAINT "autopilot_candidates_text_check" CHECK (char_length("autopilot_candidates"."label") between 1 and 500 and char_length("autopilot_candidates"."genome_key") between 2 and 2000 and char_length("autopilot_candidates"."series") between 3 and 81 and "autopilot_candidates"."generation" >= 0 and "autopilot_candidates"."returns_count" >= 0),
	CONSTRAINT "autopilot_candidates_handoff_check" CHECK (("autopilot_candidates"."deployment_request_id" is null or ("autopilot_candidates"."status" = 'verified' and "autopilot_candidates"."strategy_id" is not null)))
);
--> statement-breakpoint
ALTER TABLE "autopilot_candidates" ADD CONSTRAINT "autopilot_candidates_campaign_id_autopilot_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."autopilot_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autopilot_campaigns_due_idx" ON "autopilot_campaigns" USING btree ("status","ticked_at");--> statement-breakpoint
CREATE INDEX "autopilot_campaigns_created_idx" ON "autopilot_campaigns" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_candidates_genome_unique_idx" ON "autopilot_candidates" USING btree ("campaign_id","genome_key");--> statement-breakpoint
CREATE INDEX "autopilot_candidates_fitness_idx" ON "autopilot_candidates" USING btree ("campaign_id","fitness" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "autopilot_candidates_series_idx" ON "autopilot_candidates" USING btree ("series","created_at" DESC NULLS LAST);