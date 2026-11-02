"""ADX filter study kernel (frozen rules: docs/specs/research/adx-filter.md).

Daily strategies with and without an ADX entry filter, a next-open fill engine, daily sleeve
returns, equal-weight portfolio metrics and the deflated Sharpe ratio. Pure Python.

Research only: no clock, network, broker or order code. A result grants no trading authority.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from statistics import NormalDist

from indicators import adx, rsi, sma

COST = 0.0005  # E2: 5 bp per side
ADX_PERIOD = 14
ADX_LEVEL = 20.0
FALLING_BARS = 5
TRADING_DAYS = 252
EULER_GAMMA = 0.5772156649015329
NORMAL = NormalDist()

Line = list[float | None]


@dataclass(frozen=True, slots=True)
class Bars:
    dates: tuple[str, ...]
    open: tuple[float, ...]
    high: tuple[float, ...]
    low: tuple[float, ...]
    close: tuple[float, ...]
    volume: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class Trade:
    side: int  # 1 long, -1 short
    entry_index: int
    entry_price: float
    exit_index: int
    exit_price: float
    reason: str
    exit_cost: bool = True


@dataclass(frozen=True, slots=True)
class Metrics:
    sharpe: float | None
    cagr: float
    max_drawdown: float
    trades: int
    days: int


def adjusted_bars(rows: Sequence[dict[str, str]]) -> tuple[Bars, list[str]]:
    """D3 and D5: scale OHLC by adj_close / close; drop invalid bars and report them."""
    kept: list[tuple[str, float, float, float, float, float]] = []
    dropped: list[str] = []
    for row in rows:
        o, h, l, c, a = (float(row[key]) for key in ("open", "high", "low", "close", "adj_close"))
        if min(o, h, l, c, a) <= 0 or l > h or not l <= o <= h or not l <= c <= h:
            dropped.append(row["date"])
            continue
        factor = a / c
        kept.append((row["date"], o * factor, h * factor, l * factor, c * factor, float(row["volume"])))
    columns = list(zip(*kept, strict=True)) if kept else [()] * 6
    return Bars(*(tuple(column) for column in columns)), dropped


def _gt(left: float | None, right: float | None) -> bool:
    return left is not None and right is not None and left > right


def adx_line(bars: Bars) -> Line:
    return adx(bars.high, bars.low, bars.close, ADX_PERIOD).adx


def filter_mask(bars: Bars, kind: str) -> list[bool]:
    """Entry filter on the signal bar: none, adx_above (ADX > 20), adx_below (ADX < 20), adx_falling."""
    if kind == "none":
        return [True] * len(bars.close)
    line = adx_line(bars)
    if kind == "adx_above":
        return [_gt(value, ADX_LEVEL) for value in line]
    if kind == "adx_below":
        return [_gt(ADX_LEVEL, value) for value in line]
    if kind == "adx_falling":
        return [index >= FALLING_BARS and _gt(line[index - FALLING_BARS], line[index]) for index in range(len(line))]
    raise ValueError(f"unknown filter {kind!r}")


def _prior_extreme(values: Sequence[float], length: int, pick: Callable[[Sequence[float]], float]) -> Line:
    return [None if index < length else pick(values[index - length : index]) for index in range(len(values))]


@dataclass(frozen=True, slots=True)
class Signals:
    entry: list[bool]
    exit: list[bool]
    stop_pct: float | None = None


def sma_cross(bars: Bars) -> Signals:
    """S1: SMA 20 crosses above SMA 50; exit SMA 20 <= SMA 50."""
    fast, slow = sma(bars.close, 20), sma(bars.close, 50)
    above = [_gt(f, s) for f, s in zip(fast, slow, strict=True)]
    entry = [index > 0 and above[index] and not above[index - 1] for index in range(len(above))]
    exit_ = [f is not None and s is not None and f <= s for f, s in zip(fast, slow, strict=True)]
    return Signals(entry, exit_)


def breakout(bars: Bars) -> Signals:
    """S2: close above the prior 20-bar high; exit close below the prior 10-bar low."""
    high = _prior_extreme(bars.high, 20, max)
    low = _prior_extreme(bars.low, 10, min)
    entry = [_gt(close, level) for close, level in zip(bars.close, high, strict=True)]
    exit_ = [_gt(level, close) for close, level in zip(bars.close, low, strict=True)]
    return Signals(entry, exit_)


def rsi2_dip(bars: Bars) -> Signals:
    """S4: RSI(2) < 10 and close > SMA(200); exit close > SMA(5)."""
    strength, trend, short = rsi(bars.close, 2), sma(bars.close, 200), sma(bars.close, 5)
    entry = [_gt(10.0, r) and _gt(c, t) for r, c, t in zip(strength, bars.close, trend, strict=True)]
    exit_ = [_gt(c, s) for c, s in zip(bars.close, short, strict=True)]
    return Signals(entry, exit_)


def rsi14_dip(bars: Bars) -> Signals:
    """S5 (template rsiReversion): RSI(14) < 30 and close > SMA(200); exit RSI(14) > 55; 8% stop."""
    strength, trend = rsi(bars.close, 14), sma(bars.close, 200)
    entry = [_gt(30.0, r) and _gt(c, t) for r, c, t in zip(strength, bars.close, trend, strict=True)]
    exit_ = [_gt(r, 55.0) for r in strength]
    return Signals(entry, exit_, stop_pct=8.0)


def run_long(bars: Bars, signals: Signals, allowed: Sequence[bool], start: int) -> list[Trade]:
    """E1, E3-E6: long-only engine. Signals at the close of bar i fill at the open of bar i+1."""
    trades: list[Trade] = []
    last = len(bars.close) - 1
    position: tuple[int, float, float | None] | None = None
    pending: str | None = None
    for index in range(last + 1):
        if pending == "entry":
            price = bars.open[index]
            stop = None if signals.stop_pct is None else price * (1 - signals.stop_pct / 100)
            position = (index, price, stop)
        elif pending == "exit":
            assert position is not None  # an exit is only pending while a position is open
            trades.append(Trade(1, position[0], position[1], index, bars.open[index], "signal"))
            position = None
        pending = None
        if position is not None and position[2] is not None:
            stop = position[2]
            if index > position[0] and bars.open[index] <= stop:
                trades.append(Trade(1, position[0], position[1], index, bars.open[index], "stop"))
                position = None
            elif bars.low[index] <= stop:
                trades.append(Trade(1, position[0], position[1], index, stop, "stop"))
                position = None
        if index == last:
            break
        if position is None:
            if index >= start and signals.entry[index] and allowed[index]:
                pending = "entry"
        elif signals.exit[index]:
            pending = "exit"
    if position is not None:
        trades.append(Trade(1, position[0], position[1], last, bars.close[last], "end", exit_cost=False))
    return trades


# S6: EMT daily proxy, frozen run() of ~/Documents/reports/vertex-emt/bt.py (daily mode).
K_ACC, WICK, VOLX, SWEEP_N, MIN_RR, TIME_STOP = 1.5, 0.5, 1.5, 20, 3.0, 10


def _ema_adjust_false(values: Sequence[float], span: int) -> list[float]:
    alpha = 2.0 / (span + 1)
    out = [values[0]]
    for value in values[1:]:
        out.append(out[-1] + alpha * (value - out[-1]))
    return out


def _rolling(values: Sequence[float], length: int, pick: Callable[[Sequence[float]], float]) -> Line:
    return [None if index < length - 1 else pick(values[index - length + 1 : index + 1]) for index in range(len(values))]


def emt_daily(bars: Bars, allowed: Sequence[bool], start: int) -> list[Trade]:
    o, h, l, c, v = bars.open, bars.high, bars.low, bars.close, bars.volume
    n = len(c)
    if n == 0:
        return []
    ema = _ema_adjust_false(c, 9)
    true_range = [h[0] - l[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])) for i in range(1, n)]
    atr_line = _rolling(true_range, 14, lambda window: math.fsum(window) / 14)
    volume_avg = [None, *_rolling(v, 20, lambda window: math.fsum(window) / 20)[:-1]]
    prior_high = [None, *_rolling(h, SWEEP_N, max)[:-1]]
    prior_low = [None, *_rolling(l, SWEEP_N, min)[:-1]]
    trades: list[Trade] = []
    i = max(30, start)
    while i < n - 1:
        rng, atr_i, vavg, hh, ll = h[i] - l[i], atr_line[i], volume_avg[i], prior_high[i], prior_low[i]
        if atr_i is None or rng <= 0 or vavg is None or hh is None or ll is None or not allowed[i]:
            i += 1
            continue
        volume_ok = v[i] >= VOLX * vavg
        mean = ema[i]
        for side in (-1, 1):
            if side == -1:
                ready = h[i] - mean >= K_ACC * atr_i and (h[i] - max(o[i], c[i])) / rng >= WICK
                ready = ready and h[i] > hh and c[i] < hh
                stop = h[i] + 0.02 * atr_i
            else:
                ready = mean - l[i] >= K_ACC * atr_i and (min(o[i], c[i]) - l[i]) / rng >= WICK
                ready = ready and l[i] < ll and c[i] > ll
                stop = l[i] - 0.02 * atr_i
            if not (ready and volume_ok):
                continue
            entry = o[i + 1]
            risk = (stop - entry) * -side
            reward = (mean - entry) * side
            if risk <= 0 or reward / risk < MIN_RR:
                continue
            j, exit_price, reason = i + 1, None, "end"
            while j < n:
                level = ema[j - 1]
                hit_stop = h[j] >= stop if side == -1 else l[j] <= stop
                hit_target = l[j] <= level if side == -1 else h[j] >= level
                if hit_stop:
                    exit_price, reason = (max(o[j], stop) if side == -1 else min(o[j], stop)), "stop"
                    break
                if hit_target:
                    exit_price, reason = level, "target"
                    break
                if j - i >= TIME_STOP:
                    exit_price, reason = c[j], "time"
                    break
                j += 1
            if exit_price is None:  # E6: still open on the last bar
                trades.append(Trade(side, i + 1, entry, n - 1, c[n - 1], "end", exit_cost=False))
                return trades
            trades.append(Trade(side, i + 1, entry, j, exit_price, reason))
            i = j
            break
        i += 1
    return trades


def sleeve_returns(bars: Bars, trades: Sequence[Trade], cost: float = COST) -> list[float]:
    """E7: daily returns of one symbol's sleeve."""
    returns = [0.0] * len(bars.close)
    close = bars.close
    for trade in trades:
        side, first, last = trade.side, trade.entry_index, trade.exit_index
        if first == last:
            returns[first] += side * (trade.exit_price / trade.entry_price - 1)
        else:
            returns[first] += side * (close[first] / trade.entry_price - 1)
            for day in range(first + 1, last):
                returns[day] += side * (close[day] / close[day - 1] - 1)
            returns[last] += side * (trade.exit_price / close[last - 1] - 1)
        returns[first] -= cost
        if trade.exit_cost:
            returns[last] -= cost
    return returns


def metrics(returns: Sequence[float], trades: int) -> Metrics:
    days = len(returns)
    equity, peak, drawdown = 1.0, 1.0, 0.0
    for value in returns:
        equity *= 1 + value
        peak = max(peak, equity)
        drawdown = min(drawdown, equity / peak - 1)
    sharpe = None
    if days > 1:
        mean = math.fsum(returns) / days
        variance = math.fsum((value - mean) ** 2 for value in returns) / (days - 1)
        sharpe = mean / math.sqrt(variance) * math.sqrt(TRADING_DAYS) if variance > 0 else None
    cagr = equity ** (TRADING_DAYS / days) - 1 if days else 0.0
    return Metrics(sharpe=sharpe, cagr=cagr, max_drawdown=-drawdown, trades=trades, days=days)


def moments(returns: Sequence[float]) -> tuple[float, float, float] | None:
    """Per-day Sharpe (sample std), skew and raw kurtosis (population moments); None without spread."""
    n = len(returns)
    if n < 2:
        return None
    mean = math.fsum(returns) / n
    m2 = math.fsum((value - mean) ** 2 for value in returns) / n
    if m2 == 0:
        return None
    m3 = math.fsum((value - mean) ** 3 for value in returns) / n
    m4 = math.fsum((value - mean) ** 4 for value in returns) / n
    sample_std = math.sqrt(m2 * n / (n - 1))
    return mean / sample_std, m3 / m2**1.5, m4 / m2**2


def expected_max_sharpe(trials: int, variance: float) -> float:
    if trials < 2:
        return 0.0
    return math.sqrt(variance) * (
        (1 - EULER_GAMMA) * NORMAL.inv_cdf(1 - 1 / trials) + EULER_GAMMA * NORMAL.inv_cdf(1 - 1 / (trials * math.e))
    )


def deflated_sharpe(sharpe: float, trials: int, variance: float, observations: int, skew: float, kurtosis: float) -> float | None:
    """Bailey and Lopez de Prado (2014); same formula as packages/api/src/quant-multiple-testing.ts."""
    benchmark = expected_max_sharpe(trials, variance)
    radicand = 1 - skew * sharpe + (kurtosis - 1) / 4 * sharpe**2
    if observations < 2 or radicand <= 0:
        return None
    return NORMAL.cdf((sharpe - benchmark) * math.sqrt(observations - 1) / math.sqrt(radicand))


@dataclass(frozen=True, slots=True)
class Variant:
    strategy: str
    filter: str


STRATEGIES: dict[str, Callable[[Bars], Signals] | None] = {
    "sma_cross_20_50": sma_cross,
    "breakout_20": breakout,
    "rsi2_dip": rsi2_dip,
    "rsi14_dip": rsi14_dip,
    "emt_daily": None,
}
TREND = ("sma_cross_20_50", "breakout_20")
VARIANTS: tuple[Variant, ...] = tuple(
    Variant(name, kind)
    for name in STRATEGIES
    for kind in (("none", "adx_above") if name in TREND else ("none", "adx_below", "adx_falling"))
)


def run_symbol(bars: Bars, variant: Variant, start: int) -> list[Trade]:
    allowed = filter_mask(bars, variant.filter)
    builder = STRATEGIES[variant.strategy]
    if builder is None:
        return emt_daily(bars, allowed, start)
    return run_long(bars, builder(bars), allowed, start)


def verdict(base_halves: Sequence[Metrics], filtered_halves: Sequence[Metrics], trades_per_year: float,
            base_trades_per_year: float, probability: float | None) -> str:
    """Frozen decision rule (docs/specs/research/adx-filter.md)."""
    if base_trades_per_year < 30:
        return "DROP (trade floor: the unfiltered strategy has fewer than 30 trades per year)"
    if trades_per_year < 30:
        return "DROP (trade floor)"
    better = all(
        f.sharpe is not None and (b.sharpe is None or f.sharpe > b.sharpe)
        for b, f in zip(base_halves, filtered_halves, strict=True)
    )
    if not better:
        return "DROP (Sharpe not higher in both halves)"
    if probability is None or probability < 0.95:
        return "KEEP (kept, not significant after deflation)"
    return "KEEP"
