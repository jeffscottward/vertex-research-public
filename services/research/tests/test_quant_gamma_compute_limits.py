"""Computational rejection must not quietly alter the candidate universe."""

import hashlib
import json
from datetime import UTC, datetime, timedelta

import pytest

from gamma.adapter import InputArtifact
from gamma.decision_adapter import GammaDecisionAdapter, MAX_CONTRACTS, ResearchInputDecision
from gamma.engines import StrategySelectionConstraints


def test_pairwise_native_selector_rejects_oversized_input_without_truncation():
    now = datetime(2030, 1, 2, tzinfo=UTC)
    def source(value):
        body = json.dumps(value).encode()
        return InputArtifact(body, hashlib.sha256(body).hexdigest(), now, now)
    class Policy:
        def qualify(self, *, source, as_of, operation):
            return ResearchInputDecision(source.expected_sha256, "synthetic", True, "fresh",
                                         as_of + timedelta(days=1), "synthetic")
    setup = source({"setup_id": "synthetic", "ticker": "TEST", "direction": "bullish", "thesis": "Fixture",
                    "setup_score": 80, "confidence": 0.8, "invalidation": "Fixture", "target_window": "21 days",
                    "preferred_strategy_types": [], "rejection_reasons": []})
    chain = source([{} for _ in range(MAX_CONTRACTS + 1)])
    with pytest.raises(ValueError, match="bounded research capacity"):
        GammaDecisionAdapter(as_of=now, input_policy=Policy()).select(setup=setup, option_chain=chain,
                                                                     constraints=StrategySelectionConstraints())
