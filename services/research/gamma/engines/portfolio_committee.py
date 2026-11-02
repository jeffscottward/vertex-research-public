"""Deterministic options-native portfolio allocation."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import date
from typing import Any

from gamma.schemas import (
    MarketRegime,
    OptionsStrategyIntent,
    PortfolioAllocation,
    RejectedTrade,
    artifact_hash,
)

ALLOWED_COMMENTARY_FIELDS = frozenset({"why", "what_to_monitor"})


@dataclass(frozen=True)
class PortfolioRiskConstraints:
    """Hard portfolio risk limits for options premium-at-risk allocation."""

    max_premium_per_trade: float | None = None
    max_portfolio_premium_at_risk_pct: float = 0.20
    max_trade_risk_pct: float = 0.05
    max_theme_exposure_pct: float = 0.20
    max_ticker_exposure_pct: float = 0.10
    max_correlated_exposure_pct: float = 0.25
    max_same_expiry_exposure_pct: float = 0.25
    max_event_risk_exposure_pct: float = 0.10


class PortfolioCommittee:
    """Accept, reject, and size strategy intents under hard risk constraints."""

    def __init__(
        self,
        *,
        constraints: PortfolioRiskConstraints | None = None,
    ) -> None:
        self._constraints = constraints or PortfolioRiskConstraints()

    def allocate(
        self,
        *,
        strategy_intents: Sequence[OptionsStrategyIntent],
        account_state: Mapping[str, Any],
        current_positions: Sequence[Mapping[str, Any]] = (),
        theme_exposures: Mapping[str, float] | None = None,
        market_regime: MarketRegime | None = None,
        trade_themes: Mapping[str, Sequence[str]] | None = None,
        correlation_groups: Mapping[str, Sequence[str]] | None = None,
        event_risk_tickers: Sequence[str] = (),
        commentary: Mapping[str, Mapping[str, str]] | None = None,
    ) -> PortfolioAllocation:
        cash_available = _cash_available(account_state)
        portfolio_limit = _portfolio_limit(
            cash_available,
            self._constraints,
            market_regime,
        )
        state = _AllocationState.from_inputs(
            cash_available=cash_available,
            current_positions=current_positions,
            theme_exposures=theme_exposures or {},
            correlation_groups=correlation_groups or {},
        )
        accepted: list[OptionsStrategyIntent] = []
        rejected: list[RejectedTrade] = []
        trade_sizes: dict[str, float] = {}

        for intent in _ordered_intents(strategy_intents):
            themes = list((trade_themes or {}).get(intent.intent_id, ["unclassified"]))
            event_risk = intent.ticker.upper() in {
                ticker.upper() for ticker in event_risk_tickers
            }
            reason = _rejection_reason(
                intent=intent,
                state=state,
                cash_available=cash_available,
                portfolio_limit=portfolio_limit,
                constraints=self._constraints,
                themes=themes,
                event_risk=event_risk,
            )
            if reason is not None:
                rejected.append(
                    _rejected(
                        intent,
                        reason,
                        {
                            "premium_at_risk": intent.max_loss,
                            "themes": themes,
                            "constraints": asdict(self._constraints),
                        },
                    )
                )
                continue
            accepted.append(intent)
            trade_sizes[intent.intent_id] = round(intent.max_loss, 2)
            state.add(intent, themes=themes, event_risk=event_risk)

        return PortfolioAllocation(
            allocation_id=_allocation_id(
                cash_available=cash_available,
                strategy_intents=strategy_intents,
                trade_sizes=trade_sizes,
                rejected_trades=rejected,
                constraints=self._constraints,
                market_regime=market_regime,
            ),
            cash_available=cash_available,
            max_premium_at_risk=round(portfolio_limit, 2),
            max_trade_risk_pct=self._constraints.max_trade_risk_pct,
            max_theme_exposure_pct=self._constraints.max_theme_exposure_pct,
            max_ticker_exposure_pct=self._constraints.max_ticker_exposure_pct,
            accepted_trades=accepted,
            rejected_trades=rejected,
            trade_sizes=trade_sizes,
            risk_summary=state.summary(portfolio_limit),
            commentary=_limited_commentary(commentary),
        )


@dataclass
class _AllocationState:
    total_premium_at_risk: float
    ticker_exposure: dict[str, float]
    theme_exposure: dict[str, float]
    correlated_exposure: dict[str, float]
    same_expiry_exposure: dict[str, float]
    event_risk_exposure: float
    correlation_groups: Mapping[str, Sequence[str]]

    @classmethod
    def from_inputs(
        cls,
        *,
        cash_available: float,
        current_positions: Sequence[Mapping[str, Any]],
        theme_exposures: Mapping[str, float],
        correlation_groups: Mapping[str, Sequence[str]],
    ) -> _AllocationState:
        state = cls(
            total_premium_at_risk=0.0,
            ticker_exposure={},
            theme_exposure={
                theme: _exposure_value(value, cash_available)
                for theme, value in theme_exposures.items()
            },
            correlated_exposure={},
            same_expiry_exposure={},
            event_risk_exposure=0.0,
            correlation_groups=correlation_groups,
        )
        for position in current_positions:
            premium = _position_premium(position)
            ticker = str(position.get("ticker", "")).upper()
            if premium <= 0:
                continue
            state.total_premium_at_risk += premium
            if ticker:
                state.ticker_exposure[ticker] = (
                    state.ticker_exposure.get(ticker, 0.0) + premium
                )
                for group in _correlation_groups_for_ticker(ticker, correlation_groups):
                    state.correlated_exposure[group] = (
                        state.correlated_exposure.get(group, 0.0) + premium
                    )
            expiry = _position_expiry(position)
            if expiry is not None:
                key = expiry.isoformat()
                state.same_expiry_exposure[key] = (
                    state.same_expiry_exposure.get(key, 0.0) + premium
                )
            if bool(position.get("event_risk")):
                state.event_risk_exposure += premium
        return state

    def add(
        self,
        intent: OptionsStrategyIntent,
        *,
        themes: Sequence[str],
        event_risk: bool,
    ) -> None:
        premium = intent.max_loss
        ticker = intent.ticker.upper()
        self.total_premium_at_risk += premium
        self.ticker_exposure[ticker] = self.ticker_exposure.get(ticker, 0.0) + premium
        for theme in themes:
            self.theme_exposure[theme] = self.theme_exposure.get(theme, 0.0) + premium
        for group in _correlation_groups_for_ticker(ticker, self.correlation_groups):
            self.correlated_exposure[group] = (
                self.correlated_exposure.get(group, 0.0) + premium
            )
        expiry_key = min(leg.expiry for leg in intent.legs).isoformat()
        self.same_expiry_exposure[expiry_key] = (
            self.same_expiry_exposure.get(expiry_key, 0.0) + premium
        )
        if event_risk:
            self.event_risk_exposure += premium

    def summary(self, portfolio_limit: float) -> dict[str, Any]:
        return {
            "portfolio_limit": round(portfolio_limit, 2),
            "total_premium_at_risk": round(self.total_premium_at_risk, 2),
            "ticker_exposure": _rounded_mapping(self.ticker_exposure),
            "theme_exposure": _rounded_mapping(self.theme_exposure),
            "correlated_exposure": _rounded_mapping(self.correlated_exposure),
            "same_expiry_exposure": _rounded_mapping(self.same_expiry_exposure),
            "event_risk_exposure": round(self.event_risk_exposure, 2),
        }


def _rejection_reason(
    *,
    intent: OptionsStrategyIntent,
    state: _AllocationState,
    cash_available: float,
    portfolio_limit: float,
    constraints: PortfolioRiskConstraints,
    themes: Sequence[str],
    event_risk: bool,
) -> str | None:
    premium = intent.max_loss
    per_trade_limit = min(
        constraints.max_premium_per_trade
        if constraints.max_premium_per_trade is not None
        else float("inf"),
        cash_available * constraints.max_trade_risk_pct,
    )
    if premium > per_trade_limit:
        return "max premium per trade exceeded"
    if state.total_premium_at_risk + premium > portfolio_limit:
        return "max portfolio premium at risk exceeded"
    ticker_limit = cash_available * constraints.max_ticker_exposure_pct
    ticker = intent.ticker.upper()
    if state.ticker_exposure.get(ticker, 0.0) + premium > ticker_limit:
        return "max ticker exposure exceeded"
    theme_limit = cash_available * constraints.max_theme_exposure_pct
    for theme in themes:
        if state.theme_exposure.get(theme, 0.0) + premium > theme_limit:
            return "max theme exposure exceeded"
    correlated_limit = cash_available * constraints.max_correlated_exposure_pct
    for group in _correlation_groups_for_ticker(ticker, state.correlation_groups):
        if state.correlated_exposure.get(group, 0.0) + premium > correlated_limit:
            return "max correlated exposure exceeded"
    expiry_limit = cash_available * constraints.max_same_expiry_exposure_pct
    expiry_key = min(leg.expiry for leg in intent.legs).isoformat()
    if state.same_expiry_exposure.get(expiry_key, 0.0) + premium > expiry_limit:
        return "max same-expiry concentration exceeded"
    event_limit = cash_available * constraints.max_event_risk_exposure_pct
    if event_risk and state.event_risk_exposure + premium > event_limit:
        return "max event-risk exposure exceeded"
    if _has_failed_liquidity_check(intent.liquidity_checks):
        return "liquidity check failed"
    return None


def _portfolio_limit(
    cash_available: float,
    constraints: PortfolioRiskConstraints,
    market_regime: MarketRegime | None,
) -> float:
    limit = cash_available * constraints.max_portfolio_premium_at_risk_pct
    if market_regime is None:
        return limit
    label = market_regime.regime_label.lower()
    if any(token in label for token in ("risk_off", "bear", "recession", "crash")):
        return limit * 0.75
    return limit


def _ordered_intents(
    strategy_intents: Sequence[OptionsStrategyIntent],
) -> list[OptionsStrategyIntent]:
    return sorted(
        strategy_intents,
        key=lambda intent: (-intent.confidence, intent.max_loss, intent.intent_id),
    )


def _cash_available(account_state: Mapping[str, Any]) -> float:
    for key in ("cash_available", "cash", "buying_power"):
        value = account_state.get(key)
        if value is not None:
            cash = float(value)
            if cash < 0:
                raise ValueError("cash_available must not be negative")
            return cash
    raise ValueError("account_state requires cash_available, cash, or buying_power")


def _position_premium(position: Mapping[str, Any]) -> float:
    for key in ("premium_at_risk", "max_loss", "risk"):
        value = position.get(key)
        if value is not None:
            return max(float(value), 0.0)
    return 0.0


def _position_expiry(position: Mapping[str, Any]) -> date | None:
    value = position.get("expiry")
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _exposure_value(value: float, cash_available: float) -> float:
    exposure = float(value)
    if 0 <= exposure <= 1:
        return exposure * cash_available
    return max(exposure, 0.0)


def _correlation_groups_for_ticker(
    ticker: str,
    correlation_groups: Mapping[str, Sequence[str]],
) -> list[str]:
    return [
        group
        for group, tickers in correlation_groups.items()
        if ticker.upper() in {item.upper() for item in tickers}
    ]


def _allocation_id(
    *,
    cash_available: float,
    strategy_intents: Sequence[OptionsStrategyIntent],
    trade_sizes: Mapping[str, float],
    rejected_trades: Sequence[RejectedTrade],
    constraints: PortfolioRiskConstraints,
    market_regime: MarketRegime | None,
) -> str:
    payload = {
        "cash_available": cash_available,
        "strategy_intents": [intent.to_json_dict() for intent in strategy_intents],
        "trade_sizes": dict(trade_sizes),
        "rejected": [trade.to_json_dict() for trade in rejected_trades],
        "constraints": asdict(constraints),
        "market_regime": market_regime.to_json_dict() if market_regime else None,
    }
    return f"allocation-{artifact_hash(payload)[:12]}"


def _limited_commentary(
    commentary: Mapping[str, Mapping[str, str]] | None,
) -> dict[str, dict[str, str]]:
    if not commentary:
        return {}
    limited: dict[str, dict[str, str]] = {}
    for intent_id, fields in commentary.items():
        clean = {
            key: str(value)
            for key, value in fields.items()
            if key in ALLOWED_COMMENTARY_FIELDS
        }
        if clean:
            limited[str(intent_id)] = clean
    return limited


def _has_failed_liquidity_check(value: Any) -> bool:
    if isinstance(value, bool):
        return not value
    if isinstance(value, dict):
        return any(_has_failed_liquidity_check(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_failed_liquidity_check(item) for item in value)
    return False


def _rejected(
    intent: OptionsStrategyIntent,
    reason: str,
    details: dict[str, Any] | None = None,
) -> RejectedTrade:
    return RejectedTrade(
        ticker=intent.ticker,
        reason=reason,
        stage="portfolio_committee",
        setup=None,
        strategy_intent=intent,
        details=details,
    )


def _rounded_mapping(values: Mapping[str, float]) -> dict[str, float]:
    return {key: round(value, 2) for key, value in sorted(values.items())}


__all__ = [
    "ALLOWED_COMMENTARY_FIELDS",
    "PortfolioCommittee",
    "PortfolioRiskConstraints",
]
