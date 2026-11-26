# Drift Report — Index ETF Dossiers

- **Date:** 2026-11-24
- **Design doc:** `docs/vertex-rebuild/designs/index-etf-dossiers/design.md`
- **Review record:** `docs/vertex-rebuild/designs/index-etf-dossiers/goldfish_review_report.md`

## Implementation vs Design Comparison

| Design section | Implemented | Drift |
| --- | --- | --- |
| §3A Read-time computation from `market_bar_series` (`1d`), no second price store | `packages/api/src/server/research-reports.ts` reads `context.repositories.marketBars` at read time; explicit `input.revision` pins to stored revision bars | None |
| §3B Bar-backed `IWM` and `DIA` dossiers (`INDEX_ETF_DOSSIERS`) | `list`, `technicals`, and `dataset` synthesize bar-backed index ETFs when their `1d` bar series exist in `market_bar_series`, placing them in the SPY/QQQ category or `"index-etfs"` fallback; `companyResearch` returns `NOT_FOUND` | None |
| §3C Freshness limit (`2` NYSE sessions behind `expectedFreshnessSession`) | `evaluateDossierFreshness` in `packages/api/src/research-report-technicals.ts` reuses `expectedFreshnessSession` & `nyseSessionsBehind` with `DOSSIER_TECHNICALS_MAX_SESSIONS_BEHIND = 2` and `"fresh" \| "stale" \| "no_date"` | None |
| §3D Parity between `stored`, `recomputed`, `check`, and `current` | `recomputed` & `check` remain pinned to stored revision bars; `current` computes full indicators + trend checks from active bars (`market_bars` when fresher, else revision) | None |
| §3E Access & privacy invariants | `researchReports.*` stays behind `requireOperator` (operator + agent viewer GET), outside `AGENT_API_KEY_PROCEDURE_ROOTS`, `AGENT_API_KEY_PROCEDURE_PATHS`, and `MCP_TOOLS` | None |
| §4 Contract & OpenAPI | `packages/api/src/contracts/research-reports.ts` extended; `packages/api/openapi.json` regenerated and verified | None |
| §6 UI changes | Catalog table (`Data date` + `Stale` badge + stale KPI hint), dossier `PageHeader` (`Price data YYYY-MM-DD` / `Stale · YYYY-MM-DD`, wrapped for 375 px), Technicals tab (`Current indicators` + Weinstein stale badge & reason) | None |
| §7 Tests & 100% coverage | 135 tests across 8 suites (including `status-language.test.ts` and `research.test.tsx`); 100% statements, branches, functions, and lines across all 6 touched source files | None |

## Remaining Operational Steps (Post-Merge on QuantVPS)

- Deploy `vertex-web` via `infra/quantvps/restart-when-idle.sh` outside market hours (after 16:00 ET or before 08:30 ET).
- Verify live with the read-only agent viewer session: `researchReports.list` includes `SPY`, `QQQ`, `IWM`, `DIA`, each `technicals` response has `bars.lastDate` no older than the previous trading session, and capture dark 375 px and 1440 px screenshots of `/research/reports/IWM` and `/research/reports/QQQ`.
