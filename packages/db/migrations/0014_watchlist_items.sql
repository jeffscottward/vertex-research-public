-- Private per-user watchlist. Symbols and optional buy-zone bounds only.
-- No orders, intents, quantities, quotes or alerts. Idempotent (IF NOT EXISTS) so it
-- can be applied directly ahead of unapplied 0009-0013 and a later full migrate is a no-op.
CREATE TABLE IF NOT EXISTS "watchlist_items" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "symbol" text NOT NULL,
  "note" text,
  "buy_zone_low" numeric,
  "buy_zone_high" numeric,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "watchlist_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "watchlist_items_symbol_check" CHECK ("watchlist_items"."symbol" ~ '^[A-Z][A-Z0-9.\-]{0,9}$'),
  CONSTRAINT "watchlist_items_note_check" CHECK ("watchlist_items"."note" is null or char_length("watchlist_items"."note") <= 500),
  CONSTRAINT "watchlist_items_buy_zone_check" CHECK (("watchlist_items"."buy_zone_low" is null or "watchlist_items"."buy_zone_low" > 0) and ("watchlist_items"."buy_zone_high" is null or "watchlist_items"."buy_zone_high" > 0) and ("watchlist_items"."buy_zone_low" is null or "watchlist_items"."buy_zone_high" is null or "watchlist_items"."buy_zone_low" <= "watchlist_items"."buy_zone_high"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "watchlist_items_user_symbol_unique_idx" ON "watchlist_items" USING btree ("user_id","symbol");
