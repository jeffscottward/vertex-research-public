"""Python signals and costs match the TypeScript engine (golden fixtures).

The fixture comes from `bun scripts/research-nautilus-golden.ts`. Floats must agree within a
relative and absolute tolerance of 1e-12 (NaN equals NaN); signals and masks must be equal.
This suite does not import nautilus_trader.
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import date, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from nautilus_backtest import costs as cost_model
from nautilus_backtest import signals as sig
from nautilus_backtest.bars import (
    STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED,
    STRATEGY_INTRADAY_DAILY_UNSUPPORTED,
    STRATEGY_INTRADAY_GRID_MISALIGNED,
    STRATEGY_OPTIONS_UNSUPPORTED,
    Bars,
    InputError,
    SectorQuadrantDataError,
    SeriesDataError,
    StrategyUnsupportedError,
)

FIXTURE = Path(__file__).parent / "fixtures" / "nautilus_backtest" / "golden.json"


@cache
def golden() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


@cache
def bars_of(symbol: str, count: int | None = None) -> Bars:
    columns = golden()["bars"][symbol]
    if count is not None:
        columns = {key: values[:count] for key, values in columns.items()}
    return Bars.from_columns(columns)


def _same(actual: float | None, expected: float | None) -> bool:
    actual_nan = actual is None or actual != actual
    expected_nan = expected is None or expected != expected
    if actual_nan or expected_nan:
        return actual_nan and expected_nan
    return math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12)


def assert_series(actual: Any, expected: Any, label: str) -> None:
    assert len(actual) == len(expected), label
    for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
        assert _same(left, right), f"{label} at {index}: {left!r} != {right!r}"


def _ids(items: list[dict[str, Any]], *keys: str) -> list[str]:
    return [":".join(str(item.get(key)) for key in keys) for item in items]


INDICATORS = golden()["indicators"]
SOURCED = {
    "ema": sig.exponential_mean,
    "highest": lambda values, n: sig.prior_extreme(values, n, 1),
    "lowest": lambda values, n: sig.prior_extreme(values, n, -1),
    "realizedVol": sig.realized_volatility,
    "rollingMean": sig.rolling_mean,
    "rsi": sig.relative_strength,
    "sma": sig.rolling_mean,
    "wilderRsi": sig.wilder_rsi,
    "zscore": sig.rolling_zscore,
}


@pytest.mark.parametrize(
    "case", INDICATORS, ids=_ids(INDICATORS, "symbol", "name", "length", "source")
)
def test_indicator_matches_typescript(case: dict[str, Any]) -> None:
    bars = bars_of(case["symbol"], case["bars"])
    name = case["name"]
    length = case["length"]
    if name in SOURCED:
        values = bars.c if case["source"] == "close" else bars.h
        actual = SOURCED[name](values, length)
    elif name == "atr":
        actual = sig.average_true_range_dsl(bars, length)
    elif name == "adx":
        actual = sig.average_directional_index(bars, length)
    elif name == "rvol":
        assert bars.v is not None
        actual = sig.relative_volume_at_time(bars.t, bars.v, length)
    elif name == "costAtr":
        actual = cost_model.average_true_range(bars.h, bars.l, bars.c, length)
    else:
        raise AssertionError(f"unknown fixture indicator {name}")
    assert_series(actual, case["values"], f"{case['symbol']} {name}({length})")


COMPILED = golden()["compiled"]


def _series_input(case: dict[str, Any], symbol_key: str = "symbol") -> tuple[Any, Any, Any]:
    """The context, traded symbol and calendar of a fixture case."""
    calendar = case.get("calendar")
    return (
        golden()["series"],
        case.get("seriesSymbol", case.get(symbol_key)),
        None if calendar is None else golden()["calendars"][calendar],
    )


@pytest.mark.parametrize("case", COMPILED, ids=_ids(COMPILED, "id", "symbol", "calendar"))
def test_compiled_strategy_matches_typescript(case: dict[str, Any]) -> None:
    context, symbol, calendar = _series_input(case)

    def compile_case() -> sig.Compiled:
        return sig.compile_strategy(
            bars_of(case["symbol"]), case["definition"], golden()["sectorQuadrants"],
            context, symbol, calendar,
        )

    if "refused" in case:
        with pytest.raises(StrategyUnsupportedError) as raised:
            compile_case()
        assert raised.value.code == case["refused"]["code"]
        assert str(raised.value) == case["refused"]["message"]
        return
    if "error" in case:
        with pytest.raises(InputError) as failed:
            compile_case()
        assert not isinstance(failed.value, StrategyUnsupportedError)
        assert str(failed.value) == case["error"]
        return
    compiled = compile_case()
    assert list(compiled.signals) == case["signals"]
    assert list(compiled.exits or ()) == case["exits"]
    assert compiled.options == case.get("options")
    assert compiled.portfolio == case.get("portfolio")
    for name, actual, expected in (
        ("stopDistance", compiled.stop_distance, case["stopDistance"]),
        ("targetDistance", compiled.target_distance, case["targetDistance"]),
    ):
        if expected is None:
            assert actual is None, name
        else:
            assert actual is not None, name
            assert_series(actual, expected, name)


EXPRESSIONS = golden()["expressions"]


@pytest.mark.parametrize("case", EXPRESSIONS, ids=_ids(EXPRESSIONS, "id", "dataset"))
def test_expression_values_match_typescript(case: dict[str, Any]) -> None:
    context, symbol, calendar = _series_input(case)
    bars = bars_of(case["dataset"])
    if "error" in case:
        with pytest.raises(InputError) as failed:
            sig.expression_values(bars, case["expr"], context, symbol, calendar)
        assert str(failed.value) == case["error"]
        return
    values = sig.expression_values(bars, case["expr"], context, symbol, calendar)
    assert_series(values, case["values"], case["id"])


SERVER_REFUSALS = golden()["serverRefusals"]


@pytest.mark.parametrize("case", SERVER_REFUSALS, ids=_ids(SERVER_REFUSALS, "id"))
def test_server_refusal_matches_typescript(case: dict[str, Any]) -> None:
    definition = sig.normalize_definition(case["definition"])
    refusal = sig.server_refusal(definition, case.get("timeframe"), case.get("support"))
    if case["refusal"] is None:
        assert refusal is None
        return
    assert refusal is not None
    assert refusal.code == case["refusal"]["code"]
    assert str(refusal) == case["refusal"]["message"]


REFUSALS = golden()["engineRefusals"]


@pytest.mark.parametrize("case", REFUSALS, ids=_ids(REFUSALS, "id", "symbol"))
def test_plan_run_refuses_like_the_typescript_server_engine(case: dict[str, Any]) -> None:
    spec = {"rule": {"kind": "dsl", "definition": case["definition"]}, "costBps": 10, "costs": None,
            "sectorQuadrants": golden()["sectorQuadrants"], "timeframe": case.get("timeframe")}
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.plan_run(bars_of(case["symbol"]), spec, case.get("support"))
    assert raised.value.code == case["code"]
    assert str(raised.value) == case["message"]


def _bar_dates(path: Path) -> list[str]:
    with path.open() as handle:
        return [line.split(",", 1)[0] for line in handle.read().splitlines()[1:] if line]


REPO = Path(__file__).resolve().parents[3]


def _assert_calendar_matches_research(dates: list[str], last: date) -> None:
    """The DSL trading days equal qc_ports TradingCalendar over the bar dates, and outside them
    the qc_ports holiday rules plus the special closures, from 1998 to `last`."""
    from strategies.qc_ports.calendar import TradingCalendar, is_nyse_holiday

    calendar = TradingCalendar(dates)
    closures = {date.fromisoformat(item) for item in sig.NYSE_SPECIAL_CLOSURES}
    first = date(1998, 1, 1)
    for offset in range((last - first).days + 1):
        day = first + timedelta(days=offset)
        if calendar.first <= day <= calendar.last:
            expected = calendar.is_trading_day(day)
        else:
            expected = day.weekday() < 5 and not is_nyse_holiday(day) and day not in closures
        assert sig.is_nyse_trading_day((day - sig.EPOCH_DAY).days) == expected, day


def test_nyse_holidays_match_typescript_and_the_research_calendar() -> None:
    expected = golden()["nyseHolidays"]
    actual = [
        (sig.EPOCH_DAY + timedelta(days=day)).isoformat()
        for year in range(1998, 2036)
        for day in sorted(sig.nyse_holidays(year))
    ]
    assert actual == expected
    assert set(sig.NYSE_SPECIAL_CLOSURES) <= set(expected)
    # SPY bar dates 2015-2024 in the repo (2018-12-05 has no bar).
    _assert_calendar_matches_research(
        _bar_dates(REPO / "tests" / "fixtures" / "golden" / "SPY-1d.csv"), date(2035, 12, 31)
    )


def test_nyse_calendar_matches_the_real_spy_bar_dates() -> None:
    """Over the local qc-ports data (SPY since 1993, when present), every SPY bar date trades and
    every weekday without a bar is a holiday or special closure."""
    from strategies.qc_ports.data import DATA_ENV, DEFAULT_ROOT

    root = Path(os.environ.get(DATA_ENV, DEFAULT_ROOT))
    if not (root / "SPY.csv").exists():
        pytest.skip("qc-ports data not present")
    dates = [item for item in _bar_dates(root / "SPY.csv") if item >= "1998-01-01"]
    _assert_calendar_matches_research(dates, date.fromisoformat(dates[-1]))


FIXED = golden()["fixedRules"]


@pytest.mark.parametrize("case", FIXED, ids=_ids(FIXED, "id", "symbol"))
def test_fixed_rule_signals_match_typescript(case: dict[str, Any]) -> None:
    assert list(sig.compile_rule(bars_of(case["symbol"]), case["rule"])) == case["signals"]


COSTS = golden()["costs"]


@pytest.mark.parametrize("case", COSTS, ids=_ids(COSTS, "id"))
def test_costs_match_typescript(case: dict[str, Any]) -> None:
    profile = case["profile"]
    if case["id"] in cost_model.COST_PROFILE_PRESETS:
        assert cost_model.COST_PROFILE_PRESETS[case["id"]] == profile
    for row in case["charges"]:
        commission, fees = cost_model.order_charges(
            profile, row["side"], row["units"], row["price"]
        )
        assert _same(commission, row["commission"]), row
        assert _same(fees, row["fees"]), row
    for row in case["fills"]:
        atr = math.nan if row["atr"] is None else row["atr"]
        fill = cost_model.fill_costs(profile, row["side"], row["units"], row["quote"], atr)
        for key in ("price", "spread", "slippage", "commission", "fees"):
            assert _same(getattr(fill, key), row[key]), (key, row)
    for row in case["affordable"]:
        units = cost_model.affordable_units(profile, row["cash"], row["fill"], row["scale"])
        assert _same(units, row["units"]), row


def test_cost_fixture_covers_sell_scale_down() -> None:
    wide = next(case for case in COSTS if case["id"] == "custom-wide")
    scaled = [
        row
        for row in wide["fills"]
        if row["side"] == "sell" and row["units"] > 0 and row["quote"] == 0.04
    ]
    assert scaled and all(row["price"] == 0 for row in scaled)


ENGINE = golden()["engine"]


@pytest.mark.parametrize("case", ENGINE, ids=_ids(ENGINE, "id"))
def test_plan_run_matches_typescript_options(case: dict[str, Any]) -> None:
    spec = case["spec"]
    compiled, options = sig.plan_run(bars_of(case["symbol"]), spec)
    assert len(compiled.signals) == len(case["equity"])
    assert options.cost_bps == spec["costBps"]
    assert options.costs == spec["costs"]
    rule = spec["rule"]
    if rule["kind"] == "dsl":
        assert compiled.exits is not None
        expected = sig.compile_strategy(
            bars_of(case["symbol"]), rule["definition"], spec["sectorQuadrants"]
        )
        assert compiled.signals == expected.signals
        assert compiled.exits == expected.exits
        for actual, wanted in (
            (compiled.stop_distance, expected.stop_distance),
            (compiled.target_distance, expected.target_distance),
        ):
            assert (actual is None) == (wanted is None)
            if actual is not None:
                assert_series(actual, wanted, "distance")
    else:
        assert compiled.exits is None
        assert options.stop_loss_pct == spec["stopLossPct"]
        assert options.take_profit_pct == spec["takeProfitPct"]


def test_plan_run_atr_expansion_uses_definition_levels() -> None:
    case = next(c for c in ENGINE if c["id"] == "template:atrExpansion:custom-atr:SPY")
    compiled, options = sig.plan_run(bars_of("SPY"), case["spec"])
    assert options.risk_pct == 1
    assert options.stop_loss_pct == 0 and options.take_profit_pct == 0
    assert compiled.stop_distance is not None and compiled.target_distance is not None
    assert options.max_hold_bars is None


def test_plan_run_passes_max_hold_bars_for_dsl_rules() -> None:
    """Setup replay sends maxHoldBars (the runStrategyDefinition time exit) with a DSL rule."""
    spec = next(c for c in ENGINE if c["id"] == "template:atrExpansion:custom-atr:SPY")["spec"]
    _, options = sig.plan_run(bars_of("SPY"), {**spec, "maxHoldBars": 7})
    assert options.max_hold_bars == 7
    with pytest.raises(InputError, match="maxHoldBars must be a whole number of at least 1"):
        sig.plan_run(bars_of("SPY"), {**spec, "maxHoldBars": 0})


def test_schema_defaults_are_applied() -> None:
    normalized = sig.normalize_definition(
        {
            "version": 1,
            "name": "x",
            "entry": {
                "all": [
                    {
                        "left": {"type": "indicator", "name": "sma", "length": 3},
                        "op": ">",
                        "right": {"type": "const", "value": 1},
                    }
                ]
            },
            "filters": [{"type": "sectorQuadrant", "sector": "XLK", "quadrants": ["leading"]}],
        }
    )
    assert normalized["exit"] == {"any": []}
    assert normalized["sizing"] == {"mode": "allIn"}
    assert normalized["stopLoss"] == {"kind": "none"}
    assert normalized["takeProfit"] == {"kind": "none"}
    assert normalized["entry"]["all"][0]["left"]["source"] == "close"
    assert normalized["filters"][0]["timeframe"] == "weekly"


def _definition(left: dict[str, Any], op: str = ">") -> dict[str, Any]:
    return {
        "version": 1,
        "name": "x",
        "entry": {"all": [{"left": left, "op": op, "right": {"type": "const", "value": 0}}]},
    }


SPY_SMA = {"type": "indicator", "name": "sma", "length": 3}


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (lambda: sig.compile_rule(Bars.from_columns({k: [1] for k in "tohlc"}), {"kind": "smaCross", "fast": 1, "slow": 2}), "At least 2 bars needed"),
        (lambda: sig.compile_rule(Bars.from_columns({"t": [1, 2], "o": [1], "h": [1, 2], "l": [1, 2], "c": [1, 2]}), {"kind": "smaCross", "fast": 1, "slow": 2}), "Bar columns must have equal length"),
        (lambda: sig.compile_rule(bars_of("SPY"), {"kind": "smaCross", "fast": 0, "slow": 2}), "fast must be an integer from 1 to 500"),
        (lambda: sig.compile_rule(bars_of("SPY"), {"kind": "smaCross", "fast": 5, "slow": 5}), "fast must be shorter than slow"),
        (lambda: sig.compile_rule(bars_of("SPY"), {"kind": "breakout", "entryLookback": 2.5, "exitLookback": 2, "trendSma": 0}), "entryLookback must be an integer from 1 to 500"),
        (lambda: sig.compile_rule(bars_of("SPY"), {"kind": "rsiReversion", "period": 14, "oversold": -1, "overbought": 70}), "oversold must be from 0 to 100"),
        (lambda: sig.compile_rule(bars_of("SPY"), {"kind": "rsiReversion", "period": 14, "oversold": 70, "overbought": 30}), "oversold must be below overbought"),
        (lambda: sig.plan_run(bars_of("SPY"), {"rule": {"kind": "smaCross", "fast": 1, "slow": 2}, "stopLossPct": 100, "takeProfitPct": 0, "costBps": 0, "costs": None}), "stopLossPct must be from 0 to 99"),
        (lambda: sig.plan_run(bars_of("SPY"), {"rule": {"kind": "smaCross", "fast": 1, "slow": 2}, "stopLossPct": 0, "takeProfitPct": 0, "costBps": 501, "costs": None}), "costBps must be from 0 to 500"),
        (lambda: sig.plan_run(bars_of("SPY"), {"rule": {"kind": "smaCross", "fast": 1, "slow": 2}, "stopLossPct": 0, "takeProfitPct": 0, "costBps": 0, "costs": {"profile": cost_model.ZERO_COST_PROFILE, "capital": 0}}), "capital must be above 0"),
        (lambda: sig.compile_strategy(bars_of("gap"), _definition({**SPY_SMA, "length": 50})), "sma length 50 is longer than the 12 bars"),
        (lambda: sig.compile_strategy(Bars.from_columns({k: [1, 2] for k in "tohlc"}), _definition({"type": "indicator", "name": "rvol", "length": 1})), "rvol needs bar volume"),
        (lambda: sig.compile_strategy(bars_of("SPY"), _definition({"type": "indicator", "name": "macd", "length": 3})), "Unknown indicator: macd"),
        (lambda: sig.compile_strategy(bars_of("SPY"), _definition(SPY_SMA, op="==")), "Unknown operator: =="),
    ],
)
def test_input_errors(call: Any, message: str) -> None:
    with pytest.raises(InputError) as raised:
        call()
    assert str(raised.value) == message


def test_sector_quadrant_data_error() -> None:
    definition = {
        **_definition(SPY_SMA),
        "filters": [{"type": "sectorQuadrant", "sector": "XLF", "quadrants": ["leading"]}],
    }
    with pytest.raises(SectorQuadrantDataError) as raised:
        sig.compile_strategy(bars_of("SPY"), definition, {})
    assert str(raised.value) == "Sector quadrant data is not available for XLF (weekly)"
    assert isinstance(raised.value, InputError)


def test_risk_pct_option_is_checked() -> None:
    from nautilus_backtest.bars import assert_signal_options

    with pytest.raises(InputError, match="riskPct must be above 0 and at most 100"):
        assert_signal_options(
            2, [0, 0], cost_bps=0, stop_loss_pct=0, take_profit_pct=0, costs=None, risk_pct=0
        )


def test_bars_window_is_a_batch_case_slice() -> None:
    bars = Bars.from_columns({"t": [1, 2, 3, 4], "o": [1, 2, 3, 4], "h": [2, 3, 4, 5], "l": [1, 1, 2, 3],
                              "c": [2, 3, 4, 5], "v": [10, None, 30, 40]})
    window = bars.window(1, 3)
    assert window.t == (2.0, 3.0)
    assert window.c == (3.0, 4.0)
    assert window.v is not None and math.isnan(window.v[0]) and window.v[1] == 30.0
    no_volume = Bars.from_columns({k: [1, 2] for k in "tohlc"})
    assert no_volume.window(0, 2).v is None
    for first, end in ((2, 2), (-1, 2), (0, 5)):
        with pytest.raises(InputError, match="is outside the"):
            bars.window(first, end)


# ---------------------------------------------------------------------------------------------
# Series and calendar filters, options block (mirrors strategy-dsl*.test.ts).


def _weekdays(start: str, end: str, skip: tuple[str, ...] = ()) -> list[str]:
    first = date.fromisoformat(start)
    days = (date.fromisoformat(end) - first).days
    out = []
    for offset in range(days + 1):
        day = first + timedelta(days=offset)
        if day.weekday() < 5 and day.isoformat() not in skip:
            out.append(day.isoformat())
    return out


def _bars_on(dates: list[str]) -> Bars:
    t = [(date.fromisoformat(d) - date(1970, 1, 1)).days * 86_400_000 for d in dates]
    c = [100 + index for index in range(len(dates))]
    return Bars.from_columns({"t": t, "o": c, "h": c, "l": c, "c": c})


ALWAYS = {"left": {"type": "price", "field": "close"}, "op": ">", "right": {"type": "const", "value": 0}}


def _filtered(*filters: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"version": 1, "name": "x", "entry": {"all": [ALWAYS]}, "filters": list(filters), **extra}


def test_new_filter_defaults_are_applied_and_idempotent() -> None:
    definition = _filtered(
        {"type": "ivRank", "max": 30},
        {"type": "vixTermStructure", "maxRatio": 1},
        {"type": "volRegime", "maxVix": 20, "maxTermRatio": 1},
        {"type": "series", "series": "ES=F", "condition": ALWAYS},
    )
    normalized = sig.normalize_definition(definition)
    assert normalized["filters"][0] == {"type": "ivRank", "length": 252, "max": 30.0}
    assert normalized["filters"][1] == {"type": "vixTermStructure", "maxRatio": 1.0}
    assert normalized["filters"][2]["trendLength"] == 200
    assert normalized["filters"][3]["condition"]["left"]["offset"] == 0
    assert normalized["options"] is None
    assert sig.normalize_definition(normalized) == normalized


def test_iv_rank_series_matches_the_typescript_example() -> None:
    actual = sig.iv_rank_series([1, 3, 2, 2, 2, 2, 5], 3)
    assert_series(actual, [None, None, 50, 0, None, None, 100], "ivRank")


def test_calendar_windows_use_bar_dates_as_the_trading_calendar() -> None:
    dates = _weekdays("2019-03-06", "2019-05-30", ("2019-04-19", "2019-05-27"))
    bars = _bars_on(dates)

    def passing(filter_: dict[str, Any]) -> list[str]:
        signals = sig.compile_strategy(bars, _filtered(filter_)).signals
        return [d for d, s in zip(dates, signals, strict=True) if s == 1]

    opex = passing({"type": "calendarWindow", "window": "opexWeek"})
    assert opex[5:11] == ["2019-03-15", "2019-04-12", "2019-04-15", "2019-04-16", "2019-04-17", "2019-04-18"]
    turn = passing({"type": "calendarWindow", "window": "turnOfMonth", "fromDay": -2, "toDay": 3})
    assert turn[0] == "2019-03-28" and turn[-1] == "2019-05-30" and len(turn) == 11
    assert len(passing({"type": "calendarWindow", "window": "months", "months": [4]})) == 21


def test_options_block_is_passed_through_unchanged() -> None:
    options = {"structure": "callDebitVertical", "dte": {"target": 30, "min": 20}, "widthSigma": 1, "maxLossPct": 1}
    compiled = sig.compile_strategy(
        _bars_on(_weekdays("2024-01-01", "2024-01-05")), _filtered(options=options)
    )
    assert compiled.options == options


SERIES_BARS = _bars_on(_weekdays("2024-01-08", "2024-01-12"))
GC_CLOSE = {"type": "series", "series": "GC=F", "condition": ALWAYS}


@pytest.mark.parametrize(
    ("definition", "context", "symbol", "message"),
    [
        (_filtered({"type": "ivRank"}), None, None, "ivRank needs min, max or both"),
        (_filtered({"type": "vixTermStructure"}), None, None, "vixTermStructure needs minRatio, maxRatio or both"),
        (_filtered({"type": "calendarWindow", "window": "eclipse"}), None, None, "Unknown calendar window: eclipse"),
        (_filtered({"type": "moon"}), None, None, "Unknown filter type: moon"),
        (_filtered({**GC_CLOSE, "series": "BTC"}), None, None, "Unknown series: BTC"),
        (
            _filtered({**GC_CLOSE, "condition": {**ALWAYS, "left": {"type": "indicator", "name": "atr", "length": 3}}}),
            None,
            None,
            sig.SERIES_CLOSE_ONLY,
        ),
        (
            _filtered({**GC_CLOSE, "condition": {**ALWAYS, "right": {"type": "price", "field": "high"}}}),
            None,
            None,
            sig.SERIES_CLOSE_ONLY,
        ),
        (
            _filtered(options={"maxLossPct": 1}, sizing={"mode": "riskPct", "riskPct": 1}, stopLoss={"kind": "pct", "pct": 5}),
            None,
            None,
            "Option strategies size by options.maxLossPct; remove the riskPct sizing",
        ),
        (
            _filtered(options={"maxLossPct": 1}, takeProfit={"kind": "pct", "pct": 5}),
            None,
            None,
            "Option strategies exit by profitTakePct, exitDte and exit conditions; remove the stop loss and take profit",
        ),
        (_filtered({"type": "ivRank", "min": 50}), {}, None, "ivRank needs the traded symbol"),
        (_filtered({"type": "ivRank", "min": 50}), {}, "XLK", "ivRank has no implied-volatility index for XLK"),
        (_filtered(GC_CLOSE), {"GC=F": {"2024-1-8": 1}}, None, "Series GC=F has a date that is not YYYY-MM-DD: 2024-1-8"),
        (
            _filtered({**GC_CLOSE, "condition": {**ALWAYS, "left": {"type": "indicator", "name": "sma", "length": 5}}}),
            {"GC=F": {"2024-01-08": 1}},
            None,
            "sma length 5 is longer than the 1 bars",
        ),
    ],
)
def test_series_filter_input_errors(
    definition: dict[str, Any], context: dict[str, Any] | None, symbol: str | None, message: str
) -> None:
    with pytest.raises(InputError) as raised:
        sig.compile_strategy(SERIES_BARS, definition, None, context, symbol)
    assert str(raised.value) == message


@pytest.mark.parametrize(
    ("filter_", "context", "missing"),
    [
        (GC_CLOSE, None, "GC=F"),
        ({"type": "ivRank", "min": 50}, {}, "VIX"),
        ({"type": "vixTermStructure", "maxRatio": 1}, {"VIX": {}}, "VIX3M"),
        ({"type": "volRegime", "maxVix": 20, "maxTermRatio": 1}, {"VIX": {}, "VIX3M": {}}, "SPY"),
    ],
)
def test_series_data_error(filter_: dict[str, Any], context: dict[str, Any] | None, missing: str) -> None:
    with pytest.raises(SeriesDataError) as raised:
        sig.compile_strategy(SERIES_BARS, _filtered(filter_), None, context, "SPY")
    assert str(raised.value) == f"Series data is not available for {missing}"
    assert isinstance(raised.value, InputError)


def test_series_filter_without_values_blocks_entries() -> None:
    compiled = sig.compile_strategy(SERIES_BARS, _filtered(GC_CLOSE), None, {"GC=F": {"2024-01-08": None}})
    assert compiled.signals == (0, 0, 0, 0, 0)


def test_term_structure_needs_both_values_on_the_bar_date() -> None:
    # Same case as strategy-dsl-compile.test.ts: ratios d0 1, d1 0.9, d3 1.2; none on d2 (VIX3M
    # 0), d4 (VIX3M not finite) and d5 (no VIX).
    dates = _weekdays("2024-01-01", "2024-01-08")
    d0, d1, d2, d3, d4, d5 = dates
    context = {
        "VIX": {d0: 20, d1: 18, d2: 15, d3: 30, d4: 16},
        "VIX3M": {"2023-12-29": 10, d0: 20, d1: 20, d2: 0, d3: 25, d4: math.nan, d5: 20},
    }
    bars = _bars_on(dates)

    def mask(filter_: dict[str, Any]) -> tuple[int, ...]:
        return sig.compile_strategy(bars, _filtered(filter_), None, context).signals

    assert mask({"type": "vixTermStructure", "maxRatio": 1}) == (1, 1, 0, 0, 0, 0)
    assert mask({"type": "vixTermStructure", "minRatio": 1.1}) == (0, 0, 0, 1, 0, 0)


def test_series_filter_has_no_value_before_the_first_series_date() -> None:
    dates = _weekdays("2024-01-08", "2024-01-15")
    compiled = sig.compile_strategy(
        _bars_on(dates),
        _filtered({**GC_CLOSE, "condition": {**ALWAYS, "right": {"type": "const", "value": 100}}}),
        None,
        {"GC=F": {dates[2]: 101}},
    )
    assert compiled.signals == (0, 0, 1, 1, 1, 1)


def test_plan_run_refuses_an_options_block_as_an_equity_strategy() -> None:
    options = {"structure": "putCreditVertical", "dte": {"target": 45, "min": 21}, "widthSigma": 0.5, "maxLossPct": 2}
    spec = {"rule": {"kind": "dsl", "definition": _filtered(options=options)}, "costBps": 0, "costs": None}
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.plan_run(bars_of("SPY"), spec)
    assert raised.value.code == STRATEGY_OPTIONS_UNSUPPORTED
    assert str(raised.value) == (
        "STRATEGY_OPTIONS_UNSUPPORTED: the options block runs in backtest runs and the options"
        " research runner only; paper hand-off, Autopilot and the instant tools refuse it (no"
        ' orders). Remove "options" to test the underlying signals here.'
    )
    assert isinstance(raised.value, InputError)
    # The options research runner compiles it: signals plus the block, unchanged.
    assert sig.compile_strategy(bars_of("SPY"), _filtered(options=options)).options == options


def test_calendar_window_refuses_intraday_bars() -> None:
    hourly = Bars.from_columns(
        {k: [1.0, 2.0] for k in "ohlc"} | {"t": [1_546_300_800_000.0, 1_546_304_400_000.0]}
    )
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.compile_strategy(hourly, _filtered({"type": "calendarWindow", "window": "opexWeek"}))
    assert raised.value.code == STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED


def test_calendar_window_uses_nyse_holidays_not_bar_presence() -> None:
    # Bars on 2019-04-18 (Thursday before Good Friday) and on a Saturday: no bar on the holiday is
    # needed, and the Saturday bar is outside the turn-of-month and opex windows.
    dates = ["2019-04-15", "2019-04-18", "2019-04-20", "2019-04-30", "2019-05-01"]
    bars = _bars_on(dates)

    def mask(filter_: dict[str, Any]) -> tuple[int, ...]:
        return sig.compile_strategy(bars, _filtered(filter_)).signals

    assert mask({"type": "calendarWindow", "window": "opexWeek"}) == (1, 1, 0, 0, 0)
    assert mask({"type": "calendarWindow", "window": "turnOfMonth", "fromDay": -1, "toDay": 1}) == (
        0, 0, 0, 1, 1,
    )
    assert mask({"type": "calendarWindow", "window": "months", "months": [4]}) == (1, 1, 1, 1, 0)


def test_series_filter_carries_a_value_at_most_five_trading_days() -> None:
    dates = _weekdays("2024-01-08", "2024-01-22")
    compiled = sig.compile_strategy(
        _bars_on(dates),
        _filtered({**GC_CLOSE, "condition": {**ALWAYS, "right": {"type": "const", "value": 100}}}),
        None,
        {"GC=F": {dates[0]: 101, dates[8]: 102}},
    )
    # Value of day 0 carried to days 1-5, missing on 6-7, then day 8 and its 2 carried days.
    assert compiled.signals == (1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1)


def test_server_refusal_passes_equity_definitions() -> None:
    plain = sig.normalize_definition(_filtered({"type": "calendarWindow", "window": "opexWeek"}))
    assert sig.server_refusal(plain) is None


def test_plan_run_checks_a_known_timeframe() -> None:
    definition = _filtered({"type": "calendarWindow", "window": "opexWeek"})
    spec = {"rule": {"kind": "dsl", "definition": definition}, "costBps": 0, "costs": None}
    compiled, _ = sig.plan_run(bars_of("SPY"), {**spec, "timeframe": "1d"})
    assert len(compiled.signals) == len(bars_of("SPY").c)
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.plan_run(bars_of("SPY"), {**spec, "timeframe": "5m"})
    assert raised.value.code == STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED


# ---------------------------------------------------------------------------------------------
# DSL extensions (strategy-dsl.ts): indicator timeframe 1d, breaksAbove/breaksBelow,
# oncePerLevel, entry.any, management and maxLeverage. Same cases as strategy-dsl-compile.test.ts.

HOUR = 3_600_000.0
DAY = 86_400_000.0
NAN = math.nan
DAY_HIGH = [12.0, 15.0, 11.0, 14.0, 13.0]
DAY_LOW = [8.0, 9.0, 7.0, 10.0, 6.0]
DAY_CLOSE = [10.0, 14.0, 8.0, 12.0, 9.0]
CLOSE = {"type": "price", "field": "close"}
OPEN = {"type": "price", "field": "open"}


def _ms(year: int, month: int, day: int) -> float:
    return float((date(year, month, day) - date(1970, 1, 1)).days) * DAY


def _session_bars(volume: bool = False) -> Bars:
    """Five session days (17:00 New York, 22:00 UTC in January) of three bars: 22:00 UTC the
    evening before, 10:00 UTC and 21:00 UTC."""
    columns: dict[str, list[float]] = {key: [] for key in "tohlc"}
    for day in range(5):
        start = _ms(2024, 1, 2 + day)
        high, low, close = DAY_HIGH[day], DAY_LOW[day], DAY_CLOSE[day]
        columns["t"] += [start - 2 * HOUR, start + 10 * HOUR, start + 21 * HOUR]
        columns["o"] += [close, close, close]
        columns["h"] += [high - 1, high, high - 1]
        columns["l"] += [low + 1, low + 1, low]
        columns["c"] += [low + 1, high - 1, close]
    if volume:
        columns["v"] = [100.0] * 15
    return Bars.from_columns(columns)


def _per_bar(per_day: list[float]) -> list[float]:
    return [value for value in per_day for _ in range(3)]


def _entry(entry: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"version": 1, "name": "x", "entry": entry, **extra}


def _signals(bars: Bars, entry: dict[str, Any]) -> list[int]:
    return list(sig.compile_strategy(bars, sig.normalize_definition(_entry(entry))).signals)


def _equal_bars(bars: Bars, expr: dict[str, Any], expected: list[float]) -> list[int]:
    """1 on the bars where expr equals expected (NaN: not available); the open carries expected."""
    probe = Bars(t=bars.t, o=tuple(-1.0 if math.isnan(x) else x for x in expected), h=bars.h,
                 l=bars.l, c=bars.c, v=bars.v)
    return _signals(probe, {"all": [{"left": expr, "op": ">=", "right": OPEN},
                                    {"left": expr, "op": "<=", "right": OPEN}]})


def _available(expected: list[float]) -> list[int]:
    return [0 if math.isnan(value) else 1 for value in expected]


def _daily(name: str, length: int, **extra: Any) -> dict[str, Any]:
    return {"type": "indicator", "name": name, "length": length, "timeframe": "1d", **extra}


def test_session_daily_bars_start_at_17_00_new_york() -> None:
    daily, day = sig.session_daily_bars(_session_bars(volume=True))
    assert day == [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]
    assert list(daily.h) == DAY_HIGH
    assert list(daily.l) == DAY_LOW
    assert list(daily.c) == DAY_CLOSE
    assert list(daily.o) == DAY_CLOSE
    assert daily.v == (300.0,) * 5
    assert daily.t[0] == _ms(2024, 1, 2) - 2 * HOUR
    assert sig.session_daily_bars(_session_bars())[0].v is None
    # 21:00 UTC is 17:00 New York in July (a new day) and 16:00 in January (the same day).
    for start, days in ((_ms(2024, 7, 1), [0, 1]), (_ms(2024, 1, 2), [0, 0])):
        pair = Bars.from_columns({"t": [start + 20 * HOUR, start + 21 * HOUR], "o": [5, 6], "h": [5, 6],
                                  "l": [5, 6], "c": [5, 6]})
        assert sig.session_daily_bars(pair)[1] == days


def test_daily_highest_and_lowest_read_day_d() -> None:
    highest = _per_bar([NAN, NAN, 15, 15, 14])
    lowest = _per_bar([NAN, NAN, 8, 7, 7])
    assert _equal_bars(_session_bars(), _daily("highest", 2, source="high"), highest) == _available(highest)
    assert _equal_bars(_session_bars(), _daily("lowest", 2, source="low"), lowest) == _available(lowest)


def test_other_daily_indicators_read_day_d_minus_1() -> None:
    previous_close = _per_bar([NAN, 10, 14, 8, 12])
    mean = _per_bar([NAN, NAN, 12, 11, 10])
    assert _equal_bars(_session_bars(), _daily("sma", 1), previous_close) == _available(previous_close)
    assert _equal_bars(_session_bars(), _daily("sma", 2), mean) == _available(mean)
    shifted = ([NAN] + _per_bar([NAN, 10, 14, 8, 12]))[:15]
    assert _equal_bars(_session_bars(), _daily("sma", 1, offset=1), shifted) == _available(shifted)


def test_daily_series_are_shared_across_conditions() -> None:
    expr = _daily("sma", 1)
    entry = {"all": [
        {"left": expr, "op": ">", "right": {"type": "const", "value": 9}},
        {"left": expr, "op": "<", "right": {"type": "const", "value": 13}},
        {"left": _daily("highest", 1, source="high"), "op": ">", "right": {"type": "const", "value": 0}},
    ]}
    assert _signals(_session_bars(), entry) == _per_bar([0, 1, 0, 0, 1])


def test_daily_length_counts_daily_bars() -> None:
    with pytest.raises(InputError) as raised:
        _equal_bars(_session_bars(), _daily("sma", 6), [NAN] * 15)
    assert str(raised.value) == "sma length 6 is longer than the 5 daily bars"


def _price_bars(open_: list[float], close: list[float]) -> Bars:
    return Bars.from_columns({
        "t": [index * DAY for index in range(len(close))], "o": open_, "c": close,
        "h": [max(a, b) for a, b in zip(open_, close)], "l": [min(a, b) for a, b in zip(open_, close)],
    })


LEVELS = _price_bars([11, 9, 11, 13, 10, 9], [10, 10, 12, 12, 9, 8])


def _one(condition: dict[str, Any]) -> dict[str, Any]:
    return {"all": [condition]}


def test_breaks_compare_the_previous_left_with_the_current_right() -> None:
    assert _signals(LEVELS, _one({"left": CLOSE, "op": "breaksAbove", "right": OPEN})) == [0, 0, 1, 0, 0, 0]
    assert _signals(LEVELS, _one({"left": CLOSE, "op": "crossesAbove", "right": OPEN})) == [0, 1, 0, 0, 0, 0]
    # breaksBelow never holds at bar 0 (close 10 is below open 11 there).
    assert _signals(LEVELS, _one({"left": CLOSE, "op": "breaksBelow", "right": OPEN})) == [0, 0, 0, 0, 1, 1]


def test_breaks_never_hold_on_nan() -> None:
    rising = _price_bars([1, 2, 3, 4], [1, 2, 3, 4])
    zero = {"type": "const", "value": 0}
    sma = {"type": "indicator", "name": "sma", "length": 2}
    assert _signals(rising, _one({"left": sma, "op": "breaksAbove", "right": zero})) == [0, 0, 0, 0]
    assert _signals(rising, _one({"left": CLOSE, "op": "breaksBelow", "right": {**sma, "length": 3}})) == [0] * 4
    assert _signals(rising, _one({"left": zero, "op": "breaksBelow", "right": sma})) == [0, 0, 0, 0]


def test_once_per_level_drops_a_repeat_at_the_same_right_value() -> None:
    bars = _price_bars([10, 10, 10, 10, 12, 12, 12, 12], [9, 11, 9, 11, 9, 13, 9, 13])
    cross = {"left": CLOSE, "op": "crossesAbove", "right": OPEN}
    assert _signals(bars, _one(cross)) == [0, 1, 0, 1, 0, 1, 0, 1]
    assert _signals(bars, _one({**cross, "oncePerLevel": True})) == [0, 1, 0, 0, 0, 1, 0, 0]
    assert _signals(bars, _one({**cross, "oncePerLevel": False, "op": "breaksAbove"})) == [0, 1, 0, 1, 0, 1, 0, 1]


def _above(value: float) -> dict[str, Any]:
    return {"left": CLOSE, "op": ">", "right": {"type": "const", "value": value}}


def _below(value: float) -> dict[str, Any]:
    return {"left": CLOSE, "op": "<", "right": {"type": "const", "value": value}}


def test_entry_any_holds_when_one_condition_holds_and_combines_with_all() -> None:
    ramp = _price_bars([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
    assert _signals(ramp, {"all": [], "any": [_above(3.5), _below(1.5)]}) == [1, 0, 0, 1, 1]
    assert _signals(ramp, {"all": [_above(1.5)], "any": [_above(3.5), _below(1.5)]}) == [0, 0, 0, 1, 1]
    assert _signals(ramp, {"all": [_above(1.5)], "any": []}) == [0, 1, 1, 1, 1]


def test_management_compiles_like_typescript() -> None:
    bars = bars_of("SPY")
    stop = {"kind": "pct", "pct": 2}
    breakeven = sig.normalize_definition(_entry(_one(_above(0)), stopLoss=stop, management={"breakevenR": 1.5}))
    assert sig.compile_strategy(bars, breakeven).management == {"breakevenR": 1.5}
    trail = sig.normalize_definition(_entry(_one(_above(0)), stopLoss=stop, management={
        "trail": {"activateR": 1, "length": 3, "multiple": 2}}))
    compiled = sig.compile_strategy(bars, trail).management
    assert compiled is not None and set(compiled) == {"trail"}
    assert compiled["trail"]["activateR"] == 1 and compiled["trail"]["multiple"] == 2
    assert list(compiled["trail"]["atr"]) == list(sig.average_true_range_dsl(bars, 3))
    assert sig.compile_strategy(bars, sig.normalize_definition(_entry(_one(_above(0))))).management is None


def test_plan_run_passes_max_leverage() -> None:
    definition = _entry(_one(_above(0)), stopLoss={"kind": "pct", "pct": 2},
                        sizing={"mode": "riskPct", "riskPct": 1, "maxLeverage": 20})
    _, options = sig.plan_run(bars_of("SPY"), {"rule": {"kind": "dsl", "definition": definition}, "costBps": 0,
                                               "costs": None})
    assert options.max_leverage == 20
    assert options.risk_pct == 1


BREAKOUT = {"left": CLOSE, "op": "breaksAbove", "oncePerLevel": True,
            "right": _daily("highest", 20, source="high")}
WITH_STOP = {"stopLoss": {"kind": "pct", "pct": 2}}


@pytest.mark.parametrize(
    ("definition", "message"),
    [
        (_entry(_one({**BREAKOUT, "right": {"type": "indicator", "name": "rvol", "length": 5, "timeframe": "1d"}})),
         "rvol has no timeframe; it already compares whole sessions"),
        (_entry(_one({**BREAKOUT, "right": _daily("highest", 20, timeframe="1h")})),
         "Unknown indicator timeframe: 1h"),
        (_entry(_one({**BREAKOUT, "op": ">="})),
         "oncePerLevel works only with crossesAbove, crossesBelow, breaksAbove and breaksBelow"),
        (_entry(_one({**BREAKOUT, "oncePerLevel": 1})), "oncePerLevel must be true or false"),
        (_entry({"all": [], "any": []}), "Entry needs at least one condition in entry.all or entry.any"),
        (_entry(_one(_above(0)), management={"breakevenR": 1}), "management moves the stop loss; add a stop loss"),
        (_entry(_one(_above(0)), management={}, **WITH_STOP), "management needs trail, breakevenR or both"),
        (_entry(_one(_above(0)), management={"breakevenR": 0}, **WITH_STOP),
         "management breakevenR must be above 0 and at most 100"),
        (_entry(_one(_above(0)), management={"trail": {"activateR": 1, "multiple": 2}}, **WITH_STOP),
         "management trail length must be a whole number from 1 to 1000"),
        (_entry(_one(_above(0)), sizing={"mode": "riskPct", "riskPct": 1, "maxLeverage": 0.5}, **WITH_STOP),
         "maxLeverage must be from 1 to 50"),
        (_entry(_one(_above(0)), sizing={"mode": "riskPct", "riskPct": 1, "maxLeverage": 51}, **WITH_STOP),
         "maxLeverage must be from 1 to 50"),
    ],
)
def test_dsl_extension_input_errors(definition: dict[str, Any], message: str) -> None:
    with pytest.raises(InputError) as raised:
        sig.normalize_definition(definition)
    assert str(raised.value) == message


SERIES_CONDITION = {"left": CLOSE, "op": "crossesAbove", "right": {"type": "indicator", "name": "sma", "length": 5}}


@pytest.mark.parametrize(
    ("definition", "message"),
    [
        ({**_entry(_one(_above(0))), "extra": 1}, "Unknown key in definition: extra"),
        (_entry({"all": [_above(0)], "none": []}), "Unknown key in entry: none"),
        ({**_entry(_one(_above(0))), "exit": {"any": [], "all": []}}, "Unknown key in exit: all"),
        (_entry(_one({**_above(0), "note": "x"})), "Unknown key in condition: note"),
        (_entry(_one({**_above(0), "left": {**CLOSE, "timeframe": "1d"}})), "Unknown key in price expression: timeframe"),
        (_entry(_one({**_above(0), "right": {"type": "const", "value": 0, "offset": 1}})),
         "Unknown key in const expression: offset"),
        (_entry(_one({**_above(0), "left": {**SPY_SMA, "period": 3}})), "Unknown key in indicator expression: period"),
        (_entry(_one({**BREAKOUT, "oncePerLevel": None})), "oncePerLevel must be true or false"),
        (_entry(_one(_above(0)), management={"breakevenR": 1, "lock": 1}, **WITH_STOP),
         "Unknown key in management: lock"),
        (_entry(_one(_above(0)), management={"breakevenR": None}, **WITH_STOP),
         "management breakevenR must be above 0 and at most 100"),
        (_entry(_one(_above(0)), management={"trail": None}, **WITH_STOP), "management trail must be an object"),
        (_entry(_one(_above(0)), management={"trail": {"activateR": 1, "length": 14, "multiple": 2, "x": 1}},
                **WITH_STOP), "Unknown key in management trail: x"),
        (_entry(_one(_above(0)), management={"trail": {"activateR": 1, "length": 14.5, "multiple": 2}},
                **WITH_STOP), "management trail length must be a whole number from 1 to 1000"),
        (_entry(_one(_above(0)), management={"trail": {"activateR": 1, "length": True, "multiple": 2}},
                **WITH_STOP), "management trail length must be a whole number from 1 to 1000"),
        (_entry(_one(_above(0)), sizing={"mode": "allIn", "maxLeverage": 2}), "maxLeverage needs riskPct sizing"),
        (_entry(_one(_above(0)), sizing={"mode": "allIn", "riskPct": 1}), "Unknown key in sizing: riskPct"),
        (_entry(_one(_above(0)), sizing={"mode": "riskPct", "riskPct": 1, "cap": 2}, **WITH_STOP),
         "Unknown key in sizing: cap"),
        (_entry(_one(_above(0)), filters=[{"type": "series", "series": "VIX", "condition": {
            **SERIES_CONDITION, "oncePerLevel": True}}]),
         "A series condition takes no oncePerLevel or timeframe: the series has one value per date"),
        (_entry(_one(_above(0)), filters=[{"type": "series", "series": "VIX", "condition": {
            **SERIES_CONDITION, "right": {**SERIES_CONDITION["right"], "timeframe": "1d"}}}]),
         "A series condition takes no oncePerLevel or timeframe: the series has one value per date"),
    ],
)
def test_definition_keys_are_strict_like_the_typescript_schema(definition: dict[str, Any], message: str) -> None:
    with pytest.raises(InputError) as raised:
        sig.normalize_definition(definition)
    assert str(raised.value) == message


def test_trail_length_accepts_a_whole_float_and_normalizing_is_idempotent() -> None:
    definition = _entry({"all": [], "any": [BREAKOUT]}, stopLoss={"kind": "atr", "length": 14, "multiple": 2},
                        sizing={"mode": "riskPct", "riskPct": 1, "maxLeverage": 20},
                        management={"breakevenR": 2, "trail": {"activateR": 1, "length": 14.0, "multiple": 2}},
                        description="LD34")
    normalized = sig.normalize_definition(definition)
    assert normalized["management"]["trail"]["length"] == 14
    assert sig.normalize_definition(normalized) == normalized


# Intraday block, session indicators and volTarget: hand-checked cases (the same numbers as the
# TypeScript "intraday sessions, session indicators, gates and volTarget" tests).

MINUTE_MS = 60_000
DAY_MS_ = 86_400_000
# Monday 2026-01-05 09:30 New York (EST, UTC-5).
NY_0930 = 1_767_623_400_000
INTRADAY = {"timezone": "America/New_York", "open": "09:30", "close": "11:30", "entryFrom": "10:00", "entryTo": "11:00"}
CLOSE = {"type": "price", "field": "close"}
ZERO = {"type": "const", "value": 0}
VWAP = {"type": "indicator", "name": "vwap"}
NAN = math.nan


def _intraday_bars(rows: list[dict[str, float]], volume: bool = True) -> Bars:
    """30-minute bars: slot k of day d opens at 09:30 + 30k minutes; high/low = close +- 1."""
    columns: dict[str, list[float]] = {
        "t": [NY_0930 + row["day"] * DAY_MS_ + row["slot"] * 30 * MINUTE_MS for row in rows],
        "o": [row.get("o", row["c"] - 1) for row in rows],
        "h": [row["c"] + 1 for row in rows],
        "l": [row["c"] - 1 for row in rows],
        "c": [row["c"] for row in rows],
    }
    if volume:
        columns["v"] = [row.get("v", 0) for row in rows]
    return Bars.from_columns(columns)


def _day(day: int, open_: float, closes: list[float], slots: list[int] | None = None) -> list[dict[str, float]]:
    slots = list(range(len(closes))) if slots is None else slots
    return [{"day": day, "slot": slot, "c": c, **({"o": open_} if index == 0 else {})}
            for index, (c, slot) in enumerate(zip(closes, slots, strict=True))]


# Day 2 has no 10:30 bar (slot 1).
FOUR_DAYS = [
    *_day(0, 99, [100, 101, 102, 103]),
    *_day(1, 104, [105, 106, 107, 108]),
    *_day(2, 109, [110, 111, 112], [0, 2, 3]),
    *_day(3, 113, [114, 115, 116, 117]),
]


def test_intraday_sessions_layout_with_an_early_close() -> None:
    bars = _intraday_bars([
        {"day": 0, "slot": -1, "c": 98}, *_day(0, 99, [100, 101, 102, 103]), {"day": 0, "slot": 4, "c": 104},
        *_day(1, 109, [110, 111]),
    ])
    sessions = sig.intraday_sessions(bars, INTRADAY)
    assert sessions is not None
    assert sessions.duration == 30 * MINUTE_MS
    assert sessions.open_ms == 570 * MINUTE_MS
    assert list(sessions.close_ms) == [m * MINUTE_MS for m in (570, 600, 630, 660, 690, 720, 600, 630)]
    assert list(sessions.session) == [-1, 0, 0, 0, 0, -1, 1, 1]
    # Day 1 closes early (10:30): its 10:00-10:30 bar is the last of its session day.
    assert list(sessions.last) == [0, 0, 0, 0, 1, 0, 0, 1]
    assert list(sessions.day_open) == [99, 109]
    assert list(sessions.day_close) == [103, 111]


def test_intraday_sessions_duration_ties_repeats_and_daily_bars() -> None:
    tie = sig.intraday_sessions(_intraday_bars(_day(0, 99, [100, 101, 102], [0, 1, 3])), INTRADAY)
    assert tie is not None and tie.duration == 30 * MINUTE_MS
    repeated = sig.intraday_sessions(_intraday_bars(_day(0, 99, [100, 100, 101, 102], [0, 0, 2, 4])), INTRADAY)
    assert repeated is not None and repeated.duration == 60 * MINUTE_MS
    after_hours = _intraday_bars([{"day": 0, "slot": 4, "c": 100}, {"day": 0, "slot": 5, "c": 101}])
    outside = sig.intraday_sessions(after_hours, INTRADAY)
    assert outside is not None and list(outside.session) == [-1, -1] and list(outside.last) == [0, 0]
    daily = Bars.from_columns({"t": [index * DAY_MS_ for index in range(5)], "o": [1.0] * 5, "h": [1.0] * 5,
                               "l": [1.0] * 5, "c": [1.0] * 5})
    assert sig.intraday_sessions(daily, INTRADAY) is None


VWAP_ROWS = [
    {"day": 0, "slot": -1, "c": 98, "v": 50}, {"day": 0, "slot": 0, "c": 100, "o": 99, "v": 0},
    {"day": 0, "slot": 1, "c": 101, "v": 10}, {"day": 0, "slot": 2, "c": 102, "v": 30},
    {"day": 0, "slot": 3, "c": 103, "v": 0}, {"day": 0, "slot": 4, "c": 104, "v": 5},
    {"day": 1, "slot": 0, "c": 110, "v": 5},
]


def test_vwap_weights_the_typical_price_by_volume_per_session_day() -> None:
    # Typical = close; no volume yet: mean typical 100; then 1010 / 10; (1010 + 3060) / 40 = 101.75.
    assert_series(sig.session_indicator_series(_intraday_bars(VWAP_ROWS), INTRADAY, VWAP),
                  [NAN, 100, 101, 101.75, 101.75, NAN, 110], "vwap")
    assert_series(sig.session_indicator_series(_intraday_bars(VWAP_ROWS, volume=False), INTRADAY, VWAP),
                  [NAN, 100, 100.5, 101, 101.5, NAN, 110], "vwap without volume")


def _session_return(origin: str, to: str, rows: list[dict[str, float]] = FOUR_DAYS) -> Any:
    expr = {"type": "indicator", "name": "sessionReturn", "from": origin, "to": to}
    return sig.session_indicator_series(_intraday_bars(rows), INTRADAY, expr)


def test_session_return_from_open_prev_close_and_a_time() -> None:
    assert_series(_session_return("open", "10:30"), [
        NAN, *[101 / 99 - 1] * 3, NAN, *[106 / 104 - 1] * 3, NAN, NAN, NAN, NAN, *[115 / 113 - 1] * 3,
    ], "open -> 10:30")
    assert_series(_session_return("prevClose", "10:30"), [
        NAN, NAN, NAN, NAN, NAN, *[106 / 103 - 1] * 3, NAN, NAN, NAN, NAN, *[115 / 112 - 1] * 3,
    ], "prevClose -> 10:30")
    assert_series(_session_return("10:00", "11:00"), [
        NAN, NAN, *[102 / 100 - 1] * 2, NAN, NAN, *[107 / 105 - 1] * 2,
        NAN, *[111 / 110 - 1] * 2, NAN, NAN, *[116 / 114 - 1] * 2,
    ], "10:00 -> 11:00")
    # Day 2 has no 10:30 bar: no anchor.
    assert_series(_session_return("10:30", "11:30"), [
        NAN, NAN, NAN, 103 / 101 - 1, NAN, NAN, NAN, 108 / 106 - 1, NAN, NAN, NAN, NAN, NAN, NAN, 117 / 115 - 1,
    ], "10:30 -> 11:30")
    with_after = [
        *_day(0, 99, [100, 101, 102, 103]), {"day": 0, "slot": 4, "c": 104}, *_day(1, 104, [105, 106, 107, 108]),
    ]
    assert_series(_session_return("open", "11:30", with_after),
                  [NAN, NAN, NAN, 103 / 99 - 1, NAN, NAN, NAN, NAN, 108 / 104 - 1], "outside the session")


def _noise_band(rows: list[dict[str, float]], band: str, length: int, multiple: float | None = None) -> Any:
    expr = {"type": "indicator", "name": "noiseBand", "band": band, "length": length,
            **({} if multiple is None else {"multiple": multiple})}
    return sig.session_indicator_series(_intraday_bars(rows), INTRADAY, expr)


def test_noise_band_upper_skips_missing_slots() -> None:
    # Moves |close / open - 1|: day 0 k/99, day 1 k/104, day 2 (slots 0, 2, 3) 1/109, 2/109, 3/109.
    assert_series(_noise_band(FOUR_DAYS, "upper", 1), [
        NAN, NAN, NAN, NAN,
        104 * (1 + 1 / 99), 104 * (1 + 2 / 99), 104 * (1 + 3 / 99), 104 * (1 + 4 / 99),
        109 * (1 + 1 / 104), 109 * (1 + 3 / 104), 109 * (1 + 4 / 104),
        # Day 2 has no slot 1: day 3 reads day 1's move there.
        113 * (1 + 1 / 109), 113 * (1 + 2 / 104), 113 * (1 + 2 / 109), 113 * (1 + 3 / 109),
    ], "upper 1")


def test_noise_band_lower_with_length_and_multiple() -> None:
    assert_series(_noise_band(FOUR_DAYS, "lower", 2, 2), [
        *[NAN] * 8,
        108 * (1 - (1 / 99 + 1 / 104)), 108 * (1 - (3 / 99 + 3 / 104)), 108 * (1 - (4 / 99 + 4 / 104)),
        112 * (1 - (1 / 104 + 1 / 109)), 112 * (1 - (2 / 99 + 2 / 104)),
        112 * (1 - (3 / 104 + 2 / 109)), 112 * (1 - (4 / 104 + 3 / 109)),
    ], "lower 2 x2")


def test_noise_band_never_reads_the_current_day() -> None:
    moved = [{**row, "c": 150} if row["day"] == 1 and row["slot"] == 0 else row for row in FOUR_DAYS]
    before = _noise_band(FOUR_DAYS, "upper", 1, 3)
    after = _noise_band(moved, "upper", 1, 3)
    assert_series(after[:8], before[:8], "days 0 and 1")
    assert math.isclose(after[8], 109 * (1 + 3 * 46 / 104), rel_tol=1e-12)


GATE_ROWS = [
    {"day": 0, "slot": -1, "c": 100}, *_day(0, 100, [100] * 4), {"day": 0, "slot": 4, "c": 100},
    *_day(1, 100, [100] * 2),
]


def _always(**block: Any) -> dict[str, Any]:
    return {"version": 1, "name": "always", "entry": {"all": [{"left": CLOSE, "op": ">", "right": ZERO}]},
            "exit": {"any": [{"left": CLOSE, "op": ">", "right": ZERO}]}, "intraday": {**INTRADAY, **block}}


@pytest.mark.parametrize(("block", "signals", "exits"), [
    ({}, [0, 1, 1, 1, -1, 0, 1, -1], [0, 1, 1, 1, 1, 0, 1, 1]),
    # Day 1's 10:30 bar is its last bar: an exit, not an entry.
    ({"entryFrom": "10:30", "entryTo": "10:30"}, [0, -1, 1, -1, -1, 0, -1, -1], [0, 1, 1, 1, 1, 0, 1, 1]),
    # 60 and 120 minutes after 09:30: the bars closing at 10:30 and 11:30.
    ({"decisionEvery": 60}, [0, 0, 1, 0, -1, 0, 0, -1], [0, 0, 1, 0, 1, 0, 0, 1]),
])
def test_intraday_gates_entry_window_decision_grid_and_close(block, signals, exits) -> None:
    compiled = sig.compile_strategy(_intraday_bars(GATE_ROWS), _always(**block))
    assert list(compiled.signals) == signals
    assert list(compiled.exits or ()) == exits
    assert list(compiled.close_at or ()) == [0, 0, 0, 0, 1, 0, 0, 1]
    assert compiled.leverage is None


def test_intraday_block_on_daily_bars_is_refused() -> None:
    daily = Bars.from_columns({"t": [index * DAY_MS_ for index in range(30)], "o": [1.0] * 30,
                               "h": [1.0] * 30, "l": [1.0] * 30, "c": [1.0] * 30})
    for run in (lambda: sig.compile_strategy(daily, _always()),
                lambda: sig.session_indicator_series(daily, INTRADAY, VWAP)):
        with pytest.raises(StrategyUnsupportedError) as raised:
            run()
        assert raised.value.code == STRATEGY_INTRADAY_DAILY_UNSUPPORTED
    normalized = sig.normalize_definition(_always())
    refusal = sig.server_refusal(normalized, "1d")
    assert refusal is not None and refusal.code == STRATEGY_INTRADAY_DAILY_UNSUPPORTED
    assert sig.server_refusal(normalized, "5m") is None


GRID_TAIL = (
    " is not a whole multiple of the 30-minute bar duration; put every intraday time (minutes since"
    " midnight New York) and decisionEvery on the bar grid."
)


@pytest.mark.parametrize(("block", "field"), [
    ({"open": "09:45"}, "open 09:45"),
    ({"close": "15:50"}, "close 15:50"),
    ({"entryFrom": "10:15"}, "entryFrom 10:15"),
    ({"entryTo": "11:10"}, "entryTo 11:10"),
    ({"decisionEvery": 45}, "decisionEvery 45"),
])
def test_intraday_block_off_the_bar_grid_is_refused(block, field) -> None:
    # 30-minute bars: every time and decisionEvery must be a whole number of 30 minutes.
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.compile_strategy(_intraday_bars(GATE_ROWS), _always(**block))
    assert raised.value.code == STRATEGY_INTRADAY_GRID_MISALIGNED
    assert str(raised.value) == f"{STRATEGY_INTRADAY_GRID_MISALIGNED}: intraday {field}{GRID_TAIL}"


@pytest.mark.parametrize(("origin", "to", "field"), [
    ("prevClose", "10:15", "sessionReturn to 10:15"),
    ("10:15", "11:00", "sessionReturn from 10:15"),
])
def test_session_return_off_the_bar_grid_is_refused(origin, to, field) -> None:
    expr = {"from": origin, "name": "sessionReturn", "to": to, "type": "indicator"}
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.session_indicator_series(_intraday_bars(GATE_ROWS), INTRADAY, expr)
    assert raised.value.code == STRATEGY_INTRADAY_GRID_MISALIGNED
    assert str(raised.value) == f"{STRATEGY_INTRADAY_GRID_MISALIGNED}: intraday {field}{GRID_TAIL}"
    on_grid = {"from": "10:00", "name": "sessionReturn", "to": "11:00", "type": "indicator"}
    assert len(sig.session_indicator_series(_intraday_bars(GATE_ROWS), INTRADAY, on_grid)) == 8


def test_vol_target_leverage_daily_and_per_session_day() -> None:
    sizing = {"length": 2, "maxLeverage": 5, "targetPct": 10}
    first, second = 0.1 / math.sqrt(0.02), 0.1 / math.sqrt(0.005)
    assert math.isclose(first, math.sqrt(0.5), rel_tol=1e-12) and math.isclose(second, math.sqrt(2), rel_tol=1e-12)
    daily = Bars.from_columns({"t": [index * DAY_MS_ for index in range(5)], "o": [100.0] * 5, "h": [111.0] * 5,
                               "l": [98.0] * 5, "c": [100.0, 110.0, 99.0, 99.0, 99.0]})
    # Returns +10%, -10%; then -10%, 0; then 0, 0 (sigma 0: maxLeverage).
    assert_series(sig.vol_target_leverage(daily, sizing), [NAN, NAN, first, second, 5.0], "daily")
    bars = _intraday_bars([*_day(0, 100, [100, 100]), *_day(1, 100, [100, 110]), *_day(2, 100, [100, 99]),
                           {"day": 3, "slot": -1, "c": 90}, *_day(3, 100, [100, 99])])
    expected = [NAN, NAN, NAN, NAN, NAN, first, first, first, second]
    assert_series(sig.vol_target_leverage(bars, sizing, sig.intraday_sessions(bars, INTRADAY)), expected, "sessions")
    assert_series(sig.vol_target_leverage(bars, sizing), expected, "New York dates")
    definition = {"version": 1, "name": "volTarget", "entry": {"all": [{"left": CLOSE, "op": ">", "right": ZERO}]},
                  "intraday": INTRADAY, "sizing": {**sizing, "mode": "volTarget"}}
    assert_series(sig.compile_strategy(bars, definition).leverage, expected, "compiled")


VOL_TARGET = {"mode": "volTarget", "targetPct": 2, "length": 14, "maxLeverage": 4}
OPTIONS = {"structure": "putCreditVertical", "dte": {"min": 21, "target": 45}, "exitDte": 7, "maxLossPct": 2,
           "profitTakePct": 50, "shortDelta": 0.2, "widthSigma": 0.5}
MINIMAL = {
    "version": 1, "name": "Test",
    "entry": {"all": [{"left": CLOSE, "op": ">", "right": {"type": "const", "value": 1}}]},
}


def _with_exit(expr: dict[str, Any]) -> dict[str, Any]:
    return {**MINIMAL, "intraday": INTRADAY, "exit": {"any": [{"left": CLOSE, "op": "<", "right": expr}]}}


def test_intraday_side_and_vol_target_normalize_without_defaults() -> None:
    normalized = sig.normalize_definition({**MINIMAL, "intraday": {**INTRADAY, "decisionEvery": 30},
                                           "side": "short", "sizing": VOL_TARGET})
    assert normalized["intraday"] == {**INTRADAY, "decisionEvery": 30}
    assert normalized["side"] == "short"
    assert normalized["sizing"] == {"mode": "volTarget", "targetPct": 2.0, "length": 14, "maxLeverage": 4.0}
    upper = {"type": "indicator", "name": "noiseBand", "band": "upper", "length": 3}
    plain = sig.normalize_definition(_with_exit(upper))
    assert plain["exit"]["any"][0]["right"] == upper
    assert "decisionEvery" not in plain["intraday"]


@pytest.mark.parametrize(("definition", "message"), [
    ({**MINIMAL, "exit": {"any": [{"left": CLOSE, "op": "<", "right": VWAP}]}},
     "vwap reads the intraday session; add an intraday block"),
    ({**MINIMAL, "exit": {"any": [{
        "left": {"type": "math", "op": "add", "left": CLOSE, "right": CLOSE},
        "op": "<",
        "right": {"type": "math", "op": "sub", "left": CLOSE, "right": VWAP},
    }]}},
     "vwap reads the intraday session; add an intraday block"),
    (_with_exit({"type": "indicator", "name": "sessionReturn", "from": "10:30", "to": "10:30"}),
     "sessionReturn from must be before to"),
    (_with_exit({"type": "indicator", "name": "noiseBand", "band": "middle", "length": 3}),
     "Unknown noiseBand band: middle"),
    (_with_exit({"type": "indicator", "name": "noiseBand", "band": "upper", "length": 61}),
     "noiseBand length must be a whole number from 1 to 60"),
    (_with_exit({"type": "indicator", "name": "noiseBand", "band": "upper", "length": 3, "multiple": 0}),
     "noiseBand multiple must be above 0 and at most 100"),
    ({**MINIMAL, "intraday": {**INTRADAY, "timezone": "UTC"}}, 'intraday timezone must be "America/New_York"'),
    ({**MINIMAL, "intraday": {**INTRADAY, "close": "09:00"}}, "intraday open must be before close"),
    ({**MINIMAL, "intraday": {**INTRADAY, "entryFrom": "09:30"}},
     "The entry window must be inside the session: open < entryFrom <= entryTo < close"),
    ({**MINIMAL, "intraday": {**INTRADAY, "entryTo": "11:30"}},
     "The entry window must be inside the session: open < entryFrom <= entryTo < close"),
    ({**MINIMAL, "intraday": {**INTRADAY, "decisionEvery": 391}},
     "intraday decisionEvery must be a whole number from 1 to 390"),
    ({**MINIMAL, "sizing": {**VOL_TARGET, "targetPct": 0}}, "volTarget targetPct must be above 0 and at most 100"),
    ({**MINIMAL, "sizing": {**VOL_TARGET, "length": 1}}, "volTarget length must be a whole number from 2 to 252"),
    ({**MINIMAL, "sizing": {**VOL_TARGET, "maxLeverage": 51}}, "volTarget maxLeverage must be above 0 and at most 50"),
    ({**MINIMAL, "side": "both"}, "Unknown side: both"),
    ({**MINIMAL, "options": OPTIONS, "sizing": VOL_TARGET},
     "Option strategies size by options.maxLossPct; remove the volTarget sizing"),
    ({**MINIMAL, "side": "short", "stopLoss": {"kind": "pct", "pct": 2}, "management": {"breakevenR": 1}},
     "management raises a long stop; a short definition takes no management"),
    ({**MINIMAL, "side": "short", "options": OPTIONS},
     "Option strategies take their direction from options.structure; remove side"),
    ({**MINIMAL, "intraday": INTRADAY, "options": OPTIONS},
     "Option strategies run on daily bars; remove the intraday block"),
    ({**MINIMAL, "intraday": INTRADAY,
      "filters": [{"type": "calendarWindow", "window": "turnOfMonth", "fromDay": -2, "toDay": 3}]},
     "calendarWindow filters run on daily bars only; remove them or the intraday block"),
])
def test_intraday_side_and_vol_target_refusals(definition, message) -> None:
    with pytest.raises(InputError) as raised:
        sig.normalize_definition(definition)
    assert str(raised.value) == message


# ---------------------------------------------------------------------------------------------
# Expression trees, relative refs, calendars and the portfolio block (strategy-dsl.ts 1.2).

CLOSE = {"type": "price", "field": "close"}
ZERO = {"type": "const", "value": 0}
OPTIONS = {"structure": "putCreditVertical", "dte": {"target": 45, "min": 21}, "widthSigma": 0.5, "maxLossPct": 2}


def _nested(depth: int) -> dict[str, Any]:
    expr: dict[str, Any] = CLOSE
    for _ in range(depth - 1):
        expr = {"type": "change", "of": expr, "length": 1}
    return expr


def _wide(nodes: int) -> dict[str, Any]:
    """A balanced-ish math tree of `nodes` nodes (odd), depth at most 6."""
    leaves = (nodes + 1) // 2
    level: list[dict[str, Any]] = [CLOSE] * leaves
    while len(level) > 1:
        pairs = [{"type": "math", "op": "add", "left": level[i], "right": level[i + 1]}
                 for i in range(0, len(level) - 1, 2)]
        level = pairs + ([level[-1]] if len(level) % 2 else [])
    return level[0]


def test_expression_trees_normalize_idempotently() -> None:
    definition = _definition({
        "type": "math", "op": "div",
        "left": {"type": "change", "of": {"type": "series", "series": "$future"}, "length": 252},
        "right": {"type": "regression", "y": CLOSE, "x": {"type": "returnStdev", "of": CLOSE, "length": 2.0},
                  "length": 3, "lag": 0},
    })
    definition["exit"] = {"any": [{"left": {"type": "seasonal", "of": CLOSE, "monthsAhead": 1, "minCount": 1},
                                   "op": "<", "right": ZERO}]}
    normalized = sig.normalize_definition(definition)
    left = normalized["entry"]["all"][0]["left"]
    assert left["left"] == {"type": "change", "length": 252, "offset": 0,
                            "of": {"type": "series", "series": "$future", "offset": 0}}
    assert left["right"]["x"]["length"] == 2
    assert sig.normalize_definition(normalized) == normalized
    assert sig.strategy_series_refs(normalized) == ["$future"]
    assert sig.expr_size(left) == (4, 7)


@pytest.mark.parametrize(
    ("expr", "message"),
    [
        ({"type": "series", "series": "BTC"}, "Unknown series: BTC"),
        ({"type": "series", "series": "VIX", "offset": -1}, "offset must be a whole number from 0 to 1000"),
        ({"type": "math", "op": "pow", "left": CLOSE, "right": CLOSE}, "Unknown math operator: pow"),
        ({"type": "change", "of": CLOSE, "length": 0}, "change length must be a whole number from 1 to 1000"),
        ({"type": "change", "of": CLOSE, "length": 1.5}, "change length must be a whole number from 1 to 1000"),
        ({"type": "returnStdev", "of": CLOSE, "length": 1}, "returnStdev length must be a whole number from 2 to 1000"),
        ({"type": "regression", "y": CLOSE, "x": CLOSE, "length": 2, "lag": 0},
         "regression length must be a whole number from 3 to 1000"),
        ({"type": "regression", "y": CLOSE, "x": CLOSE, "length": 3, "lag": True},
         "regression lag must be a whole number from 0 to 1000"),
        ({"type": "seasonal", "of": CLOSE, "monthsAhead": 12, "minCount": 1},
         "seasonal monthsAhead must be a whole number from 0 to 11"),
        ({"type": "seasonal", "of": CLOSE, "monthsAhead": 0, "minCount": 0},
         "seasonal minCount must be a whole number from 1 to 1000"),
        (_nested(7), "An expression may nest at most 6 levels"),
    ],
)
def test_expression_input_errors(expr: dict[str, Any], message: str) -> None:
    with pytest.raises(InputError, match=f"^{re.escape(message)}$"):
        sig.normalize_definition(_definition(expr))


def test_expression_limits_count_both_sides() -> None:
    assert sig.expr_size(_wide(21)) == (5, 21)
    sig.normalize_definition(_definition(_wide(39)))  # 39 + the constant: 40 nodes
    condition = {"left": _wide(21), "op": ">", "right": _wide(21)}
    with pytest.raises(InputError, match="^A condition may hold at most 40 expression nodes$"):
        sig.normalize_definition({**_definition(CLOSE), "entry": {"all": [condition]}})
    with pytest.raises(InputError, match="^An expression may nest at most 6 levels$"):
        sig.expression_values(bars_of("SPY"), _nested(7))


def test_series_filter_accepts_refs_but_reads_the_close_only() -> None:
    iv = {"type": "series", "series": "$iv", "condition": ALWAYS}
    assert sig.normalize_definition(_filtered(iv))["filters"][0]["series"] == "$iv"
    tree = {**iv, "condition": {**ALWAYS, "left": {"type": "math", "op": "add", "left": CLOSE, "right": CLOSE}}}
    with pytest.raises(InputError, match="^A series condition reads the series close only"):
        sig.normalize_definition(_filtered(tree))


def test_resolve_series_maps_the_relative_refs() -> None:
    assert sig.resolve_series("VIX", None) == "VIX"
    assert sig.resolve_series("$tr", "SPY") == "SPY:TR"
    assert sig.resolve_series("$iv", "GLD") == "GVZ"
    assert sig.resolve_series("$future", "USO") == "CL=F"
    assert sig.resolve_series("$future", None) is None
    assert sig.resolve_series("$iv", "XLK") is None


def test_expression_values_nan_paths() -> None:
    dates = _weekdays("2024-01-01", "2024-01-12")
    bars = _bars_on(dates)
    context = {"VIX": {dates[0]: 10.0, dates[2]: 0.0, dates[3]: 5.0}}
    ratio = {"type": "math", "op": "div", "left": CLOSE, "right": {"type": "series", "series": "VIX"}}
    values = sig.expression_values(bars, ratio, context)
    # A division by the 0 of the third date is not finite: NaN.
    assert values[0] == 10.0 and values[1] == 101 / 10 and math.isnan(values[2]) and values[3] == 103 / 5
    shifted = sig.expression_values(bars, {"type": "series", "series": "VIX", "offset": 2}, context)
    assert math.isnan(shifted[0]) and math.isnan(shifted[1]) and shifted[2] == 10.0
    # A zero base is not finite: NaN, also inside returnStdev and change.
    zero_base = {"type": "change", "of": {"type": "series", "series": "VIX"}, "length": 1}
    changes = sig.expression_values(bars, zero_base, context)
    assert changes[1] == 0.0 and changes[2] == -1.0 and math.isnan(changes[3])
    deviation = sig.expression_values(bars, {"type": "returnStdev", "of": CLOSE, "length": 3}, context)
    assert all(math.isnan(value) for value in deviation[:3]) and deviation[3] > 0
    seasonal = {"type": "seasonal", "of": CLOSE, "monthsAhead": 0, "minCount": 3}
    means = sig.expression_values(bars, seasonal, context)
    assert math.isnan(means[1]) and means[2] == 101.0


def test_relative_refs_need_a_mapped_symbol() -> None:
    bars = bars_of("SPY")
    with pytest.raises(InputError, match=r"^\$tr needs the traded symbol$"):
        sig.expression_values(bars, {"type": "series", "series": "$tr"}, golden()["series"])
    with pytest.raises(InputError, match=r"^\$iv has no series for XLK$"):
        sig.compile_strategy(bars, _filtered({"type": "series", "series": "$iv", "condition": ALWAYS}),
                             None, golden()["series"], "XLK")
    with pytest.raises(SeriesDataError, match="^Series data is not available for VIX$"):
        sig.expression_values(bars, {"type": "series", "series": "VIX"})


def test_calendar_must_hold_ascending_dates_and_every_bar_date() -> None:
    dates = _weekdays("2024-01-01", "2024-01-05")
    bars = _bars_on(dates)
    vix = {"type": "series", "series": "VIX"}
    context = {"VIX": {dates[0]: 10.0}}
    with pytest.raises(InputError, match="^The calendar must hold ascending YYYY-MM-DD dates without repeats: "
                                         "2024-01-01$"):
        sig.expression_values(bars, vix, context, None, [dates[1], dates[0]])
    with pytest.raises(InputError, match="^The calendar must hold ascending YYYY-MM-DD dates without repeats: 2024/1/1$"):
        sig.expression_values(bars, vix, context, None, ["2024/1/1"])
    with pytest.raises(InputError, match="^Bar date 2024-01-05 is not in the calendar$"):
        sig.expression_values(bars, vix, context, None, dates[:4])
    # Carry counts calendar dates: 10 weekdays between two bars ends the 5-date carry.
    calendar = _weekdays("2024-01-01", "2024-01-31")
    month_ends = _bars_on([calendar[0], calendar[5], calendar[10]])
    assert sig.expression_values(month_ends, vix, context)[2] == 10.0
    aligned = sig.expression_values(month_ends, vix, context, None, calendar)
    assert aligned[:2] == [10.0, 10.0] and math.isnan(aligned[2])


def _portfolio_definition(portfolio: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {**_filtered({"type": "calendarWindow", "window": "opexWeek"}), "options": OPTIONS,
            "portfolio": portfolio, **extra}


@pytest.mark.parametrize(
    ("portfolio", "message"),
    [
        ({"policy": "hold", "symbols": ["SPY"]}, "Unknown portfolio policy: hold"),
        ({"policy": "roll", "symbols": []}, "A portfolio trades 1 to 7 symbols"),
        ({"policy": "roll", "symbols": ["XLK"]}, "Unknown portfolio symbol: XLK"),
        ({"policy": "roll", "symbols": ["SPY", "SPY"]}, "Portfolio symbols must not repeat"),
        ({"policy": "flat", "cadence": "weekly", "symbols": ["SPY"]}, "Unknown portfolio cadence: weekly"),
        ({"policy": "roll", "frame": "weekly", "symbols": ["SPY"]}, "Unknown portfolio frame: weekly"),
        ({"policy": "roll", "legs": [], "symbols": ["SPY"]}, "A portfolio holds 1 to 3 legs"),
        ({"policy": "roll", "symbols": ["SPY"], "legs": [{"entry": {"all": [ALWAYS]}}]},
         "A portfolio leg needs an options block"),
        ({"policy": "roll", "symbols": ["SPY"], "legs": [{"entry": {"all": []}, "options": OPTIONS}]},
         "A leg entry needs 1 to 8 conditions"),
        ({"policy": "roll", "symbols": ["SPY"], "legs": [{"entry": {"all": [ALWAYS]}, "filters": [],
                                                          "options": OPTIONS}]},
         "A leg needs 1 to 4 filters"),
        ({"policy": "roll", "symbols": ["SPY"], "select": {"score": CLOSE, "top": 8}},
         "select top must be a whole number from 1 to 7"),
        ({"policy": "roll", "symbols": ["SPY"], "select": {"score": _nested(7), "top": 1}},
         "An expression may nest at most 6 levels"),
        ({"policy": "window", "shift": 6, "symbols": ["SPY"]}, "shift must be a whole number from 1 to 5"),
        ({"policy": "flat", "symbols": ["SPY"]}, "cadence is required with the flat policy and only there"),
        ({"policy": "roll", "cadence": "daily", "symbols": ["SPY"]},
         "cadence is required with the flat policy and only there"),
        ({"policy": "window", "frame": "monthly", "symbols": ["SPY"]}, "frame monthly needs the roll policy"),
        ({"policy": "window", "select": {"score": CLOSE, "top": 1}, "symbols": ["SPY"]},
         "select needs the roll policy"),
        ({"policy": "roll", "shift": 1, "symbols": ["SPY"]}, "shift needs the window policy"),
    ],
)
def test_portfolio_refinements(portfolio: dict[str, Any], message: str) -> None:
    with pytest.raises(InputError, match=f"^{re.escape(message)}$"):
        sig.normalize_definition(_portfolio_definition(portfolio))


SHIFT_MESSAGE = (
    "A shifted window reads ahead: every leg needs the entry close > 0, no exit and calendarWindow"
    " filters only"
)


@pytest.mark.parametrize(
    "change",
    [
        {"entry": {"all": [{**ALWAYS, "left": {**CLOSE, "offset": 1}}]}},
        {"entry": {"all": [{**ALWAYS, "op": ">="}]}},
        {"entry": {"all": [{**ALWAYS, "right": {"type": "const", "value": 1}}]}},
        {"entry": {"all": [ALWAYS, ALWAYS]}},
        {"exit": {"any": [ALWAYS]}},
        {"filters": [{"type": "ivRank", "max": 30}]},
        {"filters": None},
    ],
)
def test_a_shifted_window_needs_calendar_only_legs(change: dict[str, Any]) -> None:
    portfolio = {"policy": "window", "shift": 2, "symbols": ["SPY"]}
    shifted = _portfolio_definition(portfolio)
    assert sig.normalize_definition(shifted)["portfolio"] == portfolio
    with pytest.raises(InputError, match=f"^{re.escape(SHIFT_MESSAGE)}$"):
        sig.normalize_definition({**shifted, **change})
    leg = {"entry": {"all": [ALWAYS]}, "filters": [{"type": "calendarWindow", "window": "opexWeek"}],
           "options": OPTIONS}
    with pytest.raises(InputError, match=f"^{re.escape(SHIFT_MESSAGE)}$"):
        sig.normalize_definition(_portfolio_definition({**portfolio, "legs": [leg, {**leg, **change}]}))


def test_a_portfolio_needs_an_options_block() -> None:
    definition = {**_filtered(), "portfolio": {"policy": "roll", "symbols": ["SPY"]}}
    with pytest.raises(InputError, match="^A portfolio block trades option verticals; add an options block$"):
        sig.normalize_definition(definition)


def test_portfolio_is_normalized_and_returned_with_the_ts_defaults() -> None:
    portfolio = {
        "policy": "roll", "frame": "monthly", "symbols": ["SPY", "QQQ"],
        "select": {"score": {"type": "series", "series": "$tr"}, "tieBreak": CLOSE, "top": 1},
        "legs": [{"entry": {"all": [ALWAYS]}, "exit": {"any": []},
                  "filters": [{"type": "ivRank", "max": 30}], "options": OPTIONS}],
    }
    definition = _portfolio_definition(portfolio)
    normalized = sig.normalize_definition(definition)
    assert normalized["portfolio"]["legs"][0]["filters"][0]["length"] == 252
    assert normalized["portfolio"]["select"]["tieBreak"] == {"type": "price", "field": "close", "offset": 0}
    assert sig.normalize_definition(normalized) == normalized
    assert sig.strategy_series_refs(normalized) == ["$iv", "$tr"]
    compiled = sig.compile_strategy(bars_of("SPY"), definition)
    # TS compileStrategy returns the zod output: defaults applied, absent offsets stay absent.
    assert compiled.portfolio == {
        **portfolio,
        "legs": [{**portfolio["legs"][0], "filters": [{"type": "ivRank", "max": 30, "length": 252}]}],
    }
    assert compiled.options == OPTIONS
    plain = sig.compile_strategy(bars_of("SPY"), _filtered())
    assert plain.portfolio is None


def test_server_refusal_support_flags() -> None:
    reads = sig.normalize_definition(_definition({"type": "series", "series": "VIX"}))
    refusal = sig.server_refusal(reads)
    assert refusal is not None and "series expressions need daily series" in str(refusal)
    assert sig.server_refusal(reads, "1d", {"series": True}) is None
    options = sig.normalize_definition({**_filtered(), "options": OPTIONS})
    assert sig.server_refusal(options, "1d", {"options": True}) is None
    timeframe = sig.server_refusal(options, "1w", {"options": True})
    assert timeframe is not None and timeframe.code == "STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED"


READS_VIX = {"left": CLOSE, "op": "<", "right": {"type": "series", "series": "VIX"}}


@pytest.mark.parametrize(
    "change",
    [
        {"entry": {"all": [READS_VIX]}},
        {"entry": {"all": [ALWAYS], "any": [ALWAYS, READS_VIX]}},
        {"exit": {"any": [READS_VIX]}},
        {"options": OPTIONS, "portfolio": {"policy": "roll", "symbols": ["SPY"],
                                           "legs": [{"entry": {"all": [READS_VIX]}, "options": OPTIONS}]}},
        {"options": OPTIONS, "portfolio": {"policy": "roll", "symbols": ["SPY"],
                                           "legs": [{"entry": {"all": [ALWAYS]}, "exit": {"any": [READS_VIX]},
                                                     "options": OPTIONS}]}},
    ],
    ids=["entry.all", "entry.any", "exit.any", "leg entry.all", "leg exit.any"],
)
def test_server_refusal_sees_a_series_read_in_every_condition_list(change: dict[str, Any]) -> None:
    definition = sig.normalize_definition({"version": 1, "name": "x", "entry": {"all": [ALWAYS]}, **change})
    support = {"options": True} if "options" in change else {}
    refusal = sig.server_refusal(definition, "1d", support)
    assert refusal is not None and "series expressions need daily series" in str(refusal)
    assert sig.server_refusal(definition, "1d", {**support, "series": True}) is None


def test_options_refuse_management_and_max_leverage() -> None:
    stop = {"kind": "pct", "pct": 2}
    with pytest.raises(InputError, match="remove management$"):
        sig.normalize_definition({**_filtered(), "options": OPTIONS, "management": {"breakevenR": 1}})
    # maxLeverage lives in riskPct sizing only, which an options block refuses.
    with pytest.raises(InputError, match="remove the riskPct sizing$"):
        sig.normalize_definition({**_filtered(), "options": OPTIONS, "stopLoss": stop,
                                  "sizing": {"mode": "riskPct", "riskPct": 1, "maxLeverage": 2}})


def test_plan_run_loads_series_with_a_context() -> None:
    definition = _definition({"type": "math", "op": "sub", "left": {"type": "series", "series": "$tr"},
                              "right": {"type": "series", "series": "$tr", "offset": 1}})
    spec = {"rule": {"kind": "dsl", "definition": definition}, "costBps": 0, "costs": None,
            "context": golden()["series"], "symbol": "SPY"}
    compiled, _ = sig.plan_run(bars_of("SPY"), spec)
    expected = sig.compile_strategy(bars_of("SPY"), definition, None, golden()["series"], "SPY")
    assert compiled.signals == expected.signals
    assert 0 < sum(1 for value in compiled.signals if value == 1) < len(compiled.signals)
    with pytest.raises(StrategyUnsupportedError, match="^STRATEGY_SERIES_FILTERS_UNSUPPORTED: series expressions"):
        sig.plan_run(bars_of("SPY"), spec, {"series": False})
    with pytest.raises(StrategyUnsupportedError, match="^STRATEGY_SERIES_FILTERS_UNSUPPORTED"):
        sig.plan_run(bars_of("SPY"), {**spec, "context": None})
    calendar = golden()["calendars"]["weekdays"]
    on_calendar, _ = sig.plan_run(bars_of("SPY"), {**spec, "calendar": calendar})
    assert on_calendar.signals == sig.compile_strategy(
        bars_of("SPY"), definition, None, golden()["series"], "SPY", calendar
    ).signals


def test_portfolio_ts_defaults_reach_nested_indicators_and_filters() -> None:
    sma = {"type": "indicator", "name": "sma", "length": 3}
    condition = {"left": CLOSE, "op": ">", "right": sma}
    portfolio = {
        "policy": "roll", "symbols": ["SPY"],
        "select": {"score": {"type": "math", "op": "sub", "left": sma, "right": CLOSE}, "top": 1},
        "legs": [{
            "entry": {"all": [condition]},
            "filters": [
                {"type": "sectorQuadrant", "sector": "XLK", "quadrants": ["leading"]},
                {"type": "volRegime", "maxVix": 30, "maxTermRatio": 1},
            ],
            "options": OPTIONS,
        }],
    }
    compiled = sig.compile_strategy(bars_of("SPY"), _portfolio_definition(portfolio))
    with_source = {**sma, "source": "close"}
    assert compiled.portfolio == {
        "policy": "roll", "symbols": ["SPY"],
        "select": {"score": {"type": "math", "op": "sub", "left": with_source, "right": CLOSE}, "top": 1},
        "legs": [{
            "entry": {"all": [{"left": CLOSE, "op": ">", "right": with_source}]},
            "filters": [
                {"type": "sectorQuadrant", "sector": "XLK", "quadrants": ["leading"], "timeframe": "weekly"},
                {"type": "volRegime", "maxVix": 30, "maxTermRatio": 1, "trendLength": 200},
            ],
            "options": OPTIONS,
        }],
    }
    # The input is not changed.
    assert "source" not in portfolio["legs"][0]["entry"]["all"][0]["right"]


@pytest.mark.parametrize("key", ["cadence", "frame", "legs", "select", "shift"])
def test_portfolio_refuses_null_optional_keys(key: str) -> None:
    portfolio = {"policy": "roll", "symbols": ["SPY"], key: None}
    with pytest.raises(InputError, match=f"^portfolio {key} must not be null$"):
        sig.normalize_definition(_portfolio_definition(portfolio))


def test_portfolio_refuses_unknown_keys_and_null_tie_break() -> None:
    with pytest.raises(InputError, match="^Unknown portfolio key: frames$"):
        sig.normalize_definition(
            _portfolio_definition({"policy": "roll", "symbols": ["SPY"], "frames": "monthly"})
        )
    select = {"score": CLOSE, "top": 1, "tieBreak": None}
    with pytest.raises(InputError, match="^portfolio select tieBreak must not be null$"):
        sig.normalize_definition(
            _portfolio_definition({"policy": "roll", "symbols": ["SPY"], "select": select})
        )
    with pytest.raises(InputError, match="^Unknown portfolio select key: bottom$"):
        sig.normalize_definition(
            _portfolio_definition(
                {"policy": "roll", "symbols": ["SPY"], "select": {"score": CLOSE, "top": 1, "bottom": 1}}
            )
        )


def _definition_of(conditions: list[dict[str, Any]]) -> dict[str, Any]:
    return {"version": 1, "name": "x", "entry": {"all": conditions}}


def _deep(levels: int) -> dict[str, Any]:
    expr: dict[str, Any] = CLOSE
    for _ in range(levels):
        expr = {"type": "change", "length": 1, "of": expr}
    return expr


DEPTH_MESSAGE = f"^An expression may nest at most {sig.MAX_EXPR_DEPTH} levels$"


@pytest.mark.parametrize("side", ["left", "right"])
def test_a_20000_level_expression_is_refused_without_recursion(side: str) -> None:
    condition = {**ALWAYS, side: _deep(20000)}
    with pytest.raises(InputError, match=DEPTH_MESSAGE):
        sig.normalize_definition(_definition_of([condition]))
    math: dict[str, Any] = CLOSE
    for _ in range(20000):
        math = {"type": "math", "op": "add", "left": math, "right": CLOSE}
    with pytest.raises(InputError, match=DEPTH_MESSAGE):
        sig.normalize_definition(_definition_of([{**ALWAYS, side: math}]))


@pytest.mark.parametrize("key", ["score", "tieBreak"])
def test_a_20000_level_selection_score_is_refused_without_recursion(key: str) -> None:
    select = {"score": CLOSE, "top": 1, key: _deep(20000)}
    with pytest.raises(InputError, match=DEPTH_MESSAGE):
        sig.normalize_definition(
            _portfolio_definition({"policy": "roll", "symbols": ["SPY"], "select": select})
        )


def test_the_deepest_allowed_expression_still_normalizes() -> None:
    deepest = _deep(sig.MAX_EXPR_DEPTH - 1)
    sig.normalize_definition(_definition_of([{**ALWAYS, "left": deepest}]))


@pytest.mark.parametrize("name", ["atr", "adx", "rvol"])
def test_monthly_frame_refuses_bar_range_indicators_anywhere(name: str) -> None:
    indicator = {"type": "indicator", "name": name, "length": 5}
    condition = {**ALWAYS, "left": indicator}
    monthly = {"policy": "roll", "frame": "monthly", "symbols": ["SPY"]}
    message = f"^{re.escape(sig.MONTHLY_INDICATOR_MESSAGE)}$"
    # Daily bars have a range and volume.
    sig.normalize_definition(
        _portfolio_definition({"policy": "roll", "symbols": ["SPY"]}, entry={"all": [condition]})
    )
    cases = [
        _portfolio_definition(monthly, entry={"all": [condition]}),
        _portfolio_definition(monthly, exit={"any": [condition]}),
        _portfolio_definition(
            {**monthly, "legs": [{"entry": {"all": [ALWAYS]}, "exit": {"any": [condition]}, "options": OPTIONS}]}
        ),
        _portfolio_definition(
            {**monthly, "select": {"score": {"type": "math", "op": "div", "left": indicator,
                                             "right": {"type": "const", "value": 2}}, "top": 1}}
        ),
        _portfolio_definition({**monthly, "select": {"score": CLOSE, "tieBreak": indicator, "top": 1}}),
    ]
    for definition in cases:
        with pytest.raises(InputError, match=message):
            sig.normalize_definition(definition)
    sma = {**indicator, "name": "sma"}
    sig.normalize_definition(_portfolio_definition(monthly, entry={"all": [{**ALWAYS, "left": sma}]}))


def test_portfolio_and_series_checks_cover_entry_any() -> None:
    """strategy-dsl.ts calendarOnly, definitionExprs and strategySeriesRefs read entry.any too."""
    shifted = {"policy": "window", "shift": 2, "symbols": ["SPY"]}
    with pytest.raises(InputError, match="^A shifted window reads ahead"):
        sig.normalize_definition(_portfolio_definition(shifted, entry={"all": [ALWAYS], "any": [ALWAYS]}))
    atr = {**ALWAYS, "left": {"type": "indicator", "name": "atr", "length": 5}}
    monthly = {"policy": "roll", "frame": "monthly", "symbols": ["SPY"]}
    with pytest.raises(InputError, match=f"^{re.escape(sig.MONTHLY_INDICATOR_MESSAGE)}$"):
        sig.normalize_definition(_portfolio_definition(monthly, entry={"all": [ALWAYS], "any": [atr]}))
    vix = {**ALWAYS, "right": {"type": "series", "series": "VIX"}}
    normalized = sig.normalize_definition({"name": "any", "entry": {"all": [], "any": [vix]}})
    assert sig.strategy_series_refs(normalized) == ["VIX"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"entry": {"all": [{**ALWAYS, "right": {"type": "series", "series": "VIX", "lag": 1}}]}},
         "Unknown key in series expression: lag"),
        ({"entry": {"all": [{**ALWAYS, "right": {"type": "math", "op": "add", "left": CLOSE, "right": ZERO,
                                                 "offset": 1}}]}},
         "Unknown key in math expression: offset"),
        ({"portfolio": {"policy": "roll", "symbols": ["SPY"],
                        "legs": [{"entry": {"all": [ALWAYS]}, "options": OPTIONS, "weight": 1}]}},
         "Unknown key in portfolio leg: weight"),
        ({"portfolio": {"policy": "roll", "symbols": ["SPY"],
                        "legs": [{"entry": {"all": [ALWAYS], "any": [ALWAYS]}, "options": OPTIONS}]}},
         "Unknown key in portfolio leg entry: any"),
    ],
)
def test_strict_keys_cover_trees_and_portfolio_legs(change: dict[str, Any], message: str) -> None:
    """The TS expression trees and portfolio legs are .strict() like the other schema objects."""
    with pytest.raises(InputError, match=f"^{re.escape(message)}$"):
        sig.normalize_definition({**_portfolio_definition({"policy": "roll", "symbols": ["SPY"]}), **change})


def test_a_shifted_window_takes_an_explicit_offset_0_as_no_offset() -> None:
    zero = {"all": [{**ALWAYS, "left": {**CLOSE, "offset": 0}}]}
    portfolio = {"policy": "window", "shift": 2, "symbols": ["SPY"]}
    sig.normalize_definition(_portfolio_definition(portfolio, entry=zero))


@pytest.mark.parametrize("kind", ["price", "indicator"])
@pytest.mark.parametrize("offset", [-1, 1001, 1.5, True, "2"])
def test_price_and_indicator_offsets_are_validated(kind: str, offset: Any) -> None:
    leaf = CLOSE if kind == "price" else {"type": "indicator", "name": "sma", "length": 2}
    with pytest.raises(InputError, match="^offset must be a whole number from 0 to 1000$"):
        sig.normalize_definition(_definition_of([{**ALWAYS, "left": {**leaf, "offset": offset}}]))
    assert sig.normalize_definition(
        _definition_of([{**ALWAYS, "left": {**leaf, "offset": 3.0}}])
    )["entry"]["all"][0]["left"]["offset"] == 3
