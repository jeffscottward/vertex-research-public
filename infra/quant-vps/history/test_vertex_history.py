#!/usr/bin/env python3
"""Tests for the read-only IBKR history service. Run: python3 infra/quant-vps/history/test_vertex_history.py"""
import ast
import json
import os
import re
import sys
import tempfile
import threading
import unittest
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
                    "cancelHistoricalData", "reqHeadTimeStamp"}
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
        ok = [("1 day", "1 Y"), ("1 day", "12 M"), ("1 day", "365 D"), ("5 mins", "1 M"), ("1 hour", "4 W"),
              ("1 min", "2 D"), ("15 mins", "31 D")]
        bad = [("1 day", "2 Y"), ("1 day", "13 M"), ("5 mins", "2 M"), ("1 hour", "5 W"), ("1 min", "3 D"),
               ("1 min", "1 W"), ("30 mins", "1 Y"), ("1 day", "0 D"), ("1 day", "1Y"), ("1 day", "1 S")]
        for bar, dur in ok:
            self.assertEqual(vh.validate(q(symbol="SPY", barSize=bar, duration=dur))["duration"], dur)
        for bar, dur in bad:
            with self.assertRaises(vh.BadRequest, msg=(bar, dur)):
                vh.validate(q(symbol="SPY", barSize=bar, duration=dur))

    def test_rejections(self):
        for raw in [q(symbol="SPY", secType="OPT"), q(symbol="SPY", secType="CASH"), q(symbol="", secType="STK"),
                    q(symbol="SPY;rm"), q(symbol="ES", secType="CONTFUT"), q(symbol="SPY", whatToShow="BID_ASK"),
                    q(symbol="SPY", barSize="1 secs"), q(symbol="SPY", account="x"), q(symbol="SPY", useRTH="yes"),
                    q(symbol="SPY", contractMonth="202612"), {"symbol": ["SPY", "QQQ"]}]:
            with self.assertRaises(vh.BadRequest, msg=raw):
                vh.validate(raw)

    def test_futures(self):
        r = vh.validate(q(symbol="ES", secType="CONTFUT", exchange="CME"))
        self.assertEqual((r["secType"], r["exchange"]), ("CONTFUT", "CME"))
        r = vh.validate(q(symbol="ES", secType="FUT", exchange="CME", contractMonth="202612"))
        self.assertEqual(r["contractMonth"], "202612")


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


def make_service(outcomes=None):
    c = Clock()
    gw = FakeGateway(outcomes)
    cache = vh.DiskCache(tempfile.mkdtemp(prefix="vx-hist-"), clock=c)
    svc = vh.HistoryService(gw, cache, vh.Pacer(c), clock=c, sleep=c.sleep)
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
        self.assertEqual(svc.bars(q(symbol="SPY", duration="5 Y"))[0], 400)
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

    def test_auth_and_routes(self):
        self.assertEqual(self.call("/vertex-history/v1/health", token=None)[0], 401)
        self.assertEqual(self.call("/vertex-history/v1/health", token="wrong")[0], 401)
        status, body = self.call("/vertex-history/v1/health")
        self.assertEqual((status, body["client_id"], body["connected"]), (200, 77, False))
        self.assertEqual(self.call("/vertex-history/v1/other")[0], 404)
        self.assertEqual(self.call("/vertex-history/v1/bars?symbol=SPY", method="POST")[0], 405)
        self.assertEqual(self.call("/vertex-history/v1/bars?symbol=SPY&duration=9%20Y")[0], 400)
        status, body = self.call("/vertex-history/v1/bars?symbol=SPY&barSize=1%20day&duration=1%20Y")
        self.assertEqual((status, body["count"]), (200, 2))
        self.assertNotIn(TOKEN, json.dumps(body))


if __name__ == "__main__":
    unittest.main(verbosity=1)
