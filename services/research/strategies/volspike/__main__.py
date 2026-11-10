"""Volume spike breakout study commands (research only, no orders).

    python -m strategies.volspike definition
        # the nearest DSL definition (long and short legs) as JSON
    python -m strategies.volspike study --ran 2026-11-09 [--workers 4]
        # the whole study; prints the strategy-backtest study document (progress on stderr)
    python -m strategies.volspike report-data --ran 2026-11-09 [--out DIR] [--workers 4]
        # the same run; writes DIR/report-data.json (detail for the report) and DIR/study.json (the document)

Pre-registered design: docs/specs/strategies/volume-spike-breakout.md. Data: the Dukascopy files fetched by
research/backtests/volspike/fetch_data.py (VERTEX_VOLSPIKE_DATA_ROOT), the ETF twin files of the
market-intraday-momentum study (VERTEX_IMOM_DATA) and the qc-ports daily files (VERTEX_QC_PORTS_DATA).

Memory: at most 4 worker processes by default, and the run refuses to start when less than 8 GB of memory is
available (VERTEX_VOLSPIKE_MIN_FREE_GB changes the floor; 0 turns the check off). On the rig run it inside a
memory cap, for example `systemd-run --user --wait --collect --pipe -p MemoryMax=12G -p MemorySwapMax=0 ...`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .definition import all_definitions

DEFAULT_OUT = Path.home() / "Documents" / "reports" / "web" / "vertex-volume-spike" / "results"
MIN_FREE_ENV = "VERTEX_VOLSPIKE_MIN_FREE_GB"
MIN_FREE_GB = 8.0
MAX_WORKERS = 4


def available_gb(meminfo: str = "/proc/meminfo") -> float | None:
    """MemAvailable in GB, or None where the kernel does not report it."""
    try:
        with open(meminfo) as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1024 / 1024
    except OSError:
        return None
    return None


def require_memory() -> None:
    floor = float(os.environ.get(MIN_FREE_ENV, MIN_FREE_GB))
    free = available_gb()
    if floor > 0 and free is not None and free < floor:
        raise SystemExit(f"Only {free:.1f} GB of memory is available; the study needs {floor:g} GB free "
                         f"(set {MIN_FREE_ENV} to change the floor)")


def workers_of(text: str) -> int:
    value = int(text)
    if not 1 <= value <= MAX_WORKERS:
        raise argparse.ArgumentTypeError(f"--workers must be from 1 to {MAX_WORKERS} (memory bound of the rig)")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m strategies.volspike")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("definition")
    study = sub.add_parser("study")
    report = sub.add_parser("report-data")
    for command in (study, report):
        command.add_argument("--ran", required=True)
        command.add_argument("--workers", type=workers_of, default=MAX_WORKERS)
    report.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)
    if args.command == "definition":
        print(json.dumps(all_definitions(), indent=2))
        return 0
    require_memory()
    from .study import main_report, main_study

    if args.command == "study":
        return main_study(args.ran, args.workers)
    return main_report(args.ran, Path(args.out), args.workers)


if __name__ == "__main__":
    sys.exit(main())
