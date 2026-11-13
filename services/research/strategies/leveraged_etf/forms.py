"""Forms of the leveraged-ETF short-window study: one signal, one window, five instruments (research only).

Data shapes (read from the reuse targets before any code was written):

- `signals.Signal` (this package): `signal` (S1 or S2 id), `underlying` U, `side` +1 or -1, `day` (New York
  session day of the entry), `entry_ms` (UTC ms, the close time of a 5-minute bar of U) and `price` (U at
  the entry). It has no exit: the window gives the exit session.
- `WindowTrade` (this module): one signal priced in one form, per unit (one option contract, one vertical,
  or one share), in USD per unit: `entry_price`, `exit_price`, `entry_fee`, `exit_fee`, `max_loss`, and
  `marks` = (session day, value at its close) for the entry session and every session before the exit
  session. `exit_day` is the exit session. `structure` is `longCall`, `longPut`, `callDebitVertical`,
  `putDebitVertical` or `shares`.
- `qc_ports.book.PricedTrade` (the unit both ledgers book). Mapping from a WindowTrade:
  `trade_id` = 1.. in entry order; `symbol` = the instrument (U or a fund); `structure`, `expiry`,
  `long_strike` as priced; `short_strike` and `width` = the short leg and the width of a vertical, else
  the long strike and 0 (single option) or 0 and 0 (shares, `expiry` empty); `entry_index` 0 and
  `exit_index` 1 (not read by the ledgers); `entry_date` and `exit_date` = synthetic-clock keys of the
  entry time and of the 16:00 close of the exit session; `entry_price`, `exit_price`, `entry_fee`,
  `exit_fee`, `max_loss`, `premium` as priced; `max_loss_pct` = 2; `exit_reason` = `window`;
  `marks` = (entry key, entry price), (close key, value) per mark, (exit key, exit price).
  The ledgers size at the entry: units = floor(2% x equity / max_loss), capped by the cash
  (qc_ports.book.contracts_for); 0 units = the trade is refused (`skipped`, reason `size`).
- Clock: `imom.options.SyntheticClock`, one key per distinct event time (every entry time and every
  session close), as the intraday option forms of the imom and volspike studies use it.
  `daily_result` maps a booked result back to New York days for `qc_ports.metrics.summarize`.

Pricing rules (pre-registered, research/backtests/leveraged-etf/README.md):
- Instruments: `etf-option` and `etf-vertical` trade U; `lev-option` and `lev-vertical` trade the long
  fund; `lev-shares` buys shares of the long fund (side +1) or of the inverse fund (side -1).
- Expiry of every option form: the first Friday weekly (the last session of that week when the Friday is
  closed) with at least 3 sessions after the entry session (volspike.options.weekly_expiry).
- Strikes: long leg nearest 0.50 delta on the strike grid; the short leg of a vertical 1 sigma of the
  remaining time further out of the money (qc_ports.book.choose_strikes). Calls for +1, puts for -1.
- Prices: Black-Scholes with the qc_ports smile. U at the entry = the signal price; the fund at the entry
  = prices.synthetic_price from the previous closes, with U's dividend added back to the signal price
  when the entry session is U's ex-dividend date (`PairData.u_dividends`: the fund follows U's total
  return); at every later close the real daily close (the fund's as-traded close). IV of U: ATM factor
  x its Cboe index, at the entry from the previous session's close (volspike.options.iv_before: the
  previous daily bar, at most 5 calendar days old), at a close from that session's row; a
  missing index or rate at a close carries the last value used (counted in `stale_days`). IV of the fund
  = |leverage| x the IV of U at the same standardized moneyness: ATM x |leverage| and the smile slope of
  U (`fund_iv`). Rate = IRX; dividend yield of U as the model, of the fund 0.
- Costs: options 0.65 USD per contract and half the spread per leg and side (qc_ports.options.leg_cost);
  the spread class of U is the model's, a fund is charged 4% of mid (registered with
  qc_ports.forms.proxy_symbols in `fund_models`). A vertical closes as a package (capped at
  qc_ports.book.worst_exit_cost). A position worth less than its closing cost is left to expire: the
  closing cost is capped at the exit value, so the largest loss of an option form is premium + entry
  costs (`max_loss`). Shares: 10 basis points of the price per side; `max_loss` = price + entry cost.
- Not priced (reason counted per form): no daily bar or previous close, no exit session, no or stale IV,
  no fund close, a split of the instrument after the previous close and up to the exit session, no
  strikes, no premium, a U entry price more than 30% from the previous close (a data error), and for an
  option form an exit session on or after the expiry day (`EXIT_AT_EXPIRY`: the exit session comes from
  U's daily bars, the expiry from the NYSE calendar, so a hole in the bars could put them together).
- The share form needs no IV: `lev-shares` also prices a signal that the option forms skip for "no IV".
- `stale_days` counts the mark and exit closes whose IV index or rate is None in `PairData.market`.
  qc_ports.data.load_market already carries a source value for up to 5 bar dates before it gives None;
  a value carried there is not counted.
"""
from __future__ import annotations

import bisect
import contextlib
import math
import os
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date

from strategies.imom import data as idata
from strategies.imom.options import SyntheticClock, spread_returns, years_to_close
from strategies.qc_ports import data as qd
from strategies.qc_ports import forms as fm
from strategies.qc_ports import options as om
from strategies.qc_ports.book import OptionsSpec, PricedTrade, choose_strikes, instrument_value, worst_exit_cost
from strategies.qc_ports.ledger import LedgerResult, run_ledger
from strategies.qc_ports.portfolio import PARITY_REL_TOL
from strategies.volspike import options as vopt

from . import prices
from .pairs import PAIRS, Pair
from .signals import WINDOWS, Signal

__all__ = ["ETF_FORMS", "EXIT_AT_EXPIRY", "FORM_KEYS", "FUND_HALF_SPREAD_PCT", "LONG_DELTA", "MAX_ENTRY_GAP",
           "MAX_LOSS_PCT", "MIN_EXPIRY_SESSIONS", "OPTION_FORMS", "SHARE_COST_RATE", "WIDTH_SIGMA", "BookingMismatch",
           "PairData", "WindowTrade", "book", "check_parity", "close_ms", "daily_result", "first_day", "fund_iv",
           "fund_models", "load_pair", "price_trade", "price_trades", "to_priced"]

FORM_KEYS = ("etf-option", "etf-vertical", "lev-option", "lev-vertical", "lev-shares")
ETF_FORMS = ("etf-option", "etf-vertical")
OPTION_FORMS = ("etf-option", "etf-vertical", "lev-option", "lev-vertical")
MAX_LOSS_PCT = 2.0
LONG_DELTA = 0.5
WIDTH_SIGMA = 1.0
MIN_EXPIRY_SESSIONS = 3
FUND_HALF_SPREAD_PCT = 0.04
SHARE_COST_RATE = 0.001
MAX_ENTRY_GAP = 0.30
SHARE_DECIMALS = 2
EXIT_AT_EXPIRY = "exit on or after the expiry day"


class BookingMismatch(RuntimeError):
    """The ledger and NautilusTrader disagree on a row."""


@dataclass(frozen=True)
class PairData:
    """The loaded inputs of one pair: U's daily bars with IV index and rate, U's splits, both funds and
    U's cash dividend per ex-dividend date (prices.dividends)."""

    pair: Pair
    market: qd.Market
    u_splits: Mapping[str, float]
    long_fund: prices.FundBars
    inverse_fund: prices.FundBars
    u_dividends: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class WindowTrade:
    """One signal priced in one form, per unit (see the module text)."""

    signal: Signal
    window: str
    form: str
    symbol: str
    structure: str
    expiry: str
    long_strike: float
    short_strike: float
    width: float
    entry_spot: float
    exit_spot: float
    exit_day: str
    entry_price: float
    exit_price: float
    entry_fee: float
    exit_fee: float
    max_loss: float
    premium: float
    iv: float
    rate: float
    marks: tuple[tuple[str, float], ...]
    stale_days: int = 0


def load_pair(pair: Pair, fund_root: str | os.PathLike, qc_root: str | os.PathLike | None = None) -> PairData:
    """Reads the inputs of a pair: the qc-ports daily files of U and the fetch files of the funds. U's
    dividends come from `close` and `adj_close` of U's daily file."""
    bars = qd.load_bars(pair.underlying, qc_root)
    return PairData(pair, qd.load_market(pair.underlying, qc_root), prices.load_splits(pair.underlying, fund_root),
                    prices.load_fund(pair.long_fund, fund_root), prices.load_fund(pair.inverse_fund, fund_root),
                    prices.dividends(bars.dates, bars.close, bars.adj_close))


def first_day(data: PairData) -> str:
    """The first day every daily input of the pair exists: U's bar with an IV index value and a rate, and
    a close of both funds. A signal is used from the session after it (it needs the previous close)."""
    market = data.market
    priced = next((day for day, level, rate in zip(market.dates, market.iv_index, market.rate)
                   if level is not None and rate is not None), None)
    if priced is None:
        raise ValueError(f"{market.symbol}: no day with an IV index value and a rate")
    return max(priced, data.long_fund.dates[0], data.inverse_fund.dates[0])


@contextlib.contextmanager
def fund_models(pair_list: Sequence[Pair] = PAIRS) -> Iterator[None]:
    """Registers the long funds in the symbol tables of the option model for the time of the block:
    half spread 4% of mid, the smile slope of U, dividend yield 0."""
    models = {pair.long_fund: fm.ProxyModel(FUND_HALF_SPREAD_PCT, om.SKEW[pair.underlying]) for pair in pair_list}
    with fm.proxy_symbols(models, dict.fromkeys(models, 0.0)):
        yield


def fund_iv(atm_u: float, leverage: float, spot: float, strike: float, t: float, slope: float) -> float:
    """IV of a fund option: |leverage| x the IV of U at the same standardized moneyness. With ATM x
    |leverage| the standardized moneyness of the fund strike is that of the matching U strike, so the
    smile of U (same slope) is read at the same point and scaled by |leverage|."""
    return om.smile_iv(abs(leverage) * atm_u, spot, strike, t, slope)


def close_ms(day: str) -> float:
    """UTC ms of 16:00 New York on `day` (the time every session close is booked at)."""
    return idata.ms_at(day, idata.CLOSE_MINUTE)


def _shares(signal: Signal, window: str, symbol: str, spot: float, closes: Sequence[float], days: Sequence[str]
            ) -> WindowTrade | str:
    entry = round(spot, SHARE_DECIMALS)
    if entry <= 0:
        return "no price"
    values = [round(close, SHARE_DECIMALS) for close in closes]
    return WindowTrade(
        signal=signal, window=window, form="lev-shares", symbol=symbol, structure="shares", expiry="",
        long_strike=0.0, short_strike=0.0, width=0.0, entry_spot=spot, exit_spot=closes[-1], exit_day=days[-1],
        entry_price=entry, exit_price=values[-1], entry_fee=SHARE_COST_RATE * entry,
        exit_fee=SHARE_COST_RATE * values[-1], max_loss=entry * (1 + SHARE_COST_RATE), premium=entry, iv=0.0,
        rate=0.0, marks=tuple(zip(days[:-1], values[:-1])))


def price_trade(signal: Signal, window: str, form: str, data: PairData) -> WindowTrade | str:
    """The signal priced in `form` for `window`, or the reason it is not priced. The option forms of a
    fund need the fund in the symbol tables (`fund_models`)."""
    if form not in FORM_KEYS:
        raise ValueError(f"Unknown form {form}")
    pair, market = data.pair, data.market
    if signal.underlying != pair.underlying:
        raise ValueError(f"signal on {signal.underlying} priced with the data of {pair.underlying}")
    entry = bisect.bisect_left(market.dates, signal.day)
    if entry >= len(market) or market.dates[entry] != signal.day:
        return "no daily bar on the entry day"
    if entry == 0:
        return "no previous close"
    last = entry + WINDOWS[window]
    if last >= len(market):
        return "no exit session"
    previous_day, days = market.dates[entry - 1], market.dates[entry:last + 1]
    u_previous = market.close[entry - 1]
    if abs(signal.price / u_previous - 1) > MAX_ENTRY_GAP:
        return "entry price far from the previous close"

    if form in ETF_FORMS:
        symbol, leverage, splits = pair.underlying, 1, data.u_splits
        spot: float | None = signal.price
        closes: list[float | None] = list(market.close[entry:last + 1])
        q = om.DIVIDEND_YIELD.get(symbol, 0.0)
    else:
        fund = data.long_fund if form != "lev-shares" or signal.side > 0 else data.inverse_fund
        symbol, splits = fund.symbol, fund.splits
        leverage = pair.leverage if fund is data.long_fund else -pair.leverage
        fund_previous = fund.close_on(previous_day)
        closes = [fund.close_on(day) for day in days]
        if fund_previous is None or any(close is None for close in closes):
            return "no fund close"
        spot = prices.synthetic_price(fund_previous, leverage, signal.price, u_previous,
                                      data.u_dividends.get(signal.day, 0.0))
        q = 0.0
    if prices.split_between(splits, previous_day, days[-1]):
        return "split in the window"
    if spot is None:
        return "no fund price"
    if form == "lev-shares":
        return _shares(signal, window, symbol, spot, closes, days)

    priced = vopt.iv_before(market, signal.day)
    if isinstance(priced, str):
        return priced
    atm_u, rate = priced
    index_id = qd.IV_INDEX[pair.underlying]
    multiple = abs(leverage)
    slope = om.SKEW[symbol]
    expiry = vopt.weekly_expiry(signal.day, MIN_EXPIRY_SESSIONS)
    if date.fromisoformat(days[-1]) >= expiry:
        return EXIT_AT_EXPIRY
    right = "call" if signal.side > 0 else "put"
    vertical = form.endswith("vertical")
    spread = "callDebitVertical" if right == "call" else "putDebitVertical"
    spec = OptionsSpec(spread, dte_target=7, dte_min=MIN_EXPIRY_SESSIONS, width_sigma=WIDTH_SIGMA,
                       max_loss_pct=MAX_LOSS_PCT, long_delta=LONG_DELTA)
    t_entry = years_to_close(signal.entry_ms, expiry)
    strikes = choose_strikes(right, "debit", spot, t_entry, rate, q, multiple * atm_u, slope, spec)
    if strikes is None:
        return "no strikes"
    long_strike, short_strike, width = strikes

    def mid(s: float, strike: float, t: float, atm: float, r: float) -> float:
        return om.bs_price(right, s, strike, t, r, q, fund_iv(atm, multiple, s, strike, t, slope))

    def value(s: float, t: float, atm: float, r: float) -> tuple[float, float, float]:
        """(USD per unit, model cost of trading it once, premium per share) at spot `s`."""
        long_mid = mid(s, long_strike, t, atm, r)
        if not vertical:
            return round(max(0.0, long_mid) * om.MULTIPLIER, 2), round(om.leg_cost(symbol, long_mid), 2), long_mid
        short_mid = mid(s, short_strike, t, atm, r)
        cost = round(om.leg_cost(symbol, long_mid) + om.leg_cost(symbol, short_mid), 2)
        return instrument_value("debit", long_mid, short_mid, width), cost, abs(long_mid - short_mid)

    entry_price, entry_fee, premium = value(spot, t_entry, atm_u, rate)
    if entry_price <= 0:
        return "no premium"
    atm_now, rate_now, stale = atm_u, rate, 0
    values: list[tuple[float, float]] = []
    for offset, (day, close) in enumerate(zip(days, closes)):
        level, row_rate = market.iv_index[entry + offset], market.rate[entry + offset]
        if level is None or row_rate is None:
            stale += 1
        if level is not None:
            atm_now = om.atm_iv(index_id, level)
        if row_rate is not None:
            rate_now = row_rate
        worth, cost, _ = value(close, years_to_close(close_ms(day), expiry), atm_now, rate_now)
        values.append((worth, cost))
    exit_price, exit_cost = values[-1]
    if vertical:
        exit_cost = min(exit_cost, worst_exit_cost(symbol, width))
    return WindowTrade(
        signal=signal, window=window, form=form, symbol=symbol,
        structure=spread if vertical else ("longCall" if right == "call" else "longPut"), expiry=expiry.isoformat(),
        long_strike=long_strike, short_strike=short_strike if vertical else long_strike,
        width=width if vertical else 0.0, entry_spot=spot, exit_spot=closes[-1], exit_day=days[-1],
        entry_price=entry_price, exit_price=exit_price, entry_fee=entry_fee, exit_fee=min(exit_cost, exit_price),
        max_loss=round(entry_price + entry_fee, 2), premium=premium, iv=multiple * atm_u, rate=rate,
        marks=tuple((day, worth) for day, (worth, _) in zip(days[:-1], values[:-1])), stale_days=stale)


def price_trades(signals: Sequence[Signal], window: str, form: str, data: Mapping[str, PairData]
                 ) -> tuple[list[WindowTrade], dict[str, int]]:
    """(priced trades in entry order, count of signals not priced per reason)."""
    trades: list[WindowTrade] = []
    reasons: dict[str, int] = {}
    for signal in sorted(signals, key=lambda s: (s.entry_ms, s.underlying, s.side)):
        priced = price_trade(signal, window, form, data[signal.underlying])
        if isinstance(priced, str):
            reasons[priced] = reasons.get(priced, 0) + 1
        else:
            trades.append(priced)
    return trades, reasons


def to_priced(trades: Sequence[WindowTrade], session_days: Sequence[str]) -> tuple[list[PricedTrade], SyntheticClock]:
    """qc_ports PricedTrade records on the synthetic clock: every entry time and the close of every day in
    `session_days` (it must hold every mark day and exit day)."""
    closes = {close_ms(day) for day in session_days}
    clock = SyntheticClock(tuple(sorted({trade.signal.entry_ms for trade in trades} | closes)))
    out = []
    ordered = sorted(trades, key=lambda t: (t.signal.entry_ms, t.signal.underlying, t.signal.side))
    for trade_id, trade in enumerate(ordered, start=1):
        entry_key, exit_key = clock.key(trade.signal.entry_ms), clock.key(close_ms(trade.exit_day))
        between = tuple((clock.key(close_ms(day)), worth) for day, worth in trade.marks)
        out.append(PricedTrade(
            trade_id=trade_id, symbol=trade.symbol, structure=trade.structure, expiry=trade.expiry,
            long_strike=trade.long_strike, short_strike=trade.short_strike, width=trade.width, entry_index=0,
            exit_index=1, entry_date=entry_key, exit_date=exit_key, entry_price=trade.entry_price,
            exit_price=trade.exit_price, entry_fee=trade.entry_fee, exit_fee=trade.exit_fee, max_loss=trade.max_loss,
            max_loss_pct=MAX_LOSS_PCT, premium=trade.premium, exit_reason="window",
            marks=((entry_key, trade.entry_price), *between, (exit_key, trade.exit_price)),
            stale_days=trade.stale_days))
    return out, clock


def daily_result(result: LedgerResult, clock: SyntheticClock) -> LedgerResult:
    """The booked result on New York days: equity and open positions at the last event of each day (its
    close), trade and refusal dates as days. This is what qc_ports.metrics.summarize reads."""
    days = [day for day, _ in idata.local_times([clock.real(key) - 1 for key in result.dates])]
    real = dict(zip(result.dates, days))
    dates: list[str] = []
    equity: list[float] = []
    held: list[int] = []
    for day, value, count in zip(days, result.equity, result.open_positions):
        if dates and dates[-1] == day:
            equity[-1], held[-1] = value, count
        else:
            dates.append(day)
            equity.append(value)
            held.append(count)
    trades = tuple({**record, "entryDate": real[record["entryDate"]], "exitDate": real[record["exitDate"]]}
                   for record in result.trades)
    skipped = tuple({**item, "entryDate": real[item["entryDate"]]} for item in result.skipped)
    return LedgerResult(tuple(dates), tuple(equity), tuple(held), trades, skipped, capital=result.capital,
                        engine=result.engine)


def check_parity(ledger: LedgerResult, other: LedgerResult) -> float:
    """The largest relative difference of the two equity series, when the books agree: the same number
    of points, every equity value finite and above 0, a difference of at most PARITY_REL_TOL on every
    point and the same units per trade. Else BookingMismatch. A NaN never passes: the test is
    `not gap <= tolerance`, and both series are checked for finite values first."""
    if len(ledger.equity) != len(other.equity):
        raise BookingMismatch(f"Ledger and Nautilus disagree: {len(ledger.equity)} against {len(other.equity)} "
                              "equity points")
    for name, series in (("ledger", ledger.equity), ("Nautilus", other.equity)):
        if not all(isinstance(value, (int, float)) and math.isfinite(value) and value > 0 for value in series):
            raise BookingMismatch(f"The {name} equity has a value that is not a finite number above 0")
    gap = max((abs(a - b) / max(abs(a), abs(b)) for a, b in zip(ledger.equity, other.equity, strict=True)),
              default=0.0)
    units = [(record["id"], record["contracts"]) for record in ledger.trades]
    same = units == [(record["id"], record["contracts"]) for record in other.trades]
    if not gap <= PARITY_REL_TOL or not same:
        raise BookingMismatch(f"Ledger and Nautilus disagree (gap {gap:.3g}, units match {same})")
    return gap


def book(trades: Sequence[WindowTrade], session_days: Sequence[str], capital: float, *, nautilus: bool = True) -> dict:
    """Books the trades in the qc_ports ledger and (by default) in NautilusTrader, which must agree
    (`check_parity`): equity within 1e-6 relative on every clock key and the same units per trade, else
    BookingMismatch.

    Returns `daily` (the result on New York days), `returns` (profit of each booked trade over the equity
    before its entry), `gap` (largest relative equity difference, None without Nautilus), `engine` and
    `priced`. The result is the ledger's; Nautilus confirms it."""
    priced, clock = to_priced(trades, session_days)
    keys = clock.keys()
    ledger = run_ledger(priced, capital, keys)
    gap, engine = None, ledger.engine
    if nautilus:
        from strategies.qc_ports.nautilus_runner import run_nautilus

        other = run_nautilus(priced, capital, keys)
        gap = check_parity(ledger, other)
        engine = other.engine
    return {"daily": daily_result(ledger, clock), "returns": spread_returns(ledger, capital), "gap": gap,
            "engine": engine, "priced": priced}
