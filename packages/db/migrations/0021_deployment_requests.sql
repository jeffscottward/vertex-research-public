-- Operator paper deployment requests: records only. Nothing reads these rows to start, route or submit
-- anything; there is no transport to the Quant VPS execution owner or any broker, and an approval is a
-- recorded human decision, never an execution grant. mode is fixed to paper. strategy_id restricts
-- strategy deletion; preset_id is cleared when its preset is deleted. Idempotent (IF NOT EXISTS) like 0015-0020.
CREATE TABLE IF NOT EXISTS "deployment_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "preset_id" text,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "symbol" text NOT NULL,
  "timeframe" text NOT NULL,
  "mode" text DEFAULT 'paper' NOT NULL,
  "limits" jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "requested_by" text NOT NULL,
  "requested_at" timestamp with time zone,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deployment_requests_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "deployment_requests_preset_id_strategy_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."strategy_presets"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "deployment_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "deployment_requests_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "deployment_requests_mode_check" CHECK ("deployment_requests"."mode" = 'paper'),
  CONSTRAINT "deployment_requests_status_check" CHECK ("deployment_requests"."status" in ('draft', 'requested', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT "deployment_requests_text_check" CHECK ("deployment_requests"."symbol" ~ '^[A-Z0-9][A-Z0-9._/:-]{0,31}$' and "deployment_requests"."timeframe" ~ '^[1-9][0-9]{0,2}(s|m|h|d|w)$' and ("deployment_requests"."decision_note" is null or char_length(trim("deployment_requests"."decision_note")) between 1 and 1000)),
  CONSTRAINT "deployment_requests_params_check" CHECK (jsonb_typeof("deployment_requests"."params") = 'object' and octet_length("deployment_requests"."params"::text) <= 16384),
  CONSTRAINT "deployment_requests_limits_check" CHECK (jsonb_typeof("deployment_requests"."limits") = 'object' and "deployment_requests"."limits" ?& array['maxOrderSize', 'maxPosition', 'maxOrdersPerMinute', 'dailyLossLimit'] and "deployment_requests"."limits" - array['maxOrderSize', 'maxPosition', 'maxOrdersPerMinute', 'dailyLossLimit'] = '{}'::jsonb and (case when jsonb_typeof("deployment_requests"."limits"->'maxOrderSize') = 'number' and jsonb_typeof("deployment_requests"."limits"->'maxPosition') = 'number' and jsonb_typeof("deployment_requests"."limits"->'maxOrdersPerMinute') = 'number' and jsonb_typeof("deployment_requests"."limits"->'dailyLossLimit') = 'number' then ("deployment_requests"."limits"->>'maxOrderSize')::numeric > 0 and ("deployment_requests"."limits"->>'maxPosition')::numeric > 0 and ("deployment_requests"."limits"->>'maxOrderSize')::numeric <= ("deployment_requests"."limits"->>'maxPosition')::numeric and ("deployment_requests"."limits"->>'maxOrdersPerMinute')::numeric between 1 and 1000 and ("deployment_requests"."limits"->>'maxOrdersPerMinute')::numeric = trunc(("deployment_requests"."limits"->>'maxOrdersPerMinute')::numeric) and ("deployment_requests"."limits"->>'dailyLossLimit')::numeric > 0 else false end)),
  CONSTRAINT "deployment_requests_lifecycle_check" CHECK ((("deployment_requests"."status" = 'draft' and "deployment_requests"."requested_at" is null) or ("deployment_requests"."status" in ('requested', 'approved', 'rejected') and "deployment_requests"."requested_at" is not null) or "deployment_requests"."status" = 'withdrawn') and (("deployment_requests"."decided_by" is null) = ("deployment_requests"."decided_at" is null)) and ("deployment_requests"."status" not in ('approved', 'rejected') or "deployment_requests"."decided_at" is not null) and ("deployment_requests"."status" not in ('draft', 'requested') or "deployment_requests"."decided_at" is null) and ("deployment_requests"."decision_note" is null or "deployment_requests"."decided_at" is not null) and ("deployment_requests"."status" <> 'rejected' or "deployment_requests"."decision_note" is not null))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_requests_created_idx" ON "deployment_requests" USING btree ("created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_requests_status_idx" ON "deployment_requests" USING btree ("status","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_requests_strategy_idx" ON "deployment_requests" USING btree ("strategy_id","created_at" DESC NULLS LAST);
