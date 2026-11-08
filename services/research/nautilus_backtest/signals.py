"""Signal generation for the Nautilus backtest: fixed rules and the strategy DSL.

Port of packages/api/src/instant-backtest-engine.ts (rollingMean, priorExtreme, wilderRsi, the
smaCross / breakout / rsiReversion signals) and packages/api/src/strategy-dsl-compile.ts
(compileStrategy and its indicators). Loops keep the TypeScript operation order, so every value is
the same IEEE double. NaN marks "not available"; a comparison with NaN is False, as in JS.
Research only: nothing here places an order.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .bars import (
    Bars,
    InputError,
    SectorQuadrantDataError,
    SeriesDataError,
    StrategyUnsupportedError,
    assert_columns,
    assert_params,
    assert_signal_options,
    assert_window,
    calendar_intraday_unsupported,
    is_finite_number,
    options_timeframe_unsupported,
    options_unsupported,
    series_filters_unsupported,
)
from .costs import _js_max

NAN = math.nan
FIELD_KEY = {"close": "c", "high": "h", "low": "l", "open": "o"}
PRICE_FIELDS = ("open", "high", "low", "close")
INDICATORS = (
    "sma",
    "ema",
    "rsi",
    "atr",
    "highest",
    "lowest",
    "adx",
    "rvol",
    "zscore",
    "realizedVol",
)
OPERATORS = (">", ">=", "<", "<=", "crossesAbove", "crossesBelow")
MINUTES_PER_DAY = 1440
MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
# Smallest gap between bars below this means intraday bars.
INTRADAY_GAP_MS = 20 * HOUR_MS
REALIZED_VOL_PERIODS_PER_YEAR = 252
NEW_YORK = ZoneInfo("America/New_York")
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
EPOCH_DAY = date(1970, 1, 1)

# Series that filters and series expressions may read (strategy-dsl.ts STRATEGY_SERIES_IDS), the
# relative refs of the traded symbol (STRATEGY_RELATIVE_SERIES) and, per symbol, the
# implied-volatility index (STRATEGY_IV_INDEX), futures twin and total-return close.
SERIES_IDS = (
    "SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO",
    "SPY:TR", "QQQ:TR", "DIA:TR", "IWM:TR", "GLD:TR", "SLV:TR", "USO:TR",
    "ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F",
    "VIX", "VIX3M", "VXN", "VXD", "RVX", "GVZ", "OVX", "VXSLV", "IRX", "TNX",
    "EY_TNX_RATIO",
)  # fmt: skip
IV_INDEX = {
    "DIA": "VXD",
    "GLD": "GVZ",
    "IWM": "RVX",
    "QQQ": "VXN",
    "SLV": "VXSLV",
    "SPY": "VIX",
    "USO": "OVX",
}
RELATIVE_SERIES = ("$tr", "$iv", "$future")
SERIES_REFS = SERIES_IDS + RELATIVE_SERIES
FUTURE_TWIN = {
    "DIA": "YM=F",
    "GLD": "GC=F",
    "IWM": "RTY=F",
    "QQQ": "NQ=F",
    "SLV": "SI=F",
    "SPY": "ES=F",
    "USO": "CL=F",
}
TOTAL_RETURN = {
    symbol: f"{symbol}:TR" for symbol in ("DIA", "GLD", "IWM", "QQQ", "SLV", "SPY", "USO")
}
RELATIVE_TABLES = {"$tr": TOTAL_RETURN, "$iv": IV_INDEX, "$future": FUTURE_TWIN}
# Expression limits (STRATEGY_DSL_MAX_EXPR_DEPTH, STRATEGY_DSL_MAX_EXPR_NODES) and the math ops.
MAX_EXPR_DEPTH = 6
MAX_EXPR_NODES = 40
MAX_LENGTH = 1000
MAX_CONDITIONS = 8
MATH_OPS = ("add", "sub", "mul", "div")
# Options portfolio block (StrategyPortfolioSchema).
OPTION_SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
PORTFOLIO_POLICIES = ("roll", "flat", "window")
PORTFOLIO_CADENCES = ("daily", "monthEnd")
PORTFOLIO_MAX_LEGS = 3
PORTFOLIO_MAX_SHIFT = 5
IV_RANK_DEFAULT_LENGTH = 252
# Most trading days (distinct bar dates) a series value is carried past its date (TS
# STRATEGY_SERIES_MAX_FILL_DAYS, research loader qc_ports data.MAX_FILL_DAYS).
SERIES_MAX_FILL_DAYS = 5
# Filter types that read external daily series; the server engines refuse them.
SERIES_FILTER_TYPES = ("ivRank", "vixTermStructure", "volRegime", "series")
MAX_FILTERS = 4
VOL_REGIME_DEFAULT_TREND_LENGTH = 200
# Indicators that need high, low or volume, which a one-value-per-date series does not have.
NON_CLOSE_INDICATORS = ("adx", "atr", "rvol")
SERIES_CLOSE_ONLY = (
    "A series condition reads the series close only: use the close price and close-sourced"
    " indicators other than atr, adx and rvol"
)

Series = list[float]


@dataclass(frozen=True)
class Compiled:
    """Compiled signals. `exits` is None for fixed rules; distances are None unless ATR levels.
    `options` and `portfolio` are the definition's options and portfolio blocks, unchanged, for the
    options runner."""

    signals: tuple[int, ...]
    exits: tuple[int, ...] | None
    stop_distance: tuple[float, ...] | None
    target_distance: tuple[float, ...] | None
    options: dict[str, Any] | None = None
    portfolio: dict[str, Any] | None = None


@dataclass(frozen=True)
class RunOptions:
    """Mirror of the TypeScript SignalRunOptions (without the arrays, which live in Compiled)."""

    cost_bps: float
    stop_loss_pct: float
    take_profit_pct: float
    costs: dict | None
    risk_pct: float | None = None
    max_hold_bars: int | None = None


# ---------------------------------------------------------------------------------------------
# Fixed-rule indicators (instant-backtest-engine.ts).


def rolling_mean(values: Sequence[float], length: int) -> Series:
    """Simple moving average; NaN until `length` values are available (running sum, as in TS)."""
    out = [NAN] * len(values)
    total = 0.0
    for index in range(len(values)):
        total += values[index]
        if index >= length:
            total -= values[index - length]
        if index >= length - 1:
            out[index] = total / length
    return out


def prior_extreme(values: Sequence[float], length: int, direction: int) -> Series:
    """Highest (1) or lowest (-1) of the `length` bars BEFORE each bar (monotonic deque)."""
    size = len(values)
    out = [NAN] * size
    deque = [0] * size
    head = 0
    tail = 0
    for index in range(size):
        while head < tail and deque[head] < index - length:
            head += 1
        if index >= length:
            out[index] = values[deque[head]]
        value = values[index] * direction
        while head < tail and values[deque[tail - 1]] * direction <= value:
            tail -= 1
        deque[tail] = index
        tail += 1
    return out


def _rsi_of(gain: float, loss: float) -> float:
    return 50.0 if gain + loss == 0 else (100 * gain) / (gain + loss)


def wilder_rsi(values: Sequence[float], period: int) -> Series:
    """TA-Lib style Wilder RSI of the fixed rsiReversion rule. NaN until bar `period`."""
    result = [NAN] * len(values)
    if len(values) <= period:
        return result
    gain = 0.0
    loss = 0.0
    for index in range(1, period + 1):
        change = values[index] - values[index - 1]
        if change > 0:
            gain += change
        else:
            loss -= change
    gain /= period
    loss /= period
    result[period] = _rsi_of(gain, loss)
    for index in range(period + 1, len(values)):
        change = values[index] - values[index - 1]
        gain = (gain * (period - 1) + _js_max(change, 0)) / period
        loss = (loss * (period - 1) + _js_max(-change, 0)) / period
        result[index] = _rsi_of(gain, loss)
    return result


# ---------------------------------------------------------------------------------------------
# DSL indicators (strategy-dsl-compile.ts).


def exponential_mean(values: Sequence[float], length: int) -> Series:
    """Exponential average seeded with the simple average of the first `length` values."""
    out = [NAN] * len(values)
    if len(values) < length:
        return out
    alpha = 2 / (length + 1)
    value = 0.0
    for index in range(length):
        value += values[index]
    value /= length
    out[length - 1] = value
    for index in range(length, len(values)):
        value += alpha * (values[index] - value)
        out[index] = value
    return out


def _wilder(values: Sequence[float], length: int, offset: int) -> Series:
    """Wilder smoothing: simple average seed, then value += (x - value) / length."""
    out = [NAN] * len(values)
    seed_end = offset + length
    if len(values) < seed_end:
        return out
    value = 0.0
    for index in range(offset, seed_end):
        value += values[index]
    value /= length
    out[seed_end - 1] = value
    for index in range(seed_end, len(values)):
        value += (values[index] - value) / length
        out[index] = value
    return out


def relative_strength(values: Sequence[float], length: int) -> Series:
    """DSL Wilder RSI (0 to 100). 100 when there are no losses in the window."""
    size = len(values)
    gains = [0.0] * size
    losses = [0.0] * size
    for index in range(1, size):
        change = values[index] - values[index - 1]
        gains[index] = change if change > 0 else 0.0
        losses[index] = -change if change < 0 else 0.0
    up = _wilder(gains, length, 1)
    down = _wilder(losses, length, 1)
    out = [NAN] * size
    for index in range(size):
        loss = down[index]
        if loss != loss:
            continue
        out[index] = 100.0 if loss == 0 else 100 - 100 / (1 + up[index] / loss)
    return out


def _exact_window(values: Sequence[float], start: int, end: int) -> tuple[float, float]:
    """Exact two-pass mean and sum of squared deviations of values[start..end]."""
    total = 0.0
    for at in range(start, end + 1):
        total += values[at]
    average = total / (end - start + 1)
    squares = 0.0
    for at in range(start, end + 1):
        delta = values[at] - average
        squares += delta * delta
    return (average, squares)


def _slide_window(
    average: float, squares: float, incoming: float, outgoing: float, length: int
) -> tuple[float, float]:
    """Welford update of a sliding window: `incoming` replaces `outgoing`."""
    following = average + (incoming - outgoing) / length
    return (
        following,
        _js_max(
            0,
            squares + (incoming - outgoing) * (incoming - following + outgoing - average),
        ),
    )


def _rolling_moments(values: Sequence[float], length: int) -> tuple[Series, Series]:
    """Mean and sample deviation of each full window (Welford with a periodic exact recompute)."""
    size = len(values)
    mean = [NAN] * size
    deviation = [NAN] * size
    bad = 0  # values in the window that are not finite
    run = 0  # equal values ending at the bar
    state: tuple[float, float] | None = None
    for index in range(size):
        value = values[index]
        if not math.isfinite(value):
            bad += 1
        if index >= length and not math.isfinite(values[index - length]):
            bad -= 1
        run = run + 1 if index > 0 and value == values[index - 1] else 1
        if index < length - 1:
            continue
        if bad > 0:
            state = None
            continue
        start = index - length + 1
        if state is None or start % length == 0:
            state = _exact_window(values, start, index)
        else:
            state = _slide_window(state[0], state[1], value, values[index - length], length)
        flat = run >= length
        mean[index] = value if flat else state[0]
        deviation[index] = 0.0 if flat else math.sqrt(state[1] / (length - 1))
    return (mean, deviation)


def rolling_zscore(values: Sequence[float], length: int) -> Series:
    """Rolling z-score with the bar in the window; NaN before bar length - 1 and when flat."""
    mean, deviation = _rolling_moments(values, length)
    out = [NAN] * len(values)
    for index in range(length - 1, len(values)):
        spread = deviation[index]
        if spread > 0:
            out[index] = (values[index] - mean[index]) / spread
    return out


def realized_volatility(values: Sequence[float], length: int) -> Series:
    """Annualized realized volatility in percent of the `length` simple returns ending at the bar."""
    size = len(values)
    out = [NAN] * size
    returns = [NAN] * size
    for index in range(1, size):
        previous = values[index - 1]
        current = values[index]
        if previous > 0 and current > 0:
            returns[index] = current / previous - 1
    scale = 100 * math.sqrt(REALIZED_VOL_PERIODS_PER_YEAR)
    _, deviation = _rolling_moments(returns, length)
    for index in range(length, size):
        out[index] = scale * deviation[index]
    return out


def average_true_range_dsl(bars: Bars, length: int) -> Series:
    """DSL Wilder average true range. The first bar's true range is high - low."""
    size = len(bars.c)
    ranges = [0.0] * size
    for index in range(size):
        high = bars.h[index]
        low = bars.l[index]
        if index == 0:
            ranges[index] = high - low
            continue
        previous = bars.c[index - 1]
        ranges[index] = _js_max(high - low, abs(high - previous), abs(low - previous))
    return _wilder(ranges, length, 0)


def average_directional_index(bars: Bars, length: int) -> Series:
    """Wilder ADX line with TA-Lib smoothing. DX is 0 when +DI and -DI are both 0."""
    size = len(bars.c)
    out = [NAN] * size
    plus_sum = 0.0
    minus_sum = 0.0
    range_sum = 0.0
    dx_total = 0.0
    average = NAN
    for index in range(1, size):
        high = bars.h[index]
        low = bars.l[index]
        previous = bars.c[index - 1]
        up_move = high - bars.h[index - 1]
        down_move = bars.l[index - 1] - low
        plus_move = up_move if up_move > 0 and up_move > down_move else 0.0
        minus_move = down_move if down_move > 0 and down_move > up_move else 0.0
        true_range = _js_max(high - low, abs(high - previous), abs(low - previous))
        if index < length:
            plus_sum += plus_move
            minus_sum += minus_move
            range_sum += true_range
            continue
        plus_sum += plus_move - plus_sum / length
        minus_sum += minus_move - minus_sum / length
        range_sum += true_range - range_sum / length
        plus = 0.0 if range_sum == 0 else (100 * plus_sum) / range_sum
        minus = 0.0 if range_sum == 0 else (100 * minus_sum) / range_sum
        total = plus + minus
        dx = 0.0 if total == 0 else (100 * abs(plus - minus)) / total
        if index < 2 * length - 1:
            dx_total += dx
            continue
        average = (
            (dx_total + dx) / length
            if average != average
            else (average * (length - 1) + dx) / length
        )
        out[index] = average
    return out


def _new_york_offset(t: float, cache: dict[int, float]) -> float:
    """New York local time minus UTC, in ms, for the UTC hour that holds `t`."""
    hour = math.floor(t / HOUR_MS)
    cached = cache.get(hour)
    if cached is not None:
        return cached
    instant = EPOCH + timedelta(milliseconds=hour * HOUR_MS)
    offset = instant.astimezone(NEW_YORK).utcoffset()
    value = 0.0 if offset is None else offset.total_seconds() * 1000
    cache[hour] = value
    return value


def _cumulative_as_of(slots: list[float], totals: list[float], slot: float) -> float:
    """Cumulative session volume through the last bar with slot <= `slot` (0 when none)."""
    low = 0
    high = len(slots)
    while low < high:
        middle = (low + high) // 2
        if slots[middle] <= slot:
            low = middle + 1
        else:
            high = middle
    return 0.0 if low == 0 else totals[low - 1]


def relative_volume_at_time(
    t: Sequence[float], volume: Sequence[float], lookback: int
) -> Series:
    """Relative volume at time (session = New York date, slot = New York minute of day)."""
    size = len(t)
    out = [NAN] * size
    offsets: dict[int, float] = {}
    days = [0.0] * size
    slots = [0.0] * size
    one_bar_sessions = True
    for index in range(size):
        local = t[index] + _new_york_offset(t[index], offsets)
        day = math.floor(local / DAY_MS)
        days[index] = day
        slots[index] = math.floor((local - day * DAY_MS) / MINUTE_MS)
        if index > 0 and days[index - 1] == day:
            one_bar_sessions = False
    if one_bar_sessions:
        slots = [0.0] * size
    sessions: list[tuple[list[float], list[float]]] = []
    current: tuple[list[float], list[float]] = ([], [])
    total = 0.0
    for index in range(size):
        slot = slots[index]
        if index == 0 or days[index] != days[index - 1]:
            if index > 0:
                sessions.append(current)
            current = ([], [])
            total = 0.0
        total += volume[index]
        current[0].append(slot)
        current[1].append(total)
        if len(sessions) < lookback:
            continue
        summed = 0.0
        for back in range(len(sessions) - lookback, len(sessions)):
            session_slots, session_totals = sessions[back]
            summed += _cumulative_as_of(session_slots, session_totals, slot)
        if summed != 0:
            out[index] = total / (summed / lookback)
    return out


# ---------------------------------------------------------------------------------------------
# Fixed rules.


def _sma_cross_signals(bars: Bars, rule: Mapping[str, Any], size: int) -> list[int]:
    assert_window("fast", rule.get("fast"), size)
    assert_window("slow", rule.get("slow"), size)
    if rule["fast"] >= rule["slow"]:
        raise InputError("fast must be shorter than slow")
    signals = [0] * size
    fast = rolling_mean(bars.c, int(rule["fast"]))
    slow = rolling_mean(bars.c, int(rule["slow"]))
    was_above = False
    for index in range(size):
        slow_value = slow[index]
        if slow_value != slow_value:
            continue
        above = fast[index] > slow_value
        if not above:
            signals[index] = -1
        elif not was_above:
            signals[index] = 1
        was_above = above
    return signals


def _breakout_signals(bars: Bars, rule: Mapping[str, Any], size: int) -> list[int]:
    assert_window("entryLookback", rule.get("entryLookback"), size)
    assert_window("exitLookback", rule.get("exitLookback"), size)
    trend_length = rule.get("trendSma")
    if trend_length != 0:
        assert_window("trendSma", trend_length, size)
    signals = [0] * size
    highs = prior_extreme(bars.h, int(rule["entryLookback"]), 1)
    lows = prior_extreme(bars.l, int(rule["exitLookback"]), -1)
    trend = None if trend_length == 0 else rolling_mean(bars.c, int(trend_length))
    for index in range(size):
        close = bars.c[index]
        if close < lows[index]:
            signals[index] = -1
            continue
        trend_value = -math.inf if trend is None else trend[index]
        if close > highs[index] and close > trend_value:
            signals[index] = 1
    return signals


def _rsi_reversion_signals(bars: Bars, rule: Mapping[str, Any], size: int) -> list[int]:
    assert_window("period", rule.get("period"), size - 1)

    def level(name: str, value: Any) -> None:
        if not is_finite_number(value) or value < 0 or value > 100:
            raise InputError(f"{name} must be from 0 to 100")

    level("oversold", rule.get("oversold"))
    level("overbought", rule.get("overbought"))
    if rule["oversold"] >= rule["overbought"]:
        raise InputError("oversold must be below overbought")
    period = int(rule["period"])
    signals = [0] * size
    rsi = wilder_rsi(bars.c, period)
    for index in range(period, size):
        value = rsi[index]
        if value < rule["oversold"]:
            signals[index] = 1
        elif value > rule["overbought"]:
            signals[index] = -1
    return signals


_RULES = {
    "smaCross": _sma_cross_signals,
    "breakout": _breakout_signals,
    "rsiReversion": _rsi_reversion_signals,
}


def compile_rule(bars: Bars, rule: Mapping[str, Any]) -> tuple[int, ...]:
    """Signals of a fixed rule (smaCross / breakout / rsiReversion), as runInstantBacktest builds them."""
    size = assert_columns(bars)
    build = _RULES.get(rule.get("kind"))  # type: ignore[arg-type]
    if build is None:
        raise InputError(f"Unknown rule kind: {rule.get('kind')}")
    return tuple(build(bars, rule, size))


# ---------------------------------------------------------------------------------------------
# Strategy DSL.


def _whole(value: Any, name: str, low: int, high: int) -> int:
    """A whole number in [low, high] (an integral float counts)."""
    if isinstance(value, bool) or not (
        isinstance(value, int) or (isinstance(value, float) and value.is_integer())
    ):
        raise InputError(f"{name} must be a whole number from {low} to {high}")
    if not low <= value <= high:
        raise InputError(f"{name} must be a whole number from {low} to {high}")
    return int(value)


def _offset(expr: Mapping[str, Any]) -> int:
    offset = expr.get("offset")
    return 0 if offset is None else _whole(offset, "offset", 0, MAX_LENGTH)


def _normalize_expr(expr: Mapping[str, Any]) -> dict[str, Any]:
    """StrategyExprSchema defaults of one expression tree (idempotent); offsets default to 0."""
    kind = expr.get("type")
    if kind == "price":
        if expr.get("field") not in PRICE_FIELDS:
            raise InputError(f"Unknown price field: {expr.get('field')}")
        return {"type": "price", "field": expr["field"], "offset": int(expr.get("offset") or 0)}
    if kind == "const":
        value = expr.get("value")
        if not is_finite_number(value):
            raise InputError("Constant value must be a finite number")
        return {"type": "const", "value": float(value)}
    if kind == "indicator":
        name = expr.get("name")
        if name not in INDICATORS:
            raise InputError(f"Unknown indicator: {name}")
        source = expr.get("source", "close")
        if source not in PRICE_FIELDS:
            raise InputError(f"Unknown indicator source: {source}")
        length = expr.get("length")
        if not (isinstance(length, int) and not isinstance(length, bool)) or length < 1:
            if not (isinstance(length, float) and length.is_integer() and length >= 1):
                raise InputError(f"{name} length must be a whole number of at least 1")
        return {
            "type": "indicator",
            "name": name,
            "length": int(length),
            "source": source,
            "offset": int(expr.get("offset") or 0),
        }
    if kind == "series":
        series = expr.get("series")
        if series not in SERIES_REFS:
            raise InputError(f"Unknown series: {series}")
        return {"type": "series", "series": series, "offset": _offset(expr)}
    if kind == "math":
        op = expr.get("op")
        if op not in MATH_OPS:
            raise InputError(f"Unknown math operator: {op}")
        return {
            "type": "math",
            "op": op,
            "left": _normalize_expr(expr["left"]),
            "right": _normalize_expr(expr["right"]),
        }
    if kind == "change":
        return {
            "type": "change",
            "length": _whole(expr.get("length"), "change length", 1, MAX_LENGTH),
            "of": _normalize_expr(expr["of"]),
            "offset": _offset(expr),
        }
    if kind == "returnStdev":
        return {
            "type": "returnStdev",
            "length": _whole(expr.get("length"), "returnStdev length", 2, MAX_LENGTH),
            "of": _normalize_expr(expr["of"]),
        }
    if kind == "regression":
        return {
            "type": "regression",
            "lag": _whole(expr.get("lag"), "regression lag", 0, MAX_LENGTH),
            "length": _whole(expr.get("length"), "regression length", 3, MAX_LENGTH),
            "x": _normalize_expr(expr["x"]),
            "y": _normalize_expr(expr["y"]),
        }
    if kind == "seasonal":
        return {
            "type": "seasonal",
            "minCount": _whole(expr.get("minCount"), "seasonal minCount", 1, MAX_LENGTH),
            "monthsAhead": _whole(expr.get("monthsAhead"), "seasonal monthsAhead", 0, 11),
            "of": _normalize_expr(expr["of"]),
        }
    raise InputError(f"Unknown expression type: {kind}")


def _expr_children(expr: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """TS strategyExprChildren: the sub-expressions of `expr` (none for a leaf)."""
    kind = expr["type"]
    if kind == "math":
        return [expr["left"], expr["right"]]
    if kind in ("change", "returnStdev", "seasonal"):
        return [expr["of"]]
    if kind == "regression":
        return [expr["y"], expr["x"]]
    return []


def expr_size(expr: Mapping[str, Any]) -> tuple[int, int]:
    """TS strategyExprSize: nesting depth (a leaf is 1) and node count."""
    depth = 0
    nodes = 1
    for child in _expr_children(expr):
        child_depth, child_nodes = expr_size(child)
        depth = max(depth, child_depth)
        nodes += child_nodes
    return depth + 1, nodes


def expr_series(expr: Mapping[str, Any]) -> list[str]:
    """TS strategyExprSeries: every series ref an expression reads, in tree order."""
    own = [expr["series"]] if expr["type"] == "series" else []
    return own + [ref for child in _expr_children(expr) for ref in expr_series(child)]


def _check_expr_limits(exprs: Sequence[Mapping[str, Any]]) -> None:
    """TS exprLimitIssue: depth per expression, then the node total."""
    nodes = 0
    for expr in exprs:
        depth, size = expr_size(expr)
        if depth > MAX_EXPR_DEPTH:
            raise InputError(f"An expression may nest at most {MAX_EXPR_DEPTH} levels")
        nodes += size
    if nodes > MAX_EXPR_NODES:
        raise InputError(f"A condition may hold at most {MAX_EXPR_NODES} expression nodes")


def _normalize_condition(condition: Mapping[str, Any]) -> dict[str, Any]:
    op = condition.get("op")
    if op not in OPERATORS:
        raise InputError(f"Unknown operator: {op}")
    normalized = {
        "left": _normalize_expr(condition["left"]),
        "op": op,
        "right": _normalize_expr(condition["right"]),
    }
    _check_expr_limits([normalized["left"], normalized["right"]])
    return normalized


def _normalize_level(level: Mapping[str, Any] | None) -> dict[str, Any]:
    if level is None:
        return {"kind": "none"}
    kind = level.get("kind")
    if kind == "none":
        return {"kind": "none"}
    if kind == "pct":
        return {"kind": "pct", "pct": float(level["pct"])}
    if kind == "atr":
        return {"kind": "atr", "length": int(level["length"]), "multiple": float(level["multiple"])}
    raise InputError(f"Unknown exit level kind: {kind}")


def _close_only(expr: Mapping[str, Any]) -> bool:
    if expr["type"] == "const":
        return True
    if expr["type"] == "price":
        return expr["field"] == "close"
    if expr["type"] == "indicator":
        return expr["source"] == "close" and expr["name"] not in NON_CLOSE_INDICATORS
    return False


def _bounds(item: Mapping[str, Any], keys: tuple[str, str], message: str) -> dict[str, float]:
    """The optional numeric bounds of a filter; at least one must be given."""
    bounds = {key: float(item[key]) for key in keys if item.get(key) is not None}
    if not bounds:
        raise InputError(message)
    return bounds


def _normalize_filter(item: Mapping[str, Any]) -> dict[str, Any]:
    """StrategyFilterSchema defaults for one filter (idempotent)."""
    kind = item.get("type")
    if kind == "sectorQuadrant":
        return {
            "type": "sectorQuadrant",
            "sector": item["sector"],
            "quadrants": list(item["quadrants"]),
            "timeframe": item.get("timeframe", "weekly"),
        }
    if kind == "ivRank":
        return {
            "type": "ivRank",
            "length": int(item.get("length", IV_RANK_DEFAULT_LENGTH)),
            **_bounds(item, ("min", "max"), "ivRank needs min, max or both"),
        }
    if kind == "vixTermStructure":
        return {
            "type": "vixTermStructure",
            **_bounds(
                item, ("minRatio", "maxRatio"), "vixTermStructure needs minRatio, maxRatio or both"
            ),
        }
    if kind == "volRegime":
        return {
            "type": "volRegime",
            "maxVix": float(item["maxVix"]),
            "maxTermRatio": float(item["maxTermRatio"]),
            "trendLength": int(item.get("trendLength", VOL_REGIME_DEFAULT_TREND_LENGTH)),
        }
    if kind == "calendarWindow":
        window = item.get("window")
        if window == "turnOfMonth":
            return {
                "type": kind,
                "window": window,
                "fromDay": int(item["fromDay"]),
                "toDay": int(item["toDay"]),
            }
        if window == "opexWeek":
            return {"type": kind, "window": window}
        if window == "months":
            return {"type": kind, "window": window, "months": [int(m) for m in item["months"]]}
        raise InputError(f"Unknown calendar window: {window}")
    if kind == "series":
        series = item.get("series")
        if series not in SERIES_REFS:
            raise InputError(f"Unknown series: {series}")
        condition = _normalize_condition(item["condition"])
        if not (_close_only(condition["left"]) and _close_only(condition["right"])):
            raise InputError(SERIES_CLOSE_ONLY)
        return {"type": "series", "series": series, "condition": condition}
    raise InputError(f"Unknown filter type: {kind}")


def _condition_list(items: Any, name: str, minimum: int) -> list[dict[str, Any]]:
    conditions = list(items or [])
    if not minimum <= len(conditions) <= MAX_CONDITIONS:
        raise InputError(f"{name} needs {minimum} to {MAX_CONDITIONS} conditions")
    return [_normalize_condition(item) for item in conditions]


def _normalize_leg(leg: Mapping[str, Any]) -> dict[str, Any]:
    """StrategyPortfolioLegSchema: entry, optional exit and filters, and an options block."""
    options = leg.get("options")
    if not isinstance(options, Mapping):
        raise InputError("A portfolio leg needs an options block")
    normalized: dict[str, Any] = {
        "entry": {"all": _condition_list((leg.get("entry") or {}).get("all"), "A leg entry", 1)},
        "options": dict(options),
    }
    if leg.get("exit") is not None:
        normalized["exit"] = {"any": _condition_list(leg["exit"].get("any"), "A leg exit", 0)}
    if leg.get("filters") is not None:
        filters = list(leg["filters"])
        if not 1 <= len(filters) <= MAX_FILTERS:
            raise InputError(f"A leg needs 1 to {MAX_FILTERS} filters")
        normalized["filters"] = [_normalize_filter(item) for item in filters]
    return normalized


def _selection_score(expr: Mapping[str, Any]) -> dict[str, Any]:
    normalized = _normalize_expr(expr)
    _check_expr_limits([normalized])
    return normalized


def _calendar_only(part: Mapping[str, Any]) -> bool:
    """TS calendarOnly of a raw definition or leg: entry exactly `close > 0`, no exit and only
    calendarWindow filters (at least one)."""
    entry = list((part.get("entry") or {}).get("all") or [])
    if len(entry) != 1:
        return False
    only = entry[0]
    left = only.get("left") or {}
    right = only.get("right") or {}
    filters = list(part.get("filters") or [])
    return (
        only.get("op") == ">"
        and left.get("type") == "price"
        and left.get("field") == "close"
        and left.get("offset") is None
        and right.get("type") == "const"
        and is_finite_number(right.get("value"))
        and right["value"] == 0
        and len((part.get("exit") or {}).get("any") or []) == 0
        and len(filters) > 0
        and all(item.get("type") == "calendarWindow" for item in filters)
    )


def _normalize_portfolio(portfolio: Mapping[str, Any]) -> dict[str, Any]:
    """StrategyPortfolioSchema with its refinements (same messages); optional keys stay absent."""
    policy = portfolio.get("policy")
    if policy not in PORTFOLIO_POLICIES:
        raise InputError(f"Unknown portfolio policy: {policy}")
    symbols = list(portfolio.get("symbols") or [])
    if not 1 <= len(symbols) <= len(OPTION_SYMBOLS):
        raise InputError(f"A portfolio trades 1 to {len(OPTION_SYMBOLS)} symbols")
    for symbol in symbols:
        if symbol not in OPTION_SYMBOLS:
            raise InputError(f"Unknown portfolio symbol: {symbol}")
    if len(set(symbols)) != len(symbols):
        raise InputError("Portfolio symbols must not repeat")
    normalized: dict[str, Any] = {"policy": policy, "symbols": symbols}
    cadence = portfolio.get("cadence")
    if cadence is not None:
        if cadence not in PORTFOLIO_CADENCES:
            raise InputError(f"Unknown portfolio cadence: {cadence}")
        normalized["cadence"] = cadence
    frame = portfolio.get("frame")
    if frame is not None:
        if frame != "monthly":
            raise InputError(f"Unknown portfolio frame: {frame}")
        normalized["frame"] = frame
    legs = portfolio.get("legs")
    if legs is not None:
        if not 1 <= len(legs) <= PORTFOLIO_MAX_LEGS:
            raise InputError(f"A portfolio holds 1 to {PORTFOLIO_MAX_LEGS} legs")
        normalized["legs"] = [_normalize_leg(leg) for leg in legs]
    select = portfolio.get("select")
    if select is not None:
        normalized["select"] = {
            "score": _selection_score(select["score"]),
            "top": _whole(select.get("top"), "select top", 1, len(OPTION_SYMBOLS)),
        }
        if select.get("tieBreak") is not None:
            normalized["select"]["tieBreak"] = _selection_score(select["tieBreak"])
    shift = portfolio.get("shift")
    if shift is not None:
        normalized["shift"] = _whole(shift, "shift", 1, PORTFOLIO_MAX_SHIFT)
    if (policy == "flat") != (cadence is not None):
        raise InputError("cadence is required with the flat policy and only there")
    if frame is not None and policy != "roll":
        raise InputError("frame monthly needs the roll policy")
    if select is not None and policy != "roll":
        raise InputError("select needs the roll policy")
    if shift is not None and policy != "window":
        raise InputError("shift needs the window policy")
    return normalized


def normalize_definition(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Applies the StrategyDefinitionSchema defaults and rejects unknown names and operators."""
    entry = definition.get("entry") or {}
    entry_all = entry.get("all") or []
    if len(entry_all) == 0:
        raise InputError("A strategy needs at least one entry condition")
    exit_any = (definition.get("exit") or {}).get("any") or []
    sizing = definition.get("sizing") or {"mode": "allIn"}
    if sizing.get("mode") == "riskPct":
        sizing = {"mode": "riskPct", "riskPct": float(sizing["riskPct"])}
    elif sizing.get("mode") == "allIn":
        sizing = {"mode": "allIn"}
    else:
        raise InputError(f"Unknown sizing mode: {sizing.get('mode')}")
    filters = [_normalize_filter(item) for item in definition.get("filters") or []]
    stop_loss = _normalize_level(definition.get("stopLoss"))
    take_profit = _normalize_level(definition.get("takeProfit"))
    options = definition.get("options")
    if options is not None:
        if sizing["mode"] == "riskPct":
            raise InputError(
                "Option strategies size by options.maxLossPct; remove the riskPct sizing"
            )
        if stop_loss["kind"] != "none" or take_profit["kind"] != "none":
            raise InputError(
                "Option strategies exit by profitTakePct, exitDte and exit conditions;"
                " remove the stop loss and take profit"
            )
    portfolio = definition.get("portfolio")
    normalized_portfolio = None
    if portfolio is not None:
        normalized_portfolio = _normalize_portfolio(portfolio)
        if options is None:
            raise InputError("A portfolio block trades option verticals; add an options block")
        if portfolio.get("shift") is not None and not all(
            _calendar_only(part) for part in [definition, *(portfolio.get("legs") or [])]
        ):
            raise InputError(
                "A shifted window reads ahead: every leg needs the entry close > 0, no exit and"
                " calendarWindow filters only"
            )
    session = definition.get("session")
    return {
        "name": definition.get("name"),
        "entry": {"all": [_normalize_condition(c) for c in entry_all]},
        "exit": {"any": [_normalize_condition(c) for c in exit_any]},
        "filters": filters,
        "options": None if options is None else dict(options),
        "portfolio": normalized_portfolio,
        "session": None if session is None else {"startUtc": session["startUtc"], "endUtc": session["endUtc"]},
        "sizing": sizing,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
    }


def _column(bars: Bars, field: str) -> Sequence[float]:
    return getattr(bars, FIELD_KEY[field])


def _shift(values: Sequence[float], offset: int) -> Series:
    """Series value `offset` bars ago; NaN before the first available bar."""
    size = len(values)
    out = [NAN] * size
    if offset < size:
        out[offset:] = values[: size - offset]
    return out


@dataclass(frozen=True)
class _Frame:
    """TS SeriesFrame: what series expressions and filters read. `calendar_at` is the calendar
    position of each bar when a calendar is given."""

    bar_dates: list[str]
    intraday: bool
    context: Mapping[str, Any] | None
    symbol: str | None
    calendar: list[str] | None
    calendar_at: list[int] | None


def _calendar_positions(dates: Sequence[str], bar_dates: Sequence[str]) -> list[int]:
    """TS calendarPositions: ascending YYYY-MM-DD dates that hold every bar date."""
    positions: dict[str, int] = {}
    for index, day_date in enumerate(dates):
        if _DATE_PATTERN.fullmatch(day_date) is None or (
            index > 0 and day_date <= dates[index - 1]
        ):
            raise InputError(
                f"The calendar must hold ascending YYYY-MM-DD dates without repeats: {day_date}"
            )
        positions[day_date] = index
    out = []
    for bar_date in bar_dates:
        at = positions.get(bar_date)
        if at is None:
            raise InputError(f"Bar date {bar_date} is not in the calendar")
        out.append(at)
    return out


def _series_frame(
    bars: Bars,
    context: Mapping[str, Any] | None,
    symbol: str | None,
    calendar: Sequence[str] | None,
) -> _Frame:
    bar_dates = [_utc_date(t) for t in bars.t]
    return _Frame(
        bar_dates=bar_dates,
        intraday=_is_intraday(bars.t),
        context=context,
        symbol=symbol,
        calendar=None if calendar is None else list(calendar),
        calendar_at=None if calendar is None else _calendar_positions(list(calendar), bar_dates),
    )


def resolve_series(ref: str, symbol: str | None) -> str | None:
    """TS resolveStrategySeries: the series id of `ref` for `symbol`, None when it has none."""
    table = RELATIVE_TABLES.get(ref)
    if table is None:
        return ref
    return None if symbol is None else table.get(symbol)


def _series_id(ref: str, symbol: str | None) -> str:
    series_id = resolve_series(ref, symbol)
    if series_id is not None:
        return series_id
    if symbol is None:
        raise InputError(f"{ref} needs the traded symbol")
    raise InputError(f"{ref} has no series for {symbol}")


def _align_on(
    frame: _Frame, dates: Sequence[str], values: Sequence[float], exact: bool
) -> list[float]:
    """TS alignOn: alignSeries on the bar dates, or on the calendar and then at the bar dates."""
    if frame.calendar is None or frame.calendar_at is None:
        return _align_series(dates, values, frame.bar_dates, frame.intraday, exact)
    aligned = _align_series(dates, values, frame.calendar, frame.intraday, exact)
    return [aligned[at] for at in frame.calendar_at]


def _series_values(frame: _Frame, ref: str) -> list[float]:
    """TS seriesValues: a series ref on each bar, aligned like the series filter."""
    dates, values = _daily_series(frame.context, _series_id(ref, frame.symbol))
    return _align_on(frame, dates, values, False)


def _finite_or_nan(value: float) -> float:
    return value if math.isfinite(value) else NAN


def _divide(left: float, right: float) -> float:
    """JS division (x / 0 is not finite), NaN when not finite."""
    if right == 0:
        return NAN
    return _finite_or_nan(left / right)


_MATH: dict[str, Callable[[float, float], float]] = {
    "add": lambda left, right: _finite_or_nan(left + right),
    "sub": lambda left, right: _finite_or_nan(left - right),
    "mul": lambda left, right: _finite_or_nan(left * right),
    "div": _divide,
}


def _return_deviation(values: Sequence[float], length: int) -> Series:
    """TS returnDeviation: sample deviation of the last `length` one-bar simple returns."""
    returns = [NAN] * len(values)
    for index in range(1, len(values)):
        returns[index] = _finite_or_nan(_divide(values[index], values[index - 1]) - 1)
    _, deviation = _rolling_moments(returns, length)
    return deviation


def _regression(y: Sequence[float], x: Sequence[float], length: int, lag: int) -> Series:
    """TS regressionSeries: a0 + a1 * x[t], least squares of y[s] on x[s - lag], `length` bars."""
    out = [NAN] * len(y)
    for index in range(length - 1 + lag, len(y)):
        first = index - length + 1
        sum_x = 0.0
        sum_y = 0.0
        for at in range(first, index + 1):
            sum_x += x[at - lag]
            sum_y += y[at]
        current = x[index]
        if not (math.isfinite(sum_x) and math.isfinite(sum_y) and math.isfinite(current)):
            continue
        mean_x = sum_x / length
        mean_y = sum_y / length
        squares = 0.0
        products = 0.0
        for at in range(first, index + 1):
            delta_x = x[at - lag] - mean_x
            squares += delta_x * delta_x
            products += delta_x * (y[at] - mean_y)
        if not squares > 0:
            continue
        slope = products / squares
        intercept = mean_y - slope * mean_x
        out[index] = _finite_or_nan(intercept + slope * current)
    return out


def _seasonal(
    values: Sequence[float], t: Sequence[float], months_ahead: int, min_count: int
) -> Series:
    """TS seasonalSeries: mean of the finite values at this and earlier bars in the UTC month
    `months_ahead` after the bar's month; NaN with fewer than `min_count` values."""
    out = [NAN] * len(values)
    sums = [0.0] * 12
    counts = [0] * 12
    for index, value in enumerate(values):
        month = (EPOCH + timedelta(milliseconds=t[index])).month - 1
        if math.isfinite(value):
            sums[month] += value
            counts[month] += 1
        target = (month + months_ahead) % 12
        if counts[target] >= min_count:
            out[index] = sums[target] / counts[target]
    return out


class _Evaluator:
    """Evaluates expressions with a cache keyed like the TypeScript SeriesCache; tree nodes are
    memoized by their canonical JSON. `frame` builds the series frame on first use."""

    def __init__(self, bars: Bars, frame: Callable[[], _Frame] | None = None) -> None:
        self.bars = bars
        self.cache: dict[str, Sequence[float]] = {}
        self._frame_builder = frame
        self._frame: _Frame | None = None

    def frame(self) -> _Frame:
        if self._frame is None:
            if self._frame_builder is None:
                self._frame_builder = lambda: _series_frame(self.bars, None, None, None)
            self._frame = self._frame_builder()
        return self._frame

    def evaluate(self, expr: Mapping[str, Any]) -> Sequence[float]:
        if expr["type"] not in ("price", "const", "indicator"):
            key = "expr:" + json.dumps(expr, sort_keys=True, separators=(",", ":"))
            cached = self.cache.get(key)
            if cached is None:
                cached = self._tree(expr)
                self.cache[key] = cached
            return cached
        current = self._current(expr)
        if expr["type"] == "const":
            return current
        offset = expr.get("offset", 0)
        if offset == 0:
            return current
        key = (
            f"price:{expr['field']}@{offset}"
            if expr["type"] == "price"
            else f"{expr['name']}:{expr['length']}:{expr['source']}@{offset}"
        )
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        series = _shift(current, offset)
        self.cache[key] = series
        return series

    def _tree(self, expr: Mapping[str, Any]) -> Sequence[float]:
        kind = expr["type"]
        size = len(self.bars.c)
        if kind == "series":
            return _shift(_series_values(self.frame(), expr["series"]), expr["offset"])
        if kind == "math":
            left = self.evaluate(expr["left"])
            right = self.evaluate(expr["right"])
            apply = _MATH[expr["op"]]
            return [apply(left[index], right[index]) for index in range(size)]
        if kind == "change":
            of = self.evaluate(expr["of"])
            offset = expr["offset"]
            length = expr["length"]
            out = [NAN] * size
            for index in range(offset + length, size):
                out[index] = _finite_or_nan(
                    _divide(of[index - offset], of[index - offset - length]) - 1
                )
            return out
        if kind == "returnStdev":
            return _return_deviation(self.evaluate(expr["of"]), expr["length"])
        if kind == "regression":
            return _regression(
                self.evaluate(expr["y"]), self.evaluate(expr["x"]), expr["length"], expr["lag"]
            )
        return _seasonal(
            self.evaluate(expr["of"]), self.bars.t, expr["monthsAhead"], expr["minCount"]
        )

    def _current(self, expr: Mapping[str, Any]) -> Sequence[float]:
        bars = self.bars
        size = len(bars.c)
        if expr["type"] == "price":
            return _column(bars, expr["field"])
        if expr["type"] == "const":
            return [expr["value"]] * size
        name = expr["name"]
        length = expr["length"]
        if length > size:
            raise InputError(f"{name} length {length} is longer than the {size} bars")
        key = f"{name}:{length}:{expr['source']}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        source = _column(bars, expr["source"])
        if name == "adx":
            series = average_directional_index(bars, length)
        elif name == "atr":
            series = average_true_range_dsl(bars, length)
        elif name == "ema":
            series = exponential_mean(source, length)
        elif name == "highest":
            series = prior_extreme(source, length, 1)
        elif name == "lowest":
            series = prior_extreme(source, length, -1)
        elif name == "realizedVol":
            series = realized_volatility(source, length)
        elif name == "rsi":
            series = relative_strength(source, length)
        elif name == "rvol":
            if bars.v is None:
                raise InputError("rvol needs bar volume")
            series = relative_volume_at_time(bars.t, bars.v, length)
        elif name == "sma":
            series = rolling_mean(source, length)
        elif name == "zscore":
            series = rolling_zscore(source, length)
        else:
            raise InputError(f"Unknown indicator: {name}")
        self.cache[key] = series
        return series


def _compare(op: str, left: float, right: float) -> bool:
    if op in (">", "crossesAbove"):
        return left > right
    if op == ">=":
        return left >= right
    if op in ("<", "crossesBelow"):
        return left < right
    return left <= right


def _compare_series(op: str, left: Sequence[float], right: Sequence[float]) -> list[int]:
    """1 where `left op right` holds. A cross holds now but not on the previous bar."""
    cross = op in ("crossesAbove", "crossesBelow")
    out = [0] * len(left)
    previous = False
    for index in range(len(left)):
        now = _compare(op, left[index], right[index])
        out[index] = 1 if (now and not previous if cross else now) else 0
        previous = now
    return out


def _condition_series(evaluator: _Evaluator, condition: Mapping[str, Any]) -> list[int]:
    """1 where the condition holds on the bars."""
    left = evaluator.evaluate(condition["left"])
    right = evaluator.evaluate(condition["right"])
    return _compare_series(condition["op"], left, right)


def _minutes_of(time: str) -> int:
    hours, minutes = time.split(":")
    return int(hours) * 60 + int(minutes)


def _in_session(t: float, session: Mapping[str, str]) -> bool:
    """True when the bar's UTC minute of day is in [start, end); wraps when end < start."""
    minute = math.floor(t / MINUTE_MS) % MINUTES_PER_DAY
    start = _minutes_of(session["startUtc"])
    end = _minutes_of(session["endUtc"])
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


def _is_intraday(t: Sequence[float]) -> bool:
    return any(t[index] - t[index - 1] < INTRADAY_GAP_MS for index in range(1, len(t)))


def _utc_date(t: float) -> str:
    """YYYY-MM-DD of epoch ms `t` in UTC (TS new Date(t).toISOString().slice(0, 10))."""
    return (EPOCH + timedelta(milliseconds=t)).date().isoformat()


def _filter_series(
    t: Sequence[float],
    filter_: Mapping[str, Any],
    points: Sequence[Mapping[str, Any]],
    intraday: bool,
) -> list[int]:
    """1 where the latest known sector point has an allowed quadrant."""
    allowed = set(filter_["quadrants"])
    out = [0] * len(t)
    following = 0
    quadrant: str | None = None
    for index in range(len(t)):
        date = _utc_date(t[index])
        while following < len(points):
            point = points[following]
            if (point["date"] >= date) if intraday else (point["date"] > date):
                break
            quadrant = point["quadrant"]
            following += 1
        if quadrant is not None and quadrant in allowed:
            out[index] = 1
    return out


_DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")

DailySeries = tuple[list[str], list[float]]


def _daily_series(context: Mapping[str, Any] | None, series_id: str) -> DailySeries:
    """The finite values of one context series (id -> {date: value}), by date ascending."""
    by_date = None if context is None else context.get(series_id)
    if by_date is None:
        raise SeriesDataError(series_id)
    dates: list[str] = []
    for day_date in sorted(by_date):
        if _DATE_PATTERN.fullmatch(day_date) is None:
            raise InputError(f"Series {series_id} has a date that is not YYYY-MM-DD: {day_date}")
        if is_finite_number(by_date[day_date]):
            dates.append(day_date)
    return dates, [float(by_date[day_date]) for day_date in dates]


def _align_series(
    dates: Sequence[str],
    values: Sequence[float],
    bar_dates: Sequence[str],
    intraday: bool,
    exact: bool,
) -> list[float]:
    """TS alignSeries: the latest value dated on or before each bar date (before it for intraday
    bars), carried for at most SERIES_MAX_FILL_DAYS later bar dates without a newer one;
    `exact` (daily bars) needs a value on the bar date itself, else NaN."""
    out = [NAN] * len(bar_dates)
    following = 0
    age = 0
    previous_date: str | None = None
    for index, bar_date in enumerate(bar_dates):
        before = following
        while following < len(dates) and (
            dates[following] < bar_date if intraday else dates[following] <= bar_date
        ):
            following += 1
        if following > before:
            age = 0
        elif bar_date != previous_date:
            age += 1
        previous_date = bar_date
        if following == 0 or age > SERIES_MAX_FILL_DAYS:
            continue
        if exact and not intraday and dates[following - 1] != bar_date:
            continue
        out[index] = values[following - 1]
    return out


def iv_rank_series(values: Sequence[float], length: int) -> Series:
    """TS ivRankSeries: 100 * (v - min) / (max - min) over the `length` values ending at each
    value; NaN before that and when the window is flat."""
    highest = prior_extreme(values, length - 1, 1)
    lowest = prior_extreme(values, length - 1, -1)
    out = [NAN] * len(values)
    for index in range(length - 1, len(values)):
        value = values[index]
        high = max(highest[index], value)
        low = min(lowest[index], value)
        if high > low:
            out[index] = 100 * (value - low) / (high - low)
    return out


def _term_ratio(context: Mapping[str, Any] | None) -> DailySeries:
    """VIX / VIX3M on the dates where both have a value (and VIX3M is above 0)."""
    vix_dates, vix_values = _daily_series(context, "VIX")
    long_dates, long_values = _daily_series(context, "VIX3M")
    dates: list[str] = []
    ratios: list[float] = []
    other = 0
    for index, day_date in enumerate(vix_dates):
        while other < len(long_dates) and long_dates[other] < day_date:
            other += 1
        if other == len(long_dates) or long_dates[other] != day_date:
            continue
        denominator = long_values[other]
        if not denominator > 0:
            continue
        dates.append(day_date)
        ratios.append(vix_values[index] / denominator)
    return dates, ratios


def _within(value: float, low: float | None, high: float | None) -> bool:
    return (
        not math.isnan(value)
        and (low is None or value >= low)
        and (high is None or value <= high)
    )


def _mask(size: int, passes: Callable[[int], bool]) -> list[int]:
    return [1 if passes(index) else 0 for index in range(size)]


def _weekday(day: int) -> int:
    """0 Sunday to 6 Saturday of a UTC day number (1970-01-01 was a Thursday)."""
    return (day + 4) % 7


def _day(value: date) -> int:
    return (value - EPOCH_DAY).days


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> int:
    """UTC day of the `n`th `weekday` (0 Sunday to 6 Saturday) of a month (1 January)."""
    first = _day(date(year, month, 1))
    return first + (weekday - _weekday(first) + 7) % 7 + 7 * (n - 1)


def _last_weekday(year: int, month: int, weekday: int) -> int:
    last = _day(date(year + month // 12, month % 12 + 1, 1)) - 1
    return last - (_weekday(last) - weekday + 7) % 7


def _observed(day: int) -> int:
    if _weekday(day) == 6:
        return day - 1
    return day + 1 if _weekday(day) == 0 else day


def _easter_sunday(year: int) -> int:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm), the TS easterSunday."""
    a, b, c = year % 19, year // 100, year % 100
    h = (19 * a + b - b // 4 - (b - (b + 8) // 25 + 1) // 3 + 15) % 30
    l = (32 + 2 * (b % 4) + 2 * (c // 4) - h - c % 4) % 7  # noqa: E741 (name of the algorithm)
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return _day(date(year, month, (h + l - 7 * m + 114) % 31 + 1))


# Special NYSE full-day closures since 1998 (TS NYSE_SPECIAL_CLOSURES): September 11 attacks, the
# days of mourning for Presidents Reagan, Ford, G. H. W. Bush and Carter, and Hurricane Sandy.
NYSE_SPECIAL_CLOSURES = (
    "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11", "2007-01-02",
    "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09",
)  # fmt: skip
# Timeframes of one bar per trading day or longer (TS STRATEGY_DAILY_TIMEFRAMES).
DAILY_TIMEFRAMES = ("1d", "1w")

_HOLIDAYS: dict[int, frozenset[int]] = {}


def nyse_holidays(year: int) -> frozenset[int]:
    """TS nyseHolidays: regular NYSE full-day holidays of a year as UTC days (rules since 1998,
    the rules of strategies/qc_ports calendar.is_nyse_holiday) plus NYSE_SPECIAL_CLOSURES."""
    cached = _HOLIDAYS.get(year)
    if cached is not None:
        return cached
    days = {
        _nth_weekday(year, 1, 1, 3),
        _nth_weekday(year, 2, 1, 3),
        _easter_sunday(year) - 2,
        _last_weekday(year, 5, 1),
        _observed(_day(date(year, 7, 4))),
        _nth_weekday(year, 9, 1, 1),
        _nth_weekday(year, 11, 4, 4),
        _observed(_day(date(year, 12, 25))),
    }
    new_year = _day(date(year, 1, 1))
    if _weekday(new_year) != 6:
        days.add(_observed(new_year))
    if year >= 2022:
        days.add(_observed(_day(date(year, 6, 19))))
    days.update(
        _day(date.fromisoformat(item)) for item in NYSE_SPECIAL_CLOSURES if item.startswith(f"{year}-")
    )
    _HOLIDAYS[year] = frozenset(days)
    return _HOLIDAYS[year]


def is_nyse_trading_day(day: int) -> bool:
    """TS isNyseTradingDay: a weekday that is not an NYSE holiday (UTC day number)."""
    return 1 <= _weekday(day) <= 5 and day not in nyse_holidays((EPOCH_DAY + timedelta(days=day)).year)


def _month_of(day: int) -> tuple[int, int, int]:
    """First and last UTC day number of the month holding `day`, and the month (1 to 12)."""
    day_date = EPOCH_DAY + timedelta(days=day)
    first = date(day_date.year, day_date.month, 1)
    following = date(day_date.year + day_date.month // 12, day_date.month % 12 + 1, 1)
    return (first - EPOCH_DAY).days, (following - EPOCH_DAY).days - 1, day_date.month


def _calendar_mask(filter_: Mapping[str, Any], days: Sequence[int]) -> list[int]:
    """TS calendarMask: daily bars inside the calendar window. Trading days come from the NYSE
    holiday rules; a bar on a day that does not trade is outside turnOfMonth and opexWeek."""

    def count(start: int, end: int) -> int:
        return sum(1 for day in range(start, end + 1) if is_nyse_trading_day(day))

    window = filter_["window"]

    def passes(index: int) -> bool:
        day = days[index]
        first, last, month = _month_of(day)
        if window == "months":
            return month in filter_["months"]
        if not is_nyse_trading_day(day):
            return False
        if window == "turnOfMonth":
            return -count(day, last) >= filter_["fromDay"] or count(first, day) <= filter_["toDay"]
        third_friday = first + (5 - _weekday(first) + 7) % 7 + 14
        expiry = third_friday
        while not is_nyse_trading_day(expiry):
            expiry -= 1
        start = third_friday - 5  # the Sunday before the week
        while not is_nyse_trading_day(start):
            start -= 1
        return start <= day <= expiry

    return _mask(len(days), passes)


def _iv_rank_mask(filter_: Mapping[str, Any], frame: _Frame) -> list[int]:
    symbol = frame.symbol
    if symbol is None:
        raise InputError("ivRank needs the traded symbol")
    index_id = IV_INDEX.get(symbol)
    if index_id is None:
        raise InputError(f"ivRank has no implied-volatility index for {symbol}")
    dates, values = _daily_series(frame.context, index_id)
    rank = _align_on(frame, dates, iv_rank_series(values, filter_["length"]), True)
    low = filter_.get("min")
    high = filter_.get("max")
    return _mask(len(frame.bar_dates), lambda at: _within(rank[at], low, high))


def _vol_regime_mask(filter_: Mapping[str, Any], frame: _Frame) -> list[int]:
    context = frame.context
    vix_dates, vix_values = _daily_series(context, "VIX")
    ratio_dates, ratio_values = _term_ratio(context)
    spy_dates, spy_values = _daily_series(context, "SPY")
    average = rolling_mean(spy_values, filter_["trendLength"])
    trend = [1.0 if close > average[index] else 0.0 for index, close in enumerate(spy_values)]
    vix_on = _align_on(frame, vix_dates, vix_values, True)
    ratio_on = _align_on(frame, ratio_dates, ratio_values, True)
    trend_on = _align_on(frame, spy_dates, trend, True)
    max_vix = filter_["maxVix"]
    max_ratio = filter_["maxTermRatio"]
    return _mask(
        len(frame.bar_dates),
        lambda at: vix_on[at] <= max_vix and ratio_on[at] <= max_ratio and trend_on[at] == 1,
    )


def _series_mask(filter_: Mapping[str, Any], frame: _Frame) -> list[int]:
    """TS seriesMask: the condition on the series (its own dates), each side aligned to the bars."""
    dates, values = _daily_series(frame.context, _series_id(filter_["series"], frame.symbol))
    if not values:
        return [0] * len(frame.bar_dates)
    columns = tuple(values)
    series_bars = Bars(
        t=tuple(
            float((date.fromisoformat(day_date) - EPOCH_DAY).days * DAY_MS) for day_date in dates
        ),
        o=columns,
        h=columns,
        l=columns,
        c=columns,
    )
    # The condition reads the close only (no series expressions), so the frame is never read here.
    evaluator = _Evaluator(series_bars, lambda: frame)
    condition = filter_["condition"]
    left = _align_on(frame, dates, evaluator.evaluate(condition["left"]), False)
    right = _align_on(frame, dates, evaluator.evaluate(condition["right"]), False)
    return _compare_series(condition["op"], left, right)


def _filter_masks(
    evaluator: _Evaluator,
    definition: Mapping[str, Any],
    sector_quadrants: Mapping[str, Any] | None,
) -> list[list[int]]:
    filters = definition["filters"]
    if len(filters) == 0:
        return []
    bars = evaluator.bars
    frame = evaluator.frame()
    intraday = frame.intraday
    masks = []
    for filter_ in filters:
        kind = filter_["type"]
        if kind == "sectorQuadrant":
            key = f"{filter_['sector']}:{filter_['timeframe']}"
            points = None if sector_quadrants is None else sector_quadrants.get(key)
            if points is None:
                raise SectorQuadrantDataError(filter_["sector"], filter_["timeframe"])
            masks.append(_filter_series(bars.t, filter_, points, intraday))
        elif kind == "ivRank":
            masks.append(_iv_rank_mask(filter_, frame))
        elif kind == "vixTermStructure":
            ratio_dates, ratio_values = _term_ratio(frame.context)
            ratio_on = _align_on(frame, ratio_dates, ratio_values, True)
            low = filter_.get("minRatio")
            high = filter_.get("maxRatio")
            masks.append([1 if _within(value, low, high) else 0 for value in ratio_on])
        elif kind == "volRegime":
            masks.append(_vol_regime_mask(filter_, frame))
        elif kind == "calendarWindow":
            # Fail closed: the UTC date of an intraday bar is not its exchange session.
            if intraday:
                raise calendar_intraday_unsupported()
            masks.append(_calendar_mask(filter_, [math.floor(t / DAY_MS) for t in bars.t]))
        else:
            masks.append(_series_mask(filter_, frame))
    return masks


def _distance_series(
    evaluator: _Evaluator, level: Mapping[str, Any]
) -> tuple[float, ...] | None:
    if level["kind"] != "atr":
        return None
    atr = evaluator.evaluate(
        {"type": "indicator", "name": "atr", "length": level["length"], "source": "close", "offset": 0}
    )
    multiple = level["multiple"]
    return tuple(value * multiple for value in atr)


def compile_strategy(
    bars: Bars,
    definition: Mapping[str, Any],
    sector_quadrants: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
    symbol: str | None = None,
    calendar: Sequence[str] | None = None,
) -> Compiled:
    """TS compileStrategy: 1 when every entry condition and filter holds in the session, else -1
    when any exit condition holds, else 0. The exit mask keeps exits also on entry bars.

    `context` maps series id -> {YYYY-MM-DD: value} for the ivRank, vixTermStructure, volRegime
    and series filters and the series expressions; `symbol` is the traded symbol whose IV index
    ivRank reads and that resolves $tr, $iv and $future. `calendar` (TS
    StrategySeriesInput.calendar): ascending trading dates holding every bar date; series align on
    it, then are read at the bar dates."""
    normalized = normalize_definition(definition)
    size = len(bars.c)
    evaluator = _Evaluator(bars, lambda: _series_frame(bars, context, symbol, calendar))
    filters = _filter_masks(evaluator, normalized, sector_quadrants)
    entries = [_condition_series(evaluator, c) for c in normalized["entry"]["all"]] + filters
    exits = [_condition_series(evaluator, c) for c in normalized["exit"]["any"]]
    session = normalized["session"]
    signals = [0] * size
    exit_mask = [0] * size
    for index in range(size):
        enter = all(series[index] == 1 for series in entries) and (
            session is None or _in_session(bars.t[index], session)
        )
        leave = any(series[index] == 1 for series in exits)
        if leave:
            exit_mask[index] = 1
        if enter:
            signals[index] = 1
        elif leave:
            signals[index] = -1
    return Compiled(
        signals=tuple(signals),
        exits=tuple(exit_mask),
        stop_distance=_distance_series(evaluator, normalized["stopLoss"]),
        target_distance=_distance_series(evaluator, normalized["takeProfit"]),
        options=normalized["options"],
        portfolio=None if definition.get("portfolio") is None else dict(definition["portfolio"]),
    )


def expression_values(
    bars: Bars,
    expr: Mapping[str, Any],
    context: Mapping[str, Any] | None = None,
    symbol: str | None = None,
    calendar: Sequence[str] | None = None,
) -> list[float]:
    """TS evaluateStrategyExpression: the values of one raw expression on each bar (NaN = not
    available), normalized and checked like a condition side; series read `context` like
    compile_strategy. For portfolio selection scores."""
    normalized = _normalize_expr(expr)
    _check_expr_limits([normalized])
    evaluator = _Evaluator(bars, lambda: _series_frame(bars, context, symbol, calendar))
    return list(evaluator.evaluate(normalized))


def _filter_reads(filter_: Mapping[str, Any]) -> list[str]:
    """TS FILTER_SERIES: the series refs one filter reads."""
    kind = filter_["type"]
    if kind == "ivRank":
        return ["$iv"]
    if kind == "vixTermStructure":
        return ["VIX", "VIX3M"]
    if kind == "volRegime":
        return ["VIX", "VIX3M", "SPY"]
    if kind == "series":
        return [filter_["series"]]
    return []


def strategy_series_refs(definition: Mapping[str, Any]) -> list[str]:
    """TS strategySeriesRefs of a normalized definition: every series ref it reads, first use
    first (filters, then condition expressions, per part; then the portfolio selection)."""
    portfolio = definition.get("portfolio") or {}
    refs: list[str] = []
    for part in [definition, *(portfolio.get("legs") or [])]:
        for filter_ in part.get("filters") or []:
            refs.extend(_filter_reads(filter_))
        conditions = [
            *((part.get("entry") or {}).get("all") or []),
            *((part.get("exit") or {}).get("any") or []),
        ]
        for condition in conditions:
            refs.extend(expr_series(condition["left"]))
            refs.extend(expr_series(condition["right"]))
    select = portfolio.get("select")
    if select is not None:
        refs.extend(expr_series(select["score"]))
        if select.get("tieBreak") is not None:
            refs.extend(expr_series(select["tieBreak"]))
    return list(dict.fromkeys(refs))


def server_refusal(
    definition: Mapping[str, Any],
    timeframe: str | None = None,
    support: Mapping[str, bool] | None = None,
) -> StrategyUnsupportedError | None:
    """TS serverStrategyRefusal of a normalized definition. `support` says what the path loads:
    without "options" it refuses an options block (and options run on 1d only); without "series"
    it refuses every filter or expression that reads a series; then calendar filters on a
    non-daily `timeframe`."""
    support = support or {}
    filters = definition["filters"]
    if definition["options"] is not None:
        if support.get("options") is not True:
            return options_unsupported()
        if timeframe is not None and timeframe != "1d":
            return options_timeframe_unsupported()
    if support.get("series") is not True and strategy_series_refs(definition):
        types = list(dict.fromkeys(item["type"] for item in filters if _filter_reads(item)))
        what = f"the {', '.join(types)} filters" if types else "series expressions"
        return series_filters_unsupported(what)
    if (
        timeframe is not None
        and timeframe not in DAILY_TIMEFRAMES
        and any(item["type"] == "calendarWindow" for item in filters)
    ):
        return calendar_intraday_unsupported()
    return None


def plan_run(
    bars: Bars, spec: Mapping[str, Any], support: Mapping[str, bool] | None = None
) -> tuple[Compiled, RunOptions]:
    """Signals and run options for one backtest spec (JSON from TypeScript).

    "dsl" rules work like runStrategyDefinition: percent stop and target, ATR distances, riskPct
    sizing and the exit mask come from the definition (spec stopLossPct/takeProfitPct are
    ignored). Fixed rules work like runInstantBacktest with the spec stop and target. Like the
    TypeScript server engine it refuses (StrategyUnsupportedError) an options block always, and
    filters and expressions that read series unless `support["series"]` (default: when the spec
    has a "context"); then the spec "context", "symbol" and "calendar" are the series input.
    """
    rule = spec["rule"]
    cost_bps = spec.get("costBps", 0)
    costs = spec.get("costs")
    if rule.get("kind") == "dsl":
        definition = normalize_definition(rule["definition"])
        # The server equity engine (TS runStrategyDefinition): options are refused whatever
        # `support` says; series only load with series support.
        context = spec.get("context")
        series = (support or {"series": context is not None}).get("series") is True
        refusal = server_refusal(
            definition, spec.get("timeframe"), {"series": True} if series else {}
        )
        if refusal is not None:
            raise refusal
        # The raw definition: compile_strategy normalizes it again.
        compiled = compile_strategy(
            bars,
            rule["definition"],
            spec.get("sectorQuadrants"),
            context if series else None,
            spec.get("symbol") if series else None,
            spec.get("calendar") if series else None,
        )
        stop = definition["stopLoss"]
        target = definition["takeProfit"]
        sizing = definition["sizing"]
        options = RunOptions(
            cost_bps=cost_bps,
            stop_loss_pct=stop["pct"] if stop["kind"] == "pct" else 0,
            take_profit_pct=target["pct"] if target["kind"] == "pct" else 0,
            costs=costs,
            risk_pct=sizing["riskPct"] if sizing["mode"] == "riskPct" else None,
        )
        size = assert_columns(bars)
    else:
        size = assert_columns(bars)
        assert_params(spec.get("stopLossPct"), spec.get("takeProfitPct"), cost_bps, costs)
        compiled = Compiled(
            signals=compile_rule(bars, rule), exits=None, stop_distance=None, target_distance=None
        )
        options = RunOptions(
            cost_bps=cost_bps,
            stop_loss_pct=spec["stopLossPct"],
            take_profit_pct=spec["takeProfitPct"],
            costs=costs,
        )
    assert_signal_options(
        size,
        compiled.signals,
        cost_bps=options.cost_bps,
        stop_loss_pct=options.stop_loss_pct,
        take_profit_pct=options.take_profit_pct,
        costs=options.costs,
        risk_pct=options.risk_pct,
        max_hold_bars=options.max_hold_bars,
    )
    return (compiled, options)


__all__ = [
    "Compiled",
    "RunOptions",
    "average_directional_index",
    "average_true_range_dsl",
    "compile_rule",
    "compile_strategy",
    "expression_values",
    "exponential_mean",
    "is_nyse_trading_day",
    "iv_rank_series",
    "nyse_holidays",
    "normalize_definition",
    "plan_run",
    "prior_extreme",
    "realized_volatility",
    "relative_strength",
    "relative_volume_at_time",
    "resolve_series",
    "server_refusal",
    "strategy_series_refs",
    "rolling_mean",
    "rolling_zscore",
    "wilder_rsi",
]
