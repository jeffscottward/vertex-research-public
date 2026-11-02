"""Explicit native host lifecycle; no import-time IO, startup, model or broker.

Every journal mutation is serialized; neither a tick nor a control ACK can
reserve cash. Unknown/revoked/unconfigured capability stays unavailable. Shutdown
joins bounded work before releasing the native owner fence, never abandons a
thread that may still mutate the journal.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any, Callable

from vertex_execution.adapters.callbacks import AsyncTickDrain, BoundedTickBuffer, TickEvent
from vertex_execution.batch_owner import AtomicBatchOwner
from vertex_execution.journal import Journal
from vertex_execution.native_risk import NativeRiskPort
from vertex_execution.owner import AsyncExecutionService
from vertex_execution.ports import Artifact
from vertex_execution.projection import OrderedProjectionPublisher
from vertex_execution.simulator_bridge import DurablePaperTransport

from .authority import CurrentAdmissionAuthority, CurrentRights, DisabledMutationAuthority, DisabledObservationAuthority
from .cache import HostUnavailable, SealedArtifactCache, canonical_object, freeze
from .config import read_regular
from .context import HostContext, SystemClock, UnavailablePort
from .dispatcher import LeaseDispatcher, fence
from .local_state import LocalOwnerFence, atomic_receipt
from .publication import ControlProjectionPort
from .selection import load_selection, read_artifact


async def joined_thread(operation: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Cancellation does not release ownership while a native call still runs."""
    future = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    cancelled = False
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            cancelled = True
    result = future.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


@dataclass
class HostPorts:
    # These optional ports are explicit trusted composition, never JSON booleans.
    supervisor: Any = None
    chat_events: Any = None
    gateway_status: Any = None
    tick_qualifier: Any = None
    backtest_handler: Any = None
    native_approval: Any = None
    # Default absent. Explicit exclusive research config mounts an inert startup port.
    ibkr_history: Any = None


class HostCancellation:
    def __init__(self, host: Any) -> None:
        self.host = host

    def is_set(self) -> bool:
        active = self.host.dispatcher.active_cancel
        return self.host.cancelled.is_set() or (active is not None and active.is_set())


class HostRuntime:
    def __init__(self, *, config: dict[str, Any], contracts: Any, control: Any,
                 secret_resolver: Any, kernel: Any = None, ports: HostPorts | None = None,
                 clock: Any = None) -> None:
        self.config, self.contracts, self.control = config, contracts, control
        self.secret_resolver, self.kernel = secret_resolver, kernel
        self.ports, self.clock = ports or HostPorts(), clock or SystemClock()
        self.cancelled = asyncio.Event()
        self.cache = SealedArtifactCache(contracts)
        age = int(config["worker"]["rightsMaxAgeNs"])
        self.rights = CurrentRights(contracts, config["accountAlias"], config["environment"], age)
        self.admissions = CurrentAdmissionAuthority(contracts, config["accountAlias"], age)
        self.owner_fence = LocalOwnerFence(config["ownerLockPath"])
        self.journal: Journal | None = None
        self.owner: AtomicBatchOwner | None = None
        self.execution: AsyncExecutionService | None = None
        self.transport: DurablePaperTransport | None = None
        self.publisher: OrderedProjectionPublisher | None = None
        self.evidence: Any = None
        self.selection: dict[str, Any] | None = None
        self.raw_inputs: dict[str, bytes] = {}
        self.adapter_config: Any = None
        self.shared_admission: Any = None
        self.control_bridge: Any = None
        self.native_approval = self.ports.native_approval
        self.native_admin: Any = None
        self.bootstrap_completed = False
        self.prior_epoch = 0
        self.prior_projection: tuple[int, str | None] = (0, None)
        self.epoch_store: Any = None
        self.pending_epoch: Any = None
        self.pending_replay: Any = None
        self.nautilus: Any = None
        self._nautilus_capture_attempted = False
        self.ticks = BoundedTickBuffer(1024)
        self.tick_drain = AsyncTickDrain(self.ticks, self._tick_sink)
        self._started = False
        self._drained = False
        self._background: list[asyncio.Task[Any]] = []
        self._actor = asyncio.Lock()
        self.dispatcher = LeaseDispatcher(config=config, control=control, authority=contracts,
            clock=self.clock, prepare=self._prepare, cancelled=self.cancelled, on_unavailable=self.mark_unavailable)
        self.projection_port = ControlProjectionPort(control=control, authority=contracts,
            lease=lambda: self.dispatcher.active_lease, epoch_transition=self._epoch_receipt,
            requires_epoch_transition=lambda _snapshot: self.prior_epoch > 0)
        self.work_cancellation = HostCancellation(self)
        self._history_owner: Any = None
        self._history_start_attempted = False
        self._history_ready = False
        self._history_start_lock = asyncio.Lock()
        self._history_rights: tuple[str, str] | None = None
        self._history_capability_expires = 0
        self._history_profile_expires = 0
        if config.get("ibkrHistory") is not None:
            if (config["environment"] != "research" or config["worker"]["kinds"] != ["dataset-ingest"]
                    or any(config.get(key) is not None for key in ("paper", "kernel", "nautilus", "nativeApproval", "nativeAdmin"))
                    or kernel is not None or self.ports.ibkr_history is not None
                    or self.ports.native_approval is not None or self.ports.tick_qualifier is not None):
                raise HostUnavailable("exclusive-ibkr-history-host-required")
            from .ibkr_history import StartupHistoryPort
            self.ports.ibkr_history = StartupHistoryPort(self._start_history_owner)

    def _history_current(self) -> bool:
        if not self.is_current() or self._history_rights is None:
            return False
        policy_id, version = self._history_rights
        now = self.clock.now_ns()
        return (now < min(self._history_capability_expires, self._history_profile_expires)
                and all(self.rights.permits(policy_id, version, use, now) for use in ("read", "store", "derive")))

    async def _start_history_owner(self, request: Any) -> Any:
        """Once-per-generation lazy OWNER startup, never a per-job connection.

        Reached only after the trusted IBKR handler has current rights/selection
        and a real immutable intent stage ACK. Existing dispatcher heartbeat and
        cancellation already run. Local config/pins alone cannot start a broker.
        """
        async with self._history_start_lock:
            lease = self.dispatcher.active_lease
            if lease is None or lease["kind"] != "dataset-ingest" or not self.is_current():
                raise HostUnavailable("history-current-dataset-owner-lease-required")
            first_start = not self._history_start_attempted
            if not first_start and (not self._history_ready or self._history_owner is None):
                raise HostUnavailable("history-generation-unavailable-no-reconnect")
            self._history_start_attempted = True
            from .ibkr_history import compose_history_owner, require_current_profile_review

            async def current_control() -> None:
                self._history_profile_expires = 0
                result = await self.control.status(accountAlias=lease["accountAlias"],
                    environment=lease["environment"], jobId=lease["jobId"])
                self.contracts.validate("WorkerResult", result)
                if (not self.is_current() or result["status"] != "accepted" or result["state"] != "running"
                        or result["reason"] is not None or result["lease"] != lease):
                    raise HostUnavailable("history-current-control-lease-unconfirmed")
                selected, originals = await load_selection(control=self.control, authority=self.contracts,
                    lease=lease, config=self.config, cache=self.cache, now_ns=self.clock.now_ns())
                if selected != self.selection:
                    raise HostUnavailable("history-current-selection-changed")
                self._history_profile_expires = await require_current_profile_review(
                    selection=selected, originals=originals, config=self.config["ibkrHistory"],
                    control=self.control, contracts=self.contracts, lease_fence=fence(lease),
                    clock=self.clock, max_age_ns=int(self.config["worker"]["rightsMaxAgeNs"]))
                payload = canonical_object(self.contracts, await read_artifact(self.control,
                    self.contracts, lease, lease["payloadArtifactId"], lease["payloadSha256"]))
                if (set(payload) != {"profile", "request", "publication"}
                        or payload["profile"] != "vertex-ibkr-history-ingest-v1"
                        or payload["request"]["kind"]["type"] != "bars"):
                    raise HostUnavailable("history-explicit-ibkr-dataset-profile-required")
                actual = request.decode()
                for key in ("timeout_ms", "max_bytes"):
                    if actual["limits"][key] > payload["request"]["limits"][key]:
                        raise HostUnavailable("history-request-exceeds-intent")
                    actual["limits"][key] = payload["request"]["limits"][key]
                if actual != payload["request"]:
                    raise HostUnavailable("history-request-does-not-match-current-job")
                policies = [row for row in selected["policies"] if row["role"] == "licensing-rights"
                    and row["policyId"] == payload["publication"]["rights_policy_id"]]
                capabilities = [row for row in selected["providerCapabilities"]
                    if row["providerId"] == "ibkr" and row["operation"] == "historical-bars"
                    and row["modelVersion"] is None]
                if len(policies) != 1 or len(capabilities) != 1:
                    raise HostUnavailable("history-exact-rights-and-capability-required")
                policy, capability = policies[0], capabilities[0]
                now = self.clock.now_ns()
                if (capability["state"] != "ready" or capability["rightsPolicyId"] != policy["policyId"]
                        or capability["rightsPolicyVersion"] != policy["version"]
                        or not self.contracts.epoch_ns(capability["observedAt"]) <= now
                            < self.contracts.epoch_ns(capability["expiresAt"])):
                    raise HostUnavailable("history-current-reviewed-source-capability-required")
                response = await self.control.current_rights(**fence(lease), collectionId=None,
                    policyId=policy["policyId"], use="derive")
                self.rights.install(response, policy["policyId"])
                self._history_rights = (policy["policyId"], policy["version"])
                self._history_capability_expires = self.contracts.epoch_ns(capability["expiresAt"])
                if not self._history_current():
                    raise HostUnavailable("history-source-rights-unavailable")

            try:
                await current_control()
            except BaseException:
                self._history_ready = False
                raise
            if not first_start:
                if not self._history_owner.matches_selection(self.selection) or not self._history_current():
                    self._history_ready = False
                    raise HostUnavailable("history-generation-selection-or-authority-changed")
                return self._history_owner
            self._history_owner = compose_history_owner(selection=self.selection, cache=self.cache,
                contracts=self.contracts, clock=self.clock, config=self.config["ibkrHistory"],
                current=self._history_current)
            if not self._history_owner.permits_request(request):
                raise HostUnavailable("history-request-outside-reviewed-owner-profile")
            rights = self.rights.record(*self._history_rights, self.clock.now_ns())
            deadline = min(self.contracts.epoch_ns(lease["deadlineAt"]),
                self.contracts.epoch_ns(self.selection["expiresAt"]), self._history_capability_expires,
                rights["expires_ns"], self._history_profile_expires)
            required_ns = (self._history_owner.startup_budget_seconds * 1_000_000_000
                + request.decode()["limits"]["timeout_ms"] * 1_000_000 + 1_000_000_000)
            if self.clock.now_ns() + required_ns > deadline:
                raise HostUnavailable("history-startup-and-capture-budget-unavailable")
            await self._history_owner.start()
            await current_control()
            if self.clock.now_ns() + request.decode()["limits"]["timeout_ms"] * 1_000_000 + 1_000_000_000 > deadline:
                raise HostUnavailable("history-startup-consumed-capture-budget")
            self._history_ready = True
            return self._history_owner

    def is_current(self) -> bool:
        return (self.owner_fence.is_current() and self.dispatcher.is_current()
                and not self.work_cancellation.is_set()
                and (self.selection is None or self.clock.now_ns() < self.contracts.epoch_ns(self.selection["expiresAt"])))

    def request_shutdown(self) -> None:
        # Signal handlers only set bounded in-memory flags; no journal IO here.
        self.cancelled.set()
        if self.dispatcher.active_cancel is not None:
            self.dispatcher.active_cancel.set()
        self.ticks.close()

    def on_tick(self, tick: TickEvent) -> bool:
        return self.ticks.on_tick(tick)

    async def _tick_sink(self, tick: TickEvent) -> None:
        if not self.is_current():
            raise HostUnavailable("market-callback-lease-fenced")
        if self.nautilus is not None:
            await self.nautilus.process_tick(tick)
            if self.config["environment"] == "research" or self.ports.tick_qualifier is None:
                return
        if self.ports.tick_qualifier is None or self.transport is None or self.execution is None:
            raise HostUnavailable("qualified-market-feed-unavailable")
        async with self._actor:
            events = self.ports.tick_qualifier.market_events(tick, now_ns=self.clock.now_ns())
            output = await joined_thread(self.transport.advance, events, self.clock.now_ns())
            for event in output:
                await joined_thread(self.owner.ingest, event, received_ns=self.clock.now_ns())
            for key in dict.fromkeys(event.submission_key for event in output):
                await joined_thread(self.owner.reconcile_order, key, now_ns=self.clock.now_ns())

    async def mark_unavailable(self, reason: str) -> None:
        self.admissions.clear()
        self.rights.clear()
        if self.journal is not None:
            # Independent latch remains durable if public fact generation fails.
            await joined_thread(self.journal.latch_pause, "host-unavailable", now_ns=self.clock.now_ns())
        await joined_thread(self._readiness, "unavailable", [reason])

    def _readiness(self, state: str, reasons: list[str]) -> None:
        atomic_receipt(self.config["readinessReceiptPath"], {
            "format": "vertex-host-ready-v1", "releaseId": self.config["releaseId"],
            "instanceId": self.config["instanceId"], "accountAlias": self.config["accountAlias"],
            "environment": self.config["environment"], "journalIdentity": self.config["journalIdentity"],
            "liveExecution": False, "startupMode": self.config["startupMode"], "status": state,
            "observedAtNs": str(self.clock.now_ns()), "processId": os.getpid(), "reasonCodes": reasons,
        }, self.contracts)

    async def start(self) -> None:
        if self._started:
            raise HostUnavailable("host-start-already-attempted")
        self._started = True
        await joined_thread(self.owner_fence.open)
        from vertex_control import LoopBridge
        self.control_bridge = LoopBridge(asyncio.get_running_loop())
        await joined_thread(self._readiness, "unavailable", ["waiting-selected-lease"])
        if self.config["nativeAdmin"] is not None:
            if self.config["environment"] != "paper":
                raise HostUnavailable("native-admin-paper-only")
            from .native_admin import NativeAdminServer
            self.native_admin = NativeAdminServer(config=self.config["nativeAdmin"], host=self)
            await self.native_admin.start()
        self._background = [asyncio.create_task(self._projection_loop(), name="vertex-projections"),
                            asyncio.create_task(self._callback_loop(), name="vertex-tick-drain")]

    async def run(self) -> None:
        try:
            await self.start()
            dispatch = asyncio.create_task(self.dispatcher.run(), name="vertex-dispatcher")
            done, _ = await asyncio.wait((dispatch, *self._background), return_when=asyncio.FIRST_COMPLETED)
            if dispatch not in done:
                self.request_shutdown()
                await asyncio.gather(dispatch, return_exceptions=True)
                for task in done:
                    task.result()
                raise HostUnavailable("host-background-loop-ended")
            await dispatch
        finally:
            self.request_shutdown()
            await self.drain()

    async def _prepare(self, lease: dict[str, Any], cancellation: asyncio.Event) -> tuple[Callable[..., Any], dict[str, Any]]:
        self.admissions.clear()
        self.rights.clear()
        if self.ports.supervisor is not None and getattr(self.ports.supervisor, "quarantined", False):
            self.request_shutdown()
            raise HostUnavailable("sandbox-process-cleanup-unproven")
        selected, raw_inputs = await load_selection(control=self.control, authority=self.contracts, lease=lease,
            config=self.config, cache=self.cache, now_ns=self.clock.now_ns())
        if self.selection is not None and selected != self.selection:
            raise HostUnavailable("running-host-policy-selection-changed")
        self.selection, self.raw_inputs = selected, raw_inputs
        payload = canonical_object(self.contracts, await read_artifact(self.control, self.contracts, lease,
            lease["payloadArtifactId"], lease["payloadSha256"]))
        for policy in selected["policies"]:
            if policy["role"] == "licensing-rights":
                response = await self.control.current_rights(**fence(lease), collectionId=payload.get("collectionId"),
                    policyId=policy["policyId"], use="derive")
                self.rights.install(response, policy["policyId"])
        if self.adapter_config is None and lease["kind"] in ("research-run", "dataset-ingest", "knowledge-import"):
            from adapters.configuration import load_configuration
            from adapters.admission import create_host_admission
            self.adapter_config = load_configuration(selected, raw_inputs, self.contracts)
            self.shared_admission = create_host_admission(self.adapter_config, self.clock, self)
        if lease["kind"] in ("dataset-ingest", "knowledge-import", "backtest"):
            admitted = await self.control.admit_run(**fence(lease), runId=lease["jobId"], requestSha256=lease["payloadSha256"])
            self.contracts.validate("WorkerResult", admitted)
            if admitted["status"] not in ("accepted", "duplicate") or admitted["state"] != "running":
                raise HostUnavailable("worker-durable-admission-denied")
        if self.ports.supervisor is None and self.config["sandbox"] is not None:
            from .sandbox import load_sandbox
            self.ports.supervisor = load_sandbox(self.config["sandbox"], self.contracts, self.clock, self.work_cancellation)
        if self.ports.gateway_status is None:
            from .gateway_composition import create_gateway_ports
            self.ports.gateway_status = create_gateway_ports(selected, self.cache, self.contracts, self.clock)
        if self.nautilus is None and self.config["nautilus"] is not None:
            config = self.config["nautilus"]
            if type(config) is not dict or set(config) != {"distributionRoot"}:
                raise HostUnavailable("explicit-nautilus-distribution-root-required")
            from vertex_execution.adapters.nautilus_200rc5 import OfflineEngineScope
            from .nautilus import compose_nautilus
            self.nautilus = compose_nautilus(selected, self.cache, self.contracts, self.ticks,
                OfflineEngineScope(self.config["environment"]), clock=self.clock,
                distribution_root=config["distributionRoot"])
            await joined_thread(self.nautilus.activate)
        context = HostContext(selection=freeze(selected), contracts=self.contracts, control=self.control,
            secret_resolver=self.secret_resolver, clock=self.clock, cancellation=cancellation,
            supervisor=self.ports.supervisor or UnavailablePort("enforced-sandbox-unavailable"),
            publication=self.control, admission=self.shared_admission or UnavailablePort("shared-admission-unavailable"),
            endpoint_policies={}, chat_events=self.ports.chat_events or UnavailablePort("chat-delivery-unavailable"),
            adapter_config=self.adapter_config, control_bridge=self.control_bridge, lease=freeze(lease),
            ibkr_history=self.ports.ibkr_history)
        if lease["kind"] == "native-bootstrap":
            return self._bootstrap_handler, payload
        if lease["kind"] == "paper-simulation":
            if not self.bootstrap_completed or self.owner is None:
                raise HostUnavailable("explicit-native-bootstrap-required")
            result = await self.control.admit_run(**fence(lease), runId=lease["jobId"], requestSha256=lease["payloadSha256"])
            self.contracts.validate("WorkerResult", result)
            if result["status"] not in ("accepted", "duplicate") or result["state"] != "running":
                raise HostUnavailable("paper-run-durable-admission-denied")
            await self._open_paper(selected)
            return self._paper_handler, payload
        if lease["kind"] == "backtest":
            if self.ports.backtest_handler is not None:
                return self.ports.backtest_handler, payload
            from .research_engine import create_backtest_handler
            return create_backtest_handler(context, self.cache, raw_inputs, self.ports.supervisor), payload
        from adapters import create_handlers
        handlers = create_handlers(context)
        handler = handlers.get(lease["kind"])
        if handler is None:
            raise HostUnavailable("selected-handler-unavailable")
        # Handler execution rechecks provider/model availability; preparation
        # alone is not a successful provider probe or a completed research job.
        return handler, payload

    async def _open_paper(self, selected: dict[str, Any]) -> None:
        if self.owner is not None:
            return
        if self.kernel is None or selected["simulation"] is None:
            raise HostUnavailable("paper-kernel-or-selection-unavailable")
        config = self.config["paper"]
        required = {"currency", "streamId", "nativeEmitterActorId", "nativePolicyVersion", "projectionTtlNs"}
        if type(config) is not dict or set(config) != required:
            raise HostUnavailable("explicit-paper-runtime-policy-required")
        from .commands import QualifiedCommandDecoder
        from .evidence import QualifiedEvidencePort
        path = Path(self.config["journalPath"])
        exists = path.exists()
        if (self.config["startupMode"] == "initialize" and exists) or (self.config["startupMode"] == "restore" and not exists):
            raise HostUnavailable("explicit-journal-startup-mode-mismatch")
        self.journal = await joined_thread(Journal, path, authority=self.contracts,
            account_alias=self.config["accountAlias"], simulator_id=selected["simulation"]["simulatorId"], currency=config["currency"])
        try:
            from .epoch_transition import prior_projection_anchor
            self.prior_epoch, self.prior_projection = await joined_thread(prior_projection_anchor, self.journal)
            self.evidence = QualifiedEvidencePort(authority=self.contracts, cache=self.cache, selection=selected,
                rights=self.rights, ledger_head=self.journal, admission_authority=self.admissions)
            decoder = QualifiedCommandDecoder(authority=self.contracts, evidence=self.evidence)
            mutation = self.native_approval or DisabledMutationAuthority()
            observation = self.native_approval or DisabledObservationAuthority()
            self.transport = DurablePaperTransport(journal=self.journal, models=self.evidence.session_models(),
                provenance_id=self.evidence.provenance_id, decoder=decoder, mutation_authority=mutation,
                bounds=self.evidence.simulation_bounds())
            risk = NativeRiskPort(authority=self.contracts, evaluate=self.kernel.evaluate_json,
                                  evidence=self.evidence, journal_id=self.config["journalIdentity"])
            from .guards import LeaseBoundRisk, LeaseBoundPaperTransport
            risk = LeaseBoundRisk(risk, self.is_current)
            guarded_transport = LeaseBoundPaperTransport(self.transport, self.is_current)
            self.owner = await joined_thread(AtomicBatchOwner, journal=self.journal, authority=self.contracts,
                artifacts=self.cache, risk=risk, admission_authority=self.admissions,
                observation_authority=observation, mutation_authority=mutation, stream_id=config["streamId"],
                native_emitter_actor_id=config["nativeEmitterActorId"], native_policy_version=config["nativePolicyVersion"],
                projection_ttl_ns=int(config["projectionTtlNs"]), now_ns=self.clock.now_ns(), transport=guarded_transport)
            if self.native_approval is None and self.config["nativeApproval"] is not None:
                from .native_approval import NativeApprovalAuthority, NativeApprovalScope
                self.native_approval = await joined_thread(NativeApprovalAuthority.from_config, self.config["nativeApproval"],
                    authority=self.contracts, owner_scope=lambda: NativeApprovalScope(self.owner.epoch))
                capital = next((pin for pin in selected["policies"] if pin["role"] == "capital"), None)
                policy = self.native_approval.policy
                if (capital is None or policy.policy_id != capital["policyId"] or policy.policy_version != capital["version"]
                        or policy.policy_sha256 != capital["artifact"]["artifactSha256"]
                        or policy.account_alias != self.config["accountAlias"]
                        or policy.simulator_id != selected["simulation"]["simulatorId"] or policy.currency != config["currency"]):
                    raise HostUnavailable("native-approval-policy-selection-mismatch")
                await joined_thread(self.native_approval.open_configured, now_ns=self.clock.now_ns())
            if self.native_approval is not None:
                self.owner.observation_authority = self.native_approval
                self.owner.mutation_authority = self.native_approval
                from .native_approval_transport import SimulatorMutationAuthority
                self.transport.mutation_authority = SimulatorMutationAuthority(self.native_approval, self.journal)
            self.execution = AsyncExecutionService(self.owner)
            # Same AtomicBatchOwner IS the PaperExecutionOwner; never instantiate
            # a second claimant for single-leg work.
            operation = self.transport.initialize if self.config["startupMode"] == "initialize" else self.transport.restore
            await joined_thread(operation)
            from .epoch_store import EpochTransitionStore
            self.epoch_store = EpochTransitionStore(self.journal, self.contracts)
            await joined_thread(self.epoch_store.initialize)
            self.publisher = OrderedProjectionPublisher(self.journal, self.projection_port)
            # Restore reconciliation cannot erase unknown acceptance. Cash/seed
            # and reset require distinct, explicitly applied signed approvals.
            await joined_thread(self._readiness, "unavailable", ["native-reconciliation-and-human-approval-required"])
        except BaseException:
            self.request_shutdown()
            await joined_thread(self.journal.close)
            self.journal = None
            self.owner = None
            self.transport = None
            raise

    async def _bootstrap_handler(self, payload: dict[str, Any], lease: dict[str, Any]) -> dict[str, Any]:
        self.contracts.validate("WorkerBootstrapPayload", payload)
        if (payload["journalIdentity"] != self.config["journalIdentity"]
                or payload["simulatorId"] != self.selection["simulation"]["simulatorId"]
                or payload["streamId"] != self.config["paper"]["streamId"]
                or payload["selectionId"] != self.selection["selectionId"]
                or payload["selectionSha256"] != self.selection["selectionSha256"]
                or payload["mode"] != self.config["startupMode"] or lease["environment"] != "paper"):
            raise HostUnavailable("native-bootstrap-exact-runtime-mismatch")
        result = await self.control.admit_run(**fence(lease), runId=lease["jobId"], requestSha256=lease["payloadSha256"])
        self.contracts.validate("WorkerResult", result)
        if result["status"] not in ("accepted", "duplicate") or result["state"] != "running":
            raise HostUnavailable("bootstrap-durable-admission-denied")
        await self._open_paper(self.selection)
        # Bootstrap is a bounded local human-approval wait, not capital from the
        # queue. No seed, observation, reconciliation, genesis or reset is made
        # by this loop. Those enter only through independently signed local API.
        while self.is_current() and not self.work_cancellation.is_set():
            state, _, _ = await joined_thread(self.journal.snapshot)
            if (state["reconciled"] and state["observation"] is not None
                    and await joined_thread(self.journal.projection_head) != (0, None)
                    and await joined_thread(self.journal.next_projection) is None):
                self.bootstrap_completed = True
                await joined_thread(self._readiness, "ready", [])
                return {"status": "completed", "outputArtifactIds": [], "ownerEpoch": str(self.owner.epoch),
                        "riskRearmed": False, "brokerSubmissionAllowed": False}
            await self._sleep(0.25)
        raise HostUnavailable("native-bootstrap-expired-or-cancelled")

    async def _epoch_receipt(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        if self.epoch_store is None:
            raise HostUnavailable("durable-epoch-transition-store-unavailable")
        return await joined_thread(self.epoch_store.get, snapshot)

    async def prepare_epoch_approval(self, *, snapshot_id: str, max_age_ms: int) -> dict[str, Any]:
        """Return exact NONSECRET material for independent native signing."""
        from dataclasses import asdict
        from .epoch_transition import prepare_epoch_transition, candidate_genesis, transition_subject
        from .native_approval import approval_subject
        async with self._actor:
            if self.owner is None or self.prior_epoch <= 0 or self.native_approval is None or not self.is_current():
                raise HostUnavailable("restored-native-bootstrap-required")
            if self.dispatcher.active_lease["kind"] != "native-bootstrap":
                raise HostUnavailable("native-bootstrap-lease-required")
            now = self.clock.now_ns()
            await joined_thread(self.owner.finish_reconciliation, now_ns=now)
            prepared = await joined_thread(prepare_epoch_transition, self.journal,
                journal_identity=self.config["journalIdentity"], stream_id=self.config["paper"]["streamId"],
                prior_epoch=self.prior_epoch, prior_projection=self.prior_projection, now_ns=now)
            snapshot = candidate_genesis(prepared, authority=self.contracts, snapshot_id=snapshot_id,
                                         max_age_ms=max_age_ms, now_ns=now)
            subject = transition_subject(prepared, authority=self.contracts, snapshot=snapshot)
            self.pending_epoch = (prepared, snapshot, snapshot_id, max_age_ms, now)
            # No private keys or signatures are created. Policy/actor/expiry/
            # nonce remain independently selected by the enrolled approver.
            wire = {key: str(value) if type(value) is int else value for key, value in asdict(subject).items()}
            return {"format": "vertex-native-epoch-signing-material-v1", "subject": wire,
                    "approvalSubject": approval_subject(subject, authority=self.contracts),
                    "snapshot": snapshot, "outboxEvidenceSha256": prepared.outbox_sha256,
                    "ownerFenceSha256": prepared.owner_fence_sha256}

    async def commit_epoch_approval(self, *, signed_bytes: bytes, approval_id: str, transition_id: str) -> None:
        import base64
        from .epoch_transition import build_epoch_transition
        async with self._actor:
            if self.pending_epoch is None or self.native_approval is None or self.epoch_store is None or not self.is_current():
                raise HostUnavailable("prepared-current-native-epoch-required")
            prepared, snapshot, snapshot_id, max_age_ms, evaluated_ns = self.pending_epoch
            lease = self.dispatcher.active_lease
            if lease["kind"] != "native-bootstrap":
                raise HostUnavailable("native-bootstrap-lease-required")
            rights_pin = next((pin for pin in self.selection["policies"] if pin["role"] == "licensing-rights"), None)
            if rights_pin is None:
                raise HostUnavailable("epoch-proof-storage-rights-unavailable")
            current = await self.control.current_rights(**fence(lease), collectionId=None, policyId=rights_pin["policyId"], use="store")
            self.rights.install(current, rights_pin["policyId"])
            if not self.rights.permits(rights_pin["policyId"], rights_pin["version"], "store", self.clock.now_ns()):
                raise HostUnavailable("epoch-proof-storage-rights-denied")
            for identity, digest, raw in ((prepared.outbox_artifact_id, prepared.outbox_sha256, prepared.outbox_bytes),
                                         (prepared.owner_fence_artifact_id, prepared.owner_fence_sha256, prepared.owner_fence_bytes)):
                result = await self.control.stage_artifact(**fence(lease), collectionId=None, artifactId=identity,
                    contentBase64=base64.b64encode(raw).decode("ascii"), contentSha256=digest, canonicalSha256=digest,
                    contentType="application/json", rightsPolicyId=rights_pin["policyId"], rightsVersion=rights_pin["version"],
                    lineageArtifactIds=[])
                self.contracts.validate("WorkerStageArtifactOutput", result)
                if result["contentSha256"] != digest or result["canonicalSha256"] != digest:
                    raise HostUnavailable("epoch-proof-stage-identity-mismatch")
            await joined_thread(self.native_approval.install_approval, signed_bytes, now_ns=self.clock.now_ns())
            wrapper = await joined_thread(build_epoch_transition, prepared, journal=self.journal, snapshot=snapshot,
                transition_id=transition_id, approval_id=approval_id, approval_authority=self.native_approval, now_ns=self.clock.now_ns())
            # Store signed receipt BEFORE native genesis. Crash after this point
            # never falls back to an unsigned epoch publication. Approval burns
            # on local append failure; recovery requires independent review.
            await joined_thread(self.epoch_store.store, wrapper)
            actual = await joined_thread(self.owner.record_genesis, snapshot_id, max_age_ms, now_ns=evaluated_ns)
            if actual != snapshot:
                raise HostUnavailable("prepared-native-genesis-changed")
            self.pending_epoch = None
            await joined_thread(self.journal.checkpoint)

    async def prepare_replay_approval(self, *, grant_id: str, expires_at: str) -> dict[str, Any]:
        """Prepare exact old outbox bytes; no signature, publication, or ACK."""
        from .native_approval import NativeOutboxReplay, approval_subject
        from .replay import prepare_outbox_replay
        async with self._actor:
            if (self.owner is None or self.native_approval is None or self.prior_epoch <= 0
                    or not self.is_current() or self.dispatcher.active_lease["kind"] != "native-bootstrap"):
                raise HostUnavailable("restored-current-bootstrap-required")
            lease = self.dispatcher.active_lease
            first = await joined_thread(self.journal.next_projection)
            first_kind = await joined_thread(self.journal.next_projection_kind)
            if first is not None and first_kind == "portfolio-genesis":
                genesis = canonical_object(self.contracts, first[2])
                self.contracts.validate("PortfolioGenesis", genesis)
                if genesis["sequence"] != "1" or int(genesis["ownerEpoch"]) != self.prior_epoch:
                    raise HostUnavailable("exact-original-initial-genesis-required")
                # This is the predecessor of ACTUAL native bytes, not a claim
                # that cloud state is empty. Signed replay/DB checks absence or
                # exact existing prefix atomically. No unavailable error is
                # interpreted as an empty cloud stream.
                cloud_head = (0, None)
            else:
                continuity = await self.control.read_continuity(**fence(lease), streamId=self.config["paper"]["streamId"])
                self.contracts.validate("ProjectionContinuity", continuity)
                if (continuity["accountAlias"] != self.config["accountAlias"] or continuity["environment"] != "paper"
                        or continuity["streamId"] != self.config["paper"]["streamId"]
                        or int(continuity["ownerEpoch"]) != self.prior_epoch
                        or continuity["state"] not in ("empty", "continuous", "stale")):
                    raise HostUnavailable("exact-prior-cloud-continuity-required")
                cloud_head = (int(continuity["highWaterSequence"]), continuity["highWaterEventHash"])
            now = self.clock.now_ns()
            expires = self.contracts.epoch_ns(expires_at)
            if expires > self.contracts.epoch_ns(lease["deadlineAt"]):
                raise HostUnavailable("replay-grant-exceeds-work-deadline")
            prepared = await joined_thread(prepare_outbox_replay, self.journal,
                journal_identity=self.config["journalIdentity"], stream_id=self.config["paper"]["streamId"],
                prior_epoch=self.prior_epoch,
                cloud_head=cloud_head,
                service_actor_id=self.config["paper"]["nativeEmitterActorId"], grant_id=grant_id,
                now_ns=now, expires_ns=expires, maximum_batch_bytes=12_582_912,
                epoch_transition_lookup=self.epoch_store.get)
            self.pending_replay = prepared
            return {"format": "vertex-native-replay-signing-material-v1",
                "grant": json.loads(prepared.grant_binding_bytes),
                "approvalSubject": approval_subject(NativeOutboxReplay(prepared.grant_binding_bytes), authority=self.contracts)}

    async def _stage_replay_proofs(self, prepared: Any, lease: dict[str, Any]) -> None:
        import base64
        rights = next((pin for pin in self.selection["policies"] if pin["role"] == "licensing-rights"), None)
        if rights is None:
            raise HostUnavailable("replay-proof-storage-rights-unavailable")
        current = await self.control.current_rights(**fence(lease), collectionId=None, policyId=rights["policyId"], use="store")
        self.rights.install(current, rights["policyId"])
        if not self.rights.permits(rights["policyId"], rights["version"], "store", self.clock.now_ns()):
            raise HostUnavailable("replay-proof-storage-rights-denied")
        evidence = prepared.evidence
        for identity, digest, raw in ((evidence.outbox_artifact_id, evidence.outbox_sha256, evidence.outbox_bytes),
                                     (evidence.owner_fence_artifact_id, evidence.owner_fence_sha256, evidence.owner_fence_bytes)):
            result = await self.control.stage_artifact(**fence(lease), collectionId=None, artifactId=identity,
                contentBase64=base64.b64encode(raw).decode("ascii"), contentSha256=digest, canonicalSha256=digest,
                contentType="application/json", rightsPolicyId=rights["policyId"], rightsVersion=rights["version"],
                lineageArtifactIds=[])
            self.contracts.validate("WorkerStageArtifactOutput", result)
            if result["contentSha256"] != digest or result["canonicalSha256"] != digest:
                raise HostUnavailable("replay-proof-stage-identity-mismatch")

    async def commit_replay_approval(self, *, signed_bytes: bytes | None, grant_id: str) -> dict[str, Any]:
        """Explicit send/retry only; immutable receipt precedes possible effect."""
        from .replay import build_outbox_replay, replay_receipt, restore_replay_receipt, apply_outbox_replay_ack
        async with self._actor:
            if (self.epoch_store is None or self.native_approval is None or not self.is_current()
                    or self.dispatcher.active_lease["kind"] != "native-bootstrap"):
                raise HostUnavailable("restored-current-bootstrap-required")
            lease = self.dispatcher.active_lease
            if signed_bytes is not None:
                prepared = self.pending_replay
                if prepared is None or json.loads(prepared.grant_binding_bytes)["grantId"] != grant_id:
                    raise HostUnavailable("exact-prepared-replay-grant-required")
                await joined_thread(self.native_approval.install_approval, signed_bytes, now_ns=self.clock.now_ns())
                batch = await joined_thread(build_outbox_replay, prepared, journal=self.journal,
                    approval_authority=self.native_approval, now_ns=self.clock.now_ns())
                receipt = replay_receipt(prepared, authority=self.contracts)
                await joined_thread(self.epoch_store.store_replay, grant_id, receipt, batch)
            else:
                receipt, original = await joined_thread(self.epoch_store.get_replay, grant_id)
                prepared = restore_replay_receipt(receipt, authority=self.contracts)
                batch = await joined_thread(build_outbox_replay, prepared, journal=self.journal,
                    approval_authority=self.native_approval, now_ns=self.clock.now_ns())
                if batch != original:
                    raise HostUnavailable("replay-retry-bytes-changed")
            await self._stage_replay_proofs(prepared, lease)
            if not self.is_current():
                raise HostUnavailable("replay-lease-fenced-before-transmission")
            ack = await self.control.replay_native_outbox(**fence(lease), replay=batch)
            applied = await joined_thread(apply_outbox_replay_ack, self.journal, prepared, ack=ack)
            self.pending_replay = None
            return {"status": ack["status"], "acknowledgedRows": applied, "newRiskAuthorized": False}

    async def apply_native_approval(self, *, signed_bytes: bytes, subject: Any,
                                    seed_observation: Any = None) -> None:
        """Explicit LOCAL operator API only; never called by startup/job payloads.

        Cryptographic signer enrollment and revocation authority are independent
        of the service credential. Installing material alone never bootstraps or
        rearms. Replay is burned by the native approval audit, not a worker ACK.
        """
        from vertex_execution.capital import SimulationCapitalPolicy
        from vertex_execution.ports import PortfolioObservation, MutationGrant
        async with self._actor:
            if (self.owner is None or self.native_approval is None or not self.owner_fence.is_current()
                    or self.cancelled.is_set()):
                raise HostUnavailable("local-native-approval-owner-unavailable")
            if type(subject) is MutationGrant and not self.bootstrap_completed:
                raise HostUnavailable("native-bootstrap-must-complete-before-approved-mutation")
            now = self.clock.now_ns()
            await joined_thread(self.native_approval.install_approval, signed_bytes, now_ns=now)
            if type(subject) is SimulationCapitalPolicy:
                observation = seed_observation
                if (type(observation) is not PortfolioObservation
                        or observation.seed_policy_artifact_id != subject.artifact_id
                        or observation.seed_policy_sha256 != subject.artifact_sha256
                        or observation.account_alias != subject.account_alias
                        or observation.environment != "paper" or observation.simulator_id != subject.simulator_id
                        or observation.currency != subject.currency or observation.cash != subject.settled_cash
                        or observation.positions != () or observation.source_sequence != 1):
                    raise HostUnavailable("exact-approved-capital-observation-required")
                if await joined_thread(self.native_approval.verify, subject, now_ns=now) is not True:
                    raise HostUnavailable("native-capital-approval-denied")
                await joined_thread(self.owner.observe, observation, now_ns=now)
            elif type(subject) is PortfolioObservation:
                if seed_observation is not None:
                    raise HostUnavailable("unexpected-seed-observation")
                await joined_thread(self.owner.observe, subject, now_ns=now)
            elif type(subject) is MutationGrant:
                if seed_observation is not None:
                    raise HostUnavailable("unexpected-seed-observation")
                if subject.action == "reset-new-risk":
                    await joined_thread(self.owner.reset_new_risk, subject, now_ns=now)
                elif subject.action == "cancel-simulation":
                    await joined_thread(self.owner.cancel_simulation, subject.submission_key, subject, now_ns=now)
                elif subject.action == "request-liquidation":
                    await joined_thread(self.owner.request_liquidation, subject, now_ns=now)
                else:
                    raise HostUnavailable("unsupported-native-approved-action")
            else:
                raise HostUnavailable("typed-native-approval-subject-required")

    async def record_native_checkpoint(self, *, snapshot_id: str, max_age_ms: int, genesis: bool) -> None:
        """Explicit observed reconciliation; does not reset the native risk latch."""
        async with self._actor:
            if self.owner is None or self.cancelled.is_set() or not self.owner_fence.is_current():
                raise HostUnavailable("native-checkpoint-owner-unavailable")
            if genesis and self.prior_epoch > 0:
                raise HostUnavailable("signed-restored-epoch-transition-required")
            if not genesis and not self.bootstrap_completed:
                raise HostUnavailable("native-bootstrap-genesis-only")
            now = self.clock.now_ns()
            await joined_thread(self.owner.finish_reconciliation, now_ns=now)
            operation = self.owner.record_genesis if genesis else self.owner.record_portfolio_checkpoint
            await joined_thread(operation, snapshot_id, max_age_ms, now_ns=now)
            await joined_thread(self.journal.checkpoint)

    async def run_native_capture(self) -> None:
        """Explicit finite reviewed offline capture; never live engine startup."""
        if self.nautilus is None or not self.is_current() or self._nautilus_capture_attempted:
            raise HostUnavailable("native-capture-unavailable-or-already-attempted")
        self._nautilus_capture_attempted = True
        for tick in self.nautilus.captured_ticks():
            if not self.is_current():
                raise HostUnavailable("native-capture-fenced")
            # Same owning loop performs enqueue/drain. Backpressure waits rather
            # than overflowing and falsely asserting event continuity.
            while self.ticks.state().pending >= self.ticks.state().capacity:
                if not self.is_current():
                    raise HostUnavailable("native-capture-fenced")
                await self._sleep(0.01)
            if not self.on_tick(tick):
                raise HostUnavailable("native-capture-continuity-lost")
        while self.ticks.state().pending:
            if not self.is_current():
                raise HostUnavailable("native-capture-fenced")
            await self._sleep(0.01)

    async def _paper_handler(self, payload: dict[str, Any], lease: dict[str, Any]) -> dict[str, Any]:
        if type(payload) is not dict or set(payload) != {"format", "batchIdempotencyKey", "legs", "strategyArtifact"} or payload["format"] != "vertex-paper-job-v1":
            raise HostUnavailable("unsupported-private-paper-job")
        if type(payload["legs"]) is not list or not 1 <= len(payload["legs"]) <= 8:
            raise HostUnavailable("bounded-paper-leg-set-required")
        pairs = []
        for leg in payload["legs"]:
            if type(leg) is not dict or set(leg) != {"intentArtifactId", "intentSha256", "admissionId"}:
                raise HostUnavailable("exact-paper-leg-input-required")
            # On denial/role revocation no old acceptance survives this call.
            response = await self.control.current_paper_admission(**fence(lease), **leg)
            self.contracts.validate("WorkerCurrentPaperAdmissionOutput", response)
            admission, review, intent = response["admission"], response["review"], response["intent"]
            if response["intentArtifact"] != {"artifactId": leg["intentArtifactId"], "artifactSha256": leg["intentSha256"]} or admission["admissionId"] != leg["admissionId"]:
                raise HostUnavailable("server-paper-admission-pin-mismatch")
            for identity, contract, value in ((leg["intentArtifactId"], "TradeIntent", intent),
                    (admission["admissionId"], "PaperSimulationAdmission", admission), (review["reviewId"], "AcceptedReview", review)):
                raw = self.contracts.encode(value)
                self.cache.seal(Artifact(identity, contract, self.contracts.digest(value), raw))
            self.admissions.install(response, admission=admission, review=review)
            pairs.append((leg["intentArtifactId"], admission["admissionId"]))
        strategy = payload["strategyArtifact"]
        if type(strategy) is not dict or set(strategy) != {"artifactId", "artifactSha256"}:
            raise HostUnavailable("exact-strategy-pin-required")
        raw = await read_artifact(self.control, self.contracts, lease, strategy["artifactId"], strategy["artifactSha256"])
        self.cache.seal(Artifact(strategy["artifactId"], "StrategySpec", strategy["artifactSha256"], raw))
        async with self._actor:
            if not self.is_current() or self.owner is None:
                raise HostUnavailable("paper-worker-fenced")
            key = await joined_thread(self.owner.admit_batch, payload["batchIdempotencyKey"], tuple(pairs), now_ns=self.clock.now_ns())
            if not self.is_current():
                raise HostUnavailable("paper-worker-fenced-before-dispatch")
            events = await joined_thread(self.owner.dispatch_once, key, now_ns=self.clock.now_ns())
            for event in events:
                await joined_thread(self.owner.ingest, event, received_ns=self.clock.now_ns())
            terminal = await joined_thread(self.owner.reconcile_order, key, now_ns=self.clock.now_ns())
            state, _, _ = await joined_thread(self.journal.snapshot)
            order = state["orders"][key]
            if not terminal or order["status"] == "unknown":
                status = "unknown"
            else:
                status = "succeeded" if order["status"] == "filled" else "failed"
        # Drain exact outbox bytes while this admission still owns a live lease.
        # A remote ACK never changes terminal simulator economics.
        deadline = self.clock.monotonic() + self.config["worker"]["drainMilliseconds"] / 1000
        while self.publisher is not None and self.is_current() and self.clock.monotonic() < deadline:
            if not await self.publisher.publish_one():
                break
        if self.journal is not None and await joined_thread(self.journal.next_projection) is not None:
            status = "unknown"
        return {"status": status, "submissionKey": key, "outputArtifactIds": [], "brokerSubmissionAllowed": False}

    async def _projection_loop(self) -> None:
        while not self.cancelled.is_set():
            if self.publisher is not None and self.dispatcher.is_current():
                try:
                    async with self._actor:
                        pending = await joined_thread(self.journal.next_projection)
                        # Old persisted observations require the independently
                        # signed replay lane, not ordinary current-epoch rights.
                        eligible = pending is not None and int(json.loads(pending[2])["ownerEpoch"]) == self.owner.epoch
                        if eligible and await self.publisher.publish_one():
                            continue
                except Exception:
                    await self.mark_unavailable("projection-publication-unavailable")
            await self._sleep(0.25)

    async def _callback_loop(self) -> None:
        while not self.cancelled.is_set():
            try:
                await self.tick_drain.drain(256)
            except Exception:
                await self.mark_unavailable("tick-continuity-or-qualification-unavailable")
                # This buffer deliberately retains an uncommitted failed tick.
                # Never spin/retry an uncertain native effect on the same row.
                self.request_shutdown()
            await self._sleep(0.01)

    async def _sleep(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self.cancelled.wait(), timeout=delay)
        except TimeoutError:
            pass

    async def drain(self) -> None:
        if self._drained:
            return
        self.request_shutdown()
        await asyncio.gather(*self._background, return_exceptions=True)
        # No releasing owner while native work can still mutate. Processes that
        # cannot join remain held, and the release orchestrator refuses to switch.
        active = self.dispatcher.active_task
        if active is not None and not active.done():
            await asyncio.shield(active)
        if self._history_owner is not None:
            # Joins all retained native futures before releasing the host fence.
            # Missing durable outcome ACK or uncertain dispatch blocks clean drain.
            await self._history_owner.close()
        if self.native_admin is not None:
            await self.native_admin.close()
        pending, pending_dispatch = False, 0
        epoch = sequence = head = None
        async with self._actor:
            if self.journal is not None:
                await joined_thread(self.journal.latch_pause, "host-draining", now_ns=self.clock.now_ns())
                await joined_thread(self.journal.checkpoint)
                state, number, head = await joined_thread(self.journal.snapshot)
                epoch, sequence = str(self.journal.epoch), str(number)
                pending_dispatch = sum(1 for order in state["orders"].values()
                    if order["dispatchMarked"] and order["status"] not in ("filled", "cancelled", "rejected", "not-submitted"))
                pending = await joined_thread(self.journal.next_projection) is not None
                await joined_thread(self.journal.close)
        if self.native_approval is not None:
            await joined_thread(self.native_approval.close)
        if self.ports.gateway_status is not None:
            await joined_thread(self.ports.gateway_status.close)
        if self.nautilus is not None:
            await self.nautilus.close()
        if self.kernel is not None:
            await joined_thread(self.kernel.close)
        await joined_thread(self._readiness, "draining", ["host-stopped"])
        await joined_thread(self.owner_fence.close)
        self._drained = True
        # No matching explicit drain request means no deploy authorization receipt.
        try:
            request = canonical_object(self.contracts, read_regular(self.config["drainRequestPath"], 65536, secret=True), 65536)
        except FileNotFoundError:
            return
        if (set(request) != {"format", "requestId", "releaseId", "instanceId"}
                or request["format"] != "vertex-host-drain-request-v1"
                or request["releaseId"] != self.config["releaseId"] or request["instanceId"] != self.config["instanceId"]
                or type(request["requestId"]) is not str or not 1 <= len(request["requestId"]) <= 128):
            raise HostUnavailable("exact-release-drain-request-required")
        atomic_receipt(self.config["drainReceiptPath"], {
            "format": "vertex-host-drain-v1", "requestId": request["requestId"], "releaseId": self.config["releaseId"],
            "instanceId": self.config["instanceId"], "accountAlias": self.config["accountAlias"], "environment": self.config["environment"],
            "ownerEpoch": epoch, "journalSequence": sequence, "journalHeadSha256": head,
            "journalIdentity": self.config["journalIdentity"], "journalSchema": "vertex-execution-journal-v1" if self.journal else None,
            "projectionPending": pending, "pendingDispatch": pending_dispatch, "admissionsClosed": True,
            "activeJobs": 0, "ownerFenceReleased": True, "completedAtNs": str(self.clock.now_ns()),
            "outcome": "drained" if not pending and not pending_dispatch else "pending-publications",
        }, self.contracts)
