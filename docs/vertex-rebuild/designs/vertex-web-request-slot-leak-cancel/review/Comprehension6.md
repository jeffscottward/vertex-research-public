# Comprehension review: `plan.md` lines 1–125

I read the plan and the embedded graphic as a reader new to the project, without opening any source files. I could paraphrase every section, so nothing blocks understanding outright. The main gaps are in how the evidence connects to the cause, and how some fixes connect to the evidence.

## What this proposes

The plan fixes an outage that lasted about 13 minutes. During it, `vertex-web` returned `503 DATABASE_CAPACITY` for every request that needed the database. The plan has two layers:

1. **Bounded waits.** Three caches or queues shared by every request get a deadline that each waiting request owns:
   - **QuantData call queue:** a waiter takes over the queue after 13 s.
   - **Yahoo session promise:** a waiter starts a new session after 22 s.
   - **Options-chain in-flight cache:** a waiter fails with `UNAVAILABLE` after 45 s and evicts the entry.
2. **Slot leases.** The 8-slot request database admission is rebuilt as leases in a new `request-slots.ts`.
   - A lease is reclaimed if it is older than 10 min.
   - When all 8 slots are taken, one lease is reclaimed if it had no query for 60 s. Order routes are exempt from this idle rule.
   - Each reclaim tries to destroy the lease's socket and logs `request-database.slot-reclaimed`.

Two smaller waiter-queue bugs are also fixed. The cap of 8, the 2 s wait and the 503 response stay the same.

## How the existing system works, per this document

`vertex-web` runs in one long-lived `workerd` isolate under `vite preview`, so module-level variables are shared by all requests. Each request scope takes one of 8 database slots before it connects and frees it when its connection closes. If no slot frees up within 2 s, the request gets the 503.

The QuantData client runs every call through a module-level promise chain. The Yahoo adapter and the options-chain cache also share in-flight promises across requests. In `workerd`, a promise continuation from a request context that has ended is dropped, and that context's timers do not run. So a shared step whose owner went away can stay pending forever. Every later caller then waits forever too, while still holding its slot.

The exact trigger of the 21:15 incident is a hypothesis, not reproduced.

## Findings

**1. 🟡 Major: the title and the graphic present the trigger as fact; the Cause section and the harness say otherwise (title, line 7, lines 36, 50).**

- The title says slots "stay taken after canceled requests".
- The graphic draws "/charts closed → shared step ∞" as the established cause.
- But the harness evidence (line 36) says a client cancel in every tested scenario leaves 0 slots taken, and line 50 labels the cancel-then-dropped-continuation mechanism "Not verified (hypothesis)".

A new reader who sees the title and image first takes away a cause the body explicitly does not claim. The title and the graphic should mark the trigger as suspected.

**2. 🟡 Major: nothing links `/charts` to the shared steps (lines 27–28, 31–33, 50).**

- The evidence offers `/charts` page loads, abandoned mid-request, as the likely owners of the stuck step.
- The stuck work that is actually observed is the `flow/collect` timer run, which goes through the QuantData queue.
- The document never says which procedures `/charts` calls. A reader has to guess that it calls `optionsAnalytics.*` or `optionsChain.*` and so shares the QuantData queue, Yahoo session or chain cache with `flow.collect`.

Without that sentence, the chain "browser navigated away → flow/collect stuck" does not close.

**3. 🟡 Major: the timeline has an unexplained connection from before the stuck run (lines 27, 30, 49).**

- Postgres shows the oldest idle app connection "open since about 21:14 UTC".
- The stuck `flow/collect` run started at 21:15:00. The previous run finished at 21:14:14.
- The document does not say which request owned the 21:14 connection, or how it fits the story.
- Separately, the Cause says "at least 8 scopes", but the evidence shows 5 connections. The reader has to work out that 8 follows from the 503 alone, with 3 scopes holding a slot without having connected yet. One sentence would make this explicit.

**4. 🟡 Major: the two waiter fixes are justified against evidence that seems to rule them out (lines 79–81 vs line 36).**

- Line 36 says "a hand-off to a canceled waiter leaves 0 slots taken".
- Line 81 adds release-time skipping "to prevent a hand-off to a waiter that can never use the slot".
- The `clearTimeout`/`splice(-1, 1)` bug (line 80) is stated as current behaviour, but it is not in the verified Evidence section.

The reader cannot tell whether these two fixes could have contributed to the incident, or are just hardening. The document should say which, and reconcile line 81 with the harness result.

**5. 🟡 Major: the order-route exemption relies on undefined order concepts (lines 73, 87).**

- The safety argument for exempting `/api/orpc/vertexOrders/*` uses "order bridge", "order intent", an intent left "unknown", "block new orders until reconciliation", and IBKR.
- None of these is defined or linked.
- "The 350 s placement lease" is a second, different kind of "lease". It collides with the defined term **Lease** (line 20). The reader has to work out that it is the `onePlacementAtATime` time lease from Fix A (line 58).

This is the highest-risk path in the plan, so its rationale should stand on its own.

**6. 🟡 Major: the "Claims" list does not cover the files the plan edits (line 112).**

- The claims are `packages/db/src/server/**` plus three `packages/api` files.
- Commits 5 and 6 (lines 117–118) also edit:
  - `apps/web/src/server/request-scope.ts` and its test
  - `apps/web/src/lib/request-database-diagnostics.ts` and its test
  - `docs/debugging.md`
  - `ARCHITECTURE.md`
- "Claims" is never defined. Presumably it means file reservations against other agents. If so, the list is incomplete. If not, a reader cannot tell what it means.

**7. 🟡 Major: the "Each commit reverts alone" claim looks wrong (line 125).**

- Commit 5 passes `route` and `idleReclaimable`, which Commit 4 adds to `RequestDatabaseOptions`.
- Commit 6 documents behaviour from Commit 4.
- Reverting Commit 4 alone would apparently break Commit 5's type-check.

The plan should state the revert order or the dependency.

**8. 🟢 Nit: the deadlines are hard to check because the defaults are not stated (lines 50, 56, 63, 67).**

- "13 s with the defaults" and "22 s" depend on `minIntervalMs` and `timeoutMs`, whose defaults are never given. The reader infers 1 s and 10 s from "the 1 s spacing" and "10 s abort timer".
- The 45 s chain-cache deadline has no derivation at all. Presumably it is chosen to exceed a QuantData wait plus a Yahoo wait, but it is not stated.
- Why Fix B uses `2 * timeoutMs` is not explained.

**9. 🟢 Nit: the three fixes handle timeout differently with no rationale (Fix A, B, C).**
A takes over the queue, B starts a new session, and C fails the request with `UNAVAILABLE`. The plan never says why C fails instead of starting a fresh read.

**10. 🟢 Nit: several Fix A and Fix D details are left to the reader (lines 56, 70, 66, 69).**

- **Fix A (line 56):** what happens when several waiters time out together is not stated. Only Detailed step 2 mentions a "waiter loop".
- **Rule 2 (line 70):** "One lease per request at most" is ambiguous. It presumably means at most one reclaim per acquire attempt.
- **`sessionFor(true)` (line 66):** the meaning of `true` is not stated.
- **`releaseRequestSlot` (line 116):** it appears only in the Detailed plan, not in Fix D.

**11. 🟢 Nit: project-specific names are used without definition (lines 15, 27–28).**

- QuantVPS, `vertex-web`, `vertex-postgres` and `:3450`. The last is presumably `vertex-web`'s port.
- "the timers (autopilot, …)" on line 15. Presumably these are scheduled jobs that call HTTP routes on `vertex-web`, but this is not stated.
- "card" in "job agent of card" and "`live-check.mjs` of card `…`".
- The names drift: "autopilot" and "research screen" (line 15) versus "`vertex-autopilot` tick" and "`research-screen` tick" (line 107).

**12. 🟢 Nit: the Verification and deployment steps assume undocumented conventions (lines 107, 120–121).**

- Why the live check must run "after 16:00 ET or before 08:30 ET". Presumably this is outside market hours.
- What `infra/quantvps/restart-when-idle.sh` does.
- The PR ritual: `Agent review: <SHA>`, `Owner decision: not needed (...)`, `scripts/merge-pr`, and the base branch `vertex/rebuild-darkfactory-20260921`.

None of these is explained or linked.

**13. 🟢 Nit: problems in the embedded graphic (line 7).**

- "503 × 245" is not supported anywhere in the text.
- The "own deadline 13 s" label overlaps the "shared step" label.
- The AFTER panel shows only the QuantData deadline (13 s), not the 22 s Yahoo or 45 s chain-cache deadlines.

**14. 🟢 Nit: list nesting in the Verification section (line 105).**
The `apps/web/src/server/request-scope.test.ts` bullet sits outside the "Failing tests first" list, while its sibling test bullets sit inside it. It is unclear whether it is also meant to be a failing-first test.
