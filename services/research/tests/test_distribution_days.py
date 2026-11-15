"""Smoke tests for the IBD distribution-day port (synthetic daily bars only)."""
import ast
from datetime import date, timedelta
from pathlib import Path

import pytest

from strategies.distribution_days import (
    DailyBar,
    DistributionDayError,
    DistributionDayRule,
    IndexPosture,
    RiskThresholds,
    classify_risk,
    combine_index_risks,
    count_active,
    distribution_days,
    index_posture,
)


def bars(changes):
    """Chronological bars from (pct_change, volume) steps; close starts at 100, high = close."""
    close, start, out = 100.0, date(2026, 1, 1), [DailyBar("2026-01-01", 100.0, 100.0, 1000.0)]
    for index, (pct, volume) in enumerate(changes, start=1):
        close *= 1 + pct
        out.append(DailyBar((start + timedelta(days=index)).isoformat(), close, close, volume))
    return out


QUIET = (0.001, 1000.0)
DD = (-0.005, 1500.0)


def test_detects_active_day_with_age_and_window_counts():
    series = bars([QUIET] * 59 + [DD, QUIET, QUIET])
    days, skipped = distribution_days(series)
    assert skipped == ()
    assert [(d.age_sessions, d.status) for d in days] == [(2, "active")]
    assert days[0].pct_change == pytest.approx(-0.005)
    assert days[0].volume_change_pct == pytest.approx(0.5)
    posture = index_posture("QQQ", series)
    assert (posture.d5_count, posture.d15_count, posture.d25_count) == (1, 1, 1)
    assert posture.is_distribution_day_today is False
    assert posture.risk_level == "NORMAL"
    assert posture.market_below_ma is False


def test_decline_on_lower_volume_or_small_decline_is_not_counted():
    assert distribution_days(bars([QUIET] * 5 + [(-0.01, 900.0)]))[0] == ()
    assert distribution_days(bars([QUIET] * 5 + [(-0.001, 2000.0)]))[0] == ()


def test_five_percent_gain_after_the_day_invalidates_it():
    days, _ = distribution_days(bars([QUIET] * 5 + [DD] + [(0.02, 1000.0)] * 5))
    assert [(d.date, d.status) for d in days] == [("2026-01-07", "invalidated")]
    assert days[0].invalidation_date == "2026-01-10"  # the first session at +5% (third bar after), not a later one


def test_days_older_than_25_sessions_expire():
    days, _ = distribution_days(bars([QUIET] * 5 + [DD] + [(0.0005, 1000.0)] * 25))
    assert [(d.age_sessions, d.status, d.expires_in_sessions) for d in days] == [(25, "active", 0)]
    assert count_active(days, 25) == 1
    days, _ = distribution_days(bars([QUIET] * 5 + [DD] + [(0.0005, 1000.0)] * 26))
    assert [(d.age_sessions, d.status) for d in days] == [(26, "expired")]
    assert count_active(days, 25) == 0


def test_cluster_raises_risk_level():
    two_recent = bars([QUIET] * 59 + [DD, QUIET, DD, QUIET])
    assert index_posture("SPY", two_recent).risk_level == "HIGH"  # d5 >= 2
    three_spread = bars([QUIET] * 40 + [DD] + [QUIET] * 7 + [DD] + [QUIET] * 7 + [DD] + [QUIET] * 7)
    posture = index_posture("SPY", three_spread)
    assert (posture.d5_count, posture.d25_count) == (0, 3)
    assert posture.risk_level == "CAUTION"


def test_classify_and_combine_follow_upstream_policy():
    assert classify_risk(0, 4, 4, None) == "SEVERE"
    assert classify_risk(0, 0, 5, True) == "SEVERE"
    assert classify_risk(0, 0, 5, None) == "HIGH"

    def posture(symbol, level):
        return IndexPosture(symbol, "2026-01-01", False, 0, 0, 0, None, None, None, level, (), ())

    assert combine_index_risks([posture("QQQ", "NORMAL"), posture("SPY", "HIGH")]) == "HIGH"
    assert combine_index_risks([posture("QQQ", "CAUTION"), posture("SPY", "CAUTION")]) == "HIGH"
    assert combine_index_risks([posture("QQQ", "CAUTION"), posture("SPY", "NORMAL")]) == "CAUTION"
    assert combine_index_risks([posture("IWM", "SEVERE")]) == "SEVERE"


def test_short_history_has_unknown_ma_filter_and_bad_order_is_rejected():
    assert index_posture("QQQ", bars([QUIET] * 10)).market_below_ma is None
    series = bars([QUIET] * 3)
    with pytest.raises(DistributionDayError):
        index_posture("QQQ", list(reversed(series)))
    gap = series[:2] + [DailyBar(series[2].date, None, None, None)] + series[3:]
    assert len(distribution_days(gap)[1]) == 2  # both pairs that touch the missing bar are skipped


def test_old_bad_close_keeps_ma_filter_and_duplicate_symbols_are_rejected():
    series = bars([QUIET] * 70)
    series[2] = DailyBar(series[2].date, None, None, None)
    assert index_posture("QQQ", series).market_below_ma is False
    level = IndexPosture("QQQ", "2026-01-01", False, 0, 0, 0, None, None, None, "HIGH", (), ())
    with pytest.raises(DistributionDayError):
        combine_index_risks([level, level])


def test_short_history_sets_the_upstream_audit_flags():
    short = index_posture("QQQ", bars([QUIET] * 10))
    assert short.audit_flags == ("insufficient_lookback", "insufficient_data_for_moving_average")
    assert short.risk_level == "NORMAL"  # the level alone does not show the short history
    assert index_posture("QQQ", bars([QUIET] * 49)).audit_flags == ()  # 50 bars: both averages and the window


def test_non_default_rule_and_thresholds_follow_the_upstream_fields():
    quiet_day = DailyBar("2026-01-03", 105.0, 100.0, 1000.0)  # the high is 5% above the day before; the close is not
    series = [DailyBar("2026-01-01", 100.0, 100.0, 1000.0), DailyBar("2026-01-02", 99.5, 99.5, 1500.0), quiet_day]
    by_high, _ = distribution_days(series)
    by_close, _ = distribution_days(series, DistributionDayRule(invalidation_price_source="close"))
    assert [(day.status, day.invalidation_date) for day in by_high] == [("invalidated", "2026-01-03")]
    assert [(day.status, day.invalidation_date) for day in by_close] == [("active", None)]
    assert classify_risk(0, 0, 1, None) == "NORMAL"
    assert classify_risk(0, 0, 1, None, RiskThresholds(caution_d25=1)) == "CAUTION"
    with pytest.raises(DistributionDayError):
        distribution_days(series, DistributionDayRule(invalidation_price_source="low"))  # type: ignore[arg-type]


def test_module_imports_only_the_standard_library_and_indicators():
    source = Path(__file__).resolve().parents[1] / "strategies" / "distribution_days.py"
    tree = ast.parse(source.read_text())
    modules = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    modules |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
    assert modules <= {"__future__", "math", "collections", "dataclasses", "typing", "indicators"}


def test_exact_minimum_decline_counts():
    series = [DailyBar("2026-01-01", 100.0, 100.0, 1000.0), DailyBar("2026-01-02", 99.8, 99.8, 1500.0)]
    assert [day.date for day in distribution_days(series)[0]] == ["2026-01-02"]  # exactly -0.2%
    series[1] = DailyBar("2026-01-02", 99.81, 99.81, 1500.0)
    assert distribution_days(series)[0] == ()


def test_bars_out_of_order_or_with_equal_dates_are_rejected_by_both_functions():
    series = bars([QUIET] * 3)
    equal_dates = series[:2] + [DailyBar(series[1].date, 100.0, 100.0, 1000.0)]
    for bad in (list(reversed(series)), equal_dates):
        with pytest.raises(DistributionDayError):
            distribution_days(bad)
        with pytest.raises(DistributionDayError):
            index_posture("QQQ", bad)


def test_market_below_ma_needs_a_close_below_both_averages():
    falling = index_posture("QQQ", bars([(-0.003, 1000.0)] * 60))  # equal volume: no distribution day
    assert (falling.close_above_ema, falling.close_above_sma, falling.market_below_ma) == (False, False, True)
    assert falling.d25_count == 0
    dip = index_posture("QQQ", bars([(0.01, 1000.0)] * 60 + [(-0.02, 1000.0)] * 6))
    assert (dip.close_above_ema, dip.close_above_sma, dip.market_below_ma) == (False, True, False)


def test_unknown_level_is_rejected():
    level = IndexPosture("QQQ", "2026-01-01", False, 0, 0, 0, None, None, None, "EXTREME", (), ())  # type: ignore[arg-type]
    with pytest.raises(DistributionDayError):
        combine_index_risks([level])
