"""Vertex run recorder over HTTP, with a fake opener (no network)."""
from __future__ import annotations

import http.server
import io
import json
import threading
import urllib.error
from typing import Any

import pytest

from adapters.vertex_run_recorder import RecorderError, VertexRunRecorder

KEY = "vx_agent_secret_value"


class FakeOpener:
    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float) -> Any:
        self.requests.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(json.dumps(response).encode())

    def body(self, index: int) -> Any:
        return json.loads(self.requests[index][0].data)


def recorder(opener: FakeOpener, url: str = "https://vertex.example.com/") -> VertexRunRecorder:
    return VertexRunRecorder(url, KEY, opener=opener, timeout_s=5)


def test_posts_the_input_with_the_key_and_origin_and_reads_the_output():
    opener = FakeOpener({"json": {"id": "run-1", "status": "queued"}}, {"json": {"id": "run-1"}})
    client = recorder(opener)
    assert client.record({"runKey": "k"}) == {"id": "run-1", "status": "queued"}
    client.update("run-1", {"status": "running"})
    request, timeout = opener.requests[0]
    assert request.full_url == "https://vertex.example.com/api/orpc/agentModelRuns/record"
    assert request.get_method() == "POST" and timeout == 5
    assert request.get_header("X-api-key") == KEY
    assert request.get_header("Origin") == "https://vertex.example.com"
    assert request.get_header("Content-type") == "application/json"
    assert opener.body(0) == {"json": {"runKey": "k"}}
    assert opener.body(1) == {"json": {"status": "running", "id": "run-1"}}
    assert KEY not in repr(client)


def test_appends_events_in_batches_of_200_and_counts_finished_runs():
    opener = FakeOpener(*([{"json": {"appended": 1}}] * 3),
                        {"json": {"runs": [{}, {}], "facets": {}}}, {"json": None}, [])
    client = recorder(opener)
    client.append_events("run-1", [{"seq": seq} for seq in range(450)])
    assert [len(opener.body(i)["json"]["events"]) for i in range(3)] == [200, 200, 50]
    assert opener.body(2)["json"]["events"][0] == {"seq": 400}
    assert client.count_finished({"batch": "grid-1", "ticker": ["AAPL"]}) == 2
    assert opener.body(3) == {"json": {"batch": "grid-1", "ticker": ["AAPL"],
                                       "status": ["succeeded"], "includeFacets": False,
                                       "limit": 200}}
    assert client.count_finished({}) == 0
    with pytest.raises(RecorderError) as no_id:
        client.record({})
    assert (no_id.value.code, no_id.value.status) == ("BAD_RESPONSE", 0)


def test_counts_only_the_runs_the_caller_accepts():
    runs = [{"variant": None}, {"variant": "fast"}, "not a run", {"variant": None}]
    opener = FakeOpener({"json": {"runs": runs}}, {"json": {"runs": runs}})
    client = recorder(opener)
    assert client.count_finished({}, lambda run: run.get("variant") is None) == 2
    assert client.count_finished({}) == 3


def test_a_body_that_is_not_json_is_a_recorder_error():
    class Raw(FakeOpener):
        def __call__(self, request: Any, timeout: float) -> Any:
            self.requests.append((request, timeout))
            return io.BytesIO(b"<html>proxy</html>")

    with pytest.raises(RecorderError) as bad:
        recorder(Raw()).update("run-1", {"status": "running"})
    assert (bad.value.code, bad.value.status) == ("BAD_RESPONSE", 0)
    assert KEY not in str(bad.value)


def test_refuses_redirects_so_the_key_never_reaches_another_location():
    seen: list[dict[str, str]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            seen.append({"path": self.path, "key": self.headers.get("x-api-key") or ""})
            self.rfile.read(int(self.headers.get("content-length") or 0))
            if self.path.startswith("/api/"):
                self.send_response(302)
                self.send_header("location", f"http://127.0.0.1:{port}/elsewhere")
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"json": {"id": "stolen"}}')

        do_GET = do_POST  # noqa: N815 - a followed 302 arrives as GET

        def log_message(self, *_: Any) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = VertexRunRecorder(f"http://127.0.0.1:{port}", KEY, timeout_s=5)
        with pytest.raises(RecorderError) as refused:
            client.record({"runKey": "k"})
    finally:
        server.shutdown()
    assert (refused.value.code, refused.value.status) == ("REDIRECT", 302)
    assert [hit["path"] for hit in seen] == ["/api/orpc/agentModelRuns/record"]


def test_reports_server_errors_by_code_without_the_key():
    def http_error(status: int, body: bytes) -> urllib.error.HTTPError:
        return urllib.error.HTTPError("https://vertex.example.com", status, "x", {},
                                      io.BytesIO(body))

    opener = FakeOpener(
        http_error(409, json.dumps({"json": {"code": "CONFLICT", "message": "final"}}).encode()),
        http_error(503, b"not json"),
        http_error(403, json.dumps({"error": "Forbidden"}).encode()),
        urllib.error.URLError("refused"),
        TimeoutError(),
    )
    client = recorder(opener)
    with pytest.raises(RecorderError) as conflict:
        client.update("run-1", {"status": "running"})
    assert (conflict.value.status, conflict.value.code) == (409, "CONFLICT")
    assert "final" in str(conflict.value) and KEY not in str(conflict.value)
    with pytest.raises(RecorderError) as unavailable:
        client.record({})
    assert (unavailable.value.status, unavailable.value.code) == (503, "HTTP_ERROR")
    with pytest.raises(RecorderError) as forbidden:
        client.record({})
    assert forbidden.value.code == "HTTP_ERROR" and forbidden.value.status == 403
    for _ in range(2):
        with pytest.raises(RecorderError) as down:
            client.record({})
        assert down.value.code == "UNREACHABLE" and down.value.status == 0


def test_accepts_https_or_a_loopback_http_url_only():
    assert recorder(FakeOpener(), "http://127.0.0.1:8787")._origin == "http://127.0.0.1:8787"
    assert recorder(FakeOpener(), "http://localhost:3000/")._origin == "http://localhost:3000"
    for bad in ("http://vertex.example.com", "ftp://vertex.example.com", "https://u:p@host",
                "https://host/?q=1", "not a url"):
        with pytest.raises(ValueError):
            recorder(FakeOpener(), bad)
    with pytest.raises(ValueError):
        VertexRunRecorder("https://host", "")


def test_reads_settings_from_the_environment():
    env = {"VERTEX_API_URL": "https://vertex.example.com", "VERTEX_AGENT_API_KEY": KEY}
    client = VertexRunRecorder.from_env(env, opener=FakeOpener())
    assert isinstance(client, VertexRunRecorder)
    with pytest.raises(ValueError, match="VERTEX_API_URL"):
        VertexRunRecorder.from_env({"VERTEX_API_URL": "https://vertex.example.com"})
