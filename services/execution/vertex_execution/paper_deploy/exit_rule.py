"""Owner exit rule for one held vertical spread (F4). Pure: no clock read, no I/O.

Port of the owner standing rule of 2026-11-03: a winner may run to expiry, a
loser closes 3 trading days before expiry, an open winner closes on expiry day.
The research version (services/research/strategies/qc_ports/allocation.py)
counts 3 calendar days and uses the daily close. This version counts sessions
of the exchange calendar and uses the clock.

Terms (all times are New York time):

- Expiry session: the last session on or before the expiry date. An expiry on a
  holiday trades its last day the session before.
- Exit time of a session: its close minus 15 minutes. 15:45, or 12:45 on an
  early-close day.
- "At the exit time" means from the exit time until the close of that session.
  After the close no order can trade, so nothing fires until the next session.
- Loser: the spread shows a loss after its closing cost, that is
  ``mark.close_value - held.entry_cost < 0``.

Rules, in the order ``decide_exit`` applies them at one evaluation:

1. PAST EXPIRY. At or after the close of the expiry session: action
   ``expired`` with error ``past_expiry``. Nothing can trade any more, so the
   caller must alert. A position that was handled on its expiry day is no longer
   evaluated and never comes here.
2. EXPIRY DAY. On the expiry session at the exit time: a leg in the money (or
   exactly at the money) at the mark's spot gives ``close`` with reason
   ``winner_expiry_day_1545_et``, because a long option must never exercise
   into shares. Both legs out of the money give ``expire`` (no order, no cost).
   No fresh spot gives ``close`` (fail safe) and the detail says so. The reason
   code keeps its name on an early-close day; the exit time is then 12:45.
3. LOSER CUT. On the session exactly 3 sessions before the expiry session, at
   the exit time, the position is checked once. A loser gives ``close`` with
   reason ``loser_3_trading_days_before_expiry``. A position that is not a loser
   is held and never cut later: the decision returns ``loser_checked_on`` = that
   day and the caller stores it. When no check is stored and that day has
   passed, the check runs at the first evaluation at the exit time of a later
   session before the expiry session, with ``late=True``. A position entered on
   or after the cut day gets no loser check (the research book skips it too).
4. MONTHLY ROLL. ``roll_due=True`` (the monthly decision of the sleeve ended
   this position) gives ``close`` with reason ``monthly_roll`` at any time the
   session is open.
5. Otherwise ``hold``.

Precedence: the expiry-day rule and the loser cut win over the monthly roll
when they fire at the same evaluation. On the expiry day at the exit time a
roll therefore ends as ``expire`` when both legs are out of the money. Before
the exit time of the expiry day only the roll can fire.

A ``close`` for a loser does not set ``loser_checked_on``. If the close order
does not fill, the next evaluation checks again: the same day (not late) or a
later session (late).

Marks: a mark older than ``max_mark_age`` or stamped after ``now`` counts as no
mark. The loser check without a fresh close value is not done and not stored.

Not covered: a leg that is out of the money at the exit time and in the money
at the close (the rule looks once at the mark it is given), and early
assignment of the short leg.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from .calendar import NEW_YORK, NYSE, NyseCalendar

EXIT_LEAD = timedelta(minutes=15)
LOSER_CUT_SESSIONS = 3
DEFAULT_MAX_MARK_AGE = timedelta(minutes=15)

REASON_LOSER = "loser_3_trading_days_before_expiry"
REASON_WINNER = "winner_expiry_day_1545_et"
REASON_ROLL = "monthly_roll"
EXIT_REASONS = (REASON_LOSER, REASON_WINNER, REASON_ROLL)
ERROR_PAST_EXPIRY = "past_expiry"

ExitAction = Literal["hold", "close", "expire", "expired"]


def _is_day(value: object) -> bool:
    return isinstance(value, date) and not isinstance(value, datetime)


def _is_amount(value: object) -> bool:
    return isinstance(value, Decimal) and value.is_finite()


@dataclass(frozen=True)
class HeldSpread:
    """One open vertical spread. Amounts are US dollars for the whole position.

    ``entry_cost``: what the entry cost, fees included. Positive for a debit
    spread. Negative for a credit spread (the credit received less the fees).
    ``entered_on``: the New York date of the entry fill.
    """

    position_id: str
    symbol: str
    right: Literal["call", "put"]
    expiry: date
    long_strike: Decimal
    short_strike: Decimal
    quantity: int
    entry_cost: Decimal
    entered_on: date

    def __post_init__(self) -> None:
        for name in ("position_id", "symbol"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"invalid {name}")
        if self.right not in ("call", "put"):
            raise ValueError("right must be call or put")
        if not _is_day(self.expiry) or not _is_day(self.entered_on):
            raise ValueError("expiry and entered_on must be dates")
        if self.entered_on > self.expiry:
            raise ValueError("entered_on is after the expiry")
        for name in ("long_strike", "short_strike"):
            value = getattr(self, name)
            if not _is_amount(value) or value <= 0:
                raise ValueError(f"{name} must be a positive Decimal")
        if self.long_strike == self.short_strike:
            raise ValueError("a vertical spread needs two different strikes")
        if type(self.quantity) is not int or self.quantity <= 0:
            raise ValueError("quantity must be a positive whole number of contracts")
        if not _is_amount(self.entry_cost):
            raise ValueError("entry_cost must be a finite Decimal")


@dataclass(frozen=True)
class SpreadMark:
    """What the market shows for one held spread at ``as_of``.

    ``spot``: price of the underlying. ``close_value``: US dollars the whole
    position returns when it is closed now, after the closing cost; negative
    when closing costs money (a credit spread). Either may be missing.
    """

    as_of: datetime
    spot: Decimal | None = None
    close_value: Decimal | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.as_of, datetime) or self.as_of.utcoffset() is None:
            raise ValueError("as_of must carry a time zone")
        if self.spot is not None and (not _is_amount(self.spot) or self.spot <= 0):
            raise ValueError("spot must be a positive Decimal")
        if self.close_value is not None and not _is_amount(self.close_value):
            raise ValueError("close_value must be a finite Decimal")


@dataclass(frozen=True)
class ExitDecision:
    """``loser_checked_on`` is the value the caller stores for the next evaluation."""

    action: ExitAction
    reason: str | None
    detail: str
    loser_checked_on: date | None
    late: bool = False
    error: str | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "action": self.action,
            "reason": self.reason,
            "detail": self.detail,
            "loserCheckedOn": None if self.loser_checked_on is None else self.loser_checked_on.isoformat(),
            "late": self.late,
            "error": self.error,
        }


def expiry_session_of(held: HeldSpread, calendar: NyseCalendar = NYSE) -> date:
    return calendar.last_session_on_or_before(held.expiry)


def loser_cut_day(held: HeldSpread, calendar: NyseCalendar = NYSE) -> date:
    return calendar.sessions_before(expiry_session_of(held, calendar), LOSER_CUT_SESSIONS)


def exit_time(day: date, calendar: NyseCalendar = NYSE) -> datetime:
    """The exit time of session ``day``: its close minus 15 minutes, New York time."""

    return calendar.session_close(day) - EXIT_LEAD


def _out_of_the_money(right: str, strike: Decimal, spot: Decimal) -> bool:
    return spot < strike if right == "call" else spot > strike


def _clock(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d %H:%M ET")


def decide_exit(
    held: HeldSpread,
    now: datetime,
    mark: SpreadMark | None,
    *,
    roll_due: bool,
    loser_checked_on: date | None,
    calendar: NyseCalendar = NYSE,
    max_mark_age: timedelta = DEFAULT_MAX_MARK_AGE,
) -> ExitDecision:
    """The exit decision for ``held`` at ``now``. See the module text for the rules."""

    if not isinstance(held, HeldSpread):
        raise TypeError("held must be a HeldSpread")
    if not isinstance(now, datetime) or now.utcoffset() is None:
        raise TypeError("now must be a datetime with a time zone")
    if mark is not None and not isinstance(mark, SpreadMark):
        raise TypeError("mark must be a SpreadMark or None")
    if type(roll_due) is not bool:
        raise TypeError("roll_due must be a bool")
    if loser_checked_on is not None and not _is_day(loser_checked_on):
        raise TypeError("loser_checked_on must be a date or None")
    if not isinstance(calendar, NyseCalendar):
        raise TypeError("calendar must be a NyseCalendar")

    local = now.astimezone(NEW_YORK)
    today = local.date()
    expiry_session = calendar.last_session_on_or_before(held.expiry)
    expiry_close = calendar.session_close(expiry_session)
    if local >= expiry_close:
        return ExitDecision(
            "expired",
            None,
            f"evaluated at {_clock(local)}, at or after the close of the expiry session "
            f"({_clock(expiry_close)}): nothing can trade, the position needs a manual check",
            loser_checked_on,
            error=ERROR_PAST_EXPIRY,
        )

    is_open = calendar.is_open_at(local)
    at_exit_time = is_open and local >= exit_time(today, calendar)
    fresh = mark if mark is not None and timedelta(0) <= local - mark.as_of <= max_mark_age else None

    if today == expiry_session and at_exit_time:
        spot = None if fresh is None else fresh.spot
        if spot is None:
            return ExitDecision(
                "close",
                REASON_WINNER,
                f"expiry day at {_clock(local)} without a fresh spot: closed without knowing "
                "whether a leg is in the money (fail safe)",
                loser_checked_on,
            )
        strikes = (held.long_strike, held.short_strike)
        if all(_out_of_the_money(held.right, strike, spot) for strike in strikes):
            return ExitDecision(
                "expire",
                None,
                f"expiry day at {_clock(local)}: both {held.right} legs ({held.long_strike}, "
                f"{held.short_strike}) are out of the money at spot {spot}; no order, no cost",
                loser_checked_on,
            )
        return ExitDecision(
            "close",
            REASON_WINNER,
            f"expiry day at {_clock(local)}: a {held.right} leg ({held.long_strike}, "
            f"{held.short_strike}) is in or at the money at spot {spot}; closed before the bell",
            loser_checked_on,
        )

    cut_day = calendar.sessions_before(expiry_session, LOSER_CUT_SESSIONS)
    checked = loser_checked_on
    late = False
    note = ""
    if at_exit_time and checked is None and held.entered_on < cut_day and cut_day <= today < expiry_session:
        late = today > cut_day
        when = f"{_clock(local)}" + (f" (late: the cut day was {cut_day.isoformat()})" if late else "")
        value = None if fresh is None else fresh.close_value
        if value is None:
            note = f"loser check at {when} not done: no fresh mark with a close value"
        elif value - held.entry_cost < 0:
            return ExitDecision(
                "close",
                REASON_LOSER,
                f"loser check at {when}: close value {value} minus entry cost {held.entry_cost} "
                f"= {value - held.entry_cost}",
                loser_checked_on,
                late=late,
            )
        else:
            checked = today
            note = (
                f"loser check at {when}: close value {value} minus entry cost {held.entry_cost} "
                f"= {value - held.entry_cost}, not a loser, no later cut"
            )

    if roll_due and is_open:
        detail = f"monthly roll at {_clock(local)}"
        return ExitDecision("close", REASON_ROLL, f"{detail}; {note}" if note else detail, checked, late=late)
    if roll_due:
        waiting = f"monthly roll is due; the session is not open at {_clock(local)}"
        note = f"{waiting}; {note}" if note else waiting
    return ExitDecision("hold", None, note or "no exit rule fires", checked, late=late)
