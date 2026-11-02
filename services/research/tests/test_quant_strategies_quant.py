"""Unexecuted immutable hypothesis/experiment and same-day capability cases."""
from dataclasses import replace
from datetime import timedelta
import json

import pytest

from strategies.core import SLEEVES
from strategies.publication import Unavailable
from strategies.quant import (ClaimCitation, ExperimentEvidence, ExperimentRequest,
                              ExperimentWindow, FrozenDataset, Hypothesis, PROMOTION_GATES,
                              plan_experiment, review_experiment, store_experiment)
from strategies.zero_dte import zero_dte_capability
from tests.test_quant_strategies_publication import FixtureCodec, NOW, fixture_plan


def request():
    plan, validator = fixture_plan()
    citation = ClaimCitation("paper", "a" * 64, "page-2-equation-1", "doi:synthetic-only", "Synthetic Author",
                             "v1", "rights-review", "analyst-derived")
    hypothesis = Hypothesis("hypothesis", 1, "Synthetic falsifiable hypothesis", "Fails if costs eliminate effect",
                            ("Synthetic cost assumption",), (citation,), NOW - timedelta(days=20))
    dataset = FrozenDataset("dataset", "b" * 64, "snapshot", NOW - timedelta(days=1),
                            NOW - timedelta(days=2), "dataset-rights", True)
    return ExperimentRequest("experiment", hypothesis, plan, (dataset,),
                             ExperimentWindow(NOW - timedelta(days=19), NOW - timedelta(days=10)),
                             ExperimentWindow(NOW - timedelta(days=9), NOW - timedelta(days=2)),
                             86_400, 42, "c" * 64, "simulator-v1", "d" * 64, NOW,
                             (("lookback", ("20", "50")),), 2, 60, 256), validator


def test_frozen_experiment_identity_binds_datasets_seed_environment_and_spec():
    req, validator = request()
    result = plan_experiment(req, codec=FixtureCodec(), validator=validator)
    again = plan_experiment(req, codec=FixtureCodec(), validator=validator)
    assert result == again
    content = json.loads(result.canonical_bytes)
    assert content["seed"] == 42
    assert content["strategy"]["hash"] == req.strategy.content_hash
    assert content["datasets"][0]["manifestHash"] == "b" * 64
    assert all(value is False for value in content["sandbox"].values())
    changed = plan_experiment(replace(req, seed=43), codec=FixtureCodec(), validator=validator)
    assert changed.content_hash != result.content_hash
    assert result.executable is False
    assert result.simulated_capital_enters_nav is False


def test_no_canonical_or_validator_fallback_and_no_hypothesis_substitution():
    req, validator = request()
    assert isinstance(plan_experiment(req, codec=None, validator=validator), Unavailable)
    assert isinstance(plan_experiment(req, codec=FixtureCodec(), validator=None), Unavailable)
    with pytest.raises(ValueError, match="hypothesis"):
        plan_experiment(replace(req, hypothesis=replace(req.hypothesis, statement="Changed without spec revision")),
                        codec=FixtureCodec(), validator=validator)


def test_leakage_budget_future_and_non_pit_inputs_rejected():
    req, _ = request()
    with pytest.raises(ValueError, match="embargo"):
        replace(req, out_of_sample=ExperimentWindow(req.training.end_at, NOW - timedelta(days=2)))
    with pytest.raises(ValueError, match="future"):
        replace(req, out_of_sample=ExperimentWindow(NOW - timedelta(days=9), NOW + timedelta(days=1)))
    with pytest.raises(ValueError, match="Point-in-time"):
        replace(req, datasets=(replace(req.datasets[0], point_in_time=False),))
    with pytest.raises(ValueError, match="trial budget"):
        replace(req, maximum_trials=1)
    with pytest.raises(ValueError, match="Duplicate parameter"):
        replace(req, parameter_grid=(*req.parameter_grid, req.parameter_grid[0]))


def test_six_promotion_gates_never_imply_live_or_funded_authority():
    req, validator = request()
    handoff = plan_experiment(req, codec=FixtureCodec(), validator=validator)
    incomplete = review_experiment(handoff, (), as_of=NOW)
    assert incomplete.missing_gates == PROMOTION_GATES
    receipts = tuple(ExperimentEvidence(gate, handoff.content_hash, "e" * 64, NOW, "reviewer", "pass", False)
                     for gate in PROMOTION_GATES)
    complete = review_experiment(handoff, receipts, as_of=NOW)
    assert complete.state == "research-evidence-complete"
    assert complete.execution_authority == "none"
    assert complete.requires_separate_human_approval is True
    contaminated = (replace(receipts[0], contaminated=True), *receipts[1:])
    assert review_experiment(handoff, contaminated, as_of=NOW).state == "research-incomplete"
    mismatch = (replace(receipts[0], experiment_hash="0" * 64), *receipts[1:])
    assert review_experiment(handoff, mismatch, as_of=NOW).rejected_gates == (PROMOTION_GATES[0],)
    with pytest.raises(ValueError, match="duplicate"):
        review_experiment(handoff, (*receipts, receipts[0]), as_of=NOW)


def test_immutable_experiment_store_port_does_not_schedule_or_execute():
    req, validator = request()
    result = plan_experiment(req, codec=FixtureCodec(), validator=validator)
    assert isinstance(store_experiment(result, store=None), Unavailable)
    class Store:
        def put_if_absent(self, handoff):
            return handoff.content_hash
    assert store_experiment(result, store=Store()) == result.content_hash
    with pytest.raises(ValueError, match="NAV"):
        replace(result, simulated_capital_enters_nav=True)


def test_zero_dte_is_distinct_research_capability_with_eight_missing_gates():
    capability = zero_dte_capability()
    assert SLEEVES == ("wheel", "fundamental", "swing", "macro", "quant")
    assert capability.owner_sleeve == "quant"
    assert capability.state == "research-only"
    assert capability.funded_sixth_sleeve is False
    assert capability.paper_ready is False
    assert capability.live_allowed is False
    assert tuple(gate.gate_id for gate in capability.missing_gates) == tuple(f"Z0{i}" for i in range(1, 9))
    assert all(gate.state == "missing" for gate in capability.missing_gates)
