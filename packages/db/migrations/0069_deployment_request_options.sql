-- Optional options block on paper deployment requests: structure, expiry and strike targets, budget and
-- max loss in percent of the account, and the group of a multi-symbol request. Nullable without a
-- default, so every row written before this migration stays readable (options is null = old format).
-- The CHECK repeats only the hard rules that are cheap in SQL; the full rules are in
-- packages/db/src/server/deployment-requests.ts (normalizeDeploymentOptions). Requests stay records
-- only and mode stays fixed to paper: deployment_requests_mode_check is not touched. Idempotent like 0021.
ALTER TABLE "deployment_requests" ADD COLUMN IF NOT EXISTS "options" jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_requests_options_check' AND conrelid = '"deployment_requests"'::regclass) THEN
    ALTER TABLE "deployment_requests" ADD CONSTRAINT "deployment_requests_options_check" CHECK ("deployment_requests"."options" is null or (case when jsonb_typeof("deployment_requests"."options") = 'object' and jsonb_typeof("deployment_requests"."options"->'structure') = 'string' and jsonb_typeof("deployment_requests"."options"->'maxLossPctOfAccount') = 'number' then octet_length("deployment_requests"."options"::text) <= 4096 and "deployment_requests"."options"->>'structure' in ('callDebitVertical', 'putDebitVertical', 'putCreditVertical', 'callCreditVertical') and ("deployment_requests"."options"->>'maxLossPctOfAccount')::numeric > 0 and ("deployment_requests"."options"->>'maxLossPctOfAccount')::numeric <= 2 else false end));
  END IF;
END
$$;
