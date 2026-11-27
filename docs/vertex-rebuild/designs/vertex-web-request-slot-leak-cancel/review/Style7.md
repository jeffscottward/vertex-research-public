# Style Goldfish report: `plan.md`, lines 1–109

**Mode:** REVIEW. **Scope:** FeatureRange lines 1–109 and the embedded image `before-after.png`.

I checked the plan's facts against the code. These match:

- the cap of 8 and the 2 s wait (`client.ts:130`, `:186`)
- `query_timeout` of 10 s (`client.ts:129`)
- the code path behind the `splice(-1,1)` claim (`client.ts:213-214`)
- QuantData `queue` and `timeoutMs` (`quantdata-client.ts:191`, `:209`, `:456-465`)
- Yahoo `TIMEOUT_MS = 10_000`
- chain `CACHE_TTL_MS = 60_000`
- `BRIDGE_TIMEOUT_MS = 160_000` and `PLACEMENT_LEASE_MS = 2*BRIDGE+30_000`
- the `onePlacementAtATime` comment
- compatibility date 2026-07-22

The computed values are also correct: 13 s, 22 s, about 320 s and 350 s. The findings below cover framing, calibration and clarity.

---

## 🔴 Blocker

None.

---

## 🟡 Major

**M1. Lines 7 and 13 (image alt text, Overview "This plan fixes the cause").** **CALIBRATE**

- The alt text says "one stuck shared step held all 8 request database slots". Line 13 says the plan "fixes the cause".
- Line 47 says what made the first step stop is "Not verified (hypothesis)", and the harness "did not reproduce this on demand". Line 46 verifies only that at least 8 scopes waited. It does not verify that one shared step held all of them.
- The image's "BEFORE" panel (`/charts closed → shared step → …`) shows the hypothesized trigger as fact.
- Fix: describe the hypothesis as the likely cause, and the fix as deadlines on the three identified shared waits plus slot reclaim. Do not say "fixes the cause".

**M2. Image "AFTER" panel (`200 ✓`) and "503 × 245".** **CALIBRATE**

- The plan is a Draft, so the AFTER panel shows a fix result that has not been observed yet. Label it "expected".
- The count 245 does not appear anywhere in lines 1–109, so a reader cannot check it. Add the number and its journal source to Evidence (line 30–33) or remove it from the image.
- Nit: the labels "shared step" and "own deadline 13 s" overlap. The 13 s label shows only Fix A's deadline. The 22 s and 45 s deadlines are not shown.

**M3. Line 24 (Terms, "Request context").** **RELOCATE / CALIBRATE**

- A glossary entry states a behavior as fact: "when that context is gone, `workerd` drops the continuation".
- That behavior is the mechanism of the unverified hypothesis in line 47, and the harness did not reproduce it.
- Fix: move the behavioral sentence to Cause, cite its source (workerd documentation or source), and keep only the definition in Terms.
- Nit: the parenthetical `"handle_cross_request_promise_resolution"` reads like a quoted log line. Label it "compatibility flag".

**M4. Line 41 ("The 30 s limit … applies to Cloudflare only").** **CALIBRATE**

- The evidence is one local `workerd` run where a 40 s task finished. That supports "does not apply in local `workerd` 1.20261023.1". It says nothing about Cloudflare's limits.
- The same broad claim is planned for `ARCHITECTURE.md` (line 118, outside this range), so the overstatement would reach permanent docs.

**M5. Lines 39–42 under heading "Evidence (verified)" (line 28).**

- The Miniflare harness has no path or commit, and line 106 calls it "local evidence, not a CI test". A reader cannot re-run it.
- Fix: name the harness location, or label these bullets as unreproducible local observations.

**M6. Line 46 ("at least 8 scopes waited").** **CALIBRATE**

- The only direct observation is 5 idle connections (line 34). The figure 8 is inferred from every request getting 503.
- Fix: state the inference, for example: "8 slots were taken (every admission failed); 5 had idle connections; the other 3 held slots without a visible connection."

**M7. Line 47 ("every cross-request wait gets a deadline").** **CALIBRATE**

- Fix A–C adds deadlines to three specific shared promises (line 15 says "Three module-level promises"). "Every" claims more than that. Any unidentified shared promise is covered only by reclaim (Fix D).
- Fix: "each of the three identified cross-request waits gets a deadline".
- Nit: "The leading candidate" implies ranked alternatives that are never listed. Use "The candidate" or list the alternatives.

**M8. Lines 40 vs 78–79 (contradiction between evidence and rationale).**

- Line 40 says a "hand-off to a canceled waiter leaves 0 slots taken" in the harness.
- Line 79 justifies skipping old waiters because a waiter's "request context is gone" and it "can never use the slot". That describes a leak the evidence says does not happen.
- Line 78 states "`clearTimeout` from another request context does nothing in `workerd`" as fact, but this does not appear in Evidence.
- Fix: list both `workerd` behaviors as harness findings with results, or mark them as inferences. Also say whether skipping old waiters fixes an observed leak or is defensive.

**M9. Line 53 / line 56 (Fix A semantics and "at most 13 s").**

- "When the holder finishes or becomes older than the deadline, the caller becomes the holder" is ambiguous when several callers wait. Which waiter takes over, and do the others keep waiting?
- "Delays other callers by at most 13 s" is true only for one stuck step. If the takeover step also stalls, the delay grows to 13 s per stalled step.
- Fix: state the takeover order and limit the bound to one stuck step.

**M10. Lines 99–100 (test acceptance wording).**

- "A later `request()` must settle within 13 s of fake time" does not match Fix A. The waiter becomes holder at 13 s and then runs its own step (spacing plus fetch), so it cannot settle at 13 s.
- Line 100 has the same issue: "start a new session after 22 s".
- Fix: write testable assertions, for example "becomes holder at 13 s" and "calls `sessionFor(true)` at 22 s".

**M11. Line 94 ("The live check below repeats the incident load").** **CALIBRATE**

- The incident had 5 `/charts` loads plus four timers (line 32). The live check (line 108) runs 3 headless checks, and the harness could not reproduce the trigger.
- Fix: "repeats the `/charts` navigate-away pattern seen before the incident".

**M12. Line 91 (slow-request risk).**

- The longest successful requests have no stated source. Presumably it is the journal; say so.
- "They can lose the slot only during full pressure with a 60 s query gap" leaves the operator question unanswered: do `sectorRotation/collect` (299 s) or `researchScreen/tick` (117 s) have query gaps longer than 60 s?
- `vertexOrders/status` (64 s) is under `/api/orpc/vertexOrders/`, so line 73 exempts it from idle reclaim. Listing it here contradicts that.
- Fix: state the known maximum query gap for each listed route, or mark it as unknown.

**M13. Line 64 (Fix C "45 s").**

- Fix A and Fix B derive their deadlines from `timeoutMs`. The 45 s value has no stated basis. Add how it relates to the 60 s cache TTL and the underlying reads.

**M14. Line 72 (rule 2, "One lease per request at most").**

- "Request" is ambiguous, because leases themselves belong to requests.
- Fix: "Each slot acquisition reclaims at most one lease."

---

## 🟢 Nit

**N1. Line 13, "Only a restart … restored service".** **CALIBRATE.** "Only" implies other remedies were tried and failed. Unless that happened, write "A restart … restored service."

**N2. Lines 15–16, colloquial headings.** "Stop the waits that never end" and "Reclaim slots that leak anyway" are informal. Suggested: "Bound cross-request waits" and "Reclaim leaked slots".

**N3. Line 15, "Three module-level promises".** The QuantData client is per configuration, through `quantDataClientFor`, not strictly module-level. Use "isolate-wide".

**N4. Line 16, "its socket is destroyed when possible".** Vague. Line 75 says best-effort destroy inside `try`/`catch`. Use "the owner's socket destroy is attempted".

**N5. Lines 18 and 84 repeat the unchanged items.** Line 84 adds `retry-after: 1`. Keep one statement.

**N6. Line 31, `:3450` is unexplained.** Name the service or port. "When the outage was examined" needs a timestamp; 21:26:54 is implied. "Matches" overstates a timing coincidence; use "is consistent with".

**N7. Line 32, "while page requests could still run".** Hedged. State whether in-flight requests were observed when each navigation happened.

**N8. Line 33 and line 108, "burst" is undefined.** Give the threshold, for example ">6 per hour". Reorder the warning caveat: "`vite preview` does not print `workerd` warnings, so the journal cannot show them."

**N9. Line 36, "blocks every later call forever".** Use "until the isolate restarts".

**N10. Line 74, "A query cannot run for 60 s".** Scope it: "the client cancels a query after 10 s (`query_timeout`)".

**N11. Line 75, overloaded sentence.** One sentence lists five actions plus a parenthetical. Make it an ordered list.

**N12. Line 78, "Today".** Use "In the current code".

**N13. Line 79, "longer than the 2 s wait plus 1 s".** Use "older than 3 s".

**N14. Line 80, "No secret, query text or user data is in it".** The route is a URL path. That holds for oRPC paths, but not for path-parameter routes in general. Narrow the claim or redact path parameters.

**N15. Line 86, "other QuantVPS services may share the role".** Speculative. State whether role sharing was checked. That decides whether `idle_session_timeout` is a viable alternative.

**N16. Line 90.**

- "A test covers it" is vague; name it (`client.test.ts` case 5 and `apps/web/.../request-scope.test.ts`).
- "This PR changes no order, execution, arming or risk code" repeats line 85.

**N17. Line 91, "Only when …" is a fragment.** "They are below 10 min" repeats the preceding numbers.

**N18. Line 92.** "Postgres allows 100 connections" has no source; cite `max_connections` and current use by other services. "A growing count is visible" should say where (the journal), and that there is no alert.

**N19. Line 93 repeats line 56.** Both say QuantData spacing can be missed after a takeover. Keep one.

**N20. Line 104 indentation.** The `apps/web/src/server/request-scope.test.ts` bullet is top-level, but its siblings (lines 99–103, 105) are nested under "Failing tests first". Either the indentation is wrong, or it is not a failing-first test; say which.

**N21. Line 108, "the window after 16:00 ET".** The incident was at 21:15 UTC, which is 16:15 ET, inside this window. Explain why the window is used, which is presumably outside market hours.
