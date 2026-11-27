#!/usr/bin/env python3
"""Vertex read-only deployment status collector (QuantVPS), schema v1 + v2.

Writes two sanitized snapshots every timer cycle:
  status.json     vertex-deploy-status-v1 (unchanged; the default document)
  status-v2.json  vertex-deploy-status-v2 (v1 fields + session/positions/orders/fills/equity/risk/logs)

Read-only by construction: `docker inspect`, `docker logs`, file reads/stat, `redis-cli HGETALL`,
`psql` inside `BEGIN READ ONLY`, and a single read-only `GET /api/snapshot` to the local
`ibkr-monitor.service` (IBKR client id 195) for live positions, orders, fills, and equity. Never
starts/stops containers, never connects an IBKR API client itself, never calls portfolio-ui, never
invokes any 2FA/recovery or POST endpoint, never touches kill-switch files. Account numbers are
to the last 4 characters, log text is filtered to WARNING/ERROR and scrubbed, output is bounded.
Stdlib only; runs on Python 3.8+.

Test mode: collect.py --fixtures DIR --out DIR [--now ISO]  (reads captured inputs, runs nothing).
"""
import datetime
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

COLLECTOR_VERSION = "2.4.0"
# v2 (session/account blocks) is built only when VERTEX_STATUS_V2=1 (or --v2). Default OFF: the user's
# condition for publishing account data is token + source-IP allow-list, and no stable source exists yet.
V2_ENV = "VERTEX_STATUS_V2"
V2_DIR_ENV = "VERTEX_STATUS_V2_DIR"
IBKR_MONITOR_URL_ENV = "VERTEX_IBKR_MONITOR_URL"
# Non-public directory: served only by the tailnet-bound status site (remote_ip = the rig), never by the
# public vertex-status container (which mounts /opt/vertex-status/public only).
PRIVATE_V2_DIR = "/opt/vertex-status/private-v2"
OUT_DIR = "/opt/vertex-status/public"
STATE_DIR = "/opt/vertex-status/state"
TOKEN_ENV = "/opt/vertex-status/token.env"
HOSTS_ENV = "/etc/vertex/hosts.env"
IBKR_MONITOR_PORT = 3461
IBKR_MONITOR_SNAPSHOT_PATH = "/api/snapshot"
IBKR_MONITOR_TIMEOUT_SECONDS = 5
IBKR_MONITOR_MAX_BYTES = 4 * 1024 * 1024
IBKR_MONITOR_SOURCE = "ibkr-monitor.service (/api/snapshot)"
IBKR_UNSET = 1e300
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
PREFIX = "ibkr-nautilus-exec-node-"
SERVICES = ["nautilus-trader", "ib-gateway", "watchdog", "portfolio-ui", "postgres", "redis", "caddy"]
ROOT = "/opt/vertex-exec-node"
DATA = ROOT + "/data"
NAUT = DATA + "/nautilus"
LOGS = NAUT + "/logs"
HEALTH_FILE = NAUT + "/health.json"
RUNNER_LOG = LOGS + "/prototype-runner.log"
WATCHDOG_LOG = LOGS + "/watchdog.log"
# KILL_SWITCH_PATH resolves to data/KILL_SWITCH for nautilus/watchdog (/app/data) and, through the
# relative default, to portfolio-ui/data/KILL_SWITCH for portfolio-ui (working dir /app/portfolio-ui).
KILL_SWITCH_FILES = [DATA + "/KILL_SWITCH", ROOT + "/portfolio-ui/data/KILL_SWITCH"]
REDIS_HEARTBEAT_KEY = "vertex_quant:nautilus:heartbeat:state"
PG_CACHE_SECONDS = 300

HEARTBEAT_FRESH_SECONDS = 120
REPORT_STALE_SECONDS = 300
LOG_TAIL_BYTES = 128 * 1024
DOCKER_LOG_TAIL = 300
MAX_LOG_ENTRIES = 50
MAX_FILLS = 50
MAX_POSITIONS = 200
MAX_ORDERS = 200
MAX_STRATEGIES = 20
MAX_MESSAGE = 240
SOFT_MAX_BYTES = 60 * 1024   # the Vertex app reads at most 64 KiB
HARD_MAX_BYTES = 256 * 1024

# Only these nautilus-trader environment keys are ever read from `docker inspect` (non-secret config).
RISK_ENV_KEYS = {
    "TRADING_MODE": "str", "ENABLE_LIVE_TRADING": "bool", "I_UNDERSTAND_LIVE_TRADING_RISK": "bool",
    "NAUTILUS_RISK_ORDERS_ENABLED": "bool", "NAUTILUS_RISK_DRY_RUN": "bool",
    "NAUTILUS_RISK_MAX_ORDER_QUANTITY": "num", "NAUTILUS_RISK_MAX_POSITION_NOTIONAL_USD": "num",
    "NAUTILUS_RISK_MAX_DAILY_LOSS_USD": "num", "NAUTILUS_RISK_ALLOWED_INSTRUMENTS": "list",
    "RISK_DENIED_INSTRUMENTS": "list", "NAUTILUS_SAMPLE_ORDERS_ENABLED": "bool", "SYNTHETIC_STOPS_ENABLED": "bool",
    "SYNTHETIC_STOP_MODE": "str", "SYNTHETIC_STOP_MAX_ORDER_QUANTITY": "num",
    "IBKR_GATEWAY_ENABLED": "bool",
}
# Only these watchdog live_flags are passed on; flags of retired features are dropped.
WATCHDOG_FLAG_KEYS = ("trading_mode", "enable_live_trading", "live_risk_acknowledged", "nautilus_risk_orders_enabled",
                      "nautilus_risk_dry_run", "kill_switch_active")

# ---------------------------------------------------------------------------------------------
# Scrubbing
# ---------------------------------------------------------------------------------------------
_SECRET_WORDS = (r"pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|"
                 r"client[_-]?secret|authorization|auth|cookie|session[_-]?id|credentials?|otp|totp|signature|sig")
_SCRUBBERS = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}"), r"\1 [redacted]"),
    (re.compile(r"(?i)([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"), r"\1[redacted]@"),
    (re.compile(r"(?i)\b(" + _SECRET_WORDS + r")([\"']?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;}&]+)"), r"\1\2[redacted]"),
    (re.compile(r"(?i)([?&](?:" + _SECRET_WORDS + r")=)[^&\s]+"), r"\1[redacted]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
    (re.compile(r"\b(?:DU|DF|U|F)\*{0,8}(\d{4,})\b"), lambda m: "****" + m.group(1)[-4:]),
    (re.compile(r"\b[A-Z]{1,2}\*{2,}(\d{4})\b"), r"****\1"),
    (re.compile(r"\b\d{9,}\b"), lambda m: "****" + m.group(0)[-4:]),
    # opaque tokens: 32+ chars mixing upper, lower and digits, or 32+ hex chars
    (re.compile(r"(?<![\w/.-])(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{32,}={0,2}"), "[redacted]"),
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), "[redacted]"),
]
# Final document guard: anything matching these is a leak and must not be published.
LEAK_PATTERNS = [
    re.compile(r"\b(?:DU|DF|U)\d{5,}\b"),
    re.compile(r"(?i)\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}"),
    re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|private[_-]?key)[\"']?\s*[:=]\s*[\"']?(?!\[redacted\])[^\s\"',}]{3,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


def scrub(text, limit=MAX_MESSAGE):
    s = str(text if text is not None else "")
    s = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", s)
    for pattern, repl in _SCRUBBERS:
        s = pattern.sub(repl, s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1] + "\u2026"


def mask_account(value):
    """Mask an account identifier to its last 4 characters ("****1234")."""
    if value is None:
        return None
    digits = re.sub(r"[^0-9A-Za-z]", "", str(value))
    tail = digits[-4:] if digits else ""
    return "****" + tail if tail else None


def mask_id(value):
    if value is None:
        return None
    s = str(value)
    return s if len(s) <= 4 else "****" + s[-4:]


# ---------------------------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------------------------
LEGACY_ZONE_ALIASES = {"US/Eastern": "America/New_York"}


def parse_time(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=datetime.timezone.utc)
        return value.astimezone(datetime.timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.datetime.fromtimestamp(float(value), datetime.timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    s = str(value).strip()
    if s.startswith("0001-01-01"):
        return None
    ib = re.match(r"^(\d{4})(\d\d)(\d\d)[ -](\d\d):(\d\d):(\d\d)(?:\s+(\S+))?$", s)   # IB "20260911 15:30:01 US/Eastern"
    if ib:
        tz = datetime.timezone.utc
        if ib.group(7):
            try:
                import zoneinfo
                tz_name = LEGACY_ZONE_ALIASES.get(ib.group(7), ib.group(7))
                tz = zoneinfo.ZoneInfo(tz_name)
            except Exception:
                return None
        try:
            return datetime.datetime(*[int(x) for x in ib.groups()[:6]], tzinfo=tz).astimezone(datetime.timezone.utc)
        except ValueError:
            return None
    s = s.replace(" ", "T", 1) if re.match(r"^\d{4}-\d\d-\d\d \d", s) else s
    s = re.sub(r"Z$", "+00:00", s)
    if "T" in s:
        s = re.sub(r"([+-]\d\d)$", r"\1:00", s)                   # psql "+00"
        # Python 3.10 fromisoformat needs exactly 3 or 6 fraction digits (docker emits 9)
        s = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), s, count=1)
    m = re.match(r"^(\d{8})T(\d{6})(Z|[+-]\d\d:?\d\d)?$", s)       # 20260918T201550Z
    if m:
        s = "%s-%s-%sT%s:%s:%s+00:00" % (m.group(1)[:4], m.group(1)[4:6], m.group(1)[6:], m.group(2)[:2], m.group(2)[2:4], m.group(2)[4:])
    try:
        dt = datetime.datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


def iso(value):
    dt = parse_time(value)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z") if dt else None


def parse_epoch_ms(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if f != f or f in (float("inf"), float("-inf")) or f <= 0:
        return None
    try:
        return datetime.datetime.fromtimestamp(f / 1000.0, datetime.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def num(value):
    if isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f) if f.is_integer() and abs(f) < 2 ** 53 else round(f, 6)


def ibkr_num(value):
    v = num(value)
    if v is None or abs(v) >= IBKR_UNSET:
        return None
    return v

def as_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off", ""):
        return False
    return None


# ---------------------------------------------------------------------------------------------
# Input layer (live host vs captured fixtures)
# ---------------------------------------------------------------------------------------------
def _sh(args, timeout=8, stdin=None):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, input=stdin)
    except (OSError, subprocess.SubprocessError):
        return 127, "", ""
    return r.returncode, r.stdout, r.stderr


class _RedirectRefusedError(Exception):
    def __init__(self, code):
        super().__init__("redirect refused")
        self.code = code


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _RedirectRefusedError(code)


def is_tailnet_ipv4(value):
    if not isinstance(value, str) or not value or not value.isascii():
        return False
    try:
        octets = ipaddress.IPv4Address(value).packed
    except ValueError:
        return False
    return len(octets) == 4 and octets[0] == 100 and 64 <= octets[1] <= 127


def read_host_config_value(name, path=HOSTS_ENV):
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return ""
    value = ""
    prefix = name + "="
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(prefix):
            value = line[len(prefix):].strip()
    return value


def validate_ibkr_monitor_base_url(base):
    if not isinstance(base, str) or not base.strip():
        raise ValueError("empty ibkr-monitor URL")
    text = base.strip()
    if not text.isascii():
        raise ValueError("non-ASCII ibkr-monitor URL")
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme != "http":
        raise ValueError("ibkr-monitor URL must use plain http")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("ibkr-monitor URL must not contain credentials")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("ibkr-monitor URL must be a bare base URL")
    host = (parsed.hostname or "").lower()
    if host not in LOOPBACK_HOSTS and not is_tailnet_ipv4(host):
        raise ValueError("ibkr-monitor URL must target loopback or tailnet IPv4")
    port = parsed.port
    if port is not None and not (1 <= port <= 65535):
        raise ValueError("ibkr-monitor URL port out of range")
    host_fmt = "[%s]" % host if ":" in host else host
    netloc = "%s:%d" % (host_fmt, port) if port is not None else host_fmt
    return "http://%s%s" % (netloc, IBKR_MONITOR_SNAPSHOT_PATH)


def ibkr_monitor_candidate_urls(override_url=None, hosts_env=HOSTS_ENV):
    if override_url is not None and str(override_url).strip():
        try:
            return [validate_ibkr_monitor_base_url(str(override_url))], None
        except ValueError:
            return [], "invalid ibkr-monitor URL configuration"
    urls = ["http://127.0.0.1:%d%s" % (IBKR_MONITOR_PORT, IBKR_MONITOR_SNAPSHOT_PATH)]
    tailnet_ip = read_host_config_value("VERTEX_TAILNET_IPV4", hosts_env)
    if is_tailnet_ipv4(tailnet_ip):
        urls.append("http://%s:%d%s" % (tailnet_ip, IBKR_MONITOR_PORT, IBKR_MONITOR_SNAPSHOT_PATH))
    return urls, None


def _fetch_ibkr_monitor_json(url, timeout=IBKR_MONITOR_TIMEOUT_SECONDS, max_bytes=IBKR_MONITOR_MAX_BYTES):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", resp.getcode()))
            if status != 200:
                return None, "ibkr-monitor returned HTTP %d" % status, False
            ctype = resp.headers.get("Content-Type", "")
            if not re.match(r"^\s*application/json\b", ctype, re.I):
                return None, "ibkr-monitor returned unexpected content type", False
            body = resp.read(max_bytes + 1)
            if len(body) > max_bytes:
                return None, "ibkr-monitor response exceeds size cap", False
    except _RedirectRefusedError as exc:
        return None, "ibkr-monitor redirect refused (HTTP %d)" % exc.code, False
    except urllib.error.HTTPError as exc:
        code = int(exc.code)
        try:
            exc.close()
        except Exception:
            pass
        return None, "ibkr-monitor returned HTTP %d" % code, False
    except (urllib.error.URLError, TimeoutError, OSError):
        return None, "ibkr-monitor request failed", True
    try:
        doc = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "ibkr-monitor response is not valid JSON", False
    if not isinstance(doc, dict):
        return None, "ibkr-monitor response is not a JSON object", False
    return doc, None, False


class LiveInputs:
    fixture = False

    def __init__(self, ibkr_monitor_url=None, hosts_env=HOSTS_ENV):
        env_url = os.environ.get(IBKR_MONITOR_URL_ENV, "").strip()
        self._ibkr_monitor_url = ibkr_monitor_url if ibkr_monitor_url is not None else (env_url or None)
        self._hosts_env = hosts_env

    def now(self):
        return datetime.datetime.now(datetime.timezone.utc)
    def inspect_status(self, service):
        """-> ("ok", object), ("missing", None) when Docker answers that no such container exists, or
        ("unreadable", None) when the Docker command fails in any other way."""
        code, out, err = _sh(["docker", "inspect", PREFIX + service + "-1"])
        if code != 0:
            text = (out or "") + (err or "")
            return ("missing", None) if "No such object" in text or "No such container" in text else ("unreadable", None)
        try:
            return "ok", json.loads(out)[0]
        except (ValueError, IndexError):
            return "unreadable", None

    def docker_logs(self, service, tail):
        code, out, err = _sh(["docker", "logs", "--timestamps", "--tail", str(tail), PREFIX + service + "-1"], timeout=10)
        return (out or "") + (err or "") if code == 0 else None

    def read_text(self, path, max_bytes=2 * 1024 * 1024):
        try:
            with open(path, "rb") as f:
                return f.read(max_bytes).decode("utf-8", "replace")
        except OSError:
            return None

    def tail_text(self, path, nbytes=LOG_TAIL_BYTES):
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - nbytes))
                data = f.read(nbytes).decode("utf-8", "replace")
        except OSError:
            return None
        lines = data.splitlines()
        return "\n".join(lines[1:] if size > nbytes else lines)

    def mtime(self, path):
        try:
            return os.stat(path).st_mtime
        except OSError:
            return None

    def exists(self, path):
        """True/False, or None when the answer cannot be determined (permission/IO error)."""
        try:
            os.lstat(path)
            return True
        except FileNotFoundError:
            return False
        except OSError:
            return None

    def psql(self, sql):
        script = "BEGIN READ ONLY;\nSET LOCAL statement_timeout = '4000';\n" + sql + "\nCOMMIT;\n"
        code, out, _ = _sh(["docker", "exec", "-i", PREFIX + "postgres-1", "sh", "-c",
                            'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "\t"'],
                           timeout=10, stdin=script)
        return out if code == 0 else None

    def redis_hgetall(self, key):
        code, out, _ = _sh(["docker", "exec", PREFIX + "redis-1", "redis-cli", "HGETALL", key])
        if code != 0:
            return None
        vals = out.split("\n")
        if vals and vals[-1] == "":
            vals = vals[:-1]
        return {vals[i]: vals[i + 1] for i in range(0, len(vals) - 1, 2)}

    def token(self):
        text = self.read_text(TOKEN_ENV, 4096) or ""
        m = re.search(r"^VERTEX_STATUS_TOKEN=(.+)$", text, re.M)
        return m.group(1).strip() if m else None

    def ibkr_monitor_snapshot(self):
        urls, cfg_err = ibkr_monitor_candidate_urls(self._ibkr_monitor_url, self._hosts_env)
        if cfg_err:
            return None, cfg_err
        last_err = "ibkr-monitor request failed"
        for url in urls:
            doc, err, is_transport = _fetch_ibkr_monitor_json(url)
            if err is None:
                return doc, None
            last_err = err
            if not is_transport:
                break
        return None, last_err

class FixtureInputs(LiveInputs):
    """Reads captured, redacted inputs from a fixture directory; never runs commands."""
    fixture = True

    def __init__(self, root, now=None):
        self.root = root
        with open(os.path.join(root, "manifest.json")) as f:
            self.manifest = json.load(f)
        self._now = parse_time(now or self.manifest.get("now")) or datetime.datetime.now(datetime.timezone.utc)

    def _file(self, rel):
        return os.path.join(self.root, rel)

    def now(self):
        return self._now

    def inspect_status(self, service):
        """Fixture: inspect/<service>.json is the container; inspect/<service>.unreadable is a failed
        Docker command; neither file is a missing container."""
        p = self._file("inspect/%s.json" % service)
        if os.path.exists(p):
            with open(p) as f:
                return "ok", json.load(f)
        if os.path.exists(self._file("inspect/%s.unreadable" % service)):
            return "unreadable", None
        return "missing", None

    def docker_logs(self, service, tail):
        p = self._file("docker-logs/%s.txt" % service)
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return "\n".join(f.read().splitlines()[-tail:])

    def _map(self, path):
        rel = self.manifest.get("files", {}).get(path)
        return self._file(rel) if rel else None

    def read_text(self, path, max_bytes=2 * 1024 * 1024):
        p = self._map(path)
        return LiveInputs.read_text(self, p, max_bytes) if p else None

    def tail_text(self, path, nbytes=LOG_TAIL_BYTES):
        p = self._map(path)
        return LiveInputs.tail_text(self, p, nbytes) if p else None

    def mtime(self, path):
        v = self.manifest.get("mtimes", {}).get(path)
        return parse_time(v).timestamp() if v else None

    def exists(self, path):
        v = self.manifest.get("exists", {}).get(path, False)
        return v

    def psql(self, sql):
        key = "strategies" if "strategy_events" in sql else "risk" if "risk_events" in sql else None
        p = self._file("psql/%s.tsv" % key) if key else None
        if not p or not os.path.exists(p):
            return None
        with open(p) as f:
            return f.read()

    def redis_hgetall(self, key):
        return self.manifest.get("redis", {}).get(key)

    def token(self):
        return self.manifest.get("token")

    def ibkr_monitor_snapshot(self):
        rel = self.manifest.get("ibkr_monitor_snapshot")
        if not rel:
            return None, self.manifest.get("ibkr_monitor_error") or "ibkr-monitor snapshot missing in fixture"
        p = self._file(rel)
        if not os.path.exists(p):
            return None, "ibkr-monitor fixture unreadable"
        doc = load_json_text(LiveInputs.read_text(self, p, IBKR_MONITOR_MAX_BYTES))
        if not isinstance(doc, dict):
            return None, "ibkr-monitor fixture is not a JSON object"
        return doc, None

# ---------------------------------------------------------------------------------------------
# v1 (unchanged semantics)
# ---------------------------------------------------------------------------------------------
def service_item(inp, name, raw):
    if raw is None:
        return {"service": name, "present": False}
    st = raw.get("State", {}) or {}
    item = {"service": name, "present": True, "status": st.get("Status"), "running": st.get("Running"),
            "health": (st.get("Health") or {}).get("Status"), "startedAt": st.get("StartedAt"),
            "finishedAt": st.get("FinishedAt"), "exitCode": st.get("ExitCode"), "restartCount": raw.get("RestartCount"),
            "oomKilled": st.get("OOMKilled"), "image": (raw.get("Config") or {}).get("Image")}
    if name in ("nautilus-trader", "ib-gateway") and st.get("Running"):
        logs = inp.docker_logs(name, 500)
        lines = [l for l in (logs or "").splitlines() if l.strip()]
        ts = [l.split(" ", 1)[0] for l in lines if re.match(r"^\d{4}-\d\d-\d\dT", l)]
        item["log"] = {"lastLineAt": ts[-1] if ts else None, "lines": len(lines),
                       "errorLines": sum(1 for l in lines if re.search(r"\b(ERROR|CRITICAL|Traceback)\b", l)),
                       "warnLines": sum(1 for l in lines if re.search(r"\bWARN(ING)?\b", l))}
    return item


# ---------------------------------------------------------------------------------------------
# v2 blocks
# ---------------------------------------------------------------------------------------------
def unavailable(source, reason):
    return {"available": False, "source": source, "reason": scrub(reason, 160)}


def freshness(now, as_of, stale_after):
    dt = parse_time(as_of)
    if dt is None:
        return {"as_of": None, "age_seconds": None, "stale": True}
    age = max(0, int((now - dt).total_seconds()))
    return {"as_of": iso(dt), "age_seconds": age, "stale": age > stale_after}


def read_previous(path, max_bytes=2 * 1024 * 1024):
    """The last snapshot this collector wrote, or None (absent, unreadable or not JSON)."""
    try:
        with open(path, "rb") as f:
            data = load_json_text(f.read(max_bytes).decode("utf-8", "replace"))
    except OSError:
        return None
    return data if isinstance(data, dict) else None


def load_json_text(text):
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def json_lines(text):
    out = []
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def env_map(raw):
    """Return only allow-listed, non-secret env keys of a container."""
    out = {}
    for item in ((raw or {}).get("Config") or {}).get("Env") or []:
        key, _, value = str(item).partition("=")
        if key in RISK_ENV_KEYS:
            out[key] = value
    return out


def typed_env(env):
    limits = {}
    for key, kind in RISK_ENV_KEYS.items():
        if key not in env:
            continue
        v = env[key]
        if kind == "bool":
            limits[key.lower()] = as_bool(v)
        elif kind == "num":
            limits[key.lower()] = num(v)
        elif kind == "list":
            limits[key.lower()] = [scrub(x, 32) for x in str(v).split(",") if x.strip()][:50]
        else:
            limits[key.lower()] = scrub(v, 64)
    return limits


def pg_cached(inp, name, sql):
    """psql result cached for PG_CACHE_SECONDS on the live host (event tables are large, unindexed)."""
    if inp.fixture:
        return inp.psql(sql), None
    path = os.path.join(STATE_DIR, "pg-%s.json" % name)
    try:
        with open(path) as f:
            cached = json.load(f)
        if time.time() - cached["at"] < PG_CACHE_SECONDS and cached.get("sql") == sql:
            return cached["out"], cached["at"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    out = inp.psql(sql)
    if out is not None:
        try:
            os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".pg-")
            with os.fdopen(fd, "w") as f:
                json.dump({"at": time.time(), "sql": sql, "out": out}, f)
            os.replace(tmp, path)
        except OSError:
            pass
    return out, None


def strategies_from_pg(inp, since):
    where = "event_type = 'strategy_started'"
    if since is not None:
        where += " AND event_time >= '%s'::timestamptz - interval '10 minutes'" % since.isoformat()
    sql = ("SELECT payload->>'strategy', max(event_time), (array_agg(payload::text ORDER BY event_time DESC))[1] "
           "FROM strategy_events WHERE %s GROUP BY 1 ORDER BY 2 DESC LIMIT %d;" % (where, MAX_STRATEGIES))
    out, _ = pg_cached(inp, "strategies", sql)
    if out is None:
        return None
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or parts[0] in ("BEGIN", "SET", "COMMIT"):
            continue
        payload = load_json_text(parts[2]) or {}
        watch = payload.get("watchlist") if isinstance(payload.get("watchlist"), list) else []
        rows.append({"id": scrub(parts[0], 64), "name": scrub(parts[0], 64), "started_at": iso(parts[1]),
                     "symbols": [scrub(s, 24) for s in watch][:50],
                     "observation_only": as_bool(payload.get("observation_only")),
                     "trading_mode": scrub(payload.get("trading_mode"), 16) if payload.get("trading_mode") else None})
    return rows


def last_risk_check(inp):
    sql = "SELECT event_time, event_type, payload::text FROM risk_events ORDER BY event_time DESC LIMIT 1;"
    out, _ = pg_cached(inp, "risk", sql)
    for line in (out or "").splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        p = load_json_text(parts[2]) or {}
        keep = {}
        for k in ("allowed", "dry_run", "orders_enabled", "market_hours_only", "max_daily_loss_usd", "max_order_quantity",
                  "max_order_premium_usd", "max_position_notional_usd", "requested_quantity"):
            if k in p:
                keep[k] = p[k] if isinstance(p[k], bool) else num(p[k])
        for k in ("reason", "strategy", "requested_symbol"):
            if p.get(k) is not None:
                keep[k] = scrub(p[k], 64)
        for k in ("allowed_instruments", "denied_instruments"):
            if isinstance(p.get(k), list):
                keep[k] = [scrub(x, 24) for x in p[k]][:50]
        return {"time": iso(parts[0]), "event": scrub(parts[1], 64), **keep}
    return None


def runner_events(inp):
    return json_lines(inp.tail_text(RUNNER_LOG, 64 * 1024))


def watchdog_summary(inp):
    lines = json_lines(inp.tail_text(WATCHDOG_LOG, 64 * 1024))
    for j in reversed(lines):
        if j.get("event") == "watchdog_status" and isinstance(j.get("summary"), dict):
            return j, lines
    return None, lines


def map_session_state(container, health, heartbeat_age, kill_engaged, last_event, absent="missing"):
    """absent: why there is no container record: "missing" (Docker answered: no such container) or
    "unreadable" (the Docker command failed)."""
    if container is None:
        return absent
    st = container.get("State", {}) or {}
    status = (st.get("Status") or "").lower()
    if status == "running":
        if kill_engaged:
            return "halted"
        if ((st.get("Health") or {}).get("Status") or "") == "starting":
            return "starting"
        if last_event in ("runner_stopping", "runner_stopped"):
            return "stopping"
        if (health or {}).get("status") == "ok" and heartbeat_age is not None and heartbeat_age <= HEARTBEAT_FRESH_SECONDS:
            return "running"
        return "degraded"
    if status == "restarting":
        return "starting"
    if status == "paused":
        return "paused"
    if status == "removing":
        return "stopping"
    if status == "dead" or st.get("OOMKilled"):
        return "error"
    if status == "exited":
        return "error" if st.get("ExitCode") not in (0, None) else "stopped"
    if status == "created":
        return "stopped"
    return "unrecognised"


def state_since(previous, state, now):
    """Time the session state began: the previous snapshot's state_since when its state is the same,
    else now (also on the first run and when the previous snapshot is not readable)."""
    session = (previous or {}).get("session") if isinstance(previous, dict) else None
    if isinstance(session, dict) and session.get("state") == state and parse_time(session.get("state_since")):
        return iso(session.get("state_since"))
    return iso(now)


def build_session(inp, now, nautilus_raw, health, kill_engaged, account, read="ok", previous=None):
    redis = inp.redis_hgetall(REDIS_HEARTBEAT_KEY)
    events = runner_events(inp)
    last = events[-1] if events else {}
    last_event = last.get("event")
    hb_candidates = [parse_time((health or {}).get("last_heartbeat_at")), parse_time((redis or {}).get("last_timestamp"))]
    hb_candidates += [parse_time(e.get("timestamp")) for e in events if e.get("event") == "strategy_heartbeat"]
    hb = max([d for d in hb_candidates if d is not None], default=None)
    hb_age = int((now - hb).total_seconds()) if hb else None
    state = map_session_state(nautilus_raw, health, hb_age, kill_engaged, last_event,
                              absent="unreadable" if read == "unreadable" else "missing")
    st = (nautilus_raw or {}).get("State", {}) or {}
    runner_started = parse_time((health or {}).get("started_at"))
    strategies = strategies_from_pg(inp, runner_started)
    if strategies is None:
        strategies = []
        for e in events:
            if e.get("event") in ("strategy_started", "strategy_heartbeat") and e.get("strategy"):
                strategies = [{"id": scrub(e["strategy"], 64), "name": scrub(e["strategy"], 64), "started_at": None,
                               "symbols": [scrub(s, 24) for s in (e.get("watchlist") or [])][:50],
                               "observation_only": as_bool(e.get("observation_only")), "trading_mode": None}]
        strategy_source = "nautilus_runner_log"
    else:
        strategy_source = "postgres.strategy_events"
    symbols = sorted({s for row in strategies for s in row.get("symbols", [])})
    stopped_at = None
    for e in reversed(events):
        if e.get("event") == "runner_stopped":
            stopped_at = iso(e.get("timestamp"))
            break
    raw = {
        "container_status": st.get("Status"),
        "container_health": (st.get("Health") or {}).get("Status"),
        "container_exit_code": st.get("ExitCode"),
        "health_file_status": scrub((health or {}).get("status"), 32) if health else None,
        "last_runner_event": scrub(last_event, 64) if last_event else None,
        "last_runner_event_at": iso(last.get("timestamp")),
        "heartbeat_age_seconds": hb_age,
    }
    trading_mode = (health or {}).get("trading_mode") or (redis or {}).get("trading_mode") or last.get("trading_mode")
    return {
        # Always a definite state (missing and unreadable included); an unavailable block would need a
        # reason and no other fields, which the reader requires.
        "available": True,
        "source": "docker inspect nautilus-trader + data/nautilus/health.json + redis heartbeat + prototype-runner.log + " + strategy_source,
        "as_of": iso(now),
        "state": state,
        "state_since": state_since(previous, state, now),
        "raw_state": raw,
        "trading_mode": scrub(trading_mode, 16) if trading_mode else None,
        "safe_mode": as_bool((health or {}).get("safe_mode")),
        "strategies": strategies[:MAX_STRATEGIES],
        "symbols": symbols[:100],
        "account_masked": account,
        "started_at": iso((health or {}).get("started_at")) or iso(st.get("StartedAt")),
        "stopped_at": stopped_at if state in ("stopped", "error", "stopping") else None,
        "last_heartbeat_at": iso(hb),
        "ibkr_adapter": {"ok": as_bool(((health or {}).get("ibkr") or {}).get("ok")),
                         "detail": scrub(((health or {}).get("ibkr") or {}).get("detail"), 80) or None,
                         "checked_at": iso(((health or {}).get("ibkr") or {}).get("checked_at"))},
    }


def _validate_ibkr_monitor_snapshot(payload, fetch_error):
    if payload is None:
        return None, None, fetch_error or "ibkr-monitor snapshot unavailable"
    if not isinstance(payload, dict):
        return None, None, "ibkr-monitor snapshot is not a JSON object"
    account = payload.get("account")
    if isinstance(account, dict) and account.get("modeError") == "mismatch":
        return None, None, "ibkr-monitor account mode mismatch"
    status = payload.get("status")
    if not isinstance(status, dict):
        return None, None, "ibkr-monitor snapshot missing status object"
    bridge = status.get("bridge")
    if bridge != "live":
        label = scrub(bridge, 24) if isinstance(bridge, str) and bridge.strip() else "unknown"
        return None, None, "ibkr-monitor bridge is %s" % label
    return payload, status, None


def build_positions(now, ibkr_payload, ibkr_error=None):
    payload, status, err = _validate_ibkr_monitor_snapshot(ibkr_payload, ibkr_error)
    if err is not None:
        return unavailable(IBKR_MONITOR_SOURCE, err)
    raw_positions = payload.get("positions")
    if not isinstance(raw_positions, list):
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing positions list")
    as_of_dt = parse_epoch_ms(status.get("dataAsOf"))
    if as_of_dt is None:
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing dataAsOf timestamp")
    items = []
    for p in raw_positions[:MAX_POSITIONS]:
        if not isinstance(p, dict):
            return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor positions payload contains invalid entry")
        sec_type = scrub(p.get("secType"), 8) or None
        raw_mult = ibkr_num(p.get("multiplier"))
        eff_mult = raw_mult if (raw_mult is not None and raw_mult > 0) else 1
        avg_px = ibkr_num(p.get("avgPrice"))
        avg_cost = ibkr_num(p.get("avgCost"))
        if avg_cost is None and avg_px is not None:
            derived_cost = ibkr_num(avg_px * eff_mult)
            avg_cost = round(derived_cost, 6) if derived_cost is not None else None
        elif avg_px is None and avg_cost is not None:
            derived_px = ibkr_num(avg_cost / eff_mult)
            avg_px = round(derived_px, 6) if derived_px is not None else None
        item = {
            "symbol": scrub(p.get("symbol"), 24),
            "sec_type": sec_type,
            "qty": ibkr_num(p.get("position")),
            "avg_px": avg_px,
            "avg_cost": avg_cost,
            "multiplier": eff_mult if eff_mult != 1 else None,
            "market_price": ibkr_num(p.get("last")),
            "market_value": ibkr_num(p.get("marketValue")),
            "unrealized_pnl": ibkr_num(p.get("unrealized")),
            "realized_pnl": ibkr_num(p.get("realized")),
            "currency": scrub(p.get("currency"), 8) or None,
        }
        if sec_type in ("OPT", "FOP"):
            item["right"] = scrub(p.get("right"), 4) or None
            item["strike"] = ibkr_num(p.get("strike"))
            item["expiry"] = scrub(p.get("expiry"), 12) or None
        items.append(item)
    fresh = freshness(now, as_of_dt, REPORT_STALE_SECONDS)
    if status.get("stale") is True:
        fresh["stale"] = True
    return {
        "available": True,
        "source": "ibkr_tws_api positions via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
        **fresh,
        "count": len(items),
        "items": items,
        "truncated": len(raw_positions) > MAX_POSITIONS,
    }


def build_equity(now, ibkr_payload, positions, ibkr_error=None):
    payload, status, err = _validate_ibkr_monitor_snapshot(ibkr_payload, ibkr_error)
    if err is not None:
        return unavailable(IBKR_MONITOR_SOURCE, err)
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing summary object")
    as_of_dt = parse_epoch_ms(status.get("dataAsOf"))
    if as_of_dt is None:
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing dataAsOf timestamp")

    def pick(tag):
        v = summary.get(tag)
        if isinstance(v, dict):
            for cur in ("USD", "BASE"):
                if cur in v:
                    return ibkr_num(v[cur])
            return ibkr_num(next(iter(v.values()), None))
        return ibkr_num(v)

    pnl = payload.get("pnl") if isinstance(payload.get("pnl"), dict) else {}
    unreal_val = ibkr_num(pnl.get("unrealized"))
    real_val = ibkr_num(pnl.get("realized"))
    items = positions.get("items", []) if isinstance(positions, dict) and positions.get("available") else []
    if unreal_val is not None:
        unrealized = round(unreal_val, 2)
    else:
        unreal_list = [v for v in (ibkr_num(i.get("unrealized_pnl")) for i in items) if v is not None]
        unrealized = round(sum(unreal_list), 2) if unreal_list else None
    if real_val is not None:
        realized = round(real_val, 2)
    else:
        real_list = [v for v in (ibkr_num(i.get("realized_pnl")) for i in items) if v is not None]
        realized = round(sum(real_list), 2) if real_list else None
    fresh = freshness(now, as_of_dt, REPORT_STALE_SECONDS)
    if status.get("stale") is True:
        fresh["stale"] = True
    return {
        "available": True,
        "source": "ibkr_tws_api account summary via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
        **fresh,
        "currency": "USD",
        "net_liq": pick("NetLiquidation"),
        "cash": pick("TotalCashValue"),
        "available_funds": pick("AvailableFunds"),
        "buying_power": pick("BuyingPower"),
        "unrealized": unrealized,
        "realized": realized,
    }


STOP_TYPES = ("STP", "STP LMT", "TRAIL", "TRAIL LIMIT", "STP PRT")

def build_orders(now, ibkr_payload, ibkr_error=None):
    payload, status, err = _validate_ibkr_monitor_snapshot(ibkr_payload, ibkr_error)
    if err is not None:
        return unavailable(IBKR_MONITOR_SOURCE, err)
    raw_orders = payload.get("orders")
    if not isinstance(raw_orders, list):
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing orders list")
    if "ordersAsOf" in payload:
        as_of_dt = parse_epoch_ms(payload.get("ordersAsOf"))
        if as_of_dt is None:
            return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor open-orders snapshot not ready (ordersAsOf missing)")
    else:
        as_of_dt = parse_epoch_ms(status.get("dataAsOf"))
        if as_of_dt is None:
            return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing dataAsOf timestamp")
    items = []
    for o in raw_orders[:MAX_ORDERS]:
        if not isinstance(o, dict):
            return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor orders payload contains invalid entry")
        otype = str(o.get("orderType") or "").upper()
        stp = ibkr_num(o.get("stop"))
        lmt = ibkr_num(o.get("lmt"))
        raw_oid = o.get("orderId")
        if raw_oid is None:
            raw_oid = o.get("permId")
        item = {
            "order_id_masked": mask_id(raw_oid),
            "client_id": ibkr_num(o.get("clientId")),
            "symbol": scrub(o.get("symbol"), 24),
            "sec_type": scrub(o.get("secType"), 8) or None,
            "side": scrub(o.get("action"), 8).lower() or None,
            "type": scrub(otype, 16) or None,
            "qty": ibkr_num(o.get("qty")),
            "filled": ibkr_num(o.get("filledQty")),
            "remaining": ibkr_num(o.get("remaining")),
            "price": lmt,
            "stop": stp if (stp is not None and otype in STOP_TYPES) else None,
            "aux_price": stp if (stp is not None and otype not in STOP_TYPES) else None,
            "tif": scrub(o.get("tif"), 8) or None,
            "status": scrub(o.get("status"), 24) or None,
            "currency": scrub(o.get("currency"), 8) or None,
        }
        warning = o.get("warningText") or o.get("warning")
        if warning:
            item["warning"] = scrub(warning, 160)
        items.append(item)
    fresh = freshness(now, as_of_dt, REPORT_STALE_SECONDS)
    if status.get("stale") is True:
        fresh["stale"] = True
    return {
        "available": True,
        "source": "ibkr_tws_api open orders via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
        **fresh,
        "count": len(items),
        "items": items,
        "truncated": len(raw_orders) > MAX_ORDERS,
    }


def build_fills(now, ibkr_payload, ibkr_error=None):
    payload, status, err = _validate_ibkr_monitor_snapshot(ibkr_payload, ibkr_error)
    if err is not None:
        return unavailable(IBKR_MONITOR_SOURCE, err)
    raw_execs = payload.get("executions")
    if not isinstance(raw_execs, list):
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing executions list")
    as_of_dt = parse_epoch_ms(status.get("dataAsOf"))
    if as_of_dt is None:
        return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor snapshot missing dataAsOf timestamp")
    rows = []
    for e in raw_execs:
        if not isinstance(e, dict):
            return unavailable(IBKR_MONITOR_SOURCE, "ibkr-monitor executions payload contains invalid entry")
        side = str(e.get("side") or "").upper()
        raw_oid = e.get("orderId")
        if raw_oid is None:
            perm_id = e.get("permId")
            raw_oid = perm_id if (isinstance(perm_id, int) and not isinstance(perm_id, bool) and perm_id > 0) else None
        price = ibkr_num(e.get("price"))
        if price is None:
            price = ibkr_num(e.get("avgPrice"))
        rows.append({
            "time": iso(e.get("time")),
            "symbol": scrub(e.get("symbol"), 24),
            "side": {"BOT": "buy", "SLD": "sell", "BUY": "buy", "SELL": "sell"}.get(side, scrub(side, 8).lower() or None),
            "qty": ibkr_num(e.get("shares") if e.get("shares") is not None else e.get("qty")),
            "price": price,
            "order_id_masked": mask_id(raw_oid),
            "exec_id_masked": mask_id(e.get("execId")),
        })
    rows.sort(key=lambda r: str(r.get("time") or ""), reverse=True)
    fresh = freshness(now, as_of_dt, REPORT_STALE_SECONDS)
    if status.get("stale") is True:
        fresh["stale"] = True
    return {
        "available": True,
        "source": "ibkr_tws_api executions via ibkr-monitor.service (/api/snapshot; IBKR client id 195)",
        **fresh,
        "count": len(rows[:MAX_FILLS]),
        "items": rows[:MAX_FILLS],
        "truncated": len(rows) > MAX_FILLS,
    }


def build_risk(inp, now, nautilus_raw, health, wd):
    indicators = []
    files_state = []
    for path in KILL_SWITCH_FILES:
        e = inp.exists(path)
        files_state.append(e)
        indicators.append({"source": "file " + path.replace(ROOT + "/", ""), "engaged": e, "as_of": iso(now)})
    summary = (wd or {}).get("summary") or {}
    wd_flag = as_bool((summary.get("live_flags") or {}).get("kill_switch_active"))
    if wd is not None:
        indicators.append({"source": "watchdog live_flags", "engaged": wd_flag, "as_of": iso(wd.get("timestamp"))})
    hf = as_bool((health or {}).get("kill_switch_active")) if health else None
    if health is not None:
        indicators.append({"source": "nautilus health.json (last written by the runner)", "engaged": hf,
                           "as_of": iso(health.get("last_heartbeat_at"))})
    if any(x is True for x in files_state) or wd_flag is True:
        kill = "engaged"
    elif all(x is False for x in files_state):
        kill = "clear"
    else:
        kill = "unverified"  # no file engaged, at least one file check without answer: not clear
    env = typed_env(env_map(nautilus_raw))
    checks = {}
    for name, c in (summary.get("checks") or {}).items():
        if isinstance(c, dict):
            checks[scrub(name, 40)] = {"ok": as_bool(c.get("ok")), "required": as_bool(c.get("required")),
                                       "consecutive_failures": num(c.get("consecutive_failures")),
                                       "detail": scrub(c.get("detail"), 120) or None, "checked_at": iso(c.get("checked_at"))}
    watchdog = None
    if wd is not None:
        recent = summary.get("recent_status") or {}
        watchdog = {"as_of": iso(wd.get("timestamp")), "status": scrub(summary.get("status"), 24) or None,
                    "safe_mode": as_bool(summary.get("safe_mode")), "orders_enabled": as_bool(summary.get("orders_enabled")),
                    "nautilus_orders_enabled": as_bool(summary.get("nautilus_orders_enabled")),
                    "required_failures": [scrub(x, 40) for x in (recent.get("required_failures") or [])][:20],
                    "kill_switch_created_at": iso(summary.get("kill_switch_created_at")),
                    "kill_switch_reason": scrub(summary.get("kill_switch_reason"), 120) if summary.get("kill_switch_reason") else None,
                    "live_flags": {k: (v if isinstance(v, bool) else scrub(v, 24)) for k, v in (summary.get("live_flags") or {}).items()
                                   if k in WATCHDOG_FLAG_KEYS},
                    "checks": checks}
    return {"available": True, "source": "kill-switch file stat + watchdog.log status + nautilus-trader container env (allow-listed keys) + postgres.risk_events",
            "as_of": iso(now), "kill_switch": kill, "kill_switch_indicators": indicators,
            "limits": {"available": bool(env), "source": "docker inspect nautilus-trader Config.Env (allow-listed non-secret keys)", "as_of": iso(now), **env}
            if env else unavailable("docker inspect nautilus-trader", "container env not readable"),
            "last_risk_check": last_risk_check(inp), "watchdog": watchdog}


# ---------------------------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------------------------
_TEXT_ERROR = re.compile(r"\b(ERROR|CRITICAL|FATAL|Traceback|Exception|panic|Error|failed|FAILED)\b|\bsocat\[\d+\] E\b|\[(?:error|ERROR)\]")
_TEXT_WARN = re.compile(r"\b(WARN|WARNING)\b|\bsocat\[\d+\] W\b|\[(?:warn|WARN)\]")
_EVENT_ERROR = re.compile(r"(failed|failure|error|exception|rejected|denied|crash)", re.I)
_EVENT_WARN = re.compile(r"(disconnect|skipped|blocked|threshold|stopped|stopping|timeout|stale|retry|warn|kill)", re.I)


def _norm(message):
    return re.sub(r"\[\d+\]", "[*]", re.sub(r"\b\d+(\.\d+)?\b", "#", message))


def collect_logs(inp, now, wd_lines, running_services):
    entries = {}

    def add(time_value, level, source, message):
        msg = scrub(message)
        if not msg:
            return
        key = (source, level, _norm(msg))
        t = iso(time_value)
        cur = entries.get(key)
        if cur is None:
            entries[key] = {"time": t, "level": level, "source": source, "message": msg, "count": 1}
        else:
            cur["count"] += 1
            if t and (cur["time"] is None or t >= cur["time"]):
                cur["time"], cur["message"] = t, msg
    # watchdog status lines: each failing check is a WARNING (optional) or ERROR (required)
    for j in wd_lines:
        if j.get("event") != "watchdog_status":
            if j.get("level") in ("WARNING", "ERROR", "CRITICAL") or _EVENT_ERROR.search(str(j.get("event") or "")):
                add(j.get("timestamp"), "ERROR" if j.get("level") in ("ERROR", "CRITICAL") or _EVENT_ERROR.search(str(j.get("event"))) else "WARNING",
                    "watchdog", "%s %s" % (j.get("event"), j.get("detail") or j.get("reason") or ""))
            continue
        for name, c in ((j.get("summary") or {}).get("checks") or {}).items():
            if isinstance(c, dict) and c.get("ok") is False:
                add(c.get("checked_at") or j.get("timestamp"), "ERROR" if c.get("required") else "WARNING", "watchdog",
                    "check %s failed: %s" % (name, c.get("detail") or ""))
    # nautilus runner structured log
    for j in runner_events(inp):
        ev = str(j.get("event") or "")
        lvl = str(j.get("level") or "").upper()
        if lvl in ("ERROR", "CRITICAL") or (not lvl and _EVENT_ERROR.search(ev)):
            level = "ERROR"
        elif lvl in ("WARNING", "WARN") or (not lvl and _EVENT_WARN.search(ev)):
            level = "WARNING"
        else:
            continue
        detail = " ".join(str(j[k]) for k in ("reason", "detail", "error", "message", "symbol") if j.get(k) not in (None, ""))
        add(j.get("timestamp"), level, "nautilus-trader", (ev + " " + detail).strip())
    # container stdout/stderr (docker json-file logs)
    for svc in ("ib-gateway", "portfolio-ui", "nautilus-trader", "watchdog"):
        if svc not in running_services:
            continue
        text = inp.docker_logs(svc, DOCKER_LOG_TAIL)
        for line in (text or "").splitlines():
            ts, _, rest = line.partition(" ")
            if not re.match(r"^\d{4}-\d\d-\d\dT", ts):
                ts, rest = None, line
            if svc == "watchdog" and rest.lstrip().startswith("{"):
                continue  # same JSON stream as watchdog.log, handled above
            if _TEXT_ERROR.search(rest):
                level = "ERROR"
            elif _TEXT_WARN.search(rest):
                level = "WARNING"
            else:
                continue
            rest = re.sub(r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d(\.\d+)? ", "", rest.strip())
            add(ts, level, svc, rest)
    items = sorted(entries.values(), key=lambda e: e["time"] or "", reverse=True)[:MAX_LOG_ENTRIES]
    return {"available": True, "source": "watchdog.log + prototype-runner.log tails (%d KiB) + docker logs --tail %d; WARNING/ERROR only, scrubbed, deduplicated"
            % (LOG_TAIL_BYTES // 1024, DOCKER_LOG_TAIL), "as_of": iso(now), "count": len(items), "items": items,
            "max_items": MAX_LOG_ENTRIES}


# ---------------------------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------------------------
def safe_block(name, fn, *args):
    try:
        return fn(*args)
    except Exception as exc:  # a broken source must never break the whole document
        return unavailable(name, "collector error: %s" % type(exc).__name__)


def find_leaks(text, token=None):
    hits = [p.pattern[:40] for p in LEAK_PATTERNS if p.search(text)]
    if token and len(token) >= 16 and token in text:
        hits.append("status token")
    return hits


def enforce_size(doc):
    order = [("logs", 20), ("fills", 20), ("orders", 50), ("positions", 50), ("logs", 5), ("fills", 5)]
    data = json.dumps(doc, separators=(",", ":"))
    for key, keep in order:
        if len(data.encode()) <= SOFT_MAX_BYTES:
            break
        block = doc.get(key)
        if isinstance(block, dict) and isinstance(block.get("items"), list) and len(block["items"]) > keep:
            block["items"] = block["items"][:keep]
            block["truncated"] = True
            block["count"] = len(block["items"])
            data = json.dumps(doc, separators=(",", ":"))
    for key in ("logs", "fills", "orders", "positions", "session", "risk", "equity"):
        if len(data.encode()) <= HARD_MAX_BYTES:
            break
        doc[key] = unavailable(key, "dropped: document exceeded %d bytes" % HARD_MAX_BYTES)
        data = json.dumps(doc, separators=(",", ":"))
    return data


def build(inp, v2_enabled=True, previous=None):
    """previous: the last status-v2 document (or None); it carries session.state_since forward."""
    t0 = time.time()
    now = inp.now()
    now_iso = now.isoformat(timespec="seconds")
    reads = {s: inp.inspect_status(s) for s in SERVICES}
    raws = {s: reads[s][1] for s in SERVICES}
    services = [service_item(inp, s, raws[s]) for s in SERVICES]
    v1 = {"schema": "vertex-deploy-status-v1", "host": "quantvps", "generatedAt": now_iso, "readOnly": True, "services": services}
    if not v2_enabled:
        return json.dumps(v1), None, []

    running = {s for s in SERVICES if ((raws[s] or {}).get("State") or {}).get("Running")}
    health = load_json_text(inp.read_text(HEALTH_FILE))
    wd, wd_lines = watchdog_summary(inp)
    ibkr_payload, ibkr_error = inp.ibkr_monitor_snapshot()
    account = None
    positions = safe_block("positions", build_positions, now, ibkr_payload, ibkr_error)
    orders = safe_block("orders", build_orders, now, ibkr_payload, ibkr_error)
    fills = safe_block("fills", build_fills, now, ibkr_payload, ibkr_error)
    equity = safe_block("equity", build_equity, now, ibkr_payload, positions, ibkr_error)
    risk = safe_block("risk", build_risk, inp, now, raws["nautilus-trader"], health, wd)
    kill_engaged = risk.get("kill_switch") == "engaged"
    v2 = dict(v1)
    v2["schema"] = "vertex-deploy-status-v2"
    v2.update({
        "session": safe_block("session", build_session, inp, now, raws["nautilus-trader"], health, kill_engaged, account,
                              reads["nautilus-trader"][0], previous),
        "positions": positions,
        "orders": orders,
        "fills": fills,
        "equity": equity,
        "risk": risk,
        "logs": safe_block("logs", collect_logs, inp, now, wd_lines, running),
    })
    v2["collector"] = {"version": COLLECTOR_VERSION, "duration_ms": int((time.time() - t0) * 1000),
                       "soft_max_bytes": SOFT_MAX_BYTES, "hard_max_bytes": HARD_MAX_BYTES}
    v2_text = enforce_size(v2)
    leaks = find_leaks(v2_text, inp.token())
    if leaks:
        # Fail closed: publish only the v1 fields plus an explicit marker, never the suspect blocks.
        for key in ("session", "positions", "orders", "fills", "equity", "risk", "logs"):
            v2[key] = unavailable(key, "withheld: output failed the secret-pattern guard")
        v2_text = json.dumps(v2, separators=(",", ":"))
    return json.dumps(v1), v2_text, leaks


def write_atomic(out_dir, name, text):
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=".status-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(out_dir, name))


def verify_v2_document(v2_text, pub_dir=None, token=None):
    if not v2_text:
        return "empty status-v2 document"
    if len(v2_text.encode("utf-8")) > HARD_MAX_BYTES:
        return "status-v2 document exceeds HARD_MAX_BYTES"
    leaks = find_leaks(v2_text, token)
    if leaks:
        return "status-v2 document tripped secret-pattern guard (%d)" % len(leaks)
    doc = load_json_text(v2_text)
    if not isinstance(doc, dict):
        return "status-v2 document is not valid JSON"
    if doc.get("schema") != "vertex-deploy-status-v2":
        return "unexpected schema: %r" % (doc.get("schema"),)
    version = (doc.get("collector") or {}).get("version")
    if version != COLLECTOR_VERSION:
        return "unexpected collector.version: %r (expected %s)" % (version, COLLECTOR_VERSION)
    for key, prefix in (
        ("positions", "ibkr_tws_api positions via ibkr-monitor.service"),
        ("orders", "ibkr_tws_api open orders via ibkr-monitor.service"),
        ("fills", "ibkr_tws_api executions via ibkr-monitor.service"),
        ("equity", "ibkr_tws_api account summary via ibkr-monitor.service"),
    ):
        blk = doc.get(key)
        if not isinstance(blk, dict) or blk.get("available") is not True:
            reason = blk.get("reason") if isinstance(blk, dict) else "missing block"
            return "%s unavailable: %s" % (key, reason)
        age = blk.get("age_seconds")
        if not isinstance(age, int) or isinstance(age, bool) or age < 0:
            return "%s invalid age_seconds: %r" % (key, age)
        if blk.get("stale") is not False:
            return "%s stale (as_of=%r age_seconds=%r)" % (key, blk.get("as_of"), age)
        if not str(blk.get("source") or "").startswith(prefix):
            return "%s unexpected source: %r" % (key, blk.get("source"))
    if pub_dir is not None:
        if not os.path.isfile(os.path.join(pub_dir, "status.json")):
            return "status.json missing in public dir"
        if os.path.lexists(os.path.join(pub_dir, "status-v2.json")):
            return "status-v2.json leaked into public dir"
    return None


def main(argv):
    out_dir, inp = OUT_DIR, None
    args = list(argv)
    if "--check-v2-dir" in args:
        v2_check_dir = args[args.index("--check-v2-dir") + 1]
        pub_check_dir = args[args.index("--check-public-dir") + 1] if "--check-public-dir" in args else None
        v2_text = LiveInputs().read_text(os.path.join(v2_check_dir, "status-v2.json"), HARD_MAX_BYTES + 1)
        err = verify_v2_document(v2_text, pub_dir=pub_check_dir, token=LiveInputs().token())
        if err:
            sys.stderr.write("v2_check failed: %s\n" % err)
            return 1
        doc = load_json_text(v2_text) or {}
        sys.stdout.write(
            "v2_check ok: version=%s positions_count=%s positions_age=%s orders_count=%s orders_age=%s fills_count=%s fills_age=%s equity_age=%s\n"
            % (
                (doc.get("collector") or {}).get("version"),
                (doc.get("positions") or {}).get("count"),
                (doc.get("positions") or {}).get("age_seconds"),
                (doc.get("orders") or {}).get("count"),
                (doc.get("orders") or {}).get("age_seconds"),
                (doc.get("fills") or {}).get("count"),
                (doc.get("fills") or {}).get("age_seconds"),
                (doc.get("equity") or {}).get("age_seconds"),
            )
        )
        return 0
    if "--fixtures" in args:
        i = args.index("--fixtures")
        now = args[args.index("--now") + 1] if "--now" in args else None
        inp = FixtureInputs(args[i + 1], now)
    if "--out" in args:
        out_dir = args[args.index("--out") + 1]
    ibkr_url = args[args.index("--ibkr-monitor-url") + 1] if "--ibkr-monitor-url" in args else None
    inp = inp or LiveInputs(ibkr_monitor_url=ibkr_url)
    v2_enabled = os.environ.get(V2_ENV, "0").strip() == "1" or "--v2" in args
    v2_dir = args[args.index("--v2-out") + 1] if "--v2-out" in args else os.environ.get(V2_DIR_ENV, "").strip() or PRIVATE_V2_DIR
    if v2_enabled and os.path.realpath(v2_dir) == os.path.realpath(OUT_DIR):
        sys.stderr.write("refusing to write v2 into the public directory %s\n" % OUT_DIR)
        v2_enabled = False
    previous = read_previous(os.path.join(v2_dir, "status-v2.json")) if v2_enabled else None
    v1_text, v2_text, leaks = build(inp, v2_enabled, previous)
    write_atomic(out_dir, "status.json", v1_text)
    public_v2 = os.path.join(out_dir, "status-v2.json")
    if os.path.lexists(public_v2) and os.path.realpath(out_dir) != os.path.realpath(v2_dir):
        os.remove(public_v2)  # never leave an account snapshot in the public directory
    if v2_enabled:
        os.makedirs(v2_dir, mode=0o700, exist_ok=True)
        write_atomic(v2_dir, "status-v2.json", v2_text)
    elif os.path.lexists(os.path.join(v2_dir, "status-v2.json")):
        os.remove(os.path.join(v2_dir, "status-v2.json"))
    if leaks:
        sys.stderr.write("secret-pattern guard tripped (%d patterns); v2 blocks withheld\n" % len(leaks))
    if "--verify-ibkr-monitor" in args:
        err = verify_v2_document(v2_text, pub_dir=out_dir, token=inp.token())
        if err:
            sys.stderr.write("verify-ibkr-monitor failed: %s\n" % err)
            return 1
        doc = load_json_text(v2_text) or {}
        sys.stdout.write(
            "dry_run ok: version=%s positions_count=%s positions_age=%s orders_count=%s orders_age=%s fills_count=%s fills_age=%s equity_age=%s\n"
            % (
                (doc.get("collector") or {}).get("version"),
                (doc.get("positions") or {}).get("count"),
                (doc.get("positions") or {}).get("age_seconds"),
                (doc.get("orders") or {}).get("count"),
                (doc.get("orders") or {}).get("age_seconds"),
                (doc.get("fills") or {}).get("count"),
                (doc.get("fills") or {}).get("age_seconds"),
                (doc.get("equity") or {}).get("age_seconds"),
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
