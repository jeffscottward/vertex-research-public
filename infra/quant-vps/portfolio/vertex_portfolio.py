#!/usr/bin/env python3
"""Vertex read-only IBKR portfolio monitor service (QuantVPS).

Serves one sanitized snapshot of the IBKR account (summary, P&L, positions, open orders, completed
orders, executions, recent API errors) on 127.0.0.1:8792 for the Vertex dashboard Monitor view.

Read-only. A background thread owns ONE IB API client (client id 78). It only subscribes to account,
position, P&L, order and execution data. It never places, changes or cancels orders. The calls on the
client are limited to IbMonitor.IB_CALLS (the tests enforce this with an AST scan).

Account codes never leave the process: every output record is built from an allow-list of fields and
every output string is scrubbed for account-code patterns. Logs are JSON status lines without account data.

HTTP never waits for IB: requests read the last state under a lock.

Account mode (live / paper) is a configured fact and is reported at all times, also while the gateway
is down. See ModeTracker. The snapshot never carries a neutral placeholder for it: it has a mode, or a
named error (mismatch / not-configured).
"""
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

VERSION = "1.1.0"
SCHEMA = "vertex-portfolio-snapshot-v1"
HEALTH_SCHEMA = "vertex-portfolio-health-v1"
SOURCE = "ibkr-gateway"
CLIENT_ID = 78
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8792
PREFIX = "/vertex-portfolio/v1"

MAX_ROWS = 500
MAX_ERRORS = 20
READY_TIMEOUT = 20.0
# The session turns live only after every core feed has ended (positionEnd, accountSummaryEnd,
# openOrderEnd, execDetailsEnd). A half-loaded book is unknown.
# completedOrdersEnd is not required: on 2026-10-28 the gateway answered every other initial request
# in ~3 s but never sent completedOrdersEnd, so the service never went live. Completed orders are a
# history list; until their end arrives the snapshot shows an empty completed list and the log has completed_orders_pending.
FEEDS = ("positions", "summary", "orders", "executions")
FEEDS_TIMEOUT = 30.0
COMPLETED_WAIT = 10.0
ACCOUNT_WAIT = 10.0
ACCOUNT_LIST_WAIT = 10.0
TICK = 1.0
ORDERS_EVERY = 15.0
COMPLETED_EVERY = 60.0
EXECUTIONS_EVERY = 30.0
BACKOFF_START = 10.0
BACKOFF_MAX = 120.0
EXIT_AFTER_FAILURES = 6

SUMMARY_REQ_ID = 9001
PNL_REQ_ID = 9002
SUMMARY_TAGS = (
    "NetLiquidation", "TotalCashValue", "SettledCash", "BuyingPower", "AvailableFunds", "ExcessLiquidity",
    "InitMarginReq", "MaintMarginReq", "FullInitMarginReq", "FullMaintMarginReq", "GrossPositionValue",
    "EquityWithLoanValue", "Cushion", "Leverage", "LookAheadExcessLiquidity",
)
MAIN_ONLY_TAGS = ("Cushion", "Leverage")
INFO_CODES = {2100, 2103, 2104, 2105, 2106, 2107, 2108, 2119, 2150, 2157, 2158, 2172, 2174, 10275}
FATAL_CODES = {326, 502, 504, 1100, 1300}
ACCOUNT_RE = re.compile(r"\b(?:D[UF]|[UFI])\d{4,}\b")


def now_iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def scrub(text):
    return ACCOUNT_RE.sub("[account]", "" if text is None else str(text))


def num(x):
    """IB number to float; unset sentinels (>= 1e300), NaN and junk become None."""
    if isinstance(x, bool):
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or abs(v) >= 1e300:
        return None
    return v


def as_int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


def deep_scrub(obj):
    if isinstance(obj, str):
        return scrub(obj)
    if isinstance(obj, dict):
        return {k: deep_scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [deep_scrub(v) for v in obj]
    return obj


def account_mode(accounts):
    """Mode of a managed account list (DU/DF codes = paper). None for an empty list: nothing observed."""
    accounts = [a for a in accounts if a]
    if not accounts:
        return None
    if all(a.startswith(("DU", "DF")) for a in accounts):
        return "paper"
    return "live"


def normalize_mode(value):
    mode = value.strip().lower() if isinstance(value, str) else ""
    return mode if mode in ("live", "paper") else None


def read_configured_mode(path):
    """The gateway container's configured trading mode, written by resolve-gateway.sh. None if absent."""
    try:
        with open(path) as f:
            return normalize_mode(f.read())
    except OSError:
        return None


MODE_KEYS = ("confirmedMode", "confirmedAt", "downSince", "mismatch")
ACCOUNT_LIST_MISSING = "account list not received"
MODE_MISMATCH = "account mode mismatch"


class MemoryModeStore:
    def __init__(self, initial=None):
        self.rows = dict(initial or {})

    def load(self):
        return dict(self.rows)

    def save(self, key, value):
        if value is None:
            self.rows.pop(key, None)
        else:
            self.rows[key] = str(value)


class SqliteModeStore:
    """Key-value rows in the service's state directory. Holds mode words and times, never account codes."""

    def __init__(self, path):
        self.path = path
        db = self._db()
        try:
            with db:
                db.execute("CREATE TABLE IF NOT EXISTS account_mode (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        finally:
            db.close()

    def _db(self):
        return sqlite3.connect(self.path, timeout=5)

    def load(self):
        db = self._db()
        try:
            return dict(db.execute("SELECT k, v FROM account_mode").fetchall())
        finally:
            db.close()

    def save(self, key, value):
        db = self._db()
        try:
            with db:
                if value is None:
                    db.execute("DELETE FROM account_mode WHERE k = ?", (key,))
                else:
                    db.execute("INSERT INTO account_mode (k, v) VALUES (?, ?) "
                               "ON CONFLICT(k) DO UPDATE SET v = excluded.v", (key, str(value)))
        finally:
            db.close()


def open_mode_store(path, log=None):
    """A store that cannot be opened is logged once and replaced by memory: the mode is still served,
    it only does not survive a restart."""
    try:
        return SqliteModeStore(path)
    except (sqlite3.Error, OSError) as e:
        if log:
            log("account_mode_store_unavailable", reason=type(e).__name__)
        return MemoryModeStore()


def _epoch(value):
    try:
        t = float(value)
    except (TypeError, ValueError):
        return None
    return t if t > 0 and t == t and t != float("inf") else None


class ModeTracker:
    """Account mode of the gateway session. Not thread-safe: PortfolioState calls it under its lock.

    configured  the trading mode the gateway container is configured for (read at service start);
    confirmed   the mode of the managed account list the gateway sent in a session.
    The last confirmed mode, its time and the start of the current outage are kept in the store, so a
    disconnect or a service restart does not lose them.
    Errors are named: "mismatch" (configured and confirmed disagree; account data is withheld) and
    "not-configured" (no configured mode and no confirmed mode yet).
    """

    def __init__(self, configured=None, store=None, clock=time.time):
        self.clock = clock
        self.store = store or MemoryModeStore()
        try:
            saved = self.store.load()
        except (sqlite3.Error, OSError):
            saved = {}
        self.configured = normalize_mode(configured)
        self.confirmed_mode = normalize_mode(saved.get("confirmedMode"))
        self.confirmed_at = _epoch(saved.get("confirmedAt"))
        # Start of the current outage. A fresh process is down until a session reaches live.
        self.down_since = _epoch(saved.get("downSince")) or self.clock()
        self.live_since = None
        self.session_confirmed = False
        # A mismatch is stored with the configured mode it was found for, so a restart keeps it and a
        # corrected configuration clears it.
        self.mismatch = self.configured is not None and saved.get("mismatch") == self.configured
        self._put("downSince", self.down_since)

    def _put(self, key, value):
        if key not in MODE_KEYS:
            raise ValueError("unexpected account-mode key %s" % key)
        try:
            self.store.save(key, value)
        except (sqlite3.Error, OSError):
            pass  # the in-memory value stays correct

    def observe(self, observed):
        """The mode of the account list of this session. Returns False on a mismatch."""
        observed = normalize_mode(observed)
        if observed is None:
            return not self.mismatch
        if self.configured and observed != self.configured:
            if not self.mismatch:
                self._put("mismatch", self.configured)
            self.mismatch = True
            self.session_confirmed = False
            return False
        if self.mismatch:
            self._put("mismatch", None)
        self.mismatch = False
        self.session_confirmed = True
        self.confirmed_at = self.clock()
        if observed != self.confirmed_mode:
            self.confirmed_mode = observed
            self._put("confirmedMode", observed)
        self._put("confirmedAt", self.confirmed_at)
        return True

    def session_reset(self):
        """A new connection: nothing is confirmed in it yet. A mismatch stays until a list agrees."""
        self.session_confirmed = False

    def set_live(self, live):
        if live:
            if self.live_since is None:
                self.live_since = self.clock()
            if self.down_since is not None:
                self.down_since = None
                self._put("downSince", None)
        else:
            self.live_since = None
            if self.down_since is None:
                self.down_since = self.clock()
                self._put("downSince", self.down_since)

    def since(self):
        return self.live_since if self.live_since is not None else self.down_since

    def view(self):
        none = {"accountMode": None, "modeSource": None, "modeConfirmedAt": None}
        if self.mismatch:
            return dict(none, modeError="mismatch")
        mode = self.configured or self.confirmed_mode
        if not mode:
            return dict(none, modeError="not-configured")
        return {
            "accountMode": mode,
            "modeSource": "confirmed" if self.session_confirmed or not self.configured else "configured",
            "modeConfirmedAt": self.confirmed_at if self.confirmed_mode == mode else None,
            "modeError": None,
        }


def next_backoff(current):
    if current <= 0:
        return BACKOFF_START
    return min(BACKOFF_MAX, current * 2)


class PortfolioState:
    """IB callback sink and snapshot builder. Thread-safe through self.lock."""

    def __init__(self, clock=time.time, mode=None):
        self.clock = clock
        self.mode = mode or ModeTracker(clock=clock)
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.state = "starting"
        self.last_error = None
        self.fatal = None
        self.errors = []
        self.reset()

    def reset(self):
        """Clear all account data (on every new connection), so old data never shows as live."""
        with self.lock:
            self.ready.clear()
            self.feeds = set()
            self.fatal = None
            # The account list is dropped with the connection; the account mode is not (self.mode).
            self.accounts = []
            self.mode.session_reset()
            self.main_acct = None
            self.positions = {}  # (acct, conId) -> {position, avgCost}
            self.contracts = {}
            self.portfolio = {}
            self.pnl_single = {}
            self.pnl_req = {}
            self.pnl_acct = {"daily": None, "unrealized": None, "realized": None}
            self.summary = {}
            self.orders_buf, self.orders = {}, []
            self.orders_ts = None
            self.completed_buf, self.completed = [], []
            self.exec_buf, self.execs = {}, []
            self.commissions = {}
            self.data_ts = None
            self.next_req = 5000

    def _touch(self):
        self.data_ts = self.clock()

    def set_state(self, state, error=None):
        with self.lock:
            self.state = state
            self.mode.set_live(state == "live" and not self.mode.mismatch)
            if error is not None:
                self.last_error = scrub(error)[:200]

    def rid(self):
        with self.lock:
            self.next_req += 1
            return self.next_req

    # connection
    def nextValidId(self, orderId):
        self.ready.set()

    def managedAccounts(self, accountsList):
        with self.lock:
            self.accounts = [a.strip() for a in str(accountsList).split(",") if a.strip()]
            if not self.mode.observe(account_mode(self.accounts)):
                # Configured mode and account list disagree: end the session, show nothing from it.
                self.fatal = MODE_MISMATCH

    def connectionClosed(self):
        if self.fatal != MODE_MISMATCH:
            self.fatal = "connection closed"

    def error(self, reqId, code, msg, *rest):
        code = as_int(code)
        if code in INFO_CODES:
            return
        if code in FATAL_CODES and self.fatal != MODE_MISMATCH:
            self.fatal = "api error %d" % code
        with self.lock:
            self.errors.append({"t": self.clock(), "code": code, "msg": scrub(msg)[:200]})
            self.errors = self.errors[-MAX_ERRORS:]

    # positions
    def _contract(self, c):
        con = as_int(getattr(c, "conId", 0))
        rec = {
            "conId": con, "symbol": scrub(getattr(c, "symbol", "")), "secType": scrub(getattr(c, "secType", "")),
            "currency": scrub(getattr(c, "currency", "")), "right": scrub(getattr(c, "right", "") or ""),
            "strike": num(getattr(c, "strike", 0)) or 0,
            "expiry": scrub(getattr(c, "lastTradeDateOrContractMonth", "") or ""),
            "multiplier": scrub(getattr(c, "multiplier", "") or ""),
            "localSymbol": scrub(getattr(c, "localSymbol", "") or ""),
        }
        self.contracts[con] = rec
        return rec

    def position(self, account, contract, position, avgCost):
        with self.lock:
            rec = self._contract(contract)
            self.positions[(str(account), rec["conId"])] = {"position": num(position) or 0.0, "avgCost": num(avgCost)}
            self._touch()

    def _feed_done(self, name):
        with self.lock:
            self.feeds.add(name)

    def feeds_ready(self, names=FEEDS):
        with self.lock:
            return all(n in self.feeds for n in names)

    def positionEnd(self):
        self._feed_done("positions")

    def updatePortfolio(self, contract, position, marketPrice, marketValue, averageCost,
                        unrealizedPNL, realizedPNL, accountName):
        with self.lock:
            rec = self._contract(contract)
            self.portfolio[rec["conId"]] = {
                "position": num(position) or 0.0, "marketPrice": num(marketPrice), "marketValue": num(marketValue),
                "avgCost": num(averageCost), "unrealized": num(unrealizedPNL), "realized": num(realizedPNL),
            }
            self._touch()

    def updateAccountValue(self, key, val, currency, accountName):
        pass

    def updateAccountTime(self, timeStamp):
        pass

    def accountDownloadEnd(self, accountName):
        self._feed_done("account")

    # P&L
    def pnl(self, reqId, dailyPnL, unrealizedPnL, realizedPnL):
        with self.lock:
            self.pnl_acct = {"daily": num(dailyPnL), "unrealized": num(unrealizedPnL), "realized": num(realizedPnL)}
            self._touch()

    def pnlSingle(self, reqId, pos, dailyPnL, unrealizedPnL, realizedPnL, value):
        with self.lock:
            con = self.pnl_req.get(reqId)
            if con is None:
                return
            self.pnl_single[con] = {"daily": num(dailyPnL), "unrealized": num(unrealizedPnL),
                                    "realized": num(realizedPnL), "value": num(value), "t": self.clock()}
            self._touch()

    # account summary
    def accountSummary(self, reqId, account, tag, value, currency):
        if tag not in SUMMARY_TAGS:
            return
        with self.lock:
            self.summary.setdefault(str(account), {})[tag] = value
            self._touch()

    def accountSummaryEnd(self, reqId):
        self._feed_done("summary")

    # orders
    def _order(self, contract, order, state, completed=False):
        c = self._contract(contract)
        return {
            "key": "%d:%d:%d" % (as_int(order.clientId), as_int(order.orderId), as_int(order.permId)),
            "orderId": as_int(order.orderId), "permId": as_int(order.permId), "clientId": as_int(order.clientId),
            "parentId": as_int(order.parentId), "ocaGroup": scrub(order.ocaGroup), "orderRef": scrub(order.orderRef),
            "conId": c["conId"], "symbol": c["symbol"], "secType": c["secType"], "localSymbol": c["localSymbol"],
            "action": scrub(order.action), "orderType": scrub(order.orderType), "qty": num(order.totalQuantity),
            "filledQty": num(getattr(order, "filledQuantity", None)), "remaining": None, "avgFill": None,
            "lmt": num(order.lmtPrice), "aux": num(order.auxPrice), "trailPct": num(order.trailingPercent),
            "trailStop": num(order.trailStopPrice), "tif": scrub(order.tif), "outsideRth": bool(order.outsideRth),
            "status": scrub(getattr(state, "status", "")), "transmit": bool(order.transmit),
            "completedTime": scrub(getattr(state, "completedTime", "")) if completed else "",
            "completedStatus": scrub(getattr(state, "completedStatus", "")) if completed else "",
        }

    def openOrder(self, orderId, contract, order, orderState):
        with self.lock:
            rec = self._order(contract, order, orderState)
            self.orders_buf[rec["key"]] = rec

    def orderStatus(self, orderId, status, filled, remaining, avgFillPrice, permId, parentId,
                    lastFillPrice, clientId, whyHeld, mktCapPrice=None):
        with self.lock:
            for rec in list(self.orders_buf.values()) + self.orders:
                if rec["permId"] == as_int(permId):
                    rec["status"] = scrub(status)
                    rec["filledQty"] = num(filled)
                    rec["remaining"] = num(remaining)
                    rec["avgFill"] = num(avgFillPrice)

    def openOrderEnd(self):
        with self.lock:
            self.orders = list(self.orders_buf.values())[:MAX_ROWS]
            self.orders_buf = {}
            self.orders_ts = self.clock()
            self.feeds.add("orders")

    def begin_completed(self):
        # Call before each reqCompletedOrders: a reply without completedOrdersEnd must not leave rows
        # that the next reply duplicates (the buffer would grow while the session lasts).
        with self.lock:
            self.completed_buf = []

    def completedOrder(self, contract, order, orderState):
        with self.lock:
            self.completed_buf.append(self._order(contract, order, orderState, completed=True))

    def completedOrdersEnd(self):
        with self.lock:
            self.completed, self.completed_buf = self.completed_buf[-MAX_ROWS:], []
            self.feeds.add("completed")

    # executions
    def execDetails(self, reqId, contract, execution):
        with self.lock:
            c = self._contract(contract)
            self.exec_buf[str(execution.execId)] = {
                "execId": scrub(execution.execId), "time": scrub(execution.time),
                "symbol": c["symbol"], "secType": c["secType"], "localSymbol": c["localSymbol"],
                "side": scrub(execution.side), "shares": num(execution.shares), "price": num(execution.price),
                "avgPrice": num(execution.avgPrice), "cumQty": num(execution.cumQty),
                "orderId": as_int(execution.orderId), "permId": as_int(execution.permId),
                "clientId": as_int(execution.clientId), "exchange": scrub(execution.exchange),
                "orderRef": scrub(getattr(execution, "orderRef", "")),
            }

    def execDetailsEnd(self, reqId):
        with self.lock:
            self.execs = sorted(self.exec_buf.items(), key=lambda kv: kv[1]["time"])[-MAX_ROWS:]
            self.exec_buf = {}
            self.feeds.add("executions")

    def commissionReport(self, commissionReport):
        with self.lock:
            self.commissions[str(commissionReport.execId)] = {
                "commission": num(commissionReport.commission), "realized": num(commissionReport.realizedPNL)}

    # derived
    def choose_main_account(self):
        with self.lock:
            held = {}
            for (acct, _), p in self.positions.items():
                if p["position"]:
                    held[acct] = held.get(acct, 0) + 1
            self.main_acct = max(held, key=held.get) if held else (self.accounts[0] if self.accounts else None)
            return self.main_acct

    def held_con_ids(self):
        with self.lock:
            return {con for (acct, con), p in self.positions.items() if acct == self.main_acct and p["position"]}

    def snapshot(self):
        with self.lock:
            live = self.state == "live" and not self.mode.mismatch
            totals = {}
            for acct, tags in self.summary.items():
                for tag, val in tags.items():
                    v = num(val)
                    if v is None:
                        continue
                    if tag in MAIN_ONLY_TAGS:
                        if acct == self.main_acct:
                            totals[tag] = v
                    else:
                        totals[tag] = totals.get(tag, 0.0) + v
            rows = []
            cons = {con for (acct, con), p in self.positions.items() if acct == self.main_acct and p["position"]}
            cons |= {con for con, p in self.portfolio.items() if p["position"]}
            for con in sorted(cons):
                c = self.contracts.get(con, {})
                pos = self.positions.get((self.main_acct, con), {})
                pf = self.portfolio.get(con, {})
                ps = self.pnl_single.get(con, {})
                qty = pf.get("position", pos.get("position"))
                if not qty:
                    continue
                rows.append({
                    "conId": con, "symbol": c.get("symbol", ""), "secType": c.get("secType", ""),
                    "currency": c.get("currency", ""), "right": c.get("right", ""), "strike": c.get("strike", 0),
                    "expiry": c.get("expiry", ""), "multiplier": c.get("multiplier", ""),
                    "localSymbol": c.get("localSymbol", ""), "position": qty,
                    "avgCost": pf.get("avgCost", pos.get("avgCost")),
                    "acctMarketPrice": pf.get("marketPrice"), "acctMarketValue": pf.get("marketValue"),
                    "acctUnrealized": pf.get("unrealized"), "realized": pf.get("realized"),
                    "pnlValue": ps.get("value"), "dailyPnl": ps.get("daily"),
                    "pnlUnrealized": ps.get("unrealized"), "pnlT": ps.get("t"),
                })
            execs = []
            for exec_id, e in self.execs:
                cm = self.commissions.get(exec_id, {})
                execs.append(dict(e, commission=cm.get("commission"), realized=cm.get("realized")))
            doc = {
                "schema": SCHEMA, "source": SOURCE, "clientId": CLIENT_ID, "version": VERSION,
                "generatedAt": self.clock(), "state": self.state, "connected": live,
                "lastError": self.last_error, **self.mode.view(),
                # Start of the current connection state: live since, or not live since.
                "stateSince": self.mode.since(),
                "accountCount": len(self.accounts), "dataAsOf": self.data_ts if live else None,
                # Until the core feeds have ended (state live), account data is unknown: withhold it
                # instead of showing a partial book as if it were complete.
                "ordersAsOf": self.orders_ts if live else None, "summary": totals if live else {},
                "pnl": dict(self.pnl_acct) if live else {"daily": None, "unrealized": None, "realized": None},
                "positions": rows[:MAX_ROWS] if live else [],
                "orders": [dict(o) for o in self.orders[:MAX_ROWS]] if live else [],
                "completed": [dict(o) for o in self.completed[-MAX_ROWS:]] if live else [],
                "executions": execs[-MAX_ROWS:] if live else [],
                "errors": [dict(e) for e in self.errors[-MAX_ERRORS:]],
            }
        return deep_scrub(doc)

    def mode_view(self):
        with self.lock:
            return self.mode.view()

    def has_accounts(self):
        with self.lock:
            return bool(self.accounts)

    def health(self):
        with self.lock:
            live = self.state == "live" and not self.mode.mismatch
            return {"schema": HEALTH_SCHEMA, "version": VERSION, "clientId": CLIENT_ID, "state": self.state,
                    "connected": live, "dataAsOf": self.data_ts if live else None}


def _default_client_factory(state):
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper

    class Wrapper(EWrapper):
        pass

    # Forward only the callbacks PortfolioState implements.
    for name in ("nextValidId", "managedAccounts", "connectionClosed", "error", "position", "positionEnd",
                 "updatePortfolio", "updateAccountValue", "updateAccountTime", "accountDownloadEnd", "pnl",
                 "pnlSingle", "accountSummary", "accountSummaryEnd", "openOrder", "orderStatus", "openOrderEnd",
                 "completedOrder", "completedOrdersEnd", "execDetails", "execDetailsEnd", "commissionReport"):
        setattr(Wrapper, name, (lambda n: lambda self, *a: getattr(state, n)(*a))(name))
    return EClient(Wrapper())


def _execution_filter():
    from ibapi.execution import ExecutionFilter

    return ExecutionFilter()


class IbMonitor:
    """The only code that talks to IB. Calls on self._client are limited to IB_CALLS (enforced by tests)."""

    IB_CALLS = ("connect", "disconnect", "isConnected", "run", "reqPositions", "reqAccountSummary",
                "reqAccountUpdates", "reqPnL", "reqPnLSingle", "reqAllOpenOrders", "reqCompletedOrders",
                "reqExecutions")

    def __init__(self, state, gateway_file, client_factory=None, filter_factory=None, clock=time.time,
                 sleep=time.sleep, log=None):
        self.state, self.gateway_file = state, gateway_file
        self.client_factory = client_factory or _default_client_factory
        self.filter_factory = filter_factory or _execution_filter
        self.clock, self.sleep = clock, sleep
        self.log = log or (lambda event, **kw: None)
        self.stop = threading.Event()
        self.backoff = 0.0
        self.sessions = 0
        self.failures = 0  # sessions in a row that did not reach live
        self._client = None

    def _endpoint(self):
        with open(self.gateway_file) as f:
            host, port = f.read().split()
        return host, int(port)

    def _alive(self):
        return self.state.fatal is None and self._client is not None and self._client.isConnected()

    def _wait(self, cond, timeout):
        end = self.clock() + timeout
        while not cond() and self.clock() < end and not self.stop.is_set():
            self.sleep(0.2)
        return cond()

    def session(self):
        """One connection: connect, subscribe, poll until it fails. Returns True if it reached live."""
        self.state.reset()
        self.state.set_state("starting")
        host, port = self._endpoint()
        self._client = self.client_factory(self.state)
        self._client.connect(host, port, CLIENT_ID)
        if not self._client.isConnected():
            raise ConnectionError("gateway API not reachable")
        threading.Thread(target=self._client.run, name="ib-reader", daemon=True).start()
        if not self._wait(self.state.ready.is_set, READY_TIMEOUT):
            raise ConnectionError(self.state.fatal or "gateway handshake timed out")
        if self.state.mode.configured:
            # The mode check needs the managed account list, which can arrive after nextValidId. No
            # account request is sent before it is checked, and none to a gateway that is logged in
            # to the other kind of account.
            self._wait(lambda: self.state.has_accounts() or not self._alive(), ACCOUNT_LIST_WAIT)
            if self.state.fatal == MODE_MISMATCH:
                self.log("account_mode_mismatch", configured=self.state.mode.configured)
                raise ConnectionError(MODE_MISMATCH)
            if not self.state.has_accounts():
                raise ConnectionError(self.state.fatal or ACCOUNT_LIST_MISSING)
        self._client.reqPositions()
        self._client.reqAccountSummary(SUMMARY_REQ_ID, "All", ",".join(SUMMARY_TAGS))
        self._client.reqAllOpenOrders()
        self.state.begin_completed()
        self._client.reqCompletedOrders(False)
        self._client.reqExecutions(self.state.rid(), self.filter_factory())
        started = self.clock()
        if not self._wait(lambda: self.state.feeds_ready(FEEDS) or not self._alive(), FEEDS_TIMEOUT) or not self._alive():
            missing = [n for n in FEEDS if not self.state.feeds_ready((n,))]
            if missing:
                self.log("initial_feeds_missing", feeds=missing)
            raise ConnectionError(self.state.fatal or "initial IBKR data did not complete")
        # Completed orders are optional (see FEEDS): wait briefly, then go live without them.
        self._wait(lambda: self.state.feeds_ready(("completed",)) or not self._alive(), COMPLETED_WAIT)
        if not self._alive():
            raise ConnectionError(self.state.fatal or "disconnected")
        if not self.state.feeds_ready(("completed",)):
            self.log("completed_orders_pending", client_id=CLIENT_ID)
        main = self.state.choose_main_account()
        if main:
            self._client.reqAccountUpdates(True, main)
            self._client.reqPnL(PNL_REQ_ID, main, "")
            # Account updates only add per-position prices; positions, summary and orders are already
            # complete. Wait briefly, but do not block live on accountDownloadEnd (missing prices stay null).
            self._wait(lambda: self.state.feeds_ready(("account",)) or not self._alive(), ACCOUNT_WAIT)
            if not self._alive():
                raise ConnectionError(self.state.fatal or "disconnected")
            if not self.state.feeds_ready(("account",)):
                self.log("account_updates_pending", client_id=CLIENT_ID)
        # Only now is the book complete; before this the snapshot stays "starting" (unknown, not empty).
        self.state.set_state("live")
        mode = self.state.mode_view()
        self.log("ib_live", client_id=CLIENT_ID, account_count=len(self.state.accounts),
                 account_mode=mode["accountMode"], mode_source=mode["modeSource"])
        subscribed = set()
        last = {"orders": started, "completed": started, "execs": started}
        while not self.stop.is_set():
            if not self._alive():
                raise ConnectionError(self.state.fatal or "disconnected")
            now = self.clock()
            if main:
                for con in sorted(self.state.held_con_ids() - subscribed):
                    r = self.state.rid()
                    with self.state.lock:
                        self.state.pnl_req[r] = con
                    self._client.reqPnLSingle(r, main, "", con)
                    subscribed.add(con)
            if last["orders"] is None or now - last["orders"] >= ORDERS_EVERY:
                self._client.reqAllOpenOrders()
                last["orders"] = now
            if last["completed"] is None or now - last["completed"] >= COMPLETED_EVERY:
                self.state.begin_completed()
                self._client.reqCompletedOrders(False)
                last["completed"] = now
            if last["execs"] is None or now - last["execs"] >= EXECUTIONS_EVERY:
                self._client.reqExecutions(self.state.rid(), self.filter_factory())
                last["execs"] = now
            self.sleep(TICK)
        return True

    def _drop(self):
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
        self._client = None

    def run_once(self):
        """Run one session and the backoff after it. Returns the seconds slept."""
        self.sessions += 1
        reached_live = False
        try:
            reached_live = self.session()
        except Exception as e:  # noqa: BLE001 - every failure leads to reconnect
            reached_live = self.state.state == "live"
            reason = scrub(str(e) or type(e).__name__)[:200]
            self.state.set_state("disconnected", reason)
            self.log("ib_disconnected", reason=reason)
        finally:
            self._drop()
        if self.stop.is_set():
            return 0.0
        # Clear the data so a disconnected snapshot never carries old values.
        self.state.reset()
        self.state.set_state("disconnected")
        self.failures = 0 if reached_live else self.failures + 1
        self.backoff = BACKOFF_START if reached_live else next_backoff(self.backoff)
        self.log("ib_backoff", seconds=self.backoff)
        self.sleep(self.backoff)
        return self.backoff

    def run_forever(self):
        while not self.stop.is_set():
            self.run_once()


def make_handler(state, token):
    expected = ("Bearer " + token).encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "vertex-portfolio/" + VERSION
        sys_version = ""

        def log_message(self, fmt, *args):
            return

        def _send(self, status, body):
            data = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            got = (self.headers.get("Authorization") or "").encode()
            return hmac.compare_digest(got, expected)

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            path = urlsplit(self.path).path
            if path == PREFIX + "/health":
                return self._send(200, state.health())
            if path == PREFIX + "/snapshot":
                return self._send(200, state.snapshot())
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
    gateway_file = os.path.join(os.environ.get("RUNTIME_DIRECTORY", "/run/vertex-portfolio"), "gateway")
    runtime_dir = os.path.dirname(gateway_file)
    configured = read_configured_mode(os.path.join(runtime_dir, "mode"))
    state_dir = os.environ.get("STATE_DIRECTORY", "").split(":")[0] or runtime_dir
    store = open_mode_store(os.path.join(state_dir, "account-mode.sqlite"), log=_log)
    state = PortfolioState(mode=ModeTracker(configured=configured, store=store))
    mode = state.mode_view()
    if mode["modeError"] == "not-configured":
        # A named setup error, not a neutral placeholder. resolve-gateway.sh reads the mode from the
        # gateway container (label com.ibkr-nautilus-exec-node.trading-mode, else TRADING_MODE).
        _log("account_mode_not_configured", fix="set TRADING_MODE on the ib-gateway container")
    else:
        _log("account_mode", account_mode=mode["accountMode"], mode_source=mode["modeSource"])
    monitor = IbMonitor(state, gateway_file, log=_log)
    threading.Thread(target=monitor.run_forever, name="ib-monitor", daemon=True).start()

    def watchdog():
        # The gateway IP can change when its container is recreated. After several failed sessions, exit so
        # systemd (Restart=on-failure) runs the resolver again.
        while True:
            time.sleep(15)
            if monitor.failures >= EXIT_AFTER_FAILURES:
                _log("exit_reresolve_gateway")
                os._exit(75)

    threading.Thread(target=watchdog, name="watchdog", daemon=True).start()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), make_handler(state, token))
    server.daemon_threads = True
    _log("listening", host=LISTEN_HOST, port=LISTEN_PORT, version=VERSION, client_id=CLIENT_ID)
    try:
        server.serve_forever()
    finally:
        monitor.stop.set()
        monitor._drop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
