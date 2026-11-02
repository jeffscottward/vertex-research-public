"""Authored regressions only. No real namespace/process/network probes in tests.

OS launch behavior is exercised through mocks; production capability acceptance
must later run separately on the reviewed deployment, never infer it from these.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import queue
import threading
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backtesting.lineage import LineageInputs, Pin, time_ns
from backtesting.planner import (
    BacktestPlan, BacktestRequest, DatasetInput, EngineDescriptor, SandboxReceipt,
    SimulationOutput, SimulationRequest,
)
from backtesting.ports import Artifact, ResourceBudget
from vertex_execution.adapters.research import ResearchRunBinding, ResearchEngineUnavailable
from vertex_host.research_engine import (
    ENGINE_ID, ENGINE_VERSION, EVENT_FORMAT, MODELED_ASSUMPTIONS,
    FixedQuoteResearchRunner, IsolatedResearchSimulationEngine, JsonlEventLoader, ReviewedResearchModel,
    create_backtest_handler,
)
from vertex_host.sandbox import (
    NATIVE_RESEARCH_PROFILE, PROTOCOL, PYTHON_PATH, WORKER_PATH, ConfiguredSandbox, LinuxSandboxSupervisor,
    NativeResearchProfile, ReviewedSandboxConfig, RuntimeFilePin, SandboxRejected, SandboxUnavailable,
    load_sandbox, pack, protocol_bytes, protocol_record, unpack, wire_registry,
)
from vertex_host.sandbox_worker import LocalEnforcedSupervisor, LinuxSandboxVerifier, ProtocolChannel


class SyntheticAuthority:
    """Test transport/shape fixture only, never a production native authority."""
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        return schema_version == "1.0.0"

    def epoch_ns(self, timestamp):
        return time_ns(timestamp)


AUTHORITY = SyntheticAuthority()


def config():
    # Fictional metadata only: no filesystem inspection or native ABI qualification.
    libc = RuntimeFilePin("/usr/lib/libc.so.6", "7" * 64, 40)
    return ReviewedSandboxConfig(
        rootfs="/opt/vertex/reviewed-root", bwrap_path="/usr/bin/bwrap", bwrap_sha256="1" * 64,
        bwrap_size=123, runtime_files=(RuntimeFilePin(PYTHON_PATH, "2" * 64, 10),
            RuntimeFilePin(WORKER_PATH, "3" * 64, 20),
            RuntimeFilePin("/vertex/host/vertex_host/research_engine.py", "4" * 64, 30), libc),
        cgroup_root="/sys/fs/cgroup/system.slice/vertex.service", review_digest="5" * 64,
        maximum_wire_bytes=43_000_000, maximum_rpc_calls=1024, maximum_stderr_bytes=1024,
        native_research=NativeResearchProfile(NATIVE_RESEARCH_PROFILE, libc),
    )


def artifact(name, value):
    raw = AUTHORITY.encode(value)
    return Artifact(name, raw, hashlib.sha256(raw).hexdigest())


def row(identity, event, available, **changes):
    result = {"eventId": identity, "eventNs": event, "availableNs": available,
              "payload": {"instrumentId": "equity-test", "bid": "10", "ask": "11", "bidSize": "2", "askSize": "2"}}
    result.update(changes)
    return protocol_bytes(result) + b"\n"


def request(contents=(row("a", 1, 2),), counts=(1,)):
    cfg = config()
    descriptor = EngineDescriptor(Pin(ENGINE_ID, ENGINE_VERSION, "4" * 64), MODELED_ASSUMPTIONS,
                                  (EVENT_FORMAT,), cfg.policy_digest, True)
    budget = ResourceBudget(maximum_events=8)
    at = datetime(2026, 1, 1, tzinfo=UTC)
    lineage = LineageInputs("strategy-v1", at, Pin("strategy-code", "1.0.0", "6" * 64),
                           descriptor.pin, (), (), (), (), None, None, (), ())
    strategy = artifact("StrategySpec", {"fixture": "strategy"})
    run = artifact("BacktestRun", {"fixture": "run"})
    manifests = tuple(artifact("DatasetManifest", {
        "contentHash": hashlib.sha256(content).hexdigest(),
        "startAtInclusive": "1970-01-01T00:00:00Z", "endAtExclusive": "1970-01-01T00:00:01Z",
        "captureTime": "1970-01-01T00:00:02Z"}) for content in contents)
    datasets = tuple(DatasetInput(manifest.payload_bytes, content, EVENT_FORMAT, declared)
                     for manifest, content, declared in zip(manifests, contents, counts, strict=True))
    raw = BacktestRequest(strategy.payload_bytes, run.payload_bytes, datasets, (), lineage, budget, at)
    plan = BacktestPlan(raw, "ready", strategy, run, manifests, (),
                        artifact("internal.Lineage", {"fixture": "lineage"}), (), (), descriptor)
    return SimulationRequest(plan)


class ClosedWireTests(unittest.TestCase):
    def test_exact_native_envelopes_round_trip_without_pickle_or_import_names(self):
        value = request()
        registry = wire_registry()
        self.assertEqual(unpack(pack(value, registry), registry), value)
        self.assertEqual(unpack(pack((b"raw", 2**100, True), registry), registry), (b"raw", 2**100, True))

    def test_unknown_fields_types_and_duplicate_keys_fail_closed(self):
        registry = wire_registry()
        for value in ({"record": "os.system", "fields": {}}, {"record": "Pin", "fields": {"identity": "x"}},
                      {"integer": "01"}, {"integer": "True"}, {"mapping": [["a", None], ["a", None]]}):
            with self.subTest(value=value), self.assertRaises((ValueError, SandboxRejected)):
                unpack(value, registry)
        for raw in (b'{"a":1,"a":2}', b'{"a":1.0}', b'{"a":NaN}', b'[]'):
            with self.subTest(raw=raw), self.assertRaises(SandboxRejected):
                protocol_record(raw)

    def test_nonfinite_or_unbounded_wire_and_model_values_rejected(self):
        with self.assertRaises(SandboxRejected):
            pack(object(), wire_registry())
        with self.assertRaises(SandboxRejected):
            protocol_bytes({"tooLarge": "x" * 100}, 32)
        with self.assertRaises(ValueError):
            RuntimeFilePin("/vertex/../etc/passwd", "0" * 64, 12)


class LoaderTests(unittest.TestCase):
    def load(self, value, **limits):
        return tuple(JsonlEventLoader(AUTHORITY).load(value, maximum_events=limits.get("maximum_events", 8),
                                                     maximum_bytes=limits.get("maximum_bytes", 8000)))

    def test_independent_pinned_streams_merge_causally_with_exact_payloads(self):
        value = request((row("a", 1, 2) + row("b", 5, 6), row("c", 3, 4)), (2, 1))
        loaded = self.load(value)
        self.assertEqual([event.event_id for event in loaded], ["a", "c", "b"])
        self.assertEqual(loaded[0].event_ns, 1)
        self.assertEqual(protocol_record(loaded[0].payload_bytes)["ask"], "11")

    def test_missing_extra_duplicate_unsorted_or_unterminated_rows_are_not_truncated(self):
        cases = ((row("a", 1, 2), 2), (row("a", 1, 2) + row("b", 3, 4), 1),
                 (row("a", 1, 2) + row("a", 3, 4), 2), (row("b", 3, 4) + row("a", 1, 2), 2),
                 (row("a", 1, 2).rstrip(b"\n"), 1), (row("a", 3, 2), 1),
                 (row("a", True, 2), 1))
        for content, count in cases:
            with self.subTest(content=content), self.assertRaises((ValueError, SandboxRejected)):
                self.load(request((content,), (count,)))

    def test_digest_event_and_byte_limits_apply_before_yielding(self):
        value = request()
        changed = replace(value.plan.request.datasets[0], content_bytes=b"tampered\n")
        bad = replace(value, plan=replace(value.plan, request=replace(value.plan.request, datasets=(changed,))))
        with self.assertRaises(ValueError):
            self.load(bad)
        with self.assertRaises(ValueError):
            self.load(request((row("a", 1, 2) + row("b", 3, 4),), (2,)), maximum_events=1)
        with self.assertRaises(ValueError):
            self.load(value, maximum_bytes=1)

    def test_paths_formats_and_floating_payloads_never_select_a_loader(self):
        value = request()
        source = replace(value.plan.request.datasets[0], content_format="python")
        value = replace(value, plan=replace(value.plan, request=replace(value.plan.request, datasets=(source,))))
        with self.assertRaises(ResearchEngineUnavailable):
            self.load(value)
        content = row("a", 1, 2).replace(b'"11"', b'11.5')
        with self.assertRaises(SandboxRejected):
            self.load(request((content,), (1,)))


class OuterSupervisorTests(unittest.TestCase):
    def test_missing_configuration_and_arbitrary_parent_callback_never_launch(self):
        callback = Mock()
        with patch("vertex_host.sandbox.subprocess.Popen") as popen:
            with self.assertRaises(SandboxUnavailable):
                LinuxSandboxSupervisor().execute(None, callback)
            with self.assertRaises(ResearchEngineUnavailable):
                IsolatedResearchSimulationEngine().describe()
        callback.assert_not_called()
        popen.assert_not_called()

    def test_launcher_is_exact_no_shell_network_or_host_root_binding(self):
        supervisor = LinuxSandboxSupervisor(config())
        args = supervisor._argv(Path(config().cgroup_root) / "job", ResourceBudget(), "job", "3" * 64)
        self.assertEqual(args[0], "/usr/bin/bwrap")
        for flag in ("--unshare-all", "--die-with-parent", "--cap-drop", "--disable-userns", "--clearenv", "-I", "-S", "-B"):
            self.assertIn(flag, args)
        self.assertNotIn("--share-net", args)
        self.assertNotIn("/bin/sh", args)
        self.assertEqual(args[args.index("--ro-bind") + 1:args.index("--ro-bind") + 3], [config().rootfs, "/"])
        self.assertEqual(args[-1], "decode")
        native_args = supervisor._argv(Path(config().cgroup_root) / "job", ResourceBudget(),
                                       "job", "3" * 64, mode=NATIVE_RESEARCH_PROFILE)
        self.assertEqual(native_args[:-1], args[:-1])
        self.assertEqual(native_args[-1], NATIVE_RESEARCH_PROFILE)

    def test_task_limits_require_explicit_native_profile_and_inventory(self):
        reviewed = config()
        self.assertEqual(reviewed.task_limit("decode"), 1)
        self.assertEqual(reviewed.task_limit("candle-fold-v1"), 1)
        self.assertEqual(reviewed.task_limit(NATIVE_RESEARCH_PROFILE), 2)
        absent = replace(reviewed, native_research=None)
        with self.assertRaises(SandboxUnavailable):
            absent.task_limit(NATIVE_RESEARCH_PROFILE)
        with self.assertRaises(SandboxUnavailable):
            reviewed.task_limit("research")
        with self.assertRaises(ValueError):
            replace(reviewed, runtime_files=tuple(pin for pin in reviewed.runtime_files
                                                  if pin != reviewed.native_research.libc))
        self.assertNotEqual(absent.policy_digest, reviewed.policy_digest)
        value = request()
        with patch("vertex_host.sandbox.subprocess.Popen") as popen:
            with self.assertRaises(SandboxUnavailable):
                LinuxSandboxSupervisor(absent).run_worker(value, value.plan.engine,
                    SimpleNamespace(record=lambda: {}), AUTHORITY)
        popen.assert_not_called()

    def test_factory_is_metadata_only_and_closed_configuration(self):
        from dataclasses import asdict
        with patch("vertex_host.sandbox._verify_runtime") as verify, patch("vertex_host.sandbox.subprocess.Popen") as popen:
            value = load_sandbox(asdict(config()), AUTHORITY, Mock(), threading.Event())
            self.assertIsInstance(value, ConfiguredSandbox)
            self.assertIsNone(load_sandbox(None, AUTHORITY, Mock(), threading.Event()).config)
            with self.assertRaises(SandboxUnavailable):
                load_sandbox({**asdict(config()), "allowNetwork": True}, AUTHORITY, Mock(), threading.Event())
        verify.assert_not_called()
        popen.assert_not_called()

    def test_decoder_rejects_new_operation_deadline_or_cancel_before_launch(self):
        clock = SimpleNamespace(now_ns=lambda: 100)
        cancel = threading.Event()
        supervisor = load_sandbox(None, AUTHORITY, clock, cancel)
        with patch("vertex_host.sandbox.subprocess.Popen") as popen:
            for operation in ("shell", "provider.fetch", "adapters.decode-csv"):
                with self.assertRaises(SandboxUnavailable):
                    supervisor.call(operation, {}, deadline_ns=200, max_output_bytes=100)
            supervisor.config = config()
            cancel.set()
            with self.assertRaises(SandboxRejected):
                supervisor.call("adapters.decode-csv", {}, deadline_ns=10**12, max_output_bytes=100)
        popen.assert_not_called()

    def test_unknown_authority_rpc_never_invokes_methods(self):
        authority = Mock()
        result = queue.Queue(maxsize=1)
        LinuxSandboxSupervisor._authority_call(authority, {"method": "open", "args": ["/etc/passwd"]}, result, 1000)
        self.assertEqual(result.get_nowait(), (False, None))
        self.assertEqual(authority.mock_calls, [])

    def test_caller_cancel_terminates_child_and_never_publishes_receipt(self):
        supervisor = LinuxSandboxSupervisor(config())
        value = request()
        process = Mock()
        process.stdin = io.BytesIO()
        process.stdout = io.BytesIO()
        process.stderr = io.BytesIO()
        model = SimpleNamespace(record=lambda: {})
        with patch("vertex_host.sandbox._verify_runtime"), patch.object(supervisor, "_create_cgroup", return_value=Path("/synthetic/cgroup")), \
                patch("vertex_host.sandbox.subprocess.Popen", return_value=process), \
                patch.object(supervisor, "_exchange", side_effect=KeyboardInterrupt), patch.object(supervisor, "_stop") as stop:
            with self.assertRaises(KeyboardInterrupt):
                supervisor.run_worker(value, value.plan.engine, model, AUTHORITY)
        stop.assert_called_once_with(process, Path("/synthetic/cgroup"))
        self.assertIsNone(supervisor.last_receipt)
        self.assertTrue(supervisor._lock.acquire(blocking=False))
        supervisor._lock.release()


class LocalSupervisorTests(unittest.TestCase):
    def test_worker_local_callback_preserves_adapter_nonlocals_once(self):
        value = request()
        budget = value.plan.request.budget
        binding = ResearchRunBinding("a" * 64, value.plan.lineage.digest, value.plan.strategy.digest,
            value.plan.run.digest, value.plan.engine.pin.digest, value.plan.engine.sandbox_policy_digest, budget, 100)
        owner = LocalEnforcedSupervisor({}, budget, "synthetic-session", binding.policy_digest)
        verifier = LinuxSandboxVerifier(owner)
        receipt = SandboxReceipt(binding.policy_digest, budget, True, False, False, 100, 1, 10, 1, 1,
                                 "isolation-synthetic-session")
        output = SimulationOutput(binding.lineage_digest, binding.strategy_digest, value.plan.engine.pin,
            (value.plan.datasets[0].decode()["contentHash"],), "a" * 64, b'{"synthetic":true}', (b'{}',),
            MODELED_ASSUMPTIONS, receipt, True, True, True, "inconclusive")
        callback_count = 0
        used_session = None
        def callback(session):
            nonlocal callback_count, used_session
            callback_count += 1
            used_session = session
            self.assertTrue(verifier.verify_start(session, binding))
            owner._evidence_bytes = b'{}'
            return output
        with patch("vertex_host.sandbox_worker.observe_local", return_value={"synthetic": True}), patch.object(owner, "receipt", return_value=receipt):
            result = owner.execute(binding, callback)
            self.assertTrue(verifier.verify_finish(result, binding))
            self.assertFalse(verifier.verify_finish(result, binding))
            with self.assertRaises(Exception):
                owner.execute(binding, callback)
        self.assertEqual(callback_count, 1)
        self.assertIs(used_session, result.session)
        self.assertIsNone(owner.active_binding)

    def test_enforcement_observation_failure_prevents_callback(self):
        value = request()
        budget = value.plan.request.budget
        binding = ResearchRunBinding(*(["a" * 64] * 6), budget, 100)
        owner = LocalEnforcedSupervisor({}, budget, "synthetic", binding.policy_digest)
        callback = Mock()
        with patch("vertex_host.sandbox_worker.observe_local", side_effect=SandboxRejected("missing controls")):
            with self.assertRaises(SandboxRejected):
                owner.execute(binding, callback)
        callback.assert_not_called()

    def test_protocol_limits_stop_oversized_child_input_without_logging_it(self):
        channel = ProtocolChannel(20)
        with patch("vertex_host.sandbox_worker.os.read", return_value=b"x" * 21):
            with self.assertRaises(SandboxRejected):
                channel.receive()


class FixedEconomicRunnerTests(unittest.TestCase):
    def fixture(self):
        value = request((row("entry", 1, 2) + row("exit", 3, 4),), (2,))
        run = artifact("BacktestRun", {"testWindow": {
            "startAtInclusive": "1970-01-01T00:00:00Z",
            "endAtExclusive": "1970-01-01T00:00:01Z"}})
        value = replace(value, plan=replace(value.plan, run=run))
        budget = value.plan.request.budget
        binding = ResearchRunBinding("a" * 64, value.plan.lineage.digest, value.plan.strategy.digest,
            run.digest, value.plan.engine.pin.digest, value.plan.engine.sandbox_policy_digest, budget, 100)
        model = ReviewedResearchModel(value.plan.strategy.digest, value.plan.request.lineage.code_pin.digest,
            AUTHORITY.digest([]), value.plan.engine.pin.digest, "9" * 64, "equity-test",
            "1", "1000", "1", "0", 2, 4,
            b'{"acceptanceStatus":"unreviewed","untrustedContent":true}')
        receipt = SandboxReceipt(binding.policy_digest, budget, True, False, False, 100, 2, 10, 1, 1,
                                 "synthetic-isolation")
        supervisor = SimpleNamespace(active_binding=binding,
            isolation_evidence=lambda *args: b'{"synthetic":"unreviewed"}',
            receipt=lambda count: replace(receipt, events_processed=count))
        events = tuple(JsonlEventLoader(AUTHORITY).load(value, maximum_events=8, maximum_bytes=8000))
        return value, model, supervisor, events

    def test_exact_quote_economics_is_real_computation_but_never_scientific_acceptance(self):
        value, model, supervisor, events = self.fixture()
        result = FixedQuoteResearchRunner(value.plan.engine, AUTHORITY, model, supervisor).run(value, events)
        economics = protocol_record(result.economics_bytes)
        self.assertEqual(economics["metrics"]["gross-pnl"], "-1")
        self.assertEqual(economics["metrics"]["net-pnl"], "-3")
        self.assertEqual(economics["metrics"]["ending-cash"], "997")
        self.assertEqual(economics["metricScope"], "out-of-sample")
        self.assertEqual(result.status, "inconclusive")
        self.assertTrue(result.economics_simulated)
        self.assertFalse(economics["executionAuthorized"])
        self.assertEqual(result.incident_codes, ("fixed-model-realism-review-required",))

    def test_missing_exit_never_manufactures_supplied_or_zero_pnl(self):
        value, model, supervisor, events = self.fixture()
        result = FixedQuoteResearchRunner(value.plan.engine, AUTHORITY, model, supervisor).run(value, events[:1])
        self.assertEqual(protocol_record(result.economics_bytes)["metrics"], {})
        self.assertFalse(result.economics_simulated)
        self.assertEqual(result.status, "inconclusive")

    def test_model_and_strategy_pin_mismatch_never_executes_dynamic_code(self):
        value, model, supervisor, events = self.fixture()
        runner = FixedQuoteResearchRunner(value.plan.engine, AUTHORITY,
                                         replace(model, strategy_digest="0" * 64), supervisor)
        with self.assertRaises(ResearchEngineUnavailable):
            runner.run(value, events)
        with self.assertRaises(ResearchEngineUnavailable):
            FixedQuoteResearchRunner(replace(value.plan.engine, supported_formats=("python",)),
                                     AUTHORITY, model, supervisor)


class SeccompPolicyTests(unittest.TestCase):
    def test_bpf_default_denies_network_process_exec_and_writable_opens(self):
        import os
        from vertex_host.sandbox_worker import install_seccomp
        captured = []
        def prctl(option, *args):
            if option == 22:
                program = args[1]._obj
                captured.extend((row.code, row.jt, row.jf, row.k)
                                for row in program.filter[:program.len])
            return 0
        libc = SimpleNamespace(prctl=prctl)
        with patch("vertex_host.sandbox_worker.ctypes.CDLL", return_value=libc), \
                patch("vertex_host.sandbox_worker.os.uname", return_value=SimpleNamespace(machine="x86_64")):
            install_seccomp()
        def decision(number, flags=0, pointer=0, arch=0xC000003E):
            memory = {0: number, 4: arch, 24: flags, 28: 0,
                      32: pointer if number == 302 else flags, 36: 0}
            pc = accumulator = 0
            for _ in range(512):
                code, yes, no, value = captured[pc]
                if code == 0x20:
                    accumulator = memory.get(value, 0)
                elif code == 0x15:
                    pc += yes if accumulator == value else no
                elif code == 0x45:
                    pc += yes if accumulator & value else no
                elif code == 0x06:
                    return value
                else:
                    self.fail("unexpected BPF instruction")
                pc += 1
            self.fail("unterminated BPF policy")
        allowed = 0x7FFF0000
        for number in (41, 42, 43, 44, 45, 46, 47, 49, 50, 53, 56, 57, 58, 59, 101, 165, 272, 308, 322, 435, 437, 999, 0x40000029):
            with self.subTest(syscall=number):
                self.assertNotEqual(decision(number), allowed)
        for number in (2, 257):
            self.assertEqual(decision(number, os.O_RDONLY), allowed)
            self.assertEqual(decision(number, os.O_RDONLY | os.O_DIRECTORY), allowed)
            for flags in (os.O_WRONLY, os.O_RDWR, os.O_CREAT, os.O_TRUNC, os.O_APPEND, os.O_TMPFILE):
                self.assertNotEqual(decision(number, flags), allowed)
        self.assertEqual(decision(302, pointer=0), allowed)
        self.assertNotEqual(decision(302, pointer=1), allowed)
        self.assertNotEqual(decision(0, arch=0x40000003), allowed)

    def test_kernel_refusal_fails_closed_without_an_allow_fallback(self):
        from vertex_host.sandbox_worker import install_seccomp
        with patch("vertex_host.sandbox_worker.ctypes.CDLL", return_value=SimpleNamespace(prctl=lambda *args: -1)), \
                patch("vertex_host.sandbox_worker.os.uname", return_value=SimpleNamespace(machine="x86_64")):
            with self.assertRaises(SandboxUnavailable):
                install_seccomp()


class HandlerFactoryTests(unittest.TestCase):
    def test_handler_factory_has_no_io_or_publication_effect(self):
        context = Mock()
        with patch("vertex_host.sandbox.subprocess.Popen") as popen:
            handler = create_backtest_handler(context, Mock(), {}, Mock())
            self.assertTrue(callable(handler))
        self.assertEqual(context.mock_calls, [])
        popen.assert_not_called()




class CompleteRuntimeInventoryRegression(unittest.TestCase):
    def test_unenumerable_runtime_directory_fails_closed(self):
        from vertex_host.sandbox import _verify_runtime
        config = SimpleNamespace(rootfs="/reviewed/rootfs", bwrap_path="/reviewed/bwrap",
            bwrap_sha256="a" * 64, bwrap_size=1, runtime_files=())
        def unreadable_walk(root, *, followlinks, onerror):
            self.assertFalse(followlinks)
            onerror(PermissionError("unreadable executable runtime directory"))
            return iter(())
        with patch("vertex_host.sandbox.os.uname", return_value=SimpleNamespace(sysname="Linux", machine="x86_64")), \
             patch("vertex_host.sandbox.os.geteuid", return_value=1000), \
             patch.object(Path, "resolve", lambda self, strict=False: self), \
             patch.object(Path, "stat", return_value=SimpleNamespace(st_mode=0)), \
             patch("vertex_host.sandbox._require_readonly_runtime_mount"), \
             patch("vertex_host.sandbox._root_owned"), \
             patch("vertex_host.sandbox._verify_file"), \
             patch("vertex_host.sandbox._require_static_launcher"), \
             patch("vertex_host.sandbox.os.walk", side_effect=unreadable_walk):
            with self.assertRaisesRegex(SandboxUnavailable, "inventory traversal failed"):
                _verify_runtime(config)

    def test_maximum_payload_excludes_line_delimiter(self):
        payload = {"type": "bounded", "value": "x" * 32}
        raw = protocol_bytes(payload, 1024)
        channel = ProtocolChannel(len(raw))
        with patch("vertex_host.sandbox_worker.os.read", return_value=raw + b"\n"):
            self.assertEqual(channel.receive(), payload)

    def test_oversized_unterminated_payload_is_rejected(self):
        channel = ProtocolChannel(64)
        with patch("vertex_host.sandbox_worker.os.read", return_value=b"x" * 65):
            with self.assertRaises(SandboxRejected):
                channel.receive()


if __name__ == "__main__":
    unittest.main()
