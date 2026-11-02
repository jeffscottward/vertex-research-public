-- Authored source only: not generated, registered, or executed.
-- Public DatasetManifest validation additionally requires the exact closed
-- historicalSemantics branch. This projection does not certify a calendar.
ALTER TABLE vertex_datasets ALTER COLUMN calendar DROP NOT NULL;
ALTER TABLE vertex_datasets ADD CONSTRAINT vertex_datasets_unknown_calendar
  CHECK (calendar IS NOT NULL OR
    (provider = 'ibkr' AND data_vintage_id IS NULL AND data_vintage_status = 'unavailable'));
