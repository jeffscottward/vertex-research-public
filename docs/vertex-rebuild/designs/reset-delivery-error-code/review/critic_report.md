# Stage 7: Critic review (FeatureRange)

## egm-design

Feature-range review of `docs/vertex-rebuild/designs/reset-delivery-error-code/plan.md`, lines 1–72, against `feature-spec-standard.md`, in REVIEW mode as Design Critic.

The plan is narrow and the sink pattern copies existing code. It does not pass the standard yet. Two required sections are missing, and the plan misreads how the reset path reaches the client. This misreading invalidates the Goal, Non-goals, Design 4 and the acceptance test. I found 2 Blockers, 6 Majors and 4 Nits.

---

### 1. 🔴 Blocker: no Alternatives Considered section (Feature range, lines 35–71)

- **Discrepancy:** The Alternatives Rule requires that other viable designs were considered and rejected for specific reasons. The plan gives only one design. Design 1 (lines 37–40) says it follows the `packages/db` pattern but never says what was rejected or why.
- **Rationale:** At least these options needed an explicit trade-off:
  - (a) Depend on `@darkfactory/observability` directly from `packages/auth`.
  - (b) Carry the port `code` on the thrown `APIError` (for example as `cause`). Better Auth already logs it through `runInBackgroundOrAwait`'s `logger.error`.
  - (c) Emit from the email adapters. This was ruled out only by the non-goal at line 31, not by any reasoning.
  - (d) Schedule the emission with `database.schedule` instead of raw `waitUntil`.
  - (e) Since CI runs with `APP_ENV=test` (see finding 4), a smaller fix that only logs the port code on the reset path.
- **Recommendation:** Add an Alternatives section with one concrete rejection reason for each option.

#### 2. 🔴 Blocker: no Risks & Mitigations section in the Feature range (lines 1–72; the only risk text is lines 111–114)

- **Discrepancy:** The standard requires failure modes, security, scalability limits and mitigations. The only risk statement is "Risk: low" at line 113, outside this range, with no evidence.
- **Rationale:** These risks exist and are not addressed:
  - The callback runs in background context after the response (finding 3).
  - Raw errors still reach Better Auth's logger (finding 5).
  - The allowlist can drift from the email failure codes (finding 6).
  - The event may not appear in CI logs (finding 7).
  - Log volume grows during a provider outage. Rate limits bound it at one event per send, but the plan never says so.
- **Recommendation:** Add a Risks section that covers each item and its mitigation.

#### 3. 🟡 Major: the Problem, Goal and Non-goals misread how failures reach the client (lines 8–10, 24–26, 30; affects lines 57–60 and acceptance test lines 105–108)

- **Discrepancy:** The plan describes reset failure as an HTTP 503 `PASSWORD_RESET_DELIVERY_FAILED` that the client receives. That is not what happens:
  - `createAuth` sets `advanced.backgroundTasks.handler = options.scheduleBackgroundTask` (`server.ts` around line 444). The web app passes `database.schedule` (`request-scope.ts` around line 125).
  - In better-auth 1.7.14, `requestPasswordReset` calls `ctx.context.runInBackgroundOrAwait(sendResetPassword(...))` (`dist/api/routes/password.mjs:82`). When a handler is set, the rejection is caught as `logger.error("Failed to run background task:", e)` (`dist/context/create-context.mjs:215-224`).
  - The client therefore gets HTTP 200 with `SAFE_RESET_RESPONSE`. `createAuthHandler` also rewrites any 503 reset response to that body (`server.ts` around line 1448).
  - Verification is mixed. Sign-up and sign-in send in the background, while `/send-verification-email` awaits directly (`email-verification.mjs:111/122`), so only that route returns the 503.
- **Rationale:** Line 108 ("the client still gets `PASSWORD_RESET_DELIVERY_FAILED`") cannot pass at the web-request level. The claim that client behavior is unchanged is true only by accident. The plan also never says that its callback fires inside a tracked background task, possibly after the response is sent. That matters for `waitUntil` scheduling, `source: "api"` (the DB diagnostics use `"worker"`), and how requestId correlation is read.
- **Recommendation:** Restate the client contract for each route: reset returns 200 safe response, sign-up and sign-in send verification in the background, and `/send-verification-email` returns 503. Say that the callback runs in background context and justify raw `waitUntil` from inside a `database.schedule` task. Fix the acceptance criterion to "client gets 200 `SAFE_RESET_RESPONSE`".

#### 4. 🟡 Major: the claim that the event will show the flaky test's real cause is not backed up (lines 17–20, 32)

- **Discrepancy:** E2E runs with `APP_ENV: "test"` (`tests/e2e/env.ts:226`). That sets `rateLimitEnabled` to false, so `recipientMayReceiveMail` returns `true` without touching the store. A port throw on reset rethrows the original error, not `PASSWORD_RESET_DELIVERY_FAILED`.
- **Rationale:**
  - The CI log line therefore already narrows the cause to a `status: "failed"` result from the preview transport (`EMAIL_TRANSPORT: "preview"`). The Problem section misses this.
  - That result is usually `EMAIL_PREVIEW_WRITE_FAILED`, and about 20 separate fault paths in `preview.ts` and `remote-preview.ts` share that one code. The adapters are out of scope (line 31), so the new event will likely just say `EMAIL_PREVIEW_WRITE_FAILED`. Nobody will learn which write failed.
  - Several timeout causes produce no event at all: the user is not found, the route limit is hit, the over-cap skip fires, or the background task is dropped or late. The 5/min reset limit is a `customRules` entry whose effect depends on `rateLimitEnabled` and was not traced here.
- **Recommendation:** Scale back the line 32 claim, or keep the adapter-level sub-cause in scope. List the timeout causes the event cannot detect.

#### 5. 🟡 Major (security): the reset port-throw path still sends the raw error to the log (lines 52–54, 57–60)

- **Discrepancy:** Design 4 keeps "a reset port throw rethrows the original error (as today)". Better Auth's background wrapper logs that raw `e`, including its message, through `logger.error`.
- **Rationale:** The plan says "the error message is never read" and leaves out email, URL and token, but only for the new event. The same failure still writes the unredacted message, which may hold provider detail or an address, to the same log. The verification path already redacts this case (test "redacts thrown provider failures before Better Auth schedules them", `verification-config.test.ts` around line 343). The plan edits the reset `try`/`catch` itself and keeps the inconsistency without discussion.
- **Recommendation:** Throw `passwordResetDeliveryError()` after reporting, as the verification path does. Or record why the raw rethrow must stay, and call it out as an accepted risk.

#### 6. 🟡 Major: allowlist fallback is unspecified and can drift (lines 47–48, 61–69)

- **Discrepancy:** The mapper "rebuilds the event from an allowlist of known values". The plan does not say what happens for a value outside the list. The pattern it copies, `request-database-diagnostics.ts` `eventProfileFor`, returns `undefined` and emits nothing.
- **Rationale:**
  - If a new member is added to `EmailDeliveryFailureCode` (`packages/email/src/index.ts:56-64`) or `EmailProvider`, the event is either dropped silently or rejected. That brings back the blind spot this card is meant to remove.
  - `errorName` cannot be allowlisted, because it is a free identifier matching `/^[A-Za-z_$][\w$]{0,63}$/`. The plan does not say whether the web mapper checks it again or trusts the package.
- **Recommendation:**
  - Require an exhaustive map typed `satisfies Record<EmailDeliveryFailureCode, …>` so drift fails the type check.
  - On unknown values, emit the event with a fixed category such as `AUTH_EMAIL_UNKNOWN_CODE` instead of dropping it.
  - Re-validate `errorName` with the same pattern in the mapper.

#### 7. 🟡 Major: no proof the event reaches the CI log (lines 19, 32, 67–69)

- **Discrepancy:** The motivating evidence is the CI server log. The `app` webServer in `playwright.config.ts` (lines 70–100) sets no `stdout` option. Playwright's default is `stdout: "ignore"` and `stderr: "pipe"`. The current `PASSWORD_RESET_DELIVERY_FAILED` line comes from Better Auth's `logger.error`, most likely on stderr.
- **Rationale:** The new event goes through evlog `createWorkersLogger`, where `logger.setLevel("error")` is called for failures. Whether that writes to stderr, and survives the `--mode test` start, is not verified. If it goes to stdout, CI will not show it and the card has no effect.
- **Recommendation:** State which stream carries the event and where CI keeps it. Add a check, such as one E2E or log-capture assertion, or set `stdout: "pipe"`.

#### 8. 🟡 Major: `errorName` may not tell store failures apart (lines 44, 49–52)

- **Discrepancy:** For `recipient-limit-failed`, the only cause field is `Error.name`. The parent card is about timeouts and staleness under load (line 3).
- **Rationale:** Pool, timeout and connection-terminated errors from database drivers often share a generic name such as `Error`. This holds in production, where the store is active. A safe, enumerable field such as the PostgreSQL SQLSTATE `code`, or whether it is a `RequestDatabaseCapacityError`, would separate those cases without exposing the message.
- **Recommendation:** Consider an allowlisted `errorCode`, or justify why the name alone is enough.

#### 9. 🟢 Nit: "Every auth email delivery failure" overstates the scope (line 24)

- `apps/operator/src/server/operator-auth.ts:37` also calls `createAuth` and is explicitly not wired (line 33).
- **Recommendation:** Narrow the Goal to "every web-app (`apps/web`) auth email delivery failure".

#### 10. 🟢 Nit: `source: "api"` (line 63)

- The emission runs after the response, as a background task. The sibling DB diagnostics use `source: "worker"`.
- **Recommendation:** Pick one source value and justify it.

#### 11. 🟢 Nit: the plan reads as new work, but part of it is already in the tree (lines 41–56)

- `server.ts` already contains `AuthEmailDeliveryFailure`, `AuthEmailDeliveryFailureSink`, `errorNameOf` with `SAFE_ERROR_NAME`, `onEmailDeliveryFailure` and `reportEmailDeliveryFailure` (lines 104–167, 431–439). The send paths (lines 529–575) are not wired yet.
- **Recommendation:** Note which parts are done so reviewers check the diff, not the description.

#### 12. 🟢 Nit: duplicate logs (lines 57–60, 61–69)

- Each failure will log twice: Better Auth's "Failed to run background task" line and the new event.
- **Recommendation:** Say that this is intended, or remove one, and mention it in the `docs/debugging.md` row.

## egm-structural

### Structural Goldfish review: `plan.md` lines 1–72 against the Feature Specification Standard

**Result: fails the standard.** Lines 1–72 have no Alternatives section and no Risks section. Both are mandatory. The heading hierarchy itself is clean, but the section names and contents don't match the standard's template.

**Heading structure in range:** an H1 at line 1, then four H2s: `## Problem` (6), `## Goal` (22), `## Non-goals` (28) and `## Design` (35). No heading levels are skipped and there are no H3s.

#### How it maps to the standard

- Problem Statement: present as "Problem", under a different name.
- Goals & Non-Goals: present, but split into two H2s under different names.
- Proposed Architecture: present as "Design", under a different name.
- Alternatives Considered: missing.
- Risks & Mitigations: missing.

Sibling plans already use the standard names (`status-b3-market-data`, `openbb-blocked-upstream`), so this plan is the outlier.

---

##### 🔴 Blocker

#### 1. Lines 35–71 (the whole FeatureRange): Alternatives Considered is missing

- **Discrepancy:** The Alternatives Rule says a spec "fails this standard if it proposes a single path". The plan never names or rejects another option. Design 1 (lines 37–40) states "`packages/auth` stays free of an observability dependency", which implies one rejected option, but it gives no trade-off for it.
- **Other options a reader would expect to see weighed:**
  - Import the observability port directly into `packages/auth`.
  - Log through `console` or stderr, as the portal session check does in `docs/debugging.md`.
  - Attach the port `code` as a `cause` on the thrown `APIError`.
  - Widen the existing `email` port contract.
- **Rationale:** A fresh reader can't tell whether the callback pattern was chosen on purpose or by default. That is exactly the gap the Alternatives Rule exists to close.

##### 🟡 Major

#### 2. Lines 1–72: Risks & Mitigations is missing from the range

- **Discrepancy:** The only risk text is `## Risk and revert` at lines 111–114, outside this range. It is one sentence ("Risk: low… Revert: revert the PR commits"). The security mitigations are buried in Design prose instead:
  - Line 53: sensitive fields excluded.
  - Lines 49–52: `errorName` sanitising.
  - Line 67: forged-value allowlist.
  - Line 55: a throwing callback is contained.
- **Unaddressed failure modes and limits:**
  - **Event volume:** when the mail-limit store is down, every reset or verification request emits an event.
  - **Missing request context:** the event can't be emitted when the auth instance runs without request scope, such as `apps/operator`, which calls `createAuth` at `apps/operator/src/server/operator-auth.ts:37`.
  - **Background scheduling:** emission goes through the raw `waitUntil`.
- **Rationale:** The standard requires failure modes, security implications, scalability limits and mitigations to be called out explicitly in a dedicated place.

#### 3. Lines 52–54: a Markdown lazy continuation attaches the privacy guarantee to the wrong bullet

- **Discrepancy:** Line 53 (`No email address, user name, user id, URL, token or error message is passed.`) follows the nested `errorName` bullet with no blank line. It is indented 3 spaces, less than the nested bullet's 5-space content offset. CommonMark treats it as a lazy continuation of the `errorName` bullet's paragraph.
- **Rationale:** When rendered, the "no sensitive field" rule for the whole `AuthEmailDeliveryFailure` value reads as if it applies only to `errorName`. This is the single most security-relevant sentence in the Design.

#### 4. Lines 61–69 (Design 5): the event contract is packed into one 9-line sentence

- **Discrepancy:** The mapping from `reason` to `errorCategory` is given only by order: "`AUTH_EMAIL_RECIPIENT_LIMIT_FAILED` / `AUTH_EMAIL_PORT_THREW` for the thrown reasons". The reader has to work out that `recipient-limit-failed` maps to the first and `delivery-threw` to the second.
- **Also embedded in the same sentence:** `outcome`, `source`, `correlation`, the `attributes` contents, the allowlist rule and the `waitUntil` scheduling.
- **Rationale:** This is the public log contract that `docs/debugging.md` will point at. A table with columns for `reason`, `errorCategory`, the fields present, and `attributes` would make it unambiguous.
- **Related, lines 43–52:** The rules for which fields are present for which `reason` are spread across prose ("only for `delivery-failed`", "only for the two thrown reasons"). The same table would cover them.

#### 5. Lines 35–71: the Design section mixes architecture with task-list items and has no data-flow description

- **Discrepancy:** Items 6 and 7 (lines 70–71: wire `request-scope.ts`, add a row to the `debugging.md` table) are implementation tasks. They repeat Detailed Plan items 4 and 5 (lines 95, 98). Item 4 (lines 57–60) is a behavioural invariant, not architecture.
- **What's missing:** The standard's "Proposed Architecture" asks for "component layout, data flows". The flow is never stated in one place: `sendResetPassword`/`sendVerificationEmail` → `onEmailDeliveryFailure` → `auth-email-diagnostics` mapper → evlog sink → `waitUntil`. The reader has to piece it together from items 1, 2, 5 and 6.

##### 🟢 Nit

#### 6. Lines 6, 22, 28, 35: section names don't match the standard

- **Discrepancy:**
  - `## Problem` should be `Problem Statement`.
  - `## Goal` and `## Non-goals` should be one `Goals & Non-Goals` section.
  - `## Design` should be `Proposed Architecture`.
- **Rationale:** The content is mostly in the right place, but the names break both the template and consistency with sibling plans.

#### 7. Lines 3–4: the metadata lines merge into one paragraph

- **Discrepancy:** `Card:` and `Flow:` sit on consecutive lines with no blank line, trailing break or list marker, so they render as a single run-on paragraph.
- **Self-classification:** Line 4 calls the document a "one-page plan" (bug-fix flow). It is still being audited against the full feature-spec standard, and the document doesn't explain which sections it intentionally leaves out.

#### 8. Lines 3, 18, 38: references with no link

- **Discrepancy:**
  - Line 3: "`vertex-timeout-scale-stale-under-load` item I5" has no link to that design or plan.
  - Line 18: "CI run 44763985560" has no URL.
  - Line 38: "`packages/db` (`RequestDatabaseDiagnosticSink`)" gives no file path. The type lives in `packages/db/src/server/client.ts:137`.
- **Rationale:** A fresh reader can't follow these references to their sources.

#### 9. Lines 13, 33, 41, 68: terms are used before they're defined, and there's no Terms section

- **Discrepancy:** "mail-limit store" (line 13), "evlog sink" (line 68), "semantic event" (line 62) and the "silent over-cap skip" (line 89, which relies on behaviour only visible in `server.ts:531–535`) are never defined.
- **Forward reference:** Non-goals line 33 says "Its option stays unset" before the option is introduced at line 41.
- **Rationale:** The standard's core principle is that an engineer unfamiliar with the codebase can follow the spec.

---

##### Checked against the context files, no issue found

- `server.ts:529–575` does drop the port result and the store failure (Problem, lines 8–15).
- Design 4 matches today's behaviour: the reset port has no `try` around it, and verification has a catch-all `try`.
- `AuthFactoryOptions` exists at `server.ts:136`.
- The email port's failed result has `code`, `provider` and `retryable`, and includes the three codes named in the Problem.
- In `observability/src/port.ts`, `EventOutcome` includes `"failure"` and `EventSource` includes `"api"`.
- `request-scope.ts` calls `createAuth` at line 117, and its comment at line 34 matches the raw-`waitUntil` guidance.
- `docs/debugging.md` has the "Symptom → where to look" table.
- `MD013` is disabled in `.markdownlint-cli2.jsonc`, so long lines are not a finding.

## egm-style

I found 0 blockers, 6 major and 11 nit issues in lines 1–72 of `plan.md`.

These claims match the code and docs in GoldfishContext:

- **Error codes:** `PASSWORD_RESET_DELIVERY_FAILED` and `EMAIL_VERIFICATION_DELIVERY_FAILED` return HTTP 503 (`SERVICE_UNAVAILABLE`).
- **Email port:** the example failure codes exist in `packages/email/src/index.ts`.
- **Mail-limit store:** its failure is caught and the cause is dropped, as the plan says.
- **Reset port throw:** it rethrows the original error.
- **Reused pieces:** `RequestDatabaseDiagnosticSink` exists, and the request-database mapper is scheduled with `waitUntil`. `source: "api"` is a valid `EventSource`.
- **Operator app:** `apps/operator` is dev-only and calls `createAuth`.
- **Docs:** `docs/debugging.md` has a symptom table.
- **Error names:** the `errorName` rule matches `SAFE_ERROR_NAME`.

The worktree already contains the `AuthEmailDeliveryFailure` types and the `onEmailDeliveryFailure` option, so the Problem section describes code that is partly changed.

### 🟡 Major

#### 1. Lines 8–10: the Problem section says more than the code does (CALIBRATE)

- **Discrepancy:** The text says that when a reset email "cannot be sent", `sendResetPassword` throws `PASSWORD_RESET_DELIVERY_FAILED`. In `server.ts` (lines 538–556), the port call is outside any `try`, so a port throw passes through as the original error. Line 63 of the plan says the same thing, so the plan contradicts itself.
- **Rationale:** A reader who trusts the Problem section expects this error code for all three failure types. Narrow it to the two cases that produce the code: "when the mail-limit store throws or the email port returns `status: "failed"`".

#### 2. Lines 17–20 and line 33: the flaky test is treated as caused by a delivery failure, which is not shown (CALIBRATE)

- **Discrepancy:** Line 17 starts with "Effect:", which presents the test timeout as a result of the dropped code. Line 33 says "The new event shows its real cause next time." But line 33 also says the flaky test is not fixed and its cause is unknown. The event only fires if the timeout really comes from an auth email delivery failure. A timeout with another cause produces no event.
- **Rationale:** The claim goes beyond the evidence. Use "Observed symptom:" instead of "Effect:". On line 33, write something like: "If the timeout comes from an auth email delivery failure, the event will name the cause." Drop "real" and "next time", which say nothing measurable.

#### 3. Lines 19–20: "nobody can tell which of the possible causes happened" is overstated (CALIBRATE)

- **Discrepancy:** "Nobody can tell" is an absolute, and "the possible causes" is never listed.
- **Rationale:** State the measurable fact: "The log does not show whether the mail-limit store failed or the email port returned a failure code." Name the cause types that line 43–46 introduce (`recipient-limit-failed`, `delivery-failed`, `delivery-threw`), so the Problem and Design sections use the same words.

#### 4. Lines 24–25 (Goal): "Every auth email delivery failure records one structured event" is not true as scoped (CALIBRATE)

- **Discrepancy:** Line 34 leaves `apps/operator` without the callback, so failures there record nothing. The callback is optional (line 41), so any `createAuth` caller that does not pass it records nothing. Also, `packages/auth` does not record anything: it calls a callback, and `apps/web` emits the event.
- **Rationale:** Narrow the goal to what can be tested: "In `apps/web`, every auth email delivery failure emits one `auth.email-delivery-failed` event naming the operation and a non-sensitive cause."

#### 5. Lines 64–67 (Design 5): the mapping to `errorCategory` is unclear

- **Discrepancy:** "`AUTH_EMAIL_RECIPIENT_LIMIT_FAILED` / `AUTH_EMAIL_PORT_THREW` for the thrown reasons" uses a slash for a two-to-two mapping. The reader has to guess which reason gets which value. "The other fields as `attributes`" does not list the fields. It is unclear whether `operation`, `reason`, `provider`, `retryable` and `errorName` are all included, and whether `code` is repeated.
- **Rationale:** Write the mapping out (`recipient-limit-failed` → `AUTH_EMAIL_RECIPIENT_LIMIT_FAILED`; `delivery-threw` → `AUTH_EMAIL_PORT_THREW`; `delivery-failed` → port `code`). List the attribute keys. Split the nine-line bullet into separate points: mapping, cleaning the input, and scheduling.

#### 6. Lines 67–69: "allowlist of known values, so a forged value cannot inject text into the log" claims too much (CALIBRATE)

- **Discrepancy:** `errorName` is not an allowlisted value. It is any identifier that passes the regex, up to 64 characters (`server.ts` lines 125–131). "Forged" also names no source: the value comes from auth code in the same process, and the plan does not say who could forge it.
- **Rationale:** Describe the actual control: "Rebuilds the event from fixed enumerations for `operation`, `reason`, `code` and `provider`, and drops any `errorName` that fails the identifier check." Either name the threat (for example, a caller passing an untyped object) or drop "forged".

##### 🟢 Nit

#### 7. Lines 3–4: the header uses references a new reader cannot look up

- **Discrepancy:** "Item I5", "Flow: full" and "🐘🐟 review" are not defined or linked.
- **Rationale:** The emoji is not searchable. Link the parent card or item, and replace the emoji with the name of the review process.

#### 8. Line 1 (title) is narrower than the plan

- **Discrepancy:** The title says "log the email failure code". The plan also records the operation, the reason, `errorName`, and the verification path.
- **Rationale:** Something like "Record the cause of auth email delivery failures" matches the scope.

#### 9. Lines 12–13: "the auth code drops that code" uses "code" in two senses

- **Rationale:** One means source code, the other means failure code. Write "`sendResetPassword` drops that failure code".

#### 10. Line 17: "flaky" has no measure

- **Rationale:** Give an observed failure rate or the number of failing runs, or write "intermittently failing".

#### 11. Line 34: "is not wired. Its option stays unset." repeats itself and uses jargon

- **Rationale:** Use one sentence: "`apps/operator` (dev-only) does not pass `onEmailDeliveryFailure`."

#### 12. Line 41: "New optional option" repeats the same word

- **Rationale:** Write "New optional field `onEmailDeliveryFailure`".

#### 13. Lines 47–49: "plain identifier" is undefined

- **Rationale:** Give the exact rule: "matches `^[A-Za-z_$][\w$]{0,63}$`" or "an ASCII JavaScript identifier of at most 64 characters".

#### 14. Lines 51–52 repeat earlier statements

- **Discrepancy:** "No email address, user name, user id, URL, token or error message is passed" repeats "these fields only" (line 40) and "The error message is never read" (line 50).
- **Rationale:** Keep one statement, either the list of allowed fields or the list of excluded data, not both.

#### 15. Lines 53–54: "A callback that throws never changes the auth result" is broader than the design (CALIBRATE)

- **Discrepancy:** `AuthEmailDeliveryFailureSink` returns `void`, so an `async` callback is allowed. Its rejection happens outside the `try`/`catch`.
- **Rationale:** Write "a callback that throws synchronously", or say how a returned promise is handled.

#### 16. Lines 58–63: "stays the same" and "(as today)" say the same thing; "reset store failure" is unclear

- **Discrepancy:** "Reset store failure" can be read as a store for resets. "A reset port throw" is a stack of nouns.
- **Rationale:** Drop "(as today)". Write "a mail-limit store failure on the reset path" and "a throw from the email port on the reset path".

#### 17. Lines 69–71: "the raw `waitUntil` (non-database work)" is jargon; "the same way" is broader than true

- **Discrepancy:** "Raw" is not defined. The existing mapper uses `source: "worker"`, while the plan uses `source: "api"`, so it does not follow `request-database-diagnostics.ts` in every respect.
- **Rationale:** Write "schedules the emission with `waitUntil`, not `database.schedule`, as `request-database-diagnostics.ts` does". That limits the comparison to scheduling.
