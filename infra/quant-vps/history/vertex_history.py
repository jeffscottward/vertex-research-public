#!/usr/bin/env python3
"""Vertex read-only IBKR market data service (QuantVPS): historical bars, historical ticks, depth.

Read-only. One IB API session with client id 77, used for contract lookup, historical bars,
historical ticks (time & sales) and one-shot market depth snapshots, and nothing else. Listens on
127.0.0.1 only; reachable solely through the tailnet Caddy site (rig allow-list plus bearer token).
The bearer token is checked again here.

Pacing (historical requests, bars and ticks alike): at least 10 s apart, at most 6 per 120 s, an
identical request at most once per 15 s, and a 10 minute back-off after IBKR reports a pacing
violation. Results are cached on disk with a TTL per bar size; a stale copy (at most 24 h old) is
served while paced or backed off. Ticks: TRADES, then BID_ASK over the same window (two paced
requests), cached 15 s. Depth: one subscription at a time, at least 3 s apart, collected for 2 s
and always cancelled, cached 5 s. Each /ticks request has one 35 s budget and each /depth request
one 25 s budget, shared by the lock wait, pacing, the contract lookup and every IB request.

Tests: python3 infra/quant-vps/history/test_vertex_history.py
"""
import hashlib
import hmac
import json
import math
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

VERSION = "1.1.0"
SCHEMA = "vertex-history-bars-v1"
TICKS_SCHEMA = "vertex-history-ticks-v1"
DEPTH_SCHEMA = "vertex-history-depth-v1"
SOURCE = "ibkr-gateway"
CLIENT_ID = 77
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8791
PREFIX = "/vertex-history/v1"

SEC_TYPES = ("STK", "FUT", "CONTFUT", "CASH")
DEFAULT_EXCHANGE = {"STK": "SMART", "CASH": "IDEALPRO"}
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

# Ticks: IBKR caps one reqHistoricalTicks at 1000 ticks. Both requests (TRADES, BID_ASK) go through
# the historical pacer and must start within TICKS_MAX_WAIT of the HTTP request.
TICKS_MIN, TICKS_MAX, TICKS_DEFAULT = 50, 1000, 500
TICKS_TTL = 15
TICKS_STALE_MAX = 900
TICKS_MAX_WAIT = 30.0
TICKS_DEADLINE = 35.0  # one budget per /ticks request: lock, pacing, contract lookup, both IB requests
# Depth: one reqMktDepth at a time (lock), at least DEPTH_MIN_INTERVAL apart, collected for
# DEPTH_COLLECT_SECONDS, then cancelled.
DEPTH_ROWS_MAX, DEPTH_ROWS_DEFAULT = 20, 10
DEPTH_TTL = 5
DEPTH_STALE_MAX = 60
DEPTH_MIN_INTERVAL = 3.0
DEPTH_MAX_WAIT = 10.0
DEPTH_COLLECT_SECONDS = 2.0
DEPTH_DEADLINE = 25.0  # one budget per /depth request: lock, spacing, contract lookup, subscription

PARAMS = ("symbol", "secType", "exchange", "currency", "barSize", "duration", "whatToShow", "useRTH", "contractMonth")
TICKS_PARAMS = ("symbol", "secType", "exchange", "currency", "contractMonth", "count", "useRTH", "quotes")
DEPTH_PARAMS = ("symbol", "secType", "exchange", "currency", "contractMonth", "rows")
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,11}$")
EXCHANGE_RE = re.compile(r"^[A-Z][A-Z0-9.]{1,15}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
MONTH_RE = re.compile(r"^\d{6}(\d{2})?$")
DURATION_RE = re.compile(r"^([1-9]\d{0,2}) ([DWMY])$")
ACCOUNT_RE = re.compile(r"\b(?:D?U|F|I)\d{5,}\b")
INT_RE = re.compile(r"^\d{1,4}$")
VENUE_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,15}$")


class BadRequest(Exception):
    pass


class IbError(Exception):
    """kind: no_contract | entitlement | ibkr_error | unavailable | timeout"""

    def __init__(self, kind, message, code=None):
        super().__init__(message)
        self.kind, self.message, self.code = kind, message, code


class PacingViolation(Exception):
    pass


class Paced(Exception):
    """Our own pacer would wait past the request budget."""

    def __init__(self, retry_after):
        super().__init__("paced")
        self.retry_after = retry_after


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


def _single_values(raw, allowed):
    unknown = sorted(set(raw) - set(allowed))
    if unknown:
        raise BadRequest("unknown parameter: " + unknown[0][:40])
    values = {}
    for key, vals in raw.items():
        if len(vals) != 1:
            raise BadRequest("repeated parameter: " + key)
        values[key] = vals[0].strip()
    return values


def _instrument(values):
    sec_type = values.get("secType", "STK").upper()
    if sec_type not in SEC_TYPES:
        raise BadRequest("secType must be one of " + ", ".join(SEC_TYPES))
    symbol = values.get("symbol", "").upper()
    if not SYMBOL_RE.match(symbol):
        raise BadRequest("invalid symbol")
    exchange = values.get("exchange", DEFAULT_EXCHANGE.get(sec_type, "")).upper()
    if not EXCHANGE_RE.match(exchange):
        raise BadRequest("invalid exchange (required for futures)")
    currency = values.get("currency", "USD").upper()
    if not CURRENCY_RE.match(currency):
        raise BadRequest("invalid currency")
    return {"symbol": symbol, "secType": sec_type, "exchange": exchange, "currency": currency}


def _month(values, sec_type):
    month = values.get("contractMonth", "")
    if month and (sec_type != "FUT" or not MONTH_RE.match(month)):
        raise BadRequest("contractMonth is YYYYMM or YYYYMMDD and only for FUT")
    return month or None


def _flag(values, key, default):
    value = values.get(key, default)
    if value not in ("0", "1"):
        raise BadRequest(key + " must be 0 or 1")
    return value == "1"


def _bounded_int(values, key, default, low, high):
    value = values.get(key, str(default))
    if not INT_RE.match(value) or not low <= int(value) <= high:
        raise BadRequest("%s must be an integer from %d to %d" % (key, low, high))
    return int(value)


def validate(raw):
    """raw: dict of str -> list[str] (parse_qs). Returns a normalized request dict or raises BadRequest."""
    values = _single_values(raw, PARAMS)
    inst = _instrument(values)
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
    if inst["secType"] == "CASH":
        what = "MIDPOINT"  # IBKR has no TRADES data for forex
    rth = _flag(values, "useRTH", "1")
    month = _month(values, inst["secType"])
    return {"symbol": inst["symbol"], "secType": inst["secType"], "exchange": inst["exchange"],
            "currency": inst["currency"], "barSize": bar_size, "duration": duration, "whatToShow": what,
            "useRTH": rth, "contractMonth": month}


def validate_ticks(raw):
    """Historical ticks: the most recent `count` trade prints (and bid/ask quotes over the same window)."""
    values = _single_values(raw, TICKS_PARAMS)
    inst = _instrument(values)
    _reject_cash(inst, "ticks")
    count = _bounded_int(values, "count", TICKS_DEFAULT, TICKS_MIN, TICKS_MAX)
    rth = _flag(values, "useRTH", "0")
    quotes = _flag(values, "quotes", "1")
    month = _month(values, inst["secType"])
    return dict(inst, contractMonth=month, count=count, useRTH=rth, quotes=quotes)


def validate_depth(raw):
    """Depth snapshot. Stocks always use IBKR SMART depth; futures use the given exchange's own book."""
    values = _single_values(raw, DEPTH_PARAMS)
    inst = _instrument(values)
    _reject_cash(inst, "depth")
    rows = _bounded_int(values, "rows", DEPTH_ROWS_DEFAULT, 1, DEPTH_ROWS_MAX)
    month = _month(values, inst["secType"])
    smart = inst["secType"] == "STK"
    if smart:
        inst["exchange"] = "SMART"
    return dict(inst, contractMonth=month, rows=rows, smartDepth=smart)


def _reject_cash(inst, kind):
    if inst["secType"] == "CASH":
        raise BadRequest(kind + " are not supported for CASH (forex)")


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


def _finite(value):
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError("non-finite number")
    return number


def _text(value, limit):
    text = ACCOUNT_RE.sub("[account]", str(value or "")).strip()[:limit]
    return text or None


def to_trade(tick):
    """HistoricalTickLast -> {t, p, s, x (venue or null), c (special conditions or null)}."""
    return {"t": int(tick.time), "p": _finite(tick.price), "s": max(0.0, _finite(tick.size)),
            "x": _text(getattr(tick, "exchange", ""), 16), "c": _text(getattr(tick, "specialConditions", ""), 32)}


def to_quote(tick):
    """HistoricalTickBidAsk -> {t, bp, bs, ap, as}."""
    return {"t": int(tick.time), "bp": _finite(tick.priceBid), "bs": max(0.0, _finite(tick.sizeBid)),
            "ap": _finite(tick.priceAsk), "as": max(0.0, _finite(tick.sizeAsk))}


def convert_ticks(rows, convert, limit):
    """Oldest first, the newest `limit` only; malformed ticks are dropped."""
    out = []
    for row in rows:
        try:
            out.append(convert(row))
        except (AttributeError, TypeError, ValueError):
            continue
    out.sort(key=lambda tick: tick["t"])
    return out[-limit:] if limit > 0 else []


def parse_depth_notice(text):
    """IBKR notice 2152, e.g. "Exchanges - Depth: IEX; Top: BYX; EDGEA; Need additional market data
    permissions - Depth: ARCA; ISLAND;" -> {depth, top, missing}. Unknown format -> None."""
    sections = {"depth": [], "top": [], "missing": []}
    current, seen = None, False
    for token in ACCOUNT_RE.sub("[account]", str(text))[:4000].split(";"):
        token = token.strip()
        m = re.match(r"^(.*?)\b(Depth|Top|Missing)\s*:\s*(.*)$", token, re.I)
        if m:
            label = (m.group(1) + " " + m.group(2)).lower()
            if "need" in label or "permission" in label or "missing" in label:
                current = "missing"
            elif m.group(2).lower() == "top":
                current = "top"
            else:
                current = "depth"
            seen = True
            token = m.group(3).strip()
        if current is None or not token:
            continue
        name = token.upper()
        if VENUE_RE.match(name) and name not in sections[current] and len(sections[current]) < 40:
            sections[current].append(name)
    return sections if seen else None


def positive_tick(value):
    """ContractDetails.minTick as a positive float, or None when absent, zero or invalid."""
    try:
        tick = float(value)
    except (TypeError, ValueError):
        return None
    return tick if math.isfinite(tick) and tick > 0 else None


def size_multiplier(value):
    """ContractDetails.mdSizeMultiplier; 1 when absent or not positive."""
    try:
        number = _finite(value)
    except (TypeError, ValueError):
        return 1
    if number <= 0:
        return 1
    return int(number) if number.is_integer() else number


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


class DepthPacer:
    """Market depth subscriptions: at least DEPTH_MIN_INTERVAL apart. Not thread-safe; callers serialize."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.last = None

    def wait_for(self):
        if self.last is None:
            return 0.0
        return max(0.0, self.last + DEPTH_MIN_INTERVAL - self.clock())

    def record(self):
        self.last = self.clock()


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
    def __init__(self, gateway, cache, pacer, clock=time.time, sleep=time.sleep, log=None, depth_pacer=None):
        self.gateway, self.cache, self.pacer = gateway, cache, pacer
        self.depth_pacer = depth_pacer or DepthPacer(clock)
        self.clock, self.sleep = clock, sleep
        self.log = log or (lambda event, **kw: None)
        self.lock = threading.Lock()  # historical requests (bars, ticks): one at a time
        self.depth_lock = threading.Lock()  # at most one market depth subscription at a time

    def _ok(self, payload, age, ttl, hit, stale=False, camel=False):
        body = dict(payload)
        if camel:
            body["cache"] = {"hit": hit, "ageSeconds": age, "ttlSeconds": ttl, "stale": stale}
        else:
            body["cache"] = {"hit": hit, "age_seconds": age, "ttl_seconds": ttl, "stale": stale}
        return 200, body

    def _stale_or(self, key, ttl, status, body, stale_max=STALE_MAX_SECONDS, camel=False):
        stale = self.cache.get(key, stale_max)
        if stale:
            return self._ok(stale[0], stale[1], ttl, True, stale=True, camel=camel)
        return status, body

    def _ib_error(self, e, fallback):
        """Same status and body for every endpoint; unavailable and timeout may serve a stale copy."""
        status = {"no_contract": 422, "unavailable": 503, "timeout": 504}.get(e.kind, 502)
        body = {"error": e.kind, "message": scrub(e.message)}
        if e.code is not None:
            body["ibkr_code"] = e.code
        self.log("ib_error", kind=e.kind, code=e.code)
        if e.kind in ("unavailable", "timeout"):
            return fallback(status, body)
        return status, body

    def _violation(self, fallback):
        self.pacer.violation()
        self.log("pacing_violation", backoff_seconds=int(BACKOFF_SECONDS))
        return fallback(429, {"error": "pacing_violation", "retry_after_seconds": int(BACKOFF_SECONDS)})

    def bars(self, raw):
        try:
            req = validate(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(req), ttl_for(req)

        def fallback(status, body):
            return self._stale_or(key, ttl, status, body)

        hit = self.cache.get(key, ttl)
        if hit:
            return self._ok(hit[0], hit[1], ttl, True)
        deadline = self.clock() + MAX_WAIT
        if not self.lock.acquire(timeout=MAX_WAIT):
            return fallback(429, {"error": "busy", "retry_after_seconds": int(MIN_INTERVAL)})
        try:
            hit = self.cache.get(key, ttl)
            if hit:
                return self._ok(hit[0], hit[1], ttl, True)
            wait = self.pacer.wait_for(key)
            if self.clock() + wait > deadline:
                retry = int(wait) + 1
                self.log("paced", retry_after=retry)
                return fallback(429, {"error": "paced", "retry_after_seconds": retry})
            if wait > 0:
                self.sleep(wait)
            try:
                contract, bars = self.gateway.fetch(req, lambda: self.pacer.record(key))
            except PacingViolation:
                return self._violation(fallback)
            except IbError as e:
                return self._ib_error(e, fallback)
            fetched = self.clock()
            payload = {"schema": SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "contract": contract, "bars": bars, "count": len(bars), "fetched_at": now_iso(fetched),
                       "as_of": now_iso(bars[-1]["t"]) if bars else None}
            self.cache.put(key, payload)
            return self._ok(payload, 0, ttl, False)
        finally:
            self.lock.release()

    def ticks(self, raw):
        """Most recent trade prints (TRADES) and, with quotes, bid/ask (BID_ASK) over the same window.
        Field names match the API contract (camelCase), so the API passes them through."""
        try:
            req = validate_ticks(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(dict(req, endpoint="ticks")), TICKS_TTL

        def fallback(status, body):
            return self._stale_or(key, ttl, status, body, TICKS_STALE_MAX, camel=True)

        hit = self.cache.get(key, ttl)
        if hit:
            return self._ok(hit[0], hit[1], ttl, True, camel=True)
        start = self.clock()
        deadline = start + TICKS_MAX_WAIT
        budget_end = start + TICKS_DEADLINE

        def remaining():
            return budget_end - self.clock()

        if not self.lock.acquire(timeout=max(0.0, min(MAX_WAIT, remaining()))):
            return fallback(429, {"error": "busy", "retry_after_seconds": int(MIN_INTERVAL)})
        try:
            hit = self.cache.get(key, ttl)
            if hit:
                return self._ok(hit[0], hit[1], ttl, True, camel=True)
            first = self.pacer.wait_for(key + ":TRADES")
            # the BID_ASK request follows at least MIN_INTERVAL after TRADES; both must fit the budget
            if self.clock() + first + (MIN_INTERVAL if req["quotes"] else 0.0) > deadline:
                retry = int(first) + 1
                self.log("paced", retry_after=retry)
                return fallback(429, {"error": "paced", "retry_after_seconds": retry})

            def pace(what):
                pkey = key + ":" + what
                wait = self.pacer.wait_for(pkey)
                if self.clock() + wait > min(deadline, budget_end):
                    raise Paced(int(wait) + 1)
                if wait > 0:
                    self.sleep(wait)
                self.pacer.record(pkey)

            try:
                contract, trades, quotes, min_tick = self.gateway.fetch_ticks(req, pace, remaining)
            except Paced as e:
                self.log("paced", retry_after=e.retry_after)
                return fallback(429, {"error": "paced", "retry_after_seconds": e.retry_after})
            except PacingViolation:
                return self._violation(fallback)
            except IbError as e:
                return self._ib_error(e, fallback)
            payload = {"schema": TICKS_SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "contract": contract, "minTick": min_tick, "trades": trades, "quotes": quotes,
                       "fetchedAt": now_iso(self.clock()), "asOf": now_iso(trades[-1]["t"]) if trades else None}
            self.cache.put(key, payload)
            self.log("ticks", symbol=req["symbol"], trades=len(trades), quotes=len(quotes))
            return self._ok(payload, 0, ttl, False, camel=True)
        finally:
            self.lock.release()

    def depth(self, raw):
        """One-shot market depth snapshot (best first). Field names match the API contract (camelCase)."""
        try:
            req = validate_depth(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(dict(req, endpoint="depth")), DEPTH_TTL

        def fallback(status, body):
            return self._stale_or(key, ttl, status, body, DEPTH_STALE_MAX, camel=True)

        hit = self.cache.get(key, ttl)
        if hit:
            return self._ok(hit[0], hit[1], ttl, True, camel=True)
        start = self.clock()
        deadline = start + DEPTH_MAX_WAIT
        budget_end = start + DEPTH_DEADLINE

        def remaining():
            return budget_end - self.clock()

        if not self.depth_lock.acquire(timeout=max(0.0, min(DEPTH_MAX_WAIT, remaining()))):
            return fallback(429, {"error": "busy", "retry_after_seconds": int(DEPTH_MIN_INTERVAL)})
        try:
            hit = self.cache.get(key, ttl)
            if hit:
                return self._ok(hit[0], hit[1], ttl, True, camel=True)
            wait = self.depth_pacer.wait_for()
            if self.clock() + wait > min(deadline, budget_end):
                retry = int(wait) + 1
                self.log("depth_paced", retry_after=retry)
                return fallback(429, {"error": "paced", "retry_after_seconds": retry})
            if wait > 0:
                self.sleep(wait)
            try:
                contract, book = self.gateway.fetch_depth(req, self.depth_pacer.record, remaining)
            except PacingViolation:
                self.log("depth_paced", retry_after=int(DEPTH_MIN_INTERVAL))
                return fallback(429, {"error": "paced", "retry_after_seconds": int(DEPTH_MIN_INTERVAL)})
            except IbError as e:
                return self._ib_error(e, fallback)
            payload = {"schema": DEPTH_SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "contract": contract, "minTick": book.get("minTick"), "bids": book["bids"], "asks": book["asks"],
                       "sizeMultiplier": book["sizeMultiplier"], "venues": book["venues"],
                       "updates": book["updates"], "fetchedAt": now_iso(self.clock())}
            self.cache.put(key, payload)
            self.log("depth", symbol=req["symbol"], bids=len(book["bids"]), asks=len(book["asks"]),
                     updates=book["updates"])
            return self._ok(payload, 0, ttl, False, camel=True)
        finally:
            self.depth_lock.release()

    def health(self):
        return 200, {"schema": "vertex-history-health-v1", "version": VERSION, "client_id": CLIENT_ID,
                     "connected": self.gateway.connected(), "pacing": self.pacer.snapshot()}


class _Holder:
    def __init__(self):
        self.done = threading.Event()
        self.rows = []
        self.error = None


class DepthBook(_Holder):
    """Order book of one reqMktDepth subscription. Per side, levels by position (0 = best)."""

    def __init__(self):
        _Holder.__init__(self)
        self.bids, self.asks = [], []
        self.updates = 0
        self.venues = None
        self.lock = threading.Lock()

    def apply(self, position, operation, side, price, size, venue=None):
        """operation 0 insert, 1 update, 2 delete at position; side 0 ask, 1 bid (IBKR)."""
        try:
            position, operation, side = int(position), int(operation), int(side)
            level = {"price": _finite(price), "size": max(0.0, _finite(size)), "venue": _text(venue, 16)}
        except (TypeError, ValueError):
            return
        if side not in (0, 1) or operation not in (0, 1, 2) or position < 0:
            return
        with self.lock:
            self.updates += 1
            levels = self.bids if side == 1 else self.asks
            if operation == 0:
                levels.insert(min(position, len(levels)), level)
            elif operation == 1:
                if position < len(levels):
                    levels[position] = level
                else:
                    levels.append(level)
            elif position < len(levels):
                del levels[position]

    def reset(self):
        with self.lock:
            del self.bids[:]
            del self.asks[:]

    def snapshot(self, rows):
        """Best first (bids high to low, asks low to high; ties keep IBKR's position order), top `rows`."""
        with self.lock:
            bids = sorted(self.bids, key=lambda level: -level["price"])[:rows]
            asks = sorted(self.asks, key=lambda level: level["price"])[:rows]
            return [dict(level) for level in bids], [dict(level) for level in asks], self.updates


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

        def historicalTicksLast(self, reqId, ticks, done):
            self.owner.add_ticks(reqId, ticks, done)

        def historicalTicksBidAsk(self, reqId, ticks, done):
            self.owner.add_ticks(reqId, ticks, done)

        def updateMktDepth(self, reqId, position, operation, side, price, size):
            self.owner.depth_update(reqId, position, operation, side, price, size, None)

        def updateMktDepthL2(self, reqId, position, marketMaker, operation, side, price, size, isSmartDepth):
            self.owner.depth_update(reqId, position, operation, side, price, size, marketMaker)

        def error(self, reqId, errorCode, errorString, *rest):
            self.owner.on_error(reqId, errorCode, errorString)

        def connectionClosed(self):
            self.owner.ready.clear()
            self.owner.fail_all(IbError("unavailable", "gateway connection closed"))

    return Wrapper


INFO_CODES = {2103, 2104, 2105, 2106, 2107, 2108, 2119, 2157, 2158, 2174, 2176}
ENTITLEMENT_CODES = {354, 10089, 10090, 10092, 10167, 10168, 10186, 10197}
DEPTH_NOTICE_CODE = 2152  # venues with depth, top of book only, and missing permissions
DEPTH_RESET_CODE = 317  # "market depth data has been RESET": empty the book before new entries


class IbGateway:
    """The only code that talks to IB. Calls on self._client are limited to IB_CALLS (enforced by tests)."""

    IB_CALLS = ("connect", "disconnect", "isConnected", "run", "reqContractDetails", "reqHistoricalData",
                "cancelHistoricalData", "reqHistoricalTicks", "reqMktDepth", "cancelMktDepth")

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
        self.connect_lock = threading.Lock()
        self.active_depth = None
        self.depth_collect = DEPTH_COLLECT_SECONDS

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

    def add_ticks(self, req_id, ticks, done):
        h = self.holders.get(req_id)
        if h is not None:
            h.rows.extend(ticks or [])
            if done:
                h.done.set()

    def _depth_book(self, req_id):
        h = self.holders.get(req_id)
        if not isinstance(h, DepthBook) and self.active_depth is not None:
            h = self.holders.get(self.active_depth)
        return h if isinstance(h, DepthBook) else None

    def depth_update(self, req_id, position, operation, side, price, size, venue):
        h = self.holders.get(req_id)
        if isinstance(h, DepthBook):
            h.apply(position, operation, side, price, size, venue)

    def depth_notice(self, req_id, message):
        book = self._depth_book(req_id)
        if book is None:
            return
        venues = parse_depth_notice(message)
        if venues is not None:
            book.venues = venues
        self.log("ib_depth_notice", req_id=req_id, code=DEPTH_NOTICE_CODE, parsed=venues is not None)

    def fail_all(self, err):
        with self.holders_lock:
            for h in self.holders.values():
                h.error = err
                h.done.set()

    def on_error(self, req_id, code, message):
        code = int(code)
        if code in INFO_CODES:
            return
        if code == DEPTH_NOTICE_CODE:
            return self.depth_notice(req_id, message)
        if code == DEPTH_RESET_CODE:
            book = self._depth_book(req_id)
            if book is not None:
                book.reset()
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

    def _call(self, start, remaining=None):
        """One IB request; waits min(IB_TIMEOUT, remaining()) and never past the caller's budget."""
        if remaining is not None and remaining() <= 0:
            raise IbError("timeout", "request budget exhausted before the gateway answered")
        with self.holders_lock:
            self.next_id += 1
            req_id = self.next_id
            holder = self.holders[req_id] = _Holder()
        try:
            start(req_id)  # may include a pacing sleep, so the wait is sized afterwards
            timeout = IB_TIMEOUT if remaining is None else max(0.0, min(IB_TIMEOUT, remaining()))
            if not holder.done.wait(timeout):
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

    def _connect(self):
        with self.connect_lock:  # bars/ticks and depth run under different service locks
            try:
                self._ensure()
            except OSError as e:
                self.connect_failures += 1
                raise IbError("unavailable", "gateway API not reachable: " + type(e).__name__)

    def _details(self, req, remaining=None):
        return self._contract(req, remaining)[0]

    def _contract(self, req, remaining=None):
        """(contract info, mdSizeMultiplier, minTick or None) of the first live match, cached for CONTRACT_TTL."""
        ckey = (req["symbol"], req["secType"], req["exchange"], req["currency"], req.get("contractMonth"))
        cached = self.contracts.get(ckey)
        if cached and self.clock() - cached[0] < CONTRACT_TTL:
            return cached[1], cached[2], cached[3]
        rows, _ = self._call(lambda rid: self._client.reqContractDetails(rid, self._spec(req)), remaining)
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
        multiplier = size_multiplier(getattr(d, "mdSizeMultiplier", 0))
        min_tick = positive_tick(getattr(d, "minTick", None))
        self.contracts[ckey] = (self.clock(), info, multiplier, min_tick)
        return info, multiplier, min_tick

    def _resolved_spec(self, req, info):
        """The resolved contract by conId; continuous futures map to their current front month."""
        spec = self._spec(req)
        spec.conId = info["conId"]
        if req["secType"] in ("FUT", "CONTFUT"):
            spec.secType = "FUT"
            spec.lastTradeDateOrContractMonth = info["lastTradeDateOrContractMonth"] or ""
        return spec

    def fetch(self, req, on_send):
        self._connect()
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

    def fetch_ticks(self, req, pace, remaining=None):
        """The newest req["count"] trade prints, then (quotes) bid/ask quotes over the same window.
        pace(whatToShow) blocks until the historical pacer allows the request (or raises Paced) and
        records it; it runs immediately before each reqHistoricalTicks."""
        self._connect()
        info, _, min_tick = self._contract(req, remaining)
        spec = self._resolved_spec(req, info)
        end = datetime.fromtimestamp(self.clock(), tz=timezone.utc).strftime("%Y%m%d %H:%M:%S") + " UTC"
        trades = convert_ticks(self._historical_ticks(spec, end, req, "TRADES", pace, remaining), to_trade, req["count"])
        quotes = []
        if req["quotes"]:
            quotes = convert_ticks(self._historical_ticks(spec, end, req, "BID_ASK", pace, remaining), to_quote, req["count"])
        return info, trades, quotes, min_tick

    def _historical_ticks(self, spec, end, req, what, pace, remaining=None):
        def start(rid):
            pace(what)
            self.log("ib_historical_ticks", req_id=rid, symbol=req["symbol"], secType=req["secType"],
                     whatToShow=what, count=req["count"])
            self._client.reqHistoricalTicks(rid, spec, "", end, req["count"], what, 1 if req["useRTH"] else 0,
                                            True, [])

        rows, _ = self._call(start, remaining)
        return rows

    def fetch_depth(self, req, on_send, remaining=None):
        """Subscribe, fold depth updates into the book for depth_collect seconds, always cancel, then
        return the best-first top req["rows"] levels per side."""
        self._connect()
        info, multiplier, min_tick = self._contract(req, remaining)
        spec = self._resolved_spec(req, info)
        smart = bool(req["smartDepth"])
        book = DepthBook()
        with self.holders_lock:
            self.next_id += 1
            req_id = self.next_id
            self.holders[req_id] = book
            self.active_depth = req_id
        requested = False
        collect = self.depth_collect if remaining is None else min(self.depth_collect, remaining())
        if collect <= 0:
            with self.holders_lock:
                self.holders.pop(req_id, None)
                self.active_depth = None
            raise IbError("timeout", "request budget exhausted before the depth subscription")
        try:
            on_send()
            self.log("ib_depth", req_id=req_id, symbol=req["symbol"], secType=req["secType"], rows=req["rows"],
                     smartDepth=smart)
            requested = True
            self._client.reqMktDepth(req_id, spec, req["rows"], smart, [])
            book.done.wait(collect)  # an error ends the collection early
        finally:
            if requested:
                self._cancel_depth(req_id, smart)
            with self.holders_lock:
                self.holders.pop(req_id, None)
                if self.active_depth == req_id:
                    self.active_depth = None
        bids, asks, updates = book.snapshot(req["rows"])
        error = book.error
        # an error during collection wins over an empty (or one-sided) book; raising also skips the cache
        if error is not None and (not bids or not asks or (isinstance(error, IbError) and error.kind == "unavailable")):
            raise error
        return info, {"minTick": min_tick, "bids": bids, "asks": asks, "sizeMultiplier": multiplier, "venues": book.venues,
                      "updates": updates}

    def _cancel_depth(self, req_id, smart):
        try:
            self._client.cancelMktDepth(req_id, smart)
        except Exception as e:
            self.log("ib_cancel_depth_failed", req_id=req_id, kind=type(e).__name__)

    def close(self):
        if self._client is not None:
            self._client.disconnect()


def make_handler(service, token):
    expected = ("Bearer " + token).encode()
    routes = {PREFIX + "/bars": service.bars, PREFIX + "/ticks": service.ticks, PREFIX + "/depth": service.depth}

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
            route = routes.get(parts.path)
            if route is not None:
                status, body = route(parse_qs(parts.query, keep_blank_values=True))
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
