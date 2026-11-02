"""Synthetic event-study regression source only; optional numeric tests unexecuted.

Full numerical cases require separately approved numpy/scipy optional dependencies.
No installs, provider inputs, source execution or test runs were performed.
"""
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from backtesting.event_stats import (
    NumericInconclusive, NumericUnavailable, bootstrap_ci, compute_abnormal_returns,
    fit_market_model, sum_car, ttest_cars,
)
from backtesting.event_study import EventInput, ReturnObservation, event_study, study_event
from backtesting.lineage import Pin


def synthetic_event(source_type="8-K", policy="first-close-after-availability"):
    start = datetime(2024, 1, 1, 14, tzinfo=UTC)
    returns = tuple(ReturnObservation(
        start + timedelta(days=index), start + timedelta(days=index, hours=7),
        start + timedelta(days=index, hours=7, minutes=1),
        0.001 + 1.2 * ((index % 7 - 3) / 1000) + (0.005 if index >= 250 else 0),
        (index % 7 - 3) / 1000, "a" * 64,
    ) for index in range(272))
    # Calendar is intentionally synthetic. No exchange-calendar qualification.
    anchor = returns[250].session_open + timedelta(hours=1)
    return EventInput(
        "event-a", "SYN", source_type, "2024-Q1", "b" * 64, anchor, anchor,
        policy, returns, Pin("synthetic-calendar", "1.0.0", "c" * 64),
        Pin("synthetic-unadjusted", "1.0.0", "d" * 64), ("synthetic-citation",),
    )


def test_pure_abnormal_return_and_inclusive_car_math():
    values = compute_abnormal_returns((0.04, 0.05, 0.01), (0.01, 0.02, 0), 0.01, 2)
    assert values == pytest.approx((0.01, 0, 0))
    assert sum_car((1, 2, 3), 0, 1) == 3
    with pytest.raises(NumericInconclusive):
        sum_car((1, 2), 0, 2)
    with pytest.raises(NumericInconclusive):
        compute_abnormal_returns((0.1,), (0.1, 0.2), 0, 1)
    with pytest.raises(NumericInconclusive):
        sum_car((float("nan"),), 0, 0)


def test_insufficient_or_degenerate_ttest_is_inconclusive_not_zero_pvalue():
    assert ttest_cars(()).status == "inconclusive"
    assert ttest_cars((1,)).p_value is None
    assert ttest_cars((1, 1, 1)).t_stat is None


def test_bootstrap_rejects_missing_reproducibility_and_resource_overruns():
    with pytest.raises(NumericInconclusive):
        bootstrap_ci((0.1, 0.2), rng_seed=-1)
    with pytest.raises(NumericInconclusive):
        bootstrap_ci((0.1, 0.2), rng_seed=1, n_bootstrap=100, maximum_draws=10)
    with pytest.raises(NumericInconclusive):
        bootstrap_ci((0.1, 0.2), rng_seed=1, confidence=1)


def test_date_only_and_post_asof_filings_are_retained_not_timing_qualified():
    event = synthetic_event()
    result = study_event(replace(event, published_at=None, available_at=None), as_of=event.returns[-1].available_at)
    assert result.status == "inconclusive"
    assert result.request.event_id == event.event_id
    assert result.reasons == ("precise-publication-and-availability-required",)
    future = study_event(event, as_of=event.available_at - timedelta(seconds=1))
    assert future.status == "rejected"


def test_future_revision_and_unsorted_returns_fail_before_numeric_backend():
    event = synthetic_event()
    revised = replace(event.returns[10], available_at=event.available_at + timedelta(days=1))
    result = study_event(replace(event, returns=(*event.returns[:10], revised, *event.returns[11:])), as_of=event.returns[-1].available_at)
    assert result.reasons == ("estimation-revision-unavailable-at-event",)
    unordered = replace(event, returns=(event.returns[1], event.returns[0], *event.returns[2:]))
    assert study_event(unordered, as_of=event.returns[-1].available_at).status == "rejected"


def test_missing_optional_backend_preserves_unavailable_event(monkeypatch):
    import backtesting.event_stats as stats_module
    def unavailable():
        raise NumericUnavailable("synthetic missing backend")
    monkeypatch.setattr(stats_module, "_numpy", unavailable)
    event = synthetic_event()
    result = event_study((event,), as_of=event.returns[-1].available_at, random_seed=7)
    assert result.events[0].status == "unavailable"
    assert result.skipped_event_ids == (event.event_id,)
    assert result.realism_qualified is False
    assert result.economics_simulated is False


def test_optional_backend_ols_abnormal_returns_and_bootstrap_reproducibility():
    # Requires the optional numerical dependencies; no implicit installation or
    # skip disguises their absence as verification in the deferred full gate.
    market = (-0.02, -0.01, 0, 0.01, 0.02)
    model = fit_market_model(tuple(0.001 + 1.5 * value for value in market), market)
    assert model.alpha == pytest.approx(0.001)
    assert model.beta == pytest.approx(1.5)
    assert model.r_squared == pytest.approx(1)
    first = bootstrap_ci((0.01, 0.02, -0.01, 0.03), rng_seed=9, n_bootstrap=100)
    second = bootstrap_ci((0.01, 0.02, -0.01, 0.03), rng_seed=9, n_bootstrap=100)
    assert first == second
    assert ttest_cars((0.01, 0.02, -0.01, 0.03)).status == "descriptive"
    with pytest.raises(NumericInconclusive):
        fit_market_model((0.01, 0.02, 0.03), (0, 0, 0))


def test_optional_backend_after_close_anchor_and_late_eps_segmentation():
    event = synthetic_event()
    after_close = event.returns[250].session_close + timedelta(minutes=2)
    event = replace(event, published_at=after_close, available_at=after_close,
                    eps_surprise="BEAT", eps_available_at=after_close + timedelta(days=2))
    result = study_event(event, as_of=event.returns[-1].available_at)
    assert result.status == "descriptive"
    assert result.anchor_at == event.returns[251].session_close
    assert result.eps_surprise_used is None
    assert "later-eps-label-not-used-for-segmentation" in result.reasons


def test_optional_backend_source_types_and_anchor_policies_never_pooled():
    event = synthetic_event()
    second = replace(synthetic_event("10-Q"), event_id="event-b")
    third = replace(synthetic_event(policy="first-open-after-availability"), event_id="event-c")
    result = event_study((event, second, third), as_of=event.returns[-1].available_at, random_seed=7, n_bootstrap=100)
    assert len(result.aggregates) == 3
    assert all(group.n_events == 1 for group in result.aggregates)
    assert all(window.ci is None for group in result.aggregates for window in group.windows)
    assert all("insufficient-cross-sectional-events" in window.reasons for group in result.aggregates for window in group.windows)
