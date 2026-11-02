"""Strict research-only human context data, not an enabled chat execution path.

Parsing proves only shape and canonical size/integrity at the injected trusted
codec boundary. Human bodies, participant labels/personas and syntactic hashes
are not Evidence, provenance, readiness, admission, current rights, permission or
model-disclosure approval. No extraction, summarization, authorization or runtime
integration happens here. Agent-origin rows are unsupported, never relabeled or
silently omitted. An explicit start above one means earlier rows are absent.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any, Literal

from .evidence import canonical, identifier
from .ports import CanonicalCodec
from .types import AgentFault


_CONTEXT_FIELDS = frozenset({
    "schema_version", "kind", "account_alias", "environment", "owner_actor_id",
    "response_request_id", "thread_id", "parent_message_id", "participant_id",
    "participant_config_sha256", "participant_label", "persona_text",
    "snapshot_revision", "high_water_sequence", "start_sequence", "messages",
})
_MESSAGE_FIELDS = frozenset({"message_id", "sequence", "record_sha256", "author", "body"})
_AUTHOR_FIELDS = frozenset({"kind", "actor_id"})
_DIGEST = re.compile(r"[0-9a-f]{64}")
_ORDINAL = re.compile(r"[1-9][0-9]{0,29}")
_MAX_CANONICAL_BYTES = 65_536
# ECMAScript String.prototype.trim WhiteSpace + LineTerminator, not str.strip:
# Python omits FEFF and includes additional controls. Only inspect, never trim.
_ECMASCRIPT_TRIM = frozenset(
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _literal(value: Any, expected: str) -> None:
    if type(value) is not str or value != expected:
        raise AgentFault("invalid-chat-context")


def _identifier(value: Any) -> None:
    if type(value) is not str:
        raise AgentFault("invalid-chat-context")
    identifier(value)


def _digest(value: Any) -> None:
    if type(value) is not str or not _DIGEST.fullmatch(value):
        raise AgentFault("invalid-chat-context")


def _ordinal(value: Any) -> int:
    if type(value) is not str or not _ORDINAL.fullmatch(value):
        raise AgentFault("invalid-chat-context")
    # Bounded Python integers are exact, including above JavaScript's 2**53.
    return int(value)


def _text(value: Any, maximum: int, *, multiline: bool) -> None:
    if type(value) is not str or not 1 <= len(value) <= maximum:
        raise AgentFault("invalid-chat-context")
    units = 0
    nonblank = False
    for character in value:
        point = ord(character)
        if ((point < 0x20 and not (multiline and character in "\t\n\r"))
                or 0x7f <= point <= 0x9f
                or point in (0x061c, 0x200e, 0x200f)
                or 0x202a <= point <= 0x202e
                or 0x2066 <= point <= 0x2069
                or 0xd800 <= point <= 0xdfff):
            raise AgentFault("invalid-chat-context")
        units += 2 if point > 0xffff else 1
        nonblank = nonblank or character not in _ECMASCRIPT_TRIM
    if units > maximum or not nonblank:
        raise AgentFault("invalid-chat-context")


@dataclass(frozen=True, slots=True)
class ResearchChatHumanAuthorV1:
    """A declared human identity only; current ownership needs a trusted join."""

    kind: Literal["user"]
    actor_id: str

    def __post_init__(self) -> None:
        _literal(self.kind, "user")
        _identifier(self.actor_id)


@dataclass(frozen=True, slots=True)
class ResearchChatHumanMessageV1:
    """Complete literal human body, not an Evidence item or model instruction."""

    message_id: str
    sequence: str
    record_sha256: str
    author: ResearchChatHumanAuthorV1
    body: str

    def __post_init__(self) -> None:
        _identifier(self.message_id)
        _ordinal(self.sequence)
        _digest(self.record_sha256)
        if type(self.author) is not ResearchChatHumanAuthorV1:
            raise AgentFault("invalid-chat-context")
        self.author.__post_init__()
        _text(self.body, 8_000, multiline=True)


@dataclass(frozen=True, slots=True)
class ResearchChatHumanContextV1:
    """Detached declared window; constructors do not validate canonical bytes.

    Use parse_research_chat_human_context_v1 for untrusted wire data and the
    canonical helper before exporting/hashing typed data. Both require the
    authoritative CanonicalCodec and enforce the whole UTF-8 byte bound.
    """

    schema_version: Literal["1.0.0"]
    kind: Literal["research-chat-human-context"]
    account_alias: str
    environment: Literal["research"]
    owner_actor_id: str
    response_request_id: str
    thread_id: str
    parent_message_id: str
    participant_id: str
    participant_config_sha256: str
    participant_label: str
    persona_text: str
    snapshot_revision: str
    high_water_sequence: str
    start_sequence: str
    messages: tuple[ResearchChatHumanMessageV1, ...]

    def __post_init__(self) -> None:
        _literal(self.schema_version, "1.0.0")
        _literal(self.kind, "research-chat-human-context")
        _literal(self.environment, "research")
        for value in (self.account_alias, self.owner_actor_id, self.response_request_id,
                      self.thread_id, self.parent_message_id, self.participant_id):
            _identifier(value)
        _digest(self.participant_config_sha256)
        _text(self.participant_label, 160, multiline=False)
        _text(self.persona_text, 4_000, multiline=True)
        snapshot = _ordinal(self.snapshot_revision)
        high_water = _ordinal(self.high_water_sequence)
        start = _ordinal(self.start_sequence)
        if (type(self.messages) is not tuple or not 1 <= len(self.messages) <= 16
                or snapshot != high_water + 1 or start > high_water
                or high_water - start + 1 != len(self.messages)):
            raise AgentFault("invalid-chat-context")
        seen: set[str] = set()
        for index, message in enumerate(self.messages):
            if type(message) is not ResearchChatHumanMessageV1:
                raise AgentFault("invalid-chat-context")
            message.__post_init__()
            if (message.author.actor_id != self.owner_actor_id
                    or _ordinal(message.sequence) != start + index
                    or message.message_id in seen):
                raise AgentFault("invalid-chat-context")
            seen.add(message.message_id)
        if self.messages[-1].message_id != self.parent_message_id:
            raise AgentFault("invalid-chat-context")


def _object(value: Any, expected: frozenset[str]) -> dict[str, Any]:
    # Plain JSON containers only: no custom mappings/accessors or coercion.
    if (type(value) is not dict or any(type(key) is not str for key in value)
            or set(value) != expected):
        raise AgentFault("invalid-chat-context")
    return value


def parse_research_chat_human_context_v1(
    value: Any, *, codec: CanonicalCodec,
) -> ResearchChatHumanContextV1:
    """Validate strict decoded JSON, detach/freeze, and check canonical bytes.

    The explicit window must be human-only and contiguous through its parent at
    high-water. This does not query actual rows, establish lineage/ownership or
    authorize later model use. No mutable caller container survives parsing.
    """
    wire = _object(value, _CONTEXT_FIELDS)
    rows = wire["messages"]
    if type(rows) is not list or not 1 <= len(rows) <= 16:
        raise AgentFault("invalid-chat-context")
    messages: list[ResearchChatHumanMessageV1] = []
    for row in rows:
        message = _object(row, _MESSAGE_FIELDS)
        author = ResearchChatHumanAuthorV1(**_object(message["author"], _AUTHOR_FIELDS))
        messages.append(ResearchChatHumanMessageV1(**{**message, "author": author}))
    context = ResearchChatHumanContextV1(**{**wire, "messages": tuple(messages)})
    canonical_research_chat_human_context_v1(context, codec=codec)
    return context


def canonical_research_chat_human_context_v1(
    value: ResearchChatHumanContextV1, *, codec: CanonicalCodec,
) -> tuple[bytes, str]:
    """Return authoritative canonical UTF-8 bytes and their entire-context hash.

    There is no self-referential digest field, codec fallback or production JSON
    encoder here. Revalidate typed values, including direct dataclass callers;
    an accepted shape or hash alone is never permission or provenance.
    """
    if type(value) is not ResearchChatHumanContextV1:
        raise AgentFault("invalid-chat-context")
    value.__post_init__()
    # Representation only; actual canonical encoding is solely the injected port.
    wire = asdict(value)
    wire["messages"] = list(wire["messages"])
    encoded, digest = canonical(wire, codec)
    try:
        encoded.decode("utf-8")
    except UnicodeDecodeError:
        raise AgentFault("canonical-codec-mismatch") from None
    if len(encoded) > _MAX_CANONICAL_BYTES:
        raise AgentFault("chat-context-too-large")
    return encoded, digest
