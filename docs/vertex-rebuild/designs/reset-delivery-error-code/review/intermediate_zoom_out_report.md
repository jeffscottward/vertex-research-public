# Stage 8: Intermediate Zoom Out review

## Stage 8 Zoom Out review: `reset-delivery-error-code/plan.md`

**Verdict:** I found no blockers, 1 Major and 4 Nits. The Stage 5 Blocker is fixed. Most Stage 5 Nits were handled. The one exception got worse: Stage 5 called the "forged value" allowlist speculative, and the plan has since expanded that layer instead of reducing it. The rest of the design is the smallest design that works, and it follows an existing pattern: an optional typed callback in `packages/auth`, mapped to an event in `apps/web`, like `RequestDatabaseDiagnosticSink` and `request-database-diagnostics.ts`. The code in the worktree matches the plan.

### How the Stage 5 findings were handled

| Stage 5 finding | Status | Where |
| --- | --- | --- |
| 🔴 The reset error never reaches the client | **Fixed.** The Problem section now describes the background task. Non-goals now say the response stays the safe 200. The acceptance test now checks the 200 and then drains the background tasks. | L13–19, L26, L117–119 |
| 🟡 `preview-capture` was not mentioned | **Fixed.** The plan now states the gap: the helper cannot see failures before the request reaches it. It also argues the cause from `APP_ENV=test`. I checked the code: `rateLimitEnabled: env.APP_ENV !== "test"` is at `request-scope.ts:124`, so that argument holds. | L21 |
| 🟢 The `APIError.cause` option was not discussed | **Fixed.** It is now in Alternatives, with the port-wrapper option. | L73–74 |
| 🟢 The privacy claim stopped at the new event | **Fixed.** Every reset path now throws the redacted error (`server.ts:617–620`). | L57 |
| 🟢 Where the event shows in CI was not stated | **Fixed.** The data flow and the `docs/debugging.md` row now say stderr and `[app]` lines. | L36–41; `debugging.md:13` |
| 🟢 The plan did not show work had started | **Fixed.** The Status line says the work is implemented. | L7 |
| 🟢 Causes that emit no event were not stated | **Fixed.** They are in Risks and in `docs/debugging.md`. | L83 |
| 🟢 The "forged value" allowlist is speculative | **Not fixed, and expanded.** See finding 1. | L55, L67, L101, L121 |
| 🟢 `errorName` and its regex are code detail in the Design section | **Not fixed.** See finding 2. | L55, L82 |

#### Findings

##### 🟡 Major: three layers sanitize the same values, and the defense against untyped callers is speculative (L67, L55, L101, L121)

**Discrepancy:** Stage 5 asked the plan to copy the `request-database-diagnostics.ts` pattern: a `switch` that drops unknown values. Instead, Design 6 adds more layers. It adds `satisfies`-checked tables of all 8 failure codes, 3 providers and 2 operations. It adds two policies: some unknown values are dropped (operation, reason) and others are replaced (code becomes `AUTH_EMAIL_UNKNOWN_CODE`, provider becomes `unknown`). It turns any `retryable` that is not `true` into `false`. It checks `errorName` against the regex a second time. One of the three acceptance tests (L121) now checks this layer rather than the stated Goal.

#### Simplicity rationale

- **The threat it guards against does not exist here.** The justification is "a caller that bypasses the types" (L67). The only caller is `createAuth` in the same monorepo. It builds the value from typed fields and from `errorNameOf`, which already applies the same regex (`server.ts:130–136`).
- **The log sink already covers this risk.** `createEvlogSink` runs every event through `redactSemanticEvent` (`observability/src/server/evlog.ts:69`). That function scrubs and bounds `errorCategory` (`boundedString` calls `scrubString`) and redacts `attributes`, including email addresses, reset or verify URLs and tokens (`redaction.ts:394, 442, 851–863`).
- **The same rule now lives in two places.** `SAFE_ERROR_NAME` is copied into `auth-email-diagnostics.ts:54` and `server.ts:130`.
- **Adding an email code now means editing the web app.** The tables are a runtime copy of `EmailDeliveryFailureCode` and `EmailProvider`. A new code in `packages/email` breaks the `apps/web` type check until the web mapper is edited. That is a coupling across bricks for no runtime benefit. The `errorCategory` could simply be the typed `code`.
- **The mapper is much larger than its precedent.** It is about 130 lines; `request-database-diagnostics.ts` is about 60. Two failure policies (drop and replace) make it harder to reason about.

**Simpler option:** Trust the typed union. Write a `switch` on `reason` that drops unknown reasons, set `errorCategory` to the `code` (or a fixed constant for the two reasons that throw), and leave scrubbing to `redactSemanticEvent`. Remove the replace-unknown and coercion tests, and remove the L121 acceptance case. If the plan keeps this layer, it should add an Alternatives entry explaining why the sink redaction and the typed producer are not enough. The plan does not say why it rejected the Stage 5 finding.

##### 🟢 Nit: implementation detail sits in the high-level Design section (L55, L56, L67)

- Design 2 gives the regex `^[A-Za-z_$][\w$]{0,63}$` and the `UnknownError` and `NonError` fallbacks.
- Design 3 describes attaching a `catch` to a returned promise.
- Design 6 lists `satisfies Record<..., true>` and per-field coercions.

These are code-level rules. In the Design section, they bury the three facts a reader needs: the callback is optional, the value contains nothing sensitive, and a failing callback is contained. Move them to the Detailed Implementation Plan, or rely on the tests listed at L95 and L101. Stage 5 flagged this and it is not fixed.

##### 🟢 Nit: `errorName` and `retryable` add little, and the plan now says so itself (L82, L55)

- The new Risk at L82 says `errorName` "may not separate store faults", because drivers throw a plain `Error`.
- A thrown port error is itself a bug, because the adapters return typed results.
- `retryable` is derived from `code` in the adapters (`email/src/server/provider.ts`), so logging both repeats the same fact.

Each field costs a regex, two fallbacks, a check repeated in two places, and four test cases (L95). `reason` plus `code` would answer the card's question: which failure stops the E2E reset email. The plan keeps both fields with "Accepted for now" and gives no use for them. Consider dropping both.

##### 🟢 Nit: the plan points to review files that do not exist yet (L6)

L6 lists `consolidated_review_report.md` and `goldfish_review_report.md` in `review/`. The folder now holds only `critic_report.md`, `comprehension_report.md`, `implementation_readiness_report.md` and `zoom_out_report.md`. Make sure the two named files are written before merge, or change the list.

##### 🟢 Nit: the plan says the work is implemented but gives no verification results (L7, L105–113)

L7 says the steps "describe the code in that branch". The Verification section lists commands and coverage thresholds but does not say whether they passed. That includes the `server.ts` coverage baseline: lines 98.64, branches 95.92. A reader cannot tell whether the plan describes verified code or code that has only been written. Add one line with the results or the CI run that checked them.

#### Checked with no issue

- **Package boundary:** keeping `@darkfactory/observability` out of `packages/auth` matches the `packages/db` precedent.
- **Scheduling:** emitting through the raw `waitUntil` is consistent with `request-database-diagnostics.ts` and the comment at `request-scope.ts:35`.
- **Request id:** the mapper closes over the request id, and `createAuth` is built once per request inside `withRequestScope` (`request-scope.ts:118–131`), so this holds.
- **Event fields:** `source: "worker"` and `outcome: "failure"` match the precedent.
- **No new framework:** no new shared diagnostics abstraction is added. Two mappers are not enough to justify one.
- **Alternatives:** the port-wrapper rejection (L74) gives the right reason: the store failure would still need the callback, so reporting would be split in two.
- **No premature optimization:** no caching, queues or retries are added. The Volume risk (L81) is bounded by the existing rate limits.
