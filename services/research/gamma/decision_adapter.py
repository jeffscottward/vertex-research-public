"""Guarded Gamma selector/committee boundary, with zero execution capabilities.

Raw mirrored kernels preserve source ordering/hashes. This adapter adds causal,
rights, finite-numeric and completeness checks without pretending that Gamma's
premium-at-risk heuristic is a broker margin model or reservation authority.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from gamma.adapter import InputArtifact, ResearchAdapter, freeze_native
from gamma.engines.options_strategy_selector import OptionsStrategySelector, StrategySelectionConstraints
from gamma.engines.portfolio_committee import PortfolioCommittee, PortfolioRiskConstraints
from gamma.schemas import MarketRegime, OptionsStrategyIntent, TradeSetup
from gamma.schemas.base import canonical_artifact_json

MAX_CANDIDATES = 500
# Source spread constructors enumerate pairs quadratically. This is a compute
# budget, not market filtering: reject oversized input rather than truncate it.
MAX_CONTRACTS = 512
ADAPTER_VERSION = "gamma-decisions-v1"
LIMITATIONS = (
    "Research proposal only; executionAuthorized is false and no cash/shares are reserved.",
    "Source binary64 computations and heuristic confidence are not calibrated probabilities.",
    "Gamma midpoint quotes and premium-at-risk sizing do not establish executable prices, margin, fill quality or protective orders.",
    "Missing Gamma Greek inputs may be aggregated as zero; this is not measured zero exposure.",
    "Calendar, diagonal and iron-condor vocabulary is not a Gamma constructor or qualified strategy.",
    "Source quote provenance labels are not independent proof of feed entitlement or real quotes.",
)


@dataclass(frozen=True, slots=True)
class ResearchInputDecision:
    """Internal response from an authoritative rights/freshness policy port."""

    source_sha256: str
    evidence_id: str
    permitted: bool
    status: Literal["fresh", "stale", "missing", "unknown"]
    valid_until: datetime
    source_kind: Literal["real", "synthetic", "source-unavailable"]
    reason_codes: tuple[str, ...] = ()


class InputPolicyPort(Protocol):
    def qualify(self, *, source: InputArtifact, as_of: datetime, operation: str) -> ResearchInputDecision: ...


@dataclass(frozen=True, slots=True)
class ResearchDecision:
    """Immutable native receipt, intentionally NOT a public TradeIntent."""

    status: Literal["candidate", "rejected", "unavailable"]
    operation: str
    as_of: datetime
    reason_codes: tuple[str, ...]
    native_payload: Mapping[str, Any] | None
    native_json: bytes | None
    native_output_sha256: str | None
    native_input_sha256: str | None
    native_identity_sha256: str | None
    input_identity: Mapping[str, Any]
    source_kinds: tuple[str, ...]
    limitations: tuple[str, ...] = LIMITATIONS
    proposal_only: Literal[True] = True
    execution_authorized: Literal[False] = False


def _time(value: datetime) -> datetime:
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("explicit aware research cutoff required")
    return value.astimezone(UTC)


def _finite(value: Any, *, depth: int = 0) -> None:
    if depth > 48:
        raise ValueError("native input exceeds depth bound")
    if type(value) is float and not math.isfinite(value):
        raise ValueError("nonfinite native input")
    if isinstance(value, Mapping):
        for child in value.values():
            _finite(child, depth=depth + 1)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _finite(child, depth=depth + 1)


def _number(value: Any, name: str, *, minimum: float = 0.0, maximum: float | None = None) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} cannot be boolean")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{name} requires a numeric value") from error
    if not math.isfinite(number) or number < minimum or (maximum is not None and number > maximum):
        raise ValueError(f"{name} is outside finite bounds")
    return number


def _selection_constraints(value: StrategySelectionConstraints) -> None:
    if not isinstance(value, StrategySelectionConstraints):
        raise ValueError("explicit selection constraints required")
    for name, number in asdict(value).items():
        if type(number) not in (int, float):
            raise ValueError(f"{name} requires a native numeric constraint")
        _number(number, name, minimum=-1.0 if name == "put_delta_target" else 0.0)
    if value.min_dte < 1 or value.max_dte < value.min_dte:
        raise ValueError("Gamma source constructors require positive bounded DTE; 0DTE is a separate owner")
    for name in ("min_dte", "max_dte", "min_open_interest", "min_volume"):
        if type(getattr(value, name)) is not int:
            raise ValueError(f"{name} requires integer input")
    if not -1 <= value.put_delta_target <= 0 or not 0 <= value.call_delta_target <= 1:
        raise ValueError("invalid delta targets")
    if value.max_delta_deviation > 1 or value.max_bid_ask_spread_pct > 2:
        raise ValueError("invalid fractional selection constraints")
    if value.max_premium <= 0 or value.max_loss <= 0:
        raise ValueError("positive premium and loss limits required")


def _portfolio_constraints(value: PortfolioRiskConstraints) -> None:
    if not isinstance(value, PortfolioRiskConstraints):
        raise ValueError("explicit portfolio constraints required")
    for name, number in asdict(value).items():
        if number is None and name == "max_premium_per_trade":
            continue
        if type(number) not in (int, float):
            raise ValueError(f"{name} requires a native numeric constraint")
        _number(number, name, maximum=1.0 if name.endswith("_pct") else None)


class GammaDecisionAdapter(ResearchAdapter):
    """Explicit-clock, hash-bound decisions with no provider, store or model I/O.

    The inherited parser supplies native timestamp/byte bounds and detached
    receipt handling. Default policy is absent: work is unavailable, not allowed.
    Even a candidate result has no execution meaning.
    """

    def __init__(self, *, as_of: datetime, input_policy: InputPolicyPort | None = None) -> None:
        super().__init__(as_of=_time(as_of))
        self._policy = input_policy

    def _qualify(self, operation: str, inputs: Mapping[str, InputArtifact]) -> tuple[tuple[ResearchInputDecision, ...], tuple[str, ...]]:
        if self._policy is None:
            return (), ("input-policy-unavailable",)
        decisions: list[ResearchInputDecision] = []
        for name, source in inputs.items():
            if not isinstance(source, InputArtifact):
                raise ValueError("decision input requires immutable InputArtifact")
            if source.available_at > self._as_of:
                raise ValueError("source not available at decision cutoff")
            try:
                decision = self._policy.qualify(source=source, as_of=self._as_of, operation=operation)
            except Exception:
                return (), ("input-policy-failed",)
            if not isinstance(decision, ResearchInputDecision):
                return (), ("input-policy-invalid-response",)
            if decision.source_sha256 != source.expected_sha256 or not decision.evidence_id:
                return (), ("input-policy-identity-mismatch",)
            try:
                valid = _time(decision.valid_until) > self._as_of
            except ValueError:
                return (), ("input-policy-invalid-expiry",)
            if decision.permitted is not True or decision.status != "fresh" or not valid:
                return (), (f"{name}-not-qualified",)
            if decision.source_kind not in ("real", "synthetic"):
                return (), (f"{name}-source-unavailable",)
            decisions.append(decision)
        return tuple(decisions), ()

    def _unavailable(self, operation: str, reasons: tuple[str, ...]) -> ResearchDecision:
        return ResearchDecision("unavailable", operation, self._as_of, reasons, None, None, None, None, None, freeze_native({}), ())

    def _decision(self, *, operation: str, model: Any, inputs: Mapping[str, InputArtifact], constraints: Any,
                  qualifications: tuple[ResearchInputDecision, ...], accepted: bool) -> ResearchDecision:
        native = self._result(operation, model, inputs)
        identity = {
            "adapterVersion": ADAPTER_VERSION,
            "asOf": self._as_of,
            "operation": operation,
            "inputs": {name: {"sourceSha256": source.expected_sha256, "observedAt": source.observed_at,
                              "availableAt": source.available_at} for name, source in inputs.items()},
            "constraints": asdict(constraints),
            "qualification": [asdict(item) for item in qualifications],
        }
        input_hash = hashlib.sha256(canonical_artifact_json(identity).encode()).hexdigest()
        identity_hash = hashlib.sha256(canonical_artifact_json({"inputHash": input_hash, "outputHash": native.native_sha256}).encode()).hexdigest()
        return ResearchDecision("candidate" if accepted else "rejected", operation, self._as_of,
                                () if accepted else ("no-native-candidate",), native.payload, native.native_json,
                                native.native_sha256, input_hash, identity_hash, freeze_native(identity),
                                tuple(sorted({item.source_kind for item in qualifications})))

    def select(self, *, setup: InputArtifact, option_chain: InputArtifact,
               constraints: StrategySelectionConstraints, financial_context: InputArtifact | None = None) -> ResearchDecision:
        _selection_constraints(constraints)
        inputs = {"setup": setup, "option_chain": option_chain}
        if financial_context is not None:
            inputs["financial_context"] = financial_context
        qualifications, reasons = self._qualify("options-selector", inputs)
        if reasons:
            return self._unavailable("options-selector", reasons)
        setup_data = self._object(setup)
        _finite(setup_data)
        native_setup = TradeSetup.model_validate(setup_data)
        # Pydantic source models may coerce numeric strings; inspect parsed values as well.
        freeze_native(native_setup)
        rows = self._rows(option_chain, require_time=False)
        if len(rows) > MAX_CONTRACTS:
            raise ValueError("option chain exceeds bounded research capacity")
        numeric = ("strike", "strikePrice", "strike_price", "bid", "bidPrice", "bid_price", "ask", "askPrice", "ask_price",
                   "delta", "gamma", "theta", "vega", "implied_volatility", "impliedVolatility", "iv",
                   "volume", "option_volume", "open_interest", "openInterest", "oi")
        for row in rows:
            for key in numeric:
                if row.get(key) is not None:
                    _number(row[key], key, minimum=-float("inf") if key in ("delta", "theta", "gamma", "vega") else 0)
            for key in ("quote_observed_at", "quote_fetched_at", "fetched_at", "as_of", "observed_at", "timestamp"):
                if row.get(key) is not None:
                    # Native datetime parser rejects nanosecond truncation and ambiguous naive times.
                    from gamma.adapter import _timestamp
                    if _timestamp(row[key]) > (option_chain.available_at if "fetch" in key else option_chain.observed_at):
                        raise ValueError("quote timestamp exceeds source knowledge horizon")
        financial = self._object(financial_context) if financial_context is not None else None
        result = OptionsStrategySelector(constraints=constraints).select(setup=native_setup, option_chain=rows,
                    as_of=self._as_of, financial_datasets_context=financial)
        return self._decision(operation="options-selector", model=result, inputs=inputs, constraints=constraints,
                              qualifications=qualifications, accepted=result.strategy_intent is not None)

    def allocate(self, *, portfolio: InputArtifact, constraints: PortfolioRiskConstraints) -> ResearchDecision:
        """Return source-ordered premium budget proposals, NEVER reservations.

        Input is one content-addressed snapshot so account/positions/intents cannot
        be mixed across mutable observations. Only explicit cash_available is used.
        """
        _portfolio_constraints(constraints)
        inputs = {"portfolio": portfolio}
        qualifications, reasons = self._qualify("portfolio-committee", inputs)
        if reasons:
            return self._unavailable("portfolio-committee", reasons)
        data = self._object(portfolio)
        _finite(data)
        allowed = {"strategy_intents", "account_state", "current_positions", "theme_exposures", "theme_exposure_unit",
                   "market_regime", "trade_themes", "correlation_groups", "event_risk_tickers", "commentary"}
        if set(data) - allowed:
            raise ValueError("unknown portfolio research input fields")
        account = data.get("account_state")
        if not isinstance(account, dict) or "cash_available" not in account:
            raise ValueError("observed cash_available required; buying power is not cash")
        _number(account["cash_available"], "cash_available")
        raw_intents = data.get("strategy_intents")
        if not isinstance(raw_intents, list) or len(raw_intents) > MAX_CANDIDATES:
            raise ValueError("bounded strategy_intents list required")
        intents = [OptionsStrategyIntent.model_validate(item) for item in raw_intents]
        freeze_native(intents)
        if len({intent.intent_id for intent in intents}) != len(intents):
            raise ValueError("duplicate intent identity")
        if any(not intent.intent_id.strip() for intent in intents):
            raise ValueError("empty intent identity")
        positions = data.get("current_positions")
        if not isinstance(positions, list) or len(positions) > MAX_CANDIDATES:
            raise ValueError("bounded position list required")
        for position in positions:
            if not isinstance(position, dict) or not position.get("ticker"):
                raise ValueError("position identity unavailable")
            risk = next((position[key] for key in ("premium_at_risk", "max_loss", "risk") if position.get(key) is not None), None)
            if risk is None:
                raise ValueError("position risk unavailable; missing risk cannot become zero")
            _number(risk, "position risk")
            if not position.get("expiry"):
                raise ValueError("position expiry unavailable for same-expiry cap")
            from datetime import date
            date.fromisoformat(position["expiry"])
        themes = data.get("theme_exposures")
        if not isinstance(themes, dict):
            raise ValueError("theme exposure mapping required")
        if themes and data.get("theme_exposure_unit") not in ("cash-fraction", "currency"):
            raise ValueError("explicit theme exposure units required")
        for exposure in themes.values():
            amount = _number(exposure, "theme exposure", maximum=1 if data.get("theme_exposure_unit") == "cash-fraction" else None)
            if data.get("theme_exposure_unit") == "currency" and 0 < amount <= 1:
                return self._unavailable("portfolio-committee", ("native-theme-unit-ambiguity",))
        for field in ("trade_themes", "correlation_groups"):
            groups = data.get(field)
            if not isinstance(groups, dict) or len(groups) > MAX_CANDIDATES:
                raise ValueError(f"explicit bounded {field} mapping required")
            if any(not isinstance(key, str) or not key or not isinstance(items, list) or not items
                   or len(items) > MAX_CANDIDATES or any(type(item) is not str or not item for item in items)
                   for key, items in groups.items()):
                raise ValueError(f"invalid {field} membership")
        if any(intent.intent_id not in data["trade_themes"] for intent in intents):
            return self._unavailable("portfolio-committee", ("trade-theme-classification-unavailable",))
        events = data.get("event_risk_tickers")
        if not isinstance(events, list) or len(events) > MAX_CANDIDATES or any(type(item) is not str or not item for item in events):
            raise ValueError("explicit event-risk classification list required")
        regime = MarketRegime.model_validate(data["market_regime"]) if data.get("market_regime") is not None else None
        if regime is not None:
            freeze_native(regime)
        result = PortfolioCommittee(constraints=constraints).allocate(strategy_intents=intents, account_state=account,
                    current_positions=positions, theme_exposures=themes, market_regime=regime,
                    trade_themes=data.get("trade_themes"), correlation_groups=data.get("correlation_groups"),
                    event_risk_tickers=data.get("event_risk_tickers", ()), commentary=data.get("commentary"))
        return self._decision(operation="portfolio-committee", model=result, inputs=inputs, constraints=constraints,
                              qualifications=qualifications, accepted=bool(result.accepted_trades))
