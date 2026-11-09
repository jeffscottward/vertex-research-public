"""Market data of the intraday-momentum reel study (research only).

One-minute candles come from the public Dukascopy datafeed (bid and ask, tick volume), fetched by
research/backtests/imom/fetch_data.py into a folder on the rig (default
~/Documents/reports/vertex-reel-dffkn31-data/m1, env VERTEX_IMOM_DATA): `<instrument>-bid.csv.gz` and
`<instrument>-ask.csv.gz` with UTC millisecond bar-open timestamps, already cut to weekdays 09:30-16:00
New York. The data is not in the repository: it is not ours to redistribute.

A one-minute mid bar is the average of the bid and ask candles field by field (high and low widened to
hold the open and close); its volume is the bid volume. The spread cost of a market is the median
close bid/ask spread in basis points of the mid over the
in-sample part (first 60 % of the time) only. Mid bars are aggregated to 5-minute bars aligned to
09:30 New York (bar time = UTC ms of the bar open). Session days are New York dates. Dropped: NYSE
holidays and special closures, sessions with fewer than 30 five-minute bars, and sessions that open more than
30 % away from the previous close (splits such as USO 1:8 in April 2020, or bad prints). NYSE early-close days
(13:00) keep their bars up to 13:00 only (42 bars), so no 15:30 decision exists on those days.

Source `ibkr` (study `--source ibkr`): IBKR 5-minute TRADES bars (regular hours) fetched by
research/backtests/imom/fetch_ibkr.py into ~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m (env
VERTEX_IMOM_IBKR_DATA): `<SYMBOL>.csv.gz` (timestamp,open,high,low,close,volume; UTC ms of the bar open) are used
as they are as 5-minute bars, with the same session, holiday, early-close and split rules. Markets: the Core 7 ETF
twins whose file exists; primary SPY. The spread of a symbol is the median quoted spread (time-average ask minus
time-average bid, bps of their mid) of its `<SYMBOL>-bidask.csv.gz` sample bars inside the in-sample part (first 60 %
of the time) of the SPY bar window; a symbol without such a sample uses SPY's (recorded as `SPY fallback`). Half the
spread is charged per side (as for Dukascopy) plus 0.25 bp slippage per side.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import os
import pickle
import statistics
from collections.abc import Callable, Iterable, Mapping, Sequence
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
# A session whose open is more than 30 % away from the previous close is a split or data error (USO 1:8 in
# April 2020); it is dropped.
MAX_GAP = 0.30
IS_FRACTION = 0.6
CACHE_VERSION = 2
# NYSE full-day closures outside the regular holiday rules (Hurricane Sandy; national days of mourning for
# Presidents Reagan 2004-06-11, Ford 2007-01-02, G. H. W. Bush 2018-12-05 and Carter 2025-01-09).
SPECIAL_CLOSURES = frozenset({date(2004, 6, 11), date(2007, 1, 2), date(2012, 10, 29), date(2012, 10, 30),
                              date(2018, 12, 5), date(2025, 1, 9)})


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

DUKASCOPY = "dukascopy"
IBKR = "ibkr"
SOURCES = (DUKASCOPY, IBKR)
# Vertex default for intraday backtests: IBKR (owner 2026-11-09, card vertex-reel-backtest-dffkn31;
# docs/vertex-rebuild/data-sources/intraday.md). The CLI and main_study use it. The helpers below keep
# DUKASCOPY as their default because they pair `source` with the Dukascopy PRIMARY.
DEFAULT_SOURCE = IBKR
IBKR_DATA_ENV = "VERTEX_IMOM_IBKR_DATA"
IBKR_DEFAULT_ROOT = DEFAULT_ROOT.parent / "ibkr5m"
IBKR_SLIPPAGE_BPS = 0.25
IBKR_PRIMARY = "SPY"
# IBKR: the Core 7 ETF twins traded on their own bars (the file name is the symbol).
IBKR_INSTRUMENTS: tuple[Instrument, ...] = tuple(
    Instrument(key, key, f"{key} ETF (IBKR 5-minute trades)", "etf-twin", "etf", key, IBKR_SLIPPAGE_BPS)
    for key in ETF_TWINS)
IBKR_BY_KEY = {item.key: item for item in IBKR_INSTRUMENTS}
SPREAD_MEASURED = "measured"
SPREAD_FALLBACK = f"{IBKR_PRIMARY} fallback"

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


def check_source(source: str) -> str:
    if source not in SOURCES:
        raise ValueError(f"Unknown data source {source!r} (expected one of {', '.join(SOURCES)})")
    return source


def instruments(source: str = DUKASCOPY) -> tuple[Instrument, ...]:
    """The tested markets of a data source."""
    return IBKR_INSTRUMENTS if check_source(source) == IBKR else INSTRUMENTS


def instrument(key: str, source: str = DUKASCOPY) -> Instrument:
    return (IBKR_BY_KEY if check_source(source) == IBKR else BY_KEY)[key]


def primary_of(source: str = DUKASCOPY) -> str:
    """The primary market: the US500 CFD on Dukascopy, SPY on IBKR (the paper's instrument)."""
    return IBKR_PRIMARY if check_source(source) == IBKR else PRIMARY


def data_root(root: str | os.PathLike | None = None, source: str = DUKASCOPY) -> Path:
    if root is not None:
        return Path(root)
    if check_source(source) == IBKR:
        env = os.environ.get(IBKR_DATA_ENV)
        return Path(env) if env else IBKR_DEFAULT_ROOT
    env = os.environ.get(DATA_ENV)
    return Path(env) if env else DEFAULT_ROOT


def files_of(key: str, root: str | os.PathLike | None = None) -> tuple[Path, Path]:
    item = BY_KEY[key]
    folder = data_root(root)
    return folder / f"{item.source}-bid.csv.gz", folder / f"{item.source}-ask.csv.gz"


def ibkr_files(key: str, root: str | os.PathLike | None = None) -> tuple[Path, Path]:
    """(5-minute TRADES bars, BID_ASK sample) of one IBKR symbol."""
    folder = data_root(root, IBKR)
    symbol = IBKR_BY_KEY[key].source
    return folder / f"{symbol}.csv.gz", folder / f"{symbol}-bidask.csv.gz"


def available(key: str, root: str | os.PathLike | None = None, source: str = DUKASCOPY) -> bool:
    if check_source(source) == IBKR:
        return key in IBKR_BY_KEY and ibkr_files(key, root)[0].exists()
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


def mid_minutes(bid: Mapping[int, Minute], ask: Mapping[int, Minute],
                is_fraction: float = IS_FRACTION) -> tuple[list[tuple[int, Minute]], float]:
    """Mid one-minute bars on the timestamps both sides have (volume = bid volume) and the median close spread in
    bps over the in-sample part only (the first `is_fraction` of the time), so the cost model has no look-ahead."""
    out: list[tuple[int, Minute]] = []
    spreads: list[tuple[int, float]] = []
    for t in sorted(set(bid) & set(ask)):
        b, a = bid[t], ask[t]
        o, h, low, c = ((b[i] + a[i]) / 2 for i in range(4))
        out.append((t, (o, max(o, h, c), min(o, low, c), c, b[4])))
        if c > 0 and a[3] >= b[3]:
            spreads.append((t, (a[3] - b[3]) / c * BPS))
    if not out:
        return out, 0.0
    cut = out[0][0] + (out[-1][0] - out[0][0]) * is_fraction
    in_sample = [x for t, x in spreads if t <= cut]
    return out, (statistics.median(in_sample) if in_sample else 0.0)


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
    prev_close: float | None = None
    for day in sorted(sessions):
        bars = sessions[day]
        if len(bars) < MIN_SESSION_BARS:
            continue
        gap_out = prev_close is not None and prev_close > 0 and abs(bars[0][1] / prev_close - 1) > MAX_GAP
        prev_close = bars[-1][4]
        if gap_out:
            continue
        for bar in bars:
            for index in range(6):
                cols[index].append(bar[index])
    if len(cols[0]) < 2:
        raise ValueError("Fewer than 2 five-minute bars")
    return SessionBars(*(tuple(col) for col in cols), spread_bps=spread_bps)


def _stat(path: Path) -> tuple[int, int] | None:
    if not path.exists():
        return None
    st = path.stat()
    return st.st_size, st.st_mtime_ns


def _window(path: Path) -> tuple[int, int]:
    """First and last timestamp of a bar file."""
    first = last = None
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", newline="") as fh:
        reader = csv.reader(fh)
        next(reader, None)
        for row in reader:
            if not row:
                continue
            t = int(row[0])
            first = t if first is None else min(first, t)
            last = t if last is None else max(last, t)
    if first is None or last is None:
        raise ValueError(f"No bars in {path}")
    return first, last


_CUTS: dict[tuple, float] = {}


def ibkr_cut_ms(root: str | os.PathLike | None = None, is_fraction: float = IS_FRACTION) -> float:
    """End of the in-sample part of the SPY bar window (UTC ms): first + is_fraction x (last - first)."""
    path = ibkr_files(IBKR_PRIMARY, root)[0]
    if not path.exists():
        raise FileNotFoundError(f"No IBKR bars for {IBKR_PRIMARY} ({path}); the spread window needs them")
    stamp = (str(path), _stat(path), is_fraction)
    if stamp not in _CUTS:
        first, last = _window(path)
        _CUTS[stamp] = first + (last - first) * is_fraction
    return _CUTS[stamp]


def bidask_median_bps(path: Path, cut_ms: float) -> float | None:
    """Median quoted spread in bps of the mid of the BID_ASK sample bars at or before `cut_ms` (open = time-average
    bid, close = time-average ask); None without such bars."""
    if not path.exists():
        return None
    spreads = []
    for t, (bid, _, _, ask, _) in read_side(path).items():
        if t <= cut_ms and bid > 0 and ask >= bid:
            spreads.append((ask - bid) / ((ask + bid) / 2) * BPS)
    return statistics.median(spreads) if spreads else None


def ibkr_spread(key: str, root: str | os.PathLike | None = None) -> tuple[float, str]:
    """(spread bps, origin) of an IBKR symbol: its own in-sample BID_ASK median (`measured`), else SPY's
    (`SPY fallback`). SPY itself needs a sample: the study does not run without a measured cost."""
    cut = ibkr_cut_ms(root)
    own = bidask_median_bps(ibkr_files(key, root)[1], cut)
    if own is not None:
        return own, SPREAD_MEASURED
    spy = bidask_median_bps(ibkr_files(IBKR_PRIMARY, root)[1], cut) if key != IBKR_PRIMARY else None
    if spy is None:
        raise FileNotFoundError(f"No IBKR BID_ASK sample of {IBKR_PRIMARY} in the in-sample window "
                                f"({ibkr_files(IBKR_PRIMARY, root)[1]})")
    return spy, SPREAD_FALLBACK


def input_files(keys: Sequence[str], root: str | os.PathLike | None = None,
                source: str = DUKASCOPY) -> list[Path]:
    """The input files of the given markets (IBKR: bars and, when present, the BID_ASK sample)."""
    if check_source(source) == IBKR:
        return [path for key in keys for path in ibkr_files(key, root) if path.exists()]
    return [path for key in keys for path in files_of(key, root)]


def data_hash(keys: Sequence[str], root: str | os.PathLike | None = None, source: str = DUKASCOPY) -> str:
    """sha256 over the input files (name and content) of the given markets."""
    digest = hashlib.sha256()
    for path in input_files(keys, root, source):
        digest.update(path.name.encode())
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _cache_path(key: str, root: str | os.PathLike | None) -> tuple[Path, tuple]:
    bid, ask = files_of(key, root)
    stamp = (CACHE_VERSION, bid.stat().st_size, bid.stat().st_mtime_ns, ask.stat().st_size, ask.stat().st_mtime_ns)
    return data_root(root).parent / "m5-cache" / f"{BY_KEY[key].source}.pkl", stamp


def _ibkr_cache_path(key: str, root: str | os.PathLike | None) -> tuple[Path, tuple]:
    files = (*ibkr_files(key, root), *ibkr_files(IBKR_PRIMARY, root))
    stamp = (CACHE_VERSION, IBKR, *(_stat(path) for path in files))
    return data_root(root, IBKR).parent / "m5-cache" / f"ibkr-{IBKR_BY_KEY[key].source}.pkl", stamp


def _cached(path: Path, stamp: tuple, build: Callable[[], SessionBars], cache: bool) -> SessionBars:
    if cache and path.exists():
        with path.open("rb") as fh:
            saved = pickle.load(fh)  # noqa: S301 - our own cache file on the rig
        if saved.get("stamp") == stamp:
            return saved["bars"]
    bars = build()
    if cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with tmp.open("wb") as fh:
            pickle.dump({"stamp": stamp, "bars": bars}, fh)
        tmp.replace(path)
    return bars


def load_ibkr_bars(key: str, root: str | os.PathLike | None = None, *, cache: bool = True) -> SessionBars:
    """IBKR 5-minute bars of one ETF twin as session bars (same rules as `aggregate`), with the in-sample BID_ASK
    spread (`ibkr_spread`)."""
    bars_path = ibkr_files(key, root)[0]

    def build() -> SessionBars:
        spread, _ = ibkr_spread(key, root)
        return aggregate(sorted(read_side(bars_path).items()), spread)

    path, stamp = _ibkr_cache_path(key, root)
    return _cached(path, stamp, build, cache)


def load_bars(key: str, root: str | os.PathLike | None = None, *, cache: bool = True,
              source: str = DUKASCOPY) -> SessionBars:
    """5-minute mid bars of one market (cached next to the data folder, keyed by the input file stamps)."""
    if check_source(source) == IBKR:
        return load_ibkr_bars(key, root, cache=cache)

    def build() -> SessionBars:
        bid_path, ask_path = files_of(key, root)
        minutes, spread = mid_minutes(read_side(bid_path), read_side(ask_path))
        return aggregate(minutes, spread)

    path, stamp = _cache_path(key, root)
    return _cached(path, stamp, build, cache)


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
