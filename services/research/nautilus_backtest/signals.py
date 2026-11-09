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
    intraday_daily_unsupported,
    intraday_grid_misaligned,
    is_finite_number,
    options_timeframe_unsupported,
    options_unsupported,
    series_filters_unsupported,
)
from .costs import _js_div, _js_max, _js_min

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
OPERATORS = (">", ">=", "<", "<=", "crossesAbove", "crossesBelow", "breaksAbove", "breaksBelow")
# Operators that oncePerLevel may limit (strategy-dsl.ts STRATEGY_EVENT_OPERATORS).
EVENT_OPERATORS = ("crossesAbove", "crossesBelow", "breaksAbove", "breaksBelow")
# Indicator timeframes (STRATEGY_INDICATOR_TIMEFRAMES); a session day starts at 17:00 New York.
INDICATOR_TIMEFRAMES = ("1d",)
# Session indicators (STRATEGY_SESSION_INDICATORS): they need an intraday block.
SESSION_INDICATORS = ("vwap", "sessionReturn", "noiseBand")
NOISE_BANDS = ("upper", "lower")
NOISE_BAND_MAX_LENGTH = 60
SESSION_ANCHORS = ("prevClose", "open")
SIDES = ("long", "short")
INTRADAY_TIMEZONE = "America/New_York"
INTRADAY_MAX_DECISION_MINUTES = 390
VOL_TARGET_MIN_LENGTH = 2
VOL_TARGET_MAX_LENGTH = 252
_NEW_YORK_TIME = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
MAX_LEVERAGE = 50
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
    # TS PositionManagement: {"breakevenR"?: float, "trail"?: {"activateR", "multiple", "atr"}}
    # (atr: tuple, the DSL ATR of the signal bars), or None without a management block.
    management: dict[str, Any] | None = None
    # With an intraday block: 1 on the last regular bar of each session day (market on close).
    close_at: tuple[int, ...] | None = None
    # With volTarget sizing: the leverage at each signal bar (vol_target_leverage).
    leverage: tuple[float, ...] | None = None


@dataclass(frozen=True)
class RunOptions:
    """Mirror of the TypeScript SignalRunOptions (without the arrays, which live in Compiled)."""

    cost_bps: float
    stop_loss_pct: float
    take_profit_pct: float
    costs: dict | None
    risk_pct: float | None = None
    max_hold_bars: int | None = None
    # With risk_pct: cap the position cost at cash * max_leverage (1 to 50) instead of the cash.
    max_leverage: float | None = None
    # "short" sells at the entry and buys back at the exit; None or "long" is long.
    side: str | None = None


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


# Keys of each object the TS schema declares .strict() (unknown keys are an input error).
_DEFINITION_KEYS = frozenset({"version", "name", "description", "entry", "exit", "filters", "intraday",
                              "management", "options", "portfolio", "session", "side", "sizing", "stopLoss",
                              "takeProfit"})
_EXPR_KEYS = {
    "price": frozenset({"type", "field", "offset"}),
    "const": frozenset({"type", "value"}),
    "indicator": frozenset({"type", "name", "length", "source", "offset", "timeframe"}),
    "series": frozenset({"type", "series", "offset"}),
    "math": frozenset({"type", "op", "left", "right"}),
    "change": frozenset({"type", "of", "length", "offset"}),
    "returnStdev": frozenset({"type", "of", "length"}),
    "regression": frozenset({"type", "y", "x", "length", "lag"}),
    "seasonal": frozenset({"type", "of", "monthsAhead", "minCount"}),
}
_CONDITION_KEYS = frozenset({"left", "op", "right", "oncePerLevel"})
# Session indicators take no length, source, offset or timeframe (noiseBand takes its own length).
_SESSION_EXPR_KEYS = {
    "vwap": frozenset({"type", "name"}),
    "sessionReturn": frozenset({"type", "name", "from", "to"}),
    "noiseBand": frozenset({"type", "name", "band", "length", "multiple"}),
}
_INTRADAY_KEYS = frozenset({"timezone", "open", "close", "entryFrom", "entryTo", "decisionEvery"})
_LEG_KEYS = frozenset({"entry", "exit", "filters", "options"})


def _strict(value: Mapping[str, Any], keys: frozenset[str], where: str) -> None:
    """TS .strict(): rejects keys the schema does not declare."""
    unknown = sorted(set(value) - keys)
    if unknown:
        raise InputError(f"Unknown key in {where}: {unknown[0]}")


def _is_whole(value: Any, low: int, high: int) -> bool:
    """A whole number from low to high; a float with no fraction counts (JSON has one number type)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return float(value).is_integer() and low <= value <= high


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


_EXPR_DEPTH_MESSAGE = f"An expression may nest at most {MAX_EXPR_DEPTH} levels"
# Child keys of each nested expression type (raw input; other types are leaves).
_RAW_EXPR_CHILD_KEYS: dict[str, tuple[str, ...]] = {
    "change": ("of",),
    "math": ("left", "right"),
    "regression": ("y", "x"),
    "returnStdev": ("of",),
    "seasonal": ("of",),
}


def _check_raw_expr_depth(expr: Any) -> None:
    """TS rawStrategyExprTooDeep: rejects raw input nesting deeper than MAX_EXPR_DEPTH. Iterative
    and stops at the first node past the limit, so any input depth is safe for the recursive
    normalizer."""
    stack: list[tuple[Any, int]] = [(expr, 1)]
    while stack:
        node, depth = stack.pop()
        if not isinstance(node, Mapping):
            continue
        if depth > MAX_EXPR_DEPTH:
            raise InputError(_EXPR_DEPTH_MESSAGE)
        kind = node.get("type")
        for key in _RAW_EXPR_CHILD_KEYS.get(kind, ()) if isinstance(kind, str) else ():
            if key in node:
                stack.append((node[key], depth + 1))


def _new_york_time(value: Any, what: str) -> str:
    """An HH:MM New York time (TS NewYorkTimeSchema)."""
    if not (isinstance(value, str) and _NEW_YORK_TIME.fullmatch(value)):
        raise InputError(f"{what}: Expected HH:MM (New York)")
    return value


def _is_session_indicator(expr: Mapping[str, Any]) -> bool:
    """TS isSessionIndicator: vwap, sessionReturn and noiseBand."""
    return expr.get("type") == "indicator" and expr.get("name") in SESSION_INDICATORS


def _normalize_session_expr(expr: Mapping[str, Any]) -> dict[str, Any]:
    """vwap, sessionReturn and noiseBand expressions (no defaults are added)."""
    name = expr["name"]
    _strict(expr, _SESSION_EXPR_KEYS[name], f"{name} expression")
    if name == "vwap":
        return {"type": "indicator", "name": name}
    if name == "sessionReturn":
        origin = expr.get("from")
        timed = origin not in SESSION_ANCHORS
        if timed:
            _new_york_time(origin, "sessionReturn from")
        to = _new_york_time(expr.get("to"), "sessionReturn to")
        if timed and not origin < to:
            raise InputError("sessionReturn from must be before to")
        return {"type": "indicator", "name": name, "from": origin, "to": to}
    band = expr.get("band")
    if band not in NOISE_BANDS:
        raise InputError(f"Unknown noiseBand band: {band}")
    length = expr.get("length")
    if not _is_whole(length, 1, NOISE_BAND_MAX_LENGTH):
        raise InputError(f"noiseBand length must be a whole number from 1 to {NOISE_BAND_MAX_LENGTH}")
    normalized: dict[str, Any] = {"type": "indicator", "name": name, "band": band, "length": int(length)}
    if "multiple" in expr:
        multiple = expr["multiple"]
        if not (is_finite_number(multiple) and 0 < multiple <= 100):
            raise InputError("noiseBand multiple must be above 0 and at most 100")
        normalized["multiple"] = float(multiple)
    return normalized


def _normalize_expr(expr: Mapping[str, Any]) -> dict[str, Any]:
    """StrategyExprSchema defaults of one expression tree (idempotent); offsets default to 0."""
    _check_raw_expr_depth(expr)
    kind = expr.get("type")
    if _is_session_indicator(expr):
        return _normalize_session_expr(expr)
    if kind in _EXPR_KEYS:
        _strict(expr, _EXPR_KEYS[kind], f"{kind} expression")
    if kind == "price":
        if expr.get("field") not in PRICE_FIELDS:
            raise InputError(f"Unknown price field: {expr.get('field')}")
        return {"type": "price", "field": expr["field"], "offset": _offset(expr)}
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
        normalized = {
            "type": "indicator",
            "name": name,
            "length": int(length),
            "source": source,
            "offset": _offset(expr),
        }
        timeframe = expr.get("timeframe")
        if timeframe is not None:
            if timeframe not in INDICATOR_TIMEFRAMES:
                raise InputError(f"Unknown indicator timeframe: {timeframe}")
            if name == "rvol":
                raise InputError("rvol has no timeframe; it already compares whole sessions")
            normalized["timeframe"] = timeframe
        return normalized
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
            raise InputError(_EXPR_DEPTH_MESSAGE)
        nodes += size
    if nodes > MAX_EXPR_NODES:
        raise InputError(f"A condition may hold at most {MAX_EXPR_NODES} expression nodes")


def _normalize_condition(condition: Mapping[str, Any]) -> dict[str, Any]:
    _strict(condition, _CONDITION_KEYS, "condition")
    op = condition.get("op")
    if op not in OPERATORS:
        raise InputError(f"Unknown operator: {op}")
    normalized = {
        "left": _normalize_expr(condition["left"]),
        "op": op,
        "right": _normalize_expr(condition["right"]),
    }
    once = condition.get("oncePerLevel")
    if "oncePerLevel" in condition and not isinstance(once, bool):
        raise InputError("oncePerLevel must be true or false")
    if once:
        if op not in EVENT_OPERATORS:
            raise InputError(
                "oncePerLevel works only with crossesAbove, crossesBelow, breaksAbove and breaksBelow"
            )
        normalized["oncePerLevel"] = True
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
    # Session indicators read a regular session of intraday bars, which a series does not have.
    if _is_session_indicator(expr):
        return False
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
        raw = item["condition"]
        if "oncePerLevel" in raw or any(
            isinstance(side, Mapping) and "timeframe" in side for side in (raw.get("left"), raw.get("right"))
        ):
            raise InputError(
                "A series condition takes no oncePerLevel or timeframe: the series has one value per date"
            )
        condition = _normalize_condition(raw)
        if not (_close_only(condition["left"]) and _close_only(condition["right"])):
            raise InputError(SERIES_CLOSE_ONLY)
        return {"type": "series", "series": series, "condition": condition}
    raise InputError(f"Unknown filter type: {kind}")


def _management_level(value: Any, name: str) -> float:
    if not (is_finite_number(value) and 0 < value <= 100):
        raise InputError(f"management {name} must be above 0 and at most 100")
    return float(value)


def _normalize_management(
    management: Mapping[str, Any] | None, stop_loss: Mapping[str, Any], options: Any
) -> dict[str, Any] | None:
    """TS StrategyManagementSchema and its definition refinements; None without a block."""
    if management is None:
        return None
    _strict(management, frozenset({"breakevenR", "trail"}), "management")
    normalized: dict[str, Any] = {}
    if "breakevenR" in management:
        normalized["breakevenR"] = _management_level(management["breakevenR"], "breakevenR")
    if "trail" in management:
        trail = management["trail"]
        if not isinstance(trail, Mapping):
            raise InputError("management trail must be an object")
        _strict(trail, frozenset({"activateR", "length", "multiple"}), "management trail")
        length = _whole(trail.get("length"), "management trail length", 1, MAX_LENGTH)
        normalized["trail"] = {
            "activateR": _management_level(trail.get("activateR"), "trail activateR"),
            "length": length,
            "multiple": _management_level(trail.get("multiple"), "trail multiple"),
        }
    if not normalized:
        raise InputError("management needs trail, breakevenR or both")
    # Options first: an options block needs no stop loss, so the stop message would mislead.
    if options is not None:
        raise InputError(
            "Option strategies exit by profitTakePct, exitDte and exit conditions; remove management"
        )
    if stop_loss["kind"] == "none":
        raise InputError("management moves the stop loss; add a stop loss")
    return normalized


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
    _strict(leg, _LEG_KEYS, "portfolio leg")
    leg_entry = leg.get("entry") or {}
    _strict(leg_entry, frozenset({"all"}), "portfolio leg entry")
    normalized: dict[str, Any] = {
        "entry": {"all": _condition_list(leg_entry.get("all"), "A leg entry", 1)},
        "options": dict(options),
    }
    if leg.get("exit") is not None:
        _strict(leg["exit"], frozenset({"any"}), "portfolio leg exit")
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
    """TS calendarOnly of a raw definition or leg: entry exactly `close > 0` (no entry.any), no exit
    and only calendarWindow filters (at least one)."""
    entry = list((part.get("entry") or {}).get("all") or [])
    if len(entry) != 1 or len((part.get("entry") or {}).get("any") or []) > 0:
        return False
    only = entry[0]
    left = only.get("left") or {}
    right = only.get("right") or {}
    filters = list(part.get("filters") or [])
    return (
        only.get("op") == ">"
        and left.get("type") == "price"
        and left.get("field") == "close"
        and left.get("offset", 0) in (None, 0)
        and right.get("type") == "const"
        and is_finite_number(right.get("value"))
        and right["value"] == 0
        and len((part.get("exit") or {}).get("any") or []) == 0
        and len(filters) > 0
        and all(item.get("type") == "calendarWindow" for item in filters)
    )


_PORTFOLIO_KEYS = frozenset({"cadence", "frame", "legs", "policy", "select", "shift", "symbols"})
_SELECT_KEYS = frozenset({"score", "tieBreak", "top"})


def _check_keys(block: Any, known: frozenset[str], name: str) -> None:
    """zod .strict() object with optional (not nullable) keys: an object, no unknown keys, no
    null values."""
    if not isinstance(block, Mapping):
        raise InputError(f"{name} must be an object")
    for key, value in block.items():
        if key not in known:
            raise InputError(f"Unknown {name} key: {key}")
        if value is None:
            raise InputError(f"{name} {key} must not be null")


def _with_expr_defaults(expr: Mapping[str, Any]) -> dict[str, Any]:
    """The zod output of a validated raw expression: indicators get source close; offsets stay
    absent when absent (unlike _normalize_expr)."""
    out = dict(expr)
    if out.get("type") == "indicator":
        out.setdefault("source", "close")
    for key in _RAW_EXPR_CHILD_KEYS.get(out.get("type"), ()):
        out[key] = _with_expr_defaults(out[key])
    return out


def _with_condition_defaults(condition: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **condition,
        "left": _with_expr_defaults(condition["left"]),
        "right": _with_expr_defaults(condition["right"]),
    }


def _with_filter_defaults(item: Mapping[str, Any]) -> dict[str, Any]:
    out = dict(item)
    kind = out.get("type")
    if kind == "sectorQuadrant":
        out.setdefault("timeframe", "weekly")
        out["quadrants"] = list(out["quadrants"])
    elif kind == "ivRank":
        out.setdefault("length", IV_RANK_DEFAULT_LENGTH)
    elif kind == "volRegime":
        out.setdefault("trendLength", VOL_REGIME_DEFAULT_TREND_LENGTH)
    elif kind == "calendarWindow" and "months" in out:
        out["months"] = list(out["months"])
    elif kind == "series":
        out["condition"] = _with_condition_defaults(out["condition"])
    return out


def ts_portfolio(portfolio: Mapping[str, Any]) -> dict[str, Any]:
    """The StrategyPortfolioSchema output (zod defaults applied, absent optional keys absent) of a
    validated raw portfolio block: what TS compileStrategy returns as `portfolio`."""
    out = dict(portfolio)
    out["symbols"] = list(out["symbols"])
    if "legs" in out:
        legs = []
        for leg in out["legs"]:
            ts_leg = dict(leg)
            ts_leg["options"] = dict(leg["options"])
            ts_leg["entry"] = {"all": [_with_condition_defaults(c) for c in leg["entry"]["all"]]}
            if "exit" in leg:
                ts_leg["exit"] = {"any": [_with_condition_defaults(c) for c in leg["exit"]["any"]]}
            if "filters" in leg:
                ts_leg["filters"] = [_with_filter_defaults(item) for item in leg["filters"]]
            legs.append(ts_leg)
        out["legs"] = legs
    if "select" in out:
        select = dict(out["select"])
        select["score"] = _with_expr_defaults(select["score"])
        if "tieBreak" in select:
            select["tieBreak"] = _with_expr_defaults(select["tieBreak"])
        out["select"] = select
    return out


MONTHLY_UNSUPPORTED_INDICATORS = ("atr", "adx", "rvol")
MONTHLY_INDICATOR_MESSAGE = (
    "frame monthly bars have high = low = close and no volume: atr, adx and rvol are not available"
)


def _uses_bar_range_indicator(expr: Mapping[str, Any]) -> bool:
    """Whether a normalized expression reads atr, adx or rvol (TS usesBarRangeIndicator)."""
    return (
        expr["type"] == "indicator" and expr["name"] in MONTHLY_UNSUPPORTED_INDICATORS
    ) or any(_uses_bar_range_indicator(child) for child in _expr_children(expr))


def _normalize_portfolio(portfolio: Mapping[str, Any]) -> dict[str, Any]:
    """StrategyPortfolioSchema with its refinements (same messages); optional keys stay absent.
    Like zod .strict() with .optional() keys, unknown keys and null values are refused."""
    _check_keys(portfolio, _PORTFOLIO_KEYS, "portfolio")
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
        _check_keys(select, _SELECT_KEYS, "portfolio select")
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


def _normalize_intraday(intraday: Any) -> dict[str, Any] | None:
    """TS StrategyIntradaySchema; None without a block."""
    if intraday is None:
        return None
    if not isinstance(intraday, Mapping):
        raise InputError("intraday must be an object")
    _strict(intraday, _INTRADAY_KEYS, "intraday")
    if intraday.get("timezone") != INTRADAY_TIMEZONE:
        raise InputError(f'intraday timezone must be "{INTRADAY_TIMEZONE}"')
    times = {key: _new_york_time(intraday.get(key), f"intraday {key}")
             for key in ("open", "close", "entryFrom", "entryTo")}
    if not times["open"] < times["close"]:
        raise InputError("intraday open must be before close")
    if not times["open"] < times["entryFrom"] <= times["entryTo"] < times["close"]:
        raise InputError(
            "The entry window must be inside the session: open < entryFrom <= entryTo < close"
        )
    normalized: dict[str, Any] = {"timezone": INTRADAY_TIMEZONE, **times}
    if "decisionEvery" in intraday:
        every = intraday["decisionEvery"]
        if not _is_whole(every, 1, INTRADAY_MAX_DECISION_MINUTES):
            raise InputError(
                f"intraday decisionEvery must be a whole number from 1 to {INTRADAY_MAX_DECISION_MINUTES}"
            )
        normalized["decisionEvery"] = int(every)
    return normalized


def _normalize_vol_target(sizing: Mapping[str, Any]) -> dict[str, Any]:
    """TS VolTargetSizingSchema."""
    _strict(sizing, frozenset({"mode", "targetPct", "length", "maxLeverage"}), "sizing")
    target = sizing.get("targetPct")
    length = sizing.get("length")
    cap = sizing.get("maxLeverage")
    if not (is_finite_number(target) and 0 < target <= 100):
        raise InputError("volTarget targetPct must be above 0 and at most 100")
    if not _is_whole(length, VOL_TARGET_MIN_LENGTH, VOL_TARGET_MAX_LENGTH):
        raise InputError(
            f"volTarget length must be a whole number from {VOL_TARGET_MIN_LENGTH} to {VOL_TARGET_MAX_LENGTH}"
        )
    if not (is_finite_number(cap) and 0 < cap <= MAX_LEVERAGE):
        raise InputError(f"volTarget maxLeverage must be above 0 and at most {MAX_LEVERAGE}")
    return {"mode": "volTarget", "targetPct": float(target), "length": int(length), "maxLeverage": float(cap)}


def _session_indicator_in(expr: Mapping[str, Any]) -> str | None:
    """TS sessionIndicatorIn: the name of the first session indicator in an expression tree."""
    if _is_session_indicator(expr):
        return expr["name"]
    for child in _expr_children(expr):
        name = _session_indicator_in(child)
        if name is not None:
            return name
    return None


def _check_intraday_and_side(
    normalized: dict[str, Any], management: Any, options: Any
) -> None:
    """The definition refinements of side, intraday and volTarget (TS StrategyDefinitionSchema)."""
    side = normalized["side"]
    intraday = normalized["intraday"]
    if options is not None and normalized["sizing"]["mode"] == "volTarget":
        raise InputError("Option strategies size by options.maxLossPct; remove the volTarget sizing")
    if side == "short" and management is not None:
        raise InputError("management raises a long stop; a short definition takes no management")
    if side == "short" and options is not None:
        raise InputError("Option strategies take their direction from options.structure; remove side")
    if intraday is not None and options is not None:
        raise InputError("Option strategies run on daily bars; remove the intraday block")
    if intraday is not None and any(item["type"] == "calendarWindow" for item in normalized["filters"]):
        raise InputError("calendarWindow filters run on daily bars only; remove them or the intraday block")
    if intraday is None:
        conditions = (*normalized["entry"]["all"], *normalized["entry"].get("any", []), *normalized["exit"]["any"])
        for condition in conditions:
            for expr in (condition["left"], condition["right"]):
                name = _session_indicator_in(expr)
                if name is not None:
                    raise InputError(f"{name} reads the intraday session; add an intraday block")


def normalize_definition(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Applies the StrategyDefinitionSchema defaults and rejects unknown names, operators and keys
    (the TS schema objects are strict; filter and options blocks keep their own checks)."""
    _strict(definition, _DEFINITION_KEYS, "definition")
    entry = definition.get("entry") or {}
    _strict(entry, frozenset({"all", "any"}), "entry")
    entry_all = entry.get("all") or []
    entry_any = entry.get("any") or []
    if len(entry_all) + len(entry_any) == 0:
        raise InputError("Entry needs at least one condition in entry.all or entry.any")
    exit_ = definition.get("exit") or {}
    _strict(exit_, frozenset({"any"}), "exit")
    exit_any = exit_.get("any") or []
    sizing = definition.get("sizing") or {"mode": "allIn"}
    if sizing.get("mode") == "riskPct":
        _strict(sizing, frozenset({"mode", "riskPct", "maxLeverage"}), "sizing")
        max_leverage = sizing.get("maxLeverage")
        sizing = {"mode": "riskPct", "riskPct": float(sizing["riskPct"])}
        if max_leverage is not None:
            if not (is_finite_number(max_leverage) and 1 <= max_leverage <= MAX_LEVERAGE):
                raise InputError(f"maxLeverage must be from 1 to {MAX_LEVERAGE}")
            sizing["maxLeverage"] = float(max_leverage)
    elif sizing.get("mode") == "volTarget":
        sizing = _normalize_vol_target(sizing)
    elif sizing.get("mode") == "allIn":
        if "maxLeverage" in sizing:
            raise InputError("maxLeverage needs riskPct sizing")
        _strict(sizing, frozenset({"mode"}), "sizing")
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
    management = _normalize_management(definition.get("management"), stop_loss, options)
    entry_conditions = [_normalize_condition(c) for c in entry_all]
    entry_any_conditions = [_normalize_condition(c) for c in entry_any]
    exit_conditions = [_normalize_condition(c) for c in exit_any]
    entry_out: dict[str, Any] = {"all": entry_conditions}
    if entry_any_conditions:
        entry_out["any"] = entry_any_conditions
    if normalized_portfolio is not None and normalized_portfolio.get("frame") == "monthly":
        select = normalized_portfolio.get("select") or {}
        exprs = [
            side
            for part in [
                {"entry": entry_out, "exit": {"any": exit_conditions}},
                *normalized_portfolio.get("legs", []),
            ]
            for condition in [
                *part["entry"]["all"],
                *part["entry"].get("any", []),
                *(part.get("exit") or {}).get("any", []),
            ]
            for side in (condition["left"], condition["right"])
        ] + [select[key] for key in ("score", "tieBreak") if key in select]
        if any(_uses_bar_range_indicator(expr) for expr in exprs):
            raise InputError(MONTHLY_INDICATOR_MESSAGE)
    side = definition.get("side")
    if side is not None and side not in SIDES:
        raise InputError(f"Unknown side: {side}")
    normalized = {
        "name": definition.get("name"),
        "entry": entry_out,
        "exit": {"any": exit_conditions},
        "filters": filters,
        "intraday": _normalize_intraday(definition.get("intraday")),
        "management": management,
        "options": None if options is None else dict(options),
        "portfolio": normalized_portfolio,
        "session": None if session is None else {"startUtc": session["startUtc"], "endUtc": session["endUtc"]},
        "side": side,
        "sizing": sizing,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
    }
    _check_intraday_and_side(normalized, management, options)
    return normalized


def _column(bars: Bars, field: str) -> Sequence[float]:
    return getattr(bars, FIELD_KEY[field])


def _shift(values: Sequence[float], offset: int) -> Series:
    """Series value `offset` bars ago; NaN before the first available bar."""
    size = len(values)
    out = [NAN] * size
    if offset < size:
        out[offset:] = values[: size - offset]
    return out


def _indicator_key(expr: Mapping[str, Any]) -> str:
    """TS indicatorKey: name:length:source, plus :timeframe when set."""
    timeframe = expr.get("timeframe")
    suffix = "" if timeframe is None else f":{timeframe}"
    return f"{expr['name']}:{expr['length']}:{expr['source']}{suffix}"


# A session day starts at 17:00 New York: the day key is the New York date of t + 7 hours.
SESSION_DAY_SHIFT_MS = 7 * HOUR_MS


def session_daily_bars(bars: Bars) -> tuple[Bars, list[int]]:
    """TS sessionDailyBars: daily bars (first open, highest high, lowest low, last close, summed
    volume when present; time of the first signal bar) and the daily index of every signal bar."""
    offsets: dict[int, float] = {}
    day: list[int] = []
    t: list[float] = []
    o: list[float] = []
    h: list[float] = []
    low_: list[float] = []
    c: list[float] = []
    v: list[float] = []
    key: float | None = None
    for index in range(len(bars.c)):
        shifted = bars.t[index] + SESSION_DAY_SHIFT_MS
        following = math.floor((shifted + _new_york_offset(shifted, offsets)) / DAY_MS)
        high = bars.h[index]
        low = bars.l[index]
        volume = 0.0 if bars.v is None else bars.v[index]
        if following != key:
            key = following
            t.append(bars.t[index])
            o.append(bars.o[index])
            h.append(high)
            low_.append(low)
            v.append(volume)
            c.append(0.0)
        else:
            if high > h[-1]:
                h[-1] = high
            if low < low_[-1]:
                low_[-1] = low
            v[-1] = v[-1] + volume
        c[-1] = bars.c[index]
        day.append(len(c) - 1)
    daily = Bars(
        t=tuple(t), o=tuple(o), h=tuple(h), l=tuple(low_), c=tuple(c),
        v=None if bars.v is None else tuple(v),
    )
    return daily, day


# Intraday sessions (strategy-dsl-compile.ts intradaySessions and the session indicators).


@dataclass(frozen=True)
class IntradaySessions:
    """TS IntradaySessions: the regular-session layout of intraday bars for one intraday block."""

    bars: Bars
    # Bar duration in ms: the most common gap between bars of one New York date (ties: smaller).
    duration: float
    # Close time of each bar: ms after midnight of its New York date (bar time + duration).
    close_ms: tuple[float, ...]
    open_ms: float
    # Session day of each regular bar (0, 1, ...), -1 for every other bar.
    session: tuple[int, ...]
    # 1 on the last regular bar of each session day.
    last: tuple[int, ...]
    day_open: tuple[float, ...]
    day_close: tuple[float, ...]


def intraday_sessions(bars: Bars, intraday: Mapping[str, Any]) -> IntradaySessions | None:
    """TS intradaySessions: None when no two bars share a New York date (daily or longer bars)."""
    size = len(bars.t)
    offsets: dict[int, float] = {}
    day: list[float] = [0.0] * size
    local: list[float] = [0.0] * size
    gaps: dict[float, int] = {}
    for index in range(size):
        t = bars.t[index]
        shifted = t + _new_york_offset(t, offsets)
        date_ = math.floor(shifted / DAY_MS)
        day[index] = date_
        local[index] = shifted - date_ * DAY_MS
        if index > 0 and date_ == day[index - 1]:
            gap = t - bars.t[index - 1]
            if gap > 0:
                gaps[gap] = gaps.get(gap, 0) + 1
    duration = NAN
    most = 0
    for gap, count in gaps.items():
        if count > most or (count == most and gap < duration):
            duration = gap
            most = count
    if most == 0:
        return None
    open_ms = _minutes_of(intraday["open"]) * MINUTE_MS
    close_limit = _minutes_of(intraday["close"]) * MINUTE_MS
    close_ms = [0.0] * size
    session = [-1] * size
    last = [0] * size
    day_open: list[float] = []
    day_close: list[float] = []
    last_day: float | None = None
    last_index = -1
    for index in range(size):
        close = local[index] + duration
        close_ms[index] = close
        if not (local[index] >= open_ms and close <= close_limit):
            continue
        if day[index] != last_day:
            if last_index >= 0:
                last[last_index] = 1
            last_day = day[index]
            day_open.append(bars.o[index])
            day_close.append(NAN)
        session[index] = len(day_open) - 1
        day_close[-1] = bars.c[index]
        last_index = index
    if last_index >= 0:
        last[last_index] = 1
    return IntradaySessions(
        bars=bars, duration=duration, close_ms=tuple(close_ms), open_ms=open_ms, session=tuple(session),
        last=tuple(last), day_open=tuple(day_open), day_close=tuple(day_close),
    )


def _intraday_gates(sessions: IntradaySessions, intraday: Mapping[str, Any]) -> tuple[list[int], list[int]]:
    """TS intradayGates: (entry, exit) bars of the intraday block."""
    size = len(sessions.session)
    start = _minutes_of(intraday["entryFrom"]) * MINUTE_MS
    end = _minutes_of(intraday["entryTo"]) * MINUTE_MS
    every = intraday.get("decisionEvery")
    grid = None if every is None else every * MINUTE_MS
    entry = [0] * size
    exit_ = [0] * size
    for index in range(size):
        if sessions.session[index] < 0:
            continue
        close = sessions.close_ms[index]
        if grid is not None and math.fmod(close - sessions.open_ms, grid) != 0:
            continue
        exit_[index] = 1
        if start <= close <= end and sessions.last[index] == 0:
            entry[index] = 1
    return entry, exit_


def vwap_series(sessions: IntradaySessions) -> Series:
    """TS vwapSeries: vwap since the first regular bar of each session day (running mean of the
    typical prices while the summed volume is not above 0)."""
    bars = sessions.bars
    out = [NAN] * len(sessions.session)
    current = -1
    priced = volume = typical_sum = 0.0
    count = 0
    for index, day in enumerate(sessions.session):
        if day < 0:
            continue
        if day != current:
            current = day
            priced = volume = typical_sum = 0.0
            count = 0
        typical = (bars.h[index] + bars.l[index] + bars.c[index]) / 3
        traded = 0.0 if bars.v is None else bars.v[index]
        priced += typical * traded
        volume += traded
        typical_sum += typical
        count += 1
        out[index] = priced / volume if volume > 0 else typical_sum / count
    return out


def session_return_series(sessions: IntradaySessions, origin: str, to: str) -> Series:
    """TS sessionReturnSeries: price at `to` / price at `origin` - 1 from the bar closing at `to`."""
    bars = sessions.bars
    timed = origin not in SESSION_ANCHORS
    if timed:
        _align_to_grid("sessionReturn from", origin, _minutes_of(origin), sessions)
    _align_to_grid("sessionReturn to", to, _minutes_of(to), sessions)
    to_ms = _minutes_of(to) * MINUTE_MS
    from_ms = _minutes_of(origin) * MINUTE_MS if timed else NAN
    days = len(sessions.day_open)
    target = [NAN] * days
    anchor = [NAN] * days
    for day in range(days):
        if origin == "open":
            anchor[day] = sessions.day_open[day]
        elif origin == "prevClose" and day > 0:
            anchor[day] = sessions.day_close[day - 1]
    for index, day in enumerate(sessions.session):
        if day < 0:
            continue
        if sessions.close_ms[index] == to_ms:
            target[day] = bars.c[index]
        if sessions.close_ms[index] == from_ms:
            anchor[day] = bars.c[index]
    out = [NAN] * len(sessions.session)
    for index, day in enumerate(sessions.session):
        if day < 0 or sessions.close_ms[index] < to_ms:
            continue
        out[index] = _js_div(target[day], anchor[day]) - 1
    return out


def noise_band_series(sessions: IntradaySessions, band: str, length: int, multiple: float) -> Series:
    """TS noiseBandSeries: sigma = mean |close / session open - 1| at the same slot over the previous
    `length` session days with a bar there; today's move never enters its own sigma."""
    bars = sessions.bars
    moves: dict[float, list[float]] = {}
    out = [NAN] * len(sessions.session)
    for index, day in enumerate(sessions.session):
        if day < 0:
            continue
        history = moves.setdefault(sessions.close_ms[index] - sessions.open_ms, [])
        sigma = NAN
        if len(history) >= length:
            total = 0.0
            for at in range(len(history) - length, len(history)):
                total += history[at]
            sigma = total / length
        open_ = sessions.day_open[day]
        previous = sessions.day_close[day - 1] if day > 0 else NAN
        if band == "upper":
            out[index] = _js_max(open_, previous) * (1 + multiple * sigma)
        else:
            out[index] = _js_min(open_, previous) * (1 - multiple * sigma)
        history.append(abs(_js_div(bars.c[index], open_) - 1))
    return out


def _session_indicator(sessions: IntradaySessions, expr: Mapping[str, Any]) -> Series:
    name = expr["name"]
    if name == "vwap":
        return vwap_series(sessions)
    if name == "sessionReturn":
        return session_return_series(sessions, expr["from"], expr["to"])
    return noise_band_series(sessions, expr["band"], expr["length"], expr.get("multiple", 1.0))


def _session_key(expr: Mapping[str, Any]) -> str:
    """Cache key of a session indicator (TS sessionIndicator)."""
    name = expr["name"]
    if name == "vwap":
        return "vwap"
    if name == "sessionReturn":
        return f"sessionReturn:{expr['from']}:{expr['to']}"
    return f"noiseBand:{expr['band']}:{expr['length']}:{float(expr.get('multiple', 1))}"


def _align_to_grid(field: str, value: str | float, minutes: float, sessions: IntradaySessions) -> None:
    """TS alignToGrid: refuses `minutes` that are not whole bar durations."""
    if math.fmod(minutes * MINUTE_MS, sessions.duration) != 0:
        raise intraday_grid_misaligned(field, value, sessions.duration)


def _attach_sessions(bars: Bars, intraday: Mapping[str, Any]) -> IntradaySessions:
    """TS attachSessions: refuses bars without two bars on one New York date, and open, close,
    entryFrom, entryTo or decisionEvery that are not whole multiples of the bar duration."""
    sessions = intraday_sessions(bars, intraday)
    if sessions is None:
        raise intraday_daily_unsupported()
    for field in ("open", "close", "entryFrom", "entryTo"):
        _align_to_grid(field, intraday[field], _minutes_of(intraday[field]), sessions)
    every = intraday.get("decisionEvery")
    if every is not None:
        _align_to_grid("decisionEvery", every, every, sessions)
    return sessions


def session_indicator_series(bars: Bars, intraday: Mapping[str, Any], expr: Mapping[str, Any]) -> Series:
    """TS sessionIndicatorSeries: one session indicator of the bars under an intraday block."""
    return _session_indicator(_attach_sessions(bars, intraday), _normalize_session_expr(expr))


def vol_target_leverage(
    bars: Bars, sizing: Mapping[str, Any], sessions: IntradaySessions | None = None
) -> Series:
    """TS volTargetLeverage: min(maxLeverage, targetPct / 100 / sigma) of the session days completed
    at each bar (sample standard deviation of the last `length` close-to-close returns)."""
    size = len(bars.c)
    if sessions is not None:
        last = list(sessions.last)
    else:
        offsets: dict[int, float] = {}
        dates = [math.floor((t + _new_york_offset(t, offsets)) / DAY_MS) for t in bars.t]
        last = [1 if index == size - 1 or dates[index + 1] != date_ else 0 for index, date_ in enumerate(dates)]
    length = sizing["length"]
    closes: list[float] = []
    out = [NAN] * size
    leverage = NAN
    for index in range(size):
        if last[index] == 1:
            closes.append(bars.c[index])
            if len(closes) > length:
                returns = [_js_div(closes[at], closes[at - 1]) - 1 for at in range(len(closes) - length, len(closes))]
                total = 0.0
                for value in returns:
                    total += value
                mean = total / length
                squares = 0.0
                for value in returns:
                    squares += (value - mean) * (value - mean)
                sigma = math.sqrt(squares / (length - 1))
                # sigma 0 gives Infinity, so maxLeverage; a NaN close gives NaN (no entry).
                leverage = _js_min(sizing["maxLeverage"], _js_div(sizing["targetPct"] / 100, sigma))
        out[index] = leverage
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
    memoized by their canonical JSON. `frame` builds the series frame on first use; `sessions` is
    the intraday layout the session indicators read."""

    def __init__(
        self,
        bars: Bars,
        frame: Callable[[], _Frame] | None = None,
        sessions: IntradaySessions | None = None,
    ) -> None:
        self.bars = bars
        self.cache: dict[str, Sequence[float]] = {}
        self._days: tuple[Bars, list[int]] | None = None
        self._frame_builder = frame
        self._frame: _Frame | None = None
        self.sessions = sessions

    def _daily_indicator(self, expr: Mapping[str, Any]) -> Series:
        """TS dailyIndicator: highest and lowest read day D, every other indicator day D - 1."""
        if self._days is None:
            self._days = session_daily_bars(self.bars)
        daily_bars, day = self._days
        count = len(daily_bars.c)
        if expr["length"] > count:
            raise InputError(
                f"{expr['name']} length {expr['length']} is longer than the {count} daily bars"
            )
        daily = _Evaluator(daily_bars)._current(
            {"type": "indicator", "name": expr["name"], "length": expr["length"],
             "source": expr["source"], "offset": 0}
        )
        lag = 0 if expr["name"] in ("highest", "lowest") else 1
        return [NAN if at - lag < 0 else daily[at - lag] for at in day]

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
            else f"{_indicator_key(expr)}@{offset}"
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
        if _is_session_indicator(expr):
            if self.sessions is None:
                raise InputError(f"{expr['name']} reads the intraday session; add an intraday block")
            key = _session_key(expr)
            cached = self.cache.get(key)
            if cached is None:
                cached = _session_indicator(self.sessions, expr)
                self.cache[key] = cached
            return cached
        if expr.get("timeframe") is not None:
            key = _indicator_key(expr)
            cached = self.cache.get(key)
            if cached is None:
                cached = self._daily_indicator(expr)
                self.cache[key] = cached
            return cached
        name = expr["name"]
        length = expr["length"]
        if length > size:
            raise InputError(f"{name} length {length} is longer than the {size} bars")
        key = _indicator_key(expr)
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
    if op in ("breaksAbove", "breaksBelow"):
        return _break_series(op, left, right)
    out = [0] * len(left)
    previous = False
    for index in range(len(left)):
        now = _compare(op, left[index], right[index])
        out[index] = 1 if (now and not previous if cross else now) else 0
        previous = now
    return out


def _break_series(op: str, left: Sequence[float], right: Sequence[float]) -> list[int]:
    """TS breakSeries: breaksAbove at i is left[i] > right[i] and left[i - 1] <= right[i] (the
    previous left against the current right); breaksBelow mirrors it. False at bar 0 and on NaN."""
    out = [0] * len(left)
    above = op == "breaksAbove"
    for index in range(1, len(left)):
        now = left[index]
        level = right[index]
        before = left[index - 1]
        fired = (now > level and before <= level) if above else (now < level and before >= level)
        if fired:
            out[index] = 1
    return out


def _once_per_level(fired: list[int], right: Sequence[float]) -> list[int]:
    """TS oncePerLevel: drops a bar where the condition holds when the same right value (exact
    float) already made it hold on an earlier bar. Changes `fired` in place."""
    levels: set[float] = set()
    for index, value in enumerate(fired):
        if value != 1:
            continue
        level = right[index]
        if level in levels:
            fired[index] = 0
        else:
            levels.add(level)
    return fired


def _condition_series(evaluator: _Evaluator, condition: Mapping[str, Any]) -> list[int]:
    """1 where the condition holds on the bars."""
    left = evaluator.evaluate(condition["left"])
    right = evaluator.evaluate(condition["right"])
    fired = _compare_series(condition["op"], left, right)
    return _once_per_level(fired, right) if condition.get("oncePerLevel") else fired


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


def _management(evaluator: _Evaluator, management: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """TS managementOf: the engine form of a management block (trail ATR on the signal bars)."""
    if management is None:
        return None
    out: dict[str, Any] = {}
    if "breakevenR" in management:
        out["breakevenR"] = management["breakevenR"]
    trail = management.get("trail")
    if trail is not None:
        atr = evaluator.evaluate(
            {"type": "indicator", "name": "atr", "length": trail["length"], "source": "close", "offset": 0}
        )
        out["trail"] = {"activateR": trail["activateR"], "multiple": trail["multiple"], "atr": tuple(atr)}
    return out


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
    intraday = normalized["intraday"]
    sessions = None if intraday is None else _attach_sessions(bars, intraday)
    gates = None if sessions is None else _intraday_gates(sessions, intraday)
    evaluator = _Evaluator(bars, lambda: _series_frame(bars, context, symbol, calendar), sessions)
    filters = _filter_masks(evaluator, normalized, sector_quadrants)
    entries = [_condition_series(evaluator, c) for c in normalized["entry"]["all"]] + filters
    exits = [_condition_series(evaluator, c) for c in normalized["exit"]["any"]]
    any_of = [_condition_series(evaluator, c) for c in normalized["entry"].get("any", [])]
    session = normalized["session"]
    signals = [0] * size
    exit_mask = [0] * size
    for index in range(size):
        enter = all(series[index] == 1 for series in entries) and (
            not any_of or any(series[index] == 1 for series in any_of)
        ) and (
            session is None or _in_session(bars.t[index], session)
        ) and (
            gates is None or gates[0][index] == 1
        )
        leave = any(series[index] == 1 for series in exits) and (gates is None or gates[1][index] == 1)
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
        portfolio=None
        if definition.get("portfolio") is None
        else ts_portfolio(definition["portfolio"]),
        management=_management(evaluator, normalized["management"]),
        close_at=None if sessions is None else sessions.last,
        leverage=(tuple(vol_target_leverage(bars, normalized["sizing"], sessions))
                  if normalized["sizing"]["mode"] == "volTarget" else None),
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
            *((part.get("entry") or {}).get("any") or []),
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
    if timeframe is None:
        return None
    daily = timeframe in DAILY_TIMEFRAMES
    if not daily and any(item["type"] == "calendarWindow" for item in filters):
        return calendar_intraday_unsupported()
    if daily and definition.get("intraday") is not None:
        return intraday_daily_unsupported()
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
            max_leverage=sizing.get("maxLeverage") if sizing["mode"] == "riskPct" else None,
            side=definition["side"],
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
    "IntradaySessions",
    "intraday_sessions",
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
    "session_daily_bars",
    "session_indicator_series",
    "noise_band_series",
    "session_return_series",
    "vol_target_leverage",
    "vwap_series",
    "strategy_series_refs",
    "rolling_mean",
    "rolling_zscore",
    "wilder_rsi",
]
