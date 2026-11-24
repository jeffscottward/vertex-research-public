# EGM Drift Report: Live DOM Ladder for ES/NQ (`vertex-viz-live-dom`)

- **Date:** 2026-11-24
- **Design doc:** [design.md](design.md)
- **Goldfish review:** [goldfish_review_report.md](goldfish_review_report.md) (16/17 PROPOSE FIX resolved via auto-accept; 1/17 DECLINE kept as recorded)

## Implementation vs Design Comparison

| Area | Design specification | Implemented code | Drift |
| --- | --- | --- | --- |
| QuantVPS `vertex-history` | `1.8.0`, `GET /dom`, `DOM_SCHEMA = "vertex-history-dom-v1"`, `validate_dom`, `DepthFeed.live_dom_book` (filter+aggregate before slice), `TapeFeed.attach` conId rollover clear, `TapeFeed.live_volume` (lock-free signing, `TAPE_SEED_SCAN`, `since` cutoff, `(tapeSeq, effective_cutoff)` cache, 200-level cap retaining POC) | `infra/quant-vps/history/vertex_history.py` + `test_vertex_history.py` (213 tests passing) | None |
| Market data adapter | `MARKET_DOM_TIMEOUT_MS = 4_000`, `buildMarketDomUrl`, `VertexDomUpstreamSchema`, `fetchMarketDom` with `notFoundOn404: true`, external `signal?: AbortSignal`, `tapeStreamError` redaction on both streams | `packages/api/src/server/market-data.ts` + `packages/api/src/market-data.test.ts` | None |
| oRPC contract & OpenAPI | `flow.liveDom` (`GET /flow/live-dom`), `flow.liveDomStream` (`GET /flow/live-dom/stream`, `eventIterator`), coerced GET query params, preset `windowSeconds`/`cadenceMs`, `"unsigned"` trade side (no `"unknown"`), `FLOW_API_ERRORS`, re-exported rules in `packages/api/src/index.ts`, OpenAPI regenerated | `packages/api/src/contracts/flow.ts`, `packages/api/src/flow-live-dom-rules.ts`, `packages/api/src/index.ts`, `packages/api/openapi.json` | None |
| Server loader & SSE streamer | Regular `async function openFlowLiveDomStream` awaiting initial read/DB fallback before returning inner generator (zero DB reference in generator), `20_000 ms` lease, `<= 40` polls, `5_000 ms` heartbeat, composite dedupe key, 72 h `limit: 1` `readBookSnapshots` + `5_000`-cap `readLargeTrades` + `latestSamples(["depth", "ticks"])` | `packages/api/src/server/flow-live-dom.ts`, `packages/api/src/server/flow.ts` (100% coverage) | None |
| Portal view-model & UI | `FlowLiveDomPanel` on `/flow` below Tape speed, 8 desktop columns (`Bid Δ`, `Bid`, `Bid T`, `Price`, `Ask T`, `Ask`, `Ask Δ`, `Volume · Net Δ`), 4 mobile columns (`375 px`), `min-h-11` targets, semantic tokens, keyboard inspection, `TableScroll`, pause/resume, hidden-tab pause, reset vol (`since`), lock axis + recenter, `/lab/flow` fixture | `apps/web/src/features/flow/live-dom-view-model.ts`, `apps/web/src/components/portal/flow-live-dom-panel.tsx`, `apps/web/src/components/portal/flow-workspace.tsx`, `apps/web/src/lab/fixtures/flow.ts`, `apps/web/src/lab/entries/research.tsx` (100% coverage on new modules) | None |
| Documentation | Update `flow-pipeline.md` and `quantvps-status-endpoint.md` | Updated both docs cleanly; zero private tailnet labels or Discord server IDs | None |

## Verdict

**Zero architectural or behavioral drift.** Every requirement from `design.md` and all 16 auto-accepted Goldfish review findings (F1–F16) are implemented and verified by automated tests.
