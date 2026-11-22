# Stage 9: Implementation Readiness Test

Target: design.md lines 168-251 (DetailedRange of the draft). Reviewers: egm-implementation-readiness, egm-codebase-details (implementation-readiness-standard), egm-style (direct dispatch). All completed.

## egm-implementation-readiness

### Implementation Readiness Review: `design.md`, Detailed Implementation Plan (lines 168–251)

**Verdict: the plan fails the Zero-Decision Rule.** It is close to executable. It names nearly every file and function, and it copies the existing `flow.tapeSpeed` pattern correctly. But one access-control rule is contradictory. The file list misses three files that will fail typecheck or tests. The "run `bun run check` after each step" checkpoint cannot pass at steps 2 and 5. And several output fields have meanings or formats the implementer would have to make up.

I checked every claim below against the repository, read-only.

---

#### 🔴 Blockers

B1: It is unclear who may call `flow.hedgingPressure`, and the plan contradicts the code it copies

- **Lines:** 133 ("operator or agent read key, like `flow.tapeSpeed`"), 208–209, 211–212 ("viewer key allowed").
- **Discrepancy:** `flow.tapeSpeed` cannot be called with an API key. In `packages/api/src/server/flow.test.ts:531–537`:
  - `AGENT_API_KEY_READ_PROCEDURES.has("flow.tapeSpeed")` is asserted false.
  - `isAgentApiKeyProcedurePath(["flow","tapeSpeed"])` is asserted false.
  - Only the agent-viewer **account** can read it, and only because it is a GET route.

  The list in `packages/api/src/agent-viewer.test.ts:271` that step 3 points to is the GET-derived viewer list (`isAgentViewerReadProcedure` in `server/agent-viewer.ts`). It is not the API-key list. That key list lives in `packages/api/src/server/operator-access.ts:28`, which is not in the file list. So the Contract section and the step disagree, and "viewer key allowed" mixes up two different mechanisms.
- **Why it blocks:** this is an access decision on a new read endpoint. The implementer would have to choose whether to change `operator-access.ts`.
- **Fix:**
  - Replace line 133 with: "operator session, or the agent-viewer account (GET); not open to API keys, like `flow.tapeSpeed`."
  - In step 3, say: add `"flow.hedgingPressure"` to the sorted expected list in `agent-viewer.test.ts` ("matches the reviewed read list"); do not change `operator-access.ts`.
  - Replace the handler test case with: "not open to API keys (`isAgentApiKeyProcedurePath` false, not in `AGENT_API_KEY_READ_PROCEDURES`); viewer read allowed (`isAgentViewerReadProcedure` true); non-operator signed-in user gets FORBIDDEN; no repository → STORAGE_ERROR; failed read → STORAGE_ERROR."
  - If key access is actually wanted, say so and add `operator-access.ts` to the file list.

---

##### 🟡 Majors

M1: The file list misses three files that will break

- **Lines:** 186–193, 194–198, 238–240.
- **Discrepancies:**
  1. `packages/api/src/flow-tape-speed.contract.test.ts:166–186` asserts that `Object.keys(flowContract).sort()` equals exactly `["collect","control","snapshot","tapeSpeed"]`. Adding `hedgingPressure` makes this test fail.
  2. `packages/api/src/server/flow-collect.test.ts:371` ends its repository double with `} satisfies FlowRepository;`. Adding `readHedgingPrints` to the `FlowRepository` type breaks typecheck there. The tape-speed design (`designs/vertex-viz-tape-speed/design.md:506`) listed both doubles explicitly; this plan lists only the one in `flow.test.ts`.
  3. `apps/web/src/lab/entries/research.tsx:184` declares `labFlowGateway: FlowGateway`. The step names the file but does not say that `hedgingPressure` must be added to that gateway object, nor which fixture function it calls.
- **Fix:** add to the file list:
  - `flow-tape-speed.contract.test.ts`: add `"hedgingPressure"` to the expected keys and update the test title ("the other four flow procedures").
  - `flow-collect.test.ts`: add `readHedgingPrints: vi.fn(async () => [])` to the double.
  - `research.tsx`: add `hedgingPressure: ({ symbol }) => Promise.resolve(labFlowHedgingPressure(symbol))`, and name that fixture function.

M2: "Run `bun run check` after each step" cannot pass at steps 2 and 5

- **Lines:** 171 against steps 2, 3, 5 and 6.
- **Discrepancy:**
  - `appRouter = api.router({ … flow: flowRouter })` in `server/router.ts:1729` is built from `implement(appContract)`. Once step 2 adds the route to `flowContract`, typecheck fails until step 3 adds the handler to `flowRouter`.
  - The same happens on the web side. Step 5 adds `hedgingPressure` to the `FlowGateway` type, and the lab gateway in `research.tsx` only gets the method in step 6.
- **Fix:** combine the steps into phases that each build:
  - Phase A = steps 1 to 3 (rules, contract with handler, the agent-viewer list update, the tape-speed contract-test update, the `flow-collect.test.ts` double, OpenAPI regeneration).
  - Phase B = steps 4 to 6 (view-model, panel and wiring, lab gateway and fixtures).
  - Phase C = step 7 (documentation).
  - State that `bun run check` runs at the end of each phase.

M3: The `totals` counts and `gross` are not defined precisely enough to code or test

- **Lines:** 179–185 (step 1), referring to lines 145 and 116.
- **Discrepancies:**
  - "gross (sum of absolute values)" could mean the sum of |hedge notional| over all prints, the sum of |minuteNet|, or |net|+|calls|+|puts| at the end.
  - The counts overlap and no precedence is given:
    - Is `delta` computed for `mid` or `unknown` prints, so that they can also count toward `ivLimited` or `notPriced`?
    - Does `notPriced` include unsigned prints?
    - Must `signed + notSigned = prints` hold?
  - Rule 4 says "strike or price of 0 or less". `HedgingPrint` has no `price` field, and the step 1 test says "null price", so the reader cannot tell whether this means `underlying_price` or the option `price`.
  - Are `iv ≤ 0` prints "not priced" or "IV limited"?
- **Fix:** add a rule like this to step 1: "Per print, in this order:
  1. `prints += 1`.
  2. If the sign is null, `notSigned += 1`; stop.
  3. `signed += 1`.
  4. If `iv` is null, `underlyingPrice` is null or ≤ 0, or `strike` is ≤ 0, then `notPriced += 1`; stop.
  5. If `iv < 1` or `iv > 500`, then `ivLimited += 1`.
  6. notional = sign × delta × size × 100 × underlyingPrice; add it to `net` and to `calls` or `puts`; `gross += |notional|`."

  Also say "price" means `underlying_price`. Then add test cases that check these exact counts for a mixed input.

M4: Some contract field names, types and nullability are left open

- **Lines:** 186–193.
- **Discrepancies:**
  - The `rules` object keys are only described in prose ("version, rate 0, dividend yield 0, volatility range, minimum time…"). Step 1 names `volMin`, `volMax`, `minDays` and `readCap`, but not the keys for version, rate, yield or multiplier. Because the schema is `.strict()`, every key must match exactly.
  - No contract type for the rules (like `FlowTapeSpeedRules`) is named. The convention in `flow-tape-speed-rules.ts` is "Pure; imports contract types only", but step 1 writes the rules file before step 2 creates that type.
  - The type of `points[].minute` (ISO string or epoch) is not given.
  - Whether `points[].price` and `storedUntil` can be null is not given. `underlyingPrice` is nullable in the database schema.
  - "Export the new types from `index.ts`" is misleading: `index.ts:98` already has `export * from "./contracts/flow.ts"`. What is actually undecided is whether to add `export * from "./flow-hedging-pressure-rules.ts"`, like line 135 does for tape speed.
  - The "bad date" test is ambiguous. The existing `isoDate` regex (`contracts/flow.ts:223`) accepts `2026-02-30`.
- **Fix:** give the exact Zod shape. For example:
  - `rules: { version, rate, dividendYield, volMin, volMax, minDays, multiplier, readCap }`, defined as `FlowHedgingPressureRules` in the contract and imported by the rules file.
  - `minute: isoTimestamp`, `price: finite` (never null). A minute whose last print has a null `underlyingPrice` takes the last non-null value in that minute; otherwise the print is not priced.
  - `session: isoDate.nullable()`.
  - State whether the input `date` reuses `isoDate` (format only) or checks that the calendar date is real, and list the bad-date strings the test must reject.

M5: The lab cannot show the four required fixtures

- **Lines:** 238–240 and 248.
- **Discrepancy:** `/lab/flow` is a single entry, `<FlowWorkspace gateway={labFlowGateway} />` (`research.tsx:358–366`). The gateway takes only a symbol, and only SPY and ES reach the hedging panel. So there is no way to show four fixtures (SPY rise then fall, ES with uncounted prints, a truncated session, an empty symbol). The plan also does not say which symbol is "empty" or truncated.
- **Fix:** choose one mechanism, for example:
  - "Add two lab entries `flow-hedging-truncated` and `flow-hedging-empty` that render `FlowHedgingPressurePanel` directly with `labFlowHedgingPressure("truncated" | "empty")`; the workspace entry serves SPY (rise then fall) and ES (uncounted prints)."

  Then update the Acceptance bullet to match.

M6: How a forbidden answer works in the workspace is not specified

- **Lines:** 229–237.
- **Discrepancy:** tape speed uses a dedicated `tapeForbidden` ref with a hold rule (`flow-workspace.tsx:588–651`): any other answer to the newest request ends the hold, and the hold is re-applied at the end of `load()`. "Shows the access screen like tape speed" leaves open:
  - whether to add a second `hedgingForbidden` ref or share the existing one;
  - whether a non-forbidden hedging answer clears a tape-speed hold;
  - whether the end-of-load re-apply checks both refs.

  The step 5 test list has no forbidden case for hedging. The plan also does not say whether skipping QQQ and NQ resets the hedging document and failure to null.
- **Fix:**
  - Specify a separate `hedgingForbidden` ref that is set and cleared only by hedging answers.
  - The end of `load()` applies `setFailure({ kind: "forbidden" })` when either ref is true.
  - Skipping QQQ and NQ sets the hedging document and failure to null and clears the hedging ref.
  - Add tests in `flow-workspace.test.tsx`:
    - a forbidden hedging answer shows the access screen;
    - a later non-forbidden hedging answer does not clear a tape-speed hold.

M7: The view-model text and number formats are not given, so exact-output tests cannot be written

- **Lines:** 213–225.
- **Discrepancy:** the steps require tests for "every text function" and for `formatSignedCompactUsd`, but no exact output is given for:
  - the header line, totals line, counts line, truncated line or rule paragraph. The User experience section only gives the loading, failed, empty and not-collected strings. The mock's caption "Dealer hedge $ (+ buy / − sell) · estimate · research only…" is not mapped to any text function.
  - `formatSignedCompactUsd`: the K/M/B/T thresholds, the number of decimals, the zero value (`$0` or `+$0`), and the minus sign (`-` or Unicode `−`, which the mock uses).
  - the tick rule for "3 to 5" y-axis ticks (nice-number step or fixed count).
- **Fix:**
  - Give a template for each text function, with one worked example from a fixture.
  - Define `formatSignedCompactUsd` with examples, e.g. `1_234_000_000 → "+$1.2B"`, `-56_700 → "−$56.7K"`, `0 → "$0"`, `999 → "+$999"`.
  - Define the tick algorithm, e.g. nice step from {1, 2, 2.5, 5}×10ⁿ, always including 0.

M8: Repository test scope is conditional, and the return type is undefined

- **Lines:** 195–198.
- **Discrepancy:**
  - "and the integration database test if the repository methods are listed there" leaves the decision to the implementer. Integration tests exist per method; for example, `tests/integration/database/flow-tape-seconds.test.ts` covers `readTapeSeconds`.
  - `HedgingPrint` is defined in the API package, and `packages/db` cannot import from it. The plan does not name the return type of `readHedgingPrints` on `FlowRepository`.
- **Fix:**
  - Require `tests/integration/database/flow-hedging-prints.test.ts` (symbol filter, end-exclusive `to`, ascending order, `limit` respected, nullable columns passed through).
  - Require the unit test in `packages/db/src/server/flow.test.ts` to assert the exact selected columns and the WHERE SQL, as the `readTapeSeconds` test does at lines 334–352.
  - Define the return type in `packages/db/src/server/flow.ts` as `FlowHedgingPrintRecord = Pick<FlowOptionPrintRecord, …>`, re-export it from `packages/db/src/server/index.ts`, and alias `HedgingPrint` to it in the API.

---

##### 🟢 Nits

- **N1 (lines 190–191):** remove "or the script the repo uses". The script exists: root `bun run openapi:generate`.
- **N2 (lines 199–200):** name the "existing New York time helper". Session bounds = `newYorkTime(date, 0)` and `newYorkTime(nextDay, 0)` from `server/merged-bars.ts:281`. Rule 3's expiry time = `newYorkTime(expiry, 960)`.
- **N3 (lines 204–207):** name the existing methods. "Newest print" is `repository.newestOptionPrintAt(symbol)`, and the session date is `newYorkClock(newest).day`. Define the `rows` record type for `buildFlowHedgingPressure`, including `now` (needed by `buildSourceFreshness(rows, "options")`) and `symbol`.
- **N4 (line 146, step 1 tests):** a New York date with a DST fall-back has 1,500 minutes, while the cap is `.max(1440)`. The ES/SPX session hours probably make this unreachable, but say so, or add a test that a 25-hour date cannot produce more than 1,440 points.
- **N5 (lines 179–180):** state whether `hedgingPressure()` sorts its input or assumes it is already sorted, and whether `traded_at` ties keep input order.
- **N6 (step 3 tests):** add a case where the newest print falls on a weekend date. The plan should state what happens if an SPX overnight print is dated Sunday. Rule 1 claims "a weekend shows Friday".
- **N7 (line 222):** `formatSignedCompactUsd` should list `format.test.ts` explicitly in the file list.
- **N8 (lines 249–251):** the recomputation script is "one-off". Say whether it is committed (and so falls under the 100% coverage rule) or only pasted into the PR. Give the comparison tolerance; summing floating-point values in a different order may differ by a few ulp.
- **N9 (line 226):** name the failure type (`FlowHedgingPressureFailure`, same shape as `FlowTapeSpeedFailure`) and the gateway request type (like `TapeSpeedRequest` at `flow-workspace.tsx:46`).

## egm-codebase-details

The Detailed Implementation Plan (lines 168–251) does not meet the Implementation Readiness Standard. I found 1 blocker, 9 majors and 6 nits. Most cited files and symbols exist (in many cases a planned new file of the same kind already exists). The problems are a contradiction about API-key access, edits the plan leaves out, and several choices it leaves to the implementer.

References checked and confirmed:

- **API:** `bsDelta` in `packages/api/src/options-engine/pricing.ts:130`; `buildSourceFreshness` in `server/flow-snapshot.ts:186`; `readRows`, `assemble`, `requireOperator`, `flowRouter`, `latestSamples` and `newestOptionPrintAt`; `flowContract` and `FLOW_API_ERRORS` in `contracts/flow.ts`.
- **Database:** `FlowOptionPrintRecord` and `FlowOptionSideValue`.
- **Web:** `FlowTapeSpeedPanel`, `flow-workspace.tsx`, and the gateway call `api().flow.tapeSpeed`.
- **Lab:** the lab files and the `/lab/[entry]` route.
- **Docs and scripts:** `docs/debugging.md`, `CHANGELOG.md`, `flow-pipeline.md`, and the `bun run openapi:generate` and `bun run check` scripts.

---

### 🔴 Blockers (egm-codebase-details)

B1. The plan says "agent read key, like flow.tapeSpeed", but `flow.tapeSpeed` is not on the agent read-key list (lines 133–134, 208–209, 210–212).

- **What the code does:**
  - The read-key lists are `AGENT_API_KEY_PROCEDURE_PATHS` (`packages/api/src/server/handler.ts:57–83`) and `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts:~76`). Both list `flow.snapshot` and `flow.control`, but not `flow.tapeSpeed`.
  - `CHANGELOG.md` describes `flow.tapeSpeed` as "operator session" only.
  - The list that names `flow.tapeSpeed` (`REVIEWED_READS` in `agent-viewer.test.ts:~271`) is the agent-viewer cookie list. It is a test copy of a list built automatically from GET routes (`isAgentViewerReadProcedure` in `server/agent-viewer.ts:67–72`). Editing it is a test update, not a grant.
- **Why it matters:** the implementer must decide whether read keys get this procedure. That means deciding whether to edit `handler.ts` and `operator-access.ts`, and whether to add an MCP tool beside `flow_snapshot` in `server/mcp.ts:620`. The handler test "viewer key allowed" (line 211) is ambiguous between a viewer cookie and an API key.
- **Fix:**
  - Pick one access model.
  - For "operator session plus agent viewer, like tapeSpeed": change line 133 to "operator session or agent viewer session", and say that only the `REVIEWED_READS` expectation in `agent-viewer.test.ts` changes.
  - For read-key access: add explicit Modify entries for `handler.ts` (`AGENT_API_KEY_PROCEDURE_PATHS`) and `operator-access.ts` (`AGENT_API_KEY_READ_PROCEDURES`), state whether `mcp.ts` gets a tool, and split the handler test into "viewer session allowed" and "read key allowed".

---

#### 🟡 Majors (egm-codebase-details)

**M1. The file boundary is incomplete and not marked Create/Modify (lines 170–243).** Only some paths say "new"; test paths are given without directories. Files that must change but are not listed:

- `packages/api/src/flow-tape-speed.contract.test.ts:179–184` asserts the exact `flowContract` keys (`collect`, `control`, `snapshot`, `tapeSpeed`). Adding `hedgingPressure` breaks it.
- `packages/api/src/server/flow-collect.test.ts:~289–372` builds a fake repository with `satisfies FlowRepository`. Adding a required `readHedgingPrints` breaks typecheck there. `server/flow.test.ts:94–127` has the same pattern; the file is listed, but adding the stub is not.
- `packages/db/src/server/index.ts:~218–247` re-exports the flow repository types one by one. Any new query or row type for `readHedgingPrints` must be added there.
- `packages/api/src/index.ts` already has `export * from "./contracts/flow.ts"` (line 98), so "export the new types" (lines 189–190) is a no-op that invites an unneeded edit.
- **Fix:** give a Create/Modify table with full repository-relative paths for every source and test file, including the four above. Drop the `index.ts` step or say "no change needed (`export *`)".

**M2. The "integration database test if the repository methods are listed there" is a hedge (line 198).** The repo has a per-method precedent (`tests/integration/database/flow-tape-seconds.test.ts`, `flow-minutes.test.ts`), so the implementer has to decide.

- **Fix:** name a new `tests/integration/database/flow-hedging-prints.test.ts`. List its cases: the range is end-exclusive, rows ascend by `traded_at`, the symbol filter works, `limit` is honoured, and only the selected columns come back.

**M3. "The existing New York time helper" names no helper (lines 177–178, 199–200).** There are three candidates:

- `newYorkTime(day, minute)` in `server/merged-bars.ts:281`
- `newYorkClock` in `signal-alerts.ts:116`
- `newYorkDate` in `server/gex-context.ts:266`

The rules module also needs "16:00 New York time of `expiry`". The plan does not say which helper does that, or whether the pure root module may import from `server/`.

- **Fix:** state `sessionBounds(date) = { from: newYorkTime(date, 0), to: newYorkTime(nextDay(date), 0) }` and how `nextDay` is computed. State that `printDelta` uses `newYorkTime(expiry, 960)` imported from `./server/merged-bars.ts`, or move that computation to the server layer and pass time in.

M4. The rules module's types break the pure-rules convention and use the wrong side vocabulary (lines 176, 180–181).

- `flow-tape-speed-rules.ts:3` says "Pure; imports contract types only". `flow-tape-seconds.ts:8` defines its own row type ("same shape as FlowTapeSecondsRecord") instead of importing it from the database package.
- The plan bases `HedgingPrint` on `Pick<FlowOptionPrintRecord,…>` (`@darkfactory/db/server`) and `printSign` on `FlowOptionSideValue` (`@darkfactory/db/schema`). It gives no import paths.
- The contract's side enum `FLOW_OPTION_SIDES` (`contracts/flow.ts:58–65`) uses `not_classified`, not `unknown`.
- **Fix:** declare `HedgingPrint` locally in the rules file, field by field (with `expiry: string`, `dte`, `iv` and `underlyingPrice` as `number | null`), using the database side literals. Say that `readHedgingPrints` returns that shape. State that the rules module imports only `bsDelta` and contract types.

**M5. The date validation choice is left open (lines 187, 192).** The flow contract's existing `isoDate` (`contracts/flow.ts:223`) is regex-only and accepts `2026-02-30`. `contracts/account.ts:22–35` has a calendar-validating `IsoDateSchema`. "Refuses … a bad date" does not say which is meant.

- **Fix:** name the schema (reuse `isoDate`, or add a calendar-valid refine) and the exact bad inputs the test uses (for example `2026-13-01`, `2026-02-30`, `20261120`).

M6. The row type and handler steps are underspecified (lines 199–207).

- `buildFlowHedgingPressure(rows)` has no declared `rows` type. `buildSourceFreshness` needs `latest`, `latestOk`, `now` and `symbol` (`flow-snapshot.ts:187`).
- "Newest print" does not name `repository.newestOptionPrintAt` (`db/server/flow.ts:223,483`).
- Behaviour with no stored print is not stated (`session: null`, no read).
- The plan does not require `printDelta` and the fold to never throw. `bsDelta` throws on non-finite values, `spot <= 0`, `strike <= 0` or `sigma <= 0` (`pricing.ts:70–86`), and `assemble` turns any throw into a 503 for the whole document (`server/flow.ts:121–130`).
- **Fix:** add a `FlowHedgingPressureRows` type `{ symbol, session, prints, truncated, now, latest, latestOk }`. Name `newestOptionPrintAt` and the null-session path. State that `printDelta` guards every `check` precondition and never throws, and test that with non-finite IV.

**M7. The forbidden-answer hold for a third concurrent call is not designed (lines 230–233).** Tape speed keeps the access screen up through a dedicated `tapeForbidden` ref, re-asserted after the awaited calls (`flow-workspace.tsx:587–650`). A second un-awaited call needs its own ref. The final re-assert must cover both, and a non-forbidden hedging answer must clear only its own hold. "Like tape speed" leaves all of that to the implementer.

- **Fix:** specify a `hedgingForbidden` ref, the re-assert condition `if (tapeForbidden.current || hedgingForbidden.current)`, and the matching `flow-workspace.test.tsx` cases (a forbidden hedging answer holds the screen when the snapshot answers later; a later non-forbidden hedging answer releases only its own hold).

**M8. The lab cannot show the four fixtures as the plan describes (lines 238–240, 248).** `/lab/flow` renders the whole `FlowWorkspace` through one fake `labFlowGateway` (`lab/entries/research.tsx:184–189, 358–366`).

- That gateway returns one document per symbol. QQQ and NQ make no call.
- So only one SPY and one ES fixture can appear. The truncated and empty fixtures are unreachable, and the acceptance check "shows the four fixtures" cannot pass.
- `lab/entries/research.test.tsx:276–295` covers the flow entry and is not mentioned.
- **Fix:** state the mechanism (for example a new lab entry `flow-hedging` that renders `FlowHedgingPressurePanel` four times, or which symbol maps to which fixture). Name the fixture function and its signature, the `labFlowGateway.hedgingPressure` addition, and the `research.test.tsx` assertions.

**M9. The check command misses gates the change touches (lines 171, 247).** `bun run check` is only format check, lint and typecheck. It does not run `openapi:check` or `docs:check`, which are in `verify:core`, and it does not measure coverage (`verify:coverage`). Yet the acceptance requires 100% coverage, and the plan changes `openapi.json` and the docs.

- **Fix:** each step runs `bun run check` plus the named Vitest files. Steps 2 and 7 also run `bun run openapi:check` and `bun run docs:check`. Acceptance runs `bun run verify:core` and `bun run verify:coverage`.

---

##### 🟢 Nits (egm-codebase-details)

- **N1 (line 191):** "`bun run openapi:generate` or the script the repo uses" is a hedge. The script exists (root `package.json:66` calls `packages/api` `bun scripts/openapi.ts --write`), so drop "or …".
- **N2 (line 83, inherited by the Detailed plan):** "strike or price of 0 or less" is ambiguous, because `flow_option_prints` has an option `price` column. `HedgingPrint` does not include `price`, so write `underlying_price`.
- **N3 (lines 230–232):** the plan does not say whether the window select clears the hedging state. Tape speed is cleared there (`flow-workspace.tsx:~703–706`); hedging has no `minutes` input. Also give the panel's place in the JSX (after `<FlowTapeSpeedPanel>`, before `SnapshotView`) and the failure type (reuse `FlowTapeSpeedFailure`'s shape, `FlowControlFailure & { failedAt }`).
- **N4 (line 227):** say that `symbol` on the panel is the web `FlowSymbol` from `features/flow/view-model.ts`, and that the QQQ/NQ text is separate from the existing `notCollectedLine`.
- **N5 (lines 192–193, 210):** give the directory of each test file; the paths are relative. Rules and contract tests go in `packages/api/src/`, the server test in `packages/api/src/server/`, and the panel test in `apps/web/src/components/portal/`.
- **N6 (line 242):** `docs/debugging.md` symptoms are table rows (line 38), not "lines". Specify one table row with symptom and checks. In `flow-pipeline.md`, give where the new section goes (after "Tape speed (ES, NQ)", line 256) and which "code list" is meant; no heading of that name exists.

## egm-style

I found 0 Blockers, 6 Majors and 7 Nits in the Detailed Implementation Plan (lines 168–251). The section has no marketing language, opinions or filler. All the findings are about precision: a few steps depend on a vague reference, a conditional left open, a wrong account of how access works, or a check that cannot be measured as written. I checked each claim against the repository (read-only).

### 🔴 Blocker

None.

#### 🟡 Major

S-1 — line 200: "the existing New York time helper"

- **Discrepancy:** The phrase points to one helper, but the API package has four: `newYorkParts` and `newYorkDate` in `packages/api/src/server/gex-context.ts`, `newYorkTime(day, minute)` in `packages/api/src/server/merged-bars.ts`, and `newYorkClock` in `packages/api/src/signal-alerts.ts`.
- **Rationale:** `sessionBounds` is the part that must handle daylight-saving changes. Whoever implements it has to guess which helper is meant, and the claim that it is "DST-safe" depends on that guess. Action: CALIBRATE.
- **Fix:** Name the function and its file, for example "via `newYorkTime(date, 0)` in `packages/api/src/server/merged-bars.ts`". Or say plainly that `sessionBounds` brings its own time-zone conversion.

S-2 — line 198: "(and the integration database test if the repository methods are listed there)"

- **Discrepancy:** The condition is already settled. `tests/integration/database/flow-tape-seconds.test.ts` exists and tests the matching repository method (`readTapeSeconds`).
- **Rationale:** A conditional in an implementation step leaves a decision to the implementer that the author can make now. Action: CALIBRATE.
- **Fix:** "Integration test `tests/integration/database/flow-hedging-prints.test.ts` (pattern: `flow-tape-seconds.test.ts`): column projection, `[from, to)` bounds, ascending order, `limit`." Also say that `readHedgingPrints` is added to the `FlowRepository` type around line 202 of `packages/db/src/server/flow.ts`, as well as to the implementation.

S-3 — lines 208–209: "Add `"flow.hedgingPressure"` to the agent read list where `flow.tapeSpeed` is listed (`packages/api/src/agent-viewer.test.ts` names the list)"

- **Discrepancy:** No source file lists the procedures the agent viewer may read.
  - `isAgentViewerReadProcedure` in `packages/api/src/server/agent-viewer.ts` builds that set from every route whose method is `GET`.
  - The only literal `"flow.tapeSpeed"` entry is the list of expected values in `agent-viewer.test.ts` (line 271).
- **Rationale:** The sentence says access comes from a list. It actually comes from the route method. Someone could add the string to the test and miss that access depends on `method: "GET"` in the contract. Action: CALIBRATE.
- **Fix:** "Agent-viewer read access follows from the `GET` route method (`isAgentViewerReadProcedure`, `server/agent-viewer.ts`). Add `"flow.hedgingPressure"` to the expected list in `packages/api/src/agent-viewer.test.ts`. Do not add it to `AGENT_API_KEY_READ_PROCEDURES`, matching `flow.tapeSpeed` (`server/flow.test.ts` lines 532–534)."

S-4 — line 212 against line 133 and the Rollout section: three names for one caller

- **Discrepancy:** The same caller is called "agent read key" (line 133), "viewer key" (line 212) and "agent viewer account" (Rollout).
- **Rationale:** These are three different access paths in the code. `flow.tapeSpeed` refuses the agent API read key: `AGENT_API_KEY_READ_PROCEDURES.has("flow.tapeSpeed")` is `false`. So "operator or agent read key, like `flow.tapeSpeed`" is wrong, and a reader of step 3 cannot tell which handler test to write. Action: CALIBRATE.
- **Fix:** Use one term, "agent viewer (read-only session)", in all three places. Change line 133 to "operator or agent viewer, like `flow.tapeSpeed`; the agent API read key is refused". Add a test case "agent API key refused" to step 3.

S-5 — line 247: "`bun run check` passes; coverage of every new file is 100%"

- **Discrepancy:**
  - `bun run check` runs only `format:check`, `lint` and `typecheck`. It does not check the OpenAPI output (step 2 regenerates `openapi.json`) and does not measure coverage.
  - The coverage rule in `vitest.config.ts` requires 100% for every measured file that is not grandfathered in `scripts/ci/coverage-baseline.json`. That covers changed files too, not just new ones.
- **Rationale:** As written, the criterion can pass while the OpenAPI document is out of date or coverage has dropped. "Every new file" is narrower than the rule CI enforces. Action: CALIBRATE.
- **Fix:** "`bun run check`, `bun run openapi:check` and `bun run verify:coverage` pass. Every new or changed file not listed in `scripts/ci/coverage-baseline.json` is at 100% line, branch, function and statement coverage."

S-6 — lines 248–251: "without overflow" and "the end value equals a direct recomputation … (one-off script output in the PR)"

- **Discrepancy:**
  - "Without overflow" does not say how overflow is detected.
  - "Equals" does not give a tolerance for floating-point sums.
  - The text does not say whether the "direct recomputation" is independent of `hedgingPressure()`. A script that calls the same function proves only that it returns the same output twice.
- **Rationale:** Acceptance criteria have to be reproducible. Both claims can be met trivially or argued about indefinitely. Action: CALIBRATE.
- **Fix:**
  - Overflow: "no horizontal scrollbar: `document.documentElement.scrollWidth ≤ innerWidth` at 375 and 1440 px, light and dark".
  - Recomputation: "net, calls and puts end values match, within $1, a SQL or standalone script that recomputes the sign, delta and notional without importing `flow-hedging-pressure-rules.ts`. Attach the script and its output to the PR."

##### 🟢 Nit

S-7 — line 170: "Steps 1 to 3 are the API"
Step 3 also changes `packages/db/src/server/flow.ts`. Fix: "Steps 1 to 3 are the API and database packages."

S-8 — line 171: "the focused Vitest files"
No command is given, and package tests run through `turbo run test:unit`. Fix: name the command, for example `pnpm exec vitest run --config vitest.config.ts <test file>`, or the per-package equivalent.

S-9 — line 191: "(`bun run openapi:generate` or the script the repo uses)"
This hedge is not needed: the root `package.json` defines `openapi:generate`, which delegates to `packages/api` (`bun scripts/openapi.ts --write`). Action: DROP the clause and keep `bun run openapi:generate`.

S-10 — lines 174–175: rule fields only partly named
`volMin`, `volMax` and `minDays` are given as keys. "Rate 0, yield 0, multiplier 100" are prose. The Contract table (line 139) uses a third set of words ("dividend yield", "minimum time", "contract multiplier"). Fix: list every key of `HEDGING_PRESSURE_RULES` in code form (for example `version`, `rate`, `dividendYield`, `volMin`, `volMax`, `minDays`, `multiplier`, `readCap`) and use the same keys in the Contract table.

S-11 — line 212 and line 129: "empty symbol"
The phrase can be read as an empty-string input (a validation error) or as "a symbol with no stored prints". Step 3 also lists "no prints" separately. Fix: "symbol with no stored prints (`session: null`, `points: []`)".

S-12 — line 222: new `formatSignedCompactUsd`
`formatSignedCompact` already exists in `apps/web/src/features/openbb/view-model.ts`. Fix: state whether the new formatter reuses it, wraps it with a `$` prefix, or replaces it, so the result is not a near-duplicate.

S-13 — line 242: "code list entry"
The target list is not named. Fix: "an entry in the `Code:` list under 'What it does' (`flow-pipeline.md` line 44)."

##### Outside the DetailedRange, related to step 1

Line 90 says the 200,000 read cap is "eight times the busiest stored day". The real ratio is 200,000 ÷ 25,688 ≈ 7.8. Fix: "about 7.8 times the busiest stored day (25,688)".
