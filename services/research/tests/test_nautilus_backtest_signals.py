"""Python signals and costs match the TypeScript engine (golden fixtures).

The fixture comes from `bun scripts/research-nautilus-golden.ts`. Floats must agree within a
relative and absolute tolerance of 1e-12 (NaN equals NaN); signals and masks must be equal.
This suite does not import nautilus_trader.
"""

from __future__ import annotations

import json
import math
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from nautilus_backtest import costs as cost_model
from nautilus_backtest import signals as sig
from nautilus_backtest.bars import Bars, InputError, SectorQuadrantDataError

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
    compiled = sig.compile_strategy(
        bars_of(case["symbol"]), case["definition"], golden()["sectorQuadrants"]
    )
    assert list(compiled.signals) == case["signals"]
    assert list(compiled.exits or ()) == case["exits"]
    for name, actual, expected in (
        ("stopDistance", compiled.stop_distance, case["stopDistance"]),
        ("targetDistance", compiled.target_distance, case["targetDistance"]),
    ):
        if expected is None:
            assert actual is None, name
        else:
            assert actual is not None, name
            assert_series(actual, expected, name)


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
        (lambda: sig.compile_strategy(bars_of("SPY"), _definition({"type": "indicator", "name": "vwap", "length": 3})), "Unknown indicator: vwap"),
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
