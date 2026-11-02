-- Source only; never run automatically. Disable notification admission/senders
-- before an operator-approved rollback. Populated tombstones MUST be retained:
-- switching the consumer back is safe; deleting send history is not.
BEGIN;
LOCK TABLE "notification_admissions", "notification_cooldowns" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "notification_admissions") OR EXISTS (SELECT 1 FROM "notification_cooldowns") THEN
    RAISE EXCEPTION 'Refusing notification rollback: permanent admission/cooldown records must be preserved';
  END IF;
END $$;
DROP TABLE "notification_cooldowns";
DROP TABLE "notification_admissions";
COMMIT;
