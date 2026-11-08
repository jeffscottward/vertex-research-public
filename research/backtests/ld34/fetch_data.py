#!/usr/bin/env python3
"""Dukascopy public H1 candles (bid + ask, with volume) for the LD34 reel backtest.

Research only; the data stays on the rig (not redistributed, not in the repo).
Fetches year by year; a failing year is retried month by month; months that still fail are logged.
Output: h1/<instrument>-h1-<side>.csv with header timestamp,open,high,low,close,volume (UTC ms, bar open time).
"""
import csv
import os
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(os.environ.get("VERTEX_LD34_DATA_ROOT", Path.home() / "Documents" / "reports" / "vertex-reel-dffcosd-data"))
OUT = ROOT / "h1"
END = date(2026, 11, 7)
LIST = [
    ("usa500idxusd", date(2012, 1, 16)), ("usatechidxusd", date(2013, 1, 1)), ("btcusd", date(2017, 5, 8)),
    ("usdjpy", date(2003, 5, 5)), ("gbpjpy", date(2003, 8, 4)), ("audjpy", date(2003, 12, 1)),
    ("chfjpy", date(2003, 8, 4)), ("eurjpy", date(2003, 8, 4)), ("xauusd", date(2003, 5, 5)),
    ("xagusd", date(2003, 5, 5)), ("lightcmdusd", date(2013, 1, 1)), ("usa30idxusd", date(2013, 9, 30)),
    ("ussc2000idxusd", date(2018, 8, 8)), ("spyususd", date(2017, 2, 16)), ("qqqususd", date(2017, 1, 26)),
    ("diaususd", date(2017, 5, 11)), ("iwmususd", date(2017, 1, 26)), ("gldususd", date(2017, 1, 26)),
    ("slvususd", date(2018, 2, 1)), ("usoususd", date(2017, 1, 26)),
]


def fetch(inst: str, side: str, start: date, end: date, timeframe: str = "h1") -> list[list[str]] | None:
    with tempfile.TemporaryDirectory() as tmp:
        cmd = ["npx", "-y", "dukascopy-node@1.51.1", "-i", inst, "-from", start.isoformat(), "-to", end.isoformat(),
               "-t", timeframe, "-p", side, "-v", "-f", "csv", "-dir", tmp, "-fn", "x", "-r", "3", "-bs", "10", "-bp", "300"]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=900)
        path = Path(tmp) / "x.csv"
        if proc.returncode != 0 or "wrong" in proc.stdout or not path.exists():
            return None
        with path.open() as fh:
            rows = list(csv.reader(fh))
        return rows[1:]


def hourly_from_minutes(rows: list[list[str]]) -> list[list[str]]:
    """H1 candles from M1 rows (timestamp, open, high, low, close, volume): first open, max high, min low,
    last close, summed volume per UTC hour; used where the datafeed has no H1 candles (e.g. 2013-02 indices)."""
    hours: dict[int, list[float]] = {}
    for r in rows:
        t = int(r[0]) // 3_600_000 * 3_600_000
        o, h, low, c, v = (float(x) for x in r[1:6])
        cur = hours.get(t)
        if cur is None:
            hours[t] = [o, h, low, c, v]
        else:
            cur[1], cur[2], cur[3], cur[4] = max(cur[1], h), min(cur[2], low), c, cur[4] + v
    return [[str(t), *(repr(x) for x in values)] for t, values in sorted(hours.items())]


def months(start: date, end: date):
    cur = date(start.year, start.month, 1)
    while cur < end:
        nxt = date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        yield max(cur, start), min(nxt, end)
        cur = nxt


def main() -> None:
    OUT.mkdir(exist_ok=True)
    only = set(sys.argv[1:])
    for inst, first in LIST:
        if only and inst not in only:
            continue
        for side in ("bid", "ask"):
            path = OUT / f"{inst}-h1-{side}.csv"
            if path.exists() and path.stat().st_size > 0:
                continue
            rows: dict[str, list[str]] = {}
            failed: list[str] = []
            for year in range(first.year, END.year + 1):
                a, b = max(first, date(year, 1, 1)), min(END, date(year + 1, 1, 1))
                if a >= b:
                    continue
                got = fetch(inst, side, a, b)
                if got is None:
                    for ma, mb in months(a, b):
                        sub = fetch(inst, side, ma, mb)
                        if sub is None:
                            minutes = fetch(inst, side, ma, mb, "m1")
                            sub = hourly_from_minutes(minutes) if minutes else None
                        if sub is None:
                            failed.append(ma.isoformat()[:7])
                        else:
                            for r in sub:
                                rows[r[0]] = r
                else:
                    for r in got:
                        rows[r[0]] = r
            with path.open("w", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
                for key in sorted(rows, key=int):
                    w.writerow(rows[key])
            print(f"{inst} {side} rows={len(rows)} failed_months={failed}", flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
