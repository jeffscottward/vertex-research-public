"""Run statistics of the qc-ports options runner (research only).

- CAGR over calendar time between the first and the last run day.
- Sharpe: daily returns, rf 0, sample std, annualized by sqrt(252).
- Deflated Sharpe (Bailey and Lopez de Prado 2014) through
  backtesting.optimizer.deflated_sharpe_ratio with the real number of trials
  of the search; per-observation Sharpe, sample skew and raw kurtosis of the
  daily returns. The variance of the trial Sharpes is the caller's (measured
  over the trials) or, without it, the sampling variance of the Sharpe
  estimator (1 - skew*SR + (kurt-1)/4*SR^2) / (T - 1). With one trial the
  benchmark is 0 (probabilistic Sharpe).
- Max drawdown, worst calendar month (month-end equity over the previous
  month-end, the first month over the start), trades, win rate (pnl > 0) and
  exposure (share of days ending with an open trade).
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import date
from statistics import NormalDist

from backtesting.optimizer import deflated_sharpe_ratio

from .ledger import LedgerResult

__all__ = ["TRADING_DAYS", "max_drawdown", "summarize", "worst_month"]

TRADING_DAYS = 252
DAYS_PER_YEAR = 365.25


def max_drawdown(equity: Sequence[float]) -> float:
    peak, worst = equity[0], 0.0
    for value in equity:
        peak = max(peak, value)
        worst = min(worst, value / peak - 1)
    return worst


def worst_month(dates: Sequence[str], equity: Sequence[float], start: float) -> tuple[str, float] | None:
    month_end: dict[str, float] = {}
    for day, value in zip(dates, equity):
        month_end[day[:7]] = value
    worst = None
    previous = start
    for month, value in month_end.items():
        change = value / previous - 1
        if worst is None or change < worst[1]:
            worst = (month, change)
        previous = value
    return worst


def _moments(returns: Sequence[float]) -> tuple[float, float, float, float]:
    """mean, sample std, skew and raw (non-excess) kurtosis (population moments)."""
    n = len(returns)
    mean = sum(returns) / n
    if n < 2:
        return mean, 0.0, 0.0, 3.0
    m2 = sum((x - mean) ** 2 for x in returns) / n
    m3 = sum((x - mean) ** 3 for x in returns) / n
    m4 = sum((x - mean) ** 4 for x in returns) / n
    std = math.sqrt(m2 * n / (n - 1))
    if m2 <= 0:
        return mean, std, 0.0, 3.0
    return mean, std, m3 / m2 ** 1.5, m4 / m2 ** 2


def _deflated(sharpe: float, n_trials: int, variance: float | None, n: int, skew: float, kurt: float) -> dict:
    radicand = 1 - skew * sharpe + (kurt - 1) / 4 * sharpe ** 2
    if variance is None:
        variance = radicand / (n - 1)
    if n_trials >= 2:
        result = deflated_sharpe_ratio(sharpe, n_trials, variance, n, skew, kurt)
        return {"deflatedSharpe": result.probability, "expectedMaxSharpe": result.expected_max_sharpe,
                "sharpeVariance": variance}
    z = sharpe * math.sqrt(n - 1) / math.sqrt(radicand)
    return {"deflatedSharpe": NormalDist().cdf(z), "expectedMaxSharpe": 0.0, "sharpeVariance": variance}


def summarize(result: LedgerResult, n_trials: int, sharpe_variance: float | None = None) -> dict:
    """Statistics of one run. `n_trials` = configurations tried in the search that produced it."""
    if isinstance(n_trials, bool) or not isinstance(n_trials, int) or n_trials < 1:
        raise ValueError("n_trials must be an integer >= 1")
    dates, equity = result.dates, result.equity
    if len(equity) < 2:
        raise ValueError("Need at least two run days")
    years = (_ordinal(dates[-1]) - _ordinal(dates[0])) / DAYS_PER_YEAR
    returns = [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity))]
    trades = result.trades
    wins = sum(1 for trade in trades if trade["pnl"] > 0)
    month = worst_month(dates, equity, result.capital)
    stats = {
        "start": dates[0], "end": dates[-1], "days": len(dates),
        "finalEquity": equity[-1], "totalReturn": equity[-1] / result.capital - 1,
        "cagr": (equity[-1] / result.capital) ** (1 / years) - 1 if years > 0 and equity[-1] > 0 else None,
        "sharpe": None, "deflatedSharpe": None, "expectedMaxSharpe": None, "sharpeVariance": None,
        "nTrials": n_trials, "maxDrawdown": max_drawdown([result.capital, *equity]),
        "worstMonth": None if month is None else month[0], "worstMonthReturn": None if month is None else month[1],
        "trades": len(trades), "winRate": wins / len(trades) if trades else None,
        "exposure": sum(1 for count in result.open_positions if count > 0) / len(dates),
        "skipped": len(result.skipped),
    }
    mean, std, skew, kurt = _moments(returns)
    if std > 0:
        sharpe = mean / std
        stats["sharpe"] = sharpe * math.sqrt(TRADING_DAYS)
        stats.update(_deflated(sharpe, n_trials, sharpe_variance, len(returns), skew, kurt))
    return stats


def _ordinal(day: str) -> int:
    return date.fromisoformat(day).toordinal()
