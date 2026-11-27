# Drift Report: smart money holiday session (plan-holiday-session.md)

- **Date:** 2026-11-26
- **Document:** `docs/vertex-rebuild/designs/smart-money/plan-holiday-session.md` (whole document). The other files of this folder describe PRs 1 to 7 and the assistant terms, which merged earlier, and were not in scope.
- **Method:** `egm-drift-report` with one fresh-context reader (`egm-codebase-details`) on commit `748c471cf` (the plan and the fix). The deploy and live-check steps (plan steps 5 and 6) run after the merge and were not checked.

## plan-holiday-session.md

The reader found two divergences, both in the section "Background", both resolved in the document:

- The plan said that the gap fill requests a weekday whose ledger row is missing or `partial`. The code (`wanted` in `packages/api/src/server/flow-market-premium-collect.ts`) also requests an `unavailable` row after the same 6 hours. The plan now says "`partial` or `unavailable`".
- The plan said that both readers sum the newest 1, 5 or 20 sessions. The SQL term takes each whole number from 1 to 20 (`packages/db/migrations/0100_semantic_terms_smart_money.sql`). The plan now states both.

The fresh-context code review of the same commit found three text gaps. The code and the plan changed together:

- `packages/api/src/server/smart-money.ts`, comment in `coverageOf`: the live capture window now names the NYSE trading day (plan step 3 lists the edit).
- `docs/vertex-rebuild/flow-pipeline.md`, source table row "Market premium": the same (plan step 3 lists the edit).
- A holiday for which QuantData returns no rows is stored as `no_data`, not as `complete`: `flow-pipeline.md`, `CHANGELOG.md` and the plan now say so.

## Open after this report

- None in the code or the documents.
