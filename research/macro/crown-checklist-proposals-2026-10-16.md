# Proposals: Crown desk checklist in the IBKR monitor and the trading engine

Status: proposal only, 2026-10-16. Nothing here is deployed. No order logic, live gate or service was changed. Each item needs the owner's explicit approval before implementation, and the rollout rule in `~/Github/trading/market-watch-bot/docs/RISK-AND-ROTATION.md` applies: dry run, owner review, then explicit approval.

Checklist: [crown-desk-checklist-2026-10-16.json](crown-desk-checklist-2026-10-16.json) (13 checks). The current-state facts below come from a read-only survey of `~/Github/trading/ibkr-monitor` and `~/Github/trading/market-watch-bot` on 2026-10-16. Line numbers can drift.

## Current state against the checklist

| Check | market-watch-bot / ibkr-monitor today |
| --- | --- |
| RSP/SPY breadth | Same-day sign of SPY and RSP only (`market_watch/logic.py:77-113`, 10 of 100 urgency points). RSP/SPY pair exists only as a backtest (`market-watch-bot/research/backtests.py:27`). Copyrot ignores pair trades (`copyrot/crown_copy.py:107-108`) and its universe has no RSP or SPY (`copyrot/rotation.py:18`). |
| Implied versus realized volatility | VIX, VIXEQ, VVIX and VIX/16 against the actual 1-day move (`ibkr-monitor/server/volatility.mjs`). No 20-day realized volatility. |
| Index skew | Missing. |
| Options flow | QuantData per-symbol premium gate (`reentry/flow.py`, `reentry/gates.py:268`). No index aggregate. |
| Dealer gamma | GEX dry run for SPY/QQQ (`gex/`), shown in the GEX tab. |
| Futures positioning | Missing (no CFTC data). |
| CTA technicals | 200-day and 10-month MA filters, AMT levels. No breakout trigger levels. |
| 10-year level and rejection | DGS10 and ^TNX direction. No level or rejection logic. |
| Treasury auction demand | Missing. ("auction" in market-watch-bot means market-profile levels.) |
| Fed funds strip | DFF only. No futures strip or hike odds. |
| Credit versus duration | HY OAS percentile and HYG/IEF. No IG OAS, no spread-versus-yield divergence. |
| Narrative | Per-symbol headline counts and JEV sentiment (`news/model.py:421-447`). No frequency baseline, no comparison with price. |

## IBKR monitor (read-only display)

- M1. Breadth / rotation tab. Show RSP/SPY with 20- and 50-day averages and 5-day change, SOXX/SPY, and the number of the 11 SPDR sector funds above their 50-day average. Show copyrot output, which no panel shows today.
- M2. Volatility tab. Add 20-day realized S&P volatility (annualized close-to-close), the VIX minus realized spread, and the Cboe SKEW index.
- M3. Macro tab, rates layer. Add DGS30, the latest 10-year and 30-year auction results (bid-to-cover, high yield, indirect share) and an owner-entered reference level for the 10-year with a count of recent touches. The owner sets the level; there is no default.
- M4. Macro tab, credit layer. Add IG OAS (BAMLC0A0CM) and a row that compares the 5-day change in HY and IG spreads with the 5-day change in DGS10. Label it "spreads widen while yields fall" when both conditions are true.
- M5. Positioning. Weekly CFTC Traders in Financial Futures net positions for ES and NQ (leveraged funds, asset managers), with the report date.
- M6. News tab. Headline count per theme against its 20-day average, next to the same-period RSP/SPY change.
- M7. Checklist panel. One row per check: value, direction, data age and source. No composite score and no buy/sell label.

## Trading engine (market-watch-bot), dry run only

Every item lands as an additive module or key behind a default-off flag. While a flag is off, the JEV payload and every live gate stay byte-identical.

- E1. Macro job collection: add the series from M1-M6 to `macro.json` as new keys. Candidate sources: Yahoo daily closes (RSP, SPY, SOXX, sector funds, ^SKEW), FRED (DGS30, BAMLC0A0CM), Treasury FiscalData auction results, CFTC public reporting. Verify each endpoint and its terms before use.
- E2. Re-entry composition annotation (shadow mode). For each re-entry candidate, log whether RSP/SPY is above its 20-day average and whether SOXX/SPY is falling. Flag "rotation against leadership" for semiconductor and mega-cap names. Log only; no gate. After several weeks, the owner decides from the logged outcomes whether it becomes a gate.
- E3. Copyrot pair book (paper). Add RSP to the rotation universe in dry run, and a paper-only, dollar-neutral pair book so Crown pair trades such as RSP/SPY are recorded instead of dropped. Compare its results with the existing pairs backtest.
- E4. Regime tilt inputs (dry run). Add a rates-and-credit "financing stress" input: spreads widen while the 10-year falls, plus weak or strong auction demand relative to the last six auctions of the same tenor. In dry run, show how it would change tilts for AI build-out names (semis, data-center). No thresholds are taken from the reel because it gives none; propose them from backtests.
- E5. JEV context flag `MW_JEV_CHECKLIST_CONTEXT` (default off) that adds the checklist rows to the JEV prompt, like the existing macro, news and Crown context flags.
- E6. Tests and evidence. Pytest fixtures for each new parser; a backtest of the RSP/SPY and financing-stress inputs with `market-watch-bot/research/backtests.py` before any proposal to gate.

## Decisions for the owner

1. Which of M1-M7 and E1-E6 to build first. Suggested order: E1 with M1, M2 and M4 (public data, display only), then E2 and E3 in shadow mode.
2. Whether to pay for data that public sources do not give: a real options-flow feed, intraday Treasury yields for rejection detection, and Fed funds futures quotes (IBKR market data for ZQ/SR3 is one option; CME FedWatch has no free API).
3. Whether any shadow-mode annotation ever becomes a live gate. That needs a separate approval.
