"""BridgingCycles short strangle: schema, selector, rules and simulator.

Synthetic, offline fixtures only. No network, broker or order paths.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta

import pytest
from pydantic import ValidationError

from gamma.engines.bridgingcycles_short_strangle import (
    RULES,
    BridgingCyclesShortStrangleDefinition,
    BridgingCyclesShortStrangleParams,
    DailyObservation,
    black_scholes_marks,
    chain_snapshot_marks,
    simulate_bridgingcycles_short_strangle,
    third_friday,
    vrp_percentile,
)
from gamma.engines.options_strategy_selector import (
    OptionsStrategySelector,
    StrategySelectionConstraints,
    _strategy_order,
)
from gamma.schemas import OptionLeg, OptionsStrategyIntent, TradeSetup

TLT_AS_OF = datetime(2026, 10, 21, 15, 0, tzinfo=UTC)
NOV_MONTHLY = date(2026, 11, 20)
NOV_WEEKLY = date(2026, 11, 27)
ONE_POINT_GRID = [float(strike) for strike in range(50, 111)]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def _intent(strategy_type: str, legs: list[OptionLeg]) -> OptionsStrategyIntent:
    return OptionsStrategyIntent(
        intent_id="intent-test",
        ticker="TLT",
        strategy_type=strategy_type,
        direction="neutral",
        legs=legs,
        max_loss=150,
        max_profit=150,
        net_debit_or_credit=150,
        breakevens=[71.5, 83.5],
        target_profit_pct=0.5,
        stop_loss_pct=1.0,
        dte=30,
        greeks={},
        liquidity_checks={},
        thesis="synthetic",
        invalidation="synthetic",
        confidence=0.5,
    )


def _leg(side: str, right: str, strike: float, *, expiry: date = NOV_MONTHLY,
         quantity: int = 1) -> OptionLeg:
    return OptionLeg(side=side, right=right, expiry=expiry, strike=strike,
                     quantity=quantity)


def test_schema_accepts_short_strangle() -> None:
    intent = _intent("short_strangle", [_leg("sell", "put", 73), _leg("sell", "call", 82)])
    assert intent.strategy_type == "short_strangle"
    # Leg order is not significant.
    _intent("short_strangle", [_leg("sell", "call", 82), _leg("sell", "put", 73)])


@pytest.mark.parametrize(
    "legs",
    [
        [_leg("buy", "put", 73), _leg("buy", "call", 82)],  # long sides
        [_leg("sell", "put", 73), _leg("buy", "call", 82)],  # mixed sides
        [_leg("sell", "put", 82), _leg("sell", "call", 73)],  # inverted strikes
        [_leg("sell", "put", 77), _leg("sell", "call", 77)],  # equal strikes
        [_leg("sell", "put", 73), _leg("sell", "put", 82)],  # two puts
        [_leg("sell", "put", 73), _leg("sell", "call", 82, expiry=NOV_WEEKLY)],
        [_leg("sell", "put", 73), _leg("sell", "call", 82, quantity=2)],
        [_leg("sell", "put", 73)],
    ],
)
def test_schema_rejects_inconsistent_short_strangle(legs: list[OptionLeg]) -> None:
    with pytest.raises(ValidationError, match="short_strangle legs"):
        _intent("short_strangle", legs)


def test_long_strangle_schema_is_unchanged() -> None:
    _intent("strangle", [_leg("buy", "put", 73), _leg("buy", "call", 82)])
    with pytest.raises(ValidationError, match="strangle legs"):
        _intent("strangle", [_leg("sell", "put", 73), _leg("sell", "call", 82)])


# ---------------------------------------------------------------------------
# Selector
# ---------------------------------------------------------------------------


def _setup(direction: str = "neutral", preferred: list[str] | None = None) -> TradeSetup:
    return TradeSetup(
        setup_id="synthetic-tlt", ticker="TLT", direction=direction,
        thesis="Synthetic VRP fixture", setup_score=70, confidence=0.6,
        invalidation="Synthetic only", target_window="30-60 days",
        preferred_strategy_types=["short_strangle"] if preferred is None else preferred,
        rejection_reasons=[],
    )


def _row(right: str, strike: float, bid: float, ask: float, delta: float, *,
         expiry: date = NOV_MONTHLY, spot: float | None = 77.5) -> dict[str, object]:
    row: dict[str, object] = {
        "expiry": expiry.isoformat(), "strike": strike, "right": right,
        "bid": bid, "ask": ask, "delta": delta, "volume": 500,
        "open_interest": 5_000, "implied_volatility": 0.18,
        "price_source": "offline_fixture", "timestamp": TLT_AS_OF.isoformat(),
    }
    if spot is not None:
        row["underlyingPrice"] = spot
    return row


def _tlt_chain(spot: float | None = 77.5) -> list[dict[str, object]]:
    return [
        _row("put", 72, 0.42, 0.46, -0.13, spot=spot),
        _row("put", 73, 0.58, 0.62, -0.17, spot=spot),
        _row("put", 74, 0.80, 0.85, -0.23, spot=spot),
        _row("put", 77, 1.50, 1.56, -0.43, spot=spot),
        _row("call", 78, 1.40, 1.46, 0.43, spot=spot),
        _row("call", 81, 0.55, 0.59, 0.21, spot=spot),
        _row("call", 82, 0.40, 0.44, 0.16, spot=spot),
        _row("call", 83, 0.28, 0.31, 0.12, spot=spot),
        # Non-monthly expiry inside the DTE window must be ignored (rule 6, A).
        _row("put", 73, 0.70, 0.74, -0.19, expiry=NOV_WEEKLY, spot=spot),
        _row("call", 82, 0.50, 0.54, 0.18, expiry=NOV_WEEKLY, spot=spot),
    ]


# Generic selector delta filter is 0.45 +/- 0.25; strangle wings sit near
# 0.12-0.20 delta, so the research caller widens it explicitly.
WIDE_DELTA = StrategySelectionConstraints(max_delta_deviation=0.40)


def test_selector_builds_short_strangle_from_contracts() -> None:
    result = OptionsStrategySelector(constraints=WIDE_DELTA).select(
        setup=_setup(), option_chain=_tlt_chain(), as_of=TLT_AS_OF,
    )

    intent = result.strategy_intent
    assert intent is not None
    assert result.selected_strategy_type == "short_strangle"
    assert intent.strategy_type == "short_strangle"
    assert [(leg.side, leg.right, leg.strike, leg.expiry) for leg in intent.legs] == [
        ("sell", "put", 73, NOV_MONTHLY),
        ("sell", "call", 82, NOV_MONTHLY),
    ]
    assert intent.dte == 30
    assert intent.net_debit_or_credit == 98  # (0.58 + 0.40) * 100 at the bid
    assert intent.max_profit == 98
    assert intent.max_loss == 98  # planned 2x-credit stop, not a risk bound
    assert intent.breakevens == [72.02, 82.98]
    assert intent.target_profit_pct == 0.5
    assert intent.stop_loss_pct == 1.0
    checks = intent.liquidity_checks
    assert checks["risk_profile"] == "undefined_risk"
    assert checks["max_loss_basis"] == "planned_stop_loss_spec_rule_10_assumption"
    assert checks["expected_move"] == pytest.approx(3.9993, abs=1e-4)
    assert intent.greeks["vega"] == 0.0  # fixture has no vega; sign handled


def test_selector_does_not_fabricate_short_strangle_without_spot() -> None:
    result = OptionsStrategySelector(constraints=WIDE_DELTA).select(
        setup=_setup(), option_chain=_tlt_chain(spot=None), as_of=TLT_AS_OF,
    )
    assert result.strategy_intent is None
    assert [trade.reason for trade in result.rejected_trades] == [
        "short_strangle rejected by deterministic constraints"
    ]


def test_short_strangle_is_opt_in_for_vol_contraction() -> None:
    assert _strategy_order(_setup("vol_contraction", preferred=["iron_condor"])) == [
        "put_credit_spread", "call_credit_spread", "iron_condor",
    ]
    assert _strategy_order(_setup("vol_contraction"))[-1] == "short_strangle"
    assert _strategy_order(_setup("vol_expansion")) == ["straddle", "strangle"]


# ---------------------------------------------------------------------------
# Definition: source, rules, TLT worked example
# ---------------------------------------------------------------------------


def test_definition_records_source_and_rule_basis() -> None:
    definition = BridgingCyclesShortStrangleDefinition()
    assert definition.research_only is True
    assert definition.strategy_type == "short_strangle"
    assert definition.source.reel_url == "https://www.instagram.com/reel/DeDxRuNgP2F/"
    assert definition.source.knowledge_base_path.endswith(
        "bridgingcycles-instagram/sources/DeDxRuNgP2F.md"
    )
    assert definition.source.spec_path == "docs/specs/strategies/bridgingcycles-short-strangle.md"
    numbers = [rule.number for rule in RULES]
    assert numbers == ["1", "2", "3", "4", "5", "5a", "5b", "6", "7", "7a", "8",
                       "9", "9a", "10", "11", "12"]
    for number in ("5a", "5b", "7a", "9a", "10", "11"):
        assert definition.rule(number).basis == "A"
    for number in ("1", "4", "5", "7", "8", "9"):
        assert definition.rule(number).basis == "S"
    params = definition.params
    assert (params.rv_window_days, params.vrp_lookback_days, params.vrp_entry_percentile) == (
        21, 252, 90.0)
    assert (params.min_dte, params.max_dte, params.time_stop_dte) == (30, 60, 21)
    assert (params.profit_target_fraction, params.stop_loss_multiple, params.contracts) == (
        0.5, 2.0, 1)


def test_tlt_worked_example_strikes() -> None:
    definition = BridgingCyclesShortStrangleDefinition()

    # Creator's stated expected move (~$4) reproduces 73 / 82 exactly.
    stated = definition.select_strikes(
        spot=77.5, implied_vol=0.18, dte=30, listed_strikes=ONE_POINT_GRID, move=4.0,
    )
    assert stated is not None
    assert (stated.put_strike, stated.call_strike) == (73, 82)

    # Rule 7a formula with IV 18% gives ~$4 only at 30 DTE -> 73 / 82.
    formula_30 = definition.select_strikes(
        spot=77.5, implied_vol=0.18, dte=30, listed_strikes=ONE_POINT_GRID,
    )
    assert formula_30 is not None
    assert formula_30.expected_move == pytest.approx(4.0, abs=0.01)
    assert (formula_30.put_strike, formula_30.call_strike) == (73, 82)

    # Documented difference: from the Reel date 2026-10-04 the November monthly
    # is 2026-11-20 (47 DTE); the same formula gives ~$5.01 and 72 / 83.
    assert definition.select_expiry(date(2026, 10, 4)) == NOV_MONTHLY
    formula_47 = definition.select_strikes(
        spot=77.5, implied_vol=0.18, dte=47, listed_strikes=ONE_POINT_GRID,
    )
    assert formula_47 is not None
    assert formula_47.expected_move == pytest.approx(5.006, abs=0.001)
    assert (formula_47.put_strike, formula_47.call_strike) == (72, 83)


def test_monthly_expiry_selection_skips_weeklies() -> None:
    definition = BridgingCyclesShortStrangleDefinition()
    assert third_friday(2026, 11) == NOV_MONTHLY
    assert definition.select_expiry(TLT_AS_OF.date(), [NOV_WEEKLY, NOV_MONTHLY]) == NOV_MONTHLY
    assert definition.select_expiry(TLT_AS_OF.date(), [NOV_WEEKLY]) is None


def test_vrp_percentile_and_entry_filter() -> None:
    definition = BridgingCyclesShortStrangleDefinition()
    current = 0.18 - 0.1025  # transcript example: IV ~18%, RV ~10.25%
    assert vrp_percentile([0.01 * i for i in range(252)], 252) == 100.0
    assert vrp_percentile([0.01 * i for i in range(251)], 252) is None

    extreme = [0.0003 * i for i in range(251)] + [current]  # current is the max
    ok = definition.entry_decision(atm_iv=0.18, realized_vol=0.1025, vrp_history=extreme)
    assert ok.eligible and ok.vrp == pytest.approx(0.0775)
    assert ok.vrp_percentile == 100.0

    ordinary = [0.001 * i for i in range(251)] + [current]  # 79 of 252 <= current
    below = definition.entry_decision(atm_iv=0.18, realized_vol=0.1025, vrp_history=ordinary)
    assert not below.eligible
    assert below.vrp_percentile == pytest.approx(100 * 79 / 252)
    assert below.reasons == ("VRP percentile below entry threshold",)

    no_vrp = definition.entry_decision(
        atm_iv=0.10, realized_vol=0.1025, vrp_history=[-0.1] * 251 + [-0.0025],
    )
    assert not no_vrp.eligible
    assert no_vrp.vrp_percentile == 100.0
    assert no_vrp.reasons == ("no variance risk premium (IV <= RV)",)


# ---------------------------------------------------------------------------
# Simulator on synthetic daily series
# ---------------------------------------------------------------------------

WARMUP = 280  # 21 returns for RV + 252 VRP values, plus margin
STEP = 0.01  # alternating +/-1% log returns -> constant realized vol


def _weekdays(start: date, count: int) -> list[date]:
    days: list[date] = []
    current = start
    while len(days) < count:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return days


def _series(entry_iv: float, *, warm_iv=lambda i: 0.30 - 0.0002 * i,
            extra_days: int = 80) -> list[DailyObservation]:
    """Warm-up VRP strictly falls (low percentile), then the entry-day IV."""

    days = _weekdays(date(2025, 1, 6), WARMUP + 1 + extra_days)
    observations = []
    for index, day in enumerate(days):
        spot = 100.0 * math.exp(STEP if index % 2 else 0.0)
        iv = warm_iv(index) if index < WARMUP else entry_iv
        observations.append(DailyObservation(day=day, spot=spot, atm_iv=iv))
    return observations


def _scripted_marks(entry_day: date, path: dict[int, float], default: float = 1.6):
    """Mark per leg = half of the scripted strangle mark for that day offset."""

    def mark(observation, right, strike, expiry):
        offset = (observation.day - entry_day).days
        if offset == 0:
            return 1.0  # credit 2.0 per share
        return path.get(offset, default) / 2

    return mark


def test_entry_blocked_below_threshold_and_when_iv_not_above_rv() -> None:
    # Mid-range VRP on the candidate day -> percentile far below 90.
    mid = _series(entry_iv=0.30 - 0.0002 * 140, extra_days=0)
    result = simulate_bridgingcycles_short_strangle(mid, _scripted_marks(mid[-1].day, {}))
    assert result.trades == ()
    last = result.signals[-1]
    assert last.vrp is not None and last.vrp > 0
    assert last.vrp_percentile is not None and last.vrp_percentile < 90
    assert last.reasons == ("VRP percentile below entry threshold",)
    assert not any(signal.eligible for signal in result.signals)

    # IV below RV throughout: the last VRP is the highest of the window
    # (percentile 100) but still negative, so rule 12 blocks the entry.
    negative = _series(entry_iv=0.16, warm_iv=lambda i: 0.15 - 0.0002 * i, extra_days=0)
    result = simulate_bridgingcycles_short_strangle(
        negative, _scripted_marks(negative[-1].day, {})
    )
    last = result.signals[-1]
    assert last.realized_volatility == pytest.approx(0.1625, abs=1e-3)
    assert last.vrp is not None and last.vrp < 0
    assert last.vrp_percentile == 100.0
    assert last.reasons == ("no variance risk premium (IV <= RV)",)
    assert result.trades == ()


def _run(path: dict[int, float], **params) -> tuple[list[DailyObservation], object]:
    observations = _series(entry_iv=0.45)
    entry_day = observations[WARMUP].day
    definition = BridgingCyclesShortStrangleDefinition(
        params=BridgingCyclesShortStrangleParams(**params)
    )
    result = simulate_bridgingcycles_short_strangle(
        observations, _scripted_marks(entry_day, path), definition=definition,
    )
    return observations, result


def test_entry_signal_fires_on_extreme_vrp() -> None:
    observations, result = _run({})
    signal = result.signals[WARMUP]
    assert signal.eligible and signal.vrp_percentile == 100.0
    trade = result.trades[0]
    assert trade.entry_day == observations[WARMUP].day
    assert 30 <= trade.entry_dte <= 60
    assert trade.expiry == third_friday(trade.expiry.year, trade.expiry.month)
    assert trade.put_strike <= trade.entry_spot - trade.expected_move
    assert trade.call_strike >= trade.entry_spot + trade.expected_move
    assert trade.entry_credit == 2.0
    assert trade.contracts == 1


def test_exit_on_profit_target() -> None:
    _, result = _run({3: 1.0})
    trade = result.trades[0]
    assert trade.exit_reason == "profit_target"
    assert (trade.exit_day - trade.entry_day).days == 3
    assert trade.pnl == pytest.approx(100.0)


def test_exit_on_stop_loss() -> None:
    _, result = _run({3: 4.0})
    trade = result.trades[0]
    assert trade.exit_reason == "stop_loss"
    assert trade.pnl == pytest.approx(-200.0)


def test_exit_on_time_stop() -> None:
    _, result = _run({})
    trade = result.trades[0]
    assert trade.exit_reason == "time_stop"
    assert (trade.expiry - trade.exit_day).days <= 21
    assert trade.pnl == pytest.approx((2.0 - 1.6) * 100)
    # Exactly one strangle at a time and no re-entry on the exit day.
    assert len({t.entry_day for t in result.trades}) == len(result.trades)


def test_hold_to_expiry_settles_at_intrinsic_when_time_stop_disabled() -> None:
    _, result = _run({}, time_stop_dte=0)
    trade = result.trades[0]
    assert trade.exit_reason == "expiry"
    assert trade.exit_day == trade.expiry
    assert trade.exit_debit == 0.0
    assert trade.pnl == pytest.approx(200.0)


def test_simulator_accepts_chain_snapshots_and_black_scholes_marks() -> None:
    observations = _series(entry_iv=0.45)
    bs = simulate_bridgingcycles_short_strangle(observations, black_scholes_marks())
    assert bs.trades and bs.trades[0].entry_credit > 0
    assert bs.total_pnl == pytest.approx(sum(t.pnl for t in bs.trades))

    # No chain snapshot -> entry skipped with an explicit reason, no trade.
    snap = simulate_bridgingcycles_short_strangle(observations, chain_snapshot_marks)
    assert snap.trades == ()
    assert snap.skipped_entries[0] == (observations[WARMUP].day, "missing entry mark for a leg")


def test_params_validate_assumption_ranges() -> None:
    with pytest.raises(ValueError):
        BridgingCyclesShortStrangleParams(stop_loss_multiple=1.0)
    with pytest.raises(ValueError):
        BridgingCyclesShortStrangleParams(time_stop_dte=30)
    with pytest.raises(ValueError):
        BridgingCyclesShortStrangleParams(vrp_entry_percentile=101)
