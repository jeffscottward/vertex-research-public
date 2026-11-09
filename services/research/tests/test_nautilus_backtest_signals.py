"""Python signals and costs match the TypeScript engine (golden fixtures).

The fixture comes from `bun scripts/research-nautilus-golden.ts`. Floats must agree within a
relative and absolute tolerance of 1e-12 (NaN equals NaN); signals and masks must be equal.
This suite does not import nautilus_trader.
"""

from __future__ import annotations

import json
import math
import os
from datetime import date, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from nautilus_backtest import costs as cost_model
from nautilus_backtest import signals as sig
from nautilus_backtest.bars import (
    STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED,
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


@pytest.mark.parametrize("case", COMPILED, ids=_ids(COMPILED, "id", "symbol"))
def test_compiled_strategy_matches_typescript(case: dict[str, Any]) -> None:
    if "refused" in case:
        with pytest.raises(StrategyUnsupportedError) as raised:
            sig.compile_strategy(
                bars_of(case["symbol"]), case["definition"], golden()["sectorQuadrants"],
                golden()["series"], case["symbol"],
            )
        assert raised.value.code == case["refused"]["code"]
        assert str(raised.value) == case["refused"]["message"]
        return
    compiled = sig.compile_strategy(
        bars_of(case["symbol"]),
        case["definition"],
        golden()["sectorQuadrants"],
        golden()["series"],
        case["symbol"],
    )
    assert list(compiled.signals) == case["signals"]
    assert list(compiled.exits or ()) == case["exits"]
    assert compiled.options == case.get("options")
    for name, actual, expected in (
        ("stopDistance", compiled.stop_distance, case["stopDistance"]),
        ("targetDistance", compiled.target_distance, case["targetDistance"]),
    ):
        if expected is None:
            assert actual is None, name
        else:
            assert actual is not None, name
            assert_series(actual, expected, name)


REFUSALS = golden()["engineRefusals"]


@pytest.mark.parametrize("case", REFUSALS, ids=_ids(REFUSALS, "id", "symbol"))
def test_plan_run_refuses_like_the_typescript_server_engine(case: dict[str, Any]) -> None:
    spec = {"rule": {"kind": "dsl", "definition": case["definition"]}, "costBps": 10, "costs": None,
            "sectorQuadrants": golden()["sectorQuadrants"], "timeframe": case.get("timeframe")}
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.plan_run(bars_of(case["symbol"]), spec)
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
        "STRATEGY_OPTIONS_UNSUPPORTED: the options block runs only in the options research runner;"
        ' an equity backtest refuses it. Remove "options" to test the underlying signals.'
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
