# Stage 8 intermediate zoom-out report

## Stage 8 Zoom Out review: `workerd-fetch-redirect/plan.md`

### Verdict

The plan now passes the Zoom-Out standard. The scope is still small: one fetch option in five adapters, a Nasdaq 3xx branch, and one regex guard. It follows the 20+ adapters that already send `"manual"` (I counted 23 non-test files, including the five targets) and the existing `scripts/ci/*.test.ts` convention.

The new sections are short, and they are not over-engineered:

- Non-goals (lines 28-33)
- Alternatives considered (lines 69-78)
- Revised Risks (lines 80-87)
- Acceptance check (lines 89-94)
- Rollback (lines 133-137)

I checked every code claim against the working tree. All of them match, except the three points in N1, N4 and N5 below. No earlier High finding is still open as a defect. Two of them (IC-1 and IC-3) are now accepted, deferred gaps. Only IC-1 has a stated follow-up, and that follow-up has no card ID.

#### New findings

##### N1. Medium. Acceptance check 4 fails on a normal "not asked" status

- **TargetFile lines:** 94 (also 38)
- **Problem:** The check requires that no chain response has the `nasdaq` source status `off`. But `off` is also the normal status when Nasdaq is deliberately not asked:
  - `nasdaqSkipReason` in `packages/api/src/options-chain-merge.ts:237-259` returns `"Not asked: Yahoo Finance reported open interest for every contract"` or `"Not asked: no option contracts for this expiry"`.
  - `readNasdaqOpenInterest` in `packages/api/src/server/options-chain.ts:320-322` returns that reason with `status: "off"`.

  So a healthy deploy fails the check if any SPY or NVDA expiry has a positive Yahoo OI for every contract. Only the pause message from evidence item 2 shows the bug.
- **Fix:** Change the condition to: "no chain response has `nasdaq` status `failed` with 'Nasdaq options could not be reached', or status `off` with 'Nasdaq temporarily paused after repeated upstream failures'. An `off` that starts with 'Not asked:' is fine."

##### N2. Medium. The deferred follow-ups have no card IDs, and one deferral has no follow-up at all

- **TargetFile lines:** 30, 31, 32, 77
- **Problem:**
  - Lines 30-31 say "they get a follow-up card" and "This gets a follow-up card" but name no card.
  - Line 32 (keeping a `fetch` programming error apart from a network error) has no follow-up. That catch-all mapping is what hid this fault, because Nasdaq, PostHog, email and ntfy all reported it as a transient failure.
  - Elsewhere the repo names deferred work by card slug (for example `quantvps-web-prune-after-rollback` in `infra/quantvps/README.md`). Unnamed deferrals are easy to lose, and the narrow scope depends on them.
- **Fix:**
  - Name the cards, for example `vertex-bridge-fetch-redirect-manual` for the two bridge-token adapters and `vertex-workerd-adapter-smoke` for workerd tests.
  - For line 32, either add a card (for example `adapter-fetch-programming-error-class`) or write "dropped, no follow-up" with one reason.

##### N3. Low. Line 10 points to review files that do not exist yet

- **TargetFile lines:** 10 (also 121)
- **Problem:** `review/` holds only `comprehension_report.md`, `critic_report.md`, `implementation_readiness_report.md` and `zoom_out_report.md`. `consolidated_review_report.md` and `goldfish_review_report.md` are not there yet.
- **Fix:** Make sure both files exist before the PR. Otherwise, point line 10 to the files that exist.

##### N4. Low. One reason in the "shared fetch helper" row is inaccurate

- **TargetFile lines:** 76
- **Problem:** The row says the helper "adds a dependency from `analytics`, `email` and `notifications` to a shared package". `packages/notifications/package.json` already depends on `@darkfactory/shared`. Only `analytics` and `email` would get a new dependency. The decision to defer still holds.
- **Fix:** Write "adds a dependency from `analytics` and `email` to a shared package (`notifications` already uses `@darkfactory/shared`)".

##### N5. Low (nit). The reason for the 6-minute wait is weak

- **TargetFile lines:** 94
- **Problem:** The "5-minute Quant Data chain cache" (`CHAIN_TTL_MS = 300_000` in `options-analytics.ts`) is an in-memory `Map` in `quantdata-client.ts`. The deploy restart clears it, just like the Nasdaq pause. The wait does no harm, but the reason given does not hold after a restart.
- **Fix:** Keep the wait and drop the cache reason, or give the real reason (for example, time for order-flow prints and chain reads to settle).

#### Claims checked and found correct

- **Goal (line 26):** No literal `redirect: "error"` is left in non-test files under `packages/` or `apps/`. The only remaining matches are workerd comments, which do not match the guard pattern.
- **Non-goal targets (line 30):**
  - `golive-live-quotes.ts:171` sends `x-vertex-bridge-token` with no `redirect` field.
  - `vertex-orders-gateway.ts:303` does the same.
- **Out-of-scope files (line 56):** `browser-provider.test.tsx:466` and `scripts/golive/collect.ts:373` still use `"error"`, as the plan says.
- **Nasdaq 3xx (lines 62, 86, 102-103):**
  - The 3xx branch is in the `UNAVAILABLE` condition before `!response.ok`.
  - The pause constants are `MAX_FAILURES_BEFORE_COOLDOWN = 3` and `COOLDOWN_MS = 300_000`.
  - The new test "pauses after repeated 3xx answers…" asserts the pause.
  - Nasdaq is asked only when some contract lacks a positive Yahoo OI (`nasdaqSkipReason`).
- **PostHog (line 64):** `providerFailure` gives `provider-rejected`, with `retryable` false for a 3xx. The old throw path gave `network`, `retryable: true`.
- **Email and ntfy (line 65):** Both use the reject list `[400, 401, 403, 404, 413, 422, 429]`, so a 3xx gives `unknown`. `price-alerts-ntfy.ts` sends through the ntfy adapter.
- **Swinglytics (line 66):** `BoundedRequest` no longer has a `redirect` field, and `boundedRead` always sends `"manual"`.
- **Guard (lines 67, 112-115):** The guard file matches the plan: file list, test-file filter, more than 100 files, regex, and the pattern test giving `[1, 2, 3]`.
  - Project `operations` includes `scripts/**/*.test.ts`.
  - `verify:prepush` runs `test:operations`.
  - `verify:coverage` includes `--project operations`.
- **Runtime facts (lines 15, 40):** `wrangler.jsonc` has compatibility date `2026-07-22` and `nodejs_compat`. The lockfile pins `workerd@1.20261023.1`.
- **Doc updates (lines 119-120):** Both sibling docs are changed in the diff, and the Nasdaq matrix maps 3xx to `UNAVAILABLE` with a Superseded note.
- **Rollback (line 137):** The README confirms `restart-when-idle.sh --deploy <sha>`, version-guard exit 9 and `--allow-older "<reason>"`.
- **Test names and 3xx cases (lines 103-108):** They match the existing test files: PostHog 307, ntfy 302, the new email 302 case and the call count of 5.
- **Not checkable from the repo:**
  - `EMAIL_PROVIDER=resend` on QuantVPS (line 85). The repo default in `wrangler.jsonc` is `"disabled"`, and `run-preview.mjs` takes the value from the host.
  - The live check evidence on the rig (lines 37-39).

#### Status of earlier findings

Earlier High findings:

| Finding | Status |
| --- | --- |
| Zoom-out IC-1 (runtime fidelity; tests run in Node, not workerd) | Accepted and deferred, not fixed. Covered by Non-goal line 31, Alternatives line 77 and Risk line 87. Its follow-up card has no ID (N2). |
| Zoom-out IC-3 (a programming fault reported as a network outage) | Accepted as Non-goal line 32. Still open as a known gap, with no follow-up recorded (N2). |
| Critic F1 (no Alternatives considered) | Resolved (lines 69-78). |
| Critic F2 / S1 (Goal claims too much, no Non-goals) | Resolved (lines 26-33). |
| Implementation-readiness F1 (Nasdaq 3xx described as `UPSTREAM_ERROR`, not counted for the pause) | Resolved (lines 62, 86). |
| Implementation-readiness F2 (steps 1, 2 and the sibling doc did not match the diff) | Resolved (steps 1, 2 and 10). |
| Implementation-readiness F3 (Goal false for the bridge-token adapters) | Resolved (lines 26, 30). |

Other earlier zoom-out findings:

| Finding | Status |
| --- | --- |
| ZO-1 | Resolved (lines 31, 87). |
| ZO-2 | Resolved (line 26). |
| ZO-3 | Resolved (line 135). |
| ZO-4 | Resolved (step 10 and the diff). |
| ZO-5 | Turned into Non-goal line 32, with no follow-up (N2). |
| ZO-6 | Resolved (line 66 names no helper or type). |
| ZO-7 | Resolved (line 67). |
| ZO-8 | Resolved (lines 6-7). |
| IC-4 | Resolved (lines 62, 86, 103). |
| IC-5 | Accepted (line 87). |
| IC-6 (log the 3xx status and `Location` origin) | Not addressed. Acceptable under YAGNI for this bug fix. |
| IC-7 | Resolved. |
| IC-8 | Accepted (line 87). |
| IC-9 | Resolved (line 135). |
