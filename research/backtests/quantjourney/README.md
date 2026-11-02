# QuantJourney example library: inventory and re-run

Research only. Nothing in this folder trades, submits orders or changes a live system. Card vertex-quantsmd (2026-10-31). The result: [docs/vertex-rebuild/quantjourney-library.md](../../../docs/vertex-rebuild/quantjourney-library.md).

## Files

| File | Content |
| --- | --- |
| [library.json](library.json) | Inventory (source of truth): 50 strategies with rules in Vertex's words, costs, published metrics, links, Vertex DSL mappings and re-run status |
| [results.json](results.json) | Re-run summaries and gate results (no price series; Yahoo data is not redistributable) |
| [assets-manifest.json](assets-manifest.json) | SHA-256 list of the assets kept outside the repository: 45 result previews, 5 skill prompts, the quants.md page data and the upstream LICENSE |
| `build_library.py` | Builds library.json from the quants.md page data snapshot and the pinned clone |
| `fetch_data.py` | Fetches the Yahoo daily and hourly bars (written outside the repository) |
| `qj_adapter.py` | Runs one unchanged upstream strategy file on the local bars; the only Vertex file that imports the QuantJourney package |
| `build_migration.py` | Wrote data migration `packages/db/migrations/0033_strategy_catalog_quantjourney.sql` and its rollback |

The Python files are research tools in the style of `research/backtests/carousel/`. They need the pinned clone or yfinance, are not part of the TypeScript platform and are not run by a repository gate. `scripts/research/quantjourney.ts` (tested in the `operations` project) validates library.json, computes the re-run statistics and gates, and renders the doc; `bun run research:quantjourney -- --check` reports a stale doc.

## Pin and licence

- Upstream: <https://github.com/QuantJourneyOrg/quantjourney-bt>, commit `4f403d853833e1daa6de01c5b6c6cb3983dc0044`, Apache-2.0. The repository has no NOTICE file. Clone on the rig: `~/Github/tools/quantjourney-bt`.
- Strategies, backtests, dashboards, result previews and skill prompts are QuantJourney's. Vertex copies no upstream source into the platform.
- The X post that pointed to quants.md called it a leaked Jane Street library. That is false.

## Regenerate

See the "Regenerate" section of the result doc.
