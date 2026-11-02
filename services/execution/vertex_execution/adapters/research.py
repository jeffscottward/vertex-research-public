"""Injected implementation of backtesting.planner.SimulationEngine.

This adapter does not create a sandbox or claim that Python booleans enforce
one. A separately trusted supervisor must enforce resources/isolation and an
independent verifier must authenticate start AND finish attestations binding
this exact input, policy, session and output. Missing ports fail closed. There
is no default engine, loader, supervisor, subprocess, network, or broker client.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, fields, is_dataclass, replace
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Callable, Iterable, Protocol

from .contracts import ContractAuthority, canonical_record, decode_record

if TYPE_CHECKING:
    from backtesting.planner import EngineDescriptor, SimulationOutput, SimulationRequest
    from backtesting.ports import ResourceBudget


class ResearchEngineUnavailable(RuntimeError):
    pass


class SandboxAttestationRejected(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CapturedMarketEvent:
    """Loader-owned private event; public market schemas remain native-owned."""

    dataset_content_digest: str
    event_id: str
    event_ns: int
    available_ns: int
    payload_bytes: bytes

    def __post_init__(self) -> None:
        if type(self.dataset_content_digest) is not str or len(self.dataset_content_digest) != 64 or any(
            char not in "0123456789abcdef" for char in self.dataset_content_digest
        ):
            raise ValueError("dataset content SHA-256 is required")
        if type(self.event_id) is not str or not 1 <= len(self.event_id) <= 128:
            raise ValueError("bounded event identity required")
        if any(type(value) is not int or not 0 <= value < 2**127 for value in (self.event_ns, self.available_ns)):
            raise ValueError("exact epoch nanoseconds required")
        if self.available_ns < self.event_ns:
            raise ValueError("event cannot be available before observation")
        if type(self.payload_bytes) is not bytes or not 0 < len(self.payload_bytes) <= 1_000_000:
            raise ValueError("bounded immutable event payload required")


@dataclass(frozen=True, slots=True)
class ResearchRunBinding:
    request_digest: str
    lineage_digest: str
    strategy_digest: str
    run_digest: str
    engine_digest: str
    policy_digest: str
    budget: ResourceBudget
    input_bytes: int


@dataclass(frozen=True, slots=True)
class SandboxSession:
    supervisor_id: str
    session_id: str
    policy_digest: str
    start_attestation: bytes


@dataclass(frozen=True, slots=True)
class SupervisedResult:
    session: SandboxSession
    output: SimulationOutput
    finish_attestation: bytes


class SandboxAttestationVerifier(Protocol):
    """Host-pinned trust roots, not an engine/self-supplied boolean approver.

    verify_start checks supervisor identity, unique session, current enforced
    policy and exact binding. verify_finish authenticates that same session,
    measured resource accounting, denied network/execution capabilities and the
    complete output/evidence digest. Offline evidence/signatures are injected;
    these methods must not silently fetch trust roots or relax missing proof.
    """

    def verify_start(self, session: SandboxSession, binding: ResearchRunBinding) -> bool: ...

    def verify_finish(self, result: SupervisedResult, binding: ResearchRunBinding) -> bool: ...


class SandboxSupervisor(Protocol):
    def execute(
        self,
        binding: ResearchRunBinding,
        operation: Callable[[SandboxSession], SimulationOutput],
    ) -> SupervisedResult:
        """Enforce the bound OS policy before invoking operation exactly once.

        The supervisor must not return before the workload is stopped, and must
        terminate it on budget exhaustion, exception or caller cancellation.
        It may replace only output.sandbox with its final measured SandboxReceipt
        after termination; all economics/lineage/evidence must remain identical.
        Both attestations must bind the isolation evidence already in the output.
        Callback capture is not itself isolation; a trusted implementation is
        required. The adapter never implements an in-process permissive fallback.
        """
        ...


class BoundedEventLoader(Protocol):
    def load(
        self, request: SimulationRequest, *, maximum_events: int, maximum_bytes: int
    ) -> Iterable[CapturedMarketEvent]: ...


class ResearchEngineRunner(Protocol):
    def describe(self) -> EngineDescriptor: ...

    def run(
        self, request: SimulationRequest, events: tuple[CapturedMarketEvent, ...]
    ) -> SimulationOutput: ...


def _capture_request(value: Any, maximum_bytes: int) -> tuple[dict[str, Any], int]:
    """Bounded typed fingerprint of private request dataclasses, not public JSON.

    Content bytes remain pinned by SHA-256 rather than duplicated into JSON.
    Datetime/Decimal/int have distinct exact tags. No repr, float coercion, user
    serializer, or unbounded recursive graph is accepted.
    """
    consumed = 0
    nodes = 0

    def capture(item: Any, depth: int = 0) -> Any:
        nonlocal consumed, nodes
        nodes += 1
        if depth > 64 or nodes > 100_000:
            raise ValueError("research request graph exceeds bounded capture")
        if item is None or type(item) is bool:
            return item
        if type(item) is bytes:
            consumed += len(item)
            if consumed > maximum_bytes:
                raise ValueError("research input exceeds byte budget")
            result: Any = ["bytes", len(item), hashlib.sha256(item).hexdigest()]
        elif type(item) is str:
            if len(item) > maximum_bytes:
                raise ValueError("research text exceeds byte budget")
            consumed += len(item.encode("utf-8"))
            result = ["text", item]
        elif type(item) is int:
            if not -(2**127) <= item < 2**127:
                raise ValueError("research integer exceeds exact capture range")
            result = ["integer", str(item)]
        elif type(item) is Decimal:
            if not item.is_finite() or len(item.as_tuple().digits) > 128 or abs(item.as_tuple().exponent) > 128:
                raise ValueError("bounded finite Decimal required")
            result = ["decimal", str(item)]
        elif type(item) is datetime:
            if item.tzinfo is None or item.utcoffset() is None:
                raise ValueError("aware research timestamps required")
            result = ["datetime", item.isoformat()]
        elif type(item) in (tuple, list):
            if len(item) > 100_000:
                raise ValueError("research sequence exceeds node budget")
            result = ["sequence", [capture(child, depth + 1) for child in item]]
        elif type(item) is dict:
            if len(item) > 100_000:
                raise ValueError("research mapping exceeds node budget")
            if any(type(key) is not str for key in item):
                raise ValueError("research mappings require text keys")
            result = ["mapping", [[capture(key, depth + 1), capture(item[key], depth + 1)] for key in sorted(item)]]
        elif is_dataclass(item) and not isinstance(item, type):
            result = ["record", type(item).__module__ + "." + type(item).__qualname__, [
                [field.name, capture(getattr(item, field.name), depth + 1)] for field in fields(item)
            ]]
        else:
            raise ValueError("unsupported research request capture type")
        if consumed > maximum_bytes:
            raise ValueError("research input exceeds byte budget")
        return result

    return {"capture_version": "vertex.research-engine-request.v1", "request": capture(value)}, consumed


class AttestedResearchSimulationEngine:
    """Metadata describe()/explicit simulate() match the frozen research port."""

    def __init__(
        self,
        *,
        descriptor: EngineDescriptor | None = None,
        authority: ContractAuthority | None = None,
        loader: BoundedEventLoader | None = None,
        runner: ResearchEngineRunner | None = None,
        supervisor: SandboxSupervisor | None = None,
        verifier: SandboxAttestationVerifier | None = None,
    ) -> None:
        self._descriptor = descriptor
        self._authority = authority
        self._loader = loader
        self._runner = runner
        self._supervisor = supervisor
        self._verifier = verifier
        self._running = False

    def describe(self) -> EngineDescriptor:
        if any(port is None for port in (
            self._descriptor, self._authority, self._loader, self._runner, self._supervisor, self._verifier
        )):
            raise ResearchEngineUnavailable("attested offline research engine ports are unavailable")
        if self._descriptor is None or self._descriptor.simulation_only is not True:
            raise ResearchEngineUnavailable("research engine is not simulation-only")
        return self._descriptor

    def simulate(self, request: SimulationRequest) -> SimulationOutput:
        descriptor = self.describe()
        # Imported only at explicit orchestration, not package import or describe.
        from backtesting.planner import SandboxReceipt, SimulationOutput, SimulationRequest

        if type(request) is not SimulationRequest:
            raise TypeError("the frozen research SimulationRequest is required")
        if self._running:
            raise ResearchEngineUnavailable("a research simulation is already running")
        plan = request.plan
        if (
            plan.status != "ready" or plan.execution_authorized is not False
            or plan.strategy is None or plan.run is None or plan.lineage is None
            or plan.engine != descriptor or plan.missing_ports
        ):
            raise ResearchEngineUnavailable("only a sealed ready simulation plan is accepted")
        budget = plan.request.budget
        if budget.network_allowed is not False or budget.execution_allowed is not False:
            raise SandboxAttestationRejected("network and execution capabilities must be absent")
        authority, loader, runner = self._authority, self._loader, self._runner
        supervisor, verifier = self._supervisor, self._verifier
        if authority is None or loader is None or runner is None or supervisor is None or verifier is None:
            raise ResearchEngineUnavailable("research engine ports disappeared")
        if len(plan.datasets) != len(plan.request.datasets) or len(plan.evidence) != len(plan.request.evidence_bytes):
            raise ValueError("research plan artifacts differ from captured inputs")
        public_inputs = [
            ("StrategySpec", plan.request.strategy_bytes, plan.strategy),
            ("BacktestRun", plan.request.run_bytes, plan.run),
            *(("DatasetManifest", source.manifest_bytes, artifact) for source, artifact in zip(plan.request.datasets, plan.datasets)),
            *(("ResearchEvidence", source, artifact) for source, artifact in zip(plan.request.evidence_bytes, plan.evidence)),
        ]
        for name, raw, artifact in public_inputs:
            payload = decode_record(raw, budget.maximum_input_bytes)
            if authority.validate(name, payload, schema_version="1.0.0") is not True:
                raise ValueError("native research contract validation failed")
            encoded, digest = canonical_record(authority, payload, budget.maximum_input_bytes)
            if artifact.contract_name != name or encoded != artifact.payload_bytes or digest != artifact.digest:
                raise ValueError("research plan changed a captured public artifact")
        for source, artifact in zip(plan.request.datasets, plan.datasets):
            if (
                source.content_bytes is None
                or source.content_format not in descriptor.supported_formats
                or hashlib.sha256(source.content_bytes).hexdigest() != artifact.decode()["contentHash"]
            ):
                raise ValueError("dataset bytes/format do not match the pinned manifest")
        captured, raw_bytes = _capture_request(plan.request, budget.maximum_input_bytes)
        capture_bytes, request_digest = canonical_record(authority, captured, budget.maximum_input_bytes)
        input_bytes = raw_bytes + len(capture_bytes)
        if input_bytes > budget.maximum_input_bytes:
            raise ValueError("captured research inputs and manifest exceed byte budget")
        binding = ResearchRunBinding(
            request_digest, plan.lineage.digest, plan.strategy.digest, plan.run.digest,
            descriptor.pin.digest, descriptor.sandbox_policy_digest, budget, input_bytes,
        )
        expected_data = tuple(item.decode()["contentHash"] for item in plan.datasets)
        event_limit = min(budget.maximum_events, sum(source.declared_events for source in plan.request.datasets))
        session_used: SandboxSession | None = None
        output_used: SimulationOutput | None = None
        event_count = 0
        attempted = False

        def operation(session: SandboxSession) -> SimulationOutput:
            nonlocal attempted, session_used, output_used, event_count
            if attempted:
                raise SandboxAttestationRejected("supervisor repeated the workload")
            attempted = True
            _require_session(session, binding)
            if verifier.verify_start(session, binding) is not True:
                raise SandboxAttestationRejected("supervisor start attestation was not authenticated")
            session_used = session
            if runner.describe() != descriptor:
                raise ResearchEngineUnavailable("runner differs from the pinned engine descriptor")
            events: list[CapturedMarketEvent] = []
            payload_bytes = 0
            identities: set[tuple[str, str]] = set()
            previous_ns = -1
            for event in loader.load(
                request, maximum_events=event_limit, maximum_bytes=budget.maximum_input_bytes
            ):
                if type(event) is not CapturedMarketEvent:
                    raise ValueError("loader returned an unsupported event")
                if len(events) >= event_limit or event.dataset_content_digest not in expected_data:
                    raise ValueError("loader exceeded event budget or dataset lineage")
                identity = (event.dataset_content_digest, event.event_id)
                if identity in identities or event.available_ns < previous_ns:
                    raise ValueError("duplicate or noncausal loaded market events")
                payload_bytes += len(event.payload_bytes)
                if payload_bytes > budget.maximum_input_bytes:
                    raise ValueError("loaded event payload byte budget exceeded")
                identities.add(identity)
                previous_ns = event.available_ns
                events.append(event)
            if not events:
                raise ValueError("empty event stream cannot prove economic simulation")
            event_count = len(events)
            output_used = runner.run(request, tuple(events))
            if type(output_used) is not SimulationOutput:
                raise ValueError("runner did not return frozen SimulationOutput")
            return output_used

        self._running = True
        try:
            result = supervisor.execute(binding, operation)
            if type(result) is not SupervisedResult or session_used is None or output_used is None:
                raise SandboxAttestationRejected("supervisor did not complete an attested workload")
            if type(result.output) is not SimulationOutput or type(result.output.sandbox) is not SandboxReceipt:
                raise SandboxAttestationRejected("supervisor must supply a typed measured receipt")
            expected_output = replace(output_used, sandbox=result.output.sandbox)
            if result.session != session_used or result.output != expected_output:
                raise SandboxAttestationRejected("supervisor changed session or economic workload result")
            if type(result.finish_attestation) is not bytes or not 0 < len(result.finish_attestation) <= 65536:
                raise SandboxAttestationRejected("bounded supervisor finish attestation is required")
            output = result.output
            if (
                output.lineage_digest != binding.lineage_digest
                or output.strategy_digest != binding.strategy_digest
                or output.engine_pin != descriptor.pin
                or output.dataset_content_digests != expected_data
                or not output.sandbox.qualified(descriptor, budget)
                or output.sandbox.input_bytes != input_bytes
                or output.sandbox.events_processed != event_count
            ):
                raise SandboxAttestationRejected("simulation output or measured accounting changed binding")
            if sum(len(item) for item in output.evidence_bytes) + len(output.economics_bytes) > budget.maximum_input_bytes:
                raise ValueError("research output exceeds byte budget")
            if verifier.verify_finish(result, binding) is not True:
                raise SandboxAttestationRejected("supervisor finish attestation was not authenticated")
            # No SandboxReceipt fields are synthesized or upgraded here. Public
            # evidence validation and scientific acceptance remain planner-owned.
            return output
        finally:
            self._running = False


def _require_session(session: SandboxSession, binding: ResearchRunBinding) -> None:
    if type(session) is not SandboxSession or session.policy_digest != binding.policy_digest:
        raise SandboxAttestationRejected("supervisor policy/session does not match binding")
    for value in (session.supervisor_id, session.session_id):
        if type(value) is not str or not 1 <= len(value) <= 128:
            raise SandboxAttestationRejected("bounded supervisor/session identity required")
    if type(session.start_attestation) is not bytes or not 0 < len(session.start_attestation) <= 65536:
        raise SandboxAttestationRejected("bounded supervisor start attestation is required")
