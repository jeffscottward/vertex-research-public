"""Internal, read-only Nautilus evidence assessment; not a public wire schema.

Source authority: exact tagged releases and the user-selected rc5 target. Nothing
here imports Nautilus, discovers an installation, reads a report, connects to a
Gateway, verifies a receipt, or grants research/paper/live authority. A complete
assessment means supplied evidence covers this checklist, not runtime readiness.
Receipts must come from the separately trusted evidence boundary, never a model.
"""

from dataclasses import dataclass, field, fields
from enum import Enum
import re


class ReleaseLine(str, Enum):
    V1_BASELINE = "v1_baseline"
    V2_PRERELEASE = "v2_prerelease"
    UNKNOWN = "unknown"


class AssessmentStatus(str, Enum):
    UNKNOWN = "unknown"
    BLOCKED = "blocked"
    EVIDENCE_COMPLETE = "evidence_complete"


class EvidenceState(str, Enum):
    UNKNOWN = "unknown"
    PASS = "pass"
    FAIL = "fail"


class EvaluationScope(str, Enum):
    RESEARCH = "research"
    PAPER = "paper"
    LIVE = "live"


class AdapterSurface(str, Enum):
    UNKNOWN = "unknown"
    IN_TREE_IBKR = "in_tree_ibkr"
    V1_OUT_OF_TREE_FACTORIES = "v1_out_of_tree_factories"


class PersistenceBackend(str, Enum):
    UNKNOWN = "unknown"
    POSTGRESQL_CACHE = "postgresql_cache"
    OTHER = "other"


class EvidenceGate(str, Enum):
    ISOLATED_ENVIRONMENT = "isolated_environment"
    WHEEL_HOST_ABI = "wheel_host_abi"
    ADAPTER_API = "constructors_callbacks_serialization_adapters"
    GATEWAY_LIFECYCLE = "gateway_lifecycle_separate_from_client_construction"
    ORDERED_EVENTS = "ordered_event_parity"
    FINANCIAL_PARITY = "fills_cash_positions_pnl_parity"
    RESTART_RECONCILIATION = "restart_reconciliation"
    BROKER_PACING = "broker_pacing"
    OPTIONS_MULTI_LEG = "intended_options_multi_leg_behavior"
    LATENCY = "strategy_specific_latency"
    ROLLBACK = "rollback"
    PRERELEASE_EXCEPTION = "explicit_prerelease_exception"
    RC5_RELEASE_PARITY = "rc5_release_specific_parity"
    COPIED_DATA_MIGRATION = "copied_data_migration_preserving_authoritative_history"
    CORRECTED_VOIDED_FILLS = "corrected_voided_fill_migration"
    LEGACY_EVENT_RESTORATION = "order_released_order_fill_voided_restoration"
    V1_FACTORY_MIGRATION = "v1_factory_registration_migration"
    POSTGRES_STATE_RESTORATION = "actor_strategy_heartbeat_synthetic_restoration"


@dataclass(frozen=True, slots=True)
class SourceReference:
    path: str
    locator: str


SOURCE_REFERENCES = (
    SourceReference(
        "https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/pyproject.toml",
        "Exact rc5 Rust/PyO3 package and Python requirement; intended target, not installed evidence",
    ),
    SourceReference(
        "https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/MIGRATION_V2.md",
        "rc5 API and persistence migration; no v1 fallback",
    ),
    SourceReference("docs/vertex-rebuild/architecture-decisions.md", "ADR-V06"),
    SourceReference(
        "docs/vertex-rebuild/implementation-plan.md",
        "Authoritative decisions; Provider, configuration and release gates",
    ),
)


@dataclass(frozen=True, slots=True)
class ReleaseFacts:
    version: str
    line: ReleaseLine
    source_tag: str
    prerelease: bool
    implementation: str
    python_constraint: str | None
    rust_toolchain: str | None
    release_url: str
    migration_url: str | None
    distinctions: tuple[str, ...]
    source_refs: tuple[SourceReference, ...] = SOURCE_REFERENCES


V1_BASELINE = ReleaseFacts(
    version="1.231.0",
    line=ReleaseLine.V1_BASELINE,
    source_tag="v1.231.0",
    prerelease=False,
    implementation="Upstream Beta / legacy Cython; non-prerelease distribution",
    python_constraint=None,
    rust_toolchain=None,
    release_url="https://github.com/nautechsystems/nautilus_trader/releases/tag/v1.231.0",
    migration_url=None,
    distinctions=(
        "Historical comparison only, not the canonical engine or an automatic rollback/fallback.",
        "v1 out-of-tree Python data/execution factories have no equivalent v2 registration surface.",
        "Mutable latest documentation is not the v1 package contract.",
    ),
)
V2_RC5 = ReleaseFacts(
    version="2.0.0rc5",
    line=ReleaseLine.V2_PRERELEASE,
    source_tag="v2.0.0rc5",
    prerelease=True,
    implementation="Rust / PyO3 prerelease",
    python_constraint=">=3.12,<3.15",
    rust_toolchain="1.98.1",
    release_url="https://github.com/nautechsystems/nautilus_trader/releases/tag/v2.0.0rc5",
    migration_url="https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/MIGRATION_V2.md",
    distinctions=(
        "Canonical intended new-system dependency; selection does not prove installation or qualification.",
        "Current host adapter is bounded offline Equity quote replay only, not live or full research integration.",
        "In-tree Rust/Python IBKR integration exists; IBKR is not Python-only.",
        "v1 out-of-tree Python data/execution factories have no equivalent v2 registration surface.",
        "Gateway container lifecycle is separate from client construction.",
        "PostgreSQL cache does not restore actor/strategy state, cache heartbeat or synthetics.",
        "Older OrderReleased/OrderFillVoided rows lack new restoration fields.",
        "Use copied-data migration; never delete authoritative history to satisfy loading.",
    ),
)

# Intended source dependency only. RuntimePins remain explicit/unknown until
# supplied; selecting this release never manufactures receipts or grants authority.
CANONICAL_RELEASE = V2_RC5


def release_facts(version: str | None) -> ReleaseFacts | None:
    """Exact source-known releases only; no semver ranges or 'latest' inference."""
    if version == V1_BASELINE.version:
        return V1_BASELINE
    if version == V2_RC5.version:
        return V2_RC5
    return None


@dataclass(frozen=True, slots=True)
class RuntimePins:
    """Nonsecret requested identity, not discovered installation metadata.

    Digests are lowercase hex SHA-256 (Gateway uses sha256:<hex>). account_ref
    is an opaque registry-issued acctref-<64 lowercase hex> token, not an account
    number or a client-side hash of one. Client identity is a nonsecret scoped
    alias plus the socket client ID. Identity fields are excluded from repr.
    Every receipt binds the entire value.
    """

    package_version: str | None = None
    source_tag: str | None = None
    package_sha256: str | None = None
    wheel_sha256: str | None = None
    python_version: str | None = None
    interpreter_abi: str | None = None
    rust_toolchain: str | None = None
    cargo_lock_sha256: str | None = None
    target_platform: str | None = None
    isolated_environment_id: str | None = None
    gateway_image_digest: str | None = None
    broker_config_sha256: str | None = None
    account_ref: str | None = field(default=None, repr=False)
    client_identity: str | None = field(default=None, repr=False)
    client_id: int | None = field(default=None, repr=False)
    scope: EvaluationScope = EvaluationScope.RESEARCH
    adapter_surface: AdapterSurface = AdapterSurface.UNKNOWN
    persistence_backend: PersistenceBackend = PersistenceBackend.UNKNOWN

    def __post_init__(self) -> None:
        enum_fields = {
            "scope": EvaluationScope,
            "adapter_surface": AdapterSurface,
            "persistence_backend": PersistenceBackend,
        }
        for field in fields(self):
            value = getattr(self, field.name)
            if field.name in enum_fields:
                if type(value) is not enum_fields[field.name]:
                    raise TypeError(f"{field.name} must be an internal enum")
            elif field.name == "client_id":
                if value is not None and type(value) is not int:
                    raise TypeError("client_id must be an integer or None")
            elif value is not None and type(value) is not str:
                raise TypeError(f"{field.name} must be a string or None")


@dataclass(frozen=True, slots=True)
class EvidenceReceipt:
    """Assertion supplied by a trusted caller; this evaluator never opens it.

    PRERELEASE_EXCEPTION denotes separately recorded explicit acceptance of rc5
    for these exact research/paper pins. It is not itself an authorization API.
    report_ref is an opaque registry report-<64 lowercase hex> ID, never a path,
    URL, secret, or report body. This module does not derive or resolve IDs.
    """

    gate: EvidenceGate
    pins: RuntimePins
    state: EvidenceState = EvidenceState.UNKNOWN
    report_ref: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if type(self.gate) is not EvidenceGate or type(self.state) is not EvidenceState:
            raise TypeError("gate and state must be internal enums")
        if type(self.pins) is not RuntimePins:
            raise TypeError("pins must be RuntimePins")
        if self.report_ref is not None and type(self.report_ref) is not str:
            raise TypeError("report_ref must be a string or None")


@dataclass(frozen=True, slots=True)
class CompatibilityRequest:
    pins: RuntimePins
    receipts: tuple[EvidenceReceipt, ...] = ()

    def __post_init__(self) -> None:
        if type(self.pins) is not RuntimePins:
            raise TypeError("pins must be RuntimePins")
        if type(self.receipts) is not tuple or any(
            type(receipt) is not EvidenceReceipt for receipt in self.receipts
        ):
            raise TypeError("receipts must be an immutable tuple of EvidenceReceipt")


@dataclass(frozen=True, slots=True)
class CompatibilityCheck:
    code: str
    state: EvidenceState
    detail: str
    report_ref: str | None = None


@dataclass(frozen=True, slots=True)
class CompatibilityAssessment:
    release: ReleaseFacts | None
    status: AssessmentStatus
    checks: tuple[CompatibilityCheck, ...]
    source_refs: tuple[SourceReference, ...] = SOURCE_REFERENCES

    @property
    def blockers(self) -> tuple[CompatibilityCheck, ...]:
        """Unknown and failed requirements both prevent evidence completeness."""
        return tuple(check for check in self.checks if check.state is not EvidenceState.PASS)

    @property
    def unknowns(self) -> tuple[CompatibilityCheck, ...]:
        return tuple(check for check in self.checks if check.state is EvidenceState.UNKNOWN)

    @property
    def runtime_compatibility_proven(self) -> bool:
        return False

    @property
    def trading_authorized(self) -> bool:
        return False


_COMMON_GATES = (
    EvidenceGate.ISOLATED_ENVIRONMENT,
    EvidenceGate.WHEEL_HOST_ABI,
    EvidenceGate.ADAPTER_API,
    EvidenceGate.GATEWAY_LIFECYCLE,
    EvidenceGate.ORDERED_EVENTS,
    EvidenceGate.FINANCIAL_PARITY,
    EvidenceGate.RESTART_RECONCILIATION,
    EvidenceGate.BROKER_PACING,
    EvidenceGate.OPTIONS_MULTI_LEG,
    EvidenceGate.LATENCY,
    EvidenceGate.ROLLBACK,
)
_RC5_GATES = (
    EvidenceGate.PRERELEASE_EXCEPTION,
    EvidenceGate.RC5_RELEASE_PARITY,
    EvidenceGate.COPIED_DATA_MIGRATION,
    EvidenceGate.CORRECTED_VOIDED_FILLS,
    EvidenceGate.LEGACY_EVENT_RESTORATION,
)


def required_evidence_gates(pins: RuntimePins) -> tuple[EvidenceGate, ...]:
    """Checklist, not proof: options/latency receipts cover the intended scope."""
    if type(pins) is not RuntimePins:
        raise TypeError("pins must be RuntimePins")
    gates = _COMMON_GATES
    if pins.package_version == V2_RC5.version:
        gates += _RC5_GATES
        if pins.adapter_surface is AdapterSurface.V1_OUT_OF_TREE_FACTORIES:
            gates += (EvidenceGate.V1_FACTORY_MIGRATION,)
        if pins.persistence_backend is PersistenceBackend.POSTGRESQL_CACHE:
            gates += (EvidenceGate.POSTGRES_STATE_RESTORATION,)
    return gates


def _present(value: str | None) -> bool:
    return value is not None and bool(value.strip())


def _receipt_check(request: CompatibilityRequest, gate: EvidenceGate) -> CompatibilityCheck:
    receipts = tuple(receipt for receipt in request.receipts if receipt.gate is gate)
    if not receipts:
        return CompatibilityCheck(gate.value, EvidenceState.UNKNOWN, "No scoped evidence supplied.")
    if len(receipts) != 1:
        return CompatibilityCheck(gate.value, EvidenceState.FAIL, "Ambiguous duplicate receipts.")
    receipt = receipts[0]
    if receipt.pins != request.pins:
        return CompatibilityCheck(
            gate.value, EvidenceState.FAIL, "Receipt does not bind the exact requested pins and scope."
        )
    if not _present(receipt.report_ref):
        return CompatibilityCheck(gate.value, EvidenceState.UNKNOWN, "Missing evidence report reference.")
    if re.fullmatch(r"report-[0-9a-f]{64}", receipt.report_ref) is None:
        return CompatibilityCheck(
            gate.value, EvidenceState.FAIL, "Evidence requires an opaque registry report ID."
        )
    return CompatibilityCheck(
        gate.value,
        receipt.state,
        "Caller-supplied evidence assertion; report contents not verified by this evaluator.",
        receipt.report_ref,
    )


def evaluate_compatibility(request: CompatibilityRequest) -> CompatibilityAssessment:
    """Pure, deterministic, fail-closed checklist of supplied compatibility evidence.

    UNKNOWN means an unresolved requirement without a known contradiction;
    BLOCKED means at least one failed/contradictory requirement (unknowns remain
    visible); EVIDENCE_COMPLETE is never installed, connected, reconciled or live
    readiness. No I/O, mutation, installation, broker actions or implicit upgrade.
    """
    if type(request) is not CompatibilityRequest:
        raise TypeError("request must be CompatibilityRequest")
    pins = request.pins
    release = release_facts(pins.package_version)
    checks: list[CompatibilityCheck] = []

    def add(code: str, state: EvidenceState, detail: str) -> None:
        checks.append(CompatibilityCheck(code, state, detail))

    add(
        "release_line",
        EvidenceState.PASS if release is not None else EvidenceState.UNKNOWN,
        "Exact source-known release." if release is not None else "Release is absent or outside the assessed lines.",
    )
    add(
        "evaluation_scope",
        EvidenceState.FAIL if pins.scope is EvaluationScope.LIVE else EvidenceState.PASS,
        "This assessment cannot promote or authorize live use; research/paper also need separate authority.",
    )
    # A value alone is not evidence: separate isolation, ABI and lifecycle gates
    # below prevent complete metadata from masquerading as runtime compatibility.
    for name in (
        "source_tag", "package_sha256", "wheel_sha256", "python_version",
        "interpreter_abi", "rust_toolchain", "cargo_lock_sha256", "target_platform",
        "isolated_environment_id", "gateway_image_digest", "broker_config_sha256",
        "account_ref", "client_identity",
    ):
        value = getattr(pins, name)
        if not _present(value):
            add(name, EvidenceState.UNKNOWN, "Exact nonsecret pin/identity is missing.")
            continue
        valid = value == value.strip() and not any(ord(char) < 32 or ord(char) == 127 for char in value)
        if name.endswith("_sha256"):
            valid = valid and re.fullmatch(r"[0-9a-f]{64}", value) is not None
        elif name == "gateway_image_digest":
            valid = valid and re.fullmatch(r"sha256:[0-9a-f]{64}", value) is not None
        elif name == "account_ref":
            valid = valid and re.fullmatch(r"acctref-[0-9a-f]{64}", value) is not None
        elif name in ("python_version", "rust_toolchain"):
            valid = valid and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value) is not None
        elif name == "source_tag" and release is not None:
            valid = valid and value == release.source_tag
        add(name, EvidenceState.PASS if valid else EvidenceState.FAIL, "Exact pin format/source-tag agreement required.")

    add(
        "client_id",
        EvidenceState.UNKNOWN if pins.client_id is None else (
            EvidenceState.PASS if pins.client_id >= 0 else EvidenceState.FAIL
        ),
        "Explicit nonnegative client ID required; no default identity inference.",
    )
    for name, unknown in (
        ("adapter_surface", AdapterSurface.UNKNOWN),
        ("persistence_backend", PersistenceBackend.UNKNOWN),
    ):
        add(
            name,
            EvidenceState.UNKNOWN if getattr(pins, name) is unknown else EvidenceState.PASS,
            "Adapter/persistence choice must be explicit and backed by scoped receipts.",
        )
    if release is V2_RC5:
        if pins.python_version and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", pins.python_version):
            version = tuple(int(part) for part in pins.python_version.split("."))
            add(
                "rc5_python_range",
                EvidenceState.PASS if (3, 12, 0) <= version < (3, 15, 0) else EvidenceState.FAIL,
                "rc5 tag requires Python >=3.12,<3.15; actual wheel/host ABI is a separate gate.",
            )
        else:
            add("rc5_python_range", EvidenceState.UNKNOWN, "No exact Python version available.")
        add(
            "rc5_rust_toolchain",
            EvidenceState.UNKNOWN if not _present(pins.rust_toolchain) else (
                EvidenceState.PASS if pins.rust_toolchain == V2_RC5.rust_toolchain else EvidenceState.FAIL
            ),
            "rc5 source pins Rust 1.98.1.",
        )
    checks.extend(_receipt_check(request, gate) for gate in required_evidence_gates(pins))
    status = AssessmentStatus.EVIDENCE_COMPLETE
    if any(check.state is EvidenceState.FAIL for check in checks):
        status = AssessmentStatus.BLOCKED
    elif any(check.state is EvidenceState.UNKNOWN for check in checks):
        status = AssessmentStatus.UNKNOWN
    return CompatibilityAssessment(release=release, status=status, checks=tuple(checks))
