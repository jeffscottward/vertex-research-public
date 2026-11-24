# Goldfish Review Report — `vertex-viz-liquidity-heatmap`

**Date:** 2026-11-23  
**Mode:** Consolidated report with all review rubrics (standing owner rule 2026-11-18)  
**Resolution Mode:** Auto accept (owner rule 2026-11-13)  
**Reviewers:** `goldfish-zoom-out`, `goldfish-comprehension`, `goldfish-design-critic`, `goldfish-impl-readiness`

## Summary Counts

| Disposition | Count |
| --- | --- |
| `PROPOSE FIX` (applied to `design.md`) | 19 |
| `CONTEST` (documented below, kept as designed) | 1 |
| `DECLINE` | 0 |
| `ESCALATE` | 0 |

## Findings & Resolutions

### 1. [P0] One-sided books & non-positive price/size values (`comprehension` #1, `impl-readiness` #2)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Defined `mid = (bestBid + bestAsk) / 2` strictly when both are non-null (else `null`); mid-price polyline breaks cleanly across `mid === null` columns while BBO touch lines still render; `inspectColumnSummary` prints `"—"` for null mid/spread; both `DepthFeed.sample()` and `collectDepth` filter `finite && price > 0 && size > 0`, cap at 20 levels/side, recompute `bestBid`/`bestAsk`, and skip persistence if empty.

### 2. [P0] Coarse price-bucket bid/ask collisions (`comprehension` #2)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Emit at most one cell per `(column, p)`: `{ p, s, side }` where `s = bidSize + askSize` and `side = bidSize > 0 && askSize > 0 ? "both" : bidSize > 0 ? "bid" : "ask"`. `currentDom` draws separate non-overlapping bid and ask bar halves (or bid/ask stacked segments) when both exist in one coarse bucket. Defined exact bucket formula `Math.floor((price - priceMin) / priceStep)` clamped to `[0, priceLevels.length - 1]`.

### 3. [P0] Trade dot truncation, ordering, threshold, and y-axis range (`comprehension` #3, `design-critic` #7)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** `flow_large_trades` queries keep the 500 most recent prints in `[windowStart, windowEnd)` (returned ascending by `(second, seq)`) with `tradesTruncated = totalInWindow > 500`. Reference `FLOW_INSTRUMENTS[symbol].deepTradeLimit` (`40` ES, `10` NQ). Price grid bounds span all observed snapshot levels AND plotted trade prices so every trade dot stays inside the y-axis.

### 4. [P0] `DepthBook.snapshot()` dict unpacking crash (`design-critic` #3, `impl-readiness` #2)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Fixed `DepthFeed.sample()` to read `level["price"]` and `level["size"]` from `DepthBook.snapshot(rows)` dict items instead of tuple indexing.

### 5. [P0] IBKR Error `317` (reset) and `2152` routing + post-reset settle window (`design-critic` #1)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Route `317` and `2152` to `DepthFeed` before `DepthBook`; handle `req_id == -1` by resetting all attached `DepthFeed`s and `active_depth`; record `reset_at = now` on `reset_book()` and require `>= 1.0 s` settle window after `attached_at`/`reset_at` before sampling or serving `live_snapshot`.

### 6. [P0] IBKR Error `309` (cap) release and fallback coordination (`design-critic` #2, `impl-readiness` #7)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Mirror `TapeStream`: fail `DepthFeed` with `code=DEPTH_CAP_CODE (309)`, latch cap if `309` arrives on a one-shot `DepthBook` or `req_id == -1` while feeds are active, immediately call `_release(feeds, now)` on ALL feeds in `DepthStream.step()`, set `self.halted = "depth subscription cap reached"`, expose `stream: { state, error }` in `/v1/depth-history` and `health().depth`, and make `flow.collect` skip one-shot `/v1/depth` fallback when `halted` is reported so it does not re-trigger `309`.

### 7. [P0] Live `/v1/depth` reuse envelope, currency check, and concurrency (`design-critic` #3, `impl-readiness` #7)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Check `req["currency"] == "USD"`, `secType == "CONTFUT"`, `exchange == "CME"`, `smartDepth == False`, `rows <= DEPTH_STREAM_ROWS` before serving `live_snapshot`, and return it via `self._ok(...)` so the exact `cache: { hit, ageSeconds, ttlSeconds, stale }` envelope matches `VertexDepthUpstreamSchema`.

### 8. [P0] Postgres `flow_book_snapshots` CHECK constraint hardening (`design-critic` #4)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Added finite guards (`price < 'Infinity'::double precision`, `price <> 'NaN'::double precision` / `isfinite`-equivalent bounds), 1D array checks (`coalesce(array_ndims(col), 0) <= 1`), and exact side-emptiness alignment `(best_bid is null) = (cardinality(bid_prices) = 0)` and `(best_ask is null) = (cardinality(ask_prices) = 0)`.

### 9. [P0] Contract `FLOW_API_ERRORS`, OpenAPI tag `["Flow"]`, `STORAGE_ERROR`, and agent-viewer policy (`impl-readiness` #1, `design-critic` #10)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Use shared `flow = oc.errors(FLOW_API_ERRORS)`, `tags = ["Flow"]`, `operationId: "flow.liquidityHeatmap"`, `STORAGE_ERROR` via `repositoryFor`/`readRows`/`assemble`; drop unimplemented `TOO_MANY_REQUESTS`/`INTERNAL_SERVER_ERROR` claims; keep `flow.liquidityHeatmap` excluded from `AGENT_API_KEY_READ_PROCEDURES` (matching `flow.tapeSpeed`, `flow.hedgingPressure`, `flow.putCallRatio`) and update `agent-viewer.test.ts`.

### 10. [P0] Upstream `market-data.ts` signature, schema alignment, test path, and `coverage-baseline.json` (`impl-readiness` #3)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Specified `fetchMarketDepthHistory(config, input, options)`, `VertexDepthHistoryUpstreamSchema` matching `/v1/tape` (`source`, `client_id`, `fetchedAt`, `stream: { state, error }`), `MARKET_DEPTH_HISTORY_TIMEOUT_MS = 10_000`, `depthStreamError` redaction, real test path `packages/api/src/market-data.test.ts`, and preserving/raising `coverage-baseline.json` thresholds for `market-data.ts`.

### 11. [P0] Guarded rollback SQL (no `IF EXISTS`) and explicit `prune()` wiring (`impl-readiness` #4, `zoom-out` #3, `comprehension`)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Replaced `IF EXISTS` rollback with repo's guarded rollback pattern (`BEGIN; SET LOCAL search_path = pg_catalog, public; SET LOCAL row_security = off; LOCK TABLE "public"."flow_book_snapshots" IN ACCESS EXCLUSIVE MODE; DROP TABLE "public"."flow_book_snapshots"; COMMIT;` + timer-stop header). Updated pruning spec to modify `createFlowRepository().prune` (`packages/db/src/server/flow.ts`), `pruneIfDue` and `FLOW_RETENTION_DAYS` (`packages/api/src/server/flow-collect.ts`), and `packages/db/src/server/flow.test.ts`.

### 12. [P0] Eight required wiring sites added explicitly (`impl-readiness` #5)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Explicitly added all 8 wiring sites to Architecture and Detailed Implementation Plan: (1) `vertex_history.py` `make_handler` routes, `HistoryService.__init__`, `main()`; (2) `packages/db/src/server/index.ts`; (3) `packages/api/src/index.ts`; (4) `packages/api/src/server/flow.ts`; (5) `packages/api/src/agent-viewer.test.ts`; (6) `tests/integration/database/database.test.ts`; (7) `apps/web/src/lab/entries/research.tsx`; (8) all existing `FlowRepository` and `FlowGateway` test fakes.

### 13. [P1] Dead pagination (`more`/`until`) and unused `spans`/`covered` removed (`zoom-out` #2)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Removed unused `spans`/`covered` tracking and `more`/`until` pagination from `DepthFeed` and `collectDepth`. All snapshots in the 600 s lookback (<= 120 rows, or even the full 720-row ring at ~180 KB) fit cleanly in one HTTP response.

### 14. [P1] `IbGateway` farm-break (`2103`/`2105`) and reconnect (`1101`) hooks (`design-critic` #6)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Route `1101` (fail feed so `DepthStream.step()` resubscribes) and `2103`/`2105` (reset book + settle wait) to registered `DepthFeed`s BEFORE the `INFO_CODES` early return in `IbGateway.on_error`.

### 15. [P1] `readBookSnapshots` `DESC` + limit 5000 (`design-critic` #7, `impl-readiness` #6)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Query `ORDER BY captured_at DESC LIMIT 5000` (covers full 390 m × 12/min = 4,680 rows with margin, always preserving newest snapshots) and reverse to ascending in `createFlowRepository().readBookSnapshots`.

### 16. [P1] `choosePriceStep` dynamic fallback ceiling (`design-critic` #8)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** After preferred multipliers `[1, 2, 4, 8, 12, 20, 40, 80, 160]`, add mathematical fallback `Math.ceil((maxPrice - minPrice) / ((MAX_PRICE_BUCKETS - 1) * minTick)) * minTick` so `priceLevels.length <= 80` always holds.

### 17. [P1] Collector isolation & upsert precedence (`zoom-out` #3, `design-critic` #9)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Floor sampled `capturedAt` to whole seconds; in `collectDepth`, write primary `flow_book` + `state.prices` first and isolate `upsertBookSnapshots` secondary write so a snapshot DB fault never breaks `flow_book` or GEX basis; SQL `setWhere`: `excluded.capture = 'streamed' or flow_book_snapshots.capture = 'sampled'`; within one column bucket prefer `'streamed'` over `'sampled'` before tie-breaking by latest timestamp.

### 18. [P1] Server assembly, `/flow` window alignment (`15..390`), `rules.version`, and UI tokens (`impl-readiness` #6, #8; `comprehension` #13; `zoom-out` #4–#6)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Specified `packages/api/src/server/flow-liquidity-heatmap.ts` (`readFlowLiquidityHeatmap`, `windowEnd = now`, `windowStart = now - minutes * 60_000`, `axisStart`/`axisEnd` aligned to `columnSeconds` so `columns.length <= 240`), reused `FLOW_TAPE_SYMBOLS` & `snapshotMinutes`, added `15` and `30` to `FLOW_WINDOW_MINUTES` (`[15, 30, 60, 120, 240, 390]`, default `120`), refined `liquidityColumnSeconds` (`15m -> 5s, 30m -> 10s, 60m -> 15s, 120m -> 30s, 240m -> 60s, 390m -> 120s`), added `rules.version = "flow-liquidity-heatmap-rules.v1"`, defined `heatCellStop` thresholds and `var(--color-success)`/`var(--color-destructive)` dot tokens, and defined focusable container keyboard navigation (`ArrowLeft`/`ArrowRight`) separate from `role="img"`.

### 19. [P1] Reuse `DEPTH_RESET_CODE`, `CONFIGURATION_DIRECTORY`, `health().depth` shape (`zoom-out` #5, `comprehension` #8)

- **Disposition:** `PROPOSE FIX` (applied)
- **Resolution:** Reuse existing `CONFIGURATION_DIRECTORY` with `DEPTH_OFF_FILE = "depth-off"` (and `VERTEX_HISTORY_DEPTH_OFF` override), unify `health().depth` to match `health().tape` (`{ off, halted, feeds: { ES, NQ } }`), and reuse `FLOW_TAPE_SYMBOLS` in API.

### 20. [P0] Keep continuous 5-second `DepthStream` in V1 rather than shipping 1-minute sampled only (`zoom-out` #1)

- **Disposition:** `CONTEST`
- **Rationale:** The card specification explicitly requires continuous CME L2 depth recording (`Data source: IBKR CME L2 for ES/NQ (already paid); needs continuous depth recording`) because Bookmap-style liquidity heatmaps depend on sub-minute depth history to observe resting walls appearing, pulling, and absorbing orders. We resolved the underlying column-granularity mismatch that `zoom-out` identified by (a) exposing `15m` and `30m` in `FLOW_WINDOW_MINUTES` (already supported by `snapshotMinutes` in `contracts/flow.ts`), and (b) refining `liquidityColumnSeconds` so even the default `120m` view (`30s` columns) and `60m` view (`15s` columns) directly benefit from 5-second recording (2x–12x finer than 1-minute sampling), while retaining automatic 1-minute sampled fallback when `depth-off` is set or before `vertex-history` 1.7.0 deploys.
