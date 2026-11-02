#!/usr/bin/env python3
"""Verify real IBKR cash and positions through the TWS API."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from nautilus.ibkr_account import (  # noqa: E402
    IbkrAccountSnapshotClient,
    sanitize_account_references,
)


def read_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = dict(os.environ)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return env
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(REPO_ROOT / ".env"))
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--client-id", type=int, default=None)
    parser.add_argument("--account-id", default=None)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument(
        "--market-values-timeout-seconds",
        type=float,
        default=None,
        help="wait for optional updatePortfolio market values (default: --timeout-seconds)",
    )
    parser.add_argument(
        "--output-dir", default=str(REPO_ROOT / "data/nautilus/reports")
    )
    return parser.parse_args()


def account_fingerprint(account: str, key: str) -> str:
    return hmac.new(
        key.encode("utf-8"),
        f"vertex-quant/ibkr-account/v1:{account.strip().upper()}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def sanitize_error_detail(detail: str, account_id: str) -> str:
    return sanitize_account_references(detail, account_id)


def main() -> int:
    args = parse_args()
    env = read_env(Path(args.env_file))
    account_id = args.account_id or env.get("IBKR_ACCOUNT_ID", "")
    if not account_id:
        raise SystemExit("IBKR_ACCOUNT_ID is required for account verification")
    fingerprint_key = env.get("SYNTHETIC_STOP_ACCOUNT_FINGERPRINT_KEY", "")
    if not fingerprint_key:
        raise SystemExit(
            "SYNTHETIC_STOP_ACCOUNT_FINGERPRINT_KEY is required for account-bound snapshots"
        )
    # Pass the market-values timeout only when set: callers such as
    # poll-order-notify.sh stage this script without nautilus/, so it can run
    # against an older image copy of IbkrAccountSnapshotClient.
    client_options: dict[str, float] = {"timeout_seconds": args.timeout_seconds}
    market_values_timeout = getattr(args, "market_values_timeout_seconds", None)
    if market_values_timeout is not None:
        client_options["market_values_timeout_seconds"] = market_values_timeout
    client = IbkrAccountSnapshotClient(
        args.host or env.get("IB_GATEWAY_HOST") or env.get("IBKR_HOST") or "127.0.0.1",
        args.port or int(env.get("IB_GATEWAY_PORT") or env.get("IBKR_PORT") or 4002),
        args.client_id or int(env.get("IBKR_CLIENT_ID") or 11),
        account_id,
        **client_options,
    )
    try:
        snapshot = client.snapshot()
    except Exception as exc:
        detail = sanitize_error_detail(str(exc), account_id)
        print(f"IBKR snapshot failed: {type(exc).__name__}: {detail}", file=sys.stderr)
        return 1
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"ibkr-account-snapshot-{stamp}.json"
    payload = snapshot.to_dict()
    payload["schemaVersion"] = "ibkr-account-snapshot/v1"
    payload["account_fingerprint"] = account_fingerprint(account_id, fingerprint_key)
    payload["generated_at"] = datetime.now(UTC).isoformat()
    payload["source"] = "ibkr_tws_api"
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "snapshot": str(path),
                "account": payload["account_masked"],
                "available_funds_usd": payload["available_funds_usd"],
                "positions": len(payload["positions"]),
                "market_values": payload.get("market_values_status"),
            }
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
