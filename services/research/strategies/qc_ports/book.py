"""Turns entry/exit signals into priced defined-risk option spreads (research only).

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
  on one close: expiry, stale-iv, exitDte, profit-take, signal, end of data.
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
  rounded to cents. Max loss per contract = entry value + entry costs + the
  worst-case exit cost (worst_exit_cost: commissions + the half-spread of a
  leg worth the width, per leg); every closing cost is capped at that worst
  case (the vertical closes as a package), so a trade never loses more than
  its max loss and, with sizing at maxLossPct <= 2, never more than 2% of the
  equity at entry. The bound holds under this package-close cost model only:
  legging out of a spread in a wide market could cost more than modeled.
- Costs per contract and side = sum over legs of $0.65 + 100 * half-spread
  (options.leg_cost), rounded to cents; held to expiration the spread settles
  at intrinsic value without costs.
- Missing IV index or rate on the entry bar (after the 5-day carry in data.py)
  -> no trade. While a trade is open, an IV index stale for more than 5 trading
  days (None after the carry) closes it at that bar, priced with the last IV
  used (exit reason "stale-iv"); a missing rate carries the last one used
  (counted in `stale_days`).

Two-expiry structure (long calendar spread, `callCalendar` / `putCalendar`,
parse_calendar; the DSL `options` block and the go-live drafts know verticals
only):
- Short one option at the near expiry (`dte`), long one option of the same
  right and strike at the far expiry (`farDte`, chosen like `dte` among the
  monthly expirations after the near one). Net debit.
- Each leg is priced with the ATM IV at its own DTE from the IV term structure
  of the symbol (options.term_atm_iv over the 30-day index and Market.iv_term),
  with the skew of the symbol, at max(Black-Scholes, intrinsic value) (an
  American option is worth at least its exercise value). The spread value is
  floored at 0 (instrument_value): a far leg priced below the near leg (a
  falling total variance, or the skew of the two tenors) would be an arbitrage.
  A market without every term index of data.IV_TERM for its symbol, or a bar
  without every term value, opens no calendar ("no IV term"); a term value
  missing while the trade is open closes it like a stale IV index.
- Strike: the grid strike whose near-leg |delta| is nearest `strikeDelta`
  (default 0.5, at the money). `maxTermRatio`: no trade when the far-leg ATM IV
  is above that multiple of the near-leg ATM IV ("term structure"; ATM IVs, not
  the IVs at the strike).
- Instrument value per contract = (far leg - near leg) * 100. The trade ends at
  the near expiry at the latest: there the near leg settles at its intrinsic
  value and the far leg is sold at its model value. Profit-take, exitDte,
  signal and end as for a debit vertical.
- Costs as for a vertical, per leg on the leg's mid (at the near expiry: the far
  leg, plus the near leg when it is in the money). The calendar closes as a
  package, so a closing cost is capped at two legs priced at the far leg's
  entry mid (worst_exit_cost), as a vertical's is capped at two legs worth its
  width: about the most the package is worth (the far leg's time value at the
  strike). Max loss = entry value + entry costs + that cap. The cap lowers the
  cost when the far leg ends deep in the money; legging out could cost more.
"""
from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from . import options as om
from .calendar import TradingCalendar, expirations_after, parse
from .data import INDEX_TENOR_DAYS, IV_INDEX, IV_TERM, Market

__all__ = [
    "CALENDARS", "MAX_LOSS_PCT_CAP", "STRUCTURES", "Book", "CalendarSpec", "OptionsSpec", "PricedTrade", "SignalEvent",
    "Skip", "build_book", "choose_expiry", "choose_strikes", "contracts_for", "full_term", "instrument_value",
    "parse_calendar",
    "parse_options", "spread_legs", "worst_exit_cost",
]

STRUCTURES = {
    "callDebitVertical": ("call", "debit"),
    "putDebitVertical": ("put", "debit"),
    "putCreditVertical": ("put", "credit"),
    "callCreditVertical": ("call", "credit"),
}
# Two-expiry structures (long calendar spreads): structure -> right. Not in the DSL (parse_options).
CALENDARS = {"callCalendar": "call", "putCalendar": "put"}
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
    """One spread, per contract. Prices, fees and max loss are $ per contract; marks are (date, value).

    A calendar (CALENDARS) has `expiry` = the near (short) leg, `far_expiry` = the long leg, one strike in
    `long_strike` and `short_strike`, and `width` 0. A vertical has `far_expiry` None.
    """

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
    far_expiry: str | None = None


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
    if not all(math.isfinite(value) for value in (equity, cash, max_loss, unit_cost)):
        raise ValueError("contracts_for needs finite equity, cash, max loss and unit cost")
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


def _anchor_strike(pricing: _Pricing, right: str, target: float) -> float:
    """The grid strike whose |delta| is nearest `target` (ties -> nearer the spot, then lower). Needs t > 0."""
    spot, atm, t = pricing.spot, pricing.atm, pricing.t
    step = om.strike_step(spot)
    reach = max(STRIKE_SEARCH_SIGMAS * atm * math.sqrt(t) * spot, STRIKE_SEARCH_MIN_STEPS * step)
    low = max(step, _grid(spot - reach, step))
    count = int(round((_grid(spot + reach, step) - low) / step))
    best: tuple[float, float, float] | None = None
    for n in range(count + 1):
        strike = round(low + n * step, 6)
        key = (abs(abs(pricing.delta(right, strike)) - target), abs(strike - spot), strike)
        if best is None or key < best:
            best = key
    return best[2]


def choose_strikes(right: str, kind: str, spot: float, t: float, r: float, q: float, atm: float, slope: float,
                   spec: OptionsSpec) -> tuple[float, float, float] | None:
    """(long strike, short strike, width) on the grid, or None when the far leg would be <= 0."""
    if not t > 0:
        return None
    step = om.strike_step(spot)
    target = spec.long_delta if kind == "debit" else spec.short_delta
    anchor = _anchor_strike(_Pricing(spot, t, r, q, atm, slope), right, target)
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
    if not all(math.isfinite(value) for value in (long_mid, short_mid, width)):
        raise ValueError("instrument value needs finite leg prices and width")
    spread = long_mid - short_mid if kind == "debit" else width - (short_mid - long_mid)
    return round(max(0.0, spread) * om.MULTIPLIER, 2)


def _fee(symbol: str, long_mid: float, short_mid: float) -> float:
    return round(om.leg_cost(symbol, long_mid) + om.leg_cost(symbol, short_mid), 2)


def worst_exit_cost(symbol: str, width: float) -> float:
    """Most a closing trade costs per contract under the package-close model: both legs at commission + the
    half-spread of a leg worth the spread width (the vertical closes as a package, so a deep in-the-money exit
    is charged no more; a calendar passes the entry mid of its far leg). The 2% loss bound of sizing relies on
    this cap."""
    return round(2 * om.leg_cost(symbol, width), 2)


def _check_event(event: SignalEvent, market: Market) -> None:
    if not (isinstance(event.entry_index, int) and 0 <= event.entry_index <= len(market) - 1):
        raise ValueError(f"entry index {event.entry_index} outside the {market.symbol} bars")
    if event.exit_index is not None and event.exit_index <= event.entry_index:
        raise ValueError("exit signal must come after the entry signal")


def _event(item: SignalEvent | Sequence) -> SignalEvent:
    return item if isinstance(item, SignalEvent) else SignalEvent(*item)


def _price_event(event: SignalEvent, market: Market, spec: OptionsSpec, calendar: TradingCalendar,
                 trade_id: int) -> PricedTrade | str:
    last = len(market) - 1
    _check_event(event, market)
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
    worst_exit = worst_exit_cost(market.symbol, width)
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
        pricing = _Pricing(market.close[bar], max(0, days_left) / DAYS_PER_YEAR, rate, q, om.atm_iv(index_id, level), slope)
        long_mid, short_mid = spread_legs(pricing, right, long_strike, short_strike)
        value = instrument_value(kind, long_mid, short_mid, width)
        marks.append((market.dates[bar], value))
        reason = None
        if days_left <= 0:
            reason = "expiry"
        elif market.iv_index[bar] is None:
            reason = "stale-iv"
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
            entry_fee=entry_fee,
            exit_fee=0.0 if reason == "expiry" else min(_fee(market.symbol, long_mid, short_mid), worst_exit),
            max_loss=round(entry_price + entry_fee + worst_exit, 2), max_loss_pct=spec.max_loss_pct, premium=premium,
            exit_reason=reason, marks=tuple(marks), stale_days=stale)
    raise AssertionError("unreachable: the last bar always exits")


# --------------------------------------------------------------------------- two-expiry structures

CALENDAR_KEYS = {"structure", "dte", "farDte", "strikeDelta", "maxTermRatio", "profitTakePct", "exitDte", "maxLossPct"}


@dataclass(frozen=True)
class CalendarSpec:
    """A long calendar spread (module docstring): near expiry by dte, far expiry by far_*, one strike."""

    structure: str
    dte_target: int
    dte_min: int
    far_target: int
    far_min: int
    max_loss_pct: float
    strike_delta: float = DEFAULT_LONG_DELTA
    max_term_ratio: float | None = None
    profit_take_pct: float | None = None
    exit_dte: int | None = None

    @property
    def right(self) -> str:
        return CALENDARS[self.structure]


def _dte(block: Mapping, key: str) -> tuple[int, int]:
    dte = block.get(key)
    if not isinstance(dte, Mapping) or set(dte) != {"target", "min"}:
        raise ValueError(f"{key} must be {{target, min}}")
    return _int_in(dte, "target", 7, 400), _int_in(dte, "min", 1, 400)


def parse_calendar(block: Mapping) -> CalendarSpec:
    """Validates a calendar block (CALENDAR_KEYS). maxLossPct above 2 is refused."""
    unknown = set(block) - CALENDAR_KEYS
    if unknown:
        raise ValueError(f"Unknown calendar field: {', '.join(sorted(unknown))}")
    structure = block.get("structure")
    if structure not in CALENDARS:
        raise ValueError(f"structure must be one of {', '.join(CALENDARS)}")
    max_loss = block.get("maxLossPct")
    if isinstance(max_loss, (int, float)) and not isinstance(max_loss, bool) and max_loss > MAX_LOSS_PCT_CAP:
        raise ValueError(f"maxLossPct {max_loss:g} refused: the cap is {MAX_LOSS_PCT_CAP:g}% of equity per trade")
    (dte_target, dte_min), (far_target, far_min) = _dte(block, "dte"), _dte(block, "farDte")
    if far_target <= dte_target:
        raise ValueError("farDte.target must be above dte.target")
    return CalendarSpec(
        structure=structure, dte_target=dte_target, dte_min=dte_min, far_target=far_target, far_min=far_min,
        max_loss_pct=_num_in(block, "maxLossPct", 0, MAX_LOSS_PCT_CAP, open_low=True),
        strike_delta=_num_in(block, "strikeDelta", 0.05, 0.95) if "strikeDelta" in block else DEFAULT_LONG_DELTA,
        max_term_ratio=_num_in(block, "maxTermRatio", 0.5, 3) if "maxTermRatio" in block else None,
        profit_take_pct=_num_in(block, "profitTakePct", 1, 100) if "profitTakePct" in block else None,
        exit_dte=_int_in(block, "exitDte", 0, 400) if "exitDte" in block else None,
    )


def full_term(market: Market) -> bool:
    """True when `market` holds every term index data.IV_TERM lists for its symbol (and the symbol has one)."""
    return bool(market.iv_term) and {index_id for index_id, _ in market.iv_term} == set(IV_TERM.get(market.symbol, {}))


def _term_points(market: Market, level: float, terms: Sequence[float]) -> list[tuple[int, float]]:
    """(tenor days, ATM IV) of the 30-day IV index and of every term index of `market` at the given levels."""
    tenors = IV_TERM[market.symbol]
    return [(INDEX_TENOR_DAYS, om.atm_iv(IV_INDEX[market.symbol], level)),
            *((tenors[index_id], om.atm_iv(index_id, value)) for (index_id, _), value in zip(market.iv_term, terms))]


def _leg(spot: float, days: int, rate: float, q: float, slope: float, points: Sequence[tuple[int, float]]) -> _Pricing:
    """Pricing of the leg `days` calendar days from its expiry, at the ATM IV of the term at that DTE."""
    return _Pricing(spot, max(0, days) / DAYS_PER_YEAR, rate, q, om.term_atm_iv(points, days), slope)


def _leg_mid(pricing: _Pricing, right: str, strike: float) -> float:
    """Mid per share, at least the exercise value."""
    return max(pricing.price(right, strike), om.intrinsic(right, pricing.spot, strike))


def _price_calendar(event: SignalEvent, market: Market, spec: CalendarSpec, calendar: TradingCalendar,
                    trade_id: int) -> PricedTrade | str:
    last = len(market) - 1
    _check_event(event, market)
    entry = event.entry_index + 1
    if entry >= last:
        return "no bar to enter and exit"
    level, rate = market.iv_index[entry], market.rate[entry]
    if level is None:
        return "no IV"
    if rate is None:
        return "no rate"
    terms = tuple(levels[entry] for _, levels in market.iv_term)
    if not full_term(market) or None in terms:
        return "no IV term"
    entry_day = parse(market.dates[entry])
    near = choose_expiry(entry_day, spec.dte_target, spec.dte_min, calendar)
    if near is None:
        return "no expiry"
    near_dte = (near - entry_day).days
    far = choose_expiry(entry_day, spec.far_target, max(spec.far_min, near_dte + 1), calendar)
    if far is None:
        return "no expiry"
    if spec.exit_dte is not None and near_dte <= spec.exit_dte:
        return "exitDte at entry"
    symbol, right, spot = market.symbol, spec.right, market.close[entry]
    q, slope = om.DIVIDEND_YIELD.get(symbol, 0.0), om.SKEW[symbol]
    points = _term_points(market, level, terms)
    near_leg = _leg(spot, near_dte, rate, q, slope, points)
    far_leg = _leg(spot, (far - entry_day).days, rate, q, slope, points)
    if spec.max_term_ratio is not None and far_leg.atm > spec.max_term_ratio * near_leg.atm:
        return "term structure"
    strike = _anchor_strike(near_leg, right, spec.strike_delta)
    near_mid, far_mid = _leg_mid(near_leg, right, strike), _leg_mid(far_leg, right, strike)
    entry_price = instrument_value("debit", far_mid, near_mid, 0.0)
    if entry_price <= 0:
        return "no premium"
    entry_fee = _fee(symbol, far_mid, near_mid)
    worst_exit = worst_exit_cost(symbol, far_mid)
    premium = far_mid - near_mid
    exit_signal = None if event.exit_index is None else event.exit_index + 1
    marks = [(market.dates[entry], entry_price)]
    stale = 0
    for bar in range(entry + 1, last + 1):
        day = parse(market.dates[bar])
        fresh = market.iv_index[bar] is not None and all(levels[bar] is not None for _, levels in market.iv_term)
        level = market.iv_index[bar] if market.iv_index[bar] is not None else level
        terms = tuple(old if levels[bar] is None else levels[bar] for (_, levels), old in zip(market.iv_term, terms))
        rate = market.rate[bar] if market.rate[bar] is not None else rate
        stale += not fresh or market.rate[bar] is None
        points = _term_points(market, level, terms)
        near_days, spot = (near - day).days, market.close[bar]
        near_mid = _leg_mid(_leg(spot, near_days, rate, q, slope, points), right, strike)
        far_mid = _leg_mid(_leg(spot, (far - day).days, rate, q, slope, points), right, strike)
        value = instrument_value("debit", far_mid, near_mid, 0.0)
        marks.append((market.dates[bar], value))
        reason = None
        if near_days <= 0:
            reason = "expiry"
        elif not fresh:
            reason = "stale-iv"
        elif spec.exit_dte is not None and near_days <= spec.exit_dte:
            reason = "exitDte"
        elif spec.profit_take_pct is not None and value >= entry_price * (1 + spec.profit_take_pct / 100):
            reason = "profitTake"
        elif bar == exit_signal:
            reason = "signal"
        elif bar == last:
            reason = "end"
        if reason is None:
            continue
        if reason == "expiry":  # the near leg settles at its intrinsic value (near_mid); the far leg is sold
            exit_fee = round(om.leg_cost(symbol, far_mid) + (om.leg_cost(symbol, near_mid) if near_mid > 0 else 0), 2)
        else:
            exit_fee = _fee(symbol, far_mid, near_mid)
        return PricedTrade(
            trade_id=trade_id, symbol=symbol, structure=spec.structure, expiry=near.isoformat(), long_strike=strike,
            short_strike=strike, width=0.0, entry_index=entry, exit_index=bar, entry_date=market.dates[entry],
            exit_date=market.dates[bar], entry_price=entry_price, exit_price=value, entry_fee=entry_fee,
            exit_fee=min(exit_fee, worst_exit), max_loss=round(entry_price + entry_fee + worst_exit, 2),
            max_loss_pct=spec.max_loss_pct, premium=premium, exit_reason=reason, marks=tuple(marks),
            stale_days=stale, far_expiry=far.isoformat())
    raise AssertionError("unreachable: the last bar always exits")


def _spec(options: Mapping | OptionsSpec | CalendarSpec) -> OptionsSpec | CalendarSpec:
    if isinstance(options, (OptionsSpec, CalendarSpec)):
        return options
    return parse_calendar(options) if options.get("structure") in CALENDARS else parse_options(options)


def build_book(events: Iterable[SignalEvent | Sequence], options: Mapping | OptionsSpec | CalendarSpec,
               markets: Mapping[str, Market]) -> Book:
    """Prices every event (a vertical, or a calendar for a CALENDARS structure). Trade ids follow the event
    order (accepted events only)."""
    spec = _spec(options)
    price = _price_calendar if isinstance(spec, CalendarSpec) else _price_event
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
        priced = price(event, market, spec, calendars[event.symbol], len(trades) + 1)
        if isinstance(priced, str):
            skipped.append(Skip(event, priced))
        else:
            trades.append(priced)
    return Book(tuple(trades), tuple(skipped))
