"""Explicit paper-only bootstrap. No amount, account or policy is defaulted."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .exact import units
from .owner import PaperExecutionOwner, digest_reference, reference
from .ports import ExecutionError, PortfolioObservation


@dataclass(frozen=True)
class SimulationCapitalPolicy:
    artifact_id: str
    artifact_sha256: str
    account_alias: str
    simulator_id: str
    currency: str
    settled_cash: str
    actor_id: str
    approval_id: str
    approved_ns: int
    expires_ns: int
    maximum_observation_age_ns: int
    environment: str = "paper"
    purpose: str = "SIMULATION"
    real_account_funds: bool = False
    broker_submission_allowed: bool = False


class SimulationCapitalAuthority(Protocol):
    def verify(self, policy: SimulationCapitalPolicy, *, now_ns: int) -> bool:
        """Resolve exact immutable policy bytes and human approval for its amount,
        currency/account/simulator. Check revocation and current authorization.
        A policy digest or caller boolean alone is not an approval. This cache
        is injected; no provider/broker/cloud request occurs at bootstrap.
        """
        ...


def seed_simulation(owner: PaperExecutionOwner, policy: SimulationCapitalPolicy, *,
                    authority: SimulationCapitalAuthority, observation_id: str,
                    evidence_sha256: str, now_ns: int) -> None:
    with owner.journal.mutex:
        state = owner._scope()
        if (state["observation"] is not None or state["orders"] or state["positions"]
                or policy.environment != "paper" or policy.purpose != "SIMULATION"
                or policy.real_account_funds is not False or policy.broker_submission_allowed is not False
                or policy.account_alias != state["accountAlias"] or policy.simulator_id != state["simulatorId"]
                or policy.currency != state["currency"] or units(policy.settled_cash) <= 0
                or any(type(v) is not int or v < 0 for v in (now_ns, policy.approved_ns, policy.expires_ns, policy.maximum_observation_age_ns))
                or policy.maximum_observation_age_ns <= 0 or not policy.approved_ns <= now_ns < policy.expires_ns
                or authority.verify(policy, now_ns=now_ns) is not True):
            raise ExecutionError("approved-simulation-capital-policy-required")
        for identifier in (policy.artifact_id, policy.actor_id, policy.approval_id, observation_id):
            reference(identifier)
        digest_reference(policy.artifact_sha256)
        digest_reference(evidence_sha256)
        owner.observe(PortfolioObservation(observation_id=observation_id, account_alias=policy.account_alias,
                      environment="paper", simulator_id=policy.simulator_id, source_sequence=1,
                      observed_ns=now_ns, received_ns=now_ns,
                      valid_until_ns=min(policy.expires_ns, now_ns + policy.maximum_observation_age_ns),
                      currency=policy.currency, cash=policy.settled_cash, positions=(), evidence_sha256=evidence_sha256,
                      journal_sequence=owner.journal.sequence, journal_sha256=owner.journal.event_hash,
                      seed_policy_artifact_id=policy.artifact_id, seed_policy_sha256=policy.artifact_sha256), now_ns=now_ns)
        # Remains paused/unreconciled. Caller explicitly finishes reconciliation,
        # commits genesis then obtains a DISTINCT reset grant; no automatic risk.
