"""Unexecuted synthetic vintage/rebalance cases; original macro links not invented."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from strategies.macro import (MacroAllocationPolicy, MacroAxis, MacroVintage, ORIGINAL_MACRO_LINKS,
                              classify_regime, plan_rebalance, vintages_as_of)

D = Decimal
NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)


def observation(series, value, offset):
    period = NOW - timedelta(days=offset + 2)
    release = NOW - timedelta(days=offset)
    return MacroVintage(series, period, release, release, release, D(value), "index", "source", "a" * 64)


def rows():
    return (observation("growth", "100", 30), observation("growth", "102", 1),
            observation("inflation", "100", 30), observation("inflation", "99", 1))


def axis(series):
    return MacroAxis(series, "index", D("0"), 40, 50)


def regime():
    return classify_regime(rows(), growth=axis("growth"), inflation=axis("inflation"), as_of=NOW)


def policy(turnover="0.1"):
    weights = (("expansion", (("EQUITY", D("0.6")),)),
               ("reflation", (("EQUITY", D("0.4")), ("BONDS", D("0.2")))),
               ("stagflation", (("BONDS", D("0.3")),)),
               ("slowdown", (("BONDS", D("0.5")),)))
    return MacroAllocationPolicy("explicit-policy", weights, D("0.7"), D("0.8"),
                                 D(turnover), D("0.01"), 3600, "CASH")


def test_macro_as_of_rejects_later_vintage_and_news_substitution():
    original = rows()[1]
    future = replace(original, value=D("80"), vintage_at=NOW + timedelta(days=1), available_at=NOW + timedelta(days=1))
    selected = vintages_as_of((*rows(), future), series_id="growth", as_of=NOW)
    assert selected[-1] == original
    revised = vintages_as_of((*rows(), future), series_id="growth", as_of=NOW + timedelta(days=2))
    assert revised[-1] == future
    news = replace(original, measurement_kind="news")
    assert vintages_as_of((news,), series_id="growth", as_of=NOW) == ()


def test_measured_regime_keeps_units_and_missing_original_links():
    result = regime()
    assert result.name == "expansion"
    assert result.growth_change == D("2")
    assert result.inflation_change == D("-1")
    assert result.original_links_status == "missing-original-links-not-supplied"
    assert ORIGINAL_MACRO_LINKS == ()
    missing = classify_regime(rows()[:2], growth=axis("growth"), inflation=axis("inflation"), as_of=NOW)
    assert missing.name is None
    wrong = replace(rows()[1], unit="percent")
    assert "growth-units-mismatch" in classify_regime((rows()[0], wrong, *rows()[2:]),
           growth=axis("growth"), inflation=axis("inflation"), as_of=NOW).missing


def test_turnover_is_one_way_including_cash_and_never_executes():
    result = plan_rebalance(regime(), current_weights=(), policy=policy(), as_of=NOW,
                            last_rebalance_at=None, rebalance_due=True)
    assert result.limited_by_turnover is True
    assert result.one_way_turnover <= D("0.1")
    weights = dict(result.allocation.target_weights)
    assert weights["EQUITY"] == D("0.1")
    assert weights["CASH"] == D("0.9")
    assert sum(weights.values(), D("0")) == D("1")
    assert result.allocation.reserves_cash is False


def test_rebalance_cooldown_and_explicit_calendar_schedule():
    for due, last in ((False, None), (True, NOW - timedelta(seconds=1))):
        result = plan_rebalance(regime(), current_weights=(), policy=policy(), as_of=NOW,
                                last_rebalance_at=last, rebalance_due=due)
        assert result.allocation.status == "hold"
        assert result.one_way_turnover == D("0")


def test_unknown_portfolio_is_unavailable_not_zero_and_cap_conflict_is_explicit():
    result = plan_rebalance(regime(), current_weights=None, policy=policy(), as_of=NOW,
                            last_rebalance_at=None, rebalance_due=True)
    assert result.allocation.status == "unavailable"
    result = plan_rebalance(regime(), current_weights=(("EQUITY", D("0.99")),),
                            policy=policy("0.01"), as_of=NOW, last_rebalance_at=None, rebalance_due=True)
    assert "risk-cap-conflicts-with-turnover-limit-review-required" in result.allocation.reasons


def test_duplicate_vintage_and_unbounded_targets_rejected():
    with pytest.raises(ValueError, match="Duplicate"):
        vintages_as_of((rows()[0], rows()[0]), series_id="growth", as_of=NOW)
    with pytest.raises(ValueError, match="instrument cap"):
        replace(policy(), maximum_instrument_weight=D("0.1"))
