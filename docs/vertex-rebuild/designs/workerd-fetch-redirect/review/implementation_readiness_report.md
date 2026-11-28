# Stage 9 implementation readiness report

## egm-implementation-readiness

### Stage 9 implementation readiness review: `workerd-fetch-redirect/plan.md`, lines 68-84

**Verdict:** The plan is close to ready. Steps 1-9 (lines 70-78) are concrete and correct. Every file, function, test and table they name exists in the repo. The base for checks was `b101b659`, and the current worktree diff for this change matches steps 1-9 one to one, so a fresh engineer could carry them out. The gaps are in the guard specification, verification and rollback. Two of them break the zero-decision rule.

#### Findings

##### F1. Medium: the rollback cannot be run as written (line 84)

**Problem:** "Revert the merge commit and deploy the previous build with `infra/quantvps/restart-when-idle.sh`" mixes two different actions.

- If it means redeploying the **old SHA**, the script's version guard (step 1b) refuses a build that is a strict ancestor of the deployed SHA. It exits 9 unless `--allow-older <reason>` is passed.
- If it means deploying the **revert commit**, the plan leaves out the build stage. `--deploy <sha>` needs a complete stage made by `stage-build.sh` first, or the script exits 3.
- The section also misses three points:
  - The market-hours guard (exit 14) means the rollback must also run off-hours.
  - A rollback brings the workerd fault back. Nasdaq OI fallback, Swinglytics, PostHog, Resend and ntfy all go silent again.
  - The revert also removes the CI guard.

**Fix:** Replace line 84 with explicit steps:

1. `git revert -m 1 <merge-sha>` and merge it.
2. On the rig, stage the revert commit with `infra/quantvps/stage-build.sh`.
3. Off-hours, run `infra/quantvps/restart-when-idle.sh --deploy <revert-sha>`. Do not redeploy the old SHA, because the version guard refuses it.
4. Expect this effect: the five adapters fail in workerd again, as they did before. No data or schema effect.

##### F2. Medium: the "test file" rule of the CI guard is not defined (line 77, which points to Design line 52)

**Problem:** Step 8 says only "add the guard described in Design". Design says the guard "skips test files" but does not say what a test file is. The implementer has to choose between `.test.ts(x)` only, `.spec.ts(x)` too, or also `test/`, `tests/` and `__tests__/` folders. That choice sets which source the guard checks.

Design also gives the match pattern only in prose, and it does not list:

- the sample lines for the second test case;
- the assertions beyond `file:line`.

For reference, the worktree version adds a `files.length > 100` sanity check and uses `TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.tsx?$/u`.

**Fix:** In step 8, state:

- the exact regex `\bredirect\s*[:=]\s*["'`]error["'`]` (flag `u`);
- the exact test-file regex;
- the `git ls-files -z -- packages/*.ts packages/*.tsx apps/*.ts apps/*.tsx` call;
- the sample lines and expected result: three match lines (`redirect: "error"`, `redirect: 'error'`, `` init.redirect = `error` ``) and three non-match lines (`"manual"`, `"follow"`, `const mode = "error"`), expected `[1, 2, 3]`;
- any sanity assertion, such as a minimum file count.

##### F3. Medium: acceptance check 1 has no verification step (line 79; compare line 63)

**Problem:** Acceptance check 1 requires the guard to **fail** when one `redirect: "error"` line is put back in an affected adapter. Step 10 runs the guard only on the fixed tree, so this negative check is never planned or recorded.

**Fix:** Add to step 10:

1. Change one adapter, for example `options-chain-nasdaq.ts`, back to `redirect: "error"`.
2. Run `pnpm exec vitest run --config vitest.config.ts --project operations scripts/ci/fetch-redirect.test.ts`.
3. Confirm it fails and names `packages/api/src/server/options-chain-nasdaq.ts:<line>`.
4. Restore the file and rerun.

##### F4. Low: verification commands are not exact, and the test files use two Vitest projects (line 79)

**Problem:** "Focused Vitest run of the seven test files" gives no command. The six adapter tests are in the `unit` project. `scripts/ci/fetch-redirect.test.ts` is in the `operations` project (`include: scripts/**/*.test.ts`). A run with only `--project unit` silently skips the guard. "`turbo run typecheck` for …" also gives no filter syntax.

**Fix:** Write out the commands:

- `pnpm exec vitest run --config vitest.config.ts --project unit --project operations <seven paths>`
- `pnpm exec turbo run typecheck --filter=@darkfactory/api --filter=@darkfactory/analytics --filter=@darkfactory/email --filter=@darkfactory/notifications`
- `pnpm exec tsc --noEmit -p scripts/tsconfig.json`
- `bun run verify:prepush`

Also state that no `vitest.config.ts` change is needed, because the `operations` include glob already picks up the new test.

##### F5. Low: some file paths are not full repo-relative paths (lines 74-76)

**Problem:** `posthog.test.ts`, `notification.test.ts`, `ntfy.test.ts` and `dispatch/dispatch.test.ts` are written relative to the previous path. The standard asks for exact repository-relative paths so they can serve as a write allowlist. The plan's own files (`plan.md`, `before-after.png`) are also not in the list.

**Fix:** List the full paths:

- `packages/analytics/src/server/posthog.test.ts`
- `packages/email/src/server/notification.test.ts`
- `packages/notifications/src/server/ntfy.test.ts`
- `packages/notifications/src/server/dispatch/dispatch.test.ts`
- `docs/vertex-rebuild/designs/workerd-fetch-redirect/{plan.md,before-after.png}`

Add one sentence: "No other file is changed."

##### F6. Low: the comment rule is inconsistent across adapters (lines 70, 72, 74-76)

**Problem:** Only step 1 requires a comment that names the workerd limit. Steps 3 and 5-7 make the same change without that rule, so the implementer decides whether to add one. The worktree adds comments in all five adapters.

**Fix:** In steps 3, 5, 6 and 7, add "with a one-line comment: workerd rejects `"error"`; `"manual"` returns a 3xx and the existing 2xx/`!ok` check refuses it."

##### F7. Low: another design document still describes the old behavior (line 78)

**Problem:** Step 9 updates only `research-screen/design.md`. `docs/vertex-rebuild/designs/vertex-chain-oi-yahoo-false-zero/plan.md` line 76 still says "Network / timeout / `redirect: "error"` throw -> `UNAVAILABLE`" for the same Nasdaq adapter. After this fix, a 3xx gives `UPSTREAM_ERROR`. The implementer has to decide whether to update this historical plan.

**Fix:** Do one of these:

- Add a step that changes that line to "Network / timeout throw -> `UNAVAILABLE`; HTTP 3xx (redirect `"manual"`) -> `UPSTREAM_ERROR`".
- State explicitly that card plans are historical records and stay unchanged.

##### F8. Low: no phases or checkpoints (lines 70-80)

**Problem:** The standard asks for incremental phases, each of which leaves the build and tests green. Steps 1-9 are a flat list. Order matters: for example, step 3 without step 4 breaks `research-screen-evidence.test.ts`, which still expects `"error"`.

**Fix:** Group the steps into phases:

- **Phase A:** each adapter together with its test (1+2, 3+4, 5, 6, 7). Checkpoint: the focused unit run passes.
- **Phase B:** the guard (step 8). Checkpoint: positive and negative runs, as in F3.
- **Phase C:** docs (step 9). Checkpoint: `bun run docs:check`.
- **Phase D:** gate, PR CI and deploy (steps 10-11).

#### Checked and found correct (no finding)

- **Step 2:** The first test in the `createNasdaqOptionsOpenInterestSource` block (test file line 179) makes two requests (stocks, then etf). The HTTP error table exists (line 298 onward).
- **Step 3:** `BoundedRequest.redirect`, `readChart` and `readSwinglytics` are exactly where the plan says. `readChart` already used `"manual"`.
- **Steps 5 and 7:** The 307 PostHog test and the 302 ntfy test exist.
- **Step 7:** `dispatch.test.ts` asserted `redirect: "error"`, so it is correctly included.
- **No other affected files:** No other non-test source under `packages/` or `apps/` uses a non-literal or quoted-key `redirect` form. The only remaining `"error"` uses are the two exempt files named in the plan.
- **References in steps 10-11 and the rollback:** `scripts/tsconfig.json`, `infra/quantvps/README.md`, `infra/quantvps/restart-when-idle.sh` and the four `@darkfactory/*` package names all exist. The compatibility date and flag match `apps/web/wrangler.jsonc`.
- **Coverage ratchet:** The changes only add comments, tests and removed lines, so no baseline entry in `scripts/ci/coverage-baseline.json` needs an update.

## egm-codebase-details

### Codebase-details review of `docs/vertex-rebuild/designs/workerd-fetch-redirect/plan.md`

The plan does not pass the implementation-readiness standard yet, mainly because of three blockers.

- **Nasdaq description is out of date (F1, F2):** while I was reviewing, the working tree changed. The Nasdaq adapter now handles a 3xx response differently from what the plan says. The plan file itself did not change.
- **Goal claims too much (F3):** two server adapters that send a token header still follow redirects.
- **CI guard lane is wrong (F4):** the guard does not run in the CI core lane.

I checked every factual claim in lines 1-67 and every step in lines 68-84 against the code. I compared the working tree with `git diff origin/vertex/rebuild-darkfactory-20260921`, read it twice during the review, and searched the whole repository.

#### Findings

##### F1 — High (blocker: contradicts the code) — lines 45, 44, 56, 58

- **Problem:** line 45 says a Nasdaq 3xx becomes `UPSTREAM_ERROR` through `!response.ok` and does not count toward the 5-minute pause. The working tree does something else:
  - `packages/api/src/server/options-chain-nasdaq.ts` now has a separate condition `(response.status >= 300 && response.status < 400) || 403 || 429 || >= 500`. This throws `UNAVAILABLE` "Nasdaq options returned HTTP 3xx".
  - `noteFailure` counts `UNAVAILABLE`, so three 3xx answers in a row start the 5-minute pause.
  - A new test, `pauses after repeated 3xx answers, like other UNAVAILABLE answers`, asserts exactly this.
- **Knock-on errors:**
  - Line 44 says every adapter's 3xx "takes the existing failure path". For Nasdaq this is a new path.
  - Line 58 says the pause "is unchanged". It now also fires on 3xx answers.
  - Line 56 does not mention that Nasdaq moves from `UNAVAILABLE` (thrown exception) to `UNAVAILABLE` (3xx). The category stays the same, but it now feeds the pause.
- **Fix:**
  - Rewrite line 45: "Nasdaq: a 3xx answer gives `UNAVAILABLE` 'Nasdaq options returned HTTP 3xx' (treated like 403/429/5xx, because a redirect is often a bot wall). It counts toward the pause after 3 consecutive `UNAVAILABLE` answers."
  - Correct line 44 so it says Nasdaq gets a new 3xx branch.
  - In line 58, add that repeated 3xx answers now trigger the pause.

##### F2 — High (blocker: steps do not match the change) — lines 70, 71, 68-79

- **Line 70:** step 1 only swaps the `redirect` value. The diff also adds the 3xx clause to the `UNAVAILABLE` condition in `readDocument`. An implementer following step 1 would produce code that fails the updated tests.
- **Line 71:** step 2 says the 302 row expects `UPSTREAM_ERROR`. The test now expects `UNAVAILABLE`. Step 2 also does not list the new pause test.
- **Missing file:** the diff also modifies `docs/vertex-rebuild/designs/vertex-chain-oi-yahoo-false-zero/plan.md` (it marks the old `redirect: "error"` row as superseded and maps 3xx to `UNAVAILABLE`). No step lists this file, so the file boundary is incomplete.
- **Fix:**
  - Step 1: "add `(response.status >= 300 && response.status < 400)` to the `UNAVAILABLE` condition before `!response.ok`."
  - Step 2: "302 expects `UNAVAILABLE`; add test `pauses after repeated 3xx answers…` (3 × 302 → 3 × `UNAVAILABLE`, then `OptionsChainSourceOff`, fetch called 3 times)."
  - Add step 9b: "`docs/vertex-rebuild/designs/vertex-chain-oi-yahoo-false-zero/plan.md` (Modify): the error matrix maps 3xx to `UNAVAILABLE`, with a 'Superseded' note."

##### F3 — High (claim contradicts the code) — line 18 (Goal)

- **Problem:** the Goal says "Every outbound `fetch` in app and package source … refuses a 3xx response without following it." That is not true. Two server adapters send no `redirect` field, so they use the default `"follow"`:
  - `packages/api/src/server/golive-live-quotes.ts:165`: POST with an `x-vertex-bridge-token` header.
  - `packages/api/src/server/vertex-orders-gateway.ts:299`: GET/POST with an `x-vertex-bridge-token` header.
- **Why it matters:** both follow redirects and would resend the bridge-token header to the new location. Browser and client fetches under `apps/web` and `apps/desktop` also have no `redirect` field.
- **Fix:** narrow the Goal to "Every outbound `fetch` that used `redirect: \"error\"` now works in workerd and still refuses a 3xx." Then either:
  - list the two bridge adapters as out of scope, with a follow-up card, or
  - add them to scope, setting `redirect: "manual"` and adding a 3xx test for each.

##### F4 — Medium (claim contradicts the code) — line 50

- **Problem:** line 50 says the guard runs "in `verify:prepush` and in the CI core lane".
  - The `prepush` part is correct: `verify:prepush` runs `test:operations`, and `vitest.config.ts` project `operations` includes `scripts/**/*.test.ts`.
  - The core-lane part is wrong. The core lane runs `bun run verify:core` (format, lint, auth schema, openapi, typecheck, docs, gateway), which runs no Vitest project.
  - The `operations` project runs in CI only through `verify:coverage`, in the `coverage-shards` job. `ci.yml` line 78 confirms that docs-only light-lane PRs skip the operations tests.
- **Fix:** replace "and in the CI core lane" with "and in the CI coverage shards (`verify:coverage`); docs-only light-lane PRs skip it."

##### F5 — Medium — line 84 (Rollback)

- **Problem:** "deploy the previous build with `infra/quantvps/restart-when-idle.sh`" cannot be done as written. `infra/quantvps/README.md` describes how deploys and the script actually work:
  - A deploy needs `stage-build.sh` and `stage-runtime.sh`, then `restart-when-idle.sh --deploy <sha>`.
  - The version guard exits 9 when the build is older than the deployed one, unless `--allow-older "<reason>"` is passed.
  - Without `--deploy`, the script only restarts the build that is already live.
- **Fix:** choose one route and write it out exactly:
  - (a) Revert commit → full CI → `stage-build.sh` / `stage-runtime.sh` → `restart-when-idle.sh --deploy <revert-sha>`, outside market hours; or
  - (b) `restart-when-idle.sh --backup <TS> --allow-older "rollback workerd-fetch-redirect"`.

##### F6 — Medium — lines 68-81 (file boundary)

- **Problem:** the steps use verbs ("change", "add") but do not mark each path `Create`, `Modify` or `Delete`. For example, `scripts/ci/fetch-redirect.test.ts` is a new file, but step 8 only says "add the guard".
- **Fix:** prefix each path with `Create`, `Modify` or `Delete`.

##### F7 — Medium — line 57 (Risk row 2)

- **Problem:** the row covers only "email and ntfy", but the ntfy fix reaches more alerts. `sendPriceAlertsNtfy` (`packages/api/src/server/price-alerts-ntfy.ts`) builds a `createNtfyNotificationAdapter`, and two callers use it:
  - `packages/api/src/server/connectivity.ts:80`
  - `packages/api/src/server/openbb-overdue.ts`

  So connectivity alerts and OpenBB-overdue alerts will also start arriving for the first time.
- **Fix:** name `connectivity.ts` and `openbb-overdue.ts` (price-alert ntfy path) in the row's Effect column.

##### F8 — Low — line 79 (Verification)

- **Problem:** "focused Vitest run of the seven test files" gives no command. The seven files belong to different Vitest setups:
  - five package-level `test:unit` runs through turbo;
  - the root `operations` project for `scripts/ci/fetch-redirect.test.ts`.
- **Fix:** give exact commands, for example `pnpm exec vitest run --config vitest.config.ts --project operations scripts/ci/fetch-redirect.test.ts`, plus `bunx turbo run test:unit --filter=@darkfactory/api --filter=@darkfactory/analytics --filter=@darkfactory/email --filter=@darkfactory/notifications`.

##### F9 — Low — line 50 (guard scope not stated)

- **Problem:** the guard has limits the plan does not state:
  - It scans only `.ts`/`.tsx` under `packages/` and `apps/`. `.mts`, `.mjs` and `.js` are not scanned.
  - `scripts/`, `infra/` and `tests/` are not scanned.
  - "Skips test files" actually means the regex `(^|/)(test|tests|__tests__)/|\.(test|spec)\.tsx?$`. This also skips whole `test/` folders.
- **Fix:** state the extensions, directories and exact skip rule.

##### F10 — Low — line 11

- **Problem:** `run-preview.mjs` is given without its path.
- **Fix:** write `infra/quantvps/run-preview.mjs`.

#### Claims I checked and found correct

- **Line 7:** base `b101b659` matches `origin/vertex/rebuild-darkfactory-20260921`.
- **Line 22:** `8909e65c3e60717edbd3872f1f383cc359c19275` is the merge of PR #491 (2026-11-27 19:35 −05:00, which is 00:35 UTC on 11-28). It is an ancestor of the base.
- **Lines 11 and 25:** `apps/web/wrangler.jsonc` has compatibility date `2026-07-22` and flag `nodejs_compat`. `workerd@1.20261023.1` is installed. `infra/quantvps/run-preview.mjs` exists.
- **Lines 26 and 58:** `COOLDOWN_MS = 300_000` and `MAX_FAILURES_BEFORE_COOLDOWN = 3` (consecutive `UNAVAILABLE`). A fetch exception gives "Nasdaq options could not be reached". `nasdaqSkipReason` in `options-chain-merge.ts` matches the Yahoo-positive-OI condition.
- **Line 27:** `arxiv.ts:336` and `deploy-status.ts:220` already have the workerd comment.
- **Line 46:** Swinglytics and Yahoo share `boundedRead` (`!response.ok` gives `provider-http`). `readChart` already used `"manual"`.
- **Line 47:** PostHog `providerFailure(3xx)` gives `provider-rejected` with `retryable: false`. The existing 307 test is still there.
- **Line 48:** Resend and ntfy map a status outside 200-299 to `"unknown"` with no retry. The existing ntfy 302 case is still there.
- **Line 49 and step 3:** `BoundedRequest.redirect` is removed, and `boundedRead` hard-codes `"manual"`.
- **Steps 4-7 and 9:** the diff matches each step.
- **Line 39:** `browser-provider.test.tsx:466` is a test input. `scripts/golive/collect.ts:373` runs under Bun (`infra/golive-drafts/vertex-golive-drafts-run` runs `bun run vertex:golive:collect`).
- **Lines 39 and 43 (runtime behaviour):** I ran a check locally. Node and Bun accept `"error"` and throw on a 302. With `"manual"`, both return the 302 response.
- **Line 79:** the package names `@darkfactory/{api,analytics,email,notifications}` exist, and `scripts/tsconfig.json` includes `scripts/ci`.

#### Search for other `redirect: "error"` uses

- **Literal value:** among tracked non-test, non-doc code, the only remaining `redirect` set to `"error"`, `'error'` or `` `error` `` is `scripts/golive/collect.ts:373`. It runs under Bun, where `"error"` works, and the guard does not scan it. The literal also appears in `apps/web/src/features/experience/browser-provider.test.tsx:466` (test input) and in markdown under `docs/vertex-rebuild/designs/vertex-chain-oi-yahoo-false-zero/`.
- **Indirect forms:** no non-test source sets the redirect mode through a variable, a `RequestRedirect` cast, shorthand `{ redirect }`, or a spread object.
- **Default `"follow"`:** the outbound fetches that set no `redirect` field are covered in F3.

## egm-style

The Implementation Plan section (lines 68–84) is mostly ready to follow but not fully: two Medium findings in the rollback and verification steps, plus nine Low wording and locator findings. I checked every file, function, test name, script and package name in lines 70–84 against the repository. All of them exist and are named correctly. The working tree already contains the changes that steps 1–9 describe (uncommitted), and the source and test changes match the plan's wording.

### Findings

S1 — Medium — line 84 (Rollback):

- **Problem:** "deploy the previous build with `infra/quantvps/restart-when-idle.sh`" can mean two different procedures:
  - Deploy a new revert commit.
  - Redeploy the old SHA.
- **Why it matters:** `infra/quantvps/README.md` (Version guard, line 95) says the script stops with exit 9 when the new SHA is an ancestor of the deployed SHA, unless `--allow-older "<reason>"` is passed. A `--deploy <sha>` run also needs the README build-stage steps first. An operator who follows line 84 literally can hit exit 9 or exit 3.
- **Fix:** "Revert the merge commit through a PR. Deploy the revert commit with the normal procedure in `infra/quantvps/README.md` (`restart-when-idle.sh --deploy <revert-sha>`). To redeploy the old build SHA directly instead, pass `--allow-older "<reason>"`."

S2 — Low — line 84 (CALIBRATE):

- **Problem:** "The change has no data or schema effect" claims more than is true. The Risks section (line 57) says emails and ntfy alerts start to send from workerd after this change. Messages and PostHog events sent while the change is live cannot be withdrawn by a rollback.
- **Fix:** "No schema, migration or stored-data change. Emails, ntfy alerts and PostHog events sent while the change was live stay sent."

S3 — Medium — line 79 against line 65:

- **Problem:** Step 10 ends with "the pre-push gate and PR CI". Acceptance check 3 (line 65) requires "Exact-SHA full CI (core, coverage, integration, browser) … on the merge commit". The two steps name different gates, so the implementer cannot tell which one ends the step.
- **Fix:** End step 10 with "…then `bun run verify:prepush`, PR CI, and exact-SHA full CI (core, coverage, integration, browser) on the merge commit (acceptance check 3)."

S4 — Low — line 79:

- **Problem:** Several parts of step 10 do not name an exact command:
  - "Focused Vitest run of the seven test files above" makes the reader count the files. The files are also in two Vitest projects: `scripts/ci/fetch-redirect.test.ts` is in `operations`; the rest are package tests.
  - "the pre-push gate" does not name its script.
  - `biome format` can run as a check or as `--write`; the step does not say which.
- **Fix:** List the seven files, or give one command: `pnpm exec vitest run --config vitest.config.ts <files>`. Name `bun run verify:prepush`. Say "`biome format` (check only, no `--write`)".

S5 — Low — line 78:

- **Problem:** Step 9 describes an end state ("the Swinglytics request line now says…") where every other step gives an action. "now" is also a relative time word.
- **Fix:** "`docs/vertex-rebuild/designs/research-screen/design.md`: in the Swinglytics request line, change `redirect: "error"` to `redirect: "manual"` and state that workerd rejects `"error"` and that a 3xx is refused as `provider-http`."

S6 — Low — lines 70, 72, 74–76:

- **Problem:** Only step 1 asks for "a comment that names the workerd limit". Steps 3, 5, 6 and 7 do not ask for it, but the working tree adds the same comment in all five adapters. The rule is either required everywhere or optional; the text does not say which.
- **Fix:** State it once before step 1: "Each changed `redirect` line gets a one-line comment that names the workerd limit." Remove the clause from step 1.

S7 — Low — line 76:

- **Problem:** "send and expect `redirect: "manual"`" covers three files. `dispatch/dispatch.test.ts` only expects; it sends nothing.
- **Fix:** "`ntfy.ts`: send `redirect: "manual"`. `ntfy.test.ts` and `dispatch/dispatch.test.ts`: expect it. The existing 302 case in `ntfy.test.ts` keeps `acceptance: "unknown"`."

S8 — Low — line 71:

- **Problem:** The step's locators do not match the test file:
  - No test is called "the HTTP error table". The cases are an array inside the test "rejects bad inputs, maps HTTP and parse errors safely without leaking vendor messages, and uses global fetch by default".
  - "Both requests" does not say why there are two. They are the stocks attempt and the etf fallback.
- **Fix:** Name the test, and write "assert that both requests (stocks, then the etf fallback) use `redirect: "manual"`".

S9 — Low — lines 72–73:

- **Problem:** Step 3 changes the `readChart` (Yahoo chart) request. Design line 46 states the Yahoo chart result for a 3xx. Step 4 and acceptance check 2 test only Swinglytics, so the Yahoo chart claim has no test of its own. Also, the fixture text `"fetch failed\nredirect mode is set to error"` (test file line 629) still describes the fault this plan removes.
- **Fix:** Add a sentence to step 4: "Yahoo chart uses the same `boundedRead`; the Swinglytics 302 case covers it." Otherwise, add a `readChart` 302 case. Optionally change the fixture text to a neutral network error such as `"fetch failed"`.

S10 — Low — line 74:

- **Problem:** "the existing 307 test keeps `provider-rejected`" can be read to mean the test does not change. In fact its `redirect` assertion changes from `"error"` to `"manual"`.
- **Fix:** "The existing 307 test ('fails closed instead of forwarding a redirect response') keeps its `provider-rejected` expectation and now expects `redirect: "manual"`."

S11 — Low — line 80:

- **Problem:** "deploys the merge commit off-hours" does not define "off-hours". The README has a specific rule for it: exit 14 under "Market hours guard".
- **Fix:** "…deploys the merge commit outside US market hours (see 'Market hours guard' in `infra/quantvps/README.md`)…".
