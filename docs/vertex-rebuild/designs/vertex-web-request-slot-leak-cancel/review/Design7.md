# Design Critic Report: `plan.md` FeatureRange lines 1–109

**Target:** `docs/vertex-rebuild/designs/vertex-web-request-slot-leak-cancel/plan.md`
**Standard:** `feature-spec-standard.md`
**Mode:** REVIEW

**Totals:** 2 🔴 Blockers, 10 🟡 Majors, 6 🟢 Nits.

The plan clears the standard's Problem Statement and Proposed Architecture bars. It fails the mandatory Alternatives Rule. Its Risks section leaves open its most dangerous new behaviour: reclaiming a slot that has a live socket on a shared Postgres. It also states the Cause as more verified than its own evidence supports.

---

## 🔴 Blockers

### B1. There is no Alternatives Considered section

- **Severity:** Blocker
- **Lines:** 11–109 (the whole FeatureRange). Only line 86 rejects anything (`idle_session_timeout`).
- **Finding:** The standard's Alternatives Rule says a spec "fails this standard if it proposes a single path without proving that other viable designs were considered and rejected." The plan gives one path: per-waiter deadlines plus cross-context lease reclaim. Several viable designs are never weighed:
  1. **Acquire the database slot lazily, or release it around non-database waits.** `apps/web/src/server/request-scope.ts` calls `openRequestScope` before `run()` for every request. So a request waiting on QuantData, Yahoo or a shared promise holds a scarce database slot. `docs/debugging.md:11` also says each signed-in page takes two scopes (theme and session). This is the amplifier: a non-database stall becomes a database outage.
  2. **An owner-side watchdog.** Each scope would arm its own timer in its own request context and close its own client at max age or idle. In the incident, the stuck requests were alive and waiting (one request was open for 714 s). Their own timers would run, and their own socket destroy would be legal. That avoids the cross-context destroy problem in Fix D (see B2).
  3. **Remove cross-request sharing instead of bounding it.** Options:
     - Per-request Yahoo sessions.
     - A cache that stores only settled values, so there is no in-flight `Promise<ChainRead>` for other requests to await.
     - Applying the non-promise time-lease pattern (line 55) to all three sites.
  4. **Change the cap of 8 or the pooling model.** The cap is kept on lines 18 and 84 without a reason. Hyperdrive and the Postgres budget are not discussed.
  5. **A supervisor backstop.** For example, a systemd or health-check restart on a sustained `DATABASE_CAPACITY` rate. Only a manual restart fixed the incident.
  6. **Effect concurrency primitives** for timeouts and cancellation (AGENTS.md:153). If rejected, say why.
- **Recommendation:** Add an "Alternatives Considered" section. Give each option a concrete technical rejection reason: complexity, behaviour under `workerd` cross-context rules, or connection budget.

### B2. Reclaim removes the only bound on real Postgres connections, and its key premise is unverified

- **Severity:** Blocker
- **Lines:** 16, 75, 86, 92 (Evidence 39–42 has no supporting check)
- **Finding:** Reclaim runs in the reclaiming request's context and destroys another request's socket. The plan itself says `workerd` "can refuse I/O on another request's socket" (line 75). In the incident pattern the owner's context is alive and waiting, so the destroy is likely refused. The connection then stays open until that owner ends, which for a truly stuck owner means until the isolate restarts (line 92). Today the cap bounds leaked connections at 8; after this change each reclaim can add one more, with no limit.
  - The Postgres is shared: line 86 says "other QuantVPS services may share the role."
  - "Postgres allows 100 connections" (line 92) is asserted with no source.
  - A recurring trigger could therefore turn a web-only outage into a database-wide one that hits non-web services.
  - "Each reclaim is logged" is monitoring, not mitigation.
  - The Miniflare harness (lines 39–42) never tested a cross-context `stream.destroy()`.
- **Recommendation:**
  - Test cross-context destroy in the harness, and record whether it succeeds or is refused.
  - Count reclaimed-but-not-destroyed ("zombie") leases. Add a hard ceiling (for example ≤ 8 extra) and stop reclaiming at that ceiling.
  - Prefer owner-side self-close (B1 option 2), with cross-context reclaim only as a last resort.
  - Verify and cite `max_connections` and the other services' connection budgets.

---

## 🟡 Majors

### M1. The "Verified" cause overstates the evidence and leaves contradictions unresolved

- **Severity:** Major
- **Lines:** 31, 34, 40, 46, 78–79
- **Findings:**
  - **Line 46** says "at least 8 scopes waited," but line 34 shows only 5 idle app connections. Three slots are unexplained: possibly leaked counts with no connection, or scopes stuck in connect or close. The fix chosen for those three depends on which it is.
  - **The oldest idle connection dates from about 21:14** (line 34). That is earlier than the flow/collect run that stuck at 21:15:00 (line 31), so the first stuck scope probably was not flow/collect. The narrative should say so.
  - **The 714 s open request is not reconciled with the 170 s timeout.** `packages/api/src/server/flow.ts:145-150` documents a 170 s scheduler timeout for collect runs, yet the flow/collect request stayed open 714 s (line 31). Either the scheduler never canceled it, or a cancel did not release the slot.
  - **The harness skipped the incident's actual scenario** (line 40): a client cancel while awaiting a promise owned by another, already-ended request.
  - **Line 78** states "`clearTimeout` from another request context does nothing in `workerd`" as fact, but it is not in Evidence (verified).
  - **Line 79 fixes a hand-off to a dead waiter, but line 40 says that hand-off already leaves 0 slots taken.** The plan does not explain the contradiction.
- **Recommendation:** Downgrade line 46 to what was observed (5 connections, 8 counted slots). Add the cross-context-promise cancel and cross-context `clearTimeout` cases to the harness. Reconcile the 170 s versus 714 s timing.

### M2. Deadlines do not compose, and the remaining outage windows are never quantified

- **Severity:** Major
- **Lines:** 53, 56, 60, 64, 72
- **Findings:**
  - **The 45 s cache deadline has no derivation.** In `options-chain.ts#load`, QuantData (3 starts through the serialized turn, 13 s each), IBKR and the first Yahoo read run in parallel. The first Yahoo read alone can take a 22 s session wait plus a 10 s read. After that, up to two sequential follow-up Yahoo reads can add 10 s each. A live read can therefore pass 45 s. Waiters then get a false `UNAVAILABLE` and delete the entry, which triggers a duplicate read.
  - **Fix C still allows a full outage of up to 45 s.** Waiters keep their database slots while they wait, and each waiter's timer starts when that waiter arrives. A run of `/charts` requests on one stuck key can hold 8/8 slots for more than 45 s. Sign-in gets 503 throughout. Idle reclaim (60 s) cannot act inside that window.
  - **Fix A bounds each holder but not each waiter's total wait.** A QuantData caller behind N live steps waits about N × 13 s while holding a database slot. Nothing caps that.
- **Recommendation:**
  - Derive every deadline from a budget for the operation it protects.
  - Add a per-caller total-wait cap that fails fast with a typed "busy" error.
  - State in Risks the worst-case unavailability left after the fix.

### M3. The idle-reclaim risk analysis answers the wrong question

- **Severity:** Major
- **Lines:** 72, 91
- **Finding:** Line 91 justifies safety with *total* request durations (299 s, 117 s, 64 s, 47 s). Those numbers only address the 10-minute rule. The 60 s rule depends on the longest *gap between queries*, and no gap data is given. Full pressure is not rare: line 33 records up to 6 capacity 503s per hour. Collectors that wait on external providers between writes are the likeliest victims, because rule 2 picks the oldest database activity. Killing one can leave a collection run partly written. Fix A's longer QuantData queue waits make gaps longer.
- **Recommendation:**
  - Measure the maximum inter-query gap per route.
  - State whether each collector's writes are transactional or idempotent.
  - Consider exempting timer collectors, or choosing the victim by "waiting on a known-dead shared wait" rather than by oldest activity alone.

### M4. The order-route exemption is a fragile path-prefix string

- **Severity:** Major
- **Lines:** 73, 80, 90
- **Findings:**
  - **The prefix depends on the current URL layout.** `idleReclaimable` is derived from `pathname.startsWith("/api/orpc/vertexOrders/")`. Any future route of the shape "write intent → long external call → write outcome" placed outside that prefix is silently reclaimable. That conflicts with AGENTS.md:99: "Unknown broker acceptance blocks retry until reconciliation."
  - **No inventory of such routes is given.** Current candidates such as `nautilusArm` (15 s) and `ibkrRecovery` (10 s) look safe today, but the plan does not show the check.
  - **The 10-minute rule is safe for orders only while `PLACEMENT_LEASE_MS` (350 s, from `BRIDGE_TIMEOUT_MS`) stays below it.** Nothing enforces that.
  - **Line 90 says the PR changes no order code**, yet it changes when an order request's connection can be killed.
- **Recommendation:**
  - Declare non-reclaimability per procedure (oRPC metadata or an explicit allowlist with a test listing it).
  - Add a test or compile-time assertion that `REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS > PLACEMENT_LEASE_MS` plus a margin.

### M5. It is unclear which request's sink emits the reclaim event, and it can be lost silently

- **Severity:** Major
- **Lines:** 75, 80, 94, 103
- **Finding:** The diagnostic sink (`apps/web/src/lib/request-database-diagnostics.ts`) captures *its own* request's evlog sink, `waitUntil` and `requestId`.
  - **If the reclaimer calls the victim's sink,** that is cross-context I/O and `waitUntil`. A failure there is swallowed by `emitRequestDatabaseDiagnostic`'s catch (`client.ts:150`). The event that line 94 names as "the evidence if a slot still leaks" could disappear.
  - **If it calls its own sink,** the event's `requestId` is the reclaimer's, not the victim's.
  - Line 103 ("reaches the scope's sink") does not say which scope.
- **Recommendation:**
  - Specify that the reclaiming request emits the event, carrying the victim's route, age and original `requestId` as attributes.
  - Test the cross-context path in the harness.

### M6. The route attribute can leak a password-reset token

- **Severity:** Major (security)
- **Line:** 80
- **Finding:** The route is the "URL path without query." Better Auth's password-reset link is `/api/auth/reset-password/<token>`, which goes through `withRequestScope` via the auth handler (`packages/auth/src/server.ts:577` enables `sendResetPassword`). The token is in the *path*, so line 80's claim "No secret, query text or user data is in it" is false. The chance of logging it is low, because such requests are short.
- **Recommendation:** Log a route template or the oRPC procedure path, not the raw pathname. Redact dynamic auth path segments, and add a test for it.

### M7. Fix B can start many Yahoo sessions at once

- **Severity:** Major
- **Line:** 60
- **Finding:** On timeout, every waiter calls `sessionFor(true)`, which renews unconditionally (`options-chain-yahoo.ts` `sessionFor`/`request`). N waiters that time out together start N parallel cookie+crumb handshakes, which risks Yahoo rate limiting or blocking. Each one also overwrites `session`. Fix C already uses the correct "only if the entry is still the same" guard (line 64).
- **Recommendation:** Renew only if `session` is still the stale promise that timed out (compare-and-swap). Otherwise await the newer session.

### M8. Fixes A–C time out silently, so the hypothesis can never be confirmed

- **Severity:** Major
- **Lines:** 47, 56, 60, 64, 94
- **Finding:** The trigger is explicitly unverified (line 47). After the fix, a recurrence will usually be absorbed by Fixes A–C before any slot is reclaimed. No event is emitted for a QuantData takeover, a Yahoo session replacement or a chain-read timeout, so the leading hypothesis stays untestable in production.
- **Recommendation:** Emit structured events for each, for example `quantdata.step-takeover` (holder age), `options-chain-yahoo.session-replaced` and `options-chain.shared-read-timeout`. Add a matching grep to the line 108 live check.

### M9. Goals and success criteria are missing

- **Severity:** Major (standard compliance)
- **Lines:** 11–18, 82–86, 96–108
- **Finding:** "Not changed" (82–86) works as non-goals, but there are no explicit goals and no measurable acceptance criteria. Examples of the missing criteria:
  - The maximum time a stuck shared step may keep admission saturated.
  - Zero manual restarts for this failure mode.
  - A bound on extra Postgres connections.

  The live check (line 108) is three headless runs on a trigger the plan admits it cannot reproduce on demand (line 94). A clean run therefore proves little.
- **Recommendation:** Add a Goals section with numeric targets that the post-deploy checks and events (M8) can measure.

### M10. The structural cause is kept without justification

- **Severity:** Major
- **Lines:** 18, 22, 84
- **Finding:** The design keeps two things unexamined:
  - Every database-backed request holds a slot for its entire lifetime, including external waits.
  - The cap is 8, and each page render takes 2 scopes (`docs/debugging.md:11`).

  A few slow external calls can still saturate admission with no promise stuck at all. The plan does not show which routes held the 8 slots at 21:15:46. It also does not say whether page-render scopes from the five `/charts` loads (line 32) contributed.
- **Recommendation:** Account for the 8 holders by route class, and justify the cap of 8 against measured concurrency (see also B1 options 1 and 4).

---

## 🟢 Nits

### N1. The image states a hypothesis as fact and adds claims the text does not make

- **Severity:** Nit
- **Line:** 7 (`before-after.png`)
- **Finding:**
  - "/charts closed → shared step" is drawn as the established Before state, but the text calls it a hypothesis (line 47).
  - "503 × 245" appears nowhere in the text.
  - The "shared step" and "own deadline 13 s" labels overlap.
  - Only the 13 s QuantData deadline is shown; the 22 s Yahoo and 45 s cache deadlines are missing.
- **Recommendation:** Mark the trigger as hypothesized, cite the 245 count, fix the overlapping labels and show all three deadlines.

### N2. The "three module-level promises" claim has no stated audit

- **Severity:** Nit
- **Line:** 15
- **Finding:** A quick search of `packages/api/src/server` found no other module-level shared in-flight promises. The plan should still say how the three were established as the complete set, and consider a lint or review rule against cross-request promise sharing.

### N3. The operator app inherits the new defaults unmentioned

- **Severity:** Nit
- **Line:** 80
- **Finding:** `apps/operator/src/server/operator-auth.ts` also calls `openRequestScope`. It would get no route and `idleReclaimable: true` by default. The app is dev-only, but the plan should say so.

### N4. The waiter-skip rule assumes a missed timer means a dead context

- **Severity:** Nit
- **Line:** 79
- **Finding:** An event-loop stall longer than 1 s would also skip a live waiter. The effect is benign (it would 503 anyway), but the plan should say so. It should also state that skipped waiters are removed from the queue.

### N5. Activity tracking only sees Drizzle queries, at their start

- **Severity:** Nit
- **Line:** 74
- **Finding:** Drizzle's `logQuery` fires when a query starts, and only for Drizzle-issued queries. Raw `client.query` calls would not refresh `lastActivityAt`. The plan should state this assumption.

### N6. Verification list indentation is wrong

- **Severity:** Nit
- **Line:** 104
- **Finding:** `apps/web/src/server/request-scope.test.ts` is a top-level bullet, but it belongs in the "Failing tests first" list (lines 99–105).
