"""Black-Scholes option model and cost model of the qc-ports options runner (research only).

Model (assumptions, not market data; there is no option chain in the public data):
- European Black-Scholes-Merton with continuous dividend yield q per symbol and
  the risk-free rate r from IRX (13-week T-bill, percent / 100). Time in
  calendar days / 365.
- ATM implied vol = factor * IV index / 100: factor 0.9 for VIX, VIX3M, VXN, VXD
  and RVX, 0.95 for GVZ, OVX and VXSLV (the indices sit above ATM vol by a
  variance risk premium / convexity term).
- IV term structure (two-expiry structures): the ATM vol of each index at its
  tenor (VIX 30 days, VIX3M 93 days); between two tenors the total variance
  ATM^2 * T is linear in T, outside them the ATM vol of the nearest tenor holds.
- Skew: IV(K) = ATM * max(SKEW_FLOOR, 1 + slope * x) with standardized
  moneyness x = ln(K/S) / (ATM * sqrt(T)), clamped to [-3, 3]. Negative slope =
  equity put skew, positive = commodity call skew.
- Strike grid: step 1 when spot >= 25, else 0.5.
- Costs per leg and side: $0.65 commission per contract plus half the bid/ask
  spread, half-spread = max(0.01, pct * mid) per share (100 shares a contract).
"""
from __future__ import annotations

import math
from bisect import bisect_left
from collections.abc import Sequence

__all__ = [
    "ATM_FACTOR", "COMMISSION", "DIVIDEND_YIELD", "HALF_SPREAD_PCT", "MULTIPLIER", "SKEW", "SKEW_FLOOR",
    "atm_iv", "bs_delta", "bs_price", "half_spread", "intrinsic", "leg_cost", "norm_cdf", "smile_iv", "strike_step",
    "term_atm_iv",
]

MULTIPLIER = 100
COMMISSION = 0.65
MIN_HALF_SPREAD = 0.01
ATM_FACTOR = {"VIX": 0.9, "VIX3M": 0.9, "VXN": 0.9, "VXD": 0.9, "RVX": 0.9, "GVZ": 0.95, "OVX": 0.95,
              "VXSLV": 0.95}
HALF_SPREAD_PCT = {"SPY": 0.01, "QQQ": 0.015, "IWM": 0.02, "DIA": 0.03, "GLD": 0.025, "SLV": 0.04, "USO": 0.04}
DIVIDEND_YIELD = {"SPY": 0.015, "QQQ": 0.007, "DIA": 0.018, "IWM": 0.012}
# IV change per standardized-moneyness unit, relative to ATM (model assumption).
SKEW = {"SPY": -0.30, "QQQ": -0.25, "DIA": -0.30, "IWM": -0.22, "GLD": 0.05, "SLV": 0.05, "USO": -0.10}
SKEW_FLOOR = 0.5
SKEW_CLAMP = 3.0


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def _d1_d2(spot: float, strike: float, t: float, r: float, q: float, sigma: float) -> tuple[float, float]:
    root = sigma * math.sqrt(t)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / root
    return d1, d1 - root


def _finite(**values: float) -> None:
    for name, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number")


def _check(right: str, spot: float, strike: float, sigma: float, t: float = 0.0, r: float = 0.0,
           q: float = 0.0) -> None:
    """Refuses NaN, infinities and out-of-range inputs (spot, strike, sigma > 0; t, r, q >= 0)."""
    if right not in ("call", "put"):
        raise ValueError("right must be call or put")
    _finite(spot=spot, strike=strike, sigma=sigma, t=t, r=r, q=q)
    if not (spot > 0 and strike > 0):
        raise ValueError("spot and strike must be above 0")
    if not sigma > 0:
        raise ValueError("sigma must be above 0")
    if t < 0 or r < 0 or q < 0:
        raise ValueError("t, r and q must not be negative")


def bs_price(right: str, spot: float, strike: float, t: float, r: float, q: float, sigma: float) -> float:
    """Black-Scholes-Merton price per share; intrinsic value at t = 0."""
    _check(right, spot, strike, sigma, t, r, q)
    if t == 0:
        return max(0.0, spot - strike) if right == "call" else max(0.0, strike - spot)
    d1, d2 = _d1_d2(spot, strike, t, r, q, sigma)
    growth, discount = math.exp(-q * t), math.exp(-r * t)
    if right == "call":
        return spot * growth * norm_cdf(d1) - strike * discount * norm_cdf(d2)
    return strike * discount * norm_cdf(-d2) - spot * growth * norm_cdf(-d1)


def bs_delta(right: str, spot: float, strike: float, t: float, r: float, q: float, sigma: float) -> float:
    """Spot delta (call in [0, 1], put in [-1, 0])."""
    _check(right, spot, strike, sigma, t, r, q)
    if t == 0:
        if right == "call":
            return 1.0 if spot > strike else 0.0
        return -1.0 if spot < strike else 0.0
    d1, _ = _d1_d2(spot, strike, t, r, q, sigma)
    growth = math.exp(-q * t)
    return growth * norm_cdf(d1) if right == "call" else -growth * norm_cdf(-d1)


def atm_iv(index_id: str, level: float) -> float:
    """ATM implied vol (fraction) from an IV index level in percent."""
    if index_id not in ATM_FACTOR:
        raise ValueError(f"No ATM factor for {index_id}")
    _finite(level=level)
    if not level > 0:
        raise ValueError("IV index level must be above 0")
    return ATM_FACTOR[index_id] * level / 100


def smile_iv(atm: float, spot: float, strike: float, t: float, slope: float) -> float:
    """IV at `strike`: ATM scaled by the linear skew in standardized moneyness (floored, clamped)."""
    _finite(atm=atm, spot=spot, strike=strike, t=t, slope=slope)
    if not atm > 0:
        raise ValueError("ATM IV must be above 0")
    if t <= 0 or slope == 0:
        return atm
    x = math.log(strike / spot) / (atm * math.sqrt(t))
    x = max(-SKEW_CLAMP, min(SKEW_CLAMP, x))
    return atm * max(SKEW_FLOOR, 1 + slope * x)


def term_atm_iv(points: Sequence[tuple[float, float]], days: float) -> float:
    """ATM IV at `days` to expiry from (tenor days, ATM IV) points: linear in total variance between two tenors,
    the ATM IV of the nearest tenor outside them."""
    if not points:
        raise ValueError("an IV term needs at least one point")
    for tenor, atm in points:
        _finite(tenor=tenor, atm=atm)
        if not (tenor > 0 and atm > 0):
            raise ValueError("IV term tenors and ATM IVs must be above 0")
    _finite(days=days)
    ordered = sorted(points)
    if len({tenor for tenor, _ in ordered}) != len(ordered):
        raise ValueError("IV term tenors must differ")
    if days <= ordered[0][0]:
        return ordered[0][1]
    if days >= ordered[-1][0]:
        return ordered[-1][1]
    above = bisect_left([tenor for tenor, _ in ordered], days)
    (t1, v1), (t2, v2) = ordered[above - 1], ordered[above]
    total = v1 * v1 * t1 + (v2 * v2 * t2 - v1 * v1 * t1) * (days - t1) / (t2 - t1)
    return math.sqrt(total / days)


def intrinsic(right: str, spot: float, strike: float) -> float:
    """Exercise value per share."""
    return max(0.0, spot - strike) if right == "call" else max(0.0, strike - spot)


def strike_step(spot: float) -> float:
    return 1.0 if spot >= 25 else 0.5


def half_spread(symbol: str, mid: float) -> float:
    """Half the bid/ask spread per share of one option at `mid`."""
    if symbol not in HALF_SPREAD_PCT:
        raise ValueError(f"No spread model for {symbol}")
    _finite(mid=mid)
    if mid < 0:
        raise ValueError("mid must not be negative")
    return max(MIN_HALF_SPREAD, HALF_SPREAD_PCT[symbol] * mid)


def leg_cost(symbol: str, mid: float) -> float:
    """Cost in $ per contract of trading one leg once: commission + half-spread * 100."""
    return COMMISSION + MULTIPLIER * half_spread(symbol, mid)
