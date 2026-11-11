# Allocation proposal study

Research only. This study answers one owner question (card `vertex-allocation-plan`, 2026-11-11): which
validated library strategies should a re-armed Vertex run, and with what share of account risk each?
It creates no order, no deployment request, no preset and no row in Postgres.

Result on 2026-11-11 (data to 2026-11-10): **0 of 97 library strategies pass the gate. The proposal is
100% cash / unallocated.** The report with the tables and charts is outside the repository (rig reports
directory `vertex-allocation`).

## Files

| File | What it does |
| --- | --- |
| `services/research/strategies/qc_ports/allocation.py` | Owner exit rule, account caps (`combine`), out-of-sample Sharpe, Monte Carlo, correlation, three weighting methods |
| `services/research/tests/test_qc_ports_allocation.py` | Synthetic tests of that module (base Python lane) |
| `research/backtests/allocation/run.py` | The study: runs every candidate and the combined portfolios on NautilusTrader and writes one JSON document to `--out` |

`run.py` writes its output to a report work directory. The app does not read it (AGENTS.md rule 13).

## Run it (rig)

```sh
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
  python research/backtests/qc-ports/fetch_data.py --out <data dir> --end <tomorrow of the last complete session>
<venv with services/research/requirements-nautilus-linux-py312.lock>/bin/python \
  research/backtests/allocation/run.py --data <data dir> --capital <account value, rounded> --out <work dir>/results.json
```

The run takes about 6 minutes. It fails when the reference ledger and NautilusTrader differ on a trade or
on daily equity by more than `1e-6` (the parity rule of the qc-ports runner).

## Gate

A strategy is eligible only when every check holds on our own runs. Every threshold is an existing
repository constant; this study adds none.

| Check | Threshold | Source |
| --- | --- | --- |
| G1 own NautilusTrader run on market data, after costs | required | owner rule: external validation does not count |
| G2 defined-risk options form on Nautilus | required | owner rule: options only, no shares |
| G3 trades | at least 30 | `AUTOPILOT_GATE` (`packages/api/src/autopilot-gate.ts`) |
| G4 Sharpe, full window and last 40% of the days | at least 0.5 each | `study.PASS_SHARPE`, `AUTOPILOT_GATE` out-of-sample |
| G5 deflated Sharpe with every options-form trial counted | at least 0.95 | `AUTOPILOT_GATE`, `DSR_MIN_PROBABILITY` (`scripts/research/quantjourney.ts`) |
| G6 Monte Carlo of the trade P&L, 1,000 paths | at least 80% of paths profitable; 5th-percentile drawdown not below -35% | `AUTOPILOT_GATE` |
| G7 max drawdown, and Sharpe above the always-on baseline | at most 25% | `study.PASS_DRAWDOWN`, the study's baseline rule |

Watchlists, alerts and gates (IV rank, VIX term structure, volatility regime) are tools or overlays. They
cannot hold a risk budget.

## Candidates

Only a strategy with a daily definition can run here. There are 19 candidates:

- The run A of the 11 QuantConnect idea ports (`strategies/qc_ports/ideas.py`), with the option structure
  their specs fixed on 2026-11-08.
- The 8 QuantJourney strategies with a daily DSL definition (O01, O02, O06, O12, O13, O18, W01, W03). Their
  options form was fixed before the first run: the monthly call debit vertical of the qc study
  (`MONTHLY_CALL`) on the Core 7 ETF twins, one open spread per symbol. A stop or a bracket on the
  underlying has no options form, so O12 and O18 trade exactly like O06, and W03 like O02.

Every candidate runs with the owner exit rule (2026-11-03): a winner may run to expiry, a loser closes
3 days before expiry, an open winner closes at the expiry close. The profit-take and time exits of the
specs are removed; a signal exit stays. Limits of the daily model: "3 trading days" is 3 calendar days (the
same day unless a holiday falls in that week), and "15:45 ET" is the close.

Trials for the deflated Sharpe: the 32 counted runs of the 2026-11-08 study plus the 19 runs here = 51.

The three reel ideas (`ld34-nested-donchian-breakout`, `market-intraday-momentum`, `volume-spike-breakout`)
have options forms in their own Nautilus studies on intraday data (`research_studies`); the report reads
their stored results.

## Bench and portfolios

No candidate passed, so steps 2 to 4 of the task run on a bench: the candidates with a positive Sharpe after
costs, without the two gate ideas (overlays of the put-credit sleeve) and without the duplicate trade lists.
The bench is picked after seeing its Sharpe, so its backtest is an upper bound. It has no recommended
budget.

Limits (owner rules and `sizeFromWorstRun` in `packages/api/src/backtest-analytics.ts`):

| Limit | Value |
| --- | --- |
| Portfolio drawdown limit | 20% |
| Open risk of the account (the loss if every open position fails at once) | at most 10% |
| Risk per position | 1% (never above 2%) |
| Open risk in one underlying (per-name premium cap) | at most 2% |

A sleeve's budget is its share of the 10% open-risk cap; the strategies of a sleeve share it. Three methods
set the shares: equal risk, inverse volatility (naive risk parity) and shrunk Sharpe (Sharpe times
`years / (years + 10)`, floored at 0). `combine` puts all trades into one account and the combined list
runs in the ledger and in NautilusTrader.

## Results (2026-11-11)

Data to 2026-11-10, capital = the rounded account value (not stated here), engine qc-ports ledger + nautilus_trader 1.227.0 (parity checked). Ledger and Nautilus agree on every run (largest relative equity gap 4.2e-16).

Library: 97 entries = 62 tradable strategies, 19 tools and alerts, 8 overlays and gates, 5 method demos, 3 studies. Of the tradable strategies 53 have an own Nautilus run and 20 a defined-risk options form. **Eligible: 0.**

| Candidate | Sleeve | Sharpe (owner exit) | Sharpe (as studied) | Out-of-sample | Deflated Sharpe | MC P(profit) | Max drawdown | CAGR | Trades | Checks failed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `oil-predicts-equity/A` (bench) | macro | +0.42 | +0.42 | +0.17 | 0.29 | 98% | -18.8% | +3.3% | 341 | 4 of 8 |
| `regime-put-vrp/A` (bench) | vol premium | +0.32 | +0.09 | +0.16 | 0.14 | 94% | -3.4% | +0.4% | 91 | 3 of 8 |
| `qj/W01` (bench) | trend | +0.19 | new | +0.34 | 0.02 | 87% | -33.8% | +1.6% | 644 | 5 of 7 |
| `vix-term-gate/A` (overlay) | vol premium | +0.11 | -0.05 | +0.20 | 0.02 | 69% | -6.5% | +0.1% | 115 | 4 of 8 |
| `qj/O06` (bench) | trend | +0.09 | new | +0.26 | 0.00 | 67% | -38.9% | +0.4% | 389 | 6 of 7 |
| `qj/O12` (= qj/O06) | trend | +0.09 | new | +0.26 | 0.00 | 67% | -38.9% | +0.4% | 389 | 6 of 7 |
| `qj/O18` (= qj/O06) | trend | +0.09 | new | +0.26 | 0.00 | 67% | -38.9% | +0.4% | 389 | 6 of 7 |
| `qj/O13` (bench) | mean reversion | +0.08 | new | +0.38 | 0.00 | 67% | -34.6% | +0.3% | 341 | 6 of 7 |
| `momentum-rotation/A` (bench) | rotation | +0.06 | +0.06 | +0.22 | 0.00 | 59% | -31.4% | +0.2% | 609 | 6 of 8 |
| `qj/O01` (bench) | trend | +0.04 | new | +0.17 | 0.00 | 40% | -51.1% | -0.3% | 724 | 6 of 7 |
| `qj/O02` | mean reversion | -0.03 | new | +0.20 | 0.00 | 25% | -34.9% | -0.4% | 355 | 6 of 7 |
| `qj/W03` (= qj/O02) | mean reversion | -0.03 | new | +0.20 | 0.00 | 25% | -34.9% | -0.4% | 355 | 6 of 7 |
| `asset-class-trend/A` | trend | -0.09 | -0.10 | -0.06 | 0.00 | 8% | -60.0% | -1.8% | 1221 | 6 of 8 |
| `iv-rank-gate/A` (overlay) | vol premium | -0.16 | -0.20 | -0.11 | 0.00 | 6% | -24.6% | -0.5% | 214 | 4 of 8 |
| `same-month-seasonality/A` | seasonality | -0.22 | -0.24 | +0.05 | 0.00 | 2% | -51.0% | -1.8% | 544 | 6 of 8 |
| `gold-fed-model/A` | macro | -0.27 | -0.26 | +0.15 | 0.00 | 11% | -22.9% | -0.8% | 95 | 6 of 8 |
| `futures-trend-carry/A` | trend | -0.27 | -0.32 | -0.20 | 0.00 | 1% | -66.6% | -3.6% | 991 | 7 of 8 |
| `turn-of-the-month/A` | seasonality | -0.35 | -0.41 | -0.43 | 0.00 | 0% | -69.4% | -3.1% | 1171 | 7 of 8 |
| `opex-week/A` | seasonality | -0.53 | -0.44 | -0.39 | 0.00 | 0% | -75.7% | -4.1% | 1162 | 7 of 8 |

Bench portfolios, one account, 2011-05-31 to 2026-11-10 (cash earns 0%):

| Method | Sleeve budgets (% of account) | Cash | CAGR | Sharpe | Deflated Sharpe | Max drawdown | Worst month | 2020-02-19 to 2020-03-31 | 2022 | Last 3 months |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Equal risk | rotation 2.0, macro 2.0, vol premium 2.0, trend 2.0, mean reversion 2.0 | 90% | +3.42% | +0.37 | 0.23 | -21.4% | -6.6% (2019-05) | -6.5% | -16.1% | -10.1% |
| Inverse volatility | vol premium 6.7, rotation 1.0, macro 0.9, mean reversion 0.7, trend 0.6 | 90% | +0.70% | +0.16 | 0.06 | -15.7% | -3.4% (2019-05) | -3.0% | -12.6% | -4.7% |
| Shrunk Sharpe | macro 3.0, vol premium 2.9, trend 1.7, mean reversion 1.6, rotation 0.8 | 90% | +1.85% | +0.29 | 0.15 | -19.1% | -4.6% (2019-05) | -3.8% | -16.2% | -6.2% |

Reading: the few positive results are long call spreads on equity indices since 2011; the always-on
baseline of the oil idea (buy the SPY and QQQ spread every month) has a higher Sharpe than its timing rule.
The equal-risk bench pie lost more than the 20% drawdown limit although its open risk never passed 10%: the
cap limits the loss of everything open at one time, not a run of losing months.

Not checked here: live option quotes (prices are modeled), intraday exits, interest on cash.
