#!/usr/bin/env python3
"""Alert #omp-alerts when the Nautilus node is down.

Run once per minute by ``vertex-nautilus-health-alert.timer`` on QuantVPS.

* One check = container running + Docker health "healthy" + a fresh
  heartbeat in ``data/nautilus/health.json``.
* After 3 consecutive failed checks, post one alert for the incident.
* When a check passes again after an alert, post one recovery message.
* If a post fails, the next run tries it again. Nothing else is retried.

The script only reads Docker state (``docker inspect``/``docker ps``) and the
health file. It never starts, stops or arms the node. Standard library only.
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
    arm: str


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def docker_state(run: Callable[..., Any] = subprocess.run) -> dict[str, Any] | None:
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
    ids = [line for line in (listed.stdout or "").split() if line]
    if listed.returncode != 0 or len(ids) != 1:
        return None
    inspected = run(
        [DOCKER, "inspect", "--format", "{{json .State}}", ids[0]],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if inspected.returncode != 0:
        return None
    try:
        state = json.loads(inspected.stdout)
    except ValueError:
        return None
    return state if isinstance(state, dict) else None


def read_health(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def evaluate(
    state: dict[str, Any] | None,
    health: dict[str, Any] | None,
    now: datetime,
) -> Check:
    arm = "unknown"
    if isinstance(health, dict) and isinstance(health.get("arm"), dict):
        arm = str(health["arm"].get("state") or "unknown")
    if state is None:
        return Check(False, "container missing", arm)
    if not state.get("Running"):
        return Check(False, f"container {state.get('Status') or 'not running'}", arm)
    docker_health = (state.get("Health") or {}).get("Status")
    if docker_health != "healthy":
        return Check(False, f"docker health {docker_health or 'unknown'}", arm)
    if health is None:
        return Check(False, "health file unreadable", arm)
    beat = _parse_time(health.get("last_heartbeat_at"))
    if beat is None or (now - beat).total_seconds() > HEARTBEAT_MAX_AGE_SECONDS:
        return Check(False, "heartbeat stale", arm)
    if health.get("status") != "ok":
        return Check(False, f"health {health.get('status')}", arm)
    return Check(True, "healthy", arm)


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
    state["last_checked_at"] = stamp
    state["last_detail"] = check.detail
    state["arm"] = check.arm
    if check.ok:
        state["consecutive_failures"] = 0
        state["last_ok_at"] = stamp
        if state.get("alert_open"):
            text = (
                "✅ Nautilus node (QuantVPS) recovered: healthy, "
                f"arm state {check.arm}. Incident started {state.get('incident_started_at')}."
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
        text = (
            f"⚠️ Nautilus node (QuantVPS) is down: {check.detail}; "
            f"{failures} failed checks in a row. Arm state: {check.arm}. "
            "Check: ssh quantvps docker ps -a --filter "
            "label=com.docker.compose.service=nautilus-trader"
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
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
