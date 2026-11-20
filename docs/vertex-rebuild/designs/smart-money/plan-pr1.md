# PR 1 plan: Congress trades (House and Senate PTRs)

Design: [design.md](design.md). This plan is the binding interface for PR 1.

## Outcome

`/congress-trades` and MCP tool `openbb_congress_trades` show House and Senate PTR transactions with ticker, holder, type, amount range, transaction date, filing date and reporting delay, read from Postgres. Unparsed filings are counted by reason and listed with source links. The in-app live House index reader is removed.

## 1. Rig jobs (`services/openbb`)

Jobs `congress-house` and `congress-senate` (module `vertex_openbb/jobs/congress.py`). Each prints, in this order, `congress_trades` then `congress_filings` (the tick posts tables in `OPENBB_JOB_TABLES` order, so trades are stored before the ledger claims them).

* **Window:** filings with filing date >= `--since` (default today minus 21 days) and <= `--until` (new optional CLI flag for every job, default today; used for chunked backfills because each run stops at 240 s).
* **House:** download `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip` for every year from the window start year to the window end year (zip cap 8 MiB, text cap 32 MiB), keep `FilingType == "P"` rows. Document ids starting with `2` are electronic: download `.../ptr-pdfs/<YEAR>/<docId>.pdf` (cap 10 MiB) and extract text with `pdfplumber` (`extract_text(layout=True)`, at most 40 pages). Other ids are scanned: ledger row `unparsed`, `scanned_image`, no download. Pacing 0.5 s between House requests.
* **Senate:** one `requests.Session`: GET `https://efdsearch.senate.gov/search/home/`, POST the statement-of-understanding form (`prohibition_agreement=1` with the CSRF token), then POST `/search/report/data/` (report type 11 = PTR, `submitted_start_date` = window start, 100 rows per page, all pages), then GET each `/search/view/ptr/<uuid>/` page. `/search/view/paper/<uuid>/` links are scanned: `unparsed`, `scanned_image`. Pacing 1 s between Senate requests.
* **Upstream access:** every network read goes through `Upstream.helper(key, func)` so tests replay recorded JSON: keys `congress:house-index:<year>` (returns the index text), `congress:house-pdf:<docId>` (returns the extracted text), `congress:senate-search:<since>` (returns the list of search rows), `congress:senate-ptr:<uuid>` (returns the transactions table HTML only). Pacing sleeps run inside `func`, so replay does not sleep.
* **User-Agent:** `vertex-research congress (personal research; <VERTEX_RESEARCH_CONTACT_EMAIL>)` from the same environment variable as the SEC jobs (`sec_guard.user_agent`); the job exits 2 when it is unset. The address is scrubbed from warnings.
* **Outcomes:** a failed index or search download fails that source (run `partial` or `failed`, existing rules). A failed PDF or page download adds a warning and emits no row for that filing, so a stored parsed filing is never overwritten by a download failure. Scanned or unparseable filings are ledger rows, not warnings.
* **Parser version:** `house.v1`, `senate.v1` (bump when parsing changes; stored per filing).
* **Rows:** see section 2. `rowNumber` starts at 1 in filing order.
* **Schedule (`infra/openbb/rig/vertex-openbb.steps`):**

  ```text
  congress-house        330  21600  2  ~/.local/bin/vertex-openbb-run congress-house
  congress-senate       330  21600  2  ~/.local/bin/vertex-openbb-run congress-senate
  ```

## 2. Batch tables (contract `packages/api/src/contracts/openbb.ts`, Python `rows.py`, Drizzle `schema/openbb.ts`)

`congress_trades` (DB `openbb_congress_trades`, key `chamber, doc_id, row_number`):

| field | batch rule | DB column |
| --- | --- | --- |
| chamber | enum `house`, `senate` | text CHECK |
| docId | House `^\d{1,12}$`, Senate `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` | text |
| rowNumber | count >= 1 | integer |
| member | label max 200 | text |
| filedOn | date | date |
| holder | enum nullable `self`, `spouse`, `joint`, `dependent` | text CHECK |
| ticker | nullable, existing `SYMBOL` rule | text |
| asset | text max 500 | text |
| assetType | label nullable max 40 | text |
| transactionType | enum `purchase`, `sale`, `sale_partial`, `exchange`, `other` | text CHECK |
| transactionDate | date nullable | date |
| amountLabel | label max 60 | text |
| amountLow | count nullable | bigint |
| amountHigh | count nullable | bigint |
| (DB only) first_seen_at | not sent; DB default `now()`, never updated on conflict | timestamptz |

`congress_filings` (DB `openbb_congress_filings`, key `chamber, doc_id`): `chamber`, `docId`, `member`, `stateDistrict` (label nullable max 10), `filedOn`, `url` (https), `status` (enum `parsed`, `unparsed`), `reason` (enum nullable `scanned_image`, `no_transactions`, `layout_unknown`; null exactly when parsed), `rowCount` (count; 0 when unparsed), `parserVersion` (label max 20), `amends` (boolean), DB-only `first_seen_at`.

Indexes: trades `(filed_on desc)`, `(ticker, filed_on desc)`; filings `(filed_on desc)`.

Mappings: House holder codes blank/SP/JT/DC; Senate Self/Spouse/Joint/Child. House types P/S/S (partial)/E; Senate Purchase / Sale (Full) / Sale (Partial) / Exchange; others `other`. Amount `Over $X` gives low X+1 and high null. Senate member = first name + last name. House member = prefix, first, last, suffix.

## 3. API

`congressTrades.feed` (GET `/congress-trades/feed`, operator only):

* **Input (strict):** `days` 7|30|90 (default 30, coerced), `ticker?` (uppercased, `SYMBOL` rule), `member?` (max 200, case-insensitive substring), `chamber?` (`house`|`senate`).
* **Output:** `trades[]` (all `congress_trades` fields plus `url`, `amends` and `delayDays` = filing date minus transaction date, null when no transaction date), `filings[]` (ledger fields), `members[]` (distinct, sorted), `unparsed` `{ total, byReason }`, `coverage[]` per chamber `{ chamber, lastRunAt, lastStatus, overdue }` (overdue = no `ok` or `partial` run in 30 h, from `openbb_ingest_runs`), `receivedAt` (server time), `source` (text).
* **Read rule:** window = filing date >= New York today minus `days`; trades only where `row_number <= filings.row_count` and the filing is `parsed`; sort filing date desc, chamber, doc id, row number; max 5,000 rows each.
* **Errors:** `FORBIDDEN`, `UNAUTHORIZED`, `UNAVAILABLE` (database not configured), `STORAGE_ERROR` (read failed), matching the other openbb procedures. `NOT_FOUND` and `UPSTREAM_ERROR` are removed.
* **Repository:** `congressFeed({ from, ticker?, member?, chamber? })` and `lastRunsFor(jobs)` (newest run and newest ok-or-partial run per job) in `packages/db/src/server/openbb.ts`.
* **MCP:** tool `openbb_congress_trades` in `packages/api/src/server/mcp.ts` (read-only, procedure `congressTrades/feed`, same inputs); presents at most 50 trades, unparsed counts, coverage and source; text fields capped at 300 characters. `congressTrades.feed` added to `AGENT_API_KEY_READ_PROCEDURES` in `operator-access.ts`. The `openbb_` prefix keeps it out of the in-app assistant.

## 4. Web (`apps/web/src/components/portal/`)

* `congress-trades-params.ts`: URL params `days`, `member`, `ticker`, `chamber`.
* `congress-trades-client.ts`: passes the new params.
* `congress-trades-workspace.tsx`: filter bar (window, chamber, ticker, member); a coverage line per chamber ("House: updated <time>" or "House: overdue since <time>"); a trades table (filed, member, chamber, holder, ticker, asset, type, amount, traded, delay "N d"); empty cells show "—"; an "Unparsed filings" section listing member, filed, reason and source link; amendment rows show an "Amendment" badge. Filters run on the server.

## 5. Files

Create: `services/openbb/vertex_openbb/jobs/congress.py`, `services/openbb/tests/test_congress.py`, `services/openbb/tests/fixtures/congress-house.json`, `services/openbb/tests/fixtures/congress-senate.json`, `services/openbb/tests/fixtures/upstream/congress-house.json`, `services/openbb/tests/fixtures/upstream/congress-senate.json` (synthetic fictional filings: this repository is public), `packages/api/src/fixtures/openbb/congress_trades.json`, `congress_filings.json`, `packages/db/migrations/0084_congress_trades.sql` and meta files (renumbered at merge if needed), `packages/db/rollback/0084_congress_trades.down.sql`, `docs/vertex-rebuild/designs/smart-money/{design.md,plan-pr1.md,before-after.svg}`.

Modify: `services/openbb/vertex_openbb/{cli.py,rows.py,context.py}`, `services/openbb/tests/{record.py,fixtures/invalid-rows.json,fixtures/valid-edge-rows.json}`, `services/research/tests/ci-suites-openbb.txt`, `packages/api/src/contracts/{openbb.ts,congress-trades.ts}`, `packages/api/src/server/{congress-trades.ts,mcp.ts,mcp.test.ts,operator-access.ts}`, `packages/api/src/congress-trades-feed.test.ts` (rewrite for the DB read), `packages/api/openapi.json` (`bun run openapi:generate`), `packages/db/src/schema/openbb.ts`, `packages/db/src/server/{openbb.ts,openbb.test.ts,index.ts}`, `tests/integration/database/{database.test.ts,openbb.test.ts}`, `apps/web/src/components/portal/congress-trades-*`, `apps/web/src/app/(portal)/congress-trades/page.tsx` (doc comment), `apps/web/src/lab/*/lenses*` and `tests/e2e/{account-admin-theme,day-trader-workflows}.spec.ts` (feed mocks), `infra/openbb/rig/vertex-openbb.steps`, `docs/vertex-rebuild/openbb.md`, `CHANGELOG.md`.

Delete: the in-app House index parser module `congress-trades.ts` at the root of `packages/api/src/` and its unit test.

## 6. Verification

* Python: `scripts/ci/research-python.sh` (suite list includes `../openbb/tests/test_congress.py`); `test_jobs.py` replays the new fixtures; parser cases: House row with wrapped amount, owner code, ticker and `[ST]`; row without ticker; `Over $50,000,000`; scanned id; no transactions; unknown layout; Senate table with Child holder and `--` ticker; amendment title; paper link.
* TypeScript: `bun run check`; `pnpm exec vitest run` on the changed test files; `bun run verify:coverage` keeps 100% on every non-baseline file.
* Integration: `tests/integration/database/openbb.test.ts` upsert twice and check `first_seen_at` is unchanged; read rule with a shrunk `row_count`.
* Hand check after the first live run: 10 random parsed House filings and 10 random parsed Senate filings (Python `random.sample` with seed 20261119 over the ledger); every row's ticker, type, transaction date and amount compared with the source document; any mismatch blocks the PR. Result table in the PR body.
* Live: after deploy, `vertex-openbb-run congress-house --since 2026-01-01 --until <chunk end>` in monthly chunks, then `congress-senate` the same way; then `/congress-trades?ticker=NVDA&days=90` and `openbb_congress_trades` return rows with `delayDays`; `openbb_status` shows both jobs.

## 7. Deploy and rollback

1. Pause `vertex-openbb.timer` on the rig.
2. Apply `0084_congress_trades.sql` on QuantVPS Postgres in one transaction, with the grant block of `0064_openbb_sources.sql`.
3. Deploy the app with `infra/quantvps/restart-when-idle.sh` (after 16:00 ET or before 08:30 ET).
4. `infra/openbb/rig/install.sh <sha>` on the rig.
5. Backfill (section 6), live check, resume the timer.

Rollback: reinstall the rig at the previous SHA, redeploy the previous app, apply `0084_congress_trades.down.sql` (refuses nothing; the tables hold only re-fetchable public data).
