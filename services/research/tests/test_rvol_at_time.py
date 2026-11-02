"""Relative volume at time: hand-computed cases, an identity check on the golden SPY bars,
a brute-force check on random sessions, input guards and an independent pandas reference.

pandas is not a project dependency; the pandas test is skipped without it.
"""

from __future__ import annotations

import csv
import math
import random
from pathlib import Path

import pytest

from indicators import MAX_PERIOD, rvol_at_time, sma

N = None
GOLDEN = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "golden"


def close_to(actual, expected, tolerance=1e-12):
    assert len(actual) == len(expected)
    for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
        if right is None:
            assert left is None, index
        else:
            assert left is not None and math.isclose(left, right, rel_tol=tolerance), (index, left, right)


def test_intraday_hand_case():
    # Lookback 2. D1: 09:30 v10, 09:35 v20. D2: 09:30 v30, 09:35 v10. D3: 09:30 v20, 09:35 v40.
    # D3 09:30: cum 20 / mean(10, 30) = 1. D3 09:35: cum 60 / mean(30, 40) = 60/35.
    sessions = ["D1", "D1", "D2", "D2", "D3", "D3"]
    slots = [570, 575, 570, 575, 570, 575]
    volume = [10, 20, 30, 10, 20, 40]
    close_to(rvol_at_time(sessions, slots, volume, 2), [N, N, N, N, 1.0, 60 / 35])


def test_missing_and_late_slots_use_volume_so_far():
    # D3 has a 09:32 bar: earlier sessions are taken as of 09:32, so (10, 30) -> 20/20 = 1.
    # D3 09:40 is after the last bar of D1 and D2: their full-session totals (30, 40) are used.
    # D3 09:29 is before every earlier bar: the mean is 0 and the value is undefined.
    sessions = ["D1", "D1", "D2", "D2", "D3", "D3", "D3"]
    slots = [570, 575, 570, 575, 569, 572, 580]
    volume = [10, 20, 30, 10, 5, 15, 50]
    close_to(rvol_at_time(sessions, slots, volume, 2), [N, N, N, N, N, 20 / 20, 70 / 35])


def test_daily_bars_equal_volume_over_prior_mean():
    # One bar per session: v / mean of the previous two volumes.
    days = ["a", "b", "c", "d", "e"]
    close_to(rvol_at_time(days, [0] * 5, [4, 6, 10, 0, 8], 2), [N, N, 2.0, 0.0, 8 / 5])
    assert rvol_at_time([], [], [], 3) == []
    # A zero mean is undefined, not infinite.
    assert rvol_at_time(["a", "b", "c"], [0, 0, 0], [0, 0, 5], 2) == [N, N, N]


def test_golden_spy_daily_identity():
    """On real daily bars RVOL(20) equals volume / SMA(volume, 20) of the previous bar."""
    with (GOLDEN / "SPY-1d.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    volume = [float(row["volume"]) for row in rows]
    days = [row["date"] for row in rows]
    result = rvol_at_time(days, [0] * len(days), volume, 20)
    average = sma(volume, 20)
    assert result[:20] == [N] * 20
    expected = [N] * 20 + [volume[index] / average[index - 1] for index in range(20, len(volume))]
    close_to(result, expected, 1e-9)


def _random_sessions(seed: int, days: int):
    rng = random.Random(seed)
    sessions, slots, volume = [], [], []
    for day in range(days):
        count = rng.randint(1, 12)
        for slot in sorted(rng.sample(range(570, 960, 5), count)):
            sessions.append(f"2020-01-{day:03d}")
            slots.append(slot)
            volume.append(0.0 if rng.random() < 0.1 else round(rng.uniform(0, 1000), 3))
    return sessions, slots, volume


def _brute_force(sessions, slots, volume, lookback):
    order: list[str] = []
    for key in sessions:
        if not order or order[-1] != key:
            order.append(key)
    out = []
    for index, key in enumerate(sessions):
        position = order.index(key)
        cum = math.fsum(v for k, s, v in zip(sessions, slots, volume) if k == key and s <= slots[index])
        if position < lookback:
            out.append(None)
            continue
        refs = [
            math.fsum(v for k, s, v in zip(sessions, slots, volume) if k == past and s <= slots[index])
            for past in order[position - lookback : position]
        ]
        mean = math.fsum(refs) / lookback
        out.append(cum / mean if mean > 0 else None)
    return out


@pytest.mark.parametrize("lookback", [1, 3, 20])
def test_matches_brute_force_on_random_sessions(lookback):
    sessions, slots, volume = _random_sessions(lookback, 40)
    close_to(rvol_at_time(sessions, slots, volume, lookback), _brute_force(sessions, slots, volume, lookback), 1e-9)


@pytest.mark.parametrize(
    "call,error,match",
    [
        (lambda: rvol_at_time("ab", [0, 0], [1, 1], 1), TypeError, "session keys"),
        (lambda: rvol_at_time(["a"], 5, [1], 1), TypeError, "integers"),
        (lambda: rvol_at_time(["a"], "5", [1], 1), TypeError, "integers"),
        (lambda: rvol_at_time(["a", "b"], [0], [1, 1], 1), ValueError, "same length"),
        (lambda: rvol_at_time(["a"], [0], [-1], 1), ValueError, "negative"),
        (lambda: rvol_at_time(["a"], [0], [math.inf], 1), ValueError, "finite"),
        (lambda: rvol_at_time(["a"], [0.5], [1], 1), TypeError, "integers"),
        (lambda: rvol_at_time(["a"], [True], [1], 1), TypeError, "integers"),
        (lambda: rvol_at_time(["a", "a"], [5, 5], [1, 1], 1), ValueError, "does not increase"),
        (lambda: rvol_at_time(["a", "b", "a"], [0, 0, 0], [1, 1, 1], 1), ValueError, "contiguous"),
        (lambda: rvol_at_time(["a"], [0], [1], 0), ValueError, "lookback"),
        (lambda: rvol_at_time(["a"], [0], [1], MAX_PERIOD + 1), ValueError, "lookback"),
    ],
)
def test_rejects_invalid_input(call, error, match):
    with pytest.raises(error, match=match):
        call()


def test_independent_pandas_reference():
    pd = pytest.importorskip("pandas")
    sessions, slots, volume = _random_sessions(11, 60)
    frame = pd.DataFrame({"session": sessions, "slot": slots, "volume": volume})
    frame["cum"] = frame.groupby("session", sort=False)["volume"].cumsum()
    # Cumulative volume of every session on a common slot grid, carried forward in time.
    grid = sorted(set(slots))
    wide = (
        frame.pivot(index="session", columns="slot", values="cum")
        .reindex(index=list(dict.fromkeys(sessions)), columns=grid)
        .ffill(axis=1)
        .fillna(0.0)
    )
    reference = wide.rolling(20).mean().shift(1)
    expected = []
    for key, slot, cum in zip(frame["session"], frame["slot"], frame["cum"], strict=True):
        mean = reference.at[key, slot]
        expected.append(None if pd.isna(mean) or mean == 0 else cum / mean)
    close_to(rvol_at_time(sessions, slots, volume, 20), expected, 1e-9)
