"""Source-only replay regressions, not executed. All persistence is row doubles.

No database, filesystem, cryptography loader, service or broker is contacted.
The authority/approval doubles exercise host binding, not native conformance.
"""
import base64
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
import unittest
from unittest.mock import patch

from vertex_execution.exact import timestamp
from vertex_execution.portfolio_projection import build_genesis, build_snapshot
from vertex_execution.ports import ExecutionError
from vertex_host.epoch_transition import (
    build_epoch_transition, candidate_genesis, prepare_epoch_transition, prior_projection_anchor, transition_subject,
)
from vertex_host.native_approval import NativeOutboxReplay, approval_subject
from vertex_host.replay import (
    apply_outbox_replay_ack, assert_current_replay_anchor, build_outbox_replay, prepare_outbox_replay,
    replay_receipt, restore_replay_receipt,
)

from test_epoch_transition import Cursor, EpochFixture, IndependentApprovalDouble, ReadOnlyRows


class ReplayRows(ReadOnlyRows):
    def execute(self, query, parameters=()):
        if query.startswith("SELECT sequence,event_hash FROM projections WHERE owner_epoch="):
            self.queries.append(query)
            rows = [r for r in self.fixture.tables["projections"] if r[1] == parameters[0]]
            return Cursor([(rows[-1][2], rows[-1][3])] if rows else [])
        if query == "SELECT owner_epoch,sequence,event_hash FROM projections ORDER BY publication_sequence DESC LIMIT 1":
            self.queries.append(query)
            rows = self.fixture.tables["projections"]
            return Cursor([(rows[-1][1], rows[-1][2], rows[-1][3])] if rows else [])
        if query == "SELECT event_hash,acknowledged FROM projections WHERE publication_sequence=?":
            self.queries.append(query)
            rows = [r for r in self.fixture.tables["projections"] if r[0] == parameters[0]]
            return Cursor([(rows[0][3], rows[0][5])] if rows else [])
        return super().execute(query, parameters)


class ReplayFixture(EpochFixture):
    def __init__(self, *, snapshot=False):
        super().__init__()
        if snapshot:
            self.tables["events"] = self.tables["events"][:4]
            self.tables["checkpoints"] = self.tables["checkpoints"][:4]
            self.state = json.loads(self.tables["checkpoints"][-1][3])
            checkpoint = build_snapshot(authority=self.authority, owned_state=deepcopy(self.state), stream_id="same-stream",
                         owner_epoch=1, observed_at=timestamp(200), received_at=timestamp(200), evaluated_at=timestamp(450), max_age_ms=60000,
                         snapshot_id="old-checkpoint", sequence=1, source_event_hash=self.old_genesis["sourceEventHash"])
            self.event("portfolio-checkpoint", {"snapshotId": "old-checkpoint", "sequence": "1", "ownerEpoch": "1",
                                               "sourceEventHash": self.old_genesis["sourceEventHash"]}, "old-checkpoint", 450)
            self.tables["projections"].append((2, "1", "1", self.old_genesis["sourceEventHash"], "portfolio-snapshot", 0,
                                               self.authority.encode(checkpoint)))
            self.event("epoch-claimed", {"epoch": "2"}, "epoch-2", 500)
            self.event("observation", self.observation("observation-2", 2, 600), "observation-2", 600)
            self.event("reconciled", {}, "reconciled-2", 700)
        first = list(self.tables["projections"][0])
        first[5] = 0
        self.tables["projections"][0] = tuple(first)
        self.connection = ReplayRows(self)
        self.journal._db = lambda: self.connection
        self.journal.sequence = len(self.tables["events"])
        self.journal.event_hash = self.tables["events"][-1][3]
        self.journal.state = deepcopy(self.state)
        self.journal.acknowledge_projection = self.acknowledge
        self.acked = []
        self.fail_after_ack = None

    def acknowledge(self, publication, digest):
        pending = next(r for r in self.tables["projections"] if r[5] == 0)
        if pending[0] != publication or pending[3] != digest:
            raise AssertionError("nonprefix ACK attempted")
        row = list(pending)
        row[5] = 1
        self.tables["projections"][publication - 1] = tuple(row)
        self.acked.append(publication)
        if self.fail_after_ack == len(self.acked):
            raise ExecutionError("fixture-local-ack-crash")

    def prepare_replay(self, **changes):
        values = {"journal_identity": "local-journal", "stream_id": "same-stream", "prior_epoch": 1, "cloud_head": (0, None),
                  "service_actor_id": "native-emitter", "grant_id": "replay-approval", "now_ns": self.now,
                  "expires_ns": self.now + 60_000_000_000}
        values.update(changes)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.fence):
            return prepare_outbox_replay(self.journal, **values)

    def ack(self, prepared, status="applied"):
        final = json.loads(prepared.grant_binding_bytes)["rows"][-1]
        return {"status": status, "highWaterSequence": final["sequence"], "highWaterEventHash": final["eventHash"]}


class RolloverReplayFixture(ReplayFixture):
    """Original signed 1->2 handoff, genesis2 appended, crash before cloud ACK."""
    def __init__(self):
        super().__init__()
        first = list(self.tables["projections"][0])
        first[5] = 1
        self.tables["projections"][0] = tuple(first)
        self.now = 800
        transition = self.prepare()
        snapshot = self.candidate(transition)
        subject = transition_subject(transition, authority=self.authority, snapshot=snapshot)
        old_approval = IndependentApprovalDouble(self.authority, subject)
        # Deliberately expired by the eventual replay time. The host retains the
        # original bytes; only the server's historical proof/current revocation
        # checks plus fresh current replay signature can authorize publication.
        envelope = json.loads(old_approval.raw)
        envelope["payload"].update({"issuedNs": "800", "expiresNs": "850"})
        old_approval.raw = self.authority.encode(envelope)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.fence):
            self.retained_wrapper = build_epoch_transition(transition, journal=self.journal, snapshot=snapshot,
                transition_id="original-transition", approval_id="approval-fixture", approval_authority=old_approval, now_ns=self.now)
        self.retained_original = self.authority.encode(self.retained_wrapper)
        self.historical_outbox = transition.outbox_bytes
        self.historical_fence = transition.owner_fence_bytes
        self.old_signature = old_approval.raw
        self.event("portfolio-genesis", {"snapshotId": snapshot["snapshotId"], "sequence": "1", "ownerEpoch": "2",
                   "sourceEventHash": snapshot["sourceEventHash"]}, "genesis-2", 800)
        self.tables["projections"].append((2, "2", "1", snapshot["sourceEventHash"], "portfolio-genesis", 0,
                                            self.authority.encode(snapshot)))
        self.event("epoch-claimed", {"epoch": "3"}, "epoch-3", 900)
        self.event("observation", self.observation("observation-3", 3, 1000), "observation-3", 1000)
        self.event("reconciled", {}, "reconciled-3", 1100)
        self.metadata[0] = ("epoch", "3")
        self.journal.epoch, self.journal.sequence = 3, len(self.tables["events"])
        self.journal.event_hash, self.journal.state = self.tables["events"][-1][3], deepcopy(self.state)
        self.now = 2_000_000_000
        self.lookup_calls = []

    def lookup(self, snapshot):
        self.lookup_calls.append(self.authority.encode(snapshot))
        if self.authority.encode(snapshot) != self.authority.encode(self.retained_wrapper["snapshot"]):
            raise ExecutionError("fixture-retained-original-snapshot-mismatch")
        return deepcopy(self.retained_wrapper)

    def prepare_replay(self, **changes):
        values = {"prior_epoch": 2, "epoch_transition_lookup": self.lookup}
        values.update(changes)
        return super().prepare_replay(**values)


class ReplayApprovalDouble:
    def __init__(self, authority, prepared):
        self.authority = authority
        self.subject = NativeOutboxReplay(prepared.grant_binding_bytes)
        grant = json.loads(prepared.grant_binding_bytes)
        self.calls = 0
        self.current = True
        self.raw = authority.encode({"keyId": "independent-fixture", "signatureHex": "f" * 128,
                    "payload": {"approvalId": grant["grantId"], "action": "native-outbox-replay", "ownerEpoch": grant["currentOwnerEpoch"],
                                "issuedNs": str(authority.epoch_ns(grant["issuedAt"])), "expiresNs": str(authority.epoch_ns(grant["expiresAt"])),
                                "subject": approval_subject(self.subject, authority=authority)}})

    def installed_approval_bytes(self, identifier):
        return self.raw

    def verify(self, subject, *, now_ns):
        self.calls += 1
        return self.current and subject == self.subject


class OutboxReplayTests(unittest.TestCase):
    def setUp(self):
        self.f = ReplayFixture()

    def test_pending_original_genesis_exported_without_new_capital_or_event(self):
        prepared = self.f.prepare_replay()
        grant = json.loads(prepared.grant_binding_bytes)
        rows = json.loads(prepared.rows_bytes)["rows"]
        self.assertEqual(grant["startingSequence"], "0")
        self.assertIsNone(grant["startingEventHash"])
        self.assertEqual(grant["priorOwnerEpoch"], "1")
        self.assertEqual(grant["currentOwnerEpoch"], "2")
        self.assertEqual(rows[0]["kind"], "portfolio-genesis")
        self.assertEqual(base64.b64decode(rows[0]["projectionBase64"]), self.f.tables["projections"][0][-1])
        self.assertIsNone(rows[0]["proofBase64"])
        self.assertIsNone(prepared.retained_epoch_transition_bytes)
        self.assertIsNone(grant["retainedEpochTransitionSha256"])
        self.assertEqual(prepared.publication_sequences, (1,))
        self.assertEqual(self.f.journal.sequence, 7)
        self.assertEqual(self.f.journal.state["cash"], "100")
        self.assertEqual(self.f.acked, [])
        with self.assertRaisesRegex(ExecutionError, "persisted-outbox-ack-required"):
            self.f.prepare()

    def test_full_atomic_ack_releases_original_local_rows_in_order(self):
        f = ReplayFixture(snapshot=True)
        prepared = f.prepare_replay()
        approval = ReplayApprovalDouble(f.authority, prepared)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=f.fence):
            batch = build_outbox_replay(prepared, journal=f.journal, approval_authority=approval, now_ns=f.now)
            self.assertEqual([r["kind"] for r in batch["rows"]], ["portfolio-genesis", "portfolio-snapshot"])
            self.assertIsNone(batch["retainedEpochTransitionBase64"])
            count = apply_outbox_replay_ack(f.journal, prepared, ack=f.ack(prepared))
        self.assertEqual(count, 2)
        self.assertEqual(f.acked, [1, 2])
        self.assertEqual(base64.b64decode(batch["grant"]["approvalBase64"]), approval.raw)
        self.assertEqual(json.loads(f.prepare().owned_state_bytes)["cash"], "100")

    def test_partial_local_ack_crash_reuses_exact_original_signed_batch(self):
        f = ReplayFixture(snapshot=True)
        prepared = f.prepare_replay()
        approval = ReplayApprovalDouble(f.authority, prepared)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=f.fence):
            original = build_outbox_replay(prepared, journal=f.journal, approval_authority=approval, now_ns=f.now)
            f.fail_after_ack = 1
            with self.assertRaisesRegex(ExecutionError, "fixture-local-ack-crash"):
                apply_outbox_replay_ack(f.journal, prepared, ack=f.ack(prepared))
            f.fail_after_ack = None
            repeated = build_outbox_replay(prepared, journal=f.journal, approval_authority=approval, now_ns=f.now)
            self.assertEqual(repeated, original)
            self.assertEqual(apply_outbox_replay_ack(f.journal, prepared, ack=f.ack(prepared, "duplicate")), 1)
            self.assertEqual(apply_outbox_replay_ack(f.journal, prepared, ack=f.ack(prepared, "duplicate")), 0)
        self.assertEqual(f.acked, [1, 2])
        self.assertEqual(approval.calls, 2)

    def test_gap_stale_epoch_mismatch_and_wrong_terminal_ack_never_release(self):
        prepared = self.f.prepare_replay()
        for status in ("gap", "stale", "epoch-mismatch"):
            with self.assertRaisesRegex(ExecutionError, "server-whole-batch-ack-required"):
                apply_outbox_replay_ack(self.f.journal, prepared, ack=self.f.ack(prepared, status))
        wrong = self.f.ack(prepared)
        wrong["highWaterEventHash"] = "c" * 64
        with self.assertRaisesRegex(ExecutionError, "server-exact-terminal-ack-required"):
            apply_outbox_replay_ack(self.f.journal, prepared, ack=wrong)
        self.assertEqual(self.f.acked, [])

    def test_wrong_cloud_hash_cannot_select_or_ack_unproven_rows(self):
        with self.assertRaisesRegex(ExecutionError, "cloud-head-outside-retained-batch"):
            self.f.prepare_replay(cloud_head=(1, "c" * 64))
        prepared = self.f.prepare_replay(cloud_head=(1, self.f.old_genesis["sourceEventHash"]))
        self.assertEqual(json.loads(prepared.grant_binding_bytes)["startingSequence"], "0")
        self.assertEqual(prepared.publication_sequences, (1,))
        self.assertEqual(self.f.acked, [])

    def test_receipt_preserves_all_original_bytes_and_requires_immutable_hashes(self):
        prepared = self.f.prepare_replay()
        raw = replay_receipt(prepared, authority=self.f.authority)
        self.assertEqual(restore_replay_receipt(raw, authority=self.f.authority), prepared)
        receipt = json.loads(raw)
        receipt["evidence"]["journal_head_sha256"] = "c" * 64
        with self.assertRaises(ExecutionError):
            restore_replay_receipt(self.f.authority.encode(receipt), authority=self.f.authority)
        with self.assertRaises(ExecutionError):
            restore_replay_receipt(b" " + raw, authority=self.f.authority)

    def test_revoked_or_expired_exact_retry_remains_unavailable(self):
        prepared = self.f.prepare_replay()
        approval = ReplayApprovalDouble(self.f.authority, prepared)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            build_outbox_replay(prepared, journal=self.f.journal, approval_authority=approval, now_ns=self.f.now)
            approval.current = False
            with self.assertRaisesRegex(ExecutionError, "independent-native-approval-required"):
                build_outbox_replay(prepared, journal=self.f.journal, approval_authority=approval, now_ns=self.f.now)
            with self.assertRaisesRegex(ExecutionError, "grant-expired"):
                build_outbox_replay(prepared, journal=self.f.journal, approval_authority=approval, now_ns=self.f.now + 60_000_000_000)

    def test_snapshot_hash_is_not_raw_projection_hash(self):
        f = ReplayFixture(snapshot=True)
        prepared = f.prepare_replay()
        grant = json.loads(prepared.grant_binding_bytes)
        self.assertEqual(grant["rows"][0]["eventHash"], grant["rows"][1]["eventHash"])
        self.assertNotEqual(grant["rows"][0]["projectionRawSha256"], grant["rows"][1]["projectionRawSha256"])
        rows = json.loads(prepared.rows_bytes)
        rows["rows"].reverse()
        bad = replace(prepared, rows_bytes=f.authority.encode(rows))
        with self.assertRaisesRegex(ExecutionError, "original-row-substitution"):
            replay_receipt(bad, authority=f.authority)

    def test_nonprefix_ack_history_rejects_instead_of_skipping_missing_row(self):
        f = ReplayFixture(snapshot=True)
        row = list(f.tables["projections"][1])
        row[5] = 1
        f.tables["projections"][1] = tuple(row)
        with self.assertRaisesRegex(ExecutionError, "prior-outbox-not-fully-acknowledged"):
            f.prepare_replay()

    def test_repeated_empty_claim_gap_preserves_projected_prior_epoch(self):
        f = ReplayFixture()
        f.event("epoch-claimed", {"epoch": "3"}, "epoch-3", 800)
        f.event("observation", f.observation("observation-3", 3, 900), "observation-3", 900)
        f.event("reconciled", {}, "reconciled-3", 1000)
        f.metadata[0] = ("epoch", "3")
        f.journal.epoch, f.journal.sequence = 3, len(f.tables["events"])
        f.journal.event_hash, f.journal.state = f.tables["events"][-1][3], deepcopy(f.state)
        self.assertEqual(prior_projection_anchor(f.journal), (1, (1, f.old_genesis["sourceEventHash"])))
        prepared = f.prepare_replay(cloud_head=(1, f.old_genesis["sourceEventHash"]))
        self.assertEqual(prepared.evidence.prior_epoch, 1)
        self.assertEqual(prepared.evidence.current_epoch, 3)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=f.fence):
            apply_outbox_replay_ack(f.journal, prepared, ack=f.ack(prepared, "duplicate"))
            handoff = prepare_epoch_transition(f.journal, journal_identity="local-journal", stream_id="same-stream",
                       prior_epoch=1, prior_projection=(1, f.old_genesis["sourceEventHash"]), now_ns=f.now)
        snapshot = candidate_genesis(handoff, authority=f.authority, snapshot_id="epoch-three", max_age_ms=60000, now_ns=f.now)
        self.assertEqual(snapshot["ownerEpoch"], "3")
        self.assertEqual(snapshot["cash"], "100")

    def test_unrelated_postprepare_state_change_blocks_retry(self):
        prepared = self.f.prepare_replay()
        self.f.journal.state["cash"] = "999"
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            with self.assertRaises(ExecutionError):
                assert_current_replay_anchor(self.f.journal, prepared)

    def test_wrong_signature_clock_cannot_consume_or_replay(self):
        prepared = self.f.prepare_replay()
        approval = ReplayApprovalDouble(self.f.authority, prepared)
        value = json.loads(approval.raw)
        value["payload"]["expiresNs"] = str(self.f.now + 1)
        approval.raw = self.f.authority.encode(value)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=self.f.fence):
            with self.assertRaisesRegex(ExecutionError, "approval-exact-binding-mismatch"):
                build_outbox_replay(prepared, journal=self.f.journal, approval_authority=approval, now_ns=self.f.now)
        self.assertEqual(approval.calls, 0)

    def test_bounded_prefix_never_splits_or_skips_equal_head_snapshot(self):
        f = ReplayFixture(snapshot=True)
        with patch("vertex_host.replay.MAX_REPLAY_ROWS", 1):
            first = f.prepare_replay()
        self.assertEqual(first.publication_sequences, (1,))
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=f.fence):
            self.assertEqual(apply_outbox_replay_ack(f.journal, first, ack=f.ack(first)), 1)
        second = f.prepare_replay(cloud_head=(1, f.old_genesis["sourceEventHash"]), grant_id="snapshot-replay")
        self.assertEqual(second.publication_sequences, (2,))
        grant = json.loads(second.grant_binding_bytes)
        self.assertEqual(grant["startingSequence"], "1")
        self.assertEqual(grant["startingEventHash"], grant["rows"][0]["eventHash"])
        self.assertEqual(grant["rows"][0]["kind"], "portfolio-snapshot")
        self.assertNotEqual(first.evidence.outbox_sha256, second.evidence.outbox_sha256)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=f.fence):
            self.assertEqual(apply_outbox_replay_ack(f.journal, second, ack=f.ack(second)), 1)
        self.assertEqual(f.acked, [1, 2])

    def test_unfit_first_row_and_missing_configuration_fail_without_mutation(self):
        with patch("vertex_host.replay.MAX_REPLAY_DECODED_BYTES", 1):
            with self.assertRaisesRegex(ExecutionError, "first-row-exceeds-request-bound"):
                self.f.prepare_replay()
        for changes in ({"service_actor_id": ""}, {"maximum_batch_bytes": 0},
                        {"expires_ns": self.f.now}, {"grant_id": ""}):
            with self.assertRaises(ExecutionError):
                self.f.prepare_replay(**changes)
        self.assertEqual(self.f.acked, [])

    def test_receipt_rejects_reordered_publication_and_unknown_fields(self):
        f = ReplayFixture(snapshot=True)
        prepared = f.prepare_replay()
        value = json.loads(replay_receipt(prepared, authority=f.authority))
        value["publicationSequences"].reverse()
        with self.assertRaisesRegex(ExecutionError, "original-row-substitution"):
            restore_replay_receipt(f.authority.encode(value), authority=f.authority)
        value["publicationSequences"].reverse()
        value["trusted"] = True
        with self.assertRaisesRegex(ExecutionError, "receipt-shape-mismatch"):
            restore_replay_receipt(f.authority.encode(value), authority=f.authority)

    def test_retained_signed_rollover_replays_exact_original_after_restart(self):
        f = RolloverReplayFixture()
        before = deepcopy(f.journal.state)
        prepared = f.prepare_replay()
        self.assertEqual(prepared.retained_epoch_transition_bytes, f.retained_original)
        grant = json.loads(prepared.grant_binding_bytes)
        self.assertEqual(grant["retainedEpochTransitionSha256"], hashlib.sha256(f.retained_original).hexdigest())
        self.assertEqual((grant["priorOwnerEpoch"], grant["currentOwnerEpoch"]), ("2", "3"))
        self.assertEqual((grant["startingSequence"], grant["startingEventHash"]), ("0", None))
        self.assertEqual(f.lookup_calls, [f.tables["projections"][1][-1]])
        self.assertEqual(prepared.publication_sequences, (2,))
        approval = ReplayApprovalDouble(f.authority, prepared)
        with patch("vertex_host.epoch_transition._owner_fence", side_effect=f.fence):
            batch = build_outbox_replay(prepared, journal=f.journal, approval_authority=approval, now_ns=f.now)
            self.assertEqual(base64.b64decode(batch["retainedEpochTransitionBase64"]), f.retained_original)
            self.assertEqual(base64.b64decode(batch["rows"][0]["projectionBase64"]), f.tables["projections"][1][-1])
            self.assertEqual(apply_outbox_replay_ack(f.journal, prepared, ack=f.ack(prepared)), 1)
        self.assertEqual(f.acked, [2])
        self.assertEqual(f.journal.state, before)
        self.assertEqual(base64.b64decode(f.retained_wrapper["approvalBase64"]), f.old_signature)
        self.assertNotEqual(prepared.evidence.outbox_bytes, f.historical_outbox)
        self.assertNotEqual(prepared.evidence.owner_fence_bytes, f.historical_fence)

    def test_missing_rollover_receipt_never_becomes_initial_genesis(self):
        f = RolloverReplayFixture()
        with self.assertRaisesRegex(ExecutionError, "original-transition-lookup-required"):
            f.prepare_replay(epoch_transition_lookup=None)
        with self.assertRaisesRegex(ExecutionError, "original-retained-transition-required"):
            f.prepare_replay(epoch_transition_lookup=lambda _snapshot: None)
        def unavailable(_snapshot):
            raise ExecutionError("fixture-original-receipt-unavailable")
        with self.assertRaisesRegex(ExecutionError, "fixture-original-receipt-unavailable"):
            f.prepare_replay(epoch_transition_lookup=unavailable)
        self.assertEqual(f.acked, [])

    def test_retained_wrapper_wrong_prior_head_or_native_predecessor_rejects(self):
        f = RolloverReplayFixture()
        for field in ("priorProjectionHash", "journalHeadSha256"):
            wrong = deepcopy(f.retained_wrapper)
            wrong[field] = "c" * 64
            with self.assertRaisesRegex(ExecutionError, "retained-transition-.*-mismatch"):
                f.prepare_replay(epoch_transition_lookup=lambda _snapshot, value=wrong: value)
        wrong = deepcopy(f.retained_wrapper)
        wrong["snapshot"]["cash"] = "999"
        with self.assertRaisesRegex(ExecutionError, "retained-transition-original-anchor-mismatch"):
            f.prepare_replay(epoch_transition_lookup=lambda _snapshot: wrong)
        self.assertEqual(f.acked, [])

    def test_retained_receipt_restores_exact_sidecar_and_rejects_null_or_substitution(self):
        f = RolloverReplayFixture()
        prepared = f.prepare_replay()
        raw = replay_receipt(prepared, authority=f.authority)
        self.assertEqual(restore_replay_receipt(raw, authority=f.authority), prepared)
        with self.assertRaisesRegex(ExecutionError, "original-retained-transition-required"):
            replay_receipt(replace(prepared, retained_epoch_transition_bytes=None), authority=f.authority)
        grant = json.loads(prepared.grant_binding_bytes)
        grant["retainedEpochTransitionSha256"] = None
        with self.assertRaisesRegex(ExecutionError, "grant-evidence-anchor-mismatch"):
            replay_receipt(replace(prepared, grant_binding_bytes=f.authority.encode(grant)), authority=f.authority)
        with self.assertRaises(ExecutionError):
            replay_receipt(replace(prepared, retained_epoch_transition_bytes=b" " + f.retained_original), authority=f.authority)

    def test_original_rollover_must_fit_with_first_indivisible_genesis(self):
        f = RolloverReplayFixture()
        with patch("vertex_host.replay.MAX_RETAINED_TRANSITION_BYTES", len(f.retained_original) - 1):
            with self.assertRaisesRegex(ExecutionError, "original-retained-transition-required"):
                f.prepare_replay()
        without_wrapper = ReplayFixture().prepare_replay()
        ordinary_size = len(base64.b64decode(json.loads(without_wrapper.rows_bytes)["rows"][0]["projectionBase64"]))
        with patch("vertex_host.replay.MAX_REPLAY_DECODED_BYTES", 16_384 + ordinary_size):
            with self.assertRaisesRegex(ExecutionError, "first-row-exceeds-request-bound"):
                f.prepare_replay()
        self.assertEqual(f.acked, [])

    def test_initial_genesis_never_calls_lookup_or_accepts_rollover_sidecar(self):
        def forbidden(_snapshot):
            raise AssertionError("initial genesis must not consult rollover receipts")
        prepared = self.f.prepare_replay(epoch_transition_lookup=forbidden)
        self.assertIsNone(prepared.retained_epoch_transition_bytes)
        with self.assertRaisesRegex(ExecutionError, "unexpected-retained-transition"):
            replay_receipt(replace(prepared, retained_epoch_transition_bytes=b"{}"), authority=self.f.authority)

    def test_first_native_genesis_after_empty_claims_is_not_false_rollover(self):
        f = ReplayFixture()
        f.tables = {"events": [], "checkpoints": [], "projections": [], "native_proofs": []}
        f.state = deepcopy(f.initial)
        f.event("epoch-claimed", {"epoch": "1"}, "empty-epoch-1", 100)
        f.event("epoch-claimed", {"epoch": "2"}, "first-capital-epoch-2", 200)
        f.event("observation", f.observation("first-observation", 1, 300), "first-observation", 300)
        f.event("reconciled", {}, "first-reconciled", 400)
        f.old_genesis = build_genesis(authority=f.authority, owned_state=deepcopy(f.state), stream_id="same-stream",
                        owner_epoch=2, observed_at=timestamp(300), received_at=timestamp(300), evaluated_at=timestamp(500),
                        max_age_ms=60000, snapshot_id="first-native-genesis")
        f.event("portfolio-genesis", {"snapshotId": "first-native-genesis", "ownerEpoch": "2", "sequence": "1",
                 "sourceEventHash": f.old_genesis["sourceEventHash"]}, "first-native-genesis", 500)
        f.tables["projections"].append((1, "2", "1", f.old_genesis["sourceEventHash"], "portfolio-genesis", 0,
                                        f.authority.encode(f.old_genesis)))
        f.event("epoch-claimed", {"epoch": "3"}, "replay-epoch-3", 600)
        f.event("observation", f.observation("restored-observation", 2, 700), "restored-observation", 700)
        f.event("reconciled", {}, "restored-reconciled", 800)
        f.metadata[0] = ("epoch", "3")
        f.journal.epoch, f.journal.sequence = 3, len(f.tables["events"])
        f.journal.event_hash, f.journal.state = f.tables["events"][-1][3], deepcopy(f.state)
        def forbidden(_snapshot):
            raise AssertionError("no earlier projection exists: missing rollover is not missing authority")
        prepared = f.prepare_replay(prior_epoch=2, epoch_transition_lookup=forbidden)
        self.assertIsNone(prepared.retained_epoch_transition_bytes)
        self.assertIsNone(json.loads(prepared.grant_binding_bytes)["retainedEpochTransitionSha256"])
        self.assertEqual(prepared.evidence.prior_epoch, 2)
        self.assertEqual(json.loads(prepared.evidence.owned_state_bytes)["cash"], "100")
