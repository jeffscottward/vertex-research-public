# Plan: scheduled refresh of stored daily prices

- Card: `vertex-daily-series-refresh`. Flow: bug fix plan.
- Scope: research data. The change places no order and starts, stops or configures no trading unit.
- Effect on trading inputs: Autopilot entry filters and strategy series read these tables. After the change they
  read the last session instead of rows that are up to 2 weeks old. That is the purpose of the fix.

## Problem statement

![Before and after: 17 daily series and 14 bar series get a scheduled writer](before-after.png)

Measured on the live database on 2026-11-19 (read-only SQL):

| Table | Series | Count | Last date | Writer |
| --- | --- | --- | --- | --- |
| `market_daily_series` | Cboe volatility indices | 14 | 2026-11-18 | rig step `cboe-vol-indices`, hourly, 16:45-24:00 New York |
| `market_daily_series` | 7 ETFs + 7 futures + IRX + TNX + EY_TNX_RATIO | 17 | 2026-11-06 | none (manual import on 2026-11-09) |
| `market_bar_series` (1d) | 6 ETFs + 7 futures | 13 | 2026-11-03 | none (manual import) |
| `market_bar_series` (1d) | SPY | 1 | 2024-12-31 | none (test fixture, 2015-2024) |

- **F1. No scheduled writer.** 17 daily series and all 14 bar series (13 + SPY) are written only by manual
  imports. Strategy series, backtests, Autopilot entry filters and the engine comparison driver (06:15 New York)
  read data that ends 2026-11-06, 2026-11-03 or 2024-12-31.
- **F2. The Cboe session row arrives in the last run of the window.** Rig journal of `vertex-openbb.service`:
  the row of the session appeared only in the last run of each evening (2026-11-16 at 23:13, 11-17 at 23:26, 11-18
  at 23:36; the runs one hour before did not have it). The start of the hourly run moves about 10 minutes later
  each day. When Cboe publishes after the last run before 24:00, the row waits until 16:45 on the next weekday, and
  a Friday row waits until Monday.

## Goals and non-goals

Goals (T = a trading day of the series; "stale" = last stored date before the last complete session of that series):

1. At 04:00 New York (09:00 UTC) on the day after T, no daily series and no 1d bar series is stale. The one
   exception by id is `EY_TNX_RATIO` when its monthly input is missing (see "Derived id").
2. At 06:00 New York on the day after T, the 14 Cboe series end at T, also after a Friday.
3. A second run on the same evening writes 0 rows. A stored row is never changed by the new step.

Non-goals: new symbols, intraday bars, changes to strategy logic, changes to the volatility collector code, a
change to the window parser, one store for series and bars, and a freshness monitor (see "Risks").

## Terms

- **Rig**: the Linux host that runs the collectors (`vertex-openbb.timer`). **Collector**: the Python package
  `services/openbb/vertex_openbb`. **Tick client**: `scripts/openbb/tick.ts`; it starts the collector, validates
  its rows and posts them. **`openbb.ingest`**: the oRPC procedure of the web app that writes the rows
  ([openbb.md](../../openbb.md)). **vertex-history**: the service on the QuantVPS host that returns IBKR history
  bars over HTTPS with a token.
- **Ingest table**: a named part of the ingest payload, not a database table. `daily_series` rows go to the
  database tables `market_daily_series` and `market_daily_points`. The new `daily_bars` rows go to
  `market_bar_series` and `market_bars`.
- **Price ids** (16): ETFs `SPY QQQ DIA IWM GLD SLV USO`; futures `ES=F NQ=F YM=F RTY=F GC=F SI=F CL=F`; rate
  indices `IRX TNX`. **Derived id** (1): `EY_TNX_RATIO`. Together: the 17 **price-job ids**. The 14 Cboe ids are
  the **volatility ids**.
- **Seam date**: the stored last date of a series (or the date of the stored last bar) when an append starts.
- **Complete session**: a row dated before today (New York), or dated today when the New York time is 17:15 or
  later. A row dated after today is never complete. Reason: CME closes the daily futures bar at 17:00, and IBKR
  returns the bar of the session in progress (on 2026-11-19 at 19:20 it returned an `ES=F` row dated 2026-11-20).

## Proposed architecture

![Data flow: collector on the rig, tick client, openbb.ingest, Postgres](data-flow.png)

The rig timer starts a new step `daily-prices` after the close. The collector reads each id from vertex-history
(IBKR) and uses Yahoo when IBKR does not answer. It keeps complete sessions and prints rows. The tick client posts
the rows to `openbb.ingest`. The handler appends them to the two stores through the two repositories, which
write only rows after the seam date. A second schedule line runs the existing volatility step after midnight.
Both stores are written because they have different readers: `market_daily_points` holds `adj_close` (strategy
series, qc-ports), `market_bars` holds volume (instant backtest, engine comparison driver).

## Alternatives considered

| Choice | Alternative | Why not |
| --- | --- | --- |
| Append after the seam date | Schedule the existing fetch and full replace (`fetch_data.py` + `vertex:series:import`) | It keeps data in files between the fetch and the import (owner rule of 2026-11-07 behind AGENTS.md rule 13: collectors write through an endpoint or a repository), needs `yfinance` and about 30 years of IBKR pages for each id every night, and has no bar writer. It stays the repair tool. |
| `adj_close` linked to the stored basis | Null on appended ETF rows | `qc_ports/data.py` drops rows without `adj_close`, so readers would still see old data. |
| Collector on the rig, through `openbb.ingest` | A job on the web host | The rig already has the timer, the run records, the write key and the validation; the web host must not call IBKR history in a request. |
| IBKR first, Yahoo when IBKR fails | IBKR only | The IBKR gateway needs a human login after some restarts; without a second source F1 comes back for days. `merged_daily` already uses Yahoo for everything when IBKR fails. |
| Extend `upsertPoints` with an append argument | A second method `appendPoints` | The sort, validation, lock and digest steps would be copied. |
| Load `ibkr_history.py` by path from the checkout | A shared installed package, or a copy | The module is stdlib-only and `qc-ports/fetch_data.py` loads it from the checkout too. No shared Python package exists for the two services, and a copy of 850 lines would be a second source of the merge rules. |
| A second step line after midnight | A window that crosses midnight | The parser refuses it by design; a second line needs no parser change. |
| Checks inside the repository transaction | Checks in the handler | The seam must be read under the same series lock as the write, or two runs can interleave. The handler chooses the options; the repository holds no id list. Two flags: ETF series need both checks, ETF bars only the close check, the other kinds none. |

## Detailed design

### Files

All are Modify, except one Create. Paths are relative to the repository root.

| File | Change |
| --- | --- |
| `packages/api/src/contracts/openbb.ts` | Job, ingest table, id map, row schemas, refinements (Phase 1) |
| `packages/api/src/openbb-server.test.ts` | Contract and handler cases |
| `packages/api/openapi.json` | Regenerate with `bun run openapi:generate` |
| `packages/api/src/server/openbb.ts` | Handler branches (Phase 3) |
| `packages/db/src/server/market-daily-series.ts` | `upsertPoints` gets the optional `append` argument |
| `packages/db/src/server/market-daily-series-upsert.test.ts` | Unit cases |
| `tests/integration/database/market-daily-series.test.ts` | Postgres cases |
| `packages/db/src/server/market-bars.ts` | `appendBars`, series lock, `validateMarketBar` helper |
| `packages/db/src/server/market-bars.test.ts` | Unit cases |
| `tests/integration/database/openbb.test.ts` | Postgres cases for `appendBars` and the ingest path |
| `services/openbb/vertex_openbb/jobs/prices.py` | Create |
| `services/openbb/vertex_openbb/cli.py` | `JOBS`, job tables, `SYMBOL_JOBS` |
| `services/openbb/tests/test_jobs.py`, `services/openbb/tests/test_units.py` | Collector cases (fakes are built in the tests; no fixture file) |
| `scripts/openbb/tick.ts`, `scripts/openbb/tick.test.ts` | Two names in `CHILD_ENV_NAMES` |
| `infra/openbb/rig/vertex-openbb-run.sh`, `infra/openbb/rig/vertex-openbb.steps`, `infra/openbb/rig/install.test.ts` | Token for one job, five step lines |
| `docs/vertex-rebuild/openbb.md` | Job list, the private upstream, the schedule, the append rule |

No migration: the app role already has INSERT and UPDATE on the four tables (checked on the live database). No
lock change: `xlrd==2.0.2` is in `services/openbb/requirements-openbb-linux-py312.lock`. The symbol rule of the
collector (`rows.py` `SYMBOL`) accepts `ES=F`.

### Phase 1: contract

- `OPENBB_JOBS` gets `daily-prices`; `OPENBB_TABLES` gets `daily_bars`;
  `OPENBB_JOB_TABLES["daily-prices"] = ["daily_series", "daily_bars"]`; `OPENBB_ROW_SCHEMAS` and the `tableRows`
  union get the `daily_bars` entry.
- `OPENBB_PRICE_SERIES`: id -> kind for the 17 price-job ids (`etf`, `future`, `index` for IRX and TNX, `derived`).
  The handler reads the kind from this map.
- `OpenbbDailySeriesRowSchema`: `seriesId` accepts the 31 ids; new optional `adjClose` (finite and above 0).
  Refinement by kind: `adjClose` is required for `etf` and `future` ids and refused for every other id. ETF and
  futures rows carry open, high, low and close; IRX, TNX and the derived id carry close with null open, high, low
  (as the stored rows of these ids).
- `OpenbbDailyBarRowSchema`: strict object `{ symbol (the 14 ETF and futures ids), date, open, high, low, close
  (finite, above 0), volume (finite, >= 0, or null) }`.
- Job and id refinement, in both the ingest input and `OpenbbBatchDocumentSchema` (the tick client validates the
  collector output with it): with job `cboe-vol-indices` every `seriesId` is a volatility id; with `daily-prices`
  every `seriesId` is a price-job id. Reason: `OPENBB_JOB_TABLES` alone would let either job write the other's ids
  with the wrong kind and source.
- Checkpoint: contract tests and `bun run check` pass.

### Phase 2: repositories

```ts
// market-daily-series.ts: third, optional argument. Without it the method behaves as today.
upsertPoints(series, points, append?: { seamCloseTolerance: number | null; linkAdjClose: boolean })

// market-bars.ts
appendBars(symbol: string, timeframe: MarketBarTimeframe, bars: readonly MarketBarRow[],
  options: { seamCloseTolerance: number | null }
): Promise<{ series: MarketBarSeries; written: number }>
```

`upsertPoints` is extended and not copied: it already sorts and removes duplicate dates, validates the points,
takes the series lock and recomputes count, first date, last date and the digest from the stored rows after a
write. `market-bars.ts` gets the same kind of lock (`'market_bar_series:' || id`); `replaceSeries` takes it too.

Rules of append mode, in order. Daily points match the seam by `date === stored last date`, bars by
`t === stored last_t`. A refusal is a `MarketDailySeriesInputError` or `MarketBarsInputError` with the text shown.

| Case | Result |
| --- | --- |
| The series does not exist | Refuse: `series is not imported`. The step never creates a series. |
| The input has no row on the seam | Refuse: `send rows from <seam date>`. No silent gap. |
| `seamCloseTolerance` is a number and `abs(incoming close - stored close) / stored close` on the seam is above it | Refuse: `close on <seam date> differs from the stored close`. |
| `linkAdjClose` and the stored or the incoming `adj_close` on the seam is null or not above 0 | Refuse: `adj_close on <seam date> is missing`. |
| Input rows before the seam | Ignored (not compared, not written). |
| No input row after the seam | Write nothing, return `written: 0`. |
| Rows after the seam | Insert them. With `linkAdjClose`: `adj_close = incoming adj_close x stored adj_close(seam) / incoming adj_close(seam)`; without: `adj_close` as sent, or null. |

- Append mode ignores the ownership rule: it never changes a stored row, also for a series with the same source.
  Kind and source of the series stay. The daily series digest is recomputed from the stored rows (the existing
  step). The bar series keeps `source_sha256` (it is the digest of the import file, not of the rows); `last_t`,
  `bar_count` and `imported_at` are updated; `first_t` stays.
- `validateMarketBar` (new helper taken out of `validateMarketBars`): one bar has a safe-integer `t`, positive
  finite prices, low <= open, close <= high. `appendBars` uses it and requires ascending `t` without duplicates;
  the 2-bar minimum stays in `replaceSeries`. A null volume is stored as null.
- Why the link works: an adjusted series is defined up to a constant factor. Returns from the seam to each new row
  equal the returns of the incoming adjusted series, and the step of `adj_close / close` on an ex-dividend date is
  kept. Readers: `strategy-series.ts` loads the `adjClose` column for strategy runs, and `qc_ports/forms.py`
  scales prices by `adj_close / close`.
- Checkpoint: repository tests pass (unit and isolated Postgres).

### Phase 3: handler

`repositoriesFor` also returns `context.repositories.marketBars` (it exists in the request scope; the Autopilot
handler reads it). A missing repository gives the same failure as for the other two. For job `daily-prices` the handler groups rows by id and calls, per id:

| Kind | Method | `seamCloseTolerance` | `linkAdjClose` |
| --- | --- | --- | --- |
| etf (series) | `upsertPoints` append | 0.005 | true |
| future (series) | `upsertPoints` append | null | false (`adjClose` = close as sent) |
| index IRX, TNX, derived | `upsertPoints` append | null | false (`adjClose` null) |
| etf (bars) | `appendBars` | 0.005 | - |
| future (bars) | `appendBars` | null | - |

- 0.005 is a relative limit (0.5% of the stored close): above a rounding or source difference, below any split
  ratio. The implementation records the IBKR/Yahoo close difference of the 7 ETFs on the catch-up dates in
  the PR; if one is above 0.002 the limit is reviewed before the merge. Futures get no close check: the stored futures series are the
  front month without back-adjustment, and a roll makes the two sources differ on the seam.
- A `daily_bars` row becomes `{ t: 00:00 UTC of date in ms, o, h, l, c, v }` (the stored convention).
- One refused id does not stop the others: the handler continues, then throws `BAD_REQUEST` with the list
  `<id>: <reason>`. Written ids stay written (each id is its own transaction). The tick client counts that chunk
  as failed: the run status is `partial` when another chunk of the run was accepted and `failed` when none was
  (`statusOf` in `tick.ts`, unchanged), and the message is in the run record and the journal. The rows written in
  a refused chunk are not in the run's row count; this limit is accepted. The next run writes 0 for the written
  ids and repeats the refusal.
- The handler passes `adjClose` as sent (the contract makes it present for ETFs and futures and absent for the
  other kinds).
- Job `cboe-vol-indices` keeps `upsertPoints` with kind `index` and source `cboe`, unchanged.
- Checkpoint: handler tests pass.

### Phase 4: collector and tick client

- `prices.py`, job `daily-prices`, default `--symbols` = the 16 price ids; an unknown id is an `ArgumentError`
  ("--symbols for daily-prices must be price ids, not ...").
- It loads `ibkr_history.py` with `importlib.util.spec_from_file_location("ibkr_history", <working
  directory>/../research/ibkr_history.py)`. The tick client starts the collector with the working directory
  `services/openbb` of the checkout (`OPENBB_SERVICE_DIR`), so the non-editable install and `python -I` do not
  matter. If the file is missing the job fails with a message that names the path. `--warm` does not import it.
- Calls: ETFs `merged_daily(id, yahoo, start=..., adjust="adj_close")`; futures `merged_daily(id, yahoo,
  start=..., adjust="none")`; rates `index_daily("^IRX" | "^TNX", yahoo, start=...)`. Rows whose `source` is
  `treasury` are dropped (the Treasury par yield is not the Cboe index and an appended row is permanent); the id
  then counts as failed.
- Time budget: the ids run one after the other in one worker thread (`asyncio.to_thread`). The client is built
  with `paced_retries=0` and `timeout=30`, so a paced reply fails that id at once. The job starts no new id after
  180 s and reports the ids it did not reach as failed. Worst case: 180 s + 2 requests of 30 s = 240 s, below the
  step timeout of 330 s. The next hourly run reads the missed ids.
- `yahoo`: a synchronous callable, one HTTPS GET of
  `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?period1=<start>&period2=<now>&interval=1d&events=div%2Csplits`
  (`urllib`, the collector's User-Agent, 20 s timeout). It reads `chart.result[0]`: `timestamp`,
  `indicators.quote[0]` (open, high, low, close, volume), `indicators.adjclose[0].adjclose` and
  `meta.exchangeTimezoneName` for the row date; a row with a null value is skipped. No new dependency.
  `merge_sources` calls it only when IBKR does not cover the window.
- Window: `--since`, or 45 days back (one IBKR request returns about a year in either case; 45 days keeps the seam
  in the batch after a long outage). `--since` older than 120 days is an `ArgumentError`: the tick client posts
  chunks of 2000 rows per table, and a series split over two chunks would be refused on its second part. The
  repair for an older gap is the full import.
- Filter: complete sessions only, from `ctx.now` in New York time (`cli.run` already sets it; when it is `None`
  the job uses the current New York time). Rows with a missing or non-positive value are dropped.
- Output: `daily_series` rows for all requested ids (ETFs and futures: open, high, low, close, `adjClose`; for
  futures `adjClose` = close; IRX and TNX: close only) and `daily_bars` rows for ETFs and futures (volume in
  shares or contracts).
- Result mapping per id: rows emitted -> `ctx.ok()`; `Merged.warnings` -> `ctx.warn`; no row from any allowed
  source -> `ctx.failed(<id>, <error text of the merge>)`; the other ids continue, and the run is partial.
- Tests inject a fake `ibkr_history` client transport and a fake Yahoo callable through module-level factories of
  `prices.py`, and fix the clock through `run(now=...)`.
- Derived id: when TNX is requested, the job downloads the Shiller workbook as `_shiller()` of
  `qc-ports/fetch_data.py` does (the first `href` on `https://shillerdata.com/` that contains `ie_data.xls`; sheet
  `Data`; column 0 is the date as the number `YYYY.MM`, column 1 the price P, column 3 the earnings E; rows where
  the three cells are not numbers are skipped; `urllib`, 30 s timeout). It emits one close-only row per TNX date:
  `100 x (E[m-6] / P[m-6]) / TNX close`, where `m-6` is the month 6 months before the row's month and P and E are
  both from that month. This is `ey_tnx_ratio` of `qc_ports/data.py`; a test compares the two on the same input.
  Download failure or a missing month: a warning and no row for those dates. One download per run of the futures
  step.
- `tick.ts`: `CHILD_ENV_NAMES` gets `VERTEX_HISTORY_URL` and `VERTEX_DEPLOY_STATUS_TOKEN`.
- `vertex-openbb-run.sh`: only for job `daily-prices` it reads these two names from
  `~/.config/vertex/research-lenses.env` (mode 0600, already on the rig for the research lenses) and exports them.
  No second copy of the token; other jobs do not get it. If the file or a name is missing, the collector warns
  "IBKR history not configured" and uses Yahoo.
- Checkpoint: pytest and the tick tests pass.

### Phase 5: schedule

Format `name timeout_s every_s stage command`; steps of one stage run in parallel, stages run one after the other.

```text
daily-prices-etf           330  3600   1  ~/.local/bin/vertex-openbb-run daily-prices --symbols SPY,QQQ,DIA,IWM,GLD,SLV,USO --window mon-fri@17:20-24:00
daily-prices-futures       330  3600   2  ~/.local/bin/vertex-openbb-run daily-prices --symbols ES=F,NQ=F,YM=F,RTY=F,GC=F,SI=F,CL=F,IRX,TNX --window mon-fri@17:20-24:00
daily-prices-etf-late      330  10800  1  ~/.local/bin/vertex-openbb-run daily-prices --symbols SPY,QQQ,DIA,IWM,GLD,SLV,USO --window tue-sat@00:30-06:00
daily-prices-futures-late  330  10800  2  ~/.local/bin/vertex-openbb-run daily-prices --symbols ES=F,NQ=F,YM=F,RTY=F,GC=F,SI=F,CL=F,IRX,TNX --window tue-sat@00:30-06:00
cboe-vol-indices-late      330  3600   1  ~/.local/bin/vertex-openbb-run cboe-vol-indices --window tue-sat@00:00-06:00
```

- Measured from the rig on 2026-11-19: about 10 s for an id that is not in the vertex-history cache. 7 ETFs (2
  IBKR requests each) and 9 other ids are each below 240 s; the two groups are in different stages, so they do
  not use vertex-history at the same time.
- The late lines repair an evening in which every run failed (F1) and read a Cboe row published near or after
  midnight (F2), including Friday's row on Saturday.
- The header comment of the steps file gets one sentence for the new steps (append only; token only for
  `daily-prices`).

### Rollout (after CI and merge, outside market hours)

1. Web deploy with `infra/quantvps/restart-when-idle.sh`.
2. SPY bars, one time: build `t,o,h,l,c,v` from IBKR `TRADES` daily bars (split-adjusted, dividends not included,
   volume in shares; `ibkr_history.paged("SPY", ...)`) in `/tmp`, and replace the fixture series with
   `bun run vertex:bars:import -- /tmp/.../SPY.csv /tmp/.../SPY.manifest.json`; source text "IBKR TRADES daily via
   vertex-history, split-adjusted OHLC (dividends not included), fetched <date>". The files are deleted after.
3. Rig install (`infra/openbb/rig/install.sh`), with the timer running: the append rules make a scheduled run
   and the manual run safe in any order.
4. Catch-up by hand, in two commands (ETF ids, then the other ids) with `--since 2026-10-30` so both seam dates
   (2026-11-06 and 2026-11-03) are in the batch.
5. Check: the SQL of the goals, the rig journal (rows written, then 0 on the next run), and the next engine
   comparison driver run.

## Tests (written before the code)

| Phase | File | Cases (input -> expected) |
| --- | --- | --- |
| 1 | `openbb-server.test.ts` | `SPY` with `adjClose` accepted; `AAPL` refused; `adjClose: 0` refused; `daily-prices` + `VIX` refused; `cboe-vol-indices` + `SPY` refused; `cboe-vol-indices` + table `daily_bars` refused; bar row with `volume: -1` refused; `SPY` without `adjClose` refused; `TNX` with `adjClose` refused; the same job and id cases on `OpenbbBatchDocumentSchema` |
| 2 | `market-daily-series-upsert.test.ts`, integration `market-daily-series.test.ts` | seam 100/adj 50, incoming seam 100/adj 80, next 110/adj 88 -> stored adj 55; no series -> refusal; batch starts after the seam -> refusal naming the seam date; seam close 600.00 vs 600.50 with tolerance 0.005 -> appended (0.08%); 600 vs 604 -> refusal (0.67%); 600 vs 604 with null -> appended; rows before the seam ignored; unsorted input with a duplicate date -> sorted, one row; digest equals the digest of the stored rows; no third argument -> the existing behaviour; null stored adj with link -> refusal; second call -> `written: 0`; stored rows byte-equal before and after |
| 2 | `market-bars.test.ts`, integration `openbb.test.ts` | append 1 bar after the seam -> count + 1, `last_t` moved; no series -> refusal; no seam bar -> refusal; close mismatch -> refusal; high below low -> refusal; null volume stored null; second call -> 0 |
| 3 | `openbb-server.test.ts` | each row of the kind table calls the method with those options; date `2026-11-19` -> `t` 1795046400000; one refused id of three -> two written, `BAD_REQUEST` names the id and the reason; volatility job unchanged; missing bars repository -> the existing failure |
| 4 | `test_jobs.py`, `test_units.py` | 17:14 New York: today's row dropped; 17:15: kept; a row dated tomorrow dropped at any time; IBKR error -> Yahoo rows; both fail -> `failed`, other ids emitted; a `treasury` row dropped; paced reply -> that id failed, no sleep; budget of 180 s used -> the rest failed; `--since` 121 days back -> error; ETF rows carry `adjClose`, IRX none; bars only for ETFs and futures; EY ratio equals `qc_ports.data.ey_tnx_ratio`; missing month -> warning, no row; unknown `--symbols` -> error; missing `ibkr_history.py` -> error naming the path |
| 4 | `tick.test.ts` | the child gets the two names when set; other variables stay out |
| 5 | `install.test.ts` | the five new lines parse; windows valid; step names unique |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A wrong row is appended (bad bar, later revision by the source) and stays | Only complete sessions; ETF close check on the seam; a wrong row is corrected with the full import (`vertex:series:import`, `vertex:bars:import`). Open evidence item for the implementation: record how Yahoo dates the evening futures session; if it differs from IBKR, the Yahoo path drops today's futures row. |
| ETF split or a 0.5% source difference stops that id | The run is recorded failed with the id and the reason; other ids continue; repair is the full import. This is rare (no split is announced for the 7 ETFs). |
| IBKR and Yahoo both fail, a refusal repeats, or the Shiller site stops | The run is failed or partial in the run records (`openbb.recordRun`) and in the rig journal; the late lines retry. No freshness monitor is added here; the job's receipt names it as a follow-up card. |
| A paced or slow IBKR reply uses the step budget | `paced_retries=0`, 30 s per request, no new id after 180 s; worst case 240 s against the step timeout of 330 s; the next run repeats. |
| The history token reaches the Python child, which also calls Yahoo and shillerdata.com | The token is sent only by `ibkr_history` to the vertex-history URL, never printed; only the `daily-prices` job gets it; it stays in one file on the rig. It is the token the research lenses on the same host already use; rotation changes that one file. |
| Yahoo's chart endpoint is unofficial and can block | It is the fallback only; when it fails the id fails for that run. |

Revert: remove the five step lines and reinstall the rig unit; revert the PR. Appended rows remain in the tables.

## Acceptance check

The three goals, checked with read-only SQL on the live database, plus: the rig journal shows the new steps ok
with rows written and 0 rows on the second run; goal 2 holds on 3 sessions in a row including one Friday; the
next engine comparison driver run (06:15 New York) reads bars that end at the last session; the PR checks are
green.
