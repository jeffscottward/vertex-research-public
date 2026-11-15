"""Trend Trio (Vertex reconstruction, rules guessed): the frozen rules of docs/specs/strategies/trend-trio.md.

Research only: this module turns bars into a list of trades; it places no order. The design is
docs/specs/strategies/trend-trio-design.md (completed-bar rule, rules 1-7, variants V1-V8 and S1-S22).

Terms. The trio = SuperTrend, Ultimate MA and AlphaTrend (the voters); Slingshot = the filter; Chandelier
Exit = the exit. A bucket = a 5- or 15-minute bar built from the execution bars (1-minute bars on dataset
(a), 5-minute bars on dataset (b)). Bucket boundaries are multiples of the bucket length in UTC, which puts
them at 09:30 New York (a multiple of 15 minutes in both UTC offsets of New York).

Completed-bar rule: an execution bar that closes at time T reads the newest bucket that ends at or before T.
A decision at the close of bar i fills at the open of bar i + 1; the last bar of a session closes any
position at its own close (market on close).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from dataclasses import dataclass, fields
from pathlib import Path

from indicators.trend import alphatrend, chandelier_exit, slingshot, supertrend, ultimate_ma

MINUTE_MS = 60_000
SPEC = Path(__file__).resolve().parents[4] / "docs" / "specs" / "strategies" / "trend-trio.md"
# SHA-256 of the spec above "## Results", fixed when the rules were frozen (research/backtests/trend-trio/run.py
# refuses to run when the spec differs). Set by the freeze commit.
SPEC_SHA256 = "35b52eec96881c71163fc89a69a5c042863285a1012c6bed56b3249f482d434b"
RESULTS_HEADING = "## Results"


def spec_sha256(path: Path = SPEC) -> str:
    """SHA-256 of the frozen part of the spec (everything above the "## Results" heading)."""
    text = path.read_text()
    frozen = text.split(f"\n{RESULTS_HEADING}\n", 1)[0]
    return hashlib.sha256(frozen.encode()).hexdigest()


@dataclass(frozen=True)
class Minutes:
    """Execution bars of one dataset, chronological, regular session only.

    t: UTC milliseconds of the bar open; o, h, l, c, v: prices and volume; bar_ms: bar length;
    session: session index of each bar; minute: minutes after 09:30 New York of the bar open;
    close_minute: per session, minutes after 09:30 of the session close (390, or 210 on early-close days);
    scale: per session, index points per price unit (1 on index data, NDX / QQQ on QQQ bars);
    day: per session, the New York date (YYYY-MM-DD)."""

    t: Sequence[int]
    o: Sequence[float]
    h: Sequence[float]
    l: Sequence[float]  # noqa: E741 (low, as in the other bar columns)
    c: Sequence[float]
    v: Sequence[float]
    bar_ms: int
    session: Sequence[int]
    minute: Sequence[int]
    close_minute: Sequence[int]
    scale: Sequence[float]
    day: Sequence[str]


@dataclass(frozen=True)
class Params:
    """One row of the variant list. Defaults = row P1."""

    signal_minutes: int = 5
    st_length: int = 10
    st_factor: float = 3.0
    uma_type: str = "sma"
    uma_length: int = 20
    uma_smoothing: int = 2
    at_length: int = 14
    at_coeff: float = 1.0
    at_momentum: str = "mfi"
    ce_length: int = 22
    ce_multiple: float = 3.0
    ce_on_signal: bool = False
    sling_fast: int = 38
    sling_slow: int = 62
    filter_on: bool = True
    voters_needed: int = 3
    entry: str = "episode"  # "episode" (P1), "reentry" (V1, the DSL form), "event" (V2)
    exit_on_voters: bool = False
    full_session: bool = False
    entry_end_minute: int = 380  # 15:50 New York
    lookahead: bool = False  # diagnostic only: read the bucket that contains the bar

    def key(self) -> str:
        return ",".join(f"{f.name}={getattr(self, f.name)}" for f in sorted(fields(self), key=lambda f: f.name))


@dataclass(frozen=True)
class Trade:
    session: int
    side: int  # +1 long, -1 short
    entry_bar: int  # fill at the open of this bar
    exit_bar: int  # fill at the open of this bar, or at the close of this bar when exit_reason == "close"
    entry_price: float
    exit_price: float
    exit_reason: str  # "chandelier", "voters", "reverse", "close"
    points: float  # side x (exit - entry) x session scale, before costs


@dataclass(frozen=True)
class Buckets:
    """Bucket bars and, for each execution bar, the index of the bucket it reads (-1: none yet)."""

    o: list[float]
    h: list[float]
    l: list[float]  # noqa: E741
    c: list[float]
    v: list[float]
    end_ms: list[int]
    session_first: list[bool]
    read: list[int]


def buckets(t: Sequence[int], o: Sequence[float], h: Sequence[float], low: Sequence[float], c: Sequence[float],
            v: Sequence[float], bar_ms: int, period_minutes: int, *, read_at: Sequence[int] | None = None,
            session: Sequence[int] | None = None, lookahead: bool = False) -> Buckets:
    """Aggregate bars into buckets of `period_minutes` and map bars to the bucket they may read.

    `read_at` (default `t`) are the open times of the bars that read the buckets (the execution bars); a bar
    opening at T closes at T + bar_ms and reads the newest bucket whose end is at or before that close.
    `session` (same length as `t`) marks the first bucket of each session. With `lookahead` (diagnostic),
    each reading bar reads the bucket that contains its open time instead, with that bucket's final values."""
    period = period_minutes * MINUTE_MS
    if period < bar_ms or period % bar_ms:
        raise ValueError(f"bucket length {period_minutes} min must be a whole multiple of the bar length")
    bo: list[float] = []
    bh: list[float] = []
    bl: list[float] = []
    bc: list[float] = []
    bv: list[float] = []
    end: list[int] = []
    first: list[bool] = []
    keys: list[int] = []
    last_session = None
    for i, start in enumerate(t):
        key = start // period
        if not keys or key != keys[-1]:
            keys.append(key)
            end.append((key + 1) * period)
            bo.append(o[i]); bh.append(h[i]); bl.append(low[i]); bc.append(c[i]); bv.append(v[i])
            s = None if session is None else session[i]
            first.append(s is not None and s != last_session)
            last_session = s
        else:
            if h[i] > bh[-1]:
                bh[-1] = h[i]
            if low[i] < bl[-1]:
                bl[-1] = low[i]
            bc[-1] = c[i]
            bv[-1] += v[i]
    readers = t if read_at is None else read_at
    read = [-1] * len(readers)
    k = -1
    for i, start in enumerate(readers):
        if lookahead:
            target = start // period
            while k + 1 < len(keys) and keys[k + 1] <= target:
                k += 1
            read[i] = k if k >= 0 and keys[k] == target else -1
            continue
        close = start + bar_ms
        while k + 1 < len(end) and end[k + 1] <= close:
            k += 1
        read[i] = k
    return Buckets(bo, bh, bl, bc, bv, end, first, read)


def _alignment(st: float, uma: float, at: float, sling: float, p: Params) -> int:
    votes = (st, uma, at)
    for side in (1.0, -1.0):
        agree = sum(1 for x in votes if x == side)
        against = sum(1 for x in votes if x == -side)
        voters_ok = agree == 3 if p.voters_needed == 3 else (agree >= p.voters_needed and against == 0)
        filter_ok = (not p.filter_on) or sling == side
        if voters_ok and filter_ok:
            return int(side)
    return 0


def _event_start(prev: tuple[float, float, float, float], now: tuple[float, float, float, float], side: int,
                 p: Params) -> bool:
    """V2: the episode starts because one trio indicator flipped into `side` while the other two already
    agreed (and the filter allowed at both bucket closes)."""
    before = sum(1 for x in prev[:3] if x == side)
    flipped = before == 2 and all(x == side for x in now[:3])
    filter_steady = (not p.filter_on) or (prev[3] == side and now[3] == side)
    return flipped and filter_steady


def signal_directions(b: Buckets, p: Params) -> tuple[list[float], list[float], list[float], list[float]]:
    """Directions of SuperTrend, Ultimate MA, AlphaTrend and Slingshot on the bucket bars."""
    _, st = supertrend(b.h, b.l, b.c, p.st_length, p.st_factor)
    _, uma = ultimate_ma(b.c, b.v, p.uma_type, p.uma_length, p.uma_smoothing)  # type: ignore[arg-type]
    _, at = alphatrend(b.h, b.l, b.c, b.v, p.at_length, p.at_coeff, p.at_momentum)  # type: ignore[arg-type]
    *_, sling = slingshot(b.c, p.sling_fast, p.sling_slow)
    return st, uma, at, sling


def trades(m: Minutes, p: Params, full: Minutes | None = None) -> list[Trade]:
    """Trades of one variant on one dataset. `full` (V8): full-session bars that feed the signal buckets."""
    n = len(m.t)
    src = full if (p.full_session and full is not None) else m
    b = buckets(src.t, src.o, src.h, src.l, src.c, src.v, src.bar_ms, p.signal_minutes, read_at=m.t,
                session=src.session if src is m else None, lookahead=p.lookahead)
    if src is not m:
        b = _mark_session_first(b, m)
    st, uma, at, sling = signal_directions(b, p)
    if p.ce_on_signal:
        _, _, ce_bucket = chandelier_exit(b.h, b.l, b.c, p.ce_length, p.ce_multiple)
        ce_exec = None
    else:
        ce_bucket = None
        _, _, ce_exec = chandelier_exit(m.h, m.l, m.c, p.ce_length, p.ce_multiple)
    bar_minutes = m.bar_ms // MINUTE_MS
    out: list[Trade] = []
    pos = 0
    entry_bar = -1
    episode_side = 0
    episode_used = False
    prev_read = -1
    for i in range(n):
        s = m.session[i]
        last = i == n - 1 or m.session[i + 1] != s
        r = b.read[i]
        new_bucket = r != prev_read and r >= 0
        prev_read = r
        if new_bucket:
            now = (st[r], uma[r], at[r], sling[r])
            side_now = _alignment(*now, p)
            prev_side = _alignment(st[r - 1], uma[r - 1], at[r - 1], sling[r - 1], p) if r > 0 else 0
            if side_now == 0:
                episode_side = 0
            elif p.entry == "event":
                if r > 0 and _event_start((st[r - 1], uma[r - 1], at[r - 1], sling[r - 1]), now, side_now, p):
                    episode_side, episode_used = side_now, False
                elif side_now != episode_side:
                    episode_side = 0
            elif side_now != prev_side or b.session_first[r] or side_now != episode_side:
                episode_side, episode_used = side_now, False
        ce_now = (ce_bucket[r] if r >= 0 else math.nan) if ce_bucket is not None else ce_exec[i]  # type: ignore[index]
        # Exit decisions at the close of bar i.
        exit_reason = ""
        if pos != 0:
            if last:
                exit_reason = "close"
            elif ce_now == -pos and (ce_bucket is None or new_bucket):
                exit_reason = "chandelier"
            elif p.exit_on_voters and new_bucket and any(x == -pos for x in (st[r], uma[r], at[r])):
                exit_reason = "voters"
        # Entry decision at the close of bar i.
        close_minute = m.minute[i] + bar_minutes
        window_end = m.close_minute[s] - (390 - p.entry_end_minute)
        want = 0
        if (not last and episode_side != 0 and 5 <= close_minute <= window_end
                and (p.entry == "reentry" or not episode_used) and ce_now == episode_side
                and (ce_bucket is None or new_bucket)):
            want = episode_side
        if want != 0 and pos == want:
            want = 0
        if want != 0 and pos == -want and not exit_reason:
            exit_reason = "reverse"
        if exit_reason:
            exit_at = i if exit_reason == "close" else i + 1
            price = m.c[i] if exit_reason == "close" else m.o[i + 1]
            entry_price = m.o[entry_bar]
            out.append(Trade(s, pos, entry_bar, exit_at, entry_price, price, exit_reason,
                             pos * (price - entry_price) * m.scale[s]))
            pos = 0
        if want != 0 and pos == 0:
            pos = want
            entry_bar = i + 1
            episode_used = True
    return out


def _mark_session_first(b: Buckets, m: Minutes) -> Buckets:
    """Full-session buckets: the first bucket a session's first execution bar can read starts a session."""
    first = [False] * len(b.end_ms)
    seen = set()
    for i, r in enumerate(b.read):
        s = m.session[i]
        if s in seen or r < 0:
            continue
        seen.add(s)
        nxt = r + 1 if r + 1 < len(first) else r
        first[nxt] = True
    return Buckets(b.o, b.h, b.l, b.c, b.v, b.end_ms, first, b.read)


def signal_arrays(m: Minutes, trade_list: Sequence[Trade], side: int) -> tuple[list[int], list[int], list[int]]:
    """Entry and exit decision flags of one side for nautilus_backtest.engine (the engine fills at the next
    open), and the market-on-close flags (last bar of each session)."""
    n = len(m.t)
    signals = [0] * n
    exits = [0] * n
    close_at = [1 if i == n - 1 or m.session[i + 1] != m.session[i] else 0 for i in range(n)]
    for tr in trade_list:
        if tr.side != side:
            continue
        signals[tr.entry_bar - 1] = 1
        if tr.exit_reason != "close":
            exits[tr.exit_bar - 1] = 1
    return signals, exits, close_at
