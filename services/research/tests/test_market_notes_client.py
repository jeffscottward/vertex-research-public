"""Market notes HTTP client with a fake opener (no network)."""
from __future__ import annotations

import http.server
import io
import json
import threading
import urllib.error
from typing import Any

import pytest

from market_notes.client import MarketNotesClient, MarketNotesError

KEY = "vx_agent_secret_value"
NOTE = {"id": "mn_1", "theme": "t", "claims": []}


class FakeOpener:
    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float) -> Any:
        self.requests.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(response if isinstance(response, bytes) else json.dumps(response).encode())

    def body(self, index: int) -> Any:
        return json.loads(self.requests[index][0].data)


def client(opener: FakeOpener, url: str = "https://vertex.example.com/") -> MarketNotesClient:
    return MarketNotesClient(url, KEY, opener=opener, timeout_s=5)


def http_error(status: int, body: Any) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://vertex.example.com/x", status, "error", {},  # type: ignore[arg-type]
                                  io.BytesIO(json.dumps(body).encode()))


def test_posts_each_procedure_with_the_key_and_the_origin():
    opener = FakeOpener({"json": {"asOf": "2026-11-11T10:00:00Z", "notes": [NOTE], "today": "2026-11-11"}},
                        {"json": {"created": True, "note": NOTE}}, {"json": {"note": NOTE}},
                        {"json": {"note": NOTE}}, {"json": {"note": NOTE}})
    api = client(opener)
    assert api.list_notes(scope="all", source_url="https://youtu.be/abc")["notes"] == [NOTE]
    assert api.add({"theme": "t"}) == (True, NOTE)
    assert api.get("mn_1") == NOTE
    assert api.record_checks("mn_1", [{"claimId": "c1", "evidence": "e", "status": "supported"}]) == NOTE
    assert api.review("mn_1", {"kind": "retire"}) == NOTE
    paths = [request.full_url.removeprefix("https://vertex.example.com/api/orpc/marketNotes/")
             for request, _timeout in opener.requests]
    assert paths == ["list", "add", "get", "recordChecks", "review"]
    for request, timeout in opener.requests:
        assert request.get_method() == "POST" and timeout == 5
        assert request.get_header("X-api-key") == KEY
        assert request.get_header("Origin") == "https://vertex.example.com"
        assert request.get_header("Content-type") == "application/json"
        # The key travels in one header only: not in another header, the URL or the body.
        assert sorted(name.lower() for name in request.headers) == ["content-type", "origin", "x-api-key"]
        assert KEY not in request.full_url and KEY.encode() not in request.data
    assert opener.body(0) == {"json": {"scope": "all", "sourceUrl": "https://youtu.be/abc"}}
    assert opener.body(1) == {"json": {"theme": "t"}}
    assert opener.body(2) == {"json": {"id": "mn_1"}}
    assert opener.body(3) == {"json": {"checks": [{"claimId": "c1", "evidence": "e", "status": "supported"}],
                                       "id": "mn_1"}}
    assert opener.body(4) == {"json": {"action": {"kind": "retire"}, "id": "mn_1"}}
    assert KEY not in repr(api)


def test_list_without_a_source_url_sends_the_scope_only():
    opener = FakeOpener({"json": {"asOf": "x", "notes": [], "today": "2026-11-11"}})
    client(opener).list_notes(scope="active")
    assert opener.body(0) == {"json": {"scope": "active"}}


def test_reads_the_url_from_either_variable_and_needs_the_key():
    for name in ("VERTEX_API_URL", "VERTEX_ORIGIN"):
        made = MarketNotesClient.from_env({name: "https://vertex.example.com", "VERTEX_AGENT_API_KEY": KEY},
                                          opener=FakeOpener())
        assert repr(made) == "MarketNotesClient('https://vertex.example.com')"
    first = MarketNotesClient.from_env({"VERTEX_API_URL": "https://a.example.com", "VERTEX_ORIGIN": "https://b.example.com",
                                        "VERTEX_AGENT_API_KEY": KEY})
    assert "a.example.com" in repr(first)
    for environ in ({}, {"VERTEX_API_URL": "https://vertex.example.com"}, {"VERTEX_AGENT_API_KEY": KEY}):
        with pytest.raises(ValueError, match="VERTEX_API_URL") as caught:
            MarketNotesClient.from_env(environ)
        assert KEY not in str(caught.value)


@pytest.mark.parametrize("url", ["http://vertex.example.com", "ftp://vertex.example.com", "vertex.example.com",
                                 "https://user:pass@vertex.example.com", "https://vertex.example.com/?a=1"])
def test_refuses_a_base_url_that_could_leak_the_key(url: str):
    with pytest.raises(ValueError):
        MarketNotesClient(url, KEY)


def test_plain_http_is_accepted_for_this_machine_only():
    for url in ("http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"):
        MarketNotesClient(url, KEY)
    with pytest.raises(ValueError):
        MarketNotesClient("https://vertex.example.com", "")


def test_maps_a_server_error_to_its_code_and_message_without_the_key():
    opener = FakeOpener(
        http_error(404, {"json": {"code": "NOT_FOUND", "message": "Market note not found"}}),
        http_error(400, {"json": {"code": "BAD_REQUEST", "message": "Invalid request",
                                  "data": {"issues": [{"path": ["reviewBy"], "message": "reviewBy must not be before asOf"}]}}}),
        http_error(401, {"json": {"code": "UNAUTHORIZED", "message": f"bad key {KEY}"}}),
        urllib.error.HTTPError("https://vertex.example.com/x", 502, "bad gateway", {}, io.BytesIO(b"<html>")),  # type: ignore[arg-type]
        urllib.error.URLError(f"no route with {KEY}"), TimeoutError(), b"<html>proxy page</html>",
        {"json": {"note": {"theme": "no id"}}}, {"json": {"notes": "not a list"}}, {"json": {"note": NOTE}})
    api = client(opener)
    expected = [(404, "NOT_FOUND", "Market note not found"),
                (400, "BAD_REQUEST", "reviewBy: reviewBy must not be before asOf"),
                (401, "UNAUTHORIZED", "bad key <hidden>"), (502, "HTTP_ERROR", ""),
                (0, "UNREACHABLE", "URLError"), (0, "UNREACHABLE", "TimeoutError"),
                (0, "BAD_RESPONSE", "not JSON"), (0, "BAD_RESPONSE", "no note")]
    for status, code, text in expected:
        with pytest.raises(MarketNotesError) as caught:
            api.get("mn_1")
        assert (caught.value.status, caught.value.code, caught.value.procedure) == (status, code, "get")
        assert text in str(caught.value) and KEY not in str(caught.value)
        assert str(caught.value).startswith("marketNotes.get failed:")
    with pytest.raises(MarketNotesError, match="no notes list"):
        api.list_notes()
    with pytest.raises(MarketNotesError, match="does not say if a note was created"):
        api.add({})


def test_refuses_a_procedure_outside_the_market_notes_set():
    opener = FakeOpener()
    with pytest.raises(ValueError):
        client(opener)._call("submitOrder", {})
    assert opener.requests == []


def test_a_redirect_is_refused_and_the_key_never_reaches_the_new_location():
    seen: list[dict[str, Any]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            seen.append({"path": self.path, "key": self.headers.get("x-api-key")})
            self.rfile.read(int(self.headers.get("content-length") or 0))
            self.send_response(307)
            self.send_header("location", f"http://127.0.0.1:{self.server.server_address[1]}/elsewhere")
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, *args: Any) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        api = MarketNotesClient(f"http://127.0.0.1:{server.server_address[1]}", KEY, timeout_s=5)
        with pytest.raises(MarketNotesError) as caught:
            api.list_notes()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert (caught.value.status, caught.value.code) == (307, "REDIRECT")
    assert KEY not in str(caught.value)
    assert [hit["path"] for hit in seen] == ["/api/orpc/marketNotes/list"]
