"""The intraday-momentum rules as Vertex strategy DSL definitions (research only).

Pre-registered: docs/specs/strategies/market-intraday-momentum.md. Every strategy is a pair of legs
(a long and a short definition, `side: "short"` on the short leg) that share the intraday block; the
study runs each leg as its own Nautilus run on 100,000 USD and sums the two legs' daily returns. The
legs never hold at the same time (one entry signal per day for GHLZ and BIAS; ZAB enters only above the
upper or below the lower band, which cannot hold together), so the sum is the return of one account
holding whichever leg is open.

- GHLZ (Gao, Han, Li & Zhou 2018): at 15:30 New York long if the return from the previous close to the
  10:00 price is above 0, short if below; flat at 16:00 (market-on-close); 1x notional, no stop.
  Variant r1+r12: also the 15:00-15:30 return must have the same sign.
- ZAB (Zarattini, Aziz & Barbon 2024): at HH:00 / HH:30 from 10:00 to 15:30 long above the upper noise
  band (14 days), short below the lower; exit when the close crosses back through max(upper band, VWAP)
  (long) or min(lower band, VWAP) (short); flat at 16:00; volatility-target sizing 2 % / 14-day daily vol,
  at most 4x. Variant 1x: all-in notional.
- BIAS: a research-only signal (bias.py), executed with the GHLZ clock: these definitions supply the
  intraday block, side, costs and market-on-close exit; the entry signal is replaced by the bias vote.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from typing import Any

TIMEZONE = "America/New_York"
OPEN = "09:30"
CLOSE = "16:00"
SIDES = ("long", "short")


@dataclass(frozen=True)
class Ghlz:
    signal_from: str = "prevClose"  # prevClose | open
    signal_to: str = "10:00"
    entry: str = "15:30"
    threshold: float = 0.0  # |r1| must exceed this (fraction)
    r12: bool = False
    sides: tuple[str, ...] = SIDES

    family = "GHLZ"

    def label(self) -> str:
        return "ghlz:" + ",".join(f"{k}={v}" for k, v in asdict(self).items())


@dataclass(frozen=True)
class Zab:
    length: int = 14
    multiple: float = 1.0
    decision_every: int = 30
    entry_from: str = "10:00"
    entry_to: str = "15:30"
    vol_target: bool = True
    target_pct: float = 2.0
    vol_length: int = 14
    max_leverage: float = 4.0
    sides: tuple[str, ...] = SIDES

    family = "ZAB"

    def label(self) -> str:
        return "zab:" + ",".join(f"{k}={v}" for k, v in asdict(self).items())


@dataclass(frozen=True)
class Bias:
    decision: str = "15:30"
    threshold: float = 50.0
    sides: tuple[str, ...] = SIDES

    family = "BIAS"

    def label(self) -> str:
        return "bias:" + ",".join(f"{k}={v}" for k, v in asdict(self).items())


Params = Ghlz | Zab | Bias

GHLZ = Ghlz()
GHLZ_R1R12 = Ghlz(r12=True)
ZAB = Zab()
ZAB_1X = Zab(vol_target=False)
BIAS = Bias()
# The strategies of the study, in report order: (id, name, params).
STRATEGIES: tuple[tuple[str, str, Params], ...] = (
    ("ghlz", "GHLZ", GHLZ),
    ("ghlz-r1r12", "GHLZ r1+r12", GHLZ_R1R12),
    ("zab", "ZAB", ZAB),
    ("zab-1x", "ZAB 1x", ZAB_1X),
    ("bias", "BIAS", BIAS),
)


def _const(value: float) -> dict[str, Any]:
    return {"type": "const", "value": value}


def _close() -> dict[str, Any]:
    return {"type": "price", "field": "close"}


def _session_return(start: str, end: str) -> dict[str, Any]:
    return {"type": "indicator", "name": "sessionReturn", "from": start, "to": end}


def _band(band: str, params: Zab) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "indicator", "name": "noiseBand", "band": band, "length": params.length}
    if params.multiple != 1.0:
        out["multiple"] = params.multiple
    return out


def _intraday(entry_from: str, entry_to: str, decision_every: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"timezone": TIMEZONE, "open": OPEN, "close": CLOSE, "entryFrom": entry_from,
                           "entryTo": entry_to}
    if decision_every is not None:
        out["decisionEvery"] = decision_every
    return out


def ghlz_definition(params: Ghlz, side: str) -> dict[str, Any]:
    op = ">" if side == "long" else "<"
    bound = params.threshold if side == "long" else -params.threshold
    conditions = [{"left": _session_return(params.signal_from, params.signal_to), "op": op, "right": _const(bound)}]
    if params.r12:
        conditions.append({"left": _session_return("15:00", "15:30"), "op": op, "right": _const(0)})
    out: dict[str, Any] = {
        "version": 1,
        "name": f"GHLZ intraday momentum {side}" + (" r1+r12" if params.r12 else ""),
        "description": "Reel DffkN31PrN7; Gao, Han, Li & Zhou (2018). Research only.",
        "intraday": _intraday(params.entry, params.entry),
        "entry": {"all": conditions},
        "stopLoss": {"kind": "none"},
        "sizing": {"mode": "allIn"},
    }
    if side == "short":
        out["side"] = "short"
    return out


def zab_definition(params: Zab, side: str) -> dict[str, Any]:
    if side == "long":
        entry = [{"left": _close(), "op": ">", "right": _band("upper", params)}]
        exits = [{"left": _close(), "op": "<", "right": _band("upper", params)},
                 {"left": _close(), "op": "<", "right": {"type": "indicator", "name": "vwap"}}]
    else:
        entry = [{"left": _close(), "op": "<", "right": _band("lower", params)}]
        exits = [{"left": _close(), "op": ">", "right": _band("lower", params)},
                 {"left": _close(), "op": ">", "right": {"type": "indicator", "name": "vwap"}}]
    sizing: dict[str, Any] = (
        {"mode": "volTarget", "targetPct": params.target_pct, "length": params.vol_length,
         "maxLeverage": params.max_leverage}
        if params.vol_target else {"mode": "allIn"}
    )
    out: dict[str, Any] = {
        "version": 1,
        "name": f"ZAB noise-area {side}" + ("" if params.vol_target else " 1x"),
        "description": "Zarattini, Aziz & Barbon (2024) Beat the Market. Research only.",
        "intraday": _intraday(params.entry_from, params.entry_to, params.decision_every),
        "entry": {"all": entry},
        "exit": {"any": exits},
        "stopLoss": {"kind": "none"},
        "sizing": sizing,
    }
    if side == "short":
        out["side"] = "short"
    return out


def bias_definition(params: Bias, side: str) -> dict[str, Any]:
    """The execution shell of the BIAS signal: GHLZ clock at the decision time; the entry condition is a
    placeholder that bias.py replaces with the vote."""
    out = ghlz_definition(Ghlz(entry=params.decision), side)
    out["name"] = f"BIAS bias-tracker {side} (signal replaced by the research vote)"
    out["description"] = "Reel DffkN31PrN7 8-factor bias reconstruction. Research only."
    return out


def definition(params: Params, side: str) -> dict[str, Any]:
    if side not in SIDES:
        raise ValueError(f"Unknown side {side}")
    if isinstance(params, Ghlz):
        return ghlz_definition(params, side)
    if isinstance(params, Zab):
        return zab_definition(params, side)
    return bias_definition(params, side)


def legs(params: Params) -> list[tuple[str, dict[str, Any]]]:
    return [(side, definition(params, side)) for side in params.sides]


def params_to_json(params: Params) -> dict[str, Any]:
    return {"family": params.family, **asdict(params)}


def params_from_json(data: dict[str, Any]) -> Params:
    fields = dict(data)
    family = fields.pop("family")
    fields["sides"] = tuple(fields["sides"])
    return {"GHLZ": Ghlz, "ZAB": Zab, "BIAS": Bias}[family](**fields)


# One-at-a-time sensitivity (each row changes one parameter of the stated rules).
GHLZ_SENSITIVITY: tuple[tuple[str, str, Ghlz], ...] = (
    ("signal end", "10:30", replace(GHLZ, signal_to="10:30")),
    ("signal end", "11:00", replace(GHLZ, signal_to="11:00")),
    ("entry time", "15:00", replace(GHLZ, entry="15:00")),
    ("entry time", "15:45", replace(GHLZ, entry="15:45")),
    ("|r1| threshold", "0.1 %", replace(GHLZ, threshold=0.001)),
    ("|r1| threshold", "0.25 %", replace(GHLZ, threshold=0.0025)),
    ("sides", "long only", replace(GHLZ, sides=("long",))),
    ("sides", "short only", replace(GHLZ, sides=("short",))),
    ("r1 anchor", "open (overnight excluded)", replace(GHLZ, signal_from="open")),
)
ZAB_SENSITIVITY: tuple[tuple[str, str, Zab], ...] = (
    ("band length", "10", replace(ZAB, length=10)),
    ("band length", "20", replace(ZAB, length=20)),
    ("band multiple", "0.8", replace(ZAB, multiple=0.8)),
    ("band multiple", "1.2", replace(ZAB, multiple=1.2)),
    ("decision every", "15 min", replace(ZAB, decision_every=15)),
    ("decision every", "60 min", replace(ZAB, decision_every=60)),
    ("sizing", "1x (no vol target)", ZAB_1X),
)
BIAS_SENSITIVITY: tuple[tuple[str, str, Bias], ...] = (
    ("threshold", "25", replace(BIAS, threshold=25.0)),
    ("threshold", "75", replace(BIAS, threshold=75.0)),
    ("decision time", "10:30", replace(BIAS, decision="10:30")),
    ("decision time", "12:00", replace(BIAS, decision="12:00")),
)
# Walk-forward candidates (3 y train / 1 y test, best Sharpe): GHLZ signal end x entry time.
WALK_FORWARD_GRID: tuple[Ghlz, ...] = tuple(
    replace(GHLZ, signal_to=end, entry=entry)
    for end in ("10:00", "10:30", "11:00")
    for entry in ("15:00", "15:30", "15:45")
)


def all_definitions() -> dict[str, Any]:
    """Every stated strategy as DSL legs (for `python -m strategies.imom definition`)."""
    return {sid: {"name": name, "params": params_to_json(params), "legs": dict(legs(params))}
            for sid, name, params in STRATEGIES}
