# Stage 6 comprehension report

## What this proposes

The plan fixes five server adapters that call external HTTP services: Nasdaq option-chain OI, the Swinglytics start page (with the Yahoo chart read, which uses the same helper), PostHog, Resend email and ntfy. Each one currently sends `fetch(..., { redirect: "error" })`. It will send `redirect: "manual"` instead. A 3xx response then comes back to the adapter, which already treats any non-2xx status as a failure, so redirects are still never followed. In `research-screen-evidence.ts` the `redirect` field is removed from the internal request type, so callers can no longer choose it. A new CI test, `scripts/ci/fetch-redirect.test.ts`, scans tracked non-test `.ts`/`.tsx` files under `packages/` and `apps/` and fails on any literal `redirect: "error"` (or `=`, or another quote style). The plan is checked with unit tests, full CI, and a live check of Nasdaq OI after an off-hours deploy to QuantVPS. Rollback is a revert and a redeploy.

### How the existing system works, per this document

The web app and its oRPC server code run inside workerd, the Cloudflare Workers runtime, as `vertex-web.service` on a QuantVPS host. workerd throws a `TypeError` for `redirect: "error"` before it sends anything. As a result, every call from the five adapters has failed in production. Nasdaq turns the exception into `UNAVAILABLE` and pauses itself for 5 minutes after 3 failures, so the Nasdaq OI fallback (PR #491) never ran. PostHog reports `network` failures. Email and ntfy report `acceptance: "unknown"`, so they never actually delivered. Unit tests run under Node, which accepts `"error"`, so CI never caught the fault. The fault was found when live check A reported 7 of 64 contracts with missing OI that Nasdaq does have.

### Findings

No section was impossible to paraphrase, so there are no Blockers. Severity below uses High/Medium/Low as requested (High ≈ Major, Low ≈ Nit).

#### F1. Medium: Goal claims more than the plan delivers (line 18, and lines 43, 46)

**Problem:** The Goal says "Every outbound `fetch` in app and package source works in workerd and refuses a 3xx response without following it." The plan only changes the five files that use `redirect: "error"`. A `fetch` that sets no `redirect` field defaults to `"follow"` and still follows 3xx responses. The guard only blocks the literal `"error"`. It does not check that `"manual"` is used. A reader cannot tell whether other fetches (such as `arxiv.ts` and `deploy-status.ts`, line 27) already meet the "refuses a 3xx" half of the Goal.
**Fix:** Narrow the Goal to "every outbound `fetch` that used `redirect: "error"`…". Or state that all other server fetches were checked, and list their redirect mode.

#### F2. Medium: Yahoo chart behavior change is not explained (lines 31–37, 45, 72)

**Problem:** The affected-adapter table names `research-screen-evidence.ts` only as "Swinglytics start page". The Design (line 45) and step 3 (line 72) also change the Yahoo chart request (`readChart`, through the shared `boundedRead`). The document never says which `redirect` value `readChart` sends today. If it is `"follow"`, then a Yahoo redirect that works today will fail after this change. That would be a behavior change, and the Risks table does not mention it.
**Fix:** Add a row or note with `readChart`'s current redirect value. If it is not `"error"`, add a risk row for "Yahoo chart redirects are no longer followed", plus a test.

#### F3. Medium: Nasdaq risk mitigation contradicts the Design (line 44 vs line 54)

**Problem:** The Design says a 3xx gives `UPSTREAM_ERROR`, which "does not count toward the 5-minute pause". The "Nasdaq answers often" risk then uses "its 5-minute pause after 3 `UNAVAILABLE` answers" as a mitigation. If Nasdaq starts returning a steady 3xx (or any HTTP error), the pause never triggers, and every qualifying chain read calls Nasdaq. The row heading "Nasdaq answers often" is also unclear. It seems to mean "Nasdaq is now actually called".
**Fix:** Reword the risk as "Nasdaq calls now succeed and run on every qualifying read". State what limits the call rate when Nasdaq returns `UPSTREAM_ERROR` (the chain cache? nothing?). Or accept the risk explicitly.

#### F4. Medium: No live check for four of the five adapters (lines 53, 58–63)

**Problem:** The Risks table says email and ntfy "start to send from workerd for the first time" and that silent alerts "can now arrive". PostHog capture also starts to work. Acceptance check 4 only verifies Nasdaq. No check confirms that PostHog, Resend or ntfy actually deliver in production, or that no flood of backlogged or unexpected alerts occurs.
**Fix:** Add a post-deploy check for each of these: for example, one PostHog event visible, one test ntfy push received (or a log line with a 2xx acceptance), and an expected alert volume. Or state why they are out of scope.

#### F5. Medium: Card names, dates and the "fix on the spot" rule are unclear (line 5, line 22)

**Problem:** Line 5 names two cards, `vertex-chain-oi-quantdata-zero-deploy` and `vertex-chain-oi-quantdata-zero` (line 14), and does not explain how they relate. "Owner rule 'fix on the spot'" is not defined. The date 2026-11-15 on line 5 comes before the evidence on line 22, which is dated 2026-11-28. A reader cannot tell whether 2026-11-15 is the date of the rule, the fix, or the card.
**Fix:** Add one sentence: "`…-zero` delivered PR #461/#491; `…-zero-deploy` deploys it and runs its live check." Define the owner rule in one line, or link it. Move the date next to whatever it actually refers to.

#### F6. Low: "False zeros" and the PR #491 summary are confusing (line 22)

**Problem:** "0 false zeros (PR #491 works for Yahoo), but 7 of 64 compared contracts show no OI while Nasdaq has an OI." To a new reader, "shows no OI while Nasdaq has OI" sounds like a false zero. Also, PR #491 is described as the "Nasdaq OI fallback", yet the text says it "works for Yahoo".
**Fix:** Define "false zero", for example "OI shown as 0 when Yahoo has a positive OI". Then say "The Yahoo part of PR #491 works; the Nasdaq fallback part does not."

#### F7. Low: Undefined project terms (lines 11, 14, 22, 46, 61, 80)

**Problem:** These terms are used but not defined: "QuantVPS" and "the rig", "order-flow prints", `optionsChain.chain`, "Quant Data chain cache", "off-hours deploy", the "operations" Vitest project, the "CI core lane", `verify:prepush`, `acceptance: "unknown"` (what does "acceptance" mean for a send?), and why the production service runs through `run-preview.mjs`.
**Fix:** Add short entries to "Terms" for QuantVPS/the rig, `acceptance`, and off-hours deploy, plus one-line notes or links for the CI terms.

#### F8. Low: Acceptance check 4 can pass while Nasdaq is still paused (line 63)

**Problem:** The check only rejects the status `failed` with the message "could not be reached". The `off` status ("temporarily paused", line 23) is not rejected. The document also does not say whether a fresh deploy resets the in-memory pause. The 6-minute wait is tied only to the 5-minute Quant Data cache, not to the 5-minute Nasdaq pause.
**Fix:** Also require "no `nasdaq` source status `off`". State that a restart resets the pause, or say that the 6-minute wait also covers it.

#### F9. Low: Guard scope and limits are not fully specified (line 47)

**Problem:** The document does not say what counts as a "test file" (`*.test.ts(x)`? `__tests__/`?). It does not say whether multi-line object literals or `redirect:"error"` with no space are matched. It also does not say that browser code in `apps/web` would be flagged even though browsers accept `"error"` (line 39).
**Fix:** State the skip glob and the exact regular expression. Add one sentence that browser source under `apps/` is deliberately covered as well, or exclude it.

#### F10. Low: Some implementation steps lack a reason (lines 71, 76)

**Problem:** Step 2 says "assert that both requests use `redirect: "manual"`" without saying why that test makes two requests. Step 7 edits `dispatch/dispatch.test.ts` without saying what it asserts.
**Fix:** Add a short clause to each: for example "(the source fetches the chain page and then the OI page)" and "(dispatch tests assert the exact ntfy request options)".

#### F11. Low: Rollback mechanism is vague (lines 80, 84)

**Problem:** The document says "Deploy the previous build with `infra/quantvps/restart-when-idle.sh`", but a restart script does not obviously select a build. Step 11 says the deploy goes "through `infra/quantvps/README.md`", which is a document, not a tool. Rollback also brings back the silent failure of all five adapters, and this is not stated.
**Fix:** Name the exact deploy or rollback command, or how the script picks the build. Add: "Rollback restores the workerd fault; Nasdaq, PostHog, email and ntfy stop working again."
