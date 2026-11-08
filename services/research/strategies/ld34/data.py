"""Market data of the LD34 reel study (research only).

Hourly candles come from the public Dukascopy datafeed (bid and ask, with volume),
fetched by research/backtests/ld34/fetch_data.py into a folder on the rig
(default ~/Documents/reports/vertex-reel-dffcosd-data/h1, env VERTEX_LD34_DATA).
The data is not in the repository: it is not ours to redistribute.

A bar is the mid of the bid and ask candles: open, high, low and close are the
averages of the two sides; volume is the sum. The spread cost of an instrument
is the median close-to-close bid/ask spread in basis points of the mid.
Timestamps are UTC milliseconds of the bar open.
"""
from __future__ import annotations

import csv
import os
import statistics
from dataclasses import dataclass
from pathlib import Path

DATA_ENV = "VERTEX_LD34_DATA"
DEFAULT_ROOT = Path.home() / "Documents" / "reports" / "vertex-reel-dffcosd-data" / "h1"
BPS = 10_000


@dataclass(frozen=True)
class Instrument:
    """One tested market. `source` is the Dukascopy instrument id."""

    key: str
    source: str
    label: str
    group: str  # reel-sheet | reel-results | core7 | etf-twin
    asset_class: str  # index | fx | metal | energy | crypto | etf
    max_leverage: float
    slippage_bps: float
    twin: str | None = None  # Core 7 ETF twin whose options express the signal


# Leverage caps: ESMA retail CFD limits (index 20, major FX 30, other FX and gold 20,
# other commodities 10, crypto 2); ETFs: Reg T overnight margin 2.
INSTRUMENTS: tuple[Instrument, ...] = (
    Instrument("SPX500", "usa500idxusd", "S&P 500 index CFD", "reel-sheet", "index", 20, 1.0, "SPY"),
    Instrument("NAS100", "usatechidxusd", "Nasdaq-100 index CFD", "reel-sheet", "index", 20, 1.0, "QQQ"),
    Instrument("BTCUSD", "btcusd", "Bitcoin / USD", "reel-sheet", "crypto", 2, 5.0),
    Instrument("USDJPY", "usdjpy", "USD/JPY", "reel-results", "fx", 30, 0.5),
    Instrument("GBPJPY", "gbpjpy", "GBP/JPY", "reel-results", "fx", 20, 0.5),
    Instrument("AUDJPY", "audjpy", "AUD/JPY", "reel-results", "fx", 20, 0.5),
    Instrument("CHFJPY", "chfjpy", "CHF/JPY", "reel-results", "fx", 20, 0.5),
    Instrument("EURJPY", "eurjpy", "EUR/JPY", "reel-results", "fx", 20, 0.5),
    Instrument("XAUUSD", "xauusd", "Gold / USD", "reel-results", "metal", 20, 1.0, "GLD"),
    Instrument("US30", "usa30idxusd", "Dow 30 index CFD", "core7", "index", 20, 1.0, "DIA"),
    Instrument("US2000", "ussc2000idxusd", "Russell 2000 index CFD", "core7", "index", 20, 1.0, "IWM"),
    Instrument("XAGUSD", "xagusd", "Silver / USD", "core7", "metal", 10, 2.0, "SLV"),
    Instrument("WTI", "lightcmdusd", "WTI light crude CFD", "core7", "energy", 10, 2.0, "USO"),
    Instrument("SPY", "spyususd", "SPY ETF", "etf-twin", "etf", 2, 1.0),
    Instrument("QQQ", "qqqususd", "QQQ ETF", "etf-twin", "etf", 2, 1.0),
    Instrument("DIA", "diaususd", "DIA ETF", "etf-twin", "etf", 2, 1.0),
    Instrument("IWM", "iwmususd", "IWM ETF", "etf-twin", "etf", 2, 1.0),
    Instrument("GLD", "gldususd", "GLD ETF", "etf-twin", "etf", 2, 1.0),
    Instrument("SLV", "slvususd", "SLV ETF", "etf-twin", "etf", 2, 1.0),
    Instrument("USO", "usoususd", "USO ETF", "etf-twin", "etf", 2, 1.0),
)
BY_KEY = {item.key: item for item in INSTRUMENTS}
# The Core 7 markets: the index, metal and energy CFDs stand in for the futures.
CORE7 = ("SPX500", "NAS100", "US30", "US2000", "XAUUSD", "XAGUSD", "WTI")
ETF_TWINS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
REEL_SHEET = ("SPX500", "NAS100", "BTCUSD")


@dataclass(frozen=True)
class HourlyData:
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


def _read(path: Path) -> dict[int, tuple[float, float, float, float, float]]:
    rows: dict[int, tuple[float, float, float, float, float]] = {}
    with path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            rows[int(row["timestamp"])] = (float(row["open"]), float(row["high"]), float(row["low"]),
                                           float(row["close"]), float(row.get("volume") or 0.0))
    return rows


def merge_sides(bid: dict[int, tuple], ask: dict[int, tuple]) -> HourlyData:
    """Mid bars on the timestamps both sides have, in time order, and the median spread."""
    times = sorted(set(bid) & set(ask))
    if len(times) < 2:
        raise ValueError("Fewer than 2 bars with both bid and ask")
    o, h, low, c, v, spreads = [], [], [], [], [], []
    for t in times:
        b, a = bid[t], ask[t]
        mid = [(b[i] + a[i]) / 2 for i in range(4)]
        # Keep the bar consistent after averaging the two sides.
        hi = max(mid)
        lo = min(mid)
        o.append(mid[0])
        h.append(hi)
        low.append(lo)
        c.append(mid[3])
        v.append(b[4] + a[4])
        if mid[3] > 0 and a[3] >= b[3]:
            spreads.append((a[3] - b[3]) / mid[3] * BPS)
    return HourlyData(tuple(float(t) for t in times), tuple(o), tuple(h), tuple(low), tuple(c), tuple(v),
                      statistics.median(spreads) if spreads else 0.0)


def load_hourly(key: str, root: str | os.PathLike | None = None) -> HourlyData:
    """Mid H1 bars of one instrument from its bid and ask files."""
    item = BY_KEY[key]
    folder = data_root(root)
    bid = _read(folder / f"{item.source}-h1-bid.csv")
    ask = _read(folder / f"{item.source}-h1-ask.csv")
    return merge_sides(bid, ask)
