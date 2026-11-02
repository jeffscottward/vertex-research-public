"""Offline event-study orchestration with explicit timing and source segmentation.

Result layout and [-250,-11]/[0,1,5,20] windows adapted from AI Hedge Fund
v2/event_study/models.py and engine.py. Copyright (c) 2024 Virat Singh; MIT
notice in AI_HEDGE_FUND_LICENSE.txt. Exact original source hashes are recorded
in QuantReplayBuild-v1.json. No provider client, date.today(), fetch, plotting,
CLI or original source is executed by this module.

Timing review: filing-date-only anchors and later quarterly EPS surprise labels
cannot establish announcement availability. This implementation requires precise
publication/availability timestamps and an explicit anchor policy; dated-only
filings remain inconclusive. Source types and anchor policies are never pooled.
"""
from __future__ import annotations

import hashlib
import math
import statistics
from dataclasses import dataclass
from datetime import datetime

from .event_stats import (
    BootstrapCI, MarketModelFit, NumericInconclusive, NumericUnavailable,
    TTestResult, bootstrap_ci, compute_abnormal_returns, fit_market_model, sum_car, ttest_cars,
)
from .lineage import Pin
from .ports import require_hash, require_id, utc

LIMITATIONS = (
    "Descriptive event association, not causal identification or executable strategy economics.",
    "Close-to-close returns can include pre-announcement movement; after-close events use a later session.",
    "No transaction cost, fill, borrow, margin, settlement or capital model is computed here.",
    "IID t-test and percentile bootstrap do not correct serial dependence, issuer clustering or multiple testing.",
    "Provider rights, return adjustments, delisted-universe coverage and timestamp accuracy require external evidence.",
)


@dataclass(frozen=True)
class ReturnObservation:
    session_open: datetime
    session_close: datetime
    available_at: datetime
    stock_return: float
    market_return: float
    source_digest: str

    def __post_init__(self) -> None:
        for name in ("session_open", "session_close", "available_at"):
            object.__setattr__(self, name, utc(getattr(self, name)))
        if not self.session_open < self.session_close <= self.available_at:
            raise ValueError("return observation availability/order invalid")
        if not all(math.isfinite(value) for value in (self.stock_return, self.market_return)):
            raise ValueError("finite aligned returns required")
        require_hash(self.source_digest)


@dataclass(frozen=True)
class EventInput:
    event_id: str
    ticker: str
    source_type: str
    report_period: str
    source_digest: str
    published_at: datetime | None
    available_at: datetime | None
    anchor_policy: str
    returns: tuple[ReturnObservation, ...]
    calendar_pin: Pin
    adjustment_policy_pin: Pin
    citation_ids: tuple[str, ...]
    eps_surprise: str | None = None
    eps_available_at: datetime | None = None

    def __post_init__(self) -> None:
        for identity in (self.event_id, self.ticker, self.source_type, self.report_period):
            require_id(identity)
        require_hash(self.source_digest)
        for name in ("published_at", "available_at", "eps_available_at"):
            if getattr(self, name) is not None:
                object.__setattr__(self, name, utc(getattr(self, name)))
        object.__setattr__(self, "returns", tuple(self.returns))
        object.__setattr__(self, "citation_ids", tuple(self.citation_ids))
        for value in self.citation_ids:
            require_id(value)
        if self.anchor_policy not in {"first-close-after-availability", "first-open-after-availability"}:
            raise ValueError("explicit event timing policy required")
        if self.eps_surprise not in {None, "BEAT", "MISS", "MEET"}:
            raise ValueError("unknown EPS surprise segmentation")


@dataclass(frozen=True)
class EventCAR:
    request: EventInput
    status: str
    anchor_at: datetime | None
    market_model: MarketModelFit | None
    daily_ar: tuple[float, ...]
    car_0_1: float | None
    car_0_5: float | None
    car_0_20: float | None
    eps_surprise_used: str | None
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class WindowStats:
    window: str
    n_events: int
    mean_car: float | None
    std_car: float | None
    ttest: TTestResult | None
    ci: BootstrapCI | None
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class AggregateResult:
    source_type: str
    anchor_policy: str
    eps_surprise: str | None
    n_events: int
    windows: tuple[WindowStats, ...]


@dataclass(frozen=True)
class EventStudyResult:
    events: tuple[EventCAR, ...]
    aggregates: tuple[AggregateResult, ...]
    skipped_event_ids: tuple[str, ...]
    as_of: datetime
    random_seed: int
    limitations: tuple[str, ...] = LIMITATIONS
    realism_qualified: bool = False
    economics_simulated: bool = False


def _unavailable(event: EventInput, reason: str, status: str = "inconclusive") -> EventCAR:
    return EventCAR(event, status, None, None, (), None, None, None, None, (reason,))


def study_event(event: EventInput, *, as_of: datetime) -> EventCAR:
    """Evaluate supplied aligned returns only; outcomes never become input evidence."""
    as_of = utc(as_of)
    if len(event.returns) > 5000:
        return _unavailable(event, "return-resource-budget-exceeded", "rejected")
    if event.published_at is None or event.available_at is None:
        return _unavailable(event, "precise-publication-and-availability-required")
    if not event.published_at <= event.available_at <= as_of:
        return _unavailable(event, "event-availability-invalid", "rejected")
    if not event.citation_ids:
        return _unavailable(event, "event-citations-required")
    if any(left.session_close >= right.session_open for left, right in zip(event.returns, event.returns[1:])):
        return _unavailable(event, "duplicate-overlapping-or-unsorted-return-sessions", "rejected")
    anchor_index = next((index for index, value in enumerate(event.returns) if (
        value.session_close > event.available_at if event.anchor_policy == "first-close-after-availability"
        else value.session_open >= event.available_at
    )), None)
    if anchor_index is None:
        return _unavailable(event, "event-session-not-available")
    # Source window inclusive [-250,-11]; at least 200 observations. No fitting
    # on event-window returns, revisions released after announcement, or outcomes.
    start, stop = max(0, anchor_index - 250), anchor_index - 10
    if stop <= start or stop - start < 200:
        return _unavailable(event, "insufficient-pre-event-estimation-window")
    estimation = event.returns[start:stop]
    if any(value.available_at > event.available_at for value in estimation):
        return _unavailable(event, "estimation-revision-unavailable-at-event", "rejected")
    post = event.returns[anchor_index:anchor_index + 21]
    # A contiguous prefix only: dropping unavailable interior sessions would
    # falsely shorten the declared trading-day horizon.
    observed: list[ReturnObservation] = []
    for value in post:
        if value.available_at > as_of:
            break
        observed.append(value)
    if not observed:
        return _unavailable(event, "post-event-outcomes-not-yet-observable")
    try:
        model = fit_market_model(
            tuple(value.stock_return for value in estimation),
            tuple(value.market_return for value in estimation),
        )
        daily = compute_abnormal_returns(
            tuple(value.stock_return for value in observed), tuple(value.market_return for value in observed),
            model.alpha, model.beta,
        )
        cars = tuple(sum_car(daily, 0, end) if len(daily) > end else None for end in (1, 5, 20))
        reasons: list[str] = []
        if any(value is None for value in cars):
            reasons.append("incomplete-event-horizon-retained")
        eps = event.eps_surprise
        if eps is not None and (event.eps_available_at is None or event.eps_available_at > event.available_at):
            eps = None
            reasons.append("later-eps-label-not-used-for-segmentation")
        anchor = event.returns[anchor_index]
        return EventCAR(
            event, "descriptive", anchor.session_close if event.anchor_policy == "first-close-after-availability" else anchor.session_open,
            model, daily, cars[0], cars[1], cars[2], eps, tuple(reasons),
        )
    except NumericUnavailable:
        return _unavailable(event, "optional-numeric-backend-unavailable", "unavailable")
    except (NumericInconclusive, ArithmeticError, ValueError):
        return _unavailable(event, "numeric-estimation-inconclusive")


def event_study(
    events: tuple[EventInput, ...], *, as_of: datetime, random_seed: int,
    n_bootstrap: int = 10_000, maximum_bootstrap_draws: int = 5_000_000,
) -> EventStudyResult:
    """Keep every rejected event; segment by source/timing/known EPS label.

    Seed per segment/window derives from the explicit root seed and immutable
    segment labels. Reordering groups cannot change the bootstrap sequence.
    """
    as_of = utc(as_of)
    if not 1 <= len(events) <= 128 or sum(len(event.returns) for event in events) > 250_000:
        raise ValueError("event-study resource budget exceeded")
    if len({event.event_id for event in events}) != len(events):
        raise ValueError("duplicate event identity")
    if type(random_seed) is not int or not 0 <= random_seed <= 2**32 - 1:
        raise ValueError("bounded deterministic seed required")
    if type(n_bootstrap) is not int or not 2 <= n_bootstrap <= 100_000:
        raise ValueError("bootstrap replicate budget invalid")
    if type(maximum_bootstrap_draws) is not int or not 1 <= maximum_bootstrap_draws <= 10_000_000:
        raise ValueError("total bootstrap draw budget invalid")
    results = tuple(study_event(event, as_of=as_of) for event in events)
    groups: dict[tuple[str, str, str], list[EventCAR]] = {}
    for result in results:
        if result.status == "descriptive":
            key = (result.request.source_type, result.request.anchor_policy, result.eps_surprise_used or "unknown")
            groups.setdefault(key, []).append(result)
    aggregates: list[AggregateResult] = []
    remaining = maximum_bootstrap_draws
    for key, group in sorted(groups.items()):
        windows: list[WindowStats] = []
        for label, attribute in (("[0,+1]", "car_0_1"), ("[0,+5]", "car_0_5"), ("[0,+20]", "car_0_20")):
            values = tuple(getattr(result, attribute) for result in group if getattr(result, attribute) is not None)
            reasons: list[str] = []
            test: TTestResult | None = None
            interval: BootstrapCI | None = None
            if len(values) < 2:
                reasons.append("insufficient-cross-sectional-events")
            else:
                try:
                    test = ttest_cars(values)
                    if test.status == "inconclusive":
                        reasons.append("t-test-degenerate")
                    draws = len(values) * n_bootstrap
                    if draws > remaining:
                        reasons.append("total-bootstrap-budget-exhausted")
                    else:
                        seed_material = ":".join((str(random_seed), *key, label)).encode("utf-8")
                        seed = int.from_bytes(hashlib.sha256(seed_material).digest()[:4], "big")
                        interval = bootstrap_ci(values, n_bootstrap=n_bootstrap, rng_seed=seed, maximum_draws=remaining)
                        remaining -= draws
                except NumericUnavailable:
                    reasons.append("optional-statistical-backend-unavailable")
                except (NumericInconclusive, ArithmeticError, ValueError):
                    reasons.append("cross-sectional-statistics-inconclusive")
            windows.append(WindowStats(
                label, len(values), statistics.fmean(values) if values else None,
                statistics.stdev(values) if len(values) >= 2 else None, test, interval, tuple(reasons),
            ))
        aggregates.append(AggregateResult(key[0], key[1], None if key[2] == "unknown" else key[2], len(group), tuple(windows)))
    return EventStudyResult(
        results, tuple(aggregates), tuple(item.request.event_id for item in results if item.status != "descriptive"), as_of, random_seed,
    )
