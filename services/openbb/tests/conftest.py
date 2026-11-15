"""Shared test helpers. No test touches the network: sockets are blocked for every test."""

from __future__ import annotations

import io
import json
import socket
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from vertex_openbb import cli  # noqa: E402
from vertex_openbb.upstream import ReplayUpstream  # noqa: E402

JOBS = sorted(cli.JOBS)
TEST_CONTACT = "fixtures@example.invalid"


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("network access is blocked in vertex_openbb tests")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def upstream_fixture(job: str) -> dict[str, Any]:
    return load(FIXTURES / "upstream" / f"{job}.json")


def output_fixture(job: str) -> dict[str, Any]:
    return load(FIXTURES / f"{job}.json")


class Result:
    def __init__(self, code: int, stdout: str, stderr: str) -> None:
        self.code = code
        self.stdout = stdout
        self.stderr = stderr

    @property
    def document(self) -> dict[str, Any]:
        def reject(constant: str) -> None:
            raise AssertionError(f"non-finite JSON constant {constant}")

        return json.loads(self.stdout, parse_constant=reject)

    def table(self, name: str) -> list[dict[str, Any]]:
        for table in self.document["tables"]:
            if table["table"] == name:
                return table["rows"]
        raise KeyError(name)


def run(
    argv: list[str],
    calls: list[dict[str, Any]] | None = None,
    *,
    today: date = date(2026, 11, 8),
    env: dict[str, str] | None = None,
    delay_s: float = 0.0,
    now: datetime | None = None,
) -> Result:
    out, err = io.StringIO(), io.StringIO()
    up = ReplayUpstream(calls or [], delay_s=delay_s)
    code = cli.run(argv, env=env if env is not None else {}, up=up, today=today, now=now, stdout=out, stderr=err)
    return Result(code, out.getvalue(), err.getvalue())


def replay_fixture(job: str) -> Result:
    fixture = upstream_fixture(job)
    return run(fixture["argv"], fixture["calls"], today=date.fromisoformat(fixture["today"]), env=fixture["env"])


def call(key: str, result: Any) -> dict[str, Any]:
    return {"key": key, "result": result}


def error(key: str, kind: str = "error", message: str = "boom") -> dict[str, Any]:
    return {"key": key, "error": {"kind": kind, "message": message}}
