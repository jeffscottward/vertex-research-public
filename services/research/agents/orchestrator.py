"""Sequential, isolated advisory orchestration with no ambient capabilities.

The model and retrieval ports are deliberately inert until explicitly injected.
They must implement transport timeouts; this module checks the supplied logical
clock before/after every call but does not launch threads or pretend to preempt I/O.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Mapping

from .budget import BudgetLedger, integer
from .evidence import EvidenceGate, canonical, check_freshness, check_output, check_proposal, identifier, text
from .ports import Cancellation, CanonicalCodec, ModelPort, RetrievalPort, RightsPort, RunAdmission, TimePort, Validator
from .types import (
    ALLOWED_TOOLS, PHASES, SYSTEM_INSTRUCTION, AdvisoryOutput, AgentFault,
    Evidence, LifecycleEvent, ModelRequest, ModelResponse, Proposal,
    RunRequest, RunResult, Scope, ToolRequest, ToolResult,
)
from .wire import internal_value


_SAFE_CODES = frozenset({
    "cancelled", "timeout", "model-timeout", "model-unavailable", "ports-unavailable",
    "invalid-budget", "invalid-bound", "budget-exhausted", "tool-budget-exhausted",
    "reservation-conflict", "invalid-usage", "invalid-identity", "invalid-text",
    "canonical-codec-mismatch", "evidence-unavailable", "evidence-bound-exceeded",
    "invalid-evidence", "duplicate-evidence", "evidence-scope-denied", "evidence-stale",
    "excerpt-integrity-failed", "rights-denied", "evidence-identity-conflict",
    "citation-not-in-evidence", "citation-identity-mismatch", "citation-quote-mismatch",
    "invalid-claim", "missing-citation", "duplicate-citation", "invalid-proposal",
    "invalid-output", "output-bound-exceeded", "duplicate-proposal", "invalid-request",
    "invalid-model-response", "model-identity-mismatch", "tool-denied", "invalid-tool",
    "duplicate-tool-call", "clock-regressed", "adapter-failed", "empty-evidence",
    "run-admission-denied",
})


class ResearchOrchestrator:
    def __init__(self, *, model: ModelPort | None, retrieval: RetrievalPort | None,
                 validator: Validator | None, codec: CanonicalCodec | None,
                 rights: RightsPort | None, time: TimePort,
                 cancellation: Cancellation, authorization: object,
                 admission: RunAdmission | None = None) -> None:
        self.model, self.retrieval = model, retrieval
        self.validator, self.codec, self.rights = validator, codec, rights
        self.time, self.cancellation, self.authorization = time, cancellation, authorization
        self.admission = admission

    def run(self, request: RunRequest) -> RunResult:
        # Mutable state belongs only to this invocation, never a module/global cache.
        events: list[LifecycleEvent] = []
        evidence: dict[str, Evidence] = {}
        ledger: BudgetLedger | None = None
        prior: list[AdvisoryOutput] = []
        tool_results: list[ToolResult] = []
        tool_ids: set[str] = set()
        proposals: dict[str, Proposal] = {}
        started: int | None = None
        last_time: int | None = None

        def event(kind: str, code: str, attempt_id: str | None = None, *,
                  input_digest: str | None = None, output_digest: str | None = None,
                  tool_name: str | None = None) -> None:
            events.append(LifecycleEvent(request.run_id, request.trace_id, len(events) + 1,
                                         kind, code, attempt_id, tuple(sorted(evidence)),
                                         input_digest, output_digest, tool_name))

        def check() -> tuple[int, int]:
            nonlocal started, last_time
            if self.cancellation.cancelled() is not False:
                raise AgentFault("cancelled")
            now = self.time.now_ns()
            if type(now) is not int or last_time is not None and now < last_time:
                raise AgentFault("clock-regressed")
            last_time = now
            if started is None:
                started = now
            if now >= request.deadline_ns:
                raise AgentFault("timeout")
            return now, request.reference_ns + now - started

        def retrieve(scope: Scope, query: str, limit: int) -> tuple[str, ...]:
            now, _ = check()
            assert self.retrieval is not None
            deadline = min(request.deadline_ns, now + request.per_attempt_timeout_ns)
            result = self.retrieval.retrieve(
                collection_id=scope.collection_id, snapshot_id=scope.snapshot_id,
                query=query, limit=limit, authorization=self.authorization,
                deadline_ns=deadline, cancellation=self.cancellation,
            )
            now, reference = check()
            if now >= deadline:
                raise AgentFault("timeout")
            if len(result.citations) > limit:
                raise AgentFault("evidence-bound-exceeded")
            for item in gate.admit(result, scope=scope, request=request,
                                   reference_ns=reference, current=evidence):
                evidence[item.evidence_id] = item
            event("evidence", "evidence-admitted")
            return tuple(c.evidence["evidenceId"] for c in result.citations)

        def stage_proposal(proposal: Proposal) -> None:
            check_proposal(proposal, evidence)
            if proposal.proposal_id in proposals and proposals[proposal.proposal_id] != proposal:
                raise AgentFault("duplicate-proposal")
            if proposal.proposal_id not in proposals and len(proposals) >= 8:
                raise AgentFault("output-bound-exceeded")
            proposals[proposal.proposal_id] = proposal

        def tool(call: ToolRequest) -> ToolResult:
            check()
            assert ledger is not None
            ledger.tool()
            if not isinstance(call, ToolRequest) or call.name not in request.allowed_tools:
                raise AgentFault("tool-denied")
            identifier(call.call_id)
            if call.call_id in tool_ids:
                raise AgentFault("duplicate-tool-call")
            tool_ids.add(call.call_id)
            args = call.arguments
            if not isinstance(args, Mapping):
                raise AgentFault("invalid-tool")
            if call.name == "read-evidence":
                if set(args) != {"evidence_id"} or args["evidence_id"] not in evidence:
                    raise AgentFault("evidence-scope-denied")
                return ToolResult(call.call_id, call.name, (args["evidence_id"],))
            if call.name == "search-authorized-corpus":
                if set(args) != {"collection_id", "snapshot_id", "query", "limit"}:
                    raise AgentFault("invalid-tool")
                scope = Scope(args["collection_id"], args["snapshot_id"])
                if scope not in request.scopes:
                    raise AgentFault("evidence-scope-denied")
                limit = integer(args["limit"], 1, request.max_evidence)
                ids = retrieve(scope, text(args["query"], 1000), limit)
                return ToolResult(call.call_id, call.name, ids)
            if call.name in {"propose-strategy", "request-backtest"}:
                if set(args) != {"proposal"}:
                    raise AgentFault("invalid-tool")
                proposal = args["proposal"]
                check_proposal(proposal, evidence)
                expected = "strategy-hypothesis" if call.name == "propose-strategy" else "backtest-request"
                if proposal.kind != expected:
                    raise AgentFault("invalid-proposal")
                stage_proposal(proposal)
                return ToolResult(call.call_id, call.name, proposal=proposal)
            if call.name == "write-research-artifact":
                # Stage only: no store access or public publication through model tools.
                if set(args) != {"output"}:
                    raise AgentFault("invalid-tool")
                check_output(args["output"], evidence)
                for proposal in args["output"].proposals:
                    stage_proposal(proposal)
                return ToolResult(call.call_id, call.name, tuple(sorted(evidence)))
            raise AgentFault("tool-denied")

        try:
            self._request(request)
            ledger = BudgetLedger(request.budget)
            check()
            if any(port is None for port in (self.model, self.retrieval, self.validator,
                                             self.codec, self.rights, self.admission)):
                raise AgentFault("ports-unavailable")
            assert self.validator is not None and self.codec is not None and self.rights is not None
            assert self.admission is not None
            _, request_digest = canonical(internal_value(request), self.codec)
            if self.admission.claim(actor_id=request.actor_id, run_id=request.run_id,
                                    trace_id=request.trace_id, request_digest=request_digest,
                                    token_budget=request.budget.tokens,
                                    cost_budget_usd=request.budget.usd,
                                    deadline_ns=request.deadline_ns,
                                    cancellation=self.cancellation) is not True:
                raise AgentFault("run-admission-denied")
            check()
            gate = EvidenceGate(validator=self.validator, codec=self.codec, rights=self.rights,
                                time=self.time, authorization=self.authorization)
            event("lifecycle", "running")
            for scope in request.scopes:
                retrieve(scope, request.task, request.max_evidence)
            if not evidence:
                raise AgentFault("empty-evidence")
            for phase in request.phases:
                retries = 0
                while True:
                    now, reference = check()
                    check_freshness(tuple(evidence.values()), request, reference)
                    attempt_id = f"attempt-{ledger.attempt_count + 1}"
                    deadline = min(request.deadline_ns, now + request.per_attempt_timeout_ns)
                    model_request = ModelRequest(
                        request.run_id, request.trace_id, attempt_id, request.model_version,
                        phase, SYSTEM_INSTRUCTION, request.task,
                        tuple(evidence[k] for k in sorted(evidence)), tuple(prior), tuple(tool_results),
                        request.allowed_tools, request.budget.attempt_tokens,
                        request.budget.attempt_usd, deadline,
                    )
                    _, input_digest = canonical(internal_value(model_request), self.codec)
                    ledger.reserve(attempt_id, phase)
                    event("attempt", "reserved", attempt_id, input_digest=input_digest)
                    assert self.model is not None
                    try:
                        response = self.model.invoke(model_request, cancellation=self.cancellation)
                    except Exception as error:
                        ledger.settle(attempt_id, None, "unknown-usage")
                        check()
                        retryable = (isinstance(error, AgentFault) and error.retryable is True
                                     and error.code in {"model-unavailable", "model-timeout"})
                        if retryable and retries < request.budget.max_retries:
                            retries += 1
                            event("attempt", "retry-scheduled", attempt_id)
                            continue
                        code = (error.code if isinstance(error, AgentFault)
                                and error.code in _SAFE_CODES else "model-unavailable")
                        raise AgentFault(code) from None
                    if (not isinstance(response, ModelResponse)
                            or (response.run_id, response.trace_id, response.attempt_id, response.model_version)
                            != (request.run_id, request.trace_id, attempt_id, request.model_version)):
                        ledger.settle(attempt_id, None, "identity-mismatch")
                        raise AgentFault("model-identity-mismatch")
                    ledger.settle(attempt_id, response.usage, "response-received")
                    now, reference = check()
                    if now >= deadline:
                        raise AgentFault("model-timeout")
                    check_freshness(tuple(evidence.values()), request, reference)
                    event("attempt", "settled", attempt_id)
                    if (not isinstance(response.tool_requests, tuple)
                            or len(response.tool_requests) > 4
                            or (response.output is None) == (not response.tool_requests)):
                        raise AgentFault("invalid-model-response")
                    if response.tool_requests:
                        for call in response.tool_requests:
                            tool_result = tool(call)
                            tool_results.append(tool_result)
                            _, tool_digest = canonical(internal_value(tool_result), self.codec)
                            event("tool", "tool-staged", call.call_id,
                                  output_digest=tool_digest, tool_name=call.name)
                        retries = 0
                        _, response_digest = canonical(internal_value(response), self.codec)
                        event("attempt", "response-cited", attempt_id, output_digest=response_digest)
                        continue
                    assert response.output is not None
                    check_output(response.output, evidence)
                    for proposal in response.output.proposals:
                        stage_proposal(proposal)
                    prior.append(response.output)
                    _, response_digest = canonical(internal_value(response), self.codec)
                    event("phase", "phase-completed", attempt_id, output_digest=response_digest)
                    break
            _, reference = check()
            check_freshness(tuple(evidence.values()), request, reference)
            output = replace(prior[-1], proposals=tuple(proposals[k] for k in sorted(proposals)))
            check_output(output, evidence)
            event("lifecycle", "completed")
            return RunResult(request.run_id, request.trace_id, "completed", output,
                             tuple(evidence[k] for k in sorted(evidence)), tuple(ledger.records),
                             tuple(events), ())
        except Exception as error:
            code = (error.code if isinstance(error, AgentFault) and error.code in _SAFE_CODES
                    else "adapter-failed")
            status = "cancelled" if code == "cancelled" else (
                "blocked" if code in {"ports-unavailable", "rights-denied", "empty-evidence",
                                     "evidence-unavailable", "budget-exhausted",
                                     "run-admission-denied"} else "failed")
            event("lifecycle", code)
            return RunResult(request.run_id, request.trace_id, status, None,
                             tuple(evidence[k] for k in sorted(evidence)),
                             tuple(ledger.records) if ledger else (), tuple(events), (code,))

    @staticmethod
    def _request(request: RunRequest) -> None:
        for value in (request.run_id, request.trace_id, request.actor_id,
                      request.task_contract, request.model_version, request.account_alias):
            identifier(value)
        # Research is its own scope, never coerced to paper or execution authority.
        # Live remains an advisory/observation context, not a live worker grant.
        if request.environment not in {"research", "paper", "live"}:
            raise AgentFault("rights-denied")
        text(request.task, 2000)
        if (not isinstance(request.scopes, tuple) or not 1 <= len(request.scopes) <= 8
                or len(set(request.scopes)) != len(request.scopes)):
            raise AgentFault("invalid-request")
        for scope in request.scopes:
            identifier(scope.collection_id)
            identifier(scope.snapshot_id)
        if (not isinstance(request.allowed_tools, tuple)
                or len(set(request.allowed_tools)) != len(request.allowed_tools)
                or not set(request.allowed_tools) <= ALLOWED_TOOLS
                or not isinstance(request.phases, tuple) or not request.phases
                or len(request.phases) > 3 or len(set(request.phases)) != len(request.phases)
                or any(phase not in PHASES for phase in request.phases)
                or request.phases[-1] != "synthesis"):
            raise AgentFault("invalid-request")
        integer(request.reference_ns, maximum=10**30)
        integer(request.deadline_ns, maximum=10**30)
        integer(request.per_attempt_timeout_ns, 1, 10**30)
        integer(request.max_evidence, 1, 64)
        integer(request.max_excerpt_chars, 1, 8000)
        integer(request.max_evidence_age_ns, 0, 31_536_000_000_000_000)
