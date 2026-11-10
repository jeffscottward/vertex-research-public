"""Forward outcomes of a day and the small-sample statistics of the regime flag tests (rules O1 to O6)."""
from __future__ import annotations

import math
import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

HORIZON = 30  # "six weeks" in trading days (rule O1)
HIT = -0.046  # the source's bar for a drop (rule O3)


@dataclass(frozen=True, slots=True)
class Outcome:
    index: int
    fwd: float  # close-to-close return over the horizon
    mdd: float  # lowest close in the horizon against the close of the day; 0 when none is lower
    hit: bool


@dataclass(frozen=True, slots=True)
class Group:
    n: int
    hits: int
    hit_rate: float
    mean_fwd: float
    median_fwd: float
    mean_mdd: float
    smallest_drop: float  # the mdd closest to zero


def outcome(closes: Sequence[float], t: int, horizon: int = HORIZON, bar: float = HIT) -> Outcome | None:
    """The outcome of day ``t``; None while its window is open (rule O4)."""
    if t < 0 or t + horizon >= len(closes):
        return None
    base = closes[t]
    lowest = min(closes[t + 1 : t + horizon + 1])
    mdd = min(0.0, lowest / base - 1.0)
    return Outcome(index=t, fwd=closes[t + horizon] / base - 1.0, mdd=mdd, hit=mdd <= bar)


def outcomes(closes: Sequence[float], days: Iterable[int], horizon: int = HORIZON, bar: float = HIT) -> list[Outcome]:
    """Outcomes of the days with a complete window."""
    found = (outcome(closes, t, horizon, bar) for t in days)
    return [item for item in found if item is not None]


def group(items: Sequence[Outcome]) -> Group | None:
    if not items:
        return None
    hits = sum(1 for item in items if item.hit)
    fwd = [item.fwd for item in items]
    drops = [item.mdd for item in items]
    return Group(n=len(items), hits=hits, hit_rate=hits / len(items), mean_fwd=statistics.fmean(fwd),
                 median_fwd=statistics.median(fwd), mean_mdd=statistics.fmean(drops), smallest_drop=max(drops))


def binomial_tail(k: int, n: int, p: float) -> float:
    """Exact P(X >= k) for X ~ Binomial(n, p) (rule O5)."""
    if not 0 <= k <= n or not 0.0 <= p <= 1.0:
        raise ValueError("need 0 <= k <= n and 0 <= p <= 1")
    return min(1.0, math.fsum(math.comb(n, i) * p**i * (1.0 - p) ** (n - i) for i in range(k, n + 1)))


def normal_tail(z: float) -> float:
    """P(Z >= z) for a standard normal Z."""
    return 1.0 - statistics.NormalDist().cdf(z)


def spearman_p(rho: float, n: int) -> float:
    """One-sided p-value of a positive rank correlation, normal approximation (rule O6)."""
    return normal_tail(rho * math.sqrt(n - 1))


def mean_below_p(low: Sequence[float], high: Sequence[float]) -> float:
    """One-sided p-value that the mean of ``low`` is below the mean of ``high`` (Welch, rule O6)."""
    if len(low) < 2 or len(high) < 2:
        raise ValueError("need at least 2 values on each side")
    error = math.sqrt(statistics.variance(low) / len(low) + statistics.variance(high) / len(high))
    if error == 0.0:
        return 0.5
    return normal_tail((statistics.fmean(high) - statistics.fmean(low)) / error)


def benjamini_hochberg(p_values: Sequence[float], q: float = 0.05) -> int:
    """How many of the p-values the Benjamini-Hochberg step-up rule rejects at false discovery rate ``q``."""
    ordered = sorted(p_values)
    return max((rank for rank, p in enumerate(ordered, start=1) if p <= q * rank / len(ordered)), default=0)
