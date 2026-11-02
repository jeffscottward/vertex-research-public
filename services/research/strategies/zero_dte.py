"""Dedicated same-day research capability, not a funded sixth sleeve.

The source comparison's eight gates are explicit missing integration/evidence
requirements. No parser, quote, hypothesis, method here, or agent can mark them
passed or override Gamma's positive-DTE execution restrictions.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class MissingReadinessGate:
    gate_id: str
    requirement: str
    state: str = "missing"


ZERO_DTE_GATES = (
    MissingReadinessGate("Z01", "Qualify same-day contract using exchange-local expiry time, exercise style, settlement and multiplier; reject stale/cross-date alerts."),
    MissingReadinessGate("Z02", "Apply exchange calendars, holidays, session entry cutoffs and early closes; UTC date or fixed 16:00 is insufficient."),
    MissingReadinessGate("Z03", "Require fresh timestamped intraday underlying and executable option quotes and Greeks with provider provenance."),
    MissingReadinessGate("Z04", "Check chain liquidity/spreads and model fees, slippage, latency and partial multi-leg fills."),
    MissingReadinessGate("Z05", "Enforce Greeks and aggregate exposures against reconciled positions and open orders; equity notional is insufficient."),
    MissingReadinessGate("Z06", "Construct defined-risk positions and reserve collateral at the execution authority; qualify exercise, assignment, settlement and stock exposure."),
    MissingReadinessGate("Z07", "Reproduce intraday option replay and paper scenarios through expiry, forced close and zero remaining time; no one-day numerical fallback."),
    MissingReadinessGate("Z08", "Prove rapid exits and independent kill switch through disconnects, stale data, rejection, partial fills, cancel/fill races and restart recovery."),
)


@dataclass(frozen=True)
class ZeroDteResearchCapability:
    name: str = "zero-dte-research"
    owner_sleeve: str = "quant"
    state: str = "research-only"
    funded_sixth_sleeve: bool = False
    paper_ready: bool = False
    live_allowed: bool = False
    missing_gates: tuple[MissingReadinessGate, ...] = ZERO_DTE_GATES
    separate_live_approval: str = "required-not-supplied"


def zero_dte_capability() -> ZeroDteResearchCapability:
    return ZeroDteResearchCapability()
