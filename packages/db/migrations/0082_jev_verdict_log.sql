CREATE TABLE "jev_verdict_log" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_version" text,
	"symbol" text NOT NULL,
	"data_as_of" text,
	"decided_at" timestamp with time zone NOT NULL,
	"model" text,
	"choice" text,
	"stance" text NOT NULL,
	"prob_bearish" double precision NOT NULL,
	"prob_bullish" double precision NOT NULL,
	"prob_neutral" double precision NOT NULL,
	"logged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "jev_verdict_log_check" CHECK ("jev_verdict_log"."stance" in ('BULLISH', 'BEARISH', 'NEUTRAL') and ("jev_verdict_log"."choice" is null or "jev_verdict_log"."choice" in ('BULLISH', 'BEARISH', 'NEUTRAL')) and "jev_verdict_log"."prob_bearish" between 0 and 1 and "jev_verdict_log"."prob_bullish" between 0 and 1 and "jev_verdict_log"."prob_neutral" between 0 and 1 and length("jev_verdict_log"."source") between 1 and 64 and length("jev_verdict_log"."symbol") between 1 and 12 and ("jev_verdict_log"."data_as_of" is null or "jev_verdict_log"."data_as_of" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and ("jev_verdict_log"."source_version" is null or length("jev_verdict_log"."source_version") <= 64) and ("jev_verdict_log"."model" is null or length("jev_verdict_log"."model") <= 200))
);
--> statement-breakpoint
CREATE INDEX "jev_verdict_log_symbol_data_idx" ON "jev_verdict_log" USING btree ("symbol","data_as_of");--> statement-breakpoint
CREATE INDEX "jev_verdict_log_decided_idx" ON "jev_verdict_log" USING btree ("decided_at");--> statement-breakpoint
-- App-role privileges, as in 0077_flow_net_drift. The log is append-only: the app role
-- "vertex_research" may read and insert rows, never update or delete them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT ON TABLE "jev_verdict_log" TO "vertex_research";
  END IF;
END
$$;
