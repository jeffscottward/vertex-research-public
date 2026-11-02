"""Sector momentum rotation (151 Trading Strategies, sections 4.1, 4.1.1 and 4.1.2), long only.

Research only: pure functions plus a CLI that reads local CSV files and writes one JSON report.
It places no orders. Spec: docs/specs/strategies/151-4-1-sector-momentum-rotation.md.

Frozen parameters (Vertex defaults, basis A in the spec, fixed before the first run):
* Formation: total return over the last 252 sessions (12 months), measured at the last session of
  each month. An ETF needs 252 sessions of history to be ranked.
* Holding: the top 2 ETFs by formation return, equal weight, held for one month. The book says
  "top decile"; with 9 to 11 sector ETFs one decile is one ETF, so Vertex uses the top 2.
* 4.1.1 MA filter: a top-2 ETF is held only while its close is above its 200-session average;
  otherwise its half of the book is in cash at 0%.
* 4.1.2 dual momentum: when SPY's close is above its 200-session average the book holds the top 2;
  otherwise it holds TLT.
* Benchmark: equal weight in every rankable sector ETF, rebalanced monthly.
* Cost: 10 bp per side on the traded weight at each rebalance.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

FORMATION = 252
TOP_N = 2
MA_LENGTH = 200
COST_PER_SIDE = 0.001
SECTORS = ("XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC")
VARIANTS = ("base", "ma-filter", "dual-momentum", "equal-weight")

Prices = Mapping[str, Mapping[date, float]]  # symbol -> session -> dividend-adjusted close


@dataclass(frozen=True, slots=True)
class Rebalance:
    day: date
    weights: dict[str, float]
    formation: dict[str, float]


def month_ends(days: Sequence[date]) -> list[int]:
    """Indexes of the last session of each calendar month (the final session counts only if the
    month is complete in the data, i.e. a later session exists)."""
    return [i for i in range(len(days) - 1) if (days[i].year, days[i].month) != (days[i + 1].year, days[i + 1].month)]


def _history(prices: Prices, symbol: str, days: Sequence[date], i: int, length: int) -> list[float] | None:
    series = prices.get(symbol, {})
    window = days[i - length + 1:i + 1] if i - length + 1 >= 0 else []
    if len(window) < length or any(d not in series for d in window):
        return None
    return [series[d] for d in window]


def formation_returns(prices: Prices, days: Sequence[date], i: int, universe: Sequence[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for symbol in universe:
        hist = _history(prices, symbol, days, i, FORMATION + 1)
        if hist is not None:
            out[symbol] = hist[-1] / hist[0] - 1
    return out


def above_average(prices: Prices, symbol: str, days: Sequence[date], i: int) -> bool | None:
    hist = _history(prices, symbol, days, i, MA_LENGTH)
    if hist is None:
        return None
    return hist[-1] > math.fsum(hist) / MA_LENGTH


def target_weights(variant: str, prices: Prices, days: Sequence[date], i: int,
                   universe: Sequence[str] = SECTORS) -> Rebalance | None:
    """Weights to hold from the close of session ``i`` (a month end) to the next month end."""
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant {variant!r}")
    ranks = formation_returns(prices, days, i, universe)
    if len(ranks) < TOP_N + 1:
        return None
    if variant == "equal-weight":
        return Rebalance(days[i], {s: 1 / len(ranks) for s in ranks}, ranks)
    top = sorted(ranks, key=lambda s: (-ranks[s], s))[:TOP_N]
    if variant == "dual-momentum":
        risk_on = above_average(prices, "SPY", days, i)
        if risk_on is None:
            return None
        if not risk_on:
            return Rebalance(days[i], {"TLT": 1.0}, ranks)
    weights = {s: 1 / TOP_N for s in top}
    if variant == "ma-filter":
        weights = {s: w for s, w in weights.items() if above_average(prices, s, days, i)}
    return Rebalance(days[i], weights, ranks)


def simulate(variant: str, prices: Prices, days: Sequence[date], universe: Sequence[str] = SECTORS) -> dict:
    """Monthly-rebalanced equity curve. Returns the daily equity, rebalances and turnover."""
    ends = set(month_ends(days))
    equity, value = [], 1.0
    weights: dict[str, float] = {}
    rebalances: list[Rebalance] = []
    turnover = 0.0
    started = False
    for i, day in enumerate(days):
        if started and i > 0:
            prev = days[i - 1]
            growth = 0.0
            for symbol, w in weights.items():
                series = prices[symbol]
                if prev in series and day in series:
                    growth += w * (series[day] / series[prev] - 1)
            value *= 1 + growth
            # Weights drift with prices until the next rebalance.
            if weights and 1 + growth != 0:
                drifted = {}
                for symbol, w in weights.items():
                    series = prices[symbol]
                    r = series[day] / series[prev] - 1 if prev in series and day in series else 0.0
                    drifted[symbol] = w * (1 + r) / (1 + growth)
                weights = drifted
        if i in ends:
            target = target_weights(variant, prices, days, i, universe)
            if target is not None:
                symbols = set(weights) | set(target.weights)
                traded = math.fsum(abs(target.weights.get(s, 0.0) - weights.get(s, 0.0)) for s in symbols)
                value *= 1 - COST_PER_SIDE * traded
                turnover += traded
                weights = dict(target.weights)
                rebalances.append(target)
                started = True
        if started:
            equity.append((day, value))
    return {"equity": equity, "rebalances": rebalances, "turnover": turnover}


def stats(equity: Sequence[tuple[date, float]]) -> dict:
    if len(equity) < 2:
        return {"sessions": len(equity)}
    values = [v for _, v in equity]
    rets = [values[k] / values[k - 1] - 1 for k in range(1, len(values))]
    years = (equity[-1][0] - equity[0][0]).days / 365.25
    mean = math.fsum(rets) / len(rets)
    sd = math.sqrt(math.fsum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
    peak, max_dd = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        max_dd = min(max_dd, v / peak - 1)
    return {
        "start": equity[0][0].isoformat(), "end": equity[-1][0].isoformat(),
        "cagr": round((values[-1] / values[0]) ** (1 / years) - 1, 4) if years > 0 else None,
        "vol": round(sd * math.sqrt(252), 4),
        "sharpe": round(mean / sd * math.sqrt(252), 3) if sd > 0 else None,
        "max_drawdown": round(max_dd, 4),
    }


def halves(equity: Sequence[tuple[date, float]]) -> tuple[list, list]:
    mid = len(equity) // 2
    return list(equity[:mid + 1]), list(equity[mid:])


def verdict(result: dict) -> str:
    """pass = CAGR and Sharpe above the equal-weight benchmark in both halves; otherwise fail."""
    ok = all(result[h]["cagr"] > result["benchmark"][h]["cagr"] and result[h]["sharpe"] > result["benchmark"][h]["sharpe"]
             for h in ("first_half", "second_half"))
    return "pass" if ok else "fail"


# ---------------------------------------------------------------------------------------------


def load(data: Path, symbols: Sequence[str]) -> tuple[dict[str, dict[date, float]], list[date]]:
    prices: dict[str, dict[date, float]] = {}
    for symbol in symbols:
        path = data / f"{symbol}.csv"
        if path.exists():
            prices[symbol] = {date.fromisoformat(r["date"]): float(r["adj_close"]) for r in csv.DictReader(path.open())}
    days = sorted(prices["SPY"])
    return prices, days


def run(data: Path) -> dict:
    prices, days = load(data, (*SECTORS, "SPY", "TLT"))
    curves = {v: simulate(v, prices, days) for v in VARIANTS}
    start = max(c["equity"][0][0] for c in curves.values())  # common start for a fair comparison
    report: dict = {"parameters": {"formation_sessions": FORMATION, "top_n": TOP_N, "ma_length": MA_LENGTH,
                                   "cost_per_side": COST_PER_SIDE}}
    bench_eq = [p for p in curves["equal-weight"]["equity"] if p[0] >= start]
    bench = {"full": stats(bench_eq), "first_half": stats(halves(bench_eq)[0]), "second_half": stats(halves(bench_eq)[1])}
    spy_eq = [(d, prices["SPY"][d]) for d in days if d >= start]
    report["spy_buy_and_hold"] = stats(spy_eq)
    report["equal-weight"] = bench
    for v in ("base", "ma-filter", "dual-momentum"):
        eq = [p for p in curves[v]["equity"] if p[0] >= start]
        first, second = halves(eq)
        res = {"full": stats(eq), "first_half": stats(first), "second_half": stats(second),
               "rebalances": len(curves[v]["rebalances"]), "turnover": round(curves[v]["turnover"], 2),
               "benchmark": bench}
        res["verdict"] = verdict(res)
        res["last_rebalances"] = [{"day": r.day.isoformat(), "weights": {k: round(w, 3) for k, w in r.weights.items()},
                                   "formation": {k: round(x, 4) for k, x in sorted(r.formation.items(), key=lambda kv: -kv[1])[:4]}}
                                  for r in curves[v]["rebalances"][-3:]]
        del res["benchmark"]
        report[v] = res
    return report


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    report = run(Path(a.data).expanduser())
    Path(a.out).write_text(json.dumps(report, indent=1))
    for v in ("base", "ma-filter", "dual-momentum"):
        print(v, report[v]["full"], report[v]["verdict"])
    print("equal-weight", report["equal-weight"]["full"])


if __name__ == "__main__":
    main()
