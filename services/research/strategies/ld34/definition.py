"""LD34 as a Vertex strategy DSL definition (research only).

The reel's rules (docs/specs/strategies/ld34-nested-donchian-breakout.md):
an hourly close above one of the nested Donchian levels of the daily bars
(20 / 50 / 100 / 200-day highs and lows), each level fires once; market order
long; stop 2 x ATR(14); risk 1 % per trade; no target; from +1R a 2 x ATR trail
ratchets behind price; breakeven backstop at +2R; long only.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from typing import Any

NAME = "LD34 nested Donchian long-only breakout"


@dataclass(frozen=True)
class Params:
    lookbacks: tuple[int, ...] = (20, 50, 100, 200)
    stop_multiple: float = 2.0
    atr_length: int = 14
    trail_multiple: float = 2.0
    activate_r: float = 1.0
    breakeven_r: float | None = 2.0
    risk_pct: float = 1.0
    once_per_level: bool = True
    max_leverage: float = 20.0

    def label(self) -> str:
        return ",".join(f"{key}={value}" for key, value in asdict(self).items())


BASE = Params()


def _price(field: str) -> dict[str, Any]:
    return {"type": "price", "field": field}


def _level(name: str, length: int, source: str) -> dict[str, Any]:
    return {"type": "indicator", "name": name, "length": length, "source": source, "timeframe": "1d"}


def definition(params: Params = BASE) -> dict[str, Any]:
    """The DSL definition of one parameter set: one breaksAbove condition per ladder level."""
    levels = [_level("highest", n, "high") for n in params.lookbacks]
    levels += [_level("lowest", n, "low") for n in params.lookbacks]
    any_conditions = []
    for level in levels:
        condition: dict[str, Any] = {"left": _price("close"), "op": "breaksAbove", "right": level}
        if params.once_per_level:
            condition["oncePerLevel"] = True
        any_conditions.append(condition)
    management: dict[str, Any] = {
        "trail": {"activateR": params.activate_r, "length": params.atr_length, "multiple": params.trail_multiple},
    }
    if params.breakeven_r is not None:
        management["breakevenR"] = params.breakeven_r
    return {
        "version": 1,
        "name": NAME,
        "description": "Reel DffCOSDBMoC (hooper.algo.fxx). Research only.",
        "entry": {"all": [], "any": any_conditions},
        "stopLoss": {"kind": "atr", "length": params.atr_length, "multiple": params.stop_multiple},
        "management": management,
        "sizing": {"mode": "riskPct", "riskPct": params.risk_pct, "maxLeverage": params.max_leverage},
    }


def with_leverage(params: Params, max_leverage: float) -> Params:
    return replace(params, max_leverage=max_leverage)


# One-at-a-time sensitivity around the stated rules (each row changes one parameter).
SENSITIVITY: tuple[tuple[str, str, Params], ...] = (
    ("stop multiple", "1.5", replace(BASE, stop_multiple=1.5)),
    ("stop multiple", "2.5", replace(BASE, stop_multiple=2.5)),
    ("stop multiple", "3", replace(BASE, stop_multiple=3.0)),
    ("trail multiple", "1.5", replace(BASE, trail_multiple=1.5)),
    ("trail multiple", "2.5", replace(BASE, trail_multiple=2.5)),
    ("trail multiple", "3", replace(BASE, trail_multiple=3.0)),
    ("trail from", "+0.5R", replace(BASE, activate_r=0.5)),
    ("trail from", "+1.5R", replace(BASE, activate_r=1.5)),
    ("trail from", "+2R", replace(BASE, activate_r=2.0)),
    ("breakeven at", "+1R", replace(BASE, breakeven_r=1.0)),
    ("breakeven at", "+3R", replace(BASE, breakeven_r=3.0)),
    ("breakeven at", "off", replace(BASE, breakeven_r=None)),
    ("ATR length", "7", replace(BASE, atr_length=7)),
    ("ATR length", "28", replace(BASE, atr_length=28)),
    ("ladder", "20 only", replace(BASE, lookbacks=(20,))),
    ("ladder", "50/100/200", replace(BASE, lookbacks=(50, 100, 200))),
    ("ladder", "10/20/55", replace(BASE, lookbacks=(10, 20, 55))),
    ("each level fires once", "off", replace(BASE, once_per_level=False)),
)

# Walk-forward candidates: stop multiple x trail multiple.
WALK_FORWARD_GRID: tuple[Params, ...] = tuple(
    replace(BASE, stop_multiple=stop, trail_multiple=trail)
    for stop in (1.5, 2.0, 3.0)
    for trail in (1.5, 2.0, 3.0)
)
