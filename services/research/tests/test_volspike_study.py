"""Volume spike breakout study (docs/specs/strategies/volume-spike-breakout.md): pure-logic tests on tiny
synthetic bars. No network and no rig data file: every file is written to a temporary folder.

CI (scripts/ci/research-python.sh): the base lane has no numpy and no pandas, so this file skips there as a
whole; the Nautilus lane (VERTEX_REQUIRE_NAUTILUS=1, requirements-nautilus-linux-py312.lock) runs every test
and a missing numpy, pandas or engine is an error, not a skip."""
from __future__ import annotations

import gzip
import importlib.util
import json
import math
import os
import tempfile
import unittest
from dataclasses import asdict, replace
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
    import numpy as np
    import pandas  # noqa: F401 - the data loader parses the bar files with pandas
else:
    np = pytest.importorskip("numpy", reason="the volume-spike study needs numpy (Nautilus lane)")
    pytest.importorskip("pandas", reason="the volume-spike study needs pandas (Nautilus lane)")

from strategies.qc_ports.data import Market  # noqa: E402 - after the optional-backend check
from strategies.volspike import data, definition, diagnostics, options, rules, runner, source, study  # noqa: E402
from strategies.volspike import metrics as mx  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
NEW_YORK = ZoneInfo("America/New_York")
MONDAY = "2024-03-04"
WEEK = (rules.ny_ms("2024-03-03"), rules.ny_ms("2024-03-09"))
# Small lookbacks so a few candles are enough: 4 candles of volume, 2 candles of range, no trend filter.
SMALL = rules.Params(vol_n=4, k=2, trend=False, skip_weekdays=(), stop=5.0, time_stop=6)


def _fetcher():
    path = REPO / "research" / "backtests" / "volspike" / "fetch_data.py"
    spec = importlib.util.spec_from_file_location("volspike_fetch_data", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _nautilus_installed() -> bool:
    from strategies.qc_ports import nautilus_runner

    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        nautilus_runner.require()
        return True
    try:
        nautilus_runner.require()
    except nautilus_runner.NautilusUnavailable:
        return False
    return True


class Tape:
    """Builds bars candle by candle (1-minute bars, or `step`-minute bars). A candle is 15 flat minutes at the
    previous close; its last bar closes at `close`; `high` / `low` print in the middle bar (minute 7, or the
    second 5-minute bar); `bars` overrides single bars by position. A spike candle has 4 x the mean volume of
    the 4 candles before it unless a volume is given."""

    def __init__(self, day: str = MONDAY, minute: int = 7 * 60, price: float = 100.0, step: int = 1) -> None:
        self.t = rules.ny_ms(day, minute)
        self.price = price
        self.step = step
        self.rows: list[tuple] = []
        self.volumes: list[float] = []

    def candle(self, close: float | None = None, volume: float = 15.0, high: float | None = None,
               low: float | None = None, bars: dict[int, tuple] | None = None) -> Tape:
        start = self.price
        close = start if close is None else close
        count = 15 // self.step
        for i in range(count):
            o = h = low_ = c = start
            if i == count - 1:
                c, h, low_ = close, max(start, close), min(start, close)
            if i == count // 2:
                h = max(h, high) if high is not None else h
                low_ = min(low_, low) if low is not None else low_
            if bars and i in bars:
                o, h, low_, c = bars[i]
            self.rows.append((self.t, o, h, low_, c, volume / count))
            self.t += self.step * rules.MINUTE_MS
        self.price = self.rows[-1][4]
        self.volumes.append(volume)
        return self

    def loud(self) -> float:
        return 4 * sum(self.volumes[-4:]) / 4

    def flat(self, count: int, volume: float = 15.0) -> Tape:
        for _ in range(count):
            self.candle(volume=volume)
        return self

    def spike_up(self, by: float = 1.0, volume: float | None = None) -> Tape:
        return self.candle(close=self.price + by, volume=self.loud() if volume is None else volume)

    def spike_down(self, by: float = 1.0, volume: float | None = None) -> Tape:
        return self.candle(close=self.price - by, volume=self.loud() if volume is None else volume)

    def minutes(self) -> rules.Minutes:
        cols = list(zip(*self.rows))
        return rules.Minutes(np.array(cols[0], dtype=np.int64), *(np.array(c, dtype=np.float64) for c in cols[1:]))


def trades_of(tape: Tape, params: rules.Params = SMALL, costs: rules.Costs = rules.Costs(),
              window: tuple[int, int] = WEEK) -> list[rules.Trade]:
    return rules.run_rule(rules.frame(tape.minutes()), params, *window, costs)


def morning(step: int = 1) -> Tape:
    """Monday 07:00 to 08:30 flat, then a long signal on the 08:30 candle (entry 08:45 at 101)."""
    return Tape(step=step).flat(6).spike_up()


class ClockTest(unittest.TestCase):
    def test_new_york_offset_matches_the_time_zone_database(self) -> None:
        rng = np.random.default_rng(1)
        stamps = rng.integers(rules.ny_ms("2017-01-01"), rules.ny_ms("2027-01-01"), size=4000)
        edges = [edge + shift for year in range(2017, 2027) for edge in rules.dst_bounds(year) for shift in (-1, 0, 1)]
        stamps = np.concatenate((stamps, np.array(edges, dtype=np.int64)))
        expected = [int(datetime.fromtimestamp(t / 1000, UTC).astimezone(NEW_YORK).utcoffset().total_seconds() * 1000)
                    for t in stamps]
        self.assertEqual(rules.ny_offset_ms(stamps).tolist(), expected)

    def test_new_york_ms_and_session_day(self) -> None:
        for day, minute in (("2024-01-15", 510), ("2024-07-15", 510), ("2024-03-10", 180), ("2024-11-03", 60)):
            local = datetime.fromtimestamp(rules.ny_ms(day, minute) / 1000, UTC).astimezone(NEW_YORK)
            self.assertEqual((local.date().isoformat(), local.hour * 60 + local.minute), (day, minute))
        sunday_evening = rules.ny_ms("2024-03-03", 18 * 60)
        monday_afternoon = rules.ny_ms("2024-03-04", 16 * 60 + 59)
        monday_evening = rules.ny_ms("2024-03-04", 17 * 60)
        days = rules.session_day(np.array([sunday_evening, monday_afternoon, monday_evening]))
        self.assertEqual([rules.day_text(d) for d in days], ["2024-03-04", "2024-03-04", "2024-03-05"])


class CandleTest(unittest.TestCase):
    def test_fifteen_minute_candles_on_the_new_york_clock(self) -> None:
        for day in ("2024-01-15", "2024-07-15"):  # both DST regimes
            tape = Tape(day, 8 * 60 + 20)
            for _ in range(2):
                tape.candle(close=tape.price + 1, volume=30.0, high=tape.price + 3, low=tape.price - 2)
            cd = rules.build_candles(tape.minutes(), 15)
            # 30 minutes from 08:20: candles 08:15 (10 bars), 08:30 (15 bars), 08:45 (5 bars).
            self.assertEqual(cd.open_minute.tolist(), [495, 510, 525])
            self.assertEqual((cd.last - cd.first + 1).tolist(), [10, 15, 5])
            self.assertEqual(cd.start.tolist(), [rules.ny_ms(day, m) for m in (495, 510, 525)])
            self.assertEqual([rules.day_text(d) for d in cd.day], [day] * 3)
            self.assertEqual(cd.weekday.tolist(), [0, 0, 0])
            self.assertAlmostEqual(float(cd.v.sum()), 60.0)
            self.assertEqual((cd.o[0], cd.h[0], cd.l[0], cd.c[0]), (100.0, 103.0, 98.0, 100.0))
            self.assertEqual(cd.c[1], 101.0)

    def test_four_hour_candles_start_at_midnight_new_york(self) -> None:
        tape = Tape("2024-07-15", 3 * 60 + 30).flat(40)  # 03:30 to 13:30
        slow = rules.build_candles(tape.minutes(), 240)
        self.assertEqual(slow.open_minute.tolist(), [0, 240, 480, 720])

    def test_a_candle_without_bars_does_not_exist(self) -> None:
        m = Tape().flat(3).minutes()
        keep = np.r_[0:15, 30:45]  # the 07:15 candle has no bars
        gap = rules.Minutes(*(col[keep] for col in (m.t, m.o, m.h, m.l, m.c, m.v)))
        self.assertEqual(rules.build_candles(gap, 15).open_minute.tolist(), [420, 450])


class SignalTest(unittest.TestCase):
    def test_volume_test_uses_the_candles_before(self) -> None:
        volume = np.array([10.0, 10.0, 10.0, 10.0, 30.0, 29.99, 61.0, 10.0])
        self.assertEqual(rules.mean_before(volume, 4)[4:].tolist(), [10.0, 15.0, 19.9975, 32.7475])
        self.assertTrue(np.isnan(rules.mean_before(volume, 4)[:4]).all())
        # Exactly 3 x the mean passes; just under does not; the first vol_n candles never pass.
        self.assertEqual(rules.volume_spike(volume, 3.0, 4).tolist(),
                         [False, False, False, False, True, False, True, False])

    def test_breakout_is_strict_and_looks_only_back(self) -> None:
        high = np.array([10.0, 11.0, 10.5, 10.0, 12.0])
        low = np.array([9.0, 9.5, 9.8, 9.0, 9.9])
        self.assertEqual(rules.extreme_before(high, 2, True)[2:].tolist(), [11.0, 11.0, 10.5])
        self.assertEqual(rules.extreme_before(low, 2, False)[2:].tolist(), [9.0, 9.5, 9.0])
        cd = rules.Candles(15, *(np.zeros(5, dtype=np.int64) for _ in range(4)), high, high, low,
                           np.array([0.0, 0.0, 11.0, 11.01, 8.99]), np.ones(5))
        up, down = rules.breakout(cd, 2)
        self.assertEqual(up.tolist(), [False, False, False, True, False])  # 11.0 is not above 11.0
        self.assertEqual(down.tolist(), [False, False, False, False, True])

    def test_long_and_short_signals(self) -> None:
        cd = rules.build_candles(Tape().flat(6).spike_up().flat(3).spike_down(3.0).minutes(), 15)
        long, short = rules.raw_signals(cd, SMALL)
        self.assertEqual(np.flatnonzero(long).tolist(), [6])
        self.assertEqual(np.flatnonzero(short).tolist(), [10])
        # No volume spike, no signal.
        quiet = rules.build_candles(Tape().flat(6).spike_up(volume=44.0).minutes(), 15)
        self.assertFalse(rules.raw_signals(quiet, SMALL)[0].any())

    def test_session_on_the_candle_close_and_on_the_candle_open(self) -> None:
        cd = rules.build_candles(Tape(MONDAY, 8 * 60).flat(18).minutes(), 15)  # opens 08:00 ... 12:15
        opens = cd.open_minute
        on_close = opens[rules.session_mask(cd, rules.Params())]
        self.assertEqual((int(on_close[0]), int(on_close[-1])), (8 * 60 + 15, 11 * 60 + 45))  # closes 08:30, 12:00
        on_open = opens[rules.session_mask(cd, rules.Params(session_on="open"))]
        self.assertEqual((int(on_open[0]), int(on_open[-1])), (8 * 60 + 30, 11 * 60 + 45))
        wide = opens[rules.session_mask(cd, rules.Params(session_to=16 * 60))]
        self.assertEqual(int(wide[-1]), 12 * 60 + 15)

    def test_trend_reads_the_last_closed_four_hour_candle(self) -> None:
        # Sunday 20:00 to Monday 12:15, rising to 08:00 and falling after: the 04:00 candle closes above its EMA.
        tape = Tape("2024-03-03", 20 * 60)
        for _ in range(48):
            tape.candle(close=tape.price + 0.1)
        for _ in range(17):
            tape.candle(close=tape.price - 0.5)
        fr = rules.frame(tape.minutes())
        trend = rules.trend_of(fr.cd, fr.slow, 2)
        by_open = dict(zip(fr.cd.open_minute.tolist()[-33:], trend.tolist()[-33:]))
        self.assertEqual(by_open[7 * 60 + 45], 1)  # closes 08:00: the 04:00 to 08:00 candle just closed, above
        self.assertEqual(by_open[11 * 60 + 30], 1)  # closes 11:45: still the 04:00 candle
        self.assertEqual(by_open[11 * 60 + 45], -1)  # closes 12:00: the 08:00 to 12:00 candle closed, below
        self.assertEqual(int(trend[0]), 0)  # no closed 4-hour candle yet
        ema = rules.ema(np.array([1.0, 3.0, 5.0]), 2)
        self.assertTrue(math.isnan(ema[0]))
        self.assertEqual(ema[1:].tolist(), [2.0, 4.0])


class RuleTest(unittest.TestCase):
    def test_entry_at_the_next_open_and_time_stop(self) -> None:
        trades = trades_of(morning().flat(8))
        self.assertEqual(len(trades), 1)
        t = trades[0]
        self.assertEqual((t.side, t.entry, t.reason), (rules.LONG, 101.0, "time"))
        self.assertEqual(t.entry_ms, rules.ny_ms(MONDAY, 8 * 60 + 45))
        self.assertEqual(t.exit_ms, t.entry_ms + 6 * 15 * rules.MINUTE_MS)  # the open 6 candles after the entry
        self.assertEqual((t.exit, t.r_gross), (101.0, 0.0))
        longer = trades_of(morning().flat(8), replace(SMALL, time_stop=3))
        self.assertEqual(longer[0].exit_ms, longer[0].entry_ms + 3 * 15 * rules.MINUTE_MS)

    def test_stop_in_points_on_one_minute_bars(self) -> None:
        t = trades_of(morning().candle(low=95.9).flat(8))[0]
        self.assertEqual((t.reason, t.exit, t.r_gross), ("stop", 96.0, -1.0))
        self.assertEqual(t.exit_ms, t.entry_ms + 7 * rules.MINUTE_MS)  # the minute that printed the low
        # A low exactly on the stop is a touch; one tick above is not.
        self.assertEqual(trades_of(morning().candle(low=96.0).flat(8))[0].reason, "stop")
        self.assertEqual(trades_of(morning().candle(low=96.01).flat(8))[0].reason, "time")
        # The entry minute itself can stop the trade.
        same = trades_of(morning().candle(bars={0: (101.0, 101.0, 95.0, 100.0)}).flat(8))[0]
        self.assertEqual((same.exit_index, same.exit, same.reason), (same.entry_index, 96.0, "stop"))

    def test_a_bar_that_opens_beyond_the_stop_fills_at_its_open(self) -> None:
        t = trades_of(morning().flat(1).candle(bars={0: (94.0, 94.5, 93.5, 94.0)}).flat(8))[0]
        self.assertEqual((t.reason, t.exit), ("stop", 94.0))
        self.assertAlmostEqual(t.r_gross, -7 / 5)

    def test_percent_stop_and_short_stop(self) -> None:
        pct = replace(SMALL, stop_kind="pct", stop=0.02)
        t = trades_of(morning().candle(low=98.9).flat(8), pct)[0]
        self.assertAlmostEqual(t.stop, 2.02)
        self.assertAlmostEqual(t.exit, 98.98)
        self.assertAlmostEqual(t.r_gross, -1.0)
        short = trades_of(Tape().flat(6).spike_down().candle(high=104.1).flat(8))[0]
        self.assertEqual((short.side, short.entry, short.exit, short.reason), (rules.SHORT, 99.0, 104.0, "stop"))
        self.assertEqual(short.r_gross, -1.0)

    def test_stop_fills_before_another_exit(self) -> None:
        # The time stop is due at the open of the 7th candle; the minute before it touches the stop.
        before = trades_of(morning().flat(5).candle(bars={14: (101.0, 101.0, 95.0, 101.0)}).flat(4))[0]
        self.assertEqual((before.reason, before.exit), ("stop", 96.0))
        # The exit bar itself opens beyond the stop: recorded as a stop, at that open.
        gapped = trades_of(morning().flat(6).candle(bars={0: (95.0, 95.0, 95.0, 95.0)}).flat(4))[0]
        self.assertEqual((gapped.reason, gapped.exit), ("stop", 95.0))
        self.assertEqual(gapped.exit_ms, gapped.entry_ms + 6 * 15 * rules.MINUTE_MS)
        # The opposite signal's candle touches the stop on its way down: the stop is first.
        hit = trades_of(morning().flat(2).spike_down(7.0).flat(8))[0]
        self.assertEqual((hit.reason, hit.exit), ("stop", 96.0))

    def test_opposite_signal_exits_at_the_next_open_and_reverses(self) -> None:
        trades = trades_of(morning().flat(2).spike_down(1.5).flat(8))
        self.assertEqual([(t.side, t.reason) for t in trades], [(rules.LONG, "opposite"), (rules.SHORT, "time")])
        first, second = trades
        self.assertEqual((first.exit, second.entry), (99.5, 99.5))
        self.assertEqual(first.exit_ms, second.entry_ms)
        self.assertAlmostEqual(first.r_gross, -1.5 / 5)

    def test_opposite_signal_outside_the_session_exits_without_a_reverse_entry(self) -> None:
        tape = morning().flat(1)  # entry 08:45; one more candle to 09:15
        narrow = replace(SMALL, session_to=9 * 60, time_stop=40)
        trades = trades_of(tape.flat(2).spike_down(1.5).flat(8), narrow)  # the short signal closes at 10:00
        self.assertEqual([(t.side, t.reason) for t in trades], [(rules.LONG, "opposite")])
        # Long only: the short signal still closes the long, and no short opens.
        only = trades_of(morning().flat(2).spike_down(1.5).flat(8), replace(SMALL, sides=("long",)))
        self.assertEqual([(t.side, t.reason) for t in only], [(rules.LONG, "opposite")])

    def test_one_position_at_a_time(self) -> None:
        trades = trades_of(morning().flat(2).spike_up().flat(8))
        self.assertEqual(len(trades), 1)  # the second long signal is ignored
        self.assertEqual(trades[0].reason, "time")
        # A signal on the last candle before the time stop is ignored too: the position is still open.
        late = trades_of(morning().flat(5).spike_up().flat(8))
        self.assertEqual(len(late), 1)

    def test_at_most_two_entries_per_new_york_day(self) -> None:
        tape = Tape().flat(6)
        for _ in range(3):  # three long signals (08:30, 09:45, 11:00), each stopped in its entry candle
            tape.spike_up()
            tape.candle(low=tape.price - 5.5).flat(3)
        tape.flat(4)
        self.assertEqual([t.reason for t in trades_of(tape)], ["stop", "stop"])
        self.assertEqual(len(trades_of(tape, replace(SMALL, max_entries=1))), 1)
        self.assertEqual(len(trades_of(tape, replace(SMALL, max_entries=None))), 3)

    def test_time_stop_counts_candles_not_wall_minutes(self) -> None:
        tape = morning().flat(2)  # entry candle 08:45, then 09:00
        tape.t += 15 * rules.MINUTE_MS  # the 09:15 candle has no bar
        t = trades_of(tape.flat(8))[0]
        # 6 existing candles after the entry candle: 09:00, 09:30, 09:45, 10:00, 10:15, 10:30 (105 minutes later).
        self.assertEqual((t.reason, t.exit_ms), ("time", t.entry_ms + 7 * 15 * rules.MINUTE_MS))
        self.assertNotEqual(t.exit_ms, t.entry_ms + 6 * 15 * rules.MINUTE_MS)

    def test_entry_limit_uses_the_new_york_day_not_the_utc_day(self) -> None:
        evening = replace(SMALL, session_from=17 * 60, session_to=23 * 60)
        tape = Tape(MONDAY, 16 * 60 + 30).flat(6)  # 2024-03-04 is in winter time: UTC midnight is 19:00 New York
        for _ in range(3):  # signals close 18:15, 19:30, 20:45: one before and two after UTC midnight
            tape.spike_up()
            tape.candle(low=tape.price - 5.5).flat(3)
        tape.t = rules.ny_ms("2024-03-05", 16 * 60 + 30)
        tape.flat(6).spike_up()  # Tuesday 18:15 New York: still 2024-03-05 in UTC
        tape.candle(low=tape.price - 5.5).flat(3)
        trades = trades_of(tape, evening)
        days = [datetime.fromtimestamp(t.entry_ms / 1000, UTC).astimezone(NEW_YORK).date().isoformat() for t in trades]
        utc_days = [datetime.fromtimestamp(t.entry_ms / 1000, UTC).date().isoformat() for t in trades]
        # New York days: Monday takes 2 of its 3 signals, Tuesday takes its own. A UTC-day count would take all
        # 3 on Monday (1 + 2) and then refuse Tuesday's (UTC 2024-03-05 would be full).
        self.assertEqual(days, ["2024-03-04", "2024-03-04", "2024-03-05"])
        self.assertEqual(utc_days, ["2024-03-04", "2024-03-05", "2024-03-05"])
        self.assertEqual([t.entry_ms for t in trades][:2], [rules.ny_ms(MONDAY, 18 * 60 + 15), rules.ny_ms(MONDAY, 19 * 60 + 30)])

    def test_wednesday_skip_uses_the_new_york_date_of_the_entry(self) -> None:
        skip = replace(SMALL, skip_weekdays=(2,))
        wednesday = Tape("2024-03-06").flat(6).spike_up().flat(8)
        self.assertEqual(len(trades_of(wednesday, skip)), 0)
        self.assertEqual(len(trades_of(wednesday, SMALL)), 1)
        self.assertEqual(len(trades_of(morning().flat(8), skip)), 1)  # Monday
        # A Tuesday 23:45 signal enters at Wednesday 00:00: skipped. A Wednesday 23:45 signal enters on Thursday.
        night = replace(skip, session_from=23 * 60, session_to=24 * 60)
        tuesday = Tape("2024-03-05", 22 * 60).flat(7).spike_up().flat(8)
        self.assertEqual(len(trades_of(tuesday, night)), 0)
        late_wednesday = Tape("2024-03-06", 22 * 60).flat(7).spike_up().flat(8)
        self.assertEqual(len(trades_of(late_wednesday, night)), 1)

    def test_session_variants_decide_the_entry(self) -> None:
        early = Tape(MONDAY, 6 * 60 + 45).flat(6).spike_up().flat(8)  # the signal candle is 08:15 to 08:30
        self.assertEqual(len(trades_of(early)), 1)  # closes at 08:30: inside
        self.assertEqual(len(trades_of(early, replace(SMALL, session_on="open"))), 0)  # opens at 08:15: outside
        noon = Tape(MONDAY, 10 * 60 + 30).flat(6).spike_up().flat(8)  # the signal candle is 12:00 to 12:15
        self.assertEqual(len(trades_of(noon)), 0)
        self.assertEqual(len(trades_of(noon, replace(SMALL, session_to=16 * 60))), 1)

    def test_trend_filter_blocks_the_other_side(self) -> None:
        tape = Tape("2024-03-03", 20 * 60)
        for _ in range(50):  # rising to 08:30: the last closed 4-hour candle is above its EMA
            tape.candle(close=tape.price + 0.1)
        up = tape.price
        tape.spike_up().flat(8)
        with_trend = replace(SMALL, trend=True, trend_length=2)
        self.assertEqual([t.side for t in trades_of(tape, with_trend)], [rules.LONG])
        down = Tape("2024-03-03", 20 * 60)
        for _ in range(50):
            down.candle(close=down.price + 0.1)
        down.spike_down(2.0).flat(8)
        self.assertEqual(trades_of(down, with_trend), [])  # a short against the up trend
        self.assertEqual([t.side for t in trades_of(down, SMALL)], [rules.SHORT])
        self.assertGreater(up, 100.0)

    def test_trading_window_and_end_of_data(self) -> None:
        tape = morning().flat(2)  # the data ends while the trade is open
        t = trades_of(tape)[0]
        self.assertEqual((t.reason, t.exit_index), ("end", len(tape.rows) - 1))
        later = (rules.ny_ms(MONDAY, 9 * 60), WEEK[1])
        self.assertEqual(trades_of(morning().flat(8), window=later), [])  # the entry is before the window

    def test_no_stop_variant_keeps_the_opposite_signal_and_the_time_stop(self) -> None:
        free = replace(SMALL, stop_kind="none")
        t = trades_of(morning().candle(low=80.0).flat(8), free)[0]
        self.assertEqual(t.reason, "time")
        self.assertTrue(math.isnan(t.r_gross))
        flip = trades_of(morning().candle(low=80.0).flat(2).spike_down(2.0).flat(8), free)
        self.assertEqual([t.reason for t in flip], ["opposite", "time"])


class FiveMinuteBarsTest(unittest.TestCase):
    """The IBKR ETF path: 15-minute signal candles built from 5-minute bars, fills and stop on the 5-minute bars."""

    def test_signal_candles_are_built_from_three_five_minute_bars(self) -> None:
        m = morning(5).flat(2).minutes()
        self.assertEqual(len(m), 9 * 3)
        cd = rules.build_candles(m, 15)
        self.assertEqual((cd.last - cd.first + 1).tolist(), [3] * 9)
        self.assertEqual(cd.open_minute.tolist()[:2], [420, 435])
        self.assertAlmostEqual(float(cd.v[0]), 15.0)
        self.assertEqual((cd.c[6], cd.h[6], cd.l[6]), (101.0, 101.0, 100.0))
        long, _ = rules.raw_signals(cd, SMALL)
        self.assertEqual(np.flatnonzero(long).tolist(), [6])

    def test_entry_time_stop_and_stop_resolve_on_five_minute_bars(self) -> None:
        flat = trades_of(morning(5).flat(8))[0]
        self.assertEqual((flat.entry, flat.reason), (101.0, "time"))
        self.assertEqual(flat.entry_ms, rules.ny_ms(MONDAY, 8 * 60 + 45))  # the next 15-minute open
        self.assertEqual(flat.exit_ms, flat.entry_ms + 6 * 15 * rules.MINUTE_MS)
        stopped = trades_of(morning(5).candle(low=95.9).flat(8))[0]
        self.assertEqual((stopped.reason, stopped.exit, stopped.r_gross), ("stop", 96.0, -1.0))
        self.assertEqual(stopped.exit_ms, stopped.entry_ms + 5 * rules.MINUTE_MS)  # the 5-minute bar with the low
        same_bar = trades_of(morning(5).candle(bars={0: (101.0, 101.0, 95.0, 100.0)}).flat(8))[0]
        self.assertEqual((same_bar.exit_index, same_bar.exit), (same_bar.entry_index, 96.0))
        gap = trades_of(morning(5).flat(1).candle(bars={0: (94.0, 94.5, 93.5, 94.0)}).flat(8))[0]
        self.assertEqual((gap.reason, gap.exit), ("stop", 94.0))

    def test_stop_first_and_opposite_exit_on_five_minute_bars(self) -> None:
        # The last 5-minute bar before the time-stop open touches the stop: the stop fills first.
        before = trades_of(morning(5).flat(5).candle(bars={2: (101.0, 101.0, 95.0, 101.0)}).flat(4))[0]
        self.assertEqual((before.reason, before.exit), ("stop", 96.0))
        # A 5-minute bar holds no order of events: a bar that touches the stop is a stop, whatever its high.
        both = trades_of(morning(5).candle(bars={1: (101.0, 140.0, 95.5, 139.0)}).flat(8))[0]
        self.assertEqual((both.reason, both.exit), ("stop", 96.0))
        flip = trades_of(morning(5).flat(2).spike_down(1.5).flat(8))
        self.assertEqual([(t.side, t.reason) for t in flip], [(rules.LONG, "opposite"), (rules.SHORT, "time")])
        self.assertEqual(flip[0].exit_ms, flip[1].entry_ms)


class EtfStopFillTest(unittest.TestCase):
    """The stop-fill information row on 5-minute bars (the IBKR ETF path)."""

    def test_half_way_fill_uses_the_extreme_of_the_five_minute_bar(self) -> None:
        tape = morning(5).candle(low=95.5).flat(4).spike_up().flat(8)  # a stop at 96 in a bar with low 95.5; a time exit
        m = tape.minutes()
        trades = rules.run_rule(rules.frame(m), SMALL, *WEEK)
        self.assertEqual([t.reason for t in trades], ["stop", "time"])
        calendar = runner.calendar_of(m, *WEEK)
        costs = {"vertex": rules.Costs(per_unit=0.25), "source": rules.source_costs(SMALL)}
        raw = study.stop_fill_raw(m, calendar, trades, costs)
        self.assertEqual((raw["fraction"], raw["stops"]), (0.5, 1))
        self.assertAlmostEqual(raw["meanExtraLossPerStopR"], 0.25 / 5)  # 96 -> 95.75 on a 5-point stop
        self.assertAlmostEqual(raw["r"]["vertex"]["totalR"], -5.25 / 5 - 0.1 + 0.0 - 0.1)
        self.assertAlmostEqual(raw["r"]["source"]["meanR"], (-5.25 / 5 - 0.084 - 0.084) / 2)
        self.assertEqual(raw["dated"], [(MONDAY, -5.25 / 5 - 0.1), (MONDAY, -0.1)])
        self.assertEqual(raw["datedModel"][0], (MONDAY, -1.0 - 0.1))
        view = study.stop_fill_view(raw, 0.12, "5-minute")
        for key in ("fraction", "stops", "meanExtraLossPerStopR", "trades", "meanR", "meanRSourceCosts", "totalR",
                    "sharpe", "oosSharpe", "cagr", "maxDrawdown", "sameMethodModelSharpe", "nautilusModelSharpe",
                    "label", "bar", "r", "grossR"):
            self.assertIn(key, view)
        self.assertEqual((view["trades"], view["bar"], view["nautilusModelSharpe"]), (2, "5-minute", 0.12))
        self.assertAlmostEqual(view["meanR"], (-5.25 / 5 - 0.2) / 2)
        self.assertIn("5-minute bar", view["label"])
        self.assertIn("same-method", view["label"])
        self.assertNotIn("dated", view)
        self.assertNotIn("days", raw.keys() & view.keys())
        # No stop, nothing changes.
        calm = morning(5).flat(8).minutes()
        calm_trades = rules.run_rule(rules.frame(calm), SMALL, *WEEK)
        calm_raw = study.stop_fill_raw(calm, runner.calendar_of(calm, *WEEK), calm_trades, costs)
        self.assertEqual((calm_raw["stops"], calm_raw["meanExtraLossPerStopR"]), (0, 0.0))
        self.assertEqual(calm_raw["dated"], calm_raw["datedModel"])

    def test_etf_text_shows_exact_and_half_way_fills_and_never_cuts(self) -> None:
        def twin(name: str) -> dict:
            return {"market": name, "trades": 200, "meanR": 0.272, "sharpe": 0.28,
                    "stopFill": {"meanR": 0.101, "sharpe": 0.09}}

        text = study.etf_twins_text([twin("SPY"), twin("QQQ"), twin("IWM")], ["DIA", "GLD", "SLV", "USO"])
        self.assertIn("QQQ 200 trades +0.27R 0.28 / +0.10R 0.09", text)
        self.assertIn("exact stop fill / half-way to the bar extreme", text)
        self.assertIn("Not testable on this data (no exchange-volume intraday history): DIA, GLD, SLV, USO", text)
        self.assertLessEqual(len(text), 300)
        # More tested twins: the shorter wording, still every twin and both numbers.
        seven = study.etf_twins_text([twin(n) for n in ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")], [])
        self.assertLessEqual(len(seven), 300)
        self.assertEqual(seven.count(" / +0.10R 0.09"), 7)
        self.assertEqual(study.etf_twins_text([], ["SPY"]),
                         "no twin has IBKR history. Not testable on this data (no exchange-volume intraday history): SPY")
        with self.assertRaises(ValueError):
            study.etf_twins_text([twin("SPY"), twin("QQQ"), twin("IWM")], [], limit=60)


class CostTest(unittest.TestCase):
    def test_r_multiples_and_source_costs(self) -> None:
        costs = rules.source_costs(rules.Params())
        self.assertAlmostEqual(costs.per_unit, 0.63)  # 0.084 x 15 points / 2
        self.assertAlmostEqual(costs.round_trip(rules.LONG, 20_000.0, 20_100.0), 1.26)
        gross, net = rules.r_multiples(rules.LONG, 20_000.0, 20_150.0, 15.0, costs)
        self.assertAlmostEqual(gross, 10.0)
        self.assertAlmostEqual(net, 10.0 - 0.084)
        gross, net = rules.r_multiples(rules.SHORT, 20_000.0, 20_015.0, 15.0, costs)
        self.assertAlmostEqual(gross, -1.0)
        self.assertAlmostEqual(net, -1.084)
        pct = rules.source_costs(rules.Params(stop_kind="pct", stop=0.001))
        entry = 5_000.0
        self.assertAlmostEqual(rules.r_multiples(rules.LONG, entry, entry, 0.001 * entry, pct)[1], -0.084)
        # Exactly 0.084R of the stop distance at entry, wherever the exit is.
        for exit_ in (4_000.0, 5_005.0, 9_000.0):
            gross, net = rules.r_multiples(rules.SHORT, entry, exit_, 0.001 * entry, pct)
            self.assertAlmostEqual(gross - net, 0.084, places=12)
        self.assertAlmostEqual(pct.times(2).stop_fraction, 0.084)
        with self.assertRaises(ValueError):
            runner.profile_of(pct, False, "percent-stop source costs are rules.py arithmetic")
        self.assertTrue(math.isnan(rules.r_multiples(rules.LONG, 1.0, 2.0, math.nan, costs)[0]))

    def test_rate_costs_and_sale_fee(self) -> None:
        costs = rules.Costs(per_unit=0.005, rate=0.0002, sale_rate=0.0001)
        # Long: buy at 100 (no sale fee), sell at 110 (sale fee).
        self.assertAlmostEqual(costs.round_trip(rules.LONG, 100.0, 110.0), 0.005 + 0.02 + 0.005 + 0.022 + 0.011)
        # Short: sell at 100 (sale fee), buy at 110.
        self.assertAlmostEqual(costs.round_trip(rules.SHORT, 100.0, 110.0), 0.005 + 0.02 + 0.01 + 0.005 + 0.022)
        self.assertAlmostEqual(costs.times(2).rate, 0.0004)

    def test_reprice_changes_only_the_net_result(self) -> None:
        trades = trades_of(morning().candle(low=95.9).flat(8))
        again = rules.reprice(trades, rules.Costs(per_unit=0.25))
        self.assertEqual((again[0].r_gross, again[0].exit, again[0].exit_index),
                         (trades[0].r_gross, trades[0].exit, trades[0].exit_index))
        self.assertAlmostEqual(again[0].r_net, -1.0 - 0.5 / 5)
        self.assertEqual(trades[0].r_net, -1.0)

    def test_worse_stop_fills_change_only_the_stop_exits(self) -> None:
        tape = morning().candle(low=95.5).flat(4).spike_up().flat(8)  # a stop at 96 (bar low 95.5), then a time exit
        m = tape.minutes()
        trades = rules.run_rule(rules.frame(m), SMALL, *WEEK)
        self.assertEqual([t.reason for t in trades], ["stop", "time"])
        worse = rules.worse_stop_fills(m, trades, 0.5)
        self.assertAlmostEqual(worse[0].exit, 95.75)  # half-way from 96 to the low of 95.5
        self.assertAlmostEqual(worse[0].r_gross, -5.25 / 5)
        self.assertEqual((worse[0].exit_index, worse[0].entry), (trades[0].exit_index, trades[0].entry))
        self.assertEqual((worse[1].exit, worse[1].r_gross), (trades[1].exit, trades[1].r_gross))
        self.assertEqual([t.exit for t in rules.worse_stop_fills(m, trades, 0.0)], [t.exit for t in trades])
        short = Tape().flat(6).spike_down().candle(high=104.6).flat(8)
        sm = short.minutes()
        st = rules.run_rule(rules.frame(sm), SMALL, *WEEK)
        self.assertAlmostEqual(rules.worse_stop_fills(sm, st, 0.5)[0].exit, 104.3)  # from 104 to the high of 104.6
        self.assertAlmostEqual(rules.worse_stop_fills(sm, st, 0.5, rules.Costs(per_unit=0.5))[0].r_net, -5.3 / 5 - 0.2)

    def test_vertex_costs_and_profiles(self) -> None:
        cfd = runner.vertex_costs(2.0, False)
        self.assertAlmostEqual(cfd.rate, 1.25e-4)  # half of 2 bp + 0.25 bp
        self.assertEqual((cfd.per_unit, cfd.sale_rate), (0.0, 0.0))
        self.assertAlmostEqual(runner.vertex_costs(2.0, False, 2.0).rate, 2.5e-4)
        etf = runner.vertex_costs(1.0, True, 2.0)
        self.assertAlmostEqual(etf.rate, 1.5e-4)
        self.assertAlmostEqual(etf.per_unit, 0.005 + 0.000_003)  # not doubled
        self.assertAlmostEqual(etf.sale_rate, 0.000_020_6)
        profile = runner.profile_of(rules.source_costs(rules.Params()), False, "source")
        self.assertEqual((profile["spreadBps"], profile["slippage"]["bps"]), (0, 0))  # costs never move a price
        self.assertAlmostEqual(profile["commission"]["perShare"], 0.63)
        etf_profile = runner.profile_of(etf, True, "etf")
        self.assertEqual(etf_profile["commission"]["perShare"], 0.005)
        self.assertAlmostEqual(etf_profile["commission"]["percentOfValue"], 0.015)


class MetricsTest(unittest.TestCase):
    def test_r_statistics(self) -> None:
        r = mx.r_stats([-1.0, -1.0, 9.0, -1.0, -1.0, -1.0, 4.0])
        self.assertEqual((r["trades"], r["maxLosingStreak"]), (7, 3))
        self.assertAlmostEqual(r["winRate"], 2 / 7)
        self.assertAlmostEqual(r["rewardRisk"], 6.5)
        self.assertAlmostEqual(r["meanR"], 8 / 7)
        self.assertAlmostEqual(r["totalR"], 8.0)
        self.assertAlmostEqual(r["maxDrawdownR"], 3.0)

    def test_an_empty_window_gives_no_trades_not_an_error(self) -> None:
        empty = mx.r_stats([])
        self.assertEqual((empty["trades"], empty["meanR"], empty["totalR"]), (0, None, 0.0))
        points = [("2026-09-11", 1.2), ("2026-09-14", 1.2), ("2026-09-15", 1.2), ("2026-09-16", 1.2)]
        part = study.part_of(points, [], "2026-09-12", "2026-11-06")
        self.assertTrue(part["noTrades"])
        self.assertEqual((part["trades"], part["sharpe"], part["cagr"], part["maxDrawdown"]), (0, 0.0, 0.0, 0.0))
        self.assertEqual(study.part_of([], [], "2026-09-12", "2026-11-06")["days"], 0)
        row = study.run_row("NAS100 after", "no trades", {"points": points, "trades": [], "exposure": 0.0}, [],
                            "2026-09-12", "2026-11-06", with_oos=False)
        self.assertEqual((row["trades"], row["winRate"], row["profitFactor"], row["from"]), (0, 0.0, None, "2026-09-14"))
        self.assertIsNone(study.run_row("x", "y", {"points": points, "trades": []}, [], "2027-01-01", "2027-02-01"))
        self.assertEqual(mx.deflated(points, 10_000, [0.01, 0.02])["probability"], 0.0)
        self.assertEqual(study.weekly([], "2026-09-12", "2026-11-06"), [])
        self.assertEqual(study.breakdown([], "2026-09-12", "2026-11-06")["trades"], 0)

    def test_window_base_and_weekly_r(self) -> None:
        points = [("2024-01-01", 1.0), ("2024-01-02", 1.1), ("2024-01-03", 1.2), ("2024-01-04", 1.3)]
        self.assertEqual(mx.window_base(points, "2024-01-03", "2024-01-04"), points[1:])
        self.assertEqual(mx.window_base(points, "2023-12-01", "2024-01-02"), points[:2])
        weeks = mx.weekly_r([("2024-03-04", 1.0), ("2024-03-06", -1.0), ("2024-03-12", 2.5)])
        self.assertEqual(weeks, [["2024-03-04", 0.0], ["2024-03-11", 2.5]])

    def test_r_curve_books_each_trade_on_its_exit_day(self) -> None:
        days = ["2024-03-01", "2024-03-04", "2024-03-05", "2024-03-06"]
        curve = mx.r_curve(days, [("2024-03-04", 2.0), ("2024-03-04", -1.0), ("2024-03-06", 10.0)], 0.005)
        self.assertEqual(curve[0], ("2024-03-01", 1.0))
        self.assertAlmostEqual(curve[1][1], 1.01 * 0.995)
        self.assertEqual(curve[2][1], curve[1][1])  # no exit that day
        self.assertAlmostEqual(curve[3][1], 1.01 * 0.995 * 1.05)
        self.assertEqual(mx.r_curve(days, []), [(day, 1.0) for day in days])

    def test_replication_check_tolerances(self) -> None:
        self.assertTrue(mx.replication_check(689, 0.148, 0.444)["reproduced"])
        # Trades within 25 % of 657: 493 to 821.
        self.assertFalse(mx.replication_check(492, 0.14, 0.457)["reproduced"])
        self.assertTrue(mx.replication_check(493, 0.14, 0.457)["reproduced"])
        self.assertTrue(mx.replication_check(821, 0.14, 0.457)["reproduced"])
        self.assertFalse(mx.replication_check(822, 0.14, 0.457)["reproduced"])
        # Win rate within 5 points of 14 %.
        self.assertTrue(mx.replication_check(657, 0.19, 0.457)["reproduced"])
        self.assertFalse(mx.replication_check(657, 0.191, 0.457)["reproduced"])
        self.assertFalse(mx.replication_check(657, 0.089, 0.457)["reproduced"])
        # Net result within 0.15R of +0.457R.
        self.assertTrue(mx.replication_check(657, 0.14, 0.307)["reproduced"])
        self.assertFalse(mx.replication_check(657, 0.14, 0.306)["reproduced"])
        self.assertFalse(mx.replication_check(657, 0.14, 0.608)["reproduced"])
        failed = mx.replication_check(0, None, None)
        self.assertFalse(failed["reproduced"])
        self.assertEqual([part["pass"] for part in failed["parts"]], [False, False, False])

    def test_two_outcome_distribution_of_the_claim(self) -> None:
        shape = mx.two_point(0.14, 8.88, 0.457)
        self.assertAlmostEqual(0.14 * shape["win"] - 0.86 * shape["loss"], 0.457)
        self.assertAlmostEqual(shape["win"] / shape["loss"], 8.88)
        # Checked against a sample of the same distribution.
        sample = [shape["win"]] * 14 + [-shape["loss"]] * 86
        mean, sd, skew, kurt = mx.moments(sample)
        self.assertAlmostEqual(mean, 0.457)
        self.assertAlmostEqual(sd * math.sqrt(99 / 100), shape["sd"])
        self.assertAlmostEqual(skew, shape["skew"])
        self.assertAlmostEqual(kurt, shape["kurtosis"])
        with self.assertRaises(ValueError):
            mx.two_point(0.05, 8.88, 0.457)  # a 5 % win rate at 8.88 : 1 loses money

    def test_deflated_sharpe_falls_with_the_number_of_trials(self) -> None:
        rng = np.random.default_rng(7)
        value, points = 1.0, [("2020-01-01", 1.0)]
        for i, r in enumerate(rng.normal(0.0012, 0.01, size=1500)):
            value *= 1 + r
            points.append(((date(2020, 1, 2).toordinal() + i, value)))
        points = [(date.fromordinal(d).isoformat() if isinstance(d, int) else d, v) for d, v in points]
        trials = [0.01, 0.03, 0.05, 0.02, 0.04, 0.0, 0.06]
        few = mx.deflated(points, 7, trials)
        many = mx.deflated(points, 10_000, trials)
        more = mx.deflated(points, 10_500, trials)
        self.assertGreater(few["probability"], many["probability"])
        self.assertGreater(many["probability"], more["probability"])
        self.assertGreater(many["expectedMaxSharpePerDay"], few["expectedMaxSharpePerDay"])
        self.assertEqual((many["trials"], more["trials"], many["observations"]), (10_000, 10_500, 1500))
        self.assertAlmostEqual(many["trialVariance"], mx.variance_of(trials))
        # Hand check of the benchmark: sqrt(V) x ((1 - g) x z(1 - 1/N) + g x z(1 - 1/(N e))).
        from statistics import NormalDist

        g, n = 0.5772156649015329, 10_000
        expected = math.sqrt(mx.variance_of(trials)) * ((1 - g) * NormalDist().inv_cdf(1 - 1 / n)
                                                         + g * NormalDist().inv_cdf(1 - 1 / (n * math.e)))
        self.assertAlmostEqual(many["expectedMaxSharpePerDay"], expected, places=9)

    def test_deflated_sharpe_of_the_claim(self) -> None:
        null = mx.claim_deflated(10_000, 1 / 656)
        self.assertEqual((null["observations"], null["trials"]), (657, 10_000))
        self.assertAlmostEqual(null["sharpePerTrade"], 0.457 / mx.two_point(0.14, 8.88, 0.457)["sd"])
        self.assertAlmostEqual(null["tStatistic"], null["sharpePerTrade"] * math.sqrt(657))
        # 10,000 unskilled 657-trade strategies: the best one is expected above the claim, so under 0.5.
        self.assertGreater(null["expectedMaxSharpePerTrade"], null["sharpePerTrade"])
        self.assertLess(null["probability"], 0.5)
        self.assertGreater(mx.claim_deflated(2, 1 / 656)["probability"], null["probability"])
        self.assertGreater(null["probability"], mx.claim_deflated(10_500, 1 / 656)["probability"])
        self.assertGreater(mx.claim_deflated(10_000, 0.0)["probability"], 0.99)  # no spread across trials

    def test_quantiles_and_shares(self) -> None:
        self.assertEqual(mx.quantiles([3.0, 1.0, 2.0, 5.0, 4.0], (0.0, 0.5, 1.0)), {"p00": 1.0, "p50": 3.0, "p100": 5.0})
        self.assertEqual(mx.share_at_least([1.0, 2.0, 3.0, 4.0], 3.0), 0.5)
        self.assertIsNone(mx.share_at_least([], 1.0))
        self.assertIsNone(mx.share_at_least([1.0], None))


class VerdictTest(unittest.TestCase):
    BASE = {"oos_sharpe": 0.8, "deflated_probability": 0.97, "gates_passed": 5, "gates_total": 5,
            "reproduced": True, "options_oos_sharpes": [0.2, -0.1], "trades": 750}

    def rule(self, **changes) -> str:
        return study.verdict_rule(**{**self.BASE, **changes})

    def test_pre_registered_rule(self) -> None:
        self.assertEqual(self.rule(), "edge")
        # Edge needs all five gates, the reproduced claim and one options row with a positive OOS Sharpe.
        self.assertEqual(self.rule(gates_passed=4), "needs-more-data")
        self.assertEqual(self.rule(reproduced=False), "needs-more-data")
        self.assertEqual(self.rule(options_oos_sharpes=[-0.2, 0.0]), "needs-more-data")
        self.assertEqual(self.rule(options_oos_sharpes=[None, None]), "needs-more-data")
        self.assertEqual(self.rule(options_oos_sharpes=[-1.0, 0.01]), "edge")
        # No edge: OOS Sharpe <= 0, or deflated Sharpe probability < 0.5, or at most 2 gates.
        self.assertEqual(self.rule(oos_sharpe=0.0), "no-edge")
        self.assertEqual(self.rule(deflated_probability=0.49), "no-edge")
        self.assertEqual(self.rule(gates_passed=2), "no-edge")
        self.assertEqual(self.rule(gates_passed=3), "needs-more-data")
        self.assertEqual(self.rule(deflated_probability=0.5, gates_passed=3), "needs-more-data")
        # Fewer than 100 trades: needs more data, unless a no-edge condition already holds.
        self.assertEqual(self.rule(trades=99), "needs-more-data")
        self.assertEqual(self.rule(trades=99, oos_sharpe=-0.1), "no-edge")

    def test_gates_follow_the_thresholds(self) -> None:
        primary = {"outOfSample": {"sharpe": 0.5, "cagr": 0.05}, "inSample": {"sharpe": 1.0}}
        gates = study.checks_of(primary, {"probability": 0.95, "trials": 10_000},
                                {"maxDrawdownP5": -0.35, "paths": 2000, "lossShare": 0.1}, 0.75, 24,
                                {"sharpe": 0.01, "cagr": 0.001})
        self.assertEqual([g["pass"] for g in gates], [True] * 5)
        gates = study.checks_of({"outOfSample": {"sharpe": 0.49, "cagr": 0.0}, "inSample": {"sharpe": 1.0}},
                                {"probability": 0.949, "trials": 10_000}, {"maxDrawdownP5": -0.351, "paths": 2000},
                                0.74, 24, {"sharpe": 0.0, "cagr": 0.0})
        self.assertEqual([g["pass"] for g in gates], [False] * 5)
        self.assertFalse(study.checks_of(primary, {"probability": 0.99, "trials": 10_000}, {"paths": 0}, 1.0, 24,
                                         {"sharpe": 1.0, "cagr": 0.1})[2]["pass"])  # no bootstrap, no pass
        info = {"fixedPointsSpread": {"oosSharpe": -0.13, "deflatedN10000": 0.185, "stressSharpe": 0.02},
                "fillMinuteSpread": {"oosSharpe": 0.21, "deflatedN10000": 0.41, "stressSharpe": 0.33}}
        shown = study.checks_of(primary, {"probability": 0.2, "trials": 10_000},
                                {"maxDrawdownP5": -0.5, "paths": 2000, "lossShare": 0.1}, 0.9, 24,
                                {"sharpe": -0.01, "cagr": -0.03}, info)
        # The information rows are shown in the text; the pass marks come from the pre-registered numbers only.
        self.assertEqual([g["pass"] for g in shown], [True, False, False, True, False])
        self.assertIn("-0.13 with the spread as fixed points, 0.21 with the fill-minute spread", shown[0]["result"])
        self.assertIn("0.185 with the spread as fixed points, 0.410 with the fill-minute spread", shown[1]["result"])
        self.assertIn("0.02 with the spread as fixed points, 0.33 with the fill-minute spread", shown[4]["result"])
        for gate in shown:
            self.assertLessEqual(len(gate["result"]), 300)
        self.assertNotIn("information", shown[2]["result"])
        verdict, reason = study.verdict_of(gates, 0.49, 0.949, False, {"c1": -0.3, "c2": None}, 750)
        self.assertEqual(verdict, "no-edge")
        self.assertIn("0/5 gates", reason)
        self.assertIn("not reproduced", reason)
        self.assertLessEqual(len(reason), 1000)


class DefinitionTest(unittest.TestCase):
    def test_dsl_legs_are_the_spec_shape(self) -> None:
        long = definition.dsl_definition("long")
        self.assertEqual(long["intraday"], {"timezone": "America/New_York", "open": "09:30", "close": "16:00",
                                            "entryFrom": "09:45", "entryTo": "12:00"})
        self.assertEqual(long["entry"]["all"][0], {"left": {"type": "indicator", "name": "rvol", "length": 50},
                                                   "op": ">=", "right": {"type": "const", "value": 3}})
        self.assertEqual(long["entry"]["all"][1]["op"], "breaksAbove")
        self.assertEqual(long["entry"]["all"][1]["right"],
                         {"type": "indicator", "name": "highest", "length": 5, "source": "high"})
        self.assertEqual(long["stopLoss"], {"kind": "atr", "length": 14, "multiple": 1})
        self.assertEqual(long["sizing"]["riskPct"], 0.5)
        self.assertNotIn("side", long)
        short = definition.dsl_definition("short")
        self.assertEqual((short["side"], short["entry"]["all"][1]["op"]), ("short", "breaksBelow"))
        self.assertEqual(short["entry"]["all"][1]["right"]["name"], "lowest")
        with self.assertRaises(ValueError):
            definition.dsl_definition("flat")
        printed = definition.all_definitions()["volume-spike-breakout-dsl"]
        self.assertEqual(sorted(printed["legs"]), ["long", "short"])
        self.assertEqual(len(printed["missingDslParts"]), 7)

    def test_dsl_legs_compile_in_the_engine(self) -> None:
        from nautilus_backtest.signals import normalize_definition

        for side in definition.SIDES:
            normalized = normalize_definition(definition.dsl_definition(side))
            self.assertEqual(normalized["stopLoss"]["kind"], "atr")

    def test_sensitivity_rows_change_one_parameter_each(self) -> None:
        rows = definition.sensitivity(0.00115)
        self.assertEqual(len(rows), 24)
        base = asdict(definition.AS_STATED)
        for param, value, params in rows:
            changed = {k for k, v in asdict(params).items() if v != base[k]}
            # The percent stop changes the kind and the size of the stop; every other row one field.
            self.assertEqual(len(changed), 2 if params.stop_kind == "pct" else 1, f"{param} {value}")
        self.assertEqual(len({study.config_id(p) for _, _, p in rows}), 24)
        self.assertEqual({(p, v) for p, v, _ in rows} >= {("vol_mult", "2"), ("vol_n", "100"), ("k", "20"),
                                                         ("stop", "30 points"), ("time stop", "160 candles"),
                                                         ("Wednesday skip", "off"), ("4-hour trend filter", "off"),
                                                         ("session", "08:30 to 16:00"), ("session test", "candle open"),
                                                         ("entries per day", "no limit"), ("sides", "short only")}, True)
        self.assertEqual(len(definition.WALK_FORWARD_GRID), 18)
        self.assertIn(definition.AS_STATED, definition.WALK_FORWARD_GRID)
        self.assertEqual(asdict(definition.AS_STATED), {
            "vol_mult": 3.0, "vol_n": 50, "k": 5, "stop_kind": "points", "stop": 15.0, "time_stop": 80,
            "session_from": 510, "session_to": 720, "session_on": "close", "skip_weekdays": (2,), "trend": True,
            "trend_length": 20, "max_entries": 2, "sides": ("long", "short")})


class DataTest(unittest.TestCase):
    def test_mid_bars_volume_and_spread(self) -> None:
        bid = {"t": np.array([0, 60_000, 120_000]), "o": np.array([10.0, 11.0, 12.0]), "h": np.array([10.5, 11.5, 12.5]),
               "l": np.array([9.5, 10.5, 11.5]), "c": np.array([10.2, 11.2, 12.2]), "v": np.array([1.0, 2.0, 3.0])}
        ask = {"t": np.array([60_000, 120_000, 180_000]), "o": np.array([11.2, 12.2, 13.2]),
               "h": np.array([11.7, 12.7, 13.7]), "l": np.array([10.7, 11.7, 12.7]), "c": np.array([11.4, 12.4, 13.4]),
               "v": np.array([0.5, 0.25, 9.0])}
        minutes, spread = data.mid_bars(bid, ask)
        self.assertEqual(minutes.t.tolist(), [60_000, 120_000])  # the timestamps both sides have
        self.assertEqual(minutes.v.tolist(), [2.5, 3.25])  # bid volume + ask volume
        np.testing.assert_allclose(minutes.o, [11.1, 12.1], rtol=1e-6)
        np.testing.assert_allclose(minutes.c, [11.3, 12.3], rtol=1e-6)
        np.testing.assert_allclose(spread, [0.2, 0.2], rtol=1e-5)
        self.assertEqual(minutes.o.dtype, np.float32)
        self.assertEqual(minutes.t.dtype, np.int64)
        bars = data.MarketBars("NAS100", minutes, spread)
        stats = data.spread_stats(bars, 0, 200_000)
        self.assertAlmostEqual(stats["points"], 0.2, places=5)
        self.assertAlmostEqual(stats["bps"], float(np.median([0.2 / 11.3, 0.2 / 12.3])) * 1e4, places=2)
        self.assertEqual(data.spread_stats(bars, 500_000, 600_000), {"bps": None, "points": None, "bars": 0})
        self.assertEqual(data.spread_at(bars, [])["bars"], 0)
        self.assertEqual(data.spread_at(bars, [1])["bars"], 1)

    def test_etf_split_is_back_adjusted(self) -> None:
        tape = Tape("2024-03-04", 9 * 60 + 30, price=10.0).flat(2)
        tape.t = rules.ny_ms("2024-03-05", 9 * 60 + 30)
        tape.price = 80.0  # a 1:8 reverse split overnight
        m = tape.flat(2).minutes()
        adjusted, splits = data.adjust_splits(m)
        self.assertEqual([s[0] for s in splits], ["2024-03-05"])
        self.assertAlmostEqual(splits[0][1], 8.0)
        np.testing.assert_allclose(adjusted.c, 80.0)
        same, none = data.adjust_splits(Tape().flat(4).minutes())
        self.assertEqual(none, ())
        self.assertIs(same.c.dtype, np.dtype("float64"))

    def test_files_cache_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_market(root / "m1", "usatechidxusd", Tape().flat(4).minutes(), spread=0.5)
            self.assertTrue(data.available("NAS100", root, root / "twins"))
            self.assertFalse(data.available("US500", root, root / "twins"))
            self.assertFalse(data.available("QQQ", root, root / "twins"))
            bars = data.load_market("NAS100", root, root / "twins")
            self.assertEqual(len(bars), 60)
            self.assertAlmostEqual(float(bars.spread[0]), 0.5, places=5)
            self.assertTrue((root / "cache" / "usatechidxusd" / "stamp.npy").exists())
            again = data.load_market("NAS100", root, root / "twins")
            np.testing.assert_array_equal(again.minutes.c, bars.minutes.c)
            self.assertEqual(data.summary_of(bars)["rows"], 60)
            digest, files = data.data_hash(root)
            self.assertTrue(digest.startswith("sha256:"))
            self.assertEqual(sorted(files), ["usatechidxusd-ask.csv.gz", "usatechidxusd-bid.csv.gz"])
            # The same hash as the fetcher's manifest.
            self.assertEqual(digest[7:], _fetcher().combined_hash(files))

    def ibkr_columns(self, days: list[str], first_minute: int = 9 * 60, last_minute: int = 16 * 60 + 30
                     ) -> dict[str, np.ndarray]:
        t = [rules.ny_ms(day, minute) for day in days for minute in range(first_minute, last_minute, 5)]
        price = np.linspace(100.0, 110.0, len(t))
        return {"t": np.array(t, dtype=np.int64), "o": price, "h": price + 0.2, "l": price - 0.2, "c": price + 0.1,
                "v": np.full(len(t), 5_000.0)}

    def test_ibkr_bars_keep_regular_hours_inside_the_window(self) -> None:
        days = ["2017-12-29", "2018-01-02", "2018-01-03", "2018-01-06", "2026-11-06", "2026-11-09"]
        cols = self.ibkr_columns(days)
        start, end = rules.ny_ms("2018-01-01"), rules.ny_ms("2026-11-07")
        bars = data.ibkr_bars("SPY", cols, start, end, start + 2 * rules.DAY_MS)
        self.assertTrue(bars.available)
        m = bars.minutes
        # 2017 and the day after the window are cut; Saturday 2018-01-06 and the bars outside 09:30-16:00 too.
        self.assertEqual(len(m), 3 * 78)
        local = rules.ny_local_ms(m.t)
        self.assertEqual(sorted({rules.day_text(d) for d in local // rules.DAY_MS}),
                         ["2018-01-02", "2018-01-03", "2026-11-06"])
        minute = (local // rules.MINUTE_MS) % 1440
        self.assertEqual((int(minute.min()), int(minute.max())), (570, 955))
        self.assertEqual((m.t.dtype, m.o.dtype), (np.int64, np.float32))
        self.assertEqual(bars.rows_in_file, len(cols["t"]))
        # The hash covers the bars used: older and newer bars added by the fetch job do not change it.
        more = self.ibkr_columns(["2017-12-28", *days, "2026-11-10"])
        shifted = {k: v for k, v in more.items()}
        again = data.ibkr_bars("SPY", {**cols}, start, end, start + 2 * rules.DAY_MS)
        self.assertEqual(again.sha256, bars.sha256)
        self.assertEqual(len(data.ibkr_bars("SPY", shifted, start, end, start + 2 * rules.DAY_MS).minutes), 3 * 78)

    def test_an_ibkr_file_that_does_not_reach_back_is_pending(self) -> None:
        start, end = rules.ny_ms("2018-01-01"), rules.ny_ms("2026-11-07")
        late = data.ibkr_bars("IWM", self.ibkr_columns(["2018-01-03", "2018-01-04"]), start, end,
                              start + 2 * rules.DAY_MS)
        self.assertFalse(late.available)
        self.assertEqual(late.reason, data.ETF_PENDING)
        self.assertEqual(late.first_in_file, "2018-01-03T14:00Z")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(data.load_ibkr("DIA", tmp, end).reason, data.ETF_PENDING)  # no file yet
            self.assertEqual(data.load_ibkr("GLD", tmp, end).reason, data.ETF_NOT_TESTABLE)
            cols = self.ibkr_columns(["2018-01-02", "2018-01-03"])
            lines = ["timestamp,open,high,low,close,volume"] + [
                f"{cols['t'][i]},{cols['o'][i]:.2f},{cols['h'][i]:.2f},{cols['l'][i]:.2f},{cols['c'][i]:.2f},5000.0"
                for i in range(len(cols["t"]))]
            with gzip.open(Path(tmp) / "SPY.csv.gz", "wt") as fh:
                fh.write("\n".join(lines) + "\n")
            loaded = data.load_ibkr("SPY", tmp, end)
            self.assertEqual((loaded.available, len(loaded.minutes)), (True, 2 * 78))
            self.assertEqual(data.ibkr_quoted_spread("SPY", tmp, start, end), {"bps": None, "points": None, "bars": 0})

    def test_an_unreadable_ibkr_file_makes_the_twin_not_testable(self) -> None:
        wait, data.READ_WAIT = data.READ_WAIT, 0.0
        try:
            with tempfile.TemporaryDirectory() as tmp:
                good = gzip.compress(b"timestamp,open,high,low,close,volume\n" + b"1514903400000,1,1,1,1,5\n" * 50)
                (Path(tmp) / "SPY.csv.gz").write_bytes(good[:len(good) // 2])  # cut in the middle of a rewrite
                end = rules.ny_ms("2026-11-07")
                bars = data.load_ibkr("SPY", tmp, end)
                self.assertFalse(bars.available)
                self.assertIn("could not be read after one retry", bars.reason)
                self.assertIn("EOFError", bars.reason)
                (Path(tmp) / "SPY-bidask.csv.gz").write_bytes(good[:20])
                self.assertEqual(data.ibkr_quoted_spread("SPY", tmp, 0, end)["bps"], None)
                messages: list[str] = []
                row = study._ibkr(study.Pool(0), "SPY", tmp, data.IBKR_FROM, rules.ny_ms("2019-01-01"), end,
                                  (rules.ny_ms("2019-01-01"), rules.ny_ms("2026-03-12")), 0.001, None, messages.append)
                self.assertEqual(row["status"], data.ETF_UNTESTED)
                self.assertIn("could not be read", row["reason"])
                self.assertIn("not testable", messages[0])
                twins = study.etf_twin_rows(["SPY"], {"SPY": row}, {"SPY": 3}, {})
                self.assertEqual((twins[0]["status"], twins[0]["dukascopyTrades"]), ("not-testable", 3))
        finally:
            data.READ_WAIT = wait

    def test_the_study_warns_about_files_with_missing_months(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_market(root / "m1", "usatechidxusd", Tape().flat(8).minutes(), spread=0.5)
            window = (rules.ny_ms("2024-03-03"), rules.ny_ms("2024-03-09"))
            messages: list[str] = []
            loaded = study._load("NAS100", str(root), str(root / "twins"), *window, window, messages.append)
            self.assertEqual(loaded["missingMonths"], {})
            self.assertFalse([m for m in messages if "missing months" in m])
            (root / "m1" / "usatechidxusd-bid.csv.gz.missing").write_text("2024-02-01\n")
            loaded = study._load("NAS100", str(root), str(root / "twins"), *window, window, messages.append)
            self.assertEqual(loaded["missingMonths"], {"usatechidxusd-bid.csv.gz": ["2024-02-01"]})
            self.assertTrue([m for m in messages if m.startswith("warning: NAS100 was fetched with missing months")])

    def test_a_cut_gzip_read_is_retried_once(self) -> None:
        calls = []

        def flaky(path):
            calls.append(path)
            if len(calls) == 1:
                raise EOFError("Compressed file ended before the end-of-stream marker was reached")
            return b"ok"

        self.assertEqual(data.read_once(Path("x"), wait=0.0, reader=flaky), b"ok")
        self.assertEqual(len(calls), 2)
        calls.clear()

        def broken(path):
            calls.append(path)
            raise EOFError("cut")

        with self.assertRaises(EOFError):
            data.read_once(Path("x"), wait=0.0, reader=broken)
        self.assertEqual(len(calls), 2)  # one retry, then the error

    def test_quoted_spread_of_the_ibkr_sample(self) -> None:
        cols = {"t": np.array([10, 20, 30, 40]), "o": np.array([100.0, 100.0, 100.0, 0.0]),
                "c": np.array([100.02, 100.04, 100.06, 1.0])}
        spread = data.quoted_spread(cols, 0, 35)
        self.assertEqual(spread["bars"], 3)
        self.assertAlmostEqual(spread["points"], 0.04)
        self.assertAlmostEqual(spread["bps"], 0.04 / 100.02 * 1e4, places=6)
        self.assertEqual(data.quoted_spread(cols, 35, 45)["bps"], None)  # a bid of 0 is not a quote

    def test_markets(self) -> None:
        self.assertEqual(data.PRIMARY, "NAS100")
        self.assertEqual(data.instrument("NAS100").source, "usatechidxusd")
        self.assertEqual(data.SOURCE_MARKETS, ("US500", "US30", "US2000", "XAUUSD", "WTI"))
        self.assertEqual(len(data.ALL_MARKETS), 14)
        self.assertTrue(data.is_etf("QQQ"))
        self.assertFalse(data.is_etf("XAGUSD"))


class DiagnosticsTest(unittest.TestCase):
    def test_volume_regime_finds_the_month_the_spikes_stop(self) -> None:
        tape = Tape("2024-01-29", 7 * 60)
        for day in ("2024-01-29", "2024-02-05", "2024-03-04"):
            tape.t = rules.ny_ms(day, 7 * 60)
            tape.flat(6)
            if day < "2024-03-01":
                tape.spike_up().flat(4)
            else:
                tape.flat(5)
        regime = diagnostics.volume_regime(rules.frame(tape.minutes()), SMALL)
        self.assertEqual([row["month"] for row in regime["months"]], ["2024-01", "2024-02", "2024-03"])
        self.assertEqual([row["sessionSpikes"] for row in regime["months"]], [1, 1, 0])
        self.assertEqual((regime["lastSessionSpike"], regime["noSessionSpikeFrom"]), ("2024-02-05", "2024-03"))
        self.assertEqual((regime["sessionDaysAfterLastSessionSpike"], regime["lastDay"]), (1, "2024-03-04"))
        times = diagnostics.spike_times(rules.frame(tape.minutes()), SMALL, rules.ny_ms("2024-01-01"),
                                        rules.ny_ms("2024-04-01"))
        by_time = {row["time"]: row for row in times}
        self.assertEqual((by_time["08:30"]["spikes"], by_time["08:30"]["spikeShare"]), (2, 1.0))
        self.assertEqual(by_time["08:45"]["spikes"], 0)

    def test_median_close_by_year(self) -> None:
        rows = diagnostics.median_close_by_year(Tape(price=15_000.0).flat(2).minutes(), 15.0)
        self.assertEqual((rows[0]["year"], rows[0]["medianClose"]), (2024, 15_000.0))
        self.assertAlmostEqual(rows[0]["stopPctOfPrice"], 0.1)


class ControlTest(unittest.TestCase):
    def tape(self) -> Tape:
        tape = Tape(MONDAY, 7 * 60)
        for day in ("2024-03-04", "2024-03-05", "2024-03-07", "2024-03-08"):
            tape.t = rules.ny_ms(day, 7 * 60)
            for i in range(24):
                tape.candle(close=tape.price + (0.3 if i % 2 else -0.2))
        return tape

    def test_random_control_takes_the_same_number_of_entries(self) -> None:
        fr = rules.frame(self.tape().minutes())
        params = replace(SMALL, skip_weekdays=(2,), time_stop=2)
        first = rules.random_control(fr, params, *WEEK, 6, np.random.default_rng([1, 0]))
        again = rules.random_control(fr, params, *WEEK, 6, np.random.default_rng([1, 0]))
        other = rules.random_control(fr, params, *WEEK, 6, np.random.default_rng([1, 1]))
        self.assertEqual(len(first), 6)
        self.assertEqual(first, again)  # seeded
        self.assertNotEqual([t.entry_ms for t in first], [t.entry_ms for t in other])
        session = range(8 * 60 + 30, 12 * 60 + 1)
        for t in first:
            local = datetime.fromtimestamp(t.entry_ms / 1000, UTC).astimezone(NEW_YORK)
            self.assertIn(local.hour * 60 + local.minute, session)  # the entry open = the signal candle's close
            self.assertNotEqual(local.weekday(), 2)
        per_day: dict[str, int] = {}
        for t in first:
            day = datetime.fromtimestamp(t.entry_ms / 1000, UTC).astimezone(NEW_YORK).date().isoformat()
            per_day[day] = per_day.get(day, 0) + 1
        self.assertLessEqual(max(per_day.values()), 2)
        self.assertEqual(rules.random_control(fr, params, *WEEK, 0, np.random.default_rng(1)), [])

    def test_control_summary(self) -> None:
        fr = rules.frame(self.tape().minutes())
        costs = {"vertex": rules.Costs(rate=1e-4), "source": rules.source_costs(SMALL)}
        runs = study.control_runs(fr, replace(SMALL, time_stop=2), *WEEK, 4, 5, costs, seed=3)
        self.assertEqual(len(runs), 5)
        self.assertEqual([r["trades"] for r in runs], [4] * 5)
        summary = study.control_summary(runs, {"vertex": {"meanR": 99.0, "totalR": 99.0, "sharpePerTrade": 9.0},
                                               "source": {"meanR": -99.0, "totalR": -99.0, "sharpePerTrade": -9.0}}, 4)
        self.assertEqual((summary["runs"], summary["vertex"]["shareAtOrAboveOursMeanR"]), (5, 0.0))
        self.assertEqual(summary["source"]["shareAtOrAboveOursMeanR"], 1.0)
        self.assertEqual((summary["runsShort"], summary["runsOver"]), (0, 0))
        self.assertEqual([r["short"] for r in runs], [False] * 5)
        # A control that cannot take the wanted entries is reported, not hidden.
        greedy = study.control_runs(fr, replace(SMALL, time_stop=2), *WEEK, 500, 2, costs, seed=3)
        self.assertEqual([r["short"] for r in greedy], [True, True])
        self.assertEqual(study.control_summary(greedy, {"vertex": {}, "source": {}}, 500)["runsShort"], 2)


def write_market(folder: Path, source_id: str, m: rules.Minutes, spread: float = 0.5) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for side, shift, share in (("bid", -spread / 2, 0.5), ("ask", spread / 2, 0.5)):
        lines = ["timestamp,open,high,low,close,volume"]
        for i in range(len(m)):
            lines.append(f"{int(m.t[i])},{m.o[i] + shift:.4f},{m.h[i] + shift:.4f},{m.l[i] + shift:.4f},"
                         f"{m.c[i] + shift:.4f},{m.v[i] * share:.6f}")
        with gzip.open(folder / f"{source_id}-{side}.csv.gz", "wt") as fh:
            fh.write("\n".join(lines) + "\n")


class FetcherTest(unittest.TestCase):
    def test_month_iterator(self) -> None:
        fetch = _fetcher()
        months = list(fetch.months(date(2018, 1, 1), date(2026, 11, 7)))
        self.assertEqual(len(months), 107)
        self.assertEqual(months[0], (date(2018, 1, 1), date(2018, 2, 1)))
        self.assertEqual(months[11], (date(2018, 12, 1), date(2019, 1, 1)))
        self.assertEqual(months[-1], (date(2026, 11, 1), date(2026, 11, 7)))  # clipped at the end
        for (_, end), (start, _) in zip(months, months[1:]):
            self.assertEqual(end, start)  # no gap, no overlap
        partial = list(fetch.months(date(2018, 8, 8), date(2018, 10, 1)))
        self.assertEqual(partial, [(date(2018, 8, 8), date(2018, 9, 1)), (date(2018, 9, 1), date(2018, 10, 1))])
        self.assertEqual(list(fetch.months(date(2020, 5, 1), date(2020, 5, 1))), [])

    def test_request_and_targets(self) -> None:
        fetch = _fetcher()
        cmd = fetch.command("usatechidxusd", "ask", date(2024, 3, 1), date(2024, 4, 1), "/tmp/x")
        self.assertEqual(cmd[:3], ["npx", "-y", "dukascopy-node@1.51.1"])
        self.assertEqual(cmd[cmd.index("-t") + 1], "m1")
        self.assertEqual(cmd[cmd.index("-p") + 1], "ask")
        self.assertIn("-v", cmd)
        self.assertEqual([name for name, _ in fetch.INSTRUMENTS],
                         ["usatechidxusd", "usa500idxusd", "usa30idxusd", "ussc2000idxusd", "xauusd", "xagusd",
                          "lightcmdusd"])
        self.assertEqual((fetch.START, fetch.END), (date(2018, 1, 1), date(2026, 11, 7)))

    def test_targets_are_assembled_from_month_parts_without_duplicates(self) -> None:
        fetch = _fetcher()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "m1").mkdir()
            first, second = root / "a.csv.gz", root / "b.csv.gz"
            rows = [["3", "1", "1", "1", "1", "0.5"], ["1", "1", "1", "1", "1", "0.5"], ["1", "9", "9", "9", "9", "9"]]
            fetch.write_gz(first, fetch.clean(rows))
            fetch.write_gz(second, [["3", "2", "2", "2", "2", "1"], ["4", "2", "2", "2", "2", "1"]])
            target = root / "m1" / "x-bid.csv.gz"
            self.assertEqual(fetch.assemble(target, [first, second]), 3)
            self.assertEqual([r[0] for r in fetch.read_gz(target)], ["1", "3", "4"])
            self.assertFalse(target.with_name(target.name + ".tmp").exists())
            before = fetch.sha256_of(target)
            fetch.assemble(target, [first, second])
            self.assertEqual(fetch.sha256_of(target), before)  # same rows, same bytes
            manifest = fetch.build_manifest(root)
            self.assertEqual(manifest["files"]["x-bid.csv.gz"]["rows"], 3)
            self.assertEqual(manifest["dataHash"], fetch.combined_hash({"x-bid.csv.gz": before}))
            # An existing target is skipped (no download is attempted).
            self.assertEqual(fetch.fetch_target(root, "x", date(2018, 1, 1), "bid", False), [])


class FetcherMissingMonthsTest(unittest.TestCase):
    def test_a_target_written_with_a_hole_keeps_reporting_it(self) -> None:
        fetch = _fetcher()
        calls: list[str] = []

        def fake(inst, side, start, end, cwd):
            calls.append(start.isoformat())
            if start.month == 2:
                return None  # February fails, also on the retry
            stamp = int(datetime(start.year, start.month, 2, tzinfo=UTC).timestamp() * 1000)
            return [[str(stamp), "1", "1", "1", "1", "0.5"]]

        fetch.fetch_month = fake
        fetch.END = date(2018, 4, 1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "m1").mkdir()
            (root / "parts").mkdir()
            target = root / "m1" / "x-bid.csv.gz"
            self.assertEqual(fetch.fetch_target(root, "x", date(2018, 1, 1), "bid", False), ["2018-02-01"])
            self.assertFalse(target.exists())  # incomplete: not written, the month parts stay
            self.assertEqual(calls.count("2018-02-01"), 2)  # one retry
            self.assertEqual(len(list((root / "parts").glob("x-bid-*.csv.gz"))), 2)
            self.assertEqual(fetch.fetch_target(root, "x", date(2018, 1, 1), "bid", True), ["2018-02-01"])
            self.assertEqual(len(fetch.read_gz(target)), 2)
            self.assertEqual(fetch.recorded_missing(target), ["2018-02-01"])
            # Later runs skip the existing target and still report the hole, in the result and in the manifest.
            calls.clear()
            self.assertEqual(fetch.fetch_target(root, "x", date(2018, 1, 1), "bid", False), ["2018-02-01"])
            self.assertEqual(calls, [])
            self.assertEqual(fetch.build_manifest(root)["missingMonths"], {"x-bid": ["2018-02-01"]})
            self.assertEqual(sorted(p.name for p in (root / "m1").glob("*.csv.gz")), ["x-bid.csv.gz"])  # the data hash
            before = os.environ.get("VERTEX_VOLSPIKE_DATA_ROOT")
            os.environ["VERTEX_VOLSPIKE_DATA_ROOT"] = tmp
            try:
                self.assertEqual(fetch.main(["--manifest"]), 1)
            finally:
                if before is None:
                    del os.environ["VERTEX_VOLSPIKE_DATA_ROOT"]
                else:
                    os.environ["VERTEX_VOLSPIKE_DATA_ROOT"] = before
            # The record is written before the target: a crash while the target is built cannot hide the hole.
            crash_target = root / "m1" / "y-bid.csv.gz"

            def crash(target, parts):
                raise RuntimeError("killed while writing the target")

            assemble, fetch.assemble = fetch.assemble, crash
            try:
                with self.assertRaises(RuntimeError):
                    fetch.fetch_target(root, "y", date(2018, 1, 1), "bid", True)
            finally:
                fetch.assemble = assemble
            self.assertFalse(crash_target.exists())
            self.assertEqual(fetch.recorded_missing(crash_target), ["2018-02-01"])
            # The study reads the same record and warns.
            self.assertEqual(data.missing_months("NAS100", root, root / "twins"), {})
            (root / "m1" / "usatechidxusd-ask.csv.gz.missing").write_text("2018-02-01\n2018-03-01\n")
            self.assertEqual(data.missing_months("NAS100", root, root / "twins"),
                             {"usatechidxusd-ask.csv.gz": ["2018-02-01", "2018-03-01"]})
            # A complete fetch after deleting the target clears the record.
            target.unlink()
            fetch.fetch_month = lambda inst, side, start, end, cwd: [[str(int(datetime(
                start.year, start.month, 2, tzinfo=UTC).timestamp() * 1000)), "1", "1", "1", "1", "0.5"]]
            self.assertEqual(fetch.fetch_target(root, "x", date(2018, 1, 1), "bid", False), [])
            self.assertEqual((len(fetch.read_gz(target)), fetch.recorded_missing(target)), (3, []))
            self.assertEqual(fetch.build_manifest(root)["missingMonths"], {})


class OptionsTest(unittest.TestCase):
    def market(self) -> Market:
        dates = ("2024-02-29", "2024-03-01", "2024-03-04", "2024-03-05", "2024-03-06")
        return Market("QQQ", dates, (440.0,) * 5, (18.0,) * 5, (0.05,) * 5)

    def twin(self) -> options.TwinClock:
        tape = Tape("2024-03-04", 9 * 60 + 30, price=440.0)
        for day, drift in (("2024-03-04", 0.1), ("2024-03-05", 0.2), ("2024-03-06", -0.1)):
            tape.t = rules.ny_ms(day, 9 * 60 + 30)
            for _ in range(26):
                tape.candle(close=tape.price + drift)
        return options.TwinClock(tape.minutes())

    def test_weekly_expiry_needs_two_trading_days(self) -> None:
        self.assertEqual(options.weekly_expiry("2024-03-04"), date(2024, 3, 8))  # Monday
        self.assertEqual(options.weekly_expiry("2024-03-06"), date(2024, 3, 8))  # Wednesday: Thursday, Friday
        self.assertEqual(options.weekly_expiry("2024-03-07"), date(2024, 3, 15))  # Thursday: only Friday is left
        self.assertEqual(options.weekly_expiry("2024-03-08"), date(2024, 3, 15))  # Friday
        self.assertEqual(options.weekly_expiry("2024-03-25"), date(2024, 3, 28))  # Good Friday: Thursday expiry
        self.assertEqual(options.weekly_expiry("2024-03-27"), date(2024, 4, 5))  # one trading day before it

    def test_a_signal_before_the_open_starts_at_0930_and_ends_at_the_rule_exit(self) -> None:
        twin, market = self.twin(), self.market()
        entry = rules.ny_ms("2024-03-04", 8 * 60 + 45)
        long = options.price_signal(options.Signal("long", entry, rules.ny_ms("2024-03-05", 10 * 60)), twin, market)
        self.assertEqual(long.entry_ms, rules.ny_ms("2024-03-04", 9 * 60 + 30))
        self.assertEqual(long.exit_ms, rules.ny_ms("2024-03-05", 10 * 60))
        self.assertEqual((long.right, long.expiry, long.exit_reason), ("call", "2024-03-08", "rule"))
        self.assertGreater(long.short_strike, long.long_strike)
        self.assertEqual(long.entry_spot, 440.0)
        self.assertEqual(len(long.marks), 1)  # Monday's close lies between entry and exit
        self.assertEqual(long.marks[0][0], rules.ny_ms("2024-03-04", 16 * 60))
        self.assertGreater(long.exit_price, long.entry_price)  # QQQ rose
        self.assertAlmostEqual(long.max_loss, long.entry_price + long.entry_fee + options.worst_exit_cost("QQQ", long.width))
        short = options.price_signal(options.Signal("short", entry, rules.ny_ms("2024-03-05", 10 * 60)), twin, market)
        self.assertEqual(short.right, "put")
        self.assertLess(short.short_strike, short.long_strike)
        self.assertLess(short.exit_price, short.entry_price)
        # An exit after the close waits for the next regular minute.
        night = options.price_signal(options.Signal("long", entry, rules.ny_ms("2024-03-04", 20 * 60)), twin, market)
        self.assertEqual(night.exit_ms, rules.ny_ms("2024-03-05", 9 * 60 + 30))

    def stopped(self, **entry_candle) -> rules.Trade:
        """A long entered at 10:15 on Monday (signal on the 10:00 candle) and stopped as `entry_candle` says."""
        tape = Tape(MONDAY, 8 * 60 + 30).flat(6).spike_up()
        tape.candle(**entry_candle).flat(8)
        return trades_of(tape)[0]

    def test_a_stop_inside_a_minute_is_known_when_that_minute_ends(self) -> None:
        twin, market = self.twin(), self.market()
        inside = self.stopped(low=95.5)  # touched in the 10:22 minute
        self.assertEqual((inside.reason, inside.exit_at_open), ("stop", False))
        self.assertEqual(inside.exit_ms, rules.ny_ms(MONDAY, 10 * 60 + 22))
        signal = options.signals_of([inside])[0]
        self.assertEqual((signal.entry_ms, signal.exit_ms), (inside.entry_ms, inside.exit_ms + 60_000))
        spread = options.price_signal(signal, twin, market)
        # The spread closes at the open of 10:23, the first minute after the stop minute; not at the 10:22 open.
        self.assertEqual((spread.entry_ms, spread.exit_ms),
                         (rules.ny_ms(MONDAY, 10 * 60 + 15), rules.ny_ms(MONDAY, 10 * 60 + 23)))
        self.assertEqual(spread.exit_spot, float(twin.o[twin.at_or_after(rules.ny_ms(MONDAY, 10 * 60 + 23))]))

    def test_a_stop_inside_the_entry_minute_still_opens_the_spread(self) -> None:
        twin, market = self.twin(), self.market()
        same = self.stopped(bars={0: (101.0, 101.0, 95.0, 100.0)})
        self.assertEqual((same.exit_index, same.exit_at_open), (same.entry_index, False))
        spread = options.price_signal(options.signals_of([same])[0], twin, market)
        self.assertEqual(spread.exit_ms - spread.entry_ms, 60_000)  # opened at 10:15, closed at the 10:16 open
        # Exits that fill at a bar open are known at that open: a gapped stop, the time stop.
        gapped = self.stopped(bars={3: (94.0, 94.0, 94.0, 94.0)})
        self.assertEqual((gapped.reason, gapped.exit, gapped.exit_at_open), ("stop", 94.0, True))
        self.assertEqual(options.signals_of([gapped])[0].exit_ms, gapped.exit_ms)
        timed = self.stopped()
        self.assertEqual((timed.reason, timed.exit_at_open), ("time", True))
        self.assertEqual(options.signals_of([timed])[0].exit_ms, timed.exit_ms)
        # The end of the data is the close of the last bar: known when that bar ends.
        open_end = trades_of(Tape(MONDAY, 8 * 60 + 30).flat(6).spike_up().flat(2))[0]
        self.assertEqual((open_end.reason, open_end.exit_at_open), ("end", False))
        self.assertEqual(options.signals_of([open_end])[0].exit_ms, open_end.exit_ms + 60_000)

    def test_rule_trades_to_booked_spreads_on_a_small_tape(self) -> None:
        twin, market = self.twin(), self.market()
        tape = Tape().flat(6).spike_up()  # entry 08:45
        tape.candle(low=tape.price - 5.5).flat(3)  # stopped at 08:52: known before 09:30, no spread
        tape.spike_up()  # the 09:45 candle; entry 10:00
        tape.candle(bars={0: (tape.price, tape.price, tape.price - 6, tape.price - 1)}).flat(3)  # stopped in 10:00
        tape.spike_up().flat(8)  # the 11:00 candle; entry 11:15; time stop 6 candles later
        trades = trades_of(tape, replace(SMALL, max_entries=None))
        self.assertEqual([t.reason for t in trades], ["stop", "stop", "time"])
        spreads, skipped = options.price_signals(options.signals_of(trades), twin, market)
        self.assertEqual(skipped, {"closed before the open": 1})
        times = [(s.entry_ms, s.exit_ms) for s in spreads]
        self.assertEqual(times, [(rules.ny_ms(MONDAY, 10 * 60), rules.ny_ms(MONDAY, 10 * 60 + 1)),
                                 (rules.ny_ms(MONDAY, 11 * 60 + 15), rules.ny_ms(MONDAY, 12 * 60 + 45))])
        booked = options.book(spreads, twin.close_ms, 100_000.0, nautilus=False)
        records = sorted(booked["result"].trades, key=lambda r: r["id"])
        self.assertEqual(len(records), 2)
        self.assertLess(records[0]["pnl"], 0)  # one minute in the spread: the costs of four legs
        self.assertEqual(booked["points"][0][0], MONDAY)

    def test_skips(self) -> None:
        twin, market = self.twin(), self.market()
        early = rules.ny_ms("2024-03-04", 8 * 60 + 45)
        stopped = options.Signal("long", early, rules.ny_ms("2024-03-04", 9 * 60))  # stopped before 09:30
        self.assertEqual(options.price_signal(stopped, twin, market), "closed before the open")
        same_minute = options.Signal("long", rules.ny_ms("2024-03-04", 10 * 60), rules.ny_ms("2024-03-04", 10 * 60))
        self.assertEqual(options.price_signal(same_minute, twin, market), "closed before the open")
        after = options.Signal("long", rules.ny_ms("2024-03-06", 15 * 60), rules.ny_ms("2024-03-07", 10 * 60))
        self.assertEqual(options.price_signal(after, twin, market), "no ETF bar at the exit")
        stale = Market("QQQ", ("2024-02-20",), (440.0,), (18.0,), (0.05,))
        ok = options.Signal("long", early, rules.ny_ms("2024-03-05", 10 * 60))
        self.assertEqual(options.price_signal(ok, twin, stale), "stale IV")
        spreads, skipped = options.price_signals([stopped, ok, same_minute], twin, market)
        self.assertEqual((len(spreads), skipped), (1, {"closed before the open": 2}))

    def test_ledger_booking_marks_the_session_close(self) -> None:
        twin, market = self.twin(), self.market()
        signals = [options.Signal("long", rules.ny_ms("2024-03-04", 8 * 60 + 45), rules.ny_ms("2024-03-05", 10 * 60)),
                   options.Signal("short", rules.ny_ms("2024-03-05", 11 * 60), rules.ny_ms("2024-03-06", 11 * 60))]
        spreads, _ = options.price_signals(signals, twin, market)
        booked = options.book(spreads, twin.close_ms, 100_000.0, nautilus=False)
        self.assertEqual([day for day, _ in booked["points"]], ["2024-03-04", "2024-03-05", "2024-03-06"])
        self.assertEqual(len(booked["result"].trades), 2)
        for record in booked["result"].trades:
            # Sized so the maximum loss is at most 2 % of equity (the ids follow the entry order).
            self.assertLessEqual(record["contracts"] * spreads[record["id"] - 1].max_loss, 0.02 * 101_000)
            self.assertGreater(record["contracts"], 0)
        self.assertNotEqual(booked["points"][0][1], 100_000.0)  # marked at Monday's close, before the exit
        self.assertEqual(len(booked["returns"]), 2)

    @unittest.skipUnless(_nautilus_installed(), "NautilusTrader is not installed")
    def test_nautilus_booking_matches_the_ledger(self) -> None:
        twin, market = self.twin(), self.market()
        signals = [options.Signal("long", rules.ny_ms("2024-03-04", 8 * 60 + 45), rules.ny_ms("2024-03-05", 10 * 60))]
        spreads, _ = options.price_signals(signals, twin, market)
        booked = options.book(spreads, twin.close_ms, 100_000.0)
        self.assertLess(booked["maxGap"], 0.01)


@unittest.skipUnless(_nautilus_installed(), "NautilusTrader is not installed")
class NautilusBookingTest(unittest.TestCase):
    step = 1

    def tape(self) -> Tape:
        tape = morning(self.step)  # long at 101
        tape.flat(1).candle(low=95.5).flat(1)  # stopped at 96
        tape.spike_up().flat(2)  # long at the next open
        tape.spike_down(1.5).flat(2)  # the opposite signal closes it and opens a short
        tape.candle(bars={0: (tape.price + 7, tape.price + 7, tape.price + 7, tape.price + 7)})  # gap over the short stop
        tape.flat(6)
        return tape

    def book(self, costs: rules.Costs) -> tuple[list[rules.Trade], list[dict]]:
        tape = self.tape()
        m = tape.minutes()
        params = replace(SMALL, max_entries=None)
        trades = rules.run_rule(rules.frame(m), params, *WEEK, costs)
        legs = []
        for side in (rules.LONG, rules.SHORT):
            plan = runner.leg_plan(m, trades, side)
            legs.append(runner.book_leg({"name": "test", "plan": plan,
                                         "profile": runner.profile_of(costs, False, "test")}))
        return trades, legs

    def test_nautilus_books_the_same_trades_and_net_result(self) -> None:
        costs = rules.Costs(per_unit=0.1, rate=1e-4)
        trades, legs = self.book(costs)
        self.assertEqual([(t.side, t.reason) for t in trades],
                         [(rules.LONG, "stop"), (rules.LONG, "opposite"), (rules.SHORT, "stop")])
        booked = sorted((t for leg in legs for t in leg["trades"]), key=lambda t: t["entryMs"])
        self.assertEqual(len(booked), len(trades))  # the trade count
        for ours, theirs in zip(trades, booked):
            self.assertEqual((ours.entry_ms, ours.exit_ms), (theirs["entryMs"], theirs["exitMs"]))
            self.assertAlmostEqual(theirs["entry"], ours.entry, places=9)
            self.assertAlmostEqual(theirs["exit"], ours.exit, places=9)
            self.assertEqual(theirs["reason"], ours.reason)
            self.assertAlmostEqual(theirs["rNet"], ours.r_net, places=4)
            self.assertAlmostEqual(theirs["rGross"], ours.r_gross, places=4)
            # 0.5 % of equity at the stop: the P&L is R x 0.5 % of the equity before the trade (the engine
            # keeps the entry cost inside the spend, so the size is a little under the full risk).
            self.assertAlmostEqual(theirs["pnl"] / theirs["before"], ours.r_net * 0.005, places=4)
        self.assertAlmostEqual(sum(t["rNet"] for t in booked), sum(t.r_net for t in trades), places=4)  # the net result
        self.assertLess(max(leg["maxRDiff"] for leg in legs), 1e-4)
        # The gap fills at the open beyond the stop: a loss of more than 1R.
        self.assertLess(trades[-1].r_gross, -1.0)

    def test_costs_do_not_change_the_trades(self) -> None:
        free, _ = self.book(rules.Costs())
        costly, legs = self.book(rules.Costs(per_unit=0.5))
        self.assertEqual([(t.entry_index, t.exit_index, t.exit) for t in free],
                         [(t.entry_index, t.exit_index, t.exit) for t in costly])
        for ours, theirs in zip(costly, sorted((t for leg in legs for t in leg["trades"]), key=lambda t: t["entryMs"])):
            self.assertAlmostEqual(theirs["rGross"] - theirs["rNet"], 1.0 / 5, places=4)  # 2 x 0.5 over a 5-point stop
            self.assertAlmostEqual(ours.r_gross - ours.r_net, 1.0 / 5)

    def test_daily_equity_is_flat_between_trades(self) -> None:
        trades, legs = self.book(rules.Costs())
        m = self.tape().minutes()
        calendar = runner.calendar_of(m, *WEEK)
        self.assertEqual([rules.day_text(d) for d in calendar], ["2024-03-03", "2024-03-04"])
        booked = study.assemble(calendar, legs, len(m))
        self.assertEqual(booked["points"][0], ("2024-03-03", 1.0))
        expected = 1.0
        for leg in legs:
            expected += leg["dayEquity"][-1][1] - 1
        self.assertAlmostEqual(booked["points"][-1][1], expected, places=9)
        self.assertEqual([t["entryDate"] for t in booked["trades"]], ["2024-03-04"] * 3)
        self.assertGreater(booked["exposure"], 0.0)
        with self.assertRaises(runner.BookingMismatch):
            plan = runner.leg_plan(m, trades, rules.LONG)
            plan["trades"] = plan["trades"][:1]  # rules.py and Nautilus disagree on the count
            runner.book_leg({"name": "broken", "plan": plan, "profile": runner.profile_of(rules.Costs(), False, "x")})


@unittest.skipUnless(_nautilus_installed(), "NautilusTrader is not installed")
class NautilusFiveMinuteBookingTest(NautilusBookingTest):
    """The same booking checks on 5-minute bars (the IBKR ETF path)."""

    step = 5


def five_minute_bars(m: rules.Minutes) -> rules.Minutes:
    """Regular-session 5-minute bars of 1-minute bars (an IBKR-like file with real volume)."""
    cd = rules.build_candles(m, 5)
    keep = (cd.open_minute >= 570) & (cd.open_minute < 960)
    return rules.Minutes(cd.start[keep], cd.o[keep], cd.h[keep], cd.l[keep], cd.c[keep], cd.v[keep] * 1000)


def write_bars(path: Path, m: rules.Minutes) -> None:
    lines = ["timestamp,open,high,low,close,volume"]
    for i in range(len(m)):
        lines.append(f"{int(m.t[i])},{m.o[i]:.4f},{m.h[i]:.4f},{m.l[i]:.4f},{m.c[i]:.4f},{m.v[i]:.1f}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")


def synthetic_market(days: list[str], quiet_from: str, seed: int = 5, loud_at: int = 8 * 60 + 30) -> rules.Minutes:
    """Full-session 1-minute bars with a volume jump in the 15 minutes from `loud_at` (none from `quiet_from` on)."""
    rng = np.random.default_rng(seed)
    t, o, h, low, c, v = [], [], [], [], [], []
    price = 15_000.0
    for day in days:
        start = rules.ny_ms(day, 0)
        for minute in range(0, 16 * 60 + 30):
            drift = 0.6 if 8 * 60 + 30 <= minute < 10 * 60 else 0.0
            step = float(rng.normal(drift, 2.0))
            close = price + step
            t.append(start + minute * rules.MINUTE_MS)
            o.append(price)
            h.append(max(price, close) + abs(float(rng.normal(0, 0.5))))
            low.append(min(price, close) - abs(float(rng.normal(0, 0.5))))
            c.append(close)
            loud = day < quiet_from and minute in range(loud_at, loud_at + 15)
            v.append(8.0 if loud else 1.0)
            price = close
    return rules.Minutes(np.array(t, dtype=np.int64), *(np.array(x) for x in (o, h, low, c, v)))


@unittest.skipUnless(_nautilus_installed(), "NautilusTrader is not installed")
class StudyRunTest(unittest.TestCase):
    """The whole study on a small synthetic NAS100 series (inline workers, no options data)."""

    doc: dict
    detail: dict

    @classmethod
    def setUpClass(cls) -> None:
        days = [d.isoformat() for d in (date.fromordinal(n) for n in range(date(2024, 1, 8).toordinal(),
                                                                       date(2024, 3, 16).toordinal()))
                if d.weekday() < 5]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_market(root / "m1", "usatechidxusd", synthetic_market(days, "2024-03-04"), spread=1.0)
            # An IBKR-like SPY file (5-minute regular-hours bars with a volume jump at the open) and its quote sample.
            spy = five_minute_bars(synthetic_market(days, "2024-12-31", seed=11, loud_at=9 * 60 + 30))
            write_bars(root / "ibkr" / "SPY.csv.gz", spy)
            sample = rules.Minutes(spy.t[::40], spy.c[::40], spy.c[::40], spy.c[::40], spy.c[::40] + 1.5, spy.v[::40] * 0)
            write_bars(root / "ibkr" / "SPY-bidask.csv.gz", sample)
            windows = (("sourceIs", "Source in-sample", "2024-01-15", "2024-02-23"),
                       ("sourceOos", "Source out-of-sample (6 months)", "2024-02-26", "2024-03-01"),
                       ("after", "After the dashboard date", "2024-03-04", "2024-03-15"))
            cls.doc, cls.detail = study.run_study(
                "2026-11-09", root=str(root), twin_root=str(root / "twins"), workers=0, repo=REPO, controls=3,
                markets=["NAS100", "QQQ", "SPY"], start="2024-01-15", end="2024-03-15", windows=windows,
                ibkr_root=str(root / "ibkr"), ibkr_from="2024-01-08", log=lambda _: None)

    def test_document_fits_the_contract(self) -> None:
        doc = study.finite(self.doc)
        self.assertEqual(study.validate_document(doc), [])
        self.assertEqual((doc["kind"], doc["id"], doc["spec"]), ("strategy-backtest", "volume-spike-breakout",
                                                                 "docs/specs/strategies/volume-spike-breakout.md"))
        self.assertIn(doc["verdict"], ("edge", "no-edge", "needs-more-data"))
        self.assertEqual([form["key"] for form in doc["forms"]], ["underlying", "options"])
        self.assertLessEqual(len(doc["robustness"]), 20)
        self.assertEqual([row["pass"] is not None for row in doc["robustness"][:7]], [True] * 7)
        # 24 one-at-a-time rows, two cost rows and three information rows (two cost readings, the stop fill).
        self.assertEqual(len(doc["sensitivity"]), 29)
        self.assertEqual([row["value"] for row in doc["sensitivity"][24:]],
                         ["source costs", "doubled Vertex costs", "Vertex spread as fixed points",
                          "Vertex spread at the fill minutes", "half-way to the bar extreme"])
        self.assertEqual(doc["provenance"]["runId"], "volspike-2026-11-09")
        self.assertRegex(doc["provenance"]["commit"], r"^[0-9a-f]{7,40}$")
        self.assertTrue(doc["provenance"]["dataHash"].startswith("sha256:"))
        self.assertTrue((REPO / doc["spec"]).exists())
        json.dumps(doc, allow_nan=False)
        json.dumps(study.finite(self.detail), allow_nan=False)

    def test_the_verdict_is_the_rule_applied_to_the_gates(self) -> None:
        detail = self.detail
        self.assertEqual(len(detail["gates"]), 5)
        passed = sum(1 for gate in detail["gates"] if gate["pass"])
        self.assertEqual(passed, detail["gatesPassed"])
        expected = study.verdict_rule(
            oos_sharpe=detail["primary"]["summary"]["vertex"]["outOfSample"]["sharpe"],
            deflated_probability=detail["deflatedSharpe"]["n10000"]["probability"], gates_passed=passed, gates_total=5,
            reproduced=detail["claim"]["check"]["reproduced"],
            options_oos_sharpes=list(detail["optionsOosSharpe"].values()),
            trades=detail["primary"]["full"]["vertex"]["trades"])
        self.assertEqual(self.doc["verdict"], expected)
        self.assertEqual(detail["verdict"], expected)

    def test_trades_and_an_empty_window(self) -> None:
        primary = self.detail["primary"]
        self.assertGreater(primary["full"]["vertex"]["trades"], 5)
        # Every cost set has the same trades; only the net result differs.
        counts = {name: primary["full"][name]["trades"] for name in ("vertex", "source", "vertex2x")}
        self.assertEqual(len(set(counts.values())), 1)
        self.assertGreater(primary["full"]["source"]["r"]["meanR"], primary["full"]["vertex"]["r"]["meanR"])
        self.assertGreater(primary["full"]["vertex"]["r"]["meanR"], primary["full"]["vertex2x"]["r"]["meanR"])
        self.assertLess(primary["booking"]["maxRDiffNautilusVsRules"], 1e-3)
        after = primary["windows"][2]
        self.assertTrue(after["vertex"]["noTrades"])  # the volume jump stops on 2024-03-04
        self.assertEqual(after["vertex"]["r"]["trades"], 0)
        self.assertEqual(primary["weeklyR"]["vertex"]["after"], [])
        rows = {row["symbol"]: row for row in self.doc["forms"][0]["runs"]}
        self.assertEqual(rows["NAS100 After the dashboard date"]["trades"], 0)
        self.assertIn("no trades", rows["NAS100 After the dashboard date"]["market"])
        text = {row["check"]: row["result"] for row in self.doc["robustness"]}
        self.assertIn("no trades", text["After the dashboard date (2024-03-04 to 2024-03-15)"])
        volume = self.detail["data"]["volume"]["NAS100"]
        self.assertEqual((volume["lastSessionSpike"], volume["sessionDaysAfterLastSessionSpike"]), ("2024-03-01", 10))
        self.assertIn("2024-03-01", text["Data finding: Dukascopy tick volume regime"])
        self.assertEqual(self.detail["data"]["missingMarkets"], ["QQQ", "SPY"])  # no Dukascopy files for them
        self.assertEqual(self.detail["data"]["missingMonths"], {})
        self.assertIn("sha256", self.detail["data"]["hashNote"])
        self.assertEqual(len(self.detail["data"]["ibkr"]["SPY"]["file"]["sha256OfBarsUsed"]), 64)
        self.assertEqual(self.doc["forms"][1]["runs"][0]["market"], "no priced spreads")

    def test_etf_twins_are_ibkr_results_or_a_status_row(self) -> None:
        twins = {row["market"]: row for row in self.detail["etfTwins"]}
        self.assertEqual(list(twins), ["SPY", "QQQ"])
        spy, qqq = twins["SPY"], twins["QQQ"]
        self.assertEqual((spy["status"], spy["reason"], spy["data"]), ("tested-ibkr", None, "IBKR 5-minute, exchange volume"))
        self.assertIsNone(spy["dukascopyTrades"])  # no Dukascopy SPY file in this test
        self.assertTrue(spy["spreadOrigin"].startswith("IBKR BID_ASK sample"))
        self.assertAlmostEqual(spy["spreadBps"], 1.0, delta=0.1)  # 1.5 on about 15,000
        for key in ("trades", "winRate", "meanR", "meanRSourceCosts", "totalR", "maxDrawdownR", "sharpe", "oosSharpe",
                    "sessionSpikesByYear", "spikeTimes", "bars", "file"):
            self.assertIn(key, spy)
        self.assertGreater(spy["trades"], 0)
        self.assertLess(spy["maxRDiff"], 1e-3)  # booked in Nautilus, the same trades as rules.py
        self.assertEqual(spy["sessionSpikesByYear"][0]["year"], 2024)
        self.assertGreater(spy["sessionSpikesByYear"][0]["sessionSpikes"], 10)
        self.assertEqual(max(spy["spikeTimes"], key=lambda r: r["spikes"])["time"], "09:30")
        # The stop-fill information row of the ETF: the same fields as the NAS100 one, on 5-minute bars.
        fill = spy["stopFill"]
        self.assertEqual(set(fill), set(self.detail["stopFill"]))
        self.assertEqual((fill["fraction"], fill["bar"], fill["trades"]), (0.5, "5-minute", spy["trades"]))
        self.assertEqual(self.detail["stopFill"]["bar"], "1-minute")
        self.assertLessEqual(fill["meanR"], spy["meanR"] + 1e-9)  # worse fills never help
        self.assertGreaterEqual(fill["meanExtraLossPerStopR"], 0.0)
        self.assertAlmostEqual(fill["nautilusModelSharpe"], spy["sharpe"], places=6)
        self.assertEqual((qqq["status"], qqq["reason"], qqq["dukascopyTrades"]), ("not-testable", data.ETF_PENDING, None))
        self.assertNotIn("stopFill", qqq)
        self.assertNotIn("sharpe", qqq)
        runs = {row["symbol"]: row for row in self.doc["forms"][0]["runs"]}
        self.assertIn("(b) SPY IBKR 5-minute", runs)
        self.assertEqual(runs["(b) SPY IBKR 5-minute"]["market"], "SPY ETF, IBKR 5-minute, exchange volume, percent stop")
        self.assertEqual(runs["(b) SPY IBKR 5-minute"]["trades"], spy["trades"])
        self.assertFalse([symbol for symbol in runs if "QQQ" in symbol or "ETF twin" in symbol])
        text = {row["check"]: row["result"] for row in self.doc["robustness"]}
        twins_text = text["Form (b) ETF twins: IBKR 5-minute bars, exchange volume"]
        self.assertIn("SPY", twins_text)
        self.assertIn("exact stop fill / half-way", twins_text)
        self.assertIn("SPY (IBKR), stops exactly at the level on 5-minute bars", self.doc["notes"])
        self.assertIn("same-method Sharpe", self.doc["notes"])
        self.assertIn("Not testable on this data", twins_text)
        self.assertIn("QQQ", twins_text.split("Not testable")[1])
        # The ETF rows do not enter the gates: they are all on the NAS100 primary.
        self.assertEqual(self.detail["primary"]["market"], "NAS100")
        self.assertEqual(self.detail["data"]["ibkr"]["SPY"]["status"], "tested-ibkr")

    def test_robustness_rows_are_never_dropped_silently(self) -> None:
        self.assertEqual(len(study.robustness_of(self.detail)), 20)
        crowded = dict(self.detail)
        crowded["primary"] = {**self.detail["primary"],
                              "windows": [*self.detail["primary"]["windows"], self.detail["primary"]["windows"][0]]}
        with self.assertRaises(ValueError):
            study.robustness_of(crowded)

    def test_report_data_has_what_the_report_needs(self) -> None:
        detail = self.detail
        for key in ("verdict", "gates", "primary", "claim", "sensitivity", "costs", "walkForward", "monteCarlo",
                    "randomControl", "deflatedSharpe", "markets", "options", "dsl", "buyHold", "data", "provenance"):
            self.assertIn(key, detail)
        self.assertEqual(len(detail["sensitivity"]), 24)
        self.assertEqual([row["costs"] for row in detail["costs"]], ["vertex", "source", "vertex2x"])
        self.assertAlmostEqual(detail["costs"][1]["roundTripR"], 0.084)
        fixed, fills = detail["costsInfo"]["fixedPointsSpread"], detail["costsInfo"]["fillMinuteSpread"]
        self.assertAlmostEqual(fixed["perUnitPerSide"], 0.5, places=3)  # half of the 1.0 point spread written above
        self.assertEqual(fills["perUnitPerSide"], 0.0)
        for row in (fixed, fills):
            self.assertEqual(row["trades"], detail["primary"]["full"]["vertex"]["trades"])  # the same trades
            self.assertEqual(len(row["windows"]), 3)
            self.assertNotIn("run", row)
            for key in ("sharpe", "oosSharpe", "meanR", "deflatedN10000", "stressSharpe"):
                self.assertIn(key, row)
        self.assertTrue(detail["costsInfo"]["spreadByYear"])
        # The gates show the information values in their text and nothing else changes.
        gates = {gate["name"]: gate["result"] for gate in detail["gates"]}
        self.assertIn("information, not the gate", gates["Out-of-sample Sharpe (last 40 % of the time)"])
        self.assertIn("the fill-minute spread", gates["Doubled Vertex costs"])
        fill = detail["stopFill"]
        self.assertEqual((fill["fraction"], fill["trades"]), (0.5, detail["primary"]["full"]["vertex"]["trades"]))
        self.assertLess(fill["meanR"], detail["primary"]["booking"]["rulesR"]["vertex"]["meanR"])  # worse fills
        self.assertLess(fill["meanExtraLossPerStopR"], 0.5)
        self.assertGreaterEqual(fill["meanExtraLossPerStopR"], 0.0)
        self.assertNotIn("dated", fill)
        self.assertIn("gross", detail["randomControl"])
        self.assertEqual(detail["randomControl"]["runsShort"], 0)
        self.assertEqual(len(detail["claim"]["rows"]), 16)
        self.assertEqual(detail["randomControl"]["runs"], 3)
        self.assertEqual(len(detail["randomControl"]["runsDetail"]), 3)
        deflated = detail["deflatedSharpe"]
        self.assertEqual((deflated["n10000"]["trials"], deflated["n10500"]["trials"]), (10_000, 10_500))
        self.assertEqual(deflated["own"]["trials"], len(deflated["configurations"]))
        self.assertGreaterEqual(deflated["own"]["probability"], deflated["n10000"]["probability"])
        self.assertEqual(set(deflated["claim"]), {"ownVarianceN10000", "ownVarianceN10500", "nullVarianceN10000",
                                                  "nullVarianceN10500"})
        self.assertIn("weeklyR", detail["primary"])
        self.assertTrue(detail["primary"]["byYear"])
        self.assertEqual(detail["data"]["medianCloseByYear"][0]["year"], 2024)
        self.assertIn("allBars", detail["data"]["spreads"]["NAS100"])
        self.assertIn("atFillMinutes", detail["data"]["spreads"]["NAS100"])
        self.assertTrue(detail["data"]["spikeTimes"]["NAS100"])
        self.assertEqual(detail["dsl"]["timeframe"], "15m")


class DocumentContractTest(unittest.TestCase):
    def test_text_fits_the_contract_limits(self) -> None:
        self.assertLessEqual(len(source.RULES), 30)
        self.assertLessEqual(len(source.GAPS), 30)
        for rule in source.RULES:
            self.assertEqual(set(rule), {"item", "rule", "source"})
            self.assertLessEqual(len(rule["item"]), 60)
            self.assertLessEqual(len(rule["rule"]), 400)
            self.assertLessEqual(len(rule["source"]), 200)
        for gap in source.GAPS:
            self.assertLessEqual(len(gap["gap"]), 300)
            self.assertLessEqual(len(gap["choice"]), 400)
        self.assertTrue(source.SOURCE_URL.startswith("https://"))
        self.assertLessEqual(len(source.SOURCE_LABEL), 200)
        self.assertLessEqual(len(study.TITLE), 200)

    def minimal(self) -> dict:
        run = {"symbol": "NAS100", "market": "Nasdaq-100 CFD", "from": "2019-01-02", "to": "2026-11-06", "trades": 750,
               "cagr": 0.01, "sharpe": 0.2, "maxDrawdown": -0.2, "profitFactor": 1.1, "winRate": 0.15, "exposure": 0.1,
               "oosSharpe": None, "oosCagr": None, "buyHoldCagr": 0.1, "buyHoldSharpe": 0.8}
        return {
            "kind": "strategy-backtest", "id": study.SLUG, "title": study.TITLE, "ran": "2026-11-09",
            "spec": study.SPEC_PATH, "source": {"url": source.SOURCE_URL, "label": source.SOURCE_LABEL},
            "verdict": "no-edge", "verdictReason": "reason", "rules": source.RULES, "gaps": source.GAPS,
            "forms": [{"key": "underlying", "label": "As stated", "description": "d", "runs": [run]}],
            "robustness": [{"check": "c", "result": "r", "pass": None}],
            "sensitivity": [{"param": "k", "value": "3", "sharpe": 0.1, "cagr": 0.0, "maxDrawdown": -0.1, "trades": 5}],
            "comparison": [{"name": "Buy and hold", "kind": "buy-and-hold", "sharpe": 0.8, "cagr": 0.1,
                            "maxDrawdown": -0.3}],
            "equity": [{"month": "2019-01", "value": 0.0, "drawdown": 0.0},
                       {"month": "2019-02", "value": 0.01, "drawdown": -0.01}],
            "equityLabel": "label", "provenance": {"commit": "93f4cc93", "engine": "nautilus-trader-1.227.0",
                                                   "dataHash": "sha256:" + "0" * 64, "runId": "volspike-2026-11-09"},
            "notes": "",
        }

    def test_validator_accepts_a_document_and_names_each_broken_limit(self) -> None:
        self.assertEqual(study.validate_document(self.minimal()), [])

        def broken(change) -> list[str]:
            doc = json.loads(json.dumps(self.minimal()))
            change(doc)
            return study.validate_document(doc)

        self.assertTrue(broken(lambda d: d.update(title="x" * 201)))
        self.assertTrue(broken(lambda d: d.update(verdict="pass")))
        self.assertTrue(broken(lambda d: d.update(verdictReason="x" * 1001)))
        self.assertTrue(broken(lambda d: d.update(notes="x" * 4001)))
        self.assertTrue(broken(lambda d: d.update(id="other")))
        self.assertTrue(broken(lambda d: d.update(extra=1)))
        self.assertTrue(broken(lambda d: d["forms"][0]["runs"][0].update(symbol="x" * 41)))
        self.assertTrue(broken(lambda d: d["forms"][0]["runs"][0].update(market=" padded")))
        self.assertTrue(broken(lambda d: d["forms"][0]["runs"][0].update(maxDrawdown=0.1)))
        self.assertTrue(broken(lambda d: d["forms"][0]["runs"][0].update(cagr=-1.5)))
        self.assertTrue(broken(lambda d: d["forms"][0]["runs"][0].update(sharpe=float("nan"))))
        self.assertTrue(broken(lambda d: d["forms"][0]["runs"][0].update(to="2018-01-01")))
        self.assertTrue(broken(lambda d: d["forms"][0].update(runs=[d["forms"][0]["runs"][0]] * 81)))
        self.assertTrue(broken(lambda d: d["forms"].append(dict(d["forms"][0]))))  # the same key twice
        self.assertTrue(broken(lambda d: d["forms"][0].update(key="futures")))
        self.assertTrue(broken(lambda d: d.update(robustness=[d["robustness"][0]] * 21)))
        self.assertTrue(broken(lambda d: d["robustness"][0].update(result="x" * 301)))
        self.assertTrue(broken(lambda d: d.update(sensitivity=[d["sensitivity"][0]] * 81)))
        self.assertTrue(broken(lambda d: d["sensitivity"][0].update(value="x" * 41)))
        self.assertTrue(broken(lambda d: d.update(comparison=[d["comparison"][0]] * 31)))
        self.assertTrue(broken(lambda d: d["comparison"][0].update(name="x" * 81)))
        self.assertTrue(broken(lambda d: d.update(equity=d["equity"][:1])))
        self.assertTrue(broken(lambda d: d.update(equity=d["equity"][::-1])))
        self.assertTrue(broken(lambda d: d["provenance"].update(commit="<commit>")))
        self.assertTrue(broken(lambda d: d["provenance"].update(dataHash="x" * 81)))
        self.assertTrue(broken(lambda d: d["source"].update(url="http://example.com")))
        self.assertTrue(broken(lambda d: d.update(rules=[])))
        self.assertTrue(broken(lambda d: d["rules"][0].update(rule="x" * 401)))
        self.assertTrue(broken(lambda d: d["gaps"][0].update(choice="x" * 401)))

    def test_finite_replaces_bad_numbers(self) -> None:
        cleaned = study.finite({"a": float("nan"), "b": [float("inf"), 1.5], "c": np.float64(2.0), "d": np.int64(3)})
        self.assertEqual(cleaned, {"a": 0.0, "b": [0.0, 1.5], "c": 2.0, "d": 3})

    def test_claim_table_marks_the_three_checked_rows(self) -> None:
        part = {"r": mx.r_stats([-1.0, 9.0, -1.0]), "grossR": 2.4}
        view = {"sourceIs": part, "sourceOos": part,
                "sourceIsBreakdown": study.breakdown([], "2019-01-01", "2026-03-11")}
        rows = study.claim_table(view, view, mx.replication_check(3, 1 / 3, 7 / 3))
        self.assertEqual(len(rows), 16)
        self.assertEqual([row["metric"] for row in rows if row["pass"] is not None],
                         ["Trades (source in-sample window)", "Win rate", "Net R per trade"])
        self.assertEqual([row["pass"] for row in rows[:2]], [False, False])
        self.assertEqual(rows[0]["claim"], 657)


class EtfTwinStatusTest(unittest.TestCase):
    def test_status_list(self) -> None:
        ibkr = {"SPY": {"status": data.ETF_TESTED}, "DIA": {"status": data.ETF_UNTESTED, "reason": data.ETF_PENDING},
                "GLD": {"status": data.ETF_UNTESTED, "reason": data.ETF_NOT_TESTABLE}}
        rows = study.etf_twin_rows(["SPY", "DIA", "GLD", "USO"], ibkr, {"SPY": 3, "DIA": 28, "GLD": 161},
                                   {"SPY": {"trades": 400, "meanR": 0.1, "sharpe": 0.2}})
        self.assertEqual([(r["market"], r["status"]) for r in rows],
                         [("SPY", "tested-ibkr"), ("DIA", "not-testable"), ("GLD", "not-testable"),
                          ("USO", "not-testable")])
        spy, dia, gld, uso = rows
        self.assertEqual((spy["reason"], spy["data"], spy["dukascopyTrades"], spy["trades"]),
                         (None, "IBKR 5-minute, exchange volume", 3, 400))
        # A twin that is not testable carries the reason and the Dukascopy trade count, never a result.
        self.assertIn("pending", dia["reason"])
        self.assertEqual(dia["dukascopyTrades"], 28)
        self.assertIn("regular-hours tick volume only", gld["reason"])
        self.assertEqual((uso["reason"], uso["dukascopyTrades"]), (data.ETF_NOT_TESTABLE, None))
        for row in (dia, gld, uso):
            self.assertEqual(set(row), {"market", "status", "reason", "data", "dukascopyTrades"})
            self.assertIsNone(row["data"])


class CommandTest(unittest.TestCase):
    def test_memory_floor_and_worker_limit(self) -> None:
        import argparse

        from strategies.volspike import __main__ as cli

        with tempfile.TemporaryDirectory() as tmp:
            info = Path(tmp) / "meminfo"
            info.write_text("MemTotal:       65000000 kB\nMemAvailable:   16777216 kB\n")
            self.assertAlmostEqual(cli.available_gb(str(info)), 16.0)
            self.assertIsNone(cli.available_gb(str(Path(tmp) / "missing")))
        self.assertEqual(cli.workers_of("4"), 4)
        for bad in ("0", "5", "20"):
            with self.assertRaises(argparse.ArgumentTypeError):
                cli.workers_of(bad)
        self.assertEqual(cli.MAX_WORKERS, 4)
        self.assertNotIn("Github", str(cli.DEFAULT_OUT))  # outside the repository


if __name__ == "__main__":
    unittest.main()
