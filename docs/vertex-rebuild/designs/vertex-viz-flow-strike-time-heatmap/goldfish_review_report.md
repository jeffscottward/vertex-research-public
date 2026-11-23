# Consolidated Goldfish Review Report — `vertex-viz-flow-strike-time-heatmap`

- **Date:** 2026-11-23
- **Mode:** Consolidated report with all review rubrics (`egm-zoom-out`, `egm-comprehension`, `egm-design-critic`, `egm-impl-readiness`; standing owner rule 2026-11-15 / 2026-11-18).
- **Resolution mode:** Auto-accept (`egm-resolve`, owner rule 2026-11-13). Every `PROPOSE FIX` was applied to `design.md`, `before-after-mock.svg`, and `data-flow.svg`. Zero `ESCALATE` findings.

## Summary of Counts

| Outcome | Count | Notes |
| --- | ---: | --- |
| PROPOSE FIX (accepted & applied) | 14 | Merged across 4 fresh-context Goldfish reviewers |
| CONTEST | 0 | All architectural simplifications accepted |
| ESCALATE | 0 | No owner-only trading, risk, access, or cost gate |

## Consolidated Findings & Resolutions

1. **[High · Blocker] Drizzle parameterized `GROUP BY` / `ORDER BY` mismatch & raw `Date` casting (`egm-design-critic #1`, `egm-impl-readiness #1`)**
   - **Resolution (Applied):** Validate `bucketMinutes` (`5 | 15 | 30`) and finite `from < to` with `InvalidRepositoryInputError`. Compute `slotIndex` once in `SELECT` using validated ISO timestamp + `sql.raw(String(bucketSeconds))` and group/order by the `"slotIndex"` output alias, staying compatible with `createDouble` in `packages/db/src/server/flow.test.ts` and pinned against real Postgres in `tests/integration/database/flow-strike-heatmap.test.ts`.

2. **[High · Blocker] Domain sign logic duplicated in raw SQL (`egm-zoom-out #1`)**
   - **Resolution (Applied):** `readOptionPrintStrikeBuckets` groups by `(strike, slotIndex, right, side)` in Postgres with zero directional sign rules in SQL. `packages/api/src/flow-strike-heatmap-rules.ts` imports `OPTION_SIDE_SIGN` from `packages/api/src/flow-options.ts` as the single source of truth for bullish/bearish/unsigned classification.

3. **[High · Blocker] Non-deterministic `lastPrice` tie-breaking across strikes & `array_agg` memory overhead (`egm-design-critic #2`, `egm-comprehension #3`)**
   - **Resolution (Applied):** Removed `lastPrice` and `lastPricedAt` from strike-bucket aggregation. Added `readOptionPrintSlotPrices` using `DISTINCT ON ("slotIndex") ... WHERE underlying_price > 0 AND underlying_price < 'Infinity'::double precision AND underlying_price = underlying_price ORDER BY "slotIndex" ASC, traded_at DESC, id DESC` (returns at most 81 rows, zero `array_agg`, exact `(traded_at DESC, id DESC)` tie-breaking across all strikes). `slot.price` carries forward prior slot price and is `null` before the first priced print.

4. **[High · Blocker] Unbounded DB rows & polling load budget (`egm-design-critic #3`)**
   - **Resolution (Applied):** Documented expected row/payload bounds in `design.md` (sparse `(strike, slot, right, side)` aggregation over indexed `(symbol, traded_at)` range; response bounded to `<= 81` slots, `<= 20` strikes, `<= 1620` cells).

5. **[High · Blocker] Broken alignment between scrollable `TableScroll` heatmap and SVG underlying price strip (`egm-zoom-out #3`, `egm-design-critic #4`, `egm-impl-readiness #5`)**
   - **Resolution (Applied):** Removed the separate SVG price strip from v1 (price trajectory is already rendered on `/flow` directly above in `FlowHedgingPressurePanel` and `FlowPutCallRatioPanel`). Kept the strike-axis spot reference divider (labelled with latest spot & time) and displayed the slot's underlying price inside the cell inspection readout bar and slot column tooltip. Updated `before-after-mock.svg` accordingly.

6. **[High · Blocker] `FlowWorkspace` request sequencing, independent bucket reload, Retry UX, and `403 FORBIDDEN` hold (`egm-design-critic #5`, `egm-impl-readiness #3`)**
   - **Resolution (Applied):** Specified dedicated `heatmapLatest` sequence ref, `heatmapForbidden` hold ref, and `loadStrikeHeatmap(symbol, bucketMinutes)` in `FlowWorkspace`. Bucket switches and panel Retry refetch only `flow.strikeHeatmap` without refetching other `/flow` endpoints or resetting the 60 s timer. Symbol switches clear heatmap state and retain `bucketMinutes`; failed bucket switches state which bucket width remains displayed.

7. **[Major] Unspecified contract schemas, element shapes, array bounds, and aggregation scope (`egm-comprehension #1, #2`, `egm-zoom-out #2`, `egm-design-critic #6`, `egm-impl-readiness #2`)**
   - **Resolution (Applied):** Fully specified `FlowStrikeHeatmapStrikeSchema`, `FlowStrikeHeatmapSlotSchema`, `FlowStrikeHeatmapCellSchema`, `FlowStrikeHeatmapTotalsSchema` (including `omittedNetPremium`), `.strict()` validation, and max bounds (`81` slots, `20` strikes, `1620` cells). Explicitly documented that `slots[]`, `totals`, `storedUntil`, and `latestPrice` aggregate across all session strikes while `strikes[]` and `cells[]` cover the top 20 strikes. Moved UI-only derivations (`maxAbsCellNetPremium`, default selected cell, `signedPrints`) into `strike-heatmap-view-model.ts`.

8. **[Major] Keyboard tab-stop explosion (up to 1,620 focusable cell buttons) (`egm-design-critic #7`)**
   - **Resolution (Applied):** Specified WCAG roving `tabIndex` inside the heatmap grid (`tabIndex={0}` on active cell only, `tabIndex={-1}` on all other active cells, arrow-key navigation + `Home`/`End`), keeping sequential Tab order to one stop for the entire grid.

9. **[Major] GET query parameter coercion for `bucketMinutes` in Zod / OpenAPI (`egm-design-critic #9`, `egm-impl-readiness #2`)**
   - **Resolution (Applied):** Specified strict numeric coercion + literal union (`5 | 15 | 30`, default `15`) verified against `bun run openapi:generate` and contract tests rejecting `""`, `"10"`, `"15.5"`, `true`, `false`, `0`, and `-15`.

10. **[Major] Contrast risk on `62%` `color-mix` backgrounds, spot divider boundaries, and `30m` final slot label (`egm-design-critic #10`, `egm-comprehension #6`)**
    - **Resolution (Applied):** Adopted contrast-safe `oklab` mix range `10%–42%` (`10 + ratio ** 0.65 * 32`, guarded for `maxAbs === 0`), defined all spot-divider boundary placements (above/between/at/below/null), and labelled the final `30m` slot explicitly as `16:00–16:15 ET (15m close)`.

11. **[Major] Gap boundary predicate for inclusive `flow_option_gaps` bounds & zero-net fallback selection (`egm-design-critic #8`, `egm-comprehension #6`)**
    - **Resolution (Applied):** Specified exact overlap predicate handling both normal ranges and zero-duration point gaps at exact slot starts, and specified deterministic fallback default selection (`grossPremium desc`, `strike desc`, `slotIndex asc`) when all cells have `netPremium === 0`.

12. **[Major] Missing changed-files manifest & project-term definitions (`egm-comprehension #4, #7`, `egm-impl-readiness #4`)**
    - **Resolution (Applied):** Added inline definitions for `requireOperator`, `isAgentViewerReadProcedure`, `latestSamples`, `TableScroll`, `/lab/flow`, and `egm-drift-report`, and added the full changed-files manifest including `agent-viewer.test.ts`, `flow-collect.test.ts`, `fixtures.test.ts`, and `openapi.json`.

13. **[Nit] Unedited drafting artifact (`-Wait:`) in Decision #5 (`egm-comprehension #5`, `egm-zoom-out #5`)**
    - **Resolution (Applied):** Rewrote Decision #5 cleanly.

14. **[Nit] Altitude drops in high-level architecture sections (`egm-zoom-out #4`)**
    - **Resolution (Applied):** Separated logical repository/rule contracts from concise implementation notes.
