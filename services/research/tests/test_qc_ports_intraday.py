"""qc-ports on intraday bars: bar keys, the book and the ledgers on bar times, bars from sessions (synthetic).

The book tests use the SPY market of test_qc_ports_book.py: no skew, no dividends, ATM IV 0.2 and r = 0.
"""
import dataclasses
import random
from datetime import date
from types import SimpleNamespace

import pytest

from strategies.qc_ports import book as bk
from strategies.qc_ports import forms as fm
from strategies.qc_ports import intraday as it
from strategies.qc_ports import options as om
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.calendar import SESSION_CLOSE, TradingCalendar, bar_time, day_left, is_bar_time, parse
from strategies.qc_ports.data import Bars, align
from strategies.qc_ports.ledger import run_ledger, timeline
from tests.qc_ports_synthetic import flat_model, intraday_market, market, trading_days

START = "2024-01-02"
DEBIT = {"structure": "callDebitVertical", "dte": {"target": 45, "min": 30}, "widthSigma": 0.5, "maxLossPct": 2}
HALF_DAY = 195  # minutes: two bars a session, closing at 12:45 and 16:00
EXPIRY = "2024-02-16"  # the monthly expiration of a spread opened in the first days of January 2024


def call(spot, strike, days):
    return om.bs_price("call", spot, strike, days / 365, 0, 0, 0.2)


@pytest.fixture(autouse=True)
def _flat(monkeypatch):
    flat_model(monkeypatch)


# --------------------------------------------------------------------------- bar keys

def test_a_bar_time_names_the_close_of_an_intraday_bar():
    assert bar_time("2024-03-15", 10 * 60 + 35) == "2024-03-15T10:35"
    assert bar_time(date(2024, 3, 15), SESSION_CLOSE) == "2024-03-15T16:00"
    assert is_bar_time("2024-03-15T10:35") and not is_bar_time("2024-03-15") and not is_bar_time(date(2024, 3, 15))
    for minutes in (-1, SESSION_CLOSE + 1, 10.5, True):
        with pytest.raises(ValueError, match="A bar closes"):
            bar_time("2024-03-15", minutes)


def test_parse_gives_the_day_of_a_day_key_and_of_a_bar_time():
    assert parse("2024-03-15") == parse("2024-03-15T10:35") == parse(date(2024, 3, 15)) == date(2024, 3, 15)
    assert TradingCalendar(["2024-03-14T16:00", "2024-03-15T09:35", "2024-03-15T16:00"]).last == date(2024, 3, 15)
    with pytest.raises(ValueError):
        parse("2024-03-15 10:35")


def test_day_left_is_the_part_of_the_day_until_the_close():
    assert day_left("2024-03-15") == day_left(date(2024, 3, 15)) == day_left("2024-03-15T16:00") == 0.0
    assert day_left("2024-03-15T10:00") == 0.25
    assert day_left("2024-03-15T12:45") == pytest.approx(195 / 1440)
    with pytest.raises(ValueError, match="after the 16:00 close"):
        day_left("2024-03-15T16:05")
    for text in ("2024-03-15T1x:00", "2024-03-15T10.00", "2024-03-15T10:75"):
        with pytest.raises(ValueError, match="Not a bar time"):
            day_left(text)


def test_bar_times_of_one_kind_sort_in_time_order():
    keys = [bar_time(day, close) for day in trading_days(START, 3) for close in (9 * 60 + 35, 12 * 60, SESSION_CLOSE)]
    assert sorted(keys) == keys


# --------------------------------------------------------------------------- the book on bar times

def _walk(seed: int, size: int, step: float = 0.01) -> list[float]:
    rng = random.Random(seed)
    closes = [100.0]
    for _ in range(size - 1):
        closes.append(closes[-1] * (1 + rng.gauss(0.0003, step)))
    return closes


def test_a_bar_that_closes_at_16_00_is_priced_like_the_daily_bar():
    closes = _walk(5, 45)
    daily = bk.build_book([("SPY", 0, None)], DEBIT, {"SPY": market(closes)}).trades[0]
    timed = bk.build_book([("SPY", 0, None)], DEBIT, {"SPY": intraday_market(closes, 390)}).trades[0]
    assert timed.entry_date == f"{daily.entry_date}T16:00" and timed.exit_date == f"{daily.exit_date}T16:00"
    assert [key for key, _ in timed.marks] == [f"{day}T16:00" for day, _ in daily.marks]
    same = dataclasses.replace(timed, entry_date=daily.entry_date, exit_date=daily.exit_date, marks=daily.marks)
    assert same == daily and [value for _, value in timed.marks] == [value for _, value in daily.marks]


def test_an_intraday_bar_of_the_expiry_day_still_has_time_value_and_the_spread_expires_at_16_00():
    made = intraday_market([100.0] * 90, HALF_DAY)
    trade = bk.build_book([("SPY", 0, None)], DEBIT, {"SPY": made}).trades[0]
    assert (trade.entry_date, trade.expiry) == ("2024-01-02T16:00", EXPIRY)
    assert (trade.exit_date, trade.exit_reason, trade.exit_price) == (f"{EXPIRY}T16:00", "expiry", 0.0)
    # At 12:45 of the expiry day 195 minutes are left: the at-the-money long call is not worth 0 yet.
    midday = round((call(100, trade.long_strike, 195 / 1440) - call(100, trade.short_strike, 195 / 1440)) * 100, 2)
    assert midday > 5
    assert trade.marks[-2] == (f"{EXPIRY}T12:45", midday)


def test_an_entry_on_an_intraday_bar_counts_the_rest_of_its_day():
    made = intraday_market([100.0] * 90, HALF_DAY)
    trade = bk.build_book([("SPY", 1, None)], DEBIT, {"SPY": made}).trades[0]
    assert trade.entry_date == "2024-01-03T12:45"
    days = (date.fromisoformat(EXPIRY) - date(2024, 1, 3)).days + 195 / 1440
    spec = bk.parse_options(DEBIT)
    strikes = bk.choose_strikes("call", "debit", 100.0, days / 365, 0.0, 0.0, 0.2, 0.0, spec)
    assert (trade.long_strike, trade.short_strike, trade.width) == strikes
    assert trade.entry_price == round((call(100, strikes[0], days) - call(100, strikes[1], days)) * 100, 2)


def test_exit_dte_is_reached_at_the_16_00_bar_of_its_day():
    made = intraday_market([100.0] * 90, HALF_DAY)
    trade = bk.build_book([("SPY", 0, None)], {**DEBIT, "exitDte": 3}, {"SPY": made}).trades[0]
    # Expiry is a Friday; 3 days before it is Tuesday. At 12:45 of that Tuesday 3 days and 195 minutes are left.
    assert (trade.exit_date, trade.exit_reason) == ("2024-02-13T16:00", "exitDte")


# --------------------------------------------------------------------------- the ledger on bar times

def test_the_run_days_are_all_days_or_all_bar_times():
    assert timeline([], ["2024-01-03T16:00", "2024-01-03T12:45"]) == ("2024-01-03T12:45", "2024-01-03T16:00")
    with pytest.raises(ValueError, match="all days or all bar times"):
        timeline([], ["2024-01-03", "2024-01-03T16:00"])


def _stance_trades(bars: int, seed: int, *, trim: bool = False, window_bars: int = 640):
    """(spreads of a random stance on bars of half a session, their market)."""
    rng = random.Random(seed)
    sides: list[int] = []
    while len(sides) < bars:
        sides.extend([rng.choice((1, 1, 0, -1))] * rng.randint(6, 180))
    sides = sides[:bars]
    made = intraday_market(_walk(seed, bars, 0.0085), HALF_DAY)
    form = fm.Form("t/x", "x", "X", "trend", ("SPY",), lambda inputs: {"SPY": list(sides)}, None, "Test form.")
    plain = Bars("SPY", made.dates, made.close, made.close, made.close, made.close, made.close)
    trades = fm.form_trades(form, fm.Inputs({"SPY": plain}, {"SPY": made.iv_index}), {"SPY": made}, start=START,
                            window_bars=window_bars, trim=trim)
    return trades, made


def test_the_ledger_runs_on_bar_times_and_daily_result_gives_the_closes():
    trades, made = _stance_trades(480, seed=11)
    result = run_ledger(trades, 100_000.0, dates=made.dates)
    assert result.dates == made.dates and len(result.trades) == len(trades) > 0
    by_day = it.daily_result(result)
    assert by_day.dates == trading_days(START, 240)
    assert by_day.equity == result.equity[1::2]
    assert by_day.open_positions == tuple(max(pair) for pair in zip(result.open_positions[::2], result.open_positions[1::2]))
    assert (by_day.trades, by_day.skipped, by_day.capital, by_day.engine) == (
        result.trades, result.skipped, result.capital, result.engine)


def test_max_open_risk_on_bar_times_is_the_value_of_the_portfolio_function():
    trades, made = _stance_trades(480, seed=11)
    result = run_ledger(trades, 100_000.0, dates=made.dates)
    assert it.max_open_risk(result, trades) == pf.max_open_risk(result, trades) > 0
    both, _ = _stance_trades(1400, seed=3)  # call and put spreads, some of them open on the same bars
    long_run = run_ledger(both, 100_000.0)
    assert it.max_open_risk(long_run, both) == pf.max_open_risk(long_run, both) > 0


# --------------------------------------------------------------------------- forms on bar times

def test_a_stance_on_an_intraday_bar_trades_at_the_close_of_the_next_bar():
    made = intraday_market([100.0] * 60, 30)
    sides = [0, 1, 1, 1, 0] + [0] * 55
    form = fm.Form("t/x", "x", "X", "trend", ("SPY",), lambda inputs: {"SPY": list(sides)}, None, "Test form.")
    plain = Bars("SPY", made.dates, made.close, made.close, made.close, made.close, made.close)
    trade, = fm.form_trades(form, fm.Inputs({"SPY": plain}, {"SPY": made.iv_index}), {"SPY": made}, start=START,
                            window_bars=fm.WINDOW_BARS * it.bars_per_day(30), trim=True)
    assert (trade.entry_date, trade.exit_date, trade.exit_reason) == ("2024-01-02T11:00", "2024-01-02T12:30", "signal")
    assert [key for key, _ in trade.marks] == list(made.dates[2:6])


def test_reading_the_bars_only_up_to_the_signal_exit_gives_the_same_trades():
    whole, _ = _stance_trades(1400, seed=3)
    trimmed, _ = _stance_trades(1400, seed=3, trim=True)
    assert trimmed == whole
    assert {trade.exit_reason for trade in whole} >= {"signal", "expiry", "ownerLoserCut"}
    assert {trade.structure for trade in whole} == {"callDebitVertical", "putDebitVertical"}


# --------------------------------------------------------------------------- bars from sessions

def _session(day: str, minutes, *, base: float = 100.0):
    """A session whose bar that starts `minute` after 09:30 opens at base + minute and closes 1 higher."""
    bars = [SimpleNamespace(minute=minute, open=base + minute, high=base + minute + 2, low=base + minute - 2,
                            close=base + minute + 1) for minute in minutes]
    return SimpleNamespace(day=date.fromisoformat(day), bars=bars)


def test_session_bars_joins_minute_bars_and_names_each_bar_by_its_close():
    full = _session("2024-01-02", range(0, 390, 5))
    bars = it.session_bars("SPY", [full], 5, 15)
    assert len(bars) == 26 and bars.dates[:2] == ("2024-01-02T09:45", "2024-01-02T10:00")
    assert bars.dates[-1] == "2024-01-02T16:00"
    assert (bars.open[0], bars.high[0], bars.low[0], bars.close[0]) == (100.0, 112.0, 98.0, 111.0)
    assert bars.adj_close == bars.close
    same = it.session_bars("SPY", [full], 5, 5)
    assert len(same) == 78 and same.dates[0] == "2024-01-02T09:35" and same.close[0] == 101.0


def test_the_last_bar_of_a_session_ends_with_the_session():
    full, half = _session("2024-07-02", range(0, 390, 5)), _session("2024-07-03", range(0, 210, 5))
    hourly = it.session_bars("SPY", [full, half], 5, 60)
    assert [key[11:] for key in hourly.dates[:7]] == ["10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:00"]
    assert [key[11:] for key in hourly.dates[7:]] == ["10:30", "11:30", "12:30", "13:00"]
    minutes = it.session_bars("SPY", [_session("2024-07-02", range(390))], 1, 1)
    assert (minutes.dates[0], minutes.dates[-1], len(minutes)) == ("2024-07-02T09:31", "2024-07-02T16:00", 390)
    assert (it.bars_per_day(1), it.bars_per_day(5), it.bars_per_day(30), it.bars_per_day(60)) == (390, 78, 13, 7)


def test_session_bars_refuses_bars_it_cannot_make():
    full = _session("2024-01-02", range(0, 390, 5))
    with pytest.raises(ValueError, match="cannot be made from"):
        it.session_bars("SPY", [full], 5, 12)
    with pytest.raises(ValueError, match="day order"):
        it.session_bars("SPY", [full, full], 5, 15)
    with pytest.raises(ValueError, match="out of order or off the grid"):
        it.session_bars("SPY", [_session("2024-01-02", (0, 5, 7))], 5, 15)
    with pytest.raises(ValueError, match="has no bar"):
        it.session_bars("SPY", [_session("2024-01-02", ())], 5, 15)
    with pytest.raises(ValueError, match="whole number of minutes"):
        it.bars_per_day(0)


# --------------------------------------------------------------------------- daily series on bar times

def test_known_at_gives_a_bar_the_last_value_before_its_day_and_the_last_bar_the_value_of_the_day():
    series = {"2024-01-02": 10.0, "2024-01-03": 20.0, "2024-01-04": 30.0}
    keys = ["2024-01-03T12:45", "2024-01-03T16:00", "2024-01-04T12:45", "2024-01-04T16:00"]
    assert it.known_at(series, keys) == [10.0, 20.0, 20.0, 30.0]
    # A day without bars: its value is known before the next day with bars.
    assert it.known_at(series, ["2024-01-02T16:00", "2024-01-04T12:45", "2024-01-04T16:00"]) == [10.0, 20.0, 30.0]
    # No value before the first day of the series.
    assert it.known_at(series, ["2024-01-02T12:45", "2024-01-02T16:00"]) == [None, 10.0]


def test_known_at_carries_a_value_for_the_days_align_carries_it():
    days = trading_days(START, 9)
    series = {days[0]: 15.0}
    keys = [bar_time(day, close) for day in days for close in (12 * 60 + 45, SESSION_CLOSE)]
    known = it.known_at(series, keys, max_fill=3)
    assert known[1::2] == align(series, days, 3) == [15.0] * 4 + [None] * 5
    assert known[0::2] == [None] + [15.0] * 4 + [None] * 4
    assert it.known_at(series, days, max_fill=3) == align(series, days, 3)


def test_intraday_market_is_the_book_view_of_intraday_bars():
    keys = ("2024-01-03T12:45", "2024-01-03T16:00")
    bars = Bars("SPY", keys, (1.0, 2.0), (1.0, 2.0), (1.0, 2.0), (470.0, 471.0), (470.0, 471.0))
    made = it.intraday_market(bars, {"2024-01-02": 13.0, "2024-01-03": 14.0}, {"2024-01-02": 5.0, "2024-01-03": 5.2})
    assert (made.symbol, made.dates, made.close) == ("SPY", keys, (470.0, 471.0))
    assert made.iv_index == (13.0, 14.0) and made.rate == pytest.approx((0.05, 0.052))
    assert it.day_of(keys[0]) == it.day_of("2024-01-03") == "2024-01-03"


def test_known_at_reads_the_last_value_before_a_weekend_and_a_holiday_on_the_bars_before_the_close():
    days = ["2024-01-12", "2024-01-16"]  # a Friday, then the Tuesday after Martin Luther King Jr. Day
    keys = [bar_time(day, close) for day in days for close in (12 * 60 + 45, SESSION_CLOSE)]
    known = it.known_at({"2024-01-11": 14.0, "2024-01-12": 15.0, "2024-01-16": 16.0}, keys)
    assert known == [14.0, 15.0, 15.0, 16.0]


def test_missing_expiries_names_the_expiry_days_without_a_session():
    days = [parse(day) for day in trading_days("2024-01-02", 60)]
    assert it.missing_expiries(days) == []
    assert it.missing_expiries(day for day in days if day != date(2024, 2, 16)) == [date(2024, 2, 16)]
    # March 2024: the 3rd Friday is the 15th; a run that ends before it has nothing missing.
    assert it.missing_expiries(day for day in days if day < date(2024, 3, 15)) == []
    assert it.missing_expiries([]) == []
