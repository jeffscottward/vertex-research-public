"""PortfolioCommittee tests."""

from __future__ import annotations

from datetime import UTC, date, datetime

from gamma.engines import PortfolioCommittee, PortfolioRiskConstraints
from gamma.schemas import MarketRegime, OptionLeg, OptionsStrategyIntent

NOW = datetime(2026, 6, 8, 12, 0, tzinfo=UTC)
EXPIRY = date(2026, 7, 18)


def test_portfolio_committee_accepts_and_sizes_deterministically() -> None:
    committee = PortfolioCommittee(
        constraints=PortfolioRiskConstraints(max_premium_per_trade=500)
    )
    intents = [
        _intent("cohr-call", "COHR", max_loss=300, confidence=0.8),
        _intent("lite-call", "LITE", max_loss=250, confidence=0.7),
    ]

    allocation = committee.allocate(
        strategy_intents=intents,
        account_state={"cash_available": 10_000},
        current_positions=[],
        theme_exposures={"photonics": 0.01},
        trade_themes={"cohr-call": ["photonics"], "lite-call": ["photonics"]},
        market_regime=_regime("risk_on_growth"),
    )
    repeated = committee.allocate(
        strategy_intents=intents,
        account_state={"cash_available": 10_000},
        current_positions=[],
        theme_exposures={"photonics": 0.01},
        trade_themes={"cohr-call": ["photonics"], "lite-call": ["photonics"]},
        market_regime=_regime("risk_on_growth"),
    )

    assert allocation.allocation_id == repeated.allocation_id
    assert [trade.intent_id for trade in allocation.accepted_trades] == [
        "cohr-call",
        "lite-call",
    ]
    assert allocation.trade_sizes == {"cohr-call": 300.0, "lite-call": 250.0}
    assert allocation.to_json_dict()["trade_sizes"]["cohr-call"] == 300.0


def test_portfolio_committee_rejects_trades_over_hard_risk_limits() -> None:
    committee = PortfolioCommittee(
        constraints=PortfolioRiskConstraints(
            max_premium_per_trade=400,
            max_ticker_exposure_pct=0.05,
        )
    )

    allocation = committee.allocate(
        strategy_intents=[
            _intent("cohr-big", "COHR", max_loss=450, confidence=0.9),
            _intent("cohr-small", "COHR", max_loss=300, confidence=0.8),
            _intent("cohr-second", "COHR", max_loss=250, confidence=0.7),
        ],
        account_state={"cash_available": 10_000},
        current_positions=[],
        trade_themes={"cohr-small": ["photonics"], "cohr-second": ["photonics"]},
        market_regime=_regime("risk_on_growth"),
    )

    assert [trade.intent_id for trade in allocation.accepted_trades] == ["cohr-small"]
    assert [trade.reason for trade in allocation.rejected_trades] == [
        "max premium per trade exceeded",
        "max ticker exposure exceeded",
    ]


def test_commentary_cannot_override_hard_constraints() -> None:
    intent = _intent("cohr-big", "COHR", max_loss=800, confidence=0.9)

    allocation = PortfolioCommittee(
        constraints=PortfolioRiskConstraints(max_premium_per_trade=400)
    ).allocate(
        strategy_intents=[intent],
        account_state={"cash_available": 10_000},
        current_positions=[],
        commentary={
            "cohr-big": {
                "why": "LLM says accept it.",
                "what_to_monitor": "Watch IV.",
                "override": "accept",
            }
        },
    )

    assert allocation.accepted_trades == []
    assert allocation.rejected_trades[0].reason == "max premium per trade exceeded"
    assert allocation.commentary == {
        "cohr-big": {"why": "LLM says accept it.", "what_to_monitor": "Watch IV."}
    }


def _intent(
    intent_id: str,
    ticker: str,
    *,
    max_loss: float,
    confidence: float,
) -> OptionsStrategyIntent:
    return OptionsStrategyIntent(
        intent_id=intent_id,
        ticker=ticker,
        strategy_type="long_call",
        direction="bullish",
        legs=[
            OptionLeg(
                side="buy",
                right="call",
                expiry=EXPIRY,
                strike=100,
                quantity=1,
                limit_price=max_loss / 100,
            )
        ],
        max_loss=max_loss,
        max_profit=None,
        net_debit_or_credit=-max_loss,
        breakevens=[100 + max_loss / 100],
        target_profit_pct=0.5,
        stop_loss_pct=0.35,
        dte=40,
        greeks={"delta": 0.45},
        liquidity_checks={"bid_ask_spread_ok": True},
        thesis="Photonics demand supports upside.",
        invalidation="Close below support.",
        confidence=confidence,
    )


def _regime(label: str) -> MarketRegime:
    return MarketRegime(
        as_of=NOW,
        regime_label=label,
        confidence=0.7,
        evidence=["fixture"],
        source_refs=[],
    )
