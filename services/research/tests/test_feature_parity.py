"""Feature engine tests."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from gamma.features import (
    FundamentalCatalystFeatures,
    LiquidityFeatures,
    MarketStructureFeatures,
    MomentumFeatures,
    OptionFlowFeatures,
    VolatilityFeatures,
)
from gamma.schemas import OptionContractFlow, OptionFlowSnapshot

NOW = datetime(2026, 6, 8, 12, 0, tzinfo=UTC)


def test_option_flow_features_from_normalized_quantdata_snapshot() -> None:
    expiry = date(2026, 7, 17)
    snapshot = OptionFlowSnapshot(
        ticker="COHR",
        as_of=NOW,
        unusual_call_volume=2.5,
        unusual_put_volume=0.4,
        notable_contracts=[
            OptionContractFlow(
                underlying="COHR",
                expiry=expiry,
                strike=50,
                right="call",
                side="ask",
                premium=100,
                volume=50,
                open_interest=200,
                raw={"condition": "sweep"},
            ),
            OptionContractFlow(
                underlying="COHR",
                expiry=expiry,
                strike=50,
                right="call",
                side="bid",
                premium=80,
                volume=40,
                open_interest=100,
            ),
            OptionContractFlow(
                underlying="COHR",
                expiry=date(2026, 12, 18),
                strike=45,
                right="put",
                side="bid",
                premium=90,
                volume=30,
                open_interest=60,
                raw={"type": "block"},
            ),
        ],
        raw={"provider": "quantdata"},
    )

    features = OptionFlowFeatures().compute(snapshot)

    assert features.call_premium == 180
    assert features.put_premium == 90
    assert features.call_put_premium_ratio == 2
    assert features.ask_side_call_premium == 100
    assert features.bid_side_put_premium == 90
    assert features.sweep_count == 1
    assert features.block_count == 1
    assert features.open_interest_validated is True
    assert features.repeated_strikes == [50]
    assert features.repeated_expiries == [expiry]
    assert features.flow_label == "bullish"


def test_market_structure_features_from_real_ohlcv_rows() -> None:
    rows = _price_rows(days=30, start=100, step=1.0)
    rows[-1]["close"] = 135
    rows[-1]["high"] = 136
    rows[-1]["vwap"] = 132

    features = MarketStructureFeatures().compute(ticker="cohr", rows=rows)

    assert features.ticker == "COHR"
    assert features.trend_label == "uptrend"
    assert features.vwap_relation == "above_vwap"
    assert features.breakout_status == "breakout"
    assert features.relative_volume is not None
    assert features.atr_percent is not None
    assert features.raw["value_area_method"] == "ohlcv_close_distribution_approximation"


def test_volatility_features_from_quantdata_payload() -> None:
    features = VolatilityFeatures().compute(
        ticker="COHR",
        payload={
            "timestamp": NOW.isoformat(),
            "ivRank": 0.72,
            "ivPercentile": 0.66,
            "frontMonthIv": 0.62,
            "backMonthIv": 0.48,
            "callSkew": 0.18,
            "putSkew": 0.10,
            "ivChange": 0.05,
            "events": ["earnings"],
        },
    )

    assert features.term_structure_label == "backwardation"
    assert features.skew_label == "call_skew"
    assert features.iv_change_label == "expanding"
    assert features.event_risk == ["earnings"]


def test_volatility_features_requires_provider_or_explicit_timestamp() -> None:
    with pytest.raises(ValueError, match="requires as_of"):
        VolatilityFeatures().compute(ticker="COHR", payload={"ivRank": 0.72})

    features = VolatilityFeatures().compute(
        ticker="COHR",
        payload={"ivRank": 0.72},
        as_of=NOW,
    )

    assert features.as_of == NOW


def test_momentum_features_from_stock_and_benchmark_rows() -> None:
    rows = _price_rows(days=55, start=50, step=0.8)
    rows[-1]["open"] = rows[-2]["close"] * 1.03
    rows[-1]["close"] = rows[-1]["open"] * 1.01
    rows[-1]["high"] = rows[-1]["close"] + 1
    rows[-1]["volume"] = 5_000_000
    spy_rows = _price_rows(days=55, start=400, step=0.2)
    qqq_rows = _price_rows(days=55, start=300, step=0.1)

    features = MomentumFeatures().compute(
        ticker="cohr",
        rows=rows,
        spy_rows=spy_rows,
        qqq_rows=qqq_rows,
    )

    assert features.twenty_day_breakout is True
    assert features.fifty_day_breakout is True
    assert features.volume_expansion is True
    assert features.gap_and_hold is True
    assert features.relative_strength_vs_spy is not None
    assert features.relative_strength_vs_qqq is not None


def test_liquidity_features_from_stock_rows_and_quantdata_chain() -> None:
    rows = _price_rows(days=5, start=50, step=0.5)
    option_chain = [
        {"bid": 1.0, "ask": 1.1, "volume": 500, "open_interest": 2_000},
        {"bid": 2.0, "ask": 2.8, "volume": 3, "openInterest": 50},
    ]

    features = LiquidityFeatures().compute(
        ticker="COHR",
        stock_rows=rows,
        option_chain=option_chain,
    )

    assert features.stock_avg_volume is not None
    assert features.option_contract_count == 2
    assert features.option_total_open_interest == 2_050
    assert features.option_total_volume == 503
    assert features.minimum_viable_contract_count == 1
    assert features.passes_minimum_contract_filters is True


def test_liquidity_features_uses_explicit_as_of_when_rows_have_no_timestamp() -> None:
    features = LiquidityFeatures().compute(
        ticker="COHR",
        option_chain=[{"bid": 1.0, "ask": 1.1, "volume": 500, "open_interest": 2_000}],
        as_of=NOW,
    )

    assert features.as_of == NOW


def test_liquidity_features_requires_real_or_explicit_timestamp() -> None:
    with pytest.raises(ValueError, match="explicit as_of"):
        LiquidityFeatures().compute(
            ticker="COHR",
            option_chain=[
                {"bid": 1.0, "ask": 1.1, "volume": 500, "open_interest": 2_000}
            ],
        )


def test_fundamental_catalyst_features_from_financial_datasets_context() -> None:
    features = FundamentalCatalystFeatures().compute(
        ticker="COHR",
        payload={
            "company_facts": {
                "sector": "Technology",
                "industry": "Electronic Components",
                "marketCap": 8_000_000_000,
                "employeeCount": 25_000,
            },
            "financial_metrics": {"revenue_growth": 0.12, "gross_margin_delta": 0.03},
            "earnings": [
                {"date": "2026-07-31", "surprise_percent": 8.5},
                {"date": "2026-04-30", "surprise_percent": -6.0},
            ],
            "filings": [{"item_1a": "Supply concentration risk."}],
            "insider_trades": {"net_shares": 1200},
            "institutional_holdings": {"top_holder": "Example Fund"},
            "index_fund_exposure": {"listed_in": ["IWM"]},
        },
    )

    assert features.sector == "Technology"
    assert features.market_cap == 8_000_000_000
    assert features.financial_metric_changes == {
        "revenue_growth": 0.12,
        "gross_margin_delta": 0.03,
    }
    assert features.earnings_surprise_flags == [
        "positive_surprise",
        "negative_surprise",
    ]
    assert features.filing_sections == {"item_1a": "Supply concentration risk."}
    assert features.index_fund_exposure == {"listed_in": ["IWM"]}


def _price_rows(*, days: int, start: float, step: float) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for index in range(days):
        close = start + index * step
        rows.append(
            {
                "date": (NOW.date() - timedelta(days=days - index)).isoformat(),
                "open": close - 0.5,
                "high": close + 0.5,
                "low": close - 1.0,
                "close": close,
                "volume": 1_000_000 + index * 10_000,
                "vwap": close - 0.2,
            }
        )
    return rows
