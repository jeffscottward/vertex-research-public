# Goldfish review resolution: reset-delivery-error-code plan

Resolution mode: Auto accept (standing owner rule 2026-11-13). Every PROPOSE FIX is applied to `plan.md` and, where it named code, to the branch. CONTEST and DECLINE findings stay as recorded here. No finding needed an owner fact (no ESCALATE).

Counts: findings from 10 reviewer runs (Stages 5-9), with duplicates grouped: 28 PROPOSE FIX groups (applied), 6 CONTEST, 2 DECLINE.

## PROPOSE FIX (applied)

| Source | Finding | Resolution |
| --- | --- | --- |
| Zoom Out B, Design 3, Readiness 1, Codebase 1, Catalyst M2 | The reset error never reaches the client; the acceptance test was impossible | Problem, Goals and acceptance test now describe the background task and the safe 200 response. The DF-043 integration case checks the 200 and the report after the background tasks drain. |
| Catalyst M1, Design 5, Zoom Out nit, Codebase 13 | A reset port throw rethrew the raw error, which Better Auth logs with its message | Code: every reset failure now throws `PASSWORD_RESET_DELIVERY_FAILED`, like verification. Test: "reports a thrown reset port error by name and redacts the thrown error". |
| Structural B1, Design B1 | No Alternatives section | Added four alternatives with rejection reasons. |
| Structural M2, Design B2 | No Risks section | Added Risks and Mitigations (background timing, double log line, volume, generic error names, cases without an event). |
| Design 4, Zoom Out M, Catalyst nit 2 | The claim that the event shows the flake cause was not backed up; earlier diagnostics not named | Problem now names the E2E capture helper and why `APP_ENV=test` leaves only the `failed` result; the Goal is narrowed; Risks and `docs/debugging.md` list the cases without an event. |
| Design 7, Comprehension M1, Zoom Out nit | Where the event appears in CI | Data flow and `docs/debugging.md` say: evlog error level, stderr, `[app]` lines. |
| Comprehension M5, StyleFeature 15, Readiness nit 5 | The callback could be async; a rejection would escape | Code: `reportEmailDeliveryFailure` attaches a `catch` to a returned promise. Test: "contains a rejected promise from an async diagnostic callback". |
| Comprehension M3, Structural 9, StyleFeature 7/9/12/16 | Undefined terms (email port, mail-limit store, preview email, evlog sink, semantic event) | Added a Terms list and the data-flow block. |
| Comprehension M4, StyleFeature 5/6, Readiness 3, Codebase 4, Structural M4 | Mapping to `errorCategory` and `attributes` unclear | Added two tables (reason to fields; reason to category and attributes). |
| Comprehension M6 | How the request id reaches the mapper | Design 5 says the mapper closes over the request id; `createAuth` runs once per request. |
| Readiness 2, Codebase 3 | Store failure and over-cap cases cannot be tested in `verification-config.test.ts` | Code: those cases moved to `abuse-limits.test.ts`, which mocks the store; the incidental `TypeError` test was removed. |
| Readiness 4, Codebase 9, StyleDetailed nit | Exact `createAuth` assertion would break; wiring not literal | Detailed Plan gives the literal argument and the assertion change. |
| Codebase 5, StyleDetailed nits | Paths not marked Create/Modify, test files unnamed | Every file is named with Create or Modify. |
| Codebase 6, StyleDetailed M2 | Coverage not checked by any listed command | Verification names the CI coverage lane and the `server.ts` baseline. |
| Codebase 7 | No phases | Plan split into three phases with checkpoints. |
| Codebase 8, Readiness nit 6 | Type list and imports incomplete | Phase 1 lists the imports and `AuthEmailOperation`. |
| Codebase 10, StyleDetailed nit | Table row content not given | Row added to `docs/debugging.md` with categories and files. |
| Codebase 12 | Example port result missing fields | Acceptance uses a full `failed` result. |
| StyleDetailed M1 | Reset step order could be read two ways | Phase 1 says the `failed` check stays outside both `try` blocks. |
| StyleDetailed M4, Comprehension nit | "Risk: low" had no basis; success paths restructured | Risk text now names the restructure and the passing success tests. |
| StyleFeature 1/2/3/4, Design 9 | Overstated Problem and Goal | Problem lists the three cases; Goal limited to `apps/web`; "Effect" changed to "Observed symptom". |
| Structural 3/5/6/7/8 | List rendering, heading names, metadata lines, missing links | Headings renamed to the standard; metadata is a list; CI run linked; `RequestDatabaseDiagnosticSink` path given. |
| Design 10 | `source: "api"` for a background task | Code: `source: "worker"`, like the database diagnostics. |
| Zoom Out nit (Stage 5), Design 11 | The plan read as future work | Status line says the branch implements it. |
| Zoom Out 2 M1 (Stage 8) | Three layers sanitize the same values; the web tables duplicate `packages/email` types | Code: the mapper now trusts the typed value and drops only an unknown reason; `redactSemanticEvent` in the evlog sink stays the last layer. Design 6 rewritten. |
| Zoom Out 2 nit (Stage 8) | Code detail in Design | The `errorName` regex moved to the Detailed Plan. |
| Zoom Out 2 nit (Stage 8) | Named review files did not exist | This file and `consolidated_review_report.md` are written. |
| Zoom Out 2 nit (Stage 8) | No verification results | Results are in `consolidated_review_report.md` and the PR. |

## CONTEST

| Source | Finding | Reason kept |
| --- | --- | --- |
| Catalyst nit 1 | Wrap the email port instead of changing the auth callbacks | It covers two of three reasons; the store failure still needs the callback. Recorded under Alternatives. |
| Zoom Out nit (Stage 5), Zoom Out 2 nit | Drop `errorName` and `retryable` | Both are already typed and tested; `errorName` separates a port bug from a store fault class at no extra cost. |
| Design 6 | Emit unknown codes with a fallback category | Superseded by the Stage 8 finding: the code type comes straight from `EmailDeliveryFailureCode`, so a new code needs no web change, and the sink redacts. |
| Zoom Out nit (Stage 5) | Drop the forged-value tests | Kept one test: an unknown `reason` from an untyped caller is dropped (the `request-database` precedent). |
| Comprehension nit | Reset tests in `verification-config.test.ts` | That file already holds the reset delivery tests ("delegates reset delivery and converts a typed delivery failure"). |
| Structural 7 | "One-page plan" audited against the full feature-spec standard | The flow requires the review; the plan now has every standard section. |

## DECLINE (accepted risk)

| Source | Finding | Why declined |
| --- | --- | --- |
| Design 8 | Add an allowlisted SQLSTATE `errorCode` for store failures | Store failures cannot happen in E2E (`APP_ENV=test`), which is the motivating case. Recorded as a risk. |
| Catalyst nit 2 | Print `x-request-id` from the E2E reset spec on timeout | E2E helper change, outside this card's scope. |
