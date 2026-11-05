"""Cost profiles for the backtest: port of packages/api/src/backtest-costs.ts.

Profiles are plain dicts with the TypeScript camelCase keys (they arrive as JSON). Every formula
keeps the TypeScript operation order, so results are the same IEEE doubles. Research only; nothing
here creates or routes an order.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

BPS = 10_000
PERCENT = 100
DAYS_PER_YEAR = 360
# Bisection steps that size an entry so that value plus costs fit the cash.
SIZING_ITERATIONS = 100

Side = Literal["buy", "sell"]
Profile = Mapping[str, Any]

_NO_COMMISSION: dict[str, Any] = {
    "maxPercentOfValue": None,
    "maxPerOrder": None,
    "minPerOrder": 0,
    "perContract": 0,
    "percentOfValue": 0,
    "perShare": 0,
    "premiumTiers": [],
}
_NO_FEES: dict[str, Any] = {"ofCommission": 0, "ofSaleValue": 0, "perUnit": 0}

_IBKR_STOCKS_URL = "https://www.interactivebrokers.com/en/pricing/commissions-stocks.php (read 2026-10-23)"
_IBKR_OPTIONS_URL = "https://www.interactivebrokers.com/en/pricing/commissions-options.php (read 2026-10-23)"
_SEC_FEE_RATE = 0.000_020_6
_CAT_FEE_PER_SHARE = 0.000_003
_CAT_FEE_PER_CONTRACT = 0.0003

ZERO_COST_PROFILE: dict[str, Any] = {
    "borrowFeeAnnualPct": 0,
    "commission": _NO_COMMISSION,
    "fees": _NO_FEES,
    "id": "zero",
    "instrument": "stock",
    "label": "No costs",
    "multiplier": 1,
    "slippage": {"bps": 0, "kind": "bps"},
    "source": "custom",
    "spreadBps": 0,
}

# Presets. Spread, slippage and borrow are 0: they depend on the instrument, not the broker.
COST_PROFILE_PRESETS: dict[str, dict[str, Any]] = {
    "ibkr-pro-fixed-us-stock": {
        **ZERO_COST_PROFILE,
        "commission": {
            **_NO_COMMISSION,
            "maxPercentOfValue": 1,
            "minPerOrder": 1,
            "perShare": 0.005,
        },
        "fees": {
            **_NO_FEES,
            "ofSaleValue": _SEC_FEE_RATE,
            "perUnit": _CAT_FEE_PER_SHARE,
        },
        "id": "ibkr-pro-fixed-us-stock",
        "label": "IBKR Pro Fixed, US stocks",
        "source": _IBKR_STOCKS_URL,
    },
    "ibkr-pro-tiered-us-stock": {
        **ZERO_COST_PROFILE,
        "commission": {
            **_NO_COMMISSION,
            "maxPercentOfValue": 1,
            "minPerOrder": 0.35,
            "perShare": 0.0035,
        },
        # Clearing USD 0.0002 + CAT 0.000003 per share; NYSE 0.000175 + FINRA 0.000565 pass-through.
        "fees": {
            "ofCommission": 0.000_175 + 0.000_565,
            "ofSaleValue": _SEC_FEE_RATE,
            "perUnit": 0.0002 + _CAT_FEE_PER_SHARE,
        },
        "id": "ibkr-pro-tiered-us-stock",
        "label": "IBKR Pro Tiered (<= 300,000 shares/month), US stocks",
        "source": _IBKR_STOCKS_URL,
    },
    "ibkr-pro-us-option": {
        **ZERO_COST_PROFILE,
        "commission": {
            **_NO_COMMISSION,
            "minPerOrder": 1,
            "perContract": 0.65,
            "premiumTiers": [
                {"belowPremium": 0.05, "perContract": 0.25},
                {"belowPremium": 0.1, "perContract": 0.5},
            ],
        },
        # OCC clearing 0.025 + CAT 0.0003 per contract. Exchange fees and the ORF are excluded.
        "fees": {
            **_NO_FEES,
            "ofSaleValue": _SEC_FEE_RATE,
            "perUnit": 0.025 + _CAT_FEE_PER_CONTRACT,
        },
        "id": "ibkr-pro-us-option",
        "instrument": "option",
        "label": "IBKR Pro (<= 10,000 contracts/month), US options",
        "multiplier": 100,
        "source": _IBKR_OPTIONS_URL,
    },
    "zero": ZERO_COST_PROFILE,
}
# Callers get deep copies, so a caller can not change a shared nested dict by mistake.
COST_PROFILE_PRESETS = copy.deepcopy(COST_PROFILE_PRESETS)


@dataclass(frozen=True)
class FillCosts:
    """Fill price and the money costs of one order."""

    price: float
    spread: float
    slippage: float
    commission: float
    fees: float


def _option_rate(commission: Profile, premium: float) -> float:
    for tier in commission["premiumTiers"]:
        if premium < tier["belowPremium"]:
            return tier["perContract"]
    return commission["perContract"]


def order_charges(
    profile: Profile, side: Side, units: float, price: float
) -> tuple[float, float]:
    """Commission and fees of one order of `units` at `price`. 0 units cost nothing."""
    if units <= 0:
        return (0, 0)
    rule = profile["commission"]
    fees = profile["fees"]
    value = units * price
    option = profile["instrument"] == "option"
    count = units / profile["multiplier"] if option else units
    commission = (
        count * _option_rate(rule, price) if option else units * rule["perShare"]
    ) + (value * rule["percentOfValue"]) / PERCENT
    commission = _js_max(commission, rule["minPerOrder"])
    if rule["maxPerOrder"] is not None:
        commission = _js_min(commission, rule["maxPerOrder"])
    if rule["maxPercentOfValue"] is not None:
        commission = _js_min(commission, (value * rule["maxPercentOfValue"]) / PERCENT)
    sale_fee = value * fees["ofSaleValue"] if side == "sell" else 0
    return (
        commission,
        count * fees["perUnit"] + commission * fees["ofCommission"] + sale_fee,
    )


def _adverse_move(profile: Profile, price: float, atr: float) -> tuple[float, float]:
    """Price move per unit against the trader: (half the spread, slippage)."""
    spread = (price * profile["spreadBps"]) / BPS / 2
    slip = profile["slippage"]
    if slip["kind"] == "bps":
        slippage = (price * slip["bps"]) / BPS
    else:
        slippage = atr * slip["fraction"] if math.isfinite(atr) else 0
    return (spread, slippage)


def fill_costs(
    profile: Profile, side: Side, units: float, price: float, atr: float
) -> FillCosts:
    """Fill price and costs of one order at reference price `price`."""
    spread, slippage = _adverse_move(profile, price, atr)
    total = spread + slippage
    # A sell can not fill below zero; scale both parts down so that they add up to the move.
    scale = price / total if side == "sell" and total > price else 1
    fill = price + total if side == "buy" else price - total * scale
    commission, fees = order_charges(profile, side, units, fill)
    return FillCosts(
        price=fill,
        spread=units * spread * scale,
        slippage=units * slippage * scale,
        commission=commission,
        fees=fees,
    )


def affordable_units(
    profile: Profile, cash: float, fill: float, scale: float = 1.0
) -> float:
    """Largest buy quantity whose value plus commission and fees fits `cash` at `fill`.

    `scale` converts quantities and cash to money (the engine passes the capital). Returns 0 when
    the minimum charges alone exceed the cash. Same 100-step bisection as TypeScript.
    """
    every = _js_div(cash, fill)

    def charges_of(size: float) -> float:
        commission, fees = order_charges(profile, "buy", size * scale, fill)
        return (commission + fees) / scale

    # Without charges this is exact and matches the engine path without a profile.
    if charges_of(every) == 0:
        return every
    low = 0.0
    high = every
    for _ in range(SIZING_ITERATIONS):
        middle = (low + high) / 2
        if middle * fill + charges_of(middle) <= cash:
            low = middle
        else:
            high = middle
    return low


def borrow_fee(profile: Profile, value: float, days: float) -> float:
    """Borrow fee of a short position of `value` held for `days` calendar days."""
    return abs(value) * profile["borrowFeeAnnualPct"] * days / PERCENT / DAYS_PER_YEAR


def average_true_range(
    high: Sequence[float], low: Sequence[float], close: Sequence[float], period: int
) -> list[float]:
    """Simple average true range over `period` bars (backtest-costs.ts version, not Wilder)."""
    size = len(close)
    out = [math.nan] * size
    ranges = [0.0] * size
    total = 0.0
    for index in range(size):
        h = high[index]
        lo = low[index]
        if index > 0:
            previous = close[index - 1]
            value = _js_max(h - lo, abs(h - previous), abs(lo - previous))
        else:
            value = h - lo
        ranges[index] = value
        total += value
        if index >= period:
            total -= ranges[index - period]
        if index >= period - 1:
            out[index] = total / period
    return out


def _js_max(*values: float) -> float:
    """JS Math.max: NaN when any value is NaN."""
    result = -math.inf
    for value in values:
        if value != value:
            return math.nan
        if value > result:
            result = value
    return result


def _js_min(*values: float) -> float:
    """JS Math.min: NaN when any value is NaN."""
    result = math.inf
    for value in values:
        if value != value:
            return math.nan
        if value < result:
            result = value
    return result


def _js_div(numerator: float, denominator: float) -> float:
    """JS division: x / 0 is ±Infinity or NaN instead of an exception."""
    if denominator != 0:
        return numerator / denominator
    if numerator != numerator or numerator == 0:
        return math.nan
    sign = math.copysign(1.0, denominator) * math.copysign(1.0, numerator)
    return math.inf if sign > 0 else -math.inf
