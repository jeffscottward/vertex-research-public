"""Regression cases for the static GammaResearchReview boundary findings."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, tzinfo

import pytest

from gamma.adapter import ResearchAdapter, freeze_native
from gamma.engines import SetupEngine
from gamma.features import FundamentalCatalystFeatures, LiquidityFeatures, MomentumFeatures, VolatilityFeatures
from .test_adapter import NOW, corpus, receipt, setup_inputs


@pytest.mark.parametrize("alias", ["as_of", "timestamp", "date"])
@pytest.mark.parametrize("future", ["20260609", "20260609T000000Z", "2026-06-09"])
def test_volatility_aliases_cannot_interpret_future_compact_iso_as_past_epoch(alias, future):
    with pytest.raises(ValueError, match="knowledge horizon"):
        ResearchAdapter(as_of=NOW).volatility(ticker="SYNTH", payload=receipt({alias: future, "ivRank": .5}))


@pytest.mark.parametrize("alias", ["as_of", "timestamp", "date"])
def test_past_compact_volatility_date_matches_consumer_calendar_semantics(alias):
    result = ResearchAdapter(as_of=NOW).volatility(ticker="SYNTH", payload=receipt({alias: "20260605", "ivRank": .5}))
    assert result.payload["as_of"] == datetime(2026, 6, 5, tzinfo=UTC)


def test_volatility_validates_result_timestamp_before_publication(monkeypatch):
    original = VolatilityFeatures.compute

    def changed_consumer(self, **kwargs):
        model = original(self, **kwargs)
        model.as_of = NOW + timedelta(microseconds=1)
        return model

    monkeypatch.setattr(VolatilityFeatures, "compute", changed_consumer)
    with pytest.raises(ValueError, match="result exceeds"):
        ResearchAdapter(as_of=NOW).volatility(ticker="SYNTH", payload=receipt({"ivRank": .5}))


def fundamental_result(data, *, through_setup):
    adapter = ResearchAdapter(as_of=NOW)
    if not through_setup:
        return adapter.fundamental_catalyst(ticker="SYNTH", payload=receipt(data))
    models = setup_inputs()
    models["fundamental_catalyst"].raw = data
    return adapter.identify_setup(**{name: receipt(model) for name, model in models.items()})


@pytest.mark.parametrize("through_setup", [False, True])
@pytest.mark.parametrize("alias", ["date", "report_date"])
@pytest.mark.parametrize("future", [
    "2026-06-08T20:00:00Z", "2026-06-08T08:00:00.000001-04:00",
    "2026-06-08T00:30:00-12:00", "2026-06-09", "20260609",
])
def test_realized_earnings_compare_full_instant_and_offset(through_setup, alias, future):
    with pytest.raises(ValueError, match="future earnings outcome"):
        fundamental_result({"earnings": [{alias: future, "surprise_percent": 8.5}]}, through_setup=through_setup)


@pytest.mark.parametrize("through_setup", [False, True])
@pytest.mark.parametrize("known", [
    "2026-06-08T08:00:00-04:00", "2026-06-08T12:00:00Z",
    "2026-06-09T00:30:00+14:00", "2026-06-08", "20260608",
])
def test_known_realized_earnings_keep_exact_boundary_and_date_only_envelope_semantics(through_setup, known):
    result = fundamental_result({"earnings": [{"date": known, "surprise_percent": 8.5}]}, through_setup=through_setup)
    assert result.module == ("setup" if through_setup else "fundamental_catalyst")


@pytest.mark.parametrize("through_setup", [False, True])
def test_future_intraday_schedule_without_realized_fields_is_permitted(through_setup):
    result = fundamental_result({"earnings": [{"date": "2026-06-08T20:00:00Z"}]}, through_setup=through_setup)
    assert result.module == ("setup" if through_setup else "fundamental_catalyst")


@pytest.mark.parametrize("invalid", ["2026-06-08T08:00:00", "2026-06-08T12:00:00.000000001Z"])
def test_realized_intraday_earnings_require_supported_aware_precision(invalid):
    with pytest.raises(ValueError):
        fundamental_result({"earnings": [{"date": invalid, "surprise_percent": 8.5}]}, through_setup=False)


NONFINITE_STRINGS = ["NaN", "nan", "Infinity", "+inf", "-Infinity", "1e999"]


def kernel_must_not_run(*args, **kwargs):
    pytest.fail("numeric input must be rejected before invoking the unchanged kernel")


@pytest.mark.parametrize("number", NONFINITE_STRINGS)
def test_nonfinite_candidate_numeric_coercion_rejected_before_setup_clamps_it(number, monkeypatch):
    models = setup_inputs()
    inputs = {name: receipt(model) for name, model in models.items()}
    candidate = models["candidate"].to_json_dict()
    candidate["discovery_score"] = number
    inputs["candidate"] = receipt(candidate)
    monkeypatch.setattr(SetupEngine, "identify_setup", kernel_must_not_run)
    with pytest.raises(ValueError, match="finite"):
        ResearchAdapter(as_of=NOW).identify_setup(**inputs)


@pytest.mark.parametrize("number", NONFINITE_STRINGS)
@pytest.mark.parametrize("through_setup", [False, True])
def test_nonfinite_surprise_strings_rejected_before_flags_discard_numeric_value(number, through_setup, monkeypatch):
    monkeypatch.setattr(SetupEngine, "identify_setup", kernel_must_not_run)
    monkeypatch.setattr(FundamentalCatalystFeatures, "compute", kernel_must_not_run)
    with pytest.raises(ValueError, match="finite"):
        fundamental_result({"earnings": [{"date": "2026-04-30", "surprise_percent": number}]}, through_setup=through_setup)


@pytest.mark.parametrize("number", NONFINITE_STRINGS)
@pytest.mark.parametrize("field", ["marketCap", "employeeCount"])
def test_nonfinite_company_fields_rejected_before_nonnegative_clamping(number, field):
    with pytest.raises(ValueError, match="finite"):
        ResearchAdapter(as_of=NOW).fundamental_catalyst(ticker="SYNTH", payload=receipt({"company_facts": {field: number}}))


@pytest.mark.parametrize("number", NONFINITE_STRINGS)
def test_other_consumed_numeric_strings_are_checked_before_source_computation(number, corpus, monkeypatch):
    adapter = ResearchAdapter(as_of=NOW)
    corpus["rows"][-1]["volume"] = number
    monkeypatch.setattr(MomentumFeatures, "compute", kernel_must_not_run)
    with pytest.raises(ValueError, match="finite"):
        adapter.momentum(ticker="SYNTH", rows=receipt(corpus["rows"]))
    monkeypatch.setattr(LiquidityFeatures, "compute", kernel_must_not_run)
    with pytest.raises(ValueError, match="finite"):
        adapter.liquidity(ticker="SYNTH", option_chain=receipt([{"bid": number}]))
    with pytest.raises(ValueError, match="finite"):
        adapter.liquidity(ticker="SYNTH", option_totals=receipt({"volume": number}))
    monkeypatch.setattr(VolatilityFeatures, "compute", kernel_must_not_run)
    with pytest.raises(ValueError, match="finite"):
        adapter.volatility(ticker="SYNTH", payload=receipt({"ivChange": number}))
    with pytest.raises(ValueError, match="finite"):
        adapter.fundamental_catalyst(ticker="SYNTH", payload=receipt({"financial_metrics": {"revenue_growth": number}}))


def test_unrelated_free_text_and_native_malformed_numeric_handling_are_not_reclassified():
    result = ResearchAdapter(as_of=NOW).fundamental_catalyst(ticker="SYNTH", payload=receipt({
        "company_facts": {"sector": "Infinity", "industry": "NaN", "marketCap": "unavailable"},
        "filings": [{"item_1a": "Infinity is quoted in this synthetic text."}],
        "insider_trades": {"comment": "NaN"},
        "financial_metrics": {"comment": "Infinity", "revenue_growth": "unknown"},
    }))
    assert result.payload["sector"] == "Infinity"
    assert result.payload["industry"] == "NaN"
    assert result.payload["market_cap"] is None
    assert result.payload["financial_metric_changes"] == {}
    assert result.payload["insider_trade_summary"]["comment"] == "NaN"


class MutableZone(tzinfo):
    def __init__(self):
        self.offset = timedelta(0)

    def utcoffset(self, value):
        return self.offset

    def dst(self, value):
        return timedelta(0)

    def tzname(self, value):
        return "caller-mutable"


def test_receipt_and_reference_metadata_detach_before_and_after_consumption():
    zone = MutableZone()
    caller_time = NOW.replace(tzinfo=zone)
    artifact = receipt({"ivRank": .5}, observed=caller_time, available=caller_time)
    adapter = ResearchAdapter(as_of=caller_time)
    assert artifact.observed_at.tzinfo is UTC
    assert artifact.available_at.tzinfo is UTC
    zone.offset = timedelta(hours=-5)  # mutate before adapter consumes the receipt
    first = adapter.volatility(ticker="SYNTH", payload=artifact)
    assert first.as_of == first.payload["as_of"] == NOW
    assert first.input_identity["payload"]["observed_at"] == NOW
    assert first.input_identity["payload"]["available_at"] == NOW
    digest = first.identity_sha256
    zone.offset = timedelta(hours=9)  # mutate after publication
    repeated = adapter.volatility(ticker="SYNTH", payload=artifact)
    fresh = ResearchAdapter(as_of=NOW).volatility(ticker="SYNTH", payload=receipt({"ivRank": .5}))
    assert first == repeated == fresh
    assert first.identity_sha256 == digest
    assert first.input_identity["payload"]["observed_at"].tzinfo is UTC
    assert first.input_identity["payload"]["available_at"].tzinfo is UTC


def test_generic_frozen_datetime_leaves_also_detach_mutable_timezone():
    zone = MutableZone()
    caller_time = NOW.replace(tzinfo=zone)
    frozen = freeze_native({"nested": [caller_time]})
    zone.offset = timedelta(hours=7)
    assert frozen["nested"][0] == NOW
    assert frozen["nested"][0].tzinfo is UTC
