"""Text of market notes for a person, a consult prompt or an allocation report.

Every block shows the note date, the review date and the status of each claim in brackets, so
a reader never takes an unchecked claim for a checked one. ``report_block`` is the document
key that the allocation scripts add with ``--market-notes``: context for the reader only.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from .client import MarketNotesClient

LIST_TITLE = "owner market notes (regime inputs)"
REPORT_ROLE = "research context only; not used in any weight, gate, cap or size"
_COUNTS = (("supported", "supported"), ("contradicted", "contradicted"),
           ("cannotCheck", "cannot check"), ("unverified", "unverified"))


def verification_line(verification: Any) -> str:
    if not isinstance(verification, Mapping):
        return "not reported"
    counts = ", ".join(f"{verification.get(key, 0)} {label}" for key, label in _COUNTS)
    return f"{counts} ({'all claims checked' if verification.get('checked') else 'not fully checked'})"


def claim_lines(note: Mapping[str, Any], indent: str = "  ") -> list[str]:
    return [f"{indent}{claim.get('id')} [{claim.get('status')}] {claim.get('text')}"
            for claim in note.get("claims") or [] if isinstance(claim, Mapping)]


def _source(note: Mapping[str, Any]) -> str:
    source = note.get("source") if isinstance(note.get("source"), Mapping) else {}
    parts = [str(source.get("kind") or "unknown")]
    if source.get("url"):
        parts.append(str(source["url"]))
    if source.get("author"):
        parts.append(f"by {source['author']}")
    return " ".join(parts)


def note_block(note: Mapping[str, Any]) -> str:
    """One note: date, theme, stance, review date, status and every claim with its status."""
    stance = note.get("stance") if isinstance(note.get("stance"), Mapping) else {}
    lines = [
        f"{note.get('asOf')}  {note.get('theme')}",
        f"  id: {note.get('id')}  source: {_source(note)}",
        f"  stance: {stance.get('direction')} (confidence {stance.get('confidence')})"
        f"  review by: {note.get('reviewBy')}  status: {note.get('status')}",
        f"  verification: {verification_line(note.get('verification'))}",
        "  claims:",
        *claim_lines(note, "    "),
    ]
    return "\n".join(lines)


def active_only(listing: Mapping[str, Any]) -> dict[str, Any]:
    """The listing with only the notes whose status is "active". The server already filters; this is a second guard."""
    notes = [note for note in listing.get("notes") or [] if isinstance(note, Mapping) and note.get("status") == "active"]
    return {**listing, "notes": notes}


def notes_text(listing: Mapping[str, Any], scope: str) -> str:
    """The block a consult or an allocation report pastes as "owner market notes (regime inputs)".

    With scope "active", a note of another status is left out even when the answer holds one.
    """
    notes = [note for note in listing.get("notes") or [] if isinstance(note, Mapping)
             and (scope != "active" or note.get("status") == "active")]
    head = (f"{LIST_TITLE}: {len(notes)} {'note' if len(notes) == 1 else 'notes'}, scope {scope}, "
            f"read {listing.get('asOf')}")
    rule = ("Third-party views sent by the owner. A claim counts as checked only when its status says so. "
            "Context only: no note sets a weight, a gate, a cap or a size.")
    if not notes:
        return "\n".join([head, rule, "", "no notes" if scope == "all" else "no active notes"])
    return "\n\n".join(["\n".join([head, rule]), *(note_block(note) for note in notes)])


def stored_text(first_line: str, note: Mapping[str, Any]) -> str:
    """Answer of ``add``: the id line, the theme and the claims with their ids."""
    stance = note.get("stance") if isinstance(note.get("stance"), Mapping) else {}
    return "\n".join([
        first_line,
        f"theme: {note.get('theme')}",
        f"stance: {stance.get('direction')} (confidence {stance.get('confidence')})",
        f"as of: {note.get('asOf')}  review by: {note.get('reviewBy')}  status: {note.get('status')}",
        "claims:",
        *claim_lines(note),
    ])


def report_block(listing: Mapping[str, Any]) -> dict[str, Any]:
    """``ownerMarketNotes`` of an allocation document: the active notes only.

    A note of another status (expired, retired) is left out even when the answer holds one.
    Raises ``ValueError`` on a note without its fields.
    """
    as_of = listing.get("asOf")
    if not isinstance(as_of, str) or not as_of:
        raise ValueError("the notes answer has no read time")
    notes = []
    for note in listing.get("notes") or []:
        try:
            if not isinstance(note["status"], str):
                raise TypeError
            if note["status"] != "active":
                continue
            notes.append({
                "asOf": note["asOf"], "theme": note["theme"], "stance": dict(note["stance"]),
                "reviewBy": note["reviewBy"], "verification": dict(note["verification"]),
                "claims": [{"id": claim["id"], "status": claim["status"], "text": claim["text"]}
                           for claim in note["claims"]],
            })
        except (KeyError, TypeError, ValueError):
            raise ValueError("a note of the answer lacks one of its fields") from None
    return {"role": REPORT_ROLE, "asOf": as_of, "notes": notes}


def read_report_block(environ: Mapping[str, str] | None = None, client: Any = None) -> dict[str, Any]:
    """Read the active notes and return the ``ownerMarketNotes`` block. Every failure raises.

    ``MarketNotesError`` and ``ValueError`` messages are safe to print (no key).
    """
    reader = client or MarketNotesClient.from_env(os.environ if environ is None else environ)
    return report_block(reader.list_notes(scope="active"))
