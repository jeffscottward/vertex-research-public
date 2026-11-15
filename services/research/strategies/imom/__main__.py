"""Market intraday momentum reel study commands (research only).

    python -m strategies.imom definition                     # the stated rules as DSL legs (JSON)
    python -m strategies.imom study --ran 2026-11-08 [--workers 8] [--detail PATH] [--source ibkr|dukascopy]
        [--compare-row NAME=SHARPE,CAGR,MAXDD ...]
    python -m strategies.imom zab --ran 2026-11-10 [--markets SPY,QQQ,IWM,DIA] [--workers 8] [--detail PATH]

study: every Nautilus run of the pre-registered study (docs/specs/strategies/market-intraday-momentum.md) on
the IBKR 5-minute bars (VERTEX_IMOM_IBKR_DATA, default ~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m;
`--source ibkr`, the Vertex intraday default since 2026-11-09, docs/vertex-rebuild/data-sources/intraday.md;
primary GHLZ on SPY, run id imom-ibkr-<date>) or the Dukascopy 1-minute data (VERTEX_IMOM_DATA; `--source
dukascopy`, the original run) and the qc-ports option data. `--compare-row "GHLZ US500=0.31,0.012,-0.21"`
(repeatable) adds a Dukascopy headline row to the comparison, labelled '(Dukascopy, CFD costs)'. Prints the strategy-backtest
study document (the input of `bun run vertex:research-studies:import`); progress goes to stderr. With
--detail it also writes the full detail (all runs, daily equity and drawdown of the primary, per-market
tables) to PATH (outside the repository, for the report).

zab: the pre-registered ZAB study (docs/specs/strategies/zab-intraday-momentum.md) on the IBKR ETFs; see zab_study.py.
"""
from __future__ import annotations

import argparse
import json
import sys

from .data import DEFAULT_SOURCE, SOURCES
from .definition import all_definitions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m strategies.imom")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("definition")
    study = sub.add_parser("study")
    study.add_argument("--ran", required=True)
    study.add_argument("--workers", type=int, default=8)
    study.add_argument("--detail")
    study.add_argument("--source", choices=SOURCES, default=DEFAULT_SOURCE)
    study.add_argument("--compare-row", action="append", default=[], metavar="NAME=SHARPE,CAGR,MAXDD",
                       help="a Dukascopy headline row for the comparison, labelled '(Dukascopy, CFD costs)'")
    zab = sub.add_parser("zab")
    zab.add_argument("--ran", required=True)
    zab.add_argument("--markets", help="comma list; leaving out QQQ, IWM or DIA gives verdict 'incomplete' (smoke run)")
    zab.add_argument("--workers", type=int, default=8)
    zab.add_argument("--detail")
    args = parser.parse_args(argv)
    if args.command == "definition":
        print(json.dumps(all_definitions(), indent=2))
        return 0
    if args.command == "zab":
        from .zab_study import main as main_zab

        return main_zab(args.ran, args.markets, args.workers, args.detail)
    from .study import main_study

    return main_study(args.ran, args.workers, args.detail, args.source, args.compare_row)


if __name__ == "__main__":
    sys.exit(main())
