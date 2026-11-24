# EGM Drift Report — `vertex-viz-expected-move`

- **Date:** 2026-11-23
- **Design document:** [`design.md`](design.md)
- **Reviewer:** Fresh-context read-only `egm-drift-check` subagent + post-fix verification
- **Verdict:** **PASS (zero unresolved drift)**

## Verified Alignments

1. **Contract & Authorization (`packages/api/src/contracts/options-chain.ts`, `packages/api/src/server/options-chain.ts`, `packages/api/src/index.ts`, `packages/api/openapi.json`):**
   - `EXPECTED_MOVE_BASES`, `EXPECTED_MOVE_LEG_SOURCES`, `OptionsExpectedMoveBandSchema`, and `OptionsExpectedMoveOutputSchema` match all specified fields, strictness, and `.superRefine` invariants (`band`/`unavailableReason` bijection, `lowerBand <= spot <= upperBand`, `atm_iv_model` vs straddle nullability).
   - Route `GET /options-chain/expected-move`, `operationId: "optionsChain.expectedMove"`, `requireOperator` auth, 60-second cached `readChain` + `mergeOptionsChain` reuse, and `NOT_FOUND` on missing expiries match the spec.
   - `operator-access.ts` and `handler.ts` are untouched (`x-api-key` allowlists not widened); `agent-viewer` GET allowlist snapshot in `packages/api/src/agent-viewer.test.ts` is updated.
   - `computeOptionsExpectedMove`, `findAtmPairRow`, `STRADDLE_TO_ONE_SIGMA`, and `expiryCloseMs` are re-exported from `packages/api/src/index.ts`.
2. **Pure Calculation (`packages/api/src/options-expected-move.ts`):**
   - Browser-safe (zero `./server/*` imports), `STRADDLE_TO_ONE_SIGMA = Math.sqrt(Math.PI / 2)`, pair-required `findAtmPairRow` with deterministic lower-strike tie-break, three-tier hierarchy (`atm_straddle_mid` requiring `bid > 0 && ask >= bid && sources.quote !== null`, `atm_straddle_last`, `atm_iv_model` with null straddle fields), and prioritized deduplicated `notes` cap.
3. **KLineCharts Overlay (`apps/web/src/features/charts/`):**
   - `expected-move-overlay.ts`: `vxExpectedMoveCone`, `vx_expected_move`, `[4, 24]` bar horizon with 3-way `horizonScale`, 12-step `√t` curve polygon + dashed bands + spot/expiry guides + straddle ticks + `BE+`/`BE-` labels + clamped `±1σ` pills (20 px edge margin with `↑`/`↓` prefixes) + off-canvas X hiding + `ignoreEvent: true`.
   - `kline-adapter.ts`, `chart-workstation.tsx`, `market-chart.tsx`: `totalStep: 6`, value-equality short-circuit (`sameExpectedMoveCone`), right-offset adjust/restore lifecycle, `try/catch`-guarded effect, and `Expected move (<expiry>)` in Object Tree.
4. **Portal UI, `/stock/[symbol]`, `/charts`, & `/lab`:**
   - `ExpectedMoveBar` returns `null` when disabled, uses semantic tokens only, `min-h-11` interactive targets, responsive `flex-wrap` (`375px`–`1440px`, verified `overflowX: 0` in headless Chrome dark & light), and truthful loading/error/unavailable/replay/basis states.
   - `/stock/[symbol]` computes synchronously from the loaded chain (default enabled), preserves `lastChain?.expiries`, maps `"no-answer"` to error with Retry, and syncs expiry switches with the URL.
   - `/charts` gates eligibility with `OptionsChainSymbolSchema`, scopes expiry by `{ symbol, expiry }`, cancels stale fetches via generation counter, and hides the cone during bar replay.
   - `/lab/charts` aligns `labChartsOptionsChain` to `LAB_NOW` and `labBarsOutput` last closes.

## Drift Items Found and Dispositions

| # | Severity | Item | Disposition |
| --- | --- | --- | --- |
| 1 | MEDIUM | `BE+` / `BE-` text labels omitted alongside straddle ticks in `expected-move-overlay.ts` | **Fixed in code:** added `BE+` and `BE-` text figures with `ignoreEvent: true` when `data.hasStraddle && targetVisibleX`, matching `design.md` and `before-after-mock.svg`. |
| 2 | LOW | `OptionsExpectedMoveInputSchema` reused `OptionsChainInputSchema` directly (no duplicate export) | **Accepted (knip rule):** `knip` forbids duplicate re-export aliases (`OptionsChainInputSchema\|OptionsExpectedMoveInputSchema`); `OptionsExpectedMoveInput` type alias is exported while `.input(OptionsChainInputSchema)` enforces the exact schema. |
| 3 | LOW | `kline-adapter-scripts.test.ts` and `kline-adapter-series.test.ts` chart mocks omit optional offset stubs | **Accepted:** `kline-adapter.ts` guards `typeof chart.getOffsetRightDistance === "function"` / `setOffsetRightDistance` / `getBarSpace`, and `kline-adapter.test.ts` exercises all three stubbed methods. |
| 4 | LOW | Native `<input type="checkbox">` inside `min-h-11` `<label>` used for toggle instead of `aria-pressed` button | **Accepted:** matches `Order-flow marks` toggle in `ChartToolbar` with native checkbox accessibility and 44 px touch target. |
