"""Bounded paper-only mechanics. No broker, persistence, wall clock, or authority.

All public-contract parsing/hashing belongs to the injected native authority.
These are private, immutable computation records, not public schema replicas.
A caller must durably record dispatch before submit, and retain its reservation
until an authoritative final reconciliation, never merely a cancel request.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, fields, is_dataclass, replace
from datetime import date, timedelta
from decimal import Context, Decimal, Inexact, localcontext
from fractions import Fraction
from hashlib import sha256
import json
from typing import Literal

ZERO = Decimal("0")
ONE = Decimal("1")
_EXACT = Context(prec=128, traps=[Inexact])
_MAX_NS = (1 << 63) - 1
Status = Literal["accepted", "partial-fill", "filled", "cancelled", "rejected", "unknown"]


def _text(value: str, name: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 256 or any(ord(c) < 32 for c in value):
        raise ValueError(f"invalid {name}")


def _ns(value: int, name: str) -> None:
    if type(value) is not int or not 0 <= value <= _MAX_NS:
        raise ValueError(f"invalid {name}: integer epoch nanoseconds required")


def _decimal(value: Decimal, name: str, *, positive: bool = False) -> None:
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"invalid {name}: finite Decimal required")
    if value < ZERO or (positive and value == ZERO):
        raise ValueError(f"invalid {name}: negative/zero")
    _, digits, exponent = value.as_tuple()
    if len(digits) > 28 or not -12 <= exponent <= 16 or value.adjusted() > 27:
        raise ValueError(f"invalid {name}: decimal bound exceeded")


def _fraction(value: Decimal) -> Fraction:
    return Fraction(*value.as_integer_ratio())


def _floor(value: Decimal | Fraction, step: Decimal) -> Decimal:
    units = (value if isinstance(value, Fraction) else _fraction(value)) // _fraction(step)
    with localcontext(_EXACT):
        return step * units


def _aligned(value: Decimal, step: Decimal) -> bool:
    return (_fraction(value) / _fraction(step)).denominator == 1


def _plain(value: object) -> object:
    # Private checkpoint/event identity only; never a public artifact digest.
    if isinstance(value, Decimal):
        return {"decimal": str(value)}
    if is_dataclass(value):
        return {f.name: _plain(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, tuple):
        return [_plain(v) for v in value]
    if value is None or type(value) in (str, int, bool):
        return value
    raise ValueError("unsupported private checkpoint value")


def _digest(value: object) -> str:
    return sha256(json.dumps(_plain(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


@dataclass(frozen=True)
class ExpirySchedule:
    """Explicit authoritative calendar facts; no guessed Friday or UTC close."""

    calendar_id: str
    calendar_version: str
    exchange_timezone: str
    fixing_utc_offset_seconds: int
    nominal_expiry_date: str
    effective_expiry_date: str
    closed_dates: tuple[str, ...]
    holiday_rule: Literal["previous-business-day"]
    fixing_session: Literal["AM", "PM"]
    last_trade_ns: int
    fixing_ns: int
    exercise_cutoff_ns: int
    settlement_due_ns: int

    def __post_init__(self) -> None:
        _text(self.calendar_id, "calendar_id")
        _text(self.calendar_version, "calendar_version")
        _text(self.exchange_timezone, "exchange_timezone")
        if type(self.fixing_utc_offset_seconds) is not int or not -50400 <= self.fixing_utc_offset_seconds <= 50400:
            raise ValueError("explicit bounded fixing UTC offset required")
        if self.holiday_rule != "previous-business-day" or self.fixing_session not in ("AM", "PM"):
            raise ValueError("explicit holiday rule and AM/PM fixing required")
        if not isinstance(self.closed_dates, tuple) or len(self.closed_dates) > 366:
            raise ValueError("bounded calendar closure tuple required")
        nominal, effective = date.fromisoformat(self.nominal_expiry_date), date.fromisoformat(self.effective_expiry_date)
        closed = {date.fromisoformat(d) for d in self.closed_dates}
        if len(closed) != len(self.closed_dates):
            raise ValueError("duplicate calendar closure")
        rolled = nominal
        for _ in range(370):
            if rolled.weekday() < 5 and rolled not in closed:
                break
            rolled -= timedelta(days=1)
        else:
            raise ValueError("unbounded holiday roll")
        if rolled != effective:
            raise ValueError("expiry date contradicts supplied holiday calendar")
        for name in ("last_trade_ns", "fixing_ns", "exercise_cutoff_ns", "settlement_due_ns"):
            _ns(getattr(self, name), name)
        if not self.last_trade_ns <= self.fixing_ns <= self.exercise_cutoff_ns <= self.settlement_due_ns:
            raise ValueError("invalid expiry timeline")
        local_seconds = self.fixing_ns // 1_000_000_000 + self.fixing_utc_offset_seconds
        local_date = date(1970, 1, 1) + timedelta(days=local_seconds // 86400)
        local_hour = (local_seconds % 86400) // 3600
        if local_date != effective or (self.fixing_session == "AM") != (local_hour < 12):
            raise ValueError("fixing contradicts exchange-local expiry date or AM/PM")


@dataclass(frozen=True)
class OptionTerms:
    underlying_id: str
    right: Literal["call", "put"]
    strike: Decimal
    exercise_style: Literal["american", "european"]
    settlement_kind: Literal["physical", "cash"]
    deliverable_units: Decimal
    schedule: ExpirySchedule

    def __post_init__(self) -> None:
        _text(self.underlying_id, "underlying_id")
        _decimal(self.strike, "strike", positive=True)
        _decimal(self.deliverable_units, "deliverable_units", positive=True)
        if self.right not in ("call", "put") or self.exercise_style not in ("american", "european"):
            raise ValueError("incomplete option qualification")
        if self.settlement_kind not in ("physical", "cash") or not isinstance(self.schedule, ExpirySchedule):
            raise ValueError("complete settlement metadata required")


@dataclass(frozen=True)
class QualifiedInstrument:
    instrument_id: str
    symbol: str
    session_id: str
    currency: str
    kind: Literal["equity", "option"]
    tick_size: Decimal
    lot_size: Decimal
    multiplier: Decimal
    qualification_id: str
    option: OptionTerms | None = None

    def __post_init__(self) -> None:
        for name in ("instrument_id", "symbol", "session_id", "currency", "qualification_id"):
            _text(getattr(self, name), name)
        for name in ("tick_size", "lot_size", "multiplier"):
            _decimal(getattr(self, name), name, positive=True)
        if self.kind not in ("equity", "option") or (self.kind == "option") != isinstance(self.option, OptionTerms):
            raise ValueError("instrument kind and settlement metadata disagree")
        if self.kind == "equity" and self.option is not None:
            raise ValueError("equity cannot carry option terms")
        if self.option is not None and self.option.deliverable_units != self.multiplier:
            raise ValueError("adjusted option requires matching premium and deliverable multiplier")


@dataclass(frozen=True)
class QualifiedLeg:
    leg_id: str
    instrument: QualifiedInstrument
    side: Literal["buy", "sell"]
    ratio: Decimal
    limit_price: Decimal
    model_id: str

    def __post_init__(self) -> None:
        _text(self.leg_id, "leg_id")
        _text(self.model_id, "model_id")
        if not isinstance(self.instrument, QualifiedInstrument) or self.side not in ("buy", "sell"):
            raise ValueError("qualified leg required")
        _decimal(self.ratio, "ratio", positive=True)
        _decimal(self.limit_price, "limit_price", positive=True)
        if not _aligned(self.limit_price, self.instrument.tick_size):
            raise ValueError("limit price off tick")


@dataclass(frozen=True)
class SessionModel:
    """An immutable calibrated model for one exact instrument/symbol/session."""

    model_id: str
    instrument_id: str
    symbol: str
    session_id: str
    session_open_ns: int
    session_close_ns: int
    submit_latency_ns: int
    cancel_latency_ns: int
    quote_ttl_ns: int
    participation_rate: Decimal
    depth_fraction: Decimal
    maximum_fill_quantity: Decimal
    fee_per_unit: Decimal
    fee_rate: Decimal
    minimum_fee: Decimal
    slippage_bps: Decimal
    slippage_ticks: int
    acceptance: Literal["accepted", "rejected", "unknown"] = "accepted"

    def __post_init__(self) -> None:
        for name in ("model_id", "instrument_id", "symbol", "session_id"):
            _text(getattr(self, name), name)
        for name in ("session_open_ns", "session_close_ns", "submit_latency_ns", "cancel_latency_ns", "quote_ttl_ns"):
            _ns(getattr(self, name), name)
        if self.session_close_ns <= self.session_open_ns or self.quote_ttl_ns == 0:
            raise ValueError("nonempty exact session and quote TTL required")
        for name in ("participation_rate", "depth_fraction", "maximum_fill_quantity"):
            _decimal(getattr(self, name), name, positive=True)
        if self.participation_rate > ONE or self.depth_fraction > ONE:
            raise ValueError("liquidity fraction exceeds one")
        for name in ("fee_per_unit", "fee_rate", "minimum_fee", "slippage_bps"):
            _decimal(getattr(self, name), name)
        if self.fee_rate > ONE or self.slippage_bps > Decimal("10000"):
            raise ValueError("fee/slippage bound exceeded")
        if type(self.slippage_ticks) is not int or not 0 <= self.slippage_ticks <= 10000:
            raise ValueError("invalid tick slippage")
        if self.acceptance not in ("accepted", "rejected", "unknown"):
            raise ValueError("invalid acceptance model")


@dataclass(frozen=True)
class AdmittedLimits:
    maximum_quantity: Decimal
    maximum_gross_notional: Decimal
    maximum_total_fees: Decimal
    maximum_legging_quantity: Decimal
    maximum_legging_ns: int
    valid_until_ns: int

    def __post_init__(self) -> None:
        for name in ("maximum_quantity", "maximum_gross_notional"):
            _decimal(getattr(self, name), name, positive=True)
        for name in ("maximum_total_fees", "maximum_legging_quantity"):
            _decimal(getattr(self, name), name)
        _ns(self.maximum_legging_ns, "maximum_legging_ns")
        _ns(self.valid_until_ns, "valid_until_ns")


@dataclass(frozen=True)
class SubmitCommand:
    submission_key: str
    payload_hash: str
    legs: tuple[QualifiedLeg, ...]
    maximum_quantity: Decimal
    admitted_limits: AdmittedLimits
    strategy_artifact_id: str
    policy_id: str
    submitted_at_ns: int
    expires_at_ns: int

    def __post_init__(self) -> None:
        for name in ("submission_key", "strategy_artifact_id", "policy_id"):
            _text(getattr(self, name), name)
        if not isinstance(self.payload_hash, str) or len(self.payload_hash) != 64 or any(c not in "0123456789abcdef" for c in self.payload_hash):
            raise ValueError("native-validated payload SHA-256 required")
        if not isinstance(self.legs, tuple) or not 1 <= len(self.legs) <= 16 or not all(isinstance(x, QualifiedLeg) for x in self.legs):
            raise ValueError("bounded qualified legs required")
        if len({x.leg_id for x in self.legs}) != len(self.legs) or len({x.instrument.instrument_id for x in self.legs}) != len(self.legs):
            raise ValueError("duplicate leg/instrument; normalize before admission")
        if len({x.instrument.currency for x in self.legs}) != 1:
            raise ValueError("cross-currency orders require separate admitted conversion")
        if not isinstance(self.admitted_limits, AdmittedLimits):
            raise ValueError("admitted limits required")
        _decimal(self.maximum_quantity, "maximum_quantity", positive=True)
        _ns(self.submitted_at_ns, "submitted_at_ns")
        _ns(self.expires_at_ns, "expires_at_ns")
        if self.expires_at_ns <= self.submitted_at_ns:
            raise ValueError("expired command")
        with localcontext(_EXACT):
            for leg in self.legs:
                if not _aligned(self.maximum_quantity * leg.ratio, leg.instrument.lot_size):
                    raise ValueError("maximum leg quantity off lot")


@dataclass(frozen=True)
class CancelAuthorization:
    submission_key: str
    payload_hash: str
    policy_id: str
    valid_until_ns: int
    allowed: bool


@dataclass(frozen=True)
class BookLevel:
    price: Decimal
    quantity: Decimal

    def __post_init__(self) -> None:
        _decimal(self.price, "book price", positive=True)
        _decimal(self.quantity, "book quantity", positive=True)


@dataclass(frozen=True)
class DepthSnapshot:
    instrument_id: str
    symbol: str
    session_id: str
    observed_at_ns: int
    sequence: int
    bids: tuple[BookLevel, ...]
    asks: tuple[BookLevel, ...]
    traded_quantity: Decimal

    def __post_init__(self) -> None:
        for name in ("instrument_id", "symbol", "session_id"):
            _text(getattr(self, name), name)
        _ns(self.observed_at_ns, "observed_at_ns")
        if type(self.sequence) is not int or not 1 <= self.sequence <= _MAX_NS:
            raise ValueError("positive bounded market sequence required")
        _decimal(self.traded_quantity, "traded_quantity")
        for side, reverse in ((self.bids, True), (self.asks, False)):
            if not isinstance(side, tuple) or len(side) > 128 or not all(isinstance(level, BookLevel) for level in side):
                raise ValueError("bounded depth tuple required")
            prices = tuple(level.price for level in side)
            if prices != tuple(sorted(prices, reverse=reverse)) or len(set(prices)) != len(prices):
                raise ValueError("depth must be strictly price ordered")
        if self.bids and self.asks and self.bids[0].price >= self.asks[0].price:
            raise ValueError("locked/crossed book is not executable evidence")


@dataclass(frozen=True)
class AcceptanceResolution:
    submission_key: str
    payload_hash: str
    observed_at_ns: int
    outcome: Literal["accepted", "rejected"]
    evidence_id: str

    def __post_init__(self) -> None:
        _text(self.submission_key, "submission_key")
        _text(self.evidence_id, "evidence_id")
        _ns(self.observed_at_ns, "observed_at_ns")
        if self.outcome not in ("accepted", "rejected"):
            raise ValueError("definitive acceptance outcome required")


@dataclass(frozen=True)
class LegFillTotal:
    leg_id: str
    quantity: Decimal
    gross_notional: Decimal
    fees: Decimal


@dataclass(frozen=True)
class SimulationEvent:
    event_id: str
    fill_id: str | None
    submission_key: str
    payload_hash: str
    sequence: int
    occurred_at_ns: int
    status: Status
    reason: str
    leg_id: str | None
    quantity: Decimal
    price: Decimal | None
    fee: Decimal
    cumulative_fills: tuple[LegFillTotal, ...]
    final: bool
    legging_risk: bool
    settlement: OptionTerms | None


@dataclass(frozen=True)
class Reconciliation:
    submission_key: str
    payload_hash: str | None
    status: Status
    final: bool
    authoritative: bool
    cumulative_fills: tuple[LegFillTotal, ...]
    events: tuple[SimulationEvent, ...]
    provenance_id: str
    state_hash: str
    reason: str


@dataclass(frozen=True)
class SimulationBounds:
    max_legs: int = 8
    max_book_levels: int = 32
    max_market_events: int = 256
    max_orders: int = 256
    max_books: int = 256
    max_models: int = 256
    max_events: int = 65536
    max_order_events: int = 4096

    def __post_init__(self) -> None:
        ceilings = (16, 128, 4096, 4096, 4096, 4096, 1048576, 65536)
        for field, ceiling in zip(fields(self), ceilings):
            value = getattr(self, field.name)
            if type(value) is not int or not 1 <= value <= ceiling:
                raise ValueError(f"invalid {field.name}")


@dataclass(frozen=True)
class OrderCheckpoint:
    command: SubmitCommand
    status: Status
    final: bool
    ready_at_ns: int
    cancel_at_ns: int | None
    legging_since_ns: int | None
    totals: tuple[LegFillTotal, ...]
    events: tuple[SimulationEvent, ...]
    resolution: AcceptanceResolution | None


@dataclass(frozen=True)
class BookCheckpoint:
    snapshot: DepthSnapshot
    bids_remaining: tuple[Decimal, ...]
    asks_remaining: tuple[Decimal, ...]
    volume_remaining: Decimal


@dataclass(frozen=True)
class SimulatorCheckpoint:
    revision: int
    provenance_id: str
    configuration_hash: str
    now_ns: int
    orders: tuple[OrderCheckpoint, ...]
    books: tuple[BookCheckpoint, ...]
    state_hash: str


class PaperSimulator:
    """Single-owner deterministic in-memory state machine, never a live port.

    Event batches are atomic on invalid data/resource exhaustion. Books are
    shared across orders and consumed once. Advance consumes a chronological
    causal feed; snapshots contain incremental, not cumulative, traded volume.
    At equal timestamps effective cancel/expiry precedes a newly arriving quote.
    Unknown acceptance requires explicit injected resolution, not blind retry.
    """

    def __init__(self, models: tuple[SessionModel, ...], *, provenance_id: str, bounds: SimulationBounds = SimulationBounds()) -> None:
        _text(provenance_id, "provenance_id")
        if not isinstance(bounds, SimulationBounds) or not isinstance(models, tuple) or not 1 <= len(models) <= bounds.max_models:
            raise ValueError("bounded immutable models required")
        if not all(isinstance(model, SessionModel) for model in models):
            raise ValueError("session models required")
        if len({model.model_id for model in models}) != len(models) or len({(m.instrument_id, m.symbol, m.session_id) for m in models}) != len(models):
            raise ValueError("ambiguous immutable model configuration")
        self._models = {model.model_id: model for model in models}
        self._market_models = {(m.instrument_id, m.symbol, m.session_id): m for m in models}
        self._bounds = bounds
        self._provenance = provenance_id
        self._configuration_hash = _digest((tuple(sorted(models, key=lambda m: m.model_id)), bounds))
        self._now = 0
        self._orders: dict[str, OrderCheckpoint] = {}
        self._books: dict[tuple[str, str, str], BookCheckpoint] = {}
        self._event_count = 0

    def _clock(self, now_ns: int) -> None:
        _ns(now_ns, "now_ns")
        if now_ns < self._now:
            raise ValueError("clock regression")

    def _emit(self, key: str, at: int, status: Status, reason: str, *, leg: QualifiedLeg | None = None, quantity: Decimal = ZERO, price: Decimal | None = None, fee: Decimal = ZERO) -> SimulationEvent:
        order = self._orders[key]
        if self._event_count >= self._bounds.max_events or len(order.events) >= self._bounds.max_order_events:
            raise ValueError("event bound exceeded; persist/reconcile before continuing")
        sequence = len(order.events) + 1
        identity = _digest((self._provenance, key, order.command.payload_hash, sequence, at, status, reason, None if leg is None else leg.leg_id, quantity, price, fee, order.totals))
        event = SimulationEvent(identity, "fill-" + identity if quantity > ZERO else None, key, order.command.payload_hash, sequence, at, status, reason, None if leg is None else leg.leg_id, quantity, price, fee, order.totals, order.final, self._legging(order), None if leg is None else leg.instrument.option)
        self._orders[key] = replace(order, events=order.events + (event,))
        self._event_count += 1
        return event

    def _command_reason(self, command: SubmitCommand) -> str | None:
        limits = command.admitted_limits
        if len(command.legs) > self._bounds.max_legs:
            return "leg-bound"
        if command.maximum_quantity > limits.maximum_quantity or command.expires_at_ns > limits.valid_until_ns:
            return "admission-bound"
        if command.submitted_at_ns >= limits.valid_until_ns:
            return "admission-expired"
        for leg in command.legs:
            instrument = leg.instrument
            model = self._models.get(leg.model_id)
            if model is None or (model.instrument_id, model.symbol, model.session_id) != (instrument.instrument_id, instrument.symbol, instrument.session_id):
                return "missing-exact-symbol-session-model"
            if not model.session_open_ns <= command.submitted_at_ns < model.session_close_ns:
                return "outside-model-session"
            if command.submitted_at_ns + model.submit_latency_ns >= min(command.expires_at_ns, model.session_close_ns):
                return "latency-exceeds-session"
            if instrument.option is not None and command.submitted_at_ns >= instrument.option.schedule.last_trade_ns:
                return "option-trading-ended"
        return None

    def submit(self, command: SubmitCommand) -> tuple[SimulationEvent, ...]:
        if not isinstance(command, SubmitCommand):
            raise ValueError("SubmitCommand required")
        existing = self._orders.get(command.submission_key)
        if existing is not None:
            if existing.command != command:
                raise ValueError("submission key conflicts with immutable command")
            return existing.events
        self._clock(command.submitted_at_ns)
        if len(self._orders) >= self._bounds.max_orders or self._event_count >= self._bounds.max_events:
            raise ValueError("simulator capacity exceeded")
        reason = self._command_reason(command)
        models = tuple(self._models[leg.model_id] for leg in command.legs) if reason is None else ()
        rejected = reason is not None or any(m.acceptance == "rejected" for m in models)
        unknown = not rejected and any(m.acceptance == "unknown" for m in models)
        status: Status = "rejected" if rejected else "unknown" if unknown else "accepted"
        ready = command.submitted_at_ns + max((m.submit_latency_ns for m in models), default=0)
        totals = tuple(LegFillTotal(leg.leg_id, ZERO, ZERO, ZERO) for leg in command.legs)
        self._orders[command.submission_key] = OrderCheckpoint(command, status, rejected, ready, None, None, totals, (), None)
        self._now = command.submitted_at_ns
        return (self._emit(command.submission_key, self._now, status, reason or ("acceptance-unobserved" if unknown else "model-rejected" if rejected else "paper-accepted")),)

    def cancel(self, submission_key: str, authorization: CancelAuthorization, now_ns: int) -> tuple[SimulationEvent, ...]:
        self._clock(now_ns)
        order = self._orders.get(submission_key)
        if order is None:
            raise ValueError("unknown submission key; reconcile without resubmitting")
        if not isinstance(authorization, CancelAuthorization) or authorization.allowed is not True or (authorization.submission_key, authorization.payload_hash, authorization.policy_id) != (submission_key, order.command.payload_hash, order.command.policy_id):
            raise ValueError("cancel authorization mismatch")
        _ns(authorization.valid_until_ns, "cancel valid_until_ns")
        if now_ns >= authorization.valid_until_ns:
            raise ValueError("cancel authorization expired")
        if order.final or order.cancel_at_ns is not None:
            return order.events
        if self._event_count >= self._bounds.max_events or len(order.events) >= self._bounds.max_order_events:
            raise ValueError("event bound exceeded")
        latency = max(self._models[leg.model_id].cancel_latency_ns for leg in order.command.legs)
        effective = now_ns + latency
        _ns(effective, "cancel effective time")
        self._orders[submission_key] = replace(order, cancel_at_ns=effective)
        self._now = now_ns
        # An acknowledgement is NOT final, including zero latency; advance owns
        # causal cutoff processing and includes all racing cumulative fills.
        return (self._emit(submission_key, now_ns, order.status, "cancel-pending"),)

    @staticmethod
    def _legging(order: OrderCheckpoint) -> bool:
        units = tuple(_fraction(total.quantity) / _fraction(leg.ratio) for total, leg in zip(order.totals, order.command.legs))
        return bool(units) and max(units) != min(units)

    def _finish_due(self, at: int) -> None:
        for key in tuple(self._orders):
            order = self._orders[key]
            if order.final or order.status == "unknown":
                continue
            deadlines = [(order.command.expires_at_ns, "order-expired"), (order.command.admitted_limits.valid_until_ns, "admission-expired")]
            for leg in order.command.legs:
                deadlines.append((self._models[leg.model_id].session_close_ns, "session-ended"))
                if leg.instrument.option is not None:
                    deadlines.append((leg.instrument.option.schedule.last_trade_ns, "option-trading-ended"))
            if order.cancel_at_ns is not None:
                deadlines.append((order.cancel_at_ns, "cancel-effective"))
            if order.legging_since_ns is not None:
                deadlines.append((order.legging_since_ns + order.command.admitted_limits.maximum_legging_ns, "legging-timeout"))
            deadline, reason = min(deadlines)
            if deadline <= at:
                self._orders[key] = replace(order, status="cancelled", final=True)
                self._emit(key, max(deadline, order.events[-1].occurred_at_ns), "cancelled", reason)

    def _load_book(self, event: DepthSnapshot) -> None:
        key = (event.instrument_id, event.symbol, event.session_id)
        model = self._market_models.get(key)
        if model is None:
            raise ValueError("market snapshot has no exact calibrated model")
        if max(len(event.bids), len(event.asks)) > self._bounds.max_book_levels:
            raise ValueError("book depth bound exceeded")
        if not model.session_open_ns <= event.observed_at_ns < model.session_close_ns:
            raise ValueError("market snapshot outside exact session")
        previous = self._books.get(key)
        if previous is not None and event.sequence <= previous.snapshot.sequence:
            if event == previous.snapshot:
                return
            raise ValueError("market sequence replay/conflict")
        if previous is None and len(self._books) >= self._bounds.max_books:
            raise ValueError("book count bound exceeded")
        self._books[key] = BookCheckpoint(event, tuple(level.quantity * model.depth_fraction for level in event.bids), tuple(level.quantity * model.depth_fraction for level in event.asks), min(event.traded_quantity * model.participation_rate, model.maximum_fill_quantity))

    def _resolve(self, event: AcceptanceResolution) -> None:
        order = self._orders.get(event.submission_key)
        if order is None or order.command.payload_hash != event.payload_hash:
            raise ValueError("resolution does not match dispatched payload")
        if order.resolution is not None:
            if order.resolution != event:
                raise ValueError("conflicting acceptance resolution")
            return
        if order.status != "unknown" or order.final:
            raise ValueError("resolution requires unknown acceptance")
        self._orders[event.submission_key] = replace(order, status=event.outcome, final=event.outcome == "rejected", resolution=event)
        self._emit(event.submission_key, event.observed_at_ns, event.outcome, "acceptance-resolved:" + event.evidence_id)

    def _fill(self, key: str, leg_index: int, at: int) -> None:
        order = self._orders[key]
        if order.final or order.status == "unknown" or at < order.ready_at_ns:
            return
        leg = order.command.legs[leg_index]
        instrument = leg.instrument
        model = self._models[leg.model_id]
        book_key = (instrument.instrument_id, instrument.symbol, instrument.session_id)
        book = self._books.get(book_key)
        if book is None or not 0 <= at - book.snapshot.observed_at_ns <= model.quote_ttl_ns:
            return
        levels = book.snapshot.asks if leg.side == "buy" else book.snapshot.bids
        for index, level in enumerate(levels):
            order = self._orders[key]
            if order.final:
                break
            book = self._books[book_key]
            remaining_depth = list(book.asks_remaining if leg.side == "buy" else book.bids_remaining)
            if not _aligned(level.price, instrument.tick_size):
                raise ValueError("qualified book price off tick")
            adverse = level.price * model.slippage_bps * Decimal("0.0001") + instrument.tick_size * model.slippage_ticks
            raw_price = level.price + adverse if leg.side == "buy" else level.price - adverse
            price = _floor(raw_price, instrument.tick_size)
            if leg.side == "buy" and price < raw_price:
                price += instrument.tick_size
            if price <= ZERO or (leg.side == "buy" and price > leg.limit_price) or (leg.side == "sell" and price < leg.limit_price):
                break
            total = order.totals[leg_index]
            needed = order.command.maximum_quantity * leg.ratio - total.quantity
            quantity = _floor(min(needed, remaining_depth[index], book.volume_remaining), instrument.lot_size)
            if len(order.command.legs) > 1:
                units = tuple(_fraction(t.quantity) / _fraction(l.ratio) for t, l in zip(order.totals, order.command.legs))
                allowed_units = min(units) + _fraction(order.command.admitted_limits.maximum_legging_quantity)
                leg_room = allowed_units * _fraction(leg.ratio) - _fraction(total.quantity)
                quantity = min(quantity, _floor(max(Fraction(0), leg_room), instrument.lot_size))
            if quantity <= ZERO:
                continue
            gross_used = sum((t.gross_notional for t in order.totals), ZERO)
            fee_used = sum((t.fees for t in order.totals), ZERO)
            unit_notional = price * instrument.multiplier
            limits = order.command.admitted_limits
            quantity = min(quantity, _floor(_fraction(max(ZERO, limits.maximum_gross_notional - gross_used)) / _fraction(unit_notional), instrument.lot_size))
            fee_per_quantity = model.fee_per_unit + unit_notional * model.fee_rate
            fee_room = limits.maximum_total_fees - fee_used
            if fee_room < model.minimum_fee:
                continue
            if fee_per_quantity > ZERO:
                quantity = min(quantity, _floor(_fraction(max(ZERO, fee_room)) / _fraction(fee_per_quantity), instrument.lot_size))
            if quantity <= ZERO:
                continue
            notional = quantity * unit_notional
            fee = max(model.minimum_fee, quantity * fee_per_quantity)
            totals = list(order.totals)
            totals[leg_index] = LegFillTotal(leg.leg_id, total.quantity + quantity, total.gross_notional + notional, total.fees + fee)
            complete = all(t.quantity == order.command.maximum_quantity * l.ratio for t, l in zip(totals, order.command.legs))
            status: Status = "filled" if complete else "partial-fill"
            updated = replace(order, status=status, final=complete, totals=tuple(totals))
            updated = replace(updated, legging_since_ns=(order.legging_since_ns if order.legging_since_ns is not None else at) if self._legging(updated) else None)
            self._orders[key] = updated
            remaining_depth[index] -= quantity
            self._books[book_key] = replace(book, asks_remaining=tuple(remaining_depth) if leg.side == "buy" else book.asks_remaining, bids_remaining=tuple(remaining_depth) if leg.side == "sell" else book.bids_remaining, volume_remaining=book.volume_remaining - quantity)
            self._emit(key, at, status, "depth-participation-fill", leg=leg, quantity=quantity, price=price, fee=fee)

    def _process(self, at: int) -> None:
        self._finish_due(at)
        for key in tuple(self._orders):
            for index in range(len(self._orders[key].command.legs)):
                self._fill(key, index, at)
        self._finish_due(at)

    def advance(self, market_events: tuple[DepthSnapshot | AcceptanceResolution, ...], now_ns: int) -> tuple[SimulationEvent, ...]:
        self._clock(now_ns)
        if not isinstance(market_events, tuple) or len(market_events) > self._bounds.max_market_events:
            raise ValueError("bounded market event tuple required")
        staged = deepcopy(self)
        previous_counts = {key: len(order.events) for key, order in self._orders.items()}
        with localcontext(_EXACT):
            cursor = self._now
            processed_at: int | None = None
            for event in market_events:
                if not isinstance(event, (DepthSnapshot, AcceptanceResolution)):
                    raise ValueError("unsupported market event")
                if event.observed_at_ns > now_ns:
                    raise ValueError("future market evidence")
                if isinstance(event, DepthSnapshot):
                    old = staged._books.get((event.instrument_id, event.symbol, event.session_id))
                    if old is not None and old.snapshot == event:
                        continue
                elif event.submission_key in staged._orders and staged._orders[event.submission_key].resolution == event:
                    continue
                if event.observed_at_ns < cursor:
                    raise ValueError("noncausal market event order")
                staged._finish_due(event.observed_at_ns)
                if isinstance(event, DepthSnapshot):
                    staged._load_book(event)
                else:
                    staged._resolve(event)
                staged._process(event.observed_at_ns)
                processed_at = event.observed_at_ns
                cursor = event.observed_at_ns
            if processed_at != now_ns and now_ns > self._now:
                staged._process(now_ns)
            else:
                # Empty/replayed input at the same clock is not fresh liquidity
                # or another opportunity to ratchet a multi-leg imbalance cap.
                staged._finish_due(now_ns)
            staged._now = now_ns
        result = tuple(event for key, order in staged._orders.items() for event in order.events[previous_counts[key]:])
        self._orders, self._books, self._now, self._event_count = staged._orders, staged._books, staged._now, staged._event_count
        return tuple(sorted(result, key=lambda e: (e.occurred_at_ns, e.submission_key, e.sequence)))

    def snapshot(self) -> SimulatorCheckpoint:
        checkpoint = SimulatorCheckpoint(1, self._provenance, self._configuration_hash, self._now, tuple(self._orders.values()), tuple(self._books[key] for key in sorted(self._books)), "")
        return replace(checkpoint, state_hash=_digest(checkpoint))

    @classmethod
    def restore(cls, checkpoint: SimulatorCheckpoint, models: tuple[SessionModel, ...], *, expected_provenance_id: str, bounds: SimulationBounds = SimulationBounds()) -> PaperSimulator:
        simulator = cls(models, provenance_id=expected_provenance_id, bounds=bounds)
        if not isinstance(checkpoint, SimulatorCheckpoint) or checkpoint.revision != 1 or checkpoint.provenance_id != expected_provenance_id or checkpoint.configuration_hash != simulator._configuration_hash:
            raise ValueError("checkpoint provenance/configuration mismatch")
        if checkpoint.state_hash != _digest(replace(checkpoint, state_hash="")):
            raise ValueError("checkpoint integrity mismatch")
        _ns(checkpoint.now_ns, "checkpoint clock")
        if not isinstance(checkpoint.orders, tuple) or len(checkpoint.orders) > bounds.max_orders or not isinstance(checkpoint.books, tuple) or len(checkpoint.books) > bounds.max_books:
            raise ValueError("checkpoint capacity exceeded")
        for order in checkpoint.orders:
            if not isinstance(order, OrderCheckpoint) or not isinstance(order.command, SubmitCommand):
                raise ValueError("invalid checkpoint order")
            key = order.command.submission_key
            if key in simulator._orders or not order.events or len(order.events) > bounds.max_order_events:
                raise ValueError("duplicate/unbounded checkpoint order")
            if len(order.totals) != len(order.command.legs) or order.events[-1].cumulative_fills != order.totals or order.events[-1].status != order.status or order.events[-1].final != order.final:
                raise ValueError("checkpoint finality/fill mismatch")
            for index, event in enumerate(order.events, 1):
                if event.sequence != index or event.submission_key != key or event.payload_hash != order.command.payload_hash or event.occurred_at_ns > checkpoint.now_ns:
                    raise ValueError("checkpoint event provenance mismatch")
            simulator._orders[key] = order
            simulator._event_count += len(order.events)
        if simulator._event_count > bounds.max_events:
            raise ValueError("checkpoint event capacity exceeded")
        with localcontext(_EXACT):
            for book in checkpoint.books:
                simulator._load_book(book.snapshot)
                key = (book.snapshot.instrument_id, book.snapshot.symbol, book.snapshot.session_id)
                capacity = simulator._books[key]
                if book.snapshot.observed_at_ns > checkpoint.now_ns or len(book.bids_remaining) != len(capacity.bids_remaining) or len(book.asks_remaining) != len(capacity.asks_remaining):
                    raise ValueError("checkpoint book shape/clock mismatch")
                for remaining, original in zip(book.bids_remaining + book.asks_remaining + (book.volume_remaining,), capacity.bids_remaining + capacity.asks_remaining + (capacity.volume_remaining,)):
                    if not isinstance(remaining, Decimal) or not remaining.is_finite() or not ZERO <= remaining <= original:
                        raise ValueError("checkpoint liquidity exceeds supplied evidence")
                simulator._books[key] = book
        if len(simulator._books) != len(checkpoint.books):
            raise ValueError("duplicate checkpoint book")
        simulator._now = checkpoint.now_ns
        # The digest is integrity, not authority: journal must authenticate its
        # own checkpoint envelope, expected stream/epoch and durable dispatch.
        return simulator

    def reconcile(self, submission_key: str) -> Reconciliation:
        _text(submission_key, "submission_key")
        order = self._orders.get(submission_key)
        checkpoint_hash = self.snapshot().state_hash
        if order is None:
            return Reconciliation(submission_key, None, "unknown", False, False, (), (), self._provenance, checkpoint_hash, "not-in-this-state; retain-reservation")
        return Reconciliation(submission_key, order.command.payload_hash, order.status, order.final, order.status != "unknown", order.totals, order.events, self._provenance, checkpoint_hash, order.events[-1].reason)
