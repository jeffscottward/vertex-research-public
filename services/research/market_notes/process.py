"""Child processes of the market notes tool: a small environment, one process group, no orphan.

The tool starts two outside programs: yt-dlp and the GPU transcribe script. Each one

- gets only the variables of ``CHILD_ENV_NAMES`` (an allow-list: no key, token or database URL
  of this process can reach it);
- runs in a process group of its own, so the time limit ends the program and its children;
- ends when this tool ends: SIGTERM and SIGHUP raise ``Terminated`` (a ``SystemExit``), so the
  ``finally`` blocks kill the group and remove the temporary directories, and on Linux the
  kernel sends SIGKILL to the child when this process dies without that chance (SIGKILL).
"""
from __future__ import annotations

import contextlib
import ctypes
import os
import signal
import subprocess
import sys
from collections.abc import Callable, Iterator, Mapping
from typing import Any

# The only variables a child process receives. Proxy names are read in both letter cases.
CHILD_ENV_NAMES = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
})
STOP_SIGNALS = (signal.SIGTERM, signal.SIGHUP)
_PR_SET_PDEATHSIG = 1


def child_env(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment of a child process: the allow-listed variables of this process and no other."""
    source = os.environ if environ is None else environ
    return {name: value for name, value in source.items() if name in CHILD_ENV_NAMES}


class Terminated(SystemExit):
    """This process received SIGTERM or SIGHUP. The exit code is 128 + the signal number."""

    def __init__(self, signum: int) -> None:
        super().__init__(128 + signum)
        self.signum = signum


@contextlib.contextmanager
def exit_on_signals(install: Callable[[int, Any], Any] = signal.signal) -> Iterator[None]:
    """While the block runs, SIGTERM and SIGHUP raise ``Terminated`` in the main thread.

    The first signal raises; later ones are ignored, so the cleanup of the first is not cut
    short. The handlers of before are put back at the end. Outside the main thread the handlers
    cannot be set and the block runs without them.
    """
    def stop(signum: int, _frame: Any) -> None:
        for name in STOP_SIGNALS:
            install(name, signal.SIG_IGN)
        raise Terminated(signum)

    before: dict[int, Any] = {}
    try:
        try:
            for name in STOP_SIGNALS:
                before[name] = install(name, stop)
        except ValueError:  # not the main thread
            pass
        yield
    finally:
        for name, handler in before.items():
            install(name, handler)


def die_with_parent() -> Callable[[], None] | None:
    """A ``preexec_fn`` that asks the kernel to SIGKILL the child when this process dies.

    Linux only and best effort: None when ``prctl`` cannot be reached. The request stays in
    force when the child replaces itself with another program (``exec``).
    """
    if not sys.platform.startswith("linux"):
        return None
    try:
        prctl = ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return None
    parent = os.getpid()

    def request() -> None:
        prctl(_PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0)
        if os.getppid() != parent:  # the parent died before the request was in force
            os._exit(1)

    return request


def kill_group(process: Any, kill: Callable[[int, int], None] = os.killpg) -> None:
    """SIGKILL the process group of ``process`` (the program and every child it started)."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        kill(process.pid, signal.SIGKILL)


def run_group(argv: list[str], *, cwd: str, env: Mapping[str, str], timeout: float,
              popen: Callable[..., Any] = subprocess.Popen,
              kill: Callable[[int, int], None] = os.killpg) -> subprocess.CompletedProcess[str]:
    """Run ``argv`` in a process group of its own and return its exit code and merged output.

    The whole group is killed on the time limit (``subprocess.TimeoutExpired`` is raised with the
    output so far) and on any other exception, a stop signal of this tool included.
    """
    process = popen(argv, cwd=cwd, env=dict(env), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True,
                    preexec_fn=die_with_parent())
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as expired:
        kill_group(process, kill)
        output, _ = process.communicate()
        raise subprocess.TimeoutExpired(argv, timeout, output=output) from expired
    except BaseException:
        kill_group(process, kill)
        process.wait()
        raise
    return subprocess.CompletedProcess(argv, process.returncode, output, "")
