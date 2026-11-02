"""Authored only; synthetic SQLite/approval operations have not been executed."""
from dataclasses import replace
import hashlib
import json
import sqlite3
import threading
import unittest
from unittest.mock import Mock, patch

from vertex_execution.ports import MutationGrant
from vertex_host.native_approval_transport import SimulatorMutationAuthority


class FixtureAuthority:
    def encode(self, value) -> bytes:
        return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class FixtureJournal:
    def __init__(self) -> None:
        self.authority = FixtureAuthority()
        self.mutex = threading.RLock()
        self.epoch, self.sequence = 2, 1
        self.state = {"ownerEpoch": "2", "accountAlias": "paper-fixture", "environment": "paper",
                      "orders": {"submission-fixture": {"payloadSha256": "a" * 64, "dispatchMarked": True,
                                                        "cancelRequested": True}}}
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)")
        self.db.execute("INSERT INTO metadata VALUES('epoch','2')")
        self.db.execute("CREATE TABLE events(sequence INTEGER PRIMARY KEY,event_id TEXT,previous_hash TEXT,event_hash TEXT,payload BLOB)")
        self.event = {"sequence": "1", "previousHash": "0" * 64, "ownerEpoch": "2",
                      "eventId": "cancel-cancel-fixture", "occurredNs": "100", "kind": "cancel-request",
                      "data": {"submissionKey": "submission-fixture", "payloadSha256": "a" * 64, "grantId": "cancel-fixture"}}
        self.persist()

    def _db(self):
        return self.db

    def persist(self) -> None:
        raw = self.authority.encode(self.event)
        self.event_hash = hashlib.sha256(raw).hexdigest()
        self.db.execute("DELETE FROM events")
        self.db.execute("INSERT INTO events VALUES(?,?,?,?,?)", (1, self.event["eventId"], self.event["previousHash"], self.event_hash, raw))
        self.db.commit()


class SimulatorMutationAuthorityRegression(unittest.TestCase):
    def setUp(self) -> None:
        self.journal = FixtureJournal()
        self.addCleanup(self.journal.db.close)
        self.delegate = Mock()
        self.delegate.verify_consumed.return_value = True
        self.adapter = SimulatorMutationAuthority(self.delegate, self.journal)
        self.grant = MutationGrant("cancel-fixture", "cancel-simulation", "paper-fixture", "paper", 2,
                                   "submission-fixture", "human-fixture", 90, 900, "b" * 64)

    def test_exact_persisted_marker_hands_off_without_second_consumption(self) -> None:
        self.assertTrue(self.adapter.verify(self.grant, now_ns=100))
        self.delegate.verify_consumed.assert_called_once_with(self.grant, now_ns=100)
        self.delegate.verify.assert_not_called()
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM events").fetchone(), (1,))

    def test_constructor_does_not_read_or_write_journal(self) -> None:
        with patch.object(self.journal, "_db") as db:
            SimulatorMutationAuthority(self.delegate, self.journal)
            db.assert_not_called()

    def test_absent_marker_or_memory_only_flag_never_authorizes(self) -> None:
        self.journal.db.execute("DELETE FROM events")
        self.assertFalse(self.adapter.verify(self.grant, now_ns=100))
        self.delegate.verify_consumed.assert_not_called()
        self.journal.persist()
        self.journal.state["orders"]["submission-fixture"]["cancelRequested"] = False
        self.assertFalse(self.adapter.verify(self.grant, now_ns=100))
        self.delegate.verify_consumed.assert_not_called()

    def test_wrong_marker_grant_payload_epoch_kind_and_chain_deny(self) -> None:
        original = json.loads(self.journal.authority.encode(self.journal.event))
        for change in ({"ownerEpoch": "1"}, {"kind": "liquidation-request"}, {"previousHash": "f" * 64},
                       {"data": {**original["data"], "grantId": "other"}},
                       {"data": {**original["data"], "payloadSha256": "f" * 64}},
                       {"occurredNs": "89"}):
            self.journal.event = {**original, **change}
            self.journal.persist()
            self.assertFalse(self.adapter.verify(self.grant, now_ns=100))
        self.delegate.verify_consumed.assert_not_called()

    def test_current_owner_fence_and_exact_cancel_scope_required(self) -> None:
        for change in ({"owner_epoch": 1}, {"environment": "live"}, {"account_alias": "other"},
                       {"action": "reset-new-risk"}, {"submission_key": None}, {"expires_ns": 100}):
            self.assertFalse(self.adapter.verify(replace(self.grant, **change), now_ns=100))
        self.journal.db.execute("UPDATE metadata SET value='3' WHERE key='epoch'")
        self.assertFalse(self.adapter.verify(self.grant, now_ns=100))
        self.delegate.verify_consumed.assert_not_called()

    def test_changed_evidence_is_checked_by_exact_consumed_signed_grant(self) -> None:
        altered = replace(self.grant, evidence_sha256="c" * 64)
        self.delegate.verify_consumed.side_effect = lambda value, **_: value == self.grant
        self.assertFalse(self.adapter.verify(altered, now_ns=100))
        self.assertTrue(self.adapter.verify(self.grant, now_ns=100))

    def test_corrupt_marker_or_nonliteral_delegate_success_denies(self) -> None:
        self.journal.db.execute("UPDATE events SET payload=?", (b"{}",))
        self.assertFalse(self.adapter.verify(self.grant, now_ns=100))
        self.journal.persist()
        self.delegate.verify_consumed.return_value = 1
        self.assertFalse(self.adapter.verify(self.grant, now_ns=100))

    def test_original_marker_before_later_event_requires_chain_link(self) -> None:
        self.journal.sequence = 2
        self.journal.db.execute("INSERT INTO events VALUES (2,'later',?,'later-hash',?)", (self.journal.event_hash, b"{}"))
        self.assertTrue(self.adapter.verify(self.grant, now_ns=100))
        self.journal.db.execute("UPDATE events SET previous_hash=? WHERE sequence=2", ("f" * 64,))
        self.assertFalse(self.adapter.verify(self.grant, now_ns=100))
