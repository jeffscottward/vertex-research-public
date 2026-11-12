# Leveraged ETF universe

Status: research only. A row in this table does not authorize a trade. Nothing here places, changes or cancels an order.

The table `leveraged_etf_universe` holds the US-listed leveraged and inverse funds (ETFs and ETNs), one row per fund. Each row has the fund's option-liquidity facts and one option gate label. The label answers one question for the 24 to 48 hour holding window: are the fund's options liquid enough to trade?

The data lives in Postgres, not in a JSON file (AGENTS.md rule 13). A Python fetcher prints one universe document; the import CLI checks it and writes it through a repository.

## Parts

| Part | Path |
| --- | --- |
| Table and its checks | `packages/db/src/schema/leveraged-etf.ts`, migration `0068_leveraged_etf_universe` |
| Repository (`replaceUniverse`) | `packages/db/src/server/leveraged-etf-universe.ts`, wired as `leveragedEtfUniverse` in `createRepositories` |
| Document schema (Zod) | `scripts/leveraged-etf-universe/document.ts` |
| Import CLI | `scripts/leveraged-etf-universe/import.ts`, entry `scripts/vertex-leveraged-etf-universe-import.ts` |
| Fetcher (Python, the only part with network I/O) | `research/backtests/leveraged-etf/universe.py` |

No oRPC route and no page read the table yet. The document schema is in `scripts/` because the import CLI is its only reader; a schema moves to `packages/api/src/contracts/` when a route takes or returns the document.

## Sources

Free public data only. No key and no paid feed.

| Fact | Source |
| --- | --- |
| Which funds exist: symbol, listed name, ETF or ETN, listing exchange | Nasdaq Trader symbol directory (`https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt`) |
| Leverage and unleveraged reference | Read from the listed name by the fetcher (see [Build a universe](#build-a-universe)) |
| Option chain: spot, expiries, open interest, bid and ask | Cboe delayed quotes (`https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json`). The feed is delayed by 15 minutes: a chain file holds the market of 15 minutes before its timestamp |

## Columns

The table is flat. Every row repeats the gate constants and the `generatedAt` of the document that wrote it, so one row can be read without a second table.

| Column | Type | Meaning |
| --- | --- | --- |
| `symbol` | text, primary key | Fund ticker, `^[A-Z][A-Z0-9.]{0,9}$` |
| `name` | text | Listed name, 1 to 200 characters |
| `product_type` | text | `etf` or `etn` |
| `leverage` | numeric(4,2) | Signed target multiple, for example `3`, `-2`, `1.25`, `1.2`. Never `0`, never `1`, from `-5` to `5`. The reset period is not stored (see below) |
| `underlying` | text, nullable | Ticker of the unleveraged reference (QQQ for TQQQ, the stock for a single-stock fund). Null means the fund is not mapped |
| `listing_exchange` | text | Listing exchange, 1 to 20 characters |
| `options_listed` | boolean | False means the fund has no option facts: Cboe has no chain for the fund, or the chain lists no standard contract that expires on or after the quote day. Then every option column below is null and `nearest_expiries` is `[]` |
| `quoted_at` | timestamptz, nullable | Timestamp of the option chain: the time when Cboe wrote the chain file. The quotes in the file are 15 minutes older |
| `quote_session` | text, nullable | `regular` = the quotes of the chain are from the regular session of the day of the document (exact rule in [Option gate](#option-gate)). `closed` = they are not |
| `spot` | numeric, nullable | Fund price in the chain: the current price, or the last close when the chain has no current price |
| `nearest_expiries` | jsonb array | The 1 to 4 nearest expiry dates (ISO), ascending. Empty when there are no listed options |
| `window_expiry` | date, nullable | Nearest expiry that is `gate_min_window_days` to `gate_max_window_days` calendar days after the quote day. Null means no expiry is in the window |
| `total_open_interest` | integer, nullable | Open interest of all expiries, calls and puts |
| `band_open_interest` | integer, nullable | Open interest of `window_expiry`, strikes within `gate_band_pct` percent of spot, calls and puts. Null exactly when `window_expiry` is null |
| `half_spread_pct` | numeric, nullable | For `window_expiry`: median of `(ask - bid) / 2 / mid * 100` over the calls and puts of the 4 strikes nearest spot that have `bid > 0` and `ask > bid` (at most 8 contracts). Null means no such quote. The count of these quotes is in the document (`twoSidedQuotes`); the table has no column for it |
| `option_gate` | text | `pass`, `fail` or `spread-not-measured` (see below) |
| `option_gate_reasons` | jsonb array | Why the label is not `pass` (see below). Empty for `pass`. The table does not check the names of the reasons |
| `gate_version` | integer | Version of the gate constants. It also fixes the one constant that has no column: the minimum count of two-sided quotes (version 1: 3) |
| `gate_min_band_open_interest` | integer | Minimum `band_open_interest` (version 1: 1000 contracts) |
| `gate_max_half_spread_pct` | numeric | Maximum `half_spread_pct` (version 1: 4) |
| `gate_min_window_days`, `gate_max_window_days` | integer | The expiry window in calendar days (version 1: 5 to 21) |
| `gate_band_pct` | numeric | Strike band around spot in percent (version 1: 10) |
| `generated_at` | timestamptz | `generatedAt` of the document that wrote the row. All rows have the same value after an import |
| `updated_at` | timestamptz | Time of the import transaction that wrote the row |

There is one index, on `option_gate`.

Reset period: the table has no reset-period column. `leverage` is the target multiple over the reset period of the fund. Most funds reset every day. The 23 Roundhill WeeklyPay funds (`leverage` `1.2`) reset every week: the target is 1.2 times the return of the reference over a calendar week. Some notes reset every month or every quarter. Do not read `leverage` as a daily multiple without a check of the fund.

Three CHECK constraints keep the cheap rules in the database:

- `leveraged_etf_universe_fund_check`: symbol pattern, text lengths, `product_type`, and the leverage range without 0 and 1.
- `leveraged_etf_universe_options_check`: `options_listed` false means no option facts; `options_listed` true means a quote time, a session, a positive spot, a total open interest and 1 to 4 expiries; `band_open_interest` is null exactly when `window_expiry` is null; `half_spread_pct` needs a `window_expiry`.
- `leveraged_etf_universe_gate_check`: valid gate constants; `pass` means listed options, session `regular` and no reasons; `spread-not-measured` means session `closed` and the one reason `market-closed-at-quote`; `fail` means at least one reason.

The database stores the label and the reasons. It does not recompute them. The checks do not read the names of the reasons and do not compare the facts with the thresholds: a row with `option_gate` `pass` and with no `window_expiry`, with `band_open_interest` below the minimum or with `half_spread_pct` above the maximum passes all three checks. The import CLI applies the full rule before it writes (next sections), so every row that the CLI writes follows the rule. No database change was made for the rules that came after migration 0068.

## Option gate

The gate is a function of the option facts, the gate constants and `generatedAt` of the document.

### Session

`quote_session` is `regular` when both conditions are true. Else it is `closed`.

1. The quotes are from the regular session. The time of the quotes is `quoted_at` minus 15 minutes (the Cboe delay). It must be on a NYSE trading day, from 09:45 to the close in New York. The close is 16:00. On a half day it is 13:00: 3 July and 24 December when they are a Monday to Thursday, and the Friday after Thanksgiving.
2. `quoted_at` and `generatedAt` are on the same New York calendar day.

The clock and the exchange calendar decide. The last trade of the fund does not: a fund that did not trade in the last minutes is still judged by its option quotes. A run after the close gives `regular` for a fund whose chain Cboe last wrote during the session of that day.

Limits of the calendar: it knows the regular NYSE holidays and the three half-day rules. It does not know a closure that is not in these rules, and it does not know a trading halt. On such a day a chain can be `regular` with quotes that do not change.

Evidence for the 15 minutes: in the 723 chain files of the run of 2026-11-12, no trade of a fund or of an option is newer than the file timestamp minus 15.0 minutes.

### Reasons

Fail reasons. Each of the first three reasons is the only reason when it applies. Of the other reasons, every one that applies is listed:

| Reason | Exact condition |
| --- | --- |
| `no-listed-options` | Cboe has no chain file for the fund |
| `no-standard-contract` | Cboe has a chain file for the fund, and it lists no standard contract (OCC root = fund symbol) that expires on or after the quote day |
| `stale-chain` | `quoted_at` is more than 4 New York calendar days before `generatedAt`. The other facts of such a chain are not judged |
| `no-window-expiry` | `window_expiry` is null |
| `open-interest-below-minimum` | `band_open_interest` is less than `gate_min_band_open_interest` |
| `no-two-sided-quote` | Session is `regular` and there is no two-sided quote (`half_spread_pct` is null). A fund with no window expiry in the regular session has this reason too |
| `too-few-two-sided-quotes` | Session is `regular` and there are 1 or 2 two-sided quotes (fewer than the minimum of 3). The half spread of so few quotes is not judged |
| `spread-above-maximum` | Session is `regular`, there are 3 or more two-sided quotes, and `half_spread_pct` is greater than `gate_max_half_spread_pct` |

Labels:

| `option_gate` | Exact meaning | What it means for the 24 to 48 hour window |
| --- | --- | --- |
| `fail` | At least one fail reason applies | The options are too thin, or the fund has no current option chain. The owner-approved share fallback applies, inside the 2% max-loss gate. That fallback needs an engine policy change that is not part of this work |
| `spread-not-measured` | No fail reason applies and the session is `closed`. The only reason is `market-closed-at-quote` | Not decided. The quotes are not from the regular session of the day of the document: they are stale and wide, or they are of an earlier day. The chain cannot pass and it does not prove a fail. Read a chain during the session to decide |
| `pass` | No fail reason applies and the session is `regular`. No reasons | Trade options on the fund. A `pass` always has quotes of the regular session of the New York day of `generatedAt` |

The three spread reasons are judged only in the regular session. So a `fail` from a closed-session chain never has a spread reason, and a fund that is `spread-not-measured` can become `fail` when its spread is measured.

Why these thresholds: 1000 contracts in the band keeps an order of 2% of the account small against open interest. A 4% half spread is the widest cost class that the qc-ports option model already charges (SLV, USO). The median of 1 or 2 quotes is one quote or the mean of two, so one tight quote among 8 contracts must not pass: the rule needs 3. A chain of Thursday is 4 days old on the Monday after a Friday holiday; an older chain is not the current chain of the fund.

## Universe document

One JSON document, schema `leveraged-etf-universe-v1`: `schema`, `generatedAt` (UTC, the time after the fetcher read the last chain), `gate` (the constants) and `funds` (1 to 2000 funds, sorted by symbol, no symbol twice). A fund has the columns above in camelCase; its option facts are in `options`, which is null exactly when `optionsListed` is false.

Two values are in the document and not in the table: `gate.minTwoSidedQuotes` (the minimum count of two-sided quotes; version 1: 3) and `options.twoSidedQuotes` (the count of two-sided quotes behind `halfSpreadPct`; null exactly when `windowExpiry` is null).

The gate constants belong to `gate.version`. `LEVERAGED_ETF_GATE_CONSTANTS` in `scripts/leveraged-etf-universe/document.ts` holds the constants of every version, and `GATE` in `services/research/strategies/leveraged_etf/liquidity.py` holds the constants that the fetcher uses. A changed constant needs a new version in both files. Version 1: window 5 to 21 days, band 10%, minimum band open interest 1000, maximum half spread 4%, minimum 3 two-sided quotes.

`LeveragedEtfUniverseDocumentSchema` (`scripts/leveraged-etf-universe/document.ts`) refuses a document when:

- a key is unknown, a value has the wrong type or a value is out of range;
- a datetime is not UTC (it must end with `Z` or `+00:00`);
- `gate.version` is not known, or a constant in `gate` differs from the constant of that version;
- `leverage` has more than 2 decimals (the column would round it without notice);
- the funds are not sorted by symbol or a symbol repeats;
- `options` and `optionsListed` do not agree;
- `nearestExpiries` is not ascending or holds a date before the quote day;
- `windowExpiry` is not in the gate window after the quote day, or `bandOpenInterest`, `halfSpreadPct` and `twoSidedQuotes` do not follow `windowExpiry`, or `halfSpreadPct` is null and `twoSidedQuotes` is not 0 (or the reverse);
- `quotedAt` is more than 5 minutes after `generatedAt` (the two clocks may differ by 5 minutes);
- `session` is `regular` and `quotedAt` is not on the New York day of `generatedAt`;
- `session` is `regular` and the time of the quotes (`quotedAt` minus the 15 minutes of the Cboe delay) is not from Monday to Friday, 09:45 to before 16:00 on the New York clock (summer time included);
- `windowExpiry` is before the New York day of `generatedAt` for a fund that is not `fail`;
- a fund without option facts is not `fail` with exactly one of the reasons `no-listed-options` and `no-standard-contract` (only the fetcher knows which of the two is true);
- `optionGate` or `optionGateReasons` is not what the gate rule gives for the fund's `options`, the constants of the gate version and `generatedAt`. The reasons may be in any order.

The last rule uses the constants of the version, not the numbers in the document. So the schema refuses a `pass` with no `windowExpiry`, with band open interest below the minimum, with a half spread above the maximum, with fewer than 3 two-sided quotes or with a chain of another day than `generatedAt`. It also refuses any label other than `fail` with `stale-chain` for a chain of more than 4 New York days before `generatedAt`.

Quote day: the document does not name a time zone for it. The fetcher uses the New York day of `quotedAt`. The import accepts a rule about the quote day when it holds for the New York day or for the UTC day of `quotedAt`; the two days differ only for a chain read in the New York evening. The rules about `generatedAt` use New York days only.

Holidays and half days stay with the fetcher. The import has no exchange calendar: for `session` it checks the day of `generatedAt`, the weekday and the hours 09:45 to 16:00. It accepts `regular` for a chain of a NYSE holiday that is a weekday and for a chain between 13:00 and 16:00 on a half day. The fetcher never writes `regular` for these chains (`session_of` in `liquidity.py` has the calendar). The import also accepts `closed` for a chain inside the session hours. With `closed` the spread is not judged. So such a document has `spread-not-measured` for a fund that the rule for `regular` labels `pass`, and also for a fund that it labels `fail` with a spread reason as the only reason. The fetcher never writes `closed` for such a chain.

The import does not check that `windowExpiry` is the nearest expiry in the window, or that the open interest and spread values are right: it has no chain. Those are the fetcher's job.

## Build a universe

```sh
python3 research/backtests/leveraged-etf/universe.py --save-chains <folder> > universe.json
```

The fetcher needs the Python standard library only. The document goes to stdout and a summary to stderr. Exit code `1` means that there is no document: the fetcher never prints a partial one.

Symbol directory:

- The run stops when the directory is not whole: the last line must be the `File Creation Time` line, and there must be at least 10,000 rows (`MIN_LISTING_ROWS`; the directory of 2026-11-11 has 13,282). The import deletes every fund that is not in the document, so half a directory would delete half the table.
- The run stops before any chain is read when a fund of the directory has a value that the document cannot hold: a symbol outside `^[A-Z][A-Z0-9.]{0,9}$`, a name of more than 200 characters or a multiple outside the range.
- The multiple and the unleveraged reference come from the listed name. The Roundhill WeeklyPay funds have no multiple in the name; one family rule gives them `1.2`.
- A fund that is leveraged by its name and has no single multiple of one reference is not in the document. The summary names it with the reason (`unclassified names`). The reasons: no rule reads a multiple; the fund stacks two exposures (`100% TSLA AND 100% SPCX`, the Return Stacked and STKd funds); the fund holds WeeklyPay funds (`TOPW`).
- Limit: the rules read the name only. A fund that uses leverage and does not say so in its name (for example a capital-efficient or risk-parity fund) is not in the document and not in that report.

Option chains:

- The fetcher keeps apart two cases. "No listed options" is a row: Cboe answers HTTP 403 `AccessDenied` for the symbol while the chain of SPY can be read. "The chain could not be read" ends the run with no document: a network error after 3 attempts, a chain that is not JSON, the chain of another symbol, a chain without a price, a standard contract with a negative open interest, or a number that is not finite. There is no option to leave such a fund out.
- The first fund that fails stops all workers, so no more requests go out for a document that is lost. A chain that cannot be measured counts at the moment it is read, not after all chains were fetched.
- After an HTTP 429 every worker waits, not only the worker that got it.
- `--save-chains <folder>` keeps the raw chain of every fund and of every unleveraged reference. A complete run also writes two files there: `_listing.txt`, the symbol directory that the run read, and `_run.json`, the record of the run (`generatedAt`, the funds of the run, the funds that had no chain file and the name of the listing file). So the folder alone is enough to measure the run again. Use a new folder for each run: `--save-chains` refuses a folder that already holds `_run.json` (exit `2`, before any request). A run that fails there would leave the record of the old run next to newer chain files.
- `--chains-from <folder>` measures a saved run again with no network. It reads `_run.json`, the listing and the chain files, and it writes nothing in the folder. `generatedAt` is the one of the saved run. Without `--listing` it reads the listing that the run kept in the folder: only the file `_listing.txt`, as a regular file and not through a symbolic link. The folder of a run that kept no listing needs `--listing <file>` (the runs of 2026-11-12 kept none); with `--listing`, that file is read and not the one in the folder. One rule for the funds: the document of a saved run holds exactly the funds of that run. The run ends with exit `1` and no document, and names the funds on stderr, when the listing in use has a fund whose chain the saved run did not request, or lacks a fund of the saved run. Both documents would not be the universe of that run, and the import deletes every fund that is not in the document. No option accepts such a document. This happens when the name rules changed since the saved run, or when `--listing` names the directory of another day. A fund of the saved run whose chain file is missing or cannot be measured ends the run too.

## Store a universe

```sh
python3 research/backtests/leveraged-etf/universe.py > universe.json
bun run vertex:leveraged-etf-universe:import --dry-run < universe.json
DATABASE_URL=postgres://... bun run vertex:leveraged-etf-universe:import < universe.json
```

- stdin holds one JSON document, at most 2 MiB (2097152 bytes).
- `--dry-run` checks the document and prints the counts. It needs no database and no `DATABASE_URL`.
- Without `--dry-run`, `DATABASE_URL` is required. The script does not read `.env` (`bun --no-env-file`), like `vertex:research-studies:import`.
- The CLI refuses a document whose `generatedAt` is more than 5 minutes after the current time, also with `--dry-run`. Such a document in the table would make every real document "older than the stored universe".
- The CLI refuses a document whose `generatedAt` is more than 24 hours before the current time (`GENERATED_AT_MAX_AGE_MS` in `import.ts`), also with `--dry-run`. The labels describe the option market at `generatedAt`, and no reader of the table is forced to look at `generated_at`. So a run must be stored within 24 hours; an older run that was measured again with `--chains-from` cannot be stored.
- Output: one JSON line. Example: `{"generatedAt":"2026-11-11T15:30:00Z","funds":3,"pass":1,"fail":1,"spread-not-measured":1,"upserted":3,"deleted":0}`. A dry run has `"dryRun":true` and no `upserted` or `deleted`.
- Exit codes: `0` success; `2` usage or input problem (also when the database refuses the document); `1` any other failure.

The import replaces the whole table in one transaction (`replaceUniverse`):

1. It takes a transaction-level advisory lock, so two imports run one after the other.
2. It refuses the document when its `generatedAt` is older than the newest stored `generated_at`. An old document cannot replace newer data. A document with the same `generatedAt` is accepted.
3. It upserts every fund by `symbol`.
4. It deletes every row whose symbol is not in the document. A delisted fund disappears.

When any step fails, nothing changes. The repository also refuses a document with no funds, so an empty document can never empty the table.

## Who can read the table

- The app role `vertex_research` gets `SELECT, INSERT, UPDATE, DELETE` in the migration (a guarded grant, as in `0066_breadth_90`). Those are the privileges `replaceUniverse` uses.
- The read-only agent role `vertex_semantic_reader` gets no grant. That role reads only the tables of certified semantic terms (`0056_semantic_layer`; see [agent-semantic-layer.md](agent-semantic-layer.md)), and no certified term reads this table. For an agent to read the universe, a later migration must add a certified term and a `GRANT SELECT` for that role, as `0056_semantic_layer` does for its tables.

## Deploy

Apply the migration to the live database as [flow-pipeline.md](flow-pipeline.md#deploy) states. Do not run `db:migrate` against the QuantVPS database (its Drizzle ledger is incomplete). Apply `packages/db/migrations/0068_leveraged_etf_universe.sql` alone with `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container. Then check that the table `leveraged_etf_universe` exists and that `vertex_research` has SELECT, INSERT, UPDATE and DELETE on it.

The migration only creates the table, its index and the grant. It changes no existing table, so it can be applied before or after the app build.

Rollback: `packages/db/rollback/0068_leveraged_etf_universe.down.sql` drops the index and the table. The rows are derived data; the next import writes them again.

The number `0068` was given by `pnpm db:renumber` when the go-live migration `0067_golive_drafts` merged first. When another branch with a migration merges first again, run `pnpm db:renumber` during the merge ([CONVENTIONS.md](../../CONVENTIONS.md#migration-numbers)); it renames the files and this document.

## Tests

| What | File |
| --- | --- |
| Document schema, gate constants per version and gate rule; the document that Python builds | `scripts/leveraged-etf-universe/document.test.ts` |
| CLI: arguments, stdin limits, a document from the future, a document of more than 24 hours ago, output, exit codes | `scripts/leveraged-etf-universe/import.test.ts` |
| Repository: row mapping, guards, error mapping | `packages/db/src/server/leveraged-etf-universe.test.ts` |
| Migration and rollback text | `packages/db/src/server/leveraged-etf-universe-migration.test.ts` |
| Postgres: checks, replace and delete, stale document, two imports at once, CLI | `tests/integration/database/leveraged-etf-universe.test.ts` |
| Fetcher: name rules, symbol directory, session, gate, chain measure, saved runs, pace of the requests | `services/research/tests/test_leveraged_etf_universe.py` |

`services/research/tests/fixtures/leveraged_etf/universe-document.json` is one document with every label and every reason. The Python test builds it with the Python gate rule and fails when the file differs. `document.test.ts` passes the same file through the Zod schema. So the Python rule and the TypeScript rule cannot drift apart. The fixture holds one real chain: `pur-chain-20260930.json` is the chain of PUR that the run of 2026-11-12 read 42 days after Cboe wrote it.
