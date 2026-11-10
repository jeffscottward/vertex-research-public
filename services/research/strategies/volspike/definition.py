"""The volume-spike-breakout parameters and its nearest Vertex strategy DSL definition (research only).

Pre-registered: docs/specs/strategies/volume-spike-breakout.md.

As stated, the rule is not a DSL definition: it runs as precomputed signals (rules.py, runner.py). The DSL
cannot state seven parts of it today (MISSING_DSL_PARTS). `dsl_definition` is the nearest definition the DSL
can state (spec section 'DSL definition'); the study runs it through `nautilus_backtest.run_spec` as its own
row. The DSL needs `entryFrom` after the session open, so the first decision is the close of the first
15-minute candle (09:45), not 09:30.

`sensitivity` lists the pre-registered one-at-a-time changes and WALK_FORWARD_GRID the walk-forward grid.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from .rules import Params

TIMEZONE = "America/New_York"
SIDES = ("long", "short")
AS_STATED = Params()
NO_STOP = replace(AS_STATED, stop_kind="none")  # options form c2: the debit is the defined risk
DSL_TIMEFRAME = "15m"
DSL_RISK_PCT = 0.5
DSL_MAX_LEVERAGE = 50
MISSING_DSL_PARTS = (
    "the volume of one bar against the mean of the bars before it (rvol compares cumulative session volume)",
    "a stop in fixed points",
    "an exit after N bars",
    "a weekday filter",
    "a limit of entries per day",
    "an indicator on 4-hour bars",
    "an entry window with a position that stays open overnight (the intraday block closes at 16:00)",
)


def _indicator(name: str, length: int, source: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "indicator", "name": name, "length": length}
    if source is not None:
        out["source"] = source
    return out


def dsl_definition(side: str) -> dict[str, Any]:
    """One leg of the DSL form: 15-minute bars, New York regular session, entries 09:45 to 12:00 (bar
    closes), flat at 16:00; rvol(50) >= 3 and the close breaks the 5-bar high (short: the 5-bar low);
    stop 1 x ATR(14); 0.5 % risk per trade."""
    if side not in SIDES:
        raise ValueError(f"Unknown side {side}")
    long = side == "long"
    out: dict[str, Any] = {
        "version": 1,
        "name": f"Volume spike breakout {side} (DSL form)",
        "description": "YouTube XLMG6-SATRk, strategy 39-113: the nearest definition the DSL can state. Research only.",
        "intraday": {"timezone": TIMEZONE, "open": "09:30", "close": "16:00", "entryFrom": "09:45",
                     "entryTo": "12:00"},
        "entry": {"all": [
            {"left": _indicator("rvol", 50), "op": ">=", "right": {"type": "const", "value": 3}},
            {"left": {"type": "price", "field": "close"}, "op": "breaksAbove" if long else "breaksBelow",
             "right": _indicator("highest" if long else "lowest", 5, "high" if long else "low")},
        ]},
        "stopLoss": {"kind": "atr", "length": 14, "multiple": 1},
        "sizing": {"mode": "riskPct", "riskPct": DSL_RISK_PCT, "maxLeverage": DSL_MAX_LEVERAGE},
    }
    if not long:
        out["side"] = "short"
    return out


def all_definitions() -> dict[str, Any]:
    """For `python -m strategies.volspike definition`."""
    return {
        "volume-spike-breakout-dsl": {
            "name": "Volume spike breakout (DSL form)",
            "timeframe": DSL_TIMEFRAME,
            "asStated": "precomputed signals (strategies/volspike/rules.py), not a DSL definition",
            "missingDslParts": list(MISSING_DSL_PARTS),
            "legs": {side: dsl_definition(side) for side in SIDES},
        }
    }


def percent_stop(params: Params, fraction: float) -> Params:
    """The same rule with the stop as a fraction of the entry price."""
    return replace(params, stop_kind="pct", stop=fraction)


def sensitivity(stop_fraction: float) -> tuple[tuple[str, str, Params], ...]:
    """The pre-registered one-at-a-time changes: (parameter, value, params). `stop_fraction` is the percent
    stop (15 points over the median NAS100 close of the source's in-sample window)."""
    base = AS_STATED
    return (
        ("vol_mult", "2", replace(base, vol_mult=2.0)),
        ("vol_mult", "2.5", replace(base, vol_mult=2.5)),
        ("vol_mult", "3.5", replace(base, vol_mult=3.5)),
        ("vol_mult", "4", replace(base, vol_mult=4.0)),
        ("vol_n", "20", replace(base, vol_n=20)),
        ("vol_n", "30", replace(base, vol_n=30)),
        ("vol_n", "100", replace(base, vol_n=100)),
        ("k", "3", replace(base, k=3)),
        ("k", "10", replace(base, k=10)),
        ("k", "20", replace(base, k=20)),
        ("stop", "10 points", replace(base, stop=10.0)),
        ("stop", "20 points", replace(base, stop=20.0)),
        ("stop", "30 points", replace(base, stop=30.0)),
        ("stop", f"{stop_fraction * 100:.3f} % of price", percent_stop(base, stop_fraction)),
        ("time stop", "40 candles", replace(base, time_stop=40)),
        ("time stop", "160 candles", replace(base, time_stop=160)),
        ("Wednesday skip", "off", replace(base, skip_weekdays=())),
        ("4-hour trend filter", "off", replace(base, trend=False)),
        ("session", "08:30 to 16:00", replace(base, session_to=16 * 60)),
        ("session test", "candle open", replace(base, session_on="open")),
        ("entries per day", "1", replace(base, max_entries=1)),
        ("entries per day", "no limit", replace(base, max_entries=None)),
        ("sides", "long only", replace(base, sides=("long",))),
        ("sides", "short only", replace(base, sides=("short",))),
    )


# Walk-forward candidates (3 years train, 1 year test, best Sharpe): vol_mult x k x stop points.
WALK_FORWARD_GRID: tuple[Params, ...] = tuple(
    replace(AS_STATED, vol_mult=vol_mult, k=k, stop=stop)
    for vol_mult in (2.5, 3.0, 3.5)
    for k in (5, 10)
    for stop in (10.0, 15.0, 20.0)
)

__all__ = ["AS_STATED", "DSL_TIMEFRAME", "MISSING_DSL_PARTS", "NO_STOP", "SIDES", "WALK_FORWARD_GRID",
           "all_definitions", "dsl_definition", "percent_stop", "sensitivity"]
