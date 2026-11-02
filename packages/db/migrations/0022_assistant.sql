-- Operator research assistant: threads, messages (text, tool-call trace summaries, token usage) and the
-- per-user, per-UTC-day model budget ledger. Rows hold conversation records only; nothing reads them to
-- start, route or submit anything, and no assistant record authorizes trading or deployment.
-- Threads and usage rows cascade with their user; messages cascade with their thread.
-- Idempotent (IF NOT EXISTS) like 0015-0021.
CREATE TABLE IF NOT EXISTS "assistant_threads" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "assistant_threads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "assistant_threads_title_check" CHECK (char_length(trim("assistant_threads"."title")) between 1 and 120)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_threads_user_idx" ON "assistant_threads" USING btree ("user_id","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "role" text NOT NULL,
  "mode" text NOT NULL,
  "content" text NOT NULL,
  "tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "assistant_messages_thread_id_assistant_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."assistant_threads"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "assistant_messages_role_check" CHECK ("assistant_messages"."role" in ('user', 'assistant')),
  CONSTRAINT "assistant_messages_mode_check" CHECK ("assistant_messages"."mode" in ('plan', 'act')),
  CONSTRAINT "assistant_messages_content_check" CHECK (char_length("assistant_messages"."content") <= 32000 and ("assistant_messages"."role" = 'assistant' or char_length(trim("assistant_messages"."content")) >= 1)),
  CONSTRAINT "assistant_messages_tool_calls_check" CHECK (jsonb_typeof("assistant_messages"."tool_calls") = 'array' and jsonb_array_length("assistant_messages"."tool_calls") <= 64 and octet_length("assistant_messages"."tool_calls"::text) <= 65536),
  CONSTRAINT "assistant_messages_tokens_check" CHECK ("assistant_messages"."input_tokens" >= 0 and "assistant_messages"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_messages_thread_idx" ON "assistant_messages" USING btree ("thread_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_usage" (
  "user_id" text NOT NULL,
  "day" date NOT NULL,
  "requests" integer DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "assistant_usage_pk" PRIMARY KEY ("user_id","day"),
  CONSTRAINT "assistant_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "assistant_usage_counts_check" CHECK ("assistant_usage"."requests" >= 0 and "assistant_usage"."input_tokens" >= 0 and "assistant_usage"."output_tokens" >= 0)
);
