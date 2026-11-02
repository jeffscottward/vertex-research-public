"""Pure paper option lifecycle calculations, with explicit incomplete outcomes.

No account mutation, spendable-cash authority, calendar service, or broker API.
A result describes obligations, not settlement funds available for trading.
Official fixing/calendar metadata and exercise decisions are injected facts.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Literal

from .simulator import (
    ONE,
    ZERO,
    QualifiedInstrument,
    _EXACT,
    _aligned,
    _decimal,
    _digest,
    _ns,
    _text,
)


@dataclass(frozen=True)
class SettlementPolicy:
    policy_id: str
    auto_exercise_threshold: Decimal
    pin_band: Decimal
    early_exercise_window_ns: int
    reference_ttl_ns: int
    financing_cost_per_unit: Decimal
    fee_per_contract: Decimal
    maximum_contracts: Decimal
    short_assignment_model: Literal["explicit-only", "conservative-economic"]
    maximum_positions: int = 64
    maximum_events: int = 256

    def __post_init__(self) -> None:
        _text(self.policy_id, "settlement policy_id")
        for name in ("auto_exercise_threshold", "maximum_contracts"):
            _decimal(getattr(self, name), name, positive=True)
        for name in ("pin_band", "financing_cost_per_unit", "fee_per_contract"):
            _decimal(getattr(self, name), name)
        _ns(self.early_exercise_window_ns, "early_exercise_window_ns")
        _ns(self.reference_ttl_ns, "reference_ttl_ns")
        if self.reference_ttl_ns == 0:
            raise ValueError("positive reference TTL required")
        if self.short_assignment_model not in ("explicit-only", "conservative-economic"):
            raise ValueError("explicit assignment model required")
        if type(self.maximum_positions) is not int or not 1 <= self.maximum_positions <= 256 or type(self.maximum_events) is not int or not 1 <= self.maximum_events <= 1024:
            raise ValueError("settlement bound exceeded")


@dataclass(frozen=True)
class OptionPosition:
    position_id: str
    instrument: QualifiedInstrument
    signed_contracts: Decimal

    def __post_init__(self) -> None:
        _text(self.position_id, "position_id")
        if not isinstance(self.instrument, QualifiedInstrument) or self.instrument.option is None:
            raise ValueError("fully qualified option position required")
        if not isinstance(self.signed_contracts, Decimal) or not self.signed_contracts.is_finite():
            raise ValueError("signed exact Decimal contracts required")
        _decimal(self.signed_contracts.copy_abs(), "contracts", positive=True)
        if not _aligned(self.signed_contracts.copy_abs(), self.instrument.lot_size):
            raise ValueError("contracts off qualified lot")


@dataclass(frozen=True)
class UnderlyingObservation:
    underlying_id: str
    price: Decimal
    observed_at_ns: int
    evidence_id: str
    fixing_session: Literal["AM", "PM", "intraday"]
    official_fixing: bool

    def __post_init__(self) -> None:
        _text(self.underlying_id, "underlying_id")
        _text(self.evidence_id, "evidence_id")
        _decimal(self.price, "underlying price", positive=True)
        _ns(self.observed_at_ns, "underlying observed_at_ns")
        if self.fixing_session not in ("AM", "PM", "intraday") or type(self.official_fixing) is not bool:
            raise ValueError("explicit fixing provenance required")


@dataclass(frozen=True)
class OptionMark:
    instrument_id: str
    price: Decimal
    observed_at_ns: int
    evidence_id: str

    def __post_init__(self) -> None:
        _text(self.instrument_id, "option mark instrument_id")
        _text(self.evidence_id, "option mark evidence_id")
        _decimal(self.price, "option mark")
        _ns(self.observed_at_ns, "option mark observed_at_ns")


@dataclass(frozen=True)
class DividendObservation:
    underlying_id: str
    amount_per_unit: Decimal
    announced_at_ns: int
    ex_at_ns: int
    evidence_id: str

    def __post_init__(self) -> None:
        _text(self.underlying_id, "dividend underlying_id")
        _text(self.evidence_id, "dividend evidence_id")
        _decimal(self.amount_per_unit, "dividend amount", positive=True)
        _ns(self.announced_at_ns, "dividend announced_at_ns")
        _ns(self.ex_at_ns, "dividend ex_at_ns")
        if self.announced_at_ns >= self.ex_at_ns:
            raise ValueError("dividend must be announced before ex-date")


@dataclass(frozen=True)
class ExerciseInstruction:
    decision_id: str
    action: Literal["exercise", "do-not-exercise", "assign", "no-assignment"]
    contracts: Decimal
    effective_at_ns: int

    def __post_init__(self) -> None:
        _text(self.decision_id, "decision_id")
        _decimal(self.contracts, "instruction contracts", positive=True)
        _ns(self.effective_at_ns, "instruction effective_at_ns")
        if self.action not in ("exercise", "do-not-exercise", "assign", "no-assignment"):
            raise ValueError("explicit exercise/assignment action required")


@dataclass(frozen=True)
class SettlementRequest:
    request_id: str
    position: OptionPosition
    now_ns: int
    underlying: UnderlyingObservation | None
    option_mark: OptionMark | None = None
    dividend: DividendObservation | None = None
    instruction: ExerciseInstruction | None = None
    # Early physical exercise may settle before the expiry's settlement date.
    # Its exact calendar-adjusted due time is mandatory rather than guessed T+1.
    early_settlement_due_ns: int | None = None

    def __post_init__(self) -> None:
        _text(self.request_id, "settlement request_id")
        _ns(self.now_ns, "settlement now_ns")
        if not isinstance(self.position, OptionPosition):
            raise ValueError("option position required")
        for name, kind in (("underlying", UnderlyingObservation), ("option_mark", OptionMark), ("dividend", DividendObservation), ("instruction", ExerciseInstruction)):
            value = getattr(self, name)
            if value is not None and not isinstance(value, kind):
                raise ValueError(f"invalid {name}")
        if self.early_settlement_due_ns is not None:
            _ns(self.early_settlement_due_ns, "early_settlement_due_ns")
            if self.early_settlement_due_ns < self.now_ns:
                raise ValueError("early settlement due before evaluation")


@dataclass(frozen=True)
class SettlementEvent:
    event_id: str
    request_id: str
    position_id: str
    instrument_id: str
    policy_id: str
    status: Literal["exercised", "assigned", "expired", "no-action", "unknown"]
    reason: str
    occurred_at_ns: int
    settlement_due_ns: int | None
    contracts: Decimal
    remaining_contracts: Decimal
    cash_delta: Decimal
    underlying_delta: Decimal
    underlying_id: str
    currency: str
    fees: Decimal
    intrinsic_per_unit: Decimal | None
    final: bool
    pin_risk: bool
    early_exercise: bool
    settlement_kind: Literal["cash", "physical"]
    spendable_authority: Literal[False] = False


def _result(request: SettlementRequest, policy: SettlementPolicy, *, status: Literal["exercised", "assigned", "expired", "no-action", "unknown"], reason: str, intrinsic: Decimal | None = None, contracts: Decimal = ZERO, cash: Decimal = ZERO, underlying: Decimal = ZERO, fees: Decimal = ZERO, due: int | None = None, final: bool = False, pin: bool = False, early: bool = False) -> SettlementEvent:
    position = request.position
    terms = position.instrument.option
    assert terms is not None
    if status == "expired" and due is None:
        # Expiry closes contracts, but collateral release still has a qualified
        # calendar maturity. This is evidence, never immediate cash authority.
        due = terms.schedule.settlement_due_ns
    sign = ONE if position.signed_contracts > ZERO else -ONE
    remaining = position.signed_contracts - sign * contracts
    identity = _digest((request, policy, status, reason, intrinsic, contracts, cash, underlying, fees, due, final, pin, early))
    return SettlementEvent(identity, request.request_id, position.position_id, position.instrument.instrument_id, policy.policy_id, status, reason, request.now_ns, due, contracts, remaining, cash, underlying, terms.underlying_id, position.instrument.currency, fees, intrinsic, final, pin, early, terms.settlement_kind)


def settle_option(request: SettlementRequest, policy: SettlementPolicy) -> SettlementEvent:
    """Compute one immutable event; duplicate input yields the identical event.

    Pin risk never becomes an inferred final assignment. An unresolved short
    remains unknown under explicit-only policy, preserving collateral. Long
    early exercise is never automatically triggered by an economic heuristic.
    The conservative short model is labeled a model, not observed assignment.
    """
    if not isinstance(request, SettlementRequest) or not isinstance(policy, SettlementPolicy):
        raise ValueError("typed settlement request and policy required")
    with localcontext(_EXACT):
        position = request.position
        instrument = position.instrument
        terms = instrument.option
        assert terms is not None
        schedule = terms.schedule
        absolute = position.signed_contracts.copy_abs()
        if absolute > policy.maximum_contracts:
            raise ValueError("settlement quantity bound exceeded")
        is_long = position.signed_contracts > ZERO
        early = request.now_ns < schedule.fixing_ns
        observation = request.underlying
        instruction = request.instruction
        if instruction is not None:
            if instruction.contracts > absolute or not _aligned(instruction.contracts, instrument.lot_size):
                raise ValueError("instruction exceeds position/lot")
            if instruction.effective_at_ns > request.now_ns or instruction.effective_at_ns > schedule.exercise_cutoff_ns:
                raise ValueError("late/future exercise decision")
            if (instruction.effective_at_ns < schedule.fixing_ns) != early:
                raise ValueError("instruction belongs to a different lifecycle phase")
            if (is_long and instruction.action not in ("exercise", "do-not-exercise")) or (not is_long and instruction.action not in ("assign", "no-assignment")):
                raise ValueError("exercise/assignment side mismatch")
            if early and terms.exercise_style != "american":
                raise ValueError("European option cannot exercise before fixing")
            if early and terms.settlement_kind == "cash":
                raise ValueError("early cash exercise requires a separately qualified fixing convention")
        if observation is None:
            return _result(request, policy, status="unknown", reason="missing-underlying-evidence", early=early)
        if observation.underlying_id != terms.underlying_id or observation.observed_at_ns > request.now_ns:
            raise ValueError("underlying evidence identity/time mismatch")
        if not early and (not observation.official_fixing or observation.observed_at_ns != schedule.fixing_ns or observation.fixing_session != schedule.fixing_session):
            return _result(request, policy, status="unknown", reason="missing-exact-official-expiry-fixing")
        if early and request.now_ns - observation.observed_at_ns > policy.reference_ttl_ns:
            return _result(request, policy, status="unknown", reason="stale-early-exercise-reference", early=True)
        intrinsic = max(ZERO, observation.price - terms.strike if terms.right == "call" else terms.strike - observation.price)
        pin = not early and terms.settlement_kind == "physical" and (observation.price - terms.strike).copy_abs() <= policy.pin_band
        if not early and request.now_ns < schedule.exercise_cutoff_ns and (instruction is None or instruction.action in ("do-not-exercise", "no-assignment")):
            return _result(request, policy, status="unknown", reason="exercise-window-open", intrinsic=intrinsic, pin=pin)
        if instruction is None and pin:
            return _result(request, policy, status="unknown", reason="pin-risk-explicit-decision-required", intrinsic=intrinsic, pin=True)
        if instruction is not None and instruction.action in ("do-not-exercise", "no-assignment"):
            if early:
                return _result(request, policy, status="no-action", reason="explicit-no-early-action", intrinsic=intrinsic, early=True)
            return _result(request, policy, status="expired", reason="explicit-expiry-nonexercise", intrinsic=intrinsic, contracts=instruction.contracts, final=instruction.contracts == absolute, pin=pin)
        if early:
            if terms.exercise_style == "european":
                return _result(request, policy, status="no-action", reason="european-before-fixing", intrinsic=intrinsic, early=True)
            if instruction is None:
                mark = request.option_mark
                if mark is None or mark.instrument_id != instrument.instrument_id or mark.observed_at_ns > request.now_ns or request.now_ns - mark.observed_at_ns > policy.reference_ttl_ns:
                    return _result(request, policy, status="unknown", reason="missing-fresh-option-time-value", intrinsic=intrinsic, early=True)
                if mark.price < intrinsic:
                    return _result(request, policy, status="unknown", reason="option-mark-below-intrinsic", intrinsic=intrinsic, early=True)
                time_value = mark.price - intrinsic
                economic = False
                economic_reason = "no-early-exercise-trigger"
                if terms.right == "call":
                    dividend = request.dividend
                    if dividend is None:
                        return _result(request, policy, status="unknown", reason="missing-dividend-metadata", intrinsic=intrinsic, early=True)
                    if dividend.underlying_id != terms.underlying_id or dividend.announced_at_ns > request.now_ns:
                        raise ValueError("noncausal dividend evidence")
                    if request.now_ns < dividend.ex_at_ns <= min(schedule.fixing_ns, request.now_ns + policy.early_exercise_window_ns):
                        economic = intrinsic > ZERO and dividend.amount_per_unit > time_value + policy.financing_cost_per_unit
                        economic_reason = "ex-dividend-early-exercise-risk"
                else:
                    economic = intrinsic > ZERO and policy.financing_cost_per_unit > time_value
                    economic_reason = "short-put-early-exercise-risk"
                if not economic:
                    return _result(request, policy, status="no-action", reason="no-economic-early-exercise", intrinsic=intrinsic, early=True)
                if is_long or policy.short_assignment_model == "explicit-only":
                    return _result(request, policy, status="unknown", reason=economic_reason + ":explicit-decision-required", intrinsic=intrinsic, early=True)
                reason = "modeled-conservative-" + economic_reason
            else:
                reason = "explicit-early-exercise" if is_long else "explicit-early-assignment"
            if request.early_settlement_due_ns is None:
                raise ValueError("early exercise requires explicit calendar-adjusted settlement due time")
            if terms.settlement_kind != "physical":
                raise ValueError("early cash settlement convention unsupported")
            due = request.early_settlement_due_ns
        else:
            due = schedule.settlement_due_ns
            if instruction is None:
                if terms.settlement_kind == "cash" and intrinsic == ZERO:
                    return _result(request, policy, status="expired", reason="zero-cash-intrinsic", intrinsic=intrinsic, contracts=absolute, final=True)
                if terms.settlement_kind == "physical" and intrinsic < policy.auto_exercise_threshold:
                    # Long holder can use automatic nonexercise; short physical
                    # exercise remains uncertain without an assignment model.
                    if not is_long and terms.settlement_kind == "physical" and policy.short_assignment_model == "explicit-only":
                        return _result(request, policy, status="unknown", reason="short-nonassignment-unconfirmed", intrinsic=intrinsic)
                    return _result(request, policy, status="expired", reason="below-auto-exercise-threshold", intrinsic=intrinsic, contracts=absolute, final=True)
                if not is_long and terms.settlement_kind == "physical" and policy.short_assignment_model == "explicit-only":
                    return _result(request, policy, status="unknown", reason="short-assignment-unconfirmed", intrinsic=intrinsic)
                reason = "automatic-expiry-exercise" if is_long else "cash-expiry-obligation" if terms.settlement_kind == "cash" else "modeled-conservative-expiry-assignment"
            else:
                reason = "explicit-expiry-exercise" if is_long else "explicit-expiry-assignment"
        contracts = instruction.contracts if instruction is not None else absolute
        direction = ONE if is_long else -ONE
        units = contracts * terms.deliverable_units
        fees = contracts * policy.fee_per_contract
        if terms.settlement_kind == "cash":
            cash = direction * intrinsic * units - fees
            underlying = ZERO
        else:
            # Short call: deliver underlying, receive strike. Short put:
            # purchase underlying, pay strike. Long positions reverse these.
            underlying = direction * units * (ONE if terms.right == "call" else -ONE)
            cash = -underlying * terms.strike - fees
        return _result(request, policy, status="exercised" if is_long else "assigned", reason=reason, intrinsic=intrinsic, contracts=contracts, cash=cash, underlying=underlying, fees=fees, due=due, final=contracts == absolute, pin=pin, early=early)


def settle_batch(requests: tuple[SettlementRequest, ...], policy: SettlementPolicy) -> tuple[SettlementEvent, ...]:
    """Bounded atomic pure batch; no position is silently settled twice."""
    if not isinstance(policy, SettlementPolicy) or not isinstance(requests, tuple) or len(requests) > min(policy.maximum_positions, policy.maximum_events):
        raise ValueError("settlement batch bound exceeded")
    if not all(isinstance(request, SettlementRequest) for request in requests):
        raise ValueError("typed settlement requests required")
    if len({r.request_id for r in requests}) != len(requests) or len({r.position.position_id for r in requests}) != len(requests):
        raise ValueError("duplicate settlement request/position")
    return tuple(settle_option(request, policy) for request in requests)
