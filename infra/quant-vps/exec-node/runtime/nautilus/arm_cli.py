"""Owner arm/disarm CLI. Run it inside the nautilus-trader container.

    python -m nautilus.arm_cli status --json
    python -m nautilus.arm_cli arm --by <actor> --reason <text> \
        --confirm-image-version <version> --json
    python -m nautilus.arm_cli disarm --by <actor> [--reason <text>] --json

Arm is an owner action. Call it only from the Vertex UI bridge (owner password
and typed reason) or through ``omp-approve`` (see docs/NAUTILUS_ARMING.md).
Disarm needs no reason and no approval.

Exit codes: 0 success, 2 refused, 3 unexpected error.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from nautilus import arm_gate

ERROR_SCHEMA = "nautilus-arm-error-v1"


def _print(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, sort_keys=True))
        return
    for key in sorted(payload):
        print(f"{key}={payload[key]}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m nautilus.arm_cli")
    sub = parser.add_subparsers(dest="command", required=True)
    status = sub.add_parser("status", help="print the arm state")
    status.add_argument("--json", action="store_true")
    arm = sub.add_parser("arm", help="arm the node (owner action)")
    arm.add_argument("--by", required=True)
    arm.add_argument("--reason", required=True)
    arm.add_argument("--confirm-image-version", required=True)
    arm.add_argument("--json", action="store_true")
    disarm = sub.add_parser("disarm", help="disarm the node")
    disarm.add_argument("--by", required=True)
    disarm.add_argument("--reason", default="")
    disarm.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None, env: dict[str, str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    gate = arm_gate.gate_from_env(env)
    try:
        if args.command == "status":
            _print(gate.status().as_dict(), args.json)
            return 0
        if args.command == "arm":
            status, audit_id = gate.arm(
                actor=args.by,
                reason=args.reason,
                confirm_image_version=args.confirm_image_version,
            )
        else:
            status, audit_id = gate.disarm(actor=args.by, reason=args.reason)
    except arm_gate.ArmRequestError as exc:
        _print(
            {"schema": ERROR_SCHEMA, "error": exc.code, "detail": exc.detail},
            args.json,
        )
        return 2
    except Exception as exc:  # pragma: no cover - defensive
        _print(
            {"schema": ERROR_SCHEMA, "error": "unexpected", "detail": type(exc).__name__},
            args.json,
        )
        return 3
    payload = status.as_dict()
    payload["audit_id"] = audit_id
    _print(payload, args.json)
    if args.command == "arm" and not status.armed:
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
