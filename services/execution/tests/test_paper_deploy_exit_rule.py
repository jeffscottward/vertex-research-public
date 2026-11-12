"""Session calendar and owner exit rule of the paper path. Offline: no clock, no network."""
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
import unittest

from vertex_execution.paper_deploy import calendar
from vertex_execution.paper_deploy.calendar import NEW_YORK, NYSE, NyseCalendar
from vertex_execution.paper_deploy.exit_rule import (
    REASON_LOSER,
    REASON_ROLL,
    REASON_WINNER,
    HeldSpread,
    SpreadMark,
    decide_exit,
    exit_time,
    expiry_session_of,
    loser_cut_day,
)

D = Decimal


def days_of(year):
    day = date(year, 1, 1)
    while day.year == year:
        yield day
        day += timedelta(days=1)


def at(year, month, day, hour, minute, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=NEW_YORK)


def held(expiry, entered_on=date(2026, 1, 2), right="call", long="100", short="105", entry_cost="300", quantity=1):
    return HeldSpread("position-1", "SPY", right, expiry, D(long), D(short), quantity, D(entry_cost), entered_on)


def mark(now, spot=None, close_value=None, age=timedelta(minutes=1)):
    return SpreadMark(now - age, None if spot is None else D(spot), None if close_value is None else D(close_value))


def decide(position, now, the_mark=None, *, roll_due=False, checked=None):
    return decide_exit(position, now, the_mark, roll_due=roll_due, loser_checked_on=checked)


class NyseCalendarTests(unittest.TestCase):
    def test_full_closures_2024_to_2027(self):
        expected = {
            2024: "01-01 01-15 02-19 03-29 05-27 06-19 07-04 09-02 11-28 12-25",
            2025: "01-01 01-09 01-20 02-17 04-18 05-26 06-19 07-04 09-01 11-27 12-25",
            2026: "01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25",
            2027: "01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24",
        }
        for year, days in expected.items():
            with self.subTest(year=year):
                closed = [d.strftime("%m-%d") for d in days_of(year) if d.weekday() < 5 and not calendar.is_session(d)]
                self.assertEqual(" ".join(closed), days)

    def test_session_counts(self):
        for year, count in ((2024, 252), (2025, 250), (2026, 251), (2027, 251)):
            with self.subTest(year=year):
                self.assertEqual(sum(calendar.is_session(d) for d in days_of(year)), count)

    def test_pinned_closures_and_observed_rules(self):
        closed = (
            date(2026, 4, 3),  # Good Friday
            date(2026, 7, 3),  # July 4 on a Saturday: the Friday is closed
            date(2027, 7, 5),  # July 4 on a Sunday: the Monday is closed
            date(2025, 1, 9),  # special closure
            date(2022, 6, 20),  # first Juneteenth, on a Sunday
            date(2027, 6, 18),  # Juneteenth on a Saturday
            date(2027, 12, 24),  # Christmas on a Saturday
            date(2023, 1, 2),  # New Year's Day on a Sunday
            date(2026, 11, 14),  # a Saturday
        )
        for day in closed:
            with self.subTest(closed=day):
                self.assertFalse(calendar.is_session(day))
        open_days = (
            date(2021, 6, 18),  # before Juneteenth was a holiday
            date(2021, 12, 31),  # New Year's Day 2022 on a Saturday is not observed
            date(2027, 12, 31),
            date(2026, 7, 2),
            date(2026, 4, 2),
        )
        for day in open_days:
            with self.subTest(open=day):
                self.assertTrue(calendar.is_session(day))

    def test_early_closes_2024_to_2027(self):
        expected = {2024: "07-03 11-29 12-24", 2025: "07-03 11-28 12-24", 2026: "11-27 12-24", 2027: "11-26"}
        for year, days in expected.items():
            with self.subTest(year=year):
                early = [d.strftime("%m-%d") for d in days_of(year) if calendar.is_early_close(d)]
                self.assertEqual(" ".join(early), days)

    def test_close_time(self):
        for day in (date(2026, 11, 27), date(2026, 12, 24), date(2025, 7, 3)):
            self.assertEqual(calendar.close_time(day), time(13, 0))
        # The day before an observed July 4 and the day before an observed Christmas are full days.
        for day in (date(2026, 7, 2), date(2027, 12, 23), date(2026, 11, 25), date(2026, 11, 12)):
            self.assertEqual(calendar.close_time(day), time(16, 0))
        self.assertFalse(calendar.is_early_close(date(2026, 7, 3)))
        with self.assertRaises(ValueError):
            calendar.close_time(date(2026, 7, 3))
        with self.assertRaises(ValueError):
            calendar.close_time(date(2026, 11, 14))

    def test_session_arithmetic(self):
        self.assertEqual(calendar.previous_session(date(2026, 11, 16)), date(2026, 11, 13))
        self.assertEqual(calendar.previous_session(date(2026, 4, 6)), date(2026, 4, 2))
        self.assertEqual(calendar.previous_session(date(2026, 11, 27)), date(2026, 11, 25))
        self.assertEqual(calendar.last_session_on_or_before(date(2025, 4, 18)), date(2025, 4, 17))
        self.assertEqual(calendar.last_session_on_or_before(date(2026, 11, 15)), date(2026, 11, 13))
        self.assertEqual(calendar.last_session_on_or_before(date(2026, 11, 12)), date(2026, 11, 12))
        self.assertEqual(calendar.sessions_before(date(2026, 11, 20), 1), date(2026, 11, 19))
        self.assertEqual(calendar.sessions_before(date(2026, 11, 20), 3), date(2026, 11, 17))
        self.assertEqual(calendar.sessions_before(date(2025, 4, 17), 3), date(2025, 4, 14))
        # A Saturday is not a session; the count still starts at the session before it.
        self.assertEqual(calendar.sessions_before(date(2026, 11, 21), 1), date(2026, 11, 20))
        self.assertEqual(NYSE.next_session(date(2026, 11, 25)), date(2026, 11, 27))
        for bad in (0, -1, 1.0, True):
            with self.subTest(n=bad), self.assertRaises(ValueError):
                calendar.sessions_before(date(2026, 11, 20), bad)

    def test_open_hours_and_time_zone(self):
        self.assertFalse(NYSE.is_open_at(at(2026, 11, 12, 9, 29, 59)))
        self.assertTrue(NYSE.is_open_at(at(2026, 11, 12, 9, 30)))
        self.assertTrue(NYSE.is_open_at(at(2026, 11, 12, 15, 59, 59)))
        self.assertFalse(NYSE.is_open_at(at(2026, 11, 12, 16, 0)))
        self.assertTrue(NYSE.is_open_at(at(2026, 11, 27, 12, 59)))
        self.assertFalse(NYSE.is_open_at(at(2026, 11, 27, 13, 0)))
        self.assertFalse(NYSE.is_open_at(at(2026, 11, 14, 11, 0)))
        # 20:59 UTC is 15:59 in winter and 16:59 in summer in New York.
        self.assertTrue(NYSE.is_open_at(datetime(2026, 11, 12, 20, 59, tzinfo=UTC)))
        self.assertFalse(NYSE.is_open_at(datetime(2026, 6, 15, 20, 59, tzinfo=UTC)))
        self.assertEqual(NYSE.session_close(date(2026, 6, 15)).utcoffset(), timedelta(hours=-4))
        self.assertEqual(NYSE.session_close(date(2026, 11, 12)).utcoffset(), timedelta(hours=-5))

    def test_inputs_fail_closed(self):
        with self.assertRaises(TypeError):
            calendar.is_session(datetime(2026, 11, 12, 10, 0))
        with self.assertRaises(TypeError):
            calendar.is_session("2026-11-12")
        with self.assertRaises(ValueError):
            calendar.is_session(date(1999, 12, 31))
        with self.assertRaises(ValueError):
            calendar.previous_session(date(2000, 1, 3))
        with self.assertRaises(TypeError):
            NYSE.is_open_at(datetime(2026, 11, 12, 10, 0))
        with self.assertRaises(TypeError):
            NyseCalendar(special_closures={date(2026, 11, 12)})

    def test_special_closure_table_can_be_extended(self):
        extended = NyseCalendar(special_closures=NYSE.special_closures | {date(2026, 11, 18)})
        self.assertFalse(extended.is_session(date(2026, 11, 18)))
        self.assertEqual(extended.sessions_before(date(2026, 11, 20), 3), date(2026, 11, 16))
        self.assertTrue(NYSE.is_session(date(2026, 11, 18)))


# Monthly expiry Friday 2026-11-20: cut day Tuesday 2026-11-17, no holiday in between.
EXPIRY = date(2026, 11, 20)
CUT = date(2026, 11, 17)


class ExitRuleBranchTests(unittest.TestCase):
    def setUp(self):
        self.position = held(EXPIRY)

    def test_helpers(self):
        self.assertEqual(expiry_session_of(self.position), EXPIRY)
        self.assertEqual(loser_cut_day(self.position), CUT)
        self.assertEqual(exit_time(CUT), at(2026, 11, 17, 15, 45))
        self.assertEqual(exit_time(date(2026, 11, 27)), at(2026, 11, 27, 12, 45))

    def test_hold_before_any_trigger(self):
        now = at(2026, 11, 12, 10, 0)
        decision = decide(self.position, now, mark(now, spot="90", close_value="50"))
        self.assertEqual((decision.action, decision.reason, decision.late, decision.error), ("hold", None, False, None))
        self.assertIsNone(decision.loser_checked_on)

    def test_loser_closes_on_the_cut_day_at_the_exit_time(self):
        for now in (at(2026, 11, 17, 15, 45), at(2026, 11, 17, 15, 59, 59)):
            with self.subTest(now=now):
                decision = decide(self.position, now, mark(now, spot="99", close_value="299.99"))
                self.assertEqual((decision.action, decision.reason, decision.late), ("close", REASON_LOSER, False))
                # A close is not stored as a finished check: an unfilled close is decided again.
                self.assertIsNone(decision.loser_checked_on)

    def test_evaluation_before_the_exit_time_holds_and_stores_nothing(self):
        now = at(2026, 11, 17, 15, 44, 59)
        decision = decide(self.position, now, mark(now, spot="99", close_value="10"))
        self.assertEqual((decision.action, decision.loser_checked_on), ("hold", None))

    def test_not_a_loser_is_recorded_and_never_cut_later(self):
        now = at(2026, 11, 17, 15, 45)
        for value in ("300", "450"):  # break-even is not a loss
            with self.subTest(close_value=value):
                decision = decide(self.position, now, mark(now, spot="104", close_value=value))
                self.assertEqual((decision.action, decision.loser_checked_on, decision.late), ("hold", CUT, False))
        for later in (at(2026, 11, 17, 15, 50), at(2026, 11, 18, 15, 45), at(2026, 11, 19, 15, 59)):
            with self.subTest(later=later):
                decision = decide(self.position, later, mark(later, spot="90", close_value="5"), checked=CUT)
                self.assertEqual((decision.action, decision.loser_checked_on, decision.late), ("hold", CUT, False))

    def test_missed_cut_day_is_checked_late_at_the_next_exit_time(self):
        early = at(2026, 11, 18, 10, 0)
        self.assertEqual(decide(self.position, early, mark(early, close_value="5")).action, "hold")
        self.assertIsNone(decide(self.position, early, mark(early, close_value="5")).loser_checked_on)
        for day in (18, 19):
            now = at(2026, 11, day, 15, 45)
            with self.subTest(day=day):
                loser = decide(self.position, now, mark(now, close_value="5"))
                self.assertEqual((loser.action, loser.reason, loser.late), ("close", REASON_LOSER, True))
                fine = decide(self.position, now, mark(now, close_value="400"))
                self.assertEqual((fine.action, fine.late, fine.loser_checked_on), ("hold", True, date(2026, 11, day)))
                self.assertIn("late", fine.detail)

    def test_after_hours_on_the_cut_day_is_not_the_exit_time(self):
        now = at(2026, 11, 17, 16, 30)
        decision = decide(self.position, now, mark(now, close_value="5"))
        self.assertEqual((decision.action, decision.loser_checked_on), ("hold", None))

    def test_loser_check_without_a_usable_mark_is_not_done(self):
        now = at(2026, 11, 17, 15, 45)
        cases = {
            "none": None,
            "no close value": mark(now, spot="99"),
            "stale": mark(now, close_value="5", age=timedelta(minutes=16)),
            "from the future": mark(now, close_value="5", age=timedelta(seconds=-1)),
        }
        for name, the_mark in cases.items():
            with self.subTest(mark=name):
                decision = decide(self.position, now, the_mark)
                self.assertEqual((decision.action, decision.loser_checked_on), ("hold", None))
                self.assertIn("not done", decision.detail)
        again = at(2026, 11, 17, 15, 50)
        self.assertEqual(decide(self.position, again, mark(again, close_value="5")).reason, REASON_LOSER)

    def test_position_entered_inside_the_window_gets_no_loser_check(self):
        for entered in (CUT, date(2026, 11, 18), date(2026, 11, 19)):
            position = held(EXPIRY, entered_on=entered)
            for now in (at(2026, 11, 17, 15, 45), at(2026, 11, 18, 15, 45), at(2026, 11, 19, 15, 45)):
                with self.subTest(entered=entered, now=now):
                    decision = decide(position, now, mark(now, close_value="5"))
                    self.assertEqual((decision.action, decision.loser_checked_on, decision.late), ("hold", None, False))
        before = held(EXPIRY, entered_on=date(2026, 11, 16))
        now = at(2026, 11, 17, 15, 45)
        self.assertEqual(decide(before, now, mark(now, close_value="5")).reason, REASON_LOSER)

    def test_expiry_day_closes_when_a_leg_is_in_the_money(self):
        now = at(2026, 11, 20, 15, 45)
        cases = (
            (held(EXPIRY, right="call", long="100", short="105"), "102"),  # long leg in the money
            (held(EXPIRY, right="call", long="100", short="105"), "110"),  # both
            (held(EXPIRY, right="call", long="100", short="105"), "100"),  # exactly at the money
            (held(EXPIRY, right="put", long="105", short="100"), "102"),
            (held(EXPIRY, right="put", long="100", short="105", entry_cost="-150"), "104"),  # short put in the money
            (held(EXPIRY, right="call", long="105", short="100", entry_cost="-150"), "102"),  # short call in the money
        )
        for position, spot in cases:
            with self.subTest(right=position.right, spot=spot):
                decision = decide(position, now, mark(now, spot=spot, close_value="150"))
                self.assertEqual((decision.action, decision.reason, decision.error), ("close", REASON_WINNER, None))

    def test_expiry_day_expires_when_both_legs_are_out_of_the_money(self):
        now = at(2026, 11, 20, 15, 45)
        cases = (
            (held(EXPIRY, right="call", long="100", short="105"), "99.99"),
            (held(EXPIRY, right="put", long="105", short="100"), "105.01"),
            (held(EXPIRY, right="put", long="100", short="105", entry_cost="-150"), "106"),
        )
        for position, spot in cases:
            with self.subTest(right=position.right, spot=spot):
                decision = decide(position, now, mark(now, spot=spot))
                self.assertEqual((decision.action, decision.reason, decision.error), ("expire", None, None))

    def test_expiry_day_without_a_fresh_spot_closes_fail_safe(self):
        now = at(2026, 11, 20, 15, 45)
        for name, the_mark in (
            ("none", None),
            ("no spot", mark(now, close_value="0")),
            ("stale", mark(now, spot="90", age=timedelta(minutes=16))),
        ):
            with self.subTest(mark=name):
                decision = decide(self.position, now, the_mark)
                self.assertEqual((decision.action, decision.reason), ("close", REASON_WINNER))
                self.assertIn("fail safe", decision.detail)

    def test_expiry_day_before_the_exit_time_holds(self):
        now = at(2026, 11, 20, 15, 44)
        self.assertEqual(decide(self.position, now, mark(now, spot="110")).action, "hold")

    def test_expiry_day_does_no_loser_check(self):
        now = at(2026, 11, 20, 15, 45)
        decision = decide(self.position, now, mark(now, spot="90", close_value="0"))
        self.assertEqual((decision.action, decision.late, decision.loser_checked_on), ("expire", False, None))

    def test_monthly_roll_closes_at_any_time_in_a_session(self):
        for now in (at(2026, 11, 12, 9, 30), at(2026, 11, 12, 12, 0), at(2026, 11, 20, 11, 0), at(2026, 11, 19, 15, 50)):
            with self.subTest(now=now):
                decision = decide(self.position, now, None, roll_due=True, checked=CUT)
                self.assertEqual((decision.action, decision.reason), ("close", REASON_ROLL))

    def test_monthly_roll_waits_for_an_open_session(self):
        for now in (at(2026, 11, 12, 8, 0), at(2026, 11, 12, 16, 30), at(2026, 11, 14, 11, 0), at(2026, 11, 26, 11, 0)):
            with self.subTest(now=now):
                position = held(date(2026, 12, 18))
                decision = decide(position, now, None, roll_due=True)
                self.assertEqual((decision.action, decision.reason), ("hold", None))
                self.assertIn("monthly roll is due", decision.detail)

    def test_precedence_loser_cut_wins_over_roll(self):
        now = at(2026, 11, 17, 15, 45)
        loser = decide(self.position, now, mark(now, close_value="5"), roll_due=True)
        self.assertEqual(loser.reason, REASON_LOSER)
        # Not a loser: the check is stored and the roll closes the position.
        fine = decide(self.position, now, mark(now, close_value="400"), roll_due=True)
        self.assertEqual((fine.action, fine.reason, fine.loser_checked_on), ("close", REASON_ROLL, CUT))

    def test_precedence_expiry_day_rule_wins_over_roll(self):
        now = at(2026, 11, 20, 15, 45)
        winner = decide(self.position, now, mark(now, spot="110"), roll_due=True)
        self.assertEqual((winner.action, winner.reason), ("close", REASON_WINNER))
        worthless = decide(self.position, now, mark(now, spot="90"), roll_due=True)
        self.assertEqual((worthless.action, worthless.reason), ("expire", None))
        # Before the exit time of the expiry day only the roll can fire.
        before = at(2026, 11, 20, 15, 44)
        self.assertEqual(decide(self.position, before, mark(before, spot="110"), roll_due=True).reason, REASON_ROLL)

    def test_past_expiry_fails_closed(self):
        for now in (at(2026, 11, 20, 16, 0), at(2026, 11, 20, 18, 0), at(2026, 11, 21, 10, 0), at(2026, 11, 23, 15, 45)):
            for roll_due in (False, True):
                with self.subTest(now=now, roll_due=roll_due):
                    decision = decide(self.position, now, mark(now, spot="110", close_value="5"), roll_due=roll_due, checked=CUT)
                    self.assertEqual((decision.action, decision.error, decision.reason), ("expired", "past_expiry", None))
                    self.assertEqual(decision.loser_checked_on, CUT)
                    self.assertIn("manual check", decision.detail)

    def test_clock_is_read_in_new_york_time(self):
        winter = datetime(2026, 11, 17, 20, 45, tzinfo=UTC)  # 15:45 EST
        self.assertEqual(decide(self.position, winter, mark(winter, close_value="5")).reason, REASON_LOSER)
        one_hour_early = datetime(2026, 11, 17, 19, 45, tzinfo=UTC)
        self.assertEqual(decide(self.position, one_hour_early, mark(one_hour_early, close_value="5")).action, "hold")
        summer_position = held(date(2026, 6, 26), entered_on=date(2026, 5, 1))
        summer = datetime(2026, 6, 23, 19, 45, tzinfo=UTC)  # 15:45 EDT
        self.assertEqual(decide(summer_position, summer, mark(summer, close_value="5")).reason, REASON_LOSER)

    def test_inputs_fail_closed(self):
        now = at(2026, 11, 12, 10, 0)
        with self.assertRaises(TypeError):
            decide(self.position, datetime(2026, 11, 12, 10, 0))
        with self.assertRaises(TypeError):
            decide_exit(self.position, now, None, roll_due=1, loser_checked_on=None)
        with self.assertRaises(TypeError):
            decide_exit(self.position, now, None, roll_due=False, loser_checked_on="2026-11-17")
        with self.assertRaises(TypeError):
            decide_exit(self.position, now, {"spot": 1}, roll_due=False, loser_checked_on=None)
        with self.assertRaises(ValueError):
            held(EXPIRY, long="100", short="100")
        with self.assertRaises(ValueError):
            held(EXPIRY, quantity=0)
        with self.assertRaises(ValueError):
            SpreadMark(datetime(2026, 11, 12, 10, 0), D("100"))

    def test_decision_to_json(self):
        now = at(2026, 11, 17, 15, 45)
        decision = decide(self.position, now, mark(now, close_value="400"))
        self.assertEqual(
            {key: value for key, value in decision.to_json().items() if key != "detail"},
            {"action": "hold", "reason": None, "loserCheckedOn": "2026-11-17", "late": False, "error": None},
        )


class ExitRuleDateEdgeTests(unittest.TestCase):
    def test_good_friday_is_the_third_friday(self):
        # 2025-04-18 is Good Friday: last trading day Thursday 04-17, cut day Monday 04-14.
        position = held(date(2025, 4, 18), entered_on=date(2025, 3, 3))
        self.assertEqual(expiry_session_of(position), date(2025, 4, 17))
        self.assertEqual(loser_cut_day(position), date(2025, 4, 14))
        now = at(2025, 4, 14, 15, 45)
        cut = decide(position, now, mark(now, close_value="5"))
        self.assertEqual((cut.reason, cut.late), (REASON_LOSER, False))
        # Tuesday is the day that 3 calendar days before the expiry gives: here it is one day late.
        tuesday = at(2025, 4, 15, 15, 45)
        self.assertEqual(decide(position, tuesday, mark(tuesday, close_value="5")).late, True)
        thursday = at(2025, 4, 17, 15, 45)
        self.assertEqual(decide(position, thursday, mark(thursday, spot="110")).reason, REASON_WINNER)
        self.assertEqual(decide(position, at(2025, 4, 17, 16, 0), None).error, "past_expiry")
        self.assertEqual(decide(position, at(2025, 4, 18, 10, 0), None).error, "past_expiry")

    def test_juneteenth_is_the_third_friday(self):
        position = held(date(2026, 6, 19), entered_on=date(2026, 5, 1))
        self.assertEqual(expiry_session_of(position), date(2026, 6, 18))
        self.assertEqual(loser_cut_day(position), date(2026, 6, 15))
        now = at(2026, 6, 15, 15, 45)
        self.assertEqual(decide(position, now, mark(now, close_value="5")).reason, REASON_LOSER)

    def test_monday_holiday_inside_the_window(self):
        # Expiry Wednesday 2026-01-21; Monday 01-19 is a holiday: sessions back are 01-20, 01-16, 01-15.
        position = held(date(2026, 1, 21), entered_on=date(2026, 1, 2))
        self.assertEqual(loser_cut_day(position), date(2026, 1, 15))
        friday = at(2026, 1, 16, 15, 45)
        self.assertEqual(decide(position, friday, mark(friday, close_value="5")).late, True)
        thursday = at(2026, 1, 15, 15, 45)
        self.assertEqual(decide(position, thursday, mark(thursday, close_value="5")).late, False)
        # Nothing fires on the holiday itself.
        holiday = at(2026, 1, 19, 15, 45)
        self.assertEqual(decide(position, holiday, mark(holiday, close_value="5"), roll_due=True).action, "hold")

    def test_holiday_between_cut_day_and_half_day_expiry(self):
        # Expiry Friday 2026-11-27 (13:00 close); Thanksgiving is the Thursday: cut day Monday 11-23.
        position = held(date(2026, 11, 27), entered_on=date(2026, 10, 1))
        self.assertEqual(loser_cut_day(position), date(2026, 11, 23))
        before = at(2026, 11, 27, 12, 44)
        self.assertEqual(decide(position, before, mark(before, spot="110")).action, "hold")
        now = at(2026, 11, 27, 12, 45)
        self.assertEqual(decide(position, now, mark(now, spot="110")).reason, REASON_WINNER)
        self.assertEqual(decide(position, now, mark(now, spot="90")).action, "expire")
        for late in (at(2026, 11, 27, 13, 0), at(2026, 11, 27, 15, 45)):
            self.assertEqual(decide(position, late, mark(late, spot="110")).error, "past_expiry")

    def test_cut_day_on_a_half_day(self):
        # Expiry Wednesday 2026-12-30: sessions back are 12-29, 12-28, 12-24 (13:00 close; 12-25 closed).
        position = held(date(2026, 12, 30), entered_on=date(2026, 11, 2))
        self.assertEqual(loser_cut_day(position), date(2026, 12, 24))
        before = at(2026, 12, 24, 12, 44)
        self.assertEqual(decide(position, before, mark(before, close_value="5")).action, "hold")
        now = at(2026, 12, 24, 12, 45)
        self.assertEqual(decide(position, now, mark(now, close_value="5")).reason, REASON_LOSER)
        # 15:45 on the half day is after the close: no check, and the next session checks late.
        closed = at(2026, 12, 24, 15, 45)
        self.assertEqual(decide(position, closed, mark(closed, close_value="5")).action, "hold")
        monday = at(2026, 12, 28, 15, 45)
        late = decide(position, monday, mark(monday, close_value="5"))
        self.assertEqual((late.reason, late.late), (REASON_LOSER, True))

    def test_half_day_before_independence_day_as_expiry(self):
        position = held(date(2025, 7, 3), entered_on=date(2025, 6, 2))
        self.assertEqual(loser_cut_day(position), date(2025, 6, 30))
        now = at(2025, 7, 3, 12, 45)
        self.assertEqual(decide(position, now, mark(now, spot="101")).reason, REASON_WINNER)

    def test_expiry_on_a_saturday_uses_the_friday(self):
        position = held(date(2026, 11, 21), entered_on=date(2026, 10, 1))
        self.assertEqual(expiry_session_of(position), date(2026, 11, 20))
        self.assertEqual(loser_cut_day(position), date(2026, 11, 17))


if __name__ == "__main__":
    unittest.main()
