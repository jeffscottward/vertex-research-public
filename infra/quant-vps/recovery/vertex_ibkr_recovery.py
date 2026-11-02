#!/usr/bin/env python3
"""Vertex IBKR recovery service (QuantVPS).

A human operator presses "Send IBKR 2FA request" in Vertex. The Vertex server calls this service on
127.0.0.1:8793 (through the tailnet Caddy site, rig and VPS-self only, own bearer token). The service:

- reports the ib-gateway login state. It derives the state read-only from the container state and the
  IBC lines in the container log;
- may start exactly ONE fixed program, SCRIPT_ARGV (no arguments, no shell, fixed environment), and only
  after all gates pass: one request at a time, a 900 s cooldown, and only when the gateway needs a login;
- follows the request: requested, waiting-for-approval, verifying, logged-in, timed-out, failed.

It never starts the script on its own, never retries, never logs in, never stops the script, and has no
trading authority. The fixed script environment turns off the script's account snapshot check and API
handshake check: with the script defaults those checks run `docker compose up -d nautilus-trader` (the live
trading engine). This service checks the account snapshot itself, through the read-only vertex-portfolio
health endpoint. The script sources /opt/vertex-exec-node/.env.example and .env, so the service refuses to start
it when those files set IBKR_2FA_* keys outside SAFE_ENV_FILE_KEYS (they could undo the fixed environment).

Docker access is read-only (`docker ps`, `docker inspect` and `docker logs` with fixed argv) with ONE exception:
the Nautilus arm switch (owner decision 2026-10-30). It may run `docker exec <node container id> python -m
nautilus.arm_cli status|arm|disarm ... --json`, only in the three fixed forms that is_nautilus_exec accepts.
Arm needs the exact statement ARM_STATEMENT and a 10..280 character reason; the Vertex server adds the owner
password step-up and the audit record. The arm CLI is the only writer of the arm record. The tests enforce
the spawn list, the docker verbs and the single exec form with an AST scan.

Interface contract: SCHEMA.md (card vertex-2fa-button), schema vertex-ibkr-recovery-*-v1.
"""
import collections
import hmac
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

VERSION = "1.1.0"
STATUS_SCHEMA = "vertex-ibkr-recovery-status-v1"
REQUEST_SCHEMA = "vertex-ibkr-recovery-request-v1"
HEALTH_SCHEMA = "vertex-ibkr-recovery-health-v1"
STATE_SCHEMA = "vertex-ibkr-recovery-state-v1"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8793
PREFIX = "/vertex-ibkr-recovery/v1"
DEFAULT_STATE_DIR = "/var/lib/vertex-ibkr-recovery"

# The one program this service can start. No arguments. No shell.
SCRIPT = "/opt/vertex-exec-node/scripts/request-ibkr-2fa-until-ready.sh"
SCRIPT_ARGV = (SCRIPT,)
SCRIPT_CWD = "/opt/vertex-exec-node"
SCRIPT_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "IBKR_2FA_NOTIFY_ENABLED": "0",
    "IBKR_2FA_MAX_ATTEMPTS": "1",
    "IBKR_2FA_APPROVAL_TIMEOUT_SECONDS": "180",
    # Mandatory. With 1 (script default) the readiness check starts the trading engine container.
    "IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT": "0",
    "IBKR_2FA_VERIFY_API_HANDSHAKE": "0",
}
# The script sources these files (set -a) after it starts, so they can override SCRIPT_ENV.
SCRIPT_ENV_FILES = ("/opt/vertex-exec-node/.env.example", "/opt/vertex-exec-node/.env")
# IBKR_2FA_* keys that are harmless in those files. Any other IBKR_2FA_* assignment blocks the start.
SAFE_ENV_FILE_KEYS = frozenset({
    "IBKR_2FA_NOTIFY_EMAIL", "IBKR_2FA_RETRY_INTERVAL_SECONDS", "IBKR_2FA_RESTART_COOLDOWN_SECONDS",
    "IBKR_2FA_RESTART_STATE_DIR", "IBKR_2FA_RESTART_TIMESTAMP_FILE", "IBKR_2FA_VERIFY_CLIENT_ID",
    "IBKR_2FA_VERIFY_TIMEOUT_SECONDS", "IBKR_2FA_VERIFY_HOST", "IBKR_2FA_VERIFY_PORT",
    "IBKR_2FA_SNAPSHOT_STAGE_DIR", "IBKR_2FA_SNAPSHOT_OUTPUT_DIR",
    "IBKR_2FA_UI_APPROVAL_TIMEOUT_SECONDS", "IBKR_2FA_UI_NOTIFY_ENABLED",
})
ENV_ASSIGN_RE = re.compile(r"\b(IBKR_2FA_[A-Za-z0-9_]+)\s*[:+]?=")

# Read-only docker access. Only these verbs (tests enforce it).
DOCKER = "/usr/bin/docker"
DOCKER_VERBS = ("ps", "inspect", "logs")
DOCKER_ENV = {"PATH": SCRIPT_ENV["PATH"], "HOME": "/root", "LANG": "C.UTF-8"}
GATEWAY_LABEL = "label=com.docker.compose.service=ib-gateway"
# Logs: the first read per container takes everything since StartedAt (IBC lines are rare among the Java output,
# and IBC restarts daily inside the same container, so a tail would lose them). Later reads take only the lines
# since the last line read. Only the parsed IBC events stay in memory.
LOG_FIRST_TIMEOUT = 20
LOG_NEXT_TIMEOUT = 10
LOG_MAX_BYTES = 64 * 1024 * 1024
LOG_WINDOW_SECONDS = 48 * 3600   # fallback window when the full log is too large or too slow
MAX_EVENTS = 500
CID_RE = re.compile(r"[0-9a-f]{12,64}")

STATEMENT = "I request IBKR recovery only; this does not authorize trading."
REQUEST_KEYS = frozenset({"requestId", "actorId", "statement", "dryRun"})
REQUEST_ID_RE = re.compile(r"[A-Za-z0-9-]{8,64}")
ACTOR_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43,}")
MAX_BODY = 4096

COOLDOWN_SECONDS = 900
GATEWAY_CACHE_SECONDS = 10.0
MONITOR_EVERY = 5.0
STARTUP_GRACE = 120.0       # container younger than this with no IBC event: starting
AWAIT_2FA_WINDOW = 240.0    # IBC SecondFactorAuthenticationTimeout 180 s + 60 s
LOGIN_START_WINDOW = 300.0
REQUEST_TIMEOUT = 300.0     # no logged-in event within this time after the start: timed-out
VERIFY_TIMEOUT = 180.0      # verifying longer than this without snapshot OK: failed
SNAPSHOT_SLACK = 5.0
DETAIL_MAX = 200
HISTORY_MAX = 20
HISTORY_SHOWN = 10
RUN_LOGS_MAX = 20
OUTPUT_TAIL_BYTES = 65536

PORTFOLIO_HEALTH_URL = "http://127.0.0.1:8792/vertex-portfolio/v1/health"
HEALTH_TIMEOUT = 5.0
HEALTH_REFRESH_SECONDS = 15.0
# Owner 2026-10-30: re-check the real auth state after the IBKR approval window (same rule as the rig's
# vertex-ibkr-auth-check: gateway logged in AND account feeds live). Good: the request is cleared.
# Not good: it stays visible with the reason, and the check repeats every RECHECK_REPEAT_SECONDS.
RECHECK_SECONDS = 900
RECHECK_REPEAT_SECONDS = 60

TERMINAL = frozenset({"logged-in", "timed-out", "failed"})
STATES = ("requested", "waiting-for-approval", "verifying", "logged-in", "timed-out", "failed")
LOGIN_STATES = ("stopped", "logged-in", "awaiting-2fa", "starting", "logged-out", "unknown")
NEEDS_LOGIN = {"stopped": True, "logged-in": False, "awaiting-2fa": False, "starting": False,
               "logged-out": True, "unknown": False}
PUBLIC_KEYS = ("requestId", "actorId", "requestedAt", "updatedAt", "finishedAt", "state", "detail",
               "scriptRunning", "recheckAt", "recheck")

# IBC log text -> event. Checked in this order; the first match names the line.
EVENT_PATTERNS = (
    ("2fa-timeout", ("Re-login after second factor authentication timeout not required",
                     "IBC closing because login has not completed after Second Factor Authentication")),
    ("session-ended", ("End this session and let the other session proceed", "Other session must be primary",
                       "Other session may be primary, so end this session")),
    ("logged-in", ("Login has completed", "Login has already completed")),
    ("2fa-started", ("Second Factor Authentication initiated",
                     "detected dialog entitled: Second Factor Authentication; event=Opened")),
    ("login-started", ("Login dialog WINDOW_OPENED: LoginState is LOGGED_OUT",
                       "Starting session: will exit if login dialog", "IBC will restart shortly",
                       "detected dialog entitled: Restart in progress")),
)

# Script output markers.
OUT_ATTEMPT = "IBKR 2FA login request attempt"
OUT_COOLDOWN = "restart cooldown active"
OUT_ALREADY_READY = "no 2FA request needed"

DETAIL_STARTED = "script started"
DETAIL_WAITING = "waiting for 2FA approval on the phone"
DETAIL_VERIFYING = "login completed; checking account snapshot"
DETAIL_LOGGED_IN = "account snapshot OK"
DETAIL_2FA_TIMEOUT = "2FA approval timed out"
DETAIL_NO_LOGIN = "no login within 300 s"
DETAIL_COOLDOWN = "gateway restart cooldown active on the VPS"
DETAIL_SESSION_ENDED = "gateway session ended: another IBKR session took over"
DETAIL_NOT_CONFIRMED = "login completed; account snapshot not confirmed"
DETAIL_RESTARTED = "service restarted during the request"
DETAIL_NO_OUTPUT = "script exited without output"
DETAIL_SCRIPT_READY = "The script reported the gateway ready and sent no 2FA request."

TS_RE = re.compile(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
SECRETISH_RE = re.compile(r"[A-Za-z0-9_\-+=]{32,}")
ENV_NAME_RE = re.compile(r"[A-Z0-9_]+")


def _redact(match):
    """Token-like run (letters and digits, 32+ chars) -> [redacted]. Upper-case env names stay."""
    s = match.group(0)
    if ENV_NAME_RE.fullmatch(s) or not re.search(r"[0-9]", s) or not re.search(r"[A-Za-z]", s):
        return s
    return "[redacted]"


class DockerError(Exception):
    pass


class DockerTimeout(DockerError):
    pass


class LogTooLarge(DockerError):
    pass


def iso(ts):
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts_key(text):
    """RFC3339 (docker, up to nanoseconds) -> (epoch seconds, nanoseconds) for exact ordering, or None."""
    m = TS_RE.fullmatch(text or "")
    if not m:
        return None
    y, mo, d, h, mi, s = (int(g) for g in m.groups()[:6])
    if y < 2000:  # docker uses 0001-01-01T00:00:00Z for "never"
        return None
    try:
        secs = int(datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None
    nanos = int((m.group(7) or "0").ljust(9, "0"))
    tz = m.group(8)
    if tz != "Z":
        offset = int(tz[1:3]) * 3600 + int(tz[4:6]) * 60
        secs -= offset if tz[0] == "+" else -offset
    return secs, nanos


def key_epoch(key):
    return key[0] + key[1] / 1e9


def parse_ts(text):
    """RFC3339 (docker, up to nanoseconds) -> epoch seconds, or None."""
    key = ts_key(text)
    return None if key is None else key_epoch(key)


def clean_detail(text):
    """Short, single-line, no control characters, long token-like runs removed, max 200 chars."""
    text = ANSI_RE.sub("", "" if text is None else str(text))
    text = CTRL_RE.sub(" ", text)
    text = SECRETISH_RE.sub(_redact, text)
    return " ".join(text.split())[:DETAIL_MAX]


# ---------------------------------------------------------------------------------------------------------
# Gateway login state (read-only)

def ps_argv():
    return [DOCKER, "ps", "-a", "--filter", GATEWAY_LABEL, "--format", "{{.ID}} {{.State}}"]


def inspect_argv(cid):
    return [DOCKER, "inspect", "--format", "{{json .State}}", cid]


def logs_argv(cid, since):
    return [DOCKER, "logs", "--timestamps", "--since", since, cid]


def docker_run(argv, timeout, max_bytes=None):
    """Runs one read-only docker command. Refuses any verb outside DOCKER_VERBS.

    Output goes to a temporary file first, so a too large output (max_bytes) never sits in memory.
    """
    if not isinstance(argv, list) or len(argv) < 2 or argv[0] != DOCKER or argv[1] not in DOCKER_VERBS \
            or not all(isinstance(a, str) for a in argv):
        raise DockerError("docker command refused")
    try:
        with tempfile.TemporaryFile() as out:
            r = subprocess.run(argv, shell=False, stdin=subprocess.DEVNULL, stdout=out,
                               stderr=subprocess.STDOUT if argv[1] == "logs" else subprocess.DEVNULL,
                               env=dict(DOCKER_ENV), timeout=timeout, check=False, close_fds=True)
            if r.returncode != 0:
                raise DockerError("exit %d" % r.returncode)
            size = os.fstat(out.fileno()).st_size
            if max_bytes is not None and size > max_bytes:
                raise LogTooLarge("%d bytes" % size)
            out.seek(0)
            return out.read().decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        raise DockerTimeout("timeout")
    except (OSError, subprocess.SubprocessError) as e:
        raise DockerError(type(e).__name__)


def line_event(text):
    """IBC log text -> event name or None. Only lines with 'IBC:' count."""
    idx = text.find("IBC:")
    if idx < 0:
        return None
    body = text[idx:]
    for name, needles in EVENT_PATTERNS:
        for needle in needles:
            if needle in body:
                return name
    return None


def parse_events(log_text):
    """`docker logs --timestamps` output -> [(epoch, event)] sorted by time (stdout and stderr interleave)."""
    events = []
    for line in log_text.splitlines():
        stamp, _, rest = line.partition(" ")
        ts = parse_ts(stamp)
        if ts is None:
            continue
        name = line_event(rest)
        if name:
            events.append((ts, name))
    events.sort(key=lambda e: e[0])
    return events


class GatewayView:
    def __init__(self, login_state, since, reason, events=()):
        self.login_state = login_state
        self.needs_login = NEEDS_LOGIN[login_state]
        self.since = since
        self.reason = reason
        self.events = list(events)

    def public(self):
        return {"loginState": self.login_state, "needsLogin": self.needs_login, "since": iso(self.since),
                "reason": self.reason}


def feeds_missing(health):
    """True only when vertex-portfolio answered and its account feeds are not live. No answer is unknown: False."""
    if not isinstance(health, dict):
        return False
    return not (health.get("state") == "live" and health.get("connected") is True)


def recovery_needed(view, health):
    """A request may start for a logged-out/stopped gateway, or a logged-in gateway whose account feeds are missing."""
    return view.needs_login or (view.login_state == "logged-in" and feeds_missing(health))


def auth_good(view, health):
    return view.login_state == "logged-in" and isinstance(health, dict) and not feeds_missing(health)


def classify(now, container, events):
    """container: None (no container) or {"running": bool, "startedAt": epoch|None}. events: sorted list."""
    if container is None:
        return GatewayView("stopped", None, "container-not-running")
    started = container.get("startedAt")
    if not container.get("running"):
        return GatewayView("stopped", started, "container-not-running", events)
    if not events:
        if started is not None and now - started < STARTUP_GRACE:
            return GatewayView("starting", started, "no-login-event")
        return GatewayView("unknown", None, "no-login-event")
    ts, name = events[-1]
    age = now - ts
    if name == "logged-in":
        state = "logged-in"
    elif name == "2fa-started":
        state = "awaiting-2fa" if age < AWAIT_2FA_WINDOW else "logged-out"
    elif name == "login-started":
        state = "starting" if age < LOGIN_START_WINDOW else "logged-out"
    else:  # 2fa-timeout, session-ended
        state = "logged-out"
    return GatewayView(state, ts, name, events)


class GatewayReader:
    """Reads the gateway container state and its IBC events. Not thread-safe: GatewayCache serializes reads.

    Keeps a log cursor per container (id + StartedAt): the first read takes all lines since StartedAt, later
    reads only the lines since the last line read. `docker logs --since` is inclusive, so lines at the cursor
    timestamp that were already read are skipped. If the first read is larger than LOG_MAX_BYTES or slower than
    LOG_FIRST_TIMEOUT, it reads only the last LOG_WINDOW_SECONDS ("log-window" when no event is found there).
    """

    def __init__(self, run=docker_run, clock=time.time):
        self._run = run
        self._clock = clock
        self._reset(None, None)

    def _reset(self, cid, started_raw):
        self._cid = cid
        self._started_raw = started_raw
        self._cursor = None            # (ts_key, raw stamp) of the newest line read
        self._edge = set()             # lines already read at the cursor timestamp
        self._events = collections.deque(maxlen=MAX_EVENTS)
        self._window = False

    def _ingest(self, text):
        batch = []
        for line in text.splitlines():
            stamp, _, rest = line.partition(" ")
            key = ts_key(stamp)
            if key is None:
                continue
            if self._cursor is not None and (key < self._cursor[0] or (key == self._cursor[0] and line in self._edge)):
                continue
            batch.append((key, stamp, line, rest))
        if not batch:
            return
        batch.sort(key=lambda b: b[0])  # stdout and stderr interleave
        top_key, top_stamp = batch[-1][0], batch[-1][1]
        if self._cursor is None or top_key > self._cursor[0]:
            self._edge = set()
        self._cursor = (top_key, top_stamp)
        for key, _stamp, line, rest in batch:
            if key == top_key:
                self._edge.add(line)
            name = line_event(rest)
            if name:
                self._events.append((key_epoch(key), name))

    def _read_logs(self, cid, started_raw):
        window = self._window_since(started_raw)
        if self._cursor is not None:
            try:
                text = self._run(logs_argv(cid, self._cursor[1]), LOG_NEXT_TIMEOUT, LOG_MAX_BYTES)
            except (DockerTimeout, LogTooLarge):
                self._reset(cid, started_raw)
                self._window = True
                text = self._run(logs_argv(cid, window), LOG_FIRST_TIMEOUT, LOG_MAX_BYTES)
        elif not self._window:
            try:
                text = self._run(logs_argv(cid, started_raw), LOG_FIRST_TIMEOUT, LOG_MAX_BYTES)
            except (DockerTimeout, LogTooLarge):
                self._window = True
                text = self._run(logs_argv(cid, window), LOG_FIRST_TIMEOUT, LOG_MAX_BYTES)
        else:
            text = self._run(logs_argv(cid, window), LOG_FIRST_TIMEOUT, LOG_MAX_BYTES)
        self._ingest(text)

    def _window_since(self, started_raw):
        """Start of the fallback window: now - 48 h, but never before this container start."""
        start = math.ceil(self._clock() - LOG_WINDOW_SECONDS)
        started = parse_ts(started_raw)
        if started is not None and started >= start:
            return started_raw
        return iso(start)

    def read(self):
        try:
            rows = [line.split() for line in self._run(ps_argv(), 5).splitlines() if line.strip()]
            if not rows:
                self._reset(None, None)
                return classify(self._clock(), None, [])
            if any(len(r) < 1 or not CID_RE.fullmatch(r[0]) for r in rows):
                raise DockerError("container id")
            running = [r[0] for r in rows if len(r) > 1 and r[1] == "running"]
            if len(running) > 1:
                raise DockerError("more than one running gateway container")
            cid = running[0] if running else rows[0][0]  # docker ps lists the newest first
            state = json.loads(self._run(inspect_argv(cid), 5))
            if not isinstance(state, dict):
                raise DockerError("inspect")
            started_raw = state.get("StartedAt") if isinstance(state.get("StartedAt"), str) else ""
            container = {"running": state.get("Running") is True, "startedAt": parse_ts(started_raw)}
            if cid != self._cid or started_raw != self._started_raw:
                self._reset(cid, started_raw)  # new container or restart: new cursor
            if not container["running"]:
                return classify(self._clock(), container, list(self._events))
            if container["startedAt"] is None:
                raise DockerError("StartedAt")
            self._read_logs(cid, started_raw)
            view = classify(self._clock(), container, list(self._events))
            if self._window and view.reason == "no-login-event" and view.login_state == "unknown":
                view.reason = "log-window"
            return view
        except (DockerError, ValueError, TypeError, AttributeError, IndexError):
            return GatewayView("unknown", None, "docker-error")


class GatewayCache:
    """Refreshes at most every GATEWAY_CACHE_SECONDS, unless forced (each POST)."""

    def __init__(self, read, clock=time.time, max_age=GATEWAY_CACHE_SECONDS):
        self._read = read
        self._clock = clock
        self._max_age = max_age
        self._lock = threading.Lock()
        self._view = None
        self._at = None

    def get(self, force=False):
        with self._lock:
            now = self._clock()
            if force or self._view is None or now - self._at >= self._max_age or now < self._at:
                self._view = self._read()
                self._at = now
            return self._view


# ---------------------------------------------------------------------------------------------------------
# Script start (the only spawn) and the script's env-file guard

def script_env():
    """The complete fixed script environment. Nothing from the service environment passes.

    No IB client id is passed: with VERIFY_ACCOUNT_SNAPSHOT=0 and VERIFY_API_HANDSHAKE=0 the script opens no
    IB API session, and the account snapshot check here goes through vertex-portfolio (its own client id).
    """
    return dict(SCRIPT_ENV)


def spawn_script(log_path, env):
    """Starts SCRIPT_ARGV. Output (stdout+stderr) goes to log_path (0600). Returns the Popen object."""
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        return subprocess.Popen(list(SCRIPT_ARGV), cwd=SCRIPT_CWD, env=env, shell=False,
                                stdin=subprocess.DEVNULL, stdout=fd, stderr=subprocess.STDOUT,
                                close_fds=True, start_new_session=True)
    finally:
        os.close(fd)


def env_file_override_keys(paths=SCRIPT_ENV_FILES):
    """IBKR_2FA_* keys outside SAFE_ENV_FILE_KEYS that the script's env files assign. Names only."""
    found = set()
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read(1_000_000)
        except FileNotFoundError:
            continue
        except OSError:
            found.add("UNREADABLE:" + os.path.basename(path))
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            for key in ENV_ASSIGN_RE.findall(stripped):
                if key not in SAFE_ENV_FILE_KEYS:
                    found.add(key)
    return sorted(found)


# ---------------------------------------------------------------------------------------------------------
# Account snapshot check (through the read-only vertex-portfolio service)

def make_health_fetcher(status_token):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def fetch():
        if not status_token:
            return None
        req = urllib.request.Request(PORTFOLIO_HEALTH_URL, headers={"Authorization": "Bearer " + status_token})
        try:
            with opener.open(req, timeout=HEALTH_TIMEOUT) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read(65536))
        except (OSError, ValueError):
            return None

    return fetch


def snapshot_ok(health, login_at):
    if not isinstance(health, dict) or login_at is None:
        return False
    as_of = health.get("dataAsOf")
    if isinstance(as_of, bool) or not isinstance(as_of, (int, float)) or not math.isfinite(as_of):
        return False
    return health.get("state") == "live" and health.get("connected") is True and as_of >= login_at - SNAPSHOT_SLACK


# ---------------------------------------------------------------------------------------------------------
# Request lifecycle

def decide(start, now, events, lines, exited):
    """Pure lifecycle rule for a non-terminal request.

    events: [(epoch, name)] of the gateway, sorted. lines: non-empty script output lines. exited: script ended.
    Returns (state, detail, login_at). For "verifying" the caller runs the snapshot check.
    Once the script printed its login request attempt line (the gateway restart happened), its exit no longer
    decides anything: the gateway events decide until REQUEST_TIMEOUT.
    """
    seen_2fa = False
    login_at = None
    for ts, name in events:
        if ts < start:
            continue
        if name == "2fa-timeout":
            return "timed-out", DETAIL_2FA_TIMEOUT, login_at
        if name == "session-ended":
            return "failed", DETAIL_SESSION_ENDED, login_at
        if name == "logged-in":
            login_at = ts
        elif name == "2fa-started":
            seen_2fa = True
    if login_at is not None:
        return "verifying", DETAIL_VERIFYING, login_at
    if any(OUT_ALREADY_READY in line for line in lines):
        return "failed", DETAIL_SCRIPT_READY, None
    if any(OUT_COOLDOWN in line for line in lines):
        return "failed", DETAIL_COOLDOWN, None
    attempted = any(OUT_ATTEMPT in line for line in lines)
    if exited and not attempted and not seen_2fa:
        return "failed", clean_detail(lines[-1]) if lines else DETAIL_NO_OUTPUT, None
    if now - start > REQUEST_TIMEOUT:
        return "timed-out", DETAIL_NO_LOGIN, None
    if seen_2fa or attempted:
        return "waiting-for-approval", DETAIL_WAITING, None
    return "requested", DETAIL_STARTED, None


def validate_request(raw):
    """Body bytes -> (payload, None) or (None, detail)."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "body must be JSON"
    if not isinstance(data, dict):
        return None, "body must be a JSON object"
    keys = set(data)
    if keys - REQUEST_KEYS:
        return None, "unexpected keys"
    if REQUEST_KEYS - keys:
        return None, "missing keys"
    rid, actor = data["requestId"], data["actorId"]
    if not isinstance(rid, str) or not REQUEST_ID_RE.fullmatch(rid):
        return None, "requestId must match ^[A-Za-z0-9-]{8,64}$"
    if not isinstance(actor, str) or not ACTOR_ID_RE.fullmatch(actor):
        return None, "actorId must match ^[A-Za-z0-9_-]{1,64}$"
    if data["statement"] != STATEMENT:
        return None, "statement does not match"
    if not isinstance(data["dryRun"], bool):
        return None, "dryRun must be a boolean"
    return data, None


def public(rec):
    return None if rec is None else {k: rec[k] for k in PUBLIC_KEYS}


def _valid_recheck(value):
    if not isinstance(value, dict) or not isinstance(value.get("at"), str) or not isinstance(value.get("ok"), bool):
        return None
    return {"at": value["at"], "ok": value["ok"], "detail": clean_detail(value.get("detail"))}


def _valid_record(rec):
    if not isinstance(rec, dict) or not isinstance(rec.get("requestId"), str) \
            or not REQUEST_ID_RE.fullmatch(rec["requestId"]) or rec.get("state") not in STATES:
        return None
    out = {
        "requestId": rec["requestId"],
        "actorId": rec["actorId"] if isinstance(rec.get("actorId"), str) else "unknown",
        "requestedAt": rec.get("requestedAt") if isinstance(rec.get("requestedAt"), str) else None,
        "updatedAt": rec.get("updatedAt") if isinstance(rec.get("updatedAt"), str) else None,
        "finishedAt": rec.get("finishedAt") if isinstance(rec.get("finishedAt"), str) else None,
        "state": rec["state"],
        "detail": clean_detail(rec.get("detail")),
        "scriptRunning": False,
        "recheckAt": rec.get("recheckAt") if isinstance(rec.get("recheckAt"), str) else None,
        "recheck": _valid_recheck(rec.get("recheck")),
    }
    for key in ("startEpoch", "verifyingSince", "loginAt", "recheckLast"):
        v = rec.get(key)
        out[key] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None
    return out


class Recovery:
    """Gates, single-flight start, lifecycle monitor and persistence. State changes under self.lock."""

    def __init__(self, state_dir, gateway, clock=time.time, spawn=spawn_script, fetch_health=None,
                 env_check=env_file_override_keys, log=None):
        self.state_dir = state_dir
        self.state_path = os.path.join(state_dir, "state.json")
        self.runs_dir = os.path.join(state_dir, "runs")
        self.gateway = gateway
        self.clock = clock
        self._spawn = spawn
        self._fetch_health = fetch_health or (lambda: None)
        self._env_check = env_check
        self._log = log or (lambda event, **kw: None)
        self.lock = threading.RLock()
        self.proc = None
        self.proc_request = None
        self.last_started_at = None
        self.active = None
        self.history = []
        self.health_value = None
        self.health_at = None
        os.makedirs(self.runs_dir, mode=0o700, exist_ok=True)
        self._load()

    # persistence ---------------------------------------------------------------------------------------
    def _load(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("state")
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            # Unknown history: keep the cooldown on, from now.
            self.last_started_at = self.clock()
            self._log("state_unreadable")
            self._persist()
            return
        last = data.get("lastStartedAt")
        if isinstance(last, (int, float)) and not isinstance(last, bool) and math.isfinite(last):
            self.last_started_at = float(last)
        raw_history = data.get("history") if isinstance(data.get("history"), list) else []
        history = [r for r in (_valid_record(x) for x in raw_history) if r is not None]
        active = _valid_record(data.get("active"))
        if active is not None:
            history = [active if r["requestId"] == active["requestId"] else r for r in history]
            if not any(r is active for r in history):
                history.insert(0, active)
        self.history = history[:HISTORY_MAX]
        self.active = active
        if active is not None and active["state"] not in TERMINAL:
            self._set_state(active, "failed", DETAIL_RESTARTED)
        self._persist()

    def _persist(self):
        data = {"schema": STATE_SCHEMA, "lastStartedAt": self.last_started_at, "active": self.active,
                "history": self.history[:HISTORY_MAX]}
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=self.state_dir)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(data, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.state_path)
            tmp = None
        except OSError as e:
            self._log("persist_error", error=type(e).__name__)
        finally:
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    def _prune_runs(self):
        try:
            names = [n for n in os.listdir(self.runs_dir) if n.endswith(".log")]
            paths = [os.path.join(self.runs_dir, n) for n in names]
            paths.sort(key=lambda p: (os.stat(p).st_mtime, p), reverse=True)
            for p in paths[RUN_LOGS_MAX:]:
                os.unlink(p)
        except OSError as e:
            self._log("prune_error", error=type(e).__name__)

    # helpers -------------------------------------------------------------------------------------------
    def _set_state(self, rec, state, detail):
        now = iso(self.clock())
        changed = rec["state"] != state
        rec["state"] = state
        rec["detail"] = clean_detail(detail)
        rec["updatedAt"] = now
        if state in TERMINAL and rec.get("finishedAt") is None:
            rec["finishedAt"] = now
        if changed:
            self._log("request_state", requestId=rec["requestId"], state=state)

    def _reap(self):
        """Marks the script as ended once it exits. Returns True when something changed."""
        if self.proc is None or self.proc.poll() is None:
            return False
        code = self.proc.poll()
        rec = self.proc_request
        self.proc = None
        self.proc_request = None
        if rec is not None and rec["scriptRunning"]:
            rec["scriptRunning"] = False
            rec["updatedAt"] = iso(self.clock())
        self._log("script_exited", requestId=rec["requestId"] if rec else None, code=code)
        return True

    def script_running(self):
        with self.lock:
            if self._reap():
                self._persist()
            return self.proc is not None

    def _find(self, rid):
        for rec in self.history:
            if rec["requestId"] == rid:
                return rec
        return None

    def _health(self, force=False):
        """Cached vertex-portfolio health. The HTTP read runs outside the lock."""
        now = self.clock()
        if force or self.health_at is None or now - self.health_at >= HEALTH_REFRESH_SECONDS:
            health = self._fetch_health()
            with self.lock:
                self.health_value, self.health_at = health, self.clock()
        return self.health_value

    def _read_output(self, rid):
        path = os.path.join(self.runs_dir, rid + ".log")
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - OUTPUT_TAIL_BYTES))
                data = f.read(OUTPUT_TAIL_BYTES)
        except OSError:
            return []
        text = ANSI_RE.sub("", data.decode("utf-8", "replace"))
        return [line.strip() for line in text.splitlines() if line.strip()]

    def _refuse(self, status, body, reason, headers=None):
        self._log("request_refused", reason=reason)
        return status, body, headers or {}

    # API -----------------------------------------------------------------------------------------------
    def status(self):
        view = self.gateway.get()
        health = self._health()
        with self.lock:
            if self._reap():
                self._persist()
            now = self.clock()
            until = None
            if self.last_started_at is not None and self.last_started_at + COOLDOWN_SECONDS > now:
                until = iso(self.last_started_at + COOLDOWN_SECONDS)
            return {"schema": STATUS_SCHEMA, "version": VERSION, "generatedAt": iso(now),
                    "gateway": {**view.public(), "feedsMissing": feeds_missing(health)}, "request": public(self.active),
                    "cooldown": {"seconds": COOLDOWN_SECONDS, "until": until},
                    "history": [public(r) for r in self.history[:HISTORY_SHOWN]]}

    def health(self):
        return {"schema": HEALTH_SCHEMA, "version": VERSION, "loginState": self.gateway.get().login_state}

    def request(self, payload):
        """Validated payload -> (status, body, headers).

        The forced gateway read (docker) runs before the lock, so the lock section never waits on docker.
        Gate checks and the start then run under one lock with that fresh state (single-flight).
        """
        rid = payload["requestId"]
        with self.lock:
            known = self._find(rid)
            if known is not None:
                return 200, {"schema": REQUEST_SCHEMA, "outcome": "existing", "request": public(known)}, {}
        view = self.gateway.get(force=True)
        health = self._health(force=True)
        with self.lock:
            known = self._find(rid)  # a parallel POST with the same id may have started meanwhile
            if known is not None:
                return 200, {"schema": REQUEST_SCHEMA, "outcome": "existing", "request": public(known)}, {}
            if self._reap():
                self._persist()
            if self.proc is not None or (self.active is not None and self.active["state"] not in TERMINAL):
                return self._refuse(409, {"error": "in_flight", "request": public(self.active)}, "in_flight")
            now = self.clock()
            if self.last_started_at is not None and now < self.last_started_at + COOLDOWN_SECONDS:
                until = self.last_started_at + COOLDOWN_SECONDS
                wait = max(1, int(math.ceil(until - now)))
                return self._refuse(429, {"error": "cooldown", "retryAfterSeconds": wait, "until": iso(until)},
                                    "cooldown", {"Retry-After": str(wait)})
            if not recovery_needed(view, health):
                return self._refuse(409, {"error": "not_needed", "loginState": view.login_state}, "not_needed")
            blocked = self._env_check()
            if payload["dryRun"]:
                body = {"schema": REQUEST_SCHEMA, "outcome": "dry-run", "wouldStart": not blocked}
                if blocked:
                    body["detail"] = clean_detail("script env file sets " + ",".join(blocked))
                return 200, body, {}
            stamp = iso(now)
            rec = {"requestId": rid, "actorId": payload["actorId"], "requestedAt": stamp, "updatedAt": stamp,
                   "finishedAt": None, "state": "requested", "detail": DETAIL_STARTED, "scriptRunning": False,
                   "startEpoch": now, "verifyingSince": None, "loginAt": None,
                   "recheckAt": iso(now + RECHECK_SECONDS), "recheck": None, "recheckLast": None}
            self.last_started_at = now
            self.active = rec
            self.history.insert(0, rec)
            del self.history[HISTORY_MAX:]
            self._log("request_started", requestId=rid, actorId=payload["actorId"])
            if blocked:
                self._set_state(rec, "failed", "script not started: env file sets " + ",".join(blocked))
            else:
                try:
                    self.proc = self._spawn(os.path.join(self.runs_dir, rid + ".log"), script_env())
                    self.proc_request = rec
                    rec["scriptRunning"] = True
                except Exception as e:  # noqa: BLE001 - any spawn failure ends the request
                    self.proc = None
                    self._set_state(rec, "failed", "script could not be started (%s)" % type(e).__name__)
            self._prune_runs()
            self._persist()
            return 202, {"schema": REQUEST_SCHEMA, "outcome": "started", "request": public(rec)}, {}

    # monitor ---------------------------------------------------------------------------------------------
    def tick(self):
        """One lifecycle evaluation of the active request. Docker and HTTP reads run outside the lock."""
        with self.lock:
            if self._reap():
                self._persist()
            rec = self.active
            if rec is None or rec["state"] in TERMINAL:
                return
            exited = self.proc is None
            start = rec["startEpoch"] if rec["startEpoch"] is not None else self.clock()
            rid = rec["requestId"]
        # After the script ended, read the gateway fresh (no stale cache before a "failed" decision).
        view = self.gateway.get(force=exited)
        lines = self._read_output(rid)
        now = self.clock()
        state, detail, login_at = decide(start, now, view.events, lines, exited)
        health = self._fetch_health() if state == "verifying" else None
        with self.lock:
            if self.active is not rec or rec["state"] in TERMINAL:
                return
            now = self.clock()
            if state == "verifying":
                if rec["verifyingSince"] is None:
                    rec["verifyingSince"] = now
                rec["loginAt"] = login_at
                if snapshot_ok(health, login_at):
                    state, detail = "logged-in", DETAIL_LOGGED_IN
                elif now - rec["verifyingSince"] > VERIFY_TIMEOUT:
                    state, detail = "failed", DETAIL_NOT_CONFIRMED
            if state != rec["state"] or clean_detail(detail) != rec["detail"]:
                self._set_state(rec, state, detail)
                self._persist()

    def recheck(self):
        """After RECHECK_SECONDS, re-read the real auth state for the active finished request.

        Good: the request is cleared from the status (history keeps it). Not good: it stays with the reason.
        Read-only: it never starts the script, restarts anything or logs in.
        """
        with self.lock:
            rec = self.active
            if rec is None or rec["state"] not in TERMINAL or rec.get("startEpoch") is None:
                return
            now = self.clock()
            if now < rec["startEpoch"] + RECHECK_SECONDS:
                return
            last = rec.get("recheckLast")
            if last is not None and now - last < RECHECK_REPEAT_SECONDS:
                return
        view = self.gateway.get(force=True)
        health = self._health(force=True)
        with self.lock:
            if self.active is not rec:
                return
            now = self.clock()
            rec["recheckLast"] = now
            if auth_good(view, health):
                rec["recheck"] = {"at": iso(now), "ok": True, "detail": "IBKR authenticated; account feeds live"}
                self.active = None
                self._log("recheck", requestId=rec["requestId"], ok=True)
            else:
                feeds = "unknown" if not isinstance(health, dict) else ("missing" if feeds_missing(health) else "live")
                detail = clean_detail("not authenticated (login %s, account feeds %s)" % (view.login_state, feeds))
                changed = rec.get("recheck") is None or rec["recheck"]["detail"] != detail
                rec["recheck"] = {"at": iso(now), "ok": False, "detail": detail}
                if changed:
                    rec["updatedAt"] = iso(now)
                    self._log("recheck", requestId=rec["requestId"], ok=False)
            self._persist()

    def run_monitor(self, stop):
        # Each round also refreshes the gateway state (at most every 10 s through the cache). That keeps the log
        # cursor current, so a POST or status call only reads the few newest log lines.
        first = True
        while first or not stop.wait(MONITOR_EVERY):
            first = False
            try:
                self.gateway.get()
                self._health()
                self.tick()
                self.recheck()
            except Exception as e:  # noqa: BLE001 - keep the monitor alive
                self._log("monitor_error", error=type(e).__name__)


# ---------------------------------------------------------------------------------------------------------
# Nautilus arm switch (owner decision 2026-10-30: the node runs 24/7 and is disarmed by default)
#
# The service can run exactly one more kind of program: the arm CLI inside the running nautilus-trader
# container, `docker exec <id> python -m nautilus.arm_cli status|arm|disarm ... --json`. nautilus_exec_argv
# builds the argv; nautilus_cli_run checks it again (is_nautilus_exec) and refuses every other form. The CLI
# is the only writer of the arm record. This service never restarts, stops or starts the node.

NAUTILUS_LABEL = "label=com.docker.compose.service=nautilus-trader"
# `docker compose run --rm nautilus-trader` one-off containers (the 2FA readiness snapshot) carry the same
# service label. Only the long-running node counts.
NOT_ONEOFF_LABEL = "label=com.docker.compose.oneoff=False"
ARM_STATEMENT = "I arm the Nautilus node; it may submit live orders."
ARM_STATUS_SCHEMA = "vertex-nautilus-arm-status-v1"
ARM_RESULT_SCHEMA = "vertex-nautilus-arm-result-v1"
CLI_STATUS_SCHEMA = "nautilus-arm-status-v1"
CLI_ERROR_SCHEMA = "nautilus-arm-error-v1"
ARM_KEYS = frozenset({"requestId", "actorId", "reason", "statement", "imageVersion"})
DISARM_KEYS = frozenset({"requestId", "actorId", "reason"})
# The CLI accepts ^[A-Za-z0-9_.@-]{1,64}$. The first character must not be "-" (it would read as an option).
ARM_ACTOR_RE = re.compile(r"[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,63}")
IMAGE_VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}")
ARM_REASON_MIN = 10
DISARM_REASON_MIN = 1
REASON_MAX = 280
CLI_STATUS_TIMEOUT = 8
CLI_CHANGE_TIMEOUT = 12  # under the 15 s Caddy response_header_timeout
CLI_MAX_BYTES = 65536
ARM_DETAILS = ("armed", "no_arm_record", "invalid_arm_record", "image_version_changed", "kill_switch_active")
ARM_ERRORS = ("version_mismatch", "kill_switch_active", "invalid_reason", "invalid_actor", "write_failed")


def nautilus_ps_argv():
    return [DOCKER, "ps", "-a", "--filter", NAUTILUS_LABEL, "--filter", NOT_ONEOFF_LABEL,
            "--format", "{{.ID}} {{.State}}"]


def nautilus_exec_argv(cid, command):
    """The one exec form: docker exec <container id> python -m nautilus.arm_cli <command...>."""
    return [DOCKER, "exec", cid, "python", "-m", "nautilus.arm_cli"] + list(command)


def valid_reason(text, minimum):
    return isinstance(text, str) and minimum <= len(text) <= REASON_MAX and not CTRL_RE.search(text) \
        and text == text.strip() and not text.startswith("-")


def is_nautilus_exec(argv):
    """True only for the three fixed CLI forms with valid values. Everything else is refused."""
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv) or len(argv) < 8:
        return False
    if not CID_RE.fullmatch(argv[2]) or argv[:6] != nautilus_exec_argv(argv[2], []) or argv[-1] != "--json":
        return False
    cmd = argv[6:-1]
    if cmd == ["status"]:
        return True
    if len(cmd) == 7 and cmd[0] == "arm" and cmd[1] == "--by" and cmd[3] == "--reason" \
            and cmd[5] == "--confirm-image-version":
        return bool(ARM_ACTOR_RE.fullmatch(cmd[2])) and valid_reason(cmd[4], ARM_REASON_MIN) \
            and bool(IMAGE_VERSION_RE.fullmatch(cmd[6]))
    if len(cmd) == 5 and cmd[0] == "disarm" and cmd[1] == "--by" and cmd[3] == "--reason":
        return bool(ARM_ACTOR_RE.fullmatch(cmd[2])) and valid_reason(cmd[4], DISARM_REASON_MIN)
    return False


def nautilus_cli_run(argv, timeout):
    """Runs one arm CLI call. Returns (exit code, stdout text). Refuses any argv outside is_nautilus_exec."""
    if not is_nautilus_exec(argv):
        raise DockerError("exec command refused")
    try:
        with tempfile.TemporaryFile() as out:
            r = subprocess.run(argv, shell=False, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL,
                               env=dict(DOCKER_ENV), timeout=timeout, check=False, close_fds=True)
            size = os.fstat(out.fileno()).st_size
            if size > CLI_MAX_BYTES:
                raise DockerError("output too large")
            out.seek(0)
            return r.returncode, out.read().decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        raise DockerTimeout("timeout")
    except (OSError, subprocess.SubprocessError) as e:
        raise DockerError(type(e).__name__)


def _short(value, limit=DETAIL_MAX):
    return clean_detail(value)[:limit] if isinstance(value, str) else None


def parse_cli_status(text):
    """Arm CLI status JSON -> public arm object, or None when the output does not match the contract."""
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("schema") != CLI_STATUS_SCHEMA:
        return None
    armed, detail, version = data.get("armed"), data.get("detail"), data.get("image_version")
    kill = data.get("kill_switch_active")
    record = data.get("record")
    if not isinstance(armed, bool) or detail not in ARM_DETAILS or not isinstance(version, str) \
            or not isinstance(kill, bool) or not (record is None or isinstance(record, dict)):
        return None
    if armed != (detail == "armed"):
        return None
    record = record or {}
    return {"armed": armed, "state": "armed" if armed else "disarmed", "detail": detail,
            "imageVersion": _short(version, 64) or "", "killSwitchActive": kill,
            "armedAt": _short(record.get("armed_at"), 40) if armed else None,
            "armedBy": _short(record.get("armed_by"), 64) if armed else None,
            "reason": _short(record.get("reason"), REASON_MAX) if armed else None,
            "auditId": _short(data.get("audit_id"), 64)}


def parse_cli_error(text):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("schema") != CLI_ERROR_SCHEMA or data.get("error") not in ARM_ERRORS:
        return None
    return data["error"], _short(data.get("detail")) or ""


def validate_arm_request(raw, arm):
    """Body bytes -> (payload, None) or (None, detail). arm: True for /nautilus/arm, False for /disarm."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "body must be JSON"
    if not isinstance(data, dict):
        return None, "body must be a JSON object"
    expected = ARM_KEYS if arm else DISARM_KEYS
    if set(data) != expected:
        return None, "keys must be exactly " + ", ".join(sorted(expected))
    if not isinstance(data["requestId"], str) or not REQUEST_ID_RE.fullmatch(data["requestId"]):
        return None, "requestId must match ^[A-Za-z0-9-]{8,64}$"
    if not isinstance(data["actorId"], str) or not ARM_ACTOR_RE.fullmatch(data["actorId"]):
        return None, "actorId must match ^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,63}$"
    minimum = ARM_REASON_MIN if arm else DISARM_REASON_MIN
    if not valid_reason(data["reason"], minimum):
        return None, "reason must be one line of %d to %d characters" % (minimum, REASON_MAX)
    if arm:
        if data["statement"] != ARM_STATEMENT:
            return None, "statement does not match"
        if not isinstance(data["imageVersion"], str) or not IMAGE_VERSION_RE.fullmatch(data["imageVersion"]):
            return None, "imageVersion is not valid"
    return data, None


class NautilusArm:
    """Reads the node container and its arm state; runs arm and disarm one at a time."""

    def __init__(self, docker=docker_run, cli=nautilus_cli_run, clock=time.time, log=None):
        self._docker = docker
        self._cli = cli
        self._clock = clock
        self._log = log or (lambda *a, **k: None)
        self._change = threading.Lock()

    def container(self):
        """-> (state, health, cid). state: running, exited, missing or unknown."""
        try:
            rows = [line.split() for line in self._docker(nautilus_ps_argv(), 5).splitlines() if line.strip()]
            if not rows:
                return "missing", None, None
            if any(not CID_RE.fullmatch(r[0]) for r in rows):
                raise DockerError("container id")
            if len(rows) > 1:
                raise DockerError("more than one node container")  # ambiguous: no exec
            cid = rows[0][0]
            state = json.loads(self._docker(inspect_argv(cid), 5))
            if not isinstance(state, dict):
                raise DockerError("inspect")
            health = state.get("Health")
            health = health.get("Status") if isinstance(health, dict) else None
            health = health if health in ("healthy", "unhealthy", "starting") else None
            if state.get("Running") is True:
                return "running", health, cid
            return "exited", health, cid
        except (DockerError, ValueError, TypeError, AttributeError, IndexError):
            return "unknown", None, None

    def _arm_status(self, cid):
        """-> (arm object or None, error code or None)."""
        try:
            code, text = self._cli(nautilus_exec_argv(cid, ["status", "--json"]), CLI_STATUS_TIMEOUT)
        except DockerTimeout:
            return None, "cli-timeout"
        except DockerError:
            return None, "cli-error"
        arm = parse_cli_status(text) if code == 0 else None
        if arm is None:
            return None, "cli-bad-output"
        arm.pop("auditId")
        return arm, None

    def status(self):
        state, health, cid = self.container()
        arm, error = None, "not-running"
        if state == "running":
            arm, error = self._arm_status(cid)
        return {"schema": ARM_STATUS_SCHEMA, "version": VERSION, "generatedAt": iso(self._clock()),
                "container": {"state": state, "health": health}, "arm": arm, "armError": error}

    def change(self, payload, arm):
        """-> (http status, body). One arm or disarm at a time."""
        action = "arm" if arm else "disarm"
        rid = payload["requestId"]
        if not self._change.acquire(blocking=False):
            return 409, {"error": "busy", "detail": "another arm or disarm is running"}
        try:
            self._log("node_" + action + "_requested", requestId=rid, actor=payload["actorId"])
            state, _health, cid = self.container()
            if state != "running":
                return 409, {"error": "not_running", "detail": "the node container state is " + state}
            if arm:
                command = ["arm", "--by", payload["actorId"], "--reason", payload["reason"],
                           "--confirm-image-version", payload["imageVersion"], "--json"]
            else:
                command = ["disarm", "--by", payload["actorId"], "--reason", payload["reason"], "--json"]
            try:
                code, text = self._cli(nautilus_exec_argv(cid, command), CLI_CHANGE_TIMEOUT)
            except DockerTimeout:
                self._log("node_" + action + "_failed", requestId=rid, error="timeout")
                return 504, {"error": "cli_timeout", "detail": "the arm CLI did not answer in time"}
            except DockerError as e:
                self._log("node_" + action + "_failed", requestId=rid, error=str(e))
                return 502, {"error": "cli_failed", "detail": "the arm CLI could not run"}
            result = parse_cli_status(text) if code == 0 else None
            if result is not None:
                audit_id = result.pop("auditId")
                self._log("node_" + action, requestId=rid, armed=result["armed"], auditId=audit_id)
                return 200, {"schema": ARM_RESULT_SCHEMA, "action": action, "requestId": rid,
                             "auditId": audit_id, "arm": result}
            refusal = parse_cli_error(text) if code == 2 else None
            if refusal is not None:
                self._log("node_" + action + "_refused", requestId=rid, error=refusal[0])
                return 409, {"error": refusal[0], "detail": refusal[1]}
            self._log("node_" + action + "_failed", requestId=rid, error="exit %d" % code)
            return 502, {"error": "cli_failed", "detail": "the arm CLI returned exit %d" % code}
        finally:
            self._change.release()


# ---------------------------------------------------------------------------------------------------------
# HTTP

def make_handler(service, token, nautilus=None):
    expected = ("Bearer " + token).encode()
    nautilus = nautilus or NautilusArm()
    routes = {PREFIX + "/status": "GET", PREFIX + "/health": "GET", PREFIX + "/request": "POST",
              PREFIX + "/nautilus/status": "GET", PREFIX + "/nautilus/arm": "POST",
              PREFIX + "/nautilus/disarm": "POST"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "vertex-ibkr-recovery/" + VERSION
        sys_version = ""
        timeout = 15

        def log_message(self, fmt, *args):
            return

        def _send(self, status, body, headers=None):
            data = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            got = (self.headers.get("Authorization") or "").encode("utf-8", "replace")
            return hmac.compare_digest(got, expected)

        def _bad(self, detail):
            service._log("request_refused", reason="bad_request")
            return self._send(400, {"error": "bad_request", "detail": detail})

        def _handle(self):
            self.close_connection = True
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            path = urlsplit(self.path).path
            if path not in routes:
                return self._send(404, {"error": "not_found"})
            if routes[path] != self.command:
                return self._send(405, {"error": "method_not_allowed"})
            try:
                if path == PREFIX + "/status":
                    return self._send(200, service.status())
                if path == PREFIX + "/health":
                    return self._send(200, service.health())
                if path == PREFIX + "/nautilus/status":
                    return self._send(200, nautilus.status())
                if path == PREFIX + "/nautilus/arm":
                    return self._post_arm(True)
                if path == PREFIX + "/nautilus/disarm":
                    return self._post_arm(False)
                return self._post_request()
            except Exception as e:  # noqa: BLE001
                service._log("http_error", error=type(e).__name__)
                return self._send(500, {"error": "internal"})

        def _read_body(self):
            """-> body bytes, or None when a refusal was already sent."""
            if self.headers.get("Transfer-Encoding"):
                return self._bad("Content-Length required")
            raw_len = (self.headers.get("Content-Length") or "").strip()
            if not raw_len.isdigit():
                return self._bad("Content-Length required")
            length = int(raw_len)
            if length > MAX_BODY:
                return self._send(413, {"error": "payload_too_large"})
            return self.rfile.read(length)

        def _post_arm(self, arm):
            raw = self._read_body()
            if raw is None:
                return None
            payload, detail = validate_arm_request(raw, arm)
            if payload is None:
                return self._bad(detail)
            status, body = nautilus.change(payload, arm)
            return self._send(status, body)

        def _post_request(self):
            raw = self._read_body()
            if raw is None:
                return None
            payload, detail = validate_request(raw)
            if payload is None:
                return self._bad(detail)
            status, body, headers = service.request(payload)
            return self._send(status, body, headers)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

    return Handler


def _log(event, **kw):
    print(json.dumps({"t": iso(time.time()), "event": event, **kw}, separators=(",", ":")), flush=True)


def main():
    token = os.environ.get("VERTEX_RECOVERY_TOKEN", "")
    status_token = os.environ.get("VERTEX_STATUS_TOKEN", "")
    if not TOKEN_RE.fullmatch(token):
        print("VERTEX_RECOVERY_TOKEN missing or shorter than 43 URL-safe chars", file=sys.stderr)
        return 2
    if status_token and hmac.compare_digest(token.encode(), status_token.encode()):
        print("VERTEX_RECOVERY_TOKEN must differ from VERTEX_STATUS_TOKEN", file=sys.stderr)
        return 2
    if not status_token:
        _log("warning", detail="VERTEX_STATUS_TOKEN missing; the account snapshot check cannot pass")
    os.umask(0o077)
    state_dir = (os.environ.get("STATE_DIRECTORY") or DEFAULT_STATE_DIR).split(":")[0]
    gateway = GatewayCache(GatewayReader().read)
    service = Recovery(state_dir, gateway, fetch_health=make_health_fetcher(status_token), log=_log)
    stop = threading.Event()
    threading.Thread(target=service.run_monitor, args=(stop,), name="monitor", daemon=True).start()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), make_handler(service, token, NautilusArm(log=_log)))
    server.daemon_threads = True
    _log("listening", host=LISTEN_HOST, port=LISTEN_PORT, version=VERSION)
    try:
        server.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
