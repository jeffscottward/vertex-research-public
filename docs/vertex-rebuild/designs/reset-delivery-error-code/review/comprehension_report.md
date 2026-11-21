# Stage 6: Comprehension review

## What this proposes

When the auth package fails to send a password-reset or email-verification email, it would report a small typed object through a new optional callback, `onEmailDeliveryFailure`, on `AuthFactoryOptions`. The object holds only the operation, a reason (the mail-limit store threw, the email port returned `failed`, or the email port threw), the port's `code`/`provider`/`retryable` when the port returned `failed`, and a cleaned-up `errorName` when something threw. It never holds addresses, ids, URLs, tokens or error messages. In the web app, a new mapper (`auth-email-diagnostics.ts`) rebuilds that object from an allowlist into an `auth.email-delivery-failed` event. It tags the event with the request id and emits it through the request's "evlog sink", scheduled with `waitUntil`. `request-scope.ts` wires the mapper into `createAuth`. The errors clients receive stay exactly as they are, and a callback that throws cannot change the auth outcome.

### How the existing system works, per this document

`sendResetPassword` checks a per-recipient mail-limit store, then calls the email port. The port returns a typed result with a failure code, or it throws. If the store throws or the port returns `failed`, the function throws `PASSWORD_RESET_DELIVERY_FAILED` (HTTP 503) and drops the cause. If the port throws, the original error is rethrown. `sendVerificationEmail` wraps all of this in one `try` and throws `EMAIL_VERIFICATION_DELIVERY_FAILED` for any failure. `packages/db` already sends request diagnostics this way through `RequestDatabaseDiagnosticSink`, and `request-database-diagnostics.ts` maps them in the web app. The trigger for this plan is a flaky e2e reset test. It times out waiting for the "reset preview link", and the server log shows only the generic code.

#### Findings

#### 🟡 Major: lines 17–20, 32, 103–109. The plan never says the new event reaches the log that motivated it

The motivation is that "the server log shows only `PASSWORD_RESET_DELIVERY_FAILED`" in CI run 44763985560. Line 32 promises that "the new event shows its real cause next time." But the document never says where the evlog sink's output goes in the e2e/CI environment, or whether it lands in that same server log. The acceptance test checks emission at the "web request" level, not visibility in the CI e2e log. A reader cannot confirm the plan closes the problem it states.

#### 🟡 Major: line 89 (DetailedRange), with lines 13, 24, 44. "Silent over-cap skip" is never defined

"Silent over-cap skip" first appears in the test list and is defined nowhere. Lines 13 and 44 only cover the mail-limit store *throwing*. They never say that a recipient over the cap is skipped silently, presumably without an error and without an email. That skip would also leave the e2e test waiting for a preview link that never comes. The Goal (line 24) says "every auth email delivery failure" is recorded, yet this path is deliberately not reported. The design should name the path, say what the client sees, and say why it is excluded.

#### 🟡 Major: lines 61–69. Project-specific terms in the mapper are undefined

- **"semantic event"** and its fields (`outcome`, `source`, `errorCategory`, `correlation`, `attributes`): the schema is used but never described or linked. A new reader can't tell which fields are required or what values `source` allows.
- **"evlog sink"**: never defined or linked.
- **"raw `waitUntil` (non-database work)"**: implies a wrapped `waitUntil` exists for database work, but the doc never explains the difference or why the raw one is right here.
- **`request-database-diagnostics.ts` / `RequestDatabaseDiagnosticSink` (lines 37–38, 69)**: offered as the template to copy, with no path for the db-side type and no summary of the behaviour beyond line 39.

#### 🟡 Major: lines 47–48, 49–52, 66–67. The allowlist rule is vague and conflicts with the free-form fields

"Rebuilds the event from an allowlist of known values" doesn't say which fields are allowlisted or where the lists come from (the port's code union? a provider list?). `errorName` is defined as any plain identifier up to 64 characters, which is open-ended and can't be checked against a list of known values. The doc also doesn't say what happens to an unknown `code` or `provider`: is the field dropped, replaced with a fallback category, or is the event suppressed? Nor does it say whether `provider` is safe to log.

#### 🟡 Major: lines 55–56, 76–78. The sink's type and sync/async contract are never stated

`AuthEmailDeliveryFailureSink` is exported but its signature is never given. Line 55 says the callback runs inside `try`/`catch` so a throwing callback "never changes the auth result". That only holds for synchronous throws. If the sink may return a Promise, a rejection escapes the `try`/`catch` unless it is awaited or caught. The reader can't tell whether the sink is sync `void` or async. Line 68 suggests the web side schedules the work itself, but this isn't stated as a requirement.

#### 🟡 Major: lines 65, 70, 95–97. How the request id reaches the mapper is left to inference

The event carries "the request id in `correlation`", but the auth package passes no request id (line 53 lists what it passes). The reader has to infer that `createAuth` runs once per request in `request-scope.ts` and that the mapper closes over the request id. Line 70 ("passes the mapper to `createAuth`") doesn't say this. It also doesn't define `AuthFactoryOptions` as `createAuth`'s argument (lines 41 and 70 are never explicitly linked).

#### 🟡 Major: lines 103–109. The acceptance test has no stated harness and covers one path

The doc doesn't say whether the acceptance test is a unit, integration or e2e test. It also doesn't say where it lives, or how a test forces the port to return `{status:"failed", code:"EMAIL_PREVIEW_WRITE_FAILED"}` within "the web request". It maps to none of the numbered steps (line 95's request-scope test is closest). It also covers only `password-reset` with `delivery-failed`, even though the Goal (line 24) claims every failure.

**🟢 Nit: line 3.** "Follow-up of `vertex-timeout-scale-stale-under-load` item I5": the card and item I5 are neither linked nor summarized, so the reader can't see what was decided there.

**🟢 Nit: line 4.** "Flow: full" and "🐘🐟 review" are project process terms with no definition or link.

**🟢 Nit: lines 10–14, 18–19.** "Email port" (which interface, which file?), "per-recipient mail-limit store", and "reset preview link" are project concepts with no definition or path. The link between the e2e test's "preview link" and the `EMAIL_PREVIEW_WRITE_FAILED` code is assumed knowledge: that in dev/CI the port writes emails to a preview location instead of sending them.

**🟢 Nit: lines 8–10 vs 57–59.** The Problem says a failed reset email "throws `PASSWORD_RESET_DELIVERY_FAILED`". Design 4 shows that a port throw rethrows the original error instead. The Problem statement should mention this third case.

**🟢 Nit: line 33.** "Its option stays unset" refers forward to an option first named at line 41. Line 33 also qualifies the Goal's "every auth email delivery failure" (line 24) without saying so: failures in `apps/operator` are not recorded.

**🟢 Nit: lines 49–51.** "Plain identifier" has no exact rule, such as a regex or character set.

**🟢 Nit: lines 66–67.** "A forged value cannot inject text" has no stated threat model. The value comes from in-process auth code, so it's unclear who would forge it. The source is presumably the port's provider/code strings or an error's `.name`; saying so would explain why the allowlist is needed.

**🟢 Nit: lines 71, 98.** "Symptom table" in `docs/debugging.md` isn't described, and the content of the new row (symptom text, next diagnostic step) isn't given.

**🟢 Nit: lines 87–90.** Tests for the password-reset path go into `verification-config.test.ts`, whose name suggests verification config only. A sentence on why that file is the home would help.

**🟢 Nit: line 95.** "And its test": the test file isn't named, unlike every other file in the plan.

**🟢 Nit: lines 99–101.** The verification step mixes `pnpm exec vitest` and `bun run …` without explanation. It also assumes the reader knows `verify:prepush` runs from a push hook and that a 100% coverage gate exists.

**🟢 Nit: lines 113–114.** "Success paths are unchanged" is a behavioural claim. The plan does restructure code that success paths run through: `sendVerificationEmail`'s single `try` is split into three, and `sendPasswordReset` gets a new `try`/`catch`. The risk note should acknowledge the restructure, even if behaviour is meant to stay the same.
