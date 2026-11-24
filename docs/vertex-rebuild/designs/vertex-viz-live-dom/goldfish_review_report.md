# Goldfish Fresh-Context Review: `docs/vertex-rebuild/designs/vertex-viz-live-dom/design.md`

**Reviewed artifacts:** `design.md`, `before-after-mock.svg`, `data-flow.svg`  
**Verified against codebase:** `infra/quant-vps/history/vertex_history.py`, `packages/api/src/contracts/flow.ts`, `packages/api/src/server/{flow,market-data,handler,agent-viewer,operator-access,assistant}.ts`, `packages/api/src/{market-data.test.ts,flow-trade-signing.ts,flow-liquidity-heatmap-rules.ts,status-language.test.ts,openapi.ts,index.ts}`, `packages/db/src/{schema/flow.ts,server/flow.ts,server/request-scope.ts}`, `apps/web/src/server/request-scope.ts`, `apps/web/src/app/api/orpc/[...rest]/route.ts`, `apps/web/src/components/portal/flow-workspace.tsx`, `apps/web/wrangler.jsonc`, `scripts/lib/status-language.ts`, `scripts/ci/public-names.ts`, `AGENTS.md`.

**Overall readiness:** **Not implementation-ready as written** — strong overall direction (reuses existing IBKR L2 + tape streams, zero new DB tables, bounded SSE lease), but contains **1 CRITICAL**, **8 HIGH**, **5 MEDIUM**, and **3 LOW** findings that must be resolved in `design.md` and the SVGs before implementation.

---

## Summary Table

| # | Rubric | Severity | Verdict | Title |
| --- | --- | --- | --- | --- |
| F1 | 2. Design Critique | **CRITICAL** | PROPOSE FIX | `async function*` DB-finalization race, unspecified mid-stream fallback, and missing `AbortSignal` propagation |
| F2 | 1. Consistency | **HIGH** | PROPOSE FIX | `Bid T` / `Ask T` and "Session" vs "Window" volume contradict across `design.md` and both SVGs |
| F3 | 2. Design Critique | **HIGH** | PROPOSE FIX | Cloudflare Worker subrequest count (`51` fetches/lease), `cpu_ms: 500` budget, and lease wall-time overrun |
| F4 | 2. Design Critique | **HIGH** | PROPOSE FIX | `fetchMarketDom` HTTP `404` -> `"not_found"` mismatches `MarketDataErrorCode` and breaks `market-data.test.ts` |
| F5 | 2. Design Critique | **HIGH** | PROPOSE FIX | Status-language guard hazard (`unknown` wire value) and missing IBKR error redaction on `depthStream`/`tapeStream` |
| F6 | 2. Design Critique | **HIGH** | PROPOSE FIX | `vertex_history.py` lock/data bugs: rollover ring pollution, 2-print seed bug, `seq` collision, duplicate L2 levels, GIL load |
| F7 | 3. Architecture | **HIGH** | PROPOSE FIX | Missing `z.coerce.number()` for `GET` query params & preset-vs-range mismatch on `windowSeconds`/`cadenceMs` |
| F8 | 4. Readiness | **HIGH** | PROPOSE FIX | Incomplete contract schemas (`VertexDomUpstreamSchema`, `FlowLiveDomSchema`, `rows`, `totals`, `depthFeed`/`tapeFeed`, `locked`/`crossed` spread sign) |
| F9 | 4. Readiness | **HIGH** | PROPOSE FIX | Client Reset volume baseline breaks when old prints roll out of the rolling window or `windowSeconds` changes |
| F10 | 2. Design Critique | **MEDIUM** | PROPOSE FIX | Auth doc cites wrong constant (`AGENT_API_KEY_PROCEDURE_ROOTS` instead of `AGENT_API_KEY_PROCEDURE_PATHS` / `AGENT_API_KEY_READ_PROCEDURES`) |
| F11 | 2. Design Critique | **MEDIUM** | PROPOSE FIX | Recorded fallback lacks snapshot lookback window, `limit: 1`, `readLargeTrades` bound, and `ticks` freshness |
| F12 | 3. Architecture | **MEDIUM** | PROPOSE FIX | `FlowGateway.liveDomStream` signature (`signal`), `packages/api/src/index.ts` export, `FLOW_API_ERRORS`, and `/flow` footer copy |
| F13 | 3. Architecture | **MEDIUM** | PROPOSE FIX | 100% coverage ratchet requires explicit testability hooks for SSE sleep/timers/abort/visibility |
| F14 | 4. Readiness | **MEDIUM** | PROPOSE FIX | Underspecified tick-snapping rounding, duplicate-price summing, >80-tick spread centering, POC tie-breaking, and rollover client resets |
| F15 | 1. Consistency | **LOW** | PROPOSE FIX | `rows` lower bound differs (`1..10` in Python vs `5..10` in oRPC) without rationale |
| F16 | 1. Consistency | **LOW** | PROPOSE FIX | Verification Plan cites nonexistent `server/market-data.test.ts` (actual: `packages/api/src/market-data.test.ts`) |
| F17 | 2. Design Critique | **LOW** | DECLINE | Public-repo privacy hygiene check (no leaks found; `Author` matches sibling design docs) |

---

## Detailed Findings

### Rubric 1 — Comprehension & Internal Consistency

#### F2 · HIGH · PROPOSE FIX — `Bid T` / `Ask T` and "Session" vs "Window" volume contradict across `design.md`, `before-after-mock.svg`, and `data-flow.svg`

- **Evidence:**
  - `design.md` (lines 15, 63) includes `Bid T` and `Ask T` in the 8 desktop columns ("traded-at-bid and traded-at-ask columns") but **never defines their semantics, data source, or clearing rules** in Terms, Contracts, or `live-dom-view-model.ts`.
  - `before-after-mock.svg` calls them "inside-market prints (Bid T / Ask T)" in the BEFORE bullets, yet populates `Bid T` across all 5 resting bid rows (`82, 145, 54, 28, 14`) and `Ask T` across all 5 resting ask rows (`18, 34, 62, 48, 124`), and those values do not reconcile with `Traded Volume · Net Δ` (e.g. `6012.50` has `vol=355, netDelta=+125` => `buy=240, sell=115`, yet `Ask T=124` and `Bid T` is blank). Also the mock header total `2,469` differs from the sum of visible rows (`2,464`).
  - `data-flow.svg` Box 4 lists `Session Bid T / Ask T` and `Window vs Session vol` — neither exists in `design.md`.
- **Exact fix:**
  > In `design.md` under **Terms** and **Architecture & Contracts §4**, explicitly define `Bid T` and `Ask T`:
  > - **`Bid T` (Traded at Bid):** `row.tradedSell` (contracts signed as seller-initiated at that price in the active rolling window, or since Reset). Displayed for every row where `tradedSell > 0` (or explicitly restricted to resting-bid/inside rows if desired — state the exact rule).
  > - **`Ask T` (Traded at Ask):** `row.tradedBuy` (contracts signed as buyer-initiated at that price in the active rolling window, or since Reset). Displayed for every row where `tradedBuy > 0`.
  > - Update `data-flow.svg` Box 4 from `Session Bid T / Ask T` / `Window vs Session vol` to `Bid T / Ask T display` and `Window vs Since-Reset vol`.
  > - Update `before-after-mock.svg` so `Bid T` = `sell` and `Ask T` = `buy` (e.g. at `6012.50`: `Bid T=115`, `Ask T=240`, `Vol=355`, `Net Δ=+125`), and clarify in the caption that visible rows are a 10-row viewport slice of the total window volume (`2,469`).

#### F15 · LOW · PROPOSE FIX — `rows` lower bound mismatch (`1..10` vs `5..10`)

- **Evidence:** `design.md` lines 74 & 77 set `DOM_ROWS_MIN = 1` in `vertex_history.py`, while line 97 sets `rows: 5..10` in `FlowLiveDomInputSchema`.
- **Exact fix:**
  > Align both to `rows: 1..10` (default `10`), or add one sentence in §3 noting that the oRPC API enforces a stricter `5..10` minimum than `vertex-history`'s `1..10`.

#### F16 · LOW · PROPOSE FIX — Wrong test file path in Verification Plan

- **Evidence:** `design.md` line 124 lists `server/market-data.test.ts`; the actual file in the repository is `packages/api/src/market-data.test.ts`.
- **Exact fix:**
  > Replace `server/market-data.test.ts` with `market-data.test.ts` (under `packages/api/src/`), and note `scripts/ci/public-names.test.ts` runs as part of `bun run test:operations`.

---

### Rubric 2 — Design Critique

#### F1 · CRITICAL · PROPOSE FIX — `async function*` DB-finalization race, unspecified mid-stream failure path, and missing `AbortSignal` propagation

- **Evidence:**
  - `apps/web/src/server/request-scope.ts:137-146` schedules `database.finalize()` in `finally` immediately when `handleOrpcRequest()` returns the SSE `Response`.
  - In JavaScript, an `async function*` executes **zero** statements before the first `.next()` call (which happens inside the `ReadableStream` *after* `withRequestScope`'s `finally` has already started closing Postgres). If `openFlowLiveDomStream` is written as `async function*`, fallback DB queries will race against or hit a closed connection.
  - Once streaming starts (t > 0), the DB connection is closed; if `fetchMarketDom` fails or `depthStream.state` leaves `"live"` mid-stream, Postgres fallback is impossible. `design.md` does not define what the generator yields on mid-stream errors.
  - `packages/api/src/server/market-data.ts:460-532` (`fetchHistoryDocument`) creates an internal `AbortController` solely for `timeoutMs` and accepts no external `signal?: AbortSignal`. On client disconnect during an in-flight fetch, the Worker stays stuck up to `4_000 ms`.
- **Exact fix:**
  > Add to **Architecture & Contracts §2 and §3**:
  > 1. Add optional `signal?: AbortSignal` to `FetchMarketBarsOptions` in `packages/api/src/server/market-data.ts`; combine it with the timeout controller in `fetchHistoryDocument` (via `AbortSignal.any([controller.signal, options.signal])` or an abort listener cleaned up in `finally`).
  > 2. Mandate that `openFlowLiveDomStream(deps, input, signal)` is a regular `async function` returning `Promise<AsyncGenerator<FlowLiveDomStreamEvent>>` (NEVER a top-level `async function*`). It `await`s the initial `readFlowLiveDomSnapshot` (including any Postgres fallback) **before** returning the inner `(async function* () { ... })()`. The inner generator must NOT hold a reference to `FlowRepository` or `db`.
  > 3. Define mid-stream failure behavior explicitly: if the initial read returned `source !== "live_stream"`, yield `{ type: "frame", frame }` then `{ type: "reconnect", at, reason: "recorded_fallback", retryAfterMs: 5000 }` and return. If a subsequent live-loop `fetchMarketDom` throws (other than `signal.aborted`) or returns `depthStream.state !== "live"` / empty live book, yield `{ type: "reconnect", at, reason: "upstream_interrupted", retryAfterMs: 5000 }` and return so the next client request opens a fresh request scope and can run Postgres fallback cleanly.

#### F3 · HIGH · PROPOSE FIX — Cloudflare Worker subrequest limit (`51` fetches/lease), `cpu_ms: 500` budget, and lease wall-time overrun

- **Evidence:**
  - `apps/web/wrangler.jsonc:13` sets `"limits": { "cpu_ms": 500 }`.
  - A `25_000 ms` lease at `500 ms` cadence issues up to `1 + 50 = 51` outbound `fetch()` subrequests per Worker invocation — exceeding the 50-subrequest limit on Cloudflare Free tier/constrained runtimes, and running 51 full JSON + strict Zod parses (up to 200 volume levels each) + `buildFlowLiveDom` calls inside one `500 ms` CPU budget.
  - Checking `Date.now() < leaseEndsAt` before starting a `4_000 ms`-timeout fetch lets actual wall time reach `29_000 ms`.
- **Exact fix:**
  > In **Design Decisions §2** and **Architecture & Contracts §3**:
  > 1. Set `FLOW_LIVE_DOM_STREAM_LEASE_MS = 20_000` (max `40` fetches at `500 ms`, staying safely under both the 50-subrequest floor and 30 s proxy/Worker idle windows) AND cap `FLOW_LIVE_DOM_MAX_POLLS_PER_LEASE = 40`.
  > 2. Bound each loop iteration's fetch timeout to `Math.min(MARKET_DOM_TIMEOUT_MS, Math.max(500, leaseEndsAt - Date.now()))`, and stop looping once `leaseEndsAt - Date.now() < 500` so total wall time never exceeds `FLOW_LIVE_DOM_STREAM_LEASE_MS`.

#### F4 · HIGH · PROPOSE FIX — `fetchMarketDom` HTTP `404` mapping contradicts `MarketDataErrorCode` and breaks `market-data.test.ts`

- **Evidence:**
  - `design.md` line 87 specifies mapping HTTP `404` to `MarketDataError` code `"not_found"`.
  - In `packages/api/src/server/market-data.ts:48-55`, `MarketDataErrorCode` is UPPER_SNAKE_CASE (`"NOT_FOUND"`).
  - In `market-data.ts:367-423`, `upstreamFailure()` maps HTTP `404` to `"UPSTREAM_ERROR"`, and `packages/api/src/market-data.test.ts:1271-1274` **explicitly asserts** `expect(failure.code).toBe("UPSTREAM_ERROR")` for `404 {"error": "not_found"}` on `fetchMarketTape`. Changing `upstreamFailure()` globally will break that test.
- **Exact fix:**
  > In **Architecture & Contracts §2**, specify:
  > - Keep default `upstreamFailure()` behavior unchanged for existing endpoints (`bars`, `ticks`, `depth`, `tape`, `depth-history`).
  > - Add optional `notFoundOn404?: boolean` to `FetchMarketBarsOptions` (default `false`); when `true` and `response.status === 404`, `fetchHistoryDocument` throws `new MarketDataError("NOT_FOUND", "Market DOM endpoint not found on history service (HTTP 404)")`.
  > - `fetchMarketDom` passes `{ ...options, notFoundOn404: true }` and callers check `error instanceof MarketDataError && error.code === "NOT_FOUND"`.

#### F5 · HIGH · PROPOSE FIX — Status-language guard violation risk (`unknown`) and missing IBKR account redaction

- **Evidence:**
  - `packages/api/src/status-language.test.ts` and `scripts/lib/status-language.ts:47` reject any new wire value or displayed string matching `unknown` or `unavailable` (standalone or separated by `_`/`-`). While camelCase `unknownVol` is ignored by the scanner, `lastTrade.side` or any `z.enum([..., "unknown"])` in `contracts/flow.ts` or `market-data.ts` **will fail `packages/api/src/status-language.test.ts`**.
  - `design.md` line 60 calls unsigned volume `unsigned`, while line 79 calls it `unknownVol` and leaves `lastTrade.side` unspecified.
  - `market-data.ts:597,621` applies `tapeStreamError(...)` (redacting IBKR account IDs via `redactIbkrAccounts` and truncating to `MARKET_TAPE_ERROR_MAX = 200`) to `stream.error` on `fetchMarketTape` and `fetchMarketDepthHistory`; `design.md` omits this for `fetchMarketDom`.
- **Exact fix:**
  > In **Architecture & Contracts §1, §2, §3**:
  > 1. Use `"unsigned"` (NEVER `"unknown"`) for unsigned `lastTrade.side` (`"buy" | "sell" | "unsigned"`) and `unsignedVol` in both `vertex-history` `/dom` and `FlowLiveDomSchema` (`tradedUnsigned`), matching `SIGNING_METHOD_LABELS.none = "unsigned"` and avoiding any new allowlist entry in `status-language-allowlist.ts`.
  > 2. Require `fetchMarketDom` to pass both `depthStream.error` and `tapeStream.error` through `tapeStreamError(...)` (redacting IBKR accounts and capping at `200` chars).
  > 3. Require all UI status banners (`live-dom-view-model.ts`) to name definite state + cause + timestamp + next action (e.g., `"Live book starting on QuantVPS since 14:29:50 ET · showing recorded snapshot from 14:25:00 ET · retrying every 5 s"`), never `"unavailable"`, `"unknown"`, `"N/A"`, `"—"`, or `"..."`.

#### F6 · HIGH · PROPOSE FIX — `vertex_history.py` correctness, rollover, and GIL contention defects

- **Evidence (from `infra/quant-vps/history/vertex_history.py`):**
  1. **Contract rollover ring pollution (`TapeFeed.attach`, lines 1629-1640):** `TapeFeed.attach()` does NOT clear `self.prints`. On front-month rollover (`ESU6` -> `ESZ6`), prints from the expired contract (often 40–80 points away) stay in `self.prints` for up to 60 minutes, corrupting `volumeByPrice`, `pocPrice`, and `lastTrade`.
  2. **2-print seed bug (`design.md` line 79):** Copying "up to 2 seed prints before the slice" fails whenever the last 2 prints before `cutoff` share the same price! `TapeFeed.read()` (`vertex_history.py:1769-1776`) correctly scans up to `TAPE_SEED_SCAN` (`5_000`) prints before `start` under `self.lock` to compute scalar `(previous, different)`.
  3. **Duplicate / invalid levels before truncation (`DepthBook.snapshot`, lines 1389-1394):** `DepthBook.snapshot(rows)` slices `[:rows]` *before* `_positive_depth_pairs` filters non-positive/non-finite entries, so an invalid level can displace a valid level; duplicate prices at different IBKR positions are also not aggregated.
  4. **Non-monotonic / colliding `seq = depth_updates + tape_seq` (`design.md` line 80):** Across a `vertex-history` restart or stream state transition (`live` -> `starting` with unchanged counts), summing two independent counters can collide or mask a state/contract change during SSE deduplication.
  5. **Python GIL contention (`ThreadingHTTPServer` shares process with `ib-reader`):** Copying and re-signing up to `50_000` prints on every `500 ms` poll per open tab wastes significant Python CPU in the same GIL process as IBKR callbacks.
- **Exact fix:**
  > Update **Architecture & Contracts §1**:
  > 1. In `TapeFeed.attach()`, if `self.info` existed and `info.get("conId") != self.info.get("conId")`, clear `self.prints` (and reset `self.spans`/`self.open_span`), so rollover never mixes two contracts' prices.
  > 2. In `TapeFeed.live_volume(window_seconds, now, since=None)`, scan up to `TAPE_SEED_SCAN` prints before `cutoff` under `self.lock` to extract scalar `(previous_price, previous_different_price)` (matching `TapeFeed.read()`), and adjust `cutoff = max(cutoff, self.prints[0][0] + 1)` only if desired or document partial-ring edge.
  > 3. Cache the aggregated `live_volume` result in `TapeFeed` keyed by `(self.count, effective_cutoff)` (invalidated automatically whenever a new print increments `self.count` or the cutoff second advances), eliminating repeated 50,000-print scans across concurrent tabs or quiet polls.
  > 4. In `DepthFeed.live_dom_book(rows, now)`, call `self.book.snapshot(DEPTH_STREAM_ROWS * 2)` (or read all levels), filter `_positive_depth_pairs`, aggregate identical prices by summing sizes, sort best-first, and THEN slice `[:rows]`.
  > 5. In `openFlowLiveDomStream`, deduplicate frames by composite key `${frame.contract ?? ""}:${frame.source}:${frame.depthFeed.state}:${frame.tapeFeed.state}:${frame.depthUpdates}:${frame.tapeSeq}` (keeping `seq = depthUpdates + tapeSeq` as informational monotonic revision only within one process lifetime).

#### F10 · MEDIUM · PROPOSE FIX — Wrong API-key allowlist constant referenced

- **Evidence:** `design.md` line 49 says procedures stay excluded from `AGENT_API_KEY_PROCEDURE_ROOTS`. In `packages/api/src/server/handler.ts:17-94`, `"flow"` is NOT in `AGENT_API_KEY_PROCEDURE_ROOTS`; specific `flow.*` procedures (`flow.collect`, `flow.snapshot`, `flow.control`, `flow.events`) are listed in `AGENT_API_KEY_PROCEDURE_PATHS`, and read-key access is listed in `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts:28-99`).
- **Exact fix:**
  > Replace `AGENT_API_KEY_PROCEDURE_ROOTS` in **Design Decisions §2** with `AGENT_API_KEY_PROCEDURE_PATHS` (`packages/api/src/server/handler.ts`) and `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts`), matching `flow.liquidityHeatmap`, `flow.tapeSpeed`, and `flow.strikeHeatmap`.

#### F11 · MEDIUM · PROPOSE FIX — Recorded fallback query bounds, lookback window, and tape freshness

- **Evidence:**
  - `packages/db/src/server/flow.ts` `readBookSnapshots` queries `from <= captured_at < to ORDER BY captured_at DESC LIMIT limit`; using `windowSeconds` (e.g., 15m) during closed/overnight hours returns 0 rows even when a closing snapshot exists.
  - `packages/db/src/server/flow.ts` `readLargeTrades` has **no SQL `LIMIT`** (violates `.agents/skills/scalability/SKILL.md` rule against unbounded result sets).
  - Querying only `latestSamples(symbol, ["depth"])` leaves `tapeFeed` without real freshness metadata in fallback mode.
- **Exact fix:**
  > In **Design Decisions §3** and **Architecture & Contracts §3**:
  > - Query `readBookSnapshots({ symbol, from: new Date(now - 72 * 3600_000), to: now, limit: 1 })` to get the single newest stored L2 snapshot within 72 hours (covering weekends), and anchor `readLargeTrades` to `[snapshotCapturedAt - windowSeconds, snapshotCapturedAt]` (or `[now - windowSeconds, now]` when no snapshot exists), bounding in-memory aggregation and/or adding an explicit `limit` (e.g., `5_000`) to `readLargeTrades`.
  > - Query `latestSamples(symbol, ["depth", "ticks"])` so both `depthFeed` and `tapeFeed` carry truthful recorded timestamps/states in fallback mode.

#### F17 · LOW · DECLINE — Public-repo privacy hygiene

- **Evidence:** Scanned `design.md`, `before-after-mock.svg`, and `data-flow.svg` against `scripts/ci/public-names.ts` and `AGENTS.md`: zero `*.ts.net` labels, zero Discord guild IDs, zero secrets/tokens/URLs/account IDs. `- **Author:** Jeff Scott Ward (written by an agent)` matches approved sibling design docs (`vertex-viz-strike-profiles/design.md`, `vertex-viz-tape-speed/design.md`).
- **Verdict:** **DECLINE** (no change needed to `Author`; IBKR account redaction in runtime error strings is already tracked under **F5**).

---

### Rubric 3 — Zoom-Out Architecture

#### F7 · HIGH · PROPOSE FIX — Missing `z.coerce.number()` for `GET` query params & preset-vs-range mismatch

- **Evidence:**
  - Both `flow.liveDom` (`GET /flow/live-dom`) and `flow.liveDomStream` (`GET /flow/live-dom/stream`) receive HTTP query params as strings under `OpenAPIHandler`. Every sibling `GET /flow/*` input in `packages/api/src/contracts/flow.ts` (`snapshotMinutes`, `FlowEventsInputSchema.limit`) uses `z.coerce.number().int()`. Plain `z.number()` will fail OpenAPI `GET` requests with `400`.
  - Lines 95–98 define `FLOW_LIVE_DOM_CADENCE_MS = [500, 1000, 2000]` and `FLOW_LIVE_DOM_WINDOW_SECONDS = [300, 900, 1800, 3600]`, yet allow arbitrary integers `60..3600` and `500..2000`. Arbitrary `windowSeconds` fragments `TapeFeed` caching (see F6).
- **Exact fix:**
  > In **Architecture & Contracts §3**:
  > - Specify `z.coerce.number().int()` for `rows`, `windowSeconds`, and `cadenceMs`.
  > - Either restrict `windowSeconds` to `z.coerce.number().int().refine(...)` / `z.union([z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])` (or keep `60..3600` with explicit justification and snap cache keys to 1 s) and restrict `cadenceMs` to `500..2000` (with presets `[500, 1000, 2000]` in the UI).
  > - Note that `packages/api/openapi.json` must be regenerated via `bun run openapi:generate` and verified with `bun run openapi:check` (confirming `eventIterator` on `GET` emits valid OpenAPI `text/event-stream`, matching `assistant.send`).

#### F12 · MEDIUM · PROPOSE FIX — Alignment with `FlowGateway`, `packages/api/src/index.ts`, `FLOW_API_ERRORS`, and `/flow` workspace

- **Evidence:**
  - `apps/web/src/components/portal/flow-workspace.tsx:123-139`: adding `liveDom` and `liveDomStream` to `FlowGateway` requires updating test doubles in `flow-workspace.test.tsx` and `lab/entries/research.tsx`, AND `liveDomStream` must accept `(input: LiveDomStreamRequest, options?: { signal?: AbortSignal }) => Promise<AsyncIterable<FlowLiveDomStreamEvent>>` (matching `apps/web/src/components/portal/assistant-client.ts:15-26`).
  - `packages/api/src/index.ts:176-181` re-exports every sibling `flow-*-rules.ts` module so `apps/web/src/lab/fixtures/flow.ts` can build valid fixtures via `@darkfactory/api`. `design.md` omits `export * from "./flow-live-dom-rules.ts"`.
  - `packages/api/src/contracts/flow.ts` defines `FLOW_API_ERRORS` (`BAD_REQUEST`, `FORBIDDEN`, `STORAGE_ERROR`, `UNAUTHORIZED`); `design.md` does not state that both new procedures reuse `flow = oc.errors(FLOW_API_ERRORS)`.
  - `flow-workspace.tsx:1058-1060` footer copy says *"ES and NQ depth is recorded (streamed at 5 s when active, 1 min sampled fallback)"*, which will slightly contradict the Live DOM panel unless clarified.
- **Exact fix:**
  > Add to **Architecture & Contracts §3 and §4**:
  > - Both `flow.liveDom` and `flow.liveDomStream` attach to `const flow = oc.errors(FLOW_API_ERRORS)` (no new error codes).
  > - Re-export `flow-live-dom-rules.ts` from `packages/api/src/index.ts` and register `liveDom` / `liveDomStream` in `flowContract` and `flowRouter`.
  > - Specify exact `FlowGateway` methods: `liveDom(input)` and `liveDomStream(input, options?: { signal?: AbortSignal })`, and note updates to `flow-workspace.test.tsx`, `lab/entries/research.tsx`, and the `/flow` footer note.

#### F13 · MEDIUM · PROPOSE FIX — 100% coverage ratchet testability hooks

- **Evidence:** Per `AGENTS.md` (ADR-016), all 4 new TypeScript files (`flow-live-dom-rules.ts`, `server/flow-live-dom.ts`, `live-dom-view-model.ts`, `flow-live-dom-panel.tsx`) must hit **100% lines, branches, functions, and statements** with zero coverage exclusions. Streaming loops with `setTimeout`, `AbortSignal`, reconnect backoff, and `visibilitychange` easily create untestable race branches unless sleep/clock/fetcher are injectable.
- **Exact fix:**
  > Add to **Architecture & Contracts §3 & §4**:
  > - `openFlowLiveDomStream` accepts injectable `deps: { fetchDom, repository, now, sleep, leaseMs, heartbeatMs }` (with production defaults) so unit tests deterministically exercise lease expiry, heartbeat emission, deduplication, abort during sleep, abort during fetch, mid-stream failure, and recorded fallback at 100% branch coverage with zero real sleeps.
  > - `FlowLiveDomPanel` accepts optional test props (or uses fake timers cleanly) for reconnect backoff and `visibilitychange`, avoiding unreachable defensive branches.

---

### Rubric 4 — Implementation Readiness

#### F8 · HIGH · PROPOSE FIX — Missing exact wire schemas, field names, bounds, and signed `spread` on locked/crossed books

- **Evidence:** `design.md` lines 78–80, 86, and 99–100 name top-level keys only; critical schema details are missing or internally inconsistent:
  - `VertexDomUpstreamSchema`: line 78 says `DepthFeed.live_dom_book` returns `stream` and `lastUpdate`; line 79 says `TapeFeed.live_volume` returns `stream` with `lastPrint`; line 86 says `depthStream`, `tapeStream`, `volumeByPrice`. Exact envelope keys, array max bounds, and timestamp format (ISO UTC vs epoch seconds) are unspecified.
  - `FlowLiveDomSchema`: exact shapes of `rows[]`, `totals`, `lastTrade`, `depthFeed`, `tapeFeed`, `rules`, and `FlowLiveDomStreamEventSchema.reconnect.reason` are completely unspecified.
  - **Locked / crossed book bug trap:** On `"locked"` (`bestBid === bestAsk`), `spread = 0` and `spreadTicks = 0`; on `"crossed"` (`bestBid > bestAsk`), `spread < 0` and `spreadTicks < 0`. If `spread` or `spreadTicks` uses `.positive()`, Zod validation throws on locked/crossed books!
- **Exact fix:**
  > Add a concise **Exact Wire & Contract Schemas** subsection in `design.md` §1–§3 specifying:
  > - **`GET /dom` (`vertex-history-dom-v1`)**: `{ schema: "vertex-history-dom-v1", source: "ibkr-gateway", client_id: 77, symbol: "ES"|"NQ", contract: MarketContractSchema|null, minTick: positive|null, windowSeconds: int(60..3600), since: int|null, seq: int>=0, depthUpdates: int>=0, tapeSeq: int>=0, fetchedAt: isoUtc, bids: [price>0, size>0][<=10], asks: [price>0, size>0][<=10], volumeByPrice: [price>0, buyVol>=0, sellVol>=0, unsignedVol>=0, trades>=0][<=200], lastTrade: { t: int>0, price: >0, size: >0, side: "buy"|"sell"|"unsigned" }|null, depthStream: { state: "live"|"starting"|"down"|"off"|"halted", error: string(<=2000)|null, lastUpdate: isoUtc|null }, tapeStream: { state: "live"|"down"|"off", error: string(<=2000)|null, lastPrint: isoUtc|null } }`.
  > - **`FlowLiveDomRowSchema`**: `{ price: >0, tickIndex: int, bidSize: >=0, askSize: >=0, cumBidSize: >=0, cumAskSize: >=0, tradedBuy: >=0, tradedSell: >=0, tradedUnsigned: >=0, tradedTotal: >=0, tradedDelta: finite, trades: int>=0, imbalance: "buy"|"sell"|null, isBestBid: boolean, isBestAsk: boolean, isLastTrade: boolean, isPoc: boolean }`.
  > - **`FlowLiveDomTotalsSchema`**: `{ bidSize: >=0, askSize: >=0, bidSharePct: 0..100|null, tradedBuy: >=0, tradedSell: >=0, tradedUnsigned: >=0, tradedTotal: >=0, tradedDelta: finite, trades: int>=0 }`.
  > - **`FlowLiveDomFeedSchema`** (for both `depthFeed` and `tapeFeed`): `{ state: "live"|"starting"|"down"|"off"|"halted"|"recorded"|"never", lastAt: timestamp|null, error: text(200)|null }`.
  > - **`FlowLiveDomSchema` inside-market fields**: `bestBid: positive|null`, `bestAsk: positive|null`, `mid: positive|null` (`(bestBid+bestAsk)/2` when both present, else `bestBid ?? bestAsk ?? null`), `spread: finite|null` (allows `0` for `locked` and `< 0` for `crossed`, `null` for `one_sided`/`empty`), `spreadTicks: int|null` (`Math.round((bestAsk - bestBid) / minTick)` when both present, else `null`).
  > - **`FlowLiveDomRulesSchema`**: `{ version: literal("flow-live-dom-rules.v1"), maxLevels: int>0, imbalanceMinContracts: int>0, imbalanceRatio: >0, streamLeaseMs: int>0, heartbeatMs: int>0 }`.
  > - **`reconnect` event**: `{ type: "reconnect", at: timestamp, reason: "lease_expired"|"recorded_fallback"|"upstream_interrupted", retryAfterMs: int(0..30_000) }`.

#### F9 · HIGH · PROPOSE FIX — Client-side Reset baseline breaks when old prints age out of the rolling window or `windowSeconds` changes

- **Evidence:** `design.md` line 60 subtracts a static snapshot of per-price volumes taken at Reset time (`Math.max(0, current - baseline)`). Because `vertex-history` returns a **rolling** window (`t >= now - windowSeconds`), as old pre-reset prints age out of the window, `current` drops below `baseline`, swallowing **new post-reset prints** until new volume exceeds the aged-out volume! Changing `windowSeconds` while Reset is active also injects pre-reset prints from the wider window.
- **Exact fix:**
  > Preferred (exact, zero drift, ~5 lines of Python): add optional `since` (epoch seconds, bounded to `[now - 3600, now]`) to `GET /dom`, `FlowLiveDomInputSchema`, and `FlowLiveDomStreamInputSchema`. When the user clicks **Reset vol**, the client sets `since = Math.floor(Date.now() / 1000)` and reopens/updates the stream; `TapeFeed.live_volume` uses `cutoff = max(int(now) - window_seconds, since)`. Clicking "Full window" clears `since`.  
  > *(Alternative if staying purely client-side: ratchet each price's baseline downward via `baseline[tick] = Math.min(baseline[tick], current)` on every frame so roll-off never swallows new prints, clear baseline on `windowSeconds`/`symbol`/`contract` change, and label the UI honestly as "Since reset (approx. within rolling window)".)*

#### F14 · MEDIUM · PROPOSE FIX — Underspecified edge cases in `buildFlowLiveDom` and `live-dom-view-model`

- **Evidence:** Several implementation-critical rules are missing from `design.md`:
  1. **Floating-point canonicalization:** `tickIndex * minTick` should be rounded with `Math.round(tickIndex * minTick * 1_000_000) / 1_000_000` (matching `flow-liquidity-heatmap-rules.ts:127`), and client maps (`Bid Δ`/`Ask Δ`, Reset baseline) must key by `row.tickIndex`, not float strings.
  2. **Null `minTick` fallback:** If upstream `minTick` is `null`, fall back to `FLOW_INSTRUMENTS[symbol].minTick` (`0.25` for ES/NQ).
  3. **Duplicate prices after tick snapping:** Sum resting sizes and traded volumes for entries snapping to the same `tickIndex` (never overwrite).
  4. **Outward cumulative depth on locked/crossed books:** Always accumulate `cumBidSize` descending from highest bid price and `cumAskSize` ascending from lowest ask price, independent of `bookState`.
  5. **Wide spread (`spreadTicks >= 80`) / empty book centering:** Anchor ladder on `mid` (normal/locked/crossed), `bestBid ?? bestAsk` (one-sided), `lastTrade.price` (empty book with tape), or `pocPrice` (empty book with volume); when `spreadTicks >= 80`, anchor on `bestBid`/`bestAsk` or explicitly state that the 80-row window centers on `mid` while the header still reports true inside bid/ask.
  6. **POC tie-breaking:** When max `tradedTotal === 0`, `pocPrice = null, pocVolume = 0`. On ties (`> 0`), pick the price closest to `mid ?? lastTrade?.price ?? 0`, breaking exact equidistant ties by higher price.
  7. **Client state resets:** Clear `prevBookSizes` (`Bid Δ`/`Ask Δ`), Reset state, and Axis Lock whenever `symbol`, `contract`, or `source` (`live_stream` <-> `recorded_fallback`) changes.
- **Exact fix:**
  > Add a short **Edge-Case Rules** checklist to **Architecture & Contracts §3–§4** incorporating items 1–7 verbatim so unit tests in `flow-live-dom-rules.test.ts` and `live-dom-view-model.test.ts` lock each invariant.
>
---

## EGM Resolution Summary (Auto-Accept)

Per the standing EGM resolution rule (owner decision 2026-11-13):

- **PROPOSE FIX (16/17):** F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16 — all 16 applied to `design.md`, `before-after-mock.svg`, and `data-flow.svg` before implementation.
- **DECLINE (1/17):** F17 (public-repo privacy hygiene — no leaks found; kept as recorded).
- **CONTEST (0/17):** none.
- **ESCALATE (0/17):** none.
