"""Narrow consumed-cancel handoff from native owner to local simulator.

The owner consumes its independent grant once, then durably appends the original
cancel-request marker before calling the simulator. This adapter does not consume
again or grant generic replay rights. It neither issues cancellation nor mutates
approval/native journal state; simulator durable checkpoint logic remains owner
of the single transport action. Constructor/import perform no IO.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from vertex_execution.ports import MutationGrant


class SimulatorMutationAuthority:
    def __init__(self, delegate: Any, journal: Any) -> None:
        self.delegate, self.journal = delegate, journal

    def verify(self, grant: MutationGrant, *, now_ns: int) -> bool:
        """Require exact persisted current-owner cancel marker AND consumed grant.

        Existing cancel-request payload has submissionKey/payloadSha256/grantId,
        not evidenceSha256. Evidence is bound by delegate's exact full-grant
        signed digest and consumed audit receipt; never infer a missing field.
        This adapter is for transport only, never PaperExecutionOwner authority.
        """
        try:
            if (type(grant) is not MutationGrant or grant.action != "cancel-simulation"
                    or type(grant.submission_key) is not str or not grant.submission_key
                    or type(grant.owner_epoch) is not int or type(now_ns) is not int
                    or type(grant.issued_ns) is not int or type(grant.expires_ns) is not int
                    or not 0 <= grant.issued_ns <= now_ns < grant.expires_ns
                    or grant.environment != "paper"):
                return False
            with self.journal.mutex:
                db = self.journal._db()  # Existing closed/forked/poisoned checks.
                state = self.journal.state
                if (grant.owner_epoch != self.journal.epoch or state["ownerEpoch"] != str(grant.owner_epoch)
                        or state["accountAlias"] != grant.account_alias or state["environment"] != "paper"):
                    return False
                stored_epoch = db.execute("SELECT value FROM metadata WHERE key='epoch'").fetchone()
                if stored_epoch != (str(grant.owner_epoch),):
                    return False
                order = state["orders"].get(grant.submission_key)
                if (type(order) is not dict or order.get("cancelRequested") is not True
                        or order.get("dispatchMarked") is not True):
                    return False
                event_id = "cancel-" + grant.grant_id
                row = db.execute("SELECT sequence,previous_hash,event_hash,payload FROM events WHERE event_id=?", (event_id,)).fetchone()
                if row is None or type(row[3]) is not bytes or not 0 < len(row[3]) <= 65_536:
                    return False
                sequence, previous_hash, event_hash, raw = row
                event = json.loads(raw)
                if (self.journal.authority.encode(event) != raw or hashlib.sha256(raw).hexdigest() != event_hash
                        or type(event) is not dict or set(event) != {"sequence", "previousHash", "ownerEpoch", "eventId", "occurredNs", "kind", "data"}
                        or event["sequence"] != str(sequence) or event["previousHash"] != previous_hash
                        or event["ownerEpoch"] != str(grant.owner_epoch) or event["eventId"] != event_id
                        or event["kind"] != "cancel-request" or event["data"] != {
                            "submissionKey": grant.submission_key,
                            "payloadSha256": order["payloadSha256"], "grantId": grant.grant_id,
                        } or not 0 < sequence <= self.journal.sequence):
                    return False
                occurred = event["occurredNs"]
                if (type(occurred) is not str or not occurred.isascii() or not occurred.isdecimal()
                        or str(int(occurred)) != occurred or not grant.issued_ns <= int(occurred) <= now_ns):
                    return False
                # Marker must be the original retained durable journal chain row,
                # not a stand-alone self-hashed JSON supplied by a transport call.
                prior = db.execute("SELECT event_hash FROM events WHERE sequence=?", (sequence - 1,)).fetchone()
                if previous_hash != ("0" * 64 if sequence == 1 else prior[0] if prior else None):
                    return False
                if sequence == self.journal.sequence:
                    if event_hash != self.journal.event_hash:
                        return False
                else:
                    following = db.execute("SELECT previous_hash FROM events WHERE sequence=?", (sequence + 1,)).fetchone()
                    if following != (event_hash,):
                        return False
                return self.delegate.verify_consumed(grant, now_ns=now_ns) is True
        except Exception:
            return False
