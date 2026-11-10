"""Noise-band signal expressed with SPY 0DTE options (variant 2 of the re-test). Research only.

The signal is the primary stock run's round trips (same day, side, entry and exit minute). Each round trip
becomes one defined-risk option trade on the same-day expiry, priced from real bid/ask quotes:

- Instrument A ("single", the verdict): buy the nearest-to-the-money call (long signal) or put (short
  signal) at the ask at the entry minute; sell it at the bid at the exit minute. An exact strike tie goes
  out of the money. Owner exit rule (2026-11-03): an option still open 15 minutes before the close on expiry
  day is closed then, never exercised (15:45; 12:45 on a 13:00 half-day), so later stock exits sell at that
  quote. A zero or missing exit bid counts as 0.
- Instrument B ("vertical"): buy the ATM strike at the ask and sell the strike `width` further out of the
  money at the bid; close with the long's bid minus the short's ask (a missing short ask counts as its
  intrinsic value + 0.05). Closing at quotes can cost slightly more than the debit; this is reported.

Size: contracts = floor(cap × equity at the start of the day / (debit × 100)), cap = 2% (owner per-name
premium cap), so the premium paid per trade is at most 2% of equity; commission is outside the cap. A trade
is skipped (and counted by reason) only when it cannot be entered: no expiry, no entry quote, no wing strike,
a non-positive vertical debit, or one contract costing more than the cap. Commission USD 0.65 per contract
per side.

The quote source is pluggable (QuoteBook); quotes are keyed by session minute (minutes from 09:30 ET).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Literal, Protocol, Sequence

from strategies.noise_band import BacktestResult, DayResult, Params, Trade

Instrument = Literal["single", "vertical"]


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


def nearest_strike(strikes: Sequence[float], price: float, right: str = "C") -> float:
    """Nearest listed strike; an exact tie goes out of the money (higher for calls, lower for puts)."""
    if right == "C":
        return min(strikes, key=lambda k: (abs(k - price), -k))
    return min(strikes, key=lambda k: (abs(k - price), k))


def last_exit_minute(close_minute: int) -> int:
    """15 minutes before the session close: 375 (15:45) on a full day, 195 (12:45) on a 13:00 half-day."""
    return close_minute - 15


def _intrinsic(right: str, strike: float, underlying: float) -> float:
    return max(underlying - strike, 0.0) if right == "C" else max(strike - underlying, 0.0)


def price_trade(book: QuoteBook, t: Trade, u_entry: float, u_exit: float, equity: float, p: OptionParams,
                close_minute: int = 390) -> tuple[Trade | None, str]:
    """One stock round trip -> one option round trip. Returns (trade, "ok") or (None, skip reason).

    u_entry / u_exit: raw underlying price at the entry / exit quote minute (the open of the bar that starts
    then). Quote minute m means the quote as of 09:30 + m minutes. Once the entry is priced the trade is never
    skipped: a missing exit bid counts as 0 and a missing short-leg exit ask as intrinsic value + 0.05."""
    strikes = book.strikes(t.day)
    if not strikes:
        return None, "no_expiry"
    right = "C" if t.side > 0 else "P"
    k = nearest_strike(strikes, u_entry, right)
    cap = last_exit_minute(close_minute)
    em, xm = min(t.entry_minute, cap), min(t.exit_minute, cap)
    if t.entry_minute >= cap:
        return None, "entry_after_last_exit"
    q_in = book.quote(t.day, em, right, k)
    if q_in is None or q_in[1] <= 0:
        return None, "no_entry_quote"
    missing_exit = False
    if p.instrument == "single":
        debit = q_in[1]
        q_out = book.quote(t.day, xm, right, k)
        missing_exit = q_out is None
        credit = max(q_out[0], 0.0) if q_out else 0.0
        legs = 1
    else:
        k2 = k + p.width if right == "C" else k - p.width
        if k2 not in set(strikes):
            return None, "no_wing_strike"
        s_in = book.quote(t.day, em, right, k2)
        if s_in is None:
            return None, "no_entry_quote"
        debit = q_in[1] - s_in[0]
        if debit <= 0:
            return None, "nonpositive_debit"
        l_out = book.quote(t.day, xm, right, k)
        s_out = book.quote(t.day, xm, right, k2)
        missing_exit = l_out is None or s_out is None
        long_bid = max(l_out[0], 0.0) if l_out else 0.0
        short_ask = s_out[1] if s_out else _intrinsic(right, k2, u_exit) + 0.05
        credit = long_bid - short_ask
        legs = 2
    n = math.floor(p.premium_cap * equity / (debit * 100.0))
    if n < 1:
        return None, "too_expensive_for_cap"
    gross = n * 100.0 * (credit - debit)
    cost = 2 * legs * n * p.commission_per_contract
    tag = f"{t.exit_reason}:{right}{k:g}" + (":exit_quote_missing" if missing_exit else "")
    return Trade(t.day, t.side, n, t.entry_minute, debit, xm, credit, tag, gross, cost), "ok"


def run_options(stock: BacktestResult, prices: dict[tuple[date, int], float], close_minutes: dict[date, int],
                book: QuoteBook, days: Sequence[date], p: OptionParams = OptionParams()) -> tuple[BacktestResult, dict]:
    """Option equity curve over `days` (sessions with a 0DTE expiry and quotes). Days without a priced trade
    return 0. Sizing uses equity at the start of each day.

    prices[(day, minute)]: raw open of the stock bar that starts at that minute (no slippage).
    close_minutes[day]: 390 on a full day, 210 on a 13:00 half-day."""
    by_day: dict[date, list[Trade]] = {}
    for t in stock.trades:
        by_day.setdefault(t.day, []).append(t)
    day_set = set(days)
    res = BacktestResult(Params(aum0=p.aum0))
    aum = p.aum0
    counts: dict[str, int] = {"outside_option_days": sum(len(v) for d, v in by_day.items() if d not in day_set),
                              "exit_quote_missing": 0}
    for d in days:
        start = aum
        priced: list[Trade] = []
        close = close_minutes[d]  # required: a missing half-day would otherwise exit after its close
        for t in by_day.get(d, []):
            u_in = prices.get((d, t.entry_minute))
            xm = min(t.exit_minute, last_exit_minute(close))
            u_out = prices.get((d, xm), u_in)
            if u_in is None:
                counts["no_underlying_price"] = counts.get("no_underlying_price", 0) + 1
                continue
            ot, why = price_trade(book, t, u_in, u_out, start, p, close)
            if ot is None:
                counts[why] = counts.get(why, 0) + 1
                continue
            counts["exit_quote_missing"] += ot.exit_reason.endswith(":exit_quote_missing")
            priced.append(ot)
        pnl = sum(x.net for x in priced)
        res.days.append(DayResult(d, start, start + pnl, 0.0, bool(priced)))
        res.trades.extend(priced)
        aum = start + pnl
    return res, counts
