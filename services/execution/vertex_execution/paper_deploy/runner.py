"""The paper path end to end, in memory. No broker, no file, no wall clock.

``PaperPath.open``:          request -> strategy -> policy -> fill -> position.
``PaperPath.evaluate_exit``: exit rule -> strategy (close order) -> policy -> fill.

Each call returns one ``PathResult``. ``reached`` is the last stage the call
entered. When a stage refuses, ``refusal_stage`` is that stage and
``refusal_code`` its code, and nothing after it runs: an order that the policy
refuses never reaches the venue. Outcomes: ``opened``, ``held``, ``closed``,
``expired`` (both legs out of the money on expiry day: the position leaves the
book without an order), ``refused`` and ``alert`` (the exit rule reported
``past_expiry``; the position stays in the book for a manual check).

Stages of a refusal:

- ``request``: the record is not readable (``RequestError`` code), or the intent
  was already opened (``duplicate_intent``).
- ``strategy``: ``StrategyRefusal`` code; ``open`` given a close intent is
  ``intent_not_open``.
- ``policy``: the code of the policy; a policy that does not return a
  ``PolicyDecision`` is ``policy_result_invalid``.
- ``fill``: ``VenueRefusal`` code; a close without a quote is ``no_quote``.
- ``exit``: ``past_expiry``.

Exit handling: the runner is the caller of ``decide_exit``. It stores
``loser_checked_on`` from each decision. When a close order is refused or does
not fill, the position stays and nothing else is stored, so the next evaluation
decides again.

Close limit: the exit rule says "close", not "close at a price". Without a
``net_limit`` from the caller the close order takes any fill the venue gives up
to the worst sane price: a credit of one cent when it sells a debit spread, a
debit of the strike width when it buys back a credit spread. The venue fills at
the quote, not at the limit.

Per request the book also holds the line: the open max loss of all positions of
one request stays at or below its ``maxLossPctOfAccount`` (at most 2%) of the
account value given to ``open``, and the open contracts stay at or below
``limits.maxPosition``. An intent whose signal date is after today (New York) or
more than ``MAX_SIGNAL_AGE_DAYS`` calendar days old is refused.

Not enforced here: ``limits.maxOrdersPerMinute`` and ``limits.dailyLossLimit`` of
the request, and the ``group`` of its options.

The position book is a dict in memory and is lost with the object.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import date, datetime
from decimal import Decimal
from fractions import Fraction
from typing import Literal

from .calendar import NEW_YORK, NYSE, NyseCalendar
from .exit_rule import ERROR_PAST_EXPIRY, ExitDecision, HeldSpread, SpreadMark, decide_exit
from .policy import PolicyDecision, PolicyPort
from .request import MAX_LOSS_PCT_CEILING, STRUCTURES, PaperRequest, RequestError
from .strategy import ComboOrder, PaperSpreadStrategy, SpreadIntent, StrategyRefusal
from .venue import PaperFill, SimulatedPaperVenue, SpreadQuote, VenueRefusal, epoch_ns

Stage = Literal["request", "strategy", "policy", "fill", "exit"]
Outcome = Literal["opened", "held", "closed", "expired", "refused", "alert"]
MINIMUM_CLOSE_CREDIT = Decimal("0.01")
# A signal of Friday enters on Tuesday after a Monday holiday: 4 calendar days.
MAX_SIGNAL_AGE_DAYS = 5


@dataclass(frozen=True)
class PaperPosition:
    """One open spread of the in-memory book."""

    position_id: str
    request: PaperRequest
    held: HeldSpread
    strategy_id: str
    structure: str
    multiplier: Decimal
    opened_at: datetime
    open_fill: PaperFill
    loser_checked_on: date | None = None
    close_attempts: int = 0
    max_loss_total: Decimal = Decimal(0)

    def to_json(self) -> dict[str, object]:
        held = self.held
        return {
            "positionId": self.position_id,
            "requestId": self.request.request_id,
            "symbol": held.symbol,
            "strategyId": self.strategy_id,
            "structure": self.structure,
            "expiry": held.expiry.isoformat(),
            "longStrike": str(held.long_strike),
            "shortStrike": str(held.short_strike),
            "quantity": held.quantity,
            "entryCost": str(held.entry_cost),
            "enteredOn": held.entered_on.isoformat(),
            "loserCheckedOn": None if self.loser_checked_on is None else self.loser_checked_on.isoformat(),
            "closeAttempts": self.close_attempts,
        }


@dataclass(frozen=True)
class PathResult:
    operation: Literal["open", "exit"]
    outcome: Outcome
    reached: Stage
    refusal_stage: Stage | None = None
    refusal_code: str | None = None
    refusal_detail: str | None = None
    order: ComboOrder | None = None
    policy: PolicyDecision | None = None
    fill: PaperFill | None = None
    exit: ExitDecision | None = None
    position: PaperPosition | None = None
    realized_pnl: Decimal | None = None

    @property
    def refused(self) -> bool:
        return self.refusal_stage is not None

    def to_json(self) -> dict[str, object]:
        """Plain JSON values for a report (amounts as text)."""

        def plain(value: object) -> object:
            return None if value is None else value.to_json()

        return {
            "operation": self.operation,
            "outcome": self.outcome,
            "reached": self.reached,
            "refusal": None
            if self.refusal_stage is None
            else {"stage": self.refusal_stage, "code": self.refusal_code, "detail": self.refusal_detail},
            "order": plain(self.order),
            "policy": plain(self.policy),
            "fill": plain(self.fill),
            "exit": plain(self.exit),
            "position": plain(self.position),
            "realizedPnl": None if self.realized_pnl is None else str(self.realized_pnl),
        }


class PaperPath:
    """Glue of the paper path. The venue can only be a ``SimulatedPaperVenue``."""

    __slots__ = ("_calendar", "_closed", "_opened", "_policy", "_positions", "_strategy", "_venue")

    def __init__(
        self,
        policy: PolicyPort,
        venue: SimulatedPaperVenue,
        *,
        strategy: PaperSpreadStrategy | None = None,
        calendar: NyseCalendar = NYSE,
    ) -> None:
        if not callable(policy):
            raise TypeError("policy must be a PolicyPort")
        if not isinstance(venue, SimulatedPaperVenue):
            raise TypeError("venue must be a SimulatedPaperVenue (this path has no live venue)")
        if strategy is not None and not isinstance(strategy, PaperSpreadStrategy):
            raise TypeError("strategy must be a PaperSpreadStrategy")
        if not isinstance(calendar, NyseCalendar):
            raise TypeError("calendar must be a NyseCalendar")
        self._policy = policy
        self._venue = venue
        self._strategy = strategy or PaperSpreadStrategy()
        self._calendar = calendar
        self._positions: dict[str, PaperPosition] = {}
        self._opened: set[str] = set()
        self._closed: list[PathResult] = []

    @property
    def positions(self) -> tuple[PaperPosition, ...]:
        return tuple(self._positions.values())

    @property
    def closed(self) -> tuple[PathResult, ...]:
        """The results that took a position out of the book (``closed`` and ``expired``)."""

        return tuple(self._closed)

    def position(self, position_id: str) -> PaperPosition | None:
        return self._positions.get(position_id)

    def _check_policy(self, order: ComboOrder) -> PolicyDecision:
        decision = self._policy(order)
        if not isinstance(decision, PolicyDecision):
            return PolicyDecision(False, "policy_result_invalid", "the policy did not return a PolicyDecision")
        return decision

    def open(
        self,
        request: PaperRequest | Mapping,
        intent: SpreadIntent,
        nlv: Decimal,
        quote: SpreadQuote,
        now: datetime,
    ) -> PathResult:
        """``request``: a deployment request record or a ``PaperRequest``. ``nlv``: account value."""

        if not isinstance(intent, SpreadIntent):
            raise TypeError("intent must be a SpreadIntent")
        if not isinstance(quote, SpreadQuote):
            raise TypeError("quote must be a SpreadQuote")
        now_ns = epoch_ns(now)

        def refused(stage: Stage, code: str, detail: str, **parts: object) -> PathResult:
            return PathResult("open", "refused", stage, stage, code, detail, **parts)

        if not isinstance(request, PaperRequest):
            try:
                request = PaperRequest.from_record(request)
            except RequestError as error:
                return refused("request", error.code, error.detail)
        if request.mode != "paper":
            # Second check: the strategy refuses this first, and the book never trusts one check.
            return refused("request", "mode_not_paper", f"request mode is {request.mode!r}; this path is paper only")
        if intent.intent_id in self._opened:
            return refused("request", "duplicate_intent", f"intent {intent.intent_id} already opened a position")
        today = now.astimezone(NEW_YORK).date()
        age = (today - intent.signal_date).days
        if age < 0 or age > MAX_SIGNAL_AGE_DAYS:
            return refused(
                "request",
                "signal_date_stale",
                f"signal date {intent.signal_date.isoformat()} is {age} days before {today.isoformat()}; "
                f"allowed 0 to {MAX_SIGNAL_AGE_DAYS}",
            )

        if intent.kind != "open":
            return refused("strategy", "intent_not_open", f"open() was given a {intent.kind!r} intent")
        try:
            order = self._strategy.build(request, intent, nlv)
        except StrategyRefusal as error:
            return refused("strategy", error.code, error.detail)

        mine = [p for p in self._positions.values() if p.request.request_id == request.request_id]
        open_loss = sum((p.max_loss_total for p in mine), Decimal(0))
        allowed_pct = min(request.options.max_loss_pct_of_account, MAX_LOSS_PCT_CEILING)
        if Fraction(open_loss + order.max_loss_total) > Fraction(allowed_pct) * Fraction(nlv) / 100:
            return refused(
                "strategy",
                "request_risk_exceeded",
                f"open max loss {open_loss} plus {order.max_loss_total} is above {allowed_pct}% of the account "
                f"for request {request.request_id}",
                order=order,
            )
        open_contracts = sum(p.held.quantity for p in mine)
        if open_contracts + order.quantity > request.limits.max_position:
            return refused(
                "strategy",
                "max_position_exceeded",
                f"{open_contracts} open contracts plus {order.quantity} is above maxPosition "
                f"{request.limits.max_position} of request {request.request_id}",
                order=order,
            )

        decision = self._check_policy(order)
        if not decision.allowed:
            return refused("policy", decision.code, decision.detail, order=order, policy=decision)

        fill = self._venue.fill(order, quote, now_ns)
        if isinstance(fill, VenueRefusal):
            return refused("fill", fill.code, fill.detail, order=order, policy=decision)

        held = HeldSpread(
            position_id=intent.intent_id,
            symbol=order.symbol,
            right=order.long_leg.right,
            expiry=order.long_leg.expiry,
            long_strike=order.long_leg.strike,
            short_strike=order.short_leg.strike,
            quantity=fill.quantity,
            entry_cost=-fill.net_cash,
            entered_on=now.astimezone(NEW_YORK).date(),
        )
        position = PaperPosition(
            position_id=held.position_id,
            request=request,
            held=held,
            strategy_id=order.strategy_id,
            structure=order.structure,
            multiplier=order.long_leg.multiplier,
            opened_at=now,
            open_fill=fill,
            max_loss_total=order.max_loss_total * fill.quantity / order.quantity,
        )
        self._positions[position.position_id] = position
        self._opened.add(intent.intent_id)
        return PathResult("open", "opened", "fill", order=order, policy=decision, fill=fill, position=position)

    def evaluate_exit(
        self,
        position: PaperPosition | str,
        now: datetime,
        mark: SpreadMark | None,
        quote: SpreadQuote | None,
        *,
        roll_due: bool,
        net_limit: Decimal | None = None,
    ) -> PathResult:
        """One evaluation of the exit rule for an open position, and its close when the rule says so.

        ``quote`` is needed only when the rule closes. ``net_limit``: see the module text.
        """

        position_id = position.position_id if isinstance(position, PaperPosition) else position
        current = self._positions.get(position_id) if isinstance(position_id, str) else None
        if current is None:
            raise ValueError("the position is not in the book of this path")
        if quote is not None and not isinstance(quote, SpreadQuote):
            raise TypeError("quote must be a SpreadQuote or None")
        now_ns = epoch_ns(now)

        decision = decide_exit(
            current.held,
            now,
            mark,
            roll_due=roll_due,
            loser_checked_on=current.loser_checked_on,
            calendar=self._calendar,
        )
        if decision.loser_checked_on != current.loser_checked_on:
            current = replace(current, loser_checked_on=decision.loser_checked_on)
            self._positions[position_id] = current

        if decision.action == "hold":
            return PathResult("exit", "held", "exit", exit=decision, position=current)
        if decision.action == "expired":
            return PathResult(
                "exit", "alert", "exit", "exit", decision.error or ERROR_PAST_EXPIRY, decision.detail, exit=decision, position=current
            )
        if decision.action == "expire":
            del self._positions[position_id]
            result = PathResult(
                "exit", "expired", "exit", exit=decision, position=current, realized_pnl=-current.held.entry_cost
            )
            self._closed.append(result)
            return result

        def refused(stage: Stage, code: str, detail: str, **parts: object) -> PathResult:
            return PathResult("exit", "refused", stage, stage, code, detail, exit=decision, position=current, **parts)

        current = replace(current, close_attempts=current.close_attempts + 1)
        self._positions[position_id] = current
        held = current.held
        if net_limit is None:
            closing_for_credit = STRUCTURES[current.structure][1] == "debit"
            net_limit = MINIMUM_CLOSE_CREDIT if closing_for_credit else abs(held.long_strike - held.short_strike)
        try:
            intent = SpreadIntent(
                intent_id=f"{position_id}:close:{current.close_attempts}",
                request_id=current.request.request_id,
                kind="close",
                strategy_id=current.strategy_id,
                symbol=held.symbol,
                structure=current.structure,
                expiry=held.expiry,
                long_strike=held.long_strike,
                short_strike=held.short_strike,
                net_limit=net_limit,
                signal_date=now.astimezone(NEW_YORK).date(),
                close_reason=decision.reason,
                multiplier=current.multiplier,
            )
            order = self._strategy.build(current.request, intent, None, held_quantity=held.quantity)
        except ValueError as error:
            return refused("strategy", "close_intent_invalid", str(error))
        except StrategyRefusal as error:
            return refused("strategy", error.code, error.detail)

        allowed = self._check_policy(order)
        if not allowed.allowed:
            return refused("policy", allowed.code, allowed.detail, order=order, policy=allowed)
        if quote is None:
            return refused("fill", "no_quote", "the exit rule closes and no quote was given", order=order, policy=allowed)
        fill = self._venue.fill(order, quote, now_ns)
        if isinstance(fill, VenueRefusal):
            return refused("fill", fill.code, fill.detail, order=order, policy=allowed)

        del self._positions[position_id]
        result = PathResult(
            "exit",
            "closed",
            "fill",
            order=order,
            policy=allowed,
            fill=fill,
            exit=decision,
            position=current,
            realized_pnl=fill.net_cash - held.entry_cost,
        )
        self._closed.append(result)
        return result
