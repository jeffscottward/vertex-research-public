"""qc-ports options runner commands on the public data (research only).

    python -m strategies.qc_ports smoke [--symbol SPY] [--start 2007-01-01] [--nautilus]
    python -m strategies.qc_ports study --ran 2026-11-08 [--no-nautilus] [--report]
    python -m strategies.qc_ports audit
    python -m strategies.qc_ports definitions

smoke: a monthly call debit vertical. The entry signal is the close of the
last trading day of each month (so the spread opens at the next close), with no
signal exit; the trade closes at +50% of the debit, at 7 DTE or at expiration.
Prints the metrics (and the ledger-vs-Nautilus equity gap with --nautilus).

study: the 32 pre-registered runs of the 11 QuantConnect idea ports
(study.py). Prints one JSON document per idea (JSON lines, the input of
`bun run vertex:research-studies:import`), or with --report the markdown
Results of each spec. Progress goes to stderr.

audit: the sanity checks of the study (audit.py): gross vs net, costs, failing
clauses, an IV/skew sensitivity, known-edge cases and priced-trade checks, as
markdown per idea. No command writes files.
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
    study_parser = sub.add_parser("study", help="the 32 pre-registered runs; one JSON document per idea")
    study_parser.add_argument("--ran", required=True, help="run date, YYYY-MM-DD")
    study_parser.add_argument("--no-nautilus", action="store_true", help="skip the Nautilus parity run")
    study_parser.add_argument("--report", action="store_true", help="print the markdown Results instead")
    sub.add_parser("audit", help="sanity checks of the study (markdown per idea)")
    sub.add_parser("definitions", help="run A of each idea: its DSL definition and start date (JSON)")
    args = parser.parse_args(argv)
    if args.command == "definitions":
        json.dump(definitions(), sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    if args.command == "audit":
        from . import audit, study

        blocks = audit.markdown(audit.audit(study.load_study_data()))
        for idea_id, block in blocks.items():
            sys.stdout.write(f"## {idea_id}\n\n{block}\n\n")
        return 0
    if args.command == "study":
        return _study(args.ran, not args.no_nautilus, args.report)
    report = smoke(args.symbol, args.start, args.nautilus)
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def definitions() -> dict:
    """Idea id -> {run, start, definition} of each idea's run A on the data files (the stored definitions)."""
    from . import ideas, study

    runs = ideas.family(study.load_study_data().facts)
    return {idea.id: {"run": idea.key("A"), "start": runs[idea.key("A")].start,
                      "definition": runs[idea.key("A")].definition} for idea in ideas.IDEAS}


def _study(ran: str, nautilus: bool, markdown: bool) -> int:
    from . import ideas, study

    data = study.load_study_data()
    docs, outcomes, metrics, variance = study.documents(
        data, ran, nautilus, progress=lambda key: print(f"ran {key}", file=sys.stderr, flush=True))
    for idea, doc in zip(ideas.IDEAS, docs, strict=True):
        if markdown:
            sys.stdout.write(f"## {idea.id}\n\n")
            sys.stdout.write(study.report(idea, doc, outcomes, metrics, variance, data, nautilus) + "\n\n")
        else:
            sys.stdout.write(json.dumps(doc, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
