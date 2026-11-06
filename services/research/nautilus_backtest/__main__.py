"""Command line for the Nautilus backtest engine (research only; no orders, no network).

  python -m nautilus_backtest run <request.json|->        one run, result JSON on stdout
  python -m nautilus_backtest batch <in.json|-> <out.json|->  many runs on one bar series

request.json: {"bars": {"t": [...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...]?}, "spec": {...}}
in.json:      {"bars": {...}, "cases": [{"id": "...", "spec": {...}, "slice": [first, end]?}, ...]}
The spec is the plan_run spec of signals.py. A case with "slice" runs on bars[first:end] (its own
date range inside the shared series). Output: RunResult.to_json(), or {"error": "..."} for an input
error (exit status 2 for `run`; exit status 3 for both when nautilus-trader is missing). A batch
writes {"engine": ..., "results": [{"id": ..., "wallMs": ..., "result": {...}} |
{"id": ..., "wallMs": ..., "error": "..."}], "usage": {"cpuMs": ..., "wallMs": ...}}: the engine
time of each case and the CPU time (user + system) and wall time of this process.
"""
from __future__ import annotations

import json
import resource
import sys
import time
from pathlib import Path

from .bars import Bars, InputError
from .engine import ENGINE_ID, NautilusUnavailable, run_spec


def _load(path: str) -> dict:
    text = sys.stdin.read() if path == "-" else Path(path).read_text()
    return json.loads(text)


def _dump(value) -> str:
    # NaN never appears in results; allow_nan=False makes a regression fail loudly.
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def _batch_case(bars: Bars, case: dict) -> dict:
    """One batch case with its engine wall time; an input error is the case's result."""
    started = time.perf_counter()
    try:
        window = case.get("slice")
        own = bars if window is None else bars.window(int(window[0]), int(window[1]))
        outcome = {"result": run_spec(own, case["spec"]).to_json()}
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
            result = run_spec(Bars.from_columns(request["bars"]), request["spec"])
        except InputError as error:
            print(_dump({"error": str(error)}))
            return 2
        except NautilusUnavailable as error:
            print(str(error), file=sys.stderr)
            return 3
        print(_dump(result.to_json()))
        return 0
    if len(argv) == 3 and argv[0] == "batch":
        started = time.perf_counter()
        request = _load(argv[1])
        bars = Bars.from_columns(request["bars"])
        results = []
        try:
            for case in request["cases"]:
                results.append(_batch_case(bars, case))
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
