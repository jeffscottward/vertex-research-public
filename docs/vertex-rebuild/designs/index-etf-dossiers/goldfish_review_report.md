# Goldfish Review Report — Index ETF Dossiers

- **Design doc:** `docs/vertex-rebuild/designs/index-etf-dossiers/design.md`
- **Reviewers:** Two fresh-context subagents (`goldfish-readiness-check`, `goldfish-critic-fast`)
- **Resolution mode:** Auto-accept (owner rule 2026-11-13, owner Discord message (private)): all PROPOSE FIX findings applied to `design.md` before implementation.

## Findings & Resolutions

| # | Severity | Reviewer | Finding | Resolution |
| --- | --- | --- | --- | --- |
| 1 | High | critic-fast | `buildResearchReportTechnicals` already uses local `now` for `weeklyCloses`; conflating it with wall-clock `now` breaks historical revision reproducibility. | **Accepted:** Rename week-completeness timestamp to `weekCompletenessAt` (`activeCollectedAt ?? "${last.date}T21:00:00Z"`); use wall-clock `now` solely for `evaluateDossierFreshness`. |
| 2 | High | critic-fast | Switching `recomputed` to `market_bars` while keeping `check` on `storedBars` makes `checkView` report `recomputed.sampleCount` as matching `stored` (factually wrong on SPY/QQQ) and prints "no stored daily bars" on IWM/DIA. | **Accepted:** Keep `recomputed` tied to `storedBars` (exact parity with `check`); expose full active-bar indicators in `current`; update `checkView` copy for `bars.source === "market_bars"` (both with and without a stored snapshot). |
| 3 | High | critic-fast & readiness | Passing `input.revision` matching `series.sourceSha256` for bar-backed IWM/DIA must succeed (and any other revision must return `NOT_FOUND`); `list` must also populate `importedAt` and `sourceUpdatedAt`, and `dataset` must return `revisions: [series.sourceSha256]` and clean `no-strategies` shape for `options-analysis`. | **Accepted:** Explicitly specified in `design.md` §3, §5. |
| 4 | Medium | readiness | `ApiContext` does not have `now`; adding it touches `context.ts` (in `coverage-baseline.json`). | **Accepted:** Do not modify `context.ts`. Pure functions accept optional `now = new Date()`; server handlers call `new Date()` (controlled via `vi.setSystemTime` in unit tests). |
| 5 | Medium | readiness | `PageHeader` renders `<span className="inline-flex" data-slot="page-status">{status}</span>` without `flex-wrap`/`gap`, and E2E checks `375px` overflow and exact `"Research only"` text; `research-reports.test.tsx:369,714` assert exact text on `[data-slot='page-status']` and `[data-technicals-stage]`. | **Accepted:** Wrap header badges in `<span className="inline-flex flex-wrap items-center gap-2">`, keep freshness badge outside `[data-technicals-stage]`, update `research-reports.test.tsx` assertions cleanly. |
| 6 | Medium | critic-fast & readiness | `status-language-allowlist.ts` pins exact counts for `contracts/research-reports.ts` and `research-report-technicals.ts`; `knip` flags unused runtime exports. | **Accepted:** Keep existing allowlisted strings intact, use `"no_date"` / explicit non-vague phrasing for all new strings, and ensure every exported runtime symbol is imported by runtime code. |
| 7 | Medium | critic-fast | `CatalogKpis` `"Last updated"` looks fresh once index ETFs refresh nightly, masking stale dossiers; header badge on non-Technicals tabs could clash with archived fundamentals. | **Accepted:** Label header badge `"Price data YYYY-MM-DD"` (or `"Stale · YYYY-MM-DD"`) and include stale dossier count in `CatalogKpis` hint when stale dossiers exist. |
| 8 | Low | readiness | `apps/web/src/lab/entries/research.test.tsx` validates `LAB_RESEARCH_REPORTS` with Zod; should also validate `labResearchTechnicals("SPY")`, and `docs/vertex-rebuild/research-reports.md` should stay in sync. | **Accepted:** Add schema parse check in `research.test.tsx` and update `docs/vertex-rebuild/research-reports.md`. |

- **Counts:** 8 accepted (PROPOSE FIX applied), 0 contested, 0 declined, 0 escalated.
