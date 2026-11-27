#!/usr/bin/env python3
"""Unit and invariant tests for migrating status-v2 orders/fills to ibkr-monitor
and retiring the transitional vertex-ibkr-open-orders-refresh timer.

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
ALERT_DEPLOY_SCRIPT = HERE / "deploy-status-v2-alert.sh"
DEPLOY_SCRIPT = HERE / "deploy-status-v2-ibkr-monitor.sh"

RETIRED_FILES = (
    HERE / "vertex-ibkr-open-orders-refresh.service",
    HERE / "vertex-ibkr-open-orders-refresh.timer",
    HERE / "deploy-open-orders-refresh.sh",
    HERE / "test_open_orders_refresh.py",
)

TAILNET_RE = re.compile(r"\b100\.\d+\.\d+\.\d+\b|fd7a:|\.ts\.net\b")
FORBIDDEN_CONTAINER_OR_TRADING_CMD_RE = re.compile(
    r"\b(?:docker\s+(?:restart|stop|rm|compose)|compose|systemctl\s+(?:restart|stop)\s+(?:ibkr-monitor|vertex-nautilus|vertex-portfolio|vertex-history|vertex-ibkr-recovery|vertex-web))\b",
    re.IGNORECASE,
)

if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import collect  # noqa: E402


def _non_comment_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


class DeployStatusV2IbkrMonitorTests(unittest.TestCase):
    def test_transitional_open_orders_timer_files_are_retired(self) -> None:
        for path in RETIRED_FILES:
            self.assertFalse(
                path.exists(),
                f"transitional open-orders file should be retired: {path.name}",
            )

    def test_collect_has_no_disk_report_or_mutating_ibkr_monitor_paths(self) -> None:
        source = (HERE / "collect.py").read_text(encoding="utf-8")
        for forbidden in (
            "OPEN_ORDERS_FILE",
            "FILLS_FILE",
            "ibkr-open-orders.json",
            "ibkr-fills.json",
            "/api/ibkr-2fa",
            'method="POST"',
            "method='POST'",
        ):
            self.assertNotIn(forbidden, source)
        self.assertEqual(collect.COLLECTOR_VERSION, "2.3.0")

    def test_deploy_script_guard_scope_and_ordering(self) -> None:
        self.assertTrue(DEPLOY_SCRIPT.is_file(), f"missing {DEPLOY_SCRIPT}")
        self.assertTrue(
            os.access(DEPLOY_SCRIPT, os.X_OK),
            f"{DEPLOY_SCRIPT.name} must be executable (mode 0755)",
        )
        syntax = subprocess.run(
            ["bash", "-n", str(DEPLOY_SCRIPT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

        deploy_text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.assertIsNone(
            TAILNET_RE.search(deploy_text),
            f"{DEPLOY_SCRIPT.name} must not contain tailnet addresses",
        )

        # Market-hours guard must match deploy-status-v2-alert.sh verbatim.
        guard_re = re.compile(
            r"# market-hours-guard:start.*?# market-hours-guard:end",
            re.DOTALL,
        )
        alert_guard = guard_re.search(ALERT_DEPLOY_SCRIPT.read_text(encoding="utf-8"))
        deploy_guard = guard_re.search(deploy_text)
        self.assertIsNotNone(alert_guard)
        self.assertIsNotNone(deploy_guard)
        assert alert_guard is not None and deploy_guard is not None
        self.assertEqual(deploy_guard.group(0), alert_guard.group(0))

        # Test market-hours guard offline with VERTEX_DEPLOY_NY_TIME.
        guard_snippet = f"set -euo pipefail\n{deploy_guard.group(0)}\nexit 0\n"
        for ny_time, expected_rc in (
            ("1 0830 EST", 3),
            ("3 1200 EDT", 3),
            ("5 1559 EDT", 3),
            ("6 1200 UTC", 3),
            ("bad", 3),
            ("1 0829 EST", 0),
            ("5 1600 EDT", 0),
            ("6 1200 EST", 0),
            ("7 0900 EDT", 0),
        ):
            env = {k: v for k, v in os.environ.items() if k != "VERTEX_DEPLOY_NY_TIME"}
            env["VERTEX_DEPLOY_NY_TIME"] = ny_time
            res = subprocess.run(
                ["bash", "-c", guard_snippet],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            self.assertEqual(
                res.returncode,
                expected_rc,
                f"VERTEX_DEPLOY_NY_TIME={ny_time!r}: {res.stdout} {res.stderr}",
            )

        code_only = "\n".join(_non_comment_lines(deploy_text))
        self.assertIsNone(
            FORBIDDEN_CONTAINER_OR_TRADING_CMD_RE.search(code_only),
            f"forbidden container/trading command in {DEPLOY_SCRIPT.name}",
        )

        # Strict safety ordering: dry-run preflight -> install collect.py -> live collector run
        # & verify -> retire transitional timer -> check protected containers unchanged.
        preflight_idx = code_only.find("--verify-ibkr-monitor")
        install_idx = code_only.find("install -m 700")
        start_idx = code_only.find("systemctl start vertex-status-collect.service")
        verify_idx = code_only.find("--check-v2-dir")
        retire_idx = code_only.find(
            "systemctl disable --now vertex-ibkr-open-orders-refresh.timer"
        )
        rm_units_idx = code_only.find(
            "rm -f /etc/systemd/system/vertex-ibkr-open-orders-refresh.service"
        )
        for name, idx in (
            ("--verify-ibkr-monitor", preflight_idx),
            ("install -m 700", install_idx),
            ("systemctl start vertex-status-collect.service", start_idx),
            ("--check-v2-dir", verify_idx),
            ("retire timer", retire_idx),
            ("remove retired unit files", rm_units_idx),
        ):
            self.assertGreaterEqual(idx, 0, f"missing {name} in {DEPLOY_SCRIPT.name}")
        self.assertLess(preflight_idx, install_idx)
        self.assertLess(install_idx, start_idx)
        self.assertLess(start_idx, verify_idx)
        self.assertLess(verify_idx, retire_idx)
        self.assertLess(retire_idx, rm_units_idx)

        self.assertIn("retired_timer=ok", code_only)
        self.assertIn("protected_containers=unchanged", code_only)
        self.assertIn("rollback-", code_only)
        self.assertIn("systemctl daemon-reload", code_only)


if __name__ == "__main__":
    unittest.main(verbosity=1)
