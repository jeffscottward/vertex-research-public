"""Deterministic native research sleeves; no installed I/O or trading authority.

Detailed internal dataclasses live in each named module. Public artifacts must
pass the injected authoritative validator and canonical codec in publication.
"""
from . import core, fundamental, macro, publication, quant, swing, wheel, zero_dte
from .core import AllocationProposal, ResearchDecision, Rule, SLEEVES, evaluate_rules, exact, public_decimal
from .fundamental import build_dossier, fundamental_allocation, review_thesis, revise_thesis, value_equity
from .macro import classify_regime, plan_rebalance, vintages_as_of
from .publication import (AuthoritativeValidator, CanonicalCodec, ImmutablePublicationPlan,
                          ImmutableStrategyStore, StrategyBlueprint, Unavailable,
                          plan_publication, publish_plan)
from .quant import (ImmutableExperimentStore, plan_experiment, review_experiment, store_experiment)
from .swing import dual_zone_review, momentum, session_breakout, swing_decision
from .wheel import apply_event, early_exercise_review, obligations, plan_roll, select_contracts
from .zero_dte import ZERO_DTE_GATES, zero_dte_capability

__all__ = [
    "core", "fundamental", "macro", "publication", "quant", "swing", "wheel", "zero_dte",
    "AllocationProposal", "ResearchDecision", "Rule", "SLEEVES", "evaluate_rules", "exact", "public_decimal",
    "build_dossier", "fundamental_allocation", "review_thesis", "revise_thesis", "value_equity",
    "classify_regime", "plan_rebalance", "vintages_as_of", "AuthoritativeValidator", "CanonicalCodec",
    "ImmutablePublicationPlan", "ImmutableStrategyStore", "StrategyBlueprint", "Unavailable",
    "plan_publication", "publish_plan", "ImmutableExperimentStore", "plan_experiment", "review_experiment",
    "store_experiment", "dual_zone_review", "momentum", "session_breakout", "swing_decision",
    "apply_event", "early_exercise_review", "obligations", "plan_roll", "select_contracts",
    "ZERO_DTE_GATES", "zero_dte_capability",
]
