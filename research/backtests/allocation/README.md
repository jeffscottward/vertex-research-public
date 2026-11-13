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
| `services/research/strategies/qc_ports/allocation.py` | Owner exit rule, the gate (`GATE`, `gate_checks`), account caps (`combine`), out-of-sample Sharpe, Monte Carlo, correlation, three weighting methods |
| `services/research/tests/test_qc_ports_allocation.py` | Synthetic tests of that module (base Python lane) |
| `research/backtests/allocation/run.py` | The study: runs every candidate and the combined portfolios on NautilusTrader and writes one JSON document to `--out` |
| `research/backtests/allocation/sensitivity.py` | The candidates again under changed option-model assumptions (diagnostics) |
| `research/backtests/allocation/fetch_chain_snapshot.py` | One-day option-chain snapshot: measured half-spread and skew per ETF |
| `research/backtests/allocation/funded_pie.py` | The lower-bar pie the owner picked: three sleeves in one account under both option models (proposal) |
| `research/backtests/allocation/deploy_rehearsal.py` | Deployability rehearsal of the pie, on paper only: every step from a signal to an exit, with the cause of each stop |
| `scripts/research/deploy-rehearsal-requests.ts` | The deployment-request step of the rehearsal: the request rules in one process, no database (CLI: `scripts/research-deploy-rehearsal-requests.ts`) |
| `services/research/tests/test_deploy_rehearsal.py` | Synthetic tests of the rehearsal (base Python lane) |

`run.py` writes its output to a report work directory. The app does not read it (AGENTS.md rule 13).

## Run it (rig)

```sh
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
  python research/backtests/qc-ports/fetch_data.py --out <data dir> --end <tomorrow of the last complete session>
<venv with services/research/requirements-nautilus-linux-py312.lock>/bin/python \
  research/backtests/allocation/run.py --data <data dir> --capital <account value, rounded> --out <work dir>/results.json
```

The run takes about 8 minutes. It fails when the reference ledger and NautilusTrader differ on a trade or
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
| G7 max drawdown, and Sharpe above the always-on baseline under the same exit rule | at most 25% | `study.PASS_DRAWDOWN`, the study's baseline rule |

Watchlists, alerts and gates (IV rank, VIX term structure, volatility regime) are tools or overlays. They
cannot hold a risk budget.

Differences from the Autopilot gate, written down before the first run and kept: the Monte Carlo reads all
trades (Autopilot reads the out-of-sample trades and needs 8 of them), and there is no neighbour or
cost-stress check. No result depends on these: every candidate fails G4 and G5.

## Candidates

Only a strategy with a daily definition can run here. There are 19 library candidates and two hosts
(`allocation.qc_candidates`):

- The run A of the 11 QuantConnect idea ports (`strategies/qc_ports/ideas.py`), with the option structure
  their specs fixed on 2026-11-08. Three of them are gate ideas (`qc-iv-rank-gate`, `qc-vix-term-gate`,
  `qc-regime-put-vrp`): a gate on a put-credit host. They count as overlays. The two ungated hosts are the
  vol-premium candidates: `put-credit/B` (SPY put credit verticals, the host of the regime and VIX-term
  gates) and `iv-rank-gate/B` (the same on the Core 7, the host of the IV-rank gate).
- The 8 QuantJourney strategies with a daily DSL definition (O01, O02, O06, O12, O13, O18, W01, W03). Their
  options form was fixed before the first run: the monthly call debit vertical of the qc study
  (`MONTHLY_CALL`) on the Core 7 ETF twins, one open spread per symbol. A stop or a bracket on the
  underlying has no options form, so O12 and O18 trade exactly like O06, and W03 like O02.

Every candidate runs with the owner exit rule (2026-11-03): a winner may run to expiry, a loser closes
3 days before expiry, an open winner closes at the expiry close. The profit-take and time exits of the
specs are removed; a signal exit stays. A spread that reaches expiry with a leg in the money pays the
modeled closing cost. Limits of the daily model: "3 trading days" is 3 calendar days (the same day unless
a holiday falls in that week), "15:45 ET" is the close, and a trade is a loser when it is below its cost
after the closing cost.

The baseline of check G7 is the run B of the idea (the always-on version) under the same owner exit rule;
for the QuantJourney forms it is `asset-class-trend/B` (the same call spread on the Core 7 every month).
That one is a weak comparison: it rolls at month-ends from 1993-10, while the forms hold one spread per
symbol from 1993-01. A host has no baseline check.

Trials for the deflated Sharpe: the 32 counted runs of the 2026-11-08 study plus every run made here with
the owner exit (candidates and baselines). The count includes the three duplicate trade lists. The intraday
runs of the reel studies are not counted.

The three reel ideas (`ld34-nested-donchian-breakout`, `market-intraday-momentum`, `volume-spike-breakout`)
have options forms in their own Nautilus studies on intraday data (`research_studies`); the report reads
their stored results.

## Bench and portfolios

No candidate passed, so steps 2 to 4 of the task run on a bench: the candidates with a positive Sharpe after
costs, without the overlays and without the duplicate trade lists. The bench has no recommended budget.
Its backtest is an upper bound for three reasons: the bench is picked after seeing its Sharpe; the
inverse-volatility and shrunk-Sharpe weights are fitted on the years they are tested on; and the open-risk
cap of 10% and the position risk of 1% were set after a first run (smaller positions bought no SPY or QQQ
contract).

Limits (owner rules and `sizeFromWorstRun` in `packages/api/src/backtest-analytics.ts`):

| Limit | Value |
| --- | --- |
| Portfolio drawdown limit | 20% |
| Open risk of the account (the loss if every open position fails at once) | at most 10% |
| Risk per position | 1%, or the sleeve budget when that is smaller (never above 2%) |
| Open risk in one underlying (per-name premium cap) | at most 2% |

A sleeve's budget is its share of the 10% open-risk cap; the strategies of a sleeve share it. Three methods
set the shares: equal risk, inverse volatility (naive risk parity on the common window) and shrunk Sharpe
(the mean Sharpe of the sleeve's members over their own full records times `years / (years + 10)`, floored
at 0). `combine` puts all trades into one account and the combined list runs in the ledger and in
NautilusTrader. `combine` is first come, first served and does not retry a refused entry, so each portfolio
also runs with the strategy order reversed; the results table shows both. The deflated Sharpe of a
portfolio counts these six portfolio runs as trials too.

## Results (2026-11-11)

Data to 2026-11-10, capital = the rounded account value (not stated here), engine qc-ports ledger + nautilus_trader 1.227.0 (parity checked). Ledger and Nautilus agree on every run (largest relative equity gap 4.3e-16).

Library: 97 entries = 61 tradable strategies, 19 tools and alerts, 9 overlays and gates, 5 method demos, 3 studies. Of the tradable strategies 21 have an own Nautilus run and 19 a defined-risk options form. **Eligible: 0.**

| Candidate | Sleeve | Sharpe (owner exit) | Sharpe (as studied) | Out-of-sample | Deflated Sharpe | MC P(profit) | Max drawdown | CAGR | Trades | Checks failed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `oil-predicts-equity/A` (bench) | macro | +0.42 | +0.42 | +0.17 | 0.29 | 98% | -18.8% | +3.3% | 341 | 4 of 8 |
| `regime-put-vrp/A` (overlay) | vol premium | +0.32 | +0.09 | +0.16 | 0.14 | 94% | -3.4% | +0.4% | 91 | 3 of 8 |
| `put-credit/B` (host) (bench) | vol premium | +0.15 | -0.04 | +0.02 | 0.03 | 77% | -6.5% | +0.2% | 122 | 4 of 7 |
| `iv-rank-gate/B` (host) (bench) | vol premium | +0.15 | -0.56 | +0.30 | 0.01 | 90% | -20.8% | +0.6% | 854 | 3 of 7 |
| `qj/W01` (bench) | trend | +0.12 | new | +0.24 | 0.01 | 70% | -36.3% | +0.7% | 644 | 6 of 8 |
| `vix-term-gate/A` (overlay) | vol premium | +0.11 | -0.05 | +0.20 | 0.02 | 69% | -6.5% | +0.1% | 115 | 5 of 8 |
| `momentum-rotation/A` (bench) | rotation | +0.06 | +0.06 | +0.22 | 0.00 | 59% | -31.4% | +0.2% | 609 | 6 of 8 |
| `qj/O13` (bench) | mean reversion | +0.05 | new | +0.33 | 0.00 | 57% | -35.1% | +0.1% | 341 | 6 of 8 |
| `qj/O06` (bench) | trend | +0.03 | new | +0.18 | 0.00 | 44% | -42.1% | -0.1% | 389 | 6 of 8 |
| `qj/O12` (= qj/O06) | trend | +0.03 | new | +0.18 | 0.00 | 44% | -42.1% | -0.1% | 389 | 6 of 8 |
| `qj/O18` (= qj/O06) | trend | +0.03 | new | +0.18 | 0.00 | 44% | -42.1% | -0.1% | 389 | 6 of 8 |
| `qj/O01` | trend | -0.03 | new | +0.07 | 0.00 | 15% | -55.1% | -1.1% | 723 | 6 of 8 |
| `qj/O02` | mean reversion | -0.03 | new | +0.20 | 0.00 | 25% | -34.9% | -0.4% | 355 | 6 of 8 |
| `qj/W03` (= qj/O02) | mean reversion | -0.03 | new | +0.20 | 0.00 | 25% | -34.9% | -0.4% | 355 | 6 of 8 |
| `asset-class-trend/A` | trend | -0.09 | -0.10 | -0.06 | 0.00 | 8% | -60.0% | -1.8% | 1221 | 6 of 8 |
| `iv-rank-gate/A` (overlay) | vol premium | -0.16 | -0.20 | -0.11 | 0.00 | 5% | -24.7% | -0.5% | 214 | 5 of 8 |
| `same-month-seasonality/A` | seasonality | -0.22 | -0.24 | +0.05 | 0.00 | 2% | -51.0% | -1.8% | 544 | 7 of 8 |
| `gold-fed-model/A` | macro | -0.27 | -0.26 | +0.15 | 0.00 | 11% | -22.9% | -0.8% | 95 | 6 of 8 |
| `futures-trend-carry/A` | trend | -0.27 | -0.32 | -0.20 | 0.00 | 1% | -66.6% | -3.6% | 991 | 7 of 8 |
| `turn-of-the-month/A` | seasonality | -0.35 | -0.41 | -0.43 | 0.00 | 0% | -69.4% | -3.1% | 1171 | 7 of 8 |
| `opex-week/A` | seasonality | -0.53 | -0.44 | -0.39 | 0.00 | 0% | -75.7% | -4.1% | 1162 | 7 of 8 |

Trials counted in the deflated Sharpe: 61 (32 study runs + 29 owner-exit runs); portfolios: 67.

Bench portfolios, one account, 2011-05-31 to 2026-11-10 (cash earns 0%):

| Method | Sleeve budgets (% of account) | Cash | CAGR | Sharpe | Deflated Sharpe | Max drawdown | Worst month | 2020-02-19 to 2020-03-31 | 2022 | Last 3 months | Reverse order: CAGR / Sharpe / max drawdown |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Equal risk | rotation 2.00, macro 2.00, vol premium 2.00, trend 2.00, mean reversion 2.00 | 90% | +2.21% | +0.26 | 0.11 | -25.5% | -6.5% (2012-05) | -8.7% | -17.6% | -9.1% | +2.20% / +0.29 / -21.2% |
| Inverse volatility | vol premium 3.68, rotation 1.89, macro 1.72, mean reversion 1.42, trend 1.28 | 90% | +1.06% | +0.18 | 0.07 | -16.9% | -5.3% (2018-10) | -6.5% | -14.0% | -5.9% | +1.38% / +0.24 / -15.1% |
| Shrunk Sharpe | macro 4.99, vol premium 2.15, trend 1.16, rotation 0.90, mean reversion 0.80 | 90% | +1.91% | +0.28 | 0.13 | -18.7% | -4.4% (2018-10) | -6.2% | -16.3% | -6.0% | +1.63% / +0.27 / -13.7% |

Reading: the best result is long call spreads on SPY and QQQ since 2011, and its always-on baseline has a
higher Sharpe than the timing rule. The put-credit hosts earn almost nothing after costs; the volatility
regime gate improves the SPY host, but stays far below the gate of this study. The equal-risk bench pie
lost more than the 20% drawdown limit although its open risk never passed 10%: the cap limits the loss of
everything open at one time, not a run of losing months.

Not checked here: live option quotes (prices are modeled), intraday exits, interest on cash.

## Sensitivity: why does nothing pass? (2026-11-11)

The owner asked whether one gate blocks everything. `sensitivity.py` runs the candidates again on NautilusTrader
under changed model assumptions, and `fetch_chain_snapshot.py` measures the two assumptions that matter (the
bid/ask half-spread and the volatility skew) in a one-day option-chain snapshot from Yahoo. The scenarios are
diagnostics. A pass in a scenario does not make a strategy eligible.

Findings:

- No single gate blocks everything: in the study model every one of the 15 distinct runs fails the Sharpe floor,
  the out-of-sample Sharpe floor and the deflated Sharpe, and dropping any one check unlocks none.
- The option model was too harsh for SPY and QQQ and too kind for DIA and USO (table below). With the measured
  values the median Sharpe goes from -0.03 to +0.24; the best run then fails only the deflated Sharpe and the
  baseline check.
- The gate is stricter than the index: SPY buy-and-hold has a Sharpe of 0.64, a deflated Sharpe of 0.68 and a
  max drawdown of -55%; it fails G5 and G7.
- The engine's order policy (`options_only_defined_risk_v2`) refuses combos and opening short legs, so no
  vertical tested here can be placed today. A single-long-option form is not tested (the runner prices verticals).

| Scenario | Sharpe > 0 | >= 0.3 | >= 0.5 | Median Sharpe | Best Sharpe | Pass the gate | Pass without G5 (baseline check left out) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Study model | 7 | 1 | 0 | -0.03 | +0.42 | 0 | 0 |
| No costs | 13 | 4 | 1 | +0.22 | +0.60 | 0 | 0 |
| Tight spreads (assumed) | 10 | 1 | 1 | +0.09 | +0.52 | 0 | 0 |
| Flatter call skew (assumed) | 10 | 1 | 1 | +0.14 | +0.70 | 0 | 0 |
| Tight spreads + flatter call skew (assumed) | 13 | 4 | 1 | +0.23 | +0.82 | 0 | 1 |
| Same, 0.70-delta legs, 2 sigma wide | 13 | 3 | 1 | +0.23 | +0.66 | 0 | 0 |
| Measured chain snapshot | 12 | 3 | 1 | +0.24 | +0.80 | 0 | 1 |

Of 15 distinct runs: the 16 daily library strategies make 13 different trade lists, plus the 2 put-credit hosts.
The gate here leaves out the baseline check; with it, no run passes without G5 either (the best run loses to its
always-on baseline). Trial count and trial variance of the deflated Sharpe stay at the values of `run.py` in every
scenario. The measured half-spread is the unweighted mean of four legs (two calls, two puts), used for every leg. Chain snapshot: 2026-11-11T20:26:14+00:00 (Yahoo Finance via yfinance 0.2.66), monthly
expiries 37 and 65 days out, quoted spreads.

| ETF | Half-spread per leg, model | Measured | Skew slope, model | Measured, calls | Measured, puts |
| --- | ---: | ---: | ---: | ---: | ---: |
| SPY | 1.00% | 0.40% | -0.30 | -0.13 | -0.23 |
| QQQ | 1.50% | 0.38% | -0.25 | -0.10 | -0.17 |
| DIA | 3.00% | 3.77% | -0.30 | -0.05 | -0.16 |
| IWM | 2.00% | 0.90% | -0.22 | -0.06 | -0.18 |
| GLD | 2.50% | 1.47% | +0.05 | +0.04 | -0.04 |
| SLV | 4.00% | 1.72% | +0.05 | +0.07 | -0.09 |
| USO | 4.00% | 6.18% | -0.10 | +0.08 | +0.00 |

One day of quotes is not a history: spreads widen in stress, and a limit order inside the spread costs less. The
option model in `options.py` is unchanged; replacing its constants needs more than one snapshot.

## Lower-bar pie (owner pick, 2026-11-11)

After the sensitivity result the owner picked "lower bar, fund it small". `funded_pie.py` builds that pie as a
proposal: it arms nothing, sends no order and changes no engine setting. The lower bar is an owner decision, not a
repository gate: Sharpe at least 0.3, positive out of sample, Monte Carlo profit at least 80%, max drawdown at most
25%, at least 30 trades.

| Sleeve | Definition | Budget | Since | Sharpe alone, study / measured model | Max drawdown alone | Passes the lower bar alone |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| long index | `oil-predicts-equity/B` with a plain always-true entry | 2% | 2001 | -0.00 / +0.38 | -56% / -47% | no / no |
| rotation | `momentum-rotation/A` with `top` 1 | 1% | 1994 | +0.14 / +0.44 | -24% / -20% | no / yes |
| vol premium | `regime-put-vrp/A` | 1% | 2006 | +0.32 / +0.34 | -3% / -4% | yes / yes |

"Alone" = the sleeve at the 2% per position of its definition over its own history. The always-on entry and `top` 1
are new trials, chosen after the study: the study run of the always-on leg waits for an oil forecast it does not use
(so it starts in 2011, without 2008), and the 1% budget holds one rotation position.

Limits: 1% of equity at risk per position, at most 4% open, at most 2% in one underlying; cash 96%.

One account on NautilusTrader, 2006-07-17 to 2026-11-10 (2008 included):

| Option model | CAGR | Sharpe | Out-of-sample | Deflated Sharpe | Max drawdown | 2007-10 to 2009-03 | 2022 | Reverse order: CAGR / Sharpe | Lower bar |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Measured chain snapshot | +5.12% | +0.79 | +0.83 | 0.83 | -15.0% | -14.1% | -9.4% | +5.12% / +0.79 | yes |
| Study model | +2.34% | +0.41 | +0.46 | 0.22 | -15.9% | -14.8% | -10.3% | +2.35% / +0.41 | yes |

The pie as a whole passes the lower bar in both models; alone, only the put-credit sleeve does. The long-index
sleeve is long-only beta and loses month after month in a bear market. Neither a sleeve nor the pie passes the
repository gate. The two rows are two option models on one history, not a forecast range. Before real money the
owner must re-arm the engine and decide how it may place spreads: the order policy refuses them today (card
`vertex-order-policy-spreads`).

## Deployability rehearsal (paper only)

Card `vertex-deploy-readiness-dryrun`, 2026-11-11. Owner question: with good numbers, would the pie deploy
end to end, and does a rule collision hold it back? `deploy_rehearsal.py` replays two windows through the
whole chain and writes one JSON document. It sends no order, writes no database row, arms nothing and never
contacts the Quant VPS, the Vertex database or a broker.

| Step | Code that runs in the rehearsal |
| --- | --- |
| signal | the sleeve definitions of `funded_pie.py` (`trace_signals` adds the cause of each month end without a trade) |
| sleeve budget and caps | `allocation.combine` (`trace_caps` adds the date of each refusal and must give the same trades) |
| sizing | `book.contracts_for` through the ledger |
| paper deployment request | the API contract and the repository field and lifecycle rules, in a `bun` child process; no row |
| request to engine, engine strategy, order built by the engine | no code exists; the rehearsal reads `run_live.py` and builds the orders itself (`leg_orders`, a shim) |
| order policy | `arm_gate.check_order_policy` in this process, against a temporary snapshot file |
| simulated fill, exit rule | ledger and NautilusTrader backtest with the owner exit rule (research code; the engine has neither) |

Windows. The rule is fixed before a result is read: the six full calendar months with the highest SPY total
return since the first full month in which all three sleeves can run, and as a contrast the last 63
sessions. `--extra-window NAME=START:END` adds a window by hand; the output labels it as such.

- Every window starts with no position. A monthly decision belongs to the window when its entry bar (the
  next session) is in the window: the decision of the last month end before the start counts, the one on
  the last day does not. So a window that starts on the first session of a month is at risk from day one.
- The contrast window starts on the entry day of the last monthly decision before the 63 sessions, for
  the same reason.
- The percent at risk of a day is the sum of contracts times the maximum loss per contract of the open
  spreads, over the equity of that day. The budget held is the sum of the position budgets (1% each).

Each stop has a cause and a class in `CAUSES`: a missing piece, a collision between two rules, or a rule
that works as designed (a closed gate, a false entry rule).

```sh
<venv with services/research/requirements-nautilus-linux-py312.lock>/bin/python \
  research/backtests/allocation/deploy_rehearsal.py --data <data dir> --capital <account value, rounded> \
  --out <work dir>/rehearsal.json
```

Limits of the rehearsal:

- Option prices are the model of `options.py`, not quotes.
- The request step does not check the strategy row, the params schema, the operator session or the Postgres
  constraints.
- The orders are built by the rehearsal. No engine code builds an option order from a strategy.
- The engine step is a static read of `run_live.py` (syntax tree and text). It runs no engine code.
- `ordersSent`, `rowsWritten` and `armed` in the output are constants: the script has no call that sends an
  order, opens a database or arms a node. The proof that prod did not change is a read of prod before and
  after, outside this script.
- The script reads private helpers of the research modules (`pf._signals`, `al._refusal`, `bk._Pricing`) and
  imports the order policy from the exec-node folder (without writing bytecode there). `trace_caps` raises
  when it does not accept the trades of `combine`. `trace_signals` raises when the book of each leg,
  `owner_rule_trades` and the monthly decisions it walks do not name the same entries.
- The engine, policy and exit stops are "would also stop here" counts: every sized trade is checked at those
  steps, although it already stops at the request step.
- A trade that is open on the last day of the data counts as at risk on that day.
- Leveraged ETFs: the data has no leveraged ETF and no option price for one. `leveraged_probe` checks the
  order policy only, with an example premium. It is a what-if.
