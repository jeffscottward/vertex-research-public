#!/usr/bin/env python3
"""Tests for the IBKR recovery service. Run: python3 infra/quant-vps/recovery/test_vertex_ibkr_recovery.py

No docker, no real script, no network beyond a loopback test server. Docker calls, the script start, the clock
and the portfolio health fetch are fakes.
"""
import ast
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vertex_ibkr_recovery as vr  # noqa: E402

SOURCE_PATH = os.path.join(HERE, "vertex_ibkr_recovery.py")
with open(SOURCE_PATH) as _f:
    SOURCE = _f.read()

TOKEN = "r" * 64
STATUS_TOKEN = "s" * 40
CID = "0123456789abcdef0123"
T0 = vr.parse_ts("2026-10-26T20:00:00Z")
STATEMENT = "I request IBKR recovery only; this does not authorize trading."
EXPECTED_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "IBKR_2FA_NOTIFY_ENABLED": "0",
    "IBKR_2FA_MAX_ATTEMPTS": "1",
    "IBKR_2FA_APPROVAL_TIMEOUT_SECONDS": "180",
    "IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT": "0",
    "IBKR_2FA_VERIFY_API_HANDSHAKE": "0",
}

# Real IBC message texts.
MSG = {
    "login-started": "Login dialog WINDOW_OPENED: LoginState is LOGGED_OUT",
    "2fa-started": "Second Factor Authentication initiated",
    "logged-in": "Login has completed",
    "2fa-timeout": "Re-login after second factor authentication timeout not required",
    "session-ended": "End this session and let the other session proceed",
}


def rfc(ts, nanos="123456789"):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + "." + nanos + "Z"


def ibc(ts, msg):
    """One `docker logs --timestamps` line as IBC writes it."""
    local = datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return "%s %s:123 IBC: %s" % (rfc(ts), local, msg)


class FakeClock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class FakeDocker:
    """Answers the three read-only docker commands; records every argv."""

    def __init__(self, clock, running=True, started=None, lines=None):
        self.clock = clock
        self.rows = ["%s %s" % (CID, "running" if running else "exited")]
        self.running = running
        self.started = T0 - 3600 if started is None else started
        self.lines = list(lines or [])
        self.calls = []
        self.fail = False
        self.too_large = set()   # --since values that answer "too large"

    def __call__(self, argv, timeout, max_bytes=None):
        self.calls.append(list(argv))
        if self.fail:
            raise vr.DockerError("down")
        verb = argv[1]
        if verb == "ps":
            return "\n".join(self.rows) + ("\n" if self.rows else "")
        if verb == "inspect":
            return json.dumps({"Status": "running" if self.running else "exited", "Running": self.running,
                               "StartedAt": rfc(self.started)})
        if verb == "logs":
            self.assert_logs_argv(argv)
            since = argv[argv.index("--since") + 1]
            if since in self.too_large:
                raise vr.LogTooLarge("too large")
            key = vr.ts_key(since)
            # docker logs --since is inclusive
            return "".join(line + "\n" for line in self.lines if vr.ts_key(line.split(" ", 1)[0]) >= key)
        raise AssertionError("unexpected docker verb " + verb)

    @staticmethod
    def assert_logs_argv(argv):
        assert argv[:4] == [vr.DOCKER, "logs", "--timestamps", "--since"] and len(argv) == 6, argv
        assert "--tail" not in argv, argv

    def add(self, ts, event):
        self.lines.append(ibc(ts, MSG[event]))

    def noise(self, start, count, step=1):
        for i in range(count):
            ts = start + i * step
            stamp = rfc(ts, "%09d" % i)
            self.lines.append("%s 2026-10-26 20:00:00:000 INFO [JTS-EServerSocket] java noise %d" % (stamp, i))


class FakeProc:
    def __init__(self):
        self.code = None

    def poll(self):
        return self.code


class FakeSpawn:
    def __init__(self, fail=False):
        self.calls = []
        self.procs = []
        self.fail = fail
        self.path = None

    def __call__(self, log_path, env):
        self.calls.append((log_path, env))
        if self.fail:
            raise FileNotFoundError(2, "No such file")
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.close(fd)
        self.path = log_path
        p = FakeProc()
        self.procs.append(p)
        return p

    def write(self, text):
        with open(self.path, "a") as f:
            f.write(text)


class Rig:
    """A Recovery service wired to fakes."""

    def __init__(self, tmp, lines=None, running=True, started=None, health=None, env_check=None, spawn=None,
                 clock=None):
        self.clock = clock or FakeClock()
        self.docker = FakeDocker(self.clock, running=running, started=started, lines=lines)
        self.gateway = vr.GatewayCache(vr.GatewayReader(self.docker, self.clock).read, self.clock)
        self.spawn = spawn or FakeSpawn()
        self.health = health if health is not None else {"value": None}
        self.logs = []
        self.tmp = tmp
        self.svc = self._make(env_check)

    def _make(self, env_check=None):
        return vr.Recovery(self.tmp, self.gateway, clock=self.clock, spawn=self.spawn,
                           fetch_health=lambda: self.health["value"], env_check=env_check or (lambda: []),
                           log=self.log)

    def restart(self):
        self.svc = self._make()
        return self.svc

    def log(self, event, **kw):
        self.logs.append(dict(event=event, **kw))

    def post(self, rid="req-00000001", dry=False, actor="operator_1"):
        return self.svc.request({"requestId": rid, "actorId": actor, "statement": STATEMENT, "dryRun": dry})

    def logged_out(self):
        self.docker.add(self.clock.t - 400, "2fa-timeout")


def logged_out_lines(clock):
    return [ibc(clock.t - 900, MSG["login-started"]), ibc(clock.t - 800, MSG["2fa-started"]),
            ibc(clock.t - 600, MSG["2fa-timeout"])]


# ---------------------------------------------------------------------------------------------------------
# Static safety scan

ALLOWED_IMPORTS = {"collections", "hmac", "json", "math", "os", "re", "subprocess", "sys", "tempfile", "threading",
                   "time", "urllib.request", "datetime", "http.server", "urllib.parse"}
ALLOWED_SUBPROCESS_ATTRS = {"run", "Popen", "DEVNULL", "PIPE", "STDOUT", "SubprocessError", "TimeoutExpired"}
FORBIDDEN_ATTR_RE = re.compile(r"^(system|popen|exec\w*|spawn\w*|fork\w*|posix_spawn\w*|kill\w*|terminate|"
                               r"send_signal|getoutput|getstatusoutput|check_output|check_call|call)$")
FORBIDDEN_NAMES = {"eval", "exec", "compile", "__import__"}
FORBIDDEN_TEXT = ("nautilus", "placeorder", "cancelorder", "reqglobalcancel", "compose up", "compose restart",
                  "compose down", "compose stop", "compose exec", "docker exec", "docker compose", "kill_switch")
OTHER_DOCKER_VERBS = {"exec", "restart", "stop", "kill", "rm", "start", "run", "compose", "up", "down", "pause",
                      "update", "create", "cp", "commit", "attach", "rename", "network", "volume", "system"}
# The Nautilus arm switch (owner decision 2026-10-30) is the one place that may name the node and use exec.
# Only these exact string constants may contain a forbidden text; any other string still fails the scan.
ALLOWED_NODE_STRINGS = {
    "label=com.docker.compose.service=nautilus-trader", "nautilus.arm_cli",
    "I arm the Nautilus node; it may submit live orders.", "vertex-nautilus-arm-status-v1",
    "vertex-nautilus-arm-result-v1", "nautilus-arm-status-v1", "nautilus-arm-error-v1",
    "/nautilus/status", "/nautilus/arm", "/nautilus/disarm", "kill_switch_active",
}
EXEC_FUNCTION = "nautilus_exec_argv"
EXEC_PREFIX = ["exec", None, "python", "-m", "nautilus.arm_cli"]  # None: the container id variable


def docstring_ids(tree):
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                    and isinstance(first.value.value, str):
                ids.add(id(first.value))
    return ids


def scan(source):
    """Returns a list of safety problems in the given module source."""
    tree = ast.parse(source)
    problems = []
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def enclosing_function(node):
        while node in parents:
            node = parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return node.name
        return None

    docs = docstring_ids(tree)
    subprocess_calls = []
    docker_lists = set()
    exec_lists = []
    exec_strings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_IMPORTS:
                    problems.append("import " + alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module not in ALLOWED_IMPORTS:
                problems.append("from-import " + str(node.module))
        elif isinstance(node, ast.Attribute):
            if FORBIDDEN_ATTR_RE.match(node.attr):
                problems.append("attribute " + node.attr)
            if isinstance(node.value, ast.Name) and node.value.id == "subprocess" \
                    and node.attr not in ALLOWED_SUBPROCESS_ATTRS:
                problems.append("subprocess." + node.attr)
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            problems.append("name " + node.id)
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "subprocess":
                subprocess_calls.append((f.attr, enclosing_function(node), node))
        elif isinstance(node, ast.List) and node.elts and isinstance(node.elts[0], ast.Name) \
                and node.elts[0].id == "DOCKER":
            docker_lists.add(id(node.elts[0]))
            verb = node.elts[1] if len(node.elts) > 1 else None
            if isinstance(verb, ast.Constant) and verb.value == "exec":
                exec_lists.append((enclosing_function(node), node))
            elif not (isinstance(verb, ast.Constant) and verb.value in ("ps", "inspect", "logs")):
                problems.append("docker verb " + ast.dump(verb) if verb else "docker without verb")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
            low = node.value.lower()
            if node.value not in ALLOWED_NODE_STRINGS:
                for text in FORBIDDEN_TEXT:
                    if text in low:
                        problems.append("string " + text)
            if node.value in OTHER_DOCKER_VERBS:
                exec_strings.append(node)
    # "exec" may appear exactly once: as the verb of the one fixed list in nautilus_exec_argv.
    if len(exec_lists) > 1:
        problems.append("more than one docker exec list")
    allowed_exec = set()
    for fn, lst in exec_lists:
        tail = lst.elts[1:]
        shape = [None if isinstance(e, ast.Name) else (e.value if isinstance(e, ast.Constant) else "?")
                 for e in tail]
        parent = parents.get(lst)
        joined = isinstance(parent, ast.BinOp) and isinstance(parent.op, ast.Add) and parent.left is lst \
            and isinstance(parent.right, ast.Call) and isinstance(parent.right.func, ast.Name) \
            and parent.right.func.id == "list"
        if fn != EXEC_FUNCTION or shape != EXEC_PREFIX or not joined:
            problems.append("docker exec list outside the fixed arm CLI form")
        else:
            allowed_exec.add(id(tail[0]))
    for node in exec_strings:
        if id(node) not in allowed_exec:
            problems.append("verb-like string " + node.value)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == "DOCKER" and isinstance(node.ctx, ast.Load) \
                and id(node) not in docker_lists and enclosing_function(node) != "docker_run":
            problems.append("DOCKER used outside a fixed argv list")
    kinds = sorted((attr, fn) for attr, fn, _ in subprocess_calls)
    if kinds != [("Popen", "spawn_script"), ("run", "docker_run"), ("run", "nautilus_cli_run")]:
        problems.append("subprocess calls %r" % (kinds,))
    for fn_node in ast.walk(tree):
        if isinstance(fn_node, ast.FunctionDef) and fn_node.name == "nautilus_cli_run":
            body = [s for s in fn_node.body if id(getattr(s, "value", None)) not in docs]
            first = body[0] if body else None
            guarded = isinstance(first, ast.If) and isinstance(first.test, ast.UnaryOp) \
                and isinstance(first.test.op, ast.Not) and isinstance(first.test.operand, ast.Call) \
                and isinstance(first.test.operand.func, ast.Name) and first.test.operand.func.id == "is_nautilus_exec" \
                and isinstance(first.body[0], ast.Raise)
            if not guarded:
                problems.append("nautilus_cli_run does not check is_nautilus_exec first")
    for attr, fn, call in subprocess_calls:
        if fn == "nautilus_cli_run" and not (call.args and isinstance(call.args[0], ast.Name)
                                             and call.args[0].id == "argv"):
            problems.append("nautilus_cli_run runs something other than its checked argv")
    for attr, fn, call in subprocess_calls:
        kw = {k.arg: k.value for k in call.keywords}
        if not (isinstance(kw.get("shell"), ast.Constant) and kw["shell"].value is False):
            problems.append("shell not False in " + str(fn))
        if attr == "Popen":
            first = call.args[0] if call.args else None
            ok = isinstance(first, ast.Call) and isinstance(first.func, ast.Name) and first.func.id == "list" \
                and len(first.args) == 1 and isinstance(first.args[0], ast.Name) \
                and first.args[0].id == "SCRIPT_ARGV"
            if not ok:
                problems.append("Popen argv is not list(SCRIPT_ARGV)")
            if not (isinstance(kw.get("cwd"), ast.Name) and kw["cwd"].id == "SCRIPT_CWD"):
                problems.append("Popen cwd is not SCRIPT_CWD")
    return problems


class SafetyScanTest(unittest.TestCase):
    def test_module_passes_scan(self):
        self.assertEqual(scan(SOURCE), [])

    def test_scan_detects_probes(self):
        base = SOURCE
        probes = [
            "\nimport os\ndef x():\n    os.system('id')\n",
            "\ndef x():\n    subprocess.call(['id'], shell=False)\n",
            "\ndef x():\n    subprocess.Popen(['id'], shell=False)\n",
            "\ndef x():\n    return [DOCKER, 'restart', 'ib-gateway']\n",
            "\ndef x():\n    return [DOCKER, 'exec', 'c', 'sh']\n",
            "\nX = 'docker compose up -d " + "nau" + "tilus-trader'\n",
            "\nX = 'place" + "Order'\n",
            "\ndef x(p):\n    p.kill()\n",
            "\ndef x():\n    return eval('1')\n",
            "\nimport ctypes\n",
            "\ndef x():\n    a = DOCKER\n    return [a, 'ps']\n",
        ]
        for probe in probes:
            self.assertTrue(scan(base + probe), probe)

    def test_scan_allows_only_the_one_exec_form(self):
        exec_line = '[DOCKER, "exec", cid, "python", "-m", "nautilus.arm_cli"] + list(command)'
        guard = "if not is_nautilus_exec(argv):"
        run_call = "subprocess.run(argv, shell=False, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL"
        for needle in (exec_line, guard, run_call):
            self.assertEqual(SOURCE.count(needle), 1, needle)
        mutations = [
            (exec_line, '[DOCKER, "exec", cid, "sh", "-c", "nautilus.arm_cli"] + list(command)'),
            (exec_line, '[DOCKER, "exec", "--privileged", cid, "python", "-m", "nautilus.arm_cli"] + list(command)'),
            (exec_line, '[DOCKER, "exec", cid, "python", "-m", "nautilus.arm_cli", "x"] + list(command)'),
            (exec_line, '[DOCKER, "exec", cid, "python", "-m", "nautilus.arm_cli"] + command'),
            (exec_line, '[DOCKER, "exec", cid, "python", "-m", "nautilus.cli"] + list(command)'),
            (guard, "if not argv:"),
            (run_call, run_call.replace("run(argv,", "run(list(argv),")),
            (run_call, run_call.replace("shell=False", "shell=True")),
        ]
        for old, new in mutations:
            self.assertTrue(scan(SOURCE.replace(old, new)), new)
        extra = [
            "\ndef x(cid):\n    return [DOCKER, 'exec', cid, 'python', '-m', 'nautilus.arm_cli'] + list([])\n",
            "\ndef nautilus_exec_argv2(cid):\n    return [DOCKER, 'exec', cid]\n",
            "\nX = 'nautilus-trader'\n",
            "\nX = 'docker exec x'\n",
            "\nX = 'kill_switch'\n",
            "\nX = 'exec'\n",
            "\ndef x():\n    subprocess.run(['id'], shell=False)\n",
        ]
        for probe in extra:
            self.assertTrue(scan(SOURCE + probe), probe)

    def test_fixed_identity(self):
        self.assertEqual((vr.LISTEN_HOST, vr.LISTEN_PORT, vr.VERSION), ("127.0.0.1", 8793, "1.1.0"))
        self.assertEqual(vr.SCRIPT_ARGV, ("/opt/vertex-exec-node/scripts/request-ibkr-2fa-until-ready.sh",))
        self.assertEqual(vr.SCRIPT_CWD, "/opt/vertex-exec-node")
        self.assertEqual(vr.COOLDOWN_SECONDS, 900)
        self.assertEqual(vr.STATEMENT, STATEMENT)
        self.assertEqual(vr.DOCKER_VERBS, ("ps", "inspect", "logs"))

    def test_script_env_is_fixed(self):
        hostile = {"PATH": "/tmp/evil", "VERTEX_RECOVERY_TOKEN": TOKEN, "VERTEX_STATUS_TOKEN": STATUS_TOKEN,
                   "IBKR_2FA_TEST_MODE": "1", "IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT": "1", "LD_PRELOAD": "x",
                   "IBKR_RECOVERY_SNAPSHOT_CLIENT_ID": "97", "IBKR_2FA_VERIFY_CLIENT_ID": "97"}
        with mock.patch.dict(vr.os.environ, hostile):
            self.assertEqual(vr.script_env(), EXPECTED_ENV)
        # No extra IB client id: the script opens no IB API session with both VERIFY_* at 0.
        self.assertNotIn("IBKR_RECOVERY_SNAPSHOT_CLIENT_ID", SOURCE)
        self.assertFalse(hasattr(vr, "CLIENT_ID_SOURCE") or hasattr(vr, "CLIENT_ID_TARGET"))
        env = vr.script_env()
        env["X"] = "1"
        self.assertEqual(vr.script_env(), EXPECTED_ENV)  # a fresh copy every time

    def test_spawn_script_fixed_argv(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        log_path = os.path.join(tmp, "req-00000001.log")
        with mock.patch.object(vr.subprocess, "Popen") as popen:
            popen.return_value = "proc"
            env = vr.script_env()
            self.assertEqual(vr.spawn_script(log_path, env), "proc")
        self.assertEqual(popen.call_count, 1)
        args, kw = popen.call_args
        self.assertEqual(args, (["/opt/vertex-exec-node/scripts/request-ibkr-2fa-until-ready.sh"],))
        self.assertEqual(kw["cwd"], "/opt/vertex-exec-node")
        self.assertIs(kw["shell"], False)
        self.assertEqual(kw["env"], EXPECTED_ENV)
        self.assertEqual(kw["stderr"], vr.subprocess.STDOUT)
        self.assertEqual(kw["stdin"], vr.subprocess.DEVNULL)
        self.assertIsInstance(kw["stdout"], int)
        self.assertEqual(stat.S_IMODE(os.stat(log_path).st_mode), 0o600)

    def test_docker_run_refuses_other_verbs(self):
        with mock.patch.object(vr.subprocess, "run") as run:
            for argv in ([vr.DOCKER, "exec", CID, "sh"], [vr.DOCKER, "restart", CID], [vr.DOCKER, "compose", "up"],
                         [vr.DOCKER, "rm", CID], ["/bin/sh", "ps"], [vr.DOCKER], (vr.DOCKER, "ps"), "docker ps"):
                with self.assertRaises(vr.DockerError):
                    vr.docker_run(argv, 5)
            run.assert_not_called()

    def test_docker_run_fixed_call(self):
        def writes(data, code=0):
            def run(argv, **kw):
                kw["stdout"].write(data)
                kw["stdout"].flush()
                return mock.Mock(returncode=code)
            return run

        with mock.patch.object(vr.subprocess, "run") as run:
            run.side_effect = writes(b"abc\n")
            self.assertEqual(vr.docker_run(vr.ps_argv(), 5), "abc\n")
            args, kw = run.call_args
            self.assertEqual(args[0], ["/usr/bin/docker", "ps", "-a", "--filter",
                                       "label=com.docker.compose.service=ib-gateway", "--format", "{{.ID}} {{.State}}"])
            self.assertIs(kw["shell"], False)
            self.assertEqual(kw["env"], {"PATH": EXPECTED_ENV["PATH"], "HOME": "/root", "LANG": "C.UTF-8"})
            self.assertEqual(kw["stderr"], vr.subprocess.DEVNULL)
            run.side_effect = writes(b"", code=1)
            with self.assertRaises(vr.DockerError):
                vr.docker_run(vr.inspect_argv(CID), 5)
            run.side_effect = writes(b"x" * 101)
            self.assertEqual(len(vr.docker_run(vr.logs_argv(CID, rfc(T0)), 5, max_bytes=101)), 101)
            self.assertEqual(run.call_args[1]["stderr"], vr.subprocess.STDOUT)
            with self.assertRaises(vr.LogTooLarge):
                vr.docker_run(vr.logs_argv(CID, rfc(T0)), 5, max_bytes=100)
            run.side_effect = vr.subprocess.TimeoutExpired(["docker"], 20)
            with self.assertRaises(vr.DockerTimeout):
                vr.docker_run(vr.logs_argv(CID, rfc(T0)), 20, max_bytes=100)
        self.assertEqual(vr.logs_argv(CID, "S"), ["/usr/bin/docker", "logs", "--timestamps", "--since", "S", CID])


# ---------------------------------------------------------------------------------------------------------
# Gateway login state

class EventParseTest(unittest.TestCase):
    def test_real_ibc_lines(self):
        cases = {
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Login has completed": "logged-in",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Login has already completed": "logged-in",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Second Factor Authentication initiated":
                "2fa-started",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: detected dialog entitled: Second Factor "
            "Authentication; event=Opened": "2fa-started",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Re-login after second factor "
            "authentication timeout not required": "2fa-timeout",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: IBC closing because login has not "
            "completed after Second Factor Authentication": "2fa-timeout",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Login dialog WINDOW_OPENED: LoginState "
            "is LOGGED_OUT": "login-started",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Starting session: will exit if login "
            "dialog is not displayed within 60 seconds": "login-started",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: IBC will restart shortly": "login-started",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: detected dialog entitled: Restart in "
            "progress; event=Opened": "login-started",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: End this session and let the other "
            "session proceed": "session-ended",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Other session must be primary":
                "session-ended",
            "2026-10-26T20:05:40.123456789Z 2026-10-26 20:05:40:123 IBC: Other session may be primary, so end "
            "this session": "session-ended",
        }
        for line, event in cases.items():
            events = vr.parse_events(line)
            self.assertEqual([e[1] for e in events], [event], line)
            self.assertAlmostEqual(events[0][0], vr.parse_ts("2026-10-26T20:05:40Z") + 0.123456789, places=5)

    def test_ignored_lines(self):
        text = "\n".join([
            "2026-10-26T20:05:40.1Z Login has completed",            # no IBC: prefix
            "garbage IBC: Login has completed",                       # no timestamp
            "2026-10-26T20:05:40.1Z 2026-10-26 20:05:40:123 IBC: Getting config dialog",
            "",
        ])
        self.assertEqual(vr.parse_events(text), [])

    def test_events_sorted_across_streams(self):
        text = "\n".join([ibc(T0 + 10, MSG["logged-in"]), ibc(T0, MSG["2fa-started"])])
        self.assertEqual([e[1] for e in vr.parse_events(text)], ["2fa-started", "logged-in"])

    def test_parse_ts(self):
        self.assertEqual(vr.parse_ts("2026-10-26T20:00:00Z"), T0)
        self.assertEqual(vr.parse_ts("2026-10-26T22:00:00+02:00"), T0)
        self.assertIsNone(vr.parse_ts("0001-01-01T00:00:00Z"))
        self.assertIsNone(vr.parse_ts("yesterday"))
        self.assertIsNone(vr.parse_ts(None))


class ClassifyTest(unittest.TestCase):
    def view(self, lines=(), running=True, started=T0 - 3600, now=T0, rows=None, fail=False):
        clock = FakeClock(now)
        d = FakeDocker(clock, running=running, started=started, lines=list(lines))
        if rows is not None:
            d.rows = rows
        d.fail = fail
        return vr.GatewayReader(d, clock).read(), d

    def check(self, view, state, needs, reason, since):
        self.assertEqual(view.public(), {"loginState": state, "needsLogin": needs, "reason": reason,
                                         "since": vr.iso(since) if since is not None else None})

    def test_table(self):
        n = T0
        self.check(self.view([ibc(n - 50, MSG["logged-in"])])[0], "logged-in", False, "logged-in", n - 50)
        self.check(self.view([ibc(n - 239, MSG["2fa-started"])])[0], "awaiting-2fa", False, "2fa-started", n - 239)
        self.check(self.view([ibc(n - 240, MSG["2fa-started"])])[0], "awaiting-2fa", False, "2fa-started", n - 240)
        self.check(self.view([ibc(n - 241, MSG["2fa-started"])])[0], "logged-out", True, "2fa-started", n - 241)
        self.check(self.view([ibc(n - 299, MSG["login-started"])])[0], "starting", False, "login-started", n - 299)
        self.check(self.view([ibc(n - 301, MSG["login-started"])])[0], "logged-out", True, "login-started", n - 301)
        self.check(self.view([ibc(n - 3000, MSG["2fa-timeout"])])[0], "logged-out", True, "2fa-timeout", n - 3000)
        self.check(self.view([ibc(n - 5, MSG["session-ended"])])[0], "logged-out", True, "session-ended", n - 5)
        self.check(self.view([], started=n - 60)[0], "starting", False, "no-login-event", n - 60)
        self.check(self.view([], started=n - 121)[0], "unknown", False, "no-login-event", None)
        self.check(self.view(running=False, started=n - 500)[0], "stopped", True, "container-not-running", n - 500)
        self.check(self.view(rows=[])[0], "stopped", True, "container-not-running", None)
        self.check(self.view(fail=True)[0], "unknown", False, "docker-error", None)
        self.check(self.view(rows=["%s running" % CID, "%s running" % CID.replace("0", "1")])[0],
                   "unknown", False, "docker-error", None)
        self.check(self.view(rows=["not-an-id running"])[0], "unknown", False, "docker-error", None)

    def test_last_event_wins(self):
        n = T0
        lines = [ibc(n - 100, MSG["logged-in"]), ibc(n - 90, MSG["login-started"]), ibc(n - 80, MSG["2fa-started"])]
        self.check(self.view(lines)[0], "awaiting-2fa", False, "2fa-started", n - 80)
        lines.append(ibc(n - 10, MSG["logged-in"]))
        self.check(self.view(lines)[0], "logged-in", False, "logged-in", n - 10)

    def test_needs_login_map(self):
        self.assertEqual(sorted(vr.NEEDS_LOGIN), sorted(vr.LOGIN_STATES))
        self.assertEqual({k for k, v in vr.NEEDS_LOGIN.items() if v}, {"stopped", "logged-out"})

    def test_docker_argv(self):
        view, d = self.view([ibc(T0 - 50, MSG["logged-in"])])
        started = rfc(T0 - 3600)
        self.assertEqual(d.calls, [
            ["/usr/bin/docker", "ps", "-a", "--filter", "label=com.docker.compose.service=ib-gateway",
             "--format", "{{.ID}} {{.State}}"],
            ["/usr/bin/docker", "inspect", "--format", "{{json .State}}", CID],
            ["/usr/bin/docker", "logs", "--timestamps", "--since", started, CID],
        ])
        _, d = self.view(running=False)
        self.assertEqual([c[1] for c in d.calls], ["ps", "inspect"])

    def test_picks_running_container(self):
        old = CID.replace("0", "2")
        view, d = self.view([ibc(T0 - 50, MSG["logged-in"])], rows=["%s exited" % old, "%s running" % CID])
        self.assertEqual(view.login_state, "logged-in")
        self.assertEqual(d.calls[1][-1], CID)

    def test_cache(self):
        clock = FakeClock()
        d = FakeDocker(clock, lines=[ibc(T0 - 50, MSG["logged-in"])])
        cache = vr.GatewayCache(vr.GatewayReader(d, clock).read, clock)
        cache.get()
        clock.t += 9
        cache.get()
        self.assertEqual(len(d.calls), 3)
        clock.t += 1
        cache.get()
        self.assertEqual(len(d.calls), 6)
        cache.get(force=True)
        self.assertEqual(len(d.calls), 9)


class LogCursorTest(unittest.TestCase):
    """Full first read since StartedAt, then incremental reads from the last line read."""

    def setUp(self):
        self.clock = FakeClock()
        self.docker = FakeDocker(self.clock, started=T0 - 42 * 3600)
        self.reader = vr.GatewayReader(self.docker, self.clock)

    def logs_calls(self):
        return [c for c in self.docker.calls if c[1] == "logs"]

    def test_login_far_before_many_noise_lines(self):
        d = self.docker
        d.add(T0 - 40 * 3600, "login-started")
        d.add(T0 - 40 * 3600 + 10, "2fa-started")
        d.add(T0 - 40 * 3600 + 30, "logged-in")
        d.noise(T0 - 40 * 3600 + 60, 6000, step=20)  # > 4000 Java lines after the last IBC event
        view = self.reader.read()
        self.assertEqual((view.login_state, view.reason), ("logged-in", "logged-in"))
        self.assertEqual(self.logs_calls()[0][4], rfc(T0 - 42 * 3600))
        self.assertEqual(len(self.reader._events), 3)  # events only, no raw lines kept

    def test_incremental_read_appends_and_dedupes_boundary(self):
        d = self.docker
        d.add(T0 - 3000, "logged-in")
        d.noise(T0 - 2000, 10)
        self.assertEqual(self.reader.read().login_state, "logged-in")
        last_stamp = d.lines[-1].split(" ", 1)[0]
        # A second line with the same timestamp as the cursor arrives later; docker repeats the boundary line.
        same_ts_event = "%s 2026-10-26 20:00:00:000 IBC: %s" % (last_stamp, MSG["login-started"])
        d.lines.append(same_ts_event)
        d.add(T0 - 100, "2fa-started")
        d.add(T0 - 50, "2fa-timeout")
        d.noise(T0 - 40, 5)
        view = self.reader.read()
        self.assertEqual(self.logs_calls()[1][4], last_stamp)
        self.assertEqual((view.login_state, view.reason), ("logged-out", "2fa-timeout"))
        self.assertEqual([e[1] for e in self.reader._events],
                         ["logged-in", "login-started", "2fa-started", "2fa-timeout"])
        # No new lines: the repeated boundary line adds nothing.
        self.reader.read()
        self.assertEqual(len(self.reader._events), 4)
        self.assertEqual(self.logs_calls()[2][4], d.lines[-1].split(" ", 1)[0])

    def test_restart_resets_cursor(self):
        d = self.docker
        d.add(T0 - 3000, "logged-in")
        self.assertEqual(self.reader.read().login_state, "logged-in")
        # Same container restarted: new StartedAt, old lines stay in docker but are before StartedAt.
        d.started = T0 - 30
        d.add(T0 - 20, "login-started")
        view = self.reader.read()
        self.assertEqual(self.logs_calls()[1][4], rfc(T0 - 30))
        self.assertEqual((view.login_state, [e[1] for e in self.reader._events]), ("starting", ["login-started"]))
        # New container id: cursor resets too.
        other = CID.replace("0", "3")
        d.rows = ["%s running" % other]
        d.lines = [ibc(T0 - 10, MSG["logged-in"])]
        view = self.reader.read()
        self.assertEqual((self.logs_calls()[2][4], self.logs_calls()[2][5]), (rfc(T0 - 30), other))
        self.assertEqual((view.login_state, len(self.reader._events)), ("logged-in", 1))

    def test_stopped_then_new_start(self):
        d = self.docker
        d.add(T0 - 3000, "logged-in")
        self.reader.read()
        d.running = False
        self.assertEqual(self.reader.read().login_state, "stopped")
        d.running, d.started = True, T0 - 60
        view = self.reader.read()
        self.assertEqual((view.login_state, view.reason), ("starting", "no-login-event"))

    def test_too_large_falls_back_to_window(self):
        d = self.docker
        d.started = T0 - 72 * 3600              # container up for 3 days
        d.too_large.add(rfc(d.started))
        d.add(T0 - 50 * 3600, "2fa-timeout")    # outside the 48 h window
        d.add(T0 - 47 * 3600, "logged-in")      # inside
        d.noise(T0 - 46 * 3600, 3)
        view = self.reader.read()
        self.assertEqual([c[4] for c in self.logs_calls()], [rfc(T0 - 72 * 3600), vr.iso(T0 - 48 * 3600)])
        self.assertEqual((view.login_state, [e[1] for e in self.reader._events]), ("logged-in", ["logged-in"]))
        # Window without any IBC event: unknown, reason log-window.
        reader = vr.GatewayReader(d, self.clock)
        d.lines = []
        d.noise(T0 - 3600, 3)
        view = reader.read()
        self.assertEqual((view.login_state, view.reason), ("unknown", "log-window"))
        reader.read()  # then incremental from the cursor, no new full read
        self.assertEqual(self.logs_calls()[-1][4], d.lines[-1].split(" ", 1)[0])

    def test_window_never_before_container_start(self):
        d = self.docker  # started 42 h ago, inside the 48 h window
        d.too_large.add(rfc(d.started))
        self.assertEqual(self.reader.read().reason, "docker-error")
        self.assertEqual([c[4] for c in self.logs_calls()], [rfc(T0 - 42 * 3600)] * 2)

    def test_timeout_falls_back_to_window(self):
        self.docker.started = T0 - 72 * 3600
        calls = []

        def run(argv, timeout, max_bytes=None):
            if argv[1] == "logs":
                calls.append((argv[4], timeout, max_bytes))
                if len(calls) == 1:
                    raise vr.DockerTimeout("slow")
                return ibc(T0 - 100, MSG["logged-in"]) + "\n"
            return self.docker(argv, timeout)

        view = vr.GatewayReader(run, self.clock).read()
        self.assertEqual(view.login_state, "logged-in")
        self.assertEqual(calls, [(rfc(T0 - 72 * 3600), 20, 64 * 1024 * 1024),
                                 (vr.iso(T0 - 48 * 3600), 20, 64 * 1024 * 1024)])

    def test_events_capped(self):
        d = self.docker
        for i in range(600):
            d.add(T0 - 9000 + i, "login-started" if i % 2 else "logged-in")
        self.reader.read()
        self.assertEqual(len(self.reader._events), 500)
        self.assertEqual(self.reader._events[-1][1], "login-started")

    def test_docker_error_keeps_cursor(self):
        d = self.docker
        d.add(T0 - 3000, "logged-in")
        self.reader.read()
        d.fail = True
        self.assertEqual(self.reader.read().reason, "docker-error")
        d.fail = False
        d.add(T0 - 10, "2fa-timeout")
        self.assertEqual(self.reader.read().login_state, "logged-out")
        self.assertEqual(self.logs_calls()[-1][4], rfc(T0 - 3000))


class MonitorLoopTest(unittest.TestCase):
    def test_monitor_refreshes_gateway(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        rig = Rig(tmp)
        stop = threading.Event()
        stop.set()  # one round only
        rig.svc.run_monitor(stop)
        self.assertEqual([c[1] for c in rig.docker.calls], ["ps", "inspect", "logs"])


class EnvFileGuardTest(unittest.TestCase):
    def test_keys(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        a, b = os.path.join(tmp, ".env.example"), os.path.join(tmp, ".env")
        with open(a, "w") as f:
            f.write("# IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT=1\n  # IBKR_2FA_MAX_ATTEMPTS=3\nIBKR_2FA_VERIFY_CLIENT_ID=98\n"
                    "IBKR_2FA_NOTIFY_EMAIL=a@b.c\nWATCHDOG_RESTART_COOLDOWN_SECONDS=300\n")
        self.assertEqual(vr.env_file_override_keys((a, os.path.join(tmp, "missing"))), [])
        with open(b, "w") as f:
            f.write("IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT=1\nexport IBKR_2FA_TEST_MODE=true\n"
                    ': "${IBKR_2FA_VERIFY_API_HANDSHAKE:=1}"\nX=1; IBKR_2FA_GATEWAY_SERVICE=other\n')
        self.assertEqual(vr.env_file_override_keys((a, b)),
                         ["IBKR_2FA_GATEWAY_SERVICE", "IBKR_2FA_TEST_MODE", "IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT",
                          "IBKR_2FA_VERIFY_API_HANDSHAKE"])


# ---------------------------------------------------------------------------------------------------------
# Gates

class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def rig(self, **kw):
        clock = FakeClock()
        kw.setdefault("lines", logged_out_lines(clock))
        return Rig(self.tmp, clock=clock, **kw)

    def test_not_needed_for_every_state_without_login_need(self):
        n = T0
        cases = {
            "logged-in": dict(lines=[ibc(n - 50, MSG["logged-in"])]),
            "awaiting-2fa": dict(lines=[ibc(n - 50, MSG["2fa-started"])]),
            "starting": dict(lines=[ibc(n - 50, MSG["login-started"])]),
            "unknown": dict(lines=[]),
        }
        for state, kw in cases.items():
            rig = self.rig(**kw)
            for dry in (True, False):
                status, body, _ = rig.post(dry=dry)
                self.assertEqual((status, body), (409, {"error": "not_needed", "loginState": state}), state)
            self.assertEqual(rig.spawn.calls, [])
            self.assertFalse(os.path.exists(rig.svc.state_path))
        rig = self.rig(lines=[])
        rig.docker.fail = True
        self.assertEqual(rig.post()[:2], (409, {"error": "not_needed", "loginState": "unknown"}))

    def test_stopped_and_logged_out_allow(self):
        for kw in (dict(running=False), dict(), dict(lines=[ibc(T0 - 301, MSG["login-started"])])):
            shutil.rmtree(self.tmp)
            os.makedirs(self.tmp)
            rig = self.rig(**kw)
            status, body, _ = rig.post(dry=True)
            self.assertEqual((status, body), (200, {"schema": "vertex-ibkr-recovery-request-v1",
                                                    "outcome": "dry-run", "wouldStart": True}))

    def test_dry_run_never_spawns_or_persists(self):
        rig = self.rig()
        for _ in range(3):
            self.assertEqual(rig.post(dry=True)[0], 200)
        self.assertEqual(rig.spawn.calls, [])
        self.assertFalse(os.path.exists(rig.svc.state_path))
        self.assertIsNone(rig.svc.last_started_at)
        self.assertIsNone(rig.svc.status()["request"])
        self.assertEqual(rig.post()[0], 202)

    def test_dry_run_reports_env_file_block(self):
        rig = self.rig(env_check=lambda: ["IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT"])
        status, body, _ = rig.post(dry=True)
        self.assertEqual((status, body["outcome"], body["wouldStart"]), (200, "dry-run", False))
        self.assertIn("IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT", body["detail"])
        status, body, _ = rig.post()
        self.assertEqual((status, body["request"]["state"]), (202, "failed"))
        self.assertIn("IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT", body["request"]["detail"])
        self.assertEqual(rig.spawn.calls, [])
        self.assertEqual(rig.post(rid="req-00000002")[0], 429)

    def test_started_then_in_flight_then_existing(self):
        rig = self.rig()
        status, body, _ = rig.post()
        self.assertEqual((status, body["outcome"]), (202, "started"))
        req = body["request"]
        self.assertEqual(sorted(req), sorted(vr.PUBLIC_KEYS))
        self.assertEqual((req["state"], req["scriptRunning"], req["finishedAt"], req["actorId"]),
                         ("requested", True, None, "operator_1"))
        self.assertEqual(len(rig.spawn.calls), 1)
        log_path, env = rig.spawn.calls[0]
        self.assertEqual(log_path, os.path.join(self.tmp, "runs", "req-00000001.log"))
        self.assertEqual(env, EXPECTED_ENV)
        status, body, _ = rig.post(rid="req-00000002")
        self.assertEqual((status, body["error"], body["request"]["requestId"]), (409, "in_flight", "req-00000001"))
        status, body, _ = rig.post(rid="req-00000002", dry=True)
        self.assertEqual(status, 409)
        status, body, _ = rig.post()
        self.assertEqual((status, body["outcome"], body["request"]["requestId"]), (200, "existing", "req-00000001"))
        self.assertEqual(len(rig.spawn.calls), 1)
        self.assertIn({"event": "request_started", "requestId": "req-00000001", "actorId": "operator_1"}, rig.logs)
        self.assertIn({"event": "request_refused", "reason": "in_flight"}, rig.logs)

    def test_post_reads_docker_outside_the_lock(self):
        rig = self.rig()
        seen = []
        real = rig.docker.__call__

        def try_lock(got):
            ok = rig.svc.lock.acquire(blocking=False)
            if ok:
                rig.svc.lock.release()
            got.append(ok)

        def probe(argv, timeout, max_bytes=None):
            # Another thread must be able to take the request lock while docker is read.
            got = []
            t = threading.Thread(target=try_lock, args=(got,))
            t.start()
            t.join()
            seen.append(got[0])
            return real(argv, timeout, max_bytes)

        rig.gateway._read = vr.GatewayReader(probe, rig.clock).read
        self.assertEqual(rig.post(dry=True)[0], 200)
        self.assertEqual(rig.post()[0], 202)
        self.assertEqual(rig.post(rid="req-00000002")[0], 409)
        self.assertTrue(seen)
        self.assertTrue(all(seen), seen)

    def test_single_flight_parallel_posts(self):
        rig = self.rig()
        results = []
        threads = [threading.Thread(target=lambda i=i: results.append(rig.post(rid="req-%08d" % i)[0]))
                   for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), [202] + [409] * 7)
        self.assertEqual(len(rig.spawn.calls), 1)

    def test_in_flight_while_script_runs_after_terminal(self):
        rig = self.rig()
        rig.post()
        rig.svc.active["state"] = "timed-out"
        rig.clock.t += 2000  # past the cooldown
        self.assertEqual(rig.post(rid="req-00000002")[:2][0], 409)
        rig.spawn.procs[0].code = 1
        self.assertEqual(rig.post(rid="req-00000002")[0], 202)

    def test_cooldown(self):
        rig = self.rig()
        rig.post()
        rig.spawn.procs[0].code = 0
        rig.svc.tick()  # script ended without events -> failed
        self.assertEqual(rig.svc.active["state"], "failed")
        rig.clock.t += 100
        status, body, headers = rig.post(rid="req-00000002")
        self.assertEqual((status, body["error"], body["retryAfterSeconds"]), (429, "cooldown", 800))
        self.assertEqual(body["until"], vr.iso(T0 + 900))
        self.assertEqual(headers, {"Retry-After": "800"})
        self.assertEqual(rig.svc.status()["cooldown"], {"seconds": 900, "until": vr.iso(T0 + 900)})
        rig.clock.t += 0.5
        self.assertEqual(rig.post(rid="req-00000002")[2], {"Retry-After": "800"})
        # persisted across a service restart
        rig.restart()
        self.assertEqual(rig.post(rid="req-00000002")[0], 429)
        rig.clock.t = T0 + 900
        self.assertIsNone(rig.svc.status()["cooldown"]["until"])
        self.assertEqual(rig.post(rid="req-00000002")[0], 202)

    def test_spawn_failure(self):
        rig = self.rig(spawn=FakeSpawn(fail=True))
        status, body, _ = rig.post()
        self.assertEqual((status, body["outcome"]), (202, "started"))
        self.assertEqual((body["request"]["state"], body["request"]["scriptRunning"]), ("failed", False))
        self.assertEqual(body["request"]["detail"], "script could not be started (FileNotFoundError)")
        self.assertIsNotNone(body["request"]["finishedAt"])
        self.assertEqual(rig.post(rid="req-00000002")[0], 429)

    def test_validation(self):
        good = {"requestId": "req-00000001", "actorId": "op_1-a", "statement": STATEMENT, "dryRun": False}
        self.assertEqual(vr.validate_request(json.dumps(good).encode()), (good, None))
        bad = [
            dict(good, extra=1), {k: v for k, v in good.items() if k != "dryRun"},
            dict(good, statement=STATEMENT + " "), dict(good, statement="I request IBKR recovery only."),
            dict(good, requestId="short"), dict(good, requestId="a" * 65), dict(good, requestId="req_00000001"),
            dict(good, requestId="req 00000001"), dict(good, requestId=12345678), dict(good, actorId=""),
            dict(good, actorId="a" * 65), dict(good, actorId="op@x"), dict(good, dryRun=0),
            dict(good, dryRun="false"), dict(good, dryRun=None),
        ]
        for body in bad:
            payload, detail = vr.validate_request(json.dumps(body).encode())
            self.assertIsNone(payload, body)
            self.assertTrue(detail)
        for raw in (b"", b"[]", b"null", b"{", b"\xff\xfe", b'"x"'):
            self.assertIsNone(vr.validate_request(raw)[0], raw)
        self.assertIsNone(vr.validate_request(b"req-00000001\n")[0])


# ---------------------------------------------------------------------------------------------------------
# Lifecycle

class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        clock = FakeClock()
        self.rig = Rig(self.tmp, clock=clock, lines=logged_out_lines(clock))
        self.assertEqual(self.rig.post()[0], 202)
        self.svc = self.rig.svc

    def advance(self, seconds):
        self.rig.clock.t += seconds
        self.svc.tick()
        return self.svc.status()["request"]

    def test_happy_path(self):
        r = self.rig
        self.assertEqual(self.advance(5)["state"], "requested")
        r.spawn.write("\n==> IBKR Gateway readiness check 1\n\n==> IBKR 2FA login request attempt 1\n")
        self.assertEqual(self.advance(5)["state"], "waiting-for-approval")
        r.docker.add(r.clock.t + 20, "login-started")
        r.docker.add(r.clock.t + 25, "2fa-started")
        req = self.advance(30)
        self.assertEqual((req["state"], req["detail"]), ("waiting-for-approval", vr.DETAIL_WAITING))
        self.assertEqual(self.svc.status()["gateway"]["loginState"], "awaiting-2fa")
        login_at = r.clock.t + 10
        r.docker.add(login_at, "logged-in")
        r.health["value"] = {"state": "live", "connected": True, "dataAsOf": login_at - 6}  # stale
        req = self.advance(20)
        self.assertEqual((req["state"], req["scriptRunning"]), ("verifying", True))
        r.health["value"] = {"state": "live", "connected": False, "dataAsOf": login_at + 5}
        self.assertEqual(self.advance(5)["state"], "verifying")
        r.health["value"] = {"state": "live", "connected": True, "dataAsOf": login_at}
        req = self.advance(5)
        self.assertEqual((req["state"], req["detail"], req["scriptRunning"]),
                         ("logged-in", "account snapshot OK", True))
        self.assertIsNotNone(req["finishedAt"])
        # Terminal, but the script still runs: refuse new requests; the script is never stopped.
        r.clock.t += 2000
        self.assertEqual(r.post(rid="req-00000002")[1]["error"], "in_flight")
        r.spawn.procs[0].code = 0
        req = self.advance(5)
        self.assertEqual((req["state"], req["scriptRunning"]), ("logged-in", False))
        states = [e["state"] for e in r.logs if e["event"] == "request_state"]
        self.assertEqual(states, ["waiting-for-approval", "verifying", "logged-in"])
        with open(self.svc.state_path) as f:
            saved = json.load(f)
        self.assertEqual((saved["active"]["state"], saved["active"]["scriptRunning"]), ("logged-in", False))

    def test_timeout_event(self):
        r = self.rig
        r.docker.add(r.clock.t + 5, "2fa-started")
        self.assertEqual(self.advance(10)["state"], "waiting-for-approval")
        r.docker.add(r.clock.t + 170, "2fa-timeout")
        req = self.advance(180)
        self.assertEqual((req["state"], req["detail"], req["scriptRunning"]),
                         ("timed-out", vr.DETAIL_2FA_TIMEOUT, True))

    def test_old_events_before_start_ignored(self):
        # logged_out_lines() has a 2fa-timeout before the start; it must not end the new request.
        self.assertEqual(self.advance(5)["state"], "requested")

    def test_timeout_300s(self):
        r = self.rig
        r.spawn.write("==> IBKR 2FA login request attempt 1\n")
        self.assertEqual(self.advance(300)["state"], "waiting-for-approval")
        req = self.advance(1)
        self.assertEqual((req["state"], req["detail"]), ("timed-out", "no login within 300 s"))

    def test_exit_after_2fa_waits_for_timeout(self):
        r = self.rig
        r.docker.add(r.clock.t + 5, "2fa-started")
        r.spawn.procs[0].code = 1
        req = self.advance(10)
        self.assertEqual((req["state"], req["scriptRunning"]), ("waiting-for-approval", False))
        self.assertEqual(self.advance(300)["state"], "timed-out")

    def test_early_exit_detail(self):
        r = self.rig
        long_line = "ERROR: " + "x" * 300
        r.spawn.write("\n==> IBKR Gateway readiness check 1\n" + long_line + "\n\n   \n")
        r.spawn.procs[0].code = 1
        req = self.advance(5)
        self.assertEqual(req["state"], "failed")
        self.assertEqual(len(req["detail"]), 200)
        self.assertTrue(req["detail"].startswith("ERROR: xxx"))
        self.assertFalse(req["scriptRunning"])

    def test_early_exit_detail_redacts_and_no_output(self):
        r = self.rig
        r.spawn.write("\x1b[31mERROR: bad token %s here\x1b[0m\n" % ("Ab3_" * 11))
        r.spawn.procs[0].code = 1
        self.assertEqual(self.advance(5)["detail"], "ERROR: bad token [redacted] here")

    def test_no_output_exit(self):
        self.rig.spawn.procs[0].code = 1
        self.assertEqual(self.advance(5)["detail"], "script exited without output")

    def test_exit_after_attempt_line_keeps_following_the_gateway(self):
        r = self.rig
        r.spawn.write("\n==> IBKR Gateway readiness check 1\n\n==> IBKR 2FA login request attempt 1\n"
                      "ERROR: something failed after the restart\n")
        r.spawn.procs[0].code = 1
        req = self.advance(5)
        self.assertEqual((req["state"], req["scriptRunning"]), ("waiting-for-approval", False))
        r.docker.add(r.clock.t + 20, "2fa-started")
        self.assertEqual(self.advance(30)["state"], "waiting-for-approval")
        login_at = r.clock.t + 10
        r.docker.add(login_at, "logged-in")
        self.assertEqual(self.advance(15)["state"], "verifying")
        r.health["value"] = {"state": "live", "connected": True, "dataAsOf": login_at}
        req = self.advance(5)
        self.assertEqual((req["state"], req["detail"]), ("logged-in", "account snapshot OK"))

    def test_exit_after_attempt_line_times_out_without_events(self):
        r = self.rig
        r.spawn.write("==> IBKR 2FA login request attempt 1\n")
        r.spawn.procs[0].code = 1
        self.assertEqual(self.advance(5)["state"], "waiting-for-approval")
        self.assertEqual(self.advance(296)["state"], "timed-out")

    def test_script_reports_gateway_ready(self):
        r = self.rig
        r.spawn.write("\n==> IBKR Gateway readiness check 1\nIBKR Gateway readiness checks already pass; "
                      "no 2FA request needed\n")
        req = self.advance(5)
        self.assertEqual((req["state"], req["detail"]),
                         ("failed", "The script reported the gateway ready and sent no 2FA request."))
        r.spawn.procs[0].code = 0
        self.assertEqual(self.advance(5)["detail"],
                         "The script reported the gateway ready and sent no 2FA request.")

    def test_exit_race_reads_gateway_fresh(self):
        r = self.rig
        self.advance(5)  # cache filled now
        r.docker.add(r.clock.t + 1, "logged-in")
        r.clock.t += 2
        r.spawn.procs[0].code = 0  # script saw the login and ended; the cache is still 2 s old
        self.svc.tick()
        self.assertEqual(self.svc.active["state"], "verifying")

    def test_cooldown_line(self):
        r = self.rig
        r.spawn.write("==> IBKR 2FA login request attempt 1\nWARN: IBKR Gateway restart cooldown active; 120s until "
                      "the next email/restart attempt\n")
        req = self.advance(5)
        self.assertEqual((req["state"], req["detail"], req["scriptRunning"]),
                         ("failed", "gateway restart cooldown active on the VPS", True))

    def test_session_ended(self):
        r = self.rig
        r.docker.add(r.clock.t + 3, "2fa-started")
        r.docker.add(r.clock.t + 4, "session-ended")
        req = self.advance(10)  # the gateway cache refreshes at most every 10 s
        self.assertEqual((req["state"], req["detail"]), ("failed", vr.DETAIL_SESSION_ENDED))

    def test_verifying_timeout(self):
        r = self.rig
        r.docker.add(r.clock.t + 3, "logged-in")
        self.assertEqual(self.advance(10)["state"], "verifying")
        self.assertEqual(self.advance(180)["state"], "verifying")
        req = self.advance(5)
        self.assertEqual((req["state"], req["detail"]), ("failed", "login completed; account snapshot not confirmed"))

    def test_restart_recovery(self):
        self.rig.spawn.write("==> IBKR 2FA login request attempt 1\n")
        self.advance(5)
        svc = self.rig.restart()
        req = svc.status()["request"]
        self.assertEqual((req["state"], req["detail"], req["scriptRunning"]),
                         ("failed", "service restarted during the request", False))
        self.assertEqual(svc.status()["history"][0], req)
        self.assertEqual(self.rig.post(rid="req-00000002")[0], 429)
        self.assertEqual(self.rig.post()[1]["outcome"], "existing")

    def test_monitor_skips_terminal(self):
        self.rig.spawn.procs[0].code = 1
        self.advance(5)
        calls = len(self.rig.docker.calls)
        self.rig.clock.t += 60
        self.svc.tick()
        self.assertEqual(len(self.rig.docker.calls), calls)


class DecideTest(unittest.TestCase):
    def test_pure_rules(self):
        s = T0
        self.assertEqual(vr.decide(s, s + 1, [], [], False)[0], "requested")
        self.assertEqual(vr.decide(s, s + 1, [(s - 1, "logged-in")], [], False)[0], "requested")
        self.assertEqual(vr.decide(s, s + 1, [(s, "2fa-started")], [], False)[0], "waiting-for-approval")
        self.assertEqual(vr.decide(s, s + 9, [(s + 1, "logged-in"), (s + 2, "2fa-timeout")], [], False)[0],
                         "timed-out")
        self.assertEqual(vr.decide(s, s + 9, [(s + 1, "logged-in"), (s + 5, "logged-in")], [], True),
                         ("verifying", vr.DETAIL_VERIFYING, s + 5))
        self.assertEqual(vr.decide(s, s + 400, [(s + 1, "logged-in")], [], True)[0], "verifying")

    def test_snapshot_ok(self):
        ok = {"state": "live", "connected": True, "dataAsOf": T0}
        self.assertTrue(vr.snapshot_ok(ok, T0 + 5))
        self.assertFalse(vr.snapshot_ok(ok, T0 + 5.01))
        self.assertFalse(vr.snapshot_ok(dict(ok, state="disconnected"), T0))
        self.assertFalse(vr.snapshot_ok(dict(ok, connected="true"), T0))
        self.assertFalse(vr.snapshot_ok(dict(ok, dataAsOf=None), T0))
        self.assertFalse(vr.snapshot_ok(dict(ok, dataAsOf=True), 0))
        self.assertFalse(vr.snapshot_ok(None, T0))
        self.assertFalse(vr.snapshot_ok(ok, None))


# ---------------------------------------------------------------------------------------------------------
# Persistence

class FeedsMissingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def rig(self, health):
        clock = FakeClock()
        return Rig(self.tmp, clock=clock, lines=[ibc(T0 - 50, MSG["logged-in"])], health={"value": health})

    def test_rules(self):
        self.assertFalse(vr.feeds_missing(None))
        self.assertFalse(vr.feeds_missing({"state": "live", "connected": True}))
        self.assertTrue(vr.feeds_missing({"state": "live", "connected": False}))
        self.assertTrue(vr.feeds_missing({"state": "disconnected", "connected": True}))

    def test_logged_in_with_missing_feeds_allows_a_request(self):
        rig = self.rig({"state": "disconnected", "connected": False})
        gateway = rig.svc.status()["gateway"]
        self.assertEqual((gateway["loginState"], gateway["needsLogin"], gateway["feedsMissing"]),
                         ("logged-in", False, True))
        self.assertEqual(rig.post(dry=True)[:2], (200, {"schema": vr.REQUEST_SCHEMA, "outcome": "dry-run",
                                                        "wouldStart": True}))
        self.assertEqual(rig.post()[0], 202)
        self.assertEqual(len(rig.spawn.calls), 1)

    def test_live_or_unknown_feeds_stay_not_needed(self):
        for health in ({"state": "live", "connected": True}, None):
            rig = self.rig(health)
            self.assertFalse(rig.svc.status()["gateway"]["feedsMissing"])
            self.assertEqual(rig.post()[:2], (409, {"error": "not_needed", "loginState": "logged-in"}))
            self.assertEqual(rig.spawn.calls, [])

    def test_awaiting_2fa_with_missing_feeds_stays_not_needed(self):
        clock = FakeClock()
        rig = Rig(self.tmp, clock=clock, lines=[ibc(T0 - 50, MSG["2fa-started"])],
                  health={"value": {"state": "disconnected", "connected": False}})
        self.assertEqual(rig.post()[0], 409)


class RecheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        clock = FakeClock()
        self.rig = Rig(self.tmp, clock=clock, lines=logged_out_lines(clock))
        self.assertEqual(self.rig.post()[0], 202)
        self.svc = self.rig.svc
        self.start = clock.t

    def finish_timed_out(self):
        self.rig.clock.t += 400
        self.svc.tick()
        self.assertEqual(self.svc.status()["request"]["state"], "timed-out")

    def test_schedules_the_recheck_after_the_approval_window(self):
        self.assertEqual(self.svc.status()["request"]["recheckAt"], vr.iso(self.start + 900))
        self.assertIsNone(self.svc.status()["request"]["recheck"])

    def test_not_before_the_window_and_not_while_active(self):
        self.rig.clock.t += 950
        self.svc.recheck()  # still "requested": no re-check yet
        self.assertIsNone(self.svc.active["recheck"])
        self.svc.tick()
        self.rig.clock.t = self.start + 899
        self.svc.recheck()
        self.assertIsNone(self.svc.active["recheck"])

    def test_good_auth_clears_the_request(self):
        r = self.rig
        self.finish_timed_out()
        r.docker.add(r.clock.t, "logged-in")
        r.health["value"] = {"state": "live", "connected": True, "dataAsOf": r.clock.t}
        r.clock.t = self.start + 900
        self.svc.recheck()
        self.assertIsNone(self.svc.status()["request"])
        rec = self.svc.history[0]
        self.assertEqual((rec["recheck"]["ok"], rec["state"]), (True, "timed-out"))
        with open(self.svc.state_path) as f:
            self.assertIsNone(json.load(f)["active"])
        self.assertEqual(r.spawn.calls[1:], [])  # read-only: nothing new started

    def test_bad_auth_keeps_the_request_with_the_reason_then_clears_later(self):
        r = self.rig
        self.finish_timed_out()
        r.health["value"] = {"state": "disconnected", "connected": False}
        r.clock.t = self.start + 900
        self.svc.recheck()
        req = self.svc.status()["request"]
        self.assertEqual(req["recheck"]["ok"], False)
        self.assertEqual(req["recheck"]["detail"], "not authenticated (login logged-out, account feeds missing)")
        r.clock.t += 30
        r.docker.add(r.clock.t, "logged-in")
        r.health["value"] = {"state": "live", "connected": True}
        self.svc.recheck()  # repeat interval not reached
        self.assertIsNotNone(self.svc.status()["request"])
        r.clock.t += 31
        self.svc.recheck()
        self.assertIsNone(self.svc.status()["request"])

    def test_recheck_fields_survive_a_restart(self):
        r = self.rig
        self.finish_timed_out()
        r.clock.t = self.start + 900
        self.svc.recheck()
        svc = r.restart()
        req = svc.status()["request"]
        self.assertEqual((req["recheckAt"], req["recheck"]["ok"]), (vr.iso(self.start + 900), False))
        self.assertEqual(vr._valid_recheck({"at": 1}), None)


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_state_file_and_limits(self):
        clock = FakeClock()
        rig = Rig(self.tmp, clock=clock, lines=logged_out_lines(clock))
        replaced = []
        real_replace = os.replace

        def spy(src, dst):
            replaced.append((src, dst))
            return real_replace(src, dst)

        with mock.patch.object(vr.os, "replace", side_effect=spy):
            for i in range(25):
                rid = "req-%08d" % i
                self.assertEqual(rig.post(rid=rid)[0], 202, i)
                os.utime(rig.spawn.path, (clock.t, clock.t))
                rig.spawn.procs[-1].code = 0
                rig.svc.tick()
                clock.t += 901
        self.assertTrue(replaced)
        for src, dst in replaced:
            self.assertEqual(os.path.dirname(src), self.tmp)
            self.assertEqual(dst, rig.svc.state_path)
        self.assertEqual(stat.S_IMODE(os.stat(rig.svc.state_path).st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.tmp)), ["runs", "state.json"])
        with open(rig.svc.state_path) as f:
            saved = json.load(f)
        self.assertEqual(len(saved["history"]), 20)
        self.assertEqual(saved["history"][0]["requestId"], "req-00000024")
        self.assertEqual(saved["active"]["requestId"], "req-00000024")
        self.assertEqual(saved["lastStartedAt"], T0 + 24 * 901)
        status = rig.svc.status()
        self.assertEqual(len(status["history"]), 10)
        self.assertEqual(status["request"]["requestId"], "req-00000024")
        runs = sorted(os.listdir(os.path.join(self.tmp, "runs")))
        self.assertEqual(len(runs), 20)
        self.assertEqual(runs[0], "req-00000005.log")
        svc = rig.restart()
        self.assertEqual(len(svc.history), 20)
        self.assertIs(svc.history[0], svc.active)

    def test_corrupt_state_keeps_cooldown(self):
        with open(os.path.join(self.tmp, "state.json"), "w") as f:
            f.write("{not json")
        clock = FakeClock()
        rig = Rig(self.tmp, clock=clock, lines=logged_out_lines(clock))
        self.assertEqual(rig.post()[0], 429)
        self.assertIn({"event": "state_unreadable"}, rig.logs)


# ---------------------------------------------------------------------------------------------------------
# HTTP

class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        clock = FakeClock()
        self.rig = Rig(self.tmp, clock=clock, lines=logged_out_lines(clock))
        self.server = vr.ThreadingHTTPServer(("127.0.0.1", 0), vr.make_handler(self.rig.svc, TOKEN))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def req(self, path, token=TOKEN, method="GET", body=None, headers=None):
        data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
        r = urllib.request.Request(self.base + vr.PREFIX + path, method=method, data=data)
        if token:
            r.add_header("Authorization", "Bearer " + token)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            r.add_header(k, v)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return resp.status, json.loads(resp.read()), resp.headers
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b"{}"), e.headers

    def body(self, **kw):
        b = {"requestId": "req-00000001", "actorId": "operator_1", "statement": STATEMENT, "dryRun": True}
        b.update(kw)
        return b

    def test_auth(self):
        for path, method in (("/status", "GET"), ("/health", "GET"), ("/request", "POST"), ("/nope", "GET")):
            for token in (None, "x" * 64, TOKEN[:-1], TOKEN + "x", STATUS_TOKEN):
                status, body, _ = self.req(path, token=token, method=method,
                                           body=self.body() if method == "POST" else None)
                self.assertEqual((status, body), (401, {"error": "unauthorized"}), (path, token))
        self.assertEqual(self.rig.spawn.calls, [])
        self.assertIn("compare_digest", SOURCE)

    def test_routes_and_headers(self):
        status, body, headers = self.req("/status")
        self.assertEqual((status, body["schema"], body["version"]), (200, "vertex-ibkr-recovery-status-v1", "1.1.0"))
        self.assertEqual(body["gateway"], {"loginState": "logged-out", "needsLogin": True,
                                           "since": vr.iso(T0 - 600), "reason": "2fa-timeout", "feedsMissing": False})
        self.assertEqual((body["request"], body["history"]), (None, []))
        self.assertEqual(body["cooldown"], {"seconds": 900, "until": None})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Content-Type"], "application/json")
        status, body, _ = self.req("/health")
        self.assertEqual((status, body), (200, {"schema": "vertex-ibkr-recovery-health-v1", "version": "1.1.0",
                                                "loginState": "logged-out"}))
        self.assertEqual(self.req("/other")[0], 404)
        self.assertEqual(self.req("/status", method="POST", body=self.body())[0], 405)
        self.assertEqual(self.req("/health", method="DELETE")[0], 405)
        self.assertEqual(self.req("/request")[0], 405)
        self.assertEqual(self.req("/request", method="PUT", body=self.body())[0], 405)

    def test_post_flow(self):
        status, body, _ = self.req("/request", method="POST", body=self.body())
        self.assertEqual((status, body["outcome"], body["wouldStart"]), (200, "dry-run", True))
        self.assertEqual(self.rig.spawn.calls, [])
        status, body, _ = self.req("/request", method="POST", body=self.body(dryRun=False))
        self.assertEqual((status, body["outcome"], body["request"]["state"]), (202, "started", "requested"))
        status, body, _ = self.req("/request", method="POST", body=self.body(dryRun=False))
        self.assertEqual((status, body["outcome"]), (200, "existing"))
        status, body, _ = self.req("/request", method="POST", body=self.body(requestId="req-00000002"))
        self.assertEqual((status, body["error"]), (409, "in_flight"))
        self.rig.spawn.procs[0].code = 1
        self.rig.svc.tick()  # script ended before any event -> failed
        status, body, headers = self.req("/request", method="POST", body=self.body(requestId="req-00000002"))
        self.assertEqual((status, body["error"], headers["Retry-After"]), (429, "cooldown", "900"))
        status, body, _ = self.req("/status")
        self.assertEqual(body["request"]["requestId"], "req-00000001")
        self.assertEqual(body["cooldown"]["until"], vr.iso(T0 + 900))
        self.assertEqual(len(self.rig.spawn.calls), 1)

    def test_bad_bodies(self):
        status, body, _ = self.req("/request", method="POST", body=self.body(extra=True))
        self.assertEqual((status, body["error"]), (400, "bad_request"))
        self.assertEqual(self.req("/request", method="POST", body=b"{bad")[0], 400)
        self.assertEqual(self.req("/request", method="POST", body=self.body(statement="ok"))[0], 400)
        big = json.dumps(self.body(actorId="a" * 5000)).encode()
        status, body, _ = self.req("/request", method="POST", body=big)
        self.assertEqual((status, body), (413, {"error": "payload_too_large"}))
        self.assertEqual(self.rig.spawn.calls, [])

    def test_logs_never_hold_token(self):
        self.req("/request", method="POST", body=self.body(dryRun=False))
        self.req("/request", method="POST", body=self.body(requestId="req-00000002"))
        self.req("/status", token="x" * 64)
        text = json.dumps(self.rig.logs)
        self.assertNotIn(TOKEN, text)
        self.assertNotIn(STATUS_TOKEN, text)


# ---------------------------------------------------------------------------------------------------------
# Nautilus arm switch

NODE_CID = "abcdef0123456789abcd"
ARM_STATEMENT = "I arm the Nautilus node; it may submit live orders."
REASON = "Owner arms after the 2026-10-30 review"
PY = ["/usr/bin/docker", "exec", NODE_CID, "python", "-m", "nautilus.arm_cli"]
STATUS_ARGV = PY + ["status", "--json"]
ARM_ARGV = PY + ["arm", "--by", "owner_1", "--reason", REASON, "--confirm-image-version", "1.4.2", "--json"]
DISARM_ARGV = PY + ["disarm", "--by", "owner_1", "--reason", "one click", "--json"]


def cli_status(armed=False, detail="no_arm_record", record=None, audit_id=None, **extra):
    body = {"schema": "nautilus-arm-status-v1", "armed": armed, "state": "armed" if armed else "disarmed",
            "detail": detail, "image_version": "1.4.2", "kill_switch_active": False, "record": record}
    if audit_id:
        body["audit_id"] = audit_id
    body.update(extra)
    return json.dumps(body)


ARMED_RECORD = {"schema": "nautilus-arm-record-v1", "armed": True, "armed_at": "2026-10-30T12:00:00Z",
                "armed_by": "owner_1", "reason": REASON, "image_version": "1.4.2", "audit_id": "a-1"}


class FakeNodeDocker:
    def __init__(self, rows="%s running\n" % NODE_CID, state=None, fail=False):
        self.rows = rows
        self.state = state if state is not None else {"Running": True, "Health": {"Status": "healthy"}}
        self.fail = fail
        self.calls = []

    def __call__(self, argv, timeout, max_bytes=None):
        self.calls.append(argv)
        if self.fail:
            raise vr.DockerError("down")
        if argv[1] == "ps":
            return self.rows
        return json.dumps(self.state)


class FakeCli:
    def __init__(self, replies=None):
        self.replies = list(replies or [])
        self.calls = []

    def __call__(self, argv, timeout):
        self.assertable = vr.is_nautilus_exec(argv)
        self.calls.append((argv, timeout, self.assertable))
        reply = self.replies.pop(0) if self.replies else (0, cli_status())
        if isinstance(reply, Exception):
            raise reply
        return reply


class NodeExecFormTest(unittest.TestCase):
    def test_fixed_forms(self):
        self.assertEqual(vr.nautilus_exec_argv(NODE_CID, ["status", "--json"]), STATUS_ARGV)
        self.assertEqual(vr.nautilus_ps_argv(), ["/usr/bin/docker", "ps", "-a", "--filter",
                                                 "label=com.docker.compose.service=nautilus-trader",
                                                 "--filter", "label=com.docker.compose.oneoff=False",
                                                 "--format", "{{.ID}} {{.State}}"])
        for argv in (STATUS_ARGV, ARM_ARGV, DISARM_ARGV):
            self.assertTrue(vr.is_nautilus_exec(argv), argv)
        self.assertEqual(vr.ARM_STATEMENT, ARM_STATEMENT)
        self.assertEqual(vr.DOCKER_VERBS, ("ps", "inspect", "logs"))

    def test_every_other_form_is_refused(self):
        bad = [
            ["/usr/bin/docker", "run", NODE_CID, "python", "-m", "nautilus.arm_cli", "status", "--json"],
            ["/bin/docker"] + STATUS_ARGV[1:],
            PY[:2] + ["node-name"] + PY[3:] + ["status", "--json"],
            PY[:3] + ["sh", "-c", "nautilus.arm_cli", "status", "--json"],
            PY[:5] + ["nautilus.other", "status", "--json"],
            PY + ["status"], PY + ["status", "--json", "x"], PY + ["status", "x", "--json"], PY + ["--json"],
            PY + ["arm", "--by", "owner_1", "--reason", REASON, "--json"],
            PY + ["arm", "--by", "owner_1", "--reason", "short", "--confirm-image-version", "1", "--json"],
            PY + ["arm", "--by", "owner_1", "--reason", REASON + "\nx", "--confirm-image-version", "1", "--json"],
            PY + ["arm", "--by", "owner_1", "--reason", "-" + REASON, "--confirm-image-version", "1", "--json"],
            PY + ["arm", "--by", "owner_1", "--reason", "x" * 281, "--confirm-image-version", "1", "--json"],
            PY + ["arm", "--by", "-owner", "--reason", REASON, "--confirm-image-version", "1", "--json"],
            PY + ["arm", "--by", "own er", "--reason", REASON, "--confirm-image-version", "1", "--json"],
            PY + ["arm", "--by", "owner_1", "--reason", REASON, "--confirm-image-version", "1 2", "--json"],
            PY + ["arm", "--reason", REASON, "--by", "owner_1", "--confirm-image-version", "1", "--json"],
            PY + ["disarm", "--by", "owner_1", "--json"],
            PY + ["disarm", "--by", "owner_1", "--reason", "", "--json"],
            PY + ["disarm", "--by", "owner_1", "--reason", "x", "--force", "--json"],
            PY + ["shell", "--json"],
            tuple(STATUS_ARGV), " ".join(STATUS_ARGV), STATUS_ARGV[:-1] + [1], [],
        ]
        for argv in bad:
            self.assertFalse(vr.is_nautilus_exec(argv), argv)
        # Any single change to a valid form is refused: replace, insert or remove one element.
        for good in (STATUS_ARGV, ARM_ARGV, DISARM_ARGV):
            for i in range(len(good)):
                self.assertFalse(vr.is_nautilus_exec(good[:i] + ["-x"] + good[i + 1:]), (good, i))
                self.assertFalse(vr.is_nautilus_exec(good[:i] + good[i + 1:]), (good, i))
            for i in range(len(good) + 1):
                self.assertFalse(vr.is_nautilus_exec(good[:i] + ["--privileged"] + good[i:]), (good, i))
        with mock.patch.object(vr.subprocess, "run") as run:
            for argv in bad:
                with self.assertRaises(vr.DockerError):
                    vr.nautilus_cli_run(argv, 5)
            run.assert_not_called()

    def test_cli_run_fixed_call(self):
        def writes(data, code=0):
            def run(argv, **kw):
                kw["stdout"].write(data)
                kw["stdout"].flush()
                return mock.Mock(returncode=code)
            return run

        with mock.patch.object(vr.subprocess, "run") as run:
            run.side_effect = writes(b"{}", code=2)
            self.assertEqual(vr.nautilus_cli_run(ARM_ARGV, 30), (2, "{}"))
            args, kw = run.call_args
            self.assertEqual(args[0], ARM_ARGV)
            self.assertIs(kw["shell"], False)
            self.assertEqual(kw["timeout"], 30)
            self.assertEqual(kw["stderr"], vr.subprocess.DEVNULL)
            self.assertEqual(kw["stdin"], vr.subprocess.DEVNULL)
            self.assertEqual(kw["env"], {"PATH": EXPECTED_ENV["PATH"], "HOME": "/root", "LANG": "C.UTF-8"})
            run.side_effect = writes(b"x" * (vr.CLI_MAX_BYTES + 1))
            with self.assertRaises(vr.DockerError):
                vr.nautilus_cli_run(STATUS_ARGV, 5)
            run.side_effect = vr.subprocess.TimeoutExpired(["docker"], 5)
            with self.assertRaises(vr.DockerTimeout):
                vr.nautilus_cli_run(STATUS_ARGV, 5)
            run.side_effect = OSError("no docker")
            with self.assertRaises(vr.DockerError):
                vr.nautilus_cli_run(STATUS_ARGV, 5)


class NodeParseTest(unittest.TestCase):
    def test_status_parse(self):
        self.assertEqual(vr.parse_cli_status(cli_status()), {
            "armed": False, "state": "disarmed", "detail": "no_arm_record", "imageVersion": "1.4.2",
            "killSwitchActive": False, "armedAt": None, "armedBy": None, "reason": None, "auditId": None})
        armed = vr.parse_cli_status(cli_status(True, "armed", ARMED_RECORD, audit_id="a-1"))
        self.assertEqual((armed["state"], armed["armedBy"], armed["armedAt"], armed["reason"], armed["auditId"]),
                         ("armed", "owner_1", "2026-10-30T12:00:00Z", REASON, "a-1"))
        for text in ("nope", "[]", cli_status(detail="other"), cli_status(armed="yes"), cli_status(record=[]),
                     cli_status(armed=True), cli_status(kill_switch_active=None), cli_status(image_version=1),
                     json.dumps({"schema": "x"})):
            self.assertIsNone(vr.parse_cli_status(text), text)

    def test_error_parse(self):
        ok = json.dumps({"schema": "nautilus-arm-error-v1", "error": "version_mismatch", "detail": "1.4.1 != 1.4.2"})
        self.assertEqual(vr.parse_cli_error(ok), ("version_mismatch", "1.4.1 != 1.4.2"))
        for text in ("x", "[]", json.dumps({"schema": "nautilus-arm-error-v1", "error": "other"})):
            self.assertIsNone(vr.parse_cli_error(text))

    def test_validate(self):
        arm = {"requestId": "req-00000001", "actorId": "owner_1", "reason": REASON, "statement": ARM_STATEMENT,
               "imageVersion": "1.4.2"}
        disarm = {"requestId": "req-00000001", "actorId": "owner_1", "reason": "one click"}
        self.assertEqual(vr.validate_arm_request(json.dumps(arm).encode(), True), (arm, None))
        self.assertEqual(vr.validate_arm_request(json.dumps(disarm).encode(), False), (disarm, None))
        bad_arm = [dict(arm, extra=1), {k: v for k, v in arm.items() if k != "statement"}, dict(arm, requestId="x"),
                   dict(arm, actorId="-x"), dict(arm, reason="short"), dict(arm, reason=" " + REASON),
                   dict(arm, statement="I arm"), dict(arm, imageVersion="-1"), dict(arm, imageVersion=1),
                   dict(arm, requestId=5), dict(arm, actorId=None), disarm]
        for body in bad_arm:
            self.assertIsNone(vr.validate_arm_request(json.dumps(body).encode(), True)[0], body)
        for body in (arm, dict(disarm, reason=""), dict(disarm, reason="a\tb")):
            self.assertIsNone(vr.validate_arm_request(json.dumps(body).encode(), False)[0], body)
        for raw in (b"{bad", b"[]", b"\xff"):
            self.assertIsNone(vr.validate_arm_request(raw, True)[0])


class NodeArmTest(unittest.TestCase):
    def make(self, docker=None, cli=None):
        self.logs = []
        self.docker = docker or FakeNodeDocker()
        self.cli = cli or FakeCli()
        return vr.NautilusArm(docker=self.docker, cli=self.cli, clock=lambda: T0,
                              log=lambda event, **kw: self.logs.append((event, kw)))

    def test_status_states(self):
        node = self.make()
        st = node.status()
        self.assertEqual((st["schema"], st["container"], st["armError"]),
                         ("vertex-nautilus-arm-status-v1", {"state": "running", "health": "healthy"}, None))
        self.assertEqual(st["arm"]["state"], "disarmed")
        self.assertNotIn("auditId", st["arm"])
        self.assertEqual(self.cli.calls[0][:3], (STATUS_ARGV, 8, True))
        node = self.make(cli=FakeCli([(0, cli_status(True, "armed", ARMED_RECORD))]))
        self.assertEqual(node.status()["arm"]["armedBy"], "owner_1")
        node = self.make(docker=FakeNodeDocker(rows="%s exited\n" % NODE_CID, state={"Running": False}))
        st = node.status()
        self.assertEqual((st["container"], st["arm"], st["armError"]),
                         ({"state": "exited", "health": None}, None, "not-running"))
        self.assertEqual(self.cli.calls, [])
        self.assertEqual(self.make(docker=FakeNodeDocker(rows="")).status()["container"]["state"], "missing")
        self.assertEqual(self.make(docker=FakeNodeDocker(fail=True)).status()["container"]["state"], "unknown")
        for rows in ("not-an-id running\n", "%s running\n%s running\n" % (NODE_CID, CID),
                     "%s running\n%s exited\n" % (NODE_CID, CID)):
            self.assertEqual(self.make(docker=FakeNodeDocker(rows=rows)).status()["container"]["state"], "unknown")
        self.assertEqual(self.make(docker=FakeNodeDocker(state=[])).status()["container"]["state"], "unknown")
        self.assertEqual(self.cli.calls, [])  # ambiguous or unreadable: no exec
        st = self.make(docker=FakeNodeDocker(state={"Running": True, "Health": {"Status": "odd"}})).status()
        self.assertEqual(st["container"]["health"], None)
        for reply, code in ((vr.DockerTimeout("t"), "cli-timeout"), (vr.DockerError("e"), "cli-error"),
                            ((1, cli_status()), "cli-bad-output"), ((0, "junk"), "cli-bad-output")):
            st = self.make(cli=FakeCli([reply])).status()
            self.assertEqual((st["arm"], st["armError"]), (None, code))

    def payload(self, arm=True):
        if arm:
            return {"requestId": "req-00000001", "actorId": "owner_1", "reason": REASON,
                    "statement": ARM_STATEMENT, "imageVersion": "1.4.2"}
        return {"requestId": "req-00000002", "actorId": "owner_1", "reason": "one click"}

    def test_arm_and_disarm(self):
        node = self.make(cli=FakeCli([(0, cli_status(True, "armed", ARMED_RECORD, audit_id="a-1"))]))
        status, body = node.change(self.payload(), True)
        self.assertEqual((status, body["schema"], body["action"], body["auditId"], body["arm"]["armed"]),
                         (200, "vertex-nautilus-arm-result-v1", "arm", "a-1", True))
        self.assertNotIn("auditId", body["arm"])
        self.assertEqual(self.cli.calls[0], (ARM_ARGV, 12, True))
        node = self.make(cli=FakeCli([(0, cli_status(audit_id="a-2"))]))
        status, body = node.change(self.payload(False), False)
        self.assertEqual((status, body["action"], body["arm"]["state"]), (200, "disarm", "disarmed"))
        self.assertEqual(self.cli.calls[0], (DISARM_ARGV, 12, True))
        self.assertEqual([e for e, _ in self.logs], ["node_disarm_requested", "node_disarm"])
        self.assertNotIn("one click", json.dumps(self.logs))

    def test_refusals_and_failures(self):
        err = json.dumps({"schema": "nautilus-arm-error-v1", "error": "kill_switch_active", "detail": "KILL"})
        cases = [((2, err), 409, "kill_switch_active"), ((2, "junk"), 502, "cli_failed"),
                 ((1, cli_status()), 502, "cli_failed"), (vr.DockerTimeout("t"), 504, "cli_timeout"),
                 (vr.DockerError("e"), 502, "cli_failed")]
        for reply, code, error in cases:
            status, body = self.make(cli=FakeCli([reply])).change(self.payload(), True)
            self.assertEqual((status, body["error"]), (code, error), reply)
        node = self.make(docker=FakeNodeDocker(rows=""))
        self.assertEqual(node.change(self.payload(), True), (409, {"error": "not_running",
                                                                   "detail": "the node container state is missing"}))
        self.assertEqual(self.cli.calls, [])

    def test_one_change_at_a_time(self):
        node = self.make()
        node._change.acquire()
        try:
            status, body = node.change(self.payload(False), False)
        finally:
            node._change.release()
        self.assertEqual((status, body["error"]), (409, "busy"))
        self.assertEqual(self.cli.calls, [])


class NodeHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        clock = FakeClock()
        self.rig = Rig(self.tmp, clock=clock, lines=logged_out_lines(clock))
        self.cli = FakeCli([(0, cli_status()), (0, cli_status(True, "armed", ARMED_RECORD, audit_id="a-1"))])
        node = vr.NautilusArm(docker=FakeNodeDocker(), cli=self.cli, clock=clock)
        self.server = vr.ThreadingHTTPServer(("127.0.0.1", 0), vr.make_handler(self.rig.svc, TOKEN, node))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    req = HttpTest.req

    def test_routes(self):
        arm = {"requestId": "req-00000001", "actorId": "owner_1", "reason": REASON, "statement": ARM_STATEMENT,
               "imageVersion": "1.4.2"}
        for path, method in (("/nautilus/status", "GET"), ("/nautilus/arm", "POST"), ("/nautilus/disarm", "POST")):
            status, body, _ = self.req(path, token=STATUS_TOKEN, method=method, body=arm if method == "POST" else None)
            self.assertEqual((status, body), (401, {"error": "unauthorized"}))
        self.assertEqual(self.cli.calls, [])
        status, body, headers = self.req("/nautilus/status")
        self.assertEqual((status, body["arm"]["state"], headers["Cache-Control"]), (200, "disarmed", "no-store"))
        status, body, _ = self.req("/nautilus/arm", method="POST", body=arm)
        self.assertEqual((status, body["arm"]["state"]), (200, "armed"))
        status, body, _ = self.req("/nautilus/disarm", method="POST", body=arm)
        self.assertEqual((status, body["error"]), (400, "bad_request"))
        status, body, _ = self.req("/nautilus/disarm", method="POST",
                                   body={"requestId": "req-00000002", "actorId": "owner_1", "reason": "click"})
        self.assertEqual(status, 200)
        self.assertEqual(self.req("/nautilus/arm")[0], 405)
        self.assertEqual(self.req("/nautilus/status", method="POST", body=arm)[0], 405)
        self.assertEqual(self.req("/nautilus/restart", method="POST", body=arm)[0], 404)
        self.assertEqual(self.req("/nautilus/arm", method="POST", body=b"x" * 5000)[0], 413)
        self.assertEqual(self.req("/nautilus/arm", method="POST", body=b"{")[0], 400)
        self.assertEqual([c[2] for c in self.cli.calls], [True, True, True])


class HealthFetchTest(unittest.TestCase):
    def test_no_token_no_call(self):
        self.assertIsNone(vr.make_health_fetcher("")())

    def test_unreachable_is_none(self):
        with mock.patch.object(vr, "PORTFOLIO_HEALTH_URL", "http://127.0.0.1:9/vertex-portfolio/v1/health"):
            self.assertIsNone(vr.make_health_fetcher(STATUS_TOKEN)())


class MainTest(unittest.TestCase):
    def test_refuses_weak_or_shared_token(self):
        for env in ({}, {"VERTEX_RECOVERY_TOKEN": "short"},
                    {"VERTEX_RECOVERY_TOKEN": TOKEN, "VERTEX_STATUS_TOKEN": TOKEN},
                    {"VERTEX_RECOVERY_TOKEN": "a" * 50 + "!"}):
            with mock.patch.dict(vr.os.environ, env, clear=True), mock.patch("sys.stderr"):
                self.assertEqual(vr.main(), 2, env)


if __name__ == "__main__":
    unittest.main(verbosity=1)
