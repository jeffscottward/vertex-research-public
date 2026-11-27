#!/usr/bin/env python3
"""Fixture tests for the QuantVPS status collector. Run: python3 infra/quant-vps/status/test_collect.py"""
import atexit
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import collect  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "stopped-session")
# One temp root per test process holds every output folder; it is deleted at exit (card rig-tmp-vx-hist-recurred).
TEMP_ROOT = tempfile.mkdtemp(prefix="vx-status-")
atexit.register(shutil.rmtree, TEMP_ROOT, ignore_errors=True)
PLANTED = ["U1234567", "U7654321", "DU7654321", "hunter2fixture", "fixture-not-a-real-password", "fixturepw",
           "FixtureTok3nAbCdEfGhIjKlMnOpQrStUvWxYz0123", "FixtureBearerAbCdEf0123456789", "abc123fixture",
           "FixtureKey1234", "jeff@example.com", "FixtureStatusTokenAbCdEfGhIjKlMnOpQrStUv0123456789", "fixture-secret",
           "IBKR_ACCOUNT_ID", "TWS_PASSWORD", "POSTGRES_URL", "VENDOR_API_TOKEN", "0000000000000000000000000000000000000000"]


def run_fixture():
    out = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-")
    private = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-private-")
    assert collect.main(["--fixtures", FIXTURE, "--out", out, "--v2", "--v2-out", private]) == 0
    assert sorted(os.listdir(out)) == ["status.json"], "v2 must never land in the public dir"
    with open(os.path.join(out, "status.json")) as f:
        v1_text = f.read()
    with open(os.path.join(private, "status-v2.json")) as f:
        v2_text = f.read()
    return v1_text, v2_text


class CollectorFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v1_text, cls.v2_text = run_fixture()
        cls.v1, cls.v2 = json.loads(cls.v1_text), json.loads(cls.v2_text)

    def test_v1_unchanged_shape(self):
        self.assertEqual(set(self.v1), {"schema", "host", "generatedAt", "readOnly", "services"})
        self.assertEqual(self.v1["schema"], "vertex-deploy-status-v1")
        self.assertEqual([s["service"] for s in self.v1["services"]], collect.SERVICES)
        ibg = next(s for s in self.v1["services"] if s["service"] == "ib-gateway")
        self.assertEqual(set(ibg["log"]), {"lastLineAt", "lines", "errorLines", "warnLines"})
        self.assertEqual(ibg["log"]["warnLines"], 1)
        naut = self.v1["services"][0]
        self.assertNotIn("log", naut)
        self.assertEqual(set(naut), {"service", "present", "status", "running", "health", "startedAt", "finishedAt",
                                     "exitCode", "restartCount", "oomKilled", "image"})

    def test_v2_superset_of_v1(self):
        self.assertEqual(self.v2["schema"], "vertex-deploy-status-v2")
        for key in ("host", "generatedAt", "readOnly", "services"):
            self.assertEqual(self.v2[key], self.v1[key])
        for key in ("session", "positions", "orders", "fills", "equity", "risk", "logs"):
            block = self.v2[key]
            self.assertIn("available", block, key)
            self.assertIn("source", block, key)
            if block["available"]:
                self.assertIn("as_of", block, key)
            else:
                self.assertIn("reason", block, key)

    def test_session(self):
        s = self.v2["session"]
        self.assertEqual(s["state"], "stopped")
        self.assertEqual(s["raw_state"]["container_status"], "created")
        self.assertEqual(s["raw_state"]["last_runner_event"], "runner_stopped")
        self.assertIsNone(s["account_masked"])
        self.assertEqual(s["strategies"][0]["id"], "example_strategy")
        self.assertEqual(s["symbols"], ["AAPL"])
        self.assertEqual(s["last_heartbeat_at"], "2026-09-25T16:38:38Z")
        self.assertEqual(s["stopped_at"], "2026-09-25T16:38:44Z")
        self.assertEqual(s["started_at"], "2026-09-18T16:24:08Z")

    def test_positions_equity(self):
        p = self.v2["positions"]
        self.assertTrue(p["available"])
        self.assertFalse(p["stale"])
        self.assertEqual(p["as_of"], "2026-10-03T11:18:25Z")
        self.assertEqual(p["age_seconds"], 5)
        self.assertIn("ibkr-monitor.service", p["source"])
        orcl, aapl = p["items"]
        self.assertEqual((orcl["symbol"], orcl["qty"], orcl["avg_px"], orcl["currency"]), ("ORCL", 100, 100.5, "USD"))
        self.assertEqual((orcl["avg_cost"], orcl["multiplier"], orcl["market_price"], orcl["market_value"]), (100.5, None, 101.0, 10100.0))
        self.assertEqual((aapl["right"], aapl["strike"], aapl["expiry"], aapl["avg_px"], aapl["multiplier"]), ("C", 150, "20261120", 2.5, 100))
        self.assertEqual((aapl["avg_cost"], aapl["market_price"], aapl["market_value"], aapl["unrealized_pnl"], aapl["realized_pnl"]), (250.0, 3.1, 620.0, 120.0, 12.5))
        e = self.v2["equity"]
        self.assertTrue(e["available"])
        self.assertFalse(e["stale"])
        self.assertEqual(e["as_of"], "2026-10-03T11:18:25Z")
        self.assertEqual(e["age_seconds"], 5)
        self.assertIn("ibkr-monitor.service", e["source"])
        self.assertEqual((e["net_liq"], e["cash"], e["unrealized"], e["realized"], e["currency"]), (150000.25, 90000, 170, 12.5, "USD"))
        self.assertEqual((e["available_funds"], e["buying_power"]), (120000.5, 480002.0))

    def test_orders_fills(self):
        orders = self.v2["orders"]
        self.assertTrue(orders["available"])
        self.assertFalse(orders["stale"])
        self.assertEqual(orders["as_of"], "2026-10-03T11:18:22Z")
        self.assertEqual(orders["age_seconds"], 8)
        self.assertIn("ibkr-monitor.service", orders["source"])
        o = orders["items"]
        self.assertEqual((o[0]["type"], o[0]["stop"], o[0]["price"], o[0]["side"], o[0]["status"]), ("STP", 95, None, "sell", "PreSubmitted"))
        self.assertEqual((o[1]["type"], o[1]["price"], o[1]["order_id_masked"], o[1]["client_id"]), ("LMT", 200.25, "****4567", 31))
        self.assertEqual(o[1]["warning"], "Order held for account ****4321")
        fills = self.v2["fills"]
        self.assertTrue(fills["available"])
        self.assertFalse(fills["stale"])
        self.assertEqual(fills["as_of"], "2026-10-03T11:18:25Z")
        self.assertEqual(fills["age_seconds"], 5)
        self.assertIn("ibkr-monitor.service", fills["source"])
        f = fills["items"]
        self.assertEqual([x["side"] for x in f], ["sell", "buy"])
        self.assertEqual(f[0]["time"], "2026-09-11T19:45:00Z")
        self.assertEqual(self.v2["collector"]["version"], "2.4.0")
    def test_risk(self):
        r = self.v2["risk"]
        self.assertEqual(r["kill_switch"], "clear")
        self.assertEqual(r["limits"]["nautilus_risk_max_daily_loss_usd"], 1000)
        self.assertEqual(r["limits"]["nautilus_risk_allowed_instruments"], ["*"])
        self.assertEqual(r["limits"]["risk_denied_instruments"], [])
        self.assertEqual(r["watchdog"]["status"], "degraded")
        self.assertEqual(r["watchdog"]["required_failures"], ["ib_gateway", "nautilus_health"])
        self.assertEqual(r["last_risk_check"]["max_position_notional_usd"], 3000)

    def test_watchdog_flags_and_limits_are_allow_listed(self):
        r = self.v2["risk"]
        # The fixture's watchdog also reports a retired flag; only the allow-listed flags pass.
        self.assertEqual(r["watchdog"]["live_flags"], {"enable_live_trading": True, "kill_switch_active": False,
                                                       "nautilus_risk_dry_run": False, "trading_mode": "live"})
        self.assertNotIn("retired_order_feed_enabled", self.v2_text)
        self.assertTrue(set(r["limits"]) - {"available", "source", "as_of"} <= {k.lower() for k in collect.RISK_ENV_KEYS})
        self.assertNotIn("vendor_api_token", r["limits"])

    def test_logs_filtered_scrubbed_bounded(self):
        logs = self.v2["logs"]
        self.assertLessEqual(len(logs["items"]), 50)
        levels = {i["level"] for i in logs["items"]}
        self.assertTrue(levels <= {"WARNING", "ERROR"})
        msgs = [i["message"] for i in logs["items"]]
        self.assertFalse(any("listening on" in m for m in msgs))
        socat = [i for i in logs["items"] if "socat" in i["message"]]
        self.assertEqual(len(socat), 1)
        self.assertEqual(socat[0]["count"], 3)
        self.assertTrue(any("check ib_gateway failed" in m for m in msgs))
        for i in logs["items"]:
            self.assertTrue(i["time"] and i["source"] and len(i["message"]) <= collect.MAX_MESSAGE)
        self.assertEqual(logs["items"], sorted(logs["items"], key=lambda i: i["time"], reverse=True))

    def test_no_planted_secret_leaks(self):
        for needle in PLANTED:
            self.assertNotIn(needle, self.v2_text, needle)
            self.assertNotIn(needle, self.v1_text, needle)
        self.assertEqual(collect.find_leaks(self.v2_text, "FixtureStatusTokenAbCdEfGhIjKlMnOpQrStUv0123456789"), [])
        self.assertIsNone(re.search(r"\bU\d{5,}\b", self.v2_text))

    def test_size_bounds(self):
        self.assertLess(len(self.v2_text.encode()), collect.SOFT_MAX_BYTES)
        doc = json.loads(self.v2_text)
        doc["logs"]["items"] = [{"time": "2026-10-03T00:00:00Z", "level": "ERROR", "source": "x", "message": "m" * 240, "count": 1}] * 50
        doc["positions"]["items"] = [dict(doc["positions"]["items"][0], symbol="S%d" % i) for i in range(200)]
        text = collect.enforce_size(doc)
        self.assertLessEqual(len(text.encode()), collect.HARD_MAX_BYTES)
        self.assertLessEqual(len(text.encode()), collect.SOFT_MAX_BYTES)

    def test_guard_withholds_on_leak(self):
        class Leaky(collect.FixtureInputs):
            def token(self):
                return "ORCL"  # too short to count; ensure guard ignores tiny tokens
        _, text, leaks = collect.build(Leaky(FIXTURE))
        self.assertEqual(leaks, [])
        self.assertIn("status token", collect.find_leaks('{"x":"%s"}' % ("Z" * 40), "Z" * 40))
        self.assertTrue(collect.find_leaks('{"m":"acct U1234567"}'))

class DefaultOffTest(unittest.TestCase):
    def test_v2_disabled_by_default_and_stale_file_removed(self):
        os.environ.pop(collect.V2_ENV, None)
        out = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-off-")
        with open(os.path.join(out, "status-v2.json"), "w") as f:
            f.write('{"schema":"vertex-deploy-status-v2"}')
        private = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-off-private-")
        with open(os.path.join(private, "status-v2.json"), "w") as f:
            f.write("{}")
        self.assertEqual(collect.main(["--fixtures", FIXTURE, "--out", out, "--v2-out", private]), 0)
        self.assertEqual(os.listdir(private), [])
        self.assertEqual(sorted(os.listdir(out)), ["status.json"])
        with open(os.path.join(out, "status.json")) as f:
            text = f.read()
        self.assertEqual(json.loads(text)["schema"], "vertex-deploy-status-v1")
        for needle in ("0042", "ORCL", "positions", "account"):
            self.assertNotIn(needle, text)



class PublicDirGuardTest(unittest.TestCase):
    def test_refuses_v2_into_public_dir(self):
        out = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-pub-")
        old = collect.OUT_DIR
        collect.OUT_DIR = out
        try:
            self.assertEqual(collect.main(["--fixtures", FIXTURE, "--out", out, "--v2", "--v2-out", out]), 0)
        finally:
            collect.OUT_DIR = old
        self.assertEqual(sorted(os.listdir(out)), ["status.json"])


class StateMappingTest(unittest.TestCase):
    def c(self, status, **kw):
        st = {"Status": status, "Running": status == "running", "ExitCode": kw.get("exit", 0), "OOMKilled": kw.get("oom", False)}
        if kw.get("health"):
            st["Health"] = {"Status": kw["health"]}
        return {"State": st}

    def test_mapping(self):
        m = collect.map_session_state
        ok = {"status": "ok"}
        self.assertEqual(m(None, None, None, False, None), "missing")
        self.assertEqual(m(None, None, None, False, None, absent="unreadable"), "unreadable")
        self.assertEqual(m(self.c("weird"), None, None, False, None), "unrecognised")
        self.assertEqual(m({"State": {}}, None, None, False, None), "unrecognised")
        self.assertEqual(m(self.c("running", health="healthy"), ok, 10, False, "strategy_heartbeat"), "running")
        self.assertEqual(m(self.c("running", health="healthy"), ok, 10, True, None), "halted")
        self.assertEqual(m(self.c("running", health="healthy"), ok, 900, False, None), "degraded")
        self.assertEqual(m(self.c("running", health="starting"), None, None, False, None), "starting")
        self.assertEqual(m(self.c("running"), ok, 5, False, "runner_stopping"), "stopping")
        self.assertEqual(m(self.c("restarting"), None, None, False, None), "starting")
        self.assertEqual(m(self.c("paused"), None, None, False, None), "paused")
        self.assertEqual(m(self.c("exited", exit=0), None, None, False, None), "stopped")
        self.assertEqual(m(self.c("exited", exit=137), None, None, False, None), "error")
        self.assertEqual(m(self.c("created"), None, None, False, None), "stopped")
        self.assertEqual(m(self.c("dead"), None, None, False, None), "error")

    def test_no_mapping_returns_unknown_never(self):
        m = collect.map_session_state
        for status in ("running", "restarting", "paused", "removing", "dead", "exited", "created", "weird", ""):
            self.assertNotEqual(m(self.c(status), None, None, False, None), "unknown", status)

    def test_scrub(self):
        s = collect.scrub
        self.assertEqual(s("acct U1234567 and DU0007654"), "acct ****4567 and ****7654")
        self.assertEqual(s("password=abc token: 'x y'"), "password=[redacted] token: [redacted]")
        self.assertNotIn("abcdef123456", s("Authorization: Bearer abcdef123456"))
        self.assertEqual(s("https://u:p@host/x"), "https://[redacted]@host/x")
        self.assertEqual(s("ConnectionError: HTTPConnectionPool(host='nautilus-trader', port=8080)"),
                         "ConnectionError: HTTPConnectionPool(host='nautilus-trader', port=8080)")
        self.assertEqual(collect.mask_account("U***9975"), "****9975")
        self.assertEqual(collect.iso("2026-09-29T23:45:02.407636734Z"), "2026-09-29T23:45:02Z")
        self.assertEqual(collect.iso("2026-09-18 16:24:08.74+00"), "2026-09-18T16:24:08Z")



class DefiniteStateTest(unittest.TestCase):
    """Card vertex-status-b1-quantvps: no session or kill-switch state is "unknown"."""

    def fixture_copy(self):
        import shutil
        root = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-fixture-")
        shutil.copytree(FIXTURE, root, dirs_exist_ok=True)
        return root

    def run_v2(self, root, private=None, now=None):
        out = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-")
        private = private or tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-status-private-")
        args = ["--fixtures", root, "--out", out, "--v2", "--v2-out", private]
        if now:
            args += ["--now", now]
        self.assertEqual(collect.main(args), 0)
        with open(os.path.join(private, "status-v2.json")) as f:
            return json.load(f), private

    def test_missing_container(self):
        root = self.fixture_copy()
        os.remove(os.path.join(root, "inspect", "nautilus-trader.json"))
        v2, _ = self.run_v2(root)
        self.assertEqual(v2["session"]["state"], "missing")

    def test_missing_container_and_health_file_still_names_the_state(self):
        root = self.fixture_copy()
        os.remove(os.path.join(root, "inspect", "nautilus-trader.json"))
        manifest_path = os.path.join(root, "manifest.json")
        with open(manifest_path) as f:
            manifest = json.load(f)
        health = [k for k, v in (manifest.get("files") or {}).items() if str(k).endswith("nautilus/health.json")]
        for key in health:
            del manifest["files"][key]
        with open(manifest_path, "w") as f:
            json.dump(manifest, f)
        v2, _ = self.run_v2(root)
        self.assertEqual((v2["session"]["available"], v2["session"]["state"]), (True, "missing"))
        self.assertEqual(set(v2["session"]) - {"available", "source", "as_of"} >= {"state", "state_since"}, True)

    def test_unreadable_docker(self):
        root = self.fixture_copy()
        os.remove(os.path.join(root, "inspect", "nautilus-trader.json"))
        open(os.path.join(root, "inspect", "nautilus-trader.unreadable"), "w").close()
        v2, _ = self.run_v2(root)
        self.assertEqual(v2["session"]["state"], "unreadable")

    def test_live_inspect_tells_missing_from_unreadable(self):
        replies = {"missing": (1, "", "Error: No such object: x"), "gone": (1, "", "Error response from daemon: No such container: x"),
                   "daemon": (1, "", "Cannot connect to the Docker daemon"), "timeout": (127, "", ""), "garbage": (0, "not json", "")}
        real = collect._sh
        try:
            for name, reply in replies.items():
                collect._sh = lambda args, timeout=8, stdin=None, reply=reply: reply
                got = collect.LiveInputs().inspect_status("nautilus-trader")[0]
                self.assertEqual(got, "missing" if name in ("missing", "gone") else "unreadable", name)
            collect._sh = lambda args, timeout=8, stdin=None: (0, '[{"State": {}}]', "")
            self.assertEqual(collect.LiveInputs().inspect_status("nautilus-trader"), ("ok", {"State": {}}))
        finally:
            collect._sh = real

    def test_state_since_carries_forward_and_resets(self):
        root = self.fixture_copy()
        first, private = self.run_v2(root, now="2026-11-15T10:00:00Z")
        state = first["session"]["state"]
        self.assertEqual(first["session"]["state_since"], "2026-11-15T10:00:00Z")
        second, _ = self.run_v2(root, private, now="2026-11-15T10:05:00Z")
        self.assertEqual(second["session"]["state"], state)
        self.assertEqual(second["session"]["state_since"], "2026-11-15T10:00:00Z")
        os.remove(os.path.join(root, "inspect", "nautilus-trader.json"))
        third, _ = self.run_v2(root, private, now="2026-11-15T10:10:00Z")
        self.assertEqual((third["session"]["state"], third["session"]["state_since"]), ("missing", "2026-11-15T10:10:00Z"))

    def test_state_since_ignores_a_bad_previous_snapshot(self):
        now = collect.parse_time("2026-11-15T10:00:00Z")
        for previous in (None, [], {"session": "x"}, {"session": {"state": "stopped", "state_since": "not a time"}}):
            self.assertEqual(collect.state_since(previous, "stopped", now), "2026-11-15T10:00:00Z")

    def test_kill_switch_unverified_when_a_file_check_has_no_answer(self):
        class NoAnswer(collect.FixtureInputs):
            def exists(self, path):
                return None if path == collect.KILL_SWITCH_FILES[0] else False
        inp = NoAnswer(FIXTURE)
        risk = collect.build_risk(inp, inp.now(), None, None, None)
        self.assertEqual(risk["kill_switch"], "unverified")
        self.assertIsNone(risk["kill_switch_indicators"][0]["engaged"])
        # The web names the unread files by this source format ("file <path>"); keep it.
        files = [i["source"] for i in risk["kill_switch_indicators"][:len(collect.KILL_SWITCH_FILES)]]
        self.assertEqual(files, ["file data/KILL_SWITCH", "file portfolio-ui/data/KILL_SWITCH"])


class LegacyZoneNameTest(unittest.TestCase):
    def test_us_eastern_parses_and_sorts_without_legacy_tzdata(self):
        import zoneinfo

        ny_src = None
        for root in zoneinfo.TZPATH:
            candidate = os.path.join(root, "America", "New_York")
            if os.path.isfile(candidate):
                ny_src = candidate
                break
        self.assertIsNotNone(ny_src, "America/New_York zoneinfo file not found in TZPATH")

        old_tzpath = zoneinfo.TZPATH
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as tmp_tzdir:
            ny_dst = os.path.join(tmp_tzdir, "America", "New_York")
            os.makedirs(os.path.dirname(ny_dst), exist_ok=True)
            shutil.copyfile(ny_src, ny_dst)
            zoneinfo.reset_tzpath([tmp_tzdir])
            zoneinfo.ZoneInfo.clear_cache()
            try:
                with self.assertRaises(zoneinfo.ZoneInfoNotFoundError):
                    zoneinfo.ZoneInfo("US/Eastern")
                self.assertEqual(collect.iso("20260911 15:30:01 US/Eastern"), "2026-09-11T19:30:01Z")
                self.assertEqual(collect.iso("20260115 15:30:01 US/Eastern"), "2026-01-15T20:30:01Z")
                self.assertEqual(collect.iso("20260911 15:30:01 America/New_York"), "2026-09-11T19:30:01Z")
                self.assertIsNone(collect.parse_time("20260911 15:30:01 Mars/Olympus"))
                self.assertIsNone(collect.parse_time("20260911 15:30:01 US/eastern"))

                _, v2_text = run_fixture()
                fills = json.loads(v2_text)["fills"]["items"]
                self.assertEqual([f["time"] for f in fills], ["2026-09-11T19:45:00Z", "2026-09-11T19:30:01Z"])
                self.assertEqual([f["side"] for f in fills], ["sell", "buy"])
            finally:
                zoneinfo.reset_tzpath(old_tzpath)
                zoneinfo.ZoneInfo.clear_cache()

class IbkrMonitorOrdersFillsTest(unittest.TestCase):
    def _base_snapshot(self):
        with open(os.path.join(FIXTURE, "ibkr-monitor-snapshot.json")) as f:
            return json.load(f)

    def _run_with_snapshot(self, payload, error=None):
        class Patched(collect.FixtureInputs):
            def ibkr_monitor_snapshot(self):
                return payload, error
        inp = Patched(FIXTURE)
        _, v2_text, leaks = collect.build(inp, True, None)
        return json.loads(v2_text), leaks

    def test_live_http_single_get_and_no_disk_fallback(self):
        import http.server
        import threading

        snap = self._base_snapshot()
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.command, self.path))
                body = json.dumps(snap).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        port = srv.server_address[1]
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            live = collect.LiveInputs(ibkr_monitor_url=f"http://127.0.0.1:{port}")

            class HttpBackedFixture(collect.FixtureInputs):
                def ibkr_monitor_snapshot(self):
                    return live.ibkr_monitor_snapshot()

            _, v2_text, leaks = collect.build(HttpBackedFixture(FIXTURE), True, None)
            self.assertEqual(leaks, [])
            doc = json.loads(v2_text)
            self.assertEqual(seen, [("GET", "/api/snapshot")])
            self.assertTrue(doc["positions"]["available"])
            self.assertEqual(doc["positions"]["count"], 2)
            self.assertTrue(doc["orders"]["available"])
            self.assertEqual(doc["orders"]["count"], 2)
            self.assertTrue(doc["fills"]["available"])
            self.assertEqual(doc["fills"]["count"], 2)
            self.assertTrue(doc["equity"]["available"])
            self.assertEqual(doc["equity"]["net_liq"], 150000.25)
        finally:
            srv.shutdown()
            srv.server_close()

        # After server shutdown (connection refused), all 4 broker blocks MUST fail closed (never disk fallback).
        doc_down, _ = self._run_with_snapshot(*live.ibkr_monitor_snapshot())
        self.assertFalse(doc_down["positions"]["available"])
        self.assertFalse(doc_down["orders"]["available"])
        self.assertFalse(doc_down["fills"]["available"])
        self.assertFalse(doc_down["equity"]["available"])
        self.assertNotIn(str(port), doc_down["orders"]["reason"])
        self.assertNotIn(str(port), doc_down["positions"]["reason"])

    def test_http_errors_redirects_content_type_and_size_cap_fail_closed(self):
        import http.server
        import threading

        mode = {"kind": "redirect"}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                k = mode["kind"]
                if k == "redirect":
                    self.send_response(302)
                    self.send_header("Location", "/other")
                    self.end_headers()
                elif k == "status503":
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":"secret U1234567"}')
                elif k == "html":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write(b"<html>nope</html>")
                elif k == "oversized":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b" " * 256)

            def log_message(self, format, *args):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        port = srv.server_address[1]
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            url = f"http://127.0.0.1:{port}/api/snapshot"
            for kind, expected_word in (
                ("redirect", "redirect"),
                ("status503", "503"),
                ("html", "content type"),
            ):
                mode["kind"] = kind
                doc, err, _ = collect._fetch_ibkr_monitor_json(url)
                self.assertIsNone(doc, kind)
                self.assertIn(expected_word, (err or "").lower(), kind)
                self.assertNotIn("U1234567", err or "")
            mode["kind"] = "oversized"
            doc, err, _ = collect._fetch_ibkr_monitor_json(url, max_bytes=64)
            self.assertIsNone(doc)
            self.assertIn("size cap", (err or "").lower())
        finally:
            srv.shutdown()
            srv.server_close()

    def test_url_validation_and_host_config_fallback(self):
        for good, expected in (
            ("http://127.0.0.1:3461", "http://127.0.0.1:3461/api/snapshot"),
            ("http://127.0.0.1:3461/", "http://127.0.0.1:3461/api/snapshot"),
            ("http://localhost:3461", "http://localhost:3461/api/snapshot"),
            ("http://[::1]:3461", "http://[::1]:3461/api/snapshot"),
            ("http://100.64.0.10:3461", "http://100.64.0.10:3461/api/snapshot"),
            ("http://100.127.255.254:3461", "http://100.127.255.254:3461/api/snapshot"),
        ):
            self.assertEqual(collect.validate_ibkr_monitor_base_url(good), expected)

        for bad in (
            "",
            "https://127.0.0.1:3461",
            "http://example.com:3461",
            "http://10.0.0.5:3461",
            "http://100.63.0.1:3461",
            "http://100.128.0.1:3461",
            "http://100.\u0664.0.1:3461",
            "http://user:pass@127.0.0.1:3461",
            "http://127.0.0.1:3461/api/ibkr-2fa",
            "http://127.0.0.1:3461?foo=bar",
            "http://127.0.0.1:3461#frag",
        ):
            with self.assertRaises(ValueError, msg=bad):
                collect.validate_ibkr_monitor_base_url(bad)

        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as d:
            hosts_env = os.path.join(d, "hosts.env")
            with open(hosts_env, "w") as f:
                f.write("# comment\nVERTEX_TAILNET_IPV4=100.64.0.10\n")
            urls, err = collect.ibkr_monitor_candidate_urls(None, hosts_env)
            self.assertIsNone(err)
            self.assertEqual(urls, [
                "http://127.0.0.1:3461/api/snapshot",
                "http://100.64.0.10:3461/api/snapshot",
            ])
            # Malformed tailnet IP is ignored safely (loopback remains).
            with open(hosts_env, "w") as f:
                f.write("VERTEX_TAILNET_IPV4=10.0.0.5\n")
            urls, err = collect.ibkr_monitor_candidate_urls(None, hosts_env)
            self.assertIsNone(err)
            self.assertEqual(urls, ["http://127.0.0.1:3461/api/snapshot"])

        # Explicit invalid override never silently falls back to loopback.
        urls, err = collect.ibkr_monitor_candidate_urls("http://example.com:3461")
        self.assertEqual(urls, [])
        self.assertIsNotNone(err)

    def test_fail_closed_on_bridge_down_mode_mismatch_and_missing_timestamps(self):
        for bridge in ("connecting", "disconnected", "restarting", "", None):
            snap = self._base_snapshot()
            snap["status"]["bridge"] = bridge
            doc, _ = self._run_with_snapshot(snap)
            self.assertFalse(doc["positions"]["available"], repr(bridge))
            self.assertFalse(doc["orders"]["available"], repr(bridge))
            self.assertFalse(doc["fills"]["available"], repr(bridge))
            self.assertFalse(doc["equity"]["available"], repr(bridge))

        snap = self._base_snapshot()
        snap["account"]["modeError"] = "mismatch"
        doc, _ = self._run_with_snapshot(snap)
        self.assertFalse(doc["positions"]["available"])
        self.assertFalse(doc["orders"]["available"])
        self.assertFalse(doc["fills"]["available"])
        self.assertFalse(doc["equity"]["available"])
        self.assertIn("mismatch", doc["orders"]["reason"])
        self.assertIn("mismatch", doc["positions"]["reason"])

        # ordersAsOf explicitly null -> orders fail closed (never fake 0 open orders); positions/fills/equity still work.
        snap = self._base_snapshot()
        snap["orders"] = []
        snap["ordersAsOf"] = None
        doc, _ = self._run_with_snapshot(snap)
        self.assertFalse(doc["orders"]["available"])
        self.assertIn("ordersAsOf", doc["orders"]["reason"])
        self.assertTrue(doc["fills"]["available"])
        self.assertTrue(doc["positions"]["available"])
        self.assertTrue(doc["equity"]["available"])

        # ordersAsOf key absent (older ibkr-monitor) -> falls back to status.dataAsOf.
        snap = self._base_snapshot()
        del snap["ordersAsOf"]
        doc, _ = self._run_with_snapshot(snap)
        self.assertTrue(doc["orders"]["available"])
        self.assertEqual(doc["orders"]["as_of"], "2026-10-03T11:18:25Z")

        # status.dataAsOf null -> positions, fills, and equity fail closed.
        snap = self._base_snapshot()
        snap["status"]["dataAsOf"] = None
        doc, _ = self._run_with_snapshot(snap)
        self.assertTrue(doc["orders"]["available"])
        self.assertFalse(doc["positions"]["available"])
        self.assertFalse(doc["fills"]["available"])
        self.assertFalse(doc["equity"]["available"])

        # Missing positions list or summary object -> respective blocks fail closed.
        snap = self._base_snapshot()
        del snap["positions"]
        doc, _ = self._run_with_snapshot(snap)
        self.assertFalse(doc["positions"]["available"])
        self.assertTrue(doc["equity"]["available"])

        snap = self._base_snapshot()
        snap["positions"] = ["not-a-dict"]
        doc, _ = self._run_with_snapshot(snap)
        self.assertFalse(doc["positions"]["available"])

        snap = self._base_snapshot()
        del snap["summary"]
        doc, _ = self._run_with_snapshot(snap)
        self.assertTrue(doc["positions"]["available"])
        self.assertFalse(doc["equity"]["available"])

        # status.stale true forces stale even with recent timestamps.
        snap = self._base_snapshot()
        snap["status"]["stale"] = True
        doc, _ = self._run_with_snapshot(snap)
        self.assertTrue(doc["positions"]["available"])
        self.assertTrue(doc["positions"]["stale"])
        self.assertTrue(doc["orders"]["available"])
        self.assertTrue(doc["orders"]["stale"])
        self.assertTrue(doc["fills"]["available"])
        self.assertTrue(doc["fills"]["stale"])
        self.assertTrue(doc["equity"]["available"])
        self.assertTrue(doc["equity"]["stale"])

        # Old ordersAsOf (> REPORT_STALE_SECONDS) marks orders stale even if status.stale is False.
        snap = self._base_snapshot()
        snap["ordersAsOf"] = 1791026310000 - (collect.REPORT_STALE_SECONDS + 30) * 1000
        doc, _ = self._run_with_snapshot(snap)
        self.assertTrue(doc["orders"]["available"])
        self.assertTrue(doc["orders"]["stale"])
        self.assertFalse(doc["positions"]["stale"])
        self.assertFalse(doc["fills"]["stale"])
        self.assertFalse(doc["equity"]["stale"])

        # Old status.dataAsOf (> REPORT_STALE_SECONDS) marks positions, fills, and equity stale.
        snap = self._base_snapshot()
        snap["status"]["dataAsOf"] = 1791026310000 - (collect.REPORT_STALE_SECONDS + 30) * 1000
        doc, _ = self._run_with_snapshot(snap)
        self.assertTrue(doc["positions"]["stale"])
        self.assertTrue(doc["fills"]["stale"])
        self.assertTrue(doc["equity"]["stale"])
        self.assertFalse(doc["orders"]["stale"])

    def test_position_and_equity_field_mapping_edge_cases(self):
        snap = self._base_snapshot()
        snap["positions"] = [
            {
                "id": "3003",
                "symbol": "SPY",
                "secType": "OPT",
                "currency": "USD",
                "right": "P",
                "strike": 500.0,
                "expiry": "20261218",
                "multiplier": 100,
                "position": 3,
                "avgPrice": 1.7976931348623157e+308,
                "avgCost": 425.0,
                "last": 1.7976931348623157e+308,
                "marketValue": 1500.0,
                "unrealized": 225.0,
                "realized": 1.7976931348623157e+308,
            },
            {
                "id": "4004",
                "symbol": "QQQ",
                "secType": "STK",
                "currency": "",
                "multiplier": 1,
                "position": 10,
                "avgPrice": 450.25,
                "last": 455.0,
                "marketValue": 4550.0,
                "unrealized": 47.5,
                "realized": 0.0,
            },
        ]
        # pnl uses IBKR Double.MAX -> falls back to summing position P&L values.
        snap["pnl"] = {"unrealized": 1.7976931348623157e+308, "realized": None}
        snap["summary"] = {
            "NetLiquidation": 1.7976931348623157e+308,
            "TotalCashValue": {"USD": "50000.5"},
            "AvailableFunds": 45000.0,
            "BuyingPower": 180000.0,
        }
        doc, leaks = self._run_with_snapshot(snap)
        self.assertEqual(leaks, [])
        p0, p1 = doc["positions"]["items"]
        self.assertEqual((p0["symbol"], p0["sec_type"], p0["qty"]), ("SPY", "OPT", 3))
        self.assertEqual((p0["avg_px"], p0["avg_cost"], p0["multiplier"]), (4.25, 425.0, 100))
        self.assertIsNone(p0["market_price"])
        self.assertIsNone(p0["realized_pnl"])
        self.assertEqual((p0["right"], p0["strike"], p0["expiry"]), ("P", 500.0, "20261218"))
        self.assertNotIn("right", p1)
        self.assertIsNone(p1["currency"])
        self.assertIsNone(p1["multiplier"])
        self.assertEqual((p1["avg_px"], p1["avg_cost"]), (450.25, 450.25))

        eq = doc["equity"]
        self.assertIsNone(eq["net_liq"])
        self.assertEqual((eq["cash"], eq["available_funds"], eq["buying_power"]), (50000.5, 45000.0, 180000.0))
        self.assertEqual((eq["unrealized"], eq["realized"]), (272.5, 0.0))

        # Explicit 0.0 in pnl is preserved (not treated as falsy).
        snap["pnl"] = {"unrealized": 0.0, "realized": 0.0}
        doc2, _ = self._run_with_snapshot(snap)
        self.assertEqual((doc2["equity"]["unrealized"], doc2["equity"]["realized"]), (0.0, 0.0))

        # FOP option fields, overflow avgPrice*multiplier -> None (valid JSON), NaN/inf/booleans rejected,
        # future dataAsOf clamped to age_seconds=0, and untrusted account_masked ignored.
        snap3 = self._base_snapshot()
        snap3["status"]["dataAsOf"] = 1791026310000 + 3000  # 3s ahead of fixture now
        snap3["account_masked"] = True
        snap3["positions"] = [
            {
                "id": "5005",
                "symbol": "ES",
                "secType": "FOP",
                "currency": "USD",
                "right": "C",
                "strike": 6000.0,
                "expiry": "20261218",
                "multiplier": 1e200,
                "position": True,
                "avgPrice": 1e200,
                "last": float("nan"),
                "marketValue": float("inf"),
                "unrealized": True,
                "realized": False,
            }
        ]
        snap3["summary"] = {
            "NetLiquidation": float("inf"),
            "TotalCashValue": float("nan"),
            "AvailableFunds": True,
            "BuyingPower": False,
        }
        snap3["pnl"] = {"unrealized": True, "realized": False}
        doc3, _ = self._run_with_snapshot(snap3)
        json.dumps(doc3, allow_nan=False)  # must never emit Infinity or NaN
        self.assertEqual(doc3["positions"]["age_seconds"], 0)
        self.assertFalse(doc3["positions"]["stale"])
        self.assertEqual(doc3["equity"]["age_seconds"], 0)
        self.assertIsNone(doc3["session"]["account_masked"])
        fop = doc3["positions"]["items"][0]
        self.assertEqual((fop["sec_type"], fop["right"], fop["strike"], fop["expiry"]), ("FOP", "C", 6000.0, "20261218"))
        self.assertIsNone(fop["qty"])
        self.assertIsNone(fop["avg_cost"])
        self.assertIsNone(fop["market_price"])
        self.assertIsNone(fop["market_value"])
        self.assertIsNone(fop["unrealized_pnl"])
        self.assertIsNone(fop["realized_pnl"])
        self.assertEqual(
            (doc3["equity"]["net_liq"], doc3["equity"]["cash"], doc3["equity"]["available_funds"], doc3["equity"]["buying_power"]),
            (None, None, None, None),
        )
        self.assertEqual((doc3["equity"]["unrealized"], doc3["equity"]["realized"]), (None, None))

        # Direct build_equity ignores boolean P&L values in position fallback.
        now_dt = collect.parse_time("2026-10-03T11:18:30+00:00")
        direct_snap = self._base_snapshot()
        direct_snap["pnl"] = {}
        fake_positions = {"available": True, "items": [{"unrealized_pnl": True, "realized_pnl": False}]}
        direct_eq = collect.build_equity(now_dt, direct_snap, fake_positions)
        self.assertEqual((direct_eq["unrealized"], direct_eq["realized"]), (None, None))

        # Truncation when positions exceed MAX_POSITIONS.
        snap_many = self._base_snapshot()
        snap_many["positions"] = [
            {"symbol": f"S{i}", "secType": "STK", "position": 1, "avgPrice": 10.0}
            for i in range(collect.MAX_POSITIONS + 5)
        ]
        doc_many, _ = self._run_with_snapshot(snap_many)
        self.assertEqual(doc_many["positions"]["count"], collect.MAX_POSITIONS)
        self.assertTrue(doc_many["positions"]["truncated"])

    def test_order_and_fill_field_mapping_edge_cases(self):
        snap = self._base_snapshot()
        snap["orders"] = [
            {
                "orderId": 42,
                "clientId": 195,
                "symbol": "SPY",
                "secType": "OPT",
                "action": "BUY",
                "orderType": "LIT",
                "qty": 2,
                "filledQty": 0,
                "remaining": 2,
                "lmt": 1.7976931348623157e+308,
                "stop": 520.5,
                "tif": "DAY",
                "status": "Submitted",
            },
            {
                "orderId": None,
                "permId": 9876543,
                "clientId": 0,
                "symbol": "QQQ",
                "secType": "STK",
                "action": "SELL",
                "orderType": "TRAIL",
                "qty": 10,
                "filledQty": 0,
                "remaining": 10,
                "lmt": None,
                "stop": 450.25,
                "tif": "GTC",
                "status": "PreSubmitted",
            },
        ]
        snap["executions"] = [
            {
                "execId": "exec99887766",
                "time": "20261003 11:10:00",
                "symbol": "SPY",
                "side": "BUY",
                "shares": 2,
                "price": 1.7976931348623157e+308,
                "avgPrice": 4.25,
                "permId": 7654321,
            },
            {
                "execId": "exec99887765",
                "time": "not-a-timestamp",
                "symbol": "IWM",
                "side": "SLD",
                "shares": 1.7976931348623157e+308,
                "price": 200.0,
                "orderId": 0,
            },
        ]
        doc, leaks = self._run_with_snapshot(snap)
        self.assertEqual(leaks, [])
        o0, o1 = doc["orders"]["items"]
        self.assertIsNone(o0["price"])
        self.assertIsNone(o0["stop"])
        self.assertEqual(o0["aux_price"], 520.5)
        self.assertIsNone(o0["currency"])
        self.assertEqual(o1["order_id_masked"], "****6543")
        self.assertEqual(o1["stop"], 450.25)
        self.assertIsNone(o1["aux_price"])

        f0, f1 = doc["fills"]["items"]
        self.assertEqual(f0["time"], "2026-10-03T11:10:00Z")
        self.assertEqual(f0["side"], "buy")
        self.assertEqual(f0["price"], 4.25)
        self.assertEqual(f0["order_id_masked"], "****4321")
        self.assertEqual(f0["exec_id_masked"], "****7766")
        self.assertIsNone(f1["time"])
        self.assertIsNone(f1["qty"])
        self.assertEqual(f1["order_id_masked"], "0")

    def test_verify_ibkr_monitor_and_check_v2_dir_cli(self):
        out = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-verify-pub-")
        priv = tempfile.mkdtemp(dir=TEMP_ROOT, prefix="vx-verify-priv-")
        rc = collect.main([
            "--fixtures", FIXTURE, "--out", out, "--v2", "--v2-out", priv, "--verify-ibkr-monitor",
        ])
        self.assertEqual(rc, 0)
        rc_check = collect.main(["--check-v2-dir", priv, "--check-public-dir", out])
        self.assertEqual(rc_check, 0)

        # Fail if status-v2.json leaks into public dir.
        with open(os.path.join(out, "status-v2.json"), "w") as f:
            f.write("{}")
        self.assertNotEqual(collect.main(["--check-v2-dir", priv, "--check-public-dir", out]), 0)
        os.remove(os.path.join(out, "status-v2.json"))

        # Fail if any of the 4 ibkr-monitor blocks (positions, orders, fills, equity) is stale or has negative age_seconds.
        v2_path = os.path.join(priv, "status-v2.json")
        with open(v2_path) as f:
            original = json.load(f)
        for blk_key in ("positions", "orders", "fills", "equity"):
            d = json.loads(json.dumps(original))
            d[blk_key]["stale"] = True
            with open(v2_path, "w") as f:
                json.dump(d, f)
            self.assertNotEqual(collect.main(["--check-v2-dir", priv, "--check-public-dir", out]), 0, blk_key)
            d_neg = json.loads(json.dumps(original))
            d_neg[blk_key]["age_seconds"] = -1
            with open(v2_path, "w") as f:
                json.dump(d_neg, f)
            self.assertNotEqual(collect.main(["--check-v2-dir", priv, "--check-public-dir", out]), 0, blk_key + ":neg")


if __name__ == "__main__":
    unittest.main(verbosity=1)
