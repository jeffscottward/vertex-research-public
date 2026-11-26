"""Smart-money PR 7 research-only event-study backtests (pure stdlib + services/research).

Evaluates three pre-registered signals with zero look-ahead and deflated Sharpe testing:
1. insider-purchase-confirmation (SEC Form 4 buys + cluster variant)
2. smart-money-congress-buys (House & Senate electronic PTR buys by first filing date)
3. smart-money-large-bullish-premium (QuantData >= $100k large bullish premium, needs-more-data < 2y)

Research only: never places, changes, or arms any order or risk setting.
"""
from __future__ import annotations

from .document import STUDY_IDS, build_study_document, write_study_bundle
from .engine import (
    DEFAULT_COST_BPS,
    DEFAULT_MAX_SLOTS,
    DSR_PASS_BAR,
    MIN_OOS_EVENTS,
    MIN_OOS_SESSIONS,
    DailyBar,
    PortfolioConfig,
    PortfolioResult,
    SignalEvent,
    TrialRecord,
    compute_study_dsr,
    evaluate_verdict,
    simulate_event_portfolio,
)
from .signals import (
    CongressPurchase,
    Form4Purchase,
    MarketPremiumRow,
    build_signal1_variants,
    build_signal2_variants,
    build_signal3_events,
    dedupe_congress_purchases,
    normalize_congress_member,
    normalize_security_title,
    parse_sec_form4_zip,
)

__all__ = [
    "CongressPurchase",
    "DEFAULT_COST_BPS",
    "DEFAULT_MAX_SLOTS",
    "DSR_PASS_BAR",
    "DailyBar",
    "Form4Purchase",
    "MIN_OOS_EVENTS",
    "MIN_OOS_SESSIONS",
    "MarketPremiumRow",
    "PortfolioConfig",
    "PortfolioResult",
    "STUDY_IDS",
    "SignalEvent",
    "TrialRecord",
    "build_signal1_variants",
    "build_signal2_variants",
    "build_signal3_events",
    "build_study_document",
    "compute_study_dsr",
    "dedupe_congress_purchases",
    "evaluate_verdict",
    "normalize_congress_member",
    "normalize_security_title",
    "parse_sec_form4_zip",
    "simulate_event_portfolio",
    "write_study_bundle",
]
