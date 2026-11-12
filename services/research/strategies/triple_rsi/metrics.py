"""Measures, robustness checks and gates of the Triple RSI study (research only).

Equity measures reuse the qc-ports helpers (`qc_ports.metrics.summarize`: CAGR, Sharpe, deflated Sharpe, maximum
drawdown; `qc_ports.allocation`: out-of-sample Sharpe of the last 40% of the days, the trade-P&L Monte Carlo and
the strict gate checks G3 to G7). Added here: trade measures, a compounding Monte Carlo of trade returns (shares,
100% of equity), the anchored walk-forward of the parameter pick, and the owner's lower bar.
"""
from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from datetime import date
from statistics import mean, stdev

from strategies.qc_ports import allocation as al
from strategies.qc_ports.ledger import LedgerResult
from strategies.qc_ports.metrics import DAYS_PER_YEAR, summarize

__all__ = ["BASELINE_CHECK", "LOWER_BAR", "MONTE_CARLO_PATHS", "TRADING_DAYS", "WALK_FORWARD_FOLDS", "daily_returns", "drawdown_curve",
           "equity_stats", "gate", "lower_bar", "monte_carlo_returns", "sharpe", "trade_stats", "walk_forward"]

TRADING_DAYS = al.TRADING_DAYS
MONTE_CARLO_PATHS = 10_000
WALK_FORWARD_FOLDS = 5
# The owner's lower bar of 2026-11-11 (research/backtests/allocation/funded_pie.py LOWER_BAR; the study run checks
# that both are equal).
LOWER_BAR = {"minSharpe": 0.3, "minOosSharpe": 0.0, "minMonteCarloProfit": 0.8, "maxDrawdown": -0.25, "minTrades": 30}


def daily_returns(equity: Sequence[float]) -> list[float]:
    return al.daily_returns(equity)


def sharpe(returns: Sequence[float]) -> float:
    return al.sharpe(returns)


def drawdown_curve(equity: Sequence[float]) -> list[float]:
    peak, out = -math.inf, []
    for value in equity:
        peak = max(peak, value)
        out.append(value / peak - 1)
    return out


def trade_stats(trades: Sequence[Mapping]) -> dict:
    """Trade measures. `return` is the net trade return (shares) or the return on risk (options)."""
    count = len(trades)
    if count == 0:
        return {"trades": 0, "winRate": None, "averageReturn": None, "averageWin": None, "averageLoss": None,
                "profitFactor": None, "worstTrade": None, "bestTrade": None, "averageHoldDays": None}
    returns = [float(trade["return"]) for trade in trades]
    wins = [trade["pnl"] for trade in trades if trade["pnl"] > 0]
    losses = [trade["pnl"] for trade in trades if trade["pnl"] < 0]
    won = [value for value in returns if value > 0]
    lost = [value for value in returns if value < 0]
    return {
        "trades": count,
        "winRate": len(wins) / count,
        "averageReturn": mean(returns),
        "averageWin": mean(won) if won else None,
        "averageLoss": mean(lost) if lost else None,
        "profitFactor": sum(wins) / -sum(losses) if losses else None,
        "worstTrade": min(returns),
        "bestTrade": max(returns),
        "averageHoldDays": mean(float(trade["holdDays"]) for trade in trades),
    }


def monte_carlo_returns(returns: Sequence[float], *, paths: int | None = None, seed: int = 1) -> dict | None:
    """Bootstrap of compounded trade returns (with replacement, the same trade count per path).

    Returns the share of paths that end above the start, the 5th percentile and the worst of the path maximum
    drawdowns (trade to trade, negative numbers; the keys of allocation.monte_carlo) and the median end multiple;
    None without trades.
    """
    if not returns:
        return None
    paths = MONTE_CARLO_PATHS if paths is None else paths
    rng = random.Random(seed)
    count = len(returns)
    profitable = 0
    drawdowns, finals = [], []
    for _ in range(paths):
        equity = peak = 1.0
        worst = 0.0
        for _step in range(count):
            equity *= 1 + returns[rng.randrange(count)]
            peak = max(peak, equity)
            worst = min(worst, equity / peak - 1)
        profitable += equity > 1.0
        drawdowns.append(worst)
        finals.append(equity)
    drawdowns.sort()
    finals.sort()
    return {"paths": paths, "probabilityOfProfit": profitable / paths,
            "drawdownP5": al._percentile(drawdowns, 0.05), "worstDrawdown": drawdowns[0],
            "medianMultiple": al._percentile(finals, 0.5)}


def equity_stats(result: LedgerResult, *, n_trials: int, sharpe_variance: float | None, carlo: dict | None,
                 trades: Sequence[Mapping] | None = None) -> dict:
    """Equity and trade measures of one run, with the out-of-sample Sharpe and a Monte Carlo result. `trades`:
    the trade rows for trade_stats (default: the result's trades)."""
    base = summarize(result, n_trials=n_trials, sharpe_variance=sharpe_variance)
    oos_start, oos = al.out_of_sample_sharpe(result)
    returns = daily_returns(result.equity)
    split = result.dates.index(oos_start)
    base_value = result.equity[split - 1] if split > 0 else result.capital
    oos_years = (date.fromisoformat(result.dates[-1]) - date.fromisoformat(result.dates[split - 1 if split > 0 else 0])
                 ).days / DAYS_PER_YEAR
    oos_cagr = (result.equity[-1] / base_value) ** (1 / oos_years) - 1 if oos_years > 0 else None
    return {
        **{key: base[key] for key in ("start", "end", "days", "finalEquity", "totalReturn", "cagr", "sharpe",
                                      "deflatedSharpe", "expectedMaxSharpe", "nTrials", "maxDrawdown",
                                      "worstMonth", "worstMonthReturn", "exposure")},
        "volatility": stdev(returns) * math.sqrt(TRADING_DAYS) if len(returns) > 1 else 0.0,
        "oosStart": oos_start, "oosSharpe": oos, "oosCagr": oos_cagr, "monteCarlo": carlo,
        **trade_stats(result.trades if trades is None else trades),
    }


BASELINE_CHECK = "G7 Sharpe above its always-on baseline"


def gate(stats: Mapping, baseline_sharpe: float | None) -> list[dict]:
    """The strict gate checks G3 to G7 of qc_ports.allocation (AUTOPILOT_GATE thresholds) of a strategy row. A
    strategy row always has the baseline check: without a baseline Sharpe it fails (allocation.gate_checks would drop
    it, which is right only for a row that is itself a baseline)."""
    checks = al.gate_checks(dict(stats), baseline_sharpe)
    if baseline_sharpe is None:
        checks.append({"check": BASELINE_CHECK, "pass": False, "value": None})
    return checks


def lower_bar(stats: Mapping) -> bool:
    carlo = stats.get("monteCarlo") or {}
    sharpe_value, oos = stats.get("sharpe"), stats.get("oosSharpe")
    return (sharpe_value is not None and sharpe_value >= LOWER_BAR["minSharpe"]
            and oos is not None and oos > LOWER_BAR["minOosSharpe"]
            and (carlo.get("probabilityOfProfit") or 0.0) >= LOWER_BAR["minMonteCarloProfit"]
            and stats.get("maxDrawdown") is not None and stats["maxDrawdown"] >= LOWER_BAR["maxDrawdown"]
            and (stats.get("trades") or 0) >= LOWER_BAR["minTrades"])


def fold_bounds(days: int, folds: int = WALK_FORWARD_FOLDS) -> list[int]:
    """Day indices that cut `days` run days into `folds` equal parts (by day count): [0, b1, ..., days]."""
    if folds < 2 or days < folds * 2:
        raise ValueError("Need at least two folds of two days")
    return [days * k // folds for k in range(folds + 1)]


def walk_forward(equities: Mapping[str, Sequence[float]], fixed: str, *,
                 folds: int = WALK_FORWARD_FOLDS) -> dict:
    """Anchored walk-forward of the parameter pick.

    `equities`: variant key -> daily equity on the same run days. In fold k (k = 1 .. folds-1) the variant with
    the best Sharpe on days [0, b_k) is picked and traded on days [b_k, b_k+1). Returns the picks, the Sharpe of
    the joined out-of-sample days for the picks and for the `fixed` variant, and the share of folds in which the
    picked variant's out-of-sample return was above 0.
    """
    sizes = {len(values) for values in equities.values()}
    if len(sizes) != 1:
        raise ValueError("Every variant must have the same run days")
    days = sizes.pop()
    bounds = fold_bounds(days, folds)
    picks, joined, joined_fixed, positive = [], [], [], 0
    for k in range(1, folds):
        start, end = bounds[k], bounds[k + 1]
        best = max(sorted(equities), key=lambda key: sharpe(daily_returns(equities[key][:start])))
        picked = daily_returns(equities[best][start - 1:end])
        held = daily_returns(equities[fixed][start - 1:end])
        joined.extend(picked)
        joined_fixed.extend(held)
        fold_return = equities[best][end - 1] / equities[best][start - 1] - 1
        positive += fold_return > 0
        picks.append({"fold": k, "inSampleDays": start, "outOfSampleDays": end - start, "pick": best,
                      "outOfSampleSharpe": sharpe(picked), "fixedSharpe": sharpe(held),
                      "outOfSampleReturn": fold_return,
                      "fixedReturn": equities[fixed][end - 1] / equities[fixed][start - 1] - 1})
    return {"folds": folds, "picks": picks, "outOfSampleSharpe": sharpe(joined),
            "fixedOutOfSampleSharpe": sharpe(joined_fixed), "positiveFolds": positive, "testedFolds": folds - 1}
