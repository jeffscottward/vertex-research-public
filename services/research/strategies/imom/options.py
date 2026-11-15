"""Vertex form (b) of the intraday-momentum study: same-day defined-risk debit verticals (research only).

Each underlying entry opens one debit vertical on the ETF twin in the signal direction (call vertical for
long, put vertical for short), at the underlying entry fill time, closed at the 16:00 close of the same
day; one spread per signal market and day (the first entry of the day; later ZAB re-entries that day are
ignored). Rules, as pre-registered (docs/specs/strategies/market-intraday-momentum.md):
- Underlying price = the ETF twin's 5-minute mid: the open of the bar starting at the entry time, and the
  close of the session's last bar (16:00). No ETF bar at the entry time -> no trade ("no ETF bar").
- Expiry = the nearest Friday weekly expiration (Thursday when Friday is an NYSE holiday) with at least one
  trading day left after the entry day. T in years = exact time from the entry (or exit) to 16:00 New York
  on the expiry day / 365 days.
- Strikes: qc_ports.book.choose_strikes (long leg nearest 0.50 delta on the strike grid, short leg 1 sigma
  of the remaining time further out); Black-Scholes with the qc_ports smile on the IV-index proxy of the
  PREVIOUS session close and the previous close's T-bill rate (no look-ahead); dividend yield per ETF. That row
  must be at most 5 calendar days older than the entry day, else no trade ("stale IV"). The 16:00 exit is priced
  with the same previous-close IV and rate (no intraday IV exists), only the spot and time to expiry move.
- Expiry deviates from the pre-registered "nearest expiry with >= 1 trading day left": the nearest FRIDAY weekly
  is used (Monday/Wednesday weeklies are not modeled), recorded in the spec's Deviations.
- Costs: $0.65 per contract and half the modeled bid/ask per leg (qc_ports.options.leg_cost), exit cost
  capped at the worst case (qc_ports.book.worst_exit_cost); max loss per contract = debit + costs.
- Sizing: contracts so the max loss is 2 % of equity (qc_ports.book.contracts_for, in both ledgers).
Booking: the spreads are qc_ports PricedTrade records on a synthetic clock (one synthetic day per distinct
event time: entries, and every session's 16:00 close), booked by qc_ports.nautilus_runner (NautilusTrader)
and cross-checked by qc_ports.ledger; equity is mapped back to the real times. qc_ports itself is unchanged.
"""
from __future__ import annotations

import bisect
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from strategies.qc_ports import options as om
from strategies.qc_ports.book import OptionsSpec, PricedTrade, choose_strikes, instrument_value, worst_exit_cost
from strategies.qc_ports.data import IV_INDEX, Market

from .data import CLOSE_MINUTE, SessionBars, is_closed, local_times, ms_at

YEAR_MS = 365 * 86_400_000
LONG_DELTA = 0.5
WIDTH_SIGMA = 1.0
MAX_LOSS_PCT = 2.0
SYNTHETIC_EPOCH = date(2000, 1, 1)
# The previous IV-index / T-bill row may be at most this many calendar days older than the entry day.
MAX_IV_AGE_DAYS = 5


@dataclass(frozen=True)
class OptionEvent:
    """One underlying entry to express: signal market, ETF twin, direction and the entry fill time (UTC ms)."""

    market: str
    twin: str
    side: str
    entry_ms: float


@dataclass(frozen=True)
class Spread:
    """A priced same-day vertical, per contract (qc_ports units: $ per contract)."""

    event: OptionEvent
    day: str
    expiry: str
    right: str
    long_strike: float
    short_strike: float
    width: float
    entry_spot: float
    exit_spot: float
    exit_ms: float
    entry_price: float
    exit_price: float
    entry_fee: float
    exit_fee: float
    max_loss: float
    premium: float
    iv: float
    rate: float


def weekly_expiry(day: str | date) -> date:
    """Nearest Friday weekly expiration with at least one trading day after `day` (Thursday when the
    Friday is a holiday)."""
    start = date.fromisoformat(day) if isinstance(day, str) else day
    probe = start + timedelta(days=1)
    while True:
        if probe.weekday() == 4:
            expiry = probe
            while is_closed(expiry):
                expiry -= timedelta(days=1)
            if expiry > start:
                return expiry
        probe += timedelta(days=1)


def years_to_close(t_ms: float, expiry: date) -> float:
    return max(0.0, (ms_at(expiry.isoformat(), CLOSE_MINUTE) - t_ms) / YEAR_MS)


def _fee(symbol: str, long_mid: float, short_mid: float) -> float:
    return round(om.leg_cost(symbol, long_mid) + om.leg_cost(symbol, short_mid), 2)


class EtfClock:
    """The ETF twin's 5-minute bars by bar time, and each session's last close."""

    def __init__(self, bars: SessionBars) -> None:
        self.open_at = {t: o for t, o in zip(bars.t, bars.o)}
        self.close_of_day: dict[str, tuple[float, float]] = {}
        for (day, minute), t, c in zip(local_times(bars.t), bars.t, bars.c):
            self.close_of_day[day] = (t + 5 * 60_000, c)
        self.days = tuple(sorted(self.close_of_day))


def previous_index(market: Market, day: str) -> int | None:
    """Index of the last daily bar strictly before `day`."""
    i = bisect.bisect_left(market.dates, day) - 1
    return i if i >= 0 else None


def price_event(event: OptionEvent, etf: EtfClock, market: Market) -> Spread | str:
    day = local_times([event.entry_ms])[0][0]
    spot = etf.open_at.get(event.entry_ms)
    if spot is None:
        return "no ETF bar"
    close = etf.close_of_day.get(day)
    if close is None or close[0] <= event.entry_ms:
        return "no ETF close"
    exit_ms, exit_spot = close
    prev = previous_index(market, day)
    if prev is None:
        return "no previous close"
    if (date.fromisoformat(day) - date.fromisoformat(market.dates[prev])).days > MAX_IV_AGE_DAYS:
        return "stale IV"
    level, rate = market.iv_index[prev], market.rate[prev]
    if level is None:
        return "no IV"
    if rate is None:
        return "no rate"
    expiry = weekly_expiry(day)
    right = "call" if event.side == "long" else "put"
    structure = "callDebitVertical" if right == "call" else "putDebitVertical"
    spec = OptionsSpec(structure, dte_target=7, dte_min=1, width_sigma=WIDTH_SIGMA, max_loss_pct=MAX_LOSS_PCT,
                       long_delta=LONG_DELTA)
    symbol = event.twin
    q = om.DIVIDEND_YIELD.get(symbol, 0.0)
    slope = om.SKEW[symbol]
    atm = om.atm_iv(IV_INDEX[symbol], level)
    t_entry = years_to_close(event.entry_ms, expiry)
    strikes = choose_strikes(right, "debit", spot, t_entry, rate, q, atm, slope, spec)
    if strikes is None:
        return "no strikes"
    long_strike, short_strike, width = strikes

    def legs(s: float, t: float) -> tuple[float, float]:
        if t <= 0:
            payoff = (lambda k: max(0.0, s - k)) if right == "call" else (lambda k: max(0.0, k - s))
            return payoff(long_strike), payoff(short_strike)
        return (om.bs_price(right, s, long_strike, t, rate, q, om.smile_iv(atm, s, long_strike, t, slope)),
                om.bs_price(right, s, short_strike, t, rate, q, om.smile_iv(atm, s, short_strike, t, slope)))

    long_mid, short_mid = legs(spot, t_entry)
    entry_price = instrument_value("debit", long_mid, short_mid, width)
    if entry_price <= 0:
        return "no premium"
    entry_fee = _fee(symbol, long_mid, short_mid)
    worst_exit = worst_exit_cost(symbol, width)
    x_long, x_short = legs(exit_spot, years_to_close(exit_ms, expiry))
    exit_price = instrument_value("debit", x_long, x_short, width)
    return Spread(event=event, day=day, expiry=expiry.isoformat(), right=right, long_strike=long_strike,
                  short_strike=short_strike, width=width, entry_spot=spot, exit_spot=exit_spot, exit_ms=exit_ms,
                  entry_price=entry_price, exit_price=exit_price, entry_fee=entry_fee,
                  exit_fee=min(_fee(symbol, x_long, x_short), worst_exit),
                  max_loss=round(entry_price + entry_fee + worst_exit, 2), premium=abs(long_mid - short_mid),
                  iv=atm, rate=rate)


def first_per_day(events: Sequence[OptionEvent]) -> list[OptionEvent]:
    """The first entry of each (signal market, day), in entry-time order."""
    seen: set[tuple[str, str]] = set()
    out = []
    for event in sorted(events, key=lambda e: (e.entry_ms, e.market)):
        key = (event.market, local_times([event.entry_ms])[0][0])
        if key not in seen:
            seen.add(key)
            out.append(event)
    return out


def price_events(events: Sequence[OptionEvent], etfs: Mapping[str, EtfClock], markets: Mapping[str, Market]
                 ) -> tuple[list[Spread], list[dict]]:
    spreads, skipped = [], []
    for event in first_per_day(events):
        priced = price_event(event, etfs[event.twin], markets[event.twin])
        if isinstance(priced, str):
            skipped.append({"market": event.market, "entryMs": event.entry_ms, "reason": priced})
        else:
            spreads.append(priced)
    return spreads, skipped


@dataclass(frozen=True)
class SyntheticClock:
    """Maps real event times (UTC ms) to synthetic ISO dates one day apart, in time order."""

    times: tuple[float, ...]

    def key(self, t_ms: float) -> str:
        index = bisect.bisect_left(self.times, t_ms)
        if index >= len(self.times) or self.times[index] != t_ms:
            raise KeyError(t_ms)
        return (SYNTHETIC_EPOCH + timedelta(days=index)).isoformat()

    def real(self, key: str) -> float:
        return self.times[(date.fromisoformat(key) - SYNTHETIC_EPOCH).days]

    def keys(self) -> list[str]:
        return [(SYNTHETIC_EPOCH + timedelta(days=i)).isoformat() for i in range(len(self.times))]


def to_priced(spreads: Sequence[Spread], session_closes: Sequence[float]) -> tuple[list[PricedTrade], SyntheticClock]:
    """qc_ports PricedTrade records on the synthetic clock (event times plus every session close)."""
    times = sorted({s.event.entry_ms for s in spreads} | {s.exit_ms for s in spreads} | set(session_closes))
    clock = SyntheticClock(tuple(times))
    trades = []
    for trade_id, s in enumerate(sorted(spreads, key=lambda x: (x.event.entry_ms, x.event.market)), start=1):
        entry_key, exit_key = clock.key(s.event.entry_ms), clock.key(s.exit_ms)
        trades.append(PricedTrade(
            trade_id=trade_id, symbol=s.event.twin, structure="callDebitVertical" if s.right == "call" else
            "putDebitVertical", expiry=s.expiry, long_strike=s.long_strike, short_strike=s.short_strike, width=s.width,
            entry_index=0, exit_index=1, entry_date=entry_key, exit_date=exit_key, entry_price=s.entry_price,
            exit_price=s.exit_price, entry_fee=s.entry_fee, exit_fee=s.exit_fee, max_loss=s.max_loss,
            max_loss_pct=MAX_LOSS_PCT, premium=s.premium, exit_reason="close",
            marks=((entry_key, s.entry_price), (exit_key, s.exit_price))))
    return trades, clock


def daily_points_of(result, clock: SyntheticClock) -> list[tuple[str, float]]:
    """(New York day, equity at its last synthetic time) from a ledger or Nautilus result."""
    out: list[tuple[str, float]] = []
    days = local_times([clock.real(key) - 1 for key in result.dates])
    for (day, _), value in zip(days, result.equity):
        if out and out[-1][0] == day:
            out[-1] = (day, value)
        else:
            out.append((day, value))
    return out


def book(spreads: Sequence[Spread], session_closes: Sequence[float], capital: float, *, nautilus: bool = True) -> dict:
    """Books the spreads in the qc_ports ledger and (by default) in Nautilus; daily equity of both."""
    from strategies.qc_ports.ledger import run_ledger

    trades, clock = to_priced(spreads, session_closes)
    ledger = run_ledger(trades, capital, clock.keys())
    out = {"ledger": ledger, "ledgerPoints": daily_points_of(ledger, clock), "clock": clock, "trades": trades}
    if nautilus:
        from strategies.qc_ports.nautilus_runner import run_nautilus

        naut = run_nautilus(trades, capital, clock.keys())
        out["nautilus"] = naut
        out["points"] = daily_points_of(naut, clock)
        out["maxGap"] = max((abs(a - b) for a, b in zip(ledger.equity, naut.equity)), default=0.0)
    else:
        out["points"] = out["ledgerPoints"]
        out["maxGap"] = None
    return out


def spread_returns(result, capital: float) -> list[float]:
    """Per-trade P&L over the equity at the synthetic time before its entry."""
    position = {key: i for i, key in enumerate(result.dates)}
    out = []
    for record in result.trades:
        i = position.get(record["entryDate"], 0)
        before = result.equity[i - 1] if i > 0 else capital
        if before and math.isfinite(before) and before > 0:
            out.append(record["pnl"] / before)
    return out
