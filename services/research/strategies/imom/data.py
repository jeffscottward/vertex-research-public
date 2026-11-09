"""Market data of the intraday-momentum reel study (research only).

One-minute candles come from the public Dukascopy datafeed (bid and ask, tick volume), fetched by
research/backtests/imom/fetch_data.py into a folder on the rig (default
~/Documents/reports/vertex-reel-dffkn31-data/m1, env VERTEX_IMOM_DATA): `<instrument>-bid.csv.gz` and
`<instrument>-ask.csv.gz` with UTC millisecond bar-open timestamps, already cut to weekdays 09:30-16:00
New York. The data is not in the repository: it is not ours to redistribute.

A one-minute mid bar is the average of the bid and ask candles field by field (high and low widened to
hold the open and close); its volume is the bid volume. The spread cost of a market is the median
close bid/ask spread in basis points of the mid. Mid bars are aggregated to 5-minute bars aligned to
09:30 New York (bar time = UTC ms of the bar open). Session days are New York dates. Dropped: NYSE
holidays and special closures, and sessions with fewer than 30 five-minute bars. NYSE early-close days
(13:00) keep their bars up to 13:00 only (42 bars), so no 15:30 decision exists on those days.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import os
import pickle
import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from strategies.qc_ports.calendar import is_nyse_holiday

DATA_ENV = "VERTEX_IMOM_DATA"
DEFAULT_ROOT = Path.home() / "Documents" / "reports" / "vertex-reel-dffkn31-data" / "m1"
NEW_YORK = ZoneInfo("America/New_York")
BPS = 10_000
MINUTE_MS = 60_000
BAR_MINUTES = 5
OPEN_MINUTE = 9 * 60 + 30
CLOSE_MINUTE = 16 * 60
EARLY_CLOSE_MINUTE = 13 * 60
MIN_SESSION_BARS = 30
CACHE_VERSION = 1
# NYSE full-day closures outside the regular holiday rules (Hurricane Sandy, national days of mourning).
SPECIAL_CLOSURES = frozenset({date(2012, 10, 29), date(2012, 10, 30), date(2018, 12, 5), date(2025, 1, 9)})


@dataclass(frozen=True)
class Instrument:
    """One tested market. `source` is the Dukascopy instrument id; `twin` is the ETF whose options express it."""

    key: str
    source: str
    label: str
    group: str  # futures-proxy | etf-twin
    asset_class: str  # index | metal | energy | etf
    twin: str
    slippage_bps: float = 1.0


INSTRUMENTS: tuple[Instrument, ...] = (
    Instrument("US500", "usa500idxusd", "S&P 500 index CFD (ES proxy)", "futures-proxy", "index", "SPY"),
    Instrument("NAS100", "usatechidxusd", "Nasdaq-100 index CFD (NQ proxy)", "futures-proxy", "index", "QQQ"),
    Instrument("US30", "usa30idxusd", "Dow 30 index CFD (YM proxy)", "futures-proxy", "index", "DIA"),
    Instrument("US2000", "ussc2000idxusd", "Russell 2000 index CFD (RTY proxy)", "futures-proxy", "index", "IWM"),
    Instrument("XAUUSD", "xauusd", "Gold / USD (GC proxy)", "futures-proxy", "metal", "GLD"),
    Instrument("XAGUSD", "xagusd", "Silver / USD (SI proxy)", "futures-proxy", "metal", "SLV"),
    Instrument("WTI", "lightcmdusd", "WTI light crude CFD (CL proxy)", "futures-proxy", "energy", "USO"),
    Instrument("SPY", "spyususd", "SPY ETF", "etf-twin", "etf", "SPY"),
    Instrument("QQQ", "qqqususd", "QQQ ETF", "etf-twin", "etf", "QQQ"),
    Instrument("DIA", "diaususd", "DIA ETF", "etf-twin", "etf", "DIA"),
    Instrument("IWM", "iwmususd", "IWM ETF", "etf-twin", "etf", "IWM"),
    Instrument("GLD", "gldususd", "GLD ETF", "etf-twin", "etf", "GLD"),
    Instrument("SLV", "slvususd", "SLV ETF", "etf-twin", "etf", "SLV"),
    Instrument("USO", "usoususd", "USO ETF", "etf-twin", "etf", "USO"),
)
BY_KEY = {item.key: item for item in INSTRUMENTS}
PRIMARY = "US500"
FUTURES_PROXIES = ("US500", "NAS100", "US30", "US2000", "XAUUSD", "XAGUSD", "WTI")
ETF_TWINS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")

Minute = tuple[float, float, float, float, float]


@dataclass(frozen=True)
class SessionBars:
    """5-minute mid bars of the kept sessions, in time order."""

    t: tuple[float, ...]
    o: tuple[float, ...]
    h: tuple[float, ...]
    l: tuple[float, ...]
    c: tuple[float, ...]
    v: tuple[float, ...]
    spread_bps: float

    def columns(self) -> dict[str, list[float]]:
        return {"t": list(self.t), "o": list(self.o), "h": list(self.h), "l": list(self.l),
                "c": list(self.c), "v": list(self.v)}

    def __len__(self) -> int:
        return len(self.t)


def data_root(root: str | os.PathLike | None = None) -> Path:
    if root is not None:
        return Path(root)
    env = os.environ.get(DATA_ENV)
    return Path(env) if env else DEFAULT_ROOT


def files_of(key: str, root: str | os.PathLike | None = None) -> tuple[Path, Path]:
    item = BY_KEY[key]
    folder = data_root(root)
    return folder / f"{item.source}-bid.csv.gz", folder / f"{item.source}-ask.csv.gz"


def available(key: str, root: str | os.PathLike | None = None) -> bool:
    return all(path.exists() for path in files_of(key, root))


def read_side(path: Path) -> dict[int, Minute]:
    rows: dict[int, Minute] = {}
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if header is None:
            return rows
        for row in reader:
            rows[int(row[0])] = (float(row[1]), float(row[2]), float(row[3]), float(row[4]),
                                 float(row[5]) if len(row) > 5 and row[5] else 0.0)
    return rows


def mid_minutes(bid: Mapping[int, Minute], ask: Mapping[int, Minute]) -> tuple[list[tuple[int, Minute]], float]:
    """Mid one-minute bars on the timestamps both sides have (volume = bid volume) and the median spread in bps."""
    out: list[tuple[int, Minute]] = []
    spreads: list[float] = []
    for t in sorted(set(bid) & set(ask)):
        b, a = bid[t], ask[t]
        o, h, low, c = ((b[i] + a[i]) / 2 for i in range(4))
        out.append((t, (o, max(o, h, c), min(o, low, c), c, b[4])))
        if c > 0 and a[3] >= b[3]:
            spreads.append((a[3] - b[3]) / c * BPS)
    return out, (statistics.median(spreads) if spreads else 0.0)


def is_closed(day: date) -> bool:
    return day.weekday() >= 5 or is_nyse_holiday(day) or day in SPECIAL_CLOSURES


def is_early_close(day: date) -> bool:
    """NYSE 13:00 closes: July 3 and December 24 on Monday to Thursday, the day after Thanksgiving."""
    if day.weekday() >= 4 and not (day.month == 11 and day.weekday() == 4):
        return False
    if (day.month, day.day) in {(7, 3), (12, 24)}:
        return day.weekday() <= 3
    if day.month == 11 and day.weekday() == 4:
        return 23 <= day.day <= 29
    return False


class _Clock:
    """New York local date and minute of day of UTC ms timestamps (offset cached per UTC day; the
    regular session never spans a DST switch)."""

    def __init__(self) -> None:
        self._offsets: dict[int, int] = {}

    def local(self, t_ms: int) -> tuple[date, int]:
        utc_day = t_ms // 86_400_000
        offset = self._offsets.get(utc_day)
        if offset is None:
            noon = datetime.fromtimestamp(utc_day * 86_400 + 43_200, UTC).astimezone(NEW_YORK)
            offset = int(noon.utcoffset().total_seconds() * 1000)
            self._offsets[utc_day] = offset
        local_ms = t_ms + offset
        minute = (local_ms // MINUTE_MS) % 1440
        return date.fromordinal(date(1970, 1, 1).toordinal() + local_ms // 86_400_000), minute


def aggregate(minutes: Iterable[tuple[int, Minute]], spread_bps: float = 0.0) -> SessionBars:
    """5-minute bars aligned to 09:30 New York; drops closed days, cuts early closes at 13:00 and drops
    sessions with fewer than MIN_SESSION_BARS bars."""
    clock = _Clock()
    sessions: dict[date, list[list[float]]] = {}
    for t, (o, h, low, c, v) in minutes:
        day, minute = clock.local(t)
        close = EARLY_CLOSE_MINUTE if is_early_close(day) else CLOSE_MINUTE
        if not OPEN_MINUTE <= minute < close or is_closed(day):
            continue
        start = t - ((minute - OPEN_MINUTE) % BAR_MINUTES) * MINUTE_MS
        bars = sessions.setdefault(day, [])
        if bars and bars[-1][0] == start:
            bar = bars[-1]
            bar[2] = max(bar[2], h)
            bar[3] = min(bar[3], low)
            bar[4] = c
            bar[5] += v
        else:
            bars.append([float(start), o, h, low, c, v])
    cols: list[list[float]] = [[], [], [], [], [], []]
    for day in sorted(sessions):
        bars = sessions[day]
        if len(bars) < MIN_SESSION_BARS:
            continue
        for bar in bars:
            for index in range(6):
                cols[index].append(bar[index])
    if len(cols[0]) < 2:
        raise ValueError("Fewer than 2 five-minute bars")
    return SessionBars(*(tuple(col) for col in cols), spread_bps=spread_bps)


def data_hash(keys: Sequence[str], root: str | os.PathLike | None = None) -> str:
    """sha256 over the input files (name and content) of the given markets."""
    digest = hashlib.sha256()
    for key in keys:
        for path in files_of(key, root):
            digest.update(path.name.encode())
            with path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _cache_path(key: str, root: str | os.PathLike | None) -> tuple[Path, tuple]:
    bid, ask = files_of(key, root)
    stamp = (CACHE_VERSION, bid.stat().st_size, bid.stat().st_mtime_ns, ask.stat().st_size, ask.stat().st_mtime_ns)
    return data_root(root).parent / "m5-cache" / f"{BY_KEY[key].source}.pkl", stamp


def load_bars(key: str, root: str | os.PathLike | None = None, *, cache: bool = True) -> SessionBars:
    """5-minute mid bars of one market (cached next to the data folder, keyed by the input file stamps)."""
    path, stamp = _cache_path(key, root)
    if cache and path.exists():
        with path.open("rb") as fh:
            saved = pickle.load(fh)  # noqa: S301 - our own cache file on the rig
        if saved.get("stamp") == stamp:
            return saved["bars"]
    bid_path, ask_path = files_of(key, root)
    minutes, spread = mid_minutes(read_side(bid_path), read_side(ask_path))
    bars = aggregate(minutes, spread)
    if cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with tmp.open("wb") as fh:
            pickle.dump({"stamp": stamp, "bars": bars}, fh)
        tmp.replace(path)
    return bars


def local_times(times: Sequence[float]) -> list[tuple[str, int]]:
    """(New York date, minute of day of the bar open) of each bar time."""
    clock = _Clock()
    out = []
    for t in times:
        day, minute = clock.local(int(t))
        out.append((day.isoformat(), minute))
    return out


def daily_closes(bars: SessionBars) -> list[tuple[str, float]]:
    """(session day, close of its last bar) in order."""
    out: list[tuple[str, float]] = []
    for (day, _), close in zip(local_times(bars.t), bars.c):
        if out and out[-1][0] == day:
            out[-1] = (day, close)
        else:
            out.append((day, close))
    return out


def ms_at(day: str, minute: int) -> float:
    """UTC ms of a New York local date and minute of day."""
    local = datetime.fromisoformat(day).replace(hour=minute // 60, minute=minute % 60, tzinfo=NEW_YORK)
    return local.timestamp() * 1000


def next_day(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()
