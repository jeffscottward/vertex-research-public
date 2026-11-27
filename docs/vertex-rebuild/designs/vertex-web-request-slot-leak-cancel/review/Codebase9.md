# Codebase Details Goldfish: Stage 9 Implementation Readiness Review (REVIEW mode)

**Target:** `docs/vertex-rebuild/designs/vertex-web-request-slot-leak-cancel/plan.md`. I audited the DetailedRange (L110–125) against `implementation-readiness-standard.md`. I checked every code claim in L1–125 against the source at `HEAD` (`6db354c9`).

**Baseline note:** the worktree changed while I audited. `packages/api/src/server/quantdata-client.ts` has uncommitted edits, and `packages/api/src/server/bounded-wait.ts` is a new untracked file. I checked current-state claims against `HEAD`. Where the in-progress edits show that the implementer had to make a design choice the plan does not make, I cite them as evidence.

**Claims verified as accurate:**

- `REQUEST_DATABASE_POOL_MAX_CONNECTIONS = 8`, the 2 s wait (`REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS`), FIFO waiters, `retry-after: 1`, and `query_timeout` of 10 s.
- The `splice(index, 1)` behavior when `index === -1`.
- The QuantData `let queue` chain and `quantDataClientFor`, with `flow.collect`, `optionsAnalytics.*` and `optionsChain.*` as callers.
- Yahoo `let session` and `sessionFor(true)`.
- The 60 s `cache` of `Promise<ChainRead>` in `options-chain.ts`.
- `onePlacementAtATime`, its quoted comment, `BRIDGE_TIMEOUT_MS = 160_000`, and `PLACEMENT_LEASE_MS = 350 s`.
- The `OptionsChainSourceError(code, message)` signature.
- Compatibility date `2026-07-22`.
- The 30 s `waitUntil` comment in `packages/db/src/server/request-scope.ts`.
- `infra/quantvps/restart-when-idle.sh`, `scripts/merge-pr` and the `docs/debugging.md` rows.
- The routes `flow.collect`, `sectorRotation.collect`, `researchScreen.tick` and `vertexOrders.status` exist.
- The `/api/orpc` prefix. All order-bridge calls live under `vertexOrders.*`.

---

## 🔴 Blockers

### B1. L73 (repeated at L90): the submit sequence contradicts the code

- **Discrepancy:** The plan says `vertexOrders.submit` "writes the order intent, then calls the order bridge twice in a row (account, then place)", so its scope "can have no query for up to about 320 s".
- **Actual order in `packages/api/src/server/vertex-orders.ts` (L728–843):**
  1. `consumeConfirmToken`
  2. `gateway.account` (bridge call 1)
  3. `reconcileUnknown(context, store, …)`, which queries the database
  4. `requireAudit(…"submitIntent")`
  5. `store?.recordIntent(…)`, which writes to the database
  6. `gateway.place` (bridge call 2)
- **What is wrong:** The intent is written *between* the two bridge calls, not before both of them. Database queries separate the two calls. The longest gap with no query is about one `BRIDGE_TIMEOUT_MS` (about 160 s), not 320 s. `comboSubmit` (L915, `placeCombo` at L1043) follows the same shape.
- **Impact:** The conclusion still holds: order routes must not be idle-reclaimable, because 160 s is more than 60 s. But the stated mechanism and the 320 s number are false, and Risks (L90) repeats them.

### B2. L75, L80, L102–103: which sink receives the reclaim event is not decided

- **Current code:** Each `createRequestDatabase` call has its own `diagnosticSink`. In `apps/web/src/lib/request-database-diagnostics.ts`, that sink is bound to its request's `requestId`, `sink` and `scheduleBackgroundTask` (that request's `waitUntil`).
- **The gap:** A reclaim runs inside a *different* request (the one that is acquiring a slot). The plan does not say whether `REQUEST_DATABASE_SLOT_RECLAIMED` goes to:
  - the reclaimed lease's sink, which belongs to an ended context, or
  - the acquiring request's sink.
- **Why it matters:** The plan's own Terms (L24) say that an ended context's continuations and I/O do not run. Calling the dead request's `waitUntil` from another context can throw or be dropped, and the adapter's `catch` would then drop the emission without a trace. The event would be lost exactly when it matters. Risks L94 calls this event "the evidence if a slot still leaks".
- **Ambiguous tests:** L102 "with its route and age" and L103 "reaches the scope's sink" can be read either way.
- **Also undecided:**
  - whether `requestId` and `route` go into `correlation` (`CorrelationContext` has a `route` field) or into `attributes`;
  - the `outcome` value (the adapter hard-codes `"failure"`);
  - the `errorCategory`.
- **Standard:** This violates the Zero-Decision Rule on the change's primary telemetry.

---

## 🟡 Major

### M1. L112 (DetailedRange): the file boundary is incomplete and has no Create/Modify markers

- **Claims list:** `packages/db/src/server/**`, `packages/api/src/server/quantdata-client.ts`, `options-chain.ts`, `options-chain-yahoo.ts`. The last two have no directory.
- **Files the plan's own later steps touch but the list omits:**
  - `apps/web/src/server/request-scope.ts` and its `.test.ts`
  - `apps/web/src/lib/request-database-diagnostics.ts` and its `.test.ts`
  - `docs/debugging.md`
  - `ARCHITECTURE.md`
  - the `packages/api` test files
- **Markers:** No path is marked Create, Modify or Delete.
- **Shared helper:** The plan names no helper for the waiter's deadline race, which Fixes A, B and C all repeat. The in-progress implementation created an unplanned `packages/api/src/server/bounded-wait.ts` (`waitAtMost`), whose header says it is used by all three files. That file is outside the claimed allowlist.
- **Standard:** The boundary cannot serve as a write allowlist, as the standard's "Target Scope & File Boundary" requires.

### M2. L99–101 and L113–115: test files are cited as existing but do not exist

- `packages/api/src/server/quantdata-client.test.ts` does not exist.
- `packages/api/src/server/options-chain-yahoo.test.ts` does not exist.
- `packages/api/src/server/options-chain.test.ts` does not exist.
- **Where these tests live today:**
  - `createQuantDataClient` tests are in `packages/api/src/options-analytics.test.ts`.
  - Yahoo and chain-cache tests (`createYahooOptionsSource`, `setOptionsChainForTesting`) are in `packages/api/src/options-chain.test.ts`.
- **The gap:** "Add the failing test to <path>" means the file already exists. The implementer must choose between extending the existing files and creating new ones next to the code (CONVENTIONS L63, and AGENTS rule 5: "never create a second convention beside an existing one").

### M3. L113 and L53: Fix A leaves its key design decisions to the implementer

- **Clock source is unspecified:** The plan does not say whether `startedAt` and the deadline use the injected `now` or wall time. Existing tests inject `now` and `sleep` (`options-analytics.test.ts` L180–193) and do not use fake timers. The waiter timer uses "`setTimeout` directly", so a holder age measured with the injected `now` would not match the real timer.
- **Late-finish guard is missing:** The plan does not say that a holder which finishes after a takeover must not clear the newer holder.
- **Evidence:** The in-progress diff had to make both choices itself: it uses `Date.now`, and it adds `if (running === turn) running = null` with the comment "Wall time (`Date.now`) and the global timer, not the injected `now`/`sleep`…".

### M4. L99: the Fix A test cannot be built as described

- The step's own abort timer (`setTimeout(() => controller.abort(), timeoutMs)`) and the waiter's timer are both `setTimeout` calls. A test cannot make "whose own timer never fires" true for one and not the other.
- The test therefore needs a fetch double that ignores `signal`, and it must decide on fake-timer scope (`Date` included or not). The plan specifies neither.

### M5. L60 and L114: Fix B has undocumented concurrency edge cases

- **Duplicate sessions:** Every waiter that times out calls `sessionFor(true)`. N waiters on a stuck session start N new sessions (2N Yahoo requests) and overwrite `session` in turn. The plan should say whether a waiter renews only when `session` is still the same stuck promise.
- **Stale rejection clears the new session:** The existing `next.catch(() => { session = null; })` clears `session` without a check. A stuck session that rejects later wipes the newer session. Fix A states the same kind of guard; Fix B does not.
- **Renew path:** The plan does not say whether the race applies when `renew === true` (the 401 retry), where the request started the session itself.

### M6. L64 and L115: the 45 s value has no derivation

- `SHARED_READ_WAIT_MS = 45_000` comes with no rationale, unlike the 13 s and 22 s values.
- **A live `load()` can exceed 45 s:**
  - QuantData (3 starts, each behind the 13 s-bounded turn, and queued behind other callers);
  - Yahoo: 22 s session wait, then a new session (≤ 20 s), then `get` (≤ 10 s), plus a possible 401 renew;
  - sequential follow-up Yahoo reads for each expiry attempt.
- **Consequence:** Waiters on a slow but alive read then get `UNAVAILABLE`, the entry is deleted, and a duplicate `load()` starts, which spends extra QuantData budget.
- **Signature change:** `readChain` is synchronous today (it returns `Promise<ChainRead>`). The plan does not say that it becomes `async` or how the raced promise is returned.

### M7. L69 and L116: the `request-slots.ts` API is incomplete and inconsistent

- **Missing parameters:** `acquireRequestSlot({ route, now })` "returns a lease or `null`", but:
  - the call is asynchronous (it waits up to 2 s);
  - the signature omits `idleReclaimable`, which rule 2 depends on (L73);
  - the signature omits the diagnostic sink (see B2).
- **Socket destroy:** The lease must hold "a function that destroys its socket" (L26, L75), but the `Client` is built *after* admission. The plan names no method that attaches the destroy function or records activity.
- **Unexplained items:** the role of `now` (an injected clock or a timestamp); the signature of `releaseRequestSlot`; the name of the test reset seam; and whether the two constants are defined in `request-slots.ts` and re-exported from `client.ts`.
- **Collision:** `client.ts` already has private functions named `acquireRequestSlot` and `releaseRequestSlot` (L191–219). The plan does not say they are removed or replaced.

### M8. L74 (and L22): activity tracking misses callers that use the raw client

- `packages/db/src/server/semantic-layer.ts#openReaderConnection` (L280–290) calls `createRequestDatabase` and queries through `resource.db.$client`. That path bypasses the Drizzle logger, so an active reader connection never updates `lastActivityAt` and becomes idle-reclaimable after 60 s at 8/8.
- That caller also passes no `route`.
- `apps/operator/src/server/operator-auth.ts` calls `openRequestScope` with no `route` and no `idleReclaimable`.
- The plan does not mention either caller. L22 ("A request scope takes one slot") also hides that a semantic reader takes a second slot inside the same request.

### M9. L80 and L117: "no secret is in it" does not hold for the route

- The plan sets `route = new URL(request.url).pathname` for every `withRequestScope` caller, including `/api/auth/[...all]`.
- Better Auth 1.7.14 (installed) serves `GET /reset-password/:token` (`dist/api/routes/password.mjs`), which puts the password-reset token in the path.
- A reclaim of that lease would write the token into `request-database.slot-reclaimed`.
- **Fix:** The plan needs a rule for this, for example redacting auth path parameters or using the matched route template.

### M10. L102–103 and L116: the test plan ignores the existing test doubles

- **`packages/db/src/server/client.test.ts`, drizzle double:** `drizzle: vi.fn(({ client }) => …)` drops the new `logger`, so no test can simulate query activity. The plan does not say to extend the double or how.
- **Same file, clock:** It fakes only `["setTimeout", "clearTimeout"]`, not `Date`, so 60 s and 10 min lease ages need the undefined `now` seam.
- **Same file, `clearTimeout`:** The plan does not say how "`clearTimeout` does nothing" is simulated.
- **`packages/db/src/server/request-scope.test.ts`:** It mocks `createRequestDatabase` entirely (L4–10), so "the route and `idleReclaimable` reach the lease; the reclaim diagnostic reaches the scope's sink" cannot be tested there. Also, `openRequestScope` already passes all options through by spread (L65, L78), so L80's "`openRequestScope` passes the route" implies a code change that is not needed.

### M11. L119 (DetailedRange): local verification misses required gates

- `bun run check` runs only `format:check`, `lint` and `typecheck` (package.json L56).
- CONVENTIONS L65 requires 100% line, branch, function and statement coverage (`bun run verify:coverage`). The plan names no tests for these new branches:
  - the destroy `try`/`catch`;
  - the idempotent release;
  - skipping a stale waiter;
  - defaults when `route` is undefined;
  - `index === -1`.
- AGENTS L128 requires `bun run graph:update`, `graph:check` and `graph:verify` after moving public symbols. This step does not run them.
- No step runs the tests after each commit, so the standard's requirement that every phase stay testable is not shown.

### M12. L125: "Each commit reverts alone" is false

- Reverting commit 4 (new `RequestDatabaseOptions` fields) while keeping commit 5 breaks typecheck in `apps/web/src/server/request-scope.ts`.
- Reverting commit 5 alone makes every `/api/orpc/vertexOrders/*` lease idle-reclaimable again, which is the order risk L73 describes.
- With a shared deadline helper (M1), reverting commit 1 breaks commits 2 and 3.

---

## 🟢 Nits

- **L78:** "`clearTimeout` from another request context does nothing in `workerd`" is stated as fact, but the Evidence section (L39–42) does not list it among the harness findings.
- **L38:** The cache key also includes `context.marketHistory?.url` and `context.quantData?.baseUrl`, not only symbol and expiry.
- **L75:** A reclaim that destroys the owner's socket makes the owner's `client.on("error")` emit `REQUEST_DATABASE_CLIENT_ERROR`, and its later `close()` may emit `CLIENT_CLOSE_ERROR` too. These extra events are not documented.
- **L79:** Skipping waiters that have waited more than 3 s also drops a live waiter whose timer ran late on a busy event loop; that waiter then gets a 503. This is not documented.
- **L74:** `drizzleDatabase()` is shared with `createNodeDatabase`. The plan does not say how only the request path gets the logger.
- **L116:** "the package `server` entry" is `packages/db/src/server/index.ts` (L594–600); it is not named.
- **L117:** The `startsWith("/api/orpc/vertexOrders/")` check runs on the raw pathname. A percent-encoded procedure segment would bypass it if oRPC decodes segments. The route is owner-only, so this is low risk.
- **L104–105:** The bullets are nested wrongly: `request-database-diagnostics.test.ts` (`apps/web/src/lib/`) sits under the `apps/web/src/server/request-scope.test.ts` bullet.
- **L120:** `Owner decision: not needed (...)` is a placeholder.
- **Image (L7):** "503 × 245" appears nowhere in the text and has no source. The "shared step" and "own deadline 13 s" labels overlap. The image shows only the 13 s deadline and omits the 22 s and 45 s deadlines.
