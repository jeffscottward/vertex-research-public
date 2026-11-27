# Style Goldfish report: Detailed Implementation Plan (Stage 9, style part)

**Target:** `docs/vertex-rebuild/designs/vertex-web-request-slot-leak-cancel/plan.md`, lines 110-125 (Mode: REVIEW)

I found 1 Blocker, 7 Major and 6 Nit findings. The tone of the section is already dry, direct and free of marketing language. Every finding below is a claim the code or tree does not support, a reference a reader cannot resolve, or a missing step that blocks implementation.

---

## 🔴 Blocker

### 1. Line 121, step 10 ("Deploy and live check"): the deploy step does not deploy the new build

- **Discrepancy:** The step reads "Build the merged SHA in the worktree, deploy with `infra/quantvps/restart-when-idle.sh` in the window."
  - Per `infra/quantvps/restart-when-idle.sh` (header, step 1) and `infra/quantvps/README.md` lines 80-84, the script run without `--deploy <sha>` "restarts the build that is live in dist and ignores any stage."
  - A deploy also needs these steps first: `pnpm install --frozen-lockfile && bun run build`, writing `apps/web/dist/DEPLOYED_SHA`, `infra/quantvps/stage-build.sh` and `infra/quantvps/stage-runtime.sh`.
- **Rationale (CALIBRATE):** "deploy with" claims more than the named command does. Followed literally, the live check would run against the old build and record false evidence for the fix.
- **Fix:** Name the full sequence:
  - build and record `DEPLOYED_SHA`
  - `stage-build.sh`
  - `stage-runtime.sh`
  - `restart-when-idle.sh --deploy <merged sha>`
- **Also:** "in the worktree" is ambiguous. The worktree is on `ws/vx-slot-leak`, but the merged SHA is a merge commit on the base branch. Say how that SHA gets checked out.

---

## 🟡 Major

### 2. Lines 113-115, steps 2-4: test file paths do not exist, and "Add the failing test to" assumes they do

- **Discrepancy:**
  - `packages/api/src/server/quantdata-client.test.ts` does not exist.
  - `packages/api/src/server/options-chain-yahoo.test.ts` does not exist.
  - `packages/api/src/server/options-chain.test.ts` does not exist. The existing file is `packages/api/src/options-chain.test.ts`, alongside other `packages/api/src/options-chain-*.test.ts` files.
- **Rationale (CALIBRATE):**
  - Step 4 points at the wrong path for a file that exists.
  - Steps 2 and 3 should say "create", not "add to".
  - Choose the location that follows the package's test convention (`packages/api/src/*.test.ts`).

### 3. Lines 112-116, steps 1-5: the plan does not match the working tree

- **Discrepancy:** The worktree already contains untracked `packages/api/src/server/bounded-wait.ts`. Its header says it is used by `quantdata-client.ts`, `options-chain-yahoo.ts` and `options-chain.ts`, and cites "plan.md (Cause, Fix A-C)".
  - `quantdata-client.ts` is modified: its header comment already describes the lease and the takeover deadline, while `let queue` (line 215) is still present.
  - The Detailed plan does not mention `bounded-wait.ts`:
    - not in the claims (line 112)
    - not in any commit
    - not in the Revert statement
  - Step 2 instead says "The waiter timer uses `setTimeout` directly."
- **Rationale (CALIBRATE):** A fresh implementer cannot tell which commit introduces the shared helper, or whether steps 3-4 should use it or add their own race. Either add the helper to step 2 (and the claims), or delete it from the tree.

### 4. Line 112, step 1: the claims list is incomplete

- **Discrepancy:** Claims cover `packages/db/src/server/**` and three `packages/api/src/server` files. Later steps also edit:
  - `apps/web/src/server/request-scope.ts` and `apps/web/src/lib/request-database-diagnostics.ts`, plus their tests (step 6)
  - `docs/debugging.md` and `ARCHITECTURE.md` (step 7)
  - the new test files in `packages/api` (steps 2-4)
  - `bounded-wait.ts` (finding 3)
- **Also:** `options-chain.ts` and `options-chain-yahoo.ts` drop the directory prefix after one fully qualified path. That makes them ambiguous, because `packages/api/src/options-chain*.ts` names exist too.
- **Rationale (CALIBRATE):** A claim list that omits touched paths is not reliable for collision checks. Give every path in full.

### 5. Line 116, step 5: list structure garbles the instruction, and unnamed references remain

- **Discrepancy 1:** "Add `route?: string` and `idleReclaimable?: boolean` to `RequestDatabaseOptions`, the Drizzle logger for activity, `REQUEST_DATABASE_SLOT_RECLAIMED` to `RequestDatabaseDiagnostic`…" breaks parallel structure. It can be read as adding the two fields to the Drizzle logger. Split it into three items:
  - add the fields to `RequestDatabaseOptions`
  - give `createRequestDatabase` a Drizzle `logQuery` logger that sets `lastActivityAt`
  - add the diagnostic code and its optional fields
- **Discrepancy 2:** "Export the two new constants" leaves the reader to look up Fix D. Name `REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS` and `REQUEST_DATABASE_SLOT_IDLE_RECLAIM_MILLISECONDS`.
- **Discrepancy 3:** "the package `server` entry" should name `packages/db/src/server/index.ts`, which already re-exports from `./client.ts` and `./request-scope.ts`.
- **Discrepancy 4:** "a test seam that resets the module state" should name the export.
- **Discrepancy 5:** The step omits the edit to `packages/db/src/server/request-scope.ts` (`openRequestScope` must forward `route` and `idleReclaimable`). It also omits its test, which Verification lists as `request-scope.test.ts` (db).
- **Discrepancy 6:** Fix D's signature `acquireRequestSlot({ route, now })` (line 69) has no `idleReclaimable`. Step 5 and Verification test (5) need that flag on the lease. Align the two.

### 6. Line 125, Revert: "Each commit reverts alone" is not supported

- **Discrepancy:**
  - Commit 5 (step 6) passes `route` and `idleReclaimable`, which commit 4 (step 5) adds to `RequestDatabaseOptions`. Reverting commit 4 alone fails `bun run check` (typecheck).
  - If commit 1 introduces `bounded-wait.ts` and commits 2-3 import it, reverting commit 1 alone breaks them too.
  - `scripts/merge-pr` uses `gh pr merge --merge`, so individual SHAs survive. Dependency, not SHA availability, is the problem.
- **Rationale (CALIBRATE):** Narrow the claim to the commits that are independent. State the required revert order (5 before 4, and any helper commit last).
- **No finding on the second sentence:** "No migration, no schema change and no new dependency" matches the plan's scope.

### 7. Line 118, step 7: the docs edits are telegraphic and cannot be carried out as written

- **Discrepancy:** "(the connection cap paragraph: the 30 s limit is Cloudflare only; leases and reclaim)" does not say what changes.
  - `ARCHITECTURE.md` line 151 currently says a canceled request "releases its slot when the connection closes within the 30 s `waitUntil` limit." The edit should state the replacement fact: on QuantVPS `workerd`, `waitUntil` runs past 30 s, and slots are released by lease release or reclaim.
  - For `docs/debugging.md`, "the 503 row and the event row" should say what each row gains:
    - the 503 row (line 11) cites `client.ts` anchors that move to `request-slots.ts`
    - the event row (line 12) needs `request-database.slot-reclaimed` and its `reason` values

### 8. Line 119, step 8: the local harness cannot be found or run, and its name differs from the rest of the plan

- **Discrepancy:** "the Miniflare harness against local Postgres" has no path, command or scenario list.
  - Verification (line 108) calls it the "`workerd` harness" and says "the cancel scenarios above," but no scenario list precedes it.
  - Evidence (line 40) calls it a "Miniflare harness."
- **Rationale (CALIBRATE):** Use one name. Either give its location and command, or state that it is not in the repository and how a reviewer gets it. Otherwise the "0 taken slots" check cannot be repeated.

---

## 🟢 Nit

### 9. Line 117, step 6: unbound identifier and vague closing step

- `idleReclaimable: !route.startsWith(...)` uses `route`, which the sentence never binds. The preceding expression is `new URL(request.url).pathname`. Bind it (`const route = …`) or repeat the expression.
- "Update tests." is vague. Name `apps/web/src/server/request-scope.test.ts` and `apps/web/src/lib/request-database-diagnostics.test.ts`, and the assertions Verification lines 108-109 require.
- "with attributes" should say "with `reason`, `route`, `ageSeconds`, `idleSeconds`".

### 10. Line 113, step 2: terminology drift and a jargon word

- Fix A says "holder record" and "takeover deadline," not "waiter loop." Reuse Fix A's terms.
- "cannot spin" is jargon. Say "cannot busy-loop."

### 11. Lines 114-115, steps 3-4: constant naming

- `SESSION_WAIT_MS = 2 * timeoutMs + 2000` is computed from the per-adapter `timeoutMs` option, so it cannot be a module-level constant. `options-chain-yahoo.ts` line 171 resolves `timeoutMs` inside the factory.
- SCREAMING_CASE implies a module-level constant. State where it is defined, or use a camelCase local.

### 12. Line 120, step 9: unfilled placeholder and an underspecified merge

- `Owner decision: not needed (...)` is an unfilled placeholder. `scripts/ci/merge-conditions.ts` lists the owner-decision prefixes as `services/execution-kernel/`, `infra/quant-vps/exec-node/`, `infra/golive-drafts/` and `scripts/golive/`, plus word matches for risk, arming, caps, sizing and similar. No planned path matches, so the line is not required.
  - Either drop it, or write the reason (20 or more characters per AGENTS.md line 261).
- "CI" should name the required check: "`ci-gate` green on the reviewed head" (AGENTS.md line 195).
- "merge with `scripts/merge-pr`" should show its required arguments: `<pr> --card vertex-web-request-slot-leak-cancel --head <reviewed sha>`.

### 13. Line 121, step 10: "in the window" relies on a reference elsewhere

- Restate the window here: "after 16:00 ET or before 08:30 ET on NYSE trading days." That is the step where the operator chooses when to run the script, and the script refuses with exit 14 inside market hours.

### 14. Outside DetailedRange (lines 108-109), but it affects step 6: list nesting

- The `apps/web/src/server/request-scope.test.ts` bullet (line 108) is not indented, while `request-database-diagnostics.test.ts` (line 109) is nested under it. Both belong under "Failing tests first."
- If both are meant as failing-first tests, step 6's "Update tests" contradicts that. Make one of the two consistent with the other.
