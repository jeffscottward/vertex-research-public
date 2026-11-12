"""Order policy port of the paper path, and an adapter for the engine order policy.

``PolicyPort`` is any callable that takes a ``ComboOrder`` and returns a
``PolicyDecision``. ``allow_all`` and ``refuse_all`` are for tests.

``ArmGatePolicy`` asks the engine policy (``check_order_policy`` of the exec
node's ``arm_gate`` module). The caller injects that module; this package never
imports it. The adapter:

- turns the ``ComboOrder`` into IBKR-shaped objects: a BAG contract with two
  combo legs, a bought LMT order whose ``lmtPrice`` is the net debit (positive)
  or the net credit (negative), and one option contract for each leg;
- passes ``legs=[the option contract of each combo leg]`` only when
  ``check_order_policy`` has that parameter (policy v3). Policy v2 has no such
  parameter and refuses every BAG with ``combo_refused``;
- calls with ``client=None`` and ``order_id=None``: the paper path has no
  broker client and no broker order id;
- passes the caller's ``env`` unchanged and writes no file. The account
  snapshot that the policy reads is the caller's work;
- maps the policy refusal (an exception with ``code`` and ``detail``) to
  ``PolicyDecision(False, code, detail)``. Any other exception, and any return
  value that is not a non-empty text, is a refusal too (``policy_error``,
  ``policy_result_invalid``): the adapter fails closed.

Contract ids: the paper path does not qualify contracts with IBKR, so the legs
have no real ``conId``. ``con_id_of`` supplies one for each leg. The default
``synthetic_con_id`` is a made-up stable number; a caller that writes held
positions into the account snapshot uses the same function for their ``conId``.
The trading class of a leg is taken to be the symbol.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
import inspect
from types import SimpleNamespace
from typing import Any

from .strategy import ComboOrder, OrderLeg

_RIGHTS = {"call": "C", "put": "P"}
_DETAIL_LIMIT = 400


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    code: str
    detail: str

    def __post_init__(self) -> None:
        if type(self.allowed) is not bool:
            raise ValueError("allowed must be a bool")
        if not isinstance(self.code, str) or not self.code.strip() or not isinstance(self.detail, str):
            raise ValueError("code and detail must be text; code must not be empty")

    def to_json(self) -> dict[str, object]:
        return {"allowed": self.allowed, "code": self.code, "detail": self.detail}


PolicyPort = Callable[[ComboOrder], PolicyDecision]
ConIdSource = Callable[[str, OrderLeg], int]


def allow_all() -> PolicyPort:
    """A policy that allows every order. For tests."""

    def allow(order: ComboOrder) -> PolicyDecision:
        return PolicyDecision(True, "allow_all", "test policy: every order is allowed")

    return allow


def refuse_all(code: str) -> PolicyPort:
    """A policy that refuses every order with ``code``. For tests."""

    if not isinstance(code, str) or not code.strip():
        raise ValueError("a refusal code is required")

    def refuse(order: ComboOrder) -> PolicyDecision:
        return PolicyDecision(False, code, "test policy: every order is refused")

    return refuse


def synthetic_con_id(symbol: str, leg: OrderLeg) -> int:
    """A made-up positive contract id, stable for one option contract. Not an IBKR id."""

    strike = format(leg.strike.normalize(), "f")
    multiplier = format(leg.multiplier.normalize(), "f")
    text = f"{symbol}|{leg.expiry:%Y%m%d}|{_RIGHTS[leg.right]}|{strike}|{multiplier}"
    return int.from_bytes(sha256(text.encode()).digest()[:4], "big") % (2**31 - 1) + 1


def ibkr_shapes(order: ComboOrder, con_id_of: ConIdSource = synthetic_con_id) -> tuple[Any, Any, list[Any]]:
    """(BAG contract, order, leg contracts) with the attribute names of the IBKR API."""

    legs = []
    combo_legs = []
    for leg in order.legs:
        con_id = con_id_of(order.symbol, leg)
        if type(con_id) is not int or con_id <= 0:
            raise ValueError("con_id_of must return a positive whole number")
        legs.append(
            SimpleNamespace(
                conId=con_id,
                symbol=order.symbol,
                secType="OPT",
                currency="USD",
                exchange="SMART",
                lastTradeDateOrContractMonth=leg.expiry.strftime("%Y%m%d"),
                right=_RIGHTS[leg.right],
                strike=float(leg.strike),
                multiplier=format(leg.multiplier.normalize(), "f"),
                tradingClass=order.symbol,
            )
        )
        combo_legs.append(SimpleNamespace(conId=con_id, ratio=1, action=leg.action, exchange="SMART"))
    contract = SimpleNamespace(
        symbol=order.symbol, secType="BAG", currency="USD", exchange="SMART", comboLegs=combo_legs
    )
    ib_order = SimpleNamespace(
        action=order.action,
        totalQuantity=Decimal(order.quantity),
        orderType="LMT",
        lmtPrice=float(order.signed_limit),
        tif="DAY",
        whatIf=False,
    )
    return contract, ib_order, legs


class ArmGatePolicy:
    """``PolicyPort`` over an injected ``arm_gate`` module. See the module text."""

    __slots__ = ("_check", "_clock", "_con_id_of", "_env", "_name", "_takes_legs")

    def __init__(
        self,
        arm_gate_module: Any,
        env: Mapping[str, str],
        *,
        con_id_of: ConIdSource = synthetic_con_id,
        clock: Callable[[], float] | None = None,
    ) -> None:
        check = getattr(arm_gate_module, "check_order_policy", None)
        if not callable(check):
            raise TypeError("arm_gate_module must have a callable check_order_policy")
        if not isinstance(env, Mapping) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in env.items()
        ):
            raise TypeError("env must map text to text")
        if not callable(con_id_of) or (clock is not None and not callable(clock)):
            raise TypeError("con_id_of and clock must be callable")
        try:
            parameters = inspect.signature(check).parameters.values()
        except (TypeError, ValueError):
            parameters = ()
        self._takes_legs = any(
            parameter.name == "legs" or parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters
        )
        self._check = check
        self._env = dict(env)
        self._con_id_of = con_id_of
        self._clock = clock
        self._name = str(getattr(arm_gate_module, "ORDER_POLICY", "unnamed order policy"))[:64]

    @property
    def passes_legs(self) -> bool:
        """The injected policy takes ``legs`` (policy v3 and later)."""

        return self._takes_legs

    def __call__(self, order: ComboOrder) -> PolicyDecision:
        if not isinstance(order, ComboOrder):
            raise TypeError("order must be a ComboOrder")
        contract, ib_order, legs = ibkr_shapes(order, self._con_id_of)
        arguments: dict[str, Any] = {
            "order_id": None,
            "client": None,
            "env": dict(self._env),
            "now": None if self._clock is None else self._clock(),
        }
        if self._takes_legs:
            arguments["legs"] = legs
        try:
            allowance = self._check(contract, ib_order, **arguments)
        except Exception as error:  # every failure of the policy is a refusal
            code, detail = getattr(error, "code", None), getattr(error, "detail", None)
            if isinstance(code, str) and code.strip() and isinstance(detail, str):
                return PolicyDecision(False, code, detail[:_DETAIL_LIMIT])
            return PolicyDecision(False, "policy_error", f"{type(error).__name__}: {error}"[:_DETAIL_LIMIT])
        if not isinstance(allowance, str) or not allowance.strip():
            return PolicyDecision(
                False, "policy_result_invalid", f"{self._name} returned {type(allowance).__name__}, not an allowance"
            )
        return PolicyDecision(True, allowance, f"allowed by {self._name}")
