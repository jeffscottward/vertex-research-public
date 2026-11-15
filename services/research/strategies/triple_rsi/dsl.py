"""The Triple RSI rule as a Vertex strategy DSL definition, version 1 (research only).

docs/vertex-rebuild/strategy-definitions.md: six entry conditions (all), one exit condition (any), allIn sizing,
no stop and no target. `offset` reads the series that many bars ago. The DSL engines (TypeScript and
NautilusTrader) fill at the next open; rules.py keeps the as-stated close execution. A test checks that the
compiled entry and exit bars of `definition()` are the bars of rules.signal_bars.

`python -m strategies.triple_rsi.dsl` (in services/research) prints the stated definition as JSON.
"""
from __future__ import annotations

import json
from typing import Any

from .rules import STATED, Params

__all__ = ["definition"]


def _rsi(length: int, offset: int = 0) -> dict[str, Any]:
    expr: dict[str, Any] = {"type": "indicator", "name": "rsi", "length": length}
    if offset:
        expr["offset"] = offset
    return expr


def _const(value: float) -> dict[str, Any]:
    return {"type": "const", "value": value}


def definition(params: Params = STATED) -> dict[str, Any]:
    """The DSL definition of `params` (Wilder RSI only: the DSL `rsi` is Wilder's)."""
    if params.rsi_kind != "wilder":
        raise ValueError("The DSL rsi is Wilder's; the Cutler variant has no DSL form")
    length, falls = params.length, params.falls
    if falls + 3 > 8:
        raise ValueError("The DSL allows 8 entry conditions")
    falling = [{"left": _rsi(length, day), "op": "<", "right": _rsi(length, day + 1)} for day in range(falls)]
    return {
        "version": 1,
        "name": "Triple RSI",
        "description": (f"Buy when RSI {length} is below {params.entry_below:g}, has fallen {falls} days in a row, "
                        f"was below {params.level_below:g} {falls} days ago and the close is above the "
                        f"{params.trend_length}-day average. Sell when RSI {length} crosses above "
                        f"{params.exit_above:g}. QuantifiedStrategies, research only."),
        "side": "long",
        "sizing": {"mode": "allIn"},
        "entry": {"all": [
            {"left": _rsi(length), "op": "<", "right": _const(params.entry_below)},
            *falling,
            {"left": _rsi(length, falls), "op": "<", "right": _const(params.level_below)},
            {"left": {"type": "price", "field": "close"}, "op": ">",
             "right": {"type": "indicator", "name": "sma", "length": params.trend_length}},
        ]},
        "exit": {"any": [{"left": _rsi(length), "op": "crossesAbove", "right": _const(params.exit_above)}]},
    }


if __name__ == "__main__":
    print(json.dumps(definition(), indent=2))
