#!/usr/bin/env python3
"""Dukascopy public 1-minute candles (bid + ask, tick volume) for the intraday-momentum reel backtest.

Research only; the data stays on the rig (not redistributed, not in the repo). Vertex has no stored
intraday history (vertex-history is a live IBKR proxy that ends "now"), so this is the free source.
Fetches month by month; a failing month is retried once; months that still fail are logged.
Output: m1/<instrument>-<side>.csv.gz with header timestamp,open,high,low,close,volume
(UTC ms, bar open time), New York regular session only (09:30 <= time < 16:00 New York).
"""
import csv
import gzip
import os
import subprocess
import sys
import tempfile
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(os.environ.get("VERTEX_IMOM_DATA_ROOT", Path.home() / "Documents" / "reports" / "vertex-reel-dffkn31-data"))
OUT = ROOT / "m1"
END = date(2026, 11, 7)
NY = ZoneInfo("America/New_York")
# (Dukascopy id, first month with data). ETF CFDs are the Core 7 ETF twins; the index/metal/oil CFDs are the futures proxies.
LIST = [
    ("spyususd", date(2017, 2, 16)), ("qqqususd", date(2017, 1, 26)), ("diaususd", date(2017, 5, 11)),
    ("iwmususd", date(2017, 1, 26)), ("gldususd", date(2017, 1, 26)), ("slvususd", date(2018, 2, 1)),
    ("usoususd", date(2017, 1, 26)), ("usa500idxusd", date(2012, 1, 16)), ("usatechidxusd", date(2013, 1, 1)),
    ("usa30idxusd", date(2013, 9, 30)), ("ussc2000idxusd", date(2018, 8, 8)), ("xauusd", date(2012, 1, 2)),
    ("xagusd", date(2012, 1, 2)), ("lightcmdusd", date(2013, 1, 1)),
]


def fetch(inst: str, side: str, start: date, end: date) -> list[list[str]] | None:
    with tempfile.TemporaryDirectory() as tmp:
        cmd = ["npx", "-y", "dukascopy-node@1.51.1", "-i", inst, "-from", start.isoformat(), "-to", end.isoformat(),
               "-t", "m1", "-p", side, "-v", "-f", "csv", "-dir", tmp, "-fn", "x", "-r", "3", "-bs", "10", "-bp", "300"]
        proc = subprocess.run(cmd, cwd=ROOT, check=False, capture_output=True, text=True, timeout=900)
        path = Path(tmp) / "x.csv"
        if proc.returncode != 0 or "wrong" in proc.stdout or not path.exists():
            return None
        with path.open() as fh:
            rows = list(csv.reader(fh))
        return rows[1:]


def regular_session(rows: list[list[str]]) -> list[list[str]]:
    out = []
    for r in rows:
        local = datetime.fromtimestamp(int(r[0]) / 1000, UTC).astimezone(NY)
        minute = local.hour * 60 + local.minute
        if local.weekday() < 5 and 570 <= minute < 960:
            out.append(r)
    return out


def months(start: date, end: date):
    cur = date(start.year, start.month, 1)
    while cur < end:
        nxt = date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        yield max(cur, start), min(nxt, end)
        cur = nxt


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    failed: list[str] = []
    for inst, first in LIST:
        if only and inst not in only:
            continue
        for side in ("bid", "ask"):
            target = OUT / f"{inst}-{side}.csv.gz"
            if target.exists():
                continue
            rows: list[list[str]] = []
            for a, b in months(first, END):
                got = fetch(inst, side, a, b)
                if got is None:
                    got = fetch(inst, side, a, b)
                if got is None:
                    failed.append(f"{inst} {side} {a}")
                    continue
                rows.extend(regular_session(got))
            rows.sort(key=lambda r: int(r[0]))
            tmp = target.with_suffix(".tmp")
            with gzip.open(tmp, "wt", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
                w.writerows(rows)
            tmp.replace(target)
            print(f"{inst} {side}: {len(rows)} rows", flush=True)
    for f in failed:
        print(f"FAILED {f}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
