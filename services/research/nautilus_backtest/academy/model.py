"""Options math and structures of the Academy backtest (port of packages/academy/src).

Ports `math.ts` (normal distribution, Black-Scholes price and delta, strike by delta, realized
volatility), `structures.ts` (the 19 structures, rule defaults, `resolveRules`, `structureLegs`) and
the part of `position.ts` that sizing needs (`payoffSummary`). TypeScript is the reference:
`tests/test_nautilus_backtest_academy.py` compares this port with its golden results (written by
scripts/research-academy-golden.ts). Pure functions: no network, no orders.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal

from ..bars import InputError

__all__ = [
    "COMMON_RULES", "CONTRACT_MULTIPLIER", "DAYS_PER_YEAR", "STRUCTURES", "Leg", "LegRule", "Structure",
    "black_scholes_delta", "black_scholes_price", "js_number", "norm_cdf", "payoff_max_loss", "realized_vol",
    "resolve_rules", "strike_for_delta", "structure_legs",
]

DAYS_PER_YEAR = 365
CONTRACT_MULTIPLIER = 100
_SQRT_2PI = math.sqrt(2 * math.pi)
_BISECTION_STEPS = 80
_PAYOFF_STEPS = 1600
_SLOPE_EPS = 1e-6
_JS_POSITIONAL_FROM = 1e-6
_JS_EXPONENT_FROM = 1e21


def js_number(value: float) -> str:
    """A finite number as JavaScript prints it in a template string (labels and assumption texts)."""
    number = float(value)
    if number == 0:
        return "0"
    if number.is_integer() and abs(number) < _JS_EXPONENT_FROM:
        return str(int(number))
    # Both languages print the shortest digits that round-trip; only the notation differs:
    # JavaScript is positional from 1e-6 up to 1e21, Python's repr from 1e-4 up to 1e16.
    digits = Decimal(repr(number))
    if _JS_POSITIONAL_FROM <= abs(number) < _JS_EXPONENT_FROM:
        return format(digits, "f")
    mantissa, _, exponent = f"{digits:e}".partition("e")
    if "." in mantissa:
        mantissa = mantissa.rstrip("0").rstrip(".")
    return f"{mantissa}e{'+' if int(exponent) >= 0 else '-'}{abs(int(exponent))}"


def js_round(value: float) -> float:
    """Math.round: halves go up (Python's round goes to the even neighbour)."""
    return float(math.floor(value + 0.5))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / _SQRT_2PI


def norm_cdf(x: float) -> float:
    """Standard normal cumulative distribution (Hart 1968 / West 2005), as `normCdf`."""
    z = abs(x)
    if z > 37:
        c = 0.0
    else:
        e = math.exp(-0.5 * z * z)
        if z < 7.07106781186547:
            n = 3.52624965998911e-2 * z + 0.700383064443688
            n = n * z + 6.37396220353165
            n = n * z + 33.912866078383
            n = n * z + 112.079291497871
            n = n * z + 221.213596169931
            n = n * z + 220.206867912376
            d = 8.83883476483184e-2 * z + 1.75566716318264
            d = d * z + 16.064177579207
            d = d * z + 86.7807322029461
            d = d * z + 296.564248779674
            d = d * z + 637.333633378831
            d = d * z + 793.826512519948
            d = d * z + 440.413735824752
            c = (e * n) / d
        else:
            f = z + 0.65
            f = z + 4 / f
            f = z + 3 / f
            f = z + 2 / f
            f = z + 1 / f
            c = e / f / 2.506628274631
    return c if x <= 0 else 1 - c


def _d1(spot: float, strike: float, years: float, rate: float, vol: float) -> tuple[float, float]:
    sqrt_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * sqrt_t)
    return d1, d1 - vol * sqrt_t


def black_scholes_price(kind: str, spot: float, strike: float, years: float, rate: float, vol: float) -> float:
    """`blackScholes(...).price`: years <= 0 or spot <= 0 gives the intrinsic value."""
    vol = max(vol, 1e-6)
    if years <= 0 or spot <= 0:
        return max(spot - strike, 0.0) if kind == "call" else max(strike - spot, 0.0)
    d1, d2 = _d1(spot, strike, years, rate, vol)
    discount = math.exp(-rate * years)
    if kind == "call":
        return spot * norm_cdf(d1) - strike * discount * norm_cdf(d2)
    return strike * discount * norm_cdf(-d2) - spot * norm_cdf(-d1)


def black_scholes_delta(kind: str, spot: float, strike: float, years: float, rate: float, vol: float) -> float:
    """`blackScholes(...).delta`."""
    vol = max(vol, 1e-6)
    if years <= 0 or spot <= 0:
        itm = spot > strike if kind == "call" else spot < strike
        if not itm:
            return 0.0
        return 1.0 if kind == "call" else -1.0
    d1, _ = _d1(spot, strike, years, rate, vol)
    return norm_cdf(d1) if kind == "call" else norm_cdf(d1) - 1


def strike_for_delta(kind: str, target: float, spot: float, years: float, rate: float, vol: float) -> float:
    """Strike whose delta equals `target` (bisection, 80 steps), as `strikeForDelta`."""
    low = spot * 0.2
    high = spot * 5
    for _ in range(_BISECTION_STEPS):
        mid = (low + high) / 2
        if black_scholes_delta(kind, spot, mid, years, rate, vol) > target:
            low = mid
        else:
            high = mid
    return (low + high) / 2


def realized_vol(closes, end: int, window: int, periods_per_year: int = 252) -> float | None:
    """Annualized close-to-close realized volatility over the window ending at `end`, as `realizedVol`."""
    if end - window < 0:
        return None
    total = 0.0
    squares = 0.0
    for index in range(end - window + 1, end + 1):
        previous = closes[index - 1]
        current = closes[index]
        if previous <= 0 or current <= 0:
            return None
        change = math.log(current / previous)
        total += change
        squares += change * change
    # The backtest calls this with window >= 1 (bar 20 on); TS divides by zero to NaN for window 0.
    mean = total / window
    variance = max(squares / window - mean * mean, 0.0) * (window / max(window - 1, 1))
    return math.sqrt(variance * periods_per_year)


# ---------------------------------------------------------------- structures (port of structures.ts)

@dataclass(frozen=True)
class LegRule:
    kind: str  # "call" | "put" | "stock"
    side: str  # "long" | "short"
    qty: int
    role: str  # "core" | "cycle"
    delta: str | None = None
    dte: str | None = None


@dataclass(frozen=True)
class Structure:
    id: str
    legs: tuple[LegRule, ...]
    defaults: dict
    uses_shares: bool

    def has_role(self, role: str) -> bool:
        return any(leg.role == role for leg in self.legs)


@dataclass(frozen=True)
class Leg:
    """A priced leg (`ResolvedLeg` plus the role). `dte` is math.inf for stock."""

    kind: str
    side: str
    qty: int
    strike: float
    dte: float
    vol: float
    entry: float
    role: str


COMMON_RULES = {
    "profitTakePct": 50, "stopLossPct": 100, "exitDte": 7, "riskPct": 10, "ivMult": 1.1,
    "costPerContract": 0.65, "slippagePct": 2, "slipCap": 0.1,
}


def _call(side: str, delta: str, role: str = "cycle", dte: str = "dte", qty: int = 1) -> LegRule:
    return LegRule("call", side, qty, role, delta, dte)


def _put(side: str, delta: str, role: str = "cycle", dte: str = "dte", qty: int = 1) -> LegRule:
    return LegRule("put", side, qty, role, delta, dte)


_STOCK = LegRule("stock", "long", 1, "core")


def _def(structure_id: str, legs: list[LegRule], defaults: dict) -> Structure:
    return Structure(structure_id, tuple(legs), {**COMMON_RULES, **defaults},
                     any(leg.kind == "stock" for leg in legs))


# Same order and values as STRUCTURE_DEFS; the key order of `defaults` is the order of the result's rules.
STRUCTURES: dict[str, Structure] = {item.id: item for item in (
    _def("long_call", [_call("long", "longDelta")],
         {"dte": 60, "longDelta": 0.5, "exitDte": 21, "stopLossPct": 50, "profitTakePct": 100}),
    _def("long_put", [_put("long", "longDelta")],
         {"dte": 60, "longDelta": -0.5, "exitDte": 21, "stopLossPct": 50, "profitTakePct": 100}),
    _def("call_debit_spread", [_call("long", "longDelta"), _call("short", "shortDelta")],
         {"dte": 45, "longDelta": 0.65, "shortDelta": 0.35, "exitDte": 10, "profitTakePct": 60, "stopLossPct": 50}),
    _def("put_debit_spread", [_put("long", "longDelta"), _put("short", "shortDelta")],
         {"dte": 45, "longDelta": -0.65, "shortDelta": -0.35, "exitDte": 10, "profitTakePct": 60,
          "stopLossPct": 50}),
    _def("put_credit_spread", [_put("short", "shortDelta"), _put("long", "longDelta")],
         {"dte": 45, "shortDelta": -0.3, "longDelta": -0.15, "exitDte": 14, "profitTakePct": 50,
          "stopLossPct": 200}),
    _def("call_credit_spread", [_call("short", "shortDelta"), _call("long", "longDelta")],
         {"dte": 45, "shortDelta": 0.3, "longDelta": 0.15, "exitDte": 14, "profitTakePct": 50, "stopLossPct": 200}),
    _def("iron_condor",
         [_put("long", "longPutDelta"), _put("short", "shortPutDelta"), _call("short", "shortCallDelta"),
          _call("long", "longCallDelta")],
         {"dte": 45, "shortPutDelta": -0.16, "longPutDelta": -0.08, "shortCallDelta": 0.16, "longCallDelta": 0.08,
          "exitDte": 14, "profitTakePct": 50, "stopLossPct": 200}),
    _def("iron_butterfly",
         [_put("long", "wingPutDelta"), _put("short", "atmPut"), _call("short", "atmCall"),
          _call("long", "wingCallDelta")],
         {"dte": 30, "atmPut": -0.5, "atmCall": 0.5, "wingPutDelta": -0.15, "wingCallDelta": 0.15, "exitDte": 7,
          "profitTakePct": 25, "stopLossPct": 100}),
    _def("long_straddle", [_call("long", "callDelta"), _put("long", "putDelta")],
         {"dte": 45, "callDelta": 0.5, "putDelta": -0.5, "exitDte": 14, "profitTakePct": 50, "stopLossPct": 40}),
    _def("short_strangle", [_put("short", "shortPutDelta"), _call("short", "shortCallDelta")],
         {"dte": 45, "shortPutDelta": -0.16, "shortCallDelta": 0.16, "exitDte": 21, "profitTakePct": 50,
          "stopLossPct": 200, "riskPct": 5}),
    _def("covered_call", [_STOCK, _call("short", "shortDelta")],
         {"dte": 30, "shortDelta": 0.3, "exitDte": 0, "profitTakePct": 80, "stopLossPct": 1000}),
    _def("cash_secured_put", [_put("short", "shortDelta")],
         {"dte": 30, "shortDelta": -0.3, "exitDte": 0, "profitTakePct": 80, "stopLossPct": 1000}),
    _def("collar", [_STOCK, _put("long", "putDelta"), _call("short", "callDelta")],
         {"dte": 60, "putDelta": -0.25, "callDelta": 0.25, "exitDte": 0, "profitTakePct": 1000,
          "stopLossPct": 1000}),
    _def("protective_put", [_STOCK, _put("long", "putDelta")],
         {"dte": 90, "putDelta": -0.25, "exitDte": 21, "profitTakePct": 1000, "stopLossPct": 1000}),
    _def("pmcc", [_call("long", "coreDelta", "core", "coreDte"), _call("short", "shortDelta")],
         {"coreDte": 365, "coreDelta": 0.8, "coreExitDte": 120, "dte": 30, "shortDelta": 0.3, "exitDte": 0,
          "profitTakePct": 80, "stopLossPct": 1000}),
    _def("deep_itm_call", [_call("long", "coreDelta", "core", "coreDte")],
         {"coreDte": 180, "coreDelta": 0.85, "coreExitDte": 60, "profitTakePct": 1000, "stopLossPct": 1000,
          "riskPct": 30}),
    _def("synthetic_long", [_call("long", "atmCall"), _put("short", "atmPut")],
         {"dte": 60, "atmCall": 0.5, "atmPut": -0.5, "exitDte": 14, "profitTakePct": 1000, "stopLossPct": 1000,
          "riskPct": 5}),
    _def("ratio_call_spread", [_call("long", "longDelta"), _call("short", "shortDelta", "cycle", "dte", 2)],
         {"dte": 45, "longDelta": 0.5, "shortDelta": 0.25, "exitDte": 10, "profitTakePct": 80, "stopLossPct": 200,
          "riskPct": 5}),
    _def("calendar_call", [_call("long", "atmCall", "core", "coreDte"), _call("short", "atmCall")],
         {"coreDte": 60, "coreExitDte": 30, "dte": 30, "atmCall": 0.5, "exitDte": 0, "profitTakePct": 1000,
          "stopLossPct": 1000}),
)}


def structure_of(structure_id) -> Structure:
    structure = STRUCTURES.get(structure_id) if isinstance(structure_id, str) else None
    if structure is None:
        raise InputError(f"{structure_id} is not an Academy structure")
    return structure


def resolve_rules(structure_id: str, rules: dict | None) -> dict:
    """Structure defaults overlaid by `rules`; an unknown key or a non-finite value is an input error."""
    defaults = structure_of(structure_id).defaults
    resolved = dict(defaults)
    for key, value in (rules or {}).items():
        if key not in defaults:
            raise InputError(f"{key} is not a rule of {structure_id}")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise InputError(f"{key} must be a finite number")
        resolved[key] = value
    return resolved


def structure_legs(structure_id: str, rules: dict, spot: float, vol: float, rate: float,
                   roles: tuple[str, ...] = ("core", "cycle")) -> list[Leg]:
    """Prices a structure's legs at one market state, as `structureLegs`."""
    if spot >= 200:
        increment = 5.0
    elif spot >= 50:
        increment = 1.0
    else:
        increment = 0.5
    chosen = [leg for leg in STRUCTURES[structure_id].legs if leg.role in roles]
    plans = []
    for leg in chosen:
        dte = max(rules.get(leg.dte or "dte", 30), 1)
        target = rules.get(leg.delta or "", 0.5 if leg.kind == "call" else -0.5)
        plans.append({"leg": leg, "dte": dte, "target": target, "strike": 0.0})
    # The leg nearer the money keeps its strike; a wing that rounds onto a used strike moves outward.
    used: dict[tuple[str, float], list[float]] = {}
    for plan in sorted(plans, key=lambda item: -abs(item["target"])):
        leg = plan["leg"]
        if leg.kind == "stock":
            continue
        raw = strike_for_delta(leg.kind, plan["target"], spot, plan["dte"] / DAYS_PER_YEAR, rate, vol)
        strike = max(js_round(raw / increment) * increment, increment)
        taken = used.setdefault((leg.kind, plan["dte"]), [])
        outward = increment if leg.kind == "call" else -increment
        while strike in taken:
            strike += outward
        taken.append(strike)
        plan["strike"] = strike
    legs = []
    for plan in plans:
        leg = plan["leg"]
        if leg.kind == "stock":
            legs.append(Leg("stock", leg.side, leg.qty, 0.0, math.inf, vol, spot, leg.role))
            continue
        entry = black_scholes_price(leg.kind, spot, plan["strike"], plan["dte"] / DAYS_PER_YEAR, rate, vol)
        legs.append(Leg(leg.kind, leg.side, leg.qty, plan["strike"], plan["dte"], vol, entry, leg.role))
    return legs


def _position_pnl(legs: list[Leg], spot: float, elapsed: float, rate: float) -> float:
    """`positionAt(...).pnl` in dollars (every leg x100, stock included, as in position.ts)."""
    pnl = 0.0
    for leg in legs:
        if leg.kind == "stock":
            price = spot
        else:
            price = black_scholes_price(leg.kind, spot, leg.strike, max(leg.dte - elapsed, 0) / DAYS_PER_YEAR,
                                        rate, leg.vol)
        units = (1 if leg.side == "long" else -1) * leg.qty * CONTRACT_MULTIPLIER
        pnl += units * (price - leg.entry)
    return pnl


def payoff_max_loss(legs: list[Leg], spot: float, rate: float) -> float | None:
    """`payoffSummary(...).maxLoss`: the lowest P&L at the first expiry over 0..4x spot; None = unbounded."""
    horizons = [leg.dte for leg in legs if leg.kind != "stock"]
    elapsed = min(horizons) if horizons else 0
    top = spot * 4
    max_loss = math.inf
    for index in range(_PAYOFF_STEPS + 1):
        max_loss = min(max_loss, _position_pnl(legs, (top * index) / _PAYOFF_STEPS, elapsed, rate))
    far = _position_pnl(legs, top * 1.5, elapsed, rate)
    edge = _position_pnl(legs, top, elapsed, rate)
    return None if far - edge < -_SLOPE_EPS else max_loss
