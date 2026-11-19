"""Regenerate trend-indicator-reference.json: reference values of the five Trend Trio indicators.

Not a test and not a runtime dependency. Run it with any Python 3.12 (standard library only):

    python3 services/research/tests/fixtures/make_trend_reference.py
    bunx --bun --no-install biome format --write services/research/tests/fixtures/trend-indicator-reference.json

This is a deliberately plain, literal bar-by-bar transcription of the published TradingView (Pine) formulas,
written separately from services/research/indicators/trend.py and packages/shared/src/indicators/trend.ts so
that it checks them. `None` stands for Pine's `na`; a comparison with `na` is false; `nz(x)` is 0 for `na`.
Built-ins follow the Pine reference manual: na values in a window are skipped and a window needs `length`
values that are not na. Sources (formulas only, no Pine code copied; checked 2026-11-14):
- SuperTrend: https://www.tradingview.com/pine-script-reference/v6/#fun_ta.supertrend
- Ultimate MA: ChrisMoody, CM_Ultimate_MA_MTF_V2, https://www.tradingview.com/script/8KVcQiJM-CM-Ultimate-MA-MTF-V2/
- AlphaTrend: KivancOzbilgic, https://www.tradingview.com/script/o50NYLAZ-AlphaTrend/
- Chandelier Exit: Chuck LeBeau (StockCharts ChartSchool) and everget,
  https://www.tradingview.com/script/AqXxNS7j-Chandelier-Exit-everget/ (highest high / lowest low form)
- Slingshot: ChrisMoody, CM Sling Shot System, https://www.tradingview.com/script/GE7tSQK1-CM-Sling-Shot-System/
- ta.atr, ta.tr, ta.mfi, ta.rsi, ta.rma, ta.ema: https://www.tradingview.com/pine-script-reference/v6/

The bars are a deterministic synthetic series (no market data, no provider).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROWS = 200
OUT = Path(__file__).resolve().parent / "trend-indicator-reference.json"

Na = float | None


def bars() -> dict[str, list[float]]:
    """Up trend (bars 0-49), range (50-89), a flat run of 5 equal bars (90-94), a zero-volume bar (95),
    down trend (96-139), a gap up at 140 and a rally (141-199), with a small deterministic wobble."""
    seed = 12345
    o, h, l, c, v = [], [], [], [], []
    price = 100.0
    for i in range(ROWS):
        seed = (seed * 1103515245 + 12345) % 2**31
        noise = (seed / 2**31 - 0.5) * 1.6
        drift = 0.35 if i < 50 else (0.0 if i < 96 else (-0.4 if i < 140 else 0.3))
        if i == 140:
            price += 4.0  # gap up
        open_ = price
        if 90 <= i <= 94:  # flat run: open = high = low = close
            close = high = low = price
        else:
            close = price + drift + noise + 0.8 * math.sin(i / 3.0)
            high = max(open_, close) + 0.3 + abs(noise) * 0.5
            low = min(open_, close) - 0.3 - abs(math.cos(i)) * 0.4
        seed = (seed * 1103515245 + 12345) % 2**31
        volume = 0.0 if i == 95 else 1000.0 + float(seed % 900)
        o.append(round(open_, 4))
        h.append(round(high, 4))
        l.append(round(low, 4))
        c.append(round(close, 4))
        v.append(volume)
        price = c[-1]
    return {"open": o, "high": h, "low": l, "close": c, "volume": v}


def nz(x: Na, y: Na = 0.0) -> Na:
    return y if x is None else x


def back(series: list[Na], i: int, k: int) -> Na:
    return series[i - k] if i - k >= 0 else None


def window(series: list[Na], i: int, length: int) -> list[float] | None:
    """The last `length` non-na values up to bar i (Pine built-ins skip na), or None."""
    values = [x for x in series[: i + 1] if x is not None]
    return values[-length:] if len(values) >= length else None


def sma(src: list[Na], length: int) -> list[Na]:
    out: list[Na] = []
    for i in range(len(src)):
        w = window(src, i, length) if src[i] is not None else None
        out.append(None if w is None else sum(w) / length)
    return out


def wma(src: list[Na], length: int) -> list[Na]:
    out: list[Na] = []
    for i in range(len(src)):
        w = window(src, i, length) if src[i] is not None else None
        out.append(None if w is None else sum((k + 1) * x for k, x in enumerate(w)) / (length * (length + 1) / 2))
    return out


def recursive(src: list[Na], length: int, alpha: float) -> list[Na]:
    """Pine ta.rma / ta.ema: sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])."""
    seed = sma(src, length)
    out: list[Na] = []
    for i in range(len(src)):
        prev = back(out, i, 1)
        if prev is None:
            out.append(seed[i])
        else:
            out.append(None if src[i] is None else alpha * src[i] + (1 - alpha) * prev)
    return out


def rma(src: list[Na], length: int) -> list[Na]:
    return recursive(src, length, 1.0 / length)


def ema(src: list[Na], length: int) -> list[Na]:
    return recursive(src, length, 2.0 / (length + 1))


def tr(b: dict, handle_na: bool) -> list[Na]:
    h, l, c = b["high"], b["low"], b["close"]
    out: list[Na] = []
    for i in range(len(c)):
        if i == 0:
            out.append(h[i] - l[i] if handle_na else None)
        else:
            out.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    return out


def atr(b: dict, length: int) -> list[Na]:
    return rma(tr(b, True), length)


def highest(src: list[float], length: int) -> list[Na]:
    return [max(src[i - length + 1 : i + 1]) if i >= length - 1 else None for i in range(len(src))]


def lowest(src: list[float], length: int) -> list[Na]:
    return [min(src[i - length + 1 : i + 1]) if i >= length - 1 else None for i in range(len(src))]


def mfi(src: list[float], volume: list[float], length: int) -> list[Na]:
    """ta.mfi: upper = sum(volume * (change <= 0 ? 0 : src)), lower = sum(volume * (change >= 0 ? 0 : src));
    the na change of bar 0 is skipped. lower = 0: 100 when upper > 0, na when both are 0."""
    up: list[Na] = [None]
    down: list[Na] = [None]
    for i in range(1, len(src)):
        change = src[i] - src[i - 1]
        up.append(0.0 if change <= 0 else volume[i] * src[i])
        down.append(0.0 if change >= 0 else volume[i] * src[i])
    out: list[Na] = []
    for i in range(len(src)):
        wu, wd = window(up, i, length), window(down, i, length)
        if wu is None or wd is None:
            out.append(None)
            continue
        upper, lower = sum(wu), sum(wd)
        if lower == 0:
            out.append(100.0 if upper > 0 else None)
        else:
            out.append(100.0 - 100.0 / (1.0 + upper / lower))
    return out


def rsi(src: list[float], length: int) -> list[Na]:
    u: list[Na] = [None] + [max(src[i] - src[i - 1], 0.0) for i in range(1, len(src))]
    d: list[Na] = [None] + [max(src[i - 1] - src[i], 0.0) for i in range(1, len(src))]
    ru, rd = rma(u, length), rma(d, length)
    out: list[Na] = []
    for a, b_ in zip(ru, rd, strict=True):
        if a is None or b_ is None:
            out.append(None)
        elif b_ == 0:
            out.append(100.0 if a > 0 else None)
        else:
            out.append(100.0 - 100.0 / (1.0 + a / b_))
    return out


def supertrend(b: dict, factor: float, length: int) -> tuple[list[Na], list[Na]]:
    """Pine ta.supertrend; direction returned in Vertex sign (+1 up, -1 down; Pine uses -1 up)."""
    h, l, c = b["high"], b["low"], b["close"]
    a = atr(b, length)
    lower_s: list[Na] = []
    upper_s: list[Na] = []
    line: list[Na] = []
    direction: list[Na] = []
    for i in range(len(c)):
        src = (h[i] + l[i]) / 2
        upper = None if a[i] is None else src + factor * a[i]
        lower = None if a[i] is None else src - factor * a[i]
        prev_lower = nz(back(lower_s, i, 1))
        prev_upper = nz(back(upper_s, i, 1))
        close_prev = back(c, i, 1)
        lower_keep = not (
            (lower is not None and lower > prev_lower) or (close_prev is not None and close_prev < prev_lower)
        )
        upper_keep = not (
            (upper is not None and upper < prev_upper) or (close_prev is not None and close_prev > prev_upper)
        )
        lower = prev_lower if lower_keep else lower
        upper = prev_upper if upper_keep else upper
        lower_s.append(lower)
        upper_s.append(upper)
        prev_line = back(line, i, 1)
        if back(a, i, 1) is None:
            pine_dir = 1
        elif prev_line is not None and prev_line == prev_upper:
            pine_dir = -1 if (upper is not None and c[i] > upper) else 1
        else:
            pine_dir = 1 if (lower is not None and c[i] < lower) else -1
        value = lower if pine_dir == -1 else upper
        line.append(value)
        direction.append(None if a[i] is None else float(-pine_dir))
    return [x if a[i] is not None else None for i, x in enumerate(line)], direction


def hull(src: list[Na], length: int) -> list[Na]:
    half, full = wma(src, length // 2), wma(src, length)
    inner = [None if x is None or y is None else 2 * x - y for x, y in zip(half, full, strict=True)]
    return wma(inner, round(math.sqrt(length)))


def gd(src: list[Na], length: int, factor: float) -> list[Na]:
    e1 = ema(src, length)
    e2 = ema(e1, length)
    return [None if x is None or y is None else x * (1 + factor) - y * factor for x, y in zip(e1, e2, strict=True)]


def ultimate_ma(b: dict, kind: str, length: int, smoothing: int = 2) -> tuple[list[Na], list[Na]]:
    src: list[Na] = list(b["close"])
    vol = b["volume"]
    if kind == "sma":
        out = sma(src, length)
    elif kind == "ema":
        out = ema(src, length)
    elif kind == "wma":
        out = wma(src, length)
    elif kind == "hull":
        out = hull(src, length)
    elif kind == "vwma":
        num = sma([x * y for x, y in zip(b["close"], vol, strict=True)], length)
        den = sma(list(vol), length)
        out = [None if x is None or y is None else x / y for x, y in zip(num, den, strict=True)]
    elif kind == "rma":
        out = rma(src, length)
    elif kind == "tema":
        e1 = ema(src, length)
        e2 = ema(e1, length)
        e3 = ema(e2, length)
        out = [None if None in (x, y, z) else 3 * (x - y) + z for x, y, z in zip(e1, e2, e3, strict=True)]
    else:  # t3, Tilson factor 0.7
        out = gd(gd(gd(src, length, 0.7), length, 0.7), length, 0.7)
    direction: list[Na] = []
    for i in range(len(out)):
        prev = back(out, i, smoothing)
        direction.append(None if out[i] is None or prev is None else (1.0 if out[i] >= prev else -1.0))
    return out, direction


def alphatrend(b: dict, length: int, coeff: float, momentum: str) -> tuple[list[Na], list[Na]]:
    h, l, c = b["high"], b["low"], b["close"]
    atr_s = sma(tr(b, False), length)
    hlc3 = [(x + y + z) / 3 for x, y, z in zip(h, l, c, strict=True)]
    mom = mfi(hlc3, b["volume"], length) if momentum == "mfi" else rsi(c, length)
    line: list[Na] = []
    for i in range(len(c)):
        up_t = None if atr_s[i] is None else l[i] - atr_s[i] * coeff
        down_t = None if atr_s[i] is None else h[i] + atr_s[i] * coeff
        prev = nz(back(line, i, 1))
        bullish = mom[i] is not None and mom[i] >= 50
        if bullish:
            value = prev if (up_t is not None and up_t < prev) else up_t
        else:
            value = prev if (down_t is not None and down_t > prev) else down_t
        line.append(value)
    direction: list[Na] = []
    for i in range(len(c)):
        a0, a1, a2, a3 = line[i], back(line, i, 1), back(line, i, 2), back(line, i, 3)
        if None in (a0, a1, a2, a3):
            direction.append(None)
        elif a0 > a2:
            direction.append(1.0)
        elif a0 < a2:
            direction.append(-1.0)
        else:
            direction.append(1.0 if a1 > a3 else -1.0)
    return line, direction


def chandelier(b: dict, length: int, mult: float) -> tuple[list[Na], list[Na], list[Na]]:
    h, l, c = b["high"], b["low"], b["close"]
    a = atr(b, length)
    hh, ll = highest(h, length), lowest(l, length)
    long_s: list[Na] = []
    short_s: list[Na] = []
    dirs: list[Na] = []
    state = 1.0
    for i in range(len(c)):
        band = None if a[i] is None else mult * a[i]
        long_stop = None if band is None or hh[i] is None else hh[i] - band
        short_stop = None if band is None or ll[i] is None else ll[i] + band
        long_prev = nz(back(long_s, i, 1), long_stop)
        short_prev = nz(back(short_s, i, 1), short_stop)
        close_prev = back(c, i, 1)
        if close_prev is not None and long_prev is not None and close_prev > long_prev:
            long_stop = max(long_stop, long_prev)
        if close_prev is not None and short_prev is not None and close_prev < short_prev:
            short_stop = min(short_stop, short_prev)
        long_s.append(long_stop)
        short_s.append(short_stop)
        if short_prev is not None and c[i] > short_prev:
            state = 1.0
        elif long_prev is not None and c[i] < long_prev:
            state = -1.0
        dirs.append(None if long_stop is None else state)
    return long_s, short_s, dirs


def slingshot(b: dict, fast: int, slow: int) -> tuple[list[Na], list[Na], list[Na]]:
    f, s = ema(list(b["close"]), fast), ema(list(b["close"]), slow)
    d = [None if x is None or y is None else (1.0 if x > y else (-1.0 if x < y else 0.0)) for x, y in zip(f, s, strict=True)]
    return f, s, d


def rounded(series: list[Na]) -> list[Na]:
    return [None if x is None else round(x, 10) for x in series]


def main() -> None:
    b = bars()
    expected: dict[str, list[Na]] = {}
    line, direction = supertrend(b, 3.0, 10)
    expected["supertrend_10_3.line"], expected["supertrend_10_3.direction"] = line, direction
    for kind in ("sma", "ema", "wma", "hull", "vwma", "rma", "tema", "t3"):
        value, d = ultimate_ma(b, kind, 20)
        expected[f"ultimate_ma_{kind}_20.value"], expected[f"ultimate_ma_{kind}_20.direction"] = value, d
    for momentum in ("mfi", "rsi"):
        at, d = alphatrend(b, 14, 1.0, momentum)
        expected[f"alphatrend_14_1_{momentum}.line"], expected[f"alphatrend_14_1_{momentum}.direction"] = at, d
    long_s, short_s, d = chandelier(b, 22, 3.0)
    expected["chandelier_22_3.longStop"] = long_s
    expected["chandelier_22_3.shortStop"] = short_s
    expected["chandelier_22_3.direction"] = d
    f, s, d = slingshot(b, 38, 62)
    expected["slingshot_38_62.fast"], expected["slingshot_38_62.slow"], expected["slingshot_38_62.direction"] = f, s, d
    hlc3 = [(x + y + z) / 3 for x, y, z in zip(b["high"], b["low"], b["close"], strict=True)]
    expected["mfi_hlc3_14"] = mfi(hlc3, b["volume"], 14)
    expected["rsi_close_14"] = rsi(b["close"], 14)
    doc = {
        "source": "literal transcription of the TradingView Pine formulas (see make_trend_reference.py)",
        "generator": "services/research/tests/fixtures/make_trend_reference.py",
        "bars": b,
        "expected": {k: rounded(v) for k, v in expected.items()},
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")


if __name__ == "__main__":
    main()
