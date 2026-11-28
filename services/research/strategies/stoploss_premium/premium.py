"""Stopping premium of an exit rule and the fixed pass/fail tests of the backtest plan.

Kaminski and Lo (2014), equation 4: the stopping premium is the change in expected return that the exit rule
causes, dmu = p0 x (rf - E[r | stopped out]), with p0 the share of time the rule holds the capital out of the
strategy. Here both legs are daily return series of the same entries, so dmu is measured directly as the
difference of the annualized means (after costs); E[r | stopped out] is the value that equation 4 implies.

Pass/fail tests (fixed before any run, report section "Backtest plan"):
  * fewer than MIN_STOP_EVENTS stop events -> "not enough data";
  * "adds return": dmu > 0, the block-bootstrap 90% interval above 0, dmu > 0 in both halves of the sample and
    with the threshold moved -25% and +25%;
  * "paid insurance": dmu <= 0 and the maximum drawdown falls by at least 10% of its value;
  * "fail": dmu < 0 with the interval below 0, and the maximum drawdown does not fall by 10%;
  * any other case meets none of the three tests -> "inconclusive" (the plan defines no outcome beyond
    "not enough data" and the three above, so this module names the gap instead of forcing a result).
A variant without a threshold check (a comparison row) can never pass "adds return".
The sufficient condition (rho >= Sharpe at the stop's step), p0 and the drawdown cut per half are reported
for interpretation only; they do not change the verdict.
"""
from __future__ import annotations

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass

from strategies.qc_ports.metrics import max_drawdown as qc_max_drawdown

TRADING_DAYS = 252
MIN_STOP_EVENTS = 100
BLOCK_DAYS = 21
BOOTSTRAP_REPS = 1000
INTERVAL = 0.90
DRAWDOWN_CUT = 0.10

ADDS_RETURN = "pass: adds return"
PAID_INSURANCE = "pass: paid insurance"
FAIL = "fail"
NOT_ENOUGH = "not enough data"
INCONCLUSIVE = "inconclusive"


@dataclass(frozen=True)
class Legs:
    """Daily series of one test, aligned by day. `out` is the share of the strategy's capital that the rule
    holds outside the strategy on that day (0..1); its mean is p0."""

    dates: tuple[str, ...]
    with_rule: tuple[float, ...]
    without: tuple[float, ...]
    rf: tuple[float, ...]
    out: tuple[float, ...]
    stop_events: int
    stop_days: int = 0  # distinct calendar days with at least one stop event (episodes, not rungs)

    def __post_init__(self) -> None:
        n = len(self.dates)
        if not n:
            raise ValueError("a test needs at least one day")
        if any(len(s) != n for s in (self.with_rule, self.without, self.rf, self.out)):
            raise ValueError("every daily series must have one value per date")
        if self.stop_events < 0:
            raise ValueError("stop events cannot be negative")

    def part(self, lo: int, hi: int) -> Legs:
        """Days lo..hi-1; the stop-event count is not split (it belongs to the whole sample)."""
        return Legs(self.dates[lo:hi], self.with_rule[lo:hi], self.without[lo:hi], self.rf[lo:hi],
                    self.out[lo:hi], self.stop_events, self.stop_days)


def mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def annual_mean(returns: Sequence[float]) -> float:
    return mean(returns) * TRADING_DAYS


def annual_vol(returns: Sequence[float]) -> float:
    if len(returns) < 2:
        return 0.0
    m = mean(returns)
    return math.sqrt(sum((r - m) ** 2 for r in returns) / (len(returns) - 1) * TRADING_DAYS)


def max_drawdown(returns: Sequence[float]) -> float:
    """Largest fall from a peak of the compounded curve, as a negative fraction (0 when it never falls);
    `qc_ports.metrics.max_drawdown` on the equity curve that starts at 1."""
    equity = [1.0]
    for r in returns:
        equity.append(equity[-1] * (1 + r))
    return qc_max_drawdown(equity)


def compound(returns: Sequence[float], step: int) -> list[float]:
    """Non-overlapping `step`-day compounded returns (a last incomplete block is dropped)."""
    if step < 1:
        raise ValueError("step must be at least 1 day")
    out = []
    for i in range(0, len(returns) - step + 1, step):
        level = 1.0
        for r in returns[i:i + step]:
            level *= 1 + r
        out.append(level - 1)
    return out


def autocorrelation(xs: Sequence[float]) -> float | None:
    """Lag-1 serial correlation; None with fewer than 3 values or no variance."""
    if len(xs) < 3:
        return None
    m = mean(xs)
    den = sum((x - m) ** 2 for x in xs)
    if den == 0:
        return None
    return sum((xs[i] - m) * (xs[i - 1] - m) for i in range(1, len(xs))) / den


def step_condition(legs: Legs, step: int) -> dict:
    """The paper's sufficient condition at the stop's time step: serial correlation rho of the strategy
    without the rule against its Sharpe ratio at the same step (equations 17-18, AR(1) model)."""
    r = compound(legs.without, step)
    f = compound(legs.rf, step)
    excess = [a - b for a, b in zip(r, f)]
    rho = autocorrelation(r)
    sd = math.sqrt(sum((x - mean(excess)) ** 2 for x in excess) / (len(excess) - 1)) if len(excess) > 1 else 0.0
    sharpe = mean(excess) / sd if sd > 0 else None
    met = None if rho is None or sharpe is None else rho >= sharpe
    return {"stepDays": step, "rho": rho, "sharpe": sharpe, "met": met, "periods": len(r)}


def block_bootstrap(diff: Sequence[float], *, block: int = BLOCK_DAYS, reps: int = BOOTSTRAP_REPS,
                    level: float = INTERVAL, seed: int = 7) -> tuple[float, float]:
    """Circular block bootstrap of the annualized mean of a daily series: (low, high) of the central
    `level` interval. A fixed seed makes each run reproducible."""
    n = len(diff)
    if n == 0:
        raise ValueError("the bootstrap needs at least one day")
    block = max(1, min(block, n))
    rng = random.Random(seed)
    blocks = math.ceil(n / block)
    means = []
    for _ in range(reps):
        total, count = 0.0, 0
        for _b in range(blocks):
            start = rng.randrange(n)
            for j in range(block):
                if count == n:
                    break
                total += diff[(start + j) % n]
                count += 1
        means.append(total / n * TRADING_DAYS)
    means.sort()
    tail = (1 - level) / 2
    lo = means[max(0, int(math.floor(tail * reps)))]
    hi = means[min(reps - 1, int(math.ceil((1 - tail) * reps)) - 1)]
    return lo, hi


def premium(legs: Legs) -> float:
    """Stopping premium per year: annualized mean with the rule minus without it (after costs)."""
    return annual_mean(legs.with_rule) - annual_mean(legs.without)


def halves(legs: Legs) -> tuple[float, float]:
    mid = len(legs.dates) // 2
    return premium(legs.part(0, mid)), premium(legs.part(mid, len(legs.dates)))


def summary(legs: Legs, step: int, *, seed: int = 7, interval: tuple[float, float] | None = None) -> dict:
    """Every number the plan asks for, for one test variant. `interval` skips the bootstrap (a caller that
    rescales a book whose interval is already known)."""
    diff = [a - b for a, b in zip(legs.with_rule, legs.without)]
    dmu = premium(legs)
    lo, hi = interval if interval is not None else block_bootstrap(diff, seed=seed)
    p0 = mean(legs.out)
    rf = annual_mean(legs.rf)
    mdd_with, mdd_without = max_drawdown(legs.with_rule), max_drawdown(legs.without)
    first, second = halves(legs)
    mid = len(legs.dates) // 2
    cut_halves = [_cut(max_drawdown(part.with_rule), max_drawdown(part.without))
                  for part in (legs.part(0, mid), legs.part(mid, len(legs.dates)))]
    return {
        "days": len(legs.dates), "start": legs.dates[0], "end": legs.dates[-1],
        "stopEvents": legs.stop_events, "stopDays": legs.stop_days,
        "meanWith": annual_mean(legs.with_rule), "meanWithout": annual_mean(legs.without), "rf": rf,
        "premium": dmu, "interval": [lo, hi], "halves": [first, second],
        "volWith": annual_vol(legs.with_rule), "volWithout": annual_vol(legs.without),
        "mddWith": mdd_with, "mddWithout": mdd_without, "drawdownCutHalves": cut_halves,
        "p0": p0,
        # equation 4 solved for E[r | stopped out]: rf - dmu / p0 (only when the rule is out some of the time)
        "impliedStoppedReturn": rf - dmu / p0 if p0 > 0 else None,
        "condition": step_condition(legs, step),
    }


def _cut(mdd_with: float, mdd_without: float) -> float:
    base = abs(mdd_without)
    return (base - abs(mdd_with)) / base if base > 0 else 0.0


def drawdown_cut(s: dict) -> float:
    """Share of the maximum drawdown that the rule removes (0.25 = a quarter smaller)."""
    return _cut(s["mddWith"], s["mddWithout"])


def verdict(s: dict, threshold_premiums: Sequence[float] | None) -> str:
    """Apply the fixed tests to one summary and the premiums of the -25% / +25% threshold variants.
    None or an empty list = no threshold check (a comparison row): it can never pass "adds return"."""
    if s["stopEvents"] < MIN_STOP_EVENTS:
        return NOT_ENOUGH
    dmu, (lo, hi) = s["premium"], s["interval"]
    robust = bool(threshold_premiums) and all(t > 0 for t in threshold_premiums or [])
    if dmu > 0 and lo > 0 and all(h > 0 for h in s["halves"]) and robust:
        return ADDS_RETURN
    cut = drawdown_cut(s)
    if dmu <= 0 and cut >= DRAWDOWN_CUT:
        return PAID_INSURANCE
    if dmu < 0 and hi < 0 and cut < DRAWDOWN_CUT:
        return FAIL
    return INCONCLUSIVE


def insurance_cost(s: dict) -> float | None:
    """Return given up per year for each percentage point of maximum drawdown removed (None if none removed)."""
    removed = abs(s["mddWithout"]) - abs(s["mddWith"])
    if removed <= 0:
        return None
    return -s["premium"] / (removed * 100)
