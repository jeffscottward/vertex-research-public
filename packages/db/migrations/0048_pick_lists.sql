CREATE TABLE "pick_list_members" (
	"snapshot_id" text NOT NULL,
	"symbol" text NOT NULL,
	"rank" integer,
	"weight" numeric,
	"sector" text,
	"rating" text,
	"thesis" text,
	"target_price" numeric,
	"added_on" date,
	CONSTRAINT "pick_list_members_snapshot_id_symbol_pk" PRIMARY KEY("snapshot_id","symbol"),
	CONSTRAINT "pick_list_members_fields_check" CHECK ("pick_list_members"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}$' and ("pick_list_members"."rank" is null or "pick_list_members"."rank" between 1 and 1000) and ("pick_list_members"."weight" is null or ("pick_list_members"."weight" >= 0 and "pick_list_members"."weight" <= 1)) and ("pick_list_members"."target_price" is null or "pick_list_members"."target_price" > 0) and ("pick_list_members"."sector" is null or char_length("pick_list_members"."sector") <= 60) and ("pick_list_members"."rating" is null or char_length("pick_list_members"."rating") <= 40) and ("pick_list_members"."thesis" is null or char_length("pick_list_members"."thesis") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "pick_list_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"pick_list_id" text NOT NULL,
	"as_of" date NOT NULL,
	"method" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_list_snapshots_method_check" CHECK ("pick_list_snapshots"."method" in ('manual', 'adapter'))
);
--> statement-breakpoint
CREATE TABLE "pick_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_label" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"bucket_symbol" text,
	"bucket_basket_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_lists_fields_check" CHECK ("pick_lists"."source" ~ '^[a-z0-9][a-z0-9-]{0,39}$' and "pick_lists"."slug" ~ '^[a-z0-9][a-z0-9-]{0,39}$' and char_length(trim("pick_lists"."source_label")) between 1 and 80 and char_length(trim("pick_lists"."name")) between 1 and 80 and ("pick_lists"."bucket_symbol" is null or "pick_lists"."bucket_symbol" ~ '^[A-Z][A-Z0-9]{0,9}$'))
);
--> statement-breakpoint
ALTER TABLE "pick_list_members" ADD CONSTRAINT "pick_list_members_snapshot_id_pick_list_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."pick_list_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_snapshots" ADD CONSTRAINT "pick_list_snapshots_pick_list_id_pick_lists_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."pick_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_bucket_basket_id_baskets_id_fk" FOREIGN KEY ("bucket_basket_id") REFERENCES "public"."baskets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pick_list_snapshots_list_as_of_unique_idx" ON "pick_list_snapshots" USING btree ("pick_list_id","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "pick_lists_user_source_slug_unique_idx" ON "pick_lists" USING btree ("user_id","source","slug");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the pick list repository uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "pick_lists" TO "vertex_research";
    GRANT SELECT, INSERT, DELETE ON TABLE "pick_list_snapshots" TO "vertex_research";
    GRANT SELECT, INSERT, DELETE ON TABLE "pick_list_members" TO "vertex_research";
  END IF;
END
$$;
