# 151 Trading Strategies: backtest target list

This is planning and research only. The backtests run after the RoboQuant work and the Vertex Research move are finished. Nothing in this folder trades, submits orders or changes a live system.

Owner request: Discord, 2026-10-16. Input for #rig-github-vertex-research, which owns the quant pipeline.

## Files

| File | Content |
| --- | --- |
| [strategies.json](strategies.json) | Source of truth: 175 strategy entries with section, name, asset class, required data, rule summary, harness and data mapping |
| [strategies.csv](strategies.csv) | The same entries as CSV (generated) |
| [index.md](index.md) | Markdown index by chapter (generated) |
| [universe.json](universe.json) / [universe.md](universe.md) | 20 contrasting universe groups and the strategies mapped to each (Markdown generated) |
| [swinglytics-snapshot.json](swinglytics-snapshot.json) | Swinglytics sector and theme membership, 2026-10-16 |
| [harness-evaluation.md](harness-evaluation.md) | NautilusTrader and roboquant evaluation, data sources, gaps, proposed first wave |
| `research/backtests/151-strategies/scripts/swinglytics_universe.py` | Python research tool: reads the Swinglytics page with the market-watch-swing parser (no network request) |
| `bun run research:backtest-151` | Regenerates the CSV and Markdown files (`scripts/research/backtest-151.ts`); `-- --check` reports stale files |
| `research/backtests/151-strategies/scripts/nautilus_smoke.py` | Python research tool: NautilusTrader 1.227.0 plumbing run on synthetic bars |

`scripts/research/backtest-151.test.ts` (Vitest `operations` project, part of `bun run verify:prepush`) checks the structure of the JSON files, the cross-references between them and that the generated files are current.

The two Python files are research provenance from PR #4. They need the market-watch-bot parser or NautilusTrader, are not part of the TypeScript platform and are not run by any repository gate. `swinglytics_universe.py` writes JSON with Python formatting; run `bunx --bun --no-install biome format --write` on its output before you commit it.

## Source and extraction

- Paper: Z. Kakushadze and J.A. Serur, "151 Trading Strategies", SSRN 3247865 (Palgrave Macmillan, 2018).
- SSRN returned a Cloudflare challenge (HTTP 403) to the rig on 2026-10-16, for both the abstract page and the PDF. The challenge was not bypassed. The text came from arXiv:1912.04492v1, the authors' Spanish edition of the full book. It has the same section numbering. The English strategy names come from the Palgrave table of contents.
- Section headings were parsed from the PDF. An LLM wrote each rule summary in English from that section's text. The agent spot-checked about 20 entries. No person has reviewed them yet. Summaries are paraphrases for planning. Check the paper before you implement a rule.
- Option names and legs follow the book's conventions, which differ from some desk usage. For example, the book's "short" iron condor and "short" iron butterfly are net-debit trades that profit from a large move. A judge model compared all 175 summaries with common usage and flagged 70. A check of 4 flagged entries (2.45, 2.51, 3.5, 5.13) against the source text found that each one followed the book.
- Count: the book uses the name "151" for its strategies. The PDF has 175 headed entries: 153 numbered sections and 22 sub-section variants (`is_variant: true`, for example 2.40.1 Modified Call Butterfly). All 175 are listed so that no variant is lost.
- 17.2 (money laundering) and 17.6 (loan sharking) are listed for completeness only. They are excluded from any backtest.

## Summary by chapter

Wave: 1 = data on hand or free; 2 = needs one new data source; 3 = needs OTC or model prices, or a proxy; 0 = no market backtest. RQ = fits the roboquant.dev engine (CME futures only).

| Chapter | Entries | Wave 1 | Wave 2 | Wave 3 | Wave 0 | RQ fit |
| --- | --- | --- | --- | --- | --- | --- |
| 2. Options | 58 | 0 | 58 | 0 | 0 | 0 |
| 3. Stocks | 22 | 16 | 4 | 2 | 0 | 5 |
| 4. ETFs | 8 | 8 | 0 | 0 | 0 | 1 |
| 5. Fixed income | 15 | 1 | 0 | 14 | 0 | 1 |
| 6. Indexes | 5 | 1 | 4 | 0 | 0 | 0 |
| 7. Volatility | 7 | 3 | 3 | 1 | 0 | 0 |
| 8. Foreign exchange (FX) | 6 | 5 | 0 | 1 | 0 | 1 |
| 9. Commodities | 6 | 3 | 2 | 1 | 0 | 4 |
| 10. Futures | 7 | 5 | 2 | 0 | 0 | 3 |
| 11. Structured assets | 6 | 0 | 0 | 6 | 0 | 0 |
| 12. Convertibles | 2 | 0 | 0 | 2 | 0 | 0 |
| 13. Tax arbitrage | 3 | 0 | 0 | 0 | 3 | 0 |
| 14. Miscellaneous assets | 4 | 0 | 1 | 2 | 1 | 0 |
| 15. Distressed assets | 7 | 0 | 2 | 1 | 4 | 0 |
| 16. Real estate | 8 | 0 | 0 | 7 | 1 | 0 |
| 17. Cash | 5 | 0 | 0 | 0 | 5 | 0 |
| 18. Cryptocurrencies | 2 | 1 | 0 | 1 | 0 | 0 |
| 19. Global macro | 4 | 1 | 3 | 0 | 0 | 0 |
| **Total** | **175** | **44** | **79** | **38** | **14** | **15** |

## Universe

There are 20 groups in total. Eleven Swinglytics sector ETFs plus XBI and 19 Swinglytics themes form groups G02 to G15. The other groups were added for contrast: G01 index ETFs and index futures, G16 commodities, G17 currencies, G18 rates and credit, G19 volatility and leveraged products, and G20 differentiated single names (GS, AAPL, COST, NVDA, XOM, JNJ, BRK.B, TSLA, LMT, KO). See [universe.md](universe.md).

## Main findings

1. NautilusTrader is the primary harness. It covers 161 of 175 entries: 128 with native instruments and 33 with proxies or modelled prices.
2. roboquant.dev fits only 15 CME-futures entries. Use it as a cross-check or as a source of long futures-expiry history, not as the main engine.
3. The largest gap is historical option-chain data. About 64 entries need it. The owner allows options only for new positions, so this data is the most important owner decision for the plan.

Details: [harness-evaluation.md](harness-evaluation.md).

## Regenerate

```sh
python3 research/backtests/151-strategies/scripts/swinglytics_universe.py \
  --market-watch-bot ~/Github/trading/market-watch-bot \
  --out research/backtests/151-strategies/swinglytics-snapshot.json
bunx --bun --no-install biome format --write research/backtests/151-strategies
bun run research:backtest-151
```

If the Swinglytics membership changes, edit `universe.json` by hand before you regenerate. The group definitions are curated, so the script does not rewrite them.
