#!/usr/bin/env python3
"""SPY 0DTE option quote collector for the noise-band 0DTE test (research only, card vertex-noise-band-0dte-collect).

Read-only: it sends reqContractDetails and reqHistoricalData only. It never places, changes or cancels
orders and never requests account, position or streaming market data (test_odte_quotes.py scans for this).

Why: IBKR serves 1-minute BID and ASK history for a SPY option only until the contract is purged after
expiry, and no other Vertex source has past 0DTE quotes. A probe on 2026-11-19 at 21:56 ET still returned
the full day (07:30-16:14 ET bars) of that day's expiry, so the run starts after the close (16:20 ET) and a
runs at 17:45 and 19:00 ET resume a stopped one. Both runs must be done on the expiry day.

`collect` (default), for one New York session day D (default: today; today only from 16:15 ET):
1. The listed SPY options that expire on D, then SPY 1-min TRADES bars of D (RTH) -> underlying.csv.gz;
   the day's low and high come from the bars of 09:30-16:00 ET. No option listed and no SPY bars ->
   state no_expiry (a holiday). No option listed but SPY traded -> state partial.
2. Calls and puts at every whole-dollar strike from floor(low) - 6 to ceil(high) + 6 (covers instrument
   B's 5-point wing). For each: BID and ASK 1-min bars ("1 D", RTH, epoch times) -> one
   SPY-<YYYYMMDD>-<C|P>-<strike>.csv.gz per contract.
3. manifest.csv (one line per stored contract) and status.txt (key=value lines; state=complete|no_expiry|
   partial). A contract inside floor(low)..ceil(high) without BID or ASK bars (IBKR answers "no data" once
   it dropped the contract) keeps the day partial; empty wing contracts are counted in empty_wings.
One request in flight, request starts at least --spacing seconds apart (default 30 s, 20 per 10 min). The
QuantVPS IB gateway also serves vertex-history (client 77, at most 6 per 120 s = 30 per 10 min), and IBKR
allows 60 historical requests per 10 min, so both together stay at 50. The first IBKR error other than
"no data" (pacing violation, lost connection, ...) stops the day with state=partial and exit 1; the next
run resumes and asks only for contracts not stored with both sides.

`check`: for each weekday of the last --days days (default 7) whose check time (20:30 ET) has passed,
a day without state complete or no_expiry (including no folder) is a missed day. It posts one #omp-alerts
notice per missed day (through the rig bot /post that QuantVPS reaches on 127.0.0.1:47821, the same route
as the Nautilus health alert) and remembers it in alerted.txt. Exit 1 only when a notice was not delivered
(the next check tries it again).

Files: <root>/<YYYY-MM-DD>/... with root /var/lib/vertex-odte-quotes. Standard library + ibapi 9.81
(the /opt/vertex-history venv); Python 3.10+.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import math
import os
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable, Protocol, Sequence
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
DEFAULT_ROOT = "/var/lib/vertex-odte-quotes"
DEFAULT_CLIENT_ID = 187  # distinct from 31/41-50/61/62/77/78/91/97/98/177/179 and the order bridge 211
DEFAULT_POST_URL = "http://127.0.0.1:47821/post"
WING = 6.0
COLLECT_AFTER = (16, 15)  # New York time from which `collect` takes today (the last option bar starts 16:14)
CHECK_AFTER = (20, 30)  # New York time after which a weekday counts for `check`
INFO_CODES = {165, 2103, 2104, 2105, 2106, 2107, 2108, 2119, 2157, 2158, 2172, 2174, 2176}
DONE_STATES = {"complete", "no_expiry"}
OPTION_LOOKUP = "SPY options"
RECOVER_COMMAND = ("systemd-run --wait --collect -p DynamicUser=yes -p User=vertex-odte-quotes "
                   "-p StateDirectory=vertex-odte-quotes /opt/vertex-history/venv/bin/python -I "
                   "/opt/vertex-odte-quotes/odte_quotes.py collect --day {day} --gateway /run/vertex-history/gateway")
COLLECTION_START = date(2026, 11, 19)  # first collected session; `check` ignores earlier days
MANIFEST_FIELDS = ["file", "right", "strike", "con_id", "bid_bars", "ask_bars", "first_epoch", "last_epoch"]
QUOTE_FIELDS = ["epoch", "bid_open", "bid_high", "bid_low", "bid_close",
                "ask_open", "ask_high", "ask_low", "ask_close"]


class NoData(Exception):
    """IBKR answered "no data" for a request (the contract did not quote that day)."""


class IbError(Exception):
    """Any other IBKR error (pacing violation, lost connection, timeout): stop the day."""


@dataclass(frozen=True)
class OptionContract:
    right: str  # "C" or "P"
    strike: float
    con_id: int


Bar = tuple  # (epoch seconds, open, high, low, close, volume)


class Source(Protocol):
    def underlying_bars(self, day: date) -> list[Bar]: ...
    def option_contracts(self, day: date) -> list[OptionContract]: ...
    def option_bars(self, day: date, contract: OptionContract, what: str) -> list[Bar]: ...


# ---------------------------------------------------------------------------------------------- pure logic

def session_range(bars: Iterable[Bar], day: date) -> tuple[float, float] | None:
    """Low and high of the 1-min bars that start from 09:30 to 15:59 New York time on `day`."""
    start = datetime(day.year, day.month, day.day, 9, 30, tzinfo=NY).timestamp()
    end = start + 390 * 60
    rows = [b for b in bars if start <= b[0] < end]
    if not rows:
        return None
    return min(float(b[3]) for b in rows), max(float(b[2]) for b in rows)


def select_contracts(contracts: Sequence[OptionContract], low: float, high: float,
                     wing: float = WING) -> list[OptionContract]:
    """Whole-dollar strikes from floor(low) - wing to ceil(high) + wing, both rights, nearest the middle
    of the day's range first (calls before puts at equal distance), so a stopped run keeps the most used."""
    lo, hi, mid = math.floor(low) - wing, math.ceil(high) + wing, (low + high) / 2
    keep = [c for c in contracts if lo <= c.strike <= hi and float(c.strike).is_integer() and c.right in ("C", "P")]
    unique = {(c.right, c.strike): c for c in keep}
    return sorted(unique.values(), key=lambda c: (abs(c.strike - mid), c.strike, c.right))


def price_text(value: object) -> str:
    """Shortest text that reads back as the same float (repr), without a trailing ".0"."""
    text = repr(float(value))
    return text[:-2] if text.endswith(".0") else text


def volume_text(value: object) -> str:
    """Whole shares as an integer; IBKR may send volume as float or Decimal."""
    return str(int(round(float(value))))


def strike_text(strike: float) -> str:
    return f"{strike:g}"


def contract_file(day: date, c: OptionContract) -> str:
    return f"SPY-{day:%Y%m%d}-{c.right}-{strike_text(c.strike)}.csv.gz"


def merge_quotes(bid: Sequence[Bar], ask: Sequence[Bar]) -> list[list[str]]:
    """One row per bar start (epoch seconds), BID OHLC then ASK OHLC; a side without that bar is blank."""
    b = {int(x[0]): x for x in bid}
    a = {int(x[0]): x for x in ask}
    rows = []
    for t in sorted(set(b) | set(a)):
        row = [str(t)]
        for side in (b.get(t), a.get(t)):
            row += [price_text(v) for v in side[1:5]] if side else ["", "", "", ""]
        rows.append(row)
    return rows


def write_gz_csv(path: Path, header: Sequence[str], rows: Iterable[Sequence[object]]) -> None:
    """Atomic write: a temp file in the same folder, then rename."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8", newline="") as f:
        f.write(buf.getvalue())
    os.replace(tmp, path)


def write_text(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def read_manifest(day_dir: Path) -> dict[str, dict[str, str]]:
    path = day_dir / "manifest.csv"
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as f:
        return {row["file"]: row for row in csv.DictReader(f)}


def write_manifest(day_dir: Path, rows: dict[str, dict[str, str]]) -> None:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=MANIFEST_FIELDS, lineterminator="\n")
    w.writeheader()
    for name in sorted(rows):
        w.writerow({k: rows[name].get(k, "") for k in MANIFEST_FIELDS})
    write_text(day_dir / "manifest.csv", buf.getvalue())


def read_status(day_dir: Path) -> dict[str, str]:
    path = day_dir / "status.txt"
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            out[key.strip()] = value.strip()
    return out


def write_status(day_dir: Path, **fields: object) -> None:
    write_text(day_dir / "status.txt", "".join(f"{k}={v}\n" for k, v in fields.items()))


# ------------------------------------------------------------------------------------------------- collect

def collect(connect: Callable[[], Source], root: Path, day: date, log: Callable[[str], None] = print,
            now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> int:
    """Collect one day. Returns the exit code: 0 complete, no_expiry or too early, 1 partial (stopped on an error).
    Today is collected only from 16:15 New York time, so a catch-up run before the close never stores a part day.
    `connect` opens the IBKR session only after those checks, so a failed connection never downgrades a day that
    is already complete or no_expiry."""
    now_ny = now().astimezone(NY)
    if day == now_ny.date() and (now_ny.hour, now_ny.minute) < COLLECT_AFTER:
        log(f"{day}: before {COLLECT_AFTER[0]}:{COLLECT_AFTER[1]:02d} ET; the day is not over, nothing collected")
        return 0
    day_dir = root / day.isoformat()
    day_dir.mkdir(parents=True, exist_ok=True)
    if read_status(day_dir).get("state") in DONE_STATES:
        log(f"{day}: already {read_status(day_dir)['state']}; nothing to do")
        return 0
    manifest = read_manifest(day_dir)
    requests = 0

    def stop(reason: str, **extra: object) -> int:
        write_manifest(day_dir, manifest)
        write_status(day_dir, state="partial", reason=reason.replace("\n", " "), contracts=len(manifest),
                     requests=requests, finished_utc=now().isoformat(timespec="seconds"), **extra)
        log(f"{day}: partial: {reason}")
        return 1

    try:
        source = connect()
    except IbError as e:
        return stop(f"IbError: {e}")
    try:
        requests += 1
        listed = source.option_contracts(day)
        requests += 1
        try:
            under = source.underlying_bars(day)
        except NoData:
            under = []
    except (IbError, NoData) as e:
        return stop(f"{type(e).__name__}: {e}")
    rng = session_range(under, day)
    if not listed:
        if rng is not None:  # SPY traded that day, so a 0DTE expiry should exist: do not mark the day as done
            return stop("SPY traded but IBKR listed no SPY option expiring this day")
        write_status(day_dir, state="no_expiry", requests=requests, finished_utc=now().isoformat(timespec="seconds"))
        log(f"{day}: no SPY option expires and SPY did not trade (holiday)")
        return 0
    if rng is None:
        return stop("no SPY bars from 09:30 to 16:00 ET")
    write_gz_csv(day_dir / "underlying.csv.gz", ["epoch", "open", "high", "low", "close", "volume"],
                 ([int(b[0])] + [price_text(v) for v in b[1:5]] + [volume_text(b[5])] for b in under))
    low, high = rng
    wanted = select_contracts(listed, low, high)
    log(f"{day}: SPY low {low:g} high {high:g}; {len(wanted)} contracts, {len(manifest)} already stored")
    for c in wanted:
        name = contract_file(day, c)
        if name in manifest and (day_dir / name).exists() and has_both_sides(manifest[name]):
            continue
        sides: dict[str, list[Bar]] = {}
        for what in ("BID", "ASK"):
            requests += 1
            try:
                sides[what] = source.option_bars(day, c, what)
            except NoData:
                sides[what] = []
            except IbError as e:
                return stop(f"{name} {what}: {e}", low=f"{low:g}", high=f"{high:g}")
        rows = merge_quotes(sides["BID"], sides["ASK"])
        write_gz_csv(day_dir / name, QUOTE_FIELDS, rows)
        manifest[name] = {"file": name, "right": c.right, "strike": strike_text(c.strike), "con_id": str(c.con_id),
                          "bid_bars": str(len(sides["BID"])), "ask_bars": str(len(sides["ASK"])),
                          "first_epoch": rows[0][0] if rows else "", "last_epoch": rows[-1][0] if rows else ""}
        write_manifest(day_dir, manifest)
    write_manifest(day_dir, manifest)
    # IBKR answers "no data" when it has dropped an expired contract's bars. A contract the day traded through
    # (strike inside the day's whole-dollar range) without BID or ASK bars therefore keeps the day partial, so
    # the check alerts and the next run asks again. Wing strikes may stay empty.
    empty = [n for n, row in manifest.items() if not has_both_sides(row)]
    core_empty = [n for n in empty if math.floor(low) <= float(manifest[n]["strike"]) <= math.ceil(high)]
    if core_empty:
        return stop(f"{len(core_empty)} contracts inside the day's range have no BID or ASK bars, e.g. {core_empty[0]}",
                    low=f"{low:g}", high=f"{high:g}")
    write_status(day_dir, state="complete", low=f"{low:g}", high=f"{high:g}", contracts=len(manifest),
                 empty_wings=len(empty), requests=requests, finished_utc=now().isoformat(timespec="seconds"))
    log(f"{day}: complete, {len(manifest)} contracts ({len(empty)} wing contracts without bars), "
        f"{requests} requests this run")
    return 0


def has_both_sides(row: dict[str, str]) -> bool:
    return row.get("bid_bars", "0") not in ("", "0") and row.get("ask_bars", "0") not in ("", "0")


# --------------------------------------------------------------------------------------------------- check

def due_days(now_ny: datetime, days: int) -> list[date]:
    """Weekdays of the last `days` days whose 20:30 New York check time has passed."""
    out = []
    for back in range(days):
        d = now_ny.date() - timedelta(days=back)
        if d.weekday() >= 5 or d < COLLECTION_START:
            continue
        if back == 0 and (now_ny.hour, now_ny.minute) < CHECK_AFTER:
            continue
        out.append(d)
    return sorted(out)


def check(root: Path, now_ny: datetime, post: Callable[[str], bool], days: int = 7,
          log: Callable[[str], None] = print) -> int:
    alerted_path = root / "alerted.txt"
    alerted = set(alerted_path.read_text(encoding="utf-8").split()) if alerted_path.exists() else set()
    rc = 0
    for d in due_days(now_ny, days):
        status = read_status(root / d.isoformat())
        state = status.get("state", "missing")
        if state in DONE_STATES:
            continue
        log(f"{d}: missed ({state})")
        if d.isoformat() in alerted:
            continue
        text = (f"⚠️ SPY 0DTE quote collector missed {d.isoformat()} (state {state}"
                f"{': ' + status['reason'] if status.get('reason') else ''}). IBKR serves expired SPY options only "
                f"on their expiry day (seen until at least 21:56 ET), so recover it this evening if the IB gateway is "
                f"logged in: on QuantVPS as root run `{RECOVER_COMMAND.format(day=d.isoformat())}`. "
                "Card vertex-noise-band-0dte-collect.")
        if post(text):
            alerted.add(d.isoformat())
            write_text(alerted_path, "".join(f"{x}\n" for x in sorted(alerted)))
        else:
            log(f"{d}: alert not delivered")
            rc = 1
    return rc


def post_alert(url: str, text: str) -> bool:
    import json  # the request body only; no data file

    body = json.dumps({"channel": "omp-alerts", "text": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - fixed loopback URL
            return 200 <= resp.status < 300
    except OSError:
        return False


# ------------------------------------------------------------------------------------------- IBKR adapter

def classify_error(code: int, msg: str, label: str) -> str:
    """IBKR error of a request -> "no_data" (162 "... no data"), "none_listed" (200 "no security definition"
    on the option lookup: nothing expires that day) or "stop" (everything else: pacing violation, lost
    connection, ...). Notice codes (INFO_CODES) never reach this function."""
    if code == 162 and "no data" in msg.lower():
        return "no_data"
    if code == 200 and label == OPTION_LOOKUP:
        return "none_listed"
    return "stop"


class IbSource:
    """reqContractDetails and reqHistoricalData through ibapi; one request in flight, spaced apart."""

    def __init__(self, host: str, port: int, client_id: int, spacing: float, timeout: float = 90.0,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep) -> None:
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper

        outer = self

        class App(EWrapper, EClient):
            def __init__(self) -> None:
                EClient.__init__(self, self)

            def nextValidId(self, orderId):  # noqa: N802 - ibapi callback
                outer._ready.set()

            def contractDetails(self, reqId, details):  # noqa: N802
                c = details.contract
                outer._rows.append(OptionContract(c.right, float(c.strike), int(c.conId)))

            def contractDetailsEnd(self, reqId):  # noqa: N802
                outer._done.set()

            def historicalData(self, reqId, bar):  # noqa: N802
                outer._rows.append((int(bar.date), bar.open, bar.high, bar.low, bar.close, bar.volume))

            def historicalDataEnd(self, reqId, start, end):  # noqa: N802
                outer._done.set()

            def error(self, reqId, *args):  # signature differs across ibapi versions
                ints = [a for a in args if isinstance(a, int)]
                strs = [a for a in args if isinstance(a, str)]
                code = ints[-1] if ints else -1
                if code in INFO_CODES:
                    return
                outer._error = (code, strs[0] if strs else "")
                outer._done.set()

        self._ready, self._done = threading.Event(), threading.Event()
        self._rows: list = []
        self._error: tuple[int, str] | None = None
        self._spacing, self._timeout, self._clock, self._sleep = spacing, timeout, clock, sleep
        self._last = -math.inf
        self._req = 0
        self.app = App()
        self.app.connect(host, port, client_id)
        threading.Thread(target=self.app.run, daemon=True).start()
        if not self._ready.wait(20):
            raise IbError("gateway handshake timed out")

    def close(self) -> None:
        self.app.disconnect()

    def _call(self, send: Callable[[int], None], label: str) -> list:
        # IBKR paces request starts (60 per 10 min), so the spacing counts from the previous send.
        wait = self._last + self._spacing - self._clock()
        if wait > 0:
            self._sleep(wait)
        self._req += 1
        self._rows, self._error = [], None
        self._done.clear()
        self._last = self._clock()
        send(self._req)
        ok = self._done.wait(self._timeout)
        if not ok:
            raise IbError(f"{label}: no answer in {self._timeout:g} s")
        if self._error:
            kind = classify_error(*self._error, label)
            if kind == "no_data":
                raise NoData(f"{label}: {self._error[1]}")
            if kind == "none_listed":
                return []
            raise IbError(f"{label}: IBKR {self._error[0]} {self._error[1]}")
        return list(self._rows)

    @staticmethod
    def _end(day: date) -> str:
        # Today: "" (now). Earlier days: 23:59:59 New York time, so "1 D" is that session.
        return "" if day == datetime.now(NY).date() else f"{day:%Y%m%d} 23:59:59 US/Eastern"

    def underlying_bars(self, day: date) -> list[Bar]:
        from ibapi.contract import Contract

        c = Contract()
        c.symbol, c.secType, c.exchange, c.primaryExchange, c.currency = "SPY", "STK", "SMART", "ARCA", "USD"
        return self._call(lambda r: self.app.reqHistoricalData(r, c, self._end(day), "1 D", "1 min", "TRADES",
                                                               1, 2, False, []), "SPY TRADES")

    def option_contracts(self, day: date) -> list[OptionContract]:
        from ibapi.contract import Contract

        c = Contract()
        c.symbol, c.secType, c.exchange, c.currency = "SPY", "OPT", "SMART", "USD"
        c.lastTradeDateOrContractMonth, c.multiplier, c.tradingClass = f"{day:%Y%m%d}", "100", "SPY"
        return self._call(lambda r: self.app.reqContractDetails(r, c), OPTION_LOOKUP)

    def option_bars(self, day: date, contract: OptionContract, what: str) -> list[Bar]:
        from ibapi.contract import Contract

        c = Contract()
        c.conId, c.exchange = contract.con_id, "SMART"
        return self._call(lambda r: self.app.reqHistoricalData(r, c, self._end(day), "1 D", "1 min", what,
                                                               1, 2, False, []),
                          f"{contract.right}{strike_text(contract.strike)} {what}")


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", nargs="?", default="collect", choices=("collect", "check"))
    ap.add_argument("--root", default=os.environ.get("ODTE_QUOTES_ROOT", DEFAULT_ROOT))
    ap.add_argument("--day", help="YYYY-MM-DD (collect; default: today in New York)")
    ap.add_argument("--gateway", default=os.environ.get("ODTE_QUOTES_GATEWAY_FILE", "/run/vertex-odte-quotes/gateway"),
                    help='file with "<host> <port>", or the value itself')
    ap.add_argument("--client-id", type=int, default=DEFAULT_CLIENT_ID)
    ap.add_argument("--spacing", type=float, default=30.0)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--post-url", default=os.environ.get("ODTE_QUOTES_POST_URL", DEFAULT_POST_URL))
    a = ap.parse_args(argv)
    root = Path(a.root)
    log = lambda s: print(s, flush=True)  # noqa: E731
    if a.command == "check":
        return check(root, datetime.now(NY), lambda t: post_alert(a.post_url, t), a.days, log)
    day = date.fromisoformat(a.day) if a.day else datetime.now(NY).date()
    gw = Path(a.gateway).read_text(encoding="utf-8") if Path(a.gateway).is_file() else a.gateway
    host, port = gw.split()
    opened: list[IbSource] = []

    def connect() -> IbSource:
        opened.append(IbSource(host, int(port), a.client_id, a.spacing))
        return opened[-1]

    try:
        return collect(connect, root, day, log)
    finally:
        for source in opened:
            source.close()


if __name__ == "__main__":
    sys.exit(main())
