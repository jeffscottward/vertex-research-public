"""Explicit, read-only gateway evidence and an irreversibly disabled dispatcher.

No host discovery, trust-on-first-use, login, subprocess, socket, browser, trading
or rearm capability is present. Private evidence envelopes below are not public
contracts. Public status validation/time semantics remain with the authority.
Import and construction perform no collection or database initialization.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
from threading import Lock
from typing import Any, Callable, Mapping, Protocol

from vertex_gateway.adapters import GatewayObservationService
from vertex_gateway.models import (
    Dimension, EvidenceState, GatewayProtocol, GatewayTarget, HostTrust,
    Observation, ObservationSnapshot, RecoveryBinding, RecoveryPhase, reference,
)
from vertex_gateway.ports import (
    DispatchDisposition, DispatchReceipt, HumanAdmission, PublicContractPort,
    SafetyLease,
)
from vertex_gateway.readiness import project_public_status


class GatewayHostUnavailable(RuntimeError):
    """Allowlisted failure; provider text and private source content never escape."""

    def __init__(self) -> None:
        super().__init__("gateway-host-unavailable")


def _digest(value: str) -> str:
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("gateway-evidence-digest-required")
    return value


def _ns(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("gateway-nonnegative-nanoseconds-required")
    return value


def _monotonic(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise GatewayHostUnavailable()
    return value


class GatewayHostClock(Protocol):
    def now_ns(self) -> int: ...

    def monotonic(self) -> float: ...


@dataclass(frozen=True)
class SelectedObservationSource:
    source_ref: str
    evidence_ref: str
    sha256: str
    dimensions: tuple[Dimension, ...]

    def __post_init__(self) -> None:
        reference(self.source_ref)
        reference(self.evidence_ref)
        _digest(self.sha256)
        if (type(self.dimensions) is not tuple or not self.dimensions
                or any(not isinstance(item, Dimension) for item in self.dimensions)
                or len(set(self.dimensions)) != len(self.dimensions)):
            raise ValueError("gateway-source-dimensions-required")


@dataclass(frozen=True)
class GatewayHostSelection:
    """One server-selected endpoint/session; references are never hostnames/keys."""

    target: GatewayTarget
    endpoint_ref: str
    generation_ref: str
    sources: tuple[SelectedObservationSource, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.target, GatewayTarget):
            raise ValueError("gateway-target-required")
        reference(self.endpoint_ref)
        reference(self.generation_ref)
        if (type(self.sources) is not tuple or not self.sources or len(self.sources) > len(Dimension)
                or any(not isinstance(item, SelectedObservationSource) for item in self.sources)):
            raise ValueError("gateway-selected-sources-required")
        dimensions = tuple(dimension for source in self.sources for dimension in source.dimensions)
        if (len(set(dimensions)) != len(dimensions)
                or len({source.source_ref for source in self.sources}) != len(self.sources)
                or len({source.evidence_ref for source in self.sources}) != len(self.sources)):
            raise ValueError("gateway-selected-sources-ambiguous")


@dataclass(frozen=True)
class ObservationLimits:
    maximum_bytes: int
    timeout_seconds: float
    max_age_ns: int
    max_delivery_ns: int

    def __post_init__(self) -> None:
        if (type(self.maximum_bytes) is not int or not 0 < self.maximum_bytes <= 1_048_576
                or type(self.timeout_seconds) not in (int, float)
                or not math.isfinite(self.timeout_seconds) or not 0 < self.timeout_seconds <= 30
                or _ns(self.max_age_ns) == 0):
            raise ValueError("gateway-bounded-observation-policy-required")
        _ns(self.max_delivery_ns)


class BoundedHostObservationProvider(Protocol):
    """Trusted host provider for opaque, explicitly selected evidence references.

    Must resolve ONLY the supplied registry identity, read at most maximum_bytes,
    and enforce the absolute monotonic deadline while reading (not after an
    unbounded call). No discovery, mutation, login, retries or raw broker/account
    payloads. The result is a private sanitized metadata envelope, not a public
    schema. The adapter additionally checks exact original-byte SHA256, identity,
    source dimensions, chronology and its total deadline; it never retries.
    """

    def read_once(self, source_ref: str, *, endpoint_ref: str, target_digest: str,
                  generation_ref: str, maximum_bytes: int,
                  deadline_monotonic: float) -> bytes | None: ...


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-private-evidence-key")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("nonfinite-private-evidence")


def _envelope(raw: bytes, expected_digest: str, keys: frozenset[str], maximum_bytes: int) -> dict[str, Any]:
    if (type(raw) is not bytes or not 0 < len(raw) <= maximum_bytes
            or sha256(raw).hexdigest() != expected_digest):
        raise GatewayHostUnavailable()
    result = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                        parse_constant=_reject_constant)
    if type(result) is not dict or result.keys() != keys:
        raise GatewayHostUnavailable()
    return result


_OBSERVATION_KEYS = frozenset({
    "kind", "sourceRef", "evidenceRef", "endpointRef", "targetDigest", "gatewayId",
    "accountRef", "environment", "protocol", "generationRef", "observations",
})
_ROW_KEYS = frozenset({"dimension", "state", "observedNs", "receivedNs", "expiresNs"})


class HostObservationAdapter:
    def __init__(self, *, selection: GatewayHostSelection | None,
                 provider: BoundedHostObservationProvider | None,
                 clock: GatewayHostClock, limits: ObservationLimits) -> None:
        self._selection, self._provider = selection, provider
        self._clock, self._limits = clock, limits

    def collect(self, target: GatewayTarget) -> ObservationSnapshot:
        """One finite collection, no cache or earlier-evidence fallback."""
        try:
            selection, provider = self._selection, self._provider
            if selection is None or provider is None or target != selection.target:
                raise GatewayHostUnavailable()
            start = _monotonic(self._clock.monotonic())
            deadline = start + self._limits.timeout_seconds
            previous = start
            rows: list[Observation] = []
            for source in selection.sources:
                before = _monotonic(self._clock.monotonic())
                if not previous <= before < deadline:
                    raise GatewayHostUnavailable()
                raw = provider.read_once(
                    source.source_ref, endpoint_ref=selection.endpoint_ref,
                    target_digest=target.digest, generation_ref=selection.generation_ref,
                    maximum_bytes=self._limits.maximum_bytes, deadline_monotonic=deadline,
                )
                after = _monotonic(self._clock.monotonic())
                if not before <= after < deadline:
                    raise GatewayHostUnavailable()
                previous = after
                value = _envelope(raw, source.sha256, _OBSERVATION_KEYS, self._limits.maximum_bytes)
                expected = {
                    "kind": "vertex-host-gateway-observation", "sourceRef": source.source_ref,
                    "evidenceRef": source.evidence_ref, "endpointRef": selection.endpoint_ref,
                    "targetDigest": target.digest, "gatewayId": target.gateway_id,
                    "accountRef": target.account_ref, "environment": target.environment.value,
                    "protocol": target.protocol.value, "generationRef": selection.generation_ref,
                }
                if any(value[key] != item for key, item in expected.items()):
                    raise GatewayHostUnavailable()
                observations = value["observations"]
                if type(observations) is not list or len(observations) != len(source.dimensions):
                    raise GatewayHostUnavailable()
                dimensions: set[Dimension] = set()
                for row in observations:
                    if type(row) is not dict or row.keys() != _ROW_KEYS:
                        raise GatewayHostUnavailable()
                    dimension, state = Dimension(row["dimension"]), EvidenceState(row["state"])
                    if dimension not in source.dimensions or dimension in dimensions:
                        raise GatewayHostUnavailable()
                    dimensions.add(dimension)
                    rows.append(Observation(
                        dimension, state, source.source_ref, source.evidence_ref,
                        _ns(row["observedNs"]), _ns(row["receivedNs"]), _ns(row["expiresNs"]),
                        target.account_ref, target.environment,
                    ))
            now = _ns(self._clock.now_ns())
            finish = _monotonic(self._clock.monotonic())
            if not after <= finish < deadline:
                raise GatewayHostUnavailable()
            for row in rows:
                if (not row.observed_ns <= row.received_ns <= now < row.expires_ns
                        or now - row.observed_ns > self._limits.max_age_ns
                        or row.received_ns - row.observed_ns > self._limits.max_delivery_ns):
                    raise GatewayHostUnavailable()
            return ObservationSnapshot(target, selection.generation_ref, tuple(rows))
        except Exception:
            raise GatewayHostUnavailable() from None


@dataclass(frozen=True)
class ReviewedHostTrustRecord:
    """Explicit review receipt binding original sanitized verifier evidence.

    This is injected by the host's reviewed registry, never by a public request.
    No fingerprint, endpoint address, credentials or raw provider page is stored.
    Expired/revoked reviews must be removed/replaced by the enclosing selection;
    no old record may be selected when the current review is rejected.
    """

    target_digest: str
    endpoint_ref: str
    evidence_ref: str
    sha256: str
    original_bytes: bytes = field(repr=False)
    reviewer_ref: str
    reviewed_ns: int
    expires_ns: int

    def __post_init__(self) -> None:
        _digest(self.target_digest)
        _digest(self.sha256)
        for value in (self.endpoint_ref, self.evidence_ref, self.reviewer_ref):
            reference(value)
        if (type(self.original_bytes) is not bytes or not 0 < len(self.original_bytes) <= 65_536
                or not _ns(self.reviewed_ns) < _ns(self.expires_ns)):
            raise ValueError("gateway-reviewed-trust-required")


_TRUST_KEYS = frozenset({
    "kind", "targetDigest", "endpointRef", "evidenceRef", "verifiedNs", "expiresNs",
    "state", "providerConsoleVerified", "pinnedHostVerified", "strictVerification", "tlsVerified",
})


class ReviewedHostTrustAdapter:
    def __init__(self, *, selection: GatewayHostSelection | None,
                 records: tuple[ReviewedHostTrustRecord, ...], clock: GatewayHostClock) -> None:
        if (type(records) is not tuple or len(records) > 64
                or any(not isinstance(record, ReviewedHostTrustRecord) for record in records)):
            raise ValueError("gateway-immutable-trust-records-required")
        self._selection, self._records, self._clock = selection, records, clock

    def inspect(self, target: GatewayTarget) -> HostTrust:
        try:
            selection = self._selection
            if selection is None or selection.target != target:
                raise GatewayHostUnavailable()
            # Ambiguity fails closed, including a fresh record beside a stale one.
            matches = tuple(record for record in self._records
                            if record.target_digest == target.digest
                            and record.endpoint_ref == selection.endpoint_ref)
            if len(matches) != 1:
                raise GatewayHostUnavailable()
            record = matches[0]
            value = _envelope(record.original_bytes, record.sha256, _TRUST_KEYS, 65_536)
            if (value["kind"] != "vertex-host-gateway-trust"
                    or value["targetDigest"] != target.digest
                    or value["endpointRef"] != selection.endpoint_ref
                    or value["evidenceRef"] != record.evidence_ref):
                raise GatewayHostUnavailable()
            verified, expiry = _ns(value["verifiedNs"]), _ns(value["expiresNs"])
            now = _ns(self._clock.now_ns())
            if not verified <= record.reviewed_ns <= now < min(expiry, record.expires_ns):
                raise GatewayHostUnavailable()
            flags = tuple(value[key] for key in (
                "providerConsoleVerified", "pinnedHostVerified", "strictVerification", "tlsVerified",
            ))
            if any(type(flag) is not bool for flag in flags):
                raise GatewayHostUnavailable()
            state = EvidenceState(value["state"])
            strict = all(flags[:3]) and (target.protocol is not GatewayProtocol.CLIENT_PORTAL_HTTP or flags[3])
            if state is EvidenceState.YES and not strict:
                raise GatewayHostUnavailable()
            return HostTrust(target.digest, state, record.evidence_ref, verified,
                             min(expiry, record.expires_ns), strict)
        except Exception:
            raise GatewayHostUnavailable() from None


class HostGatewayStatusAdapter:
    def __init__(self, *, selection: GatewayHostSelection | None,
                 observations: GatewayObservationService | None, contracts: PublicContractPort,
                 clock: GatewayHostClock, format_timestamp: Callable[[int], str] | None) -> None:
        self._selection, self._observations = selection, observations
        self._contracts, self._clock, self._format_timestamp = contracts, clock, format_timestamp

    def current(self, target: GatewayTarget) -> Mapping[str, Any]:
        try:
            selection = self._selection
            if (selection is None or selection.target != target or self._observations is None
                    or self._format_timestamp is None):
                raise GatewayHostUnavailable()
            started_ns = _ns(self._clock.now_ns())
            assessment = self._observations.observe(target)
            if (assessment.target != target or assessment.generation_ref != selection.generation_ref
                    or assessment.host_trust is EvidenceState.UNKNOWN
                    or not started_ns <= _ns(assessment.assessed_ns) <= _ns(self._clock.now_ns())):
                raise GatewayHostUnavailable()
            selected_evidence = {dimension: source.evidence_ref for source in selection.sources
                                 for dimension in source.dimensions}
            if (len(assessment.dimensions) != len(Dimension)
                    or {row.dimension for row in assessment.dimensions} != set(Dimension)
                    or any(row.evidence_ref is not None
                           and row.evidence_ref != selected_evidence.get(row.dimension)
                           for row in assessment.dimensions)):
                raise GatewayHostUnavailable()
            # Revision is stable for the same selected evidence and assessment;
            # merely asking again cannot invalidate a human's expectedStatusId.
            # New bytes, session generation, trust/dimension states or reason codes
            # produce a different revision. There is no status cache/fallback.
            revision = [target.digest, selection.endpoint_ref, selection.generation_ref,
                        [(source.source_ref, source.sha256) for source in selection.sources],
                        assessment.host_trust.value, assessment.read_only_ready.value,
                        [(row.dimension.value, row.state.value, row.reason, row.evidence_ref)
                         for row in assessment.dimensions], list(assessment.reason_codes)]
            status_id = "status-" + sha256(json.dumps(revision, separators=(",", ":")).encode()).hexdigest()
            return project_public_status(
                self._contracts, assessment, status_id=status_id,
                observed_at=self._format_timestamp(assessment.assessed_ns),
                recovery_phase=RecoveryPhase.BLOCKED,
            )
        except Exception:
            raise GatewayHostUnavailable() from None


class ActiveRecoveryGuard(Protocol):
    """The actual execution owner, not lease.permits alone or cloud assertion."""

    def lease_valid(self, binding: RecoveryBinding, lease: SafetyLease) -> bool: ...


class DisabledRecoveryClaims(Protocol):
    """Atomic durable consumption. Literal True means a NEW committed claim.

    Reject every replay of request/idempotency/challenge/attempt/guard, including
    changed content. Persist the FULL binding/admission/lease hash, not only the
    shorter binding.digest. Exceptions/uncertain commits must not be retried.
    This consumes a disabled handoff only; it grants no execution authority.
    """

    def consume_once(self, binding: RecoveryBinding, admission: HumanAdmission,
                     lease: SafetyLease, *, now_ns: int) -> bool: ...


def _valid_disabled_claim(binding: RecoveryBinding, admission: HumanAdmission,
                          lease: SafetyLease, now: int) -> bool:
    if (not isinstance(binding, RecoveryBinding) or not isinstance(admission, HumanAdmission)
            or not isinstance(lease, SafetyLease)):
        return False
    try:
        reference(admission.attempt_ref)
        reference(lease.guard_ref)
        for value in (now, binding.confirmed_ns, binding.requested_ns, binding.expires_ns,
                      admission.authenticated_ns, admission.challenge_verified_ns, admission.expires_ns,
                      lease.expires_ns):
            _ns(value)
        return (binding.confirmed_ns <= binding.requested_ns <= now < binding.expires_ns
                and now - binding.confirmed_ns <= 300_000_000_000
                and binding.expires_ns - binding.confirmed_ns <= 300_000_000_000
                and admission.binding_digest == binding.digest
                and admission.human_verified is EvidenceState.YES
                and admission.durable_claim is EvidenceState.YES
                and admission.challenge_verified_ns == binding.confirmed_ns
                and 0 <= now - admission.authenticated_ns <= 300_000_000_000
                and now < admission.expires_ns <= binding.expires_ns
                and lease.permits(binding, now))
    except Exception:
        return False


def _claim_hash(binding: RecoveryBinding, admission: HumanAdmission, lease: SafetyLease) -> str:
    # A private consumption key, NOT a replacement for public canonical JSON.
    fields = [
        "vertex-disabled-recovery-v1", binding.target.gateway_id, binding.target.account_ref,
        binding.target.environment.value, binding.target.protocol.value, binding.operation.value,
        binding.request_id, binding.idempotency_key, binding.expected_status_id, binding.actor_id,
        binding.challenge_id, binding.requested_ns, binding.confirmed_ns, binding.expires_ns,
        binding.request_digest, binding.digest, admission.attempt_ref, admission.binding_digest,
        admission.authenticated_ns, admission.challenge_verified_ns, admission.expires_ns,
        admission.human_verified.value, admission.durable_claim.value, lease.guard_ref,
        lease.binding_digest, lease.expires_ns, lease.owner_fenced.value, lease.new_risk_paused.value,
        lease.submission_journal_reconciled.value, lease.no_inflight_mutations.value,
        lease.protection_continuity_proven.value, lease.disruption_safe.value,
    ]
    return sha256(json.dumps(fields, separators=(",", ":")).encode()).hexdigest()


class SQLiteDisabledRecoveryClaims:
    """Dedicated private local ledger. Not the execution journal/control store.

    open() is the only initialization operation. It requires an explicit absolute
    path in an existing private owner directory. No directories are created, no
    migrations of unrelated databases occur, and no rows are deleted/rearmed.
    Claims contain only hashes and timestamps; never actor/account/raw requests.
    """

    _APPLICATION_ID = 0x56524443
    _OPEN_TOKEN = object()
    _SCHEMA = (
        "CREATE TABLE disabled_claims ("
        "full_hash TEXT PRIMARY KEY NOT NULL,"
        "request_hash TEXT UNIQUE NOT NULL,"
        "idempotency_hash TEXT UNIQUE NOT NULL,"
        "challenge_hash TEXT UNIQUE NOT NULL,"
        "attempt_hash TEXT UNIQUE NOT NULL,"
        "guard_hash TEXT UNIQUE NOT NULL,"
        "binding_hash TEXT NOT NULL,"
        "consumed_ns TEXT NOT NULL,"
        "disposition TEXT NOT NULL CHECK (disposition = 'disabled-not-attempted'))"
    )

    def __init__(self, connection: sqlite3.Connection, *, _opened: object) -> None:
        if _opened is not self._OPEN_TOKEN:
            raise GatewayHostUnavailable()
        self._connection, self._lock = connection, Lock()

    @classmethod
    def _check_schema(cls, connection: sqlite3.Connection, *, empty_ok: bool = False) -> bool:
        application_id = connection.execute("PRAGMA application_id").fetchone()[0]
        objects = set(connection.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall())
        if empty_ok and application_id == 0 and not objects:
            return False
        expected = {("table", "disabled_claims", "disabled_claims", cls._SCHEMA)}
        expected.update(("index", f"sqlite_autoindex_disabled_claims_{index}", "disabled_claims", None)
                        for index in range(1, 7))
        if application_id != cls._APPLICATION_ID or objects != expected:
            raise GatewayHostUnavailable()
        return True

    @classmethod
    def open(cls, path: str | Path) -> SQLiteDisabledRecoveryClaims:
        connection = None
        try:
            selected = Path(path)
            if not selected.is_absolute() or selected.name in ("", ".", ".."):
                raise GatewayHostUnavailable()
            if selected.parent.resolve(strict=True) != selected.parent:
                raise GatewayHostUnavailable()
            parent = selected.parent.stat()
            if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077:
                raise GatewayHostUnavailable()
            flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC
            descriptor = os.open(selected, flags, 0o600)
            try:
                metadata = os.fstat(descriptor)
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                        or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600):
                    raise GatewayHostUnavailable()
                identity = (metadata.st_dev, metadata.st_ino)
            finally:
                os.close(descriptor)
            connection = sqlite3.connect(selected.as_uri() + "?mode=rw", uri=True,
                                         timeout=1.0, isolation_level=None, check_same_thread=False)
            metadata = selected.lstat()
            if not stat.S_ISREG(metadata.st_mode) or identity != (metadata.st_dev, metadata.st_ino):
                raise GatewayHostUnavailable()
            cls._check_schema(connection, empty_ok=True)
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("BEGIN IMMEDIATE")
            try:
                if not cls._check_schema(connection, empty_ok=True):
                    connection.execute(cls._SCHEMA)
                    connection.execute(f"PRAGMA application_id={cls._APPLICATION_ID}")
                cls._check_schema(connection)
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
            return cls(connection, _opened=cls._OPEN_TOKEN)
        except Exception:
            if connection is not None:
                connection.close()
            raise GatewayHostUnavailable() from None

    def consume_once(self, binding: RecoveryBinding, admission: HumanAdmission,
                     lease: SafetyLease, *, now_ns: int) -> bool:
        if not _valid_disabled_claim(binding, admission, lease, now_ns):
            return False
        try:
            hashes = tuple(sha256(value.encode()).hexdigest() for value in (
                binding.request_id, binding.idempotency_key, binding.challenge_id,
                admission.attempt_ref, lease.guard_ref,
            ))
            with self._lock:
                self._connection.execute("BEGIN IMMEDIATE")
                try:
                    self._check_schema(self._connection)
                    self._connection.execute(
                        "INSERT INTO disabled_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (_claim_hash(binding, admission, lease), *hashes, binding.digest,
                         str(now_ns), "disabled-not-attempted"),
                    )
                    self._connection.execute("COMMIT")
                    return True
                except sqlite3.IntegrityError:
                    self._connection.execute("ROLLBACK")
                    return False
                except Exception:
                    self._connection.execute("ROLLBACK")
                    raise
        except Exception:
            # Commit uncertainty is never converted to a definitely-unused claim.
            raise GatewayHostUnavailable() from None

    def close(self) -> None:
        with self._lock:
            self._connection.close()


class DisabledHumanRecoveryExecutor:
    """Consumes a valid one-time request, but NEVER dispatches any real action.

    There is deliberately no enable flag, action callback, transport or rearm
    method. Unknown/unavailable/duplicate claims do not claim successful consume.
    A successful receipt proves only durable consumption plus NO attempted action.
    """

    def __init__(self, *, clock: GatewayHostClock, claims: DisabledRecoveryClaims | None = None,
                 guard: ActiveRecoveryGuard | None = None) -> None:
        self._clock, self._claims, self._guard = clock, claims, guard

    def dispatch_once(self, binding: RecoveryBinding, admission: HumanAdmission,
                      lease: SafetyLease) -> DispatchReceipt:
        if not isinstance(binding, RecoveryBinding) or not isinstance(admission, HumanAdmission):
            raise GatewayHostUnavailable()
        try:
            attempt_ref = reference(admission.attempt_ref)
            binding_digest = _digest(binding.digest)
        except Exception:
            raise GatewayHostUnavailable() from None
        disposition = DispatchDisposition.UNKNOWN
        try:
            now = _ns(self._clock.now_ns())
            if (self._claims is not None and self._guard is not None
                    and _valid_disabled_claim(binding, admission, lease, now)
                    and self._guard.lease_valid(binding, lease) is True):
                # Recheck trusted time after guard inspection. The store binds the
                # exact request/admission/live guard, not merely binding.digest.
                now = _ns(self._clock.now_ns())
                if (_valid_disabled_claim(binding, admission, lease, now)
                        and self._claims.consume_once(binding, admission, lease, now_ns=now) is True):
                    disposition = DispatchDisposition.DEFINITELY_NOT_ATTEMPTED
        except Exception:
            disposition = DispatchDisposition.UNKNOWN
        return DispatchReceipt(attempt_ref, binding_digest, disposition)
