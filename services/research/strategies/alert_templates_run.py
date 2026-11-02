"""Frozen event-study backtest of the alert-template triggers on daily CSV data.

Research only: reads local files, writes one JSON report, places no orders.

Usage (rig):
  cd services/research && python -m strategies.alert_templates_run \
      --data ~/Documents/reports/vertex-strategies-buildout/data --out results.json

Method (fixed before the first run; see docs/specs/strategies/<slug>.md):
* An event is one alert (trigger session t). Forward return = adj_close[t+h] / adj_close[t] - 1 for
  h = 5, 20, 60 sessions, measured from the trigger-day close (the alert is known by then).
* Benchmark = equal-weight mean forward return, same date and horizon, of every symbol in the
  strategy's universe with data. Excess = event return - benchmark. Market stress uses SPY's average
  forward return over all sessions; the earnings-calendar move alerts also report excess over the
  same stock's average forward return over all sessions (selection check).
* Cost = 10 bp per side (0.20% round trip), charged to the event return only.
* Halves = events split at the median event date. Verdict at h = 20:
  pass = at least 30 events, mean net excess > 0 with t >= 2, and mean net excess > 0 in both halves;
  fail = at least 30 events and not pass; inconclusive = fewer than 30 events.
  t uses the plain standard error; overlapping events make it too high, so treat it as an upper bound.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from strategies import alert_templates as at

HORIZONS = (5, 20, 60)
COST_ROUND_TRIP = 0.002
MIN_EVENTS = 30


@dataclass(frozen=True, slots=True)
class Instrument:
    symbol: str
    bars: tuple[at.DailyBar, ...]
    adj: tuple[float, ...]
    index: dict[date, int]
    dividends: tuple[at.Dividend, ...]


def load(data: Path, symbol: str) -> Instrument | None:
    path = data / f"{symbol}.csv"
    if not path.exists():
        return None
    bars: list[at.DailyBar] = []
    adj: list[float] = []
    for row in csv.DictReader(path.open()):
        o, h, lo, c = (float(row[k]) for k in ("open", "high", "low", "close"))
        if min(o, h, lo, c) <= 0:
            continue
        # Yahoo rows can carry high/low slightly inside open/close; widen to contain them.
        bars.append(at.DailyBar(date.fromisoformat(row["date"]), o, max(h, o, c), min(lo, o, c), c,
                                float(row["volume"])))
        adj.append(float(row["adj_close"]))
    divs: list[at.Dividend] = []
    div_path = data / f"{symbol}.div.csv"
    if div_path.exists():
        divs = [at.Dividend(date.fromisoformat(r["ex_date"]), float(r["dividend"])) for r in csv.DictReader(div_path.open())]
    return Instrument(symbol, tuple(bars), tuple(adj), {b.day: i for i, b in enumerate(bars)}, tuple(divs))


def forward(inst: Instrument, t: int, h: int) -> float | None:
    if t + h >= len(inst.adj):
        return None
    return inst.adj[t + h] / inst.adj[t] - 1


class Benchmark:
    """Equal-weight mean forward return of a universe, per (date, horizon); cached."""

    def __init__(self, universe: Sequence[Instrument]):
        self.universe = universe
        self.cache: dict[tuple[date, int], float | None] = {}

    def __call__(self, inst: Instrument, day: date, h: int) -> float | None:
        key = (day, h)
        if key not in self.cache:
            values = [r for inst in self.universe if day in inst.index
                      for r in [forward(inst, inst.index[day], h)] if r is not None]
            self.cache[key] = math.fsum(values) / len(values) if values else None
        return self.cache[key]


def _stats(values: Sequence[float]) -> dict:
    n = len(values)
    if n == 0:
        return {"n": 0}
    mean = math.fsum(values) / n
    sd = math.sqrt(math.fsum((v - mean) ** 2 for v in values) / (n - 1)) if n > 1 else 0.0
    t = mean / (sd / math.sqrt(n)) if n > 1 and sd > 0 else None
    return {"n": n, "mean": round(mean, 5), "t": None if t is None else round(t, 2)}


def study(events: Sequence[tuple[Instrument, at.Signal]],
          bench: Callable[[Instrument, date, int], float | None]) -> dict:
    rows = []
    for inst, sig in events:
        row: dict = {"symbol": inst.symbol, "day": sig.day.isoformat(), "kind": sig.kind, "level": sig.level}
        for h in HORIZONS:
            r, b = forward(inst, sig.index, h), bench(inst, sig.day, h)
            if r is not None and b is not None:
                row[f"r{h}"] = r - COST_ROUND_TRIP
                row[f"x{h}"] = r - COST_ROUND_TRIP - b
                row[f"b{h}"] = b
        rows.append(row)
    rows.sort(key=lambda r: (r["day"], r["symbol"]))
    out: dict = {"events": len(rows)}
    if not rows:
        out["verdict"] = "inconclusive (no events)"
        return out
    mid = rows[len(rows) // 2]["day"]
    first = [r for r in rows if r["day"] < mid]
    second = [r for r in rows if r["day"] >= mid]
    for h in HORIZONS:
        have = [r for r in rows if f"x{h}" in r]
        out[f"h{h}"] = {
            "net": _stats([r[f"r{h}"] for r in have]),
            "benchmark": _stats([r[f"b{h}"] for r in have]),
            "excess": _stats([r[f"x{h}"] for r in have]),
            "hit_rate": round(sum(1 for r in have if r[f"r{h}"] > 0) / len(have), 3) if have else None,
            "first_half_excess": _stats([r[f"x{h}"] for r in first if f"x{h}" in r]),
            "second_half_excess": _stats([r[f"x{h}"] for r in second if f"x{h}" in r]),
        }
    out["first_event"], out["last_event"], out["split_day"] = rows[0]["day"], rows[-1]["day"], mid
    out["verdict"] = verdict(out)
    out["sample"] = [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()} for r in rows[-5:]]
    return out


def verdict(result: dict) -> str:
    h = result.get("h20")
    if not h or h["excess"]["n"] < MIN_EVENTS:
        return "inconclusive (fewer than 30 events)"
    ex, a, b = h["excess"], h["first_half_excess"], h["second_half_excess"]
    ok = (ex["mean"] > 0 and (ex["t"] or 0) >= 2 and a.get("mean", -1) > 0 and b.get("mean", -1) > 0)
    return "pass" if ok else "fail"


# ---------------------------------------------------------------------------------------------


def run(data: Path) -> dict:
    from importlib import import_module

    universe_mod = import_module("universe")  # research/backtests/freestockalerts/universe.py on sys.path
    stocks = [i for s in universe_mod.STOCKS if (i := load(data, s)) is not None]
    sectors = [i for s in universe_mod.SECTOR_ETFS if (i := load(data, s)) is not None]
    stress = {s: load(data, s) for s in universe_mod.STRESS}
    spy = stress["SPY"]
    assert spy is not None
    stock_bench = Benchmark(stocks)
    report: dict = {"method": __doc__.split("Method", 1)[1].strip(), "universe_sizes": {
        "stocks": len(stocks), "sector_etfs": len(sectors)}}

    def per_symbol(fn: Callable[[Instrument], list[at.Signal]], universe: Sequence[Instrument]) -> list:
        return [(inst, sig) for inst in universe for sig in fn(inst)]

    report["quality-breakout-radar"] = study(per_symbol(lambda i: at.quality_breakout_radar(i.bars), stocks), stock_bench)
    report["under-the-radar-breakouts"] = study(per_symbol(lambda i: at.under_the_radar_breakouts(i.bars), stocks), stock_bench)
    report["quality-compounders-on-pullback"] = study(
        per_symbol(lambda i: at.quality_compounders_on_pullback(i.bars), stocks), stock_bench)
    report["leader-pullback-and-reclaim"] = study(per_symbol(lambda i: at.leader_pullback_and_reclaim(i.bars), stocks), stock_bench)
    report["200-day-comeback-watchlist"] = study(per_symbol(lambda i: at.two_hundred_day_comeback(i.bars), stocks), stock_bench)
    report["dividend-growth-buy-zones"] = study(
        per_symbol(lambda i: at.dividend_growth_buy_zones(i.bars, i.dividends), stocks), stock_bench)

    sector_events = per_symbol(lambda i: at.sector_leadership(i.bars, spy.bars), sectors)
    sector_bench = Benchmark(sectors)
    report["sector-leadership-radar"] = {
        "all": study(sector_events, sector_bench),
        **{label: study([e for e in sector_events if e[1].note == label], sector_bench)
           for label in ("leadership", "bounce-in-downtrend")}}

    stress_signals = at.market_stress({k: v.bars for k, v in stress.items() if v is not None})
    flat = lambda inst, day, h: _unconditional(spy, h)  # noqa: E731
    stress_report: dict = {"note": "Forward returns are SPY's, from the alert-day close, against SPY's "
                                   "average forward return over all sessions."}
    for symbol, signals in stress_signals.items():
        inst = stress[symbol]
        assert inst is not None
        for kind in sorted({s.kind for s in signals}):
            events = [(spy, at.Signal(spy.index[s.day], s.day, s.kind)) for s in signals
                      if s.kind == kind and s.day in spy.index]
            stress_report[f"{symbol} {kind}"] = study(events, flat)
    report["market-stress-alerts"] = stress_report

    cal = [i for i in stocks if i.symbol in at.EARNINGS_CALENDAR_SYMBOLS]
    cal_bench = Benchmark(cal)
    moves = per_symbol(lambda i: at.large_moves(i.symbol, i.bars) if i.symbol in at.LARGE_MOVE_LIMITS else [], cal)
    report["earnings-calendar-alerts"] = {
        "large-moves-all": study(moves, cal_bench),
        "large-moves-up": study([e for e in moves if e[1].kind == "move-up"], cal_bench),
        "large-moves-down": study([e for e in moves if e[1].kind == "move-down"], cal_bench),
        "large-moves-all-vs-own-average": study(moves, lambda inst, day, h: _unconditional(inst, h)),
        "reminders": "needs data source: historical earnings dates (FinancialDatasets /earnings adapter exists; "
                     "no API key is configured)"}
    for slug in ("post-earnings-strength-radar", "insider-purchase-confirmation", "analyst-upgrade-clusters"):
        report[slug] = {"verdict": "not run: needs data source"}
    return report


_UNCOND: dict[tuple[str, int], float] = {}


def _unconditional(inst: Instrument, h: int) -> float:
    key = (inst.symbol, h)
    if key not in _UNCOND:
        values = [r for t in range(len(inst.adj)) if (r := forward(inst, t, h)) is not None]
        _UNCOND[key] = math.fsum(values) / len(values)
    return _UNCOND[key]


def main() -> None:
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--universe-dir", default=str(Path(__file__).resolve().parents[3] / "research/backtests/freestockalerts"))
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    sys.path.insert(0, args.universe_dir)
    report = run(Path(args.data).expanduser())
    Path(args.out).write_text(json.dumps(report, indent=1, default=str))
    for key, value in report.items():
        if isinstance(value, dict) and "verdict" in value:
            print(f"{key}: {value['events'] if 'events' in value else ''} events, {value['verdict']}")


if __name__ == "__main__":
    main()
