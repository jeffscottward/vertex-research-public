"""Exact research-compute accounting; these are never capital reservations."""
from __future__ import annotations

import re

from .types import AgentFault, AttemptRecord, Budget, Usage


_USD = re.compile(r"^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$")
_SCALE = 10**18


def usd_units(value: str) -> int:
    if not isinstance(value, str) or not _USD.fullmatch(value):
        raise AgentFault("invalid-budget")
    whole, _, fraction = value.partition(".")
    return int(whole) * _SCALE + int(fraction.ljust(18, "0") or "0")


def usd_text(units: int) -> str:
    whole, part = divmod(units, _SCALE)
    return str(whole) if not part else f"{whole}.{part:018d}".rstrip("0")


def integer(value: object, minimum: int = 0, maximum: int = 2**53 - 1) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise AgentFault("invalid-bound")
    return value


class BudgetLedger:
    """One run, sequential attempts; reservations cannot be reused or refunded twice."""

    def __init__(self, budget: Budget) -> None:
        integer(budget.tokens)
        integer(budget.attempt_tokens, 1)
        integer(budget.max_attempts, 1, 64)
        integer(budget.max_retries, 0, 8)
        integer(budget.max_tool_calls, 0, 64)
        self.budget = budget
        self.limit_usd = usd_units(budget.usd)
        self.attempt_usd = usd_units(budget.attempt_usd)
        if budget.attempt_tokens > budget.tokens or self.attempt_usd > self.limit_usd:
            raise AgentFault("budget-exhausted")
        self.tokens = 0
        self.usd = 0
        self.attempt_count = 0
        self.tool_count = 0
        self.records: list[AttemptRecord] = []
        self._pending: tuple[str, str] | None = None
        self._closed_ids: set[str] = set()
        self.breached = False

    def reserve(self, attempt_id: str, phase: str) -> None:
        if self._pending is not None or attempt_id in self._closed_ids:
            raise AgentFault("reservation-conflict")
        if (self.breached or self.attempt_count >= self.budget.max_attempts
                or self.tokens + self.budget.attempt_tokens > self.budget.tokens
                or self.usd + self.attempt_usd > self.limit_usd):
            raise AgentFault("budget-exhausted")
        self.attempt_count += 1
        self.tokens += self.budget.attempt_tokens
        self.usd += self.attempt_usd
        self._pending = (attempt_id, phase)

    def settle(self, attempt_id: str, usage: Usage | None, outcome: str) -> None:
        if self._pending is None or self._pending[0] != attempt_id:
            raise AgentFault("reservation-conflict")
        _, phase = self._pending
        # Invalid, missing or unavailable billing cannot turn into a free retry.
        valid = False
        tokens, cost = self.budget.attempt_tokens, self.attempt_usd
        if usage is not None:
            try:
                tokens, cost = integer(usage.tokens), usd_units(usage.usd)
                valid = True
            except (AgentFault, AttributeError, TypeError):
                tokens, cost = self.budget.attempt_tokens, self.attempt_usd
        breach = valid and (tokens > self.budget.attempt_tokens or cost > self.attempt_usd)
        self.tokens += tokens - self.budget.attempt_tokens
        self.usd += cost - self.attempt_usd
        self.records.append(AttemptRecord(
            attempt_id, phase, self.budget.attempt_tokens, self.budget.attempt_usd,
            tokens, usd_text(cost), "budget-breach" if breach else outcome, valid,
        ))
        self._closed_ids.add(attempt_id)
        self._pending = None
        self.breached = self.breached or breach
        if breach:
            raise AgentFault("budget-exhausted")
        if usage is not None and not valid:
            raise AgentFault("invalid-usage")

    def tool(self) -> None:
        if self.tool_count >= self.budget.max_tool_calls:
            raise AgentFault("tool-budget-exhausted")
        self.tool_count += 1
