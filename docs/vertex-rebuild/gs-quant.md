# gs-quant in Vertex

Owner request 2026-11-05 (card `vertex-gs-quant`): integrate Goldman Sachs [gs-quant](https://github.com/goldmansachs/gs-quant) wherever it fits the Vertex stack.

Research only. Nothing on this page creates, routes or simulates a live order. No Goldman Sachs account, credential or Marquee session is used.

## What gs-quant is

gs-quant is the Python toolkit of Goldman Sachs (Apache-2.0). Vertex pins version 2.2.4 from PyPI; the module list was also read from upstream `main` at commit `a836565` (2026-11-03). It has two parts:

1. A client for Marquee, the Goldman Sachs data and pricing platform. Pricing, risk, datasets, assets, portfolios, risk models and most time-series "measures" send requests to Marquee. Marquee needs a Goldman Sachs client account and OAuth credentials.
2. A local analytics library. The functions marked `@plot_function` in `gs_quant.timeseries` (statistics, econometrics, technicals, series algebra) and the `PredefinedAssetEngine` backtester run on data that the caller supplies. They need no account.

Vertex uses part 2 only.

## How the module map was made

A probe imported every `gs_quant` subpackage and called one representative function of each in a Python 3.12 environment from the pinned lock. Every network socket was blocked and no `GsSession` existed. A call that needs Marquee fails with `MqUninitialisedError: GsSession is not initialised`. The source of each module was also read (decorators, `GsSession` and `Dataset` use).

## Module map

Verdicts: **Offline** = works on our own data without an account. **Needs Marquee** = needs a Goldman Sachs account. **Not relevant** = no use for Vertex.

|Module|What it does|Verdict|Vertex use|
|---|---|---|---|
|`timeseries.statistics`|zscores, winsorize, percentiles, std, var, cov, mean, median, sum, generate_series (18 functions)|Offline|Adopted: z-score (adapter and `indicators.zscore`)|
|`timeseries.econometrics`|returns, prices, index, annualize, volatility, correlation, beta, max_drawdown, vol/corr swap estimators (11 functions)|Offline|Adopted: realized volatility, beta, correlation, max drawdown (adapter); realized volatility also as `indicators.realized_volatility`|
|`timeseries.technicals`|moving_average, bollinger_bands, smoothed_moving_average, RSI, EMA, MACD, exponential_volatility, trend, seasonally_adjusted (10 functions)|Offline|Adopted: exponential volatility (adapter). The others are parity references for Vertex indicators. `trend` and `seasonally_adjusted` need two full seasonal cycles (statsmodels); not adopted|
|`timeseries.algebra`, `analysis`, `datetime`|Series arithmetic, lag, diff, smooth_spikes, align, interpolate, bucketize (48 functions)|Offline|Not adopted: thin pandas wrappers; Vertex kernels use plain lists|
|`timeseries.event_study`|Frame series around events, impact analysis; event lists from Marquee|Offline helpers; event sources need Marquee|Not adopted: `services/research/backtesting/event_study.py` covers event studies|
|`timeseries.measures*` (14 files)|About 215 `@plot_measure` functions: implied volatility, skew, forward vol, swap curves, FX vol, inflation, cross-currency basis, bond, ETF, FactSet, risk-model and portfolio measures, TCA|Needs Marquee|See the Marquee list below|
|`backtests.predefined_asset_engine`|Event-driven backtest on supplied prices: triggers, market-on-close/TWAP/VWAP orders, holdings, performance|Offline|Compared with the Quant Lab engine (parity test); not adopted as an engine|
|`backtests.generic_engine`, `equity_vol_engine`, `strategy_systematic`|Backtests of OTC and listed instruments priced by Goldman Sachs models|Needs Marquee|See below|
|`backtests.triggers`, `actions`, `strategy`|Trigger and action objects for the engines|Offline (objects only)|Used in the parity test|
|`datetime`|Business-day offsets, relative dates ("-1b", "3m")|Offline with weekends only; named holiday calendars (for example NYSE) need Marquee|Not adopted: weekend-only calendars are not enough for exchange sessions|
|`instrument`, `markets`, `risk`|Instrument objects; pricing, Greeks, scenarios, historical pricing; securities master, baskets, indices, portfolios, position sets, hedger, optimizer, screens, reports|Needs Marquee (instrument objects are local data only)|See below|
|`models.risk_model`, `risk_model_utils`|Factor risk models (exposures, covariance, specific risk)|Needs Marquee|See below|
|`models.epidemiology`|SIR/SEIR model fitting (lmfit)|Offline|Not relevant|
|`data`, `entities`, `api`|Marquee dataset queries, entity lookup, REST client|Needs Marquee|See below|
|`api.fred`|FRED data source|Needs a free FRED API key and network access (not Marquee)|Not adopted: external data belongs in Vertex providers, not in a vendor client|
|`analytics` (datagrid, workspaces), `workflow`, `quote_reports`|Marquee dashboards, workflows and quote reports|Needs Marquee|Not relevant without an account|
|`mcp`|FastMCP server and client (`python -m gs_quant.mcp`). Tools: users (`current_user_info`, `whois`), marketview (dashboards, widgets), data (`get_daily_data`, `get_intraday_data`, `get_last_data`, coverage, asset identifiers). Needs the `mcp` extra (fastmcp, uvicorn)|Needs Marquee (every tool calls Marquee)|Not adopted. With an account, the data tools are read-only and could serve Vertex research agents|
|`skills` (`gs-quant-overview`)|Agent skill: how to write gs_quant code (sessions, pricing, datasets, backtesting, errors)|Documentation for Marquee use|Not adopted. Useful only after an account exists|
|`interfaces.algebra`|Operator overloading helpers|Offline|Not relevant|
|`tracing`, `config`, `json_*`, `target`, `content`|OpenTelemetry tracing, settings, JSON codecs, generated API types, example notebooks|Offline (internal)|Not relevant|

## What Vertex integrated

|Part|Path|
|---|---|
|Pinned lock (55 wheels, gs-quant 2.2.4, pandas 3.1.1, SciPy, statsmodels; base pins and hashes unchanged)|`services/research/requirements-gsquant-linux-py312.lock`, extra `gsquant` and optional backend `gs-quant-analytics` in `services/research/pyproject.toml`|
|Port (plain dates and numbers in, aligned lists out)|`services/research/analytics/ports.py` (`SeriesAnalytics`)|
|Adapter, the only module outside tests that imports `gs_quant`|`services/research/analytics/gs_quant_backend.py` (`GsQuantAnalytics`)|
|Core 7 risk report through the port|`services/research/analytics/report.py`, CLI `python -m analytics report`|
|Pure-Python indicators in the gs-quant convention|`indicators.zscore`, `indicators.realized_volatility` in `services/research/indicators/core.py` ([indicators](../indicators.md))|
|Tests|`services/research/tests/test_gs_quant.py` (gs-quant run), `services/research/tests/test_analytics.py` (base and gs-quant runs), new cases in `services/research/tests/test_indicators.py`|
|CI|Fourth run of `scripts/ci/research-python.sh` with `VERTEX_REQUIRE_GSQUANT=1` ([testing](../testing.md))|
|License notice|`services/research/NOTICE.txt` (dependency only, nothing vendored)|

Safety rules in the adapter:

- The adapter raises `GsQuantSessionActive` when a `GsSession` is set in the process, so it cannot reach Marquee by accident. `test_adapter_refuses_to_run_with_a_marquee_session` checks this.
- Every gs-quant test blocks network sockets. A network attempt fails the test.
- `test_only_the_adapter_imports_gs_quant` fails when any other non-test module imports `gs_quant`.
- When gs-quant is missing or a different version, the adapter raises `GsQuantUnavailable` with the install command, and `python -m analytics report` exits with code 2.

Conventions (gs-quant 2.2.4): volatility is the sample standard deviation (ddof 1) of simple returns, annualized (gs-quant infers 252 for daily dates) and multiplied by 100. Beta and correlation use simple returns on the dates both series share. The adapter returns `None` for partial windows, where gs-quant returns values from fewer points.

## Parity results

`test_gs_quant.py` compares Vertex indicators with gs-quant on the TA-Lib fixture (80 bars) and on 800 synthetic bars.

|Vertex|gs-quant|Result|
|---|---|---|
|`sma`|`moving_average`|Equal (1e-12)|
|`zscore`|`zscores`|Equal (1e-9)|
|`realized_volatility`|`volatility`|Equal (1e-9)|
|`bollinger_bands`|`bollinger_bands`|gs-quant uses the sample deviation. Equal when the Vertex width is k·√(n/(n−1))|
|`smma`, `rsi`|`smoothed_moving_average`, `relative_strength_index`|gs-quant seeds the recursion at the first bar; Vertex seeds with a full SMA (TA-Lib). Equal within 1e-8 after 300 bars; different before|
|`macd` (line, signal)|`macd(x, 12, 26, 1)`, `macd(x, 12, 26, 9)`|Same seeding difference; equal within 1e-9 after 400 bars. gs-quant `macd` with s = 9 returns the signal line|

The adapter's beta, correlation and maximum drawdown are checked against a brute-force calculation on a series with missing benchmark days.

## Backtest engine comparison

`test_predefined_asset_engine_matches_quant_lab_engine` runs the same SMA(50) timing decisions in the gs-quant `PredefinedAssetEngine` (market-on-close orders on supplied daily prices) and in the Quant Lab engine `quantlab.engine.simulate` (next close, no costs, no cash interest). The equity curves are equal within 1e-12 on 600 bars, and the trade counts are equal.

Decision: the gs-quant engine is not added as a third Quant Lab engine. For daily single-instrument timing it gives the same result as the standard-library engine. It has no cost or cash-interest model, and the NautilusTrader engine already provides an independent event-driven check. Its intraday TWAP and VWAP orders on supplied minute data are the one feature Vertex does not have; adopt them only when an intraday Quant Lab spec needs them.

## Demo

`python -m analytics report --data <dir> --out <file.html> [--json <file.json>]` computes, for each Core 7 future and ETF twin: realized volatility (20 and 60 returns), exponentially weighted volatility (decay 0.94), the 50-day z-score of the close, maximum drawdown over 252 bars and since the first bar, 60-day beta and correlation to the benchmark (ES=F for futures, SPY for ETFs), the 60-day correlation of each future with its ETF twin, and a sparkline of 20-day volatility. The page has no script and makes no external request.

Run on the rig (2026-11-05, data through 2026-11-03):

```bash
cd services/research
python -m analytics report --data ~/Documents/reports/vertex-core7/data/daily \
  --out ~/Documents/reports/web/vertex-gs-quant/index.html
```

- Page (tailnet only): <https://omarchy-rig.tail752186.ts.net/reports/vertex-gs-quant/>
- Screenshots on the rig: `~/Documents/reports/vertex-gs-quant/core7-risk-1440.png`, `core7-risk-375.png`
- The Core 7 data is not in the repository (Yahoo terms). See [Core 7 universe](core7-universe.md) for the fetch.

## Features that need a Goldman Sachs account (Marquee)

None of these is used. Each needs a Goldman Sachs Marquee client account with OAuth credentials; the cost and terms are set by Goldman Sachs and are unknown here. Owner decision before any use.

|Feature|What an account would unlock for Vertex|
|---|---|
|`timeseries.measures` (about 215 measures)|Implied volatility, skew, term structure and forward volatility for equities, indices and FX; swap curves and rates measures; inflation; cross-currency basis; bond and ETF measures; FactSet fundamentals; risk-model factor exposures; portfolio and report measures; transaction-cost analysis|
|`instrument` + `risk` + `markets` pricing|Prices and Greeks of listed and OTC options, swaps, FX and credit instruments from Goldman Sachs models; scenario shocks; historical pricing|
|`backtests.GenericEngine`, `EquityVolEngine`, `strategy_systematic`|Backtests of option and volatility strategies with Goldman Sachs pricing (for example rolling index option overlays)|
|`data.Dataset`|Goldman Sachs and partner datasets (equity, volatility, macro, alternative data)|
|`markets` securities, baskets, indices, portfolios, hedger, optimizer, screens|Security master lookups, custom baskets, portfolio analytics, hedge and optimizer services|
|`models.risk_model`|Factor risk models: exposures, factor covariance and specific risk for portfolio risk reports|
|`datetime` named calendars|Exchange holiday calendars (NYSE and others)|
|`mcp` server tools|Read-only Marquee data and dashboard tools for research agents|
|`skills`|An agent guide for the account features above|
|`analytics` datagrid and workspaces, `workflow`, `quote_reports`|Marquee dashboards, workflows and quote reports|

## Limits

- The lock holds CPython 3.12 Linux x86_64 wheels only. The adapter is not part of any deployed runtime (`runtime-qualified = false`).
- gs-quant 2.2.4 warns on import (pandas and invalid escape sequences in its own code). The warnings do not change results.
- The full Core 7 report takes about 20 seconds; most of it is gs-quant's rolling z-score and full-history drawdown.
- The futures are continuous front-month series that are not back-adjusted. Roll gaps count as returns, which lowers the twin correlation of the futures.
