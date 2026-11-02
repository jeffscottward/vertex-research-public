"""All eight source constructors; synthetic, unexecuted characterization only."""

from datetime import UTC, date, datetime

import pytest

from gamma.engines.options_strategy_selector import (
    OptionChainContract, OptionsStrategySelector, StrategySelectionConstraints,
    _build_strategy_intent,
)
from gamma.schemas import TradeSetup

NOW = datetime(2030, 1, 2, 12, tzinfo=UTC)
EXPIRY = date(2030, 2, 15)


def native_setup(direction="bullish"):
    return TradeSetup(setup_id="synthetic-only", ticker="TEST", direction=direction,
                      thesis="Synthetic constructor fixture", setup_score=80, confidence=0.8,
                      invalidation="Not a live protection instruction", target_window="21-75 days",
                      preferred_strategy_types=[], rejection_reasons=[])


def contracts():
    def item(right, strike, delta, bid, ask):
        return OptionChainContract(expiry=EXPIRY, strike=strike, right=right, bid=bid, ask=ask,
                                   delta=delta, volume=100, open_interest=500,
                                   raw={"price_source": "offline_fixture", "timestamp": NOW.isoformat()})
    return [item("call", 100, 0.45, 2, 2.1), item("call", 105, 0.30, 1, 1.1),
            item("put", 100, -0.45, 2, 2.1), item("put", 95, -0.30, 1, 1.1)]


@pytest.mark.parametrize("strategy,direction,legs,credit", [
    ("long_call", "bullish", 1, False), ("long_put", "bearish", 1, False),
    ("call_debit_spread", "bullish", 2, False), ("put_debit_spread", "bearish", 2, False),
    ("call_credit_spread", "bearish", 2, True), ("put_credit_spread", "bullish", 2, True),
    ("straddle", "vol_expansion", 2, False), ("strangle", "vol_expansion", 2, False),
])
def test_all_eight_native_source_constructors(strategy, direction, legs, credit):
    first = _build_strategy_intent(setup=native_setup(direction), strategy_type=strategy,
                                   contracts=contracts(), as_of=NOW, constraints=StrategySelectionConstraints())
    second = _build_strategy_intent(setup=native_setup(direction), strategy_type=strategy,
                                    contracts=contracts(), as_of=NOW, constraints=StrategySelectionConstraints())
    assert first is not None and second is not None
    assert first.strategy_type == strategy
    assert len(first.legs) == legs
    assert first.max_loss > 0 and first.max_loss <= 500
    assert (first.net_debit_or_credit > 0) is credit
    assert first.to_artifact_hash() == second.to_artifact_hash()
    assert first.liquidity_checks["quote_readiness"] == "not_ready"
    assert first.liquidity_checks["quote_trust_classes"] == ["offline"]


@pytest.mark.parametrize("strategy", ["calendar", "diagonal", "iron_condor", "custom"])
def test_vocabulary_is_not_an_implemented_constructor(strategy):
    assert _build_strategy_intent(setup=native_setup("neutral"), strategy_type=strategy,
                                  contracts=contracts(), as_of=NOW, constraints=StrategySelectionConstraints()) is None


def test_parse_constraint_then_aggregate_rejection_order_is_preserved():
    result = OptionsStrategySelector().select(setup=native_setup(), as_of=NOW, option_chain=[
        {"expiry": "not-a-date"},
        {"expiry": "2030-01-03", "strike": 100, "right": "call", "bid": 1, "ask": 1.05,
         "delta": 0.45, "volume": 100, "open_interest": 500},
    ])
    assert result.strategy_intent is None
    assert [item.reason for item in result.rejected_trades] == [
        "invalid option-chain row", "contract outside DTE bounds", "no contracts satisfied constraints",
    ]
