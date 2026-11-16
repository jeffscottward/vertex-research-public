#!/usr/bin/env python3
"""Alert #omp-alerts when the Nautilus node is down.

Run once per minute by ``vertex-nautilus-health-alert.timer`` on QuantVPS.

* One check = container running + Docker health "healthy" + a fresh
  heartbeat in ``data/nautilus/health.json``.
* After 3 consecutive failed checks, post one alert for the incident.
* When a check passes again after an alert, post one recovery message.
* If a post fails, the next run tries it again. Nothing else is retried.

The script only reads Docker state (``docker inspect``/``docker ps``), the
health file and the watchdog's ``/status`` (through ``docker exec``). It never
starts, stops or arms the node or the gateway. Standard library only.

It also alerts when the IB Gateway API stays unreachable for 5 checks in a row
(card ibkr-drop-1845). Each Sunday the 23:45 UTC (18:45 ET) IBC auto-restart
needs a full login with 2FA, and the gateway then waits at the login dialog
until the owner asks for a 2FA push. Before this alert, nobody was told.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

UTC = timezone.utc  # host python3 on QuantVPS is 3.10 (no datetime.UTC)
from pathlib import Path
from typing import Any, Callable

DOCKER = "/usr/bin/docker"
COMPOSE_PROJECT = "ibkr-nautilus-exec-node"
SERVICE = "nautilus-trader"
DEFAULT_HEALTH_FILE = "/opt/vertex-exec-node/data/nautilus/health.json"
DEFAULT_STATE_FILE = "/var/lib/vertex-nautilus-health-alert/state.json"
DEFAULT_POST_URL = "http://127.0.0.1:47821/post"
DEFAULT_CHANNEL = "omp-alerts"
FAILURE_THRESHOLD = 3
HEARTBEAT_MAX_AGE_SECONDS = 180


@dataclass(frozen=True)
class Check:
    ok: bool
    detail: str
    # The arm text for the messages: the node's arm state, or why it is not known.
    arm: str
    # The arm state when the node reported one; None when ``arm`` names a cause instead.
    arm_state: str | None = None
    # "down", or "cannot-verify" when the check cannot decide (Docker not readable, more than one
    # container, or no Docker health status).
    kind: str = "down"


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


# docker_state() answers these strings when it has no container state to give.
DOCKER_UNREADABLE = "unreadable"  # a docker command failed, timed out or printed no JSON object
DOCKER_AMBIGUOUS = "ambiguous"  # more than one nautilus-trader container matches


def docker_state(run: Callable[..., Any] = subprocess.run) -> dict[str, Any] | str | None:
    """-> the container State object, None when Docker lists no container, or DOCKER_UNREADABLE /
    DOCKER_AMBIGUOUS."""
    try:
        listed = run(
            [
                DOCKER,
                "ps",
                "-a",
                "-q",
                "--filter",
                f"label=com.docker.compose.project={COMPOSE_PROJECT}",
                "--filter",
                f"label=com.docker.compose.service={SERVICE}",
                # Skip one-off `compose run` containers (the 2FA readiness snapshot).
                "--filter",
                "label=com.docker.compose.oneoff=False",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if listed.returncode != 0:
            return DOCKER_UNREADABLE
        ids = [line for line in (listed.stdout or "").split() if line]
        if not ids:
            return None
        if len(ids) != 1:
            return DOCKER_AMBIGUOUS
        inspected = run(
            [DOCKER, "inspect", "--format", "{{json .State}}", ids[0]],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return DOCKER_UNREADABLE
    if inspected.returncode != 0:
        return DOCKER_UNREADABLE
    try:
        state = json.loads(inspected.stdout)
    except ValueError:
        return DOCKER_UNREADABLE
    return state if isinstance(state, dict) else DOCKER_UNREADABLE


def read_health(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def arm_of(health: dict[str, Any] | None) -> tuple[str, str | None]:
    """-> (arm text, definite arm state or None). Names the cause when the state is missing."""
    if health is None:
        return "not readable (health file unreadable)", None
    arm = health.get("arm")
    if not isinstance(arm, dict):
        return "not reported by the node (no arm block in the health file)", None
    state = arm.get("state")
    if not isinstance(state, str) or not state:
        return "missing in the health file (arm block has no state)", None
    return state, state


def evaluate(
    state: dict[str, Any] | str | None,
    health: dict[str, Any] | None,
    now: datetime,
) -> Check:
    arm, arm_state = arm_of(health)

    def fail(detail: str, kind: str = "down") -> Check:
        return Check(False, detail, arm, arm_state, kind)

    if state is None:
        return fail("container missing (docker lists no nautilus-trader container)")
    if state == DOCKER_UNREADABLE:
        return fail("docker not readable (docker ps or inspect failed)", "cannot-verify")
    if state == DOCKER_AMBIGUOUS:
        return fail("more than one nautilus-trader container", "cannot-verify")
    if not isinstance(state, dict):
        return fail("docker not readable (docker ps or inspect failed)", "cannot-verify")
    if not state.get("Running"):
        return fail(f"container {state.get('Status') or 'not running'}")
    docker_health = (state.get("Health") or {}).get("Status")
    if not docker_health:
        return fail("docker reports no health status for the container", "cannot-verify")
    if docker_health != "healthy":
        return fail(f"docker health {docker_health}")
    if health is None:
        return fail("health file unreadable")
    beat = _parse_time(health.get("last_heartbeat_at"))
    if beat is None or (now - beat).total_seconds() > HEARTBEAT_MAX_AGE_SECONDS:
        return fail("heartbeat stale")
    if health.get("status") != "ok":
        return fail(f"health {health.get('status')}")
    return Check(True, "healthy", arm, arm_state)


def arm_line(check: Check, state: dict[str, Any]) -> str:
    """Arm text for a message. A missing arm state names its cause, the last known state and the
    last healthy check from the alert state file."""
    if check.arm_state is not None:
        return check.arm
    known = state.get("last_known_arm")
    if known:
        last = f"last known: {known} at {state.get('last_known_arm_at')}"
    else:
        last = "no earlier arm state recorded"
    ok_at = state.get("last_ok_at")
    healthy = f"last healthy check: {ok_at}" if ok_at else "no healthy check recorded"
    return f"{check.arm}; {last}; {healthy}"


def post_message(url: str, channel: str, text: str) -> bool:
    body = json.dumps({"channel": channel, "text": text}).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except OSError:
        return False


def load_state(path: Path) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {"consecutive_failures": 0, "alert_open": False}
    if not isinstance(data, dict):
        return {"consecutive_failures": 0, "alert_open": False}
    return data


def save_state(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".state.", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, sort_keys=True)
    os.replace(temporary, path)


def step(
    previous: dict[str, Any],
    check: Check,
    now: datetime,
    post: Callable[[str], bool],
    threshold: int = FAILURE_THRESHOLD,
) -> dict[str, Any]:
    """Pure state transition. ``post`` returns True when Discord accepted it."""

    state = dict(previous)
    stamp = now.isoformat().replace("+00:00", "Z")
    # Built from the previous state, so "last known" and "last healthy check" are earlier values.
    arm = arm_line(check, previous)
    state["last_checked_at"] = stamp
    state["last_detail"] = check.detail
    state["arm"] = check.arm
    if check.arm_state is not None:
        state["last_known_arm"] = check.arm_state
        state["last_known_arm_at"] = stamp
    if check.ok:
        state["consecutive_failures"] = 0
        state["last_ok_at"] = stamp
        if state.get("alert_open"):
            text = (
                "✅ Nautilus node (QuantVPS) recovered: healthy, "
                f"arm state {arm}. Incident started {state.get('incident_started_at')}."
            )
            if post(text):
                state["alert_open"] = False
                state.pop("incident_started_at", None)
        return state
    failures = int(state.get("consecutive_failures") or 0) + 1
    state["consecutive_failures"] = failures
    if failures == 1:
        state["incident_started_at"] = stamp
    if failures >= threshold and not state.get("alert_open"):
        headline = "cannot be verified" if check.kind == "cannot-verify" else "is down"
        text = (
            f"⚠️ Nautilus node (QuantVPS) {headline}: {check.detail}; "
            f"{failures} failed checks in a row. Arm state: {arm}. "
            "Check: ssh quantvps docker ps -a --filter "
            "label=com.docker.compose.service=nautilus-trader"
        )
        if post(text):
            state["alert_open"] = True
    return state


WATCHDOG_SERVICE = "watchdog"
GATEWAY_FAILURE_THRESHOLD = 5  # checks, one per minute
# Runs inside the watchdog container; prints the watchdog's own ib_gateway check as JSON.
WATCHDOG_STATUS_PROBE = (
    "import json,urllib.request;"
    "d=json.load(urllib.request.urlopen('http://127.0.0.1:8081/status',timeout=10));"
    "print(json.dumps(d.get('checks',{}).get('ib_gateway')))"
)
GATEWAY_OWNER_STEP = (
    "Owner step: Vertex Mission control, account card, press \"Send IBKR 2FA request\", "
    "then approve the IBKR push on your phone."
)


def gateway_check(run: Callable[..., Any] = subprocess.run) -> tuple[bool, str]:
    """-> (ok, detail) from the watchdog's ib_gateway check. A watchdog that cannot be read is
    not ok: the gateway state cannot be verified."""
    unreadable = (False, "cannot verify: watchdog status not readable")
    try:
        listed = run(
            [
                DOCKER,
                "ps",
                "-q",
                "--filter",
                f"label=com.docker.compose.project={COMPOSE_PROJECT}",
                "--filter",
                f"label=com.docker.compose.service={WATCHDOG_SERVICE}",
                "--filter",
                "label=com.docker.compose.oneoff=False",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        ids = [line for line in (listed.stdout or "").split() if line]
        if listed.returncode != 0 or len(ids) != 1:
            return unreadable
        probed = run(
            [DOCKER, "exec", ids[0], "python", "-c", WATCHDOG_STATUS_PROBE],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return unreadable
    if probed.returncode != 0:
        return unreadable
    try:
        check = json.loads(probed.stdout)
    except ValueError:
        return unreadable
    if not isinstance(check, dict):
        return unreadable
    detail = str(check.get("detail") or "no detail")
    if not check.get("required"):
        return True, f"not required by the watchdog ({detail})"
    return bool(check.get("ok")), detail


def gateway_step(
    previous: dict[str, Any],
    ok: bool,
    detail: str,
    now: datetime,
    post: Callable[[str], bool],
    threshold: int = GATEWAY_FAILURE_THRESHOLD,
) -> dict[str, Any]:
    """Pure state transition for the IB Gateway API alert: one alert per incident, one recovery."""
    state = dict(previous)
    stamp = now.isoformat().replace("+00:00", "Z")
    state["last_checked_at"] = stamp
    state["last_detail"] = detail
    if ok:
        state["consecutive_failures"] = 0
        state["last_ok_at"] = stamp
        if state.get("alert_open"):
            text = (
                "✅ IBKR gateway API (QuantVPS) reachable again. "
                f"Unreachable since {state.get('incident_started_at')}."
            )
            if post(text):
                state["alert_open"] = False
                state.pop("incident_started_at", None)
        return state
    failures = int(state.get("consecutive_failures") or 0) + 1
    state["consecutive_failures"] = failures
    if failures == 1:
        state["incident_started_at"] = stamp
    if failures >= threshold and not state.get("alert_open"):
        last_ok = state.get("last_ok_at") or "none recorded"
        text = (
            f"⚠️ IBKR gateway API (QuantVPS) not reachable since {state.get('incident_started_at')}: "
            f"{detail}; {failures} failed checks in a row; last good check {last_ok}. "
            "Likely cause: the IBC auto-restart (23:45 UTC, 18:45 ET) needs a full login; "
            f"IBKR requires one each week. {GATEWAY_OWNER_STEP}"
        )
        if post(text):
            state["alert_open"] = True
    return state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health-file", default=DEFAULT_HEALTH_FILE)
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE)
    parser.add_argument("--post-url", default=DEFAULT_POST_URL)
    parser.add_argument("--channel", default=DEFAULT_CHANNEL)
    parser.add_argument("--dry-run", action="store_true", help="print, do not post")
    args = parser.parse_args(argv)

    now = datetime.now(UTC)
    check = evaluate(docker_state(), read_health(Path(args.health_file)), now)

    def post(text: str) -> bool:
        if args.dry_run:
            print(f"would post to #{args.channel}: {text}")
            return True
        return post_message(args.post_url, args.channel, text)

    state_path = Path(args.state_file)
    state = step(load_state(state_path), check, now, post)
    gateway_ok, gateway_detail = gateway_check()
    state["gateway"] = gateway_step(
        state.get("gateway") or {}, gateway_ok, gateway_detail, now, post
    )
    if not args.dry_run:
        save_state(state_path, state)
    print(
        json.dumps(
            {
                "ok": check.ok,
                "detail": check.detail,
                "arm": check.arm,
                "consecutive_failures": state["consecutive_failures"],
                "alert_open": bool(state.get("alert_open")),
                "gateway_ok": gateway_ok,
                "gateway_detail": gateway_detail,
                "gateway_alert_open": bool(state["gateway"].get("alert_open")),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
