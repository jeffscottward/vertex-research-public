"""Tests for the session-open-momentum runner (strategies/noise_band_futures_run.py)."""
from datetime import date, datetime, timedelta, timezone

import pytest

from strategies import noise_band_futures_run as run
from strategies.noise_band import FuturesDay, FuturesParams, FuturesResult, Session


def utc(day: date, hour: int, minute: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc)


def rows(day: date, n: int = 78, start=(14, 30), price: float = 100.0, skip: int | None = None):
    for j in range(n):
        if j == skip:
            continue
        t = utc(day, *start) + timedelta(minutes=5 * j)
        yield t, price, price + 1, price - 1, price, 10.0


def test_sessions_keep_full_and_half_days_and_skip_gaps() -> None:
    d1, d2, d3, d4 = date(2020, 1, 2), date(2020, 1, 3), date(2020, 1, 6), date(2020, 11, 27)
    pre = [(utc(d1, 14, 0), 1.0, 1.0, 1.0, 1.0, 1.0)]  # 09:00 New York: dropped
    sessions, info = run._sessions([*pre, *rows(d1), *rows(d2, skip=10), *rows(d3), *rows(d4, n=42)])
    # d2 misses a bar; d3 follows it, so its previous close would be two days old.
    assert [s.day for s in sessions] == [d1, d4]
    assert [len(s.bars) for s in sessions] == [78, 42]
    assert sessions[0].bars[0].minute == 0 and sessions[0].bars[-1].minute == 385
    assert info["skipped_days"] == [d2.isoformat()]
    assert info["skipped_after"] == [d3.isoformat()]


def test_scales_use_the_previous_close_only() -> None:
    sessions = [Session(date(2020, 1, d), ()) for d in (2, 3, 6)]
    ndx = {date(2020, 1, 1): 400.0, date(2020, 1, 2): 410.0, date(2020, 1, 3): 999.0}
    qqq = {date(2020, 1, 1): 10.0, date(2020, 1, 2): 10.0, date(2020, 1, 3): 10.0}
    assert run.qqq_scales(sessions, ndx, qqq) == [40.0, 41.0, 99.9]


def test_bootstrap_is_seeded_and_brackets_the_mean() -> None:
    values = [float(i % 7 - 2) for i in range(300)]
    lo, hi = run.bootstrap_ci(values, resamples=2000)
    assert lo < sum(values) / len(values) < hi
    assert run.bootstrap_ci(values, resamples=2000) == (lo, hi)


def test_drawdown_summary_and_grades() -> None:
    assert run.max_drawdown_usd([10, -5, -10, 20, -30]) == 30
    days = [FuturesDay(date(2020, 1, 1) + timedelta(days=i), p, 1 if p else 0) for i, p in enumerate([10.0, 0.0, -4.0, 6.0])]
    res = FuturesResult(FuturesParams(), days, [])
    s = run.summarize(res, date(2020, 1, 1), date(2020, 12, 31), ci=False)
    assert s["sessions"] == 4 and s["usd_per_day"] == pytest.approx(3.0) and s["share_traded"] == 0.75
    assert s["trades_per_session"] == 0.0  # no trades in this result, only day totals
    assert s["max_drawdown"] == 4.0 and s["years"]["2020"]["total"] == 12.0
    assert run.grade("replication", {"ci": [0.1, 5], "usd_per_day": 2}) == "REPLICATES"
    assert run.grade("replication", {"ci": [-1, 5], "usd_per_day": 2}) == "WEAK"
    assert run.grade("replication", {"ci": [-3, 1], "usd_per_day": -1}) == "DOES NOT REPLICATE"
    assert run.grade("before", {"ci": [-0.1, 5], "usd_per_day": 2}) == "DOES NOT HOLD"
    assert run.grade("before", {"ci": [0.1, 2], "usd_per_day": 1}) == "HOLDS"


def test_nq_front_by_prior_volume_back_adjusted(tmp_path) -> None:
    days = [date(2024, 9, 3) + timedelta(days=i) for i in range(4)]

    def write(name: str, price: float, volumes: list[float]) -> str:
        path = tmp_path / f"{name}.csv"
        lines = ["date,open,high,low,close,volume"]
        for day, vol in zip(days, volumes):
            for j in range(78):
                t = utc(day, 13, 30) + timedelta(minutes=5 * j)
                lines.append(f"{t:%Y%m%d}  {t:%H:%M:%S},{price},{price},{price},{price},{vol}")
        path.write_text("\n".join(lines))
        return str(path)

    old = write("NQ_202409", 100.0, [10, 10, 1, 1])
    new = write("NQ_202412", 102.0, [1, 5, 10, 10])
    segments, scales, info = run.load_nq([old, new])
    # Days 2 and 3 follow the prior day's volume (old); day 4 follows day 3, where new is larger: one roll.
    assert info["rolls"] == 1 and info["sessions"] == 3
    [seg], [k] = segments, scales
    assert [s.bars[-1].close for s in seg] == pytest.approx([102.0, 102.0, 102.0])
    assert k == pytest.approx([100.0 / 102.0, 100.0 / 102.0, 1.0])


def test_nq_roll_across_a_data_gap_splits_segments(tmp_path) -> None:
    def write(name: str, price: float, days: list[date]) -> str:
        path = tmp_path / f"{name}.csv"
        lines = ["date,open,high,low,close,volume"]
        for day in days:
            for j in range(78):
                t = utc(day, 13, 30) + timedelta(minutes=5 * j)
                lines.append(f"{t:%Y%m%d}  {t:%H:%M:%S},{price},{price},{price},{price},1")
        path.write_text("\n".join(lines))
        return str(path)

    early = [date(2025, 6, 2) + timedelta(days=i) for i in range(3)]
    late = [date(2025, 7, 21) + timedelta(days=i) for i in range(3)]
    segments, scales, info = run.load_nq([write("NQ_202506", 100.0, early), write("NQ_202509", 110.0, late)])
    assert [len(s) for s in segments] == [2, 2] and info["rolls"] == 1
    assert scales == [[1.0, 1.0], [1.0, 1.0]]


def test_nq_roll_with_a_shared_day_before_a_gap_back_adjusts(tmp_path) -> None:
    def write(name: str, price: float, days: list[date]) -> str:
        path = tmp_path / f"{name}.csv"
        lines = ["date,open,high,low,close,volume"]
        for day in days:
            vol = 5 if name.endswith("09") else 1
            for j in range(78):
                t = utc(day, 13, 30) + timedelta(minutes=5 * j)
                lines.append(f"{t:%Y%m%d}  {t:%H:%M:%S},{price},{price},{price},{price},{vol}")
        path.write_text("\n".join(lines))
        return str(path)

    early = [date(2025, 6, 2) + timedelta(days=i) for i in range(3)]
    late = [date(2025, 7, 21) + timedelta(days=i) for i in range(2)]
    # The new contract also has the old one's last two days, so the roll happens before the gap.
    segments, scales, info = run.load_nq([write("NQ_202506", 100.0, early), write("NQ_202509", 110.0, early[1:] + late)])
    # 06-03 trades the old contract, back-adjusted by 110/100; from 06-04 on the new one, real prices.
    assert info["rolls"] == 1 and [len(s) for s in segments] == [2, 2]
    assert [s.bars[-1].close for s in segments[0]] == pytest.approx([110.0, 110.0])
    assert scales[0] == pytest.approx([100.0 / 110.0, 1.0]) and scales[1] == [1.0, 1.0]
