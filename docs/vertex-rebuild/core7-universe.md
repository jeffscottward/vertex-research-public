# Core 7 default backtest universe

Owner decision 2026-11-03: every Vertex backtest, sweep, Autopilot and strategy-library re-run starts with the "Core 7 futures" universe. The "Core 7 ETF twins" universe is the second choice. This page describes both universes, their data, the data coverage and one re-run of the QuantJourney strategy library on them.

Research only. Nothing on this page creates, routes or simulates an order. Nothing was promoted to paper trading.

## The universe

The universes are defined in `packages/shared/src/universes/index.ts` (`CORE7_MARKETS`, `BACKTEST_UNIVERSES`, `DEFAULT_BACKTEST_UNIVERSE_ID = "core7-futures"`).

| Market | Future (Yahoo) | ETF twin |
| --- | --- | --- |
| S&P 500 | `ES=F` | `SPY` |
| Nasdaq-100 | `NQ=F` | `QQQ` |
| Dow 30 | `YM=F` | `DIA` |
| Russell 2000 | `RTY=F` | `IWM` |
| Gold | `GC=F` | `GLD` |
| Silver | `SI=F` | `SLV` |
| WTI crude oil | `CL=F` | `USO` |

## Owner rule

- The futures are research signals only. Vertex places no futures orders.
- A live expression of a signal is options on the ETF twin only, within the master trading rules (2% maximum loss gate).
- A backtest result on this universe is research. It is not a promotion to paper or live trading.

## Where the default applies

- Forms: `/instant-backtest`, `/backtest-runs`, `/backtest-sweeps` and `/autopilot` open with the Universe select on "Core 7 futures" and preselect its first stored member (`ES=F` when its bars are stored). The other choices are "Core 7 ETF twins" and "All stored series". When no member of the chosen universe has stored bars, the form says so and lists all stored series.
- `/backtest-runs` can queue one run per stored member of the chosen universe, and it reads `?universe=<id>&strategy=<id>`. The library strategy page links "Re-run on Core 7 futures" to that form.
- API (for agents and other API clients; the forms read the shared module directly): `instantBacktest.universes` returns both universes, `defaultUniverseId: "core7-futures"` and the stored timeframes of each member (test: `packages/api/src/instant-backtest.test.ts`).
- Autopilot refuses to hand a campaign on any `=F` future to paper. For a Core 7 future the refusal names the ETF twin.
- Stored bar symbols may contain `=` since migration `0045_market_bar_futures_symbols`. The forms show a member only after its bars are imported (see How to refresh).

## Data and roll method

Source: Yahoo Finance daily bars through `yfinance` 0.2.66, `period="max"`, `interval="1d"`, `auto_adjust=False`. The script is `research/backtests/core7/fetch_data.py`. The data is not in the repository: the Yahoo terms do not allow redistribution. The fetch writes it to `~/Documents/reports/vertex-core7/data` on the rig.

Futures (verified in the fetched data):

- A Yahoo `=F` symbol is a continuous front-month series. It is not back-adjusted. When Yahoo moves to the next contract, the price jumps by the spread between the two contracts.
- A strategy on these bars sees each roll gap as a return. Buy and hold on these bars is the price change of the series. It is not the return of a rolled futures position.
- `adj_close` equals `close` on every futures row.
- `coverage.json` lists, per future, the 5 largest close-to-close moves and the 5 days where the move differs most from the ETF twin's move on the same day. The second list shows the roll gaps:

| Future | Largest close-to-close moves | Largest differences from the ETF twin (future vs twin) |
| --- | --- | --- |
| `ES=F` | 2008-10-13 +14.1%, 2008-10-28 +12.5%, 2020-03-16 -10.4% | 2020-03-20 +1.4% vs -4.9%, 2020-03-23 -8.9% vs -2.6%, 2009-03-20 +0.7% vs -2.8% |
| `NQ=F` | 2001-01-03 +16.7%, 2008-10-13 +13.7%, 2008-10-28 +12.6% | 2020-03-20 +1.7% vs -3.9%, 2020-03-23 -5.8% vs -0.1% |
| `YM=F` | 2008-10-13 +13.6%, 2008-10-28 +13.5%, 2020-03-24 +11.4% | 2020-03-20 +1.3% vs -4.7%, 2020-03-23 -8.7% vs -3.0%, 2020-06-19 +1.8% vs -1.0% |
| `RTY=F` | 2020-03-16 -13.9%, 2020-03-12 -12.1%, 2020-03-24 +10.1% | 2020-03-20 +2.0% vs -2.4%, 2024-12-23 +2.9% vs -0.2%, 2026-03-20 0.0% vs -2.2% |
| `GC=F` | 2008-09-18 +20.4%, 2006-07-13 +11.3%, 2026-01-30 -10.8% | 2008-09-19 -3.6% vs +3.8%, 2008-09-18 +20.4% vs +13.3%, 2009-03-19 +7.8% vs +1.4% |
| `SI=F` | 2026-01-30 -31.3%, 2011-09-23 -17.8%, 2008-08-15 -16.3% | 2026-01-27 -8.3% vs +3.3%, 2010-11-09 +5.4% vs -3.6%, 2008-09-18 +8.8% vs -0.1% |
| `CL=F` | 2020-04-30 +25.1%, 2020-04-02 +24.7%, 2020-03-09 -24.6% | 2008-12-22 +17.8% vs -7.4%, 2020-04-30 +25.1% vs +6.2%, 2020-04-22 -24.6% vs -40.4% |

- The index-future differences fall on a quarterly expiry Friday (third Friday of March, June or December: 2009-03-20, 2020-03-20, 2020-06-19, 2026-03-20) or on the next trading day (2020-03-23, 2024-12-23). `CL=F` on 2008-12-22 rises 17.8% while `USO` falls 7.4%. These dates are consistent with a contract roll. The exact roll date of each Yahoo series was not checked against the exchange calendar (unverified).
- The largest plain moves of the index futures are market moves (October 2008, March 2020), not roll gaps: an index roll gap is small compared with them.
- `CL=F` traded below zero on 2020-04-20 (low -40.32) and opened at -14.00 on 2020-04-21. Both rows have a non-positive price and are dropped.

ETF twins:

- Open, high, low and close are split-adjusted only. They do not include dividends. `adj_close` also includes dividends.
- The import files (below) use the split-adjusted prices, the same basis as the stored `SPY` series. The re-run uses `parsePriceCsv` (`scripts/research/quantjourney.ts`), which scales OHLC by `adj_close / close`, so the ETF re-runs include dividends.

Intraday route: IBKR `CONTFUT` bars through `vertex-history` (`docs/vertex-rebuild/quantvps-status-endpoint.md`) are the route for intraday futures bars where needed. That service allows at most 1 year of daily bars per request, so it is not used for this default daily history.

## Coverage

Fetched 2026-11-04T02:30:45Z with yfinance 0.2.66. Full data: `research/backtests/core7/coverage.json`.

- Reference calendar: the `SPY` trading dates of the same fetch.
- Reference sessions: reference dates in [first, last] of the symbol.
- Missing sessions: reference dates without a bar. For every future except `CL=F`, most missing sessions are dropped rows.
- Extra dates: bars on dates that are not `SPY` trading dates, for example days when the stock market was closed but a futures session took place (2025-01-09, 2025-07-04).
- Dropped rows: rows that the Vertex bar importer would reject (a missing or non-positive price, low above open or close, high below open or close). They are dropped and counted, never repaired. `GC=F` (441, all in 2001 to 2011) and `SI=F` (243, all in 2006 to 2011) have many rows where the high or low does not contain the open and close. `YM=F` has 22 such rows in 2024 and 2025. `CL=F` has 2 non-positive rows (2020-04-20 and 2020-04-21) and 7 high/low rows.
- The fetch ran at 21:30 New York time, after the 2026-11-03 ETF close. Whether the last futures bar (2026-11-03) contains any evening trading of the next session is not verified.

| Symbol | First date | Last date | Rows | Reference sessions | Missing sessions | Extra dates | Dropped rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ES=F` | 2000-09-18 | 2026-11-03 | 6587 | 6571 | 12 | 28 | 10 |
| `NQ=F` | 2000-09-18 | 2026-11-03 | 6573 | 6571 | 26 | 28 | 24 |
| `YM=F` | 2002-04-05 | 2026-11-03 | 6159 | 6186 | 31 | 4 | 29 |
| `RTY=F` | 2017-07-10 | 2026-11-03 | 2347 | 2344 | 0 | 3 | 0 |
| `GC=F` | 2000-08-30 | 2026-11-03 | 6129 | 6583 | 460 | 6 | 441 |
| `SI=F` | 2000-08-30 | 2026-11-03 | 6328 | 6583 | 261 | 6 | 243 |
| `CL=F` | 2000-08-23 | 2026-11-03 | 6569 | 6588 | 24 | 5 | 9 |
| `SPY` | 1993-01-29 | 2026-11-03 | 8499 | 8499 | 0 | 0 | 0 |
| `QQQ` | 1999-03-10 | 2026-11-03 | 6957 | 6957 | 0 | 0 | 0 |
| `DIA` | 1998-01-20 | 2026-11-03 | 7243 | 7243 | 0 | 0 | 0 |
| `IWM` | 2000-05-26 | 2026-11-03 | 6649 | 6649 | 0 | 0 | 0 |
| `GLD` | 2004-11-18 | 2026-11-03 | 5524 | 5524 | 0 | 0 | 0 |
| `SLV` | 2006-04-28 | 2026-11-03 | 5162 | 5162 | 0 | 0 | 0 |
| `USO` | 2006-04-10 | 2026-11-03 | 5175 | 5175 | 0 | 0 | 0 |

Rows are the bars in the import file, after dropped rows. All 14 import files pass the importer rules (header `t,o,h,l,c,v`, SHA-256 of the file equals `normalizedSha256`, `validateMarketBars` in `packages/db/src/server/market-bars.ts`, `t` at UTC midnight). Nothing was written to a database.

## How to refresh

1. Fetch (rig, public data, about 30 s):

   ```sh
   uv run --no-project --python 3.12 --with yfinance==0.2.66 \
     python research/backtests/core7/fetch_data.py \
     --out ~/Documents/reports/vertex-core7/data \
     --coverage research/backtests/core7/coverage.json
   ```

   The script retries a symbol once after 60 s when Yahoo returns nothing or an error (for example HTTP 429).

2. Import the 14 series (one command per symbol; each import replaces the whole stored series):

   ```sh
   # from the repository root
   d=~/Documents/reports/vertex-core7/data/import
   for s in ES=F NQ=F YM=F RTY=F GC=F SI=F CL=F SPY QQQ DIA IWM GLD SLV USO; do
     DATABASE_URL=... bun run vertex:bars:import -- "$d/$s-1d.csv" "$d/$s-1d.manifest.json"
   done
   ```

3. Re-run the strategy library:

   ```sh
   bun run research:core7 -- --data ~/Documents/reports/vertex-core7/data
   ```

   This writes `research/backtests/core7/rerun-results.json`. The logic is in `scripts/research/core7-rerun.ts`.

4. Format the two JSON files before a commit (the repository formatter checks JSON): `bunx --bun --no-install biome format --write research/backtests/core7/`.

## Re-run results (2026-11-04)

Strategies: the 9 entries of `research/backtests/quantjourney/library.json` with a Vertex DSL definition. 8 are daily and run on every member of both universes. W09 is an hourly definition and is not run, because the Core 7 data set is daily only. The other 41 strategies need the QuantJourney adapter (fixed ticker lists) and are not re-run on Core 7.

Method:

- Each symbol runs on its full history, so per-symbol figures cover different periods.
- Combined: equal starting capital per member, never rebalanced, on the common window of all members, each sleeve rebased at the window start. Futures window: 2017-07-10 to 2026-11-03 (`RTY=F` starts last). ETF window: 2006-04-28 to 2026-11-03 (`SLV` starts last). The two windows differ, so do not compare the two columns directly.
- Cost: 10 bp per side on every position change. Statistics: Vertex `returnStats`, risk-free rate 0.
- O01 and O18 give the same series (same rule: long while SMA 20 is above SMA 50). O02 and W03 also give the same series (same RSI 35/60 rule).

Combined results (CAGR / Sharpe / max drawdown):

| Strategy | Core 7 futures | Core 7 ETF twins |
| --- | --- | --- |
| Buy and hold | 12.5% / 0.77 / -32.4% | 9.9% / 0.64 / -44.7% |
| O01 Market SMA Crossover | 7.6% / 0.69 / -21.0% | 5.0% / 0.51 / -21.0% |
| O02 Market RSI Reversion | 5.1% / 0.50 / -30.2% | 3.1% / 0.33 / -37.1% |
| O06 Protective Stop Loss | 5.8% / 0.60 / -19.8% | 4.0% / 0.47 / -22.8% |
| O12 Bracket Trend | 2.2% / 0.67 / -7.7% | 2.3% / 0.66 / -7.5% |
| O13 Bracket RSI Reversion | 0.5% / 0.12 / -8.7% | -0.6% / -0.09 / -27.9% |
| O18 Signal-Change Rotation (orders) | 7.6% / 0.69 / -21.0% | 5.0% / 0.51 / -21.0% |
| W01 Daily SMA Trend | 7.4% / 0.60 / -27.8% | 7.4% / 0.63 / -28.6% |
| W03 Weekly RSI Reversion | 5.1% / 0.50 / -30.2% | 3.1% / 0.33 / -37.1% |

Per symbol, full history (CAGR / Sharpe):

| Strategy | `ES=F` | `NQ=F` | `YM=F` | `RTY=F` | `GC=F` | `SI=F` | `CL=F` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Buy and hold | 6.5% / 0.42 | 8.1% / 0.43 | 6.8% / 0.45 | 7.7% / 0.43 | 10.7% / 0.65 | 9.2% / 0.43 | 4.2% / 0.31 |
| O01 | 2.8% / 0.29 | 5.9% / 0.45 | 2.3% / 0.26 | 4.2% / 0.33 | 7.1% / 0.55 | 4.2% / 0.29 | 2.9% / 0.24 |
| O02 | 1.9% / 0.20 | 2.9% / 0.24 | 3.2% / 0.29 | 1.4% / 0.17 | 4.5% / 0.47 | 6.8% / 0.45 | 0.3% / 0.16 |
| O06 | 1.9% / 0.23 | 3.4% / 0.32 | 2.1% / 0.25 | -5.4% / -0.40 | 8.2% / 0.63 | 7.0% / 0.41 | 0.1% / 0.11 |
| O12 | 0.8% / 0.16 | 1.7% / 0.29 | -0.5% / -0.05 | 0.7% / 0.14 | 3.1% / 0.52 | 2.2% / 0.32 | -0.5% / -0.04 |
| O13 | -1.6% / -0.15 | -0.3% / 0.01 | 0.2% / 0.07 | -3.5% / -0.37 | 2.1% / 0.36 | 2.2% / 0.28 | -9.3% / -0.79 |
| O18 | 2.8% / 0.29 | 5.9% / 0.45 | 2.3% / 0.26 | 4.2% / 0.33 | 7.1% / 0.55 | 4.2% / 0.29 | 2.9% / 0.24 |
| W01 | 6.6% / 0.57 | 10.6% / 0.69 | 4.8% / 0.45 | -2.3% / -0.05 | 8.8% / 0.62 | 6.9% / 0.38 | 4.5% / 0.30 |
| W03 | 1.9% / 0.20 | 2.9% / 0.24 | 3.2% / 0.29 | 1.4% / 0.17 | 4.5% / 0.47 | 6.8% / 0.45 | 0.3% / 0.16 |

| Strategy | `SPY` | `QQQ` | `DIA` | `IWM` | `GLD` | `SLV` | `USO` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Buy and hold | 10.7% / 0.64 | 10.5% / 0.51 | 9.0% / 0.56 | 8.5% / 0.46 | 10.0% / 0.61 | 5.9% / 0.34 | -5.8% / 0.03 |
| O01 | 5.5% / 0.51 | 6.2% / 0.43 | 3.5% / 0.36 | 3.5% / 0.30 | 5.0% / 0.42 | 3.7% / 0.28 | 5.3% / 0.34 |
| O02 | 2.9% / 0.27 | 2.2% / 0.21 | 3.1% / 0.28 | 2.3% / 0.22 | 2.8% / 0.32 | 5.6% / 0.37 | -6.2% / -0.09 |
| O06 | 3.8% / 0.40 | 4.7% / 0.38 | 3.1% / 0.33 | 1.7% / 0.19 | 4.3% / 0.39 | 4.7% / 0.32 | 3.5% / 0.27 |
| O12 | 1.4% / 0.24 | 2.8% / 0.45 | 0.4% / 0.09 | 2.3% / 0.36 | 1.5% / 0.27 | 1.5% / 0.23 | 3.5% / 0.48 |
| O13 | -0.0% / 0.04 | 0.1% / 0.06 | -0.9% / -0.08 | -2.1% / -0.20 | 1.4% / 0.24 | 0.5% / 0.10 | -12.4% / -0.99 |
| O18 | 5.5% / 0.51 | 6.2% / 0.43 | 3.5% / 0.36 | 3.5% / 0.30 | 5.0% / 0.42 | 3.7% / 0.28 | 5.3% / 0.34 |
| W01 | 9.4% / 0.72 | 10.7% / 0.64 | 5.4% / 0.47 | 1.9% / 0.20 | 7.9% / 0.59 | 5.2% / 0.33 | 0.7% / 0.15 |
| W03 | 2.9% / 0.27 | 2.2% / 0.21 | 3.1% / 0.28 | 2.3% / 0.22 | 2.8% / 0.32 | 5.6% / 0.37 | -6.2% / -0.09 |

Reading:

- No strategy beats buy and hold on CAGR in either combined universe. Several reduce the drawdown (O12 about -8% against -32% and -45%).
- O01 and O18 (SMA 20/50) lead in the futures universe (7.6% CAGR, max drawdown -21.0%). W01 (SMA 50/200 trend) leads in the ETF universe (7.4% CAGR, -28.6% against -44.7%).
- RSI reversion with a bracket (O13) loses money on crude oil in both forms (`CL=F` -9.3%, `USO` -12.4%).
- These are single runs without the multiple-testing gates of the QuantJourney re-run. They are not evidence of an edge.

Research only. Nothing is promoted (`"promoted": []` in `rerun-results.json`).
