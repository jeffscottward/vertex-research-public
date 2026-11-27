# Inventive Catalyst Goldfish: Stage 5 review of `plan.md` (strategic review)

**Contradiction check.** There is a real contradiction here, not a balanced design. Two parts of the plan pull against each other:

- **Reclaim safety.** Slots must be taken back from requests that stay stuck.
- **Correctness of slow but alive requests.** Order submits, `sectorRotation/collect` and other long requests do legitimate work and should keep their slot.

The plan settles this with heuristics (60 s without a database query, a 10 min age limit, an exemption for routes under `/api/orpc/vertexOrders/`) and with three separate timeouts. It does not remove the cause. Four findings are Major and two are Nits; all are advisory.

These are fixed constraints, not contradictions:

- `workerd` does not let one request do I/O on a socket owned by another request.
- Timers belong to the request context that created them.
- The cap of 8 is a deliberate policy (ARCHITECTURE.md line 151).

---

## 🟡 Major 1: a slot lives as long as the whole request, so reclaim has to guess

1. **Severity:** Major (advisory)
2. **Affected scope:** Overview line 16; Fix D lines 70–75; Risks lines 91–92.
3. **False compromise:** The plan keeps the current model, in which a request takes a slot before it does any work and gives it back only when it finishes. In `withRequestScope`, `openRequestScope` → `createRequestDatabase` runs before `run(...)`, and `finalize` runs in `finally`. So a request holds a database connection while it waits on QuantData, Yahoo or the IBKR bridge. The Evidence shows this: at line 38, 5 connections were `idle (ClientRead)` with no query running.

   Because of that, D has to infer whether a request is stuck from database inactivity. This forces three accepted costs:
   - A slow but alive request loses its slot (line 91).
   - The order routes need an exemption (line 73).
   - Socket destruction across request contexts may be refused, so more than 8 real connections can exist (line 92). With 8 connections stuck this way, Postgres could reach 16 real connections and more.
4. **Proposed resolution:**
   - **Segmentation in time (lazy, short-lived acquisition).** Take the slot and connect on the first query, through a lazy `db` proxy. Let the owning request give the slot back after a short database idle period outside a transaction, and reconnect on its next query. A request then holds a slot only while it actually uses the database.
   - **Self-Service on the owner's side.** When a lease is marked reclaimed, a timer in the owning request's own context closes its own client. This avoids the cross-context `stream.destroy()`, so the cap stays a real limit on connections instead of a count.
   - In a context that has already ended, `workerd` tears the socket down itself. The Miniflare harness showed 0 slots left after a cancel.
5. **Secondary liabilities:**
   - Each reconnect costs a TCP/TLS/auth round trip.
   - Session state is lost: idle release must be blocked inside `withTransaction` and during Better Auth background tasks.
   - The capacity 503 moves from the start of the request into the handler. It can then come after external side effects (a QuantData call already spent), so procedures need a typed late-capacity error.
   - The owner-side timer runs once per open lease.

## 🟡 Major 2: the order-path exemption is tied to URL text, not to where the wait happens

1. **Severity:** Major (advisory)
2. **Affected scope:** Line 73; line 80; Risks line 90; Detailed Implementation Plan step 6 (`idleReclaimable: !route.startsWith("/api/orpc/vertexOrders/")`).
3. **False compromise:** The plan treats "reclaim protects the cap" and "reclaim breaks writes that come after an external call" as opposites, and settles them with a route prefix fed into `packages/db`. This puts web-routing knowledge into the database layer.
   - Any future procedure that waits on an external call and then writes falls silently under the 60 s rule. `sectorRotation/collect` (299 s) and `researchScreen/tick` (117 s) are similar today (line 91).
   - Order routes stay protected for 10 min, longer than any actual bridge wait (2 × 160 s).
   - Today only `vertex-orders.ts` imports `vertex-orders-gateway.ts`, so the prefix is correct now. It is not enforced anywhere.
4. **Proposed resolution:** **Inversion.** The code that waits declares its own expected silence: for example `scope.expectExternalWait(deadlineMs, fn)` around each bridge call, or around any long upstream call. Reclaim skips a lease only inside a declared, deadline-bounded window and is allowed again once that deadline passes. This removes the prefix rule and narrows order-path protection from 10 min to the actual bridge deadline.
5. **Secondary liabilities:**
   - A new API on the request scope that call sites must use. A missed annotation brings back today's behaviour (reclaimable), which is safe for the cap but not for the write.
   - Some indirection when reading why a lease was or was not reclaimed. The reason must go into the reclaim event.

## 🟡 Major 3: three independent waiter deadlines, no end-to-end limit, and the 45 s wait is shorter than reclaim

1. **Severity:** Major (advisory)
2. **Affected scope:** Fix A lines 53–56; Fix B line 60; Fix C line 64; Overview line 15.
3. **False compromise:** Each shared step gets its own hand-tuned constant (13 s, 22 s, 45 s). The plan accepts that these do not combine into one limit per request:
   - **Waiters on a stuck chain read can still fill the cap.** In C, every request that hits the cached promise for the same symbol and expiry waits up to 45 s while holding a slot. Eight `/charts` reads of one stuck symbol can hold 8/8 for about 45 s. Reclaim rule 2 cannot act, because 45 s is below its 60 s threshold. A short outage of about 45 s is therefore still possible.
   - **Normal backlog can exceed 45 s with nothing stuck.** QuantData stays serialized with a 10 s timeout per step. With about five queued calls, the wait is roughly 5 × 11 s, above C's 45 s. Chain readers can then fail `UNAVAILABLE` while each one held a slot the whole time.
4. **Proposed resolution:**
   - **Extraction.** One helper, `awaitShared(promise, deadline)`, used at every cross-request await: A, B, C and any future shared step. The plan's count of three is right today: the other `Promise` holders found in `market-news.ts`, `strategy-series.ts`, `vertex-runtime-objects.ts` and `groq.ts` live inside one request or settle at once. Nothing prevents a fourth.
   - **A request deadline (`AbortSignal`) passed down to these waits.** Each wait uses `min(own limit, remaining request budget)`, which replaces the unrelated constants with one limit per request.
   - **Beforehand Cushioning in C.** A cache hit on an in-flight entry older than the owner's own longest possible run does not wait. It replaces the entry and starts its own read, or returns `UNAVAILABLE` at once. Its wait (`SHARED_READ_WAIT_MS`) should also be set below the reclaim threshold, or the waiters should give back their slot first (see Major 1).
5. **Secondary liabilities:**
   - Passing a signal or deadline through procedure and adapter signatures.
   - Duplicate upstream reads when an abandoned entry is replaced, which uses QuantData budget.
   - Timeout errors that are harder to trace across nested limits.

## 🟡 Major 4: when reclaim fails, the only response is a log event and a manual grep

1. **Severity:** Major (advisory)
2. **Affected scope:** Overview lines 13 and 16; line 75; Risks lines 92 and 94; live check line 108.
3. **False compromise:** The incident ended only with a manual restart after 13 minutes. In the plan, the last line of defence is the `request-database.slot-reclaimed` event plus a journal grep.
   - If the leak is not idle in the plan's sense, reclaim does not apply. For example, a stuck route under `vertexOrders`, a lease that keeps getting queries, or real connections piling up because socket destruction across contexts was refused (line 92).
   - In those cases, sustained `DATABASE_CAPACITY` returns and still needs a person.
   - `vertex-web.service` has only `Restart=on-failure`. There is no health watchdog.
4. **Proposed resolution:**
   - **Blessing in Disguise plus Self-Service.** Use the reclaim count and the rate of capacity 503s as health signals. When they stay high past a threshold, the health check fails and an automatic, order-aware restart runs, reusing the idle check of `infra/quantvps/restart-when-idle.sh`.
   - **Cheap Dispensables.** Treat the long-lived isolate as something that can be replaced, which is what the manual fix already relied on.
   - Optionally, a **circuit breaker** per route that leaks repeatedly, so callers get a fast typed error instead of taking slots.
5. **Secondary liabilities:**
   - The restart can flap if thresholds are wrong.
   - The restart must never interrupt an order placement.
   - Extra watchdog logic and its tests.
   - A circuit breaker can block a healthy route after transient pressure.

## 🟢 Nit 5: the request that lost its slot fails with a generic connection error

1. **Severity:** Nit (advisory)
2. **Affected scope:** Line 74; Risks line 91.
3. **False compromise:** A slow request whose lease was reclaimed learns about it only when its next query fails with a socket or connection error. That error cannot be told apart from a real database fault in logs or retries.
4. **Proposed resolution:** **Preliminary Action.** The same Drizzle logger or query wrapper that records activity checks `lease.released` before each query. If set, it throws a typed `RequestDatabaseSlotReclaimedError` that carries the reclaim reason.
5. **Secondary liabilities:** One flag check per query, and one more error type to map in procedures and diagnostics.

## 🟢 Nit 6: the QuantData takeover gives up first-come, first-served order

1. **Severity:** Nit (advisory)
2. **Affected scope:** Fix A lines 53–56; Risks line 93.
3. **False compromise:** The old promise chain ran calls in arrival order. The new holder record wakes every waiter on `holder.done` and lets them race again in a loop. That trades fairness for safety from stuck steps: during sustained load, an unlucky caller can lose repeated takeovers while holding its slot. This adds to Major 3.
   - Separately, the "spacing can be missed" risk (line 93) looks overstated. `send()` already sleeps until `lastStart + minInterval`, and the stuck step set `lastStart` at least 13 s earlier.
4. **Proposed resolution:** **Segmentation.** Keep an explicit first-come, first-served waiter list where each waiter runs its own timer. This is the same structure D already fixes for slot waiters at line 79, which gives safety and order together.
5. **Secondary liabilities:** A second waiter queue to maintain, and cleanup when a waiter's request context dies, which needs the same stale-waiter skip as line 79.
