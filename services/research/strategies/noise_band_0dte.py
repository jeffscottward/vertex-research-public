"""Noise-band signal expressed with SPY 0DTE options (variant 2 of the re-test). Research only.

The signal is the primary stock run's round trips (same day, side, entry and exit minute). Each round trip
becomes one defined-risk option trade on the same-day expiry, priced from real bid/ask quotes:

- Instrument A ("single", the verdict): buy the nearest-to-the-money call (long signal) or put (short
  signal) at the ask at the entry minute; sell it at the bid at the exit minute. Owner exit rule
  (2026-11-03): an option still open at 15:45 ET on expiry day is closed then, never exercised, so every
  exit after 15:45 (the stock run's 16:00 close exit) sells at the 15:45 quote. A zero or missing exit bid
  counts as 0.
- Instrument B ("vertical"): buy the ATM strike at the ask and sell the strike `width` further out of the
  money at the bid; close with the long's bid minus the short's ask.

Size: contracts = floor(cap × equity at the start of the day / (debit × 100)), cap = 2% (owner per-name
premium cap), so the premium at risk per trade is at most 2% of equity. A trade is skipped when one
contract costs more, or when a needed quote is missing. Commission USD 0.65 per contract per side.

The quote source is pluggable (QuoteBook); quotes are keyed by session minute (minutes from 09:30 ET).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Literal, Protocol, Sequence

from strategies.noise_band import BacktestResult, DayResult, Params, Trade

Instrument = Literal["single", "vertical"]
LAST_EXIT_MINUTE = 375  # 15:45 ET: owner rule, open options close at 15:45 on expiry day


class QuoteBook(Protocol):
    def strikes(self, day: date) -> Sequence[float]:
        """Listed strikes of the expiry that settles on `day` (empty: no 0DTE expiry that day)."""
        ...

    def quote(self, day: date, minute: int, right: str, strike: float) -> tuple[float, float] | None:
        """(bid, ask) of the 0DTE contract at the session minute, or None when no quote exists."""
        ...


@dataclass(frozen=True)
class OptionParams:
    instrument: Instrument = "single"
    premium_cap: float = 0.02
    commission_per_contract: float = 0.65
    width: float = 5.0
    aum0: float = 100_000.0


def nearest_strike(strikes: Sequence[float], price: float) -> float:
    return min(strikes, key=lambda k: (abs(k - price), k))


def _quote_minute(minute: int) -> int:
    return min(minute, LAST_EXIT_MINUTE)


def price_trade(book: QuoteBook, t: Trade, underlying: float, equity: float, p: OptionParams) -> Trade | None:
    """One stock round trip -> one option round trip, or None when it cannot be priced or sized."""
    strikes = book.strikes(t.day)
    if not strikes:
        return None
    right = "C" if t.side > 0 else "P"
    k = nearest_strike(strikes, underlying)
    em, xm = _quote_minute(t.entry_minute), _quote_minute(t.exit_minute)
    q_in = book.quote(t.day, em, right, k)
    if q_in is None or q_in[1] <= 0:
        return None
    if p.instrument == "single":
        debit = q_in[1]
        q_out = book.quote(t.day, xm, right, k)
        credit = max(q_out[0], 0.0) if q_out else 0.0
        legs = 1
        strike_label = k
    else:
        k2 = k + p.width if right == "C" else k - p.width
        if k2 not in set(strikes):
            return None
        s_in = book.quote(t.day, em, right, k2)
        if s_in is None:
            return None
        debit = q_in[1] - s_in[0]
        if debit <= 0:
            return None
        l_out = book.quote(t.day, xm, right, k)
        s_out = book.quote(t.day, xm, right, k2)
        if l_out is None or s_out is None:
            return None
        credit = l_out[0] - s_out[1]
        legs = 2
        strike_label = k
    n = math.floor(p.premium_cap * equity / (debit * 100.0))
    if n < 1:
        return None
    gross = n * 100.0 * (credit - debit)
    cost = 2 * legs * n * p.commission_per_contract
    return Trade(t.day, t.side, n, t.entry_minute, debit, t.exit_minute, credit, f"{t.exit_reason}:{right}{strike_label:g}", gross, cost)


def run_options(stock: BacktestResult, underlying_at_entry: dict[tuple[date, int], float], book: QuoteBook,
                days: Sequence[date], p: OptionParams = OptionParams()) -> tuple[BacktestResult, dict]:
    """Option equity curve over `days` (sessions with a 0DTE expiry and quotes). Days without a priced trade
    return 0. Sizing uses equity at the start of each day."""
    by_day: dict[date, list[Trade]] = {}
    for t in stock.trades:
        by_day.setdefault(t.day, []).append(t)
    res = BacktestResult(Params(aum0=p.aum0))
    aum = p.aum0
    skipped = {"no_quote_or_expiry": 0, "too_expensive_for_cap": 0}
    for d in days:
        start = aum
        priced: list[Trade] = []
        for t in by_day.get(d, []):
            u = underlying_at_entry.get((d, t.entry_minute))
            if u is None:
                skipped["no_quote_or_expiry"] += 1
                continue
            ot = price_trade(book, t, u, start, p)
            if ot is None:
                one = price_trade(book, t, u, 1e12, p)
                skipped["too_expensive_for_cap" if one is not None else "no_quote_or_expiry"] += 1
                continue
            priced.append(ot)
        pnl = sum(x.net for x in priced)
        res.days.append(DayResult(d, start, start + pnl, 0.0, bool(priced)))
        res.trades.extend(priced)
        aum = start + pnl
    return res, skipped
