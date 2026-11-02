-- Source only; operator-approved empty-schema reversal, never artifact cleanup.
-- A populated catalog may contain shared immutable object references; preserve it
-- when switching consumers back rather than deleting evidence or blob metadata.
BEGIN;
LOCK TABLE "vertex_object_metadata" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "vertex_object_metadata") THEN
    RAISE EXCEPTION 'Refusing object metadata rollback: immutable references must be retained';
  END IF;
END $$;
DROP TABLE "vertex_object_metadata";
COMMIT;
