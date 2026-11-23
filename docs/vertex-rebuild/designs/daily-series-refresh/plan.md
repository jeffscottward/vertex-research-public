# Plan: scheduled refresh of the stored daily prices and a late Cboe catch-up

![Before and after. Before: 14 of 31 daily series have a scheduled writer; 17 series stop at 2026-11-06, 13 bar series stop at 2026-11-03 and the SPY bar series stops at 2024-12-31. After: a new rig job reads the stored last dates after midnight, fetches only the missing days, checks them against the stored rows and appends them through the ingest endpoint; the Cboe step also runs after midnight.](plan-overview.png)

Before: 17 of 31 stored daily series and all 14 stored daily bar series are written only by a
manual import. After: a scheduled job appends the missing days each night, and the Cboe step has a
second window after midnight.

- Card: `vertex-daily-series-refresh`. The task file sets the bug-fix flow (one plan document, then
  review). It comes from the triage of 2026-11-19 of a research consult, which listed "stored
  prices have no scheduled writer" and "Cboe rows arrive after the last run" as gaps 3 and 4.
- Baseline: commit `f289b21b` on `vertex/rebuild-darkfactory-20260921`. Every "today" statement
  below describes that commit and the live database on 2026-11-22.
- Scope: research data only. This change touches no order, execution, arming or risk path. It adds
  no paid source and no new symbol.
- Review: nine EGM goldfish reviewers (consolidated full flow) plus the intermediate zoom-out.
  Findings and resolutions: `consolidated_review_report.md`, `goldfish_review_report.md`.

## Problem Statement

Measured on 2026-11-22 (read-only SQL on the live database; the last session was 2026-11-20):

- `market_daily_series` holds 31 series. A scheduled step (`cboe-vol-indices` on the rig) refreshes
  only the 14 Cboe volatility index ids. The other 17 end 2026-11-06: 7 ETFs (DIA GLD IWM QQQ SLV
  SPY USO), 7 futures (CL=F ES=F GC=F NQ=F RTY=F SI=F YM=F), the yield indices IRX and TNX, and
  the derived series EY_TNX_RATIO. A manual import (`bun run vertex:series:import`) wrote them on
  2026-11-09.
- `market_bar_series` holds 14 daily (`1d`) series, the same 7 ETFs and 7 futures. 13 end
  2026-11-03 (manual `bun run vertex:bars:import`). SPY ends 2024-12-31: it was imported from the
  test reference file `tests/fixtures/golden/SPY-1d.csv` (Yahoo data, 2015 to 2024).
- Cboe publishes the index row of a session late (about 22:15 to 23:30 New York). The Cboe step
  has the window `mon-fri@16:45-24:00` and runs once an hour. A row that Cboe publishes after the
  last run of the evening waits for the next weekday 16:45; a Friday row waits until Monday.
- Readers of the stale data are research functions: the strategy series loader
  (`packages/api/src/server/strategy-series.ts`), backtest runs, the Autopilot research campaigns
  (`packages/api/src/server/autopilot-runner.ts`), the QuantConnect idea ports
  (`services/research/strategies/qc_ports/portfolio.py`), and the engine comparison driver
  (`scripts/engine-comparison-driver/driver.ts`, 06:15 New York every day).

## Terms

- **The rig**: the owner's Linux research host. The systemd service `vertex-openbb.service` runs
  there every 5 minutes and executes the step lines of `infra/openbb/rig/vertex-openbb.steps`
  (name, timeout, interval, stage, command). Stages run one after another; the steps of one stage
  run in parallel.
- **Fetcher**: the Python package `services/openbb/vertex_openbb`. One run of one job prints one
  JSON document (tables of rows, warnings) on stdout.
- **Tick client**: `scripts/openbb/tick.ts`. It starts the fetcher, posts each table through the
  oRPC procedure `openbb.ingest`, and records the run through `openbb.recordRun` (`ok`, `partial`
  when there are warnings, `failed`, `blocked_upstream`).
- **Series store**: one row of `market_daily_series` plus its points in `market_daily_points`
  (date, open, high, low, close, adj_close). **Bar store**: one row of `market_bar_series` plus
  its bars in `market_bars` (t in epoch milliseconds at 00:00 UTC of the date, o, h, l, c, v).
  Both stores have their own readers (the series store: strategy series and the idea ports; the
  bar store: instant backtests, backtest runs, Autopilot), so the job writes both.
- **Price basis**: both stores hold split-adjusted prices that are not dividend-adjusted.
  **adj_close** (series store only) is the dividend-adjusted (total-return) close of an ETF. The
  bar view of a series (`packages/db/src/server/market-daily-views.ts`) drops an ETF row without
  adj_close.
- **Owner of a series**: the `source` text of the stored series row. `upsertPoints` overwrites by
  date only for the same source; for another source it appends only dates after the stored last
  date (`packages/db/src/server/market-daily-series.ts`). The manual import owns all 17 stale
  series, so the new job can only append.
- **IBKR history**: the read-only `vertex-history` service on the trading server. The Python
  client `services/research/ibkr_history.py` reads it first and uses Yahoo when it fails (owner
  decision of 2026-11-10: IBKR is the first source, Yahoo fills gaps). The service allows about 3
  requests a minute (at least 10 s apart, at most 6 in 120 s;
  `docs/vertex-rebuild/quantvps-status-endpoint.md`).
- **Work unit**: one symbol that the job handles in one `ctx.up.helper` call: TNX (with the
  derived EY_TNX_RATIO, which adds a second helper call `daily-prices:shiller` for the Shiller
  page and workbook when EY has newer dates), IRX, each of the 7 ETFs (2 IBKR requests each, or 1
  Yahoo call on fallback), each of the 7 futures (1 request each); 16 work units.
- **Stored seam**: the stored last date of a series or of a bar series. The first appended row
  follows it. (`ibkr_history.py` uses "seam" for the join of two sources; this plan always says
  "stored seam".)

## Goals & Non-Goals

Goals:

1. Before 06:00 New York of the day after a NYSE session, every price series and every `1d` bar
   series holds the row of that session, without a manual step. Exceptions: EY_TNX_RATIO while its
   Shiller month is not published; IRX and TNX on a US bond market holiday (no index value).
2. An appended row never changes a stored row. A fetched row is appended only when the fetched
   close on the stored seam is within the tolerance of the stored close.
3. The Cboe index row of a session is stored before 06:00 New York of the next day.

Non-goals:

- New symbols, intraday bars, strategy logic.
- A rewrite of stored history, or SPY bar history before 2015.
- A change of the `vertex-history` service.
- A freshness alert for stored prices (follow-up card, see Risks).

## Proposed Architecture

### Measured facts (2026-11-22, from the rig)

- The live `vertex-history` service answers schema `vertex-history-bars-v1`. The client accepts
  only `v2`, so today IBKR fails with a schema error and Yahoo serves. The job works with both; the
  source changes to IBKR without a deploy when the service answers `v2`.
- A run of the finished job with the real stored state and Yahoo (no post): 16 work units, 5 s,
  170 series rows (2026-11-09 to 2026-11-20) and 643 bars (SPY from 2025-01-02), 0 seam warnings.
  So both stored seams of every work unit, including the SPY bar seam of 2024-12-31, match Yahoo
  within the tolerance.
- The Treasury fallback of `index_daily` gives IRX 4.19 on 2026-11-06; stored is 4.0 (4.75 % off).
  It measures a different yield, so the job refuses Treasury rows by rule.
- The Shiller workbook was revised after the import of 2026-11-08: for 2026-11-06 the stored
  EY_TNX_RATIO is 0.7890, and the workbook of 2026-11-22 gives 0.7099. The resulting step at
  2026-11-09 is intentional and produces one revision warning (`EY_TNX_RATIO: the Shiller figures
  changed...`).

### Components and data flow

1. The tick client reads the stored state with a new read procedure `openbb.dailyPricesState`:
   for each price series the last date, close and adj_close; for each `1d` bar series the last
   date and close. If this read fails, the run fails and the fetcher does not start.
2. The fetcher job `daily-prices` gets the state on stdin and works through the 16 work units.
3. A work unit is skipped without any request when its series and its bar series hold the last
   finished session. The last finished session is the newest day before today (New York) that is
   a weekday and not a listed NYSE closure
   (`services/openbb/vertex_openbb/jobs/nyse_closures.py`).
4. For a work unit that is behind, the job fetches daily rows from 7 days before the earliest
   stored seam of the unit (series, bar series, and for TNX also EY_TNX_RATIO). Source order: IBKR,
   then Yahoo, through the existing merge (`merged_daily` / `index_daily`).
5. Stored-seam check, once for the series and once for the bar series: when there are no usable
   rows after the stored last date (`not newer`), `after_seam` returns no rows immediately without
   checking the stored seam and without warning (for example on a US bond market holiday or before
   an upstream posts a session). Otherwise the fetched close on the stored seam must be within 2 %
   of the stored close (10 % for futures: the stored futures series is not back-adjusted, and two
   sources can hold different contracts near a roll). A store that fails the check, or has no
   fetched row on its stored seam, gets no rows and the run gets a warning. The other store of the
   unit is not blocked.
6. The job emits the rows after each stored seam: `daily_series` rows (with `adjClose`) and, for
   ETFs and futures, `daily_bars` rows. The tick client posts them through `openbb.ingest`. The
   server appends them (`upsertPoints` for series, a new `appendBars` for bars).

### Rules

- **Finished sessions only**: a row is accepted when its date is before today (New York). The job
  therefore runs after midnight, when every source holds the final row of the session before. No
  row is read on its own session day.
- **adj_close of appended rows**: ETF: fetched adj_close x (stored adj_close on the stored seam /
  fetched adj_close on the stored seam). Inside one fetch, the ratio of two adj_close values is the
  total return between the two days, so the result continues the stored total-return series and
  no stored row changes. An adj_close that the IBKR client carried over from another day is not
  used. Futures: adj_close = close (as stored). Indices and EY_TNX_RATIO: null, and index rows
  store the close only (as stored).
- **No holes**: the rows of a work unit stop at the first row that cannot be stored (a missing
  price, a bar whose high is below its close, an ETF row without an adj_close). The run warns with
  the date and the number of rows left out, and the next run reads that day again. A negative
  volume is stored as null. The tick client posts no later chunk of `daily_series` or `daily_bars`
  after a failed chunk of that table, because a later chunk would move the stored seam past the
  failed rows.
- **EY_TNX_RATIO**: for each TNX date after the stored last EY date:
  100 x earnings / price of the Shiller month 6 months before, divided by the TNX close (the
  formula of `eyTnxRatio` in `scripts/market-series/import.ts`, with the same 4-decimal Shiller
  values). The job downloads the Shiller page and workbook only when it has such dates. Rows stop
  at the first date whose lagged Shiller month is not published (or has non-positive price) or
  whose TNX close is missing / `<= 0`, and the run warns with the stopped date, reason (naming the
  lagged Shiller month when unpublished) and count of rows not appended. Whether the TNX unit is
  skipped does not depend on EY; EY catches up on the next day that TNX has a new row. In a
  stateful run, EY rows are derived only when TNX had newer usable rows and passed the stored-seam
  check (`seam is not None`, so a no-newer TNX fetch does not derive EY even if EY is behind) and
  a stored EY series exists (`ratio is not None`; a missing one warns when the TNX unit runs). In
  a dry run (`state is None`), EY rows are derived from all usable TNX rows without a seam check.
  The EY value is not rounded (as in the import). When rows are appended and the workbook was
  revised (the recomputed value on the stored last EY date differs by more than 2 %), the run
  warns once and appends the rows with the new figures.
- **Sources**: IBKR is called with no paced retry and a 30 s timeout. A paced answer ends the run
  silently (exit 0, no warning, run status `ok` if nothing else warned; the paced unit counts as
  neither ok nor failed); Yahoo does not replace a paced unit. After the first other IBKR error,
  the remaining units of the run read Yahoo at once. After the stored-seam check passes, when the
  usable rows (dated before today) of a unit hold any row of the Treasury fallback (whether on,
  before or after the stored seam), no row of that unit's series is appended and no EY row is
  derived (warning when there were newer rows; a stored-seam mismatch warns first). `--since
  <date>` (manual run) moves the fetch start earlier for each behind unit when `<date>` precedes
  its default start; a later `--since` never moves it forward.
- **Time budget**: the fetcher deadline stays 240 s. The job starts a work unit only when at least
  100 s remain (one upstream call is cut at 90 s, `CALL_TIMEOUT_S`); when less remains the loop
  stops silently (exit 0, no warning, run status `ok` if nothing else warned; skipped units count
  as neither ok nor failed). Units left over are done by the next run, because the state then shows
  them as behind. With IBKR pacing (2 requests for an ETF, 1 for the others; 23 in total, at most 6
  in 120 s) a session needs about 4 runs, 20 minutes apart (about 80 minutes); with Yahoo, 1 run.
- **Missing state**: a work unit without a stored series is skipped with a warning (the job never
  creates a series). A unit without a stored bar series gets no bars. A dry run has no state: it
  prints the rows of the last 10 days without a check (ETF adj_close as fetched) and with one
  warning; a dry run posts nothing.
- **Run status**: empty tables are normal (`nothing_new`). Each fetched non-paced unit counts as an
  ok source; a unit whose call fails counts as failed; paced and deadline-skipped units count as
  neither. When the Shiller workbook is fetched, it is also counted as a source (`ok` via
  `ctx.take` on success, `failed` on `UpstreamError` or payload error). Exit 3 occurs only when
  every called source failed (`sources_failed > 0` and `sources_ok == 0`); a refused stored seam is
  a warning.
- **Write limits**: `openbb.ingest` and the fetcher document schema refuse a `daily_series` row
  whose id does not belong to the job (`cboe-vol-indices`: the 14 volatility ids; `daily-prices`:
  the 17 price ids), and `openbb.ingest` refuses to create a missing price series (`BAD_REQUEST`,
  matching `daily_bars`). This is input hygiene; authorization is the operator write key as before.
- **Data identity of bars**: `appendBars` recomputes `source_sha256` as the digest of the stored
  bars, as `upsertPoints` does for a series. Backtest runs record this digest. A run in flight
  while its bar series is appended is refused by the existing "stored bars changed" check and
  must be started again; the job runs between 00:30 and 06:00 New York.

### Schedule (step lines)

| Step | Windows (New York) | Interval | Timeout | Stage |
| --- | --- | --- | --- | --- |
| `daily-prices` | `tue-sat@00:30-06:00` | 20 min | 345 s | 2 |
| `cboe-vol-indices` | `mon-fri@16:45-24:00+tue-sat@00:00-06:00` | 60 min | 330 s | 1 |

- The window option accepts several windows joined with `+`, because one window cannot cross
  midnight. Each job keeps exactly one step line.
- 345 s = fetcher deadline 240 s + 90 s + 15 s for the state read (the rule of the steps file).
  The stage sum is 420 + 345 + 350 + 365 + 350 + 600 s plus 10 s for each of the 6 stages =
  2490 s; `TimeoutStartSec` is 2535 s.

## Alternatives Considered

- **Schedule the manual import as a full replace.** It needs no stored-seam check and corrects
  revised rows. Rejected: each run needs 30 years of history for 16 symbols (IBKR pages at 3
  requests a minute), every run changes the data identity of every series, and the import reads
  CSV files, which the app may not use as a data path.
- **A fixed 10-day window without the state read.** Rejected: it cannot fill the present gap
  (2026-11-06, bars 2026-11-03, SPY bars 2024-12-31), cannot continue adj_close, and cannot skip
  finished units, so every run would call every source.
- **Check the stored seam on the server at write time.** It would protect every writer. Rejected
  for now: the fetcher still needs the stored last dates to choose its window, and a refusal must
  reach the run warnings, which only the fetcher document carries. The repositories keep their
  own invariant (append after the last date only).
- **Yahoo first, or Yahoo only.** Stored history is Yahoo, and IBKR fails today. Rejected: the
  owner decision of 2026-11-10 makes IBKR the first source. The job works without the history
  variables (Yahoo only), so the rig can switch by configuration.
- **Leave the history variables off the rig until the service answers `v2`.** No token would reach
  the fetcher now. Rejected: the task file makes the rig variables part of this job, and the owner
  decision makes IBKR the first source. The cost today is one failing request per run (after it,
  the run reads Yahoo). The rig returns to Yahoo-only by removing the two variables.
- **Install `services/research` into the fetcher venv instead of loading two files by path.**
  Rejected: `services/research` is a folder of scripts and modules with other dependency sets, not
  a package; `install.sh` and the hash-locked venv would need a second install step. The checkout
  that holds the two files is the folder the wrapper already runs in.
- **Keep EY_TNX_RATIO on the manual import.** It would remove the Shiller download and one
  exception. Rejected: the task asks for the derivation in this job, the acceptance check counts
  all 31 series, and the idea ports read the series every day.
- **adj_close null on appended ETF rows, or a weekly full replace.** Rejected: the bar view drops
  rows without adj_close; the chain rule gives the same total-return series with no replace.
- **A longer deadline for this job.** One run would finish a session. Rejected: it needs a wrapper
  exception, a stage of its own and a longer service bound; the continuation over about 4 runs
  needs none of these.
- **Rows on the session day (evening runs).** Fresher by some hours. Rejected: nothing proves that
  a row read at 17:30 is final, and an appended row cannot be corrected. The first reader of the
  day runs at 06:15.
- **A second step line for the late Cboe window.** Rejected: the install test keeps one step per
  job; the `+` windows need 4 lines in the window parser.
- **Write one store and derive the other.** Rejected: the bar store has volume and its own data
  identity; changing its readers is outside this fix.

## Detailed Implementation Plan

One PR. Paths are from the repo root. Each numbered part holds its tests.

### 1. Database repositories (`packages/db`)

- Modify `packages/db/src/server/market-daily-series.ts`: add to `MarketDailySeriesRepository`
  `latestPoints(ids: readonly string[]): Promise<MarketDailyLatestPoint[]>` with
  `MarketDailyLatestPoint = { id, lastDate, close, adjClose }`: one row per stored id, joined on
  `market_daily_points.date = market_daily_series.last_date`, ordered by id; no query for an empty
  list. Also add optional `options?: MarketDailyUpsertOptions` (`{ createIfMissing?: boolean }`,
  default `true`) to `upsertPoints`: when `createIfMissing` is `false` and the series is missing,
  throw `MarketDailySeriesInputError("no stored series <id>")` under the advisory lock without
  inserting.
- Modify `packages/db/src/server/market-bars.ts`: split the bar rules out of `validateMarketBars`
  (series key rules; bar rules with a minimum count) and add to `MarketBarsRepository`
  - `latestBars(timeframe): Promise<MarketBarLatest[]>` with `{ symbol, lastT, close }`, joined on
    `market_bars.t = market_bar_series.last_t`, ordered by symbol;
  - `appendBars(series: MarketBarSeriesKey, bars: readonly MarketBarRow[]): Promise<MarketBarAppendResult>`
    (`MarketBarSeriesKey` = symbol and timeframe; result `{ series, written }`): at least 1 valid
    bar in ascending time; a per-series advisory transaction lock; `MarketBarsInputError` when the
    series is not stored; only bars with `t > last_t` are inserted; nothing newer returns the
    stored row unchanged with `written: 0`; otherwise `bar_count`, `last_t`, `imported_at` and
    `source_sha256` (sha256 over `t|o|h|l|c|v` lines in time order, null volume as empty, floats
    in shortest exact text) are recomputed from storage; `source` keeps the text of the base
    import.
  - `replaceSeries` takes the same lock, so a manual import and an append cannot interleave.
- Modify `packages/db/src/server/index.ts`: export the new types.
- Tests: new `packages/db/src/server/market-append.test.ts` (query double: append with a newer and
  an older bar, nothing newer, missing series, key and bar validation before any query, the digest
  expression, `latestBars`, `latestPoints` with duplicate ids, empty list, bad id);
  `packages/db/src/server/market-daily-series-upsert.test.ts` (`createIfMissing: false` refuses a
  missing series and appends to a stored one);
  `packages/db/src/server/market-bars.test.ts` (lock in `replaceSeries`);
  `tests/integration/database/openbb.test.ts` (real Postgres: missing series refused when
  `createIfMissing: false`, last point of a stored series, append, digest value, nothing newer,
  last bars).
- The repository types grow, so the typed test doubles get the new members:
  `packages/api/src/agent-model-runs.test.ts`, `packages/api/src/agent-ops-backtests.test.ts`,
  `packages/api/src/autopilot.test.ts`, `packages/api/src/backtest-runs.test.ts`,
  `packages/api/src/instant-backtest.test.ts`, `packages/api/src/openbb-server.test.ts`,
  `packages/api/src/server/setup-replay.test.ts`, `packages/api/src/server/strategy-series.test.ts`.
- No migration: no table or column changes.

### 2. Contract and server (`packages/api`)

- Modify `packages/api/src/contracts/openbb.ts`:
  - `OPENBB_JOBS` gains `"daily-prices"`; `OPENBB_TABLES` gains `"daily_bars"`;
    `OPENBB_JOB_TABLES["daily-prices"] = ["daily_series", "daily_bars"]`.
  - New constants: `OPENBB_PRICE_SERIES_KINDS` (id -> kind: the 7 ETFs `etf`, the 7 futures
    `future`, IRX and TNX `index`, EY_TNX_RATIO `derived`), `OPENBB_PRICE_SERIES_IDS`,
    `OPENBB_DAILY_BAR_SYMBOLS` (the ETF and futures ids), `OPENBB_DAILY_PRICES_SOURCE`, and
    `openbbIsPriceSeriesId`.
  - `OpenbbDailySeriesRowSchema`: `seriesId` is an enum of the volatility ids and the price ids;
    new key `adjClose` (null or finite, optional: a fetcher before this change sends no key).
  - New `OpenbbDailyBarRowSchema` (strict): `symbol`, `date`, `open`, `high`, `low`, `close`
    (finite, above 0), `volume` (null, or finite and at least 0), with
    low <= min(open, close) and high >= max(open, close). Added to `OPENBB_ROW_SCHEMAS` and to the
    table union.
  - `OpenbbIngestInputSchema` and `OpenbbBatchDocumentSchema` refuse a `daily_series` row whose id
    is outside the job's id group.
  - New route `dailyPricesState` (POST `/openbb/daily-prices-state`, summary "Scheduler: stored
    last rows of the daily price series and 1d bar series"): input `{}` (strict), output
    `OpenbbDailyPricesStateOutputSchema` =
    `{ series: [{ id, lastDate, close, adjClose }], bars: [{ symbol, lastDate, close }] }`.
- Modify `packages/api/src/server/openbb.ts`:
  - `repositoriesFor` also returns `context.repositories.marketBars` (missing: `STORAGE_ERROR`).
  - `daily_series` branch: kind and source come from the id (`index` and `cboe` for a volatility
    id; `OPENBB_PRICE_SERIES_KINDS[id]` and `OPENBB_DAILY_PRICES_SOURCE` for a price id);
    `upsertPoints` gets `{ createIfMissing: !price }`, so a missing price series raises
    `MarketDailySeriesInputError` (mapped to `BAD_REQUEST`) while a missing volatility index is
    created; `adjClose` is `row.adjClose ?? null`.
  - `daily_bars` branch: group rows by symbol, map each to
    `{ t: Date.parse(date + "T00:00:00Z"), o, h, l, c, v }`, sort by `t`, call
    `appendBars({ symbol, timeframe: "1d" }, bars)`, add up `written`; `MarketBarsInputError`
    becomes `BAD_REQUEST`.
  - `dailyPricesState` handler: operator plus agent write key (as `form4State`);
    `latestPoints(OPENBB_PRICE_SERIES_IDS)` and `latestBars("1d")` filtered to
    `OPENBB_DAILY_BAR_SYMBOLS`, `lastT` as an ISO date; a repository error becomes
    `STORAGE_ERROR`.
- Regenerate `packages/api/openapi.json` (`bun run openapi:generate`).
- Tests in `packages/api/src/openbb-server.test.ts`: id lists; id group refused in both
  directions; bar price rules; price points with kind, source and adjClose; bars grouped and
  sorted, `BAD_REQUEST` and storage errors; the state read (no key, no storage, mapped rows, both
  repository errors). The fixture test there reads the Python fixture of the new job.

### 3. Fetcher (`services/openbb`, `services/research`)

- New `services/research/shiller.py` (stdlib plus a lazy `xlrd` import). `xlrd==2.0.2` is already
  in the OpenBB lock file through two providers; it becomes a declared pin in
  `services/openbb/requirements-openbb.in`, `services/openbb/pyproject.toml` and the `via` list of
  `services/openbb/requirements-openbb-linux-py312.lock`. The module has `PAGE_URL`, `workbook_url(page)` (`ValueError` without a link) and
  `monthly_rows(content) -> list[tuple[str, float, float]]` (values rounded to 4 decimals, the
  precision of the import's CSV). Modify `research/backtests/qc-ports/fetch_data.py`: `_shiller`
  calls them (same CSV lines, same `SystemExit` text). Test: new
  `services/research/tests/test_shiller.py` (a fake `xlrd`), listed in
  `services/research/tests/ci-suites.txt`.
- Modify `services/openbb/vertex_openbb/rows.py`: id tuples (`ETF_IDS`, `FUTURE_IDS`,
  `YIELD_INDEX_IDS`, `DERIVED_IDS`, `PRICE_SERIES_IDS`, `DAILY_BAR_SYMBOLS`); `daily_series` gets
  `adjClose` (required key, null or finite) and the wider id enum; new table `daily_bars` with the
  cross-field rule of the Zod schema; key `("symbol", "date")`.
- Modify `services/openbb/vertex_openbb/jobs/cboe.py`: `index_rows` adds `"adjClose": None`.
- Modify `services/openbb/vertex_openbb/context.py`: field `daily_prices_state`.
- New `services/openbb/vertex_openbb/jobs/daily_prices.py`: the job and its rule functions. One
  `ctx.up.helper("daily-prices:<id>:<start>:<ibkr|yahoo>", ...)` call per work unit runs the merge
  and returns `{ rows, errors, warnings, paced }`:
  - IBKR client `Client.from_env(env, paced_retries=0, timeout=30)`; ETFs call `merged_daily` with
    `adjust="adj_close"`, futures call `merged_daily` with `adjust="none"`, and yield indices call
    `index_daily` (Yahoo symbol `^TNX` / `^IRX`); no `end` argument (the job cuts rows at the last
    finished session).
  - Yahoo callable: `yfinance` `history(start, interval="1d", auto_adjust=False)` with open, high,
    low, close, adj_close and volume.
  - Emitted prices are rounded to 6 decimals (volume to 0); the EY value is not rounded.
  - A second helper call (`daily-prices:shiller`) downloads the Shiller page and workbook.
  - `ibkr_history.py` and `shiller.py` are loaded by file path from `OPENBB_RESEARCH_DIR`
    (default: the source tree), because the venv holds a copy of the package, not the repository;
    the job loads both before the first unit, so a missing file is an argument error (exit 2).
    The repository checkout is always present on
    the rig (the wrapper runs inside it).
- Modify `services/openbb/vertex_openbb/cli.py`: job, tables, `--state-stdin` for `daily-prices`
  (the state is shape-checked; bad state exits 2), `xlrd` in the `--warm` import list, and the
  history URL and token in the scrub list, so they never appear in a warning or a document. The
  job takes no `--symbols`.
- Tests: new `services/openbb/tests/test_daily_prices.py` (each rule function; a quiet run with
  everything stored; rows only after both stored seams; refused stored seam per store; missing
  entries; EY derivation, stop warning on unpublished Shiller month or TNX close `<= 0`, revised
  workbook, failed/malformed workbook, Treasury rows, no EY row without a checked TNX row, missing
  EY series; a unit that cannot advance; paced units (also an index unit), failed and switched
  units; a missing research folder (exit 2); `--since`; the deadline gate; the live helper bodies
  with a fake transport and a fake `yfinance`; module loading errors; scrubbed secrets), listed in
  `services/research/tests/ci-suites-openbb.txt`; and `services/openbb/tests/test_jobs.py`
  (`test_nan_and_infinity_are_removed` gains `adjClose: None` on the expected `daily_series` row).
  Fixtures `services/openbb/tests/fixtures/daily-prices.json` and
  `services/openbb/tests/fixtures/upstream/daily-prices.json` hold made-up prices (IBKR and Yahoo
  rows are not redistributed; `services/openbb/tests/record.py` treats the job as synthetic);
  `services/openbb/tests/fixtures/cboe-vol-indices.json` gains `adjClose`;
  `services/openbb/tests/fixtures/invalid-rows.json` and
  `services/openbb/tests/fixtures/valid-edge-rows.json` gain rows of both tables.

### 4. Tick client (`scripts/openbb/tick.ts`)

- `insideOpenbbWindow` accepts several windows joined with `+`; every window is validated.
- `postTables` stops posting a table of the append-only set (`daily_series`, `daily_bars`) after
  its first failed chunk and counts the later rows as failed.
- `call()` gains the procedure `dailyPricesState`. `stateFor`: for `daily-prices` it reads the
  state (15 s limit, parsed with `OpenbbDailyPricesStateOutputSchema`) whenever the API is
  configured (timer and manual runs; not in a dry run). An error fails the run before the fetcher
  starts, recorded as `dailyPricesState failed: <reason>`.
- `openbbChildEnv(env, job?)`: for `daily-prices` only, the child also gets `VERTEX_HISTORY_URL`
  and `VERTEX_DEPLOY_STATUS_TOKEN`; the tick adds `OPENBB_RESEARCH_DIR` (the folder `../research`
  next to the service folder). Other jobs keep the present allowlist. The header comment says so.
- Tests in `scripts/openbb/tick.test.ts`: state on stdin, child environment per job, both tables
  posted, failed state read, dry run, a failed first chunk, `+` windows.

### 5. Rig files and documents

- Modify `infra/openbb/rig/vertex-openbb.steps`: the `daily-prices` line, the second window of
  `cboe-vol-indices`, the header comments. `infra/openbb/rig/install.test.ts` needs no change.
- Modify `infra/openbb/rig/vertex-openbb-run.sh` (header: the two optional history variables) and
  `infra/openbb/rig/vertex-openbb.service` (the stage sum in the comment).
- Modify `docs/vertex-rebuild/openbb.md`: the job, the table, the state read, the rules and the
  schedule.

### 6. Deploy and first run (after merge, outside market hours)

Order: web app first, then the rig (a new fetcher sends `adjClose`, which the old server schema
refuses). Rollback in the opposite order.

1. Web app on the trading server: `infra/quantvps/restart-when-idle.sh` with the merged SHA
   (claim `deploy:quantvps:vertex-web`). Check: `openbb.dailyPricesState` answers 17 series and
   14 bar series.
2. Rig: back up `~/.config/vertex/openbb.env`, add the two history variables (values copied from
   `~/.config/vertex/research-lenses.env`, mode 0600, never printed), run
   `infra/openbb/rig/install.sh <merged sha>`.
3. `vertex-openbb-run daily-prices --dry-run`, then `vertex-openbb-run daily-prices` once (Yahoo
   serves today, so one run does every unit); read back the last dates with read-only SQL.

## Acceptance Checks

1. Read-only SQL on the live database at 09:00 UTC after a NYSE session T:
   `select count(*) from market_daily_series where last_date < T and id <> 'EY_TNX_RATIO'` is 0
   (IRX and TNX excepted on a bond market holiday), EY_TNX_RATIO is at T or the run warning names
   its Shiller month, and
   `select count(*) from market_bar_series where timeframe='1d' and to_timestamp(last_t/1000)::date < T`
   is 0. (09:00 UTC is 04:00 or 05:00 New York; the `daily-prices` window starts at 00:30.)
2. `journalctl --user -u vertex-openbb.service` on the rig shows `daily-prices` with rows written
   above 0; a later run the same night writes 0 rows and records status `ok`.
3. `select min(last_date) from market_daily_series where source='cboe'` equals T at 06:00 New York
   on T+1, on 3 sessions in a row including one Friday.
4. `journalctl --user -u vertex-engine-comparison-driver.service` on the rig and the newest
   `backtestRuns.comparisons.list` rows show a last bar date equal to the last session.
5. The required PR check `ci-gate` passed on the head commit; `bun run verify:coverage` reports
   100 % for the new and changed TypeScript files; the Python suites of
   `scripts/ci/research-python.sh` pass (Python coverage is not measured in this repository).

## Risks & Mitigations

- **Mixed sources.** An appended row can come from IBKR or Yahoo while history is Yahoo. The
  stored-seam check bounds the difference on the stored seam only; later days are not checked
  against a second source. IBKR continuous futures use all trading hours, and it is not verified
  whether IBKR back-adjusts them (`ibkr_history.py`). Mitigation: the 10 % futures tolerance
  refuses a level change; the rig can run Yahoo-only by leaving the history variables unset; the
  switch to IBKR (service `v2`) is a moment to compare one night's rows of both sources.
- **A refused work unit stays stale** until a manual `vertex:series:import` /
  `vertex:bars:import`, and the run stays `partial`, which also hides a new warning of another
  unit. A stale series is visible in the run status; a row with a wrong level would give readers a
  false return. Follow-up card: a freshness alert when a stored price series is more than 2
  sessions behind.
- **EY_TNX_RATIO revisions.** The stored rows keep the Shiller figures of their fetch day. After a
  revision the appended rows step away from them (measured: stored 0.7890 to new 0.7099 on
  2026-11-06, producing the intentional step at 2026-11-09). The run warns once; a manual
  `vertex:series:import` re-derives the whole series.
- **The history token reaches the fetcher process** of this one job. The fetcher also runs
  `yfinance` and `xlrd` on downloaded content. Mitigation: the token is read-only (market data),
  only `daily-prices` gets it, the fetcher scrubs it and the URL from its output, and the module
  folder comes from the tick (the checkout), not from the network.
- **Upstream limits.** Yahoo can throttle or change its format; the unit then fails and the run
  is `partial` or `failed` in the run ledger. The job makes at most 17 helper calls a run (at most
  16 unit calls — up to 16 Yahoo calls when Yahoo serves, or up to 23 IBKR requests across runs —
  plus at most 1 Shiller helper call of 2 HTTP GETs for the page and workbook) and makes none when
  everything is stored.
- **NYSE closure list.** `nyse_closures.py` lists closures up to 2028. On an unlisted closure
  every unit is behind and each run fetches without writing; no row is written. For a session in
  a year outside the list, the run warns (as the Reg SHO job does).
- **A missing price series** is refused by both the fetcher (warns and skips) and `openbb.ingest`
  (`upsertPoints` with `{ createIfMissing: false }` returns `BAD_REQUEST`, matching `daily_bars`).
- **Rollback.** Rig first: run `infra/openbb/rig/install.sh <previous sha>` (the old steps file
  has no `daily-prices` line). Then revert the PR and deploy the web app. Appended rows passed the
  schema and the stored-seam check and stay; a wrong row is fixed by a manual import of that
  series (replace).
