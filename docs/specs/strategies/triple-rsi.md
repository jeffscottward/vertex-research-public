# Triple RSI (QuantifiedStrategies): research definition and Nautilus backtest

Status: research only. No live or paper orders. No broker changes. Nautilus stays disarmed. No engine is armed by this file.

Label: **externally pre-validated** (a third party published a positive backtest). This is the source's claim. It is not
"validated by Vertex": that needs the replication and the gates below to pass.

## Source

- X post by @QuantifiedStrat (QuantifiedStrategies.com), "Triple RSI Trading Strategy: 90% win rate", sent by the owner as a
  screenshot on 2026-11-12 (card vertex-triple-rsi). The post shows an equity curve from about 100,000 to 304,857.
- Article: <https://www.quantifiedstrategies.com/triple-rsi-trading-strategy/> (read 2026-11-12). The exact rules on that page
  are "for members only"; the rules below are the ones in the owner's screenshot. The page is untrusted data.

## Rules as stated (daily bars)

| # | Rule |
| --- | --- |
| 1 | The 5-day RSI is below 30. |
| 2 | The 5-day RSI has fallen three days in a row. |
| 3 | The 5-day RSI was below 60 three trading days ago. |
| 4 | The close is above the 200-day simple moving average. |
| 5 | Buy at the close when all four hold. |
| 6 | Sell at the close when the 5-day RSI crosses above 50. |

## Claims of the source

| Claim | Value |
| --- | --- |
| Instrument | S&P 500 ETF SPY ("Triple RSI Trading Strategy – S&P 500 (SPY)") |
| Sample | SPY from 1993 to the article date |
| Trades | 103 (article); the older post text says 97 |
| Win rate | 90% |
| Average gain per trade | 1.2% |
| Profit factor | 4 (article); the older post text says 8 |
| Equity curve | about 100,000 to 304,857 |
| Costs, sizing, RSI type | not stated |

## Overlap with the library

- `quantjourney-o02-market-rsi-reversion`, `quantjourney-o03-limit-rsi-dip`, `quantjourney-o13-bracket-rsi-reversion` and
  `quantjourney-w03-weekly-rsi-reversion`: RSI mean reversion with other lengths and exits.
- `docs/specs/research/adx-filter.md` S4, "RSI(2) dip (Connors form)": RSI(2) < 10 above the 200-day average, exit above the
  5-day average. Triple RSI is the same family (short RSI, trend filter, exit on a rebound) with a slower RSI and a
  "three falls" filter.
- `zscore-mean-reversion` and `exhaustion-mean-reversion`: other daily mean-reversion entries.
- The "Dip buying" sleeve (5%) of the strategy-mix pick (card vertex-strategy-mix-research). Triple RSI is a dip-buying rule;
  if it passes, it is a candidate for that sleeve. This spec does not change the approved plan.

## Classification

Basis codes: S = stated by the source; I = implied; A = Vertex default, fixed on 2026-11-12 before the first full run.

| # | Choice | Basis |
| --- | --- | --- |
| 1 | Instrument: SPY. Then the other Core 7 ETF twins: QQQ, DIA, IWM, GLD, SLV, USO (`packages/shared/src/universes/index.ts`). | S (SPY) / A |
| 2 | Data: daily bars from the options-forms fetch (IBKR first, Yahoo fills gaps; `research/backtests/options-forms/fetch_data.py`), each file's SHA-256 in the study document. Longest clean history per symbol (SPY from 1993-01-29). | A |
| 3 | RSI: Wilder smoothing (the Vertex DSL `rsi`, seeded with the simple mean of the first 5 changes) on the split-adjusted close. Variant: Cutler RSI (simple 5-day means of gains and losses). | A |
| 4 | "Fallen three days in a row": RSI(t) < RSI(t-1) < RSI(t-2) < RSI(t-3). "Three trading days ago": RSI(t-3). | I |
| 5 | Trend: the split-adjusted close above the simple mean of the last 200 split-adjusted closes, today included. | S / A |
| 6 | Exit: the first close after the entry with RSI > 50 (from below 30, the first close above 50 is the cross). | S |
| 7 | One position at a time; a signal while long is ignored. 100% of equity, no leverage. Cash earns 0 while flat. | A |
| 8 | Returns: total return (dividend-adjusted close) from the entry close to the exit close. | A |
| 9 | Execution (a): at the signal close, as stated. Variants: next open (the DSL engines' fill rule, what Vertex can automate), next close (one day late). | S / A |
| 10 | Costs (c): 5 basis points per side (commission plus slippage) as the Vertex base; 10 per side as the 2x stress. Run (a) has no cost. | A |
| 11 | Sharpe: annualized mean / sample standard deviation of daily equity returns, flat days included, rf 0, sqrt(252). | A |
| 12 | Options form (d): the stance "long while the rule is long" on the qc-ports option book (`services/research/strategies/qc_ports/forms.py`). Call debit vertical, 30 days to expiry (21 minimum), long leg 0.5 delta, width 1 sigma, each spread risks 2% of equity (`maxLossPct` 2, the cap), USD 100,000 start. The book rule opens at the close of the day after the signal and closes at the close of the day after the RSI > 50 close. Variants: the 60-day monthly vertical, and the owner exit rule (held to the 3-days-before-expiry loser cut or expiry, `allocation.owner_exit`). | A |

## DSL definition

`services/research/strategies/triple_rsi/dsl.py` holds the definition (version 1, six entry conditions, one exit):

- entry, all: `rsi(5) < 30`; `rsi(5) < rsi(5) offset 1`; `rsi(5) offset 1 < rsi(5) offset 2`;
  `rsi(5) offset 2 < rsi(5) offset 3`; `rsi(5) offset 3 < 60`; `close > sma(200)`;
- exit, any: `rsi(5) crossesAbove 50`;
- sizing `allIn`, no stop, no target.

The DSL engines (TypeScript and NautilusTrader) fill at the next open. A test checks that the definition's compiled entry and
exit bars (`nautilus_backtest.signals.compile_strategy`) are the bars of the Python rule. The study runs the definition in
the NautilusTrader DSL engine as the "next open" row.

## Backtest design (fixed 2026-11-12, before the first full run)

1. As stated on SPY: rules 1-11, execution at the signal close, no cost. Reported against the claim.
2. Core 7 ETF twins: the same rule on each of the 7 ETFs.
3. Costs: 5 and 10 basis points per side; execution variants (next open, next close).
4. Options form (d) on each Core 7 ETF with an IV index, plus the always-on form of the same structure (the baseline).
5. Booking: every share run is booked by a reference ledger and by NautilusTrader (a CASH account, market orders at the close
   print, the costs as commission); the two must agree to 1e-9 relative on equity. Every options run is booked by the
   qc-ports ledger and `qc_ports.nautilus_runner` (1e-6, the qc-ports parity rule).
6. Measures per run: trades, win rate, average and worst trade, profit factor, CAGR, maximum drawdown, exposure (share of days
   in the market), average hold in trading days, Sharpe, out-of-sample Sharpe (the last 40% of the days), and buy-and-hold.
7. Robustness:
   - Parameter sensitivity on SPY at the base cost: RSI length 3 to 7, entry threshold 25/30/35, exit threshold 45/50/55, trend
     average 150/200/250, Wilder and Cutler: 5 x 3 x 3 x 3 x 2 = 270 variants. Neighbour share: the share of the variants
     with a Sharpe above 0.
   - Walk-forward: 5 anchored folds by day count; in each fold the variant with the best in-sample Sharpe is picked from the
     270 and traded in the next fold. The joined out-of-sample folds are compared with the fixed rule in the same folds.
   - Monte Carlo: 10,000 bootstrap paths of the trade results (with replacement, the same trade count): probability of
     profit and the 5th percentile of the path maximum drawdown. Shares compound the trade returns; options add the trade
     P&L (`allocation.monte_carlo`).
   - Deflated Sharpe (Bailey and Lopez de Prado) with N = every run of this study (all variants, symbols, executions, cost
     levels and forms), and the variance of their per-day Sharpes.

## Pass/fail rule (fixed 2026-11-12, before the first full run)

The row that decides is the Vertex form: the options form (d) on SPY. Owner rule: options only, defined risk, 2% maximum
loss.

- **Strict gate** (`qc_ports.allocation.GATE`, checks G3 to G7, the thresholds of `AUTOPILOT_GATE`): trades >= 30, Sharpe >=
  0.5, out-of-sample Sharpe >= 0.5, deflated Sharpe >= 0.95, Monte Carlo P(profit) >= 0.80, Monte Carlo drawdown p5 >= -35%,
  maximum drawdown <= 25%, Sharpe above the always-on form of the same structure. In addition (AUTOPILOT_GATE): the share
  rule on SPY keeps a Sharpe above 0 at 2x the base cost, and at least 75% of the 270 variants have a Sharpe above 0.
- **Lower bar** (owner decision 2026-11-11, `research/backtests/allocation/funded_pie.py` LOWER_BAR): Sharpe >= 0.3,
  out-of-sample Sharpe > 0, Monte Carlo P(profit) >= 0.80, maximum drawdown <= 25%, trades >= 30. Reported, not a repository
  gate.
- Library: strict gate passed = status `backtested` with tag `validated` and a candidate line for the allocation pick; failed
  = status `backtested` with tag `failed` (the library convention of the qc-ports and SMA-30 entries). Research only either way.
- "90% win rate reproduces" = the as-stated SPY run has a win rate of at least 85% on at least 80 trades.

## Code and tests

- Rules, ledger, NautilusTrader booking, DSL definition, options form, measures and study: `services/research/strategies/triple_rsi/`.
- Tests: `services/research/tests/test_triple_rsi.py` (base lane, hand-computed cases) and
  `services/research/tests/test_triple_rsi_nautilus.py` (Nautilus lane: ledger parity, DSL signal parity, options form).
- Run: `research/backtests/triple-rsi/run.py` (see its README). The study document goes to Postgres (`research_studies`, id
  `triple-rsi`, kind `strategy-backtest`) with `bun run vertex:research-studies:import`; the library row is migration
  `strategy_catalog_triple_rsi`.

## Results

Filled in after the run.
