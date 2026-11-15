"""Option chain summaries for openbb_option_iv_daily / openbb_option_iv_term (pure functions).

Inputs are Cboe delayed-quote contracts: OCC symbol, implied volatility (decimal), delta, gamma
(per 1 point of the underlying), open interest and volume.

- ATM IV per expiration: mean of call and put IV at the strike nearest spot that has both
  (else the nearest strike with any IV). Expirations on the snapshot date (0 DTE) are excluded.
- 30-day constant-maturity IV: linear interpolation of total variance (iv^2 * t) between the two
  expirations that bracket 30 calendar days; flat beyond the listed range. Expirations with
  dte < 1 are left out of the interpolation.
- 25-delta IV: per expiration, linear interpolation of IV in delta at +0.25 (calls) and -0.25
  (puts), then the same 30-day variance interpolation.
- Net GEX: sum of gamma * OI * 100 * S^2 * 0.01 (dollars per 1% move), calls positive, puts
  negative.
- Gamma flip: the strike where the cumulative (ascending strike) net GEX changes sign, nearest
  spot; null when it never changes sign.
- Call wall / put wall: strike with the largest call / put gamma * OI.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Any

from .values import count, num

OCC = re.compile(r"^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
TARGET_DAYS = 30
TARGET_DELTA = 0.25


@dataclass(frozen=True)
class Contract:
    expiration: date
    strike: float
    is_call: bool
    iv: float | None
    delta: float | None
    gamma: float | None
    open_interest: int
    volume: int


def parse_contracts(options: list[dict[str, Any]], as_of: date) -> tuple[list[Contract], int]:
    """Parse Cboe option rows; returns (contracts expiring on/after as_of, rows skipped)."""
    contracts: list[Contract] = []
    skipped = 0
    for option in options:
        match = OCC.fullmatch(str(option.get("option") or ""))
        if not match:
            skipped += 1
            continue
        try:
            expiration = date(2000 + int(match[2]), int(match[3]), int(match[4]))
        except ValueError:
            skipped += 1
            continue
        if expiration < as_of:
            continue
        iv = num(option.get("iv"))
        contracts.append(
            Contract(
                expiration=expiration,
                strike=int(match[6]) / 1000,
                is_call=match[5] == "C",
                iv=iv if iv is not None and iv > 0 else None,
                delta=num(option.get("delta")),
                gamma=num(option.get("gamma")),
                open_interest=count(option.get("open_interest")) or 0,
                volume=count(option.get("volume")) or 0,
            )
        )
    return contracts, skipped


def atm(contracts: list[Contract], spot: float) -> tuple[float | None, float | None]:
    """(ATM strike, ATM IV) of one expiration."""
    if not contracts:
        return None, None
    by_strike: dict[float, dict[bool, float]] = defaultdict(dict)
    for c in contracts:
        if c.iv is not None:
            by_strike[c.strike][c.is_call] = c.iv
    both = [k for k, sides in by_strike.items() if len(sides) == 2]
    if both:
        strike = min(both, key=lambda k: (abs(k - spot), k))
        return strike, (by_strike[strike][True] + by_strike[strike][False]) / 2
    if by_strike:
        strike = min(by_strike, key=lambda k: (abs(k - spot), k))
        sides = by_strike[strike]
        return strike, sum(sides.values()) / len(sides)
    strike = min({c.strike for c in contracts}, key=lambda k: (abs(k - spot), k))
    return strike, None


def iv_at_delta(contracts: list[Contract], target: float) -> float | None:
    """IV at `target` delta by linear interpolation in delta (None outside the quoted deltas)."""
    points = sorted(
        (c.delta, c.iv)
        for c in contracts
        if c.delta is not None and c.iv is not None and (0 < c.delta < 1 if target > 0 else -1 < c.delta < 0)
    )
    if not points:
        return None
    for d, iv in points:
        if d == target:
            return iv
    below = [p for p in points if p[0] < target]
    above = [p for p in points if p[0] > target]
    if not below or not above:
        return None
    (d1, iv1), (d2, iv2) = below[-1], above[0]
    return iv1 + (iv2 - iv1) * (target - d1) / (d2 - d1)


def constant_maturity(points: list[tuple[int, float | None]], target: int = TARGET_DAYS) -> float | None:
    """Variance-interpolated IV at `target` days from (dte, iv) points; flat outside the range."""
    clean = sorted((t, iv) for t, iv in points if t >= 1 and iv is not None and iv > 0)
    if not clean:
        return None
    for t, iv in clean:
        if t == target:
            return iv
    lower = [p for p in clean if p[0] < target]
    upper = [p for p in clean if p[0] > target]
    if not lower:
        return upper[0][1]
    if not upper:
        return lower[-1][1]
    (t1, iv1), (t2, iv2) = lower[-1], upper[0]
    w1, w2 = iv1 * iv1 * t1, iv2 * iv2 * t2
    w = w1 + (w2 - w1) * (target - t1) / (t2 - t1)
    if w <= 0:
        return None
    return math.sqrt(w / target)


def gex(contract: Contract, spot: float) -> float:
    if contract.gamma is None or contract.open_interest == 0:
        return 0.0
    value = contract.gamma * contract.open_interest * 100 * spot * spot * 0.01
    return value if contract.is_call else -value


def gamma_flip(per_strike: dict[float, float], spot: float) -> float | None:
    """Strike where cumulative net GEX (ascending strikes) changes sign, nearest spot."""
    total = 0.0
    previous_sign = 0
    flips: list[float] = []
    for strike in sorted(per_strike):
        total += per_strike[strike]
        sign = (total > 0) - (total < 0)
        if sign == 0:
            continue
        if previous_sign and sign != previous_sign:
            flips.append(strike)
        previous_sign = sign
    if not flips:
        return None
    return min(flips, key=lambda k: (abs(k - spot), k))


def wall(per_strike: dict[float, float]) -> float | None:
    positive = {k: v for k, v in per_strike.items() if v > 0}
    if not positive:
        return None
    return max(positive, key=lambda k: (positive[k], -k))


def summarize(underlying: str, as_of: date, spot: float, contracts: list[Contract]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (option_iv_daily row, option_iv_term rows) for one underlying snapshot.

    Contracts expiring on as_of itself (0 DTE) are left out of every figure: their gamma is about to
    vanish and dominates GEX, walls and the flip on expiration day; they get no term row.
    """
    contracts = [c for c in contracts if c.expiration > as_of]
    by_expiration: dict[date, list[Contract]] = defaultdict(list)
    for c in contracts:
        by_expiration[c.expiration].append(c)

    term_rows: list[dict[str, Any]] = []
    atm_points: list[tuple[int, float | None]] = []
    call_points: list[tuple[int, float | None]] = []
    put_points: list[tuple[int, float | None]] = []
    for expiration in sorted(by_expiration):
        chain = by_expiration[expiration]
        dte = (expiration - as_of).days
        strike, iv = atm(chain, spot)
        atm_points.append((dte, iv))
        call_points.append((dte, iv_at_delta([c for c in chain if c.is_call], TARGET_DELTA)))
        put_points.append((dte, iv_at_delta([c for c in chain if not c.is_call], -TARGET_DELTA)))
        term_rows.append(
            {
                "asOf": as_of.isoformat(),
                "atmIv": _r(iv, 6),
                "atmStrike": _r(strike, 4),
                "callOi": sum(c.open_interest for c in chain if c.is_call),
                "callVolume": sum(c.volume for c in chain if c.is_call),
                "dte": dte,
                "expiration": expiration.isoformat(),
                "putOi": sum(c.open_interest for c in chain if not c.is_call),
                "putVolume": sum(c.volume for c in chain if not c.is_call),
                "underlying": underlying,
            }
        )

    net_by_strike: dict[float, float] = defaultdict(float)
    call_gamma_oi: dict[float, float] = defaultdict(float)
    put_gamma_oi: dict[float, float] = defaultdict(float)
    has_gamma = False
    for c in contracts:
        if c.gamma is None:
            continue
        has_gamma = True
        net_by_strike[c.strike] += gex(c, spot)
        weight = c.gamma * c.open_interest
        if c.is_call:
            call_gamma_oi[c.strike] += weight
        else:
            put_gamma_oi[c.strike] += weight

    daily = {
        "asOf": as_of.isoformat(),
        "atmIv30d": _r(constant_maturity(atm_points), 6),
        "callIv25d30d": _r(constant_maturity(call_points), 6),
        "callOi": sum(c.open_interest for c in contracts if c.is_call),
        "callVolume": sum(c.volume for c in contracts if c.is_call),
        "callWall": _r(wall(call_gamma_oi), 4),
        "contracts": len(contracts),
        "gammaFlip": _r(gamma_flip(net_by_strike, spot), 4) if has_gamma else None,
        "netGex": _r(sum(net_by_strike.values()), 2) if has_gamma else None,
        "putIv25d30d": _r(constant_maturity(put_points), 6),
        "putOi": sum(c.open_interest for c in contracts if not c.is_call),
        "putVolume": sum(c.volume for c in contracts if not c.is_call),
        "putWall": _r(wall(put_gamma_oi), 4),
        "underlying": underlying,
        "underlyingPrice": _r(spot, 4),
    }
    return daily, term_rows


def _r(value: float | None, digits: int) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)
