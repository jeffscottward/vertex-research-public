"""Point-in-time fundamental research and explicitly versioned thesis decisions.

Catalyst/fact separation follows Gamma; valuation and revision logic are native.
Reported facts, assumptions and news are never substituted for each other.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from .core import (ONE, ZERO, AllocationProposal, ResearchDecision, Rule, FeatureObservation,
                   count, deterministic, digest_text, evaluate_rules, fraction, identity,
                   instant, ratio, require_decimal)


@dataclass(frozen=True)
class FinancialFact:
    fact_id: str
    field: str
    period_end: datetime
    published_at: datetime
    available_at: datetime
    value: Decimal
    unit: str
    source_id: str
    source_hash: str
    revision: int

    def __post_init__(self):
        for value in (self.fact_id, self.field, self.unit, self.source_id):
            identity(value)
        for value in (self.period_end, self.published_at, self.available_at):
            instant(value)
        if not self.period_end <= self.published_at <= self.available_at:
            raise ValueError("Fact period/publication/availability ordering invalid")
        digest_text(self.source_hash)
        count(self.revision, positive=True)
        require_decimal(self.value)


def facts_as_of(facts: tuple[FinancialFact, ...], *, as_of: datetime) -> tuple[FinancialFact, ...]:
    instant(as_of)
    identities = set()
    latest: dict[str, FinancialFact] = {}
    for fact in facts:
        key = (fact.fact_id, fact.revision)
        if key in identities:
            raise ValueError("Duplicate fact revision")
        identities.add(key)
        if fact.available_at > as_of or fact.published_at > as_of:
            continue
        previous = latest.get(fact.field)
        # A later restatement of an old period never replaces a newer period.
        rank = (fact.period_end, fact.available_at, fact.revision, fact.fact_id)
        if previous is None or rank > (previous.period_end, previous.available_at, previous.revision, previous.fact_id):
            latest[fact.field] = fact
    return tuple(latest[key] for key in sorted(latest))


@dataclass(frozen=True)
class ValuationAssumptions:
    scenario_id: str
    revenue_growth: Decimal
    free_cash_flow_margin: Decimal
    terminal_fcf_multiple: Decimal
    annual_discount_rate: Decimal
    annual_dilution: Decimal
    years: int
    rationale: str
    evidence_ids: tuple[str, ...]
    known_at: datetime

    def __post_init__(self):
        identity(self.scenario_id)
        instant(self.known_at)
        count(self.years, positive=True)
        if self.years > 30:
            raise ValueError("Valuation horizon exceeds bound")
        require_decimal(self.revenue_growth)
        if self.revenue_growth <= -ONE:
            raise ValueError("Revenue growth must exceed -100%")
        fraction(self.free_cash_flow_margin)
        require_decimal(self.terminal_fcf_multiple, nonnegative=True)
        require_decimal(self.annual_discount_rate, nonnegative=True)
        fraction(self.annual_dilution)
        if not self.rationale.strip() or not self.evidence_ids:
            raise ValueError("Assumptions require rationale and source-linked evidence")
        for value in self.evidence_ids:
            identity(value)


@dataclass(frozen=True)
class ValuationResult:
    scenario_id: str
    status: str
    fair_value_per_share: Decimal | None
    discounted_enterprise_value: Decimal | None
    reasons: tuple[str, ...]
    reported_fact_ids: tuple[str, ...]
    assumption_evidence_ids: tuple[str, ...]


@deterministic
def value_equity(facts: tuple[FinancialFact, ...], assumptions: ValuationAssumptions, *,
                 as_of: datetime, instrument_kind: str, currency: str,
                 maximum_fact_age_days: int) -> ValuationResult:
    count(maximum_fact_age_days)
    identity(currency)
    selected = {fact.field: fact for fact in facts_as_of(facts, as_of=as_of)}
    reasons = []
    if assumptions.known_at > as_of:
        reasons.append("valuation-assumptions-not-known-as-of")
    if instrument_kind != "equity":
        reasons.append("equity-valuation-not-applicable-to-fund-future-or-option")
    for key in ("revenue", "net-debt", "diluted-shares"):
        fact = selected.get(key)
        if fact is None:
            reasons.append("missing-" + key)
        elif (as_of - fact.period_end).total_seconds() > maximum_fact_age_days * 86_400:
            reasons.append("stale-" + key)
        elif fact.unit != ("shares" if key == "diluted-shares" else currency):
            reasons.append("unit-mismatch-" + key)
    ids = tuple(selected[key].fact_id for key in sorted(selected))
    if reasons:
        return ValuationResult(assumptions.scenario_id, "unavailable", None, None,
                               tuple(reasons), ids, assumptions.evidence_ids)
    revenue = selected["revenue"].value
    debt = selected["net-debt"].value
    shares = selected["diluted-shares"].value
    if revenue <= ZERO or shares <= ZERO:
        return ValuationResult(assumptions.scenario_id, "unavailable", None, None,
                               ("nonpositive-revenue-or-share-count",), ids, assumptions.evidence_ids)
    present = ZERO
    for year in range(1, assumptions.years + 1):
        revenue *= ONE + assumptions.revenue_growth
        cash_flow = revenue * assumptions.free_cash_flow_margin
        present += cash_flow / (ONE + assumptions.annual_discount_rate) ** year
    present += (cash_flow * assumptions.terminal_fcf_multiple /
                (ONE + assumptions.annual_discount_rate) ** assumptions.years)
    diluted_shares = shares * (ONE + assumptions.annual_dilution) ** assumptions.years
    # Negative net debt is net cash; negative residual equity has a zero floor.
    fair_value = ratio(max(ZERO, present - debt), diluted_shares)
    return ValuationResult(assumptions.scenario_id, "research", fair_value, ratio(present, ONE),
                           ("assumption-sensitive-not-a-price-forecast",), ids, assumptions.evidence_ids)


@dataclass(frozen=True)
class ThesisRevision:
    thesis_id: str
    revision: int
    previous_revision: int | None
    text: str
    accepted_at: datetime
    reviewer_id: str
    evidence_ids: tuple[str, ...]
    invalidation_rules: tuple[Rule, ...]

    def __post_init__(self):
        identity(self.thesis_id)
        identity(self.reviewer_id)
        count(self.revision, positive=True)
        instant(self.accepted_at)
        if self.previous_revision is not None:
            count(self.previous_revision, positive=True)
        if not self.text.strip() or not self.evidence_ids or not self.invalidation_rules:
            raise ValueError("A thesis needs text, evidence and deterministic invalidations")
        for value in self.evidence_ids:
            identity(value)


def revise_thesis(previous: ThesisRevision, proposed: ThesisRevision) -> ThesisRevision:
    if proposed.thesis_id != previous.thesis_id or proposed.previous_revision != previous.revision:
        raise ValueError("Thesis compare-and-swap identity mismatch")
    if proposed.revision != previous.revision + 1 or proposed.accepted_at <= previous.accepted_at:
        raise ValueError("Revision must advance exactly once after previous acceptance")
    if proposed == previous:
        raise ValueError("No-op thesis revision")
    return proposed


@dataclass(frozen=True)
class Dossier:
    instrument_id: str
    as_of: datetime
    facts: tuple[FinancialFact, ...]
    thesis: ThesisRevision | None
    valuation_cases: tuple[ValuationResult, ...]
    missing: tuple[str, ...]
    source_ids: tuple[str, ...]


def build_dossier(*, instrument_id: str, as_of: datetime, facts: tuple[FinancialFact, ...],
                  revisions: tuple[ThesisRevision, ...], scenarios: tuple[ValuationAssumptions, ...],
                  instrument_kind: str, currency: str, maximum_fact_age_days: int) -> Dossier:
    identity(instrument_id)
    instant(as_of)
    selected = facts_as_of(facts, as_of=as_of)
    ordered = sorted(revisions, key=lambda item: item.revision)
    if ordered:
        if ordered[0].revision != 1 or ordered[0].previous_revision is not None:
            raise ValueError("Thesis history must include its initial revision")
        for prior, revision in zip(ordered, ordered[1:]):
            revise_thesis(prior, revision)
    eligible = [revision for revision in ordered if revision.accepted_at <= as_of]
    thesis = eligible[-1] if eligible else None
    if len({item.scenario_id for item in scenarios}) != len(scenarios):
        raise ValueError("Duplicate valuation scenario")
    cases = tuple(value_equity(selected, item, as_of=as_of, instrument_kind=instrument_kind,
                               currency=currency, maximum_fact_age_days=maximum_fact_age_days)
                  for item in scenarios)
    missing = []
    if not selected:
        missing.append("point-in-time-facts-unavailable")
    if thesis is None:
        missing.append("accepted-thesis-unavailable-as-of")
    if not cases or any(case.status == "unavailable" for case in cases):
        missing.append("valuation-incomplete")
    return Dossier(instrument_id, as_of, selected, thesis, cases, tuple(missing),
                   tuple(sorted({item.source_id for item in selected})))


def review_thesis(dossier: Dossier, features: dict[str, FeatureObservation], *,
                  as_of: datetime, maximum_feature_age_seconds: int,
                  material_event_ids: tuple[str, ...] = ()) -> ResearchDecision:
    instant(as_of)
    if dossier.as_of > as_of or dossier.thesis is None or dossier.thesis.accepted_at > as_of:
        return ResearchDecision("unavailable", ("thesis-unavailable-as-of",))
    results = evaluate_rules(dossier.thesis.invalidation_rules, features, as_of=as_of,
                             maximum_age_seconds=maximum_feature_age_seconds)
    triggered = tuple(result.rule_id for result in results if result.state == "pass")
    # Known invalidation takes priority over missing unrelated metrics.
    if triggered:
        return ResearchDecision("exit", ("thesis-invalidated", *triggered),
                                evidence_ids=dossier.thesis.evidence_ids)
    if any(result.state == "unavailable" for result in results):
        return ResearchDecision("unavailable", ("invalidation-data-incomplete",))
    if material_event_ids:
        return ResearchDecision("review", ("material-event-requires-new-thesis-revision", *material_event_ids))
    return ResearchDecision("hold", ("accepted-thesis-not-invalidated",))


@deterministic
def fundamental_allocation(dossier: Dossier, *, market_price: Decimal | None,
                           desired_weight: Decimal, instrument_cap: Decimal,
                           sector_other_weight: Decimal | None, sector_cap: Decimal,
                           sleeve_remaining_weight: Decimal | None,
                           minimum_margin_of_safety: Decimal, scenario_id: str,
                           as_of: datetime, market_price_observed_at: datetime | None,
                           market_price_available_at: datetime | None,
                           maximum_price_age_seconds: int, maximum_dossier_age_days: int) -> AllocationProposal:
    instant(as_of)
    count(maximum_price_age_seconds)
    count(maximum_dossier_age_days)
    for value in (desired_weight, instrument_cap, sector_cap, minimum_margin_of_safety):
        fraction(value)
    for value in (sector_other_weight, sleeve_remaining_weight):
        if value is not None:
            fraction(value)
    if market_price is not None:
        require_decimal(market_price, positive=True)
    missing = list(dossier.missing)
    if dossier.as_of > as_of or (as_of - dossier.as_of).total_seconds() > maximum_dossier_age_days * 86_400:
        missing.append("point-in-time-dossier-future-or-stale")
    if market_price_observed_at is None or market_price_available_at is None:
        missing.append("market-price-clocks-unavailable")
    else:
        instant(market_price_observed_at)
        instant(market_price_available_at)
        if not market_price_observed_at <= market_price_available_at <= as_of:
            missing.append("market-price-not-known-as-of")
        elif (as_of - market_price_observed_at).total_seconds() > maximum_price_age_seconds:
            missing.append("market-price-stale")
    case = next((item for item in dossier.valuation_cases if item.scenario_id == scenario_id), None)
    if case is None or case.fair_value_per_share is None or case.fair_value_per_share <= ZERO:
        missing.append("requested-valuation-case-unavailable")
    if market_price is None:
        missing.append("market-price-unavailable")
    if sector_other_weight is None or sleeve_remaining_weight is None:
        missing.append("reconciled-portfolio-headroom-unavailable")
    if missing:
        return AllocationProposal("fundamental", (), tuple(missing), "unavailable")
    margin = ONE - ratio(market_price, case.fair_value_per_share)
    if margin < minimum_margin_of_safety:
        return AllocationProposal("fundamental", (), ("margin-of-safety-not-met",), "hold")
    cap = min(desired_weight, instrument_cap, max(ZERO, sector_cap - sector_other_weight),
              sleeve_remaining_weight)
    return AllocationProposal("fundamental", ((dossier.instrument_id, cap),),
                              ("point-in-time-thesis-and-valuation", "proposal-only-no-quantity-or-reservation"),
                              "proposal" if cap > ZERO else "hold")
