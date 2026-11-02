"""Source-only adapter regressions. No engine/provider/broker is instantiated.

StubAuthority is a test double for byte/validation call wiring, not a second
public schema implementation or evidence that the native authority is qualified.
Research fixtures intentionally exercise the adapter boundary, not scientific
acceptance: the planner's independent qualification suite owns that decision.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import unittest
from dataclasses import FrozenInstanceError, replace
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from vertex_execution.adapters import (
    AdapterContractError,
    AsyncTickDrain,
    AttestedResearchSimulationEngine,
    BoundedTickBuffer,
    CapturedMarketEvent,
    EngineUnavailable,
    EngineVersionMismatch,
    KERNEL_REQUEST_VERSION,
    KernelTransportUnavailable,
    Nautilus1231Adapter,
    OfflineEngineScope,
    PreparedKernelCommand,
    ResearchEngineUnavailable,
    RustKernelCommandAdapter,
    SandboxAttestationRejected,
    SandboxSession,
    SupervisedResult,
    TickContinuityLost,
    TickEvent,
)
from vertex_execution.adapters.quarantine.v2_0_0rc5 import (
    ABI_COMPATIBLE_WITH_1231,
    ACTIVATION_SUPPORTED,
    Nautilus200rc5Adapter,
    QuarantinedEngineError,
)


class StubAuthority:
    def __init__(self):
        self.validated = []
        self.validation_result = True
        self.bad_digest = False

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.validated.append((contract_name, payload, schema_version))
        return self.validation_result

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return "0" * 64 if self.bad_digest else hashlib.sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, timestamp):
        raise AssertionError("adapter must not replace exact supplied kernel clock")


def tick(number=1):
    return TickEvent("instrument-1", f"event-{number}", number, bid=Decimal("1.10"), ask=Decimal("1.11"))


def kernel_request():
    # Private fields not interpreted by Python; actual Rust fixtures prove risk.
    return {
        "request_version": KERNEL_REQUEST_VERSION,
        "operation": "evaluate",
        "mode": "PAPER-SIMULATION",
        "now_ns": "1790078400000000001",
        "request_id": "risk-request-1",
        "account_alias": "paper-account",
        "policy": {"policy_id": "paper-policy", "costs": {"model_id": "fixed-cost-v1", "latency_model_id": "fixed-latency-v1"}},
        "journal": {"journal_id": "journal-1", "revision": "9", "owner_epoch": "3", "head_hash": "e" * 64},
        "strategy_artifact_id": "immutable-strategy-v1",
        "strategy": {"testArtifact": "strategy"},
        "intents": [{"testArtifact": "proposal-only"}],
        "legs": [{"intent_hash": "a" * 64}],
    }


def kernel_response(**changes):
    request = kernel_request()
    value = {
        "request_version": KERNEL_REQUEST_VERSION,
        "status": "admitted",
        "plan": {
            "quantity": "1.000000000000000001",
            "request_id": request["request_id"],
            "account_alias": request["account_alias"],
            "mode": request["mode"],
            "strategy_artifact_id": request["strategy_artifact_id"],
            "strategy_hash": StubAuthority().digest(request["strategy"]),
            "policy_id": request["policy"]["policy_id"],
            "cost_model_id": request["policy"]["costs"]["model_id"],
            "latency_model_id": request["policy"]["costs"]["latency_model_id"],
            "journal_id": request["journal"]["journal_id"],
            "journal_revision": request["journal"]["revision"],
            "journal_head_hash": request["journal"]["head_hash"],
            "owner_epoch": request["journal"]["owner_epoch"],
            "evaluated_at_ns": request["now_ns"],
            "live_authorization": False,
            "broker_submission_allowed": False,
        },
        "reasons": [],
        "live_authorization": False,
        "broker_submission_allowed": False,
    }
    value.update(changes)
    return value


class TickBufferTests(unittest.TestCase):
    def test_prices_and_clock_are_exact_and_immutable(self):
        value = tick()
        self.assertEqual(value.bid, Decimal("1.10"))
        with self.assertRaises(FrozenInstanceError):
            value.event_ns = 2
        for bad in (1.2, True, Decimal("NaN"), Decimal("Infinity"), Decimal("0"), Decimal("1e-19")):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                TickEvent("instrument", "event", 1, last=bad)
        for bad in (True, 1.5, -1, 2**127):
            with self.subTest(clock=bad), self.assertRaises(ValueError):
                TickEvent("instrument", "event", bad, last=Decimal("1"))
        with self.assertRaises(ValueError):
            TickEvent("instrument", "event", 1, bid=Decimal("2"), ask=Decimal("1"))

    def test_callback_never_invokes_observers_or_engine(self):
        buffer = BoundedTickBuffer(2)
        loader, factory = Mock(), Mock()
        adapter = Nautilus1231Adapter(mode="paper", buffer=buffer, load_module=loader, factory=factory)
        self.assertTrue(adapter.on_tick(tick()))
        self.assertFalse(adapter.active)
        self.assertEqual(buffer.state().pending, 1)
        loader.assert_not_called()
        factory.assert_not_called()

    def test_overflow_preserves_old_ticks_and_latches_gap(self):
        buffer = BoundedTickBuffer(1)
        self.assertTrue(buffer.on_tick(tick(1)))
        self.assertFalse(buffer.on_tick(tick(2)))
        self.assertFalse(buffer.on_tick(tick(3)))
        self.assertEqual(buffer.state().pending, 1)
        self.assertEqual(buffer.state().dropped, 2)
        self.assertTrue(buffer.state().continuity_lost)

    def test_no_unbounded_capacity_or_raw_engine_objects(self):
        for capacity in (0, -1, 65537, True, 1.5):
            with self.subTest(capacity=capacity), self.assertRaises(ValueError):
                BoundedTickBuffer(capacity)
        with self.assertRaises(TypeError):
            BoundedTickBuffer().on_tick(SimpleNamespace(instrument_id="x"))
        with self.assertRaises(ValueError):
            TickEvent("x" * 129, "event", 1, last=Decimal("1"))

    def test_close_rejects_without_erasing_observations(self):
        buffer = BoundedTickBuffer(2)
        buffer.on_tick(tick())
        buffer.close()
        self.assertFalse(buffer.on_tick(tick(2)))
        self.assertEqual(buffer.state().pending, 1)
        self.assertFalse(buffer.state().continuity_lost)


class TickDrainTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_drain_is_bounded_fifo_and_not_callback_work(self):
        buffer, seen = BoundedTickBuffer(4), []

        async def sink(event):
            seen.append(event.event_id)
            if event.event_id == "event-1":
                buffer.on_tick(tick(3))

        drain = AsyncTickDrain(buffer, sink)
        buffer.on_tick(tick(1))
        buffer.on_tick(tick(2))
        self.assertEqual(seen, [])
        self.assertEqual(await drain.drain(1), 1)
        self.assertEqual(seen, ["event-1"])
        self.assertEqual(await drain.drain(), 2)
        self.assertEqual(seen, ["event-1", "event-2", "event-3"])
        self.assertEqual(buffer.state().pending, 0)

    async def test_failed_sink_retains_head_for_deduplicated_retry(self):
        buffer, seen = BoundedTickBuffer(2), []
        buffer.on_tick(tick())

        async def fail(event):
            seen.append(event.event_id)
            raise RuntimeError("unknown sink outcome")

        with self.assertRaises(RuntimeError):
            await AsyncTickDrain(buffer, fail).drain()
        self.assertEqual(buffer.state().pending, 1)

        async def recover(event):
            seen.append(event.event_id)

        self.assertEqual(await AsyncTickDrain(buffer, recover).drain(), 1)
        self.assertEqual(seen, ["event-1", "event-1"])

    async def test_cancelled_sink_retains_head_and_releases_consumer(self):
        buffer = BoundedTickBuffer(2)
        buffer.on_tick(tick())

        async def cancel(event):
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await AsyncTickDrain(buffer, cancel).drain()
        self.assertEqual(buffer.state().pending, 1)
        self.assertFalse(buffer._draining)

    async def test_overflow_blocks_sink_even_with_buffered_ticks(self):
        buffer = BoundedTickBuffer(1)
        buffer.on_tick(tick())
        buffer.on_tick(tick(2))
        sink = Mock()
        with self.assertRaises(TickContinuityLost):
            await AsyncTickDrain(buffer, sink).drain()
        sink.assert_not_called()

    async def test_two_drains_cannot_consume_same_head_concurrently(self):
        buffer = BoundedTickBuffer(2)
        buffer.on_tick(tick())
        started, finish = asyncio.Event(), asyncio.Event()

        async def sink(event):
            started.set()
            await finish.wait()

        first = asyncio.create_task(AsyncTickDrain(buffer, sink).drain())
        try:
            await started.wait()
            with self.assertRaises(RuntimeError):
                await AsyncTickDrain(buffer, sink).drain()
        finally:
            finish.set()
            await first

    async def test_gap_during_sink_halts_remaining_drain(self):
        buffer = BoundedTickBuffer(1)
        buffer.on_tick(tick())

        async def sink(event):
            self.assertFalse(buffer.on_tick(tick(2)))

        with self.assertRaises(TickContinuityLost):
            await AsyncTickDrain(buffer, sink).drain()
        self.assertEqual(buffer.state().pending, 0)
        self.assertTrue(buffer.state().continuity_lost)


class KernelAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.authority = StubAuthority()
        self.calls = []
        self.response = self.authority.encode(kernel_response())
        owner = self

        class Transport:
            async def evaluate(self, command, *, maximum_response_bytes):
                owner.calls.append((command, maximum_response_bytes))
                return owner.response

        self.adapter = RustKernelCommandAdapter(authority=self.authority, transport=Transport())

    def test_prepare_uses_native_authority_and_detaches_input(self):
        request = kernel_request()
        prepared = self.adapter.prepare(request)
        request["strategy"]["testArtifact"] = "changed"
        self.assertEqual(json.loads(prepared.canonical_bytes)["strategy"]["testArtifact"], "strategy")
        self.assertEqual(prepared.sha256, hashlib.sha256(prepared.canonical_bytes).hexdigest())
        self.assertEqual([item[0] for item in self.authority.validated], ["StrategySpec", "TradeIntent"])
        self.assertEqual(self.calls, [])

    async def test_no_default_transport_or_subprocess_startup(self):
        adapter = RustKernelCommandAdapter(authority=self.authority)
        prepared = adapter.prepare(kernel_request())
        with self.assertRaises(KernelTransportUnavailable):
            await adapter.evaluate(prepared)
        self.assertEqual(self.calls, [])

    async def test_only_async_boundary_invokes_transport(self):
        prepared = self.adapter.prepare(kernel_request())
        result = await self.adapter.evaluate(prepared)
        self.assertEqual(self.calls, [(prepared.canonical_bytes, 2_000_000)])
        self.assertEqual(result.request_sha256, prepared.sha256)
        self.assertEqual(result.status, "admitted")
        self.assertEqual(json.loads(result.plan_bytes)["quantity"], "1.000000000000000001")
        self.assertIs(json.loads(result.canonical_response)["broker_submission_allowed"], False)

    async def test_tampered_prepared_digest_is_rejected(self):
        prepared = self.adapter.prepare(kernel_request())
        with self.assertRaises(AdapterContractError):
            await self.adapter.evaluate(PreparedKernelCommand(prepared.canonical_bytes, "0" * 64))
        self.assertEqual(self.calls, [])

    def test_false_or_truthy_nonboolean_native_validation_rejects(self):
        for result in (False, None, 1, "true"):
            self.authority.validation_result = result
            with self.subTest(result=result), self.assertRaises(AdapterContractError):
                self.adapter.prepare(kernel_request())
        self.assertEqual(self.calls, [])

    def test_live_modes_send_operations_and_inexact_clocks_reject(self):
        for change in (
            {"mode": "live"}, {"mode": "PAPER-BROKER"}, {"operation": "submit"},
            {"now_ns": 1790078400000000001}, {"now_ns": "1.2"}, {"now_ns": "01"},
            {"now_ns": str(2**127)}, {"now_ns": "١"}, {"request_version": "v2"},
        ):
            request = kernel_request()
            request.update(change)
            with self.subTest(change=change), self.assertRaises(AdapterContractError):
                self.adapter.prepare(request)

    def test_bad_native_digest_and_floating_input_reject(self):
        self.authority.bad_digest = True
        with self.assertRaises(AdapterContractError):
            self.adapter.prepare(kernel_request())
        self.authority.bad_digest = False
        request = kernel_request()
        request["quantity"] = 0.1
        with self.assertRaises(AdapterContractError):
            self.adapter.prepare(request)

    async def test_malformed_or_authority_granting_responses_reject(self):
        prepared = self.adapter.prepare(kernel_request())
        responses = [
            b'{"status":"admitted","status":"rejected"}',
            b'{"quantity":0.1}',
            b'[]', b'null', b'\xff',
            self.authority.encode(kernel_response(live_authorization=True)),
            self.authority.encode(kernel_response(broker_submission_allowed=True)),
            self.authority.encode(kernel_response(status="submitted")),
            self.authority.encode(kernel_response(plan=None)),
            self.authority.encode(kernel_response(status="rejected", reasons=[], plan=None)),
            self.authority.encode(kernel_response(extra="unsupported")),
            b"x" * 2_000_001,
        ]
        for response in responses:
            self.response = response
            with self.subTest(response=response[:60]), self.assertRaises(AdapterContractError):
                await self.adapter.evaluate(prepared)

    async def test_transport_exception_is_not_retried(self):
        calls = []

        class BrokenTransport:
            async def evaluate(self, command, *, maximum_response_bytes):
                calls.append(command)
                raise OSError("offline native endpoint unavailable")

        adapter = RustKernelCommandAdapter(authority=self.authority, transport=BrokenTransport())
        with self.assertRaises(OSError):
            await adapter.evaluate(adapter.prepare(kernel_request()))
        self.assertEqual(len(calls), 1)

    async def test_rejected_kernel_computation_has_no_plan(self):
        self.response = self.authority.encode(kernel_response(status="rejected", plan=None, reasons=["position-feed-unready"]))
        result = await self.adapter.evaluate(self.adapter.prepare(kernel_request()))
        self.assertEqual(result.reasons, ("position-feed-unready",))
        self.assertIsNone(result.plan_bytes)

    async def test_stale_cross_account_or_authorizing_private_plans_reject(self):
        prepared = self.adapter.prepare(kernel_request())
        for field, value in (
            ("request_id", "other-request"), ("account_alias", "other-account"),
            ("strategy_artifact_id", "latest"), ("strategy_hash", "0" * 64),
            ("journal_revision", "8"), ("owner_epoch", "2"), ("journal_head_hash", "0" * 64),
            ("evaluated_at_ns", "1790078400000000000"), ("live_authorization", True),
            ("broker_submission_allowed", True),
        ):
            response = kernel_response()
            response["plan"][field] = value
            self.response = self.authority.encode(response)
            with self.subTest(field=field), self.assertRaises(AdapterContractError):
                await self.adapter.evaluate(prepared)


class NautilusAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        owner = self

        class Engine:
            async def process_tick(self, event):
                owner.events.append(event)

            async def close(self):
                owner.events.append("closed")

        self.factory = Mock(return_value=Engine())
        self.loader = Mock(return_value=SimpleNamespace(__version__="1.231.0"))
        self.buffer = BoundedTickBuffer(2)
        self.adapter = Nautilus1231Adapter(mode="paper", buffer=self.buffer, load_module=self.loader, factory=self.factory)

    async def test_activation_is_lazy_and_callbacks_only_buffer(self):
        self.loader.assert_not_called()
        self.factory.assert_not_called()
        self.assertTrue(self.adapter.on_tick(tick()))
        self.assertEqual(self.events, [])
        self.adapter.activate()
        self.adapter.activate()
        self.loader.assert_called_once()
        self.factory.assert_called_once()
        scope = self.factory.call_args.args[1]
        self.assertIs(scope.simulation_only, True)
        self.assertIs(scope.live_authorization, False)
        self.assertIs(scope.broker_submission_allowed, False)
        self.assertEqual(await AsyncTickDrain(self.buffer, self.adapter.process_tick).drain(), 1)
        self.assertEqual(self.events, [tick()])
        await self.adapter.close()
        await self.adapter.close()
        self.assertEqual(self.events, [tick(), "closed"])
        with self.assertRaises(EngineUnavailable):
            self.adapter.activate()

    def test_exact_stable_version_and_separate_quarantine(self):
        for version in ("1.231", "1.231.0+local", "1.231.1", "2.0.0rc5", None):
            loader = Mock(return_value=SimpleNamespace(__version__=version))
            adapter = Nautilus1231Adapter(mode="research", buffer=BoundedTickBuffer(), load_module=loader, factory=self.factory)
            with self.subTest(version=version), self.assertRaises(EngineVersionMismatch):
                adapter.activate()
            with self.assertRaises(EngineUnavailable):
                adapter.activate()
            loader.assert_called_once()
        self.factory.assert_not_called()
        with self.assertRaises(QuarantinedEngineError):
            Nautilus200rc5Adapter().activate()
        self.assertIs(ABI_COMPATIBLE_WITH_1231, False)
        self.assertIs(ACTIVATION_SUPPORTED, False)

    async def test_missing_factory_stays_unavailable(self):
        adapter = Nautilus1231Adapter(mode="paper", buffer=BoundedTickBuffer())
        with self.assertRaises(EngineUnavailable):
            adapter.activate()
        with self.assertRaises(EngineUnavailable):
            await adapter.process_tick(tick())

    def test_live_mode_and_authority_overrides_are_not_configurable(self):
        for mode in ("live", "broker", "paper-broker", True):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                Nautilus1231Adapter(mode=mode, buffer=BoundedTickBuffer())
        with self.assertRaises(TypeError):
            OfflineEngineScope("paper", live_authorization=True)
        self.assertFalse(hasattr(self.adapter, "submit"))
        self.assertFalse(hasattr(self.adapter, "connect"))

    def test_factory_failure_is_not_automatically_retried(self):
        self.factory.side_effect = RuntimeError("failed explicit construction")
        with self.assertRaises(RuntimeError):
            self.adapter.activate()
        with self.assertRaises(EngineUnavailable):
            self.adapter.activate()
        self.factory.assert_called_once()


class ResearchAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Source sibling only; do not install or load an optional market engine.
        research_root = Path(__file__).resolve().parents[2] / "research"
        with patch.object(sys, "path", [str(research_root), *sys.path]):
            from backtesting import planner
            from backtesting.lineage import LineageInputs, Pin
            from backtesting.ports import Artifact, ResourceBudget
        cls.planner = planner
        cls.LineageInputs = LineageInputs
        cls.Pin = Pin
        cls.Artifact = Artifact
        cls.ResourceBudget = ResourceBudget

    def setUp(self):
        self.authority = StubAuthority()
        self.calls = []
        self.start_verified = True
        self.finish_verified = True
        self.change_session = False
        self.repeat_operation = False
        self.finish_proof = b"synthetic-finish-proof"
        self.start_proof = b"synthetic-start-proof"
        self.output_change = {}
        self.supervisor_output_change = {}
        self.measured_receipt_change = {}
        self.binding = None
        self.descriptor = self.planner.EngineDescriptor(
            self.Pin("offline-test-engine", "1.0.0", "a" * 64),
            ("fixed-fees",), ("captured-events",), "b" * 64, True,
        )
        self.budget = self.ResourceBudget(maximum_events=2)
        at = datetime(2026, 9, 22, tzinfo=timezone.utc)
        lineage = self.LineageInputs(
            strategy_version_id="immutable-strategy-v1", strategy_frozen_at=at,
            code_pin=self.Pin("test-code", "1.0.0", "c" * 64),
            engine_pin=self.descriptor.pin, data_pins=(), point_in_time=(),
            assumptions=(), folds=(), trials=None, forward_criteria=None,
            incidents=(), citations=(),
        )

        def artifact(name, value):
            encoded = self.authority.encode(value)
            return self.Artifact(name, encoded, hashlib.sha256(encoded).hexdigest())

        strategy = artifact("StrategySpec", {"testArtifact": "strategy"})
        run = artifact("BacktestRun", {"strategyVersion": "immutable-strategy-v1"})
        content = b"captured synthetic market events"
        self.data_hash = hashlib.sha256(content).hexdigest()
        manifest = artifact("DatasetManifest", {"contentHash": self.data_hash})
        dataset = self.planner.DatasetInput(manifest.payload_bytes, content, "captured-events", 1)
        request = self.planner.BacktestRequest(
            strategy.payload_bytes, run.payload_bytes, (dataset,), (), lineage, self.budget, at
        )
        plan = self.planner.BacktestPlan(
            request, "ready", strategy, run, (manifest,), (),
            artifact("internal.BacktestLineage.v1", {"lineage": lineage.record()}),
            (), (), self.descriptor,
        )
        self.request = self.planner.SimulationRequest(plan)
        self.events = [CapturedMarketEvent(self.data_hash, "event-1", 1, 2, b'{"last":"1.00"}')]
        owner = self

        class Loader:
            def load(self, request, *, maximum_events, maximum_bytes):
                owner.calls.append(("loader", maximum_events, maximum_bytes))
                return iter(owner.events)

        class Runner:
            def describe(self):
                owner.calls.append("runner-describe")
                return owner.descriptor

            def run(self, request, events):
                owner.calls.append("runner")
                binding = owner.binding
                receipt = owner.planner.SandboxReceipt(
                    binding.policy_digest, binding.budget, True, False, False,
                    binding.input_bytes, len(events), 1000, 1, 1, "isolation-evidence",
                )
                result = owner.planner.SimulationOutput(
                    request.plan.lineage.digest, request.plan.strategy.digest, owner.descriptor.pin,
                    (owner.data_hash,), "d" * 64, b'{"metrics":{"pnl":"0"}}',
                    (b'{"evidenceId":"isolation-evidence"}',), ("fixed-fees",), receipt,
                    True, True, True, "completed",
                )
                return replace(result, **owner.output_change)

        class Supervisor:
            def execute(self, binding, operation):
                owner.calls.append("supervisor")
                owner.binding = binding
                session = SandboxSession("test-supervisor", "session-1", binding.policy_digest, owner.start_proof)
                output = operation(session)
                if owner.repeat_operation:
                    operation(session)
                if owner.change_session:
                    session = replace(session, session_id="session-2")
                receipt = replace(output.sandbox, **owner.measured_receipt_change)
                output = replace(output, sandbox=receipt, **owner.supervisor_output_change)
                return SupervisedResult(session, output, owner.finish_proof)

        class Verifier:
            # Only verifies adapter call ordering/binding. These synthetic proof
            # tokens and booleans are not a production trust-root implementation.
            def verify_start(self, session, binding):
                owner.calls.append("verify-start")
                owner.assertEqual(session.policy_digest, binding.policy_digest)
                owner.assertEqual(binding, owner.binding)
                return owner.start_verified

            def verify_finish(self, result, binding):
                owner.calls.append("verify-finish")
                owner.assertEqual(result.output.lineage_digest, binding.lineage_digest)
                return owner.finish_verified

        self.adapter = AttestedResearchSimulationEngine(
            descriptor=self.descriptor, authority=self.authority, loader=Loader(),
            runner=Runner(), supervisor=Supervisor(), verifier=Verifier(),
        )

    def test_missing_ports_are_unavailable(self):
        unavailable = AttestedResearchSimulationEngine()
        with self.assertRaises(ResearchEngineUnavailable):
            unavailable.describe()
        with self.assertRaises(ResearchEngineUnavailable):
            unavailable.simulate(self.request)
        self.assertEqual(self.calls, [])

    def test_describe_is_metadata_only_and_simulate_is_explicit(self):
        self.assertEqual(self.adapter.describe(), self.descriptor)
        self.assertEqual(self.calls, [])
        result = self.adapter.simulate(self.request)
        self.assertEqual(result.status, "completed")
        self.assertEqual(self.calls[0:3], ["supervisor", "verify-start", "runner-describe"])
        self.assertEqual(self.calls[-2:], ["runner", "verify-finish"])
        self.assertEqual(self.binding.lineage_digest, self.request.plan.lineage.digest)
        self.assertEqual(self.binding.strategy_digest, self.request.plan.strategy.digest)
        self.assertEqual(self.binding.budget, self.budget)
        self.assertIs(result.sandbox.execution_authority_used, False)

    def test_unverified_start_blocks_loader_and_runner(self):
        for decision in (False, 1, "true", None):
            self.start_verified = decision
            self.calls.clear()
            with self.subTest(decision=decision), self.assertRaises(SandboxAttestationRejected):
                self.adapter.simulate(self.request)
            self.assertEqual(self.calls, ["supervisor", "verify-start"])

    def test_boolean_receipt_without_finish_proof_is_rejected(self):
        self.finish_verified = False
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)
        self.assertIn("runner", self.calls)
        self.assertEqual(self.calls[-1], "verify-finish")
        self.finish_verified = True
        self.finish_proof = b""
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)

    def test_empty_start_proof_is_rejected_before_workload(self):
        self.start_proof = b""
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)
        self.assertEqual(self.calls, ["supervisor"])

    def test_supervisor_session_substitution_is_rejected(self):
        self.change_session = True
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)
        self.assertNotIn("verify-finish", self.calls)

    def test_supervisor_cannot_repeat_operation(self):
        self.repeat_operation = True
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)
        self.assertEqual(self.calls.count("runner"), 1)

    def test_changed_dataset_bytes_never_reach_supervisor(self):
        source = replace(self.request.plan.request.datasets[0], content_bytes=b"substituted capture")
        changed = replace(self.request.plan.request, datasets=(source,))
        request = replace(self.request, plan=replace(self.request.plan, request=changed))
        with self.assertRaises(ValueError):
            self.adapter.simulate(request)
        self.assertEqual(self.calls, [])

    def test_native_contract_rejection_never_reaches_supervisor(self):
        self.authority.validation_result = False
        with self.assertRaises(ValueError):
            self.adapter.simulate(self.request)
        self.assertEqual(self.calls, [])

    def test_event_lineage_and_budget_fail_closed(self):
        good = self.events[0]
        for events in (
            [replace(good, dataset_content_digest="0" * 64)],
            [good, good],
            [good, replace(good, event_id="event-2", available_ns=1)],
            [good, replace(good, event_id="event-2"), replace(good, event_id="event-3")],
            [],
        ):
            self.events = events
            self.calls.clear()
            with self.subTest(events=events), self.assertRaises(ValueError):
                self.adapter.simulate(self.request)
            self.assertNotIn("runner", self.calls)
            self.assertNotIn("verify-finish", self.calls)

    def test_output_lineage_and_measured_accounting_cannot_be_rebound(self):
        self.output_change = {"strategy_digest": "0" * 64}
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)
        self.assertNotIn("verify-finish", self.calls)

    def test_nonready_or_executable_plan_never_reaches_supervisor(self):
        for change in ({"status": "inconclusive"}, {"execution_authorized": True}, {"missing_ports": ("native",)}):
            with self.subTest(change=change), self.assertRaises(ResearchEngineUnavailable):
                self.adapter.simulate(replace(self.request, plan=replace(self.request.plan, **change)))
        self.assertEqual(self.calls, [])

    def test_changed_captured_input_changes_supervisor_binding(self):
        self.adapter.simulate(self.request)
        first_digest = self.binding.request_digest
        changed = replace(self.request.plan.request, planned_at=datetime(2026, 9, 23, tzinfo=timezone.utc))
        self.adapter.simulate(replace(self.request, plan=replace(self.request.plan, request=changed)))
        self.assertNotEqual(self.binding.request_digest, first_digest)

    def test_supervisor_finalizes_only_authenticated_measured_receipt(self):
        self.measured_receipt_change = {"cpu_ms": 2, "wall_ms": 3}
        result = self.adapter.simulate(self.request)
        self.assertEqual(result.sandbox.cpu_ms, 2)
        self.assertEqual(self.calls[-1], "verify-finish")
        self.supervisor_output_change = {"economics_bytes": b'{"metrics":{"pnl":"999999"}}'}
        with self.assertRaises(SandboxAttestationRejected):
            self.adapter.simulate(self.request)

    def test_resource_breaches_and_capability_claims_reject_even_with_verifier(self):
        for change in (
            {"network_used": True}, {"execution_authority_used": True},
            {"limits_enforced": False}, {"input_bytes": 0}, {"events_processed": 0},
            {"peak_memory_bytes": self.budget.maximum_memory_bytes + 1},
            {"cpu_ms": self.budget.maximum_cpu_ms + 1},
            {"wall_ms": self.budget.maximum_wall_ms + 1},
        ):
            self.calls.clear()
            self.measured_receipt_change = change
            with self.subTest(change=change), self.assertRaises(SandboxAttestationRejected):
                self.adapter.simulate(self.request)
            self.assertNotIn("verify-finish", self.calls)
