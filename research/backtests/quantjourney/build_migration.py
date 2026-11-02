"""Write the 50 QuantJourney strategy-library rows as data migration 0033 and its guarded rollback.

Research only. Reads library.json and results.json in this folder; writes two SQL files.
Run once from the repository root:
  python3 research/backtests/quantjourney/build_migration.py
The migration is frozen after release; later result changes need a new migration.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parents[2]
MIGRATION = ROOT / "packages/db/migrations/0033_strategy_catalog_quantjourney.sql"
ROLLBACK = ROOT / "packages/db/rollback/0033_strategy_catalog_quantjourney.down.sql"
SOURCE_REF = "research/backtests/quantjourney/library.json"


def pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def ratio(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def describe(entry: dict, result: dict) -> str:
    universe = ", ".join(entry["universe"])
    parts = [
        f"QuantJourney example {entry['id']} ({entry['category']}, {entry['granularity']} bars, "
        f"{entry['assetClass']}: {universe}; {entry['period']['start']} to {entry['period']['end']}).",
        f"Rules: {entry['rules']}",
    ]
    published = entry["published"]
    if published is None:
        parts.append("QuantJourney publishes workflow diagnostics for this example, not portfolio metrics.")
    else:
        sharpe = "n/a" if published["sharpe"] is None else f"{published['sharpe']:.2f}"
        parts.append(
            f"QuantJourney published: total return {published['totalReturnPct']:.1f}%, Sharpe {sharpe}, "
            f"max drawdown {published['maxDrawdownPct']:.1f}%."
        )
    if result["status"] == "no-data":
        parts.append(f"Not re-run: {entry['rerun']['reason']}")
    else:
        engine = result["adapter"]
        if engine is not None:
            qj = engine["qj"]
            check = ("differs in " + ", ".join(result["flags"])) if result["flags"] else (
                "within tolerance" if published is not None else "no published figures to compare")
            parts.append(
                f"QuantJourney engine on Vertex Yahoo data: total return {pct(qj['totalReturn'])}, "
                f"Sharpe {ratio(qj['sharpe'])}, max drawdown {pct(qj['maxDrawdown'])} ({check})."
            )
        if result["primary"] is None:
            parts.append(result["note"])
        else:
            summary = result["dsl"] if result["primary"] == "dsl" else result["adapterVertexCost"]["summary"]
            gate = result["gate"]
            engine_name = "Vertex DSL signal engine" if result["primary"] == "dsl" else "adapter"
            parts.append(
                f"Vertex re-run ({engine_name}, 10 bp per side): CAGR {pct(summary['cagr'])}, "
                f"Sharpe {ratio(summary['sharpe'])}, max drawdown {pct(summary['maxDrawdown'])}; "
                f"deflated Sharpe probability {ratio(gate['deflatedSharpeProbability'])} with 50 trials; "
                f"gates: {'pass' if gate['pass'] else 'fail'}."
            )
    parts.append(f"Details: docs/vertex-rebuild/quantjourney-library.md. Dashboard: {entry['dashboard']} "
                 f"GitHub: {entry['github']} Research only.")
    return " ".join(parts)


def tags(entry: dict, result: dict) -> list[str]:
    out = ["quantjourney", entry["category"], entry["granularity"]]
    out += [style for style in entry["styles"] if style not in out]
    if entry["dsl"] is not None:
        out.append("vertex-dsl")
    if result["status"] == "no-data":
        out.append("needs-data")
    elif entry["published"] is not None and result["adapter"] is not None:
        out.append("reproduced" if not result["flags"] else "not-reproduced")
    return out


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> None:
    library = json.loads((HERE / "library.json").read_text())
    results = {r["id"]: r for r in json.loads((HERE / "results.json").read_text())["strategies"]}
    rows = []
    for entry in library["strategies"]:
        result = results[entry["id"]]
        description = describe(entry, result)
        if len(description) > 2000:
            raise SystemExit(f"{entry['id']} description has {len(description)} characters")
        status = "idea" if result["status"] == "no-data" else "backtested"
        values = [
            sql_text(f"strategy-seed-{entry['slug']}"),
            sql_text(entry["slug"]),
            sql_text(f"QuantJourney {entry['id']}: {entry['name']}"),
            sql_text(description),
            "'external'",
            sql_text(status),
            sql_text(SOURCE_REF),
            sql_text(json.dumps(tags(entry, result))) + "::jsonb",
            sql_text(entry["section"]),
            "'[]'::jsonb",
        ]
        rows.append("  (" + ", ".join(values) + ")")
    ids = ", ".join(sql_text(f"strategy-seed-{e['slug']}") for e in library["strategies"])
    MIGRATION.write_text(
        "-- Seed: the 50 QuantJourney Backtester example strategies listed on quants.md (card vertex-quantsmd,\n"
        "-- 2026-10-31). Inventory and re-run: docs/vertex-rebuild/quantjourney-library.md, built from\n"
        "-- research/backtests/quantjourney/library.json and results.json. Every row is research only; none is\n"
        "-- promoted to paper. Existing slugs are never overwritten.\n"
        'INSERT INTO "strategies" ("id", "slug", "name", "description", "kind", "status", "source_ref", "tags", '
        '"section", "params") VALUES\n'
        + ",\n".join(rows)
        + '\nON CONFLICT ("slug") DO NOTHING;\n'
    )
    ROLLBACK.write_text(
        "-- Guarded reversal of 0033_strategy_catalog_quantjourney only.\n"
        "-- Deletes the catalog rows only while none was edited, linked to a backtest or given a preset.\n"
        "-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.\n"
        "BEGIN;\n"
        "SET LOCAL search_path = pg_catalog, public;\n"
        "SET LOCAL row_security = off;\n"
        'LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE;\n'
        "DO $$\n"
        "BEGIN\n"
        "  IF EXISTS (\n"
        '    SELECT 1 FROM "public"."strategies" s\n'
        f'    WHERE s."id" IN ({ids})\n'
        "      AND (\n"
        '        s."updated_at" <> s."created_at"\n'
        '        OR EXISTS (SELECT 1 FROM "public"."strategy_presets" p WHERE p."strategy_id" = s."id")\n'
        '        OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."strategy_id" = s."id")\n'
        "      )\n"
        "  ) THEN\n"
        "    RAISE EXCEPTION 'catalog strategies have operator edits, presets or backtests; refusing rollback';\n"
        "  END IF;\n"
        "END\n"
        "$$;\n"
        f'DELETE FROM "public"."strategies" WHERE "id" IN ({ids});\n'
        "COMMIT;\n"
    )
    print(f"wrote {len(rows)} rows")


if __name__ == "__main__":
    main()
