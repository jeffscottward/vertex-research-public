"""qc-ports ideas: the pre-registered runs as pure DSL definitions, and the report's regression table."""
import json
import math

import pytest

from nautilus_backtest import signals as sig
from strategies.qc_ports import ideas as qi
from strategies.qc_ports.book import parse_options


def test_ols_by_hand():
    a0, a1, t = qi.ols([0, 1, 2, 3], [1, 3, 2, 5])
    assert (a0, a1) == (pytest.approx(1.1), pytest.approx(1.1))
    assert t == pytest.approx(1.1 / math.sqrt(2.7 / 2 / 5))
    assert qi.ols([0, 1, 2], [1, 3, 5])[2] is None  # exact fit: no standard error
    with pytest.raises(ValueError):
        qi.ols([1, 1, 1], [1, 2, 3])
    with pytest.raises(ValueError):
        qi.ols([1, 2], [1, 2])


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
    assert qi.oil_predictions([100.0, None, 99.0, 108.9, 119.79], equity, [0.0] * 5, window=3) == {}


def _facts():
    starts = {idea: {symbol: "2010-01-29" for symbol in qi.CORE7} for idea in (
        "qc-asset-class-trend", "qc-futures-trend-carry", "qc-momentum-rotation", "qc-same-month-seasonality")}
    starts["qc-gold-fed-model"] = {"GLD": "2010-01-29"}
    starts["qc-oil-predicts-equity"] = {"SPY": "2011-05-31", "QQQ": "2011-05-31"}
    dates = {symbol: "2005-01-03" for symbol in qi.CORE7}
    return qi.Facts(iv_start=dates, iv_rank_join=dates, starts=starts, gold_last_input="2026-09-30")


def test_family_has_the_32_pre_registered_runs_as_valid_definitions():
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
        sig.normalize_definition(run.definition)
        parse_options(run.definition["options"])
        for leg in run.definition["portfolio"].get("legs", ()):
            parse_options(leg["options"])
        # Pure DSL: every series a run reads is a product series id or a member-relative ref.
        assert "qc:" not in json.dumps(run.definition)
    for made in qi.ELIGIBILITY.values():
        sig.normalize_definition(made)
    assert sum(len(idea.runs) for idea in qi.IDEAS) == 37  # 32 distinct counted runs, some shared


def test_runs_follow_the_specs():
    runs = qi.family(_facts())
    assert runs["S2"].start == runs["S3"].start == "2006-07-17"
    assert runs["S1"].start == runs["S0"].start
    assert not runs["S0@2006-07-17"].counted
    assert runs["D0"].symbols == qi.CORE7
    assert runs["D3"].definition["portfolio"] == {"symbols": list(qi.CORE7), "policy": "flat", "cadence": "daily"}
    assert runs["opex-week/A"].definition["portfolio"]["shift"] == 1
    assert "shift" not in runs["opex-week/A-L"].definition["portfolio"]
    futures = runs["futures-trend-carry/A"].definition
    assert futures["options"]["structure"] == "callDebitVertical"
    assert [leg["options"]["structure"] for leg in futures["portfolio"]["legs"]] == ["putDebitVertical"]
    assert "legs" not in runs["futures-trend-carry/A-L"].definition["portfolio"]
    assert runs["asset-class-trend/A"].definition["portfolio"]["frame"] == "monthly"
    assert runs["asset-class-trend/B"].start == runs["asset-class-trend/A"].start == "2010-01-29"
    assert runs["oil-predicts-equity/A"].symbols == ("SPY", "QQQ")
    assert runs["momentum-rotation/A"].definition["portfolio"]["select"]["top"] == 2
    assert runs["iv-rank-gate/A"].start == "2005-01-03"
    assert qi.PUT_CREDIT["exitDte"] == 21 and qi.HOST_CALL["exitDte"] == 5
    assert "exitDte" not in qi.MONTHLY_CALL and "profitTakePct" not in qi.CALENDAR_CALL


def test_trend_rule_expressions_follow_the_spec_formula():
    assert qi.TREND["op"] == "div" and qi.TREND["left"] == qi.change(qi.series("$future"), 252)
    assert qi.TREND["right"]["right"] == qi.const(math.sqrt(252))
    assert qi.CARRY == qi.math_expr("sub", qi.change(qi.series("$tr"), 252), qi.change(qi.series("$future"), 252))
    assert qi.OIL_FORECAST["lag"] == 1 and qi.OIL_FORECAST["length"] == 60
    assert qi.SEASON == qi.seasonal(qi.change(qi.CLOSE, 1), 1, 5)
    assert qi.series("IRX", 1) == {"type": "series", "series": "IRX", "offset": 1}
    assert "offset" not in qi.change(qi.CLOSE, 12)


def test_contango_bound_is_strict():
    assert qi.CONTANGO_MAX < 1.0
    assert qi.CONTANGO_MAX == math.nextafter(1.0, 0.0)
    assert 0.9999999999 <= qi.CONTANGO_MAX


def test_shifted_windows_only_read_the_calendar():
    window = {"type": "calendarWindow", "window": "opexWeek"}
    book = qi.portfolio(["SPY"], "window", shift=1)
    sig.normalize_definition(qi.definition("ok", qi.CALENDAR_CALL, filters=[window], book=book))
    bad = [
        qi.definition("price", qi.CALENDAR_CALL, filters=[window], book=book,
                      entry=[qi.condition(qi.CLOSE, ">", qi.indicator("sma", 3))]),
        qi.definition("series", qi.CALENDAR_CALL, filters=[window, qi.series_filter("VIX", "<", 20)], book=book),
        qi.definition("exit", qi.CALENDAR_CALL, filters=[window], book=book,
                      exit=[qi.condition(qi.CLOSE, "<", qi.const(1))]),
        qi.definition("none", qi.CALENDAR_CALL, book=book),
    ]
    for made in bad:
        with pytest.raises(ValueError):
            sig.normalize_definition(made)
    with pytest.raises(ValueError):
        sig.normalize_definition(qi.definition("ok", qi.CALENDAR_CALL, filters=[window],
                                               book=qi.portfolio(["SPY"], "roll", shift=1)))
