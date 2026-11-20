# Plan: scheduled refresh of stored daily prices

![Before and after: 17 daily series and 14 bar series get a scheduled writer](before-after.png)

![Data flow: collector on the rig, tick client, openbb.ingest, Postgres](data-flow.png)

Card `vertex-daily-series-refresh`. Flow: bug fix (one-page plan). Research data only: the change places no
order and touches no trading unit.

## Problem

Measured on the live database on 2026-11-19 (read-only SQL):

| Table | Series | Last date | Writer |
| --- | --- | --- | --- |
| `market_daily_series` | 14 Cboe volatility indices | 2026-11-18 | rig step `cboe-vol-indices` (hourly, 16:45-24:00 New York) |
| `market_daily_series` | 7 ETFs, 7 futures, IRX, TNX, EY_TNX_RATIO | 2026-11-06 | none (manual import on 2026-11-09) |
| `market_bar_series` (1d) | 13 symbols | 2026-11-03 | none (manual import) |
| `market_bar_series` (1d) | SPY | 2024-12-31 | none (test fixture, 2015-2024) |

Two faults:

1. 17 daily series and all 14 bar series have no scheduled writer. Strategy series, backtests, Autopilot entry
   filters and the engine comparison driver (06:15 New York) read old data.
2. Cboe publishes the session row between about 22:15 and 23:30 New York. The `cboe-vol-indices` window ends at
   24:00 and the step runs one time per hour, so a late row waits until 16:45 on the next weekday. A Friday close
   waits until Monday.

## Terms

- **Price ids**: the 16 fetched ids. ETFs `SPY QQQ DIA IWM GLD SLV USO`; futures `ES=F NQ=F YM=F RTY=F GC=F SI=F
  CL=F`; rate indices `IRX TNX`.
- **Derived id**: `EY_TNX_RATIO` = 100 x Shiller earnings / price of the month 6 months back / TNX yield in percent.
- **Seam date**: the stored last date of a series at the time of an append.
- **Complete session**: a row dated before today (New York), or dated today when the New York time is 17:15 or
  later. CME closes the daily futures bar at 17:00. IBKR returns the bar of the session in progress (on
  2026-11-19 at 19:20 it returned an `ES=F` row dated 2026-11-20), so the job must drop rows that are not complete.

## Change

### 1. Contract (`packages/api/src/contracts/openbb.ts`)

- New job `daily-prices`. It may write `daily_series` and the new table `daily_bars`.
- `OPENBB_PRICE_SERIES`: a constant map id -> kind for the 16 price ids and the derived id (`etf`, `future`,
  `index`, `derived`).
- `OpenbbDailySeriesRowSchema.seriesId` accepts the 14 volatility ids and the 17 ids of the map. The row gets an
  optional `adjClose` (finite, above 0, or null).
- `OpenbbDailyBarRowSchema`: `{ symbol (one of the 14 ETF and futures ids), date, open, high, low, close, volume
  (>= 0 or null) }`.
- The ingest input refuses a batch where the id group and the job do not match: `cboe-vol-indices` writes only
  volatility ids, `daily-prices` writes only ids of the map.

### 2. Handler (`packages/api/src/server/openbb.ts`)

- `daily_series`: kind comes from the map (volatility ids stay `index`). Source is `cboe` for the volatility job
  and `vertex-openbb daily-prices (IBKR first, Yahoo gaps)` for the new job. `adjClose` passes through.
- `daily_bars`: rows are grouped by symbol, `date` becomes `t` = 00:00 UTC of the date in milliseconds (the stored
  convention), and the repository method `appendBars` writes them.

### 3. Repositories (`packages/db`)

- `market-daily-series.ts` `upsertPoints`: the append rule stays (a series another source owns gets only dates
  after its last date; stored rows are never overwritten). New `adj_close` rule for appended rows:
  - The stored `adj_close` basis is kept. For each appended row: `adj_close = incoming adj_close x stored
    adj_close(seam) / incoming adj_close(seam)`. Returns across the seam are then correct after a dividend, and the
    step of `adj_close / close` on an ex-dividend date stays readable (`leveraged_etf/prices.py` reads it).
  - The batch must hold the seam date when an appended row has an `adj_close`. If it does not, the append fails
    with a message that names the date to send from (`--since`).
  - If the incoming close on the seam date differs from the stored close by more than 0.5%, the append of that
    series fails (a split or a bad bar). The fix is the full import (`bun run vertex:series:import`).
    This check runs only for rows with an `adj_close` (ETFs). Futures are stored as a front-month series that is
    not back-adjusted, so a roll difference is not an error.
  - Rows without `adj_close` (indices, the derived id) are appended as they are. Futures send `adj_close = close`
    and get the same rule without the 0.5% check.
  - Null `adj_close` on appended ETF rows was rejected: `qc_ports/data.py` drops rows without `adj_close`, so
    readers would still see old data. A weekly full replace was rejected: it needs the CSV import path, and the
    app must not read data files.
- `market-bars.ts` new `appendBars(series, bars)`: in one transaction with the series lock, write only bars with
  `t` after `last_t`, update `last_t` and `bar_count`; create the series when it does not exist. Stored bars are
  never changed. Returns the series and the number of bars written.

### 4. Collector job (`services/openbb/vertex_openbb/jobs/prices.py`)

- For each requested price id: `ibkr_history.merged_daily` / `index_daily` (IBKR first through vertex-history;
  Yahoo fills gaps and covers an IBKR outage). Yahoo is read with one HTTPS request to the chart v8 endpoint
  (the locked environment has no `yfinance`; no new dependency). Window: the last 10 days, or `--since`.
- Keeps complete sessions only (see Terms). Drops rows with a missing or non-positive value.
- Emits `daily_series` rows (ETFs with `adjClose` from IBKR `ADJUSTED_LAST` or Yahoo `adjclose`; futures with
  `adjClose = close`; IRX and TNX close and OHLC in percent) and `daily_bars` rows for ETFs and futures (volume in
  shares or contracts).
- `EY_TNX_RATIO`: when TNX is in the request, the job reads the Shiller workbook (`xlrd` is in the lock) and emits
  one close-only row per TNX date. When the Shiller month 6 months back is not in the workbook, the job warns and
  emits no row for that date.
- The job imports `services/research/ibkr_history.py` from the same checkout (the path that
  `qc-ports/fetch_data.py` uses). No CSV or JSON file is written.
- Measured on 2026-11-19 from the rig: about 10 s for each id that is not in the vertex-history cache. 16 ids
  need about 160 s; the fetcher deadline is 240 s. The schedule splits the ids into two steps to keep a margin.

### 5. Schedule (`infra/openbb/rig/vertex-openbb.steps`)

```text
daily-prices-etf      330  3600  1  vertex-openbb-run daily-prices --symbols SPY,QQQ,DIA,IWM,GLD,SLV,USO --window mon-fri@17:20-24:00
daily-prices-futures  330  3600  2  vertex-openbb-run daily-prices --symbols ES=F,NQ=F,YM=F,RTY=F,GC=F,SI=F,CL=F,IRX,TNX --window mon-fri@17:20-24:00
cboe-vol-indices-late 330  3600  1  vertex-openbb-run cboe-vol-indices --window tue-sat@00:00-06:00
```

- The first run after 17:20 writes the session. Later runs in the window write 0 rows (append rule) and repair a
  failed first run. The two steps use different stages, so they do not run at the same time (vertex-history
  serializes requests).
- The late Cboe step covers a row that Cboe publishes after midnight, and Friday's row on Saturday. The window
  parser keeps its rule (a window does not cross midnight); a second line is enough.
- Rig environment: `~/.config/vertex/openbb.env` gets `VERTEX_HISTORY_URL` and `VERTEX_DEPLOY_STATUS_TOKEN` (the
  values that `research-lenses.env` holds; mode 0600; values are never printed).

### 6. One-time data steps after the deploy

1. Catch-up: `vertex-openbb-run daily-prices --since 2026-11-01` (the seam dates 2026-11-06 and 2026-11-03 must be
   in the batch).
2. SPY bars: replace the 2015-2024 fixture series with real bars one time with the existing
   `bun run vertex:bars:import` (source text as for the 13 other symbols), then the catch-up appends to it.

## Series excepted from the acceptance check

- `EY_TNX_RATIO` has a monthly input (Shiller). It gets a row for each TNX date while the Shiller month 6 months
  back exists in the workbook. If the workbook stops (no update for more than 6 months), this series stops and the
  job run shows a warning. It is the only excepted series.
- On a day when US stocks trade and CME or Cboe has no session (or the reverse), a series has no row for that day.
  The check uses the last session of each series.

## Out of scope

New symbols, intraday bars, changes to strategy logic, a change to the volatility job, and a change to the window
parser.

## Tests (written before the code)

- Contract: accepted and refused ids, `adjClose`, `daily_bars` rows, job and id group pairs, job and table pairs.
- Handler: kind and source by id group, bars grouping and the `t` conversion, error mapping.
- Repositories (isolated Postgres): append after the seam, `adj_close` link with and without a dividend, missing
  seam, 0.5% close check, futures without the check, second run writes 0, `appendBars` create, append, no
  overwrite, count.
- Collector (pytest, recorded fixtures): complete-session cutoff before and after 17:15, future-dated row dropped,
  Yahoo fallback when IBKR fails, `EY_TNX_RATIO` values and the missing-month warning, `--symbols` validation.
- Schedule: `install.test.ts` and the tick tests accept the three new lines.

## Acceptance check

As in the task file: no stale daily series (except as named above) and no stale 1d bar series at 09:00 UTC after a
trading day; the rig journal shows the new steps ok with rows written, then 0 rows on the second run; the Cboe
last date equals T at 06:00 New York on T+1 for 3 sessions including one Friday; the engine comparison driver
reads bars that end at the last session; PR checks green and new code at 100% coverage.

## Risk and revert

- Risk: a wrong appended row. Limits: only complete sessions, only dates after the stored last date, stored rows
  never change, a close mismatch on the seam stops the ETF append.
- Revert: remove the three step lines and reinstall the rig unit; revert the PR. Appended rows stay valid data;
  the full import replaces a series when needed.
- Deploy: web deploy through `infra/quantvps/restart-when-idle.sh` outside market hours, then the rig install.
