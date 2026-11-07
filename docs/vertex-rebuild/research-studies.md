# Research studies

Status: research only. A study result does not authorize a trade.

Frozen research studies, such as the ADX/RVOL filter study (`docs/specs/research/adx-filter.md`), are stored in Postgres and served through oRPC. The app does not read a study from a JSON file (AGENTS.md rule 13).

## Parts

| Part | Code |
| --- | --- |
| Table | `research_studies` (`packages/db/src/schema/research-studies.ts`, migration `0050_research_studies`, rollback `packages/db/rollback/0050_research_studies.down.sql`) |
| Repository | `packages/db/src/server/research-studies.ts` (`get`, `upsert`) |
| Contract | `packages/api/src/contracts/research-studies.ts`: `FilterStudySchema`, `researchStudies.get` (`GET /research-studies/{id}`) |
| Service | `packages/api/src/server/research-studies.ts` (operator-only, the same gate as `quantLab.list`) |
| Page | `/backtests`: `apps/web/src/components/portal/filter-studies-section.tsx` loads the study; `filter-studies-panel.tsx` renders it |
| Import | `bun run vertex:research-studies:import` (`scripts/research-studies/import.ts`) |

## Table

One row per study: `id` (slug, for example `adx-rvol-filters`), `spec_ref`, `ran_on`, `summary` (the whole study document, jsonb), `created_at`, `updated_at`. Checks: the id is a lowercase slug of at most 64 characters, `summary` is a JSON object of at most 256 KiB, and its `id` and `spec` match the row. The app role `vertex_research` gets `SELECT`, `INSERT` and `UPDATE`; the app never deletes a study.

The migration seeds the ADX/RVOL study run on 2026-10-31 (public research on public prices) with `ON CONFLICT DO NOTHING`. The rollback refuses while an imported study exists.

## Store a new run

From the repository root:

```sh
(cd services/research && python -m strategies.filter_study_summary \
    --daily <adx_filter_run output> --intraday <rvol_intraday output> --ran 2026-10-31) \
  | DATABASE_URL=postgres://... bun run vertex:research-studies:import
```

The import CLI reads one document from stdin, checks it with `FilterStudySchema` and upserts it by id. `--dry-run` checks the document without a database. Exit codes: 0 stored, 2 usage or input problem, 1 storage failure. The API checks the stored document again on every read; a document that fails the schema is a `STORAGE_ERROR`, not a broken page.

## Tests

- `packages/db/src/server/research-studies*.test.ts`: repository and migration (the seed equals `apps/web/src/features/research-studies/fixtures/adx-filter-study.json`).
- `packages/api/src/research-studies.test.ts`: contract, access, errors, OpenAPI.
- `apps/web/src/components/portal/filter-studies-section.test.tsx`, `filter-studies-panel.test.tsx`.
- `scripts/research-studies/import.test.ts`.
- `tests/integration/database/research-studies.test.ts`: migration and repository on Postgres.
