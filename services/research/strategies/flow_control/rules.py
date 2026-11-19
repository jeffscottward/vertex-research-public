"""Frozen study rule of the options-side continuation study (research only).

Trend in place on the group's primary ticker and the options net drift state of the group on the same side:
enter between 09:45 and 11:30 New York at the end of a minute, fill at the next minute's price, exit when the
state is lost, at the hard stop or at 15:55. Bar `b` of a session is the minute opening at
ms_at(day, OPEN_MINUTE_OF_DAY + b); `price[b]` is the vendor's stockPrice of that bucket. The spec
(docs/specs/strategies/flow-control-continuation.md, above "## Results") is frozen by SPEC_SHA256.
"""
from __future__ import annotations

import dataclasses
import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .control import NO_DATA, RULES, ControlRules, DriftMinute, fold_control_state, group_options_state
from .fomc import is_fomc_day

SPEC = Path(__file__).resolve().parents[4] / "docs" / "specs" / "strategies" / "flow-control-continuation.md"
# SHA-256 of the spec above "## Results", fixed when the rule was frozen (the runner refuses a different spec).
SPEC_SHA256 = "6ab915d19717ac61495556556d37eccb1baf1262a41cd540f6fc64929e66d4d1"
RESULTS_HEADING = "## Results"

# Minutes after 09:30 New York.
ENTRY_FIRST = 15  # 09:45
ENTRY_LAST = 120  # 11:30
ENTRY_LAST_LATE = 360  # 15:30
TIME_EXIT = 385  # 15:55
BARS = 386
TREND_LOOKBACK = 30
HARD_STOP_PCT = 0.40
OPEN_MINUTE_OF_DAY = 570


def spec_sha256(path: Path = SPEC) -> str:
    """SHA-256 of the frozen part of the spec (everything above the "## Results" heading)."""
    text = path.read_text()
    frozen = text.split(f"\n{RESULTS_HEADING}\n", 1)[0]
    return hashlib.sha256(frozen.encode()).hexdigest()


@dataclass(frozen=True)
class Params:
    window_minutes: int = 30
    entry_last: int = ENTRY_LAST
    skip_fomc: bool = True


@dataclass(frozen=True)
class Session:
    day: str
    price: tuple[float, ...]
    trend_price: tuple[float, ...]
    primary: tuple[DriftMinute, ...]
    check: tuple[DriftMinute, ...]


@dataclass(frozen=True)
class Trade:
    day: str
    side: int
    entry_bar: int
    exit_bar: int
    entry_price: float
    exit_price: float
    exit_reason: str
    points: float


def trend(price: Sequence[float], minute: int) -> int:
    """+1 above both the 09:30 price and the price TREND_LOOKBACK minutes earlier; -1 below both; else 0."""
    now, start, earlier = price[minute], price[0], price[max(0, minute - TREND_LOOKBACK)]
    if now > start and now > earlier:
        return 1
    if now < start and now < earlier:
        return -1
    return 0


def _states(steps, n: int) -> list[str]:
    out = [step.state for step in steps[:n]]
    return out + [NO_DATA] * (n - len(out))


def group_states(session: Session, rules: ControlRules) -> list[str]:
    """BARS group states; a minute after a ticker's last step counts as no_data for that ticker."""
    primary = _states(fold_control_state(session.primary, rules), BARS)
    check = _states(fold_control_state(session.check, rules), BARS)
    return [group_options_state(p, c) for p, c in zip(primary, check)]


def _trade(session: Session, states: Sequence[str], params: Params) -> Trade | None:
    price, tp = session.price, session.trend_price
    for m in range(ENTRY_FIRST, params.entry_last + 1):
        if states[m] == "buyers" and trend(tp, m) == 1:
            side = 1
        elif states[m] == "sellers" and trend(tp, m) == -1:
            side = -1
        else:
            continue
        entry_bar = m + 1
        entry_price = price[entry_bar]
        for k in range(entry_bar, TIME_EXIT):
            if side * (price[k] / entry_price - 1) <= -HARD_STOP_PCT / 100:
                reason = "stop"
            elif states[k] != states[m]:
                reason = "state"
            else:
                continue
            exit_price = price[k + 1]
            return Trade(session.day, side, entry_bar, k + 1, entry_price, exit_price, reason,
                         side * (exit_price - entry_price))
        exit_price = price[TIME_EXIT]
        return Trade(session.day, side, entry_bar, TIME_EXIT, entry_price, exit_price, "time",
                     side * (exit_price - entry_price))
    return None


def session_trade(session: Session, params: Params) -> Trade | None:
    """The first trade of the session (Pseudocode B of the plan), or None."""
    rules = dataclasses.replace(RULES, window_minutes=params.window_minutes)
    return _trade(session, group_states(session, rules), params)


def trades(sessions: Sequence[Session], params: Params) -> list[Trade]:
    out = []
    for session in sessions:
        if params.skip_fomc and is_fomc_day(session.day):
            continue
        trade = session_trade(session, params)
        if trade is not None:
            out.append(trade)
    return out


def signal_arrays(session: Session, trade: Trade | None, side: int) -> tuple[list[int], list[int], list[int]]:
    """Entry, exit and close flags of one side for nautilus_backtest.engine (it fills at the next bar's open)."""
    signals, exits, close_at = [0] * BARS, [0] * BARS, [0] * BARS
    close_at[TIME_EXIT] = 1
    if trade is not None and trade.side == side:
        signals[trade.entry_bar - 1] = 1
        if trade.exit_reason != "time":
            exits[trade.exit_bar - 1] = 1
    return signals, exits, close_at
