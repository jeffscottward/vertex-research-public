"""SSRN supplied-input paper adapter. Parsing is not a copyright/entitlement determination."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
import re

from providers.boundary import Boundary, BoundaryError, authorize, epoch_ns, identifier, plain_text, raw_sha256
from providers.ports import Clock, RightRequest, RightsPort, Unavailable
from .models import Segment, SourceInput


@dataclass(frozen=True)
class PaperInput:
    ssrn_id: str
    version_id: str
    title: str
    authors: tuple[str, ...]
    doi: str | None
    published_at: str | None
    captured_at: str
    data: bytes
    media_type: str
    rights_policy_id: str
    expected_digest: str


@dataclass(frozen=True)
class ParsedPage:
    page_number: int
    text: str
    method: str


class PaperParser(Protocol):
    """Host-selected adapter; no shell commands, links, tools or instructions from a PDF."""
    def parse(self, data: bytes, media_type: str, *, maximum_pages: int, maximum_characters: int) -> tuple[ParsedPage, ...]: ...


class SuppliedTextParser:
    """Functional plain-text path; PDF requires a separately reviewed parser binding."""
    def parse(self, data: bytes, media_type: str, *, maximum_pages: int, maximum_characters: int) -> tuple[ParsedPage, ...]:
        if media_type != "text/plain":
            raise BoundaryError("pdf-parser-unavailable")
        text = data.decode("utf-8", errors="strict")
        pages = text.split("\f")
        if len(text) > maximum_characters or len(pages) > maximum_pages:
            raise BoundaryError("paper-parse-budget")
        return tuple(ParsedPage(index + 1, page, "Supplied UTF-8 page text; not layout-verified PDF extraction") for index, page in enumerate(pages))


class SSRNAdapter:
    def __init__(self, *, boundary: Boundary, clock: Clock, rights: RightsPort | None, parser: PaperParser | None,
                 maximum_bytes: int = 8_000_000, maximum_pages: int = 64, maximum_characters: int = 500_000):
        if not 1 <= maximum_bytes <= 32_000_000 or not 1 <= maximum_pages <= 64 or not 1 <= maximum_characters <= 1_000_000:
            raise BoundaryError("invalid-paper-budget")
        self.boundary, self.clock, self.rights, self.parser = boundary, clock, rights, parser
        self.maximum_bytes, self.maximum_pages, self.maximum_characters = maximum_bytes, maximum_pages, maximum_characters

    def prepare(self, paper: PaperInput) -> SourceInput | Unavailable:
        try:
            self.boundary.require()
            if re.fullmatch(r"[1-9][0-9]{0,11}", paper.ssrn_id) is None:
                raise BoundaryError("invalid-ssrn-identity")
            identifier(paper.version_id)
            source_id = identifier("ssrn:" + paper.ssrn_id + ":" + paper.version_id)
            plain_text(paper.title)
            if not paper.authors or len(paper.authors) > 32:
                raise BoundaryError("paper-attribution-required")
            for author in paper.authors:
                plain_text(author, 200)
            if paper.doi is not None and (len(paper.doi) > 200 or re.fullmatch(r"10\.[0-9]{4,9}/[^\s]+", paper.doi) is None):
                raise BoundaryError("invalid-doi")
            if not isinstance(paper.data, bytes) or not 1 <= len(paper.data) <= self.maximum_bytes:
                raise BoundaryError("paper-input-byte-budget")
            if raw_sha256(paper.data) != paper.expected_digest:
                raise BoundaryError("paper-source-digest-mismatch")
            now = self.clock.now()
            if epoch_ns(paper.captured_at) > epoch_ns(now) or (paper.published_at is not None and epoch_ns(paper.published_at) > epoch_ns(paper.captured_at)):
                raise BoundaryError("paper-clock-mismatch")
            authorize(self.rights, RightRequest("ssrn", paper.rights_policy_id, "paper-parse", now, (source_id,)))
            if self.parser is None:
                raise BoundaryError("paper-parser-unavailable")
            pages = self.parser.parse(paper.data, paper.media_type, maximum_pages=self.maximum_pages, maximum_characters=self.maximum_characters)
            if not pages or len(pages) > self.maximum_pages or sum(len(page.text) for page in pages) > self.maximum_characters:
                raise BoundaryError("paper-parser-budget")
            if len({page.page_number for page in pages}) != len(pages) or any(type(page.page_number) is not int or page.page_number < 1 for page in pages):
                raise BoundaryError("paper-page-locator-mismatch")
            segments = []
            for page in pages:
                clean = " ".join(page.text.split())
                if not clean:
                    continue
                # Keep the full raw paper; bound retrieval excerpts without calling any model.
                segments.append(Segment("page:" + str(page.page_number) + ":normalized-char:0", clean[:1800], page.method))
            if not segments:
                raise BoundaryError("paper-text-unavailable")
            authorize(self.rights, RightRequest("ssrn", paper.rights_policy_id, "paper-parse", self.clock.now(), (source_id,)))
            metadata = {"ssrnId": paper.ssrn_id, "versionId": paper.version_id, "doi": paper.doi, "doiStatus": "available" if paper.doi else "unavailable",
                        "title": paper.title, "authors": list(paper.authors), "rawPaperDigest": paper.expected_digest,
                        "parsedPages": [{"number": page.page_number, "textDigest": raw_sha256(page.text.encode("utf-8")), "method": page.method} for page in pages],
                        "parserDoesNotGrantRights": True, "toolAuthority": False, "executionAuthority": False}
            attribution = paper.authors[0] if len(paper.authors) == 1 else paper.authors[0] + " et al. (complete authors in metadata)"
            plain_text(attribution, 200)
            return SourceInput(source_id, "https://ssrn.com/abstract=" + paper.ssrn_id, attribution, paper.captured_at, paper.published_at,
                               paper.data, tuple(segments), paper.rights_policy_id, "paper", "not-applicable", "paper", None,
                               ("Unreviewed paper claims are not proven strategy performance or permission to execute code.",
                                "First 1800 normalized characters per parsed page are citation candidates; full source bytes retained under policy.",
                                "DOI/version and author metadata require independent provenance review; parsing is not rights approval."),
                               self.boundary.encode(metadata), paper.expected_digest)
        except BoundaryError as error:
            return Unavailable(str(error), "ssrn", "Only authorized supplied bytes can be parsed; no SSRN page, PDF, or corpus was downloaded.")
        except Exception:
            return Unavailable("paper-parser-failed", "ssrn", "Parser failed closed; no text, tools or execution permissions were accepted.")
