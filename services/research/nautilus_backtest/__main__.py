"""Command line for the Nautilus backtest engine (research only; no orders, no network).

  python -m nautilus_backtest run <request.json|->        one run, result JSON on stdout
  python -m nautilus_backtest batch <in.json|-> <out.json|->  many runs on one bar series
  python -m nautilus_backtest academy <request.json|->    one Academy options run, result JSON on stdout

request.json: {"bars": {"t": [...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...]?}, "spec": {...}}
in.json:      {"bars": {...}, "series": {...}?, "cases": [{"id": "...", "spec": {...}, "slice": [first, end]?}, ...]}
The spec is the plan_run spec of signals.py. A case with "slice" runs on bars[first:end] (its own
date range inside the shared series). "series" holds daily series store rows (id -> {dates, open,
high, low, close, adjClose}): a dsl case whose definition reads series gets them as its series
context (spec "context", the run symbol); a dsl case with an options block runs in the options
runner (strategies.qc_ports.portfolio.run_spec_json: ledger plus NautilusTrader parity) on those
rows instead of the bars. Output: RunResult.to_json() (options: the run_spec_json document), or
{"error": "..."} for an input error (exit status 2 for `run`; exit status 3 for both when
nautilus-trader is missing). A spec with rule {"kind": "academy", "structure": ..., "rules": {...},
"iv": [...]?} runs the Academy modelled options backtest (academy/engine.py) on the closes with
spec "initialCapital" as the capital and returns it in the same result shape (academy/result.py);
"iv" holds one implied volatility (or null) per bar of the case. The `academy` command takes
{"bars": {"t": [...], "c": [...], "iv": [...]?}, "structure": ..., "rules": {...}, "capital": n}
and prints the full Academy result (the TypeScript `BacktestResult` fields; equity as one number
per bar from "firstIndex"). A batch writes {"engine": ..., "results": [entry, ...], "usage": {"cpuMs":
..., "wallMs": ...}}: the engine time of each case and the CPU time (user + system) and wall time of
this process. Each entry is {"id": ..., "wallMs": ...} with exactly one of:

  "result": {...}   the case ran
  "error": "..."    an input error (InputError): the request is at fault
  "crash": "..."    a case crash: any other Exception of the case, also a result that JSON cannot
                    hold; the text is "<class name>: <message>" on one line, at most 300 characters
                    (the options route still turns ValueError and RuntimeError into input errors)

Exit status of `batch`:

  0   the document is complete; no case crashed
  4   the document is complete; at least one entry is a crash (on stderr: the traceback of the first
      3 crashes and one line `case <id as JSON> crashed: <crash text>` per crash, for diagnosis
      only). The status is returned after the document was written.
  3   nautilus-trader is missing; no document
  1   any other fault ends the batch without a document: the bars or the case list cannot be read
      (`cases` must be a list of objects with a string id), ImportError, MemoryError, an exception
      that is not an Exception (KeyboardInterrupt, a Rust panic of the engine, a case that calls
      exit())
  a signal, or none: the process was killed, aborted natively or timed out; no document

A reader takes status 0 or 4 as a complete document and decides each case by its key (`crash` before
`result`); every other status is a process failure.
"""
from __future__ import annotations

import json
import resource
import sys
import time
import traceback
from collections.abc import Mapping
from datetime import UTC, datetime
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
    if rule.get("kind") == "academy":
        return _run_academy_case(bars, spec, rule)
    definition = rule.get("definition")
    # A definition that is not an object goes on to normalize_definition, which refuses it.
    if rule.get("kind") == "dsl" and isinstance(definition, Mapping) and definition.get("options") is not None:
        from strategies.qc_ports.portfolio import run_spec_json

        if not rows:
            raise InputError("An options definition needs the daily series rows")
        try:
            return run_spec_json(spec, rows)
        except (ValueError, RuntimeError) as error:
            raise InputError(str(error)) from error
    if rule.get("kind") == "dsl" and rows and strategy_series_refs(normalize_definition(definition)):
        from strategies.qc_ports.portfolio import context_from_rows

        last = spec.get("to") or _bar_date(bars.t[-1])
        spec = {**spec, "context": context_from_rows(_rows_until(rows, last))}
    return run_spec(bars, spec).to_json()


def _run_academy_case(bars: Bars, spec: dict, rule: dict) -> dict:
    """An Academy rule: the modelled options backtest on the closes, in the engine result shape."""
    from .academy.engine import ACADEMY_MODEL_VERSION, run_academy
    from .academy.result import engine_result
    from .academy.simulator import AcademyInput

    iv = rule.get("iv")
    if iv is not None and (not isinstance(iv, list) or len(iv) != len(bars.t)):
        raise InputError("rule.iv must hold one value per bar")
    data = AcademyInput.from_json({
        "bars": {"t": list(bars.t), "c": list(bars.c), "iv": iv}, "structure": rule.get("structure"),
        "rules": rule.get("rules"), "capital": spec.get("initialCapital")})
    mapped = engine_result(run_academy(data), data)
    return {"engine": ENGINE_ID, "modelVersion": ACADEMY_MODEL_VERSION, "capital": data.capital, **mapped}


def _bar_date(t: float) -> str:
    """YYYY-MM-DD (UTC) of a bar time in ms."""
    return datetime.fromtimestamp(t / 1000, tz=UTC).date().isoformat()


def _rows_until(rows: dict, last: str) -> dict:
    """Store rows cut at `last` (inclusive): a case of a batch reads only rows up to its own `to`,
    as the run alone does with its claim rows (the batch holds the rows up to the latest run end)."""
    cut = {}
    for series_id, row in rows.items():
        keep = sum(1 for day in row["dates"] if day <= last)
        cut[series_id] = {key: list(values)[:keep] for key, values in row.items()}
    return cut


CRASH_STATUS = 4
CRASH_TEXT_MAX = 300
FULL_TRACEBACKS = 3
# Faults of the process, not of one case: they end the batch (NautilusUnavailable is a RuntimeError).
_BATCH_FAULTS = (NautilusUnavailable, ImportError, MemoryError)


def _crash_text(error: BaseException) -> str:
    """`<type>: <message>` on one line, at most CRASH_TEXT_MAX characters; the type alone without a message."""
    try:
        message = " ".join(str(error).split())
    except Exception:  # noqa: BLE001 - an unreadable message is left out
        message = ""
    name = type(error).__name__
    return (f"{name}: {message}" if message else name)[:CRASH_TEXT_MAX]


def _report_crash(case_id: str, text: str, crashes: int) -> None:
    """Stderr for one crashed case: the traceback of the exception being handled (first FULL_TRACEBACKS
    crashes of the process only), then one `case <id> crashed: <text>` line."""
    if crashes < FULL_TRACEBACKS:
        traceback.print_exc(file=sys.stderr)
    print(f"case {json.dumps(case_id)} crashed: {text}", file=sys.stderr)


def _batch_case(bars: Bars, case: dict, rows: dict | None = None, crashes: int = 0) -> dict:
    """One batch case with its engine wall time. An input error is the case's `error`; any other
    exception of the case is its `crash` (`crashes` = crashes of the process so far, for stderr)."""
    started = time.perf_counter()
    try:
        window = case.get("slice")
        own = bars if window is None else bars.window(int(window[0]), int(window[1]))
        outcome = {"result": _run_case(own, case["spec"], rows)}
    except InputError as error:
        outcome = {"error": str(error)}
    except _BATCH_FAULTS:
        raise
    except Exception as error:  # noqa: BLE001 - the case guard records every Exception
        outcome = {"crash": _crash_text(error)}
        _report_crash(case["id"], outcome["crash"], crashes)
    return {"id": case["id"], "wallMs": (time.perf_counter() - started) * 1000, **outcome}


def _entry_text(entry: dict, crashes: int) -> tuple[str, bool]:
    """The JSON text of one entry and whether it is a crash. A result that JSON cannot hold (NaN,
    an unknown type) is a crash too."""
    try:
        return _dump(entry), "crash" in entry
    except MemoryError:
        raise
    except Exception as error:  # noqa: BLE001 - the case guard records every Exception
        text = _crash_text(error)
        _report_crash(entry["id"], text, crashes)
        return _dump({"id": entry["id"], "wallMs": entry["wallMs"], "crash": text}), True


def _cases(request: dict) -> list:
    """The case list, checked before the first case runs: a list of objects with a string id."""
    cases = request["cases"]
    if not isinstance(cases, list) or not all(
            isinstance(case, Mapping) and isinstance(case.get("id"), str) for case in cases):
        raise ValueError("cases must be a list of objects with a string id")
    return cases


def _run_batch(request: dict, started: float) -> tuple[str, int]:
    """The batch document and its exit status. The document is joined from the entry texts: the same
    bytes as one _dump of the whole document, and no result is serialized twice."""
    bars = Bars.from_columns(request["bars"])
    entries = []
    crashes = 0
    for case in _cases(request):
        entry = _batch_case(bars, case, request.get("series"), crashes)
        text, crashed = _entry_text(entry, crashes)
        entries.append(text)
        crashes += crashed
    document = f'{{"engine":{_dump(ENGINE_ID)},"results":[{",".join(entries)}],"usage":{_dump(_usage(started))}}}'
    return document, CRASH_STATUS if crashes else 0


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
    if len(argv) == 2 and argv[0] == "academy":
        from .academy.engine import run_academy
        from .academy.simulator import AcademyInput

        try:
            result = run_academy(AcademyInput.from_json(_load(argv[1])))
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
        try:
            text, status = _run_batch(request, started)
        except NautilusUnavailable as error:
            print(str(error), file=sys.stderr)
            return 3
        except SystemExit as error:
            # A case that calls exit() must not end with a batch status (0 or 4) but no document.
            print(f"a case called exit({error.code!r}); no document", file=sys.stderr)
            return 1
        if argv[2] == "-":
            print(text)
            return status
        tmp = Path(argv[2] + ".tmp")
        tmp.write_text(text)
        tmp.replace(argv[2])
        return status
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
