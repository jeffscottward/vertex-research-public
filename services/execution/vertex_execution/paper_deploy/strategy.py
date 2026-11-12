"""Paper strategy (F1): one approved paper request plus one intent gives one combo order.

The strategy computes no signal. Symbol, expiry, strikes and the net limit come
from the ``SpreadIntent``; the request says what is allowed and how much.

Combo convention (the IBKR one): the combo is always bought (``action`` is
``BUY``) and each leg carries the action that really happens. ``net_side`` says
what ``net_limit`` means: ``debit`` = the most the order pays per share,
``credit`` = the least it receives per share. ``legs[0]`` is always the long
leg of the held spread and ``legs[1]`` its short leg; a close order has the two
actions reversed.

Open intent, checks in this order (the first failure is the refusal):

``mode_not_paper``, ``request_not_approved``, ``no_option_structure``,
``intent_kind_invalid``, ``request_id_mismatch``, ``symbol_mismatch``,
``sleeve_mismatch``, ``structure_mismatch``, ``expiry_outside_request``,
``limit_implausible``, ``account_value_invalid``, ``max_loss_exceeded``,
``sized_to_zero``.

- Max loss of one contract: debit spread = net limit x multiplier; credit
  spread = (strike width - net limit) x multiplier. Fees are not included.
- ``max_loss_exceeded``: that amount is above ``maxLossPctOfAccount`` % of the
  account value, or above 2 % whatever the request says.
- Size: floor(``budgetPctOfAccount`` % x account value / max loss of one
  contract), then at most floor(``limits.maxOrderSize``) contracts. A request
  that loads has a budget of at most ``maxLossPctOfAccount``, so the whole
  order risks at most that. The strategy holds the same bound itself (the
  smaller of ``maxLossPctOfAccount`` % and 2 %) against a request object that
  did not come through the loader.
- ``expiry_outside_request``: calendar days from ``signal_date`` to the expiry
  below ``dte.min`` or above ``dte.target`` + 45.
- ``sleeve_mismatch``: the sleeve is the strategy of the request, so the
  intent's ``strategy_id`` must be the request's ``strategyId``.

Close intent: the reverse combo for the held quantity that the caller gives.
Checked: ``mode_not_paper``, ``no_option_structure``, ``intent_kind_invalid``,
the four identity checks, ``close_reason_invalid`` and ``quantity_invalid``.
Not checked: the approval status (a close only reduces risk; a request that was
withdrawn after the entry must not block it), the expiry window, the max loss,
the budget and ``maxOrderSize`` (a close is never cut down in size).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_UP, Context, Decimal, localcontext
from fractions import Fraction
from typing import Literal

from .exit_rule import EXIT_REASONS
from .request import MAX_LOSS_PCT_CEILING, STRUCTURES, PaperRequest

EXPIRY_GRACE_DAYS = 45
_HUNDRED = Decimal("100")
_MATH = Context(prec=60)
_PCT_STEP = Decimal("0.000001")


class StrategyRefusal(Exception):
    """The strategy builds no order for this request and intent."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"paper strategy refused ({code}): {detail}")
        self.code = code
        self.detail = detail


def _is_day(value: object) -> bool:
    return isinstance(value, date) and not isinstance(value, datetime)


def _positive(value: object) -> bool:
    return isinstance(value, Decimal) and value.is_finite() and value > 0


def _name(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


@dataclass(frozen=True)
class SpreadIntent:
    """What the signal side wants: open or close one vertical spread.

    ``net_limit`` is per share and above 0: the debit paid or the credit received.
    """

    intent_id: str
    request_id: str
    kind: Literal["open", "close"]
    strategy_id: str
    symbol: str
    structure: str
    expiry: date
    long_strike: Decimal
    short_strike: Decimal
    net_limit: Decimal
    signal_date: date
    close_reason: str | None = None
    multiplier: Decimal = _HUNDRED

    def __post_init__(self) -> None:
        for name in ("intent_id", "request_id", "strategy_id", "symbol", "structure"):
            if not _name(getattr(self, name)):
                raise ValueError(f"invalid {name}")
        if not isinstance(self.kind, str):
            raise ValueError("invalid kind")
        if not _is_day(self.expiry) or not _is_day(self.signal_date):
            raise ValueError("expiry and signal_date must be dates")
        for name in ("long_strike", "short_strike", "net_limit", "multiplier"):
            if not _positive(getattr(self, name)):
                raise ValueError(f"{name} must be a positive Decimal")
        if self.close_reason is not None and not _name(self.close_reason):
            raise ValueError("invalid close_reason")


@dataclass(frozen=True)
class OrderLeg:
    action: Literal["BUY", "SELL"]
    right: Literal["call", "put"]
    strike: Decimal
    expiry: date
    multiplier: Decimal

    def __post_init__(self) -> None:
        if self.action not in ("BUY", "SELL") or self.right not in ("call", "put"):
            raise ValueError("invalid leg action or right")
        if not _positive(self.strike) or not _positive(self.multiplier) or not _is_day(self.expiry):
            raise ValueError("invalid leg strike, multiplier or expiry")

    def to_json(self) -> dict[str, object]:
        return {
            "action": self.action,
            "right": self.right,
            "strike": str(self.strike),
            "expiry": self.expiry.isoformat(),
            "multiplier": str(self.multiplier),
        }


@dataclass(frozen=True)
class ComboOrder:
    """One two-leg combo order. Money fields are US dollars; ``net_limit`` is per share.

    ``max_loss_total`` and ``max_loss_pct_of_account`` are 0 for a close order.
    """

    request_id: str
    intent_id: str
    kind: Literal["open", "close"]
    symbol: str
    strategy_id: str
    structure: str
    action: Literal["BUY"]
    quantity: int
    net_limit: Decimal
    net_side: Literal["debit", "credit"]
    legs: tuple[OrderLeg, OrderLeg]
    max_loss_total: Decimal
    max_loss_pct_of_account: Decimal
    close_reason: str | None = None

    def __post_init__(self) -> None:
        for name in ("request_id", "intent_id", "symbol", "strategy_id"):
            if not _name(getattr(self, name)):
                raise ValueError(f"invalid {name}")
        if self.kind not in ("open", "close") or self.action != "BUY" or self.net_side not in ("debit", "credit"):
            raise ValueError("invalid kind, action or net side")
        if self.structure not in STRUCTURES:
            raise ValueError("invalid structure")
        if type(self.quantity) is not int or self.quantity <= 0:
            raise ValueError("quantity must be a positive whole number of contracts")
        if not _positive(self.net_limit):
            raise ValueError("net_limit must be a positive Decimal")
        legs = self.legs
        if not isinstance(legs, tuple) or len(legs) != 2 or not all(isinstance(leg, OrderLeg) for leg in legs):
            raise ValueError("exactly two legs are required")
        if sorted(leg.action for leg in legs) != ["BUY", "SELL"]:
            raise ValueError("a vertical buys one leg and sells the other")
        first, second = legs
        if (first.right, first.expiry, first.multiplier) != (second.right, second.expiry, second.multiplier):
            raise ValueError("both legs need the same right, expiry and multiplier")
        if first.strike == second.strike:
            raise ValueError("the two legs need different strikes")
        for name in ("max_loss_total", "max_loss_pct_of_account"):
            value = getattr(self, name)
            if not isinstance(value, Decimal) or not value.is_finite() or value < 0:
                raise ValueError(f"invalid {name}")
        if (self.kind == "close") != (self.close_reason is not None):
            raise ValueError("a close order, and only a close order, carries a close reason")

    @property
    def long_leg(self) -> OrderLeg:
        """The leg at the long strike of the spread (sold by a close order)."""

        return self.legs[0]

    @property
    def short_leg(self) -> OrderLeg:
        return self.legs[1]

    @property
    def signed_limit(self) -> Decimal:
        """Net limit as IBKR writes it for a bought combo: debit positive, credit negative."""

        return self.net_limit if self.net_side == "debit" else -self.net_limit

    def to_json(self) -> dict[str, object]:
        return {
            "requestId": self.request_id,
            "intentId": self.intent_id,
            "kind": self.kind,
            "symbol": self.symbol,
            "strategyId": self.strategy_id,
            "structure": self.structure,
            "action": self.action,
            "quantity": self.quantity,
            "netLimit": str(self.net_limit),
            "netSide": self.net_side,
            "legs": [leg.to_json() for leg in self.legs],
            "maxLossTotal": str(self.max_loss_total),
            "maxLossPctOfAccount": str(self.max_loss_pct_of_account),
            "closeReason": self.close_reason,
        }


def strikes_fit(structure: str, long_strike: Decimal, short_strike: Decimal) -> bool:
    """The strike order of ``structure``: a debit call is long the lower strike, and so on."""

    right, kind = STRUCTURES[structure]
    long_is_lower = (right == "call") == (kind == "debit")
    return long_strike < short_strike if long_is_lower else long_strike > short_strike


def max_loss_per_contract(structure: str, intent: SpreadIntent) -> Decimal:
    width = abs(intent.long_strike - intent.short_strike)
    per_share = intent.net_limit if STRUCTURES[structure][1] == "debit" else width - intent.net_limit
    return per_share * intent.multiplier


class PaperSpreadStrategy:
    """Stateless. ``build`` returns a ``ComboOrder`` or raises ``StrategyRefusal``."""

    def build(
        self,
        request: PaperRequest,
        intent: SpreadIntent,
        nlv: Decimal | None,
        *,
        held_quantity: int | None = None,
    ) -> ComboOrder:
        """``nlv``: account net liquidation value, needed for an open intent.

        ``held_quantity``: contracts held, needed for a close intent and only then.
        """

        if not isinstance(request, PaperRequest):
            raise TypeError("request must be a PaperRequest")
        if not isinstance(intent, SpreadIntent):
            raise TypeError("intent must be a SpreadIntent")
        if request.mode != "paper":
            raise StrategyRefusal("mode_not_paper", f"request mode is {request.mode!r}; this path is paper only")
        closing = intent.kind == "close"
        if not closing and request.status != "approved":
            raise StrategyRefusal("request_not_approved", f"request status is {request.status!r}")
        options = request.options
        if options is None:
            raise StrategyRefusal("no_option_structure", "the request has no options block (old format)")
        if intent.kind not in ("open", "close"):
            raise StrategyRefusal("intent_kind_invalid", f"intent kind {intent.kind!r} is not open or close")
        if intent.request_id != request.request_id:
            raise StrategyRefusal("request_id_mismatch", "the intent names another request")
        if intent.symbol != request.symbol:
            raise StrategyRefusal("symbol_mismatch", f"intent {intent.symbol!r}, request {request.symbol!r}")
        if intent.strategy_id != request.strategy_id:
            raise StrategyRefusal(
                "sleeve_mismatch", f"intent strategy {intent.strategy_id!r}, request strategy {request.strategy_id!r}"
            )
        if intent.structure != options.structure:
            raise StrategyRefusal("structure_mismatch", f"intent {intent.structure!r}, request {options.structure!r}")
        if not strikes_fit(options.structure, intent.long_strike, intent.short_strike):
            raise StrategyRefusal(
                "structure_mismatch",
                f"{options.structure} does not have long strike {intent.long_strike} and short strike {intent.short_strike}",
            )
        if intent.multiplier != _HUNDRED:
            # The max loss and the size scale with the multiplier, so the intent cannot choose it.
            raise StrategyRefusal(
                "multiplier_unsupported", f"contract multiplier {intent.multiplier} is not 100 (US equity options)"
            )
        if closing:
            return self._close(intent, options.right, options.kind, held_quantity)
        if held_quantity is not None:
            raise StrategyRefusal("quantity_invalid", "an open intent takes no held quantity")
        if intent.close_reason is not None:
            raise StrategyRefusal("close_reason_invalid", "an open intent carries no close reason")
        dte = (intent.expiry - intent.signal_date).days
        if dte < options.dte_min or dte > options.dte_target + EXPIRY_GRACE_DAYS:
            raise StrategyRefusal(
                "expiry_outside_request",
                f"{dte} days to expiry on {intent.signal_date.isoformat()}; allowed "
                f"{options.dte_min} to {options.dte_target + EXPIRY_GRACE_DAYS}",
            )
        width = abs(intent.long_strike - intent.short_strike)
        if intent.net_limit >= width:
            raise StrategyRefusal(
                "limit_implausible", f"net {options.kind} {intent.net_limit} must be below the strike width {width}"
            )
        if not _positive(nlv):
            raise StrategyRefusal("account_value_invalid", "the account value must be a positive Decimal")
        # A fixed context and exact fractions: the ambient decimal context cannot change the size.
        with localcontext(_MATH):
            one = max_loss_per_contract(options.structure, intent)
            allowed_pct = min(options.max_loss_pct_of_account, MAX_LOSS_PCT_CEILING)
            allowed = allowed_pct / _HUNDRED * nlv
            budget = options.budget_pct_of_account / _HUNDRED * nlv
            if Fraction(one) > Fraction(allowed_pct) * Fraction(nlv) / 100:
                raise StrategyRefusal(
                    "max_loss_exceeded", f"one contract can lose {one}; allowed {allowed_pct}% of {nlv} = {allowed}"
                )
            by_budget = Fraction(options.budget_pct_of_account) * Fraction(nlv) / 100 // Fraction(one)
            by_max_loss = Fraction(allowed_pct) * Fraction(nlv) / 100 // Fraction(one)
            contracts = int(min(by_budget, by_max_loss, Fraction(request.limits.max_order_size) // 1))
            if contracts < 1:
                raise StrategyRefusal(
                    "sized_to_zero",
                    f"budget {budget}, max loss of one contract {one}, maxOrderSize {request.limits.max_order_size}",
                )
            total = one * contracts
            # Rounded up: the reported percentage never understates the risk.
            percent = (total / nlv * _HUNDRED).quantize(_PCT_STEP, rounding=ROUND_UP)
        return ComboOrder(
            request_id=request.request_id,
            intent_id=intent.intent_id,
            kind="open",
            symbol=intent.symbol,
            strategy_id=intent.strategy_id,
            structure=options.structure,
            action="BUY",
            quantity=contracts,
            net_limit=intent.net_limit,
            net_side=options.kind,
            legs=self._legs(intent, options.right, "BUY", "SELL"),
            max_loss_total=total,
            max_loss_pct_of_account=percent,
        )

    @staticmethod
    def _legs(intent: SpreadIntent, right: str, long_action: str, short_action: str) -> tuple[OrderLeg, OrderLeg]:
        return (
            OrderLeg(long_action, right, intent.long_strike, intent.expiry, intent.multiplier),
            OrderLeg(short_action, right, intent.short_strike, intent.expiry, intent.multiplier),
        )

    def _close(self, intent: SpreadIntent, right: str, kind: str, held_quantity: int | None) -> ComboOrder:
        if intent.close_reason not in EXIT_REASONS:
            raise StrategyRefusal("close_reason_invalid", f"close reason must be one of {', '.join(EXIT_REASONS)}")
        if type(held_quantity) is not int or held_quantity <= 0:
            raise StrategyRefusal("quantity_invalid", "a close intent needs the held quantity, a positive whole number")
        return ComboOrder(
            request_id=intent.request_id,
            intent_id=intent.intent_id,
            kind="close",
            symbol=intent.symbol,
            strategy_id=intent.strategy_id,
            structure=intent.structure,
            action="BUY",
            quantity=held_quantity,
            net_limit=intent.net_limit,
            # Closing a debit spread sells it for a credit; closing a credit spread pays a debit.
            net_side="credit" if kind == "debit" else "debit",
            legs=self._legs(intent, right, "SELL", "BUY"),
            max_loss_total=Decimal("0"),
            max_loss_pct_of_account=Decimal("0"),
            close_reason=intent.close_reason,
        )
