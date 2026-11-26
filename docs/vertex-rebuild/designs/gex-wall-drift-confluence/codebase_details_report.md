# Codebase details report: gex-wall-drift-confluence design

- **Lens:** EGM Stage 9, Codebase Details Goldfish (Mode: REVIEW).
- **Target:** `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md`, lines 1-185 (FeatureRange 1-167,
  DetailedRange 84-127 and 168-185).
- **Code read:** `packages/api/src/gex-wall-drift-rules.ts` (+ `.test.ts`, `gex-wall-drift-spec.test.ts`, `index.ts`),
  `apps/web/src/features/flow/wall-drift-view-model.ts`, `apps/web/src/components/portal/wall-drift-badge.tsx`,
  `flow-workspace.tsx`, `options-analytics-panel.tsx`, `options-analytics-client.ts`,
  `apps/web/src/features/stock-detail/stock-detail-workspace.tsx`, `apps/web/src/app/(portal)/stock/[symbol]/page.tsx`,
  plus the inputs they depend on (`contracts/flow.ts`, `contracts/options-analytics.ts`, `server/flow-control.ts`,
  `server/flow-collect.ts`, `server/options-analytics.ts`, `server/gex-context.ts`, `lib/request-portal-session.ts`,
  `packages/ui/src/status-badge.tsx`, `lab/fixtures/flow.ts`) and the companion spec
  `docs/specs/strategies/gex-wall-drift-confluence.md`.
- **State reviewed:** the uncommitted working tree of `ws/vertex-gex-drift` as of 2026-11-25 19:04 EST. The rule
  module, its test, the view model, the badge, the spec and the design were being edited while I reviewed. An
  earlier read showed the code using `flipSide: "unknown"` / `hold_flip_unknown` while the test and spec used
  `no_flip` / `hold_no_flip`; by 19:04 all four agree on `no_flip` / `hold_no_flip`. Line numbers below refer to the
  19:04 design file.

## Summary

The rule module matches the Technical Plan closely: the nine values, their sources in `FLOW_SOURCE_METADATA`, the
order of the twelve no-data checks, the three wall no-read codes, the truth table and the output fields are all as
written. The page wiring for `/flow` is as described. The gaps are on the edges: the badge layout claim, the `/stock`
path (no badge while analytics loads or fails, a read that never ages, a GEX time that is the response time), the
price minute, the drift-age reference point, a misleading `/flow` reason when the snapshot fails, and an
over-stated spec check. Three findings contradict the code (Blocker), seven are Major, the rest are Nits.

## Blockers

### B1. "No layout shift between states" is not what the badge classes do (lines 124, 157)

- **Affected scope:** design line 124 (`min-h-20`, `line-clamp-2` reason, "so no layout shift between states") and
  line 157 (NFR "no layout shift between loading, no-data and graded states");
  `apps/web/src/components/portal/wall-drift-badge.tsx` lines 33-71.
- **Discrepancy:** `min-h-20` is 80 px. The badge content is always taller: `py-2` (16 px) + the header row (about
  20-22 px) + `gap-1` + the reason (one or two `text-xs` lines, 16 or 32 px) + `gap-1` + the `<summary>` with
  `min-h-11` (44 px) is about 106 px with a one-line reason and about 122 px with two. So the minimum height never
  binds, and the height changes whenever the reason wraps to a second line or the header row wraps (the header
  `flex-wrap` row only contains the context span "Put wall 600 · above flip 590" when a wall is touched, so graded
  and at-wall reads are wider than not-at-wall and no-data reads). On `/stock` the badge does not exist at all while
  options analytics loads (see B2), so the NFR's "loading" state has no badge to keep stable.
- **Recommendation:** either give the badge a fixed reserved height that covers the two-line reason, a wrapped
  header and the 44 px summary (for example `min-h-32`, measured), and always reserve the context span; or drop the
  "no layout shift" claim from lines 124 and 157 and state what is actually guaranteed (the reason never exceeds
  two lines).

### B2. On `/stock` there is no "No data" state when the GEX input is missing (lines 45, 121-123, 184)

- **Affected scope:** Goal line 45 ("An explicit 'No data' state ... whenever an input is missing or stale"),
  Acceptance line 184 ("renders on ... `/stock` (operator) with an explicit no-data state");
  `options-analytics-panel.tsx` lines 667-694.
- **Discrepancy:** `StockWallDrift` is rendered only inside the `state.type === "ready"` branch of
  `OptionsAnalyticsPanel`. While options analytics is loading, and whenever `optionsAnalytics.snapshot` fails
  (QuantData not configured, 401, 403, rate limit with an error, network), the panel shows its own loading or error
  block and no wall x drift badge at all. The GEX levels on `/stock` come only from that answer, so "GEX missing" on
  `/stock` is a blank, not a no-data read. The `gex_missing` code is never produced on `/stock`
  (`stockWallDriftView` always builds `kind: "levels"`).
- **Recommendation:** either render the badge outside the ready branch for eligible operators and feed
  `{ kind: "missing", code: "gex_missing", detail: <loading or error text> }` when analytics is not ready, or narrow
  the Goal and Acceptance to say that on `/stock` the badge appears only after options analytics answers.

### B3. The read's price is not always "the newest drift minute" (lines 73, 142)

- **Affected scope:** line 73 (B1 "price from the net drift minute"), line 142 ("price from the newest drift
  minute"); `gex-wall-drift-rules.ts` lines 206, 214-215, 322-325; also `docs/vertex-rebuild/flow-pipeline.md`
  "Wall x drift read" ("price from the newest settled drift minute").
- **Discrepancy:** `gexDriftWindow` takes `window.findLast((point) => point.underlyingPrice !== null)`, the newest
  point in the window that has a price. When the newest minutes have `underlyingPrice: null` (the contract allows
  null), the price comes from an older minute, up to the baseline (15 to 18 minutes before the newest minute). The
  read then compares a wall touch at that older price with the drift up to the newest minute. `priceAt` reports the
  real minute, but nothing limits the gap. The companion spec is itself split: spec line 38 says "the
  `underlying_price` of the same net drift minute", spec line 70 says "the newest underlying price in the window"
  (which matches the code).
- **Recommendation:** decide one rule. Either require the price of the newest minute (return `no_price` otherwise),
  or keep the code and change design lines 73 and 142, the flow-pipeline paragraph and spec line 38 to "the newest
  priced minute in the window", and consider a limit on `newestMinute - priceMinute`.

## Major

### M1. `/stock` reads never age, and their GEX time is the response time (lines 121-123, 142)

- **Affected scope:** line 142 ("Stale levels or drift: contract age limits"), lines 121-123;
  `wall-drift-view-model.ts` lines 178-195; `wall-drift-badge.tsx` lines 103-133;
  `packages/api/src/server/options-analytics.ts` (`receivedAt: now.toISOString()`, `CHAIN_TTL_MS = 300_000`).
- **Discrepancy:** (1) `stockWallDriftView` passes `at: analytics.receivedAt`. `receivedAt` is the time the server
  assembled the answer, not the time of the GEX estimate; chain and open interest can be cached for up to 300 s.
  So `gex_stale` is effectively unreachable on `/stock`. (2) `now` is `checkedAt`, set once when `flow.control`
  answers. `OptionsAnalyticsPanel` has no refresh timer (only the Refresh button and the Flow window select), so a
  graded `Hold (A)` or `Break risk` stays on screen indefinitely after both inputs go stale. The age limits on
  `/stock` hold only at the moment of load.
- **Recommendation:** document both facts in the `/stock` bullet, or fix them: re-grade on a clock tick (for
  example every 30 s, pure re-computation, no new request) and name the `/stock` levels time honestly (for example
  "response time; the estimate may be up to 5 min older").

### M2. `/flow` says "flow snapshot is loading" when the snapshot failed (line 120)

- **Affected scope:** line 120 (only `flow.control` loading or failure is described); `wall-drift-view-model.ts`
  lines 148-161; `flow-workspace.tsx` lines 1007-1020.
- **Discrepancy:** `flowWallDriftView` maps every `snapshot === null` to the detail "flow snapshot is loading". When
  the first `flow.snapshot` request fails, `snapshot` stays null and the workspace shows "Flow snapshot not loaded",
  but the badge keeps saying "flow snapshot is loading" for as long as the failure lasts. `flowWallDriftView` does
  not receive the snapshot failure. This is an undocumented failure mode with a wrong reason.
- **Recommendation:** pass the snapshot failure into `flowWallDriftView` and say "flow snapshot not loaded: <code>"
  in that case; add the case to line 120.

### M3. Drift age is not measured the way the collector measures it (line 97)

- **Affected scope:** line 97 ("`maxDriftAgeMinutes` 5 (from `FLOW_SOURCE_METADATA`)"); `gex-wall-drift-rules.ts`
  lines 303-309; `server/flow-control.ts` lines 224-226 and 502-530; `server/flow-collect.ts` lines 1421 and 1525.
- **Discrepancy:** the value is shared, the reference point is not. The rule ages the end of the newest *settled*
  point (`newestMinute + 1 min`); while the session is open `flow.control` drops the newest stored bucket, so the
  rule's newest minute is already one bucket behind. The collector calls a sample `ok` when the newest `total`
  bucket *started* at most 300 s ago, and the `flow.control` freshness row ages the time of the last ok sample
  (`latestOk.at`). The two can disagree for a few minutes in either direction. When the freshness row is `stale` but
  the rule still grades, `collectorNote` is dropped (it is shown only with a no-data read), so the operator sees a
  graded read while the control panel says net drift is stale.
- **Recommendation:** state in the Rule section that drift age is measured from the end of the newest settled
  minute, and either show the collector note whenever the freshness row is not `fresh`, or make a non-fresh
  freshness row its own no-data reason.

### M4. No walls and rate-limited analytics become "No read", not "No data" (lines 101-103)

- **Affected scope:** lines 101-103 (order of checks); `gex-wall-drift-rules.ts` lines 343-369;
  `contracts/options-analytics.ts` (`rateLimited`, nullable `context.levels`).
- **Discrepancy:** `GexWallLevelsInput.callWall` and `putWall` are nullable. When both are null (an empty or
  partial GEX estimate, or an options analytics answer with `rateLimited: true` and missing chain data), the rule
  passes every no-data check and returns `no-read` / `not_at_wall` with "price ... is not within 0.25% of a wall".
  That describes a missing input as an observation. `wall_geometry` is only checked when both walls exist; a single
  wall is read normally. `rateLimited` is never consulted by the view model. None of this is in the design.
- **Recommendation:** add a no-data code for "GEX has no walls" (both null), consider `rateLimited` a no-data reason
  on `/stock`, and list the one-wall behaviour in the Rule section.

### M5. The `/stock` badge lives on the Analytics tab only (lines 44, 121-123, 134)

- **Affected scope:** lines 44, 121-123 and the UX bullet on line 134; `stock-detail-workspace.tsx` lines 616-624.
- **Discrepancy:** `OptionsAnalyticsPanel` (and so the badge) is mounted only when `query.tab === "analytics"`
  (`/stock/SPY?tab=analytics`). On the default chart tab an operator sees no badge. The design never names the tab,
  so a reviewer checking "the badge renders on `/stock`" on the default tab will report it missing.
- **Recommendation:** say "on the Analytics tab of `/stock/<symbol>`" in lines 44, 121 and the UX section.

### M6. The spec check covers the values only, not "the same rules" (lines 46-47, 74, 185)

- **Affected scope:** lines 46-47 ("the same rules embedded and checked by a test"), line 74 (B3), Acceptance
  line 185; `packages/api/src/gex-wall-drift-spec.test.ts` lines 13-20.
- **Discrepancy:** the test parses the JSON block after `## Rules` and compares it with `GEX_WALL_DRIFT_RULES`, and
  checks the version string. The spec's truth table, its code names, the flip-side names, the check order and the
  price definition are free text that no test reads. During this review the code, its test and the spec disagreed
  on exactly those names (`unknown` / `hold_flip_unknown` against `no_flip` / `hold_no_flip`) and the spec test would
  have passed. The spec also carries a second contradiction the test cannot see (B3: spec lines 38 and 70).
- **Recommendation:** reword lines 46-47 to "the rule values embedded and checked by a test", or extend the spec test
  to compare the truth-table codes and flip-side names with `GEX_WALL_DRIFT_CODES` and `GexFlipSide`.

### M7. The file list has no Create / Modify markers, and "(+ their tests)" is not accurate (lines 170-178)

- **Affected scope:** lines 170-178.
- **Discrepancy:** no entry says whether it is created or modified. In the working tree, created:
  `gex-wall-drift-rules.ts`, its two tests, `wall-drift-view-model.ts` (+ test), `wall-drift-badge.tsx` (+ test),
  `app/(portal)/stock/[symbol]/page.test.tsx`, the spec. Modified: `index.ts`, `flow-workspace.tsx` (+ test),
  `options-analytics-panel.tsx` (+ test), `options-analytics-client.ts`, `stock-detail-workspace.tsx`, `page.tsx`,
  `route-files.test.tsx`, `flow-pipeline.md`. "(+ their tests)" is not true for `options-analytics-client.ts` (no
  test file exists) or `stock-detail-workspace.tsx` (its test is unchanged and never passes `operator`), and the new
  `page.test.tsx` and the changed `route-files.test.tsx` are not named.
- **Recommendation:** mark each path Create or Modify, name the test files actually touched, and either add a
  `stock-detail-workspace` test for `operator -> wallDrift` or drop the claim.

## Nits

- **N1. `StockWallDrift` location (lines 121-123, 174).** It is defined in `wall-drift-badge.tsx`, not in
  `options-analytics-panel.tsx`, and it imports `describePortfolioMonitorFailure` from
  `portfolio-monitor-client.ts` to format `flow.control` errors. Name the file and the dependency.
- **N2. Reuse instead of `wallDriftGroupOf` (`wall-drift-view-model.ts` lines 70-72).** The ticker to group map
  already exists: `groupOfSymbol(flowSymbolForTicker(ticker))` (`control-view-model.ts`, `flow-features.ts`). The
  local `ticker === "SPY" || ticker === "SPX"` copy can drift from `FLOW_GROUPS`.
- **N3. Public API not listed (lines 42-43, 112-114).** Exports not mentioned: `gexDriftWindow`,
  `GEX_WALL_DRIFT_READS`, `GEX_WALL_DRIFT_CODES`, the input and output types; in the view model
  `isWallDriftTicker`, `wallDriftGroupOf`, `flowWallDriftView`, `stockWallDriftView`, `WALL_DRIFT_HELP`,
  `WALL_DRIFT_STUDY_STATUS`, `WallDriftControlState`.
- **N4. Rule semantics left unstated (lines 96-114, Terms line 30).** The code fixes them; the design should too:
  the band is `|price| x 0.25 / 100` and inclusive (`<=`); `above` includes `price == flip`; a side is rising at
  `share >= 0.30` and a negative change is never rising; gross sums the absolute changes between consecutive
  *points*, so a missing minute merges into the next one (Terms line 30 says "per-minute"); an unparsable time
  counts as stale; `distancePct = (price - wall) / price x 100`; `flipSide`, `callShare` and `putShare` are filled on
  wall no-reads too; reasons use "+$1.50M" style amounts and the real span.
- **N5. "Operators" includes agent viewers (lines 55, 71, 121).** `session.isOperator` is true for
  `VERTEX_OPERATOR_EMAILS` and the read-only `VERTEX_AGENT_VIEWER_EMAILS` (`lib/request-portal-session.ts`).
- **N6. Collector note attribution (line 120).** The net drift collector message is appended to every no-data read,
  including GEX causes (`gex_stale`, `gex_no_spot`), and also for `closed` and `never` freshness states, where it
  is a status line such as "SPY total 390 buckets, ... newest 15:59 NY". Limit it to drift codes, or label it.
- **N7. Help text (line 126; `WALL_DRIFT_HELP`).** "No read" lists "a hold below the flip" but not a hold without a
  flip (`hold_no_flip`), both walls in the band, or inverted walls.
- **N8. `/stock` ticker pairing (line 141).** On `/stock` both inputs take the route symbol, so `ticker_mismatch`
  cannot fire; `analytics.symbol` is available and unused. The risk row's "both inputs carry the ticker" is true for
  `/flow` only.
- **N9. Missing gateway and `/charts` (lines 121-123).** A supplied `OptionsAnalyticsGateway` without `flowControl`
  shows "No data: net drift not loaded: this page does not load flow.control". `/charts` mounts the same panel with
  `wallDrift` defaulting to false, so operators never see the badge there. Both are fine; neither is written down.
- **N10. Dead branch (`wall-drift-badge.tsx` lines 109-112).** "A reload keeps the last answer on screen" never
  applies in the panel: every analytics reload passes through `type: "loading"`, which unmounts `StockWallDrift`, so
  the drift always restarts from `loading`. The NFR (one `flow.control` request per analytics answer, line 156)
  holds; note that changing the Flow window also triggers one.
- **N11. Lab fixtures (Acceptance line 184).** `/lab/flow` fixtures are anchored at `LAB_NOW` (2026-10-30T20:00Z)
  while `FlowWorkspace` grades with the real clock, so the lab always shows `No data` (`gex_stale`). Graded states
  are visible only in unit tests; say so, or add a lab state that injects `now`.
- **N12. Time zone (line 126).** The disclosure shows input times as `HH:MM UTC`; the Terms and the spec use New
  York time.
- **N13. Gamma flip term (line 25).** `gex-context.ts` uses the crossing nearest to spot when the profile crosses
  zero more than once; the Term does not say which crossing.
- **N14. Unrelated diff noise.** `page.tsx` also reorders the `prefetch={false}` props on two links; not in the plan.

## Verified as written

- `GEX_WALL_DRIFT_RULES` is frozen with exactly the nine values on lines 96-97; `maxGexAgeMinutes` and
  `maxDriftAgeMinutes` are derived from `FLOW_SOURCE_METADATA.gex.maxAgeSeconds` (1800) and
  `.net_drift.maxAgeSeconds` (300); version `gex-wall-drift-rules.v1`; exported from `packages/api/src/index.ts`.
- The input shapes on lines 90-94 match `GexWallLevelsInput`, `GexDriftInput` and `GexWallDriftInput`, with
  `FlowOptionTicker` on both inputs (M7 of the brainstorm).
- The no-data order on lines 101-102 matches `readInputs` exactly; the wall order on line 103 matches `locateWall`;
  the truth table on lines 106-110 matches `gradeTouch` (both rising checked first, then push side, then flat, then
  hold by flip side), including `no_flip` / `hold_no_flip`.
- The output field list on lines 112-114 matches `GexWallDriftRead` and `GexDriftWindow` (the window also carries
  `priceMinute`).
- `/flow`: the badge sits directly above `FlowControlPanel`; it reads `snapshot.gex.levels` (never `symbolLevels`),
  `gex.spot`, `gex.at`, and the `flow.control` series and freshness row of `gex.ticker`; the group already includes
  that ticker (`FLOW_GROUPS`: sp500 = SPX + SPY, nasdaq100 = QQQ + NDX); `flow.control` loading or failure becomes
  `drift_missing` with the error code; no extra request.
- `flow.control` points are the settled vendor `total` series with filter `otm-clean.v1` (`server/flow-control.ts`),
  as the Terms and M8 say.
- `/stock`: `page.tsx` reads the session, `StockDetailWorkspace` passes `operator` as `wallDrift`, `StockWallDrift`
  sends no request unless `enabled` and the symbol is SPY, SPX, QQQ or NDX, calls
  `OptionsAnalyticsGateway.flowControl({ group })`, and reloads on a new `receivedAt`.
- Badge: `StatusBadge` tones success / warning / neutral / info exist in `packages/ui`; labels "Hold (A)", "Break
  risk", "No read", "No data"; "Unvalidated: study accruing · research only" on every state; `line-clamp-2` reason;
  44 px `<summary>` (`min-h-11`) with help text and input times.
- The UX example strings match the code: "Put wall 600 · above flip 590", "net drift is older than 5 min",
  "collector: ...".
- Unit tests name every code in `GEX_WALL_DRIFT_CODES`.
