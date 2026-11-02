"""Vertex run recorder: stores framework runs through the agentModelRuns oRPC procedures.

POST {VERTEX_API_URL}/api/orpc/agentModelRuns/<procedure> with body {"json": input} and the agent
API key in the x-api-key header (an operator's write key). The server checks the Origin header on
POST, so the request sends the base URL's origin. Plain http is accepted only for a loopback host.
Redirects are refused, because urllib would send the key to the new location. The key is never logged, printed or put into an error message. Research only: a recorded rating is a
label and never reaches an order path.
"""
from __future__ import annotations

import ipaddress
import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlsplit

APPEND_MAX = 200
API_KEY_ENV = "VERTEX_AGENT_API_KEY"
API_URL_ENV = "VERTEX_API_URL"
LIST_MAX = 200

Opener = Callable[..., Any]


class RecorderError(RuntimeError):
    """A failed recorder call: the procedure, the HTTP status and the server's error code only."""

    def __init__(self, procedure: str, status: int, code: str, message: str = "") -> None:
        super().__init__(f"agentModelRuns.{procedure} failed: {status} {code} {message}".strip())
        self.procedure, self.status, self.code = procedure, status, code


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _origin(base_url: str) -> str:
    parts = urlsplit(base_url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"{API_URL_ENV} must be an http(s) URL")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError(f"{API_URL_ENV} must not carry credentials, a query or a fragment")
    if parts.scheme == "http" and not _is_loopback(parts.hostname):
        raise ValueError(f"{API_URL_ENV} must use https unless it points at this machine")
    return f"{parts.scheme}://{parts.netloc}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect: urllib would resend the x-api-key header to the new location."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any,
                         newurl: str) -> None:
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


class VertexRunRecorder:
    """RunRecorder over HTTP with the standard library (no new dependency)."""

    def __init__(self, base_url: str, api_key: str, *, opener: Opener = _NO_REDIRECT_OPENER.open,
                 timeout_s: float = 30.0) -> None:
        if not api_key:
            raise ValueError(f"{API_KEY_ENV} is empty")
        self._origin = _origin(base_url)
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._open = opener
        self._timeout = timeout_s

    def __repr__(self) -> str:  # never show the key
        return f"VertexRunRecorder({self._base!r})"

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ, **kwargs: Any) -> VertexRunRecorder:
        base, key = environ.get(API_URL_ENV, ""), environ.get(API_KEY_ENV, "")
        if not base or not key:
            raise ValueError(f"set {API_URL_ENV} and {API_KEY_ENV} to record runs")
        return cls(base, key, **kwargs)

    def _call(self, procedure: str, payload: Mapping[str, Any]) -> Any:
        request = urllib.request.Request(
            f"{self._base}/api/orpc/agentModelRuns/{procedure}",
            data=json.dumps({"json": payload}).encode(),
            headers={"content-type": "application/json", "origin": self._origin,
                     "x-api-key": self._key},
            method="POST",
        )
        try:
            with self._open(request, timeout=self._timeout) as response:
                body = json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            if 300 <= error.code < 400:
                raise RecorderError(procedure, error.code, "REDIRECT",
                                    "redirects are refused; set VERTEX_API_URL to the final URL"
                                    ) from None
            raise _error_of(procedure, error) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise RecorderError(procedure, 0, "UNREACHABLE", type(error).__name__) from None
        except ValueError:  # a body that is not JSON (a proxy page, a cut response)
            raise RecorderError(procedure, 0, "BAD_RESPONSE", "the answer is not JSON") from None
        return body.get("json") if isinstance(body, dict) else None

    def record(self, fields: Mapping[str, Any]) -> Mapping[str, Any]:
        stored = self._call("record", fields)
        if not isinstance(stored, dict) or not isinstance(stored.get("id"), str) or not stored["id"]:
            raise RecorderError("record", 0, "BAD_RESPONSE", "the stored run has no id")
        return stored

    def update(self, run_id: str, fields: Mapping[str, Any]) -> Mapping[str, Any]:
        return self._call("update", {**fields, "id": run_id})

    def append_events(self, run_id: str, events: Sequence[Mapping[str, Any]]) -> None:
        for start in range(0, len(events), APPEND_MAX):
            self._call("appendEvents", {"runId": run_id,
                                        "events": list(events[start:start + APPEND_MAX])})

    def count_finished(self, filters: Mapping[str, Any],
                       accept: Callable[[Mapping[str, Any]], bool] | None = None) -> int:
        page = self._call("list", {**filters, "status": ["succeeded"], "includeFacets": False,
                                   "limit": LIST_MAX})
        runs = page.get("runs") if isinstance(page, dict) else None
        if not isinstance(runs, list):
            return 0
        return sum(1 for run in runs
                   if isinstance(run, dict) and (accept is None or accept(run)))


def _error_of(procedure: str, error: urllib.error.HTTPError) -> RecorderError:
    code, message = "HTTP_ERROR", ""
    try:
        body = json.loads(error.read() or b"{}")
        detail = body.get("json", body) if isinstance(body, dict) else {}
        if isinstance(detail, dict):
            code = str(detail.get("code") or code)[:64]
            message = str(detail.get("message") or "")[:300]
    except (ValueError, OSError):
        pass
    return RecorderError(procedure, error.code, code, message)
