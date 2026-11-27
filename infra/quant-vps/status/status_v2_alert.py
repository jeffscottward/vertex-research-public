#!/usr/bin/env python3
"""Alert #omp-alerts when QuantVPS /vertex-status/v2 fails, bypasses auth, or serves stale broker blocks.

Run every 2 minutes by ``vertex-status-v2-alert.timer`` on QuantVPS. Read-only probe: never
starts, stops, reloads, or reconfigures any service or trading unit. Python 3.10+ stdlib only.

Probes:
  1. Authorized GET with ``Authorization: Bearer <VERTEX_STATUS_TOKEN>`` must return HTTP 200
     with a valid payload whose ``schema`` equals ``vertex-deploy-status-v2`` (max 256 KiB).
  2. Guard GETs without a token and with an invalid bearer token must return HTTP 401 or 403
     whenever the authorized probe did not fail with a transport/timeout error. Any 2xx from
     either guard probe triggers an immediate auth-bypass incident.
  3. Freshness inspection of the authorized ``status-v2`` payload: checks top-level
     ``generatedAt`` and the monitored broker blocks (default: ``orders``, ``fills``,
     ``positions``, ``equity``). Fails closed when any monitored block is missing, reports
     ``available != True``, reports ``stale != False``, lacks a valid UTC ``as_of``, or
     exceeds ``--stale-max-age`` seconds (default 360 s) by wall-clock or reported age.

Three independent incident state machines persist atomically in plain-text ``key=value`` form:
  - ``avail_*``: alerts once after ``--threshold`` (default 3) consecutive failed ticks, plus
    one recovery message when healthy again.
  - ``bypass_*``: alerts immediately on tick 1 regardless of ``avail_alert_open``, plus one
    recovery message when both guard probes reject unauthorized callers again.
  - ``stale_*``: alerts once after ``--stale-threshold`` (default: inherits ``--threshold``, 3)
    consecutive degraded ticks, plus one recovery message when all monitored blocks and
    ``generatedAt`` are available and fresh again. Pauses when the authorized probe fails so
    HTTP outages neither raise spurious stale alerts nor falsely clear an open stale incident.
"""

from __future__ import annotations

import argparse
import json
import math
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
DEFAULT_STALE_BLOCKS: tuple[str, ...] = ("orders", "fills", "positions", "equity")
VALID_STALE_BLOCKS: frozenset[str] = frozenset(DEFAULT_STALE_BLOCKS)
DEFAULT_STALE_MAX_AGE_SECONDS = 360
MAX_FUTURE_SKEW_SECONDS = 60
MAX_REASON_CHARS = 120
MAX_TIMESTAMP_CHARS = 40
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
    stale_ok: bool = True
    stale_verified: bool = False
    stale_blocks: tuple[str, ...] = ()
    stale_detail: str = "ok"
    block_ages: tuple[tuple[str, int], ...] = ()


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
    stale_failures: int = 0
    stale_alert_open: bool = False
    stale_started_at: str = ""
    stale_reason: str = ""
    stale_blocks: str = ""
    last_checked_at: str = ""
    last_ok_at: str = ""


def _clean_value(value: str) -> str:
    return " ".join(value.splitlines()).strip()


def _sanitize_text(
    value: Any,
    *,
    max_chars: int = MAX_REASON_CHARS,
    fallback: str = "no reason given",
    secret_token: str = "",
) -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = _clean_value(value)
    if secret_token and secret_token in cleaned:
        cleaned = cleaned.replace(secret_token, "[redacted]")
    if not cleaned:
        return fallback
    if len(cleaned) > max_chars:
        return cleaned[: max_chars - 1].rstrip() + "…"
    return cleaned


def _parse_iso_utc(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # Python 3.10 datetime.fromisoformat() does not accept trailing "Z".
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None or dt.utcoffset() is None:
        return None
    return dt.astimezone(UTC)


def parse_stale_blocks(raw: str) -> tuple[str, ...]:
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    if not parts:
        raise ValueError("invalid --stale-blocks: require at least one block name")
    deduped: list[str] = []
    for name in parts:
        if name not in VALID_STALE_BLOCKS:
            allowed = ",".join(DEFAULT_STALE_BLOCKS)
            raise ValueError(
                f"invalid --stale-blocks entry {name!r}: expected subset of {allowed}"
            )
        if name not in deduped:
            deduped.append(name)
    return tuple(deduped)


def inspect_stale_blocks(
    doc: dict[str, Any],
    now: datetime,
    blocks: tuple[str, ...] = DEFAULT_STALE_BLOCKS,
    stale_max_age: int = DEFAULT_STALE_MAX_AGE_SECONDS,
    secret_token: str = "",
) -> tuple[bool, tuple[str, ...], str, tuple[tuple[str, int], ...]]:
    """Inspect top-level generatedAt and monitored status-v2 broker blocks (fail closed)."""
    degraded: list[str] = []
    reasons: list[str] = []
    fresh_ages: list[tuple[str, int]] = []

    gen_raw = doc.get("generatedAt")
    gen_dt = _parse_iso_utc(gen_raw)
    if gen_dt is None:
        degraded.append("snapshot")
        reasons.append("snapshot: missing/invalid generatedAt")
    else:
        gen_age = int((now - gen_dt).total_seconds())
        if gen_age > stale_max_age:
            gen_txt = _sanitize_text(
                gen_raw,
                max_chars=MAX_TIMESTAMP_CHARS,
                fallback="unknown",
                secret_token=secret_token,
            )
            degraded.append("snapshot")
            reasons.append(
                f"snapshot: stale generatedAt (age={gen_age}s, generatedAt={gen_txt})"
            )
        elif gen_age < -MAX_FUTURE_SKEW_SECONDS:
            gen_txt = _sanitize_text(
                gen_raw,
                max_chars=MAX_TIMESTAMP_CHARS,
                fallback="unknown",
                secret_token=secret_token,
            )
            degraded.append("snapshot")
            reasons.append(
                f"snapshot: future generatedAt (skew=+{abs(gen_age)}s, generatedAt={gen_txt})"
            )

    for name in blocks:
        blk = doc.get(name)
        if not isinstance(blk, dict):
            degraded.append(name)
            reasons.append(f"{name}: missing")
            continue

        if blk.get("available") is not True:
            reason = _sanitize_text(blk.get("reason"), secret_token=secret_token)
            degraded.append(name)
            reasons.append(f"{name}: unavailable ({reason})")
            continue

        as_of_raw = blk.get("as_of")
        as_of_dt = _parse_iso_utc(as_of_raw)
        as_of_txt = _sanitize_text(
            as_of_raw,
            max_chars=MAX_TIMESTAMP_CHARS,
            fallback="null",
            secret_token=secret_token,
        )
        age_raw = blk.get("age_seconds")
        age_int: int | None
        if (
            isinstance(age_raw, (int, float))
            and not isinstance(age_raw, bool)
            and math.isfinite(age_raw)
        ):
            age_int = int(age_raw)
        else:
            age_int = None
        wall_age = int((now - as_of_dt).total_seconds()) if as_of_dt is not None else None

        stale_flag = blk.get("stale")
        if stale_flag is True:
            degraded.append(name)
            if age_int is not None and wall_age is not None:
                reported_age: int | None = max(0, age_int, wall_age)
            elif age_int is not None:
                reported_age = max(0, age_int)
            elif wall_age is not None:
                reported_age = max(0, wall_age)
            else:
                reported_age = None
            age_txt = f"{reported_age}s" if reported_age is not None else "unknown"
            reasons.append(f"{name}: stale (age={age_txt}, as_of={as_of_txt})")
            continue

        if stale_flag is not False:
            degraded.append(name)
            reasons.append(f"{name}: missing/invalid stale flag")
            continue

        if as_of_dt is None:
            degraded.append(name)
            reasons.append(f"{name}: missing/invalid as_of")
            continue

        assert wall_age is not None
        if wall_age > stale_max_age:
            degraded.append(name)
            reasons.append(
                f"{name}: stale by clock (age={wall_age}s, as_of={as_of_txt})"
            )
            continue

        if wall_age < -MAX_FUTURE_SKEW_SECONDS:
            degraded.append(name)
            reasons.append(
                f"{name}: future as_of (skew=+{abs(wall_age)}s, as_of={as_of_txt})"
            )
            continue

        if age_int is not None and age_int > stale_max_age:
            degraded.append(name)
            reasons.append(
                f"{name}: stale age_seconds (age={age_int}s, as_of={as_of_txt})"
            )
            continue

        fresh_ages.append((name, max(0, wall_age)))

    stale_ok = len(degraded) == 0
    stale_detail = "; ".join(reasons) if reasons else "ok"
    return stale_ok, tuple(degraded), stale_detail, tuple(fresh_ages)


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
    *,
    now: datetime | None = None,
    stale_blocks: tuple[str, ...] = DEFAULT_STALE_BLOCKS,
    stale_max_age: int = DEFAULT_STALE_MAX_AGE_SECONDS,
) -> CheckResult:
    probe_now = now if now is not None else datetime.now(UTC)
    auth = fetcher(url, {"Authorization": f"Bearer {token}"}, timeout)
    avail_ok = False
    avail_detail = "ok"
    parsed_doc: dict[str, Any] | None = None

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
            stale_ok=True,
            stale_verified=False,
            stale_blocks=(),
            stale_detail="stale check skipped (authorized probe failed)",
            block_ages=(),
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
                parsed_doc = doc

    if parsed_doc is not None:
        stale_ok, degraded_blocks, stale_detail, block_ages = inspect_stale_blocks(
            parsed_doc,
            probe_now,
            blocks=stale_blocks,
            stale_max_age=stale_max_age,
            secret_token=token,
        )
        stale_verified = True
    else:
        stale_ok = True
        degraded_blocks = ()
        stale_detail = "stale check skipped (authorized probe failed)"
        block_ages = ()
        stale_verified = False

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

    overall_ok = avail_ok and bypass_ok and (stale_ok if stale_verified else True)

    return CheckResult(
        ok=overall_ok,
        avail_ok=avail_ok,
        bypass_ok=bypass_ok,
        bypass_verified=bypass_verified,
        auth_http=auth.http_status,
        no_token_http=no_tok.http_status,
        wrong_token_http=wrong_tok.http_status,
        avail_detail=avail_detail,
        bypass_detail=bypass_detail,
        stale_ok=stale_ok,
        stale_verified=stale_verified,
        stale_blocks=degraded_blocks,
        stale_detail=stale_detail,
        block_ages=block_ages,
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
    state.stale_failures = _int("stale_failures")
    state.stale_alert_open = _bool("stale_alert_open")
    state.stale_started_at = _clean_value(kv.get("stale_started_at", ""))
    state.stale_reason = _clean_value(kv.get("stale_reason", ""))
    state.stale_blocks = _clean_value(kv.get("stale_blocks", ""))
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
        f"stale_failures={state.stale_failures}",
        f"stale_alert_open={'true' if state.stale_alert_open else 'false'}",
        f"stale_started_at={_clean_value(state.stale_started_at)}",
        f"stale_reason={_clean_value(state.stale_reason)}",
        f"stale_blocks={_clean_value(state.stale_blocks)}",
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
    *,
    stale_threshold: int | None = None,
) -> tuple[AlertState, bool, bool]:
    now_iso = now.isoformat().replace("+00:00", "Z")
    eff_stale_threshold = threshold if stale_threshold is None else stale_threshold
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

    # 3. Stale/unavailable broker-block state machine (independent of avail and bypass).
    # Only evaluate when the authorized status-v2 payload was actually fetched and parsed
    # (stale_verified=True), so HTTP 403/5xx/transport outages neither raise spurious stale alerts
    # nor falsely clear an open stale-block incident.
    if result.stale_verified:
        if result.stale_ok:
            if state.stale_alert_open:
                ages_txt = ", ".join(f"{k}={v}s" for k, v in result.block_ages)
                suffix = f" ({ages_txt})" if ages_txt else ""
                msg = (
                    "✅ QuantVPS `/vertex-status/v2` broker blocks recovered: "
                    f"snapshot and monitored blocks are available and fresh again{suffix}."
                )
                if post(msg):
                    state.stale_alert_open = False
                    state.stale_started_at = ""
                    state.stale_reason = ""
                    state.stale_blocks = ""
                    recovery_sent = True
            else:
                state.stale_started_at = ""
                state.stale_reason = ""
                state.stale_blocks = ""
            state.stale_failures = 0
        else:
            state.stale_failures += 1
            if not state.stale_started_at:
                state.stale_started_at = now_iso
            state.stale_reason = result.stale_detail
            state.stale_blocks = ",".join(result.stale_blocks)
            if state.stale_failures >= eff_stale_threshold and not state.stale_alert_open:
                msg = (
                    "⚠️ QuantVPS `/vertex-status/v2` stale/unavailable broker blocks "
                    f"({state.stale_failures} consecutive ticks): {result.stale_detail}. "
                    "Check `ibkr-monitor.service` and `vertex-status-collect.timer`."
                )
                if post(msg):
                    state.stale_alert_open = True
                    alert_sent = True

    return state, alert_sent, recovery_sent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Probe QuantVPS /vertex-status/v2 and alert #omp-alerts on 403/failures, "
            "auth bypass, or stale/unavailable broker blocks."
        )
    )
    parser.add_argument("--hosts-env", default=DEFAULT_HOSTS_ENV)
    parser.add_argument("--token-env", default=None)
    parser.add_argument("--url", default=None)
    parser.add_argument("--state-file", default=None)
    parser.add_argument("--post-url", default=DEFAULT_POST_URL)
    parser.add_argument("--channel", default=DEFAULT_CHANNEL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--threshold", type=int, default=DEFAULT_FAILURE_THRESHOLD)
    parser.add_argument(
        "--stale-threshold",
        type=int,
        default=None,
        help="consecutive stale-block ticks before alerting (default: inherits --threshold)",
    )
    parser.add_argument(
        "--stale-max-age",
        type=int,
        default=DEFAULT_STALE_MAX_AGE_SECONDS,
        help="max wall-clock age in seconds for generatedAt and block as_of (default: 360)",
    )
    parser.add_argument(
        "--stale-blocks",
        default=",".join(DEFAULT_STALE_BLOCKS),
        help="comma-separated status-v2 broker blocks to check (default: orders,fills,positions,equity)",
    )
    parser.add_argument("--dry-run", action="store_true", help="probe only; do not post or write state")
    args = parser.parse_args(argv)

    if (
        args.timeout <= 0
        or args.threshold < 1
        or (args.stale_threshold is not None and args.stale_threshold < 1)
        or args.stale_max_age < 1
    ):
        print(
            json.dumps(
                {
                    "error": "invalid --timeout, --threshold, --stale-threshold, or --stale-max-age",
                    "ok": False,
                }
            )
        )
        return 1

    try:
        url = resolve_probe_url(args.url, Path(args.hosts_env))
        post_url = validate_post_url(args.post_url)
        token = resolve_token(args.token_env)
        stale_blocks = parse_stale_blocks(args.stale_blocks)
    except ValueError as exc:
        print(json.dumps({"error": str(exc), "ok": False}))
        return 1

    state_path = resolve_state_file(args.state_file)
    now = datetime.now(UTC)
    result = run_probes(
        url,
        token,
        args.timeout,
        now=now,
        stale_blocks=stale_blocks,
        stale_max_age=args.stale_max_age,
    )

    def _post(text: str) -> bool:
        if args.dry_run:
            return False
        return post_alert(post_url, args.channel, text, timeout=min(args.timeout, 8.0))

    state = load_state(state_path)
    state, alert_sent, recovery_sent = step_state(
        state,
        result,
        now,
        args.threshold,
        _post,
        stale_threshold=args.stale_threshold,
    )
    if not args.dry_run:
        save_state(state_path, state)

    detail_parts = []
    if not result.avail_ok:
        detail_parts.append(result.avail_detail)
    if not result.bypass_ok:
        detail_parts.append(result.bypass_detail)
    if result.stale_verified and not result.stale_ok:
        detail_parts.append(result.stale_detail)
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
        "stale_alert_open": state.stale_alert_open,
        "stale_blocks": list(result.stale_blocks),
        "stale_failures": state.stale_failures,
        "stale_verified": result.stale_verified,
        "wrong_token_http": result.wrong_token_http,
    }
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
