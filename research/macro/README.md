# Macro checklists

Curated, source-anchored checklists for the market-health (macro) section. Each checklist maps its checks to indicator IDs in the legacy `main:research/expansion/market-health.json`. That file is not in the rebuild line yet (merge-plan P1 imports market health into PostgreSQL). Each mapped revision therefore has a pinned id/status extract here, for example [market-health-extract-health-d2b267514f5df389.json](market-health-extract-health-d2b267514f5df389.json), with the legacy commit and blob ID. `scripts/research/crown-checklist.test.ts` verifies that every mapped ID exists in that extract and that each coverage level agrees with the indicator status.

These files are research filters for manual review. They are not composite scores, thresholds or order signals.

## Crown desk checklist, 2026-10-16

- Data: [crown-desk-checklist-2026-10-16.json](crown-desk-checklist-2026-10-16.json)
- Proposed engine and monitor changes: [crown-checklist-proposals-2026-10-16.md](crown-checklist-proposals-2026-10-16.md)
- Source: Nicholas Crown Instagram reel [DejvlgDD22R](https://www.instagram.com/reel/DejvlgDD22R/), 2026-10-16, caption "It's not fancy but it works." The transcript is local ASR (faster-whisper large-v3), not checked against the audio. The full transcript is in the knowledge-bases repository at `trading/nicholas-crown/raw/ig-DejvlgDD22R.md`.
- Reported trade: long RSP against SPY (equal weight over cap weight), profit target reached after four days. This is the author's claim, not verified performance. The reel gives no thresholds, weights or sizes.
- Mapped against market-health revision `health-d2b267514f5df389`. Its measured series end on 2026-09-09, so they are stale until the input is collected and imported again.

| # | Layer | Check | Existing indicators | Coverage | Main gap |
| --- | --- | --- | --- | --- | --- |
| 1 | Breadth | RSP/SPY cap weight versus equal weight; semis leadership versus broad sectors | `rsp-spy`, `rsp-spy-sma20`, `igv-soxx`, SOXX MAs | measured | No SOXX/SPY ratio; no sector participation count |
| 2 | Volatility | Implied versus realized volatility | `vix`, `vixeq`, `vixeq-minus-vix` | partial | No realized S&P volatility or VIX minus realized spread |
| 3 | Volatility | Index skew | Crown concept only | concept-only | No SKEW index or 25-delta skew |
| 4 | Positioning | Options flow | Crown concepts only | concept-only | No flow feed |
| 5 | Positioning | Dealer gamma exposure | Crown concepts only | concept-only | GEX exists only in market-watch-bot, not imported |
| 6 | Positioning | Futures positioning | Crown COT concept only | concept-only | No CFTC Traders in Financial Futures data |
| 7 | Technicals | Levels that CTAs follow | SPY/QQQ 50/200-day MAs | partial | No CTA trend-signal estimate; no RSP MAs |
| 8 | Rates | 10-year level and repeated rejection (5.35%) | `series-dgs10`, `series-dgs30`, `treasury-10y-minus-2y` | partial | Daily closes only; no intraday rejection detection |
| 9 | Rates | 10-year and 30-year auction demand | none | missing | No Treasury auction results |
| 10 | Rates | Fed funds strip and hike odds | Crown concept, `series-sofr` | concept-only | No futures strip or per-meeting probability |
| 11 | Credit | Spreads widening while duration rallies | HY and IG OAS, `hyg-lqd` | measured | No spread-versus-yield divergence flag |
| 12 | Narrative | Press sentiment and headline frequency versus price | Crown concepts only | concept-only | No headline-count or sentiment series |
| 13 | Synthesis | How market composition changes; act when layers agree | `crown-signal-stacking-...` | concept-only | Manual by design; no composite score |

Summary: 2 measured, 3 partial, 7 concept-only, 1 missing.
