CREATE TABLE "todos" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"due_date" date,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "todos_text_check" CHECK (char_length(trim("todos"."title")) between 1 and 200 and ("todos"."note" is null or char_length("todos"."note") <= 2000) and "todos"."status" in ('open', 'done') and cardinality("todos"."tags") <= 10 and ("todos"."source_url" is null or (char_length("todos"."source_url") <= 2000 and "todos"."source_url" ~ '^https?://')))
);
--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todos_user_status_due_idx" ON "todos" USING btree ("user_id","status","due_date");