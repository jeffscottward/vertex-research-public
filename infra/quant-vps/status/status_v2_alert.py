#!/usr/bin/env python3
"""Alert #omp-alerts when the QuantVPS /vertex-status/v2 tailnet snapshot fails or bypasses auth.

Run every 2 minutes by ``vertex-status-v2-alert.timer`` on QuantVPS. Read-only probe: never
starts, stops, reloads, or reconfigures any service or trading unit. Python 3.10+ stdlib only.

Probes:
  1. Authorized GET with ``Authorization: Bearer <VERTEX_STATUS_TOKEN>`` must return HTTP 200
     with a valid payload whose ``schema`` equals ``vertex-deploy-status-v2`` (max 256 KiB).
  2. Guard GETs without a token and with an invalid bearer token must return HTTP 401 or 403
     whenever the authorized probe did not fail with a transport/timeout error. Any 2xx from
     either guard probe triggers an immediate auth-bypass incident.

Two independent incident state machines persist atomically in plain-text ``key=value`` form:
  - ``avail_*``: alerts once after ``--threshold`` (default 3) consecutive failed ticks, plus
    one recovery message when healthy again.
  - ``bypass_*``: alerts immediately on tick 1 regardless of ``avail_alert_open``, plus one
    recovery message when both guard probes reject unauthorized callers again.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

UTC = timezone.utc  # QuantVPS host python3 is 3.10 (no datetime.UTC)

DEFAULT_HOSTS_ENV = "/etc/vertex/hosts.env"
DEFAULT_TOKEN_ENV = "/opt/vertex-status/token.env"
DEFAULT_STATE_FILE = "/var/lib/vertex-status-v2-alert/state.txt"
DEFAULT_POST_URL = "http://127.0.0.1:47821/post"
DEFAULT_CHANNEL = "omp-alerts"
DEFAULT_TIMEOUT_SECONDS = 8.0
DEFAULT_FAILURE_THRESHOLD = 3
MAX_BODY_BYTES = 262_144
EXPECTED_SCHEMA = "vertex-deploy-status-v2"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


class _RedirectRefusedError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"redirect refused (HTTP {status})")
        self.status = status


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # type: ignore[override]
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        raise _RedirectRefusedError(int(code))


@dataclass(frozen=True)
class ProbeOutcome:
    http_status: int | None
    body: bytes | None
    error: str | None
    transport_error: bool


@dataclass(frozen=True)
class CheckResult:
    ok: bool
    avail_ok: bool
    bypass_ok: bool
    bypass_verified: bool
    auth_http: int | None
    no_token_http: int | None
    wrong_token_http: int | None
    avail_detail: str
    bypass_detail: str


@dataclass
class AlertState:
    avail_failures: int = 0
    avail_alert_open: bool = False
    avail_started_at: str = ""
    avail_reason: str = ""
    bypass_failures: int = 0
    bypass_alert_open: bool = False
    bypass_started_at: str = ""
    bypass_reason: str = ""
    last_checked_at: str = ""
    last_ok_at: str = ""


def _clean_value(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").strip()


def _read_env_value(path: Path, key: str) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    found: str | None = None
    prefix = f"{key}="
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(prefix):
            found = line[len(prefix) :].strip()
    return found


def resolve_probe_url(url_arg: str | None, hosts_env: Path) -> str:
    if url_arg:
        parsed = urllib.parse.urlsplit(url_arg)
        host = (parsed.hostname or "").lower()
        if parsed.scheme == "https" and host:
            return url_arg
        if parsed.scheme == "http" and host in LOOPBACK_HOSTS:
            return url_arg
        raise ValueError(
            "invalid --url: require https:// or loopback http:// (127.0.0.1, ::1, localhost)"
        )
    host_val = _read_env_value(hosts_env, "VERTEX_TAILNET_HOST")
    if not host_val or any(ch in host_val for ch in " \t/\\@:?#"):
        raise ValueError(f"VERTEX_TAILNET_HOST missing or invalid in {hosts_env}")
    return f"https://{host_val}:8443/vertex-status/v2"


def resolve_token(token_env_arg: str | None) -> str:
    if token_env_arg:
        path = Path(token_env_arg)
    else:
        cred_dir = os.environ.get("CREDENTIALS_DIRECTORY", "").strip()
        path = Path(cred_dir) / "status-token" if cred_dir else Path(DEFAULT_TOKEN_ENV)
    token = _read_env_value(path, "VERTEX_STATUS_TOKEN")
    if not token:
        raise ValueError(f"VERTEX_STATUS_TOKEN missing or empty in {path}")
    return token


def resolve_state_file(state_file_arg: str | None) -> Path:
    if state_file_arg:
        return Path(state_file_arg)
    state_dir = os.environ.get("STATE_DIRECTORY", "").strip()
    if state_dir:
        return Path(state_dir) / "state.txt"
    return Path(DEFAULT_STATE_FILE)


def _http_get(url: str, headers: dict[str, str], timeout: float) -> ProbeOutcome:
    parsed = urllib.parse.urlsplit(url)
    handlers: list[urllib.request.BaseHandler] = [_NoRedirectHandler()]
    if parsed.scheme == "https":
        handlers.append(
            urllib.request.HTTPSHandler(context=ssl.create_default_context())
        )
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", resp.getcode()))
            body = resp.read(MAX_BODY_BYTES + 1)
            return ProbeOutcome(status, body, None, False)
    except _RedirectRefusedError as exc:
        return ProbeOutcome(exc.status, None, f"redirect refused (HTTP {exc.status})", False)
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        try:
            exc.close()
        except Exception:  # noqa: BLE001
            pass
        return ProbeOutcome(status, None, f"HTTP {status}", False)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return ProbeOutcome(None, None, f"transport error ({type(exc).__name__})", True)


def run_probes(
    url: str,
    token: str,
    timeout: float,
    fetcher: Callable[[str, dict[str, str], float], ProbeOutcome] = _http_get,
) -> CheckResult:
    auth = fetcher(url, {"Authorization": f"Bearer {token}"}, timeout)
    avail_ok = False
    avail_detail = "ok"

    if auth.transport_error:
        avail_detail = f"authorized probe failed: {auth.error}"
        return CheckResult(
            ok=False,
            avail_ok=False,
            bypass_ok=True,
            bypass_verified=False,
            auth_http=auth.http_status,
            no_token_http=None,
            wrong_token_http=None,
            avail_detail=avail_detail,
            bypass_detail="guard probes skipped after authorized transport error",
        )

    if auth.error and auth.http_status is not None and 300 <= auth.http_status < 400:
        avail_detail = f"authorized probe redirect refused (HTTP {auth.http_status})"
    elif auth.http_status == 403:
        avail_detail = (
            "Caddy allow-list rejected QuantVPS self-probe (HTTP 403) — "
            "check /opt/vertex-status/Caddyfile.tailnet for @status_v2_caller"
        )
    elif auth.http_status == 401:
        avail_detail = (
            "bearer token rejected (HTTP 401) — check /opt/vertex-status/token.env "
            "and vertex-status-tailnet env"
        )
    elif auth.http_status != 200:
        avail_detail = f"unexpected HTTP {auth.http_status} from /vertex-status/v2"
    elif auth.body is None:
        avail_detail = "empty response body from /vertex-status/v2"
    elif len(auth.body) > MAX_BODY_BYTES:
        avail_detail = f"oversized response body (> {MAX_BODY_BYTES} bytes)"
    else:
        try:
            doc = json.loads(auth.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            avail_detail = "invalid JSON body from /vertex-status/v2"
        else:
            if not isinstance(doc, dict) or doc.get("schema") != EXPECTED_SCHEMA:
                avail_detail = (
                    f"unexpected schema in /vertex-status/v2 response "
                    f"(expected {EXPECTED_SCHEMA})"
                )
            else:
                avail_ok = True

    no_tok = fetcher(url, {}, timeout)
    wrong_tok = fetcher(url, {"Authorization": "Bearer invalid-probe"}, timeout)

    bypass_reasons: list[str] = []
    guard_avail_reasons: list[str] = []

    for label, outcome in (("unauthenticated", no_tok), ("wrong-token", wrong_tok)):
        code = outcome.http_status
        if code is not None and 200 <= code < 300:
            bypass_reasons.append(f"{label} probe returned HTTP {code} (auth bypass)")
        elif code in (401, 403):
            continue
        elif outcome.transport_error:
            guard_avail_reasons.append(f"{label} guard probe failed: {outcome.error}")
        else:
            guard_avail_reasons.append(
                f"{label} guard probe returned unexpected HTTP {code} (expected 401/403)"
            )

    bypass_ok = len(bypass_reasons) == 0
    bypass_detail = "; ".join(bypass_reasons) if bypass_reasons else "ok"

    if guard_avail_reasons:
        avail_ok = False
        extra = "; ".join(guard_avail_reasons)
        avail_detail = extra if avail_detail == "ok" else f"{avail_detail}; {extra}"

    bypass_verified = (
        no_tok.http_status in (401, 403) and wrong_tok.http_status in (401, 403)
    )

    return CheckResult(
        ok=avail_ok and bypass_ok,
        avail_ok=avail_ok,
        bypass_ok=bypass_ok,
        bypass_verified=bypass_verified,
        auth_http=auth.http_status,
        no_token_http=no_tok.http_status,
        wrong_token_http=wrong_tok.http_status,
        avail_detail=avail_detail,
        bypass_detail=bypass_detail,
    )


def load_state(path: Path) -> AlertState:
    state = AlertState()
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return state
    kv: dict[str, str] = {}
    for raw in text.splitlines():
        if "=" not in raw:
            continue
        k, v = raw.split("=", 1)
        kv[k.strip()] = v.strip()

    def _int(name: str) -> int:
        try:
            return max(0, int(kv.get(name, "0")))
        except ValueError:
            return 0

    def _bool(name: str) -> bool:
        return kv.get(name, "").lower() == "true"

    state.avail_failures = _int("avail_failures")
    state.avail_alert_open = _bool("avail_alert_open")
    state.avail_started_at = _clean_value(kv.get("avail_started_at", ""))
    state.avail_reason = _clean_value(kv.get("avail_reason", ""))
    state.bypass_failures = _int("bypass_failures")
    state.bypass_alert_open = _bool("bypass_alert_open")
    state.bypass_started_at = _clean_value(kv.get("bypass_started_at", ""))
    state.bypass_reason = _clean_value(kv.get("bypass_reason", ""))
    state.last_checked_at = _clean_value(kv.get("last_checked_at", ""))
    state.last_ok_at = _clean_value(kv.get("last_ok_at", ""))
    return state


def save_state(path: Path, state: AlertState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"avail_failures={state.avail_failures}",
        f"avail_alert_open={'true' if state.avail_alert_open else 'false'}",
        f"avail_started_at={_clean_value(state.avail_started_at)}",
        f"avail_reason={_clean_value(state.avail_reason)}",
        f"bypass_failures={state.bypass_failures}",
        f"bypass_alert_open={'true' if state.bypass_alert_open else 'false'}",
        f"bypass_started_at={_clean_value(state.bypass_started_at)}",
        f"bypass_reason={_clean_value(state.bypass_reason)}",
        f"last_checked_at={_clean_value(state.last_checked_at)}",
        f"last_ok_at={_clean_value(state.last_ok_at)}",
    ]
    payload = "\n".join(lines) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=".state-", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def validate_post_url(post_url: str) -> str:
    parsed = urllib.parse.urlsplit(post_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "http" and host in LOOPBACK_HOSTS:
        return post_url
    raise ValueError(
        "invalid --post-url: require loopback http:// (127.0.0.1, ::1, localhost)"
    )


def post_alert(post_url: str, channel: str, text: str, timeout: float = 8.0) -> bool:
    validate_post_url(post_url)
    body = json.dumps({"channel": channel, "text": text}).encode("utf-8")
    req = urllib.request.Request(
        post_url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - validated loopback URL
            return 200 <= int(getattr(resp, "status", resp.getcode())) < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def step_state(
    state: AlertState,
    result: CheckResult,
    now: datetime,
    threshold: int,
    post: Callable[[str], bool],
) -> tuple[AlertState, bool, bool]:
    now_iso = now.isoformat().replace("+00:00", "Z")
    state.last_checked_at = now_iso
    if result.ok:
        state.last_ok_at = now_iso

    alert_sent = False
    recovery_sent = False

    # 1. Availability incident state machine (default threshold: 3 consecutive failures).
    if result.avail_ok:
        if state.avail_alert_open:
            msg = (
                "✅ QuantVPS `/vertex-status/v2` recovered: Deployments tailnet snapshot "
                f"is healthy again (auth={result.auth_http}, no-token={result.no_token_http}, "
                f"wrong-token={result.wrong_token_http})."
            )
            if post(msg):
                state.avail_alert_open = False
                state.avail_started_at = ""
                state.avail_reason = ""
                recovery_sent = True
        state.avail_failures = 0
    else:
        state.avail_failures += 1
        if not state.avail_started_at:
            state.avail_started_at = now_iso
        state.avail_reason = result.avail_detail
        if state.avail_failures >= threshold and not state.avail_alert_open:
            msg = (
                "⚠️ QuantVPS `/vertex-status/v2` snapshot check failed "
                f"({state.avail_failures} consecutive ticks): {result.avail_detail} "
                f"(auth={result.auth_http}, no-token={result.no_token_http}, "
                f"wrong-token={result.wrong_token_http}). "
                "Vertex `/deployments` cannot read session or kill switch state."
            )
            if post(msg):
                state.avail_alert_open = True
                alert_sent = True

    # 2. Auth-bypass incident state machine (immediate tick-1 alert, independent of avail).
    # Only clear bypass_alert_open when BOTH guard probes explicitly returned 401/403.
    if result.bypass_ok:
        if result.bypass_verified:
            if state.bypass_alert_open:
                msg = (
                    "✅ QuantVPS `/vertex-status/v2` auth guard recovered: unauthenticated and "
                    f"wrong-token requests are rejected again (no-token={result.no_token_http}, "
                    f"wrong-token={result.wrong_token_http})."
                )
                if post(msg):
                    state.bypass_alert_open = False
                    state.bypass_started_at = ""
                    state.bypass_reason = ""
                    recovery_sent = True
            state.bypass_failures = 0
    else:
        state.bypass_failures += 1
        if not state.bypass_started_at:
            state.bypass_started_at = now_iso
        state.bypass_reason = result.bypass_detail
        if not state.bypass_alert_open:
            msg = (
                "🚨 QuantVPS `/vertex-status/v2` auth bypass detected: "
                f"{result.bypass_detail} (no-token={result.no_token_http}, "
                f"wrong-token={result.wrong_token_http}). Check /opt/vertex-status/Caddyfile.tailnet immediately."
            )
            if post(msg):
                state.bypass_alert_open = True
                alert_sent = True

    return state, alert_sent, recovery_sent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Probe QuantVPS /vertex-status/v2 and alert #omp-alerts on 403/failures/auth bypass."
    )
    parser.add_argument("--hosts-env", default=DEFAULT_HOSTS_ENV)
    parser.add_argument("--token-env", default=None)
    parser.add_argument("--url", default=None)
    parser.add_argument("--state-file", default=None)
    parser.add_argument("--post-url", default=DEFAULT_POST_URL)
    parser.add_argument("--channel", default=DEFAULT_CHANNEL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--threshold", type=int, default=DEFAULT_FAILURE_THRESHOLD)
    parser.add_argument("--dry-run", action="store_true", help="probe only; do not post or write state")
    args = parser.parse_args(argv)

    if args.timeout <= 0 or args.threshold < 1:
        print(json.dumps({"error": "invalid --timeout or --threshold", "ok": False}))
        return 1

    try:
        url = resolve_probe_url(args.url, Path(args.hosts_env))
        post_url = validate_post_url(args.post_url)
        token = resolve_token(args.token_env)
    except ValueError as exc:
        print(json.dumps({"error": str(exc), "ok": False}))
        return 1

    state_path = resolve_state_file(args.state_file)
    now = datetime.now(UTC)
    result = run_probes(url, token, args.timeout)

    def _post(text: str) -> bool:
        if args.dry_run:
            return False
        return post_alert(post_url, args.channel, text, timeout=min(args.timeout, 8.0))
    state = load_state(state_path)
    state, alert_sent, recovery_sent = step_state(
        state, result, now, args.threshold, _post
    )
    if not args.dry_run:
        save_state(state_path, state)

    detail_parts = []
    if not result.avail_ok:
        detail_parts.append(result.avail_detail)
    if not result.bypass_ok:
        detail_parts.append(result.bypass_detail)
    detail = "; ".join(detail_parts) if detail_parts else "ok"

    summary = {
        "alert_sent": alert_sent,
        "auth_http": result.auth_http,
        "avail_alert_open": state.avail_alert_open,
        "avail_failures": state.avail_failures,
        "bypass_alert_open": state.bypass_alert_open,
        "checked_at": state.last_checked_at,
        "detail": detail,
        "no_token_http": result.no_token_http,
        "ok": result.ok,
        "recovery_sent": recovery_sent,
        "wrong_token_http": result.wrong_token_http,
    }
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
