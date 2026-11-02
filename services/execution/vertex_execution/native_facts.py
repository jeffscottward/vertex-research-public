"""Pure, observation-only facts from a fenced native paper journal transition.

The caller supplies the actual Journal.append envelope and its candidate owned
state, not a cloud projection or external evidence claim. The journal must store
that immutable event, the canonical NativeJournalProof bytes and the projection
atomically. Computing a proof does not authenticate callers or grant authority.
Public fact fields and invariants belong exclusively to ContractAuthority.
"""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
from typing import Any

from .exact import timestamp
from .ports import ContractAuthority, ExecutionError


_JOURNAL_FIELDS = frozenset({
    "sequence", "previousHash", "ownerEpoch", "eventId", "occurredNs", "kind", "data",
})


def _digest(value: Any) -> str:
    if (type(value) is not str or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)):
        raise ExecutionError("native-fact-invalid-digest")
    return value


def _journal_sequence(value: Any) -> None:
    if (type(value) is not str or not value.isascii() or not value.isdecimal()
            or value.startswith("0")):
        raise ExecutionError("native-fact-invalid-journal-sequence")


def build_native_fact_bundle(
    authority: ContractAuthority,
    owned_state: dict[str, Any],
    stream_id: str,
    owner_epoch: int,
    sequence: int,
    previous_event_hash: str,
    native_emitter_actor_id: str,
    policy_version: str,
    occurred_ns: int,
    received_ns: int,
    ttl_ns: int,
    event_id: str,
    journal_event: dict[str, Any],
    fact: dict[str, Any],
    *,
    fact_ordinal: int,
) -> tuple[dict[str, Any], bytes]:
    """Build a fact and its canonical proof; no IO, mutation, or risk decision.

    ``sequence`` is the shared publication ordinal, not the journal sequence.
    Sequence one belongs solely to PortfolioGenesis. ``event_id`` is a stable,
    caller-owned idempotency key for the actual journal event plus ``fact_ordinal``
    (zero through 63). Multiple facts from one event must receive different keys.
    ``received_ns``
    is the first durable receipt time: publication retries use stored bytes,
    never rebuild with a fresh clock. TTL is observation retention only.
    """
    if type(fact_ordinal) is not int or not 0 <= fact_ordinal <= 63:
        raise ExecutionError("native-fact-ordinal-invalid")
    if any(type(value) is not int for value in (occurred_ns, received_ns, ttl_ns)):
        raise ExecutionError("native-fact-integer-nanoseconds-required")
    if occurred_ns < 0 or received_ns < occurred_ns or ttl_ns <= 0:
        raise ExecutionError("native-fact-chronology-invalid")
    occurred_at = timestamp(occurred_ns)
    received_at = timestamp(received_ns)
    expires_at = timestamp(received_ns + ttl_ns)
    if type(owner_epoch) is not int or owner_epoch <= 0:
        raise ExecutionError("native-fact-owner-epoch-mismatch")
    if type(sequence) is not int or sequence < 2:
        raise ExecutionError("native-fact-genesis-required")
    _digest(previous_event_hash)
    if (type(owned_state) is not dict or owned_state.get("environment") != "paper"
            or type(owned_state.get("accountAlias")) is not str
            or not owned_state["accountAlias"]
            or type(owned_state.get("simulatorId")) is not str
            or not owned_state["simulatorId"]):
        raise ExecutionError("native-fact-owned-paper-scope-required")
    if owned_state.get("ownerEpoch") != str(owner_epoch):
        raise ExecutionError("native-fact-owner-epoch-mismatch")
    if type(journal_event) is not dict or set(journal_event) != _JOURNAL_FIELDS:
        raise ExecutionError("native-fact-journal-envelope-required")
    source = deepcopy(journal_event)
    _journal_sequence(source["sequence"])
    _digest(source["previousHash"])
    if (source["ownerEpoch"] != str(owner_epoch)
            or source["occurredNs"] != str(occurred_ns)):
        raise ExecutionError("native-fact-journal-lineage-mismatch")
    if (type(source["eventId"]) is not str or not source["eventId"]
            or type(source["kind"]) is not str or not source["kind"]
            or source["kind"] == "epoch-claimed" or type(source["data"]) is not dict):
        raise ExecutionError("native-fact-journal-envelope-required")
    # Journal envelopes have no top-level account. Bind native owner scope and
    # any explicit transition scope, rather than inventing a source account.
    for field in ("accountAlias", "environment", "simulatorId", "ownerEpoch"):
        if field in source["data"] and source["data"][field] != owned_state[field]:
            raise ExecutionError("native-fact-journal-scope-mismatch")
    if type(fact) is not dict:
        raise ExecutionError("native-fact-payload-required")
    source_digest = _digest(authority.digest(source))
    proof = {
        "schemaVersion": "1.0.0",
        "proofKind": "native-journal-event",
        "accountAlias": owned_state["accountAlias"],
        "environment": "paper",
        "streamId": stream_id,
        "ownerEpoch": str(owner_epoch),
        "sourceEventId": source["eventId"],
        "journalSequence": source["sequence"],
        "journalHeadHash": source_digest,
        "factOrdinal": fact_ordinal,
        "occurredAt": occurred_at,
        "eventType": fact.get("kind"),
        "payload": deepcopy(fact),
    }
    if authority.validate("NativeJournalProof", proof) is not True:
        raise ExecutionError("native-journal-proof-validation-required")
    if fact.get("kind") == "checkpoint" and (
            fact.get("journalSequence") != source["sequence"]
            or fact.get("journalHeadHash") != source_digest):
        raise ExecutionError("native-fact-checkpoint-head-mismatch")
    proof_bytes = authority.encode(proof)
    proof_digest = _digest(authority.digest(proof))
    # Raw artifact bytes and native canonical object hashing must agree. Never
    # mistake the internal journal head hash for the public proof artifact hash.
    if type(proof_bytes) is not bytes or sha256(proof_bytes).hexdigest() != proof_digest:
        raise ExecutionError("native-journal-proof-codec-mismatch")
    value = {
        "schemaVersion": "1.0.0",
        "projectionId": f"native-fact-{owner_epoch}-{sequence}",
        "accountAlias": owned_state["accountAlias"],
        "environment": "paper",
        "streamId": stream_id,
        "ownerEpoch": str(owner_epoch),
        "sequence": str(sequence),
        "previousEventHash": previous_event_hash,
        "proofJournalSequence": source["sequence"],
        "proofJournalHeadHash": source_digest,
        "factOrdinal": fact_ordinal,
        "occurredAt": occurred_at,
        "receivedAt": received_at,
        "actorId": native_emitter_actor_id,
        "policyVersion": policy_version,
        "expiresAt": expires_at,
        "idempotencyKey": event_id,
        "sourceKind": "paper-simulation",
        "proof": {
            "artifactId": "journalproof-" + proof_digest,
            "sha256": proof_digest,
            "sourceEventId": source["eventId"],
        },
        "fact": deepcopy(fact),
        "authoritative": False,
        "reservationAuthority": "native-owner-only",
        "executionAuthorized": False,
    }
    # Hash the entire projection before adding its only self-hash field.
    value["eventHash"] = _digest(authority.digest(value))
    if authority.validate("NativeFactProjection", value) is not True:
        raise ExecutionError("native-fact-validation-required")
    return value, proof_bytes


def build_native_fact(
    authority: ContractAuthority,
    owned_state: dict[str, Any],
    stream_id: str,
    owner_epoch: int,
    sequence: int,
    previous_event_hash: str,
    native_emitter_actor_id: str,
    policy_version: str,
    occurred_ns: int,
    received_ns: int,
    ttl_ns: int,
    event_id: str,
    journal_event: dict[str, Any],
    fact: dict[str, Any],
    *,
    fact_ordinal: int,
) -> dict[str, Any]:
    """Projection-only convenience; atomic persistence uses the bundle API."""
    return build_native_fact_bundle(
        authority=authority, owned_state=owned_state, stream_id=stream_id,
        owner_epoch=owner_epoch, sequence=sequence,
        previous_event_hash=previous_event_hash,
        native_emitter_actor_id=native_emitter_actor_id, policy_version=policy_version,
        occurred_ns=occurred_ns, received_ns=received_ns, ttl_ns=ttl_ns,
        event_id=event_id, journal_event=journal_event, fact=fact,
        fact_ordinal=fact_ordinal,
    )[0]
