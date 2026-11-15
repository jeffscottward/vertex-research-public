"""Run plan of the Trend Trio study (Vertex reconstruction, rules guessed; research only, it never places orders).

Design: docs/specs/strategies/trend-trio-design.md ("Study design", "Booking", "Storage"). The rules live in
`rules.py` (frozen with the spec); this module loads the three datasets, lists the 33 graded rows and the
diagnostics as jobs, books the trades in dollars and grades them with tests T1-T7.

Datasets (every path is an argument of `DataPaths`; nothing is copied into the repository):
- (a) Dukascopy `usatechidxusd` 1-minute bid and ask (the imom m1 files), regular session, mid prices;
  V8 also reads the full-session monthly files (`m1_full`), "not run" when a month is missing (Q-ETH).
- (b) IBKR QQQ 5-minute bars, P&L in NDX points (scale = NDX / QQQ of the latest earlier date, Yahoo daily).
- (c) real NQ 5-minute bars, front month by prior-session volume (tracking check, reported only).

Jobs write one JSON file each (`<name>.json` in the output directory); a restarted run skips a job whose file
names the same parameters and spec hash. `assemble(out_dir)` reads the files and builds the results document.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import math
import random
import statistics
import time
from array import array
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from datetime import UTC, date, datetime
from datetime import time as clock_time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from backtesting.optimizer import deflated_sharpe_ratio
from indicators.trend import mfi
from strategies import noise_band_futures_run as nbf
from strategies.imom import data as imom
from strategies.trend_trio import rules
from strategies.trend_trio.rules import Minutes, Params, Trade

__all__ = ["CAPITAL", "DIAGNOSTICS", "VARIANTS", "DataPaths", "Datasets", "Job", "Variant", "assemble",
           "bucket_gaps", "full_years", "jobs", "ledger", "load_datasets", "max_drawdown", "per_year",
           "random_control", "run_job", "session_pnl", "time_in_market", "walk_forward"]

SCHEMA = "trend-trio-study-v1"
NEW_YORK = ZoneInfo("America/New_York")
MINUTE_MS = rules.MINUTE_MS
OPEN = imom.OPEN_MINUTE  # 09:30 New York, minutes after midnight
FULL_CLOSE = 390  # minutes after 09:30
EARLY_CLOSE = 210  # 13:00
MIN_SESSION_MINUTES = 150

# Booking (design rule 7): 1 NQ contract = $20 per point, tick 0.25 point = $5, fees $4.50 per round trip,
# slippage per side on every entry and exit fill.
POINT_USD = 20.0
TICK_USD = 5.0
FEES_USD = 4.50
SLIPPAGE_TICKS = (0, 1, 2)
BASE_TICKS = 1
STRESS_TICKS = 2
CAPITAL = 100_000.0  # capital basis per contract of the study document (returns are fractions of it)
SESSIONS_PER_YEAR = 252

# Tests.
N_TRIALS = 33
SEED = 7
RESAMPLES = 10_000
DRAWS = 1_000
PROFITABLE_YEARS = 0.75
MIN_GROSS_PER_TRADE = 80.0
DSR_PASS = 0.95
WF_FIRST_TRAIN = 2013
WF_TEST_YEARS = tuple(range(2016, 2026))
WF_MIN_TRAIN_YEARS = 3
CLAIM_YEARS = 16
CLAIM_WINDOW = (2010, 2025)
PILOT_YEARS = (2024, 2024)
MFI_LENGTH = 14

REPORTS = Path.home() / "Documents" / "reports"


@dataclass(frozen=True)
class DataPaths:
    """Input locations on the rig (defaults); every one can be overridden on the run.py command line."""

    m1: Path = imom.DEFAULT_ROOT
    m1_full: Path = REPORTS / "vertex-trend-trio-data" / "m1-full"
    qqq: Path = REPORTS / "vertex-reel-dffkn31-data" / "ibkr5m" / "QQQ.csv.gz"
    yahoo_ndx: Path = REPORTS / "vertex-session-open-momentum" / "data" / "yahoo-NDX.json"
    yahoo_qqq: Path = REPORTS / "vertex-session-open-momentum" / "data" / "yahoo-QQQ.json"
    nq: Path = REPORTS / "vertex-emt" / "futures"


# --- variants ------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Variant:
    row: str
    dataset: str  # "a", "b", "c" or "a5" ((a) aggregated to 5-minute bars)
    params: Params
    change: str


P1 = Params()
B15_5 = Params(signal_minutes=15)  # "(b) 15/5": 15-minute signal buckets on 5-minute execution bars

# One parameter at a time (S1-S22): (label, field, low, high) in the order of the design table.
SENSITIVITY: tuple[tuple[str, str, float, float], ...] = (
    ("SuperTrend length", "st_length", 7, 14), ("SuperTrend factor", "st_factor", 2.1, 4.2),
    ("Ultimate MA length", "uma_length", 14, 28), ("Ultimate MA smoothing", "uma_smoothing", 1, 3),
    ("AlphaTrend length", "at_length", 10, 20), ("AlphaTrend coeff", "at_coeff", 0.7, 1.4),
    ("Chandelier length", "ce_length", 15, 31), ("Chandelier multiple", "ce_multiple", 2.1, 4.2),
    ("Slingshot fast", "sling_fast", 27, 53), ("Slingshot slow", "sling_slow", 43, 87),
    ("Entry window end", "entry_end_minute", 370, 385),
)


def clock(minute: int) -> str:
    """Minutes after 09:30 as New York clock time, e.g. 380 -> "15:50"."""
    total = OPEN + minute
    return f"{total // 60:02d}:{total % 60:02d}"


def _value_text(name: str, value: float) -> str:
    return clock(int(value)) if name == "entry_end_minute" else f"{value:g}"


def _variants() -> tuple[Variant, ...]:
    rows = [
        Variant("P1", "a", P1, "none (primary)"),
        Variant("P2", "a", replace(P1, signal_minutes=15), "signal timeframe 15 minutes"),
        Variant("P3", "b", B15_5, 'the "(b) 15/5" rules'),
        Variant("V1", "a", replace(P1, entry="reentry"), "re-entry: several entries per episode (the DSL form)"),
        Variant("V2", "a", replace(P1, entry="event"), "event entry: an episode counts only after a trio flip"),
        Variant("V3", "a", replace(P1, exit_on_voters=True), "exit also when a trio indicator turns against"),
        Variant("V4", "a", replace(P1, ce_on_signal=True), "Chandelier Exit on the signal buckets"),
        Variant("V5", "a", replace(P1, at_momentum="rsi"), "AlphaTrend momentum RSI"),
        Variant("V6", "a", replace(P1, filter_on=False), "no Slingshot filter"),
        Variant("V7", "a", replace(P1, voters_needed=2), "two of the trio agree, none against"),
        Variant("V8", "a", replace(P1, full_session=True), "indicators on full-session 1-minute bars"),
    ]
    number = 0
    for label, name, low, high in SENSITIVITY:
        for value in (low, high):
            number += 1
            rows.append(Variant(f"S{number}", "a", replace(P1, **{name: value}), f"{label} {_value_text(name, value)}"))
    return tuple(rows)


VARIANTS = _variants()
BY_ROW = {variant.row: variant for variant in VARIANTS}
# Diagnostics outside N: look-ahead, bridge ((b) rules on (a) at 5 minutes) and the NQ tracking check.
DIAGNOSTICS = (
    Variant("LA", "a", replace(P1, lookahead=True), "look-ahead: reads the forming bucket (diagnostic)"),
    Variant("BR", "a5", B15_5, 'bridge: "(b) 15/5" rules on (a) aggregated to 5 minutes'),
    Variant("NQ", "c", B15_5, 'tracking: "(b) 15/5" rules on real NQ 5-minute bars'),
)
NAUTILUS_ROWS = ("P1", "P2", "P3")


@dataclass(frozen=True)
class Job:
    """One unit of work. kind: "trades" (one row on one dataset), "random" (T7 control), "nautilus" (the
    engine check of one row) or "mfi" (MFI-state agreement of CFD and NQ)."""

    kind: str
    row: str
    dataset: str
    params: Params
    tier: int

    @property
    def name(self) -> str:
        return f"{self.row}-{self.dataset}" if self.kind == "trades" else f"{self.kind}-{self.row}-{self.dataset}"

    @property
    def graded(self) -> bool:
        return self.kind == "trades" and self.row in BY_ROW


def jobs() -> list[Job]:
    """Tier 1: P1-P3; tier 2: V1-V8; tier 3: S1-S22; tier 4: diagnostics (look-ahead, bridge, NQ tracking,
    random-entry control, NautilusTrader check of P1-P3, MFI agreement). The walk-forward needs no job."""
    out = [Job("trades", v.row, v.dataset, v.params, 1 if v.row.startswith("P") else 2 if v.row.startswith("V") else 3)
           for v in VARIANTS]
    out += [Job("trades", v.row, v.dataset, v.params, 4) for v in DIAGNOSTICS]
    out.append(Job("random", "P1", "a", P1, 4))
    out += [Job("nautilus", row, BY_ROW[row].dataset, BY_ROW[row].params, 4) for row in NAUTILUS_ROWS]
    out.append(Job("mfi", "MFI", "a5c", P1, 4))
    return out


# --- data ----------------------------------------------------------------------------------------------

Years = tuple[int, int]


class _Columns:
    """Bar columns of one dataset (compact arrays, shared by forked workers without copies)."""

    def __init__(self) -> None:
        self.t = array("q")
        self.o, self.h, self.l, self.c, self.v = (array("d") for _ in range(5))
        self.session = array("l")
        self.minute = array("l")
        self.close_minute: list[int] = []
        self.scale: list[float] = []
        self.day: list[str] = []

    def add_session(self, day: date, bars: Sequence[tuple], scale: float, close_minute: int) -> None:
        """bars: (UTC ms of the bar open, minutes after 09:30, o, h, l, c, v)."""
        index = len(self.day)
        for t, minute, o, h, low, c, v in bars:
            self.t.append(t); self.minute.append(minute); self.session.append(index)
            self.o.append(o); self.h.append(h); self.l.append(low); self.c.append(c); self.v.append(v)
        self.day.append(day.isoformat())
        self.scale.append(scale)
        self.close_minute.append(close_minute)

    def minutes(self, bar_ms: int) -> Minutes:
        return Minutes(self.t, self.o, self.h, self.l, self.c, self.v, bar_ms, self.session, self.minute,
                       self.close_minute, self.scale, self.day)


def _in_years(day: date, years: Years | None) -> bool:
    return years is None or years[0] <= day.year <= years[1]


def _close_of(day: date) -> int:
    return EARLY_CLOSE if imom.is_early_close(day) else FULL_CLOSE


def rth_minutes(rows: Iterable[tuple[int, tuple[float, float, float, float, float]]], years: Years | None = None,
                bar_minutes: int = 1) -> tuple[Minutes, dict]:
    """Regular-session bars from (UTC ms, (o, h, l, c, v)) rows in time order: closed days skipped, early
    closes cut at 13:00, sessions with fewer than 150 minutes of bars dropped and counted (imom.data rules)."""
    clock_ = imom._Clock()  # the imom New York clock, reused as is
    cols = _Columns()
    dropped: list[str] = []
    day_now: date | None = None
    buffer: list[tuple] = []

    def flush() -> None:
        if day_now is None or not buffer:
            return
        if len(buffer) * bar_minutes < MIN_SESSION_MINUTES:
            dropped.append(day_now.isoformat())
        else:
            cols.add_session(day_now, buffer, 1.0, _close_of(day_now))

    for t, (o, h, low, c, v) in rows:
        day, minute_of_day = clock_.local(t)
        minute = minute_of_day - OPEN
        if not _in_years(day, years) or imom.is_closed(day) or not 0 <= minute <= _close_of(day) - bar_minutes:
            continue
        if day != day_now:
            flush()
            day_now, buffer = day, []
        buffer.append((t, minute, o, h, low, c, v))
    flush()
    return cols.minutes(bar_minutes * MINUTE_MS), {"sessions": len(cols.day), "dropped": len(dropped),
                                                   "droppedDays": dropped[:50]}


def _median_spread(bid: Mapping[int, tuple], ask: Mapping[int, tuple], years: Years | None) -> float | None:
    """Median close spread (ask - bid) in points over the common minutes (a diagnostic; never charged)."""
    lo = None if years is None else datetime(years[0], 1, 1, tzinfo=UTC).timestamp() * 1000
    hi = None if years is None else datetime(years[1] + 1, 1, 1, tzinfo=UTC).timestamp() * 1000
    spreads = [ask[t][3] - bid[t][3] for t in bid
               if t in ask and (lo is None or lo <= t < hi)]  # type: ignore[operator]
    return statistics.median(spreads) if spreads else None


def load_cfd(paths: DataPaths, years: Years | None = None) -> tuple[Minutes, dict, list[Path]]:
    """Dataset (a): mid 1-minute bars of the imom NAS100 files (volume = bid tick volume)."""
    bid_path, ask_path = imom.files_of("NAS100", paths.m1)
    bid, ask = imom.read_side(bid_path), imom.read_side(ask_path)
    mid, _ = imom.mid_minutes(bid, ask)
    spread = _median_spread(bid, ask, years)
    del bid, ask
    minutes, info = rth_minutes(mid, years, 1)
    info["spreadMedianPoints"] = spread
    info["dataHash"] = imom.data_hash(["NAS100"], paths.m1)
    return minutes, info, [bid_path, ask_path]


def _open_ms(day: date) -> int:
    return int(datetime.combine(day, clock_time(9, 30), tzinfo=NEW_YORK).timestamp() * 1000)


def from_sessions(sessions: Sequence[Any], scales: Sequence[float], years: Years | None = None,
                  bar_minutes: int = 5) -> tuple[Minutes, dict]:
    """Minutes from noise_band Sessions (bars with `minute` after 09:30) and per-session scales; sessions
    outside `years`, on closed days, without a scale or shorter than 150 minutes are dropped and counted."""
    cols = _Columns()
    dropped, no_scale = 0, 0
    for session, scale in zip(sessions, scales, strict=True):
        day = session.day
        if not _in_years(day, years) or imom.is_closed(day):
            continue
        if not math.isfinite(scale):
            no_scale += 1
            continue
        close = _close_of(day)
        start = _open_ms(day)
        bars = [(start + b.minute * MINUTE_MS, b.minute, b.open, b.high, b.low, b.close, b.volume)
                for b in session.bars if b.minute + bar_minutes <= close]
        if len(bars) * bar_minutes < MIN_SESSION_MINUTES:
            dropped += 1
            continue
        cols.add_session(day, bars, scale, close)
    return cols.minutes(bar_minutes * MINUTE_MS), {"sessions": len(cols.day), "dropped": dropped,
                                                   "noScale": no_scale}


def load_qqq_minutes(paths: DataPaths, years: Years | None = None) -> tuple[Minutes, dict, list[Path]]:
    """Dataset (b): QQQ 5-minute bars; P&L points = scale x QQQ change (scale = NDX / QQQ, no look-ahead)."""
    sessions, loaded = nbf.load_qqq(str(paths.qqq))
    ndx, _ = nbf.load_yahoo(str(paths.yahoo_ndx))
    qqq, _ = nbf.load_yahoo(str(paths.yahoo_qqq))
    minutes, info = from_sessions(sessions, nbf.qqq_scales(sessions, ndx, qqq), years)
    info["skippedIncomplete"] = loaded["skipped"]
    return minutes, info, [paths.qqq, paths.yahoo_ndx, paths.yahoo_qqq]


def load_nq_minutes(paths: DataPaths, years: Years | None = None) -> tuple[Minutes, dict, list[Path]]:
    """Dataset (c): NQ 5-minute front month (ratio back-adjusted; scale = 1 / adjustment keeps real points)."""
    files = sorted(paths.nq.glob("NQ_*.csv"))
    segments, scales, loaded = nbf.load_nq([str(path) for path in files])
    flat = [s for segment in segments for s in segment]
    minutes, info = from_sessions(flat, [k for segment in scales for k in segment], years)
    info["rolls"] = loaded["rolls"]
    return minutes, info, files


def full_months(days: Sequence[str]) -> list[str]:
    return sorted({day[:7] for day in days})


def load_cfd_full(folder: Path, months: Sequence[str]) -> tuple[Minutes | None, dict, list[Path]]:
    """V8 input: full-session mid 1-minute bars of `months` (files usatechidxusd-{bid,ask}-YYYY-MM.csv).
    Q-ETH: a missing or empty month leaves V8 "not run". Only t, o, h, l, c, v feed the signal buckets; the
    session columns stay empty."""
    files = [folder / f"usatechidxusd-{side}-{month}.csv" for month in months for side in ("bid", "ask")]
    missing = sorted({path.name for path in files if not path.exists()})
    if missing:
        return None, {"status": "not run", "reason": "Q-ETH: full-session months missing", "missing": missing[:50]}, []
    cols = _Columns()
    empty: list[str] = []
    for month in months:
        bid = imom.read_side(folder / f"usatechidxusd-bid-{month}.csv")
        ask = imom.read_side(folder / f"usatechidxusd-ask-{month}.csv")
        rows, _ = imom.mid_minutes(bid, ask)
        if not rows:
            empty.append(month)
        for t, (o, h, low, c, v) in rows:
            if cols.t and t <= cols.t[-1]:
                continue
            cols.t.append(t); cols.o.append(o); cols.h.append(h); cols.l.append(low)
            cols.c.append(c); cols.v.append(v)
    if empty:
        return None, {"status": "not run", "reason": "Q-ETH: full-session months empty", "missing": empty[:50]}, files
    return cols.minutes(MINUTE_MS), {"status": "ran", "bars": len(cols.t), "months": len(months)}, files


def aggregate_minutes(m: Minutes, minutes: int) -> Minutes:
    """Bars of `minutes` from the execution bars of each session (bucket start = multiple of the length in
    UTC, which is 09:30 New York); used for the bridge row and the MFI agreement."""
    period = minutes * MINUTE_MS
    cols = _Columns()
    for s, (lo, hi) in enumerate(session_bounds(m)):
        bars: list[list] = []
        for i in range(lo, hi):
            start = m.t[i] // period * period
            if bars and bars[-1][0] == start:
                bar = bars[-1]
                bar[3] = max(bar[3], m.h[i]); bar[4] = min(bar[4], m.l[i]); bar[5] = m.c[i]; bar[6] += m.v[i]
            else:
                bars.append([start, m.minute[i] // minutes * minutes, m.o[i], m.h[i], m.l[i], m.c[i], m.v[i]])
        cols.add_session(date.fromisoformat(m.day[s]), [tuple(bar) for bar in bars], m.scale[s], m.close_minute[s])
    return cols.minutes(period)


def bucket_gaps(m: Minutes, minutes: int) -> int:
    """Buckets of `minutes` built from fewer execution bars than they span (counted and reported)."""
    period = minutes * MINUTE_MS
    need = period // m.bar_ms
    gaps = 0
    for lo, hi in session_bounds(m):
        count, key = 0, None
        for i in range(lo, hi):
            k = m.t[i] // period
            if k != key:
                gaps += 1 if key is not None and count < need else 0
                count, key = 0, k
            count += 1
        gaps += 1 if key is not None and count < need else 0
    return gaps


def session_bounds(m: Minutes) -> list[tuple[int, int]]:
    """(first bar, end) of each session."""
    bounds: list[tuple[int, int]] = []
    start = 0
    for i in range(1, len(m.t) + 1):
        if i == len(m.t) or m.session[i] != m.session[i - 1]:
            bounds.append((start, i))
            start = i
    return bounds


@dataclass(frozen=True)
class Datasets:
    sets: Mapping[str, Minutes | None]  # "a", "a5", "b", "c", "a_full"
    info: Mapping[str, Any]
    files: tuple[Path, ...]


LOADED: Datasets | None = None  # set by `use` before a forked pool starts (workers share it copy-on-write)


def use(data: Datasets) -> None:
    global LOADED
    LOADED = data


def load_datasets(paths: DataPaths = DataPaths(), years: Years | None = None) -> Datasets:
    a, a_info, a_files = load_cfd(paths, years)
    b, b_info, b_files = load_qqq_minutes(paths, years)
    c, c_info, c_files = load_nq_minutes(paths, years)
    full, full_info, full_files = load_cfd_full(paths.m1_full, full_months(a.day))
    a_info["partialBuckets5"] = bucket_gaps(a, 5)
    a_info["partialBuckets15"] = bucket_gaps(a, 15)
    info = {name: {**data_info, **_span(m)} for name, data_info, m in
            (("a", a_info, a), ("b", b_info, b), ("c", c_info, c))}
    info["a_full"] = full_info
    info["years"] = list(years) if years is not None else None
    sets = {"a": a, "a5": aggregate_minutes(a, 5), "b": b, "c": c, "a_full": full}
    return Datasets(sets, info, (*a_files, *b_files, *c_files, *full_files))


def _span(m: Minutes) -> dict:
    return {"from": m.day[0] if m.day else None, "to": m.day[-1] if m.day else None, "bars": len(m.t)}


def file_sha256(path: Path) -> str:
    with path.open("rb") as fh:
        return hashlib.file_digest(fh, "sha256").hexdigest()


def data_manifest(files: Iterable[Path]) -> list[dict]:
    """Every input file with its size and SHA-256 (the data stay on the rig; the manifest makes them checkable)."""
    return [{"path": str(path), "bytes": path.stat().st_size, "sha256": file_sha256(path)} for path in files]


# --- jobs ----------------------------------------------------------------------------------------------

def trade_record(m: Minutes, trade: Trade) -> dict:
    """A rule-module trade plus its fill times in minutes after 09:30 (entry open, exit open or close)."""
    bar_minutes = m.bar_ms // MINUTE_MS
    exit_minute = m.minute[trade.exit_bar] + (bar_minutes if trade.exit_reason == "close" else 0)
    return {**asdict(trade), "entryMinute": m.minute[trade.entry_bar], "exitMinute": exit_minute,
            "day": m.day[trade.session]}


def trade_of(record: Mapping) -> Trade:
    return Trade(**{name: record[name] for name in Trade.__dataclass_fields__})


def _job_header(job: Job) -> dict:
    return {"schema": SCHEMA, "job": job.name, "kind": job.kind, "row": job.row, "dataset": job.dataset,
            "params": asdict(job.params), "paramsKey": job.params.key(), "specSha256": rules.SPEC_SHA256}


def _finished(path: Path, job: Job) -> dict | None:
    """The stored output of `job`, or None when it is missing or from other parameters or another spec."""
    if not path.exists():
        return None
    try:
        stored = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    header = _job_header(job)
    return stored if all(stored.get(key) == header[key] for key in ("kind", "paramsKey", "specSha256")) else None


def _session_minutes(m: Minutes) -> int:
    return sum(m.close_minute)


def trades_payload(m: Minutes, params: Params, full: Minutes | None = None) -> dict:
    result = rules.trades(m, params, full)
    return {"status": "ran", "sessions": len(m.day), "days": list(m.day), "barMinutes": m.bar_ms // MINUTE_MS,
            "sessionMinutes": _session_minutes(m), "trades": [trade_record(m, trade) for trade in result]}


def _trades_job(job: Job, data: Datasets) -> dict:
    m = data.sets[job.dataset]
    if m is None:
        return {"status": "not run", "reason": f"dataset {job.dataset} not loaded"}
    full = data.sets["a_full"] if job.params.full_session else None
    if job.params.full_session and full is None:
        return {"status": "not run", "reason": data.info["a_full"].get("reason", "Q-ETH failed")}
    return trades_payload(m, job.params, full)


def _row_trades(out_dir: Path, row: str, dataset: str, data: Datasets) -> list[dict]:
    """The trades of a graded row from its job file, else computed now."""
    variant = BY_ROW[row]
    stored = _finished(out_dir / f"{row}-{dataset}.json", Job("trades", row, dataset, variant.params, 1))
    if stored is not None and stored.get("status") == "ran":
        return stored["trades"]
    return trades_payload(data.sets[dataset], variant.params)["trades"]  # type: ignore[arg-type]


def run_job(job: Job, out_dir: Path, data: Datasets | None = None) -> dict:
    """Runs one job unless its file is already there; returns {"job", "status", "seconds", "skipped"}."""
    path = out_dir / f"{job.name}.json"
    stored = _finished(path, job)
    if stored is not None:
        return {"job": job.name, "status": stored.get("status"), "seconds": stored.get("seconds"), "skipped": True}
    data = data or LOADED
    if data is None:
        raise RuntimeError("no datasets loaded (call study.use first)")
    started = time.time()
    if job.kind == "trades":
        payload = _trades_job(job, data)
    elif job.kind == "random":
        payload = random_control(data.sets["a"], _row_trades(out_dir, "P1", "a", data))  # type: ignore[arg-type]
    elif job.kind == "nautilus":
        records = _row_trades(out_dir, job.row, job.dataset, data)
        payload = nautilus_check(data.sets[job.dataset], records)  # type: ignore[arg-type]
    elif job.kind == "mfi":
        payload = mfi_agreement(data.sets["a5"], data.sets["c"])  # type: ignore[arg-type]
    else:
        raise ValueError(f"unknown job kind {job.kind}")
    payload = {**_job_header(job), **payload, "seconds": round(time.time() - started, 3)}
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    temp.replace(path)
    return {"job": job.name, "status": payload.get("status"), "seconds": payload["seconds"], "skipped": False}


# --- booking -------------------------------------------------------------------------------------------

def trade_net(trade: Trade, slip_ticks: int) -> float:
    """points x $20 - $4.50 - 2 x slippage ticks x $5."""
    return trade.points * POINT_USD - FEES_USD - 2 * slip_ticks * TICK_USD


def ledger(trades: Sequence[Trade], slip_ticks: int) -> list[float]:
    """Net dollars of each trade at `slip_ticks` per side."""
    return [trade_net(trade, slip_ticks) for trade in trades]


def session_pnl(trades: Sequence[Trade], sessions: int, slip_ticks: int) -> list[float]:
    """Net dollars per session (a session without a trade counts 0)."""
    out = [0.0] * sessions
    for trade, net in zip(trades, ledger(trades, slip_ticks), strict=True):
        out[trade.session] += net
    return out


def per_year(days: Sequence[str], pnl: Sequence[float]) -> dict[int, float]:
    out: dict[int, float] = {}
    for day, value in zip(days, pnl, strict=True):
        year = int(day[:4])
        out[year] = out.get(year, 0.0) + value
    return out


def full_years(days: Sequence[str]) -> list[int]:
    """Calendar years the data cover from the first to the last trading week (2004 and 2026 are partial)."""
    first: dict[int, str] = {}
    last: dict[int, str] = {}
    for day in days:
        year = int(day[:4])
        first.setdefault(year, day)
        last[year] = day
    return [year for year in first if first[year][5:] <= "01-07" and last[year][5:] >= "12-24"]


def max_drawdown(pnl: Sequence[float]) -> float:
    """Largest peak-to-trough fall of the cumulative dollars (positive number)."""
    return nbf.max_drawdown_usd(pnl)


def time_in_market(records: Sequence[Mapping], session_minutes: float) -> float:
    held = sum(record["exitMinute"] - record["entryMinute"] for record in records)
    return held / session_minutes if session_minutes > 0 else 0.0


def sharpe(values: Sequence[float]) -> float:
    """Per-observation Sharpe (mean / sample standard deviation); 0 without variation."""
    if len(values) < 2:
        return 0.0
    sd = statistics.stdev(values)
    return statistics.fmean(values) / sd if sd > 0 else 0.0


def moments(values: Sequence[float]) -> tuple[float, float]:
    """Skew and raw (non-excess) kurtosis."""
    mean = statistics.fmean(values)
    m2 = sum((x - mean) ** 2 for x in values) / len(values)
    if m2 <= 0:
        return 0.0, 3.0
    m3 = sum((x - mean) ** 3 for x in values) / len(values)
    m4 = sum((x - mean) ** 4 for x in values) / len(values)
    return m3 / m2 ** 1.5, m4 / m2 ** 2


def capital_curve(days: Sequence[str], pnl: Sequence[float]) -> dict:
    """Returns on the $100,000 capital basis per contract (no compounding): CAGR, max drawdown (negative
    fraction of the peak equity) and month-end points."""
    equity, peak, worst = CAPITAL, CAPITAL, 0.0
    months: dict[str, dict] = {}
    for day, value in zip(days, pnl, strict=True):
        equity += value
        peak = max(peak, equity)
        drawdown = equity / peak - 1 if peak > 0 else -1.0
        worst = min(worst, drawdown)
        months[day[:7]] = {"month": day[:7], "value": max(-1.0, equity / CAPITAL - 1),
                           "drawdown": max(-1.0, min(0.0, drawdown))}
    years = (date.fromisoformat(days[-1]) - date.fromisoformat(days[0])).days / 365.25 if days else 0.0
    ratio = equity / CAPITAL
    cagr = (ratio ** (1 / years) - 1 if ratio > 0 else -1.0) if years > 0 else 0.0
    return {"cagr": max(-1.0, cagr), "maxDrawdown": max(-1.0, worst), "months": list(months.values())}


def row_stats(records: Sequence[Mapping], days: Sequence[str], session_minutes: float, slip_ticks: int) -> dict:
    """Dollar statistics of one row at one slippage."""
    trades = [trade_of(record) for record in records]
    nets = ledger(trades, slip_ticks)
    pnl = session_pnl(trades, len(days), slip_ticks)
    wins = sum(x for x in nets if x > 0)
    losses = -sum(x for x in nets if x < 0)
    count = len(trades)
    gross = sum(trade.points for trade in trades) * POINT_USD
    curve = capital_curve(days, pnl)
    per_session = sharpe(pnl)
    return {
        "slipTicks": slip_ticks, "trades": count, "grossUsd": gross, "feesUsd": count * FEES_USD,
        "slippageUsd": count * 2 * slip_ticks * TICK_USD, "netUsd": sum(nets),
        "grossPerTrade": gross / count if count else 0.0, "netPerTrade": sum(nets) / count if count else 0.0,
        "winRate": sum(1 for x in nets if x > 0) / count if count else 0.0,
        "profitFactor": wins / losses if losses > 0 else None, "maxDrawdownUsd": max_drawdown(pnl),
        "sessionSharpe": per_session, "sharpe": per_session * math.sqrt(SESSIONS_PER_YEAR),
        "timeInMarket": time_in_market(records, session_minutes),
        "perYear": {str(year): value for year, value in per_year(days, pnl).items()},
        "cagr": curve["cagr"], "maxDrawdown": curve["maxDrawdown"],
    }


# --- tests and diagnostics -----------------------------------------------------------------------------

def walk_forward(net_by_year: Mapping[str, Mapping[int, float]], available: Sequence[int],
                 test_years: Sequence[int] = WF_TEST_YEARS, first: int = WF_FIRST_TRAIN,
                 min_train: int = WF_MIN_TRAIN_YEARS) -> dict:
    """Anchored walk-forward: the training years (first .. test year - 1, at least `min_train` full years)
    pick the row with the highest net (ties: the earlier row), booked in the test year. `available`: the full
    years of the data."""
    folds = []
    for year in test_years:
        train = [y for y in range(first, year) if y in available]
        if len(train) < min_train or year not in available:
            continue
        scores = {row: sum(by_year.get(y, 0.0) for y in train) for row, by_year in net_by_year.items()}
        pick = max(scores, key=lambda row: scores[row])  # max keeps the first of equal scores
        folds.append({"year": year, "pick": pick, "trainNet": scores[pick],
                      "testNet": net_by_year[pick].get(year, 0.0)})
    stitched = sum(fold["testNet"] for fold in folds) if folds else None
    return {"folds": folds, "stitchedNet": stitched, "testYears": [fold["year"] for fold in folds]}


def _random_trade(m: Minutes, bounds: Sequence[tuple[int, int]], record: Mapping, rng: random.Random,
                  slip_ticks: int) -> float:
    """One P1 trade moved to a random other session at the same minute, same side and holding minutes (cut
    at the close); its net dollars."""
    held = record["exitMinute"] - record["entryMinute"]
    sessions = len(bounds)
    for _ in range(1000):
        s = rng.randrange(sessions - 1)
        s += 1 if s >= record["session"] else 0
        lo, hi = bounds[s]
        entry = bisect.bisect_left(m.minute, record["entryMinute"], lo, hi)
        if entry < hi:
            break
    else:
        raise ValueError("no session has a bar at the entry minute")
    end = bisect.bisect_left(m.minute, m.minute[entry] + held, entry + 1, hi)
    exit_price = m.o[end] if end < hi else m.c[hi - 1]
    points = record["side"] * (exit_price - m.o[entry]) * m.scale[s]
    return points * POINT_USD - FEES_USD - 2 * slip_ticks * TICK_USD


def random_control(m: Minutes, records: Sequence[Mapping], seed: int = SEED, draws: int | None = None,
                   slip_ticks: int = BASE_TICKS) -> dict:
    """T7: mean net per trade of P1 against `draws` (default DRAWS = 1,000) random-entry copies of its trades
    (seed 7)."""
    draws = DRAWS if draws is None else draws
    if not records:
        return {"status": "ran", "draws": draws, "seed": seed, "trades": 0, "p95": None, "actual": None, "pass": None}
    if len(m.day) < 2:
        raise ValueError("the random-entry control needs at least two sessions")
    rng = random.Random(seed)
    bounds = session_bounds(m)
    means = sorted(statistics.fmean(_random_trade(m, bounds, record, rng, slip_ticks) for record in records)
                   for _ in range(draws))
    p95 = means[math.ceil(0.95 * draws) - 1]
    actual = statistics.fmean(ledger([trade_of(record) for record in records], slip_ticks))
    return {"status": "ran", "draws": draws, "seed": seed, "trades": len(records), "p95": p95,
            "drawMean": statistics.fmean(means), "actual": actual, "pass": actual > p95}


def _year_windows(m: Minutes) -> list[tuple[int, int, int]]:
    """(year, first bar, end) of each calendar year (no position crosses a session, so years are independent)."""
    out: list[tuple[int, int, int]] = []
    for s, (lo, hi) in enumerate(session_bounds(m)):
        year = int(m.day[s][:4])
        if out and out[-1][0] == year:
            out[-1] = (year, out[-1][1], hi)
        else:
            out.append((year, lo, hi))
    return out


def nautilus_check(m: Minutes, records: Sequence[Mapping], tolerance: float = 1e-6) -> dict:
    """Books the rule module's entry and exit arrays in NautilusTrader (`run_signal_backtest`, long and short as
    separate runs, one year at a time, no costs) and compares entry/exit bars and fill prices."""
    from nautilus_backtest import engine

    try:
        engine.require()
    except engine.NautilusUnavailable as error:
        return {"status": "not run", "reason": str(error)[:200]}
    trades = [trade_of(record) for record in records]
    mismatches: list[dict] = []
    booked = 0
    for year, lo, hi in _year_windows(m):
        for side in (1, -1):
            ours = [t for t in trades if t.side == side and lo <= t.entry_bar < hi]
            theirs = engine_trades(m, trades, side, lo, hi)
            booked += len(theirs)
            mismatches += compare_fills(ours, theirs, tolerance, year, side)
    return {"status": "ran", "engine": engine.ENGINE_ID, "trades": len(trades), "booked": booked,
            "same": not mismatches and booked == len(trades), "mismatches": mismatches[:20]}


def engine_trades(m: Minutes, trades: Sequence[Trade], side: int, lo: int, hi: int) -> list[tuple]:
    """(entry bar, exit bar, entry price, exit price, reason) of the NautilusTrader run of bars lo..hi-1."""
    from nautilus_backtest.bars import Bars
    from nautilus_backtest.engine import run_signal_backtest
    from nautilus_backtest.signals import Compiled, RunOptions

    signals, exits, close_at = rules.signal_arrays(m, trades, side)
    bars = Bars.from_columns({"t": m.t[lo:hi], "o": m.o[lo:hi], "h": m.h[lo:hi], "l": m.l[lo:hi], "c": m.c[lo:hi]})
    compiled = Compiled(signals=tuple(signals[lo:hi]), exits=tuple(exits[lo:hi]), stop_distance=None,
                        target_distance=None, close_at=tuple(close_at[lo:hi]))
    options = RunOptions(cost_bps=0, stop_loss_pct=0, take_profit_pct=0, costs=None,
                         side="short" if side < 0 else None)
    result = run_signal_backtest(bars, compiled, options)
    return [(t["entryIndex"] + lo, t["exitIndex"] + lo, t["entryPrice"], t["exitPrice"], t["exitReason"])
            for t in result.trades]


def compare_fills(ours: Sequence[Trade], theirs: Sequence[tuple], tolerance: float, year: int,
                  side: int) -> list[dict]:
    out = []
    for index in range(max(len(ours), len(theirs))):
        a = ours[index] if index < len(ours) else None
        b = theirs[index] if index < len(theirs) else None
        same = (a is not None and b is not None and a.entry_bar == b[0] and a.exit_bar == b[1]
                and math.isclose(a.entry_price, b[2], rel_tol=tolerance, abs_tol=tolerance)
                and math.isclose(a.exit_price, b[3], rel_tol=tolerance, abs_tol=tolerance))
        if not same:
            out.append({"year": year, "side": side, "rule": None if a is None else
                        [a.entry_bar, a.exit_bar, a.entry_price, a.exit_price, a.exit_reason],
                        "engine": None if b is None else list(b)})
    return out


def mfi_agreement(a5: Minutes, c: Minutes, length: int = MFI_LENGTH) -> dict:
    """Share of common 5-minute bars (CFD tick volume vs NQ volume) where MFI(hlc3) >= 50 agrees."""
    if a5 is None or c is None:
        return {"status": "not run", "reason": "dataset missing"}
    common_days = set(a5.day) & set(c.day)

    def states(m: Minutes) -> dict[int, bool]:
        hlc3 = [(h + low + close) / 3 for h, low, close in zip(m.h, m.l, m.c, strict=True)]
        values = mfi(hlc3, m.v, length)
        return {m.t[i]: values[i] >= 50 for i in range(len(values))
                if not math.isnan(values[i]) and m.day[m.session[i]] in common_days}

    cfd, nq = states(a5), states(c)
    shared = sorted(set(cfd) & set(nq))
    agree = sum(1 for t in shared if cfd[t] == nq[t])
    return {"status": "ran", "days": len(common_days), "bars": len(shared),
            "agreement": agree / len(shared) if shared else None}


# --- assemble ------------------------------------------------------------------------------------------

def _load(out_dir: Path, name: str) -> dict | None:
    path = out_dir / f"{name}.json"
    return json.loads(path.read_text()) if path.exists() else None


def row_result(variant: Variant, stored: Mapping | None) -> dict:
    out: dict[str, Any] = {"row": variant.row, "dataset": variant.dataset, "change": variant.change,
                           "params": asdict(variant.params)}
    if stored is None or stored.get("status") != "ran":
        out["status"] = "missing" if stored is None else stored.get("status", "not run")
        out["reason"] = None if stored is None else stored.get("reason")
        return out
    days = stored["days"]
    out.update({"status": "ran", "sessions": stored["sessions"], "from": days[0] if days else None,
                "to": days[-1] if days else None, "fullYears": full_years(days), "seconds": stored.get("seconds"),
                "stats": {str(tick): row_stats(stored["trades"], days, stored["sessionMinutes"], tick)
                          for tick in SLIPPAGE_TICKS}})
    return out


def _session_series(stored: Mapping, slip_ticks: int) -> list[float]:
    return session_pnl([trade_of(r) for r in stored["trades"]], stored["sessions"], slip_ticks)


def _years_profitable(row: Mapping, tick: int, window: Years | None = None) -> tuple[int, int]:
    years = [y for y in row.get("fullYears", []) if window is None or window[0] <= y <= window[1]]
    per = row["stats"][str(tick)]["perYear"]
    return sum(1 for y in years if per.get(str(y), 0.0) > 0), len(years)


def deflated_sharpe(series: Mapping[str, Sequence[float]], primary: str = "P1", n_trials: int = N_TRIALS) -> dict:
    """T4: per-session Sharpe of the primary row against the variance of the per-session Sharpes of every
    row that ran, raw N = 33, skew and kurtosis of the primary."""
    sharpes = [sharpe(values) for values in series.values()]
    values = series[primary]
    skew, kurtosis = moments(values)
    try:
        result = deflated_sharpe_ratio(sharpe(values), n_trials, statistics.variance(sharpes), len(values),
                                       skew, kurtosis)
    except (ValueError, statistics.StatisticsError) as error:
        return {"probability": None, "error": str(error)[:200]}
    return {"probability": result.probability, "sharpe": result.sharpe, "expectedMax": result.expected_max_sharpe,
            "variance": result.sharpe_variance, "observations": result.n_observations, "skew": skew,
            "kurtosis": kurtosis, "trials": n_trials, "rows": len(sharpes)}


def _test(test_id: str, name: str, passed: bool | None, value: str) -> dict:
    return {"id": test_id, "name": name, "pass": passed, "value": value}


def grade(rows: Mapping[str, Mapping], series: Mapping[str, Sequence[float]], wf: Mapping,
          random_ctl: Mapping | None) -> list[dict]:
    """T1-T7 (1 tick per side on P1 unless stated); `pass` None = could not be computed (not a pass)."""
    p1, p3 = rows["P1"], rows["P3"]
    ran = p1.get("status") == "ran"
    base = p1["stats"][str(BASE_TICKS)] if ran else None
    out = []
    if base is None:
        return [_test(f"T{n}", "P1 did not run", None, "P1 not run") for n in range(1, 8)]
    stitched = wf["stitchedNet"]
    t1 = base["netUsd"] > 0 and stitched is not None and stitched > 0
    walk = "n/a" if stitched is None else f"${stitched:,.0f}"
    out.append(_test("T1", "Net P&L > 0 (full span and walk-forward test years)",
                     t1 if stitched is not None or base["netUsd"] <= 0 else None,
                     f"P1 ${base['netUsd']:,.0f}; walk-forward {walk}"))
    low, high = nbf.bootstrap_ci(series["P1"])
    out.append(_test("T2", "Bootstrap 95% interval of mean P&L per session above 0", low > 0,
                     f"[{low:,.2f}, {high:,.2f}] $/session"))
    k1, n1 = _years_profitable(p1, BASE_TICKS)
    k3, n3 = _years_profitable(p3, BASE_TICKS) if p3.get("status") == "ran" else (0, 0)
    t3 = None if n1 == 0 or n3 == 0 else (k1 >= PROFITABLE_YEARS * n1 and k3 >= PROFITABLE_YEARS * n3)
    out.append(_test("T3", "At least 75% of full years profitable (P1 and P3)", t3,
                     f"P1 {k1}/{n1}, P3 {k3}/{n3}"))
    dsr = deflated_sharpe(series)
    probability = dsr["probability"]
    out.append(_test("T4", "Deflated Sharpe probability > 0.95 (N = 33)",
                     None if probability is None else probability > DSR_PASS,
                     "n/a" if probability is None else f"{probability:.3f}"))
    out.append(_test("T5", "Average gross P&L per trade >= $80", base["grossPerTrade"] >= MIN_GROSS_PER_TRADE,
                     f"${base['grossPerTrade']:,.2f} on {base['trades']} trades"))
    stress = p1["stats"][str(STRESS_TICKS)]["netUsd"]
    out.append(_test("T6", "Net P&L > 0 at 2 ticks per side", stress > 0, f"${stress:,.0f}"))
    rc = random_ctl or {}
    out.append(_test("T7", "Mean net per trade above the random-entry 95th percentile", rc.get("pass"),
                     "n/a" if rc.get("p95") is None else f"${rc['actual']:,.2f} vs p95 ${rc['p95']:,.2f}"))
    return out


def outcome_of(tests: Sequence[Mapping]) -> tuple[str, str | None]:
    """"reconstruction passed" when T1-T7 all pass; otherwise the first test that did not pass decides."""
    for test in tests:
        if test["pass"] is not True:
            return "reconstruction failed", test["id"]
    return "reconstruction passed", None


def _correlation(left: Mapping[str, float], right: Mapping[str, float]) -> dict:
    days = sorted(set(left) & set(right))
    xs, ys = [left[d] for d in days], [right[d] for d in days]
    try:
        value = statistics.correlation(xs, ys) if len(days) >= 2 else None
    except statistics.StatisticsError:
        value = None
    return {"sessions": len(days), "correlation": value, "left": sum(xs), "right": sum(ys)}


def _by_day(stored: Mapping | None, tick: int = BASE_TICKS) -> dict[str, float]:
    if stored is None or stored.get("status") != "ran":
        return {}
    return dict(zip(stored["days"], _session_series(stored, tick), strict=True))


def diagnostics(out_dir: Path, rows: Mapping[str, Mapping], stored: Mapping[str, Mapping | None]) -> dict:
    extra = {v.row: row_result(v, _load(out_dir, f"{v.row}-{v.dataset}")) for v in DIAGNOSTICS}
    nq = _load(out_dir, "NQ-c")
    return {
        "rows": extra,
        "tracking": {"nqVsP3": _correlation(_by_day(nq), _by_day(stored.get("P3"))),
                     "nqVsP1": _correlation(_by_day(nq), _by_day(stored.get("P1")))},
        "randomControl": _load(out_dir, "random-P1-a"),
        "nautilus": {row: _load(out_dir, f"nautilus-{row}-{BY_ROW[row].dataset}") for row in NAUTILUS_ROWS},
        "mfi": _load(out_dir, "mfi-MFI-a5c"),
        "v8": rows["V8"].get("status"),
    }


def assemble(out_dir: Path, data_info: Mapping | None = None, *, pilot: bool = False) -> dict:
    """The results document: every row at 0, 1 and 2 ticks, walk-forward, tests T1-T7, outcome, diagnostics,
    data manifest (`data.json` written by run.py, or `data_info`)."""
    out_dir = Path(out_dir)
    stored = {v.row: _load(out_dir, f"{v.row}-{v.dataset}") for v in VARIANTS}
    rows = {v.row: row_result(v, stored[v.row]) for v in VARIANTS}
    ran = [row for row, result in rows.items() if result["status"] == "ran"]
    series = {row: _session_series(stored[row], BASE_TICKS) for row in ran}  # type: ignore[arg-type]
    a_rows = {row: {int(y): v for y, v in rows[row]["stats"][str(BASE_TICKS)]["perYear"].items()}
              for row in ran if BY_ROW[row].dataset == "a"}
    available = rows["P1"].get("fullYears", [])
    wf = walk_forward(a_rows, available)
    extra = diagnostics(out_dir, rows, stored)
    tests = grade(rows, series, wf, extra["randomControl"])
    outcome, deciding = outcome_of(tests)
    claim = {"years": CLAIM_YEARS, "window": list(CLAIM_WINDOW)}
    for row in ("P1", "P3"):
        if rows[row]["status"] == "ran":
            claim[row] = {str(t): list(_years_profitable(rows[row], t)) for t in (0, BASE_TICKS)}
    if rows["P3"]["status"] == "ran":
        claim["P3window"] = {str(t): list(_years_profitable(rows["P3"], t, CLAIM_WINDOW)) for t in (0, BASE_TICKS)}
    info = data_info if data_info is not None else (_load(out_dir, "data") or {})
    curve = (capital_curve(stored["P1"]["days"], series["P1"])["months"]  # type: ignore[index]
             if "P1" in series else [])
    return {
        "schema": SCHEMA, "study": "trend-trio", "pilot": pilot, "specSha256": rules.SPEC_SHA256,
        "costs": {"pointUsd": POINT_USD, "tickPoints": 0.25, "tickUsd": TICK_USD, "feesUsd": FEES_USD,
                  "slippageTicks": list(SLIPPAGE_TICKS), "baseTicks": BASE_TICKS, "capital": CAPITAL},
        "trials": {"n": N_TRIALS, "ran": len(ran)},
        "rows": [rows[v.row] for v in VARIANTS], "walkForward": wf, "tests": tests, "outcome": outcome,
        "decidingTest": deciding, "claim": claim, "diagnostics": extra, "curve": curve,
        "data": info, "provenance": {},
    }
