"""Signals of the leveraged-ETF short-window study (research only; it never places orders).

A signal is a direction (+1 or -1) on the unleveraged ETF U of a pair and one entry time. The signals
are the same for every form of a pair: the forms change only the instrument.

- S1 `session-open-momentum`: the noise-band kernel (strategies.noise_band.run_futures_backtest, 5-minute
  bars, decisions on the bars that end on HH:00 and HH:30 from 10:00 to 15:30 New York, scale 1) on U's
  5-minute IBKR bars. The signal of a session is the FIRST entry of the kernel in that session: the first
  decision bar whose close is beyond the noise band and beyond the session VWAP; direction = side of the
  break. Entry = the close of that bar. At most one signal per session. The kernel's own stops and
  re-entries are not used. This kernel is used and not the ZAB one (run_backtest) because its entries do
  not depend on an account value; the first entry of a session is the same rule in both.
  A session after a missing NYSE session is a reference only (its previous close is two days old).
- S2 `volume-spike-breakout`: the rule of strategies.volspike.rules on the Dukascopy index of the pair
  (the futures proxy whose ETF twin is U), default parameters without the 15-point stop
  (strategies.volspike.definition.NO_STOP: a defined-risk form does not use the stop, and the stop is
  in NAS100 points). The signal is the entry of each trade of the rule
  (strategies.volspike.options.signals_of). Entry on U = the close of the first 5-minute bar of U that
  ends at or after the rule's entry time, on the same New York day: a signal before the open, or at
  09:30, enters at 09:35. A signal on a day without a U session gives no trade.
- Regime `calm`: the signal is kept only when, at the previous session's close, VIX <= maxVix and
  VIX / VIX3M <= maxTermRatio (qc_ports.ideas.GATES['volRegime']) and the signal agrees with U's
  200-day trend (long: close above the 200-day simple average; short: below). A missing value fails.
- Window: `24h` exits at the close of the next session after the entry session, `48h` at the close of
  the second session after it (sessions = U's daily bars).
- Overlap: a new signal of the same pair and direction while an earlier one is still in its window is
  skipped. This is decided on the signals, before pricing, so every form sees the same signals.

S1 is pure Python. S2 imports the volspike rule (numpy) inside `volume_spike_breakout`.
"""
from __future__ import annotations

import bisect
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from strategies import noise_band as nb
from strategies.imom import data as idata
from strategies.qc_ports.data import MAX_FILL_DAYS, align
from strategies.qc_ports.forms import sma
from strategies.qc_ports.ideas import GATES

__all__ = ["BAR_MS", "FIRST_ENTRY_MINUTE", "REGIMES", "S1", "S2", "SIGNALS", "WINDOWS", "Signal", "calm_days",
           "exit_day", "first_bar_ending_at", "in_regime", "sessions_of", "session_open_momentum", "source_market",
           "take", "volume_spike_breakout"]

S1 = "session-open-momentum"
S2 = "volume-spike-breakout"
SIGNALS = (S1, S2)
REGIMES = ("all", "calm")
# Sessions between the entry session and the exit session.
WINDOWS = {"24h": 1, "48h": 2}
BAR_MS = idata.BAR_MINUTES * idata.MINUTE_MS
# The earliest entry of a signal that comes before the open: the close of the first 5-minute bar.
FIRST_ENTRY_MINUTE = idata.OPEN_MINUTE + idata.BAR_MINUTES


@dataclass(frozen=True)
class Signal:
    """One entry: `side` +1 (long U) or -1 (short U), the New York session day, the entry time (UTC ms,
    the close time of a 5-minute bar of U) and U's price there (the close of that bar)."""

    signal: str
    underlying: str
    side: int
    day: str
    entry_ms: float
    price: float

    def __post_init__(self) -> None:
        if self.side not in (1, -1):
            raise ValueError("side must be +1 or -1")
        if not self.price > 0:
            raise ValueError("price must be above 0")


def sessions_of(bars: idata.SessionBars) -> tuple[list[nb.Session], list[tuple[float, ...]]]:
    """(noise-band sessions, the bar times of each session) from the 5-minute session bars of the
    intraday loader. A session that follows a missing NYSE session is marked not tradable."""
    by_day: dict[str, list[int]] = {}
    for index, (day, _) in enumerate(idata.local_times(bars.t)):
        by_day.setdefault(day, []).append(index)
    sessions: list[nb.Session] = []
    times: list[tuple[float, ...]] = []
    previous: date | None = None
    for day in sorted(by_day):
        rows = by_day[day]
        current = date.fromisoformat(day)
        local = idata.local_times([bars.t[i] for i in rows])
        session_bars = tuple(nb.Bar(minute - idata.OPEN_MINUTE, bars.o[i], bars.h[i], bars.l[i], bars.c[i], bars.v[i])
                             for i, (_, minute) in zip(rows, local))
        gap = previous is not None and any(
            not idata.is_closed(previous + timedelta(days=n)) for n in range(1, (current - previous).days))
        sessions.append(nb.Session(current, session_bars, tradable=not gap))
        times.append(tuple(bars.t[i] for i in rows))
        previous = current
    return sessions, times


def session_open_momentum(underlying: str, bars: idata.SessionBars,
                          params: nb.FuturesParams = nb.FuturesParams()) -> list[Signal]:
    """S1: the first entry of the noise-band kernel in each session of U."""
    sessions, times = sessions_of(bars)
    result = nb.run_futures_backtest(sessions, [1.0] * len(sessions), params)
    position = {session.day: index for index, session in enumerate(sessions)}
    out: list[Signal] = []
    seen: set[date] = set()
    for trade in result.trades:
        if trade.day in seen:
            continue
        seen.add(trade.day)
        index = position[trade.day]
        session = sessions[index]
        # The kernel fills at the open of the bar after the decision bar; the signal uses that decision bar.
        entered = next(k for k, bar in enumerate(session.bars) if bar.minute == trade.entry_minute)
        decision = session.bars[entered - 1]
        out.append(Signal(S1, underlying, trade.side, trade.day.isoformat(), times[index][entered - 1] + BAR_MS,
                          decision.close))
    return out


def source_market(underlying: str) -> str:
    """The Dukascopy index (futures proxy) whose ETF twin is `underlying` (the volspike market table)."""
    found = [key for key in idata.FUTURES_PROXIES if idata.BY_KEY[key].twin == underlying]
    if len(found) != 1:
        raise ValueError(f"No single Dukascopy index for {underlying}")
    return found[0]


def first_bar_ending_at(times: Sequence[float], closes: Sequence[float], at_ms: float) -> tuple[str, float, float] | None:
    """(New York day, close time, close) of the first 5-minute bar of U that ends at or after `at_ms`, when
    it is on the New York day of `at_ms`; else None (no U session that day, or the session is over)."""
    index = bisect.bisect_left(times, at_ms - BAR_MS)
    if index >= len(times):
        return None
    wanted = idata.local_times([at_ms])[0][0]
    day = idata.local_times([times[index]])[0][0]
    if day != wanted:
        return None
    return day, times[index] + BAR_MS, closes[index]


def volume_spike_breakout(underlying: str, minutes, bars: idata.SessionBars, start_ms: int, end_ms: int,
                          params=None) -> tuple[list[Signal], int]:
    """S2: (signals, rule entries without a U bar). `minutes` are the 1-minute bars of the Dukascopy index
    of the pair (volspike.rules.Minutes); entries of the rule inside [start_ms, end_ms). `params` default:
    the stated rule without its stop (NO_STOP)."""
    from strategies.volspike import options as vopt
    from strategies.volspike import rules
    from strategies.volspike.definition import NO_STOP

    trades = rules.run_rule(rules.frame(minutes), NO_STOP if params is None else params, start_ms, end_ms)
    out: list[Signal] = []
    dropped = 0
    for item in vopt.signals_of(trades):
        found = first_bar_ending_at(bars.t, bars.c, item.entry_ms)
        if found is None:
            dropped += 1
            continue
        day, close_ms, close = found
        out.append(Signal(S2, underlying, 1 if item.side == "long" else -1, day, close_ms, close))
    return out, dropped


def calm_days(dates: Sequence[str], closes: Sequence[float], vix: Mapping[str, float], vix3m: Mapping[str, float],
              gate: Mapping = GATES["volRegime"]) -> list[int]:
    """Per daily bar of U, the direction the `calm` regime allows AFTER that close: +1 (calm and above
    the trend), -1 (calm and below it) or 0 (not calm, or a value is missing)."""
    level = align(vix, dates, MAX_FILL_DAYS)
    longer = align(vix3m, dates, MAX_FILL_DAYS)
    trend = sma(closes, int(gate["trendLength"]))
    out = []
    for close, near, far, average in zip(closes, level, longer, trend):
        calm = (near is not None and far is not None and far > 0 and average is not None
                and near <= gate["maxVix"] and near / far <= gate["maxTermRatio"])
        out.append(0 if not calm or close == average else (1 if close > average else -1))
    return out


def in_regime(signals: Sequence[Signal], regime: str, dates: Sequence[str], allowed: Sequence[int]) -> list[Signal]:
    """The signals of a regime: `all` keeps every signal; `calm` keeps a signal whose direction equals
    `allowed` (calm_days) at the last daily bar of U before the signal day."""
    if regime == "all":
        return list(signals)
    if regime != "calm":
        raise ValueError(f"Unknown regime {regime}")
    out = []
    for item in signals:
        previous = bisect.bisect_left(dates, item.day) - 1
        if previous >= 0 and allowed[previous] == item.side:
            out.append(item)
    return out


def exit_day(day: str, window: str, dates: Sequence[str]) -> str | None:
    """The exit session of an entry on session `day`: the 1st (24h) or 2nd (48h) daily bar of U after it.
    None when `day` is not a daily bar or the data ends before the exit."""
    index = bisect.bisect_left(dates, day)
    if index >= len(dates) or dates[index] != day:
        return None
    index += WINDOWS[window]
    return dates[index] if index < len(dates) else None


def take(signals: Sequence[Signal], window: str, dates: Mapping[str, Sequence[str]]) -> tuple[list[Signal], dict[str, int]]:
    """(signals to trade, counts) in entry order. Left out: a signal without an exit session (`noExit`) and
    a signal of the same pair and direction as an earlier taken signal whose exit session is not before the
    signal day (`overlap`: that position is still open, it leaves at the close of its exit session)."""
    taken: list[Signal] = []
    counts = {"overlap": 0, "noExit": 0}
    open_until: dict[tuple[str, int], str] = {}
    for item in sorted(signals, key=lambda s: (s.entry_ms, s.underlying, s.side)):
        leaves = exit_day(item.day, window, dates[item.underlying])
        if leaves is None:
            counts["noExit"] += 1
            continue
        key = (item.underlying, item.side)
        if key in open_until and item.day <= open_until[key]:
            counts["overlap"] += 1
            continue
        open_until[key] = leaves
        taken.append(item)
    return taken, counts
