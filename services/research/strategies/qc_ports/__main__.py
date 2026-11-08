"""Smoke run of the qc-ports options runner on the public data (research only).

    python -m strategies.qc_ports smoke [--symbol SPY] [--start 2007-01-01] [--nautilus]

Strategy: a monthly call debit vertical. The entry signal is the close of the
last trading day of each month (so the spread opens at the next close), with no
signal exit; the trade closes at +50% of the debit, at 7 DTE or at expiration.
Prints the metrics (and the ledger-vs-Nautilus equity gap with --nautilus); it
writes no files.
"""
from __future__ import annotations

import argparse
import json
import sys

from .book import SignalEvent, build_book
from .data import load_market
from .ledger import run_ledger
from .metrics import summarize

SMOKE_OPTIONS = {
    "structure": "callDebitVertical", "dte": {"target": 45, "min": 30}, "longDelta": 0.5, "widthSigma": 0.5,
    "profitTakePct": 50, "exitDte": 7, "maxLossPct": 2,
}


def monthly_events(symbol: str, dates, start: str) -> list[SignalEvent]:
    """Entry signal on the last bar of every month from `start` (the last bar of the data excluded)."""
    return [SignalEvent(symbol, index) for index in range(len(dates) - 1)
            if dates[index] >= start and dates[index][:7] != dates[index + 1][:7]]


def smoke(symbol: str, start: str, nautilus: bool, root=None) -> dict:
    market = load_market(symbol, root)
    events = monthly_events(symbol, market.dates, start)
    book = build_book(events, SMOKE_OPTIONS, {symbol: market})
    first = next(index for index, day in enumerate(market.dates) if day >= start)
    dates = market.dates[first:]
    result = run_ledger(book.trades, dates=dates)
    report = {"symbol": symbol, "options": SMOKE_OPTIONS, "events": len(events),
              "bookSkipped": len(book.skipped), "metrics": summarize(result, n_trials=1)}
    if nautilus:
        from .nautilus_runner import run_nautilus

        other = run_nautilus(book.trades, dates=dates)
        report["nautilusMaxRelGap"] = max(abs(a - b) / max(abs(a), abs(b))
                                          for a, b in zip(result.equity, other.equity, strict=True))
        report["nautilusTradesMatch"] = [(t["id"], t["contracts"]) for t in result.trades] == [
            (t["id"], t["contracts"]) for t in other.trades]
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m strategies.qc_ports")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("smoke", help="monthly call debit vertical on the public data")
    run.add_argument("--symbol", default="SPY")
    run.add_argument("--start", default="2007-01-01")
    run.add_argument("--nautilus", action="store_true")
    args = parser.parse_args(argv)
    report = smoke(args.symbol, args.start, args.nautilus)
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
