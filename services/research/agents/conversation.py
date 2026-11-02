"""Pure finite conversation plans, never admission or research execution.

Inputs are candidates for a future admission boundary, not proof of trusted room
membership, corpus rights, accepted review, model readiness or a durable job.
That boundary must resolve each exact proof separately; an initial integration
may admit only a single-collection turn. This module establishes no cross-corpus
execution, availability, context truncation policy, or prompt/tool authority.

Turns describe user-facing statements/synthesis, not internal reasoning events.
By default each still requires research PHASES and all existing host guards.
The optional conversation synthesis is distinct from that internal phase name;
internal phases do not create additional conversation turns or hidden speakers.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .budget import BudgetLedger, integer, usd_units
from .evidence import identifier
from .types import AgentFault, Budget, PHASES


@dataclass(frozen=True)
class ConversationTurn:
    """Plan-local identity only; never a run, job, admission or transcript row."""

    ordinal: int
    coordination_id: str
    participant_id: str
    round_index: int | None
    kind: Literal["statement", "synthesis"]
    budget: Budget


@dataclass(frozen=True)
class ConversationPlan:
    """An immutable ceiling allocation, not a reservation or completion promise."""

    mode: Literal["discuss", "debate"]
    participant_ids: tuple[str, ...]
    room_member_ids: tuple[str, ...]
    synthesizer_id: str | None
    aggregate_budget: Budget
    turns: tuple[ConversationTurn, ...]


def _identities(values: tuple[str, ...], minimum: int, maximum: int) -> None:
    if not isinstance(values, tuple):
        raise AgentFault("invalid-request")
    integer(len(values), minimum, maximum)
    for value in values:
        identifier(value)
    if len(set(values)) != len(values):
        raise AgentFault("invalid-request")


def _budgets(aggregate: Budget, child: Budget, count: int, *, chat: bool = False) -> None:
    if not isinstance(aggregate, Budget) or not isinstance(child, Budget):
        raise AgentFault("invalid-budget")
    # Reuse the existing validation owner only. These throwaway validators never
    # reserve, settle or call tools; they are not a second accounting ledger.
    parent_ledger, child_ledger = BudgetLedger(aggregate), BudgetLedger(child)
    if (child.attempt_tokens > aggregate.attempt_tokens
            or child_ledger.attempt_usd > parent_ledger.attempt_usd
            or child.max_retries > aggregate.max_retries):
        raise AgentFault("budget-exhausted")
    # The explicit chat profile has one completion, not the legacy three-phase
    # model loop. Tokenization is a separate metered request within its USD cap.
    # This remains a pure ceiling check, never a durable reservation or refund.
    if chat and (child.max_attempts != 1 or aggregate.max_attempts != count
                 or child.max_retries != 0 or aggregate.max_retries != 0
                 or child.max_tool_calls != 0 or aggregate.max_tool_calls != 0):
        raise AgentFault("invalid-budget")
    required = 1 if chat else len(PHASES)
    if (child.max_attempts < required
            or child.tokens < required * child.attempt_tokens
            or child_ledger.limit_usd < required * child_ledger.attempt_usd):
        raise AgentFault("budget-exhausted")
    if (count * child.tokens > aggregate.tokens
            or count * usd_units(child.usd) > usd_units(aggregate.usd)
            or count * child.max_attempts > aggregate.max_attempts
            or count * child.max_tool_calls > aggregate.max_tool_calls):
        raise AgentFault("budget-exhausted")


def compile_conversation(*, mode: Literal["discuss", "debate"],
                         participant_ids: tuple[str, ...],
                         room_member_ids: tuple[str, ...],
                         aggregate_budget: Budget, turn_budget: Budget,
                         synthesizer_id: str | None = None,
                         execution_profile: Literal["research-phases-v1", "vertex-research-chat-single-completion-v1"]
                         = "research-phases-v1") -> ConversationPlan:
    """Compile explicit candidate selections with one server-policy turn budget.

    Discuss: 1..8 selected speakers, one ordered statement each, no synthesis.
    Debate: 2..4 selected speakers, two ordered statement rounds, optionally one
    final synthesis by an explicitly selected participant who is a room member.
    A room member not in participant_ids cannot become an implicit extra speaker.
    Room membership follows the existing 1..16 thread bound. Tuples and existing
    exact identifiers are required; no normalization, sorting or defaults add
    speakers. Ordinals/coordination IDs are stable only within this plan, never
    globally unique idempotency keys or durable execution identities.

    Both Budgets are validated by BudgetLedger. Every child ceiling, including
    an optional synthesis, must fit the aggregate without redistribution. The
    aggregate per-attempt and per-phase retry caps may not be exceeded either.
    max_retries retains its existing PER-PHASE meaning: it is not summed across
    turns or treated as a total retry guarantee. Summed max_attempts ceilings
    bound all initial attempts, retries and tool-driven continuations together;
    individual token/USD ceilings and current runtime guards can stop them sooner.

    Only the explicit chat profile maps to one completion per turn, zero retries
    and zero tools. It accepts exactly two speakers, two rounds and one explicit
    selected synthesizer. It cannot supply an arbitrary phase/turn schedule.

    Passing a spent ledger's immutable Budget does not replenish that ledger or
    prove remaining capacity. A future admission/execution owner must retain its
    authoritative spent/reserved state and reject duplicate/replayed work. This
    function performs no reservations, I/O, model calls or admission, accepts no
    model/tool/prompt authority and never guarantees completion.
    """
    if execution_profile not in ("research-phases-v1", "vertex-research-chat-single-completion-v1"):
        raise AgentFault("invalid-request")
    chat = execution_profile == "vertex-research-chat-single-completion-v1"
    if mode not in ("discuss", "debate"):
        raise AgentFault("invalid-request")
    _identities(room_member_ids, 1, 16)
    _identities(participant_ids, 1 if mode == "discuss" else 2, 8 if mode == "discuss" else 4)
    if chat and (mode != "debate" or len(participant_ids) != 2
                 or synthesizer_id is None or "first-mate" in participant_ids):
        raise AgentFault("invalid-request")
    if not set(participant_ids).issubset(room_member_ids):
        raise AgentFault("invalid-request")
    if synthesizer_id is not None:
        identifier(synthesizer_id)
        if mode != "debate" or synthesizer_id not in participant_ids:
            raise AgentFault("invalid-request")

    rounds = 1 if mode == "discuss" else 2
    count = integer(rounds * len(participant_ids) + int(synthesizer_id is not None), 1, 9)
    _budgets(aggregate_budget, turn_budget, count, chat=chat)
    turns: list[ConversationTurn] = []
    for round_index in range(1, rounds + 1):
        for participant_id in participant_ids:
            ordinal = len(turns) + 1
            turns.append(ConversationTurn(ordinal, f"turn-{ordinal}", participant_id,
                                          round_index, "statement", turn_budget))
    if synthesizer_id is not None:
        turns.append(ConversationTurn(count, f"turn-{count}", synthesizer_id,
                                      None, "synthesis", turn_budget))
    return ConversationPlan(mode, participant_ids, room_member_ids, synthesizer_id,
                            aggregate_budget, tuple(turns))
