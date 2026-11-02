"""Process owner fence and atomic private lifecycle receipts; no trading state."""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import stat
import tempfile
from typing import Any

from .cache import HostUnavailable


def private_directory(path: Path) -> None:
    parent = path.parent
    info = parent.stat()
    if (not path.is_absolute() or parent.resolve() != parent or not parent.is_dir()
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        raise HostUnavailable("private-owned-local-state-directory-required")


class LocalOwnerFence:
    def __init__(self, path: str) -> None:
        self.path, self.fd, self.pid = Path(path), None, os.getpid()

    def open(self) -> None:
        if self.fd is not None:
            raise HostUnavailable("host-owner-already-open")
        private_directory(self.path)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != self.pid_uid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise HostUnavailable("unsafe-host-owner-fence")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd

    @staticmethod
    def pid_uid() -> int:
        return os.getuid()

    def is_current(self) -> bool:
        return self.fd is not None and self.pid == os.getpid()

    def close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def atomic_receipt(path: str, value: dict[str, Any], authority: Any) -> None:
    destination = Path(path)
    private_directory(destination)
    raw = authority.encode(value)
    if len(raw) > 65536:
        raise HostUnavailable("lifecycle-receipt-bound")
    fd, temporary = tempfile.mkstemp(prefix=".vertex-receipt-", dir=destination.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        # Replacement changes only the configured private receipt, never the
        # journal or caller-provided arbitrary paths.
        os.replace(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
