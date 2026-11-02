"""OLS, abnormal returns, inclusive CAR, t-test and percentile bootstrap.

Adapted from AI Hedge Fund v2/event_study/stats.py, SHA256
ca6939d89a5809e6b838d1125dd142a42339502cccdfb495eed1e04ff38f921f.
Model fields derive from v2/event_study/models.py, SHA256
aeda6a0113013d0aabf45e0b960543fb11559bc54225e84e655fcd40de0d4dcb.
Copyright (c) 2024 Virat Singh. MIT; see AI_HEDGE_FUND_LICENSE.txt.

Original least-squares, inclusive windows, sample t-test and percentile-bootstrap
math retained. Added finite/rank/sample/budget checks, immutable internal results,
mandatory seed, bounded allocation and lazy optional numerical dependencies.
These floating-point diagnostics are NOT canonical public economic amounts.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


class NumericUnavailable(RuntimeError):
    """Optional numpy/scipy backend has not been supplied by the application."""


class NumericInconclusive(ValueError):
    """Insufficient, singular, nonfinite or degenerate statistical sample."""


@dataclass(frozen=True)
class MarketModelFit:
    alpha: float
    beta: float
    r_squared: float
    n_obs: int


@dataclass(frozen=True)
class BootstrapCI:
    lower: float
    upper: float
    confidence: float
    n_bootstrap: int
    rng_seed: int


@dataclass(frozen=True)
class TTestResult:
    t_stat: float | None
    p_value: float | None
    n_obs: int
    status: str


def _numpy() -> Any:
    try:
        import numpy
    except ImportError as exc:
        raise NumericUnavailable("optional numpy dependency unavailable") from exc
    return numpy


def _values(values: Sequence[float], *, minimum: int = 1, maximum: int = 250_000) -> tuple[float, ...]:
    if not minimum <= len(values) <= maximum:
        raise NumericInconclusive("numeric sample count outside permitted bounds")
    result = tuple(float(value) for value in values)
    if any(not math.isfinite(value) for value in result):
        raise NumericInconclusive("nonfinite numeric sample")
    return result


def fit_market_model(stock_returns: Sequence[float], market_returns: Sequence[float]) -> MarketModelFit:
    """OLS R_stock = alpha + beta * R_market on the declared estimation window."""
    stocks, market = _values(stock_returns, minimum=3), _values(market_returns, minimum=3)
    if len(stocks) != len(market):
        raise NumericInconclusive("unaligned return vectors")
    np = _numpy()
    stock = np.asarray(stocks, dtype=float)
    benchmark = np.asarray(market, dtype=float)
    # Design matrix: column of 1s (intercept) + market returns (slope).
    matrix = np.column_stack([np.ones(len(stock)), benchmark])
    coefficients, _, rank, _ = np.linalg.lstsq(matrix, stock, rcond=None)
    if rank != 2:
        raise NumericInconclusive("singular benchmark market model")
    alpha, beta = float(coefficients[0]), float(coefficients[1])
    predicted = alpha + beta * benchmark
    ss_res = float(np.sum((stock - predicted) ** 2))
    ss_tot = float(np.sum((stock - stock.mean()) ** 2))
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    if not all(math.isfinite(value) for value in (alpha, beta, r_squared)):
        raise NumericInconclusive("nonfinite market model")
    return MarketModelFit(alpha, beta, r_squared, len(stocks))


def compute_abnormal_returns(
    stock_returns: Sequence[float], market_returns: Sequence[float], alpha: float, beta: float,
) -> tuple[float, ...]:
    """AR_t = R_stock,t - (alpha + beta * R_market,t), without cost/fill claims."""
    stock, benchmark = _values(stock_returns), _values(market_returns)
    if len(stock) != len(benchmark) or not all(math.isfinite(value) for value in (alpha, beta)):
        raise NumericInconclusive("unaligned returns or invalid model")
    return _values(tuple(value - (alpha + beta * market) for value, market in zip(stock, benchmark, strict=True)))


def sum_car(daily_ar: Sequence[float], start: int, end: int) -> float:
    """Sum [start,end] inclusive; unavailable windows are NOT truncated silently."""
    values = _values(daily_ar)
    if type(start) is not int or type(end) is not int or not 0 <= start <= end < len(values):
        raise NumericInconclusive("CAR window incomplete")
    result = math.fsum(values[start:end + 1])
    if not math.isfinite(result):
        raise NumericInconclusive("nonfinite CAR")
    return result


def ttest_cars(cars: Sequence[float]) -> TTestResult:
    """Two-sided one-sample t-test vs zero, not proof of profitable event causality.

    Unlike the source's (0,1) fallback, insufficient/constant samples explicitly
    remain inconclusive. No significance assertion is fabricated from NaN/Inf.
    """
    values = _values(cars, minimum=0)
    if len(values) < 2 or len(set(values)) < 2:
        return TTestResult(None, None, len(values), "inconclusive")
    try:
        from scipy import stats
    except ImportError as exc:
        raise NumericUnavailable("optional scipy dependency unavailable") from exc
    t_stat, p_value = stats.ttest_1samp(values, popmean=0.0)
    if not math.isfinite(float(t_stat)) or not math.isfinite(float(p_value)):
        return TTestResult(None, None, len(values), "inconclusive")
    return TTestResult(float(t_stat), float(p_value), len(values), "descriptive")


def bootstrap_ci(
    cars: Sequence[float], *, n_bootstrap: int = 10_000, confidence: float = 0.95,
    rng_seed: int, maximum_draws: int = 5_000_000,
) -> BootstrapCI:
    """Seeded percentile interval for mean CAR under IID-event resampling.

    This is not a block/cluster bootstrap. Serial/cross-event correlation and
    multiple comparisons need independent evidence before any inference claim.
    """
    values = _values(cars, minimum=2)
    if type(n_bootstrap) is not int or not 2 <= n_bootstrap <= 100_000:
        raise NumericInconclusive("bootstrap replicate budget invalid")
    if type(maximum_draws) is not int or not 1 <= maximum_draws <= 10_000_000:
        raise NumericInconclusive("bootstrap draw budget invalid")
    if len(values) * n_bootstrap > maximum_draws:
        raise NumericInconclusive("bootstrap draw budget exceeded")
    if type(rng_seed) is not int or not 0 <= rng_seed <= 2**32 - 1:
        raise NumericInconclusive("explicit bounded random seed required")
    if not math.isfinite(confidence) or not 0 < confidence < 1:
        raise NumericInconclusive("confidence must lie strictly between zero and one")
    np = _numpy()
    rng = np.random.default_rng(rng_seed)
    sample = np.asarray(values, dtype=float)
    means = np.empty(n_bootstrap, dtype=float)
    for index in range(n_bootstrap):
        means[index] = rng.choice(sample, size=len(sample), replace=True).mean()
    lower, upper = np.percentile(means, [(1 - confidence) / 2 * 100, (1 + confidence) / 2 * 100])
    if not math.isfinite(float(lower)) or not math.isfinite(float(upper)):
        raise NumericInconclusive("nonfinite bootstrap interval")
    return BootstrapCI(float(lower), float(upper), confidence, n_bootstrap, rng_seed)
