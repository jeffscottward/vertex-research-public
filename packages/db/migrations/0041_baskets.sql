CREATE TABLE "basket_members" (
	"basket_id" text NOT NULL,
	"symbol" text NOT NULL,
	"weight" numeric NOT NULL,
	"base_price" numeric,
	"shares_at_base" numeric,
	CONSTRAINT "basket_members_basket_id_symbol_pk" PRIMARY KEY("basket_id","symbol"),
	CONSTRAINT "basket_members_symbol_check" CHECK ("basket_members"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}$'),
	CONSTRAINT "basket_members_weight_check" CHECK ("basket_members"."weight" > 0 and "basket_members"."weight" <= 1),
	CONSTRAINT "basket_members_base_check" CHECK (("basket_members"."base_price" is null or "basket_members"."base_price" > 0) and ("basket_members"."shares_at_base" is null or "basket_members"."shares_at_base" > 0))
);
--> statement-breakpoint
CREATE TABLE "baskets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"base_date" date,
	"base_value" numeric DEFAULT '100' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baskets_symbol_check" CHECK ("baskets"."symbol" ~ '^[A-Z][A-Z0-9]{0,9}$'),
	CONSTRAINT "baskets_name_check" CHECK (char_length(trim("baskets"."name")) between 1 and 80),
	CONSTRAINT "baskets_base_value_check" CHECK ("baskets"."base_value" > 0)
);
--> statement-breakpoint
ALTER TABLE "basket_members" ADD CONSTRAINT "basket_members_basket_id_baskets_id_fk" FOREIGN KEY ("basket_id") REFERENCES "public"."baskets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "baskets_user_symbol_unique_idx" ON "baskets" USING btree ("user_id","symbol");--> statement-breakpoint
-- App-role privileges (see 0039_app_role_grants): only when the app role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "baskets" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "basket_members" TO "vertex_research";
  END IF;
END
$$;
