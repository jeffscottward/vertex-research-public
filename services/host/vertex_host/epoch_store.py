"""Immutable host transition receipts inside the existing owned journal DB.

No separate cash/position store, journal event, owner claim, network call or
startup IO. Parent stores the already independently approved exact wrapper
BEFORE record_genesis; publication thereafter retrieves only this persisted
wrapper, never an unsigned fallback. Old epochs retain their original receipts.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

from .cache import HostUnavailable

MAX_WRAPPER_BYTES = 12_000_000
MAX_SNAPSHOT_BYTES = 8_000_000
_EPOCH = re.compile(r"[1-9][0-9]{0,18}", re.ASCII)


class EpochTransitionStore:
    def __init__(self, journal: Any, authority: Any) -> None:
        self.journal, self.authority = journal, authority
        self._initialized = False

    def initialize(self) -> None:
        """Explicit source-defined schema only; journal owns connection/lifetime.

        CREATE IF NOT EXISTS is not a migration. An incompatible preexisting
        table fails the structural query; no old wrapper is removed or changed.
        """
        with self.journal.mutex:
            with self.journal.transaction():
                db = self.journal._db()
                db.execute("""CREATE TABLE IF NOT EXISTS host_epoch_transitions (
                    owner_epoch TEXT PRIMARY KEY,
                    snapshot_sha256 TEXT NOT NULL UNIQUE,
                    transition_id TEXT NOT NULL UNIQUE,
                    wrapper_sha256 TEXT NOT NULL UNIQUE,
                    wrapper BLOB NOT NULL
                )""")
                # Columns and uniqueness are part of the immutable format, not
                # silently inferred from a same-named table with weaker keys.
                columns = db.execute("PRAGMA table_info(host_epoch_transitions)").fetchall()
                if [(row[1], row[2], row[3], row[5]) for row in columns] != [
                    ("owner_epoch", "TEXT", 0, 1), ("snapshot_sha256", "TEXT", 1, 0),
                    ("transition_id", "TEXT", 1, 0), ("wrapper_sha256", "TEXT", 1, 0),
                    ("wrapper", "BLOB", 1, 0),
                ]:
                    raise HostUnavailable("epoch-transition-store-schema-mismatch")
                unique = set()
                for index in db.execute("PRAGMA index_list(host_epoch_transitions)").fetchall():
                    if index[2] == 1 and index[4] == 0:
                        escaped = index[1].replace('"', '""')
                        unique.add(tuple(row[2] for row in db.execute(f'PRAGMA index_info("{escaped}")').fetchall()))
                if not {("owner_epoch",), ("snapshot_sha256",), ("transition_id",), ("wrapper_sha256",)} <= unique:
                    raise HostUnavailable("epoch-transition-store-uniqueness-required")
                db.execute("""CREATE TABLE IF NOT EXISTS host_native_replay_receipts (
                    grant_id TEXT PRIMARY KEY,
                    receipt_sha256 TEXT NOT NULL,
                    receipt BLOB NOT NULL,
                    batch_sha256 TEXT NOT NULL,
                    batch BLOB NOT NULL
                )""")
                replay_columns = db.execute("PRAGMA table_info(host_native_replay_receipts)").fetchall()
                if [(row[1], row[2], row[3], row[5]) for row in replay_columns] != [
                    ("grant_id", "TEXT", 0, 1), ("receipt_sha256", "TEXT", 1, 0),
                    ("receipt", "BLOB", 1, 0), ("batch_sha256", "TEXT", 1, 0), ("batch", "BLOB", 1, 0),
                ]:
                    raise HostUnavailable("native-replay-receipt-schema-mismatch")
            self._initialized = True

    def _db(self) -> Any:
        if not self._initialized:
            raise HostUnavailable("epoch-transition-store-not-initialized")
        return self.journal._db()

    def _snapshot(self, snapshot: Any) -> tuple[dict[str, Any], str, str]:
        if type(snapshot) is not dict:
            raise HostUnavailable("exact-epoch-snapshot-required")
        raw = self.authority.encode(snapshot)
        if type(raw) is not bytes or not 0 < len(raw) <= MAX_SNAPSHOT_BYTES:
            raise HostUnavailable("epoch-snapshot-bound")
        value = json.loads(raw)
        if self.authority.validate("PortfolioGenesis", value) is not True:
            raise HostUnavailable("native-epoch-genesis-validation-required")
        epoch = value.get("ownerEpoch")
        if (type(epoch) is not str or _EPOCH.fullmatch(epoch) is None or int(epoch) > 9_223_372_036_854_775_807
                or value.get("environment") != "paper" or value.get("sequence") != "1"):
            raise HostUnavailable("native-epoch-genesis-scope-required")
        return value, epoch, hashlib.sha256(raw).hexdigest()

    def _wrapper(self, wrapper: Any) -> tuple[dict[str, Any], str, str, bytes, str]:
        if type(wrapper) is not dict:
            raise HostUnavailable("exact-epoch-transition-wrapper-required")
        raw = self.authority.encode(wrapper)
        if type(raw) is not bytes or not 0 < len(raw) <= MAX_WRAPPER_BYTES:
            raise HostUnavailable("epoch-transition-wrapper-bound")
        value = json.loads(raw)
        if self.authority.encode(value) != raw or self.authority.validate("PortfolioEpochTransition", value) is not True:
            raise HostUnavailable("native-epoch-transition-validation-required")
        snapshot, epoch, digest = self._snapshot(value.get("snapshot"))
        if value["snapshot"] != snapshot:
            raise HostUnavailable("epoch-transition-snapshot-mismatch")
        return value, epoch, digest, raw, hashlib.sha256(raw).hexdigest()

    def store(self, wrapper: dict[str, Any]) -> None:
        """Persist approved canonical bytes once; matching retry is observational.

        Schema validation is not approval: caller must consume the independent
        native signature before calling. A fresh insert requires the current
        owner, exact journal head and no existing current-epoch genesis.
        """
        value, epoch, snapshot_sha, raw, wrapper_sha = self._wrapper(wrapper)
        with self.journal.mutex:
            with self.journal.transaction():
                db = self._db()
                old = db.execute("SELECT snapshot_sha256,wrapper_sha256,wrapper FROM host_epoch_transitions WHERE owner_epoch=?", (epoch,)).fetchone()
                if old is not None:
                    if old != (snapshot_sha, wrapper_sha, raw):
                        raise HostUnavailable("immutable-epoch-transition-conflict")
                    return
                state = self.journal.state
                if (epoch != str(self.journal.epoch) or epoch != state["ownerEpoch"]
                        or value["snapshot"]["accountAlias"] != state["accountAlias"]
                        or state["environment"] != "paper" or value["snapshot"]["currency"] != state["currency"]
                        or value["journalSequence"] != str(self.journal.sequence)
                        or value["journalHeadSha256"] != self.journal.event_hash):
                    raise HostUnavailable("epoch-transition-current-journal-mismatch")
                if db.execute("SELECT 1 FROM projections WHERE owner_epoch=? AND kind='portfolio-genesis' LIMIT 1", (epoch,)).fetchone() is not None:
                    raise HostUnavailable("epoch-transition-must-precede-genesis")
                conflict = db.execute("SELECT 1 FROM host_epoch_transitions WHERE transition_id=? OR snapshot_sha256=? OR wrapper_sha256=?",
                                      (value["transitionId"], snapshot_sha, wrapper_sha)).fetchone()
                if conflict is not None:
                    raise HostUnavailable("immutable-epoch-transition-identity-conflict")
                db.execute("INSERT INTO host_epoch_transitions VALUES (?,?,?,?,?)",
                           (epoch, snapshot_sha, value["transitionId"], wrapper_sha, raw))

    def get(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        """Read exact retained wrapper, including prior epochs awaiting ACK.

        No missing-receipt synthesis, modified signature, grant reissue, receipt
        mutation or unsigned-genesis fallback is permitted. Returned JSON is a
        detached value; mutating it cannot change the persisted original bytes.
        """
        _, epoch, snapshot_sha = self._snapshot(snapshot)
        with self.journal.mutex:
            with self.journal.transaction():
                row = self._db().execute("SELECT wrapper_sha256,wrapper FROM host_epoch_transitions WHERE owner_epoch=? AND snapshot_sha256=?",
                                         (epoch, snapshot_sha)).fetchone()
                if row is None:
                    raise HostUnavailable("signed-epoch-transition-unavailable")
                if type(row[1]) is not bytes or len(row[1]) > MAX_WRAPPER_BYTES or hashlib.sha256(row[1]).hexdigest() != row[0]:
                    raise HostUnavailable("epoch-transition-receipt-corrupt")
                value, stored_epoch, stored_sha, raw, wrapper_sha = self._wrapper(json.loads(row[1]))
                if (stored_epoch, stored_sha, raw, wrapper_sha) != (epoch, snapshot_sha, row[1], row[0]):
                    raise HostUnavailable("epoch-transition-receipt-binding-mismatch")
                return value

    def _replay(self, grant_id: str, receipt: bytes, batch: Any) -> tuple[Any, bytes, str, str]:
        from .replay import restore_replay_receipt
        if type(receipt) is not bytes or not 0 < len(receipt) <= 64 * 1024 * 1024:
            raise HostUnavailable("native-replay-receipt-bound")
        prepared = restore_replay_receipt(receipt, authority=self.authority)
        if type(batch) is not dict or self.authority.validate("NativeOutboxReplay", batch) is not True:
            raise HostUnavailable("native-replay-batch-invalid")
        raw = self.authority.encode(batch)
        if not 0 < len(raw) <= 12 * 1024 * 1024:
            raise HostUnavailable("native-replay-batch-bound")
        binding = {key: value for key, value in batch["grant"].items() if key != "approvalBase64"}
        if (binding["grantId"] != grant_id or self.authority.encode(binding) != prepared.grant_binding_bytes
                or json.loads(prepared.rows_bytes)["rows"] != batch["rows"]):
            raise HostUnavailable("native-replay-receipt-binding-mismatch")
        retained = prepared.retained_epoch_transition_bytes
        if retained is None:
            if batch["retainedEpochTransitionBase64"] is not None or binding["retainedEpochTransitionSha256"] is not None:
                raise HostUnavailable("native-replay-retained-transition-null-pair-required")
        elif (type(retained) is not bytes or not 0 < len(retained) <= 1_048_576
                or batch["retainedEpochTransitionBase64"] != base64.b64encode(retained).decode("ascii")
                or binding["retainedEpochTransitionSha256"] != hashlib.sha256(retained).hexdigest()):
            raise HostUnavailable("native-replay-retained-transition-changed")
        return prepared, raw, hashlib.sha256(receipt).hexdigest(), hashlib.sha256(raw).hexdigest()

    def store_replay(self, grant_id: str, receipt: bytes, batch: dict[str, Any]) -> None:
        """Immutable signed retry material, not another admission or work queue."""
        from .replay import assert_current_replay_anchor
        prepared, raw, receipt_sha, batch_sha = self._replay(grant_id, receipt, batch)
        with self.journal.mutex:
            assert_current_replay_anchor(self.journal, prepared)
            with self.journal.transaction():
                db = self._db()
                row = db.execute("SELECT receipt_sha256,receipt,batch_sha256,batch FROM host_native_replay_receipts WHERE grant_id=?",
                                 (grant_id,)).fetchone()
                if row is not None:
                    if row != (receipt_sha, receipt, batch_sha, raw):
                        raise HostUnavailable("immutable-native-replay-receipt-conflict")
                    return
                db.execute("INSERT INTO host_native_replay_receipts VALUES (?,?,?,?,?)",
                           (grant_id, receipt_sha, receipt, batch_sha, raw))

    def get_replay(self, grant_id: str) -> tuple[bytes, dict[str, Any]]:
        """No renewed permission: caller must recheck current signed authority."""
        with self.journal.mutex:
            row = self._db().execute("SELECT receipt_sha256,receipt,batch_sha256,batch FROM host_native_replay_receipts WHERE grant_id=?",
                                     (grant_id,)).fetchone()
            if (row is None or type(row[1]) is not bytes or type(row[3]) is not bytes
                    or len(row[1]) > 64 * 1024 * 1024 or len(row[3]) > 12 * 1024 * 1024
                    or hashlib.sha256(row[1]).hexdigest() != row[0] or hashlib.sha256(row[3]).hexdigest() != row[2]):
                raise HostUnavailable("native-replay-receipt-missing-or-corrupt")
            batch = json.loads(row[3])
            _, raw, receipt_sha, batch_sha = self._replay(grant_id, row[1], batch)
            if (receipt_sha, batch_sha, raw) != (row[0], row[2], row[3]):
                raise HostUnavailable("native-replay-receipt-noncanonical")
            return row[1], batch
