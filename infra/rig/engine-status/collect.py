#!/usr/bin/env python3
"""Engine status collector (audit phase 5, Engines view; owner choice A, 2026-11-02).

Runs on the rig as a user timer. It reads systemd *unit state only* for the trading-engine timers
(and their services) and copies one JSON document to QuantVPS over the existing `quantvps` SSH
alias host with a dedicated key: QuantVPS forces the only command it may run (write
status.json; see infra/quantvps/engine-status/README.md). No logs, no command lines, no environment, no unit descriptions, no account data.

Output schema `vertex-engine-status-v1`:
  {"schema": "...", "generatedAt": <unix s>, "host": "dev-rig",
   "engines": [{"unit": "market-watch-gex", "timerActive": bool, "serviceState": str,
                "result": str, "exitStatus": int|null, "lastRunAt": <unix s>|null,
                "lastExitAt": <unix s>|null, "nextRunAt": <unix s>|null}]}
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

SCHEMA = "vertex-engine-status-v1"
# Engine timers shown in Vertex: prefixes of rig user timers (verified 2026-11-02).
ENGINE_PREFIXES = ("market-watch-", "crown-", "crowncopy-")
UNIT_NAME = re.compile(r"^[A-Za-z0-9@._-]{1,120}$")
PROPS = (
    "Id",
    "ActiveState",
    "SubState",
    "Result",
    "ExecMainStatus",
    "ExecMainExitTimestamp",
    "NextElapseUSecRealtime",
    "LastTriggerUSec",
)


def run(args: list[str], stdin: str | None = None) -> str:
    return subprocess.run(
        args, input=stdin, capture_output=True, text=True, check=True, timeout=30
    ).stdout


def engine_timers(listing: str) -> list[str]:
    names = []
    for line in listing.splitlines():
        name = line.split()[0] if line.split() else ""
        if not name.endswith(".timer") or not UNIT_NAME.match(name):
            continue
        if name.startswith(ENGINE_PREFIXES):
            names.append(name[: -len(".timer")])
    return sorted(set(names))


def parse_show(text: str) -> dict[str, dict[str, str]]:
    units: dict[str, dict[str, str]] = {}
    for block in text.strip().split("\n\n"):
        props = dict(
            line.split("=", 1) for line in block.splitlines() if "=" in line
        )
        if "Id" in props:
            units[props["Id"]] = props
    return units


def stamp(value: str | None) -> int | None:
    if not value or not value.startswith("@"):
        return None
    try:
        seconds = int(value[1:])
    except ValueError:
        return None
    return seconds if seconds > 0 else None


def exit_status(value: str | None) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except ValueError:
        return None


def build(names: list[str], units: dict[str, dict[str, str]], now: int) -> dict:
    engines = []
    for name in names:
        timer = units.get(f"{name}.timer", {})
        service = units.get(f"{name}.service", {})
        engines.append(
            {
                "unit": name,
                "timerActive": timer.get("ActiveState") == "active",
                "serviceState": service.get("ActiveState", "unknown")[:20],
                "result": service.get("Result", "unknown")[:40],
                "exitStatus": exit_status(service.get("ExecMainStatus")),
                "lastRunAt": stamp(timer.get("LastTriggerUSec")),
                "lastExitAt": stamp(service.get("ExecMainExitTimestamp")),
                "nextRunAt": stamp(timer.get("NextElapseUSecRealtime")),
            }
        )
    return {
        "schema": SCHEMA,
        "generatedAt": now,
        "host": "dev-rig",
        "engines": engines,
    }


def collect(now: int | None = None) -> dict:
    names = engine_timers(
        run(
            [
                "systemctl",
                "--user",
                "list-units",
                "--all",
                "--type=timer",
                "--no-legend",
                "--plain",
            ]
        )
    )
    units = (
        parse_show(
            run(
                [
                    "systemctl",
                    "--user",
                    "show",
                    "--timestamp=unix",
                    "-p",
                    ",".join(PROPS),
                    *[f"{name}.{kind}" for name in names for kind in ("timer", "service")],
                ]
            )
        )
        if names
        else {}
    )
    return build(names, units, int(time.time()) if now is None else now)


KEY = os.path.expanduser("~/.ssh/vertex_engine_status_ed25519")


def push(document: dict, host: str = "quantvps") -> None:
    # The key's authorized_keys entry on QuantVPS forces the remote command (write status.json
    # atomically from stdin) and disables pty and forwarding; any command sent here is ignored.
    body = json.dumps(document, separators=(",", ":"))
    run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-i",
            KEY,
            "-T",
            host,
        ],
        stdin=body,
    )


def main(argv: list[str]) -> int:
    document = collect()
    if "--print" in argv:
        print(json.dumps(document, indent=2))
        return 0
    push(document)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
