"""Restored native-owner epoch handoff from actual persisted journal evidence.

No database is opened here. The caller supplies its already-owned Journal; every
SELECT runs under that owner's mutex. Full bounded histories are copied without
compaction. Overflow, missing ACKs, unknown schema/events or changed balances fail
unavailable. No worker assertion, caller boolean or public snapshot supplies cash.

Owner-fence bytes describe the actual process, open lock-file identity and claimed
journal epoch. They are NOT cryptographic proof of a live OS lock: the separately
enrolled native signer attests the provenance and the server independently checks
the signed bytes, current enrollment, replayed history and one-use approval.
"""
from __future__ import annotations

import base64
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import os
import re
import stat
from typing import Any, Mapping

from vertex_execution.exact import timestamp
from vertex_execution.journal import Journal, apply_event, initial_state
from vertex_execution.portfolio_projection import build_genesis, build_snapshot, validate_genesis
from vertex_execution.ports import ExecutionError
from vertex_execution.projection import build_projection

from .native_approval import NativeEpochTransition, approval_subject

MAX_EVIDENCE_BYTES = 1_048_576
MAX_ROWS = 4096
MAX_ROW_BYTES = 262_144
MAX_SOURCE_BYTES = 524_288
_OUTBOX_FORMAT = "vertex-native-outbox-evidence-v1"
_FENCE_FORMAT = "vertex-native-owner-fence-v1"
_ZERO = "0" * 64
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_POST_CLAIM = frozenset(("pause", "observation", "reconciled"))
_STATE_METADATA = frozenset(("ownerEpoch", "pausedNewRisk", "reconciled", "pauseReasons", "observation", "portfolioRevision"))


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ExecutionError("epoch-transition-" + reason)


def _identifier(value: Any) -> str:
    _require(type(value) is str and _IDENTIFIER.fullmatch(value) is not None, "identifier-required")
    return value


def _integer(value: Any, *, positive: bool = False) -> int:
    _require(type(value) is str and value.isascii() and value.isdecimal() and len(value) <= 39
             and (value == "0" or not value.startswith("0")), "canonical-integer-required")
    result = int(value)
    _require(result < 2**127 and (not positive or result > 0), "integer-bound")
    return result


def _digest(value: Any) -> str:
    _require(type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value), "digest-required")
    return value


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _require(key not in result, "duplicate-json-key")
        result[key] = value
    return result


def _no_number(_: str) -> None:
    raise ExecutionError("epoch-transition-nonexact-json-number")


def _canonical(authority: Any, raw: bytes, maximum: int = MAX_ROW_BYTES) -> dict[str, Any]:
    _require(type(raw) is bytes and 0 < len(raw) <= maximum, "canonical-byte-bound")
    try:
        value = json.loads(raw, object_pairs_hook=_pairs, parse_float=_no_number, parse_constant=_no_number)
        _require(type(value) is dict and authority.encode(value) == raw, "noncanonical-source")
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise ExecutionError("epoch-transition-invalid-source-json") from exc


def _bytes(value: Any) -> bytes:
    _require(type(value) is str and 0 < len(value) <= 4 * ((MAX_ROW_BYTES + 2) // 3), "base64-bound")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise ExecutionError("epoch-transition-invalid-base64") from exc
    _require(0 < len(raw) <= MAX_ROW_BYTES and base64.b64encode(raw).decode("ascii") == value, "noncanonical-base64")
    return raw


def _fields(value: Any, names: str) -> dict[str, Any]:
    _require(type(value) is dict and set(value) == set(names.split()), "evidence-field-set")
    return value


def _rows(value: Any, maximum: int = MAX_ROWS) -> list[Any]:
    _require(type(value) is list and len(value) <= maximum, "history-row-bound")
    return value


def _encoded_row(raw: Any) -> str:
    _require(type(raw) is bytes and 0 < len(raw) <= MAX_ROW_BYTES, "source-row-byte-bound")
    return base64.b64encode(raw).decode("ascii")


def _economic(state: Mapping[str, Any]) -> dict[str, Any]:
    """Only documented claim/observation metadata may differ across restoration."""
    value = {k: deepcopy(v) for k, v in state.items() if k not in _STATE_METADATA}
    # The exact claim reducer marks unresolved dispatched orders unknown. Nothing
    # else about quantities, reservations, fees, finality or lineage may change.
    for order in value["orders"].values():
        if order["dispatchMarked"] and not order["finalityProven"]:
            order["status"] = "unknown"
    return value


@dataclass(frozen=True, slots=True)
class PreparedEpochTransition:
    outbox_bytes: bytes
    owner_fence_bytes: bytes
    owned_state_bytes: bytes
    prior_state_bytes: bytes
    outbox_sha256: str
    owner_fence_sha256: str
    journal_identity: str
    stream_id: str
    account_alias: str
    simulator_id: str
    prior_epoch: int
    current_epoch: int
    journal_sequence: int
    prior_projection_sequence: int
    captured_at_ns: int
    prior_projection_hash: str
    journal_head_sha256: str
    state_sha256: str

    @property
    def outbox_artifact_id(self) -> str:
        return "native-outbox-evidence-" + self.outbox_sha256

    @property
    def owner_fence_artifact_id(self) -> str:
        return "native-owner-fence-" + self.owner_fence_sha256


@dataclass(frozen=True, slots=True)
class ReplayedEpochEvidence:
    owned_state_bytes: bytes
    prior_state_bytes: bytes
    claim_sequence: int
    claim_event_hash: str
    claim_payload_bytes: bytes


def replay_epoch_evidence(authority: Any, outbox_bytes: bytes) -> ReplayedEpochEvidence:
    return _replay_evidence(authority, outbox_bytes, require_acknowledged=True)


def _replay_evidence(authority: Any, outbox_bytes: bytes, *, require_acknowledged: bool) -> ReplayedEpochEvidence:
    """Pure replay of exported originals; never interprets a supplied status flag.

    All private row shapes are exact. Public snapshots/projections and native
    fact proof pairs are still validated by the injected native authority.
    """
    outbox = _canonical(authority, outbox_bytes, MAX_EVIDENCE_BYTES)
    _fields(outbox, "format journalIdentity accountAlias environment simulatorId currency streamId priorOwnerEpoch "
            "priorProjectionSequence priorProjectionHash ownerEpoch journalSequence journalHeadSha256 capturedAtNs "
            "initialState priorStateSha256 currentStateSha256 metadata events checkpoints projections nativeProofs nativeFactIdentities")
    _require(outbox["format"] == _OUTBOX_FORMAT and outbox["environment"] == "paper", "unsupported-evidence-format")
    for name in ("journalIdentity", "accountAlias", "simulatorId", "streamId"):
        _identifier(outbox[name])
    prior_epoch, current_epoch = _integer(outbox["priorOwnerEpoch"], positive=True), _integer(outbox["ownerEpoch"], positive=True)
    _require(current_epoch > prior_epoch, "newer-restored-epoch-required")
    now_ns = _integer(outbox["capturedAtNs"])
    initial = initial_state(outbox["accountAlias"], outbox["simulatorId"], outbox["currency"])
    _require(outbox["initialState"] == initial, "initial-state-not-owned-scope")
    metadata: dict[str, str] = {}
    last_key = ""
    for row in _rows(outbox["metadata"], 16):
        _fields(row, "key value")
        _require(type(row["key"]) is str and row["key"] > last_key and row["key"] in ("scope", "epoch", "local_pause")
                 and type(row["value"]) is str and len(row["value"].encode()) <= MAX_ROW_BYTES, "metadata-unavailable")
        metadata[row["key"]], last_key = row["value"], row["key"]
    _require(metadata.get("epoch") == str(current_epoch)
             and metadata.get("scope", "").encode() == authority.encode(initial), "metadata-owned-epoch-mismatch")
    checkpoints = {}
    last_sequence = 0
    source_size = 0
    for row in _rows(outbox["checkpoints"]):
        _fields(row, "sequence eventHash stateHash payloadBase64")
        sequence = _integer(row["sequence"], positive=True)
        _require(sequence > last_sequence, "checkpoint-order")
        raw = _bytes(row["payloadBase64"])
        _canonical(authority, raw)
        source_size += len(raw)
        checkpoints[sequence] = (row, raw)
        last_sequence = sequence
    execution_sources = set()
    for row in _rows(outbox["projections"]):
        if row["kind"] == "execution":
            projection = _canonical(authority, _bytes(row["payloadBase64"]))
            source_ids = projection["receipt"]["auditEventIds"]
            _require(type(source_ids) is list and len(source_ids) == 1, "execution-source-event-required")
            execution_sources.add(_identifier(source_ids[0]))
    state, sequence, previous = deepcopy(initial), 0, _ZERO
    event_rows: dict[int, tuple[dict[str, Any], str, bytes]] = {}
    event_ids: dict[str, dict[str, Any]] = {}
    state_before_events: dict[int, bytes] = {}
    state_after_events: dict[str, bytes] = {}
    retained_state_bytes = 0
    prior_state = None
    claim = None
    for row in _rows(outbox["events"]):
        _fields(row, "sequence eventId previousHash eventHash payloadBase64")
        number = _integer(row["sequence"], positive=True)
        raw = _bytes(row["payloadBase64"])
        source_size += len(raw)
        event = _canonical(authority, raw)
        _fields(event, "sequence previousHash ownerEpoch eventId occurredNs kind data")
        _require(number == sequence + 1 and row["previousHash"] == event["previousHash"] == previous
                 and event["sequence"] == str(number) and event["eventId"] == row["eventId"]
                 and _sha(raw) == _digest(row["eventHash"]), "journal-chain-corruption")
        _identifier(event["eventId"])
        _require(event["eventId"] not in event_ids and _integer(event["occurredNs"]) <= now_ns
                 and event["ownerEpoch"] == state["ownerEpoch"], "journal-event-scope-or-time")
        before = authority.encode(state)
        # Retain only states needed to rederive historical public snapshots.
        if event["kind"] in ("portfolio-genesis", "portfolio-checkpoint"):
            state_before_events[number] = before
        if event["kind"] == "epoch-claimed":
            _fields(event["data"], "epoch")
            claimed = _integer(event["data"]["epoch"], positive=True)
            _require(claimed == int(state["ownerEpoch"]) + 1 and claimed <= current_epoch, "claim-epoch-mismatch")
            if claimed == prior_epoch + 1:
                _require(prior_state is None and state["observation"] is not None, "restored-prior-state-required")
                prior_state = before
            if claimed == current_epoch:
                _require(claim is None and prior_state is not None, "restored-prior-state-required")
                claim = (number, row["eventHash"], raw)
        elif prior_state is not None:
            _require(event["kind"] in _POST_CLAIM, "economic-event-after-restored-claim")
        apply_event(state, event)
        after = authority.encode(state)
        _require(len(after) <= MAX_ROW_BYTES, "replayed-state-byte-bound")
        if event["eventId"] in execution_sources:
            state_after_events[event["eventId"]] = after
            retained_state_bytes += len(after)
        if number in state_before_events:
            retained_state_bytes += len(state_before_events[number])
        _require(retained_state_bytes <= MAX_SOURCE_BYTES, "historical-state-work-bound")
        sequence, previous = number, row["eventHash"]
        event_rows[number] = (event, previous, raw)
        event_ids[event["eventId"]] = event
        if number in checkpoints:
            checkpoint, checkpoint_raw = checkpoints.pop(number)
            _require(checkpoint["eventHash"] == previous and checkpoint["stateHash"] == _sha(checkpoint_raw)
                     and authority.encode(state) == checkpoint_raw, "checkpoint-replay-mismatch")
    _require(not checkpoints and claim is not None and prior_state is not None, "missing-claim-or-checkpoint-history")
    _require(sequence == _integer(outbox["journalSequence"], positive=True) and previous == _digest(outbox["journalHeadSha256"])
             and state["ownerEpoch"] == str(current_epoch) and _sha(prior_state) == outbox["priorStateSha256"]
             and authority.digest(state) == outbox["currentStateSha256"], "replayed-head-mismatch")
    _require(authority.encode(_economic(state)) == authority.encode(_economic(json.loads(prior_state)))
             and state["pausedNewRisk"] is True, "restored-economic-state-changed")
    proofs = {}
    previous_id = ""
    for row in _rows(outbox["nativeProofs"]):
        _fields(row, "artifactId sha256 payloadBase64")
        artifact_id = _identifier(row["artifactId"])
        _require(artifact_id > previous_id, "native-proof-order")
        previous_id = artifact_id
        raw = _bytes(row["payloadBase64"])
        source_size += len(raw)
        _require(_sha(raw) == _digest(row["sha256"]), "native-proof-digest-mismatch")
        _canonical(authority, raw)
        proofs[(artifact_id, row["sha256"])] = raw
    identities = {}
    for row in _rows(outbox["nativeFactIdentities"]):
        _fields(row, "ownerEpoch journalSequence journalHeadHash factOrdinal projectionHash")
        key = (row["ownerEpoch"], row["journalSequence"], row["journalHeadHash"], row["factOrdinal"])
        _require(type(row["factOrdinal"]) is int and 0 <= row["factOrdinal"] < 64 and key not in identities, "native-identity-invalid")
        _integer(row["ownerEpoch"], positive=True)
        _integer(row["journalSequence"], positive=True)
        _digest(row["journalHeadHash"])
        identities[key] = _digest(row["projectionHash"])
    chains: dict[str, tuple[int, str | None]] = {}
    source_ordinals: dict[tuple[str, str, str], int] = {}
    last_sources = {}
    latest_source_sequence = {}
    used_proofs = set()
    publication_sequence = 0
    snapshot_event_ids = set()
    pending_seen = False
    for row in _rows(outbox["projections"]):
        _fields(row, "publicationSequence ownerEpoch sequence eventHash kind acknowledged payloadBase64")
        number = _integer(row["publicationSequence"], positive=True)
        epoch, projection_sequence = row["ownerEpoch"], _integer(row["sequence"], positive=True)
        _require(number == publication_sequence + 1 and type(row["acknowledged"]) is bool
                 and (row["acknowledged"] or not require_acknowledged)
                 and not (pending_seen and row["acknowledged"])
                 and 0 < _integer(epoch, positive=True) <= prior_epoch, "prior-outbox-not-fully-acknowledged")
        pending_seen = pending_seen or not row["acknowledged"]
        publication_sequence = number
        raw = _bytes(row["payloadBase64"])
        source_size += len(raw)
        projection = _canonical(authority, raw)
        _require(projection["ownerEpoch"] == epoch and projection["sequence"] == row["sequence"]
                 and projection["accountAlias"] == outbox["accountAlias"] and projection["environment"] == "paper"
                 and projection["streamId"] == outbox["streamId"], "projection-scope-mismatch")
        previous_number, previous_hash = chains.get(epoch, (0, None))
        kind, digest = row["kind"], _digest(row["eventHash"])
        if kind == "portfolio-genesis":
            _require(previous_number == 0 and projection_sequence == 1 and validate_genesis(authority, projection) == digest,
                     "projection-genesis-chain-mismatch")
            matching = [(n, e) for n, (e, _, _) in event_rows.items()
                        if e["kind"] == "portfolio-genesis" and e["ownerEpoch"] == epoch]
            _require(len(matching) == 1, "projection-genesis-event-missing")
            n, event = matching[0]
            _require(event["data"] == {"snapshotId": projection["snapshotId"], "sequence": "1", "ownerEpoch": epoch,
                                      "sourceEventHash": digest}, "projection-genesis-source-mismatch")
            prior_snapshot_state = json.loads(state_before_events[n])
            expected = build_genesis(authority=authority, owned_state=prior_snapshot_state, stream_id=outbox["streamId"], owner_epoch=int(epoch),
                                     observed_at=projection["asOfAt"], received_at=projection["receivedAt"],
                                     evaluated_at=projection["continuity"]["evaluatedAt"],
                                     max_age_ms=projection["continuity"]["freshness"]["maxAgeMs"], snapshot_id=projection["snapshotId"])
            _require(authority.encode(expected) == raw, "historical-genesis-not-native-state")
            snapshot_event_ids.add(event["eventId"])
        elif kind in ("execution", "native-fact"):
            _require(previous_number > 0 and projection_sequence == previous_number + 1
                     and projection["previousEventHash"] == previous_hash and projection["eventHash"] == digest,
                     "projection-chain-mismatch")
            contract = "ExecutionProjection" if kind == "execution" else "NativeFactProjection"
            if kind == "execution":
                source_id = projection["receipt"]["auditEventIds"][0]
                _require(source_id in state_after_events and event_ids[source_id]["ownerEpoch"] == epoch,
                         "execution-source-not-owned-event")
                source_state = json.loads(state_after_events[source_id])
                occurred_ns, received_ns = authority.epoch_ns(projection["occurredAt"]), authority.epoch_ns(projection["receivedAt"])
                _require(_integer(event_ids[source_id]["occurredNs"]) == occurred_ns, "execution-source-time-mismatch")
                expected = build_projection(authority=authority, state=source_state,
                            order_key=projection["receipt"]["submissionKey"], stream_id=outbox["streamId"], epoch=int(epoch),
                            sequence=projection_sequence, previous_hash=previous_hash, occurred_ns=occurred_ns, received_ns=received_ns,
                            ttl_ns=authority.epoch_ns(projection["expiresAt"]) - received_ns,
                            audit_event_id=source_id, native_emitter_actor_id=projection["actorId"])
                _require(authority.encode(expected) == raw, "execution-projection-not-native-state")
            _require(authority.validate(contract, projection) is True, "projection-public-validation-failed")
            if kind == "native-fact":
                proof_key = (projection["proof"]["artifactId"], projection["proof"]["sha256"])
                _require(proof_key in proofs and authority.validate_native_journal_proof(projection, proofs[proof_key], "1.0.0") is True,
                         "native-proof-invalid")
                used_proofs.add(proof_key)
                source_sequence = _integer(projection["proofJournalSequence"], positive=True)
                source_event, source_hash, _ = event_rows[source_sequence]
                _require(source_event["eventId"] == projection["proof"]["sourceEventId"]
                         and source_hash == projection["proofJournalHeadHash"] and source_event["ownerEpoch"] == epoch
                         and _integer(source_event["occurredNs"]) == authority.epoch_ns(projection["occurredAt"]), "native-proof-source-mismatch")
                identity = (epoch, str(source_sequence), source_hash)
                ordinal = source_ordinals.get(identity, 0)
                _require(projection["factOrdinal"] == ordinal and ordinal < 64
                         and (ordinal == 0 or last_sources.get(epoch) == identity)
                         and source_sequence >= latest_source_sequence.get(epoch, 0)
                         and (identity in source_ordinals or source_sequence != latest_source_sequence.get(epoch)), "native-proof-source-order")
                _require(identities.pop((*identity, ordinal), None) == digest, "native-proof-identity-mismatch")
                source_ordinals[identity], latest_source_sequence[epoch], last_sources[epoch] = ordinal + 1, source_sequence, identity
        elif kind == "portfolio-snapshot":
            _require(previous_number > 0 and projection_sequence == previous_number and digest == previous_hash
                     and projection["sourceEventHash"] == previous_hash and authority.validate("PortfolioSnapshot", projection) is True,
                     "portfolio-checkpoint-chain-mismatch")
            matching = [e for e in event_ids.values() if e["kind"] == "portfolio-checkpoint" and e["ownerEpoch"] == epoch
                        and e["data"].get("snapshotId") == projection["snapshotId"]]
            _require(len(matching) == 1 and matching[0]["data"] == {"snapshotId": projection["snapshotId"], "sequence": row["sequence"],
                     "ownerEpoch": epoch, "sourceEventHash": digest}, "portfolio-checkpoint-source-mismatch")
            event = matching[0]
            source_state = json.loads(state_before_events[_integer(event["sequence"], positive=True)])
            expected = build_snapshot(authority=authority, owned_state=source_state, stream_id=outbox["streamId"],
                        owner_epoch=int(epoch), observed_at=projection["asOfAt"], received_at=projection["receivedAt"],
                        evaluated_at=projection["continuity"]["evaluatedAt"], max_age_ms=projection["continuity"]["freshness"]["maxAgeMs"],
                        snapshot_id=projection["snapshotId"], sequence=projection_sequence, source_event_hash=digest)
            _require(authority.encode(expected) == raw, "portfolio-checkpoint-not-native-state")
            snapshot_event_ids.add(matching[0]["eventId"])
        else:
            raise ExecutionError("epoch-transition-unsupported-projection-kind")
        if kind != "native-fact":
            last_sources[epoch] = None
        chains[epoch] = (projection_sequence, digest)
    _require(not identities and used_proofs == set(proofs), "unreferenced-native-proof-or-identity")
    expected_snapshot_events = {e["eventId"] for e in event_ids.values() if e["kind"] in ("portfolio-genesis", "portfolio-checkpoint")}
    _require(snapshot_event_ids == expected_snapshot_events, "omitted-historical-snapshot-projection")
    _require(chains.get(str(prior_epoch)) == (_integer(outbox["priorProjectionSequence"], positive=True), _digest(outbox["priorProjectionHash"])),
             "prior-acknowledged-head-mismatch")
    _require(source_size <= MAX_SOURCE_BYTES, "source-history-byte-bound")
    return ReplayedEpochEvidence(authority.encode(state), prior_state, *claim)


def _stat_identity(info: os.stat_result) -> dict[str, str]:
    _require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1 and info.st_uid == os.getuid(), "unsafe-owned-file")
    return {"device": str(info.st_dev), "inode": str(info.st_ino), "mode": "0600",
            "linkCount": str(info.st_nlink), "ownerUid": str(info.st_uid)}


def _owner_fence(journal: Journal, outbox: Mapping[str, Any], outbox_sha: str,
                 replay: ReplayedEpochEvidence) -> dict[str, Any]:
    _require(journal.pid == os.getpid() and journal.lock_fd is not None and not journal.poisoned,
             "current-native-owner-required")
    lock_info = os.fstat(journal.lock_fd)
    named_lock = os.stat(str(journal.path) + ".owner", follow_symlinks=False)
    _require((lock_info.st_dev, lock_info.st_ino) == (named_lock.st_dev, named_lock.st_ino), "owner-lock-path-replaced")
    journal_info = os.stat(journal.path, follow_symlinks=False)
    _require(journal.path.parent.resolve() == journal.path.parent and not journal.path.is_symlink(), "journal-path-changed")
    scope = {k: outbox[k] for k in ("journalIdentity", "accountAlias", "environment", "simulatorId", "streamId",
                                  "priorOwnerEpoch", "ownerEpoch", "journalSequence", "journalHeadSha256", "capturedAtNs")}
    return {"format": _FENCE_FORMAT, **scope, "nativeOutboxEvidenceSha256": outbox_sha,
            "claimSequence": str(replay.claim_sequence), "claimEventHash": replay.claim_event_hash,
            "claimPayloadBase64": base64.b64encode(replay.claim_payload_bytes).decode("ascii"),
            "processId": str(journal.pid), "ownerUid": str(os.getuid()), "lockFile": _stat_identity(lock_info),
            "journalFile": _stat_identity(journal_info)}


def prior_projection_anchor(journal: Journal) -> tuple[int, tuple[int, str | None]]:
    """Latest ACTUAL persisted projected epoch, never an empty claimed epoch.

    No row means a first initialization only when no prior genesis exists. Full
    bounded replay in preparation subsequently proves all intermediate claims.
    """
    with journal.mutex:
        row = journal._db().execute(
            "SELECT owner_epoch,sequence,event_hash FROM projections ORDER BY publication_sequence DESC LIMIT 1"
        ).fetchone()
        if row is None:
            _require("portfolioCheckpoint" not in journal.state, "missing-persisted-projection-history")
            return 0, (0, None)
        epoch, sequence, digest = row
        old_epoch = _integer(epoch, positive=True)
        _require(old_epoch <= journal.epoch, "projection-ahead-of-owned-epoch")
        return old_epoch, (_integer(sequence, positive=True), _digest(digest))


def prepare_epoch_transition(journal: Journal, *, journal_identity: str, stream_id: str,
                             prior_epoch: int, prior_projection: tuple[int, str | None], now_ns: int) -> PreparedEpochTransition:
    return _prepare_evidence(journal, journal_identity=journal_identity, stream_id=stream_id, prior_epoch=prior_epoch,
                             prior_projection=prior_projection, now_ns=now_ns, require_acknowledged=True)


def _prepare_evidence(journal: Journal, *, journal_identity: str, stream_id: str,
                      prior_epoch: int, prior_projection: tuple[int, str | None], now_ns: int,
                      require_acknowledged: bool) -> PreparedEpochTransition:
    """Copy and prove the actual persisted ACK high-water before new genesis.

    No caller state or ACK boolean is accepted. All original history is included;
    SQL count/byte bounds run BEFORE payload fetches. This function only SELECTs.
    """
    _identifier(journal_identity)
    _identifier(stream_id)
    _require(type(prior_epoch) is int and prior_epoch > 0 and type(now_ns) is int and now_ns >= 0
             and type(prior_projection) is tuple and len(prior_projection) == 2
             and type(prior_projection[0]) is int and prior_projection[0] > 0, "prior-restored-anchor-required")
    _digest(prior_projection[1])
    try:
        with journal.mutex:
            connection = journal._db()
            _require(not connection.in_transaction and journal.epoch > prior_epoch, "owner-epoch-or-transaction-mismatch")
            queries = (
                ("events", "SELECT sequence,event_id,previous_hash,event_hash,payload FROM events ORDER BY sequence"),
                ("checkpoints", "SELECT sequence,event_hash,state_hash,payload FROM checkpoints ORDER BY sequence"),
                ("projections", "SELECT publication_sequence,owner_epoch,sequence,event_hash,kind,acknowledged,payload FROM projections ORDER BY publication_sequence"),
                ("native_proofs", "SELECT artifact_id,sha256,payload FROM native_proofs ORDER BY artifact_id"),
            )
            total = 0
            for table, _ in queries:
                count, size, largest = connection.execute(f"SELECT COUNT(*),COALESCE(SUM(length(payload)),0),COALESCE(MAX(length(payload)),0) FROM {table}").fetchone()
                _require(count <= MAX_ROWS and largest <= MAX_ROW_BYTES, "persisted-history-row-bound")
                total += size
            identity_count = connection.execute("SELECT COUNT(*) FROM native_fact_identities").fetchone()[0]
            _require(identity_count <= MAX_ROWS and total <= MAX_SOURCE_BYTES, "persisted-history-byte-bound")
            count, size = connection.execute("SELECT COUNT(*),COALESCE(SUM(length(value)),0) FROM metadata").fetchone()
            _require(count <= 16 and size <= MAX_ROW_BYTES, "persisted-metadata-bound")
            persisted = {table: connection.execute(query).fetchall() for table, query in queries}
            metadata = [{"key": k, "value": v} for k, v in connection.execute("SELECT key,value FROM metadata ORDER BY key")]
            identities = [{"ownerEpoch": e, "journalSequence": n, "journalHeadHash": h, "factOrdinal": o, "projectionHash": p}
                          for e, n, h, o, p in connection.execute("SELECT owner_epoch,journal_sequence,journal_head_hash,fact_ordinal,projection_hash FROM native_fact_identities ORDER BY owner_epoch,journal_sequence,journal_head_hash,fact_ordinal")]
            for row in persisted["projections"]:
                _require(type(row[5]) is int and row[5] in (0, 1) and (row[5] == 1 or not require_acknowledged),
                         "persisted-outbox-ack-required")
            events = [{"sequence": str(n), "eventId": i, "previousHash": p, "eventHash": h, "payloadBase64": _encoded_row(b)}
                      for n, i, p, h, b in persisted["events"]]
            checkpoints = [{"sequence": str(n), "eventHash": h, "stateHash": s, "payloadBase64": _encoded_row(b)}
                           for n, h, s, b in persisted["checkpoints"]]
            projections = [{"publicationSequence": str(p), "ownerEpoch": e, "sequence": n, "eventHash": h, "kind": k,
                            "acknowledged": a == 1, "payloadBase64": _encoded_row(b)} for p, e, n, h, k, a, b in persisted["projections"]]
            proofs = [{"artifactId": i, "sha256": h, "payloadBase64": _encoded_row(b)} for i, h, b in persisted["native_proofs"]]
            # Compute prior state from originals first, without trusting a caller
            # snapshot; the full independent replay below checks every row again.
            state = initial_state(journal.state["accountAlias"], journal.state["simulatorId"], journal.state["currency"])
            prior = None
            for row in persisted["events"]:
                event = _canonical(journal.authority, row[4])
                if event["kind"] == "epoch-claimed" and event["data"].get("epoch") == str(prior_epoch + 1):
                    _require(prior is None, "duplicate-first-restored-claim")
                    prior = journal.authority.encode(state)
                apply_event(state, event)
            _require(prior is not None and journal.authority.encode(state) == journal.authority.encode(journal.state), "persisted-memory-state-mismatch")
            outbox = {"format": _OUTBOX_FORMAT, "journalIdentity": journal_identity, "accountAlias": state["accountAlias"],
                      "environment": "paper", "simulatorId": state["simulatorId"], "currency": state["currency"], "streamId": stream_id,
                      "priorOwnerEpoch": str(prior_epoch), "priorProjectionSequence": str(prior_projection[0]),
                      "priorProjectionHash": prior_projection[1], "ownerEpoch": str(journal.epoch), "journalSequence": str(journal.sequence),
                      "journalHeadSha256": journal.event_hash, "capturedAtNs": str(now_ns), "initialState": initial_state(state["accountAlias"], state["simulatorId"], state["currency"]),
                      "priorStateSha256": _sha(prior), "currentStateSha256": journal.authority.digest(state), "metadata": metadata,
                      "events": events, "checkpoints": checkpoints, "projections": projections, "nativeProofs": proofs, "nativeFactIdentities": identities}
            raw = journal.authority.encode(outbox)
            _require(len(raw) <= MAX_EVIDENCE_BYTES, "encoded-history-byte-bound")
            replay = _replay_evidence(journal.authority, raw, require_acknowledged=require_acknowledged)
            fence_bytes = journal.authority.encode(_owner_fence(journal, outbox, _sha(raw), replay))
            _require(len(fence_bytes) <= MAX_EVIDENCE_BYTES, "encoded-fence-byte-bound")
            return PreparedEpochTransition(raw, fence_bytes, replay.owned_state_bytes, replay.prior_state_bytes,
                    _sha(raw), _sha(fence_bytes), journal_identity, stream_id, state["accountAlias"], state["simulatorId"], prior_epoch,
                    journal.epoch, journal.sequence, prior_projection[0], now_ns, prior_projection[1], journal.event_hash, journal.authority.digest(state))
    except (KeyError, TypeError, ValueError, OSError, AttributeError) as exc:
        raise ExecutionError("epoch-transition-persisted-evidence-unavailable") from exc


def _verify_prepared(prepared: PreparedEpochTransition, authority: Any, *,
                     require_acknowledged: bool = True) -> tuple[dict[str, Any], ReplayedEpochEvidence]:
    _require(type(prepared) is PreparedEpochTransition and _sha(prepared.outbox_bytes) == prepared.outbox_sha256
             and _sha(prepared.owner_fence_bytes) == prepared.owner_fence_sha256, "prepared-evidence-digest-mismatch")
    replay = _replay_evidence(authority, prepared.outbox_bytes, require_acknowledged=require_acknowledged)
    outbox = _canonical(authority, prepared.outbox_bytes, MAX_EVIDENCE_BYTES)
    expected = {"journalIdentity": prepared.journal_identity, "streamId": prepared.stream_id, "accountAlias": prepared.account_alias,
                "simulatorId": prepared.simulator_id, "priorOwnerEpoch": str(prepared.prior_epoch), "ownerEpoch": str(prepared.current_epoch),
                "journalSequence": str(prepared.journal_sequence), "priorProjectionSequence": str(prepared.prior_projection_sequence),
                "capturedAtNs": str(prepared.captured_at_ns), "priorProjectionHash": prepared.prior_projection_hash,
                "journalHeadSha256": prepared.journal_head_sha256, "currentStateSha256": prepared.state_sha256}
    _require(all(outbox[k] == v for k, v in expected.items()) and replay.owned_state_bytes == prepared.owned_state_bytes
             and replay.prior_state_bytes == prepared.prior_state_bytes, "prepared-anchor-substitution")
    fence = _canonical(authority, prepared.owner_fence_bytes, MAX_EVIDENCE_BYTES)
    _fields(fence, "format journalIdentity accountAlias environment simulatorId streamId priorOwnerEpoch ownerEpoch journalSequence "
            "journalHeadSha256 nativeOutboxEvidenceSha256 claimSequence claimEventHash claimPayloadBase64 capturedAtNs processId ownerUid lockFile journalFile")
    _require(fence["format"] == _FENCE_FORMAT and fence["environment"] == "paper"
             and all(fence[k] == outbox[k] for k in ("journalIdentity", "accountAlias", "simulatorId", "streamId", "priorOwnerEpoch",
                     "ownerEpoch", "journalSequence", "journalHeadSha256", "capturedAtNs"))
             and fence["nativeOutboxEvidenceSha256"] == prepared.outbox_sha256
             and _integer(fence["claimSequence"], positive=True) == replay.claim_sequence
             and fence["claimEventHash"] == replay.claim_event_hash and _bytes(fence["claimPayloadBase64"]) == replay.claim_payload_bytes,
             "owner-fence-source-mismatch")
    _integer(fence["processId"], positive=True)
    _integer(fence["ownerUid"])
    for name in ("lockFile", "journalFile"):
        item = _fields(fence[name], "device inode mode linkCount ownerUid")
        _require(item["mode"] == "0600" and item["linkCount"] == "1" and item["ownerUid"] == fence["ownerUid"], "owner-fence-file-scope")
        _integer(item["device"])
        _integer(item["inode"], positive=True)
    return outbox, replay


def candidate_genesis(prepared: PreparedEpochTransition, *, authority: Any, snapshot_id: str,
                      max_age_ms: int, now_ns: int) -> dict[str, Any]:
    _verify_prepared(prepared, authority)
    _require(type(now_ns) is int and now_ns >= prepared.captured_at_ns, "candidate-time-before-evidence")
    state = json.loads(prepared.owned_state_bytes)
    observation = state["observation"]
    _require(type(observation) is dict, "restored-current-observation-required")
    return build_genesis(authority=authority, owned_state=state, stream_id=prepared.stream_id, owner_epoch=prepared.current_epoch,
                         observed_at=timestamp(_integer(observation["observedNs"])), received_at=timestamp(_integer(observation["receivedNs"])),
                         evaluated_at=timestamp(now_ns), max_age_ms=max_age_ms, snapshot_id=_identifier(snapshot_id))


def transition_subject(prepared: PreparedEpochTransition, *, authority: Any, snapshot: Mapping[str, Any]) -> NativeEpochTransition:
    _verify_prepared(prepared, authority)
    _require(authority.validate("PortfolioGenesis", snapshot) is True, "candidate-genesis-invalid")
    candidate = candidate_genesis(prepared, authority=authority, snapshot_id=snapshot["snapshotId"],
                                 max_age_ms=snapshot["continuity"]["freshness"]["maxAgeMs"], now_ns=authority.epoch_ns(snapshot["continuity"]["evaluatedAt"]))
    _require(authority.encode(candidate) == authority.encode(snapshot), "candidate-not-restored-native-state")
    return NativeEpochTransition(account_alias=prepared.account_alias, environment="paper", simulator_id=prepared.simulator_id,
             stream_id=prepared.stream_id, journal_identity=prepared.journal_identity, prior_owner_epoch=prepared.prior_epoch,
             current_owner_epoch=prepared.current_epoch, prior_projection_sequence=prepared.prior_projection_sequence,
             prior_projection_hash=prepared.prior_projection_hash, journal_sequence=prepared.journal_sequence,
             journal_head_sha256=prepared.journal_head_sha256, new_snapshot_sha256=authority.digest(snapshot),
             native_outbox_evidence_sha256=prepared.outbox_sha256, native_owner_fence_sha256=prepared.owner_fence_sha256)


def assert_current_epoch_anchor(journal: Journal, prepared: PreparedEpochTransition) -> None:
    """Re-export at the ORIGINAL capture time; any row/ACK/fence change rejects."""
    current = prepare_epoch_transition(journal, journal_identity=prepared.journal_identity, stream_id=prepared.stream_id,
              prior_epoch=prepared.prior_epoch, prior_projection=(prepared.prior_projection_sequence, prepared.prior_projection_hash),
              now_ns=prepared.captured_at_ns)
    _require(current == prepared, "prepared-journal-or-fence-changed")


def build_epoch_transition(prepared: PreparedEpochTransition, *, journal: Journal, snapshot: Mapping[str, Any],
                           transition_id: str, approval_id: str, approval_authority: Any, now_ns: int) -> dict[str, Any]:
    """Consume one independently signed approval; never mint, append or publish.

    Caller MUST keep its actor/mutex ownership through durable wrapper+proof
    persistence and exact owner.record_genesis. A post-consumption failure burns
    the approval; only the exact durable wrapper can be retried for publication.
    """
    with journal.mutex:
        assert_current_epoch_anchor(journal, prepared)
        subject = transition_subject(prepared, authority=journal.authority, snapshot=snapshot)
        _require(type(now_ns) is int and now_ns >= journal.authority.epoch_ns(snapshot["continuity"]["evaluatedAt"]), "approval-time-before-candidate")
        state = json.loads(prepared.owned_state_bytes)
        observed = _integer(state["observation"]["observedNs"])
        _require(now_ns < _integer(state["observation"]["validUntilNs"])
                 and now_ns - observed <= snapshot["continuity"]["freshness"]["maxAgeMs"] * 1_000_000, "candidate-observation-expired")
        raw_approval = approval_authority.installed_approval_bytes(_identifier(approval_id))
        approval = _canonical(journal.authority, raw_approval, MAX_EVIDENCE_BYTES)
        payload = approval["payload"]
        _require(payload["approvalId"] == approval_id and payload["action"] == "owner-epoch-transition"
                 and payload["ownerEpoch"] == str(prepared.current_epoch)
                 and payload["subject"] == approval_subject(subject, authority=journal.authority), "signed-approval-subject-mismatch")
        wrapper = {"schemaVersion": "1.0.0", "transitionId": _identifier(transition_id), "snapshot": json.loads(journal.authority.encode(snapshot)),
                   "priorOwnerEpoch": str(prepared.prior_epoch), "priorProjectionSequence": str(prepared.prior_projection_sequence),
                   "priorProjectionHash": prepared.prior_projection_hash, "journalIdentity": prepared.journal_identity,
                   "journalSequence": str(prepared.journal_sequence), "journalHeadSha256": prepared.journal_head_sha256,
                   "nativeOutboxEvidenceSha256": prepared.outbox_sha256, "nativeOwnerFenceSha256": prepared.owner_fence_sha256,
                   "approvalBase64": base64.b64encode(raw_approval).decode("ascii")}
        _require(journal.authority.validate("PortfolioEpochTransition", wrapper) is True, "wrapper-native-validation-unavailable")
        assert_current_epoch_anchor(journal, prepared)
        _require(approval_authority.verify(subject, now_ns=now_ns) is True, "independent-native-approval-required")
        return wrapper
