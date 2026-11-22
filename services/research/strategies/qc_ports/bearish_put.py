"""The bearish put-spread rule of the 2026-11-19 market consult as strategy DSL definitions (research only).

Spec: docs/specs/strategies/bearish-put-spread.md (rule, method decisions, the JSON of every definition
here and the forward test). A backtest of these definitions does not authorize a trade.

The consult's rule needs the dealer gamma flip level, which Vertex has no history of. These definitions
use a price-level proxy, the 20-day SMA of the closes before the signal bar ("SMA20 proxy"); results
describe the proxy rule, never a gamma-flip rule. Entry, all on the signal bar:

1. the high reached the proxy level (high >= SMA20[1]);
2. the close is below it, at most 2% below (0.98 * SMA20[1] <= close < SMA20[1]);
3. rule with breadth: not a heavy down-volume day (series NYSE_UPVOL_PCT above 20).

Exit signal: the close crosses above the 200-day SMA (a failed rally gets back above that line).
Structure: put debit vertical, monthly expiry nearest 52 days with at least 45, long leg at |delta|
0.425, short leg 0.6 ATM standard deviations lower (near |delta| 0.25 at usual QQQ IV), at most 2% of
equity at risk. exitDte 3 closes every spread 3 calendar days before expiry; without it a spread is
held to expiry. The baseline enters on every bar with the same options block and exit.
"""
from __future__ import annotations

from .ideas import CLOSE, condition, const, definition, indicator, math_expr, series_filter

__all__ = ["BASELINE", "BEAR_PUT", "DEFINITIONS", "ENTRY", "EXIT", "PROXY_EXIT3", "RULE_EXIT3", "RULE_EXPIRY"]

HIGH = {"type": "price", "field": "high"}
SMA20_PRIOR = {**indicator("sma", 20), "offset": 1}
ENTRY = (
    condition(HIGH, ">=", SMA20_PRIOR),
    condition(CLOSE, "<", SMA20_PRIOR),
    condition(CLOSE, ">=", math_expr("mul", SMA20_PRIOR, const(0.98))),
)
EXIT = (condition(CLOSE, "crossesAbove", indicator("sma", 200)),)
BREADTH_OK = series_filter("NYSE_UPVOL_PCT", ">", 20)
BEAR_PUT = {"structure": "putDebitVertical", "dte": {"target": 52, "min": 45}, "longDelta": 0.425,
            "widthSigma": 0.6, "maxLossPct": 2}
EXIT3 = {**BEAR_PUT, "exitDte": 3}

RULE_EXIT3 = definition("Bearish put spread, SMA20 proxy, breadth, exitDte 3", EXIT3, entry=ENTRY, exit=EXIT,
                        filters=[BREADTH_OK])
RULE_EXPIRY = definition("Bearish put spread, SMA20 proxy, breadth, to expiry", BEAR_PUT, entry=ENTRY, exit=EXIT,
                         filters=[BREADTH_OK])
PROXY_EXIT3 = definition("Bearish put spread, SMA20 proxy, no breadth, exitDte 3", EXIT3, entry=ENTRY, exit=EXIT)
BASELINE = definition("Bearish put spread baseline, every bar, exitDte 3", EXIT3, exit=EXIT)

# Spec heading -> definition (docs/specs/strategies/bearish-put-spread.md).
DEFINITIONS = {"RULE_EXIT3": RULE_EXIT3, "RULE_EXPIRY": RULE_EXPIRY, "PROXY_EXIT3": PROXY_EXIT3,
               "BASELINE": BASELINE}
