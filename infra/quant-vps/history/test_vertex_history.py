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
                    "cancelMktDepth"}
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
        self.assertNotIn("reqMktData", SOURCE)  # no streaming top-of-book subscription either

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
                 slow=None):
        self.gw, self.md_mult, self.min_tick = gw, md_mult, min_tick
        self.slow = slow or {}  # call name -> (fake seconds it takes, answers at all)
        self.depth_script = depth_script or []
        self.ticks = ticks or {}
        self.depth_raises = depth_raises
        self.calls = []

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


def fake_gateway(**kw):
    gw = vh.IbGateway("/nonexistent", clock=Clock())
    gw._connect = lambda: None
    gw._spec = lambda req: types.SimpleNamespace(symbol=req["symbol"], secType=req["secType"],
                                                 exchange=req["exchange"], currency=req["currency"],
                                                 lastTradeDateOrContractMonth=req.get("contractMonth") or "",
                                                 conId=0)
    gw.depth_collect = 0.05
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
        for name in vh.IbGateway.IB_CALLS:
            self.assertTrue(hasattr(EClient, name), name)
        wrapper = vh._wrapper_class()
        for name in ("historicalTicksLast", "historicalTicksBidAsk", "updateMktDepth", "updateMktDepthL2"):
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
        self.assertEqual(self.call("/vertex-history/v1/bars?symbol=SPY&duration=9%20Y")[0], 400)
        status, body = self.call("/vertex-history/v1/bars?symbol=SPY&barSize=1%20day&duration=1%20Y")
        self.assertEqual((status, body["count"]), (200, 2))
        self.assertNotIn(TOKEN, json.dumps(body))


if __name__ == "__main__":
    unittest.main(verbosity=1)
