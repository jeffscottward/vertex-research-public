# Golden backtest battery

Updated: 2026-10-23. Research and backtest evidence only. Nothing in the battery creates, routes or simulates broker orders, and no result authorizes a trade.

The battery runs fixed sample strategies on frozen daily bars through the Vertex code and through independent reference code. It then compares the results within one stated tolerance. The current numbers are in [summary.md](summary.md) and, machine-readable, in [results.json](results.json).

## What is compared

|Check|Vertex code|Reference|Compared values|
|---|---|---|---|
|Backtests|`packages/api/src/instant-backtest-engine.ts`|`services/research/tests/golden/pandas_reference.py` (pandas)|Every trade (entry bar, exit bar, exit reason, prices, P&L, net return), final equity, total return, CAGR, maximum drawdown, Sharpe, Sortino, profit factor, win rate, exposure, buy-and-hold return and drawdown|
|Engine indicators|`rollingMean` and `wilderRsi` in the engine|TA-Lib SMA and RSI|SMA 20, SMA 50, RSI 14 at checkpoint bars|
|Chart indicators|`apps/web/src/features/charts/indicator-math.ts`|TA-Lib; pandas for SMMA|SMA, EMA, SMMA, LWMA, ATR, Bollinger Bands, Parabolic SAR, MACD, Stochastic, ADX with +DI and −DI at checkpoint bars|
|Python indicators|`services/research/indicators/core.py`|TA-Lib; pandas for SMMA|The same indicators plus RSI, on every bar (at generation time) and at checkpoint bars (in the test)|

Checkpoint bars are every 50th bar and the last bar of each fixture (52 bars). Each indicator runs over all 2,516 bars first, so the checkpoints test the full recursion. The first bar with a value must also equal the TA-Lib first bar, except the MACD line and Stochastic %K, which start earlier on purpose ([indicators.md](../indicators.md)).

The operations test runs the TypeScript checks only. The Python rows in the results are values recorded when the reference was generated; `services/research/tests/test_golden_battery.py` rechecks the Python library, and CI does not run it.

## Cases

Eight cases: two symbols (SPY, QQQ), two rules and two cost settings (0 and 5 basis points per side). No stop-loss and no take-profit.

- SMA crossover 20/50: long when SMA 20 is above SMA 50 after the close; flat otherwise.
- RSI(14) 30/70 mean reversion: long after RSI falls below 30; flat after RSI rises above 70; hold between the levels. The engine rule is `rsiReversion`. The oRPC contract does not expose it yet.

## Shared conventions

The two backtest paths share these written rules. They share no code.

- Bars are total-return bars: open, high, low and close are each multiplied by adj_close/close.
- A signal uses data up to the close of bar i. The fill is at the open of bar i + 1. A position still open after the last bar closes at the last close.
- Long only, fully invested or flat. Starting equity is 1.
- Cost is charged in basis points of the traded value on entry and on exit.
- Statistics use simple per-bar returns and a risk-free rate of 0. Annualization uses the observed number of bars per elapsed calendar year (365.25 days), so the Sharpe ratio uses about 251.6 bars per year here, not 252. Profit factor uses the equity P&L of each trade.

The reference was written after reading the engine and uses the same metric definitions. A match proves that the two implementations agree under these conventions. It does not prove that the conventions equal the AlgoTradingHub or MT5 definitions (for example Sharpe with 252 periods or a risk-free rate, or profit factor on fixed position sizes); compare those definitions separately.

The engine walks the bars once and holds cash and units. The pandas reference builds a target-position column with vectorized operations and multiplies per-bar growth factors. Agreement between these two designs is the evidence.

## Tolerance

`|vertex − reference| ≤ 1e-9 · max(1, |reference|)` for every price, P&L, return, ratio and indicator value. Trade count, entry bar, exit bar and exit reason must be equal. The paths do the same arithmetic in a different order, so only floating-point rounding may differ (observed: below 1e-11 for backtest values; below 1e-10 absolute, about 1e-13 relative, for indicator values). A logic error, such as one extra trade or a fill one bar late, changes values by 1e-4 or more.

## Data

|Item|Value|
|---|---|
|Provider|Yahoo Finance public chart endpoint v8, interval 1d. No account, key or payment. The instant-backtest evidence and the quant-lab research branch use the same source.|
|Symbols and range|SPY and QQQ, 2015-01-02 to 2024-12-31, 2,516 bars each|
|Fields|`date` (exchange-local trading date), `open`, `high`, `low`, `close` (split-adjusted USD), `adj_close` (split- and dividend-adjusted close), `volume`. Prices are rounded to 6 decimals.|
|Delay|End-of-day history only. The newest bar is from 2024-12-31.|
|License|Yahoo Finance data is for personal, non-commercial use and must not be redistributed. The CSV files are a test fixture in this private repository. Do not publish them, copy them to report pages or ship them in a build. If the repository becomes public, remove the fixture and replace it with data that may be redistributed.|
|Files|`tests/fixtures/golden/SPY-1d.csv`, `tests/fixtures/golden/QQQ-1d.csv`, `tests/fixtures/golden/manifest.json` (SHA-256 of each file and of each original download)|

The fixture is the one exception to the rule in [instant-backtest.md](../vertex-rebuild/instant-backtest.md) that vendor data stays under `private/`: the owner's parity plan requires a committed, frozen fixture so that CI can run the battery. IBKR history was not used because its terms also forbid redistribution and a fetch needs the QuantVPS history service.

Yahoo restates adjusted closes after each new dividend, so a new download gives different numbers. Do not rebuild the fixture unless the reference is rebuilt at the same time.

## Run it

- TypeScript (runs in CI, operations project): `pnpm exec vitest run --project operations scripts/golden-battery/battery.test.ts`. It runs every case and indicator check and fails when `results.json` or `summary.md` is stale.
- Rewrite the results after an engine change: `bun run vertex:golden-battery -- write`, then `bunx --bun --no-install biome format --write docs/golden-battery/results.json`. `bun run vertex:golden-battery -- check` checks without writing.
- Python, from `services/research`: `python -m pytest tests/test_golden_battery.py tests/test_golden_pandas_reference.py`. The pandas tests are skipped when pandas is not installed. The CI lanes do not run the Python research suite.
- Rebuild the reference (pandas and TA-Lib in a throwaway environment): follow the steps at the top of `services/research/tests/golden/make_golden_reference.py`.
- Rebuild the fixture: `python3 services/research/tests/golden/fetch_yahoo.py`, then rebuild the reference and the results.

## Limits

- One data source. The battery proves that the code paths agree on the same bars; it does not prove that the bars are correct.
- Daily bars only, one symbol per run, long only, no stops or targets in the golden cases (the engine unit tests cover stops and targets).
- The reference was written for this battery from the written conventions above. It is a second implementation, not an external standard. TA-Lib is the external standard for the indicators.
