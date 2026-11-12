"""Prints the go-live draft candidates of one trading day (research only: no orders, no broker, no network).

  python -m golive --data <qc-ports data dir> --chain-store <option-chain snapshot store> \\
      --trading-day YYYY-MM-DD < plan.json

Run in services/research. stdin: the plan document (GoLivePlanSchema of
packages/api/src/contracts/golive-drafts.ts). stdout: one JSON object in the shape of
GoLiveCollectInputSchema, and nothing else. Exit codes: 0 the document is printed (zero candidates
is a valid result); 1 refused, with the reason on stderr and nothing on stdout (stale data, an
unknown definition variant or run key, a plan that does not state its tested definition); 2 usage;
3 the day is not an NYSE trading day (nothing to collect).
"""
from __future__ import annotations

import argparse
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
        plan = json.loads(stdin.read())
        data = study.load_study_data(args.data.expanduser())
        document = generate(plan, data.dataset, data.facts, args.chain_store.expanduser(), args.trading_day, now)
    except NotTradingDayError as error:
        print(f"golive: {error}", file=stderr)
        return EXIT_NOT_TRADING_DAY
    except GoLiveError as error:
        print(f"golive: {error}", file=stderr)
        return EXIT_REFUSED
    except json.JSONDecodeError as error:
        print(f"golive: the plan on stdin is not JSON ({error})", file=stderr)
        return EXIT_REFUSED
    except OSError as error:
        print(f"golive: cannot read the data directory {args.data}: {error}", file=stderr)
        return EXIT_REFUSED
    stdout.write(json.dumps(document, allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
