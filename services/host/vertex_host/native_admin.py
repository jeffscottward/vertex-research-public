"""Optional local operator ingress; no worker-token route or automatic actions.

The socket is private, peer credentials are checked, and all mutations still
require independently signed native approval. This module never signs approvals,
reads keys from a vault, or chooses capital. Construction does not open a socket.
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import fields
import os
from pathlib import Path
import socket
import stat
import struct
from typing import Any

from vertex_execution.capital import SimulationCapitalPolicy
from vertex_execution.ports import MutationGrant, PortfolioObservation
from .cache import HostUnavailable, canonical_object
from .local_state import private_directory


MAX_REQUEST = 262_144
_RECORDS = {"capital": SimulationCapitalPolicy, "observation": PortfolioObservation, "mutation": MutationGrant}
_INTS = {"owner_epoch", "approved_ns", "expires_ns", "maximum_observation_age_ns", "observed_ns", "received_ns",
         "valid_until_ns", "source_sequence", "journal_sequence", "issued_ns"}
_BOOL = {"real_account_funds", "broker_submission_allowed"}
_NULLABLE = {"submission_key", "seed_policy_artifact_id", "seed_policy_sha256"}


def typed_subject(kind: str, record: dict[str, Any]) -> Any:
    cls = _RECORDS.get(kind)
    if cls is None or type(record) is not dict or set(record) != {field.name for field in fields(cls)}:
        raise HostUnavailable("exact-native-subject-fields-required")
    converted = {}
    for name, value in record.items():
        if name in _INTS:
            if type(value) is not str or not value.isascii() or not value.isdecimal() or len(value) > 39 or (len(value) > 1 and value[0] == "0") or int(value) >= 2**127:
                raise HostUnavailable("exact-native-subject-integer-required")
            converted[name] = int(value)
        elif name in _BOOL:
            if type(value) is not bool:
                raise HostUnavailable("native-subject-boolean-type")
            converted[name] = value
        elif name == "positions":
            if type(value) is not list or len(value) > 10000 or any(type(pair) is not list or len(pair) != 2 or any(type(item) is not str or len(item) > 256 for item in pair) for pair in value):
                raise HostUnavailable("bounded-native-position-list-required")
            converted[name] = tuple(tuple(pair) for pair in value)
        elif value is None and name in _NULLABLE:
            converted[name] = None
        else:
            if type(value) is not str or not 1 <= len(value) <= 256:
                raise HostUnavailable("bounded-native-subject-text-required")
            converted[name] = value
    return cls(**converted)


class NativeAdminServer:
    def __init__(self, *, config: dict[str, Any], host: Any) -> None:
        if type(config) is not dict or set(config) != {"socketPath", "operatorUid", "requestTimeoutSeconds"}:
            raise HostUnavailable("explicit-native-admin-configuration-required")
        if type(config["operatorUid"]) is not int or config["operatorUid"] < 0 or type(config["requestTimeoutSeconds"]) is not int or not 1 <= config["requestTimeoutSeconds"] <= 60:
            raise HostUnavailable("bounded-local-operator-policy-required")
        self.path = Path(config["socketPath"])
        self.operator_uid, self.timeout = config["operatorUid"], config["requestTimeoutSeconds"]
        self.host, self.server, self.inode = host, None, None
        self._lock = asyncio.Lock()
        self._clients: set[asyncio.Task[Any]] = set()

    async def start(self) -> None:
        private_directory(self.path)
        if self.path.exists() or self.path.is_symlink():
            # Do not erase a possibly live owner's socket after a crash.
            raise HostUnavailable("native-admin-existing-socket-requires-human-recovery")
        self.server = await asyncio.start_unix_server(self._serve, path=self.path, limit=MAX_REQUEST + 1)
        os.chmod(self.path, 0o600)
        self.inode = self.path.lstat().st_ino

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if len(self._clients) >= 8:
            writer.close()
            return
        self._clients.add(task)
        try:
            raw_socket = writer.get_extra_info("socket")
            if raw_socket is None or not hasattr(socket, "SO_PEERCRED"):
                raise HostUnavailable("local-peer-credentials-unavailable")
            _, uid, _ = struct.unpack("3i", raw_socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != self.operator_uid or self._lock.locked():
                raise HostUnavailable("local-operator-denied-or-busy")
            async with self._lock:
                async with asyncio.timeout(self.timeout):
                    length = int.from_bytes(await reader.readexactly(4), "big")
                    if not 0 < length <= MAX_REQUEST:
                        raise HostUnavailable("native-admin-request-bound")
                    raw = await reader.readexactly(length)
                value = canonical_object(self.host.contracts, raw, MAX_REQUEST)
                # No timeout cancellation around native mutation: the host joins
                # it and audit/journal durable state remains the source of truth.
                result = await self._dispatch(value)
                response = self.host.contracts.encode({"status": "completed", "result": result})
        except BaseException:
            response = self.host.contracts.encode({"status": "unknown", "reason": "native-request-unavailable-or-denied"})
        try:
            writer.write(len(response).to_bytes(4, "big") + response)
            await asyncio.wait_for(writer.drain(), timeout=self.timeout)
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            try:
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=self.timeout)
            except (Exception, asyncio.CancelledError):
                pass
            finally:
                self._clients.discard(task)

    async def _dispatch(self, value: dict[str, Any]) -> dict[str, Any]:
        if value.get("format") != "vertex-native-admin-request-v1":
            raise HostUnavailable("unsupported-native-admin-request")
        operation = value.get("operation")
        if operation == "prepare-epoch-transition":
            if (set(value) != {"format", "operation", "snapshotId", "maxAgeMs"}
                    or type(value["maxAgeMs"]) is not int or not 1 <= value["maxAgeMs"] <= 86_400_000):
                raise HostUnavailable("exact-epoch-preparation-request-required")
            return await self.host.prepare_epoch_approval(snapshot_id=value["snapshotId"], max_age_ms=value["maxAgeMs"])
        if operation == "commit-epoch-transition":
            if set(value) != {"format", "operation", "approvalId", "transitionId", "signedApprovalBase64"}:
                raise HostUnavailable("exact-epoch-commit-request-required")
            signed = base64.b64decode(value["signedApprovalBase64"], validate=True)
            await self.host.commit_epoch_approval(signed_bytes=signed, approval_id=value["approvalId"],
                                                  transition_id=value["transitionId"])
            return {"operation": operation, "riskRearmed": False, "brokerSubmissionAllowed": False}
        if operation == "prepare-outbox-replay":
            if set(value) != {"format", "operation", "grantId", "expiresAt"}:
                raise HostUnavailable("exact-native-replay-preparation-required")
            return await self.host.prepare_replay_approval(grant_id=value["grantId"], expires_at=value["expiresAt"])
        if operation in ("commit-outbox-replay", "retry-outbox-replay"):
            expected = {"format", "operation", "grantId"}
            if operation == "commit-outbox-replay":
                expected.add("signedApprovalBase64")
            if set(value) != expected:
                raise HostUnavailable("exact-native-replay-commit-required")
            signed = None
            if operation == "commit-outbox-replay":
                signed = base64.b64decode(value["signedApprovalBase64"], validate=True)
                if base64.b64encode(signed).decode("ascii") != value["signedApprovalBase64"]:
                    raise HostUnavailable("canonical-native-signature-required")
            return await self.host.commit_replay_approval(signed_bytes=signed, grant_id=value["grantId"])
        if operation == "run-offline-native-capture":
            if set(value) != {"format", "operation"}:
                raise HostUnavailable("exact-native-capture-request-required")
            await self.host.run_native_capture()
            return {"operation": operation, "newRiskAuthorized": False, "brokerSubmissionAllowed": False}
        if operation == "apply-approval":
            if set(value) != {"format", "operation", "signedApprovalBase64", "subjectKind", "subject", "seedObservation"}:
                raise HostUnavailable("exact-native-approval-request-required")
            signed = base64.b64decode(value["signedApprovalBase64"], validate=True)
            subject = typed_subject(value["subjectKind"], value["subject"])
            seed = None if value["seedObservation"] is None else typed_subject("observation", value["seedObservation"])
            await self.host.apply_native_approval(signed_bytes=signed, subject=subject, seed_observation=seed)
            return {"operation": operation, "brokerSubmissionAllowed": False}
        if operation == "record-checkpoint":
            if set(value) != {"format", "operation", "snapshotId", "maxAgeMs", "genesis"} or type(value["genesis"]) is not bool or type(value["maxAgeMs"]) is not int or not 1 <= value["maxAgeMs"] <= 86_400_000:
                raise HostUnavailable("exact-native-checkpoint-request-required")
            await self.host.record_native_checkpoint(snapshot_id=value["snapshotId"], max_age_ms=value["maxAgeMs"], genesis=value["genesis"])
            return {"operation": operation, "riskRearmed": False}
        if operation == "status":
            if set(value) != {"format", "operation"}:
                raise HostUnavailable("exact-native-status-request-required")
            owner = self.host.owner
            return {"available": owner is not None, "ownerEpoch": None if owner is None else str(owner.epoch),
                    "paused": True if owner is None else owner.journal.state["pausedNewRisk"],
                    "journalIdentity": self.host.config["journalIdentity"], "brokerSubmissionAllowed": False}
        raise HostUnavailable("unsupported-native-admin-operation")

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            await asyncio.gather(*self._clients, return_exceptions=True)
            info = self.path.lstat()
            if info.st_ino != self.inode or not stat.S_ISSOCK(info.st_mode):
                raise HostUnavailable("native-admin-socket-identity-changed")
            self.path.unlink()
            self.server = None


async def request_local(*, socket_path: str, expected_server_uid: int, request: dict[str, Any],
                        authority: Any, timeout_seconds: int = 30) -> dict[str, Any]:
    """One explicit local request, no retry, key discovery or automatic approval."""
    if type(expected_server_uid) is not int or expected_server_uid < 0 or not 1 <= timeout_seconds <= 60:
        raise HostUnavailable("explicit-local-server-identity-required")
    path = Path(socket_path)
    if not path.is_absolute() or path.parent.resolve() != path.parent:
        raise HostUnavailable("absolute-local-admin-socket-required")
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != expected_server_uid or stat.S_IMODE(info.st_mode) != 0o600:
        raise HostUnavailable("local-admin-socket-identity-mismatch")
    raw = authority.encode(request)
    if not 0 < len(raw) <= MAX_REQUEST:
        raise HostUnavailable("native-admin-request-bound")
    async with asyncio.timeout(timeout_seconds):
        reader, writer = await asyncio.open_unix_connection(path=path, limit=MAX_REQUEST + 1)
        try:
            selected = writer.get_extra_info("socket")
            if selected is None:
                raise HostUnavailable("local-admin-peer-unavailable")
            _, uid, _ = struct.unpack("3i", selected.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != expected_server_uid:
                raise HostUnavailable("local-admin-peer-identity-mismatch")
            writer.write(len(raw).to_bytes(4, "big") + raw)
            await writer.drain()
            length = int.from_bytes(await reader.readexactly(4), "big")
            if not 0 < length <= MAX_REQUEST:
                raise HostUnavailable("native-admin-response-bound")
            return canonical_object(authority, await reader.readexactly(length), MAX_REQUEST)
        finally:
            writer.close()
            await writer.wait_closed()
