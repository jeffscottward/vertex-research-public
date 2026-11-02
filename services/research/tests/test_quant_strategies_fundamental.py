"""Synthetic fundamental cases, authored but intentionally unexecuted."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from strategies.core import FeatureObservation, Rule
from strategies.fundamental import (FinancialFact, ThesisRevision, ValuationAssumptions,
                                    build_dossier, facts_as_of, fundamental_allocation,
                                    review_thesis, revise_thesis, value_equity)

D = Decimal
NOW = datetime(2026, 4, 1, tzinfo=timezone.utc)
PERIOD = NOW - timedelta(days=90)


def fact(field, value, unit="USD", revision=1, known=NOW):
    return FinancialFact(field, field, PERIOD, known, known, D(value), unit,
                         "filing-source", "a" * 64, revision)


def facts():
    return (fact("revenue", "1000"), fact("net-debt", "100"), fact("diluted-shares", "100", "shares"))


def assumption():
    return ValuationAssumptions("base", D("0"), D("0.1"), D("10"), D("0"), D("0"),
                                1, "Synthetic flat-revenue case", ("assumption-source",), NOW)


def thesis():
    return ThesisRevision("thesis", 1, None, "Synthetic thesis", NOW, "reviewer", ("filing-source",),
                          (Rule("margin-breach", "margin", "lt", D("0.1"), 1),))


def dossier():
    return build_dossier(instrument_id="SYNTH", as_of=NOW, facts=facts(), revisions=(thesis(),),
                         scenarios=(assumption(),), instrument_kind="equity", currency="USD", maximum_fact_age_days=180)


def test_future_restatement_does_not_leak_and_newer_period_wins():
    original = fact("revenue", "1000")
    revision = fact("revenue", "2000", revision=2, known=NOW + timedelta(days=1))
    assert facts_as_of((original, revision), as_of=NOW) == (original,)
    assert facts_as_of((original, revision), as_of=NOW + timedelta(days=2)) == (revision,)
    new_period = replace(original, fact_id="next-period", period_end=NOW - timedelta(days=30), value=D("1100"))
    assert facts_as_of((new_period, revision), as_of=NOW + timedelta(days=2)) == (new_period,)


def test_valuation_retains_reported_and_assumed_sources_and_exact_math():
    result = value_equity(facts(), assumption(), as_of=NOW, instrument_kind="equity", currency="USD", maximum_fact_age_days=180)
    assert result.fair_value_per_share == D("10")
    assert result.discounted_enterprise_value == D("1100")
    assert "revenue" in result.reported_fact_ids
    assert result.assumption_evidence_ids == ("assumption-source",)


def test_discounted_intermediate_precision_is_independent_of_ambient_context():
    from decimal import localcontext
    assumptions = replace(assumption(), annual_discount_rate=D("0.07"),
                          revenue_growth=D("0.03"), years=10, annual_dilution=D("0.01"))
    expected = value_equity(facts(), assumptions, as_of=NOW, instrument_kind="equity",
                            currency="USD", maximum_fact_age_days=180)
    with localcontext() as context:
        context.prec = 4
        actual = value_equity(facts(), assumptions, as_of=NOW, instrument_kind="equity",
                              currency="USD", maximum_fact_age_days=180)
    assert actual == expected
    assert actual.fair_value_per_share > D("0")


@pytest.mark.parametrize("kind", ["fund", "future", "option"])
def test_equity_valuation_not_applied_to_fund_units_or_derivatives(kind):
    result = value_equity(facts(), assumption(), as_of=NOW, instrument_kind=kind, currency="USD", maximum_fact_age_days=180)
    assert result.status == "unavailable"
    assert result.fair_value_per_share is None


def test_missing_stale_wrong_unit_and_future_assumption_remain_unavailable():
    base = dict(as_of=NOW, instrument_kind="equity", currency="USD", maximum_fact_age_days=180)
    assert value_equity((), assumption(), **base).status == "unavailable"
    wrong = (fact("revenue", "1000", "EUR"), *facts()[1:])
    assert "unit-mismatch-revenue" in value_equity(wrong, assumption(), **base).reasons
    future = replace(assumption(), known_at=NOW + timedelta(seconds=1))
    assert "valuation-assumptions-not-known-as-of" in value_equity(facts(), future, **base).reasons
    stale = replace(facts()[0], period_end=NOW - timedelta(days=181))
    assert "stale-revenue" in value_equity((stale, *facts()[1:]), assumption(), **base).reasons


def test_thesis_revision_is_explicit_cas_and_future_acceptance_not_visible():
    prior = thesis()
    revised = replace(prior, revision=2, previous_revision=1, accepted_at=NOW + timedelta(days=1), text="Changed thesis")
    assert revise_thesis(prior, revised) == revised
    with pytest.raises(ValueError):
        revise_thesis(prior, replace(revised, previous_revision=3))
    current = build_dossier(instrument_id="SYNTH", as_of=NOW, facts=facts(), revisions=(prior, revised),
                            scenarios=(assumption(),), instrument_kind="equity", currency="USD", maximum_fact_age_days=180)
    assert current.thesis == prior


def test_thesis_invalidation_exit_and_material_event_review():
    current = dossier()
    feature = FeatureObservation("margin", D("0.05"), NOW, NOW, 1, "filing-source")
    result = review_thesis(current, {"margin": feature}, as_of=NOW, maximum_feature_age_seconds=10)
    assert result.status == "exit"
    assert result.executable is False
    assert review_thesis(current, {}, as_of=NOW, maximum_feature_age_seconds=10).status == "unavailable"
    revised_feature = replace(feature, value=D("0.2"))
    assert review_thesis(current, {"margin": revised_feature}, as_of=NOW, maximum_feature_age_seconds=10,
                         material_event_ids=("earnings",)).status == "review"


def test_fundamental_caps_are_proposals_and_missing_headroom_is_not_zero():
    args = dict(market_price=D("8"), desired_weight=D("0.2"), instrument_cap=D("0.1"),
                sector_other_weight=D("0.24"), sector_cap=D("0.3"), sleeve_remaining_weight=D("0.08"),
                minimum_margin_of_safety=D("0.15"), scenario_id="base", as_of=NOW,
                market_price_observed_at=NOW, market_price_available_at=NOW,
                maximum_price_age_seconds=60, maximum_dossier_age_days=30)
    result = fundamental_allocation(dossier(), **args)
    assert result.target_weights == (("SYNTH", D("0.06")),)
    assert result.reserves_cash is False
    args["sector_other_weight"] = None
    missing = fundamental_allocation(dossier(), **args)
    assert missing.status == "unavailable"
    assert missing.target_weights == ()
    args["sector_other_weight"] = D("0.24")
    args["market_price_available_at"] = NOW + timedelta(seconds=1)
    assert "market-price-not-known-as-of" in fundamental_allocation(dossier(), **args).reasons
