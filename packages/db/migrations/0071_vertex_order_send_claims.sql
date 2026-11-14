CREATE TABLE "vertex_order_send_claims" (
	"attempt" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_ref" text NOT NULL,
	"request_id" text NOT NULL,
	CONSTRAINT "vertex_order_send_claims_pk" PRIMARY KEY("order_ref","attempt"),
	CONSTRAINT "vertex_order_send_claims_fields_check" CHECK ("vertex_order_send_claims"."attempt" >= 0 and char_length("vertex_order_send_claims"."order_ref") between 1 and 64 and char_length("vertex_order_send_claims"."request_id") between 1 and 200)
);--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the order intent repository uses
-- (recordIntentOnce: insert of a claim, returning its attempt, which needs select). No UPDATE or
-- DELETE: a claim is written once, in the transaction of its intent row, and never removed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT ON TABLE "vertex_order_send_claims" TO "vertex_research";
  END IF;
END
$$;
