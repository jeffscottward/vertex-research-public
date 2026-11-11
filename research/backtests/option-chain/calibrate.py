"""Proposed option-model constants from the daily chain snapshots of snapshot.py (research only).

Reads every <store>/<day>/<run>/summary.json. One day counts once per symbol: the latest run of the day
that has quotes for the symbol. Per symbol and day:
- half-spread: mean over the four reference legs and the expiries, as a fraction of the mid;
- call slope and put slope: mean over the expiries (IV change per standardized-moneyness unit).
Across the days the script reports the median and the 25th and 75th percentile. The proposal is the
median. It is ready when every symbol has MIN_DAYS days (20 trading days = 4 weeks); before that the
report says "not ready" and the model constants stay as they are.

  python3 research/backtests/option-chain/calibrate.py --store ~/.local/share/vertex/option-chain \
      [--out <report work dir>/option-chain-calibration.json]

The JSON has `proposed.halfSpread` (fraction of the mid), `proposed.callSlope` and `proposed.putSlope`
per symbol.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
from pathlib import Path

SCHEMA = 1
SNAPSHOT_SCHEMA = 2  # the summary.json schema of snapshot.py that this report reads
MIN_DAYS = 20
ROOT = Path(__file__).resolve().parents[3]
MODEL = ROOT / "services/research/strategies/qc_ports/options.py"


def day_value(items: list[dict]) -> dict | None:
    """Half-spread (fraction of the mid) and wing slopes of one symbol on one day; None when a part is missing."""
    spreads = [value for item in items for value in item["halfSpreadPct"].values() if value is not None]
    calls = [item["callSlope"] for item in items if item["callSlope"] is not None]
    puts = [item["putSlope"] for item in items if item["putSlope"] is not None]
    if not spreads or not calls or not puts:
        return None
    return {"halfSpread": statistics.fmean(spreads) / 100, "callSlope": statistics.fmean(calls),
            "putSlope": statistics.fmean(puts)}


def load_days(store: Path) -> tuple[dict[str, dict[str, dict]], list[str]]:
    """(symbol -> day -> day value, the run files left out). A day value comes from the latest run of the
    day that has quotes for the symbol. A file is left out when it is damaged or has another schema
    (another method of measurement): `snapshot.py --remeasure` writes it again from the stored CSV files."""
    out: dict[str, dict[str, dict]] = {}
    skipped = []
    for path in sorted(store.glob("*/*/summary.json")):  # day, then run time: later runs replace earlier ones
        try:
            summary = json.loads(path.read_text())
            if summary["schema"] != SNAPSHOT_SCHEMA:
                raise ValueError(f"schema {summary['schema']}, not {SNAPSHOT_SCHEMA}")
            day = summary["day"]
            values = {symbol: day_value(items) for symbol, items in summary["symbols"].items()}
        except (ValueError, KeyError, TypeError, AttributeError) as error:  # JSONDecodeError is a ValueError
            skipped.append(f"{path}: {type(error).__name__}: {error}")
            continue
        for symbol, value in values.items():
            if value is not None:
                out.setdefault(symbol, {})[day] = value
    return out, skipped


def spread_of(values: list[float]) -> dict:
    """Median and quartiles (inclusive method; one value gives that value three times)."""
    if len(values) == 1:
        return {"median": values[0], "p25": values[0], "p75": values[0]}
    low, median, high = statistics.quantiles(values, n=4, method="inclusive")
    return {"median": median, "p25": low, "p75": high}


def calibrate(store: Path, model: dict, min_days: int = MIN_DAYS) -> dict:
    """The report: per symbol the day count and the statistics, the proposal and whether it is ready."""
    days, skipped = load_days(store)
    symbols = {}
    for symbol in model["halfSpread"]:
        values = days.get(symbol, {})
        stats = {key: spread_of([value[key] for value in values.values()]) if values else None
                 for key in ("halfSpread", "callSlope", "putSlope")}
        symbols[symbol] = {"days": len(values), "firstDay": min(values, default=None), "lastDay": max(values, default=None),
                           "model": {"halfSpread": model["halfSpread"][symbol], "slope": model["slope"][symbol]}, **stats}
    counted = [entry["days"] for entry in symbols.values()]
    ready = bool(counted) and min(counted) >= min_days
    proposed = {key: {symbol: round(entry[key]["median"], digits) for symbol, entry in symbols.items() if entry[key]}
                for key, digits in (("halfSpread", 4), ("callSlope", 3), ("putSlope", 3))}
    return {"schema": SCHEMA, "store": str(store), "minDays": min_days, "ready": ready,
            "daysMin": min(counted, default=0), "daysMax": max(counted, default=0), "skipped": skipped, "symbols": symbols, "proposed": proposed}


def table(report: dict) -> str:
    def cell(entry: dict | None, scale: float, digits: int) -> str:
        if entry is None:
            return "no data"
        return f"{entry['median'] * scale:.{digits}f} ({entry['p25'] * scale:.{digits}f} to {entry['p75'] * scale:.{digits}f})"

    lines = ["| ETF | Days | Half-spread %, model | Measured: median (p25 to p75) | Skew slope, model | Calls | Puts |",
             "|---|---|---|---|---|---|---|"]
    for symbol, entry in report["symbols"].items():
        lines.append(f"| {symbol} | {entry['days']} | {entry['model']['halfSpread'] * 100:.2f} | {cell(entry['halfSpread'], 100, 2)} "
                     f"| {entry['model']['slope']:+.2f} | {cell(entry['callSlope'], 1, 3)} | {cell(entry['putSlope'], 1, 3)} |")
    state = "ready" if report["ready"] else "not ready"
    lines.append(f"\n{state}: {report['daysMin']} of {report['minDays']} days (the symbol with the fewest days)")
    lines.extend(f"left out: {entry}" for entry in report["skipped"])
    return "\n".join(lines)


def current_model() -> dict:
    """The constants of the qc-ports option model, loaded from its file (it imports only math)."""
    spec = importlib.util.spec_from_file_location("qc_ports_options", MODEL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {"halfSpread": dict(module.HALF_SPREAD_PCT), "slope": dict(module.SKEW)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--store", required=True, type=Path, help="snapshot store directory of snapshot.py")
    parser.add_argument("--min-days", type=int, default=MIN_DAYS)
    parser.add_argument("--out", type=Path, default=None, help="write the report JSON here")
    args = parser.parse_args()
    report = calibrate(args.store.expanduser(), current_model(), args.min_days)
    print(table(report))
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
