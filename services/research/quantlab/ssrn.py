"""SSRN topic search and capture.

Metadata comes from the public Crossref REST API (SSRN registers its DOIs under
prefix 10.2139). Open-access PDF locations come from the public OpenAlex API.
SSRN's own site answers automated clients with a bot challenge (HTTP 403 seen
2026-10-18), so this module never fetches papers.ssrn.com and never bypasses a
challenge or login. A PDF is retained only when an open-access location returns
an actual PDF; otherwise the capture is metadata-only and records the reason.
"""
from __future__ import annotations

import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

# Crossref/OpenAlex "polite pool" contact. Optional; set QUANTLAB_CONTACT_EMAIL locally, never in source.
_CONTACT = os.environ.get("QUANTLAB_CONTACT_EMAIL", "").strip()
USER_AGENT = f"vertex-quantlab/0.1 (research{'; mailto:' + _CONTACT if _CONTACT else ''})"
CROSSREF = "https://api.crossref.org/works"
OPENALEX = "https://api.openalex.org/works"
SSRN_PREFIX = "10.2139"
MAX_PDF_BYTES = 25_000_000
BLOCKED_HOSTS = ("papers.ssrn.com", "ssrn.com")


@dataclass(frozen=True)
class HttpResponse:
    status: int
    content_type: str
    body: bytes
    final_url: str = ""


Fetch = Callable[[str], HttpResponse]


class UnsafeUrl(ValueError):
    """A URL that is not plain public HTTPS (SSRF guard)."""


def require_public_https(url: str) -> None:
    """Refuse anything but https on port 443 to a name that resolves only to global addresses.

    PDF locations come from third-party OpenAlex records, so they are untrusted:
    without this check a record could point the fetcher at file://, the cloud
    metadata address, loopback services, the LAN or the tailnet.
    """
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.port not in (None, 443)):
        raise UnsafeUrl("only https URLs on port 443 without credentials are fetched")
    try:
        addresses = {ipaddress.ip_address(parsed.hostname)}
    except ValueError:
        try:
            infos = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        except OSError as error:
            raise UnsafeUrl("host does not resolve") from error
        addresses = {ipaddress.ip_address(str(info[4][0]).split("%", 1)[0]) for info in infos}
    if not addresses or not all(address.is_global for address in addresses):
        raise UnsafeUrl("host resolves to a non-public address")


class _CheckedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Apply the same public-HTTPS check to every redirect hop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require_public_https(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER: urllib.request.OpenerDirector | None = None


def _opener() -> urllib.request.OpenerDirector:
    global _OPENER
    if _OPENER is None:
        _OPENER = urllib.request.build_opener(_CheckedRedirectHandler())
    return _OPENER


def http_fetch(url: str, *, timeout: float = 30.0, max_bytes: int = MAX_PDF_BYTES) -> HttpResponse:
    require_public_https(url)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with _opener().open(request, timeout=timeout) as response:
            body = response.read(max_bytes + 1)
            return HttpResponse(response.status, response.headers.get("content-type", ""), body, response.geturl())
    except urllib.error.HTTPError as error:
        return HttpResponse(error.code, error.headers.get("content-type", "") if error.headers else "", b"")


@dataclass(frozen=True)
class PaperCapture:
    doi: str
    ssrn_id: str
    title: str
    authors: tuple[str, ...]
    year: int | None
    posted: str | None
    version: str
    abstract: str | None
    url: str
    topic: str
    captured_at: str
    pdf_status: str
    pdf_sha256: str | None = None
    pdf_bytes: int | None = None
    pdf_path: str | None = None
    pdf_source_url: str | None = None
    metadata_source: str = "crossref"
    notes: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["authors"] = list(self.authors)
        data["notes"] = list(self.notes)
        return data


def plain_text(text: str) -> str:
    """Decode HTML entities until stable (Crossref may double-escape), then normalize spaces."""
    for _ in range(3):
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    return re.sub(r"\s+", " ", text.replace("\u00a0", " ")).strip()


def strip_jats(text: str | None) -> str | None:
    if not text:
        return None
    plain = plain_text(re.sub(r"<[^>]+>", " ", text))
    return plain or None


def ssrn_id_from_doi(doi: str) -> str:
    match = re.fullmatch(r"10\.2139/ssrn\.(\d+)", doi.strip().lower())
    if not match:
        raise ValueError(f"not an SSRN DOI: {doi}")
    return match.group(1)


def _date(parts: dict | None) -> tuple[int | None, str | None]:
    values = (parts or {}).get("date-parts") or [[None]]
    first = values[0]
    if not first or first[0] is None:
        return None, None
    year = int(first[0])
    iso = "-".join(f"{int(v):02d}" if i else str(int(v)) for i, v in enumerate(first))
    return year, iso


def capture_from_crossref(item: dict, *, topic: str, captured_at: str) -> PaperCapture:
    doi = str(item["DOI"]).lower()
    authors = tuple(
        " ".join(part for part in (a.get("given"), a.get("family")) if part) or a.get("name", "")
        for a in item.get("author", [])
    )
    year, posted = _date(item.get("posted") or item.get("issued"))
    deposited = (item.get("deposited") or {}).get("date-time")
    titles = item.get("title") or ["(untitled)"]
    return PaperCapture(
        doi=doi,
        ssrn_id=ssrn_id_from_doi(doi),
        title=plain_text(titles[0])[:300],
        authors=tuple(a for a in authors if a),
        year=year,
        posted=posted,
        # SSRN revisions re-deposit the same DOI; the Crossref deposit time identifies the record version.
        version=f"crossref-deposited:{deposited}" if deposited else "crossref-deposited:unknown",
        abstract=strip_jats(item.get("abstract")),
        url=f"https://doi.org/{doi}",
        topic=topic,
        captured_at=captured_at,
        pdf_status="metadata_only:not_checked",
    )


def search_crossref(topic: str, *, rows: int = 10, since: str | None = None, fetch: Fetch = http_fetch) -> list[dict]:
    if not 1 <= rows <= 100:
        raise ValueError("rows must be 1..100")
    filters = [f"prefix:{SSRN_PREFIX}"]
    if since:
        # SSRN deposits carry a year-only posted date, so "since" filters on DOI creation time.
        filters.append(f"from-created-date:{since}")
    query = urllib.parse.urlencode({
        "query": topic,
        "filter": ",".join(filters),
        "rows": rows,
        "select": "DOI,title,author,issued,posted,deposited,abstract",
    })
    response = fetch(f"{CROSSREF}?{query}")
    if response.status != 200:
        raise RuntimeError(f"crossref search failed: HTTP {response.status}")
    return list(json.loads(response.body)["message"]["items"])


def blocked(url: str) -> bool:
    host = urllib.parse.urlparse(url).hostname or ""
    return any(host == b or host.endswith("." + b) for b in BLOCKED_HOSTS)


def open_access_pdf_urls(doi: str, *, fetch: Fetch = http_fetch) -> list[str]:
    query = urllib.parse.urlencode({"filter": f"doi:https://doi.org/{doi}", "select": "id,best_oa_location,locations"})
    response = fetch(f"{OPENALEX}?{query}")
    if response.status != 200:
        return []
    urls: list[str] = []
    for work in json.loads(response.body).get("results", []):
        for location in [work.get("best_oa_location")] + list(work.get("locations") or []):
            if location and location.get("is_oa") and location.get("pdf_url"):
                url = str(location["pdf_url"])
                if not blocked(url) and url not in urls:
                    urls.append(url)
    return urls


def retain_pdf(capture: PaperCapture, store: Path, *, fetch: Fetch = http_fetch) -> PaperCapture:
    """Keep a PDF only when an open-access location returns a real PDF."""
    try:
        urls = open_access_pdf_urls(capture.doi, fetch=fetch)
    except Exception as error:  # metadata stays valid without a PDF
        return _replace(capture, pdf_status=f"metadata_only:oa_lookup_failed:{type(error).__name__}")
    if not urls:
        return _replace(capture, pdf_status="metadata_only:no_free_copy")
    for url in urls:
        try:
            response = fetch(url)
        except Exception:
            continue
        if response.final_url and blocked(response.final_url):
            continue  # an open-access link that redirects to SSRN is not retained
        body = response.body
        if response.status == 200 and body.startswith(b"%PDF") and len(body) <= MAX_PDF_BYTES:
            digest = hashlib.sha256(body).hexdigest()
            store.mkdir(parents=True, exist_ok=True)
            path = store / f"ssrn-{capture.ssrn_id}-{digest[:12]}.pdf"
            path.write_bytes(body)
            return _replace(capture, pdf_status="retained", pdf_sha256=digest, pdf_bytes=len(body),
                            pdf_path=str(path), pdf_source_url=url)
    return _replace(capture, pdf_status="metadata_only:free_copy_unreachable")


def _replace(capture: PaperCapture, **changes) -> PaperCapture:
    data = {**capture.__dict__, **changes}
    return PaperCapture(**data)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_topic(topic: str, *, rows: int, since: str | None, store: Path, fetch: Fetch = http_fetch,
              captured_at: str | None = None, retain: bool = True) -> list[PaperCapture]:
    stamp = captured_at or now_iso()
    captures = []
    for item in search_crossref(topic, rows=rows, since=since, fetch=fetch):
        try:
            capture = capture_from_crossref(item, topic=topic, captured_at=stamp)
        except ValueError:
            continue
        captures.append(retain_pdf(capture, store, fetch=fetch) if retain else capture)
    return captures


def get_by_doi(doi: str, *, topic: str, store: Path, fetch: Fetch = http_fetch, retain: bool = True) -> PaperCapture:
    response = fetch(f"{CROSSREF}/{urllib.parse.quote(doi)}")
    if response.status != 200:
        raise RuntimeError(f"crossref lookup failed: HTTP {response.status}")
    capture = capture_from_crossref(json.loads(response.body)["message"], topic=topic, captured_at=now_iso())
    return retain_pdf(capture, store, fetch=fetch) if retain else capture
