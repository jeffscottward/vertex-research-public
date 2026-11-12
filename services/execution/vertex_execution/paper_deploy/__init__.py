"""Paper deployment path for defined-risk vertical spreads. Simulation only.

request -> strategy -> order policy -> simulated venue -> position -> exit rule.
Importing starts nothing. No module here talks to a broker, reads the wall
clock or writes a file.
"""
from .calendar import NYSE, NyseCalendar
from .exit_rule import (
    REASON_LOSER,
    REASON_ROLL,
    REASON_WINNER,
    ExitDecision,
    HeldSpread,
    SpreadMark,
    decide_exit,
)
from .policy import ArmGatePolicy, PolicyDecision, PolicyPort, allow_all, refuse_all
from .request import OptionsBlock, PaperRequest, RequestError, RequestLimits
from .runner import PaperPath, PaperPosition, PathResult
from .strategy import ComboOrder, OrderLeg, PaperSpreadStrategy, SpreadIntent, StrategyRefusal
from .venue import LegQuote, PaperFill, PaperVenueModel, SimulatedPaperVenue, SpreadQuote, VenueRefusal

__all__ = [
    "NYSE",
    "REASON_LOSER",
    "REASON_ROLL",
    "REASON_WINNER",
    "ArmGatePolicy",
    "ComboOrder",
    "ExitDecision",
    "HeldSpread",
    "LegQuote",
    "NyseCalendar",
    "OptionsBlock",
    "OrderLeg",
    "PaperFill",
    "PaperPath",
    "PaperPosition",
    "PaperRequest",
    "PaperSpreadStrategy",
    "PaperVenueModel",
    "PathResult",
    "PolicyDecision",
    "PolicyPort",
    "RequestError",
    "RequestLimits",
    "SimulatedPaperVenue",
    "SpreadIntent",
    "SpreadMark",
    "SpreadQuote",
    "StrategyRefusal",
    "VenueRefusal",
    "allow_all",
    "decide_exit",
    "refuse_all",
]
