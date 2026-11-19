"""From a note source to its text: kind detection, reel audio download, article text.

Everything fetched here is third-party data. The reel download runs yt-dlp without cookies,
without a browser, without plugins and without the user's yt-dlp configuration, so only public
media is read. The article fetch uses the standard library: https only, no proxy, redirects
only on the same host, at most 2 MB and one total time limit. Both refuse a host that resolves
to an address of this machine or of a private network. No request here carries a key, and no
child process receives one.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .contract import AUTHOR_MAX, http_url, tidy_line, units
from .errors import NoteError
from .process import child_env, run_group

YTDLP_ENV = "VERTEX_MARKET_NOTE_YTDLP"
DEFAULT_YTDLP = "yt-dlp"
DOWNLOAD_TIMEOUT_S = 600.0
# Hosts whose links are short videos. A post link of x.com or twitter.com counts too: a shared
# video there is a plain post link. Any other http(s) link is an article.
REEL_HOSTS = ("instagram.com", "tiktok.com", "youtube.com", "youtu.be")
POST_HOSTS = ("x.com", "twitter.com")
_POST_PATH = re.compile(r"/(?:status|statuses|broadcasts)/[^/]+")
# Always passed. The two cookie flags switch both cookie sources off.
YTDLP_SAFE_FLAGS = ("--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist")
# No plugin code, no live stream, no media longer than one hour, no download over 300 MB.
YTDLP_LIMIT_FLAGS = ("--no-plugin-dirs", "--max-filesize", "300M", "--match-filter", "!is_live & duration<?3600")
# Option text that would read a login, a cookie store, a browser or another input list.
_YTDLP_REFUSED = ("--cookies", "--netrc", "--username", "--password", "--twofactor",
                  "--video-password", "--ap-", "--client-certificate", "--config-location",
                  "--batch-file", "--load-info-json", "--exec", "--add-header", "--plugin-dirs")
ARTICLE_MAX_BYTES = 2_000_000
ARTICLE_MIN_CHARS = 200
# Limit of one network step, and of the whole fetch with its redirects.
ARTICLE_TIMEOUT_S = 30.0
ARTICLE_DEADLINE_S = 60.0
ARTICLE_REDIRECTS = 5
_ARTICLE_TYPES = ("text/html", "application/xhtml+xml", "text/plain")
_USER_AGENT = "vertex-market-notes/1 (research reader; no cookies)"

Runner = Callable[..., "subprocess.CompletedProcess[str]"]
Opener = Callable[..., Any]
Resolver = Callable[..., Any]


def _host_in(host: str, names: tuple[str, ...]) -> bool:
    return any(host == name or host.endswith("." + name) for name in names)


def detect_kind(value: str) -> str:
    """``reel``, ``article`` or ``owner-text`` for one command-line source value."""
    parts = http_url(value)
    if parts is None:
        return "owner-text"
    host = (parts.hostname or "").lower().rstrip(".")
    if _host_in(host, REEL_HOSTS):
        return "reel"
    if _host_in(host, POST_HOSTS) and _POST_PATH.search(parts.path):
        return "reel"
    return "article"


def clean_line(value: Any, maximum: int) -> str | None:
    """Third-party text as one clean line of at most ``maximum`` characters, or None when it is empty."""
    if not isinstance(value, str):
        return None
    text = tidy_line(value)
    while units(text) > maximum:
        text = text[:-1]
    return text.strip() or None


def _is_public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%")[0])
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return (mapped or ip).is_global


def require_public_host(host: str, port: int | None, *, what: str, resolve: Resolver | None = None) -> None:
    """Refuse a host that is, or resolves to, an address of this machine or of a private network.

    Every resolved address must be a global one. Short and numeric host forms resolve too, so
    they get the same answer as the address they stand for.
    """
    name = host.lower().rstrip(".").strip("[]")
    refusal = NoteError(f"the {what} host is a local or private address; pass --transcript-file")
    if not name or name == "localhost" or name.endswith((".localhost", ".local", ".internal")):
        raise refusal
    try:
        found = (resolve or socket.getaddrinfo)(name, port or 443, type=socket.SOCK_STREAM)
        addresses = {str(entry[4][0]) for entry in found}
    except (OSError, UnicodeError, IndexError, TypeError):
        raise NoteError(f"the {what} host could not be resolved; pass --transcript-file") from None
    if not addresses or not all(_is_public(address) for address in addresses):
        raise refusal


# ---- reel: audio through yt-dlp -------------------------------------------------------------

def refuse_login_options(argv: list[str]) -> None:
    """Stop when a yt-dlp option would read cookies, a browser, a login or another input list."""
    for arg in argv[1:]:
        low = arg.lower()
        if not low.startswith("-") or low in YTDLP_SAFE_FLAGS:
            continue
        if "browser" in low or "cookie" in low or low in ("-u", "-p", "-n", "-a") \
                or low.startswith(_YTDLP_REFUSED):
            raise NoteError(f"refused yt-dlp option {arg.split('=')[0]}: the intake never uses "
                            "cookies, a browser or a login")


def ytdlp_argv(binary: str, source_url: str) -> list[str]:
    """Argument vector of one audio download. Output files: the audio (``note.m4a``) and the yt-dlp metadata file beside it."""
    parts = http_url(source_url)
    if parts is None or parts.scheme.lower() != "https":
        raise NoteError("a reel is read over https only; pass an https link or --transcript-file")
    if parts.username or parts.password:
        raise NoteError("the reel link must not carry a user name or a password")
    host = (parts.hostname or "").lower().rstrip(".")
    # On tiktok.com the best audio-only stream is the music track, so take a stream with video.
    media = "b[vcodec!=none]/best" if _host_in(host, ("tiktok.com",)) else "bestaudio/best"
    argv = [binary, *YTDLP_SAFE_FLAGS, *YTDLP_LIMIT_FLAGS, "--no-progress", "--no-warnings", "-f", media,
            "-x", "--audio-format", "m4a", "--write-info-json", "-o", "note.%(ext)s", source_url]
    refuse_login_options(argv)
    return argv


@dataclass(frozen=True)
class ReelAudio:
    audio: Path
    media_id: str
    author: str | None
    upload_date: str | None  # YYYY-MM-DD


def _info(path: Path) -> tuple[str, str | None, str | None]:
    """Media id, author and upload date of a yt-dlp info file. Only these three fields are read."""
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "note", None, None
    if not isinstance(info, dict):
        return "note", None, None
    raw_id = info.get("id")
    media_id = raw_id if isinstance(raw_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", raw_id) else "note"
    author = clean_line(info.get("uploader"), AUTHOR_MAX) or clean_line(info.get("channel"), AUTHOR_MAX)
    day = info.get("upload_date")
    upload = None
    if isinstance(day, str) and re.fullmatch(r"\d{8}", day):
        upload = f"{day[:4]}-{day[4:6]}-{day[6:]}"
    return media_id, author, upload


def download_reel(source_url: str, directory: Path, *, environ: Mapping[str, str] | None = None,
                  run: Runner = run_group, timeout_s: float = DOWNLOAD_TIMEOUT_S,
                  resolve: Resolver | None = None) -> ReelAudio:
    """Download the audio of one public reel into ``directory`` (a fresh, empty directory).

    yt-dlp runs in a process group of its own with the small child environment (``process``).
    """
    source = os.environ if environ is None else environ
    argv = ytdlp_argv(source.get(YTDLP_ENV) or DEFAULT_YTDLP, source_url)
    parts = http_url(source_url)
    require_public_host(parts.hostname or "" if parts else "", parts.port if parts else None, what="reel", resolve=resolve)
    try:
        done = run(argv, cwd=str(directory), env=child_env(source), timeout=timeout_s)
    except subprocess.TimeoutExpired:
        raise NoteError(f"yt-dlp did not finish in {timeout_s:g} s") from None
    except OSError as error:
        raise NoteError(f"could not start yt-dlp ({error.strerror or type(error).__name__}); "
                        f"set {YTDLP_ENV} to the yt-dlp binary") from None
    if done.returncode != 0:
        tail = clean_line((done.stdout or "")[-400:], 300) or "no message"
        raise NoteError(f"yt-dlp failed (exit {done.returncode}): {tail}. A reel that needs a login "
                        "cannot be read; pass its text with --transcript-file")
    audio = sorted(directory.glob("*.m4a"))
    if len(audio) != 1:
        raise NoteError(f"yt-dlp wrote {len(audio)} m4a files; exactly one is expected")
    media_id, author, upload = _info(directory / "note.info.json")  # json-data-ignore: yt-dlp metadata of one download in a temporary directory, deleted after the run; not stored data
    return ReelAudio(audio[0], media_id, author, upload)


# ---- article: fetch and reduce to text ------------------------------------------------------

class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to an https URL on the same host and port that still resolves to public addresses."""

    max_redirections = ARTICLE_REDIRECTS

    def __init__(self, resolve: Resolver | None = None) -> None:
        self._resolve = resolve

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        old, new = http_url(req.full_url), http_url(newurl)
        try:
            same = (old is not None and new is not None and new.scheme.lower() == "https"
                    and not new.username and not new.password
                    and (new.hostname or "").lower() == (old.hostname or "").lower() and new.port == old.port)
            if same and new is not None:
                require_public_host(new.hostname or "", new.port, what="redirect", resolve=self._resolve)
        except (ValueError, NoteError):  # a port that is not a number, or a host that is not public now
            same = False
        if not same:
            target = (new.hostname if new is not None else None) or "another location"
            raise urllib.error.HTTPError(req.full_url, code, f"redirect to {target} refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def article_opener(resolve: Resolver | None = None) -> Opener:
    """The opener of the article fetch: no proxy (the checked host is the host that is reached), guarded redirects."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _SameHostRedirect(resolve)).open


_SKIPPED = frozenset({"script", "style", "nav", "noscript", "template", "svg", "iframe"})
_BLOCKS = frozenset({
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
    "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol", "p",
    "pre", "section", "table", "td", "th", "title", "tr", "ul"})


class _TextReducer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip = 0
        self._open = {"article": 0, "main": 0}
        self.page: list[str] = []
        self.inside: dict[str, list[str]] = {"article": [], "main": []}

    def _add(self, text: str) -> None:
        self.page.append(text)
        for tag, depth in self._open.items():
            if depth:
                self.inside[tag].append(text)

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in _SKIPPED:
            self._skip += 1
        elif not self._skip:
            if tag in self._open:
                self._open[tag] += 1
            if tag in _BLOCKS:
                self._add("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIPPED:
            self._skip = max(0, self._skip - 1)
        elif not self._skip:
            if tag in _BLOCKS:
                self._add("\n")
            if tag in self._open:
                self._open[tag] = max(0, self._open[tag] - 1)

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._add(data)


def _tidy(parts: list[str]) -> str:
    lines = (" ".join(line.split()) for line in "".join(parts).replace("\xa0", " ").splitlines())
    return "\n".join(line for line in lines if line)


def html_to_text(html: str) -> str:
    """Readable text of an HTML page without script, style and navigation content.

    When the ``article`` elements of the page hold enough text, only their text is returned;
    else the text of ``main``; else the text of the whole page.
    """
    reducer = _TextReducer()
    reducer.feed(html)
    reducer.close()
    for tag in ("article", "main"):
        text = _tidy(reducer.inside[tag])
        if len(text) >= ARTICLE_MIN_CHARS:
            return text
    return _tidy(reducer.page)


def _within(seconds: float, work: Callable[[], Any], hint: str) -> Any:
    """The result of ``work``, or a failure when it takes longer than ``seconds`` in total."""
    box: dict[str, Any] = {}

    def target() -> None:
        try:
            box["value"] = work()
        except BaseException as error:  # handed to the caller below
            box["error"] = error

    thread = threading.Thread(target=target, daemon=True, name="market-note-article")
    thread.start()
    thread.join(seconds)
    if thread.is_alive():
        raise NoteError(f"article fetch did not finish in {seconds:g} s; {hint}")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _read_page(opener: Opener, request: Any, timeout_s: float, deadline: float) -> tuple[str, str | None, bytes]:
    """Content type, charset and at most 2 MB + 1 byte of the body. Each read is checked against the deadline."""
    with opener(request, timeout=timeout_s) as response:
        headers = response.headers
        media, charset = headers.get_content_type(), headers.get_content_charset()
        body = b""
        while len(body) <= ARTICLE_MAX_BYTES:
            if time.monotonic() > deadline:
                raise TimeoutError
            chunk = response.read1(min(65_536, ARTICLE_MAX_BYTES + 1 - len(body)))
            if not chunk:
                break
            body += chunk
    return media, charset, body


def fetch_article(source_url: str, *, opener: Opener | None = None, resolve: Resolver | None = None,
                  timeout_s: float = ARTICLE_TIMEOUT_S, deadline_s: float = ARTICLE_DEADLINE_S,
                  notify: Callable[[str], None] | None = None) -> str:
    """Text of one public article. Fails when the page gives under 200 characters of text."""
    hint = "pass the text with --transcript-file"
    parts = http_url(source_url)
    if parts is None or parts.scheme.lower() != "https":
        raise NoteError(f"an article is fetched over https only; {hint}")
    if parts.username or parts.password:
        raise NoteError("the article URL must not carry a user name or a password")
    require_public_host(parts.hostname or "", parts.port, what="article", resolve=resolve)
    request = urllib.request.Request(source_url, method="GET", headers={
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.8", "accept-encoding": "identity",
        "user-agent": _USER_AGENT})
    reader, deadline = opener or article_opener(resolve), time.monotonic() + deadline_s
    try:
        media, charset, body = _within(
            deadline_s, lambda: _read_page(reader, request, min(timeout_s, deadline_s), deadline), hint)
    except urllib.error.HTTPError as error:
        reason = clean_line(str(error.reason), 120) or "no reason"
        raise NoteError(f"article fetch failed: HTTP {error.code} ({reason}); {hint}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise NoteError(f"article fetch failed ({type(error).__name__}); {hint}") from None
    if media not in _ARTICLE_TYPES:
        raise NoteError(f"the article is {clean_line(media, 60) or 'of an unknown type'}, not a web page; {hint}")
    if len(body) > ARTICLE_MAX_BYTES:
        body = body[:ARTICLE_MAX_BYTES]
        if notify is not None:
            notify(f"the page is larger than {ARTICLE_MAX_BYTES // 1_000_000} MB; only the first part was read")
    try:
        page = body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        page = body.decode("utf-8", errors="replace")
    text = _tidy([page]) if media == "text/plain" else html_to_text(page)
    if len(text) < ARTICLE_MIN_CHARS:
        raise NoteError(f"the page gave {len(text)} characters of text (under {ARTICLE_MIN_CHARS}); {hint}")
    return text
