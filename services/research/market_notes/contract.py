"""Limits and value checks of a market note, as in ``packages/api/src/contracts/market-notes.ts``.

The server validates every request again. These checks run first, so a wrong value stops the
command before a download, a model call or a request. Lengths count UTF-16 code units, as the
TypeScript contract does.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any
from urllib.parse import SplitResult, urlsplit

SOURCE_KINDS = ("reel", "article", "owner-text")
CHECK_STATUSES = ("supported", "contradicted", "cannot-check")
STANCES = ("risk-on", "risk-off", "neutral")
CONFIDENCES = ("low", "medium", "high")
LIST_SCOPES = ("active", "all")
MAX_CLAIMS = 12
RAW_TEXT_MAX = 200_000
URL_MAX = 2000
THEME_MAX, CLAIM_MAX, EVIDENCE_MAX, AUTHOR_MAX = 300, 500, 2000, 120
SECTOR_MAX, STRATEGY_MAX = 60, 80
SECTORS_MAX, STRATEGIES_MAX, TICKERS_MAX = 12, 12, 30
NOTE_ID_MAX = 64

_CLAIM_ID = re.compile(r"c(?:[1-9]|1[0-2])")
_TICKER = re.compile(r"[A-Z][A-Z0-9.-]{0,9}")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
DATE_MIN, DATE_MAX = date(2000, 1, 1), date(2100, 12, 31)
AS_OF_AHEAD_DAYS = 1
REVIEW_AHEAD_DAYS = 366
# Unicode categories that a one-line field must not hold: control, format (zero-width and
# bidi marks), line separator, paragraph separator, and a surrogate that stands alone.
_SPACED = frozenset({"Cc", "Zl", "Zp"})
_DROPPED = frozenset({"Cf", "Cs"})


def units(text: str) -> int:
    """Length in UTF-16 code units (the length JavaScript reports)."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def tidy_line(value: str) -> str:
    """Text from outside as one clean line: the characters a one-line field refuses are taken out.

    Control characters and line separators become a space; format characters go.
    """
    kept = (" " if unicodedata.category(char) in _SPACED else char
            for char in value if unicodedata.category(char) not in _DROPPED)
    return " ".join("".join(kept).split())


def broken_text(value: str) -> bool:
    """True when the text holds U+0000 or a surrogate that stands alone (the server refuses both)."""
    return "\x00" in value or any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def tidy_text(value: str) -> str:
    """Raw text from outside without U+0000; a surrogate that stands alone becomes "?"."""
    return value.replace("\x00", "").encode("utf-8", errors="replace").decode("utf-8")


def one_line(value: Any, maximum: int, name: str) -> str:
    """Trimmed text of 1 to ``maximum`` units on one line, with no control character."""
    if not isinstance(value, str):
        raise ValueError(f"{name} must be text")
    text = value.strip()
    if not text:
        raise ValueError(f"{name} is empty")
    if units(text) > maximum:
        raise ValueError(f"{name} is longer than {maximum} characters")
    if any(unicodedata.category(char) in _SPACED | _DROPPED for char in text):
        raise ValueError(f"{name} must be one line of text with no control characters "
                         "(no line break, tab, zero-width or text-direction mark)")
    return text


def http_url(value: Any) -> SplitResult | None:
    """The parts of ``value`` when it is one http(s) URL with a host and nothing else."""
    if not isinstance(value, str) or not value or units(value) > URL_MAX:
        return None
    if any(char.isspace() or unicodedata.category(char) == "Cc" for char in value):
        return None
    try:
        parts = urlsplit(value)
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not host:
        return None
    return parts


def url(value: Any, name: str) -> str:
    """An http(s) URL of at most 2,000 characters that carries no user name or password."""
    parts = http_url(value)
    if parts is None:
        raise ValueError(f"{name} must be an http(s) URL of at most {URL_MAX} characters")
    if parts.username or parts.password:
        raise ValueError(f"{name} must not carry a user name or a password")
    return value


def iso_date(value: Any, name: str) -> date:
    if not isinstance(value, str) or _DATE.fullmatch(value) is None:
        raise ValueError(f"{name} must be a date as YYYY-MM-DD")
    try:
        day = date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{name} is not a calendar date") from None
    if not DATE_MIN <= day <= DATE_MAX:
        raise ValueError(f"{name} must be from {DATE_MIN} to {DATE_MAX}")
    return day


def as_of_date(value: Any, name: str, today: date) -> date:
    """A note date: in the date range and at most one day after today (UTC)."""
    day = iso_date(value, name)
    if day > today + timedelta(days=AS_OF_AHEAD_DAYS):
        raise ValueError(f"{name} {day} is more than {AS_OF_AHEAD_DAYS} day after today ({today}, UTC)")
    return day


def review_date(value: Any, name: str, today: date) -> date:
    """A review date: in the date range and at most 366 days after today (UTC)."""
    day = iso_date(value, name)
    if day > today + timedelta(days=REVIEW_AHEAD_DAYS):
        raise ValueError(f"{name} {day} is more than {REVIEW_AHEAD_DAYS} days after today ({today}, UTC)")
    return day


def claim_id(value: Any) -> str:
    if not isinstance(value, str) or _CLAIM_ID.fullmatch(value) is None:
        raise ValueError("claim ids are c1 to c12")
    return value


def note_id(value: Any) -> str:
    if not isinstance(value, str) or not value or units(value) > NOTE_ID_MAX:
        raise ValueError(f"a note id has 1 to {NOTE_ID_MAX} characters")
    return value


def is_ticker(value: Any) -> bool:
    return isinstance(value, str) and _TICKER.fullmatch(value) is not None


def ticker(value: Any) -> str:
    if not is_ticker(value):
        raise ValueError(f"ticker {str(value)[:20]!r} must be upper case, like NVDA or BRK.B")
    return value


def evidence(value: Any) -> str:
    """Evidence text of a check: 1 to 2,000 characters after trimming. Line breaks are allowed."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("evidence is empty")
    text = value.strip()
    if broken_text(text):
        raise ValueError("evidence holds a NUL character or text that is not valid Unicode")
    if units(text) > EVIDENCE_MAX:
        raise ValueError(f"evidence is longer than {EVIDENCE_MAX} characters")
    return text


def _lines(values: Any, maximum_count: int, maximum_length: int, name: str) -> list[str]:
    if not isinstance(values, list):
        raise ValueError(f"{name} must be a list")
    out = list(dict.fromkeys(one_line(value, maximum_length, f"{name} entry") for value in values))
    if len(out) > maximum_count:
        raise ValueError(f"{name} has more than {maximum_count} entries")
    return out


@dataclass(frozen=True)
class Extraction:
    """What the intake reads out of a note text: the theme, the claims, the affected area, the stance."""

    theme: str
    claims: tuple[str, ...]
    sectors: tuple[str, ...]
    tickers: tuple[str, ...]
    strategies: tuple[str, ...]
    direction: str
    confidence: str

    def affected(self) -> dict[str, list[str]]:
        return {"sectors": list(self.sectors), "strategies": list(self.strategies),
                "tickers": list(self.tickers)}

    def stance(self) -> dict[str, str]:
        return {"confidence": self.confidence, "direction": self.direction}


def _exact_keys(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    if set(value) != keys:
        extra, missing = sorted(set(value) - keys), sorted(keys - set(value))
        raise ValueError(f"{name} must have exactly the keys {sorted(keys)}"
                         + (f"; unknown: {extra}" if extra else "")
                         + (f"; missing: {missing}" if missing else ""))
    return value


def tidy_extraction(value: Any) -> Any:
    """A model answer with its one-line texts cleaned (``tidy_line``). The shape is not changed or checked."""
    def lines(items: Any) -> Any:
        return [tidy_line(item) if isinstance(item, str) else item for item in items] if isinstance(items, list) else items

    if not isinstance(value, dict):
        return value
    out = dict(value)
    if isinstance(out.get("theme"), str):
        out["theme"] = tidy_line(out["theme"])
    if "claims" in out:
        out["claims"] = lines(out["claims"])
    if isinstance(out.get("affected"), dict):
        out["affected"] = {key: lines(items) if key in ("sectors", "strategies") else items
                           for key, items in out["affected"].items()}
    return out


def extraction(value: Any) -> Extraction:
    """Strict check of ``{theme, claims, affected{sectors,tickers,strategies}, stance{direction,confidence}}``."""
    top = _exact_keys(value, {"theme", "claims", "affected", "stance"}, "the extraction")
    affected = _exact_keys(top["affected"], {"sectors", "tickers", "strategies"}, "affected")
    stance = _exact_keys(top["stance"], {"direction", "confidence"}, "stance")
    claims = top["claims"]
    if not isinstance(claims, list) or not 1 <= len(claims) <= MAX_CLAIMS:
        raise ValueError(f"claims must be a list of 1 to {MAX_CLAIMS} statements")
    texts = [one_line(claim, CLAIM_MAX, f"claim {index}") for index, claim in enumerate(claims, 1)]
    if len(set(texts)) != len(texts):
        raise ValueError("claims must be unique")
    tickers = affected["tickers"]
    if not isinstance(tickers, list):
        raise ValueError("affected.tickers must be a list")
    symbols = list(dict.fromkeys(ticker(symbol) for symbol in tickers))
    if len(symbols) > TICKERS_MAX:
        raise ValueError(f"affected.tickers has more than {TICKERS_MAX} entries")
    if stance["direction"] not in STANCES:
        raise ValueError(f"stance.direction must be one of {', '.join(STANCES)}")
    if stance["confidence"] not in CONFIDENCES:
        raise ValueError(f"stance.confidence must be one of {', '.join(CONFIDENCES)}")
    return Extraction(
        theme=one_line(top["theme"], THEME_MAX, "theme"), claims=tuple(texts),
        sectors=tuple(_lines(affected["sectors"], SECTORS_MAX, SECTOR_MAX, "affected.sectors")),
        tickers=tuple(symbols),
        strategies=tuple(_lines(affected["strategies"], STRATEGIES_MAX, STRATEGY_MAX,
                                "affected.strategies")),
        direction=stance["direction"], confidence=stance["confidence"])
