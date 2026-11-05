"""Indicator kernels: hand-computed cases, TA-Lib reference parity and input guards."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from indicators import (
    MAX_PERIOD,
    adx,
    atr,
    bollinger_bands,
    ema,
    lwma,
    macd,
    parabolic_sar,
    realized_volatility,
    rolling_vwap,
    rsi,
    sma,
    smma,
    stochastic,
    true_range,
    zscore,
)

REFERENCE = json.loads((Path(__file__).parent / "fixtures" / "indicator-reference.json").read_text())
N = None


def close_to(actual, expected, tolerance=1e-9):
    assert len(actual) == len(expected)
    for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
        if right is None:
            assert left is None, index
        else:
            assert left is not None, index
            assert math.isclose(left, right, rel_tol=tolerance, abs_tol=tolerance), (index, left, right)


def matches_reference(actual, expected, tolerance=1e-9):
    """Compare every bar TA-Lib defines. Bars TA-Lib leaves undefined are checked by the hand tests."""
    assert len(actual) == len(expected)
    defined = [index for index, value in enumerate(expected) if value is not None]
    assert defined, "reference has no defined values"
    close_to([actual[index] for index in defined], [expected[index] for index in defined], tolerance)


# Hand-computed values. Each comment shows the arithmetic.


def test_moving_averages_by_hand():
    values = [2, 4, 6, 8, 13]
    close_to(sma(values, 3), [N, N, 4, 6, 9])
    # EMA alpha 2/4: seed SMA(2,4,6)=4; 4+.5*(8-4)=6; 6+.5*(13-6)=9.5
    close_to(ema(values, 3), [N, N, 4, 6, 9.5])
    # SMMA: seed 4; (4*2+8)/3=16/3; (16/3*2+13)/3=71/9
    close_to(smma(values, 3), [N, N, 4, 16 / 3, 71 / 9])
    # LWMA weights 1,2,3 over 6: (2+8+18)/6, (4+12+24)/6, (6+16+39)/6
    close_to(lwma(values, 3), [N, N, 28 / 6, 40 / 6, 61 / 6])
    close_to(sma(values, 1), [2, 4, 6, 8, 13])
    assert sma([1, 2], 3) == [N, N]
    assert lwma([1, 2], 3) == [N, N]
    assert ema([], 3) == []


def test_rsi_by_hand_and_flat_window():
    # deltas +1,-1,+2,0,-1. Period 2 averages: (.5,.5) (1.25,.25) (.625,.125) (.3125,.5625)
    close_to(rsi([10, 11, 10, 12, 12, 11], 2), [N, N, 50, 250 / 3, 250 / 3, 100 * 0.3125 / 0.875])
    assert rsi([5, 5, 5, 5], 2) == [N, N, 50, 50]
    assert rsi([5, 6], 2) == [N, N]


def test_rolling_vwap_uses_typical_price_and_gaps_zero_volume():
    high, low, close = [11, 12, 13], [9, 10, 11], [10, 11, 12]
    close_to(rolling_vwap(high, low, close, [100, 0, 300], 2), [N, 10, 12])
    assert rolling_vwap(high, low, close, [0, 0, 5], 2) == [N, N, 12]


def test_true_range_and_atr_by_hand():
    high, low, close = [10, 12, 11, 15], [8, 9, 9, 11], [9, 11, 10, 14]
    # TR: max(3,3,0)=3; max(2,0,2)=2; max(4,5,1)=5
    assert true_range(high, low, close) == [N, 3, 2, 5]
    # Wilder seed (3+2)/2=2.5; (2.5*1+5)/2=3.75. SMA: (2+5)/2=3.5
    close_to(atr(high, low, close, 2), [N, N, 2.5, 3.75])
    close_to(atr(high, low, close, 2, method="sma"), [N, N, 2.5, 3.5])
    close_to(atr(high, low, close, 1), [N, 3, 2, 5])
    with pytest.raises(ValueError, match="method"):
        atr(high, low, close, 2, method="ema")  # type: ignore[arg-type]


def test_bollinger_by_hand():
    bands = bollinger_bands([1, 2, 3, 4], 2, 2)
    close_to(bands.middle, [N, 1.5, 2.5, 3.5])
    close_to(bands.upper, [N, 2.5, 3.5, 4.5])
    close_to(bands.lower, [N, 0.5, 1.5, 2.5])
    assert bollinger_bands([3, 3], 2, 1).upper == [N, 3]
    assert bollinger_bands([3], 2, 1).middle == [N]


def test_parabolic_sar_by_hand_including_reversal():
    # acceleration .1, max .2: long from bar 1, reversal to short at bar 3.
    close_to(parabolic_sar([10, 11, 12, 11, 9], [9, 10, 11, 9, 8], 0.1, 0.2), [N, 9, 9.2, 12, 12])
    # Short start (bar 1 minus movement wins), then reversal to long.
    short = parabolic_sar([12, 11, 10, 12, 13], [11, 9, 8, 9, 11], 0.1, 0.2)
    # init short: extreme=9, sar=12. bar1 out 12; sar=max(12-.3, 11, 11)=11.7
    # bar2 out 11.7; new low 8 -> extreme 8, af .2; sar=max(11.7-.74, 11, 10)=11
    # bar3 high 12 >= 11 -> long; sar=min(8, 8, 9)=8; out 8
    close_to(short[:4], [N, 12, 11.7, 8])
    assert parabolic_sar([1], [1]) == [N]
    with pytest.raises(ValueError, match="exceed"):
        parabolic_sar([2, 3], [1, 2], 0.3, 0.2)


def test_macd_by_hand():
    result = macd([1, 2, 4, 8, 16, 32], fast=2, slow=3, signal=2)
    # seeds at bar 2: fast SMA(2,4)=3, slow SMA(1,2,4)=7/3 -> 2/3
    # bar 3: fast 19/3, slow 31/6 -> 7/6. Signal seed mean(2/3, 7/6)=11/12
    # bar 4: fast 115/9, slow 127/12 -> 79/36; signal 11/12+2/3*(79/36-33/36)=191/108
    close_to(result.macd[:5], [N, N, 2 / 3, 7 / 6, 79 / 36])
    close_to(result.signal[:5], [N, N, N, 11 / 12, 191 / 108])
    close_to(result.histogram[:5], [N, N, N, 7 / 6 - 11 / 12, 79 / 36 - 191 / 108])
    with pytest.raises(ValueError, match="shorter"):
        macd([1, 2, 3], fast=3, slow=3, signal=1)
    assert macd([1, 2], fast=1, slow=3, signal=1).macd == [N, N]


def test_stochastic_by_hand_and_zero_range():
    high, low, close = [10, 11, 12, 13, 12], [8, 9, 10, 11, 10], [9, 11, 10, 12, 11]
    # raw %K: 50, 75, 100/3. %K SMA(2): 62.5, (75+100/3)/2. %D SMA(2) of %K.
    result = stochastic(high, low, close, 3, 2, 2)
    k4 = (75 + 100 / 3) / 2
    close_to(result.k, [N, N, N, 62.5, k4])
    close_to(result.d, [N, N, N, N, (62.5 + k4) / 2])
    fast = stochastic(high, low, close, 3, 1, 1)
    close_to(fast.k, [N, N, 50, 75, 100 / 3])
    flat = stochastic([5, 5, 5], [5, 5, 5], [5, 5, 5], 2, 1, 1)
    assert flat.k == [N, 50, 50]


def test_adx_by_hand():
    high, low, close = [10, 12, 13, 12, 14], [8, 9, 11, 10, 11], [9, 11, 12, 11, 13]
    result = adx(high, low, close, 2)
    # sums after bar 2: +DM 2, -DM 0, TR 3.5 -> +DI 400/7, DX 100
    # bar 3: +DM 1, -DM 1, TR 3.75 -> DI 80/3 each, DX 0 -> ADX (100+0)/2=50
    # bar 4: +DM 2.5, -DM .5, TR 4.875 -> DX 200/3 -> ADX (50+200/3)/2
    close_to(result.plus_di, [N, N, 400 / 7, 80 / 3, 250 / 4.875])
    close_to(result.minus_di, [N, N, 0, 80 / 3, 50 / 4.875])
    close_to(result.adx, [N, N, N, 50, (50 + 200 / 3) / 2])
    flat = adx([5, 5, 5], [5, 5, 5], [5, 5, 5], 1)
    assert flat.plus_di == [N, 0, 0] and flat.adx == [N, 0, 0]


# TA-Lib reference parity on the same synthetic bars.

BARS = REFERENCE["bars"]
EXPECTED = REFERENCE["expected"]
H, L, C = BARS["high"], BARS["low"], BARS["close"]


def test_reference_is_talib_on_synthetic_bars():
    assert REFERENCE["source"].startswith("TA-Lib C ")
    assert len(C) == 80


@pytest.mark.parametrize(
    "actual,key",
    [
        (lambda: sma(C, 10), "sma_10"),
        (lambda: ema(C, 10), "ema_10"),
        (lambda: lwma(C, 10), "lwma_10"),
        (lambda: rsi(C, 14), "rsi_14"),
        (lambda: true_range(H, L, C), "true_range"),
        (lambda: atr(H, L, C, 14), "atr_14"),
        (lambda: parabolic_sar(H, L, 0.02, 0.2), "sar_002_02"),
    ],
)
def test_single_line_parity_with_talib(actual, key):
    result = actual()
    matches_reference(result, EXPECTED[key])
    first = next(index for index, value in enumerate(EXPECTED[key]) if value is not None)
    assert all(value is None for value in result[:first]) and result[first] is not None


def test_sar_reference_contains_both_trend_directions():
    sar = EXPECTED["sar_002_02"]
    assert any(value > high for value, high in zip(sar, H, strict=True) if value is not None)
    assert any(value < low for value, low in zip(sar, L, strict=True) if value is not None)


def test_multi_line_parity_with_talib():
    bands = bollinger_bands(C, 20, 2)
    for name in ("upper", "middle", "lower"):
        matches_reference(getattr(bands, name), EXPECTED["bollinger_20_2"][name])
    result = macd(C, 12, 26, 9)
    for name in ("macd", "signal", "histogram"):
        matches_reference(getattr(result, name), EXPECTED["macd_12_26_9"][name])
    # TA-Lib starts every MACD output at bar 33; this library shows the line from bar 25.
    assert result.macd[24] is None and result.macd[25] is not None and result.signal[32] is None
    stoch = stochastic(H, L, C, 14, 3, 3)
    matches_reference(stoch.k, EXPECTED["stochastic_14_3_3"]["k"])
    # %K starts at bar 15 here; TA-Lib starts %K and %D together at bar 17.
    assert stoch.k[14] is None and stoch.k[15] is not None and stoch.d[16] is None
    assert EXPECTED["stochastic_14_3_3"]["k"][16] is None and EXPECTED["stochastic_14_3_3"]["k"][17] is not None
    matches_reference(stoch.d, EXPECTED["stochastic_14_3_3"]["d"])
    directional = adx(H, L, C, 14)
    for name in ("plus_di", "minus_di", "adx"):
        matches_reference(getattr(directional, name), EXPECTED["adx_14"][name])
    assert directional.adx[26] is None and directional.adx[27] is not None


# Input guards.


@pytest.mark.parametrize(
    "call,error,match",
    [
        (lambda: sma([1, math.nan], 1), ValueError, "finite"),
        (lambda: sma([1, True], 1), TypeError, "real numbers"),
        (lambda: sma("123", 1), TypeError, "sequence"),
        (lambda: sma([1, 2], 0), ValueError, "period"),
        (lambda: sma([1, 2], MAX_PERIOD + 1), ValueError, "period"),
        (lambda: sma([1, 2], 2.0), TypeError, "integer"),
        (lambda: atr([1, 2], [1], [1, 2], 1), ValueError, "same length"),
        (lambda: atr([1, 2], [2, 1], [1, 2], 1), ValueError, "low above high"),
        (lambda: atr([2, 2], [1, 1], [1, 3], 1), ValueError, "close outside"),
        (lambda: rolling_vwap([2], [1], [1], [-1], 1), ValueError, "negative"),
        (lambda: rolling_vwap([2], [1], [1], [1, 1], 1), ValueError, "same length"),
        (lambda: bollinger_bands([1, 2], 2, 0), ValueError, "positive"),
        (lambda: bollinger_bands([1, 2], 2, "2"), TypeError, "real number"),
    ],
)
def test_rejects_invalid_input(call, error, match):
    with pytest.raises(error, match=match):
        call()


def test_inputs_are_not_mutated_or_sorted():
    values = [3.0, 1.0, 2.0]
    assert sma(values, 1) == [3.0, 1.0, 2.0]
    assert values == [3.0, 1.0, 2.0]


def test_row_limit_and_internal_undefined_guards(monkeypatch):
    from indicators import core

    monkeypatch.setattr(core, "MAX_ROWS", 2)
    with pytest.raises(ValueError, match="more than 2 rows"):
        sma([1, 2, 3], 1)
    with pytest.raises(ValueError, match="seed window"):
        core._seeded_ema([None, 1.0], 2, 1, 0.5)
    with pytest.raises(ValueError, match="after its seed"):
        core._seeded_ema([1.0, None], 1, 0, 0.5)
    with pytest.raises(ValueError, match="rolling mean"):
        core._rolling_mean([1.0, None], 1, 0)


def test_running_window_kernels_match_brute_force():
    import random

    rng = random.Random(7)
    closes = [100.0]
    for _ in range(599):
        closes.append(max(1.0, closes[-1] + rng.uniform(-2, 2)))
    highs = [value + rng.uniform(0, 1.5) for value in closes]
    lows = [value - rng.uniform(0, 1.5) for value in closes]
    volumes = [0.0 if index % 7 == 0 else rng.uniform(0, 500) for index in range(600)]
    for span in (1, 5, 37):
        bands = bollinger_bands(closes, span, 2)
        vwap = rolling_vwap(highs, lows, closes, volumes, span)
        stoch = stochastic(highs, lows, closes, span, 1, 1)
        for index in range(span - 1, 600):
            window = closes[index - span + 1 : index + 1]
            mean = math.fsum(window) / span
            deviation = math.sqrt(math.fsum((value - mean) ** 2 for value in window) / span)
            assert math.isclose(bands.upper[index], mean + 2 * deviation, rel_tol=1e-9, abs_tol=1e-9)
            volume = math.fsum(volumes[index - span + 1 : index + 1])
            typical = math.fsum(
                (highs[i] + lows[i] + closes[i]) / 3 * volumes[i] for i in range(index - span + 1, index + 1)
            )
            if volume == 0:
                assert vwap[index] is None
            else:
                assert math.isclose(vwap[index], typical / volume, rel_tol=1e-9)
            top = max(highs[index - span + 1 : index + 1])
            bottom = min(lows[index - span + 1 : index + 1])
            assert math.isclose(stoch.k[index], 100 * (closes[index] - bottom) / (top - bottom), rel_tol=1e-9)


def test_zscore_hand_cases():
    # Windows [1, 2, 4] and [2, 4, 8]: (x - mean) / sample deviation (ddof 1).
    close_to(zscore([1, 2, 4, 8], 3), [N, N, 5 / math.sqrt(21), 10 / math.sqrt(84)])
    close_to(zscore([3, 1], 2), [N, -1 / math.sqrt(2)])
    # A flat window has no defined z-score.
    close_to(zscore([5, 5, 5, 6], 2), [N, N, N, 0.5 / math.sqrt(0.5)])


def test_realized_volatility_hand_cases():
    # Returns 0.1, -0.1, 0.0; sample deviation of each 2-return window, times 100 * sqrt(1).
    close_to(realized_volatility([100, 110, 99, 99], 2, periods_per_year=1), [N, N, 100 * math.sqrt(0.02), 100 * math.sqrt(0.005)])
    close_to(realized_volatility([100, 110, 99], 2), [N, N, 100 * math.sqrt(0.02) * math.sqrt(252)])
    assert realized_volatility([10, 10, 10, 10], 2) == [N, N, 0.0, 0.0]
    assert realized_volatility([10, 11], 2) == [N, N]


def test_flat_windows_after_a_volatile_stretch():
    # A volatile stretch leaves rounding residue in a running variance; a flat window must still be exact.
    import random

    rng = random.Random(5)
    closes = [100.0 + rng.uniform(-30, 30) for _ in range(97)] + [123.456] * 40
    for span in (2, 7, 20):
        z = zscore(closes, span)
        assert all(value is None for value in z[97 + span - 1 :])
        assert all(value is not None for value in z[span - 1 : 97])
    growth = [100.0 * 1.5**index for index in range(5)] + [7.0] * 30
    vol = realized_volatility([100.0 + rng.uniform(-30, 30) for _ in range(50)] + [42.0] * 30, 10)
    assert vol[-20:] == [0.0] * 20 and vol[50] > 0
    assert realized_volatility(growth, 3)[-1] == 0.0


def test_zscore_and_realized_volatility_match_brute_force():
    import random

    rng = random.Random(11)
    closes = [100.0]
    for _ in range(499):
        closes.append(closes[-1] * (1 + rng.uniform(-0.03, 0.03)))
    simple = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]
    for span in (2, 5, 63):
        z = zscore(closes, span)
        vol = realized_volatility(closes, span)
        for index in range(span - 1, len(closes)):
            window = closes[index - span + 1 : index + 1]
            mean = math.fsum(window) / span
            deviation = math.sqrt(math.fsum((value - mean) ** 2 for value in window) / (span - 1))
            assert math.isclose(z[index], (closes[index] - mean) / deviation, rel_tol=1e-8, abs_tol=1e-8)
            if index >= span:
                returns = simple[index - span : index]
                r_mean = math.fsum(returns) / span
                r_dev = math.sqrt(math.fsum((r - r_mean) ** 2 for r in returns) / (span - 1))
                assert math.isclose(vol[index], 100 * math.sqrt(252) * r_dev, rel_tol=1e-8)


@pytest.mark.parametrize(
    ("call", "error"),
    [
        (lambda: zscore([1, 2, 3], 1), ValueError),
        (lambda: realized_volatility([1, 2, 3], 1), ValueError),
        (lambda: realized_volatility([1, 0, 3], 2), ValueError),
        (lambda: realized_volatility([1, 2, 3], 2, periods_per_year=0), ValueError),
        (lambda: realized_volatility([1, 2, 3], 2, periods_per_year=True), ValueError),
        (lambda: zscore([1, float("nan")], 2), ValueError),
    ],
)
def test_zscore_and_realized_volatility_guards(call, error):
    with pytest.raises(error):
        call()


def test_zscore_and_realized_volatility_match_the_gs_quant_fixture():
    # gs-quant-reference.json holds gs-quant 2.2.4 output on the fixture closes (make_gs_quant_reference.py).
    gs = json.loads((Path(__file__).parent / "fixtures" / "gs-quant-reference.json").read_text())["expected"]
    closes = REFERENCE["bars"]["close"]
    for window in (5, 20):
        close_to(zscore(closes, window), gs[f"zscore_{window}"])
        close_to(realized_volatility(closes, window), gs[f"realized_vol_{window}"])
