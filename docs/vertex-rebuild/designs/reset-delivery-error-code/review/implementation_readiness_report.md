# Stage 9: Implementation readiness review (DetailedRange)

## egm-implementation-readiness

The detailed plan (lines 73–114) is not ready to implement as written. It has 1 blocker, 3 major findings and 3 nits. The blocker is that the acceptance test expects the client to receive an error it never receives. Note that `packages/auth/src/server.ts` already contains uncommitted changes that match step 1. I checked everything below against that working-tree file and the Better Auth version in `node_modules`, which is 1.7.14.

### 🔴 Blocker

#### 1. Lines 105–109 (Acceptance test): the client-facing assertion is false, and no file is named for the test

- **What the plan says:** a reset whose port result is `failed` makes "the client still get `PASSWORD_RESET_DELIVERY_FAILED`".
- **What the code does:** Better Auth calls `sendResetPassword` through `ctx.context.runInBackgroundOrAwait(...)` (`better-auth/dist/api/routes/password.mjs:82`).
  - `createAuth` sets `advanced.backgroundTasks.handler = options.scheduleBackgroundTask`.
  - So the promise is handed to the scheduler as `promise.catch(e => logger.error(...))` (`context/create-context.mjs:215-224`).
  - The response is always `SAFE_RESET_RESPONSE` (status 200, `{status: true, message: ...}`). `tests/integration/auth/auth.test.ts:677-692` already asserts this.
  - The thrown `PASSWORD_RESET_DELIVERY_FAILED` only reaches Better Auth's logger. That matches the "server log shows only …" symptom, but it never reaches the client.
- **Consequence:** an implementer cannot make this test pass without changing client behaviour, which the non-goals forbid.
- **No harness is named:** the plan says "the web request emits", but none of the six steps owns this test.
  - `request-scope.test.ts` mocks `createAuth`.
  - `tests/integration/auth/auth.test.ts` uses `createAuth` without `withRequestScope`.
  - So the implementer would have to design a new end-to-end harness.
- **Guidance:**
  - Change the assertion to: the client gets `SAFE_RESET_RESPONSE`, and the event is emitted after the scheduled background tasks are drained.
  - Name the file and level for the test, for example a new case in `tests/integration/auth/auth.test.ts` that passes an `onEmailDeliveryFailure` spy, plus the mapper unit test.
  - Add that file to the file list.

##### 🟡 Major

#### 2. Lines 87–90 (step 2), with line 99: the store-failure and over-cap tests cannot be written in the file the plan names

- In `verification-config.test.ts`, `createConfiguredAuth` hard-codes `rateLimitEnabled: false` and `database: {} as never`.
  - `recipientMayReceiveMail` therefore returns `true` without touching the store.
  - So `recipient-limit-failed` and "no report on the silent over-cap skip" cannot be triggered there.
- The existing harness for these paths is `packages/auth/src/abuse-limits.test.ts`.
  - It already does `vi.mock("./rate-limit-storage.ts")`.
  - It already has "caps … and skips silently" (around line 274) and "maps a recipient-cap store failure" (around line 295).
- That file is not in the file list. The implementer must either expand the write boundary or add a new mock to `verification-config.test.ts`.
- `createConfiguredAuth` also has no parameter for `onEmailDeliveryFailure`, and the plan does not say how to thread one in.
- **Guidance:**
  - Put the recipient-limit and over-cap cases in `abuse-limits.test.ts` and list that file.
  - Keep the `delivery-failed`, `delivery-threw` and throwing-callback cases in `verification-config.test.ts`.
  - Say how the helper accepts the callback.
  - Update "the three test files" on line 99 to match.

#### 3. Lines 91–94 (step 3): the mapper is not specified

Several decisions are left to the implementer:

- **Function name and options:** the step names a file but no exported factory or option shape. By analogy it would be `createAuthEmailDeliveryFailureSink({ sink, scheduleBackgroundTask, requestId })`. Step 4's `request-scope` assertion depends on this name.
- **Attribute keys:** "the other fields as attributes" (Design 5, lines 61–64) does not say whether `code` is repeated in `attributes` alongside `errorCategory`. It also does not give the exact key set: `operation`, `reason`, `provider`, `retryable`, `errorName`?
- **Allowlist source:** `EmailDeliveryFailureCode` is a type-only union in `packages/email/src/index.ts`, so no runtime array exists. `EMAIL_ADAPTERS` is exported from `@darkfactory/email/adapters`, but `"preview"` and `"disabled"` are not in it. The implementer must choose between hard-coding a `satisfies readonly EmailDeliveryFailureCode[]` list in `apps/web` and adding a runtime constant to `packages/email`, which is outside the file boundary.
- **`errorName`:** this is not a finite set, so "rebuilds the event from an allowlist of known values" cannot apply to it directly. The plan does not say whether the mapper re-checks it with the `/^[A-Za-z_$][\w$]{0,63}$/` rule, swaps in `"UnknownError"`, or drops it. The same applies to type-checking `retryable` as a boolean.
- **Rejection behaviour:** "allowlist rejection of forged values" does not say what happens when only one field is forged. The options are to drop the whole event (as `request-database-diagnostics.ts` does by returning `undefined`) or to emit the event without the bad field.
- **Guidance:** give the exported signature, the exact event literal for each reason (as in `request-database-diagnostics.test.ts:38-48`), where the allowlist constants live, and the rule for each field.

#### 4. Lines 95–97 (step 4): the wiring is underspecified, and the emission runs after the response

- The step should state the literal `createAuth` argument, for example `onEmailDeliveryFailure: createAuthEmailDeliveryFailureSink({ sink, scheduleBackgroundTask: waitUntil, requestId })`. It should name `apps/web/src/server/request-scope.test.ts` and say that the exact-match `toHaveBeenCalledWith` at about line 133 gains `onEmailDeliveryFailure: expect.any(Function)`.
- **Timing:** for reset (always) and sign-up verification, the report runs inside a task tracked on `database.schedule`, which runs after the response. The raw `waitUntil` call therefore happens later.
  - The plan should confirm this is the intended model: finalization keeps the invocation alive while it drains tracked tasks.
  - The `request-scope` test should drain the scheduled tasks before asserting `emit`, as the existing case at about lines 169–192 does.

##### 🟢 Nit

**5. Line 76:** "Export `AuthEmailDeliveryFailure` …" gives no type definition.

- Design 2 can be encoded as a flat object with optional fields or as a discriminated union. The working tree uses a union.
- The plan should pin the union, because tests that use `toEqual` and the mapper's narrowing both depend on it.
- It should also pin `AuthEmailDeliveryFailureSink`'s return type as `void`. An `async` callback is assignable to that type, and its rejection would escape the `try`/`catch` described on line 78.

**6. Lines 80–83:** step 1 leaves out the supporting edits the change needs:

- a new type-only import of `EmailDeliveryResult`, `EmailDeliveryFailureCode` and `EmailProvider` from `@darkfactory/email`;
- a `let result: EmailDeliveryResult` declaration before the port `try`;
- a helper that builds the `delivery-failed` value. The working tree added a `deliveryFailed(operation, result)` helper; the plan does not say whether one is wanted.

**7. Lines 98–101:** a few details are imprecise.

- Step 5 should give the row text in the same format as `docs/debugging.md:12`: the event name, then `apps/web/src/lib/auth-email-diagnostics.ts#<factory>`.
- Step 6 should list the test files by full path.
- "Does not fall for the changed files" should name the legacy baseline that applies: `server.ts` has a minimum of 98.64 lines / 95.92 branches in `scripts/ci/coverage-baseline.json:1090`. `request-scope.ts` and the new mapper must stay at 100%.

Phasing and rollback are adequate. Each step leaves the code buildable, because the callback is optional and not set until step 4, and reverting the PR commits is enough to roll back because no data or schema changes.

## egm-codebase-details

I found 1 blocker, 6 major findings and 6 nits in the Detailed Implementation Plan (lines 73–114). I checked it against `HEAD` and the runtime code. The worktree is also mid-implementation and has uncommitted changes in `packages/auth/src/server.ts` and `verification-config.test.ts`. Where that partial work shows a gap in the plan, I say so.

### 🔴 Blocker

**1. Lines 105–108: the client does not get `PASSWORD_RESET_DELIVERY_FAILED`.** The acceptance test says "the client still gets `PASSWORD_RESET_DELIVERY_FAILED`". The code does something else, for two independent reasons:

- **Better Auth runs the callback in the background.** In better-auth 1.7.14, `dist/api/routes/password.mjs:82` calls `sendResetPassword` through `ctx.context.runInBackgroundOrAwait(...)`. `createAuth` sets `advanced.backgroundTasks.handler = options.scheduleBackgroundTask` (`server.ts`), which `request-scope.ts` sets to `database.schedule`. In that case `create-context.mjs:215-221` hands the promise to the handler with `.catch(logger.error)` and the route returns 200 `{status: true, message: …}` right away. The thrown error never reaches the response.
- **The route bridge hides it anyway.** Even if a 503 came back, `createAuthHandler` (`server.ts`) checks `isResetRequest(request) && (response.ok || isDeliveryFailure(response, PASSWORD_RESET_DELIVERY_ERROR_CODE))` and rewrites the response to `SAFE_RESET_RESPONSE` with status 200.

What the client really gets is the safe 200 reset response. An implementer who writes this acceptance test as stated will see it fail. The "server log shows only `PASSWORD_RESET_DELIVERY_FAILED`" line in Problem holds only because Better Auth logs the background error with `logger.error("Failed to run background task:", e)`. The plan should state the real behavior: the reset callback runs inside a `database.schedule` background task after the response, and the client sees the safe 200 response. (The verification path differs: `/send-verification-email` awaits `sendVerificationEmailFn` directly, while sign-up runs it in the background.)

#### 🟡 Major

**2. Lines 103–109: no test file implements the acceptance test, and its timing is not stated.** Step 4's `request-scope.test.ts` mocks `createAuth` (`vi.fn(() => ({ kind: "auth" }))`). Step 2 mocks `betterAuth`. Nothing runs reset → Better Auth → mapper → evlog end to end.

- Because the reset failure fires inside a scheduled background task, any test of "makes the web request emit" has to wait for the tracked task and then for the raw-`waitUntil` emission.
- The plan does not say which file holds this test, whether it is unit, integration or e2e, or how to wait for the background work.

#### 3. Lines 87–90: the step 2 test harness cannot produce two of the listed cases without unplanned setup

- `verification-config.test.ts` builds auth with `database: {} as never` and `rateLimitEnabled: false`, and does not mock `./rate-limit-storage.ts`. So `recipientMayReceiveMail` never touches the store.
- That means neither "recipient-limit-failed" nor "the silent over-cap skip" (which needs `consume` to return `{allowed: false}`) can be triggered there.
- A harness for exactly this already exists: `packages/auth/src/abuse-limits.test.ts` mocks `createAtomicAuthRateLimitStorage` with `mocks.consume`. It already has "maps a recipient-cap store failure to the normalized delivery errors" and the over-cap/disabled cases.
- The in-progress worktree shows the result of leaving this open. It forces a store failure by passing `rateLimitEnabled: true` with `database: {}`, so the reported `errorName` depends on an incidental `TypeError`. I found no over-cap no-report test in that file.
- The plan should put these cases in `abuse-limits.test.ts`, which also means adding it to the file list.

**4. Lines 91–94 (with Design 5): the web mapper's contract leaves decisions to the implementer.** Per the standard's zero-decision rule, these are open:

- **Names:** no exported function name or options type is given. The existing pattern is `createRequestDatabaseDiagnosticSink({ sink, scheduleBackgroundTask, requestId })`.
- **Attribute keys:** only `operation` is named (in the acceptance test). It is not said whether `reason`, `provider`, `retryable` and `errorName` all go into `attributes`, or whether `code` is repeated there.
- **Forged values:** the existing mapper drops the whole event when it sees an unknown code (the `eventProfileFor` → `undefined` path, tested as "rejects forged diagnostic codes without scheduling or emitting"). The plan says "rebuilds the event from an allowlist" but not whether a forged value drops the event, gets replaced by a placeholder, or gets omitted.
- **Allowlist sources:** `EmailDeliveryFailureCode` and `EmailProvider` are type-only exports in `packages/email/src/index.ts`. There is no runtime array of the eight codes; only `EMAIL_ADAPTERS = ["resend"]` exists in `adapters.ts`. The implementer must either copy the list into `apps/web` or add an export to `packages/email`, and `packages/email` is not in the file list.
- **`errorName`:** a "known values" allowlist cannot cover arbitrary error class names. The plan does not say whether the web side re-applies the `^[A-Za-z_$][\w$]{0,63}$` rule from `server.ts`.

#### 5. Lines 75–101: the file boundary is incomplete and paths are not marked Create, Modify or Delete

- Step 3 gives `auth-email-diagnostics.test.ts` without a repo-relative path.
- Step 4 says "its test" instead of `apps/web/src/server/request-scope.test.ts`.
- `packages/auth/src/abuse-limits.test.ts` (finding 3) is missing, and so is any `packages/email` change needed for runtime allowlists (finding 4).
- No entry is marked Create or Modify; only Design 5 says "(new)".

This list is not good enough to enforce a write allowlist.

#### 6. Lines 99–101: nothing in the verification step runs coverage

- `verify:prepush` is `verify:core && test:unit && test:contract && test:operations`. Coverage is only in `verify:coverage`, which runs `scripts/coverage-lane.ts … --coverage`.
- Under `vitest.config.ts`, any file not listed in `scripts/ci/coverage-baseline.json` must stay at 100%. That covers the new mapper and `apps/web/src/server/request-scope.ts`.
- `packages/auth/src/server.ts` has a baseline entry (lines 98.64, branches 95.92, functions 100, statements 98.22), so "does not fall" applies to it.
- As written, "Coverage stays 100%" is claimed but never checked. The step should name `bun run verify:coverage` or an exact `pnpm exec vitest run --coverage` command.

**7. Lines 73–101: there are no phases or checkpoints.** The standard requires the work to be split into incremental phases, each leaving the codebase buildable and testable. The plan is one ordered list with all verification at the end (step 6). Steps 1–2 (auth package), 3 (web mapper) and 4–5 (wiring and docs) are natural phases, but none has its own pass check.

##### 🟢 Nits

#### 8. Lines 76–79: the type list is incomplete

- `AuthEmailOperation` is not listed, though the in-progress worktree exports it for the `operation` union.
- The new imports are not listed. `HEAD` imports only `type EmailPort` from `@darkfactory/email`; the new types need `EmailDeliveryFailureCode` and `EmailProvider`.
- The plan does not say that `AuthEmailDeliveryFailure` is a union keyed on `reason` rather than one flat object with optional fields. Design 2's "only for" wording implies the union, but the step does not state it.

**9. Lines 95–97: an existing assertion will break.** `request-scope.test.ts` lines 133–143 check `createAuth` with `toHaveBeenCalledWith({...})` against an exact object. Adding `onEmailDeliveryFailure` breaks it, so it needs `expect.any(Function)`. The "same request id" test should copy the existing pattern at lines 169–190, which pulls the callback out of `mocks.<fn>.mock.calls[0]`. Neither change is spelled out.

**10. Line 98: the table row's content is not given.** The other rows name a `file#symbol` in the "Where to look" column, for example `apps/web/src/lib/request-database-diagnostics.ts#createRequestDatabaseDiagnosticSink`. The plan gives no symbol for the new row. The "Logs" paragraph at `docs/debugging.md:42` also lists example event names, and the plan does not say whether to update it.

**11. Line 99: the test command is vague.** "`pnpm exec vitest run` on the three test files" gives no paths and no `--project`. The root `vitest.config.ts` defines several projects (unit, contract, operations, …).

**12. Line 105: the example port result is not a valid `FailedEmailDelivery`.** `{status: "failed", code: "EMAIL_PREVIEW_WRITE_FAILED"}` is missing the required `provider` and `retryable` fields (`packages/email/src/index.ts:78-83`). The real preview adapters return it with `provider: "preview"` (`packages/email/src/server/preview.ts:389`, `remote-preview.ts:158`).

#### 13. Lines 111–114: two facts are missing from the risk section

- **Store failures cannot happen in the test environment.** `request-scope.ts` passes `rateLimitEnabled: env.APP_ENV !== "test"`. If the e2e tests run with `APP_ENV=test` (I did not confirm this), the store is never consulted there. The flaky-test diagnosis could then only ever see `delivery-failed` or `delivery-threw`.
- **The two paths stay inconsistent.** A reset port throw still rethrows the original error, and Better Auth then logs it with its message. The verification path replaces it with the generic delivery error ("redacts thrown provider failures before Better Auth schedules them"). The plan keeps this as-is and should say so.

#### What checked out

- **`packages/auth`:** `AuthFactoryOptions`, `sendResetPassword`, `sendVerificationEmail`, `recipientMayReceiveMail`, `PASSWORD_RESET_DELIVERY_ERROR_CODE` and `EMAIL_VERIFICATION_DELIVERY_ERROR_CODE` all exist and behave as the plan assumes. That includes the single `try` in the verification path and, in the reset path, the store `try` with a direct port call and result check.
- **Email and observability types:** `FailedEmailDelivery` has `code`, `provider` and `retryable`. `SemanticEvent` has `attributes`, `errorCategory`, `outcome` and `correlation.requestId`, and `"api"` is a valid `EventSource`.
- **Web wiring:** `request-database-diagnostics.ts` does schedule through the raw `waitUntil`. `request-scope.test.ts` exists, `docs/debugging.md` has the symptom table, `bun run check` and `verify:prepush` exist, and the repo uses pnpm (`pnpm@11.16.0`).
- **Redaction:** the evlog sink runs `redactSemanticEvent`, and none of the likely attribute key names (`operation`, `reason`, `provider`, `retryable`, `errorName`) match its sensitive-key rules.

## egm-style

I found 9 problems in lines 73–114: 4 Major and 5 Nit, with no Blockers. The prose is plain and has no marketing language or filler. The problems are steps that can be read two ways, terms the section never defines, and claims that no listed test or command checks.

### 🟡 Major — lines 80–83 (`sendResetPassword` step): the order of operations can be read two ways

- The step says to wrap `sendPasswordReset` in a `try`/`catch` that reports `delivery-threw`. It then says to report `delivery-failed` "before the existing throw".
- It does not say whether the `result.status === "failed"` check and its throw stay outside the new `try`. In `server.ts:565-573` they sit right after the port call. If a reader wraps them too, the catch reports `delivery-threw` for the auth code's own `APIError`, so one failure is reported twice.
- The verification step at lines 84–86 states this split explicitly, so the reset step should say the same.

#### 🟡 Major — lines 99–101 (Verify): the coverage claim is not checked by any listed command

- "Coverage stays 100% … does not fall" has no command behind it. `verify:prepush` runs `verify:core`, `test:unit`, `test:contract` and `test:operations`, all without coverage. `vitest.config.ts:110-111` says thresholds are checked once, in the CI coverage lane. Fix (CALIBRATE): name the command or CI lane that checks coverage.
- "Does not fall for the changed files" is not accurate for every file:
  - `packages/auth/src/server.ts` is in `scripts/ci/coverage-baseline.json`, so "does not fall" is correct for it.
  - `apps/web/src/server/request-scope.ts` is not in the baseline. It is held to 100%, not "does not fall".
- Smaller problems in the same lines:
  - "The three test files" makes the reader count back through steps 2–4. Name them: `verification-config.test.ts`, `auth-email-diagnostics.test.ts`, `request-scope.test.ts`.
  - `bun run check` (format, lint, typecheck) repeats work that `verify:prepush` already does through `verify:core`.
  - "Then `bun run verify:prepush` through the push hook" does not say whether to run it by hand or let `git push` run it.

#### 🟡 Major — lines 103–109 (Acceptance test): no step says which test proves this

- The first bullet covers the whole path: port result, auth error, web event, and the response the client gets. None of steps 2–4 maps to it.
- Step 4's test cannot prove the "client still gets `PASSWORD_RESET_DELIVERY_FAILED`" half. `request-scope.test.ts` mocks `createAuth` (line 30) and returns `{ kind: "auth" }`.
- Fix (CALIBRATE): name the test file and case that checks each bullet, or narrow the bullets to what steps 2–4 actually check.
- Line 109 forbids only "email address, URL or token". Design 2 (lines 53–54) also excludes user name, user id and error message. Use one list in both places. Step 3 also has no "serialized event contains no sensitive value" case to back line 109.

#### 🟡 Major — lines 113–114 (Risk): "Risk: low" is an opinion with no stated basis

- "Success paths are unchanged" goes beyond the plan's own steps:
  - Step 1 restructures the success-path control flow of `sendVerificationEmail` (splits the `try`).
  - It wraps the successful `sendPasswordReset` call in a new `try`.
  - Step 4 adds an option to every `createAuth` call.
- Fix (CALIBRATE or DROP): drop the "low" label, or say what was verified. For example: "success-path behavior unchanged; covered by existing success tests (`verification-config.test.ts`, 'resolves a successful verification delivery…', 'delegates reset delivery…')".

#### 🟢 Nit — line 88: "no sensitive value" is not defined in this section

Refer to the exclusion list in Design 2 (lines 53–54) so the test author knows exactly which fields to check.

#### 🟢 Nit — lines 89–90: "the silent over-cap skip" is undefined

The term only appears as a code comment ("Over the cap: skip silently", `server.ts:531`). Spell it out: "`recipientMayReceiveMail` returns `false`, so the auth code returns without sending."

#### 🟢 Nit — lines 92–94 (step 3): vague wording

- "Event shape per reason" — say which fields the test checks (`name`, `errorCategory`, `correlation`, `attributes`).
- "Copied cases" suggests copying verbatim; "modeled on" is more accurate.
- The source file has two containment cases: "contains emission failure in the tracked background task" and "contains emission rejection when background scheduling throws". "Contained emission failure" leaves it unclear whether both are copied.

#### 🟢 Nit — line 95: "and its test" hides a required edit

- Name the file: `apps/web/src/server/request-scope.test.ts`.
- The existing exact assertion `expect(mocks.createAuth).toHaveBeenCalledWith({...})` at `request-scope.test.ts:136` will fail once `onEmailDeliveryFailure` is passed. The step reads as add-only and does not mention this change.

#### 🟢 Nit — line 98: the content of the new table row is not given

The table in `docs/debugging.md` ("Symptom → where to look") has two columns: Symptom and Where to look. Give the "Where to look" target, for example `apps/web/src/lib/auth-email-diagnostics.ts` and `packages/auth/src/server.ts#sendResetPassword`, the way the `request-database.*` row at line 12 does.

`packages/auth/src/server.ts` already has uncommitted changes, including a `reportEmailDeliveryFailure` helper. Step 1 (line 78) still describes adding it as future work.
