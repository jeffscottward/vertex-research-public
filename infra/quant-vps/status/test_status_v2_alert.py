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
from datetime import datetime, timezone
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
                    else json.dumps(
                        {"schema": "vertex-deploy-status-v2", "ok": True}
                    ).encode("utf-8")
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

        # Non-rig callers without matching block still receive 403.
        self.assertIn('respond "forbidden" 403', text)
        # History and portfolio stay behind @not_rig / @rig_authorized.
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


if __name__ == "__main__":
    unittest.main()
