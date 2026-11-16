"""Options side of the flow control rules: Python port of packages/api/src/flow-control-rules.ts.

Pure module (no file or network access). The golden vectors committed with the TypeScript module are the
acceptance test of the port: the Python test replays every case and must give the same ratio, state, no-data reason
and start minute as TypeScript.
In the study every minute is closed, so the live reader's reason `stale` and its rule "leave out the minute in
progress" have no effect here and are not ported.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

BUYERS = "buyers"
SELLERS = "sellers"
BALANCED = "balanced"
NO_DATA = "no_data"
MIXED = "mixed"
SESSION_START = "session_start"
GAP = "gap"


@dataclass(frozen=True)
class ControlRules:
    version: str
    window_minutes: int
    enter_ratio: float
    exit_ratio: float
    min_minutes: int
    min_buckets: int

    def to_json(self) -> dict:
        return {"version": self.version, "windowMinutes": self.window_minutes, "enterRatio": self.enter_ratio,
                "exitRatio": self.exit_ratio, "minMinutes": self.min_minutes, "minBuckets": self.min_buckets}


RULES = ControlRules("flow-control-rules.v1", 30, 0.30, 0.10, 5, 10)


@dataclass(frozen=True)
class DriftMinute:
    """One closed minute of the expiry part `total`; `minute` counts from 09:30 New York."""

    minute: int
    net_call_premium: float
    net_put_premium: float


@dataclass(frozen=True)
class ControlStep:
    minute: int
    ratio: float | None
    state: str
    no_data_reason: str | None
    since_minute: int | None


def options_ratio(window: Sequence[DriftMinute]) -> float:
    """Sum of (call minus put) over the sum of (absolute call plus absolute put); 0.0 for a zero divisor."""
    num = sum(m.net_call_premium - m.net_put_premium for m in window)
    den = sum(abs(m.net_call_premium) + abs(m.net_put_premium) for m in window)
    return num / den if den != 0 else 0.0


def fold_control_state(minutes: Sequence[DriftMinute], rules: ControlRules) -> list[ControlStep]:
    """One step per minute from 0 to the last minute of `minutes`, gaps included (Pseudocode A of the plan)."""
    rows = sorted(minutes, key=lambda m: m.minute)
    if not rows:
        return []
    last = rows[-1].minute
    state, since = BALANCED, None
    buy_run = sell_run = 0
    buy_start: int | None = None
    sell_start: int | None = None
    out: list[ControlStep] = []
    lo = 0
    for m in range(0, last + 1):
        hi = lo
        while lo < len(rows) and rows[lo].minute <= m - rules.window_minutes:
            lo += 1
        hi = lo
        while hi < len(rows) and rows[hi].minute <= m:
            hi += 1
        window = rows[lo:hi]
        if len(window) < rules.min_buckets:
            reason = SESSION_START if m + 1 < rules.min_buckets else GAP
            out.append(ControlStep(m, None, NO_DATA, reason, None))
            buy_run = sell_run = 0
            continue
        ratio = options_ratio(window)
        if (state == BUYERS and ratio < rules.exit_ratio) or (state == SELLERS and ratio > -rules.exit_ratio):
            state, since = BALANCED, None
        if state == BALANCED:
            if ratio >= rules.enter_ratio:
                sell_run = 0
                buy_run += 1
                if buy_run == 1:
                    buy_start = m
            elif ratio <= -rules.enter_ratio:
                buy_run = 0
                sell_run += 1
                if sell_run == 1:
                    sell_start = m
            else:
                buy_run = sell_run = 0
            if buy_run == rules.min_minutes:
                state, since, buy_run = BUYERS, buy_start, 0
            elif sell_run == rules.min_minutes:
                state, since, sell_run = SELLERS, sell_start, 0
        out.append(ControlStep(m, ratio, state, None, since))
    return out


def group_options_state(primary: str, check: str) -> str:
    """`no_data` without primary data; `mixed` when the two tickers control opposite sides; else the primary."""
    if primary == NO_DATA:
        return NO_DATA
    if (primary, check) in ((BUYERS, SELLERS), (SELLERS, BUYERS)):
        return MIXED
    return primary
