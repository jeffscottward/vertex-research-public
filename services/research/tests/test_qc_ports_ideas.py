"""qc-ports ideas: derived series, selections and the pre-registered run family (hand-computed, synthetic)."""
import math
from statistics import stdev

import pytest

from nautilus_backtest import signals as sig
from strategies.qc_ports import ideas as qi
from strategies.qc_ports.book import parse_options


def test_month_end_indices_skip_the_open_last_month():
    dates = ["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01", "2024-03-04"]
    assert qi.month_end_indices(dates) == [1, 3]


def test_futures_trend_and_carry_by_hand():
    future = [100.0, 110.0, 99.0, 121.0]
    etf = [50.0, 50.0, 50.0, 60.0]
    (index, (trend, carry)), = qi.futures_trend_carry(future, etf, [3], lookback=3).items()
    returns = [0.1, -0.1, 121 / 99 - 1]
    assert index == 3
    assert trend == pytest.approx(0.21 / (stdev(returns) * math.sqrt(3)))
    assert carry == pytest.approx(0.2 - 0.21)


def test_futures_trend_needs_the_whole_window():
    assert qi.futures_trend_carry([100.0, None, 99.0, 121.0], [1.0] * 4, [3], lookback=3) == {}
    assert qi.futures_trend_carry([100.0, 110.0, 99.0, 121.0], [None, 1.0, 1.0, 1.0], [3], lookback=3) == {}
    assert qi.futures_trend_carry([100.0, 110.0, 121.0], [1.0] * 3, [1], lookback=3) == {}


def test_ols_by_hand():
    a0, a1, t = qi.ols([0, 1, 2, 3], [1, 3, 2, 5])
    assert (a0, a1) == (pytest.approx(1.1), pytest.approx(1.1))
    assert t == pytest.approx(1.1 / math.sqrt(2.7 / 2 / 5))
    assert qi.ols([0, 1, 2], [1, 3, 5])[2] is None  # exact fit: no standard error
    with pytest.raises(ValueError):
        qi.ols([1, 1, 1], [1, 2, 3])


def test_oil_regression_uses_last_months_oil_return():
    oil = [100.0, 110.0, 99.0, 108.9, 119.79]  # x = _, .1, -.1, .1, .1
    equity = [100.0, 100.0, 102.0, 99.96, 101.9592]  # y = _, 0, .02, -.02, .02
    out = qi.oil_predictions(oil, equity, [0.0] * 5, window=3)
    assert list(out) == [4]  # at t=3 the first pair would need x_0
    a0, a1, _, prediction = out[4]
    assert (a0, a1, prediction) == (pytest.approx(0, abs=1e-12), pytest.approx(0.2), pytest.approx(0.02))
    shifted = qi.oil_predictions(oil, equity, [12.0] * 5, window=3)[4]  # 12% bill: y - 0.01
    assert shifted[0] == pytest.approx(-0.01)
    assert shifted[3] == pytest.approx(0.01)


def _grid(values_by_symbol, months=13):
    return {symbol: [values[k] if k < len(values) else values[-1] for k in range(months)]
            for symbol, values in values_by_symbol.items()}


def test_momentum_top_two_positive_with_ties():
    order = ("AAA", "BBB", "CCC", "DDD")
    base = [100.0] * 13
    closes = {
        "AAA": base[:11] + [110.0, 120.0],  # momentum (k-1 over k-12) 10%, 12-month 20%
        "BBB": base[:11] + [110.0, 105.0],  # 10%, 5%: loses the tie to AAA
        "CCC": base[:11] + [105.0, 200.0],  # 5%
        "DDD": base[:11] + [90.0, 300.0],  # -10%: never held
    }
    live = {symbol: [True] * 13 for symbol in order}
    row = qi.momentum_table(closes, live, order)[12]
    assert {s for s, pick in row.items() if pick.selected} == {"AAA", "BBB"}
    assert row["AAA"].score == pytest.approx(0.1)
    live["AAA"] = [True] * 12 + [False]
    row = qi.momentum_table(closes, live, order)[12]
    assert not row["AAA"].eligible
    assert {s for s, pick in row.items() if pick.selected} == {"BBB", "CCC"}
    assert all(not pick.eligible for pick in qi.momentum_table(closes, live, order)[11].values())


def test_momentum_holds_fewer_when_few_are_positive():
    order = ("AAA", "BBB")
    closes = {"AAA": [100.0] * 11 + [110.0, 110.0], "BBB": [100.0] * 11 + [90.0, 90.0]}
    row = qi.momentum_table(closes, {s: [True] * 13 for s in order}, order)[12]
    assert [s for s, pick in row.items() if pick.selected] == ["AAA"]


def test_season_score_is_the_same_calendar_month_mean():
    months = [f"{2020 + k // 12}-{k % 12 + 1:02d}" for k in range(14)]  # 2020-01 .. 2021-02
    order = ("AAA", "BBB", "CCC")
    closes = {symbol: [100.0] * 14 for symbol in order}
    closes["AAA"][1] = 103.0  # Feb 2020 +3%
    closes["BBB"][1] = 101.0  # +1%
    closes["CCC"][1] = 99.0  # -1%
    live = {symbol: [True] * 14 for symbol in order}
    table = qi.season_table(closes, months, live, order, minimum=1)
    row = table[12]  # 2021-01: the target month is February
    assert row["AAA"].score == pytest.approx(0.03)
    assert {s for s, pick in row.items() if pick.selected} == {"AAA", "BBB"}
    assert not table[0]["AAA"].eligible  # no February yet
    assert all(not pick.eligible for pick in qi.season_table(closes, months, live, order)[12].values())  # minimum 5


def test_season_ties_follow_symbol_order():
    months = [f"{2020 + k // 12}-{k % 12 + 1:02d}" for k in range(13)]  # 2020-01 .. 2021-01
    order = ("AAA", "BBB", "CCC")
    closes = {symbol: [100.0] + [101.0] * 12 for symbol in order}  # Feb 2020 +1% for all
    row = qi.season_table(closes, months, {s: [True] * 13 for s in order}, order, minimum=1)[12]
    assert [s for s, pick in row.items() if pick.selected] == ["AAA", "BBB"]


def test_window_spans():
    assert qi.window_spans([False, True, True, False, True]) == [(1, 2), (4, 4)]
    assert qi.window_spans([]) == []


def _facts():
    starts = {idea: {symbol: "2010-01-29" for symbol in qi.CORE7} for idea in (
        "qc-asset-class-trend", "qc-futures-trend-carry", "qc-momentum-rotation", "qc-same-month-seasonality")}
    starts["qc-gold-fed-model"] = {"GLD": "2010-01-29"}
    starts["qc-oil-predicts-equity"] = {"SPY": "2011-05-31", "QQQ": "2011-05-31"}
    dates = {symbol: "2005-01-03" for symbol in qi.CORE7}
    return qi.Facts(iv_start=dates, iv_rank_join=dates, starts=starts, gold_last_input="2026-09-30")


def test_family_has_the_32_pre_registered_runs():
    runs = qi.family(_facts())
    counted = [key for key, run in runs.items() if run.counted]
    assert len(counted) == 32
    for idea in qi.IDEAS:
        assert idea.spec == f"docs/specs/strategies/{idea.id}.md"
        for _, key in idea.runs:
            assert key in runs
        for gate in idea.gates:
            assert runs[gate.after].counted
            assert gate.before in runs
    for run in runs.values():
        for leg in run.legs:
            filters = leg.definition.get("filters", [])
            sig.normalize_definition({**leg.definition, "filters": [f for f in filters if not qi.is_derived(f)]})
            for item in filter(qi.is_derived, filters):
                sig._normalize_condition(item["condition"])
            parse_options(leg.definition["options"])
    assert sum(len(idea.runs) for idea in qi.IDEAS) == 37  # 32 distinct counted runs, some shared


def test_runs_follow_the_specs():
    runs = qi.family(_facts())
    assert runs["S2"].start == runs["S3"].start == "2006-07-17"
    assert runs["S1"].start == runs["S0"].start
    assert not runs["S0@2006-07-17"].counted
    assert {leg.symbol for leg in runs["D0"].legs} == set(qi.CORE7)
    assert all(leg.cadence == "daily" and leg.policy == "flat" for leg in runs["D3"].legs)
    assert runs["gold-fed-model/A"].legs[0].end == "2026-09-30"
    assert runs["gold-fed-model/B"].legs[0].end is None
    assert [leg.shift for leg in runs["opex-week/A"].legs] == [1] * 4
    assert [leg.shift for leg in runs["opex-week/A-L"].legs] == [0] * 4
    futures = runs["futures-trend-carry/A"].legs
    assert {leg.definition["options"]["structure"] for leg in futures} == {"callDebitVertical", "putDebitVertical"}
    assert {leg.definition["options"]["structure"] for leg in runs["futures-trend-carry/A-L"].legs} == {
        "callDebitVertical"}
    assert all(leg.frame == "monthly" for leg in runs["asset-class-trend/A"].legs)
    assert runs["asset-class-trend/B"].start == runs["asset-class-trend/A"].start
    assert qi.PUT_CREDIT["exitDte"] == 21 and qi.HOST_CALL["exitDte"] == 5
    assert "exitDte" not in qi.MONTHLY_CALL and "profitTakePct" not in qi.CALENDAR_CALL


def test_contango_bound_is_strict():
    assert qi.CONTANGO_MAX < 1.0
    assert qi.CONTANGO_MAX == math.nextafter(1.0, 0.0)
    assert 0.9999999999 <= qi.CONTANGO_MAX


def test_shifted_legs_only_read_the_calendar():
    window = {"type": "calendarWindow", "window": "opexWeek"}
    qi.Leg("SPY", qi.definition("ok", qi.CALENDAR_CALL, filters=[window]), "window", "2024-01-01", shift=1)
    bad = [
        qi.definition("price", qi.CALENDAR_CALL, filters=[window], entry=[qi.condition(qi.CLOSE, ">", qi.indicator("sma", 3))]),
        qi.definition("series", qi.CALENDAR_CALL, filters=[window, qi.series_filter("VIX", "<", 20)]),
        qi.definition("gate", qi.CALENDAR_CALL, filters=[window, qi.GATES["ivRank"]]),
        qi.definition("exit", qi.CALENDAR_CALL, filters=[window], exit=[qi.condition(qi.CLOSE, "<", qi.const(1))]),
        qi.definition("none", qi.CALENDAR_CALL),
    ]
    for definition in bad:
        with pytest.raises(ValueError, match="calendarWindow"):
            qi.Leg("SPY", definition, "window", "2024-01-01", shift=1)
    with pytest.raises(ValueError):
        qi.Leg("SPY", qi.definition("ok", qi.CALENDAR_CALL, filters=[window]), "roll", "2024-01-01", shift=1)
