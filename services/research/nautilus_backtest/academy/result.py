"""An Academy result in the engine result shape of a backtest run (dual run; research only).

The research worker returns every run in the shape of the TypeScript `InstantRunResult` (unit
equity per bar, trades, statistics), which the API validates and compares. `engine_result` maps
an Academy result to it; `packages/api/src/academy-engine-result.ts` does the same mapping for the
TypeScript result, so the stored differences compare like with like:

- equity: 1 on the warm-up bars (the first 20, no position), then the dollar equity / capital.
- one trade per closed role (position, cycle or core): entry and exit bar; `entryPrice` and
  `exitPrice` are the underlying closes at entry and exit (a structure has no single price),
  `units` and `pnl` are per unit of capital, `netReturn` is the P&L over the absolute entry cash.
- exit reason: profit-target -> target, stop -> stop, end -> end; exit-dte, expiry and core-roll
  -> signal (the engine result has no finer reason).
- statistics: `engine.summarize` on that equity and those trades. `exposure` counts the bars of
  every trade, so a structure with a core and a cycle counts its bars twice.
"""
from __future__ import annotations

from types import SimpleNamespace

from ..bars import InputError
from ..engine import summarize
from .simulator import AcademyInput

__all__ = ["EXIT_REASONS", "engine_result"]

EXIT_REASONS = {"profit-target": "target", "stop": "stop", "end": "end", "exit-dte": "signal",
                "expiry": "signal", "core-roll": "signal"}


def _bars_in_position(trades: list[dict]) -> int:
    """Port of TS `barsInPositionOf`."""
    return sum(trade["exitIndex"] - trade["entryIndex"] + (1 if trade["exitReason"] == "end" else 0)
               for trade in trades)


def engine_result(result: dict, data: AcademyInput) -> dict:
    """{equity, trades, stats} of an Academy result (simulator.run_model or engine.run_academy)."""
    capital = data.capital
    equity = [1.0] * result["firstIndex"] + [value / capital for value in result["equity"]]
    if any(value <= 0 for value in equity):
        raise InputError("The Academy equity fell to zero or below; an engine result cannot hold it")
    trades = []
    for trade in result["trades"]:
        basis = abs(trade["entryNet"])
        trades.append({
            "entryIndex": trade["entryIndex"],
            "entryPrice": trade["spotEntry"],
            "exitIndex": trade["exitIndex"],
            "exitPrice": trade["spotExit"],
            "exitReason": EXIT_REASONS[trade["reason"]],
            "netReturn": trade["pnl"] / basis if basis > 0 else 0.0,
            "pnl": trade["pnl"] / capital,
            "units": trade["units"] / capital,
        })
    bars = SimpleNamespace(t=data.t, c=data.c)
    return {"equity": equity, "trades": trades, "stats": summarize(bars, equity, trades, _bars_in_position(trades))}
