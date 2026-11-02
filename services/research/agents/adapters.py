"""Injected Agno transport and existing-chat projections, not another chat app.

No SDK is imported, instantiated or invoked implicitly. The host may implement
AgnoTransport with a pinned, isolated Agno worker; tools are descriptors, never
callables. Existing chat consumes plain-text/data events, not model HTML/Markdown.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping, Protocol

from .budget import integer, usd_units
from .evidence import identifier, text
from .ports import Cancellation
from .types import (
    ALLOWED_TOOLS, SYSTEM_INSTRUCTION, AdvisoryOutput, AgentFault, CitationRef,
    Claim, ModelRequest, ModelResponse, Proposal, RunResult, ToolRequest, Usage,
)


@dataclass(frozen=True)
class AgnoCall:
    run_id: str
    trace_id: str
    attempt_id: str
    model_version: str
    system_instruction: str
    untrusted_user_data: Mapping[str, Any]
    tool_names: tuple[str, ...]
    max_output_tokens: int
    max_total_tokens: int
    max_cost_usd: str
    deadline_ns: int
    execute_tools: bool = False
    memory_enabled: bool = False
    external_retrieval_enabled: bool = False


class TokenMeter(Protocol):
    def input_tokens(self, call: AgnoCall) -> int:
        """Count complete serialized prompt/tools using this exact model tokenizer."""
        ...


class AgnoTransport(Protocol):
    def run(self, call: AgnoCall, *, cancellation: Cancellation) -> Mapping[str, Any]:
        """Deadline/cancel enforcing isolated SDK bridge. No tools may execute.

        Exact response keys: run_id, trace_id, attempt_id, model_version, usage,
        output, tool_requests. usage has input_tokens/output_tokens/cost_usd. All
        chargeable reasoning/cache/provider tokens must be included in usage.
        """
        ...


@dataclass(frozen=True)
class ModelPricing:
    input_usd_per_million: str
    output_usd_per_million: str


class AgnoAdvisoryAdapter:
    def __init__(self, *, transport: AgnoTransport | None, meter: TokenMeter | None,
                 model_version: str, pricing: ModelPricing) -> None:
        self.transport, self.meter = transport, meter
        self.model_version, self.pricing = model_version, pricing

    def invoke(self, request: ModelRequest, *, cancellation: Cancellation) -> ModelResponse:
        if self.transport is None or self.meter is None:
            raise AgentFault("model-unavailable")
        if (request.model_version != self.model_version
                or request.system_instruction != SYSTEM_INSTRUCTION
                or not set(request.allowed_tools) <= ALLOWED_TOOLS):
            raise AgentFault("tool-denied")
        if cancellation.cancelled() is not False:
            raise AgentFault("cancelled")
        # There is exactly one fixed trusted system instruction. All source and
        # previous-model prose stay within this untrusted user-data envelope.
        call = AgnoCall(
            request.run_id, request.trace_id, request.attempt_id, request.model_version,
            SYSTEM_INSTRUCTION, {
                "phase": request.phase, "task": request.untrusted_task,
                "evidence": [asdict(item) for item in request.untrusted_evidence],
                "prior_analyses": [asdict(item) for item in request.untrusted_prior_analyses],
                "tool_results": [asdict(item) for item in request.untrusted_tool_results],
                "untrusted_content": True,
            }, request.allowed_tools, 0, request.max_tokens, request.max_cost_usd,
            request.deadline_ns,
        )
        inputs = integer(self.meter.input_tokens(call))
        outputs = request.max_tokens - inputs
        if outputs <= 0:
            raise AgentFault("budget-exhausted")
        input_price = usd_units(self.pricing.input_usd_per_million)
        output_price = usd_units(self.pricing.output_usd_per_million)
        # Round UP only for admission. USD and tokens are independent bounds.
        worst_units = (inputs * input_price + outputs * output_price + 999_999) // 1_000_000
        if worst_units > usd_units(request.max_cost_usd):
            raise AgentFault("budget-exhausted")
        from dataclasses import replace
        raw = self.transport.run(replace(call, max_output_tokens=outputs), cancellation=cancellation)
        row = _record(raw, {"run_id", "trace_id", "attempt_id", "model_version",
                            "usage", "output", "tool_requests"})
        usage = _record(row["usage"], {"input_tokens", "output_tokens", "cost_usd"})
        tokens = integer(usage["input_tokens"]) + integer(usage["output_tokens"])
        usd_units(usage["cost_usd"])
        calls = _array(row["tool_requests"], 4)
        parsed_calls: list[ToolRequest] = []
        for value in calls:
            item = _record(value, {"call_id", "name", "arguments"})
            name, args = item["name"], item["arguments"]
            if name not in request.allowed_tools:
                raise AgentFault("tool-denied")
            if name in {"propose-strategy", "request-backtest"}:
                args = _record(args, {"proposal"})
                args = {"proposal": _proposal(args["proposal"])}
            elif name == "write-research-artifact":
                args = _record(args, {"output"})
                args = {"output": _output(args["output"])}
            elif name == "read-evidence":
                args = dict(_record(args, {"evidence_id"}))
            else:
                args = dict(_record(args, {"collection_id", "snapshot_id", "query", "limit"}))
            parsed_calls.append(ToolRequest(identifier(item["call_id"]), name, args))
        return ModelResponse(row["run_id"], row["trace_id"], row["attempt_id"], row["model_version"],
                             Usage(tokens, usage["cost_usd"]),
                             _output(row["output"]) if row["output"] is not None else None,
                             tuple(parsed_calls))


def _record(value: Any, keys: set[str]) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise AgentFault("invalid-model-response")
    return value


def _array(value: Any, limit: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > limit:
        raise AgentFault("invalid-model-response")
    return value


def _claim(value: Any) -> Claim:
    row = _record(value, {"text", "kind", "citations"})
    refs: list[CitationRef] = []
    for item in _array(row["citations"], 8):
        ref = _record(item, {"evidence_id", "source_id", "source_snapshot_id", "content_hash",
                             "excerpt_digest", "quote"})
        refs.append(CitationRef(**ref))
    return Claim(text(row["text"], 2000), row["kind"], tuple(refs))


def _proposal(value: Any) -> Proposal:
    row = _record(value, {"proposal_id", "kind", "title", "rationale", "execution_authorized"})
    if row["execution_authorized"] is not False:
        raise AgentFault("invalid-proposal")
    return Proposal(identifier(row["proposal_id"]), row["kind"], text(row["title"], 200),
                    _claim(row["rationale"]))


def _output(value: Any) -> AdvisoryOutput:
    row = _record(value, {"claims", "proposals", "execution_authorized"})
    if row["execution_authorized"] is not False:
        raise AgentFault("invalid-output")
    return AdvisoryOutput(tuple(_claim(c) for c in _array(row["claims"], 12)),
                          tuple(_proposal(p) for p in _array(row["proposals"], 8)))


@dataclass(frozen=True)
class ChatEvent:
    """Internal event for the existing thread transport; not EventEnvelope v1.

    Consumers MUST render text as plain text and never infer order/risk approval.
    Citation URIs are not embedded in text, commands or tool-routing instructions.
    """
    thread_id: str
    run_id: str
    trace_id: str
    sequence: int
    kind: str
    text: str
    citations: tuple[CitationRef, ...] = ()
    proposal: Proposal | None = None
    execution_authorized: bool = False
    format: str = "plain-text"
    untrusted_content: bool = True


class ExistingChatAdapter:
    """Pure event projection: the existing authenticated chat owns delivery."""

    def events(self, *, thread_id: str, result: RunResult) -> tuple[ChatEvent, ...]:
        identifier(thread_id)
        identifier(result.run_id)
        identifier(result.trace_id)
        events: list[ChatEvent] = []
        # Never copy exception strings, prompt text, raw transcripts or hidden reasoning.
        for event in result.events:
            label = {
                "running": "Research started.", "completed": "Cited research completed; no execution authorized.",
                "cancelled": "Research cancelled.", "evidence-admitted": "Scoped cited evidence available.",
                "reserved": "Research-compute budget reserved.", "settled": "Research-compute usage recorded.",
                "retry-scheduled": "Bounded advisory retry scheduled.",
                "phase-completed": "Cited advisory phase completed.",
                "tool-staged": "Allowlisted research result staged; no external action performed.",
                "response-cited": "Typed advisory response recorded.",
            }.get(event.code, "Research unavailable or stopped by a safety boundary.")
            events.append(ChatEvent(thread_id, result.run_id, result.trace_id,
                                    len(events) + 1, "research-lifecycle", label))
        if result.status == "completed" and result.output is not None:
            from .evidence import check_output
            check_output(result.output, {e.evidence_id: e for e in result.evidence})
            for claim in result.output.claims:
                events.append(ChatEvent(thread_id, result.run_id, result.trace_id,
                                        len(events) + 1, "research-claim", claim.text, claim.citations))
            for proposal in result.output.proposals:
                events.append(ChatEvent(thread_id, result.run_id, result.trace_id,
                                        len(events) + 1, "research-proposal", proposal.title,
                                        proposal.rationale.citations, proposal))
        return tuple(events)
