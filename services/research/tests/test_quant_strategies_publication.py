"""Source-authored cases only; not executed during the build-first wave."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal, localcontext
import hashlib
import json

import pytest

from strategies.core import (AllocationProposal, FeatureObservation, Rule, SLEEVES,
                             evaluate_rules, exact, public_decimal, ratio)
from strategies.publication import (PublicationReceipt, StrategyBlueprint, Unavailable,
                                    plan_publication, publish_plan)

D = Decimal
NOW = datetime(2026, 1, 20, 20, tzinfo=timezone.utc)


class FixtureCodec:
    """Test-only fixed JSON profile; never installed as a runtime codec."""
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()


class ExpectedValidator:
    def __init__(self, expected):
        self.expected = expected
        self.calls = []

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.calls.append((contract_name, schema_version))
        return contract_name == "StrategySpec" and schema_version == "1.0.0" and payload == self.expected


def blueprint(sleeve="quant"):
    return StrategyBlueprint(
        "synthetic-study", "1.0.0", sleeve, "Synthetic falsifiable hypothesis", ("SYNTH",),
        "synthetic-calendar", "bar-close",
        (Rule("entry", "momentum", "gt", D("0"), 20),),
        (Rule("exit", "momentum", "lt", D("0"), 20),),
        {"maximumLoss": D("10"), "maximumNotional": D("100"), "maximumPositions": 1},
        ({"kind": "candles", "maximumAgeMs": 1000, "pointInTimeRequired": True,
          "entitlementPolicyId": "synthetic-rights"},),
        {"commissionPerUnit": D("0.01"), "spreadBps": D("1"), "slippageBps": D("2"),
         "borrowAnnualBps": D("0"), "impactModel": "fixed-bps", "maximumParticipationBps": D("100")},
        "a" * 64,
    )


def fixture_plan(sleeve="quant"):
    spec = blueprint(sleeve)
    validator = ExpectedValidator(spec.public_candidate())
    return plan_publication(spec, validator=validator, codec=FixtureCodec()), validator


@pytest.mark.parametrize("bad", [1.1, 1, True, "NaN", "1e3", " 1", "+1", "01"])
def test_exact_input_rejects_ambiguous_or_float_values(bad):
    with pytest.raises((ValueError, TypeError)):
        exact(bad)


def test_normalized_public_decimal_is_lossless_and_bounded():
    assert public_decimal(D("10.2000")) == "10.2"
    assert public_decimal(D("-0")) == "0"
    with pytest.raises(ValueError):
        public_decimal(D("0.0000000000000000001"))
    with pytest.raises(ValueError):
        public_decimal(D("1000000000000000000000000000000"))
    with localcontext() as context:
        context.prec = 4
        assert ratio(D("1"), D("3")) == D("0.333333333333333333")


def test_rule_missing_future_stale_and_lookback_are_not_false_or_zero():
    rule = Rule("entry", "momentum", "gt", D("0.1"), 20)
    feature = FeatureObservation("momentum", D("0.2"), NOW, NOW, 20, "source")
    assert evaluate_rules((rule,), {"momentum": feature}, as_of=NOW, maximum_age_seconds=1)[0].state == "pass"
    cases = (None, replace(feature, value=None), replace(feature, completed_bars=19),
             replace(feature, available_at=NOW + timedelta(seconds=1)))
    for item in cases:
        result = evaluate_rules((rule,), {} if item is None else {"momentum": item}, as_of=NOW, maximum_age_seconds=1)
        assert result[0].state == "unavailable"
    assert evaluate_rules((rule,), {"momentum": feature}, as_of=NOW + timedelta(seconds=2), maximum_age_seconds=1)[0].reason == "stale-feature"


@pytest.mark.parametrize("sleeve", SLEEVES)
def test_all_five_sleeves_publish_exact_authoritatively_validated_plans(sleeve):
    spec = blueprint(sleeve)
    validator = ExpectedValidator(spec.public_candidate())
    result = plan_publication(spec, validator=validator, codec=FixtureCodec())
    assert result.contract_name == "StrategySpec"
    assert result.content_hash == hashlib.sha256(result.canonical_bytes).hexdigest()
    assert validator.calls == [("StrategySpec", "1.0.0")]
    assert json.loads(result.canonical_bytes)["riskLimits"]["maximumLoss"] == "10"
    assert result.executable is False
    spec.risk_limits["maximumLoss"] = D("99")
    assert json.loads(result.canonical_bytes)["riskLimits"]["maximumLoss"] == "10"


def test_no_runtime_validator_or_canonical_fallback():
    assert isinstance(plan_publication(blueprint(), validator=None, codec=None), Unavailable)

    class TruthyValidator:
        def validate(self, *args, **kwargs):
            return 1

    with pytest.raises(ValueError, match="literal True"):
        plan_publication(blueprint(), validator=TruthyValidator(), codec=FixtureCodec())

    class BadCodec(FixtureCodec):
        def digest(self, value):
            return "0" * 64

    with pytest.raises(ValueError, match="disagree"):
        plan_publication(blueprint(), validator=ExpectedValidator(blueprint().public_candidate()), codec=BadCodec())


def test_floats_and_sixth_sleeve_never_reach_publication():
    with pytest.raises(ValueError):
        blueprint("0dte").public_candidate()
    spec = blueprint()
    spec.cost_model["spreadBps"] = 1.1
    with pytest.raises(TypeError):
        spec.public_candidate()
    with pytest.raises(ValueError):
        AllocationProposal("0dte", (), ())


def test_immutable_store_receipt_and_revalidation():
    plan, validator = fixture_plan()
    class Store:
        def __init__(self):
            self.saved = {}
        def put_if_absent(self, candidate):
            existing = self.saved.get(candidate.artifact_id)
            if existing is not None and existing != candidate:
                raise ValueError("immutable version collision")
            self.saved[candidate.artifact_id] = candidate
            return PublicationReceipt(candidate.artifact_id, candidate.content_hash,
                                      "already-present" if existing else "created")
    store = Store()
    assert publish_plan(plan, store=store, validator=validator, codec=FixtureCodec()).state == "created"
    assert publish_plan(plan, store=store, validator=validator, codec=FixtureCodec()).state == "already-present"
    assert isinstance(publish_plan(plan, store=None, validator=validator, codec=FixtureCodec()), Unavailable)
    with pytest.raises(ValueError, match="validation"):
        publish_plan(plan, store=store, validator=ExpectedValidator({}), codec=FixtureCodec())


def test_allocations_neither_size_nor_reserve_cash():
    for sleeve in SLEEVES:
        plan = AllocationProposal(sleeve, (("SYNTH", D("0.2")),), ("research",))
        assert plan.reserves_cash is False
        assert plan.executable is False
    with pytest.raises(ValueError):
        AllocationProposal("macro", (("A", D("0.8")), ("B", D("0.3"))), ())
