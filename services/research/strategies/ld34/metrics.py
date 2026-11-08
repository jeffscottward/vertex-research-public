"""Daily statistics, financing, walk-forward, Monte Carlo and the deflated Sharpe of the LD34 study.

Session days follow the DSL `timeframe: "1d"` rule: the New York date of (bar time + 7 hours),
so a day starts at 17:00 New York. Statistics use the equity at the last bar of each session day.
Sharpe is annualized by the observed session days per year (rf 0).
"""
from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

from backtesting.optimizer import deflated_sharpe_ratio

NEW_YORK = ZoneInfo("America/New_York")
SESSION_SHIFT = timedelta(hours=7)
DAYS_PER_YEAR = 365.25
FINANCING_SPREAD = 0.015  # broker margin loan: benchmark (13-week T-bill, IRX) + 1.5 %

Point = tuple[str, float]


def session_day(t_ms: float) -> str:
    moment = datetime.fromtimestamp(t_ms / 1000, UTC) + SESSION_SHIFT
    return moment.astimezone(NEW_YORK).date().isoformat()


def daily_points(times: Sequence[float], values: Sequence[float]) -> list[Point]:
    """The last value of each session day, in order."""
    out: list[Point] = []
    for t, value in zip(times, values):
        day = session_day(t)
        if out and out[-1][0] == day:
            out[-1] = (day, value)
        else:
            out.append((day, value))
    return out


def _years(first: str, last: str) -> float:
    return (date.fromisoformat(last) - date.fromisoformat(first)).days / DAYS_PER_YEAR


def returns_of(points: Sequence[Point]) -> list[float]:
    return [b[1] / a[1] - 1 for a, b in pairwise(points) if a[1] > 0]


def max_drawdown(values: Sequence[float]) -> float:
    peak = -math.inf
    worst = 0.0
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            worst = min(worst, value / peak - 1)
    return worst


def drawdowns(values: Sequence[float]) -> list[float]:
    peak = -math.inf
    out = []
    for value in values:
        peak = max(peak, value)
        out.append(value / peak - 1 if peak > 0 else 0.0)
    return out


def stats(points: Sequence[Point]) -> dict:
    """CAGR, Sharpe, max drawdown and years of daily points (needs 2+ points)."""
    if len(points) < 3:
        return {"cagr": 0.0, "sharpe": 0.0, "maxDrawdown": 0.0, "years": 0.0, "days": len(points), "sharpePerDay": 0.0}
    years = _years(points[0][0], points[-1][0])
    rets = returns_of(points)
    n = len(rets)
    mean = sum(rets) / n
    var = sum((r - mean) ** 2 for r in rets) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    per_year = n / years if years > 0 else 252.0
    growth = points[-1][1] / points[0][1]
    cagr = growth ** (1 / years) - 1 if years > 0 and growth > 0 else -1.0
    return {
        "cagr": cagr,
        "sharpe": mean / sd * math.sqrt(per_year) if sd > 0 else 0.0,
        "sharpePerDay": mean / sd if sd > 0 else 0.0,
        "maxDrawdown": max_drawdown([p[1] for p in points]),
        "years": years,
        "days": len(points),
    }


def split(points: Sequence[Point], fraction: float = 0.6) -> tuple[list[Point], list[Point]]:
    """In-sample (first `fraction` of the time) and out-of-sample points; the OOS part starts at the last IS point."""
    first = date.fromisoformat(points[0][0])
    last = date.fromisoformat(points[-1][0])
    cut = (first + (last - first) * fraction).isoformat()
    head = [p for p in points if p[0] <= cut]
    tail = [p for p in points if p[0] >= head[-1][0]]
    return list(head), tail


def trade_stats(trades: Sequence[Mapping]) -> dict:
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [-t["pnl"] for t in trades if t["pnl"] <= 0]
    return {
        "trades": len(trades),
        "winRate": len(wins) / len(trades) if trades else 0.0,
        "profitFactor": (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else None,
    }


def financing_factors(trades: Sequence[Mapping], times: Sequence[float], equity: Sequence[float],
                      rate_by_day: Mapping[str, float]) -> dict[str, float]:
    """Interest on the borrowed part of each position (notional above the equity at entry), charged at
    exit: day -> fraction of equity lost that day. Rate = IRX / 100 + FINANCING_SPREAD (IRX of the
    entry day, else the latest earlier one)."""
    days_sorted = sorted(rate_by_day)
    charges: dict[str, float] = {}
    for trade in trades:
        entry, exit_ = trade["entryIndex"], trade["exitIndex"]
        before = equity[entry - 1] if entry > 0 else equity[0]
        notional = trade["units"] * trade["entryPrice"]
        borrowed = notional - before
        if borrowed <= 0:
            continue
        held = (times[exit_] - times[entry]) / 86_400_000
        entry_day = session_day(times[entry])
        rate = _rate_on(entry_day, days_sorted, rate_by_day) / 100 + FINANCING_SPREAD
        fee = borrowed * max(rate, 0.0) * held / 365
        at_exit = equity[exit_]
        if at_exit > 0:
            day = session_day(times[exit_])
            charges[day] = charges.get(day, 0.0) + fee / at_exit
    return charges


def _rate_on(day: str, days_sorted: Sequence[str], rates: Mapping[str, float]) -> float:
    lo, hi = 0, len(days_sorted)
    while lo < hi:
        mid = (lo + hi) // 2
        if days_sorted[mid] <= day:
            lo = mid + 1
        else:
            hi = mid
    return rates[days_sorted[lo - 1]] if lo > 0 else (rates[days_sorted[0]] if days_sorted else 0.0)


def apply_charges(points: Sequence[Point], charges: Mapping[str, float]) -> list[Point]:
    factor = 1.0
    out = []
    for day, value in points:
        factor *= 1 - charges.get(day, 0.0)
        out.append((day, value * factor))
    return out


def combine(sleeves: Sequence[Sequence[Point]]) -> list[Point]:
    """Equal capital per sleeve, rebalanced daily, on the common window (days all sleeves report)."""
    maps = [dict(s) for s in sleeves]
    start = max(s[0][0] for s in sleeves)
    end = min(s[-1][0] for s in sleeves)
    days = sorted({d for s in sleeves for d, _ in s if start <= d <= end})
    last = [None] * len(sleeves)
    value = 1.0
    out: list[Point] = []
    for day in days:
        current = []
        for i, m in enumerate(maps):
            current.append(m.get(day, last[i]))
        if all(c is not None for c in last):
            rets = [c / p - 1 for c, p in zip(current, last)]
            value *= 1 + sum(rets) / len(rets)
        out.append((day, value))
        last = current
    return out


def window_points(points: Sequence[Point], first: str, last: str) -> list[Point]:
    return [p for p in points if first <= p[0] <= last]


def walk_forward(candidates: Sequence[Sequence[Point]], train_years: int = 3, test_years: int = 1,
                 warmup_days: int = 300) -> dict:
    """Rolling selection: each test year uses the candidate with the best Sharpe over the previous
    `train_years`; the stitched test returns form the walk-forward curve. Returns the curve and picks."""
    grid = candidates[0]
    first_day = date.fromisoformat(grid[0][0]) + timedelta(days=warmup_days)
    last_day = date.fromisoformat(grid[-1][0])
    curve: list[Point] = []
    picks: list[dict] = []
    value = 1.0
    start = first_day + timedelta(days=round(train_years * DAYS_PER_YEAR))
    while start < last_day:
        end = min(start + timedelta(days=round(test_years * DAYS_PER_YEAR)), last_day)
        train = [window_points(c, (start - timedelta(days=round(train_years * DAYS_PER_YEAR))).isoformat(),
                               start.isoformat()) for c in candidates]
        scores = [stats(t)["sharpe"] if len(t) > 20 else -math.inf for t in train]
        best = max(range(len(candidates)), key=lambda i: scores[i])
        test = window_points(candidates[best], start.isoformat(), end.isoformat())
        if not curve and test:
            curve.append((test[0][0], value))
        for a, b in pairwise(test):
            value *= b[1] / a[1]
            curve.append((b[0], value))
        picks.append({"from": start.isoformat(), "to": end.isoformat(), "pick": best, "trainSharpe": scores[best]})
        start = end
    return {"curve": curve, "picks": picks}


def monte_carlo(trade_returns: Sequence[float], paths: int = 2000, seed: int = 34) -> dict:
    """Bootstrap the per-trade equity returns (with replacement, same count): percentiles of the
    final return and of the max drawdown."""
    if len(trade_returns) < 2:
        return {"paths": 0}
    rng = random.Random(seed)
    finals, dds = [], []
    n = len(trade_returns)
    for _ in range(paths):
        value = peak = 1.0
        worst = 0.0
        for _ in range(n):
            value *= 1 + trade_returns[rng.randrange(n)]
            peak = max(peak, value)
            worst = min(worst, value / peak - 1)
        finals.append(value - 1)
        dds.append(worst)
    finals.sort()
    dds.sort()

    def pct(values: list[float], q: float) -> float:
        return values[min(len(values) - 1, max(0, int(q * len(values))))]

    return {"paths": paths, "trades": n, "finalP5": pct(finals, 0.05), "finalP50": pct(finals, 0.5),
            "maxDrawdownP5": pct(dds, 0.05), "maxDrawdownP50": pct(dds, 0.5),
            "lossShare": sum(1 for f in finals if f < 0) / paths}


def moments(rets: Sequence[float]) -> tuple[float, float, float, float]:
    n = len(rets)
    mean = sum(rets) / n
    m2 = sum((x - mean) ** 2 for x in rets) / n
    m3 = sum((x - mean) ** 3 for x in rets) / n
    m4 = sum((x - mean) ** 4 for x in rets) / n
    if m2 <= 0:
        return mean, 0.0, 0.0, 3.0
    return mean, math.sqrt(m2 * n / (n - 1)), m3 / m2 ** 1.5, m4 / m2 ** 2


def deflated_sharpe(points: Sequence[Point], n_trials: int, trial_sharpes_per_day: Sequence[float]) -> dict:
    """Bailey & Lopez de Prado deflated Sharpe probability of the daily returns, given the number of
    configurations tried and the variance of their per-day Sharpes."""
    rets = returns_of(points)
    mean, sd, skew, kurt = moments(rets)
    sharpe = mean / sd if sd > 0 else 0.0
    if len(trial_sharpes_per_day) >= 2:
        mu = sum(trial_sharpes_per_day) / len(trial_sharpes_per_day)
        variance = sum((s - mu) ** 2 for s in trial_sharpes_per_day) / (len(trial_sharpes_per_day) - 1)
    else:
        variance = 0.0
    result = deflated_sharpe_ratio(sharpe, max(n_trials, 2), variance, len(rets), skew, kurt)
    return {"probability": result.probability, "expectedMaxSharpePerDay": result.expected_max_sharpe,
            "sharpePerDay": sharpe, "trials": n_trials, "observations": len(rets)}


def monthly(points: Sequence[Point]) -> list[dict]:
    """Month-end return since start and drawdown, for the study chart."""
    out: dict[str, tuple[float, float]] = {}
    base = points[0][1]
    dd = drawdowns([p[1] for p in points])
    for (day, value), d in zip(points, dd):
        month = day[:7]
        prev = out.get(month)
        out[month] = (value / base - 1, min(d, prev[1]) if prev else d)
    return [{"month": m, "value": v, "drawdown": d} for m, (v, d) in sorted(out.items())]
