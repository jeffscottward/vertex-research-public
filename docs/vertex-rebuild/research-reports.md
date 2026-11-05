# Research reports: workspace dossiers in Postgres

Status: research only. These records do not place, change or cancel orders, and a report recommendation does not authorize a trade. This is merge plan phase P1, part 1: the research dossiers of the old vertex-research workspace move into the platform database.

## Data

| Table | Holds |
| --- | --- |
| `research_reports` | One row per catalog report (58): identity, status, current `data_revision`, the whole catalog entry as `metadata`, and the accepted company-research head. |
| `research_report_categories` | The catalog groups and their report ids, in catalog order. |
| `research_report_revisions` | Each immutable report revision: `revision` (a revision folder) or `flat` (the original report, APP, whose files sit at the data root). |
| `research_report_datasets` | The seven datasets of each revision (`market`, `portfolio`, `fundamentals`, `news`, `technicals`, `options-analysis`, `committee`): SHA-256, byte length and the exact source text. |
| `research_company_research` | Every company-research dossier revision, by its SHA-256. |

Privacy: the `portfolio` dataset holds private broker data. Its body is never stored. A database check constraint (`research_report_datasets_private_check`) refuses a `portfolio` row with a body and any other row without one. Only the SHA-256 and byte length of a portfolio file are kept, so the revision token stays checkable. Other datasets of the original APP report quote account figures from the time of that research. They stay in the private database and are served only to operators. No dataset file is committed to this repository; tests use synthetic fixtures.

## Import

```sh
DATABASE_URL=postgres://... bun run vertex:research-reports:import -- --data-root <workspace>/data
bun run vertex:research-reports:import -- --data-root <workspace>/data --dry-run
bun run vertex:research-reports:import -- --data-root <workspace>/data --allow-remove
```

The importer (`scripts/research-reports/`) reads `reports.json`, every `reports/<ID>/revisions/<token>/` folder, the flat data-root files and `company-research/`. Before any write it checks:

- Every revision token. The rule is the workspace `revisionFor`: SHA-256 over `<name>\0<byteLength>\0<bytes>` for the seven datasets in the order above, over the exact file bytes.
- Every company-research revision: SHA-256 of `JSON.stringify` of the parsed dossier.
- Every catalog report has a folder for its current revision (or is the one flat report), and every accepted company-research head has a dossier stored for that same report.
- A missing `company-research/manifest.json` means no accepted research. Any other read error stops the import.

A mismatch stops the import with exit code 2 and writes nothing. The write is one transaction. Stored revisions, datasets and dossiers are never rewritten, so a rerun adds only new revisions. A stored revision whose source or dataset digests differ from the source folder stops the import. The catalog and categories are replaced as a whole. A stored report that is not in the catalog stops the import; `--allow-remove` deletes it with its revisions and datasets (its company-research rows stay).

The app role may update and delete only `research_reports` and `research_report_categories`; the other three tables are read and insert only. Revisions of one import share one import time, so `researchReports.dataset` lists them in token order within that import.

Expected counts for the workspace snapshot of 2026-10-16: 58 reports, 15 categories, 115 revisions (114 folders and 1 flat), 805 datasets (115 of them `portfolio` without a body), 72 company-research revisions and 58 accepted heads.

Rollback: `packages/db/rollback/0044_research_reports.down.sql` refuses to run while any research report row exists.

## API

Read-only and operator-only (the same gate as `quantLab.list`). Agent API keys and MCP tools cannot call these procedures.

| Procedure | Route | Returns |
| --- | --- | --- |
| `researchReports.list` | `GET /research-reports` | Catalog summaries and categories. |
| `researchReports.dataset` | `GET /research-reports/{reportId}/datasets/{dataset}` | One parsed dataset of the current revision, or of `revision`, plus the report's revision list. `portfolio` is not a valid dataset name. |
| `researchReports.companyResearch` | `GET /research-reports/{reportId}/company-research` | The accepted company-research dossier. |

## Pages

- `/research/reports`: the catalog, one table per category in catalog order; reports in no category form a last "Other reports" group. Linked from the Research page.
- `/research/reports/<ID>`: one report's datasets (fundamentals first; technicals, options analysis, committee, news, market) with summary, warnings, metrics, news items, collapsible sections and sources, and the revision in use.

Both pages load through the operator-only API; other users see "Research reports are limited to operators." Dataset JSON is read defensively in `apps/web/src/features/research-reports/view-model.ts`: fields with an unexpected shape are left out, and only `http(s)` links are rendered.

## Remaining P1 work

The research refresh scheduler, the technicals port (including Fibonacci and the volume profile check), market health and the Crown checklist, knowledge search and the payoff lab are later P1 slices. See the merge plan at `~/Documents/reports/web/vertex-merge-plan/` on the rig.
