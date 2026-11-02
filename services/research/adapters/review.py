"""Original evidence bytes + fresh exact-hash CURRENT review at every use."""
from __future__ import annotations

from dataclasses import asdict, replace
from typing import Any

from agents.adapters import ExistingChatAdapter
from agents.evidence import EvidenceGate, check_freshness
from agents.types import AgentFault, Evidence, RetrievalResult, RunRequest, RunResult, Scope, StagedCitation


class OriginalEvidenceCache:
    """Per-run byte preservation, never an authorization cache."""
    def __init__(self, retrieval: Any):
        self.retrieval = retrieval
        self.originals: dict[tuple[str, str, str], StagedCitation] = {}

    def retrieve(self, **request: Any) -> RetrievalResult:
        result = self.retrieval.retrieve(**request)
        for citation in result.citations:
            key = (result.collection_id, result.snapshot_id, citation.evidence["evidenceId"])
            previous = self.originals.get(key)
            if previous is not None and previous != citation:
                raise AgentFault("evidence-identity-conflict")
            self.originals[key] = citation
        return result


class CurrentUseGuard:
    def __init__(self, *, request: RunRequest, originals: OriginalEvidenceCache,
                 rights: Any, contracts: Any, time: Any, authorization: object):
        self.request, self.originals, self.time = request, originals, time
        self.gate = EvidenceGate(validator=contracts, codec=contracts, rights=rights,
                                 time=time, authorization=authorization)

    def before_disclosure(self, call: Any) -> None:
        rows = call.untrusted_user_data.get("evidence")
        if not isinstance(rows, list) or not 1 <= len(rows) <= self.request.max_evidence:
            raise AgentFault("invalid-evidence")
        self.check(tuple(Evidence(**row) for row in rows))

    def check(self, evidence: tuple[Evidence, ...]) -> None:
        now = self.time.now_ns()
        if now >= self.request.deadline_ns:
            raise AgentFault("timeout")
        check_freshness(evidence, self.request, now)
        for item in evidence:
            original = self.originals.originals.get((item.collection_id, item.snapshot_id, item.evidence_id))
            if original is None:
                raise AgentFault("invalid-evidence")
            staged = RetrievalResult("available", item.collection_id, item.snapshot_id, (original,))
            # EvidenceGate resolves current review AND current rights against the
            # original canonical bytes every time, never trusts acceptanceStatus.
            admitted = self.gate.admit(staged, scope=Scope(item.collection_id, item.snapshot_id),
                                       request=self.request, reference_ns=now, current={})
            if (len(admitted) != 1
                    or replace(admitted[0], valid_until_ns=item.valid_until_ns) != item):
                raise AgentFault("rights-denied")


class GuardedModel:
    def __init__(self, model: Any, guard: CurrentUseGuard):
        self.model, self.guard = model, guard

    def invoke(self, request: Any, *, cancellation: Any) -> Any:
        self.guard.check(request.untrusted_evidence)
        response = self.model.invoke(request, cancellation=cancellation)
        # Revocation while model was in flight suppresses all returned material;
        # external compute is still charged by the model admission owner.
        self.guard.check(request.untrusted_evidence)
        return response


class ExistingChatDelivery:
    def __init__(self, delivery: Any, guard: CurrentUseGuard):
        self.delivery, self.guard = delivery, guard

    def deliver(self, *, thread_id: str, result: RunResult, deadline_ns: int) -> str:
        if result.status == "completed":
            if result.publication_status != "published":
                return "unavailable"
            self.guard.check(result.evidence)
        # Server delivery must authorize thread membership/current rights at the
        # commit boundary too; this projection creates no new chat application.
        events = ExistingChatAdapter().events(thread_id=thread_id, result=result)
        status = self.delivery.deliver(thread_id=thread_id, run_id=result.run_id, trace_id=result.trace_id,
                                       events=tuple(asdict(event) for event in events), deadline_ns=deadline_ns)
        return status if status in ("accepted", "duplicate", "unknown", "rejected") else "unknown"
