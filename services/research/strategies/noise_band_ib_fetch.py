"""One-off, read-only IBKR historical bar fetch for the noise-band re-test (research only).

Runs on QuantVPS with the ibapi package of /opt/vertex-history/venv against the IB gateway API port.
It sends reqContractDetails and reqHistoricalData only (no orders, no account or market data
subscriptions) under its own client id (default 177, distinct from vertex-history's 77).

Bars: 5-minute TRADES, regular trading hours, one "31 D" request per calendar month (31 calendar days back from the month end, so day 1 is never cut; overlaps are deduplicated by the loader), walking back
from --end to --start; one request in flight, at least --interval seconds apart (default 30 s, so the
combined rate with vertex-history stays near its own 6 per 120 s). The run aborts on the first pacing
violation or other IBKR error (162 other than "no data", 366, 321, ...). Each month is written to
<out>/<SYMBOL>/<YYYY-MM>.csv (epoch_utc,open,high,low,close,volume) so a rerun resumes. After
--stop-empty consecutive empty months the symbol is treated as not yet listed and the walk stops.

Usage (on the VPS):
  /opt/vertex-history/venv/bin/python noise_band_ib_fetch.py --gateway "$(cat /run/vertex-history/gateway)" \
      --out /root/noise-band-bars --start 2008-01 --end 2026-11 SPY QQQ
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import threading
import time
from datetime import date

from ibapi.client import EClient
from ibapi.contract import Contract
from ibapi.wrapper import EWrapper

PRIMARY = {"QQQ": "NASDAQ"}  # every other symbol used here is an NYSE Arca ETF
INFO_CODES = {2103, 2104, 2105, 2106, 2107, 2108, 2119, 2157, 2158, 2174, 2176}


class App(EWrapper, EClient):
    def __init__(self) -> None:
        EClient.__init__(self, self)
        self.ready = threading.Event()
        self.done: dict[int, threading.Event] = {}
        self.rows: dict[int, list[tuple]] = {}
        self.errors: dict[int, tuple[int, str]] = {}

    def nextValidId(self, orderId):  # noqa: N802 - ibapi callback
        self.ready.set()

    def historicalData(self, reqId, bar):  # noqa: N802
        self.rows.setdefault(reqId, []).append((bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume))

    def historicalDataEnd(self, reqId, start, end):  # noqa: N802
        self.done.setdefault(reqId, threading.Event()).set()

    def error(self, reqId, *args):  # signature differs across ibapi versions
        ints = [a for a in args if isinstance(a, int)]
        strs = [a for a in args if isinstance(a, str)]
        code = ints[-1] if ints else -1
        if code in INFO_CODES:
            return
        msg = strs[0] if strs else ""
        self.errors[reqId] = (code, msg)
        if reqId in self.done:
            self.done[reqId].set()


def month_ends(start: str, end: str) -> list[str]:
    """Calendar months from end back to start, as IB endDateTime strings (last day 23:59:59 ET)."""
    y, m = map(int, end.split("-"))
    sy, sm = map(int, start.split("-"))
    out = []
    while (y, m) >= (sy, sm):
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        last = date.fromordinal(date(ny, nm, 1).toordinal() - 1)
        out.append((f"{y:04d}-{m:02d}", last.strftime("%Y%m%d") + " 23:59:59 US/Eastern"))
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="+")
    ap.add_argument("--gateway", required=True, help='"<host> <port>"')
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", default="2008-01")
    ap.add_argument("--end", required=True)
    ap.add_argument("--client-id", type=int, default=177)
    ap.add_argument("--interval", type=float, default=30.0)
    ap.add_argument("--stop-empty", type=int, default=3)
    a = ap.parse_args()
    host, port = a.gateway.split()
    app = App()
    app.connect(host, int(port), a.client_id)
    threading.Thread(target=app.run, daemon=True).start()
    if not app.ready.wait(20):
        print("gateway handshake timed out", file=sys.stderr)
        return 2
    rid = 1000
    last_sent = 0.0
    for sym in a.symbols:
        os.makedirs(os.path.join(a.out, sym), exist_ok=True)
        c = Contract()
        c.symbol, c.secType, c.exchange, c.currency = sym, "STK", "SMART", "USD"
        c.primaryExchange = PRIMARY.get(sym, "ARCA")
        empty = 0
        for label, end_dt in month_ends(a.start, a.end):
            path = os.path.join(a.out, sym, label + ".csv")
            if os.path.exists(path):
                empty = empty + 1 if os.path.getsize(path) == 0 else 0
                if empty >= a.stop_empty:
                    break
                continue
            wait = a.interval - (time.time() - last_sent)
            if wait > 0:
                time.sleep(wait)
            rid += 1
            app.done[rid] = threading.Event()
            last_sent = time.time()
            app.reqHistoricalData(rid, c, end_dt, "31 D", "5 mins", "TRADES", 1, 2, False, [])
            if not app.done[rid].wait(120):
                app.cancelHistoricalData(rid)
                print(f"{sym} {label} timeout; abort", flush=True)
                app.disconnect()
                return 3
            rows = app.rows.pop(rid, [])
            err = app.errors.get(rid)
            if err and not (err[0] == 162 and "no data" in err[1].lower() and not rows):
                print(f"{sym} {label} IBKR error {err[0]}: {err[1][:160]}; abort", flush=True)
                app.disconnect()
                return 4
            tmp = path + ".tmp"
            with open(tmp, "w", newline="") as f:
                w = csv.writer(f)
                for r in rows:
                    w.writerow([int(str(r[0]).split()[0]), r[1], r[2], r[3], r[4], r[5]])
            os.replace(tmp, path)
            print(f"{sym} {label} {len(rows)} bars", flush=True)
            empty = 0 if rows else empty + 1
            if empty >= a.stop_empty:
                print(f"{sym}: {empty} empty months before {label}; stop", flush=True)
                break
    app.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
