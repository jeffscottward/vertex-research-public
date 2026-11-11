"""Options forms of the QuantJourney rebalance-policy strategies and of 151 Strategies 4.1 (research only).

Seventeen rules for `forms.Form`: sixteen QuantJourney examples (O17 and the weights examples W02 to
W22 that trade ETFs on daily bars) and the base sector momentum rotation of
`strategies/sector_rotation.py`. Source files: `~/Github/tools/quantjourney-bt/strategies/`
(`example_orders_17_*`, `example_weights_NN_*`) and `backtester/portfolio/rebalance.py` of that repo.

What every rule here keeps: the stance is the sign of the target weight decided at the close of a
rebalance bar, held until the next rebalance decision. The option book opens a spread at the close of
the next bar (forms.py). Sizes are not kept: inverse volatility, volatility target, risk parity and
position caps change only the size of a weight, so those rules keep their rebalance dates and their
members. The drift band of W02 is dropped too (a drift rebalance needs the size of the weights).

Differences from the QuantJourney engine, fixed on 2026-11-11 before the first run:

- The engine trades on bar t the weights of the signal of bar t-1. Here the decision uses the signal
  of the rebalance bar itself and the option book adds the one-bar delay.
- Period ends (week, month, quarter) come from the NYSE holiday rules (`forms.period_ends`), not from the
  next bar, so a rule on truncated bars gives the same stance. Special closures are not modeled;
  none falls on a period end between 2005 and 2026.
- W10, W11 and W12 gate on the shares portfolio. `shares_book` simulates that portfolio inside the
  rule from the rule's own target weights (the example's weights times the engine's 95% invested
  share) and adjusted closes, filled at the close of the rebalance bar.
- W10 passes `max_drawdown_trigger=0.15` and the engine tests `drawdown < trigger`, which is true on
  every bar. This rule uses the stated intent: flatten when the drawdown is below -15%.
- W11 does not pass `benchmark_returns`, so the engine logs the tracking-error trigger as inactive.
  This rule uses the stated intent: tracking error against SPY (the example's benchmark symbol).
"""
from __future__ import annotations

import math
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from statistics import stdev

from .. import sector_rotation
from . import forms
from .forms import MULTI8, SECTOR9, SECTOR11, Form, Inputs, Panel, period_ends

__all__ = [
    "CASH_BUFFER", "DEFENSIVE", "FORMS", "RISK_ON", "Gates", "bollinger_reversion", "circuit_breaker_trend",
    "defensive_rotation", "dual_momentum", "inverse_volatility", "macd_trend", "month_starts", "monthly_rotation",
    "monthly_trend", "partial_drift", "risk_parity", "risk_parity_capped",
    "sector_momentum", "sector_momentum_long_short", "sector_reversal_long_short", "shares_book",
    "te_cost_gate_momentum", "vol_target_momentum",
]

Stance = dict[str, list[int]]
# Per panel bar: symbol -> target weight (symbols with weight 0 are left out).
Targets = list[dict[str, float]]

TRADING_DAYS = 252
# The engine invests 1 - cash_buffer of the equity (backtester/portfolio/portf_data.py).
CASH_BUFFER = 0.05
HELD = 1e-9
# W06 (example_weights_06_signal_change_defensive.py): risk_on_assets and defensive_assets.
RISK_ON = ("SPY", "EFA", "EEM", "DBC", "VNQ")
DEFENSIVE = ("TLT", "IEF", "GLD")


# --------------------------------------------------------------------------- rebalance bars

def month_starts(dates: Sequence[str]) -> list[bool]:
    """True on the first bar of each month. The first bar counts (O17 starts with no last month)."""
    return [index == 0 or text[:7] != dates[index - 1][:7] for index, text in enumerate(dates)]


def _every_bar(dates: Sequence[str]) -> list[bool]:
    return [True] * len(dates)


# --------------------------------------------------------------------------- indicators on panel columns
# One value per bar; None where the window is not full or has a missing close. Bar i reads bars 0..i only.

def _rolling(values: Sequence[float | None], length: int,
             function: Callable[[Sequence[float]], float]) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    for index in range(length - 1, len(values)):
        window = values[index - length + 1:index + 1]
        if None not in window:
            out[index] = function(window)  # type: ignore[arg-type]
    return out


def _mean(window: Sequence[float]) -> float:
    return sum(window) / len(window)


def _ewm(values: Sequence[float], span: int) -> list[float]:
    """pandas ewm(span, adjust=False).mean(): started at the first value, a value on every bar."""
    alpha = 2 / (span + 1)
    out: list[float] = []
    for value in values:
        out.append(value if not out else alpha * value + (1 - alpha) * out[-1])
    return out


def _ranked(scores: Mapping[str, float], count: int, *, largest: bool) -> list[str]:
    """pandas nlargest / nsmallest: ties keep the column order (the order of `scores`)."""
    return sorted(scores, key=lambda symbol: -scores[symbol] if largest else scores[symbol])[:count]


# --------------------------------------------------------------------------- target weights

def _trend_targets(book: Panel, cap: float) -> Targets:
    """SMA(50) above SMA(200): equal weight in the active symbols, at most `cap` each."""
    fast = {symbol: _rolling(column, 50, _mean) for symbol, column in book.close.items()}
    slow = {symbol: _rolling(column, 200, _mean) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        active = [symbol for symbol in book.close
                  if slow[symbol][index] is not None and fast[symbol][index] > slow[symbol][index]]
        out.append({symbol: min(1 / len(active), cap) for symbol in active})
    return out


def _momentum_targets(book: Panel, lookback: int, count: int, cap: float, *, positive: bool) -> Targets:
    """The `count` symbols with the highest `lookback`-bar return (only returns above 0 when `positive`)."""
    momentum = {symbol: forms.pct_change(column, lookback) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        scores = {symbol: values[index] for symbol, values in momentum.items()
                  if values[index] is not None and (values[index] > 0 or not positive)}
        picks = _ranked(scores, count, largest=True)
        out.append({symbol: min(1 / len(picks), cap) for symbol in picks})
    return out


def _all_targets(book: Panel, lookback: int) -> Targets:
    """Equal weight in every symbol that has `lookback` daily returns ending on the bar."""
    full = {symbol: _rolling(column, lookback + 1, len) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        active = [symbol for symbol in book.close if full[symbol][index] is not None]
        out.append({symbol: 1 / len(active) for symbol in active})
    return out


def _long_short_targets(book: Panel, lookback: int, count: int, *, long_high: bool) -> Targets:
    """+0.5 over `count` symbols at one end of the `lookback`-bar return ranking and -0.5 over `count`
    at the other end; nothing with fewer than 2 x `count` ranked symbols. A symbol at both ends is short."""
    returns = {symbol: forms.pct_change(column, lookback) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        scores = {symbol: values[index] for symbol, values in returns.items() if values[index] is not None}
        row: dict[str, float] = {}
        if len(scores) >= 2 * count:
            row.update(dict.fromkeys(_ranked(scores, count, largest=long_high), 0.5 / count))
            row.update(dict.fromkeys(_ranked(scores, count, largest=not long_high), -0.5 / count))
        out.append(row)
    return out


def _regime_targets(book: Panel) -> Targets:
    """W06: RISK_ON while SPY closes above its SMA(200), DEFENSIVE otherwise; nothing without the SMA."""
    close = book.close["SPY"]
    average = _rolling(close, 200, _mean)
    out: Targets = []
    for value, level in zip(close, average):
        if level is None:
            out.append({})
            continue
        assets = RISK_ON if value > level else DEFENSIVE
        out.append({symbol: min(1 / len(assets), 0.50) for symbol in assets})
    return out


def _tilt_targets(book: Panel, lookback: int, cap: float) -> Targets:
    """W12: weights in proportion to the positive `lookback`-bar returns, at most `cap` each."""
    momentum = {symbol: forms.pct_change(column, lookback) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        scores = {symbol: values[index] for symbol, values in momentum.items()
                  if values[index] is not None and values[index] > 0}
        total = sum(scores.values())
        out.append({symbol: min(value / total, cap) for symbol, value in scores.items()})
    return out


def _invested(targets: Targets) -> Targets:
    return [{symbol: weight * (1 - CASH_BUFFER) for symbol, weight in row.items()} for row in targets]


# --------------------------------------------------------------------------- stance of a calendar rule

def _held(book: Panel, flags: Sequence[bool], targets: Targets) -> Stance:
    """Sign of the target of the last rebalance bar, per panel date."""
    sides = {symbol: [0] * len(book.dates) for symbol in book.close}
    current: dict[str, float] = {}
    for index, flag in enumerate(flags):
        if flag:
            current = targets[index]
        for symbol, weight in current.items():
            sides[symbol][index] = 1 if weight > 0 else -1
    return sides


# --------------------------------------------------------------------------- the shares portfolio

@dataclass(frozen=True)
class Gates:
    """The layers of the QuantJourney RebalancePolicy that read the shares portfolio.

    `drawdown` / `cooldown`: flatten when the portfolio is more than `drawdown` below its peak, stay
    flat for `cooldown` bars, then rebalance on the next bar and restart the peak.
    `te_threshold` / `te_window`: rebalance early when the annualized tracking error against the
    benchmark over the last `te_window` bars is above the threshold.
    `max_turnover`: skip a rebalance that would lift the turnover of the last 252 bars above it.
    `partial_drift`: at a rebalance trade only the symbols whose weight is further than this from
    target; the traded symbols share what the kept ones leave of the target total.
    """

    drawdown: float | None = None
    cooldown: int = 0
    te_threshold: float | None = None
    te_window: int = 21
    max_turnover: float | None = None
    partial_drift: float | None = None


def _returns(column: Sequence[float | None]) -> list[float | None]:
    """Daily return against the last known close; None where the symbol has no close on the bar."""
    out: list[float | None] = []
    last: float | None = None
    for value in column:
        out.append(None if value is None else 0.0 if last is None else value / last - 1)
        if value is not None:
            last = value
    return out


def _drifted(weights: Sequence[float], returns: Sequence[float]) -> list[float]:
    """Weights after one bar; the cash share (1 - sum of weights) earns nothing."""
    grown = [weight * (1 + change) for weight, change in zip(weights, returns)]
    total = 1 - sum(weights) + sum(grown)
    return [0.0] * len(grown) if abs(total) <= 1e-12 else [value / total for value in grown]


def _renormalized(new: list[float], target: Sequence[float], keep: Sequence[bool]) -> list[float]:
    """rebalance.py `_renormalize_traded_sleeve`: scale the traded targets to the target total less the
    kept weights, never above the gross target less the kept gross."""
    traded = [index for index, kept in enumerate(keep) if not kept]
    if not traded:
        return new
    kept_net = sum(new[index] for index, kept in enumerate(keep) if kept)
    kept_gross = sum(abs(new[index]) for index, kept in enumerate(keep) if kept)
    traded_net = sum(target[index] for index in traded)
    traded_gross = sum(abs(target[index]) for index in traded)
    room = max(sum(abs(value) for value in target) - kept_gross, 0.0)
    if abs(sum(target)) > 1e-12 and abs(traded_net) > 1e-12:
        scale = max((sum(target) - kept_net) / traded_net, 0.0)
        if traded_gross > 1e-12 and scale * traded_gross > room + 1e-12:
            scale = room / traded_gross
    elif traded_gross > 1e-12:
        scale = room / traded_gross
    else:
        return new
    for index in traded:
        new[index] = target[index] * scale
    return new


def shares_book(book: Panel, flags: Sequence[bool], targets: Targets, gates: Gates,
                benchmark: str | None = None) -> list[list[float]]:
    """Weights of the shares portfolio after the close of each panel bar (columns in the order of `book.close`).

    Per bar: the weights held since the last close earn the bar's adjusted-close return and drift;
    then the gates and the calendar flag decide on that close, and a rebalance fills at that close.
    The order of the layers is the engine's (rebalance.py `RebalanceEngine.run`): drawdown breaker,
    cooldown, calendar, tracking error, turnover budget, partial rebalance. A symbol without a close
    on the bar is not traded. Bar i reads bars 0..i only.
    """
    symbols = tuple(book.close)
    returns = [_returns(book.close[symbol]) for symbol in symbols]
    reference = _returns(book.close[benchmark]) if benchmark is not None else None
    weights = [0.0] * len(symbols)
    nav = peak = 1.0
    flat = restart = False
    wait = 0
    turnover: deque[float] = deque(maxlen=TRADING_DAYS)
    active: list[float] = []
    out: list[list[float]] = []
    for index in range(len(book.dates)):
        moves = [column[index] or 0.0 for column in returns]
        earned = sum(weight * move for weight, move in zip(weights, moves))
        nav *= 1 + earned
        peak = max(peak, nav)
        if reference is not None:
            active.append(earned - (reference[index] or 0.0))
        weights = _drifted(weights, moves)

        if gates.drawdown is not None and not flat and not restart and nav / peak - 1 < -gates.drawdown:
            flat, wait = True, gates.cooldown
            turnover.append(sum(abs(weight) for weight in weights))
            weights = [0.0] * len(symbols)
            out.append(weights)
            continue
        if flat:
            wait -= 1
            if wait <= 0:
                flat, restart = False, True
            turnover.append(0.0)
            out.append(weights)
            continue

        rebalance = restart or flags[index]
        if restart:
            peak = nav
        if (not rebalance and gates.te_threshold is not None and reference is not None
                and len(active) >= gates.te_window):
            error = stdev(active[-gates.te_window:]) * math.sqrt(TRADING_DAYS)
            rebalance = error > gates.te_threshold
        traded = 0.0
        if rebalance:
            target = [targets[index].get(symbol, 0.0) for symbol in symbols]
            missing = [column[index] is None for column in returns]
            new = [weight if gone else goal for weight, goal, gone in zip(weights, target, missing)]
            if any(missing):
                new = _renormalized(new, target, missing)
            if (gates.max_turnover is not None
                    and sum(turnover) + sum(abs(a - b) for a, b in zip(new, weights)) > gates.max_turnover):
                rebalance = False
        if rebalance:
            if gates.partial_drift is not None:
                keep = [abs(weight - goal) <= gates.partial_drift for weight, goal in zip(weights, new)]
                new = [weight if kept else goal for weight, goal, kept in zip(weights, new, keep)]
                new = _renormalized(new, target, keep)
            traded = sum(abs(a - b) for a, b in zip(new, weights))
            weights = new
            restart = False
        turnover.append(traded)
        out.append(weights)
    return out


def _signs(book: Panel, rows: Sequence[Sequence[float]]) -> Stance:
    return {symbol: [1 if row[column] > HELD else -1 if row[column] < -HELD else 0 for row in rows]
            for column, symbol in enumerate(book.close)}


# --------------------------------------------------------------------------- rules

Schedule = Callable[[Sequence[str]], list[bool]]


def _month_ends(dates: Sequence[str]) -> list[bool]:
    return period_ends(dates, "month")


def _quarter_ends(dates: Sequence[str]) -> list[bool]:
    return period_ends(dates, "quarter")


def _week_ends(dates: Sequence[str]) -> list[bool]:
    return period_ends(dates, "week")


def _scheduled(symbols: Sequence[str], schedule: Schedule, targets: Callable[[Panel], Targets]) -> forms.Rule:
    """A rule that holds the sign of the target of the last scheduled bar."""
    def rule(inputs: Inputs) -> Stance:
        book = forms.panel(inputs, symbols)
        return forms.from_panel(inputs, book.dates, _held(book, schedule(book.dates), targets(book)))
    return rule


def _gated(symbols: Sequence[str], schedule: Schedule, targets: Callable[[Panel], Targets], gates: Gates,
           benchmark: str | None = None) -> forms.Rule:
    """A rule that holds the sign of the weights of the simulated shares portfolio."""
    def rule(inputs: Inputs) -> Stance:
        book = forms.panel(inputs, symbols)
        rows = shares_book(book, schedule(book.dates), _invested(targets(book)), gates, benchmark)
        return forms.from_panel(inputs, book.dates, _signs(book, rows))
    return rule


# O17: on the first bar of a month hold the 3 ETFs with the highest 126-bar return.
monthly_rotation = _scheduled(MULTI8, month_starts,
                              lambda book: _momentum_targets(book, 126, 3, 1.0, positive=False))
# W02 and W17: at the month end hold the ETFs with SMA(50) above SMA(200).
monthly_trend = _scheduled(MULTI8, _month_ends, lambda book: _trend_targets(book, 0.30))
# W04: at the quarter end hold the 2 ETFs with the highest 252-bar return, only returns above 0.
dual_momentum = _scheduled(MULTI8, _quarter_ends,
                           lambda book: _momentum_targets(book, 252, 2, 0.50, positive=True))
# W05 and W19: at the month end hold every ETF with 63 daily returns.
inverse_volatility = _scheduled(MULTI8, _month_ends, lambda book: _all_targets(book, 63))
risk_parity = inverse_volatility
# W10: the monthly trend rule with a 15% drawdown breaker and a 10-bar cooldown.
circuit_breaker_trend = _gated(MULTI8, _month_ends, lambda book: _trend_targets(book, 0.30),
                               Gates(drawdown=0.15, cooldown=10))
# W11: at the quarter end hold the 3 ETFs with the highest 126-bar return; early rebalance on a
# 63-bar tracking error above 6% against SPY; no rebalance beyond 4x turnover in 252 bars.
te_cost_gate_momentum = _gated(MULTI8, _quarter_ends,
                               lambda book: _momentum_targets(book, 126, 3, 0.40, positive=False),
                               Gates(te_threshold=0.06, te_window=63, max_turnover=4.0), benchmark="SPY")
# W18: at the month end hold the 3 ETFs with the highest 126-bar return, only returns above 0.
vol_target_momentum = _scheduled(MULTI8, _month_ends,
                                 lambda book: _momentum_targets(book, 126, 3, 0.40, positive=True))
# W12: every bar, weights in proportion to the positive 63-bar returns; only symbols further than
# 10 points of weight from target are traded.
partial_drift = _gated(SECTOR9, _every_bar, lambda book: _tilt_targets(book, 63, 0.35), Gates(partial_drift=0.10))
# W15: at the month end long the 3 sectors with the highest 252-bar return, short the 3 lowest.
sector_momentum_long_short = _scheduled(SECTOR9, _month_ends,
                                        lambda book: _long_short_targets(book, 252, 3, long_high=True))
# W16: at the week end long the 3 sectors with the lowest 21-bar return, short the 3 highest.
sector_reversal_long_short = _scheduled(SECTOR9, _week_ends,
                                        lambda book: _long_short_targets(book, 21, 3, long_high=False))
# W20: at the month end hold every sector with 126 daily returns.
risk_parity_capped = _scheduled(SECTOR9, _month_ends, lambda book: _all_targets(book, 126))


def defensive_rotation(inputs: Inputs) -> Stance:
    """W06: the risk ETFs while SPY closes above its SMA(200), the defensive ETFs otherwise.

    The engine rebalances when a target weight changes by more than 0.01, which is every change of
    the regime, so the stance is the regime of the bar.
    """
    book = forms.panel(inputs, MULTI8)
    targets = _regime_targets(book)
    flags = [index == 0 or any(abs(row.get(symbol, 0.0) - targets[index - 1].get(symbol, 0.0)) > 0.01
                               for symbol in book.close)
             for index, row in enumerate(targets)]
    return forms.from_panel(inputs, book.dates, _held(book, flags, targets))


def bollinger_reversion(inputs: Inputs) -> Stance:
    """W21: long from a close below the lower band (20 bars, 2 sample standard deviations) until a
    close above the 20-bar mean. Adjusted closes of the symbol's own bars; decided every bar."""
    out: Stance = {}
    for symbol in SECTOR9:
        close = inputs.bars[symbol].adj_close
        middle = _rolling(close, 20, _mean)
        spread = _rolling(close, 20, stdev)
        holding = False
        sides = []
        for value, mean, deviation in zip(close, middle, spread):
            if mean is None or deviation is None:
                holding = False
            elif not holding and value < mean - 2.0 * deviation:
                holding = True
            elif holding and value > mean:
                holding = False
            sides.append(int(holding))
        out[symbol] = sides
    return out


def macd_trend(inputs: Inputs) -> Stance:
    """W22: long while MACD (EMA 12 less EMA 26 of the adjusted close) is above its 9-bar EMA.
    The EMAs start at the first bar, as upstream (no warm-up); decided every bar."""
    out: Stance = {}
    for symbol in SECTOR9:
        close = inputs.bars[symbol].adj_close
        macd = [fast - slow for fast, slow in zip(_ewm(close, 12), _ewm(close, 26))]
        out[symbol] = [int(value > line) for value, line in zip(macd, _ewm(macd, 9))]
    return out


def sector_momentum(inputs: Inputs) -> Stance:
    """151 Strategies 4.1, base variant: at the last session of a month hold the 2 sector ETFs with the
    highest 252-session total return (`sector_rotation.target_weights`), until the next month end
    with a ranking. No ranking (fewer than 3 rankable ETFs) leaves the holding unchanged."""
    book = forms.panel(inputs, SECTOR11)
    days = [date.fromisoformat(text) for text in book.dates]
    prices = {symbol: {day: value for day, value in zip(days, column) if value is not None}
              for symbol, column in book.close.items()}
    flags = [False] * len(days)
    targets: Targets = [{}] * len(days)
    for index, end in enumerate(period_ends(book.dates, "month")):
        decision = sector_rotation.target_weights("base", prices, days, index, SECTOR11) if end else None
        if decision is not None:
            flags[index], targets[index] = True, decision.weights
    return forms.from_panel(inputs, book.dates, _held(book, flags, targets))


# --------------------------------------------------------------------------- forms

_SIZES = "The sizes are not kept."
_GATE = "The gate reads the shares portfolio, simulated inside the rule from the rule's target weights."


def _qj(code: str, slug: str, name: str, sleeve: str, symbols: tuple[str, ...], rule: forms.Rule, keeps: str) -> Form:
    universe = "multi8" if symbols == MULTI8 else "sector9"
    return Form(f"qj/{code}", f"quantjourney-{slug}", f"QuantJourney {code}: {name}", sleeve, symbols, rule,
                f"base/{universe}", keeps)


FORMS: tuple[Form, ...] = (
    _qj("O17", "o17-monthly-rotation-orders", "Monthly Rotation (orders)", "rotation", MULTI8, monthly_rotation,
        "Keeps the members: long the 3 ETFs with the highest 126-bar return, chosen on the first bar of each "
        "month. Drops the equal share sizes and the order costs."),
    _qj("W02", "w02-monthly-drift-etf", "Monthly ETF Trend + Drift", "trend", MULTI8, monthly_trend,
        "Keeps the month-end members: long each ETF with SMA(50) above SMA(200). Drops the 5-point drift "
        f"rebalance between month ends and the 30% cap. {_SIZES}"),
    _qj("W04", "w04-quarterly-dual-momentum", "Quarterly Dual Momentum", "rotation", MULTI8, dual_momentum,
        "Keeps the quarter-end members: long the 2 ETFs with the highest 252-bar return, only when that "
        f"return is above 0. {_SIZES}"),
    _qj("W05", "w05-monthly-inverse-vol", "Monthly Inverse Volatility", "trend", MULTI8, inverse_volatility,
        "Keeps the month-end dates and the members: long every ETF with 63 daily returns. Drops the "
        "inverse-volatility sizes, which are all the rule decides."),
    _qj("W06", "w06-signal-change-defensive", "Signal-Change Defensive Rotation", "trend", MULTI8,
        defensive_rotation,
        "Keeps the regime: long SPY, EFA, EEM, DBC and VNQ while SPY closes above its SMA(200), long TLT, IEF "
        f"and GLD otherwise, changed on the bar the regime changes. {_SIZES}"),
    _qj("W10", "w10-monthly-circuit-breaker", "Monthly + Circuit Breaker", "trend", MULTI8, circuit_breaker_trend,
        "Keeps the month-end trend members (SMA(50) above SMA(200)) and the breaker: flat after a 15% drawdown "
        f"for 10 bars, then back to the members. {_GATE} The sizes of the option positions are not kept."),
    _qj("W11", "w11-quarterly-te-cost-gate", "Quarterly TE + Cost Gate", "rotation", MULTI8, te_cost_gate_momentum,
        "Keeps the members (the 3 ETFs with the highest 126-bar return), rebalanced at quarter ends and early "
        "when the 63-bar tracking error against SPY is above 6%, unless the turnover of the last 252 bars "
        f"would pass 4x. {_GATE} The sizes of the option positions are not kept."),
    _qj("W17", "w17-vol-target-trend", "Vol-Targeted Trend", "trend", MULTI8, monthly_trend,
        "Keeps the month-end members: long each ETF with SMA(50) above SMA(200). Drops the 10% volatility "
        "target, which changes only the sizes, so the stance equals W02."),
    _qj("W18", "w18-vol-target-momentum", "Vol-Targeted Momentum", "rotation", MULTI8, vol_target_momentum,
        "Keeps the month-end members: long the 3 ETFs with the highest 126-bar return, only returns above 0. "
        "Drops the 15% volatility target, which changes only the sizes."),
    _qj("W19", "w19-risk-parity-multiasset", "Risk Parity (Multi-Asset ERC)", "trend", MULTI8, risk_parity,
        "Keeps the month-end dates and the members: long every ETF with 63 daily returns. Drops the "
        "equal-risk sizes, which are all the rule decides, so the stance equals W05."),
    _qj("W12", "w12-daily-partial-drift", "Daily Partial Drift", "rotation", SECTOR9, partial_drift,
        "Keeps the members of the partially rebalanced book: daily targets in proportion to the positive "
        f"63-bar returns, traded only where a weight is more than 10 points from target. {_GATE} The sizes "
        "of the option positions are not kept."),
    _qj("W15", "w15-cross-sectional-momentum", "Cross-Sectional Momentum (L/S)", "rotation", SECTOR9,
        sector_momentum_long_short,
        "Keeps the month-end sides: long the 3 sectors with the highest 252-bar return, short the 3 lowest. "
        "Drops the dollar-neutral sizes."),
    _qj("W16", "w16-cross-sectional-reversal", "Cross-Sectional Reversal (L/S)", "mean reversion", SECTOR9,
        sector_reversal_long_short,
        "Keeps the week-end sides: long the 3 sectors with the lowest 21-bar return, short the 3 highest. "
        "Drops the dollar-neutral sizes."),
    _qj("W20", "w20-risk-parity-capped", "Risk Parity + Position Cap", "trend", SECTOR9, risk_parity_capped,
        "Keeps the month-end dates and the members: long every sector with 126 daily returns. Drops the "
        "equal-risk sizes and the 25% cap, which are all the rule decides."),
    _qj("W21", "w21-bollinger-reversion", "Bollinger Band Reversion", "mean reversion", SECTOR9,
        bollinger_reversion,
        "Keeps the daily entries and exits: long from a close below the lower 20-bar band (2 standard "
        f"deviations) until a close above the 20-bar mean. {_SIZES}"),
    _qj("W22", "w22-macd-trend", "MACD Trend", "trend", SECTOR9, macd_trend,
        f"Keeps the daily signal: long while MACD(12, 26) is above its 9-bar signal line. {_SIZES}"),
    Form("lib/151-4-1", "151-4-1-sector-momentum-rotation", "Sector momentum rotation (151 Strategies 4.1)",
         "rotation", SECTOR11, sector_momentum, "base/sector11",
         "Keeps the base variant 4.1: at the last session of each month long the 2 sector ETFs with the "
         "highest 252-session total return. Drops the equal 50% sizes and the 10 bp cost."),
)
