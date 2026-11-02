"""Source adaptation: options_alpha/workflows/research_agent_v1.py.

Preserves conservative long-call/put readiness and candidate-matched replay. It
intentionally removes scan/cache/env/filesystem/clock defaults, order formatting
and legacy 'add' action wording. A replay pass is research evidence, not permission.
Original source identity and adaptation details are in QuantAgentsBuild-v1.json.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Protocol

from .budget import integer
from .evidence import identifier
from .types import AgentFault


REPLAY_REQUIRED_CHECKS = frozenset({
    "source_ids_match", "candidate_join_matched", "manifest_hash_verified",
    "snapshot_timestamps_at_or_before_decision", "outcome_execution_bound",
    "outcome_observed_after_horizon", "accepted_allocation_present",
    "backtest_submission_accepted",
})
_TRUSTED_QUOTES = frozenset({"provider_nbbo", "nbbo", "quantdata", "quantdata_option_chain"})
_SUPPORTED = frozenset({"long_call", "long_put"})


def _digest(value: str) -> None:
    if (not isinstance(value, str) or len(value) != 64
            or any(c not in "0123456789abcdef" for c in value)):
        raise AgentFault("invalid-source-digest")


@dataclass(frozen=True)
class CandidateInput:
    ticker: str
    strategy_type: str
    intent_id: str | None
    execution_id: str | None
    execution_digest: str | None
    decision_ns: int
    score: int
    covered: bool
    hard_rejections: tuple[str, ...] = ()
    quote_sources: tuple[str, ...] = ()
    quote_observed_ns: tuple[int, ...] = ()
    quote_review_ready: bool = False
    offline: bool = False


@dataclass(frozen=True)
class CandidateDecision:
    candidate: CandidateInput
    rank: int
    status: str
    readiness: str
    reasons: tuple[str, ...]
    replay: CandidateReplayEvidence | None = None
    execution_authorized: bool = False


@dataclass(frozen=True)
class ResearchRevision:
    run_id: str
    root_research_run_id: str
    source_artifact_digest: str
    linked_trade_run_ids: tuple[str, ...]
    generated_ns: int
    revision: int
    supersedes_run_id: str | None
    candidates: tuple[CandidateDecision, ...]
    execution_authorized: bool = False


@dataclass(frozen=True)
class ReplayReference:
    replay_run_id: str
    replay_artifact_digest: str


@dataclass(frozen=True)
class CandidateReplayEvidence:
    """Trusted replay verifier attestation; never accepted from a model response."""
    root_research_run_id: str
    source_artifact_digest: str
    source_trade_run_id: str
    replay_run_id: str
    replay_artifact_digest: str
    manifest_id: str
    manifest_hash: str
    ticker: str
    strategy_intent_id: str
    execution_id: str
    execution_digest: str
    decision_ns: int
    entry_ns: int
    horizon_end_ns: int
    observed_ns: int
    snapshot_ns: tuple[int, ...]
    checks: tuple[tuple[str, bool], ...]
    engine_label: str


class CandidateReplayPort(Protocol):
    def qualify(self, *, source: ResearchRevision, candidate: CandidateInput,
                replay: ReplayReference) -> CandidateReplayEvidence | None:
        """Verify immutable replay/source bytes, full execution-set binding and
        eight Gamma checks. Translate the backtesting-owned manifest, do not create
        a second manifest schema. Supplied-outcome replay is NOT realistic economics.
        """
        ...


def rank_candidates(*, run_id: str, source_artifact_digest: str,
                    linked_trade_run_ids: tuple[str, ...], generated_ns: int,
                    candidates: tuple[CandidateInput, ...], max_candidates: int,
                    max_trade_candidates: int) -> ResearchRevision:
    identifier(run_id)
    _digest(source_artifact_digest)
    integer(generated_ns, maximum=10**30)
    integer(max_candidates, 1, 512)
    integer(max_trade_candidates, 1, 512)
    if (not isinstance(candidates, tuple) or not 1 <= len(candidates) <= 512
            or not linked_trade_run_ids or len(linked_trade_run_ids) > 512
            or len(set(linked_trade_run_ids)) != len(linked_trade_run_ids)):
        raise AgentFault("invalid-candidates")
    for trade_id in linked_trade_run_ids:
        identifier(trade_id)
    seen: set[str] = set()
    provisional: list[CandidateDecision] = []
    for row in candidates:
        identifier(row.ticker)
        if row.ticker != row.ticker.upper() or row.ticker in seen:
            raise AgentFault("duplicate-or-nonnormalized-ticker")
        seen.add(row.ticker)
        integer(row.score)
        integer(row.decision_ns, maximum=10**30)
        if row.decision_ns > generated_ns:
            raise AgentFault("future-decision")
        if (not isinstance(row.hard_rejections, tuple) or len(row.hard_rejections) > 64
                or not isinstance(row.quote_sources, tuple) or len(row.quote_sources) > 16
                or not isinstance(row.quote_observed_ns, tuple) or len(row.quote_observed_ns) > 64):
            raise AgentFault("candidate-bound-exceeded")
        reasons = list(row.hard_rejections)
        for reason in reasons:
            identifier(reason)
        if row.covered is not True:
            reasons.append("coverage_gap")
        if row.strategy_type not in _SUPPORTED:
            reasons.append("paper_guardrail_single_leg_only")
        if not row.intent_id or not row.execution_id or not row.execution_digest:
            reasons.append("missing_candidate_binding")
        else:
            identifier(row.intent_id)
            identifier(row.execution_id)
            _digest(row.execution_digest)
        if row.offline is not False:
            reasons.append("offline_replay_quote")
        if not row.quote_sources or not set(row.quote_sources) <= _TRUSTED_QUOTES:
            reasons.append("untrusted_quote_provenance")
        if row.quote_review_ready is not True:
            reasons.append("quote_not_review_ready")
        if not row.quote_observed_ns:
            reasons.append("missing_quote_timestamp")
        else:
            for at in row.quote_observed_ns:
                integer(at, maximum=10**30)
            if any(at > generated_ns + 120_000_000_000 for at in row.quote_observed_ns):
                reasons.append("future_quote_timestamp")
            if generated_ns - min(row.quote_observed_ns) > 1_200_000_000_000:
                reasons.append("stale_quote_timestamp")
        reasons = list(dict.fromkeys(reasons))
        status = "rejected" if row.hard_rejections else "candidate" if not reasons else "research_only"
        ready = "paper_candidate" if status == "candidate" else "research_only"
        if ready == "paper_candidate":
            reasons.append("replay_gate_required")
        provisional.append(CandidateDecision(row, 0, status, ready, tuple(reasons)))
    # Readiness first, then deterministic score; caller universe order breaks ties.
    priority = {"candidate": 0, "research_only": 1, "rejected": 2}
    ordered = sorted(provisional, key=lambda x: (priority[x.status], -x.candidate.score))
    ranked: list[CandidateDecision] = []
    for rank, decision in enumerate(ordered, 1):
        reasons = list(decision.reasons)
        status, readiness = decision.status, decision.readiness
        if rank > max_candidates or rank > max_trade_candidates:
            reasons = [reason for reason in reasons if reason != "replay_gate_required"]
            reasons.append("outside_max_candidates" if rank > max_candidates else "outside_max_trade_candidates")
            status = "rejected" if status == "rejected" else "research_only"
            readiness = "research_only"
        ranked.append(replace(decision, rank=rank, status=status, readiness=readiness,
                              reasons=tuple(dict.fromkeys(reasons))))
    return ResearchRevision(run_id, run_id, source_artifact_digest, linked_trade_run_ids,
                            generated_ns, 0, None, tuple(ranked))


def apply_replay_revision(*, source: ResearchRevision, replay: ReplayReference,
                          revision_run_id: str, generated_ns: int,
                          verifier: CandidateReplayPort | None) -> ResearchRevision:
    identifier(revision_run_id)
    identifier(replay.replay_run_id)
    _digest(replay.replay_artifact_digest)
    integer(generated_ns, maximum=10**30)
    if (source.execution_authorized is not False
            or any(decision.execution_authorized is not False for decision in source.candidates)):
        raise AgentFault("invalid-revision")
    if generated_ns < source.generated_ns or revision_run_id in {source.run_id, source.root_research_run_id}:
        raise AgentFault("invalid-revision")
    revised: list[CandidateDecision] = []
    attempted = 0
    for decision in source.candidates:
        if decision.status != "candidate" or decision.readiness == "research_only":
            revised.append(decision)
            continue
        attempted += 1
        evidence = None
        if verifier is not None:
            try:
                evidence = verifier.qualify(source=source, candidate=decision.candidate, replay=replay)
            except Exception:
                # Untrusted verifier errors carry no source text or credentials outward.
                evidence = None
        passed = _matches(source, decision.candidate, replay, evidence, generated_ns)
        retained = tuple(reason for reason in decision.reasons
                         if reason not in {"replay_gate_required", "candidate_replay_failed",
                                           "candidate_replay_unavailable"})
        failure = () if passed else ("candidate_replay_unavailable" if evidence is None
                                     else "candidate_replay_failed",)
        # Failed attestations are not retained as trusted evidence. Failure remains visible.
        revised.append(replace(decision, readiness="replay_passed" if passed else "replay_failed",
                               reasons=retained + failure, replay=evidence if passed else None))
    if not attempted:
        raise AgentFault("no-replay-candidates")
    return replace(source, run_id=revision_run_id, generated_ns=generated_ns,
                   revision=source.revision + 1, supersedes_run_id=source.run_id,
                   candidates=tuple(revised))


def _matches(source: ResearchRevision, candidate: CandidateInput, replay: ReplayReference,
             evidence: CandidateReplayEvidence | None, generated_ns: int) -> bool:
    if not isinstance(evidence, CandidateReplayEvidence):
        return False
    try:
        _digest(evidence.manifest_hash)
        identifier(evidence.engine_label)
        if not evidence.snapshot_ns or any(type(at) is not int or at > candidate.decision_ns
                                           for at in evidence.snapshot_ns):
            return False
        checks = dict(evidence.checks)
        return (
            len(evidence.checks) == len(REPLAY_REQUIRED_CHECKS)
            and set(checks) == REPLAY_REQUIRED_CHECKS
            and all(value is True for value in checks.values())
            and evidence.root_research_run_id == source.root_research_run_id
            and evidence.source_artifact_digest == source.source_artifact_digest
            and evidence.source_trade_run_id in source.linked_trade_run_ids
            and evidence.replay_run_id == replay.replay_run_id
            and evidence.replay_artifact_digest == replay.replay_artifact_digest
            and evidence.manifest_id == "replay-manifest-" + evidence.manifest_hash[:24]
            and (evidence.ticker, evidence.strategy_intent_id, evidence.execution_id, evidence.execution_digest)
            == (candidate.ticker, candidate.intent_id, candidate.execution_id, candidate.execution_digest)
            and evidence.decision_ns == candidate.decision_ns
            and all(type(value) is int for value in (evidence.decision_ns, evidence.entry_ns,
                                                     evidence.horizon_end_ns, evidence.observed_ns))
            and evidence.decision_ns <= evidence.entry_ns < evidence.horizon_end_ns
            <= evidence.observed_ns <= generated_ns
        )
    except (AgentFault, TypeError, ValueError):
        return False
