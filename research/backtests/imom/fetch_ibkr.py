#!/usr/bin/env python3
"""IBKR 5-minute TRADES bars (regular hours) for the intraday-momentum study, paged backwards through vertex-history.

Research only; the data stays on the rig. Each request goes over the `quantvps` SSH alias to the read-only
vertex-history service (127.0.0.1:8791 on QuantVPS); the bearer token is read on QuantVPS and never leaves it.
Needs vertex-history >= the version with `endDateTime`. Pages of PAGE_DAYS calendar days, one request every
SPACING_S seconds (the service allows 6 per 120 s; this leaves room for the app). Resumable: a symbol's file is
extended backwards from its earliest stored bar. Stops after EMPTY_STOP empty pages in a row (before IBKR's head).
Output: ibkr5m/<SYMBOL>.csv.gz with header timestamp,open,high,low,close,volume (UTC ms, bar open time).
"""
import csv
import gzip
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(os.environ.get("VERTEX_IMOM_DATA_ROOT", Path.home() / "Documents" / "reports" / "vertex-reel-dffkn31-data"))
OUT = ROOT / "ibkr5m"
PAGE_DAYS = int(os.environ.get("IMOM_IBKR_PAGE_DAYS", "30"))
SPACING_S = float(os.environ.get("IMOM_IBKR_SPACING_S", "30"))
EMPTY_STOP = 3
EARLIEST = datetime(2004, 1, 1, tzinfo=UTC)
REMOTE = (
    'T=$(grep -E "^VERTEX_STATUS_TOKEN=" /opt/vertex-status/token.env | cut -d= -f2- | tr -d "\\""); '
    'curl -s -m 120 -H "Authorization: Bearer $T" "http://127.0.0.1:8791/vertex-history/v1/bars?{query}"'
)


def request(symbol: str, end: datetime) -> list[dict]:
    query = (f"symbol={symbol}&secType=STK&exchange=SMART&currency=USD&barSize=5%20mins"
             f"&duration={PAGE_DAYS}%20D&whatToShow=TRADES&useRTH=1&endDateTime={end:%Y%m%d-%H:%M:%S}")
    for attempt in range(3):
        proc = subprocess.run(["ssh", "quantvps", REMOTE.format(query=query)], capture_output=True, text=True, timeout=180)
        try:
            body = json.loads(proc.stdout)
        except json.JSONDecodeError:
            body = {"error": (proc.stdout or proc.stderr)[:200]}
        if "bars" in body:
            return body["bars"]
        print(f"{symbol} {end:%Y-%m-%d}: {str(body.get('error', body))[:160]} (attempt {attempt + 1})", flush=True)
        time.sleep(120 if "pacing" in json.dumps(body).lower() or "429" in json.dumps(body) else SPACING_S)
    raise RuntimeError(f"{symbol}: page ending {end:%Y-%m-%d} failed 3 times")


def load(path: Path) -> dict[int, list[str]]:
    if not path.exists():
        return {}
    with gzip.open(path, "rt", newline="") as fh:
        rows = list(csv.reader(fh))[1:]
    return {int(r[0]): r for r in rows}


def save(path: Path, rows: dict[int, list[str]]) -> None:
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        w.writerows(rows[t] for t in sorted(rows))
    tmp.replace(path)


def fetch_symbol(symbol: str) -> None:
    path = OUT / f"{symbol}.csv.gz"
    rows = load(path)
    end = (datetime.fromtimestamp(min(rows) / 1000, UTC) if rows else datetime.now(UTC) - timedelta(minutes=5))
    empty = 0
    while end > EARLIEST and empty < EMPTY_STOP:
        bars = request(symbol, end)
        new = {int(b["t"]) * 1000: [str(int(b["t"]) * 1000), repr(b["o"]), repr(b["h"]), repr(b["l"]), repr(b["c"]),
                                    repr(b.get("v") or 0)] for b in bars}
        older = [t for t in new if not rows or t < min(rows)]
        rows.update(new)
        empty = 0 if older else empty + 1
        end = (datetime.fromtimestamp(min(rows) / 1000, UTC) if older else end - timedelta(days=PAGE_DAYS))
        save(path, rows)
        first = datetime.fromtimestamp(min(rows) / 1000, UTC) if rows else None
        print(f"{symbol}: {len(rows)} bars, earliest {first:%Y-%m-%d}, page +{len(older)}", flush=True)
        time.sleep(SPACING_S)
    print(f"{symbol}: done ({len(rows)} bars)", flush=True)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for symbol in sys.argv[1:] or ["SPY", "QQQ", "IWM", "DIA", "GLD", "SLV", "USO"]:
        fetch_symbol(symbol.upper())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
