#!/usr/bin/env python3
"""Fixture tests for the QuantVPS status collector. Run: python3 infra/quant-vps/status/test_collect.py"""
import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import collect  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "stopped-session")
PLANTED = ["U1234567", "U7654321", "DU7654321", "hunter2fixture", "fixture-not-a-real-password", "fixturepw",
           "FixtureTok3nAbCdEfGhIjKlMnOpQrStUvWxYz0123", "FixtureBearerAbCdEf0123456789", "abc123fixture",
           "FixtureKey1234", "jeff@example.com", "FixtureStatusTokenAbCdEfGhIjKlMnOpQrStUv0123456789", "fixture-secret",
           "IBKR_ACCOUNT_ID", "TWS_PASSWORD", "POSTGRES_URL", "VENDOR_API_TOKEN", "0000000000000000000000000000000000000000"]


def run_fixture():
    out = tempfile.mkdtemp(prefix="vx-status-")
    private = tempfile.mkdtemp(prefix="vx-status-private-")
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
        self.assertEqual(s["account_masked"], "****0042")
        self.assertEqual(s["strategies"][0]["id"], "example_strategy")
        self.assertEqual(s["symbols"], ["AAPL"])
        self.assertEqual(s["last_heartbeat_at"], "2026-09-25T16:38:38Z")
        self.assertEqual(s["stopped_at"], "2026-09-25T16:38:44Z")
        self.assertEqual(s["started_at"], "2026-09-18T16:24:08Z")

    def test_positions_equity(self):
        p = self.v2["positions"]
        self.assertTrue(p["available"])
        self.assertTrue(p["stale"])
        self.assertEqual(p["as_of"], "2026-09-18T20:15:50Z")
        orcl, aapl = p["items"]
        self.assertEqual((orcl["symbol"], orcl["qty"], orcl["avg_px"], orcl["currency"]), ("ORCL", 100, 100.5, "USD"))
        self.assertEqual((aapl["right"], aapl["strike"], aapl["expiry"], aapl["avg_px"], aapl["multiplier"]), ("C", 150, "20261120", 2.5, 100))
        e = self.v2["equity"]
        self.assertEqual((e["net_liq"], e["cash"], e["unrealized"], e["realized"], e["currency"]), (150000.25, 90000, 170, 12.5, "USD"))

    def test_orders_fills(self):
        o = self.v2["orders"]["items"]
        self.assertEqual((o[0]["type"], o[0]["stop"], o[0]["price"], o[0]["side"], o[0]["status"]), ("STP", 95, None, "sell", "PreSubmitted"))
        self.assertEqual((o[1]["type"], o[1]["price"], o[1]["order_id_masked"], o[1]["client_id"]), ("LMT", 200.25, "****4567", 31))
        self.assertEqual(o[1]["warning"], "Order held for account ****4321")
        f = self.v2["fills"]["items"]
        self.assertEqual([x["side"] for x in f], ["sell", "buy"])
        self.assertEqual(f[0]["time"], "2026-09-11T19:45:00Z")

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
        out = tempfile.mkdtemp(prefix="vx-status-off-")
        with open(os.path.join(out, "status-v2.json"), "w") as f:
            f.write('{"schema":"vertex-deploy-status-v2"}')
        private = tempfile.mkdtemp(prefix="vx-status-off-private-")
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
        out = tempfile.mkdtemp(prefix="vx-status-pub-")
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
        self.assertEqual(m(None, None, None, False, None), "unknown")
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
