"""Authored only: pure journal-row doubles, no filesystem/SQLite/native loading.

NonConformanceAuthority is explicitly not a public schema implementation. The
final native schema/signature/replay integration gate remains deferred.
"""
import base64
from copy import deepcopy
from dataclasses import replace
from datetime import date
import hashlib
import json
from threading import RLock
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from vertex_execution.exact import timestamp
from vertex_execution.journal import apply_event, initial_state
from vertex_execution.portfolio_projection import build_genesis
from vertex_execution.ports import ExecutionError
from vertex_host.epoch_transition import (
    MAX_ROWS, PreparedEpochTransition, assert_current_epoch_anchor, build_epoch_transition,
    candidate_genesis, prepare_epoch_transition, replay_epoch_evidence, transition_subject,
)
from vertex_host.native_approval import approval_subject


class NonConformanceAuthority:
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def validate(self, name, value, schema_version="1.0.0"):
        return True

    def epoch_ns(self, value):
        day, clock = value.removesuffix("Z").split("T")
        hour, minute, second = clock.split(":")
        second, _, nanos = second.partition(".")
        days = (date.fromisoformat(day) - date(1970, 1, 1)).days
        return (days * 86400 + int(hour) * 3600 + int(minute) * 60 + int(second)) * 10**9 + int(nanos.ljust(9, "0"))

    def validate_native_journal_proof(self, *args):
        return False


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)

    def __iter__(self):
        return iter(self.rows)


class ReadOnlyRows:
    """Query routing only; never opens/executes SQLite or any other database."""
    in_transaction = False

    def __init__(self, fixture):
        self.fixture, self.queries = fixture, []
        self.oversize = None

    def execute(self, query, parameters=()):
        if not query.startswith("SELECT "):
            raise AssertionError("exporter attempted non-read operation")
        self.queries.append(query)
        f = self.fixture
        if query.startswith("SELECT COUNT(*),COALESCE(SUM(length(payload))"):
            table = query.rsplit(" ", 1)[1]
            rows = f.tables[table]
            size = sum(len(row[-1]) for row in rows)
            count = MAX_ROWS + 1 if self.oversize == table else len(rows)
            return Cursor([(count, size, max((len(row[-1]) for row in rows), default=0))])
        if query == "SELECT COUNT(*) FROM native_fact_identities":
            return Cursor([(len(f.identities),)])
        if query.startswith("SELECT COUNT(*),COALESCE(SUM(length(value))"):
            return Cursor([(len(f.metadata), sum(len(v) for _, v in f.metadata))])
        if query == "SELECT key,value FROM metadata ORDER BY key":
            return Cursor(f.metadata)
        if " FROM native_fact_identities ORDER BY " in query:
            return Cursor(f.identities)
        table = query.split(" FROM ")[1].split(" ")[0]
        return Cursor(f.tables[table])


class EpochFixture:
    def __init__(self):
        self.authority = NonConformanceAuthority()
        self.now = 2_000_000_000
        self.initial = initial_state("paper-fixture", "sim-fixture", "USD")
        self.state = deepcopy(self.initial)
        self.tables = {"events": [], "checkpoints": [], "projections": [], "native_proofs": []}
        self.identities = []
        self.event("epoch-claimed", {"epoch": "1"}, "epoch-1", 100)
        self.event("observation", self.observation("observation-1", 1, 200), "observation-1", 200)
        self.event("reconciled", {}, "reconciled-1", 300)
        self.old_genesis = build_genesis(authority=self.authority, owned_state=deepcopy(self.state), stream_id="same-stream",
                                        owner_epoch=1, observed_at=timestamp(200), received_at=timestamp(200),
                                        evaluated_at=timestamp(400), max_age_ms=60000, snapshot_id="genesis-old")
        genesis_data = {"snapshotId": "genesis-old", "sequence": "1", "ownerEpoch": "1", "sourceEventHash": self.old_genesis["sourceEventHash"]}
        self.event("portfolio-genesis", genesis_data, "genesis-1", 400)
        self.tables["projections"].append((1, "1", "1", self.old_genesis["sourceEventHash"], "portfolio-genesis", 1,
                                            self.authority.encode(self.old_genesis)))
        self.event("epoch-claimed", {"epoch": "2"}, "epoch-2", 500)
        self.event("observation", self.observation("observation-2", 2, 600), "observation-2", 600)
        self.event("reconciled", {}, "reconciled-2", 700)
        self.metadata = [("epoch", "2"), ("scope", self.authority.encode(self.initial).decode())]
        self.connection = ReadOnlyRows(self)
        self.journal = SimpleNamespace(authority=self.authority, mutex=RLock(), epoch=2, sequence=7,
                                       event_hash=self.tables["events"][-1][3], state=deepcopy(self.state), _db=lambda: self.connection)

    def observation(self, identity, sequence, clock):
        return {"observationId": identity, "sourceSequence": str(sequence), "observedNs": str(clock), "receivedNs": str(clock),
                "validUntilNs": "90000000000", "cash": "100", "positions": {}, "seedPolicyArtifactId": "native-seed-policy",
                "seedPolicySha256": "a" * 64, "evidenceSha256": "b" * 64}

    def event(self, kind, data, event_id, clock):
        sequence = len(self.tables["events"]) + 1
        previous = self.tables["events"][-1][3] if self.tables["events"] else "0" * 64
        event = {"sequence": str(sequence), "previousHash": previous, "ownerEpoch": self.state["ownerEpoch"],
                 "eventId": event_id, "occurredNs": str(clock), "kind": kind, "data": data}
        raw = self.authority.encode(event)
        digest = hashlib.sha256(raw).hexdigest()
        apply_event(self.state, event)
        self.tables["events"].append((sequence, event_id, previous, digest, raw))
        state_raw = self.authority.encode(self.state)
        self.tables["checkpoints"].append((sequence, digest, hashlib.sha256(state_raw).hexdigest(), state_raw))

    def fence(self, journal, outbox, digest, replay):
        identity = {"device": "1", "inode": "2", "mode": "0600", "linkCount": "1", "ownerUid": "1000"}
        return {"format": "vertex-native-owner-fence-v1",
                **{k: outbox[k] for k in ("journalIdentity", "accountAlias", "environment", "simulatorId", "streamId", "priorOwnerEpoch",
                                        "ownerEpoch", "journalSequence", "journalHeadSha256", "capturedAtNs")},
                "nativeOutboxEvidenceSha256": digest, "claimSequence": str(replay.claim_sequence), "claimEventHash": replay.claim_event_hash,
                "claimPayloadBase64": base64.b64encode(replay.claim_payload_bytes).decode(), "processId": "42", "ownerUid": "1000",
                "lockFile": identity, "journalFile": {**identity, "inode": "3"}}

    def prepare(self, **changes):
        values = {"journal_identity": "local-journal", "stream_id": "same-stream", "prior_epoch": 1,
                  "prior_projection": (1, self.old_genesis["sourceEventHash"]), "now_ns": self.now}
        values.update(changes)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.fence):
            return prepare_epoch_transition(self.journal, **values)

    def candidate(self, prepared):
        return candidate_genesis(prepared, authority=self.authority, snapshot_id="genesis-new", max_age_ms=60000, now_ns=self.now)


class IndependentApprovalDouble:
    """Explicit test admission port, NOT a cryptographic verifier or signer."""
    def __init__(self, authority, subject):
        self.authority, self.subject, self.consumed = authority, subject, False
        self.calls = []
        self.raw = authority.encode({"keyId": "independent-fixture", "signatureHex": "f" * 128,
                                     "payload": {"approvalId": "approval-fixture", "action": "owner-epoch-transition", "ownerEpoch": "2",
                                                 "subject": approval_subject(subject, authority=authority)}})

    def installed_approval_bytes(self, approval_id):
        self.calls.append(("read", approval_id))
        return self.raw

    def verify(self, subject, *, now_ns):
        self.calls.append(("verify", subject))
        if self.consumed or subject != self.subject:
            return False
        self.consumed = True
        return True


class EpochTransitionTests(unittest.TestCase):
    def setUp(self):
        self.f = EpochFixture()

    def test_complete_original_source_history_and_actual_persisted_ack(self):
        prepared = self.f.prepare()
        proof = json.loads(prepared.outbox_bytes)
        self.assertEqual(len(proof["events"]), 7)
        self.assertEqual(len(proof["checkpoints"]), 7)
        self.assertTrue(proof["projections"][0]["acknowledged"])
        self.assertEqual(base64.b64decode(proof["events"][4]["payloadBase64"]), self.f.tables["events"][4][4])
        self.assertEqual(prepared.prior_epoch, 1)
        self.assertEqual(prepared.current_epoch, 2)
        self.assertEqual(prepared.journal_sequence, 7)
        self.assertEqual(prepared.outbox_artifact_id, "native-outbox-evidence-" + hashlib.sha256(prepared.outbox_bytes).hexdigest())
        self.assertEqual(prepared.owner_fence_artifact_id, "native-owner-fence-" + hashlib.sha256(prepared.owner_fence_bytes).hexdigest())
        self.assertEqual(json.loads(prepared.owned_state_bytes)["cash"], "100")
        self.assertTrue(all(query.startswith("SELECT ") for query in self.f.connection.queries))

    def test_unacknowledged_persisted_row_cannot_be_overridden_by_caller_head(self):
        row = list(self.f.tables["projections"][0])
        row[5] = 0
        self.f.tables["projections"][0] = tuple(row)
        with self.assertRaisesRegex(ExecutionError, "persisted-outbox-ack-required"):
            self.f.prepare()

    def test_missing_projection_and_wrong_prior_head_are_not_current_evidence(self):
        with self.assertRaisesRegex(ExecutionError, "prior-acknowledged-head-mismatch"):
            self.f.prepare(prior_projection=(1, "f" * 64))
        self.f.tables["projections"].clear()
        with self.assertRaisesRegex(ExecutionError, "omitted-historical-snapshot-projection"):
            self.f.prepare()

    def test_row_capacity_is_checked_before_large_payloads_are_fetched(self):
        self.f.connection.oversize = "events"
        with self.assertRaisesRegex(ExecutionError, "persisted-history-row-bound"):
            self.f.prepare()
        self.assertFalse(any("payload FROM events ORDER BY" in query for query in self.f.connection.queries))

    def test_same_stream_and_exact_current_native_balance_required(self):
        with self.assertRaisesRegex(ExecutionError, "projection-scope-mismatch"):
            self.f.prepare(stream_id="different-stream")
        self.f.journal.state["cash"] = "1000000"
        with self.assertRaisesRegex(ExecutionError, "persisted-memory-state-mismatch"):
            self.f.prepare()

    def test_event_original_byte_tamper_is_detected(self):
        prepared = self.f.prepare()
        proof = json.loads(prepared.outbox_bytes)
        row = proof["events"][1]
        event = json.loads(base64.b64decode(row["payloadBase64"]))
        event["data"]["cash"] = "9999"
        row["payloadBase64"] = base64.b64encode(self.f.authority.encode(event)).decode()
        with self.assertRaisesRegex(ExecutionError, "journal-chain-corruption"):
            replay_epoch_evidence(self.f.authority, self.f.authority.encode(proof))

    def test_checkpoint_payload_and_metadata_epoch_are_bound(self):
        prepared = self.f.prepare()
        for field in ("checkpoint", "epoch"):
            proof = json.loads(prepared.outbox_bytes)
            if field == "checkpoint":
                proof["checkpoints"][0]["stateHash"] = "f" * 64
            else:
                proof["metadata"][0]["value"] = "3"
            with self.subTest(field=field), self.assertRaises(ExecutionError):
                replay_epoch_evidence(self.f.authority, self.f.authority.encode(proof))

    def test_sparse_checkpoints_keep_complete_event_chain(self):
        self.f.tables["checkpoints"] = self.f.tables["checkpoints"][::3]
        prepared = self.f.prepare()
        self.assertEqual(json.loads(prepared.owned_state_bytes), self.f.journal.state)
        proof = json.loads(prepared.outbox_bytes)
        del proof["events"][1]
        with self.assertRaisesRegex(ExecutionError, "journal-chain-corruption"):
            replay_epoch_evidence(self.f.authority, self.f.authority.encode(proof))

    def test_candidate_is_new_epoch_observation_not_seed_or_rearm(self):
        prepared = self.f.prepare()
        snapshot = self.f.candidate(prepared)
        self.assertEqual(snapshot["cash"], "100")
        self.assertEqual(snapshot["ownerEpoch"], "2")
        self.assertEqual(snapshot["streamId"], "same-stream")
        self.assertTrue(snapshot["continuity"]["newRiskInhibited"])
        self.assertFalse(snapshot["executionAuthorized"])
        self.assertEqual(self.f.journal.sequence, 7)
        subject = transition_subject(prepared, authority=self.f.authority, snapshot=snapshot)
        self.assertEqual(subject.new_snapshot_sha256, self.f.authority.digest(snapshot))
        snapshot["cash"] = "999"
        with self.assertRaisesRegex(ExecutionError, "candidate-not-restored-native-state"):
            transition_subject(prepared, authority=self.f.authority, snapshot=snapshot)

    def test_forged_prepared_dataclass_cannot_swap_anchor_or_owner_fence(self):
        prepared = self.f.prepare()
        for modified in (replace(prepared, current_epoch=3), replace(prepared, outbox_sha256="f" * 64),
                         replace(prepared, owner_fence_bytes=b"{}"), replace(prepared, owned_state_bytes=b"{}")):
            with self.assertRaises(ExecutionError):
                self.f.candidate(modified)

    def test_exact_approval_bytes_subject_and_once_only_consumption(self):
        prepared = self.f.prepare()
        candidate = self.f.candidate(prepared)
        subject = transition_subject(prepared, authority=self.f.authority, snapshot=candidate)
        approval = IndependentApprovalDouble(self.f.authority, subject)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            wrapper = build_epoch_transition(prepared, journal=self.f.journal, snapshot=candidate,
                      transition_id="transition-fixture", approval_id="approval-fixture", approval_authority=approval, now_ns=self.f.now)
            with self.assertRaisesRegex(ExecutionError, "independent-native-approval-required"):
                build_epoch_transition(prepared, journal=self.f.journal, snapshot=candidate,
                      transition_id="transition-fixture", approval_id="approval-fixture", approval_authority=approval, now_ns=self.f.now)
        self.assertEqual(base64.b64decode(wrapper["approvalBase64"]), approval.raw)
        self.assertEqual(wrapper["snapshot"], candidate)
        self.assertEqual(wrapper["nativeOutboxEvidenceSha256"], prepared.outbox_sha256)
        self.assertEqual(self.f.journal.sequence, 7)

    def test_changed_head_or_metadata_prevents_consuming_approval(self):
        prepared = self.f.prepare()
        candidate = self.f.candidate(prepared)
        approval = IndependentApprovalDouble(self.f.authority, transition_subject(prepared, authority=self.f.authority, snapshot=candidate))
        self.f.metadata.insert(1, ("local_pause", "new-pause"))
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            with self.assertRaisesRegex(ExecutionError, "prepared-journal-or-fence-changed"):
                build_epoch_transition(prepared, journal=self.f.journal, snapshot=candidate, transition_id="transition-fixture",
                                       approval_id="approval-fixture", approval_authority=approval, now_ns=self.f.now)
        self.assertFalse(approval.consumed)

    def test_signed_subject_mismatch_is_not_consumed(self):
        prepared = self.f.prepare()
        candidate = self.f.candidate(prepared)
        subject = transition_subject(prepared, authority=self.f.authority, snapshot=candidate)
        approval = IndependentApprovalDouble(self.f.authority, replace(subject, prior_projection_hash="e" * 64))
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            with self.assertRaisesRegex(ExecutionError, "signed-approval-subject-mismatch"):
                build_epoch_transition(prepared, journal=self.f.journal, snapshot=candidate, transition_id="transition-fixture",
                                       approval_id="approval-fixture", approval_authority=approval, now_ns=self.f.now)
        self.assertFalse(approval.consumed)

    def test_candidate_expiry_and_changed_current_epoch_fail_closed(self):
        prepared = self.f.prepare()
        candidate = self.f.candidate(prepared)
        approval = IndependentApprovalDouble(self.f.authority, transition_subject(prepared, authority=self.f.authority, snapshot=candidate))
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            with self.assertRaisesRegex(ExecutionError, "candidate-observation-expired"):
                build_epoch_transition(prepared, journal=self.f.journal, snapshot=candidate, transition_id="transition-fixture",
                                       approval_id="approval-fixture", approval_authority=approval, now_ns=90_000_000_000)
            self.f.journal.epoch = 3
            with self.assertRaises(ExecutionError):
                assert_current_epoch_anchor(self.f.journal, prepared)

    def test_noncanonical_and_duplicate_evidence_never_decode(self):
        prepared = self.f.prepare()
        for raw in (b" " + prepared.outbox_bytes, prepared.outbox_bytes[:-1] + b',"format":"vertex-native-outbox-evidence-v1"}'):
            with self.assertRaises(ExecutionError):
                replay_epoch_evidence(self.f.authority, raw)
