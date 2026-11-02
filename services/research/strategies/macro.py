"""Measured vintage-aware macro research; news/knowledge prose is not a signal.

Original user macro strategy links are unavailable in the supplied authority.
This implements an explicit caller-authored policy, not a recovered Crown model
or a calibrated/approved allocator. No cash is reserved and no units are sized.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_DOWN

from .core import (ONE, ZERO, AllocationProposal, count, deterministic, digest_text,
                   fraction, identity, instant, ratio, require_decimal)

ORIGINAL_MACRO_LINKS = ()
ORIGINAL_MACRO_LINKS_STATUS = "missing-original-links-not-supplied"


@dataclass(frozen=True)
class MacroVintage:
    series_id: str
    period_at: datetime
    release_at: datetime
    vintage_at: datetime
    available_at: datetime
    value: Decimal
    unit: str
    source_id: str
    source_hash: str
    measurement_kind: str = "measured"

    def __post_init__(self):
        for value in (self.series_id, self.unit, self.source_id):
            identity(value)
        for value in (self.period_at, self.release_at, self.vintage_at, self.available_at):
            instant(value)
        if not self.period_at <= self.release_at <= self.vintage_at <= self.available_at:
            raise ValueError("Macro period/release/vintage/availability ordering invalid")
        require_decimal(self.value)
        digest_text(self.source_hash)
        if self.measurement_kind not in {"measured", "news", "interpretation"}:
            raise ValueError("Unknown measurement classification")


def vintages_as_of(rows: tuple[MacroVintage, ...], *, series_id: str,
                   as_of: datetime) -> tuple[MacroVintage, ...]:
    instant(as_of)
    identity(series_id)
    selected = {}
    seen = set()
    for row in rows:
        key = (row.series_id, row.period_at, row.vintage_at)
        if key in seen:
            raise ValueError("Duplicate macro vintage identity")
        seen.add(key)
        if row.series_id != series_id or row.measurement_kind != "measured":
            continue
        if row.available_at > as_of or row.vintage_at > as_of or row.release_at > as_of:
            continue
        previous = selected.get(row.period_at)
        if previous is None or (row.vintage_at, row.available_at) > (previous.vintage_at, previous.available_at):
            selected[row.period_at] = row
    return tuple(selected[key] for key in sorted(selected))


@dataclass(frozen=True)
class MacroAxis:
    series_id: str
    unit: str
    positive_change_threshold: Decimal
    maximum_release_age_days: int
    maximum_period_age_days: int

    def __post_init__(self):
        identity(self.series_id)
        identity(self.unit)
        require_decimal(self.positive_change_threshold)
        count(self.maximum_release_age_days)
        count(self.maximum_period_age_days)


@dataclass(frozen=True)
class MacroRegime:
    name: str | None
    as_of: datetime
    growth_change: Decimal | None
    inflation_change: Decimal | None
    evidence: tuple[MacroVintage, ...]
    missing: tuple[str, ...]
    original_links_status: str = ORIGINAL_MACRO_LINKS_STATUS


@deterministic
def classify_regime(rows: tuple[MacroVintage, ...], *, growth: MacroAxis,
                    inflation: MacroAxis, as_of: datetime) -> MacroRegime:
    instant(as_of)
    if growth.series_id == inflation.series_id:
        raise ValueError("Growth and inflation need distinct measured series")
    changes = []
    evidence = []
    missing = []
    for label, axis in (("growth", growth), ("inflation", inflation)):
        series = vintages_as_of(rows, series_id=axis.series_id, as_of=as_of)
        if len(series) < 2:
            missing.append(label + "-two-point-vintage-history-unavailable")
            changes.append(None)
            continue
        prior, latest = series[-2:]
        if prior.unit != axis.unit or latest.unit != axis.unit:
            missing.append(label + "-units-mismatch")
        if (as_of - latest.release_at).total_seconds() > axis.maximum_release_age_days * 86_400:
            missing.append(label + "-release-stale")
        if (as_of - latest.period_at).total_seconds() > axis.maximum_period_age_days * 86_400:
            missing.append(label + "-period-stale")
        changes.append(latest.value - prior.value)
        evidence.extend((prior, latest))
    if missing:
        return MacroRegime(None, as_of, changes[0], changes[1], tuple(evidence), tuple(missing))
    growth_up = changes[0] > growth.positive_change_threshold
    inflation_up = changes[1] > inflation.positive_change_threshold
    name = {(True, False): "expansion", (True, True): "reflation",
            (False, True): "stagflation", (False, False): "slowdown"}[(growth_up, inflation_up)]
    return MacroRegime(name, as_of, changes[0], changes[1], tuple(evidence), ())


@dataclass(frozen=True)
class MacroAllocationPolicy:
    policy_id: str
    weights_by_regime: tuple[tuple[str, tuple[tuple[str, Decimal], ...]], ...]
    maximum_instrument_weight: Decimal
    maximum_risky_weight: Decimal
    maximum_one_way_turnover: Decimal
    minimum_rebalance_drift: Decimal
    minimum_rebalance_seconds: int
    cash_instrument_id: str

    @deterministic
    def __post_init__(self):
        identity(self.policy_id)
        identity(self.cash_instrument_id)
        for value in (self.maximum_instrument_weight, self.maximum_risky_weight,
                      self.maximum_one_way_turnover, self.minimum_rebalance_drift):
            fraction(value)
        count(self.minimum_rebalance_seconds)
        names = [name for name, _ in self.weights_by_regime]
        if set(names) != {"expansion", "reflation", "stagflation", "slowdown"} or len(names) != 4:
            raise ValueError("All four regimes require unique explicit target weights")
        for _, weights in self.weights_by_regime:
            AllocationProposal("macro", weights, ())
            if any(key == self.cash_instrument_id for key, _ in weights):
                raise ValueError("Cash is the residual, not an independently set target")
            if any(weight > self.maximum_instrument_weight for _, weight in weights):
                raise ValueError("Regime target exceeds instrument cap")
            if sum((weight for _, weight in weights), ZERO) > self.maximum_risky_weight:
                raise ValueError("Regime target exceeds risky-weight cap")


@dataclass(frozen=True)
class RebalancePlan:
    allocation: AllocationProposal
    previous_weights: tuple[tuple[str, Decimal], ...]
    desired_weights: tuple[tuple[str, Decimal], ...]
    one_way_turnover: Decimal | None
    limited_by_turnover: bool
    original_links_status: str = ORIGINAL_MACRO_LINKS_STATUS


@deterministic
def plan_rebalance(regime: MacroRegime, *, current_weights: tuple[tuple[str, Decimal], ...] | None,
                   policy: MacroAllocationPolicy, as_of: datetime,
                   last_rebalance_at: datetime | None,
                   rebalance_due: bool) -> RebalancePlan:
    instant(as_of)
    if type(rebalance_due) is not bool:
        raise ValueError("Explicit injected calendar rebalance decision required")
    if last_rebalance_at is not None:
        instant(last_rebalance_at)
        if last_rebalance_at > as_of:
            raise ValueError("Future rebalance history")
    missing = list(regime.missing)
    if regime.name is None or regime.as_of > as_of:
        missing.append("macro-regime-unavailable-as-of")
    if current_weights is None:
        missing.append("reconciled-current-weights-unavailable")
    if missing:
        return RebalancePlan(AllocationProposal("macro", (), tuple(missing), "unavailable"), (), (), None, False)
    AllocationProposal("macro", current_weights, ())
    current = dict(current_weights)
    if policy.cash_instrument_id in current:
        raise ValueError("Supply risky weights only; cash is derived consistently")
    current[policy.cash_instrument_id] = ONE - sum(current.values(), ZERO)
    desired = dict(dict(policy.weights_by_regime)[regime.name])
    desired[policy.cash_instrument_id] = ONE - sum(desired.values(), ZERO)
    keys = sorted(set(current) | set(desired))
    gross = sum((abs(desired.get(key, ZERO) - current.get(key, ZERO)) for key in keys), ZERO)
    turnover = gross / 2
    prior = tuple((key, current.get(key, ZERO)) for key in keys)
    targets = tuple((key, desired.get(key, ZERO)) for key in keys)
    cooldown = last_rebalance_at is not None and (as_of - last_rebalance_at).total_seconds() < policy.minimum_rebalance_seconds
    if not rebalance_due or cooldown or turnover < policy.minimum_rebalance_drift or turnover == ZERO:
        return RebalancePlan(AllocationProposal("macro", prior, ("rebalance-not-due-or-below-drift",), "hold"),
                             prior, targets, ZERO, False)
    limited = turnover > policy.maximum_one_way_turnover
    scale = min(ONE, policy.maximum_one_way_turnover / turnover)
    proposed = {}
    quantum = Decimal("0.000000000000000001")
    for key in keys:
        if key == policy.cash_instrument_id:
            continue
        delta = (desired.get(key, ZERO) - current.get(key, ZERO)) * scale
        # Round deltas toward zero, preserving the turnover ceiling.
        proposed[key] = current.get(key, ZERO) + delta.quantize(quantum, rounding=ROUND_DOWN)
    proposed[policy.cash_instrument_id] = ONE - sum(proposed.values(), ZERO)
    actual_turnover = sum((abs(proposed.get(key, ZERO) - current.get(key, ZERO)) for key in keys), ZERO) / 2
    risky = {key: weight for key, weight in proposed.items() if key != policy.cash_instrument_id}
    if any(weight > policy.maximum_instrument_weight for weight in risky.values()) or sum(risky.values(), ZERO) > policy.maximum_risky_weight:
        return RebalancePlan(AllocationProposal("macro", (), ("risk-cap-conflicts-with-turnover-limit-review-required",), "unavailable"),
                             prior, targets, None, limited)
    return RebalancePlan(AllocationProposal("macro", tuple(sorted(proposed.items())),
                                           ("vintage-aware-measured-policy", ORIGINAL_MACRO_LINKS_STATUS,
                                            "new-native-policy-not-original-strategy-reproduction")),
                         prior, targets, ratio(actual_turnover, ONE), limited)
