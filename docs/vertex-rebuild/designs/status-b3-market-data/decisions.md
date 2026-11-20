# Status batch 3: row decisions

The final text for each row of [rows.md](rows.md), by the rules of [plan.md](plan.md). `<name>` is a placeholder. Line numbers are from the worktree at commit `0dfbf071`.

## Area A: route error pages and sign-in

### Files

- Create `apps/web/src/components/status-time.ts`
- Create `apps/web/src/components/status-time.test.ts`
- Modify `apps/web/src/components/route-error-state.tsx` (title time from `utcClock`)
- Modify `apps/web/src/app/(portal)/calendar/error.tsx`
- Modify `apps/web/src/app/(portal)/charts/error.tsx`
- Modify `apps/web/src/app/(portal)/congress-trades/error.tsx`
- Modify `apps/web/src/app/(portal)/flow/error.tsx`
- Modify `apps/web/src/app/(portal)/markets/error.tsx`
- Modify `apps/web/src/app/(portal)/news/error.tsx`
- Modify `apps/web/src/app/(portal)/rotation-matrix/error.tsx`
- Modify `apps/web/src/app/(portal)/sector-rotation/error.tsx`
- Modify `apps/web/src/app/(portal)/calendar/route-files.test.tsx`, and the same file in `congress-trades`, `flow`, `markets`, `news`, `rotation-matrix`, `sector-rotation`
- Create `apps/web/src/app/(portal)/charts/error.test.tsx`
- Modify `apps/web/src/components/auth/auth-flow.ts`
- Modify `apps/web/src/components/auth/auth-flow.test.ts`
- Modify `tests/integration/auth/auth.test.ts` (the suspended-account test gains the order assertions; it runs the real `/sign-in/email` handler against the test database)
- Modify `apps/web/src/components/route-error-state.test.tsx` only if an assertion changes (the title keeps its form: `routeErrorText` calls `utcClock(at, at)`)
- Create `docs/vertex-rebuild/designs/status-b3-market-data/plan.md`, `rows.md`, `decisions.md`, `overview.svg`, `overview.png`

### Rows

Each error page renders `<RouteErrorState error={error} page="<page>" reset={reset} safety="<safety>" />`. `RouteErrorState` builds the title `<page> failed to render at <utcClock(at)>` (`at` = the time the boundary rendered), the cause sentence from `routeErrorCause(error)`, `Reference: <error.digest>` when the digest exists, the safety sentence and the Try again action. Each safety sentence is `No data was changed.`, as today: a render failure sends no request that writes.

| ID | File and function | Final text or template | Source of each placeholder | Test file |
| --- | --- | --- | --- | --- |
| A1 | `calendar/error.tsx` `CalendarError` | `Calendar failed to render at <HH:MM UTC>` | `at` in `RouteErrorState` | `calendar/route-files.test.tsx` |
| A2 | `charts/error.tsx` `ChartsError` | `Charts failed to render at <HH:MM UTC>` | same | `charts/error.test.tsx` |
| A3 | `congress-trades/error.tsx` | `Congress trades failed to render at <HH:MM UTC>` | same | `congress-trades/route-files.test.tsx` |
| A4 | `flow/error.tsx` `FlowError` | `Flow failed to render at <HH:MM UTC>` | same | `flow/route-files.test.tsx` |
| A5 | `markets/error.tsx` | `Market context failed to render at <HH:MM UTC>` | same | `markets/route-files.test.tsx` |
| A6 | `news/error.tsx` | `News monitor failed to render at <HH:MM UTC>` | same | `news/route-files.test.tsx` |
| A7 | `rotation-matrix/error.tsx` | `Rotation matrix failed to render at <HH:MM UTC>` | same | `rotation-matrix/route-files.test.tsx` |
| A8 | `sector-rotation/error.tsx` | `Sector rotation failed to render at <HH:MM UTC>` | same | `sector-rotation/route-files.test.tsx` |
| A9 | `components/auth/auth-flow.ts`, the sign-in error mapping | `This account is suspended. Contact the project administrator.` for `ACCOUNT_SUSPENDED`; `This account is deactivated. Contact the project administrator.` for `ACCOUNT_DEACTIVATED` | `error.code` | `components/auth/auth-flow.test.ts`; the order assertions in `tests/integration/auth/auth.test.ts` |

### Notes

- `utcClock(time, now = new Date())`: `HH:MM UTC` when `time` is on the UTC day of `now`, else `YYYY-MM-DD HH:MM UTC`. `loadFailedLabel(failedAt)`: `Load failed <utcClock(failedAt)>`. `statusTime(time, now)`: the same for ISO text, epoch milliseconds or a Date; `time not reported by source` for null, empty or unreadable input. In areas C, D and E a time that comes as text is formatted with `statusTime`.
- A9: the order assertions are in `tests/integration/auth/auth.test.ts`: after the account is suspended, a sign-in with a wrong password returns status 401 and code `INVALID_EMAIL_OR_PASSWORD`, and its status and body equal those of a sign-in for an email with no account. Result on 2026-11-19: green, so the text is split.
- Allow list: the nine open entries of this area go (eight `<Page> unavailable` titles and the `auth-flow.ts` text); `MAX_OPEN` falls by 9.

## Area B: flow, GEX, IV, options (rows B1-B35)

Prefixes: API = `packages/api/src`, WEB = `apps/web/src`. Line numbers are of the worktree head. `<t>` in an API text is `HH:MM UTC`, with the date in front when it is not the UTC day of `now` (rule 1).

### Files

- Modify `apps/web/src/components/portal/flow-workspace.tsx`
- Modify `apps/web/src/components/portal/flow-workspace.test.tsx`
- Modify `apps/web/src/components/portal/options-analytics-panel.tsx`
- Modify `apps/web/src/components/portal/options-analytics-panel.test.tsx`
- Modify `apps/web/src/features/flow/control-view-model.ts`
- Modify `apps/web/src/features/flow/control-view-model.test.ts`
- Modify `apps/web/src/features/flow/format.ts`
- Modify `apps/web/src/features/flow/format.test.ts`
- Modify `apps/web/src/features/flow/view-model.ts`
- Modify `apps/web/src/features/flow/view-model.test.ts`
- Modify `apps/web/src/features/stock-detail/options-chain-table.tsx`
- Modify `apps/web/src/features/stock-detail/options-chain-table.test.tsx`
- Modify `apps/web/src/lab/fixtures/market.ts`
- Modify `apps/web/src/status-language-allowlist.ts`
- Modify `apps/web/src/status-language.test.ts`
- Modify `packages/api/openapi.json`
- Modify `packages/api/src/contracts/flow.ts`
- Modify `packages/api/src/contracts/options-analytics.ts`
- Modify `packages/api/src/contracts/options-chain.ts`
- Modify `packages/api/src/flow-options.ts`
- Modify `packages/api/src/flow-options.test.ts`
- Modify `packages/api/src/gex-context.test.ts`
- Modify `packages/api/src/options-analytics.test.ts`
- Modify `packages/api/src/options-chain.test.ts`
- Modify `packages/api/src/server/flow.ts`
- Modify `packages/api/src/server/flow.test.ts`
- Modify `packages/api/src/server/flow-collect.ts`
- Modify `packages/api/src/server/flow-collect.test.ts`
- Modify `packages/api/src/server/flow-control.test.ts`
- Modify `packages/api/src/server/flow-snapshot.ts`
- Modify `packages/api/src/server/flow-snapshot.test.ts`
- Modify `packages/api/src/server/gex-context.ts`
- Modify `packages/api/src/server/options-chain.ts`
- Modify `tests/e2e/helpers/options-snapshot.ts`

No file is created. `packages/db` does not change (rule 9). Not modified: `apps/web/src/components/portal/flow-control-panel.tsx` (its `formatMoney` arguments are never null; it compiles with the new default parameter), `apps/web/src/lab/fixtures/flow.ts` (imports `formatSigned` only), `packages/api/src/server/mcp.ts` (no description names an old value: the only quoted `unknown` is at :508, in another tool), and the `TradeSide` files (B17 kept).

### Rows

| ID | File and function | Final text or template | Source of each placeholder | Test file |
| --- | --- | --- | --- | --- |
| B1 | WEB/components/portal/flow-workspace.tsx, `FlowWorkspace` alert (:679-685) and `load` (:581) | Badge: `Load failed <HH:MM UTC>`. Body, no snapshot: `Flow snapshot not loaded: <message> · retrying every <N> s`. Body, with snapshot: `Refresh failed: <message> · showing the snapshot as of <asOf> · retrying every <N> s` | badge = `loadFailedLabel(failure.failedAt)`; new field `failedAt: number` on the `error` variant of `Failure`, set to `Date.now()` in `load`; `<message>` = `failure.message`; `<N>` = `Math.round(refreshMs / 1000)`; `<asOf>` = `formatNyDateTime(snapshot.windowEnd)` (existing) | WEB/components/portal/flow-workspace.test.tsx |
| B2 | WEB/components/portal/options-analytics-panel.tsx; the constant `DASH` is deleted; each use gets its own text and a `title` | (a) `pct(null)`: `no IV`, title `QuantData sent no IV for this point`. (b) `pct(undefined)` (:221, no skew point): `no contract`, title `No contract at this delta for this expiry`. (c) `money(null)` for `section.totalGex` and `row.gex`: `not computed`, title `GEX needs option-chain IV and a spot price`. (d) max pain null: `no open interest`. (e) GEX expiry null: `no IV expiry`. (f) level null: `not computed` when `section.totalGex === null`; else flip `no zero crossing`, call wall `no positive GEX`, put wall `no negative GEX`. (g) flow type null: `type not sent`. (h) header: `· spot not received from QuantData · received <HH:MM:SS> UTC` | `value` argument of `pct`/`money`; `section.totalGex`, `section.maxPain`, `section.gexExpiry` (`Exposure` :285); `context.levels.*`; `event.flowType`; `state.data.spot`, `state.data.receivedAt.slice(11, 19)` (existing) | WEB/components/portal/options-analytics-panel.test.tsx |
| B3 | WEB/features/flow/format.ts: export `MISSING` is deleted; every formatter gets a second parameter `missing: string = NO_VALUE` with `NO_VALUE = "no value"`; `formatNyTime` and `formatNyDateTime` return `unreadable time`. WEB/features/flow/view-model.ts and control-view-model.ts pass the reason at each call that can be null | `lastOk` (:119): `never`. `coverageText` (:161): `no window yet`. `pressureText` (:192): `no book data`. Delta ratio, VWAP, last price, off-exchange share (:171-180): `no trades in window`. Best bid / ask (:202, :206): `no bid` / `no ask`. Put/call ratio (:221): `no call premium`. OTM, 0DTE, opening share (:237-239): `no option premium`. Print price (:284): `price not sent`. GEX level, underlying (:331): `no level`; symbol price (:330): `basis not computed` when `gex.symbolLevels === null`, else `no level`. Total GEX, Net DEX (:336-337): `not computed`. GEX 0DTE share (:338): `no flow premium`. Spot (:340): `spot not received`. control-view-model.ts:140 slope null: `too few buckets`. flow-control-panel.tsx:420 and control-view-model.ts:75, :94, :234 with a timestamp that does not parse: `unreadable time` | the null field at each call site (`row.lastOkAt`, `windowSeconds`, `pressure`, `orderFlow.*`, `book.*`, `options.*`, `print.price`, `gex.*`, `series.slopeUsdPerMinute`: null when no bucket lies `slopeWindowMinutes` before the last one, API/server/flow-control.ts:399) | WEB/features/flow/format.test.ts, WEB/features/flow/view-model.test.ts, WEB/features/flow/control-view-model.test.ts |
| B4 | WEB/features/flow/view-model.ts, `SIDE_LABELS` (:242) and the print row (:287); new row field `sideTitle: string or null`; cell at flow-workspace.tsx:424 gets `title` | Key `not_classified`: cell `not classified`, title `QuantData sent no side code for this print, or a code that this version does not map`. No label: `enumLabel` fallback (rule 11) | `enumLabel(SIDE_LABELS, print.side)` | WEB/features/flow/view-model.test.ts |
| B5 | WEB/features/flow/view-model.ts, `GEX_REGIME_LABELS` (:296) becomes a `Partial` record with the keys `positive`, `negative`, `no_data`; `gexMetrics` (:335); `Metric` gets `title?: string`, rendered on the `dd` at flow-workspace.tsx:109 | `no_data` (guard value of the read mapping): `no GEX estimate`, title `The stored GEX row of <at> has no positive or negative regime`. `zero` has no producer on the flow page and no label; it and any other value show the `enumLabel` fallback (rule 11) | `enumLabel(GEX_REGIME_LABELS, gex.regime)`; `<at>` = `utcClock(gex.at)` | WEB/features/flow/view-model.test.ts (`no_data` label and the fallback) |
| B6 | WEB/features/flow/view-model.ts, `IV_REGIME_LABELS` (:302), `gexMetrics` (:339) | `no_term_data`: `under two IV expiries`, title `Fewer than two expiries had an ATM IV in the <at> GEX sample; front and back IV are not stored`. No label: `enumLabel` fallback (rule 11) | `enumLabel(IV_REGIME_LABELS, gex.ivRegime)`; `<at>` = `utcClock(gex.at)` | WEB/features/flow/view-model.test.ts |
| B7 | WEB/features/flow/view-model.ts, `basisNote` (:349) | `Levels come from <ticker> options and are shown in <ticker> price only: the <symbol> − <ticker> basis was not computed for the <at> GEX sample (no <symbol> price or no <ticker> spot in that collector run) · the next GEX sample computes it again` | `gex.ticker`, `symbol`, `<at>` = `utcClock(gex.at)`. Which of the two prices was missing is not in the snapshot; the text names both | WEB/features/flow/view-model.test.ts |
| B8 | WEB/features/stock-detail/options-chain-table.tsx; `DASH` is deleted; `formatCell` (:65) returns the reason; new `cellTitle(contract, key): string or undefined` sets `title` on the `td` (:169) | `contract === null`: `no contract`, title `No contract listed at this strike`. bid, ask null: `no quote`. last null: `no trade`. volume null: `no volume`. open interest null: `no OI`, title `Open interest not sent by the source`. iv null: `no IV`, title `IV not computed by the source`. delta, theta, vega, rho null: `no greeks`, title `Greeks not sent by the source` | `contract`, `key`, `contract[key]`, `contract.iv`, `contract.greeks?.[key]` | WEB/features/stock-detail/options-chain-table.test.tsx |
| B9 | API/contracts/flow.ts, `FLOW_OPTION_SIDES` (:54) | Value `not_classified` replaces `unknown` | - | API/server/flow-snapshot.test.ts |
| B10 | API/contracts/flow.ts, `FLOW_VOTES` (:74); WEB/features/flow/view-model.ts `VOTE_TONE` (:141) and new `VOTE_LABELS`; badge at flow-workspace.tsx:229 shows the label | Values `no_data`, `context` replace `unknown`. Tones: `no_data` info, `context` neutral, no tone found: info. Labels: `bullish`, `bearish`, `neutral`, `no data`, `context`. No label: `enumLabel` fallback (rule 11) | `enumLabel(VOTE_LABELS, factor.vote)` | API/server/flow-snapshot.test.ts, WEB/features/flow/view-model.test.ts, WEB/components/portal/flow-workspace.test.tsx |
| B11 | API/contracts/flow.ts `STORAGE_ERROR` (:467); API/server/flow.ts `repositoryFor` (:88), `snapshot` (:216), `control` (:386) | Contract default: `Flow storage request failed; retry`. :88: `Flow storage is not configured on this server; ask the operator`. :216 and :386, `DatabasePersistenceError`: `Flow storage: database request failed; retry`. :216 and :386, any other error: `Flow storage request failed inside the API (unexpected error); retry, and report it if it repeats` | the caught error (`catch (error)` replaces `catch {}`); `error instanceof DatabasePersistenceError` | API/server/flow.test.ts |
| B12 | API/contracts/options-analytics.ts, `GEX_REGIMES` (:159) | Values `no_data`, `zero` replace `unknown` | - | API/gex-context.test.ts |
| B13 | API/contracts/options-analytics.ts, `GEX_FLOW_BIASES` (:160) | Values `no_signed_flow`, `not_received` replace `unknown` | - | API/gex-context.test.ts |
| B14 | API/contracts/options-analytics.ts, `IV_TERM_REGIMES` (:166) | Value `no_term_data` replaces `unknown` | - | API/gex-context.test.ts |
| B15 | API/contracts/options-chain.ts, `UNAVAILABLE` (:213) | Contract default: `Options data source request failed; retry`. The error code `UNAVAILABLE` is kept: it is a machine code that clients match, not a shown text | - | API/options-chain.test.ts (new assertion on the default message of `UNAVAILABLE` in the contract error map; every throw site passes its own message) |
| B16 | API/flow-options.ts, `parseOptionPrints` (:178); `optionEvents` (:203, see Notes 7) | Kept: the literal `"unknown"` stays; it is the word stored in `flow_option_prints.side` (rule 9) and this is the one write-side place for the side. The type of `FlowOptionPrintRow.side` and of `SIDES` becomes the new exported type `StoredOptionSide` (the five side words or `"unknown"`). The response maps it (B9, Notes 1) | `row.tradeSideCode` | API/flow-options.test.ts: the existing assertions of the stored word `unknown` for an unmapped side code stay (:120, :190) and are the collector test of rule 9 for the side |
| B17 | API/flow-trade-signing.ts, `TradeSide` (:12), `signTrades` (:98) | Kept, no change: the value `unknown` and the key `counts.unknown` stay. Reason (plan, Area B): the web already shows it as `Unsigned (no usable quote or earlier price)` (order-flow-views.tsx:82), and a rename would change a response key with no change for the user | - | none (existing tests stay as they are) |
| B18 | API/server/flow-collect.ts, `ticksBlocked` (:258) | `IBKR history health check failed (no pacing data); tick sample skipped, retry next run` | `pacing === null`. `historyPacing` drops the error, so no error text is added | API/server/flow-collect.test.ts, API/server/flow.test.ts |
| B19 | API/server/flow-collect.ts, `collectGex` (:819-823 and :836) | Condition becomes `exposure.status !== "ok" or (context.regime !== "positive" and context.regime !== "negative")`; its result is the same as today. Message: `exposure.message` when it is set; else `Not stored: net GEX is exactly 0 (no sign)` (the only case without a message: options-analytics.ts:131-136 sets one for every other case). At :836 the stored word is `context.iv.regime === "no_term_data" ? "unknown" : context.iv.regime` (rule 9, the one write-side place for iv_regime) | `exposure.message`, `context.regime`, `context.iv.regime` | API/server/flow-collect.test.ts: the new message, and that the row passed to `insertGex` has `ivRegime: "unknown"` when the context has `no_term_data` |
| B20 | API/server/flow-collect.ts, `gexBasis` (:796) returns `{ basis: number } or { basis: null; reason: string }`; message at :853 | `<regime> gamma` when the basis exists. `<regime> gamma; basis not computed: no <symbol> price in this run` when `state.prices.get(instrument.symbol) === undefined`. `<regime> gamma; basis not computed: QuantData sent no <ticker> spot` when the price exists and `output.spot === null`. When both are missing the price message wins (it is checked first, the order of the code today) | `context.regime`, `instrument.symbol`, `instrument.optionsTicker`, `state.prices`, `output.spot` | API/server/flow-collect.test.ts (three cases: price missing, spot missing, both) |
| B21 | API/server/flow-snapshot.ts, `vote` (:185) | Returns `no_data` for a null value. `known` (:281) counts votes that are `bullish`, `bearish` or `neutral` | `value` | API/server/flow-snapshot.test.ts |
| B22 | API/server/flow-snapshot.ts, `pct` (:192) keeps numbers only; new `noVoteValue(source, input)` gives the factor `value` in `buildConfluence` (:249, :257, :265). `ConfluenceInput` gets `symbol: FlowSymbol`, `now: Date`, `freshness: readonly FlowFreshness[]` | (a) no freshness entry of the source: `No vote: not collected for <symbol>`. (b) state `never`: `No vote: never collected`. (c) state `stale`, `lastStatus === "unavailable"`: `No vote: source failed; last good <t>`. (d) state `stale`, other status: `No vote: sample stale; last good <t>`. (e) source usable, value null: order flow `No vote: no trades in last 15 min`; book `No vote: no book sizes in newest snapshot`; options flow `No vote: no signed premium in last 30 min`. For (a)-(e) the `detail` is the existing sentence plus `The freshness table shows the last collector message; the next collector run retries.` | source of the factor: order flow = `ticks`, book = `depth`, options flow = `options`; `<symbol>` = `input.symbol`; entry = `input.freshness.find(source)`; `entry.state`, `entry.lastStatus`; `<t>` from `entry.lastOkAt` and `input.now` (local UTC formatter, rule 5) | API/server/flow-snapshot.test.ts |
| B23 | API/server/flow-snapshot.ts, `gexFactorValue` (:216) | (a) no freshness entry for `gex`: `Not collected for <symbol>`. (b) `gex === null`: `No GEX stored yet`. (c) regime after the read mapping is `no_data` (guard; no producer today): `Not computed: no GEX estimate`. (d) not usable: `Stale since <t>; last: <regime> gamma`. Positive and negative texts do not change. There is no text for a stored zero | `input.gex`, `usable.gex`, `input.freshness`, `input.symbol`; `<t>` from `gex.at` and `input.now`; `<regime>` = mapped `gex.regime` (positive or negative in (d)) | API/server/flow-snapshot.test.ts (cases a, b, d; one guard test for c) |
| B24 | API/server/flow-snapshot.ts, `buildConfluence` GEX factor (:275) | `vote: "context"`; web label `context` (B10) | - | API/server/flow-snapshot.test.ts |
| B25 | API/server/gex-context.ts, `flowBias` (:175); `buildGexContext` (:660) | `flowBias` returns `no_signed_flow` when `signed === 0`. `buildGexContext` sets `flow.bias` to `not_received` when `input.flowOk` is false | `bullish + bearish`, `input.flowOk` | API/gex-context.test.ts |
| B26 | API/server/gex-context.ts, `ivContext` (:224) | Returns `regime: "no_term_data"` | `front`, `back` | API/gex-context.test.ts |
| B27 | API/server/gex-context.ts, `flowFactor` (:423-430), tone alert in both cases | `not_received`: value `Not received: QuantData flow request failed`; detail `The QuantData option-flow request for the last <h> h failed; the next load of this page retries it. Without flow, a GEX level says where hedging changes, not which way price goes.` `no_signed_flow`: value `No signed flow in last <h> h`; detail `QuantData returned <n> trades for the last <h> h and none has a bullish or bearish sentiment. Without flow, a GEX level says where hedging changes, not which way price goes.` | `flow.bias`; `<h>` = `input.flowHours`; `<n>` = `input.events.length` | API/gex-context.test.ts |
| B28 | API/server/gex-context.ts, `REGIME_VALUES` (:456), `regimeFactor` (:462), tone alert for both new values | `no_data`: value `Not computed: no GEX estimate`; detail starts `No net GEX: open interest, option-chain IV or the spot price was not received from QuantData (the exposure message names which).`. `zero`: value `Not computed: net GEX is 0`; detail starts `Net GEX over the strikes within 50-150% of spot is exactly 0, so it has no sign.`. Both then continue with the existing detail sentence | `regime` | API/gex-context.test.ts |
| B29 | API/server/gex-context.ts, `shareText` (:495) is deleted; `expiryFactor` detail (:507) | Last sentence of the detail. Flow request failed: `Flow request failed, so there is no 0DTE or 7-day flow share.` No premium: `No flow premium in the <h> h window, so there is no 0DTE or 7-day flow share.` With premium: the existing sentence with two percent values. The first sentence changes `is unknown` to `is not reported by the source` | `input.flowOk`; `flow.zeroDteShare === null`; `<h>` = `input.flowHours` | API/gex-context.test.ts |
| B30 | API/server/gex-context.ts, `greekFactors` (:523) gets a new parameter `cause: string`; `dealerContext` (:354) returns it as `greeksCause: string or null`; DEX value (:532) | Value `Not computed: <cause>`; detail starts `Not computed: <cause>.` and continues with the existing sentence. `<cause>`, first match: `no spot price` (`spot` null or not above 0); `no strike open interest` (`strikes.length === 0`); `no option chain rows` (`gammaModel` null: the chain has no expiry); `no front ATM IV` (`model.atmIv === null`); `no strike could be priced` (`dealerTotals` null with valid spot and strikes). The three Greeks are null only together (`NO_GREEKS`, :368) | the branches of `dealerContext` (:358-369): `input.spot`, `input.strikes`, `model`, `atmIv`, `totals` | API/gex-context.test.ts (one test per cause) |
| B31 | API/server/gex-context.ts, `greekFactors`, charm value (:544) | Same value and detail prefix as B30 | as B30 | API/gex-context.test.ts |
| B32 | API/server/gex-context.ts, `greekFactors`, vanna value (:557) | Same value and detail prefix as B30 | as B30 | API/gex-context.test.ts |
| B33 | API/server/gex-context.ts, `IV_REGIME_LABELS` (:564) loses the key `unknown`; `ivFactor` (:572-587), tone alert | `iv.frontIv === null`: value `Not computed: no front expiry IV`; detail starts `Front and back expiry IV are missing: no expiry 1 or more days out has an ATM IV in the QuantData chain.`. `iv.frontIv` set, `iv.backIv === null`: value `Not computed: no back expiry IV`; detail starts `Back expiry IV is missing: only the front expiry (ATM IV <front>) has an ATM IV.`. Both then continue with the existing detail sentence | `iv.frontIv`, `iv.backIv`; `<front>` = `percent(iv.frontIv)` | API/gex-context.test.ts |
| B34 | API/server/gex-context.ts, `buildGexContext` (:627-632) | `total === null`: `no_data`. `total === 0`: `zero`. Else `positive` or `negative` | `input.totalGex` | API/gex-context.test.ts, API/options-analytics.test.ts |
| B35 | API/server/options-chain.ts, `mapFailure` (:300-303) | `Options chain request failed inside the API (unexpected error); retry, and report it if it repeats` | `error` is not an `OptionsChainSourceError` | API/options-chain.test.ts, test `maps adapter failures and does not cache them` (:552; its `ODD` symbol throws `new Error("unexpected")` at :559 and reaches `mapFailure`); add the message assertion there |

Rule 11: one shared function `enumLabel<K extends string>(labels: Partial<Record<K, string>>, value: string): string`, exported from `apps/web/src/features/flow/format.ts`. It returns the label, or `Value "<value>" has no label in this page version · reload the page`. Used in B4, B5, B6, B10; test in `apps/web/src/features/flow/format.test.ts`. The text has no guarded word, so no allow-list entry is added.

### Notes

1. Read direction (rule 9), one place: API/server/flow-snapshot.ts. `printView` (:375): a stored side that is not in `FLOW_OPTION_SIDES` becomes `not_classified`. `buildGexView` (:449): a stored `iv_regime` that is not in `IV_TERM_REGIMES` becomes `no_term_data`; a stored regime that is not `positive` or `negative` becomes `no_data` (guard, no `total_gex` branch). `FlowGexRow` (:114) types `regime` and `ivRegime` as `string`. Tests in API/server/flow-snapshot.test.ts build a response from a row with `unknown` in each of the two columns and from a row with a regime that is not in the enum.
2. Write direction, one place per column: API/flow-options.ts:178 writes `unknown` for a print without a side (B16); API/server/flow-collect.ts:836 writes `unknown` for `no_term_data` (B19). Each has a collector test that asserts the stored word.
3. No API response field is added. Added inside the API: `ConfluenceInput.symbol`, `.now`, `.freshness` (B22); `greeksCause` (B30); `StoredOptionSide` (B16); a local UTC time formatter in flow-snapshot.ts (rule 5). Added in the web: `Failure.failedAt: number` (B1), `Metric.title?: string` (B5), print row `sideTitle` (B4), `VOTE_LABELS` (B10), `NO_VALUE`, `enumLabel` (format.ts).
4. `no_data` and `zero` of `GEX_REGIMES` are produced only by the live analytics path (`buildGexContext`, B34) and shown through the factor texts of B28. `tests/e2e/helpers/options-snapshot.ts` `EMPTY_GEX_CONTEXT` takes `bias: "not_received"` (:16), `regime: "no_term_data"` (:23), `regime: "no_data"` (:33) and the comment at :4 is reworded. `apps/web/src/lab/fixtures/market.ts` takes the B33 value text (:185) and `no_term_data` (:197).
5. `features/flow/format.ts` has three importers outside view-model.ts: control-view-model.ts (modified, B3), flow-control-panel.tsx and lab/fixtures/flow.ts (not modified, see Files). The other files that call functions with the same names import them from other modules.
6. Allow list: remove the 6 open entries of this area: flow-workspace.tsx (`Flow snapshot unavailable. ${}`), options-analytics-panel.tsx (dash), features/flow/format.ts (dash), features/flow/view-model.ts (`Unknown` count 3; basis text), options-chain-table.tsx (dash). `MAX_OPEN` falls by 6. Kept entries do not change: flow-workspace.tsx range dash and flags dash (test :343 stays), panel hyphen, fake-gateways.ts dummy text.
7. Not an audit row, fixed in this pull request: `optionEvents` in `packages/api/src/flow-options.ts` (:203) writes `side not classified` for a stored side `unknown` and `price not reported` for a null price into `flow_events.detail`; a test in `packages/api/src/flow-options.test.ts` asserts both. The same text prints the moneyness: a stored `unknown` moneyness is written as `moneyness not reported`. `printEvent` in `packages/api/src/flow-features.ts` writes `unsigned` for a trade side `unknown` in its detail text (`flow-features.test.ts` asserts it). Rows already stored keep the old words until they expire (14 days).
8. B1: `FlowWorkspace` has no load badge. The alert paragraph carries the whole status line, starting with `loadFailedLabel(failedAt)`.
9. Times: a time that comes as text (`gex.at`, `asOf`, `generatedAt`) is formatted with `statusTime` from `apps/web/src/components/status-time.ts`, which returns `time not reported by source` for a missing or unreadable time.
10. Length: the longest new `value` is B22 (c) with a date, `No vote: source failed; last good 2026-11-18 14:05 UTC` (54 characters). The longest new `detail` is B28 `no_data` (prefix of 136 characters on a sentence of 155). A test asserts the longest text of each field.
11. Existing assertions of an old text or value (file: lines). Update:
    - `packages/api/src/gex-context.test.ts`: 233, 273, 278, 419 (`"unknown"`); 428, 430, 432, 440 (`"Unknown"`); 425, 426, 433 (`"n/a"`)
    - `packages/api/src/server/flow-snapshot.test.ts`: 269, 324, 350, 702, 703 (`"unknown"`); 276, 339, 340, 341, 342, 349, 350, 628 (`"n/a"`)
    - `packages/api/src/server/flow-collect.test.ts`: 564 (pacing); 1657, 1661 (regime); 1697, 1705, 1711 (basis)
    - `packages/api/src/server/flow.test.ts`: 160 (pacing)
    - `packages/api/src/options-analytics.test.ts`: 1094
    - `packages/api/src/flow-options.test.ts`: 120, 129, 183, 190 hold `"unknown"` as the stored side or moneyness word; they stay (rule 9), no update
    - `apps/web/src/components/portal/flow-workspace.test.tsx`: 329 (vote), 364, 370, 390 (503 text and alert text)
    - `apps/web/src/components/portal/options-analytics-panel.test.tsx`: 219, 286, 309, 369
    - `apps/web/src/features/stock-detail/options-chain-table.test.tsx`: 70, 72, 74, 78, 79, 80
    - `apps/web/src/features/flow/view-model.test.ts`: 4, 122, 138, 152, 177, 209, 226
    - `apps/web/src/features/flow/format.test.ts`: 16, 26, 32, 45, 50, 52, 54, 61, 86, 87
    - `tests/e2e/helpers/options-snapshot.ts`: 4, 16, 23, 33; `apps/web/src/lab/fixtures/market.ts`: 185, 197
12. `packages/api/src/server/flow-control.test.ts` gets the test that `SIDE_SIGN` gives 0 for the stored side `unknown` (the control path reads stored rows, so it never meets `not_classified`).

## Area C: market context, feeds, news, calendar, congress (rows C1-C31)

Paths are repository-relative. `portal/` in the Rows table = `apps/web/src/components/portal/`. `HH:MM UTC` always means the output of `utcClock(...)` from `apps/web/src/components/status-time.ts` (added by pull request A; not in this worktree yet).

### Files

- Modify `apps/web/src/components/portal/congress-trades-workspace.tsx`
- Modify `apps/web/src/components/portal/congress-trades-workspace.test.tsx`
- Modify `apps/web/src/components/portal/market-context-workspace.tsx`
- Modify `apps/web/src/components/portal/market-context-workspace.test.tsx`
- Modify `apps/web/src/components/portal/market-feeds-workspace.tsx`
- Modify `apps/web/src/components/portal/market-feeds-workspace.test.tsx`
- Modify `apps/web/src/components/portal/market-news-client.ts`
- Modify `apps/web/src/components/portal/market-news-client.test.ts`
- Modify `apps/web/src/components/portal/market-news-workspace.tsx`
- Modify `apps/web/src/components/portal/market-news-workspace.test.tsx`
- Modify `apps/web/src/components/portal/market-source-status.ts`
- Modify `apps/web/src/components/portal/market-source-status.test.ts`
- Modify `apps/web/src/components/portal/calendar-workspace.tsx`
- Modify `apps/web/src/components/portal/calendar-workspace.test.tsx`
- Modify `apps/web/src/components/portal/market-context-page.test.tsx` (fixture gets `sections`)
- Modify `apps/web/src/components/portal/dashboard-widgets.test.tsx` (fixture gets `sections`)
- Modify `apps/web/src/components/portal/dashboard-widgets-model.test.ts` (fixture gets `sections`)
- Modify `apps/web/src/lab/fixtures/lenses.ts` (`LAB_MARKET_CONTEXT` gets `sections`; `lab/entries/lenses.test.tsx` parses it with the strict schema)
- Modify `packages/api/src/contracts/market-context.ts`
- Modify `packages/api/src/contracts/market-news.ts`
- Modify `packages/api/src/contracts/congress-trades.ts`
- Modify `packages/api/src/server/market-context.ts`
- Modify `packages/api/src/server/market-news.ts`
- Modify `packages/api/src/market-context.test.ts`
- Modify `packages/api/src/market-news-server.test.ts`
- Modify `packages/api/src/congress-trades-feed.test.ts`
- Modify `infra/rig/engine-status/market_context.py`
- Modify `infra/rig/engine-status/test_market_context.py`
- Modify `infra/rig/engine-status/fixtures/market-context.v1.json` (regenerate with `MC_WRITE_FIXTURE=1`)
- Modify `apps/web/src/status-language-allowlist.ts`, `apps/web/src/status-language.test.ts` (`MAX_OPEN` only), `packages/api/openapi.json` (generated)

No `packages/db` file, no `services/` file. `packages/api/src/server/congress-trades.ts`, `server/loopback-status.ts` and `server/ibkr-monitor.ts` do not change.

### Rows

| ID | File and function | Final text or template | Source of each placeholder | Test file |
| --- | --- | --- | --- | --- |
| C1 | portal/congress-trades-workspace.tsx, filing card (line 90) | `district not in filing` (then the existing `· filed <filedOn>`) | none; shown when `filing.stateDistrict === ""` | portal/congress-trades-workspace.test.tsx |
| C2 | same file, table cell (line 139) | `not in filing` | none; same condition | same |
| C3 | same file, `FeedStatus` (line 207) | `Load failed HH:MM UTC` | `loadFailedLabel(state.failedAt)`; new field `failedAt: number` on the error arm of `FeedState`, set to `Date.now()` in the rejection branch of `load` (line 279). The audit's error code is not shown: the state holds the server message only, and the body line already prints it | same |
| C4 | portal/market-context-workspace.tsx, `fixed` (line 39) | `no reading` | none | portal/market-context-workspace.test.tsx |
| C5 | same file, `signed` (line 42) | `no prior value` | none | same |
| C6 | same file, `SeriesCard` (line 64) | Case A (a `sourceErrors` entry starts with `Cboe:`): value `Not received`, hint `Not received from Cboe: <error>`. Case B (no such entry): value `No reading`, hint `No reading in the response of HH:MM UTC` | `<error>` = that entry of `data.sourceErrors` without the prefix `Cboe:` (new prop `sourceError: string or null`); time = new field `receivedAt: number` on the ready arm of `State`, set to `Date.now()` in `load`, passed as a prop. The API sends no reason or last-reading time per series, so the per-source error is the cause | same |
| C7 | portal/market-feeds-workspace.tsx, `when` (line 56) | `time not reported by source` (renders as `As of time not reported by source`) | none; the non-null branch does not change | portal/market-feeds-workspace.test.tsx |
| C8 | same file, `num` (line 68) | `no value`; GEX cells get `title` = `not in the GEX snapshot of HH:MM UTC` (or `not in the GEX snapshot; time not reported by source` when `gex.asOf === null`); macro cells get `title` = `series status <status> in the macro snapshot of HH:MM UTC` | `gex.asOf`, `macro.asOf` (new props `asOf` on `GexRow` and the macro row); `<status>` = `series.stale ? "stale" : series.status` | same |
| C9 | same file, `signed` (line 71) | `no prior value` | none | same |
| C10 | same file, `dollars` (line 74), cell at line 97 | `not computed`; `title` as the GEX title of C8 | `gex.asOf` | same |
| C11 | same file, `GexRow` regime cell (line 99) | `regime not computed`; `title` as the GEX title of C8 | `gex.asOf` | same |
| C12 | same file, `GexRow` 0DTE cell (line 115) | `0DTE not in snapshot`; `title` as the GEX title of C8. One text: the collector sets `zeroDte` to null both when market-watch-bot has no 0DTE block and when its block is not `ok`, and the plan does not add a field for it | `gex.asOf` | same |
| C13 | same file, `GexSection` (line 132), new function `missingSectionText(label, section, data)` | By `data.sections.gex`: `state_file_missing` -> `GEX not received: the collector found no GEX state file · collector push HH:MM UTC · <next>`. `state_file_unreadable` -> `GEX not received: the collector could not read the GEX state file (last written <stateAt>) · collector push HH:MM UTC · <next>`. `state_file_invalid` -> `GEX not received: the GEX state file (last written <stateAt>) has a shape the collector does not accept · collector push HH:MM UTC · <next>`. Entry null, or status `ok` with a null section -> `GEX not in the collector push of HH:MM UTC; this collector version reports no cause · <next>` | push time = `data.generatedAt`; `<stateAt>` = `utcClock(section.stateAt)`, or `time not reported by source` when null; `<next>` = `collector pushes every 5 min` when `data.stale === false`, else `collector has not pushed since HH:MM UTC; check the rig collector` (same `generatedAt`). `GexSection` gets the new props | same |
| C14 | same file, macro value cell (line 254) | `no value`; `title` as the macro title of C8. The status is already printed after the series label (line 249-251) | `series.status`, `series.stale`, `macro.asOf` | same |
| C15 | same file, macro date cell (line 257) | `date not reported` | none | same |
| C16 | same file, `NewsSection` (line 302) | The four texts of C13 with `News` and `news` in place of `GEX` | `data.sections.news`, `data.generatedAt`, `data.stale` | same |
| C17 | portal/market-news-client.ts, `describeMarketNewsFailure`, case `STORAGE_ERROR` (line 56) | The function returns `{ message, retryable }` (type `MarketNewsFailure`). `message` = the server text without a trailing `; retry`: `Watchlist storage: database request failed` (`retryable: true`), `Watchlist storage is not configured on this server; ask the operator` (`retryable: false`), and `Watchlist storage request failed` (`retryable: true`) when the error has no message. No prefix `Watchlist not loaded:`: the workspace adds its own subject (C24, C29), and two prefixes would stack | `message` of the oRPC error when it is a non-empty string (one of the two server texts of C23). `retryable` is true when that text ends with `; retry` or is missing. The audit's "not saved" is dropped: this procedure only reads the watchlist | portal/market-news-client.test.ts |
| C18 | portal/market-news-workspace.tsx, `NewsStatus` (line 305) | `Load failed HH:MM UTC` | `loadFailedLabel(state.failedAt)`; new field `failedAt: number` on the error arm of `NewsState`, set at line 433. No last-good time: the workspace drops the old data when a load starts | portal/market-news-workspace.test.tsx |
| C19 | same file, earnings row (line 392) | `SEC filings not loaded: <error>` | `row.error` (`TickerEarnings.error` from `latestEarningsFilings`, calendar-model.ts:65) | same |
| C20 | portal/market-source-status.ts, `summarizeMarketStatus` (line 57) | `All sources failed` | none; the signature does not change. Each workspace below the chip shows its own cause and time (C3, C18, C24, C29 and the kept body lines) | portal/market-source-status.test.ts; portal/calendar-workspace.test.tsx (chip) |
| C21 | packages/api/src/contracts/congress-trades.ts, `CONGRESS_TRADES_ERRORS.UNAVAILABLE` (line 51) | `House Clerk disclosures request failed; retry` | none. Default only: every throw of this code in `server/congress-trades.ts` passes its own message, and those do not change | packages/api/src/congress-trades-feed.test.ts |
| C22 | packages/api/src/contracts/market-context.ts, `MARKET_CONTEXT_API_ERRORS.UNAVAILABLE` (line 18) | `Market context request failed; retry` | none. Default only: `toLoopbackStatusProcedureError` always passes a message (`Market context service did not answer`, `No market context pushed yet`) | packages/api/src/market-context.test.ts |
| C23 | packages/api/src/contracts/market-news.ts, `MARKET_NEWS_API_ERRORS.STORAGE_ERROR` (line 132); two throw sites in packages/api/src/server/market-news.ts | Default: `Watchlist storage request failed; retry`. Site 1 (line 587, repository undefined): `Watchlist storage is not configured on this server; ask the operator`. Site 2 (line 592, `DatabasePersistenceError`): `Watchlist storage: database request failed; retry`. Status stays 503; other errors are still rethrown | none | packages/api/src/market-news-server.test.ts |
| C24 | portal/calendar-workspace.tsx, `EarningsNotes` (line 115) | Retryable failure: `Earnings filings not loaded: <message> · HH:MM UTC · press Try again`. Failure that a retry cannot fix (session expired, not permitted, storage not configured): `Earnings filings not loaded: <message> · HH:MM UTC` | `marketNewsFailureLine("Earnings filings", state)` in market-news-client.ts; `message` and `retryable` from `describeMarketNewsFailure` (see Notes); time = new field `failedAt: number` on the error arm of `NewsState`, set at line 211 | portal/calendar-workspace.test.tsx; portal/market-news-client.test.ts |
| C25 | same file, `EarningsNotes` (line 145) | `SEC filings not loaded: <SYMBOL> (<error>), <SYMBOL> (<error>) · response of HH:MM UTC · press Refresh` | per ticker `ticker.symbol` and `ticker.error` from `latestEarningsFilings(tickers)`, joined with `,`; time = `state.news.receivedAt` | same |
| C26 | portal/market-context-workspace.tsx, S&P 500 panel (line 191) | Case A (a `sourceErrors` entry starts with `S&P 500:`): `S&P 500 quote not received: <error> · response of HH:MM UTC · refreshes every minute`. Case B: `S&P 500 quote: no reading in the response of HH:MM UTC · refreshes every minute` | `<error>` = that entry of `data.sourceErrors` without the prefix; time = `state.receivedAt` (C6). The API sends no last-quote time | portal/market-context-workspace.test.tsx |
| C27 | portal/market-feeds-workspace.tsx, `GexRow` 0DTE cell (line 116) | `expiry not reported` (in place of the mark, before `: flip ...`) | none; shown when `row.zeroDte.expiry === null` | portal/market-feeds-workspace.test.tsx |
| C28 | same file, `MacroSection` (line 202) | The four texts of C13 with `Macro` and `macro` in place of `GEX` | `data.sections.macro`, `data.generatedAt`, `data.stale` | same |
| C29 | portal/market-news-workspace.tsx, error body (line 513) | Retryable failure: `News not loaded: <message> · HH:MM UTC · press Try again`. Failure that a retry cannot fix: `News not loaded: <message> · HH:MM UTC` | `marketNewsFailureLine("News", state)`; `message` and `retryable` from `describeMarketNewsFailure`; time = `utcClock(state.failedAt)` (C18) | portal/market-news-workspace.test.tsx; portal/market-news-client.test.ts |
| C30 | portal/congress-trades-workspace.tsx, `FeedKpis` "Latest filing" value (line 245) | `No filing`; the hint `No filing in this window` does not change | none; shown when `latestFiling(feed.filings)` is undefined | portal/congress-trades-workspace.test.tsx |
| C31 | same file, pager (line 179) `Showing {first + 1}–{first + shown} of {total}` | kept: the dash is a range mark between two real numbers. The allow-list entry for the dash loses `open`, gets count 1 and this reason | n/a (kept) | apps/web/src/status-language.test.ts |

### Notes

1. Collector (`market_context.py`, `collect_document`): `document["sections"] = {name: {"status": str, "stateAt": int | None}}` for each of `gex`, `macro`, `news`. `status`: `ok`; `state_file_missing` on `FileNotFoundError`; `state_file_unreadable` on any other `OSError`; `state_file_invalid` on `ValueError`, `TypeError`, `AttributeError` (JSON, shape or builder). `stateAt` = `int(os.stat(path).st_mtime)` in unix seconds, `None` when the stat fails. `missing` and the schema id `vertex-market-context-v1` do not change (the Quant VPS writer routes by that exact string).
2. Contract (`contracts/market-context.ts`): `export const MARKET_CONTEXT_SECTION_STATUSES = ["ok", "state_file_missing", "state_file_unreadable", "state_file_invalid"] as const;` `export const MarketContextSectionSchema = z.object({ status: z.enum(MARKET_CONTEXT_SECTION_STATUSES), stateAt: z.iso.datetime().nullable() }).strict();` and in `MarketContextOutputSchema`: `sections: z.object({ gex: MarketContextSectionSchema.nullable(), macro: MarketContextSectionSchema.nullable(), news: MarketContextSectionSchema.nullable() }).strict()`. The key is required, so every typed fixture in Files gets `sections: { gex: null, macro: null, news: null }`.
3. Server (`server/market-context.ts`): `UpstreamSchema` gets `sections: z.record(z.string(), z.unknown()).optional().catch(undefined)`. `toMarketContext` builds each of the three entries with `z.object({ status: z.enum(MARKET_CONTEXT_SECTION_STATUSES), stateAt: epoch.nullable() }).safeParse(entry)`; a failed parse or an absent key gives `null`; `stateAt` goes through `isoOrNull`. Tests: document without `sections`, with one bad entry, with all four statuses.
4. `describeMarketNewsFailure` (covers the audit notes of C24 and C29) returns `{ message, retryable }`. `UNAUTHORIZED` and `FORBIDDEN` texts stay, with `retryable: false`; `STORAGE_ERROR` as C17; default returns `<code>: <message>` with `retryable: true`, `code` = the error's `code` string or `ERROR`, and `message` = the error's non-empty `message` without a trailing `; retry`, or `Request failed`. The words `press Try again` are added once, by `marketNewsFailureLine`, and only when `retryable` is true. The old default `Request failed. Retry.` and its two assertions go.
5. Helpers that are joined with a unit must not print the unit after a reason. `market-context-workspace.tsx` line 196 prints `(<signed>%)` only when `movePct` is a number, else `(no prior value)`; lines 207-208 do the same for `%` and `×`. In `market-feeds-workspace.tsx` the pair `num(callWall) / num(putWall)` stays as two texts.
6. Rule 3 state changes: `failedAt: number` is added to the error arm of `FeedState` (congress), `NewsState` (news workspace and calendar). `market-context-workspace.tsx` adds `receivedAt: number` to its ready arm. The error arms of `market-context-workspace.tsx`, `market-feeds-workspace.tsx` and the calendar's `ContextState` are not rows of this area; their body texts are kept entries.
7. The collector's fallback for a row or series status is the data string `unknown` (`market_context.py` lines 113 and 162); the feeds page prints the series status at line 251. Both fallbacks change to `not_reported` (fits `label(20)`); `test_market_context.py` asserts it.
8. Allow list: 17 open entries of these files go (C31's entry stays without `open`), so the open count and `MAX_OPEN` fall by 18 for this pull request (17 entries removed, and C31's entry loses `open`). The chip label is also the value of `data-market-status` and `data-calendar-status`; no test selects on the old value except `calendar-workspace.test.tsx` lines 411-423 and `market-source-status.test.ts` lines 54-55.
9. Texts C21-C23 are outside the guard; their tests assert the exact strings. No value of this area is stored in Postgres, and no enum of rules 8, 9 or 11 is in this area.

## Area D: rotation matrix, sector rotation, breadth

### Files

- Modify `apps/web/src/components/portal/breadth-90-chart.tsx`
- Modify `apps/web/src/components/portal/breadth-90-chart.test.tsx`
- Modify `apps/web/src/components/portal/rotation-matrix-workspace.tsx`
- Modify `apps/web/src/components/portal/rotation-matrix-workspace.test.tsx`
- Modify `apps/web/src/components/portal/sector-rotation-workspace.tsx`
- Modify `apps/web/src/components/portal/sector-rotation-workspace.test.tsx`
- Modify `tests/e2e/sector-rotation.spec.ts`
- Modify `packages/api/src/contracts/sector-rotation.ts`
- Modify `packages/api/src/server/sector-rotation.ts`
- Modify `packages/api/src/sector-rotation-server.test.ts`
- Modify `packages/api/openapi.json`
- Modify `apps/web/src/status-language-allowlist.ts`
- Modify `apps/web/src/status-language.test.ts`

### Rows

| ID | File and function | Final text or template | Source of each placeholder | Test file |
| --- | --- | --- | --- | --- |
| D1 | `breadth-90-chart.tsx`, `Breadth90Chart`, cell "Advancers %" of the `sr-only` table | Case `day.adv + day.decl === 0`: cell `no advancer counts`, `title` = `<source> sent 0 advancers and 0 decliners for <date>`. Case null with counts above 0: cell `not computed`, `title` = `advancers % was not stored for <date> (advancers <adv>, decliners <decl>)`. | `day.source`, `day.date`, `day.adv`, `day.decl` (`Breadth90Day`) | `breadth-90-chart.test.tsx` |
| D2 | `rotation-matrix-workspace.tsx`, `formatReturn(value, n?: number)` (new optional second argument) | Case `n === 0`: `no names`. Case value not a number, any other `n`: `no return`. KPI cards do not call it for a missing industry: `leading === undefined` / `lagging === undefined` show the value `none ranked` (hint stays `No ranked industry`). | `n`: `stats.n` (`CellDetail`), `cell.n` / `industry.n` (heat grid labels and `HeatButton`), `sector.n` (sector row); other call sites pass no `n` | `rotation-matrix-workspace.test.tsx` |
| D3 | `rotation-matrix-workspace.tsx`, `CellDetail`, summary sentence | Case `stats.breadth === null`: `<sector>. Median <median>, cap-weighted <capWeighted>, share of names up not computed: <n> names have a <period> return.<rank>`. Case number: unchanged (`<breadth>% of <n> names up.`). | `industry.sector`, `formatReturn(stats.retMedian, stats.n)`, `formatReturn(stats.retCapWeighted, stats.n)`, `stats.n`, `period` prop, `rank` | `rotation-matrix-workspace.test.tsx` |
| D4 | `rotation-matrix-workspace.tsx`, `OurNames`, column Industry | Cell `no industry`, `title` = `The matrix document generated <generatedAt> has no industry for <symbol>` | `matrix.generatedAt` (raw string), `name.symbol` | `rotation-matrix-workspace.test.tsx` |
| D5 | `rotation-matrix-workspace.tsx`, `OurNames`, column 1M (new local `cellStateCell(name, "1M")`) | Case `name.cell1M === undefined`: cell `no cell state`, `title` = `The matrix document generated <generatedAt> has no 1M cell state for <symbol>`. Case `"unranked"`: cell `not ranked`, `title` = `<industry> has fewer than 3 names with a 1M return`. Any other value: shown as stored (`leading`, `lagging`, `middle`). | `matrix.generatedAt`, `name.symbol`, `name.industry ?? "Its industry"`, `name.cell1M` | `rotation-matrix-workspace.test.tsx` |
| D6 | same function with `"3M"` | Same three cases with `3M` in place of `1M`. | as D5, `name.cell3M` | `rotation-matrix-workspace.test.tsx` |
| D7 | `rotation-matrix-workspace.tsx`, header `status` badge; body alert; `LoadState` error member gets `failedAt: number` set in `load` | Badge: `Load failed <HH:MM UTC>`. Body: `Rotation matrix load failed: <message> · <time> · press Try again`. | badge = `loadFailedLabel(state.failedAt)`; `state.message`; time = `utcClock(state.failedAt)`; `failedAt = Date.now()` in the rejection branch of `load` | `rotation-matrix-workspace.test.tsx` |
| D8 | `rotation-matrix-workspace.tsx`, header `status` badge, ready state | Case `asOf === null`: `As-of date not reported by generator · generated <generated>`. Case string: unchanged (`As of <asOf>`). | generated = `utcClock(Date.parse(matrix.generatedAt))` when the parse is finite, else the raw `matrix.generatedAt` | `rotation-matrix-workspace.test.tsx` |
| D9 | `rotation-matrix-workspace.tsx`, footer paragraph | Case `matrix.source === null`: `Sources: not recorded by the generator. Generated <generatedAt>.` Case object: unchanged (`Sources: <metadata>; <bars>. Generated <generatedAt>.`). | `matrix.source`, `matrix.source.metadata`, `matrix.source.bars`, `matrix.generatedAt` | `rotation-matrix-workspace.test.tsx` |
| D10 | same paragraph as D9 | Same text as D9: `metadata` and `bars` are both required strings of `RotationSourceSchema`, so they are absent only together (`source === null`). One branch covers both rows. | as D9 | `rotation-matrix-workspace.test.tsx` |
| D11 | `sector-rotation-workspace.tsx`, `HeaderStatus`; body alert in the map panel; `LoadState` error member gets `failedAt: number` set in the `catch` of the load callback | Badge: `Load failed <HH:MM UTC>`. Body: `Sector rotation load failed: <message> · <time> · press Try again`. | badge = `loadFailedLabel(state.failedAt)`; `state.message` with one trailing `.` removed; time = `utcClock(state.failedAt)`; `failedAt = Date.now()` in the `catch` | `sector-rotation-workspace.test.tsx`, `tests/e2e/sector-rotation.spec.ts` |
| D12 | `contracts/sector-rotation.ts`, `SECTOR_ROTATION_API_ERRORS.STORAGE_ERROR.message`; `server/sector-rotation.ts`, the throw in the repository lookup (the only `failures.STORAGE_ERROR()` call) | Contract default: `Sector rotation storage request failed; retry`. Throw site: `Sector rotation storage is not configured on this server; ask the operator`. | none (literals); the `Failures.STORAGE_ERROR` type gets `(options?: { message?: string })` | `sector-rotation-server.test.ts` |
| D13 | `contracts/sector-rotation.ts`, `SECTOR_ROTATION_API_ERRORS.UNAVAILABLE.message` | Contract default: `Market data source request failed; retry`. The three `failures.UNAVAILABLE` throw sites keep their own messages (`<symbol>: <reason>`, `No sector has enough price history`, `Benchmark <symbol>: <reason>`). | none (literal) | `sector-rotation-server.test.ts` |

### Notes

- No API field is added. The audit's cause "too few bars" for D2, D5, D6 is not in the response; the texts use what is in scope (`n`, the cell state, `generatedAt`).
- D4 and the `undefined` cases of D5/D6 cannot occur with the current generator (covered names always get an industry and a cell state); the tests need a fixture that omits the fields. The state seen in practice is the stored string `unranked`.
- D5/D6: `unranked` is a stored string of `rotation-matrix.json` and is not renamed; only its label changes. "Fewer than 3" is the generator's ranking rule (`rotation-matrix.ts`, `industry.n >= 3`).
- D7 and D11 also replace the body texts `Rotation matrix unavailable:` and `Sector rotation unavailable:`; their two allow-list entries (not `open`) are removed with the open ones.
- D12/D13 messages are not shown on the rotation matrix page; that page uses `RESEARCH_LENS_ERRORS`, which is not in this area.
- Allow list: remove from `rotation-matrix-workspace.tsx` the entries `–` (5), `Unavailable` (1), `unknown` (3), `Rotation matrix unavailable:` (1); from `sector-rotation-workspace.tsx` `Unavailable` (1), `Sector rotation unavailable:` (1); from `breadth-90-chart.tsx` `—` (1). The `sector-rotation-workspace.tsx` entry `–` (row name cell) is not a row and stays. `MAX_OPEN` goes down by 5 entries.
- Tests to update: `rotation-matrix-workspace.test.tsx` lines 137, 290, 303, 396, 414, 416; `sector-rotation-workspace.test.tsx` lines 346, 766, 820; `tests/e2e/sector-rotation.spec.ts` line 33 (match `/^Load failed \d\d:\d\d UTC$/`). `sector-rotation-client.test.ts` uses an old message only as sample input and does not change.
- `packages/api/openapi.json` is regenerated (`bun run openapi:generate`) because two contract defaults change.

## Area E: charts and market data

### Files

- Modify `apps/web/src/components/portal/charts-analysis-panels.tsx`
- Create `charts-analysis-panels.test.tsx` (new file in `apps/web/src/components/portal/`)
- Modify `apps/web/src/components/portal/charts-workspace.tsx`
- Modify `apps/web/src/components/portal/charts-workspace.test.tsx`
- Modify `apps/web/src/features/charts/chart-workstation.tsx`
- Modify `apps/web/src/features/charts/chart-workstation.test.tsx`
- Modify `apps/web/src/features/charts/indicators.ts`
- Modify `apps/web/src/features/charts/indicators.test.ts`
- Modify `apps/web/src/features/charts/market-chart.tsx`
- Modify `apps/web/src/features/charts/renderer-host.tsx`
- Modify `apps/web/src/features/charts/renderer-host.test.tsx`
- Modify `apps/web/src/features/charts/script-sandbox.ts`
- Modify `apps/web/src/features/charts/script-sandbox.test.ts`
- Modify `packages/api/src/contracts/market-data.ts`
- Modify `packages/api/src/server/market-data.ts`
- Modify `packages/api/src/market-data.test.ts`
- Modify `packages/api/openapi.json`
- Modify `apps/web/src/status-language-allowlist.ts`
- Modify `apps/web/src/status-language.test.ts`

### Rows

| ID | File and function | Final text or template | Source of each placeholder | Test file |
| --- | --- | --- | --- | --- |
| E1 | `charts-analysis-panels.tsx`: remove `DASH`; `formatReturn(value, digits, reason)` gets a required reason for null; `ReturnStatsTable` picks it from `stats.count` | Mean, Min, Max null (`count === 0`): `no returns`. Stdev null (`count < 2`): `too few bars`. Skew null: `too few bars` when `count < 3`, else `zero variance`. Each such cell has `title` = `<count> returns in range; <statistic> needs at least <minimum>` (minimum: mean/min/max 1, stdev 2, skew 3) or, for zero variance, `all <count> returns are equal`. Histogram bin edges and session mean (non-finite number only): `not finite`. | `stats.count`; statistic = the column name | `charts-analysis-panels.test.tsx` (new) |
| E2 | `charts-workspace.tsx`, source `dl`, `dd` after "As of" | Case `data.asOf === null`: `not reported by source`, `title` = `IBKR Gateway sent no as-of time; fetched <fetchedAt>`. Case string: unchanged. | `data.fetchedAt` | `charts-workspace.test.tsx` |
| E3 | `chart-workstation.tsx`, `screenshot` | Case `renderer === null`: `Screenshot not saved: the chart is not drawn (see the caption under the chart) · try again when bars are drawn`. Case `renderer.snapshot === undefined`: `Screenshot not saved: this chart renderer has no image export`. Case `snapshot()` returned `""`: `Screenshot not saved: the renderer returned an empty image · try again when bars are drawn`. | `renderer` state of the workstation; `renderer.snapshot` | `chart-workstation.test.tsx` |
| E4 | `indicators.ts`, `calculateIndicator`, the rights check (one `if` becomes five branches, in this order) | `status === "denied"`: `Display rights denied for candle <candleId> (<provider>/<sourceId>, policy <policyId>).` `"expired"`: `Display rights expired for candle <candleId> (<provider>/<sourceId>, policy <policyId>).` any other status that is not `"granted"`: `Display rights were not verified for candle <candleId> (<provider>/<sourceId>, policy <policyId>).` granted and (`expiresAt === null` or `expiresAt <= evaluatedAt`): `Display rights for candle <candleId> expired at <expiresAt> (evaluated at <evaluatedAt>).` with `<expiresAt>` = `no expiry time` when null. `checkedAt > evaluatedAt`: `Rights check for candle <candleId> at <checkedAt> is later than the evaluation time <evaluatedAt>.` | `candle.candleId`; `identity.provider`, `identity.sourceId`; `rights.policyId`, `rights.status`, `rights.expiresAt`, `rights.checkedAt`; `view.evaluatedAt` (timestamp strings) | `indicators.test.ts` |
| E5 | `indicators.ts`, `calculateIndicator`, the freshness check (two branches) | `status === "missing"`: `Candle <candleId> has no observation time from <provider>/<sourceId>; freshness cannot be checked.` any other status that is not `fresh` or `stale`: `Freshness of candle <candleId> was not evaluated (<provider>/<sourceId>).` | `candle.candleId`, `identity.provider`, `identity.sourceId`, `candle.source.freshness.status` | `indicators.test.ts` |
| E6 | `market-chart.tsx`, `MARKET_CHART_CAPTIONS.error` (now only the next step; the host writes state, cause and time) | Constant: `reload the page to retry`. Rendered caption: `Chart renderer failed to <stage>: <errorName> · <time> · reload the page to retry`. | from the host state, see E7 | `renderer-host.test.tsx` |
| E7 | `renderer-host.tsx`, `ChartRendererHost`: state gets `failure: { stage: "load" \| "draw"; name: string; failedAt: number } \| null`; the five `catch` blocks bind the error and set it; `figcaption` | Default caption: `Chart renderer failed to <stage>: <errorName> · <time> · exact data is in the table; reload the page to retry`. With a `captions` prop: `Chart renderer failed to <stage>: <errorName> · <time> · <captions.error>`. | stage = `load` in the mount `catch`, `draw` in the resize, `replace`, `setStudies`, `setMarkers` catches; errorName = `error.name` when `error instanceof Error`, else `non-Error value (<typeof error>)`; time = `utcClock(failure.failedAt)`, `failedAt = Date.now()` in the `catch` | `renderer-host.test.tsx` |
| E8 | `script-sandbox.ts`, `handleScriptMessage`, the `catch` | Error: `Script engine failed: <message>` (unchanged). Not an Error: `Script engine failed: engine threw a non-Error value (<type>): <thrown>`. | `error.message`; type = `typeof error`; thrown = `String(error)` cut to 120 characters, inside its own `try` (a thrown object can have a failing `toString`; then thrown = `value has no text form`) | `script-sandbox.test.ts` |
| E9 | `contracts/market-data.ts`, `MARKET_DATA_ERRORS.UNAVAILABLE.message` | `IBKR history service request failed; retry` | none (literal) | `market-data.test.ts` |
| E10 | `server/market-data.ts`, `upstreamFailure`, the 503/504 branch with a body and no message | `IBKR history service returned HTTP <status> with no message; retry`. With a message: unchanged (the upstream message). | `response.status` | `market-data.test.ts` |
| E11 | same code location as E8 | Same text as E8; one edit removes both allow-list hits (`unknown error`). | as E8 | `script-sandbox.test.ts` |

### Notes

- No API field is added. `captions.error` keeps the type `string`; its meaning changes from the full caption to the next step, so the literal in `renderer-host.test.tsx` (line 271) changes too.
- E6 does not say "values are in the table below" as the audit proposed: `captions` exists for hosts without an exact-value table (comment in `renderer-host.tsx`), and `/charts` passes it.
- E3: the workstation does not hold the host phase, so `renderer === null` covers loading and failed; the text points to the caption, which E7 makes definite. Rule 1's time is left out of E3: the message answers a click made at that moment.
- E4: `CandleSchema.safeParse` runs before the rights check and rejects `granted` with a null `expiresAt`, so the `no expiry time` case is not reachable; it is kept so that each branch of the old condition has a text. Reason texts contain no vague word in the source; a status value is never printed.
- E4/E5: `IndicatorSeries.status` keeps the value `unavailable` (allow-list entry without `open`, count 2, stays). `calculateIndicator` has no caller outside `indicators.test.ts`.
- E10: the audit's `gateway down or restarting`, `bars not loaded` and `retry in 1 min` are not supported: the same function serves bars, ticks and depth, and no retry time is in the response. The message is passed to the client by `toTypedError`; the code stays `UNAVAILABLE` (503).
- E9/E10: `services/research/ibkr_history.py` line 264 and its test hold their own copy of the old text. They are not rows of this batch and do not change; `apps/web/src/features/stock-detail/fake-gateways.ts` (dummy text) also does not change.
- Allow list: remove the open entries of `charts-analysis-panels.tsx` (`—`), `charts-workspace.tsx` (`—`), `chart-workstation.tsx`, `indicators.ts` (2 texts), `market-chart.tsx`, `renderer-host.tsx`, `script-sandbox.ts`. `MAX_OPEN` goes down by 8 entries. E9 and E10 are in `packages/api` and have no entry.
- Tests to update: `chart-workstation.test.tsx` lines 320, 377; `renderer-host.test.tsx` lines 205, 271; `script-sandbox.test.ts` line 214. New assertions: `market-data.test.ts` (503 with a body and no message; contract default), `indicators.test.ts` (each E4/E5 branch), `charts-workspace.test.tsx` (null `asOf`).
- `packages/api/openapi.json` is regenerated because one contract default changes.
