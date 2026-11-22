# KB decision record — second source for the Core 7 option IV snapshot

Card: vertex-openbb-option-iv-fallback · 2026-11-21 · rig (omarchy-rig)
Method question: is a marked Yahoo vendor-model IV segment acceptable in the stored IV-percentile
history while Cboe is blocked, and is the Yahoo column + local BSM greeks an acceptable research
fallback for GEX/flip/walls?

## Consultation pathway (standing trading-research rule, owner 2026-11-14)

1. kb-chat agents at 127.0.0.1:8787 — one neutral question each, no account values:
   - `kb-quantfinancetogo-bdac178174f6` (option pricing, volatility models) — thread
     44f55f28-f435-4b10-96e4-ebd5af161b89, asked 2026-11-21T12:09:32Z.
     **Answer: none. Error: "The model usage limit has been reached. Try again after your access
     resets. No fallback was attempted."** (saved: kb-answers.md)
   - `kb-skydweller-07b18e4adfdd` (gamma levels, order flow) — same usage-limit error
     (saved: kb-answers.md).
   - `kb-andrea-cimitan-1b25ed78a28b` (GEX data quality) — same usage-limit error
     (saved: kb-answers.md).
   The kb-chat model backend is at its usage limit; per the standing Claude-only rule no paid
   fallback is attempted. The questions and errors are saved as evidence.
2. `~/Github/knowledge-bases/trading/_master-rules/rules.jsonl` — read directly (the rule's second
   named source). Relevant rules with citations:

   | Rule id | Statement (verbatim) | Bearing on the decision |
   | --- | --- | --- |
   | andrea-cimitan:indicator:3 | "Prefer CBOE-sourced market-maker flow over naive open-interest GEX, since 0DTE (~50% of SPX options volume) never shows in end-of-day OI." | Cboe stays the first source; the fallback is marked, never presented as Cboe-quality. The pipeline already excludes 0-DTE from every figure (options_math.summarize), which addresses the stated 0DTE mechanism. |
   | skydweller:wisdom:2 | "GEX tools only estimate dealer positioning; treat levels as high-probability zones, never guarantees." | GEX from any source is an estimate; a marked vendor-model estimate is within the research use, not an order input. |
   | damien-wursten:risk:26 | "Cross-check fundamental data across multiple sources; production figures are often delayed or revised and can mislead short-term forecasts." | Supports keeping a second source with explicit provenance instead of a hole; the run warning + panel note are the cross-check marker. |
   | worldclassedge:wisdom:1 | "Validate that your data is real executed-order data (not CFD tick data) before trusting any model." | The Yahoo chain is real listed-contract data (OI/volume from the exchange feeds Yahoo aggregates); the IV column is a model output and is labeled as such in the note. |
   | inthemoneyadam:entry:3 | "Buy options when IV rank or percentile is below about 50 and sell options when it is above 50." | The percentile is a decision input for premium strategies; a silent method mix would corrupt it. The marking (and the 20-session minimum, today 9 stored) is the mitigation; no trading decision reads it automatically. |
   | nicholas-crown:options_structure:7 | "Sell premium when IV is at extreme percentiles (e.g., 98th)…" | Same: extreme-percentile reads must not be fabricated by a method boundary; the boundary jump is measured (+4.2 to +8.4 vol points incl. market move) and stated in the plan. |
   | quantfinancetogo:wisdom:4 | "Distrust the best of many rules tried on the same history; data-mined patterns found even in noise do not repeat on new data." | Cautions against tuning the percentile to hide the boundary; the plan keeps the percentile formula unchanged and marks the segment instead. |

## Decision (from the master-rules answers; kb-chat unavailable at its usage limit)

1. **Keep Cboe first; Yahoo fallback only on failure, explicitly marked** (run warning marker
   "used the Yahoo option chain", run status partial, panel note naming the symbols and the
   method). Sources: andrea-cimitan:indicator:3, damien-wursten:risk:26.
2. **Mix the marked segment into the stored history; do not exclude it.** Excluding fallback
   sessions would recreate the holes this card exists to remove, and the percentile already
   refuses to display below 20 sessions. The mix is bounded, measured and marked; the run ledger
   keeps per-session provenance. A ledger-derived post-recovery caveat is follow-up card
   openbb-iv-history-caveat. Sources: damien-wursten:risk:26, quantfinancetogo:wisdom:4 (keep the
   formula unchanged, mark rather than tune), inthemoneyadam:entry:3 (the consumer is a human
   research read, not an automatic order).
3. **GEX/flip/walls from BSM greeks on the Yahoo column are research estimates**, labeled by the
   same note; 0-DTE excluded as today; sentinel IV < 0.01 dropped (12% of contracts measured).
   Sources: skydweller:wisdom:2, andrea-cimitan:indicator:3.
4. **No trading authorization**: this is a research data pipeline; nothing here arms, sizes or
   places an order. KB answers are research input only.

## Pathway to proving the change (gate checks and missing evidence)

- Gate checks passed at design time: live Cboe 403 confirmed; live Yahoo full-snapshot measured
  (179 requests, ~31 s with spacing, 40,057 contracts); boundary jump measured against the last
  stored Cboe session; greeks parity convention pinned (2e-7 vs the TS erf bound).
- Evidence still missing (produced by the build): recorded-fixture replay tests green; the live
  rig run writing all 7 symbols with the marker; the Markets panel note verified in headless
  Chrome (agent viewer); CI green on the reviewed head.
- Missing KB evidence: the three kb-chat answers (usage limit). The decision rests on the
  master-rules source the standing rule names equally; the saved errors document the gap. If the
  owner wants the agent answers, re-ask after the kb-chat model reset (questions saved).
