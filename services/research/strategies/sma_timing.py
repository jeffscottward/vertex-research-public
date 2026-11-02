"""Moving average market timing: hold the market above its N-day simple moving average, else T-bills.

Research only. Pure functions over daily return series; no orders, no network, no file access.
Spec: docs/specs/strategies/sma30-market-timing.md. Runner: research/backtests/sma30-timing/run.py.

Rules (basis codes are in the spec):
* Level: a total-return index built from daily market returns (starts at 1.0 before day 0).
* Signal at the close of day t: in when level(t) > SMA_N(t), out when level(t) < SMA_N(t); an exact
  tie keeps the previous state. SMA_N(t) is the mean of the N levels t-N+1..t. Before the first full
  window the state is "in" (the warm-up days equal buy-and-hold).
* Position: ``lag`` days after the signal. lag=1 is the primary test (signal at the close of t, hold
  the new position for the return of day t+1). lag=0 earns day t's return with day t's close signal;
  it uses information that is not available before that close (look-ahead) and is reported only to
  show the size of that bias.
* Out of the market the strategy earns the cash return (T-bill rate).
* Cost: a fraction of equity is lost on every day the position changes (one switch = one trade).
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

YEAR = 252


@dataclass(frozen=True, slots=True)
class Stats:
    days: int
    final_wealth: float  # growth of 1.0
    cagr: float
    volatility: float  # annualized standard deviation of daily returns
    sharpe: float  # annualized mean / standard deviation of daily returns in excess of cash
    max_drawdown: float  # negative fraction, e.g. -0.3952
    trades: int  # position changes inside the period
    fraction_out: float  # share of days the position is out of the market


def total_return_index(returns: Sequence[float]) -> list[float]:
    level, out = 1.0, []
    for r in returns:
        level *= 1.0 + r
        out.append(level)
    return out


def sma_states(levels: Sequence[float], window: int) -> list[int]:
    """State (1 = in, 0 = out) decided at the close of each day."""
    if window < 1:
        raise ValueError("window must be at least 1")
    states, state, running = [], 1, 0.0
    for t, level in enumerate(levels):
        running += level
        if t >= window:
            running -= levels[t - window]
        if t >= window - 1:
            average = running / window
            if level > average:
                state = 1
            elif level < average:
                state = 0
        states.append(state)
    return states


def positions(states: Sequence[int], lag: int) -> list[int]:
    """Position held over each day's return; days before the first signal are invested."""
    if lag < 0:
        raise ValueError("lag must be at least 0")
    shift = min(lag, len(states))
    return [1] * shift + list(states[: len(states) - shift])


def strategy_returns(asset: Sequence[float], cash: Sequence[float], held: Sequence[int],
                     cost: float, previous: int = 1) -> tuple[list[float], int]:
    """Daily returns and the number of position changes. ``previous`` is the position before day 0."""
    if not len(asset) == len(cash) == len(held):
        raise ValueError("series lengths differ")
    out, trades = [], 0
    for a, c, p in zip(asset, cash, held, strict=True):
        r = a if p else c
        if p != previous:
            trades += 1
            r = (1.0 + r) * (1.0 - cost) - 1.0
        out.append(r)
        previous = p
    return out, trades


def next_open_returns(overnight: Sequence[float], intraday: Sequence[float], cash: Sequence[float],
                      held: Sequence[int], cost: float, previous: int = 1) -> tuple[list[float], int]:
    """Daily returns when the trade fills at the next open instead of the signal-day close.

    ``held`` is the lag-1 position for each day. On day d the overnight leg (close d-1 to open d)
    keeps the position of day d-1 and the intraday leg (open d to close d) uses the position of day
    d. Cash earns the full day's rate when it holds the intraday leg and nothing overnight. This
    credits a full day of cash on exit days and none on entry days (about one day of T-bill interest
    per switch, roughly offsetting over a round trip).
    """
    if not len(overnight) == len(intraday) == len(cash) == len(held):
        raise ValueError("series lengths differ")
    out, trades = [], 0
    for o, i, c, p in zip(overnight, intraday, cash, held, strict=True):
        night = o if previous else 0.0
        day = i if p else c
        r = (1.0 + night) * (1.0 + day) - 1.0
        if p != previous:
            trades += 1
            r = (1.0 + r) * (1.0 - cost) - 1.0
        out.append(r)
        previous = p
    return out, trades


def max_drawdown(returns: Sequence[float]) -> float:
    level, peak, worst = 1.0, 1.0, 0.0
    for r in returns:
        level *= 1.0 + r
        peak = max(peak, level)
        worst = min(worst, level / peak - 1.0)
    return worst


def stats(returns: Sequence[float], cash: Sequence[float], trades: int = 0,
          held: Sequence[int] | None = None, per_year: float = YEAR) -> Stats:
    """``per_year`` is the number of return days per calendar year (above 252 while the NYSE traded
    on Saturdays, before 1952)."""
    if not returns or len(returns) != len(cash):
        raise ValueError("need equal, non-empty return and cash series")
    n = len(returns)
    wealth = math.prod(1.0 + r for r in returns)
    mean = math.fsum(returns) / n
    vol = math.sqrt(math.fsum((r - mean) ** 2 for r in returns) / (n - 1)) if n > 1 else 0.0
    excess = [r - c for r, c in zip(returns, cash, strict=True)]
    ex_mean = math.fsum(excess) / n
    ex_sd = math.sqrt(math.fsum((e - ex_mean) ** 2 for e in excess) / (n - 1)) if n > 1 else 0.0
    return Stats(
        days=n,
        final_wealth=wealth,
        cagr=wealth ** (per_year / n) - 1.0,
        volatility=vol * math.sqrt(per_year),
        sharpe=ex_mean / ex_sd * math.sqrt(per_year) if ex_sd > 0 else 0.0,
        max_drawdown=max_drawdown(returns),
        trades=trades,
        fraction_out=sum(1 for p in held if p == 0) / n if held is not None else 0.0,
    )


def run(asset: Sequence[float], cash: Sequence[float], window: int, lag: int, cost: float,
        start: int = 0, end: int | None = None, signal: Sequence[float] | None = None,
        per_year: float = YEAR) -> tuple[Stats, Stats]:
    """Timing and buy-and-hold statistics over days [start, end).

    The signal uses the whole history (``signal`` levels, default the asset's total-return index),
    so a sub-period starts with the state it really had. The position entering the period is the
    previous day's position; a switch on the first day of the period counts as a trade.
    """
    end = len(asset) if end is None else end
    levels = list(signal) if signal is not None else total_return_index(asset)
    held = positions(sma_states(levels, window), lag)
    previous = held[start - 1] if start > 0 else 1
    timed, trades = strategy_returns(asset[start:end], cash[start:end], held[start:end], cost, previous)
    window_cash = list(cash[start:end])
    return (stats(timed, window_cash, trades, held[start:end], per_year),
            stats(list(asset[start:end]), window_cash, per_year=per_year))
