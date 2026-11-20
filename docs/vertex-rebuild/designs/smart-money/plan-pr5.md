# PR 5 plan: 13F full books, quarter-over-quarter changes and FINRA short volume for all symbols

Design: [design.md](design.md), section "PR 5". This plan is the binding interface for PR 5. Research only: no order, arming, risk setting or trading-unit change, and no new paid source. Reviewed with the EGM consolidated review on 2026-11-20 (8 Goldfish reviewers); the resolved findings are applied below.

## Execution model

The rig host (`omarchy-rig`) runs `vertex-openbb.service`: a tick-runner starts each step of `infra/openbb/rig/vertex-openbb.steps` on its cadence. A step runs `scripts/openbb/tick.ts`, which starts the Python fetcher (`python -I -m vertex_openbb <job>`), reads its JSON document from stdout (cap 64 MiB, `scripts/openbb/spawn.ts`), posts each table in chunks of 2,000 rows to `openbb.ingest` on the QuantVPS app, then calls `openbb.recordRun`. The fetcher stops starting new work at its 240 s deadline. SEC steps also take a host-wide SEC lock (one SEC job at a time, at most 8 requests/s).

## Outcome

* `sec-13f` stores the full book of 23 tracked filers (no top-50 cut), records each stored filing in a new ledger `sec_13f_filings` (accession, filing date, row count), and downloads only filings that are not in the ledger.
* `sec-ftd` fills a new CUSIP-to-ticker map `cusip_symbols` from the SEC fails-to-deliver files; the stock page and `openbb_sec` match 13F rows to a symbol through it.
* The stock page's filings tab and MCP tool `openbb_sec` show `changes13f`: one entry per (filer, CUSIP, option type) between the filer's two newest full books of consecutive quarters (new, added, reduced, sold, unchanged), with both periods, shares, values, filing date and reporting delay (filing date minus quarter end).
* `finra-short-volume` keeps every symbol of the daily FINRA Reg SHO file that matches the FINRA symbol rule (section 1). On the 2026-11-18 file all 12,301 symbols match.

## Measurements (design question 2, 2026-11-20)

`<infoTable>` entries of each filer's newest 13F-HR (period 2026-09-30), from EDGAR:

| filer | entries | filer | entries |
| --- | --- | --- | --- |
| Citadel Advisors | 16,527 | Susquehanna | 15,637 |
| Jane Street | 14,764 | Wellington Management | 7,435 |
| D. E. Shaw | 6,478 | Millennium Management | 6,103 |
| Two Sigma | 4,830 | T. Rowe Price Associates | 4,704 |
| Point72 | 3,856 | Renaissance Technologies | 3,151 |
| Bridgewater | 974 | Capital World Investors | 648 |
| Capital International Investors | 491 | Capital Research Global Investors | 424 |
| Coatue | 263 | Dodge & Cox | 225 |
| Berkshire Hathaway | 89 | Viking Global | 79 |
| Tiger Global | 45 | Elliott Investment Management | 39 |
| Lone Pine | 31 | Baupost | 21 |
| Pershing Square | 11 | | |

* Sum: about 86,800 entries per quarter, so at most about 0.35M stored rows per year (rows are aggregated per CUSIP and option type, which can only lower the count). This is below the design estimate of 0.6-2M rows; the design's storage line is updated.
* The job's parser (OpenBB `parse_13f_hr`) reads Susquehanna (13,390 aggregated rows), Viking (79) and Citadel (13,843) newest filings; checked 2026-11-20.
* FINRA file of 2026-11-18: 12,301 symbols (546 KB), about 3.1M rows per year. 435 symbols use FINRA suffixes (lowercase `p` for preferred, `/` for class, for example `ABRpD`, `AGM/A`).

## 1. Rig jobs (`services/openbb`)

### `sec-13f` (`vertex_openbb/jobs/sec.py`)

* **Filers:** `FILERS` in `sec.py` (a constant; its comment records the check date). The 6 existing filers (Berkshire Hathaway, Bridgewater, Renaissance, Citadel Advisors, Susquehanna, Jane Street) stay, including the three market makers, because the owner chose them before PR 5 and removing them would drop stored history. Added (CIK in parentheses): Capital World Investors (1422849), Capital International Investors (1562230), Capital Research Global Investors (1422848), Wellington Management Group (902219), T. Rowe Price Associates (80255), Millennium Management (1273087), D. E. Shaw & Co. (1009207), Two Sigma Investments (1179392), Point72 Asset Management (1603466), Pershing Square Capital Management (1336528), Tiger Global Management (1167483), Coatue Management (1135730), Viking Global Investors (1103804), Elliott Investment Management (1791786), Baupost Group (1061768), Dodge & Cox (200217), Lone Pine Capital (1061165).
* **Selection rule:** large 13F filers with an active (stock-picking or multi-manager) book, chosen by hand; index funds and custodians (Vanguard, BlackRock, State Street, FMR) and AQR (25,388 entries, above a per-run budget on its own) are left out. CIKs and names checked against `data.sec.gov/submissions` on 2026-11-20.
* **No top-50 cut:** `TOP_HOLDINGS` and the cut are removed. Every aggregated (CUSIP, option type) row of a book is kept.
* **Accession:** the listing item's `accession_number` (must match `^\d{10}-\d{2}-\d{6}$`), else the file name of `complete_submission_url` (`/(\d{10}-\d{2}-\d{6})\.txt$`). Rows get `accessionNumber` and `filedOn`.
* **Skip stored filings:** the tick reads the ledger accessions through the new procedure `openbb.sec13fAccessions` and passes them as `--skip-accessions A,B,...` (new CLI flag, only for `sec-13f`; other jobs exit 2). The job does not download a filing whose accession is in the list. If the read fails, the tick records a failed run and does not start the fetcher.
* **Periods:** unchanged rule: the filer's newest N filed 13F-HR periods, N = number of quarter ends in [today - 183 days, today] (2, sometimes 3); `--since` raises N.
* **Row budget:** a run starts a filing only while its rows plus the largest measured book (17,000) stay within 40,000 (at most 20 ingest chunks, so posting fits the 600 s step after the 240 s deadline); the first filing of a run always starts. It warns `sec 13f: row budget of 40000 rows reached; N filings left for the next run`. The row budget or the deadline ends a run early; the ledger lets the next run continue with the remaining filings.
* **Ledger row:** each parsed filing with at least one row and an accession emits one `sec_13f_filings` row; its `rows` counts the book rows that pass the row schema (the fetcher drops the others), so the completeness check can pass. A run where every filing is stored already writes no rows and no "every table is empty" warning. A filing with 0 rows warns `... 0 rows from the information table; no ledger row`; a filing without accession warns `... no accession or filing date; no ledger row`. Both are retried by the next run.
* **Amendments (unchanged):** the original 13F-HR is used; a 13F-HR/A is noted in a warning.
* **Timeout:** the step stays at 600 s.

### CUSIP-to-ticker map (`sec-ftd` job)

* **Free source chosen:** the SEC fails-to-deliver files (CUSIP and symbol per row). The `sec-ftd` job already downloads them. Rejected: OpenFIGI (a new external service and key), the SEC Official List of Section 13(f) Securities (no tickers).
* `_ftd_file` returns every row of the file. `sec_ftd` rows stay filtered to the job universe (unchanged). `cusip_symbols` gets one row per (CUSIP, symbol) across the loaded files with `lastSeen` = newest settlement date of that pair.
* Migration 0086 seeds the map from `openbb_sec_ftd`. The deploy runs `sec-ftd --since <today - 2 years>` once so the map covers two years of files.
* **Known limit:** a CUSIP that never had a fail has no map entry. Its holdings still match when the fetcher's verified universe map names the symbol (`holdings.symbol`).
* The upstream call key of the FTD file (record and replay key in `services/openbb/tests/fixtures/upstream/sec-ftd.json`) drops the symbol list: `sec:ftd:<key>`.

### `finra-short-volume` (`vertex_openbb/jobs/finra.py`)

* `parse_regsho` keeps every row of the file. Symbols must match the FINRA symbol rule `^[A-Za-z0-9./^=-]{1,16}$`; a row that fails it is skipped and counted in one warning.
* The window changes from 10 to 5 calendar days (3-4 weekdays, about 37-50k rows and 4-5 MB per run), because each run now writes every symbol and the step runs every 3 hours. Older days are fetched with `--since`.
* `--symbols` still filters a manual run.

## 2. Batch tables (contract `packages/api/src/contracts/openbb.ts`, Python `rows.py`, Drizzle `packages/db/src/schema/openbb.ts`)

`sec_13f_holdings` (key unchanged `filer_cik, period_ending, cusip, option_type`), two new nullable fields: `accessionNumber` (accession rule) and `filedOn` (date). Rows stored before PR 5 have null.

New `sec_13f_filings` (DB `openbb_sec_13f_filings`, key `accession_number`): `accessionNumber`, `filerCik`, `filerName` (label max 200), `periodEnding`, `filedOn`, `rows` (count). Index `(filer_cik, period_ending)` (not unique: a later original for the same period is stored and ignored by the read rule).

**Ledger completeness check:** `openbb.ingest` stores a `sec_13f_filings` row only when the stored `openbb_sec_13f_holdings` rows with that accession equal its `rows`. A filing with a failed holdings chunk stays out of the ledger and is fetched again; other filings of the same run are not affected.

New `cusip_symbols` (DB `openbb_cusip_symbols`, key `cusip, symbol`): `cusip`, `symbol` (general symbol rule), `lastSeen`. The upsert keeps the greater `lastSeen`. Job `sec-ftd` writes `sec_ftd` and `cusip_symbols`.

`short_volume_daily`: the `symbol` rule becomes the FINRA symbol rule (contract, `rows.py` and the DB CHECK `openbb_short_volume_daily_check`). Read paths that take a symbol from the user keep the general rule, so suffix rows are stored for market-wide lists and are not reachable by symbol lookup yet.

Migration `0086_sec_13f_full_books.sql` adds the columns, the two tables, the CUSIP index on holdings, the CHECK change, the map seed and the 0064-style grants. Rollback `packages/db/rollback/0086_sec_13f_full_books.down.sql` drops the tables and columns, deletes short-volume rows that fail the old CHECK and restores it (public data the jobs fetch again).

## 3. API

* `openbb.sec13fAccessions` (scheduler; needs the agent write key like `openbb.ingest`): output `{ accessions: string[] }`, the newest 5,000 by filing date (23 filers x 4 quarters x 50 years would still fit).
* `openbb.sec` output adds `changes13f`:
  * One entry per (filer CIK, CUSIP, option type) in the filer's two newest ledger books. For each period the earliest-filed ledger row is the book (the same original 13F-HR that `pick_filings` picks).
  * A filer is left out unless the older book is exactly the quarter before the newer one (one book only, or a missing quarter, gives no entries).
  * `change`: `new` (no previous row; `previousShares`, `previousValue` null), `sold` (no current row; `shares`, `value` null), else compare shares when both sides have shares, otherwise value: `added`, `reduced` or `unchanged` (equal).
  * Fields: `filerCik`, `filerName`, `cusip`, `issuer`, `optionType`, `period`, `previousPeriod`, `shares`, `previousShares`, `value`, `previousValue`, `change`, `filedOn`, `accessionNumber`, `delayDays`.
  * Sort: larger of value and previous value, descending; then filer CIK, CUSIP, option type. No cap (a symbol has at most 23 filers x a few CUSIPs x 3 option types).
  * Known limit: a stock split between the two quarters shows as `added` by shares; both shares and values are shown so the reader can see it.
* Symbol to CUSIPs: `cusip_symbols` entries for the symbol plus the CUSIPs of its FTD rows; holdings also match by their own `symbol`.
* `holdings13f` keeps its rule (newest period per filer in the holdings table) and gains the two new fields.
* MCP `openbb_sec` returns `changes13f`; its description names the source (SEC EDGAR 13F-HR), the 45-day filing deadline, `delayDays`, and that issuer and filer names are source text. Names are capped at 200 characters by the row schema.

## 4. Web (`apps/web/src/features/openbb/`)

The filings tab adds a block "13F quarter-over-quarter change" after "Tracked 13F holders": one table row per entry with filer, change, option, shares now / before, value now / before, periods, filed on and delay in days. Empty text: "No tracked 13F filer held this symbol in its last two consecutive full quarterly reports." Caption: "Source: SEC Form 13F-HR, due 45 days after quarter end. Delay is the filing date minus the quarter end."

## 5. Files

* `services/openbb/vertex_openbb/jobs/sec.py`, `jobs/finra.py`, `rows.py`, `cli.py`, `context.py`; tests and fixtures under `services/openbb/tests/` (re-keyed `upstream/sec-ftd.json`, regenerated output fixtures, row corpora).
* `packages/api/src/contracts/openbb.ts`, `packages/api/src/server/openbb.ts`, `packages/api/src/server/mcp.ts`, `packages/api/openapi.json`, `packages/api/src/fixtures/openbb/`.
* `packages/db/src/schema/openbb.ts`, `packages/db/src/server/openbb.ts`, `packages/db/migrations/0086_sec_13f_full_books.sql` and snapshot, `packages/db/rollback/0086_sec_13f_full_books.down.sql`.
* `scripts/openbb/tick.ts`.
* `apps/web/src/features/openbb/openbb-panels.tsx`.
* `docs/vertex-rebuild/openbb.md`, `docs/vertex-rebuild/designs/smart-money/design.md` (storage figure).

## 6. Verification

* Python: `pytest services/openbb`: full books with ledger rows, skip list, row budget, 0-row and no-accession filings, the CUSIP map, FINRA suffix symbols and the symbol filter.
* TypeScript unit tests: change rule (new, added, reduced, sold, unchanged, single book, missing quarter, earliest original per period, sort), the ledger completeness check, `sec13fAccessions`, tick flag passing and the failed read, the 0086 migration text, the repository reads; 100% coverage on changed files.
* Integration (Postgres): migration 0086 applies, upserts and reads of the new tables, and rollback.
* Live checks after deploy (pass criteria):
  * `openbb_sec_13f_filings`: at least one row for each of the 23 filers once the backfill warning is gone.
  * `openbb_sec_13f_holdings` rows of period 2026-09-30 per filer: at most the entry count above and more than 50 for each filer with more than 50 entries.
  * `openbb_short_volume_daily`: more than 10,000 symbols for the newest date.
  * `openbb_cusip_symbols`: more than 10,000 rows.
  * Stock page filings tab screenshot in dark mode with the change block; MCP `openbb_sec` answer for one symbol with `changes13f`.

## 7. Deploy and rollback

Deploy (after 16:00 ET or before 08:30 ET):

1. Pause `vertex-openbb.timer` on the rig (the old fetcher would otherwise get the new tick's `--skip-accessions` flag, or post rows the old schema refuses).
2. Apply migration 0086.
3. Deploy the app with `infra/quantvps/restart-when-idle.sh`.
4. Install the rig at the same SHA (`infra/openbb/rig/install.sh <sha>`).
5. Run `sec-ftd --since <today - 2 years>`, then `finra-short-volume`, then `sec-13f` until it no longer warns `row budget ... reached`.
6. Run the live checks in section 6.
7. Resume the timer.

Rollback: pause the timer, install the rig at the previous SHA, deploy the previous app, apply `0086_sec_13f_full_books.down.sql`, resume the timer.
