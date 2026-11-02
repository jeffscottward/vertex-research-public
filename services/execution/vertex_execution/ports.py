"""Internal execution ports. None is a public schema or broker authority grant.

All dependencies are explicitly injected. Native ContractAuthority is the only
public validation/codec authority; the owner never accepts a PortfolioSnapshot
as cash, shares, positions, readiness or permission.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol


class ExecutionError(RuntimeError):
    pass


class ContractAuthority(Protocol):
    def validate(self, contract_name: str, payload: Any, schema_version: str = "1.0.0") -> bool: ...
    def validate_native_journal_proof(self, projection: Any, proof_bytes: bytes,
                                      schema_version: str = "1.0.0") -> bool: ...
    def encode(self, value: Any) -> bytes: ...
    def digest(self, value: Any) -> str: ...
    def epoch_ns(self, timestamp: str) -> int: ...


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    contract_name: str
    sha256: str
    canonical_bytes: bytes


class ArtifactPort(Protocol):
    """Local immutable sealed input cache. Never resolve 'latest' or do IO in assess."""
    def get(self, artifact_id: str) -> Artifact: ...


@dataclass(frozen=True)
class RiskPlan:
    intent_sha256: str
    strategy_artifact_id: str
    ledger_sequence: int
    ledger_sha256: str
    policy_version: str
    cash_reserve: str
    share_reserve: tuple[tuple[str, str], ...]
    maximum_loss: str
    maximum_notional: str
    # Full immutable simulator command preparation and qualification lineage.
    command_bytes: bytes
    # One exact maximum quantity and direction per qualified leg, no netting.
    legs: tuple[tuple[str, str, str], ...]
    # Collateral remains locked after terminal fills until settlement evidence.
    settlement_required: bool
    valid_until_ns: int
    # Native internal Reservation DTO (Greek intervals, sleeve, notionals). It is
    # persisted intact for the next kernel assessment, not a public projection.
    kernel_reservation_bytes: bytes = b""
    batch_evidence_bytes: bytes = b""


class RiskPort(Protocol):
    """Synchronous deterministic native kernel only: no IO, callbacks or models.

    Input ledger is a private immutable copy of the replayed local journal.
    Implementations must requalify all legs, costs and current evidence. Returning
    a plan means every check passed; unknown or unsupported policies raise.
    """
    def assess(self, *, intent: Mapping[str, Any], admission: Mapping[str, Any],
               strategy: Mapping[str, Any], ledger: Mapping[str, Any],
               ledger_sequence: int, ledger_sha256: str, now_ns: int) -> RiskPlan: ...
    def assess_batch(self, *, batch_submission_key: str, intents: tuple[Mapping[str, Any], ...],
                     admissions: tuple[Mapping[str, Any], ...], strategy: Mapping[str, Any],
                     ledger: Mapping[str, Any], ledger_sequence: int, ledger_sha256: str, now_ns: int) -> RiskPlan: ...


class AdmissionAuthorityPort(Protocol):
    """Verify current accepted review, actor role/revocation and immutable grants.

    This is a preloaded local trusted authorization snapshot, not cloud IO.
    Native validation alone is not authentication or authorization.
    """
    def permits(self, *, admission: Mapping[str, Any], review: Mapping[str, Any],
                now_ns: int) -> bool: ...


@dataclass(frozen=True)
class PortfolioObservation:
    observation_id: str
    account_alias: str
    environment: str
    simulator_id: str
    source_sequence: int
    observed_ns: int
    received_ns: int
    valid_until_ns: int
    currency: str
    cash: str
    positions: tuple[tuple[str, str], ...]
    evidence_sha256: str
    # Authoritative journal state this trusted observation reconciles, not a
    # cloud portfolio sequence. Initial seed binds the already-claimed epoch head.
    journal_sequence: int
    journal_sha256: str
    seed_policy_artifact_id: str | None = None
    seed_policy_sha256: str | None = None


class ObservationAuthorityPort(Protocol):
    """First observation additionally verifies the explicit approved SIMULATION
    capital policy and human approval/revocation. Later observations reconcile
    owned balances and cannot reset paper capital. No public snapshot authority.
    """
    def verify(self, observation: PortfolioObservation, *, now_ns: int) -> bool: ...


@dataclass(frozen=True)
class MutationGrant:
    grant_id: str
    action: str  # cancel-simulation, request-liquidation, reset-new-risk
    account_alias: str
    environment: str
    owner_epoch: int
    submission_key: str | None
    actor_id: str
    issued_ns: int
    expires_ns: int
    evidence_sha256: str


class MutationAuthorityPort(Protocol):
    def verify(self, grant: MutationGrant, *, now_ns: int) -> bool: ...


@dataclass(frozen=True)
class PaperEvent:
    event_id: str
    submission_key: str
    payload_sha256: str
    kind: str  # accepted, fill, cancelled, rejected, unknown
    occurred_ns: int
    order_ref: str | None = None
    fill_id: str | None = None
    instrument_id: str | None = None
    quantity: str | None = None
    cash_delta: str | None = None
    fee: str | None = None
    # Cash delta is signed, includes price*multiplier, excludes fee.
    # Trusted simulator bridge verifies it against qualified command + fill.
    evidence_sha256: str | None = None


@dataclass(frozen=True)
class Reconciliation:
    submission_key: str
    payload_sha256: str
    events: tuple[PaperEvent, ...]
    status: str
    cumulative_fills: tuple[tuple[str, str], ...]
    terminal: bool
    finality_proven: bool
    final_event_ids: tuple[str, ...]
    source_evidence_sha256: str
    # Empty/new simulator state can NEVER establish a definitely-not-submitted
    # result for a pre-crash dispatch marker.
    recovered_state_proven: bool


class PaperTransportPort(Protocol):
    simulation_only: bool
    broker_submission_allowed: bool
    def submit(self, submission_key: str, payload_sha256: str, command_bytes: bytes,
               *, now_ns: int) -> tuple[PaperEvent, ...]: ...
    def cancel(self, submission_key: str, grant: MutationGrant,
               *, now_ns: int) -> tuple[PaperEvent, ...]: ...
    def reconcile(self, submission_key: str, payload_sha256: str,
                  *, now_ns: int) -> Reconciliation: ...


class ProjectionPort(Protocol):
    async def publish(self, canonical_projection: bytes, *, event_hash: str) -> str:
        """Return exact acknowledged hash. Duplicate identical hashes succeed."""
        ...
    async def publish_portfolio_genesis(self, canonical_snapshot: bytes, *, source_hash: str) -> str:
        """Separate native-emitter-authorized observation port, never cash authority."""
        ...
    async def publish_portfolio_snapshot(self, canonical_snapshot: bytes, *, source_hash: str) -> str:
        """Publish current native checkpoint only after its referenced head is acknowledged."""
        ...
    async def publish_native_fact(self, canonical_projection: bytes, proof_bytes: bytes, *, event_hash: str) -> str:
        """Publish separately validated typed native fact/proof under emitter scope."""
        ...


class DisabledPaperTransport:
    simulation_only = True
    broker_submission_allowed = False

    def submit(self, *args: Any, **kwargs: Any) -> tuple[PaperEvent, ...]:
        raise ExecutionError("paper-simulator-not-injected")

    def cancel(self, *args: Any, **kwargs: Any) -> tuple[PaperEvent, ...]:
        raise ExecutionError("paper-simulator-not-injected")

    def reconcile(self, *args: Any, **kwargs: Any) -> Reconciliation:
        raise ExecutionError("paper-simulator-not-injected")
