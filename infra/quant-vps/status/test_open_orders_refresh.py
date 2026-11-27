#!/usr/bin/env python3
"""Unit and invariant tests for the IBKR open-orders refresh timer and deployer.

Standard-library unittest only. Reads repository files and tests the market-hours
guard block offline with bash; nothing reaches QuantVPS, Docker, or IBKR.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUANT_VPS_DIR = HERE.parent
FROZEN_MANIFEST = QUANT_VPS_DIR / "exec-node" / "frozen-manifest.sha256"
ALERT_DEPLOY_SCRIPT = HERE / "deploy-status-v2-alert.sh"
DEPLOY_SCRIPT = HERE / "deploy-open-orders-refresh.sh"
SERVICE_UNIT = HERE / "vertex-ibkr-open-orders-refresh.service"
TIMER_UNIT = HERE / "vertex-ibkr-open-orders-refresh.timer"

if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import collect  # noqa: E402

EXPECTED_EXEC_START = (
    "ExecStart=/usr/bin/docker exec ibkr-nautilus-exec-node-portfolio-ui-1 "
    "/usr/bin/timeout -k 5 40 "
    "/opt/ibkr-snapshot-venv/bin/python3 "
    "/app/scripts/ibkr_open_orders.py --client-id 149 --timeout-seconds 15"
)

# Recorded IB client IDs in use or reserved across QuantVPS services/tools (checked 2026-11-27,
# including 191-198 reserved in infra/quant-vps/exec-node/runtime/docker-compose.yml).
RECORDED_IN_USE_CLIENT_IDS = (
    {31, 52, 57, 61, 62, 77, 78, 91, 97, 98, 177, 179, 187, 211}
    | set(range(41, 51))
    | set(range(191, 199))
)

TAILNET_RE = re.compile(r"\b100\.\d+\.\d+\.\d+\b|fd7a:|\.ts\.net\b")
FORBIDDEN_DEPLOY_CMD_RE = re.compile(r"\b(?:restart|stop|compose|rm)\b", re.IGNORECASE)
CLIENT_ID_SCAN_EXTS = {".service", ".sh", ".py", ".yml", ".yaml", ".mjs"}


def _non_comment_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


class OpenOrdersRefreshTests(unittest.TestCase):
    def test_timer_period_keeps_report_fresh(self) -> None:
        self.assertTrue(TIMER_UNIT.is_file(), f"missing {TIMER_UNIT}")
        text = TIMER_UNIT.read_text(encoding="utf-8")
        lines = [line.strip() for line in text.splitlines()]
        self.assertFalse(
            any(line.startswith(";") for line in lines),
            "timer unit must use '#' comments, not ';'",
        )
        for required in (
            "OnBootSec=2min",
            "OnUnitInactiveSec=60s",
            "AccuracySec=5s",
            "Persistent=false",
            "RandomizedDelaySec=0",
            "WantedBy=timers.target",
        ):
            self.assertIn(required, lines, f"missing {required!r} in {TIMER_UNIT.name}")
        match = re.search(r"^OnUnitInactiveSec=(\d+)s$", text, re.MULTILINE)
        self.assertIsNotNone(match, "OnUnitInactiveSec must specify seconds")
        period = int(match.group(1))
        self.assertLess(
            3 * period,
            collect.REPORT_STALE_SECONDS,
            f"3 * {period}s must be < REPORT_STALE_SECONDS ({collect.REPORT_STALE_SECONDS}s)",
        )

    def test_service_runs_frozen_writer_read_only(self) -> None:
        self.assertTrue(SERVICE_UNIT.is_file(), f"missing {SERVICE_UNIT}")
        text = SERVICE_UNIT.read_text(encoding="utf-8")
        lines = [line.strip() for line in text.splitlines()]
        self.assertFalse(
            any(line.startswith(";") for line in lines),
            "service unit must use '#' comments, not ';'",
        )
        self.assertIn("Type=oneshot", lines)
        self.assertIn("TimeoutStartSec=50", lines)
        self.assertIn("Nice=10", lines)
        self.assertFalse(
            any(line.startswith("SuccessExitStatus=") for line in lines),
            "service must not mask non-zero exits with SuccessExitStatus=",
        )
        self.assertFalse(
            any(line.startswith("ExecStartPre=") for line in lines),
            "service should not duplicate docker exec via ExecStartPre=",
        )

        exec_lines = [line for line in lines if line.startswith("ExecStart=")]
        self.assertEqual(len(exec_lines), 1, f"expected one ExecStart=, got {exec_lines}")
        exec_line = exec_lines[0]
        self.assertEqual(exec_line, EXPECTED_EXEC_START)

        lower_exec = exec_line.lower()
        for forbidden in ("--output", "cancel", "close", "arm"):
            self.assertNotIn(forbidden, lower_exec)

        script_match = re.search(r"/app/(\S+\.py)\b", exec_line)
        self.assertIsNotNone(script_match, "ExecStart must name a /app/<script>.py path")
        manifest_paths: set[str] = set()
        for raw in FROZEN_MANIFEST.read_text(encoding="utf-8").splitlines():
            parts = raw.strip().split(None, 1)
            if len(parts) == 2:
                manifest_paths.add(parts[1].strip())
        self.assertIn(
            script_match.group(1),
            manifest_paths,
            f"{script_match.group(1)} must be listed in frozen-manifest.sha256",
        )

    def test_service_client_id_is_dedicated(self) -> None:
        self.assertTrue(SERVICE_UNIT.is_file(), f"missing {SERVICE_UNIT}")
        text = SERVICE_UNIT.read_text(encoding="utf-8")
        match = re.search(r"--client-id\s+(\d+)\b", text)
        self.assertIsNotNone(match, "ExecStart must pass --client-id <int>")
        client_id = int(match.group(1))
        self.assertEqual(client_id, 149)
        self.assertNotIn(client_id, RECORDED_IN_USE_CLIENT_IDS)

        # Dynamically verify no other runtime file under infra/quant-vps/ declares this client ID.
        id_patterns = (
            re.compile(rf"--client-id(?:=|\s+){client_id}\b", re.IGNORECASE),
            re.compile(
                rf"client[_-]id[^\n#]*?(?:[:=]|:-|\|\|)\s*['\"]?{client_id}\b",
                re.IGNORECASE,
            ),
        )
        for path in sorted(QUANT_VPS_DIR.rglob("*")):
            if not path.is_file() or path.suffix not in CLIENT_ID_SCAN_EXTS:
                continue
            if path in (SERVICE_UNIT, Path(__file__).resolve()):
                continue
            if path.name.startswith("test_"):
                continue
            content = "\n".join(_non_comment_lines(path.read_text(encoding="utf-8", errors="ignore")))
            for pat in id_patterns:
                self.assertIsNone(
                    pat.search(content),
                    f"client id {client_id} collides with {path.relative_to(QUANT_VPS_DIR)}",
                )

    def test_deploy_script_guard_and_scope(self) -> None:
        self.assertTrue(DEPLOY_SCRIPT.is_file(), f"missing {DEPLOY_SCRIPT}")
        self.assertTrue(
            os.access(DEPLOY_SCRIPT, os.X_OK),
            f"{DEPLOY_SCRIPT.name} must be executable",
        )
        text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        alert_text = ALERT_DEPLOY_SCRIPT.read_text(encoding="utf-8")

        syntax = subprocess.run(
            ["bash", "-n", str(DEPLOY_SCRIPT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

        start = "# market-hours-guard:start\n"
        end = "# market-hours-guard:end\n"
        self.assertIn(start, text)
        self.assertIn(end, text)
        block = text[text.index(start) : text.index(end)]
        expected_block = alert_text[alert_text.index(start) : alert_text.index(end)]
        self.assertEqual(block, expected_block)

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

        code_only = "\n".join(_non_comment_lines(text))
        match = FORBIDDEN_DEPLOY_CMD_RE.search(code_only)
        self.assertIsNone(
            match,
            f"forbidden command word in deploy script: {match.group(0) if match else ''}",
        )
        self.assertIsNone(
            TAILNET_RE.search(text),
            "deploy script must not contain tailnet hostnames or IPs",
        )

        # Verify initial service run happens before enabling the timer (avoids OnBootSec race)
        # and required stdout markers exist.
        start_idx = code_only.find("systemctl start vertex-ibkr-open-orders-refresh.service")
        enable_idx = code_only.find("systemctl enable --now vertex-ibkr-open-orders-refresh.timer")
        self.assertGreater(start_idx, -1, "deploy script must start the service once")
        self.assertGreater(enable_idx, -1, "deploy script must enable and start the timer")
        self.assertLess(start_idx, enable_idx, "initial service start must run before enabling timer")
        self.assertIn("START_RC=", code_only)
        self.assertIn("first_run: result=", code_only)
        self.assertIn("protected_containers=unchanged", code_only)


if __name__ == "__main__":
    unittest.main()
