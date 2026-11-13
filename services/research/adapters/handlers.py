"""One Host dispatcher registry. No queue, poller, retry scheduler or SQL client."""
from __future__ import annotations

import asyncio
from dataclasses import fields, replace
from typing import Any, Mapping

from agents.budget import usd_units
from agents.evidence import identifier
from agents.orchestrator import ResearchOrchestrator
from agents.publication import AgentRunPublisher
from agents.types import AgentFault, Budget, RunRequest, Scope
from agents.wire import internal_value
from knowledge.collections import CollectionAdapters
from knowledge.papers import PaperInput, SSRNAdapter
from knowledge.service import KnowledgeService
from providers.boundary import Boundary, authorize
from providers.financialdatasets import FinancialDatasets
from providers.ibkr_history import HistoricalRequest, acquire_history
from providers.ports import RightRequest, Unavailable
from providers.quantdata import QuantData
from providers.quantpad import AuthorizedHistoricalInput, QuantPadInputBoundary
from vertex_market_data.normalization import MarketNormalizer, SourceContext
from vertex_market_data.observations import ProviderObservationPlanner
from vertex_market_data.service import DatasetPlanner

from .agno import create_model
from .configuration import AdapterConfiguration, OBSERVATION_RENDEZVOUS_PROFILE, NATIVE_EVIDENCE_PROFILE
from .decoders import IsolatedDecoders
from .historical import plan_historical, plan_ibkr_bars
from .http import HttpsTransport, SharedRateGate
from .model_use import ModelUseRequests
from .ports import AdapterUnavailable, EventCancellation, ResearchClock
from .review import CurrentUseGuard, ExistingChatDelivery, GuardedModel, OriginalEvidenceCache


UNAVAILABLE_QUANTDATA_ROLES = frozenset({"news", "dark-pool", "dealer-analytics"})


def _record(value: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - optional:
        raise AdapterUnavailable("job-shape-invalid")
    return dict(value)


def _dataclass(kind: Any, value: Any, *, exclude: tuple[str, ...] = ()) -> Any:
    keys = {f.name for f in fields(kind)} - set(exclude)
    return kind(**_record(value, keys))


def _unavailable(reason: str = "adapter-unavailable") -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason, "outputArtifactIds": [], "executionAuthorized": False}


class _Job:
    def __init__(self, context: Any, lease: Mapping[str, Any], *, collection_id: str | None = None,
                 snapshot_id: str | None = None, request: RunRequest | None = None):
        from vertex_control import ResearchContext, RunBinding, create_research_adapters
        self.context, self.lease = context, lease
        if context.contracts.validate("WorkerLease", lease, "1.0.0") is not True:
            raise AdapterUnavailable("lease-invalid")
        self.config = context.adapter_config
        if not isinstance(self.config, AdapterConfiguration):
            raise AdapterUnavailable("adapter-configuration-unavailable")
        self.selection = context.selection
        if (self.config.selection_id != lease["policySelectionId"]
                or self.config.selection_sha256 != lease["policySelectionSha256"]
                or self.selection["selectionId"] != self.config.selection_id
                or self.selection["selectionSha256"] != self.config.selection_sha256
                or self.selection["accountAlias"] != lease["accountAlias"]
                or self.selection["environment"] != lease["environment"]):
            raise AdapterUnavailable("selection-lease-mismatch")
        lease_deadline = context.contracts.epoch_ns(lease["deadlineAt"])
        self.deadline = lease_deadline if request is None else min(lease_deadline, request.deadline_ns)
        self.clock = ResearchClock(context.clock, context.contracts)
        self.cancel = EventCancellation(context.cancellation)
        self.boundary = Boundary(context.contracts, context.contracts)
        self.check()
        policies = [item for item in self.selection["policies"] if item["role"] == "licensing-rights"]
        if len(policies) != 1:
            raise AdapterUnavailable("rights-policy-unavailable")
        self.rights_policy = policies[0]
        fence = {key: lease[key] for key in ("accountAlias", "environment", "jobId", "leaseId", "leaseEpoch")}
        # This opaque identity is NOT permission; every concrete control operation
        # reauthenticates the service + principal/fence/current grants server-side.
        self.authorization = object()
        run_binding = None if request is None else RunBinding(
            run_id=request.run_id, trace_id=request.trace_id,
            request_digest=context.contracts.digest(internal_value(request)),
            token_budget=request.budget.tokens, cost_budget_usd=request.budget.usd)
        retention = [item for item in self.selection["policies"] if item["role"] == "retention"]
        retention_bindings = {} if len(retention) != 1 else {
            (self.rights_policy["policyId"], self.rights_policy["version"]): retention[0]["policyId"],
        }
        self.model_use = (ModelUseRequests(config=self.config, selection=self.selection, lease=lease, contracts=context.contracts)
                          if request is not None and self.config.model_use is not None else None)
        research_context = ResearchContext(fence=fence, actor_id=lease["researchPrincipalId"], authorization=self.authorization,
            clock=self.clock, deadline_ns=self.deadline, rights_policy_id=self.rights_policy["policyId"],
            rights_version=self.rights_policy["version"], collection_id=collection_id, snapshot_id=snapshot_id,
            run_binding=run_binding, retention_policy_bindings=retention_bindings,
            model_use_request_factory=None if self.model_use is None else self.model_use.eligibility)
        # Only the closed canonical/hash-pinned profile, after the original
        # selection/lease checks above, selects local final-check observations.
        self.control = create_research_adapters(client=context.control, bridge=context.control_bridge,
            context=research_context, rights_mode=("local-observation-v1"
                if self.config.profile in (OBSERVATION_RENDEZVOUS_PROFILE, NATIVE_EVIDENCE_PROFILE) else "legacy"))
        self.gate = SharedRateGate(context.admission, context.clock)
        self.http = None
        self.input_bytes = 0
        self.private_admitted_at: str | None = None
        self.decoders = IsolatedDecoders(supervisor=context.supervisor, clock=context.clock,
                                         cancellation=self.cancel, deadline_ns=self.deadline)

    def check(self) -> None:
        now = self.clock.now_ns()
        if (self.cancel.cancelled() or now >= self.deadline
                or not self.context.contracts.epoch_ns(self.selection["issuedAt"]) <= now < self.context.contracts.epoch_ns(self.selection["expiresAt"])):
            raise AdapterUnavailable("cancelled-or-selection-expired")

    def admit_private_research(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        """Use normal durable admission without inventing a model RunRequest."""
        from vertex_control.client import ControlError
        self.check()
        if (self.lease["kind"] != "research-run"
                or self.context.contracts.digest(payload) != self.lease["payloadSha256"]
                or (payload.get("actor_id"), payload.get("account_alias"), payload.get("environment"))
                != (self.lease["researchPrincipalId"], self.lease["accountAlias"], self.lease["environment"])):
            raise AdapterUnavailable("private-research-admission-binding-mismatch")
        try:
            response = self.control.artifacts.call("admitRun", runId=payload["run_id"],
                requestSha256=self.lease["payloadSha256"], deadline_ns=self.deadline, cancellation=self.cancel)
        except ControlError as error:
            status = "unknown" if error.effect == "unknown" else "unavailable"
            return {"status": status, "reason": "private-research-admission-" + status,
                    "outputArtifactIds": [], "executionAuthorized": False}
        # Existing recovery semantics permit an exact still-running duplicate.
        # The server binds runId/requestSha256 to this job and lease epoch; the
        # receipt must also preserve the current fence and immutable job inputs.
        current = response.get("lease")
        identity_fields = ("jobId", "eventId", "kind", "researchPrincipalId", "accountAlias", "environment",
                           "payloadArtifactId", "payloadSha256", "policySelectionId", "policySelectionSha256",
                           "deadlineAt", "leaseId", "leaseEpoch")
        if (response.get("jobId") != self.lease["jobId"]
                or response.get("status") not in ("accepted", "duplicate")
                or response.get("state") != "running" or not isinstance(current, Mapping)
                or any(current.get(key) != self.lease[key] for key in identity_fields)):
            status = "unavailable" if response.get("status") in ("rejected", "completed") else "unknown"
            return {"status": status, "reason": "private-research-admission-" + status,
                    "outputArtifactIds": [], "executionAuthorized": False}
        admitted_at = response.get("admittedAt")
        if admitted_at is not None:
            if (type(admitted_at) is not str or self.context.contracts.epoch_ns(admitted_at) > self.clock.now_ns()
                    or self.private_admitted_at is not None and self.private_admitted_at != admitted_at):
                raise AdapterUnavailable("private-research-admission-time-mismatch")
            self.private_admitted_at = admitted_at
        self.check()
        return None

    def transport(self) -> HttpsTransport:
        if self.http is None:
            self.http = HttpsTransport(policies=self.config.endpoint_policies, secrets=self.context.secret_resolver,
                budget=self.gate, clock=self.context.clock, timestamps=self.clock,
                cancellation=self.cancel, deadline_ns=self.deadline, authorize_endpoint=self.authorize_endpoint)
        return self.http

    def authorize_endpoint(self, endpoint: Any) -> None:
        self.check()
        matches = [fact for fact in self.selection["providerCapabilities"]
                   if fact["endpointReferenceId"] == endpoint.endpoint_id
                   and fact["providerId"] == endpoint.provider and fact["operation"] == endpoint.operation]
        now = self.clock.now_ns()
        if (len(matches) != 1 or matches[0]["state"] != "ready"
                or not self.context.contracts.epoch_ns(matches[0]["observedAt"]) <= now
                < self.context.contracts.epoch_ns(matches[0]["expiresAt"])):
            raise AdapterUnavailable("endpoint-current-capability-unavailable")
        if endpoint.operation in ("model-tokenize", "model-completion"):
            # Storage read remains independently required, but is NOT model-use
            # permission; HttpsTransport also requires an exact-input proof callback.
            self.control.rights.current(endpoint.policy_id, ("read",))
        else:
            authorize(self.control.rights, RightRequest(endpoint.provider, endpoint.policy_id, endpoint.operation, self.clock.now()))

    def artifact(self, reference: Any, *, collection_id: str | None = None) -> bytes:
        value = _record(reference, {"artifactId", "sha256"})
        self.check()
        content = self.control.artifacts.read(artifact_id=value["artifactId"], expected_digest=value["sha256"], collection_id=collection_id)
        # Enforce before returning raw bytes to eager collection planners; their
        # later aggregate check cannot protect the Host from 1000 retained blobs.
        if not isinstance(content, bytes) or len(content) > 1_048_576 or self.input_bytes + len(content) > 16_000_000:
            raise AdapterUnavailable("job-input-aggregate-budget")
        self.input_bytes += len(content)
        return content

    def capability(self, *, provider: str, operation: str, model_version: str | None = None) -> None:
        now = self.clock.now_ns()
        matches = [v for v in self.selection["providerCapabilities"]
                   if v["providerId"] == provider and v["operation"] == operation and v["modelVersion"] == model_version]
        if len(matches) != 1 or matches[0]["state"] != "ready" or not self.context.contracts.epoch_ns(matches[0]["observedAt"]) <= now < self.context.contracts.epoch_ns(matches[0]["expiresAt"]):
            raise AdapterUnavailable("provider-capability-unavailable")
        # State is not permission: current rights are checked independently now,
        # before transport/parsing and again by publication's control transaction.
        if operation in ("model-tokenize", "model-completion"):
            self.control.rights.current(matches[0]["rightsPolicyId"], ("read",))
        else:
            authorize(self.control.rights, RightRequest(provider, matches[0]["rightsPolicyId"], operation, self.clock.now()))

    def publish_dataset(self, plan: Any) -> dict[str, Any]:
        if isinstance(plan, Unavailable):
            return _unavailable(plan.reason)
        self.check()
        receipt = self.control.datasets.publish(plan)
        if not isinstance(receipt, dict) or receipt.get("status") not in ("accepted", "duplicate", "completed"):
            return {"status": "unknown", "reason": "dataset-publication-unknown", "outputArtifactIds": [], "executionAuthorized": False}
        return {"status": "completed", "outputArtifactIds": [plan.manifest.decode()["datasetId"]],
                "manifestSha256": plan.manifest.digest, "executionAuthorized": False}


def _dataset(context: Any, payload: dict[str, Any], lease: Mapping[str, Any]) -> dict[str, Any]:
    row = _record(payload, {"profile", "provider", "operation", "request", "sourceContext", "publication"})
    if row["profile"] != "vertex-dataset-ingest-v1":
        return _unavailable("dataset-profile-unavailable")
    job = _Job(context, lease)
    provider, operation = row["provider"], row["operation"]
    if provider == "quantdata" and operation in UNAVAILABLE_QUANTDATA_ROLES:
        return _unavailable("quantdata-endpoint-semantics-or-entitlement-unavailable")
    job.capability(provider=provider, operation=operation)
    publication = _record(row["publication"], {"dataset_id", "storage_ref", "start_at", "end_at", "as_of_at", "retention_policy", "require_point_in_time"})
    source = _dataclass(SourceContext, row["sourceContext"])
    config = job.config.providers.get(provider)
    if config is None or config.enabled is not True or provider not in ("financialdatasets", "quantdata"):
        return _unavailable("provider-configuration-unavailable")
    adapter = (FinancialDatasets if provider == "financialdatasets" else QuantData)(
        config=config, boundary=job.boundary, clock=job.clock, rights=job.control.rights,
        transport=job.transport(), budget=job.gate)
    parameters = _record(row["request"], set(), {"symbol", "start_date", "end_date", "interval", "period", "filing_type", "accession_number", "item",
        "start_at", "end_at", "aggregation_period", "snapshot_at", "expiration_date", "strike", "contract_type", "filters"})
    if operation == "screener" and provider == "financialdatasets":
        plan = adapter.screener_plan(parameters["filters"])
    else:
        plan = adapter.request_plan(operation, **parameters)
    if isinstance(plan, Unavailable):
        return _unavailable(plan.reason)
    capture = adapter.client.capture(plan)
    if isinstance(capture, Unavailable):
        return _unavailable(capture.reason)
    records = adapter.records(capture)
    if isinstance(records, Unavailable):
        return _unavailable(records.reason)
    job.check()
    if operation == "equity-bars":
        calendar = job.config.calendars.get(source.calendar)
        if calendar is None:
            return _unavailable("selected-calendar-unavailable")
        normalizer = MarketNormalizer(boundary=job.boundary, clock=job.clock, rights=job.control.rights, calendar=calendar)
        normalized = normalizer.candles(capture, records, source, interval=parameters.get("interval", parameters.get("aggregation_period")))
        if isinstance(normalized, Unavailable):
            return _unavailable(normalized.reason)
        result = DatasetPlanner(boundary=job.boundary, clock=job.clock, rights=job.control.rights).plan(
            captures=(capture,), records=normalized, contexts=(source,), **publication)
    else:
        if publication["as_of_at"] != source.as_of_at:
            raise AdapterUnavailable("dataset-source-cutoff-mismatch")
        arguments = {key: value for key, value in publication.items() if key != "as_of_at"}
        result = ProviderObservationPlanner(boundary=job.boundary, clock=job.clock, rights=job.control.rights).plan(capture, source, **arguments)
    return job.publish_dataset(result)


async def _ibkr_history(context: Any, payload: dict[str, Any], lease: Mapping[str, Any]) -> dict[str, Any]:
    """Use the injected restricted owner on its loop; control work stays off-loop."""
    def prepare() -> tuple[_Job, dict[str, Any], HistoricalRequest]:
        row = _record(payload, {"profile", "request", "publication"})
        if row["profile"] != "vertex-ibkr-history-ingest-v1" or lease["environment"] != "research":
            raise AdapterUnavailable("ibkr-history-profile-unavailable")
        job = _Job(context, lease)
        publication = _record(row["publication"], {"dataset_id", "storage_ref", "instrument_id",
            "rights_policy_id", "retention_policy"})
        if publication["rights_policy_id"] != job.rights_policy["policyId"]:
            raise AdapterUnavailable("ibkr-history-rights-selection-mismatch")
        original = HistoricalRequest(job.boundary.encode(row["request"]))
        request = original.decode()
        if request["kind"]["type"] != "bars":
            raise AdapterUnavailable("ibkr-ticks-require-separate-profile")
        refresh(job)
        # The SDK's 4MiB cap is NOT the worker's transport/storage cap. Keep its
        # exact 1MiB immutable artifact limit; never silently truncate a capture.
        from vertex_control.adapters import MAX_ARTIFACT_BYTES
        request["limits"]["max_bytes"] = min(request["limits"]["max_bytes"], MAX_ARTIFACT_BYTES)
        remaining_ms = (job.deadline - job.clock.now_ns()) // 1_000_000
        # Reserve half the remaining job time for fenced intent/outcome I/O.
        # This is a local budget policy, not a provider pacing/coverage claim.
        request["limits"]["timeout_ms"] = min(request["limits"]["timeout_ms"], remaining_ms // 2)
        bounded = HistoricalRequest(job.boundary.encode(request))
        intent_id = "ibkr-history-intent-" + context.contracts.digest(
            {"jobId": lease["jobId"], "requestSha256": bounded.sha256})
        job.control.artifacts.stage(artifact_id=intent_id,
            content=bounded.data, content_type="application/json", canonical_digest=bounded.sha256)
        refresh(job)
        # Intent I/O consumed budget. Never submit the earlier bound if it can
        # now outlive the job; the intent must pin the bytes actually dispatched.
        if job.clock.now_ns() + bounded.decode()["limits"]["timeout_ms"] * 1_000_000 > job.deadline:
            raise AdapterUnavailable("ibkr-history-intent-exhausted-deadline")
        return job, publication, bounded

    def refresh(job: _Job) -> None:
        job.check()
        selected = job.control.artifacts.call("policySelection", selectionId=lease["policySelectionId"],
            selectionSha256=lease["policySelectionSha256"], cancellation=job.cancel)
        # Host selection is frozen MappingProxy/tuple; hash the returned plain
        # canonical body against its exact pinned digest, never encode proxies.
        if (selected["selectionSha256"] != lease["policySelectionSha256"]
                or context.contracts.digest({key: value for key, value in selected.items()
                                             if key != "selectionSha256"}) != lease["policySelectionSha256"]):
            raise AdapterUnavailable("ibkr-history-current-selection-mismatch")
        job.capability(provider="ibkr", operation="historical-bars")
        facts = [fact for fact in job.selection["providerCapabilities"]
                 if fact["providerId"] == "ibkr" and fact["operation"] == "historical-bars"]
        if (len(facts) != 1 or facts[0]["rightsPolicyId"] != job.rights_policy["policyId"]
                or facts[0]["rightsPolicyVersion"] != job.rights_policy["version"]):
            raise AdapterUnavailable("ibkr-history-capability-rights-mismatch")

    job, publication, request = await asyncio.to_thread(prepare)
    try:
        captured = await acquire_history(context.ibkr_history, request, cancellation=context.cancellation)
    except Exception:
        return {"status": "unknown", "reason": "ibkr-history-dispatch-or-capture-unconfirmed",
                "outputArtifactIds": [], "executionAuthorized": False}

    def retain() -> dict[str, Any]:
        # Retain the exact returned capture BEFORE ordinary completion/validity
        # checks, including incomplete outcomes. Expired/revoked fences still
        # deny staging; an owner must retain/quarantine any unacknowledged result.
        return job.control.artifacts.stage(artifact_id="blob-" + captured.content.digest,
            content=captured.content.data, content_type=captured.content.media_type)

    def publish() -> dict[str, Any]:
        value = captured.decode()
        if not all(value[key] for key in ("source_response_complete", "capture_complete", "data_valid")):
            return _unavailable("ibkr-history-capture-unqualified")
        try:
            refresh(job)
            planned = plan_ibkr_bars(captured, request=request, boundary=job.boundary,
                rights=job.control.rights, clock=job.clock, publication=publication, producer_job_id=lease["jobId"])
            refresh(job)
        except Exception:
            # Original outcome is durably staged and acknowledged. Invalid or
            # missing terminal windows/semantics have no DatasetManifest output.
            return _unavailable("ibkr-bars-dataset-qualification-unavailable")
        return job.publish_dataset(planned)

    try:
        staged = await asyncio.to_thread(retain)
        if staged != {"artifactId": "blob-" + captured.content.digest, "artifactSha256": captured.content.digest}:
            raise AdapterUnavailable("ibkr-history-retention-receipt-mismatch")
        # Trusted owner releases its retained bytes only after the exact fenced
        # store receipt. This is NOT a broker cancellation acknowledgement.
        await context.ibkr_history.acknowledge_capture(request_sha256=request.sha256,
            capture_sha256=captured.content.digest, stage_artifact_id=staged["artifactId"])
        return await asyncio.to_thread(publish)
    except Exception:
        # A returned capture is not proof of durable archival after cancellation,
        # lease expiry or an unknown stage ACK. No successful output is invented.
        return {"status": "unknown", "reason": "ibkr-history-outcome-retention-or-publication-unconfirmed",
                "outputArtifactIds": [], "executionAuthorized": False}


def _historical(context: Any, payload: dict[str, Any], lease: Mapping[str, Any]) -> dict[str, Any]:
    row = _record(payload, {"profile", "input", "artifact", "current_session_start", "dataset_id", "storage_ref", "instrument_universe", "adjustment_method"})
    job = _Job(context, lease)
    job.capability(provider="quantpad", operation="historical-authorized-input")
    source = _record(row["input"], {f.name for f in fields(AuthorizedHistoricalInput)} - {"data"})
    data = job.artifact(row["artifact"])
    if source["expected_digest"] != row["artifact"]["sha256"]:
        raise AdapterUnavailable("historical-digest-binding-mismatch")
    boundary = QuantPadInputBoundary(boundary=job.boundary, clock=job.clock, rights=job.control.rights,
                                     decoder=job.decoders, enabled=True, maximum_bytes=1_048_576)
    captured = boundary.accept(AuthorizedHistoricalInput(data=data, **source), current_session_start=row["current_session_start"])
    if isinstance(captured, Unavailable):
        return _unavailable(captured.reason)
    planned = plan_historical(captured, boundary=job.boundary, rights=job.control.rights, clock=job.clock,
        dataset_id=row["dataset_id"], storage_ref=row["storage_ref"], instrument_universe=tuple(row["instrument_universe"]),
        adjustment_method=row["adjustment_method"])
    return job.publish_dataset(planned)


def _knowledge(context: Any, payload: dict[str, Any], lease: Mapping[str, Any]) -> dict[str, Any]:
    row = _record(payload, {"profile", "collection_id", "snapshot_id", "expected_snapshot_id", "rights_policy_id", "captured_at", "input"})
    if row["profile"] != "vertex-knowledge-import-v1":
        return _unavailable("knowledge-profile-unavailable")
    collection = row["collection_id"]
    job = _Job(context, lease, collection_id=collection, snapshot_id=row["snapshot_id"])
    adapters = CollectionAdapters(job.boundary, clock=job.clock, rights=job.control.rights, maximum_ledger_bytes=1_048_576)
    if collection == "ssrn":
        incoming = _record(row["input"], {"paper", "artifact"})
        metadata = _record(incoming["paper"], {f.name for f in fields(PaperInput)} - {"data"})
        if metadata["expected_digest"] != incoming["artifact"]["sha256"] or metadata["rights_policy_id"] != row["rights_policy_id"] or metadata["captured_at"] != row["captured_at"]:
            raise AdapterUnavailable("paper-scope-mismatch")
        metadata["authors"] = tuple(metadata["authors"])
        prepared = SSRNAdapter(boundary=job.boundary, clock=job.clock, rights=job.control.rights,
                               parser=job.decoders, maximum_bytes=1_048_576).prepare(PaperInput(
                                   data=job.artifact(incoming["artifact"], collection_id=collection), **metadata))
        sources = prepared if isinstance(prepared, Unavailable) else (prepared,)
    elif collection in ("deltatrendtrading", "verrillo-aleks", "define-your-risk", "jay-medrow"):
        incoming = _record(row["input"], {"manifest", "transcripts"})
        if not isinstance(incoming["transcripts"], dict) or len(incoming["transcripts"]) > 1000:
            raise AdapterUnavailable("transcript-membership-budget")
        def load_transcript(source_id: str) -> bytes | None:
            # Manifest-controlled filenames/URLs are never opened. Only explicit
            # artifact references already authorized for this collection can load.
            reference = incoming["transcripts"].get(source_id)
            return None if reference is None else job.artifact(reference, collection_id=collection)
        planner = {"deltatrendtrading": adapters.delta_trend, "verrillo-aleks": adapters.verrillo_aleks,
                   "define-your-risk": adapters.define_your_risk, "jay-medrow": adapters.jay_medrow}[collection]
        sources = planner(job.artifact(incoming["manifest"], collection_id=collection), load_transcript,
                          captured_at=row["captured_at"], rights_policy_id=row["rights_policy_id"])
    elif collection == "nicholas-crown":
        if isinstance(row["input"], dict) and "bundles" in row["input"]:
            incoming = _record(row["input"], {"bundles"})
            references = incoming["bundles"]
            if not isinstance(references, list) or not 1 <= len(references) <= 32:
                raise AdapterUnavailable("crown-bundle-membership-budget")
            references = [_record(reference, {"artifactId", "sha256"}) for reference in references]
            if (any(not isinstance(reference["artifactId"], str) or not isinstance(reference["sha256"], str)
                    for reference in references)
                    or len({reference["artifactId"] for reference in references}) != len(references)
                    or len({reference["sha256"] for reference in references}) != len(references)):
                raise AdapterUnavailable("crown-bundle-reference-duplicate")
            # The reviewed recipe pins every chunk. All reads retain their
            # collection rights, per-artifact and cumulative job-byte guards.
            chunks = tuple(job.artifact(reference, collection_id=collection) for reference in references)
            job.check()
            sources = adapters.crown_chunks(chunks, captured_at=row["captured_at"], rights_policy_id=row["rights_policy_id"])
        else:
            incoming = _record(row["input"], {"bundle"})
            sources = adapters.crown(job.artifact(incoming["bundle"], collection_id=collection),
                                     captured_at=row["captured_at"], rights_policy_id=row["rights_policy_id"])
    else:
        return _unavailable("collection-identity-unavailable")
    if isinstance(sources, Unavailable):
        return _unavailable(sources.reason)
    service = KnowledgeService(boundary=job.boundary, clock=job.clock, rights=job.control.rights, store=job.control.collections)
    plan = service.plan(collection, row["snapshot_id"], sources, rights_policy_id=row["rights_policy_id"], expected_snapshot_id=row["expected_snapshot_id"])
    if isinstance(plan, Unavailable):
        return _unavailable(plan.reason)
    job.check()
    receipt = service.publish(plan)
    if isinstance(receipt, Unavailable):
        return _unavailable(receipt.reason)
    return {"status": "completed", "collectionId": receipt.collection_id, "snapshotId": receipt.snapshot_id,
            "manifestSha256": receipt.manifest_digest, "outputArtifactIds": [], "executionAuthorized": False}


def _research(context: Any, payload: dict[str, Any], lease: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("profile") == "vertex-research-chat-native-evidence-job-v1":
        from .native_evidence_consumer import decode_native_evidence_recipe, run_native_evidence_chat
        recipe = decode_native_evidence_recipe(payload, contracts=context.contracts)
        if context.cancellation.is_set():
            return {"status": "cancelled", "reason": "chat-response-cancelled",
                    "outputArtifactIds": [], "executionAuthorized": False}
        return run_native_evidence_chat(_Job(context, lease), recipe)
    if payload.get("profile") in ("vertex-research-chat-job-v1", "vertex-research-chat-job-v2"):
        from .chat_consumer import decode_chat_recipe, decode_chat_recipe_v2, run_research_chat
        decoder = decode_chat_recipe_v2 if payload["profile"] == "vertex-research-chat-job-v2" else decode_chat_recipe
        recipe = decoder(payload, contracts=context.contracts)
        if context.cancellation.is_set():
            return {"status": "cancelled", "reason": "chat-response-cancelled",
                    "outputArtifactIds": [], "executionAuthorized": False}
        # Strict original queued-run/max pins are required before _Job exists.
        # The composed output owner then preflights real reads/rights/envelope
        # capacity before any durable model admission or provider disclosure.
        return run_research_chat(_Job(context, lease), recipe)
    if payload.get("profile") == "vertex-paper-lab-job-v1":
        from .paper_lab import run_paper_lab
        recipe = payload.get("recipe")
        if not isinstance(recipe, dict):
            raise AdapterUnavailable("paper-lab-recipe-unavailable")
        return run_paper_lab(_Job(context, lease, collection_id=recipe.get("collection_id"),
                                 snapshot_id=recipe.get("snapshot_id")), payload)
    if payload.get("profile") == "vertex-sleeve-research-v1":
        from .sleeve_research import run_sleeve_research
        recipe = payload.get("recipe")
        if not isinstance(recipe, dict):
            raise AdapterUnavailable("sleeve-recipe-unavailable")
        return run_sleeve_research(_Job(context, lease, collection_id=recipe.get("collection_id"),
                                       snapshot_id=recipe.get("snapshot_id")), payload)
    if payload.get("profile") == "vertex-quant-experiment-job-v1":
        from .quant_experiment import run_quant_experiment
        recipe = payload.get("recipe")
        if not isinstance(recipe, dict):
            raise AdapterUnavailable("quant-experiment-recipe-unavailable")
        return run_quant_experiment(_Job(context, lease, collection_id=recipe.get("collection_id")), payload)
    if payload.get("profile") == "vertex-gamma-research-v1":
        from .gamma import run_gamma
        recipe = payload.get("recipe")
        if not isinstance(recipe, dict):
            raise AdapterUnavailable("gamma-recipe-unavailable")
        return run_gamma(_Job(context, lease, collection_id=recipe.get("collection_id"),
                              snapshot_id=recipe.get("snapshot_id")), payload)
    row = _record(payload, {"profile", "request", "thread_id"})
    if row["profile"] != "vertex-research-run-v1":
        return _unavailable("research-profile-unavailable")
    value = _record(row["request"], {f.name for f in fields(RunRequest)})
    for name in ("reference_ns", "deadline_ns", "per_attempt_timeout_ns", "max_evidence_age_ns"):
        encoded = value[name]
        if (not isinstance(encoded, str) or not encoded.isascii() or not encoded.isdecimal()
                or not 1 <= len(encoded) <= 30 or len(encoded) > 1 and encoded.startswith("0")):
            raise AdapterUnavailable("research-nanosecond-encoding-invalid")
        value[name] = int(encoded)
    value["budget"] = _dataclass(Budget, value["budget"])
    if not isinstance(value["scopes"], list) or not 1 <= len(value["scopes"]) <= 8:
        raise AdapterUnavailable("research-scope-budget")
    value["scopes"] = tuple(_dataclass(Scope, s) for s in value["scopes"])
    try:
        collections = {identifier(scope.collection_id) for scope in value["scopes"]}
        for scope in value["scopes"]:
            identifier(scope.snapshot_id)
    except AgentFault:
        raise AdapterUnavailable("research-collection-scope-invalid") from None
    if len(collections) != 1 or len(set(value["scopes"])) != len(value["scopes"]):
        raise AdapterUnavailable("research-collection-scope-invalid")
    collection_id = next(iter(collections))
    for name in ("allowed_tools", "phases"):
        value[name] = tuple(value[name])
    request = RunRequest(**value)
    if ((request.actor_id, request.account_alias, request.environment) != (lease["researchPrincipalId"], lease["accountAlias"], lease["environment"])
            or request.deadline_ns > context.contracts.epoch_ns(lease["deadlineAt"])):
        raise AdapterUnavailable("research-principal-scope-mismatch")
    # The admitted request pins a collection, not one arbitrarily selected
    # snapshot. Multiple distinct snapshots in that collection remain valid.
    job = _Job(context, lease, collection_id=collection_id, request=request)
    config = job.selection["research"]
    model_policy = job.config.model
    if config is None or model_policy is None:
        return _unavailable("selected-model-unavailable")
    if (request.model_version != config["modelVersion"] or request.model_version != model_policy.model_version
            or request.task_contract != config["taskContract"] or request.budget.tokens > config["tokenBudget"]
            or usd_units(request.budget.usd) > usd_units(config["costBudgetUsd"])
            or not set(request.allowed_tools) <= set(config["allowedTools"])):
        raise AdapterUnavailable("research-selection-mismatch")
    capability = next((v for v in job.selection["providerCapabilities"] if v["capabilityId"] == config["modelCapabilityId"]), None)
    if capability is None:
        return _unavailable("selected-model-unavailable")
    job.capability(provider=capability["providerId"], operation=capability["operation"], model_version=request.model_version)
    retrieval = OriginalEvidenceCache(job.control.retrieval)
    guard = CurrentUseGuard(request=request, originals=retrieval, rights=job.control.rights,
                            contracts=context.contracts, time=job.clock, authorization=job.authorization)
    model = create_model(policy=model_policy, endpoints=job.config.endpoint_policies, http=job.transport(), gate=job.gate,
                          admission=context.admission, clock=context.clock, timestamps=job.clock,
                          rights=job.control.rights, cancellation=job.cancel, before_disclosure=guard.before_disclosure,
                          model_use_requests=job.model_use)
    runner = ResearchOrchestrator(model=GuardedModel(model, guard), retrieval=retrieval, validator=context.contracts,
        codec=context.contracts, rights=job.control.rights, time=job.clock, cancellation=job.cancel,
        authorization=job.authorization, admission=job.control.admission)
    result = runner.run(request)
    job.check()
    if result.status == "completed":
        guard.check(result.evidence)
    result = AgentRunPublisher(validator=context.contracts, codec=context.contracts, store=job.control.artifacts,
                              time=job.clock, cancellation=job.cancel).publish(request=request, result=result, reference_ns=job.clock.now_ns())
    chat_status = "unavailable"
    if context.chat_events is not None and row["thread_id"] is not None:
        try:
            chat_status = ExistingChatDelivery(context.chat_events, guard).deliver(thread_id=row["thread_id"], result=result, deadline_ns=job.deadline)
        except Exception:
            # Research publication is already durable; optional chat unavailability
            # must never erase its artifact identities or falsely retry compute.
            chat_status = "unknown"
    if result.publication_status != "published":
        return {"status": "unknown" if result.publication_status == "unknown" else "unavailable",
                "reason": "research-publication-" + result.publication_status, "outputArtifactIds": [], "executionAuthorized": False}
    outcome = {"completed": "completed", "cancelled": "cancelled", "failed": "failed", "blocked": "unavailable"}.get(result.status, "unavailable")
    return {"status": outcome, "runStatus": result.status, "outputArtifactIds": list(result.artifact_ids),
            "chatStatus": chat_status, "executionAuthorized": False}


def create_handlers(host_context: Any) -> dict[str, Any]:
    """Sync registry construction; each callable is async handler(payload, lease)."""
    def bind(kind: str, effect: Any) -> Any:
        async def handler(payload: dict[str, Any], lease: dict[str, Any]) -> dict[str, Any]:
            if lease.get("kind") != kind:
                return _unavailable("handler-kind-mismatch")
            if kind == "dataset-ingest" and payload.get("profile") == "vertex-ibkr-history-ingest-v1":
                try:
                    if host_context.contracts.digest(payload) != lease["payloadSha256"]:
                        return _unavailable("job-payload-digest-mismatch")
                    return await _ibkr_history(host_context, payload, lease)
                except Exception:
                    return _unavailable("ibkr-history-acquisition-unavailable")
            def invoke() -> dict[str, Any]:
                try:
                    if host_context.contracts.digest(payload) != lease["payloadSha256"]:
                        return _unavailable("job-payload-digest-mismatch")
                    if kind == "dataset-ingest" and payload.get("profile") == "vertex-historical-input-v1":
                        return _historical(host_context, payload, lease)
                    return effect(host_context, payload, lease)
                except Exception:
                    # Never expose source snippets, provider URLs/headers, SDK or
                    # parser errors; a failed effect is not a completed job.
                    return _unavailable()
            return await asyncio.to_thread(invoke)
        return handler
    return {"research-run": bind("research-run", _research), "dataset-ingest": bind("dataset-ingest", _dataset),
            "knowledge-import": bind("knowledge-import", _knowledge)}
