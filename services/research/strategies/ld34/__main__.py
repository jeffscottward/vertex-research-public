"""LD34 reel study commands (research only).

    python -m strategies.ld34 definition            # the stated rules as a DSL definition (JSON)
    python -m strategies.ld34 study --ran 2026-11-08 [--workers 8] [--artifacts DIR]

study: every Nautilus run of the pre-registered study (docs/specs/strategies/
ld34-nested-donchian-breakout.md) on the Dukascopy H1 data (VERTEX_LD34_DATA)
and the qc-ports option data. Prints one JSON line {"id", "summary"} (the input
of `bun run vertex:research-studies:import`); progress goes to stderr. With
--artifacts it also writes the daily curves for the report into DIR (outside
the repository).
"""
from __future__ import annotations

import argparse
import json
import sys

from .definition import BASE, definition


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m strategies.ld34")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("definition")
    study = sub.add_parser("study")
    study.add_argument("--ran", required=True)
    study.add_argument("--workers", type=int, default=8)
    study.add_argument("--artifacts")
    args = parser.parse_args(argv)
    if args.command == "definition":
        print(json.dumps(definition(BASE), indent=2))
        return 0
    from .study import main_study

    return main_study(args.ran, args.workers, args.artifacts)


if __name__ == "__main__":
    sys.exit(main())
