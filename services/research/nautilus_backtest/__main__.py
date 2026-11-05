"""Command line for the Nautilus backtest engine (research only; no orders, no network).

  python -m nautilus_backtest run <request.json|->        one run, result JSON on stdout
  python -m nautilus_backtest batch <in.json> <out.json>  many runs on one bar series

request.json: {"bars": {"t": [...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...]?}, "spec": {...}}
in.json:      {"bars": {...}, "cases": [{"id": "...", "spec": {...}}, ...]}
The spec is the plan_run spec of signals.py. Output: RunResult.to_json(), or
{"error": "..."} for an input error (exit status 2 for `run`). A batch writes
{"engine": ..., "results": [{"id": ..., "result": {...}} | {"id": ..., "error": "..."}]}.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .bars import Bars, InputError
from .engine import ENGINE_ID, NautilusUnavailable, run_spec


def _load(path: str) -> dict:
    text = sys.stdin.read() if path == "-" else Path(path).read_text()
    return json.loads(text)


def _dump(value) -> str:
    # NaN never appears in results; allow_nan=False makes a regression fail loudly.
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


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
        request = _load(argv[1])
        bars = Bars.from_columns(request["bars"])
        results = []
        for case in request["cases"]:
            try:
                results.append({"id": case["id"], "result": run_spec(bars, case["spec"]).to_json()})
            except InputError as error:
                results.append({"id": case["id"], "error": str(error)})
        tmp = Path(argv[2] + ".tmp")
        tmp.write_text(_dump({"engine": ENGINE_ID, "results": results}))
        tmp.replace(argv[2])
        return 0
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
