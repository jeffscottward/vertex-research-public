# Stage 7 critic report

## egm-design

### Stage 7 Critic Review: `workerd-fetch-redirect/plan.md`, FeatureRange lines 1-67

**Result: does not pass `feature-spec-standard.md` yet.** The cause and evidence are strong (lines 20-28 are specific and reproducible), but the plan has no Alternatives section and no Non-Goals. Two claims are also broader or more reassuring than the code supports. I checked the claims against the base `b101b659` and the current working tree. This review is read-only; no file was edited.

#### Findings

##### F1: No "Alternatives Considered" section (the standard's Alternatives Rule)

- **Severity:** High (Blocker under the standard)
- **Lines:** 41-50 (Design); no alternatives section anywhere in lines 1-67
- **Problem:** The plan proposes one path: `redirect: "manual"` plus a regex CI test. It never shows that other designs were considered and rejected. This matters most because line 27 names the real root cause: unit tests run under Node, not workerd. `arxiv.ts` and `deploy-status.ts` show the same fault happened before, and the regex guard treats only this one symptom.
- **Fix:** Add a section "## Alternatives considered", with a concrete trade-off for each:
  - (a) **Omit `redirect`** (default `"follow"`). Rejected: ntfy and Resend send bearer credentials, and a followed 3xx could reach an unvetted host.
  - (b) **`"follow"` plus a check of `response.redirected` / `response.url`.** Rejected: the request (with auth headers) has already reached the redirect target.
  - (c) **One shared `serverFetch` helper** that always sets `redirect: "manual"`, plus a type-level or lint ban on a raw `redirect` field. This is stronger than a regex. State why it is deferred (for example, scope).
  - (d) **Run adapter tests or a smoke test under workerd** (for example `@cloudflare/vitest-pool-workers`, or the test worker from line 25 in CI). This attacks the root cause. Today no workerd test infrastructure exists in the repo: grep finds no `vitest-pool-workers`. State its cost and why it is deferred or rejected.
  - (e) **A Biome/GritQL lint rule** instead of a Vitest regex test.

##### F2: The Goal over-claims scope, and there are no Non-Goals

- **Severity:** Medium
- **Lines:** 18 (Goal); compare with 6 and 29-39
- **Problem:** Line 18 says every outbound `fetch` in app and package source "refuses a 3xx response without following it". The design only changes five adapters, and the guard only blocks the literal `"error"`. Server code still calls `fetch` with no `redirect` field, which means the default `"follow"`:
  - `packages/api/src/server/golive-live-quotes.ts:165`
  - `packages/api/src/server/vertex-orders-gateway.ts:299`
  - `apps/web/src/components/account/sign-out-client.ts:54`

  Line 18 also says every `fetch` "works in workerd". That is not shown: line 25 tested only `credentials`, `cache` and `referrerPolicy` on one request.
- **Fix:** Narrow the Goal to "the five adapters listed in the table work in workerd and do not follow a 3xx". Add a "Non-goals" list:
  - `fetch` calls that use the default `"follow"`, named above;
  - other `RequestInit` fields workerd may reject;
  - code that does not run in workerd (Bun scripts, browser code, `.mjs` files).

##### F3: A Nasdaq 3xx no longer reaches the pause; the risk table hides this

- **Severity:** Medium
- **Lines:** 45, 56, 58
- **Problem:**
  - **Before:** under Node, `redirect: "error"` turned any 3xx into an exception. The adapter caught it as `UNAVAILABLE`, which counts toward the 3-failure, 5-minute pause.
  - **After:** a 3xx becomes `UPSTREAM_ERROR`, which never counts toward the pause (`options-chain-nasdaq.ts:211-215` and `noteFailure` at 276-283).
  - **No caching of failures:** `options-chain.ts:332-333` deletes the cache entry for a non-ok result.
  - **Effect:** if Nasdaq starts answering every request with a 3xx (a bot-check or maintenance redirect), every chain read that needs the fallback calls Nasdaq again, with no backoff.

  Row 3 (line 58) says the pause is "unchanged". That is literally true, but the 3xx path no longer reaches it. Row 1 (line 56) lists only the PostHog category change, not this Nasdaq one.
- **Fix:** Either:
  - map a 3xx to `UNAVAILABLE` in `readDocument`, as already done for 403, 429 and 5xx, and test that three 3xx answers cause the pause; or
  - add a risk row that states the lost backoff and justifies it, for example that the outer 5-minute chain cache limits the request rate. That would need evidence.

##### F4: No check in workerd before deploy, and no live check for four of the five adapters

- **Severity:** Medium
- **Lines:** 61-66 (Acceptance check), 59 (Risk row 4)
- **Problem:**
  - Checks 1-3 all run under Node, which is the runtime that hid the bug (line 27).
  - Check 4 is the only workerd check. It runs after deploy and covers only Nasdaq.
  - PostHog, Resend, ntfy and Swinglytics get no runtime proof in workerd.
  - Risk row 4 also uses this post-deploy Nasdaq check as the mitigation for gaps in the guard.
- **Fix:** Add an acceptance step before merge or deploy. Run the built bundle (or the test worker from line 25) in the repo's `workerd@1.20261023.1`, against a local stub server, for each of the five adapters. Assert two things: no `TypeError`, and a stubbed 302 is refused without a second request to the `Location` URL. After deploy, add one observable check for PostHog capture and for ntfy/email, or say explicitly why there is none.

##### F5: The live check is not reproducible and its pass rule is not stated

- **Severity:** Medium
- **Lines:** 14, 22, 66
- **Problem:**
  - `live-check.mjs` and its output live under `~/Documents/reports/...` on the rig, not in the repository. A fresh reader cannot see what "exit 0" requires (tolerances, how many contracts are compared).
  - Exit 0 can fail for reasons this change does not touch: Yahoo and Nasdaq disagreeing, or a single network blip that gives `failed` "could not be reached".
  - The check rejects `failed` but says nothing about the `off` status (the pause), which was 18 of 21 chains in the original failure (line 23).
- **Fix:**
  - State the pass rule of live check A inline: what is compared, which tolerance, and which counts must be zero.
  - Add "no chain has `nasdaq` status `off`".
  - Say how to tell a one-off upstream blip from a recurrence of this bug, for example by rerunning once before calling a fail.

##### F6: The risk that email and ntfy now send is not made concrete

- **Severity:** Low
- **Line:** 57
- **Problem:** "Alerts and emails that were silent before can now arrive" is correct. Price alerts already use this path: `price-alerts-ntfy.ts` goes through `createNtfyNotificationAdapter`. But the plan does not say which senders are enabled on `vertex-web` today (ntfy price-alert config, Resend key), or how many messages to expect. The repo's `wrangler.jsonc` sets `EMAIL_PROVIDER` and `EMAIL_TRANSPORT` to `"disabled"`, while the QuantVPS runtime environment may differ. So the reader cannot tell whether email will in fact start.
- **Fix:** List the enable state of each sender on the QuantVPS runtime before deploy. Confirm that no queued or retry state will flush a backlog: from the code, `unknown` results are not retried and the PostHog result is not persisted. Notify the owner that phone alerts will begin.

##### F7: The guard's scope and its comment behavior are unstated

- **Severity:** Low
- **Lines:** 50, 59
- **Problem:**
  - The guard scans only `.ts` and `.tsx` under `packages/` and `apps/`. It skips `.mjs`/`.js` files (for example `infra/quantvps/run-preview.mjs`) and `scripts/`.
  - It does not catch a value passed through a variable or object spread (row 4 admits the variable case).
  - It matches comment lines too. A comment written as `redirect: "error"` in an adapter would fail CI. The current code works only because its comments avoid the colon.
  - It will also reject `"error"` in non-test browser code under `apps/`, where the value is valid (line 39).
  - "Skips test files" is not defined.
- **Fix:** In the Design:
  - state the exact test-file rule (the implementation uses `/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.tsx?$/`);
  - state that comment lines and browser files are matched on purpose;
  - list the files and spellings left out as known gaps, or extend the scan to `.mts`/`.mjs`.

##### F8: The before-and-after image is missing

- **Severity:** Low
- **Line:** 3
- **Problem:** `./before-after.png` does not exist. The directory holds only `plan.md` and `review/`.
- **Fix:** Add the image, or remove the reference.

##### F9: Date and path wording is unclear

- **Severity:** Low
- **Lines:** 5, 11, 22
- **Problem:**
  - Line 5 dates the fix with "2026-11-15", which is the date of the owner rule. The failure itself happened 2026-11-28 01:17 UTC (2026-11-27 local, as the guard's own comment says).
  - Line 11 names `run-preview.mjs` without its path, `infra/quantvps/run-preview.mjs`.
- **Fix:** Write "owner rule of 2026-11-15; fault found 2026-11-28 01:26 UTC", and give the full path.

##### F10: Outside the FeatureRange: rollback steps would hit the version guard

- **Severity:** Low (noted for the DetailedRange reviewer)
- **Line:** 84
- **Problem:** "Deploy the previous build with `restart-when-idle.sh`" deploys a strict ancestor commit. The version guard then stops with exit 9 unless `--allow-older "<reason>"` (and `--backup <TS>`) is passed (`infra/quantvps/README.md:95`). Also, a rollback brings back the broken Nasdaq, PostHog, email and ntfy behavior.
- **Fix:** Give the exact command: either deploy the revert commit with `--deploy <sha>`, or use `--allow-older "<reason>" --backup <TS>`. State that a rollback brings the original fault back.

#### Checks that held up

- **Workerd setup:** the compatibility date and flag (line 11) match `apps/web/wrangler.jsonc`, and `workerd@1.20261023.1` matches `pnpm-lock.yaml`.
- **Affected files:** the five adapters in the table (lines 31-37) are exactly the non-test files with `redirect: "error"` at `b101b659`. The two exclusions on line 39 are correct.
- **Failure paths:** the paths on lines 45-48 match the code: Nasdaq `!response.ok` gives `UPSTREAM_ERROR`, PostHog `providerFailure` gives `provider-rejected` and not retryable for 3xx, and email and ntfy give `acceptance: "unknown"` for a status outside 200-299.
- **CI placement:** the `operations` Vitest project runs in `verify:prepush`, as line 50 says.

## egm-structural

I reviewed lines 1-67 of `docs/vertex-rebuild/designs/workerd-fetch-redirect/plan.md` against `feature-spec-standard.md`. The feature range does not pass the standard yet. It has two High findings: no evaluation of alternatives, and a Goal that claims more than the plan delivers. One risk mitigation is wrong in the code, and the image link on line 3 is broken.

The problem statement and evidence (lines 20-39) are concrete and match the source. The H1 → H2 → H3 heading order is correct.

### F1: No "Alternatives Considered" section

- **Severity:** High
- **Lines:** whole range; the gap is between Design (41-50) and Risks (52-59).
- **Problem:** The standard's Alternatives Rule says a spec fails if it gives a single path without showing that other designs were considered and rejected for stated reasons. Lines 41-50 give only one design, with no rejected options. The design choice behind the CI guard (line 50) is also not justified.
- **Fix:** Add `## Alternatives considered` between Design and Risks. Give each option one concrete reason for rejecting it:
  - (a) Remove the option and accept the default `"follow"`. Rejected because redirects would then be followed. The adapters send API keys and tokens, so these could reach another host.
  - (b) Add one shared `safeFetch` helper that always sends `"manual"` and refuses a 3xx. This puts the rule in one place instead of five adapters plus a text guard. Say why it is not chosen now, for example the size of the change.
  - (c) Run the adapter unit tests in workerd, for example with a workers Vitest pool, instead of Node. This closes the root gap in item 6 (line 27).
  - (d) A lint rule (Biome or AST-based) instead of a regex test. Compare false negatives and maintenance cost.
  - (e) Pick the redirect mode by runtime. Rejected because it adds a branch with no benefit, since `"manual"` works in workerd, Node and Bun.

#### F2: The Goal claims more than the plan delivers, and there are no Non-Goals

- **Severity:** High
- **Lines:** 16-18 (also 6 and 39)
- **Problem:** Line 18 says "Every outbound `fetch` in app and package source works in workerd and refuses a 3xx response without following it." The repository does not match this:
  - Server fetches with no `redirect` option use the default `"follow"`. Examples: `packages/api/src/server/golive-live-quotes.ts:165`, `packages/api/src/server/vertex-orders-gateway.ts:299` and `packages/jobs/src/server/model-relay.ts` (lines 196, 201, 299). They follow 3xx responses today, and this plan does not change them.
  - The guard on line 50 only finds the literal `"error"`. It does not enforce "refuses a 3xx".
  - "App source" also includes browser code, which line 39 knowingly excludes.
  - The standard asks for "Goals & Non-Goals"; there is no Non-Goals list.
- **Fix:** Narrow the goal, for example: "The five server adapters that set `redirect: "error"` send `"manual"`, so they work in workerd and still refuse a 3xx. A CI test blocks a new literal `redirect: "error"` in non-test source under `packages/` and `apps/`." Then add a `### Non-goals` list:
  - server fetches that use the default `"follow"` (name the files above);
  - browser code and Bun scripts (move line 39 here);
  - running unit tests in workerd;
  - changes to retry or pause policy;
  - other fetch options that workerd may reject.

##### F3: The Nasdaq risk mitigation is wrong for a repeated 3xx

- **Severity:** Medium
- **Lines:** 58 (and 45)
- **Problem:** The mitigation relies on "its 5-minute pause after 3 `UNAVAILABLE` answers". But line 45 itself says a 3xx gives `UPSTREAM_ERROR`, which "does not count toward the 5-minute pause". The code confirms this: `noteFailure` in `options-chain-nasdaq.ts` counts only `UNAVAILABLE`. So if Nasdaq starts answering with a redirect, there is no backoff and every read sends a request. The risk name "Nasdaq answers often" is also unclear; it means "Nasdaq is called more often".
- **Fix:** Rename the risk to "Nasdaq is requested more often, including when it keeps answering 3xx". State plainly that a repeated 3xx is not paused. Then either accept this with a reason (each read is one request per symbol and expiry, only when Yahoo has no OI), or add a follow-up to count 3xx toward the pause.

##### F4: No security entry, although the standard requires security implications

- **Severity:** Medium
- **Lines:** 52-59
- **Problem:** The "Risks & Limits" section of the standard asks for security implications. The adapters send credentials: PostHog key, Resend key, ntfy token. The point of `"error"` was to stop those credentials from following a redirect to another host. The plan never says that `"manual"` keeps this protection, or that no adapter reads the `Location` header.
- **Fix:** Add a risk row:
  - **Risk:** "A changed redirect mode lets a credential reach a second host."
  - **Effect:** "Key or token leak."
  - **Mitigation:** "`manual` never follows. Each adapter refuses a 3xx and does not read `Location`. Tests assert `redirect: "manual"` and the 3xx refusal."

##### F5: The limits of the guard are only partly stated

- **Severity:** Medium
- **Lines:** 27, 50, 59
- **Problem:** Line 59 lists only "another spelling". The guard has wider limits that the spec does not state:
  - It scans only `.ts`/`.tsx` files under `packages/` and `apps/`. It does not scan `scripts/`, `infra/` or `.mjs`/`.js` files.
  - Other `fetch` options that Node accepts but workerd may reject are not checked. This is the same root gap as item 6 (line 27).
  - It also blocks `"error"` in non-test browser code under `apps/web`, where browsers accept it (compare line 39).
- **Fix:** Add these to the risk row on line 59, or to a short "Limits" paragraph. Link them to alternative (c) in F1.

##### F6: Only the Nasdaq adapter is checked in workerd

- **Severity:** Medium
- **Lines:** 61-66
- **Problem:** Checks 1-3 all run under Node. Check 4 tests only Nasdaq after the deploy. Swinglytics, PostHog, Resend and ntfy have no evidence from workerd, so the main runtime fault could stay in four of the five adapters without being seen.
- **Fix:** Add a check. Either run the evidence item 4 test worker (line 25) in the repository's workerd against each changed request shape, or define a post-deploy signal for each adapter, for example:
  - a PostHog capture with status other than `failed`/`network`;
  - one ntfy test push with acceptance `accepted`;
  - a Swinglytics evidence row that is not `provider-timeout`.

##### F7: The image link on line 3 is broken

- **Severity:** Medium
- **Lines:** 3
- **Problem:** `./before-after.png` does not exist. The plan's directory contains only `plan.md` and `review/`.
- **Fix:** Add the image file, or remove the line.

##### F8: Section headings do not match the standard's names

- **Severity:** Low
- **Lines:** 16, 41, 52
- **Problem:** "Goal", "Design" and "Risks" do not match the standard's "Goals & Non-Goals", "Proposed Architecture" and "Risks & Mitigations". A checklist reviewer cannot map them at a glance.
- **Fix:** Rename them to `## Goals and non-goals`, `## Design (proposed architecture)` and `## Risks and mitigations`.

##### F9: The date in the card bullet is unclear

- **Severity:** Low
- **Lines:** 5 and 22
- **Problem:** Line 5 ends with "2026-11-15", but the deploy and live check on line 22 happened on 2026-11-28 UTC. It is not clear what the 11-15 date refers to (the owner rule, or the card).
- **Fix:** Write "(owner rule 'fix on the spot', dated 2026-11-15; found during live check A on 2026-11-28 UTC)".

##### F10: The evidence file cannot be reached by a reader

- **Severity:** Low
- **Lines:** 22
- **Problem:** The evidence path `~/Documents/reports/...` is on the rig only, so a reviewer cannot read it.
- **Fix:** Quote the key numbers from that file, as is already partly done, and say that the file is rig-local. Or attach a redacted excerpt next to the plan.

## egm-style

### Style Goldfish review: `workerd-fetch-redirect/plan.md`, lines 1-67 (Stage 7, style)

I found 14 problems: 1 High, 6 Medium, 7 Low. Most are claims that go further than the evidence, plus a few unclear or inconsistent terms. Each claim about code below was checked against the current worktree, the base commit `b101b659`, `package.json` and `.github/workflows/ci.yml`. The plan is mostly plain and factual, with little filler.

---

#### S1. High: the Goal promises more than the change and the guard deliver

**Lines:** 18-19

**Problem:** "Every outbound `fetch` in app and package source works in workerd and refuses a 3xx response without following it" is not what the change does or what the guard checks.

- The plan changes five adapters. The guard only checks that no line literally passes `redirect: "error"`.
- These non-test server files call `fetch` and contain no `redirect` setting of their own:
  - `packages/api/src/server/golive-live-quotes.ts`
  - `packages/api/src/server/price-alerts-ntfy.ts`
  - `packages/api/src/server/vertex-orders-gateway.ts`

  They pass an `init` object built elsewhere. Nothing in this plan proves those calls refuse a 3xx.
- "Works in workerd" cannot be measured.

**Action:** CALIBRATE.

**Fix:** "No non-test `.ts`/`.tsx` file under `packages/` or `apps/` passes `redirect: "error"`. The five adapters below send `redirect: "manual"` and treat a 3xx as a failure. A CI test stops a new literal `redirect: "error"` from reaching the build."

##### S2. Medium: the date on line 5 conflicts with the other dates

**Lines:** 5, 22

**Problem:** Line 5 says the fix was found during live check A and gives "2026-11-15". Line 22 dates the deploy and live check to 2026-11-28 01:17 / 01:26 UTC. The guard's comment in `scripts/ci/fetch-redirect.test.ts` says "On 2026-11-27". The parenthetical also packs three facts together, so it is unclear whether 2026-11-15 is the date of the finding or of the owner rule.

**Fix:** Split it and date each fact. For example: "Found during live check A of that deploy card (2026-11-28 01:26 UTC). Fixed in the same job under the owner rule 'fix on the spot' (rule dated 2026-11-15)." Also choose one clock (UTC or local) and use it in the plan and the code comment.

##### S3. Medium: one successful GET is stated as "Nasdaq does not block the host"

**Line:** 24

**Problem:** One GET that returned HTTP 200 shows only that this request succeeded at that time. The plan does not say which tool sent it or which headers it used. The Nasdaq adapter sends a browser user-agent, `origin` and `referer`, so the headers matter.

**Action:** CALIBRATE.

**Fix:** "From the QuantVPS host, `<tool>` with the adapter's headers fetched the same Nasdaq URL with HTTP 200 in 1.9 s at `<time UTC>`. Nasdaq did not block that request."

##### S4. Medium: "in production the Nasdaq fallback never ran" has no time bound

**Line:** 26

Problem:

- The fallback first shipped in build `8909e65c` (PR #491). "In production" with no time range overstates the scope.
- The pause in the code is tied to *consecutive* `UNAVAILABLE` failures (`consecutiveUnavailable`, `MAX_FAILURES_BEFORE_COOLDOWN = 3`, `COOLDOWN_MS = 300_000`). The text says only "after 3 such failures".

**Action:** CALIBRATE.

**Fix:** "After 3 consecutive such failures it pauses for 5 minutes. So from the 01:17 UTC deploy to the live check, the Nasdaq fallback sent no request."

##### S5. Medium: the email/ntfy failure rule is stated wrongly

**Line:** 49

**Problem:** "status outside 200-299 gives `acceptance: "unknown"`" is not accurate. In both `notification.ts` and `ntfy.ts`, status 400, 401, 403, 404, 413, 422 and 429 give `acceptance: "rejected"`. Only the remaining non-2xx statuses, which include every 3xx, give `"unknown"`.

**Action:** CALIBRATE.

**Fix:** "Resend email and ntfy: a 3xx status is not in the reject list (400, 401, 403, 404, 413, 422, 429), so it gives `acceptance: "unknown"`, with no retry."

##### S6. Medium: the guard does not run in the "CI core lane"

**Line:** 51

Problem:

- `verify:core` does not run the Vitest `operations` project. It runs format, lint, schema, openapi, typecheck, docs and gateway checks.
- In CI, `operations` runs through `verify:coverage`, in the `coverage-shards` job, and through `test:operations` inside `verify:prepush`.
- `ci.yml` line 78 says docs-only light-lane PRs skip the operations tests.

**Action:** CALIBRATE.

**Fix:** "...Vitest project `operations`, which runs in `verify:prepush` and in the CI coverage shards (`verify:coverage`)."

##### S7. Medium: the Nasdaq request-volume risk is poorly stated, and its mitigation is overstated

**Line:** 58

Problems:

- "Nasdaq answers often" does not describe a risk. The risk is that the adapter now sends requests where it used to send none.
- The mitigation cites "its 5-minute pause after 3 `UNAVAILABLE` answers". By the plan's own Design (line 46), a 3xx now gives `UPSTREAM_ERROR`, which does not count toward the pause. If Nasdaq kept answering with a redirect, the pause would not limit the requests. The only limit would be the "Yahoo lacks a positive OI" condition.

Fix:

- Risk: "The adapter sends requests to Nasdaq where it sent none before."
- Mitigation: "The adapter runs only when Yahoo lacks a positive OI for a contract of the shown expiry. The 5-minute pause after 3 consecutive `UNAVAILABLE` answers (network error, 403, 429, 5xx) is unchanged. A 3xx gives `UPSTREAM_ERROR` and does not start the pause."

##### S8. Medium: the guard's coverage and the end-to-end check are stated too broadly

**Line:** 59

Problems:

- "The pattern covers the literal forms used in this repository" is broader than the regex. The regex `/\bredirect\s*[:=]\s*["'`]error["'`]/u` matches only when key and value are on one line. It misses a value on the next line, a variable or constant, and any file outside `packages/` and `apps/`.
- "Live check A after deploy is the end-to-end check for Nasdaq" leaves the other four adapters with no end-to-end check, and the row does not say so.

**Action:** CALIBRATE.

**Fix:** "The pattern matches single-line literal forms in tracked non-test `.ts`/`.tsx` files under `packages/` and `apps/`. A value split across lines or held in a variable is not detected. Live check A checks only Nasdaq end to end. Swinglytics, PostHog, Resend and ntfy rely on their unit tests."

##### S9. Low: "for the first time" in Risk 2 is not backed by evidence

**Line:** 57

**Problem:** The plan has no evidence that email or ntfy are enabled on `vertex-web`, or that they never sent from another runtime.

**Action:** CALIBRATE.

**Fix:** "If email or ntfy is enabled on `vertex-web`, sends that failed in workerd before can now arrive." Alternatively, cite the enable-flag state.

##### S10. Low: Yahoo chart appears in the Design but was never affected

**Lines:** 29-37 and 47

**Problem:** At base `b101b659`, `readChart` already sent `redirect: "manual"`; only `readSwinglytics` sent `"error"`. Line 47 lists "Swinglytics and Yahoo chart" together, which suggests Yahoo was broken.

**Fix:** Add to line 47: "Yahoo chart already sent `"manual"`; its behavior does not change."

##### S11. Low: different words for the same machine, and terms that are not defined

**Lines:** 14, 22, 24

Problems:

- The same host is called "the rig" (line 22), "the QuantVPS host" (line 24) and "QuantVPS" (line 11).
- "False zeros" (line 22) and "order-flow prints" (line 14) are used without a definition.

Fix:

- Use "QuantVPS host" throughout.
- Define "false zero": a contract shown with OI 0 while Yahoo or Nasdaq reports a positive OI.
- Define "order-flow print": a recorded trade in the order-flow feed. Or link to the live-check card for both terms.

##### S12. Low: "PR #491 works for Yahoo" is an inference written as a fact

**Line:** 22

**Problem:** The count "0 false zeros" is the observation. "PR #491 works for Yahoo" is a conclusion drawn from it.

**Fix:** "0 false zeros, so the Yahoo part of PR #491 behaved as intended in this run."

##### S13. Low: vague wording in the "Problem and evidence" list

**Lines:** 25, 27

Problems:

- Line 25 lists the accepted `credentials`, `cache` and `referrerPolicy` options but does not say why they matter.
- Line 27's "the fault has occurred before" is an inference from code comments.

Fix:

- Line 25: "The adapters' other options (`credentials: "omit"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"`) are accepted, so only `redirect` must change."
- Line 27: "`arxiv.ts` and `deploy-status.ts` already send `redirect: "manual"`, with comments that name this workerd limit."

##### S14. Low: Acceptance check 3 uses undefined jargon and may not be achievable

**Line:** 64

Problems:

- "Exact-SHA full CI" is not defined.
- `ci.yml` runs the browser lane only when `BROWSER_TESTS` is `on`. When it is off, the core lane runs the production build instead. A required "browser" pass may not be possible.

**Fix:** "Full CI on the merge commit SHA passes: core, coverage, integration, and browser when `BROWSER_TESTS` is on; otherwise the core-lane production build."

---

**No change needed:** the Terms definitions (lines 11-13), the affected-adapter table rows (lines 31-37) and Acceptance check 4 (line 66). Their wording is precise and matches the code.
