"""Republish only the actual retained old-epoch native outbox, never new events.

Preparation is read-only. Independent native approval binds exact public grant
bytes, original rows/proofs, current owner evidence, emitter and expiry. Replays
use one immutable grant, including after cloud acceptance or a partial local ACK
crash. No second queue, unsigned fallback, implicit order, capital or reset path.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, fields
import hashlib
import json
from typing import Any, Callable, Mapping

from vertex_execution.exact import timestamp
from vertex_execution.journal import Journal
from vertex_execution.ports import ExecutionError

from .epoch_transition import (
    MAX_EVIDENCE_BYTES, PreparedEpochTransition, _bytes, _canonical, _digest, _identifier,
    _integer, _prepare_evidence, _verify_prepared,
)
from .native_approval import MAX_APPROVAL_BYTES, NativeOutboxReplay, approval_subject

MAX_REPLAY_ROWS = 64
MAX_REPLAY_DECODED_BYTES = 8_388_608
MAX_REPLAY_WIRE_BYTES = 12_582_912
MAX_RETAINED_TRANSITION_BYTES = 1_048_576
_KIND = {"execution": "order", "native-fact": "native-fact", "portfolio-genesis": "portfolio-genesis",
         "portfolio-snapshot": "portfolio-snapshot"}


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ExecutionError("native-outbox-replay-" + reason)


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


@dataclass(frozen=True, slots=True)
class PreparedOutboxReplay:
    grant_binding_bytes: bytes
    rows_bytes: bytes
    evidence: PreparedEpochTransition
    publication_sequences: tuple[int, ...]
    maximum_batch_bytes: int
    retained_epoch_transition_bytes: bytes | None = None

    @property
    def grant_sha256(self) -> str:
        return _sha(self.grant_binding_bytes)


def _selected_rows(authority: Any, evidence: PreparedEpochTransition) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    outbox, _ = _verify_prepared(evidence, authority, require_acknowledged=False)
    pending = [row for row in outbox["projections"] if not row["acknowledged"]]
    _require(pending and all(row["ownerEpoch"] == str(evidence.prior_epoch) for row in pending), "pending-prior-epoch-required")
    return outbox, pending


def _row(authority: Any, outbox: Mapping[str, Any], row: Mapping[str, Any], service_actor_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    kind = _KIND[row["kind"]]
    raw = _bytes(row["payloadBase64"])
    projection = _canonical(authority, raw)
    proof = None
    proof_hash = None
    if kind in ("order", "native-fact"):
        _require(projection["actorId"] == service_actor_id, "recorded-emitter-mismatch")
        identity = projection["projectionId"]
    else:
        identity = projection["snapshotId"]
    if kind == "native-fact":
        matches = [p for p in outbox["nativeProofs"] if p["artifactId"] == projection["proof"]["artifactId"]
                   and p["sha256"] == projection["proof"]["sha256"]]
        _require(len(matches) == 1, "exact-native-proof-required")
        proof = matches[0]["payloadBase64"]
        proof_hash = _sha(_bytes(proof))
    binding = {"projectionId": identity, "sequence": row["sequence"], "eventHash": row["eventHash"],
               "projectionRawSha256": _sha(raw), "kind": kind, "proofSha256": proof_hash}
    content = {"kind": kind, "projectionBase64": row["payloadBase64"], "proofBase64": proof}
    return binding, content


def _starting_head(outbox: Mapping[str, Any], first: Mapping[str, Any], prior_epoch: int) -> tuple[int, str | None]:
    preceding = [r for r in outbox["projections"] if r["ownerEpoch"] == str(prior_epoch)
                 and _integer(r["publicationSequence"], positive=True) < _integer(first["publicationSequence"], positive=True)]
    if not preceding:
        return 0, None
    _require(all(r["acknowledged"] for r in preceding), "nonprefix-prior-acknowledgment")
    return _integer(preceding[-1]["sequence"], positive=True), preceding[-1]["eventHash"]


def _rollover_predecessor(outbox: Mapping[str, Any], first: Mapping[str, Any]) -> Mapping[str, Any] | None:
    if first["kind"] != "portfolio-genesis":
        return None
    earlier = [row for row in outbox["projections"]
               if _integer(row["publicationSequence"], positive=True) < _integer(first["publicationSequence"], positive=True)]
    # A first-ever native genesis can follow several empty crash claims. Epoch
    # number alone is NOT evidence of a prior projected portfolio or rollover.
    if not earlier:
        return None
    previous = earlier[-1]
    _require(all(row["acknowledged"] for row in earlier)
             and _integer(previous["ownerEpoch"], positive=True) < _integer(first["ownerEpoch"], positive=True),
             "rollover-prior-projected-head-required")
    return previous


def _verify_retained_transition(authority: Any, outbox: Mapping[str, Any], first: Mapping[str, Any],
                                raw: bytes | None) -> dict[str, Any] | None:
    previous = _rollover_predecessor(outbox, first)
    if previous is None:
        _require(raw is None, "unexpected-retained-transition")
        return None
    _require(type(raw) is bytes and 0 < len(raw) <= MAX_RETAINED_TRANSITION_BYTES, "original-retained-transition-required")
    wrapper = _canonical(authority, raw, MAX_RETAINED_TRANSITION_BYTES)
    _require(authority.validate("PortfolioEpochTransition", wrapper) is True, "retained-transition-native-contract-required")
    original = _bytes(first["payloadBase64"])
    _require(authority.encode(wrapper["snapshot"]) == original
             and wrapper["priorOwnerEpoch"] == previous["ownerEpoch"]
             and wrapper["priorProjectionSequence"] == previous["sequence"]
             and wrapper["priorProjectionHash"] == previous["eventHash"]
             and wrapper["journalIdentity"] == outbox["journalIdentity"], "retained-transition-original-anchor-mismatch")
    # The immutable wrapper was consumed/stored immediately before this exact
    # native genesis append. Do not substitute a newer wrapper or its proof.
    events = [(row, _canonical(authority, _bytes(row["payloadBase64"]))) for row in outbox["events"]]
    genesis = [(row, event) for row, event in events
               if event["kind"] == "portfolio-genesis" and event["data"]["snapshotId"] == wrapper["snapshot"]["snapshotId"]]
    _require(len(genesis) == 1, "retained-transition-native-genesis-required")
    row, event = genesis[0]
    _require(event["ownerEpoch"] == first["ownerEpoch"]
             and wrapper["journalSequence"] == str(_integer(row["sequence"], positive=True) - 1)
             and wrapper["journalHeadSha256"] == row["previousHash"], "retained-transition-native-predecessor-mismatch")
    return wrapper


def _batch_payload(grant: Mapping[str, Any], rows: list[dict[str, Any]], retained: bytes | None) -> dict[str, Any]:
    return {"grant": grant, "rows": rows,
            "retainedEpochTransitionBase64": base64.b64encode(retained).decode("ascii") if retained is not None else None}


def prepare_outbox_replay(journal: Journal, *, journal_identity: str, stream_id: str, prior_epoch: int,
                          cloud_head: tuple[int, str | None], service_actor_id: str, grant_id: str,
                          now_ns: int, expires_ns: int, maximum_batch_bytes: int = 1_048_576,
                          epoch_transition_lookup: Callable[[dict[str, Any]], dict[str, Any]] | None = None) -> PreparedOutboxReplay:
    """Read full bounded persisted proof, then select an indivisible <=64 prefix.

    A non-genesis cloud_head is a fresh control observation, not authority; it
    must equal the local predecessor or an exact retained head in this batch.
    For first pending genesis, callers may use the intrinsic native (0, None):
    the server checks actual cloud absence, prior transition head or duplicates.
    Existing rollover requires its original journal-persisted signed wrapper,
    never a newly signed historical transition or an initial-capital fallback.
    """
    _identifier(service_actor_id)
    _identifier(grant_id)
    _require(type(now_ns) is int and type(expires_ns) is int and 0 <= now_ns < expires_ns,
             "explicit-grant-clock-required")
    _require(type(maximum_batch_bytes) is int and 65_536 <= maximum_batch_bytes <= MAX_REPLAY_WIRE_BYTES,
             "explicit-request-byte-bound")
    _require(type(cloud_head) is tuple and len(cloud_head) == 2 and type(cloud_head[0]) is int and cloud_head[0] >= 0
             and (cloud_head[0] == 0) == (cloud_head[1] is None), "cloud-head-shape")
    if cloud_head[1] is not None:
        _digest(cloud_head[1])
    with journal.mutex:
        # This is a read from the already-owned journal connection, never a new
        # database, new queue or caller-supplied projection collection.
        head = journal._db().execute("SELECT sequence,event_hash FROM projections WHERE owner_epoch=? ORDER BY publication_sequence DESC LIMIT 1",
                                     (str(prior_epoch),)).fetchone()
        _require(head is not None, "persisted-prior-outbox-required")
        evidence = _prepare_evidence(journal, journal_identity=journal_identity, stream_id=stream_id, prior_epoch=prior_epoch,
                    prior_projection=(int(head[0]), head[1]), now_ns=now_ns, require_acknowledged=False)
        outbox, pending = _selected_rows(journal.authority, evidence)
        starting = _starting_head(outbox, pending[0], prior_epoch)
        retained = None
        if _rollover_predecessor(outbox, pending[0]) is not None:
            _require(callable(epoch_transition_lookup), "original-transition-lookup-required")
            snapshot = _canonical(journal.authority, _bytes(pending[0]["payloadBase64"]))
            wrapper = epoch_transition_lookup(snapshot)
            _require(type(wrapper) is dict, "original-retained-transition-required")
            retained = journal.authority.encode(wrapper)
        _verify_retained_transition(journal.authority, outbox, pending[0], retained)
        grant = {"schemaVersion": "1.0.0", "grantId": grant_id, "accountAlias": evidence.account_alias, "environment": "paper",
                 "streamId": stream_id, "priorOwnerEpoch": str(prior_epoch), "currentOwnerEpoch": str(evidence.current_epoch),
                 "serviceActorId": service_actor_id, "startingSequence": str(starting[0]), "startingEventHash": starting[1],
                 "journalIdentity": journal_identity, "journalSequence": str(evidence.journal_sequence), "journalHeadSha256": evidence.journal_head_sha256,
                 "nativeJournalEvidenceSha256": evidence.outbox_sha256, "nativeOwnerFenceSha256": evidence.owner_fence_sha256,
                 "retainedEpochTransitionSha256": _sha(retained) if retained is not None else None,
                 "issuedAt": timestamp(now_ns), "expiresAt": timestamp(expires_ns), "rows": []}
        contents, publications = [], []
        decoded = MAX_APPROVAL_BYTES + (len(retained) if retained is not None else 0)
        # Reserve the actual native authority's maximum signature envelope size,
        # not a fabricated approval. Bound includes request/fence overhead slack.
        approval_wire_budget = 4 * ((MAX_APPROVAL_BYTES + 2) // 3) + 4096
        for row in pending[:MAX_REPLAY_ROWS]:
            binding, content = _row(journal.authority, outbox, row, service_actor_id)
            row_size = len(_bytes(content["projectionBase64"])) + (len(_bytes(content["proofBase64"])) if content["proofBase64"] else 0)
            candidate = {**grant, "rows": [*grant["rows"], binding]}
            candidate_rows = [*contents, content]
            estimated = len(journal.authority.encode(_batch_payload(candidate, candidate_rows, retained))) + approval_wire_budget
            if estimated > maximum_batch_bytes or decoded + row_size > MAX_REPLAY_DECODED_BYTES:
                _require(bool(contents), "first-row-exceeds-request-bound")
                break  # An explicit bounded prefix; no half row or omitted proof.
            grant["rows"].append(binding)
            contents.append(content)
            publications.append(_integer(row["publicationSequence"], positive=True))
            decoded += row_size
        # A response may have been lost after cloud commit. Never skip the local
        # pending prefix: a fresh new-owner signed grant may resend its exact
        # original rows and the server atomically checks/applies duplicates.
        possible_cloud_heads = {starting, *((_integer(r["sequence"], positive=True), r["eventHash"]) for r in grant["rows"])}
        _require(cloud_head in possible_cloud_heads, "cloud-head-outside-retained-batch")
        binding_bytes = journal.authority.encode(grant)
        _require(0 < len(binding_bytes) <= 65_536, "native-grant-binding-byte-bound")
        prepared = PreparedOutboxReplay(binding_bytes, journal.authority.encode({"rows": contents}), evidence,
                                        tuple(publications), maximum_batch_bytes, retained)
        _verify_material(journal.authority, prepared)
        return prepared


def _verify_material(authority: Any, prepared: PreparedOutboxReplay) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    _require(type(prepared) is PreparedOutboxReplay and type(prepared.maximum_batch_bytes) is int
             and 65_536 <= prepared.maximum_batch_bytes <= MAX_REPLAY_WIRE_BYTES, "prepared-replay-required")
    grant = _canonical(authority, prepared.grant_binding_bytes, 65_536)
    _require(set(grant) == set("schemaVersion grantId accountAlias environment streamId priorOwnerEpoch currentOwnerEpoch serviceActorId "
             "startingSequence startingEventHash journalIdentity journalSequence journalHeadSha256 nativeJournalEvidenceSha256 nativeOwnerFenceSha256 "
             "retainedEpochTransitionSha256 issuedAt expiresAt rows".split()),
             "grant-binding-field-set")
    _require(grant["schemaVersion"] == "1.0.0" and grant["environment"] == "paper", "grant-binding-version")
    contents = _canonical(authority, prepared.rows_bytes, MAX_REPLAY_WIRE_BYTES)
    _require(set(contents) == {"rows"} and type(contents["rows"]) is list and type(grant["rows"]) is list
             and 1 <= len(contents["rows"]) == len(grant["rows"]) == len(prepared.publication_sequences) <= MAX_REPLAY_ROWS,
             "prepared-row-count")
    _require(type(prepared.publication_sequences) is tuple
             and all(type(n) is int and n > 0 for n in prepared.publication_sequences), "publication-identity-required")
    outbox, pending = _selected_rows(authority, prepared.evidence)
    _require(len(pending) >= len(grant["rows"]), "retained-prefix-row-count")
    _verify_retained_transition(authority, outbox, pending[0], prepared.retained_epoch_transition_bytes)
    expected = {"accountAlias": prepared.evidence.account_alias, "streamId": prepared.evidence.stream_id,
                "priorOwnerEpoch": str(prepared.evidence.prior_epoch), "currentOwnerEpoch": str(prepared.evidence.current_epoch),
                "journalIdentity": prepared.evidence.journal_identity, "journalSequence": str(prepared.evidence.journal_sequence),
                "journalHeadSha256": prepared.evidence.journal_head_sha256, "nativeJournalEvidenceSha256": prepared.evidence.outbox_sha256,
                "nativeOwnerFenceSha256": prepared.evidence.owner_fence_sha256,
                "retainedEpochTransitionSha256": _sha(prepared.retained_epoch_transition_bytes) if prepared.retained_epoch_transition_bytes is not None else None}
    _require(all(grant[k] == v for k, v in expected.items())
             and prepared.evidence.captured_at_ns <= authority.epoch_ns(grant["issuedAt"]) < authority.epoch_ns(grant["expiresAt"]),
             "grant-evidence-anchor-mismatch")
    _identifier(grant["serviceActorId"])
    _identifier(grant["grantId"])
    start = _starting_head(outbox, pending[0], prepared.evidence.prior_epoch)
    _require((str(start[0]), start[1]) == (grant["startingSequence"], grant["startingEventHash"]), "grant-predecessor-mismatch")
    sequence, event_hash = start
    for index, (binding, content) in enumerate(zip(grant["rows"], contents["rows"], strict=True)):
        row = pending[index]
        expected_binding, expected_content = _row(authority, outbox, row, grant["serviceActorId"])
        _require(binding == expected_binding and content == expected_content
                 and prepared.publication_sequences[index] == _integer(row["publicationSequence"], positive=True), "original-row-substitution")
        if binding["kind"] == "portfolio-snapshot":
            _require(sequence > 0 and binding["sequence"] == str(sequence) and binding["eventHash"] == event_hash,
                     "snapshot-head-mismatch")
        else:
            _require(_integer(binding["sequence"], positive=True) == sequence + 1
                     and (sequence == 0) == (binding["kind"] == "portfolio-genesis"), "row-sequence-mismatch")
            sequence, event_hash = sequence + 1, binding["eventHash"]
    decoded_bytes = MAX_APPROVAL_BYTES + (len(prepared.retained_epoch_transition_bytes) if prepared.retained_epoch_transition_bytes is not None else 0)
    decoded_bytes += sum(len(_bytes(row["projectionBase64"]))
                    + (len(_bytes(row["proofBase64"])) if row["proofBase64"] is not None else 0) for row in contents["rows"])
    _require(decoded_bytes <= MAX_REPLAY_DECODED_BYTES
             and len(authority.encode(_batch_payload(grant, contents["rows"], prepared.retained_epoch_transition_bytes)))
                 + 4 * ((MAX_APPROVAL_BYTES + 2) // 3) + 4096
                 <= prepared.maximum_batch_bytes, "prepared-batch-byte-bound")
    return grant, contents["rows"], outbox


def assert_current_replay_anchor(journal: Journal, prepared: PreparedOutboxReplay) -> None:
    """Permit only exact already-ACKed batch prefixes after a local ACK crash."""
    _, _, original = _verify_material(journal.authority, prepared)
    evidence = prepared.evidence
    current = _prepare_evidence(journal, journal_identity=evidence.journal_identity, stream_id=evidence.stream_id,
              prior_epoch=evidence.prior_epoch, prior_projection=(evidence.prior_projection_sequence, evidence.prior_projection_hash),
              now_ns=evidence.captured_at_ns, require_acknowledged=False)
    candidate = json.loads(current.outbox_bytes)
    _require(len(candidate["projections"]) == len(original["projections"]), "retained-row-count-changed")
    allowed = set(prepared.publication_sequences)
    for before, after in zip(original["projections"], candidate["projections"], strict=True):
        if before["acknowledged"] != after["acknowledged"]:
            _require(before["acknowledged"] is False and after["acknowledged"] is True
                     and _integer(before["publicationSequence"], positive=True) in allowed, "unrelated-ack-state-changed")
            after["acknowledged"] = False
    _require(journal.authority.encode(candidate) == evidence.outbox_bytes, "retained-journal-evidence-changed")
    fence = json.loads(current.owner_fence_bytes)
    fence["nativeOutboxEvidenceSha256"] = evidence.outbox_sha256
    _require(journal.authority.encode(fence) == evidence.owner_fence_bytes, "current-native-owner-fence-changed")


def build_outbox_replay(prepared: PreparedOutboxReplay, *, journal: Journal, approval_authority: Any, now_ns: int) -> dict[str, Any]:
    """Verify/consume or exact-retry the independently installed signed grant."""
    with journal.mutex:
        grant, rows, _ = _verify_material(journal.authority, prepared)
        assert_current_replay_anchor(journal, prepared)
        _require(type(now_ns) is int and journal.authority.epoch_ns(grant["issuedAt"]) <= now_ns < journal.authority.epoch_ns(grant["expiresAt"]),
                 "grant-expired")
        subject = NativeOutboxReplay(prepared.grant_binding_bytes)
        signed = approval_authority.installed_approval_bytes(grant["grantId"])
        _require(type(signed) is bytes and len(signed) <= MAX_APPROVAL_BYTES, "approval-size-bound")
        approval = _canonical(journal.authority, signed)
        payload = approval["payload"]
        _require(payload["approvalId"] == grant["grantId"] and payload["action"] == "native-outbox-replay"
                 and payload["ownerEpoch"] == grant["currentOwnerEpoch"]
                 and _integer(payload["issuedNs"]) == journal.authority.epoch_ns(grant["issuedAt"])
                 and _integer(payload["expiresNs"]) == journal.authority.epoch_ns(grant["expiresAt"])
                 and payload["subject"] == approval_subject(subject, authority=journal.authority), "approval-exact-binding-mismatch")
        batch = _batch_payload({**grant, "approvalBase64": base64.b64encode(signed).decode("ascii")}, rows, prepared.retained_epoch_transition_bytes)
        _require(journal.authority.validate("NativeOutboxReplay", batch) is True, "native-replay-contract-unavailable")
        _require(len(journal.authority.encode(batch)) + 4096 <= prepared.maximum_batch_bytes, "signed-batch-request-bound")
        assert_current_replay_anchor(journal, prepared)
        _require(approval_authority.verify(subject, now_ns=now_ns) is True, "independent-native-approval-required")
        return batch


def apply_outbox_replay_ack(journal: Journal, prepared: PreparedOutboxReplay, *, ack: Mapping[str, Any]) -> int:
    """Apply only a trusted control response acknowledging the WHOLE exact batch.

    The server commits a grant atomically. A partial/different high-water cannot
    disambiguate snapshots at the same sequence, so it acknowledges NOTHING here.
    A crash between local ACK rows is recovered by retrying the original grant.
    The caller obtains ack from its authenticated control port, never a payload.
    """
    with journal.mutex:
        grant, _, original = _verify_material(journal.authority, prepared)
        _require(journal.authority.validate("WorkerProjectionAck", ack) is True and ack["status"] in ("applied", "duplicate"),
                 "server-whole-batch-ack-required")
        final = grant["rows"][-1]
        _require(ack["highWaterSequence"] == final["sequence"] and ack["highWaterEventHash"] == final["eventHash"],
                 "server-exact-terminal-ack-required")
        assert_current_replay_anchor(journal, prepared)
        rows_by_publication = {_integer(row["publicationSequence"], positive=True): row for row in original["projections"]}
        count = 0
        for publication in prepared.publication_sequences:
            row = rows_by_publication[publication]
            saved = journal._db().execute("SELECT event_hash,acknowledged FROM projections WHERE publication_sequence=?", (publication,)).fetchone()
            _require(saved is not None and saved[0] == row["eventHash"] and type(saved[1]) is int and saved[1] in (0, 1),
                     "local-ack-row-changed")
            if saved[1] == 1:
                continue
            # Existing journal method verifies it is the FIRST pending row and
            # persists exactly that original hash in its normal durable transaction.
            journal.acknowledge_projection(publication, row["eventHash"])
            count += 1
        return count


_EVIDENCE_BYTE_FIELDS = frozenset(("outbox_bytes", "owner_fence_bytes", "owned_state_bytes", "prior_state_bytes"))
_EVIDENCE_INTEGER_FIELDS = frozenset(("prior_epoch", "current_epoch", "journal_sequence", "prior_projection_sequence", "captured_at_ns"))
MAX_REPLAY_RECEIPT_BYTES = 16_777_216


def replay_receipt(prepared: PreparedOutboxReplay, *, authority: Any) -> bytes:
    """Canonical private persistence record; caller owns its durable storage.

    This is recovery material, not a second queue or renewed authority. Restoring
    it replays the originals; current owner and signed approval checks still run
    before any transmission or local ACK.
    """
    _verify_material(authority, prepared)
    evidence = {}
    for field in fields(PreparedEpochTransition):
        value = getattr(prepared.evidence, field.name)
        evidence[field.name] = (base64.b64encode(value).decode("ascii") if field.name in _EVIDENCE_BYTE_FIELDS
                               else str(value) if field.name in _EVIDENCE_INTEGER_FIELDS else value)
    record = {"format": "vertex-native-outbox-replay-receipt-v1", "grantBindingBase64": base64.b64encode(prepared.grant_binding_bytes).decode("ascii"),
              "rowsBase64": base64.b64encode(prepared.rows_bytes).decode("ascii"), "evidence": evidence,
              "retainedEpochTransitionBase64": base64.b64encode(prepared.retained_epoch_transition_bytes).decode("ascii")
                  if prepared.retained_epoch_transition_bytes is not None else None,
              "publicationSequences": [str(n) for n in prepared.publication_sequences], "maximumBatchBytes": str(prepared.maximum_batch_bytes)}
    raw = authority.encode(record)
    _require(len(raw) <= MAX_REPLAY_RECEIPT_BYTES, "receipt-byte-bound")
    return raw


def _receipt_blob(value: Any, maximum: int) -> bytes:
    _require(type(value) is str and 0 < len(value) <= 4 * ((maximum + 2) // 3), "receipt-blob-bound")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise ExecutionError("native-outbox-replay-receipt-blob-invalid") from exc
    _require(0 < len(raw) <= maximum and base64.b64encode(raw).decode("ascii") == value, "receipt-blob-noncanonical")
    return raw


def restore_replay_receipt(raw: bytes, *, authority: Any) -> PreparedOutboxReplay:
    """Pure decoding of exact original recovery material; no IO/reauthorization."""
    value = _canonical(authority, raw, MAX_REPLAY_RECEIPT_BYTES)
    _require(set(value) == {"format", "grantBindingBase64", "rowsBase64", "evidence", "publicationSequences", "maximumBatchBytes", "retainedEpochTransitionBase64"}
             and value["format"] == "vertex-native-outbox-replay-receipt-v1", "receipt-shape-mismatch")
    evidence = value["evidence"]
    _require(type(evidence) is dict and set(evidence) == {field.name for field in fields(PreparedEpochTransition)}, "receipt-evidence-shape")
    decoded = {}
    for name, item in evidence.items():
        if name in _EVIDENCE_BYTE_FIELDS:
            decoded[name] = _receipt_blob(item, MAX_EVIDENCE_BYTES)
        elif name in _EVIDENCE_INTEGER_FIELDS:
            decoded[name] = _integer(item)
        else:
            _require(type(item) is str, "receipt-evidence-text-required")
            decoded[name] = item
    _require(type(value["publicationSequences"]) is list and 1 <= len(value["publicationSequences"]) <= MAX_REPLAY_ROWS,
             "receipt-publication-bound")
    prepared = PreparedOutboxReplay(_receipt_blob(value["grantBindingBase64"], 65_536),
                 _receipt_blob(value["rowsBase64"], MAX_REPLAY_WIRE_BYTES), PreparedEpochTransition(**decoded),
                 tuple(_integer(n, positive=True) for n in value["publicationSequences"]), _integer(value["maximumBatchBytes"], positive=True),
                 _receipt_blob(value["retainedEpochTransitionBase64"], MAX_RETAINED_TRANSITION_BYTES)
                     if value["retainedEpochTransitionBase64"] is not None else None)
    _verify_material(authority, prepared)
    _require(replay_receipt(prepared, authority=authority) == raw, "receipt-roundtrip-mismatch")
    return prepared
