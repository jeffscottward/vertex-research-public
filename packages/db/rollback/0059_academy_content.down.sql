-- Guarded reversal of 0059_academy_content only.
-- Refuses while either Academy content table holds a row, so imported lessons are never silently
-- discarded: delete them first (they are reproducible with `bun run vertex:academy:import`), knowing
-- the database courses' pages then show no lessons. No cascading drops, truncation or conditional
-- drops. Drizzle ledger reconciliation is deliberately not automated: after this rollback the 0059 row
-- stays in drizzle.__drizzle_migrations, so `db:migrate` skips 0059 and the tables stay missing
-- (academy.lessons and academy.lesson answer STORAGE_ERROR). To re-apply, delete that ledger row
-- (match its hash) first, then run `db:migrate`. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "public"."academy_lesson_specs", "public"."academy_lesson_sources" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."academy_lesson_specs")
    OR EXISTS (SELECT 1 FROM "public"."academy_lesson_sources") THEN
    RAISE EXCEPTION 'academy content tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."academy_lesson_specs";
DROP TABLE "public"."academy_lesson_sources";
COMMIT;
