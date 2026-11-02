"""Source-authored regressions only; no SQLite or tests run during authoring."""
from contextlib import contextmanager
from copy import deepcopy
import base64
import hashlib
import json
import sqlite3
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from vertex_host.cache import HostUnavailable
from vertex_host.epoch_store import EpochTransitionStore


class FixtureAuthority:
    """Structural stub tests store behavior, not real native schema acceptance."""
    def __init__(self) -> None:
        self.reject: str | None = None

    def encode(self, value) -> bytes:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def validate(self, name, value) -> bool:
        return name != self.reject and name in {"PortfolioGenesis", "PortfolioEpochTransition", "NativeOutboxReplay"}


class FixtureJournal:
    def __init__(self) -> None:
        self.mutex = threading.RLock()
        self.connection = sqlite3.connect(":memory:", isolation_level=None)
        self.connection.execute("CREATE TABLE projections(owner_epoch TEXT,kind TEXT)")
        self.epoch = 2
        self.sequence = 31
        self.event_hash = "4" * 64
        self.state = {"ownerEpoch": "2", "accountAlias": "paper-fixture", "environment": "paper", "currency": "USD",
                      "cash": "100.00", "positions": {}, "orders": {}}
        self.fenced = False

    def _db(self):
        return self.connection

    @contextmanager
    def transaction(self):
        with self.mutex:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                if self.fenced:
                    raise HostUnavailable("synthetic-owner-fenced")
                yield
                self.connection.execute("COMMIT")
            except BaseException:
                self.connection.execute("ROLLBACK")
                raise


class EpochStoreRegression(unittest.TestCase):
    def setUp(self) -> None:
        self.authority = FixtureAuthority()
        self.journal = FixtureJournal()
        self.addCleanup(self.journal.connection.close)
        self.store = EpochTransitionStore(self.journal, self.authority)
        self.wrapper = {
            "schemaVersion": "1.0.0", "transitionId": "transition-fixture",
            "snapshot": {"ownerEpoch": "2", "accountAlias": "paper-fixture", "environment": "paper",
                         "currency": "USD", "sequence": "1", "snapshotId": "snapshot-fixture"},
            "priorOwnerEpoch": "1", "priorProjectionSequence": "17", "priorProjectionHash": "3" * 64,
            "journalIdentity": "journal-fixture", "journalSequence": "31", "journalHeadSha256": "4" * 64,
            "nativeOutboxEvidenceSha256": "5" * 64, "nativeOwnerFenceSha256": "6" * 64,
            "approvalBase64": "cHVibGljLXN5bnRoZXRpYy1zaWduZWQtYnl0ZXM=",
        }

    def test_constructor_has_no_schema_or_io_side_effect(self) -> None:
        with patch.object(self.journal, "_db") as db:
            EpochTransitionStore(self.journal, self.authority)
            db.assert_not_called()
        with self.assertRaisesRegex(HostUnavailable, "not-initialized"):
            self.store.store(self.wrapper)

    def test_exact_wrapper_is_retained_without_balance_or_journal_change(self) -> None:
        original = deepcopy(self.journal.state)
        self.store.initialize()
        self.store.store(self.wrapper)
        self.store.store(self.wrapper)
        result = self.store.get(self.wrapper["snapshot"])
        self.assertEqual(result, self.wrapper)
        result["approvalBase64"] = "mutation-only-in-returned-copy"
        self.assertEqual(self.store.get(self.wrapper["snapshot"]), self.wrapper)
        self.assertEqual(self.journal.state, original)
        self.assertEqual(self.journal.sequence, 31)
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM host_epoch_transitions").fetchone(), (1,))
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM projections").fetchone(), (0,))

    def test_missing_or_changed_snapshot_never_gets_unsigned_fallback(self) -> None:
        self.store.initialize()
        with self.assertRaisesRegex(HostUnavailable, "unavailable"):
            self.store.get(self.wrapper["snapshot"])
        self.store.store(self.wrapper)
        altered = {**self.wrapper["snapshot"], "snapshotId": "different"}
        with self.assertRaisesRegex(HostUnavailable, "unavailable"):
            self.store.get(altered)

    def test_wrapper_or_signature_cannot_be_replaced(self) -> None:
        self.store.initialize()
        self.store.store(self.wrapper)
        for change in ({"approvalBase64": "Y2hhbmdlZA=="}, {"transitionId": "other-transition"},
                       {"nativeOwnerFenceSha256": "f" * 64}):
            with self.assertRaisesRegex(HostUnavailable, "immutable"):
                self.store.store({**self.wrapper, **change})
        self.assertEqual(self.store.get(self.wrapper["snapshot"]), self.wrapper)

    def test_new_receipt_must_precede_genesis_but_exact_retry_can_follow(self) -> None:
        self.store.initialize()
        self.journal.connection.execute("INSERT INTO projections VALUES ('2','portfolio-genesis')")
        with self.assertRaisesRegex(HostUnavailable, "precede-genesis"):
            self.store.store(self.wrapper)
        self.journal.connection.execute("DELETE FROM projections")
        self.store.store(self.wrapper)
        self.journal.connection.execute("INSERT INTO projections VALUES ('2','portfolio-genesis')")
        self.store.store(self.wrapper)
        self.assertEqual(self.store.get(self.wrapper["snapshot"]), self.wrapper)

    def test_prior_epoch_receipt_is_readable_after_restore_but_not_reissued(self) -> None:
        self.store.initialize()
        self.store.store(self.wrapper)
        self.journal.epoch = 3
        self.journal.state["ownerEpoch"] = "3"
        restored = EpochTransitionStore(self.journal, self.authority)
        restored.initialize()
        self.assertEqual(restored.get(self.wrapper["snapshot"]), self.wrapper)
        changed = deepcopy(self.wrapper)
        changed["snapshot"]["ownerEpoch"] = "3"
        with self.assertRaisesRegex(HostUnavailable, "identity-conflict"):
            restored.store(changed)

    def test_wrong_journal_head_epoch_scope_or_native_schema_denies(self) -> None:
        self.store.initialize()
        for change in ({"journalSequence": "30"}, {"journalHeadSha256": "f" * 64}):
            with self.assertRaisesRegex(HostUnavailable, "journal-mismatch"):
                self.store.store({**self.wrapper, **change})
        changed = deepcopy(self.wrapper)
        changed["snapshot"]["accountAlias"] = "other-account"
        with self.assertRaisesRegex(HostUnavailable, "journal-mismatch"):
            self.store.store(changed)
        self.authority.reject = "PortfolioEpochTransition"
        with self.assertRaisesRegex(HostUnavailable, "validation-required"):
            self.store.store(self.wrapper)
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM host_epoch_transitions").fetchone(), (0,))

    def test_corrupt_stored_bytes_or_canonical_hash_denies(self) -> None:
        self.store.initialize()
        self.store.store(self.wrapper)
        altered = self.authority.encode({**self.wrapper, "approvalBase64": "dGFtcGVyZWQ="})
        self.journal.connection.execute("UPDATE host_epoch_transitions SET wrapper=?", (altered,))
        with self.assertRaisesRegex(HostUnavailable, "corrupt"):
            self.store.get(self.wrapper["snapshot"])

    def test_weak_existing_schema_never_implicitly_migrates(self) -> None:
        self.journal.connection.execute("CREATE TABLE host_epoch_transitions(owner_epoch TEXT,wrapper BLOB)")
        with self.assertRaisesRegex(HostUnavailable, "schema-mismatch"):
            self.store.initialize()
        columns = self.journal.connection.execute("PRAGMA table_info(host_epoch_transitions)").fetchall()
        self.assertEqual([row[1] for row in columns], ["owner_epoch", "wrapper"])

    def test_owner_fence_applies_to_initialize_store_and_get(self) -> None:
        self.store.initialize()
        self.store.store(self.wrapper)
        self.journal.fenced = True
        for operation in (self.store.initialize, lambda: self.store.store(self.wrapper), lambda: self.store.get(self.wrapper["snapshot"])):
            with self.assertRaisesRegex(HostUnavailable, "fenced"):
                operation()

    def replay_fixture(self):
        binding = {"grantId": "replay-fixture", "currentOwnerEpoch": "2", "retainedEpochTransitionSha256": None}
        rows = [{"projectionBase64": "e30="}]
        batch = {"grant": {**binding, "approvalBase64": "c2lnbmVk"}, "rows": rows, "retainedEpochTransitionBase64": None}
        prepared = SimpleNamespace(grant_binding_bytes=self.authority.encode(binding),
                                   rows_bytes=self.authority.encode({"rows": rows}), retained_epoch_transition_bytes=None)
        return prepared, b"synthetic-reviewed-receipt", batch

    def test_replay_receipt_is_immutable_and_never_cash_or_queue(self):
        prepared, receipt, batch = self.replay_fixture()
        original = deepcopy(self.journal.state)
        self.store.initialize()
        with patch("vertex_host.replay.restore_replay_receipt", return_value=prepared), \
             patch("vertex_host.replay.assert_current_replay_anchor"):
            self.store.store_replay("replay-fixture", receipt, batch)
            self.store.store_replay("replay-fixture", receipt, batch)
            returned_receipt, returned_batch = self.store.get_replay("replay-fixture")
            self.assertEqual((returned_receipt, returned_batch), (receipt, batch))
            returned_batch["grant"]["approvalBase64"] = "bXV0YXRlZA=="
            self.assertEqual(self.store.get_replay("replay-fixture"), (receipt, batch))
            with self.assertRaisesRegex(HostUnavailable, "immutable"):
                self.store.store_replay("replay-fixture", receipt, returned_batch)
        self.assertEqual(self.journal.state, original)
        self.assertEqual(self.journal.sequence, 31)
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM projections").fetchone(), (0,))

    def test_replay_receipt_corruption_cannot_become_retry_authority(self):
        prepared, receipt, batch = self.replay_fixture()
        self.store.initialize()
        with patch("vertex_host.replay.restore_replay_receipt", return_value=prepared), \
             patch("vertex_host.replay.assert_current_replay_anchor"):
            self.store.store_replay("replay-fixture", receipt, batch)
        self.journal.connection.execute("UPDATE host_native_replay_receipts SET receipt=?", (b"changed",))
        with self.assertRaisesRegex(HostUnavailable, "corrupt"):
            self.store.get_replay("replay-fixture")

    def test_replay_receipt_rechecks_current_journal_before_persistence(self):
        prepared, receipt, batch = self.replay_fixture()
        self.store.initialize()
        with patch("vertex_host.replay.restore_replay_receipt", return_value=prepared), \
             patch("vertex_host.replay.assert_current_replay_anchor", side_effect=HostUnavailable("fenced")):
            with self.assertRaisesRegex(HostUnavailable, "fenced"):
                self.store.store_replay("replay-fixture", receipt, batch)
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM host_native_replay_receipts").fetchone(), (0,))

    def test_retained_transition_sidecar_must_match_original_receipt_bytes(self):
        prepared, receipt, batch = self.replay_fixture()
        original = b'{"synthetic":"original-signed-transition"}'
        binding = json.loads(prepared.grant_binding_bytes)
        binding["retainedEpochTransitionSha256"] = hashlib.sha256(original).hexdigest()
        prepared.grant_binding_bytes = self.authority.encode(binding)
        prepared.retained_epoch_transition_bytes = original
        batch["grant"] = {**binding, "approvalBase64": "c2lnbmVk"}
        batch["retainedEpochTransitionBase64"] = base64.b64encode(original).decode("ascii")
        self.store.initialize()
        with patch("vertex_host.replay.restore_replay_receipt", return_value=prepared), \
             patch("vertex_host.replay.assert_current_replay_anchor"):
            self.store.store_replay("replay-fixture", receipt, batch)
            changed = deepcopy(batch)
            changed["retainedEpochTransitionBase64"] = base64.b64encode(b"changed").decode("ascii")
            with self.assertRaisesRegex(HostUnavailable, "retained-transition-changed"):
                self.store.store_replay("replay-fixture", receipt, changed)

    def test_normal_replay_cannot_hide_unsigned_transition_sidecar(self):
        prepared, receipt, batch = self.replay_fixture()
        batch["retainedEpochTransitionBase64"] = "e30="
        self.store.initialize()
        with patch("vertex_host.replay.restore_replay_receipt", return_value=prepared):
            with self.assertRaisesRegex(HostUnavailable, "null-pair"):
                self.store.store_replay("replay-fixture", receipt, batch)
