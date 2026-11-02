CREATE TABLE "assistant_actions" (
	"args" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"error" text,
	"finished_at" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"result" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text NOT NULL,
	"thread_id" text NOT NULL,
	"tool" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "assistant_actions_status_check" CHECK ("assistant_actions"."status" in ('pending', 'running', 'executed', 'failed', 'rejected')),
	CONSTRAINT "assistant_actions_tool_check" CHECK ("assistant_actions"."tool" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "assistant_actions_text_check" CHECK (char_length("assistant_actions"."summary") between 1 and 500 and ("assistant_actions"."result" is null or char_length("assistant_actions"."result") <= 16000) and ("assistant_actions"."error" is null or char_length("assistant_actions"."error") between 1 and 500)),
	CONSTRAINT "assistant_actions_args_check" CHECK (jsonb_typeof("assistant_actions"."args") = 'object' and octet_length("assistant_actions"."args"::text) <= 65536),
	CONSTRAINT "assistant_actions_decided_check" CHECK (("assistant_actions"."status" = 'pending') = ("assistant_actions"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "strategy_definition_revisions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "strategy_definition_revisions_revision_check" CHECK ("strategy_definition_revisions"."revision" between 1 and 1000000),
	CONSTRAINT "strategy_definition_revisions_sha_check" CHECK ("strategy_definition_revisions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "strategy_definition_revisions_text_check" CHECK (char_length(trim("strategy_definition_revisions"."name")) between 1 and 120 and char_length("strategy_definition_revisions"."definition_id") between 1 and 128 and ("strategy_definition_revisions"."note" is null or char_length("strategy_definition_revisions"."note") <= 500)),
	CONSTRAINT "strategy_definition_revisions_definition_check" CHECK (jsonb_typeof("strategy_definition_revisions"."definition") = 'object' and octet_length("strategy_definition_revisions"."definition"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_message_id_assistant_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."assistant_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_thread_id_assistant_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."assistant_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_actions_thread_idx" ON "assistant_actions" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_definition_revisions_revision_unique_idx" ON "strategy_definition_revisions" USING btree ("definition_id","revision");--> statement-breakpoint
CREATE INDEX "strategy_definition_revisions_created_idx" ON "strategy_definition_revisions" USING btree ("created_at" DESC NULLS LAST);