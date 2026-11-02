"""Carousel strategies rebuilt from published references (Instagram post DfFnuSOkqi9, 2026-10-29).

Research only. These functions compute signals, simulated trades and summary statistics on
completed daily bars. They place no orders, call no network and read no files.

Each strategy follows one published reference, and the reference result is reproduced by
``research/backtests/carousel/validate.py`` within a stated tolerance before the strategy is listed.
Specs: ``docs/specs/strategies/<slug>.md``.

* Close-to-Open Edge: overnight (close to next open) versus intraday (open to close) returns.
  Reference: Knuteson, "Strikingly Suspicious Overnight and Intraday Returns" (2020); Open Alpha
  Lab study 01 (MIT licence).
* Pairs Trading Divergence: Ernest Chan, *Quantitative Trading* (2008), example 3.6 (GLD/GDX).
* Volatility Compression Breakout: Toby Crabel's NR7 (*Day Trading With Short-Term Price
  Patterns*, 1990); Open Alpha Lab study 190.
* Z-Score Mean Reversion: Bollinger lower band (20-day mean minus 2 standard deviations, that is
  a z-score of -2); Open Alpha Lab study 104.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise

YEAR = 252


@dataclass(frozen=True, slots=True)
class Bar:
    day: str
    open: float
    high: float
    low: float
    close: float
    dividend: float = 0.0


@dataclass(frozen=True, slots=True)
class Trade:
    signal_index: int
    direction: int  # +1 long, -1 short
    entry: float
    exit: float
    gross_return: float


@dataclass(frozen=True, slots=True)
class TradeSummary:
    count: int
    mean_bps: float
    win_rate: float


def mean(values: Sequence[float]) -> float:
    if not values:
        raise ValueError("mean of an empty sequence")
    return math.fsum(values) / len(values)


def sample_std(values: Sequence[float]) -> float:
    """Standard deviation with n - 1 in the denominator (as MATLAB ``std`` and pandas)."""
    if len(values) < 2:
        raise ValueError("standard deviation needs at least two values")
    centre = mean(values)
    return math.sqrt(math.fsum((v - centre) ** 2 for v in values) / (len(values) - 1))


def annual_sharpe(returns: Sequence[float]) -> float:
    """sqrt(252) * mean / sample standard deviation of daily returns (no risk-free rate).

    NaN when there are fewer than two returns or they do not vary: the ratio is undefined.
    """
    if len(returns) < 2:
        return math.nan
    scale = sample_std(returns)
    return math.nan if scale == 0 else math.sqrt(YEAR) * mean(returns) / scale


def summarize(trades: Sequence[Trade]) -> TradeSummary:
    if not trades:
        return TradeSummary(0, 0.0, 0.0)
    rets = [t.gross_return for t in trades]
    return TradeSummary(len(rets), mean(rets) * 1e4, sum(1 for r in rets if r > 0) / len(rets))


# --- Close-to-Open Edge ------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class SessionSplit:
    sessions: int
    overnight_total: float  # compounded close-to-open return, 0.10 = +10%
    intraday_total: float  # compounded open-to-close return
    overnight_mean_bps: float
    intraday_mean_bps: float


def session_split(bars: Sequence[Bar], include_dividends: bool = False) -> SessionSplit:
    """Split each session's return into overnight (previous close to open) and intraday (open to close).

    The first bar contributes only its intraday leg. With ``include_dividends`` the ex-date cash
    dividend is added to that day's open, so the overnight leg carries the dividend.
    """
    if len(bars) < 2:
        raise ValueError("session_split needs at least two bars")
    overnight = [((b.open + (b.dividend if include_dividends else 0.0)) / prev.close) - 1.0
                 for prev, b in pairwise(bars)]
    intraday = [b.close / b.open - 1.0 for b in bars]
    return SessionSplit(len(bars), math.prod(1.0 + r for r in overnight) - 1.0,
                        math.prod(1.0 + r for r in intraday) - 1.0,
                        mean(overnight) * 1e4, mean(intraday) * 1e4)


# --- Pairs Trading Divergence ------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class PairBacktest:
    hedge_ratio: float
    spread_mean: float
    spread_std: float
    positions: list[int | None]  # +1 long spread, -1 short spread, 0 flat, None before any signal
    pnl: list[float | None]  # daily P&L per unit of capital in each leg; None without a position
    sharpe_train: float
    sharpe_test: float


def pair_spread_backtest(y: Sequence[float], x: Sequence[float], train: int, entry_z: float = 2.0,
                         exit_z: float = 1.0) -> PairBacktest:
    """Chan (2008) example 3.6: a fixed-ratio spread traded on its training-set z-score.

    * Hedge ratio: least squares of ``y`` on ``x`` without intercept, on the first ``train`` bars.
    * Spread ``y - h * x``; z-score uses the training-set mean and sample standard deviation.
    * Long spread (long ``y``, short ``x``) at ``z <= -entry_z``; short spread at ``z >= entry_z``;
      flat at ``|z| <= exit_z``; otherwise the previous position is held.
    * The position decided at the close of day t earns day t+1's return. Each leg holds one unit
      of capital, as in the reference code, so the P&L is ``pos * (ret_y - ret_x)``.
    * Sharpe ratios: training set from day 2 to ``train``; test set after ``train``. Days before the
      first signal have no P&L and are left out.
    """
    if len(y) != len(x):
        raise ValueError("y and x must have the same length")
    if not 2 < train < len(y):
        raise ValueError("train must leave at least one test bar")
    if not 0 <= exit_z < entry_z:
        raise ValueError("exit_z must be below entry_z")
    hedge = math.fsum(a * b for a, b in zip(y[:train], x[:train], strict=True)) / math.fsum(b * b for b in x[:train])
    spread = [a - hedge * b for a, b in zip(y, x, strict=True)]
    centre, scale = mean(spread[:train]), sample_std(spread[:train])
    if scale == 0:
        raise ValueError("the training-set spread does not vary")
    positions: list[int | None] = []
    current: int | None = None
    for value in spread:
        z = (value - centre) / scale
        if abs(z) <= exit_z:
            current = 0
        elif z >= entry_z:
            current = -1
        elif z <= -entry_z:
            current = 1
        positions.append(current)
    pnl: list[float | None] = [None]
    for t in range(1, len(y)):
        held = positions[t - 1]
        pnl.append(None if held is None else held * ((y[t] / y[t - 1] - 1.0) - (x[t] / x[t - 1] - 1.0)))
    train_pnl = [p for p in pnl[1:train] if p is not None]
    test_pnl = [p for p in pnl[train:] if p is not None]
    return PairBacktest(hedge, centre, scale, positions, pnl, annual_sharpe(train_pnl), annual_sharpe(test_pnl))


# --- Volatility Compression Breakout (NR7) -----------------------------------------------------

def nr7_days(bars: Sequence[Bar], lookback: int = 7) -> list[bool]:
    """True on a day whose high-low range is the narrowest of the last ``lookback`` days (ties count)."""
    ranges = [b.high - b.low for b in bars]
    return [t >= lookback - 1 and ranges[t] == min(ranges[t - lookback + 1:t + 1]) for t in range(len(bars))]


def range_expansion_ratios(bars: Sequence[Bar], signals: Sequence[bool], window: int = 20) -> list[float]:
    """Next-day range divided by the mean range of the ``window`` days ending on the signal day."""
    ranges = [b.high - b.low for b in bars]
    out: list[float] = []
    for t, fired in enumerate(signals):
        if fired and t + 1 < len(bars) and t >= window - 1:
            base = mean(ranges[t - window + 1:t + 1])
            if base > 0:
                out.append(ranges[t + 1] / base)
    return out


def nr7_breakout_trades(bars: Sequence[Bar], signals: Sequence[bool]) -> list[Trade]:
    """Next-day breakout of the NR7 bar, held to that day's close.

    A gap above the NR7 high (below the low) fills long (short) at the open. Otherwise the first
    rule that holds wins: a trade above the NR7 high fills long at that high, then a trade below the
    NR7 low fills short at that low. Daily bars cannot show which level traded first, so the long
    side is checked first, as in the reference. No break means no trade.
    """
    trades: list[Trade] = []
    for t, fired in enumerate(signals):
        if not fired or t + 1 >= len(bars):
            continue
        setup, nxt = bars[t], bars[t + 1]
        if nxt.open > setup.high:
            direction, fill = 1, nxt.open
        elif nxt.open < setup.low:
            direction, fill = -1, nxt.open
        elif nxt.high > setup.high:
            direction, fill = 1, setup.high
        elif nxt.low < setup.low:
            direction, fill = -1, setup.low
        else:
            continue
        trades.append(Trade(t, direction, fill, nxt.close, direction * (nxt.close - fill) / fill))
    return trades


# --- Z-Score Mean Reversion (Bollinger lower band) ---------------------------------------------

def rolling_zscore(closes: Sequence[float], window: int = 20) -> list[float | None]:
    """(close - mean) / sample standard deviation over the ``window`` closes ending today."""
    out: list[float | None] = []
    for t in range(len(closes)):
        if t < window - 1:
            out.append(None)
            continue
        chunk = closes[t - window + 1:t + 1]
        scale = sample_std(chunk)
        out.append(None if scale == 0 else (closes[t] - mean(chunk)) / scale)
    return out


def lower_band_entries(closes: Sequence[float], window: int = 20, k: float = 2.0) -> list[int]:
    """Days on which the close first moves below the lower band (z < -k after a day at or above it)."""
    z = rolling_zscore(closes, window)
    below = [v is not None and v < -k for v in z]
    return [t for t in range(len(closes)) if below[t] and not (t > 0 and below[t - 1])]


def time_exit_trades(bars: Sequence[Bar], entries: Sequence[int], hold: int = 20) -> list[Trade]:
    """Long at the next day's open; exit at the close ``hold`` sessions later (or the last bar)."""
    trades: list[Trade] = []
    for t in entries:
        start = t + 1
        if start >= len(bars):
            continue
        last = min(start + hold - 1, len(bars) - 1)
        entry, exit_ = bars[start].open, bars[last].close
        trades.append(Trade(t, 1, entry, exit_, (exit_ - entry) / entry))
    return trades
