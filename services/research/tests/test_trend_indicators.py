"""Trend Trio indicators (indicators/trend.py) against the shared reference table and hand cases."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from indicators import trend as T

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "trend-indicator-reference.json"
TOLERANCE = 1e-9


def _reference() -> tuple[dict[str, list[float]], dict[str, list[float | None]]]:
    doc = json.loads(FIXTURE.read_text())
    return doc["bars"], doc["expected"]


def _computed(bars: dict[str, list[float]]) -> dict[str, list[float]]:
    h, l, c, v = bars["high"], bars["low"], bars["close"], bars["volume"]
    out: dict[str, list[float]] = {}
    out["supertrend_10_3.line"], out["supertrend_10_3.direction"] = T.supertrend(h, l, c, 10, 3.0)
    for kind in T.MA_TYPES:
        value, direction = T.ultimate_ma(c, v, kind, 20)
        out[f"ultimate_ma_{kind}_20.value"], out[f"ultimate_ma_{kind}_20.direction"] = value, direction
    for momentum in ("mfi", "rsi"):
        line, direction = T.alphatrend(h, l, c, v, 14, 1.0, momentum)
        out[f"alphatrend_14_1_{momentum}.line"], out[f"alphatrend_14_1_{momentum}.direction"] = line, direction
    long_stop, short_stop, direction = T.chandelier_exit(h, l, c, 22, 3.0)
    out["chandelier_22_3.longStop"], out["chandelier_22_3.shortStop"] = long_stop, short_stop
    out["chandelier_22_3.direction"] = direction
    fast, slow, direction = T.slingshot(c, 38, 62)
    out["slingshot_38_62.fast"], out["slingshot_38_62.slow"], out["slingshot_38_62.direction"] = fast, slow, direction
    hlc3 = [(x + y + z) / 3 for x, y, z in zip(h, l, c, strict=True)]
    out["mfi_hlc3_14"] = T.mfi(hlc3, v, 14)
    out["rsi_close_14"] = T.rsi(c, 14)
    return out


BARS, EXPECTED = _reference()
COMPUTED = _computed(BARS)


@pytest.mark.parametrize("key", sorted(EXPECTED))
def test_matches_reference_table(key: str) -> None:
    got, ref = COMPUTED[key], EXPECTED[key]
    assert len(got) == len(ref)
    for index, (value, want) in enumerate(zip(got, ref, strict=True)):
        if want is None:
            assert math.isnan(value), f"{key}[{index}] = {value}, expected undefined"
        else:
            assert abs(value - want) <= TOLERANCE, f"{key}[{index}] = {value}, expected {want}"


def test_every_reference_key_is_checked() -> None:
    assert set(COMPUTED) == set(EXPECTED)


def nan_equal(got: list[float], want: list[float]) -> bool:
    return all((math.isnan(a) and math.isnan(b)) or a == b for a, b in zip(got, want, strict=True))


def test_hand_cases() -> None:
    nan = math.nan
    assert nan_equal(T.sma([1.0, 2.0, 3.0, 4.0], 2), [nan, 1.5, 2.5, 3.5])
    assert nan_equal(T.sma([nan, 2.0, 4.0], 2), [nan, nan, 3.0])
    assert nan_equal(T.rma([2.0, 2.0, 2.0, 4.0], 2), [nan, 2.0, 2.0, 3.0])
    assert nan_equal(T.ema([1.0, 3.0, 5.0], 2), [nan, 2.0, 2 / 3 * 5.0 + (1 - 2 / 3) * 2.0])
    assert nan_equal(T.wma([1.0, 2.0, 3.0], 2), [nan, 5.0 / 3, 8.0 / 3])
    assert nan_equal(T.true_range([3.0, 5.0], [1.0, 4.0], [2.0, 4.5], True), [2.0, 3.0])
    assert nan_equal(T.true_range([3.0, 5.0], [1.0, 4.0], [2.0, 4.5], False), [nan, 3.0])
    assert nan_equal(T.highest([1.0, 3.0, 2.0, 0.5], 2), [nan, 3.0, 3.0, 2.0])
    assert nan_equal(T.lowest([1.0, 3.0, 2.0, 0.5], 2), [nan, 1.0, 2.0, 0.5])
    assert T.mfi([1.0, 2.0, 3.0, 4.0], [1.0, 1.0, 1.0, 1.0], 2)[-1] == 100.0
    assert math.isnan(T.mfi([1.0, 1.0, 1.0], [1.0, 1.0, 1.0], 2)[-1])
    # A window whose falling flow left the running sum is exactly 0, not a rounding remainder.
    assert nan_equal(T.mfi([1.0, 0.1, 0.05, 0.05, 0.05], [1.0, 1.0, 4.0, 1.0, 1.0], 2), [nan, nan, 0.0, 0.0, nan])
    assert T.rsi([1.0, 2.0, 3.0], 2)[-1] == 100.0
    assert math.isnan(T.rsi([1.0, 1.0, 1.0], 2)[-1])
    assert T.slingshot([1.0, 1.0, 1.0], 1, 2)[2][-1] == 0.0


def test_direction_signs() -> None:
    rising = [float(i) for i in range(40)]
    _, direction = T.supertrend([x + 1 for x in rising], [x - 1 for x in rising], rising, 3, 1.0)
    assert direction[-1] == 1.0
    _, direction = T.ultimate_ma(rising, None, "sma", 3)
    assert direction[-1] == 1.0
    falling = rising[::-1]
    _, direction = T.ultimate_ma(falling, None, "sma", 3)
    assert direction[-1] == -1.0
    *_, direction = T.chandelier_exit([x + 1 for x in falling], [x - 1 for x in falling], falling, 3, 1.0)
    assert direction[-1] == -1.0


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (lambda: T.sma([1.0], 0), "length must be an integer from 1 to 2000"),
        (lambda: T.sma([1.0], True), "length must be an integer from 1 to 2000"),
        (lambda: T.supertrend([1.0], [1.0], [1.0], 10, 0.0), "factor must be a positive number"),
        (lambda: T.supertrend([1.0], [1.0], [1.0, 2.0]), "input series must have the same length"),
        (lambda: T.alphatrend([1.0], [1.0], [1.0]), "AlphaTrend momentum mfi needs volume; use momentum rsi"),
        (lambda: T.alphatrend([1.0], [1.0], [1.0], None, 14, 1.0, "obv"), "momentum must be mfi or rsi"),
        (lambda: T.moving_average([1.0], None, "vwma", 2), "vwma needs volume"),
        (lambda: T.moving_average([1.0], None, "kama", 2), "ma_type must be one of"),
        (lambda: T.ultimate_ma([1.0], None, "t3", 2, 2, -1.0), "t3_factor must be a positive number"),
    ],
)
def test_errors(call, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        call()


def test_vwma_zero_volume_window_is_undefined() -> None:
    assert math.isnan(T.moving_average([1.0, 2.0], [0.0, 0.0], "vwma", 2)[-1])
