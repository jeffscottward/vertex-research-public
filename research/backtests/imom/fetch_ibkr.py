#!/usr/bin/env python3
"""IBKR 5-minute TRADES bars (regular hours) for the intraday-momentum study, paged backwards through vertex-history.

Research only; the data stays on the rig. Each request goes over the `quantvps` SSH alias to the read-only
vertex-history service (127.0.0.1:8791 on QuantVPS); the bearer token is read on QuantVPS and never leaves it.
Needs vertex-history >= 1.2.0 (`endDateTime`, `BID_ASK`). Pages of PAGE_DAYS calendar days, one request every
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
import re
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(os.environ.get("VERTEX_IMOM_DATA_ROOT", Path.home() / "Documents" / "reports" / "vertex-reel-dffkn31-data"))
OUT = ROOT / "ibkr5m"
PAGE_DAYS = int(os.environ.get("IMOM_IBKR_PAGE_DAYS", "30"))
SPACING_S = float(os.environ.get("IMOM_IBKR_SPACING_S", "30"))
EMPTY_STOP = 3
EARLIEST = datetime(2004, 1, 1, tzinfo=UTC)
REMOTE = (
    'T=$(grep -E "^VERTEX_STATUS_TOKEN=" /opt/vertex-status/token.env | cut -d= -f2- | tr -d "\\""); '
    'printf "Authorization: Bearer %s\\n" "$T" | curl -s -m 120 -H @- "http://127.0.0.1:8791/vertex-history/v1/bars?{query}"'
)
NEW_YORK = ZoneInfo("America/New_York")
QUIET_FROM, QUIET_TO = 9 * 60 + 25, 16 * 60 + 5  # weekday market hours: leave the shared gateway to trading


def wait_off_hours() -> None:
    """Sleep while US markets are open (Mon-Fri 09:25-16:05 New York), so the backfill never competes with trading."""
    while True:
        now = datetime.now(NEW_YORK)
        minute = now.hour * 60 + now.minute
        if now.weekday() >= 5 or not QUIET_FROM <= minute < QUIET_TO:
            return
        print(f"market hours ({now:%H:%M} New York): pausing until 16:05", flush=True)
        time.sleep((QUIET_TO - minute) * 60 + 5)


SYMBOL_RE = re.compile(r"^[A-Z0-9.]{1,12}$")


def request(symbol: str, end: datetime, what: str = "TRADES", days: int = PAGE_DAYS) -> list[dict]:
    query = (f"symbol={symbol}&secType=STK&exchange=SMART&currency=USD&barSize=5%20mins"
             f"&duration={days}%20D&whatToShow={what}&useRTH=1&endDateTime={end:%Y%m%d-%H:%M:%S}")
    failures = 0
    while failures < 3:
        wait_off_hours()
        proc = subprocess.run(["ssh", "quantvps", REMOTE.format(query=query)], capture_output=True, text=True, timeout=180)
        try:
            body = json.loads(proc.stdout)
        except json.JSONDecodeError:
            body = {"error": (proc.stdout or proc.stderr)[:200]}
        if "bars" in body:
            return body["bars"]
        retry = body.get("retry_after_seconds")
        print(f"{symbol} {end:%Y-%m-%d}: {str(body.get('error', body))[:160]}", flush=True)
        if isinstance(retry, (int, float)) and retry > 0:
            time.sleep(retry + 5)  # paced / busy / backoff: wait as told, not a failure
            continue
        failures += 1
        time.sleep(SPACING_S)
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
    fresh = not rows
    end = (datetime.fromtimestamp(min(rows) / 1000, UTC) if rows else datetime.now(UTC) - timedelta(minutes=5))
    empty = 0
    while end > EARLIEST and empty < EMPTY_STOP:
        bars = request(symbol, end)
        if fresh:  # never keep an unfinished newest bar (resume only extends backwards)
            bars = [b for b in bars if (int(b["t"]) + 300) <= end.timestamp()]
            fresh = False
        new = {int(b["t"]) * 1000: [str(int(b["t"]) * 1000), repr(b["o"]), repr(b["h"]), repr(b["l"]), repr(b["c"]),
                                    repr(b.get("v") or 0)] for b in bars}
        floor = min(rows) if rows else None
        older = [t for t in new if floor is None or t < floor]
        rows.update(new)
        empty = 0 if older else empty + 1
        end = (datetime.fromtimestamp(min(rows) / 1000, UTC) if older else end - timedelta(days=PAGE_DAYS))
        save(path, rows)
        first = datetime.fromtimestamp(min(rows) / 1000, UTC) if rows else None
        print(f"{symbol}: {len(rows)} bars, earliest {first:%Y-%m-%d}, page +{len(older)}" if first else f"{symbol}: empty page",
              flush=True)
        time.sleep(SPACING_S)
    print(f"{symbol}: done ({len(rows)} bars)", flush=True)


def fetch_spreads(symbol: str, first_year: int) -> None:
    """BID_ASK sample: the first full Monday-Friday week of each calendar quarter (open = time-average bid,
    close = time-average ask of each 5-minute bar). Output: ibkr5m/<SYMBOL>-bidask.csv.gz, same columns."""
    path = OUT / f"{symbol}-bidask.csv.gz"
    rows = load(path)
    done = {datetime.fromtimestamp(t / 1000, UTC).strftime("%Y-%m") for t in rows}
    now = datetime.now(UTC)
    for year in range(first_year, now.year + 1):
        for month in (1, 4, 7, 10):
            start = datetime(year, month, 1, tzinfo=UTC)
            while start.weekday() != 0:  # first Monday of the quarter
                start += timedelta(days=1)
            end = start + timedelta(days=4, hours=21)
            if end >= now or start.strftime("%Y-%m") in done:
                continue
            bars = request(symbol, end, "BID_ASK", 5)
            for b in bars:
                t = int(b["t"]) * 1000
                rows[t] = [str(t), repr(b["o"]), repr(b["h"]), repr(b["l"]), repr(b["c"]), "0"]
            save(path, rows)
            print(f"{symbol} spreads {start:%Y-%m-%d}: {len(bars)} bars", flush=True)
            time.sleep(SPACING_S)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    args = sys.argv[1:]
    for symbol in args[2:] if args and args[0] == "--spreads" else args:
        if not SYMBOL_RE.match(symbol.upper()):
            raise SystemExit(f"bad symbol: {symbol!r}")
    if args and args[0] == "--spreads":
        for symbol in args[2:] or ["SPY"]:
            fetch_spreads(symbol.upper(), int(args[1]))
        return 0
    for symbol in args or ["SPY", "QQQ", "IWM", "DIA", "GLD", "SLV", "USO"]:
        fetch_symbol(symbol.upper())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
