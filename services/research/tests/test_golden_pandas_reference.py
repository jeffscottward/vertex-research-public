"""Independent pandas reference for the golden battery: hand-computed cases and
reproduction of the committed tests/fixtures/golden/golden-reference.json.

pandas is not a project dependency. Without it this module is skipped; run it in the
throwaway environment described in tests/golden/make_golden_reference.py.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

pd = pytest.importorskip("pandas")

from tests.golden.pandas_reference import (  # noqa: E402
    RsiReversion,
    SmaCross,
    backtest,
    load_bars,
    target_state,
    wilder_rsi,
)
from tests.golden.pandas_reference import smma as pandas_smma  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "golden"
REFERENCE = json.loads((FIXTURES / "golden-reference.json").read_text())
TOLERANCE = 1e-9


def within(actual, expected) -> bool:
    if actual is None or expected is None:
        return actual is expected
    return abs(actual - expected) <= TOLERANCE * max(1.0, abs(expected))


HEADER = "date,open,high,low,close,adj_close,volume\n"


def write_bars(tmp_path: Path, rows: list[tuple[float, float, float, float]], adj: list[float] | None = None) -> Path:
    days = pd.bdate_range("2020-01-01", periods=len(rows))
    lines = [HEADER]
    for index, (day, (open_, high, low, close)) in enumerate(zip(days, rows, strict=True)):
        adjusted = close if adj is None else adj[index]
        lines.append(f"{day.date().isoformat()},{open_},{high},{low},{close},{adjusted},100\n")
    path = tmp_path / "bars.csv"
    path.write_text("".join(lines))
    return path


# SMA(1)/SMA(2): fast moves above slow on bar 2 (fill at the bar 3 open 11.5) and falls to or
# below it on bar 4 (fill at the bar 5 open 10.5). Same bars as the TypeScript battery test.
CROSS_ROWS = [
    (10, 10, 10, 10),
    (10, 10, 9, 9),
    (9, 11, 9, 11),
    (11.5, 12, 11.5, 12),
    (12, 12, 10, 10),
    (10.5, 13, 10.5, 13),
]


def test_load_bars_scales_prices_to_total_return(tmp_path):
    bars = load_bars(write_bars(tmp_path, [(20, 22, 18, 20)], adj=[10]))
    assert bars.iloc[0].tolist() == [10, 11, 9, 10]
    assert str(bars.index[0].tz) == "UTC"


def test_sma_cross_by_hand(tmp_path):
    bars = load_bars(write_bars(tmp_path, CROSS_ROWS))
    result = backtest(bars, SmaCross(fast=1, slow=2), cost_bps=0)
    assert result["trades"] == [
        {
            "entryIndex": 3,
            "exitIndex": 5,
            "entryPrice": 11.5,
            "exitPrice": 10.5,
            "netReturn": pytest.approx(10.5 / 11.5 - 1),
            "pnl": pytest.approx(10.5 / 11.5 - 1),
            "exitReason": "signal",
        }
    ]
    stats = result["stats"]
    # Equity 1,1,1,12/11.5,10/11.5,10.5/11.5.
    assert stats["finalEquity"] == pytest.approx(10.5 / 11.5)
    assert stats["maxDrawdown"] == pytest.approx(10 / 12 - 1)
    assert stats["exposure"] == pytest.approx(2 / 6)
    assert stats["winRate"] == 0
    assert stats["profitFactor"] == 0
    assert stats["trades"] == 1


def test_cost_is_charged_on_both_legs(tmp_path):
    bars = load_bars(write_bars(tmp_path, CROSS_ROWS))
    result = backtest(bars, SmaCross(fast=1, slow=2), cost_bps=100)
    assert result["stats"]["finalEquity"] == pytest.approx(0.99 * 0.99 * 10.5 / 11.5)


def test_position_open_at_the_end_closes_at_the_last_close(tmp_path):
    rows = [(10, 10, 10, 10), (10, 11, 10, 11), (11.5, 12, 11.5, 12), (12.5, 13, 12.5, 13)]
    result = backtest(load_bars(write_bars(tmp_path, rows)), SmaCross(fast=1, slow=2), cost_bps=0)
    assert [
        (trade["entryIndex"], trade["exitIndex"], trade["exitPrice"], trade["exitReason"]) for trade in result["trades"]
    ] == [(2, 3, 13, "end")]
    assert result["stats"]["finalEquity"] == pytest.approx(13 / 11.5)
    assert result["stats"]["winRate"] == 1
    assert result["stats"]["profitFactor"] is None


def test_wilder_rsi_by_hand_and_against_talib():
    # Changes -1,-1,-1,+1,+1,+1 with period 2: 0, 0, 50, 75, 87.5 from bar 2.
    values = wilder_rsi(pd.Series([10.0, 9, 8, 7, 8, 9, 10]), 2).tolist()
    assert math.isnan(values[0]) and math.isnan(values[1])
    assert values[2:] == [0, 0, 50, 75, 87.5]
    assert wilder_rsi(pd.Series([5.0, 5, 5, 6]), 2).tolist()[2:] == [50, 100]
    talib = json.loads((Path(__file__).parent / "fixtures" / "indicator-reference.json").read_text())
    ours = wilder_rsi(pd.Series(talib["bars"]["close"]), 14).tolist()
    for index, expected in enumerate(talib["expected"]["rsi_14"]):
        if expected is not None:
            assert ours[index] == pytest.approx(expected, rel=1e-9, abs=1e-9), index


def test_pandas_smma_by_hand():
    # Seed SMA(2,4,6)=4; (4*2+8)/3=16/3; (16/3*2+13)/3=71/9.
    values = pandas_smma(pd.Series([2.0, 4, 6, 8, 13]), 3).tolist()
    assert math.isnan(values[1])
    assert values[2:] == pytest.approx([4, 16 / 3, 71 / 9])


def test_rsi_target_state_holds_between_levels(tmp_path):
    closes = [10, 9, 8, 7, 8, 9, 10]
    rows = [(close, close, close, close) for close in closes]
    bars = load_bars(write_bars(tmp_path, rows))
    rule = RsiReversion(period=2, oversold=30, overbought=70)
    # RSI 0, 0 -> long; 50 -> keep; 75, 87.5 -> flat.
    assert target_state(bars, rule).tolist() == [0, 0, 1, 1, 1, 0, 0]


def test_committed_reference_reproduces():
    for case in REFERENCE["cases"]:
        rule = case["rule"]
        made = (
            SmaCross(fast=rule["fast"], slow=rule["slow"])
            if rule["kind"] == "smaCross"
            else RsiReversion(period=rule["period"], oversold=rule["oversold"], overbought=rule["overbought"])
        )
        result = backtest(load_bars(FIXTURES / f"{case['symbol']}-1d.csv"), made, case["costBps"])
        assert result["trades"] == case["trades"], case["id"]
        for name, expected in case["stats"].items():
            assert within(result["stats"][name], expected), (case["id"], name)
