# Flow control signals: implementation plan for pull request 1 (net drift and the options side)

- **Author:** Jeff Scott Ward
- **Status:** Reviewed and resolved (2026-11-16)
- **Date:** 2026-11-15

This plan lists every file of pull request 1 of the design [Flow control signals](design.md) (sections 1, 2, 3, 5, 6, 7 and 9): the instrument registry, migration 0077 (the next free number: `packages/db/migrations/0076_research_screen.sql` exists; take the next free number again if another migration lands first), the net drift collection, the options side of the control document, and the control panel on `/flow` with QQQ and NQ. The futures state, the deep trades list, the catalog terms and the agent tool `flow_control` are in [pull request 2](plan-pr2.md). The study is in [pull request 3](plan-pr3.md). Everything here is research and display: no order, arming or risk path is touched.

Path rule: `bun scripts/docs.ts check` (function `findBrokenDocPaths` in `scripts/docs/docs.ts`) fails on a backticked repository path that does not exist. So a file that this pull request creates is written without backticks, and no path carries a `#symbol` suffix.

## Detailed Implementation Plan

### PR 1: Registry, net drift, options side of the control panel, QQQ and NQ

Facts from the code that the plan depends on (every location was read):

- Flow symbols, tickers and sources are three tuples in `packages/api/src/contracts/flow.ts:14-16`; `FlowCollectInputSchema.symbols` has `.max(2)` (`:113`); every schema is strict; `count`, `timestamp` and `text` are at `:97-101`.
- Per-symbol facts live in four places: `FLOW_INSTRUMENTS` (`packages/api/src/flow-features.ts:13-40`), `DEFAULT_MIN_TICK` (`packages/api/src/server/flow-collect.ts:87-90`), symbol tests at `packages/api/src/server/flow-collect.ts:713`, `packages/api/src/server/flow-snapshot.ts:44`, `:464`, `:511` and `apps/web/src/features/flow/view-model.ts:174`, and the literal type at `packages/api/src/server/flow-snapshot.ts:72`.
- The run loop is `for source of SOURCE_ORDER, for symbol of symbols` (`packages/api/src/server/flow-collect.ts:865-877`); a thrown repository error leaves the loop and ends the run. A skip (not due, closed, budget) is a run entry that is not stored (`:112`, `:132-138`). A source is due by the age of its newest stored sample of any status (`:801-806`, `:812-823`). `prune` takes one cutoff (`:843-849`; `packages/db/src/server/flow.ts:267-300`).
- The vendor client starts one request per second and at most 30 per 60 s (`packages/api/src/server/quantdata-client.ts:3-4`, `:33`, `:154`); `QUANTDATA_ENDPOINTS` has three keys (`:21-25`). One GEX estimate sends three requests (`packages/api/src/server/options-analytics.ts:99-102`). The client keeps its window in `starts` (`packages/api/src/server/quantdata-client.ts:168`) and refuses a start when the window is full (`:224-235`); `DEFAULT_MAX_PER_MINUTE` is at `:33`. One client per configuration is shared by `/charts` option reads and `flow.collect` (`quantDataClientFor`, `packages/api/src/server/options-analytics.ts:222-237`); `flow.collect` builds it at `packages/api/src/server/flow.ts:84` and passes it to `buildOptionsAnalytics` at `:103-109`. Fake clients that implement `QuantDataClient` are in `packages/api/src/options-analytics.test.ts:792-800`, `packages/api/src/options-chain-quantdata.test.ts:105-110` and `packages/api/src/server/flow-collect.test.ts:268-276` and `:989`.
- Read keys are an allow list (`AGENT_API_KEY_READ_PROCEDURES`, `packages/api/src/server/operator-access.ts:28`), key procedures a second list (`AGENT_API_KEY_PROCEDURE_PATHS`, `packages/api/src/server/handler.ts:52`), viewer reads a reviewed list (`packages/api/src/agent-viewer.test.ts:352-361`).
- The semantic-layer eval recording is stale when the tool definitions, the system prompt, a question or a tool result changes: the digest hashes `JSON.stringify(request.tools)` and every message that is not a model reply (`tests/integration/semantic-layer/harness.ts:181-192`, compared at `:274`; the replay test fails at `tests/integration/semantic-layer/eval-replay.test.ts:79`). The tools are built from `MCP_TOOLS` with the JSON Schema of each tool input (`packages/api/src/server/assistant-runtime.ts:141-149`, `packages/api/src/server/mcp.ts:757-771`). The tool `flow_snapshot` uses `FlowSnapshotInputSchema` (`packages/api/src/server/mcp.ts:521-529`), whose `symbol` enum is `FLOW_SYMBOLS`. Result for this pull request: a wider `FLOW_SYMBOLS` would change that tool definition and make every recorded trial stale; a new oRPC procedure, the read-key list and `packages/api/openapi.json` are not inputs of the digest; the recording holds no `flow_snapshot` call. So entry 36 pins the tool input.
- The status-language test reads every string literal, template and JSX text under `apps/web/src` except tests, fixtures and `lab` (`apps/web/src/status-language.test.ts:41-52`). It rejects the words unknown, n/a, unavailable, not available, not known, not set, unspecified, undetermined, tbd and a text that is only a dash, "?" or "…". Operands of a comparison, `case` labels, types and `data-*` values do not count (`:16-20`).
- The stored study is read with `ResearchStudyRepository.get(id)` (`packages/db/src/server/research-studies.ts:52`); the `strategy-backtest` document has `ran` (`packages/api/src/contracts/research-studies.ts:438`), `rules[].item` and `rules[].rule` (`:451-456`) and `verdict` (`:488`).
- `newYorkTime(day, minute)` gives the instant of a New York wall time (`packages/api/src/server/merged-bars.ts:280`); `newYorkClock(date)` gives the New York day and minute of the day (`packages/api/src/signal-alerts.ts:116`).
- Vendor shape: <https://quantdata.us/api/docs/endpoints/net-drift> (response keyed by the bucket start in epoch milliseconds; per-bucket values, not running totals; a bucket is settled when its minute has closed), and the probe of 2026-11-15 (15 requests, HTTP 200, the bodies of entry 23).

Terms used below:

- **Bucket**: one vendor one-minute value for one ticker and one part (one row of `flow_net_drift`). The parts are `total` (all expiries) and `zero_dte`. `longer` is never stored: it is total minus `zero_dte`, computed on read.
- **Settled bucket**: a `total` bucket that the fold may use. While the `net_drift` session is open (09:30 to 16:20 New York) the newest stored `total` bucket of a ticker is left out, because its minute may be in progress; after 16:20 every bucket is settled.
- **Enter ratio**, **exit ratio**: the two numbers `enterRatio` and `exitRatio` of the rules object.

Decisions of this plan that the Technical Plan does not state:

- NQ has no `ticks` source in this pull request; its sources are `depth`, `gex`, `net_drift`. Pull request 2 adds the tick schedule. The table in design section 1 shows the state after pull request 2.
- `flow-snapshot.v1` freshness lists only those of the four `FLOW_SNAPSHOT_SOURCES` (`ticks`, `depth`, `options`, `gex`) that the symbol collects. `net_drift` freshness is in `flow.control` only. The SPY and ES snapshot does not change.
- A seed run (`--seed`) is exempt from the group stagger. It keeps the caller reserve check and the rule of one GEX estimate per run. Its session date is the newest weekday at or before now in New York.
- `net_drift` is collected until 16:20 New York. The last bucket (16:14) closes at 16:15, and the vendor document says a bucket is settled once its minute has closed; each group is read every 2 minutes, so each ticker is read at least twice after 16:15.
- A source whose QuantData worst case does not fit in the free starts beyond the caller reserve is a run entry with the status `skipped` and the reason; it is printed in the journal and it is not stored in `flow_samples`. A stored sample would move the due time of the source by its full interval (`packages/api/src/server/flow-collect.ts:801-806`).
- A `net_drift` sample is `ok` when the `total` part answered. A failed `zero_dte` part is named in the message; the net drift series of the control document then has `partsStatus: "partial"` (the expiry split only).
- The "not collected" sentence lists the symbols whose registry entry has `ticks` as the budget holders. In this pull request it reads "ES and SPY"; the same rule gives "ES, NQ and SPY" after pull request 2 without a code change.
- The cross-check compares SPX only. For nasdaq100 it reports `not_collected`.
- The MCP tool `flow_snapshot` keeps its recorded definition (entry 36). Pull request 2 removes the pin, updates the description to four symbols, adds the tool `flow_control` and records the eval again once.
- Contract fields that design section 6 does not list: `netDrift[].points[].total` and `study.agreementDetail` (the agreement half of the page's futures line). `options.checkState` is never null. The side object has no `sincePrecisionSeconds`, and its `inputs` are `numerator`, `denominator` and `rows` only.
- `FLOW_NO_DATA_REASONS` holds all eight reasons (`storage_failed` was added after `source_unavailable` in the code review) in this pull request, `sampled_tape` included, so pull request 2 needs no contract change for it. `partial` is not a no-data reason: it is a value of `FLOW_PARTS_STATUSES` on each net drift series (design section 5).
- `FLOW_AGREEMENT_STATES` holds only `not_comparable` (design section 5). No agreement function, text or test for other values ships.
- The page prints one futures line, `<futures label>; <study.agreementDetail>`, and no separate agreement line (design section 7).

Tuple values per commit (commit numbers as in "Commit order"):

| Commit | `FLOW_SYMBOLS`, `FlowSymbolValue` | `FLOW_OPTION_TICKERS`, `FlowOptionTickerValue` | `FLOW_SOURCES`, `FlowSourceValue` | SQL check text | `packages/api/openapi.json` |
| --- | --- | --- | --- | --- | --- |
| 1 | SPY, ES | SPY, SPX | ticks, depth, options, gex | as in 0052 and 0053 | no change |
| 2 | SPY, ES | SPY, SPX | ticks, depth, options, gex | four symbols, four tickers, five sources | no change |
| 3, 4 | SPY, ES | SPY, SPX | ticks, depth, options, gex | wide | generate run, no difference expected |
| 5 | SPY, ES | SPY, SPX | ticks, depth, options, gex | wide | regenerated (`budget`) |
| 6 | SPY, ES, QQQ, NQ | SPY, SPX, QQQ, NDX | plus `net_drift` | wide | regenerated |
| 7, 8 | four | four | five | wide | regenerated in 7 (`flow.control`); no change in 8 |

#### 1. `packages/api/src/flow-features.ts` (Modify)

- **Type / Scope**: Pure leaf module; the one registry of instruments and groups.
- **Proposed Changes**:
  - Commit 1 (structure only): extend `FlowInstrument` with `kind: "future" | "etf"`, `group: FlowGroupId`, `session: "stock" | "globex"`, `minTick: number`, `sources: readonly FlowSource[]`, `ticks: "trades_and_quotes" | "none"`, `offExchange: boolean`, `note: string`; `optionsTicker` becomes `FlowOptionTicker`. ES gains `{ kind: "future", group: "sp500", session: "globex", minTick: 0.25, sources: ["ticks", "depth", "options", "gex"], ticks: "trades_and_quotes", offExchange: false, note: "ES options context uses SPX options; SPX levels are shifted by the ES − SPX basis." }`. SPY gains `{ kind: "etf", group: "sp500", session: "stock", minTick: 0.01, sources: ["ticks", "depth", "options", "gex"], ticks: "trades_and_quotes", offExchange: true, note: "SPY book is IEX depth plus top of book from other venues (no paid venue books)." }`. Existing fields keep their values.
  - Commit 1: add `export type FlowGroupId = "sp500" | "nasdaq100"`, `export type FlowGroup = Readonly<{ id: FlowGroupId; label: string; future: FlowSymbol; primaryTicker: FlowOptionTicker; checkTicker: FlowOptionTicker }>` and `export const FLOW_GROUPS: Readonly<Record<"sp500", FlowGroup>>` with `sp500 = { id: "sp500", label: "S&P 500", future: "ES", primaryTicker: "SPX", checkTicker: "SPY" }`.
  - Commit 4: `FlowGroupId` is imported from the contract (`FLOW_GROUP_IDS`) and re-exported; the local declaration is deleted.
  - Commit 6: add `"net_drift"` to the sources of SPY and ES. Add QQQ `{ symbol: "QQQ", secType: "STK", kind: "etf", group: "nasdaq100", session: "stock", optionsTicker: "QQQ", minTick: 0.01, largePrint: 10_000, optionEventPremium: 500_000, sources: ["depth", "gex", "net_drift"], ticks: "none", offExchange: true, note: "QQQ book is IEX depth plus top of book from other venues (no paid venue books)." }` and NQ `{ symbol: "NQ", secType: "CONTFUT", exchange: "CME", kind: "future", group: "nasdaq100", session: "globex", optionsTicker: "NDX", minTick: 0.25, largePrint: 10, optionEventPremium: 1_000_000, sources: ["depth", "gex", "net_drift"], ticks: "none", offExchange: false, note: "NQ options context uses NDX options; NDX levels are shifted by the NQ − NDX basis." }`. `FLOW_GROUPS` becomes `Readonly<Record<FlowGroupId, FlowGroup>>` and gains `nasdaq100 = { id: "nasdaq100", label: "Nasdaq 100", future: "NQ", primaryTicker: "QQQ", checkTicker: "NDX" }`.
  - Commit 6: add `export const flowSymbolForTicker = (ticker: FlowOptionTicker): FlowSymbol` (the one symbol whose `optionsTicker` is the ticker: SPY, ES for SPX, QQQ, NQ for NDX).

#### 2. `packages/api/src/flow-features.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: Commit 1: only hand-built `FlowInstrument` values gain the new fields. Commit 6, new cases: "lists every flow symbol once and every group names a registry future"; "the schema symbol, ticker, source and part tuples equal the contract tuples" (compares `FLOW_SYMBOL_VALUES`, `FLOW_OPTION_TICKER_VALUES`, `FLOW_SOURCE_VALUES`, `FLOW_NET_DRIFT_TICKER_VALUES` and `FLOW_NET_DRIFT_PART_VALUES` from `@darkfactory/db/schema` with `FLOW_SYMBOLS`, `FLOW_OPTION_TICKERS`, `FLOW_SOURCES`, `FLOW_OPTION_TICKERS` and `FLOW_EXPIRY_PARTS`, each sorted); "maps each option ticker to one flow symbol".

#### 3. `packages/api/src/server/flow-collect.ts` (Modify)

- **Type / Scope**: The collector run (server only).
- **Proposed Changes**:
  - Commit 1: delete `DEFAULT_MIN_TICK`; line 231 reads `instrument.minTick`; `gexBasis` (line 713) tests `instrument.kind === "etf"`.
  - Commit 2 (retention): replace `FLOW_RETENTION_DAYS = 14` by `export const FLOW_RETENTION_DAYS: Readonly<Record<FlowPruneTable, number>>` with `flow_net_drift: 730` and 14 for `flow_samples`, `flow_minutes`, `flow_book`, `flow_option_prints`, `flow_events`, `flow_gex`, `flow_option_gaps` (`flow_minutes` stays at 14 days, so a rollback deletes no row; design section 3). `pruneIfDue` builds one cutoff per table (`now − days × 86 400 000`) and calls `repository.prune(cutoffs)`.
  - Commit 5 (storage errors): the loop body wraps `attempt` in try/catch. A caught error becomes `{ status: "unavailable", record: true, items: 0, events: 0, message: "storage: write failed (<error.name>)" }` (`<error.name>` is the runtime class name; no SQL text). `recordSample` gets its own try/catch; when it also fails the run entry is still returned. Errors of `lastAttempts` and `pruneIfDue` are outside both and end the run as today.
  - Commit 5 (budget): no run-time counter. Constants: `export const FLOW_QUANTDATA_CALLER_RESERVE = 6` (comment: collector calls leave 6 of the shared client's 30 starts per 60 s free, so two `/charts` option reads of 3 requests each always fit; the client holds the window), `export const FLOW_GEX_REQUESTS_PER_RUN = 3`, `export const FLOW_QUANTDATA_SOURCE_MAX: Readonly<Partial<Record<FlowSource, number>>> = { options: FLOW_OPTION_RUN_PAGES_MAX, gex: FLOW_GEX_REQUESTS_PER_RUN }`. In `attempt`, after the session and due checks and on seed runs too: when `FLOW_QUANTDATA_SOURCE_MAX[source]` is a number, the client is not null and `client.freeStarts() < that number`, return `notDue("budget: <free> QuantData starts free beyond the reserve of 6, <n> needed")`. The client here is the reserve view of entry 30, so `freeStarts()` already leaves out the reserve. A request that the client still refuses with the reason `reserved` (another caller started requests in between) fails like any refused request of that source; `collectNetDrift` treats it as in the rules below. `FlowCollectDeps` gains `elapsedMs: () => number`.
  - Commit 5 (GEX): `RunState.gexDone: boolean`; after one symbol ran `collectGex`, the other symbols return `notDue("staggered: GEX ran for another symbol in this run")` and stay due.
  - Commit 5 (output): the result gains `budget: { quantDataFree: deps.quantData?.freeStarts() ?? null, quantDataReserve: FLOW_QUANTDATA_CALLER_RESERVE, ibkrRecent: state.pacing?.recentRequests ?? null, ibkrLimit: 6, runSeconds: Math.round(deps.elapsedMs() / 1000) }` (`quantDataFree` is read at the end of the run).
  - Commit 6 (sources per symbol): the loop skips a symbol whose `sources` does not include the source (no run entry, no sample). `SOURCE_ORDER = ["net_drift", "depth", "ticks", "options", "gex"]`. `FLOW_DUE_SECONDS.net_drift = 0` (comment: due on every run; `netDriftTurn` alone sets the cadence, each group on alternate minutes). `COLLECTORS.net_drift = collectNetDrift`. `FLOW_QUANTDATA_SOURCE_MAX.net_drift = FLOW_NET_DRIFT_REQUESTS_PER_SYMBOL` with `export const FLOW_NET_DRIFT_REQUESTS_PER_SYMBOL = 2`. `attempt` uses `flowSessionOpen("net_drift", symbol, now)` for this source.
  - Commit 6 (the one cadence rule): `export const netDriftTurn = (group: FlowGroupId, now: Date): boolean` = `Math.floor(now.getTime() / 60_000) % 2 === (group === "sp500" ? 0 : 1)` (sp500 symbols on even minutes, nasdaq100 symbols on odd minutes of the run time). When it is false and the run is not a seed run, `collectNetDrift` returns `notDue("staggered: <group> net drift runs on <even or odd> minutes")`.
  - Commit 6: `collectNetDrift(state, instrument): Promise<Attempt>`. No client: `notDue("QuantData not configured")`. `sessionDate = flowSessionDate(deps.now)` (entry 5). Two calls in this order: `client.request("netDrift", netDriftRequest(sessionDate, ticker, part), 30_000)` for `total`, then `zero_dte`; each answer goes through `parseNetDrift`. A part fails when the client result is not ok or the parse fails. When the `total` request answers with the reason `reserved`, the attempt is `notDue("budget: QuantData starts kept free for other callers")` and stores no sample; `zero_dte` is then not requested. The failure text of a part is `rate limited until HH:MM ET` (now plus `retryAfterSeconds`, or plus `client.cooldownSeconds()` when it is null) when `reason === "rate_limited"`, else the client or parser message. Every parsed bucket of a part that answered is stored with `repository.upsertNetDrift` as `{ ...bucket, ticker, part, filterProfile: FLOW_FILTER_PROFILE }`; `items` is the returned count.
    - `total` failed: `unavailable`, message = the failure text of `total`.
    - `total` answered with zero buckets: `empty`, message `<T> total 0 buckets, zero_dte <m>, 2 requests` (no newest time).
    - `total` answered and its newest bucket started at most 300 s before now: `ok`; older: `empty`. Both use the message `<T> total <n> buckets, zero_dte <m>, newest HH:MM NY, 2 requests`.
    - `zero_dte` failed while `total` answered: the status follows the three rules above and the message ends with `; zero_dte failed (<failure text>)`, with `zero_dte 0` as its count.
  - Commit 6: `export const flowQuantDataRunWorstCase = (instruments: Readonly<Record<FlowSymbol, FlowInstrument>>, groups: Readonly<Record<FlowGroupId, FlowGroup>>): number` = (the largest count of `net_drift` symbols in one group × `FLOW_NET_DRIFT_REQUESTS_PER_SYMBOL`) + (the count of `options` symbols × `FLOW_OPTION_RUN_PAGES_MAX`) + `FLOW_GEX_REQUESTS_PER_RUN`. Value: 4 + 16 + 3 = 23. The test of entry 4 checks it against `DEFAULT_MAX_PER_MINUTE − FLOW_QUANTDATA_CALLER_RESERVE` = 24 (entry 22 exports `DEFAULT_MAX_PER_MINUTE`).

#### 4. `packages/api/src/server/flow-collect.test.ts` (Modify)

- **Type / Scope**: Unit test with a fake repository and a fake client.
- **Proposed Changes**: Commit 1: no change. Commit 2: the fake repository (line 263) gains `upsertNetDrift`, `readNetDrift`, `newestNetDriftMinute`; "prunes only when due, with the retention cutoff" (line 1650) becomes "prunes each table with its own cutoff". Commit 5: `depsWith` gains `elapsedMs`; the fake clients (lines 268-276 and 989) gain `freeStarts` (default 24); cases "records a storage error as a sample and continues with the next source"; "returns the run entry when the sample write also fails"; "ends the run when the sample lookup fails"; "runs GEX for one symbol per run"; "skips a source whose worst case does not fit in the free starts and stores no sample for it"; "applies the free-start check on a seed run"; "reports the free starts, the reserve, the IBKR window and the run time". Commit 6: existing cases that count runs are updated for four symbols; cases "runs net drift first"; "skips a source that the symbol does not list"; "sends the total and the zero_dte request per symbol and stores both parts"; "runs sp500 on even minutes and nasdaq100 on odd minutes"; "ignores the stagger on a seed run and asks for the newest weekday"; "records unavailable with the vendor rate limit end time when the total part is refused"; "skips net drift and stores no sample when the total part is refused for the caller reserve"; "stays ok and names the failed zero_dte part"; "records empty without a newest time for zero buckets"; "records empty for a newest bucket older than 300 s"; "answers not configured without a client"; "keeps the worst case of one run inside the client window minus the caller reserve" (asserts `flowQuantDataRunWorstCase(FLOW_INSTRUMENTS, FLOW_GROUPS) === 23` and `23 <= DEFAULT_MAX_PER_MINUTE - FLOW_QUANTDATA_CALLER_RESERVE`); "reads net drift on every run of the group's minute" (no due wait).

#### 5. `packages/api/src/server/flow-snapshot.ts` (Modify)

- **Type / Scope**: Sessions and the pure snapshot assembly.
- **Proposed Changes**:
  - Commit 1: `flowSessionOpen` line 44 tests `FLOW_INSTRUMENTS[symbol].session === "stock"`; `buildOrderFlow` line 464 tests `FLOW_INSTRUMENTS[rows.symbol].offExchange`; `flowNotes` line 511 reads `FLOW_INSTRUMENTS[symbol].note`; `FlowGexRow.ticker` becomes `FlowOptionTicker`.
  - Commit 6: `flowSessionOpen` answers `net_drift` as a weekday with 09:30 <= minutes < 16:20. `FLOW_STALE_SECONDS.net_drift = 300`. `export const flowSessionDate = (now: Date): string`: the New York date of `now`, moved back to Friday on Saturday and Sunday. `buildFreshness` maps over `FLOW_SNAPSHOT_SOURCES` filtered by the instrument's `sources`. `ConfluenceInput.usable` (line 188) and the cast at line 528 become `Readonly<Record<FlowSnapshotSource, boolean>>`, built over `FLOW_SNAPSHOT_SOURCES` with `false` for a source without a freshness row, so QQQ and NQ have no order-flow and no options factor with data.

#### 6. `packages/api/src/server/flow-snapshot.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: Commit 1: none. Commit 6, new cases: "opens net drift from 09:30 to 16:20 New York on weekdays"; "gives the newest weekday as the session date"; "lists freshness only for the sources a symbol collects" (QQQ: depth and gex); "keeps the SPY freshness rows unchanged"; "QQQ confluence has no order-flow or options factor with data"; "gives QQQ and NQ their registry note and no off-exchange share for NQ".

#### 7. `packages/api/src/index.ts` (Modify)

- **Type / Scope**: Public surface of the API package.
- **Proposed Changes**: Commit 1: add `export { FLOW_GROUPS, FLOW_INSTRUMENTS, type FlowGroup, type FlowGroupId, type FlowInstrument } from "./flow-features.ts";` (pure module; the web view-model reads it). Commit 4: add `export * from "./flow-control-rules.ts";` and drop `type FlowGroupId` from the first line (the contract exports it).

#### 8. `apps/web/src/features/flow/view-model.ts` (Modify)

- **Type / Scope**: Pure view-model of the page.
- **Proposed Changes**: Commit 1: `orderFlowMetrics` line 174 tests `FLOW_INSTRUMENTS[symbol].offExchange`. Commit 8: `FLOW_VIEW_SYMBOLS = ["SPY", "QQQ", "ES", "NQ"]`; `FRESHNESS_TONE` (line 86) is exported for entry 41. Add `export const shortTermBadge = (confluence: FlowConfluence): string`: more bullish than bearish "2 of 3 short-term factors bullish"; more bearish "2 of 3 short-term factors bearish"; equal counts above zero "Short-term factors split: 1 bullish, 1 bearish of 3"; no factor with data "No short-term factor has data yet" (the numbers are `bullish`, `bearish` and `known` of the confluence). Add `export const notCollectedLine = (symbol: FlowSymbol): string | null`: null when the registry entry lists `ticks` and `options`; else `Not collected for <symbol>: <list>. The IBKR and vendor budgets go to <holders>.` where the list holds "trades" for a missing `ticks` and "option prints" for a missing `options`, joined by " and ", and the holders are the symbols whose entry lists `ticks`, sorted by name and joined as "ES and SPY".

#### 9. `apps/web/src/features/flow/view-model.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: Commit 1: none. Commit 8, new cases: "offers SPY, QQQ, ES and NQ"; "counts short-term factors for a bullish, a bearish, a split and an empty reading"; "names what is not collected for QQQ and NQ and nothing for SPY and ES".

#### 10. `packages/db/src/schema/flow.ts` (Modify)

- **Type / Scope**: Drizzle schema.
- **Proposed Changes**:
  - Commit 2: only SQL text and the new table change; `FlowSymbolValue`, `FlowOptionTickerValue` and `FlowSourceValue` keep their values. `symbolCheck` gives `in ('SPY', 'ES', 'QQQ', 'NQ')`; the ticker lists of `flow_option_prints_check` and `flow_gex_check` give `in ('SPY', 'SPX', 'QQQ', 'NDX')`; the source list of `flow_samples_check` gives `in ('ticks', 'depth', 'options', 'gex', 'net_drift')`. Export `FLOW_NET_DRIFT_TICKER_VALUES = ["SPY", "SPX", "QQQ", "NDX"] as const`, `FLOW_NET_DRIFT_PART_VALUES = ["total", "zero_dte"] as const` and the types `FlowNetDriftTickerValue`, `FlowNetDriftPartValue` derived from them. Header comment: retention is per table (entry 3).
  - Commit 2, new table `flowNetDrift` (`flow_net_drift`), properties and columns: `ticker: text("ticker").$type<FlowNetDriftTickerValue>().notNull()`, `part: text("part").$type<FlowNetDriftPartValue>().notNull()`, `minute: utc("minute").notNull()`, `netCallPremium: num("net_call_premium").notNull()`, `netPutPremium: num("net_put_premium").notNull()`, `netCallVolume: num("net_call_volume").notNull()`, `netPutVolume: num("net_put_volume").notNull()`, `underlyingPrice: num("underlying_price")` (nullable), `filterProfile: text("filter_profile").notNull()`. No other column. Primary key (`ticker`, `part`, `minute`). Check `flow_net_drift_check`: `ticker in ('SPY', 'SPX', 'QQQ', 'NDX') and part in ('total', 'zero_dte') and length(filter_profile) <= 40`. No extra index: the hourly prune scans by `minute`, and the table holds about 2.5 million rows after 730 days (2 parts × 2,460 buckets per session, pre-market buckets included, × about 504 sessions; design section 3).
  - Commit 6: export `FLOW_SYMBOL_VALUES = ["SPY", "ES", "QQQ", "NQ"] as const`, `FLOW_OPTION_TICKER_VALUES = ["SPY", "SPX", "QQQ", "NDX"] as const`, `FLOW_SOURCE_VALUES = ["ticks", "depth", "options", "gex", "net_drift"] as const` and derive the three `*Value` types from them. No SQL text changes, so no migration.

#### 11. packages/db/migrations/0077_flow_net_drift.sql (Create)

- **Type / Scope**: Migration, written by drizzle-kit and then edited (commit 2).
- **Proposed Changes**:
  - Command, in a terminal inside `packages/db`, after entry 10 is edited: `bunx --bun --no-install drizzle-kit generate --config drizzle.config.ts --name flow_net_drift` (the command of `packages/db/package.json:62` plus the name). `DATABASE_URL` must be set to any value; the command does not connect, and without a terminal it writes nothing and still exits 0 (`CONVENTIONS.md:115`). Expected output: this file, entry 12 and one journal entry (entry 13). `CONVENTIONS.md:113` requires a generated snapshot for every schema change; `CONVENTIONS.md:86` forbids a hand edit of the journal.
  - Content: `CREATE TABLE "flow_net_drift"` with the columns, key and check of entry 10, and for each constraint of the table below `ALTER TABLE "<table>" DROP CONSTRAINT "<name>";` followed by `ALTER TABLE "<table>" ADD CONSTRAINT "<name>" CHECK (<new text>);`. When drizzle-kit does not write the DROP and ADD statements for a changed check text, write these statements by hand into the generated SQL file (as the grant blocks of 0052 and 0053 were added); the snapshot stays as generated.
  - Hand-added at the end, modelled on `packages/db/migrations/0053_flow_option_gaps.sql:10-19`: a comment and a `DO $$ ... IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_net_drift" TO "vertex_research"; END IF; ... $$;` block.
  - The file holds no `UPDATE`, `DELETE`, `INSERT`, `TRUNCATE` or `DROP TABLE`.

| Constraint (table has the same name without `_check`) | Old text is at | Changed list: old to new |
| --- | --- | --- |
| `flow_book_check` | `packages/db/migrations/0052_flow_pipeline.sql:11` | symbol: `('SPY', 'ES')` to `('SPY', 'ES', 'QQQ', 'NQ')` |
| `flow_events_check` | `packages/db/migrations/0052_flow_pipeline.sql:26` | symbol, as above |
| `flow_gex_check` | `packages/db/migrations/0052_flow_pipeline.sql:45` | symbol, as above; ticker: `('SPY', 'SPX')` to `('SPY', 'SPX', 'QQQ', 'NDX')` |
| `flow_minutes_check` | `packages/db/migrations/0052_flow_pipeline.sql:69` | symbol, as above |
| `flow_option_prints_check` | `packages/db/migrations/0052_flow_pipeline.sql:99` | symbol and ticker, as above |
| `flow_samples_check` | `packages/db/migrations/0052_flow_pipeline.sql:110` | symbol, as above; source: `('ticks', 'depth', 'options', 'gex')` to `('ticks', 'depth', 'options', 'gex', 'net_drift')` |
| `flow_option_gaps_check` | `packages/db/migrations/0053_flow_option_gaps.sql:7` | symbol, as above |

Every other part of each check text stays as in the old line.

#### 12. packages/db/migrations/meta/0077_snapshot.json (Create)

- **Type / Scope**: Generated artifact (JSON class "generated", `scripts/ci/json-data.ts:34-38`).
- **Proposed Changes**: Written by the command of entry 11. Never edited by hand.

#### 13. `packages/db/migrations/meta/_journal.json` (Modify)

- **Type / Scope**: Generated artifact.
- **Proposed Changes**: One new entry with `tag: "0077_flow_net_drift"`, written by the command of entry 11.

#### 14. packages/db/rollback/0077_flow_net_drift.down.sql (Create)

- **Type / Scope**: Guarded reversal, in the form of `packages/db/rollback/0053_flow_option_gaps.down.sql`.
- **Proposed Changes**: Header comment: this file is not the rollback path (the rollback is "deploy the previous app", which runs on the migrated database); before it runs, a person must delete the rows with symbol QQQ or NQ from the seven flow tables and the `net_drift` rows from `flow_samples`, else the narrower checks fail and the transaction rolls back; dropping `flow_net_drift` loses the stored series; the Drizzle ledger row stays. Body: `BEGIN; SET LOCAL search_path = pg_catalog, public; SET LOCAL row_security = off;`, then for each constraint of the table in entry 11 a DROP and an ADD with the full old text copied from the line named there, then `LOCK TABLE "public"."flow_net_drift" IN ACCESS EXCLUSIVE MODE; DROP TABLE "public"."flow_net_drift"; COMMIT;`. No `DELETE`, no cascade.

#### 15. `packages/db/src/server/flow-migration.test.ts` (Modify)

- **Type / Scope**: Unit test of migration SQL and rollback (no database).
- **Proposed Changes**: The 0052 and 0053 blocks need no change (they compare column names and check names only, lines 49-68 and 105-115). Commit 2, new `describe("0077_flow_net_drift migration")`: "creates flow_net_drift, replaces the seven checks and changes no row" (no `TRUNCATE`, `UPDATE`, `DELETE`, `INSERT` or `DROP TABLE`; contains the grant line); "matches the drizzle columns, key and check of flow_net_drift" (through `getTableConfig`); "drops and adds each of the seven checks with the four symbols" (per constraint name: one DROP, one ADD, and the ADD text holds `'QQQ'` and `'NQ'`; the two ticker checks hold `'NDX'`; the samples check holds `'net_drift'`); "has a journal entry with its tag" (finds the tag; pins no index and no neighbour, `CONVENTIONS.md:111`); "the rollback restores the old checks, drops only flow_net_drift and deletes no row". Commit 6, one more case: "every schema symbol, ticker and source value is in the check text of the migration".

#### 16. `packages/db/src/server/flow.ts` (Modify)

- **Type / Scope**: Flow repository (Drizzle only).
- **Proposed Changes**: Commit 2: `export type FlowNetDriftRecord = typeof flowNetDrift.$inferSelect`; `export type FlowPruneTable = "flow_samples" | "flow_minutes" | "flow_book" | "flow_option_prints" | "flow_events" | "flow_gex" | "flow_option_gaps" | "flow_net_drift"`; `export type FlowNetDriftQuery = Readonly<{ tickers: readonly FlowNetDriftTickerValue[]; from: Date; to: Date }>`. New methods of `FlowRepository`:
  - `upsertNetDrift(rows: readonly FlowNetDriftRecord[]): Promise<number>`: batches of `FLOW_UPSERT_BATCH`; `onConflictDoUpdate` on the primary key; sets the four values, `underlying_price` and `filter_profile` from `excluded`; `setWhere`: one of these six columns `IS DISTINCT FROM` its excluded value; returns the count of returned rows, so an unchanged session returns 0.
  - `readNetDrift(query: FlowNetDriftQuery): Promise<FlowNetDriftRecord[]>`: ticker in the list, `from <= minute < to`, ascending by minute.
  - `newestNetDriftMinute(ticker: FlowNetDriftTickerValue): Promise<Date | null>`: the newest `minute` of the `total` part.
  - Changed: `prune(cutoffs: Readonly<Record<FlowPruneTable, Date>>): Promise<number>`, one delete per table with its cutoff, `flow_net_drift` by `minute`. The doc comment at line 73 becomes "Deletes rows older than each table's cutoff; returns the rows removed"; the header comment at line 19 says "prune() removes rows older than each table's retention cutoff".
  - Commit 6: `SOURCES` (line 120) becomes `FLOW_SOURCE_VALUES`, so `latestSamples` also reads the `net_drift` source.

#### 17. `packages/db/src/server/flow.test.ts` (Modify)

- **Type / Scope**: Unit test with a mocked executor.
- **Proposed Changes**: Commit 2: "deletes from every flow table before the cutoff and sums removed rows" becomes "deletes from each flow table before its own cutoff and sums removed rows". New cases: "upserts net drift by ticker, part and minute and rewrites a row only when a value or the filter profile changed"; "returns zero net drift rows for no input"; "reads net drift for the tickers and the time range in minute order"; "returns the newest total net drift minute, or null for an empty table or a missing driver row". Commit 6: "queries the newest sample of the net_drift source".

#### 18. `packages/db/src/server/index.ts` (Modify)

- **Type / Scope**: Public server surface of the database package.
- **Proposed Changes**: Commit 2: add `FlowNetDriftRecord`, `FlowNetDriftQuery` and `FlowPruneTable` to the type re-export block that ends at line 227.

#### 19. `tests/integration/database/database.test.ts` (Modify)

- **Type / Scope**: Integration test (real Postgres, all migrations applied).
- **Proposed Changes**: Commit 2: add `flow_net_drift: "ticker,part,minute"` to the table list after `flow_minutes` (lines 85-91).

#### 20. `packages/api/src/contracts/flow.ts` (Modify)

- **Type / Scope**: oRPC contract and Zod schemas. Each part is written before the code that uses it (contract first). `packages/api/openapi.json` is regenerated in every commit that changes this file.
- **Proposed Changes**:
  - Commit 2: the comment on `pruned` says "(per-table retention)" in place of "(14 days)".
  - Commit 3: `FLOW_EXPIRY_PARTS = ["total", "zero_dte"] as const`, `FLOW_FILTER_PROFILE = "otm-clean.v1"`, type `FlowExpiryPart`.
  - Commit 4: `FLOW_GROUP_IDS = ["sp500", "nasdaq100"]`, `FLOW_CONTROL_STATES = ["buyers", "sellers", "balanced", "mixed", "no_data"]`, `FLOW_NO_DATA_REASONS = ["market_closed", "source_unavailable", "stale", "gap", "session_start", "sampled_tape", "not_collected"]` (the order is the priority), `FLOW_PARTS_STATUSES = ["complete", "partial", "no_data"]`, `FLOW_AGREEMENT_STATES = ["not_comparable"]` (widened with the futures fold, not in this design), `FLOW_CROSS_CHECK_RESULTS = ["same_direction", "opposite_direction", "not_comparable", "not_collected"]`, `FLOW_STUDY_STATUSES = ["edge", "no-edge", "needs-more-data", "not_tested"]`, and `FlowControlRulesSchema`.
  - Commit 5: `FlowCollectOutputSchema` gains `budget: FlowCollectBudgetSchema` = `{ quantDataFree: count.nullable(), quantDataReserve: count, ibkrRecent: count.nullable(), ibkrLimit: count, runSeconds: count }` (strict).
  - Commit 6: `FLOW_SYMBOLS = ["SPY", "ES", "QQQ", "NQ"]`, `FLOW_OPTION_TICKERS = ["SPY", "SPX", "QQQ", "NDX"]`, `FLOW_SOURCES = ["ticks", "depth", "options", "gex", "net_drift"]`, `FLOW_SNAPSHOT_SOURCES = ["ticks", "depth", "options", "gex"]`, `FLOW_SNAPSHOT_TOOL_SYMBOLS = ["SPY", "ES"]`. `FlowCollectInputSchema.symbols` gets `.max(4)`. `FlowFreshnessSchema.source` uses `FLOW_SNAPSHOT_SOURCES`. The `minutes` field of `FlowSnapshotInputSchema` moves into one constant `snapshotMinutes` that both snapshot input schemas use; new `FlowSnapshotToolInputSchema = z.object({ symbol: z.enum(FLOW_SNAPSHOT_TOOL_SYMBOLS), minutes: snapshotMinutes }).strict()` (the same keys in the same order as `FlowSnapshotInputSchema` has today). The summary of `collect` names the four symbols and net drift.
  - Commit 7: tuples `FLOW_CAPTURE_MODES = ["sampled"]`, `FLOW_SIGNING_METHODS = ["quote", "tick"]`, `FLOW_TRADE_SIDES = ["buy", "sell"]`, `FLOW_TICKER_ROLES = ["primary", "check"]`, `FLOW_SESSION_EVENTS = ["fomc"]`; constants `FLOW_CONTROL_VERSION = "flow-control.v1"`, `FLOW_CONTROL_MAX_POINTS = 420`, `FLOW_CONTROL_MAX_TRADES = 60`, `FLOW_CONTROL_MAX_MINUTES = 420`, `FLOW_CONTROL_MAX_ABSORPTIONS = 20`, `FLOW_CONTROL_MAX_FRESHNESS = 12`, `FLOW_CONTROL_MAX_NOTES = 12`; the other schemas of the table below; the procedure `control`: `GET /flow/control`, `operationId: "flow.control"`, summary "One index group: who is in control on the futures side and the options side, net drift and study status (research input)", errors `FLOW_API_ERRORS`; `flowContract = { collect, control, snapshot }`.
  - Legend for the table: every object is `.strict()`; `ts` = `timestamp` (line 100); `text(k)` = `z.string().max(k)` (line 101); `count` = the file's `count` (line 97); `n` = `z.number()`; `n a..b` = `z.number().min(a).max(b)`; `int a..b` = `z.number().int().min(a).max(b)`; `E(X)` = `z.enum(X)`; `?` after a type = `.nullable()`; `max k` = `z.array(...).max(k)`.
  - Exported types (commit of their schema): `FlowExpiryPart`, `FlowGroupId`, `FlowControlState`, `FlowNoDataReason`, `FlowPartsStatus`, `FlowAgreementState`, `FlowCrossCheckResult`, `FlowStudyStatus`, `FlowControlRules`, `FlowCollectBudget`, `FlowSnapshotSource`, `FlowControlInput`, `FlowControl`, `FlowControlSide`, `FlowControlOptionsSide`, `FlowAgreement`, `FlowNetDriftTotals`, `FlowNetDriftPoint`, `FlowNetDriftSeries`, `FlowDeepTrades`, `FlowCrossCheck`, `FlowControlStudy`, `FlowControlFreshness`.

| Schema | Fields |
| --- | --- |
| `FlowControlInputSchema` | `group: E(FLOW_GROUP_IDS)` |
| `FlowControlRulesSchema` | `version: text(40)`, `windowMinutes: int 1..390`, `enterRatio: n 0..1`, `exitRatio: n 0..1`, `minMinutes: int 1..60`, `minBuckets: int 1..390` |
| `FlowControlSideSchema` | `instrument: text(12)`, `state: E(FLOW_CONTROL_STATES)`, `noDataReason: E(FLOW_NO_DATA_REASONS)?`, `direction: E(FLOW_DIRECTIONS)`, `label: text(120)`, `detail: text(300)`, `since: ts?`, `asOf: ts?`, `ratio: (n -1..1)?`, `enterRatio: n 0..1`, `windowStart: ts?`, `windowEnd: ts?`, `inputs: { numerator: n?, denominator: n?, rows: count }` |
| `FlowControlOptionsSideSchema` | the side fields plus `primaryTicker: E(FLOW_OPTION_TICKERS)`, `checkTicker: E(FLOW_OPTION_TICKERS)`, `checkState: E(FLOW_CONTROL_STATES)` |
| `FlowAgreementSchema` | `state: E(FLOW_AGREEMENT_STATES)`, `direction: E(FLOW_DIRECTIONS)`, `label: text(120)`, `detail: text(300)`, `since: ts?` |
| `FlowNetDriftTotalsSchema` | `netCallPremiumUsd: n`, `netPutPremiumUsd: n`, `callMinusPutUsd: n`, `netCallVolume: n`, `netPutVolume: n` |
| `FlowNetDriftLineSchema` | `netCallPremiumUsd: n`, `netPutPremiumUsd: n` (cumulative since 09:30) |
| `FlowNetDriftPointSchema` | `minute: ts`, `total: FlowNetDriftLineSchema`, `zeroDte: FlowNetDriftLineSchema?`, `longer: FlowNetDriftLineSchema?`, `underlyingPrice: n?` |
| `FlowNetDriftSeriesSchema` | `ticker: E(FLOW_OPTION_TICKERS)`, `role: E(FLOW_TICKER_ROLES)`, `asOf: ts?`, `filterProfile: text(40)`, `totals: { cumulativeFrom: ts, total: FlowNetDriftTotalsSchema?, zeroDte: FlowNetDriftTotalsSchema?, longer: FlowNetDriftTotalsSchema? }`, `partsStatus: E(FLOW_PARTS_STATUSES)`, `partsDetail: text(300)?`, `slopeUsdPerMinute: n?`, `slopeWindowMinutes: int 1..390`, `points: FlowNetDriftPointSchema max 420` |
| `FlowDeepTradesSchema` | `symbol: E(FLOW_SYMBOLS)`, `limitSize: n?`, `signing: E(FLOW_SIGNING_METHODS)?`, `capture: E(FLOW_CAPTURE_MODES)`, `coverage: { seenSeconds: count, windowSeconds: count, share: (n 0..1)? }`, `sums: { buyVolume: n, sellVolume: n, netVolume: n, cumulativeFrom: ts? }`, `trades: { at: ts, side: E(FLOW_TRADE_SIDES), size: n, price: n, signing: E(FLOW_SIGNING_METHODS) } max 60`, `totalTrades: count`, `minutes: { minute: ts, buyVolume: n, sellVolume: n, coveredSeconds: int 0..60 } max 420`, `absorptions: { at: ts, direction: E(FLOW_DIRECTIONS), price: n?, detail: text(200) } max 20` |
| `FlowCrossCheckSchema` | `ticker: E(FLOW_OPTION_TICKERS)`, `result: E(FLOW_CROSS_CHECK_RESULTS)`, `storedPrints: count`, `unreadRanges: count`, `oldestUnreadAt: ts?`, `detail: text(300)` |
| `FlowControlStudySchema` | `status: E(FLOW_STUDY_STATUSES)`, `strategyId: text(80)`, `testedOn: text(10)?`, `rulesVersion: text(400)?`, `detail: text(300)`, `agreementDetail: text(120)` |
| `FlowControlFreshnessSchema` | `source: E(FLOW_SOURCES)`, `instrument: text(12)`, `state: E(FLOW_FRESHNESS_STATES)`, `lastOkAt: ts?`, `ageSeconds: count?`, `message: text(300)?` |
| `FlowSessionLevelsSchema` | `ticker: E(FLOW_OPTION_TICKERS)`, `sessionOpen: n?`, `sessionHigh: n?`, `sessionLow: n?`, `previousClose: n?`, `source: z.literal("one_minute_closes")` |
| `FlowControlSchema` | `schemaVersion: z.literal(FLOW_CONTROL_VERSION)`, `group: E(FLOW_GROUP_IDS)`, `generatedAt: ts`, `session: { date: text(10), open: z.boolean(), optionsOpen: z.boolean(), futuresOpen: z.boolean(), event: E(FLOW_SESSION_EVENTS)? }`, `levels: FlowSessionLevelsSchema?`, `rules: FlowControlRulesSchema`, `futures: FlowControlSideSchema`, `options: FlowControlOptionsSideSchema`, `agreement: FlowAgreementSchema`, `netDrift: FlowNetDriftSeriesSchema max 2`, `deepTrades: FlowDeepTradesSchema`, `crossCheck: FlowCrossCheckSchema`, `study: FlowControlStudySchema`, `freshness: FlowControlFreshnessSchema max 12`, `notes: text(300) max 12` |

#### 21. packages/api/src/flow-control.contract.test.ts (Create)

- **Type / Scope**: Contract test (project `contract`, pattern `**/*contract.test.ts`, `vitest.config.ts:157`).
- **Proposed Changes**: Commit 5: "requires the budget block in the collect output". Commit 6: "accepts four symbols in flow.collect and rejects five"; "keeps flow-snapshot.v1 freshness to the four snapshot sources"; "the tool input of flow_snapshot accepts SPY and ES and rejects QQQ". Commit 7: "accepts a full flow-control.v1 document"; "accepts null and a filled value for session.event and levels"; "rejects an extra key at every level"; "rejects more than 420 points, 60 trades, 420 minutes, 20 absorptions"; "rejects a ratio outside -1 to 1"; "accepts sp500 and nasdaq100 and rejects another group"; "allows only sampled as the capture mode"; "holds the eight no-data reasons in priority order and no partial"; "allows only not_comparable as the agreement state"; "accepts complete, partial and no_data as the parts status"; "exposes flow.control as GET /flow/control".

#### 22. `packages/api/src/server/quantdata-client.ts` (Modify)

- **Type / Scope**: Vendor client (adapter).
- **Proposed Changes**:
  - Commit 3: add `netDrift: "/v1/options/tool/net-drift"` to `QUANTDATA_ENDPOINTS`. The collector passes `ttlMs = 30_000`, below the 120 s net drift cadence. A new object key adds no branch.
  - Commit 5 (caller reserve; design section 3): export the existing `DEFAULT_MAX_PER_MINUTE` (line 33). `QuantDataFailureReason` gains `"reserved"`. `QuantDataClient.request` gains a fifth optional parameter `keepFree?: number` (default 0, held to 0 to `maxPerMinute − 1`); `send` takes it, and the window check at lines 224-235 refuses a start when `starts.length >= maxPerMinute − keepFree`: with `keepFree > 0` and `starts.length < maxPerMinute` the failure is `reserved` with the message `QuantData <endpoint>: <keepFree> request starts per minute are kept free for other callers.` and `retryAfterSeconds` as today; otherwise the present `rate_limited` failure. A cache hit starts no request and is never refused. `QuantDataClient` gains `freeStarts: () => number`: `maxPerMinute` minus the starts of the last 60 s at `now()`. New `export const withCallerReserve = (client: QuantDataClient, keepFree: number): QuantDataClient` returns `{ cooldownSeconds: client.cooldownSeconds, freeStarts: () => Math.max(0, client.freeStarts() − keepFree), request: (endpoint, payload, ttlMs, cacheKey) => client.request(endpoint, payload, ttlMs, cacheKey, keepFree) }`, so the view shares the one window of the shared client. The header comment (lines 1-18) names the caller reserve. `options-analytics.ts:169` keeps testing `rate_limited` only; a `reserved` answer reaches `/charts` never, because `/charts` calls use `keepFree = 0`.

#### 23. packages/api/src/flow-net-drift.ts (Create)

- **Type / Scope**: Pure leaf module (commit 3): vendor request bodies and the Zod mapper. Imports contract types only. The shape comes from the vendor document and the probe named in the facts.
- **Proposed Changes**:
  - `export const netDriftRequest = (sessionDate: string, ticker: string, part: FlowExpiryPart): Readonly<Record<string, unknown>>` returns, with the keys in this order, `{ sessionDate, aggregationPeriod: "1m", filter: { tickers: [ticker], moneyTypes: ["OTM"] }, filterExpression: { conjunction: "AND", filters: [ { field: "isComplex", operation: "=", value: false }, { field: "isFloor", operation: "=", value: false }, { field: "isTied", operation: "=", value: false }, { field: "isCancelled", operation: "=", value: false } ] } }`. For `zero_dte` the `filters` list has a fifth entry `{ field: "dte", operation: "<", value: 1 }`. For `total` it has no `dte` entry. These two bodies are the filter profile `otm-clean.v1`.
  - `NetDriftBucketSchema = z.object({ netCallPremium: z.number(), netPutPremium: z.number(), netCallVolume: z.number(), netPutVolume: z.number(), midMarketCallPremium: z.number().optional(), midMarketPutPremium: z.number().optional(), stockPrice: z.number().positive().optional() })` (other keys are dropped); `NetDriftDataSchema = z.record(z.string().regex(/^\d{10,14}$/), NetDriftBucketSchema)`, refused above 1500 keys.
  - `export type FlowNetDriftBucket = Readonly<{ minute: Date; netCallPremium: number; netPutPremium: number; netCallVolume: number; netPutVolume: number; underlyingPrice: number | null }>`.
  - `export const parseNetDrift = (data: unknown): Readonly<{ ok: true; buckets: readonly FlowNetDriftBucket[] }> | Readonly<{ ok: false; message: string }>`: parse; the key is the bucket start in epoch milliseconds; keep keys that are a whole minute; sort ascending; `underlyingPrice = stockPrice ?? null`. Failure message: `net drift answer has an unexpected shape: <first issue path>` (no payload text).
  - `export const newestBucketAt = (buckets: readonly FlowNetDriftBucket[]): Date | null`.
  - Commit 6: `export type FlowNetDriftRow = FlowNetDriftBucket & Readonly<{ ticker: FlowOptionTicker; part: FlowExpiryPart; filterProfile: string }>`. Its property names and types equal those of `FlowNetDriftRecord` (entries 10 and 16), so the repository rows are used without a mapper.

#### 24. packages/api/src/flow-net-drift.test.ts (Create)

- **Type / Scope**: Unit test of entry 23 (100% lines and branches), commit 3.
- **Proposed Changes**: Cases: "builds exactly the two request bodies of the golden fixture" (reads `netDriftRequests.total` and `netDriftRequests.zero_dte` of entry 27 and compares each with `netDriftRequest("YYYY-MM-DD", "T", part)` by deep equality and by `JSON.stringify`, which also pins the key order); "maps buckets in minute order with signed values"; "keeps the price when present and null when absent"; "drops a key that is not a whole minute"; "rejects a non-object answer, a bad key and a non-number value with a message that has no payload"; "rejects more than 1500 buckets"; "returns the newest bucket time, or null for no buckets".

#### 25. packages/api/src/flow-control-rules.ts (Create)

- **Type / Scope**: Pure leaf module (commit 4): the rules object, the fold and every label. Imports contract types only. Pull request 3 imports `FLOW_CONTROL_RULES`, `optionsRatio`, `foldControlState` and `FLOW_CONTROL_STUDY_RULES_ITEM`; do not rename them.
- **Proposed Changes**:
  - `export const FLOW_CONTROL_RULES: FlowControlRules = { version: "flow-control-rules.v1", windowMinutes: 30, enterRatio: 0.3, exitRatio: 0.1, minMinutes: 5, minBuckets: 10 }` (frozen). `export const FLOW_CONTROL_STUDY_RULES_ITEM = "Rules version"`, `FLOW_CONTROL_STUDY_ID = "flow-control-continuation"`, `FLOW_STUDY_AGREEMENT_DETAIL = "futures and options agreement is not compared or tested"`, `FLOW_NET_DRIFT_SLOPE_MINUTES = 15`, `FLOW_CROSS_CHECK_MIN_PRINTS = 20`.
  - `export type FlowDriftMinute = Readonly<{ minute: number; netCallPremium: number; netPutPremium: number }>`: `minute` is whole minutes after 09:30 New York; the values are the `total` bucket of that minute; a missing minute is a gap.
  - `export const windowTotals = (minutes: readonly FlowDriftMinute[], end: number, rules: FlowControlRules): Readonly<{ numerator: number; denominator: number; rows: number }>` over the entries with `end − rules.windowMinutes < minute <= end`: numerator = Σ(call − put), denominator = Σ(|call| + |put|), rows = their count. `export const optionsRatio = (window: readonly FlowDriftMinute[]): number` = numerator / denominator over the given entries; 0 when the denominator is 0.
  - `export type FlowControlStep = Readonly<{ minute: number; ratio: number | null; state: "buyers" | "sellers" | "balanced" | "no_data"; noDataReason: "session_start" | "gap" | null; sinceMinute: number | null }>`.
  - `export const foldControlState = (minutes: readonly FlowDriftMinute[], rules: FlowControlRules): readonly FlowControlStep[]` (the rules argument is required; the study passes windows of 15 and 60). One step per minute m from 0 to the last input minute, gaps included; no step for an empty input. The fold keeps a carried state (`buyers`, `sellers` or `balanced`, at first `balanced`), its start minute, a buy run and a sell run.
    - Fewer than `minBuckets` entries in the window of m: the step is `{ ratio: null, state: "no_data", sinceMinute: null }` with the reason `session_start` when `m + 1 < minBuckets`, else `gap`. The carried state and its start are kept; both runs are reset. When a later minute has enough entries again, its step reports the carried state with its original `sinceMinute`, after the rules below are applied to its ratio.
    - Otherwise `ratio = optionsRatio(window)`. While the carried state is `balanced`: count steps in a row with ratio >= enter ratio (buy run) or <= −enter ratio (sell run); a ratio between the two resets both runs; when a run reaches `minMinutes` the carried state becomes that side and its start is the first minute of the run. While `buyers`: a ratio < exit ratio ends control in that step (carried state `balanced`, start null; the step starts a sell run when its ratio is <= −enter ratio); a ratio equal to the exit ratio keeps control; a ratio equal to the enter ratio counts for a run. `sellers` mirrors this with ratio > −exit ratio. The step reports the carried state and its start.
  - `export const groupOptionsState = (primary: FlowControlState, check: FlowControlState): FlowControlState`: `no_data` when the primary is `no_data`; `mixed` when one is `buyers` and the other `sellers`; else the primary state.
  - `export const crossCheckResult = (vendorNumerator: number | null, printsFigure: number, storedPrints: number): "same_direction" | "opposite_direction" | "not_comparable"`: `not_comparable` when `storedPrints < FLOW_CROSS_CHECK_MIN_PRINTS`, the numerator is null or 0, or the prints figure is 0; `same_direction` when both have the same sign; else `opposite_direction`.
  - The four text functions build every `label` and `detail`; the numbers come from the rules argument and the facts, never from a literal:
    - `export type FlowText = Readonly<{ label: string; detail: string }>`.
    - `export type FlowSideFacts = Readonly<{ instrument: string; state: FlowControlState; reason: FlowNoDataReason | null; ratio: number | null; primaryState: FlowControlState; checkInstrument: string | null; buckets: number; minutesSinceOpen: number; cause: string | null; newestBucketEt: string | null; staleMinutes: number; sessionDate: string; closeState: FlowControlState | null }>`.
    - `export const describeSide = (facts: FlowSideFacts, rules: FlowControlRules): FlowText`.
    - `export const describeAgreement = (futures: FlowSideSummary, options: FlowSideSummary): FlowText` with `FlowSideSummary = Readonly<{ instrument: string; state: FlowControlState; label: string; detail: string }>`; it builds the `not_comparable` text only.
    - `export const describeParts = (instrument: string): string` (the sentence of a `partial` parts status).
    - `export const describeCrossCheck = (facts: Readonly<{ ticker: string; result: FlowCrossCheckResult; storedPrints: number; unreadRanges: number }>): string`.
    - `export const describeStudy = (study: Readonly<{ status: FlowStudyStatus; testedOn: string | null }>): string`.
  - Templates. Angle brackets mark runtime values: `<I>` instrument, `<C>` check instrument, `<F>` futures instrument, `<O>` options instrument, `<r>` ratio and `<e>` enter ratio with two decimals, `<w>` `windowMinutes`, `<b>` `minBuckets`, `<n>` buckets in the window, `<m>` minutes since 09:30, `<t>` time of the newest bucket, `<s>` `staleMinutes`, `<d>` session date, `<side>` "bullish" for `buyers` and "bearish" for `sellers`, `<state>` the state name. The page prints a no-data line as `<label>: <detail>`. A detail longer than 300 characters is cut to 300.

| Function, case | `label` | `detail` |
| --- | --- | --- |
| `describeSide`, `buyers` | `<I> options: bullish, call buying leads` | `Ratio <r> over the last <w> min; enter ratio <e>` |
| `describeSide`, `sellers` | `<I> options: bearish, put buying leads` | `Ratio <r> over the last <w> min; enter ratio <e>` |
| `describeSide`, `balanced` | `<I> options: balanced` | `Ratio <r> over the last <w> min; enter ratio <e>` |
| `describeSide`, `mixed` | `Options mixed: <I> <side of primaryState>, <C> <the other side>` | `<I> ratio <r> over the last <w> min; <C> is in control of the other side` |
| `describeSide`, `market_closed`, `closeState` `buyers` or `sellers` | `Market closed` | `Last session ended 16:15 ET on <d>; at the close the <I> options side was <side>` |
| `describeSide`, `market_closed`, `closeState` `balanced` or `mixed` | `Market closed` | `Last session ended 16:15 ET on <d>; at the close the <I> options side was <state>` |
| `describeSide`, `market_closed`, `closeState` `no_data` | `Market closed` | `Last session ended 16:15 ET on <d>; at the close the <I> options side had no state` |
| `describeSide`, `market_closed`, `closeState` null | `Market closed` | `No net drift session is stored yet` |
| `describeSide`, `source_unavailable` | `No answer from QuantData net drift` | `<cause>`, or `the last request failed` when `cause` is null |
| `describeParts` | none | `The same-day (0DTE) part of <I> net drift is missing; the totals are complete` |
| `describeSide`, `stale`, with a bucket | `Net drift is stale` | `Newest <I> bucket is <t>; stale after <s> min` |
| `describeSide`, `stale`, `newestBucketEt` null | `Net drift is stale` | `No <I> bucket since 09:30 ET; stale after <s> min` |
| `describeSide`, `gap` | `Gap in net drift` | `<n> of <b> buckets needed in the last <w> min for <I>` |
| `describeSide`, `session_start` | `Session start` | `<m> of <b> minutes needed since 09:30 ET` |
| `describeSide`, `sampled_tape` | `Sampled tape` | `<I> trades are sampled; no state is computed from them` |
| `describeSide`, `not_collected` | `Futures: deep trades not collected yet` | `<I> deep trades are not collected yet` |
| `describeAgreement` (`not_comparable`) | `Cannot compare` | `<label>: <detail>` of the side without data (the futures side when both have none) |
| `describeCrossCheck`, `same_direction` | none | `Stored <I> option prints point the same way as the vendor net drift (<n> prints, <u> unread time ranges)` |
| `describeCrossCheck`, `opposite_direction` | none | `Stored <I> option prints point the other way (<n> prints, <u> unread time ranges). Check the filter profile and the vendor status. No state is changed.` |
| `describeCrossCheck`, `not_comparable` | none | `Too few stored <I> option prints to compare, or one figure is zero (<n> prints, 20 needed)` (20 is `FLOW_CROSS_CHECK_MIN_PRINTS`) |
| `describeCrossCheck`, `not_collected` | none | `Option prints are not collected for <I>` |
| `describeStudy`, `not_tested` | none | `Options-side continuation rule (modelled fills): not tested yet` |
| `describeStudy`, `edge` | none | `Options-side continuation rule (modelled fills): tested on <testedOn>, edge found (Strategy Library)` |
| `describeStudy`, `no-edge` | none | `Options-side continuation rule (modelled fills): tested on <testedOn>, no edge found (Strategy Library)` |
| `describeStudy`, `needs-more-data` | none | `Options-side continuation rule (modelled fills): tested on <testedOn>, more data needed (Strategy Library)` |

No text of this table holds a word that the status-language test rejects.

#### 26. packages/api/src/flow-control-rules.test.ts (Create)

- **Type / Scope**: Unit test of entry 25 (100% lines and branches), commit 4.
- **Proposed Changes**: Cases: "replays every options case of the golden fixture: ratio, state, reason and start minute per minute" (reads entry 27; the `rules.windowMinutes` of a case overrides the fixture rules; ratios compared to 9 decimal places); "replays every group case of the golden fixture"; "the fixture carries the rules object, the study rules item and the filter profile of the code"; "ratio is 0 for a zero denominator and the state stays balanced"; "reports session_start before minBuckets minutes and gap after them"; "returns no step for an empty input"; "enters after minMinutes in a row and dates the start at the first of them"; "a ratio equal to the enter ratio counts and a ratio equal to the exit ratio keeps control"; "a ratio between the two resets the run"; "after a gap the step reports the carried state with its original start"; "sellers mirror buyers"; "works with windows of 15, 30 and 60 minutes"; "agreement text names the side without data (the futures side when both have none)"; "describeParts names the missing same-day part"; "cross-check needs 20 prints and two non-zero figures"; "every text takes its numbers from the rules argument and the facts" (changed rules change the text); one case per row of the template table.

#### 27. packages/api/src/fixtures/flow-control-golden.fixture.json (Create)

- **Type / Scope**: Test fixture, shared with the Python port of pull request 3. JSON class "fixture": the path has a `fixtures/` segment or the name ends in `.fixture.json` (`scripts/ci/json-data.ts:29-31,49`; this file meets both). Only test files name it, and test files are not runtime sources (`:61-62`). The folder `packages/api/src/fixtures` exists.
- **Proposed Changes**: Pull request 3 reads this shape; do not change it. Commit 3 creates the file with `{ schemaVersion: "flow-control-golden.v1", studyRulesItem: "Rules version", filterProfile: "otm-clean.v1", netDriftRequests: { total, zero_dte }, rules: {}, optionsCases: [], groupCases: [] }`, where `total` and `zero_dte` are the two full bodies of entry 23 for sessionDate "YYYY-MM-DD" and ticker "T". Commit 4 fills `rules` (the six values of `FLOW_CONTROL_RULES` as JSON), `optionsCases` and `groupCases`. An options case is `{ name, rules?: { windowMinutes }, minutes: [ { minute, netCallPremium, netPutPremium } ], expected: [ { minute, ratio, state, noDataReason, sinceMinute } ] }` with one expected entry per minute from 0 to the last. A group case is `{ name, primary, check, expected }`. Options cases: a bullish run from the open; enter then exit; a flip from buyers to sellers; balanced between the two ratios; a gap of missing minutes with the carried state after it; exact ties at the enter ratio and at the exit ratio; a zero denominator (ratio 0, state balanced); one series with windows of 15, 30 and 60. Group cases: both pairs that give `mixed`, a check ticker without data, a primary without data. The author computes the expected values in a spreadsheet, not with `foldControlState`.

#### 28. packages/api/src/server/flow-control.ts (Create)

- **Type / Scope**: Assembly of `flow-control.v1` from stored rows (commit 7; no I/O). Imports entry 1 (`FLOW_GROUPS`, `FLOW_INSTRUMENTS`, `flowSymbolForTicker`), entry 5 (`flowSessionOpen`, `FLOW_STALE_SECONDS`, `FlowSampleRow`), entry 23 (`FlowNetDriftRow`), entry 25, `FlowOptionPrintRow` from `packages/api/src/flow-options.ts`, `newYorkTime` from `packages/api/src/server/merged-bars.ts`, `newYorkClock` from `packages/api/src/signal-alerts.ts` and the contract.
- **Proposed Changes**:
  - `export type FlowStudyRead = Readonly<{ status: FlowStudyStatus; testedOn: string | null; rulesVersion: string | null }>`. `export type FlowControlRows = Readonly<{ group: FlowGroupId; now: Date; sessionDate: string; netDrift: readonly FlowNetDriftRow[]; samples: Readonly<Partial<Record<FlowSymbol, Readonly<{ latest: readonly FlowSampleRow[]; latestOk: readonly FlowSampleRow[] }>>>>; crossPrints: readonly FlowOptionPrintRow[] | null; crossGaps: readonly Readonly<{ startTime: Date; endTime: Date }>[] | null; study: FlowStudyRead }>`. `samples` is keyed by flow symbol; the samples of a ticker are those of `flowSymbolForTicker(ticker)`.
  - `export const optionsSessionRange = (date: string): Readonly<{ from: Date; to: Date }>` = `{ from: newYorkTime(date, 570), to: newYorkTime(date, 975) }` (09:30 and 16:15). `export const etClock = (date: Date): string` = `HH:MM ET` from `newYorkClock(date).minute`.
  - `export const buildFlowControl = (rows: FlowControlRows): FlowControl`. Per ticker of the group (primary, then check):
    - Buckets: the rows of the ticker with `filterProfile === FLOW_FILTER_PROFILE` and `from <= minute < to` of `optionsSessionRange(rows.sessionDate)`. Settled `total` buckets: all `total` buckets, without the newest one while `flowSessionOpen("net_drift", symbol, now)` is true. Fold input: one `FlowDriftMinute` per settled `total` bucket with `minute = (bucket.minute − from) / 60 000`. `steps = foldControlState(input, FLOW_CONTROL_RULES)`; `last` is the last step or null.
    - Ticker state and reason, the first rule that applies: (1) `market_closed` when `flowSessionOpen("options", symbol, now)` is false; `closeState` is `last.state`, or null without a step. (2) `source_unavailable` when the newest `net_drift` sample of the symbol has the status `unavailable` and no `ok` sample is at most 300 s old; `cause` is that sample's message. (3) `stale` when `now − max(newest stored total bucket minute, from) > FLOW_STALE_SECONDS.net_drift` seconds. (4) `last` is null: `session_start`. (5) `last.state` is `no_data`: its reason (`gap` or `session_start`). (6) else `last.state` with no reason. `partial` is never a side reason.
  - Options side: the first table below gives every field (P = the primary ticker result, K = the check ticker result).
  - Session: `date` = `rows.sessionDate`; `optionsOpen` = `flowSessionOpen("options", group.future, now)` (09:30 to 16:15; this call decides `market_closed`); `futuresOpen` = `flowSessionOpen("ticks", group.future, now)`; `open` = `optionsOpen || futuresOpen`; `event` = null. `levels` = null.
  - Net drift series, one per ticker in the order primary, check: the second table below gives every field.
  - Futures side: `{ instrument: group.future, state: "no_data", noDataReason: "not_collected", direction: "neutral", since: null, asOf: null, ratio: null, enterRatio: FLOW_CONTROL_RULES.enterRatio, windowStart: null, windowEnd: null, inputs: { numerator: null, denominator: null, rows: 0 } }` with the `not_collected` texts. Pull request 2 changes the reason to `sampled_tape`.
  - Agreement: `{ state: "not_comparable", direction: "neutral", since: null }` with the label and detail of `describeAgreement(futures, options)`.
  - Deep trades: `{ symbol: group.future, limitSize: null, signing: null, capture: "sampled", coverage: { seenSeconds: 0, windowSeconds: windowMinutes × 60, share: null }, sums: { buyVolume: 0, sellVolume: 0, netVolume: 0, cumulativeFrom: null }, trades: [], totalTrades: 0, minutes: [], absorptions: [] }`.
  - Cross-check. nasdaq100: `{ ticker: "QQQ", result: "not_collected", storedPrints: 0, unreadRanges: 0, oldestUnreadAt: null }`. sp500: ticker SPX; the window is `[options.windowStart, options.windowEnd)` of the SPX fold; without a window the result is `not_comparable` with zeros. `storedPrints` = the count of `crossPrints` with `ticker === "SPX"` and `tradedAt` in the window. Prints figure = Σ over these prints of `premium × a × b`, with a = +1 for the sides `ask` and `above_ask`, −1 for `bid` and `below_bid`, 0 for the others, and b = +1 for a call, −1 for a put. `vendorNumerator` = `options.inputs.numerator`. `result` = `crossCheckResult(vendorNumerator, figure, storedPrints)`. `unreadRanges` = the count of `crossGaps` with `startTime < windowEnd` and `endTime > windowStart`; `oldestUnreadAt` = the earliest `startTime` of these, or null. `detail` = `describeCrossCheck`. The result never changes a state.
  - Study: `{ status, strategyId: FLOW_CONTROL_STUDY_ID, testedOn, rulesVersion, detail: describeStudy(...), agreementDetail: FLOW_STUDY_AGREEMENT_DETAIL }`.
  - Freshness: one row per ticker with `source: "net_drift"`, `instrument` = the ticker, `lastOkAt` and `ageSeconds` from the newest `ok` sample of its symbol, `message` from the newest sample, `state` = `never` without an `ok` sample, `closed` when `flowSessionOpen("net_drift", symbol, now)` is false, `stale` when the age is above `FLOW_STALE_SECONDS.net_drift`, else `fresh`.
  - Notes, in this order: "Net drift filter otm-clean.v1: out-of-the-money options only, without complex, tied, floor and cancelled trades." (the id comes from `FLOW_FILTER_PROFILE`); "Net drift values are the vendor's signed per-minute values; sums start at 09:30 New York."; "The newest net drift minute is left out until it has closed."; "Futures deep trades are not collected yet."; "Research only; a state describes recent flow and is not a trade signal."

| Field | Value |
| --- | --- |
| `instrument`, `primaryTicker` | `group.primaryTicker` |
| `checkTicker`, `checkState` | `group.checkTicker`; the state of K (`no_data` when K has a reason) |
| `state` | `groupOptionsState(P.state, K.state)` |
| `noDataReason` | the reason of P when `state` is `no_data`, else null |
| `direction` | `bullish` for `buyers`, `bearish` for `sellers`, else `neutral` |
| `label`, `detail` | `describeSide` with `state` and `reason` of the side, `ratio`, `cause` and `closeState` of P, and (`buckets` = `inputs.rows`, `minutesSinceOpen` = `last.minute + 1` or 0, `newestBucketEt` = `etClock` of the newest stored total bucket or null, `staleMinutes` = `FLOW_STALE_SECONDS.net_drift / 60`, `checkInstrument` = `group.checkTicker`, `primaryState` = `P.state`) |
| `since` | for `buyers` and `sellers`: `from + last.sinceMinute` minutes as ISO text; else null |
| `asOf`, `windowEnd` | `from + (last.minute + 1)` minutes; null without a step |
| `windowStart` | `windowEnd − windowMinutes` minutes; null without a step |
| `ratio` | `last.ratio` when `state` is not `no_data`, else null |
| `enterRatio` | `FLOW_CONTROL_RULES.enterRatio` |
| `inputs.numerator`, `inputs.denominator`, `inputs.rows` | `windowTotals(input, last.minute, FLOW_CONTROL_RULES)`; without a step: null, null, 0 |

| Field | Value |
| --- | --- |
| `ticker`, `role` | the ticker; `primary` or `check` |
| `filterProfile` | `FLOW_FILTER_PROFILE` |
| `asOf` | the `asOf` of that ticker's fold (rule of the side table) |
| `partsStatus`, `partsDetail` | `no_data` and null without a settled `total` bucket; `partial` and `describeParts(ticker)` when the session has settled `total` buckets and either no `zero_dte` bucket or a newest `zero_dte` bucket more than 5 minutes before the newest `total` bucket; else `complete` and null. Neither field changes a side state |
| `points` | one per settled `total` bucket, ascending; `total` = running sum of the `total` buckets since 09:30; `zeroDte` = running sum of the `zero_dte` buckets up to that minute (a minute without a `zero_dte` bucket adds 0); `longer` = `total − zeroDte` per field; `zeroDte` and `longer` are null in every point when `partsStatus` is `partial`; `underlyingPrice` = the price of the `total` bucket. At most 405 points exist (09:30 to 16:15), so no truncation rule is needed. |
| `totals.cumulativeFrom` | `from` as ISO text |
| `totals.total`, `totals.zeroDte`, `totals.longer` | the sums up to the last point with the five fields of `FlowNetDriftTotalsSchema` (`callMinusPutUsd` = call − put); `total` is null without a point; `zeroDte` and `longer` are null without a point or when `partsStatus` is `partial` |
| `slopeUsdPerMinute` | (`callMinusPutUsd` of the last point − that of the newest point at least `FLOW_NET_DRIFT_SLOPE_MINUTES` minutes earlier) / 15; null without such a point |
| `slopeWindowMinutes` | `FLOW_NET_DRIFT_SLOPE_MINUTES` |

#### 29. packages/api/src/server/flow-control.test.ts (Create)

- **Type / Scope**: Unit test of entry 28 (100% lines and branches), commit 7.
- **Proposed Changes**: Cases: "builds a document that the contract schema accepts for both groups"; "leaves out the newest total bucket while the net drift session is open and keeps it after 16:20"; "ignores rows of another filter profile"; "starts the cumulative lines at 09:30 New York and derives longer as total minus zero_dte"; "sets partsStatus partial for the expiry split only and keeps the state"; "sets partsStatus no_data without a settled total bucket"; "uses the primary ticker for the group and marks opposite control of the check ticker as mixed"; "gives no_data with each reason in the stated order" (market_closed, source_unavailable, stale, session_start without a step, gap, session_start); "names the state at the last close, and says that no session is stored when there is none"; "fills since, asOf, the window and the inputs from the last step"; "computes the slope over 15 minutes and null without an earlier point"; "returns the futures side as no_data not_collected and an empty deep trades block"; "agreement is not_comparable with the futures cause"; "cross-check: same direction, opposite direction, too few prints, no window, counts unread ranges and the oldest one"; "nasdaq100 cross-check is not_collected"; "lists net drift freshness per ticker as never, closed, stale and fresh"; "returns the five notes and null for session.event and levels".

#### 30. `packages/api/src/server/flow.ts` (Modify)

- **Type / Scope**: The `flow.*` procedures.
- **Proposed Changes**:
  - Commit 5 (collect handler): `const client = quantData === null ? null : withCallerReserve(quantDataClientFor(quantData), FLOW_QUANTDATA_CALLER_RESERVE)` (line 84); pass this view as `quantData` and to `buildOptionsAnalytics`, so every collector request (net drift, option pages, GEX) keeps the reserve free; pass `elapsedMs: () => clock().getTime() - started`. `/charts` keeps the shared client without the view. The busy answer carries `budget: { quantDataFree: null, quantDataReserve: FLOW_QUANTDATA_CALLER_RESERVE, ibkrRecent: null, ibkrLimit: 6, runSeconds: 0 }`.
  - Commit 7: `export const readFlowControl = async (repositories: Readonly<{ flow: FlowRepository; researchStudies: ResearchStudyRepository | undefined }>, input: FlowControlInput, now: Date): Promise<FlowControl>`. Steps: `group = FLOW_GROUPS[input.group]`; `optionsOpen = flowSessionOpen("options", group.future, now)`; `sessionDate = newYorkClock(optionsOpen ? now : ((await flow.newestNetDriftMinute(group.primaryTicker)) ?? now)).day`; `{ from, to } = optionsSessionRange(sessionDate)`; `netDrift = await flow.readNetDrift({ tickers: [group.primaryTicker, group.checkTicker], from, to })`; `samples` = `flow.latestSamples(symbol)` for `flowSymbolForTicker` of both tickers; for sp500 only: `end = optionsOpen ? now : to`, `crossPrints = (await flow.readWindow({ symbol: "ES", from: new Date(end.getTime() − (FLOW_CONTROL_RULES.windowMinutes + 10) × 60 000), to: end })).prints` (10 minutes more than the window, because the fold window ends before `now`; entry 28 filters to the exact window) and `crossGaps = await flow.optionGaps("ES")`; for nasdaq100 both are null; `study = await readFlowStudy(researchStudies)`; return `buildFlowControl(...)`.
  - Commit 7: `const readFlowStudy`: `researchStudies?.get(FLOW_CONTROL_STUDY_ID)`. No repository, no record, a `summary` that fails `ResearchStudyDocumentSchema.safeParse`, or a kind other than `strategy-backtest` gives `{ status: "not_tested", testedOn: null, rulesVersion: null }`. Else `status = verdict`, `testedOn = ran`, `rulesVersion = rules.find((entry) => entry.item === FLOW_CONTROL_STUDY_RULES_ITEM)?.rule ?? null`.
  - Commit 7: handler `control = api.flow.control.use(requireOperator)`: `repositoryFor(context, failures)` for the flow repository, `context.repositories.researchStudies` for the studies; it calls `readFlowControl({ flow, researchStudies }, input, clock())`; any thrown error maps to `STORAGE_ERROR`, as `snapshot` does (lines 163-173). `flowRouter = { collect, control, snapshot }`.

#### 31. `packages/api/src/server/flow.test.ts` (Modify)

- **Type / Scope**: Unit test of the procedures.
- **Proposed Changes**: Commit 2: `fakeRepository` (lines 62-80) gains `upsertNetDrift`, `readNetDrift` and `newestNetDriftMinute`. Commit 5: update "wires history and QuantData into the collector" (the reserve view reaches the collector and `buildOptionsAnalytics`, budget) and "answers busy while another collect run is active" (zero budget). Commit 7, new cases: "flow.control returns the document for a group"; "flow.control fails with STORAGE_ERROR without a flow repository and on a repository failure"; "reads the last stored session when the market is closed and today's date when nothing is stored"; "study is not_tested without a repository, without a record, for a malformed document and for another kind"; "maps verdict, run date and the Rules version entry of a stored study"; "rules version is null when the entry is missing"; "reads prints and gaps only for sp500, for the window plus 10 minutes".

#### 32. `packages/api/src/server/operator-access.ts` (Modify)

- **Type / Scope**: Read-key allow list.
- **Proposed Changes**: Commit 7: add `"flow.control"` after `"flow.snapshot"` (line 76) in `AGENT_API_KEY_READ_PROCEDURES`, so an agent read key can read the document.

#### 33. `packages/api/src/server/handler.ts` (Modify)

- **Type / Scope**: Key-procedure allow list.
- **Proposed Changes**: Commit 7: add `"flow.control"` after `"flow.snapshot"` (line 63) in `AGENT_API_KEY_PROCEDURE_PATHS`; add `flow.control` after `flow.snapshot` in the message text at line 104; extend the comment at lines 36-37 ("research agents read flow.snapshot and flow.control with a read key").

#### 34. `packages/api/src/agent-api-keys.test.ts` (Modify)

- **Type / Scope**: Unit test of the lists.
- **Proposed Changes**: Commit 7: add `"flow.control"` to the expected list (after line 277) and the assertion that `isAgentApiKeyProcedurePath(["flow", "control"])` is true.

#### 35. `packages/api/src/agent-viewer.test.ts` (Modify)

- **Type / Scope**: Reviewed read list of the viewer role.
- **Proposed Changes**: Commit 7: add `"flow.control"` before `"flow.snapshot"` (line 269) in `REVIEWED_READS`. The procedure is a GET without side effects, so `isAgentViewerReadProcedure` admits it.

#### 36. `packages/api/src/server/mcp.ts` (Modify)

- **Type / Scope**: MCP tool table. No new tool in this pull request.
- **Proposed Changes**: Commit 6: the tool `flow_snapshot` (lines 521-529) takes `input: FlowSnapshotToolInputSchema` in place of `FlowSnapshotInputSchema`; the import at line 33 changes with it. Its name, title and description stay as they are. A comment states: the definition is pinned to the recorded semantic-layer eval; pull request 2 restores `FlowSnapshotInputSchema`, updates the description to four symbols, adds `flow_control` and records the eval again once.

#### 37. `packages/api/src/server/mcp.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: Commit 6, new case "keeps the recorded definition of flow_snapshot": the `listMcpTools()` entry of `flow_snapshot` has `inputSchema.properties.symbol.enum` equal to `["SPY", "ES"]`, the property keys `symbol`, `minutes` in this order, and a description that contains "for SPY or ES". The pinned tool list at lines 60-76 does not change.

#### 38. `packages/api/openapi.json` (Modify)

- **Type / Scope**: Generated artifact.
- **Proposed Changes**: Regenerated with `bun run openapi:generate` (`package.json:66`) in commits 5, 6 and 7. In commits 2, 3 and 4 the command is run too and must leave the file as it is. Never edited by hand.

#### 39. `scripts/flow/tick.ts` (Modify)

- **Type / Scope**: Scheduler client (prints the journal lines).
- **Proposed Changes**: Commit 5: `CollectSchema.json` gains `budget: z.object({ quantDataFree: z.number().nullable(), quantDataReserve: z.number(), ibkrRecent: z.number().nullable(), ibkrLimit: z.number(), runSeconds: z.number() }).optional()` (optional, so the script also works against the previous app after a rollback). After the run lines, when `budget` exists, one line `budget quantdata_free=<quantDataFree> reserve=<quantDataReserve> ibkr=<ibkrRecent>/<ibkrLimit> run=<runSeconds>s`; a null `quantDataFree` prints `quantdata_free=unread`, a null `ibkrRecent` prints `ibkr=unread/6`. The header comment names the budget line.

#### 40. `scripts/flow/tick.test.ts` (Modify)

- **Type / Scope**: Unit test (project `operations`).
- **Proposed Changes**: Commit 5, new cases: "prints one budget line after the run lines"; "prints unread for an IBKR window that was not read"; "prints no budget line for an answer without a budget".

#### 41. apps/web/src/features/flow/control-view-model.ts (Create)

- **Type / Scope**: Pure view-model of the control panel (`CONVENTIONS.md:88`), commit 8. Uses `Tone`, `Metric`, `formatNyTime`, `formatAge` and `formatMoney` of the feature.
- **Proposed Changes**:
  - `export type FlowControl` (from `@darkfactory/api`); `export type FlowControlFailure = Readonly<{ code: string; message: string }>`; `export type NetDriftView = "total" | "zero_dte" | "longer"`; `export const NET_DRIFT_VIEWS: readonly Readonly<{ view: NetDriftView; label: string }>[]` with the labels "All expiries", "Same day (0DTE)", "Longer".
  - `export const groupOfSymbol = (symbol: FlowSymbol): FlowGroupId` (registry). `export const controlTitle = (control: FlowControl): string` = `Who is in control: <FLOW_GROUPS[group].label>`.
  - `export const STATE_TONE: Readonly<Record<FlowControlState, Tone>>` = buyers success, sellers destructive, balanced neutral, mixed warning, no_data info.
  - `export type ControlLine = Readonly<{ key: "options" | "futures"; state: string; tone: Tone; text: string; since: string | null; asOf: string | null; ratio: string | null }>`. `export const controlLines = (control: FlowControl, now: Date, refreshMs: number): readonly ControlLine[]` returns two lines, options then futures (design section 7: one futures line, no separate agreement line): options `text` = `label` for a state with data and `<label>: <detail>` for `no_data`; futures `text` = `<futures.label>; <study.agreementDetail>` (for example "Futures: deep trades not collected yet; futures and options agreement is not compared or tested"); `since` = `since <formatNyTime(since)>`; `asOf` = `as of <formatNyTime(asOf)>, <formatAge(seconds)> ago`; `ratio` = `Ratio <r> (enter ratio <e>)` with two decimals; every tone is `neutral` when `controlAgeNotice` is not null. The `agreement` field is not rendered.
  - `export const controlAgeNotice = (control: FlowControl, now: Date, refreshMs: number): string | null` = `Data is <k> min old, refreshing` when `now − generatedAt > 2 × refreshMs`.
  - `export const netDriftSummary = (series: FlowNetDriftSeries, view: NetDriftView): readonly Metric[]`: labels "Net call premium", "Net put premium", "Call minus put", "Slope per minute (15 min)" (the slope only for the view `total`); a null total gives the value "no bucket yet"; when `partsDetail` is set and the view is not `total`, one metric "Expiry split" with `partsDetail`.
  - `export type NetDriftChart = Readonly<{ width: 320; height: 96; call: string; put: string; difference: string; zeroY: number; min: number; max: number }>`. `export const buildNetDriftChart = (series: FlowNetDriftSeries, view: NetDriftView): NetDriftChart`: values per point are the call line, the put line and call − put of the view (points whose view is null are left out); `min` and `max` over the three lines and 0; x = `index / max(1, count − 1) × 320`; y = `4 + (max − value) / (max − min) × 88`, or 48 when `max === min`; a line is the points as `x,y` with one decimal, joined by a space; `zeroY` = the y of 0; without points the three strings are empty and `min`, `max` are 0.
  - `export const crossCheckLine = (control: FlowControl): string` = `control.crossCheck.detail`. `export const studyLine = (control: FlowControl): string` = `study.detail`. `export const controlFreshnessRows = (control: FlowControl): readonly Readonly<{ key: string; text: string; tone: Tone }>[]` = one row per `freshness` entry, text `<instrument> net drift: <state>, last answer <formatNyTime(lastOkAt)>` (`never` state: `<instrument> net drift: never collected`), tone as `FRESHNESS_TONE` of the feature view-model (exported there in this commit).
  - No string in this file may contain a word that the status-language test rejects (checked by `apps/web/src/status-language.test.ts`). The server sentences arrive as data and are not literals in the web source.

#### 42. apps/web/src/features/flow/control-view-model.test.ts (Create)

- **Type / Scope**: Unit test of entry 41 (100% lines and branches), commit 8.
- **Proposed Changes**: Cases: "maps SPY and ES to sp500 and QQQ and NQ to nasdaq100"; "titles the panel by group"; "builds the options line and the one futures line with tone, text, since, as-of and ratio, and no agreement line"; "joins label and detail for a side without data"; "drops the tones and adds the age notice for a document older than two refresh periods"; "summarises the totals per view, says no bucket yet for a missing total and shows the expiry split sentence"; "builds three lines in a 320 by 96 box, a flat line at 48 and empty strings without points"; "passes the cross-check and the study sentence through"; "lists one freshness row per ticker".

#### 43. apps/web/src/components/portal/flow-control-panel.tsx (Create)

- **Type / Scope**: Client component (commit 8); takes only the model inputs.
- **Proposed Changes**: `export const FLOW_SELECT_CLASS = "h-11 rounded-md border border-border bg-background px-2 text-sm"` (moved from `apps/web/src/components/portal/flow-workspace.tsx:80-81`; 44 px high). `export const FlowControlPanel = ({ control, failure, now, refreshMs }: Readonly<{ control: FlowControl | null; failure: FlowControlFailure | null; now: Date; refreshMs: number }>)`. It renders a `Panel` with the title of `controlTitle` and, in this order: two rows (Options, Futures), each a `StatusBadge` with `data-flow-control-side` and `data-flow-control-state` plus the text, since, ratio and as-of strings (the state is text, not colour alone); the age notice; the study line; the cross-check line (below the study line, design section 7); the net drift block; the freshness rows; the notes list. Net drift block: two native `<select>` elements with visible labels "Ticker" and "Expiries" and `FLOW_SELECT_CLASS`; the defaults are the series with the role `primary` and the view `total`, set again when `control.group` changes; the metrics of `netDriftSummary`; an inline `<svg viewBox="0 0 320 96" width="100%" preserveAspectRatio="none" role="img">` with three `<polyline>` elements, a zero line and an `aria-label` `Net drift of <ticker>: call minus put <value>`. Texts without a document: no failure "Loading the control document"; with a failure "Control document failed to load (<code>: <message>). The next automatic refresh retries." With a failure and an earlier document: the document plus "Refresh failed (<code>: <message>). Showing the document of <formatNyTime(generatedAt)>."

#### 44. apps/web/src/components/portal/flow-control-panel.test.tsx (Create)

- **Type / Scope**: Component test of entry 43 (100% lines and branches), commit 8.
- **Proposed Changes**: Cases: "shows the three state lines with their text states and times"; "shows one futures line that joins the not-collected label and the agreement sentence, and no agreement row"; "shows the age notice and neutral badges for an old document"; "shows the study line and the cross-check line"; "starts on the primary ticker and all expiries and switches both"; "goes back to the defaults when the group changes"; "draws the chart and names its current value for assistive technology"; "shows the loading text before the first document"; "shows a failure without a document and with an earlier document".

#### 45. `apps/web/src/components/portal/flow-workspace.tsx` (Modify)

- **Type / Scope**: Page body (commit 8).
- **Proposed Changes**:
  - Header comment (lines 1-4) becomes: "What: /flow page body: the control panel of the selected symbol's index group (flow.control), then one symbol's order flow, options flow, GEX levels, events and short-term factors from flow.snapshot, with per-source freshness and an "as of" stamp. Symbol select (SPY, QQQ, ES, NQ), window select, auto refresh every 60 s and manual refresh. Research only: nothing here places, changes or cancels orders, and a state describes recent flow, never a trade signal."
  - `FlowGateway` gains `readonly control: (input: FlowControlInput) => Promise<FlowControl>`; the browser gateway calls `client.flow.control(input)`.
  - `load` calls the snapshot and `gateway.control({ group: groupOfSymbol(symbol) })` together with `Promise.allSettled`, under the same request counter. New state: `control: FlowControl | null`, `controlFailure: FlowControlFailure | null` and `loadedAt: Date` (set to `new Date()` when a load settles; it is the `now` of the panel, so there is no ticking clock). A rejected control read is converted with `describePortfolioMonitorFailure(error)`: the kind `forbidden` sets the workspace failure as today; else `controlFailure = { code: described.code, message: described.message }` and the earlier document stays. A failed control read does not hide the snapshot. A symbol of another group clears `control`.
  - Render order: controls, `FlowControlPanel`, the paragraph of `notCollectedLine(symbol)` when it is not null, then `SnapshotView`. In `SnapshotView` the order becomes `ConfluencePanel`, `OrderFlowPanel`, `OptionsFlowPanel`, `GexPanel`, `EventsPanel`, `FreshnessPanel`.
  - `ConfluencePanel`: title "Short-term factors (last 15 to 30 min)"; the badge text is `shortTermBadge(confluence)` in place of `confluence.label` (line 175); the count sentence at lines 178-179 stays.
  - `FreshnessPanel`: when no row is `stale` or `never`, one line "All sources fresh as of <time>" with a "Show sources" button; else the open list as today. The toggle is a `Button` with `aria-expanded`, not a `<details>` element.
  - The local `selectClass` is deleted; both selects use `FLOW_SELECT_CLASS` of entry 43.

#### 46. `apps/web/src/components/portal/flow-workspace.test.tsx` (Modify)

- **Type / Scope**: Component test (commit 8).
- **Proposed Changes**: Fake gateways gain `control`. Update "shows every section of a SPY snapshot with its as-of stamp" (new title, badge text, panel order, freshness line). New cases: "shows the control panel first and loads the group of the selected symbol"; "loads nasdaq100 for QQQ and NQ and names what is not collected"; "keeps the snapshot when the control read fails and shows the failure in the panel"; "shows operator access required when the control read is forbidden"; "refreshes the control document on the timer"; "ignores a control answer that a newer request replaced"; "opens the freshness list when a source is stale and on request"; "uses the word agree only in the control panel" (the confluence block has no "agree").

#### 47. `apps/web/src/lab/fixtures/flow.ts` (Modify)

- **Type / Scope**: Dev-lab fixture (TypeScript, no JSON).
- **Proposed Changes**: Commit 6 (the type `Record<FlowSnapshot["symbol"], LabFlowInstrument>` at lines 25-27 needs four keys once `FLOW_SYMBOLS` has four values): `LAB_FLOW_INSTRUMENTS` gains QQQ `{ basis: 0, offExchangeShare: 0.38, price: 612.4, strike: 612, tick: 0.01, ticker: "QQQ" }` and NQ `{ basis: 42.5, offExchangeShare: null, price: 25480.25, strike: 25450, tick: 0.25, ticker: "NDX" }`; the snapshot of QQQ and NQ has no minutes, no prints and freshness rows for depth and gex only. Commit 8: `export const labFlowControl = (group: FlowGroupId): FlowControl`: options `buyers` since 10:31 for sp500 and `mixed` for nasdaq100, the futures side `no_data` with `not_collected`, 120 net drift points per ticker, study `not_tested`. All values are fictional.

#### 48. `apps/web/src/lab/entries/research.tsx` (Modify)

- **Type / Scope**: Dev-lab entry (commit 8).
- **Proposed Changes**: `labFlowGateway` (lines 169-172) gains `control: ({ group }) => Promise.resolve(labFlowControl(group))`.

#### 49. `apps/web/src/lab/entries/research.test.tsx` (Modify)

- **Type / Scope**: Lab test (commit 8).
- **Proposed Changes**: The flow case (line 231) also expects two `[data-flow-control-side]` rows, and it presses "Show sources" before it counts the four `[data-flow-source]` rows.

#### 50. `docs/vertex-rebuild/flow-pipeline.md` (Modify)

- **Type / Scope**: The pipeline doc; each part is committed with the code it describes.
- **Proposed Changes**:
  - "Deploy" (commit 2), the full step list for this pull request: pause `vertex-flow.timer`; apply the 0077 file alone with `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container; check `flow_net_drift`, its grants and one replaced check; deploy the app; re-run `infra/flow/quantvps/install.sh` (new tick script); run `bun run vertex:flow:tick --dry-run`; start the timer. Rollback: deploy the previous app; the down script is not the rollback path and needs the QQQ, NQ and `net_drift` rows deleted first.
  - New section "Retention" after "Freshness" (commit 2): 730 days for `flow_net_drift`, 14 days for every other flow table, `flow_minutes` included; the previous app does not prune `flow_net_drift`, so a rollback deletes no row.
  - "Options paging and gaps" and "Terms" (commit 5): the caller reserve `FLOW_QUANTDATA_CALLER_RESERVE = 6` in the shared QuantData client and why (6 of 30 starts per 60 s stay free for `/charts`, across runs), the free-start check before each source, one GEX estimate per run, the budget journal line, storage errors as samples.
  - "What it does" (commit 6): four symbols, the registry table and the group table, the `net_drift` source row (vendor endpoint, table, one cadence rule: sp500 on even and nasdaq100 on odd minutes, so every 120 s per ticker).
  - New section "Net drift" after "Features and events" (commit 6): the two requests, the filter profile `otm-clean.v1`, the write rule, no stored sums, the sample messages, stale after 300 s, the worst case of 23 requests per run against 30 minus the reserve of 6.
  - "IBKR budget" (commit 6): the IBKR share of ES and SPY does not change; NQ and QQQ send no tick request in this pull request.
  - "Freshness" (commit 6): the `net_drift` value; snapshot freshness lists collected sources only.
  - "Agent semantic layer" (commit 6): the tool `flow_snapshot` stays pinned to SPY and ES until pull request 2 records the eval again.
  - New section "Control document" after "Confluence" (commit 7): `flow.control`, the rules table, the fold with settled buckets, the eight no-data reasons in priority order, the parts status of each series, the agreement as `not_comparable` only, the futures side as `not_collected`, read keys, and the measured time of one `flow.control` call after the deploy (see "Verification").
  - "Confluence" (commit 8): the new title and badge text; "agree" is used for futures against options only.
  - No generated doc changes: `docs/generated/package-graph.md` depends on package roles only, and no package is added.

#### 51. `packages/api/src/options-analytics.test.ts` (Modify)

- **Type / Scope**: Unit test of the shared client (`describe("quantdata client")`, line 130) and of the analytics engine (commit 5).
- **Proposed Changes**: The fake client at lines 792-800 gains `freeStarts: () => 30`. New cases in `describe("quantdata client")`: "keeps free the starts that the caller reserve asks for and answers reserved" (a client with 30 per minute, `keepFree` 6: the 25th start in 60 s is `reserved`, a start without `keepFree` still runs); "answers rate_limited, not reserved, when the window is full"; "serves a cached body to a reserving caller without a start"; "counts free starts over the sliding 60 s"; "withCallerReserve forwards the reserve, shares the window and lowers freeStarts by the reserve"; "holds keepFree to 0 and the window minus 1". These cover the new branches of entry 22 (`bun run verify:coverage`: no drop).

#### 52. `packages/api/src/options-chain-quantdata.test.ts` (Modify)

- **Type / Scope**: Unit test (commit 5).
- **Proposed Changes**: The fake client at lines 105-110 gains `freeStarts: () => 30`, so it still implements `QuantDataClient`. No case changes.

#### Commit order

Each commit, checked out by itself, passes `bun run check` and its focused tests, and holds its tests, generated artifacts and docs. The split was not compiled (this plan changes no code); the table "Tuple values per commit" and the notes below state why each commit typechecks.

1. `refactor(flow): move per-symbol facts into the instrument registry`: the commit 1 parts of entries 1, 2, 3, 5, 7 and 8. Structure only: no expectation in a test changes.
2. `feat(db): flow_net_drift table, wider flow checks and per-table prune (0077)`: entries 10 to 19, the retention part of entry 3 with entry 4, the fakes of entries 4 and 31, the comment of entry 20, the "Deploy" and "Retention" parts of entry 50. The exported `*Value` types stay narrow, so the API still typechecks against the repository rows.
3. `feat(api): QuantData net drift endpoint and mapper`: the commit 3 part of entry 22, entries 23, 24, the commit 3 parts of entries 20 and 27.
4. `feat(api): control rules with golden vectors`: entries 25 and 26, the commit 4 parts of entries 1, 7, 20 and 27.
5. `feat(flow): storage-error isolation and a caller reserve for collector QuantData calls`: the commit 5 parts of entries 3, 4, 20, 21, 22, 30, 31, 50; entries 39, 40, 51 and 52; entry 38 regenerated. Order inside the commit: entry 22 and its tests (entries 51, 52) first, then the collector.
6. `feat(flow): QQQ, NQ and the net_drift source`: the commit 6 parts of entries 1 to 6, 10, 15, 16, 17, 20, 21, 23, 47 and 50; entries 36 and 37; entry 38 regenerated. The three contract tuples and the three schema types widen together here, with every record keyed by them (`FLOW_INSTRUMENTS`, `FLOW_DUE_SECONDS`, `FLOW_STALE_SECONDS`, `COLLECTORS`, `LAB_FLOW_INSTRUMENTS`).
7. `feat(api): flow.control procedure`: the commit 7 parts of entries 20, 21, 30, 31 and 50; entries 28, 29, 32 to 35; entry 38 regenerated. Order inside the commit: contract, failing tests, implementation.
8. `feat(web): control panel, QQQ and NQ on /flow`: the commit 8 parts of entries 8, 9, 47 and 50; entries 41 to 46, 48 and 49.

#### Verification

- `pnpm exec vitest run packages/api/src/flow-features.test.ts packages/api/src/server/flow-collect.test.ts packages/api/src/server/flow-snapshot.test.ts apps/web/src/features/flow/view-model.test.ts` after commit 1. Pass: all four files pass with no expectation edited.
- The generate command of entry 11, run a second time after commit 2. Expected output: `No schema changes`. Then `pnpm exec vitest run packages/db/src/server/flow-migration.test.ts packages/db/src/server/migration-journal.test.ts packages/db/src/server/flow.test.ts`: SQL, rollback, journal order, snapshot against schema, repository queries.
- `bun run test:integration` (needs `bun run db:test:up`): every migration applies to an empty database, `flow_net_drift` has the listed key, and `tests/integration/semantic-layer/eval-replay.test.ts` passes with the unchanged recording (`git diff --stat` shows no change in `tests/integration/semantic-layer/eval-recording.fixture.json`).
- `pnpm exec vitest run packages/api/src/flow-control.contract.test.ts packages/api/src/flow-control-rules.test.ts packages/api/src/flow-net-drift.test.ts packages/api/src/server/flow-control.test.ts packages/api/src/server/flow.test.ts`: contract bounds, the golden vectors, the two vendor bodies and the document.
- `pnpm exec vitest run packages/api/src/agent-api-keys.test.ts packages/api/src/agent-viewer.test.ts packages/api/src/server/mcp.test.ts`: the read key and the viewer list include `flow.control`; the tool list and the `flow_snapshot` definition are as recorded.
- `bun run openapi:generate`, then `bun run openapi:check`, in every commit that changes entry 20: the artifact matches the contract.
- `pnpm exec vitest run scripts/flow/tick.test.ts`: the budget line.
- `pnpm exec vitest run packages/api/src/options-analytics.test.ts packages/api/src/options-chain-quantdata.test.ts`: the caller reserve of the shared client and the fakes with `freeStarts`.
- `pnpm exec vitest run apps/web/src/features/flow apps/web/src/components/portal/flow-control-panel.test.tsx apps/web/src/components/portal/flow-workspace.test.tsx apps/web/src/lab/entries/research.test.tsx`: the page and the lab entry.
- `pnpm exec vitest run apps/web/src/status-language.test.ts`. Pass: the test passes while `apps/web/src/status-language-allowlist.ts` is not changed and `MAX_OPEN` stays 208.
- `bun run test:json-data`: the fixture is the only new JSON data name and it is in the fixture class.
- `bun run check`: format, Biome (import cycles, no `any`), markdownlint, knip and typecheck.
- `bun run docs:check`: every backticked path in the changed docs exists.
- `bun run verify:coverage`: 100% lines and branches for the new source files (entries 23, 25, 28, 41, 43) and no drop elsewhere (no flow file is in `scripts/ci/coverage-baseline.json`).
- `bun run verify:prepush` before the push; then the eight required checks on the pull request.
- Page gate (accepted as manual): the panel in the dev lab at 375 px (no sideways scroll, 44 px targets, each state readable without colour), and after the deploy one dark screenshot of `/flow` at 375 px and one at desktop width. No Playwright spec is added: the panel needs stored net drift rows, which the E2E database does not have, and the unit tests of entries 42, 44 and 46 cover the rendering.
- Performance gate (manual): one timed `flow.control` call per group on the trading server after the deploy; the target is under 300 ms; the measured times are written into the "Control document" section of entry 50.
