"""Authoritative AgentRun v1 publication; no local validator/hash fallback."""
from __future__ import annotations

from dataclasses import replace

from .budget import integer
from .evidence import canonical, check_freshness, check_output
from .ports import ArtifactStore, Cancellation, CanonicalCodec, TimePort, Validator
from .types import AgentFault, RunRequest, RunResult
from .wire import internal_value


def _public_error(code: str) -> str:
    if code == "cancelled":
        return "cancelled"
    if code in {"budget-exhausted", "tool-budget-exhausted"}:
        return "budget-exhausted"
    if code in {"rights-denied", "evidence-scope-denied", "tool-denied"}:
        return "permission-denied"
    if code in {"model-unavailable", "model-timeout", "ports-unavailable"}:
        return "model-unavailable"
    if code in {"evidence-unavailable", "evidence-stale", "empty-evidence", "timeout"}:
        return "provider-unavailable"
    return "validation-failed"


class AgentRunPublisher:
    def __init__(self, *, validator: Validator | None, codec: CanonicalCodec | None,
                 store: ArtifactStore | None, time: TimePort,
                 cancellation: Cancellation) -> None:
        self.validator, self.codec, self.store = validator, codec, store
        self.time, self.cancellation = time, cancellation

    def publish(self, *, request: RunRequest, result: RunResult,
                reference_ns: int) -> RunResult:
        """Caller supplies current reference epoch-ns; store commit is atomic.

        Publication is explicit, never a model tool. A store timeout is 'unknown',
        never retried here. Caller reconciles by run/trace and immutable digests.
        """
        if any(port is None for port in (self.validator, self.codec, self.store)):
            return replace(result, publication_status="unavailable")
        if result.publication_status != "not-requested":
            return result
        try:
            integer(reference_ns, maximum=10**30)
            if (result.run_id != request.run_id or result.trace_id != request.trace_id
                    or result.execution_authorized is not False
                    or reference_ns < request.reference_ns):
                raise AgentFault("invalid-publication")
            if self.cancellation.cancelled() is not False or self.time.now_ns() >= request.deadline_ns:
                return replace(result, publication_status="cancelled")
            if result.status == "completed":
                if result.errors or result.output is None:
                    raise AgentFault("invalid-publication")
                check_output(result.output, {e.evidence_id: e for e in result.evidence})
                check_freshness(result.evidence, request, reference_ns)
            elif result.output is not None:
                raise AgentFault("invalid-publication")
            assert self.validator is not None and self.codec is not None and self.store is not None
            # Internal trace is an implementation artifact, NOT a public contract.
            # No task prose, credentials, raw errors, prompts or chain of thought.
            internal = {
                "profile": "vertex-internal-agent-advisory-v1",
                "taskContract": request.task_contract,
                "modelVersion": request.model_version,
                "result": internal_value(result),
            }
            if result.status != "completed":
                # A stopped run may contain rights-expired evidence: retain identities,
                # not source excerpts, in its operational audit artifact.
                for item in internal["result"]["evidence"]:
                    item.pop("excerpt", None)
            body, digest = canonical(internal, self.codec)
            advisory_id = "agent-advisory-" + digest
            output_ids = [advisory_id] if result.status == "completed" else []
            public = {
                "schemaVersion": "1.0.0", "runId": request.run_id,
                "agentRole": "research", "taskContract": request.task_contract,
                "allowedTools": list(request.allowed_tools), "modelVersion": request.model_version,
                "inputEvidenceIds": sorted(e.evidence_id for e in result.evidence),
                "outputArtifactIds": output_ids, "tokenBudget": request.budget.tokens,
                "costBudgetUsd": request.budget.usd, "status": result.status,
                "errors": [{"code": code, "retryable": False}
                           for code in dict.fromkeys(_public_error(e) for e in result.errors)],
                "approvalRequests": [], "executionAuthorized": False,
            }
            if self.validator.validate("AgentRun", public, "1.0.0") is not True:
                return replace(result, publication_status="invalid")
            public_body, public_digest = canonical(public, self.codec)
            artifacts = (("vertex-internal-agent-advisory-v1", advisory_id, body, digest),
                         ("AgentRun", request.run_id, public_body, public_digest))
            if self.cancellation.cancelled() is not False or self.time.now_ns() >= request.deadline_ns:
                return replace(result, publication_status="cancelled")
        except Exception:
            return replace(result, publication_status="invalid")
        try:
            committed = self.store.publish(run_id=request.run_id, trace_id=request.trace_id,
                                           artifacts=artifacts, deadline_ns=request.deadline_ns,
                                           cancellation=self.cancellation)
        except Exception:
            return replace(result, publication_status="unknown")
        # The private advisory remains an immutable provenance reference inside
        # AgentRun, not an owned public output eligible for WorkerComplete.
        if type(committed) is not tuple or committed != (request.run_id,):
            return replace(result, publication_status="unknown")
        return replace(result, publication_status="published", artifact_ids=committed)
