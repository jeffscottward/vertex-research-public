"""OptionsStrategySelector tests."""

from __future__ import annotations

from datetime import UTC, date, datetime

from gamma.engines import (
    OptionsStrategySelector,
    SetupEngine,
)
from gamma.features.liquidity_features import LiquidityFeatureSnapshot
from gamma.schemas import (
    CandidateCompany,
    MarketStructureSnapshot,
    OptionContractFlow,
    OptionFlowSnapshot,
    ResearchBrief,
    SourceRef,
    VolatilitySnapshot,
)

NOW = datetime(2026, 6, 8, 12, 0, tzinfo=UTC)
EXPIRY = date(2026, 7, 18)


def test_selector_builds_long_call_from_quantdata_chain() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract("call", 90, delta=0.46, bid=2.0, ask=2.1),
            _contract("call", 95, delta=0.32, bid=1.0, ask=1.1),
            _contract("put", 80, delta=-0.35, bid=1.0, ask=1.1),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.selected_strategy_type == "long_call"
    assert result.strategy_intent.strategy_type == "long_call"
    assert result.strategy_intent.legs[0].right == "call"
    assert result.strategy_intent.dte == 40
    assert result.strategy_intent.max_loss == 210
    assert result.strategy_intent.liquidity_checks["source"] == "quantdata_option_chain"


def test_selector_carries_quote_provenance_into_liquidity_checks() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract(
                "call",
                90,
                delta=0.46,
                bid=2.0,
                ask=2.1,
                price_source="last_trade_synthetic_spread",
            ),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.strategy_intent.liquidity_checks["price_sources"] == [
        "last_trade_synthetic_spread"
    ]

    provenance = result.strategy_intent.liquidity_checks["quote_provenance"][0]
    assert provenance["source"] == "last_trade_synthetic_spread"
    assert provenance["trust_class"] == "synthetic"
    assert provenance["readiness"] == "not_ready"
    assert provenance["trust_class"] != "provider_backed"
    assert result.strategy_intent.liquidity_checks["quote_readiness"] == "not_ready"


def test_selector_marks_provider_nbbo_quote_review_ready() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract(
                "call",
                90,
                delta=0.46,
                bid=2.0,
                ask=2.1,
                price_source="provider_nbbo",
                quote_observed_at=NOW.isoformat(),
                quote_fetched_at=NOW.isoformat(),
                provider_endpoint="/v1/options/tool/term-structure",
                trace_id="quantdata:option_chain:NVDA:2026-07-18:90:CALL",
            ),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    checks = result.strategy_intent.liquidity_checks
    assert checks["quote_readiness"] == "review_ready"
    assert checks["quote_trust_classes"] == ["provider_backed"]
    provenance = checks["quote_provenance"][0]
    assert provenance["source"] == "provider_nbbo"
    assert provenance["observed_at"] == "2026-06-08T12:00:00Z"
    assert provenance["fetched_at"] == "2026-06-08T12:00:00Z"
    assert provenance["age_seconds"] == 0.0
    assert provenance["provider_endpoint"] == "/v1/options/tool/term-structure"
    assert provenance["trace_id"] == "quantdata:option_chain:NVDA:2026-07-18:90:CALL"
    assert provenance["trust_class"] == "provider_backed"
    assert provenance["readiness"] == "review_ready"


def test_selector_carries_quote_timestamps_into_liquidity_checks() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract(
                "call",
                90,
                delta=0.46,
                bid=2.0,
                ask=2.1,
                price_source="nbbo",
                quote_observed_at=NOW.isoformat(),
            ),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.strategy_intent.liquidity_checks["quote_observed_at"] == [
        NOW.isoformat()
    ]


def test_selector_carries_provider_timestamp_alias_into_liquidity_checks() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract(
                "call",
                90,
                delta=0.46,
                bid=2.0,
                ask=2.1,
                price_source="nbbo",
                timestamp=NOW.isoformat(),
            ),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.strategy_intent.liquidity_checks["timestamp"] == [NOW.isoformat()]


def test_selector_carries_provider_as_of_alias_into_liquidity_checks() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract(
                "call",
                90,
                delta=0.46,
                bid=2.0,
                ask=2.1,
                price_source="nbbo",
                quote_as_of=NOW.isoformat(),
            ),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.strategy_intent.liquidity_checks["as_of"] == [NOW.isoformat()]

def test_selector_uses_high_iv_bullish_spread_rules() -> None:
    setup = _setup(iv_rank=0.74)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract("call", 90, delta=0.46, bid=3.0, ask=3.1),
            _contract("call", 95, delta=0.31, bid=1.4, ask=1.5),
            _contract("put", 80, delta=-0.35, bid=1.0, ask=1.1),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.selected_strategy_type == "call_debit_spread"
    assert result.strategy_intent.strategy_type == "call_debit_spread"
    assert len(result.strategy_intent.legs) == 2
    assert result.strategy_intent.max_loss == 170


def test_selector_rejects_no_builder_strategy_families_without_intent() -> None:
    setup = _setup(iv_rank=0.35).model_copy(
        update={
            "direction": "neutral",
            "preferred_strategy_types": ["calendar", "iron_condor"],
        }
    )

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract("call", 90, delta=0.46, bid=2.0, ask=2.1),
            _contract("put", 90, delta=-0.45, bid=1.8, ask=1.9),
            _contract("call", 95, delta=0.31, bid=1.0, ask=1.1),
            _contract("put", 85, delta=-0.32, bid=1.0, ask=1.1),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is None
    assert result.selected_strategy_type is None
    assert [trade.reason for trade in result.rejected_trades] == [
        "calendar rejected by deterministic constraints",
        "iron_condor rejected by deterministic constraints",
    ]
    assert [trade.details for trade in result.rejected_trades] == [
        {"strategy_type": "calendar"},
        {"strategy_type": "iron_condor"},
    ]


def test_selector_builds_straddle_for_vol_expansion_setup() -> None:
    setup = _setup(iv_rank=0.35).model_copy(
        update={
            "direction": "vol_expansion",
            "preferred_strategy_types": ["straddle", "strangle"],
        }
    )

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract("call", 90, delta=0.48, bid=2.0, ask=2.1),
            _contract("put", 90, delta=-0.47, bid=1.8, ask=1.9),
            _contract("call", 95, delta=0.31, bid=1.0, ask=1.1),
            _contract("put", 85, delta=-0.32, bid=1.0, ask=1.1),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.selected_strategy_type == "straddle"
    assert result.strategy_intent.strategy_type == "straddle"
    assert [leg.right for leg in result.strategy_intent.legs] == ["call", "put"]
    assert result.strategy_intent.max_loss == 400
    assert result.strategy_intent.breakevens == [88.1, 92.1]


def test_selector_builds_strangle_when_straddle_contracts_are_unavailable() -> None:
    setup = _setup(iv_rank=0.35).model_copy(
        update={
            "direction": "vol_expansion",
            "preferred_strategy_types": ["straddle", "strangle"],
        }
    )

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract("call", 95, delta=0.31, bid=1.1, ask=1.2),
            _contract("put", 85, delta=-0.32, bid=1.2, ask=1.3),
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is not None
    assert result.selected_strategy_type == "strangle"
    assert result.strategy_intent.strategy_type == "strangle"
    assert result.strategy_intent.max_loss == 250
    assert result.strategy_intent.breakevens == [83.7, 96.2]
    assert [trade.reason for trade in result.rejected_trades] == [
        "straddle rejected by deterministic constraints"
    ]


def test_selector_rejects_invalid_chain_without_fabricating_trade() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[
            _contract("call", 90, delta=0.46, bid=1.0, ask=2.0, volume=1),
            {"expirationDate": EXPIRY.isoformat(), "strikePrice": 95},
        ],
        as_of=NOW,
    )

    assert result.strategy_intent is None
    assert any(
        trade.reason == "invalid option-chain row"
        for trade in result.rejected_trades
    )
    assert any(
        trade.reason == "no contracts satisfied constraints"
        for trade in result.rejected_trades
    )


def test_financial_datasets_context_cannot_override_missing_quantdata_chain() -> None:
    setup = _setup(iv_rank=0.35)

    result = OptionsStrategySelector().select(
        setup=setup,
        option_chain=[],
        as_of=NOW,
        financial_datasets_context={
            "earnings": [{"date": "2026-07-31"}],
            "fake_contract": {"strike": 90, "ask": 1.0, "delta": 0.45},
        },
    )

    assert result.strategy_intent is None
    assert result.financial_datasets_context_used is True
    assert [trade.reason for trade in result.rejected_trades] == [
        "missing option chain"
    ]


def _setup(*, iv_rank: float):
    return SetupEngine().identify_setup(
        candidate=CandidateCompany(
            ticker="COHR",
            company_name="Coherent Corp",
            theme_ids=["photonics"],
            why_it_fits="Optical interconnect supplier tied to AI cluster scale.",
            discovery_score=0.82,
            liquidity_score=0.8,
            options_available=True,
            options_volume=10_000,
            options_open_interest=50_000,
        ),
        research_brief=ResearchBrief(
            ticker="COHR",
            themes=["photonics"],
            bull_case="AI cluster bandwidth demand supports upside.",
            bear_case="Capex cuts would pressure estimates.",
            key_catalysts=["800G network upgrade cycle"],
            key_risks=["capex pause"],
            what_would_change_our_mind=["order cancellations"],
            confidence=0.78,
            source_refs=[
                SourceRef(
                    source_type="fixture",
                    title="Photonics demand",
                    timestamp=NOW,
                    confidence=0.8,
                )
            ],
        ),
        flow_snapshot=OptionFlowSnapshot(
            ticker="COHR",
            as_of=NOW,
            total_call_premium=1_500,
            total_put_premium=250,
            notable_contracts=[
                OptionContractFlow(
                    underlying="COHR",
                    expiry=EXPIRY,
                    strike=90,
                    right="call",
                    side="ask",
                    premium=1_500,
                    volume=300,
                    open_interest=1_200,
                )
            ],
            raw={"provider": "quantdata"},
        ),
        market_structure=MarketStructureSnapshot(
            ticker="COHR",
            as_of=NOW,
            timeframe="1d",
            trend_label="uptrend",
            vwap_relation="above_vwap",
            value_area_relation="accepting_above",
            breakout_status="breakout",
            relative_volume=1.7,
            atr_percent=0.04,
            support_levels=[75.0, 80.0],
            resistance_levels=[95.0],
        ),
        volatility=VolatilitySnapshot(
            ticker="COHR",
            as_of=NOW,
            iv_rank=iv_rank,
            iv_percentile=iv_rank,
            front_iv=0.48,
            back_iv=0.46,
            term_structure_label="flat",
            skew_label="call_skew",
            iv_change_label="stable",
            event_risk=[],
        ),
        liquidity=LiquidityFeatureSnapshot(
            ticker="COHR",
            as_of=NOW,
            stock_avg_volume=2_000_000,
            stock_relative_volume=1.3,
            option_contract_count=24,
            option_total_open_interest=25_000,
            option_total_volume=5_000,
            median_bid_ask_spread_pct=0.08,
            minimum_viable_contract_count=5,
            passes_minimum_contract_filters=True,
            raw={"provider": "quantdata"},
        ),
        as_of=NOW,
    )


def _contract(
    right: str,
    strike: float,
    *,
    delta: float,
    bid: float,
    ask: float,
    volume: int = 200,
    open_interest: int = 1_500,
    price_source: str | None = None,
    quote_observed_at: str | None = None,
    quote_fetched_at: str | None = None,
    timestamp: str | None = None,
    quote_as_of: str | None = None,
    provider_endpoint: str | None = None,
    trace_id: str | None = None,
) -> dict[str, object]:
    row: dict[str, object] = {
        "expirationDate": EXPIRY.isoformat(),
        "strikePrice": strike,
        "contractType": right,
        "bid": bid,
        "ask": ask,
        "volume": volume,
        "openInterest": open_interest,
        "delta": delta,
        "gamma": 0.02,
        "theta": -0.04,
        "vega": 0.12,
        "impliedVolatility": 0.45,
    }
    if price_source is not None:
        row["price_source"] = price_source
    if quote_observed_at is not None:
        row["quote_observed_at"] = quote_observed_at
    if quote_fetched_at is not None:
        row["quote_fetched_at"] = quote_fetched_at
    if timestamp is not None:
        row["timestamp"] = timestamp
    if quote_as_of is not None:
        row["as_of"] = quote_as_of
    if provider_endpoint is not None:
        row["provider_endpoint"] = provider_endpoint
    if trace_id is not None:
        row["trace_id"] = trace_id
    return row
