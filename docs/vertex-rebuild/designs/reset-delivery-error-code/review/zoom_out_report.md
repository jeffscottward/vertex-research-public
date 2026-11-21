# Stage 5: Zoom Out review

## egm-zoom-out

### Zoom-out review: `plan.md` for `vertex-reset-delivery-error-code` (lines 1–114)

**Verdict:** one blocker. The plan assumes the client sees the reset delivery error, but it never does. The overall shape is sound: an optional typed callback in `packages/auth`, mapped to a semantic event in `apps/web`. It copies a pattern that already exists and works (`RequestDatabaseDiagnosticSink` with `apps/web/src/lib/request-database-diagnostics.ts`, which uses the raw `waitUntil`). No reusable auth-email event exists in the codebase. Two diagnostic mappers are too few to justify a shared abstraction, so don't add one.

The worktree already contains part of this work. `packages/auth/src/server.ts` lines 104–133 and 418–426 have the types, `errorNameOf` and `reportEmailDeliveryFailure`. `verification-config.test.ts` lines 484–627 has the reporting tests. The plan does not say this.

---

#### 🔴 Blocker — the reset error never reaches the client (lines 8–10, 24–26, 57–60, 105–108)

- **What the plan says:** the Problem section says the error is "HTTP 503". The Goal says "the API error that the client receives does not change". The acceptance test requires that "the client still gets `PASSWORD_RESET_DELIVERY_FAILED`".
- **What actually happens:** in better-auth 1.7.14, `/request-password-reset` calls `sendResetPassword` through `ctx.context.runInBackgroundOrAwait(...)` (`dist/api/routes/password.mjs:82`).
  - `request-scope.ts` sets `scheduleBackgroundTask: database.schedule`, which becomes `advanced.backgroundTasks.handler`. With that handler set, `runInBackgroundOrAwait` hands the task off and catches its error with `logger.error("Failed to run background task:", e)` (`dist/context/create-context.mjs:215-225`).
  - The client always gets 200 with `{status: true, message: "If this email exists…"}`.
  - The verification sends on sign-up and sign-in also go through `runInBackgroundOrAwait`. Only `/send-verification-email` awaits the send directly, so only that endpoint surfaces `EMAIL_VERIFICATION_DELIVERY_FAILED` to the client.
- **Why it matters:**
  - The acceptance test cannot pass as an HTTP-level check.
  - The "server log shows only `PASSWORD_RESET_DELIVERY_FAILED`" line in the Problem section is better-auth's generic background-task log, so the plan misdescribes where the failure shows up.
  - Design item 4 carefully preserves a thrown error whose only consumer, for reset, is that log line.
  - After the change, each failure produces two log lines: the generic one and the new event.
- **Fix:** describe the real flow in Problem and Goal. Rewrite the acceptance test as "the event is emitted and the reset response is unchanged (200 generic)". Keep "client sees the error" only for `/send-verification-email`.

##### 🟡 Major — earlier diagnostics for the same flaky test are not mentioned (lines 17–20, 32)

- `tests/e2e/helpers/preview-capture.ts` lines 132–141 already writes `[preview-capture] rejected <status>: <reason>` to stderr. Its comment cites card `vertex-e2e-reset-password-preview-flake` and says "the app only reports PASSWORD_RESET_DELIVERY_FAILED". That is the same motivation as this plan.
- The plan never mentions this. It doesn't say whether CI run 44763985560 showed a capture-side rejection line. It doesn't explain what gap is left: failures before the capture server is reached, render failures, and recipient-limit store failures.
- Without that, a new reader can't tell whether this is a second diagnostic layer for the same symptom.
- **Fix:** add 2–3 sentences: what already exists, what the CI run did or didn't show, and why an app-side event is still needed.

##### 🟢 Nit — a cheaper option exists but isn't discussed (Design, lines 35–71)

- For reset and the sign-up verification sends, the thrown error only reaches better-auth's background-task logger. Attaching the typed failure to the thrown `APIError` as `cause`, or using Better Auth's own `logger` option, would surface the code with no new module, no new option and no wiring.
- The chosen design is defensible: it gives request-id correlation, the redacting evlog sink, and consistency with the `request-database.*` events. Still, record one line on why that option was rejected so later reviewers don't relitigate it.

##### 🟢 Nit — the "forged value" allowlist is speculative (lines 66–67, 92–93)

- The plan sanitizes the payload at three layers:
  1. typed fields plus `errorNameOf` inside `packages/auth`;
  2. an allowlist rebuild in the new web mapper, "so a forged value cannot inject text into the log";
  3. `redactSemanticEvent` inside `createEvlogSink` (`packages/observability/src/server/evlog.ts:69`).
- The producer is typed, in-process code, so "forged" input is not a real threat here.
- The existing precedent, `request-database-diagnostics.ts#eventProfileFor`, is just a `switch` on a code that drops unknown values.
- **Fix:** mirror that switch (reason/code → `errorCategory`, pass the typed fields through). Drop the "allowlist rejection of forged values" test cases.

##### 🟢 Nit — `errorName` adds rules for little value, and the Design section drops into code detail (lines 49–52)

- The 64-character identifier regex and the `"UnknownError"` / `"NonError"` fallbacks are implementation detail sitting in the high-level Design section.
- `reason` already separates the three causes. The email adapters turn failures into typed results, so a thrown error is a bug, and its class name (usually `Error` or `TypeError`, or a generic database error for the store) rarely tells you more.
- `retryable` is derived from `code` in the adapters (`packages/email/src/server/provider.ts:170-176`), so it adds little too.
- **Fix:** consider dropping `errorName`, and maybe `retryable`. Otherwise move the sanitizing rules to the Detailed Implementation Plan.

##### 🟢 Nit — the privacy claim stops at the new event (lines 52, 59)

- The plan says "the error message is never read". But Design item 4 keeps the reset path rethrowing the original error when the email port throws, and better-auth's `logger.error` prints that error in full, message included.
- This is out of scope to fix. The plan should say it is a known exception, or the privacy claim should be limited to the new event.

##### 🟢 Nit — where the event appears in CI is not stated (line 32)

- I checked the path: failure events set evlog level `error`, which goes to `console.error`, then stderr. Playwright pipes webServer stderr by default and ignores stdout. So the event will show in the app server's CI output.
- Since seeing it there is the whole point of the card, add one line telling readers where to look (app webServer stderr in the CI job log). The `docs/debugging.md` row (item 7) could say the same.

##### 🟢 Nit — the plan doesn't show that work has started (lines 73–101)

- The Detailed Implementation Plan reads as future work, yet steps 1–2 are largely already in the worktree.
- Mark completed steps, so reviewers aren't auditing code that already exists, and so the remaining scope (steps 3–5) is clear.

## egm-inventive-catalyst

I found 2 Major findings and 2 Nits. The main one is that the plan protects a client-visible error that the client never receives. Because of that, it keeps an unredacted rethrow on the reset path, and the acceptance test asserts a response the client cannot get.

**Contradiction check:** Two real false compromises exist. Both come from the constraint "keep the client-visible API error unchanged" (lines 25–26, 30, 57–60, 108). The code shows that constraint is not real.

- Better Auth 1.7.14 runs `sendResetPassword` and `sendVerificationEmail` through `runInBackgroundOrAwait`. Because `createAuth` sets `advanced.backgroundTasks.handler`, delivery runs after the response is built. Any throw goes to `logger.error("Failed to run background task:", e)` (better-auth `context/create-context.mjs:215-224`).
- `createAuthHandler` (`packages/auth/src/server.ts:1435-1442`) also rewrites any reset response with `PASSWORD_RESET_DELIVERY_FAILED` into `SAFE_RESET_RESPONSE`, which is HTTP 200.
- So no thrown error, rethrown or mapped, ever reaches the client. Its only consumer is Better Auth's background-task logger.

---

### 🟡 Major — Lines 57–60 (Design 4), 81–83 (Detailed Plan 1), 30 (Non-goals)

**Discrepancy:** Design 4 keeps "a reset port throw rethrows the original error (as today)" so the client-visible error does not change. Verification already maps every throw to the fixed `EMAIL_VERIFICATION_DELIVERY_FAILED` error. The test "redacts thrown provider failures before Better Auth schedules them" (`verification-config.test.ts:344-372`) checks that redaction.

**False compromise:** The plan gives up redaction on the reset path to protect behavior the client never sees. As a result, the raw reset error, including the message that Design 2 says "can hold an address or token" (line 52; `server.ts` `errorNameOf` comment), still reaches Better Auth's `logger.error`. The new event never reads the message, but the old log line still prints it. The plan's privacy rule is therefore only half applied, and reset and verification treat throws differently.

**Proposed resolution (Segmentation of channels):** Separate the diagnostic channel from the error channel.

- Report `delivery-threw` with `errorName` through `onEmailDeliveryFailure`.
- Then throw `passwordResetDeliveryError()`, matching verification. The callback already carries the cause, so the raw error adds nothing.
- Change the non-goal on line 30 to "no change to the HTTP response clients see". That response is the normalized 200, which this change does not affect.

#### Secondary liabilities

- The test "rethrows it unchanged" (`verification-config.test.ts:545`) has to be rewritten.
- Better Auth's background log loses the original stack trace. Only the event's `errorName` remains to diagnose a reset port throw.

---

##### 🟡 Major — Lines 25–26 (Goal), 104–108 (Acceptance test), 113–114 (Risk)

**Discrepancy:** The acceptance test expects the web request to emit the event "and the client still gets `PASSWORD_RESET_DELIVERY_FAILED`". Through the web route, the client gets `SAFE_RESET_RESPONSE` (200, `cache-control: no-store`), and delivery runs as a background task after the response.

**False compromise:** The test assumes delivery, diagnosis and response happen in one step. In reality the event is emitted by a background task. That task is scheduled through `database.schedule` and then hands off to raw `waitUntil`, after `run` returns. As written, the test cannot pass.

The real constraints it should check are:

1. The response is normalized and does not change.
2. The event is emitted only after the scheduled tasks drain.

**Proposed resolution (Inversion: observe the background drain, not the response):** Restate the acceptance test as two checks.

- The reset response body and status are identical to the success case.
- After the test drains the `waitUntil` and `database.schedule` promises, the sink has received `auth.email-delivery-failed` with `errorCategory: "EMAIL_PREVIEW_WRITE_FAILED"` and the same `requestId`.

#### Secondary liabilities (2)

- The test harness needs a way to drain both background schedulers, which adds async ordering to the test.
- The "Risk: low" note (line 113) should say the event is emitted after the response. Event loss when the background task is dropped stays a known gap.

---

##### 🟢 Nit — Lines 37–41, 84–86 (Design 1; Detailed Plan 1, `sendVerificationEmail` split)

**Discrepancy:** Two of the three reasons, `delivery-failed` and `delivery-threw`, are facts about the `EmailPort` result. The plan collects them by restructuring the auth package's security-critical send callbacks: a new try around the port in `sendResetPassword` (lines 81–83), and splitting the single `try` in `sendVerificationEmail` (line 84). Only `recipient-limit-failed` actually needs code inside `packages/auth`.

**False compromise:** The plan reads as if diagnostics require changing auth control flow. A thin wrapper around the email port would avoid that.

**Proposed resolution (Extraction / Intermediary):** Wrap the port returned by `selectEmailPort` in `apps/web/src/server/request-scope.ts`. The wrapper maps the method to the operation (`sendPasswordReset` → `password-reset`) and emits the event on `status: "failed"` or a throw. Keep the auth callback only for `recipient-limit-failed`.

#### Secondary liabilities (3)

- Reporting is split across two places (port wrapper plus auth callback).
- It does not match the single-callback `RequestDatabaseDiagnosticSink` precedent the plan cites.
- If the wrapper also redacts the thrown error, it duplicates the redaction already in auth.

This is advisory. The plan's choice is defensible because it follows an existing pattern.

---

##### 🟢 Nit — Lines 32 (Non-goals), 92–93 (Detailed Plan 2: "no report on success")

**Discrepancy:** The plan diagnoses the flake only by an event appearing "next time". The event covers delivery failures only. Other causes produce no event at all:

- Better Auth skipped the send because the user does not exist.
- The background task was dropped or never ran.
- The preview capture rejected a successful `previewed` delivery (`tests/e2e/helpers/preview-capture.ts:132-141` already logs that to stderr).

**False compromise:** If the flake recurs with no `auth.email-delivery-failed` event, the absence does not identify any of those causes.

**Proposed resolution (Blessing in Disguise):** No positive success event is needed (YAGNI). Instead:

- State explicitly in the plan and in `docs/debugging.md` which causes the event does not cover, including the preview-capture stderr line and background-task loss, so an empty log is read correctly.
- Optionally, have the E2E reset spec print the response's `x-request-id` when it times out, so CI logs can be filtered by request id.

#### Secondary liabilities (4)

- More text in the debugging docs.
- If the request-id print is added, it is a small change to the E2E helper, outside the plan's current scope.

I checked that the event will show up in CI: failure events are logged at error level, so evlog writes them with `console.error` to stderr, and Playwright's `webServer` captures stderr by default. That part needs no change.
