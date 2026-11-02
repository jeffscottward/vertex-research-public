"""Pure command preparation separated from explicitly injected kernel IO.

The Rust target is vertex_execution_kernel::evaluate_json. There is no default
process, native library load, IPC endpoint, network transport or retry. Results
are private risk computations, never public admission or submission authority.
Use evaluate outside callback paths and outside the single journal-owner lock.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .contracts import AdapterContractError, ContractAuthority, canonical_record, decode_record


KERNEL_REQUEST_VERSION = "vertex.execution-kernel.v1"


class KernelTransportUnavailable(RuntimeError):
    pass


class KernelCommandTransport(Protocol):
    async def evaluate(self, command: bytes, *, maximum_response_bytes: int) -> bytes:
        """Invoke the pure Rust command using host-owned, bounded transport."""
        ...


@dataclass(frozen=True, slots=True)
class PreparedKernelCommand:
    canonical_bytes: bytes
    sha256: str


@dataclass(frozen=True, slots=True)
class KernelEvaluation:
    request_sha256: str
    canonical_response: bytes
    status: str
    reasons: tuple[str, ...]
    plan_bytes: bytes | None


class RustKernelCommandAdapter:
    __slots__ = ("_authority", "_transport", "_maximum_bytes")

    def __init__(
        self,
        *,
        authority: ContractAuthority,
        transport: KernelCommandTransport | None = None,
        maximum_bytes: int = 2_000_000,
    ) -> None:
        if authority is None:
            raise ValueError("a pinned native ContractAuthority is required")
        if type(maximum_bytes) is not int or not 1024 <= maximum_bytes <= 8_000_000:
            raise ValueError("invalid kernel command byte bound")
        self._authority = authority
        self._transport = transport
        self._maximum_bytes = maximum_bytes

    def prepare(self, request: Mapping[str, Any]) -> PreparedKernelCommand:
        """Pure snapshot/validation. Private risk fields are validated by Rust.

        No public artifact is normalized, repaired, copied into an alternate
        schema or interpreted as spendable ledger state here. The StrategySpec
        artifact ID comes from the immutable catalog, never a latest alias.
        """
        encoded, digest = canonical_record(self._authority, request, self._maximum_bytes)
        captured = decode_record(encoded, self._maximum_bytes)
        if (
            captured.get("request_version") != KERNEL_REQUEST_VERSION
            or captured.get("operation") != "evaluate"
            or captured.get("mode") != "PAPER-SIMULATION"
        ):
            raise AdapterContractError("only paper-simulation risk evaluation is supported")
        now_ns = captured.get("now_ns")
        if type(now_ns) is not str or not now_ns.isascii() or not now_ns.isdecimal():
            raise AdapterContractError("kernel clock must be exact integer-string nanoseconds")
        if len(now_ns) > 39 or (len(now_ns) > 1 and now_ns.startswith("0")) or int(now_ns) >= 2**127:
            raise AdapterContractError("kernel clock is outside nonnegative i128")
        strategy = captured.get("strategy")
        intents = captured.get("intents")
        if type(strategy) is not dict or type(intents) is not list or not 1 <= len(intents) <= 64:
            raise AdapterContractError("public strategy and bounded intent artifacts are required")
        artifacts = [("StrategySpec", strategy), *(("TradeIntent", intent) for intent in intents)]
        for name, value in artifacts:
            if self._authority.validate(name, value, schema_version="1.0.0") is not True:
                raise AdapterContractError("native public contract validation failed")
        if self._authority.encode(captured) != encoded:
            raise AdapterContractError("authority mutated the captured risk request")
        return PreparedKernelCommand(encoded, digest)

    async def evaluate(self, command: PreparedKernelCommand) -> KernelEvaluation:
        """One explicit IO invocation; never implicitly activates a transport.

        Revalidation prevents a hand-constructed PreparedKernelCommand from
        bypassing the native public boundary. Exceptions cause no retry/send.
        """
        if self._transport is None:
            raise KernelTransportUnavailable("native kernel transport was not injected")
        if type(command) is not PreparedKernelCommand:
            raise TypeError("a prepared immutable kernel command is required")
        request = decode_record(command.canonical_bytes, self._maximum_bytes)
        validated = self.prepare(request)
        if validated != command:
            raise AdapterContractError("prepared kernel command identity changed")
        response = await self._transport.evaluate(
            command.canonical_bytes, maximum_response_bytes=self._maximum_bytes
        )
        record = decode_record(response, self._maximum_bytes)
        required = {"request_version", "status", "plan", "reasons", "live_authorization", "broker_submission_allowed"}
        if set(record) != required or record.get("request_version") != KERNEL_REQUEST_VERSION:
            raise AdapterContractError("unsupported native kernel response envelope")
        if record["live_authorization"] is not False or record["broker_submission_allowed"] is not False:
            raise AdapterContractError("kernel response attempted to grant external authority")
        status, plan, reasons = record["status"], record["plan"], record["reasons"]
        if type(status) is not str or status not in ("admitted", "rejected"):
            raise AdapterContractError("unknown kernel response status")
        if type(reasons) is not list or len(reasons) > 128 or any(
            type(reason) is not str or not 1 <= len(reason) <= 256 for reason in reasons
        ):
            raise AdapterContractError("kernel response reasons are not bounded strings")
        if status == "admitted" and type(plan) is not dict:
            raise AdapterContractError("admitted computation lacks its private risk plan")
        if status == "rejected" and (plan is not None or not reasons):
            raise AdapterContractError("rejected computation must explain rejection without a plan")
        if plan is not None:
            self._check_plan_binding(plan, request)
        encoded, _ = canonical_record(self._authority, record, self._maximum_bytes)
        plan_bytes = None if plan is None else canonical_record(self._authority, plan, self._maximum_bytes)[0]
        return KernelEvaluation(command.sha256, encoded, status, tuple(reasons), plan_bytes)

    def _check_plan_binding(self, plan: dict[str, Any], request: dict[str, Any]) -> None:
        """Reject stale/cross-account transport responses, not recompute risk."""
        try:
            expected = {
                "request_id": request["request_id"],
                "account_alias": request["account_alias"],
                "mode": request["mode"],
                "strategy_artifact_id": request["strategy_artifact_id"],
                "strategy_hash": self._authority.digest(request["strategy"]),
                "policy_id": request["policy"]["policy_id"],
                "cost_model_id": request["policy"]["costs"]["model_id"],
                "latency_model_id": request["policy"]["costs"]["latency_model_id"],
                "journal_id": request["journal"]["journal_id"],
                "journal_revision": request["journal"]["revision"],
                "journal_head_hash": request["journal"]["head_hash"],
                "owner_epoch": request["journal"]["owner_epoch"],
                "evaluated_at_ns": request["now_ns"],
            }
        except (KeyError, TypeError) as exc:
            raise AdapterContractError("admitted response lacks exact private request scope") from exc
        if any(type(value) is not str or plan.get(key) != value for key, value in expected.items()):
            raise AdapterContractError("kernel response changed request, artifact, policy or journal scope")
        if plan.get("live_authorization") is not False or plan.get("broker_submission_allowed") is not False:
            raise AdapterContractError("private kernel plan attempted to grant external authority")
