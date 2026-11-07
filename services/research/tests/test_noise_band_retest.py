"""Tests for the noise-band re-test helpers: 5-minute bars, IB month files, windows and the pre-set rule."""
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import csv

from strategies.noise_band import Bar, BacktestResult, DayResult, Params, Session, Trade, is_check_minute, run_backtest
from strategies.noise_band_retest import (
    ET,
    calendar_check,
    evaluate,
    load_ib_sessions,
    splice,
    to_five_minute,
)

NO_COST = dict(commission_per_share=0.0, slippage_bps=0.0)


def trend_session(day: date, move: float, n: int = 390, price: float = 100.0) -> Session:
    bars, prev = [], price
    for k in range(n):
        c = price * (1.0 + move * (k + 1) / n)
        bars.append(Bar(k, prev, max(prev, c), min(prev, c), c, 1000.0))
        prev = c
    return Session(day, tuple(bars))


def sessions(n: int) -> list[Session]:
    start = date(2020, 1, 1)
    return [trend_session(start + timedelta(days=i), 0.01 if i % 2 == 0 else -0.01) for i in range(n)]


def test_check_minute_five_minute_bars():
    # 5-minute bar starting 09:55 (minute 25) ends 10:00; 10:25 (55) ends 10:30; 10:05 (35) does not.
    assert is_check_minute(25, 30, 5)
    assert is_check_minute(55, 30, 5)
    assert not is_check_minute(35, 30, 5)
    assert not is_check_minute(0, 30, 5)
    # default stays 1-minute
    assert is_check_minute(29, 30) and not is_check_minute(25, 30)


def test_to_five_minute_ohlcv():
    s = trend_session(date(2021, 1, 4), 0.02)
    five = to_five_minute([s])[0]
    assert len(five.bars) == 78
    b = five.bars[1]
    src = s.bars[5:10]
    assert b.minute == 5
    assert b.open == src[0].open and b.close == src[-1].close
    assert b.high == max(x.high for x in src) and b.low == min(x.low for x in src)
    assert b.volume == sum(x.volume for x in src)
    assert five.bars[-1].close == s.bars[-1].close


def test_five_minute_run_matches_one_minute_on_linear_days():
    """On linear trend days VWAP never binds, so the 5-minute run trades exactly like the 1-minute run."""
    ss = sessions(16) + [trend_session(date(2020, 2, 1), 0.03)]
    r1 = run_backtest(ss, Params(**NO_COST))
    r5 = run_backtest(to_five_minute(ss), Params(bar_minutes=5, **NO_COST))
    assert r1.trades and len(r1.trades) == len(r5.trades)
    for a, b in zip(r1.trades, r5.trades):
        assert (a.day, a.side, a.entry_minute, a.exit_minute, a.exit_reason) == (b.day, b.side, b.entry_minute, b.exit_minute, b.exit_reason)
        assert abs(a.entry_price - b.entry_price) < 1e-9 and abs(a.exit_price - b.exit_price) < 1e-9
    for t in r5.trades:
        assert t.entry_minute % 30 == 0


def write_month(path, day: date, minutes, price=100.0):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        for m in minutes:
            et = datetime(day.year, day.month, day.day, 9, 30, tzinfo=ET) + timedelta(minutes=m)
            w.writerow([int(et.astimezone(timezone.utc).timestamp()), price, price + 1, price - 1, price + 0.5, 100])


def test_load_ib_sessions_dst_dedupe_and_incomplete(tmp_path):
    full = list(range(0, 390, 5))
    write_month(tmp_path / "2021-03.csv", date(2021, 3, 12), full)  # EST
    write_month(tmp_path / "2021-04.csv", date(2021, 3, 15), full)  # EDT, first day after the switch
    write_month(tmp_path / "2021-05.csv", date(2021, 3, 15), full)  # overlapping month repeats the day
    write_month(tmp_path / "2021-06.csv", date(2021, 3, 16), full[:-3])  # incomplete
    write_month(tmp_path / "2021-07.csv", date(2021, 11, 26), list(range(0, 210, 5)))  # half-day, 13:00 close
    ss, info = load_ib_sessions(str(tmp_path), {date(2021, 3, 15): 0.5})
    assert [s.day for s in ss] == [date(2021, 3, 12), date(2021, 3, 15), date(2021, 11, 26)]
    assert all(len(s.bars) == 78 for s in ss[:2]) and len(ss[2].bars) == 42
    assert ss[1].bars[0].minute == 0 and ss[1].bars[-1].minute == 385
    assert ss[1].dividend == 0.5 and info["dividends_applied"] == 1
    assert info["half_day_sessions"] == 1
    assert len(info["sessions_dropped_incomplete"]) == 1


def result_with(rets_first, rets_second, n_trades):
    p = Params()
    days, aum = [], 100.0
    start = date(2020, 1, 1)
    for i, r in enumerate(rets_first + rets_second):
        days.append(DayResult(start + timedelta(days=i), aum, aum * (1 + r), 1.0, True))
        aum *= 1 + r
    trades = [Trade(days[i % len(days)].day, 1, 1, 30, 1.0, 60, 1.0, "stop", 0.0, 0.0) for i in range(n_trades)]
    return BacktestResult(p, days, trades)


def test_evaluate_rule_and_window():
    good = [0.002, -0.001] * 100
    bad = [0.001, -0.0012] * 100
    assert evaluate(result_with(good, good, 400))["verdict"] == "pass"
    assert evaluate(result_with(good, bad, 400))["verdict"] == "fail"
    assert evaluate(result_with(good, good, 100))["verdict"] == "inconclusive"
    res = result_with(bad, good, 400)
    w = evaluate(res, start=date(2020, 1, 1) + timedelta(days=200))
    assert w["from"] == (date(2020, 1, 1) + timedelta(days=200)).isoformat()
    assert w["full"]["days"] == 200


def test_calendar_check_and_splice():
    a = [trend_session(date(2021, 1, d), 0.01) for d in (4, 5, 6)]
    b = [trend_session(date(2021, 1, d), 0.01) for d in (6, 7)]
    sp = splice(a, b)
    assert [s.day for s in sp] == [date(2021, 1, 4), date(2021, 1, 5), date(2021, 1, 6), date(2021, 1, 7)]
    assert sp[2] is b[0]
    closes = {date(2021, 1, d): sp[0].bars[-1].close for d in (4, 5, 6, 7, 8)}
    closes[date(2021, 1, 1)] = 1.0  # outside the bar range: ignored
    chk = calendar_check([s for s in sp if s.day != date(2021, 1, 5)], closes)
    assert chk["missing_sessions"] == ["2021-01-05"]
    assert chk["last_close_vs_yahoo_median_abs"] == 0.0
