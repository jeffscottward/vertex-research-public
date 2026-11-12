"""The paper deployment request as the paper path reads it.

``PaperRequest.from_record`` reads one deployment request record (the JSON of
packages/api/src/contracts/deployment-requests.ts). It takes the fields below
and ignores the other fields of the record:

- ``id``, ``strategyId``, ``symbol``, ``status``, ``mode``, ``limits`` (required);
- ``timeframe`` (optional text);
- ``options`` (optional): the option structure of the request. A record without
  it, or with ``null``, is the old format and loads with ``options=None``.

The request's ``strategyId`` identifies the sleeve: there is no sleeve key in
the options block.

The ``options`` block is validated here a second time, with no trust in the
caller. The rules are those of ``normalizeDeploymentOptions`` in
packages/db/src/server/deployment-requests.ts. Only these keys; any other key
is refused, in the block and in its nested objects:

- ``structure``: ``callDebitVertical``, ``putDebitVertical``,
  ``putCreditVertical`` or ``callCreditVertical``;
- ``dte``: ``{target, min}``, whole calendar days, 1 <= target <= 730 and
  0 <= min <= target;
- ``width``: ``{unit, value}``, unit ``sigma`` or ``price``, value above 0 and
  at most 10000;
- ``anchorDelta``: above 0 and below 1;
- ``legs``: ``[{role: anchor, action, right}, {role: wing, action, right}]`` in
  that order. A debit structure buys the anchor and sells the wing, a credit
  structure sells the anchor and buys the wing, and both have the right of the
  structure. Left out or ``null``: filled in from the structure;
- ``maxLossPctOfAccount``: above 0 and at most 2 (hard ceiling; a larger value
  is refused, it is never lowered silently);
- ``budgetPctOfAccount``: above 0 and at most ``maxLossPctOfAccount``;
- ``group``: ``null`` (or left out), or ``{key, symbols}`` with 2 to 16
  different symbols that include the symbol of the request.

Modes: ``paper`` and ``live`` load (the strategy refuses every mode but
``paper``); any other mode is refused here.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
import re
from typing import Literal

KNOWN_MODES = ("paper", "live")
STATUS_VALUES = ("draft", "requested", "approved", "rejected", "withdrawn")
MAX_LOSS_PCT_CEILING = Decimal("2")
MAX_DTE = 730
MAX_WIDTH = Decimal("10000")
WIDTH_UNITS = ("sigma", "price")
GROUP_MIN_SYMBOLS = 2
GROUP_MAX_SYMBOLS = 16

# structure -> (right, kind). Debit: the long leg is worth more. Credit: the short leg.
STRUCTURES: dict[str, tuple[Literal["call", "put"], Literal["debit", "credit"]]] = {
    "callDebitVertical": ("call", "debit"),
    "putDebitVertical": ("put", "debit"),
    "putCreditVertical": ("put", "credit"),
    "callCreditVertical": ("call", "credit"),
}

OPTION_KEYS = ("structure", "dte", "width", "anchorDelta", "legs", "budgetPctOfAccount", "maxLossPctOfAccount", "group")
_LIMIT_KEYS = ("maxOrderSize", "maxPosition", "maxOrdersPerMinute", "dailyLossLimit")
_GROUP_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9._/:-]{0,31}")


class RequestError(ValueError):
    """The record is not a request this path can read."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"deployment request refused ({code}): {detail}")
        self.code = code
        self.detail = detail


def _bad(detail: str) -> RequestError:
    return RequestError("options_invalid", detail)


def _number(value: object) -> Decimal | None:
    """A finite JSON number as a Decimal; ``None`` for anything else (bool included)."""

    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    number = value if isinstance(value, Decimal) else Decimal(str(value))
    return number if number.is_finite() else None


def _amount(value: object) -> bool:
    return isinstance(value, Decimal) and value.is_finite()


def _text(record: Mapping, key: str, *, required: bool, limit: int = 256) -> str | None:
    value = record.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise RequestError("malformed_request", f"{key} must be text of 1 to {limit} characters")
    return value.strip()


def _only_keys(raw: Mapping, allowed: tuple[str, ...], path: str) -> None:
    for key in raw:
        if key not in allowed:
            raise _bad(f"{path}.{str(key)[:40]} is not a recognized field")


def _symbol(value: object) -> str:
    symbol = value.strip().upper() if isinstance(value, str) else ""
    if not _SYMBOL.fullmatch(symbol):
        raise _bad("options.group.symbols must be symbols of 1 to 32 letters, digits or . _ / : -")
    return symbol


@dataclass(frozen=True)
class RequestLimits:
    max_order_size: Decimal
    max_position: Decimal
    max_orders_per_minute: int
    daily_loss_limit: Decimal

    @classmethod
    def from_record(cls, raw: object) -> RequestLimits:
        if not isinstance(raw, Mapping):
            raise RequestError("malformed_request", "limits must be an object")
        values: dict[str, Decimal] = {}
        for key in _LIMIT_KEYS:
            number = _number(raw.get(key))
            if number is None or number <= 0:
                raise RequestError("malformed_request", f"limits.{key} must be a positive number")
            values[key] = number
        per_minute = values["maxOrdersPerMinute"]
        if per_minute != per_minute.to_integral_value() or per_minute > 1000:
            raise RequestError("malformed_request", "limits.maxOrdersPerMinute must be a whole number up to 1000")
        return cls(values["maxOrderSize"], values["maxPosition"], int(per_minute), values["dailyLossLimit"])


@dataclass(frozen=True)
class OptionLeg:
    """One leg of the structure by its role. The strikes come later, from the intent."""

    role: Literal["anchor", "wing"]
    action: Literal["buy", "sell"]
    right: Literal["call", "put"]


@dataclass(frozen=True)
class OptionGroup:
    key: str
    symbols: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.key, str) or not _GROUP_KEY.fullmatch(self.key):
            raise _bad("options.group.key must be 1-64 letters, digits, _ or - starting with a letter or digit")
        symbols = self.symbols
        if not isinstance(symbols, tuple) or not GROUP_MIN_SYMBOLS <= len(symbols) <= GROUP_MAX_SYMBOLS:
            raise _bad(f"options.group.symbols must list {GROUP_MIN_SYMBOLS} to {GROUP_MAX_SYMBOLS} symbols")
        if tuple(_symbol(symbol) for symbol in symbols) != symbols:
            raise _bad("options.group.symbols must be upper-case symbols")
        if len(set(symbols)) != len(symbols):
            raise _bad("options.group.symbols must not repeat a symbol")

    @classmethod
    def from_record(cls, raw: object) -> OptionGroup:
        if not isinstance(raw, Mapping):
            raise _bad("options.group must be an object")
        _only_keys(raw, ("key", "symbols"), "options.group")
        listed = raw.get("symbols")
        if not isinstance(listed, (list, tuple)):
            raise _bad(f"options.group.symbols must list {GROUP_MIN_SYMBOLS} to {GROUP_MAX_SYMBOLS} symbols")
        return cls(raw.get("key"), tuple(_symbol(symbol) for symbol in listed))


def structure_legs(structure: str) -> tuple[OptionLeg, OptionLeg]:
    """The two legs a structure means: (anchor, wing)."""

    right, kind = STRUCTURES[structure]
    return (
        OptionLeg("anchor", "buy" if kind == "debit" else "sell", right),
        OptionLeg("wing", "sell" if kind == "debit" else "buy", right),
    )


@dataclass(frozen=True)
class OptionsBlock:
    structure: str
    dte_target: int
    dte_min: int
    width_unit: str
    width_value: Decimal
    anchor_delta: Decimal
    legs: tuple[OptionLeg, OptionLeg]
    budget_pct_of_account: Decimal
    max_loss_pct_of_account: Decimal
    group: OptionGroup | None = None

    def __post_init__(self) -> None:
        # The same rules for a block built in python as for one read from a record.
        if not isinstance(self.structure, str) or self.structure not in STRUCTURES:
            raise _bad(f"options.structure must be one of {', '.join(STRUCTURES)}")
        if type(self.dte_target) is not int or not 1 <= self.dte_target <= MAX_DTE:
            raise _bad(f"options.dte.target must be a whole number from 1 to {MAX_DTE}")
        if type(self.dte_min) is not int or not 0 <= self.dte_min <= self.dte_target:
            raise _bad("options.dte.min must be a whole number from 0 to options.dte.target")
        if self.width_unit not in WIDTH_UNITS:
            raise _bad(f"options.width.unit must be one of {', '.join(WIDTH_UNITS)}")
        if not _amount(self.width_value) or not 0 < self.width_value <= MAX_WIDTH:
            raise _bad(f"options.width.value must be greater than 0 and at most {MAX_WIDTH}")
        if not _amount(self.anchor_delta) or not 0 < self.anchor_delta < 1:
            raise _bad("options.anchorDelta must be between 0 and 1 (absolute delta)")
        if self.legs != structure_legs(self.structure):
            anchor, wing = structure_legs(self.structure)
            raise _bad(
                f"options.legs do not agree with {self.structure}: the anchor leg must {anchor.action} "
                f"a {anchor.right} and the wing leg must {wing.action} a {wing.right}"
            )
        maximum = self.max_loss_pct_of_account
        if not _amount(maximum) or maximum <= 0:
            raise _bad("options.maxLossPctOfAccount must be a number greater than 0")
        if maximum > MAX_LOSS_PCT_CEILING:
            raise RequestError(
                "max_loss_pct_above_ceiling",
                f"options.maxLossPctOfAccount {maximum} is above the ceiling of {MAX_LOSS_PCT_CEILING}% "
                "of the account per position",
            )
        budget = self.budget_pct_of_account
        if not _amount(budget) or budget <= 0:
            raise _bad("options.budgetPctOfAccount must be a number greater than 0")
        if budget > maximum:
            raise _bad("options.budgetPctOfAccount must not exceed options.maxLossPctOfAccount")
        if self.group is not None and not isinstance(self.group, OptionGroup):
            raise _bad("options.group must be an object or null")

    @property
    def right(self) -> Literal["call", "put"]:
        return STRUCTURES[self.structure][0]

    @property
    def kind(self) -> Literal["debit", "credit"]:
        return STRUCTURES[self.structure][1]

    @classmethod
    def from_record(cls, raw: object) -> OptionsBlock:
        if not isinstance(raw, Mapping):
            raise _bad("options must be an object")
        _only_keys(raw, OPTION_KEYS, "options")
        structure = raw.get("structure")
        if not isinstance(structure, str) or structure not in STRUCTURES:
            raise _bad(f"options.structure must be one of {', '.join(STRUCTURES)}")

        dte = raw.get("dte")
        if not isinstance(dte, Mapping):
            raise _bad("options.dte must be an object")
        _only_keys(dte, ("target", "min"), "options.dte")
        days: dict[str, int] = {}
        for key in ("target", "min"):
            number = _number(dte.get(key))
            if number is None or number != number.to_integral_value() or abs(number) > MAX_DTE:
                raise _bad(f"options.dte.{key} must be a whole number of days, at most {MAX_DTE}")
            days[key] = int(number)

        width = raw.get("width")
        if not isinstance(width, Mapping):
            raise _bad("options.width must be an object with unit and value")
        _only_keys(width, ("unit", "value"), "options.width")
        unit = width.get("unit")
        if not isinstance(unit, str):
            raise _bad(f"options.width.unit must be one of {', '.join(WIDTH_UNITS)}")

        numbers: dict[str, Decimal] = {}
        for name, value in (
            ("width.value", width.get("value")),
            ("anchorDelta", raw.get("anchorDelta")),
            ("maxLossPctOfAccount", raw.get("maxLossPctOfAccount")),
            ("budgetPctOfAccount", raw.get("budgetPctOfAccount")),
        ):
            number = _number(value)
            if number is None:
                raise _bad(f"options.{name} must be a number")
            numbers[name] = number

        legs = structure_legs(structure)
        listed = raw.get("legs")
        if listed is not None:
            if not isinstance(listed, (list, tuple)) or len(listed) != 2:
                raise _bad("options.legs must list exactly the anchor leg and the wing leg")
            for index, (leg, want) in enumerate(zip(listed, legs)):
                if not isinstance(leg, Mapping):
                    raise _bad(f"options.legs[{index}] must be an object")
                _only_keys(leg, ("role", "action", "right"), f"options.legs[{index}]")
                if (leg.get("role"), leg.get("action"), leg.get("right")) != (want.role, want.action, want.right):
                    raise _bad(
                        f"options.legs do not agree with {structure}: the {want.role} leg must "
                        f"{want.action} a {want.right}"
                    )

        group = raw.get("group")
        return cls(
            structure=structure,
            dte_target=days["target"],
            dte_min=days["min"],
            width_unit=unit,
            width_value=numbers["width.value"],
            anchor_delta=numbers["anchorDelta"],
            legs=legs,
            budget_pct_of_account=numbers["budgetPctOfAccount"],
            max_loss_pct_of_account=numbers["maxLossPctOfAccount"],
            group=None if group is None else OptionGroup.from_record(group),
        )


@dataclass(frozen=True)
class PaperRequest:
    """``strategy_id`` is the identity of the sleeve this request deploys."""

    request_id: str
    strategy_id: str
    symbol: str
    mode: str
    status: str
    limits: RequestLimits
    options: OptionsBlock | None = None
    timeframe: str | None = None

    def __post_init__(self) -> None:
        for name in ("request_id", "strategy_id", "symbol", "mode", "status"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise RequestError("malformed_request", f"{name} must be text")
        if not isinstance(self.limits, RequestLimits):
            raise RequestError("malformed_request", "limits must be RequestLimits")
        if self.options is not None and not isinstance(self.options, OptionsBlock):
            raise _bad("options must be an OptionsBlock or None")
        group = None if self.options is None else self.options.group
        if group is not None and self.symbol.strip().upper() not in group.symbols:
            raise _bad(f"options.group.symbols must include the request symbol {self.symbol.strip().upper()[:32]}")

    @classmethod
    def from_record(cls, record: Mapping) -> PaperRequest:
        if not isinstance(record, Mapping):
            raise RequestError("malformed_request", "the record must be an object")
        mode = record.get("mode")
        if not isinstance(mode, str) or mode not in KNOWN_MODES:
            shown = repr(mode)[:40]
            raise RequestError("unknown_mode", f"mode {shown} is not one of {', '.join(KNOWN_MODES)}")
        status = record.get("status")
        if not isinstance(status, str) or status not in STATUS_VALUES:
            raise RequestError("malformed_request", f"status must be one of {', '.join(STATUS_VALUES)}")
        raw_options = record.get("options")
        return cls(
            request_id=_text(record, "id", required=True, limit=128),
            strategy_id=_text(record, "strategyId", required=True, limit=128),
            symbol=_text(record, "symbol", required=True, limit=64),
            mode=mode,
            status=status,
            limits=RequestLimits.from_record(record.get("limits")),
            options=None if raw_options is None else OptionsBlock.from_record(raw_options),
            timeframe=_text(record, "timeframe", required=False, limit=16),
        )
