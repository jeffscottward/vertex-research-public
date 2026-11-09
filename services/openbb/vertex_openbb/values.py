"""Value helpers: finite numbers, counts, ISO dates and short labels.

Every number that leaves the fetcher goes through `num` or `count`, so NaN and Infinity never reach
the JSON document (they become null, and a row whose required number is missing is dropped by
`rows.validate_rows`).
"""

from __future__ import annotations

import html
import math
import re
from datetime import date, datetime, timedelta
from typing import Any

_ISO_PREFIX = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_COMPACT = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")
_CLOCK = re.compile(r"^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*$", re.IGNORECASE)
_CLOCK_24 = re.compile(r"^\s*([01]?\d|2[0-3]):([0-5]\d)(?::\d{2})?\s*$")


def num(value: Any) -> float | None:
    """Return a finite float, or None for None, NaN, Infinity, booleans and non-numbers."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        text = str(value).strip().replace(",", "")
        if text in {"", ".", "-", "NaN", "nan", "N/A", "NA", "null", "None"}:
            return None
        try:
            result = float(text)
        except ValueError:
            return None
    return result if math.isfinite(result) else None


def rounded(value: Any, digits: int = 6) -> float | None:
    """`num` rounded to `digits` decimals (removes float noise such as 0.038900000000000004)."""
    result = num(value)
    return None if result is None else round(result, digits)


def count(value: Any) -> int | None:
    """Return a non-negative whole number (rounded), or None."""
    result = num(value)
    if result is None or result < 0:
        return None
    return int(round(result))


def iso_date(value: Any) -> str | None:
    """Return `YYYY-MM-DD` for a date, datetime, ISO string or `YYYYMMDD`, else None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    match = _ISO_PREFIX.match(text) or _COMPACT.fullmatch(text)
    if not match:
        return None
    try:
        return date(int(match[1]), int(match[2]), int(match[3])).isoformat()
    except ValueError:
        return None


def parse_day(value: str) -> date:
    """Parse a strict `YYYY-MM-DD` string (ValueError otherwise)."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        raise ValueError(f"not a YYYY-MM-DD date: {value!r}")
    return date.fromisoformat(value)


def weekdays(start: date, end: date) -> list[date]:
    """Monday-Friday dates from start to end inclusive."""
    days = []
    current = start
    while current <= end:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return days


def clock(value: Any) -> str | None:
    """Return `HH:MM` (24 h) for '2:00 p.m.', '10:30 AM', '14:15' and the like, else None."""
    if value is None:
        return None
    text = str(value).strip()
    match = _CLOCK.match(text)
    if match:
        hour = int(match[1])
        minute = int(match[2] or 0)
        if not 1 <= hour <= 12 or minute > 59:
            return None
        hour = hour % 12 + (12 if match[3].lower() == "p" else 0)
        return f"{hour:02d}:{minute:02d}"
    match = _CLOCK_24.match(text)
    if match:
        return f"{int(match[1]):02d}:{match[2]}"
    return None


def utf16_len(text: str) -> int:
    """Length in UTF-16 code units (what JavaScript `string.length` and Zod `.max()` count)."""
    return len(text.encode("utf-16-le")) // 2


def cut(text: str, limit: int, ellipsis: str = "") -> str:
    """`text` cut to at most `limit` UTF-16 code units (with `ellipsis` when cut)."""
    if utf16_len(text) <= limit:
        return text
    room = limit - utf16_len(ellipsis)
    out = text
    while out and utf16_len(out) > room:
        out = out[:-1]
    return out.rstrip() + ellipsis


def plain_text(value: Any, limit: int) -> str | None:
    """Unescape HTML, drop tags, collapse whitespace and cut to `limit` characters."""
    if value is None:
        return None
    text = html.unescape(html.unescape(str(value)))
    text = _SPACE.sub(" ", _TAG.sub(" ", text)).strip()
    if not text:
        return None
    return cut(text, limit, "…")


def label(value: Any, limit: int) -> str | None:
    """A trimmed, non-empty single-line label of at most `limit` characters, else None."""
    if value is None:
        return None
    text = _SPACE.sub(" ", str(value)).strip()
    if not text:
        return None
    return cut(text, limit)


def slug(value: Any, limit: int = 60) -> str:
    """Lower-case `a-z0-9-` slug for stable event keys."""
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return text[:limit].strip("-") or "x"
