"""Options forms of the QuantJourney rebalance-policy strategies and of 151 Strategies 4.1 (research only).

Seventeen rules for `forms.Form`: sixteen QuantJourney examples (O17 and the weights examples W02 to
W22 that trade ETFs on daily bars) and the base sector momentum rotation of
`strategies/sector_rotation.py`. Source files: `~/Github/tools/quantjourney-bt/strategies/`
(`example_orders_17_*`, `example_weights_NN_*`) and `backtester/portfolio/rebalance.py` of that repo.

What every rule keeps: the sign of the weight that the shares rule holds after the close of each bar.
The option book opens a spread at the close of the next bar (forms.py). Sizes are not kept.

The weights examples run in the QuantJourney rebalance engine. `shares_book` is that engine's loop
(`RebalanceEngine.run`) in plain Python: it simulates the shares portfolio from the example's target
weights (`_compute_weights`, times the engine's 95% invested share) and adjusted closes. A rule that
is an `EngineRule` returns the sign of the simulated weights. So the layers that read the shares
portfolio are kept: the drift band of W02, the drawdown breaker of W10, the turnover budget of W11
and the partial rebalance of W12. A symbol cannot trade on a bar without a close or on its first bar
(the first bar of the panel excepted). W06 trades only when the regime changes, so an ETF that starts
in a regime is bought at the next change.

Differences from the upstream run, fixed on 2026-11-11 before the first run of a form:

- Decision bar. The engine shifts the target weights by one bar: the rebalance of bar t reads the
  target of bar t-1. `shares_book` reads the target of bar t (no shift), and the option book adds its
  own one-bar delay. All other steps of the engine's loop are the same.
- Period ends (week, month, quarter) come from the NYSE holiday rules (`forms.period_ends`), so a
  rule on truncated bars gives the same stance. The engine takes the last bar on or before the
  business period end, which is the same bar on a complete calendar. Special closures are not
  modeled.
- Sizes. The risk models of W05 (inverse volatility), W17 and W18 (volatility target), W19 and W20
  (equal risk contribution, 25% cap) change the size of a weight and not its sign. They are not run.
- W19 and W20. Upstream sets the signal of every column from calendar row 63 (W20: 126) and its
  covariance uses the returns that a symbol has. On partial histories that covariance is not defined:
  upstream W19 cannot run on the study data from 1993 (it raises `Weights must contain only finite
  numeric values`). Here a symbol is held only when it has 63 (126) daily returns of its own. No
  difference when all symbols start with the calendar (the upstream run starts in 2007).
- W10. The example passes `max_drawdown_trigger=0.15` and the engine tests `drawdown < trigger`,
  which is true on every bar: upstream as written is flat on 11 of every 12 bars. The rule here is
  the stated one: flatten when the drawdown is below -15%.
- W11. The example passes no benchmark returns, so the engine's tracking-error trigger is inactive
  in the upstream run. It is inactive here too. The turnover budget is active.
- W21 and W22 read each symbol's own bars (upstream: the union calendar). They differ only where a
  symbol has a gap inside its history. Their policy is daily and has no other layer, so the stance
  is the signal of the bar.
- O17 runs in order mode (market orders, no engine). The stance changes on the signal bar.
"""
from __future__ import annotations

from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from functools import partial
from statistics import stdev

from .. import sector_rotation
from . import forms
from .forms import MULTI8, SECTOR9, SECTOR11, Form, Inputs, Panel, period_ends

__all__ = [
    "CASH_BUFFER", "DEFENSIVE", "FORMS", "RISK_ON", "EngineRule", "Gates", "bollinger_reversion",
    "circuit_breaker_trend", "defensive_rotation", "dual_momentum", "inverse_volatility", "macd_trend",
    "month_starts", "monthly_rotation", "monthly_trend_drift", "partial_drift", "risk_parity", "risk_parity_capped",
    "sector_momentum", "sector_momentum_long_short", "sector_reversal_long_short", "shares_book",
    "te_cost_gate_momentum", "vol_target_momentum", "vol_target_trend",
]

Stance = dict[str, list[int]]
# Per panel bar: symbol -> target weight (symbols with weight 0 are left out).
Targets = list[dict[str, float]]
Schedule = Callable[[Sequence[str]], list[bool]]

# The engine invests 1 - cash_buffer of the equity (backtester/portfolio/portf_data.py).
CASH_BUFFER = 0.05
# The turnover budget counts the last 252 bars (rebalance.py `_ROLLING_WINDOW`).
TURNOVER_WINDOW = 252
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


def _never(dates: Sequence[str]) -> list[bool]:
    return [False] * len(dates)


_month_ends: Schedule = partial(period_ends, period="month")
_quarter_ends: Schedule = partial(period_ends, period="quarter")
_week_ends: Schedule = partial(period_ends, period="week")


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
# The `_compute_weights` of an example: one row per panel bar, read from bars 0..i.

def _trend_targets(book: Panel, *, fast: int, slow: int, cap: float) -> Targets:
    """SMA(fast) above SMA(slow): equal weight in the active symbols, at most `cap` each."""
    quick = {symbol: _rolling(column, fast, _mean) for symbol, column in book.close.items()}
    base = {symbol: _rolling(column, slow, _mean) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        active = [symbol for symbol in book.close
                  if quick[symbol][index] is not None and base[symbol][index] is not None
                  and quick[symbol][index] > base[symbol][index]]
        out.append({symbol: min(1 / len(active), cap) for symbol in active})
    return out


def _momentum_targets(book: Panel, *, lookback: int, count: int, cap: float, positive: bool) -> Targets:
    """The `count` symbols with the highest `lookback`-bar return (only returns above 0 when `positive`):
    equal weight, at most `cap` each."""
    momentum = {symbol: forms.pct_change(column, lookback) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        scores = {symbol: values[index] for symbol, values in momentum.items()
                  if values[index] is not None and (values[index] > 0 or not positive)}
        picks = _ranked(scores, count, largest=True)
        out.append({symbol: min(1 / len(picks), cap) for symbol in picks})
    return out


def _all_targets(book: Panel, *, lookback: int) -> Targets:
    """Equal weight in every symbol that has `lookback` daily returns ending on the bar."""
    full = {symbol: _rolling(column, lookback + 1, len) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        active = [symbol for symbol in book.close if full[symbol][index] is not None]
        out.append({symbol: 1 / len(active) for symbol in active})
    return out


def _long_short_targets(book: Panel, *, lookback: int, count: int, long_high: bool) -> Targets:
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


def _regime_targets(book: Panel, *, average: int, cap: float) -> Targets:
    """W06: RISK_ON while SPY closes above its SMA, DEFENSIVE otherwise; nothing without the SMA."""
    close = book.close["SPY"]
    out: Targets = []
    for value, level in zip(close, _rolling(close, average, _mean)):
        if level is None:
            out.append({})
            continue
        assets = RISK_ON if value > level else DEFENSIVE
        out.append({symbol: min(1 / len(assets), cap) for symbol in assets})
    return out


def _tilt_targets(book: Panel, *, lookback: int, cap: float) -> Targets:
    """W12: weights in proportion to the positive `lookback`-bar returns, at most `cap` each."""
    momentum = {symbol: forms.pct_change(column, lookback) for symbol, column in book.close.items()}
    out: Targets = []
    for index in range(len(book.dates)):
        scores = {symbol: values[index] for symbol, values in momentum.items()
                  if values[index] is not None and values[index] > 0}
        total = sum(scores.values())
        out.append({symbol: min(value / total, cap) for symbol, value in scores.items()})
    return out


# --------------------------------------------------------------------------- the shares portfolio

@dataclass(frozen=True)
class Gates:
    """The layers of the QuantJourney RebalancePolicy besides the calendar. All read the shares portfolio
    or the targets up to the bar.

    `signal_change`: rebalance when a target weight differs from the bar before by more than this.
    `drift`: rebalance when a weight is further than this from its target (in points of weight).
    `partial`: at a rebalance trade only the symbols further than `drift` from target; the traded
    symbols share what the kept ones leave of the target total.
    `drawdown` / `cooldown`: flatten when the portfolio closed more than `drawdown` below its peak on
    the bar before. Stay flat for `cooldown` more bars, then rebalance and restart the peak.
    `max_turnover`: skip a rebalance that would lift the turnover of the last 252 bars above it.
    """

    signal_change: float | None = None
    drift: float | None = None
    partial: bool = False
    drawdown: float | None = None
    cooldown: int = 5
    max_turnover: float | None = None


def _returns(column: Sequence[float | None]) -> list[float | None]:
    """core.py `_compute_accounting_returns`: the return against the last known close. None where the
    symbol has no close on the bar or no close before it (the first row of the panel has return 0)."""
    out: list[float | None] = []
    last: float | None = None
    for index, value in enumerate(column):
        if value is None:
            out.append(None)
            continue
        out.append(value / last - 1 if last is not None else 0.0 if index == 0 else None)
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


def _kept(weights: Sequence[float], goal: Sequence[float], target: Sequence[float],
          keep: Sequence[bool]) -> list[float]:
    """`goal` with the weights of the kept symbols left as they are and the rest renormalized."""
    if not any(keep):
        return list(goal)
    return _renormalized([weight if kept else value for weight, value, kept in zip(weights, goal, keep)], target, keep)


def _turnover(new: Sequence[float], old: Sequence[float]) -> float:
    return sum(abs(a - b) for a, b in zip(new, old))


def _furthest(new: Sequence[float], old: Sequence[float]) -> float:
    return max(abs(a - b) for a, b in zip(new, old))


def shares_book(book: Panel, flags: Sequence[bool], targets: Targets, gates: Gates = Gates()) -> list[list[float]]:
    """Weights of the shares portfolio after the close of each panel bar (columns in the order of `book.close`).

    This is the loop of rebalance.py `RebalanceEngine.run` on targets that are not shifted. Per bar:

    1. Breaker: when the equity of the bar before is more than `drawdown` below the peak, flatten at
       this close and start the cooldown. During the cooldown nothing else is read. The bar after the
       cooldown rebalances and restarts the peak.
    2. Triggers, first match: the calendar flag, a change of the target, a weight outside the drift band.
    3. The new weights are the target; a symbol without a return on the bar keeps its weight. The
       turnover budget can refuse the rebalance (not on the first bar, which always takes its target).
    4. A partial rebalance keeps the weights inside the drift band.
    5. The weights of the bar before earn the bar's return. On a rebalance bar the new weights are
       taken as they are; on any other bar the weights drift with the returns.

    The comparisons of steps 2 to 4 use the weights after the bar before, as the engine does: on a
    rebalance bar a kept weight does not drift. Bar i reads bars 0..i only.
    """
    symbols = tuple(book.close)
    returns = [_returns(book.close[symbol]) for symbol in symbols]
    weights = [0.0] * len(symbols)
    nav = peak = 1.0
    flat = restart = False
    wait = 0
    spent: deque[float] = deque(maxlen=TURNOVER_WINDOW)
    last_target = weights
    out: list[list[float]] = []
    for index in range(len(book.dates)):
        moves = [column[index] or 0.0 for column in returns]
        earned = sum(weight * move for weight, move in zip(weights, moves))
        target = [targets[index].get(symbol, 0.0) for symbol in symbols]
        changed = (gates.signal_change is not None and index > 0
                   and _furthest(target, last_target) > gates.signal_change)
        last_target = target

        breached = (gates.drawdown is not None and not flat and not restart and index > 0
                    and nav / peak - 1 < -gates.drawdown)
        if breached or flat:
            if breached:
                flat, wait = True, gates.cooldown
                spent.append(sum(abs(weight) for weight in weights))
                weights = [0.0] * len(symbols)
            else:
                wait -= 1
                flat, restart = wait > 0, wait <= 0
                spent.append(0.0)
            nav *= 1 + earned
            peak = max(peak, nav)
            out.append(weights)
            continue

        rebalance = restart or flags[index] or changed
        if restart:
            peak = nav
        if not rebalance and gates.drift is not None and index > 0:
            rebalance = _furthest(weights, target) > gates.drift
        new: list[float] | None = None
        if rebalance or index == 0:
            missing = [column[index] is None for column in returns]
            new = _kept(weights, target, target, missing)
            if (rebalance and index > 0 and gates.max_turnover is not None
                    and sum(spent) + _turnover(new, weights) > gates.max_turnover):
                new = None
        if new is not None:
            if gates.partial and gates.drift is not None and index > 0:
                inside = [abs(weight - value) <= gates.drift for weight, value in zip(weights, new)]
                new = _kept(weights, new, target, inside)
            spent.append(_turnover(new, weights))
            restart = False
        else:
            spent.append(0.0)
        nav *= 1 + earned
        peak = max(peak, nav)
        weights = new if new is not None else _drifted(weights, moves)
        out.append(weights)
    return out


@dataclass(frozen=True)
class EngineRule:
    """A QuantJourney weights example as a rule: the sign of the weights of its simulated shares portfolio.

    `targets` is the example's `_compute_weights` and `schedule` the calendar of its rebalance policy
    (True on a rebalance bar); `gates` are the other layers of the policy.
    """

    symbols: tuple[str, ...]
    targets: Callable[[Panel], Targets]
    schedule: Schedule
    gates: Gates = Gates()

    def weights(self, inputs: Inputs) -> tuple[Panel, list[list[float]]]:
        """The panel of the symbols and the weights of the shares portfolio after each panel bar."""
        book = forms.panel(inputs, self.symbols)
        invested = [{symbol: weight * (1 - CASH_BUFFER) for symbol, weight in row.items()}
                    for row in self.targets(book)]
        return book, shares_book(book, self.schedule(book.dates), invested, self.gates)

    def __call__(self, inputs: Inputs) -> Stance:
        book, rows = self.weights(inputs)
        sides = {symbol: [1 if row[column] > HELD else -1 if row[column] < -HELD else 0 for row in rows]
                 for column, symbol in enumerate(book.close)}
        return forms.from_panel(inputs, book.dates, sides)


# --------------------------------------------------------------------------- rules in the engine

# W02: SMA(50) above SMA(200), month ends, and a rebalance when a weight is 5 points from target.
# Every change of the members moves a weight by more than 5 points, so the members follow the signal daily.
monthly_trend_drift = EngineRule(MULTI8, partial(_trend_targets, fast=50, slow=200, cap=0.30), _month_ends,
                                 Gates(drift=0.05))
# W04: at the quarter end the 2 ETFs with the highest 252-bar return, only returns above 0.
dual_momentum = EngineRule(MULTI8, partial(_momentum_targets, lookback=252, count=2, cap=0.50, positive=True),
                           _quarter_ends)
# W05 and W19: at the month end every ETF with 63 daily returns.
inverse_volatility = EngineRule(MULTI8, partial(_all_targets, lookback=63), _month_ends)
risk_parity = inverse_volatility
# W06: the regime of SPY against its SMA(200); a rebalance when a target weight changes by more than 0.01.
defensive_rotation = EngineRule(MULTI8, partial(_regime_targets, average=200, cap=0.50), _never,
                                Gates(signal_change=0.01))
# W10: the monthly trend members with a 15% drawdown breaker and a 10-bar cooldown.
circuit_breaker_trend = EngineRule(MULTI8, partial(_trend_targets, fast=50, slow=200, cap=0.30), _month_ends,
                                   Gates(drawdown=0.15, cooldown=10))
# W11: at the quarter end the 3 ETFs with the highest 126-bar return; no rebalance beyond 4x turnover
# in 252 bars. The tracking-error trigger (6%, 63 bars) is inactive in the upstream run.
te_cost_gate_momentum = EngineRule(MULTI8, partial(_momentum_targets, lookback=126, count=3, cap=0.40, positive=False),
                                   _quarter_ends, Gates(max_turnover=4.0))
# W17: the monthly trend members (the volatility target changes only the sizes).
vol_target_trend = EngineRule(MULTI8, partial(_trend_targets, fast=50, slow=200, cap=0.34), _month_ends)
# W18: at the month end the 3 ETFs with the highest 126-bar return, only returns above 0.
vol_target_momentum = EngineRule(MULTI8, partial(_momentum_targets, lookback=126, count=3, cap=0.40, positive=True),
                                 _month_ends)
# W12: every bar, targets in proportion to the positive 63-bar returns; only symbols further than
# 10 points of weight from target are traded.
partial_drift = EngineRule(SECTOR9, partial(_tilt_targets, lookback=63, cap=0.35), _every_bar,
                           Gates(drift=0.10, partial=True))
# W15: at the month end long the 3 sectors with the highest 252-bar return, short the 3 lowest.
sector_momentum_long_short = EngineRule(SECTOR9, partial(_long_short_targets, lookback=252, count=3, long_high=True),
                                        _month_ends)
# W16: at the week end long the 3 sectors with the lowest 21-bar return, short the 3 highest.
sector_reversal_long_short = EngineRule(SECTOR9, partial(_long_short_targets, lookback=21, count=3, long_high=False),
                                        _week_ends)
# W20: at the month end every sector with 126 daily returns.
risk_parity_capped = EngineRule(SECTOR9, partial(_all_targets, lookback=126), _month_ends)


# --------------------------------------------------------------------------- rules outside the engine

def _held(book: Panel, flags: Sequence[bool], targets: Targets) -> Stance:
    """Sign of the target of the last flagged bar, per panel date."""
    sides = {symbol: [0] * len(book.dates) for symbol in book.close}
    current: dict[str, float] = {}
    for index, flag in enumerate(flags):
        if flag:
            current = targets[index]
        for symbol, weight in current.items():
            sides[symbol][index] = 1 if weight > 0 else -1
    return sides


def monthly_rotation(inputs: Inputs, *, lookback: int = 126, count: int = 3) -> Stance:
    """O17: on the first bar of a month hold the `count` ETFs with the highest `lookback`-bar return.
    Order mode: names that leave the set are sold and new names are bought at market on that bar."""
    book = forms.panel(inputs, MULTI8)
    targets = _momentum_targets(book, lookback=lookback, count=count, cap=1.0, positive=False)
    return forms.from_panel(inputs, book.dates, _held(book, month_starts(book.dates), targets))


def bollinger_reversion(inputs: Inputs, *, window: int = 20, width: float = 2.0) -> Stance:
    """W21: long from a close below the lower band (`window` bars, `width` sample standard deviations)
    until a close above the `window`-bar mean. Adjusted closes of the symbol's own bars; decided every bar."""
    out: Stance = {}
    for symbol in SECTOR9:
        close = inputs.bars[symbol].adj_close
        holding = False
        sides = []
        for value, mean, deviation in zip(close, _rolling(close, window, _mean), _rolling(close, window, stdev)):
            if mean is None or deviation is None:
                holding = False
            elif not holding and value < mean - width * deviation:
                holding = True
            elif holding and value > mean:
                holding = False
            sides.append(int(holding))
        out[symbol] = sides
    return out


def macd_trend(inputs: Inputs, *, fast: int = 12, slow: int = 26, signal: int = 9) -> Stance:
    """W22: long while MACD (EMA `fast` less EMA `slow` of the adjusted close) is above its `signal`-bar
    EMA. The EMAs start at the first bar, as upstream (no warm-up); decided every bar."""
    out: Stance = {}
    for symbol in SECTOR9:
        close = inputs.bars[symbol].adj_close
        macd = [quick - base for quick, base in zip(_ewm(close, fast), _ewm(close, slow))]
        out[symbol] = [int(value > line) for value, line in zip(macd, _ewm(macd, signal))]
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

def _qj(code: str, slug: str, name: str, sleeve: str, rule: forms.Rule, keeps: str,
        symbols: tuple[str, ...] = MULTI8) -> Form:
    universe = "multi8" if symbols == MULTI8 else "sector9"
    return Form(f"qj/{code}", f"quantjourney-{slug}", f"QuantJourney {code}: {name}", sleeve, symbols, rule,
                f"base/{universe}", keeps)


FORMS: tuple[Form, ...] = (
    _qj("O17", "o17-monthly-rotation-orders", "Monthly Rotation (orders)", "rotation", monthly_rotation,
        "Keeps the members: long the 3 ETFs with the highest 126-bar return, chosen on the first bar of each "
        "month. Drops the share sizes and the order costs."),
    _qj("W02", "w02-monthly-drift-etf", "Monthly ETF Trend + Drift", "trend", monthly_trend_drift,
        "Keeps the signal of each bar: long while SMA(50) is above SMA(200), because the 5-point drift band of "
        "the simulated shares portfolio trades every change. Drops the sizes."),
    _qj("W04", "w04-quarterly-dual-momentum", "Quarterly Dual Momentum", "rotation", dual_momentum,
        "Keeps the quarter-end members: long the 2 ETFs with the highest 252-bar return, only where that "
        "return is above 0. Drops the sizes."),
    _qj("W05", "w05-monthly-inverse-vol", "Monthly Inverse Volatility", "trend", inverse_volatility,
        "Keeps the month-end dates and the members: long every ETF with 63 daily returns. Drops the "
        "inverse-volatility sizes, which are all that the rule decides."),
    _qj("W06", "w06-signal-change-defensive", "Signal-Change Defensive Rotation", "trend", defensive_rotation,
        "Keeps the regime: long SPY, EFA, EEM, DBC and VNQ while SPY closes above its SMA(200), long TLT, IEF "
        "and GLD otherwise. Drops the sizes."),
    _qj("W10", "w10-monthly-circuit-breaker", "Monthly + Circuit Breaker", "trend", circuit_breaker_trend,
        "Keeps the month-end trend members and the stated breaker: flat for 11 bars after a 15% drawdown of "
        "the simulated shares portfolio. Upstream as written compares the drawdown with plus 15%, so it is flat on "
        "11 of every 12 bars."),
    _qj("W11", "w11-quarterly-te-cost-gate", "Quarterly TE + Cost Gate", "rotation", te_cost_gate_momentum,
        "Keeps the quarter-end members (the 3 ETFs with the highest 126-bar return) and the 4x turnover budget "
        "of the simulated shares portfolio. The tracking-error trigger is inactive, as in the upstream run."),
    _qj("W17", "w17-vol-target-trend", "Vol-Targeted Trend", "trend", vol_target_trend,
        "Keeps the month-end members: long each ETF with SMA(50) above SMA(200). Drops the volatility target, "
        "which changes only the sizes."),
    _qj("W18", "w18-vol-target-momentum", "Vol-Targeted Momentum", "rotation", vol_target_momentum,
        "Keeps the month-end members: long the 3 ETFs with the highest 126-bar return, only where that return "
        "is above 0. Drops the volatility target, which changes only the sizes."),
    _qj("W19", "w19-risk-parity-multiasset", "Risk Parity (Multi-Asset ERC)", "trend", risk_parity,
        "Keeps the month-end dates and the members: long every ETF with 63 daily returns. Drops the "
        "equal-risk sizes, which are all that the rule decides."),
    _qj("W12", "w12-daily-partial-drift", "Daily Partial Drift", "rotation", partial_drift,
        "Keeps the members of the simulated shares portfolio: a position trades only when its weight is over "
        "10 points from its daily momentum target. Drops the sizes.", SECTOR9),
    _qj("W15", "w15-cross-sectional-momentum", "Cross-Sectional Momentum (L/S)", "rotation",
        sector_momentum_long_short,
        "Keeps the month-end sides: long the 3 sectors with the highest 252-bar return, short the 3 lowest. "
        "Drops the dollar-neutral sizes.", SECTOR9),
    _qj("W16", "w16-cross-sectional-reversal", "Cross-Sectional Reversal (L/S)", "mean reversion",
        sector_reversal_long_short,
        "Keeps the week-end sides: long the 3 sectors with the lowest 21-bar return, short the 3 highest. "
        "Drops the dollar-neutral sizes.", SECTOR9),
    _qj("W20", "w20-risk-parity-capped", "Risk Parity + Position Cap", "trend", risk_parity_capped,
        "Keeps the month-end dates and the members: long every sector with 126 daily returns. Drops the "
        "equal-risk sizes and the position cap.", SECTOR9),
    _qj("W21", "w21-bollinger-reversion", "Bollinger Band Reversion", "mean reversion", bollinger_reversion,
        "Keeps the daily entries and exits: long from a close below the lower 20-bar band until a close above "
        "the 20-bar mean. Drops the sizes.", SECTOR9),
    _qj("W22", "w22-macd-trend", "MACD Trend", "trend", macd_trend,
        "Keeps the daily signal: long while MACD(12, 26) is above its 9-bar signal line. Drops the sizes.", SECTOR9),
    Form("lib/151-4-1", "151-4-1-sector-momentum-rotation", "Sector momentum rotation (151 Strategies 4.1)",
         "rotation", SECTOR11, sector_momentum, "base/sector11",
         "Keeps the base variant 4.1: at each month end long the 2 sector ETFs with the highest 252-session "
         "total return. Drops the 50% sizes and the 10 bp cost."),
)
