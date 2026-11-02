"""Unmounted, concrete extension for reviewed wheel early-exercise research.

Integration proposal, serialized through the existing sleeve caller owner:
operation: wheel-early-exercise-review
required roles: wheel_state, exercise_quotes
optional role: dividend_calendar (mandatory for an American call)
parameters: maximum_quote_age_seconds (0..86400),
            maximum_dividend_age_seconds (0..31536000)

Use the same exact input/dependency/current-review loading, 64-pin/16MB total
budgets, _Job admission and final immutable publication as sleeve_research.
After loading and reviewing ALL sources, decode_wheel_exercise(policy, params)
then compute_wheel_exercise(decoded) actually invokes early_exercise_review.
Do NOT bypass source review, publish these results accepted, or call an event
transition. Recipe/handler/operation registry wiring is intentionally NOT made
here while another source owner holds the shared recipe files.

Source payloads are closed and documented below. No missing quote becomes a
zero; no missing dividend calendar becomes an assertion of no dividend. A
supplied WheelState is expressly research-state input, never reconciled actual
holdings, capital, assignment or collateral proof. Selection/roll/event methods
are not silently emulated by this exercise-risk computation.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from strategies.core import ResearchDecision
from strategies.wheel import WheelState, early_exercise_review

OPERATION = "wheel-early-exercise-review"
REQUIRED_ROLES = frozenset({"wheel_state", "exercise_quotes"})
OPTIONAL_ROLES = frozenset({"dividend_calendar"})
PARAMETER_FIELDS = frozenset({"maximum_quote_age_seconds", "maximum_dividend_age_seconds"})
QUOTE_CLOCK_FIELDS = {"observed_at", "available_at", "source_id", "source_hash", "currency"}
UNDERLYING_FIELDS = QUOTE_CLOCK_FIELDS | {"instrument_id", "instrument_kind", "price"}
OPTION_FIELDS = QUOTE_CLOCK_FIELDS | {"contract_id", "price_unit", "ask"}
DIVIDEND_FIELDS = QUOTE_CLOCK_FIELDS | {"underlying_id", "status", "dividend_per_share", "ex_dividend_at"}


@dataclass(frozen=True)
class DecodedWheelExercise:
    state: WheelState
    as_of: datetime
    underlying_price: Decimal
    option_ask: Decimal
    dividend_per_share: Decimal | None
    ex_dividend_at: datetime | None


@dataclass(frozen=True)
class WheelExerciseResearch:
    operation: str
    contract_id: str
    decision: ResearchDecision
    state_basis: str = "source-supplied-research-state"
    actual_holdings_verified: bool = False
    assignment_verified: bool = False
    collateral_readiness_verified: bool = False
    execution_authorized: bool = False

    @property
    def status(self) -> str:
        return self.decision.status


def decode_wheel_exercise(policy: Any, parameters: Any) -> DecodedWheelExercise:
    """Decode original reviewed payloads, not arbitrary caller price arguments.

    wheel_state: unchanged complete explicit sleeve wheel-state payload.
    exercise_quotes: {underlying: UNDERLYING_FIELDS, option: OPTION_FIELDS}.
    Both observations independently bind an exact original reviewed source hash,
    currency and point-in-time clock. instrument_kind must be equity and option
    ask price_unit must be currency-per-underlying-unit, never total premium.
    dividend_calendar: DIVIDEND_FIELDS; status must be declared. Ex-date is a
    supplied future effective date, not fabricated from availability or expiry.
    All timestamps use the canonical public Timestamp representation, with
    sub-microsecond times rejected by the native datetime boundary.
    """
    # Function-local reuse prevents circular module initialization when the
    # caller eventually mounts this focused helper. No alternate JSON/codec,
    # review authority, Decimal conversion or time implementation is created.
    from .sleeve_research import (_decimal, _decode_inputs, _digest, _fail, _identifier,
                                 _instant, _integer, _projection, _record)

    job = policy.job
    params = _record(parameters, set(PARAMETER_FIELDS))
    quote_age = _integer(params["maximum_quote_age_seconds"])
    dividend_age = _integer(params["maximum_dividend_age_seconds"])
    if quote_age > 86_400 or dividend_age > 31_536_000:
        _fail("wheel-scenario-freshness-policy-invalid")
    roles = [source.role for source in policy.sources if source.role is not None]
    if (len(roles) != len(set(roles)) or not REQUIRED_ROLES <= set(roles) <= REQUIRED_ROLES | OPTIONAL_ROLES
            or not any(source.role is None for source in policy.sources)):
        _fail("wheel-exercise-original-source-roles-required")
    # Existing decoder requires all balances/quantities explicitly, no events,
    # a nonempty outstanding option, physical delivery and an unexpired term.
    # It does not establish that this scenario describes actual holdings.
    state = _decode_inputs(policy, "wheel-obligations", {})[0]["state"]
    contract = state.option.contract
    if contract.exercise_style != "american":
        _fail("wheel-exercise-american-contract-required")
    quotes = _record(policy.source("exercise_quotes").payload, {"underlying", "option"})
    underlying = _record(quotes["underlying"], UNDERLYING_FIELDS)
    option = _record(quotes["option"], OPTION_FIELDS)
    if (underlying["instrument_kind"] != "equity" or underlying["instrument_id"] != state.underlying_id
            or option["contract_id"] != contract.contract_id
            or option["price_unit"] != "currency-per-underlying-unit"
            or underlying["currency"] != state.currency or option["currency"] != state.currency):
        _fail("wheel-exercise-instrument-or-price-unit-mismatch")
    observed_times = []
    for quote in (underlying, option):
        observed, available = _instant(job, quote["observed_at"]), _instant(job, quote["available_at"])
        observed_ns = int(_projection(observed))
        if not observed <= available <= policy.as_of or policy.as_of_ns - observed_ns > quote_age * 1_000_000_000:
            _fail("wheel-exercise-quote-not-current-at-cutoff")
        policy.provenance(_identifier(job, quote["source_id"]), _digest(quote["source_hash"]),
                          available, role="exercise_quotes")
        observed_times.append(observed)
    policy.observation("exercise_quotes", tuple(observed_times))
    underlying_price, option_ask = _decimal(underlying["price"]), _decimal(option["ask"])
    if underlying_price <= 0 or option_ask < 0:
        _fail("wheel-exercise-nonpositive-price-or-negative-ask")
    dividend_per_share, ex_dividend_at = None, None
    if contract.right == "call" and "dividend_calendar" not in roles:
        _fail("wheel-exercise-declared-dividend-calendar-unavailable")
    if "dividend_calendar" in roles:
        dividend = _record(policy.source("dividend_calendar").payload, DIVIDEND_FIELDS)
        if (dividend["underlying_id"] != state.underlying_id or dividend["currency"] != state.currency
                or dividend["status"] != "declared"):
            _fail("wheel-exercise-dividend-identity-or-status-invalid")
        observed, available = _instant(job, dividend["observed_at"]), _instant(job, dividend["available_at"])
        if (not observed <= available <= policy.as_of
                or policy.as_of_ns - int(_projection(observed)) > dividend_age * 1_000_000_000):
            _fail("wheel-exercise-dividend-not-known-at-cutoff")
        policy.provenance(_identifier(job, dividend["source_id"]), _digest(dividend["source_hash"]),
                          available, role="dividend_calendar")
        policy.observation("dividend_calendar", (observed,))
        dividend_per_share = _decimal(dividend["dividend_per_share"])
        ex_dividend_at = _instant(job, dividend["ex_dividend_at"])
        if dividend_per_share < 0 or ex_dividend_at <= policy.as_of:
            _fail("wheel-exercise-future-declared-dividend-required")
    return DecodedWheelExercise(state, policy.as_of, underlying_price, option_ask,
                                dividend_per_share, ex_dividend_at)


def compute_wheel_exercise(inputs: DecodedWheelExercise) -> WheelExerciseResearch:
    """Pure authored risk-review invocation; not actual assignment prediction."""
    result = early_exercise_review(inputs.state, as_of=inputs.as_of,
        underlying_price=inputs.underlying_price, option_ask=inputs.option_ask,
        dividend_per_share=inputs.dividend_per_share, ex_dividend_at=inputs.ex_dividend_at)
    return WheelExerciseResearch(OPERATION, inputs.state.option.contract.contract_id, result)
