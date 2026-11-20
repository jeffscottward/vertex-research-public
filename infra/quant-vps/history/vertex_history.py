#!/usr/bin/env python3
"""Vertex read-only IBKR market data service (QuantVPS): historical bars, historical ticks, depth, news, tape.

Read-only. One IB API session with client id 77, used for contract lookup, historical bars,
historical ticks (time & sales), one-shot market depth snapshots and the streamed futures tape, and
nothing else. Listens on 127.0.0.1 only; reachable solely through the tailnet Caddy site (rig allow-list plus bearer token).
The bearer token is checked again here.

Pacing (historical requests, bars and ticks alike): at least 10 s apart, at most 6 per 120 s, an
identical request at most once per 15 s, and a 10 minute back-off after IBKR reports a pacing
violation. Results are cached on disk with a TTL per bar size; a stale copy (at most 24 h old) is
served while paced or backed off. Ticks: TRADES, then BID_ASK over the same window (two paced
requests), cached 15 s. Depth: one subscription at a time, at least 3 s apart, collected for 2 s
and always cancelled, cached 5 s. Each /ticks request has one 35 s budget and each /depth request
one 25 s budget, shared by the lock wait, pacing, the contract lookup and every IB request.

Bars take an optional endDateTime=YYYYMMDD-HH:MM:SS (UTC, IBKR's form; absent = now): a real instant from
1990-01-01 up to, not including, the service clock, refused for CONTFUT. It is part of the cache key and the
request echo. A copy fetched at least 24 h after its endDateTime is cached for up to 24 h. whatToShow=BID_ASK
(stocks only): open = time-average bid, high = max ask, low = min bid, close = time-average ask, volume null.

1.3.0 (card vertex-yahoo-terms-decision, owner 2026-11-10 "Extend it"): daily bars take up to 30 Y in one request
(longer than 365 days only in Y units); whatToShow=ADJUSTED_LAST (stocks, daily, no endDateTime: IBKR refuses an
end date for it) gives split- and dividend-adjusted bars; secType=IND (indices such as VIX on CBOE, TRADES bars,
exchange required) serves bars only, not ticks or depth.
/news (1.3.0): newest headlines for one stock from every API news provider on the account (read-only:
reqNewsProviders, reqHistoricalNews).
/option-chain (1.4.0, card vertex-options-chain-ibkr): top-of-book quotes for the strikes nearest the money of one
stock option expiry (read-only: reqSecDefOptParams, then one-shot reqMktData snapshots, never a regulatory
snapshot, never a streaming reqMktData subscription). Off unless VERTEX_HISTORY_OPTION_QUOTES=1.
/tape (1.5.0, card vertex-flow-streaming-tape): the newest ES and NQ prints of the front month, kept in memory with
the bid and ask that were in force when each print arrived. The only streaming subscriptions of the service are
four tick-by-tick streams: per symbol the quote stream (BidAsk, price changes only) and, 16 s later, the trade
stream (AllLast). Both requests sit in one gateway method with literal arguments (enforced by tests). /tape serves
whole exchange seconds from `since`, oldest first, with the covered intervals; it sends no IBKR request. While the
file tape-off exists in the configuration directory (/etc/vertex-history), the service holds no tick-by-tick
subscription; no restart is needed. When IBKR reports the subscription cap (error 10190), the tape stops until
the process restarts.
1.6.0 (design history-ibapi-10-30): IBKR API client 10.30.1 (server version 163 or later; the service does not
start with an older client). Bars schema vertex-history-bars-v2 adds `volume_unit`: "shares" (STK in USD),
"contracts" (FUT, CONTFUT), "unqualified" (STK in another currency; volume null) or null (IND, CASH; volume null).
Every IBKR size goes through ib_size: the client's unset value, a negative or a non-finite size is missing.
A bar with a missing volume has volume null; a tick, tape print or depth level with a missing size is dropped and
counted (health `unsetSizes`).

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
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

VERSION = "1.6.0"
SCHEMA = "vertex-history-bars-v2"
MIN_CLIENT_VER = 163  # ibapi.server_versions.MAX_CLIENT_VER of 10.30.1; older clients get wrong sizes
# The client's UNSET_DECIMAL is Decimal(2**127 - 1); any size at or above this bound is "not set".
UNSET_SIZE_FLOOR = 1e37
STARTED_AT = time.time()
TICKS_SCHEMA = "vertex-history-ticks-v1"
DEPTH_SCHEMA = "vertex-history-depth-v1"
SOURCE = "ibkr-gateway"
CLIENT_ID = 77
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8791
PREFIX = "/vertex-history/v1"

SEC_TYPES = ("STK", "FUT", "CONTFUT", "CASH", "IND")
DEFAULT_EXCHANGE = {"STK": "SMART", "CASH": "IDEALPRO"}
BARS_ONLY_SEC_TYPES = {"CASH": "CASH (forex)", "IND": "IND (indices)"}
WHAT_TO_SHOW = ("TRADES", "MIDPOINT", "BID_ASK", "ADJUSTED_LAST")
# ADJUSTED_LAST (IBKR): daily bars adjusted for splits and dividends; IBKR requires an empty end date.
ADJUSTED_SEC_TYPES = ("STK",)
DAILY_MAX_DAYS = 30 * 365  # 30 Y; above 365 days IBKR takes the duration in years only
# BID_ASK bars (IBKR semantics): open = time-average bid, high = max ask, low = min bid, close = time-average ask,
# volume n/a (null). Offered for stocks only here; forex stays MIDPOINT and futures TRADES/MIDPOINT.
BID_ASK_SEC_TYPES = ("STK",)
BAR_SIZES = {"1 min": 60, "5 mins": 300, "15 mins": 900, "30 mins": 1800, "1 hour": 3600, "1 day": 86400}
UNIT_DAYS = {"D": 1, "W": 7, "M": 30, "Y": 365}
TTL_SECONDS = {"1 min": 120, "1 day": 3600}
DEFAULT_TTL = 300
STALE_MAX_SECONDS = 86400
# endDateTime (bars): IBKR's UTC form, in the past, not before 1990. A range that ended at least
# SETTLE_SECONDS before a copy was fetched no longer changes, so that copy is good for up to PAST_TTL.
END_DATETIME_RE = re.compile(r"([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2}):([0-9]{2}):([0-9]{2})")  # fullmatch, ASCII
END_DATETIME_MIN = datetime(1990, 1, 1, tzinfo=timezone.utc)
SETTLE_SECONDS = 86400
PAST_TTL = 86400
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
# Tape (1.5.0): tick-by-tick trades and quotes of the front-month ES and NQ contracts, a ring of prints per symbol.
TAPE_SCHEMA = "vertex-history-tape-v1"
TAPE_OFF_FILE = "tape-off"  # in the configuration directory: while it exists, no tick-by-tick subscription
TAPE_SYMBOLS = ("ES", "NQ")
TAPE_RING = 200_000  # prints kept per symbol
# /tape serves seconds at least TAPE_SETTLE_SECONDS old. A second is covered only when, in addition, a print of a
# later second arrived: one trade stream delivers its prints in exchange order, so that print proves that the
# second is complete, also when the reader is some seconds behind.
TAPE_SETTLE_SECONDS = 3
TAPE_MAX = 20_000  # prints per /tape answer (whole seconds; a single second is never split)
TAPE_SEED_SCAN = 5_000  # prints before `since` searched for previousDifferentPrice: a short scan under the lock
TAPE_IDLE_SECONDS = 60.0  # prints further apart end a covered span; stall limit while another feed prints
TAPE_QUIET_SECONDS = 1800.0  # a feed without a print this long (closed market, silent outage) is subscribed again
TAPE_RETRY_SECONDS = 30.0  # a feed's wait before a new subscription; doubles after each attempt without a print
TAPE_RETRY_MAX_SECONDS = 300.0
TAPE_TRADES_DELAY_SECONDS = 16.0  # IBKR: one tick-by-tick request per instrument in 15 s; quotes first, then trades
TAPE_LAG_SECONDS = 5.0  # a print this long after its exchange second is late (the reader is behind)
TAPE_SPANS = 512
TAPE_BREAK_CODES = (2103, 2105)  # a market data farm is broken: prints can be missing, the covered span ends
TAPE_LOST_CODE = 1101  # connectivity returned, data lost: market data requests must be sent again
TAPE_CAP_CODE = 10190  # the account's tick-by-tick subscription cap: the tape stops until the process restarts
# News (1.3.0): headlines from every news provider the account has for API use (reqNewsProviders, cached 24 h),
# newest first via reqHistoricalNews. One news request at a time, at least NEWS_MIN_INTERVAL apart, cached
# NEWS_TTL; a stale copy up to NEWS_STALE_MAX is served when IBKR is unavailable.
NEWS_SCHEMA = "vertex-history-news-v1"
NEWS_MIN, NEWS_MAX, NEWS_DEFAULT = 1, 50, 20
NEWS_TTL = 300
NEWS_STALE_MAX = 3600
NEWS_MIN_INTERVAL = 3.0
NEWS_DEADLINE = 25.0  # one budget per /news request: lock, spacing, contract lookup, providers, headlines
PROVIDERS_TTL = 86400
PROVIDERS_EMPTY_TTL = 300
HEADLINE_META_RE = re.compile(r"^\{[^{}]{0,300}\}")  # IBKR prefixes some headlines with {A:...:L:en:K:...}
# Option chain (1.4.0): reqSecDefOptParams (cached CONTRACT_TTL), one reqMktData snapshot of the underlying, then one
# snapshot per call and put of the strikes nearest the money, all in one wave. Market data snapshots use the market
# data lines of the IB gateway that the live engine shares, so the endpoint is off by default and the owner turns it
# on with VERTEX_HISTORY_OPTION_QUOTES=1 (read once at start-up). Every reqMktData is a one-shot snapshot with
# regulatorySnapshot=False (a regulatory snapshot costs money per request) and no generic ticks; reqMarketDataType
# is never called, so the session keeps the gateway's default (live) market data type.
OPTION_CHAIN_SCHEMA = "vertex-history-option-chain-v1"
OPTION_QUOTES_ENV = "VERTEX_HISTORY_OPTION_QUOTES"
OPTION_STRIKES_MAX, OPTION_STRIKES_DEFAULT = 12, 8
OPTION_SNAPSHOT_MAX = 2 * OPTION_STRIKES_MAX + 1  # snapshot requests per /option-chain call, underlying included
OPTION_TTL = 30
OPTION_STALE_MAX = 300
OPTION_MIN_INTERVAL = 5.0
OPTION_MAX_WAIT = 2.0  # longest wait for the lock; then 429 busy
OPTION_MIN_WINDOW = 3.0  # no snapshot wave is sent with less budget left than this; the answer is 504
# reqMktData and cancelMktData sends of the option path in any one second. IB accepts 50 messages per second from one
# client; a full call (25 requests, 25 cancels) would send 50 in about a second without this limit.
OPTION_MESSAGES_PER_SECOND = 40
OPTION_SNAPSHOT_SECONDS = 12.0  # IBKR ends a snapshot after about 11 s at the latest
# Longest wait for the underlying snapshot; then the price rule takes what is there (last, midpoint, close). With the
# lock wait (2 s) and the spacing (5 s) this leaves OPTION_MIN_WINDOW of the budget for the option wave.
OPTION_UNDERLYING_SECONDS = 4.0
# One budget per /option-chain request: lock, spacing, lookups, both snapshot waves. The consumer waits 15 s.
OPTION_DEADLINE = 14.0
OPTION_CLOSE_ZONE, OPTION_CLOSE_HOUR = "America/New_York", 16  # an expiry counts until its 16:00 New York close
OPTION_SUBSCRIPTION_CODES = {354, 10089, 10090, 10091, 10167, 10168}  # market data not subscribed (for the API)
# Warnings IB addresses to one snapshot request and may still follow with prices: they are recorded, they do not end
# the snapshot (that takes tickSnapshotEnd, a terminal error or the deadline).
OPTION_WARNING_CODES = {10090, 10091, 10167}
# A wave whose option rows are all not_subscribed means the account has no option market data for the API. The
# service then makes no IB call for /option-chain for this long: at most one such wave per 15 minutes.
OPTION_NOT_SUBSCRIBED_SECONDS = 900
OPTION_PRICE_MAX = 1e9  # a snapshot price at or above this is a sentinel (the unset double of the IB API is DBL_MAX), not a price
# tickPrice types: live 1 bid, 2 ask, 4 last, 9 close; their delayed twins 66, 67, 68, 75
PRICE_TICKS = {1: "bid", 2: "ask", 4: "last", 9: "close", 66: "bid", 67: "ask", 68: "last", 75: "close"}
DELAYED_PRICE_TICKS = {66, 67, 68, 75}
MARKET_DATA_TYPES = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed-frozen"}  # marketDataType callback
OPTION_UNDERLYING = {"secType": "STK", "exchange": "SMART", "currency": "USD"}  # stock underlyings only

PARAMS = ("symbol", "secType", "exchange", "currency", "barSize", "duration", "whatToShow", "useRTH", "contractMonth",
          "endDateTime")
TICKS_PARAMS = ("symbol", "secType", "exchange", "currency", "contractMonth", "count", "useRTH", "quotes")
DEPTH_PARAMS = ("symbol", "secType", "exchange", "currency", "contractMonth", "rows")
TAPE_PARAMS = ("symbol", "since")
NEWS_PARAMS = ("symbol", "secType", "exchange", "currency", "count")
OPTION_CHAIN_PARAMS = ("symbol", "expiry", "strikes")
EXPIRY_RE = re.compile(r"[0-9]{8}")  # fullmatch, ASCII
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,11}( [A-Z])?$")  # IBKR class shares: "BRK B"
EXCHANGE_RE = re.compile(r"^[A-Z][A-Z0-9.]{1,15}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
MONTH_RE = re.compile(r"^\d{6}(\d{2})?$")
DURATION_RE = re.compile(r"^([1-9]\d{0,2}) ([DWMY])$")
ACCOUNT_RE = re.compile(r"\b(?:D?U|F|I)\d{5,}\b")
INT_RE = re.compile(r"^\d{1,4}$")
SINCE_RE = re.compile(r"^\d{1,10}$")
VENUE_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,15}$")


class BadRequest(Exception):
    pass


class IbError(Exception):
    """kind: no_contract | entitlement | ibkr_error | unavailable | timeout | no_option_chain | expiry_not_listed"""

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
        return DAILY_MAX_DAYS
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
        raise BadRequest("invalid exchange (required for futures and indices)")
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


def end_datetime_ts(text):
    """`YYYYMMDD-HH:MM:SS` (UTC) -> epoch seconds; ValueError when malformed or not a real date and time."""
    m = END_DATETIME_RE.fullmatch(text)
    if not m:
        raise ValueError("endDateTime must be YYYYMMDD-HH:MM:SS (UTC)")
    return datetime(*(int(g) for g in m.groups()), tzinfo=timezone.utc).timestamp()


def _end_datetime(values, sec_type, now):
    """Absent -> None (IBKR's "" = now). Present: a real UTC instant from 1990 up to, not including, now."""
    if "endDateTime" not in values:
        return None
    text = values["endDateTime"]
    if sec_type == "CONTFUT":
        raise BadRequest("endDateTime is not supported for CONTFUT (IBKR rejects an end date for continuous "
                         "futures); use secType=FUT with contractMonth")
    try:
        ts = end_datetime_ts(text)
    except ValueError:
        raise BadRequest("endDateTime must be YYYYMMDD-HH:MM:SS (UTC) and a real date and time") from None
    if ts < END_DATETIME_MIN.timestamp():
        raise BadRequest("endDateTime must not be before 19900101-00:00:00")
    if ts >= now:
        raise BadRequest("endDateTime must be in the past")
    return text


def validate(raw, now=None):
    """raw: dict of str -> list[str] (parse_qs). Returns a normalized request dict or raises BadRequest.
    now: the service clock (epoch seconds) that endDateTime must precede; defaults to time.time()."""
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
    if days > 365 and m.group(2) != "Y":
        raise BadRequest("durations longer than 365 days take Y units (IBKR)")
    what = values.get("whatToShow", "TRADES").upper()
    if what not in WHAT_TO_SHOW:
        raise BadRequest("whatToShow must be one of " + ", ".join(WHAT_TO_SHOW))
    if what == "BID_ASK" and inst["secType"] not in BID_ASK_SEC_TYPES:
        raise BadRequest("whatToShow=BID_ASK is offered for " + ", ".join(BID_ASK_SEC_TYPES) + " only")
    if what == "ADJUSTED_LAST":
        if inst["secType"] not in ADJUSTED_SEC_TYPES:
            raise BadRequest("whatToShow=ADJUSTED_LAST is offered for " + ", ".join(ADJUSTED_SEC_TYPES) + " only")
        if bar_size != "1 day":
            raise BadRequest("whatToShow=ADJUSTED_LAST is offered for 1 day bars only")
        if "endDateTime" in values:
            raise BadRequest("whatToShow=ADJUSTED_LAST takes no endDateTime (IBKR); ask for a longer duration")
    if inst["secType"] == "IND" and what != "TRADES":
        raise BadRequest("IND (indices) offers whatToShow=TRADES only")
    if inst["secType"] == "CASH":
        what = "MIDPOINT"  # IBKR has no TRADES data for forex
    rth = _flag(values, "useRTH", "1")
    month = _month(values, inst["secType"])
    end = _end_datetime(values, inst["secType"], time.time() if now is None else now)
    req = {"symbol": inst["symbol"], "secType": inst["secType"], "exchange": inst["exchange"],
           "currency": inst["currency"], "barSize": bar_size, "duration": duration, "whatToShow": what,
           "useRTH": rth, "contractMonth": month}
    if end is not None:  # only when given: requests without it keep their cache key and echo
        req["endDateTime"] = end
    return req


def validate_ticks(raw):
    """Historical ticks: the most recent `count` trade prints (and bid/ask quotes over the same window)."""
    values = _single_values(raw, TICKS_PARAMS)
    inst = _instrument(values)
    _reject_bars_only(inst, "ticks")
    count = _bounded_int(values, "count", TICKS_DEFAULT, TICKS_MIN, TICKS_MAX)
    rth = _flag(values, "useRTH", "0")
    quotes = _flag(values, "quotes", "1")
    month = _month(values, inst["secType"])
    return dict(inst, contractMonth=month, count=count, useRTH=rth, quotes=quotes)


def validate_depth(raw):
    """Depth snapshot. Stocks always use IBKR SMART depth; futures use the given exchange's own book."""
    values = _single_values(raw, DEPTH_PARAMS)
    inst = _instrument(values)
    _reject_bars_only(inst, "depth")
    rows = _bounded_int(values, "rows", DEPTH_ROWS_DEFAULT, 1, DEPTH_ROWS_MAX)
    month = _month(values, inst["secType"])
    smart = inst["secType"] == "STK"
    if smart:
        inst["exchange"] = "SMART"
    return dict(inst, contractMonth=month, rows=rows, smartDepth=smart)


def validate_tape(raw):
    """Streamed tape: one of TAPE_SYMBOLS and the first exchange second wanted (epoch seconds). Both are required."""
    values = _single_values(raw, TAPE_PARAMS)
    symbol = values.get("symbol", "").upper()
    if symbol not in TAPE_SYMBOLS:
        raise BadRequest("symbol must be one of " + ", ".join(TAPE_SYMBOLS))
    since = values.get("since", "")
    if not SINCE_RE.match(since):
        raise BadRequest("since must be epoch seconds (1 to 10 digits)")
    return {"symbol": symbol, "since": int(since)}


def tape_request(symbol):
    """The contract request of a tape symbol: the continuous future, so IBKR names the front month."""
    return {"symbol": symbol, "secType": "CONTFUT", "exchange": "CME", "currency": "USD", "contractMonth": None}


def _reject_bars_only(inst, kind):
    label = BARS_ONLY_SEC_TYPES.get(inst["secType"])
    if label:
        raise BadRequest(kind + " are not supported for " + label)


def validate_news(raw):
    """News headlines for one stock: the newest `count` from all API news providers on the account."""
    values = _single_values(raw, NEWS_PARAMS)
    inst = _instrument(values)
    if inst["secType"] != "STK":
        raise BadRequest("news are offered for STK only")
    count = _bounded_int(values, "count", NEWS_DEFAULT, NEWS_MIN, NEWS_MAX)
    return dict(inst, count=count)


def option_quotes_enabled(environ=None):
    """The /option-chain switch: on only when VERTEX_HISTORY_OPTION_QUOTES is exactly "1"."""
    return (os.environ if environ is None else environ).get(OPTION_QUOTES_ENV) == "1"


def validate_option_chain(raw):
    """Option chain of one stock (always STK on SMART in USD; no secType parameter): `expiry` YYYYMMDD (absent = nearest listed expiry that has
    not closed), `strikes` = how many listed strikes nearest the underlying price (a call and a put each)."""
    values = _single_values(raw, OPTION_CHAIN_PARAMS)
    symbol = values.get("symbol", "").upper()
    if not SYMBOL_RE.match(symbol):
        raise BadRequest("invalid symbol")
    expiry = None
    if "expiry" in values:
        expiry = values["expiry"]
        if not EXPIRY_RE.fullmatch(expiry):
            raise BadRequest("expiry must be YYYYMMDD")
        try:
            expiry_close_ts(expiry)
        except ValueError:
            raise BadRequest("expiry must be YYYYMMDD and a real date") from None
    strikes = _bounded_int(values, "strikes", OPTION_STRIKES_DEFAULT, 1, OPTION_STRIKES_MAX)
    return {"symbol": symbol, "expiry": expiry, "strikes": strikes}


_option_zone = None  # the resolved OPTION_CLOSE_ZONE; set once by option_zone()


def option_zone():
    """The America/New_York zone, resolved once and kept. None when the host has no tz data for it (ZoneInfo then
    raises ZoneInfoNotFoundError, a KeyError); HistoryService turns the option switch off in that case."""
    global _option_zone
    if _option_zone is None:
        try:
            _option_zone = ZoneInfo(OPTION_CLOSE_ZONE)
        except Exception:
            return None
    return _option_zone


def expiry_close_ts(expiry):
    """`YYYYMMDD` -> epoch seconds of that day's 16:00 America/New_York close; ValueError when not a real date."""
    day = datetime.strptime(expiry, "%Y%m%d")
    zone = option_zone()
    if zone is None:  # not reachable through the service: without the zone the switch is off
        raise IbError("unavailable", "time zone data for %s is missing" % OPTION_CLOSE_ZONE)
    return datetime(day.year, day.month, day.day, OPTION_CLOSE_HOUR, tzinfo=zone).timestamp()


def pick_expiry(expirations, wanted, now):
    """wanted when listed and its close is after now (else None); without wanted the first listed expiry whose
    close is after now."""
    if wanted is not None:
        return wanted if wanted in expirations and expiry_close_ts(wanted) > now else None
    for expiry in sorted(expirations):
        if expiry_close_ts(expiry) > now:
            return expiry
    return None


def nearest_strikes(strikes, price, count):
    """The `count` listed strikes nearest to price (ties: the lower strike first), ascending."""
    near = sorted(set(strikes), key=lambda strike: (abs(strike - price), strike))[:max(0, count)]
    return sorted(near)


def underlying_price(quote):
    """The underlying price used to pick strikes: last if > 0, else the bid/ask midpoint (both > 0), else close
    if > 0, else None."""
    bid, ask, last, close = (quote.get(name) or 0 for name in ("bid", "ask", "last", "close"))
    if last > 0:
        return last
    if bid > 0 and ask > 0:
        return (bid + ask) / 2.0
    return close if close > 0 else None


def underlying_complete(prices):
    """The underlying snapshot has what the request needs: a last above 0, or a bid and an ask above 0. A close
    alone is not enough to stop waiting; underlying_price still falls back to it at the end of the window."""
    bid, ask, last = (prices.get(name) or 0 for name in ("bid", "ask", "last"))
    return last > 0 or (bid > 0 and ask > 0)


def option_quote_complete(prices):
    """An option snapshot has what the consumer needs: a bid that is not null (0 is a real bid) and an ask above
    0. The same test says whether "a bid and an ask arrived" after a warning code."""
    return prices.get("bid") is not None and (prices.get("ask") or 0) > 0


def option_price(value):
    """One snapshot price: kept only when finite, not negative and below OPTION_PRICE_MAX; anything else is None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if 0 <= number < OPTION_PRICE_MAX else None  # NaN fails both comparisons


def option_error_kind(error):
    """Per-contract error label of one option snapshot request: not_subscribed only for the market data
    subscription codes; every other error (10197 competing live session included) is ib_error."""
    code = getattr(error, "code", None)
    kind = getattr(error, "kind", None)
    if code == 200 or kind == "no_contract":
        return "no_security_definition"
    if code in OPTION_SUBSCRIPTION_CODES:
        return "not_subscribed"
    return "ib_error"


def option_quote_row(strike, right, holder):
    """The published row of one option snapshot. One rule: a row with an error has bid, ask and last null and
    dataType as IB reported it (or null). A row with a bid and an ask (option_quote_complete) is a good row, with
    or without tickSnapshotEnd and also after a warning code; last is null when it had not arrived. Without
    them, a warning code makes the row not_subscribed and the end of the window makes it timeout."""
    prices = holder.prices
    if holder.error is not None:
        label = option_error_kind(holder.error)
    elif holder.warning is not None and not option_quote_complete(prices):
        label = "not_subscribed"
    elif holder.timed_out:
        label = "timeout"
    else:
        label = None
    bid, ask, last = (None, None, None) if label else (prices["bid"], prices["ask"], prices["last"])
    return {"strike": strike, "right": right, "bid": bid, "ask": ask, "last": last,
            "dataType": holder.reported_type(), "error": label}


def parse_news_time(text):
    """IBKR's `YYYY-MM-DD HH:MM:SS[.f]` -> epoch seconds, read as UTC (IBKR: "UTC assumed"; to be confirmed
    against a live headline, see docs/vertex-rebuild/quantvps-status-endpoint.md); ValueError when malformed."""
    return int(datetime.strptime(str(text).split(".")[0], "%Y-%m-%d %H:%M:%S")
               .replace(tzinfo=timezone.utc).timestamp())


def to_news_item(time_text, provider, article_id, headline):
    """None for a row without a readable time or headline."""
    try:
        t = parse_news_time(time_text)
    except ValueError:
        return None
    text = _text(HEADLINE_META_RE.sub("", str(headline or "")), 500)
    if text is None:
        return None
    return {"t": t, "time": now_iso(t), "provider": _text(provider, 16), "articleId": _text(article_id, 64),
            "headline": text}


def cache_key(req):
    return hashlib.sha256(json.dumps(req, sort_keys=True).encode()).hexdigest()


def ttl_for(req, now=None):
    """Max cache age accepted now. Past ranges: a copy fetched at least SETTLE_SECONDS after endDateTime is good
    for up to PAST_TTL; that holds exactly while age <= now - end - SETTLE_SECONDS, so the bound is
    min(PAST_TTL, now - end - SETTLE_SECONDS), never below the bar size's normal TTL."""
    base = TTL_SECONDS.get(req["barSize"], DEFAULT_TTL)
    end = req.get("endDateTime")
    if not end:
        return base
    settled_for = (time.time() if now is None else now) - end_datetime_ts(end) - SETTLE_SECONDS
    return max(base, min(PAST_TTL, int(settled_for)))


def parse_bar_time(text):
    s = str(text).strip()
    if re.fullmatch(r"\d{8}", s):
        return int(datetime.strptime(s, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp())
    if re.fullmatch(r"\d{9,11}", s):
        return int(s)
    raise ValueError("unexpected bar time format")


class DecodeError(Exception):
    """IBKR sent a bar that cannot be converted."""


class MissingSize(ValueError):
    """IBKR sent no usable size (unset, negative or non-finite)."""


class _Counter:
    def __init__(self):
        self.value = 0
        self.lock = threading.Lock()

    def add(self, n=1):
        with self.lock:
            self.value += n


UNSET_SIZES = _Counter()  # ticks, tape prints and depth levels dropped for a missing size since start


def count_unset(where, n=1):
    if n > 0:
        UNSET_SIZES.add(n)
        _log("ib_unset_size", where=where, count=n)


def ib_size(value):
    """One IBKR size (Decimal, float or int) -> float, or None when missing: the client's unset value,
    a negative or a non-finite number. A value that is not a number raises TypeError or ValueError."""
    if value is None or isinstance(value, bool):
        raise TypeError("size is not a number")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")) or number < 0 or number >= UNSET_SIZE_FLOOR:
        return None
    return number


def volume_unit(sec_type, currency):
    """Unit of bar volume: shares (STK in USD), contracts (FUT, CONTFUT), unqualified (STK in another
    currency) or None (IND, CASH: IBKR sends no real volume)."""
    if sec_type == "STK":
        return "shares" if currency == "USD" else "unqualified"
    if sec_type in ("FUT", "CONTFUT"):
        return "contracts"
    return None


def to_bar(date, o, h, l, c, v):
    return {"t": parse_bar_time(date), "o": _finite(o), "h": _finite(h), "l": _finite(l), "c": _finite(c),
            "v": ib_size(v)}


def to_bars(rows):
    try:
        return [to_bar(b.date, b.open, b.high, b.low, b.close, b.volume) for b in rows]
    except (AttributeError, TypeError, ValueError, ArithmeticError) as e:
        raise DecodeError(type(e).__name__) from None


def _size_or_missing(value):
    size = ib_size(value)
    if size is None:
        raise MissingSize("missing size")
    return size


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
    return {"t": int(tick.time), "p": _finite(tick.price), "s": _size_or_missing(tick.size),
            "x": _text(getattr(tick, "exchange", ""), 16), "c": _text(getattr(tick, "specialConditions", ""), 32)}


def to_quote(tick):
    """HistoricalTickBidAsk -> {t, bp, bs, ap, as}."""
    return {"t": int(tick.time), "bp": _finite(tick.priceBid), "bs": _size_or_missing(tick.sizeBid),
            "ap": _finite(tick.priceAsk), "as": _size_or_missing(tick.sizeAsk)}


def convert_ticks(rows, convert, limit):
    """Oldest first, the newest `limit` only; malformed ticks are dropped, ticks with a missing size counted."""
    out, unset = [], 0
    for row in rows:
        try:
            out.append(convert(row))
        except MissingSize:
            unset += 1
        except (AttributeError, TypeError, ValueError, ArithmeticError):
            continue
    count_unset("ticks", unset)
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


class MessageLimiter:
    """At most `limit` sends in any window of `period` seconds: wait() returns when one more send is allowed and
    counts it. The sleep runs in real time, so it uses up the budget of the request that waits. One wait() never
    sleeps longer than `period`."""

    def __init__(self, limit, period=1.0, clock=time.monotonic, sleep=time.sleep):
        self.limit, self.period, self.clock, self.sleep = limit, period, clock, sleep
        self.sent = deque()  # send times inside the last period, oldest first
        self.lock = threading.Lock()

    def _now(self):
        """The clock, after the recorded sends that no longer count are dropped."""
        now = self.clock()
        if self.sent and now < self.sent[-1]:  # the clock went back: start a new window, do not sleep it out
            self.sent.clear()
        while self.sent and now - self.sent[0] >= self.period:
            self.sent.popleft()
        return now

    def wait(self):
        with self.lock:
            now, slept = self._now(), 0.0
            while len(self.sent) >= self.limit and slept < self.period:
                pause = min(self.period - slept, max(0.0, self.sent[0] + self.period - now))
                if pause <= 0:
                    break
                self.sleep(pause)
                slept += pause
                now = self._now()
            if len(self.sent) >= self.limit:  # the clock did not move with the sleep: start a new window
                self.sent.clear()
            self.sent.append(now)


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
    def __init__(self, gateway, cache, pacer, clock=time.time, sleep=time.sleep, log=None, depth_pacer=None,
                 option_quotes=False, tape_stream=None):
        self.gateway, self.cache, self.pacer = gateway, cache, pacer
        self.depth_pacer = depth_pacer or DepthPacer(clock)
        self.clock, self.sleep = clock, sleep
        self.log = log or (lambda event, **kw: None)
        # main() passes the stream it starts; without one the service holds a stream that never runs (tests).
        self.tape_stream = tape_stream or TapeStream(gateway, clock=clock, log=self.log)
        self.lock = threading.Lock()  # historical requests (bars, ticks): one at a time
        self.depth_lock = threading.Lock()  # at most one market depth subscription at a time
        self.news_lock = threading.Lock()  # one news request at a time
        self.news_last = None
        # /option-chain switch (VERTEX_HISTORY_OPTION_QUOTES=1, read once at start-up). Off by default: market data
        # snapshots use the market data lines of the IB gateway that the live engine shares, so the owner turns it on.
        # The expiry rule needs the America/New_York zone: it is resolved here, once, and without it the switch is
        # forced off, so no request can fail on missing tz data.
        self.option_quotes = bool(option_quotes)
        if self.option_quotes and option_zone() is None:
            self.option_quotes = False
            self.log("option_quotes_forced_off", reason="tz_data_missing", zone=OPTION_CLOSE_ZONE)
        self.option_lock = threading.Lock()  # one option chain fetch at a time
        self.option_last = None
        # Service clock of the last wave that showed the account has no option market data (see
        # OPTION_NOT_SUBSCRIBED_SECONDS). Per process, written only under option_lock.
        self.option_unsubscribed = None

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
        status = {"no_contract": 422, "unavailable": 503, "timeout": 504, "no_option_chain": 404,
                  "expiry_not_listed": 404}.get(e.kind, 502)
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
            now = self.clock()
            req = validate(raw, now=now)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(dict(req, schema=SCHEMA)), ttl_for(req, now=now)

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
            except DecodeError as e:
                self.log("ib_decode_error", symbol=req["symbol"], secType=req["secType"], cause=str(e))
                return 502, {"error": "decode_error", "message": "IBKR sent a bar that cannot be read"}
            unit = volume_unit(req["secType"], req["currency"])
            if unit not in ("shares", "contracts"):
                bars = [dict(b, v=None) for b in bars]
            fetched = self.clock()
            payload = {"schema": SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "volume_unit": unit, "contract": contract, "bars": bars, "count": len(bars), "fetched_at": now_iso(fetched),
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
        now, stream = self.clock(), self.tape_stream
        reason = stream.reason()
        tape = {"off": stream.off, "halted": stream.halted,
                "feeds": {symbol: feed.status(now, reason) for symbol, feed in stream.feeds.items()}}
        return 200, {"schema": "vertex-history-health-v1", "version": VERSION, "client_id": CLIENT_ID,
                     "connected": self.gateway.connected(), "pacing": self.pacer.snapshot(),
                     "optionQuotes": self.option_quotes, "tape": tape, "ibapi": ibapi_version(),
                     "startedAt": now_iso(STARTED_AT), "unsetSizes": UNSET_SIZES.value,
                     "warnings": ["unset_sizes"] if UNSET_SIZES.value > 0 else []}

    def tape(self, raw):
        """Streamed tape of one symbol from `since`: no IBKR request, no cache."""
        try:
            req = validate_tape(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        stream, now = self.tape_stream, self.clock()
        feed, reason = stream.feeds[req["symbol"]], stream.reason()
        payload = {"schema": TAPE_SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "symbol": req["symbol"],
                   "contract": feed.info, "minTick": feed.min_tick}
        payload.update(feed.read(req["since"], now))
        payload.update(stream={"state": feed.state(now, reason), "error": reason or feed.cause()},
                       fetchedAt=now_iso(now))
        return 200, payload

    def news(self, raw):
        """Newest IBKR news headlines for one stock (camelCase fields, like ticks and depth)."""
        try:
            req = validate_news(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(dict(req, endpoint="news")), NEWS_TTL

        def fallback(status, body):
            return self._stale_or(key, ttl, status, body, NEWS_STALE_MAX, camel=True)

        hit = self.cache.get(key, ttl)
        if hit:
            return self._ok(hit[0], hit[1], ttl, True, camel=True)
        budget_end = self.clock() + NEWS_DEADLINE

        def remaining():
            return budget_end - self.clock()

        if not self.news_lock.acquire(timeout=max(0.0, min(MAX_WAIT, remaining()))):
            return fallback(429, {"error": "busy", "retry_after_seconds": int(NEWS_MIN_INTERVAL)})
        try:
            hit = self.cache.get(key, ttl)
            if hit:
                return self._ok(hit[0], hit[1], ttl, True, camel=True)
            if self.news_last is not None:
                wait = self.news_last + NEWS_MIN_INTERVAL - self.clock()
                if wait > 0:
                    self.sleep(wait)
            self.news_last = self.clock()
            try:
                contract, providers, items = self.gateway.fetch_news(req, remaining)
            except IbError as e:
                return self._ib_error(e, fallback)
            except PacingViolation:  # news has no historical back-off; just ask the caller to retry
                self.log("news_pacing_violation")
                return fallback(429, {"error": "pacing_violation", "retry_after_seconds": int(NEWS_MIN_INTERVAL)})
            except Exception as e:  # never drop the connection without a JSON answer
                self.log("news_failed", kind=type(e).__name__)
                return fallback(500, {"error": "internal", "message": "news request failed"})
            payload = {"schema": NEWS_SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "contract": contract, "providers": providers, "items": items, "count": len(items),
                       "fetchedAt": now_iso(self.clock())}
            self.cache.put(key, payload)
            self.log("news", symbol=req["symbol"], providers=len(providers), items=len(items))
            return self._ok(payload, 0, ttl, False, camel=True)
        finally:
            self.news_lock.release()

    def _option_unsubscribed(self):
        """The answer while the not_subscribed memo is fresh (no IB call), else None."""
        since = self.option_unsubscribed
        rest = 0 if since is None else since + OPTION_NOT_SUBSCRIBED_SECONDS - self.clock()
        if not 0 < rest <= OPTION_NOT_SUBSCRIBED_SECONDS:  # over, or the clock went back
            return None
        return 502, {"error": "not_subscribed", "retry_after_seconds": int(math.ceil(rest)),
                     "message": "IB reported no market data subscription for option quotes; the service asks IB "
                                "again after retry_after_seconds"}

    def option_chain(self, raw):
        """Top-of-book snapshot quotes of the calls and puts nearest the money for one stock option expiry
        (camelCase fields, like news). Refused, before anything else and without any IB call, while the switch
        is off. A fresh cached answer is served first; after that the request is refused, without any IB call,
        while the not_subscribed memo is fresh."""
        if not self.option_quotes:
            return 403, {"error": "disabled",
                         "message": "option quotes are off; the owner enables them with %s=1" % OPTION_QUOTES_ENV}
        try:
            req = validate_option_chain(raw)
        except BadRequest as e:
            return 400, {"error": "bad_request", "message": str(e)}
        key, ttl = cache_key(dict(req, endpoint="option-chain")), OPTION_TTL

        def fallback(status, body):
            return self._stale_or(key, ttl, status, body, OPTION_STALE_MAX, camel=True)

        hit = self.cache.get(key, ttl)
        if hit:
            return self._ok(hit[0], hit[1], ttl, True, camel=True)
        refused = self._option_unsubscribed()
        if refused:
            return refused
        budget_end = self.clock() + OPTION_DEADLINE

        def remaining():
            return budget_end - self.clock()

        if not self.option_lock.acquire(timeout=max(0.0, min(OPTION_MAX_WAIT, remaining()))):
            return fallback(429, {"error": "busy", "retry_after_seconds": int(OPTION_MIN_INTERVAL)})
        try:
            hit = self.cache.get(key, ttl)
            if hit:
                return self._ok(hit[0], hit[1], ttl, True, camel=True)
            refused = self._option_unsubscribed()  # the request this one waited for may have set the memo
            if refused:
                return refused
            if self.option_last is not None:
                wait = min(OPTION_MIN_INTERVAL, self.option_last + OPTION_MIN_INTERVAL - self.clock())
                if wait > 0 and remaining() - wait < OPTION_MIN_WINDOW:  # the spacing does not fit in the budget
                    return fallback(429, {"error": "busy", "retry_after_seconds": max(1, int(math.ceil(wait)))})
                if wait > 0:
                    self.sleep(wait)
            self.option_last = self.clock()
            try:
                chain = self.gateway.fetch_option_chain(req, remaining)
            except IbError as e:
                return self._ib_error(e, fallback)
            except PacingViolation:  # snapshots have no historical back-off; just ask the caller to retry
                self.log("option_chain_pacing_violation")
                return fallback(429, {"error": "pacing_violation", "retry_after_seconds": int(OPTION_MIN_INTERVAL)})
            except Exception as e:  # never drop the connection without a JSON answer
                self.log("option_chain_failed", kind=type(e).__name__)
                return fallback(500, {"error": "internal", "message": "option chain request failed"})
            quotes = chain["quotes"]
            errors = sorted(set(quote["error"] for quote in quotes if quote["error"]))
            quoted = sum(1 for quote in quotes if quote["error"] is None)
            if errors == ["not_subscribed"] and quoted == 0:  # every option row; this answer is not cached
                self.option_unsubscribed = self.clock()
                self.log("option_chain_not_subscribed", symbol=req["symbol"], expiry=chain["expiry"],
                         quotes=len(quotes), errors=scrub(",".join(errors)),
                         retry_after_seconds=OPTION_NOT_SUBSCRIBED_SECONDS)
                return self._option_unsubscribed()
            payload = {"schema": OPTION_CHAIN_SCHEMA, "source": SOURCE, "client_id": CLIENT_ID, "request": req,
                       "expirations": chain["expirations"], "expiry": chain["expiry"],
                       "tradingClass": chain["tradingClass"], "multiplier": chain["multiplier"],
                       "underlying": chain["underlying"], "quotes": quotes, "count": len(quotes),
                       "fetchedAt": now_iso(self.clock())}
            self.cache.put(key, payload)
            self.log("option_chain", symbol=req["symbol"], expiry=chain["expiry"], quotes=len(quotes),
                     quoted=quoted, errors=scrub(",".join(errors)) or None)
            return self._ok(payload, 0, ttl, False, camel=True)
        finally:
            self.option_lock.release()


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
            level = {"price": _finite(price), "size": ib_size(size), "venue": _text(venue, 16)}
        except (TypeError, ValueError, ArithmeticError):
            return
        if level["size"] is None and operation != 2:  # a delete needs no size
            count_unset("depth")
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


class QuoteSnapshot(_Holder):
    """Prices of one reqMktData snapshot request. done = tickSnapshotEnd, a terminal error, or complete(prices):
    the request has what its caller needs, so the wave does not wait for tickSnapshotEnd (IB can hold it for about
    11 s). While the holder is registered every callback changes it under IbGateway.holders_lock; after _snapshots
    has popped it nothing changes it."""

    def __init__(self, complete=option_quote_complete):
        _Holder.__init__(self)
        self.complete = complete  # prices -> bool
        self.prices = {"bid": None, "ask": None, "last": None, "close": None}
        self.data_type = None  # live | frozen | delayed | delayed-frozen, as IB reported it for this request
        self.delayed = False  # a price came from a delayed tick type (66, 67, 68, 75)
        self.timed_out = False  # no tickSnapshotEnd, no terminal error and not complete when the wave ended
        self.ended = False  # tickSnapshotEnd arrived: IB closed the market data line, nothing to cancel
        self.refused = False  # IB answered this request id with a terminal error: closed at IB, nothing to cancel
        self.warning = None  # an OPTION_WARNING_CODES message; prices may still follow

    def tick(self, tick_type, price):
        """tickPrice: bid, ask, last or close (live or delayed). The latest valid tick of a field wins. A value
        that is not a plausible price (negative, non-finite, a sentinel) is ignored: it never replaces a price, so
        a request that is done stays done."""
        try:
            kind = int(tick_type)
        except (TypeError, ValueError):
            return
        name, number = PRICE_TICKS.get(kind), option_price(price)
        if name is None or number is None:
            return
        self.prices[name] = number
        self.delayed = self.delayed or kind in DELAYED_PRICE_TICKS
        if self.complete(self.prices):  # same lock as the price: the waiter of the wave cannot miss it
            self.done.set()

    def reported_type(self):
        """dataType of the request: what marketDataType said. Without it, "delayed" when a price came from a
        delayed tick type, else None: live tick types alone are not reported as live."""
        return self.data_type if self.data_type is not None else "delayed" if self.delayed else None

    def market_data_type(self, value):
        try:
            self.data_type = MARKET_DATA_TYPES.get(int(value), self.data_type)
        except (TypeError, ValueError):
            return


def _positive(value):
    """The finite number above 0, or None."""
    try:
        number = _finite(value)
    except (AttributeError, TypeError, ValueError):
        return None
    return number if number > 0 else None


class TapeFeed(_Holder):
    """Streamed tape of one symbol: a ring of the newest prints and the covered spans.

    A print is (exchange second, price, size, bid, ask); bid and ask are the newest values of the quote stream
    when the print arrived (None before the first quote message). The ring is sorted by second: read() needs that.
    A span is [first covered second, end]: the end is the receive time of its newest print, but at most
    TAPE_SETTLE_SECONDS after the second before that print's second, so read() never reports the second of the
    newest print (it can still miss prints) or a later one as covered. A span opens with the first print after
    the trade stream was requested, and only prints extend it. It ends when the subscription ends, when two
    prints are more than TAPE_IDLE_SECONDS apart, at a late print, at an out-of-order print and at break_span().
    `lock` guards every field below except retry_at and delay (only the TapeStream thread uses them); `done` and
    `error` belong to _Holder and are set by the gateway.
    """

    def __init__(self, symbol):
        _Holder.__init__(self)
        self.symbol = symbol
        self.lock = threading.Lock()
        self.prints = deque(maxlen=TAPE_RING)
        self.spans = deque(maxlen=TAPE_SPANS)
        self.open_span = False
        self.bid = self.ask = None
        self.last_tick = self.last_print = None
        self.count = self.quotes = self.no_quote = self.invalid = self.unreported = self.late = self.subscribes = 0
        self.disordered = 0
        self.lag = None
        self.info = self.min_tick = None
        self.quote_id = self.trade_id = None
        self.attached_at = self.trades_at = None
        self.trades_due = 0.0
        self.retry_at, self.delay = 0.0, TAPE_RETRY_SECONDS  # no new subscription before retry_at; the next wait

    def attach(self, info, min_tick, quote_id, now):
        """A new subscription starts with the quote stream; the trade stream follows at trades_due."""
        with self.lock:
            self.done.clear()
            self.error = None
            self.info, self.min_tick = info, min_tick
            self.quote_id, self.trade_id = quote_id, None
            self.attached_at, self.trades_at = now, None
            self.trades_due = now + TAPE_TRADES_DELAY_SECONDS
            self.bid = self.ask = None
            self.open_span = False
            self.subscribes += 1

    def trades_on(self, trade_id, now):
        with self.lock:
            self.trade_id, self.trades_at = trade_id, now
            self.open_span = False

    def detach(self):
        """Ends the subscription state; returns the request ids that were set."""
        with self.lock:
            ids = [rid for rid in (self.quote_id, self.trade_id) if rid is not None]
            self.quote_id = self.trade_id = None
            self.open_span = False
            return ids

    def break_span(self):
        with self.lock:
            self.open_span = False

    def attached(self):
        return self.quote_id is not None

    def printed(self):
        """Did a print arrive since the present trade stream was requested? Only that proves that the
        subscription works: IBKR can serve the quote stream and refuse the trade stream."""
        with self.lock:
            return self.trade_id is not None and self.last_print is not None and self.last_print >= self.trades_at

    def quote(self, now, bid, ask):
        """A value that is not a finite number above 0 keeps the stored value of that side."""
        bid, ask = _positive(bid), _positive(ask)
        with self.lock:
            if bid is not None:
                self.bid = bid
            if ask is not None:
                self.ask = ask
            self.quotes += 1
            self.last_tick = now

    def trade(self, now, t, price, size, unreported=False):
        try:
            if ib_size(size) is None:
                count_unset("tape")
                return
        except (TypeError, ValueError, ArithmeticError):
            pass  # not a number: counted as invalid below
        price, size, second = _positive(price), _positive(size), _positive(t)
        with self.lock:
            if price is None or size is None or second is None:
                self.invalid += 1
                return
            t = int(second)
            if self.bid is None or self.ask is None:
                self.no_quote += 1
            row = (t, price, int(size) if size == int(size) else size, self.bid, self.ask)
            disordered = bool(self.prints) and t < self.prints[-1][0]
            if disordered:
                self._insert(row)
            else:
                self.prints.append(row)
            self.count += 1
            if unreported:
                self.unreported += 1
            self.lag = now - t
            # Prints come in exchange order: this print proves that every second before t is complete, and second
            # t can still miss prints. So no span end passes `settled`, the time at which read() serves t - 1.
            settled = t - 1 + TAPE_SETTLE_SECONDS
            if self.last_print is not None and now - self.last_print > TAPE_IDLE_SECONDS:
                self.open_span = False
            if self.lag > TAPE_LAG_SECONDS:
                self.late += 1
            if disordered:
                # Earlier answers for second t missed this print, and the order rule failed: nothing from t on
                # stays covered, in the open span and in every older span that reaches t.
                self.disordered += 1
                for span in self.spans:
                    span[1] = min(span[1], settled)
                self.open_span = False
            elif self.lag > TAPE_LAG_SECONDS:
                # The reader is behind: seconds from this print on can still miss queued prints.
                if self.open_span:
                    self.spans[-1][1] = min(self.spans[-1][1], settled)
                self.open_span = False
            elif self.open_span:
                self.spans[-1][1] = max(self.spans[-1][1], min(now, settled))  # the end never moves back
            elif self.trade_id is not None:
                # The first covered second is t + 1 and the end is before it: read() gives no interval for this
                # span until a print of a later second extends it.
                self.spans.append([t + 1, min(now, settled)])
                self.open_span = True
            self.last_print = self.last_tick = now

    def _insert(self, row):
        """Stores an out-of-order print after the last row whose second is not later (arrival order stays inside
        a second), so the ring stays sorted by second. The caller holds the lock."""
        later = 0
        for kept in reversed(self.prints):
            if kept[0] <= row[0]:
                break
            later += 1
        at = len(self.prints) - later
        if len(self.prints) == self.prints.maxlen:
            if at == 0:
                return  # older than every kept print: a full ring drops its oldest print, and that is this one
            self.prints.popleft()  # a full bounded deque refuses insert()
            at -= 1
        self.prints.insert(at, row)

    def read(self, since, now):
        """Whole exchange seconds from `since` to TAPE_SETTLE_SECONDS before now, oldest first, at most TAPE_MAX
        prints (a single second is never split). `until` is the last second of the answer; `more` says that
        settled prints after it remain. `covered` holds inclusive [from, to] seconds inside [since, until]; a
        span is covered up to TAPE_SETTLE_SECONDS before its end, which is never later than the second before
        its newest print's second (see trade()). Seconds after that can be in the answer, but they are not
        covered: their prints can still be in transit. `previousPrice` is the price of the newest print before
        `since`; `previousDifferentPrice` is the price of the newest print before `since` that differs from it
        (the seed of the reader's zero-tick rule), None when there is no previousPrice or when the newest
        TAPE_SEED_SCAN prints before `since` hold no other price."""
        end = int(now) - TAPE_SETTLE_SECONDS
        with self.lock:
            start = since
            if self.count > TAPE_RING and self.prints[0][0] + 1 > start:
                start = self.prints[0][0] + 1  # a full ring dropped older prints: its oldest second can be partial
            rows, previous, different, scanned = [], None, None, 0
            for row in reversed(self.prints):  # sorted by second: after the first row before `start`, all are
                if row[0] >= start:
                    if row[0] <= end:
                        rows.append(row)
                    continue
                if scanned == 0:
                    previous = row[1]
                elif row[1] != previous:
                    different = row[1]
                    break
                scanned += 1
                if scanned >= TAPE_SEED_SCAN:
                    break
            spans = [(first, last) for first, last in self.spans]
        if start > end:
            return {"since": start, "until": start - 1, "more": False, "trades": [], "covered": [],
                    "previousPrice": previous, "previousDifferentPrice": different}
        rows.reverse()
        until, more = end, False
        if len(rows) > TAPE_MAX:
            cut = TAPE_MAX
            while cut > 0 and rows[cut][0] == rows[cut - 1][0]:
                cut -= 1
            if cut == 0:  # the first second alone holds more than TAPE_MAX prints: that second stays whole
                cut = next((i for i, row in enumerate(rows) if row[0] != rows[0][0]), len(rows))
            if cut < len(rows):
                until, more, rows = rows[cut - 1][0], True, rows[:cut]
        covered = []
        for first, last in spans:
            # `last` is at most TAPE_SETTLE_SECONDS after the second before the span's newest print's second.
            low, high = max(first, start), min(int(last) - TAPE_SETTLE_SECONDS, until)
            if low <= high:
                covered.append([low, high])
        return {"since": start, "until": until, "more": more, "trades": [list(row) for row in rows],
                "covered": covered, "previousPrice": previous, "previousDifferentPrice": different}

    def state(self, now, halted=None):
        """off: the stream is switched off or halted. live: the trade stream is requested and a tick arrived in
        the last TAPE_IDLE_SECONDS. Else down."""
        if halted is not None:
            return "off"
        with self.lock:
            live = (self.trade_id is not None and not self.done.is_set() and self.last_tick is not None
                    and now - self.last_tick <= TAPE_IDLE_SECONDS)
        return "live" if live else "down"

    def cause(self):
        return scrub(self.error) if self.error is not None else None

    def status(self, now, halted=None):
        state = self.state(now, halted)
        with self.lock:
            return {"state": state, "contract": (self.info or {}).get("localSymbol"),
                    "coveredSince": now_iso(self.spans[-1][0]) if self.open_span else None,
                    "lastTickAt": now_iso(self.last_tick) if self.last_tick is not None else None,
                    "lastPrintAt": now_iso(self.last_print) if self.last_print is not None else None,
                    "prints": self.count, "quotes": self.quotes, "noQuote": self.no_quote,
                    "invalid": self.invalid, "unreported": self.unreported, "late": self.late,
                    "disordered": self.disordered, "dropped": max(0, self.count - TAPE_RING),
                    "subscribes": self.subscribes,
                    "lagSeconds": round(self.lag, 3) if self.lag is not None else None, "error": self.cause()}


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

        def newsProviders(self, newsProviders):
            self.owner.add_providers(newsProviders)

        def historicalNews(self, requestId, time, providerCode, articleId, headline):
            self.owner.add_row(requestId, (time, providerCode, articleId, headline))

        def historicalNewsEnd(self, requestId, hasMore):
            self.owner.finish(requestId)

        def securityDefinitionOptionParameter(self, reqId, exchange, underlyingConId, tradingClass, multiplier,
                                              expirations, strikes):
            self.owner.add_row(reqId, (exchange, tradingClass, multiplier, expirations, strikes))

        def securityDefinitionOptionParameterEnd(self, reqId):
            self.owner.finish(reqId)

        def tickPrice(self, reqId, tickType, price, attrib):
            self.owner.tick_price(reqId, tickType, price)

        def tickSnapshotEnd(self, reqId):
            self.owner.snapshot_end(reqId)

        def marketDataType(self, reqId, marketDataType):
            self.owner.market_data_type(reqId, marketDataType)

        def tickByTickAllLast(self, reqId, tickType, time, price, size, tickAttribLast, exchange, specialConditions):
            self.owner.tape_trade(reqId, time, price, size, bool(getattr(tickAttribLast, "unreported", False)))

        def tickByTickBidAsk(self, reqId, time, bidPrice, askPrice, bidSize, askSize, tickAttribBidAsk):
            self.owner.tape_quote(reqId, bidPrice, askPrice)

    return Wrapper


INFO_CODES = {2103, 2104, 2105, 2106, 2107, 2108, 2119, 2157, 2158, 2174, 2176}
ENTITLEMENT_CODES = {354, 10089, 10090, 10092, 10167, 10168, 10186, 10197, 10276}  # 10276: news feed not allowed
DEPTH_NOTICE_CODE = 2152  # venues with depth, top of book only, and missing permissions
DEPTH_RESET_CODE = 317  # "market depth data has been RESET": empty the book before new entries


class IbGateway:
    """The only code that talks to IB. Calls on self._client are limited to IB_CALLS (enforced by tests)."""

    IB_CALLS = ("connect", "disconnect", "isConnected", "run", "reqContractDetails", "reqHistoricalData",
                "cancelHistoricalData", "reqHistoricalTicks", "reqMktDepth", "cancelMktDepth", "reqNewsProviders",
                "reqHistoricalNews", "reqSecDefOptParams", "reqMktData", "cancelMktData", "reqTickByTickData",
                "cancelTickByTickData")

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
        self.providers = None  # (fetched at, [{code, name}])
        self.providers_rid = None
        self.option_defs = {}  # (symbol, conId) -> (fetched at, option chain definition)
        self.snapshot_wait = OPTION_SNAPSHOT_SECONDS
        self.underlying_wait = OPTION_UNDERLYING_SECONDS
        self.option_limiter = MessageLimiter(OPTION_MESSAGES_PER_SECOND)  # reqMktData and cancelMktData sends

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

    def tape_trade(self, req_id, t, price, size, unreported):
        h = self.holders.get(req_id)
        if isinstance(h, TapeFeed):
            h.trade(self.clock(), t, price, size, unreported)

    def tape_quote(self, req_id, bid, ask):
        h = self.holders.get(req_id)
        if isinstance(h, TapeFeed):
            h.quote(self.clock(), bid, ask)

    def _tape_feeds(self):
        with self.holders_lock:
            return list({id(h): h for h in self.holders.values() if isinstance(h, TapeFeed)}.values())

    def _tape_notice(self, code, message):
        """A broken market data farm ends the covered spans; "connectivity returned, data lost" ends the tape
        subscriptions, because IBKR wants market data requests sent again after it."""
        if code in TAPE_BREAK_CODES:
            for feed in self._tape_feeds():
                feed.break_span()
        elif code == TAPE_LOST_CODE:
            for feed in self._tape_feeds():
                self._fail(feed, IbError("unavailable", str(message), code))

    @staticmethod
    def _fail(holder, err):
        """Marks a holder failed. A tape feed ends its covered span at once: the stream thread drops the feed up
        to seconds later, and a print handled before that must not extend the span across the gap."""
        holder.error = err
        if isinstance(holder, TapeFeed):
            holder.break_span()
        holder.done.set()

    def _snapshot_update(self, req_id, update):
        """Applies update(holder) to the registered QuoteSnapshot of req_id under holders_lock; False when there is
        none. _snapshots pops its holders under the same lock, so a callback that comes later (a late tick, the
        answer to a cancel) changes nothing."""
        with self.holders_lock:
            h = self.holders.get(req_id)
            if not isinstance(h, QuoteSnapshot):
                return False
            update(h)
            return True

    def tick_price(self, req_id, tick_type, price):
        self._snapshot_update(req_id, lambda h: h.tick(tick_type, price))

    def market_data_type(self, req_id, value):
        self._snapshot_update(req_id, lambda h: h.market_data_type(value))

    def snapshot_end(self, req_id):
        """tickSnapshotEnd: IB has closed the market data line of this snapshot."""
        def end(h):
            h.ended = True
            h.done.set()

        self._snapshot_update(req_id, end)

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
                self._fail(h, err)

    def on_error(self, req_id, code, message):
        code = int(code)
        self._tape_notice(code, message)
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
        def record(h):
            if code in OPTION_WARNING_CODES:  # a warning: the snapshot stays open and may still fill
                h.warning = IbError("entitlement", text, code)
            else:
                h.error, h.refused = err, True
                h.done.set()

        if self._snapshot_update(req_id, record):
            return
        h = self.holders.get(req_id)
        if h is not None:
            self._fail(h, err)
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
            end = req.get("endDateTime") or ""  # "" = IBKR's "now"
            self.log("ib_historical", req_id=rid, symbol=req["symbol"], secType=req["secType"],
                     barSize=req["barSize"], duration=req["duration"], whatToShow=req["whatToShow"],
                     endDateTime=end or None)
            self._client.reqHistoricalData(rid, spec, end, req["duration"], req["barSize"], req["whatToShow"],
                                           1 if req["useRTH"] else 0, 2, False, [])

        try:
            rows, _ = self._call(start)
        except IbError as e:
            if e.kind == "timeout" and sent:
                self._cancel(sent[0])
            raise
        bars = to_bars(rows)
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

    def _tape_id(self, feed):
        with self.holders_lock:
            self.next_id += 1
            self.holders[self.next_id] = feed
            return self.next_id

    def subscribe_tape(self, req, feed):
        """The only tick-by-tick requests of the service. First call for a feed: its quote stream (price changes
        only). Second call, TAPE_TRADES_DELAY_SECONDS later: its trade stream. The arguments after the contract
        are the tick type, the number of earlier ticks (0: none) and "price changes only"."""
        self._connect()
        if not feed.attached():
            info, _, min_tick = self._contract(req)
            spec = self._resolved_spec(req, info)
            rid = self._tape_id(feed)
            feed.attach(info, min_tick, rid, self.clock())
            self._client.reqTickByTickData(rid, spec, "BidAsk", 0, True)
        else:
            spec = self._resolved_spec(req, feed.info)
            rid = self._tape_id(feed)
            feed.trades_on(rid, self.clock())
            self._client.reqTickByTickData(rid, spec, "AllLast", 0, False)

    def unsubscribe_tape(self, feed):
        """The only tick-by-tick cancel of the service: every stream of the feed."""
        for rid in feed.detach():
            with self.holders_lock:
                self.holders.pop(rid, None)
            try:
                self._client.cancelTickByTickData(rid)
            except Exception as e:
                self.log("ib_cancel_tape_failed", req_id=rid, kind=type(e).__name__)

    def add_providers(self, providers):
        """newsProviders has no request id: it answers the one pending provider request."""
        rid = self.providers_rid
        for p in providers or []:
            self.add_row(rid, {"code": _text(getattr(p, "code", ""), 16), "name": _text(getattr(p, "name", ""), 80)})
        self.finish(rid)

    def news_providers(self, remaining=None):
        """[{code, name}] of the account's API news providers, cached for PROVIDERS_TTL."""
        if self.providers is not None and self.clock() - self.providers[0] < PROVIDERS_TTL:
            return self.providers[1]

        def start(rid):
            self.providers_rid = rid
            self._client.reqNewsProviders()

        rows, _ = self._call(start, remaining)
        providers = [p for p in rows if p["code"]]
        # an empty answer (no providers yet, or a reconnect) is cached only briefly
        ttl_offset = 0 if providers else PROVIDERS_TTL - PROVIDERS_EMPTY_TTL
        self.providers = (self.clock() - ttl_offset, providers)
        return providers

    def fetch_news(self, req, remaining=None):
        """(contract info, providers, headlines newest first) for one stock; no providers -> no request."""
        self._connect()
        info = self._details(req, remaining)
        providers = self.news_providers(remaining)
        if not providers:
            return info, [], []
        codes = "+".join(p["code"] for p in providers)
        rows, _ = self._call(lambda rid: self._client.reqHistoricalNews(rid, info["conId"], codes, "", "",
                                                                        req["count"], []), remaining)
        items = [i for i in (to_news_item(*row) for row in rows) if i is not None]
        items.sort(key=lambda i: i["t"], reverse=True)
        return info, providers, items[:req["count"]]

    def _option_definition(self, req, info, remaining=None):
        """{tradingClass, multiplier, expirations, strikes} of the SMART option chain, cached for CONTRACT_TTL."""
        dkey = (req["symbol"], info["conId"])
        cached = self.option_defs.get(dkey)
        if cached and self.clock() - cached[0] < CONTRACT_TTL:
            return cached[1]
        rows, _ = self._call(lambda rid: self._client.reqSecDefOptParams(rid, req["symbol"], "", "STK",
                                                                         info["conId"]), remaining)
        smart = [row for row in rows if row[0] == "SMART"]
        if not smart:
            raise IbError("no_option_chain", "no SMART option chain for this symbol")
        classes = (req["symbol"], req["symbol"].replace(" ", ""))
        row = next((row for row in smart if row[1] in classes), None)
        if row is None:  # another class may be an adjusted chain (after a split or merger): never guess
            raise IbError("no_option_chain", "no SMART option chain with the trading class of this symbol")
        expirations = []
        for expiry in sorted(set(str(e) for e in row[3] or [])):
            try:
                if EXPIRY_RE.fullmatch(expiry) and expiry_close_ts(expiry):
                    expirations.append(expiry)
            except ValueError:
                continue
        strikes = set()
        for strike in row[4] or []:
            try:
                if 0 < _finite(strike) < OPTION_PRICE_MAX:
                    strikes.add(_finite(strike))
            except (TypeError, ValueError):
                continue
        definition = {"tradingClass": _text(row[1], 16), "multiplier": _text(row[2], 8), "expirations": expirations,
                      "strikes": sorted(strikes)}
        self.option_defs[dkey] = (self.clock(), definition)
        return definition

    def _option_spec(self, inst, definition, expiry, strike, right):
        spec = self._spec(dict(inst, secType="OPT", exchange="SMART", contractMonth=expiry))
        spec.lastTradeDateOrContractMonth = expiry
        spec.strike, spec.right = strike, right
        spec.multiplier, spec.tradingClass = definition["multiplier"] or "", definition["tradingClass"] or ""
        return spec

    def _snapshots(self, specs, remaining=None, complete=option_quote_complete, window=None):
        """One wave of one-shot market data snapshots, one QuoteSnapshot per spec in the same order. Waits until
        every request is done: tickSnapshotEnd, a terminal error, or complete(prices). The wait is at most
        window (default snapshot_wait) and never goes past the caller's budget; with less than OPTION_MIN_WINDOW of budget left
        nothing is sent. Every send goes through option_limiter. Then the holders are popped; a request that is not done at that moment is marked
        timed_out. cancelMktData goes only to the sent requests that are still open at IB: no tickSnapshotEnd
        and no error that IB addressed to that request id. So a request that completed on its prices is
        cancelled at once; a warning code does not close a request, and neither does a gateway loss reported for
        all requests. Always snapshot=True, regulatorySnapshot=False (a regulatory snapshot costs money) and no
        generic ticks."""
        if not 0 < len(specs) < OPTION_SNAPSHOT_MAX:
            raise IbError("ibkr_error", "snapshot wave outside the request cap")
        if remaining is not None and remaining() < OPTION_MIN_WINDOW:
            raise IbError("timeout", "too little of the request budget is left for a market data snapshot")
        pending = []
        with self.holders_lock:
            for spec in specs:
                self.next_id += 1
                holder = self.holders[self.next_id] = QuoteSnapshot(complete)
                pending.append((self.next_id, spec, holder))
        sent = []
        try:
            for req_id, spec, _holder in pending:
                self.option_limiter.wait()
                sent.append(req_id)
                self._client.reqMktData(req_id, spec, "", True, False, [])
            # sized after the sends: a wait of the limiter has used up some of the budget
            wait = self.snapshot_wait if window is None else window
            wait = wait if remaining is None else min(wait, remaining())
            end = time.monotonic() + max(0.0, wait)
            for _req_id, _spec, holder in pending:
                holder.done.wait(max(0.0, end - time.monotonic()))
        finally:
            still_open = []
            with self.holders_lock:  # one consistent read: from here on no callback can change these holders
                for req_id, _spec, holder in pending:
                    self.holders.pop(req_id, None)
                    holder.timed_out = not (holder.ended or holder.error is not None or complete(holder.prices))
                    if req_id in sent and not holder.ended and not holder.refused:
                        still_open.append(req_id)
            for req_id in still_open:  # after the pop: an answer of IB to a cancel (code 300) finds no holder
                self._cancel_snapshot(req_id)
        return [holder for _req_id, _spec, holder in pending]

    def _cancel_snapshot(self, req_id):
        try:  # a failure of the limiter must never skip the cancel
            self.option_limiter.wait()
        except Exception as e:
            self.log("ib_option_limiter_failed", req_id=req_id, kind=type(e).__name__)
        try:
            self._client.cancelMktData(req_id)
        except Exception as e:
            self.log("ib_cancel_snapshot_failed", req_id=req_id, kind=type(e).__name__)

    def fetch_option_chain(self, req, remaining=None):
        """The chain of one stock: the option chain definition, one snapshot of the underlying, then one snapshot
        per call and put of the req["strikes"] listed strikes nearest the underlying price. At most
        OPTION_SNAPSHOT_MAX snapshot requests; a failed option contract is reported in its row, not raised."""
        if req["expiry"] is not None and expiry_close_ts(req["expiry"]) <= self.clock():  # before any IB call
            raise IbError("expiry_not_listed", "expiry %s has passed its 16:00 New York close" % req["expiry"])
        self._connect()
        inst = dict(OPTION_UNDERLYING, symbol=req["symbol"])
        try:
            info = self._details(inst, remaining)
        except IbError as e:
            if e.kind == "no_contract":  # unknown symbol: 404 on this endpoint
                raise IbError("no_option_chain", "no stock contract found for this symbol", e.code) from None
            raise
        definition = self._option_definition(inst, info, remaining)
        expiry = pick_expiry(definition["expirations"], req["expiry"], self.clock())
        if expiry is None:
            raise IbError("expiry_not_listed", "expiry %s is not listed for this symbol" % req["expiry"]
                          if req["expiry"] else "no listed expiry is still open")
        under = self._snapshots([self._resolved_spec(inst, info)], remaining, underlying_complete,
                                self.underlying_wait)[0]
        price = underlying_price(under.prices)
        error = under.error
        if error is not None and (price is None or not isinstance(error, IbError) or error.kind == "unavailable"):
            raise error
        if price is None:
            if under.warning is not None:
                raise under.warning
            if under.timed_out:
                raise IbError("timeout", "the underlying snapshot did not answer in time")
            raise IbError("ibkr_error", "no usable underlying price in the snapshot")
        strikes = nearest_strikes(definition["strikes"], price, min(req["strikes"], OPTION_STRIKES_MAX))
        if not strikes:
            raise IbError("no_option_chain", "the option chain lists no strikes")
        legs = [(strike, right) for strike in strikes for right in ("C", "P")]
        self.log("ib_option_chain", symbol=req["symbol"], expiry=expiry, strikes=len(strikes), snapshots=len(legs) + 1)
        holders = self._snapshots([self._option_spec(inst, definition, expiry, strike, right)
                                   for strike, right in legs], remaining)
        quotes = []
        for (strike, right), holder in zip(legs, holders):
            error = holder.error
            if isinstance(error, IbError) and error.kind == "unavailable":
                raise error  # the gateway went away: not a per-contract problem
            quotes.append(option_quote_row(strike, right, holder))
        return {"expirations": definition["expirations"], "expiry": expiry,
                "tradingClass": definition["tradingClass"], "multiplier": definition["multiplier"],
                "underlying": dict(under.prices, price=price, dataType=under.reported_type()), "quotes": quotes}

    def close(self):
        if self._client is not None:
            self._client.disconnect()


class TapeStream:
    """Keeps the tape feeds subscribed. step() is one pass; start() runs it every second in a daemon thread.
    Each feed has its own wait (retry_at, delay): a feed that IBKR refuses backs off also beside a live feed.
    While the gateway is not reachable, the feeds wait together: one connect attempt per wait."""

    def __init__(self, gateway, off_file=None, clock=time.time, log=None):
        self.gateway, self.off_file, self.clock = gateway, off_file, clock
        self.log = log or (lambda event, **kw: None)
        self.feeds = {symbol: TapeFeed(symbol) for symbol in TAPE_SYMBOLS}
        self.halted = None  # set when IBKR reports the subscription cap; stays until the process restarts
        self.off = False  # the off-switch file exists

    def reason(self):
        """Why the stream holds no subscription on purpose, or None."""
        return "switched off" if self.off else self.halted

    def _drop(self, feed, now, event, failed=False, **kw):
        """Ends the subscription of a feed. A failed attempt (no print since its trade stream was requested)
        doubles the next wait of that feed."""
        self.gateway.unsubscribe_tape(feed)
        wait = TAPE_RETRY_SECONDS
        if failed:
            wait, feed.delay = feed.delay, min(feed.delay * 2, TAPE_RETRY_MAX_SECONDS)
        feed.retry_at = max(feed.retry_at, now + wait)
        self.log(event, symbol=feed.symbol, **kw)

    def _release(self, feeds, now):
        """Cancels every subscription. IBKR allows one tick-by-tick request per instrument in 15 s, and the feed
        can have sent one just now: no new request for it before that time passed (the off switch can go on and
        off within seconds)."""
        for feed in feeds:
            if feed.attached():
                self.gateway.unsubscribe_tape(feed)
                feed.retry_at = max(feed.retry_at, now + TAPE_TRADES_DELAY_SECONDS)

    def step(self):
        feeds, now = list(self.feeds.values()), self.clock()
        # Off switch: checked in every pass, so it works at any time without a restart.
        off = self.off_file is not None and os.path.exists(self.off_file)
        if off != self.off:
            self.off = off
            self.log("tape_off" if off else "tape_on")
        if self.off:
            self._release(feeds, now)
            return
        if self.halted is not None:
            return
        # Only a print of the feed itself proves that its subscription works. A quote of the feed or a tick of the
        # other feed must not reset the wait of a feed whose trade stream IBKR refuses again and again. A feed
        # that is healthy but ends before its first print (a quiet market) waits longer once, at most
        # TAPE_RETRY_MAX_SECONDS, and its first print resets the wait.
        for feed in feeds:
            if feed.printed():
                feed.delay = TAPE_RETRY_SECONDS
        # Lost: IBKR reported an error on a stream, connectivity returned with data lost, or the connection closed.
        for feed in feeds:
            if not (feed.attached() and feed.done.is_set()):
                continue
            code = getattr(feed.error, "code", None)
            self._drop(feed, now, "tape_lost", failed=not feed.printed(), error=feed.cause(), code=code)
            if code == TAPE_CAP_CODE:  # research gives way to trading: no new request until a restart
                self._release(feeds, now)
                self.halted = "subscription cap reached"
                self.log("tape_halted", reason=self.halted)
                return
        # Idle: a trade stream without a print while another feed prints is stalled; a long silence ends it too.
        newest = max((feed.last_print or 0.0) for feed in feeds)
        for feed in feeds:
            if feed.trade_id is None:
                continue
            idle = now - max(feed.last_print or 0.0, feed.trades_at)
            if idle > TAPE_QUIET_SECONDS or (idle > TAPE_IDLE_SECONDS and now - newest <= TAPE_IDLE_SECONDS):
                self._drop(feed, now, "tape_idle", failed=not feed.printed(), seconds=round(idle))
        # Subscribe: the quote stream, then the trade stream once trades_due passed. A feed waits until its own
        # retry_at, and a refusal of one feed does not stop the next feed. Every wait is TAPE_TRADES_DELAY_SECONDS
        # or longer (_drop, _release, trades_due), so one instrument is never requested twice in 15 s.
        for feed in feeds:
            if now < feed.retry_at or (feed.attached() and (feed.trade_id is not None or now < feed.trades_due)):
                continue
            try:
                self.gateway.subscribe_tape(tape_request(feed.symbol), feed)
            except Exception as e:
                kind = e.kind if isinstance(e, IbError) else type(e).__name__
                self._drop(feed, now, "tape_subscribe_failed", failed=True, kind=kind)
                if kind == "unavailable":
                    # The gateway is not reachable, so the next feed would fail too, and each failed connect
                    # counts for the watchdog. One connect attempt per wait: the pass ends, and the feeds
                    # without a subscription wait with the failed feed (their own delay does not double).
                    for other in feeds:
                        if not other.attached():
                            other.retry_at = max(other.retry_at, feed.retry_at)
                    return

    def start(self, wait=time.sleep):
        def loop():
            while True:
                try:
                    self.step()
                except Exception as e:
                    self.log("tape_step_failed", kind=type(e).__name__)
                wait(1.0)

        threading.Thread(target=loop, name="tape", daemon=True).start()


def make_handler(service, token):
    expected = ("Bearer " + token).encode()
    routes = {PREFIX + "/bars": service.bars, PREFIX + "/ticks": service.ticks, PREFIX + "/depth": service.depth,
              PREFIX + "/news": service.news, PREFIX + "/option-chain": service.option_chain,
              PREFIX + "/tape": service.tape}

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


def ibapi_version():
    try:
        import ibapi
    except ImportError:
        return None
    try:
        return str(ibapi.get_version_string())
    except Exception:
        return None


def client_problem():
    """None when the installed ibapi is new enough, else the reason."""
    try:
        from ibapi import server_versions
    except ImportError:
        return "ibapi is not installed"
    found = getattr(server_versions, "MAX_CLIENT_VER", 0)
    if not isinstance(found, int) or found < MIN_CLIENT_VER:
        return "ibapi MAX_CLIENT_VER %s is below %d; install ibapi 10.30.1" % (found, MIN_CLIENT_VER)
    return None


def main():
    problem = client_problem()
    if problem:
        print("vertex-history refuses to start: " + problem, file=sys.stderr)
        return 3
    token = os.environ.get("VERTEX_STATUS_TOKEN", "")
    if len(token) < 32:
        print("VERTEX_STATUS_TOKEN missing", file=sys.stderr)
        return 2
    cache_dir = os.environ.get("CACHE_DIRECTORY", "/var/cache/vertex-history")
    gateway_file = os.path.join(os.environ.get("RUNTIME_DIRECTORY", "/run/vertex-history"), "gateway")
    gateway = IbGateway(gateway_file, log=_log)
    option_quotes = option_quotes_enabled()  # read once; a change needs a restart
    off_file = os.path.join(os.environ.get("CONFIGURATION_DIRECTORY", "/etc/vertex-history"), TAPE_OFF_FILE)
    tape_stream = TapeStream(gateway, off_file, log=_log)
    service = HistoryService(gateway, DiskCache(cache_dir), Pacer(), log=_log, option_quotes=option_quotes,
                             tape_stream=tape_stream)
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), make_handler(service, token))
    server.daemon_threads = True

    def watchdog():
        while True:
            time.sleep(15)
            if gateway.connect_failures >= 3:
                _log("exit_reresolve_gateway")
                os._exit(75)

    threading.Thread(target=watchdog, name="watchdog", daemon=True).start()
    tape_stream.start()
    _log("listening", host=LISTEN_HOST, port=LISTEN_PORT, version=VERSION, client_id=CLIENT_ID,
         option_quotes=service.option_quotes, tape_off_file=off_file)
    try:
        server.serve_forever()
    finally:
        gateway.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
