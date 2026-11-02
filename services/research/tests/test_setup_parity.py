"""SetupEngine tests."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from gamma.engines import SetupEngine
from gamma.features.fundamental_catalyst_features import (
    FundamentalCatalystFeatureSnapshot,
)
from gamma.features.liquidity_features import LiquidityFeatureSnapshot
from gamma.schemas import (
    CandidateCompany,
    MarketRegime,
    MarketStructureSnapshot,
    OptionContractFlow,
    OptionFlowSnapshot,
    ResearchBrief,
    SourceRef,
    VolatilitySnapshot,
)

NOW = datetime(2026, 6, 8, 12, 0, tzinfo=UTC)


def test_setup_engine_accepts_explainable_bullish_setup() -> None:
    engine = SetupEngine()

    setup = engine.identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(),
        market_structure=_market_structure(),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=NOW,
    )
    repeated = engine.identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(),
        market_structure=_market_structure(),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=NOW,
    )

    assert setup.setup_id == repeated.setup_id
    assert setup.direction == "bullish"
    assert setup.setup_score > 70
    assert setup.rejection_reasons == []
    assert set(setup.score_components) == {
        "research_theme_score",
        "flow_confirmation",
        "amt_breakout_pre_breakout_score",
        "volatility_suitability",
        "liquidity_score",
        "catalyst_timing",
        "fundamental_confirmation",
    }
    assert setup.preferred_strategy_types == ["long_call", "call_debit_spread"]


def test_setup_engine_preserves_rejected_setup_with_reasons() -> None:
    stale_flow = _flow_snapshot(as_of=NOW - timedelta(days=5), put_premium=2_500)
    wide_illiquid = _liquidity(
        spread=0.42,
        viable_count=0,
        total_volume=0,
        total_open_interest=0,
    )

    setup = SetupEngine().identify_setup(
        candidate=_candidate(options_available=False),
        research_brief=_research_brief(),
        flow_snapshot=stale_flow,
        market_structure=_market_structure(),
        volatility=_volatility(iv_rank=0.91),
        liquidity=wide_illiquid,
        fundamental_catalyst=_fundamental(earnings_dates=["2026-06-12"]),
        market_regime=_market_regime("risk_on_growth"),
        as_of=NOW,
    )

    assert setup.setup_score <= 49
    assert setup.rejection_reasons == [
        "no options liquidity",
        "flow contradicts thesis",
        "IV too high for long premium",
        "market regime conflict",
        "too close to earnings",
        "spread too wide",
        "stale data",
    ]


def test_setup_engine_allows_latest_daily_market_structure_after_weekend() -> None:
    friday_midnight = datetime(2026, 6, 5, 0, 0, tzinfo=UTC)
    monday_noon = datetime(2026, 6, 8, 12, 0, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(as_of=monday_noon),
        market_structure=_market_structure(as_of=friday_midnight),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=monday_noon,
    )

    assert "stale data" not in setup.rejection_reasons


def test_setup_engine_rejects_prior_daily_bar_at_exact_availability_boundary() -> None:
    friday_midnight = datetime(2026, 6, 5, 0, 0, tzinfo=UTC)
    monday_daily_bar_available = datetime(2026, 6, 8, 20, 15, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(as_of=monday_daily_bar_available),
        market_structure=_market_structure(as_of=friday_midnight),
        volatility=_volatility(as_of=monday_daily_bar_available),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=monday_daily_bar_available,
    )

    assert "stale data" in setup.rejection_reasons


def test_setup_engine_allows_daily_structure_after_observed_market_holiday() -> None:
    thursday_midnight = datetime(2026, 7, 2, 0, 0, tzinfo=UTC)
    monday_before_daily_bar = datetime(2026, 7, 6, 12, 0, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(as_of=monday_before_daily_bar),
        market_structure=_market_structure(as_of=thursday_midnight),
        volatility=_volatility(as_of=monday_before_daily_bar),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=monday_before_daily_bar,
    )

    assert "stale data" not in setup.rejection_reasons


def test_setup_engine_rejects_friday_daily_bar_after_monday_close() -> None:
    friday_midnight = datetime(2026, 6, 5, 0, 0, tzinfo=UTC)
    monday_after_close = datetime(2026, 6, 8, 20, 30, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(as_of=monday_after_close),
        market_structure=_market_structure(as_of=friday_midnight),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=monday_after_close,
    )

    assert "stale data" in setup.rejection_reasons


def test_setup_engine_rejects_friday_daily_market_structure_on_normal_tuesday() -> None:
    friday_midnight = datetime(2026, 6, 5, 0, 0, tzinfo=UTC)
    tuesday_noon = datetime(2026, 6, 9, 12, 0, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(as_of=tuesday_noon),
        market_structure=_market_structure(as_of=friday_midnight),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=tuesday_noon,
    )

    assert "stale data" in setup.rejection_reasons


def test_setup_engine_keeps_intraday_flow_freshness_strict_after_weekend() -> None:
    friday_flow = datetime(2026, 6, 5, 20, 0, tzinfo=UTC)
    monday_noon = datetime(2026, 6, 8, 12, 0, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(as_of=friday_flow),
        market_structure=_market_structure(as_of=friday_flow),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=monday_noon,
    )

    assert "stale data" in setup.rejection_reasons



def test_setup_engine_rejects_genuinely_stale_daily_market_structure() -> None:
    old_session = datetime(2026, 6, 1, 0, 0, tzinfo=UTC)

    setup = SetupEngine().identify_setup(
        candidate=_candidate(),
        research_brief=_research_brief(),
        flow_snapshot=_flow_snapshot(),
        market_structure=_market_structure(as_of=old_session),
        volatility=_volatility(),
        liquidity=_liquidity(),
        fundamental_catalyst=_fundamental(),
        market_regime=_market_regime("risk_on_growth"),
        as_of=NOW,
    )

    assert "stale data" in setup.rejection_reasons


def test_setup_engine_handles_missing_chain_and_absent_fundamentals() -> None:
    setup = SetupEngine().identify_setup(
        candidate=_candidate(options_available=None),
        research_brief=_research_brief(),
        flow_snapshot=None,
        market_structure=_market_structure(trend_label="range", breakout_status="none"),
        volatility=_volatility(),
        liquidity=None,
        fundamental_catalyst=None,
        as_of=NOW,
    )

    assert setup.rejection_reasons == ["missing chain", "structure unclear"]
    assert setup.score_components["fundamental_confirmation"] == 0.5
    assert not hasattr(setup, "legs")


def _candidate(options_available: bool | None = True) -> CandidateCompany:
    return CandidateCompany(
        ticker="COHR",
        company_name="Coherent Corp",
        theme_ids=["photonics"],
        why_it_fits="Optical interconnect supplier tied to AI cluster scale.",
        discovery_score=0.82,
        liquidity_score=0.75,
        options_available=options_available,
        options_volume=20_000,
        options_open_interest=80_000,
        score_signals={"theme_fit": 0.9},
    )


def _research_brief() -> ResearchBrief:
    return ResearchBrief(
        ticker="COHR",
        themes=["photonics"],
        bull_case="AI cluster bandwidth demand supports upside.",
        bear_case="Hyperscaler capex cuts would pressure estimates.",
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
    )


def _flow_snapshot(
    *,
    as_of: datetime = NOW,
    put_premium: float = 250,
) -> OptionFlowSnapshot:
    return OptionFlowSnapshot(
        ticker="COHR",
        as_of=as_of,
        total_call_premium=1_500,
        total_put_premium=put_premium,
        unusual_call_volume=2.4,
        unusual_put_volume=0.6,
        notable_contracts=[
            OptionContractFlow(
                underlying="COHR",
                expiry=date(2026, 7, 17),
                strike=90,
                right="call",
                side="ask",
                premium=1_500,
                volume=300,
                open_interest=1_200,
            )
        ],
        raw={"provider": "quantdata"},
    )


def _market_structure(
    *,
    as_of: datetime = NOW,
    trend_label: str = "uptrend",
    breakout_status: str = "breakout",
) -> MarketStructureSnapshot:
    return MarketStructureSnapshot(
        ticker="COHR",
        as_of=as_of,
        timeframe="1d",
        trend_label=trend_label,
        vwap_relation="above_vwap",
        value_area_relation="accepting_above",
        breakout_status=breakout_status,
        relative_volume=1.7,
        atr_percent=0.04,
        support_levels=[75.0, 80.0],
        resistance_levels=[95.0],
    )


def _volatility(
    iv_rank: float = 0.42,
    *,
    as_of: datetime = NOW,
) -> VolatilitySnapshot:
    return VolatilitySnapshot(
        ticker="COHR",
        as_of=as_of,
        iv_rank=iv_rank,
        iv_percentile=0.55,
        front_iv=0.48,
        back_iv=0.46,
        term_structure_label="flat",
        skew_label="call_skew",
        iv_change_label="stable",
        event_risk=[],
    )


def _liquidity(
    *,
    spread: float = 0.08,
    viable_count: int = 5,
    total_volume: float = 5_000,
    total_open_interest: float = 25_000,
) -> LiquidityFeatureSnapshot:
    return LiquidityFeatureSnapshot(
        ticker="COHR",
        as_of=NOW,
        stock_avg_volume=2_000_000,
        stock_relative_volume=1.3,
        option_contract_count=24,
        option_total_open_interest=total_open_interest,
        option_total_volume=total_volume,
        median_bid_ask_spread_pct=spread,
        minimum_viable_contract_count=viable_count,
        passes_minimum_contract_filters=viable_count > 0,
        raw={"provider": "quantdata"},
    )


def _fundamental(
    earnings_dates: list[str] | None = None,
) -> FundamentalCatalystFeatureSnapshot:
    return FundamentalCatalystFeatureSnapshot(
        ticker="COHR",
        sector="Technology",
        industry="Electronic Components",
        market_cap=8_000_000_000,
        employee_count=25_000,
        financial_metric_changes={"revenue_growth": 0.12},
        earnings_dates=earnings_dates or ["2026-07-31"],
        earnings_surprise_flags=["positive_surprise"],
        filing_sections={"item_1a": "Supply concentration risk."},
        insider_trade_summary={},
        institutional_holding_summary={"top_holder": "Example Fund"},
        index_fund_exposure={"listed_in": ["IWM"]},
        raw={"provider": "financialdatasets"},
    )


def _market_regime(label: str) -> MarketRegime:
    return MarketRegime(
        as_of=NOW,
        regime_label=label,
        confidence=0.7,
        evidence=["fixture regime"],
        source_refs=[],
    )
