"""Flow control rules (options, futures and agreement): Python port matches the TypeScript golden vectors."""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from strategies.flow_control.control import (
    FUTURES_RULES,
    RULES,
    DriftMinute,
    TapeMinute,
    agreement_of,
    fold_control_state,
    fold_futures_state,
    futures_window_totals,
    group_options_state,
    options_ratio,
)
FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "api" / "src" / "fixtures" / \
    "flow-control-golden.fixture.json"
GOLDEN = json.loads(FIXTURE.read_text())


def _minutes(rows) -> list[DriftMinute]:
    return [DriftMinute(r["minute"], r["netCallPremium"], r["netPutPremium"]) for r in rows]


def test_fixture_schema_version_is_known():
    assert GOLDEN["schemaVersion"] == "flow-control-golden.v1"


def test_rules_object_equals_the_fixture_rules():
    assert RULES.to_json() == GOLDEN["rules"]
    assert FUTURES_RULES.to_json() == GOLDEN["futuresRules"]

@pytest.mark.parametrize("case", GOLDEN["optionsCases"], ids=lambda case: case["name"])
def test_every_options_case_gives_the_fixture_states(case):
    rules = RULES
    if case.get("rules", {}).get("windowMinutes") is not None:
        rules = dataclasses.replace(RULES, window_minutes=case["rules"]["windowMinutes"])
    steps = fold_control_state(_minutes(case["minutes"]), rules)
    assert len(steps) == len(case["expected"])
    for step, want in zip(steps, case["expected"], strict=True):
        assert step.minute == want["minute"]
        if want["ratio"] is None:
            assert step.ratio is None
        else:
            assert step.ratio is not None and abs(step.ratio - want["ratio"]) <= 1e-12
        assert (step.state, step.no_data_reason, step.since_minute) == (
            want["state"], want["noDataReason"], want["sinceMinute"]), step


@pytest.mark.parametrize("case", GOLDEN["groupCases"], ids=lambda case: case["name"])
def test_every_group_case_gives_the_fixture_state(case):
    assert group_options_state(case["primary"], case["check"]) == case["expected"]


def test_options_ratio_by_hand():
    window = [DriftMinute(0, 300.0, -100.0), DriftMinute(1, 100.0, 100.0)]
    # (300 - -100 + 100 - 100) / (300 + 100 + 100 + 100)
    assert options_ratio(window) == pytest.approx(400 / 600)
    assert options_ratio([DriftMinute(0, 0.0, 0.0)]) == 0.0
    assert options_ratio([]) == 0.0


def test_session_start_and_gap_reasons_by_hand():
    rows = [DriftMinute(m, 10.0, 0.0) for m in range(0, 12)] + [DriftMinute(50, 10.0, 0.0)]
    steps = fold_control_state(rows, RULES)
    assert [s.no_data_reason for s in steps[:9]] == ["session_start"] * 9
    assert steps[9].state != "no_data"
    assert steps[45].state == "no_data" and steps[45].no_data_reason == "gap"
    assert steps[-1].minute == 50


def test_no_data_step_keeps_the_state_and_resets_the_runs():
    rows = [DriftMinute(m, 10.0, 0.0) for m in range(0, 20)]
    rows += [DriftMinute(m, 10.0, 0.0) for m in range(60, 63)]
    steps = fold_control_state(rows, dataclasses.replace(RULES, window_minutes=30))
    assert steps[13].state == "buyers" and steps[13].since_minute == 9
    gap = steps[55]
    assert gap.state == "no_data" and gap.since_minute is None
    # Too few buckets again at 60..62: still no data; the carried state is not lost.
    assert all(s.state == "no_data" for s in steps[50:63])
    rows += [DriftMinute(m, 10.0, 0.0) for m in range(63, 80)]
    steps = fold_control_state(rows, RULES)
    assert steps[72].state == "buyers" and steps[72].since_minute == 9


def _tape_minutes(rows) -> list[TapeMinute]:
    return [
        TapeMinute(
            minute=r["minute"],
            deep_buy=r["deepBuy"],
            deep_sell=r["deepSell"],
            deep_trades=r["deepTrades"],
            delta=r["delta"],
            volume=r["volume"],
            vwap=r["vwap"],
            close=r["close"],
        )
        for r in rows
    ]


def _futures_rules_with(overrides: dict | None):
    if not overrides:
        return FUTURES_RULES
    mapping = {
        "windowMinutes": "window_minutes",
        "enterRatio": "enter_ratio",
        "exitRatio": "exit_ratio",
        "minMinutes": "min_minutes",
        "minBuckets": "min_buckets",
        "maxMissingMinutes": "max_missing_minutes",
        "minCoveredSeconds": "min_covered_seconds",
        "minTrades": "min_trades",
        "version": "version",
    }
    return dataclasses.replace(FUTURES_RULES, **{mapping[k]: v for k, v in overrides.items()})


@pytest.mark.parametrize("case", GOLDEN["futuresCases"], ids=lambda case: case["name"])
def test_every_futures_case_gives_the_fixture_states(case):
    rules = _futures_rules_with(case.get("rules"))
    through = case.get("through", -1)
    steps = fold_futures_state(_tape_minutes(case["minutes"]), rules, through=through)
    assert len(steps) == len(case["expected"])
    for step, want in zip(steps, case["expected"], strict=True):
        assert step.minute == want["minute"]
        if want["ratio"] is None:
            assert step.ratio is None
        else:
            assert step.ratio is not None and abs(step.ratio - want["ratio"]) <= 1e-12
        assert (step.state, step.no_data_reason, step.since_minute, step.hold, step.trades) == (
            want["state"],
            want["noDataReason"],
            want["sinceMinute"],
            want["hold"],
            want["trades"],
        ), step


@pytest.mark.parametrize("case", GOLDEN["agreementCases"], ids=lambda case: case["name"])
def test_every_agreement_case_gives_the_fixture_result(case):
    assert agreement_of(case["futures"], case["options"]).to_json() == case["expected"]


def test_futures_window_totals_and_empty_fold():
    assert fold_futures_state([]) == []
    rows = [
        TapeMinute(0, 100.0, 20.0, 2, 10.0, 200.0, 5000.0, 5001.0),
        TapeMinute(30, 50.0, 50.0, 1, 0.0, 100.0, 5002.0, 5002.0),
    ]
    # Window at end=30 with window_minutes=30 includes minutes in (0, 30], so minute 0 is excluded.
    totals = futures_window_totals(rows, 30, FUTURES_RULES)
    assert (totals.numerator, totals.denominator, totals.rows) == (0.0, 100.0, 1)
