"""The single native lease dispatcher. ACK is never job completion.

One lease at a time prevents account-policy/cache races; the control dispatcher
also owns notifications. This process never starts a second queue/poller.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import inspect
from typing import Any

from vertex_execution.exact import timestamp
from .cache import HostUnavailable


def fence(lease: dict[str, Any]) -> dict[str, str]:
    return {key: lease[key] for key in ("accountAlias", "environment", "jobId", "leaseId", "leaseEpoch")}


class LeaseDispatcher:
    def __init__(self, *, config: dict[str, Any], control: Any, authority: Any, clock: Any,
                 prepare: Callable[[dict[str, Any], asyncio.Event], Awaitable[tuple[Callable[..., Any], dict[str, Any]]]],
                 cancelled: asyncio.Event, on_unavailable: Callable[[str], Awaitable[None]]) -> None:
        self.config, self.control, self.authority, self.clock = config, control, authority, clock
        self.prepare, self.cancelled, self.on_unavailable = prepare, cancelled, on_unavailable
        self.active_lease: dict[str, Any] | None = None
        self.active_cancel: asyncio.Event | None = None
        self.active_task: asyncio.Task[Any] | None = None
        self._fenced = False

    def is_current(self) -> bool:
        lease = self.active_lease
        return (not self._fenced and not self.cancelled.is_set() and lease is not None
                and self.clock.now_ns() < min(self.authority.epoch_ns(lease["leaseExpiresAt"]), self.authority.epoch_ns(lease["deadlineAt"])))

    async def _delay(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.cancelled.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def run(self) -> None:
        worker = self.config["worker"]
        while not self.cancelled.is_set():
            response = await self.control.claim(accountAlias=self.config["accountAlias"], environment=self.config["environment"],
                workerInstanceId=self.config["instanceId"], kinds=worker["kinds"], limit=1,
                leaseDurationMs=worker["leaseDurationMs"])
            self.authority.validate("WorkerClaimOutput", response)
            if response["status"] != "accepted":
                raise HostUnavailable("worker-claim-denied")
            if not response["leases"]:
                await self._delay(worker["pollMilliseconds"] / 1000)
                continue
            await self._execute(response["leases"][0])

    async def _renew(self, lease: dict[str, Any], finished: asyncio.Event) -> None:
        duration = self.config["worker"]["leaseDurationMs"] * 1_000_000
        while not finished.is_set():
            remaining = min(self.authority.epoch_ns(lease["leaseExpiresAt"]), self.authority.epoch_ns(lease["deadlineAt"])) - self.clock.now_ns()
            if remaining <= 0 or self.cancelled.is_set():
                self._fenced = True
                if self.active_cancel:
                    self.active_cancel.set()
                raise HostUnavailable("worker-lease-expired-or-shutdown")
            try:
                await asyncio.wait_for(finished.wait(), timeout=max(0.001, min(remaining / 3_000_000_000, duration / 3_000_000_000)))
                return
            except TimeoutError:
                pass
            expires = min(self.clock.now_ns() + duration, self.authority.epoch_ns(lease["deadlineAt"]))
            result = await self.control.renew(**fence(lease), leaseExpiresAt=timestamp(expires))
            self.authority.validate("WorkerResult", result)
            if result["status"] not in ("accepted", "duplicate") or result["lease"] is None:
                raise HostUnavailable("worker-lease-renewal-fenced")
            renewed = result["lease"]
            if fence(renewed) != fence(lease) or renewed["payloadSha256"] != lease["payloadSha256"] or renewed["policySelectionSha256"] != lease["policySelectionSha256"]:
                raise HostUnavailable("worker-renewal-identity-changed")
            lease["leaseExpiresAt"] = renewed["leaseExpiresAt"]

    async def _backtest_output_ledger(self, lease: dict[str, Any], known: list[str]) -> list[str]:
        """Reconcile once, never retry publication or replace unknown outputs."""
        deadline = min(self.authority.epoch_ns(lease["leaseExpiresAt"]),
                       self.authority.epoch_ns(lease["deadlineAt"]))
        remaining = (deadline - self.clock.now_ns()) / 1_000_000_000
        if remaining <= 0:
            raise HostUnavailable("backtest-output-ledger-fenced")
        result = await asyncio.wait_for(self.control.status(
            accountAlias=lease["accountAlias"], environment=lease["environment"], jobId=lease["jobId"]),
            timeout=min(remaining, 10.0))
        if self.authority.validate("WorkerResult", result) is not True:
            raise HostUnavailable("backtest-output-ledger-invalid")
        # Full returned lease equality binds fence, scope, principal, payload,
        # policy selection and deadline; status alone is not publication proof.
        if (self.clock.now_ns() >= deadline or result["jobId"] != lease["jobId"]
                or result["status"] != "accepted" or result["reason"] is not None
                or result["state"] not in ("leased", "running") or result["lease"] != lease):
            raise HostUnavailable("backtest-output-ledger-identity-unknown")
        committed = result["outputArtifactIds"]
        if (type(known) is not list or type(committed) is not list
                or len(known) > 64 or len(committed) > 64
                or any(type(identity) is not str for identity in (*known, *committed))
                or len(set(committed)) != len(committed)
                or not set(known).issubset(committed)):
            raise HostUnavailable("backtest-output-ledger-unconfirmed")
        # Keep the existing successful order; include every earlier committed
        # output, including a publication whose response was lost.
        return list(dict.fromkeys((*known, *committed)))

    async def _execute(self, received: dict[str, Any]) -> None:
        self.authority.validate("WorkerLease", received)
        lease = dict(received)
        worker = self.config["worker"]
        if (lease["accountAlias"] != self.config["accountAlias"] or lease["environment"] != self.config["environment"]
                or lease["kind"] not in worker["kinds"] or lease["policySelectionId"] != worker["selectionId"]
                or lease["policySelectionSha256"] != worker["selectionSha256"]):
            await self.control.cancel(**fence(lease), reason="policy-revoked")
            raise HostUnavailable("lease-outside-reviewed-host-selection")
        self._fenced = False
        self.active_lease, self.active_cancel = lease, asyncio.Event()
        finished = asyncio.Event()
        renewal = asyncio.create_task(self._renew(lease, finished), name="vertex-lease-renewal")
        outcome, output_ids, result_digest = "unknown", [], self.authority.digest({"status": "unknown"})
        try:
            # Preparation includes all private IO, exact-policy and current-rights
            # checks. Handler never receives a control ACK as an engine result.
            async def work() -> dict[str, Any]:
                handler, payload = await self.prepare(lease, self.active_cancel)
                if not self.is_current():
                    raise HostUnavailable("lease-fenced-before-handler")
                result = handler(payload, lease)
                if inspect.isawaitable(result):
                    result = await result
                if type(result) is not dict:
                    raise HostUnavailable("handler-result-must-be-canonical-object")
                encoded = self.authority.encode(result)
                if len(encoded) > 1_048_576:
                    raise HostUnavailable("handler-output-bound")
                return result

            self.active_task = asyncio.create_task(work(), name="vertex-lease-work")
            done, _ = await asyncio.wait((self.active_task, renewal), return_when=asyncio.FIRST_COMPLETED)
            if renewal in done:
                await renewal
                raise HostUnavailable("renewal-ended-before-job")
            result = await self.active_task
            if not self.is_current():
                raise HostUnavailable("lease-fenced-after-handler")
            output_ids = result.get("outputArtifactIds", [])
            if type(output_ids) is not list or len(output_ids) > 64 or any(type(v) is not str for v in output_ids):
                raise HostUnavailable("bounded-handler-artifact-identities-required")
            state = result.get("status")
            # A handler must report terminal completion explicitly; `accepted`
            # is transport admission and cannot be promoted here.
            if state in ("succeeded", "completed"):
                outcome = "succeeded"
            elif state in ("failed", "rejected", "unavailable"):
                outcome = "failed"
            elif state == "cancelled":
                outcome = "cancelled"
            else:
                outcome = "unknown"
            result_digest = self.authority.digest(result)
        except BaseException:
            self._fenced = True
            self.active_cancel.set()
            if self.active_task is not None and not self.active_task.done():
                # Cancelling a coroutine awaiting to_thread abandons its live
                # thread. Signal the shared cancellation token, then JOIN the
                # handler instead. A non-cooperative port keeps the owner fence
                # held; release cannot falsely claim a stopped workload.
                await asyncio.shield(asyncio.gather(self.active_task, return_exceptions=True))
            await self.on_unavailable("lease-work-unavailable")
        finally:
            finished.set()
            renewal.cancel()
            await asyncio.gather(renewal, return_exceptions=True)
            if self.cancelled.is_set():
                self.active_cancel.set()
                try:
                    await self.control.cancel(**fence(lease), reason="shutdown")
                except Exception:
                    pass  # Lease expires remotely; never resubmit or claim success.
            else:
                completion_failure = "worker-completion-unknown"
                try:
                    if lease["kind"] == "backtest":
                        # complete replaces the persisted output set. An unknown
                        # ledger must remain untouched for explicit reconciliation.
                        completion_failure = "worker-output-ledger-reconciliation-required"
                        output_ids = await self._backtest_output_ledger(lease, output_ids)
                        completion_failure = "worker-completion-unknown"
                    terminal = await self.control.complete(**fence(lease), outcome=outcome,
                        outcomeSha256=result_digest, outputArtifactIds=output_ids)
                    self.authority.validate("WorkerResult", terminal)
                    if terminal["status"] not in ("completed", "duplicate"):
                        await self.on_unavailable("worker-completion-not-acknowledged")
                except Exception:
                    await self.on_unavailable(completion_failure)
            self.active_lease = None
            self.active_cancel = None
            self.active_task = None
