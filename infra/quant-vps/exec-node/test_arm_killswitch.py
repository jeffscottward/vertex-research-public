"""Kill switch and arm record: the kill switch must clear the arm record.

Audit finding (state-machine audit 2026-11-03, card sma-vertex-arm-killswitch):
removing the kill switch re-armed the node without an owner action, because
the arm record survived the kill switch.
"""

from __future__ import annotations

import dataclasses
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "runtime" / "nautilus"))
sys.path.insert(0, str(HERE / "runtime"))
import arm_gate  # noqa: E402
from watchdog import watchdog as wd  # noqa: E402

REASON = "owner test arm for kill switch check"


class ArmGateKillSwitchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.armed = self.tmp / "nautilus" / "ARMED"
        self.kill = self.tmp / "KILL_SWITCH"
        self.audit = self.tmp / "nautilus" / "arm-audit.jsonl"
        self.gate = arm_gate.ArmGate(
            self.armed, "img-1", kill_switch_path=self.kill, audit_path=self.audit
        )
        self.gate.arm(actor="owner", reason=REASON, confirm_image_version="img-1")
        self.assertTrue(self.gate.status().armed)

    def test_kill_switch_clears_record_so_removal_does_not_rearm(self) -> None:
        self.kill.write_text("reason=test\n")
        status = self.gate.status()
        self.assertFalse(status.armed)
        self.assertEqual(status.detail, arm_gate.DETAIL_KILL_SWITCH)
        self.assertFalse(self.armed.exists())
        self.kill.unlink()
        after = self.gate.status()
        self.assertFalse(after.armed)
        self.assertEqual(after.detail, arm_gate.DETAIL_NO_RECORD)
        events = [json.loads(line)["event"] for line in self.audit.read_text().splitlines()]
        self.assertIn("disarmed", events)

    def test_require_armed_refuses_and_clears_under_kill_switch(self) -> None:
        self.kill.write_text("reason=test\n")
        with self.assertRaises(arm_gate.DisarmedError):
            self.gate.require_armed("placeOrder", "test")
        self.assertFalse(self.armed.exists())


class ArmRaceTest(unittest.TestCase):
    def test_kill_switch_created_during_arm_refuses_and_leaves_no_record(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        kill = tmp / "KILL_SWITCH"
        gate = arm_gate.ArmGate(tmp / "ARMED", "img-1", kill_switch_path=kill)
        write = gate._write_record

        def write_then_kill(record):
            write(record)
            kill.write_text("reason=race\n")

        gate._write_record = write_then_kill
        with self.assertRaises(arm_gate.ArmRequestError):
            gate.arm(actor="owner", reason=REASON, confirm_image_version="img-1")
        self.assertFalse((tmp / "ARMED").exists())

    def test_audit_failure_while_clearing_still_reports_disarmed(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        gate = arm_gate.ArmGate(tmp / "ARMED", "img-1", kill_switch_path=tmp / "K", audit_path=tmp / "a.jsonl")
        gate.arm(actor="owner", reason=REASON, confirm_image_version="img-1")
        (tmp / "K").write_text("x\n")
        gate.audit_path = tmp / "a.jsonl" / "not-a-dir"
        self.assertFalse(gate.status().armed)
        self.assertFalse((tmp / "ARMED").exists())


class WatchdogKillSwitchTest(unittest.TestCase):
    def test_watchdog_clears_arm_record_while_kill_switch_exists(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        armed = tmp / "nautilus" / "ARMED"
        armed.parent.mkdir(parents=True)
        armed.write_text("{}\n")
        kill = tmp / "KILL_SWITCH"
        config = wd.WatchdogConfig(
            kill_switch_path=kill, nautilus_armed_path=armed, log_dir=tmp / "logs"
        )
        service = wd.WatchdogService(config)
        service.clear_arm_record_on_kill_switch()
        self.assertTrue(armed.exists())
        kill.write_text("reason=test\n")
        service.clear_arm_record_on_kill_switch()
        self.assertFalse(armed.exists())

    def test_armed_path_comes_from_env(self) -> None:
        config = wd.WatchdogConfig.from_env({"NAUTILUS_ARMED_PATH": "/app/data/nautilus/ARMED"})
        self.assertEqual(config.nautilus_armed_path, Path("/app/data/nautilus/ARMED"))


class WatchdogGatewayRequirementTest(unittest.TestCase):
    """A live Nautilus order path (live mode plus live trading or risk orders) needs the IB gateway."""

    LIVE = {
        "TRADING_MODE": "live",
        "ENABLE_LIVE_TRADING": "true",
        "I_UNDERSTAND_LIVE_TRADING_RISK": "true",
        "IBKR_ACCOUNT_ID": "U0000001",
        "LIVE_TRADING_ACCOUNT_ALLOWLIST": "U0000001",
    }

    def required(self, **env: str) -> bool:
        return wd.WatchdogConfig.from_env({"WATCHDOG_HEALTH_PORT": "8081", **env}).ib_gateway_required

    def required_unvalidated(self, **env: str) -> bool:
        # Each term of the live order path alone, without the live-mode safety validation.
        with mock.patch.object(wd, "validate_safe_mode"):
            return self.required(**env)

    def test_valid_live_config_requires_the_gateway(self) -> None:
        self.assertTrue(self.required(**self.LIVE))
        self.assertTrue(self.required(**self.LIVE, NAUTILUS_RISK_ORDERS_ENABLED="true"))

    def test_each_live_order_term_requires_the_gateway(self) -> None:
        self.assertTrue(self.required_unvalidated(TRADING_MODE="live", ENABLE_LIVE_TRADING="true"))
        self.assertTrue(self.required_unvalidated(TRADING_MODE="live", NAUTILUS_RISK_ORDERS_ENABLED="true"))
        self.assertFalse(self.required_unvalidated(TRADING_MODE="live"))

    def test_paper_mode_does_not_require_the_gateway(self) -> None:
        self.assertFalse(self.required(TRADING_MODE="paper"))
        self.assertFalse(self.required(TRADING_MODE="paper", NAUTILUS_RISK_ORDERS_ENABLED="true"))

    def test_explicit_gateway_flags_still_require_it(self) -> None:
        self.assertTrue(self.required(IB_GATEWAY_REQUIRED="true"))
        self.assertTrue(self.required(WATCHDOG_REQUIRE_IB_GATEWAY="true"))
        self.assertTrue(self.required(IBKR_GATEWAY_ENABLED="true"))

    def test_config_has_no_signal_intake_settings(self) -> None:
        names = {field.name for field in dataclasses.fields(wd.WatchdogConfig)}
        self.assertFalse([name for name in names if "charan" in name or "trade_intent" in name])


if __name__ == "__main__":
    unittest.main()
