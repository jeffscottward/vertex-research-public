"""Print the compact filter-study document that the /backtests page shows.

Reads the raw outputs of adx_filter_run and rvol_intraday and keeps only display values, rounded.
The document goes to stdout; pipe it into the import CLI, which checks it and stores it in Postgres
(research_studies, read by researchStudies.get). Research only: reads local files, writes stdout.

Usage (from the repository root):
  (cd services/research && python -m strategies.filter_study_summary \
      --daily <adx_filter_run output> --intraday <rvol_intraday output> --ran 2026-10-31) \
    | DATABASE_URL=postgres://... bun run vertex:research-studies:import
Add --out <path> to also keep a local copy for inspection; the app never reads it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _round(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(value, digits)


def _variant(full: dict, halves: list[dict], trades_per_year: float) -> dict:
    return {
        "sharpe": _round(full["sharpe"]),
        "sharpeHalves": [_round(half["sharpe"]) for half in halves],
        "cagr": _round(full["cagr"]),
        "maxDrawdown": _round(full["max_drawdown"]),
        "trades": full["trades"],
        "tradesPerYear": _round(trades_per_year, 2),
    }


def summarize(daily: dict, intraday: dict, ran: str) -> dict:
    verdicts = {(item["strategy"], item["filter"]): item["verdict"] for item in daily["decisions"]}
    variants = []
    for row in daily["variants"]:
        deflated = row["deflated"]
        variants.append({
            "strategy": row["strategy"],
            "filter": row["filter"],
            **_variant(row["full"], row["halves"], row["tradesPerYear"]),
            "deflatedProbability": None if deflated is None else _round(deflated["probability"]),
            "verdict": verdicts.get((row["strategy"], row["filter"])),
        })
    primary = intraday["primary1bp"]
    return {
        "id": "adx-rvol-filters",
        "spec": "docs/specs/research/adx-filter.md",
        "ran": ran,
        "daily": {
            "window": daily["window"],
            "universe": daily["data"]["universe"],
            "costBpsPerSide": 5,
            "trials": daily["trials"],
            "variants": variants,
        },
        "intraday": {
            "symbol": "SPY",
            "barMinutes": 5,
            "window": {
                "start": intraday["firstSession"],
                "end": intraday["lastSession"],
                "sessions": intraday["sessions"],
                "secondHalfStart": intraday["secondHalfStart"],
            },
            "costBpsPerSide": 1,
            "variants": [
                {
                    "filter": name,
                    **_variant(primary[name]["full"], [primary[name]["firstHalf"], primary[name]["secondHalf"]],
                               primary[name]["tradesPerYear"]),
                }
                for name in ("none", "rvol_above_1")
            ],
            "verdict": primary["verdict"],
            "sensitivity": {"costBpsPerSide": 5, "verdict": intraday["sensitivity5bp"]["verdict"]},
            "spearman": {
                half: _round(intraday["spearmanRvolVsAbsMove"][half]) for half in ("firstHalf", "secondHalf")
            },
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--daily", required=True)
    parser.add_argument("--intraday", required=True)
    parser.add_argument("--ran", required=True)
    parser.add_argument("--out", help="also write the document to this path (local inspection only)")
    args = parser.parse_args()
    daily = json.loads(Path(args.daily).expanduser().read_text())
    intraday = json.loads(Path(args.intraday).expanduser().read_text())
    document = json.dumps(summarize(daily, intraday, args.ran), indent=2) + "\n"
    if args.out:
        Path(args.out).expanduser().write_text(document)
    sys.stdout.write(document)


if __name__ == "__main__":
    main()
