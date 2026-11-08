# Research studies

Status: research only. A study result does not authorize a trade.

Frozen research studies are stored in Postgres and served through oRPC. The app does not read a study from a JSON file (AGENTS.md rule 13). Two kinds of study document share the table; the document's `kind` field tells them apart:

| Kind | `kind` | Example | Shown on |
| --- | --- | --- | --- |
| Filter study | absent (the seeded document predates the field) or `"filter"` | ADX/RVOL (`docs/specs/research/adx-filter.md`), id `adx-rvol-filters` | `/backtests` |
| qc-port backtest study | `"qc-port"` | the 11 QuantConnect idea ports (`docs/specs/strategies/qc-*.md`); the study id is the strategy slug, for example `qc-iv-rank-gate` | Strategy library detail, Backtests tab, of entries tagged `quantconnect-idea` |

## Parts

| Part | Code |
| --- | --- |
| Table | `research_studies` (`packages/db/src/schema/research-studies.ts`, migration `0051_research_studies`, rollback `packages/db/rollback/0051_research_studies.down.sql`) |
| Repository | `packages/db/src/server/research-studies.ts` (`get`, `upsert`, `upsertMany` in one transaction) |
| Contract | `packages/api/src/contracts/research-studies.ts`: `FilterStudySchema`, `QcPortStudySchema`, `ResearchStudyDocumentSchema` (the union, selected by `kind`), `researchStudies.get` (`GET /research-studies/{id}`) |
| Service | `packages/api/src/server/research-studies.ts` (operator-only, the same gate as `quantLab.list`) |
| Pages | `/backtests`: `apps/web/src/components/portal/filter-studies-section.tsx` loads the filter study; `filter-studies-panel.tsx` renders it. Strategy library: `strategy-backtest-study.tsx` (Backtest study section, mapped by `strategy-backtest-study-model.ts`) |
| Import | `bun run vertex:research-studies:import` (`scripts/research-studies/import.ts`) |

## qc-port study document

| Field | Meaning |
| --- | --- |
| `id`, `spec`, `ran` | Strategy slug, spec path, run date `YYYY-MM-DD`. The spec must match `docs/specs/strategies/qc-<slug>.md` and the id must equal that `qc-<slug>` |
| `kind` | `"qc-port"` |
| `verdict` | `"PASS"` or `"FAIL"`. The schema recomputes it from `runs[0]` and `criteria` and rejects a document whose verdict differs |
| `criteria` | The pre-registered pass rule: `{minSharpe, minDeflatedSharpe, maxDrawdown, beatBaseline}`. Bounds are strict: `runs[0]` passes when its Sharpe is above `minSharpe`, its deflated Sharpe is above `minDeflatedSharpe` (0 to 1), its drawdown magnitude is below `maxDrawdown` (above 0, at most 1) and, with `beatBaseline`, its Sharpe is above the Sharpe of `runs[1]` (required then; a baseline without a Sharpe counts as beaten). A null Sharpe or deflated Sharpe fails |
| `provenance` | `{codeRevision, engine, dataSha256, runId}`: the full 40-character git commit SHA, the engine and version (for example `nautilus_trader 1.221.0`), the SHA-256 of the data manifest and the run id |
| `title` | Display title |
| `runs` | 1 to 40 runs: `name`, `symbols`, `cagr`, `sharpe`, `deflatedSharpe` (0 to 1), `maxDrawdown` (-1 to 1; the page shows the magnitude as a loss), `worstMonth` (`{month: "YYYY-MM", ret}`), `trades`, `winRate` (0 to 1), `exposure` (0 to 1), `skipped`. `cagr`, `sharpe`, `deflatedSharpe`, `winRate` and `worstMonth` may be null when the run has too few days or no trades. |
| `equity` | Up to 400 monthly points `{t: "YYYY-MM", v}`, oldest first, months strictly increasing, `v` positive. The page charts the return since the first month. |
| `gates` | Optional, up to 40: `{gate, host, before, after}`, where `before` and `after` are `{sharpe, maxDrawdown, trades}` of the host strategy without and with the gate |
| `notes` | Free text, at most 4000 characters (may be empty) |

Unknown keys are rejected. Option prices in qc-port studies are MODELED (Black-Scholes on CBOE vol-index proxies); the Backtest study section says so. The section always shows "A backtest result is not approval to trade (research only).", in every state, and the verdict badge is neutral for PASS and FAIL alike. It also shows the pass rule and the provenance. The section has no arm, deploy or order control.

## Table

One row per study: `id` (slug, for example `adx-rvol-filters`), `spec_ref`, `ran_on`, `summary` (the whole study document, jsonb), `created_at`, `updated_at`. Checks: the id is a lowercase slug of at most 64 characters, `summary` is a JSON object of at most 320 KiB of jsonb text, and its `id`, `spec` and `ran` must be present and equal `id`, `spec_ref` and `ran_on`. The 320 KiB cap leaves headroom over the import CLI's 256 KiB cap on compact JSON, because jsonb text adds a space after every `,` and `:`. The app role `vertex_research` gets `SELECT`, `INSERT` and `UPDATE`; the app never deletes a study. Both kinds fit these checks, so the qc-port kind needed no migration.

The migration seeds the ADX/RVOL study run on 2026-10-31 (public research on public prices). The seed runs once, in the same migration that creates the table.

Rollback: `packages/db/rollback/0051_research_studies.down.sql` refuses while an imported study exists. It does not touch the Drizzle ledger, so the 0051 row stays in `drizzle.__drizzle_migrations` and `db:migrate` skips 0051 afterwards (the table stays missing and `researchStudies.get` answers `STORAGE_ERROR`). To re-apply, delete that ledger row (match its hash), then run `db:migrate`.

## Store a new run

From the repository root:

```sh
(cd services/research && python -m strategies.filter_study_summary \
    --daily <adx_filter_run output> --intraday <rvol_intraday output> --ran 2026-10-31) \
  | DATABASE_URL=postgres://... bun run vertex:research-studies:import
```

qc-port studies go through the same command: pipe one document, or JSON lines with one document per line (for example all 11 ports of one run).

The import CLI reads stdin as one JSON document (pretty-printed or not) or as JSON lines (at most 100 documents, distinct ids). It checks every document with `ResearchStudyDocumentSchema` before it stores any, then upserts all of them by id, in order, in one database transaction (`upsertMany` in the repository) and prints one result line per stored study after the transaction commits. `--dry-run` checks the documents without a database and prints one line per document. Exit codes: 0 stored, 2 usage or input problem (including a document the database checks reject), 1 storage failure. When any write fails (for example a document the database checks reject), the transaction rolls back and no study of that run is stored. Dates must be real calendar dates. The API checks the stored document again on every read; a document that fails the schema is a `STORAGE_ERROR`, not a broken page.

## Tests

- `packages/db/src/server/research-studies*.test.ts`: repository and migration (the seed equals `apps/web/src/features/research-studies/fixtures/adx-filter-study.json`).
- `packages/api/src/research-studies.test.ts`: both schemas, the union, access, errors, OpenAPI.
- `apps/web/src/components/portal/filter-studies-section.test.tsx`, `filter-studies-panel.test.tsx`.
- `apps/web/src/components/portal/strategy-backtest-study.test.tsx`, `strategy-backtest-study-model.test.ts` (fixture `apps/web/src/features/research-studies/fixtures/qc-port-study.json`, synthetic numbers).
- `scripts/research-studies/import.test.ts`.
- `tests/integration/database/research-studies.test.ts`: migration and repository on Postgres.
