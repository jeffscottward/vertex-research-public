#!/usr/bin/env python3
"""Tests for the read-only IBKR history service. Run: python3 infra/quant-vps/history/test_vertex_history.py"""
import ast
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
import threading
import types
import unittest
from unittest import mock
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vertex_history as vh  # noqa: E402

SOURCE_PATH = os.path.join(HERE, "vertex_history.py")
with open(SOURCE_PATH) as _f:
    SOURCE = _f.read()

# Order, account and position entry points of the IB API. None may appear anywhere in the service source.
FORBIDDEN = [
    "placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions", "reqAccountUpdates", "reqAccountUpdatesMulti",
    "reqAccountSummary", "reqPositions", "reqPositionsMulti", "reqExecutions", "reqOpenOrders", "reqAllOpenOrders",
    "reqAutoOpenOrders", "reqCompletedOrders", "reqPnL", "reqPnLSingle", "reqManagedAccts", "reqIds",
    "reqFamilyCodes", "reqUserInfo", "replaceFA", "requestFA", "reqWshEventData", "ibapi.order", "ibapi.execution",
    "OrderState", "Order(",
]
ALLOWED_IB_CALLS = {"connect", "disconnect", "isConnected", "run", "reqContractDetails", "reqHistoricalData",
                    "cancelHistoricalData", "reqHeadTimeStamp", "reqHistoricalTicks", "reqMktDepth",
                    "cancelMktDepth", "reqNewsProviders", "reqHistoricalNews", "reqSecDefOptParams", "reqMktData",
                    "cancelMktData"}
# 1.4.0 grew the allow list by exactly these three (option chain definition, one-shot snapshots and their cancel).
OPTION_CHAIN_IB_CALLS = {"reqSecDefOptParams", "reqMktData", "cancelMktData"}
ALLOWED_BEFORE_1_4_0 = ALLOWED_IB_CALLS - OPTION_CHAIN_IB_CALLS


def _functions_using(tree, attr):
    """Names of the functions whose own body (nested functions excluded from the outer one) uses `.attr`."""
    found = set()

    def visit(node, owner):
        for child in ast.iter_child_nodes(node):
            inner = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else owner
            if isinstance(child, ast.Attribute) and child.attr == attr:
                found.add(owner)
            visit(child, inner)

    visit(tree, None)
    return found


def market_data_problems(source):
    """reqMktData may exist only as the one snapshot call of IbGateway._snapshots, reached only through
    fetch_option_chain and HistoryService.option_chain, and only as a non-regulatory snapshot without generic
    ticks. Returns the list of violations (empty = fine)."""
    tree = ast.parse(source)
    problems = []
    for attr, owners in (("reqMktData", {"_snapshots"}), ("_snapshots", {"fetch_option_chain"}),
                         ("fetch_option_chain", {"option_chain"}), ("cancelMktData", {"_cancel_snapshot"}),
                         ("_cancel_snapshot", {"_snapshots"}), ("reqSecDefOptParams", {"_option_definition"}),
                         ("_option_definition", {"fetch_option_chain"})):
        users = _functions_using(tree, attr)
        if users != owners:
            problems.append("%s used in %s, expected only %s" % (attr, sorted(map(str, users)), sorted(owners)))
    for node in ast.walk(tree):  # no dynamic attribute access that could hide an IB call
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr":
            name = node.args[1] if len(node.args) > 1 else None
            if not isinstance(name, ast.Constant) or re.match(r"^(req|cancel|place|exercise)", str(name.value)):
                problems.append("getattr with a dynamic or IB call name")
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and n.func.attr == "reqMktData"]
    if len(calls) != 1:
        problems.append("expected exactly one reqMktData call, found %d" % len(calls))
    for call in calls:
        args = call.args
        ok = (len(args) == 6 and not call.keywords
              and isinstance(args[2], ast.Constant) and args[2].value == ""
              and isinstance(args[3], ast.Constant) and args[3].value is True
              and isinstance(args[4], ast.Constant) and args[4].value is False
              and isinstance(args[5], ast.List) and not args[5].elts)
        if not ok:
            problems.append('reqMktData must be called as (reqId, contract, "", True, False, [])')
    # no alias: every `.reqMktData` attribute must be the func of that one call
    funcs = {id(call.func) for call in calls}
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "reqMktData" and id(node) not in funcs:
            problems.append("reqMktData referenced outside its one call (line %d)" % node.lineno)
    # no call by name: the string may appear only in the IB_CALLS allow-list tuple (once). A bare string statement
    # (a docstring) is not a value any code can use, so it is not counted.
    allowed, unused = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "IbGateway":
            for stmt in node.body:
                if (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.value, ast.Tuple)
                        and isinstance(stmt.targets[0], ast.Name) and stmt.targets[0].id == "IB_CALLS"):
                    allowed.update(id(elt) for elt in stmt.value.elts
                                   if isinstance(elt, ast.Constant) and elt.value == "reqMktData")
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            unused.add(id(node.value))
    if len(allowed) != 1:
        problems.append("expected reqMktData exactly once in IbGateway.IB_CALLS, found %d" % len(allowed))
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)) and id(node) not in allowed
                and id(node) not in unused
                and "reqMktData" in (node.value if isinstance(node.value, str) else node.value.decode("latin-1"))):
            problems.append("the string reqMktData outside the allow list (line %d)" % node.lineno)
    if any(isinstance(n, ast.Attribute) and n.attr == "reqMarketDataType" for n in ast.walk(tree)):
        problems.append("reqMarketDataType must not be called")
    return problems


TOKEN = "T" * 40


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class StaticSafetyTest(unittest.TestCase):
    def test_no_order_account_or_position_methods(self):
        for name in FORBIDDEN:
            self.assertNotIn(name, SOURCE, "forbidden IB API name in service source: " + name)

    def test_client_calls_are_allow_listed(self):
        tree = ast.parse(SOURCE)
        used = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Attribute) \
                    and node.value.attr == "_client" and isinstance(node.value.value, ast.Name):
                used.add(node.attr)
        self.assertTrue(used, "expected calls on self._client")
        self.assertLessEqual(used, ALLOWED_IB_CALLS)
        self.assertLessEqual(set(vh.IbGateway.IB_CALLS), ALLOWED_IB_CALLS)
        self.assertLessEqual(used, set(vh.IbGateway.IB_CALLS))
        # every req*/cancel* attribute anywhere in the module is an allowed call
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and re.match(r"^(req|cancel|place|exercise)[A-Z]", node.attr):
                self.assertIn(node.attr, ALLOWED_IB_CALLS, node.attr)
        self.assertEqual(SOURCE.count("EClient("), 1, "exactly one EClient construction")
        self.assertNotRegex(SOURCE, r"class \w+\([^)]*EClient")

    def test_client_id_and_bind_are_fixed(self):
        self.assertEqual(vh.CLIENT_ID, 77)
        self.assertRegex(SOURCE, r"(?m)^CLIENT_ID = 77$")
        self.assertEqual(vh.LISTEN_HOST, "127.0.0.1")
        self.assertNotRegex(SOURCE, r"environ[^\n]*(CLIENT_ID|LISTEN_HOST|LISTEN_PORT)")
        self.assertIn("connect(host, port, CLIENT_ID)", SOURCE)

    def test_read_only_market_data_calls_are_listed(self):
        for name in ("reqHistoricalTicks", "reqMktDepth", "cancelMktDepth"):
            self.assertIn(name, vh.IbGateway.IB_CALLS)
        # no streaming top-of-book subscription: reqMktData exists only as the option-chain snapshot (1.4.0)
        self.assertEqual(market_data_problems(SOURCE), [])

    def test_allow_list_grew_by_exactly_the_three_option_chain_calls(self):
        self.assertEqual(set(vh.IbGateway.IB_CALLS) - ALLOWED_BEFORE_1_4_0, OPTION_CHAIN_IB_CALLS)
        self.assertEqual(ALLOWED_BEFORE_1_4_0, {
            "connect", "disconnect", "isConnected", "run", "reqContractDetails", "reqHistoricalData",
            "cancelHistoricalData", "reqHeadTimeStamp", "reqHistoricalTicks", "reqMktDepth", "cancelMktDepth",
            "reqNewsProviders", "reqHistoricalNews"})

    def test_market_data_outside_the_option_chain_path_is_detected(self):
        call = 'self._client.reqMktData(req_id, spec, "", True, False, [])'
        self.assertIn(call, SOURCE)
        stray = "\nclass Stray:\n    def fetch_quote(self, rid, spec):\n        %s\n"
        for probe in (SOURCE + stray % 'self._client.reqMktData(rid, spec, "", True, False, [])',
                      SOURCE + stray % "return self._snapshots([spec])",
                      SOURCE + stray % "return self.gateway.fetch_option_chain(spec)",
                      SOURCE + stray % "self._client.cancelMktData(rid)",
                      SOURCE.replace(call, 'self._client.reqMktData(req_id, spec, "", False, False, [])'),
                      SOURCE.replace(call, 'self._client.reqMktData(req_id, spec, "", True, True, [])'),
                      SOURCE.replace(call, 'self._client.reqMktData(req_id, spec, "233", True, False, [])'),
                      SOURCE.replace(call, 'self._client.reqMktData(req_id, spec, "", True, False, [tag])'),
                      SOURCE.replace(call, 'self._client.reqMktData(req_id, spec, "", snapshot, False, [])'),
                      SOURCE + stray % "self._client.reqMarketDataType(3)",
                      SOURCE + stray % 'getattr(self._client, "req" + "MktData")(rid, spec, "", False, False, [])',
                      # review probes: an alias next to the legitimate call, and two calls by name
                      SOURCE.replace(call, call + "\n                send = self._client.reqMktData"
                                     "\n                send(req_id, spec, \"\", False, True, [])"),
                      SOURCE + stray % 'operator.methodcaller("reqMktData", rid, spec, "", False, True, [])(self._client)',
                      SOURCE + stray % 'self._client.__getattribute__("reqMktData")(rid, spec, "", False, True, [])',
                      SOURCE + stray % 'name = b"reqMktData".decode()',
                      SOURCE + stray % 'name = f"reqMktData{rid}"',
                      SOURCE.replace('"reqSecDefOptParams", "reqMktData", "cancelMktData")',
                                     '"reqSecDefOptParams", "reqMktData", "reqMktData", "cancelMktData")')):
            ast.parse(probe)
            self.assertTrue(market_data_problems(probe), probe[-200:])
        # each new rule fires by itself, not through an older one
        alias = market_data_problems(SOURCE + stray % "send = self._client.reqMktData")
        self.assertTrue(any("outside its one call" in problem for problem in alias), alias)
        by_name = market_data_problems(SOURCE + stray % 'return operator.methodcaller("reqMktData")')
        self.assertEqual([problem.split(" (")[0] for problem in by_name], ["the string reqMktData outside the allow list"])

    def test_scan_detects_forbidden_names(self):
        probe = SOURCE + "\nclient.place" + "Order(1, c, o)\n"
        self.assertTrue(any(name in probe for name in FORBIDDEN))


def q(**kw):
    return {k: [v] for k, v in kw.items()}


class ValidateTest(unittest.TestCase):
    def test_defaults(self):
        r = vh.validate(q(symbol="spy"))
        self.assertEqual(r, {"symbol": "SPY", "secType": "STK", "exchange": "SMART", "currency": "USD",
                             "barSize": "1 day", "duration": "1 Y", "whatToShow": "TRADES", "useRTH": True,
                             "contractMonth": None})

    def test_duration_bounds(self):
        ok = [("1 day", "1 Y"), ("1 day", "12 M"), ("1 day", "365 D"), ("1 day", "2 Y"), ("1 day", "30 Y"),
              ("5 mins", "1 M"), ("1 hour", "4 W"), ("1 min", "2 D"), ("15 mins", "31 D")]
        bad = [("1 day", "31 Y"), ("1 day", "13 M"), ("1 day", "400 D"), ("1 day", "60 W"), ("5 mins", "2 M"),
               ("1 hour", "5 W"), ("1 min", "3 D"), ("1 min", "1 W"), ("30 mins", "1 Y"), ("1 day", "0 D"),
               ("1 day", "1Y"), ("1 day", "1 S")]
        for bar, dur in ok:
            self.assertEqual(vh.validate(q(symbol="SPY", barSize=bar, duration=dur))["duration"], dur)
        for bar, dur in bad:
            with self.assertRaises(vh.BadRequest, msg=(bar, dur)):
                vh.validate(q(symbol="SPY", barSize=bar, duration=dur))

    def test_rejections(self):
        for raw in [q(symbol="SPY", secType="OPT"), q(symbol="BTC", secType="CRYPTO"), q(symbol="", secType="STK"),
                    q(symbol="SPY;rm"), q(symbol="ES", secType="CONTFUT"), q(symbol="SPY", whatToShow="BID"),
                    q(symbol="SPY", barSize="1 secs"), q(symbol="SPY", account="x"), q(symbol="SPY", useRTH="yes"),
                    q(symbol="SPY", contractMonth="202612"), {"symbol": ["SPY", "QQQ"]}]:
            with self.assertRaises(vh.BadRequest, msg=raw):
                vh.validate(raw)

    def test_futures(self):
        r = vh.validate(q(symbol="ES", secType="CONTFUT", exchange="CME"))
        self.assertEqual((r["secType"], r["exchange"]), ("CONTFUT", "CME"))
        r = vh.validate(q(symbol="ES", secType="FUT", exchange="CME", contractMonth="202612"))
        self.assertEqual(r["contractMonth"], "202612")

    def test_forex(self):
        r = vh.validate(q(symbol="eur", secType="CASH", currency="usd"))
        self.assertEqual((r["secType"], r["exchange"], r["currency"], r["whatToShow"]),
                         ("CASH", "IDEALPRO", "USD", "MIDPOINT"))
        r = vh.validate(q(symbol="USD", secType="CASH", currency="JPY", whatToShow="TRADES"))
        self.assertEqual(r["whatToShow"], "MIDPOINT")
        for fn in (vh.validate_ticks, vh.validate_depth):
            with self.assertRaises(vh.BadRequest):
                fn(q(symbol="EUR", secType="CASH"))


class BarsTest(unittest.TestCase):
    def test_times(self):
        self.assertEqual(vh.parse_bar_time("20261002"), 1790899200)
        self.assertEqual(vh.parse_bar_time("1790899200"), 1790899200)
        with self.assertRaises(ValueError):
            vh.parse_bar_time("20261002 09:30:00 US/Eastern")

    def test_bar(self):
        b = vh.to_bar("20261002", 1, 2, 0.5, 1.5, -1)
        self.assertEqual(b, {"t": 1790899200, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": None})
        self.assertEqual(vh.to_bar("1790899200", 1, 2, 0.5, 1.5, 1200)["v"], 1200.0)

    def test_scrub(self):
        self.assertEqual(vh.scrub("acct U1234567 and DU7654321"), "acct [account] and [account]")
        self.assertEqual(len(vh.scrub("x" * 500)), 200)


class PacerTest(unittest.TestCase):
    def test_min_interval_and_burst(self):
        c = Clock()
        p = vh.Pacer(c)
        self.assertEqual(p.wait_for("a"), 0)
        p.record("a")
        self.assertEqual(p.wait_for("b"), 10)
        for i in range(5):
            c.sleep(p.wait_for("k%d" % i))
            p.record("k%d" % i)
        # six requests in 50 s; the seventh waits until the first leaves the 120 s window
        self.assertEqual(c.t - 1_800_000_000.0, 50)
        self.assertEqual(p.wait_for("z"), 70)

    def test_identical_window(self):
        c = Clock()
        p = vh.Pacer(c)
        p.record("a")
        c.sleep(11)
        self.assertEqual(p.wait_for("b"), 0)
        self.assertEqual(p.wait_for("a"), 4)

    def test_backoff(self):
        c = Clock()
        p = vh.Pacer(c)
        p.violation()
        self.assertEqual(p.wait_for("a"), 600)
        c.sleep(600)
        self.assertEqual(p.wait_for("a"), 0)
        self.assertEqual(p.snapshot(), {"recent_requests": 0, "backoff_seconds": 0})


class FakeGateway:
    def __init__(self, outcomes=None):
        self.calls = []
        self.outcomes = list(outcomes or [])

    def connected(self):
        return False

    def fetch(self, req, on_send):
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, vh.IbError) and outcome.kind == "unavailable":
            raise outcome
        on_send()
        self.calls.append(req)
        if isinstance(outcome, Exception):
            raise outcome
        return {"conId": 756733, "localSymbol": req["symbol"]}, [vh.to_bar("20261001", 1, 2, 0.5, 1.5, 10),
                                                                  vh.to_bar("20261002", 1.5, 2, 1, 1.8, 12)]

    def _outcome(self):
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def fetch_ticks(self, req, pace, remaining=None):
        outcome = self.outcomes[0] if self.outcomes else None
        if isinstance(outcome, vh.IbError) and outcome.kind == "unavailable":
            self.outcomes.pop(0)
            raise outcome
        pace("TRADES")
        if req["quotes"]:
            pace("BID_ASK")
        self.calls.append(req)
        self._outcome()
        trades = [{"t": 1790899200, "p": 1.5, "s": 100.0, "x": "ARCA", "c": None},
                  {"t": 1790899201, "p": 1.51, "s": 200.0, "x": None, "c": "T"}]
        quotes = [{"t": 1790899200, "bp": 1.49, "bs": 3.0, "ap": 1.51, "as": 4.0}] if req["quotes"] else []
        return {"conId": 756733, "localSymbol": req["symbol"]}, trades, quotes, 0.01

    def fetch_news(self, req, remaining=None):
        self.calls.append(req)
        self._outcome()
        return ({"conId": 756733, "localSymbol": req["symbol"]}, [{"code": "BRFG", "name": "Briefing.com"}],
                [{"t": 1790899300, "time": "2026-10-02T00:01:40Z", "provider": "BRFG", "articleId": "BRFG$1",
                  "headline": "SPY gains"}])

    def fetch_option_chain(self, req, remaining=None):
        self.calls.append(req)
        self._outcome()
        return {"expirations": ["20270115", "20270122"], "expiry": req["expiry"] or "20270115", "tradingClass": "SPY",
                "multiplier": "100",
                "underlying": {"bid": 600.1, "ask": 600.14, "last": 600.12, "close": 598.0, "price": 600.12,
                               "dataType": "live"},
                "quotes": [{"strike": 600.0, "right": "C", "bid": 4.1, "ask": 4.15, "last": 4.12, "dataType": "live",
                            "error": None},
                           {"strike": 600.0, "right": "P", "bid": None, "ask": None, "last": None, "dataType": None,
                            "error": "timeout"}]}

    def fetch_depth(self, req, on_send, remaining=None):
        outcome = self.outcomes[0] if self.outcomes else None
        if isinstance(outcome, vh.IbError) and outcome.kind == "unavailable":
            self.outcomes.pop(0)
            raise outcome
        on_send()
        self.calls.append(req)
        self._outcome()
        return {"conId": 756733, "localSymbol": req["symbol"]}, {
            "minTick": 0.01, "bids": [{"price": 1.49, "size": 3.0, "venue": "ARCA"}], "asks": [{"price": 1.51, "size": 4.0, "venue": None}],
            "sizeMultiplier": 100, "venues": {"depth": ["ARCA"], "top": [], "missing": []}, "updates": 7}


def make_service(outcomes=None, **kw):
    c = Clock()
    gw = FakeGateway(outcomes)
    cache = vh.DiskCache(tempfile.mkdtemp(prefix="vx-hist-"), clock=c)
    svc = vh.HistoryService(gw, cache, vh.Pacer(c), clock=c, sleep=c.sleep, **kw)
    return svc, gw, c


class ServiceTest(unittest.TestCase):
    def test_fetch_then_cache(self):
        svc, gw, c = make_service()
        status, body = svc.bars(q(symbol="SPY"))
        self.assertEqual(status, 200)
        self.assertEqual(body["schema"], "vertex-history-bars-v1")
        self.assertEqual(body["source"], "ibkr-gateway")
        self.assertEqual(body["client_id"], 77)
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["as_of"], "2026-10-02T00:00:00Z")
        self.assertEqual(body["cache"], {"hit": False, "age_seconds": 0, "ttl_seconds": 3600, "stale": False})
        c.sleep(100)
        status, body = svc.bars(q(symbol="SPY"))
        self.assertEqual((status, body["cache"]["hit"], body["cache"]["age_seconds"]), (200, True, 100))
        self.assertEqual(len(gw.calls), 1)
        c.sleep(3600)
        self.assertEqual(svc.bars(q(symbol="SPY"))[0], 200)
        self.assertEqual(len(gw.calls), 2)

    def test_waits_for_spacing(self):
        svc, gw, c = make_service()
        svc.bars(q(symbol="SPY"))
        t0 = c.t
        self.assertEqual(svc.bars(q(symbol="QQQ"))[0], 200)
        self.assertEqual(c.t - t0, 10)

    def test_paced_when_wait_exceeds_budget(self):
        svc, gw, c = make_service()
        for s in ["A", "B", "C", "D", "E", "F"]:
            self.assertEqual(svc.bars(q(symbol=s))[0], 200)
        status, body = svc.bars(q(symbol="G"))
        self.assertEqual(status, 429)
        self.assertEqual(body["error"], "paced")
        self.assertGreater(body["retry_after_seconds"], 20)
        self.assertEqual(len(gw.calls), 6)

    def test_pacing_violation_backs_off_and_serves_stale(self):
        svc, gw, c = make_service([None, vh.PacingViolation()])
        svc.bars(q(symbol="SPY"))
        c.sleep(4000)
        status, body = svc.bars(q(symbol="SPY"))
        self.assertEqual(status, 200)
        self.assertTrue(body["cache"]["stale"])
        self.assertEqual(svc.pacer.snapshot()["backoff_seconds"], 600)
        status, body = svc.bars(q(symbol="QQQ"))
        self.assertEqual((status, body["error"]), (429, "paced"))
        self.assertEqual(len(gw.calls), 2)

    def test_ib_errors(self):
        svc, gw, c = make_service([vh.IbError("entitlement", "No market data permissions U1234567", 354)])
        status, body = svc.bars(q(symbol="ES", secType="CONTFUT", exchange="CME"))
        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": "entitlement", "message": "No market data permissions [account]",
                                "ibkr_code": 354})
        svc, gw, c = make_service([vh.IbError("no_contract", "No security definition", 200)])
        self.assertEqual(svc.bars(q(symbol="ZZZZ"))[0], 422)
        svc, gw, c = make_service([vh.IbError("unavailable", "down")])
        self.assertEqual(svc.bars(q(symbol="SPY"))[0], 503)

    def test_bad_request(self):
        svc, gw, c = make_service()
        self.assertEqual(svc.bars(q(symbol="SPY", duration="35 Y"))[0], 400)
        self.assertEqual(gw.calls, [])


class GatewayErrorMappingTest(unittest.TestCase):
    def holder(self, gw, rid):
        h = vh._Holder()
        gw.holders[rid] = h
        return h

    def test_mapping(self):
        gw = vh.IbGateway("/nonexistent")
        h = self.holder(gw, 1)
        gw.on_error(-1, 2104, "Market data farm connection is OK")
        self.assertFalse(h.done.is_set())
        gw.on_error(1, 162, "Historical Market Data Service error message:Historical data request pacing violation")
        self.assertIsInstance(h.error, vh.PacingViolation)
        h = self.holder(gw, 2)
        gw.on_error(2, 162, "Historical Market Data Service error message:HMDS query returned no data: ESZ6")
        self.assertTrue(h.done.is_set())
        self.assertIsNone(h.error)
        h = self.holder(gw, 3)
        gw.on_error(3, 162, "Historical Market Data Service error message:No market data permissions for CME FUT")
        self.assertEqual(h.error.kind, "entitlement")
        h = self.holder(gw, 4)
        gw.on_error(4, 200, "No security definition has been found for the request")
        self.assertEqual(h.error.kind, "no_contract")
        h = self.holder(gw, 5)
        gw.on_error(-1, 326, "Unable to connect as the client id is already in use")
        self.assertEqual(h.error.kind, "unavailable")


class ValidateTicksDepthTest(unittest.TestCase):
    def test_ticks_defaults_and_bounds(self):
        r = vh.validate_ticks(q(symbol="spy"))
        self.assertEqual(r, {"symbol": "SPY", "secType": "STK", "exchange": "SMART", "currency": "USD",
                             "contractMonth": None, "count": 500, "useRTH": False, "quotes": True})
        for count in ("50", "1000"):
            self.assertEqual(vh.validate_ticks(q(symbol="SPY", count=count))["count"], int(count))
        for count in ("49", "1001", "0", "-5", "5e2", "abc", "", "10000"):
            with self.assertRaises(vh.BadRequest, msg=count):
                vh.validate_ticks(q(symbol="SPY", count=count))
        r = vh.validate_ticks(q(symbol="SPY", useRTH="1", quotes="0"))
        self.assertEqual((r["useRTH"], r["quotes"]), (True, False))

    def test_ticks_rejections(self):
        for raw in [q(symbol="ES", secType="FUT"), q(symbol="SPY", contractMonth="202612"),
                    q(symbol="ES", secType="CONTFUT", exchange="CME", contractMonth="202612"),
                    q(symbol="SPY", quotes="yes"), q(symbol="SPY", useRTH="true"), q(symbol="SPY", barSize="1 min"),
                    q(symbol="SPY", rows="5"), q(symbol="SPY", account="x"), {"symbol": ["SPY"], "count": ["50", "60"]}]:
            with self.assertRaises(vh.BadRequest, msg=raw):
                vh.validate_ticks(raw)
        r = vh.validate_ticks(q(symbol="ES", secType="FUT", exchange="CME", contractMonth="202612"))
        self.assertEqual((r["exchange"], r["contractMonth"]), ("CME", "202612"))

    def test_depth(self):
        r = vh.validate_depth(q(symbol="spy", exchange="ARCA"))
        self.assertEqual(r, {"symbol": "SPY", "secType": "STK", "exchange": "SMART", "currency": "USD",
                             "contractMonth": None, "rows": 10, "smartDepth": True})
        r = vh.validate_depth(q(symbol="ES", secType="CONTFUT", exchange="cme", rows="20"))
        self.assertEqual((r["exchange"], r["rows"], r["smartDepth"]), ("CME", 20, False))
        self.assertEqual(vh.validate_depth(q(symbol="SPY", rows="1"))["rows"], 1)
        for raw in [q(symbol="SPY", rows="0"), q(symbol="SPY", rows="21"), q(symbol="SPY", rows="x"),
                    q(symbol="ES", secType="FUT"), q(symbol="SPY", contractMonth="202612"), q(symbol="SPY", count="50")]:
            with self.assertRaises(vh.BadRequest, msg=raw):
                vh.validate_depth(raw)


def last_tick(t, price, size, exchange="", cond=""):
    return types.SimpleNamespace(time=t, price=price, size=size, exchange=exchange, specialConditions=cond)


def bidask_tick(t, bp, bs, ap, a_s):
    return types.SimpleNamespace(time=t, priceBid=bp, sizeBid=bs, priceAsk=ap, sizeAsk=a_s)


class TicksConversionTest(unittest.TestCase):
    def test_trades_and_quotes(self):
        self.assertEqual(vh.to_trade(last_tick(10, 1.5, 100, "ARCA", "")),
                         {"t": 10, "p": 1.5, "s": 100.0, "x": "ARCA", "c": None})
        self.assertEqual(vh.to_trade(last_tick(10, 1.5, -1, "", "T I"))["s"], 0.0)
        self.assertEqual(vh.to_trade(last_tick(10, 1.5, 1, "", "U1234567"))["c"], "[account]")
        self.assertEqual(vh.to_quote(bidask_tick(11, 1.49, 3, 1.51, 4)),
                         {"t": 11, "bp": 1.49, "bs": 3.0, "ap": 1.51, "as": 4.0})

    def test_oldest_first_capped_and_malformed_dropped(self):
        rows = [last_tick(t, 1.0, 1) for t in (5, 3, 4, 1, 2)] + [last_tick(6, float("nan"), 1), object()]
        out = vh.convert_ticks(rows, vh.to_trade, 3)
        self.assertEqual([r["t"] for r in out], [3, 4, 5])
        many = [last_tick(t, 1.0, 1) for t in range(1500)]
        self.assertEqual(len(vh.convert_ticks(many, vh.to_trade, vh.TICKS_MAX)), 1000)


class DepthBookTest(unittest.TestCase):
    def test_insert_update_delete_by_position_per_side(self):
        b = vh.DepthBook()
        b.apply(0, 0, 1, 100.0, 5, None)   # bid insert
        b.apply(1, 0, 1, 99.5, 7, None)
        b.apply(0, 0, 1, 100.25, 2, None)  # new best bid pushes the others down
        b.apply(0, 0, 0, 100.5, 3, "NSDQ")  # ask insert
        b.apply(1, 0, 0, 100.75, 9, "ARCA")
        b.apply(1, 1, 1, 100.0, 50, None)  # update bid at position 1
        b.apply(0, 2, 0, 0, 0, None)       # delete best ask
        b.apply(9, 2, 0, 0, 0, None)       # delete out of range: ignored
        b.apply(0, 0, 7, 1, 1, None)       # unknown side: ignored
        b.apply(0, 5, 1, 1, 1, None)       # unknown operation: ignored
        bids, asks, updates = b.snapshot(10)
        self.assertEqual([(l["price"], l["size"]) for l in bids], [(100.25, 2.0), (100.0, 50.0), (99.5, 7.0)])
        self.assertEqual(asks, [{"price": 100.75, "size": 9.0, "venue": "ARCA"}])
        self.assertEqual(updates, 8)
        self.assertEqual(len(b.snapshot(2)[0]), 2)
        b.apply(5, 1, 0, 101.0, 1, None)   # update beyond the end appends
        self.assertEqual(len(b.snapshot(10)[1]), 2)
        b.reset()
        self.assertEqual(b.snapshot(10)[:2], ([], []))

    def test_snapshot_is_best_first(self):
        b = vh.DepthBook()
        for pos, price in enumerate([99.0, 100.0, 98.0]):
            b.apply(pos, 0, 1, price, 1, None)
            b.apply(pos, 0, 0, price + 5, 1, None)
        bids, asks, _ = b.snapshot(10)
        self.assertEqual([l["price"] for l in bids], [100.0, 99.0, 98.0])
        self.assertEqual([l["price"] for l in asks], [103.0, 104.0, 105.0])


class DepthNoticeTest(unittest.TestCase):
    def test_parse_2152(self):
        text = ("Exchanges - Depth: IEX; ARCA; Top: BYX; EDGEA; PSX; Need additional market data permissions - "
                "Depth: ISLAND; BATS; NYSE;")
        self.assertEqual(vh.parse_depth_notice(text), {"depth": ["IEX", "ARCA"], "top": ["BYX", "EDGEA", "PSX"],
                                                       "missing": ["ISLAND", "BATS", "NYSE"]})
        self.assertEqual(vh.parse_depth_notice("Exchanges - Depth: CME;"), {"depth": ["CME"], "top": [], "missing": []})
        self.assertEqual(vh.parse_depth_notice("Missing: AMEX; U1234567; bad venue!"),
                         {"depth": [], "top": [], "missing": ["AMEX"]})

    def test_unknown_format_is_null(self):
        for text in ("", "Market depth data is available", None, "ARCA; ISLAND"):
            self.assertIsNone(vh.parse_depth_notice(text), text)

    def test_caps(self):
        venues = vh.parse_depth_notice("Exchanges - Depth: " + "; ".join("V%d" % i for i in range(100)))
        self.assertEqual(len(venues["depth"]), 40)


class FakeIbClient:
    """Stands in for EClient: answers contract details and replays scripted market data callbacks."""

    def __init__(self, gw, md_mult=100, depth_script=None, ticks=None, depth_raises=None, min_tick=0.01,
                 slow=None, bars=None, providers=None, news=None, sec_def=None, quotes=None):
        self.gw, self.md_mult, self.min_tick = gw, md_mult, min_tick
        self.slow = slow or {}  # call name -> (fake seconds it takes, answers at all)
        self.depth_script = depth_script or []
        self.ticks = ticks or {}
        self.bars = bars or []  # BarData-like rows answered to reqHistoricalData
        self.providers = providers if providers is not None else []  # NewsProvider-like objects
        self.news = news or []  # (time, providerCode, articleId, headline) rows, or (code, message) error
        self.depth_raises = depth_raises
        # securityDefinitionOptionParameter rows (exchange, tradingClass, multiplier, expirations, strikes)
        self.sec_def = sec_def if sec_def is not None else []
        # "STK" or (strike, right) -> {tickType: price, "md": marketDataType} | (code, message) | "silent" | an
        # Exception (raised by the send); a key that is missing answers self.default_quote. Extra dict keys:
        # "warn": (code, message) sent before the ticks, "warn_late": the same after them, "end": False = no
        # tickSnapshotEnd
        self.quotes = quotes or {}
        self.default_quote = {1: 1.0, 2: 1.2, 4: 1.1, "md": 1}
        self.calls = []

    def reqSecDefOptParams(self, rid, symbol, fut_fop_exchange, sec_type, con_id):
        self.calls.append(("reqSecDefOptParams", rid, symbol, fut_fop_exchange, sec_type, con_id))
        if self._slow("reqSecDefOptParams"):
            return
        if isinstance(self.sec_def, tuple):
            return self.gw.on_error(rid, *self.sec_def)
        for row in self.sec_def:
            self.gw.add_row(rid, row)
        self.gw.finish(rid)

    def reqMktData(self, rid, spec, generic_ticks, snapshot, regulatory, options):
        key = "STK" if spec.secType == "STK" else (spec.strike, spec.right)
        self.calls.append(("reqMktData", rid, generic_ticks, snapshot, regulatory, options, spec.secType, key,
                           spec.lastTradeDateOrContractMonth, getattr(spec, "multiplier", None),
                           getattr(spec, "tradingClass", None), spec.exchange, spec.currency, spec.conId))
        if self._slow("reqMktData"):
            return
        script = self.quotes.get(key, self.default_quote)
        if isinstance(script, Exception):
            raise script
        if script == "silent":
            return
        if isinstance(script, tuple):
            return self.gw.on_error(rid, *script)
        if "warn" in script:
            self.gw.on_error(rid, *script["warn"])
        if "md" in script:
            self.gw.market_data_type(rid, script["md"])
        for tick_type, price in script.items():
            if isinstance(tick_type, int):
                self.gw.tick_price(rid, tick_type, price)
        if "warn_late" in script:
            self.gw.on_error(rid, *script["warn_late"])
        if script.get("end", True):
            self.gw.snapshot_end(rid)  # tickSnapshotEnd

    def cancelMktData(self, rid):
        self.calls.append(("cancelMktData", rid))

    def reqContractDetails(self, rid, spec):
        self.calls.append(("reqContractDetails", rid))
        if self._slow("reqContractDetails"):
            return
        contract = types.SimpleNamespace(conId=4242, secType=spec.secType, localSymbol=spec.symbol + "Z6",
                                         exchange=spec.exchange, currency=spec.currency,
                                         lastTradeDateOrContractMonth="20261218" if spec.secType != "STK" else "",
                                         multiplier="50" if spec.secType != "STK" else "")
        details = types.SimpleNamespace(contract=contract, longName="Test", timeZoneId="US/Central")
        if self.md_mult is not None:
            details.mdSizeMultiplier = self.md_mult
        if self.min_tick is not None:
            details.minTick = self.min_tick
        self.gw.add_row(rid, details)
        self.gw.finish(rid)

    def reqHistoricalTicks(self, rid, spec, start, end, n, what, rth, ignore_size, options):
        self.calls.append(("reqHistoricalTicks", rid, start, end, n, what, rth, ignore_size, options,
                           spec.secType, spec.conId))
        if self._slow("reqHistoricalTicks"):
            return
        batches = self.ticks.get(what, [])
        if isinstance(batches, tuple):  # (code, message): an IB error instead of data
            return self.gw.on_error(rid, *batches)
        for i, batch in enumerate(batches or [[]]):  # no script: an empty, finished answer
            self.gw.add_ticks(rid, batch, i == len(batches) - 1 if batches else True)

    def reqMktDepth(self, rid, spec, rows, smart, options):
        self.calls.append(("reqMktDepth", rid, rows, smart, options, spec.exchange, spec.secType, spec.conId))
        if self.depth_raises:
            raise self.depth_raises
        for event in self.depth_script:
            if event[0] == "L1":
                self.gw.depth_update(rid, *event[1:], None)
            elif event[0] == "L2":  # same argument order as updateMktDepthL2
                position, market_maker, operation, side, price, size = event[1:]
                self.gw.depth_update(rid, position, operation, side, price, size, market_maker)
            else:
                code, message, own_id = event[1:]
                self.gw.on_error(rid if own_id else -1, code, message)

    def _slow(self, name):
        """Advance the gateway's fake clock; True when this call never answers."""
        seconds, answers = self.slow.get(name, (0, True))
        self.gw.clock.sleep(seconds)
        return not answers

    def cancelMktDepth(self, rid, smart):
        self.calls.append(("cancelMktDepth", rid, smart))

    def reqNewsProviders(self):
        self.calls.append(("reqNewsProviders",))
        self.gw.add_providers(self.providers)

    def reqHistoricalNews(self, rid, con_id, codes, start, end, total, options):
        self.calls.append(("reqHistoricalNews", rid, con_id, codes, start, end, total, options))
        if isinstance(self.news, tuple):
            return self.gw.on_error(rid, *self.news)
        for row in self.news:
            self.gw.add_row(rid, row)
        self.gw.finish(rid)

    def reqHistoricalData(self, rid, spec, end, duration, bar_size, what, rth, date_format, keep_up, options):
        self.calls.append(("reqHistoricalData", rid, end, duration, bar_size, what, rth, date_format, keep_up,
                           options, spec.secType, spec.conId))
        for bar in self.bars:
            self.gw.add_row(rid, bar)
        self.gw.finish(rid)


def fake_gateway(**kw):
    gw = vh.IbGateway("/nonexistent", clock=Clock())
    gw._connect = lambda: None
    gw._spec = lambda req: types.SimpleNamespace(symbol=req["symbol"], secType=req["secType"],
                                                 exchange=req["exchange"], currency=req["currency"],
                                                 lastTradeDateOrContractMonth=req.get("contractMonth") or "",
                                                 conId=0)
    gw.depth_collect = 0.05
    gw.snapshot_wait = 0.05
    gw.underlying_wait = 0.05
    # the message limiter on the fake clock of the gateway: its sleep moves that clock, as real time does

    def pause(seconds):
        gw.limiter_sleeps.append(seconds)
        gw.clock.sleep(seconds)

    gw.limiter_sleeps = []
    gw.option_limiter = vh.MessageLimiter(vh.OPTION_MESSAGES_PER_SECOND, clock=gw.clock, sleep=pause)
    gw._client = FakeIbClient(gw, **kw)
    return gw


class GatewayDepthTest(unittest.TestCase):
    def test_smart_depth_book_notice_and_cancel(self):
        script = [("L2", 0, "ARCA", 0, 1, 100.0, 3), ("L2", 0, "NSDQ", 0, 0, 100.1, 4),
                  ("L2", 1, "BATS", 0, 1, 99.9, 6), ("L2", 0, "IEX", 1, 1, 100.0, 5),
                  ("err", 2152, "Exchanges - Depth: ARCA; Top: BYX; Need additional market data permissions - Depth: "
                                "ISLAND;", False),
                  ("err", 2176, "fractional share size rules", True)]
        gw = fake_gateway(depth_script=script)
        sent = []
        info, book = gw.fetch_depth(vh.validate_depth(q(symbol="SPY", rows="1")), lambda: sent.append(1))
        self.assertEqual(sent, [1])
        self.assertEqual(info["conId"], 4242)
        self.assertEqual(book["bids"], [{"price": 100.0, "size": 5.0, "venue": "IEX"}])  # top 1, best first
        self.assertEqual(book["asks"], [{"price": 100.1, "size": 4.0, "venue": "NSDQ"}])
        self.assertEqual((book["sizeMultiplier"], book["updates"]), (100, 4))
        self.assertEqual(book["venues"], {"depth": ["ARCA"], "top": ["BYX"], "missing": ["ISLAND"]})
        calls = gw._client.calls
        req_call = [c for c in calls if c[0] == "reqMktDepth"][0]
        self.assertEqual(req_call[2:], (1, True, [], "SMART", "STK", 4242))
        self.assertEqual(calls[-1], ("cancelMktDepth", req_call[1], True))
        self.assertEqual(gw.holders, {})
        self.assertIsNone(gw.active_depth)

    def test_futures_use_the_exchange_book(self):
        gw = fake_gateway(md_mult=0, depth_script=[("L1", 0, 0, 1, 6000.25, 12), ("L1", 0, 0, 0, 6000.5, 9)])
        info, book = gw.fetch_depth(vh.validate_depth(q(symbol="ES", secType="CONTFUT", exchange="CME")), lambda: None)
        self.assertEqual(book["sizeMultiplier"], 1)  # mdSizeMultiplier 0 -> 1
        self.assertIsNone(book["venues"])
        self.assertEqual(book["bids"], [{"price": 6000.25, "size": 12.0, "venue": None}])
        req_call = [c for c in gw._client.calls if c[0] == "reqMktDepth"][0]
        self.assertEqual(req_call[3:], (False, [], "CME", "FUT", 4242))  # CONTFUT -> front month by conId
        self.assertEqual(gw._client.calls[-1], ("cancelMktDepth", req_call[1], False))
        gw = fake_gateway(md_mult=None)
        self.assertEqual(gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)[1]["sizeMultiplier"], 1)

    def test_cancel_even_when_the_request_raises(self):
        gw = fake_gateway(depth_raises=ConnectionError("socket"))
        with self.assertRaises(ConnectionError):
            gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)
        self.assertEqual(gw._client.calls[-1][0], "cancelMktDepth")
        self.assertEqual(gw.holders, {})

    def test_entitlement_without_levels(self):
        for code in (10092, 10089):
            gw = fake_gateway(depth_script=[("err", code, "Deep market data is not supported", True)])
            with self.assertRaises(vh.IbError) as ctx:
                gw.fetch_depth(vh.validate_depth(q(symbol="ES", secType="FUT", exchange="CME")), lambda: None)
            self.assertEqual((ctx.exception.kind, ctx.exception.code), ("entitlement", code))
            self.assertEqual(gw._client.calls[-1][0], "cancelMktDepth")

    def test_levels_win_over_a_late_entitlement_error(self):
        gw = fake_gateway(depth_script=[("L2", 0, "IEX", 0, 1, 10.0, 1), ("L2", 0, "IEX", 0, 0, 10.1, 1),
                                        ("err", 10092, "Deep market data is not supported", True)])
        info, book = gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)
        self.assertEqual((len(book["bids"]), len(book["asks"])), (1, 1))

    def test_one_sided_book_with_an_error_raises(self):
        gw = fake_gateway(depth_script=[("L2", 0, "IEX", 0, 1, 10.0, 1),
                                        ("err", 10092, "Deep market data is not supported", True)])
        with self.assertRaises(vh.IbError) as ctx:
            gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)
        self.assertEqual((ctx.exception.kind, ctx.exception.code), ("entitlement", 10092))
        gw = fake_gateway(depth_script=[("L1", 0, 0, 0, 10.1, 1), ("err", 10225, "Bust event occurred", True)])
        with self.assertRaises(vh.IbError) as ctx:
            gw.fetch_depth(vh.validate_depth(q(symbol="ES", secType="FUT", exchange="CME")), lambda: None)
        self.assertEqual(ctx.exception.kind, "ibkr_error")
        gw = fake_gateway(depth_script=[("err", 2104, "Market data farm connection is OK", True)])
        info, book = gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)  # informational only
        self.assertEqual((book["bids"], book["asks"]), ([], []))

    def test_min_tick_from_contract_details(self):
        self.assertEqual(fake_gateway().fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)[1]["minTick"], 0.01)
        for absent in (None, 0):
            gw = fake_gateway(min_tick=absent)
            self.assertIsNone(gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)[1]["minTick"])
        self.assertEqual(fake_gateway(min_tick=0.25).fetch_ticks(vh.validate_ticks(q(symbol="SPY")), lambda w: None)[3], 0.25)

    def test_reset_empties_the_book(self):
        gw = fake_gateway(depth_script=[("L1", 0, 0, 1, 10.0, 1), ("err", 317, "Market depth data has been RESET", True),
                                        ("L1", 0, 0, 1, 11.0, 2)])
        info, book = gw.fetch_depth(vh.validate_depth(q(symbol="ES", secType="FUT", exchange="CME")), lambda: None)
        self.assertEqual(book["bids"], [{"price": 11.0, "size": 2.0, "venue": None}])

    def test_updates_after_cancel_are_ignored(self):
        gw = fake_gateway()
        gw.fetch_depth(vh.validate_depth(q(symbol="SPY")), lambda: None)
        rid = gw._client.calls[-1][1]
        gw.depth_update(rid, 0, 0, 1, 1.0, 1, None)  # no holder any more: no error
        gw.on_error(-1, 2152, "Exchanges - Depth: IEX;")


class GatewayTicksTest(unittest.TestCase):
    def test_trades_then_quotes_same_window(self):
        trades = [[last_tick(3, 10.0, 100, "ARCA"), last_tick(1, 9.9, 50, "")], [last_tick(2, 9.95, 10, "IEX")]]
        quotes = [[bidask_tick(1, 9.9, 1, 10.0, 2)]]
        gw = fake_gateway(ticks={"TRADES": trades, "BID_ASK": quotes})
        paced = []
        info, t, qt, _ = gw.fetch_ticks(vh.validate_ticks(q(symbol="SPY", count="50")), paced.append)
        self.assertEqual(paced, ["TRADES", "BID_ASK"])
        self.assertEqual([x["t"] for x in t], [1, 2, 3])  # oldest first across batches
        self.assertEqual(t[0]["x"], None)
        self.assertEqual(qt, [{"t": 1, "bp": 9.9, "bs": 1.0, "ap": 10.0, "as": 2.0}])
        tick_calls = [c for c in gw._client.calls if c[0] == "reqHistoricalTicks"]
        self.assertEqual(len(tick_calls), 2)
        for call, what in zip(tick_calls, ("TRADES", "BID_ASK")):
            _, _, start, end, n, w, rth, ignore_size, options, sec, con = call
            self.assertEqual((start, n, w, rth, ignore_size, options, sec, con), ("", 50, what, 0, True, [], "STK", 4242))
            self.assertRegex(end, r"^\d{8} \d{2}:\d{2}:\d{2} UTC$")
        self.assertEqual(tick_calls[0][3], tick_calls[1][3])

    def test_no_quotes_rth_futures_and_no_data(self):
        gw = fake_gateway(ticks={"TRADES": (162, "Historical Market Data Service error message:HMDS query returned "
                                                 "no data: ESZ6")})
        paced = []
        info, t, qt, _ = gw.fetch_ticks(vh.validate_ticks(q(symbol="ES", secType="FUT", exchange="CME", useRTH="1",
                                                         quotes="0")), paced.append)
        self.assertEqual((t, qt, paced), ([], [], ["TRADES"]))
        call = [c for c in gw._client.calls if c[0] == "reqHistoricalTicks"][0]
        self.assertEqual((call[6], call[9]), (1, "FUT"))

    def test_entitlement_and_pacing(self):
        gw = fake_gateway(ticks={"TRADES": (10089, "Requested market data requires additional subscription for API")})
        with self.assertRaises(vh.IbError) as ctx:
            gw.fetch_ticks(vh.validate_ticks(q(symbol="SPY")), lambda what: None)
        self.assertEqual(ctx.exception.kind, "entitlement")
        gw = fake_gateway(ticks={"TRADES": (162, "Historical Market Data Service error message:Historical data "
                                                 "request pacing violation")})
        with self.assertRaises(vh.PacingViolation):
            gw.fetch_ticks(vh.validate_ticks(q(symbol="SPY")), lambda what: None)
        gw = fake_gateway()

        def refuse(what):
            raise vh.Paced(9)

        with self.assertRaises(vh.Paced):
            gw.fetch_ticks(vh.validate_ticks(q(symbol="SPY")), refuse)
        self.assertEqual(gw.holders, {})
        self.assertFalse(any(c[0] == "reqHistoricalTicks" for c in gw._client.calls))


class TicksServiceTest(unittest.TestCase):
    def test_fetch_spacing_and_cache(self):
        svc, gw, c = make_service()
        t0 = c.t
        status, body = svc.ticks(q(symbol="SPY", count="50"))
        self.assertEqual(status, 200)
        self.assertEqual((body["schema"], body["source"], body["client_id"]), ("vertex-history-ticks-v1", "ibkr-gateway", 77))
        self.assertEqual(c.t - t0, 10)  # BID_ASK waits the 10 s historical spacing after TRADES
        self.assertEqual(svc.pacer.snapshot()["recent_requests"], 2)
        self.assertEqual(body["asOf"], "2026-10-02T00:00:01Z")
        self.assertEqual(body["cache"], {"hit": False, "ageSeconds": 0, "ttlSeconds": 15, "stale": False})
        self.assertEqual(set(body), {"schema", "source", "client_id", "request", "contract", "minTick", "trades",
                                     "quotes", "fetchedAt", "asOf", "cache"})
        c.sleep(14)
        self.assertEqual(svc.ticks(q(symbol="SPY", count="50"))[1]["cache"]["hit"], True)
        c.sleep(2)
        self.assertEqual(svc.ticks(q(symbol="SPY", count="50"))[1]["cache"]["hit"], False)
        self.assertEqual(len(gw.calls), 2)
        status, body = svc.ticks(q(symbol="SPY", count="50", quotes="0"))
        self.assertEqual((status, body["quotes"]), (200, []))

    def test_paced_when_both_requests_do_not_fit(self):
        svc, gw, c = make_service()
        for s_ in ["A", "B", "C", "D", "E"]:
            self.assertEqual(svc.bars(q(symbol=s_))[0], 200)
        status, body = svc.ticks(q(symbol="SPY"))  # the 6th request fits, the 7th would wait ~70 s
        self.assertEqual((status, body["error"]), (429, "paced"))
        self.assertEqual(len(gw.calls), 5)

    def test_errors_map_like_bars_and_stale(self):
        svc, gw, c = make_service([vh.IbError("entitlement", "requires additional subscription U1234567", 10089)])
        status, body = svc.ticks(q(symbol="SPY"))
        self.assertEqual((status, body), (502, {"error": "entitlement", "message": "requires additional subscription "
                                                "[account]", "ibkr_code": 10089}))
        svc, gw, c = make_service([vh.IbError("no_contract", "No security definition", 200)])
        self.assertEqual(svc.ticks(q(symbol="ZZZZ"))[0], 422)
        svc, gw, c = make_service([None, vh.IbError("unavailable", "down")])
        self.assertEqual(svc.ticks(q(symbol="SPY"))[0], 200)
        c.sleep(60)
        status, body = svc.ticks(q(symbol="SPY"))
        self.assertEqual((status, body["cache"]["stale"], body["cache"]["ageSeconds"]), (200, True, 60))
        svc, gw, c = make_service([vh.IbError("timeout", "slow")])
        self.assertEqual(svc.ticks(q(symbol="SPY"))[0], 504)
        svc, gw, c = make_service([vh.PacingViolation()])
        self.assertEqual(svc.ticks(q(symbol="SPY"))[1]["error"], "pacing_violation")
        self.assertEqual(svc.pacer.snapshot()["backoff_seconds"], 600)
        self.assertEqual(svc.ticks(q(symbol="SPY", count="5"))[0], 400)


class DepthServiceTest(unittest.TestCase):
    def test_fetch_cache_and_pacer(self):
        svc, gw, c = make_service()
        status, body = svc.depth(q(symbol="SPY", rows="5"))
        self.assertEqual(status, 200)
        self.assertEqual(body["schema"], "vertex-history-depth-v1")
        self.assertEqual(body["request"]["smartDepth"], True)
        self.assertEqual(set(body), {"schema", "source", "client_id", "request", "contract", "minTick", "bids",
                                     "asks", "sizeMultiplier", "venues", "updates", "fetchedAt", "cache"})
        self.assertEqual(body["cache"], {"hit": False, "ageSeconds": 0, "ttlSeconds": 5, "stale": False})
        c.sleep(4)
        self.assertTrue(svc.depth(q(symbol="SPY", rows="5"))[1]["cache"]["hit"])
        t0 = c.t
        self.assertEqual(svc.depth(q(symbol="QQQ"))[0], 200)
        self.assertEqual(c.t, t0)  # 4 s since the last subscription: no wait
        self.assertEqual(svc.depth(q(symbol="IWM"))[0], 200)
        self.assertEqual(c.t - t0, 3)  # at least 3 s between depth subscriptions
        self.assertEqual(len(gw.calls), 3)
        self.assertEqual(svc.pacer.snapshot()["recent_requests"], 0)  # depth never uses historical pacing

    def test_errors(self):
        svc, gw, c = make_service([vh.IbError("entitlement", "Deep market data is not supported", 10092)])
        status, body = svc.depth(q(symbol="ES", secType="FUT", exchange="CME"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (502, "entitlement", 10092))
        svc, gw, c = make_service([vh.IbError("unavailable", "down")])
        self.assertEqual(svc.depth(q(symbol="SPY"))[0], 503)
        svc, gw, c = make_service()
        self.assertEqual(svc.depth(q(symbol="SPY", rows="50"))[0], 400)
        self.assertEqual(gw.calls, [])


@unittest.skipUnless(importlib.util.find_spec("ibapi"), "ibapi not installed")
class IbapiSignatureTest(unittest.TestCase):
    def test_client_and_wrapper_signatures(self):
        import inspect
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper

        def params(fn):
            return list(inspect.signature(fn).parameters)[1:]

        self.assertEqual(params(EClient.reqHistoricalTicks), ["reqId", "contract", "startDateTime", "endDateTime",
                                                             "numberOfTicks", "whatToShow", "useRth", "ignoreSize",
                                                             "miscOptions"])
        self.assertEqual(params(EClient.reqMktDepth), ["reqId", "contract", "numRows", "isSmartDepth",
                                                      "mktDepthOptions"])
        self.assertEqual(params(EClient.cancelMktDepth), ["reqId", "isSmartDepth"])
        self.assertEqual(params(EClient.reqHistoricalData), ["reqId", "contract", "endDateTime", "durationStr",
                                                            "barSizeSetting", "whatToShow", "useRTH", "formatDate",
                                                            "keepUpToDate", "chartOptions"])
        for name in vh.IbGateway.IB_CALLS:
            self.assertTrue(hasattr(EClient, name), name)
        wrapper = vh._wrapper_class()
        self.assertEqual(params(EClient.reqHistoricalNews), ["reqId", "conId", "providerCodes", "startDateTime",
                                                            "endDateTime", "totalResults", "historicalNewsOptions"])
        self.assertEqual(params(EClient.reqNewsProviders), [])
        self.assertEqual(params(EClient.reqSecDefOptParams), ["reqId", "underlyingSymbol", "futFopExchange",
                                                             "underlyingSecType", "underlyingConId"])
        self.assertEqual(params(EClient.reqMktData), ["reqId", "contract", "genericTickList", "snapshot",
                                                     "regulatorySnapshot", "mktDataOptions"])
        self.assertEqual(params(EClient.cancelMktData), ["reqId"])
        self.assertEqual(params(EWrapper.securityDefinitionOptionParameter),
                         ["reqId", "exchange", "underlyingConId", "tradingClass", "multiplier", "expirations", "strikes"])
        self.assertEqual(params(EWrapper.securityDefinitionOptionParameterEnd), ["reqId"])
        self.assertEqual(params(EWrapper.tickPrice), ["reqId", "tickType", "price", "attrib"])
        self.assertEqual(params(EWrapper.tickSnapshotEnd), ["reqId"])
        self.assertEqual(params(EWrapper.marketDataType), ["reqId", "marketDataType"])
        from ibapi.ticktype import TickTypeEnum
        self.assertEqual({TickTypeEnum.to_str(t): name for t, name in vh.PRICE_TICKS.items()},
                         {"BID": "bid", "ASK": "ask", "LAST": "last", "CLOSE": "close", "DELAYED_BID": "bid",
                          "DELAYED_ASK": "ask", "DELAYED_LAST": "last", "DELAYED_CLOSE": "close"})
        qgw = fake_gateway()
        qw = wrapper(qgw)
        defs, snap = vh._Holder(), vh.QuoteSnapshot()
        qgw.holders[7], qgw.holders[8] = defs, snap
        qw.securityDefinitionOptionParameter(7, "SMART", 4242, "SPY", "100", {"20270115"}, {600.0})
        qw.securityDefinitionOptionParameterEnd(7)
        self.assertEqual((defs.rows, defs.done.is_set()), ([("SMART", "SPY", "100", {"20270115"}, {600.0})], True))
        qw.marketDataType(8, 3)
        qw.tickPrice(8, 66, 4.1, None)
        qw.tickPrice(8, 2, 4.2, None)
        qw.tickSnapshotEnd(8)
        self.assertEqual((snap.prices["bid"], snap.prices["ask"], snap.data_type, snap.done.is_set(), snap.ended),
                         (4.1, 4.2, "delayed", True, True))
        for name in ("historicalTicksLast", "historicalTicksBidAsk", "updateMktDepth", "updateMktDepthL2",
                     "newsProviders", "historicalNews", "historicalNewsEnd", "securityDefinitionOptionParameter",
                     "securityDefinitionOptionParameterEnd", "tickPrice", "tickSnapshotEnd", "marketDataType"):
            self.assertEqual(params(getattr(wrapper, name)), params(getattr(EWrapper, name)), name)
        gw = fake_gateway()
        w = wrapper(gw)
        book = gw.holders[5] = vh.DepthBook()
        w.updateMktDepthL2(5, 0, "ARCA", 0, 1, 10.0, 3, True)
        w.updateMktDepth(5, 0, 0, 0, 10.5, 2)
        self.assertEqual(book.snapshot(5)[:2], ([{"price": 10.0, "size": 3.0, "venue": "ARCA"}],
                                                [{"price": 10.5, "size": 2.0, "venue": None}]))
        h = gw.holders[6] = vh._Holder()
        w.historicalTicksLast(6, [last_tick(1, 1.0, 1)], False)
        w.historicalTicksBidAsk(6, [bidask_tick(2, 1, 1, 2, 1)], True)
        self.assertEqual((len(h.rows), h.done.is_set()), (2, True))


def budget_service(**kw):
    """The real gateway (fake IB client) behind the service, both on one fake clock."""
    gw = fake_gateway(**kw)
    c = gw.clock
    cache = vh.DiskCache(tempfile.mkdtemp(prefix="vx-hist-"), clock=c)
    return vh.HistoryService(gw, cache, vh.Pacer(c), clock=c, sleep=c.sleep), gw, c


class RequestBudgetTest(unittest.TestCase):
    """A slow gateway never holds a request past its budget (ticks 35 s, depth 25 s)."""

    def test_ticks_budget_spent_by_a_slow_contract_lookup(self):
        svc, gw, c = budget_service(slow={"reqContractDetails": (36, True)})
        t0, wall = c.t, time.monotonic()
        status, body = svc.ticks(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (504, "timeout"))
        self.assertLessEqual(c.t - t0, vh.TICKS_DEADLINE + 1)
        self.assertLess(time.monotonic() - wall, 1.0)
        self.assertFalse(any(x[0] == "reqHistoricalTicks" for x in gw._client.calls))
        self.assertIsNone(svc.cache.get(vh.cache_key(dict(vh.validate_ticks(q(symbol="SPY")), endpoint="ticks")), 15))

    def test_ticks_wait_for_a_silent_gateway_is_the_remaining_budget(self):
        # the silent TRADES request has used 34.6 of 35 s; it may wait only the 0.4 s left, not IB_TIMEOUT
        svc, gw, c = budget_service(slow={"reqHistoricalTicks": (34.6, False)})
        wall = time.monotonic()
        status, body = svc.ticks(q(symbol="SPY", quotes="0"))
        self.assertEqual((status, body["error"]), (504, "timeout"))
        self.assertLess(time.monotonic() - wall, 2.0)
        self.assertEqual(gw.holders, {})

    def test_ticks_pacing_cannot_exceed_the_budget(self):
        svc, gw, c = budget_service(slow={"reqContractDetails": (30, True)})
        status, body = svc.ticks(q(symbol="SPY"))  # BID_ASK would start 10 s after TRADES, past 35 s
        self.assertEqual((status, body["error"]), (429, "paced"))
        self.assertEqual(len([x for x in gw._client.calls if x[0] == "reqHistoricalTicks"]), 1)

    def test_depth_budget_spent_by_a_slow_contract_lookup(self):
        svc, gw, c = budget_service(slow={"reqContractDetails": (26, True)},
                                    depth_script=[("L1", 0, 0, 1, 1.0, 1), ("L1", 0, 0, 0, 1.1, 1)])
        wall = time.monotonic()
        status, body = svc.depth(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (504, "timeout"))
        self.assertLess(time.monotonic() - wall, 1.0)
        self.assertFalse(any(x[0] == "reqMktDepth" for x in gw._client.calls))
        self.assertEqual(gw.holders, {})
        self.assertIsNone(gw.active_depth)

    def test_depth_silent_contract_lookup_waits_at_most_the_budget(self):
        svc, gw, c = budget_service(slow={"reqContractDetails": (24.7, False)})
        wall = time.monotonic()
        status, body = svc.depth(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (504, "timeout"))
        self.assertLess(time.monotonic() - wall, 2.0)

    def test_depth_error_on_an_empty_side_is_returned_and_not_cached(self):
        svc, gw, c = budget_service(depth_script=[("L2", 0, "IEX", 0, 1, 10.0, 1),
                                                  ("err", 10092, "Deep market data is not supported", True)])
        status, body = svc.depth(q(symbol="SPY"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (502, "entitlement", 10092))
        self.assertIsNone(svc.cache.get(vh.cache_key(dict(vh.validate_depth(q(symbol="SPY")), endpoint="depth")), 60))

    def test_min_tick_reaches_the_payload(self):
        svc, gw, c = budget_service(min_tick=0.25, depth_script=[("L1", 0, 0, 1, 1.0, 1), ("L1", 0, 0, 0, 1.25, 1)])
        self.assertEqual(svc.depth(q(symbol="SPY"))[1]["minTick"], 0.25)
        svc, gw, c = budget_service(min_tick=None)
        self.assertIsNone(svc.ticks(q(symbol="SPY", quotes="0"))[1]["minTick"])


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        svc, cls.gw, _ = make_service()
        cls.server = vh.ThreadingHTTPServer(("127.0.0.1", 0), vh.make_handler(svc, TOKEN))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def call(self, path, token=TOKEN, method="GET"):
        req = urllib.request.Request(self.base + path, method=method)
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            body = e.read()
            return e.code, json.loads(body) if body else None

    def test_ticks_and_depth_routes(self):
        status, body = self.call("/vertex-history/v1/ticks?symbol=SPY&count=50")
        self.assertEqual((status, body["schema"], len(body["trades"])), (200, "vertex-history-ticks-v1", 2))
        self.assertEqual(self.call("/vertex-history/v1/ticks?symbol=SPY&count=49")[0], 400)
        status, body = self.call("/vertex-history/v1/depth?symbol=SPY&rows=5")
        self.assertEqual((status, body["schema"], body["sizeMultiplier"]), (200, "vertex-history-depth-v1", 100))
        self.assertEqual(self.call("/vertex-history/v1/depth?symbol=SPY&rows=21")[0], 400)
        self.assertEqual(self.call("/vertex-history/v1/depth?symbol=SPY", token=None)[0], 401)
        self.assertEqual(self.call("/vertex-history/v1/ticks?symbol=SPY", method="POST")[0], 405)

    def test_auth_and_routes(self):
        self.assertEqual(self.call("/vertex-history/v1/health", token=None)[0], 401)
        self.assertEqual(self.call("/vertex-history/v1/health", token="wrong")[0], 401)
        status, body = self.call("/vertex-history/v1/health")
        self.assertEqual((status, body["client_id"], body["connected"]), (200, 77, False))
        self.assertEqual(self.call("/vertex-history/v1/other")[0], 404)
        self.assertEqual(self.call("/vertex-history/v1/bars?symbol=SPY", method="POST")[0], 405)
        self.assertEqual(self.call("/vertex-history/v1/bars?symbol=SPY&duration=31%20Y")[0], 400)
        status, body = self.call("/vertex-history/v1/bars?symbol=SPY&barSize=1%20day&duration=1%20Y")
        self.assertEqual((status, body["count"]), (200, 2))
        self.assertNotIn(TOKEN, json.dumps(body))
        self.assertNotIn("endDateTime", body["request"])
        status, body = self.call("/vertex-history/v1/bars?symbol=SPY&endDateTime=20261001-20:00:00")
        self.assertEqual((status, body["request"]["endDateTime"]), (200, "20261001-20:00:00"))
        for bad in ("", "20261001%2020:00:00", "20991231-00:00:00"):
            status, body = self.call("/vertex-history/v1/bars?symbol=SPY&endDateTime=" + bad)
            self.assertEqual((status, body["error"]), (400, "bad_request"), bad)
        status, body = self.call("/vertex-history/v1/bars?symbol=ES&secType=CONTFUT&exchange=CME"
                                 "&endDateTime=20261001-20:00:00")
        self.assertEqual(status, 400)
        self.assertIn("CONTFUT", body["message"])


def ib_time(ts):
    return time.strftime("%Y%m%d-%H:%M:%S", time.gmtime(ts))


NOW = Clock().t  # 2027-01-15T08:00:00Z


def bar_row(date, o, h, low, c, v):
    return types.SimpleNamespace(date=date, open=o, high=h, low=low, close=c, volume=v)


class EndDateTimeValidateTest(unittest.TestCase):
    def test_valid_end_is_normalized_into_the_request(self):
        r = vh.validate(q(symbol="spy", endDateTime="20261001-20:00:00"), now=NOW)
        self.assertEqual(r["endDateTime"], "20261001-20:00:00")
        self.assertEqual({k: v for k, v in r.items() if k != "endDateTime"}, vh.validate(q(symbol="spy"), now=NOW))
        for ok in ("19900101-00:00:00", "20240229-23:59:59", ib_time(NOW - 1), " 20261001-20:00:00 "):
            self.assertEqual(vh.validate(q(symbol="SPY", endDateTime=ok), now=NOW)["endDateTime"], ok.strip())
        r = vh.validate(q(symbol="ES", secType="FUT", exchange="CME", contractMonth="202612",
                          endDateTime="20261001-20:00:00"), now=NOW)
        self.assertEqual(r["endDateTime"], "20261001-20:00:00")
        r = vh.validate(q(symbol="EUR", secType="CASH", endDateTime="20261001-20:00:00"), now=NOW)
        self.assertEqual(r["endDateTime"], "20261001-20:00:00")

    def test_absent_param_is_unchanged(self):
        r = vh.validate(q(symbol="SPY"), now=NOW)
        self.assertNotIn("endDateTime", r)
        before = {"symbol": "SPY", "secType": "STK", "exchange": "SMART", "currency": "USD", "barSize": "1 day",
                  "duration": "1 Y", "whatToShow": "TRADES", "useRTH": True, "contractMonth": None}
        self.assertEqual(vh.cache_key(r), vh.cache_key(before))  # same key as before the parameter existed
        self.assertEqual(vh.ttl_for(r, now=NOW), 3600)

    def test_bad_format(self):
        bad = ["", "20261001 20:00:00", "20261001-20:00", "2026-10-01T20:00:00", "20261001-20:00:00 UTC",
               "20261001-20:00:00Z", "20261001-200000", "2026101-20:00:00", "20261301-00:00:00", "20260230-00:00:00",
               "20250229-00:00:00", "20261000-00:00:00", "20261001-24:00:00", "20261001-23:60:00",
               "20261001-23:59:60", "20261001-20:00:00\n1", "\uff12\uff10\uff12\uff16" + "1001-20:00:00",
               "\u0662\u0660\u0662\u0666" + "1001-20:00:00", "abcdefgh-ij:kl:mn"]
        for value in bad:
            with self.assertRaises(vh.BadRequest, msg=value):
                vh.validate(q(symbol="SPY", endDateTime=value), now=NOW)
        with self.assertRaises(vh.BadRequest):
            vh.validate({"symbol": ["SPY"], "endDateTime": ["20261001-20:00:00", "20261002-20:00:00"]}, now=NOW)
        with self.assertRaisesRegex(vh.BadRequest, "1990"):
            vh.validate(q(symbol="SPY", endDateTime="19891231-23:59:59"), now=NOW)

    def test_future_or_now_is_refused(self):
        for value in (ib_time(NOW), ib_time(NOW + 1), "20991231-23:59:59"):
            with self.assertRaisesRegex(vh.BadRequest, "past", msg=value):
                vh.validate(q(symbol="SPY", endDateTime=value), now=NOW)
        # The default clock is the real one.
        with self.assertRaises(vh.BadRequest):
            vh.validate(q(symbol="SPY", endDateTime=ib_time(time.time() + 120)))
        self.assertIn("endDateTime", vh.validate(q(symbol="SPY", endDateTime=ib_time(time.time() - 120))))

    def test_contfut_is_refused(self):
        with self.assertRaisesRegex(vh.BadRequest, "CONTFUT"):
            vh.validate(q(symbol="ES", secType="CONTFUT", exchange="CME", endDateTime="20261001-20:00:00"), now=NOW)
        self.assertNotIn("endDateTime", vh.validate(q(symbol="ES", secType="CONTFUT", exchange="CME"), now=NOW))

    def test_bars_only(self):
        for fn in (vh.validate_ticks, vh.validate_depth):
            with self.assertRaisesRegex(vh.BadRequest, "unknown parameter"):
                fn(q(symbol="SPY", endDateTime="20261001-20:00:00"))

    def test_cache_key_differs_by_end_date(self):
        keys = {vh.cache_key(vh.validate(q(symbol="SPY", **extra), now=NOW))
                for extra in ({}, {"endDateTime": "20261001-20:00:00"}, {"endDateTime": "20261001-20:00:01"},
                              {"endDateTime": "20250101-00:00:00"})}
        self.assertEqual(len(keys), 4)

    def test_ttl_for_past_ranges(self):
        def ttl(end, bar="1 day"):
            return vh.ttl_for(vh.validate(q(symbol="SPY", barSize=bar, duration="1 D", endDateTime=ib_time(end)),
                                          now=NOW), now=NOW)

        self.assertEqual(ttl(NOW - 60), 3600)  # not settled: the bar size's TTL
        self.assertEqual(ttl(NOW - 60, "1 min"), 120)
        self.assertEqual(ttl(NOW - 86400 - 600, "1 min"), 600)  # only copies fetched after settling qualify
        self.assertEqual(ttl(NOW - 3 * 86400, "1 min"), 86400)
        self.assertEqual(ttl(NOW - 30 * 86400), 86400)


class EndDateTimeGatewayTest(unittest.TestCase):
    def test_valid_end_date_is_passed_to_reqHistoricalData(self):
        gw = fake_gateway(bars=[bar_row("1790899200", 1, 2, 0.5, 1.5, 10)])
        _info, bars = gw.fetch(vh.validate(q(symbol="SPY", barSize="1 hour", duration="2 D",
                                            endDateTime="20261001-20:00:00"), now=NOW), lambda: None)
        self.assertEqual(bars, [{"t": 1790899200, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0}])
        calls = [c for c in gw._client.calls if c[0] == "reqHistoricalData"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2:], ("20261001-20:00:00", "2 D", "1 hour", "TRADES", 1, 2, False, [], "STK", 4242))

    def test_absent_end_date_is_the_empty_string(self):
        gw = fake_gateway()
        _info, bars = gw.fetch(vh.validate(q(symbol="ES", secType="CONTFUT", exchange="CME"), now=NOW), lambda: None)
        self.assertEqual(bars, [])
        call = next(c for c in gw._client.calls if c[0] == "reqHistoricalData")
        self.assertEqual((call[2], call[3], call[5]), ("", "1 Y", "TRADES"))

    def test_bid_ask_is_passed_through_with_null_volume(self):
        gw = fake_gateway(bars=[bar_row("1790899200", 9.9, 10.2, 9.8, 10.0, -1)])
        _info, bars = gw.fetch(vh.validate(q(symbol="SPY", whatToShow="bid_ask", endDateTime="20261001-20:00:00"),
                                          now=NOW), lambda: None)
        self.assertEqual(bars, [{"t": 1790899200, "o": 9.9, "h": 10.2, "l": 9.8, "c": 10.0, "v": None}])
        call = next(c for c in gw._client.calls if c[0] == "reqHistoricalData")
        self.assertEqual((call[2], call[5]), ("20261001-20:00:00", "BID_ASK"))


class BidAskValidateTest(unittest.TestCase):
    def test_stocks_only(self):
        r = vh.validate(q(symbol="SPY", whatToShow="BID_ASK", barSize="5 mins", duration="1 W"), now=NOW)
        self.assertEqual(r["whatToShow"], "BID_ASK")
        for raw in (q(symbol="EUR", secType="CASH", whatToShow="BID_ASK"),
                    q(symbol="ES", secType="CONTFUT", exchange="CME", whatToShow="BID_ASK"),
                    q(symbol="ES", secType="FUT", exchange="CME", contractMonth="202612", whatToShow="BID_ASK")):
            with self.assertRaisesRegex(vh.BadRequest, "BID_ASK", msg=raw):
                vh.validate(raw, now=NOW)
        with self.assertRaises(vh.BadRequest):  # same duration bounds as TRADES
            vh.validate(q(symbol="SPY", whatToShow="BID_ASK", barSize="1 min", duration="3 D"), now=NOW)
        self.assertNotEqual(vh.cache_key(r), vh.cache_key(dict(r, whatToShow="TRADES")))


class EndDateTimeServiceTest(unittest.TestCase):
    def test_echo_cache_separation_and_absent(self):
        svc, gw, c = make_service()
        status, body = svc.bars(q(symbol="SPY", endDateTime="20261001-20:00:00"))
        self.assertEqual((status, body["request"]["endDateTime"]), (200, "20261001-20:00:00"))
        self.assertEqual(gw.calls[-1]["endDateTime"], "20261001-20:00:00")
        self.assertEqual(body["cache"], {"hit": False, "age_seconds": 0, "ttl_seconds": 86400, "stale": False})
        c.sleep(20)
        status, body = svc.bars(q(symbol="SPY", endDateTime="20261002-20:00:00"))  # other range: not the cache
        self.assertEqual((status, body["cache"]["hit"], len(gw.calls)), (200, False, 2))
        c.sleep(20)
        status, body = svc.bars(q(symbol="SPY"))  # absent: today's behaviour, no echo
        self.assertEqual((status, body["cache"]["hit"], len(gw.calls)), (200, False, 3))
        self.assertNotIn("endDateTime", body["request"])
        self.assertNotIn("endDateTime", gw.calls[-1])
        self.assertEqual(body["cache"]["ttl_seconds"], 3600)
        c.sleep(5 * 3600)  # settled past range: still cached; the open-ended request is not
        status, body = svc.bars(q(symbol="SPY", endDateTime="20261001-20:00:00"))
        self.assertEqual((status, body["cache"]["hit"], len(gw.calls)), (200, True, 3))
        self.assertEqual(body["request"]["endDateTime"], "20261001-20:00:00")
        self.assertEqual(svc.bars(q(symbol="SPY"))[1]["cache"]["hit"], False)
        self.assertEqual(len(gw.calls), 4)

    def test_copy_fetched_before_settling_keeps_the_short_ttl(self):
        svc, gw, c = make_service()
        end = ib_time(c.t - 3600)  # one hour ago: the last bar may still change
        status, body = svc.bars(q(symbol="SPY", endDateTime=end))
        self.assertEqual((status, body["cache"]["ttl_seconds"]), (200, 3600))
        c.sleep(86400)  # now settled, but this copy predates settling
        status, body = svc.bars(q(symbol="SPY", endDateTime=end))
        self.assertEqual((status, body["cache"]["hit"], len(gw.calls)), (200, False, 2))
        c.sleep(3 * 3600)
        status, body = svc.bars(q(symbol="SPY", endDateTime=end))
        self.assertEqual((status, body["cache"]["hit"], len(gw.calls)), (200, True, 2))

    def test_bad_end_dates_are_400_without_a_request(self):
        svc, gw, c = make_service()
        for raw in (q(symbol="SPY", endDateTime="2026-10-01"), q(symbol="SPY", endDateTime=ib_time(c.t + 60)),
                    q(symbol="ES", secType="CONTFUT", exchange="CME", endDateTime="20261001-20:00:00")):
            status, body = svc.bars(raw)
            self.assertEqual((status, body["error"]), (400, "bad_request"), raw)
        self.assertEqual(gw.calls, [])


class Extend130Test(unittest.TestCase):
    """1.3.0: ADJUSTED_LAST, IND bars, daily windows up to 30 Y (card vertex-yahoo-terms-decision)."""

    def test_adjusted_last_rules(self):
        r = vh.validate(q(symbol="SPY", whatToShow="adjusted_last", duration="30 Y"), now=NOW)
        self.assertEqual((r["whatToShow"], r["duration"]), ("ADJUSTED_LAST", "30 Y"))
        self.assertNotIn("endDateTime", r)
        self.assertNotEqual(vh.cache_key(r), vh.cache_key(dict(r, whatToShow="TRADES")))
        for raw, msg in ((q(symbol="SPY", whatToShow="ADJUSTED_LAST", endDateTime="20261001-20:00:00"), "endDateTime"),
                         (q(symbol="SPY", whatToShow="ADJUSTED_LAST", barSize="1 hour", duration="2 D"), "1 day"),
                         (q(symbol="ES", secType="CONTFUT", exchange="CME", whatToShow="ADJUSTED_LAST"), "STK"),
                         (q(symbol="EUR", secType="CASH", whatToShow="ADJUSTED_LAST"), "STK"),
                         (q(symbol="VIX", secType="IND", exchange="CBOE", whatToShow="ADJUSTED_LAST"), "STK")):
            with self.assertRaisesRegex(vh.BadRequest, msg, msg=raw):
                vh.validate(raw, now=NOW)

    def test_indices_are_trades_bars_with_an_exchange(self):
        r = vh.validate(q(symbol="vix", secType="IND", exchange="cboe", duration="30 Y"), now=NOW)
        self.assertEqual((r["symbol"], r["secType"], r["exchange"], r["whatToShow"]), ("VIX", "IND", "CBOE", "TRADES"))
        r = vh.validate(q(symbol="VIX", secType="IND", exchange="CBOE", endDateTime="20101001-20:00:00"), now=NOW)
        self.assertEqual(r["endDateTime"], "20101001-20:00:00")
        with self.assertRaisesRegex(vh.BadRequest, "exchange"):
            vh.validate(q(symbol="VIX", secType="IND"), now=NOW)
        for what in ("MIDPOINT", "BID_ASK"):
            with self.assertRaises(vh.BadRequest, msg=what):
                vh.validate(q(symbol="VIX", secType="IND", exchange="CBOE", whatToShow=what), now=NOW)
        for fn, kind in ((vh.validate_ticks, "ticks"), (vh.validate_depth, "depth")):
            with self.assertRaisesRegex(vh.BadRequest, kind + " are not supported for IND"):
                fn(q(symbol="VIX", secType="IND", exchange="CBOE"))
            with self.assertRaisesRegex(vh.BadRequest, kind + " are not supported for CASH"):
                fn(q(symbol="EUR", secType="CASH"))

    def test_adjusted_last_and_index_reach_reqHistoricalData(self):
        gw = fake_gateway(bars=[bar_row("20261002", 1, 2, 0.5, 1.5, 10)])
        _info, bars = gw.fetch(vh.validate(q(symbol="SPY", whatToShow="ADJUSTED_LAST", duration="20 Y"), now=NOW),
                               lambda: None)
        self.assertEqual(bars, [{"t": 1790899200, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0}])
        call = next(c for c in gw._client.calls if c[0] == "reqHistoricalData")
        self.assertEqual((call[2], call[3], call[4], call[5]), ("", "20 Y", "1 day", "ADJUSTED_LAST"))
        gw = fake_gateway(bars=[bar_row("20261002", 20, 21, 19, 20.5, -1)])
        _info, bars = gw.fetch(vh.validate(q(symbol="VIX", secType="IND", exchange="CBOE", duration="5 Y"), now=NOW),
                               lambda: None)
        self.assertIsNone(bars[0]["v"])
        call = next(c for c in gw._client.calls if c[0] == "reqHistoricalData")
        self.assertEqual((call[3], call[5], call[-2]), ("5 Y", "TRADES", "IND"))

    def test_class_share_symbols(self):
        self.assertEqual(vh.validate(q(symbol="brk b"), now=NOW)["symbol"], "BRK B")
        for bad in ("BRK  B", "BRK BB", "BRK-B C", "BRK B1"):
            with self.assertRaises(vh.BadRequest, msg=bad):
                vh.validate({"symbol": [bad]}, now=NOW)

    def test_health_reports_1_4_0(self):
        svc, _gw, _c = make_service()
        self.assertEqual(svc.health()[1]["version"], "1.4.0")


class IbapiPinTest(unittest.TestCase):
    def test_ibapi_9_81_is_pinned(self):
        """US stock bar volume arrives in lots of 100 with ibapi 9.81; packages/api/src/server/ibkr-history.ts
        (STK_VOLUME_LOT) scales it to shares. Upgrading ibapi (10.x reports shares) must change both."""
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install-history.sh")
        if not os.path.exists(path):  # the QuantVPS install stage holds only the service and this test
            self.skipTest("install-history.sh is not next to the test")
        with open(path) as f:
            self.assertIn("ibapi-9.81.1.post1.tar.gz", f.read())


class NewsTest(unittest.TestCase):
    """1.3.0 /news: IBKR headlines for one stock from the account's API news providers."""

    def test_validate(self):
        self.assertEqual(vh.validate_news(q(symbol="aapl")),
                         {"symbol": "AAPL", "secType": "STK", "exchange": "SMART", "currency": "USD", "count": 20})
        self.assertEqual(vh.validate_news(q(symbol="AAPL", count="50"))["count"], 50)
        for raw in (q(symbol="AAPL", count="51"), q(symbol="AAPL", count="0"), q(symbol="ES", secType="FUT",
                    exchange="CME"), q(symbol="VIX", secType="IND", exchange="CBOE"), q(symbol="AAPL", barSize="1 day")):
            with self.assertRaises(vh.BadRequest, msg=raw):
                vh.validate_news(raw)

    def test_items_strip_metadata_and_skip_unreadable_rows(self):
        item = vh.to_news_item("2026-10-02 00:01:40.0", "BRFG", "BRFG$1", "{A:800015:L:en:K:n/a:C:0.9}  SPY gains ")
        self.assertEqual(item, {"t": 1790899300, "time": "2026-10-02T00:01:40Z", "provider": "BRFG",
                                "articleId": "BRFG$1", "headline": "SPY gains"})
        self.assertIsNone(vh.to_news_item("yesterday", "BRFG", "x", "text"))
        self.assertIsNone(vh.to_news_item("2026-10-02 00:01:40", "BRFG", "x", "{A:1}"))
        self.assertEqual(vh.to_news_item("2026-10-02 00:01:40", "DJ", "x", "Acct U1234567 note")["headline"],
                         "Acct [account] note")

    def test_gateway_asks_all_providers_newest_first_and_caches_providers(self):
        providers = [types.SimpleNamespace(code="BRFG", name="Briefing.com"),
                     types.SimpleNamespace(code="DJNL", name="Dow Jones Newsletters"),
                     types.SimpleNamespace(code="", name="broken")]
        rows = [("2026-10-01 12:00:00.0", "BRFG", "a1", "older"), ("2026-10-02 12:00:00.0", "DJNL", "a2", "newer"),
                ("bad", "DJNL", "a3", "dropped")]
        gw = fake_gateway(providers=providers, news=rows)
        info, got_providers, items = gw.fetch_news(vh.validate_news(q(symbol="AAPL", count="5")))
        self.assertEqual(info["conId"], 4242)
        self.assertEqual([p["code"] for p in got_providers], ["BRFG", "DJNL"])
        self.assertEqual([i["headline"] for i in items], ["newer", "older"])
        call = next(c for c in gw._client.calls if c[0] == "reqHistoricalNews")
        self.assertEqual(call[2:], (4242, "BRFG+DJNL", "", "", 5, []))
        gw.fetch_news(vh.validate_news(q(symbol="MSFT")))
        self.assertEqual(sum(1 for c in gw._client.calls if c[0] == "reqNewsProviders"), 1)

    def test_gateway_without_providers_makes_no_news_request(self):
        gw = fake_gateway(providers=[])
        _info, providers, items = gw.fetch_news(vh.validate_news(q(symbol="AAPL")))
        self.assertEqual((providers, items), ([], []))
        self.assertFalse(any(c[0] == "reqHistoricalNews" for c in gw._client.calls))

    def test_gateway_entitlement_error(self):
        gw = fake_gateway(providers=[types.SimpleNamespace(code="BRFG", name="B")], news=(10276, "News feed is not allowed"))
        with self.assertRaises(vh.IbError) as ctx:
            gw.fetch_news(vh.validate_news(q(symbol="AAPL")))
        self.assertEqual((ctx.exception.kind, ctx.exception.code), ("entitlement", 10276))

    def test_empty_provider_list_is_cached_briefly(self):
        gw = fake_gateway(providers=[])
        gw.fetch_news(vh.validate_news(q(symbol="AAPL")))
        gw.fetch_news(vh.validate_news(q(symbol="AAPL")))
        self.assertEqual(sum(1 for c in gw._client.calls if c[0] == "reqNewsProviders"), 1)
        gw.clock.sleep(vh.PROVIDERS_EMPTY_TTL + 1)
        gw._client.providers = [types.SimpleNamespace(code="BRFG", name="B")]
        _info, providers, _items = gw.fetch_news(vh.validate_news(q(symbol="AAPL")))
        self.assertEqual([p["code"] for p in providers], ["BRFG"])
        self.assertEqual(sum(1 for c in gw._client.calls if c[0] == "reqNewsProviders"), 2)

    def test_service_answers_pacing_violation_and_unexpected_errors_with_json(self):
        svc, gw, c = make_service()
        gw.outcomes = [vh.PacingViolation()]
        status, body = svc.news(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (429, "pacing_violation"))
        self.assertEqual(svc.pacer.snapshot()["backoff_seconds"], 0)  # the historical pacer is untouched
        c.sleep(10)
        gw.outcomes = [RuntimeError("boom")]
        status, body = svc.news(q(symbol="SPY"))
        self.assertEqual((status, body), (500, {"error": "internal", "message": "news request failed"}))

    def test_service_caches_spaces_and_serves_stale(self):
        svc, gw, c = make_service()
        status, body = svc.news(q(symbol="SPY"))
        self.assertEqual((status, body["schema"], body["count"], body["client_id"]), (200, "vertex-history-news-v1", 1, 77))
        self.assertEqual(body["cache"], {"hit": False, "ageSeconds": 0, "ttlSeconds": 300, "stale": False})
        self.assertEqual(svc.news(q(symbol="SPY"))[1]["cache"]["hit"], True)
        start = c.t
        svc.news(q(symbol="QQQ"))  # second symbol right away: waits for NEWS_MIN_INTERVAL
        self.assertEqual(c.t - start, vh.NEWS_MIN_INTERVAL)
        c.sleep(400)
        gw.outcomes = [vh.IbError("unavailable", "down")]
        status, body = svc.news(q(symbol="SPY"))
        self.assertEqual((status, body["cache"]["stale"]), (200, True))
        gw.outcomes = [vh.IbError("entitlement", "no news permission", 10276)]
        c.sleep(400)
        status, body = svc.news(q(symbol="SPY"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (502, "entitlement", 10276))
        self.assertEqual(svc.news(q(symbol="SPY", count="99"))[0], 400)

    def test_busy_lock_answers_429(self):
        svc, _gw, _c = make_service()
        svc.news_lock.acquire()
        try:
            with mock.patch.object(vh, "MAX_WAIT", 0.01):
                status, body = svc.news(q(symbol="SPY"))
        finally:
            svc.news_lock.release()
        self.assertEqual((status, body["error"]), (429, "busy"))

    def test_http_route(self):
        svc, _gw, _c = make_service()
        server = vh.ThreadingHTTPServer(("127.0.0.1", 0), vh.make_handler(svc, TOKEN))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request("http://127.0.0.1:%d/vertex-history/v1/news?symbol=SPY" % server.server_address[1])
            req.add_header("Authorization", "Bearer " + TOKEN)
            with urllib.request.urlopen(req, timeout=5) as r:
                body = json.loads(r.read())
            self.assertEqual((r.status, body["items"][0]["headline"]), (200, "SPY gains"))
        finally:
            server.shutdown()
            server.server_close()


SEC_DEF = [("CBOE", "SPY", "100", {"20270115"}, {600.0}),
           ("SMART", "2SPY", "100", {"20270301"}, {1.0}),
           ("SMART", "SPY", "100", {"20270122", "20270115", "20270219", "junk", "20271340"},
            {590.0, 595.0, 597.5, 600.0, 602.5, 605.0, 610.0, -1.0, float("nan")})]
SPY_QUOTE = {1: 600.1, 2: 600.14, 4: 601.0, 9: 598.0, "md": 1}


def chain_service(option_quotes=True, **kw):
    """The real gateway (fake IB client) behind the service with the option switch set, on one fake clock."""
    kw.setdefault("sec_def", SEC_DEF)
    kw.setdefault("quotes", {"STK": SPY_QUOTE})
    gw = fake_gateway(**kw)
    c = gw.clock
    cache = vh.DiskCache(tempfile.mkdtemp(prefix="vx-hist-"), clock=c)
    logs = []
    svc = vh.HistoryService(gw, cache, vh.Pacer(c), clock=c, sleep=c.sleep, option_quotes=option_quotes,
                            log=lambda event, **fields: logs.append((event, fields)))
    svc.logs = logs
    return svc, gw, c


def snapshot_calls(gw):
    return [call for call in gw._client.calls if call[0] == "reqMktData"]


class OptionChainTest(unittest.TestCase):
    """1.4.0 /option-chain: snapshot quotes of the strikes nearest the money, behind VERTEX_HISTORY_OPTION_QUOTES."""

    def test_validate(self):
        self.assertEqual(vh.validate_option_chain(q(symbol="spy")), {"symbol": "SPY", "expiry": None, "strikes": 8})
        self.assertEqual(vh.validate_option_chain(q(symbol="BRK B", expiry="20270115", strikes="12")),
                         {"symbol": "BRK B", "expiry": "20270115", "strikes": 12})
        self.assertEqual(vh.validate_option_chain(q(symbol="SPY", strikes="1"))["strikes"], 1)
        for raw in (q(), q(symbol="SPY$"), q(symbol="SPY", strikes="0"), q(symbol="SPY", strikes="13"),
                    q(symbol="SPY", strikes="x"), q(symbol="SPY", strikes=""), q(symbol="SPY", expiry=""),
                    q(symbol="SPY", expiry="2027011"), q(symbol="SPY", expiry="202701155"),
                    q(symbol="SPY", expiry="20270230"), q(symbol="SPY", expiry="20271301"),
                    q(symbol="SPY", expiry="2027-1-5"), q(symbol="SPY", expiry="\u0662\u0660270115"),
                    q(symbol="SPY", secType="STK"), q(symbol="SPY", secType="FUT"), q(symbol="SPY", exchange="CBOE"),
                    q(symbol="SPY", currency="USD"), q(symbol="SPY", count="5"),
                    {"symbol": ["SPY", "QQQ"]}, {"symbol": ["SPY"], "strikes": ["2", "3"]}):
            with self.assertRaises(vh.BadRequest, msg=raw):
                vh.validate_option_chain(raw)
        svc, gw, _c = chain_service()
        for raw in (q(symbol="SPY", strikes="13"), q(symbol="SPY", secType="FUT"), {"symbol": ["SPY", "QQQ"]}):
            status, body = svc.option_chain(raw)
            self.assertEqual((status, body["error"]), (400, "bad_request"), raw)
        self.assertEqual(gw._client.calls, [])

    def test_switch_reads_exactly_one(self):
        self.assertTrue(vh.option_quotes_enabled({"VERTEX_HISTORY_OPTION_QUOTES": "1"}))
        for value in ("", "0", "true", "yes", "on", " 1", "1 ", "01", "11"):
            self.assertFalse(vh.option_quotes_enabled({"VERTEX_HISTORY_OPTION_QUOTES": value}), value)
        self.assertFalse(vh.option_quotes_enabled({}))
        with mock.patch.dict(os.environ, {"VERTEX_HISTORY_OPTION_QUOTES": "1"}):
            self.assertTrue(vh.option_quotes_enabled())
        self.assertEqual(SOURCE.count("option_quotes_enabled()"), 1, "the switch is read once, in main()")
        self.assertFalse(make_service()[0].option_quotes)  # off unless the caller turns it on

    def test_switch_off_answers_403_without_any_ib_call(self):
        svc, gw, _c = chain_service(option_quotes=False)
        connects = []
        gw._connect = lambda: connects.append(1)
        for raw in (q(symbol="SPY"), q(symbol="SPY", expiry="20270115", strikes="2"), q(symbol="SPY", strikes="99"),
                    q()):
            status, body = svc.option_chain(raw)
            self.assertEqual((status, body["error"]), (403, "disabled"), raw)
            self.assertIn("VERTEX_HISTORY_OPTION_QUOTES", body["message"])
        self.assertEqual((gw._client.calls, connects, svc.logs), ([], [], []))
        health = make_service()[0].health()[1]
        self.assertEqual((health["optionQuotes"], health["version"]), (False, "1.4.0"))
        self.assertEqual(make_service(option_quotes=True)[0].health()[1]["optionQuotes"], True)

    def test_happy_path_shape_order_and_nearest_strikes(self):
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): {1: 4.1, 2: 4.15, 4: 4.12, 9: 3.9, "md": 1},
                  (600.0, "P"): {66: 3.0, 67: 3.1, 68: -1.0, 75: 2.9, "md": 3},
                  (597.5, "P"): {1: 0.0, 2: 0.05, "md": 2}}
        svc, gw, c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="spy", strikes="3"))
        self.assertEqual(status, 200)
        self.assertEqual(list(body), ["schema", "source", "client_id", "request", "expirations", "expiry", "tradingClass",
                                      "multiplier", "underlying", "quotes", "count", "fetchedAt", "cache"])
        self.assertEqual((body["schema"], body["source"], body["client_id"]),
                         ("vertex-history-option-chain-v1", "ibkr-gateway", 77))
        self.assertEqual(body["request"], {"symbol": "SPY", "expiry": None, "strikes": 3})
        self.assertEqual(body["expirations"], ["20270115", "20270122", "20270219"])  # SMART row of class SPY, ascending
        self.assertEqual((body["expiry"], body["tradingClass"], body["multiplier"]), ("20270115", "SPY", "100"))
        self.assertEqual(body["underlying"], {"bid": 600.1, "ask": 600.14, "last": 601.0, "close": 598.0,
                                              "price": 601.0, "dataType": "live"})
        self.assertEqual(list(body["underlying"]), ["bid", "ask", "last", "close", "price", "dataType"])
        # nearest to 601.0: 600 (1.0), 602.5 (1.5), 597.5 (3.5); ascending by strike, call before put
        self.assertEqual([(row["strike"], row["right"]) for row in body["quotes"]],
                         [(597.5, "C"), (597.5, "P"), (600.0, "C"), (600.0, "P"), (602.5, "C"), (602.5, "P")])
        by = {(row["strike"], row["right"]): row for row in body["quotes"]}
        self.assertEqual(by[(600.0, "C")], {"strike": 600.0, "right": "C", "bid": 4.1, "ask": 4.15, "last": 4.12,
                                            "dataType": "live", "error": None})
        self.assertEqual(list(by[(600.0, "C")]), ["strike", "right", "bid", "ask", "last", "dataType", "error"])
        # delayed twins fill the same fields; a negative price is null
        self.assertEqual(by[(600.0, "P")], {"strike": 600.0, "right": "P", "bid": 3.0, "ask": 3.1, "last": None,
                                            "dataType": "delayed", "error": None})
        self.assertEqual(by[(597.5, "P")], {"strike": 597.5, "right": "P", "bid": 0.0, "ask": 0.05, "last": None,
                                            "dataType": "frozen", "error": None})
        self.assertEqual((body["count"], body["fetchedAt"]), (6, vh.now_iso(c.t)))
        self.assertEqual(body["cache"], {"hit": False, "ageSeconds": 0, "ttlSeconds": 30, "stale": False})
        json.dumps(body, allow_nan=False)
        # the IB flow: contract lookup, definition by conId, the underlying snapshot, then one wave of options
        names = [call[0] for call in gw._client.calls]
        self.assertEqual(names, ["reqContractDetails", "reqSecDefOptParams"] + ["reqMktData"] * 7)
        self.assertEqual(gw._client.calls[1][2:], ("SPY", "", "STK", 4242))
        under, first = snapshot_calls(gw)[0], snapshot_calls(gw)[1]
        self.assertEqual(under[6:], ("STK", "STK", "", None, None, "SMART", "USD", 4242))
        self.assertEqual(first[6:], ("OPT", (597.5, "C"), "20270115", "100", "SPY", "SMART", "USD", 0))
        self.assertEqual(gw.holders, {})
        event, fields = svc.logs[-1]
        self.assertEqual((event, fields), ("option_chain", {"symbol": "SPY", "expiry": "20270115", "quotes": 6,
                                                            "quoted": 6, "errors": None}))

    def test_helpers_nearest_strikes_and_underlying_price_rule(self):
        strikes = [590.0, 595.0, 597.5, 600.0, 602.5, 605.0]
        self.assertEqual(vh.nearest_strikes(strikes, 600.0, 2), [597.5, 600.0])  # tie 597.5/602.5: the lower first
        self.assertEqual(vh.nearest_strikes(strikes, 600.0, 3), [597.5, 600.0, 602.5])
        self.assertEqual(vh.nearest_strikes(strikes, 1.0, 2), [590.0, 595.0])
        self.assertEqual(vh.nearest_strikes(strikes, 600.0, 99), strikes)
        self.assertEqual(vh.nearest_strikes([], 600.0, 3), [])
        price = vh.underlying_price
        self.assertEqual(price({"bid": 10.0, "ask": 10.2, "last": 10.3, "close": 9.0}), 10.3)  # last if > 0
        self.assertEqual(price({"bid": 10.0, "ask": 10.5, "last": 0.0, "close": 9.0}), 10.25)  # else the midpoint
        self.assertEqual(price({"bid": 10.0, "ask": None, "last": None, "close": 9.0}), 9.0)  # else close
        self.assertEqual(price({"bid": 0.0, "ask": 10.5, "last": None, "close": 9.0}), 9.0)
        self.assertIsNone(price({"bid": None, "ask": None, "last": None, "close": None}))
        self.assertIsNone(price({"bid": 10.0, "ask": None, "last": None, "close": 0.0}))
        snap = vh.QuoteSnapshot()
        for tick_type, value in ((1, -1.0), (2, float("nan")), (4, "x"), (9, float("inf")), (3, 5.0), (0, 7.0),
                                 ("bid", 1.0)):
            snap.tick(tick_type, value)
        snap.market_data_type(9)
        snap.market_data_type("x")
        self.assertEqual((snap.prices, snap.data_type), ({"bid": None, "ask": None, "last": None, "close": None}, None))
        snap.market_data_type(4)
        self.assertEqual(snap.data_type, "delayed-frozen")

    def test_underlying_price_falls_back_to_midpoint_then_close(self):
        svc, _gw, c = chain_service(quotes={"STK": {1: 599.0, 2: 601.0, 9: 590.0, "md": 1}})
        body = svc.option_chain(q(symbol="SPY", strikes="2"))[1]
        self.assertEqual((body["underlying"]["price"], body["underlying"]["last"]), (600.0, None))
        self.assertEqual([row["strike"] for row in body["quotes"]], [597.5, 597.5, 600.0, 600.0])
        svc, _gw, _c = chain_service(quotes={"STK": {75: 590.2, "md": 4}})
        body = svc.option_chain(q(symbol="SPY", strikes="1"))[1]
        self.assertEqual(body["underlying"], {"bid": None, "ask": None, "last": None, "close": 590.2, "price": 590.2,
                                              "dataType": "delayed-frozen"})
        self.assertEqual([row["strike"] for row in body["quotes"]], [590.0, 590.0])

    def test_nearest_expiry_around_the_new_york_close(self):
        ny_close = 1800046800  # 2027-01-15T21:00:00Z = 16:00 America/New_York (EST)
        self.assertEqual(vh.expiry_close_ts("20270115"), ny_close)
        self.assertEqual(vh.now_iso(vh.expiry_close_ts("20270716")), "2027-07-16T20:00:00Z")  # EDT in summer
        listed = ["20270122", "20270115", "20270219"]
        self.assertEqual(vh.pick_expiry(listed, None, ny_close - 1), "20270115")
        self.assertEqual(vh.pick_expiry(listed, None, ny_close), "20270122")  # at the close it is no longer ahead
        self.assertEqual(vh.pick_expiry(listed, None, ny_close + 1), "20270122")
        self.assertIsNone(vh.pick_expiry(listed, None, vh.expiry_close_ts("20270219")))
        self.assertEqual(vh.pick_expiry(listed, "20270219", ny_close), "20270219")
        self.assertEqual(vh.pick_expiry(listed, "20270115", ny_close - 1), "20270115")
        self.assertIsNone(vh.pick_expiry(listed, "20270115", ny_close))  # a given expiry must be listed and still open
        self.assertIsNone(vh.pick_expiry(listed, "20270116", 0))
        for at, expected in ((ny_close - 1, "20270115"), (ny_close, "20270122")):
            svc, gw, c = chain_service()
            c.t = float(at)
            status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
            self.assertEqual((status, body["expiry"]), (200, expected), at)
            self.assertEqual(snapshot_calls(gw)[1][8], expected)
        svc, gw, c = chain_service()
        c.t = vh.expiry_close_ts("20270219") + 1.0
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (404, "expiry_not_listed"))
        self.assertEqual(snapshot_calls(gw), [])

    def test_given_expiry_must_be_listed(self):
        svc, gw, _c = chain_service()
        status, body = svc.option_chain(q(symbol="SPY", expiry="20270219", strikes="1"))
        self.assertEqual((status, body["expiry"], body["request"]["expiry"]), (200, "20270219", "20270219"))
        self.assertTrue(all(call[8] == "20270219" for call in snapshot_calls(gw)[1:]))
        before = len(gw._client.calls)
        for unlisted in ("20270116", "20270301"):  # 20270301 is listed for another SMART trading class only
            status, body = svc.option_chain(q(symbol="SPY", expiry=unlisted))
            self.assertEqual((status, body["error"]), (404, "expiry_not_listed"), unlisted)
            self.assertIn(unlisted, body["message"])
        # the definition is cached, and an unlisted expiry sends no snapshot at all
        self.assertEqual(len(gw._client.calls), before)
        self.assertEqual(sum(1 for call in gw._client.calls if call[0] == "reqSecDefOptParams"), 1)

    def test_definition_row_choice_cache_and_missing_chain(self):
        # no SMART row of the symbol's own trading class: 404, never another (maybe adjusted) class
        other = [("SMART", "2SPY", "100", {"20270122"}, {600.0}), ("AMEX", "SPY", "100", {"20270115"}, {600.0}),
                 ("SMART", "SPYQ", "10", {"20270129"}, {600.0})]
        svc, gw, c = chain_service(sec_def=other)
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["error"]), (404, "no_option_chain"))
        self.assertEqual(snapshot_calls(gw), [])
        # the own class wins wherever it stands; "BRK B" also matches the class written without the space
        for symbol, rows, expected in (
                ("SPY", other + [("SMART", "SPY", "100", {"20270219"}, {600.0})], ("SPY", "20270219")),
                ("BRK B", [("SMART", "BRK", "100", {"20270122"}, {600.0}),
                           ("SMART", "BRKB", "100", {"20270129"}, {600.0})], ("BRKB", "20270129")),
                ("BRK B", [("SMART", "BRKB", "100", {"20270129"}, {600.0}),
                           ("SMART", "BRK B", "100", {"20270219"}, {600.0})], ("BRKB", "20270129"))):
            svc, gw, c = chain_service(sec_def=rows)
            status, body = svc.option_chain(q(symbol=symbol, strikes="1"))
            self.assertEqual((status, body["tradingClass"], body["expiry"]), (200,) + expected, symbol)
        svc, gw, c = chain_service(sec_def=[("SMART", "BRK", "100", {"20270122"}, {600.0})])
        self.assertEqual(svc.option_chain(q(symbol="BRK B"))[0], 404)
        svc, gw, c = chain_service()
        svc.option_chain(q(symbol="SPY", strikes="1"))
        c.sleep(vh.CONTRACT_TTL - 1)
        svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual(sum(1 for call in gw._client.calls if call[0] == "reqSecDefOptParams"), 1)
        c.sleep(2)
        svc.option_chain(q(symbol="SPY", strikes="3"))
        self.assertEqual(sum(1 for call in gw._client.calls if call[0] == "reqSecDefOptParams"), 2)
        svc, gw, _c = chain_service(sec_def=[("CBOE", "SPY", "100", {"20270115"}, {600.0})])
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (404, "no_option_chain"))
        self.assertEqual(snapshot_calls(gw), [])
        svc, gw, _c = chain_service()
        gw._client.reqContractDetails = lambda rid, spec: gw.finish(rid)  # unknown symbol: no contract rows
        status, body = svc.option_chain(q(symbol="NOPE"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (404, "no_option_chain", 200))
        self.assertEqual(gw._client.calls, [])

    def test_per_contract_errors_do_not_fail_the_response(self):
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): (200, "No security definition has been found for the request"),
                  (600.0, "P"): (354, "Requested market data is not subscribed"),
                  (602.5, "C"): (10091, "Part of requested market data requires additional subscription for API"),
                  (602.5, "P"): (10167, "Requested market data is not subscribed. Displaying delayed market data"),
                  (597.5, "C"): (10090, "Part of requested market data is not subscribed"),
                  (597.5, "P"): (321, "Error validating request for account U1234567"),
                  # an error after the prices: the row keeps its dataType and loses the prices
                  (605.0, "C"): {1: 2.0, 2: 2.1, 4: 2.05, "md": 2, "warn_late": (10168, "not subscribed"), "end": False}}
        svc, gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="4"))
        self.assertEqual(status, 200)
        errors = {(row["strike"], row["right"]): row["error"] for row in body["quotes"]}
        self.assertEqual(errors, {(597.5, "C"): "not_subscribed", (597.5, "P"): "ib_error",
                                  (600.0, "C"): "no_security_definition", (600.0, "P"): "not_subscribed",
                                  (602.5, "C"): "not_subscribed", (602.5, "P"): "not_subscribed",
                                  (605.0, "C"): "not_subscribed", (605.0, "P"): None})
        failed = [row for row in body["quotes"] if row["error"]]
        self.assertTrue(all((row["bid"], row["ask"], row["last"]) == (None,) * 3 for row in failed))
        self.assertEqual([row["dataType"] for row in failed], [None] * 6 + ["frozen"])
        self.assertEqual(body["quotes"][-1]["bid"], 1.0)
        # a request that IB ended with an error gets no cancel; the three that got only a warning code (10090,
        # 10091, 10167) and no tickSnapshotEnd are still open at IB and are cancelled
        still_open = [call[1] for call in snapshot_calls(gw) if call[7] in ((597.5, "C"), (602.5, "C"), (602.5, "P"))]
        self.assertEqual(sorted(call[1] for call in gw._client.calls if call[0] == "cancelMktData"), sorted(still_open))
        self.assertEqual(gw.holders, {})
        self.assertEqual(svc.logs[-1][1]["errors"], "ib_error,no_security_definition,not_subscribed")
        self.assertNotIn("U1234567", json.dumps(body) + json.dumps(svc.logs))
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="4"))[1]["cache"]["hit"], True)

    def test_snapshot_deadline_marks_timeout_and_cancels(self):
        svc, gw, _c = chain_service(quotes={"STK": SPY_QUOTE, (600.0, "P"): "silent", (602.5, "C"): "silent"})
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual(status, 200)
        self.assertEqual([(row["strike"], row["right"], row["error"]) for row in body["quotes"]],
                         [(600.0, "C", None), (600.0, "P", "timeout"), (602.5, "C", "timeout"), (602.5, "P", None)])
        self.assertEqual(body["quotes"][1], {"strike": 600.0, "right": "P", "bid": None, "ask": None, "last": None,
                                             "dataType": None, "error": "timeout"})
        open_ids = sorted(call[1] for call in snapshot_calls(gw) if call[7] in ((600.0, "P"), (602.5, "C")))
        self.assertEqual(sorted(call[1] for call in gw._client.calls if call[0] == "cancelMktData"), open_ids)
        self.assertEqual(gw.holders, {})
        self.assertEqual(vh.OPTION_SNAPSHOT_SECONDS, 12.0)
        self.assertEqual(vh.IbGateway("/nonexistent").snapshot_wait, 12.0)

    def test_underlying_failures_are_ib_errors(self):
        svc, gw, _c = chain_service(quotes={"STK": {1: -1.0, 2: -1.0, "md": 1}})
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (502, "ibkr_error"))
        self.assertEqual(len(snapshot_calls(gw)), 1)  # no option snapshot without an underlying price
        svc, gw, _c = chain_service(quotes={"STK": "silent"})
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (504, "timeout"))
        self.assertEqual([call[0] for call in gw._client.calls][-2:], ["reqMktData", "cancelMktData"])
        svc, gw, _c = chain_service(quotes={"STK": (354, "Requested market data is not subscribed for U1234567")})
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (502, "entitlement", 354))
        self.assertEqual([call[0] for call in gw._client.calls][-2:], ["reqSecDefOptParams", "reqMktData"])  # no cancel
        self.assertIn("[account]", body["message"])
        self.assertNotIn("U1234567", json.dumps(body))
        svc, gw, _c = chain_service(sec_def=(10197, "No market data during competing live session"))
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (502, "entitlement"))
        self.assertEqual(snapshot_calls(gw), [])

    def test_gateway_loss_fails_the_request_and_serves_stale(self):
        svc, gw, c = chain_service()
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="1"))[0], 200)
        c.sleep(vh.OPTION_TTL + 1)
        gw._client.quotes = {"STK": SPY_QUOTE, (600.0, "P"): (1100, "Connectivity between IB and TWS has been lost")}
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["cache"]["stale"], body["cache"]["hit"]), (200, True, True))
        c.sleep(vh.OPTION_STALE_MAX)
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["error"]), (503, "unavailable"))

    def test_warning_codes_do_not_end_a_snapshot(self):
        warn = (10090, "Part of requested market data is not subscribed")
        quotes = {"STK": dict(SPY_QUOTE, warn=warn),  # the warning comes before the ticks of the underlying
                  (600.0, "C"): {"warn": (10167, "Displaying delayed market data"), 1: 4.1, 2: 4.15, 4: 4.12, "md": 1},
                  (600.0, "P"): {"warn": (10091, "requires additional subscription for API"), 4: 3.0, "md": 1},
                  (602.5, "C"): {"warn": warn, 1: 2.0, 2: 2.1, "md": 1, "end": False},
                  (602.5, "P"): {1: 1.0, 2: 1.1, "md": 3, "warn_late": warn}}
        svc, gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual((status, body["underlying"]["price"], body["underlying"]["dataType"]), (200, 601.0, "live"))
        self.assertEqual(body["quotes"], [
            # a live bid and ask after the warning: a good row
            {"strike": 600.0, "right": "C", "bid": 4.1, "ask": 4.15, "last": 4.12, "dataType": "live", "error": None},
            # ended without a bid and an ask: the warning is the reason
            {"strike": 600.0, "right": "P", "bid": None, "ask": None, "last": None, "dataType": "live",
             "error": "not_subscribed"},
            # a bid and an ask after the warning, no tickSnapshotEnd: complete, a good row
            {"strike": 602.5, "right": "C", "bid": 2.0, "ask": 2.1, "last": None, "dataType": "live", "error": None},
            {"strike": 602.5, "right": "P", "bid": 1.0, "ask": 1.1, "last": None, "dataType": "delayed", "error": None}])
        open_id = [call[1] for call in snapshot_calls(gw) if call[7] == (602.5, "C")]
        self.assertEqual([call[1] for call in gw._client.calls if call[0] == "cancelMktData"], open_id)
        # the holder records the warning and stays open until tickSnapshotEnd
        snap = gw.holders[5] = vh.QuoteSnapshot()
        gw.on_error(5, *warn)
        self.assertEqual((snap.done.is_set(), snap.error, snap.warning.code, snap.ended), (False, None, 10090, False))
        gw.tick_price(5, 1, 7.0)
        gw.snapshot_end(5)
        self.assertEqual((snap.done.is_set(), snap.ended, snap.prices["bid"]), (True, True, 7.0))
        gw.snapshot_end(99)  # a late or unknown id is ignored
        plain = gw.holders[6] = vh._Holder()  # other request kinds keep the old rule: the code ends them
        gw.on_error(6, *warn)
        self.assertEqual((plain.done.is_set(), plain.error.kind), (True, "entitlement"))
        self.assertEqual(vh.OPTION_WARNING_CODES, {10090, 10091, 10167})
        self.assertLess(vh.OPTION_WARNING_CODES, vh.OPTION_SUBSCRIPTION_CODES)
        # an underlying that gets only the warning: 502 with the IB code, and its line is cancelled
        svc, gw, _c = chain_service(quotes={"STK": {"warn": warn, "end": False}})
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (502, "entitlement", 10090))
        self.assertEqual([call[0] for call in gw._client.calls][-2:], ["reqMktData", "cancelMktData"])

    def test_error_labels_and_null_prices_of_error_rows(self):
        for code, kind, expected in ((200, "no_contract", "no_security_definition"), (354, "entitlement", "not_subscribed"),
                                     (10089, "entitlement", "not_subscribed"), (10090, "entitlement", "not_subscribed"),
                                     (10091, "ibkr_error", "not_subscribed"), (10167, "entitlement", "not_subscribed"),
                                     (10168, "entitlement", "not_subscribed"), (10197, "entitlement", "ib_error"),
                                     (10092, "entitlement", "ib_error"), (10186, "entitlement", "ib_error"),
                                     (10276, "entitlement", "ib_error"), (321, "ibkr_error", "ib_error"),
                                     (None, "entitlement", "ib_error")):
            self.assertEqual(vh.option_error_kind(vh.IbError(kind, "x", code)), expected, code)
        self.assertEqual(vh.option_error_kind(vh.PacingViolation()), "ib_error")
        self.assertEqual(vh.OPTION_SUBSCRIPTION_CODES, {354, 10089, 10090, 10091, 10167, 10168})
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): (10197, "No market data during competing live session"),
                  (600.0, "P"): (2222, "No market data permissions for U1234567"),
                  # a bid and a last but no ask, and no tickSnapshotEnd before the end of the window
                  (602.5, "C"): {1: 2.0, 4: 2.05, "md": 4, "end": False},
                  # prices, then a terminal error
                  (602.5, "P"): {1: 1.0, 2: 1.1, 4: 1.05, "md": 1, "warn_late": (200, "none"), "end": False}}
        svc, gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual(status, 200)
        self.assertEqual([(row["bid"], row["ask"], row["last"], row["dataType"], row["error"]) for row in body["quotes"]],
                         [(None, None, None, None, "ib_error"), (None, None, None, None, "ib_error"),
                          (None, None, None, "delayed-frozen", "timeout"),
                          (None, None, None, "live", "no_security_definition")])
        self.assertNotIn("U1234567", json.dumps(body) + json.dumps(svc.logs))

    def test_implausible_prices_are_null(self):
        huge = sys.float_info.max
        self.assertEqual(vh.OPTION_PRICE_MAX, 1e9)
        for value, expected in ((0.0, 0.0), (4.1, 4.1), ("4.1", 4.1), (1e9 - 1, 1e9 - 1), (1e9, None), (huge, None),
                                (-1.0, None), (-0.01, None), (float("nan"), None), (float("inf"), None),
                                (float("-inf"), None), (None, None), ("x", None)):
            self.assertEqual(vh.option_price(value), expected, value)
        snap = vh.QuoteSnapshot()
        snap.tick(1, 4.1)
        snap.tick(1, huge)  # not a price: ignored, the bid stays
        snap.tick(2, huge)
        snap.tick(2, 4.2)
        snap.tick(99, 5.0)
        snap.tick("x", 5.0)
        self.assertEqual(snap.prices, {"bid": 4.1, "ask": 4.2, "last": None, "close": None})
        # an underlying whose every price is the sentinel has no price: no option wave, and no 200
        svc, gw, _c = chain_service(quotes={"STK": {1: huge, 2: huge, 4: huge, 9: huge, "md": 1}})
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual((status, body["error"]), (502, "ibkr_error"))
        self.assertEqual(len(snapshot_calls(gw)), 1)
        # a sentinel last falls back to the midpoint; sentinel option prices are null in the row
        quotes = {"STK": {1: 600.1, 2: 600.3, 4: huge, 9: 598.0, "md": 1}, (600.0, "C"): {1: 4.1, 2: huge, 4: huge, "md": 1}}
        svc, gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["underlying"]["last"], round(body["underlying"]["price"], 6)), (200, None, 600.2))
        self.assertEqual([row["strike"] for row in body["quotes"]], [600.0, 600.0])
        self.assertEqual(body["quotes"][0], {"strike": 600.0, "right": "C", "bid": 4.1, "ask": None, "last": None,
                                             "dataType": "live", "error": None})
        json.dumps(body, allow_nan=False)
        # a sentinel strike is not listed
        svc, gw, _c = chain_service(sec_def=[("SMART", "SPY", "100", {"20270115"}, {600.0, huge, 1e9})])
        self.assertEqual(gw._option_definition({"symbol": "SPY"}, {"conId": 1})["strikes"], [600.0])

    def test_missing_tz_data_turns_the_switch_off(self):
        import zoneinfo
        missing = zoneinfo.ZoneInfoNotFoundError("No time zone found with key America/New_York")
        self.assertIsInstance(missing, KeyError)
        with mock.patch.object(vh, "_option_zone", None), mock.patch.object(vh, "ZoneInfo", side_effect=missing) as zone:
            svc, gw, _c = chain_service()
            self.assertFalse(svc.option_quotes)
            self.assertEqual(svc.logs, [("option_quotes_forced_off", {"reason": "tz_data_missing",
                                                                      "zone": "America/New_York"})])
            connects = []
            gw._connect = lambda: connects.append(1)
            for raw in (q(symbol="SPY"), q(symbol="SPY", expiry="20270115"), q(symbol="SPY", expiry="20270230"), q()):
                status, body = svc.option_chain(raw)  # no exception leaves the request path
                self.assertEqual((status, body["error"]), (403, "disabled"), raw)
            self.assertEqual((gw._client.calls, connects, len(svc.logs)), ([], [], 1))
            gw.connected = lambda: True
            self.assertEqual(svc.health()[1]["optionQuotes"], False)
            self.assertEqual(zone.call_count, 1)
            off, _gw, _c = chain_service(option_quotes=False)  # switch off: the zone is not even looked up
            self.assertEqual((off.logs, zone.call_count), ([], 1))
            self.assertIsNone(vh.option_zone())
            with self.assertRaises(vh.IbError):  # the pure helper never lets the KeyError out either
                vh.expiry_close_ts("20270115")
        with mock.patch.object(vh, "_option_zone", None), mock.patch.object(vh, "ZoneInfo", wraps=zoneinfo.ZoneInfo) as zone:
            svc, gw, _c = chain_service()
            self.assertTrue(svc.option_quotes)
            self.assertEqual(svc.option_chain(q(symbol="SPY", expiry="20270122", strikes="1"))[0], 200)
            self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[0], 200)
            self.assertEqual(zone.call_args_list, [mock.call("America/New_York")])  # resolved once, at start-up
        self.assertEqual(SOURCE.count("ZoneInfo("), 1)
        self.assertEqual(SOURCE.count("option_zone() is None"), 1)

    def test_given_expiry_that_has_closed_is_not_listed(self):
        svc, gw, c = chain_service()
        close = vh.expiry_close_ts("20270115")
        c.t = close - 1.0
        self.assertEqual(svc.option_chain(q(symbol="SPY", expiry="20270115", strikes="1"))[0], 200)
        sent = len(gw._client.calls)
        for at, strikes in ((close, "2"), (close + 1.0, "3"), (close + 86400.0, "4")):
            c.t = at
            status, body = svc.option_chain(q(symbol="SPY", expiry="20270115", strikes=strikes))
            self.assertEqual((status, body["error"]), (404, "expiry_not_listed"), at)
            self.assertIn("20270115", body["message"])
        self.assertEqual(len(gw._client.calls), sent)  # no snapshot, no IB call at all
        # the cached definition still lists the closed expiry; the default moves on to the next one
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["expiry"], body["expirations"][0]), (200, "20270122", "20270115"))
        # a fresh service with nothing cached makes no IB call for a closed expiry either
        svc, gw, c = chain_service()
        c.t = close
        connects = []
        gw._connect = lambda: connects.append(1)
        self.assertEqual(svc.option_chain(q(symbol="SPY", expiry="20270115"))[0], 404)
        self.assertEqual((gw._client.calls, connects), ([], []))

    def test_exception_between_sends_cancels_every_sent_request(self):
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): {1: 4.1, 2: 4.2, "md": 1, "end": False},
                  (600.0, "P"): RuntimeError("socket closed U1234567")}
        svc, gw, c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual((status, body), (500, {"error": "internal", "message": "option chain request failed"}))
        wave = snapshot_calls(gw)[1:]
        self.assertEqual([call[7] for call in wave], [(600.0, "C"), (600.0, "P")])  # the send stopped at the failure
        # every sent id is cancelled, the failing one included (IB may have got it)
        self.assertEqual([call[1] for call in gw._client.calls if call[0] == "cancelMktData"], [call[1] for call in wave])
        self.assertEqual(gw.holders, {})
        self.assertFalse(svc.option_lock.locked())
        self.assertNotIn("U1234567", json.dumps(svc.logs))
        gw._client.quotes = {"STK": SPY_QUOTE}
        start = c.t
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[0], 200)  # the next request works, spaced
        self.assertEqual(c.t - start, vh.OPTION_MIN_INTERVAL)
        # a cancel that raises does not stop the clean-up of the others
        gw = fake_gateway(sec_def=SEC_DEF, quotes=dict(quotes, **{"STK": "silent"}))
        gw._client.cancelMktData = mock.Mock(side_effect=OSError("down"))
        spec = gw._resolved_spec(dict(vh.OPTION_UNDERLYING, symbol="SPY"), gw._details(dict(vh.OPTION_UNDERLYING, symbol="SPY")))
        holders = gw._snapshots([spec, spec])
        self.assertEqual((gw._client.cancelMktData.call_count, gw.holders, [h.timed_out for h in holders]),
                         (2, {}, [True, True]))

    def test_strike_and_snapshot_caps(self):
        many = [("SMART", "SPY", "100", {"20270115"}, {float(k) for k in range(500, 700)})]
        svc, gw, _c = chain_service(sec_def=many)
        status, body = svc.option_chain(q(symbol="SPY", strikes="12"))
        self.assertEqual((status, body["count"]), (200, 24))
        self.assertEqual(len(snapshot_calls(gw)), 25)
        self.assertEqual(vh.OPTION_SNAPSHOT_MAX, 2 * 12 + 1)
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="13"))[0], 400)
        # the gateway holds the cap even for a request that skipped validation
        gw = fake_gateway(sec_def=many, quotes={"STK": SPY_QUOTE})
        chain = gw.fetch_option_chain({"symbol": "SPY", "expiry": None, "strikes": 500})
        self.assertEqual((len(chain["quotes"]), len(snapshot_calls(gw))), (24, 25))
        spec = types.SimpleNamespace(secType="STK")
        for wave in ([], [spec] * 25):
            with self.assertRaises(vh.IbError):
                gw._snapshots(wave)
        self.assertEqual(len(snapshot_calls(gw)), 25)  # a wave outside the cap sends nothing

    def test_every_snapshot_is_one_shot_non_regulatory_without_generic_ticks(self):
        svc, gw, _c = chain_service(quotes={"STK": SPY_QUOTE, (600.0, "C"): "silent", (600.0, "P"): (200, "none")})
        svc.option_chain(q(symbol="SPY", strikes="12"))
        svc.option_chain(q(symbol="SPY", expiry="20270219", strikes="3"))
        calls = snapshot_calls(gw)
        self.assertGreater(len(calls), 20)
        for call in calls:
            generic_ticks, snapshot, regulatory, options = call[2:6]
            self.assertEqual(generic_ticks, "")
            self.assertIs(snapshot, True)
            self.assertIs(regulatory, False)
            self.assertEqual(options, [])
        self.assertLessEqual({call[0] for call in gw._client.calls},
                             {"reqContractDetails", "reqSecDefOptParams", "reqMktData", "cancelMktData"})
        self.assertFalse(hasattr(gw._client, "reqMarketDataType"))

    def test_cache_spacing_and_budget(self):
        svc, gw, c = chain_service()
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[1]["cache"]["hit"], False)
        sent = len(gw._client.calls)
        c.sleep(vh.OPTION_TTL)
        status, body = svc.option_chain(q(symbol="spy", strikes="2"))
        self.assertEqual((status, body["cache"]), (200, {"hit": True, "ageSeconds": 30, "ttlSeconds": 30, "stale": False}))
        self.assertEqual(len(gw._client.calls), sent)
        c.sleep(1)
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[1]["cache"]["hit"], False)  # expired
        start = c.t
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="3"))[0], 200)  # another key right away: spaced
        self.assertEqual((c.t - start, vh.OPTION_MIN_INTERVAL), (5.0, 5.0))
        self.assertEqual((vh.OPTION_TTL, vh.OPTION_STALE_MAX, vh.OPTION_DEADLINE, vh.OPTION_MAX_WAIT), (30, 300, 14.0, 2.0))
        # a slow underlying snapshot uses up the 14 s budget: no option wave is sent
        svc, gw, c = chain_service(slow={"reqMktData": (14, True)})
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"]), (504, "timeout"))
        self.assertEqual(len(snapshot_calls(gw)), 1)
        # slow lookups use it up: no snapshot at all
        svc, gw, c = chain_service(slow={"reqContractDetails": (7, True), "reqSecDefOptParams": (7, True)})
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"], c.t - 1_800_000_000.0), (504, "timeout", 14.0))
        self.assertEqual(snapshot_calls(gw), [])
        # every wait of one request is cut to what is left of the budget
        svc, gw, c = chain_service(slow={"reqContractDetails": (3, True), "reqSecDefOptParams": (3, True)})
        gw.snapshot_wait, gw.underlying_wait = vh.OPTION_SNAPSHOT_SECONDS, vh.OPTION_UNDERLYING_SECONDS
        waits = []
        with mock.patch.object(vh.threading.Event, "wait", lambda self, timeout=None: waits.append(timeout) or self.is_set()):
            self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="1"))[0], 200)
        # 14 s less the lookups before each wait; the underlying gets its 4 s, the option wave the 8 s that are
        # left, not its full 12 s
        self.assertEqual((waits[:2], len(waits)), ([11.0, 8.0], 5))
        self.assertTrue(3.9 < waits[2] <= 4.0 and all(7.9 < wait <= 8.0 for wait in waits[3:]), waits)

    def test_spacing_that_does_not_fit_the_budget_answers_busy(self):
        svc, gw, c = chain_service()
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="1"))[0], 200)
        sent, start = len(gw._client.calls), c.t
        with mock.patch.object(vh, "OPTION_DEADLINE", 6.0):  # the spacing must leave the 3 s minimum window
            status, body = svc.option_chain(q(symbol="SPY", strikes="2"))  # 5 s of spacing, 6 s of budget
            self.assertEqual((status, body), (429, {"error": "busy", "retry_after_seconds": 5}))
            c.sleep(1.5)
            self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[1]["retry_after_seconds"], 4)
            self.assertEqual((len(gw._client.calls), c.t - start, svc.option_lock.locked()), (sent, 1.5, False))
            c.sleep(1.5)  # 2 s of spacing left: 4 s stay for the work, the request sleeps and asks IB
            self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[0], 200)
            self.assertEqual((c.t - start, len(gw._client.calls) > sent), (5.0, True))
        # with the real numbers the spacing always fits: 2 s of lock wait and 5 s of spacing leave 7 s
        self.assertLessEqual(vh.OPTION_MAX_WAIT + vh.OPTION_MIN_INTERVAL + vh.OPTION_MIN_WINDOW, vh.OPTION_DEADLINE)
        # a clock that went back cannot make the spacing longer than 5 s
        svc, gw, c = chain_service()
        svc.option_last = c.t + 3600.0
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="1"))[0], 200)
        self.assertEqual(c.t - 1_800_000_000.0, 5.0)

    def test_service_stale_busy_and_unexpected_errors(self):
        svc, gw, c = make_service(option_quotes=True)
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["schema"], body["count"]), (200, "vertex-history-option-chain-v1", 2))
        self.assertNotIn("contract", body)
        c.sleep(vh.OPTION_TTL + 1)
        gw.outcomes = [vh.IbError("unavailable", "down")]
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["cache"]["stale"]), (200, True))
        c.sleep(vh.OPTION_STALE_MAX)
        gw.outcomes = [vh.IbError("unavailable", "down")]
        self.assertEqual(svc.option_chain(q(symbol="SPY"))[0], 503)
        gw.outcomes = [RuntimeError("boom U1234567")]
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body), (500, {"error": "internal", "message": "option chain request failed"}))
        gw.outcomes = [vh.PacingViolation()]
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"], body["retry_after_seconds"]), (429, "pacing_violation", 5))
        self.assertEqual(svc.pacer.snapshot()["backoff_seconds"], 0)  # the historical pacer is untouched
        calls = len(gw.calls)
        svc.option_lock.acquire()
        try:
            with mock.patch.object(vh, "OPTION_MAX_WAIT", 0.01):
                status, body = svc.option_chain(q(symbol="QQQ"))
        finally:
            svc.option_lock.release()
        self.assertEqual((status, body), (429, {"error": "busy", "retry_after_seconds": 5}))
        self.assertEqual(len(gw.calls), calls)
        self.assertIsNot(svc.option_lock, svc.news_lock)
        self.assertIsNot(svc.option_lock, svc.depth_lock)
        self.assertIsNot(svc.option_lock, svc.lock)

    def test_http_route_on_and_off(self):
        for enabled, expected in ((True, 200), (False, 403)):
            svc, gw, _c = make_service(option_quotes=enabled)
            server = vh.ThreadingHTTPServer(("127.0.0.1", 0), vh.make_handler(svc, TOKEN))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = "http://127.0.0.1:%d/vertex-history/v1" % server.server_address[1]

            def call(path, token=TOKEN):
                req = urllib.request.Request(base + path)
                if token:
                    req.add_header("Authorization", "Bearer " + token)
                try:
                    with urllib.request.urlopen(req, timeout=5) as r:
                        return r.status, json.loads(r.read())
                except urllib.error.HTTPError as e:
                    return e.code, json.loads(e.read())

            try:
                status, body = call("/option-chain?symbol=SPY&expiry=20270122&strikes=4")
                self.assertEqual(status, expected)
                if enabled:
                    self.assertEqual((body["expiry"], body["quotes"][1]["error"]), ("20270122", "timeout"))
                    self.assertEqual(call("/option-chain?symbol=SPY&strikes=13")[0], 400)
                    self.assertEqual(call("/option-chain?symbol=SPY&symbol=QQQ")[0], 400)
                else:
                    self.assertEqual(body["error"], "disabled")
                    self.assertEqual(gw.calls, [])
                self.assertEqual(call("/option-chain?symbol=SPY", token=None)[0], 401)
                self.assertEqual(call("/health")[1]["optionQuotes"], enabled)
                self.assertEqual(call("/health")[1]["version"], "1.4.0")
            finally:
                server.shutdown()
                server.server_close()


NOT_SUBSCRIBED = (354, "Requested market data is not subscribed")


def answering_cancel(gw):
    """A cancelMktData to which IB answers at once: code 300 and late callbacks for every snapshot id sent so far."""
    def cancel(rid):
        gw._client.calls.append(("cancelMktData", rid))
        for call in snapshot_calls(gw):
            gw.on_error(call[1], 300, "Can't find EId with tickerId:%d" % call[1])
            gw.tick_price(call[1], 1, 9.99)
            gw.market_data_type(call[1], 3)
            gw.snapshot_end(call[1])

    return cancel


class StaleDone:
    """Stands in for the done Event of one holder: the wait runs out, then `arrive` delivers the answer of IB, and
    a reader of is_set() still sees the state from before."""

    def __init__(self, arrive):
        self.arrive = arrive

    def wait(self, timeout=None):
        self.arrive()
        return False

    def is_set(self):
        return False

    def set(self):
        pass


class OptionChainLoadTest(unittest.TestCase):
    """What one /option-chain call may send to the shared gateway, and what a late answer of IB may change."""

    def test_an_answer_to_a_cancel_changes_no_row(self):
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): (200, "No security definition has been found for the request"),
                  (600.0, "P"): NOT_SUBSCRIBED,
                  (602.5, "C"): (10090, "Part of requested market data is not subscribed"),  # a warning: still open
                  (602.5, "P"): {1: 1.0, "md": 1, "end": False},  # a bid only, no tickSnapshotEnd: still open
                  (597.5, "P"): {1: 1.0, 2: 1.1, "md": 1, "end": False}}  # complete on bid and ask: still open
        svc, gw, _c = chain_service(quotes=quotes)
        gw._client.cancelMktData = answering_cancel(gw)
        messages = []
        gw.log = lambda event, **fields: messages.append(fields.get("code"))
        status, body = svc.option_chain(q(symbol="SPY", strikes="3"))
        self.assertEqual(status, 200)
        self.assertEqual([(row["strike"], row["right"], row["bid"], row["dataType"], row["error"]) for row in body["quotes"]],
                         [(597.5, "C", 1.0, "live", None), (597.5, "P", 1.0, "live", None),
                          (600.0, "C", None, None, "no_security_definition"), (600.0, "P", None, None, "not_subscribed"),
                          (602.5, "C", None, None, "not_subscribed"), (602.5, "P", None, "live", "timeout")])
        still_open = [call[1] for call in snapshot_calls(gw) if call[7] in ((597.5, "P"), (602.5, "C"), (602.5, "P"))]
        self.assertEqual([call[1] for call in gw._client.calls if call[0] == "cancelMktData"], still_open)
        self.assertEqual(gw.holders, {})
        self.assertEqual(messages.count(300), 3 * 7)  # the answers are logged, and that is all
        # the holders a wave returns are final: nothing that comes after the pop is in them
        gw = fake_gateway(quotes={"STK": {4: 600.0, "md": 1, "end": False}})
        gw._client.cancelMktData = answering_cancel(gw)
        spec = types.SimpleNamespace(secType="STK", lastTradeDateOrContractMonth="", exchange="SMART", currency="USD",
                                     conId=1)
        holder = gw._snapshots([spec])[0]
        self.assertEqual((holder.timed_out, holder.ended, holder.refused, holder.error, holder.prices["bid"],
                          holder.prices["last"], holder.data_type), (True, False, False, None, None, 600.0, "live"))
        # an underlying with only a warning keeps its own error: not ibkr_error with code 300
        svc, gw, _c = chain_service(quotes={"STK": {"warn": (10090, "Part of requested market data"), "end": False}})
        gw._client.cancelMktData = answering_cancel(gw)
        status, body = svc.option_chain(q(symbol="SPY"))
        self.assertEqual((status, body["error"], body["ibkr_code"]), (502, "entitlement", 10090))

    def test_timeout_is_decided_when_the_holders_are_popped(self):
        # tickSnapshotEnd (or an error) that arrives after the wait ran out and before the pop still counts
        for late, expected in (("end", (4.1, 4.2, "live", None)), ("error", (None, None, "live", "no_security_definition"))):
            svc, gw, _c = chain_service(quotes={"STK": SPY_QUOTE, (600.0, "P"): "silent"})
            client, send = gw._client, gw._client.reqMktData

            def arrive(rid, late=late, gw=gw):
                gw.market_data_type(rid, 1)
                gw.tick_price(rid, 1, 4.1)
                gw.tick_price(rid, 2, 4.2)
                if late == "end":
                    gw.snapshot_end(rid)
                else:
                    gw.on_error(rid, 200, "No security definition has been found for the request")

            def late_send(rid, spec, *rest, gw=gw, send=send, arrive=arrive):
                send(rid, spec, *rest)
                if getattr(spec, "right", None) == "P":
                    gw.holders[rid].done = StaleDone(lambda: arrive(rid))

            client.reqMktData = late_send
            status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
            self.assertEqual(status, 200)
            row = body["quotes"][1]
            self.assertEqual((row["bid"], row["ask"], row["dataType"], row["error"]), expected, late)
            self.assertFalse(any(call[0] == "cancelMktData" for call in client.calls), late)  # IB ended it

    def test_cancel_only_for_requests_still_open_at_ib(self):
        many = [("SMART", "SPY", "100", {"20270115"}, {float(k) for k in range(500, 700)})]

        def counts(gw):
            names = [call[0] for call in gw._client.calls]
            return len(names), names.count("reqMktData"), names.count("cancelMktData")

        # every option request refused at once (an account without option data): 25 requests, no cancel
        svc, gw, _c = chain_service(sec_def=many)
        gw._client.default_quote = NOT_SUBSCRIBED
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="12"))[0], 502)
        self.assertEqual(counts(gw), (27, 25, 0))
        # the usual form of that case: the underlying is done on its prices, so it alone is cancelled
        svc, gw, _c = chain_service(sec_def=many, quotes={"STK": {4: 600.0, "md": 1, "end": False}})
        gw._client.default_quote = NOT_SUBSCRIBED
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="12"))[0], 502)
        self.assertEqual(counts(gw), (28, 25, 1))
        # every option request ended by IB with tickSnapshotEnd: no cancel
        svc, gw, _c = chain_service(sec_def=many)
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="12"))[0], 200)
        self.assertEqual(counts(gw), (27, 25, 0))
        # the most one call can send: 2 lookups, 25 requests and 25 cancels, when the underlying gave a price but
        # no tickSnapshotEnd in its window and no option request was answered
        svc, gw, _c = chain_service(sec_def=many, quotes={"STK": {4: 600.0, "md": 1, "end": False}})
        gw._client.default_quote = "silent"
        status, body = svc.option_chain(q(symbol="SPY", strikes="12"))
        self.assertEqual((status, {row["error"] for row in body["quotes"]}), (200, {"timeout"}))
        self.assertEqual(counts(gw), (52, 25, 25))
        cancelled = [call[1] for call in gw._client.calls if call[0] == "cancelMktData"]
        self.assertEqual(sorted(cancelled), sorted(call[1] for call in snapshot_calls(gw)))  # each id once
        # the underlying is closed (here: cancelled) before the first option request goes out
        names = [call[0] for call in gw._client.calls]
        self.assertEqual(names[2:5], ["reqMktData", "cancelMktData", "reqMktData"])
        # a gateway loss reported for all requests does not close them at IB: the open ones are cancelled
        svc, gw, _c = chain_service(quotes={"STK": SPY_QUOTE, (600.0, "C"): "silent", (602.5, "P"): "silent"})
        send = gw._client.reqMktData

        def lose_gateway(rid, spec, *rest):
            send(rid, spec, *rest)
            if (getattr(spec, "strike", None), getattr(spec, "right", None)) == (602.5, "P"):
                gw.on_error(-1, 1100, "Connectivity between IB and TWS has been lost")

        gw._client.reqMktData = lose_gateway
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual((status, body["error"]), (503, "unavailable"))
        still_open = [call[1] for call in snapshot_calls(gw) if call[7] in ((600.0, "C"), (602.5, "P"))]
        self.assertEqual([call[1] for call in gw._client.calls if call[0] == "cancelMktData"], still_open)
        self.assertEqual(gw.holders, {})

    def test_zero_prices_and_warning_rows(self):
        def row(prices, warning=True):
            holder = vh.QuoteSnapshot()
            for tick_type, price in prices.items():
                holder.tick(tick_type, price)
            holder.ended = True
            holder.warning = vh.IbError("entitlement", "Part of requested market data", 10090) if warning else None
            out = vh.option_quote_row(600.0, "C", holder)
            return out["bid"], out["ask"], out["last"], out["error"]

        # with a warning code, "a bid and an ask arrived" means a bid that is not null and an ask above 0
        self.assertEqual(row({1: 0.0, 2: 0.05, 4: 0.0}), (0.0, 0.05, 0.0, None))
        self.assertEqual(row({1: 4.1, 2: 4.2}), (4.1, 4.2, None, None))
        self.assertEqual(row({1: 0.0, 2: 0.0, 4: 0.0}), (None, None, None, "not_subscribed"))
        self.assertEqual(row({1: 4.1, 2: 0.0}), (None, None, None, "not_subscribed"))
        self.assertEqual(row({2: 4.2, 4: 4.1}), (None, None, None, "not_subscribed"))
        self.assertEqual(row({1: 4.1, 4: 4.1}), (None, None, None, "not_subscribed"))
        self.assertEqual(row({1: 4.1, 2: -1.0}), (None, None, None, "not_subscribed"))
        # without a warning a 0 tick is published as 0.0, as before
        self.assertEqual(row({1: 0.0, 2: 0.0, 4: 0.0}, warning=False), (0.0, 0.0, 0.0, None))
        warn = (10091, "Part of requested market data requires additional subscription for API")
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): {"warn": warn, 1: 0.0, 2: 0.05, "md": 1},
                  (600.0, "P"): {"warn": warn, 1: 0.0, 2: 0.0, 4: 0.0, "md": 1}}
        svc, _gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual(status, 200)
        self.assertEqual(body["quotes"], [
            {"strike": 600.0, "right": "C", "bid": 0.0, "ask": 0.05, "last": None, "dataType": "live", "error": None},
            {"strike": 600.0, "right": "P", "bid": None, "ask": None, "last": None, "dataType": "live",
             "error": "not_subscribed"}])


class OptionSubscriptionMemoTest(unittest.TestCase):
    """A wave whose option rows are all not_subscribed stops the IB calls of /option-chain for 900 s."""

    def refused(self, rest):
        return 502, {"error": "not_subscribed", "retry_after_seconds": rest,
                     "message": "IB reported no market data subscription for option quotes; the service asks IB "
                                "again after retry_after_seconds"}

    def test_memo_is_set_and_stops_ib_calls_for_900_seconds(self):
        self.assertEqual(vh.OPTION_NOT_SUBSCRIBED_SECONDS, 900)
        svc, gw, c = chain_service()
        gw._client.default_quote = NOT_SUBSCRIBED  # every option row
        connects = []
        gw._connect = lambda: connects.append(1)
        self.assertIsNone(svc.option_unsubscribed)
        # the wave that finds it out gets the same answer as the requests after it
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="3")), self.refused(900))
        self.assertEqual([call[0] for call in gw._client.calls],
                         ["reqContractDetails", "reqSecDefOptParams"] + ["reqMktData"] * 7)
        self.assertEqual(svc.option_unsubscribed, c.t)
        key = vh.cache_key({"symbol": "SPY", "expiry": None, "strikes": 3, "endpoint": "option-chain"})
        self.assertIsNone(svc.cache.get(key, 10 ** 6))  # the refusal is not cached
        self.assertEqual(svc.logs[-1], ("option_chain_not_subscribed", {
            "symbol": "SPY", "expiry": "20270115", "quotes": 6, "retry_after_seconds": 900,
            "errors": "not_subscribed"}))
        sent, logged = len(gw._client.calls), len(svc.logs)
        # while the memo is fresh: the same answer for every valid request, with no IB call, no connect, no log line
        for seconds, rest, raw in ((0, 900, q(symbol="SPY", strikes="3")), (1, 899, q(symbol="QQQ")),
                                   (30, 869, q(symbol="SPY", expiry="20270122", strikes="1")),
                                   (868.5, 1, q(symbol="SPY", strikes="3"))):
            c.sleep(seconds)
            self.assertEqual(svc.option_chain(raw), self.refused(rest), seconds)
        self.assertEqual((len(gw._client.calls), connects, len(svc.logs)), (sent, [1], logged))
        self.assertFalse(svc.option_lock.locked())
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="13"))[0], 400)  # validation comes first
        # after 900 s IB is asked again: one more wave, and the memo is set again
        c.sleep(0.5)
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="3")), self.refused(900))
        self.assertEqual([call[0] for call in gw._client.calls[sent:]], ["reqMktData"] * 7)
        self.assertEqual([event for event, _fields in svc.logs[logged:]], ["option_chain_not_subscribed"])
        sent = len(gw._client.calls)
        # the account got the subscription: the next wave after the memo is a normal answer, and nothing was cached
        gw._client.default_quote = {1: 1.0, 2: 1.2, 4: 1.1, "md": 1}
        gw._client.quotes = {"STK": SPY_QUOTE}
        c.sleep(900)
        status, body = svc.option_chain(q(symbol="SPY", strikes="3"))
        self.assertEqual((status, body["cache"]["hit"], [row["error"] for row in body["quotes"]]), (200, False, [None] * 6))
        self.assertEqual(len(gw._client.calls), sent + 7)
        c.sleep(vh.OPTION_TTL + 1)
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="3"))[1]["cache"]["hit"], False)  # IB again

    def test_only_a_wave_with_every_row_not_subscribed_sets_the_memo(self):
        cases = (
            # one good row among refused ones: the account has option data
            ({"STK": SPY_QUOTE, (600.0, "C"): {1: 4.1, 2: 4.2, "md": 1}}, NOT_SUBSCRIBED, 200),
            # no good row, but no not_subscribed row either
            ({"STK": SPY_QUOTE, (600.0, "C"): (200, "none")}, "silent", 200),
            ({"STK": SPY_QUOTE}, (10197, "No market data during competing live session"), 200),
            # one not_subscribed row among rows that IB does not list, or among rows without an answer
            ({"STK": SPY_QUOTE, (600.0, "C"): {"warn": (10090, "Part of requested market data"), "end": False}},
             (200, "No security definition has been found for the request"), 200),
            ({"STK": SPY_QUOTE, (600.0, "C"): "silent"}, NOT_SUBSCRIBED, 200),
            # every row not_subscribed: refused at once, or a warning code and nothing after it
            ({"STK": SPY_QUOTE}, NOT_SUBSCRIBED, 502),
            ({"STK": SPY_QUOTE}, {"warn": (10090, "Part of requested market data is not subscribed"), "end": False}, 502))
        for quotes, default, expected in cases:
            svc, gw, c = chain_service(quotes=quotes)
            gw._client.default_quote = default
            status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
            self.assertEqual((status, svc.option_unsubscribed is not None), (expected, expected == 502), default)
            sent = len(gw._client.calls)
            c.sleep(vh.OPTION_TTL + 1)
            svc.option_chain(q(symbol="SPY", strikes="1"))
            self.assertEqual(len(gw._client.calls) > sent, expected == 200, default)
            names = [event for event, _fields in svc.logs]
            self.assertEqual(names.count("option_chain_not_subscribed"), 1 if expected == 502 else 0)
        # a fresh cached answer is still served while the memo is fresh; after that the memo answers, before the
        # lock, so a request does not wait behind a running fetch
        svc, gw, c = chain_service()
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="1"))[0], 200)
        gw._client.default_quote = NOT_SUBSCRIBED
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="2"))[0], 502)
        sent = len(gw._client.calls)
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["cache"]["hit"], body["quotes"][0]["error"]), (200, True, None))
        c.sleep(vh.OPTION_TTL)  # the copy is no longer fresh: the memo answers, not a stale copy
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["error"], body["retry_after_seconds"]), (502, "not_subscribed", 870))
        self.assertEqual(len(gw._client.calls), sent)
        svc.option_lock.acquire()
        try:
            with mock.patch.object(vh, "OPTION_MAX_WAIT", 0.01):
                self.assertEqual(svc.option_chain(q(symbol="QQQ"))[0], 502)  # not 429 busy
        finally:
            svc.option_lock.release()
        # the memo belongs to one service (one process), and the switch check still comes before it
        svc, gw, _c = chain_service(option_quotes=False)
        svc.option_unsubscribed = svc.clock()
        self.assertEqual(svc.option_chain(q(symbol="SPY"))[0], 403)
        # a clock that went back does not stretch the memo
        svc, gw, c = chain_service()
        svc.option_unsubscribed = c.t + 5000
        self.assertEqual(svc.option_chain(q(symbol="SPY"))[0], 200)

    def test_a_request_that_waited_for_the_lock_sees_the_memo(self):
        svc, gw, c = chain_service()
        real = svc.option_lock

        class SetsMemo:
            """The lock as a waiting request sees it: the request before it found no subscription."""

            def acquire(self, timeout=None):
                svc.option_unsubscribed = c.t
                return real.acquire(timeout=timeout)

            def release(self):
                real.release()

        svc.option_lock = SetsMemo()
        self.assertEqual(svc.option_chain(q(symbol="SPY")), self.refused(900))
        self.assertEqual((gw._client.calls, real.locked()), ([], False))


class OptionRowCompletionTest(unittest.TestCase):
    """A request is done when it has what its caller needs; a wave does not wait for tickSnapshotEnd."""

    def test_done_is_set_by_the_tick_that_completes_the_request(self):
        for prices, option, underlying in (({}, False, False), ({"bid": 4.1}, False, False), ({"ask": 4.2}, False, False),
                                           ({"bid": 4.1, "ask": 4.2}, True, True), ({"bid": 0.0, "ask": 0.05}, True, False),
                                           ({"bid": 4.1, "ask": 0.0}, False, False), ({"bid": 4.1, "ask": None}, False, False),
                                           ({"last": 4.1}, False, True), ({"last": 0.0, "close": 4.0}, False, False),
                                           ({"close": 4.0}, False, False)):
            self.assertEqual((vh.option_quote_complete(prices), vh.underlying_complete(prices)), (option, underlying), prices)
        gw = fake_gateway()
        scripts = ((vh.QuoteSnapshot(), ((4, 4.1, False), (1, 4.1, False), (2, 0.0, False), (2, -1.0, False), (2, 4.2, True))),
                   (vh.QuoteSnapshot(), ((66, 0.0, False), (67, 0.05, True))),  # 0 is a real bid; delayed ticks count
                   (vh.QuoteSnapshot(vh.underlying_complete), ((9, 598.0, False), (1, 600.1, False), (2, 600.3, True))),
                   (vh.QuoteSnapshot(vh.underlying_complete), ((9, 598.0, False), (4, 0.0, False), (4, 600.0, True))))
        for rid, (snap, steps) in enumerate(scripts, 5):
            gw.holders[rid] = snap
            for tick_type, price, done in steps:
                gw.tick_price(rid, tick_type, price)
                self.assertEqual(snap.done.is_set(), done, (rid, tick_type, price))
            self.assertEqual((snap.ended, snap.error, snap.timed_out), (False, None, False))

    def test_a_wave_does_not_wait_for_tick_snapshot_end(self):
        quotes = {"STK": {1: 600.1, 2: 600.3, "md": 1, "end": False},
                  (600.0, "C"): {1: 4.1, 2: 4.2, "md": 1, "end": False},
                  (600.0, "P"): {66: 0.0, 67: 0.05, 68: 0.02, "md": 3, "end": False},
                  (602.5, "C"): {"warn": (10167, "Displaying delayed market data"), 1: 2.0, 2: 2.1, "md": 3, "end": False},
                  (602.5, "P"): {1: 1.0, 2: 1.2, 4: 1.1, "md": 1}}  # this one IB ended
        svc, gw, _c = chain_service(quotes=quotes)
        gw.snapshot_wait = 30.0  # two waves that waited for their window would take a minute
        began = time.monotonic()
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertLess(time.monotonic() - began, 5.0)
        self.assertEqual(status, 200)
        under = body["underlying"]
        self.assertEqual((under["bid"], under["ask"], under["last"], under["close"], round(under["price"], 6),
                          under["dataType"]), (600.1, 600.3, None, None, 600.2, "live"))
        self.assertEqual([(row["strike"], row["right"], row["bid"], row["ask"], row["last"], row["dataType"], row["error"])
                          for row in body["quotes"]],
                         [(600.0, "C", 4.1, 4.2, None, "live", None), (600.0, "P", 0.0, 0.05, 0.02, "delayed", None),
                          (602.5, "C", 2.0, 2.1, None, "delayed", None), (602.5, "P", 1.0, 1.2, 1.1, "live", None)])
        # a request that completed on its prices is still open at IB: it is cancelled as soon as its wave ends
        ids = [call[1] for call in snapshot_calls(gw)]
        self.assertEqual([call[:2] for call in gw._client.calls[2:]],
                         [("reqMktData", ids[0]), ("cancelMktData", ids[0])] + [("reqMktData", rid) for rid in ids[1:]]
                         + [("cancelMktData", rid) for rid in ids[1:4]])
        self.assertEqual((svc.logs[-1][1]["quoted"], gw.holders), (4, {}))

    def test_a_row_without_bid_and_ask_at_the_end_of_the_window_is_timeout(self):
        quotes = {"STK": SPY_QUOTE, (600.0, "C"): {1: 4.1, 4: 4.0, "md": 1, "end": False},  # a bid and a last only
                  (600.0, "P"): {2: 4.2, "md": 1, "end": False},  # an ask only
                  (602.5, "C"): {1: 4.1, 2: 0.0, "md": 1, "end": False},  # an ask of 0
                  (602.5, "P"): {1: 4.1, 4: 4.0, "md": 1}}  # a bid and a last only, but IB ended the snapshot
        svc, gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual(status, 200)
        self.assertEqual([(row["bid"], row["ask"], row["last"], row["dataType"], row["error"]) for row in body["quotes"]],
                         [(None, None, None, "live", "timeout")] * 3 + [(4.1, None, 4.0, "live", None)])
        ids = [call[1] for call in snapshot_calls(gw)]
        self.assertEqual([call[1] for call in gw._client.calls if call[0] == "cancelMktData"], ids[1:4])
        # an underlying with only a close waits for its window, then the close is its price (the rule as before)
        svc, gw, _c = chain_service(quotes={"STK": {9: 598.0, "md": 2, "end": False}})
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["underlying"]["price"], body["underlying"]["last"]), (200, 598.0, None))
        self.assertEqual([call[0] for call in gw._client.calls[2:4]], ["reqMktData", "cancelMktData"])
        holder = gw._snapshots([types.SimpleNamespace(secType="STK", lastTradeDateOrContractMonth="", exchange="SMART",
                                                      currency="USD", conId=1)], None, vh.underlying_complete)[0]
        self.assertEqual((holder.done.is_set(), holder.timed_out, holder.prices["close"]), (False, True, 598.0))

    def test_ticks_from_another_thread_wake_the_wave(self):
        # the underlying completes on a last alone; its ticks come in the send, those of the options from a thread
        svc, gw, _c = chain_service(quotes={"STK": {4: 600.0, "md": 1, "end": False}, (600.0, "C"): "silent",
                                            (600.0, "P"): "silent"})
        gw.snapshot_wait = 30.0
        send = gw._client.reqMktData

        def later(rid, spec, *rest):
            send(rid, spec, *rest)
            if spec.secType == "OPT":
                def ticks():
                    gw.market_data_type(rid, 1)
                    gw.tick_price(rid, 1, 4.1)
                    gw.tick_price(rid, 2, 4.2)

                threading.Timer(0.05, ticks).start()

        gw._client.reqMktData = later
        began = time.monotonic()
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertLess(time.monotonic() - began, 5.0)
        self.assertEqual([(row["bid"], row["ask"], row["dataType"], row["error"]) for row in body["quotes"]],
                         [(4.1, 4.2, "live", None)] * 2)
        self.assertEqual([call[0] for call in gw._client.calls].count("cancelMktData"), 3)

    def test_no_wave_with_less_than_the_minimum_window(self):
        self.assertEqual(vh.OPTION_MIN_WINDOW, 3.0)
        # the lookups leave 2.5 s: no snapshot at all
        svc, gw, _c = chain_service(slow={"reqSecDefOptParams": (11.5, True)})
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["error"], snapshot_calls(gw)), (504, "timeout", []))
        # exactly 3 s are enough for both waves
        svc, gw, _c = chain_service(slow={"reqSecDefOptParams": (11.0, True)})
        self.assertEqual((svc.option_chain(q(symbol="SPY", strikes="1"))[0], len(snapshot_calls(gw))), (200, 3))
        # the underlying snapshot leaves 2.5 s: no option snapshot
        svc, gw, _c = chain_service(slow={"reqMktData": (11.5, True)})
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertEqual((status, body["error"], len(snapshot_calls(gw))), (504, "timeout", 1))
        self.assertEqual(gw.holders, {})
        gw = fake_gateway(quotes={"STK": SPY_QUOTE})
        spec = types.SimpleNamespace(secType="STK", lastTradeDateOrContractMonth="", exchange="SMART", currency="USD",
                                     conId=1)
        with self.assertRaises(vh.IbError) as caught:
            gw._snapshots([spec], lambda: 2.99)
        self.assertEqual((caught.exception.kind, gw._client.calls, gw.holders), ("timeout", [], {}))
        self.assertTrue(gw._snapshots([spec], lambda: 3.0)[0].ended)


class MessageLimiterTest(unittest.TestCase):
    """reqMktData and cancelMktData of the option path: at most 40 in any one second."""

    def assert_rate(self, stamps, limit, period=1.0):
        for start in stamps:
            self.assertLessEqual(sum(1 for stamp in stamps if start <= stamp < start + period), limit, start)

    def test_limiter_waits_when_the_window_is_full(self):
        clock, sleeps, stamps = Clock(100.0), [], []

        def pause(seconds):
            sleeps.append(seconds)
            clock.sleep(seconds)

        limiter = vh.MessageLimiter(3, clock=clock, sleep=pause)
        for step in (0, 0, 0, 0, 0.25, 0, 0, 2.0, 0):
            clock.sleep(step)
            limiter.wait()
            stamps.append(clock.t - 100.0)
        self.assertEqual((stamps, sleeps), ([0, 0, 0, 1.0, 1.25, 1.25, 2.0, 4.0, 4.0], [1.0, 0.75]))
        self.assert_rate(stamps, 3)
        real = vh.IbGateway("/nonexistent").option_limiter
        self.assertEqual((real.limit, real.period, real.clock, real.sleep, vh.OPTION_MESSAGES_PER_SECOND),
                         (40, 1.0, time.monotonic, time.sleep, 40))

    def test_a_full_call_never_sends_more_than_40_option_messages_in_one_second(self):
        many = [("SMART", "SPY", "100", {"20270115"}, {float(k) for k in range(500, 700)})]
        # the usual case: every request completes on its prices without tickSnapshotEnd, so every one is cancelled
        svc, gw, c = chain_service(sec_def=many, quotes={"STK": {4: 600.0, "md": 1, "end": False}})
        gw._client.default_quote = {1: 1.0, 2: 1.2, "md": 1, "end": False}
        stamps, client = [], gw._client
        for name in ("reqMktData", "cancelMktData"):
            def stamped(*args, send=getattr(client, name)):
                stamps.append(c.t)
                return send(*args)

            setattr(client, name, stamped)
        status, body = svc.option_chain(q(symbol="SPY", strikes="12"))
        self.assertEqual((status, [row["error"] for row in body["quotes"]]), (200, [None] * 24))
        names = [call[0] for call in client.calls]
        self.assertEqual((names.count("reqMktData"), names.count("cancelMktData"), len(stamps)), (25, 25, 50))
        self.assert_rate(stamps, 40)
        # 40 at once, then the last 10 cancels one second later
        self.assertEqual((stamps.count(stamps[0]), stamps.count(stamps[0] + 1.0), gw.limiter_sleeps), (40, 10, [1.0]))
        # the next call comes right after (another key, 5 s spacing): the bound holds over both calls
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="11"))[0], 200)
        self.assertEqual(len(stamps), 50 + 46)
        self.assert_rate(stamps, 40)
        # up to 9 strikes a call stays under the limit and never waits
        svc, gw, c = chain_service(sec_def=many, quotes={"STK": {4: 600.0, "md": 1, "end": False}})
        gw._client.default_quote = {1: 1.0, 2: 1.2, "md": 1, "end": False}
        self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="9"))[0], 200)
        self.assertEqual((len(gw._client.calls), gw.limiter_sleeps), (2 + 2 + 18 + 18, []))

    def test_the_wait_of_the_limiter_uses_the_request_budget(self):
        svc, gw, c = chain_service(slow={"reqContractDetails": (3, True), "reqSecDefOptParams": (3, True)})
        gw.snapshot_wait = vh.OPTION_SNAPSHOT_SECONDS
        gw.option_limiter.sent.extend([c.t + 6.0] * 39)  # 39 option messages just before the underlying request
        waits = []
        with mock.patch.object(vh.threading.Event, "wait", lambda self, timeout=None: waits.append(timeout) or self.is_set()):
            self.assertEqual(svc.option_chain(q(symbol="SPY", strikes="1"))[0], 200)
        self.assertEqual((gw.limiter_sleeps, waits[:2]), ([1.0], [11.0, 8.0]))
        # the first option request had to wait: the option wave gets 8 s less the second the limiter took
        self.assertTrue(all(6.9 < wait <= 7.0 for wait in waits[3:]), waits)


class OptionFinalReviewTest(unittest.TestCase):
    """Rules from the last review: the underlying window, ticks that are not prices, dataType without
    marketDataType, and a cancel that the limiter cannot skip."""

    def test_underlying_window_leaves_room_for_the_option_wave(self):
        self.assertEqual((vh.OPTION_UNDERLYING_SECONDS, vh.IbGateway("/nonexistent").underlying_wait), (4.0, 4.0))
        self.assertLessEqual(vh.OPTION_MAX_WAIT + vh.OPTION_MIN_INTERVAL + vh.OPTION_UNDERLYING_SECONDS
                             + vh.OPTION_MIN_WINDOW, vh.OPTION_DEADLINE)
        for worst in (False, True):
            # an underlying that sends only a close: no tickSnapshotEnd, nothing that ends the wait
            svc, gw, c = chain_service(quotes={"STK": {9: 598.0, "md": 2, "end": False}})
            gw.snapshot_wait, gw.underlying_wait = vh.OPTION_SNAPSHOT_SECONDS, vh.OPTION_UNDERLYING_SECONDS
            if worst:  # 2 s of lock wait, then the full 5 s of spacing
                real = svc.option_lock

                class SlowLock:
                    def acquire(self, timeout=None, svc=svc, c=c, real=real):
                        c.sleep(vh.OPTION_MAX_WAIT)
                        svc.option_last = c.t
                        return real.acquire(timeout=timeout)

                    def release(self, real=real):
                        real.release()

                svc.option_lock = SlowLock()
            start, waits = c.t, []

            def wait(event, timeout=None, c=c, waits=waits):  # a wait that runs out takes its time on the clock
                waits.append(timeout)
                if not event.is_set():
                    c.sleep(timeout)
                return event.is_set()

            with mock.patch.object(vh.threading.Event, "wait", wait):
                status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
            self.assertEqual((status, body["underlying"]["price"], body["underlying"]["last"]), (200, 598.0, None), worst)
            self.assertEqual([row["error"] for row in body["quotes"]], [None, None])  # the option wave was sent
            self.assertEqual([call[0] for call in gw._client.calls[2:]],
                             ["reqMktData", "cancelMktData", "reqMktData", "reqMktData"])
            # the underlying waited its 4 s window; the option wave got what was left of the 14 s
            left = 3.0 if worst else 10.0
            self.assertTrue(3.99 < waits[2] <= 4.0 and all(abs(wait - left) < 0.01 for wait in waits[3:]), waits)
            self.assertAlmostEqual(c.t - start, 11.0 if worst else 4.0, places=2)

    def test_a_tick_that_is_not_a_price_never_replaces_a_price(self):
        bad = (-1.0, float("nan"), float("inf"), sys.float_info.max, 1e9)
        snap = vh.QuoteSnapshot()
        for tick_type, price in ((1, 1.0), (2, 1.2), (4, 1.1)) + tuple((2, value) for value in bad):
            snap.tick(tick_type, price)
        self.assertEqual((snap.prices, snap.done.is_set(), vh.option_quote_complete(snap.prices)),
                         ({"bid": 1.0, "ask": 1.2, "last": 1.1, "close": None}, True, True))
        snap.tick(2, 1.3)  # a later price still replaces
        snap.tick(1, 0.0)
        self.assertEqual((snap.prices["bid"], snap.prices["ask"]), (0.0, 1.3))
        # an option row and the underlying that are done stay done: a good row, a price, no timeout
        svc, gw, _c = chain_service(quotes={"STK": "silent", (600.0, "C"): "silent"})
        gw.snapshot_wait = gw.underlying_wait = 30.0
        send = gw._client.reqMktData

        def then_not_a_price(rid, spec, *rest):
            send(rid, spec, *rest)
            ticks = ((4, 600.0), (4, -1.0)) if spec.secType == "STK" else ((1, 1.0), (2, 1.2), (2, -1.0), (1, float("nan")))
            if getattr(spec, "right", "C") == "C":
                for tick_type, price in ticks:
                    gw.tick_price(rid, tick_type, price)

        gw._client.reqMktData = then_not_a_price
        began = time.monotonic()
        status, body = svc.option_chain(q(symbol="SPY", strikes="1"))
        self.assertLess(time.monotonic() - began, 5.0)
        self.assertEqual((status, body["underlying"]["last"], body["underlying"]["price"]), (200, 600.0, 600.0))
        self.assertEqual(body["quotes"][0], {"strike": 600.0, "right": "C", "bid": 1.0, "ask": 1.2, "last": None,
                                             "dataType": None, "error": None})

    def test_data_type_without_market_data_type(self):
        def reported(ticks, market_data_type=None):
            snap = vh.QuoteSnapshot()
            if market_data_type is not None:
                snap.market_data_type(market_data_type)
            for tick_type, price in ticks:
                snap.tick(tick_type, price)
            return snap.reported_type()

        self.assertEqual(vh.DELAYED_PRICE_TICKS, {66, 67, 68, 75})
        self.assertEqual(reported(((66, 3.0), (67, 3.1))), "delayed")  # delayed tick types only
        self.assertEqual(reported(((75, 3.0),)), "delayed")
        self.assertIsNone(reported(((1, 3.0), (2, 3.1), (4, 3.0), (9, 2.9))))  # live tick types: not called live
        self.assertEqual(reported(((1, 3.0), (67, 3.1))), "delayed")  # both kinds
        self.assertIsNone(reported(((1, 3.0), (67, -1.0))))  # a delayed tick that is not a price does not count
        self.assertIsNone(reported(()))
        for value, name in ((1, "live"), (2, "frozen"), (3, "delayed"), (4, "delayed-frozen")):
            self.assertEqual(reported(((66, 3.0), (2, 3.1)), value), name)  # what IB reported always wins
        quotes = {"STK": {68: 601.0, "end": False}, (600.0, "C"): {66: 3.0, 67: 3.1, "end": False},
                  (600.0, "P"): {1: 3.0, 2: 3.1, "end": False}, (602.5, "C"): {1: 3.0, 67: 3.1},
                  (602.5, "P"): {66: 3.0, 67: 3.1, "md": 4}}
        svc, _gw, _c = chain_service(quotes=quotes)
        status, body = svc.option_chain(q(symbol="SPY", strikes="2"))
        self.assertEqual((status, body["underlying"]["dataType"]), (200, "delayed"))
        self.assertEqual([(row["dataType"], row["error"]) for row in body["quotes"]],
                         [("delayed", None), (None, None), ("delayed", None), ("delayed-frozen", None)])

    def test_a_limiter_that_fails_cannot_skip_a_cancel(self):
        many = [("SMART", "SPY", "100", {"20270115"}, {float(k) for k in range(500, 700)})]
        svc, gw, c = chain_service(sec_def=many, quotes={"STK": {4: 600.0, "md": 1, "end": False}})
        gw._client.default_quote = {1: 1.0, 2: 1.2, "md": 1, "end": False}  # every request stays open at IB
        failures = []

        def broken(seconds):
            raise OSError("no sleep")

        gw.option_limiter = vh.MessageLimiter(vh.OPTION_MESSAGES_PER_SECOND, clock=c, sleep=broken)
        gw.log = lambda event, **fields: failures.append((event, fields.get("kind")))
        status, body = svc.option_chain(q(symbol="SPY", strikes="12"))
        self.assertEqual((status, [row["error"] for row in body["quotes"]]), (200, [None] * 24))
        cancelled = [call[1] for call in gw._client.calls if call[0] == "cancelMktData"]
        self.assertEqual(sorted(cancelled), sorted(call[1] for call in snapshot_calls(gw)))  # all 25, each once
        # 26 sends passed the limiter, then 14 cancels; the wait of each of the last 10 failed and was logged
        self.assertEqual(failures.count(("ib_option_limiter_failed", "OSError")), 10)
        self.assertEqual(gw.holders, {})

    def test_limiter_with_a_clock_that_goes_back_or_stands_still(self):
        clock, sleeps = Clock(100.0), []
        limiter = vh.MessageLimiter(40, clock=clock, sleep=sleeps.append)  # this sleep does not move the clock
        for _ in range(40):
            limiter.wait()
        clock.t = 50.0  # behind the newest recorded send: a new window, no sleep
        limiter.wait()
        self.assertEqual((sleeps, list(limiter.sent)), ([], [50.0]))
        # a clock that stands still: one wait sleeps one period at most, then starts a new window
        limiter = vh.MessageLimiter(2, clock=clock, sleep=sleeps.append)
        for _ in range(5):
            limiter.wait()
        self.assertEqual((sleeps, list(limiter.sent)), ([1.0, 1.0], [50.0]))
        # a clock that moves at a quarter of the speed: the sleeps of one wait add up to one period at most
        del sleeps[:]

        def slow(seconds):
            sleeps.append(seconds)
            clock.sleep(seconds / 4.0)

        limiter = vh.MessageLimiter(2, clock=clock, sleep=slow)
        limiter.sent.extend([50.0, 50.0])
        clock.t = 50.5
        limiter.wait()
        self.assertEqual((sleeps, sum(sleeps), list(limiter.sent)), ([0.5, 0.375, 0.125], 1.0, [50.75]))
        self.assertEqual(vh.IbGateway("/nonexistent").option_limiter.period, 1.0)  # so never more than 1 s


if __name__ == "__main__":
    unittest.main(verbosity=1)
