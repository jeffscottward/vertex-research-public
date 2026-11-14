"""HTTP client of the ``marketNotes`` oRPC procedures (rig intake and verification).

POST {VERTEX_API_URL}/api/orpc/marketNotes/<procedure> with body {"json": input} and the agent
API key in the x-api-key header (an operator's write key). ``VERTEX_ORIGIN`` is read when
``VERTEX_API_URL`` is not set. The safety rules are those of ``adapters.vertex_run_recorder``
and use its code: the request sends the base URL's origin (the server checks it on POST), plain
http is accepted only for a loopback host, and every redirect is refused, because urllib would
send the key to the new location. The key is never logged, printed or put into an error message.

Research only: a note is narrative context. No procedure here reads or changes an order, the arm
state, a size or a risk setting.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from typing import Any

# One implementation of the origin and redirect rules for both clients: a fix lands in both.
from adapters.vertex_run_recorder import _NO_REDIRECT_OPENER, _origin

API_KEY_ENV = "VERTEX_AGENT_API_KEY"
API_URL_ENVS = ("VERTEX_API_URL", "VERTEX_ORIGIN")
PROCEDURES = ("add", "get", "list", "recordChecks", "review")
# A note with its raw text is at most about 0.8 MB of JSON; a list holds 50 notes without raw text.
MAX_RESPONSE_BYTES = 8_000_000

Opener = Callable[..., Any]


class MarketNotesError(RuntimeError):
    """A failed call: the procedure, the HTTP status, the server's error code and its message."""

    def __init__(self, procedure: str, status: int, code: str, message: str = "") -> None:
        super().__init__(f"marketNotes.{procedure} failed: {status} {code} {message}".strip())
        self.procedure, self.status, self.code = procedure, status, code


class MarketNotesClient:
    """The five ``marketNotes`` procedures over HTTP with the standard library."""

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
        return f"MarketNotesClient({self._base!r})"

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ, **kwargs: Any) -> MarketNotesClient:
        base = next((environ[name] for name in API_URL_ENVS if environ.get(name)), "")
        key = environ.get(API_KEY_ENV, "")
        if not base or not key:
            raise ValueError(f"set {API_URL_ENVS[0]} (or {API_URL_ENVS[1]}) and {API_KEY_ENV} "
                             "to reach the market notes API")
        return cls(base, key, **kwargs)

    def _safe(self, text: str) -> str:
        return text.replace(self._key, "<hidden>")

    def _fail(self, procedure: str, status: int, code: str, message: str = "") -> MarketNotesError:
        return MarketNotesError(procedure, status, self._safe(code), self._safe(message))

    def _call(self, procedure: str, payload: Mapping[str, Any]) -> Any:
        if procedure not in PROCEDURES:
            raise ValueError(f"marketNotes.{procedure} is not a procedure of this client")
        request = urllib.request.Request(
            f"{self._base}/api/orpc/marketNotes/{procedure}",
            data=json.dumps({"json": payload}).encode(),
            headers={"content-type": "application/json", "origin": self._origin,
                     "x-api-key": self._key},
            method="POST",
        )
        try:
            with self._open(request, timeout=self._timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            if 300 <= error.code < 400:
                raise self._fail(procedure, error.code, "REDIRECT",
                                 f"redirects are refused; set {API_URL_ENVS[0]} to the final URL"
                                 ) from None
            raise self._fail(procedure, error.code, *_error_detail(error)) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise self._fail(procedure, 0, "UNREACHABLE", type(error).__name__) from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise self._fail(procedure, 0, "BAD_RESPONSE", "the answer is too large")
        try:
            body = json.loads(raw or b"{}")
        except ValueError:  # a body that is not JSON (a proxy page, a cut response)
            raise self._fail(procedure, 0, "BAD_RESPONSE", "the answer is not JSON") from None
        return body.get("json") if isinstance(body, dict) else None

    def _note(self, procedure: str, answer: Any) -> dict[str, Any]:
        note = answer.get("note") if isinstance(answer, dict) else None
        if not isinstance(note, dict) or not isinstance(note.get("id"), str) or not note["id"]:
            raise self._fail(procedure, 0, "BAD_RESPONSE", "the answer has no note")
        return note

    def list_notes(self, scope: str = "all", source_url: str | None = None) -> dict[str, Any]:
        """``{asOf, notes, today}``: notes newest first. ``source_url`` keeps the note of one source."""
        payload: dict[str, Any] = {"scope": scope}
        if source_url is not None:
            payload["sourceUrl"] = source_url
        answer = self._call("list", payload)
        notes = answer.get("notes") if isinstance(answer, dict) else None
        if not isinstance(notes, list) or any(not isinstance(note, dict) for note in notes):
            raise self._fail("list", 0, "BAD_RESPONSE", "the answer has no notes list")
        return answer

    def get(self, note_id: str) -> dict[str, Any]:
        """One note with its raw text."""
        return self._note("get", self._call("get", {"id": note_id}))

    def add(self, fields: Mapping[str, Any]) -> tuple[bool, dict[str, Any]]:
        """Store one note. Returns ``(created, note)``; ``created`` is false for a known source."""
        answer = self._call("add", fields)
        note = self._note("add", answer)
        if not isinstance(answer.get("created"), bool):
            raise self._fail("add", 0, "BAD_RESPONSE", "the answer does not say if a note was created")
        return answer["created"], note

    def record_checks(self, note_id: str, checks: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """Record ``{claimId, status, evidence}`` for claims of one note."""
        return self._note("recordChecks",
                          self._call("recordChecks", {"checks": list(checks), "id": note_id}))

    def review(self, note_id: str, action: Mapping[str, Any]) -> dict[str, Any]:
        """``{kind: "renew", reviewBy}`` or ``{kind: "retire"}``."""
        return self._note("review", self._call("review", {"action": dict(action), "id": note_id}))


def _error_detail(error: urllib.error.HTTPError) -> tuple[str, str]:
    """The server's error code and message, with the first input issues of a rejected request."""
    code, message = "HTTP_ERROR", ""
    try:
        body = json.loads(error.read(MAX_RESPONSE_BYTES) or b"{}")
        detail = body.get("json", body) if isinstance(body, dict) else {}
        if isinstance(detail, dict):
            code = str(detail.get("code") or code)[:64]
            message = str(detail.get("message") or "")[:300]
            data = detail.get("data")
            issues = data.get("issues") if isinstance(data, dict) else None
            if isinstance(issues, list):
                parts = [f"{'.'.join(str(step) for step in issue.get('path') or [])}: "
                         f"{issue.get('message')}"[:160]
                         for issue in issues[:3] if isinstance(issue, dict)]
                if parts:
                    message = f"{message} ({'; '.join(parts)})".strip()
    except (ValueError, OSError):
        pass
    return code, message
