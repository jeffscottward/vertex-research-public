#!/usr/bin/env python3
"""Tests for the read-only IBKR portfolio monitor. Run: python3 infra/quant-vps/portfolio/test_vertex_portfolio.py

No network and no ibapi needed: a fake client stands in for EClient. All account codes are fictional.
"""
import ast
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace as NS

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vertex_portfolio as vp  # noqa: E402

SOURCE_PATH = os.path.join(HERE, "vertex_portfolio.py")
with open(SOURCE_PATH) as _f:
    SOURCE = _f.read()

# Order-changing or account-changing entry points. None may appear anywhere in the service source.
# reqOpenOrders is read-only, but it binds to client 0 semantics; the service uses reqAllOpenOrders only.
FORBIDDEN = [
    "placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions", "reqAutoOpenOrders", "reqOpenOrders",
    "reqIds", "replaceFA", "requestFA", "ibapi.order", "reqAccountUpdatesMulti", "reqPositionsMulti",
    "cancelPositions", "cancelAccountSummary", "cancelPnL",
]
ALLOWED_IB_CALLS = {"connect", "disconnect", "isConnected", "run", "reqPositions", "reqAccountSummary",
                    "reqAccountUpdates", "reqPnL", "reqPnLSingle", "reqAllOpenOrders", "reqCompletedOrders",
                    "reqExecutions"}

TOKEN = "t" * 40


class FakeClock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t
        self.slept = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s
        if s < 1:
            time.sleep(0.002)  # let the fake reader thread run


def contract(con, symbol, sec="STK", **kw):
    base = dict(conId=con, symbol=symbol, secType=sec, currency="USD", right="", strike=0.0,
                lastTradeDateOrContractMonth="", multiplier="", localSymbol=symbol)
    base.update(kw)
    return NS(**base)


def order(order_id, perm, **kw):
    base = dict(clientId=1, orderId=order_id, permId=perm, parentId=0, ocaGroup="", orderRef="", action="BUY",
                orderType="LMT", totalQuantity=10, filledQuantity=1.7976931348623157e308, lmtPrice=100.0,
                auxPrice=1.7976931348623157e308, trailingPercent=1.7976931348623157e308,
                trailStopPrice=1.7976931348623157e308, tif="DAY", outsideRth=False, transmit=True)
    base.update(kw)
    return NS(**base)


class FakeClient:
    """Stands in for EClient. Answers subscriptions by calling the state callbacks."""

    def __init__(self, state, script):
        self.state, self.script = state, script
        self.calls = []
        self.connected = False

    def connect(self, host, port, client_id):
        self.calls.append(("connect", host, port, client_id))
        self.connected = self.script.get("connect", True)

    def isConnected(self):
        return self.connected

    def run(self):
        if self.script.get("handshake", True):
            self.state.managedAccounts(self.script.get("accounts", "DU1111111"))
            self.state.nextValidId(1)

    def disconnect(self):
        self.calls.append(("disconnect",))
        self.connected = False

    def __getattr__(self, name):
        if not name.startswith("req"):
            raise AttributeError(name)

        def call(*args):
            self.calls.append((name,) + args)
            hook = self.script.get(name)
            if hook:
                hook(self, *args)
            # Like the gateway: each request ends with its *End callback unless the script withholds it.
            if name not in self.script.get("withhold", ()):
                end = {"reqPositions": lambda: self.state.positionEnd(),
                       "reqAccountSummary": lambda: self.state.accountSummaryEnd(args[0]),
                       "reqAllOpenOrders": lambda: self.state.openOrderEnd(),
                       "reqCompletedOrders": lambda: self.state.completedOrdersEnd(),
                       "reqExecutions": lambda: self.state.execDetailsEnd(args[0]),
                       "reqAccountUpdates": lambda: self.state.accountDownloadEnd(args[1])}.get(name)
                if end and self.connected:
                    end()
        return call


class SafetyScanTest(unittest.TestCase):
    def test_no_order_methods(self):
        for name in FORBIDDEN:
            self.assertNotIn(name, SOURCE, name)

    def test_client_calls_are_allow_listed(self):
        tree = ast.parse(SOURCE)
        used = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Attribute) \
                    and node.value.attr == "_client":
                used.add(node.attr)
        self.assertTrue(used)
        self.assertLessEqual(used, ALLOWED_IB_CALLS)
        self.assertLessEqual(set(vp.IbMonitor.IB_CALLS), ALLOWED_IB_CALLS)
        self.assertLessEqual(used, set(vp.IbMonitor.IB_CALLS))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and re.match(r"^(req|cancel|place|exercise)[A-Z]", node.attr):
                self.assertIn(node.attr, ALLOWED_IB_CALLS, node.attr)

    def test_fixed_identity(self):
        self.assertEqual(vp.CLIENT_ID, 78)
        self.assertEqual((vp.LISTEN_HOST, vp.LISTEN_PORT), ("127.0.0.1", 8792))

    def test_scan_detects_forbidden_names(self):
        probe = "self._client." + "place" + "Order(1, c, o)"
        self.assertTrue(any(name in probe for name in FORBIDDEN))


class HelpersTest(unittest.TestCase):
    def test_num(self):
        self.assertIsNone(vp.num(1.7976931348623157e308))
        self.assertIsNone(vp.num(float("nan")))
        self.assertIsNone(vp.num("x"))
        self.assertIsNone(vp.num(None))
        self.assertEqual(vp.num("2.5"), 2.5)

    def test_scrub(self):
        for code in ("U1234567", "DU1234567", "DF7654321", "F9876543"):
            self.assertEqual(vp.scrub("acct %s ok" % code), "acct [account] ok")
        self.assertEqual(vp.scrub("ES 20261218"), "ES 20261218")

    def test_account_mode(self):
        self.assertEqual(vp.account_mode([]), "unknown")
        self.assertEqual(vp.account_mode(["DU1111111", "DF2222222"]), "paper")
        self.assertEqual(vp.account_mode(["DU1111111", "U3333333"]), "live")
        self.assertEqual(vp.account_mode(["U3333333"]), "live")

    def test_backoff(self):
        seq, b = [], 0.0
        for _ in range(6):
            b = vp.next_backoff(b)
            seq.append(b)
        self.assertEqual(seq, [10, 20, 40, 80, 120, 120])


def populated_state(clock):
    s = vp.PortfolioState(clock=clock)
    s.managedAccounts("DU1111111,DU2222222")
    s.position("DU1111111", contract(1, "AAPL"), 10, 150.0)
    s.position("DU1111111", contract(2, "MSFT"), 5, 300.0)
    s.position("DU2222222", contract(3, "ESZ6", "FUT", multiplier="50"), 1, 5000.0)
    s.position("DU1111111", contract(4, "OLD"), 0, 1.0)
    s.choose_main_account()
    for acct, nl, cushion in (("DU1111111", "1000", "0.5"), ("DU2222222", "250", "0.9")):
        s.accountSummary(1, acct, "NetLiquidation", nl, "USD")
        s.accountSummary(1, acct, "Cushion", cushion, "")
        s.accountSummary(1, acct, "BuyingPower", "1.7976931348623157E308", "USD")
        s.accountSummary(1, acct, "AccountCode", acct, "")
    s.updatePortfolio(contract(1, "AAPL"), 10, 160.0, 1600.0, 150.0, 100.0, 0.0, "DU1111111")
    s.pnl(9002, 12.5, 100.0, 1.7976931348623157e308)
    s.pnl_req[5001] = 1
    s.pnlSingle(5001, 10, 3.0, 100.0, 0.0, 1600.0)
    s.pnlSingle(9999, 1, 1, 1, 1, 1)
    s.openOrder(11, contract(1, "AAPL"), order(11, 501, ocaGroup="oca DU1111111", orderRef="ref U7654321"),
                NS(status="Submitted"))
    s.openOrder(12, contract(1, "AAPL"), order(12, 502, parentId=11, orderType="TRAIL", trailStopPrice=140.0),
                NS(status="PreSubmitted"))
    s.orderStatus(11, "Submitted", 0, 10, 0, 501, 0, 0, 1, "", 0)
    s.openOrderEnd()
    s.completedOrder(contract(2, "MSFT"), order(9, 400), NS(status="Filled", completedTime="20261009 10:00:00",
                                                            completedStatus="Filled DU1111111"))
    s.completedOrdersEnd()
    s.execDetails(7, contract(2, "MSFT"),
                  NS(execId="0001.DU1111111.01", time="20261009 10:00:00", side="BOT", shares=5, price=300.0,
                     avgPrice=300.0, cumQty=5, orderId=9, permId=400, clientId=1, exchange="NASDAQ",
                     orderRef="U1234567 ref"))
    s.commissionReport(NS(execId="0001.DU1111111.01", commission=1.0, realizedPNL=1.7976931348623157e308))
    s.execDetailsEnd(7)
    s.error(-1, 2104, "farm ok")
    s.error(5, 201, "Order rejected for account DU1111111")
    s.set_state("live")
    return s


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.state = populated_state(self.clock)
        self.doc = self.state.snapshot()

    def test_top_level(self):
        d = self.doc
        self.assertEqual(d["schema"], "vertex-portfolio-snapshot-v1")
        self.assertEqual((d["source"], d["clientId"], d["state"], d["connected"]), ("ibkr-gateway", 78, "live", True))
        self.assertEqual((d["accountMode"], d["accountCount"]), ("paper", 2))
        self.assertEqual(d["dataAsOf"], self.clock.t)
        self.assertEqual(d["ordersAsOf"], self.clock.t)
        self.assertEqual(set(d), {"schema", "source", "clientId", "version", "generatedAt", "state", "connected",
                                  "lastError", "accountMode", "accountCount", "dataAsOf", "ordersAsOf", "summary",
                                  "pnl", "positions", "orders", "completed", "executions", "errors"})

    def test_main_account_and_summary(self):
        self.assertEqual(self.state.main_acct, "DU1111111")
        self.assertEqual(self.doc["summary"], {"NetLiquidation": 1250.0, "Cushion": 0.5})

    def test_pnl_sentinel(self):
        self.assertEqual(self.doc["pnl"], {"daily": 12.5, "unrealized": 100.0, "realized": None})

    def test_positions(self):
        rows = {r["symbol"]: r for r in self.doc["positions"]}
        self.assertEqual(set(rows), {"AAPL", "MSFT"})
        a = rows["AAPL"]
        self.assertEqual((a["position"], a["acctMarketPrice"], a["dailyPnl"], a["pnlValue"]), (10, 160.0, 3.0, 1600.0))
        self.assertEqual(a["pnlT"], self.clock.t)
        self.assertIsNone(rows["MSFT"]["acctMarketPrice"])
        self.assertEqual(set(a), {"conId", "symbol", "secType", "currency", "right", "strike", "expiry",
                                  "multiplier", "localSymbol", "position", "avgCost", "acctMarketPrice",
                                  "acctMarketValue", "acctUnrealized", "realized", "pnlValue", "dailyPnl",
                                  "pnlUnrealized", "pnlT"})

    def test_orders(self):
        o = {x["orderId"]: x for x in self.doc["orders"]}
        self.assertEqual(o[11]["key"], "1:11:501")
        self.assertEqual((o[11]["remaining"], o[11]["filledQty"], o[11]["status"]), (10, 0, "Submitted"))
        self.assertIsNone(o[11]["aux"])
        self.assertEqual((o[12]["parentId"], o[12]["trailStop"], o[12]["remaining"]), (11, 140.0, None))
        self.assertEqual(o[11]["ocaGroup"], "oca [account]")
        self.assertEqual(o[11]["orderRef"], "ref [account]")
        c = self.doc["completed"][0]
        self.assertEqual((c["completedTime"], c["completedStatus"]), ("20261009 10:00:00", "Filled [account]"))

    def test_executions(self):
        e = self.doc["executions"][0]
        self.assertEqual(e["execId"], "0001.[account].01")
        self.assertEqual(e["orderRef"], "[account] ref")
        self.assertEqual((e["commission"], e["realized"]), (1.0, None))

    def test_errors(self):
        self.assertEqual([(e["code"], e["msg"]) for e in self.doc["errors"]],
                         [(201, "Order rejected for account [account]")])

    def test_no_account_code_anywhere(self):
        text = json.dumps(self.doc)
        self.assertIsNone(re.search(r"(DU|DF|U|F)\d{4,}", text))
        json.dumps(self.doc, allow_nan=False)

    def test_disconnected_hides_times(self):
        self.state.set_state("disconnected", "connection closed")
        d = self.state.snapshot()
        self.assertEqual((d["connected"], d["dataAsOf"], d["ordersAsOf"]), (False, None, None))
        self.assertEqual(d["lastError"], "connection closed")

    def test_health(self):
        h = self.state.health()
        self.assertEqual(h, {"schema": "vertex-portfolio-health-v1", "version": vp.VERSION, "clientId": 78,
                             "state": "live", "connected": True, "dataAsOf": self.clock.t})


FIXTURE = os.path.join(HERE, "fixtures", "sample-snapshot.json")


class FixtureTest(unittest.TestCase):
    # The installer runs this suite on the VPS without the fixtures folder; the repo run checks drift.
    @unittest.skipUnless(os.path.exists(FIXTURE), "fixture not shipped (VPS install)")
    def test_sample_snapshot_matches_fixture(self):
        # Regenerate: json.dumps(populated_state(FakeClock()).snapshot(), indent=2) + "\n"
        with open(FIXTURE) as f:
            fixture = f.read()
        self.assertEqual(json.dumps(populated_state(FakeClock()).snapshot(), indent=2) + "\n", fixture)


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        fd, self.gw = tempfile.mkstemp()
        with os.fdopen(fd, "w") as f:
            f.write("172.18.0.5 4003\n")
        self.state = vp.PortfolioState(clock=self.clock)
        self.clients = []

    def tearDown(self):
        os.unlink(self.gw)

    def monitor(self, script):
        def factory(state):
            c = FakeClient(state, script)
            self.clients.append(c)
            return c

        return vp.IbMonitor(self.state, self.gw, client_factory=factory, filter_factory=lambda: "filter",
                            clock=self.clock, sleep=self.clock.sleep)

    def test_full_session_then_reconnect(self):
        ticks = {"n": 0}

        def positions(c, *a):
            c.state.position("U5555555", contract(1, "AAPL"), 3, 10.0)
            c.state.position("U6666666", contract(2, "MSFT"), 0, 10.0)

        def open_orders(c, *a):
            ticks["n"] += 1
            if ticks["n"] == 3:
                c.state.error(-1, 1100, "Connectivity lost")

        script = {"accounts": "U5555555,U6666666", "reqPositions": positions, "reqAllOpenOrders": open_orders}
        m = self.monitor(script)
        orig = m.session

        def session():
            try:
                return orig()
            finally:
                self.assertEqual(self.state.state, "live")
                self.assertEqual(self.state.snapshot()["accountMode"], "live")
        m.session = session
        slept = m.run_once()
        names = [c[0] for c in self.clients[0].calls]
        self.assertEqual(self.clients[0].calls[0], ("connect", "172.18.0.5", 4003, 78))
        for n in ("reqPositions", "reqAccountSummary", "reqAccountUpdates", "reqPnL", "reqPnLSingle",
                  "reqAllOpenOrders", "reqCompletedOrders", "reqExecutions", "disconnect"):
            self.assertIn(n, names)
        self.assertEqual(names.count("reqPnLSingle"), 1)
        self.assertIn(("reqAccountUpdates", True, "U5555555"), self.clients[0].calls)
        self.assertIn(("reqCompletedOrders", False), self.clients[0].calls)
        self.assertEqual(names.count("reqAllOpenOrders"), 3)
        self.assertEqual((slept, m.failures), (10, 0))
        snap = self.state.snapshot()
        self.assertEqual((snap["state"], snap["connected"], snap["positions"], snap["dataAsOf"]),
                         ("disconnected", False, [], None))
        self.assertEqual(snap["lastError"], "api error 1100")
        self.assertNotIn("5555555", json.dumps(snap))

    def test_never_live_until_every_initial_feed_ends(self):
        # positionEnd never arrives: the half-loaded book must not be reported as live.
        def positions(c, *a):
            c.state.position("U5555555", contract(1, "AAPL"), 3, 10.0)

        seen = []
        events = []
        m = self.monitor({"accounts": "U5555555", "reqPositions": positions, "withhold": ("reqPositions",)})
        m.log = lambda event, **kw: events.append((event, kw))
        orig_sleep = m.sleep

        def sleep(s):
            seen.append(self.state.snapshot()["state"])
            orig_sleep(s)
        m.sleep = sleep
        m.run_once()
        self.assertNotIn("live", seen)
        self.assertEqual(m.failures, 1)
        snap = self.state.snapshot()
        self.assertEqual((snap["state"], snap["positions"], snap["dataAsOf"]), ("disconnected", [], None))
        self.assertEqual(snap["lastError"], "initial IBKR data did not complete")
        names = [c[0] for c in self.clients[0].calls]
        self.assertNotIn("reqAccountUpdates", names)
        self.assertIn(("initial_feeds_missing", {"feeds": ["positions"]}), events)

    def test_starting_snapshot_withholds_account_data(self):
        st = populated_state(FakeClock())
        st.set_state("starting")
        snap = st.snapshot()
        self.assertEqual((snap["summary"], snap["positions"], snap["orders"], snap["completed"], snap["executions"]),
                         ({}, [], [], [], []))
        self.assertEqual(snap["pnl"], {"daily": None, "unrealized": None, "realized": None})
        self.assertIsNone(snap["dataAsOf"])

    def test_missing_account_download_end_does_not_block_live(self):
        events = []
        ticks = {"n": 0}

        def positions(c, *a):
            c.state.position("U5555555", contract(1, "AAPL"), 3, 10.0)

        def open_orders(c, *a):
            ticks["n"] += 1
            if ticks["n"] == 2:
                c.state.error(-1, 1100, "Connectivity lost")

        m = self.monitor({"accounts": "U5555555", "reqPositions": positions, "reqAllOpenOrders": open_orders,
                          "withhold": ("reqAccountUpdates",)})
        m.log = lambda event, **kw: events.append(event)
        m.run_once()
        self.assertIn("account_updates_pending", events)
        self.assertEqual(m.failures, 0)  # it reached live

    def test_missing_completed_orders_end_does_not_block_live(self):
        # Observed 2026-10-28: the gateway answers every initial request except reqCompletedOrders.
        events = []
        ticks = {"n": 0}

        def open_orders(c, *a):
            ticks["n"] += 1
            if ticks["n"] == 7:  # about 90 s of the live loop: reqCompletedOrders is sent again
                c.state.error(-1, 1100, "Connectivity lost")

        def completed_orders(c, *a):
            # Rows arrive, completedOrdersEnd never does.
            c.state.completedOrder(contract(2, "MSFT"), order(9, 400),
                                   NS(status="Filled", completedTime="20261028 10:00:00", completedStatus="Filled"))

        m = self.monitor({"accounts": "U5555555", "reqAllOpenOrders": open_orders,
                          "reqCompletedOrders": completed_orders, "withhold": ("reqCompletedOrders",)})
        m.log = lambda event, **kw: events.append(event)
        seen = []
        buffered = []
        orig_sleep = m.sleep

        def sleep(s):
            snap = self.state.snapshot()
            seen.append((snap["state"], snap["completed"]))
            buffered.append(len(self.state.completed_buf))
            orig_sleep(s)
        m.sleep = sleep
        m.run_once()
        self.assertIn("completed_orders_pending", events)
        self.assertIn("ib_live", events)
        self.assertNotIn("initial_feeds_missing", events)
        # Live with an empty completed list: a half-received list is never shown.
        self.assertIn(("live", []), seen)
        self.assertNotIn("live", [state for state, completed in seen if completed])
        self.assertEqual(m.failures, 0)
        # Each new request starts a new buffer, so rows without an end do not pile up or repeat.
        names = [c[0] for c in self.clients[0].calls]
        self.assertGreaterEqual(names.count("reqCompletedOrders"), 2)
        self.assertEqual(max(buffered), 1)

    def test_completed_rows_start_over_on_each_request(self):
        st = vp.PortfolioState(clock=FakeClock())
        row = (contract(2, "MSFT"), order(9, 400), NS(status="Filled", completedTime="", completedStatus=""))
        st.completedOrder(*row)
        st.completedOrder(*row)
        st.begin_completed()
        st.completedOrder(*row)
        st.completedOrdersEnd()
        self.assertEqual(len(st.completed), 1)
        self.assertEqual(st.completed_buf, [])

    def test_backoff_doubles_without_live(self):
        m = self.monitor({"connect": False})
        got = [m.run_once() for _ in range(6)]
        self.assertEqual(got, [10, 20, 40, 80, 120, 120])
        self.assertEqual(m.failures, 6)
        self.assertEqual(self.state.health()["state"], "disconnected")

    def test_handshake_timeout_and_fatal_326(self):
        def run_326(c):
            c.state.error(-1, 326, "client id is already in use")

        m = self.monitor({"handshake": False})
        self.clients_script = None
        m.client_factory = lambda st: self._client_with_run(st, run_326)
        self.assertEqual(m.run_once(), 10)
        self.assertEqual(self.state.snapshot()["lastError"], "api error 326")
        self.assertEqual(self.state.snapshot()["errors"][-1]["code"], 326)

    def _client_with_run(self, state, fn):
        c = FakeClient(state, {"handshake": False})
        c.run = lambda: fn(c)
        self.clients.append(c)
        return c


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = populated_state(FakeClock())
        cls.server = vp.ThreadingHTTPServer(("127.0.0.1", 0), vp.make_handler(cls.state, TOKEN))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def req(self, path, token=TOKEN, method="GET"):
        r = urllib.request.Request(self.base + path, method=method)
        if token:
            r.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b"{}")

    def test_auth_and_routes(self):
        self.assertEqual(self.req("/vertex-portfolio/v1/snapshot", token=None)[0], 401)
        self.assertEqual(self.req("/vertex-portfolio/v1/snapshot", token="x" * 40)[0], 401)
        status, body = self.req("/vertex-portfolio/v1/snapshot")
        self.assertEqual((status, body["schema"]), (200, "vertex-portfolio-snapshot-v1"))
        status, body = self.req("/vertex-portfolio/v1/health")
        self.assertEqual((status, body["schema"], body["clientId"]), (200, "vertex-portfolio-health-v1", 78))
        self.assertEqual(self.req("/vertex-portfolio/v1/other")[0], 404)
        self.assertEqual(self.req("/vertex-portfolio/v1/snapshot", method="POST")[0], 405)
        self.assertEqual(self.req("/vertex-portfolio/v1/snapshot", method="DELETE")[0], 405)


if __name__ == "__main__":
    unittest.main(verbosity=1)
