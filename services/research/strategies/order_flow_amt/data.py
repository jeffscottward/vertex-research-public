"""Bars and order-flow minutes of the order flow / AMT study (research only; data stay outside the repository).

Bars (5-minute regular session; epoch seconds, open, high, low, close, volume):
- SPY: the 2008-2021 1-minute file of the noise-band study (ibkr-mt format), aggregated to 5 minutes, spliced
  before the IBKR 5-minute month files (`<ib dir>/SPY/*.csv`, from 2020-02).
- QQQ: the IBKR 5-minute month files (`<ib dir>/QQQ/*.csv`, from 2007-10).
- Forward window: Yahoo 5-minute files (`<yahoo dir>/<SYMBOL>/*.csv`, same columns), used only after the last
  IBKR session.
Ex-dividend dates: `<dividends dir>/<SYMBOL>.csv` (ex_date, amount); those sessions are not traded.
Order-flow minutes: a CSV export of `flow_minutes` (symbol, minute_ms, delta, buy_volume, sell_volume, volume,
covered_seconds, trades, close).
"""
from __future__ import annotations

import csv
import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from strategies.noise_band import Session
from strategies.noise_band_retest import load_ib_sessions, splice, to_five_minute
from strategies.noise_band_run import load_sessions

SYMBOLS = ("SPY", "QQQ")
FLOW_COLUMNS = ("symbol", "minute_ms", "delta", "buy_volume", "sell_volume", "volume", "covered_seconds", "trades",
                "close")


@dataclass(frozen=True)
class Sources:
    ib: Path
    spy_minutes: Path | None = None
    yahoo: Path | None = None
    dividends: Path | None = None


@dataclass(frozen=True)
class FlowMinute:
    symbol: str
    minute_ms: int
    delta: float
    volume: float
    covered_seconds: int


def _files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.glob("*.csv") if p.is_file()) if directory.is_dir() else []


def input_files(sources: Sources) -> list[Path]:
    files = [f for symbol in SYMBOLS for f in _files(sources.ib / symbol)]
    if sources.spy_minutes is not None:
        files.append(sources.spy_minutes)
    if sources.yahoo is not None:
        files += [f for symbol in SYMBOLS for f in _files(sources.yahoo / symbol)]
    if sources.dividends is not None:
        files += [sources.dividends / f"{symbol}.csv" for symbol in SYMBOLS if (sources.dividends / f"{symbol}.csv").is_file()]
    return files


def read_ex_dates(path: Path) -> frozenset[str]:
    """Ex-dividend dates (column ex_date, YYYY-MM-DD) of one symbol."""
    with path.open(newline="") as handle:
        return frozenset(row["ex_date"] for row in csv.DictReader(handle))


def ex_dates_of(sources: Sources) -> dict[str, frozenset[str]]:
    out = {}
    for symbol in SYMBOLS:
        path = None if sources.dividends is None else sources.dividends / f"{symbol}.csv"
        out[symbol] = read_ex_dates(path) if path is not None and path.is_file() else frozenset()
    return out


def data_hash(files: Iterable[Path]) -> str:
    """SHA-256 over each file's name and bytes, in order."""
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def extend(early: Sequence[Session], late: Sequence[Session]) -> list[Session]:
    """`early`, then the sessions of `late` after early's last day."""
    if not early:
        return list(late)
    last = early[-1].day
    return list(early) + [s for s in late if s.day > last]


def load_symbol(symbol: str, sources: Sources) -> tuple[list[Session], dict]:
    sessions, info = load_ib_sessions(str(sources.ib / symbol))
    out = {"ib": {k: v for k, v in info.items() if k != "sessions_dropped_incomplete"}}
    out["ib"]["droppedIncomplete"] = len(info.get("sessions_dropped_incomplete") or [])
    if symbol == "SPY" and sources.spy_minutes is not None:
        minutes, minute_info = load_sessions(str(sources.spy_minutes), "ibkr-mt", {})
        sessions = splice(to_five_minute(minutes), sessions)
        dropped = minute_info.get("sessions_dropped_incomplete") or []
        out["minutes"] = {"sessions": minute_info.get("sessions_used"), "first": minute_info.get("first_session"),
                          "last": minute_info.get("last_session"),
                          "droppedIncomplete": dropped if isinstance(dropped, int) else len(dropped)}
    if sources.yahoo is not None and (sources.yahoo / symbol).is_dir():
        forward, _ = load_ib_sessions(str(sources.yahoo / symbol))
        before = len(sessions)
        sessions = extend(sessions, forward)
        out["yahoo"] = {"added": len(sessions) - before,
                        "first": sessions[before].day.isoformat() if len(sessions) > before else None}
    out["sessions"] = len(sessions)
    out["first"] = sessions[0].day.isoformat() if sessions else None
    out["last"] = sessions[-1].day.isoformat() if sessions else None
    return sessions, out


def load_all(sources: Sources) -> tuple[dict[str, list[Session]], dict]:
    sessions, info = {}, {}
    for symbol in SYMBOLS:
        sessions[symbol], info[symbol] = load_symbol(symbol, sources)
    return sessions, info


def read_flow_minutes(path: Path) -> list[FlowMinute]:
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in FLOW_COLUMNS if c not in (reader.fieldnames or ())]
        if missing:
            raise ValueError(f"{path.name}: missing columns {', '.join(missing)}")
        return [FlowMinute(row["symbol"], int(row["minute_ms"]), float(row["delta"] or 0), float(row["volume"] or 0),
                           int(row["covered_seconds"] or 0)) for row in reader]


def by_symbol(minutes: Sequence[FlowMinute]) -> Mapping[str, dict[int, FlowMinute]]:
    out: dict[str, dict[int, FlowMinute]] = {}
    for minute in minutes:
        out.setdefault(minute.symbol, {})[minute.minute_ms] = minute
    return out
