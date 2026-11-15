"""Vertex form (c) of the volume-spike-breakout study: defined-risk debit verticals on QQQ (research only).

Each NAS100 signal of the rule opens one debit vertical on QQQ in the signal direction (call vertical for a
long, put vertical for a short). Pre-registered (docs/specs/strategies/volume-spike-breakout.md):
- Entry: the open of the first regular-session QQQ minute at or after the rule's entry, so a signal before
  09:30 opens the spread at 09:30. Exit: the open of the first regular QQQ minute at or after the time the
  rule's exit is known. An exit at a bar open (opposite signal, time stop, a stop gapped through) is known at
  that open; a stop touched inside a 1-minute bar is known only when that minute ends, so its spread closes at
  the open of the next minute (no look-ahead into the stop minute). A rule trade whose exit is already known
  when its spread would open ("closed before the open", for example stopped before 09:30) opens no spread; a
  trade stopped inside its entry minute does open one. A spread still open at its expiry settles at intrinsic
  value at that close.
- Expiry: the nearest Friday weekly (Thursday when the Friday is an NYSE holiday) with at least 2 trading
  days left after the entry day.
- Strikes: long leg nearest 0.50 delta on the strike grid, short leg 1 sigma of the remaining time further
  out (qc_ports.book.choose_strikes). Black-Scholes with the qc_ports smile on the VXN close of the session
  before the pricing day and that day's 13-week T-bill rate (no look-ahead); that row must be at most 5
  calendar days old, else no trade ("stale IV"). The exit and the marks at the session closes in between use
  the previous close of their own day.
- Costs: 0.65 USD per contract and half the modeled bid/ask per leg (qc_ports.options.leg_cost), the exit
  cost capped at the worst case; maximum loss per contract = debit + costs.
- Size: contracts so the maximum loss is 2 % of equity (qc_ports.book.contracts_for, in both ledgers).
- Row c1 uses every exit of the rule (stop included). Row c2 uses the rule without the 15-point stop (the
  debit is the defined risk): only the opposite signal and the time stop close it.
Booking: qc_ports PricedTrade records on the synthetic clock of the market-intraday-momentum options form,
booked by qc_ports.nautilus_runner (NautilusTrader) and cross-checked by qc_ports.ledger.
"""
from __future__ import annotations

import bisect
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np

from strategies.imom.data import CLOSE_MINUTE, is_closed, ms_at
from strategies.imom.options import SyntheticClock, daily_points_of, spread_returns, years_to_close
from strategies.qc_ports import options as om
from strategies.qc_ports.book import OptionsSpec, PricedTrade, choose_strikes, instrument_value, worst_exit_cost
from strategies.qc_ports.data import IV_INDEX, Market

from . import rules

SYMBOL = "QQQ"
LONG_DELTA = 0.5
WIDTH_SIGMA = 1.0
MAX_LOSS_PCT = 2.0
MIN_TRADING_DAYS = 2
MAX_IV_AGE_DAYS = 5
MINUTE_MS = 60_000


@dataclass(frozen=True)
class Signal:
    """One trade of the rule to express: direction, the rule's entry time and the time its exit is KNOWN (UTC
    ms). An exit that fills at a bar open is known at that open; a stop touched inside a bar is known only when
    that bar ends (`signals_of`)."""

    side: str
    entry_ms: int
    exit_ms: int


@dataclass(frozen=True)
class PricedSpread:
    """A priced vertical, per contract (qc_ports units: USD per contract)."""

    signal: Signal
    right: str
    entry_ms: int
    exit_ms: int
    day: str
    expiry: str
    long_strike: float
    short_strike: float
    width: float
    entry_spot: float
    exit_spot: float
    entry_price: float
    exit_price: float
    entry_fee: float
    exit_fee: float
    max_loss: float
    premium: float
    iv: float
    rate: float
    exit_reason: str  # rule | expiry
    marks: tuple[tuple[int, float], ...]  # (session close UTC ms, value) between entry and exit


class TwinClock:
    """Regular-session 1-minute bars of the ETF twin: opens by minute and each session's close."""

    def __init__(self, m: rules.Minutes) -> None:
        self.t = np.asarray(m.t, dtype=np.int64)
        self.o = m.o
        day = rules.ny_local_ms(self.t) // rules.DAY_MS
        last = np.flatnonzero(np.concatenate((day[1:] != day[:-1], [True]))) if len(m) else np.zeros(0, dtype=int)
        self.days = [rules.day_text(day[i]) for i in last]
        self.close_ms = [int(self.t[i]) + MINUTE_MS for i in last]
        self.close_price = [float(m.c[i]) for i in last]

    def at_or_after(self, t_ms: int) -> int | None:
        index = int(np.searchsorted(self.t, t_ms, side="left"))
        return index if index < self.t.shape[0] else None

    def session(self, day: str) -> tuple[int, float] | None:
        index = bisect.bisect_left(self.days, day)
        if index < len(self.days) and self.days[index] == day:
            return self.close_ms[index], self.close_price[index]
        return None

    def closes_between(self, after_ms: int, before_ms: int) -> list[tuple[str, int, float]]:
        first = bisect.bisect_right(self.close_ms, after_ms)
        last = bisect.bisect_left(self.close_ms, before_ms)
        return [(self.days[i], self.close_ms[i], self.close_price[i]) for i in range(first, last)]


def weekly_expiry(day: str | date, min_days: int = MIN_TRADING_DAYS) -> date:
    """Nearest Friday weekly expiration (Thursday when the Friday is closed) with at least `min_days` trading
    days after `day` up to and including the expiry."""
    start = date.fromisoformat(day) if isinstance(day, str) else day
    probe = start + timedelta(days=1)
    while True:
        if probe.weekday() == 4:
            expiry = probe
            while is_closed(expiry):
                expiry -= timedelta(days=1)
            ahead = sum(1 for n in range(1, (expiry - start).days + 1) if not is_closed(start + timedelta(days=n)))
            if expiry > start and ahead >= min_days:
                return expiry
        probe += timedelta(days=1)


def iv_before(market: Market, day: str) -> tuple[float, float] | str:
    """(ATM IV, rate) from the last daily row strictly before `day`, or the reason there is none."""
    index = bisect.bisect_left(market.dates, day) - 1
    if index < 0:
        return "no previous close"
    if (date.fromisoformat(day) - date.fromisoformat(market.dates[index])).days > MAX_IV_AGE_DAYS:
        return "stale IV"
    level, rate = market.iv_index[index], market.rate[index]
    if level is None:
        return "no IV"
    if rate is None:
        return "no rate"
    return om.atm_iv(IV_INDEX[market.symbol], level), rate


def _local_day(t_ms: int) -> str:
    return rules.day_text(int(rules.ny_local_ms(np.array([t_ms]))[0] // rules.DAY_MS))


def price_signal(signal: Signal, twin: TwinClock, market: Market, symbol: str = SYMBOL) -> PricedSpread | str:
    at = twin.at_or_after(signal.entry_ms)
    if at is None:
        return "no ETF bar"
    entry_ms, spot = int(twin.t[at]), float(twin.o[at])
    out = twin.at_or_after(signal.exit_ms)
    if out is None:
        return "no ETF bar at the exit"
    exit_ms, exit_spot = int(twin.t[out]), float(twin.o[out])
    if exit_ms <= entry_ms:
        return "closed before the open"
    day = _local_day(entry_ms)
    priced = iv_before(market, day)
    if isinstance(priced, str):
        return priced
    atm, rate = priced
    expiry = weekly_expiry(day)
    expiry_close = int(ms_at(expiry.isoformat(), CLOSE_MINUTE))
    reason = "rule"
    if exit_ms >= expiry_close:
        session = twin.session(expiry.isoformat())
        if session is None:
            return "no ETF close at expiry"
        exit_ms, exit_spot = session
        reason = "expiry"
    right = "call" if signal.side == "long" else "put"
    structure = "callDebitVertical" if right == "call" else "putDebitVertical"
    spec = OptionsSpec(structure, dte_target=7, dte_min=MIN_TRADING_DAYS, width_sigma=WIDTH_SIGMA,
                       max_loss_pct=MAX_LOSS_PCT, long_delta=LONG_DELTA)
    q = om.DIVIDEND_YIELD.get(symbol, 0.0)
    slope = om.SKEW[symbol]
    t_entry = years_to_close(entry_ms, expiry)
    strikes = choose_strikes(right, "debit", spot, t_entry, rate, q, atm, slope, spec)
    if strikes is None:
        return "no strikes"
    long_strike, short_strike, width = strikes

    def legs(s: float, t: float, vol: float, r: float) -> tuple[float, float]:
        if t <= 0:
            payoff = (lambda k: max(0.0, s - k)) if right == "call" else (lambda k: max(0.0, k - s))
            return payoff(long_strike), payoff(short_strike)
        return (om.bs_price(right, s, long_strike, t, r, q, om.smile_iv(vol, s, long_strike, t, slope)),
                om.bs_price(right, s, short_strike, t, r, q, om.smile_iv(vol, s, short_strike, t, slope)))

    def value_at(t_ms: int, s: float) -> tuple[float, float, float] | None:
        """(value, long mid, short mid) priced with the previous close of the day of `t_ms`."""
        t = years_to_close(t_ms, expiry)
        if t <= 0:
            long_mid, short_mid = legs(s, 0.0, atm, rate)
        else:
            later = iv_before(market, _local_day(t_ms - 1))
            if isinstance(later, str):
                return None
            long_mid, short_mid = legs(s, t, later[0], later[1])
        return instrument_value("debit", long_mid, short_mid, width), long_mid, short_mid

    long_mid, short_mid = legs(spot, t_entry, atm, rate)
    entry_price = instrument_value("debit", long_mid, short_mid, width)
    if entry_price <= 0:
        return "no premium"
    entry_fee = round(om.leg_cost(symbol, long_mid) + om.leg_cost(symbol, short_mid), 2)
    worst_exit = worst_exit_cost(symbol, width)
    closing = value_at(exit_ms, exit_spot)
    if closing is None:
        return "stale IV at the exit"
    exit_price, x_long, x_short = closing
    exit_fee = min(round(om.leg_cost(symbol, x_long) + om.leg_cost(symbol, x_short), 2), worst_exit)
    marks = []
    for _, close_ms, close_price in twin.closes_between(entry_ms, exit_ms):
        marked = value_at(close_ms, close_price)
        if marked is not None:
            marks.append((close_ms, marked[0]))
    return PricedSpread(
        signal=signal, right=right, entry_ms=entry_ms, exit_ms=exit_ms, day=day, expiry=expiry.isoformat(),
        long_strike=long_strike, short_strike=short_strike, width=width, entry_spot=spot, exit_spot=exit_spot,
        entry_price=entry_price, exit_price=exit_price, entry_fee=entry_fee, exit_fee=exit_fee,
        max_loss=round(entry_price + entry_fee + worst_exit, 2), premium=abs(long_mid - short_mid), iv=atm,
        rate=rate, exit_reason=reason, marks=tuple(marks))


def price_signals(signals: Sequence[Signal], twin: TwinClock, market: Market, symbol: str = SYMBOL
                  ) -> tuple[list[PricedSpread], dict[str, int]]:
    """Priced spreads in entry order and the count of skipped signals per reason."""
    spreads: list[PricedSpread] = []
    skipped: dict[str, int] = {}
    for signal in sorted(signals, key=lambda s: s.entry_ms):
        priced = price_signal(signal, twin, market, symbol)
        if isinstance(priced, str):
            skipped[priced] = skipped.get(priced, 0) + 1
        else:
            spreads.append(priced)
    return spreads, skipped


def to_priced(spreads: Sequence[PricedSpread], session_closes: Sequence[int], symbol: str = SYMBOL
              ) -> tuple[list[PricedTrade], SyntheticClock]:
    """qc_ports PricedTrade records on the synthetic clock (entries, exits and every session close), marked
    at the session closes between entry and exit."""
    times = sorted({s.entry_ms for s in spreads} | {s.exit_ms for s in spreads} | {int(t) for t in session_closes})
    clock = SyntheticClock(tuple(float(t) for t in times))
    known = set(times)
    trades = []
    for trade_id, s in enumerate(sorted(spreads, key=lambda x: x.entry_ms), start=1):
        entry_key, exit_key = clock.key(float(s.entry_ms)), clock.key(float(s.exit_ms))
        between = tuple((clock.key(float(t)), value) for t, value in s.marks if t in known)
        trades.append(PricedTrade(
            trade_id=trade_id, symbol=symbol,
            structure="callDebitVertical" if s.right == "call" else "putDebitVertical", expiry=s.expiry,
            long_strike=s.long_strike, short_strike=s.short_strike, width=s.width, entry_index=0, exit_index=1,
            entry_date=entry_key, exit_date=exit_key, entry_price=s.entry_price, exit_price=s.exit_price,
            entry_fee=s.entry_fee, exit_fee=s.exit_fee, max_loss=s.max_loss, max_loss_pct=MAX_LOSS_PCT,
            premium=s.premium, exit_reason=s.exit_reason,
            marks=((entry_key, s.entry_price), *between, (exit_key, s.exit_price))))
    return trades, clock


def book(spreads: Sequence[PricedSpread], session_closes: Sequence[int], capital: float, *, nautilus: bool = True
         ) -> dict:
    """Books the spreads in the qc_ports ledger and (by default) in Nautilus; daily equity of both."""
    from strategies.qc_ports.ledger import run_ledger

    trades, clock = to_priced(spreads, session_closes)
    ledger = run_ledger(trades, capital, clock.keys())
    out = {"ledger": ledger, "ledgerPoints": daily_points_of(ledger, clock), "trades": trades}
    result = ledger
    if nautilus:
        from strategies.qc_ports.nautilus_runner import run_nautilus

        result = run_nautilus(trades, capital, clock.keys())
        out["maxGap"] = max((abs(a - b) for a, b in zip(ledger.equity, result.equity)), default=0.0)
    else:
        out["maxGap"] = None
    out["result"] = result
    out["points"] = daily_points_of(result, clock)
    out["returns"] = spread_returns(result, capital)
    return out


def signals_of(trades: Sequence[rules.Trade], bar_ms: int = MINUTE_MS) -> list[Signal]:
    """The rule's trades as option signals without look-ahead: an exit inside its bar (a stop that was touched,
    the end of the data) is known at the end of that bar, `bar_ms` after its open; the spread then closes at the
    first regular QQQ minute at or after that time, not at the open of the minute the stop happened in."""
    return [Signal(t.side_name, t.entry_ms, t.exit_ms if t.exit_at_open else t.exit_ms + bar_ms) for t in trades]


__all__ = ["MAX_LOSS_PCT", "SYMBOL", "PricedSpread", "Signal", "TwinClock", "book", "iv_before", "price_signal",
           "price_signals", "signals_of", "to_priced", "weekly_expiry"]
