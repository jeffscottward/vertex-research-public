#!/usr/bin/env python3
"""Vertex read-only IBKR historical bars service (QuantVPS).

Bars only. One IB API session with client id 77, used for contract lookup and historical bars and
nothing else. Listens on 127.0.0.1 only; reachable solely through the tailnet Caddy site (rig
allow-list plus bearer token). The bearer token is checked again here.

Pacing (historical requests): at least 10 s apart, at most 6 per 120 s, an identical request at most
once per 15 s, and a 10 minute back-off after IBKR reports a pacing violation. Results are cached on
disk with a TTL per bar size; a stale copy (at most 24 h old) is served while paced or backed off.

Tests: python3 infra/quant-vps/history/test_vertex_history.py
"""
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

VERSION = "1.0.0"
SCHEMA = "vertex-history-bars-v1"
SOURCE = "ibkr-gateway"
CLIENT_ID = 77
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8791
PREFIX = "/vertex-history/v1"

SEC_TYPES = ("STK", "FUT", "CONTFUT")
WHAT_TO_SHOW = ("TRADES", "MIDPOINT")
BAR_SIZES = {"1 min": 60, "5 mins": 300, "15 mins": 900, "30 mins": 1800, "1 hour": 3600, "1 day": 86400}
UNIT_DAYS = {"D": 1, "W": 7, "M": 30, "Y": 365}
TTL_SECONDS = {"1 min": 120, "1 day": 3600}
DEFAULT_TTL = 300
STALE_MAX_SECONDS = 86400
CONTRACT_TTL = 86400

MIN_INTERVAL = 10.0
BURST_MAX = 6
BURST_WINDOW = 120.0
IDENTICAL_WINDOW = 15.0
BACKOFF_SECONDS = 600.0
MAX_WAIT = 20.0
IB_TIMEOUT = 20.0

PARAMS = ("symbol", "secType", "exchange", "currency", "barSize", "duration", "whatToShow", "useRTH", "contractMonth")
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,11}$")
EXCHANGE_RE = re.compile(r"^[A-Z][A-Z0-9.]{1,15}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
MONTH_RE = re.compile(r"^\d{6}(\d{2})?$")
DURATION_RE = re.compile(r"^([1-9]\d{0,2}) ([DWMY])$")
ACCOUNT_RE = re.compile(r"\b(?:D?U|F|I)\d{5,}\b")


class BadRequest(Exception):
    pass


class IbError(Exception):
    """kind: no_contract | entitlement | ibkr_error | unavailable | timeout"""

    def __init__(self, kind, message, code=None):
        super().__init__(message)
        self.kind, self.message, self.code = kind, message, code


class PacingViolation(Exception):
    pass


def now_iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def scrub(text):
    return ACCOUNT_RE.sub("[account]", str(text))[:200]


def max_duration_days(bar_size):
    if bar_size == "1 day":
        return 365
    if bar_size == "1 min":
        return 2
    return 31


def validate(raw):
    """raw: dict of str -> list[str] (parse_qs). Returns a normalized request dict or raises BadRequest."""
    unknown = sorted(set(raw) - set(PARAMS))
    if unknown:
        raise BadRequest("unknown parameter: " + unknown[0][:40])
    values = {}
    for key, vals in raw.items():
        if len(vals) != 1:
            raise BadRequest("repeated parameter: " + key)
        values[key] = vals[0].strip()
    sec_type = values.get("secType", "STK").upper()
    if sec_type not in SEC_TYPES:
        raise BadRequest("secType must be one of " + ", ".join(SEC_TYPES))
    symbol = values.get("symbol", "").upper()
    if not SYMBOL_RE.match(symbol):
        raise BadRequest("invalid symbol")
    exchange = values.get("exchange", "SMART" if sec_type == "STK" else "").upper()
    if not EXCHANGE_RE.match(exchange):
        raise BadRequest("invalid exchange (required for futures)")
    currency = values.get("currency", "USD").upper()
    if not CURRENCY_RE.match(currency):
        raise BadRequest("invalid currency")
    bar_size = values.get("barSize", "1 day")
    if bar_size not in BAR_SIZES:
        raise BadRequest("barSize must be one of " + ", ".join(BAR_SIZES))
    duration = values.get("duration", "1 Y" if bar_size == "1 day" else "1 D").upper()
    m = DURATION_RE.match(duration)
    if not m:
        raise BadRequest("invalid duration")
    days = int(m.group(1)) * UNIT_DAYS[m.group(2)]
    if bar_size == "1 min" and m.group(2) != "D":
        raise BadRequest("1 min bars allow durations in days only")
    if days > max_duration_days(bar_size):
        raise BadRequest("duration too long for " + bar_size)
    what = values.get("whatToShow", "TRADES").upper()
    if what not in WHAT_TO_SHOW:
        raise BadRequest("whatToShow must be TRADES or MIDPOINT")
    rth = values.get("useRTH", "1")
    if rth not in ("0", "1"):
        raise BadRequest("useRTH must be 0 or 1")
    month = values.get("contractMonth", "")
    if month and (sec_type != "FUT" or not MONTH_RE.match(month)):
        raise BadRequest("contractMonth is YYYYMM or YYYYMMDD and only for FUT")
    return {"symbol": symbol, "secType": sec_type, "exchange": exchange, "currency": currency, "barSize": bar_size,
            "duration": duration, "whatToShow": what, "useRTH": rth == "1", "contractMonth": month or None}


def cache_key(req):
    return hashlib.sha256(json.dumps(req, sort_keys=True).encode()).hexdigest()


def ttl_for(req):
    return TTL_SECONDS.get(req["barSize"], DEFAULT_TTL)


def parse_bar_time(text):
    s = str(text).strip()
    if re.fullmatch(r"\d{8}", s):
        return int(datetime.strptime(s, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp())
    if re.fullmatch(r"\d{9,11}", s):
        return int(s)
    raise ValueError("unexpected bar time format")


def to_bar(date, o, h, l, c, v):
    vol = float(v)
    return {"t": parse_bar_time(date), "o": float(o), "h": float(h), "l": float(l), "c": float(c),
            "v": None if vol < 0 else vol}


class Pacer:
    """Historical-request pacing. Not thread-safe; callers serialize."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.sent = []
        self.last_by_key = {}
        self.backoff_until = 0.0

    def wait_for(self, key):
        now = self.clock()
        self.sent = [t for t in self.sent if now - t < BURST_WINDOW]
        wait = max(0.0, self.backoff_until - now)
        if self.sent:
            wait = max(wait, self.sent[-1] + MIN_INTERVAL - now)
        if len(self.sent) >= BURST_MAX:
            wait = max(wait, self.sent[-BURST_MAX] + BURST_WINDOW - now)
        last = self.last_by_key.get(key)
        if last is not None:
            wait = max(wait, last + IDENTICAL_WINDOW - now)
        return wait

    def record(self, key):
        now = self.clock()
        self.sent.append(now)
        self.last_by_key = {k: t for k, t in self.last_by_key.items() if now - t < IDENTICAL_WINDOW}
        self.last_by_key[key] = now

    def violation(self):
        self.backoff_until = self.clock() + BACKOFF_SECONDS

    def snapshot(self):
        now = self.clock()
        return {"recent_requests": len([t for t in self.sent if now - t < BURST_WINDOW]),
                "backoff_seconds": max(0, int(self.backoff_until - now))}


class DiskCache:
    def __init__(self, directory, clock=time.time):
        self.dir, self.clock = directory, clock
        os.makedirs(directory, mode=0o700, exist_ok=True)

    def _path(self, key):
        return os.path.join(self.dir, key + ".json")

    def get(self, key, max_age):
        try:
            with open(self._path(key)) as f:
                entry = json.load(f)
            age = self.clock() - float(entry["stored_at"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if age < 0 or age > max_age:
            return None
        return entry["payload"], int(age)

    def put(self, key, payload):
        tmp = self._path(key) + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"stored_at": self.clock(), "payload": payload}, f, separators=(",", ":"))
        os.replace(tmp, self._path(key))


class HistoryService:
    def __init__(self, gateway, cache, pacer, clock=time.time, sleep=time.sleep, log=None):
        self.gateway, self.cache, self.pacer = gateway, cache, pacer
        self.clock, self.sleep = clock, sleep
        self.log = log or (lambda event, **kw: None)
        self.lock = threading.Lock()

    def _ok(self, payload, age, ttl, hit, stale=False):
        body = dict(payload)
        body["cache"] = {"hit": hit, "age_seconds": age, "ttl_seconds": ttl, "stale": stale}
        return 200, body

    def _stale_or(self, key, ttl, status, body):
        stale = self.cache.get(key, STALE_MAX_SECONDS)
        if stale:
            return self._ok(stale[0], stale[1], ttl, True, stale=True)
        return status, body

    def bars(self, raw):
        try:
            req = validate(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(req), ttl_for(req)
        hit = self.cache.get(key, ttl)
        if hit:
            return self._ok(hit[0], hit[1], ttl, True)
        deadline = self.clock() + MAX_WAIT
        if not self.lock.acquire(timeout=MAX_WAIT):
            return self._stale_or(key, ttl, 429, {"error": "busy", "retry_after_seconds": int(MIN_INTERVAL)})
        try:
            hit = self.cache.get(key, ttl)
            if hit:
                return self._ok(hit[0], hit[1], ttl, True)
            wait = self.pacer.wait_for(key)
            if self.clock() + wait > deadline:
                retry = int(wait) + 1
                self.log("paced", retry_after=retry)
                return self._stale_or(key, ttl, 429, {"error": "paced", "retry_after_seconds": retry})
            if wait > 0:
                self.sleep(wait)
            try:
                contract, bars = self.gateway.fetch(req, lambda: self.pacer.record(key))
            except PacingViolation:
                self.pacer.violation()
                self.log("pacing_violation", backoff_seconds=int(BACKOFF_SECONDS))
                return self._stale_or(key, ttl, 429, {"error": "pacing_violation",
                                                      "retry_after_seconds": int(BACKOFF_SECONDS)})
            except IbError as e:
                status = {"no_contract": 422, "unavailable": 503, "timeout": 504}.get(e.kind, 502)
                body = {"error": e.kind, "message": scrub(e.message)}
                if e.code is not None:
                    body["ibkr_code"] = e.code
                self.log("ib_error", kind=e.kind, code=e.code)
                if e.kind in ("unavailable", "timeout"):
                    return self._stale_or(key, ttl, status, body)
                return status, body
            fetched = self.clock()
            payload = {"schema": SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "contract": contract, "bars": bars, "count": len(bars), "fetched_at": now_iso(fetched),
                       "as_of": now_iso(bars[-1]["t"]) if bars else None}
            self.cache.put(key, payload)
            return self._ok(payload, 0, ttl, False)
        finally:
            self.lock.release()

    def health(self):
        return 200, {"schema": "vertex-history-health-v1", "version": VERSION, "client_id": CLIENT_ID,
                     "connected": self.gateway.connected(), "pacing": self.pacer.snapshot()}


class _Holder:
    def __init__(self):
        self.done = threading.Event()
        self.rows = []
        self.error = None


def _wrapper_class():
    from ibapi.wrapper import EWrapper

    class Wrapper(EWrapper):
        def __init__(self, owner):
            EWrapper.__init__(self)
            self.owner = owner

        def nextValidId(self, orderId):  # handshake complete
            self.owner.ready.set()

        def contractDetails(self, reqId, contractDetails):
            self.owner.add_row(reqId, contractDetails)

        def contractDetailsEnd(self, reqId):
            self.owner.finish(reqId)

        def historicalData(self, reqId, bar):
            self.owner.add_row(reqId, bar)

        def historicalDataEnd(self, reqId, start, end):
            self.owner.finish(reqId)

        def error(self, reqId, errorCode, errorString, *rest):
            self.owner.on_error(reqId, errorCode, errorString)

        def connectionClosed(self):
            self.owner.ready.clear()
            self.owner.fail_all(IbError("unavailable", "gateway connection closed"))

    return Wrapper


INFO_CODES = {2103, 2104, 2105, 2106, 2107, 2108, 2119, 2157, 2158, 2174}
ENTITLEMENT_CODES = {354, 10089, 10090, 10167, 10168, 10186, 10197}


class IbGateway:
    """The only code that talks to IB. Calls on self._client are limited to IB_CALLS (enforced by tests)."""

    IB_CALLS = ("connect", "disconnect", "isConnected", "run", "reqContractDetails", "reqHistoricalData",
                "cancelHistoricalData")

    def __init__(self, gateway_file, clock=time.time, log=None):
        self.gateway_file, self.clock = gateway_file, clock
        self.log = log or (lambda event, **kw: None)
        self.ready = threading.Event()
        self.holders = {}
        self.holders_lock = threading.Lock()
        self.next_id = 1000
        self._client = None
        self.contracts = {}
        self.connect_failures = 0

    def connected(self):
        return bool(self._client is not None and self._client.isConnected() and self.ready.is_set())

    def _endpoint(self):
        with open(self.gateway_file) as f:
            host, port = f.read().split()
        return host, int(port)

    def _ensure(self):
        if self.connected():
            return
        from ibapi.client import EClient

        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
        host, port = self._endpoint()
        self.ready.clear()
        self._client = EClient(_wrapper_class()(self))
        self._client.connect(host, port, CLIENT_ID)
        if not self._client.isConnected():
            self.connect_failures += 1
            raise IbError("unavailable", "gateway API not reachable")
        threading.Thread(target=self._client.run, name="ib-reader", daemon=True).start()
        if not self.ready.wait(10):
            self.connect_failures += 1
            self._client.disconnect()
            raise IbError("unavailable", "gateway handshake timed out")
        self.connect_failures = 0
        self.log("ib_connected", client_id=CLIENT_ID)

    def add_row(self, req_id, row):
        h = self.holders.get(req_id)
        if h is not None:
            h.rows.append(row)

    def finish(self, req_id):
        h = self.holders.get(req_id)
        if h is not None:
            h.done.set()

    def fail_all(self, err):
        with self.holders_lock:
            for h in self.holders.values():
                h.error = err
                h.done.set()

    def on_error(self, req_id, code, message):
        code = int(code)
        if code in INFO_CODES:
            return
        text = str(message)
        low = text.lower()
        if code == 326:
            err = IbError("unavailable", "client id 77 already in use", code)
        elif "pacing violation" in low:
            err = PacingViolation()
        elif code == 162 and "returned no data" in low:
            self.finish(req_id)
            return
        elif code in ENTITLEMENT_CODES or "permission" in low or "not subscribed" in low:
            err = IbError("entitlement", text, code)
        elif code == 200:
            err = IbError("no_contract", text, code)
        elif code in (502, 504, 1100, 1300):
            err = IbError("unavailable", text, code)
        else:
            err = IbError("ibkr_error", text, code)
        self.log("ib_message", req_id=req_id, code=code)
        h = self.holders.get(req_id)
        if h is not None:
            h.error = err
            h.done.set()
        elif req_id == -1 and isinstance(err, IbError) and err.kind == "unavailable":
            self.fail_all(err)

    def _call(self, start):
        with self.holders_lock:
            self.next_id += 1
            req_id = self.next_id
            holder = self.holders[req_id] = _Holder()
        try:
            start(req_id)
            if not holder.done.wait(IB_TIMEOUT):
                raise IbError("timeout", "gateway did not answer in time")
            if holder.error is not None:
                raise holder.error
            return holder.rows, req_id
        finally:
            with self.holders_lock:
                self.holders.pop(req_id, None)

    def _spec(self, req):
        from ibapi.contract import Contract

        c = Contract()
        c.symbol, c.secType, c.exchange, c.currency = req["symbol"], req["secType"], req["exchange"], req["currency"]
        if req.get("contractMonth"):
            c.lastTradeDateOrContractMonth = req["contractMonth"]
        return c

    def _details(self, req):
        ckey = (req["symbol"], req["secType"], req["exchange"], req["currency"], req.get("contractMonth"))
        cached = self.contracts.get(ckey)
        if cached and self.clock() - cached[0] < CONTRACT_TTL:
            return cached[1]
        rows, _ = self._call(lambda rid: self._client.reqContractDetails(rid, self._spec(req)))
        if not rows:
            raise IbError("no_contract", "no contract found", 200)
        if req["secType"] == "FUT":
            today = datetime.now(timezone.utc).strftime("%Y%m%d")
            live = [r for r in rows if (r.contract.lastTradeDateOrContractMonth or "")[:8] >= today] or rows
            rows = sorted(live, key=lambda r: r.contract.lastTradeDateOrContractMonth or "")
        d = rows[0]
        info = {"conId": d.contract.conId, "secType": d.contract.secType, "localSymbol": d.contract.localSymbol,
                "exchange": d.contract.exchange, "currency": d.contract.currency,
                "lastTradeDateOrContractMonth": d.contract.lastTradeDateOrContractMonth or None,
                "multiplier": d.contract.multiplier or None, "longName": getattr(d, "longName", "") or None,
                "timeZoneId": getattr(d, "timeZoneId", "") or None, "matches": len(rows)}
        self.contracts[ckey] = (self.clock(), info)
        return info

    def fetch(self, req, on_send):
        try:
            self._ensure()
        except OSError as e:
            self.connect_failures += 1
            raise IbError("unavailable", "gateway API not reachable: " + type(e).__name__)
        info = self._details(req)
        if req["secType"] == "CONTFUT":
            spec = self._spec(req)
        else:
            spec = self._spec(req)
            spec.conId = info["conId"]
            if req["secType"] == "FUT":
                spec.lastTradeDateOrContractMonth = info["lastTradeDateOrContractMonth"] or ""

        sent = []

        def start(rid):
            sent.append(rid)
            on_send()
            self.log("ib_historical", req_id=rid, symbol=req["symbol"], secType=req["secType"],
                     barSize=req["barSize"], duration=req["duration"])
            self._client.reqHistoricalData(rid, spec, "", req["duration"], req["barSize"], req["whatToShow"],
                                           1 if req["useRTH"] else 0, 2, False, [])

        try:
            rows, _ = self._call(start)
        except IbError as e:
            if e.kind == "timeout" and sent:
                self._cancel(sent[0])
            raise
        bars = [to_bar(b.date, b.open, b.high, b.low, b.close, b.volume) for b in rows]
        bars.sort(key=lambda b: b["t"])
        return info, bars

    def _cancel(self, req_id):
        try:
            self._client.cancelHistoricalData(req_id)
        except Exception:
            pass

    def close(self):
        if self._client is not None:
            self._client.disconnect()


def make_handler(service, token):
    expected = ("Bearer " + token).encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "vertex-history/" + VERSION
        sys_version = ""

        def log_message(self, fmt, *args):
            return

        def _send(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if status == 429 and isinstance(body.get("retry_after_seconds"), int):
                self.send_header("Retry-After", str(body["retry_after_seconds"]))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            got = (self.headers.get("Authorization") or "").encode()
            return hmac.compare_digest(got, expected)

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            parts = urlsplit(self.path)
            if parts.path == PREFIX + "/health":
                return self._send(*service.health())
            if parts.path == PREFIX + "/bars":
                status, body = service.bars(parse_qs(parts.query, keep_blank_values=True))
                return self._send(status, body)
            return self._send(404, {"error": "not_found"})

        def _not_allowed(self):
            self._send(405, {"error": "method_not_allowed"})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _not_allowed

    return Handler


def _log(event, **kw):
    print(json.dumps({"t": now_iso(time.time()), "event": event, **kw}, separators=(",", ":")), flush=True)


def main():
    token = os.environ.get("VERTEX_STATUS_TOKEN", "")
    if len(token) < 32:
        print("VERTEX_STATUS_TOKEN missing", file=sys.stderr)
        return 2
    cache_dir = os.environ.get("CACHE_DIRECTORY", "/var/cache/vertex-history")
    gateway_file = os.path.join(os.environ.get("RUNTIME_DIRECTORY", "/run/vertex-history"), "gateway")
    gateway = IbGateway(gateway_file, log=_log)
    service = HistoryService(gateway, DiskCache(cache_dir), Pacer(), log=_log)
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), make_handler(service, token))
    server.daemon_threads = True

    def watchdog():
        while True:
            time.sleep(15)
            if gateway.connect_failures >= 3:
                _log("exit_reresolve_gateway")
                os._exit(75)

    threading.Thread(target=watchdog, name="watchdog", daemon=True).start()
    _log("listening", host=LISTEN_HOST, port=LISTEN_PORT, version=VERSION, client_id=CLIENT_ID)
    try:
        server.serve_forever()
    finally:
        gateway.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
