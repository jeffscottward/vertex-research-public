# Goldfish Review Resolution Report — IV Rank and Percentile History (`vertex-viz-iv-rank-history`)

- **Target:** `docs/vertex-rebuild/designs/vertex-viz-iv-rank-history/design.md`
- **Date:** 2026-11-23
- **Review mode:** Consolidated report with all review rubrics (auto-selected under standing owner rule, 2026-11-15 / permanent 2026-11-18).
- **Resolution mode:** Auto-accept all PROPOSE FIX findings (standing owner rule, 2026-11-13). Zero ESCALATE findings.
- **Fresh-context Goldfish reviewers:**
  - `egm-zoom-out` → [zoom_out_report.md](zoom_out_report.md) (7 findings)
  - `egm-comprehension` → `agent://comprehension` (summarized below)
  - `egm-design` → [critic_report.md](critic_report.md) (13 findings)
  - `egm-implementation-readiness` → [implementation_readiness_report.md](implementation_readiness_report.md) (14 findings)

## Resolution summary

- **PROPOSE FIX accepted and applied to `design.md`:** 14 consolidated items (covering all Blocker, Major, and Nit findings across the 4 reviewers)
- **CONTEST:** 2 items (documented below)
- **DECLINE:** 0
- **ESCALATE:** 0

## Consolidated resolutions

| # | Severity | Issue (sources) | Disposition | Resolution applied in `design.md` |
| --- | --- | --- | --- | --- |
| R1 | Blocker | Rolling own-IV null-row semantics diverged from `openbbEvaluateOwnIvBasis` (zoom-out #1, critic #1, readiness #9) | PROPOSE FIX (accepted) | Unified in `packages/api/src/openbb-iv-standing.ts`: every rolling own-IV point requires 252 contiguous stored rows with zero null `atmIv30d`, guaranteeing 100% point-in-time parity with `openbb.volContext({ asOf })`. |
| R2 | Blocker | `sessions` on GET OpenAPI route lacked `z.coerce.number()` and path wrote `/api/rpc/` instead of `/api/openapi/` + `/api/orpc/` (critic #2, readiness #4, #5) | PROPOSE FIX (accepted) | Pinned `z.coerce.number().pipe(...)` matching `OpenbbInsiderClustersInputSchema`, fixed paths to `/api/openapi/openbb/iv-history` and `/api/orpc/openbb/ivHistory`, and added OpenAPI GET test. |
| R3 | Blocker | Unbounded `asOf` lower bound could trigger `MarketDailySeriesInputError` HTTP 500 (critic #3) | PROPOSE FIX (accepted) | Changed `asOf` to `historyFrom.optional()` (`>= 1900-01-01`) and catch `MarketDailySeriesInputError` as `BAD_REQUEST`. |
| R4 | Blocker | Duplicate `IvHistoryGateway` vs `OpenbbGateway` signature mismatch & nesting OpenBB inside QuantData `OptionsAnalyticsPanel` (zoom-out #2, critic #4, #7, readiness #1, #2, #11) | PROPOSE FIX (accepted) | Added `ivHistory(symbol, sessions?)` to `OpenbbGateway`, exported `type IvHistoryGateway = Pick<OpenbbGateway, "ivHistory">`, and mounted `IvRankHistoryPanel` as a sibling of `OptionsAnalyticsPanel` in `StockDetailWorkspace` (reusing `openbb` prop) and `ChartsWorkspace` (adding `openbb?: IvHistoryGateway`). Leaves `options-analytics-panel.tsx` untouched. |
| R5 | Blocker | `/lab/markets` renders `MarketContextPage`, not `OpenbbMarketsSection` (zoom-out #3, critic #4, readiness #3) | PROPOSE FIX (accepted) | Scoped `/lab` fixture wiring to `/lab/charts` and `/lab/stock` (`apps/web/src/lab/entries/charts.tsx`), keeping `/lab/markets` (`lenses.tsx`) unchanged; verified `OpenbbMarketsSection` via unit tests. |
| R6 | Major | Day-252 auto-switchover collapses Core 7 1Y/2Y chart to 1 point for months (critic #5) | PROPOSE FIX (accepted) | Select `own_atm_iv` once own rolling points cover `requestedSessions` (or when no proxy exists), otherwise keep full `vol_index_proxy` history while returning `own` standing metadata; always show `"Showing N of M sessions"` when partial. |
| R7 | Major | `openbbEvaluateProxyIvBasis` hardcoded `"in 420d window"` (zoom-out #1, critic #6, readiness #8) | PROPOSE FIX (accepted) | Added optional `lookbackDays = 420` parameter to `openbbEvaluateProxyIvBasis` so `volContext` preserves `"420d window"` and `ivHistory` reports its actual lookback. |
| R8 | Major | Regime label metric unspecified & `reason` omitted on selected basis (comprehension #1, #2, critic #11, readiness #12) | PROPOSE FIX (accepted) | Pinned regime label to `ivRank ?? ivPercentile` (`>= 80` High IV, `<= 20` Low IV, `> 20 && < 80` Mid range); pinned `reason` on selected basis (`own.reason` / `proxy.reason`); documented `OpenbbIvBasisResultSchema` fields. |
| R9 | Major | Bespoke SVG pointer/arrow-key scrubbing conflicts with `role="img"` and diverges from existing portal SVG charts (zoom-out #5, critic #12, readiness #12) | PROPOSE FIX (accepted) | Aligned with existing portal SVG panels (`flow-put-call-ratio-panel.tsx`, `flow-hedging-pressure-panel.tsx`): responsive SVG (`role="img"`, descriptive `aria-label`, `vectorEffect="non-scaling-stroke"`), KPI summary strip, horizon & series toggles (`disabled` on last active series), and collapsible `<details>` table (`min-h-11` summary) of latest 10 sessions + 52w high/low milestones. |
| R10 | Major | Missing 30s timeout, error formatter, UTC date parsing, and `@darkfactory/ui` token/primitive refs (zoom-out #7, critic #8, readiness #6, #12) | PROPOSE FIX (accepted) | Specified `OPENBB_REQUEST_TIMEOUT_MS = 30_000` with Retry, `describePortfolioMonitorFailure`, UTC `YYYY-MM-DD` formatting (`MMM DD` for 3M/6M, `MMM YY` for 1Y/2Y), `@darkfactory/ui` primitives, and verified `packages/ui/src/styles.css` CSS tokens. |
| R11 | Major | Unbounded MCP payload at `sessions: 504` (critic #9, readiness #10) | PROPOSE FIX (accepted) | Added MCP `present` formatter in `packages/api/src/server/mcp.ts` capping presented daily points to newest 63 + min/max milestones with `pointsOmitted`. |
| R12 | Major | Inaccurate table/index note (`market_daily_series` vs `market_daily_points` and `(as_of, underlying)` PK) (critic #10, readiness #14) | PROPOSE FIX (accepted) | Corrected table name to `market_daily_points` (PK `(series_id, date)`) and documented `(as_of, underlying)` PK with explicit row-count threshold (100k rows) for adding a secondary index if collection expands beyond Core 7. |
| R13 | Major | Unnamed Playwright spec & `/charts` IBKR bars dependency (critic #13, readiness #13) | PROPOSE FIX (accepted) | Named `tests/e2e/iv-rank-history.spec.ts` targeting `/lab/stock?symbol=SPY&tab=analytics` and `/lab/stock?symbol=NVDA&tab=analytics`; documented `/charts` US `STK` dependency on `marketData.bars`. |
| R14 | Major | Exporting `computeIvWindowStats` and keeping `openbb-iv-standing.ts` cohesive (zoom-out #1, readiness #7) | PROPOSE FIX (accepted) | Export `computeIvWindowStats` and `openbbIvHistory` from `packages/api/src/openbb-iv-standing.ts` (no second duplicate module). |
| C1 | Major | YAGNI critique of multi-horizon (`3M`/`6M`/`1Y`/`2Y`), `asOf`, and MCP registration (zoom-out #4) | CONTEST (retained) | Multi-horizon switching (3M/6M/1Y/2Y) is standard on IV rank history charts (O20) and trivial to support from 10y Cboe vol-index history; `asOf` matches `openbb.volContext` for reproducible tests/audits; read-only MCP + agent-read-key access matches every other `openbb.*` read procedure. |
| C2 | Major | Querying `openbb.ivHistory` for non-Core-7 stocks on `/stock` and `/charts` (zoom-out #6) | CONTEST (retained) | The card goal is explicitly "per ticker", and `cboe-option-iv --symbols` already supports arbitrary symbols in `openbb_option_iv_daily`. Querying the small table (`<1 ms`) avoids hardcoding a Core-7-only UI wall while honestly reporting stored session progress (`0 / 252`) for uncollected tickers. |
