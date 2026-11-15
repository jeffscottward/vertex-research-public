"""Statistics of the volume-spike-breakout study (research only).

The daily statistics, the 60/40 split, the walk-forward, the Monte Carlo and the deflated Sharpe ratio are
the LD34 / market-intraday-momentum functions, imported unchanged. This module adds the R-multiple
statistics of a trade list, the replication check against the source's claims, the deflated Sharpe ratio
with a given number of trials and of the source's claimed result, and helpers that accept an empty window
(a window without trades or without days gives zeros and `None`s, never an exception).
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date, timedelta

from backtesting.optimizer import deflated_sharpe_ratio, expected_max_sharpe
from strategies.imom.metrics import (
    IS_FRACTION,
    combine,
    deflated_sharpe,
    drawdown_series,
    monte_carlo,
    monthly,
    rebase,
    returns_of,
    split,
    stats,
    sum_legs,
    walk_forward,
    window,
)
from strategies.ld34.metrics import moments

Point = tuple[str, float]
MC_PATHS = 2000
MC_SEED = 39113  # the source's strategy id 39-113
CONTROL_SEED = 39113
# The source's claims (docs/specs/strategies/volume-spike-breakout.md, 'Claims of the source').
CLAIM = {
    "trades": 657, "winRate": 0.14, "rewardRisk": 8.88, "netR": 0.457, "grossR": 0.541, "totalR": 300.0,
    "maxDrawdownR": 71.0, "maxLosingStreak": 37, "costR": 0.084, "stopShare": 0.85, "longR": 0.636,
    "shortR": 0.133, "holdMinutes": 400.0, "tradesPerWeek": 1.75,
    "oosNetR": 1.154, "oosTrades": 59, "oosTotalR": 68.1,
}
# Pre-registered tolerances of the replication check.
TOLERANCE = {"trades": 0.25, "winRate": 0.05, "netR": 0.15}
SOURCE_TRIALS = 10_000
SOURCE_TRIALS_WITH_CONTROLS = 10_500


def flat(days: Sequence[str]) -> list[Point]:
    return [(day, 1.0) for day in days]


def window_base(points: Sequence[Point], first: str, last: str) -> list[Point]:
    """The points inside [first, last], preceded by the last point before `first` (the base of the window's
    first return)."""
    inside = [p for p in points if first <= p[0] <= last]
    before = [p for p in points if p[0] < first]
    return ([before[-1]] if before else []) + inside


def split_summary(points: Sequence[Point], fraction: float = IS_FRACTION) -> dict:
    """Full, in-sample (first `fraction` of the time) and out-of-sample statistics, with the split dates."""
    if len(points) < 3:
        empty = stats(points)
        return {"full": empty, "inSample": empty, "outOfSample": empty, "split": None}
    head, tail = split(points, fraction)
    return {"full": stats(points), "inSample": stats(head), "outOfSample": stats(tail),
            "split": {"isFrom": head[0][0], "isTo": head[-1][0], "oosFrom": tail[0][0], "oosTo": tail[-1][0]}}


def r_stats(values: Sequence[float]) -> dict:
    """R-multiple statistics of a trade list in trade order. Empty list: zeros and None."""
    rs = [float(v) for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    n = len(rs)
    if n == 0:
        return {"trades": 0, "winRate": None, "avgWinR": None, "avgLossR": None, "rewardRisk": None, "meanR": None,
                "totalR": 0.0, "maxDrawdownR": 0.0, "maxLosingStreak": 0, "sdR": None, "sharpePerTrade": None}
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    mean = sum(rs) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in rs) / (n - 1)) if n > 1 else 0.0
    total = peak = worst = 0.0
    streak = longest = 0
    for r in rs:
        total += r
        peak = max(peak, total)
        worst = max(worst, peak - total)
        streak = streak + 1 if r <= 0 else 0
        longest = max(longest, streak)
    avg_win = sum(wins) / len(wins) if wins else None
    avg_loss = -sum(losses) / len(losses) if losses else None
    return {
        "trades": n, "winRate": len(wins) / n, "avgWinR": avg_win, "avgLossR": avg_loss,
        "rewardRisk": avg_win / avg_loss if avg_win is not None and avg_loss else None,
        "meanR": mean, "totalR": total, "maxDrawdownR": worst, "maxLosingStreak": longest, "sdR": sd,
        "sharpePerTrade": mean / sd if sd > 0 else None,
    }


def replication_check(trades: int, win_rate: float | None, net_r: float | None, claim: Mapping = CLAIM,
                      tolerance: Mapping = TOLERANCE) -> dict:
    """The pre-registered check: reproduced when the trade count is within 25 % of the claim, the win rate
    within 5 percentage points and the net result within 0.15R per trade. A missing value fails its part."""
    parts = [
        {"metric": "trades", "ours": trades, "claim": claim["trades"],
         "low": claim["trades"] * (1 - tolerance["trades"]), "high": claim["trades"] * (1 + tolerance["trades"])},
        {"metric": "winRate", "ours": win_rate, "claim": claim["winRate"],
         "low": claim["winRate"] - tolerance["winRate"], "high": claim["winRate"] + tolerance["winRate"]},
        {"metric": "netR", "ours": net_r, "claim": claim["netR"],
         "low": claim["netR"] - tolerance["netR"], "high": claim["netR"] + tolerance["netR"]},
    ]
    for part in parts:
        value = part["ours"]
        # A value on the bound counts as inside (1e-12 absorbs the float error of the bound itself).
        part["pass"] = (value is not None and math.isfinite(value)
                        and part["low"] - 1e-12 <= value <= part["high"] + 1e-12)
    return {"reproduced": all(part["pass"] for part in parts), "parts": parts}


def variance_of(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / (len(values) - 1)


def deflated(points: Sequence[Point], n_trials: int, trial_sharpes_per_day: Sequence[float]) -> dict:
    """Deflated Sharpe probability of the daily returns for `n_trials` trials whose per-day Sharpe ratios
    have the variance of `trial_sharpes_per_day`. Fewer than 3 returns or no variation: probability 0."""
    rets = returns_of(points)
    mean = sum(rets) / len(rets) if rets else 0.0
    if len(rets) < 3 or not any(r != mean for r in rets):
        return {"probability": 0.0, "expectedMaxSharpePerDay": 0.0, "sharpePerDay": 0.0, "trials": n_trials,
                "observations": len(rets), "trialVariance": variance_of(trial_sharpes_per_day)}
    out = deflated_sharpe(points, n_trials, trial_sharpes_per_day)
    out["trialVariance"] = variance_of(trial_sharpes_per_day)
    return out


def two_point(win_rate: float, reward_risk: float, mean: float) -> dict:
    """The per-trade distribution with two outcomes (+win with probability `win_rate`, -loss otherwise) that has
    the given win rate, average win / average loss and mean: its outcomes, spread, skew and raw kurtosis."""
    p = win_rate
    edge = p * reward_risk - (1 - p)
    if not (0 < p < 1 and reward_risk > 0 and edge * mean > 0):
        raise ValueError("No two-outcome distribution has this win rate, reward : risk and mean")
    loss = mean / edge
    win = reward_risk * loss
    spread = math.sqrt(p * (1 - p)) * (win + loss)
    return {"win": win, "loss": loss, "mean": mean, "sd": spread, "sharpe": mean / spread,
            "skew": (1 - 2 * p) / math.sqrt(p * (1 - p)), "kurtosis": (1 - 3 * p * (1 - p)) / (p * (1 - p))}


def claim_deflated(n_trials: int, trial_variance: float, claim: Mapping = CLAIM) -> dict:
    """Deflated Sharpe probability of the source's claimed result: `claim['trades']` per-trade observations of
    the two-outcome distribution rebuilt from its win rate, reward : risk and mean; `trial_variance` is the
    variance of the per-trade Sharpe ratios across the trials."""
    shape = two_point(claim["winRate"], claim["rewardRisk"], claim["netR"])
    result = deflated_sharpe_ratio(shape["sharpe"], max(int(n_trials), 2), max(trial_variance, 0.0),
                                   int(claim["trades"]), shape["skew"], shape["kurtosis"])
    return {"probability": result.probability, "expectedMaxSharpePerTrade": result.expected_max_sharpe,
            "sharpePerTrade": shape["sharpe"], "trials": int(n_trials), "observations": int(claim["trades"]),
            "trialVariance": trial_variance, "tStatistic": shape["sharpe"] * math.sqrt(claim["trades"]),
            "distribution": shape}


def quantiles(values: Sequence[float], qs: Sequence[float] = (0.05, 0.25, 0.5, 0.75, 0.95)) -> dict:
    ordered = sorted(v for v in values if math.isfinite(v))
    if not ordered:
        return {f"p{round(q * 100):02d}": None for q in qs}
    return {f"p{round(q * 100):02d}": ordered[min(len(ordered) - 1, max(0, int(q * len(ordered))))] for q in qs}


def share_at_least(values: Sequence[float], level: float | None) -> float | None:
    """Share of `values` at or above `level` (None without values or level)."""
    if level is None or not values:
        return None
    return sum(1 for v in values if v >= level) / len(values)


def week_start(day: str) -> str:
    d = date.fromisoformat(day)
    return (d - timedelta(days=d.weekday())).isoformat()


def weekly_r(dated: Sequence[tuple[str, float]]) -> list[list]:
    """[[Monday of the week, cumulative R at the end of that week]] of (exit date, R) pairs in time order."""
    out: list[list] = []
    total = 0.0
    for day, r in dated:
        if not math.isfinite(r):
            continue
        total += r
        week = week_start(day)
        if out and out[-1][0] == week:
            out[-1][1] = total
        else:
            out.append([week, total])
    return out


def r_curve(days: Sequence[str], dated: Sequence[tuple[str, float]], risk: float = 0.005) -> list[Point]:
    """Daily equity (base 1.0 on the first day) of trades that each risk `risk` of equity: on the day of a
    trade's exit the equity is multiplied by 1 + risk x R. `dated` holds (exit day, R). An approximation of the
    Nautilus curve (which marks open positions daily) for rows that are rules.py arithmetic only."""
    by_day: dict[str, float] = {}
    for day, r in dated:
        if math.isfinite(r):
            by_day[day] = by_day.get(day, 1.0) * (1 + risk * r)
    value = 1.0
    out: list[Point] = []
    for position, day in enumerate(days):
        if position > 0:
            value *= by_day.get(day, 1.0)
        out.append((day, value))
    return out


def trade_returns(trades: Sequence[Mapping]) -> list[float]:
    """Per-trade return on the leg equity before the trade."""
    return [t["pnl"] / t["before"] for t in trades if t.get("before", 0) > 0]


def trade_summary(trades: Sequence[Mapping]) -> dict:
    """Count, win rate and profit factor of booked trades (unit-equity P&L); empty-safe."""
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [-t["pnl"] for t in trades if t["pnl"] <= 0]
    return {"trades": len(trades), "winRate": len(wins) / len(trades) if trades else 0.0,
            "profitFactor": sum(wins) / sum(losses) if losses and sum(losses) > 0 else None}


__all__ = [
    "CLAIM", "CONTROL_SEED", "IS_FRACTION", "MC_PATHS", "MC_SEED", "SOURCE_TRIALS", "SOURCE_TRIALS_WITH_CONTROLS",
    "TOLERANCE", "claim_deflated", "combine", "deflated", "deflated_sharpe_ratio", "drawdown_series",
    "expected_max_sharpe", "flat", "moments", "monte_carlo", "monthly", "quantiles", "r_curve", "r_stats", "rebase",
    "replication_check", "returns_of", "share_at_least", "split", "split_summary", "stats", "sum_legs",
    "trade_returns", "trade_summary", "two_point", "variance_of", "walk_forward", "week_start", "weekly_r",
    "window", "window_base",
]
