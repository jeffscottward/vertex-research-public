"""Market notes CLI: add (reel, article, text), list, check, renew, retire. Fakes only: no network, GPU or model."""
from __future__ import annotations

import io
import json
import os
import signal
import socket
import subprocess
import time
from datetime import date
from email.message import Message
from pathlib import Path
from typing import Any

import pytest

from market_notes import cli
from market_notes.client import MarketNotesClient, MarketNotesError

KEY = "vx_agent_secret_value"
ENV = {"VERTEX_API_URL": "https://vertex.example.com", "VERTEX_AGENT_API_KEY": KEY}
REEL = "https://www.instagram.com/reel/DfmxTYzBO1s/"
TODAY = date(2026, 11, 11)
ANSWER = {
    "theme": "AI capex is close to a peak",
    "claims": ["Microsoft capital expenditure rose year over year in the quarter that ended 2026-09-30.",
               "Meta free cash flow fell year over year in the quarter that ended 2026-09-30."],
    "affected": {"sectors": ["Semiconductors"], "tickers": ["MSFT", "META"], "strategies": []},
    "stance": {"direction": "risk-off", "confidence": "medium"},
}
SCRIPT = ('MIN_FREE_MIB = 4096\nwhile free_mib() < MIN_FREE_MIB:\n    wait()\n'
          'model = WhisperModel("large-v3", device="cuda", compute_type="int8_float16")\n')


def public_names(host: str, port: int, **options: Any) -> list[Any]:
    """A fake resolver: every host has one public address. No DNS request."""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


class FakeClient:
    """An in-memory stand-in for the marketNotes procedures."""

    def __init__(self, notes: list[dict[str, Any]] | None = None, fail: Exception | None = None,
                 filters_scope: bool = True) -> None:
        self.notes, self.fail, self.filters_scope = list(notes or []), fail, filters_scope
        self.calls: list[tuple[Any, ...]] = []

    def _find(self, note_id: str) -> dict[str, Any]:
        for note in self.notes:
            if note["id"] == note_id:
                return note
        raise MarketNotesError("get", 404, "NOT_FOUND", "Market note not found")

    def list_notes(self, scope: str = "all", source_url: str | None = None) -> dict[str, Any]:
        self.calls.append(("list", scope, source_url))
        if self.fail is not None:
            raise self.fail
        notes = [note for note in self.notes
                 if (source_url is None or note["source"]["url"] == source_url)
                 and (scope == "all" or note["status"] == "active" or not self.filters_scope)]
        return {"asOf": "2026-11-11T15:00:00.000Z", "notes": notes, "today": "2026-11-11"}

    def add(self, fields: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        self.calls.append(("add", fields))
        for note in self.notes:
            if note["rawText"] == fields["rawText"] and note["source"]["url"] is None and fields["source"]["url"] is None:
                return False, note
        note = {**fields, "id": f"mn_{len(self.notes) + 1}", "status": "active", "receivedAt": "2026-11-11T15:00:00.000Z",
                "updatedAt": "2026-11-11T15:00:00.000Z",
                "claims": [{"id": f"c{index}", "text": text, "status": "unverified", "evidence": None, "checkedAt": None}
                           for index, text in enumerate(fields["claims"], 1)],
                "verification": {"cannotCheck": 0, "checked": False, "contradicted": 0, "supported": 0,
                                 "unverified": len(fields["claims"])}}
        self.notes.append(note)
        return True, note

    def record_checks(self, note_id: str, checks: list[dict[str, Any]]) -> dict[str, Any]:
        self.calls.append(("recordChecks", note_id, checks))
        note = self._find(note_id)
        if note["status"] == "retired":
            raise MarketNotesError("recordChecks", 400, "BAD_REQUEST", "A retired note takes no checks")
        for check in checks:
            claim = next(claim for claim in note["claims"] if claim["id"] == check["claimId"])
            claim.update(status=check["status"], evidence=check["evidence"], checkedAt="2026-11-11T16:00:00.000Z")
        statuses = [claim["status"] for claim in note["claims"]]
        note["verification"] = {"cannotCheck": statuses.count("cannot-check"), "checked": "unverified" not in statuses,
                                "contradicted": statuses.count("contradicted"), "supported": statuses.count("supported"),
                                "unverified": statuses.count("unverified")}
        return note

    def review(self, note_id: str, action: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("review", note_id, action))
        note = self._find(note_id)
        if action["kind"] == "retire":
            note["status"] = "retired"
        else:
            note.update(reviewBy=action["reviewBy"], status="active")
        return note


class FakeGenerator:
    def __init__(self, answer: Any = ANSWER) -> None:
        self.answer, self.prompts = answer, []

    def generate(self, name: str, prompt: str) -> Any:
        self.prompts.append(prompt)
        if isinstance(self.answer, Exception):
            raise self.answer
        return json.loads(json.dumps(self.answer))


class FakeDownload:
    def __init__(self, info: dict[str, Any] | None = None) -> None:
        self.info = {"id": "DfmxTYzBO1s", "uploader": "Jane Doe", "upload_date": "20261110"} if info is None else info
        self.calls: list[dict[str, Any]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"argv": argv, **kwargs})
        (Path(kwargs["cwd"]) / "note.m4a").write_bytes(b"audio")
        (Path(kwargs["cwd"]) / "note.info.json").write_text(json.dumps(self.info), encoding="utf-8")
        return subprocess.CompletedProcess(argv, 0, "", "")


class FakeGpu:
    def __init__(self, record: Any = None, raises: BaseException | None = None) -> None:
        self.record = record or {"text": "Capex at the hyperscalers is near a peak.", "language": "en", "duration": 60.0,
                                 "model": {"id": "Systran/faster-whisper-large-v3", "device": "cuda"}}
        self.raises, self.calls = raises, []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"argv": argv, **kwargs})
        if self.raises is not None:
            raise self.raises
        work = Path(kwargs["cwd"])
        audio, = (work / "media" / "note").glob("*.m4a")
        target = work / "transcripts" / "note" / f"{audio.stem}.json"
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps(self.record), encoding="utf-8")
        return subprocess.CompletedProcess(argv, 0, "DONE transcribed 1\n", "")


class FakeArticle(io.BytesIO):
    def __init__(self, body: bytes) -> None:
        super().__init__(body)
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"


class Rig:
    """One CLI run with every outside dependency replaced."""

    def __init__(self, tmp_path: Path, client: FakeClient | None = None, **deps: Any) -> None:
        self.client = client or FakeClient()
        self.generator, self.download, self.gpu = FakeGenerator(), FakeDownload(), FakeGpu()
        self.article_requests: list[Any] = []
        self.article = ("<html><body><nav>menu</nav><article><p>" + "Hyperscaler capex rose in the quarter. " * 10
                        + "</p></article></body></html>").encode()
        script = tmp_path / "transcribe.py"
        script.write_text(SCRIPT, encoding="utf-8")
        python = tmp_path / "asr-python"
        python.write_text("", encoding="utf-8")
        self.environ = {**ENV, "VERTEX_MARKET_NOTE_TRANSCRIBE": str(script),
                        "VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON": str(python)}
        self.overrides = deps

    def _open_article(self, request: Any, timeout: float) -> Any:
        self.article_requests.append(request)
        return FakeArticle(self.article)

    def run(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        deps = cli.Deps(**{"client_factory": lambda environ: self.client, "download_run": self.download,
                           "transcribe_run": self.gpu, "article_opener": self._open_article, "resolve": public_names,
                           "generator_factory": lambda: self.generator, "today": lambda: TODAY, **self.overrides})
        code = cli.main(list(argv), environ=self.environ, stdout=out, stderr=err, deps=deps)
        assert KEY not in out.getvalue() and KEY not in err.getvalue()
        return code, out.getvalue(), err.getvalue()


@pytest.fixture()
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


def test_add_a_reel_downloads_transcribes_extracts_and_stores(rig: Rig):
    code, out, err = rig.run("add", REEL, "--owner-message", "https://chat.example.com/m/1")
    assert code == 0, err
    assert out.splitlines() == [
        "stored: mn_1", "theme: AI capex is close to a peak", "stance: risk-off (confidence medium)",
        "as of: 2026-11-10  review by: 2026-12-11  status: active", "claims:",
        "  c1 [unverified] Microsoft capital expenditure rose year over year in the quarter that ended 2026-09-30.",
        "  c2 [unverified] Meta free cash flow fell year over year in the quarter that ended 2026-09-30."]
    assert [call[0] for call in rig.client.calls] == ["list", "add"]
    assert rig.client.calls[0] == ("list", "all", REEL)
    assert rig.client.calls[1][1] == {
        "affected": {"sectors": ["Semiconductors"], "strategies": [], "tickers": ["MSFT", "META"]},
        "asOf": "2026-11-10", "claims": ANSWER["claims"], "ownerMessageUrl": "https://chat.example.com/m/1",
        "rawText": "Capex at the hyperscalers is near a peak.", "reviewBy": "2026-12-11",
        "source": {"author": "Jane Doe", "kind": "reel", "url": REEL},
        "stance": {"confidence": "medium", "direction": "risk-off"}, "theme": "AI capex is close to a peak"}
    # yt-dlp ran without cookies or a browser, the GPU tool ran once, and neither got the key.
    (download,), (gpu,) = rig.download.calls, rig.gpu.calls
    assert "--no-cookies" in download["argv"] and "--no-cookies-from-browser" in download["argv"]
    assert not any(arg.startswith("--cookies") for arg in download["argv"])
    assert "VERTEX_AGENT_API_KEY" not in download["env"] and "VERTEX_AGENT_API_KEY" not in gpu["env"]
    assert gpu["timeout"] == 1800 and len(gpu["argv"]) == 2
    assert not Path(download["cwd"]).exists() and not Path(gpu["cwd"]).exists()  # temporary folders are removed
    assert "Capex at the hyperscalers is near a peak." in rig.generator.prompts[0]
    assert "as-of date 2026-11-10 is the reel upload date" in err


def test_a_stored_link_is_reported_without_download_transcription_or_model(rig: Rig):
    assert rig.run("add", REEL)[0] == 0
    downloads, gpu_runs, prompts = len(rig.download.calls), len(rig.gpu.calls), len(rig.generator.prompts)
    code, out, _err = rig.run("add", REEL)
    assert code == 0 and out.splitlines()[0] == "already stored: mn_1"
    assert "theme: AI capex is close to a peak" in out and "  c1 [unverified]" in out
    assert (len(rig.download.calls), len(rig.gpu.calls), len(rig.generator.prompts)) == (downloads, gpu_runs, prompts)
    assert [call[0] for call in rig.client.calls] == ["list", "add", "list"] and len(rig.client.notes) == 1


def test_owner_text_is_stored_once(rig: Rig):
    text = "Owner view: the hyperscalers are close to peak capex.\nSecond line."
    code, out, _err = rig.run("add", text)
    assert code == 0 and out.startswith("stored: mn_1\n")
    assert [call[0] for call in rig.client.calls] == ["add"]  # no link, so no lookup by link
    fields = rig.client.calls[0][1]
    assert fields["source"] == {"author": None, "kind": "owner-text", "url": None} and fields["rawText"] == text
    assert (fields["asOf"], fields["reviewBy"], fields["ownerMessageUrl"]) == ("2026-11-11", "2026-12-11", None)
    assert rig.download.calls == [] and rig.gpu.calls == []
    code, out, _err = rig.run("add", text)
    assert code == 0 and out.startswith("already stored: mn_1\n") and len(rig.client.notes) == 1


def test_an_article_is_fetched_and_reduced_to_text(rig: Rig):
    url = "https://www.example.com/markets/capex"
    code, _out, err = rig.run("add", url, "--as-of", "2026-11-05", "--review-by", "2026-11-20", "--author", "Example News")
    assert code == 0, err
    fields = rig.client.calls[1][1]
    assert fields["source"] == {"author": "Example News", "kind": "article", "url": url}
    assert fields["rawText"].startswith("Hyperscaler capex rose") and "menu" not in fields["rawText"]
    assert (fields["asOf"], fields["reviewBy"]) == ("2026-11-05", "2026-11-20")
    assert [request.full_url for request in rig.article_requests] == [url]
    assert rig.article_requests[0].get_header("X-api-key") is None
    assert rig.download.calls == [] and rig.gpu.calls == []


def test_a_short_article_fails_and_points_to_the_transcript_file(rig: Rig):
    rig.article = b"<html><body><p>Subscribe to read.</p></body></html>"
    code, out, err = rig.run("add", "https://www.example.com/paywalled")
    assert (code, out) == (1, "") and "--transcript-file" in err and "under 200" in err
    assert [call[0] for call in rig.client.calls] == ["list"] and rig.generator.prompts == []


def test_a_transcript_file_skips_download_and_transcription(rig: Rig, tmp_path: Path):
    text = tmp_path / "reel.txt"
    text.write_text("  Transcribed by hand: capex is near a peak.\n", encoding="utf-8")
    code, _out, err = rig.run("add", REEL, "--transcript-file", str(text), "--author", "Jane Doe")
    assert code == 0, err
    fields = rig.client.calls[1][1]
    assert fields["rawText"] == "Transcribed by hand: capex is near a peak."
    assert fields["source"] == {"author": "Jane Doe", "kind": "reel", "url": REEL} and fields["asOf"] == "2026-11-11"
    assert rig.download.calls == [] and rig.gpu.calls == [] and rig.article_requests == []


def test_manual_theme_and_claims_skip_the_model(rig: Rig):
    code, out, err = rig.run("add", "Owner text about capex.", "--theme", "Peak capex", "--claim", "Capex rose 60% in 2026.",
                             "--claim", "Free cash flow fell at Meta.", "--stance", "risk-off", "--confidence", "low",
                             "--ticker", "meta", "--ticker", "MSFT", "--sector", "Cloud", "--strategy", "long index")
    assert code == 0, err
    assert rig.generator.prompts == []
    fields = rig.client.calls[0][1]
    assert fields["theme"] == "Peak capex" and fields["claims"] == ["Capex rose 60% in 2026.", "Free cash flow fell at Meta."]
    assert fields["affected"] == {"sectors": ["Cloud"], "strategies": ["long index"], "tickers": ["META", "MSFT"]}
    assert fields["stance"] == {"confidence": "low", "direction": "risk-off"}
    assert "  c2 [unverified] Free cash flow fell at Meta." in out


def test_flags_add_to_the_model_answer_and_replace_its_stance(rig: Rig):
    code, _out, err = rig.run("add", "Owner text about capex.", "--ticker", "NVDA", "--ticker", "MSFT", "--stance", "neutral")
    assert code == 0, err
    fields = rig.client.calls[0][1]
    assert fields["affected"]["tickers"] == ["NVDA", "MSFT", "META"]
    assert fields["stance"] == {"confidence": "medium", "direction": "neutral"}


def test_the_model_reads_at_most_24000_characters_but_the_whole_text_is_stored(rig: Rig):
    text = "capex " * 8_000
    assert rig.run("add", text)[0] == 0
    assert len(rig.client.calls[0][1]["rawText"]) == len(text.strip())
    assert "cut after 24,000 characters" in rig.generator.prompts[0]
    assert rig.generator.prompts[0].count("capex ") == 4_000


def test_a_text_over_the_stored_limit_is_cut_with_a_notice(rig: Rig):
    code, _out, err = rig.run("add", "x" * 200_500, "--theme", "t", "--claim", "c", "--stance", "neutral", "--confidence", "low")
    assert code == 0 and len(rig.client.calls[0][1]["rawText"]) == 200_000
    assert "the text has 200,500 characters; the first 200,000 are stored" in err


@pytest.mark.parametrize("answer", [
    {**ANSWER, "claims": []}, {**ANSWER, "stance": {"direction": "buy", "confidence": "high"}}, {**ANSWER, "orders": []},
    {**ANSWER, "theme": "\u200b\n"}, "not an object", RuntimeError("omp market-note-extract: exit 1: not logged in"),
])
def test_an_invalid_model_answer_stores_nothing(rig: Rig, answer: Any):
    rig.generator = FakeGenerator(answer)
    code, out, err = rig.run("add", "Owner text about capex.")
    assert (code, out) == (1, "") and "Nothing was stored" in err
    assert rig.client.calls == [] and rig.client.notes == []


def test_a_gpu_timeout_fails_the_add_and_stores_nothing(rig: Rig):
    rig.gpu = FakeGpu(raises=subprocess.TimeoutExpired(["python"], 45, output="GPU gate: free 900 MiB < 4096; waiting\n"))
    code, out, err = rig.run("add", REEL, "--transcribe-timeout", "45")
    assert (code, out) == (1, "")
    assert "stopped after 45 s: the GPU gate (4096 MiB free) did not open or the run did not finish" in err
    assert rig.gpu.calls[0]["timeout"] == 45 and [call[0] for call in rig.client.calls] == ["list"]
    assert rig.generator.prompts == []


def test_a_low_gpu_gate_stops_before_the_download(rig: Rig):
    Path(rig.environ["VERTEX_MARKET_NOTE_TRANSCRIBE"]).write_text(SCRIPT.replace("4096", "1024"), encoding="utf-8")
    code, _out, err = rig.run("add", REEL)
    assert code == 1 and "has a GPU gate of 1024 MiB; at least 4096 MiB is required" in err
    assert rig.download.calls == [] and rig.gpu.calls == []


def test_a_missing_gpu_tool_stops_before_the_download(rig: Rig):
    Path(rig.environ["VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON"]).unlink()
    code, _out, err = rig.run("add", REEL)
    assert code == 1 and "the transcribe interpreter is missing" in err and "VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON" in err
    Path(rig.environ["VERTEX_MARKET_NOTE_TRANSCRIBE"]).unlink()
    code, _out, err = rig.run("add", REEL)
    assert code == 1 and "the transcribe script is missing" in err
    assert rig.download.calls == [] and rig.gpu.calls == [] and len(rig.client.notes) == 0


def test_sigterm_during_the_gpu_run_ends_the_command_and_removes_the_temporary_directories(rig: Rig):
    before = {name: signal.getsignal(name) for name in (signal.SIGTERM, signal.SIGHUP)}
    seen: dict[str, Path] = {}

    def gpu(argv: list[str], **kwargs: Any) -> Any:
        seen["work"] = Path(kwargs["cwd"])
        assert seen["work"].is_dir() and Path(rig.download.calls[0]["cwd"]).is_dir()
        os.kill(os.getpid(), signal.SIGTERM)  # the tool is told to stop while the child runs
        time.sleep(30)
        raise AssertionError("the stop signal did not interrupt the run")

    rig.gpu = gpu  # type: ignore[assignment]
    started = time.monotonic()
    code, out, err = rig.run("add", REEL)
    assert (code, out) == (143, "") and time.monotonic() - started < 10
    assert "stopped by SIGTERM" in err and "temporary files removed" in err
    assert not seen["work"].exists() and not Path(rig.download.calls[0]["cwd"]).exists()
    assert [call[0] for call in rig.client.calls] == ["list"] and rig.client.notes == []
    assert {name: signal.getsignal(name) for name in before} == before  # the handlers of before are back


def test_sighup_during_the_download_ends_the_command(rig: Rig):
    def download(argv: list[str], **kwargs: Any) -> Any:
        rig.download.calls.append({"argv": argv, **kwargs})
        os.kill(os.getpid(), signal.SIGHUP)
        time.sleep(30)

    rig.overrides["download_run"] = download
    code, out, err = rig.run("add", REEL)
    assert (code, out) == (129, "") and "stopped by SIGHUP" in err
    assert not Path(rig.download.calls[0]["cwd"]).exists() and rig.client.notes == []


def test_the_real_runs_use_the_process_group_runner_and_real_signals():
    from market_notes import process

    deps = cli.Deps()
    assert deps.download_run is process.run_group and deps.transcribe_run is process.run_group
    assert deps.install_signal is signal.signal and deps.resolve is None


def test_outside_text_is_cleaned_before_it_is_stored(rig: Rig, tmp_path: Path):
    """NUL and lone surrogates leave the raw text; control and format characters leave the one-line fields."""
    rig.gpu = FakeGpu({"text": "Capex\x00 is near \ud83d a peak.\nSecond line.", "model": {"device": "cuda"}})
    rig.download = FakeDownload({"id": "abc", "uploader": "Jane\u200b Doe\u202e", "upload_date": "20261110"})
    rig.generator = FakeGenerator({**ANSWER, "theme": "AI capex\u200b is\nclose to a peak\u202e",
                                   "claims": ["Capex\u2066 rose\tin 2026."]})
    code, out, err = rig.run("add", REEL)
    assert code == 0, err
    fields = rig.client.calls[1][1]
    assert fields["rawText"] == "Capex is near ? a peak.\nSecond line."  # line breaks stay in the raw text
    assert fields["source"]["author"] == "Jane Doe"
    assert fields["theme"] == "AI capex is close to a peak" and fields["claims"] == ["Capex rose in 2026."]
    text = tmp_path / "reel.txt"
    text.write_bytes(b"By hand:\x00 capex is near a peak.")
    assert rig.run("add", "https://youtu.be/other", "--transcript-file", str(text), "--theme", "t", "--claim", "c",
                   "--stance", "neutral", "--confidence", "low")[0] == 0
    assert rig.client.calls[-1][1]["rawText"] == "By hand: capex is near a peak."


def test_dates_at_the_limits_are_accepted(rig: Rig):
    code, _out, err = rig.run("add", "Owner text.", "--as-of", "2026-11-12", "--review-by", "2027-11-12", "--theme", "t",
                              "--claim", "c", "--stance", "neutral", "--confidence", "low")
    assert code == 0, err
    fields = rig.client.calls[0][1]
    assert (fields["asOf"], fields["reviewBy"]) == ("2026-11-12", "2027-11-12")  # today + 1 day, today + 366 days


def test_a_reel_upload_date_that_cannot_be_a_note_date_is_not_used(rig: Rig):
    for upload in ("20270101", "19990101", "20261350"):
        rig.client.notes.clear()
        rig.download = FakeDownload({"id": "abc", "upload_date": upload})
        code, _out, err = rig.run("add", REEL)
        assert code == 0 and "the as-of date is today" in err
        assert rig.client.calls[-1][1]["asOf"] == "2026-11-11" and rig.client.calls[-1][1]["reviewBy"] == "2026-12-11"


def test_a_cpu_transcript_is_refused(rig: Rig):
    rig.gpu = FakeGpu({"text": "words", "model": {"device": "cpu"}})
    code, _out, err = rig.run("add", REEL)
    assert code == 1 and "not on cuda" in err and rig.generator.prompts == []


def test_an_old_reel_gets_its_review_period_from_today(rig: Rig):
    rig.download = FakeDownload({"id": "abc", "channel": "handle", "upload_date": "20260901"})
    code, _out, err = rig.run("add", REEL)
    assert code == 0
    fields = rig.client.calls[1][1]
    assert (fields["asOf"], fields["reviewBy"], fields["source"]["author"]) == ("2026-09-01", "2026-12-11", "handle")
    assert "will read as expired" not in err


def test_a_past_review_date_is_stored_with_a_notice_that_the_note_will_read_as_expired(rig: Rig):
    rig.download = FakeDownload({"id": "abc", "channel": "handle", "upload_date": "20260901"})
    code, _out, err = rig.run("add", REEL, "--review-by", "2026-10-01")
    assert code == 0
    fields = rig.client.calls[1][1]
    assert (fields["asOf"], fields["reviewBy"]) == ("2026-09-01", "2026-10-01")
    assert ("review date 2026-10-01 is before today: the note will read as expired and stay out of agent context "
            "until you renew it with the renew command") in err


@pytest.mark.parametrize(("argv", "text"), [
    (["add", "  "], "the note source is empty"),
    (["add", "some text", "--kind", "reel"], "--kind reel needs one http(s) link"),
    (["add", REEL, "--kind", "owner-text"], "takes the note text, not a link"),
    (["add", "https://user:pw@example.com/a"], "must not carry a user name"),
    (["add", "some text", "--transcript-file", "/tmp/x.txt"], "--transcript-file goes with a link"),
    (["add", REEL, "--transcript-file", "/nonexistent/reel.txt"], "--transcript-file cannot be read"),
    (["add", "text", "--owner-message", "chat/1"], "--owner-message must be an http(s) URL"),
    (["add", "text", "--as-of", "11/11/2026"], "--as-of must be a date as YYYY-MM-DD"),
    (["add", "text", "--as-of", "2026-11-11", "--review-by", "2026-11-10"], "is before the as-of date"),
    (["add", "text", "--author", "two\nlines"], "--author must be one line"),
    (["add", "text", "--theme", "only a theme"], "pass --theme together with at least one --claim"),
    (["add", "text", "--claim", "only a claim"], "pass --theme together with at least one --claim"),
    (["add", "text", "--theme", "t", "--claim", "c"], "also pass --stance and --confidence"),
    (["add", "text", "--theme", "t", "--claim", "c", "--claim", "c", "--stance", "neutral", "--confidence", "low"], "unique"),
    (["add", "text", "--theme", "t" * 301, "--claim", "c", "--stance", "neutral", "--confidence", "low"], "longer than 300"),
    (["add", "text", "--ticker", "not-a-ticker!"], "upper case"),
    (["add", "text", "--sector", "s" * 61], "--sector is longer than 60"),
    (["add", "text", "--sector", "tab\there"], "--sector must be one line"),
    (["add", "text", "--strategy", "bidi\u202emark"], "--strategy must be one line"),
    (["add", "text", "--theme", "zero\u200bwidth", "--claim", "c", "--stance", "neutral", "--confidence", "low"],
     "--theme must be one line"),
    (["add", "text", "--theme", "t", "--claim", "line\u2028separator", "--stance", "neutral", "--confidence", "low"],
     "--claim must be one line"),
    (["add", "text", "--author", "mark\u200f"], "--author must be one line"),
    (["add", "nul or broken \udcff bytes"], "the note text holds a NUL character or bytes that are not valid text"),
    (["add", "text", "--as-of", "1999-12-31"], "--as-of must be from 2000-01-01 to 2100-12-31"),
    (["add", "text", "--as-of", "2026-11-13"], "--as-of 2026-11-13 is more than 1 day after today"),
    (["add", "text", "--review-by", "2027-11-13"], "--review-by 2027-11-13 is more than 366 days after today"),
    (["add", "text", "--review-by", "2101-01-01"], "--review-by must be from 2000-01-01 to 2100-12-31"),
    (["renew", "mn_1", "--review-by", "2027-11-13"], "--review-by 2027-11-13 is more than 366 days after today"),
    (["renew", "mn_1", "--review-by", "1999-01-01"], "--review-by must be from 2000-01-01 to 2100-12-31"),
    (["add", "text", "--owner-message", "https://user:pw@example.com/m/1"], "--owner-message must not carry a user name"),
    (["add", "http://www.instagram.com/reel/abc/"], "a reel link must use https"),
    (["add", REEL, "--transcript-file", "/dev/zero"], "--transcript-file is larger than 2 MB"),
    (["check", "mn_1", "--claim", "c1", "--status", "supported", "--evidence", "nul\x00inside"], "evidence holds a NUL character"),
    (["add", REEL, "--transcribe-timeout", "0"], "--transcribe-timeout must be in"),
    (["check", "mn_1", "--claim", "c13", "--status", "supported", "--evidence", "e"], "claim ids are c1 to c12"),
    (["check", "mn_1", "--claim", "c1", "--status", "supported", "--evidence", "  "], "evidence is empty"),
    (["check", "mn_1", "--claim", "c1", "--status", "supported", "--evidence", "e" * 2001], "longer than 2000"),
    (["renew", "mn_1", "--review-by", "soon"], "--review-by must be a date"),
    (["retire", "x" * 65], "a note id has 1 to 64 characters"),
])
def test_usage_errors_exit_2_before_any_request(rig: Rig, argv: list[str], text: str):
    code, out, err = rig.run(*argv)
    assert (code, out) == (2, "") and text in err and err.startswith("market-notes: usage: ")
    assert rig.client.calls == [] and rig.download.calls == [] and rig.generator.prompts == []


@pytest.mark.parametrize("argv", [
    [], ["unknown"], ["add"], ["add", "text", "--kind", "video"], ["add", "text", "--stance", "bullish"],
    ["list", "--scope", "expired"], ["check", "mn_1", "--claim", "c1", "--status", "unverified", "--evidence", "e"],
    ["check", "mn_1", "--claim", "c1", "--status", "supported"], ["renew", "mn_1"], ["evidence"],
])
def test_argparse_errors_exit_2(rig: Rig, argv: list[str], capsys: pytest.CaptureFixture[str]):
    assert rig.run(*argv)[0] == 2
    assert "usage: python -m market_notes.cli" in capsys.readouterr().err
    assert rig.client.calls == []


def test_help_exits_0(rig: Rig, capsys: pytest.CaptureFixture[str]):
    assert rig.run("--help")[0] == 0
    text = capsys.readouterr().out
    for part in ("add", "list", "evidence", "check", "renew", "retire", "VERTEX_AGENT_API_KEY", "no value is ever printed"):
        assert part in text


def note(note_id: str, status: str, statuses: list[str], **fields: Any) -> dict[str, Any]:
    counts = {"cannotCheck": statuses.count("cannot-check"), "checked": "unverified" not in statuses,
              "contradicted": statuses.count("contradicted"), "supported": statuses.count("supported"),
              "unverified": statuses.count("unverified")}
    return {"id": note_id, "asOf": "2026-11-11", "theme": "AI capex is close to a peak", "reviewBy": "2026-12-11",
            "status": status, "stance": {"direction": "risk-off", "confidence": "medium"},
            "source": {"kind": "reel", "url": REEL, "author": "Jane Doe"}, "verification": counts, "rawText": "raw",
            "claims": [{"id": f"c{index}", "text": f"Claim {index} text.", "status": value,
                        "evidence": None if value == "unverified" else "FD cash-flow pack", "checkedAt": None}
                       for index, value in enumerate(statuses, 1)], **fields}


def test_list_prints_one_block_per_note_with_every_claim_status(tmp_path: Path):
    client = FakeClient([
        note("mn_2", "active", ["supported", "contradicted", "cannot-check", "unverified"]),
        note("mn_1", "expired", ["unverified"], asOf="2026-09-01", reviewBy="2026-10-01", theme="Old view",
             source={"kind": "owner-text", "url": None, "author": None}),
    ])
    rig = Rig(tmp_path, client)
    code, out, _err = rig.run("list")
    assert code == 0 and client.calls == [("list", "active", None)]
    assert out == """owner market notes (regime inputs): 1 note, scope active, read 2026-11-11T15:00:00.000Z
Third-party views sent by the owner. A claim counts as checked only when its status says so. Context only: no note sets a weight, a gate, a cap or a size.

2026-11-11  AI capex is close to a peak
  id: mn_2  source: reel https://www.instagram.com/reel/DfmxTYzBO1s/ by Jane Doe
  stance: risk-off (confidence medium)  review by: 2026-12-11  status: active
  verification: 1 supported, 1 contradicted, 1 cannot check, 1 unverified (not fully checked)
  claims:
    c1 [supported] Claim 1 text.
    c2 [contradicted] Claim 2 text.
    c3 [cannot-check] Claim 3 text.
    c4 [unverified] Claim 4 text.
"""
    code, out, _err = rig.run("list", "--scope", "all")
    assert code == 0 and "2 notes, scope all" in out
    assert "2026-09-01  Old view\n  id: mn_1  source: owner-text\n" in out
    assert "review by: 2026-10-01  status: expired" in out and out.count("\n\n") == 2
    assert "raw" not in out.replace("rawText", "")  # the raw text is not part of the list


def test_list_json_prints_the_answer_and_an_empty_list_says_so(tmp_path: Path):
    rig = Rig(tmp_path, FakeClient([note("mn_2", "active", ["supported"])]))
    code, out, _err = rig.run("list", "--format", "json", "--scope", "all")
    assert code == 0 and json.loads(out)["notes"][0]["id"] == "mn_2" and json.loads(out)["today"] == "2026-11-11"
    empty = Rig(tmp_path, FakeClient())
    assert empty.run("list")[1].splitlines()[-1] == "no active notes"
    assert empty.run("list", "--scope", "all")[1].splitlines()[-1] == "no notes"


def test_the_active_scope_shows_no_other_status_even_when_the_answer_holds_one(tmp_path: Path):
    client = FakeClient([note("mn_3", "active", ["supported"]), note("mn_2", "expired", ["unverified"], theme="Stale view"),
                         note("mn_1", "retired", ["unverified"], theme="Retired view")], filters_scope=False)
    rig = Rig(tmp_path, client)
    code, out, _err = rig.run("list")
    assert code == 0 and "1 note, scope active" in out and "mn_3" in out
    assert "Stale view" not in out and "Retired view" not in out
    listed = json.loads(rig.run("list", "--format", "json")[1])
    assert [entry["id"] for entry in listed["notes"]] == ["mn_3"] and listed["today"] == "2026-11-11"
    assert "3 notes, scope all" in rig.run("list", "--scope", "all")[1]  # scope all still shows every note


def test_a_check_on_a_retired_note_prints_the_reason_of_the_server(tmp_path: Path):
    client = FakeClient([note("mn_2", "retired", ["unverified"])])
    code, out, err = Rig(tmp_path, client).run("check", "mn_2", "--claim", "c1", "--status", "supported", "--evidence", "FD pack.")
    assert (code, out) == (1, "")
    assert err == "market-notes: marketNotes.recordChecks failed: 400 BAD_REQUEST A retired note takes no checks\n"
    assert client.notes[0]["claims"][0]["status"] == "unverified"


def test_check_records_one_claim_with_its_evidence(tmp_path: Path):
    client = FakeClient([note("mn_2", "active", ["unverified", "unverified"])])
    rig = Rig(tmp_path, client)
    proof = "MSFT capex 19,000 vs 14,000 a year before (Financial Datasets, fetched 2026-11-11)."
    code, out, _err = rig.run("check", "mn_2", "--claim", "c1", "--status", "supported", "--evidence", f"  {proof}\n")
    assert code == 0
    assert client.calls == [("recordChecks", "mn_2", [{"claimId": "c1", "evidence": proof, "status": "supported"}])]
    assert out.splitlines() == [
        "recorded: mn_2 c1 [supported]",
        "verification: 1 supported, 0 contradicted, 0 cannot check, 1 unverified (not fully checked)", "claims:",
        "  c1 [supported] Claim 1 text.", "  c2 [unverified] Claim 2 text."]
    code, out, _err = rig.run("check", "mn_2", "--claim", "c2", "--status", "cannot-check", "--evidence", "No public data.")
    assert code == 0 and "(all claims checked)" in out and "  c2 [cannot-check] Claim 2 text." in out


def test_renew_and_retire_call_review(tmp_path: Path):
    client = FakeClient([note("mn_2", "expired", ["supported"], reviewBy="2026-10-01")])
    rig = Rig(tmp_path, client)
    assert rig.run("renew", "mn_2", "--review-by", "2026-12-31") == (0, "renewed: mn_2 review by 2026-12-31 status active\n", "")
    assert rig.run("retire", "mn_2") == (0, "retired: mn_2 status retired\n", "")
    assert client.calls == [("review", "mn_2", {"kind": "renew", "reviewBy": "2026-12-31"}),
                            ("review", "mn_2", {"kind": "retire"})]


def test_a_server_error_exits_1_with_its_reason(tmp_path: Path):
    rig = Rig(tmp_path, FakeClient())
    code, out, err = rig.run("retire", "mn_9")
    assert (code, out) == (1, "") and err == "market-notes: marketNotes.get failed: 404 NOT_FOUND Market note not found\n"
    down = Rig(tmp_path, FakeClient(fail=MarketNotesError("list", 0, "UNREACHABLE", "URLError")))
    code, out, err = down.run("add", REEL)
    assert (code, out) == (1, "") and "marketNotes.list failed: 0 UNREACHABLE URLError" in err
    assert down.download.calls == []  # no download when the lookup failed


def test_missing_settings_exit_1_and_name_only_the_variables(tmp_path: Path):
    for environ in ({}, {"VERTEX_API_URL": "https://vertex.example.com"}, {"VERTEX_AGENT_API_KEY": KEY},
                    {"VERTEX_API_URL": "http://vertex.example.com", "VERTEX_AGENT_API_KEY": KEY}):
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(["list"], environ=environ, stdout=out, stderr=err)
        assert (code, out.getvalue()) == (1, "") and "VERTEX_API_URL" in err.getvalue() and KEY not in err.getvalue()


def test_the_key_is_never_printed_even_when_a_server_message_holds_it(tmp_path: Path):
    rig = Rig(tmp_path, FakeClient(fail=MarketNotesError("list", 500, "STORAGE_ERROR", f"echo {KEY}")))
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(["list"], environ=rig.environ, stdout=out, stderr=err, deps=cli.Deps(client_factory=lambda environ: rig.client))
    assert code == 1 and KEY not in err.getvalue() and "echo <hidden>" in err.getvalue()
    boom = cli.Deps(client_factory=lambda environ: (_ for _ in ()).throw(RuntimeError(f"trace with {KEY}")))
    out, err = io.StringIO(), io.StringIO()
    assert cli.main(["list"], environ=rig.environ, stdout=out, stderr=err, deps=boom) == 1
    assert err.getvalue() == "market-notes: internal error (RuntimeError)\n"


def test_the_real_client_is_the_default(tmp_path: Path):
    assert cli.Deps().client_factory == MarketNotesClient.from_env
