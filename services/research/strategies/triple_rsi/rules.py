"""The Triple RSI rule: indicators, signal bars and trades (research only).

Rule (docs/specs/strategies/triple-rsi.md, classification 3 to 7):
- entry at bar t: RSI(t) < entry_below; RSI(t) < RSI(t-1) < RSI(t-2) < RSI(t-3) (`falls` = 3 falls in a row);
  RSI(t - falls) < level_below; close(t) > SMA(trend_length)(t). Every value must exist (warm-up bars hold none).
- exit at bar t: RSI crosses above exit_above (RSI(t) > exit_above and not RSI(t-1) > exit_above), the DSL
  `crossesAbove`. From an entry below 30 the first close above 50 is always a cross.
- one position: an entry signal while long is ignored; the exit is the first exit bar after the entry bar.

The indicators read the close series they are given (the study passes the split-adjusted close). Wilder RSI is
the Vertex DSL `rsi` (nautilus_backtest.signals.relative_strength), so the DSL definition (dsl.py) compiles to the
same bars; Cutler RSI uses simple means of the last `length` gains and losses.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from nautilus_backtest.signals import relative_strength, rolling_mean

__all__ = ["EXECUTIONS", "RSI_KINDS", "STATED", "Params", "SignalTrade", "cutler_rsi", "rsi", "signal_bars",
           "signal_trades", "sma"]

RSI_KINDS = ("wilder", "cutler")
# close: fill at the signal bar's close (as stated); nextOpen: the DSL engines' fill rule; nextClose: one day late.
EXECUTIONS = ("close", "nextOpen", "nextClose")
NAN = float("nan")


@dataclass(frozen=True)
class Params:
    length: int = 5
    entry_below: float = 30.0
    exit_above: float = 50.0
    trend_length: int = 200
    level_below: float = 60.0
    falls: int = 3
    rsi_kind: str = "wilder"

    def __post_init__(self) -> None:
        if self.rsi_kind not in RSI_KINDS:
            raise ValueError(f"rsi_kind must be one of {RSI_KINDS}")
        if self.length < 2 or self.trend_length < 2 or self.falls < 1:
            raise ValueError("length and trend_length must be at least 2, falls at least 1")

    def key(self) -> str:
        return (f"{self.rsi_kind}-rsi{self.length}-in{self.entry_below:g}-out{self.exit_above:g}"
                f"-sma{self.trend_length}")


STATED = Params()


@dataclass(frozen=True)
class SignalTrade:
    """One round trip in signal bars: the entry signal bar and the exit signal bar (None: still open at the end)."""

    entry: int
    exit: int | None


def _finite(value: float) -> bool:
    return math.isfinite(value)


def cutler_rsi(values: Sequence[float], length: int) -> list[float]:
    """RSI from simple means of the last `length` gains and losses; NaN until bar `length`. 100 without losses."""
    out = [NAN] * len(values)
    gains = [0.0] * len(values)
    losses = [0.0] * len(values)
    for index in range(1, len(values)):
        change = values[index] - values[index - 1]
        gains[index] = change if change > 0 else 0.0
        losses[index] = -change if change < 0 else 0.0
    for index in range(length, len(values)):
        up = sum(gains[index - length + 1:index + 1]) / length
        down = sum(losses[index - length + 1:index + 1]) / length
        out[index] = 100.0 if down == 0 else 100 - 100 / (1 + up / down)
    return out


def rsi(values: Sequence[float], length: int, kind: str = "wilder") -> list[float]:
    if kind == "wilder":
        return list(relative_strength(values, length))
    if kind == "cutler":
        return cutler_rsi(values, length)
    raise ValueError(f"Unknown RSI kind: {kind}")


def sma(values: Sequence[float], length: int) -> list[float]:
    """Simple mean of the last `length` values, today included (the DSL `sma`); NaN before."""
    return list(rolling_mean(values, length))


def signal_bars(close: Sequence[float], params: Params = STATED) -> tuple[list[bool], list[bool]]:
    """(entry bars, exit bars) of the rule on `close`."""
    strength = rsi(close, params.length, params.rsi_kind)
    trend = sma(close, params.trend_length)
    size = len(close)
    entries = [False] * size
    exits = [False] * size
    for t in range(size):
        now = strength[t]
        if _finite(now) and now > params.exit_above:
            before = strength[t - 1] if t >= 1 else NAN
            exits[t] = not (_finite(before) and before > params.exit_above)
        if t < params.falls or not (_finite(trend[t]) and close[t] > trend[t]):
            continue
        window = strength[t - params.falls:t + 1]
        if not all(_finite(value) for value in window):
            continue
        falling = all(window[k + 1] < window[k] for k in range(params.falls))
        entries[t] = now < params.entry_below and falling and window[0] < params.level_below
    return entries, exits


def signal_trades(entries: Sequence[bool], exits: Sequence[bool], first: int = 0) -> list[SignalTrade]:
    """Round trips in signal bars from bar `first` on: one position, the first exit bar after the entry bar."""
    trades: list[SignalTrade] = []
    index = first
    size = len(entries)
    while index < size:
        if not entries[index]:
            index += 1
            continue
        exit_bar = next((bar for bar in range(index + 1, size) if exits[bar]), None)
        trades.append(SignalTrade(index, exit_bar))
        if exit_bar is None:
            break
        index = exit_bar + 1
    return trades
