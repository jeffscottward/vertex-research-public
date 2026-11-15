"""Trend Trio indicators in TradingView (Pine Script v6) conventions: SuperTrend, Ultimate MA, AlphaTrend,
Chandelier Exit and Slingshot, with the Pine building blocks they need.

The formulas are re-implemented from their public definitions; no Pine source is copied (licences and
authors are in NOTICE). Sources, checked 2026-11-14:
- SuperTrend: TradingView built-in ``ta.supertrend``,
  <https://www.tradingview.com/pine-script-reference/v6/#fun_ta.supertrend>.
- Ultimate MA: ChrisMoody, CM_Ultimate_MA_MTF_V2 (8 average types),
  <https://www.tradingview.com/script/8KVcQiJM-CM-Ultimate-MA-MTF-V2/>.
- AlphaTrend: KivancOzbilgic, <https://www.tradingview.com/script/o50NYLAZ-AlphaTrend/> (MPL-2.0).
- Chandelier Exit: Chuck LeBeau (StockCharts ChartSchool) in the ratcheting form of everget,
  <https://www.tradingview.com/script/AqXxNS7j-Chandelier-Exit-everget/>, with the highest high and the
  lowest low (everget's "use close" switch off).
- Slingshot: ChrisMoody, CM Sling Shot System (EMA 38 against EMA 62),
  <https://www.tradingview.com/script/GE7tSQK1-CM-Sling-Shot-System/>.
- Building blocks: ``ta.tr``, ``ta.atr``, ``ta.rma``, ``ta.ema``, ``ta.sma``, ``ta.wma``, ``ta.vwma``, ``ta.mfi``,
  ``ta.rsi`` in <https://www.tradingview.com/pine-script-reference/v6/>.

Conventions (shared with packages/shared/src/indicators/trend.ts, operation for operation, so both give the
same IEEE doubles; the reference values are services/research/tests/fixtures/trend-indicator-reference.json):
- Input: lists of finite floats in chronological order. Output: lists of the same length; ``nan`` is Pine's
  ``na`` (undefined).
- Windowed averages (sma, wma) use the last ``length`` values that are not ``nan`` and are ``nan`` at a bar
  whose own input is ``nan`` (Pine: "na values in the source series are ignored").
- ``rma`` and ``ema`` start with the simple mean of the first ``length`` defined values, then recurse.
- ``atr`` uses a true range whose first bar is high - low; AlphaTrend uses the plain ``ta.tr`` (``nan`` on the
  first bar) and its simple mean.
- ``mfi`` skips the first bar (its change is undefined). When the falling flow is 0 it is 100 if the rising
  flow is above 0, else ``nan``; ``rsi`` the same with average gains and losses.
- Directions use +1 for up and -1 for down (Slingshot: 0 when the averages are equal). Pine's own
  ``ta.supertrend`` returns the opposite sign; the script built-in keeps Pine's sign.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Sequence
from typing import Literal

NAN = math.nan
Series = list[float]
MaType = Literal["sma", "ema", "wma", "hull", "vwma", "rma", "tema", "t3"]
MA_TYPES: tuple[MaType, ...] = ("sma", "ema", "wma", "hull", "vwma", "rma", "tema", "t3")
Momentum = Literal["mfi", "rsi"]
MAX_LENGTH = 2_000


def _length(name: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_LENGTH:
        raise ValueError(f"{name} must be an integer from 1 to {MAX_LENGTH}")
    return value


def _positive(name: str, value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive number")
    return float(value)


def _same_length(*series: Sequence[float]) -> int:
    size = len(series[0])
    if any(len(s) != size for s in series):
        raise ValueError("input series must have the same length")
    return size


def sma(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.sma``: mean of the last ``length`` defined values (running sum, oldest value removed)."""
    span = _length("length", length)
    out = [NAN] * len(src)
    window: deque[float] = deque()
    total = 0.0
    for i, x in enumerate(src):
        if math.isnan(x):
            continue
        window.append(x)
        total += x
        if len(window) > span:
            total -= window.popleft()
        if len(window) == span:
            out[i] = total / span
    return out


def wma(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.wma``: weights 1..length over the last ``length`` defined values, the newest heaviest."""
    span = _length("length", length)
    out = [NAN] * len(src)
    window: deque[float] = deque()
    divisor = span * (span + 1) / 2
    for i, x in enumerate(src):
        if math.isnan(x):
            continue
        window.append(x)
        if len(window) > span:
            window.popleft()
        if len(window) == span:
            weighted = 0.0
            for weight, value in enumerate(window, start=1):
                weighted += weight * value
            out[i] = weighted / divisor
    return out


def _recursive(src: Sequence[float], length: int, alpha: float) -> Series:
    seed = sma(src, length)
    out = [NAN] * len(src)
    previous = NAN
    for i, x in enumerate(src):
        if math.isnan(previous):
            out[i] = seed[i]
        else:
            out[i] = alpha * x + (1 - alpha) * previous
        previous = out[i]
    return out


def rma(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.rma`` (Wilder): alpha 1/length, seeded with the simple mean."""
    span = _length("length", length)
    return _recursive(src, span, 1 / span)


def ema(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.ema``: alpha 2/(length + 1), seeded with the simple mean."""
    span = _length("length", length)
    return _recursive(src, span, 2 / (span + 1))


def true_range(high: Sequence[float], low: Sequence[float], close: Sequence[float], handle_na: bool) -> Series:
    """Pine ``ta.tr(handle_na)``: the first bar is high - low when ``handle_na`` is true, else ``nan``."""
    size = _same_length(high, low, close)
    out = [NAN] * size
    for i in range(size):
        if i == 0:
            out[i] = high[i] - low[i] if handle_na else NAN
        else:
            previous = close[i - 1]
            out[i] = max(high[i] - low[i], abs(high[i] - previous), abs(low[i] - previous))
    return out


def atr(high: Sequence[float], low: Sequence[float], close: Sequence[float], length: int) -> Series:
    """Pine ``ta.atr``: rma of the true range whose first bar is high - low."""
    return rma(true_range(high, low, close, True), length)


def highest(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.highest``: highest of the last ``length`` values (``nan`` before ``length`` bars)."""
    span = _length("length", length)
    out = [NAN] * len(src)
    keep: deque[int] = deque()
    for i, x in enumerate(src):
        while keep and src[keep[-1]] <= x:
            keep.pop()
        keep.append(i)
        if keep[0] <= i - span:
            keep.popleft()
        if i >= span - 1:
            out[i] = src[keep[0]]
    return out


def lowest(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.lowest``: lowest of the last ``length`` values (``nan`` before ``length`` bars)."""
    span = _length("length", length)
    out = [NAN] * len(src)
    keep: deque[int] = deque()
    for i, x in enumerate(src):
        while keep and src[keep[-1]] >= x:
            keep.pop()
        keep.append(i)
        if keep[0] <= i - span:
            keep.popleft()
        if i >= span - 1:
            out[i] = src[keep[0]]
    return out


def _oscillator(up: float, down: float) -> float:
    if down == 0:
        return 100.0 if up > 0 else NAN
    return 100.0 - 100.0 / (1.0 + up / down)


def mfi(src: Sequence[float], volume: Sequence[float], length: int) -> Series:
    """Pine ``ta.mfi``: rising flow sums volume x src on bars where src rose, falling flow where it fell."""
    size = _same_length(src, volume)
    up = [NAN] * size
    down = [NAN] * size
    for i in range(1, size):
        change = src[i] - src[i - 1]
        up[i] = 0.0 if change <= 0 else volume[i] * src[i]
        down[i] = 0.0 if change >= 0 else volume[i] * src[i]
    span = _length("length", length)
    sum_up, sum_down = sma(up, span), sma(down, span)
    out = [NAN] * size
    for i in range(size):
        if not math.isnan(sum_up[i]):
            out[i] = _oscillator(sum_up[i] * span, sum_down[i] * span)
    return out


def rsi(src: Sequence[float], length: int) -> Series:
    """Pine ``ta.rsi``: Wilder averages of gains and losses from the second bar."""
    size = len(src)
    gains = [NAN] * size
    losses = [NAN] * size
    for i in range(1, size):
        gains[i] = max(src[i] - src[i - 1], 0.0)
        losses[i] = max(src[i - 1] - src[i], 0.0)
    avg_up, avg_down = rma(gains, length), rma(losses, length)
    return [NAN if math.isnan(u) else _oscillator(u, d) for u, d in zip(avg_up, avg_down, strict=True)]


def _nz(x: float, fallback: float = 0.0) -> float:
    return fallback if math.isnan(x) else x


def supertrend(high: Sequence[float], low: Sequence[float], close: Sequence[float], length: int = 10,
               factor: float = 3.0) -> tuple[Series, Series]:
    """Pine ``ta.supertrend(factor, length)``: (line, direction +1 up / -1 down), ``nan`` while the ATR is."""
    size = _same_length(high, low, close)
    mult = _positive("factor", factor)
    atr_s = atr(high, low, close, length)
    line = [NAN] * size
    direction = [NAN] * size
    prev_lower = prev_upper = prev_line = NAN
    for i in range(size):
        a = atr_s[i]
        mid = (high[i] + low[i]) / 2
        upper = mid + mult * a
        lower = mid - mult * a
        p_lower, p_upper = _nz(prev_lower), _nz(prev_upper)
        close_prev = close[i - 1] if i > 0 else NAN
        if not (lower > p_lower or close_prev < p_lower):
            lower = p_lower
        if not (upper < p_upper or close_prev > p_upper):
            upper = p_upper
        if i == 0 or math.isnan(atr_s[i - 1]):
            up = False
        elif prev_line == p_upper:
            up = close[i] > upper
        else:
            up = not close[i] < lower
        value = lower if up else upper
        if not math.isnan(a):
            line[i] = value
            direction[i] = 1.0 if up else -1.0
        prev_lower, prev_upper, prev_line = lower, upper, value
    return line, direction


def _hull(src: Sequence[float], length: int) -> Series:
    half, full = wma(src, max(length // 2, 1)), wma(src, length)
    inner = [2 * h - f for h, f in zip(half, full, strict=True)]
    return wma(inner, max(round(math.sqrt(length)), 1))


def _tilson(src: Sequence[float], length: int, factor: float) -> Series:
    e1 = ema(src, length)
    e2 = ema(e1, length)
    return [x * (1 + factor) - y * factor for x, y in zip(e1, e2, strict=True)]


def moving_average(close: Sequence[float], volume: Sequence[float] | None, ma_type: MaType, length: int,
                   t3_factor: float = 0.7) -> Series:
    """The eight averages of CM_Ultimate_MA_MTF_V2: 1 sma, 2 ema, 3 wma, 4 hull, 5 vwma, 6 rma, 7 tema, 8 t3."""
    span = _length("length", length)
    if ma_type == "sma":
        return sma(close, span)
    if ma_type == "ema":
        return ema(close, span)
    if ma_type == "wma":
        return wma(close, span)
    if ma_type == "hull":
        return _hull(close, span)
    if ma_type == "vwma":
        if volume is None:
            raise ValueError("vwma needs volume")
        _same_length(close, volume)
        weighted = sma([x * v for x, v in zip(close, volume, strict=True)], span)
        base = sma(volume, span)
        return [w / b if b != 0 else NAN for w, b in zip(weighted, base, strict=True)]
    if ma_type == "rma":
        return rma(close, span)
    if ma_type == "tema":
        e1 = ema(close, span)
        e2 = ema(e1, span)
        e3 = ema(e2, span)
        return [3 * (x - y) + z for x, y, z in zip(e1, e2, e3, strict=True)]
    if ma_type == "t3":
        factor = _positive("t3_factor", t3_factor)
        return _tilson(_tilson(_tilson(close, span, factor), span, factor), span, factor)
    raise ValueError(f"ma_type must be one of {', '.join(MA_TYPES)}")


def ultimate_ma(close: Sequence[float], volume: Sequence[float] | None = None, ma_type: MaType = "sma",
                length: int = 20, smoothing: int = 2, t3_factor: float = 0.7) -> tuple[Series, Series]:
    """Ultimate MA: (value, direction); +1 when the value is >= its value ``smoothing`` bars ago, else -1."""
    lag = _length("smoothing", smoothing)
    value = moving_average(close, volume, ma_type, length, t3_factor)
    direction = [NAN] * len(value)
    for i in range(lag, len(value)):
        if not (math.isnan(value[i]) or math.isnan(value[i - lag])):
            direction[i] = 1.0 if value[i] >= value[i - lag] else -1.0
    return value, direction


def alphatrend(high: Sequence[float], low: Sequence[float], close: Sequence[float],
               volume: Sequence[float] | None = None, length: int = 14, coeff: float = 1.0,
               momentum: Momentum = "mfi") -> tuple[Series, Series]:
    """AlphaTrend (line, direction). Momentum ``mfi`` (MFI of hlc3, needs volume) or ``rsi`` (RSI of close),
    bullish at >= 50. Direction: +1 when the line is above its value 2 bars ago, -1 below, else +1 when the
    line 1 bar ago is above its value 3 bars ago, else -1 (``nan`` until 4 defined values)."""
    size = _same_length(high, low, close)
    span = _length("length", length)
    mult = _positive("coeff", coeff)
    if momentum == "mfi":
        if volume is None:
            raise ValueError("AlphaTrend momentum mfi needs volume; use momentum rsi")
        _same_length(close, volume)
        hlc3 = [(h + lo + c) / 3 for h, lo, c in zip(high, low, close, strict=True)]
        mom = mfi(hlc3, volume, span)
    elif momentum == "rsi":
        mom = rsi(close, span)
    else:
        raise ValueError("momentum must be mfi or rsi")
    band = sma(true_range(high, low, close, False), span)
    line = [NAN] * size
    previous = NAN
    for i in range(size):
        prev = _nz(previous)
        if mom[i] >= 50:
            up_t = low[i] - band[i] * mult
            value = prev if up_t < prev else up_t
        else:
            down_t = high[i] + band[i] * mult
            value = prev if down_t > prev else down_t
        line[i] = value
        previous = value
    direction = [NAN] * size
    for i in range(3, size):
        a0, a1, a2, a3 = line[i], line[i - 1], line[i - 2], line[i - 3]
        if math.isnan(a0) or math.isnan(a1) or math.isnan(a2) or math.isnan(a3):
            continue
        if a0 > a2:
            direction[i] = 1.0
        elif a0 < a2:
            direction[i] = -1.0
        else:
            direction[i] = 1.0 if a1 > a3 else -1.0
    return line, direction


def chandelier_exit(high: Sequence[float], low: Sequence[float], close: Sequence[float], length: int = 22,
                    multiple: float = 3.0) -> tuple[Series, Series, Series]:
    """Chandelier Exit (long stop, short stop, direction). Long stop = highest high - multiple x ATR, raised
    while the previous close stays above the previous long stop; short stop mirrors it; direction starts +1,
    turns +1 when the close is above the previous short stop and -1 when it is below the previous long stop."""
    size = _same_length(high, low, close)
    mult = _positive("multiple", multiple)
    atr_s = atr(high, low, close, length)
    top, bottom = highest(high, length), lowest(low, length)
    long_stop = [NAN] * size
    short_stop = [NAN] * size
    direction = [NAN] * size
    state = 1.0
    for i in range(size):
        band = mult * atr_s[i]
        long_now = top[i] - band
        short_now = bottom[i] + band
        long_prev = _nz(long_stop[i - 1], long_now) if i > 0 else long_now
        short_prev = _nz(short_stop[i - 1], short_now) if i > 0 else short_now
        close_prev = close[i - 1] if i > 0 else NAN
        if close_prev > long_prev:
            long_now = max(long_now, long_prev)
        if close_prev < short_prev:
            short_now = min(short_now, short_prev)
        long_stop[i] = long_now
        short_stop[i] = short_now
        if close[i] > short_prev:
            state = 1.0
        elif close[i] < long_prev:
            state = -1.0
        if not math.isnan(long_now):
            direction[i] = state
    return long_stop, short_stop, direction


def slingshot(close: Sequence[float], fast: int = 38, slow: int = 62) -> tuple[Series, Series, Series]:
    """Slingshot (fast EMA, slow EMA, direction +1 / -1 / 0 when equal)."""
    quick, steady = ema(close, fast), ema(close, slow)
    direction = [NAN] * len(close)
    for i, (q, s) in enumerate(zip(quick, steady, strict=True)):
        if not (math.isnan(q) or math.isnan(s)):
            direction[i] = 1.0 if q > s else (-1.0 if q < s else 0.0)
    return quick, steady, direction
