"""Test F: exits of the cash-secured put (income sleeve, not armed), on model prices (see options.py).

Today's design (market-watch-bot `market_watch/income/rules.py`): one put per monthly expiry, opened on the
session whose days to expiry are nearest 38 inside 30-45, at the strike whose model |delta| is nearest 0.25
inside 0.15-0.30, credit at least $0.10 per share; buy back at 50% of the credit (take profit); at a loss
(mid above the credit) close on the session 3 before the expiry session; else close on the expiry session
(intrinsic value). Opening sells at the model bid, closing buys at the model ask. Capital per trade = the
strike (cash-secured), earning the T-bill rate.

Variants compared with today's design on the same entries:
  * stop: also close when the mid reaches `stop_mult` x the credit (2 x = a loss of one credit);
  * roll: at the loss check, roll down and out instead of closing: buy back, sell the next monthly expiry at the
    lowest strike at or below the current one whose bid pays at least the buy-back ask (a net credit); with no
    such strike, hold to expiry (assignment, valued at intrinsic). At most MAX_ROLLS rolls.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from strategies.qc_ports.options import strike_step

from .options import Leg, Underlying, delta_at, expiration, monthly_expiries, strike_for_delta
from .portfolio import PathReturns

TARGET_DTE, DTE_MIN, DTE_MAX = 38, 30, 45
SHORT_DELTA = 0.25
DELTA_BAND = (0.15, 0.30)
TAKE_PROFIT = 0.50
LOSS_CLOSE_SESSIONS = 3
MIN_CREDIT = 0.10
MAX_ROLLS = 3


@dataclass
class Position:
    strike: float
    expiry: date
    expiry_i: int
    credit: float  # net credit received per share (bid at entry)


def entry_days(u: Underlying, lo: int, hi: int) -> list[tuple[int, date]]:
    """(session, expiry) pairs: for each monthly expiry, the session in lo..hi-1 nearest TARGET_DTE."""
    best: dict[date, tuple[int, int]] = {}
    for i in range(lo, hi):
        d = u.dates[i]
        for e in monthly_expiries(d, 2):
            dte = (e - d).days
            if DTE_MIN <= dte <= DTE_MAX:
                score = abs(dte - TARGET_DTE)
                if e not in best or score < best[e][1]:
                    best[e] = (i, score)
    return sorted((i, e) for e, (i, _) in best.items())


def put_quote(u: Underlying, strike: float, i: int, pos_exp: date, expiry_i: int) -> tuple[float, float] | None:
    return u.quote((Leg("put", strike, 1),), i, pos_exp, expiry_i=expiry_i)


def open_put(u: Underlying, i: int, expiry: date) -> Position | None:
    if expiry > u.dates[-1]:
        return None
    k = strike_for_delta(u, i, expiry, "put", -SHORT_DELTA)
    d = None if k is None else delta_at(u, i, expiry, "put", k)
    if k is None or d is None or not DELTA_BAND[0] <= abs(d) <= DELTA_BAND[1]:
        return None
    expiry_i = u.session_on_or_before(expiry)
    q = put_quote(u, k, i, expiry, expiry_i)
    if q is None:
        return None
    credit = q[0] - q[1]
    if credit < MIN_CREDIT:
        return None
    return Position(k, expiry, expiry_i, credit)


def _roll(u: Underlying, pos: Position, i: int, buyback_ask: float) -> Position | None:
    d = u.dates[i]
    y, mo = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    expiry = expiration(y, mo)
    if expiry <= pos.expiry:
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
        expiry = expiration(y, mo)
    if expiry > u.dates[-1]:
        return None
    expiry_i = u.session_on_or_before(expiry)
    step = strike_step(u.close[i])
    k = pos.strike
    best = None
    while k > 0.5 * pos.strike:
        q = put_quote(u, k, i, expiry, expiry_i)
        if q is None:
            return None
        if q[0] - q[1] >= buyback_ask:
            best = Position(k, expiry, expiry_i, q[0] - q[1])
            k -= step
            continue
        break
    return best


def simulate(u: Underlying, start: Position, entry_i: int, rf: Sequence[float], *, stop_mult: float | None = None,
             roll: bool = False, loss_sessions: int = LOSS_CLOSE_SESSIONS) -> tuple[list[float], list[int]]:
    """Daily value per unit of capital (the first strike) from entry_i+1 to the end of the position, and the
    index in that list of each rule event (stop or roll)."""
    pos = start
    cash = pos.strike + pos.credit          # per share
    capital = start.strike
    values: list[float] = []
    events: list[int] = []
    rolls = 0
    assigned = False                        # a roll found no credit: hold to expiry
    last_mid = pos.credit
    i = entry_i
    while i + 1 < len(u.close):
        i += 1
        cash *= 1 + rf[i]
        q = put_quote(u, pos.strike, i, pos.expiry, pos.expiry_i)
        if q is None:  # no model volatility that day: hold and mark at the last mid
            values.append((cash - last_mid) / capital)
            continue
        mid, cost = q
        last_mid = mid
        ask = mid + cost if mid > 0 else 0.0
        done = False
        if i >= pos.expiry_i:
            cash -= mid if assigned else ask   # assignment settles at intrinsic, a buy-back pays the ask
            done = True
        elif assigned:
            pass
        elif mid <= pos.credit * (1 - TAKE_PROFIT):
            cash -= ask
            done = True
        elif stop_mult is not None and mid >= stop_mult * pos.credit:
            cash -= ask
            done = True
            events.append(len(values))
        elif i >= pos.expiry_i - loss_sessions and mid > pos.credit:
            if roll and rolls < MAX_ROLLS:
                new = _roll(u, pos, i, ask)
                if new is None:
                    assigned = True  # no credit roll: no trade, so no rule event
                else:
                    events.append(len(values))
                    cash += new.credit - ask
                    pos = new
                    rolls += 1
                    q = put_quote(u, pos.strike, i, pos.expiry, pos.expiry_i)
                    mid = q[0] if q else mid
                    last_mid = mid
            else:
                cash -= ask
                done = True
        values.append((cash - (0.0 if done else mid)) / capital)
        if done:
            break
    return values, events


def pair(values_rule: list[float], values_base: list[float], rf: Sequence[float], entry_i: int, start: int,
         events: list[int]) -> PathReturns:
    """Both legs over the longer of the two; the leg that ended first earns the T-bill rate."""
    n = max(len(values_rule), len(values_base))
    p = PathReturns(start=start, stop_events=len(events), days_to_stop=events[0] + 1 if events else None,
                    stop_offsets=list(events))

    def padded(v: list[float]) -> list[float]:
        out = list(v)
        while len(out) < n:
            k = entry_i + 1 + len(out)
            out.append(out[-1] * (1 + (rf[k] if k < len(rf) else 0.0)))
        return out
    w, o = padded(values_rule), padded(values_base)
    prev_w = prev_o = 1.0
    for j in range(n):
        out = 1.0 if j >= len(values_rule) and j < len(values_base) else 0.0
        p.add(w[j] - prev_w, o[j] - prev_o, out)
        prev_w, prev_o = w[j], o[j]
    return p
