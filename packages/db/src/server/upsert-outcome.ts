// What: SQL expression that tells, in the RETURNING list of an upsert, whether a row was inserted.
// Used by: packages/db/src/server/research-studies.ts (write) and
// packages/db/src/server/academy-content.ts (writeCourse).
// See: tests/integration/database/research-studies.test.ts and
// tests/integration/database/academy-content.test.ts, which check both outcomes on real Postgres.
import { sql } from "drizzle-orm";

/**
 * Only for the RETURNING list of `INSERT ... ON CONFLICT DO UPDATE` on an ordinary (not
 * partitioned) table: true for a row that the statement inserted, false for a row that it updated.
 * `xmax` is the system column with the id of the transaction that deleted or locked the row
 * version. It is 0 on a newly inserted row. ON CONFLICT DO UPDATE locks the existing row before it
 * writes the new version, and Postgres carries that lock mark over to the new version, so `xmax`
 * is not 0. No clocks are used: the result is also right when both writes run in one transaction
 * or in one millisecond. The Postgres manual does not promise this behavior. The integration tests
 * named above fail when they run on a Postgres version that changes it; CI runs them on the version
 * pinned in scripts/ci/rig-postgres.sh (the same as infra/docker/postgres.compose.yml). Each new use
 * needs its own test of both outcomes on real Postgres.
 */
export const rowWasInserted = sql<boolean>`(xmax = 0)`;
