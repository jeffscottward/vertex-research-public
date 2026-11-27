# Zoom-out review: `vertex-web-request-slot-leak-cancel/plan.md`

**Mode:** REVIEW. **Standard:** zoom-out-standard.md. **Verdict:** the root-cause fix is incomplete (one Blocker), and the safety-net layer is heavier than the evidence justifies.

**What passes.** Context is sufficient (§0). The plan states the objective, the incident timeline and the verified versus unverified cause clearly at lines 11–47. Keeping the cap, the 2 s wait and the 503 contract unchanged (lines 18 and 84) is the right minimal scope. Rejecting `idle_session_timeout` with a stated reason (line 86) shows a platform alternative was considered. A bespoke admission module is justified: a `pg` `Pool` cannot be shared across `workerd` request contexts. No new dependency or migration is added.

---

## 🔴 Blocker

### 1. The inventory of cross-request shared promises is incomplete, so the root-cause layer does not hold its own invariant

- **Affected scope:** line 15 ("Three module-level promises are shared by all requests"), lines 36–38 (Evidence: Code), line 47 ("every cross-request wait gets a deadline that the waiter owns"), Fix A–C (lines 51–64), and Verification lines 99–101.
- **Discrepancy:** A code search finds at least two more process-wide caches that share an in-flight promise across requests. Both have the same failure mode the plan names as its leading hypothesis:
  - `packages/api/src/server/golive-live-quotes.ts`:
    - `bridgeQuotesReaderFor` keeps one reader per configuration for the whole process (module `readers` Map, line 216). It is wired into the web oRPC route (`apps/web/src/app/api/orpc/[...rest]/route.ts:316`).
    - Its cache stores `quote: Promise<GoLiveQuote | null>` (lines 80–81). A read still in flight counts as fresh for `GOLIVE_QUOTES_CACHE_MS = 100_000` (comment at line 170: "a second caller waits for it instead of a new bridge run").
    - Its abort timer `AbortSignal.timeout(GOLIVE_QUOTES_TIMEOUT_MS)` (45 s) is created in the context of the originating request. This is exactly the case the plan says workerd never fires once that context ends.
  - `packages/api/src/server/instant-backtest.ts#columnsFor`:
    - The module-level `columnCache` stores `columns: Promise<MarketBarColumns>` (lines 46–52). The comment says "A load in flight is shared, so concurrent misses for one series read the bars once".
    - A hit awaits `cached.columns` with no deadline. That promise is a database load on the first request's connection.
    - Callers include `backtest-runs.ts`, `agent-ops.ts`, `agent-model-runs.ts`, `setup-replay.ts` and `backtest-run-engine.ts`.
- **Rationale:** Layer 1 claims to "stop the waits that never end" and treats layer 2 as a fallback for unknown leaks. In fact two known, structurally identical waits stay unbounded, so their callers would hold slots until layer 2 rule 2 (60 s at 8/8) or rule 1 (10 min) reclaims them. This patches the three call sites seen in this incident, not the pattern.
  - The plan should list every module-level in-flight promise that other requests can await and give each a bound. The searches found no others: `strategy-series.ts`, `market-news.ts`, `vertex-experience-adapter.ts` and `vertex-runtime-objects.ts` share promises only within one call or request.
  - It should also state the rule as a convention so new code does not reintroduce the pattern: "a promise awaited by another request must be awaited through the bounded wait". `docs/debugging.md` or `ARCHITECTURE.md` is the natural place.

---

## 🟡 Major

### 2. The plan describes three ad-hoc `Promise.race` timers instead of one shared primitive, and the worktree has already diverged

- **Affected scope:** line 53 (`Promise.race([holder.done, timer(remaining)])`), line 60, line 64, and DetailedRange lines 113–115.
- **Discrepancy:**
  - The worktree already has an untracked `packages/api/src/server/bounded-wait.ts#waitAtMost`. Its header names `quantdata-client.ts`, `options-chain-yahoo.ts` and `options-chain.ts` as users.
  - `quantdata-client.ts` is already rewritten around it: `running` and `takeTurn` are in place, and `let queue` is gone.
  - The plan never mentions this module. It still describes three separate race and timer constructions.
  - A repository-wide search found no other timeout helper: each `Promise.race` deadline in `packages/*` is hand-written (`groq.ts`, `notification.ts`, `safety.ts`, `model-relay.ts`).
- **Rationale:**
  - Leverage-existing and pattern-consistency both point to one primitive: "wait for a promise another request may own, with a timer of the waiter".
  - The Fix section should name it as the single component, with the reason the waiter must own the timer, and apply it at all five sites (Blocker 1).
  - Per-site sections should then state only the deadline value and what happens on timeout.
  - Otherwise the plan and the code drift before review ends, and AGENTS.md line 126 ("never create a second convention beside an existing one") will be broken by the next shared cache.

### 3. Fix D rule 2 (idle-under-pressure reclaim) carries most of D's complexity and new failure modes for a speculative benefit

- **Affected scope:** line 16; lines 70–74 (rule 2, the order-route exemption, Drizzle `logQuery` activity tracking); line 80; Risks lines 90–92; DetailedRange lines 116–117.
- **Simplicity rationale:**
  - Once Blocker 1 is fixed, every known shared wait ends within 13–45 s, so slots free on their own.
  - What remains is an unknown, unreproduced leak (lines 47 and 94). For that, the plan already says the reclaim event is the evidence (line 94).
  - Rule 1 (max age 10 min), the two waiter bug fixes, idempotent release and the `slot-reclaimed` event together give:
    - a bounded outage;
    - the evidence the plan wants;
    - no new policy surface.
  - Rule 2 adds the following:
    - Activity tracking through a Drizzle logger hook.
    - A new public `idleReclaimable` option on `RequestDatabaseOptions`.
    - Route plumbing into `packages/db`.
    - A safety exemption defined by URL-prefix string matching in the web composition root (line 73: `!route.startsWith("/api/orpc/vertexOrders/")`). Any future long-external-call procedure must remember to join that list, or a live request will be killed.
    - A new class of failure: an alive request loses its socket mid-flight (line 91).
  - That is speculative recovery-time optimization ahead of data. It also places order-safety policy in a string match in `apps/web` rather than in the order procedure that knows it is making a long bridge call.
- **Alternative:** Ship layer 1, the waiter fixes, the max-age reclaim and the event first. Add rule 2 only if `request-database.slot-reclaimed` events show leaks that layer 1 does not explain. If rule 2 is kept, the procedure should declare its own exemption rather than a URL-prefix list in the composition root. This is a design point to add to the plan, not code to write now.

### 4. The reclaim event's sink (whose request emits it) is unspecified, and the obvious reading routes it to a dead context

- **Affected scope:**
  - line 75: "reports `REQUEST_DATABASE_SLOT_RECLAIMED`" (no sink named);
  - line 80: route passed through `openRequestScope`;
  - line 94: "The reclaim event is the evidence";
  - line 103: "the reclaim diagnostic reaches the scope's sink".
- **Discrepancy:**
  - Diagnostic sinks are built per request (`apps/web/src/server/request-scope.ts`).
  - `createRequestDatabaseDiagnosticSink` binds them to that request's `waitUntil`, and `createEvlogSink({ request, executionContext })` binds them to that request's evlog sink.
  - The reclaimed lease usually belongs to a request whose context is gone. The plan's own terms (line 24) say its timers, continuations and scheduled work do not run.
- **Rationale:** At the architecture level, the plan must state that the requesting (live) request's sink emits the event, carrying the reclaimed lease's route, age and idle time as attributes. Otherwise the one observable proof of a remaining leak can be silently lost, exactly in the scenario it exists for. `acquireRequestSlot({ route, now })` (line 69) takes no sink, so the data flow is currently undefined.

### 5. The structural reason slots are exposed to external waits is not acknowledged

- **Affected scope:** Overview lines 13–18, Terms line 22, Cause line 46.
- **Discrepancy:** `withRequestScope` opens the database scope, which takes the slot, before `run`. The scope holds the slot for the whole request, including long upstream waits that do no database work: QuantData steps, Yahoo sessions, the IBKR bridge for up to about 320 s, and `sectorRotation/collect` at 299 s (line 91).
- **Rationale:** The incident is "external I/O stalled, and database admission was taken hostage". The plan bounds the stall and reclaims the hostage, but never says that eager slot acquisition is the coupling. Fixing it, for example with lazy connect on first query, is too large for this bug fix and should not be built now. A one-line "known structural cause, out of scope, follow-up card" would keep future readers from layering more reclaim heuristics on top.

---

## 🟢 Nit

### 6. The FeatureRange drops to code level in places

- **Affected scope:**
  - line 53: holder record shape, the `Promise.race` expression, the `stepDeadlineMs` formula;
  - line 69: `acquireRequestSlot({ route, now })` signature;
  - line 74: Drizzle `logQuery`, `lastActivityAt`;
  - line 75: `client.connection.stream.destroy()` inside `try`/`catch`;
  - line 78: `index !== -1`, `splice(-1, 1)`.
- **Rationale:** These belong in the Detailed Implementation Plan. In the Fix section, keep the component (bounded wait, admission leases), the interface (what a lease records, who emits the event) and the deadline and outcome per site. The incident-specific bug explanations at line 78 can stay as one sentence each.

### 7. Deadline derivation is inconsistent

- **Affected scope:** line 64 and line 115 (`SHARED_READ_WAIT_MS = 45_000`), compared with lines 53 and 60.
- **Rationale:** A (`minIntervalMs + timeoutMs + 2000`) and B (`2 * timeoutMs + 2000`) derive their deadlines from the upstream's own timeouts. C uses a bare 45 s with no rationale. State how 45 s follows from the Yahoo session and read timeouts, or derive it the same way.

### 8. The claims and revert statements do not match the commit plan

- **Affected scope:** line 112 (claims), line 125 ("Each commit reverts alone").
- **Discrepancy:**
  - The claims omit `apps/web/src/server/request-scope.ts`, `apps/web/src/lib/request-database-diagnostics.ts`, `docs/debugging.md`, `ARCHITECTURE.md` and the new `bounded-wait.ts`. `packages/api/src/options-analytics.test.ts` is also already modified in the worktree.
  - Commit 5 (web wiring) depends on the options added in commit 4, so commit 4 cannot be reverted alone.

### 9. The precedent citation is loose

- **Affected scope:** line 55.
- **Rationale:** `onePlacementAtATime` is a reject-on-busy time lease. Fix A is a wait-with-takeover lease. The pattern is similar, not the same. `basket-history.ts` (`claim: { at }`, "the one history request in flight in this process") is a second in-repo lease precedent worth naming.

### 10. The embedded image has issues

- **Affected scope:** line 7 / `before-after.png`.
- **Discrepancy:**
  - The "shared step" label overlaps "own deadline 13 s".
  - Only Fix A's 13 s deadline is drawn; B and C, and any added sites, are absent.
  - "503 × 245" does not appear anywhere in the text.
