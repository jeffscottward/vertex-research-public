"""Command line for the Nautilus backtest engine (research only; no orders, no network).

  python -m nautilus_backtest run <request.json|->        one run, result JSON on stdout
  python -m nautilus_backtest batch <in.json|-> <out.json|->  many runs on one bar series

request.json: {"bars": {"t": [...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...]?}, "spec": {...}}
in.json:      {"bars": {...}, "series": {...}?, "cases": [{"id": "...", "spec": {...}, "slice": [first, end]?}, ...]}
The spec is the plan_run spec of signals.py. A case with "slice" runs on bars[first:end] (its own
date range inside the shared series). "series" holds daily series store rows (id -> {dates, open,
high, low, close, adjClose}): a dsl case whose definition reads series gets them as its series
context (spec "context", the run symbol); a dsl case with an options block runs in the options
runner (strategies.qc_ports.portfolio.run_spec_json: ledger plus NautilusTrader parity) on those
rows instead of the bars. Output: RunResult.to_json() (options: the run_spec_json document), or
{"error": "..."} for an input error (exit status 2 for `run`; exit status 3 for both when
nautilus-trader is missing). A batch writes {"engine": ..., "results": [{"id": ..., "wallMs": ...,
"result": {...}} | {"id": ..., "wallMs": ..., "error": "..."}], "usage": {"cpuMs": ..., "wallMs":
...}}: the engine time of each case and the CPU time (user + system) and wall time of this process.
"""
from __future__ import annotations

import json
import resource
import sys
import time
from pathlib import Path

from .bars import Bars, InputError
from .engine import ENGINE_ID, NautilusUnavailable, run_spec
from .signals import normalize_definition, strategy_series_refs


def _load(path: str) -> dict:
    text = sys.stdin.read() if path == "-" else Path(path).read_text()
    return json.loads(text)


def _dump(value) -> str:
    # NaN never appears in results; allow_nan=False makes a regression fail loudly.
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def _run_case(bars: Bars, spec: dict, rows: dict | None) -> dict:
    """One case: the options runner for an options definition, else run_spec (with the series context
    when the definition reads series and rows are given)."""
    rule = spec.get("rule") or {}
    if rule.get("kind") == "dsl" and rule.get("definition", {}).get("options") is not None:
        from strategies.qc_ports.portfolio import run_spec_json

        if not rows:
            raise InputError("An options definition needs the daily series rows")
        try:
            return run_spec_json(spec, rows)
        except (ValueError, RuntimeError) as error:
            raise InputError(str(error)) from error
    if rule.get("kind") == "dsl" and rows and strategy_series_refs(normalize_definition(rule["definition"])):
        from strategies.qc_ports.portfolio import context_from_rows

        spec = {**spec, "context": context_from_rows(rows)}
    return run_spec(bars, spec).to_json()


def _batch_case(bars: Bars, case: dict, rows: dict | None = None) -> dict:
    """One batch case with its engine wall time; an input error is the case's result."""
    started = time.perf_counter()
    try:
        window = case.get("slice")
        own = bars if window is None else bars.window(int(window[0]), int(window[1]))
        outcome = {"result": _run_case(own, case["spec"], rows)}
    except InputError as error:
        outcome = {"error": str(error)}
    return {"id": case["id"], "wallMs": (time.perf_counter() - started) * 1000, **outcome}


def _usage(started: float) -> dict:
    """CPU time (user + system) and wall time of this process, in milliseconds."""
    own = resource.getrusage(resource.RUSAGE_SELF)
    return {"cpuMs": (own.ru_utime + own.ru_stime) * 1000, "wallMs": (time.perf_counter() - started) * 1000}


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "run" and len(argv) == 2:
        request = _load(argv[1])
        try:
            result = _run_case(Bars.from_columns(request["bars"]), request["spec"], request.get("series"))
        except InputError as error:
            print(_dump({"error": str(error)}))
            return 2
        except NautilusUnavailable as error:
            print(str(error), file=sys.stderr)
            return 3
        print(_dump(result))
        return 0
    if len(argv) == 3 and argv[0] == "batch":
        started = time.perf_counter()
        request = _load(argv[1])
        bars = Bars.from_columns(request["bars"])
        results = []
        try:
            for case in request["cases"]:
                results.append(_batch_case(bars, case, request.get("series")))
        except NautilusUnavailable as error:
            print(str(error), file=sys.stderr)
            return 3
        text = _dump({"engine": ENGINE_ID, "results": results, "usage": _usage(started)})
        if argv[2] == "-":
            print(text)
            return 0
        tmp = Path(argv[2] + ".tmp")
        tmp.write_text(text)
        tmp.replace(argv[2])
        return 0
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
