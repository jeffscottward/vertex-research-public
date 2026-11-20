# Probe evidence: ibapi 9.81.1 against 10.30.1 (read-only)

Run 2026-11-20 between 02:19 and 02:27 UTC on QuantVPS against the live IB Gateway, with a separate client id (163), historical requests and contract details only. Both runs used the host Python 3.10.12. `ibapi` 9.81.1 reports server version 157; 10.30.1 reports 187. The probe processes ended and the temporary folder was deleted. The raw JSON results stay in the job report folder on the rig (the repository holds no data files).

"Last value" is the volume of the last bar, the size of the last of the first five ticks, or `mdSizeMultiplier` for contract details (10.30.1 has no such field: none). Errors list IBKR codes for the request (10285: "upgrade to a minimum version 163").

| Request | 9.81.1 count | 9.81.1 errors | 9.81.1 last value | 10.30.1 count | 10.30.1 errors | 10.30.1 last value |
| --- | --- | --- | --- | --- | --- | --- |
| SPY details | 1 | - | 40 | 1 | - | None |
| ES details | 1 | - | 1 | 1 | - | None |
| SPY STK 1 day 1 M | 22 | - | 1323464 | 22 | - | 52938577 |
| SPY STK 1 hour 2 D | 14 | - | 374281 | 14 | - | 14971256 |
| AAPL STK 1 day 1 M | 22 | - | 569953 | 22 | - | 22798158 |
| ES CONTFUT 1 day 1 M | 22 | - | 2193478 | 22 | - | 2193478 |
| ES FUT 202612 1 day 1 M | 22 | - | 2193478 | 22 | - | 2193478 |
| SPX IND 1 day 1 M | 22 | - | 0 | 22 | - | 0 |
| EUR.USD CASH 1 day 1 M | 0 | 10285 | None | 22 | - | -1 |
| EUR.USD CASH 1 hour 2 D | 0 | 10285 | None | 29 | - | -1 |
| GBP.USD CASH 1 day 1 M | 0 | 10285 | None | 22 | - | -1 |
| USD.JPY CASH 1 day 1 M | 22 | - | -1 | 22 | - | -1 |
| SPY ticks TRADES 30 | 226 | - | 20 | 226 | - | 20 |

Notes:

- Daily stock volume ratios (10.30.1 / 9.81.1) for 2026-11-19: SPY 52,938,577 / 1,323,464 = 40.0000; AAPL 22,798,158 / 569,953 = 40.0001; SPY last hourly bar 14,971,256 / 374,281 = 40.0000.
- ES CONTFUT and ES FUT 202612 give the same volume with both clients; ES contract details give `mdSizeMultiplier` 1 with 9.81.1.
- Yahoo daily volume for 2026-11-19 (read 2026-11-20 UTC): SPY 76,476,400; AAPL 40,795,500.

## Probe script

```python
"""Read-only probe: historical bars, historical ticks and contract details with one ibapi version.
Usage: python3 probe.py <host> <port> <client_id> <out.json>. No orders, no market data subscriptions."""
import json, sys, threading, time
from decimal import Decimal

import ibapi
from ibapi.client import EClient
from ibapi.contract import Contract
from ibapi.wrapper import EWrapper

HOST, PORT, CID, OUT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
END_TICKS = "20261119 15:59:00 US/Eastern"


def contract(symbol, sec, exch, cur, month="", local=""):
    c = Contract()
    c.symbol, c.secType, c.exchange, c.currency = symbol, sec, exch, cur
    if month:
        c.lastTradeDateOrContractMonth = month
    if local:
        c.localSymbol = local
    return c


BARS = [
    ("SPY STK 1 day 1 M", contract("SPY", "STK", "SMART", "USD"), "TRADES", "1 day", "1 M"),
    ("SPY STK 1 hour 2 D", contract("SPY", "STK", "SMART", "USD"), "TRADES", "1 hour", "2 D"),
    ("AAPL STK 1 day 1 M", contract("AAPL", "STK", "SMART", "USD"), "TRADES", "1 day", "1 M"),
    ("ES CONTFUT 1 day 1 M", contract("ES", "CONTFUT", "CME", "USD"), "TRADES", "1 day", "1 M"),
    ("ES FUT 202612 1 day 1 M", contract("ES", "FUT", "CME", "USD", month="202612"), "TRADES", "1 day", "1 M"),
    ("SPX IND 1 day 1 M", contract("SPX", "IND", "CBOE", "USD"), "TRADES", "1 day", "1 M"),
    ("EUR.USD CASH 1 day 1 M", contract("EUR", "CASH", "IDEALPRO", "USD"), "MIDPOINT", "1 day", "1 M"),
    ("EUR.USD CASH 1 hour 2 D", contract("EUR", "CASH", "IDEALPRO", "USD"), "MIDPOINT", "1 hour", "2 D"),
    ("GBP.USD CASH 1 day 1 M", contract("GBP", "CASH", "IDEALPRO", "USD"), "MIDPOINT", "1 day", "1 M"),
    ("USD.JPY CASH 1 day 1 M", contract("USD", "CASH", "IDEALPRO", "JPY"), "MIDPOINT", "1 day", "1 M"),
]
DETAILS = [("SPY details", contract("SPY", "STK", "SMART", "USD")), ("ES details", contract("ES", "FUT", "CME", "USD", month="202612"))]


def plain(v):
    if isinstance(v, Decimal):
        return str(v)
    return v


class App(EWrapper, EClient):
    def __init__(self):
        EWrapper.__init__(self)
        EClient.__init__(self, self)
        self.ready = threading.Event()
        self.done = {}
        self.rows = {}
        self.errors = {}

    def nextValidId(self, orderId):
        self.ready.set()

    def error(self, reqId, errorCode, errorString, *rest):
        self.errors.setdefault(reqId, []).append([errorCode, str(errorString)[:200]])
        if reqId in self.done and errorCode not in (2104, 2106, 2107, 2108, 2158, 2174, 2176):
            self.done[reqId].set()

    def historicalData(self, reqId, bar):
        self.rows.setdefault(reqId, []).append({"date": bar.date, "close": plain(bar.close), "volume": plain(bar.volume),
                                                "volumeType": type(bar.volume).__name__, "wap": plain(getattr(bar, "wap", getattr(bar, "average", None))),
                                                "count": plain(bar.barCount)})

    def historicalDataEnd(self, reqId, start, end):
        self.done[reqId].set()

    def historicalTicksLast(self, reqId, ticks, done):
        for t in ticks:
            self.rows.setdefault(reqId, []).append({"time": t.time, "price": plain(t.price), "size": plain(t.size),
                                                    "sizeType": type(t.size).__name__})
        if done:
            self.done[reqId].set()

    def contractDetails(self, reqId, d):
        self.rows.setdefault(reqId, []).append({"conId": d.contract.conId, "mdSizeMultiplier": plain(getattr(d, "mdSizeMultiplier", None)),
                                                "minSize": plain(getattr(d, "minSize", None)), "sizeIncrement": plain(getattr(d, "sizeIncrement", None)),
                                                "minTick": d.minTick})

    def contractDetailsEnd(self, reqId):
        self.done[reqId].set()


def main():
    app = App()
    app.connect(HOST, PORT, CID)
    thread = threading.Thread(target=app.run, daemon=True)
    thread.start()
    if not app.ready.wait(15):
        print("handshake timeout", app.errors)
        app.disconnect()
        sys.exit(2)
    out = {"ibapi": getattr(ibapi, "__version__", None) or ibapi.get_version_string(), "serverVersion": app.serverVersion(), "results": {}}
    rid = 1000
    for name, c in DETAILS:
        rid += 1
        app.done[rid] = threading.Event()
        app.reqContractDetails(rid, c)
        app.done[rid].wait(20)
        out["results"][name] = {"rows": app.rows.get(rid, [])[:3], "errors": app.errors.get(rid, [])}
        time.sleep(1)
    for name, c, what, size, dur in BARS:
        rid += 1
        app.done[rid] = threading.Event()
        app.reqHistoricalData(rid, c, "", dur, size, what, 1, 2, False, [])
        ok = app.done[rid].wait(45)
        rows = app.rows.get(rid, [])
        out["results"][name] = {"finished": ok, "bars": len(rows), "first": rows[:2], "last": rows[-3:], "errors": app.errors.get(rid, [])}
        if not ok:
            app.cancelHistoricalData(rid)
        time.sleep(3)
    rid += 1
    app.done[rid] = threading.Event()
    app.reqHistoricalTicks(rid, contract("SPY", "STK", "SMART", "USD"), "", END_TICKS, 30, "TRADES", 1, False, [])
    ok = app.done[rid].wait(45)
    rows = app.rows.get(rid, [])
    out["results"]["SPY ticks TRADES 30"] = {"finished": ok, "ticks": len(rows), "first": rows[:5], "errors": app.errors.get(rid, [])}
    out["connectionErrors"] = app.errors.get(-1, [])
    app.disconnect()
    thread.join(5)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", OUT)


main()
```
