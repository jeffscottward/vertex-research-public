"""Market notes child processes: the small environment, the process group, the stop signals, no orphan."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from market_notes import process

RESEARCH = Path(__file__).resolve().parents[1]


def test_a_child_gets_only_the_allow_listed_variables():
    environ = {
        "PATH": "/usr/bin", "HOME": "/home/x", "USER": "x", "LOGNAME": "x", "LANG": "C.UTF-8", "LC_ALL": "C", "LC_CTYPE": "C",
        "TMPDIR": "/tmp", "XDG_CACHE_HOME": "/c", "XDG_CONFIG_HOME": "/cfg", "XDG_DATA_HOME": "/d", "XDG_RUNTIME_DIR": "/r",
        "HF_HOME": "/hf", "HF_HUB_CACHE": "/hub", "HUGGINGFACE_HUB_CACHE": "/hub2", "CUDA_VISIBLE_DEVICES": "0",
        "LD_LIBRARY_PATH": "/lib", "HTTP_PROXY": "p1", "HTTPS_PROXY": "p2", "NO_PROXY": "p3", "http_proxy": "p4",
        "https_proxy": "p5", "no_proxy": "p6",
    }
    secrets = {
        "VERTEX_AGENT_API_KEY": "a", "FINANCIAL_DATASETS_API_KEY": "b", "ANTHROPIC_API_KEY": "c", "GH_TOKEN": "d", "HF_TOKEN": "e",
        "DATABASE_URL": "f", "BETTER_AUTH_SECRET": "g", "AWS_SECRET_ACCESS_KEY": "h", "OP_SERVICE_ACCOUNT_TOKEN": "i",
        "SSH_AUTH_SOCK": "j", "VERTEX_ORIGIN": "k", "VERTEX_MARKET_NOTE_TRANSCRIBE": "l", "SC_CUDA_PATH_SET": "1",
        "MIN_FREE_MIB": "0", "PYTHONPATH": "/x", "PYTHONSTARTUP": "/y", "LD_PRELOAD": "/z.so", "path": "lower", "Home": "mixed",
    }
    assert process.child_env({**environ, **secrets}) == environ
    assert set(environ) == process.CHILD_ENV_NAMES
    assert process.child_env({}) == {}


class FakeProcess:
    pid = 424242

    def __init__(self, outcomes: list[Any]) -> None:
        self.outcomes, self.returncode, self.waited = outcomes, 0, 0

    def communicate(self, timeout: float | None = None) -> tuple[str, None]:
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome, None

    def wait(self) -> int:
        self.waited += 1
        return -9


class FakePopen:
    def __init__(self, *outcomes: Any) -> None:
        self.process = FakeProcess(list(outcomes))
        self.calls: list[dict[str, Any]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> FakeProcess:
        self.calls.append({"argv": argv, **kwargs})
        return self.process


def test_the_child_runs_in_its_own_group_and_dies_with_this_process():
    popen, kills = FakePopen("all output\n"), []
    done = process.run_group(["tool", "arg"], cwd="/work", env={"PATH": "/usr/bin"}, timeout=7, popen=popen,
                             kill=lambda pid, sig: kills.append((pid, sig)))
    assert (done.returncode, done.stdout, kills) == (0, "all output\n", [])
    call = popen.calls[0]
    assert call["argv"] == ["tool", "arg"] and call["cwd"] == "/work" and call["env"] == {"PATH": "/usr/bin"}
    assert call["start_new_session"] is True and call["stdin"] == subprocess.DEVNULL
    assert call["stdout"] == subprocess.PIPE and call["stderr"] == subprocess.STDOUT
    assert "shell" not in call
    assert callable(call["preexec_fn"])  # Linux: the kernel kills the child when this process dies


def test_the_time_limit_kills_the_whole_group():
    popen, kills = FakePopen(subprocess.TimeoutExpired(["tool"], 7), "partial output\n"), []
    with pytest.raises(subprocess.TimeoutExpired) as caught:
        process.run_group(["tool"], cwd="/work", env={}, timeout=7, popen=popen, kill=lambda pid, sig: kills.append((pid, sig)))
    assert kills == [(424242, signal.SIGKILL)] and caught.value.output == "partial output\n"


@pytest.mark.parametrize("error", [process.Terminated(signal.SIGTERM), process.Terminated(signal.SIGHUP), KeyboardInterrupt()])
def test_a_stop_of_this_tool_kills_the_whole_group(error: BaseException):
    popen, kills = FakePopen(error), []
    with pytest.raises(type(error)):
        process.run_group(["tool"], cwd="/work", env={}, timeout=7, popen=popen, kill=lambda pid, sig: kills.append((pid, sig)))
    assert kills == [(424242, signal.SIGKILL)] and popen.process.waited == 1


def test_a_group_that_is_gone_is_not_an_error():
    def gone(pid: int, sig: int) -> None:
        raise ProcessLookupError

    process.kill_group(FakeProcess([]), gone)


def test_stop_signals_raise_terminated_once_and_the_old_handlers_come_back():
    installed: dict[int, Any] = {signal.SIGTERM: "old-term", signal.SIGHUP: "old-hup"}
    log: list[tuple[int, Any]] = []

    def install(signum: int, handler: Any) -> Any:
        log.append((signum, handler))
        before, installed[signum] = installed[signum], handler
        return before

    with pytest.raises(process.Terminated) as caught:
        with process.exit_on_signals(install):
            handler = installed[signal.SIGTERM]
            assert callable(handler) and installed[signal.SIGHUP] is handler
            handler(signal.SIGTERM, None)
    assert caught.value.code == 143 and caught.value.signum == signal.SIGTERM and isinstance(caught.value, SystemExit)
    # After the first signal both are ignored, so the cleanup is not cut short; then the old handlers are back.
    assert log[2:4] == [(signal.SIGTERM, signal.SIG_IGN), (signal.SIGHUP, signal.SIG_IGN)]
    assert installed == {signal.SIGTERM: "old-term", signal.SIGHUP: "old-hup"}
    assert process.Terminated(signal.SIGHUP).code == 129


def test_without_a_signal_the_block_runs_and_the_handlers_come_back():
    before = {name: signal.getsignal(name) for name in process.STOP_SIGNALS}
    with process.exit_on_signals():
        assert all(signal.getsignal(name) is not before[name] for name in process.STOP_SIGNALS)
    assert {name: signal.getsignal(name) for name in process.STOP_SIGNALS} == before

    def refuse(signum: int, handler: Any) -> Any:
        raise ValueError("signal only works in main thread")

    with process.exit_on_signals(refuse):  # outside the main thread the block still runs
        pass


PARENT = """
import shutil, sys
from pathlib import Path
from market_notes import process
work = Path(sys.argv[1])
work.mkdir()
child = "import os, sys, time; open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(120)"
try:
    with process.exit_on_signals():
        try:
            process.run_group([sys.executable, "-c", child, sys.argv[2]], cwd=str(work), env={}, timeout=120)
        finally:
            shutil.rmtree(work)
except process.Terminated as stop:
    print("terminated", stop.code, flush=True)
    raise
"""


def alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


def start_parent(tmp_path: Path) -> tuple[subprocess.Popen[str], int, Path]:
    work, pid_file = tmp_path / "work", tmp_path / "child.pid"
    parent = subprocess.Popen([sys.executable, "-c", PARENT, str(work), str(pid_file)], cwd=RESEARCH, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              env={"PYTHONPATH": str(RESEARCH), "PYTHONDONTWRITEBYTECODE": "1", "PATH": os.environ.get("PATH", "")})
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not (pid_file.exists() and pid_file.read_text().strip()):
        assert parent.poll() is None, parent.stdout.read() if parent.stdout else ""
        time.sleep(0.02)
    return parent, int(pid_file.read_text()), work


def wait_until_dead(pid: int, seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.02)
    return False


@pytest.mark.parametrize("stop", [signal.SIGTERM, signal.SIGHUP])
def test_sigterm_and_sighup_end_the_child_and_remove_the_work_directory(tmp_path: Path, stop: signal.Signals):
    parent, child, work = start_parent(tmp_path)
    try:
        assert alive(child) and work.is_dir()
        parent.send_signal(stop)
        output, _ = parent.communicate(timeout=20)
        assert parent.returncode == 128 + stop and f"terminated {128 + stop}" in output
        assert wait_until_dead(child) and not work.exists()
    finally:
        parent.kill()
        if alive(child):
            os.kill(child, signal.SIGKILL)


def test_sigkill_of_the_tool_still_ends_the_child(tmp_path: Path):
    parent, child, _work = start_parent(tmp_path)
    try:
        assert alive(child)
        parent.kill()  # SIGKILL: no handler and no finally block runs
        parent.communicate(timeout=20)
        assert wait_until_dead(child), "the child outlived its killed parent"
    finally:
        if alive(child):
            os.kill(child, signal.SIGKILL)
