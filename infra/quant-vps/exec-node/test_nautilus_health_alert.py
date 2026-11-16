"""The Nautilus health alert names each state it cannot decide (card vertex-status-b1-quantvps).

Owner rule 2026-11-11 (card vertex-no-unknown-status): a status shows a definite state, its cause,
since when, and the last known value. ``scripts/nautilus_health_alert.py`` posted "Arm state:
unknown" and "docker health unknown"; it now names the cause, the last known arm state and the
last healthy check from its state file. Standard library only; no Docker, no network.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "runtime" / "scripts" / "nautilus_health_alert.py"
_spec = importlib.util.spec_from_file_location("nautilus_health_alert", SCRIPT)
assert _spec is not None and _spec.loader is not None
alert = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = alert  # dataclasses look the module up by name
_spec.loader.exec_module(alert)

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
RUNNING = {"Running": True, "Status": "running", "Health": {"Status": "healthy"}}


def health(arm: object = None, *, beat: datetime = NOW, status: str = "ok") -> dict:
    data: dict = {"status": status, "last_heartbeat_at": beat.isoformat()}
    if arm is not None:
        data["arm"] = arm
    return data


def run_steps(checks, state=None):
    posts: list[str] = []
    state = state or {"consecutive_failures": 0, "alert_open": False}
    for i, check in enumerate(checks):
        state = alert.step(state, check, NOW + timedelta(minutes=i), lambda t: posts.append(t) or True)
    return state, posts


class ArmTextTests(unittest.TestCase):
    def test_unreadable_health_file_names_the_cause(self):
        check = alert.evaluate(RUNNING, None, NOW)
        self.assertEqual(check.arm, "not readable (health file unreadable)")
        self.assertIsNone(check.arm_state)

    def test_missing_arm_block_names_the_cause(self):
        check = alert.evaluate(RUNNING, health(), NOW)
        self.assertEqual(check.arm, "not reported by the node (no arm block in the health file)")
        self.assertIsNone(check.arm_state)

    def test_arm_block_without_state_names_the_cause(self):
        for arm in ({}, {"state": ""}, {"state": None}, {"state": 7}):
            check = alert.evaluate(RUNNING, health(arm), NOW)
            self.assertEqual(check.arm, "missing in the health file (arm block has no state)", arm)
            self.assertIsNone(check.arm_state)

    def test_reported_arm_state_is_kept(self):
        check = alert.evaluate(RUNNING, health({"state": "disarmed"}), NOW)
        self.assertTrue(check.ok)
        self.assertEqual((check.arm, check.arm_state), ("disarmed", "disarmed"))

    def test_no_text_says_unknown(self):
        for state, data in ((RUNNING, None), (RUNNING, health()), (RUNNING, health({})),
                            ({"Running": True, "Health": None}, health())):
            check = alert.evaluate(state, data, NOW)
            self.assertNotIn("unknown", check.arm + check.detail)


class DockerHealthTests(unittest.TestCase):
    def test_no_health_status_cannot_be_verified(self):
        for container in ({"Running": True}, {"Running": True, "Health": None}, {"Running": True, "Health": {}}):
            check = alert.evaluate(container, health({"state": "disarmed"}), NOW)
            self.assertFalse(check.ok)
            self.assertEqual(check.kind, "cannot-verify")
            self.assertEqual(check.detail, "docker reports no health status for the container")

    def test_docker_answers_are_named(self):
        cases = {None: ("down", "container missing (docker lists no nautilus-trader container)"),
                 alert.DOCKER_UNREADABLE: ("cannot-verify", "docker not readable (docker ps or inspect failed)"),
                 alert.DOCKER_AMBIGUOUS: ("cannot-verify", "more than one nautilus-trader container")}
        for state, expected in cases.items():
            check = alert.evaluate(state, health({"state": "disarmed"}), NOW)
            self.assertEqual((check.kind, check.detail), expected, state)

    def test_unhealthy_stays_down(self):
        check = alert.evaluate({"Running": True, "Health": {"Status": "unhealthy"}}, health({"state": "armed"}), NOW)
        self.assertEqual((check.kind, check.detail), ("down", "docker health unhealthy"))

    def test_cannot_verify_alert_headline(self):
        check = alert.evaluate({"Running": True}, health({"state": "disarmed"}), NOW)
        _state, posts = run_steps([check] * 3)
        self.assertEqual(len(posts), 1)
        self.assertIn("(QuantVPS) cannot be verified: docker reports no health status for the container;", posts[0])
        self.assertIn("Arm state: disarmed.", posts[0])

    def test_down_alert_headline_is_unchanged(self):
        check = alert.evaluate(None, health({"state": "disarmed"}), NOW)
        _state, posts = run_steps([check] * 3)
        self.assertIn("(QuantVPS) is down: container missing (docker lists no nautilus-trader container); "
                      "3 failed checks in a row.", posts[0])


class FakeRun:
    """Answers docker ps, then docker inspect, from a list of (returncode, stdout) or an exception."""

    def __init__(self, *replies):
        self.replies = list(replies)

    def __call__(self, argv, **kwargs):
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        code, out = reply
        return type("Done", (), {"returncode": code, "stdout": out})()


class DockerStateTests(unittest.TestCase):
    def test_answers(self):
        cid = "a" * 12
        self.assertIsNone(alert.docker_state(FakeRun((0, ""))))
        self.assertEqual(alert.docker_state(FakeRun((1, ""))), alert.DOCKER_UNREADABLE)
        self.assertEqual(alert.docker_state(FakeRun((0, cid + "\n" + "b" * 12))), alert.DOCKER_AMBIGUOUS)
        self.assertEqual(alert.docker_state(FakeRun((0, cid), (1, ""))), alert.DOCKER_UNREADABLE)
        self.assertEqual(alert.docker_state(FakeRun((0, cid), (0, "not json"))), alert.DOCKER_UNREADABLE)
        self.assertEqual(alert.docker_state(FakeRun((0, cid), (0, "[]"))), alert.DOCKER_UNREADABLE)
        self.assertEqual(alert.docker_state(FakeRun(OSError("no docker"))), alert.DOCKER_UNREADABLE)
        self.assertEqual(alert.docker_state(FakeRun((0, cid), (0, '{"Running": true}'))), {"Running": True})


class LastKnownTests(unittest.TestCase):
    def test_down_message_without_history(self):
        check = alert.evaluate(None, None, NOW)
        _state, posts = run_steps([check] * 3)
        self.assertIn(
            "Arm state: not readable (health file unreadable); no earlier arm state recorded; "
            "no healthy check recorded.",
            posts[0],
        )

    def test_down_message_names_last_known_arm_and_last_healthy_check(self):
        good = alert.evaluate(RUNNING, health({"state": "disarmed"}), NOW)
        bad = alert.evaluate(None, None, NOW)
        state, posts = run_steps([good, bad, bad, bad])
        self.assertEqual(state["last_known_arm"], "disarmed")
        self.assertEqual(state["last_known_arm_at"], "2026-11-15T12:00:00Z")
        self.assertIn(
            "Arm state: not readable (health file unreadable); last known: disarmed at 2026-11-15T12:00:00Z; "
            "last healthy check: 2026-11-15T12:00:00Z.",
            posts[0],
        )

    def test_indefinite_arm_does_not_overwrite_last_known(self):
        good = alert.evaluate(RUNNING, health({"state": "armed"}), NOW)
        bad = alert.evaluate(RUNNING, health(), NOW)  # healthy, but no arm block
        state, _posts = run_steps([good, bad, bad])
        self.assertEqual(state["last_known_arm"], "armed")
        self.assertEqual(state["arm"], "not reported by the node (no arm block in the health file)")

    def test_recovered_message_uses_the_arm_text(self):
        bad = alert.evaluate(None, health({"state": "disarmed"}), NOW)
        good = alert.evaluate(RUNNING, health({"state": "disarmed"}), NOW)
        state, posts = run_steps([bad, bad, bad, good])
        self.assertEqual(len(posts), 2)
        self.assertIn("recovered: healthy, arm state disarmed.", posts[1])
        self.assertFalse(state["alert_open"])

    def test_recovered_without_arm_names_the_cause(self):
        bad = alert.evaluate(None, None, NOW)
        good = alert.evaluate(RUNNING, health(), NOW)
        _state, posts = run_steps([bad, bad, bad, good])
        self.assertIn(
            "recovered: healthy, arm state not reported by the node (no arm block in the health file); "
            "no earlier arm state recorded; no healthy check recorded.",
            posts[1],
        )


class GatewayCheckTests(unittest.TestCase):
    """Card ibkr-drop-1845: the Sunday IBC auto-restart left the gateway logged out for hours and
    nobody was told. The watchdog saw it; this alert reads the watchdog's ib_gateway check."""

    def test_reads_the_watchdog_check(self):
        bad = '{"ok": false, "required": true, "detail": "RuntimeError: ibapi handshake timeout"}'
        self.assertEqual(
            (False, "RuntimeError: ibapi handshake timeout"),
            alert.gateway_check(FakeRun((0, "abc\n"), (0, bad))),
        )
        good = '{"ok": true, "required": true, "detail": "socket_open; ibapi_connected"}'
        self.assertEqual(
            (True, "socket_open; ibapi_connected"), alert.gateway_check(FakeRun((0, "abc"), (0, good)))
        )

    def test_not_required_is_ok(self):
        ok, detail = alert.gateway_check(FakeRun((0, "a"), (0, '{"ok": false, "required": false}')))
        self.assertTrue(ok)
        self.assertIn("not required", detail)

    def test_unreadable_watchdog_is_not_ok(self):
        cases = [
            FakeRun((1, "")),
            FakeRun((0, "")),
            FakeRun((0, "a b")),
            FakeRun(OSError("no docker")),
            FakeRun((0, "a"), (1, "")),
            FakeRun((0, "a"), (0, "not json")),
            FakeRun((0, "a"), (0, "null")),
        ]
        for run in cases:
            self.assertEqual((False, "cannot verify: watchdog status not readable"), alert.gateway_check(run))

    def test_one_alert_after_five_failures_then_one_recovery(self):
        posts: list[str] = []

        def accept(text: str) -> bool:
            posts.append(text)
            return True

        state: dict = {"last_ok_at": "2026-11-15T23:44:00Z"}
        for minute in range(8):
            now = NOW + timedelta(minutes=minute)
            state = alert.gateway_step(state, False, "ibapi handshake timeout", now, accept)
        self.assertEqual(1, len(posts))
        self.assertIn("not reachable since 2026-11-15T12:00:00Z", posts[0])
        self.assertIn("5 failed checks", posts[0])
        self.assertIn("Send IBKR 2FA request", posts[0])
        state = alert.gateway_step(state, True, "ok", NOW + timedelta(minutes=9), accept)
        self.assertEqual(2, len(posts))
        self.assertIn("reachable again. Unreachable since 2026-11-15T12:00:00Z", posts[1])
        self.assertFalse(state["alert_open"])

    def test_failed_post_is_retried(self):
        state = alert.gateway_step({"consecutive_failures": 4}, False, "x", NOW, lambda t: False)
        self.assertFalse(state.get("alert_open"))
        sent: list[str] = []

        def post(text: str) -> bool:
            sent.append(text)
            return True

        state = alert.gateway_step(state, False, "x", NOW, post)
        self.assertTrue(state["alert_open"])
        self.assertEqual(1, len(sent))


if __name__ == "__main__":
    unittest.main()
