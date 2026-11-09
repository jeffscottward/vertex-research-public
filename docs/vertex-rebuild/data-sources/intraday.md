# Data source: intraday bars for backtests

Updated: 2026-11-09. Status: **decided: IBKR is the default**. Card `vertex-reel-backtest-dffkn31`.

## Decision

The owner chose IBKR on 2026-11-09 for the question "Which data should Vertex use for intraday backtests from now on?"
(job channel menu, message `1569303850148692022`, answer **1 · IBKR**). The other options were Dukascopy and both.

- New intraday studies (minute and 5-minute bars of US ETFs and stocks) use IBKR TRADES bars.
- Dukascopy is no longer a default for any study. A new study may use it only when IBKR has no history for the market
  (for example a 24-hour CFD or FX series). The study's spec must state that reason.
- Results already stored keep the source they were run on, and their documents name that source. The Dukascopy run of
  the market intraday momentum study stays in its spec and report as a recorded comparison.

## Why IBKR

| | IBKR (vertex-history) | Dukascopy (public datafeed) |
| --- | --- | --- |
| What a SPY bar is | real exchange trades with real volume | the broker's own CFD quote that tracks SPY |
| History | 2004 onwards | 2017 onwards for ETFs, 2012 for index CFDs |
| Volume | traded shares | tick count |
| Spread used for costs | quoted SPY bid/ask measured from IBKR `BID_ASK` bars | CFD spread, wider than SPY's |

On the same rules GHLZ gave Sharpe −0.36 (out-of-sample −0.93) on IBKR against −1.72 (−2.04) on Dukascopy. The
Dukascopy figures came from fewer years and a cost model that does not match the traded ETF.

## How the data is fetched

- Service: the read-only `vertex-history` service on QuantVPS (version 1.2.0 or later, which adds `endDateTime` and
  `BID_ASK`), reached over the `quantvps` SSH alias. Its token stays on QuantVPS.
- Fetcher: `research/backtests/imom/fetch_ibkr.py <SYMBOL>...`. It pages backwards 30 calendar days per request, one
  request every 30 s, and pauses during US market hours so it never competes with trading. It is resumable.
- Storage: on the rig only, not in the repository (the data is not ours to redistribute):
  `~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m/<SYMBOL>.csv.gz` (header
  `timestamp,open,high,low,close,volume`, UTC milliseconds of the bar open) and `<SYMBOL>-bidask.csv.gz` spread samples.
- Backtests run on Nautilus on the rig, never on QuantVPS.

## Tooling defaults

- `python -m strategies.imom study` uses `--source ibkr` unless `--source dukascopy` is given
  (`DEFAULT_SOURCE` in `services/research/strategies/imom/data.py`; test `test_vertex_default_is_ibkr`).
- The data helpers in that module keep Dukascopy as their own default argument, because they pair the source with the
  Dukascopy primary market (US500). Callers that mean IBKR pass `source="ibkr"`.
