"""Independent offline Ed25519 native approvals, never worker-token authority.

No key generation, signing, discovery, remote IO, file opening or crypto backend
loading occurs at import/construction. Explicit open uses a separate approval
SQLite ledger, never the execution journal or a spendable cash balance. Parent
must independently enroll keys/policy and supply a local current owner epoch.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
from types import MappingProxyType
from typing import Any, Callable

from vertex_execution.capital import SimulationCapitalPolicy
from vertex_execution.exact import units
from vertex_execution.ports import MutationGrant, PortfolioObservation

CRYPTOGRAPHY_VERSION = "46.0.3"  # Exact proposal, not an installation/verification claim.
MAX_SIGNED_BYTES = 1_048_576
MAX_APPROVAL_BYTES = 16_384
MAX_APPROVALS = 100_000  # Never silently prune nonce history; fail when full.
_DOMAIN = b"vertex-native-approval-signature-v1\0"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", re.ASCII)
_HASH = re.compile(r"[0-9a-f]{64}", re.ASCII)
_NS = re.compile(r"0|[1-9][0-9]{0,18}", re.ASCII)
_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", re.ASCII)
_ACTIONS = frozenset({"seed-simulation", "observe-portfolio", "cancel-simulation", "request-liquidation", "reset-new-risk", "owner-epoch-transition", "native-outbox-replay"})
_MUTATIONS = frozenset({"cancel-simulation", "request-liquidation", "reset-new-risk"})
_COMMON = frozenset({"policyId", "policySha256", "policyVersion", "accountAlias", "environment", "simulatorId", "currency"})
_STATUS_FIELDS = _COMMON | {"format", "revision", "checkedNs", "expiresNs", "revokedKeyIds", "revokedApprovalIds", "revokedNonces"}
_APPROVAL_FIELDS = _COMMON | {"format", "approvalId", "nonce", "actorId", "ownerEpoch", "action", "issuedNs", "expiresNs", "subject"}


class NativeApprovalUnavailable(RuntimeError):
    """Sanitized fail-closed reason only; no signed content or signature in errors."""


def _require(condition: bool, code: str = "native-approval-invalid") -> None:
    if not condition:
        raise NativeApprovalUnavailable(code)


def _identifier(value: Any) -> str:
    _require(type(value) is str and _ID.fullmatch(value) is not None)
    return value


def _digest(value: Any) -> str:
    _require(type(value) is str and _HASH.fullmatch(value) is not None)
    return value


def _clock(value: Any) -> int:
    _require(type(value) is int and 0 <= value <= 9_223_372_036_854_775_807)
    return value


def _ns(value: Any) -> int:
    _require(type(value) is str and _NS.fullmatch(value) is not None)
    return _clock(int(value))


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    _require(len(dict(pairs)) == len(pairs), "duplicate-native-approval-key")
    return dict(pairs)


@dataclass(frozen=True, slots=True)
class EnrolledApproverKey:
    key_id: str
    actor_id: str
    public_key: bytes
    roles: tuple[str, ...]  # "approval" and/or "status"; independently enrolled.
    not_before_ns: int
    expires_ns: int

    def __post_init__(self) -> None:
        _identifier(self.key_id)
        _identifier(self.actor_id)
        _require(type(self.public_key) is bytes and len(self.public_key) == 32, "ed25519-public-key-required")
        _require(type(self.roles) is tuple and 1 <= len(self.roles) <= 2 and len(set(self.roles)) == len(self.roles)
                 and set(self.roles) <= {"approval", "status"}, "enrolled-key-role-required")
        _require(_clock(self.not_before_ns) < _clock(self.expires_ns), "enrolled-key-validity-required")


@dataclass(frozen=True, slots=True)
class NativeApprovalPolicy:
    policy_id: str
    policy_sha256: str
    policy_version: str
    account_alias: str
    simulator_id: str
    currency: str
    maximum_approval_ttl_ns: int
    maximum_status_age_ns: int

    def __post_init__(self) -> None:
        for value in (self.policy_id, self.account_alias, self.simulator_id):
            _identifier(value)
        _digest(self.policy_sha256)
        _require(type(self.policy_version) is str and len(self.policy_version) <= 64 and _VERSION.fullmatch(self.policy_version) is not None)
        _require(type(self.currency) is str and re.fullmatch(r"[A-Z]{3}", self.currency) is not None)
        _require(0 < _clock(self.maximum_approval_ttl_ns) <= 86_400_000_000_000)
        _require(0 < _clock(self.maximum_status_age_ns) <= 300_000_000_000)


@dataclass(frozen=True, slots=True)
class NativeApprovalScope:
    owner_epoch: int

    def __post_init__(self) -> None:
        _require(_clock(self.owner_epoch) > 0)


@dataclass(frozen=True, slots=True)
class NativeEpochTransition:
    """Exact reviewed restored-owner handoff, never a new capital seed.

    The parent compares these fields to the native journal, prior publication
    head and proposed new epoch snapshot. Signing/verification alone cannot
    establish that external state; it only authorizes this exact handoff once.
    """
    account_alias: str
    environment: str
    simulator_id: str
    stream_id: str
    journal_identity: str
    prior_owner_epoch: int
    current_owner_epoch: int
    prior_projection_sequence: int
    prior_projection_hash: str
    journal_sequence: int
    journal_head_sha256: str
    new_snapshot_sha256: str
    native_outbox_evidence_sha256: str
    native_owner_fence_sha256: str

    def __post_init__(self) -> None:
        for value in (self.account_alias, self.simulator_id, self.stream_id, self.journal_identity):
            _identifier(value)
        _require(self.environment == "paper")
        _require(0 < _clock(self.prior_owner_epoch) < _clock(self.current_owner_epoch))
        _require(_clock(self.prior_projection_sequence) > 0 and _clock(self.journal_sequence) > 0)
        for value in (self.prior_projection_hash, self.journal_head_sha256, self.new_snapshot_sha256,
                      self.native_outbox_evidence_sha256, self.native_owner_fence_sha256):
            _digest(value)


@dataclass(frozen=True, slots=True)
class NativeOutboxReplay:
    """Exact public grant binding, excluding ONLY approvalBase64.

    Unlike the private transition subject, replay hashes the authoritative
    public camelCase grant recipe. Original canonical bytes are immutable and
    remain the same across exact batch retries. No approval is synthesized.
    """
    grant_binding_bytes: bytes

    def __post_init__(self) -> None:
        _require(type(self.grant_binding_bytes) is bytes and 0 < len(self.grant_binding_bytes) <= 65_536,
                 "native-replay-binding-bound")

    @classmethod
    def from_grant(cls, grant: dict[str, Any], *, authority: Any) -> NativeOutboxReplay:
        _require(type(grant) is dict and authority.validate("NativeOutboxReplayGrant", grant) is True,
                 "native-replay-grant-validation-required")
        frozen = json.loads(authority.encode(grant))
        del frozen["approvalBase64"]
        return cls(authority.encode(frozen))

    def binding(self) -> dict[str, Any]:
        try:
            value = json.loads(self.grant_binding_bytes, object_pairs_hook=_object,
                               parse_constant=lambda _: (_ for _ in ()).throw(NativeApprovalUnavailable("nonfinite-replay")))
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise NativeApprovalUnavailable("native-replay-binding-invalid") from None
        _require(type(value) is dict and set(value) == {
            "schemaVersion", "grantId", "accountAlias", "environment", "streamId", "priorOwnerEpoch",
            "currentOwnerEpoch", "serviceActorId", "startingSequence", "startingEventHash",
            "journalIdentity", "journalSequence", "journalHeadSha256", "nativeJournalEvidenceSha256",
            "nativeOwnerFenceSha256", "retainedEpochTransitionSha256", "issuedAt", "expiresAt", "rows",
        }, "native-replay-exact-public-binding-required")
        _require(type(value["rows"]) is list and 1 <= len(value["rows"]) <= 64,
                 "native-replay-row-bound")
        # Required even on ordinary replay: explicit null is part of the signed
        # public binding. A retained historical signature never substitutes for
        # the current independently verified native-outbox-replay approval.
        if value["retainedEpochTransitionSha256"] is not None:
            _digest(value["retainedEpochTransitionSha256"])
        return value


def _wire(value: SimulationCapitalPolicy | PortfolioObservation | MutationGrant | NativeEpochTransition | NativeOutboxReplay) -> dict[str, Any]:
    """Private signed subject profile: exact dataclass names, integers as decimal
    strings (nanoseconds are beyond JS safe integer), tuple positions as arrays.
    No public contract is invented or used as a bearer authorization here.
    """
    if type(value) is NativeOutboxReplay:
        return value.binding()
    _require(type(value) in (SimulationCapitalPolicy, PortfolioObservation, MutationGrant, NativeEpochTransition))
    result: dict[str, Any] = {}
    for field in fields(value):
        item = getattr(value, field.name)
        if field.name.endswith(("_ns", "_epoch", "_sequence")):
            item = str(_clock(item))
        elif field.name == "positions":
            _require(type(item) is tuple and len(item) <= 10_000)
            _require(all(type(pair) is tuple and len(pair) == 2 and all(type(part) is str for part in pair) for pair in item))
            for instrument, amount in item:
                _identifier(instrument)
                _require(len(amount) <= 80)
                units(amount)
            item = [list(pair) for pair in item]
        elif type(item) is str:
            _require(len(item) <= 1024, "native-subject-string-bound")
        result[field.name] = item
    return result


def approval_subject(value: SimulationCapitalPolicy | PortfolioObservation | MutationGrant | NativeEpochTransition | NativeOutboxReplay, *,
                     authority: Any, seed_observation: PortfolioObservation | None = None) -> dict[str, Any]:
    """Canonical subject recipe for independently reviewed external signers.

    This only hashes exact proposed bytes. It does not sign, enroll or approve.
    A seed approval must include the exact future observation; no implicit amount
    or generated observation can be substituted after signing.
    """
    sha = hashlib.sha256(authority.encode(_wire(value))).hexdigest()
    if type(value) is NativeOutboxReplay:
        _require(seed_observation is None and authority.encode(value.binding()) == value.grant_binding_bytes,
                 "canonical-native-replay-binding-required")
        return {"replaySha256": sha}
    if type(value) is SimulationCapitalPolicy:
        _require(type(seed_observation) is PortfolioObservation, "exact-seed-observation-required")
        return {"capitalArtifactId": value.artifact_id, "capitalArtifactSha256": value.artifact_sha256,
                "capitalPolicySha256": sha, "amount": value.settled_cash, "currency": value.currency,
                "maximumObservationAgeNs": str(_clock(value.maximum_observation_age_ns)),
                "observationSha256": hashlib.sha256(authority.encode(_wire(seed_observation))).hexdigest()}
    _require(seed_observation is None)
    if type(value) is PortfolioObservation:
        return {"observationSha256": sha}
    if type(value) is NativeEpochTransition:
        return {"transitionSha256": sha}
    return {"grantSha256": sha, "submissionKey": value.submission_key}


class DisabledNativeApprovalAuthority:
    def verify(self, value: object, *, now_ns: int) -> bool:
        return False


class NativeApprovalAuthority:
    """Implements all three verify protocols, with current signed revocation.

    Seed policy verification PREPARES its approval idempotently, not consumes it.
    Its exact signed observation consumes the same nonce once. Mutation and later
    observation verifications consume directly once. A subsequent execution-
    journal append failure burns approval: no cross-database transaction or
    automatic retry is claimed. Recovery requires a distinct reviewed approval.
    """
    def __init__(self, *, authority: Any, policy: NativeApprovalPolicy,
                 keys: tuple[EnrolledApproverKey, ...], status_key_id: str,
                 owner_scope: Callable[[], NativeApprovalScope], audit_path: Path) -> None:
        _require(type(policy) is NativeApprovalPolicy and type(keys) is tuple and 1 <= len(keys) <= 64)
        _require(all(type(key) is EnrolledApproverKey for key in keys))
        _require(len({key.key_id for key in keys}) == len(keys) and len({key.public_key for key in keys}) == len(keys), "distinct-enrolled-keys-required")
        selected = {key.key_id: key for key in keys}
        _require(status_key_id in selected and "status" in selected[status_key_id].roles, "independent-status-key-required")
        _require(callable(owner_scope) and isinstance(audit_path, Path) and audit_path.is_absolute())
        self.authority, self.policy, self.keys = authority, policy, MappingProxyType(selected)
        self.status_key_id, self.owner_scope, self.path = status_key_id, owner_scope, audit_path
        self._mutex = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        self._pid: int | None = None
        self._key_type: Any = None
        self._invalid_signature: Any = None
        self._poisoned = False
        self._startup_mode: str | None = None
        self._status_file_pin: dict[str, str] | None = None

    @classmethod
    def from_config(cls, config: dict[str, Any], *, authority: Any,
                    owner_scope: Callable[[], NativeApprovalScope]) -> NativeApprovalAuthority:
        """Parse explicit private enrollment only; no files/keys are discovered.

        Public keys are supplied as canonical padded standard base64, not paths.
        open_configured(now_ns=...) is the separate consequential lifecycle step.
        No approval is installed, and no seed/reset/rearm is performed by either.
        """
        _require(type(config) is dict and set(config) == {
            "format", "auditPath", "startupMode", "statusFile", "statusKeyId", "keys", "policy",
        } and config["format"] == "vertex-native-approval-config-v1")
        _require(type(config["auditPath"]) is str and config["startupMode"] in ("initialize", "restore"))
        status_pin = config["statusFile"]
        _require(type(status_pin) is dict and set(status_pin) == {"path", "sha256"}
                 and type(status_pin["path"]) is str and Path(status_pin["path"]).is_absolute())
        _digest(status_pin["sha256"])
        value = config["policy"]
        _require(type(value) is dict and set(value) == {
            "policyId", "policySha256", "policyVersion", "accountAlias", "simulatorId", "currency",
            "maximumApprovalTtlNs", "maximumStatusAgeNs",
        })
        policy = NativeApprovalPolicy(value["policyId"], value["policySha256"], value["policyVersion"],
            value["accountAlias"], value["simulatorId"], value["currency"],
            _ns(value["maximumApprovalTtlNs"]), _ns(value["maximumStatusAgeNs"]))
        _require(type(config["keys"]) is list and 1 <= len(config["keys"]) <= 64)
        keys = []
        for item in config["keys"]:
            _require(type(item) is dict and set(item) == {
                "keyId", "actorId", "publicKeyBase64", "roles", "notBeforeNs", "expiresNs",
            })
            _require(type(item["publicKeyBase64"]) is str and len(item["publicKeyBase64"]) == 44
                     and type(item["roles"]) is list and all(type(role) is str for role in item["roles"]))
            try:
                raw = base64.b64decode(item["publicKeyBase64"], validate=True)
            except (binascii.Error, ValueError):
                raise NativeApprovalUnavailable("canonical-enrolled-public-key-required") from None
            _require(base64.b64encode(raw).decode("ascii") == item["publicKeyBase64"])
            keys.append(EnrolledApproverKey(item["keyId"], item["actorId"], raw, tuple(item["roles"]),
                        _ns(item["notBeforeNs"]), _ns(item["expiresNs"])))
        instance = cls(authority=authority, policy=policy, keys=tuple(keys), status_key_id=config["statusKeyId"],
                       owner_scope=owner_scope, audit_path=Path(config["auditPath"]))
        instance._startup_mode, instance._status_file_pin = config["startupMode"], dict(status_pin)
        return instance

    def open_configured(self, *, now_ns: int) -> None:
        """Explicitly open the configured audit ledger and install pinned status."""
        from .config import read_pinned
        _clock(now_ns)
        _require(self._startup_mode is not None and self._status_file_pin is not None,
                 "explicit-native-approval-config-required")
        # Read the already-reviewed status before creating a fresh ledger.
        raw = read_pinned(self._status_file_pin, MAX_SIGNED_BYTES)
        self.open(initialize=self._startup_mode == "initialize")
        try:
            self.install_status(raw, now_ns=now_ns)
        except BaseException:
            self.close()
            raise

    def _common(self) -> dict[str, Any]:
        p = self.policy
        return {"policyId": p.policy_id, "policySha256": p.policy_sha256, "policyVersion": p.policy_version,
                "accountAlias": p.account_alias, "environment": "paper", "simulatorId": p.simulator_id, "currency": p.currency}

    def _enrollment_digest(self) -> str:
        policy = {field.name: getattr(self.policy, field.name) for field in fields(self.policy)}
        for name in ("maximum_approval_ttl_ns", "maximum_status_age_ns"):
            policy[name] = str(policy[name])
        key_config = [{"keyId": key.key_id, "actorId": key.actor_id, "publicKeyHex": key.public_key.hex(),
                       "roles": sorted(key.roles), "notBeforeNs": str(key.not_before_ns), "expiresNs": str(key.expires_ns)}
                      for key in sorted(self.keys.values(), key=lambda k: k.key_id)]
        return hashlib.sha256(self.authority.encode({"policy": policy, "keys": key_config, "statusKeyId": self.status_key_id})).hexdigest()

    def open(self, *, initialize: bool) -> None:
        """Only explicit lifecycle operation opens SQLite and cryptography.

        initialize creates a NEW 0600 ledger only; restore requires an existing
        exact-enrollment ledger. No migration, overwrite, nonce pruning or policy
        rotation is automatic. Keep this separate from the execution journal.
        """
        with self._mutex:
            _require(type(initialize) is bool and self._connection is None, "approval-ledger-lifecycle-invalid")
            parent = self.path.parent
            _require(parent.resolve() == parent and parent.is_dir(), "private-approval-directory-required")
            info = parent.stat()
            _require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, "private-approval-directory-required")
            try:
                import cryptography
                from cryptography.exceptions import InvalidSignature
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
                _require(cryptography.__version__ == CRYPTOGRAPHY_VERSION, "reviewed-crypto-version-required")
                self._key_type, self._invalid_signature = Ed25519PublicKey, InvalidSignature
                flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
                if initialize:
                    flags |= os.O_CREAT | os.O_EXCL
                descriptor = os.open(self.path, flags, 0o600)
                try:
                    metadata = os.fstat(descriptor)
                    _require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid() and metadata.st_nlink == 1
                             and stat.S_IMODE(metadata.st_mode) == 0o600, "unsafe-approval-ledger")
                    for suffix in ("-journal", "-wal", "-shm"):
                        sidecar = Path(str(self.path) + suffix)
                        if sidecar.exists() or sidecar.is_symlink():
                            side = sidecar.lstat()
                            _require(stat.S_ISREG(side.st_mode) and side.st_uid == os.getuid() and side.st_nlink == 1
                                     and stat.S_IMODE(side.st_mode) & 0o077 == 0, "unsafe-approval-sidecar")
                    connection = sqlite3.connect(self.path.as_uri() + "?mode=rw", uri=True,
                                                 timeout=5, isolation_level=None, check_same_thread=False)
                    self._connection = connection
                    after = self.path.lstat()
                    _require((metadata.st_dev, metadata.st_ino) == (after.st_dev, after.st_ino), "approval-ledger-path-changed")
                finally:
                    os.close(descriptor)
                _require(connection.execute("PRAGMA journal_mode=DELETE").fetchone() == ("delete",),
                         "durable-native-approval-journal-required")
                connection.execute("PRAGMA synchronous=FULL")
                _require(connection.execute("PRAGMA synchronous").fetchone() == (2,),
                         "durable-native-approval-sync-required")
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA trusted_schema=OFF")
                if initialize:
                    connection.executescript("""
                        BEGIN IMMEDIATE;
                        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                        CREATE TABLE current_status (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                            revision TEXT NOT NULL, sha256 TEXT NOT NULL, signed BLOB NOT NULL);
                        CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL,
                            signed BLOB NOT NULL, sha256 TEXT NOT NULL, observation_sha TEXT UNIQUE,
                            transition_sha TEXT UNIQUE,
                            replay_sha TEXT UNIQUE,
                            state TEXT NOT NULL CHECK(state IN ('pending','prepared','consumed')));
                        CREATE TABLE audit (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                            approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
                            stage TEXT NOT NULL CHECK(stage IN ('installed','prepared','consumed')),
                            operation_sha256 TEXT NOT NULL, at_ns TEXT NOT NULL, status_revision TEXT NOT NULL,
                            UNIQUE(approval_id, stage));
                    """)
                    connection.execute("INSERT INTO metadata VALUES ('format','vertex-native-approval-ledger-v3')")
                    connection.execute("INSERT INTO metadata VALUES ('enrollment',?)", (self._enrollment_digest(),))
                    connection.execute("COMMIT")
                records = dict(connection.execute("SELECT key,value FROM metadata").fetchall())
                _require(records == {"format": "vertex-native-approval-ledger-v3", "enrollment": self._enrollment_digest()}, "approval-ledger-enrollment-mismatch")
                self._pid, self._poisoned = os.getpid(), False
                if initialize:
                    directory = os.open(parent, os.O_DIRECTORY | os.O_CLOEXEC)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
            except (ImportError, OSError, sqlite3.Error, ValueError):
                self.close()
                raise NativeApprovalUnavailable("native-approval-ledger-unavailable") from None
            except BaseException:
                self.close()
                raise

    def _db(self) -> sqlite3.Connection:
        _require(self._connection is not None and self._pid == os.getpid() and not self._poisoned,
                 "native-approval-ledger-unavailable")
        return self._connection

    def close(self) -> None:
        with self._mutex:
            if self._connection is not None:
                self._connection.close()
            self._connection, self._pid = None, None

    def _signed(self, raw: bytes, *, role: str, now_ns: int) -> tuple[dict[str, Any], EnrolledApproverKey]:
        limit = MAX_SIGNED_BYTES if role == "status" else MAX_APPROVAL_BYTES
        _require(type(raw) is bytes and 0 < len(raw) <= limit, "signed-native-approval-bound")
        try:
            document = json.loads(raw, object_pairs_hook=_object,
                                  parse_constant=lambda _: (_ for _ in ()).throw(NativeApprovalUnavailable("nonfinite-approval")))
            _require(type(document) is dict and set(document) == {"keyId", "payload", "signatureHex"})
            _require(self.authority.encode(document) == raw, "canonical-native-approval-required")
            key = self.keys.get(_identifier(document["keyId"]))
            _require(key is not None and role in key.roles and key.not_before_ns <= now_ns < key.expires_ns,
                     "enrolled-approver-unavailable")
            if role == "status":
                _require(key.key_id == self.status_key_id, "independent-status-key-required")
            signature = document["signatureHex"]
            _require(type(signature) is str and len(signature) == 128 and re.fullmatch(r"[0-9a-f]{128}", signature) is not None)
            payload = document["payload"]
            _require(type(payload) is dict)
            message = _DOMAIN + self.authority.encode({"keyId": key.key_id, "payload": payload})
            self._key_type.from_public_bytes(key.public_key).verify(bytes.fromhex(signature), message)
            _require(all(payload.get(name) == value for name, value in self._common().items()), "native-approval-scope-mismatch")
            return payload, key
        except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
            raise NativeApprovalUnavailable("signed-native-approval-invalid") from None
        except Exception as exc:
            if self._invalid_signature is not None and isinstance(exc, self._invalid_signature):
                raise NativeApprovalUnavailable("native-approval-signature-invalid") from None
            raise

    def _status(self, raw: bytes, now_ns: int) -> dict[str, Any]:
        payload, key = self._signed(raw, role="status", now_ns=now_ns)
        _require(set(payload) == _STATUS_FIELDS and payload["format"] == "vertex-native-approval-status-v1")
        _require(_ns(payload["revision"]) > 0)
        checked, expiry = _ns(payload["checkedNs"]), _ns(payload["expiresNs"])
        _require(key.not_before_ns <= checked <= now_ns < expiry <= key.expires_ns
                 and 0 < expiry - checked <= self.policy.maximum_status_age_ns, "native-approval-status-stale")
        for name in ("revokedKeyIds", "revokedApprovalIds", "revokedNonces"):
            values = payload[name]
            _require(type(values) is list and len(values) <= 10_000)
            for value in values:
                (_digest if name == "revokedNonces" else _identifier)(value)
            _require(values == sorted(set(values)), "canonical-revocation-set-required")
        _require(key.key_id not in payload["revokedKeyIds"], "status-signing-key-revoked")
        return payload

    def install_status(self, signed_canonical_bytes: bytes, *, now_ns: int) -> None:
        _clock(now_ns)
        with self._mutex:
            connection = self._db()
            payload = self._status(signed_canonical_bytes, now_ns)
            sha = hashlib.sha256(signed_canonical_bytes).hexdigest()
            try:
                connection.execute("BEGIN IMMEDIATE")
                old = connection.execute("SELECT revision,sha256 FROM current_status WHERE singleton=1").fetchone()
                if old is not None:
                    _require(_ns(payload["revision"]) > _ns(old[0]) or (payload["revision"] == old[0] and sha == old[1]),
                             "native-status-rollback-or-conflict")
                connection.execute("INSERT INTO current_status VALUES (1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,sha256=excluded.sha256,signed=excluded.signed",
                                   (payload["revision"], sha, signed_canonical_bytes))
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise

    def _current(self, connection: sqlite3.Connection, now_ns: int) -> dict[str, Any]:
        row = connection.execute("SELECT revision,sha256,signed FROM current_status WHERE singleton=1").fetchone()
        _require(row is not None, "current-native-revocation-required")
        _require(hashlib.sha256(row[2]).hexdigest() == row[1])
        value = self._status(row[2], now_ns)
        _require(value["revision"] == row[0])
        return value

    def _approval(self, raw: bytes, current: dict[str, Any], now_ns: int) -> dict[str, Any]:
        payload, key = self._signed(raw, role="approval", now_ns=now_ns)
        _require(set(payload) == _APPROVAL_FIELDS and payload["format"] == "vertex-native-approval-v1")
        _identifier(payload["approvalId"])
        _digest(payload["nonce"])
        _require(payload["actorId"] == key.actor_id and payload["action"] in _ACTIONS)
        scope = self.owner_scope()  # Trusted local owner only, never worker token/remote IO.
        _require(type(scope) is NativeApprovalScope and _ns(payload["ownerEpoch"]) == scope.owner_epoch,
                 "native-approval-owner-epoch-mismatch")
        issued, expiry = _ns(payload["issuedNs"]), _ns(payload["expiresNs"])
        _require(key.not_before_ns <= issued <= now_ns < expiry <= key.expires_ns
                 and 0 < expiry - issued <= self.policy.maximum_approval_ttl_ns, "native-approval-expired")
        _require(key.key_id not in current["revokedKeyIds"] and payload["approvalId"] not in current["revokedApprovalIds"]
                 and payload["nonce"] not in current["revokedNonces"], "native-approval-revoked")
        subject = payload["subject"]
        _require(type(subject) is dict)
        if payload["action"] == "seed-simulation":
            _require(set(subject) == {"capitalArtifactId", "capitalArtifactSha256", "capitalPolicySha256", "amount", "currency", "observationSha256", "maximumObservationAgeNs"})
            _identifier(subject["capitalArtifactId"])
            for name in ("capitalArtifactSha256", "capitalPolicySha256", "observationSha256"):
                _digest(subject[name])
            _require(type(subject["amount"]) is str and len(subject["amount"]) <= 80 and units(subject["amount"]) > 0
                     and subject["currency"] == self.policy.currency and _ns(subject["maximumObservationAgeNs"]) > 0)
        elif payload["action"] == "observe-portfolio":
            _require(set(subject) == {"observationSha256"})
            _digest(subject["observationSha256"])
        elif payload["action"] == "owner-epoch-transition":
            _require(set(subject) == {"transitionSha256"})
            _digest(subject["transitionSha256"])
        elif payload["action"] == "native-outbox-replay":
            _require(set(subject) == {"replaySha256"})
            _digest(subject["replaySha256"])
        else:
            _require(set(subject) == {"grantSha256", "submissionKey"})
            _digest(subject["grantSha256"])
            if payload["action"] == "cancel-simulation":
                _identifier(subject["submissionKey"])
            else:
                _require(subject["submissionKey"] is None)
        return payload

    def install_approval(self, signed_canonical_bytes: bytes, *, now_ns: int) -> None:
        _clock(now_ns)
        with self._mutex:
            connection = self._db()
            try:
                connection.execute("BEGIN IMMEDIATE")
                current = self._current(connection, now_ns)
                payload = self._approval(signed_canonical_bytes, current, now_ns)
                sha = hashlib.sha256(signed_canonical_bytes).hexdigest()
                old = connection.execute("SELECT sha256 FROM approvals WHERE approval_id=?", (payload["approvalId"],)).fetchone()
                if old is not None:
                    _require(old[0] == sha, "native-approval-id-conflict")
                else:
                    _require(connection.execute("SELECT COUNT(*) FROM approvals").fetchone()[0] < MAX_APPROVALS,
                             "native-approval-audit-capacity")
                    connection.execute("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,'pending')", (
                        payload["approvalId"], payload["nonce"], signed_canonical_bytes, sha,
                        payload["subject"].get("observationSha256"), payload["subject"].get("transitionSha256"),
                        payload["subject"].get("replaySha256"),
                    ))
                    connection.execute("INSERT INTO audit(approval_id,stage,operation_sha256,at_ns,status_revision) VALUES (?,'installed',?,?,?)",
                                       (payload["approvalId"], sha, str(now_ns), current["revision"]))
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise

    def installed_approval_bytes(self, approval_id: str) -> bytes:
        """Return exact original PUBLIC signed bytes, not proof of current rights.

        No key material or private signing inputs are stored. The control-side
        independent NativeOwnerGrant verifier must reverify signature, current
        policy/revocation, exact transition scope and its own once-only nonce.
        Retrieving consumed material is intentional for durable handoff replay;
        it neither resets native consumption nor authorizes another action.
        """
        with self._mutex:
            row = self._db().execute("SELECT signed,sha256 FROM approvals WHERE approval_id=?",
                                     (_identifier(approval_id),)).fetchone()
            _require(row is not None and type(row[0]) is bytes and len(row[0]) <= MAX_APPROVAL_BYTES
                     and hashlib.sha256(row[0]).hexdigest() == row[1], "native-approval-not-installed")
            return bytes(row[0])

    def _matches(self, payload: dict[str, Any], value: Any, operation_sha: str, state: str) -> str:
        """Returns prepared/consumed; every rejected match leaves audit untouched."""
        subject = payload["subject"]
        if type(value) is NativeOutboxReplay:
            binding = value.binding()
            _require(payload["action"] == "native-outbox-replay" and state in ("pending", "consumed")
                     and subject["replaySha256"] == operation_sha
                     and binding["grantId"] == payload["approvalId"]
                     and binding["accountAlias"] == self.policy.account_alias and binding["environment"] == "paper"
                     and binding["currentOwnerEpoch"] == payload["ownerEpoch"]
                     and 0 < _ns(binding["priorOwnerEpoch"]) < _ns(binding["currentOwnerEpoch"])
                     and self.authority.epoch_ns(binding["issuedAt"]) == _ns(payload["issuedNs"])
                     and self.authority.epoch_ns(binding["expiresAt"]) == _ns(payload["expiresNs"]))
            return "consumed"
        if type(value) is NativeEpochTransition:
            _require(payload["action"] == "owner-epoch-transition" and state == "pending"
                     and subject["transitionSha256"] == operation_sha
                     and value.account_alias == self.policy.account_alias and value.environment == "paper"
                     and value.simulator_id == self.policy.simulator_id
                     and str(value.current_owner_epoch) == payload["ownerEpoch"]
                     and 0 < value.prior_owner_epoch < value.current_owner_epoch)
            return "consumed"
        if type(value) is SimulationCapitalPolicy:
            _require(payload["action"] == "seed-simulation" and payload["approvalId"] == value.approval_id
                     and payload["actorId"] == value.actor_id and value.environment == "paper" and value.purpose == "SIMULATION"
                     and value.real_account_funds is False and value.broker_submission_allowed is False)
            _require(value.account_alias == self.policy.account_alias and value.simulator_id == self.policy.simulator_id
                     and value.currency == self.policy.currency and units(value.settled_cash) > 0
                     and _clock(value.maximum_observation_age_ns) > 0)
            _require(str(_clock(value.approved_ns)) == payload["issuedNs"] and str(_clock(value.expires_ns)) == payload["expiresNs"])
            _require(subject["capitalPolicySha256"] == operation_sha and subject["capitalArtifactId"] == value.artifact_id
                     and subject["capitalArtifactSha256"] == value.artifact_sha256
                     and subject["amount"] == value.settled_cash and subject["currency"] == value.currency
                     and subject["maximumObservationAgeNs"] == str(value.maximum_observation_age_ns))
            _require(state in ("pending", "prepared"), "native-approval-already-consumed")
            return "prepared"
        if type(value) is PortfolioObservation:
            _require(payload["action"] in ("seed-simulation", "observe-portfolio") and subject["observationSha256"] == operation_sha)
            _require(value.environment == "paper" and value.account_alias == self.policy.account_alias
                     and value.simulator_id == self.policy.simulator_id and value.currency == self.policy.currency)
            if payload["action"] == "seed-simulation":
                _require(state == "prepared", "capital-policy-preparation-required")
                _require(value.seed_policy_artifact_id == subject["capitalArtifactId"] and value.seed_policy_sha256 == subject["capitalArtifactSha256"]
                         and value.cash == subject["amount"] and value.positions == () and value.source_sequence == 1
                         and _ns(payload["issuedNs"]) <= value.observed_ns
                         and value.valid_until_ns <= value.observed_ns + _ns(subject["maximumObservationAgeNs"]))
            else:
                _require(state == "pending" and value.seed_policy_artifact_id is None and value.seed_policy_sha256 is None)
            _require(_clock(value.observed_ns) <= _clock(value.received_ns) < _clock(value.valid_until_ns)
                     and value.valid_until_ns <= _ns(payload["expiresNs"]))
            return "consumed"
        _require(type(value) is MutationGrant and payload["action"] in _MUTATIONS and state == "pending")
        _require(payload["action"] == value.action and payload["approvalId"] == value.grant_id and payload["actorId"] == value.actor_id
                 and value.account_alias == self.policy.account_alias and value.environment == "paper"
                 and str(_clock(value.owner_epoch)) == payload["ownerEpoch"] and subject["grantSha256"] == operation_sha
                 and subject["submissionKey"] == value.submission_key
                 and str(_clock(value.issued_ns)) == payload["issuedNs"] and str(_clock(value.expires_ns)) == payload["expiresNs"])
        return "consumed"

    def verify_consumed(self, grant: MutationGrant, *, now_ns: int) -> bool:
        """Read-only cancel transport handoff, NOT permission to repeat mutation.

        Only SimulatorMutationAuthority may use this after checking the exact
        durable original cancel-request journal marker. Normal owner verify()
        remains once-only. The full signed grant digest includes evidenceSha256,
        actor, scope, epoch, submission key and time bounds. No state is reset.
        """
        connection: sqlite3.Connection | None = None
        with self._mutex:
            try:
                _clock(now_ns)
                _require(type(grant) is MutationGrant and grant.action == "cancel-simulation"
                         and type(grant.submission_key) is str, "consumed-cancel-grant-required")
                operation_sha = hashlib.sha256(self.authority.encode(_wire(grant))).hexdigest()
                connection = self._db()
                # A deferred read transaction snapshots status+receipt together;
                # no approval state, audit row or native journal is written.
                connection.execute("BEGIN")
                current = self._current(connection, now_ns)
                row = connection.execute("SELECT signed,sha256,state FROM approvals WHERE approval_id=?",
                                         (_identifier(grant.grant_id),)).fetchone()
                _require(row is not None and row[2] == "consumed"
                         and hashlib.sha256(row[0]).hexdigest() == row[1], "consumed-cancel-approval-required")
                payload = self._approval(row[0], current, now_ns)
                # Reuse exact canonical scope binding, not the mutation consume
                # path. Passing pending here only selects binding checks; actual
                # persisted state was required consumed above and is untouched.
                _require(self._matches(payload, grant, operation_sha, "pending") == "consumed")
                receipt = connection.execute("SELECT operation_sha256 FROM audit WHERE approval_id=? AND stage='consumed'",
                                             (grant.grant_id,)).fetchone()
                _require(receipt == (operation_sha,), "consumed-cancel-receipt-required")
                connection.execute("COMMIT")
                return True
            except Exception:
                if connection is not None and connection.in_transaction:
                    try:
                        connection.execute("ROLLBACK")
                    except sqlite3.Error:
                        self._poisoned = True
                return False

    def verify(self, value: SimulationCapitalPolicy | PortfolioObservation | MutationGrant | NativeEpochTransition | NativeOutboxReplay, *, now_ns: int) -> bool:
        """Deny stale/wrong/spent input; exact replay receipts alone may retry."""
        connection: sqlite3.Connection | None = None
        with self._mutex:
            try:
                _clock(now_ns)
                operation_sha = hashlib.sha256(self.authority.encode(_wire(value))).hexdigest()
                if type(value) is NativeOutboxReplay:
                    _require(self.authority.encode(value.binding()) == value.grant_binding_bytes,
                             "canonical-native-replay-binding-required")
                connection = self._db()
                connection.execute("BEGIN IMMEDIATE")
                current = self._current(connection, now_ns)
                if type(value) is PortfolioObservation:
                    row = connection.execute("SELECT signed,sha256,state FROM approvals WHERE observation_sha=?", (operation_sha,)).fetchone()
                elif type(value) is NativeEpochTransition:
                    row = connection.execute("SELECT signed,sha256,state FROM approvals WHERE transition_sha=?", (operation_sha,)).fetchone()
                elif type(value) is NativeOutboxReplay:
                    row = connection.execute("SELECT signed,sha256,state FROM approvals WHERE replay_sha=?", (operation_sha,)).fetchone()
                else:
                    identifier = value.approval_id if type(value) is SimulationCapitalPolicy else value.grant_id
                    row = connection.execute("SELECT signed,sha256,state FROM approvals WHERE approval_id=?", (_identifier(identifier),)).fetchone()
                _require(row is not None and hashlib.sha256(row[0]).hexdigest() == row[1], "native-approval-not-installed")
                payload = self._approval(row[0], current, now_ns)
                if type(value) is NativeOutboxReplay:
                    grant = {**value.binding(), "approvalBase64": base64.b64encode(row[0]).decode("ascii")}
                    _require(self.authority.validate("NativeOutboxReplayGrant", grant) is True,
                             "native-replay-grant-validation-required")
                    if row[2] == "consumed":
                        receipt = connection.execute("SELECT operation_sha256 FROM audit WHERE approval_id=? AND stage='consumed'",
                                                     (payload["approvalId"],)).fetchone()
                        _require(receipt == (operation_sha,), "native-replay-consumed-receipt-required")
                stage = self._matches(payload, value, operation_sha, row[2])
                if type(value) is PortfolioObservation:
                    _require(value.received_ns <= now_ns < value.valid_until_ns)
                if row[2] != stage:
                    connection.execute("UPDATE approvals SET state=? WHERE approval_id=? AND state=?", (stage, payload["approvalId"], row[2]))
                    connection.execute("INSERT INTO audit(approval_id,stage,operation_sha256,at_ns,status_revision) VALUES (?,?,?,?,?)",
                                       (payload["approvalId"], stage, operation_sha, str(now_ns), current["revision"]))
                connection.execute("COMMIT")
                return True
            except Exception:
                if connection is not None and connection.in_transaction:
                    try:
                        connection.execute("ROLLBACK")
                    except sqlite3.Error:
                        self._poisoned = True
                return False
