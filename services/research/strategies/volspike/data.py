"""Market data of the volume-spike-breakout study (research only).

1-minute Dukascopy bid and ask candles with tick volume, on the rig (not in the repository):
- the seven CFD markets, full trading session: research/backtests/volspike/fetch_data.py writes
  `<root>/m1/<instrument>-{bid,ask}.csv.gz` (root: VERTEX_VOLSPIKE_DATA_ROOT, default
  ~/Documents/reports/vertex-volume-spike-data);
- the seven ETF twins, New York regular session only: the files of the market-intraday-momentum study
  (VERTEX_IMOM_DATA, default ~/Documents/reports/vertex-reel-dffkn31-data/m1).

A mid bar is the average of the bid and ask candle field by field on the timestamps both sides have (high and
low widened to hold the open and close); volume = bid volume + ask volume; the quoted spread of a bar is its
ask close minus its bid close. Arrays are float32 prices and int64 times; one market is about 100 MB. Parsed
bars are cached as .npy files under `<root>/cache`, keyed by the size and mtime of the two input files.

ETF twins only: a session that opens more than 30 % away from the previous close is a split (USO 1:8, April
2020); earlier prices are multiplied by the ratio so the series is continuous (percent stops do not change).

The Dukascopy ETF files are ETF-CFD candles with regular-hours tick volume only, so the volume test is not
a test there. The ETF twins that have IBKR history are tested on real exchange volume instead: IBKR 5-minute
TRADES bars, regular hours, `<ibkr root>/<SYMBOL>.csv.gz` (VERTEX_IMOM_IBKR_DATA, default
~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m; header timestamp,open,high,low,close,volume; UTC ms of
the bar open), fetched by another job. This module only reads them: each file once, whole, into memory (one
retry when the gzip stream is cut because the file is being rewritten), bars inside [2018-01-01, end of the
study window) only. A file that does not reach back to the first session of 2018 is "pending".
"""
from __future__ import annotations

import gzip
import hashlib
import io
import os
import time
import zlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from strategies.imom import data as imom_data

from . import rules

DATA_ENV = "VERTEX_VOLSPIKE_DATA_ROOT"
DEFAULT_ROOT = Path.home() / "Documents" / "reports" / "vertex-volume-spike-data"
CACHE_VERSION = 2
BPS = 10_000
MAX_SPLIT_GAP = 0.30

PRIMARY = "NAS100"
# The source's markets that Dukascopy has (NAS100 is the primary; USOIL = light crude).
SOURCE_MARKETS = ("US500", "US30", "US2000", "XAUUSD", "WTI")
CORE7_PROXIES = ("US500", "NAS100", "US30", "US2000", "XAUUSD", "XAGUSD", "WTI")
ETF_TWINS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
CFD_MARKETS = CORE7_PROXIES
ALL_MARKETS = CFD_MARKETS + ETF_TWINS
OPTIONS_TWIN = "QQQ"
IBKR_BAR_MINUTES = 5
IBKR_TWINS = ("SPY", "QQQ", "IWM", "DIA")  # the twins the IBKR history job covers; a missing file there is "pending"
IBKR_FROM = "2018-01-01"  # bars before it are not used; 2018 warms the indicators up. A file whose first bar is two
# days or more after it (2018-01-02 is the first session) does not reach back: the twin is "pending".
REGULAR_OPEN = 9 * 60 + 30
REGULAR_CLOSE = 16 * 60
ETF_NOT_TESTABLE = ("no exchange-volume intraday history on the rig; the Dukascopy ETF-CFD files have regular-hours "
                    "tick volume only")
ETF_PENDING = "IBKR 5-minute history is pending (no file that reaches back to 2018-01-01 at run time); " + ETF_NOT_TESTABLE
ETF_NO_SPREAD = "no measured bid/ask spread for the cost model"
ETF_TESTED = "tested-ibkr"
ETF_UNTESTED = "not-testable"


def instrument(key: str) -> imom_data.Instrument:
    """Label, Dukascopy id and ETF twin of a market (the table of the market-intraday-momentum study)."""
    return imom_data.BY_KEY[key]


def is_etf(key: str) -> bool:
    return instrument(key).asset_class == "etf"


def data_root(root: str | os.PathLike | None = None) -> Path:
    if root is not None:
        return Path(root)
    env = os.environ.get(DATA_ENV)
    return Path(env) if env else DEFAULT_ROOT


def files_of(key: str, root: str | os.PathLike | None = None,
             twin_root: str | os.PathLike | None = None) -> tuple[Path, Path]:
    source = instrument(key).source
    folder = imom_data.data_root(twin_root) if is_etf(key) else data_root(root) / "m1"
    return folder / f"{source}-bid.csv.gz", folder / f"{source}-ask.csv.gz"


def missing_months(key: str, root: str | os.PathLike | None = None,
                   twin_root: str | os.PathLike | None = None) -> dict[str, list[str]]:
    """Months a market's files were written without (fetch_data.py --allow-missing): file name -> ISO first
    days, from the `<file>.missing` record next to each file. Empty when the files are complete."""
    out: dict[str, list[str]] = {}
    for path in files_of(key, root, twin_root):
        record = path.with_name(path.name + ".missing")
        if record.exists():
            months = [line.strip() for line in record.read_text().splitlines() if line.strip()]
            if months:
                out[path.name] = months
    return out


def available(key: str, root: str | os.PathLike | None = None, twin_root: str | os.PathLike | None = None) -> bool:
    return all(path.exists() for path in files_of(key, root, twin_root))


@dataclass(frozen=True)
class MarketBars:
    """The 1-minute mid bars of one market and the quoted spread of each bar (price units, float32)."""

    key: str
    minutes: rules.Minutes
    spread: np.ndarray
    splits: tuple[tuple[str, float], ...] = ()  # (New York date, price ratio) of each adjusted split

    def __len__(self) -> int:
        return len(self.minutes)


def read_side(path: Path) -> dict[str, np.ndarray]:
    """One side's candles as columns (pandas parser; only used when the cache is cold)."""
    import pandas as pd

    table = pd.read_csv(path, header=0, names=["t", "o", "h", "l", "c", "v"],
                        dtype={"t": "int64", "o": "float64", "h": "float64", "l": "float64", "c": "float64",
                               "v": "float64"})
    table = table.drop_duplicates("t").sort_values("t")
    return {name: table[name].to_numpy() for name in table.columns}


def mid_bars(bid: dict[str, np.ndarray], ask: dict[str, np.ndarray]) -> tuple[rules.Minutes, np.ndarray]:
    """Mid bars on the timestamps both sides have, and the bar spreads (ask close - bid close)."""
    t, ib, ia = np.intersect1d(bid["t"], ask["t"], assume_unique=True, return_indices=True)
    o = (bid["o"][ib] + ask["o"][ia]) / 2
    c = (bid["c"][ib] + ask["c"][ia]) / 2
    h = np.maximum.reduce([(bid["h"][ib] + ask["h"][ia]) / 2, o, c])
    low = np.minimum.reduce([(bid["l"][ib] + ask["l"][ia]) / 2, o, c])
    v = np.nan_to_num(bid["v"][ib]) + np.nan_to_num(ask["v"][ia])
    spread = ask["c"][ia] - bid["c"][ib]
    f32 = np.float32
    return (rules.Minutes(t.astype(np.int64), o.astype(f32), h.astype(f32), low.astype(f32), c.astype(f32),
                          v.astype(f32)), spread.astype(f32))


def adjust_splits(m: rules.Minutes, limit: float = MAX_SPLIT_GAP) -> tuple[rules.Minutes, tuple[tuple[str, float], ...]]:
    """Back-adjusts sessions that open more than `limit` away from the previous close (regular-session data)."""
    if len(m) < 2:
        return m, ()
    day = rules.ny_local_ms(m.t) // rules.DAY_MS
    starts = np.flatnonzero(day[1:] != day[:-1]) + 1
    previous = m.c[starts - 1].astype(np.float64)
    opened = m.o[starts].astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = opened / previous
    jumps = np.flatnonzero((previous > 0) & (np.abs(ratio - 1) > limit))
    if jumps.shape[0] == 0:
        return m, ()
    factor = np.ones(len(m), dtype=np.float64)
    found = []
    for index in jumps:
        factor[:starts[index]] *= ratio[index]
        found.append((rules.day_text(day[starts[index]]), float(ratio[index])))
    f32 = np.float32
    return (rules.Minutes(m.t, (m.o * factor).astype(f32), (m.h * factor).astype(f32), (m.l * factor).astype(f32),
                          (m.c * factor).astype(f32), m.v), tuple(found))


def _stamp(paths: Sequence[Path]) -> str:
    return "|".join([str(CACHE_VERSION), *(f"{p.name}:{p.stat().st_size}:{p.stat().st_mtime_ns}" for p in paths)])


CACHE_COLUMNS = ("t", "o", "h", "l", "c", "v", "spread")


def load_market(key: str, root: str | os.PathLike | None = None, twin_root: str | os.PathLike | None = None, *,
                cache: bool = True) -> MarketBars:
    """The mid bars of one market. The parsed columns are cached as .npy files next to the data; `stamp.npy`
    (written last) holds the size and mtime of the two input files and makes the cache valid."""
    bid_path, ask_path = files_of(key, root, twin_root)
    folder = data_root(root) / "cache" / instrument(key).source
    stamp = _stamp([bid_path, ask_path])
    stamp_path = folder / "stamp.npy"
    if cache and stamp_path.exists() and str(np.load(stamp_path)) == stamp:
        cols = {name: np.load(folder / f"{name}.npy") for name in CACHE_COLUMNS}
        days, ratios = np.load(folder / "split_days.npy"), np.load(folder / "split_ratios.npy")
        return MarketBars(key, rules.Minutes(*(cols[name] for name in CACHE_COLUMNS[:6])), cols["spread"],
                          tuple((str(d), float(r)) for d, r in zip(days, ratios)))
    minutes, spread = mid_bars(read_side(bid_path), read_side(ask_path))
    splits: tuple[tuple[str, float], ...] = ()
    if is_etf(key):
        minutes, splits = adjust_splits(minutes)
    if cache:
        folder.mkdir(parents=True, exist_ok=True)
        stamp_path.unlink(missing_ok=True)
        columns = (minutes.t, minutes.o, minutes.h, minutes.l, minutes.c, minutes.v, spread)
        for name, column in zip(CACHE_COLUMNS, columns):
            np.save(folder / f"{name}.npy", column)
        np.save(folder / "split_days.npy", np.array([d for d, _ in splits], dtype="U10"))
        np.save(folder / "split_ratios.npy", np.array([r for _, r in splits], dtype=np.float64))
        np.save(stamp_path, np.array(stamp))
    return MarketBars(key, minutes, spread, splits)


def window_slice(t: np.ndarray, start_ms: int, end_ms: int) -> slice:
    return slice(int(np.searchsorted(t, start_ms, side="left")), int(np.searchsorted(t, end_ms, side="left")))


def spread_stats(bars: MarketBars, start_ms: int, end_ms: int) -> dict:
    """Median quoted spread of the 1-minute bars in [start_ms, end_ms): basis points of the mid close (the
    Vertex spread cost, half per side) and price units; None values when the window has no bars."""
    part = window_slice(bars.minutes.t, start_ms, end_ms)
    close = bars.minutes.c[part].astype(np.float64)
    spread = bars.spread[part].astype(np.float64)
    keep = (close > 0) & (spread >= 0)
    if not keep.any():
        return {"bps": None, "points": None, "bars": 0}
    return {"bps": float(np.median(spread[keep] / close[keep] * BPS)), "points": float(np.median(spread[keep])),
            "bars": int(keep.sum())}


def spread_at(bars: MarketBars, indexes: Sequence[int]) -> dict:
    """Median quoted spread at the given 1-minute bars (the fill minutes of a trade list; information only)."""
    index = np.asarray(indexes, dtype=np.int64)
    if index.shape[0] == 0:
        return {"bps": None, "points": None, "bars": 0}
    close = bars.minutes.c[index].astype(np.float64)
    spread = bars.spread[index].astype(np.float64)
    keep = (close > 0) & (spread >= 0)
    if not keep.any():
        return {"bps": None, "points": None, "bars": 0}
    return {"bps": float(np.median(spread[keep] / close[keep] * BPS)), "points": float(np.median(spread[keep])),
            "bars": int(keep.sum())}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def combined_hash(hashes: dict[str, str]) -> str:
    """One sha256 over '<file name> <sha256>' lines sorted by name (the fetcher's manifest hash)."""
    text = "".join(f"{name} {hashes[name]}\n" for name in sorted(hashes))
    return hashlib.sha256(text.encode()).hexdigest()


def file_hashes(paths: Sequence[Path]) -> dict[str, str]:
    return {path.name: sha256_of(path) for path in paths}


def data_hash(root: str | os.PathLike | None = None) -> tuple[str, dict[str, str]]:
    """('sha256:<hash>', per-file hashes) over every fetched full-session file under `<root>/m1`."""
    hashes = file_hashes(sorted((data_root(root) / "m1").glob("*.csv.gz")))
    return "sha256:" + combined_hash(hashes), hashes


def summary_of(bars: MarketBars) -> dict:
    """Row count and first and last bar (UTC) of the mid bars."""
    t = bars.minutes.t
    if t.shape[0] == 0:
        return {"rows": 0, "firstBar": None, "lastBar": None}

    def iso(ms: int) -> str:
        return str(np.datetime64(int(ms), "ms").astype("datetime64[m]")) + "Z"

    return {"rows": int(t.shape[0]), "firstBar": iso(t[0]), "lastBar": iso(t[-1])}


# ------------------------------------------------------------------------------------------------
# IBKR 5-minute bars of the ETF twins (real exchange volume)


def ibkr_file(key: str, ibkr_root: str | os.PathLike | None = None, sample: bool = False) -> Path:
    """The IBKR 5-minute TRADES bars of an ETF, or (`sample`) its BID_ASK sample bars."""
    folder = imom_data.data_root(ibkr_root, imom_data.IBKR)
    return folder / (f"{key}-bidask.csv.gz" if sample else f"{key}.csv.gz")


READ_WAIT = 2.0  # seconds before the one retry of a cut read


def read_once(path: Path, *, retries: int = 1, wait: float | None = None, reader=None) -> bytes:
    """The whole decompressed file, read once into memory. A cut gzip stream (another job is rewriting the
    file) is read again after `wait` seconds (READ_WAIT), `retries` times."""
    reader = reader or (lambda p: gzip.decompress(p.read_bytes()))
    wait = READ_WAIT if wait is None else wait
    for attempt in range(retries + 1):
        try:
            return reader(path)
        except (EOFError, OSError, zlib.error):
            if attempt == retries:
                raise
            time.sleep(wait)
    raise AssertionError("unreachable")


def parse_bars(raw: bytes) -> dict[str, np.ndarray]:
    """Columns t, o, h, l, c, v of a bar file (header row first), sorted by time, one row per timestamp."""
    import pandas as pd

    table = pd.read_csv(io.BytesIO(raw), header=0, names=["t", "o", "h", "l", "c", "v"],
                        dtype={"t": "int64", "o": "float64", "h": "float64", "l": "float64", "c": "float64",
                               "v": "float64"})
    table = table.drop_duplicates("t").sort_values("t")
    return {name: table[name].to_numpy() for name in table.columns}


@dataclass(frozen=True)
class IbkrBars:
    """Regular-session 5-minute bars of one ETF inside the wanted window, or the reason there are none."""

    key: str
    minutes: rules.Minutes | None
    reason: str | None = None
    rows_in_file: int = 0
    first_in_file: str | None = None
    last_in_file: str | None = None
    sha256: str | None = None  # of the bars used (stable while the fetch job adds older or newer bars)
    splits: tuple[tuple[str, float], ...] = ()

    @property
    def available(self) -> bool:
        return self.minutes is not None


def regular_hours(cols: dict[str, np.ndarray]) -> np.ndarray:
    """Mask of the bars that open on a weekday from 09:30 to before 16:00 New York."""
    local = rules.ny_local_ms(cols["t"])
    minute = (local // rules.MINUTE_MS) % 1440
    weekday = (local // rules.DAY_MS + 3) % 7
    return (minute >= REGULAR_OPEN) & (minute < REGULAR_CLOSE) & (weekday < 5)


def ibkr_bars(key: str, cols: dict[str, np.ndarray], start_ms: int, end_ms: int, reach_ms: int) -> IbkrBars:
    """The bars of [start_ms, end_ms) as study bars; "pending" when the file starts at or after `reach_ms`."""
    t = cols["t"]
    if t.shape[0] == 0:
        return IbkrBars(key, None, "the IBKR file has no bars")

    def iso(ms: int) -> str:
        return str(np.datetime64(int(ms), "ms").astype("datetime64[m]")) + "Z"

    described = {"rows_in_file": int(t.shape[0]), "first_in_file": iso(t[0]), "last_in_file": iso(t[-1])}
    if int(t[0]) >= reach_ms:
        return IbkrBars(key, None, ETF_PENDING, **described)
    keep = regular_hours(cols) & (t >= start_ms) & (t < end_ms) & (cols["c"] > 0)
    if int(keep.sum()) < 2:
        return IbkrBars(key, None, "the IBKR file has no bars in the study window", **described)
    f32 = np.float32
    o, c = cols["o"][keep], cols["c"][keep]
    minutes = rules.Minutes(t[keep].astype(np.int64), o.astype(f32),
                            np.maximum.reduce([cols["h"][keep], o, c]).astype(f32),
                            np.minimum.reduce([cols["l"][keep], o, c]).astype(f32), c.astype(f32),
                            np.nan_to_num(cols["v"][keep]).astype(f32))
    digest = hashlib.sha256()
    for column in (minutes.t, minutes.o, minutes.h, minutes.l, minutes.c, minutes.v):
        digest.update(np.ascontiguousarray(column).tobytes())
    minutes, splits = adjust_splits(minutes)
    return IbkrBars(key, minutes, None, sha256=digest.hexdigest(), splits=splits, **described)


READ_ERRORS = (EOFError, OSError, zlib.error, ValueError)  # a cut or broken gzip stream, a file that does not parse


def load_ibkr(key: str, ibkr_root: str | os.PathLike | None, end_ms: int, from_day: str = IBKR_FROM) -> IbkrBars:
    """IBKR 5-minute bars of one ETF twin for the study: from `from_day` (2018-01-01; that year warms the
    indicators up) to before `end_ms`. The file must start within two days of `from_day`, else it is pending.
    A file that cannot be read after the retry makes the twin not testable; it does not stop the study."""
    path = ibkr_file(key, ibkr_root)
    if not path.exists():
        return IbkrBars(key, None, ETF_PENDING if key in IBKR_TWINS else ETF_NOT_TESTABLE)
    try:
        cols = parse_bars(read_once(path))
    except READ_ERRORS as error:
        return IbkrBars(key, None, f"the IBKR file could not be read after one retry ({type(error).__name__}); "
                                   + ETF_NOT_TESTABLE)
    start_ms = rules.ny_ms(from_day)
    return ibkr_bars(key, cols, start_ms, end_ms, start_ms + 2 * rules.DAY_MS)


def quoted_spread(cols: dict[str, np.ndarray], start_ms: int, end_ms: int) -> dict:
    """Median quoted spread of IBKR BID_ASK sample bars (open = time-average bid, close = time-average ask)
    inside [start_ms, end_ms): basis points of their mid and price units; None values without such bars."""
    t, bid, ask = cols["t"], cols["o"], cols["c"]
    keep = (t >= start_ms) & (t < end_ms) & (bid > 0) & (ask >= bid)
    if not keep.any():
        return {"bps": None, "points": None, "bars": 0}
    width = ask[keep] - bid[keep]
    return {"bps": float(np.median(width / ((ask[keep] + bid[keep]) / 2) * BPS)), "points": float(np.median(width)),
            "bars": int(keep.sum())}


def ibkr_quoted_spread(key: str, ibkr_root: str | os.PathLike | None, start_ms: int, end_ms: int) -> dict:
    path = ibkr_file(key, ibkr_root, sample=True)
    if not path.exists():
        return {"bps": None, "points": None, "bars": 0}
    try:
        return quoted_spread(parse_bars(read_once(path)), start_ms, end_ms)
    except READ_ERRORS:
        # No usable sample: the caller falls back to the Dukascopy spread.
        return {"bps": None, "points": None, "bars": 0}


__all__ = [
    "ALL_MARKETS", "CFD_MARKETS", "CORE7_PROXIES", "DATA_ENV", "ETF_NOT_TESTABLE", "ETF_NO_SPREAD", "ETF_PENDING",
    "ETF_TESTED", "ETF_TWINS", "ETF_UNTESTED", "IBKR_BAR_MINUTES", "IBKR_FROM", "IBKR_TWINS", "OPTIONS_TWIN", "PRIMARY",
    "SOURCE_MARKETS", "IbkrBars", "MarketBars", "adjust_splits", "available", "combined_hash", "data_hash",
    "data_root", "file_hashes", "files_of", "ibkr_bars", "ibkr_file", "ibkr_quoted_spread", "instrument", "is_etf",
    "load_ibkr", "load_market", "mid_bars", "missing_months", "parse_bars", "quoted_spread", "read_once", "read_side",
    "regular_hours",
    "sha256_of", "spread_at", "spread_stats", "summary_of", "window_slice",
]
