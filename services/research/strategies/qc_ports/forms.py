"""Options forms of library strategies that only have a shares form (research only).

A form keeps one thing of a shares rule: its stance per traded symbol and day. The stance is +1
(the rule is long), -1 (the rule is short) or 0 (flat), known at the close of that day. The form
turns the stance into defined-risk option spreads with the option book of this package:

- +1 holds the call debit vertical of the qc study (ideas.MONTHLY_CALL), -1 the put debit
  vertical (ideas.MONTHLY_PUT). A form can name other structures per side (`Form.structures`).
- One open spread per symbol and side (a side with two structures opens both or neither, as one
  package). A stance at bar i opens the spread at the close
  of bar i+1 (the book rule). The spread closes at the close of the bar after the stance ends, or
  under the owner exit rule (allocation.owner_exit). While the stance lasts, the next spread opens
  the bar after the last one closed.
- An entry-only form (`Form.entry_only`) has a rule that only says when to open: the end of the
  stance closes nothing, and the spread stays open until the owner exit rule closes it.
- The weight of the shares rule is not kept: every spread risks `maxLossPct` of the equity.
- The bars are split-adjusted. For an underlying with a split history (`raw_factors`) a spread is
  priced at the prices of its entry day: every close times the product of the split ratios after
  the entry day. So the strike grid, the commission and the contract count are those of the price
  the underlying traded at, and a split during the trade changes nothing (as for a listed option).
- A spread less than `MIN_WIDTH_STEPS` strike steps wide, or with a premium per contract below its
  entry commission, is not opened (`degenerate`): there the strike grid and the fee floors decide
  the result, not the rule.

A rule is a pure function of `Inputs` (daily bars and IV index levels). It must not read a bar
after the day it sets the stance for; `tests/test_qc_ports_forms.py` checks this for every rule.

Underlyings without a Cboe IV index get a proxy index (`proxy_iv_index`) and a cost model by class
(`PROXY_MODELS`). `proxy_symbols` adds them to the symbol tables of data.py and options.py for the
time of one study run. Both are model assumptions, fixed on 2026-11-11 before the first run of a
form: research/backtests/options-forms/README.md.
"""
from __future__ import annotations

import contextlib
import dataclasses
import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from statistics import pstdev

from . import allocation as al
from . import data as qd
from . import options as om
from .book import CALENDARS, PricedTrade, SignalEvent, build_book
from .calendar import is_nyse_holiday
from .data import MAX_FILL_DAYS, Bars, Market, align
from .ideas import CORE7, MONTHLY_CALL, MONTHLY_PUT

__all__ = [
    "CORE7", "FUTURES_TWINS", "FX_TWINS", "LONG_SHORT", "MULTI8", "PROXY_ATM_FACTOR", "PROXY_MODELS", "SECTOR9",
    "SECTOR11", "Form", "FormBook", "Inputs", "NotRun", "ProxyModel", "adjusted", "always_on", "always_on_after",
    "continuous", "degenerate", "distributions", "dividend_yield", "ema", "first_priced", "form_book", "form_trades",
    "from_panel", "highest", "is_always_on", "lowest", "next_session", "panel", "pct_change", "period_ends",
    "proxy_index_id", "proxy_iv_index", "proxy_market", "proxy_symbols", "raw_factors", "raw_priced", "rolling_stdev",
    "rsi", "sma", "stance_of",
]

# --------------------------------------------------------------------------- universes

MULTI8 = ("SPY", "EFA", "EEM", "TLT", "IEF", "GLD", "DBC", "VNQ")
SECTOR9 = ("XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY")
SECTOR11 = (*SECTOR9, "XLRE", "XLC")
# Listed ETF twins of the QuantJourney FX pairs (EURUSD, GBPUSD, AUDUSD; NZDUSD has no ETF with options)
# and futures (MES, MNQ, ZN, CL, GC, ZC). The rule reads the twin's own bars.
FX_TWINS = ("FXE", "FXB", "FXA")
FUTURES_TWINS = ("SPY", "QQQ", "IEF", "USO", "GLD", "CORN")


# --------------------------------------------------------------------------- forms

@dataclass(frozen=True)
class Inputs:
    """What a rule reads. `bars`: traded symbol -> daily bars. `iv_index`: traded symbol -> IV index
    level in percent per bar of that symbol (None where the index has no value)."""

    bars: Mapping[str, Bars]
    iv_index: Mapping[str, Sequence[float | None]]


Rule = Callable[[Inputs], Mapping[str, Sequence[int]]]
LONG_SHORT: Mapping[int, tuple[Mapping, ...]] = {1: (MONTHLY_CALL,), -1: (MONTHLY_PUT,)}


@dataclass(frozen=True)
class Form:
    """The options form of one library strategy.

    `rule` gives the stance per traded symbol (one value per bar of that symbol). `structures`
    maps a side to the option blocks (book.parse_options) it holds. `baseline` is the key of the
    always-on form of the same universe (check G7 of the allocation gate), None for a form that has
    no long-only baseline. `keeps` says in one or two short sentences what the form keeps and drops.
    `entry_only`: the rule only opens spreads; the owner exit rule alone closes them.
    """

    key: str
    slug: str
    name: str
    sleeve: str
    symbols: tuple[str, ...]
    rule: Rule
    baseline: str | None
    keeps: str
    structures: Mapping[int, tuple[Mapping, ...]] = field(default_factory=lambda: LONG_SHORT)
    entry_only: bool = False


@dataclass(frozen=True)
class NotRun:
    """A library strategy without a form here, with the reason."""

    slug: str
    reason: str


def always_on(inputs: Inputs) -> dict[str, list[int]]:
    """The baseline rule: long every symbol on every bar."""
    return {symbol: [1] * len(bars) for symbol, bars in inputs.bars.items()}


def always_on_after(delay: int) -> Rule:
    """The baseline rule started `delay` bars after the first IV value of each symbol (another phase of the
    same basket: the spreads of a symbol follow each other, so the first entry day sets all later ones)."""
    def rule(inputs: Inputs) -> dict[str, list[int]]:
        out = {}
        for symbol, bars in inputs.bars.items():
            levels = inputs.iv_index[symbol]
            first = next((index for index, value in enumerate(levels) if value is not None), len(bars))
            out[symbol] = [int(index >= first + delay) for index in range(len(bars))]
        return out
    return rule


def is_always_on(stance: Mapping[str, Sequence[int]], symbols: Sequence[str]) -> bool:
    """True when every one of `symbols` is flat until its first long bar and long on every bar after it
    (the stance of a baseline that starts late): such a form holds the always-on basket of its universe."""
    def late_baseline(sides: Sequence[int]) -> bool:
        first = next((index for index, side in enumerate(sides) if side != 0), len(sides))
        return first < len(sides) and all(side == 1 for side in sides[first:])

    return bool(symbols) and all(symbol in stance and late_baseline(stance[symbol]) for symbol in symbols)


def stance_of(form: Form, inputs: Inputs) -> dict[str, list[int]]:
    """The rule's stance, checked: only symbols of the form, one side per bar, sides the form has a structure for."""
    stance = {symbol: list(sides) for symbol, sides in form.rule(inputs).items()}
    for symbol, sides in stance.items():
        if symbol not in form.symbols:
            raise ValueError(f"{form.key}: stance for {symbol}, which is not a symbol of the form")
        if len(sides) != len(inputs.bars[symbol]):
            raise ValueError(f"{form.key}: {symbol} has {len(sides)} stance values for {len(inputs.bars[symbol])} bars")
        unknown = {side for side in sides if side != 0 and side not in form.structures}
        if unknown:
            raise ValueError(f"{form.key}: {symbol} has sides without a structure: {sorted(unknown)}")
    return stance


def _spans(sides: Sequence[int], side: int) -> list[tuple[int, int | None]]:
    """(signal bar, first later bar where the stance is not `side`) for every bar with that stance."""
    out: list[tuple[int, int | None]] = []
    following: int | None = None
    for index in range(len(sides) - 1, -1, -1):
        if sides[index] == side:
            out.append((index, following))
        else:
            following = index
    out.reverse()
    return out


MIN_WIDTH_STEPS = 2
LEGS = 2


def raw_factors(dates: Sequence[str], splits: Mapping[str, float]) -> list[float]:
    """Per bar: raw close over split-adjusted close, the product of the ratios of the splits after that date.

    `splits` maps the effective date of a split to its ratio (4.0 for 4-for-1, 0.1 for 1-for-10).
    """
    out = [1.0] * len(dates)
    factor = 1.0
    pending = sorted(splits.items(), reverse=True)
    for index in range(len(dates) - 1, -1, -1):
        while pending and pending[0][0] > dates[index]:
            factor *= pending.pop(0)[1]
        out[index] = factor
    return out


# Bars of a symbol the book reads to price one spread: enough for the longest expiry it allows
# (book.py: 400 days), so the result is the same as on the whole history, and the book does not
# build a calendar of every bar for every signal.
WINDOW_BARS = 320


def _window(market: Market, first: int, factor: float) -> Market:
    """The bars of `market` from `first` on (at most WINDOW_BARS), closes times `factor`."""
    last = min(len(market.dates), first + WINDOW_BARS)
    return Market(market.symbol, market.dates[first:last], tuple(close * factor for close in market.close[first:last]),
                  market.iv_index[first:last], market.rate[first:last],
                  tuple((index_id, levels[first:last]) for index_id, levels in market.iv_term))


def first_priced(market: Market, blocks: Sequence[Mapping]) -> int:
    """The first bar with every IV input the book needs for `blocks`: the IV index, and every IV term value when
    a block is a calendar (len(market) when there is none)."""
    term = any(block["structure"] in CALENDARS for block in blocks)
    return next((index for index, value in enumerate(market.iv_index) if value is not None and (
        not term or (market.iv_term and all(levels[index] is not None for _, levels in market.iv_term)))),
        len(market.dates))


def degenerate(trade: PricedTrade, spot: float) -> bool:
    """True when the strike grid or the fee floor decides the trade: a vertical less than MIN_WIDTH_STEPS strike
    steps wide at the entry `spot`, or a premium per contract below the entry commission of its two legs."""
    return ((trade.far_expiry is None and trade.width < MIN_WIDTH_STEPS * om.strike_step(spot))
            or trade.premium * om.MULTIPLIER < LEGS * om.COMMISSION)


def _side_trades(symbol: str, sides: Sequence[int], side: int, blocks: Sequence[Mapping], market: Market, start: str,
                 entry_only: bool, factors: Sequence[float] | None,
                 refused: dict[str, int]) -> list[tuple[int, PricedTrade]]:
    """(structure number, trade) of one symbol and side under the owner exit rule.

    The structures of a side are one package: they open together on a signal bar or not at all, and
    the next package opens only when every spread of the last one has closed. `refused` counts the
    signal bars without a package, by the reason of the first structure that had none.
    """
    join = first_priced(market, blocks)
    trades: list[tuple[int, PricedTrade]] = []
    busy = -1
    for entry, exit_ in _spans(sides, side):
        if entry < max(busy, join) or entry >= len(market.dates) - 1 or market.dates[entry] < start:
            continue
        priced = _window(market, entry, 1.0 if factors is None else factors[entry + 1])
        leaves = None if entry_only or exit_ is None or exit_ - entry >= len(priced.dates) else exit_ - entry
        package, reason = [], None
        for options in blocks:
            book = build_book([SignalEvent(symbol, 0, leaves)], options, {symbol: priced})
            if not book.trades:
                reason = book.skipped[0].reason
            elif degenerate(book.trades[0], priced.close[1]):
                reason = "degenerate"
            if reason is not None:
                break
            final = al.owner_exit(book.trades[0], options, priced)
            package.append(dataclasses.replace(final, entry_index=final.entry_index + entry,
                                               exit_index=final.exit_index + entry))
        if reason is not None:
            refused[reason] = refused.get(reason, 0) + 1
            continue
        trades.extend(enumerate(package))
        busy = max(trade.exit_index for trade in package)
    return trades


@dataclass(frozen=True)
class FormBook:
    """The priced trades of a form (ids 1..n by entry date) and its refused signal bars by reason: a book
    reason (no IV value, no expiry, no premium, ...) or `degenerate`. A refused stance is tried again on
    the next bar, so the count is in bars, not in spreads."""

    trades: tuple[PricedTrade, ...]
    refused: Mapping[str, int]


def form_book(form: Form, inputs: Inputs, markets: Mapping[str, Market], *, start: str,
              factors: Mapping[str, Sequence[float]] | None = None) -> FormBook:
    """Prices a form under the owner exit rule.

    `factors`: symbol -> `raw_factors` of its bars, for the underlyings whose bars are split-adjusted
    and whose spreads are priced at the raw price of the entry day.
    """
    stance = stance_of(form, inputs)
    collected = []
    refused: dict[str, int] = {}
    for order, symbol in enumerate(form.symbols):
        if symbol not in stance:
            continue
        market = markets[symbol]
        if market.dates != inputs.bars[symbol].dates:
            raise ValueError(f"{form.key}: the market and the bars of {symbol} have different dates")
        scale = None if factors is None else factors.get(symbol)
        if scale is not None and len(scale) != len(market.dates):
            raise ValueError(f"{form.key}: {symbol} has {len(scale)} raw factors for {len(market.dates)} bars")
        for side in sorted(form.structures, reverse=True):
            blocks = [al.hold_options(block) for block in form.structures[side]]
            for number, trade in _side_trades(symbol, stance[symbol], side, blocks, market, start, form.entry_only,
                                              scale, refused):
                collected.append((trade.entry_date, order, -side, number, trade))
    collected.sort(key=lambda item: item[:4])
    trades = tuple(dataclasses.replace(item[4], trade_id=number) for number, item in enumerate(collected, start=1))
    return FormBook(trades, dict(sorted(refused.items())))


def form_trades(form: Form, inputs: Inputs, markets: Mapping[str, Market], *, start: str,
                factors: Mapping[str, Sequence[float]] | None = None) -> tuple[PricedTrade, ...]:
    """The priced trades of `form_book`."""
    return form_book(form, inputs, markets, start=start, factors=factors).trades


# --------------------------------------------------------------------------- distributions the bars do not adjust

DISTRIBUTION_RATIO = 1.2
FALL_TOLERANCE = 1.1


def distributions(bars: Bars, threshold: float = DISTRIBUTION_RATIO) -> dict[str, float]:
    """date -> ratio of every one-day distribution the split-adjusted close does not adjust for.

    A spin-off or a special dividend makes the close fall while the adjusted close does not. A day
    is treated like a split with ratio r when the adjusted close moved r >= `threshold` times as
    much as the close, and the close itself fell by about that ratio (at least r / FALL_TOLERANCE;
    an adjusted close that jumps while the close does not is a data error, not a distribution).
    A listed option is adjusted for such a distribution in the same way. A smaller special
    dividend stays in the prices as a fall.
    """
    out = {}
    for index in range(1, len(bars)):
        fall = bars.close[index - 1] / bars.close[index]
        ratio = fall * bars.adj_close[index] / bars.adj_close[index - 1]
        if ratio >= threshold and fall >= ratio / FALL_TOLERANCE:
            out[bars.dates[index]] = ratio
    return out


def continuous(bars: Bars, events: Mapping[str, float]) -> Bars:
    """`bars` with open, high, low and close before each event date divided by the event ratio, so the
    prices have no jump at a distribution. The adjusted close stays (it has none)."""
    scale = [1.0 / factor for factor in raw_factors(bars.dates, events)]
    return Bars(bars.symbol, bars.dates, *(tuple(value * factor for value, factor in zip(column, scale))
                                           for column in (bars.open, bars.high, bars.low, bars.close)), bars.adj_close)


def raw_priced(bars: Bars, splits: Mapping[str, float]) -> tuple[Bars, list[float], dict[str, float]]:
    """What the study reads for an underlying outside the Core 7: (bars without a jump at a distribution,
    their raw factors, the distributions found). A split and a distribution on one date multiply."""
    events = distributions(bars)
    ratios = dict(splits)
    for day, ratio in events.items():
        ratios[day] = ratios.get(day, 1.0) * ratio
    smooth = continuous(bars, events)
    return smooth, raw_factors(smooth.dates, ratios), events


# --------------------------------------------------------------------------- proxy IV and cost model

RV_WINDOW = 60
RV_PREMIUM = 1.15
RATIO_RANGE = (0.5, 6.0)
TRADING_DAYS = 252
# A proxy index is read like VIX: ATM IV = 0.9 x index (options.ATM_FACTOR).
PROXY_ATM_FACTOR = 0.9
DIVIDEND_YIELD_CAP = 0.06


@dataclass(frozen=True)
class ProxyModel:
    """Cost model of an underlying without a Cboe IV index: half the bid/ask spread as a share of the
    option mid (options.HALF_SPREAD_PCT) and the skew slope (options.SKEW)."""

    half_spread_pct: float
    skew: float


# Classes follow the Core 7 table of options.py: 2% like IWM, 3% like DIA, 4% like SLV and USO.
# Equity skew is the QQQ slope; rates, currencies and commodities get no slope.
LIQUID_EQUITY = ProxyModel(0.02, -0.25)
EQUITY = ProxyModel(0.03, -0.25)
THIN_EQUITY = ProxyModel(0.04, -0.25)
LIQUID_OTHER = ProxyModel(0.02, 0.0)
THIN_OTHER = ProxyModel(0.04, 0.0)
PROXY_MODELS: Mapping[str, ProxyModel] = {
    **dict.fromkeys(("EEM", "EFA", "XLE", "XLF", "XLK", "GDX"), LIQUID_EQUITY),
    **dict.fromkeys(("XLB", "XLI", "XLP", "XLU", "XLV", "XLY", "XLRE", "XLC", "KO", "PEP"), EQUITY),
    **dict.fromkeys(("VNQ", "EWA", "EWC"), THIN_EQUITY),
    "TLT": LIQUID_OTHER,
    **dict.fromkeys(("IEF", "DBC", "FXE", "FXB", "FXA", "CORN"), THIN_OTHER),
}


def proxy_index_id(symbol: str) -> str:
    return f"{symbol}:IVX"


def _realized(bars: Bars) -> dict[str, float]:
    """date -> annualized volatility in percent of the last RV_WINDOW daily log returns (adjusted close)."""
    returns = [math.log(later / earlier) for earlier, later in zip(bars.adj_close, bars.adj_close[1:])]
    return {bars.dates[index + 1]: pstdev(returns[index + 1 - RV_WINDOW:index + 1]) * math.sqrt(TRADING_DAYS) * 100
            for index in range(RV_WINDOW - 1, len(returns))}


def proxy_iv_index(bars: Bars, reference: Bars, reference_index: Mapping[str, float]) -> dict[str, float]:
    """date -> proxy IV index level in percent of `bars`.

    The geometric mean of two estimates: the reference index (VIX) times the ratio of the 60-day
    realized volatilities (symbol over reference, SPY), and 1.15 times the symbol's own 60-day
    realized volatility. The ratio is held in RATIO_RANGE. No value where an input is missing or a
    realized volatility is 0.
    """
    own, base = _realized(bars), _realized(reference)
    low, high = RATIO_RANGE
    out = {}
    for day, value in own.items():
        level, other = reference_index.get(day), base.get(day)
        if level is None or not other or not value:
            continue
        out[day] = math.sqrt(level * min(high, max(low, value / other)) * RV_PREMIUM * value)
    return out


def dividend_yield(bars: Bars) -> float:
    """Mean continuous dividend yield of the bars: the total-return drift minus the price drift per year."""
    years = len(bars) / TRADING_DAYS
    if years <= 0:
        return 0.0
    drift = math.log(bars.adj_close[-1] / bars.adj_close[0]) - math.log(bars.close[-1] / bars.close[0])
    return min(DIVIDEND_YIELD_CAP, max(0.0, drift / years))


def proxy_market(bars: Bars, index: Mapping[str, float], irx: Mapping[str, float]) -> Market:
    """The option book's view of a proxy symbol: its proxy index and IRX aligned to its bars."""
    rate = [None if value is None else value / 100 for value in align(irx, bars.dates, MAX_FILL_DAYS)]
    return Market(bars.symbol, bars.dates, bars.close, tuple(align(index, bars.dates, MAX_FILL_DAYS)), tuple(rate))


@contextlib.contextmanager
def proxy_symbols(models: Mapping[str, ProxyModel], yields: Mapping[str, float]) -> Iterator[None]:
    """Adds proxy symbols to the symbol tables of data.py and options.py and removes them at the end.

    The option book reads these tables by symbol. A symbol that is already in a table is refused,
    so a Core 7 model cannot be replaced.
    """
    known = [symbol for symbol in models if symbol in qd.IV_INDEX or symbol in om.HALF_SPREAD_PCT or symbol in om.SKEW]
    if known:
        raise ValueError(f"Already in the symbol tables: {sorted(known)}")
    added = dict(models)
    try:
        for symbol, model in added.items():
            qd.IV_INDEX[symbol] = proxy_index_id(symbol)
            om.ATM_FACTOR[proxy_index_id(symbol)] = PROXY_ATM_FACTOR
            om.HALF_SPREAD_PCT[symbol] = model.half_spread_pct
            om.SKEW[symbol] = model.skew
            om.DIVIDEND_YIELD[symbol] = yields.get(symbol, 0.0)
        yield
    finally:
        for symbol in added:
            qd.IV_INDEX.pop(symbol, None)
            om.ATM_FACTOR.pop(proxy_index_id(symbol), None)
            om.HALF_SPREAD_PCT.pop(symbol, None)
            om.SKEW.pop(symbol, None)
            om.DIVIDEND_YIELD.pop(symbol, None)


# --------------------------------------------------------------------------- indicators for rules
# One value per bar; None where the window is not full. Bar i reads bars 0..i only.

def adjusted(bars: Bars) -> Bars:
    """`bars` with open, high, low and close scaled by adj_close / close: total-return prices, as Vertex's
    adapter gives them to the QuantJourney engine (research/backtests/quantjourney/qj_adapter.py)."""
    scale = [adj / close for adj, close in zip(bars.adj_close, bars.close)]
    return Bars(bars.symbol, bars.dates, *(tuple(value * factor for value, factor in zip(column, scale))
                                           for column in (bars.open, bars.high, bars.low)),
                bars.adj_close, bars.adj_close)


def sma(values: Sequence[float], length: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    total = 0.0
    for index, value in enumerate(values):
        total += value
        if index >= length:
            total -= values[index - length]
        if index >= length - 1:
            out[index] = total / length
    return out


def ema(values: Sequence[float], length: int) -> list[float | None]:
    """Exponential mean with alpha 2 / (length + 1), started at the first value (pandas ewm adjust=False);
    None for the first length - 1 bars."""
    out: list[float | None] = [None] * len(values)
    alpha = 2 / (length + 1)
    level: float | None = None
    for index, value in enumerate(values):
        level = value if level is None else alpha * value + (1 - alpha) * level
        if index >= length - 1:
            out[index] = level
    return out


def rsi(values: Sequence[float], length: int = 14) -> list[float | None]:
    """Wilder RSI as the QuantJourney indicator library computes it: the first average is the mean of the
    first `length` changes, then Wilder smoothing; 50 when there was no change at all, 100 without a loss."""
    out: list[float | None] = [None] * len(values)
    gain = loss = 0.0
    for index in range(1, len(values)):
        change = values[index] - values[index - 1]
        up, down = max(change, 0.0), max(-change, 0.0)
        if index <= length:
            gain += up / length
            loss += down / length
        else:
            gain = (gain * (length - 1) + up) / length
            loss = (loss * (length - 1) + down) / length
        if index >= length:
            if loss == 0:
                out[index] = 50.0 if gain == 0 else 100.0
            else:
                out[index] = 100 - 100 / (1 + gain / loss)
    return out


def highest(values: Sequence[float], length: int) -> list[float | None]:
    """Highest of the last `length` values, the bar itself included."""
    return [None if index < length - 1 else max(values[index - length + 1:index + 1]) for index in range(len(values))]


def lowest(values: Sequence[float], length: int) -> list[float | None]:
    return [None if index < length - 1 else min(values[index - length + 1:index + 1]) for index in range(len(values))]


def pct_change(values: Sequence[float | None], length: int) -> list[float | None]:
    """values[i] / values[i - length] - 1; None where a value is missing."""
    out: list[float | None] = [None] * len(values)
    for index in range(length, len(values)):
        now, then = values[index], values[index - length]
        if now is not None and then:
            out[index] = now / then - 1
    return out


def rolling_stdev(values: Sequence[float | None], length: int) -> list[float | None]:
    """Population standard deviation of the last `length` values; None where one of them is missing."""
    out: list[float | None] = [None] * len(values)
    for index in range(length - 1, len(values)):
        window = values[index - length + 1:index + 1]
        if all(value is not None for value in window):
            out[index] = pstdev(window)  # type: ignore[arg-type]
    return out


def next_session(day: date) -> date:
    """The next NYSE session after `day` by the holiday rules of calendar.py (no bar is read)."""
    day += timedelta(days=1)
    while day.weekday() >= 5 or is_nyse_holiday(day):
        day += timedelta(days=1)
    return day


_PERIOD_KEY: Mapping[str, Callable[[date], tuple[int, int]]] = {
    "week": lambda day: tuple(day.isocalendar())[:2],
    "month": lambda day: (day.year, day.month),
    "quarter": lambda day: (day.year, (day.month - 1) // 3),
}


def period_ends(dates: Sequence[str], period: str) -> list[bool]:
    """True where the date is the last NYSE session of its week, month or quarter.

    Each flag depends on its own date only, so it is known at the close of that bar.
    """
    key = _PERIOD_KEY[period]
    out = []
    for text in dates:
        day = date.fromisoformat(text)
        out.append(key(day) != key(next_session(day)))
    return out


# --------------------------------------------------------------------------- cross-sectional rules

@dataclass(frozen=True)
class Panel:
    """Adjusted closes of several symbols on one calendar (the union of their bar dates); None where
    a symbol has no bar on a date."""

    dates: tuple[str, ...]
    close: Mapping[str, tuple[float | None, ...]]


def panel(inputs: Inputs, symbols: Sequence[str]) -> Panel:
    dates = tuple(sorted({day for symbol in symbols for day in inputs.bars[symbol].dates}))
    close = {}
    for symbol in symbols:
        bars = inputs.bars[symbol]
        by_day = dict(zip(bars.dates, bars.adj_close))
        close[symbol] = tuple(by_day.get(day) for day in dates)
    return Panel(dates, close)


def from_panel(inputs: Inputs, dates: Sequence[str], sides: Mapping[str, Sequence[int]]) -> dict[str, list[int]]:
    """Panel sides (one per panel date) as a stance on each symbol's own bars."""
    out = {}
    for symbol, values in sides.items():
        by_day = dict(zip(dates, values, strict=True))
        out[symbol] = [by_day[day] for day in inputs.bars[symbol].dates]
    return out
