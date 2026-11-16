"""Loader of the downloaded QuantData net drift history (research only; reads under the data folder, never writes).

Layout: <root>/net-drift/<TICKER>/<part>/<YYYY-MM-DD>.json, each file the vendor's `data` object (keys epoch
milliseconds, values the one-minute bucket). The rule reads the part `total`; without it, the total of a minute is
the sum of the parts `zero_dte` and `longer` where both have the minute (`derived_total`).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from strategies.imom.data import is_closed, is_early_close, local_times

from .control import DriftMinute
from .rules import BARS, OPEN_MINUTE_OF_DAY

DATA_ENV = "VERTEX_FLOW_CONTROL_DATA"
DEFAULT_ROOT = Path.home() / ".local" / "share" / "vertex-research-data" / "flow-control"
PARTS = ("total", "zero_dte")
FALLBACK_PARTS = ("zero_dte", "longer")
TICKERS = ("SPX", "SPY", "QQQ", "NDX")
FIELDS = ("netCallPremium", "netPutPremium", "netCallVolume", "netPutVolume", "stockPrice")
MAX_PRICE_CARRY_MINUTES = 5
MIN_TOTAL_MINUTES = 300
SKIP_REASONS = ("missing", "empty", "thin", "no_open_price", "missing_price")
# First session the study reads (the download starts here; the FOMC list starts in 2025).
FIRST_DAY = "2025-01-02"
SESSION_MINUTES = 390

Bucket = tuple[float, float, float, float, float | None]


class DataError(ValueError):
    pass


def data_root(root: str | os.PathLike | None = None) -> Path:
    if root is not None:
        return Path(root).expanduser()
    env = os.environ.get(DATA_ENV)
    return Path(env).expanduser() if env else DEFAULT_ROOT


def bucket_path(root: Path, ticker: str, part: str, day: str) -> Path:
    return root / "net-drift" / ticker / part / f"{day}.json"  # json-data-ignore: vendor download on the research machine, outside the repository; the app never reads it


def _number(value, key: str, field: str, *, nullable: bool = False) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise DataError(f"bucket {key}: field {field} is not a finite number")
    return float(value)


def parse_part(text: str) -> dict[int, Bucket]:
    """Epoch ms -> (netCallPremium, netPutPremium, netCallVolume, netPutVolume, stockPrice or None)."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise DataError(f"not JSON: {error}") from error
    if not isinstance(data, dict):
        raise DataError("not an object")
    out: dict[int, Bucket] = {}
    for key, value in data.items():
        if not key.isdigit() or int(key) % 60_000 != 0:
            raise DataError(f"bucket {key}: key is not epoch milliseconds of a minute")
        if not isinstance(value, dict) or any(field not in value for field in FIELDS):
            raise DataError(f"bucket {key}: missing field")
        out[int(key)] = (_number(value["netCallPremium"], key, "netCallPremium"),
                         _number(value["netPutPremium"], key, "netPutPremium"),
                         _number(value["netCallVolume"], key, "netCallVolume"),
                         _number(value["netPutVolume"], key, "netPutVolume"),
                         _number(value["stockPrice"], key, "stockPrice", nullable=True))
    return out


@dataclass(frozen=True)
class TickerSession:
    ticker: str
    day: str
    minutes: tuple[DriftMinute, ...]
    price: tuple[float, ...]
    derived_total: bool
    files: tuple[Path, ...]


def _session_minutes(buckets: Mapping[int, Bucket], day: str) -> dict[int, Bucket]:
    keys = sorted(buckets)
    out = {}
    for key, (local_day, minute) in zip(keys, local_times(keys)):
        m = minute - OPEN_MINUTE_OF_DAY
        if local_day == day and 0 <= m < SESSION_MINUTES:
            out[m] = buckets[key]
    return out


def read_ticker(root: Path, ticker: str, day: str) -> TickerSession | str:
    total = bucket_path(root, ticker, "total", day)
    if total.exists():
        files = (total,)
        buckets = parse_part(total.read_text())
        derived = False
    else:
        parts = [bucket_path(root, ticker, part, day) for part in FALLBACK_PARTS]
        if not all(path.exists() for path in parts):
            return "missing"
        files = tuple(parts)
        zero, longer = (parse_part(path.read_text()) for path in parts)
        buckets = {}
        for key in zero.keys() & longer.keys():
            a, b = zero[key], longer[key]
            buckets[key] = (a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] if a[4] is not None else b[4])
        derived = True
        if not zero and not longer:
            return "empty"
    if not buckets:
        return "empty"
    minutes = _session_minutes(buckets, day)
    if len(minutes) < MIN_TOTAL_MINUTES:
        return "thin"
    if minutes.get(0) is None or minutes[0][4] is None:
        return "no_open_price"
    price: list[float] = []
    last, age = minutes[0][4], 0
    for b in range(BARS):
        value = minutes.get(b, (0, 0, 0, 0, None))[4]
        if value is not None:
            last, age = value, 0
        else:
            age += 1
            if age > MAX_PRICE_CARRY_MINUTES:
                return "missing_price"
        price.append(last)
    drift = tuple(DriftMinute(m, row[0], row[1]) for m, row in sorted(minutes.items()))
    return TickerSession(ticker, day, drift, tuple(price), derived, files)


def load_ticker(root: Path, ticker: str, day: str) -> TickerSession | None:
    result = read_ticker(root, ticker, day)
    return None if isinstance(result, str) else result


@dataclass(frozen=True)
class Loaded:
    days: tuple[str, ...]
    sessions: Mapping[str, Mapping[str, TickerSession]]
    skipped: tuple[dict, ...]
    early_close_days: int
    derived_total_days: int
    files: tuple[Path, ...]


def candidate_days(root: Path, first_day: str = FIRST_DAY) -> list[str]:
    days = set()
    for ticker in TICKERS:
        for part in (*PARTS, *FALLBACK_PARTS):
            folder = root / "net-drift" / ticker / part
            if folder.is_dir():
                days.update(path.stem for path in folder.iterdir() if path.suffix == ".json")
    out = []
    for day in sorted(days):
        try:
            d = date.fromisoformat(day)
        except ValueError:
            continue
        if day >= first_day and d.weekday() < 5 and not is_closed(d):
            out.append(day)
    return out


def load_all(root: Path, first_day: str = FIRST_DAY) -> Loaded:
    days, sessions, skipped, files = [], {}, [], []
    early = derived = 0
    for day in candidate_days(root, first_day):
        if is_early_close(date.fromisoformat(day)):
            early += 1
            continue
        loaded, failed = {}, []
        for ticker in TICKERS:
            result = read_ticker(root, ticker, day)
            if isinstance(result, str):
                failed.append({"day": day, "ticker": ticker, "reason": result})
            else:
                loaded[ticker] = result
        if failed:
            skipped += failed
            continue
        days.append(day)
        sessions[day] = loaded
        derived += any(s.derived_total for s in loaded.values())
        files += [path for s in loaded.values() for path in s.files]
    return Loaded(tuple(days), sessions, tuple(skipped), early, derived, tuple(files))


def data_manifest(files: Sequence[Path]) -> list[dict]:
    out = []
    for path in files:
        blob = Path(path).read_bytes()
        out.append({"path": str(path), "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()})
    return out


def data_hash(manifest: Sequence[Mapping]) -> str:
    return hashlib.sha256(json.dumps(list(manifest), sort_keys=True).encode()).hexdigest()
