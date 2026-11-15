# Library list: show the Vertex study result next to the external claim

* **Author:** Jeff Scott Ward
* **Date:** 2026-11-13

## Overview

On the strategy library list (`/library`), a strategy that Vertex tested and found to fail shows only the badge "Externally pre-validated". This badge records a third party's claim, but a reader takes it as a positive status. The Vertex result is visible only on the strategy's Backtests tab (the study verdict) or in the Overview tags field (the `failed` tag).

The feature adds a second badge to each strategy row (table row, card and detail header). This badge shows Vertex's own result:

* "Vertex study: <verdict>" when the strategy has a stored Vertex study that the Backtests tab also shows.
* A tag-based label when the strategy has no such study but has the `failed` tag.
* No result badge when neither applies.

The server adds the study verdict to each row. There is no database migration and no data change. The target users are the owner and operators who scan the library to choose strategies for research or paper trading. A study verdict is a research result. It gives no trading authority, and it does not mean "validated by Vertex" (that needs the Vertex replication and gates).

## Analysis

Seven goldfish reviewers examined the concept in BRAINSTORM mode: design critic, codebase details, zoom out, comprehension, implementation readiness, structural and inventive catalyst. All seven returned a report. The findings below are deduplicated.

### Facts checked in the code

* `volume-spike-breakout` (migration 0065) has the tags `backtest-study` and `externally-pre-validated`, and no `failed` tag. `triple-rsi` (migration 0070) has `backtest-study`, `externally-pre-validated` and `failed`. A rule based only on tags misses `volume-spike-breakout`. A rule that requires the `backtest-study` tag still covers it.
* The Backtests tab loads a study only when the strategy has a tag, and only when the study kind matches that tag (`strategy-library-detail.tsx`, `BacktestsTab`):
  * tag `quantconnect-idea` loads a study of kind `qc-port`, verdict `PASS` or `FAIL`;
  * tag `backtest-study` loads a study of kind `strategy-backtest`, verdict `edge`, `no-edge` or `needs-more-data`.
* The `research_studies` table also holds filter studies (for example `adx-rvol-filters`). They have no `kind`, or `kind: "filter"`, and they have no single verdict for a strategy. They share the id namespace with strategy slugs.
* The study repository has only `get(id)` for one study. It returns the full `summary` document, which can be up to 320 KiB of jsonb. The list can return up to 500 rows (`STRATEGY_LIST_MAX`). Each request has one database connection.
* `StrategySummarySchema` is the row type of both `strategyLibrary.list` and `strategyLibrary.get`. The `StrategyBadges` component renders in the table row, the card and the detail header.
* `StrategyBadges` gives every badge that is not `high-priority` the attribute `data-strategy-external-validation` and the external-claim style. A new badge key would be marked as an external claim unless the component changes.
* Read-only agent API keys may call `strategyLibrary.list` and `strategyLibrary.get`, but not `researchStudies.get` (`AGENT_API_KEY_READ_PROCEDURES` in `operator-access.ts`).
* Strategy slugs can have up to 80 characters. Study ids can have up to 64 characters.
* No code refers to the `failed` tag today. It is a data convention only.
* `packages/api/openapi.json` is committed and `bun run openapi:check` runs in `verify:core`.

### Main risks and how the brief resolves them

1. **The list and the Backtests tab can disagree (all seven reviewers).** If the list matches a study by slug only, an untagged strategy, a filter study or a study of the wrong kind can give a list badge that the Backtests tab does not show. Resolution: one shared rule decides which study belongs to a strategy. The rule is the Backtests tab rule: the study id equals the slug, the strategy has the tag, and the study kind matches the tag. The list and the tab use the same rule from one module.
2. **Reading full study documents for every row is too expensive (design, structural, readiness, inventive, codebase, zoom out).** One `get` per row gives up to 500 sequential queries and can move many megabytes. Resolution: add one batch repository method that reads only `id`, `summary->>'kind'` and `summary->>'verdict'` in a single primary-key query (`WHERE id = ANY(...)`). This follows the existing `latestBacktests` batch pattern. The server queries only the slugs that pass the tag rule and that are at most 64 characters long. A small Zod schema checks each projected pair against the verdict enums of the existing study contracts. Known limit: the database still reads the whole stored document to extract the two keys. This is acceptable for the current few dozen studies. A stored column would remove it, but that needs a migration and is out of scope.
3. **The projection skips the full read-time validation (design, codebase, inventive).** The Backtests tab parses the full document and, for `qc-port`, recomputes PASS/FAIL. The list does not. A stored document that fails the current schema could give a list badge while the Backtests tab shows a storage error. Resolution: the list trusts the validation done by the import CLI. It accepts only known kinds and their verdict enums. A test with a malformed row pins the behavior. This trade-off is written in the contract comment.
4. **A study lookup failure can break the whole list, or silently bring back the misleading state (design, codebase, readiness, inventive, zoom out, comprehension).** The list handler sends every error to `mapStrategyError`, which gives a 503 for the whole library page and for the Backtest runs strategy dropdown. Its error text also names the wrong migrations. If the failure gives no badge, a failed strategy again shows only "Externally pre-validated". Resolution: a study lookup error never fails the list. The exact row state after a failure is an open decision for `/egm-draft` (see below). Each degraded lookup emits a structured semantic event (like `reportFailure` in `market-notes.ts`), with the study id and an error category, never the document body.
5. **The new badge would be styled and marked as an external claim (comprehension, structural, readiness, codebase).** Resolution: `StrategyBadgeKey` gets a new key. The component replaces its two-way ternary with a lookup keyed by badge key (data attributes and variant per key), so the compiler catches every new key. The new badge has its own attribute, for example `data-strategy-vertex-result="no-edge"`, and a source attribute (`study` or `failed-tag`).
6. **Two verdict scales and a tag can confuse readers (comprehension, structural, inventive, design).** `PASS` can be read as "validated by Vertex". "Tested, failed" does not say who tested. Resolution: one label map per study kind, shared by the list badge and the Backtests tab. `edge`, `no-edge` and `needs-more-data` reuse `VERDICT_LABELS`. Every result badge uses the neutral `outline` tone, never green or red. The existing qc-port component already keeps PASS neutral ("a PASS is a research result, never a go signal"). Each badge has a hint and screen-reader text that names the source and states that a study verdict gives no trading authority. The badge text alone carries the meaning.
7. **The field reaches more than the list (design, readiness, structural, codebase, zoom out).** The shared row type also feeds `strategyLibrary.get` and the detail header. Resolution: one server helper fills the field for `list` and `get`, through the shared `toStrategySummaryOutput`. The detail header shows the same badge, so a click from a row does not lose the result. The OpenAPI file is regenerated.
8. **Read-only agent keys would see study verdicts (five reviewers).** Resolution: accept this on purpose. A verdict is a short research label with no trading authority, and the full study document stays behind `researchStudies.get`. Record the decision in the access comment in `operator-access.ts` and in a test.
9. **A study verdict and the `failed` tag can disagree (comprehension, structural, inventive, codebase).** Resolution: the study verdict wins over the tag. When the study says `edge` or `PASS` and the tag says `failed`, the hint says "Also tagged failed". A `FAILED_TAG` constant replaces the bare string.
10. **Environments without imported studies (readiness).** Studies are written only by `bun run vertex:research-studies:import`. A database where the import did not run shows no study badge. Rollout checks that the study rows exist in production before the live check. Tests that expect a badge load a study fixture first.
11. **Rollback with open browser tabs (readiness).** The web app and its API deploy together. A tab that runs new client code against an old server receives rows without the field. The badge helper treats a missing field as `null`.

### Inventive contradictions

* **Complete badge versus a cheap list request.** Resolved by a projected batch read, limited to rows that pass the tag rule (segmentation and preliminary action).
* **List availability versus a truthful result.** The list must load when the study read fails, and a failed strategy must not look positive. Resolved by separating the study lookup from the list query and giving each row an explicit result state. The exact state is the open decision below.
* **Simple list rule versus agreement with the Backtests tab.** Resolved by extracting one rule (tag plus kind) that both pages use.
* **Each study kind's own words versus one consistent badge.** Resolved by one typed adapter in `strategy-library-model.ts` with `Record` tables keyed on the contract enums, so a new kind or verdict fails to compile instead of rendering nothing.

### Ideal Final Result

`strategyLibrary.list` and `strategyLibrary.get` add one small batched query and no migration. One shared rule decides whether a strategy has a Vertex result, so the list and the Backtests tab never disagree. A failed lookup never removes the list and never lets the external-claim badge stand alone as good news. One typed badge model feeds the table row, the card and the detail header.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * A Vertex result badge in the table row, the card and the detail header, placed directly before "Externally pre-validated".
  * A nullable, closed contract field on `StrategySummarySchema` with the study kind and verdict, filled by one helper for `list` and `get`.
  * One batch repository read of the projected verdict fields, with no query per row.
  * One shared tag-plus-kind rule, used by the list and the Backtests tab.
  * The `failed` tag fallback in `strategyBadges`, with a `FAILED_TAG` constant.
  * A study lookup failure never fails the list. Each degraded lookup emits a semantic event.
  * Neutral tone, hint and screen-reader text for each result state. Layout stays stable at 375, 768, 1024 and 1440 px.
  * Regenerated `packages/api/openapi.json`. Updated comments in `contracts/research-studies.ts` (three study kinds share the table), `server/research-studies.ts`, `operator-access.ts`, and the `EXTERNAL_CLAIM_NOTICE` text where needed.
  * Tests: a study verdict row, a `failed` tag row, a row with neither, a filter study at a tagged slug, a wrong-kind study, a malformed stored row, a lookup error, a missing repository, a slug longer than 64 characters, and a tag-study conflict.
* **Out-of-Scope Non-Goals:**
  * Filtering or sorting the list by verdict.
  * Renaming the "Externally pre-validated" badge.
  * Any database migration, stored verdict column or data change (tags and studies stay as they are).
  * Making the badge a link to the Backtests tab. The row link already leads there.
  * Product analytics for badge clicks.
  * Extra telemetry and tracing that reviewers proposed: span metrics for the study lookup (time, rows, degraded count), a latency budget, a `study-missing` event, a tag-study conflict event, the study run date or `updatedAt` in the contract field, and dates in badge hints. Reason: the card asks for a list badge only (focused change, repository rule 12). The one semantic event for a failed lookup stays in scope, because the conventions forbid swallowing an error without an event. The owner can move any of these back into scope.
  * Refreshing an open list when a study is imported. The list reloads on the next filter change or page load.

## Alternatives Weighed

* **Badge from the `failed` tag only, computed on the client.** Rejected by author: `volume-spike-breakout` has no `failed` tag, so its "No edge" result would stay hidden.
* **Add or change tags in the data, for example tag `volume-spike-breakout` as failed.** Rejected by author: the card asks for a UI change with no data change, and a tag would copy a result that the study already holds.
* **Fetch each study from the browser with `researchStudies.get` per row.** Rejected by reviewers: one request per row, and read-only agent keys cannot call it.
* **Reuse `get(id)` per row on the server, or load full documents in bulk.** Rejected by reviewers: up to 500 sequential queries on one connection and many megabytes per request.
* **Store the verdict in a new column, or copy it into tags.** Rejected by author: needs a migration or a data change.
* **Match studies by slug only.** Rejected by reviewers: the list and the Backtests tab would disagree, and filter studies or wrong-kind studies could produce badges.
* **Change the Backtests tab to match by slug and kind instead of tag.** Considered by reviewers. Not chosen: it changes existing detail behavior, and the tag rule already covers the motivating cases.
* **Only rename "Externally pre-validated" to "External claim".** Rejected by reviewers: it still does not show the Vertex result.
* **Put a ready-made label string in the API response.** Rejected by reviewers: display wording belongs in the web model, not in the contract.

## Key Decisions & Staging for Next Steps

Decided in ideation:

1. Matching rule: study id equals slug, the strategy has the tag, and the study kind matches the tag (`quantconnect-idea` to `qc-port`, `backtest-study` to `strategy-backtest`). Filter studies and unknown kinds never give a badge.
2. Contract field: a nullable discriminated object on `StrategySummarySchema`, for example `vertexStudy: { kind: "qc-port", verdict: "PASS" | "FAIL" } | { kind: "strategy-backtest", verdict: "edge" | "no-edge" | "needs-more-data" } | null`. The web model derives the badge from it and from `tags`.
3. Batch read: one projected primary-key query, only for tagged slugs of at most 64 characters, checked with a small Zod schema.
4. The study verdict wins over the `failed` tag. A conflict shows in the hint.
5. The badge appears in the table row, the card and the detail header, before "Externally pre-validated", in the neutral `outline` tone.
6. Read-only agent keys may see the verdict. This is recorded in code.
7. No migration and no data change.

Open for `/egm-draft` (author decides; more than one defensible answer):

1. **Row state after a failed study lookup.** Options: (a) a neutral "Vertex result unavailable" badge on tagged rows, with a third state in the contract field; (b) the field becomes `null` and the row falls back to the `failed` tag rule or no badge, with only a server event. Option (a) keeps the page truthful during an outage but adds one more contract state and badge text. Option (b) is smaller but can show the misleading single badge during an outage.
2. **Label for the tag fallback.** Options: "Tested, failed" (the card's wording) or a label that names Vertex and the source, for example "Vertex: failed (tag)".
3. **Label for qc-port verdicts.** Options: "Vertex study: Pass" / "Vertex study: Fail", or wording closer to the Backtests tab, for example "Vertex backtest: PASS".
