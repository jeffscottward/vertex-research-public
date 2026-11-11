"""Options forms of the pairs, the FX and futures twins, the 10-month SMA timing, the short strangle
and the leader pullback (research only).

`FORMS` holds the 10 forms on fixed universes. `leader_forms(symbols)` makes the 2 forms of the
library alert `leader-pullback-and-reclaim` on the stocks the study has bars for. Every rule gives
the stance of forms.py (+1, -1 or 0 per symbol and bar, known at the close of that bar). The condor and the leader forms
are entry only (`Form.entry_only`): their stance is +1 on the bars that may open a spread.

Sources and what the rules read:
- QuantJourney examples (quantjourney-bt, `strategies/example_weights_13`, `_14`, `_23`, `_24`,
  `_25`, `example_orders_19`, `_20`). They read total-return prices (forms.adjusted). A pandas
  rolling `std`, `var` and `cov` is the sample statistic (n - 1).
- Pairs Trading Divergence: docs/specs/strategies/pairs-trading-divergence.md and
  published_rules.pair_spread_backtest (Chan 2008, example 3.6). The book fits the hedge ratio and
  the spread statistics once; the form fits them on the last 252 joint bars at every bar.
- 10-month SMA timing: quantlab/drafts/zakamulin-2013-sma-timing.json.
- Short strangle: docs/specs/strategies/bridgingcycles-short-strangle.md and `entry_decision` of
  gamma/engines/bridgingcycles_short_strangle.py. The entry rule is written again here (this package
  does not import gamma); tests/test_qc_ports_forms_other.py compares it with the engine.
- Leader pullback: alert_templates.py, with the bars built as alert_templates_run.load builds them
  (unadjusted open, high, low and close).

A pair is traded on the days both symbols have a bar. On a day one of them has no bar, the other
keeps its side.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from datetime import date

from .. import alert_templates as at
from ..published_rules import mean, sample_std
from . import data as qd
from . import options as om
from .data import Bars
from .forms import (CORE7, FUTURES_TWINS, FX_TWINS, Form, Inputs, Rule, adjusted, from_panel, highest, lowest,
                    panel, pct_change, period_ends, sma)
from .ideas import MONTHLY_CALL

__all__ = [
    "ALERT_VOLUME", "CONDOR_CALL", "CONDOR_PUT", "DIVERGENCE_WINDOW", "FORMS", "FUTURES4",
    "LEADER_CALL", "LEADER_SLUG", "LEADERS_BASELINE", "band_sides", "daily_bars", "dip_sides", "divergence_sides",
    "divergence_z", "donchian_sides", "hedge_ratio_z", "leader_forms", "momentum_direction",
    "momentum_sign", "ratio_z", "reclaim_sides", "sma_timing_sides", "trend_sides", "vrp_entries",
]

# --------------------------------------------------------------------------- pairs

PAIR_WINDOW = 60
PAIR_ENTRY = 2.0
PAIR_EXIT = 0.5
DIVERGENCE_WINDOW = 252
DIVERGENCE_ENTRY = 2.0
DIVERGENCE_EXIT = 1.0


def _zscore(values: Sequence[float | None], length: int) -> list[float | None]:
    """(value - mean) / sample standard deviation of the last `length` values; None where one of them is
    missing or they do not vary."""
    out: list[float | None] = [None] * len(values)
    for index in range(length - 1, len(values)):
        window = values[index - length + 1:index + 1]
        if any(value is None for value in window):
            continue
        scale = sample_std(window)  # type: ignore[arg-type]
        if scale > 0:
            out[index] = (window[-1] - mean(window)) / scale  # type: ignore[arg-type,operator]
    return out


def _rolling_beta(y: Sequence[float], x: Sequence[float], length: int) -> list[float | None]:
    """Regression slope of y on x (covariance over variance) of the last `length` bars; None where x does not vary."""
    out: list[float | None] = [None] * len(y)
    for index in range(length - 1, len(y)):
        ys, xs = y[index - length + 1:index + 1], x[index - length + 1:index + 1]
        centre_y, centre_x = mean(ys), mean(xs)
        spread = math.fsum((b - centre_x) ** 2 for b in xs)
        if spread > 0:
            out[index] = math.fsum((a - centre_y) * (b - centre_x) for a, b in zip(ys, xs)) / spread
    return out


def ratio_z(first: Sequence[float], second: Sequence[float], length: int = PAIR_WINDOW) -> list[float | None]:
    """QuantJourney weights 13: z-score of log(first) - log(second) over `length` bars."""
    return _zscore([math.log(a) - math.log(b) for a, b in zip(first, second, strict=True)], length)


def hedge_ratio_z(first: Sequence[float], second: Sequence[float], length: int = PAIR_WINDOW) -> list[float | None]:
    """QuantJourney weights 14: z-score over `length` bars of log(first) - beta * log(second), where
    beta is the regression slope of the two logs over the last `length` bars (one beta per bar)."""
    logs_a, logs_b = [math.log(a) for a in first], [math.log(b) for b in second]
    beta = _rolling_beta(logs_a, logs_b, length)
    spread = [None if slope is None else a - slope * b for a, b, slope in zip(logs_a, logs_b, beta, strict=True)]
    return _zscore(spread, length)


def divergence_z(first: Sequence[float], second: Sequence[float],
                 length: int = DIVERGENCE_WINDOW) -> list[float | None]:
    """Pairs Trading Divergence on a rolling window: at each bar the hedge ratio h is the least-squares
    slope of `first` on `second` without intercept over the last `length` bars (as the book fits it),
    and z is the last value of first - h * second against the mean and the sample standard deviation
    of that spread over the same bars."""
    out: list[float | None] = [None] * len(first)
    for index in range(length - 1, len(first)):
        ys, xs = first[index - length + 1:index + 1], second[index - length + 1:index + 1]
        hedge = math.fsum(a * b for a, b in zip(ys, xs, strict=True)) / math.fsum(b * b for b in xs)
        spread = [a - hedge * b for a, b in zip(ys, xs)]
        scale = sample_std(spread)
        if scale > 0:
            out[index] = (spread[-1] - mean(spread)) / scale
    return out


def band_sides(z_values: Sequence[float | None], entry: float = PAIR_ENTRY, exit_: float = PAIR_EXIT) -> list[int]:
    """Side of the first leg, QuantJourney: from flat, -1 at z > entry and +1 at z < -entry; back to flat
    at |z| < exit_ (no direct change of side); flat where z is missing."""
    out, side = [], 0
    for z in z_values:
        if z is None:
            side = 0
        elif side == 0:
            side = -1 if z > entry else 1 if z < -entry else 0
        elif abs(z) < exit_:
            side = 0
        out.append(side)
    return out


def divergence_sides(z_values: Sequence[float | None], entry: float = DIVERGENCE_ENTRY,
                     exit_: float = DIVERGENCE_EXIT) -> list[int]:
    """Side of the first leg, book rule 4: flat at |z| <= exit_, -1 at z >= entry, +1 at z <= -entry,
    otherwise the side of the bar before; flat where z is missing."""
    out, side = [], 0
    for z in z_values:
        if z is None or abs(z) <= exit_:
            side = 0
        elif z >= entry:
            side = -1
        elif z <= -entry:
            side = 1
        out.append(side)
    return out


def _pair_rule(first: str, second: str, z_of: Callable[[Sequence[float], Sequence[float]], list[float | None]],
               sides_of: Callable[[Sequence[float | None]], list[int]]) -> Rule:
    """`first` gets the side of the z-score rule and `second` the opposite side."""

    def rule(inputs: Inputs) -> dict[str, list[int]]:
        made = panel(inputs, (first, second))
        rows = [(index, a, b) for index, (a, b) in enumerate(zip(made.close[first], made.close[second]))
                if a is not None and b is not None]
        sides = sides_of(z_of([a for _, a, _ in rows], [b for _, _, b in rows]))
        on_joint_day = dict(zip((index for index, _, _ in rows), sides, strict=True))
        held_side, side = [], 0
        for index in range(len(made.dates)):
            side = on_joint_day.get(index, side)
            held_side.append(side)
        return from_panel(inputs, made.dates, {first: held_side, second: [-value for value in held_side]})

    return rule


# --------------------------------------------------------------------------- FX and futures twins

FX_MOMENTUM = 126
FX_RANK = 63
DONCHIAN = 55
TREND_FAST = 63
TREND_SLOW = 252
# ETF twins of MES, MNQ, CL and GC (QuantJourney orders 20).
FUTURES4 = ("SPY", "QQQ", "USO", "GLD")


def _sign(value: float | None) -> int:
    return 0 if value is None else (value > 0) - (value < 0)


def _each(symbols: Sequence[str], sides_of: Callable[[Bars], list[int]], *, total_return: bool) -> Rule:
    """One stance per symbol from its own bars (`total_return`: the bars of forms.adjusted)."""

    def rule(inputs: Inputs) -> dict[str, list[int]]:
        return {symbol: sides_of(adjusted(inputs.bars[symbol]) if total_return else inputs.bars[symbol])
                for symbol in symbols if symbol in inputs.bars}

    return rule


def momentum_direction(bars: Bars, lookback: int = FX_MOMENTUM) -> list[int]:
    """QuantJourney orders 19: from bar `lookback` on, +1 when the close is over the close `lookback`
    bars before, else -1 (the rule is never flat again)."""
    close = bars.close
    return [0 if index < lookback else 1 if close[index] > close[index - lookback] else -1
            for index in range(len(close))]


def momentum_sign(bars: Bars, lookback: int = FX_MOMENTUM) -> list[int]:
    """QuantJourney weights 23: the sign of the `lookback`-bar return (0 for no change)."""
    return [_sign(change) for change in pct_change(bars.close, lookback)]


def _rank_rule(symbols: Sequence[str], lookback: int = FX_RANK) -> Rule:
    """QuantJourney weights 24: per day, +1 for the highest and -1 for the lowest `lookback`-bar
    return among the symbols that have one (at least 2). Ties go to the first symbol in `symbols`;
    when all returns are equal that symbol is short, as the source assigns the short side last."""

    def rule(inputs: Inputs) -> dict[str, list[int]]:
        names = [symbol for symbol in symbols if symbol in inputs.bars]
        made = panel(inputs, names)
        scores = {symbol: pct_change(made.close[symbol], lookback) for symbol in names}
        sides = {symbol: [0] * len(made.dates) for symbol in names}
        for index in range(len(made.dates)):
            valid = [(scores[symbol][index], symbol) for symbol in names if scores[symbol][index] is not None]
            if len(valid) < 2:
                continue
            best, worst = max(value for value, _ in valid), min(value for value, _ in valid)  # type: ignore[type-var]
            sides[next(symbol for value, symbol in valid if value == best)][index] = 1
            sides[next(symbol for value, symbol in valid if value == worst)][index] = -1
        return from_panel(inputs, made.dates, sides)

    return rule


def donchian_sides(bars: Bars, window: int = DONCHIAN) -> list[int]:
    """QuantJourney orders 20: +1 from a close over the highest high of the `window` bars before,
    -1 from a close under their lowest low, otherwise the side of the bar before."""
    top, bottom = highest(bars.high, window), lowest(bars.low, window)
    out, side = [], 0
    for index, close in enumerate(bars.close):
        if index >= window:
            if close > top[index - 1]:  # type: ignore[operator]
                side = 1
            elif close < bottom[index - 1]:  # type: ignore[operator]
                side = -1
        out.append(side)
    return out


def trend_sides(bars: Bars, fast: int = TREND_FAST, slow: int = TREND_SLOW) -> list[int]:
    """QuantJourney weights 25: the sign of SMA(fast) - SMA(slow) of the close; 0 until both exist."""
    return [0 if quick is None or base is None else _sign(quick - base)
            for quick, base in zip(sma(bars.close, fast), sma(bars.close, slow))]


# --------------------------------------------------------------------------- 10-month SMA timing

SMA_MONTHS = 10


def sma_timing_sides(bars: Bars, months: int = SMA_MONTHS) -> list[int]:
    """+1 from a month-end close until the next month-end when the adjusted close is above the mean of
    the last `months` month-end adjusted closes (that month included), else 0."""
    close = bars.adj_close
    ends = [index for index, last in enumerate(period_ends(bars.dates, "month")) if last]
    out = [0] * len(bars)
    for number in range(months - 1, len(ends)):
        index = ends[number]
        level = mean([close[end] for end in ends[number - months + 1:number + 1]])
        stop = ends[number + 1] if number + 1 < len(ends) else len(bars)
        out[index:stop] = [int(close[index] > level)] * (stop - index)
    return out


# --------------------------------------------------------------------------- short strangle as an iron condor

# The strangle has undefined risk. The form holds a put credit spread and a call credit spread:
# 1% of the equity per side, so the condor risks at most 2%.
CONDOR_PUT = {"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.16,
              "widthSigma": 0.5, "maxLossPct": 1}
CONDOR_CALL = {**CONDOR_PUT, "structure": "callCreditVertical"}
RV_WINDOW = 21
RV_YEAR = 252
VRP_LOOKBACK = 252
VRP_PERCENTILE = 90.0


def _realized_volatility(closes: Sequence[float], index: int) -> float | None:
    """Annualized sample standard deviation of the RV_WINDOW daily log returns that end at bar `index`
    (the arithmetic of the engine's `realized_volatility`)."""
    if index < RV_WINDOW:
        return None
    tail = closes[index - RV_WINDOW:index + 1]
    returns = [math.log(tail[position + 1] / tail[position]) for position in range(RV_WINDOW)]
    centre = sum(returns) / RV_WINDOW
    variance = sum((value - centre) ** 2 for value in returns) / (RV_WINDOW - 1)
    return math.sqrt(variance) * math.sqrt(RV_YEAR)


def vrp_entries(bars: Bars, iv_index: Sequence[float | None], index_id: str) -> list[int]:
    """1 on a bar where the entry rule of the short strangle holds (spec rules 4, 5, 5a and 12), else 0.

    The premium is ATM IV (options.atm_iv of the index level) minus the 21-day realized volatility
    of the adjusted close. The rule holds when the premium is above 0 and at least 90% of its last
    252 values, the bar itself included, are at or below it. A bar without an index level or without
    21 returns has no premium: its stance is 0 and it does not count among the 252 values (as the
    engine keeps its history).
    """
    out: list[int] = []
    history: list[float] = []
    for index, level in enumerate(iv_index):
        realized = _realized_volatility(bars.adj_close, index)
        if level is None or realized is None:
            out.append(0)
            continue
        premium = om.atm_iv(index_id, level) - realized
        history.append(premium)
        if premium <= 0 or len(history) < VRP_LOOKBACK:
            out.append(0)
            continue
        at_or_below = sum(1 for value in history[-VRP_LOOKBACK:] if value <= premium)
        out.append(int(100.0 * at_or_below / VRP_LOOKBACK >= VRP_PERCENTILE))
    return out


def _condor_rule(inputs: Inputs) -> dict[str, list[int]]:
    return {symbol: vrp_entries(inputs.bars[symbol], inputs.iv_index[symbol], qd.IV_INDEX[symbol])
            for symbol in CORE7 if symbol in inputs.bars}


# --------------------------------------------------------------------------- leader pullback

LEADER_SLUG = "leader-pullback-and-reclaim"
LEADERS_BASELINE = "base/leaders"
# Up to about 97 names can be open at once, so a leader spread risks 0.5% of the equity, not 2%.
LEADER_CALL = {**MONTHLY_CALL, "dte": dict(MONTHLY_CALL["dte"]), "maxLossPct": 0.5}
# The bars have no volume. This volume passes the liquidity filter of the alert (30-day average over 2e6).
ALERT_VOLUME = 1e9


def daily_bars(bars: Bars) -> tuple[list[int], list[at.DailyBar]]:
    """The alert bars of `bars` and the bar index of each, built as alert_templates_run.load builds
    them: unadjusted prices, high and low widened to hold open and close, rows with a price at or
    under 0 left out. The volume is ALERT_VOLUME."""
    positions: list[int] = []
    made: list[at.DailyBar] = []
    for index, day in enumerate(bars.dates):
        open_, high, low, close = bars.open[index], bars.high[index], bars.low[index], bars.close[index]
        if min(open_, high, low, close) <= 0:
            continue
        positions.append(index)
        made.append(at.DailyBar(date.fromisoformat(day), open_, max(high, open_, close), min(low, open_, close),
                                close, ALERT_VOLUME))
    return positions, made


def reclaim_sides(bars: Bars) -> list[int]:
    """+1 on the bar of each `leader_pullback_and_reclaim` signal, else 0."""
    positions, made = daily_bars(bars)
    out = [0] * len(bars)
    for signal in at.leader_pullback_and_reclaim(made):
        out[positions[signal.index]] = 1
    return out


def dip_sides(bars: Bars) -> list[int]:
    """+1 on every bar where `leader_pullback_price` holds, else 0."""
    positions, made = daily_bars(bars)
    series = at.prepare(made)
    out = [0] * len(bars)
    for index, position in enumerate(positions):
        out[position] = int(at.leader_pullback_price(series, index))
    return out


LEADER_FORM = ("The call spread risks 0.5% of equity (many names can be open at once) and is held to the owner exit "
               "rule; the next one opens on a signal after it has closed. Reads unadjusted prices, as the alert "
               "study. The liquidity filter is not applied: the bars have no volume.")
SCREEN = "close over SMA(200), 8% to 20% under the 252-day high, under SMA(50), RSI(14) between 35 and 45"


def leader_forms(symbols: Sequence[str]) -> tuple[Form, ...]:
    """The two forms of the alert `leader-pullback-and-reclaim` on `symbols` (long only, entry only)."""
    names = tuple(symbols)
    structures = {1: (LEADER_CALL,)}
    return (
        Form("leaders/reclaim", LEADER_SLUG, "Leader pullback and reclaim (buy the reclaim)", "mean reversion", names,
             _each(names, reclaim_sides, total_return=False), LEADERS_BASELINE,
             f"Keeps the alert: the stock passes the pullback screen on the first session of a week ({SCREEN}) "
             f"and trades back over SMA(50) by the first session of the next week. {LEADER_FORM}", structures, True),
        Form("leaders/dip", LEADER_SLUG, "Leader pullback (buy the dip state)", "mean reversion", names,
             _each(names, dip_sides, total_return=False), LEADERS_BASELINE,
             f"Keeps the pullback screen of the alert, read on every bar ({SCREEN}), and drops the wait for the "
             f"reclaim of SMA(50). {LEADER_FORM}", structures, True),
    )


# --------------------------------------------------------------------------- forms

PAIR_SIZE = ("Each leg risks 2% of equity in its own spread; the dollar-neutral weights, the short borrow and the "
             "netting of the two legs are dropped.")
FX_TWIN = ("Reads the bars of FXE, FXB and FXA for EURUSD, GBPUSD and AUDUSD; NZDUSD is dropped (no ETF with "
           "options).")

FORMS: tuple[Form, ...] = (
    Form("qj/W13", "quantjourney-w13-pairs-ratio-zscore", "Pairs Trading (Ratio Z-Score)", "relative value",
         ("KO", "PEP"), _pair_rule("KO", "PEP", ratio_z, band_sides), None,
         "Keeps the z-score of log(KO) - log(PEP) over 60 bars: short KO and long PEP from z > 2, the opposite from "
         f"z < -2, flat when |z| < 0.5. {PAIR_SIZE}"),
    Form("qj/W14", "quantjourney-w14-pairs-hedge-ratio", "Pairs Trading (Hedge Ratio)", "relative value",
         ("EWA", "EWC"), _pair_rule("EWA", "EWC", hedge_ratio_z, band_sides), None,
         "Keeps the z-score over 60 bars of log(EWA) - beta x log(EWC), beta the 60-bar regression slope: short EWA "
         f"and long EWC from z > 2, the opposite from z < -2, flat when |z| < 0.5. {PAIR_SIZE}"),
    Form("lib/pairs-divergence", "pairs-trading-divergence", "Pairs Trading Divergence", "relative value",
         ("GLD", "GDX"), _pair_rule("GLD", "GDX", divergence_z, divergence_sides), None,
         "Keeps the z-score rule of the spread GLD - h x GDX: long GLD and short GDX from z <= -2, the opposite from "
         "z >= 2, flat at |z| <= 1, otherwise the side before. Adaptation: the book fits the hedge ratio h and the "
         "spread mean and deviation once on 2006-2007, and that fit does not hold on 20 years, so the form fits them "
         "at every bar on the last 252 bars (least squares of GLD on GDX without intercept, as the book). "
         f"{PAIR_SIZE}"),
    Form("qj/O19", "quantjourney-o19-fx-momentum-lots", "FX Momentum with Standard Lots", "rotation", FX_TWINS,
         _each(FX_TWINS, momentum_direction, total_return=True), "base/fx3",
         "Keeps the direction of the 126-bar change: long when the close is over the close 126 bars before, else "
         f"short, never flat after the first 126 bars. {FX_TWIN} The lot count by ATR risk and notional cap, "
         "slippage and commission are dropped."),
    Form("qj/W23", "quantjourney-w23-fx-time-series-momentum", "FX Time-Series Momentum", "rotation", FX_TWINS,
         _each(FX_TWINS, momentum_sign, total_return=True), "base/fx3",
         f"Keeps the sign of the 126-bar return per currency. {FX_TWIN} The inverse-volatility weights are dropped."),
    Form("qj/W24", "quantjourney-w24-fx-cross-sectional-momentum", "FX Cross-Sectional Momentum", "rotation",
         FX_TWINS, _rank_rule(FX_TWINS), "base/fx3",
         "Keeps the rank of the 63-bar returns: long the strongest and short the weakest of the 3 currency ETFs, "
         f"nothing on the third (the source ranks 4 pairs). {FX_TWIN} The dollar-neutral weights are dropped."),
    Form("qj/O20", "quantjourney-o20-futures-donchian-contracts", "Futures Donchian Contracts", "trend", FUTURES4,
         _each(FUTURES4, donchian_sides, total_return=True), "base/futures4",
         "Keeps the 55-bar Donchian breakout: long from a close over the highest high of the 55 bars before, short "
         "from a close under their lowest low, held until the opposite breakout. Reads the bars of SPY, QQQ, USO and "
         "GLD for MES, MNQ, CL and GC. The contract count by ATR risk, notional and margin caps, slippage and "
         "commission are dropped."),
    Form("qj/W25", "quantjourney-w25-continuous-futures-trend", "Continuous Futures Trend Proxy", "trend",
         FUTURES_TWINS, _each(FUTURES_TWINS, trend_sides, total_return=True), "base/futures6",
         "Keeps the sign of SMA(63) - SMA(252) of the close. Reads the bars of SPY, QQQ, IEF, USO, GLD and CORN for "
         "MES, MNQ, ZN, CL, GC and ZC. The inverse-volatility weights are dropped."),
    Form("lib/zakamulin-sma", "quantlab-zakamulin-2013-sma-timing", "SSRN 2242795 10-month SMA timing, SPY vs T-bills",
         "trend", ("SPY",), _each(("SPY",), sma_timing_sides, total_return=False), "base/spy",
         "Keeps the month-end decision: long from a month-end close above the mean of the last 10 month-end "
         "adjusted closes until the next month-end, flat otherwise. The T-bill return of the flat months, the fill "
         "at the next open, the costs and the walk-forward choice of the window (the form fixes 10 months) are "
         "dropped."),
    Form("lib/short-strangle", "bridgingcycles-short-strangle", "BridgingCycles short strangle", "vol premium", CORE7,
         _condor_rule, None,
         "Keeps the entry rule: ATM IV (the Cboe index times 0.9 or 0.95) minus the 21-day realized volatility is "
         "above 0 and at or above the 90th percentile of its last 252 values. Adaptation: the strangle has undefined "
         "risk, so the form holds an iron condor (a put and a call credit spread, short legs at 0.16 delta, 45 days, "
         "1% of equity per side, at most 2% together). The condor opens when the entry rule holds and is held to the "
         "owner exit rule; the 50% profit take, the stop at twice the credit and the 21 DTE exit of the spec are "
         "dropped.",
         {1: (CONDOR_PUT, CONDOR_CALL)}, True),
)
