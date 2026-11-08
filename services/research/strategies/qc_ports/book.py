"""Turns entry/exit signals into priced defined-risk vertical spreads (research only).

Input: signal events (symbol, entry signal bar, exit signal bar or None) from
the equity signal engine and the DSL `options` block. Output: one PricedTrade
per accepted event, with the spread legs, the per-contract instrument value at
every close it is held (marks) and the per-contract costs; plus the skipped
events with a reason. Sizing (contracts) depends on equity, so the ledgers
(ledger.py, nautilus_runner.py) apply it at entry with `contracts_for`.

Rules:
- Timing: an entry or exit signal at the close of bar i trades at the close of
  bar i + 1 at the modeled price. Profit-take, exitDte and expiry are checked
  at each close after the entry close and executed at that close. Precedence
  on one close: expiry, exitDte, profit-take, signal, end of data.
- Expiry: the standard monthly expiration whose calendar DTE is nearest
  dte.target among those with DTE >= dte.min (ties -> the earlier one).
- Strikes on the grid (options.strike_step): the anchor leg is the strike whose
  |delta| is nearest the target (debit: long leg at longDelta, default 0.5;
  credit: short leg at shortDelta, default 0.25; ties -> nearer the spot, then
  lower); the other leg is `width` further out of the money (calls up, puts
  down), width = widthSigma * ATM IV * sqrt(T) * spot rounded to the grid,
  at least one step.
- Instrument value per contract (always >= 0): debit = spread value * 100,
  credit = (width - spread value) * 100 (fully collateralised). Values are
  rounded to cents. Max loss per contract = entry value + entry costs.
- Costs per contract and side = sum over legs of $0.65 + 100 * half-spread
  (options.leg_cost), rounded to cents; held to expiration the spread settles
  at intrinsic value without costs.
- Missing IV index or rate on the entry bar (after the 5-day carry in data.py)
  -> no trade. While a trade is open a missing value carries the last one used
  (counted in `stale_days`).
"""
from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from . import options as om
from .calendar import TradingCalendar, expirations_after, parse
from .data import IV_INDEX, Market

__all__ = [
    "MAX_LOSS_PCT_CAP", "STRUCTURES", "Book", "OptionsSpec", "PricedTrade", "SignalEvent", "Skip", "build_book",
    "choose_expiry", "choose_strikes", "contracts_for", "instrument_value", "parse_options", "spread_legs",
]

STRUCTURES = {
    "callDebitVertical": ("call", "debit"),
    "putDebitVertical": ("put", "debit"),
    "putCreditVertical": ("put", "credit"),
    "callCreditVertical": ("call", "credit"),
}
MAX_LOSS_PCT_CAP = 2.0
DEFAULT_LONG_DELTA = 0.5
DEFAULT_SHORT_DELTA = 0.25
EXPIRY_SCAN_MONTHS = 15
DAYS_PER_YEAR = 365
# Strike search range around the spot in ATM standard deviations, and its minimum in grid steps.
STRIKE_SEARCH_SIGMAS = 4.0
STRIKE_SEARCH_MIN_STEPS = 20
OPTION_KEYS = {"structure", "dte", "longDelta", "shortDelta", "widthSigma", "profitTakePct", "exitDte", "maxLossPct"}


@dataclass(frozen=True)
class SignalEvent:
    symbol: str
    entry_index: int
    exit_index: int | None = None


@dataclass(frozen=True)
class OptionsSpec:
    structure: str
    dte_target: int
    dte_min: int
    width_sigma: float
    max_loss_pct: float
    long_delta: float = DEFAULT_LONG_DELTA
    short_delta: float = DEFAULT_SHORT_DELTA
    profit_take_pct: float | None = None
    exit_dte: int | None = None

    @property
    def right(self) -> str:
        return STRUCTURES[self.structure][0]

    @property
    def kind(self) -> str:
        return STRUCTURES[self.structure][1]


@dataclass(frozen=True)
class PricedTrade:
    """One spread, per contract. Prices, fees and max loss are $ per contract; marks are (date, value)."""

    trade_id: int
    symbol: str
    structure: str
    expiry: str
    long_strike: float
    short_strike: float
    width: float
    entry_index: int
    exit_index: int
    entry_date: str
    exit_date: str
    entry_price: float
    exit_price: float
    entry_fee: float
    exit_fee: float
    max_loss: float
    max_loss_pct: float
    premium: float
    exit_reason: str
    marks: tuple[tuple[str, float], ...]
    stale_days: int = 0


@dataclass(frozen=True)
class Skip:
    event: SignalEvent
    reason: str


@dataclass(frozen=True)
class Book:
    trades: tuple[PricedTrade, ...]
    skipped: tuple[Skip, ...]


def _int_in(block: Mapping, key: str, low: int, high: int) -> int:
    value = block.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{key} must be an integer in {low}..{high}")
    return value


def _num_in(block: Mapping, key: str, low: float, high: float, *, open_low: bool = False) -> float:
    value = block.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{key} must be a number")
    if value > high or value < low or (open_low and value == low):
        raise ValueError(f"{key} must be in {'(' if open_low else '['}{low:g}, {high:g}]")
    return float(value)


def parse_options(block: Mapping) -> OptionsSpec:
    """Validates the DSL `options` block. maxLossPct above 2 is refused."""
    unknown = set(block) - OPTION_KEYS
    if unknown:
        raise ValueError(f"Unknown options field: {', '.join(sorted(unknown))}")
    structure = block.get("structure")
    if structure not in STRUCTURES:
        raise ValueError(f"structure must be one of {', '.join(STRUCTURES)}")
    dte = block.get("dte")
    if not isinstance(dte, Mapping) or set(dte) != {"target", "min"}:
        raise ValueError("dte must be {target, min}")
    max_loss = block.get("maxLossPct")
    if isinstance(max_loss, (int, float)) and not isinstance(max_loss, bool) and max_loss > MAX_LOSS_PCT_CAP:
        raise ValueError(f"maxLossPct {max_loss:g} refused: the cap is {MAX_LOSS_PCT_CAP:g}% of equity per trade")
    return OptionsSpec(
        structure=structure,
        dte_target=_int_in(dte, "target", 7, 400),
        dte_min=_int_in(dte, "min", 1, 400),
        width_sigma=_num_in(block, "widthSigma", 0.1, 3),
        max_loss_pct=_num_in(block, "maxLossPct", 0, MAX_LOSS_PCT_CAP, open_low=True),
        long_delta=_num_in(block, "longDelta", 0.05, 0.95) if "longDelta" in block else DEFAULT_LONG_DELTA,
        short_delta=_num_in(block, "shortDelta", 0.05, 0.95) if "shortDelta" in block else DEFAULT_SHORT_DELTA,
        profit_take_pct=_num_in(block, "profitTakePct", 1, 100) if "profitTakePct" in block else None,
        exit_dte=_int_in(block, "exitDte", 0, 400) if "exitDte" in block else None,
    )


def contracts_for(equity: float, cash: float, max_loss_pct: float, max_loss: float, unit_cost: float) -> int:
    """floor(maxLossPct% * equity / max loss per contract), capped by the cash for the entry (value + costs)."""
    if not 0 < max_loss_pct <= MAX_LOSS_PCT_CAP:
        raise ValueError(f"maxLossPct {max_loss_pct:g} refused: must be above 0 and at most {MAX_LOSS_PCT_CAP:g}")
    if not (max_loss > 0 and equity > 0 and cash > 0):
        return 0
    contracts = math.floor(max_loss_pct / 100 * equity / max_loss)
    if unit_cost > 0:
        contracts = min(contracts, math.floor(cash / unit_cost))
    return max(0, contracts)


def choose_expiry(entry: str | date, target: int, minimum: int, calendar: TradingCalendar | None = None) -> date | None:
    """Monthly expiration with DTE >= minimum nearest the target DTE (ties -> earlier)."""
    day = parse(entry)
    months = EXPIRY_SCAN_MONTHS + max(target, minimum) // 30
    best = None
    for expiry in expirations_after(day, months, calendar):
        dte = (expiry - day).days
        if dte < minimum:
            continue
        if best is None or abs(dte - target) < abs((best - day).days - target):
            best = expiry
    return best


@dataclass(frozen=True)
class _Pricing:
    spot: float
    t: float
    r: float
    q: float
    atm: float
    slope: float

    def iv(self, strike: float) -> float:
        return om.smile_iv(self.atm, self.spot, strike, self.t, self.slope)

    def price(self, right: str, strike: float) -> float:
        return om.bs_price(right, self.spot, strike, self.t, self.r, self.q, self.iv(strike))

    def delta(self, right: str, strike: float) -> float:
        return om.bs_delta(right, self.spot, strike, self.t, self.r, self.q, self.iv(strike))


def _grid(value: float, step: float) -> float:
    return round(round(value / step) * step, 6)


def choose_strikes(right: str, kind: str, spot: float, t: float, r: float, q: float, atm: float, slope: float,
                   spec: OptionsSpec) -> tuple[float, float, float] | None:
    """(long strike, short strike, width) on the grid, or None when the far leg would be <= 0."""
    if not t > 0:
        return None
    pricing = _Pricing(spot, t, r, q, atm, slope)
    step = om.strike_step(spot)
    target = spec.long_delta if kind == "debit" else spec.short_delta
    reach = max(STRIKE_SEARCH_SIGMAS * atm * math.sqrt(t) * spot, STRIKE_SEARCH_MIN_STEPS * step)
    low = max(step, _grid(spot - reach, step))
    count = int(round((_grid(spot + reach, step) - low) / step))
    best: tuple[float, float, float] | None = None
    for n in range(count + 1):
        strike = round(low + n * step, 6)
        key = (abs(abs(pricing.delta(right, strike)) - target), abs(strike - spot), strike)
        if best is None or key < best:
            best = key
    anchor = best[2]
    width = max(step, _grid(spec.width_sigma * atm * math.sqrt(t) * spot, step))
    other = round(anchor + width if right == "call" else anchor - width, 6)
    if other <= 0:
        return None
    return (anchor, other, width) if kind == "debit" else (other, anchor, width)


def spread_legs(pricing: _Pricing, right: str, long_strike: float, short_strike: float) -> tuple[float, float]:
    """Mid prices per share of the long and the short leg."""
    return pricing.price(right, long_strike), pricing.price(right, short_strike)


def instrument_value(kind: str, long_mid: float, short_mid: float, width: float) -> float:
    """$ per contract, rounded to cents: debit = (long - short) * 100, credit = (width - (short - long)) * 100."""
    spread = long_mid - short_mid if kind == "debit" else width - (short_mid - long_mid)
    return round(max(0.0, spread) * om.MULTIPLIER, 2)


def _fee(symbol: str, long_mid: float, short_mid: float) -> float:
    return round(om.leg_cost(symbol, long_mid) + om.leg_cost(symbol, short_mid), 2)


def _event(item: SignalEvent | Sequence) -> SignalEvent:
    return item if isinstance(item, SignalEvent) else SignalEvent(*item)


def _price_event(event: SignalEvent, market: Market, spec: OptionsSpec, calendar: TradingCalendar,
                 trade_id: int) -> PricedTrade | str:
    last = len(market) - 1
    if not (isinstance(event.entry_index, int) and 0 <= event.entry_index <= last):
        raise ValueError(f"entry index {event.entry_index} outside the {market.symbol} bars")
    if event.exit_index is not None and event.exit_index <= event.entry_index:
        raise ValueError("exit signal must come after the entry signal")
    entry = event.entry_index + 1
    if entry >= last:
        return "no bar to enter and exit"
    level, rate = market.iv_index[entry], market.rate[entry]
    if level is None:
        return "no IV"
    if rate is None:
        return "no rate"
    entry_day = parse(market.dates[entry])
    expiry = choose_expiry(entry_day, spec.dte_target, spec.dte_min, calendar)
    if expiry is None:
        return "no expiry"
    dte = (expiry - entry_day).days
    if spec.exit_dte is not None and dte <= spec.exit_dte:
        return "exitDte at entry"
    index_id = IV_INDEX[market.symbol]
    q = om.DIVIDEND_YIELD.get(market.symbol, 0.0)
    slope = om.SKEW[market.symbol]
    right, kind = spec.right, spec.kind
    pricing = _Pricing(market.close[entry], dte / DAYS_PER_YEAR, rate, q, om.atm_iv(index_id, level), slope)
    strikes = choose_strikes(right, kind, pricing.spot, pricing.t, rate, q, pricing.atm, slope, spec)
    if strikes is None:
        return "no strikes"
    long_strike, short_strike, width = strikes
    long_mid, short_mid = spread_legs(pricing, right, long_strike, short_strike)
    entry_price = instrument_value(kind, long_mid, short_mid, width)
    entry_fee = _fee(market.symbol, long_mid, short_mid)
    premium = abs(long_mid - short_mid)
    exit_signal = None if event.exit_index is None else event.exit_index + 1
    credit = width * om.MULTIPLIER - entry_price
    if (entry_price if kind == "debit" else credit) <= 0:
        return "no premium"
    marks = [(market.dates[entry], entry_price)]
    stale = 0
    for bar in range(entry + 1, last + 1):
        day = parse(market.dates[bar])
        level = market.iv_index[bar] if market.iv_index[bar] is not None else level
        rate = market.rate[bar] if market.rate[bar] is not None else rate
        stale += market.iv_index[bar] is None or market.rate[bar] is None
        days_left = (expiry - day).days
        pricing = _Pricing(market.close[bar], days_left / DAYS_PER_YEAR, rate, q, om.atm_iv(index_id, level), slope)
        long_mid, short_mid = spread_legs(pricing, right, long_strike, short_strike)
        value = instrument_value(kind, long_mid, short_mid, width)
        marks.append((market.dates[bar], value))
        reason = None
        if days_left <= 0:
            reason = "expiry"
        elif spec.exit_dte is not None and days_left <= spec.exit_dte:
            reason = "exitDte"
        elif spec.profit_take_pct is not None and (
                value >= entry_price * (1 + spec.profit_take_pct / 100) if kind == "debit"
                else width * om.MULTIPLIER - value <= (1 - spec.profit_take_pct / 100) * credit):
            reason = "profitTake"
        elif bar == exit_signal:
            reason = "signal"
        elif bar == last:
            reason = "end"
        if reason is None:
            continue
        return PricedTrade(
            trade_id=trade_id, symbol=market.symbol, structure=spec.structure, expiry=expiry.isoformat(),
            long_strike=long_strike, short_strike=short_strike, width=width, entry_index=entry, exit_index=bar,
            entry_date=market.dates[entry], exit_date=market.dates[bar], entry_price=entry_price, exit_price=value,
            entry_fee=entry_fee, exit_fee=0.0 if reason == "expiry" else _fee(market.symbol, long_mid, short_mid),
            max_loss=round(entry_price + entry_fee, 2), max_loss_pct=spec.max_loss_pct, premium=premium,
            exit_reason=reason, marks=tuple(marks), stale_days=stale)
    raise AssertionError("unreachable: the last bar always exits")


def build_book(events: Iterable[SignalEvent | Sequence], options: Mapping | OptionsSpec,
               markets: Mapping[str, Market]) -> Book:
    """Prices every event. Trade ids follow the event order (accepted events only)."""
    spec = options if isinstance(options, OptionsSpec) else parse_options(options)
    calendars: dict[str, TradingCalendar] = {}
    trades: list[PricedTrade] = []
    skipped: list[Skip] = []
    for item in events:
        event = _event(item)
        market = markets.get(event.symbol)
        if market is None:
            raise ValueError(f"No market data for {event.symbol}")
        if event.symbol not in calendars:
            calendars[event.symbol] = TradingCalendar(market.dates)
        priced = _price_event(event, market, spec, calendars[event.symbol], len(trades) + 1)
        if isinstance(priced, str):
            skipped.append(Skip(event, priced))
        else:
            trades.append(priced)
    return Book(tuple(trades), tuple(skipped))
