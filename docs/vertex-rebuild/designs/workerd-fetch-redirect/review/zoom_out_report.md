# Stage 5 zoom-out report

## egm-zoom-out

The plan passes the Zoom-Out standard. Its scope is narrow and correct: it changes one fetch option in five adapters and adds one CI guard. It follows the codebase's existing pattern, since 20+ server adapters already send `redirect: "manual"` and `arxiv.ts` and `deploy-status.ts` carry the same workerd comment. It also follows the `scripts/ci/*.test.ts` invariant-test convention. There is no shared server fetch wrapper to reuse. Adding one, or adding `@cloudflare/workers-types` (not used anywhere today), would be beyond what this bug fix needs.

The implementation already exists in the working tree: there are no commits after `b101b659`, `scripts/ci/fetch-redirect.test.ts` is present, and the five adapters now send `"manual"`. The findings below are about framing, residual risk and doc accuracy. None of them blocks the plan.

### Findings

#### ZO-1: The root cause is only named for one API (Medium)

- **Lines:** 27 (Problem 6), 50 (CI guard), 59 (guard risk row)
- **Problem:** Line 27 shows this is the third time the same fault has happened (`arxiv.ts`, `deploy-status.ts`, now five adapters). The deeper cause is that unit tests run under Node while production runs workerd. The guard catches one symptom: a literal `redirect: "error"`. Any other workerd-only difference will pass CI the same way. The plan does not say that this gap is accepted on purpose, so a reader may think the guard closes it.
- **Fix:** Add one sentence to Risks or Goal: "Node/workerd runtime divergence in unit tests is out of scope; the guard covers only the redirect mode. Live check A remains the end-to-end check." If the owner wants more, record a follow-up card (for example, a workerd smoke for the adapters) instead of widening this plan.

##### ZO-2: The Goal promises more than the change delivers (Low)

- **Line:** 18
- **Problem:** "Every outbound `fetch` in app and package source works in workerd" is broader than what the plan does or checks. The change removes one option value from five adapters, and the guard checks one literal pattern. `apps/` also contains browser-only code, which never runs in workerd.
- **Fix:** Reword to: "Every server-side outbound `fetch` in app and package source uses a redirect mode that workerd accepts (`"manual"`) and refuses a 3xx without following it. A CI test stops a new literal `redirect: "error"` in `packages/` and `apps/` source."

##### ZO-3: Rollback is all-or-nothing and goes back to a known-broken state (Low)

- **Lines:** 57 (email/ntfy risk row), 82-84 (Rollback)
- **Problem:** Reverting the merge commit brings back the state where all five adapters fail in workerd, including the Nasdaq OI fallback. The only real new behavior is email and ntfy sending from workerd for the first time (line 57). That risk already has a smaller lever, which the plan names: those adapters' enable flags. Note that a backlog flood is not a risk: the notification store keeps `pending`/`unknown` rows forever and never retries them (`packages/notifications/src/server/contracts.ts`, `dispatch/composition.ts`).
- **Fix:** Add a first-line rollback: "If unexpected email or ntfy traffic appears, turn off the email/ntfy enable flags. Revert the whole commit only if a redirect-mode change itself is wrong; a revert brings back the Nasdaq, PostHog, Resend and ntfy failures."

##### ZO-4: A sibling design doc still describes the old behaviour (Low)

- **Line:** 78 (step 9)
- **Problem:** Step 9 updates only `docs/vertex-rebuild/designs/research-screen/design.md`. But `docs/vertex-rebuild/designs/vertex-chain-oi-yahoo-false-zero/plan.md:76` still lists "`redirect: "error"` throw -> `UNAVAILABLE`" for the Nasdaq adapter. Its review report says to "Keep `redirect: "error"`" (line 117) and to cover "`redirect: "error"` rejection" (line 129). A future reader or agent could bring the bug back by following those docs.
- **Fix:** Extend step 9 to correct the Nasdaq rule in `vertex-chain-oi-yahoo-false-zero/plan.md`. For example, add a one-line note there: "superseded: workerd requires `redirect: "manual"`; a 3xx gives `UPSTREAM_ERROR`." Review reports can stay as historical records.

##### ZO-5: The catch-all error mapping hid a code fault as a network fault (Low, follow-up only)

- **Lines:** 26 (Problem 5), 33-37 (affected table)
- **Problem:** The fault went unnoticed because each adapter maps any `fetch` throw to a transient category: Nasdaq `UNAVAILABLE` plus a 5-minute pause, PostHog `network`, email/ntfy `unknown`. In workerd, the `TypeError` thrown before any request is a fixed programming error, but it looked like flaky upstreams. The plan treats this as background only. Changing error classification here would be scope creep, but the lesson is worth recording.
- **Fix:** Do not change it in this plan. Add a one-line follow-up note: "consider keeping a synchronous `TypeError` from `fetch` apart from network failures in adapter error mapping and logs."

##### ZO-6: The Design section uses some code-level names (Low / nit)

- **Lines:** 45-49
- **Problem:** The Design bullets use function names and internal types (`providerFailure(status)`, `boundedRead`, `BoundedRequest`). The per-adapter outcomes are useful because they show how failure categories change. The helper names belong in the Implementation Plan, where they already appear (steps 3 and 5).
- **Fix:** Keep the outcome per adapter, for example "PostHog: a 3xx is a non-retryable `provider-rejected`". Move helper and type names to steps 3-5. Line 49 could say: "The internal request type no longer lets a caller choose the redirect mode; the shared reader always sends `"manual"`."

##### ZO-7: The guard also covers browser code and does not say so (Low / nit)

- **Lines:** 39, 50
- **Problem:** The guard scans all non-test `.ts` and `.tsx` files in `apps/`, which includes browser-only modules. Line 39 says `"error"` is valid in browsers. The guard will still reject it in browser source, which is a stricter rule than the workerd limit needs. That is a reasonable simple choice, but the plan should state it so nobody files it later as a false positive.
- **Fix:** Add to line 50: "Browser source in `apps/` is included on purpose; `"manual"` works there too, and one repo-wide rule is simpler than telling server files from browser files."

##### ZO-8: The dates in the context are confusing (Low / nit)

- **Lines:** 5, 22
- **Problem:** Line 5 gives 2026-11-15 next to "fixed in the same job", while the deploy and live check happened on 2026-11-28 UTC (line 22). The guard's code comment says 2026-11-27. A fresh reader cannot tell which date is the incident and which is the owner rule.
- **Fix:** Write: "owner rule 'fix on the spot' (2026-11-15); incident found 2026-11-28 01:26 UTC (2026-11-27 local)".

#### Checked and found fine

- **Reuse:** There is no shared fetch helper. The only shared server read helper is `readCappedText` in `portfolio-monitor.ts`. Writing `"manual"` in each adapter matches the 20+ adapters that already do so.
- **YAGNI:** The plan adds no new abstraction. Removing `redirect` from `BoundedRequest` (line 49) is a simplification.
- **Guard placement:** It is a Vitest test in `scripts/ci/`, like the other invariant tests. No new tool or lint plugin is added.
- **Yahoo chart:** It already sent `"manual"` at `b101b659`, so leaving it out of the affected table is correct.
- **Altitude:** The Implementation Plan (lines 68-84) is detailed, which is right for that section.

## egm-inventive-catalyst

### Inventive Catalyst Goldfish: Stage 5 strategic review of `workerd-fetch-redirect/plan.md` (lines 1-84)

**Is there a real contradiction?** Yes. The plan sees that CI runs under Node while production runs under workerd (lines 6, 27). It then accepts two weaker answers: a text-pattern guard and a manual live check after deploy. The root conflict stays unsolved: tests are fast because they run in Node, but only workerd shows the real runtime behavior. The plan also keeps the error mapping that hid the fault for weeks.

---

#### IC-1: High. Runtime fidelity is given up for test convenience

- **Lines:** 27, 50, 59, 63, 66
- **False compromise:** The plan accepts that CI cannot see workerd behavior. Its answer is a regex that bans one literal string, plus a live check of one adapter after deploy. Line 59 admits that a variable holding `"error"` gets through. Any other init value that workerd rejects would also get through.
  - The plan's own evidence shows a better option is possible. Line 25 says a test worker already ran in the repository's pinned workerd binary (`workerd@1.20261023.1`, compatibility date `2026-07-22`, `nodejs_compat`).
- **Proposed fix (Preliminary Action + Extraction):** Add a workerd contract test to the `operations` Vitest project:
  1. Each adapter's unit test exports or records the `RequestInit` it actually sends.
  2. One test starts the pinned workerd with the `compatibility_date` and flags read from `apps/web/wrangler.jsonc`.
  3. It replays every recorded init against a loopback HTTP server that returns 200 and 302.
  4. It asserts that no `TypeError` occurs and that the 3xx comes back unfollowed.

  This proves the behavior instead of matching text. It also catches future rejected init fields, not just `redirect`. Keep the regex guard as a cheap first line.
- **Secondary liabilities:**
  - workerd startup adds about 1-2 s to CI.
  - CI runners need the platform-specific workerd binary.
  - Loopback ports can cause flaky tests.
  - The compatibility date must stay in sync with `wrangler.jsonc`, so read it from that file rather than copying it.

##### IC-2: Medium. Redirect policy is copied into every adapter instead of owned by one type

- **Lines:** 43, 49, 50, 59
- **False compromise:** The plan treats "each adapter sets `redirect: "manual"` and a regex bans `"error"`" as the only option. The same policy comment is already copied into about 12 files: `arxiv.ts`, `deploy-status.ts`, `market-data.ts`, `quantdata-client.ts`, `options-chain-yahoo.ts`, and the five targets. Line 49 already fixes this properly for one file: `BoundedRequest` loses its `redirect` field, so callers can no longer choose a bad value. The plan does not apply that idea anywhere else.
- **Proposed fix (Extraction / Inversion):** Define one shared server request-init type and builder in a common server package, for example `type ServerRequestInit = Omit<RequestInit, "redirect"> & { redirect: "manual" }`. All server adapters use it. The type checker then rejects `"error"` even through variables. The CI guard can then be simpler and stronger: "no `redirect:` literal outside the helper."
- **Secondary liabilities:**
  - Adds a dependency edge across `api`, `analytics`, `email` and `notifications`.
  - Touches more files, which raises refactor risk.
  - A cast such as `as RequestInit` can still bypass the type. A lint rule can cover that.

##### IC-3: High. A programming fault is reported as a network outage

- **Lines:** 26, 45, 57; code at `options-chain-nasdaq.ts` lines 191-196 and 277-283
- **False compromise:** The catch-all `catch {}` turns every `fetch` exception into `UNAVAILABLE` "could not be reached". That includes a deterministic `TypeError` that workerd throws before any request leaves. The error then feeds the 5-minute circuit breaker. So a configuration bug looked exactly like an outage.
  - Email and ntfy failed silently in production. Line 57 admits they will "send from workerd for the first time". Nothing raised an alarm.
  - The plan fixes the symptom but keeps the classification that hid it.
- **Proposed fix (Blessing in Disguise + Self-Service):**
  1. Treat an exception thrown before send as a separate code, for example `MISCONFIGURED`. Possible signals: a `TypeError` whose message is not a network error, or validation through `new Request(url, init)` before `fetch`.
  2. This code does not count toward the pause, is logged at error level, and raises an operator alert.
  3. Add a startup self-check: each adapter builds `new Request(url, init)` once in workerd. This should validate the init values with no network traffic. It must be verified that workerd's `Request` constructor does reject `redirect: "error"`.
- **Secondary liabilities:**
  - One more error code to map in the API and UI.
  - Possible alert noise.
  - The self-check must never send real email or ntfy messages.
  - Telling `TypeError` causes apart in workerd by message text is fragile.

##### IC-4: Medium. A 3xx from Nasdaq quietly leaves the circuit breaker

- **Lines:** 45, 58; `noteFailure` counts only `UNAVAILABLE`
- **Problem:**
  - Under Node, `redirect: "error"` turned a 3xx into a `TypeError`. That became `UNAVAILABLE` and counted toward the pause.
  - Under the new design, a 3xx becomes `UPSTREAM_ERROR`, which does not count (line 45).
  - If Nasdaq keeps redirecting (for example to a bot wall or consent page), every qualifying chain read sends a new Nasdaq request with no backoff.
  - The Risks table (line 58) cites the "unchanged" pause as the mitigation, but the pause no longer covers this case.
- **Proposed fix (Beforehand Cushioning / Dynamics):** Map 3xx to `UNAVAILABLE`, just as 403 and 429 already are. Or count every consecutive failure except `NOT_FOUND` toward the breaker. Add a unit test: three 302 answers in a row cause a pause.
- **Secondary liabilities:** A transient redirect can now disable the OI fallback for 5 minutes. Users may see more "paused" states.

##### IC-5: Medium. Only Nasdaq gets a live check

- **Lines:** 18, 57, 59, 66, 80
- **Problem:** Acceptance check 4 proves only the Nasdaq adapter in workerd. Swinglytics, PostHog, Resend email and ntfy change from "always failing" to "sending" (line 57), but none of them has a workerd proof before or after deploy. The plan treats this partial coverage as enough.
- **Proposed fix:** Prefer IC-1, which covers all five adapters in CI. If live proof is still wanted, add a post-deploy smoke step that sends through each adapter:
  - a PostHog test event,
  - an ntfy message to a test topic,
  - a Resend send to a sandbox address,
  - one Swinglytics read.
- **Secondary liabilities:** Live sends have real side effects and need test destinations and their credentials. The deploy runbook gets longer.

##### IC-6: Medium. The 3xx response is thrown away instead of used for diagnosis

- **Lines:** 47, 56
- **False compromise:** A PostHog 3xx changes from `network` (retryable) to `provider-rejected` (not retryable). The plan accepts this as "unchanged from the current 307 test". The status and `Location` header are now available, but nothing records them. If a provider moves its endpoint, events are dropped permanently with no explanation.
- **Proposed fix (Blessing in Disguise):** On any 3xx, keep refusing to follow it. Do record the status and the `Location` origin, with path and query stripped, in the failure detail or log. Then an operator can see an endpoint move right away.
- **Secondary liabilities:**
  - `Location` URLs can carry tokens, so strip everything except the origin.
  - Slightly larger failure records.

##### IC-7: Low. The Goal claims more than the plan covers

- **Lines:** 6, 18
- **Problem:** The Goal says every outbound `fetch` "refuses a 3xx response without following it". Several server call sites set no `redirect` field, so they use the default `"follow"`:
  - `packages/api/src/server/golive-live-quotes.ts:165`
  - `packages/api/src/server/vertex-orders-gateway.ts:299`
  - `price-alerts-ntfy.ts`, which passes through the init its caller gives it.
- **Proposed fix:** Narrow the Goal to "no outbound `fetch` uses `redirect: "error"`; the five adapters refuse a 3xx." Alternatively, list the follow-mode call sites and say why following is acceptable for each (for example, a loopback endpoint).

##### IC-8: Low. The regex guard is line-based and easy to get around

- **Lines:** 50, 59, 63
- **Problem:** The pattern misses:
  - a multi-line `redirect:` followed by `"error"` on the next line,
  - `["redirect"]: "error"`,
  - a constant such as `redirect: MODE`,
  - an init object spread in from elsewhere.

  Line 59 accepts this gap as permanent.
- **Proposed fix:** Make IC-1 or IC-2 the main protection and keep the regex as a cheap pre-check. If the regex stays the main guard, run it on the whole file text (allowing newlines between `redirect:` and `"error"`) and add those forms to the sample-line test.

##### IC-9: Low. Rollback goes back to a known-broken build

- **Line:** 84
- **Problem:** The previous build has all five adapters failing in workerd: no Nasdaq fallback, and silent email, ntfy and PostHog. The plan does not say this, so rollback looks safe when it brings back a known outage.
- **Proposed fix:** Say that rollback restores the earlier failures (Nasdaq fallback off; email, ntfy and PostHog silent). Recommend fixing forward, and use rollback only if the new build breaks something more important.
