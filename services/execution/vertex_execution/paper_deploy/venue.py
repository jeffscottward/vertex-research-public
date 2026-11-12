"""Simulated paper venue (F3): a thin adapter over ``PaperSimulator``. Never a broker.

``SimulatedPaperVenue.fill(order, quote, now_ns)`` returns a ``PaperFill`` or a
``VenueRefusal``. It takes a frozen fee and slippage model, a calendar and a
text label for its records, nothing else: there is no parameter, attribute or
method that accepts a broker client, and the class has fixed slots.

Fill rule: the bought leg fills at its ask and the sold leg at its bid, each
moved against the order by the model's slippage and rounded against the order
to the tick, for the whole quantity, and only when the resulting net price is
within the order's net limit. Otherwise nothing fills. Fees come from the model.

How one combo order maps onto ``PaperSimulator`` (which has no net-price combo:
it fills leg by leg, each leg with its own limit, inside legging bounds):

1. A new simulator for each order, with one session model for each leg and the
   session of the calendar (09:30 to the close, New York time).
2. The quote goes in as one depth snapshot for each leg with one level a side.
   The displayed size is used as depth and as tradable volume (there is no tape).
3. The order goes in as one two-leg command that lives for one fill attempt.
   Each leg gets a wide limit (sell: one tick; buy: above twice the ask), so the
   simulator alone decides the leg prices from quote, slippage and tick.
4. This adapter then enforces what the simulator cannot express: both legs
   filled whole, and the net of the two leg prices within the net limit. If not,
   the simulator and everything it filled are thrown away and the result is a
   refusal (``limit_not_reached``, ``not_filled``). A combo never ends half filled.

The simulator needs a later clock value to fill than to accept, so the fill is
stamped at ``now_ns`` plus the model's latency, at least one nanosecond.

Refusal codes: ``session_closed``, ``option_expired``, ``quote_from_future``,
``quote_stale``, ``quote_off_tick``, ``no_market``, ``insufficient_size``,
``limit_not_reached``, ``not_filled``, ``simulator_rejected``,
``simulator_error``.

What this venue does NOT prove:

- queue position, or that a resting order would be reached at all: the fill is
  immediate, against the quote that the caller gives;
- real spreads and sizes: bid, ask and size are inputs, not market data;
- combo-book matching: a real combo can fill between the leg quotes, or not at
  the leg quotes; here the net is always the sum of the two leg prices;
- partial fills, and liquidity shared between orders: each order sees the full
  quoted size and fills whole or not at all;
- assignment, exercise and pin risk;
- IBKR margin, buying power, order checks and order ids;
- the 15 extra minutes that some index and ETF options trade after the close;
- exchange facts of the option: the expiry schedule is built from the rule
  calendar and each leg is described as American and physically settled. These
  fields do not change a fill.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Context, Decimal, localcontext
from hashlib import sha256
import json
from typing import Literal

from ..simulator import (
    AdmittedLimits,
    BookLevel,
    DepthSnapshot,
    ExpirySchedule,
    OptionTerms,
    PaperSimulator,
    QualifiedInstrument,
    QualifiedLeg,
    SessionModel,
    SubmitCommand,
)
from .calendar import NEW_YORK, NYSE, NyseCalendar
from .strategy import ComboOrder, OrderLeg

VENUE_ID = "simulated-paper"
EXERCISE_CUTOFF_AFTER_CLOSE = timedelta(minutes=90)
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MICROSECOND = timedelta(microseconds=1)
_ZERO = Decimal("0")
_ONE = Decimal("1")
_WIDE = Decimal("1000000000000")
_MATH = Context(prec=60)
_RIGHTS = {"call": "C", "put": "P"}


def epoch_ns(moment: datetime) -> int:
    """Whole nanoseconds since 1970-01-01 UTC of a datetime with a time zone."""

    if not isinstance(moment, datetime) or moment.utcoffset() is None:
        raise TypeError("a datetime with a time zone is required")
    return (moment - _EPOCH) // _MICROSECOND * 1000


def _amount(value: object, *, positive: bool = False) -> bool:
    return isinstance(value, Decimal) and value.is_finite() and (value > 0 if positive else value >= 0)


def _aligned(price: Decimal, tick: Decimal) -> bool:
    with localcontext(_MATH):
        return price % tick == 0


def _plain(value: Decimal) -> str:
    return format(value.normalize(), "f")


@dataclass(frozen=True)
class PaperVenueModel:
    """Fee, slippage and liquidity numbers of the simulation. Nothing is defaulted.

    ``fee_per_contract`` and ``minimum_fee`` are US dollars for each leg fill;
    ``fee_rate`` is a fraction of the leg notional. Slippage is against the
    order: ``slippage_bps`` of the quote price plus ``slippage_ticks`` ticks.
    ``depth_fraction`` and ``participation_rate`` are the share of the displayed
    size one order may take.
    """

    tick_size: Decimal
    fee_per_contract: Decimal
    fee_rate: Decimal
    minimum_fee: Decimal
    slippage_bps: Decimal
    slippage_ticks: int
    quote_ttl_ns: int
    submit_latency_ns: int
    depth_fraction: Decimal
    participation_rate: Decimal
    max_fill_contracts: int

    def __post_init__(self) -> None:
        if not _amount(self.tick_size, positive=True):
            raise ValueError("tick_size must be a positive Decimal")
        for name in ("fee_per_contract", "fee_rate", "minimum_fee", "slippage_bps"):
            if not _amount(getattr(self, name)):
                raise ValueError(f"{name} must be a Decimal, zero or more")
        if self.fee_rate > _ONE or self.slippage_bps > Decimal("10000"):
            raise ValueError("fee_rate above 1 or slippage above 10000 bps")
        for name in ("depth_fraction", "participation_rate"):
            value = getattr(self, name)
            if not _amount(value, positive=True) or value > _ONE:
                raise ValueError(f"{name} must be above 0 and at most 1")
        if type(self.slippage_ticks) is not int or not 0 <= self.slippage_ticks <= 10000:
            raise ValueError("slippage_ticks must be a whole number from 0 to 10000")
        for name in ("quote_ttl_ns", "max_fill_contracts"):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name} must be a positive whole number")
        if type(self.submit_latency_ns) is not int or self.submit_latency_ns < 0:
            raise ValueError("submit_latency_ns must be a whole number, zero or more")


@dataclass(frozen=True)
class LegQuote:
    """Top of book of one option. A bid of 0 means no bid. Sizes are contracts."""

    bid: Decimal
    ask: Decimal
    bid_size: int
    ask_size: int

    def __post_init__(self) -> None:
        if not _amount(self.bid) or not _amount(self.ask, positive=True):
            raise ValueError("bid must be a Decimal of 0 or more and ask a positive Decimal")
        if self.bid >= self.ask:
            raise ValueError("a locked or crossed quote is not a market")
        for name in ("bid_size", "ask_size"):
            value = getattr(self, name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{name} must be a whole number, zero or more")


@dataclass(frozen=True)
class SpreadQuote:
    """Both legs at one time. ``long_leg`` is the leg at the long strike of the spread."""

    observed_at_ns: int
    long_leg: LegQuote
    short_leg: LegQuote

    def __post_init__(self) -> None:
        if type(self.observed_at_ns) is not int or self.observed_at_ns < 0:
            raise ValueError("observed_at_ns must be whole nanoseconds since 1970 UTC")
        if not isinstance(self.long_leg, LegQuote) or not isinstance(self.short_leg, LegQuote):
            raise ValueError("two leg quotes are required")


@dataclass(frozen=True)
class LegFill:
    action: Literal["BUY", "SELL"]
    right: Literal["call", "put"]
    strike: Decimal
    quantity: int
    price: Decimal
    fee: Decimal

    def to_json(self) -> dict[str, object]:
        return {
            "action": self.action,
            "right": self.right,
            "strike": str(self.strike),
            "quantity": self.quantity,
            "price": str(self.price),
            "fee": str(self.fee),
        }


@dataclass(frozen=True)
class PaperFill:
    """A simulated fill of one whole combo. Cash is US dollars, positive = received.

    ``net_price`` is per share in the terms of ``net_side``: the debit paid or
    the credit received. ``net_cash`` = ``gross_cash`` - ``fees``. ``order`` is
    the order that was filled; ``to_json`` leaves it out (a report shows it once).
    """

    order: ComboOrder
    request_id: str
    intent_id: str
    kind: Literal["open", "close"]
    quantity: int
    net_side: Literal["debit", "credit"]
    net_price: Decimal
    legs: tuple[LegFill, LegFill]
    gross_cash: Decimal
    fees: Decimal
    net_cash: Decimal
    filled_at_ns: int
    submission_key: str
    simulator_state_hash: str
    venue: str = VENUE_ID

    def to_json(self) -> dict[str, object]:
        return {
            "venue": self.venue,
            "requestId": self.request_id,
            "intentId": self.intent_id,
            "kind": self.kind,
            "quantity": self.quantity,
            "netSide": self.net_side,
            "netPrice": str(self.net_price),
            "legs": [leg.to_json() for leg in self.legs],
            "grossCash": str(self.gross_cash),
            "fees": str(self.fees),
            "netCash": str(self.net_cash),
            "filledAtNs": self.filled_at_ns,
            "submissionKey": self.submission_key,
            "simulatorStateHash": self.simulator_state_hash,
        }


@dataclass(frozen=True)
class VenueRefusal:
    code: str
    detail: str

    def to_json(self) -> dict[str, object]:
        return {"code": self.code, "detail": self.detail}


class SimulatedPaperVenue:
    """See the module text. One instance keeps the fills it made, in memory."""

    __slots__ = ("_calendar", "_fills", "_model", "_provenance", "_sequence")

    def __init__(
        self, model: PaperVenueModel, *, calendar: NyseCalendar = NYSE, provenance_id: str = "paper-deploy"
    ) -> None:
        """``provenance_id``: a text label of this run; it names the simulator of each order."""

        if not isinstance(model, PaperVenueModel):
            raise TypeError("model must be a PaperVenueModel (this venue takes no broker client)")
        if not isinstance(calendar, NyseCalendar):
            raise TypeError("calendar must be a NyseCalendar")
        if not isinstance(provenance_id, str):
            raise TypeError("provenance_id must be text")
        if not provenance_id.strip() or len(provenance_id) > 128 or any(ord(char) < 32 for char in provenance_id):
            raise ValueError("provenance_id must be 1 to 128 printable characters")
        self._model = model
        self._calendar = calendar
        self._provenance = provenance_id
        self._fills: list[PaperFill] = []
        self._sequence = 0

    @property
    def provenance_id(self) -> str:
        return self._provenance

    @property
    def fills(self) -> tuple[PaperFill, ...]:
        return tuple(self._fills)

    def fill(self, order: ComboOrder, quote: SpreadQuote, now_ns: int) -> PaperFill | VenueRefusal:
        if not isinstance(order, ComboOrder):
            raise TypeError("order must be a ComboOrder")
        if not isinstance(quote, SpreadQuote):
            raise TypeError("quote must be a SpreadQuote")
        if type(now_ns) is not int or now_ns < 0:
            raise TypeError("now_ns must be whole nanoseconds since 1970 UTC")
        model, calendar = self._model, self._calendar

        day = datetime.fromtimestamp(now_ns // 1_000_000_000, tz=NEW_YORK).date()
        if not calendar.is_session(day):
            return VenueRefusal("session_closed", f"{day.isoformat()} is not a session")
        open_ns, close_ns = epoch_ns(calendar.session_open(day)), epoch_ns(calendar.session_close(day))
        fill_ns = now_ns + max(model.submit_latency_ns, 1)
        if not open_ns <= now_ns or fill_ns + 1 > close_ns:
            return VenueRefusal("session_closed", f"the session of {day.isoformat()} is not open for this order")
        expiry_session = calendar.last_session_on_or_before(order.long_leg.expiry)
        if fill_ns >= epoch_ns(calendar.session_close(expiry_session)):
            return VenueRefusal("option_expired", f"the option stopped trading on {expiry_session.isoformat()}")
        if quote.observed_at_ns > now_ns:
            return VenueRefusal("quote_from_future", "the quote is stamped after the order time")
        if quote.observed_at_ns < open_ns or fill_ns - quote.observed_at_ns > model.quote_ttl_ns:
            return VenueRefusal("quote_stale", "the quote is from before this session or older than the model allows")

        sides = ((order.long_leg, quote.long_leg), (order.short_leg, quote.short_leg))
        for leg, leg_quote in sides:
            price, size = (leg_quote.ask, leg_quote.ask_size) if leg.action == "BUY" else (leg_quote.bid, leg_quote.bid_size)
            name = f"{leg.action} {leg.right} {leg.strike}"
            if not all(_aligned(value, model.tick_size) for value in (leg_quote.bid, leg_quote.ask)):
                return VenueRefusal("quote_off_tick", f"{name}: the quote is not on the {model.tick_size} tick")
            if price <= _ZERO or size <= 0:
                return VenueRefusal("no_market", f"{name}: no {'ask' if leg.action == 'BUY' else 'bid'} to trade against")
            if size < order.quantity:
                return VenueRefusal("insufficient_size", f"{name}: {size} displayed, {order.quantity} needed")

        self._sequence += 1
        payload_hash = sha256(json.dumps(order.to_json(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        key = f"paper-{self._sequence}-{payload_hash[:24]}"
        try:
            with localcontext(_MATH):
                return self._simulate(order, sides, quote.observed_at_ns, now_ns, fill_ns, day, open_ns, close_ns, key, payload_hash)
        except ValueError as error:
            return VenueRefusal("simulator_error", str(error)[:300])

    def _schedule(self, expiry: date) -> ExpirySchedule:
        calendar = self._calendar
        effective = calendar.last_session_on_or_before(expiry)
        closed = tuple(
            (effective + timedelta(days=offset)).isoformat()
            for offset in range(1, (expiry - effective).days + 1)
            if (effective + timedelta(days=offset)).weekday() < 5
        )
        close = calendar.session_close(effective)
        return ExpirySchedule(
            calendar_id="nyse-rule-calendar",
            calendar_version="paper-deploy-1",
            exchange_timezone="America/New_York",
            fixing_utc_offset_seconds=int(close.utcoffset().total_seconds()),
            nominal_expiry_date=expiry.isoformat(),
            effective_expiry_date=effective.isoformat(),
            closed_dates=closed,
            holiday_rule="previous-business-day",
            fixing_session="PM",
            last_trade_ns=epoch_ns(close),
            fixing_ns=epoch_ns(close),
            exercise_cutoff_ns=epoch_ns(close + EXERCISE_CUTOFF_AFTER_CLOSE),
            settlement_due_ns=epoch_ns(calendar.session_close(calendar.next_session(effective))),
        )

    def _simulate(
        self,
        order: ComboOrder,
        sides: tuple[tuple[OrderLeg, LegQuote], tuple[OrderLeg, LegQuote]],
        quote_ns: int,
        now_ns: int,
        fill_ns: int,
        day: date,
        open_ns: int,
        close_ns: int,
        key: str,
        payload_hash: str,
    ) -> PaperFill | VenueRefusal:
        model = self._model
        tick = model.tick_size
        session_id = f"{day.isoformat()}:regular"
        quantity = Decimal(order.quantity)
        models, command_legs, snapshots = [], [], []
        for index, (leg, leg_quote) in enumerate(sides):
            identity = f"{order.symbol}:{leg.expiry:%Y%m%d}:{_RIGHTS[leg.right]}:{_plain(leg.strike)}"
            terms = OptionTerms(order.symbol, leg.right, leg.strike, "american", "physical", leg.multiplier, self._schedule(leg.expiry))
            instrument = QualifiedInstrument(
                identity, order.symbol, session_id, "USD", "option", tick, _ONE, leg.multiplier, "paper-deploy:unqualified", terms
            )
            model_id = f"paper-model:{identity}"
            models.append(
                SessionModel(
                    model_id=model_id,
                    instrument_id=identity,
                    symbol=order.symbol,
                    session_id=session_id,
                    session_open_ns=open_ns,
                    session_close_ns=close_ns,
                    submit_latency_ns=model.submit_latency_ns,
                    cancel_latency_ns=0,
                    quote_ttl_ns=model.quote_ttl_ns,
                    participation_rate=model.participation_rate,
                    depth_fraction=model.depth_fraction,
                    maximum_fill_quantity=Decimal(model.max_fill_contracts),
                    fee_per_unit=model.fee_per_contract,
                    fee_rate=model.fee_rate,
                    minimum_fee=model.minimum_fee,
                    slippage_bps=model.slippage_bps,
                    slippage_ticks=model.slippage_ticks,
                )
            )
            buying = leg.action == "BUY"
            # Wide leg limits: the net limit is enforced below, on the prices the simulator gives.
            wide = (leg_quote.ask * 2 // tick + model.slippage_ticks + 2) * tick if buying else tick
            command_legs.append(QualifiedLeg(f"leg-{index}", instrument, "buy" if buying else "sell", _ONE, wide, model_id))
            bids = (BookLevel(leg_quote.bid, Decimal(leg_quote.bid_size)),) if leg_quote.bid > _ZERO and leg_quote.bid_size > 0 else ()
            asks = (BookLevel(leg_quote.ask, Decimal(leg_quote.ask_size)),) if leg_quote.ask_size > 0 else ()
            traded = Decimal(leg_quote.ask_size if buying else leg_quote.bid_size)
            snapshots.append(DepthSnapshot(identity, order.symbol, session_id, quote_ns, 1, bids, asks, traded))

        simulator = PaperSimulator(tuple(models), provenance_id=f"{self._provenance}:{key}")
        simulator.advance(tuple(snapshots), quote_ns)
        limits = AdmittedLimits(quantity, _WIDE, _WIDE, quantity, 0, close_ns)
        command = SubmitCommand(
            key, payload_hash, tuple(command_legs), quantity, limits, "paper-deploy-strategy", "paper-deploy-policy", now_ns, fill_ns + 1
        )
        accepted = simulator.submit(command)[-1]
        if accepted.status != "accepted":
            return VenueRefusal("simulator_rejected", f"{accepted.status}: {accepted.reason}")
        simulator.advance((), fill_ns)
        result = simulator.reconcile(key)
        totals = result.cumulative_fills
        if result.status != "filled" or not result.final or any(total.quantity != quantity for total in totals):
            filled = ", ".join(f"{leg.action} {leg.strike}: {_plain(total.quantity)}" for (leg, _), total in zip(sides, totals))
            return VenueRefusal("not_filled", f"simulator {result.status} ({result.reason}); legs filled {filled}; nothing is kept")

        leg_fills = tuple(
            LegFill(leg.action, leg.right, leg.strike, order.quantity, total.gross_notional / (quantity * leg.multiplier), total.fees)
            for (leg, _), total in zip(sides, totals)
        )
        bought = next(fill for fill in leg_fills if fill.action == "BUY")
        sold = next(fill for fill in leg_fills if fill.action == "SELL")
        net_debit = bought.price - sold.price
        net_price = net_debit if order.net_side == "debit" else -net_debit
        if (order.net_side == "debit" and net_price > order.net_limit) or (order.net_side == "credit" and net_price < order.net_limit):
            bound = "at most" if order.net_side == "debit" else "at least"
            return VenueRefusal(
                "limit_not_reached",
                f"net {order.net_side} would be {_plain(net_price)} (buy {_plain(bought.price)}, sell {_plain(sold.price)}); "
                f"the limit is {bound} {_plain(order.net_limit)}",
            )
        gross_cash = sum(
            (total.gross_notional if leg.action == "SELL" else -total.gross_notional for (leg, _), total in zip(sides, totals)),
            _ZERO,
        )
        fees = sum((total.fees for total in totals), _ZERO)
        fill = PaperFill(
            order=order,
            request_id=order.request_id,
            intent_id=order.intent_id,
            kind=order.kind,
            quantity=order.quantity,
            net_side=order.net_side,
            net_price=net_price,
            legs=leg_fills,
            gross_cash=gross_cash,
            fees=fees,
            net_cash=gross_cash - fees,
            filled_at_ns=fill_ns,
            submission_key=key,
            simulator_state_hash=result.state_hash,
        )
        self._fills.append(fill)
        return fill
