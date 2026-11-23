"""CME Group public FTP server: the files of the "Daily Volume and Open Interest" report.

Every FTP call of the service is in this module (the jobs do not import `ftplib`). One `CmeFtp`
holds one anonymous session in passive mode that opens on first use. After any failure the session
is closed, and the next file opens a new one. Nothing is retried: the job decides what a failure
means. The transfer is not encrypted and the file is public; the caller treats the bytes as
untrusted input.
"""

from __future__ import annotations

import contextlib
import ftplib
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from .upstream import UpstreamError

HOST = "ftp.cmegroup.com"
DIRECTORY = "/daily_volume"
# Every socket operation.
SOCKET_TIMEOUT_S = 30.0
# One RETR, checked in the data callback (below the 90 s limit of an upstream helper call).
MAX_TRANSFER_S = 60.0
# Counted in the data callback; the transfer stops when it is passed (a real file is about 100 kB).
MAX_FILE_BYTES = 2_000_000
# Before the second and each later RETR of one session.
PAUSE_S = 0.2
# RETR reply for a file that does not exist ("550 Failed to open file."): the day is not published.
NOT_PUBLISHED = "550"
MAX_REPLY_CHARS = 200


def file_name(day: date) -> str:
    return f"daily_volume_{day:%Y%m%d}.xlsx"


class _Stopped(Exception):
    """A limit of this module stopped the transfer."""


@dataclass
class _Session:
    ftp: ftplib.FTP
    transfers: int = 0
    # True while a call uses the session (from before the connect): `close` then sends no QUIT.
    busy: bool = True


def _text(exc: BaseException) -> str:
    return " ".join(str(exc).split())[:MAX_REPLY_CHARS]


def _host_error(exc: BaseException) -> UpstreamError:
    text = _text(exc)
    name = type(exc).__name__
    return UpstreamError("error", f"CME FTP {HOST}: {f'{name}: {text}' if text else name}")


def _shut(ftp: ftplib.FTP) -> None:
    """Close the sockets without a QUIT exchange (the session can be broken or in use)."""
    with contextlib.suppress(Exception):
        ftp.close()


class CmeFtp:
    """One FTP session to the CME server. Tests pass a fake FTP class, clock and sleep function."""

    def __init__(
        self,
        factory: Callable[..., ftplib.FTP] = ftplib.FTP,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._factory = factory
        self._clock = clock
        self._sleep = sleep
        self._session: _Session | None = None

    def workbook(self, day: date) -> bytes | None:
        """The bytes of the file for `day`; None when the server has no such file (not published)."""
        name = file_name(day)
        session = self._session or self._open()
        session.busy = True
        try:
            if session.transfers:
                self._sleep(PAUSE_S)
            session.transfers += 1
            return self._retrieve(session.ftp, name)
        except UpstreamError:
            self._drop(session)
            raise
        finally:
            session.busy = False

    def close(self) -> None:
        """End the session; never raises. A session that a call still uses gets no QUIT: the job
        calls this after a helper timeout, when the abandoned thread can still be in a transfer."""
        session, self._session = self._session, None
        if session is None:
            return
        if not session.busy:
            try:
                session.ftp.quit()
            except Exception:  # noqa: BLE001 - a failed QUIT must not fail the run
                pass
            else:
                return
        _shut(session.ftp)

    def _open(self) -> _Session:
        ftp = self._factory(timeout=SOCKET_TIMEOUT_S)
        # Stored before the connect, so `close` reaches a session that is still opening.
        session = _Session(ftp)
        self._session = session
        try:
            ftp.connect(HOST)
            ftp.login()
            ftp.set_pasv(True)
            ftp.cwd(DIRECTORY)
        except ftplib.all_errors as exc:
            self._drop(session)
            raise _host_error(exc) from exc
        return session

    def _drop(self, session: _Session) -> None:
        # Only its own session: an abandoned call that fails late must not close the session of
        # the call that runs now.
        if self._session is session:
            self._session = None
        _shut(session.ftp)

    def _retrieve(self, ftp: ftplib.FTP, name: str) -> bytes | None:
        chunks: list[bytes] = []
        size = 0
        started = self._clock()

        def take(chunk: bytes) -> None:
            nonlocal size
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise _Stopped(f"larger than {MAX_FILE_BYTES} bytes")
            if self._clock() - started > MAX_TRANSFER_S:
                raise _Stopped(f"transfer took more than {MAX_TRANSFER_S:.0f} s")
            chunks.append(chunk)

        try:
            ftp.retrbinary(f"RETR {name}", take)
        except _Stopped as exc:
            raise UpstreamError("error", f"CME FTP {name}: {exc}") from exc
        except ftplib.Error as exc:
            reply = _text(exc)
            if reply.startswith(NOT_PUBLISHED):
                return None
            raise UpstreamError("error", f"CME FTP {name}: {reply}") from exc
        except (OSError, EOFError) as exc:
            raise _host_error(exc) from exc
        return b"".join(chunks)
