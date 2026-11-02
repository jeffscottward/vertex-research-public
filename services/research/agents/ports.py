"""All effects supplied by the composition root; no default provider or SDK."""
from __future__ import annotations

from typing import Any, Callable, Literal, Mapping, Protocol, Sequence

from .framework_types import FrameworkEvent, FrameworkInfo, FrameworkRunRequest, FrameworkRunResult
from .types import AcceptedReview, ModelRequest, ModelResponse, RetrievalResult, RightsGrant


class Validator(Protocol):
    def validate(self, contract_name: str, payload: Mapping[str, Any],
                 schema_version: str = "1.0.0") -> bool: ...


class CanonicalCodec(Protocol):
    def encode(self, value: Any) -> bytes: ...
    def digest(self, value: Any) -> str: ...


class TimePort(Protocol):
    def now_ns(self) -> int:
        """Monotonic logical run time; never implicitly read the system clock."""
        ...

    def timestamp_ns(self, value: str) -> int:
        """Authoritative v1 timestamp interpretation, preserving nanoseconds."""
        ...


class Cancellation(Protocol):
    def cancelled(self) -> bool: ...


class RetrievalPort(Protocol):
    def retrieve(self, *, collection_id: str, snapshot_id: str, query: str,
                 limit: int, authorization: object, deadline_ns: int,
                 cancellation: Cancellation) -> RetrievalResult:
        """Only the named authorized collection generation, staged by DataKnowledge.

        Adapter must honor deadline/cancellation; this synchronous pure coordinator
        cannot preempt arbitrary blocking I/O. No ingestion or global corpus search.
        """
        ...


class AcceptedEvidenceResolver(Protocol):
    def resolve_current(self, *, actor_id: str, account_alias: str,
                        environment: Literal["research", "paper", "live"],
                        collection_id: str, snapshot_id: str, evidence_id: str,
                        artifact_digest: str, original_bytes: bytes, purpose: str,
                        reference_ns: int, authorization: object) -> AcceptedReview | None:
        """Read fresh authoritative CURRENT review joined to authorization/rights.

        Bind exact immutable original evidence bytes and scope. Never select an
        older accepted review when current is rejected, expired or superseded.
        No evidence/import mutation or acceptanceStatus-derived authorization.
        resolved_ns is this request's reference_ns; cache-only answers must deny.
        """
        ...


class RightsPort(AcceptedEvidenceResolver, Protocol):
    def authorize(self, *, actor_id: str, evidence: Mapping[str, Any],
                  reference_ns: int, authorization: object) -> RightsGrant | None: ...


class ModelPort(Protocol):
    def invoke(self, request: ModelRequest, *, cancellation: Cancellation) -> ModelResponse:
        """Enforce aggregate input+output token and USD caps BEFORE dispatch.

        Must honor request.deadline_ns and cancellation at the transport boundary.
        Unknown usage/exception charges the entire reservation; never invoke tools
        in the SDK. Tool requests are inert typed data returned to this coordinator.
        """
        ...


class ArtifactStore(Protocol):
    def publish(self, *, run_id: str, trace_id: str,
                artifacts: tuple[tuple[str, str, bytes, str], ...],
                deadline_ns: int, cancellation: Cancellation) -> tuple[str, ...] | None:
        """Atomically store (contract/profile, id, canonical bytes, digest).

        Same run/identical bytes is idempotent. Same ID with different bytes MUST
        reject. No partial AgentRun referencing absent internal advisory artifacts.
        Return only committed public output IDs from the validated owned-job
        receipt, never private staging IDs or a boolean acknowledgement.
        None/exception is unknown, no retry.
        """
        ...


class RunAdmission(Protocol):
    def claim(self, *, actor_id: str, run_id: str, trace_id: str, request_digest: str,
              token_budget: int, cost_budget_usd: str,
              deadline_ns: int, cancellation: Cancellation) -> bool:
        """Durably claim one authorized compute budget before any external read.

        Return literal True for a newly admitted run only. Duplicate run IDs,
        changed identity/budget and uncertain previous admission return False.
        No automatic release/reclaim after crash; this deliberately fails closed.
        This is compute-budget admission, never cash allocation or broker authority.
        """
        ...


class RunEventSink(Protocol):
    def emit(self, event: FrameworkEvent) -> None:
        """Take one event of a running framework (live view). Never blocks the run on storage."""
        ...


class AgentFrameworkPort(Protocol):
    """Research adapter port for an agent framework (TradingAgents-style desks, Vibe-Trading).

    One run: one ticker, one decision date, one model endpoint. The adapter starts the framework
    with read-only tools only, passes only the key the endpoint names, honours the request timeout
    and cancellation, and returns a rating that is a research label, never an order.
    """

    def describe(self) -> FrameworkInfo: ...

    def run(self, request: FrameworkRunRequest, sink: RunEventSink,
            cancellation: Cancellation) -> FrameworkRunResult: ...


class RunRecorder(Protocol):
    """Stores framework runs in Vertex (agentModelRuns.record/update/appendEvents/list).

    A failed call raises an exception; one with an integer `status` attribute of 400-499 will fail
    the same way again, any other may succeed on a retry."""

    def record(self, fields: Mapping[str, Any]) -> Mapping[str, Any]:
        """Idempotent by fields["runKey"]; returns the stored run (a repeated key returns the first)."""
        ...

    def update(self, run_id: str, fields: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def append_events(self, run_id: str, events: Sequence[Mapping[str, Any]]) -> None:
        """At most 200 events with increasing seqs; an exact retry of a seq is a no-op."""
        ...

    def count_finished(self, filters: Mapping[str, Any],
                       accept: Callable[[Mapping[str, Any]], bool] | None = None) -> int:
        """Finished (succeeded) runs that match the list filters and, when given, `accept` (for
        fields the list filters cannot express, such as a missing variant), for reuse."""
        ...
