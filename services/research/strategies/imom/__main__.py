"""Market intraday momentum reel study commands (research only).

    python -m strategies.imom definition                     # the stated rules as DSL legs (JSON)
    python -m strategies.imom study --ran 2026-11-08 [--workers 8] [--detail PATH]

study: every Nautilus run of the pre-registered study (docs/specs/strategies/market-intraday-momentum.md) on
the Dukascopy 1-minute data (VERTEX_IMOM_DATA) and the qc-ports option data. Prints the strategy-backtest
study document (the input of `bun run vertex:research-studies:import`); progress goes to stderr. With
--detail it also writes the full detail (all runs, daily equity and drawdown of the primary, per-market
tables) to PATH (outside the repository, for the report).
"""
from __future__ import annotations

import argparse
import json
import sys

from .definition import all_definitions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m strategies.imom")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("definition")
    study = sub.add_parser("study")
    study.add_argument("--ran", required=True)
    study.add_argument("--workers", type=int, default=8)
    study.add_argument("--detail")
    args = parser.parse_args(argv)
    if args.command == "definition":
        print(json.dumps(all_definitions(), indent=2))
        return 0
    from .study import main_study

    return main_study(args.ran, args.workers, args.detail)


if __name__ == "__main__":
    sys.exit(main())
