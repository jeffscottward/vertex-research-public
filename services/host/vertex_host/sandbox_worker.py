"""Pinned child entrypoint. Not a Python-eval service or user-selected module.

Bootstrap joins the preconfigured cgroup and applies hard rlimits BEFORE importing
research dependencies. A seccomp default-deny filter is installed before reading
ANY input. The entire AttestedResearchSimulationEngine and its closure stay in
this process; the parent only brokers the authoritative codec and measures exit.
"""
from __future__ import annotations

import os
import resource
import sys

_NATIVE_PROFILE = "nautilus-rc5-glibc244-x86_64-2task-v1"
_FOLD_MODE = "candle-fold-v1"


def _bootstrap() -> tuple[str, str, str, int, int, int, str]:
    if len(sys.argv) != 8 or sys.version_info[:3] != (3, 12, 11) or sys.platform != "linux":
        raise RuntimeError("exact reviewed Linux Python worker required")
    session, policy, worker_hash, memory_text, cpu_text, wire_text, mode = sys.argv[1:]
    if mode not in (_NATIVE_PROFILE, "decode", _FOLD_MODE):
        raise RuntimeError("unknown fixed worker mode")
    memory, cpu, wire = int(memory_text), int(cpu_text), int(wire_text)
    if not 1 <= memory <= 8_000_000_000 or not 1 <= cpu <= 3_600_000 or not 65_536 <= wire <= 128_000_000:
        raise RuntimeError("invalid bootstrap limits")
    fd = os.open("/vertex-cgroup.procs", os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.write(fd, str(os.getpid()).encode("ascii"))
    finally:
        os.close(fd)
    for kind, value in ((resource.RLIMIT_AS, memory), (resource.RLIMIT_CPU, (cpu + 999) // 1000),
                        (resource.RLIMIT_NPROC, 2 if mode == _NATIVE_PROFILE else 1), (resource.RLIMIT_NOFILE, 32),
                        (resource.RLIMIT_FSIZE, 0), (resource.RLIMIT_CORE, 0)):
        resource.setrlimit(kind, (value, value))
    # Fixed administrator-provisioned read-only roots; never from a request/env.
    sys.path[:0] = ["/vertex/host", "/vertex/execution", "/vertex/research", "/vertex/deps"]
    return session, policy, worker_hash, memory, cpu, wire, mode


_BOOTSTRAP = _bootstrap() if __name__ == "__main__" else None

import base64
import ctypes
import hashlib
import hmac
import time
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from vertex_execution.adapters.contracts import canonical_record
from vertex_execution.adapters.research import (
    AttestedResearchSimulationEngine, ResearchRunBinding, SandboxAttestationRejected,
    SandboxSession, SupervisedResult,
)
from vertex_host.sandbox import (
    PROTOCOL, WORKER_PATH, NATIVE_RESEARCH_PROFILE, NativeResearchProfile, RuntimeFilePin,
    SandboxRejected, SandboxUnavailable, _integer,
    _key_values, _read_small, fold_wire_registry, pack, protocol_bytes, protocol_record, unpack, wire_registry,
)
from vertex_host.research_engine import JsonlEventLoader, ReviewedResearchModel
from vertex_host.nautilus_research import NautilusResearchRunner
from vertex_host.config import read_regular


def install_seccomp(mode: str = "decode") -> None:
    """Default deny; reviewed native mode adds only bounded same-process threads.

    There is no deny-list escape for an unrecognized syscall or alternate ABI.
    read-only open/openat is allowed only on the pinned root/proc controls; no
    inherited socket/file handles survive launcher close_fds. Writable /tmp
    exists for runtime compatibility but post-bootstrap file writes are denied.
    """
    if os.uname().machine != "x86_64":
        raise SandboxUnavailable("seccomp policy supports exact x86_64 ABI only")
    if mode not in ("decode", _FOLD_MODE, NATIVE_RESEARCH_PROFILE) or _NATIVE_PROFILE != NATIVE_RESEARCH_PROFILE:
        raise SandboxUnavailable("unknown fixed thread profile")
    if mode == NATIVE_RESEARCH_PROFILE:
        _glibc_version()
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]
    # LD W ABS, JMP JEQ K, RET K; arch mismatch kills, all unknown syscalls EPERM.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000), (0x20, 0, 0, 0)]
    allowed = (0, 1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 20, 21, 24, 25, 28,
               35, 39, 60, 63, 72, 79, 89, 96, 97, 98, 99, 102, 104, 107, 108, 110,
               131, 158, 186, 202, 204, 217, 218, 228, 230, 231, 234, 262, 267, 273,
               302, 318, 332, 334)
    # fcntl cannot create network/process capability; writable descriptors are
    # exclusively bounded protocol stdout/stderr. prlimit64 is constrained below
    # to read-only queries: hard resource limits may never be raised/changed.
    allowed = tuple(n for n in allowed if n != 302)
    for number in allowed:
        instructions.extend(((0x15, 0, 1, number), (0x06, 0, 0, 0x7FFF0000)))
    if mode == NATIVE_RESEARCH_PROFILE:
        # glibc 2.44, commit 16be1518495f1fa05481b0182c4e4c24927c62df:
        # pthread_create.c:280-298 uses exactly 0x003d0f00, zero exit signal.
        # clone-internal.c:95-109 falls back to clone only for clone3 ENOSYS.
        # https://forge.sourceware.org/glibc/glibc-mirror/src/commit/16be1518495f1fa05481b0182c4e4c24927c62df/nptl/pthread_create.c
        # https://forge.sourceware.org/glibc/glibc-mirror/src/commit/16be1518495f1fa05481b0182c4e4c24927c62df/sysdeps/unix/sysv/linux/clone-internal.c
        # Never allow opaque clone3 flags, fork/vfork, namespace or process clones.
        instructions.extend(((0x15, 0, 1, 435), (0x06, 0, 0, 0x00050026)))
        # Both halves of flags must match; cgroup pids.max=2 bounds task count.
        instructions.extend(((0x15, 0, 6, 56), (0x20, 0, 0, 16),
                             (0x15, 0, 3, 0x003D0F00), (0x20, 0, 0, 20),
                             (0x15, 0, 1, 0), (0x06, 0, 0, 0x7FFF0000),
                             (0x06, 0, 0, 0x00050001)))
    # Read-only prlimit64(pid, resource, NULL, old_limit); reject nonzero pointer.
    instructions.extend(((0x15, 0, 6, 302), (0x20, 0, 0, 32), (0x15, 0, 3, 0),
                         (0x20, 0, 0, 36), (0x15, 0, 1, 0), (0x06, 0, 0, 0x7FFF0000),
                         (0x06, 0, 0, 0x00050001)))
    # open/openat: allow only read-only, noncreating, nontruncating flags.
    forbidden_flags = (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
                       | (getattr(os, "O_TMPFILE", 0) & ~os.O_DIRECTORY))
    for number, flag_offset in ((2, 24), (257, 32)):
        instructions.extend(((0x15, 0, 4, number), (0x20, 0, 0, flag_offset),
                             (0x45, 1, 0, forbidden_flags), (0x06, 0, 0, 0x7FFF0000),
                             (0x06, 0, 0, 0x00050001)))
    instructions.append((0x06, 0, 0, 0x00050001))
    filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    program = Program(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise SandboxUnavailable("kernel refused no_new_privs")
    if mode == NATIVE_RESEARCH_PROFILE:
        # seccomp(SET_MODE_FILTER, TSYNC, ...): never leave an already-present
        # sibling unfiltered. Newly created pthreads inherit this exact filter.
        libc.syscall.restype = ctypes.c_long
        installed = libc.syscall(317, 1, 1, ctypes.byref(program))
    else:
        installed = libc.prctl(22, 2, ctypes.byref(program), 0, 0)
    if installed != 0:
        raise SandboxUnavailable("kernel refused synchronized seccomp policy")


class ProtocolChannel:
    def __init__(self, maximum: int) -> None:
        self.maximum = maximum
        self.buffer = bytearray()
        self.read_total = self.write_total = 0

    def receive(self) -> dict[str, Any]:
        while b"\n" not in self.buffer:
            part = os.read(0, min(65_536, self.maximum + 1 - len(self.buffer)))
            if not part:
                raise SandboxRejected("parent protocol closed unexpectedly")
            self.buffer.extend(part)
            self.read_total += len(part)
            if (b"\n" not in self.buffer and len(self.buffer) > self.maximum) or self.read_total > self.maximum * 16:
                raise SandboxRejected("worker input budget exceeded")
        line, _, remaining = self.buffer.partition(b"\n")
        self.buffer = bytearray(remaining)
        return protocol_record(bytes(line), self.maximum)

    def send(self, message: dict[str, Any]) -> None:
        raw = protocol_bytes(message, self.maximum) + b"\n"
        self.write_total += len(raw)
        if self.write_total > self.maximum * 16:
            raise SandboxRejected("worker aggregate output budget exceeded")
        view = memoryview(raw)
        while view:
            count = os.write(1, view)
            if count <= 0:
                raise SandboxRejected("worker protocol write failed")
            view = view[count:]


class AuthorityProxy:
    """Bounded transport to the parent's existing native authority, not a codec."""
    def __init__(self, channel: ProtocolChannel, maximum_calls: int) -> None:
        self.channel = channel
        self.maximum_calls = maximum_calls
        self.calls = 0

    def _call(self, method: str, args: list[Any]) -> Any:
        self.calls += 1
        if self.calls > self.maximum_calls:
            raise SandboxRejected("authority RPC budget exhausted")
        self.channel.send({"type": "authority", "id": self.calls, "method": method, "args": args})
        result = self.channel.receive()
        if set(result) != {"type", "id", "value"} or result["type"] != "authority-result" or result["id"] != self.calls:
            raise SandboxRejected("authority RPC result mismatch")
        return result["value"]

    def validate(self, contract_name: str, payload: Any, schema_version: str = "1.0.0") -> bool:
        value = self._call("validate", [contract_name, payload, schema_version])
        if type(value) is not bool:
            raise SandboxRejected("native validation is not boolean")
        return value

    def encode(self, value: Any) -> bytes:
        encoded = self._call("encode", [value])
        if type(encoded) is not dict or set(encoded) != {"bytes"} or type(encoded["bytes"]) is not str:
            raise SandboxRejected("native encoded bytes required")
        return base64.b64decode(encoded["bytes"], validate=True)

    def digest(self, value: Any) -> str:
        from vertex_host.sandbox import _hash
        return _hash(self._call("digest", [value]))

    def epoch_ns(self, timestamp: str) -> int:
        value = self._call("epoch_ns", [timestamp])
        if type(value) is not str or len(value) > 40:
            raise SandboxRejected("native exact clock required")
        return _integer(int(value), 0, 2**127 - 1)


def _glibc_version() -> Any:
    try:
        function = ctypes.CDLL(None).gnu_get_libc_version
        function.argtypes = []
        function.restype = ctypes.c_char_p
        if function() != b"2.44":
            raise SandboxUnavailable("unreviewed native pthread ABI")
        return function
    except (AttributeError, OSError):
        raise SandboxUnavailable("reviewed GNU libc ABI unavailable") from None


def _task_limit(expected: dict[str, Any]) -> int:
    if _BOOTSTRAP is None or expected["thread_profile"] != _BOOTSTRAP[-1]:
        raise SandboxAttestationRejected("worker thread profile differs from bootstrap")
    mode = expected["thread_profile"]
    if mode in ("decode", _FOLD_MODE):
        if expected["native_profile"] is not None or expected["pids_max"] != 1:
            raise SandboxAttestationRejected("decoder profile cannot acquire native threads")
        return 1
    value = expected["native_profile"]
    if mode != NATIVE_RESEARCH_PROFILE or type(value) is not dict or set(value) != {"profile", "libc"}:
        raise SandboxAttestationRejected("reviewed native ABI pin missing")
    profile = NativeResearchProfile(value["profile"], RuntimeFilePin(**value["libc"]))
    if expected["pids_max"] != 2:
        raise SandboxAttestationRejected("native profile is bounded to two tasks")
    # Bind the actual libc supplying pthread's ABI to its reviewed file, not an
    # arbitrary file claiming that version. Parent already sealed all rootfs files.
    function = _glibc_version()
    address = ctypes.cast(function, ctypes.c_void_p).value
    mappings = []
    for row in _read_small(Path("/proc/self/maps"), 1_000_000).splitlines():
        fields = row.split(None, 5)
        bounds = fields[0].split("-")
        if address is not None and int(bounds[0], 16) <= address < int(bounds[1], 16):
            mappings.append(fields[5] if len(fields) == 6 else "")
    if mappings != [profile.libc.path]:
        raise SandboxAttestationRejected("loaded libc is not the reviewed ABI file")
    raw = read_regular(Path(profile.libc.path), profile.libc.size)
    if len(raw) != profile.libc.size or hashlib.sha256(raw).hexdigest() != profile.libc.sha256:
        raise SandboxAttestationRejected("loaded libc file pin mismatch")
    return 2


def observe_local(expected: dict[str, Any], budget: Any) -> dict[str, Any]:
    task_limit = _task_limit(expected)
    status = dict(row.split(":", 1) for row in _read_small(Path("/proc/self/status")).splitlines() if ":" in row)
    namespaces = [[name, os.readlink("/proc/self/ns/" + name)] for name in ("net", "mnt", "pid", "user", "ipc", "uts", "cgroup")]
    if namespaces != expected["namespaces"] or status.get("NoNewPrivs", "").strip() != "1" or status.get("Seccomp", "").strip() != "2" or int(status["CapEff"].strip(), 16) != 0:
        raise SandboxAttestationRejected("local worker isolation differs from parent observation")
    limits = ((resource.RLIMIT_AS, budget.maximum_memory_bytes), (resource.RLIMIT_CPU, (budget.maximum_cpu_ms + 999) // 1000),
              (resource.RLIMIT_NPROC, task_limit), (resource.RLIMIT_NOFILE, 32), (resource.RLIMIT_FSIZE, 0), (resource.RLIMIT_CORE, 0))
    for kind, value in limits:
        if resource.getrlimit(kind) != (value, value):
            raise SandboxAttestationRejected("worker hard rlimit mismatch")
    controls = {name: _read_small(Path("/vertex-cgroup") / name).strip() for name in
                ("memory.max", "memory.swap.max", "memory.oom.group", "pids.max", "cpu.max")}
    if controls != {"memory.max": str(budget.maximum_memory_bytes), "memory.swap.max": "0", "memory.oom.group": "1", "pids.max": str(task_limit), "cpu.max": "100000 100000"}:
        raise SandboxAttestationRejected("local cgroup enforcement mismatch")
    if _read_small(Path("/vertex-cgroup/cgroup.procs")).split() != [str(os.getpid())]:
        raise SandboxAttestationRejected("worker cgroup is not process-exclusive")
    mounts = _read_small(Path("/proc/self/mountinfo"), 1_000_000).splitlines()
    if not any(row.split()[4] == "/" and "ro" in row.split()[5].split(",") for row in mounts):
        raise SandboxAttestationRejected("local runtime mount not read-only")
    return {"parentObservation": expected, "localNamespaces": namespaces, "controls": controls,
            "hardLimits": [[kind, value] for kind, value in limits],
            "networkPolicy": "default-deny-seccomp-and-private-netns",
            "runtimePolicy": "root-owned-exact-inventory-read-only-mount",
            "scope": "entire-attested-adapter-in-worker"}


class LocalEnforcedSupervisor:
    """Only worker-local operation closures, with observed already-enforced OS policy."""
    def __init__(self, observation: dict[str, Any], budget: Any, session_id: str, policy_digest: str) -> None:
        self.observation = observation
        self.budget = budget
        self.session_id = session_id
        self.policy_digest = policy_digest
        self.registry = wire_registry()
        self.active_binding: ResearchRunBinding | None = None
        self._session: SandboxSession | None = None
        self._result: SupervisedResult | None = None
        self._key = os.urandom(32)
        self._started = False
        self._clock = time.monotonic_ns()
        self._evidence_bytes: bytes | None = None
        self._evidence_content: bytes | None = None
        self._controls: dict[str, Any] | None = None

    def _proof(self, record: dict[str, Any]) -> bytes:
        content = protocol_bytes(record, 60_000)
        return protocol_bytes({"payload": base64.b64encode(content).decode("ascii"),
                               "mac": hmac.digest(self._key, content, "sha256").hex()}, 65_536)

    def execute(self, binding: ResearchRunBinding, operation: Callable[[SandboxSession], Any]) -> SupervisedResult:
        if self._started or binding.budget != self.budget or binding.policy_digest != self.policy_digest:
            raise SandboxAttestationRejected("local sandbox session cannot be repeated or rebound")
        self._started = True
        self._controls = observe_local(self.observation, binding.budget)
        self.active_binding = binding
        binding_digest = hashlib.sha256(protocol_bytes(pack(binding, self.registry))).hexdigest()
        self._evidence_content = protocol_bytes({"bindingDigest": binding_digest, "enforcement": self._controls})
        session = SandboxSession("vertex-linux-worker-v1", self.session_id, self.policy_digest,
            self._proof({"phase": "start", "bindingDigest": binding_digest,
                         "enforcementDigest": hashlib.sha256(self._evidence_content).hexdigest()}))
        self._session = session
        try:
            # Closure and adapter nonlocals remain in the SAME already-isolated
            # process. No parent callback is invoked, forked, pickled or upgraded.
            output = operation(session)
            observe_local(self.observation, binding.budget)
            if self._evidence_bytes is None or self._evidence_bytes not in output.evidence_bytes:
                raise SandboxAttestationRejected("output omitted actual isolation evidence")
            output = replace(output, sandbox=self.receipt(output.sandbox.events_processed))
            output_digest = hashlib.sha256(protocol_bytes(pack(output, self.registry))).hexdigest()
            self._result = SupervisedResult(session, output,
                self._proof({"phase": "finish", "bindingDigest": binding_digest,
                             "outputDigest": output_digest, "enforcementDigest": hashlib.sha256(self._evidence_content).hexdigest()}))
            return self._result
        finally:
            self.active_binding = None

    def receipt(self, events_processed: int) -> Any:
        from backtesting.planner import SandboxReceipt
        binding = self.active_binding
        if binding is None or self._controls is None:
            raise SandboxAttestationRejected("no active observed local session")
        memory_events = _key_values(Path("/vertex-cgroup/memory.events"))
        if any(memory_events.get(name, 0) for name in ("max", "oom", "oom_kill", "oom_group_kill")) or _key_values(Path("/vertex-cgroup/pids.events")).get("max", 0):
            raise SandboxAttestationRejected("kernel resource control rejected workload")
        peak = int(_read_small(Path("/vertex-cgroup/memory.peak")).strip())
        cpu = (_key_values(Path("/vertex-cgroup/cpu.stat"))["usage_usec"] + 999) // 1000
        wall = (time.monotonic_ns() - self._clock + 999_999) // 1_000_000
        if peak > self.budget.maximum_memory_bytes or cpu > self.budget.maximum_cpu_ms or wall > self.budget.maximum_wall_ms:
            raise SandboxAttestationRejected("local measured budget exceeded")
        return SandboxReceipt(self.policy_digest, self.budget, self._controls is not None,
            False, False, binding.input_bytes, events_processed, peak, cpu, wall, "isolation-" + self.session_id)

    def isolation_evidence(self, authority: Any, template_bytes: bytes) -> bytes:
        if self._evidence_bytes is not None:
            return self._evidence_bytes
        if self._evidence_content is None or self.active_binding is None:
            raise SandboxAttestationRejected("observed start enforcement is required")
        evidence = protocol_record(template_bytes, 64_000)
        content_hash = hashlib.sha256(self._evidence_content).hexdigest()
        evidence.update(evidenceId="isolation-" + self.session_id, contentHash=content_hash,
            sourceType="derived-analysis", publishedAt=None,
            capturedAt=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            sourceLocator="worker:" + self.session_id,
            claim="The entire fixed offline research adapter ran under the observed Linux worker controls.",
            method="Parent-observed private namespaces, read-only pinned runtime, local default-deny seccomp, hard rlimits, and cgroup v2 controls.",
            limitations=["Start enforcement evidence; final accounting is recorded separately after worker exit.",
                         "No scientific, realism, forward-paper, or trading approval is implied.",
                         "Trusted native contract authority is reached only through bounded private parent IPC."],
            acceptanceStatus="unreviewed", untrustedContent=True)
        evidence["sourceIdentity"] = {**evidence["sourceIdentity"], "sourceId": "isolation-" + self.session_id, "contentHash": content_hash}
        if self.observation["thread_profile"] == _FOLD_MODE:
            evidence["claim"] = "The fixed " + self.active_binding.operation + " computation ran under the observed single-thread Linux worker controls."
            evidence["limitations"].append("Candle selection/recomputation only; no fitter, parameter-to-engine mapping, or strategy execution was run.")
        if authority.validate("ResearchEvidence", evidence, schema_version="1.0.0") is not True:
            raise SandboxAttestationRejected("native authority rejected isolation evidence")
        encoded, _ = canonical_record(authority, evidence, self.budget.maximum_input_bytes)
        self._evidence_bytes = encoded
        return encoded


class LinuxSandboxVerifier:
    """Worker-pinned local verifier; no input-supplied trust roots or booleans."""
    def __init__(self, supervisor: LocalEnforcedSupervisor) -> None:
        self.supervisor = supervisor
        self._start_verified = False
        self._finish_verified = False

    def verify_start(self, session: SandboxSession, binding: ResearchRunBinding) -> bool:
        owner = self.supervisor
        if self._start_verified or session is not owner._session or binding != owner.active_binding:
            return False
        proof = protocol_record(session.start_attestation, 65_536)
        raw = base64.b64decode(proof["payload"], validate=True)
        if not hmac.compare_digest(proof["mac"], hmac.digest(owner._key, raw, "sha256").hex()):
            return False
        record = protocol_record(raw, 60_000)
        if (record.get("phase") != "start"
                or record.get("bindingDigest") != hashlib.sha256(protocol_bytes(pack(binding, owner.registry))).hexdigest()
                or record.get("enforcementDigest") != hashlib.sha256(owner._evidence_content).hexdigest()):
            return False
        observe_local(owner.observation, binding.budget)
        self._start_verified = True
        return True

    def verify_finish(self, result: SupervisedResult, binding: ResearchRunBinding) -> bool:
        owner = self.supervisor
        if not self._start_verified or self._finish_verified or result is not owner._result or result.session is not owner._session:
            return False
        proof = protocol_record(result.finish_attestation, 65_536)
        raw = base64.b64decode(proof["payload"], validate=True)
        if not hmac.compare_digest(proof["mac"], hmac.digest(owner._key, raw, "sha256").hex()):
            return False
        record = protocol_record(raw, 60_000)
        if (record.get("phase") != "finish"
                or record["bindingDigest"] != hashlib.sha256(protocol_bytes(pack(binding, owner.registry))).hexdigest()
                or record["outputDigest"] != hashlib.sha256(protocol_bytes(pack(result.output, owner.registry))).hexdigest()
                or record["enforcementDigest"] != hashlib.sha256(owner._evidence_content).hexdigest()):
            return False
        observe_local(owner.observation, binding.budget)
        self._finish_verified = True
        return True


def main(bootstrap: tuple[str, str, str, int, int, int, str]) -> int:
    from backtesting.planner import EngineDescriptor, SimulationRequest
    session, policy, worker_hash, memory, cpu, maximum_wire, mode = bootstrap
    registry = fold_wire_registry() if mode == _FOLD_MODE else wire_registry()
    if hashlib.sha256(Path(WORKER_PATH).read_bytes()).hexdigest() != worker_hash:
        raise SandboxUnavailable("worker source does not match reviewed runtime")
    install_seccomp(mode)
    channel = ProtocolChannel(maximum_wire)
    channel.send({"type": "ready", "protocol": PROTOCOL, "session": session})
    enforced = channel.receive()
    if set(enforced) != {"type", "observation"} or enforced["type"] != "enforcement":
        raise SandboxRejected("parent enforcement observation required")
    observation = enforced["observation"]
    if observation["session_id"] != session or observation["policy_digest"] != policy or observation["worker_sha256"] != worker_hash:
        raise SandboxRejected("parent enforcement identity mismatch")
    envelope = channel.receive()
    if mode == "decode":
        return decode_job(channel, envelope, observation, session, policy, memory, cpu)
    if mode == _FOLD_MODE:
        return candle_fold_job(channel, envelope, observation, session, policy, memory, cpu, maximum_wire)
    if set(envelope) != {"type", "protocol", "session", "policy", "request", "descriptor", "model", "budget", "maximumWireBytes", "maximumRpcCalls"}:
        raise SandboxRejected("fixed worker request fields required")
    if (envelope["type"], envelope["protocol"], envelope["session"], envelope["policy"], envelope["maximumWireBytes"]) != ("request", PROTOCOL, session, policy, maximum_wire):
        raise SandboxRejected("worker request identity mismatch")
    request = unpack(envelope["request"], registry)
    descriptor = unpack(envelope["descriptor"], registry)
    if type(request) is not SimulationRequest or type(descriptor) is not EngineDescriptor:
        raise SandboxRejected("typed simulation request/descriptor required")
    budget = request.plan.request.budget
    if asdict(budget) != envelope["budget"] or (budget.maximum_memory_bytes, budget.maximum_cpu_ms) != (memory, cpu):
        raise SandboxRejected("request exceeds inherited bootstrap budget")
    authority = AuthorityProxy(channel, _integer(envelope["maximumRpcCalls"], 1, 4096))
    model = ReviewedResearchModel.from_record(envelope["model"])
    supervisor = LocalEnforcedSupervisor(observation, budget, session, policy)
    from backtesting.historical import ENGINE_ID as BAR_ENGINE_ID
    if descriptor.pin.identity == BAR_ENGINE_ID:
        from .nautilus_bars import HistoricalBarLoader, NautilusHistoricalBarRunner
        runner = NautilusHistoricalBarRunner(descriptor, authority, model, supervisor)
        event_loader = HistoricalBarLoader(authority, model)
    else:
        runner = NautilusResearchRunner(descriptor, authority, model, supervisor)
        event_loader = JsonlEventLoader(authority)
    engine = AttestedResearchSimulationEngine(descriptor=descriptor, authority=authority,
        loader=event_loader, runner=runner, supervisor=supervisor,
        verifier=LinuxSandboxVerifier(supervisor))
    output = engine.simulate(request)
    encoded = pack(output, registry)
    if supervisor._session is None or supervisor._result is None or supervisor._evidence_content is None:
        raise SandboxRejected("worker attestation completion missing")
    channel.send({"type": "result", "protocol": PROTOCOL, "session": session, "output": encoded,
                  "outputSha256": hashlib.sha256(protocol_bytes(encoded, maximum_wire)).hexdigest(),
                  "isolationContent": base64.b64encode(supervisor._evidence_content).decode("ascii"),
                  "startAttestation": base64.b64encode(supervisor._session.start_attestation).decode("ascii"),
                  "finishAttestation": base64.b64encode(supervisor._result.finish_attestation).decode("ascii")})
    return 0


def candle_fold_job(channel: ProtocolChannel, envelope: dict[str, Any], observation: dict[str, Any],
                    session: str, policy: str, memory: int, cpu: int, maximum_wire: int) -> int:
    from backtesting.ports import PublicBoundary
    from vertex_host.fold_selection import (
        FOLD_MODE, CandleFoldJob, check_fold_job, make_fold_binding, run_candle_fold_job,
    )
    if (FOLD_MODE != _FOLD_MODE or set(envelope) != {"type", "protocol", "session", "policy",
            "job", "budget", "maximumWireBytes", "maximumRpcCalls"}
            or (envelope["type"], envelope["protocol"], envelope["session"], envelope["policy"],
                envelope["maximumWireBytes"]) != ("candle-fold", PROTOCOL, session, policy, maximum_wire)):
        raise SandboxRejected("closed candle fold protocol required")
    registry = fold_wire_registry()
    job = unpack(envelope["job"], registry)
    if type(job) is not CandleFoldJob:
        raise SandboxRejected("typed candle fold job required")
    budget = job.request.budget
    if (asdict(budget) != envelope["budget"] or (budget.maximum_memory_bytes, budget.maximum_cpu_ms) != (memory, cpu)
            or job.selector.sandbox_policy_digest != policy or job.verifier.sandbox_policy_digest != policy):
        raise SandboxRejected("fold inherited budget or policy mismatch")
    body = protocol_bytes(envelope, min(maximum_wire, budget.maximum_input_bytes))
    authority = AuthorityProxy(channel, _integer(envelope["maximumRpcCalls"], 1, 4096))
    check_fold_job(job, PublicBoundary(validator=authority, codec=authority, maximum_bytes=budget.maximum_input_bytes))
    admission = job.admission.decode()

    def current() -> None:
        now = authority.epoch_ns(datetime.now(UTC).isoformat().replace("+00:00", "Z"))
        if not authority.epoch_ns(admission["checkedAt"]) <= now < authority.epoch_ns(admission["expiresAt"]):
            raise SandboxRejected("fold authority expired or worker clock regressed")

    current()
    supervisor = LocalEnforcedSupervisor(observation, budget, session, policy)
    supervisor.registry = registry
    binding = make_fold_binding(job, len(body))
    verifier = LinuxSandboxVerifier(supervisor)

    def operation(active_session: SandboxSession) -> Any:
        if verifier.verify_start(active_session, binding) is not True:
            raise SandboxAttestationRejected("fold start containment not verified")
        current()
        output = run_candle_fold_job(job, authority, supervisor)
        current()
        return output

    result = supervisor.execute(binding, operation)
    if verifier.verify_finish(result, binding) is not True:
        raise SandboxAttestationRejected("fold finish containment not verified")
    current()
    encoded = pack(result.output, registry)
    output_bytes = protocol_bytes(encoded, min(maximum_wire, budget.maximum_input_bytes))
    if supervisor._evidence_content is None:
        raise SandboxRejected("actual fold isolation evidence unavailable")
    channel.send({"type": "result", "protocol": PROTOCOL, "session": session, "output": encoded,
        "outputSha256": hashlib.sha256(output_bytes).hexdigest(),
        "isolationContent": base64.b64encode(supervisor._evidence_content).decode("ascii"),
        "startAttestation": base64.b64encode(result.session.start_attestation).decode("ascii"),
        "finishAttestation": base64.b64encode(result.finish_attestation).decode("ascii")})
    return 0


def decode_job(channel: ProtocolChannel, envelope: dict[str, Any], observation: dict[str, Any],
               session: str, policy: str, memory: int, cpu: int) -> int:
    from backtesting.ports import ResourceBudget
    # The pinned module is fixed by source, not user-selected/importlib/eval.
    from adapters.decode_worker import dispatch
    if set(envelope) != {"type", "protocol", "session", "policy", "operation", "payload", "budget", "maximumOutputBytes"}:
        raise SandboxRejected("fixed decoder fields required")
    if (envelope["type"], envelope["protocol"], envelope["session"], envelope["policy"]) != ("decode", PROTOCOL, session, policy):
        raise SandboxRejected("decoder protocol identity mismatch")
    if envelope["operation"] not in {"adapters.decode-csv", "adapters.decode-arrow", "adapters.decode-pdf"}:
        raise SandboxRejected("decoder operation unavailable")
    budget = ResourceBudget(**envelope["budget"])
    if (budget.maximum_memory_bytes, budget.maximum_cpu_ms) != (memory, cpu) or memory > 256 * 1024 * 1024 or budget.maximum_wall_ms > 30_000:
        raise SandboxRejected("decoder inherited limits mismatch")
    maximum = _integer(envelope["maximumOutputBytes"], 1, 16_000_000)
    observe_local(observation, budget)
    output = dispatch(envelope["operation"], envelope["payload"])
    if type(output) is not dict or output.get("status") not in ("completed", "unavailable"):
        raise SandboxRejected("fixed decoder result required")
    encoded = protocol_bytes(output, maximum)
    observe_local(observation, budget)
    channel.send({"type": "result", "protocol": PROTOCOL, "session": session, "output": output,
                  "outputSha256": hashlib.sha256(encoded).hexdigest()})
    return 0


if __name__ == "__main__":
    try:
        assert _BOOTSTRAP is not None
        raise SystemExit(main(_BOOTSTRAP))
    except Exception:
        # No source payloads, exception strings, environment, or paths on stderr.
        os.write(2, b"research-worker-unavailable\n")
        raise SystemExit(70)
