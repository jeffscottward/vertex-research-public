# Plays list

`/plays` shows the owner's potential option trades. It is a list of ideas only. The page has no order or approve button, and nothing on it places, stages or sizes an order. Only operators can open it (`plays.list`, `requireOperator`; others get 403), the same access as `/engines` and `/markets`.

## Where the data lives

Plays are rows in the Postgres `plays` table (migration `packages/db/migrations/0050_plays.sql`, rollback `packages/db/rollback/0050_plays.down.sql`). The API reads them through the plays repository (`packages/db/src/server/plays-repository.ts`, `context.repositories.plays`), newest `updated_at` first, at most 200 rows.

The API is read-only: `GET /plays` (`plays.list`). There is no API write endpoint. Rows are written server-side only, with the repository's `upsert` (operator scripts, seeds). Development and test seeds (`packages/db/src/seeds/plays.ts`, run by `db:seed`) add clearly fake plays (`ZZZT`, `QQQX`, expiry 2099). Never commit real plays.

## Columns

Rules are enforced by table CHECK constraints and by the repository before a write:

- `id`: text primary key.
- `ticker`: an upper-case symbol, 1 to 10 letters, digits, `.` or `-`.
- `structure`: 1 to 80 characters, for example `call debit spread`.
- `legs`: JSON array of 1 to 8 legs `{ side: buy|sell, right: call|put, strike > 0, expiry: YYYY-MM-DD, quantity: integer > 0 }`. Options only.
- `max_loss_usd`: numeric, required, greater than 0. Standing rule: defined risk only (at most 2% of NLV).
- `defined_risk`: boolean, default true, must be true.
- `thesis` (up to 2000), `trigger`, `exit_rule` (up to 500): required text.
- `status`: `idea`, `armed`, `taken` or `dropped`.
- `notes` (optional, up to 2000), `source_url` (optional, `https` only).
- `created_at`, `updated_at`: timestamps.

## API output

`plays.list` returns `{ plays: Play[] }`. Each play has `id`, `ticker`, `structure`, `legs`, `maxLossUsd` (number), `definedRisk` (always `true`), `thesis`, `trigger`, `exitRule`, `status`, `notes`, `sourceUrl`, `createdAt` and `updatedAt` (ISO strings). See `packages/api/src/contracts/plays.ts`. A storage failure is `STORAGE_ERROR` (503); the page shows it with **Retry now**.
