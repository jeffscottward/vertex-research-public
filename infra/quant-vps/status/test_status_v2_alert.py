#!/usr/bin/env python3
"""Unit and invariant tests for status_v2_alert.py, Caddyfile.tailnet, and alert units.

Standard-library unittest only. Uses local 127.0.0.1 HTTP servers and temporary directories;
nothing reaches QuantVPS, the tailnet, or any external host.
"""

from __future__ import annotations

import http.server
import io
import json
import os
import re
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
CADDYFILE = HERE / "Caddyfile.tailnet"
INSTALL_TAILNET = HERE / "install-tailnet.sh"
DEPLOY_SCRIPT = HERE / "deploy-status-v2-alert.sh"
SERVICE_UNIT = HERE / "vertex-status-v2-alert.service"
TIMER_UNIT = HERE / "vertex-status-v2-alert.timer"

if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import status_v2_alert as mod  # noqa: E402
def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _healthy_v2_payload(
    now: datetime | None = None,
    *,
    generated_age_s: int = 5,
    block_age_s: int = 10,
    block_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ref = now if now is not None else datetime.now(timezone.utc)
    as_of = _iso_z(ref - timedelta(seconds=block_age_s))
    doc: dict[str, Any] = {
        "schema": "vertex-deploy-status-v2",
        "generatedAt": _iso_z(ref - timedelta(seconds=generated_age_s)),
        "orders": {
            "available": True,
            "source": "ibkr_tws_api open orders via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
            "as_of": as_of,
            "age_seconds": block_age_s,
            "stale": False,
            "count": 0,
            "items": [],
            "truncated": False,
        },
        "fills": {
            "available": True,
            "source": "ibkr_tws_api executions via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
            "as_of": as_of,
            "age_seconds": block_age_s,
            "stale": False,
            "count": 0,
            "items": [],
            "truncated": False,
        },
        "positions": {
            "available": True,
            "source": "ibkr_tws_api positions via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
            "as_of": as_of,
            "age_seconds": block_age_s,
            "stale": False,
            "count": 0,
            "items": [],
            "truncated": False,
        },
        "equity": {
            "available": True,
            "source": "ibkr_tws_api account summary via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
            "as_of": as_of,
            "age_seconds": block_age_s,
            "stale": False,
            "currency": "USD",
            "net_liq": 0.0,
        },
    }
    if block_overrides:
        for key, value in block_overrides.items():
            if value is None:
                doc.pop(key, None)
            else:
                doc[key] = value
    return doc


class _MockState:
    def __init__(self) -> None:
        self.expected_token = "tok-secret-999"
        self.auth_status = 200
        self.auth_body: bytes | None = None
        self.auth_redirect: str | None = None
        self.no_token_status = 403
        self.wrong_token_status = 403
        self.requests: list[tuple[str, str | None]] = []
        self.posts: list[dict[str, Any]] = []
        self.post_status = 200


class _ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _start_server(state: _MockState) -> tuple[_ThreadedHTTPServer, str, str]:
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def do_GET(self) -> None:  # noqa: N802
            auth = self.headers.get("Authorization")
            state.requests.append((self.path, auth))
            if auth == f"Bearer {state.expected_token}":
                if state.auth_redirect is not None:
                    self.send_response(302)
                    self.send_header("Location", state.auth_redirect)
                    self.end_headers()
                    return
                body = (
                    state.auth_body
                    if state.auth_body is not None
                    else json.dumps(_healthy_v2_payload()).encode("utf-8")
                )
                self.send_response(state.auth_status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if auth is None:
                code = state.no_token_status
                body = b'{"schema":"vertex-deploy-status-v2"}' if code == 200 else b"forbidden"
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            code = state.wrong_token_status
            body = b'{"schema":"vertex-deploy-status-v2"}' if code == 200 else b"forbidden"
            self.send_response(code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except ValueError:
                payload = {"raw": raw.decode("utf-8", errors="replace")}
            state.posts.append(payload)
            self.send_response(state.post_status)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

    server = _ThreadedHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    return server, f"{base}/vertex-status/v2", f"{base}/post"


class CaddyfileInvariantTests(unittest.TestCase):
    def test_status_v2_caller_allows_rig_and_vps_with_bearer_before_not_rig(self) -> None:
        text = CADDYFILE.read_text(encoding="utf-8")
        v2_idx = text.find("@status_v2_caller {")
        not_rig_idx = text.find("@not_rig not remote_ip __RIG_IP__")
        self.assertGreater(v2_idx, 0, "@status_v2_caller block missing")
        self.assertGreater(not_rig_idx, v2_idx, "@status_v2_caller must precede @not_rig")

        v2_block_end = text.find("\n  }", v2_idx)
        self.assertGreater(v2_block_end, v2_idx)
        v2_matcher = text[v2_idx:v2_block_end]
        self.assertIn("remote_ip __RIG_IP__ __TS_IP__", v2_matcher)
        self.assertIn("path /vertex-status/v2", v2_matcher)
        self.assertIn('header Authorization "Bearer {$VERTEX_STATUS_TOKEN}"', v2_matcher)

        handle_idx = text.find("handle @status_v2_caller {")
        self.assertGreater(handle_idx, v2_block_end)
        self.assertLess(handle_idx, not_rig_idx)
        handle_end = text.find("\n  }", handle_idx)
        self.assertGreater(handle_end, handle_idx)
        handle_block = text[handle_idx:handle_end]
        self.assertIn("root * /srv", handle_block)
        self.assertIn("rewrite * /status-v2.json", handle_block)
        self.assertIn("file_server", handle_block)

        # Single /status-v2.json rewrite (no dead duplicate inside @rig_authorized).
        self.assertEqual(text.count("/status-v2.json"), 1)
        self.assertNotIn("handle /vertex-status/v2 {", text)

        # Non-rig callers without matching block still receive 403 inside handle @not_rig.
        not_rig_handle = text.find("handle @not_rig {", not_rig_idx)
        self.assertGreater(not_rig_handle, not_rig_idx)
        not_rig_end = text.find("\n  }", not_rig_handle)
        self.assertGreater(not_rig_end, not_rig_handle)
        self.assertIn('respond "forbidden" 403', text[not_rig_handle:not_rig_end])
        self.assertGreater(text.find("handle /vertex-history/v1/*"), not_rig_idx)
        self.assertGreater(text.find("handle /vertex-portfolio/v1/*"), not_rig_idx)
        # Public repo: zero concrete tailnet hostnames or IPs.
        self.assertIsNone(re.search(r"\b100\.\d+\.\d+\.\d+\b|fd7a:|[a-z0-9-]+\.ts\.net\b", text))

    def test_install_tailnet_checks_vps_200_and_no_token_403(self) -> None:
        text = INSTALL_TAILNET.read_text(encoding="utf-8")
        self.assertIn("expect 200", text)
        self.assertIn("expect 403", text)
        self.assertIsNone(re.search(r"\b100\.\d+\.\d+\.\d+\b|fd7a:|\.ts\.net\b", text))

    def test_systemd_units_hardening_and_timeout(self) -> None:
        svc = SERVICE_UNIT.read_text(encoding="utf-8")
        tmr = TIMER_UNIT.read_text(encoding="utf-8")
        self.assertIn(
            "ExecStart=/usr/bin/python3 -B -I /opt/vertex-status/status_v2_alert.py", svc
        )
        self.assertIn("DynamicUser=yes", svc)
        self.assertIn("StateDirectory=vertex-status-v2-alert", svc)
        self.assertIn("LoadCredential=status-token:/opt/vertex-status/token.env", svc)
        self.assertIn("TimeoutStartSec=60", svc)
        self.assertIn("NoNewPrivileges=yes", svc)
        self.assertIn("ProtectSystem=strict", svc)
        self.assertIn("OnUnitActiveSec=2m", tmr)

    def test_deploy_script_market_hours_guard(self) -> None:
        text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"\b100\.\d+\.\d+\.\d+\b|fd7a:|\.ts\.net\b", text))
        start = "# market-hours-guard:start\n"
        end = "# market-hours-guard:end\n"
        self.assertIn(start, text)
        self.assertIn(end, text)
        block = text[text.index(start) : text.index(end)]
        for blocked in ("1 0830 EST", "3 1200 EDT", "5 1559 EDT", "6 1200 UTC", "bad"):
            res = subprocess.run(
                ["bash", "-c", f"set -euo pipefail\n{block}\necho ok"],
                env={"PATH": "/usr/bin:/bin", "VERTEX_DEPLOY_NY_TIME": blocked},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(res.returncode, 3, f"expected refusal for {blocked}")
        for allowed in ("1 0829 EST", "5 1600 EDT", "6 1200 EST", "7 0900 EDT"):
            res = subprocess.run(
                ["bash", "-c", f"set -euo pipefail\n{block}\necho ok"],
                env={"PATH": "/usr/bin:/bin", "VERTEX_DEPLOY_NY_TIME": allowed},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, f"expected allow for {allowed}")
            self.assertIn("ok", res.stdout)


class StatusV2AlertTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="vx-v2-alert-test-")
        self.tmp = Path(self._tmp.name)
        self.state_file = self.tmp / "state.txt"
        self.token_env = self.tmp / "token.env"
        self.token_env.write_text("VERTEX_STATUS_TOKEN=tok-secret-999\n", encoding="utf-8")
        self.hosts_env = self.tmp / "hosts.env"
        self.hosts_env.write_text(
            "VERTEX_TAILNET_HOST=quant-vps-host.example-tailnet.ts.net\n", encoding="utf-8"
        )
        self.mock = _MockState()
        self.server, self.url, self.post_url = _start_server(self.mock)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def _run(self, *extra: str, env_override: dict[str, str] | None = None) -> tuple[int, dict[str, Any]]:
        buf = io.StringIO()
        argv = [
            "--url",
            self.url,
            "--token-env",
            str(self.token_env),
            "--state-file",
            str(self.state_file),
            "--post-url",
            self.post_url,
            "--timeout",
            "5",
            *extra,
        ]
        old_env = os.environ.copy()
        try:
            if env_override:
                os.environ.update(env_override)
            with redirect_stdout(buf):
                rc = mod.main(argv)
        finally:
            os.environ.clear()
            os.environ.update(old_env)
        out = buf.getvalue().strip()
        self.assertNotIn("tok-secret-999", out)
        payload = json.loads(out) if out.startswith("{") else {"raw": out}
        return rc, payload

    def test_healthy_200_and_403_guards_no_alert(self) -> None:
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["auth_http"], 200)
        self.assertEqual(out["no_token_http"], 403)
        self.assertEqual(out["wrong_token_http"], 403)
        self.assertEqual(out["avail_failures"], 0)
        self.assertFalse(out["avail_alert_open"])
        self.assertFalse(out["bypass_alert_open"])
        self.assertFalse(out["stale_alert_open"])
        self.assertEqual(out["stale_failures"], 0)
        self.assertTrue(out["stale_verified"])
        self.assertEqual(out["stale_blocks"], [])
        self.assertFalse(out["alert_sent"])
        self.assertFalse(out["recovery_sent"])
        self.assertEqual(self.mock.posts, [])
        # State file written with 0600 permissions.
        self.assertEqual(os.stat(self.state_file).st_mode & 0o777, 0o600)

    def test_healthy_with_401_guards(self) -> None:
        self.mock.no_token_status = 401
        self.mock.wrong_token_status = 401
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["no_token_http"], 401)
        self.assertEqual(out["wrong_token_http"], 401)

    def test_403_alerts_on_third_failure_dedupes_and_recovers(self) -> None:
        self.mock.auth_status = 403
        # Failures 1 and 2: no alert yet.
        for expected_count in (1, 2):
            rc, out = self._run()
            self.assertEqual(rc, 0)
            self.assertFalse(out["ok"])
            self.assertEqual(out["auth_http"], 403)
            self.assertEqual(out["avail_failures"], expected_count)
            self.assertFalse(out["avail_alert_open"])
            self.assertFalse(out["alert_sent"])
            self.assertEqual(len(self.mock.posts), 0)

        # Failure 3: sends one alert to #omp-alerts with clear 403 explanation, no secret.
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertEqual(out["avail_failures"], 3)
        self.assertTrue(out["avail_alert_open"])
        self.assertTrue(out["alert_sent"])
        self.assertEqual(len(self.mock.posts), 1)
        post = self.mock.posts[0]
        self.assertEqual(post["channel"], "omp-alerts")
        self.assertIn("HTTP 403", post["text"])
        self.assertIn("Caddyfile.tailnet", post["text"])
        self.assertNotIn("tok-secret-999", post["text"])

        # Failure 4: deduplicated (no second alert).
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertEqual(out["avail_failures"], 4)
        self.assertTrue(out["avail_alert_open"])
        self.assertFalse(out["alert_sent"])
        self.assertEqual(len(self.mock.posts), 1)

        # Recovery: sends one recovery notice and clears alert_open.
        self.mock.auth_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["avail_failures"], 0)
        self.assertFalse(out["avail_alert_open"])
        self.assertTrue(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)
        self.assertIn("recovered", self.mock.posts[1]["text"].lower())

        # Next healthy tick: no duplicate recovery.
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)

    def test_post_failure_retries_alert_and_recovery_on_next_tick(self) -> None:
        self.mock.auth_status = 403
        self.mock.post_status = 500
        for _ in range(3):
            rc, out = self._run()
            self.assertEqual(rc, 0)
            self.assertFalse(out["avail_alert_open"])
            self.assertFalse(out["alert_sent"])
        # Post recovers on tick 4 -> alert now delivered and marked open.
        self.mock.post_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["avail_alert_open"])
        self.assertTrue(out["alert_sent"])

        # Endpoint recovers, but post fails -> avail_alert_open stays True for retry.
        self.mock.auth_status = 200
        self.mock.post_status = 500
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["avail_alert_open"])
        self.assertFalse(out["recovery_sent"])

        # Post succeeds -> recovery delivered and avail_alert_open clears.
        self.mock.post_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["avail_alert_open"])
        self.assertTrue(out["recovery_sent"])

    def test_auth_bypass_alerts_immediately_even_when_avail_alert_is_open(self) -> None:
        # Open an availability incident first (3x 403).
        self.mock.auth_status = 403
        for _ in range(3):
            self._run()
        self.assertEqual(len(self.mock.posts), 1)

        # Now misconfigured Caddy lets unauthenticated requests return 200.
        self.mock.auth_status = 200
        self.mock.no_token_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertTrue(out["bypass_alert_open"])
        self.assertTrue(out["alert_sent"])
        # Availability recovered AND bypass alerted (2 new posts).
        self.assertEqual(len(self.mock.posts), 3)
        self.assertTrue(
            any("auth bypass" in p["text"].lower() or "unauthenticated" in p["text"].lower() for p in self.mock.posts)
        )

        # Wrong-token 200 also triggers bypass independently when starting clean.
        self.state_file.unlink()
        self.mock.posts.clear()
        self.mock.no_token_status = 403
        self.mock.wrong_token_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertTrue(out["bypass_alert_open"])
        self.assertTrue(out["alert_sent"])
        self.assertEqual(len(self.mock.posts), 1)
        self.assertIn("wrong-token", self.mock.posts[0]["text"].lower())

        # Fix wrong-token guard -> bypass recovery notice sent.
        self.mock.wrong_token_status = 403
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertFalse(out["bypass_alert_open"])
        self.assertTrue(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)

    def test_401_bad_json_wrong_schema_and_oversized_body_fail(self) -> None:
        # HTTP 401
        self.mock.auth_status = 401
        _, out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("401", out["detail"])

        # Wrong schema
        self.mock.auth_status = 200
        self.mock.auth_body = b'{"schema":"vertex-deploy-status-v1"}'
        _, out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("schema", out["detail"].lower())

        # Invalid JSON
        self.mock.auth_body = b"not-json"
        _, out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("json", out["detail"].lower())

        # Oversized body (> 256 KiB)
        self.mock.auth_body = b"{" + b" " * (mod.MAX_BODY_BYTES + 10) + b"}"
        _, out = self._run()
        self.assertFalse(out["ok"])
        self.assertIn("oversized", out["detail"].lower())

    def test_redirect_refused_without_forwarding_bearer_token(self) -> None:
        self.mock.auth_redirect = f"{self.url}/elsewhere"
        self.mock.requests.clear()
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertEqual(out["auth_http"], 302)
        self.assertIn("redirect", out["detail"].lower())
        # Redirect target was never requested.
        paths = [p for p, _ in self.mock.requests]
        self.assertNotIn("/vertex-status/v2/elsewhere", paths)

    def test_credentials_directory_and_corrupt_state_recovery(self) -> None:
        cred_dir = self.tmp / "creds"
        cred_dir.mkdir()
        (cred_dir / "status-token").write_text("VERTEX_STATUS_TOKEN=tok-secret-999\n", encoding="utf-8")
        # Corrupt state file must not crash.
        self.state_file.write_text("not_a_valid_line\navail_failures=NaN\n", encoding="utf-8")

        buf = io.StringIO()
        old_env = os.environ.copy()
        try:
            os.environ["CREDENTIALS_DIRECTORY"] = str(cred_dir)
            os.environ["STATE_DIRECTORY"] = str(self.tmp)
            with redirect_stdout(buf):
                rc = mod.main(["--url", self.url, "--post-url", self.post_url, "--timeout", "5"])
        finally:
            os.environ.clear()
            os.environ.update(old_env)
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue().strip())
        self.assertTrue(out["ok"])
        self.assertEqual(out["avail_failures"], 0)

    def test_fatal_config_and_non_loopback_http_exit_1(self) -> None:
        # Missing token file
        rc, _ = self._run("--token-env", str(self.tmp / "missing.env"))
        self.assertEqual(rc, 1)

        # Empty token
        empty_tok = self.tmp / "empty.env"
        empty_tok.write_text("VERTEX_STATUS_TOKEN=\n", encoding="utf-8")
        rc, _ = self._run("--token-env", str(empty_tok))
        self.assertEqual(rc, 1)

        # Non-loopback http:// rejected
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(
                [
                    "--url",
                    "http://example.com:8443/vertex-status/v2",
                    "--token-env",
                    str(self.token_env),
                    "--state-file",
                    str(self.state_file),
                ]
            )
        self.assertEqual(rc, 1)

        # Missing hosts.env when --url is not passed
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(
                [
                    "--hosts-env",
                    str(self.tmp / "no-hosts.env"),
                    "--token-env",
                    str(self.token_env),
                    "--state-file",
                    str(self.state_file),
                ]
            )
        self.assertEqual(rc, 1)

    def test_dry_run_does_not_post_or_write_state(self) -> None:
        self.mock.auth_status = 403
        rc, out = self._run("--threshold", "1", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertEqual(self.mock.posts, [])
        self.assertFalse(self.state_file.exists())

    def test_state_sanitizes_newlines(self) -> None:
        now = datetime(2026, 11, 25, 4, 0, tzinfo=timezone.utc)
        st = mod.AlertState(
            avail_failures=2,
            avail_alert_open=True,
            avail_started_at=now.isoformat(),
            avail_reason="line1\nline2\rline3",
            bypass_failures=0,
            bypass_alert_open=False,
            bypass_started_at="",
            bypass_reason="",
            last_checked_at=now.isoformat(),
            last_ok_at="",
        )
        mod.save_state(self.state_file, st)
        loaded = mod.load_state(self.state_file)
        self.assertEqual(loaded.avail_failures, 2)
        self.assertTrue(loaded.avail_alert_open)
        self.assertEqual(loaded.avail_reason, "line1 line2 line3")

    def test_bypass_alert_stays_open_when_guards_skipped_or_500(self) -> None:
        # Open an auth-bypass alert first.
        self.mock.no_token_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["bypass_alert_open"])
        self.assertEqual(len(self.mock.posts), 1)

        # Guard probe returning 500 must NOT falsely clear bypass_alert_open (counts as avail failure).
        self.mock.no_token_status = 500
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertTrue(out["bypass_alert_open"])
        self.assertEqual(out["avail_failures"], 1)
        self.assertFalse(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 1)

        # Authorized transport error skipping guard probes must NOT clear bypass_alert_open.
        def _transport_fail(
            _url: str, _headers: dict[str, str], _timeout: float
        ) -> mod.ProbeOutcome:
            return mod.ProbeOutcome(None, None, "transport error (TimeoutError)", True)

        res = mod.run_probes(self.url, "tok-secret-999", 5.0, fetcher=_transport_fail)
        self.assertFalse(res.bypass_verified)
        st = mod.load_state(self.state_file)
        posted: list[str] = []
        st2, _, rec = mod.step_state(
            st, res, datetime(2026, 11, 25, 4, 2, tzinfo=timezone.utc), 3, lambda m: (posted.append(m) or True)
        )
        self.assertTrue(st2.bypass_alert_open)
        self.assertFalse(rec)
        self.assertEqual(posted, [])

        # Once BOTH guard probes explicitly return 403, bypass_alert_open clears and recovers.
        self.mock.no_token_status = 403
        self.mock.wrong_token_status = 403
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertFalse(out["bypass_alert_open"])
        self.assertTrue(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)

    def test_invalid_utf8_state_file_resets_safely(self) -> None:
        self.state_file.write_bytes(b"\xff\xfe\xfd\x80not-utf8")
        loaded = mod.load_state(self.state_file)
        self.assertEqual(loaded.avail_failures, 0)
        self.assertFalse(loaded.avail_alert_open)
        self.assertFalse(loaded.bypass_alert_open)

    def test_resolve_probe_url_from_hosts_env_and_reject_non_loopback_post_url(self) -> None:
        self.assertEqual(
            mod.resolve_probe_url(None, self.hosts_env),
            "https://quant-vps-host.example-tailnet.ts.net:8443/vertex-status/v2",
        )
        rc, _ = self._run("--post-url", "https://example.com/post")
        self.assertEqual(rc, 1)

    def test_stale_block_alerts_on_third_tick_dedupes_and_recovers(self) -> None:
        stale_as_of = _iso_z(datetime.now(timezone.utc) - timedelta(seconds=900))
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {
                        "available": True,
                        "source": "ibkr_tws_api open orders via ibkr-monitor.service",
                        "as_of": stale_as_of,
                        "age_seconds": 900,
                        "stale": True,
                    }
                }
            )
        ).encode("utf-8")

        # Ticks 1 and 2: degraded but below threshold -> no alert yet.
        for expected_count in (1, 2):
            rc, out = self._run()
            self.assertEqual(rc, 0)
            self.assertFalse(out["ok"])
            self.assertTrue(out["stale_verified"])
            self.assertEqual(out["stale_blocks"], ["orders"])
            self.assertEqual(out["stale_failures"], expected_count)
            self.assertFalse(out["stale_alert_open"])
            self.assertFalse(out["alert_sent"])
            self.assertEqual(out["avail_failures"], 0)
            self.assertEqual(len(self.mock.posts), 0)

        # Tick 3: sends one alert naming the stale block.
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertEqual(out["stale_failures"], 3)
        self.assertTrue(out["stale_alert_open"])
        self.assertTrue(out["alert_sent"])
        self.assertEqual(len(self.mock.posts), 1)
        alert_text = self.mock.posts[0]["text"]
        self.assertIn("orders: stale", alert_text)
        self.assertIn("ibkr-monitor.service", alert_text)
        self.assertNotIn("tok-secret-999", alert_text)

        # Tick 4: deduplicated (no second alert while open).
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertEqual(out["stale_failures"], 4)
        self.assertTrue(out["stale_alert_open"])
        self.assertFalse(out["alert_sent"])
        self.assertEqual(len(self.mock.posts), 1)

        # Tick 5: fresh again -> sends one recovery message and clears state.
        self.mock.auth_body = None
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["stale_failures"], 0)
        self.assertFalse(out["stale_alert_open"])
        self.assertEqual(out["stale_blocks"], [])
        self.assertTrue(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)
        rec_text = self.mock.posts[1]["text"]
        self.assertIn("broker blocks recovered", rec_text.lower())
        self.assertIn("orders=", rec_text)

        # Tick 6: healthy again -> no duplicate recovery.
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)

    def test_unavailable_missing_and_non_bool_blocks_fail_closed(self) -> None:
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "positions": {
                        "available": False,
                        "source": "ibkr-monitor.service (/api/snapshot)",
                        "reason": "ibkr-monitor bridge is degraded",
                    },
                    "fills": None,
                    "equity": {
                        "available": True,
                        "as_of": _iso_z(datetime.now(timezone.utc) - timedelta(seconds=5)),
                        "age_seconds": 5,
                        "stale": "false",
                    },
                    "orders": {
                        "available": 1,
                        "as_of": _iso_z(datetime.now(timezone.utc) - timedelta(seconds=5)),
                        "stale": False,
                    },
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertTrue(out["stale_alert_open"])
        self.assertTrue(out["alert_sent"])
        self.assertEqual(out["stale_blocks"], ["orders", "fills", "positions", "equity"])
        self.assertIn("positions: unavailable (ibkr-monitor bridge is degraded)", out["detail"])
        self.assertIn("fills: missing", out["detail"])
        self.assertIn("equity: missing/invalid stale flag", out["detail"])
        self.assertIn("orders: unavailable", out["detail"])

    def test_frozen_snapshot_detected_by_wall_clock_even_when_stale_flag_false(self) -> None:
        # Simulate vertex-status-collect.timer stopping 15 minutes ago: disk JSON still has stale=False.
        frozen_at = datetime.now(timezone.utc) - timedelta(seconds=900)
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(now=frozen_at, generated_age_s=0, block_age_s=5)
        ).encode("utf-8")
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertTrue(out["stale_alert_open"])
        self.assertEqual(
            out["stale_blocks"], ["snapshot", "orders", "fills", "positions", "equity"]
        )
        self.assertIn("snapshot: stale generatedAt", out["detail"])
        self.assertIn("orders: stale by clock", out["detail"])

    def test_stale_post_failure_retries_alert_and_recovery(self) -> None:
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "fills": {"available": False, "source": "ibkr-monitor", "reason": "bridge offline"}
                }
            )
        ).encode("utf-8")
        self.mock.post_status = 500
        for _ in range(3):
            rc, out = self._run()
            self.assertEqual(rc, 0)
            self.assertFalse(out["stale_alert_open"])
            self.assertFalse(out["alert_sent"])
        # Post recovers on tick 4 -> alert delivered and marked open.
        self.mock.post_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])
        self.assertTrue(out["alert_sent"])

        # Blocks recover, but Discord post fails -> stale_alert_open stays True for retry.
        self.mock.auth_body = None
        self.mock.post_status = 500
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])
        self.assertFalse(out["recovery_sent"])

        # Post succeeds -> recovery delivered and stale_alert_open clears.
        self.mock.post_status = 200
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(out["stale_alert_open"])
        self.assertTrue(out["recovery_sent"])

    def test_stale_alert_pauses_during_http_outage_without_false_recovery(self) -> None:
        # Open a stale-block alert first.
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "positions": {"available": False, "source": "ibkr-monitor", "reason": "bridge down"}
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])
        self.assertEqual(len(self.mock.posts), 1)

        # HTTP 403 outage: stale check is skipped (stale_verified=False) and does NOT clear stale_alert_open.
        self.mock.auth_status = 403
        rc, out = self._run("--threshold", "3")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertFalse(out["stale_verified"])
        self.assertTrue(out["stale_alert_open"])
        self.assertEqual(out["stale_failures"], 1)
        self.assertEqual(out["avail_failures"], 1)
        self.assertFalse(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 1)

        # Authorized 200 returns while positions is STILL unavailable -> stays open, no duplicate alert.
        self.mock.auth_status = 200
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_verified"])
        self.assertTrue(out["stale_alert_open"])
        self.assertFalse(out["alert_sent"])
        self.assertFalse(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 1)

        # Positions recovers -> single recovery sent.
        self.mock.auth_body = None
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertFalse(out["stale_alert_open"])
        self.assertTrue(out["recovery_sent"])
        self.assertEqual(len(self.mock.posts), 2)

    def test_stale_and_bypass_alerts_are_independent(self) -> None:
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {"available": False, "source": "ibkr-monitor", "reason": "ordersAsOf null"}
                }
            )
        ).encode("utf-8")
        self.mock.no_token_status = 200
        rc, out = self._run("--threshold", "3")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        # Bypass alerts immediately on tick 1; stale waits for threshold 3.
        self.assertTrue(out["bypass_alert_open"])
        self.assertFalse(out["stale_alert_open"])
        self.assertEqual(out["stale_failures"], 1)
        self.assertEqual(len(self.mock.posts), 1)
        self.assertIn("auth bypass", self.mock.posts[0]["text"].lower())

    def test_pre_upgrade_state_file_loads_cleanly(self) -> None:
        self.state_file.write_text(
            "avail_failures=2\n"
            "avail_alert_open=true\n"
            "avail_started_at=2026-11-27T01:00:00Z\n"
            "avail_reason=HTTP 403\n"
            "bypass_failures=0\n"
            "bypass_alert_open=false\n"
            "last_checked_at=2026-11-27T01:04:00Z\n"
            "last_ok_at=2026-11-27T00:58:00Z\n",
            encoding="utf-8",
        )
        loaded = mod.load_state(self.state_file)
        self.assertEqual(loaded.avail_failures, 2)
        self.assertTrue(loaded.avail_alert_open)
        self.assertEqual(loaded.stale_failures, 0)
        self.assertFalse(loaded.stale_alert_open)
        self.assertEqual(loaded.stale_blocks, "")

    def test_stale_reason_sanitizes_newlines_truncates_and_redacts_token(self) -> None:
        long_reason = "bridge failed\nwith tok-secret-999 " + ("x" * 200)
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {"available": False, "source": "ibkr-monitor", "reason": long_reason}
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])
        self.assertNotIn("tok-secret-999", out["detail"])
        self.assertIn("[redacted]", out["detail"])
        self.assertNotIn("\n", out["detail"])
        self.assertEqual(len(self.mock.posts), 1)
        self.assertNotIn("tok-secret-999", self.mock.posts[0]["text"])
        saved = self.state_file.read_text(encoding="utf-8")
        self.assertNotIn("tok-secret-999", saved)
        self.assertEqual(len(saved.splitlines()), 15)

    def test_stale_cli_options_and_validation(self) -> None:
        # Custom --stale-blocks ignores unmonitored block (equity).
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "equity": {"available": False, "source": "ibkr-monitor", "reason": "missing summary"}
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--stale-blocks", "orders,fills,positions", "--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["stale_blocks"], [])

        # Custom --stale-threshold overrides --threshold.
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {"available": False, "source": "ibkr-monitor", "reason": "down"}
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--threshold", "5", "--stale-threshold", "2")
        self.assertEqual(rc, 0)
        self.assertFalse(out["stale_alert_open"])
        rc, out = self._run("--threshold", "5", "--stale-threshold", "2")
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])

        # Custom --stale-max-age catches 90s-old block even when stale=False, and --dry-run touches neither posts nor state.
        posts_before = len(self.mock.posts)
        state_before = self.state_file.read_text(encoding="utf-8")
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(generated_age_s=5, block_age_s=90)
        ).encode("utf-8")
        rc, out = self._run("--stale-max-age", "60", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertEqual(out["stale_blocks"], ["orders", "fills", "positions", "equity"])
        self.assertEqual(len(self.mock.posts), posts_before)
        self.assertEqual(self.state_file.read_text(encoding="utf-8"), state_before)

        # Invalid CLI flags exit 1.
        for bad_args in (
            ("--stale-blocks", "unknown_block"),
            ("--stale-blocks", "  ,  "),
            ("--stale-threshold", "0"),
            ("--stale-max-age", "0"),
        ):
            rc, err_out = self._run(*bad_args)
            self.assertEqual(rc, 1, f"expected exit 1 for {bad_args}")
            self.assertFalse(err_out["ok"])

    def test_iso_utc_parser_handles_z_offsets_and_rejects_naive(self) -> None:
        self.assertEqual(
            mod._parse_iso_utc("2026-11-27T17:30:00Z"),
            datetime(2026, 11, 27, 17, 30, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            mod._parse_iso_utc("2026-11-27T17:30:00.250000z"),
            datetime(2026, 11, 27, 17, 30, 0, 250000, tzinfo=timezone.utc),
        )
        self.assertEqual(
            mod._parse_iso_utc("2026-11-27T12:30:00-05:00"),
            datetime(2026, 11, 27, 17, 30, 0, tzinfo=timezone.utc),
        )
        for bad in ("2026-11-27T17:30:00", "2026-11-27", "", "not-a-timestamp", None, 12345):
            self.assertIsNone(mod._parse_iso_utc(bad), f"expected None for {bad!r}")


    def test_real_collector_v2_fixture_passes_fresh_and_fails_when_clock_advances(self) -> None:
        import collect as collector_mod  # noqa: PLC0415

        inp = collector_mod.FixtureInputs(str(HERE / "fixtures" / "stopped-session"))
        _, v2_text, leaks = collector_mod.build(inp, v2_enabled=True)
        self.assertEqual(leaks, [])
        doc = json.loads(v2_text)
        gen_dt = mod._parse_iso_utc(doc["generatedAt"])
        self.assertIsNotNone(gen_dt)
        assert gen_dt is not None

        ok, degraded, detail, ages = mod.inspect_stale_blocks(doc, gen_dt)
        self.assertTrue(ok, detail)
        self.assertEqual(degraded, ())
        self.assertEqual(dict(ages), {"orders": 8, "fills": 5, "positions": 5, "equity": 5})

        # Advancing wall clock 10 minutes past generatedAt catches frozen snapshot + all 4 blocks.
        later = gen_dt + timedelta(seconds=600)
        ok2, degraded2, detail2, _ = mod.inspect_stale_blocks(doc, later)
        self.assertFalse(ok2)
        self.assertEqual(degraded2, ("snapshot", "orders", "fills", "positions", "equity"))
        self.assertIn("snapshot: stale generatedAt", detail2)


    def test_transient_stale_ticks_clear_metadata_on_recovery(self) -> None:
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {"available": False, "source": "ibkr-monitor", "reason": "brief blip"}
                }
            )
        ).encode("utf-8")
        # 2 ticks below threshold -> metadata populated, no alert.
        for _ in range(2):
            rc, out = self._run("--threshold", "3")
            self.assertEqual(rc, 0)
            self.assertFalse(out["stale_alert_open"])
        mid = mod.load_state(self.state_file)
        self.assertEqual(mid.stale_failures, 2)
        self.assertNotEqual(mid.stale_started_at, "")
        self.assertIn("orders", mid.stale_blocks)

        # Next tick healthy -> counters AND transient metadata cleared cleanly.
        self.mock.auth_body = None
        rc, out = self._run("--threshold", "3")
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(len(self.mock.posts), 0)
        cleared = mod.load_state(self.state_file)
        self.assertEqual(cleared.stale_failures, 0)
        self.assertEqual(cleared.stale_started_at, "")
        self.assertEqual(cleared.stale_reason, "")
        self.assertEqual(cleared.stale_blocks, "")

    def test_unicode_line_separators_sanitized_in_state_file(self) -> None:
        # Unicode U+2028/U+2029/U+0085 splitlines() characters must never inject state.txt keys.
        injected = "bridge down stale_alert_open=false avail_failures=99tail"
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {"available": False, "source": "ibkr-monitor", "reason": injected}
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])
        loaded = mod.load_state(self.state_file)
        self.assertTrue(loaded.stale_alert_open)
        self.assertEqual(loaded.avail_failures, 0)
        self.assertEqual(len(self.state_file.read_text(encoding="utf-8").splitlines()), 15)

    def test_inspect_stale_blocks_edge_cases_and_future_skew(self) -> None:
        now = datetime(2026, 11, 27, 18, 0, 0, tzinfo=timezone.utc)

        # Missing/invalid generatedAt + non-dict present block + stale=False with missing as_of
        # + stale=False with fresh as_of but float age_seconds > max_age.
        doc = _healthy_v2_payload(now=now)
        doc["generatedAt"] = "not-a-timestamp"
        doc["orders"] = ["unexpected-list"]
        doc["fills"]["as_of"] = None
        doc["positions"]["age_seconds"] = 450.5
        ok, degraded, detail, _ = mod.inspect_stale_blocks(doc, now)
        self.assertFalse(ok)
        self.assertEqual(degraded, ("snapshot", "orders", "fills", "positions"))
        self.assertIn("snapshot: missing/invalid generatedAt", detail)
        self.assertIn("orders: missing", detail)
        self.assertIn("fills: missing/invalid as_of", detail)
        self.assertIn("positions: stale age_seconds (age=450s", detail)

        # stale=True with as_of=None and age_seconds=None (collect.py missing as_of shape),
        # stale=True with age_seconds=900, and stale=True with slight forward skew (clamped >= 0).
        doc2 = _healthy_v2_payload(now=now)
        doc2["orders"] = {"available": True, "as_of": None, "age_seconds": None, "stale": True}
        doc2["fills"] = {"available": True, "as_of": None, "age_seconds": 900, "stale": True}
        doc2["positions"] = {
            "available": True,
            "as_of": _iso_z(now + timedelta(seconds=5)),
            "age_seconds": None,
            "stale": True,
        }
        ok2, degraded2, detail2, _ = mod.inspect_stale_blocks(doc2, now)
        self.assertFalse(ok2)
        self.assertEqual(degraded2, ("orders", "fills", "positions"))
        self.assertIn("orders: stale (age=unknown, as_of=null)", detail2)
        self.assertIn("fills: stale (age=900s, as_of=null)", detail2)
        self.assertIn("positions: stale (age=0s,", detail2)

        # Small forward NTP skew (+10s) is tolerated and clamped to 0s.
        doc3 = _healthy_v2_payload(now=now + timedelta(seconds=10), generated_age_s=0, block_age_s=0)
        ok3, degraded3, detail3, ages3 = mod.inspect_stale_blocks(doc3, now)
        self.assertTrue(ok3, detail3)
        self.assertEqual(degraded3, ())
        self.assertEqual(dict(ages3), {"orders": 0, "fills": 0, "positions": 0, "equity": 0})

        # Far-future timestamps (> 60s ahead) fail closed so corrupt future dates cannot mask freezes.
        doc4 = _healthy_v2_payload(now=now + timedelta(seconds=3600), generated_age_s=0, block_age_s=0)
        ok4, degraded4, detail4, _ = mod.inspect_stale_blocks(doc4, now)
        self.assertFalse(ok4)
        self.assertEqual(degraded4, ("snapshot", "orders", "fills", "positions", "equity"))
        self.assertIn("snapshot: future generatedAt", detail4)
        self.assertIn("orders: future as_of", detail4)

    def test_transport_error_pauses_stale_and_guard_500_still_evaluates_stale(self) -> None:
        # 1. Open a stale-block alert first.
        self.mock.auth_body = json.dumps(
            _healthy_v2_payload(
                block_overrides={
                    "orders": {"available": False, "source": "ibkr-monitor", "reason": "bridge down"}
                }
            )
        ).encode("utf-8")
        rc, out = self._run("--threshold", "1")
        self.assertEqual(rc, 0)
        self.assertTrue(out["stale_alert_open"])

        # 2. Transport failure on authorized probe skips stale check without clearing stale_alert_open.
        def _transport_fail(
            _url: str, _headers: dict[str, str], _timeout: float
        ) -> mod.ProbeOutcome:
            return mod.ProbeOutcome(None, None, "transport error (TimeoutError)", True)

        res = mod.run_probes(self.url, "tok-secret-999", 5.0, fetcher=_transport_fail)
        self.assertFalse(res.stale_verified)
        st = mod.load_state(self.state_file)
        posted: list[str] = []
        st2, _, rec = mod.step_state(
            st,
            res,
            datetime(2026, 11, 27, 18, 2, tzinfo=timezone.utc),
            3,
            lambda m: (posted.append(m) or True),
        )
        self.assertTrue(st2.stale_alert_open)
        self.assertEqual(st2.stale_failures, 1)
        self.assertFalse(rec)
        self.assertEqual(posted, [])

        # 3. Authorized 200 with fresh payload + guard probe HTTP 500:
        # avail_ok=False (guard failed), while stale_verified=True still evaluates and recovers stale!
        self.mock.auth_body = None
        self.mock.no_token_status = 500
        rc, out = self._run("--threshold", "3")
        self.assertEqual(rc, 0)
        self.assertFalse(out["ok"])
        self.assertEqual(out["avail_failures"], 1)
        self.assertTrue(out["stale_verified"])
        self.assertFalse(out["stale_alert_open"])
        self.assertTrue(out["recovery_sent"])


if __name__ == "__main__":
    unittest.main()
