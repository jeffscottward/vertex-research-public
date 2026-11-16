"""Frozen rules of the order flow / AMT auction study (research only).

Two Auction Market Theory rules on the prior regular session's value area (profile.py), on 5-minute
regular-session bars. Bar k of a session starts at 09:30 + 5k minutes New York and closes 5 minutes later.
- Rule A, failed auction: the session traded beyond the prior VAL (VAH), then FAILED_CLOSES or more closes are back
  inside value, every close after that side's most recent probe bar inside. Long (short) toward the prior POC; stop
  one cent beyond the session extreme. The later probe wins; one bar probing both sides goes long.
- Rule C, acceptance: at least ACCEPT_CLOSES closes of the session beyond the prior VAH (VAL), the last close beyond
  it and the developing session POC beyond it. Long (short); target one value-area width beyond the edge; stop one
  cent back inside value.
A signal is the close of bar 0 (09:35) to bar 65 (15:00); the first signal of the session per rule is taken. No
signal on a half day, after a half day, when the prior loaded session is not the previous NYSE trading day, without
ATR14, or on an ex-dividend day. Stop and target are distances from the signal close, applied from the entry fill at
the next bar's open (the NautilusTrader engine's rule). Exits: stop first (at the open when it gaps through), then
the target on touch (at the open when it gaps through), else the close of bar 74 (15:45, owner exit rule for options
on expiry day). The spec (docs/specs/strategies/order-flow-amt-auction.md, above "## Results") is frozen by
SPEC_SHA256.
"""
from __future__ import annotations

import hashlib
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from strategies.imom.data import is_closed
from strategies.noise_band import Bar, Session

from .profile import Levels, bin_price, poc_index, prior_levels, volume_profile

SPEC = Path(__file__).resolve().parents[4] / "docs" / "specs" / "strategies" / "order-flow-amt-auction.md"
# SHA-256 of the spec above "## Results", fixed when the rule was frozen (the runner refuses a different spec).
SPEC_SHA256 = "1b3f4610ab8bcac6c5e55cbe960b9fd888e88b588a1d2c51c24da834cdd98be7"
RESULTS_HEADING = "## Results"

BAR_MINUTES = 5
FULL_BARS = 78
ENTRY_FIRST = 0  # bar closing 09:35
ENTRY_LAST = 65  # bar closing 15:00
TIME_EXIT = 74  # bar closing 15:45
FAILED_CLOSES = 2
ACCEPT_CLOSES = 6
STOP_BUFFER = 0.01
PRICE_DECIMALS = 9  # NautilusTrader engine price precision
RULES = ("A", "C")


def spec_sha256(path: Path = SPEC) -> str:
    """SHA-256 of the frozen part of the spec (everything above the "## Results" heading)."""
    frozen = path.read_text().split(f"\n{RESULTS_HEADING}\n", 1)[0]
    return hashlib.sha256(frozen.encode()).hexdigest()


@dataclass(frozen=True)
class Signal:
    rule: str
    side: int
    bar: int
    close: float
    stop_distance: float
    target_distance: float
    reason: str


@dataclass(frozen=True)
class Trade:
    symbol: str
    day: str
    rule: str
    side: int
    signal_bar: int
    entry_bar: int
    exit_bar: int
    entry_price: float
    exit_price: float
    stop: float
    target: float
    stop_distance: float
    target_distance: float
    exit_reason: str


def tradable(session: Session) -> bool:
    return session.tradable and len(session.bars) == FULL_BARS


def previous_trading_day(day: date) -> date:
    """The NYSE trading day before `day` (weekends, NYSE holidays and special closures skipped)."""
    probe = day - timedelta(days=1)
    while is_closed(probe):
        probe -= timedelta(days=1)
    return probe


def _signal(rule: str, side: int, bar: Bar, k: int, stop: float, target: float, reason: str) -> Signal | None:
    stop_distance = round(side * (bar.close - stop), 6)
    target_distance = round(side * (target - bar.close), 6)
    if stop_distance <= 0 or target_distance <= 0:
        return None
    return Signal(rule, side, k, bar.close, stop_distance, target_distance, reason)


def failed_auction(bars: Sequence[Bar], levels: Levels) -> Signal | None:
    """First rule A signal of a session."""
    last_below = last_above = -1
    low = high = None
    for k, bar in enumerate(bars[:ENTRY_LAST + 1]):
        low = bar.low if low is None else min(low, bar.low)
        high = bar.high if high is None else max(high, bar.high)
        if bar.low < levels.val:
            last_below = k
        if bar.high > levels.vah:
            last_above = k
        candidates = []
        for side, probe in ((1, last_below), (-1, last_above)):
            if probe < 0 or k - probe < FAILED_CLOSES:
                continue
            if all(levels.val <= b.close <= levels.vah for b in bars[probe + 1:k + 1]):
                candidates.append((probe, side))
        if not candidates:
            continue
        probe, side = max(candidates)  # the later probe wins (live AMT job rule)
        if side > 0:
            stop, target = low - STOP_BUFFER, levels.poc
            reason = f"failed auction below VAL {levels.val:.2f}: {k - probe} closes back inside"
        else:
            stop, target = high + STOP_BUFFER, levels.poc
            reason = f"failed auction above VAH {levels.vah:.2f}: {k - probe} closes back inside"
        found = _signal("A", side, bar, k, stop, target, reason)
        if found is not None:
            return found
    return None


def acceptance(bars: Sequence[Bar], levels: Levels) -> Signal | None:
    """First rule C signal of a session."""
    above = below = 0
    width = levels.vah - levels.val
    for k, bar in enumerate(bars[:ENTRY_LAST + 1]):
        above += bar.close > levels.vah
        below += bar.close < levels.val
        if not (bar.close > levels.vah and above >= ACCEPT_CLOSES) and not (bar.close < levels.val
                                                                           and below >= ACCEPT_CLOSES):
            continue
        poc = poc_index(volume_profile(bars[:k + 1], levels.bin))
        developing = None if poc is None else bin_price(poc, levels.bin, "mid")
        if developing is None:
            continue
        if bar.close > levels.vah and developing > levels.vah:
            found = _signal("C", 1, bar, k, levels.vah - STOP_BUFFER, levels.vah + width,
                            f"accepted above VAH {levels.vah:.2f}: {above} closes, developing POC {developing:.2f}")
        elif bar.close < levels.val and developing < levels.val:
            found = _signal("C", -1, bar, k, levels.val + STOP_BUFFER, levels.val - width,
                            f"accepted below VAL {levels.val:.2f}: {below} closes, developing POC {developing:.2f}")
        else:
            continue
        if found is not None:
            return found
    return None


DETECT = {"A": failed_auction, "C": acceptance}


def _px(value: float) -> float:
    return round(value, PRICE_DECIMALS)


def simulate(symbol: str, day: str, bars: Sequence[Bar], signal: Signal) -> Trade:
    """Fill at the next bar's open; stop first, then target, else the close of bar TIME_EXIT. Prices are rounded
    to the engine's precision before they are compared."""
    side, entry_bar = signal.side, signal.bar + 1
    entry = _px(bars[entry_bar].open)
    stop = _px(entry - side * signal.stop_distance)
    target = _px(entry + side * signal.target_distance)

    def trade(exit_bar: int, price: float, reason: str) -> Trade:
        return Trade(symbol, day, signal.rule, side, signal.bar, entry_bar, exit_bar, entry, price, stop, target,
                     signal.stop_distance, signal.target_distance, reason)

    for b in range(entry_bar, TIME_EXIT + 1):
        bar = bars[b]
        opening = _px(bar.open)
        worst, best = (_px(bar.low), _px(bar.high)) if side > 0 else (_px(bar.high), _px(bar.low))
        if side * (worst - stop) <= 0:
            return trade(b, opening if side * (opening - stop) <= 0 else stop, "stop")
        if side * (best - target) >= 0:
            return trade(b, opening if side * (opening - target) >= 0 else target, "target")
    return trade(TIME_EXIT, _px(bars[TIME_EXIT].close), "time")


def session_signals(sessions: Sequence[Session], index: int,
                    ex_dates: Collection[str] = frozenset()) -> dict[str, Signal]:
    """Rule -> first signal of sessions[index] (prior levels from sessions[index - 1]). No signal when this or the
    prior session is a half day, the prior loaded session is not the previous NYSE trading day, the ATR14 of the
    session is missing, or this session is an ex-dividend day."""
    if index < 1 or not tradable(sessions[index]) or not tradable(sessions[index - 1]):
        return {}
    if sessions[index - 1].day != previous_trading_day(sessions[index].day):
        return {}
    if sessions[index].day.isoformat() in ex_dates:
        return {}
    session = sessions[index]
    levels = prior_levels(sessions, index)
    if levels is None:
        return {}
    out = {}
    for rule in RULES:
        found = DETECT[rule](session.bars, levels)
        if found is not None:
            out[rule] = found
    return out


def trades(symbol: str, sessions: Sequence[Session], first_day: str | None = None,
           ex_dates: Collection[str] = frozenset()) -> dict[str, list[Trade]]:
    """Rule -> trades over the sessions (from `first_day` on, when given)."""
    out: dict[str, list[Trade]] = {rule: [] for rule in RULES}
    for index in range(1, len(sessions)):
        day = sessions[index].day.isoformat()
        if first_day is not None and day < first_day:
            continue
        for rule, found in session_signals(sessions, index, ex_dates).items():
            out[rule].append(simulate(symbol, day, sessions[index].bars, found))
    return out


def signal_arrays(trade: Trade | None, side: int) -> tuple[list[int], list[float], list[float], list[int]]:
    """Entry flags, stop and target distances and market-on-close flags of one session for the engine."""
    signals, stops, targets, close_at = [0] * FULL_BARS, [0.0] * FULL_BARS, [0.0] * FULL_BARS, [0] * FULL_BARS
    close_at[TIME_EXIT] = 1
    if trade is not None and trade.side == side:
        signals[trade.signal_bar] = 1
        stops[trade.signal_bar] = trade.stop_distance
        targets[trade.signal_bar] = trade.target_distance
    return signals, stops, targets, close_at
