"""Registry of the options forms study (research only).

On 2026-11-11 the allocation study found 42 tradable library strategies without a defined-risk
options form (`LIBRARY_SLUGS`). Each of them is here once: with a form (`STRATEGY_FORMS`) or with
the reason why this runner cannot run it (`NOT_RUN`). `study_forms` adds configs B and C of the long
calendar spread, the two forms of the library alert `leader-pullback-and-reclaim` and the always-on
baseline of every universe.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence

from .forms import (
    CORE7,
    FUTURES_TWINS,
    FX_TWINS,
    LONG_SHORT,
    MULTI8,
    SECTOR9,
    SECTOR11,
    Form,
    NotRun,
    always_on,
)
from .forms_orders import FORMS as ORDER_FORMS
from .forms_other import FORMS as OTHER_FORMS
from .forms_other import CALENDAR_VARIANTS, LEADER_CALL, LEADERS_BASELINE, leader_forms
from .forms_weights import FORMS as WEIGHT_FORMS

__all__ = ["BASELINE_UNIVERSES", "LEADERS_BASELINE", "LIBRARY_SLUGS", "NOT_RUN", "STRATEGY_FORMS", "baseline_form",
           "study_forms"]

STRATEGY_FORMS: tuple[Form, ...] = (*ORDER_FORMS, *WEIGHT_FORMS, *OTHER_FORMS)

INTRADAY = ("The rule reads {bars} bars. The option book prices daily closes only, and the data set has no "
            "intraday bars and no intraday option prices for it.")
NOT_RUN: tuple[NotRun, ...] = (
    NotRun("quantjourney-o15-intraday-5m-bracket-reversion", INTRADAY.format(bars="5-minute")),
    NotRun("quantjourney-o16-intraday-30m-stop-breakout", INTRADAY.format(bars="30-minute")),
    NotRun("quantjourney-w07-intraday-rsi-15m", INTRADAY.format(bars="15-minute")),
    NotRun("quantjourney-w08-intraday-1m-ema-scalp", INTRADAY.format(bars="1-minute")),
    NotRun("quantjourney-w09-intraday-1h-sma-trend", INTRADAY.format(bars="1-hour")),
)

# The 42 tradable library strategies without an options form (allocation study, 2026-11-11).
LIBRARY_SLUGS: tuple[str, ...] = (
    "151-4-1-sector-momentum-rotation", "long-calendar-spread", "quantlab-zakamulin-2013-sma-timing",
    "pairs-trading-divergence", "bridgingcycles-short-strangle",
    "quantjourney-o03-limit-rsi-dip", "quantjourney-o04-limit-trend-pullback", "quantjourney-o05-stop-breakout-entry",
    "quantjourney-o07-stop-limit-breakout", "quantjourney-o08-stop-limit-protection",
    "quantjourney-o09-trailing-stop-trend", "quantjourney-o10-trailing-stop-rsi", "quantjourney-o11-trailing-stop-limit",
    "quantjourney-o14-oco-dip-or-breakout", "quantjourney-o15-intraday-5m-bracket-reversion",
    "quantjourney-o16-intraday-30m-stop-breakout", "quantjourney-o17-monthly-rotation-orders",
    "quantjourney-o19-fx-momentum-lots", "quantjourney-o20-futures-donchian-contracts",
    "quantjourney-w02-monthly-drift-etf", "quantjourney-w04-quarterly-dual-momentum",
    "quantjourney-w05-monthly-inverse-vol", "quantjourney-w06-signal-change-defensive",
    "quantjourney-w07-intraday-rsi-15m", "quantjourney-w08-intraday-1m-ema-scalp",
    "quantjourney-w09-intraday-1h-sma-trend", "quantjourney-w10-monthly-circuit-breaker",
    "quantjourney-w11-quarterly-te-cost-gate", "quantjourney-w12-daily-partial-drift",
    "quantjourney-w13-pairs-ratio-zscore", "quantjourney-w14-pairs-hedge-ratio",
    "quantjourney-w15-cross-sectional-momentum", "quantjourney-w16-cross-sectional-reversal",
    "quantjourney-w17-vol-target-trend", "quantjourney-w18-vol-target-momentum",
    "quantjourney-w19-risk-parity-multiasset", "quantjourney-w20-risk-parity-capped",
    "quantjourney-w21-bollinger-reversion", "quantjourney-w22-macd-trend", "quantjourney-w23-fx-time-series-momentum",
    "quantjourney-w24-fx-cross-sectional-momentum", "quantjourney-w25-continuous-futures-trend",
)

BASELINE_UNIVERSES: dict[str, tuple[str, ...]] = {
    "base/core7": CORE7,
    "base/multi8": MULTI8,
    "base/sector9": SECTOR9,
    "base/sector11": SECTOR11,
    "base/fx3": FX_TWINS,
    "base/futures4": ("SPY", "QQQ", "USO", "GLD"),
    "base/futures6": FUTURES_TWINS,
    "base/spy": ("SPY",),
}


def baseline_form(key: str, symbols: Sequence[str], structures: Mapping[int, tuple[Mapping, ...]] = LONG_SHORT) -> Form:
    """The always-on form of a universe: one call spread per symbol at all times."""
    return Form(key, key, f"Always on ({len(symbols)} symbols)", "baseline", tuple(symbols), always_on, None,
                "Holds the call spread on every symbol at all times.", structures)


def study_forms(leaders: Sequence[str]) -> tuple[Form, ...]:
    """Every form the study runs: the strategy forms, configs B and C of the long calendar spread, the leader
    forms on `leaders`, then the baselines."""
    made = (*STRATEGY_FORMS, *CALENDAR_VARIANTS, *leader_forms(leaders))
    universes = {**BASELINE_UNIVERSES, LEADERS_BASELINE: tuple(leaders)}
    # The leader baseline holds the leader spread (0.5% of equity per name), so check G7 compares like with like.
    sized = {LEADERS_BASELINE: {1: (LEADER_CALL,)}}
    missing = sorted({form.baseline for form in made if form.baseline is not None} - set(universes))
    if missing:
        raise ValueError(f"No baseline universe for {missing}")
    for form in made:
        if form.baseline is not None and set(form.symbols) != set(universes[form.baseline]):
            raise ValueError(f"{form.key}: its symbols are not the universe of {form.baseline}")
    return (*made, *(baseline_form(key, symbols, sized.get(key, LONG_SHORT)) for key, symbols in universes.items()))
