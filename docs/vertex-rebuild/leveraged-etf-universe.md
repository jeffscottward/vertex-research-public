# Leveraged ETF universe

Status: research only. A row in this table does not authorize a trade. Nothing here places, changes or cancels an order.

The table `leveraged_etf_universe` holds the US-listed leveraged and inverse funds (ETFs and ETNs), one row per fund. Each row has the fund's option-liquidity facts and one option gate label. The label answers one question for the 24 to 48 hour holding window: are the fund's options liquid enough to trade?

The data lives in Postgres, not in a JSON file (AGENTS.md rule 13). A Python fetcher prints one universe document; the import CLI checks it and writes it through a repository.

## Parts

| Part | Path |
| --- | --- |
| Table and its checks | `packages/db/src/schema/leveraged-etf.ts`, migration `0067_leveraged_etf_universe` |
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
| Leverage and unleveraged reference | Read from the listed name by the fetcher |
| Option chain: spot, expiries, open interest, bid and ask | Cboe delayed quotes (`https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json`) |

## Columns

The table is flat. Every row repeats the gate constants and the `generatedAt` of the document that wrote it, so one row can be read without a second table.

| Column | Type | Meaning |
| --- | --- | --- |
| `symbol` | text, primary key | Fund ticker, `^[A-Z][A-Z0-9.]{0,9}$` |
| `name` | text | Listed name, 1 to 200 characters |
| `product_type` | text | `etf` or `etn` |
| `leverage` | numeric(4,2) | Signed target multiple, for example `3`, `-2`, `1.25`. Never `0`, never `1`, from `-5` to `5` |
| `underlying` | text, nullable | Ticker of the unleveraged reference (QQQ for TQQQ, the stock for a single-stock fund). Null means the fund is not mapped |
| `listing_exchange` | text | Listing exchange, 1 to 20 characters |
| `options_listed` | boolean | False means the fund has no listed options; then every option column below is null and `nearest_expiries` is `[]` |
| `quoted_at` | timestamptz, nullable | Time of the option chain |
| `quote_session` | text, nullable | `regular` = the US option market was trading when the chain was read. `closed` = it was not |
| `spot` | numeric, nullable | Fund price in the chain |
| `nearest_expiries` | jsonb array | The 1 to 4 nearest expiry dates (ISO), ascending. Empty when there are no listed options |
| `window_expiry` | date, nullable | Nearest expiry that is `gate_min_window_days` to `gate_max_window_days` calendar days after the quote day. Null means no expiry is in the window |
| `total_open_interest` | integer, nullable | Open interest of all expiries, calls and puts |
| `band_open_interest` | integer, nullable | Open interest of `window_expiry`, strikes within `gate_band_pct` percent of spot, calls and puts. Null exactly when `window_expiry` is null |
| `half_spread_pct` | numeric, nullable | For `window_expiry`: median of `(ask - bid) / 2 / mid * 100` over the calls and puts of the 4 strikes nearest spot that have `bid > 0` and `ask > bid`. Null means no such quote |
| `option_gate` | text | `pass`, `fail` or `spread-not-measured` (see below) |
| `option_gate_reasons` | jsonb array | Why the label is not `pass` (see below). Empty for `pass` |
| `gate_version` | integer | Version of the gate constants |
| `gate_min_band_open_interest` | integer | Minimum `band_open_interest` (version 1: 1000 contracts) |
| `gate_max_half_spread_pct` | numeric | Maximum `half_spread_pct` (version 1: 4) |
| `gate_min_window_days`, `gate_max_window_days` | integer | The expiry window in calendar days (version 1: 5 to 21) |
| `gate_band_pct` | numeric | Strike band around spot in percent (version 1: 10) |
| `generated_at` | timestamptz | `generatedAt` of the document that wrote the row. All rows have the same value after an import |
| `updated_at` | timestamptz | Time of the import transaction that wrote the row |

There is one index, on `option_gate`.

Three CHECK constraints keep the cheap rules in the database:

- `leveraged_etf_universe_fund_check`: symbol pattern, text lengths, `product_type`, and the leverage range without 0 and 1.
- `leveraged_etf_universe_options_check`: `options_listed` false means no option facts; `options_listed` true means a quote time, a session, a positive spot, a total open interest and 1 to 4 expiries; `band_open_interest` is null exactly when `window_expiry` is null; `half_spread_pct` needs a `window_expiry`.
- `leveraged_etf_universe_gate_check`: valid gate constants; `pass` means listed options, session `regular` and no reasons; `spread-not-measured` means session `closed` and the one reason `market-closed-at-quote`; `fail` means at least one reason.

The database does not recompute the thresholds. The import CLI does (next section).

## Option gate

The gate is a function of the option facts and the gate constants only.

Fail reasons. Every reason that applies is listed:

| Reason | Exact condition |
| --- | --- |
| `no-listed-options` | The fund has no listed options. This is then the only reason |
| `no-window-expiry` | `window_expiry` is null |
| `open-interest-below-minimum` | `band_open_interest` is less than `gate_min_band_open_interest` |
| `no-two-sided-quote` | Session is `regular` and `half_spread_pct` is null. A fund with no window expiry in the regular session has this reason too |
| `spread-above-maximum` | Session is `regular` and `half_spread_pct` is greater than `gate_max_half_spread_pct` |

Labels:

| `option_gate` | Exact meaning | What it means for the 24 to 48 hour window |
| --- | --- | --- |
| `fail` | At least one fail reason applies | The options are too thin. The owner-approved share fallback applies, inside the 2% max-loss gate. That fallback needs an engine policy change that is not part of this work |
| `spread-not-measured` | No fail reason applies and the session is `closed`. The only reason is `market-closed-at-quote` | Not decided. A chain read after the close has stale, wide quotes: it cannot pass and it does not prove a fail. Read a chain during the session to decide |
| `pass` | No fail reason applies and the session is `regular`. No reasons | Trade options on the fund |

The two spread reasons are judged only in the regular session. So a `fail` from a closed-session chain never has a spread reason, and a fund that is `spread-not-measured` can become `fail` when its spread is measured.

Why these thresholds: 1000 contracts in the band keeps an order of 2% of the account small against open interest. A 4% half spread is the widest cost class that the qc-ports option model already charges (SLV, USO).

## Universe document

One JSON document, schema `leveraged-etf-universe-v1`: `schema`, `generatedAt` (UTC), `gate` (the constants) and `funds` (1 to 2000 funds, sorted by symbol, no symbol twice). A fund has the columns above in camelCase; its option facts are in `options`, which is null exactly when `optionsListed` is false.

`LeveragedEtfUniverseDocumentSchema` (`scripts/leveraged-etf-universe/document.ts`) refuses a document when:

- a key is unknown, a value has the wrong type or a value is out of range;
- a datetime is not UTC (it must end with `Z` or `+00:00`);
- `leverage` has more than 2 decimals (the column would round it without notice);
- the funds are not sorted by symbol or a symbol repeats;
- `options` and `optionsListed` do not agree;
- `nearestExpiries` is not ascending or holds a date before the quote day;
- `windowExpiry` is not in the gate window after the quote day, or `bandOpenInterest` and `halfSpreadPct` do not follow `windowExpiry`;
- `optionGate` or `optionGateReasons` is not what the gate rule gives for the fund's `options` and the document's gate constants. The reasons may be in any order.

Quote day: the document does not name a time zone for it. The fetcher uses the New York day of `quotedAt`. The import accepts a date rule when it holds for the New York day or for the UTC day of `quotedAt`; the two days differ only for a chain read in the New York evening.

The import does not check that `windowExpiry` is the nearest expiry in the window, or that the open interest and spread values are right: it has no chain. Those are the fetcher's job.

## Store a universe

```sh
python3 research/backtests/leveraged-etf/universe.py > universe.json
bun run vertex:leveraged-etf-universe:import --dry-run < universe.json
DATABASE_URL=postgres://... bun run vertex:leveraged-etf-universe:import < universe.json
```

- stdin holds one JSON document, at most 2 MiB (2097152 bytes).
- `--dry-run` checks the document and prints the counts. It needs no database and no `DATABASE_URL`.
- Without `--dry-run`, `DATABASE_URL` is required. The script does not read `.env` (`bun --no-env-file`), like `vertex:research-studies:import`.
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

Apply the migration to the live database as [flow-pipeline.md](flow-pipeline.md#deploy) states. Do not run `db:migrate` against the QuantVPS database (its Drizzle ledger is incomplete). Apply `packages/db/migrations/0067_leveraged_etf_universe.sql` alone with `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container. Then check that the table `leveraged_etf_universe` exists and that `vertex_research` has SELECT, INSERT, UPDATE and DELETE on it.

The migration only creates the table, its index and the grant. It changes no existing table, so it can be applied before or after the app build.

Rollback: `packages/db/rollback/0067_leveraged_etf_universe.down.sql` drops the index and the table. The rows are derived data; the next import writes them again.

The number `0067` is the next free number on this branch. When another branch with a migration merges first, run `pnpm db:renumber` during the merge ([CONVENTIONS.md](../../CONVENTIONS.md#migration-numbers)).

## Tests

| What | File |
| --- | --- |
| Document schema and gate rule | `scripts/leveraged-etf-universe/document.test.ts` |
| CLI: arguments, stdin limits, output, exit codes | `scripts/leveraged-etf-universe/import.test.ts` |
| Repository: row mapping, guards, error mapping | `packages/db/src/server/leveraged-etf-universe.test.ts` |
| Migration and rollback text | `packages/db/src/server/leveraged-etf-universe-migration.test.ts` |
| Postgres: checks, replace and delete, stale document, two imports at once, CLI | `tests/integration/database/leveraged-etf-universe.test.ts` |
