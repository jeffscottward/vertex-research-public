"""Trend Trio as Vertex strategy DSL definitions (study-only; research only; never in STRATEGY_TEMPLATES).

Spec: docs/specs/strategies/trend-trio.md ("DSL definition"). The DSL enters whenever the book is flat and the
condition holds, so these definitions equal variant V1 (re-entry), not P1. The names `supertrend`, `alphaTrend`,
`chandelierExit` and the intraday indicator timeframes "5m" / "15m" come from the DSL change (design PR 2,
docs/specs/strategies/trend-trio-design.md items 14-19); the engines run them only with the `intradayIndicators`
support (research runs; the server paths refuse them). Ultimate MA (default SMA type) and Slingshot are written with
the existing `sma` / `ema` and `offset`. tests/test_trend_trio_dsl.py checks that the long and short definitions
decide on the same bars as rules.trades with Params(entry="reentry"). One difference remains on early-close days:
V1 stops entries 10 minutes before the early close, the DSL entryTo is a fixed 15:50 New York. The DSL `ema`
(x - value step) and indicators.trend `ema` (Slingshot; weighted sum) round differently, which can flip the
filter only when the two averages are equal to within rounding.
"""
from __future__ import annotations

from typing import Any

TIMEZONE = "America/New_York"
SIDES = ("long", "short")


def _ind(name: str, **fields: Any) -> dict[str, Any]:
    return {"type": "indicator", "name": name, **fields}


def _const(value: float) -> dict[str, Any]:
    return {"type": "const", "value": value}


def definition(side: str, timeframe: str = "5m") -> dict[str, Any]:
    """The long or short Trend Trio definition with signal indicators on `timeframe` buckets."""
    if side not in SIDES:
        raise ValueError("side must be long or short")
    up = side == "long"
    into, against = (">", "<") if up else ("<", ">")
    ce = _ind("chandelierExit", length=22, multiple=3.0, output="direction", offset=0)
    uma = _ind("sma", length=20, source="close", offset=0, timeframe=timeframe)
    uma_back = _ind("sma", length=20, source="close", offset=2, timeframe=timeframe)
    entry = [
        {"left": _ind("supertrend", length=10, multiple=3.0, output="direction", offset=0, timeframe=timeframe),
         "op": into, "right": _const(0)},
        {"left": uma, "op": ">=" if up else "<", "right": uma_back},
        {"left": _ind("alphaTrend", length=14, multiple=1.0, momentum="mfi", output="direction", offset=0,
                      timeframe=timeframe), "op": into, "right": _const(0)},
        {"left": _ind("ema", length=38, source="close", offset=0, timeframe=timeframe), "op": into,
         "right": _ind("ema", length=62, source="close", offset=0, timeframe=timeframe)},
        {"left": ce, "op": into, "right": _const(0)},
    ]
    out: dict[str, Any] = {
        "version": 1,
        "name": f"Trend Trio (Vertex reconstruction) {side}",
        "intraday": {"timezone": TIMEZONE, "open": "09:30", "close": "16:00", "entryFrom": "09:35",
                     "entryTo": "15:50"},
        "entry": {"all": entry},
        "exit": {"any": [{"left": ce, "op": against, "right": _const(0)}]},
        "stopLoss": {"kind": "none"},
        "sizing": {"mode": "allIn"},
    }
    if not up:
        out["side"] = "short"
    return out
