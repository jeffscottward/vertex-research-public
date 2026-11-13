"""Leveraged ETF short-window study commands (research only, no orders).

    python -m strategies.leveraged_etf study --results <results.json> --ran <YYYY-MM-DD>
        # prints ONE research_studies document (kind strategy-backtest, id leveraged-etf-short-window)
        # built from the results document of research/backtests/leveraged-etf/run.py
    python -m strategies.leveraged_etf tables --results <results.json>
        # prints the results tables (the text of results.md) of the same results document

Each command reads one file and prints text. It imports nothing into a database. A study document that
does not fit the contract limits is not printed: the problems go to stderr and the exit code is 1.
Method: research/backtests/leveraged-etf/README.md.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path


def ran_date(text: str) -> str:
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"--ran must be a date YYYY-MM-DD: {error}") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m strategies.leveraged_etf")
    sub = parser.add_subparsers(dest="command", required=True)
    study = sub.add_parser("study")
    study.add_argument("--results", required=True, type=Path)
    study.add_argument("--ran", required=True, type=ran_date)
    tables = sub.add_parser("tables")
    tables.add_argument("--results", required=True, type=Path)
    args = parser.parse_args(argv)
    results = json.loads(args.results.expanduser().read_text())
    if args.command == "tables":
        from .report import results_markdown

        print(results_markdown(results))
        return 0
    from .study import document, validate

    try:
        doc = document(results, args.ran)
    except ValueError as error:
        print(f"No study document: {error}", file=sys.stderr)
        return 1
    problems = validate(doc)
    if problems:
        print("The study document does not fit the contract:\n" + "\n".join(problems), file=sys.stderr)
        return 1
    print(json.dumps(doc, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
