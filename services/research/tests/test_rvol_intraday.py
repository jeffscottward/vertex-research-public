"""RVOL intraday filter test kernel: session cleaning, 5-minute bars, trades, ranks and the verdict."""
from __future__ import annotations

import math
from datetime import date, timedelta

import pytest

from strategies.rvol_intraday import (
    Bar,
    Day,
    Session,
    complete_sessions,
    daily_returns,
    decision_rvol,
    evaluate,
    five_minute,
    ranks,
    session_days,
    spearman,
)


def minute_rows(day: str, last: int = 389, skip: int | None = None, price=lambda m: 100.0, volume=lambda m: 10.0):
    """Mountain-time rows (09:30 ET = 07:30 MT) for minutes 0..last."""
    rows = []
    for m in range(last + 1):
        if m == skip:
            continue
        total = 7 * 60 + 30 + m
        p = price(m)
        rows.append({"date": f"{day} {total // 60:02d}:{total % 60:02d}:00", "open": str(p), "high": str(p + 1),
                     "low": str(p - 1), "close": str(p), "volume": str(volume(m))})
    return rows


def test_complete_sessions_keeps_full_and_half_days_and_drops_gaps():
    rows = minute_rows("2020-01-02") + minute_rows("2020-01-03", last=209) + minute_rows("2020-01-06", skip=7)
    rows += minute_rows("2020-01-07", last=300)
    rows.append({"date": "2020-01-02 07:29:00", "open": "1", "high": "1", "low": "1", "close": "1", "volume": "1"})
    rows.append(dict(rows[0]))  # duplicate minute: the first row wins
    kept, dropped = complete_sessions(rows)
    assert [day for day, _ in kept] == ["2020-01-02", "2020-01-03"]
    assert dropped == ["2020-01-06", "2020-01-07"]
    assert len(kept[0][1]) == 390


def test_five_minute_aggregation():
    kept, _ = complete_sessions(minute_rows("2020-01-02", price=lambda m: 100.0 + m, volume=lambda m: m))
    session = five_minute(*kept[0])
    assert len(session.bars) == 78
    first = session.bars[0]
    assert first == Bar(0, 100.0, 105.0, 99.0, 104.0, 0 + 1 + 2 + 3 + 4)
    assert session.bars[-1].minute == 385


def make_session(day: str, open_: float, close_0955: float, open_1000: float, last_close: float, volume: float):
    bars = [Bar(m * 5, 100.0, 101.0, 99.0, 100.0, volume) for m in range(78)]
    bars[0] = Bar(0, open_, open_, open_, open_, volume)
    bars[5] = Bar(25, close_0955, close_0955, close_0955, close_0955, volume)
    bars[6] = Bar(30, open_1000, open_1000, open_1000, open_1000, volume)
    bars[-1] = Bar(385, last_close, last_close, last_close, last_close, volume)
    return Session(day, tuple(bars))


def test_session_days_direction_move_and_rvol():
    start = date(2020, 1, 1)
    sessions = [make_session((start + timedelta(days=i)).isoformat(), 100, 100, 100, 100, 1.0) for i in range(20)]
    sessions.append(make_session("2020-02-01", 100, 101, 101, 103, 2.0))
    sessions.append(make_session("2020-02-02", 100, 99, 99, 98, 1.0))
    sessions.append(make_session("2020-02-03", 100, 100, 100, 100, 1.0))
    days = session_days(sessions)
    assert all(day.rvol is None for day in days[:20])
    assert days[20].side == 1 and math.isclose(days[20].move, 103 / 101 - 1) and math.isclose(days[20].rvol, 2.0)
    assert days[21].side == -1 and math.isclose(days[21].move, 98 / 99 - 1)
    assert days[22].side == 0
    assert decision_rvol([]) == []


def test_daily_returns_apply_filter_and_costs():
    days = [Day("a", 1, 0.01, 1.5), Day("b", -1, 0.02, 0.5), Day("c", 1, 0.01, None), Day("d", 0, 0.01, 2.0)]
    returns, traded = daily_returns(days, filtered=False, cost=0.001)
    assert traded == [True, True, True, False]
    assert returns == pytest.approx([0.008, -0.022, 0.008, 0.0])
    returns, traded = daily_returns(days, filtered=True, cost=0.001)
    assert traded == [True, False, False, False] and returns == pytest.approx([0.008, 0, 0, 0])


def test_ranks_and_spearman():
    assert ranks([3.0, 1.0, 2.0, 1.0]) == [4.0, 1.5, 3.0, 1.5]
    assert spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)
    assert spearman([1, 2], [1, 2]) is None
    assert spearman([1, 1, 1], [1, 2, 3]) is None


def test_evaluate_reports_both_costs_and_verdicts():
    days = [Day(f"d{i:03d}", 1 if i % 3 else -1, 0.004 * (1 if i % 2 else -1), 0.5 + (i % 4) / 2) for i in range(300)]
    days = [Day("w", 1, 0.0, None)] + days
    result = evaluate(days)
    assert result["sessions"] == 300 and result["firstSession"] == "d000" and result["secondHalfStart"] == "d150"
    for block in ("primary1bp", "sensitivity5bp"):
        assert set(result[block]) == {"none", "rvol_above_1", "verdict"}
        assert result[block]["verdict"].startswith(("KEEP", "DROP"))
        assert result[block]["none"]["full"]["trades"] == 300
    assert set(result["spearmanRvolVsAbsMove"]) == {"full", "firstHalf", "secondHalf"}
    # Few filtered trades fall under the trade floor.
    sparse = [Day(f"s{i}", 1, 0.001, 2.0 if i == 0 else 0.5) for i in range(260)]
    assert evaluate(sparse)["primary1bp"]["verdict"] == "DROP (trade floor)"
    # A filter that removes only losing days is better in both halves.
    good = [Day(f"g{i:03d}", 1, 0.01 if i % 2 else -0.01, 2.0 if i % 2 else 0.5) for i in range(300)]
    good = [Day(d.day, d.side, d.move + (0.001 * (i % 5)), d.rvol) for i, d in enumerate(good)]
    assert evaluate(good)["primary1bp"]["verdict"] == "KEEP"
