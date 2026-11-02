"""RVOL-at-time intraday filter test (frozen rules R1-R7: docs/specs/research/adx-filter.md).

SPY 1-minute bars are aggregated to 5-minute bars. First-half-hour momentum trades from the 10:00 open
to the session close, with and without the filter RVOL-at-time(20) > 1.0 on the 09:55 bar.

Research only: reads local files, writes a local JSON file, places no orders.

Usage (from services/research):
  python -m strategies.rvol_intraday --bars spy_1min.csv --out rvol.json
The CSV is the Kaggle file rockinbrock/spy-1-minute-data used by the noise-band test (an IBKR TWS export):
columns date,open,high,low,close,volume
with naive US Mountain time bar starts (ET = MT + 2 h).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from indicators import rvol_at_time
from strategies.adx_filter import metrics

FULL_DAY_LAST = 389
HALF_DAY_LASTS = {209, 224}
DECISION_BAR = 5  # the 5-minute bar that starts at 09:55
LOOKBACK = 20
THRESHOLD = 1.0
PRIMARY_COST, SENSITIVITY_COST = 0.0001, 0.0005


@dataclass(frozen=True, slots=True)
class Bar:
    minute: int  # minutes after 09:30 ET of the bar start
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True, slots=True)
class Session:
    day: str
    bars: tuple[Bar, ...]  # 5-minute bars


def complete_sessions(rows: Iterable[dict[str, str]]) -> tuple[list[tuple[str, dict[int, Bar]]], list[str]]:
    """R1: regular-session minute bars by ET date; keep only sessions without missing minutes."""
    by_day: dict[str, dict[int, Bar]] = {}
    for row in rows:
        stamp = datetime.fromisoformat(row["date"]) + timedelta(hours=2)
        minute = stamp.hour * 60 + stamp.minute - (9 * 60 + 30)
        if not 0 <= minute <= FULL_DAY_LAST:
            continue
        day = by_day.setdefault(stamp.date().isoformat(), {})
        day.setdefault(minute, Bar(minute, *(float(row[key]) for key in ("open", "high", "low", "close", "volume"))))
    kept, dropped = [], []
    for day in sorted(by_day):
        bars = by_day[day]
        last = max(bars)
        if 0 in bars and len(bars) == last + 1 and (last == FULL_DAY_LAST or last in HALF_DAY_LASTS):
            kept.append((day, bars))
        else:
            dropped.append(day)
    return kept, dropped


def five_minute(day: str, minutes: dict[int, Bar]) -> Session:
    out = []
    for start in range(0, max(minutes) + 1, 5):
        group = [minutes[m] for m in range(start, start + 5) if m in minutes]
        out.append(Bar(start, group[0].open, max(b.high for b in group), min(b.low for b in group), group[-1].close,
                       math.fsum(b.volume for b in group)))
    return Session(day, tuple(out))


def decision_rvol(sessions: Sequence[Session]) -> list[float | None]:
    """RVOL-at-time(20) on the 09:55 bar of each session.

    The value at 09:55 uses only bars that start at or before 09:55 in every session, so later bars
    are left out. This keeps the input below the indicator row limit and gives the same values.
    """
    keys, slots, volume, decision_index = [], [], [], []
    for session in sessions:
        for bar in session.bars[: DECISION_BAR + 1]:
            if bar.minute == DECISION_BAR * 5:
                decision_index.append(len(volume))
            keys.append(session.day)
            slots.append(bar.minute)
            volume.append(bar.volume)
    line = rvol_at_time(keys, slots, volume, LOOKBACK)
    return [line[index] for index in decision_index]


@dataclass(frozen=True, slots=True)
class Day:
    day: str
    side: int  # 0 = no trade
    move: float  # side-free return from the 10:00 open to the close
    rvol: float | None


def session_days(sessions: Sequence[Session]) -> list[Day]:
    """R2: direction from the 09:30 open to the 09:55 bar close; trade the 10:00 open to the last close."""
    days = []
    for session, rvol in zip(sessions, decision_rvol(sessions), strict=True):
        bars = session.bars
        first_half_hour = bars[DECISION_BAR].close / bars[0].open - 1
        side = (first_half_hour > 0) - (first_half_hour < 0)
        days.append(Day(session.day, side, bars[-1].close / bars[DECISION_BAR + 1].open - 1, rvol))
    return days


def daily_returns(days: Sequence[Day], filtered: bool, cost: float) -> tuple[list[float], list[bool]]:
    returns, traded = [], []
    for day in days:
        trade = day.side != 0 and (not filtered or (day.rvol is not None and day.rvol > THRESHOLD))
        returns.append(day.side * day.move - 2 * cost if trade else 0.0)
        traded.append(trade)
    return returns, traded


def ranks(values: Sequence[float]) -> list[float]:
    order = sorted(range(len(values)), key=values.__getitem__)
    out = [0.0] * len(values)
    position = 0
    while position < len(order):
        end = position
        while end + 1 < len(order) and values[order[end + 1]] == values[order[position]]:
            end += 1
        for index in order[position : end + 1]:
            out[index] = (position + end) / 2 + 1
        position = end + 1
    return out


def spearman(left: Sequence[float], right: Sequence[float]) -> float | None:
    if len(left) < 3:
        return None
    a, b = ranks(left), ranks(right)
    mean_a, mean_b = math.fsum(a) / len(a), math.fsum(b) / len(b)
    cov = math.fsum((x - mean_a) * (y - mean_b) for x, y in zip(a, b, strict=True))
    var = math.sqrt(math.fsum((x - mean_a) ** 2 for x in a) * math.fsum((y - mean_b) ** 2 for y in b))
    return cov / var if var else None


def evaluate(days: Sequence[Day]) -> dict:
    """R3-R6 over the sessions with a defined RVOL (the first 20 sessions are warm-up for both variants)."""
    days = [day for day in days if day.rvol is not None]
    middle = math.ceil(len(days) / 2)
    parts = {"full": slice(0, len(days)), "firstHalf": slice(0, middle), "secondHalf": slice(middle, len(days))}
    years = len(days) / 252
    result: dict = {
        "sessions": len(days),
        "firstSession": days[0].day,
        "secondHalfStart": days[middle].day,
        "lastSession": days[-1].day,
    }
    for cost_name, cost in (("primary1bp", PRIMARY_COST), ("sensitivity5bp", SENSITIVITY_COST)):
        block = {}
        for variant, filtered in (("none", False), ("rvol_above_1", True)):
            returns, traded = daily_returns(days, filtered, cost)
            block[variant] = {
                name: asdict(metrics(returns[part], sum(traded[part]))) for name, part in parts.items()
            } | {"tradesPerYear": sum(traded) / years}
        base, filt = block["none"], block["rvol_above_1"]
        better = all(
            filt[half]["sharpe"] is not None and base[half]["sharpe"] is not None
            and filt[half]["sharpe"] > base[half]["sharpe"]
            for half in ("firstHalf", "secondHalf")
        )
        block["verdict"] = (
            "DROP (trade floor)" if filt["tradesPerYear"] < 30
            else "KEEP" if better else "DROP (Sharpe not higher in both halves)"
        )
        result[cost_name] = block
    result["spearmanRvolVsAbsMove"] = {
        name: spearman([d.rvol for d in days[part]], [abs(d.move) for d in days[part]])
        for name, part in parts.items()
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bars", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.bars, newline="") as handle:
        kept, dropped = complete_sessions(csv.DictReader(handle))
    sessions = [five_minute(day, bars) for day, bars in kept]
    result = evaluate(session_days(sessions))
    result["data"] = {"sessionsUsed": len(sessions), "sessionsDroppedIncomplete": dropped}
    with open(args.out, "w") as handle:
        json.dump(result, handle, indent=1)
    for cost_name in ("primary1bp", "sensitivity5bp"):
        print(cost_name, result[cost_name]["verdict"])


if __name__ == "__main__":
    main()
