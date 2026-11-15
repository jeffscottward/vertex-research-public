"""Statistics of the intraday-momentum study: the LD34 study metrics (imported unchanged, so LD34 outputs
do not move) plus the leg sum of a long/short strategy and the equity/drawdown series of the report.

Daily points are (New York session day, equity at the last bar of that day). Sharpe is annualized by the
observed session days per year (rf 0), as in LD34.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence

from strategies.ld34.metrics import (
    combine,
    deflated_sharpe,
    drawdowns,
    max_drawdown,
    monte_carlo,
    monthly,
    returns_of,
    split,
    stats,
    trade_stats,
    walk_forward,
    window_points,
)

Point = tuple[str, float]
IS_FRACTION = 0.6
MC_PATHS = 2000
MC_SEED = 31


def sum_legs(legs: Sequence[Sequence[Point]]) -> list[Point]:
    """One curve (start 1.0) whose daily return is the sum of the legs' daily returns, on the union of days
    (a leg without a point that day contributes 0)."""
    if not legs:
        return []
    maps = [dict(leg) for leg in legs]
    days = sorted({d for leg in legs for d, _ in leg})
    last: list[float | None] = [None] * len(legs)
    value = 1.0
    out: list[Point] = []
    for day in days:
        total = 0.0
        for i, m in enumerate(maps):
            current = m.get(day)
            if current is None:
                continue
            if last[i] is not None and last[i] > 0:
                total += current / last[i] - 1
            last[i] = current
        value *= 1 + total
        out.append((day, value))
    return out


def rebase(points: Sequence[Point]) -> list[Point]:
    if not points:
        return []
    base = points[0][1]
    return [(d, v / base) for d, v in points]


def drawdown_series(points: Sequence[Point]) -> list[Point]:
    return [(d, dd) for (d, _), dd in zip(points, drawdowns([p[1] for p in points]))]


def summary(points: Sequence[Point], fraction: float = IS_FRACTION) -> dict:
    if len(points) < 3:
        empty = stats(points)
        return {"full": empty, "inSample": empty, "outOfSample": empty}
    is_part, oos = split(points, fraction)
    return {"full": stats(points), "inSample": stats(is_part), "outOfSample": stats(oos)}


def trades_between(trades: Sequence[Mapping], first: str, last: str) -> list[Mapping]:
    return [t for t in trades if first <= t["day"] <= last]


def trade_returns(trades: Sequence[Mapping], first: str | None = None) -> list[float]:
    """Per-trade return on the leg equity before the trade (unit equity), for trades on or after `first`."""
    return [t["pnl"] / t["before"] for t in trades
            if t.get("before", 0) > 0 and (first is None or t["day"] >= first)]


def window(points: Sequence[Point], ref: Sequence[Point]) -> list[Point]:
    return [p for p in points if ref and ref[0][0] <= p[0] <= ref[-1][0]]


__all__ = [
    "IS_FRACTION", "MC_PATHS", "MC_SEED", "combine", "deflated_sharpe", "drawdown_series", "drawdowns", "max_drawdown",
    "monte_carlo", "monthly", "rebase", "returns_of", "split", "stats", "sum_legs", "summary", "trade_returns",
    "trade_stats", "trades_between", "walk_forward", "window", "window_points",
]
