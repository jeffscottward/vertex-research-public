#!/usr/bin/env python3
"""Vertex read-only deployment status collector (QuantVPS), schema v1 + v2.

Writes two sanitized snapshots every timer cycle:
  status.json     vertex-deploy-status-v1 (unchanged; the default document)
  status-v2.json  vertex-deploy-status-v2 (v1 fields + session/positions/orders/fills/equity/risk/logs)

Read-only by construction: `docker inspect`, `docker logs`, file reads/stat, `redis-cli HGETALL`
and `psql` inside `BEGIN READ ONLY`. Never starts/stops containers, never connects an IBKR API
client, never calls portfolio-ui, never touches kill-switch files. Account numbers are masked to the
last 4 characters, log text is filtered to WARNING/ERROR and scrubbed, output is bounded.
Stdlib only; runs on Python 3.8+.

Test mode: collect.py --fixtures DIR --out DIR [--now ISO]  (reads captured inputs, runs nothing).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time

COLLECTOR_VERSION = "2.1.0"
# v2 (session/account blocks) is built only when VERTEX_STATUS_V2=1 (or --v2). Default OFF: the user's
# condition for publishing account data is token + source-IP allow-list, and no stable source exists yet.
V2_ENV = "VERTEX_STATUS_V2"
V2_DIR_ENV = "VERTEX_STATUS_V2_DIR"
# Non-public directory: served only by the tailnet-bound status site (remote_ip = the rig), never by the
# public vertex-status container (which mounts /opt/vertex-status/public only).
PRIVATE_V2_DIR = "/opt/vertex-status/private-v2"
OUT_DIR = "/opt/vertex-status/public"
STATE_DIR = "/opt/vertex-status/state"
TOKEN_ENV = "/opt/vertex-status/token.env"
PREFIX = "ibkr-nautilus-exec-node-"
SERVICES = ["nautilus-trader", "ib-gateway", "watchdog", "portfolio-ui", "postgres", "redis", "caddy"]
ROOT = "/opt/vertex-exec-node"
DATA = ROOT + "/data"
NAUT = DATA + "/nautilus"
REPORTS = NAUT + "/reports"
LOGS = NAUT + "/logs"
HEALTH_FILE = NAUT + "/health.json"
RUNNER_LOG = LOGS + "/prototype-runner.log"
WATCHDOG_LOG = LOGS + "/watchdog.log"
OPEN_ORDERS_FILE = REPORTS + "/ibkr-open-orders.json"
FILLS_FILE = REPORTS + "/ibkr-fills.json"
SNAPSHOT_PREFIX = "ibkr-account-snapshot-"
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
    "RISK_DENIED_INSTRUMENTS": "list", "NAUTILUS_SAMPLE_ORDERS_ENABLED": "bool",
    "CHARAN_TRADE_INTENTS_ENABLED": "bool", "CHARAN_LIVE_TRANSMIT_ENABLED": "bool",
    "CHARAN_MAX_OPTION_UNIT_NOTIONAL_USD": "num", "SYNTHETIC_STOPS_ENABLED": "bool",
    "SYNTHETIC_STOP_MODE": "str", "SYNTHETIC_STOP_MAX_ORDER_QUANTITY": "num",
    "IBKR_GATEWAY_ENABLED": "bool",
}

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
def parse_time(value):
    if value is None or value == "":
        return None
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
                tz = zoneinfo.ZoneInfo(ib.group(7))
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


def num(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f) if f.is_integer() and abs(f) < 2 ** 53 else round(f, 6)


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


class LiveInputs:
    fixture = False

    def now(self):
        return datetime.datetime.now(datetime.timezone.utc)

    def inspect(self, service):
        code, out, _ = _sh(["docker", "inspect", PREFIX + service + "-1"])
        if code != 0:
            return None
        try:
            return json.loads(out)[0]
        except (ValueError, IndexError):
            return None

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

    def latest_report(self, prefix):
        # Report files embed a UTC timestamp in the name, so the lexical max is the newest one.
        best = None
        try:
            with os.scandir(REPORTS) as it:
                for entry in it:
                    n = entry.name
                    if n.startswith(prefix) and n.endswith(".json") and (best is None or n > best):
                        best = n
        except OSError:
            return None
        return os.path.join(REPORTS, best) if best else None

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

    def inspect(self, service):
        p = self._file("inspect/%s.json" % service)
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)

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

    def latest_report(self, prefix):
        names = [p for p in self.manifest.get("files", {}) if os.path.basename(p).startswith(prefix)]
        return max(names) if names else None

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
    age = int((now - dt).total_seconds())
    return {"as_of": iso(dt), "age_seconds": age, "stale": age > stale_after}


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


def map_session_state(container, health, heartbeat_age, kill_engaged, last_event):
    if container is None:
        return "unknown"
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
    return "unknown"


def build_session(inp, now, nautilus_raw, health, kill_engaged, account):
    redis = inp.redis_hgetall(REDIS_HEARTBEAT_KEY)
    events = runner_events(inp)
    last = events[-1] if events else {}
    last_event = last.get("event")
    hb_candidates = [parse_time((health or {}).get("last_heartbeat_at")), parse_time((redis or {}).get("last_timestamp"))]
    hb_candidates += [parse_time(e.get("timestamp")) for e in events if e.get("event") == "strategy_heartbeat"]
    hb = max([d for d in hb_candidates if d is not None], default=None)
    hb_age = int((now - hb).total_seconds()) if hb else None
    state = map_session_state(nautilus_raw, health, hb_age, kill_engaged, last_event)
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
        "available": nautilus_raw is not None or health is not None,
        "source": "docker inspect nautilus-trader + data/nautilus/health.json + redis heartbeat + prototype-runner.log + " + strategy_source,
        "as_of": iso(now),
        "state": state,
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


def build_positions(inp, now, snapshot, snapshot_path):
    if snapshot is None:
        return unavailable("ibkr-account-snapshot report file", "no readable account snapshot report")
    items = []
    for p in (snapshot.get("positions") or [])[:MAX_POSITIONS]:
        c = p.get("contract") or {}
        qty = num(p.get("quantity"))
        mult = num(c.get("multiplier")) or 1
        avg_cost = num(p.get("average_cost"))
        item = {"symbol": scrub(p.get("symbol") or c.get("symbol"), 24), "sec_type": scrub(p.get("sec_type") or c.get("secType"), 8),
                "qty": qty, "avg_px": (round(avg_cost / mult, 6) if avg_cost is not None and mult else avg_cost),
                "avg_cost": avg_cost, "multiplier": mult if mult != 1 else None,
                "market_price": num(p.get("market_price")), "market_value": num(p.get("market_value")),
                "unrealized_pnl": num(p.get("unrealized_pnl")), "realized_pnl": num(p.get("realized_pnl")),
                "currency": scrub(p.get("currency") or c.get("currency"), 8) or None}
        if (c.get("secType") or p.get("sec_type")) in ("OPT", "FOP"):
            item["right"] = scrub(c.get("right"), 4)
            item["strike"] = num(c.get("strike"))
            item["expiry"] = scrub(c.get("lastTradeDateOrContractMonth"), 12)
        items.append(item)
    as_of = snapshot.get("generated_at") or snapshot.get("captured_at_epoch")
    return {"available": True, "source": "ibkr_tws_api via " + os.path.basename(snapshot_path) + " (written by portfolio-ui snapshot refresh)",
            **freshness(now, as_of, REPORT_STALE_SECONDS), "count": len(items), "items": items,
            "truncated": len(snapshot.get("positions") or []) > MAX_POSITIONS}


def build_equity(now, snapshot, snapshot_path, positions):
    if snapshot is None:
        return unavailable("ibkr-account-snapshot report file", "no readable account snapshot report")
    summary = snapshot.get("summary") or {}

    def pick(tag):
        v = summary.get(tag)
        if isinstance(v, dict):
            for cur in ("USD", "BASE"):
                if cur in v:
                    return num(v[cur])
            return num(next(iter(v.values()), None))
        return num(v)
    items = positions.get("items", []) if positions.get("available") else []
    unreal = [i["unrealized_pnl"] for i in items if isinstance(i.get("unrealized_pnl"), (int, float))]
    real = [i["realized_pnl"] for i in items if isinstance(i.get("realized_pnl"), (int, float))]
    as_of = snapshot.get("generated_at") or snapshot.get("captured_at_epoch")
    return {"available": True, "source": "ibkr_tws_api account summary via " + os.path.basename(snapshot_path),
            **freshness(now, as_of, REPORT_STALE_SECONDS), "currency": "USD",
            "net_liq": pick("NetLiquidation"), "cash": pick("TotalCashValue"),
            "available_funds": pick("AvailableFunds") if pick("AvailableFunds") is not None else num(snapshot.get("available_funds_usd")),
            "buying_power": pick("BuyingPower"),
            "unrealized": round(sum(unreal), 2) if unreal else None, "realized": round(sum(real), 2) if real else None}


STOP_TYPES = ("STP", "STP LMT", "TRAIL", "TRAIL LIMIT", "STP PRT")


def build_orders(inp, now):
    payload = load_json_text(inp.read_text(OPEN_ORDERS_FILE))
    if payload is None:
        return unavailable("data/nautilus/reports/ibkr-open-orders.json", "open-orders report missing or unreadable")
    items = []
    for o in (payload.get("orders") or [])[:MAX_ORDERS]:
        c = o.get("contract") or {}
        otype = str(o.get("order_type") or "").upper()
        aux = num(o.get("aux_price"))
        lmt = num(o.get("limit_price"))
        item = {"order_id_masked": mask_id(o.get("order_id")), "client_id": num(o.get("client_id")),
                "symbol": scrub(o.get("symbol") or c.get("symbol"), 24), "sec_type": scrub(o.get("sec_type") or c.get("sec_type"), 8),
                "side": scrub(o.get("action"), 8).lower() or None, "type": scrub(otype, 16) or None,
                "qty": num(o.get("total_quantity")), "filled": num(o.get("filled")), "remaining": num(o.get("remaining")),
                "price": lmt if lmt else None, "stop": aux if (aux and otype in STOP_TYPES) else None,
                "aux_price": aux if (aux and otype not in STOP_TYPES) else None,
                "tif": scrub(o.get("tif"), 8) or None, "status": scrub(o.get("status"), 24) or None,
                "currency": scrub(o.get("currency") or c.get("currency"), 8) or None}
        if o.get("warning_text"):
            item["warning"] = scrub(o.get("warning_text"), 160)
        items.append(item)
    return {"available": True, "source": "ibkr_tws_api open orders via data/nautilus/reports/ibkr-open-orders.json (read from disk; no API call)",
            **freshness(now, payload.get("generated_at") or payload.get("captured_at_epoch"), REPORT_STALE_SECONDS),
            "count": len(items), "items": items, "truncated": len(payload.get("orders") or []) > MAX_ORDERS}


def build_fills(inp, now):
    payload = load_json_text(inp.read_text(FILLS_FILE))
    if payload is None:
        return unavailable("data/nautilus/reports/ibkr-fills.json", "fills report missing or unreadable")
    rows = []
    for e in payload.get("executions") or []:
        side = str(e.get("side") or "").upper()
        rows.append({"time": iso(e.get("time")) or scrub(e.get("time"), 32), "symbol": scrub(e.get("symbol"), 24),
                     "side": {"BOT": "buy", "SLD": "sell", "BUY": "buy", "SELL": "sell"}.get(side, scrub(side, 8).lower() or None),
                     "qty": num(e.get("shares") if e.get("shares") is not None else e.get("qty")), "price": num(e.get("price")),
                     "order_id_masked": mask_id(e.get("order_id")), "exec_id_masked": mask_id(e.get("exec_id"))})
    rows.sort(key=lambda r: str(r.get("time") or ""), reverse=True)
    return {"available": True, "source": "ibkr_tws_api executions via data/nautilus/reports/ibkr-fills.json (written by scripts/ibkr_fill_check.py)",
            **freshness(now, payload.get("generated_at"), REPORT_STALE_SECONDS), "count": len(rows[:MAX_FILLS]),
            "items": rows[:MAX_FILLS], "truncated": len(rows) > MAX_FILLS}


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
        kill = "unknown"
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
                    "live_flags": {scrub(k, 40): (v if isinstance(v, bool) else scrub(v, 24)) for k, v in (summary.get("live_flags") or {}).items()},
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


def build(inp, v2_enabled=True):
    t0 = time.time()
    now = inp.now()
    now_iso = now.isoformat(timespec="seconds")
    raws = {s: inp.inspect(s) for s in SERVICES}
    services = [service_item(inp, s, raws[s]) for s in SERVICES]
    v1 = {"schema": "vertex-deploy-status-v1", "host": "quantvps", "generatedAt": now_iso, "readOnly": True, "services": services}
    if not v2_enabled:
        return json.dumps(v1), None, []

    running = {s for s in SERVICES if ((raws[s] or {}).get("State") or {}).get("Running")}
    health = load_json_text(inp.read_text(HEALTH_FILE))
    wd, wd_lines = watchdog_summary(inp)
    snapshot_path = inp.latest_report(SNAPSHOT_PREFIX)
    snapshot = load_json_text(inp.read_text(snapshot_path)) if snapshot_path else None
    account = mask_account((snapshot or {}).get("account_masked"))
    orders = safe_block("orders", build_orders, inp, now)
    if account is None and orders.get("available"):
        account = mask_account((load_json_text(inp.read_text(OPEN_ORDERS_FILE)) or {}).get("account_masked"))
    risk = safe_block("risk", build_risk, inp, now, raws["nautilus-trader"], health, wd)
    kill_engaged = risk.get("kill_switch") == "engaged"
    positions = safe_block("positions", build_positions, inp, now, snapshot, snapshot_path or "")
    v2 = dict(v1)
    v2["schema"] = "vertex-deploy-status-v2"
    v2.update({
        "session": safe_block("session", build_session, inp, now, raws["nautilus-trader"], health, kill_engaged, account),
        "positions": positions,
        "orders": orders,
        "fills": safe_block("fills", build_fills, inp, now),
        "equity": safe_block("equity", build_equity, now, snapshot, snapshot_path or "", positions),
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


def main(argv):
    out_dir, inp = OUT_DIR, None
    args = list(argv)
    if "--fixtures" in args:
        i = args.index("--fixtures")
        now = args[args.index("--now") + 1] if "--now" in args else None
        inp = FixtureInputs(args[i + 1], now)
    if "--out" in args:
        out_dir = args[args.index("--out") + 1]
    inp = inp or LiveInputs()
    v2_enabled = os.environ.get(V2_ENV, "0").strip() == "1" or "--v2" in args
    v2_dir = args[args.index("--v2-out") + 1] if "--v2-out" in args else os.environ.get(V2_DIR_ENV, "").strip() or PRIVATE_V2_DIR
    if v2_enabled and os.path.realpath(v2_dir) == os.path.realpath(OUT_DIR):
        sys.stderr.write("refusing to write v2 into the public directory %s\n" % OUT_DIR)
        v2_enabled = False
    v1_text, v2_text, leaks = build(inp, v2_enabled)
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
