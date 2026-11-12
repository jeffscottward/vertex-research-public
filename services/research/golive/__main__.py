"""Prints the go-live draft candidates of one trading day (research only: no orders, no broker, no network).

  python -m golive --data <qc-ports data dir> --chain-store <option-chain snapshot store> \\
      --trading-day YYYY-MM-DD < plan.json

Run in services/research. stdin: the plan document (GoLivePlanSchema of
packages/api/src/contracts/golive-drafts.ts). stdout: one JSON object in the shape of
GoLiveCollectInputSchema, and nothing else.

Exit codes (scripts/golive/collect.ts reads them; do not renumber):
  0  the document is printed: every check passed. Zero candidates then means the model wants
     nothing. stderr is empty.
  1  refused: the reason on stderr (every line starts with "golive: "), nothing on stdout. Data
     that is not usable (the bars, or a series a sleeve reads, have no value of the trading day
     before the trading day, or of an older day the tested data has a value for), a chain store
     that cannot be read, a candidate without listed strikes, a candidate that breaks an output
     rule, an unknown definition variant or run key, a plan that does not state its tested
     definition, a plan that is not JSON, a data directory that cannot be read. An error nobody
     foresaw also ends with 1 (the Python traceback on stderr, nothing on stdout).
  2  usage (argparse), nothing on stdout.
  3  the day is not an NYSE trading day: nothing to collect, nothing on stdout.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from strategies.qc_ports import study

from .generator import GoLiveError, NotTradingDayError, generate

EXIT_REFUSED = 1
EXIT_NOT_TRADING_DAY = 3


def main(argv=None, stdin=None, stdout=None, stderr=None) -> int:
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    parser = argparse.ArgumentParser(prog="python -m golive", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, type=Path, help="qc-ports data directory (read only)")
    parser.add_argument("--chain-store", required=True, type=Path, help="option-chain snapshot store (read only)")
    parser.add_argument("--trading-day", required=True, help="YYYY-MM-DD; the data must end the trading day before")
    parser.add_argument("--now", type=datetime.fromisoformat, default=None,
                        help="ISO time (UTC when it has no offset): quotes come from the newest snapshot at or before "
                             "it. Default: the current time")
    args = parser.parse_args(argv)
    now = args.now or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    try:
        # stdout carries the document and nothing else: a print of the code below goes to stderr.
        with contextlib.redirect_stdout(stderr):
            plan = json.loads(stdin.read())
            try:
                data = study.load_study_data(args.data.expanduser())
            except OSError as error:
                raise GoLiveError(f"cannot read the data directory {args.data}: {error}") from None
            document = generate(plan, data.dataset, data.facts, args.chain_store.expanduser(), args.trading_day, now)
            text = json.dumps(document, allow_nan=False)
    except NotTradingDayError as error:
        return _refuse(stderr, str(error), EXIT_NOT_TRADING_DAY)
    except GoLiveError as error:
        return _refuse(stderr, str(error), EXIT_REFUSED)
    except json.JSONDecodeError as error:
        return _refuse(stderr, f"the plan on stdin is not JSON ({error})", EXIT_REFUSED)
    stdout.write(text + "\n")
    return 0


def _refuse(stderr, message: str, code: int) -> int:
    """Writes the reason to stderr, every line with the "golive: " prefix, and returns the exit code."""
    for line in message.splitlines() or [""]:
        print(f"golive: {line}", file=stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
