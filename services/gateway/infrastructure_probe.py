"""Local-only infrastructure metadata probe; never a broker readiness check.

Native Python standard-library external-service exception. No HTTP service,
background loop, environment-file evaluation, password entry, or order path.
"""
import argparse
from collections import Counter
from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time
from types import MappingProxyType


COMMANDS = MappingProxyType({
    "hostname": "/bin/hostname",
    "os": "/usr/bin/uname -s",
    "user": "/usr/bin/id -un",
    "containers": "/usr/bin/docker --host unix:///var/run/docker.sock ps --all --format '{{.State}}'",
})
DEFAULT_CHECKS = tuple(COMMANDS)
CONNECT_TIMEOUT = 5
COMMAND_TIMEOUT = 12
TRUST_TIMEOUT = 3
MAX_OUTPUT = 16384
PROCESS_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
CONTAINER_STATES = frozenset({"created", "restarting", "running", "removing", "paused", "exited", "dead"})


def _result(state, reason, observations=None):
    return {"state": state, "reason": reason, "observations": observations or {},
            "brokerHandshake": "not_attempted", "recovery": "disabled", "trading": "disabled"}


def _safe_host(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 253:
        return False
    if re.fullmatch(r"[A-Za-z0-9.:-]+", value) is None:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        # Explicit fully qualified names only; never SSH aliases or option text.
        labels = value.split(".")
        return len(labels) >= 2 and all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in labels)


class _UnsafeFile(Exception):
    pass


class _OutputLimitExceeded(Exception):
    pass


def _safe_directory(info):
    # Sticky root-owned shared directories (notably /tmp) protect entries owned
    # by this user. A sticky bit on somebody else's directory is not sufficient.
    return (stat.S_ISDIR(info.st_mode) and info.st_uid in {0, os.getuid()}
            and (not info.st_mode & 0o022
                 or (info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX))))


@contextmanager
def _safe_file(value, identity=False):
    """Open through verified directory descriptors; pin the inode until exit.

    Linux parent-process fd paths survive OpenSSH's closing of inherited fds.
    Neither tool reopens the caller-supplied pathname; no trust/key is copied.
    """
    if not isinstance(value, str) or re.fullmatch(r"/[A-Za-z0-9_./-]+", value) is None:
        raise _UnsafeFile()
    path = Path(value)
    if path.anchor != "/" or str(path) != value or ".." in path.parts or len(path.parts) < 2:
        raise _UnsafeFile()
    directory_fd = file_fd = None
    try:
        try:
            directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            directory_fd = os.open("/", directory_flags)
            for part in path.parts[1:-1]:
                if not _safe_directory(os.fstat(directory_fd)):
                    raise _UnsafeFile()
                next_fd = os.open(part, directory_flags, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = next_fd
            if not _safe_directory(os.fstat(directory_fd)):
                raise _UnsafeFile()
            # Nonblocking open prevents an untrusted FIFO/device from hanging
            # before fstat can reject it as a non-regular file.
            file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                              dir_fd=directory_fd)
            info = os.fstat(file_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_size == 0 or info.st_mode & (0o077 if identity else 0o022)):
                raise _UnsafeFile()
            pinned_path = f"/proc/{os.getpid()}/fd/{file_fd}"
            pinned_info = os.stat(pinned_path)
            if (pinned_info.st_dev, pinned_info.st_ino) != (info.st_dev, info.st_ino):
                raise _UnsafeFile()
        except OSError:
            raise _UnsafeFile() from None
        yield pinned_path
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if directory_fd is not None:
            os.close(directory_fd)


def _valid_config(config):
    if not isinstance(config, dict) or set(config) != {"host", "user", "port", "known_hosts", "identity"}:
        return False
    return (_safe_host(config["host"])
            and isinstance(config["user"], str)
            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,31}", config["user"]) is not None
            and type(config["port"]) is int and 1 <= config["port"] <= 65535)


def _run(argv, timeout):
    # Read raw bytes fairly from both pipes. Each stream and their sum have the
    # same budget; at the boundary read only one byte to distinguish EOF/overflow.
    # Stderr is counted but never retained, returned, logged, or persisted.
    deadline = time.monotonic() + timeout
    with subprocess.Popen(argv, shell=False, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                          env=PROCESS_ENV, close_fds=True) as child:
        try:
            counts = [0, 0]
            total = 0
            stdout = bytearray()
            with selectors.DefaultSelector() as selector:
                for index, stream in enumerate((child.stdout, child.stderr)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, index)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired("metadata_probe", timeout)
                    for key, _ in selector.select(remaining):
                        index = key.data
                        size = min(4096, MAX_OUTPUT - counts[index] + 1, MAX_OUTPUT - total + 1)
                        try:
                            chunk = os.read(key.fd, size)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        counts[index] += len(chunk)
                        total += len(chunk)
                        if counts[index] > MAX_OUTPUT or total > MAX_OUTPUT:
                            raise _OutputLimitExceeded()
                        if index == 0:
                            stdout.extend(chunk)
            child.wait(timeout=max(0, deadline - time.monotonic()))
            return subprocess.CompletedProcess("metadata_probe", child.returncode,
                                               stdout.decode("utf-8", errors="replace"), "")
        except subprocess.TimeoutExpired:
            # wait() embeds argv by default; do not propagate it or partial data.
            raise subprocess.TimeoutExpired("metadata_probe", timeout) from None
        finally:
            # Only this Popen-owned child is signalled. No process groups, PID
            # discovery, retries, or output-draining communicate() on failure.
            if child.poll() is None:
                child.kill()
            child.wait()


def _trust_exists(config):
    host = config["host"] if config["port"] == 22 else f'[{config["host"]}]:{config["port"]}'
    response = _run(["/usr/bin/ssh-keygen", "-F", host, "-f", config["known_hosts"]], TRUST_TIMEOUT)
    # Handles hashed hosts; SSH still cryptographically verifies the exact key.
    return response.returncode == 0 and 0 < len(response.stdout.strip()) <= MAX_OUTPUT


def _ssh_argv(config, check):
    options = [
        "BatchMode=yes", "StrictHostKeyChecking=yes", "UpdateHostKeys=no",
        f'UserKnownHostsFile={config["known_hosts"]}', "GlobalKnownHostsFile=/dev/null",
        "VerifyHostKeyDNS=no", "IdentitiesOnly=yes", "IdentityAgent=none",
        "PreferredAuthentications=publickey", "PubkeyAuthentication=yes",
        "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
        "GSSAPIAuthentication=no", "HostbasedAuthentication=no",
        "NumberOfPasswordPrompts=0", f"ConnectTimeout={CONNECT_TIMEOUT}",
        "ConnectionAttempts=1", "ServerAliveInterval=3", "ServerAliveCountMax=1",
        "ProxyCommand=none", "ProxyJump=none", "PermitLocalCommand=no",
        "RemoteCommand=none", "RequestTTY=no", "ClearAllForwardings=yes",
        "ForwardAgent=no", "ForwardX11=no", "ControlMaster=no", "ControlPath=none",
        "ControlPersist=no", "LogLevel=ERROR",
    ]
    argv = ["/usr/bin/ssh", "-F", "/dev/null", "-n", "-T"]
    for option in options:
        argv.extend(["-o", option])
    argv.extend(["-i", config["identity"], "-p", str(config["port"]),
                 "-l", config["user"], "--", config["host"], COMMANDS[check]])
    return argv


def _metadata(check, output):
    if len(output) > MAX_OUTPUT:
        return None
    lines = output.splitlines()
    if check == "containers":
        if len(lines) > 1000 or any(line not in CONTAINER_STATES for line in lines):
            return None
        return {"state": "observed", "count": len(lines), "states": dict(sorted(Counter(lines).items()))}
    if len(lines) != 1 or re.fullmatch(r"[A-Za-z0-9_.-]{1,253}", lines[0]) is None:
        return None
    if check == "os":
        return {"state": "observed", "family": lines[0] if lines[0] in {"Linux", "Darwin", "FreeBSD", "OpenBSD"} else "other"}
    # Do not disclose hostnames, usernames, container identities, or remote text.
    return {"state": "observed"}


def probe_infrastructure(config, checks=DEFAULT_CHECKS, *, execute=False):
    """Return sanitized metadata only; explicit local execution is opt-in.

    Configuration is an exact dict of host/user/port/known_hosts/identity. It is
    never loaded from .env, the shell, SSH aliases, or a password-based fallback.
    There is no arbitrary command, SSH option, timeout, or environment input.
    """
    if execute is not True:
        return _result("unavailable", "probe_disabled")
    if not _valid_config(config):
        return _result("blocked", "invalid_configuration")
    if (not isinstance(checks, (tuple, list)) or not checks
            or any(not isinstance(check, str) or check not in COMMANDS for check in checks)
            or len(set(checks)) != len(checks)):
        return _result("blocked", "invalid_checks")
    observations = {}
    try:
        with _safe_file(config["known_hosts"]) as trust, _safe_file(config["identity"], identity=True) as identity:
            pinned_config = {**config, "known_hosts": trust, "identity": identity}
            if not _trust_exists(pinned_config):
                return _result("blocked", "host_trust_unverified")
            for check in checks:
                response = _run(_ssh_argv(pinned_config, check), COMMAND_TIMEOUT)
                if response.returncode != 0:
                    return _result("failed", "ssh_or_command_failed", observations)
                metadata = _metadata(check, response.stdout)
                if metadata is None:
                    return _result("failed", "unexpected_metadata", observations)
                observations[check] = metadata
    except _UnsafeFile:
        return _result("blocked", "invalid_configuration")
    except _OutputLimitExceeded:
        return _result("failed", "unexpected_metadata", observations)
    except subprocess.TimeoutExpired:
        return _result("timeout", "command_timeout", observations)
    except OSError:
        return _result("unavailable", "local_tool_unavailable", observations)
    return _result("observed", "metadata_only", observations)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally echoes untrusted argument values. Never do that here.
        raise ValueError("invalid_arguments")


def main(argv=None):
    parser = _Parser(description="Disabled-by-default metadata-only probe; never broker readiness.", allow_abbrev=False)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--host")
    parser.add_argument("--user")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--known-hosts")
    parser.add_argument("--identity")
    parser.add_argument("--check", action="append", choices=DEFAULT_CHECKS)
    try:
        args = parser.parse_args(argv)
    except ValueError:
        print(json.dumps(_result("blocked", "invalid_arguments"), sort_keys=True))
        return 2
    config = {"host": args.host, "user": args.user, "port": args.port,
              "known_hosts": args.known_hosts, "identity": args.identity}
    result = probe_infrastructure(config, args.check or DEFAULT_CHECKS, execute=args.execute)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["state"] == "observed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
