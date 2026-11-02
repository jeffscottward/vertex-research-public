"""Synthetic-only regression source. Not executed during build-first authoring."""

import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from gamma.adapter import InputArtifact
from gamma.decision_adapter import GammaDecisionAdapter, ResearchInputDecision
from gamma.decimal_boundary import DecimalFieldRule, FloatDecimalPolicy, project_native
from gamma.engines import PortfolioRiskConstraints, StrategySelectionConstraints
from gamma.publication import GammaPublicationPlanner

NOW = datetime(2030, 1, 2, 12, tzinfo=UTC)


def source(payload, *, at=NOW):
    content = json.dumps(payload, default=lambda value: value.isoformat()).encode()
    return InputArtifact(content, hashlib.sha256(content).hexdigest(), at, at)


class SyntheticInputPolicy:
    def qualify(self, *, source, as_of, operation):
        return ResearchInputDecision(source.expected_sha256, "synthetic-evidence", True, "fresh",
                                     as_of + timedelta(hours=1), "synthetic")


def setup():
    return source({"setup_id": "synthetic-setup", "ticker": "TEST", "direction": "bullish",
                   "thesis": "Synthetic ordering characterization, not a trade recommendation.",
                   "setup_score": 80.0, "confidence": 0.8, "invalidation": "Synthetic condition",
                   "target_window": "21-75 days", "preferred_strategy_types": ["long_call"],
                   "rejection_reasons": []})


def chain():
    return source([{"expiry": "2030-02-15", "strike": 100, "right": "call", "bid": 1.0,
                    "ask": 1.05, "delta": 0.45, "volume": 100, "open_interest": 500,
                    "price_source": "offline_fixture", "quote_observed_at": NOW.isoformat(),
                    "quote_fetched_at": NOW.isoformat()}])


def adapter():
    return GammaDecisionAdapter(as_of=NOW, input_policy=SyntheticInputPolicy())


def selection():
    return adapter().select(setup=setup(), option_chain=chain(), constraints=StrategySelectionConstraints())


def test_no_implicit_rights_policy_or_clock():
    outcome = GammaDecisionAdapter(as_of=NOW).select(setup=setup(), option_chain=chain(),
                                                   constraints=StrategySelectionConstraints())
    assert outcome.status == "unavailable"
    assert outcome.reason_codes == ("input-policy-unavailable",)
    assert outcome.native_json is None
    with pytest.raises(ValueError):
        GammaDecisionAdapter(as_of=NOW.replace(tzinfo=None))


def test_rights_identity_and_staleness_fail_closed():
    class WrongIdentity(SyntheticInputPolicy):
        def qualify(self, **kwargs):
            return replace(super().qualify(**kwargs), source_sha256="0" * 64)
    outcome = GammaDecisionAdapter(as_of=NOW, input_policy=WrongIdentity()).select(
        setup=setup(), option_chain=chain(), constraints=StrategySelectionConstraints())
    assert outcome.reason_codes == ("input-policy-identity-mismatch",)
    class Stale(SyntheticInputPolicy):
        def qualify(self, **kwargs):
            return replace(super().qualify(**kwargs), status="stale")
    assert GammaDecisionAdapter(as_of=NOW, input_policy=Stale()).select(
        setup=setup(), option_chain=chain(), constraints=StrategySelectionConstraints()).status == "unavailable"


def test_selection_preserves_synthetic_identity_and_is_immutable_proposal():
    first, second = selection(), selection()
    assert first.status == "candidate"
    assert first.source_kinds == ("synthetic",)
    assert first.proposal_only is True and first.execution_authorized is False
    assert first.native_identity_sha256 == second.native_identity_sha256
    assert hashlib.sha256(first.native_json).hexdigest() == first.native_output_sha256
    with pytest.raises(TypeError):
        first.native_payload["selected_strategy_type"] = "arbitrary"
    assert any("missing" in item.lower() for item in first.limitations)


def test_configuration_is_part_of_identity_even_with_same_native_result():
    first = selection()
    second = adapter().select(setup=setup(), option_chain=chain(),
                              constraints=StrategySelectionConstraints(max_premium=600))
    assert first.native_input_sha256 != second.native_input_sha256


def test_future_quote_rejected_not_reinterpreted_as_today():
    payload = chain().decode()
    payload[0]["quote_observed_at"] = (NOW + timedelta(seconds=1)).isoformat()
    with pytest.raises(ValueError, match="horizon"):
        adapter().select(setup=setup(), option_chain=source(payload), constraints=StrategySelectionConstraints())


@pytest.mark.parametrize("bad", ["NaN", "Infinity", True, -1])
def test_invalid_native_quote_numbers_never_become_outputs(bad):
    rows = chain().decode()
    rows[0]["bid"] = bad
    with pytest.raises(ValueError):
        adapter().select(setup=setup(), option_chain=source(rows), constraints=StrategySelectionConstraints())


def test_nanosecond_quote_not_silently_truncated():
    rows = chain().decode()
    rows[0]["quote_observed_at"] = "2030-01-02T12:00:00.000000001Z"
    with pytest.raises(ValueError, match="nanosecond"):
        adapter().select(setup=setup(), option_chain=source(rows), constraints=StrategySelectionConstraints())


def test_zero_dte_cannot_enter_gamma_legacy_constructors():
    with pytest.raises(ValueError, match="separate owner"):
        adapter().select(setup=setup(), option_chain=chain(), constraints=StrategySelectionConstraints(min_dte=0))


def test_portfolio_requires_actual_cash_and_observed_position_risk():
    with pytest.raises(ValueError, match="cash_available"):
        adapter().allocate(portfolio=source({"strategy_intents": [], "account_state": {"buying_power": 10000}}),
                           constraints=PortfolioRiskConstraints())
    with pytest.raises(ValueError, match="missing risk"):
        adapter().allocate(portfolio=source({"strategy_intents": [], "account_state": {"cash_available": 10000},
                                            "current_positions": [{"ticker": "TEST", "expiry": "2030-02-15"}]}),
                           constraints=PortfolioRiskConstraints())


def test_portfolio_refuses_ambiguous_source_theme_units():
    outcome = adapter().allocate(portfolio=source({"strategy_intents": [], "account_state": {"cash_available": 10000},
                    "current_positions": [],
                    "theme_exposures": {"synthetic-theme": 0.5}, "theme_exposure_unit": "currency"}),
                    constraints=PortfolioRiskConstraints())
    assert outcome.status == "unavailable"
    assert outcome.reason_codes == ("native-theme-unit-ambiguity",)


def policy(*rules):
    return FloatDecimalPolicy("synthetic-rounding", "1.0.0", tuple(rules))


def test_conversion_requires_explicit_nonoverlapping_field_rule():
    with pytest.raises(ValueError, match="exactly one"):
        project_native({"risk": 0.1}, policy(DecimalFieldRule("/other", "0.01", "0.005")))
    with pytest.raises(ValueError, match="exactly one"):
        project_native({"risk": 0.1}, policy(DecimalFieldRule("/*", "0.01", "0.005"),
                                             DecimalFieldRule("/risk", "0.01", "0.005")))


def test_conversion_audits_shortest_roundtrip_and_rounding_error():
    result = project_native({"risk": 0.1 + 0.2, "zero": -0.0}, policy(DecimalFieldRule("/*", "0.01", "0.00000001")))
    assert result.payload["risk"] == "0.3"
    assert result.payload["zero"] == "0"
    assert result.observations[0].binary64_repr == "0.30000000000000004"
    assert result.observations[0].absolute_error == "0.00000000000000004"
    with pytest.raises(TypeError):
        result.payload["risk"] = "1"


def test_conversion_never_silently_rounds_beyond_budget_or_unsafe_integer():
    with pytest.raises(ValueError, match="error budget"):
        project_native({"risk": 1.005}, policy(DecimalFieldRule("/*", "0.01", "0")))
    with pytest.raises(ValueError, match="unsafe public integer"):
        project_native({"n": 2**53}, policy(DecimalFieldRule("/*", "0.01", "0")))
    with pytest.raises(ValueError, match="nonfinite"):
        project_native({"risk": float("nan")}, policy(DecimalFieldRule("/*", "0.01", "0")))


class SyntheticCodec:
    """Test double ONLY, not the authoritative Vertex canonical implementation."""
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()


def evidence_metadata():
    return {"evidenceId": "synthetic-gamma-evidence", "collectionId": "synthetic-only", "snapshotId": "synthetic-1",
            "sourceUri": "https://example.invalid/synthetic", "sourceIdentity": {"provider": "test-fixture",
            "sourceId": "synthetic-native", "snapshotId": "synthetic-1", "contentHash": "0" * 64},
            "sourceLocator": "synthetic-only", "attribution": "Original synthetic regression fixture",
            "publishedAt": None, "capturedAt": "2030-01-02T12:00:00Z", "claim": "Not empirical evidence.",
            "limitations": ["Synthetic test fixture"], "rightsPolicyId": "synthetic-test-rights"}


def test_publication_missing_ports_is_unavailable():
    assert GammaPublicationPlanner().evidence(decision=selection(), metadata={}, conversion=None).status == "unavailable"


def test_publication_requires_literal_validation_success_and_keeps_hash_domains():
    calls = []
    def validate(name, payload, *, schema_version):
        calls.append((name, payload, schema_version))
        return True
    conversion = policy(DecimalFieldRule("/*", "0.000001", "0.000001"))
    decision = selection()
    result = GammaPublicationPlanner(validate=validate, codec=SyntheticCodec()).evidence(
        decision=decision, metadata=evidence_metadata(), conversion=conversion)
    assert result.status == "candidate"
    assert result.content_digest != result.native_source_digest
    assert hashlib.sha256(result.content_bytes).hexdigest() == result.content_digest
    assert calls[0][0] == "ResearchEvidence" and calls[0][2] == "1.0.0"
    record = json.loads(result.record_bytes)
    assert record["contentHash"] == record["sourceIdentity"]["contentHash"]
    assert record["acceptanceStatus"] == "unreviewed"
    content = json.loads(result.content_bytes)
    assert content["executionAuthorized"] is False
    assert content["nativeOutputHash"] == decision.native_output_sha256
    rejected = GammaPublicationPlanner(validate=lambda *a, **k: 1, codec=SyntheticCodec()).evidence(
        decision=decision, metadata=evidence_metadata(), conversion=conversion)
    assert rejected.status == "unavailable"


def test_publication_rejects_mutated_native_source():
    decision = replace(selection(), native_json=b"{}")
    with pytest.raises(ValueError, match="source output hash"):
        GammaPublicationPlanner(validate=lambda *a, **k: True, codec=SyntheticCodec()).evidence(
            decision=decision, metadata=evidence_metadata(), conversion=policy(DecimalFieldRule("/*", "0.01", "0.01")))
