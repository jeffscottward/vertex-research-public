# Stage 8 zoom-out review: `plan.md`, lines 1–125

**Mode:** REVIEW. **Standard:** zoom-out-standard.md. **Persona:** Skeptical Architect.

**Verdict:** Fail. The plan no longer describes what is being built. The worktree's uncommitted code already uses a simpler design than the plan's Fix D. That code shows that about half of the Stage 5–7 mitigation requests are no longer needed. The remaining work is to rewrite the plan down to the code, close one shared-promise site that is still unbounded, and turn down the heavier additions the reviewers proposed.

**Context check (§0): passes.** The objective, the timeline, and the split between verified facts and the hypothesis are clear (lines 11–47). Keeping the cap, the 2 s wait and the 503 response unchanged (lines 18 and 84) is the right minimal scope.

---

## 🔴 Blockers

### B1. Fix D in the plan is the complex design; the code already uses the simple one

- **TargetFile lines:** 16, 26, 69–80, 86, 90–92, 102–105, 116–117 (and the image at line 7).
- **What the plan says.** Reclaim when a lease is idle 60 s under full pressure, or older than 10 min. Activity comes from a Drizzle `logQuery` hook. A new `idleReclaimable` option exempts order routes through `!route.startsWith("/api/orpc/vertexOrders/")`. The reclaiming request destroys the other request's socket.
- **What the worktree has.** These files are uncommitted: `packages/db/src/server/request-slots.ts`, the `client.ts` diff, `apps/web/src/server/request-scope.ts` and `packages/api/src/request-slot-age.test.ts`.
  - **No idle rule.** There is no idle reclaim, no `idleReclaimable`, no Drizzle logger, no route-prefix exemption and no cross-request socket destroy.
  - **Owner-side age limit.** Each request arms a timer in its own context (`manageRequestClient`). At `REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS = 420_000` the owner destroys its own socket and frees its slot.
  - **Fallback reclaim.** Only when the owner's timer did not run (its context is gone and `workerd` has torn down its sockets) does another request reclaim the count, at 430 s. It reports the event through its own live sink, carrying the victim's route and age.
  - **Order safety is one test.** `request-slot-age.test.ts` asserts that the max age is at least `2 × BRIDGE_TIMEOUT_MS + 30 s + 60 s`.
  - **Route label is redacted.** `requestRouteLabel` keeps oRPC procedure names and turns non-name segments into `:param`.
- **Simplicity rationale.**
  - The code design is strictly simpler. It removes the plan's three new failure modes:
    1. An alive request losing its slot mid-flight (line 91).
    2. Connections above 8 when a cross-context destroy is refused (line 92).
    3. Order-safety policy held in a URL string (line 73).
  - It also answers several Stage 5–7 blockers and majors without new machinery:
    - **ZoomOut5 #3 and #4, and Design7 M5 (event sink):** the reclaiming request emits through its own sink.
    - **Design7 B2 (zombie connections):** the owner closes its own socket, so no extra connections and no ceiling are needed.
    - **Design7 M3 (inter-query gap measurement):** there is no idle rule left to calibrate.
    - **Design7 M4 and Catalyst5 M2 (per-procedure exemption):** there is no exemption left.
    - **Design7 M6 (token in the route):** the route label is redacted.
  - A plan that still specifies the discarded design will lead the next reviewer, or a re-implementer, to rebuild it.
- **Required.** Rewrite Overview layer 2, the Lease term, Fix D, Risks, Verification and Detailed steps 5–6 to match the code. State the accepted bound in one line: "A leak that layer 1 does not catch saturates admission for at most about 7 min." The incident lasted 13 min and needed a manual restart. Also redraw the AFTER panel of the image.

### B2. One known cross-request in-flight promise is still unbounded, so line 47's invariant does not hold

- **TargetFile lines:** 15 ("Three module-level promises"), 36–38, 47 ("every cross-request wait gets a deadline that the waiter owns"), 99–101.
- **Discrepancy.**
  - **The code covers four sites, not three.** `waitAtMost` is already used at four sites. One of them is `instant-backtest.ts#columnsFor`, with `SHARED_LOAD_WAIT_MS = 30_000`, which the plan never mentions.
  - **One site has no bound at all.** `packages/api/src/server/golive-live-quotes.ts` keeps a process-wide `readers` Map (line 216). Its cache stores `quote: Promise<GoLiveQuote | null>` (line 81) and treats an in-flight read as fresh for 100 s (lines 171–174). The abort timer, `AbortSignal.timeout(45 s)` at line 143, belongs to the originating request. A scan of the other module-level caches found only settled values in `pick-lists.ts`, `sector-rotation.ts`, `research-lenses.ts`, `market-news.ts` and `basket-history.ts`. So golive is the last such site.
- **Simplicity rationale.**
  - With the owner-side age limit, this site now causes at most a 7-minute outage, not a permanent one.
  - But layer 1 exists to make that backstop unnecessary for known waits. Closing the site is one `waitAtMost` call at an existing primitive. That is cheaper than any of the mitigations proposed in Stage 7.
  - Fix the site and the count (4 → 5 sites). Do not add more reclaim rules to cover it.

---

## 🟡 Majors

### M1. `waitAtMost` sits beside an older rule in the same codebase without naming it

- **TargetFile lines:** 53, 55, 60, 64, 118 (the ARCHITECTURE.md update).
- **Discrepancy.** `packages/api/src/server/basket-history.ts` (lines 11–12, 38–40, 75) already states a rule for this hazard: "Only plain data is shared between requests (the workerd runtime forbids sharing promises…)". It uses a `claim: { at }` time lease plus polling. Fix A–C and the new `bounded-wait.ts` add a second way to handle the same hazard: share the promise, but await it only through a waiter-owned timer. AGENTS.md line 126 says to "never create a second convention beside an existing one".
- **Simplicity rationale.**
  - Converting five sites to claim-and-poll would be a larger change in behaviour: no in-flight dedupe, and polling sleeps. Keeping `waitAtMost` is the right minimal choice.
  - But the plan must say so in one sentence, and record one rule in ARCHITECTURE.md: "Share plain data across requests. When an in-flight promise is shared for dedupe, other requests await it only through `waitAtMost`."
  - That one sentence answers ZoomOut5 #1's request for a convention. It does not need a lint rule or a new review gate.

### M2. Fix A–C describe three hand-written races instead of the single primitive that exists

- **TargetFile lines:** 53, 60, 64, 113–115 (including line 113's "The waiter timer uses `setTimeout` directly").
- **Simplicity rationale.**
  - The code has one component, `bounded-wait.ts#waitAtMost`. The Fix section should name it once, with its reason: only the waiter's own timer is sure to run.
  - Each site should then get one line: its deadline, how the deadline was derived, and what happens on timeout. The 45 s derivation, for example, exists only in a code comment (`options-chain.ts`: Yahoo session 22 s plus options fetch 10 s, and QuantData two steps of 13 s each).
  - This resolves ZoomOut5 #2, ZoomOut5 #7, Comprehension6 #8 and Style7 M13 together, without new code.

### M3. The Stage 5–7 mitigations that would add complexity should be rejected explicitly in the plan

- **TargetFile lines:** none yet. This belongs in the short Alternatives paragraph (see M4).
- **Over-engineering to decline.** Each item is either made moot by the code's design or a speculative addition:
  - **Catalyst5 M1:** lazy slot acquisition, idle release and reconnect. This changes the 503 contract, needs late-capacity errors and blocks release inside transactions. It is a follow-up card at most. Keep only ZoomOut5 #5's one-line "known structural coupling, out of scope".
  - **Catalyst5 M2:** a `scope.expectExternalWait(...)` API. Moot: there is no idle rule.
  - **Catalyst5 M3 and Design7 M2:** an `AbortSignal` or request deadline passed through procedure and adapter signatures, and a per-caller total-wait cap with a typed busy error. Both add signature churn across `packages/api` for a backlog that has not been observed.
  - **Catalyst5 M4 and Design7 B1 option 5:** a health watchdog, an auto-restart or a circuit breaker. The age limit already bounds the outage. Revisit only if `request-database.slot-reclaimed` events recur in production.
  - **Catalyst5 Nit 5:** a typed `RequestDatabaseSlotReclaimedError`. Today it would be raised at most once per 7-minute request, which does not justify a new error type.
  - **Catalyst5 Nit 6:** a first-come, first-served waiter list inside the QuantData client. This adds a second waiter queue with its own stale-waiter cleanup. The current loop already re-reads `running` synchronously after each wake, so there is no herd.
  - **Design7 B2:** a ceiling on zombie connections. Moot: the owner closes its own socket.
  - **Design7 M3 and M4:** measuring inter-query gaps per route, and an exemption per procedure in oRPC metadata. Moot. Order safety is the single assertion in `request-slot-age.test.ts`.
  - **Design7 M8:** three new telemetry events for takeover, session replacement and shared-read timeout. None of the four `waitAtMost` sites has a logger or sink in scope, so this needs new sink plumbing into isolate-wide clients. Defer until the reclaim event shows a leak that layer 1 should have caught.
  - **Design7 M10:** re-justifying the cap of 8 against measured concurrency. Out of scope; the cap is unchanged by design (line 84).
  - **Structural7 M2, M3 and M5:** reshaping a bug-fix plan into the full feature-spec template (Problem Statement, Proposed Architecture, a two-part Risks & Mitigations layout, an expanded glossary). This is ceremony that adds length, not clarity.
- **Mitigations worth keeping because they simplify or cost one line:**
  - ZoomOut5 #1, #2 and #5.
  - A goals line with the outage bounds (Design7 M9).
  - Design7 M6 and M7, which the code already does.
  - A short Alternatives paragraph (M4).

### M4. There is no Alternatives paragraph; a short one would also record the simplifications

- **TargetFile lines:** between 80 and 82. Currently, line 86 is the only alternative the plan rejects.
- **Simplicity rationale.**
  - Design7 B1 and Structural7 B1 are right that alternatives are missing. Five lines are enough, not an essay:
    1. Idle reclaim under pressure: rejected because it kills live requests and needs exemptions.
    2. Cross-context socket destroy: rejected because `workerd` may refuse it; the owner closes its own socket instead.
    3. Lazy slot acquisition: a follow-up.
    4. Raising the cap: rejected.
    5. A restart watchdog: deferred.
  - Each with its one-clause reason. This paragraph is also where M3's rejections go, so future reviewers do not reopen them.

---

## 🟢 Nits

### N1. Altitude drops in the Fix section

- **TargetFile lines:** 53 (the holder shape and the `Promise.race` expression), 69 (the `acquireRequestSlot({ route, now })` signature), 74–75 (`logQuery`, `client.connection.stream.destroy()`), 78 (`index !== -1`, `splice(-1, 1)`), 113.
- **Rationale.** Move these to the Detailed Implementation Plan, or drop them once Fix D is rewritten. Several no longer match the code: `acquireRequestSlot` now takes `{ route, onReclaim }`.

### N2. The timeout policy differs by site without a stated rule

- **TargetFile lines:** 56, 60, 64.
- **Rationale.** On timeout, QuantData takes over the turn, Yahoo replaces the session, the chain read fails with `UNAVAILABLE`, and `instant-backtest` reloads with its own repository. State one rule, for example: "redo the work where it is cheap and local; fail fast where redoing spends upstream quota". This also answers Comprehension6 #9.

### N3. The scope and claims list misses the files actually touched

- **TargetFile line:** 112.
- **Rationale.** These files are missing:
  - `apps/web/*`
  - `docs/debugging.md`
  - `ARCHITECTURE.md`
  - `bounded-wait.ts`
  - `instant-backtest.ts`
  - `packages/db/src/server/semantic-layer.ts` (now passes `route: "semantic-layer/reader"`)
  - `packages/api/src/request-slot-age.test.ts`

  Also note that `apps/operator` gets the `"unknown"` route by default (Design7 N3).

### N4. The revert claim is false as stated

- **TargetFile line:** 125.
- **Rationale.** Commit 5 depends on the `route` option that commit 4 adds. State the revert order (5, then 4) instead of claiming that each commit reverts alone.

### N5. The planned ARCHITECTURE.md edit overstates a local observation

- **TargetFile lines:** 41, 118.
- **Rationale.** Write "not enforced by `workerd` as run on QuantVPS", not "applies to Cloudflare only" (Style7 M4). The current line 151 paragraph also needs a single sentence on the age limit; it does not need the reclaim heuristics.

### N6. The max-age headroom over the longest live request is not stated

- **TargetFile lines:** 71, 91.
- **Rationale.** The code uses 420 s, not 10 min. `sectorRotation/collect` (299 s) now has 121 s of headroom, and no test pins that margin, unlike the order-placement margin. State the number in Risks. Do not add machinery for it.
