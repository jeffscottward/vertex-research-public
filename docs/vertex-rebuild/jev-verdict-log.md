# JEV verdict log

The JEV verdict log keeps every successful JEV verdict in Postgres, so the forecast scorecard (`packages/api/src/forecast-scorecard.ts`) can score real verdicts. Before this log, verdicts lived only in the memory of the server process and were lost on restart.

Research only. The final order gate never reads this table. Nothing here places, changes or cancels an order.

## Parts

|Part|File|
|---|---|
|Table `jev_verdict_log`|`packages/db/src/schema/jev-verdict-log.ts`, migration `packages/db/migrations/0082_jev_verdict_log.sql`|
|Repository (`append`, `listForecasts`)|`packages/db/src/server/jev-verdict-log.ts`, `Repositories.jevVerdictLog`|
|Write after a refresh|`refreshJevVerdict` and `verdictLogWriter` in `packages/api/src/server/jev-verdict.ts`|
|Guarded rollback|`packages/db/rollback/0082_jev_verdict_log.down.sql`|

## When a row is written

1. `jevVerdict.refresh` calls JEV and parses the reply.
2. The in-memory store gets the verdict (`store.succeed`). From this point the order gate can read it.
3. Then the log write starts. With a request scheduler (`scheduleDatabaseTask`) the response does not wait for it. Without a scheduler the refresh waits for the write, but the verdict is already in the store.
4. A failed write is ignored. It never changes the verdict, the refresh result or the throttle.

Failed refreshes (market data, JEV error, unreadable reply) write no row. Only a refresh writes rows; there is no scheduled refresh, so the log holds verdicts only for symbols that an operator refreshed.

## Row and forecast record

Each row holds the source (`jev-verdict`), the source version (null for now), symbol, `data_as_of` (date of the last bar JEV saw), `decided_at`, model, JEV's own choice, the stance, the three probabilities and `logged_at`.

`listForecasts()` returns the rows, oldest decision first, in the forecast record shape (schema version 1) of the scorecard. The scorecard parser accepts them without a change.

## Duplicates

The log keeps every verdict, also several for the same symbol and data date. It does not remove duplicates. The scorecard decides: the record with the earliest `decidedAt` counts, and the others get the status `DUPLICATE`.

## Append-only

The repository has only `append` and `listForecasts`. The migration grants the app role `vertex_research` only `SELECT` and `INSERT` on the table, so the app cannot update or delete rows. On production the migrations run as `vertex_research`, so that role owns the table and the grant does not limit it; migration 0104 adds triggers that reject `UPDATE`, `DELETE` and `TRUNCATE` for every role, the owner included.

## Rollback

The rollback is "deploy the previous app"; the previous app ignores the table. The down file drops the table and loses every logged verdict, so it stops while the table holds rows. Export first, then confirm in the same session:

```sql
\copy (SELECT * FROM jev_verdict_log ORDER BY decided_at, id) TO 'jev_verdict_log.csv' CSV HEADER
SET vertex.jev_verdict_log_exported = 'yes';
```

## Limits

- Logged verdicts lean toward symbols an operator looked at. A scheduled refresh would fix this; it is an owner decision and not part of this change.
- A first real scorecard result needs many months of logged dates (see the scorecard docs).
