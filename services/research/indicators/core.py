"""Pure-Python indicator kernels.

Conventions (all outputs are aligned to the input; ``None`` is warmup or undefined):

* EMA, MACD, Bollinger Bands, LWMA, RSI, ATR, Parabolic SAR, Stochastic and ADX
  follow TA-Lib's default conventions (``TA_COMPATIBILITY_DEFAULT``, no unstable
  period). The parity test compares them with TA-Lib C 0.8.1 output.
* Documented differences from TA-Lib:
  - Earlier first values. The MACD line starts at bar ``slow-1`` and Stochastic
    %K at bar ``k_period+k_smoothing-2``; TA-Lib starts every output of these
    functions where the last one (signal, %D) starts. Values on shared bars are equal.
  - Flat input. RSI is 50 when a window has neither gains nor losses (TA-Lib
    returns 0). Stochastic raw %K is 50 when the high-low range is zero (TA-Lib
    returns 0). ADX treats DX as 0 when +DI and -DI are both 0 (TA-Lib keeps the
    previous ADX).
* SMMA (Wilder smoothing, also called RMA), the rolling candle VWAP and relative
  volume at time are not TA-Lib functions; their tests use hand-computed values.
* Rolling z-score and realized volatility follow the gs-quant 2.2.4 conventions
  of ``gs_quant.timeseries.zscores`` and ``gs_quant.timeseries.volatility`` (sample
  standard deviation, ddof 1; volatility of simple returns, annualized, in
  percent). The optional gs-quant suite compares them with gs-quant output.
* Input is plain finite numbers in chronological order. Input is never sorted.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections import deque
from collections.abc import Hashable, Sequence
from dataclasses import dataclass
from numbers import Real
from typing import Literal

MAX_ROWS = 200_000
MAX_PERIOD = 2_000

Series = list[float | None]


@dataclass(frozen=True, slots=True)
class BollingerResult:
    middle: Series
    upper: Series
    lower: Series


@dataclass(frozen=True, slots=True)
class MacdResult:
    macd: Series
    signal: Series
    histogram: Series


@dataclass(frozen=True, slots=True)
class StochasticResult:
    k: Series
    d: Series


@dataclass(frozen=True, slots=True)
class AdxResult:
    plus_di: Series
    minus_di: Series
    adx: Series


def _values(name: str, values: Sequence[float]) -> list[float]:
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence):
        raise TypeError(f"{name} must be a sequence of numbers")
    if len(values) > MAX_ROWS:
        raise ValueError(f"{name} has more than {MAX_ROWS} rows")
    result: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, Real):
            raise TypeError(f"{name} must contain only real numbers")
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"{name} must contain only finite numbers")
        result.append(number)
    return result


def _period(name: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    if not 1 <= value <= MAX_PERIOD:
        raise ValueError(f"{name} must be 1..{MAX_PERIOD}")
    return value


def _positive(name: str, value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{name} must be a real number")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return number


def _bars(
    high: Sequence[float], low: Sequence[float], close: Sequence[float] | None = None
) -> tuple[list[float], list[float], list[float]]:
    highs = _values("high", high)
    lows = _values("low", low)
    closes = _values("close", close) if close is not None else list(highs)
    if not len(highs) == len(lows) == len(closes):
        raise ValueError("high, low and close must have the same length")
    for index, (bar_high, bar_low) in enumerate(zip(highs, lows, strict=True)):
        if bar_low > bar_high:
            raise ValueError(f"bar {index} has low above high")
        if close is not None and not bar_low <= closes[index] <= bar_high:
            raise ValueError(f"bar {index} has close outside its high-low range")
    return highs, lows, closes


def _empty(length: int) -> Series:
    return [None] * length


def _seeded_ema(values: Sequence[float | None], period: int, seed_index: int, alpha: float) -> Series:
    """EMA seeded at ``seed_index`` with the SMA of the ``period`` values ending there."""
    out = _empty(len(values))
    if seed_index >= len(values) or seed_index - period + 1 < 0:
        return out
    window = values[seed_index - period + 1 : seed_index + 1]
    if any(value is None for value in window):
        raise ValueError("EMA seed window contains undefined values")
    previous = math.fsum(value for value in window if value is not None) / period
    out[seed_index] = previous
    for index in range(seed_index + 1, len(values)):
        value = values[index]
        if value is None:
            raise ValueError("EMA input contains undefined values after its seed")
        previous = previous + alpha * (value - previous)
        out[index] = previous
    return out


def _rolling_mean(values: Sequence[float | None], period: int, first: int) -> Series:
    """Trailing mean of ``period`` values; ``first`` is the first index with a full defined window."""
    out = _empty(len(values))
    if first >= len(values):
        return out
    window = values[first - period + 1 : first + 1]
    total = math.fsum(value for value in window if value is not None)
    out[first] = total / period
    for index in range(first + 1, len(values)):
        incoming = values[index]
        outgoing = values[index - period]
        if incoming is None or outgoing is None:
            raise ValueError("rolling mean input contains undefined values")
        total += incoming - outgoing
        out[index] = total / period
    return out


def sma(values: Sequence[float], period: int) -> Series:
    """Simple moving average of the trailing ``period`` values (TA-Lib SMA)."""
    data = _values("values", values)
    span = _period("period", period)
    return _rolling_mean(data, span, span - 1)


def ema(values: Sequence[float], period: int) -> Series:
    """EMA with alpha 2/(period+1), seeded by the first full-period SMA (TA-Lib EMA)."""
    data = _values("values", values)
    span = _period("period", period)
    return _seeded_ema(data, span, span - 1, 2.0 / (span + 1))


def smma(values: Sequence[float], period: int) -> Series:
    """Smoothed (Wilder) moving average: SMA seed, then (previous*(period-1)+value)/period."""
    data = _values("values", values)
    span = _period("period", period)
    return _seeded_ema(data, span, span - 1, 1.0 / span)


def lwma(values: Sequence[float], period: int) -> Series:
    """Linearly weighted moving average, weights 1..period with the newest bar heaviest (TA-Lib WMA)."""
    data = _values("values", values)
    span = _period("period", period)
    out = _empty(len(data))
    if len(data) < span:
        return out
    divisor = span * (span + 1) / 2
    window_sum = math.fsum(data[:span])
    weighted = math.fsum(weight * value for weight, value in enumerate(data[:span], start=1))
    out[span - 1] = weighted / divisor
    for index in range(span, len(data)):
        weighted += span * data[index] - window_sum
        window_sum += data[index] - data[index - span]
        out[index] = weighted / divisor
    return out


def rsi(values: Sequence[float], period: int = 14) -> Series:
    """Wilder RSI of closing prices (TA-Lib RSI). A flat window returns 50."""
    data = _values("values", values)
    span = _period("period", period)
    out = _empty(len(data))
    if len(data) <= span:
        return out
    gains = losses = 0.0
    for index in range(1, len(data)):
        delta = data[index] - data[index - 1]
        gain = delta if delta > 0 else 0.0
        loss = -delta if delta < 0 else 0.0
        if index <= span:
            gains += gain / span
            losses += loss / span
        else:
            gains = (gains * (span - 1) + gain) / span
            losses = (losses * (span - 1) + loss) / span
        if index >= span:
            total = gains + losses
            out[index] = 50.0 if total == 0 else 100.0 * gains / total
    return out


def rolling_vwap(
    high: Sequence[float],
    low: Sequence[float],
    close: Sequence[float],
    volume: Sequence[float],
    period: int,
) -> Series:
    """Trailing volume-weighted typical price ((high+low+close)/3) over ``period`` candles.

    This is a candle approximation, not tick VWAP or session-cumulative VWAP.
    A window with zero total volume returns ``None`` (a gap, not zero).
    """
    highs, lows, closes = _bars(high, low, close)
    volumes = _values("volume", volume)
    if len(volumes) != len(closes):
        raise ValueError("volume must have the same length as the bars")
    if any(value < 0 for value in volumes):
        raise ValueError("volume must not be negative")
    span = _period("period", period)
    out = _empty(len(closes))
    weights = [(h + l + c) / 3.0 * v for h, l, c, v in zip(highs, lows, closes, volumes, strict=True)]
    total_volume = weighted = 0.0
    traded = 0  # bars with positive volume in the window; exact, unlike the float sum
    for index, (volume_value, weight) in enumerate(zip(volumes, weights, strict=True)):
        total_volume += volume_value
        weighted += weight
        traded += volume_value > 0
        if index >= span:
            total_volume -= volumes[index - span]
            weighted -= weights[index - span]
            traded -= volumes[index - span] > 0
        if index >= span - 1 and traded > 0:
            out[index] = weighted / total_volume
    return out


def _true_range(highs: list[float], lows: list[float], closes: list[float]) -> Series:
    out = _empty(len(closes))
    for index in range(1, len(closes)):
        previous = closes[index - 1]
        out[index] = max(highs[index] - lows[index], abs(highs[index] - previous), abs(lows[index] - previous))
    return out


def true_range(high: Sequence[float], low: Sequence[float], close: Sequence[float]) -> Series:
    """True range from the second bar on (TA-Lib TRANGE); the first bar has no previous close."""
    return _true_range(*_bars(high, low, close))


def atr(
    high: Sequence[float],
    low: Sequence[float],
    close: Sequence[float],
    period: int = 14,
    method: Literal["wilder", "sma"] = "wilder",
) -> Series:
    """Average true range. ``wilder`` matches TA-Lib ATR; ``sma`` is the plain mean of true range.

    Both start at bar ``period`` with the mean of true range over bars 1..period.
    """
    ranges = _true_range(*_bars(high, low, close))
    span = _period("period", period)
    if method == "sma":
        return _rolling_mean(ranges, span, span)
    if method == "wilder":
        return _seeded_ema(ranges, span, span, 1.0 / span)
    raise ValueError("method must be 'wilder' or 'sma'")


def bollinger_bands(values: Sequence[float], period: int = 20, deviations: float = 2.0) -> BollingerResult:
    """SMA middle band +/- ``deviations`` population standard deviations (TA-Lib BBANDS, SMA type)."""
    data = _values("values", values)
    span = _period("period", period)
    width = _positive("deviations", deviations)
    middle = _empty(len(data))
    upper = _empty(len(data))
    lower = _empty(len(data))
    if len(data) < span:
        return BollingerResult(middle=middle, upper=upper, lower=lower)
    # Sliding-window Welford update: O(rows), numerically stable for price data.
    mean = math.fsum(data[:span]) / span
    squares = math.fsum((value - mean) ** 2 for value in data[:span])
    for index in range(span - 1, len(data)):
        if index >= span:
            incoming, outgoing = data[index], data[index - span]
            previous_mean = mean
            mean += (incoming - outgoing) / span
            squares = max(0.0, squares + (incoming - outgoing) * (incoming - mean + outgoing - previous_mean))
        deviation = math.sqrt(squares / span)
        middle[index] = mean
        upper[index] = mean + width * deviation
        lower[index] = mean - width * deviation
    return BollingerResult(middle=middle, upper=upper, lower=lower)


def parabolic_sar(
    high: Sequence[float], low: Sequence[float], acceleration: float = 0.02, maximum: float = 0.2
) -> Series:
    """Wilder Parabolic SAR (TA-Lib SAR). The first bar is warmup.

    The initial trend is short only when bar 1 has a positive minus directional
    movement larger than its plus movement; otherwise it is long.
    """
    highs, lows, _ = _bars(high, low)
    step = _positive("acceleration", acceleration)
    limit = _positive("maximum", maximum)
    if step > limit:
        raise ValueError("acceleration must not exceed maximum")
    out = _empty(len(highs))
    if len(highs) < 2:
        return out
    up_move = highs[1] - highs[0]
    down_move = lows[0] - lows[1]
    is_long = not (down_move > 0 and down_move > up_move)
    if is_long:
        extreme, sar = highs[1], lows[0]
    else:
        extreme, sar = lows[1], highs[0]
    factor = step
    new_high, new_low = highs[1], lows[1]
    for index in range(1, len(highs)):
        previous_high, previous_low = new_high, new_low
        new_high, new_low = highs[index], lows[index]
        if is_long:
            if new_low <= sar:
                is_long = False
                sar = max(extreme, previous_high, new_high)
                out[index] = sar
                factor = step
                extreme = new_low
                sar = max(sar + factor * (extreme - sar), previous_high, new_high)
            else:
                out[index] = sar
                if new_high > extreme:
                    extreme = new_high
                    factor = min(factor + step, limit)
                sar = min(sar + factor * (extreme - sar), previous_low, new_low)
        elif new_high >= sar:
            is_long = True
            sar = min(extreme, previous_low, new_low)
            out[index] = sar
            factor = step
            extreme = new_high
            sar = min(sar + factor * (extreme - sar), previous_low, new_low)
        else:
            out[index] = sar
            if new_low < extreme:
                extreme = new_low
                factor = min(factor + step, limit)
            sar = max(sar + factor * (extreme - sar), previous_high, new_high)
    return out


def macd(values: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9) -> MacdResult:
    """MACD line, signal line and histogram (TA-Lib MACD).

    Both EMAs are seeded at bar ``slow-1`` with the SMA of their own period ending
    there, so the MACD line starts at bar ``slow-1``. The signal EMA is seeded with
    the SMA of the first ``signal`` MACD values. TA-Lib omits the MACD line before
    the signal starts; this function keeps it.
    """
    data = _values("values", values)
    fast_span = _period("fast", fast)
    slow_span = _period("slow", slow)
    signal_span = _period("signal", signal)
    if fast_span >= slow_span:
        raise ValueError("fast must be shorter than slow")
    start = slow_span - 1
    fast_line = _seeded_ema(data, fast_span, start, 2.0 / (fast_span + 1))
    slow_line = _seeded_ema(data, slow_span, start, 2.0 / (slow_span + 1))
    line: Series = [
        None if quick is None or steady is None else quick - steady
        for quick, steady in zip(fast_line, slow_line, strict=True)
    ]
    signal_line = _seeded_ema(line, signal_span, start + signal_span - 1, 2.0 / (signal_span + 1))
    histogram: Series = [
        None if value is None or trigger is None else value - trigger
        for value, trigger in zip(line, signal_line, strict=True)
    ]
    return MacdResult(macd=line, signal=signal_line, histogram=histogram)


def stochastic(
    high: Sequence[float],
    low: Sequence[float],
    close: Sequence[float],
    k_period: int = 14,
    k_smoothing: int = 3,
    d_period: int = 3,
) -> StochasticResult:
    """Slow stochastic (TA-Lib STOCH with SMA smoothing). ``k_smoothing=1`` gives fast %K.

    Raw %K = 100*(close - lowest low)/(highest high - lowest low) over ``k_period``;
    %K is its SMA over ``k_smoothing``; %D is the SMA of %K over ``d_period``.
    A zero high-low range gives a raw %K of 50. %K starts at bar
    ``k_period+k_smoothing-2``; TA-Lib hides it until %D starts.
    """
    highs, lows, closes = _bars(high, low, close)
    k_span = _period("k_period", k_period)
    smooth_span = _period("k_smoothing", k_smoothing)
    d_span = _period("d_period", d_period)
    raw = _empty(len(closes))
    # Monotonic deques of bar indexes give the window high and low in O(rows).
    high_window: deque[int] = deque()
    low_window: deque[int] = deque()
    for index in range(len(closes)):
        while high_window and highs[high_window[-1]] <= highs[index]:
            high_window.pop()
        high_window.append(index)
        while low_window and lows[low_window[-1]] >= lows[index]:
            low_window.pop()
        low_window.append(index)
        if high_window[0] <= index - k_span:
            high_window.popleft()
        if low_window[0] <= index - k_span:
            low_window.popleft()
        if index < k_span - 1:
            continue
        highest = highs[high_window[0]]
        lowest = lows[low_window[0]]
        spread = highest - lowest
        raw[index] = 50.0 if spread == 0 else 100.0 * (closes[index] - lowest) / spread
    k_first = k_span + smooth_span - 2
    k_line = _rolling_mean(raw, smooth_span, k_first)
    d_line = _rolling_mean(k_line, d_span, k_first + d_span - 1)
    return StochasticResult(k=k_line, d=d_line)


def adx(high: Sequence[float], low: Sequence[float], close: Sequence[float], period: int = 14) -> AdxResult:
    """Wilder +DI, -DI and ADX (TA-Lib PLUS_DI, MINUS_DI and ADX).

    Directional movement and true range start at bar 1. The smoothed sums are
    seeded with the sum of bars 1..period-1 and then updated with
    ``sum - sum/period + value`` from bar ``period``, so +DI and -DI start at bar
    ``period``. ADX is the mean of DX over bars period..2*period-1, then Wilder
    smoothing; its first value is at bar ``2*period-1``.
    """
    highs, lows, closes = _bars(high, low, close)
    span = _period("period", period)
    length = len(closes)
    plus_di = _empty(length)
    minus_di = _empty(length)
    adx_line = _empty(length)
    plus_sum = minus_sum = range_sum = 0.0
    dx_total = 0.0
    average: float | None = None
    for index in range(1, length):
        up_move = highs[index] - highs[index - 1]
        down_move = lows[index - 1] - lows[index]
        plus_move = up_move if up_move > 0 and up_move > down_move else 0.0
        minus_move = down_move if down_move > 0 and down_move > up_move else 0.0
        previous_close = closes[index - 1]
        bar_range = max(
            highs[index] - lows[index], abs(highs[index] - previous_close), abs(lows[index] - previous_close)
        )
        if index < span:
            plus_sum += plus_move
            minus_sum += minus_move
            range_sum += bar_range
            continue
        plus_sum = plus_sum - plus_sum / span + plus_move
        minus_sum = minus_sum - minus_sum / span + minus_move
        range_sum = range_sum - range_sum / span + bar_range
        plus = 0.0 if range_sum == 0 else 100.0 * plus_sum / range_sum
        minus = 0.0 if range_sum == 0 else 100.0 * minus_sum / range_sum
        plus_di[index] = plus
        minus_di[index] = minus
        total = plus + minus
        dx = 0.0 if total == 0 else 100.0 * abs(plus - minus) / total
        if index < 2 * span - 1:
            dx_total += dx
        elif average is None:
            average = (dx_total + dx) / span
            adx_line[index] = average
        else:
            average = (average * (span - 1) + dx) / span
            adx_line[index] = average
    return AdxResult(plus_di=plus_di, minus_di=minus_di, adx=adx_line)


def rvol_at_time(
    sessions: Sequence[Hashable],
    slots: Sequence[int],
    volume: Sequence[float],
    lookback: int = 20,
) -> Series:
    """Relative volume at time: volume so far in the session against earlier sessions at the same time.

    ``sessions`` holds one session key per bar (for example the exchange date) and
    ``slots`` the time of day of each bar as an integer (for example minutes since
    midnight in the exchange time zone). Bars of one session must be contiguous and
    their slots must increase.

    For bar ``i`` the value is ``cum(i) / mean(cum_as_of(P, slot(i)))`` over the
    ``lookback`` sessions ``P`` immediately before the session of bar ``i``.
    ``cum(i)`` is the session volume up to and including bar ``i``.
    ``cum_as_of(P, s)`` is the volume of session ``P`` through its last bar with a
    slot at or before ``s`` (0 when there is no such bar). The value is ``None``
    while fewer than ``lookback`` earlier sessions exist or when the mean is 0.
    With one bar per session this is volume divided by the mean volume of the
    previous ``lookback`` bars.
    """
    if isinstance(sessions, (str, bytes)) or not isinstance(sessions, Sequence):
        raise TypeError("sessions must be a sequence of session keys")
    if isinstance(slots, (str, bytes)) or not isinstance(slots, Sequence):
        raise TypeError("slots must be a sequence of integers")
    volumes = _values("volume", volume)
    if not len(sessions) == len(slots) == len(volumes):
        raise ValueError("sessions, slots and volume must have the same length")
    if any(value < 0 for value in volumes):
        raise ValueError("volume must not be negative")
    span = _period("lookback", lookback)
    out = _empty(len(volumes))
    history: list[tuple[list[int], list[float]]] = []
    seen: set[Hashable] = set()
    current_slots: list[int] = []
    current_cums: list[float] = []
    current_key: Hashable = None
    cumulative = 0.0
    for index, (key, slot, bar_volume) in enumerate(zip(sessions, slots, volumes, strict=True)):
        if isinstance(slot, bool) or not isinstance(slot, int):
            raise TypeError("slots must contain only integers")
        if index == 0 or key != current_key:
            if key in seen:
                raise ValueError(f"bar {index} starts session {key!r} again; sessions must be contiguous")
            seen.add(key)
            if index > 0:
                history.append((current_slots, current_cums))
            current_key, current_slots, current_cums, cumulative = key, [], [], 0.0
        elif slot <= current_slots[-1]:
            raise ValueError(f"bar {index} has a slot that does not increase within its session")
        cumulative += bar_volume
        current_slots.append(slot)
        current_cums.append(cumulative)
        if len(history) < span:
            continue
        reference = math.fsum(
            past_cums[position - 1] if (position := bisect_right(past_slots, slot)) else 0.0
            for past_slots, past_cums in history[-span:]
        )
        if reference > 0:
            out[index] = cumulative / (reference / span)
    return out


# Relative spread under which a window counts as flat (sample deviation treated as 0).
_FLAT_WINDOW = 1e-12


def _rolling_sample_moments(data: list[float], span: int) -> list[tuple[float, float] | None]:
    """(mean, sample standard deviation) of each full trailing window; None before the first one."""
    out: list[tuple[float, float] | None] = [None] * len(data)
    if len(data) < span:
        return out
    # Sliding-window Welford update, as in bollinger_bands, recomputed exactly once every
    # ``span`` bars so rounding drift cannot build up (z-scores divide by a small deviation): O(rows).
    mean = squares = 0.0
    for index in range(span - 1, len(data)):
        if (index - span + 1) % span == 0:
            window = data[index - span + 1 : index + 1]
            mean = math.fsum(window) / span
            squares = math.fsum((value - mean) ** 2 for value in window)
        else:
            incoming, outgoing = data[index], data[index - span]
            previous_mean = mean
            mean += (incoming - outgoing) / span
            squares = max(0.0, squares + (incoming - outgoing) * (incoming - mean + outgoing - previous_mean))
        deviation = math.sqrt(squares / (span - 1))
        if deviation <= _FLAT_WINDOW * max(1.0, abs(mean)):
            deviation = 0.0
        out[index] = (mean, deviation)
    return out


def _window_period(name: str, value: int) -> int:
    span = _period(name, value)
    if span < 2:
        raise ValueError(f"{name} must be 2..{MAX_PERIOD}; a sample deviation needs two values")
    return span


def zscore(values: Sequence[float], period: int = 20) -> Series:
    """Rolling z-score of each value against its trailing ``period`` window (gs-quant ``zscores``).

    z(i) = (x(i) - mean) / sample standard deviation (ddof 1) of the ``period``
    values ending at bar i, the bar itself included. The first value is at bar
    ``period - 1``. A flat window has no defined z-score and gives ``None``
    (gs-quant gives NaN).
    """
    data = _values("values", values)
    span = _window_period("period", period)
    out = _empty(len(data))
    for index, moments in enumerate(_rolling_sample_moments(data, span)):
        if moments is not None and moments[1] > 0:
            out[index] = (data[index] - moments[0]) / moments[1]
    return out


def realized_volatility(values: Sequence[float], period: int = 20, periods_per_year: int = 252) -> Series:
    """Annualized realized volatility in percent (gs-quant ``volatility`` with simple returns).

    vol(i) = 100 * sqrt(periods_per_year) * sample standard deviation (ddof 1) of
    the ``period`` simple returns ending at bar i. The first value is at bar
    ``period`` (``period`` returns need ``period + 1`` prices). Prices must be
    positive. gs-quant infers the annualization factor from the dates (252 for
    daily data); here it is explicit. A flat window gives 0.
    """
    data = _values("values", values)
    span = _window_period("period", period)
    if isinstance(periods_per_year, bool) or not isinstance(periods_per_year, int) or not 1 <= periods_per_year <= 100_000:
        raise ValueError("periods_per_year must be an integer 1..100000")
    if any(value <= 0 for value in data):
        raise ValueError("values must be positive prices")
    out = _empty(len(data))
    if len(data) <= span:
        return out
    simple = [data[index] / data[index - 1] - 1.0 for index in range(1, len(data))]
    scale = 100.0 * math.sqrt(periods_per_year)
    for index, moments in enumerate(_rolling_sample_moments(simple, span), start=1):
        if moments is not None:
            out[index] = scale * moments[1]
    return out
