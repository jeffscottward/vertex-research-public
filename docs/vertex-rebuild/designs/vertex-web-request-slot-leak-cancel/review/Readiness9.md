# Implementation Readiness Review: `plan.md`, Detailed Implementation Plan (lines 110–125)

**Verdict: the plan fails the Zero-Decision Rule.** Commits 1–3 can mostly be written from Fix A–C as they stand. Commit 4 (slot leases) leaves the core admission algorithm, its function signature and the routing of the new log event to the implementer. Several file paths, test seams and process steps also do not match the repository.

---

## 🔴 Blockers

### B1. The reclaim event may never be logged: the plan does not say which request's sink sends it

**Lines:** 116 (Commit 4), 117 (Commit 5); design at lines 75 and 80; tests at lines 102–103.

- **What the plan says:** reclaim "reports `REQUEST_DATABASE_SLOT_RECLAIMED`", and `request-scope.test.ts` (db) checks that it "reaches the scope's sink".
- **What is missing:** which sink. It could be the sink of the request that triggers the reclaim, or the sink of the request whose lease is taken.
- **Why it matters:**
  - Each request's sink is built from that request's own `waitUntil` and evlog sink (`apps/web/src/lib/request-database-diagnostics.ts`, `createRequestDatabaseDiagnosticSink`).
  - A reclaimed lease usually belongs to a request whose context is already gone. In `workerd`, scheduling `waitUntil` from that context drops the work, so the event would be silently lost.
  - That event is the plan's main evidence in production (live check, line 108; Risks, line 94).
- **Signature problem:** the proposed `acquireRequestSlot({ route, now })` (line 69) has no sink parameter and no `idleReclaimable`. So the implementer has to invent how the reclaimer reports.
- **Guidance:**
  - Send the reclaim diagnostic through the sink of the request that triggers the reclaim (the current acquirer).
  - Give the full signature, for example `acquireRequestSlot({ route, idleReclaimable, diagnosticSink, now }): Promise<SlotLease | null>`.
  - Define the `SlotLease` type with its fields (`route`, `startedAt`, `lastActivityAt`, `released`, `idleReclaimable`, `destroy`).
  - Restate the db request-scope assertion with that sink choice.

### B2. Who gets a reclaimed slot is undefined

**Lines:** 116; design at lines 70–72 and 75.

Line 75 says reclaim "hands the slot to the next waiter". Line 70 says reclaim is checked "when a slot is requested and again when a waiter's 2 s wait ends". That leaves these cases open:

1. A new request finds 8/8 and reclaims a lease while waiters are queued. Does the slot go to the head waiter (so the new request still queues), or to the new request?
2. A waiter's 2 s timer fires and reclaims a lease. The slot goes to the "next waiter", which may be the timing-out waiter itself. Does that waiter then get the slot instead of a 503? If the slot goes to a different waiter, the reclaiming waiter still returns 503. Is that intended?
3. "One lease per request at most" (line 72): one idle reclaim per `acquire` call, or per request across both checks? Is a max-age reclaim (rule 1) included in that limit, or are all expired leases reclaimed?
4. When there are no waiters, does the counter go down and then up for the acquirer, or is the slot transferred directly?

Test (1) at line 102 ("the 9th request must get a slot") only covers the no-waiter case.

**Guidance:** write `acquire`, `release` and `reclaim` as pseudo-code with explicit FIFO rules. Add one test with queued waiters plus a reclaim.

---

## 🟡 Major

### M1. The plan does not say which clock measures ages and deadlines

**Lines:** 113, 116; design at lines 52, 69 and 79.

- **Lease ages and stale waiters (`packages/db`):**
  - `acquireRequestSlot({ route, now })` does not say whether `now` is a timestamp, an injected `() => number`, or `Date.now`.
  - `packages/db/src/server/client.test.ts` fakes only `["setTimeout", "clearTimeout"]`, not `Date`. The 60 s and 10 min tests and the "waited longer than 3 s" skip test cannot advance a `Date.now`-based clock in that setup.
  - Existing tests also assert `vi.getTimerCount()` is 0.
- **QuantData holder age (Fix A):**
  - The holder's `startedAt` could use the injected `options.now` or `Date.now`; the plan does not say which.
  - Existing tests inject a manual `now: () => clock` (`packages/api/src/options-analytics.test.ts`), while the new waiter timer uses real `setTimeout`.
  - If the age uses the injected clock and the test does not advance it, the waiter computes the same 13 s remaining after every wake and never takes over.
- **Guidance:** state the clock for each component (for example "holder age uses `options.now`", "request-slots uses an injected `now` set through the test seam"). Also state the fake-timer setup each new test uses.

### M2. Fix A does not protect a newer holder from an older holder's late finish

**Lines:** 113 (Commit 1); design at line 52.

- After a takeover, the old stuck step may still settle later. Its cleanup must clear the holder only if it is still the current holder.
- `vertex-orders.ts#onePlacementAtATime`, which the plan cites as precedent, does exactly this: `if (placingUntil === lease) placingUntil = 0`.
- Fix C states this guard ("only when the entry is still the same"); Fix A does not.
- **Also unspecified:**
  - `done` must be a promise that never rejects.
  - The wake order when several waiters see `done` resolve at once: the loop must re-check the holder, and FIFO is lost.
  - The waiter's timer must be cleared when `done` wins the race.
- **Guidance:** write out the holder type and the loop, including the identity-guarded release. Add a test: "a stale holder that settles after a takeover does not end the new holder".

### M3. Fix B lets several timed-out waiters each start a new Yahoo session

**Lines:** 114 (Commit 2); design at line 60.

- Every request that waited on the stuck session times out after 22 s and calls `sessionFor(true)`. Each call opens a new session and overwrites `session`.
- The existing failure handler `next.catch(() => { session = null })` is not identity-checked. If the abandoned promise rejects late, it erases a newer good session.
- **Not specified:**
  - Whether the race also applies when this call started the session itself, or on the 401 `renew = true` path.
  - Clearing the race timer.
- **Guidance:**
  - On timeout, renew only if `session` is still the stale promise; otherwise use the current session.
  - Change the failure handler to `if (session === next) session = null`.
  - Apply the race only to a session started by another request.

### M4. The list of files to change is incomplete and uses a glob

**Lines:** 112.

- The claims list `packages/db/src/server/**` is a glob. The standard allows globs only for generated output.
- **Files changed or created in later steps but missing from the list:**
  - `apps/web/src/server/request-scope.ts` and `apps/web/src/server/request-scope.test.ts`
  - `apps/web/src/lib/request-database-diagnostics.ts` and its test
  - `docs/debugging.md`
  - `ARCHITECTURE.md`
  - the three new `packages/api/src/server/*.test.ts` files
- `options-chain.ts` and `options-chain-yahoo.ts` are listed without a directory.
- **Guidance:** give one repository-relative list of every file to create or modify, and use it as the write allowlist.

### M5. Test file paths and test seams do not match the repository

**Lines:** 113–117; design at lines 99–105.

- **Missing files:** `packages/api/src/server/quantdata-client.test.ts`, `options-chain-yahoo.test.ts` and `options-chain.test.ts` do not exist.
  - "Add the failing test to" reads as if they do.
  - The existing tests of this code are `packages/api/src/options-chain.test.ts` (Yahoo, chain cache, `setOptionsChainForTesting`) and `packages/api/src/options-analytics.test.ts` (QuantData client).
  - Say whether to create new files next to the code (CONVENTIONS.md line 63) or extend the existing ones and reuse their fixtures.
- **The db request-scope test cannot check what the plan says:** `packages/db/src/server/request-scope.test.ts` replaces `./client.ts` with a mock (`vi.mock("./client.ts", ...)`).
  - It can only check that options are passed to `createRequestDatabase`.
  - It cannot show that "the route and `idleReclaimable` reach the lease" or that "the reclaim diagnostic reaches the scope's sink" (line 103).
  - No detailed step creates or edits that test.
- **Vague test step:** step 6 says only "Update tests". The existing `toHaveBeenCalledWith({...})` assertion at `apps/web/src/server/request-scope.test.ts:115` compares the exact object and will fail once `route` and `idleReclaimable` are added.
- **Unnamed seam:** the name, export and `beforeEach` use of the module-state reset in `request-slots.ts` are not specified.

### M6. The 100% coverage requirement is not addressed

**Lines:** 113–117.

- AGENTS.md rule 4 and CONVENTIONS.md line 65 require 100% line, branch, function and statement coverage. The new `request-slots.ts` is not on the coverage-baseline list, so it must reach 100%.
- **Branches the listed tests (lines 99–105) do not reach:**
  - socket `destroy()` throwing during a reclaim
  - a reclaim attempted while the slot is already released
  - Fix C's "entry is no longer the same" path
  - Fix A's late finish of a stale holder (M2)
  - Fix B's "session already renewed" path (M3)
  - a timer cleared when the shared promise settles first
  - the default branch of the diagnostic mapping
- **Guidance:** list the branch cases per file, or state explicitly that 100% coverage of the changed files is an acceptance criterion of each commit.

### M7. Database activity from other callers is not tracked

**Lines:** 116; design at lines 74 and 80.

- `packages/db/src/server/semantic-layer.ts:283-288` (`openReaderConnection`) calls `createRequestDatabase` directly, with no route. It then runs raw queries through `$client`, which bypasses the Drizzle logger.
- Its lease therefore records activity only at connect. Under full load it can be reclaimed after 60 s while still running queries, and its event has no route.
- `apps/operator/src/server/operator-auth.ts:65` (`openRequestScope`) also passes no route.
- **Guidance:** pick one:
  - track activity at the `pg` `Client.query` level instead of the Drizzle logger, or
  - make the semantic reader non-reclaimable, or
  - set a fixed route label for it.

  Also state the route value used when none is given.

### M8. The lease's socket-destroy function cannot exist when the lease is created

**Lines:** 116; design at lines 23 and 75.

- The lease is created in `acquireRequestSlot`, before `new Client(...)` exists. The plan does not say how the lease gets its destroy function (a setter, a mutable field, or a callback passed later).
- **Other gaps:**
  - When activity starts counting: when connect starts or when it finishes.
  - Destroying the socket makes the owning client emit `error` while `closing` is false. That emits `REQUEST_DATABASE_CLIENT_ERROR` on the owner's (dead) sink. Is that expected, or suppressed?
  - `closeRequestDatabaseClient` currently calls `releaseRequestSlot()` with no argument. The plan does not say it must now release its own lease, or how the lease reaches it.

### M9. Commit 4 cannot be reverted on its own

**Lines:** 123–125.

- Commit 5 passes `route` and `idleReclaimable` to `openRequestScope`. Its diagnostics `switch` also uses `REQUEST_DATABASE_SLOT_RECLAIMED`.
- Reverting commit 4 alone removes those option fields and that code from the types. The code no longer type-checks, so `bun run check` fails.
- **Guidance:** state the revert order (commit 5 before commit 4), or change the statement to "revert commits 4–6 together".

### M10. Local verification depends on a harness that is not in the repository

**Lines:** 119; design at lines 49–52 and 106.

- No Miniflare or `workerd` harness exists in the worktree. A search found only `CHANGELOG.md`, `packages/storage/src/r2-binding.ts` and this plan.
- An implementer cannot run "the Miniflare harness against local Postgres".
- **Guidance:** name its location, add it to the file list, or drop it from the required steps.

### M11. The deploy step skips the repository's pre-deploy CI rule

**Lines:** 121.

- AGENTS.md line 187: before deploying, dispatch full manual CI on the deploy SHA. Check that the run's `head_sha` matches. Require the core, coverage, integration and browser checks to pass (`browser_tests: on` when `BROWSER_TESTS` is off).
- A passing pull-request `ci-gate` does not replace this.
- Step 10 goes straight from "build the merged SHA" to `restart-when-idle.sh`.

---

## 🟢 Nits

- **Lines 114, 115:** `SESSION_WAIT_MS` is written as a module constant, but it depends on the per-instance `timeoutMs` (`options.timeoutMs ?? TIMEOUT_MS`, `options-chain-yahoo.ts:171`). Say that it is computed inside `createYahooOptionsSource`. In Fixes A–C, say that each race clears its timer when the shared promise settles first.
- **Line 116:** "Export the two new constants from `client.ts`": say which file defines them (`request-slots.ts` or `client.ts`). Also say whether `REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS` and the waiter queue move to `request-slots.ts`; existing tests import the wait constant from `client.ts`.
- **Line 116:** `RequestDatabaseDiagnostic` is currently `Readonly<{ code }>` with frozen constants. Say whether the reclaim diagnostic is a union member with required fields or the same type with optional fields (the plan says optional). Give the type of `reason` (`"max-age" | "idle-under-pressure"`).
- **Line 117:** the event mapping always sets `outcome: "failure"` and `errorCategory`. Give the `outcome`, `errorCategory` and the exact `attributes` keys and types for `request-database.slot-reclaimed`.
- **Line 117:** `idleReclaimable: !route.startsWith(...)` refers to `route` before it is defined. Write it as two statements on one computed `pathname`.
- **Line 118:** `docs/debugging.md` row 12 already covers all `request-database.*` events. Give the exact new text for the 503 row and the event row, and the replacement sentence for ARCHITECTURE.md line 151.
- **Line 119:** list the exact test files for "each changed test file", consistent with the M5 decision.
- **Line 120:** the `Owner decision: not needed (...)` reason must be at least 20 characters (`scripts/ci/merge-conditions.ts`). None of the changed paths match an owner-decision prefix or keyword, so this line is fine; supply the actual reason text.
