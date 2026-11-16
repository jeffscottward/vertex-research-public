"""Net drift download: request bodies, plan, pacing, retries, resume and the script. Fake post and sleep; no network."""
from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
from pathlib import Path

import pytest

from strategies.flow_control import data, download
from strategies.imom.data import ms_at

REPO = Path(__file__).resolve().parents[3]
GOLDEN = json.loads((REPO / "packages" / "api" / "src" / "fixtures" / "flow-control-golden.fixture.json").read_text())
SCRIPT = REPO / "research" / "backtests" / "flow-control-continuation" / "fetch_net_drift.py"
DAY = "2025-06-03"
KEY = "secret-key-123"


def script():
    spec = importlib.util.spec_from_file_location("flow_control_fetch", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def body_with_data(day=DAY) -> dict:
    return {"data": {str(int(ms_at(day, 570))): {"netCallPremium": 1, "netPutPremium": 2, "netCallVolume": 3,
                                                  "netPutVolume": 4, "stockPrice": 5.0}}}


class FakePost:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, body):
        self.calls.append(body)
        item = self.responses.pop(0) if self.responses else (200, body_with_data(body["sessionDate"]), {})
        return item


def run(items, root, post, logs=None):
    sleeps: list[float] = []
    out = download.fetch_all(items, root, post, sleeps.append, (logs if logs is not None else []).append)
    return out, sleeps


def test_request_bodies_equal_the_fixture_header():
    assert download.NET_DRIFT_REQUESTS == GOLDEN["netDriftRequests"]


def test_filter_profile_equals_the_fixture_header():
    assert download.FILTER_PROFILE == GOLDEN["filterProfile"]


def test_request_body_fills_day_and_ticker():
    body = download.request_body("zero_dte", DAY, "SPY")
    assert body["sessionDate"] == DAY and body["filter"]["tickers"] == ["SPY"]
    assert download.NET_DRIFT_REQUESTS["zero_dte"]["sessionDate"] == "YYYY-MM-DD"


def test_plan_marks_data_empty_and_pending_and_skips_weekends_and_closed_days(tmp_path):
    path = data.bucket_path(tmp_path, "SPY", "total", "2025-07-03")
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(body_with_data("2025-07-03")["data"]))
    empty = data.bucket_path(tmp_path, "SPX", "total", "2025-07-03")
    empty.parent.mkdir(parents=True)
    empty.write_text("{}")
    broken = data.bucket_path(tmp_path, "QQQ", "total", "2025-07-03")
    broken.parent.mkdir(parents=True)
    broken.write_text("{bad")
    items = download.plan(tmp_path, "2025-07-07", "2025-07-02")
    days = sorted({item[2] for item in items}, reverse=True)
    assert days == ["2025-07-07", "2025-07-03", "2025-07-02"]  # 4th closed, 5th and 6th weekend
    assert items[0][2] == "2025-07-07" and len(items) == 3 * 4 * 2
    status = {(t, p, d): s for t, p, d, s in items}
    assert status[("SPY", "total", "2025-07-03")] == "data"
    assert status[("SPX", "total", "2025-07-03")] == "empty"
    assert status[("QQQ", "total", "2025-07-03")] == "pending"


def test_writes_through_a_temporary_file(tmp_path):
    out, _ = run([("SPY", "total", DAY, "pending")], tmp_path, FakePost([]))
    path = data.bucket_path(tmp_path, "SPY", "total", DAY)
    assert out["written"] == 1 and path.exists() and not path.with_name(path.name + ".tmp").exists()
    assert data.parse_part(path.read_text())


def test_rate_is_one_request_per_interval(tmp_path):
    items = [("SPY", "total", d, "pending") for d in ("2025-06-05", "2025-06-04", "2025-06-03")]
    out, sleeps = run(items, tmp_path, FakePost([]))
    assert out["written"] == 3 and sleeps == [download.REQUEST_INTERVAL_SECONDS] * 2


def test_429_waits_retry_after_then_retries(tmp_path):
    post = FakePost([(429, None, {"Retry-After": "7"})])
    out, sleeps = run([("SPY", "total", DAY, "pending")], tmp_path, post)
    assert out["written"] == 1 and 7.0 in sleeps and len(post.calls) == 2
    out, sleeps = run([("SPY", "total", "2025-06-04", "pending")], tmp_path, FakePost([(429, None, {})]))
    assert download.COOLDOWN_SECONDS in sleeps


def test_429_stops_after_max_retries_and_a_second_run_resumes(tmp_path):
    items = [("SPY", "total", "2025-06-04", "pending"), ("SPY", "total", DAY, "pending")]
    post = FakePost([(200, body_with_data("2025-06-04"), {})] + [(429, None, {})] * (download.MAX_RETRIES + 1))
    out, _ = run(items, tmp_path, post)
    assert out["stopped"] and out["pending"] == 1 and out["written"] == 1
    again = download.plan(tmp_path, "2025-06-04", DAY)
    pending = [item for item in again if item[3] == "pending"]
    assert ("SPY", "total", "2025-06-04", "data") in again
    out, _ = run([item for item in pending if item[0] == "SPY" and item[1] == "total"], tmp_path, FakePost([]))
    assert out["written"] == 1 and not out["stopped"]


def test_5xx_and_network_errors_retry_then_count_as_failed(tmp_path):
    post = FakePost([(503, None, {}), (0, None, {})])
    out, sleeps = run([("SPY", "total", DAY, "pending")], tmp_path, post)
    assert out["written"] == 1 and sleeps.count(download.ERROR_WAIT_SECONDS) == 2
    post = FakePost([(500, None, {})] * (download.MAX_RETRIES + 1))
    out, _ = run([("SPY", "total", "2025-06-04", "pending")], tmp_path, post)
    assert out["failed"] == 1 and len(post.calls) == download.MAX_RETRIES + 1


@pytest.mark.parametrize("code", [401, 403])
def test_401_and_403_raise_auth_error(tmp_path, code):
    with pytest.raises(download.AuthError):
        run([("SPY", "total", DAY, "pending")], tmp_path, FakePost([(code, None, {})]))


@pytest.mark.parametrize("response", [(200, None, {}), (200, {"nodata": 1}, {}),
                                      (200, {"data": {"1": {"x": 1}}}, {}), (418, None, {})])
def test_invalid_body_is_not_written_and_counts_as_failed(tmp_path, response):
    post = FakePost([response])
    out, _ = run([("SPY", "total", DAY, "pending")], tmp_path, post)
    assert out["failed"] == 1 and len(post.calls) == 1
    assert not data.bucket_path(tmp_path, "SPY", "total", DAY).exists()


def test_empty_sessions_end_a_ticker_part_and_existing_empty_files_count(tmp_path):
    days = download.trading_days("2025-05-01", "2025-06-30")[::-1]
    items = [("SPY", "total", d, "empty") for d in days[:3]]
    items += [("SPY", "total", d, "pending") for d in days[3:]]
    post = FakePost([(200, {"data": {}}, {})] * 20)
    out, _ = run(items, tmp_path, post)
    assert out["empty"] == download.EMPTY_STOP - 3 and len(post.calls) == download.EMPTY_STOP - 3
    assert out["dropped"] == len(days) - download.EMPTY_STOP
    assert data.bucket_path(tmp_path, "SPY", "total", days[3]).read_text() == "{}"


def test_refuses_a_folder_inside_the_repository(tmp_path):
    with pytest.raises(SystemExit):
        download.outside_repository(REPO / "x", REPO)
    with pytest.raises(SystemExit):
        download.outside_repository(REPO, REPO)
    assert download.outside_repository(tmp_path, REPO) == tmp_path.resolve()


def test_script_exit_codes_0_1_2(tmp_path):
    module = script()
    args = ["--data", str(tmp_path), "--from", DAY, "--to", DAY]
    env = {download.KEY_ENV: KEY}
    assert module.main(args, post_factory=lambda key: FakePost([]), sleep=lambda s: None, environ=env) == 0
    failing = lambda key: FakePost([(418, None, {})] * 8)  # noqa: E731
    assert module.main(["--data", str(tmp_path), "--from", "2025-06-04", "--to", "2025-06-04"],
                       post_factory=failing, sleep=lambda s: None, environ=env) == 1
    assert module.main(args, post_factory=lambda key: FakePost([]), sleep=lambda s: None, environ={}) == 2
    refused = lambda key: FakePost([(401, None, {})])  # noqa: E731
    assert module.main(["--data", str(tmp_path), "--from", "2025-06-05", "--to", "2025-06-05"],
                       post_factory=refused, sleep=lambda s: None, environ=env) == 2
    assert module.main(["--data", str(REPO / "tmp-data")], environ=env) == 2


def test_script_turns_http_and_network_errors_into_tuples(monkeypatch):
    module = script()
    post = module.make_post(KEY)

    def http_error(request, timeout):
        assert request.get_header("Authorization") == f"Bearer {KEY}" and timeout == download.REQUEST_TIMEOUT_SECONDS
        raise urllib.error.HTTPError(request.full_url, 429, "busy", {"Retry-After": "3"}, io.BytesIO(b""))

    monkeypatch.setattr(module.urllib.request, "urlopen", http_error)
    code, body, headers = post(download.request_body("total", DAY, "SPY"))
    assert (code, body, headers.get("Retry-After")) == (429, None, "3")

    def network_error(request, timeout):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(module.urllib.request, "urlopen", network_error)
    assert post({}) == (0, None, {})

    def timeout_error(request, timeout):
        raise TimeoutError()

    monkeypatch.setattr(module.urllib.request, "urlopen", timeout_error)
    assert post({}) == (0, None, {})


def test_no_log_line_holds_the_key_a_header_or_a_body(tmp_path, capsys):
    module = script()
    responses = lambda key: FakePost([(503, None, {}), (429, None, {"Retry-After": "0"}), (418, None, {})])  # noqa
    module.main(["--data", str(tmp_path), "--from", DAY, "--to", DAY], post_factory=responses,
                sleep=lambda s: None, environ={download.KEY_ENV: KEY})
    captured = capsys.readouterr()
    text = captured.out + captured.err
    assert KEY not in text and "Bearer" not in text and "sessionDate" not in text and "filterExpression" not in text


def test_dry_run_sends_nothing_and_prints_the_estimate(tmp_path, capsys):
    module = script()

    def no_post(key):
        raise AssertionError("dry run must not build a post")

    assert module.main(["--data", str(tmp_path), "--from", DAY, "--to", DAY, "--dry-run"], post_factory=no_post,
                       environ={}) == 0
    out = capsys.readouterr().out
    assert out.startswith("8 pending files of 8") and "hours" in out
