"""Market note sources: kind detection, the yt-dlp command, article fetch and text reduction. Fakes only."""
from __future__ import annotations

import io
import json
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from typing import Any

import pytest

from market_notes import sources
from market_notes.errors import NoteError

REEL = "https://www.instagram.com/reel/DfmxTYzBO1s/"
PUBLIC_ADDRESS = "93.184.216.34"


class Names:
    """A fake resolver: no DNS. A literal address is itself, a listed name has its addresses, any other name is public."""

    def __init__(self, **addresses: list[str]) -> None:
        self.addresses = {name.replace("_", "."): found for name, found in addresses.items()}
        self.asked: list[tuple[str, int]] = []

    def __call__(self, host: str, port: int, **options: Any) -> list[Any]:
        self.asked.append((host, port))
        assert options == {"type": socket.SOCK_STREAM}
        found = self.addresses.get(host, [host] if host.replace(".", "").isdigit() or ":" in host else [PUBLIC_ADDRESS])
        if not found:
            raise socket.gaierror("name not known")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port)) for address in found]


@pytest.mark.parametrize(("value", "kind"), [
    (REEL, "reel"),
    ("https://instagram.com/p/abc/", "reel"),
    ("https://www.tiktok.com/@someone/video/123", "reel"),
    ("https://vm.tiktok.com/ZM123/", "reel"),
    ("https://www.youtube.com/shorts/abc", "reel"),
    ("https://m.youtube.com/watch?v=abc", "reel"),
    ("https://youtu.be/abc", "reel"),
    ("HTTPS://YOUTU.BE/abc", "reel"),
    ("https://x.com/someone/status/123", "reel"),
    ("https://twitter.com/someone/status/123/video/1", "reel"),
    ("https://x.com/i/broadcasts/1abc", "reel"),
    ("https://x.com/someone", "article"),
    ("https://www.ft.com/content/abc", "article"),
    ("http://example.com/post", "article"),
    ("https://notinstagram.com/reel/1", "article"),
    ("https://instagram.com.evil.example/reel/1", "article"),
    ("Capex at the hyperscalers is near a peak", "owner-text"),
    ("https://www.ft.com/content/abc says capex is near a peak", "owner-text"),
    ("ftp://example.com/file", "owner-text"),
    ("www.instagram.com/reel/abc", "owner-text"),
    ("https://", "owner-text"),
    ("", "owner-text"),
])
def test_kind_detection(value: str, kind: str):
    assert sources.detect_kind(value) == kind


def test_the_ytdlp_command_never_reads_cookies_or_a_browser():
    for url in (REEL, "https://www.tiktok.com/@a/video/1", "https://youtu.be/abc", "https://x.com/a/status/1"):
        argv = sources.ytdlp_argv("/opt/yt-dlp", url)
        assert argv[0] == "/opt/yt-dlp" and argv[-1] == url
        for flag in ("--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist",
                     "--no-plugin-dirs", "-x", "--write-info-json"):
            assert argv.count(flag) == 1
        assert argv[argv.index("--max-filesize") + 1] == "300M"
        assert argv[argv.index("--match-filter") + 1] == "!is_live & duration<?3600"
        assert argv[argv.index("--audio-format") + 1] == "m4a"
        assert argv[argv.index("-o") + 1] == "note.%(ext)s"
        options = [arg for arg in argv[1:-1] if arg.startswith("-")]
        cookie_or_browser = [arg for arg in options if "cookie" in arg or "browser" in arg]
        assert cookie_or_browser == ["--no-cookies", "--no-cookies-from-browser"]
        assert not any(arg.startswith(("--cookies", "--netrc", "--username", "--password")) for arg in options)
    assert sources.ytdlp_argv("yt-dlp", REEL)[sources.ytdlp_argv("yt-dlp", REEL).index("-f") + 1] == "bestaudio/best"
    tiktok = sources.ytdlp_argv("yt-dlp", "https://www.tiktok.com/@a/video/1")
    assert tiktok[tiktok.index("-f") + 1] == "b[vcodec!=none]/best"
    with pytest.raises(NoteError):
        sources.ytdlp_argv("yt-dlp", "--cookies-from-browser=firefox")
    for link in ("http://youtu.be/abc", "http://www.instagram.com/reel/abc/", "ftp://youtu.be/abc"):
        with pytest.raises(NoteError, match="https only"):
            sources.ytdlp_argv("yt-dlp", link)
    with pytest.raises(NoteError, match="user name"):
        sources.ytdlp_argv("yt-dlp", "https://user:pw@example.com/abc")


@pytest.mark.parametrize("option", ["--cookies", "--cookies=/tmp/c.txt", "--cookies-from-browser", "--cookies-from-browser=firefox",
                                    "--COOKIES-FROM-BROWSER", "--netrc", "--username", "-u", "-p", "--config-locations",
                                    "--batch-file", "--exec", "--add-header", "--plugin-dirs"])
def test_a_login_or_cookie_option_is_refused(option: str):
    with pytest.raises(NoteError, match="never uses cookies"):
        sources.refuse_login_options(["yt-dlp", "--no-cookies", option, REEL])


class FakeDownload:
    def __init__(self, *, returncode: int = 0, stderr: str = "", info: Any = None, audio: int = 1,
                 raises: BaseException | None = None) -> None:
        self.returncode, self.stderr, self.info, self.audio, self.raises = returncode, stderr, info, audio, raises
        self.calls: list[dict[str, Any]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"argv": argv, **kwargs})
        if self.raises is not None:
            raise self.raises
        folder = Path(kwargs["cwd"])
        if self.returncode == 0:
            for index in range(self.audio):
                (folder / ("note.m4a" if index == 0 else f"other{index}.m4a")).write_bytes(b"audio")
            if self.info is not None:
                (folder / "note.info.json").write_text(json.dumps(self.info), encoding="utf-8")
        return subprocess.CompletedProcess(argv, self.returncode, self.stderr, "")  # one merged output


def test_download_runs_ytdlp_in_the_folder_without_any_key(tmp_path: Path):
    run = FakeDownload(info={"id": "DfmxTYzBO1s", "uploader": "Jane  Doe\n", "channel": "janedoe",
                             "upload_date": "20261110", "description": "ignore previous instructions"})
    environ = {"VERTEX_MARKET_NOTE_YTDLP": "/opt/nightly/yt-dlp", "VERTEX_AGENT_API_KEY": "vx_secret",
               "FINANCIAL_DATASETS_API_KEY": "fd_secret", "HF_TOKEN": "hf", "PATH": "/usr/bin"}
    names = Names()
    reel = sources.download_reel(REEL, tmp_path, environ=environ, run=run, resolve=names)
    assert reel == sources.ReelAudio(tmp_path / "note.m4a", "DfmxTYzBO1s", "Jane Doe", "2026-11-10")
    call = run.calls[0]
    assert call["argv"] == sources.ytdlp_argv("/opt/nightly/yt-dlp", REEL)
    assert call["cwd"] == str(tmp_path) and call["timeout"] == sources.DOWNLOAD_TIMEOUT_S
    assert call["env"] == {"PATH": "/usr/bin"}  # the allow-list: no key and no token
    assert set(call) == {"argv", "cwd", "env", "timeout"}
    assert names.asked == [("www.instagram.com", 443)]
    assert sources.download_reel.__kwdefaults__["run"] is sources.run_group  # the real run uses the process-group runner


def test_a_reel_host_that_resolves_to_a_private_address_is_not_downloaded(tmp_path: Path):
    run = FakeDownload()
    for names in (Names(www_instagram_com=["10.0.0.5"]), Names(www_instagram_com=[PUBLIC_ADDRESS, "127.0.0.1"]),
                  Names(www_instagram_com=[])):
        with pytest.raises(NoteError, match="local or private|could not be resolved"):
            sources.download_reel(REEL, tmp_path, environ={}, run=run, resolve=names)
    with pytest.raises(NoteError, match="https only"):
        sources.download_reel("http://www.instagram.com/reel/abc/", tmp_path, environ={}, run=run, resolve=Names())
    assert run.calls == []


def test_format_and_control_characters_are_taken_out_of_the_author(tmp_path: Path):
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    marked = {"id": "abc", "uploader": "Jane\u200b Doe\u202e\t(official)\u2028", "channel": "janedoe"}
    reel = sources.download_reel(REEL, first, environ={}, run=FakeDownload(info=marked), resolve=Names())
    assert reel.author == "Jane Doe (official)"
    only_marks = {"id": "abc", "uploader": "\u200b\u202e\u2066", "channel": "jane\u200fdoe"}
    assert sources.download_reel(REEL, second, environ={}, run=FakeDownload(info=only_marks), resolve=Names()).author == "janedoe"
    assert sources.clean_line("\u200b\x00\u2029", 120) is None and sources.clean_line(7, 120) is None
    assert sources.clean_line("x" * 200, 120) == "x" * 120


def test_download_falls_back_to_the_channel_and_plain_defaults(tmp_path: Path):
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    reel = sources.download_reel(REEL, first, environ={}, resolve=Names(), run=FakeDownload(
        info={"id": "../../etc", "uploader": None, "channel": "handle", "upload_date": "soon"}))
    assert (reel.media_id, reel.author, reel.upload_date) == ("note", "handle", None)
    run = FakeDownload()
    bare = sources.download_reel(REEL, second, environ={}, run=run, resolve=Names())
    assert (bare.media_id, bare.author, bare.upload_date) == ("note", None, None)
    assert run.calls[0]["argv"][0] == "yt-dlp"


def test_download_failures_stop_the_intake(tmp_path: Path):
    cases = [
        (FakeDownload(returncode=1, stderr="ERROR: [Instagram] abc: login required\n"), "login required"),
        (FakeDownload(raises=subprocess.TimeoutExpired(["yt-dlp"], 600)), "did not finish"),
        (FakeDownload(raises=FileNotFoundError(2, "No such file or directory")), "VERTEX_MARKET_NOTE_YTDLP"),
        (FakeDownload(audio=0), "wrote 0 m4a files"),
        (FakeDownload(audio=2), "wrote 2 m4a files"),
    ]
    for index, (run, text) in enumerate(cases):
        folder = tmp_path / str(index)
        folder.mkdir()
        with pytest.raises(NoteError, match=text):
            sources.download_reel(REEL, folder, environ={}, run=run, resolve=Names())


PAGE = """<!doctype html><html><head><title>Capex   watch</title>
<style>body { color: red }</style><script>var secret = "do not show";</script></head>
<body><nav><a href="/">Home</a><a href="/markets">Markets menu</a></nav>
<header><h1>AI capex &amp; cash flow</h1></header>
<main><p>Hyperscaler capital expenditure rose&nbsp;again in the third quarter.</p>
<p>Free cash flow fell at <b>two</b> of the four companies.<br>Debt issuance went up.</p>
<noscript>enable javascript</noscript><svg><text>chart label</text></svg>
<ul><li>First point</li><li>Second point</li></ul></main>
<script type="application/ld+json">{"hidden": true}</script><footer>Example News 2026</footer></body></html>"""


def test_html_is_reduced_to_text_without_script_style_and_navigation():
    text = sources.html_to_text(PAGE)
    assert text.splitlines() == [
        "Capex watch", "AI capex & cash flow", "Hyperscaler capital expenditure rose again in the third quarter.",
        "Free cash flow fell at two of the four companies.", "Debt issuance went up.", "First point", "Second point",
        "Example News 2026"]
    for hidden in ("do not show", "color: red", "Markets menu", "enable javascript", "chart label", "hidden"):
        assert hidden not in text


def test_an_article_element_with_enough_text_is_preferred():
    body = "Capital expenditure at the four largest cloud companies rose again. " * 5
    page = f"<html><body><div>Cookie banner and menu</div><article><p>{body}</p></article><div>Related links</div></body></html>"
    assert sources.html_to_text(page) == body.strip()
    short = "<html><body><div>Outside text</div><article><p>Short.</p></article></body></html>"
    assert sources.html_to_text(short).splitlines() == ["Outside text", "Short."]
    in_main = f"<html><body><header>Site name</header><main><h1>Title</h1><article>Teaser.</article><p>{body}</p></main></body></html>"
    assert sources.html_to_text(in_main).splitlines() == ["Title", "Teaser.", body.strip()]


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, content_type: str = "text/html; charset=utf-8") -> None:
        super().__init__(body)
        self.headers = Message()
        self.headers["Content-Type"] = content_type


class FakeOpener:
    def __init__(self, response: Any) -> None:
        self.response, self.requests = response, []

    def __call__(self, request: Any, timeout: float) -> Any:
        self.requests.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


LONG_PAGE = ("<html><body><nav>menu</nav><p>" + "Hyperscaler capex rose in the quarter. " * 10 + "</p></body></html>").encode()


def test_article_fetch_sends_no_key_and_returns_the_text():
    opener = FakeOpener(FakeResponse(LONG_PAGE))
    names = Names()
    text = sources.fetch_article("https://www.example.com/a?b=1", opener=opener, resolve=names)
    assert text.startswith("Hyperscaler capex rose") and "menu" not in text
    request, timeout = opener.requests[0]
    assert request.full_url == "https://www.example.com/a?b=1" and request.get_method() == "GET"
    assert timeout == sources.ARTICLE_TIMEOUT_S
    assert sorted(name.lower() for name in request.headers) == ["accept", "accept-encoding", "user-agent"]
    assert request.get_header("Accept-encoding") == "identity"
    assert names.asked == [("www.example.com", 443)]  # the host is resolved and checked before the request


def test_article_fetch_reads_plain_text_and_other_charsets():
    plain = ("Capex rose again.\n" * 20).encode()
    assert sources.fetch_article("https://example.com/a.txt", opener=FakeOpener(FakeResponse(plain, "text/plain")),
                                 resolve=Names()).count("Capex") == 20
    latin = ("<p>" + "Société Générale a relevé ses prévisions. " * 8 + "</p>").encode("latin-1")
    text = sources.fetch_article("https://example.com/fr", opener=FakeOpener(FakeResponse(latin, "text/html; charset=ISO-8859-1")),
                                 resolve=Names())
    assert "Société Générale a relevé" in text


def test_article_fetch_stops_at_two_megabytes():
    filler = b"<p>" + b"word " * 500_000 + b"</p><p>END-OF-PAGE</p>"
    notes: list[str] = []
    text = sources.fetch_article("https://example.com/big", opener=FakeOpener(FakeResponse(filler)), notify=notes.append,
                                 resolve=Names())
    assert len(filler) > sources.ARTICLE_MAX_BYTES and "END-OF-PAGE" not in text
    assert len(text) <= sources.ARTICLE_MAX_BYTES and notes == ["the page is larger than 2 MB; only the first part was read"]


@pytest.mark.parametrize(("url", "response", "text"), [
    ("http://example.com/a", FakeResponse(LONG_PAGE), "https only"),
    ("https://user:pw@example.com/a", FakeResponse(LONG_PAGE), "user name"),
    ("https://127.0.0.1/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://10.1.2.3/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://198.18.0.1/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://[::1]/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://localhost/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://rig.internal/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://169.254.169.254/latest/meta-data", FakeResponse(LONG_PAGE), "local or private"),
    ("https://[::ffff:10.0.0.1]/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://[fe80::1]/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://private.example.com/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://mixed.example.com/a", FakeResponse(LONG_PAGE), "local or private"),
    ("https://nowhere.example.com/a", FakeResponse(LONG_PAGE), "could not be resolved"),
    ("https://example.com/a", FakeResponse(b"<html><body><p>Too short.</p></body></html>"), "under 200"),
    ("https://example.com/a", FakeResponse(b"<html><body><script>" + b"x" * 5000 + b"</script></body></html>"), "under 200"),
    ("https://example.com/a.pdf", FakeResponse(b"%PDF-1.7", "application/pdf"), "not a web page"),
    ("https://example.com/a", urllib.error.HTTPError("https://example.com/a", 403, "Forbidden", {}, None), "HTTP 403"),  # type: ignore[arg-type]
    ("https://example.com/a", urllib.error.URLError("dns"), "URLError"),
    ("https://example.com/a", TimeoutError(), "TimeoutError"),
])
def test_article_fetch_failures_ask_for_a_transcript_file(url: str, response: Any, text: str):
    opener = FakeOpener(response)
    names = Names(private_example_com=["192.168.1.20"], mixed_example_com=[PUBLIC_ADDRESS, "10.0.0.5"], nowhere_example_com=[])
    with pytest.raises(NoteError, match=text) as caught:
        sources.fetch_article(url, opener=opener, resolve=names)
    if "user name" not in text:
        assert "--transcript-file" in str(caught.value)
    if text in ("https only", "user name", "local or private", "could not be resolved"):
        assert opener.requests == []


@pytest.mark.parametrize("host", ["2130706433", "127.1", "0x7f.0.0.1", "017700000001", "0", "[::1]", "[::]", "192.168.0.1"])
def test_short_and_numeric_forms_of_a_local_address_are_refused_by_the_real_resolver(host: str):
    """These forms are parsed by the system resolver without any DNS request."""
    opener = FakeOpener(FakeResponse(LONG_PAGE))
    with pytest.raises(NoteError, match="local or private|could not be resolved"):
        sources.fetch_article(f"https://{host}/a", opener=opener)
    assert opener.requests == []


def test_the_whole_fetch_has_one_time_limit():
    release = threading.Event()

    def stuck(request: Any, timeout: float) -> Any:
        release.wait(20)
        raise TimeoutError

    started = time.monotonic()
    try:
        with pytest.raises(NoteError, match="did not finish in 0.2 s") as caught:
            sources.fetch_article("https://example.com/a", opener=stuck, resolve=Names(), deadline_s=0.2)
    finally:
        release.set()
    assert time.monotonic() - started < 5 and "--transcript-file" in str(caught.value)


def test_a_body_that_trickles_in_is_cut_off_by_the_time_limit():
    class Trickle(FakeResponse):
        def read1(self, size: int = -1) -> bytes:
            time.sleep(0.05)  # each read is far under the per-read limit
            return b"<p>word</p>"

    started = time.monotonic()
    with pytest.raises(NoteError, match="did not finish|TimeoutError"):
        sources.fetch_article("https://example.com/a", opener=FakeOpener(Trickle(b"")), resolve=Names(), deadline_s=0.3)
    assert time.monotonic() - started < 5


def test_the_default_opener_uses_no_proxy_and_the_guarded_redirects(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("https_proxy", "http://proxy.example.com:3128")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example.com:3128")
    director = sources.article_opener(Names()).__self__
    assert not [handler for handler in director.handlers if isinstance(handler, urllib.request.ProxyHandler)]
    redirects = [handler for handler in director.handlers if isinstance(handler, urllib.request.HTTPRedirectHandler)]
    assert len(redirects) == 1 and isinstance(redirects[0], sources._SameHostRedirect)


def test_a_redirect_is_followed_on_the_same_host_only():
    handler = sources._SameHostRedirect(Names())
    request = urllib.request.Request("https://example.com/a", headers={"user-agent": "x"})
    followed = handler.redirect_request(request, None, 302, "Found", Message(), "https://example.com/b")
    assert followed is not None and followed.full_url == "https://example.com/b"
    for target in ("https://www.example.com/b", "https://other.example/b", "http://example.com/b",
                   "https://example.com:8443/b", "https://example.com:x/b", "ftp://example.com/b",
                   "https://user:pw@example.com/b"):
        with pytest.raises(urllib.error.HTTPError, match="refused"):
            handler.redirect_request(request, None, 302, "Found", Message(), target)
    # The same host, but it resolves to a private address at the time of the redirect.
    moved = sources._SameHostRedirect(Names(example_com=["10.0.0.5"]))
    with pytest.raises(urllib.error.HTTPError, match="refused"):
        moved.redirect_request(request, None, 302, "Found", Message(), "https://example.com/b")
    assert handler.max_redirections == 5
