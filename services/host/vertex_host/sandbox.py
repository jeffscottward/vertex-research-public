"""Explicit Linux research isolation. Import/describe never probes or starts it.

The outer supervisor runs the ENTIRE attested adapter in a pinned worker. It
never calls an arbitrary parent closure and describes that closure as isolated.
Provider jobs cannot use this protocol: it has no network-capable mode.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import selectors
import signal
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import asdict, dataclass, fields, is_dataclass, replace
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from vertex_execution.adapters.contracts import ContractAuthority
from vertex_execution.adapters.research import ResearchEngineUnavailable

PROTOCOL = "vertex.research-worker.v1"
WORKER_PATH = "/vertex/host/vertex_host/sandbox_worker.py"
PYTHON_PATH = "/usr/bin/python3.12"
PYTHON_VERSION = "3.12.11"
MAX_FRAME = 128_000_000
NATIVE_RESEARCH_PROFILE = "nautilus-rc5-glibc244-x86_64-2task-v1"


class SandboxUnavailable(ResearchEngineUnavailable):
    pass


class SandboxRejected(RuntimeError):
    pass


def _hash(value: str) -> str:
    if type(value) is not str or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("exact SHA-256 pin required")
    return value


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("bounded exact integer required")
    return value


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate protocol key")
        result[key] = value
    return result


def _bad_number(_: str) -> None:
    raise ValueError("inexact protocol number forbidden")


def protocol_bytes(value: Any, maximum: int = MAX_FRAME) -> bytes:
    """Private transport, NOT a replacement for the native canonical codec."""
    data = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
    if not 0 < len(data) <= maximum:
        raise SandboxRejected("worker frame exceeds byte limit")
    return data


def protocol_record(raw: bytes, maximum: int = MAX_FRAME) -> dict[str, Any]:
    if type(raw) is not bytes or not 0 < len(raw) <= maximum:
        raise SandboxRejected("worker frame exceeds byte limit")
    try:
        result = json.loads(raw, object_pairs_hook=_pairs, parse_float=_bad_number, parse_constant=_bad_number)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise SandboxRejected("invalid worker frame") from exc
    if type(result) is not dict:
        raise SandboxRejected("worker frame must be a record")
    return result


def wire_registry() -> dict[str, type]:
    """Closed set of native private envelopes. No import names from the wire."""
    from backtesting.lineage import (
        AcceptanceCriterion, DataPin, ForwardCriteria, Incident, LineageInputs,
        ModelAssumption, Pin, PointInTimeEvidence, TimeWindow, TrialRegistry, WalkForwardFold,
    )
    from backtesting.planner import (
        BacktestPlan, BacktestRequest, DatasetInput, EngineDescriptor,
        SandboxReceipt, SimulationOutput, SimulationRequest,
    )
    from backtesting.historical import HistoricalBarInput, HistoricalBarLineage
    from backtesting.ports import Artifact, ResourceBudget
    from vertex_execution.adapters.research import ResearchRunBinding, SandboxSession, SupervisedResult
    types = (
        AcceptanceCriterion, DataPin, ForwardCriteria, Incident, LineageInputs,
        ModelAssumption, Pin, PointInTimeEvidence, TimeWindow, TrialRegistry, WalkForwardFold,
        BacktestPlan, BacktestRequest, DatasetInput, EngineDescriptor, SandboxReceipt,
        SimulationOutput, SimulationRequest, Artifact, ResourceBudget, ResearchRunBinding,
        SandboxSession, SupervisedResult, HistoricalBarInput, HistoricalBarLineage,
    )
    return {item.__name__: item for item in types}


def fold_wire_registry() -> dict[str, type]:
    """Separate closed fold profile; the native/decoder registry is unchanged."""
    from backtesting.candle_labels import CandleDatasetPolicy, CandleLabelPolicy, CandleSourcePin
    from backtesting.candle_selection import CandleSelectionCandidate
    from backtesting.fold_contracts import (
        FoldPortPin, FoldRecord, FoldSelection, FoldSelectionRequest, FoldStageEvidence, WalkForwardPolicy,
    )
    from .fold_selection import CandleFoldJob, CandleFoldRunBinding, CandleFoldWorkerOutput
    registry = wire_registry()
    for kind in (CandleDatasetPolicy, CandleLabelPolicy, CandleSourcePin, CandleSelectionCandidate,
                 FoldPortPin, FoldRecord, FoldSelection, FoldSelectionRequest, FoldStageEvidence,
                 WalkForwardPolicy, CandleFoldJob, CandleFoldRunBinding, CandleFoldWorkerOutput):
        registry[kind.__name__] = kind
    return registry


def pack(value: Any, registry: dict[str, type], *, depth: int = 0, nodes: list[int] | None = None) -> Any:
    nodes = [0, 0] if nodes is None else nodes
    nodes[0] += 1
    if depth > 64 or nodes[0] > 250_000:
        raise SandboxRejected("typed protocol graph limit")
    if type(value) in (str, bytes):
        # Count before base64/JSON allocation; duplicate graph references count
        # again because the transport duplicates them as well.
        nodes[1] += len(value) * (4 if type(value) is str else 1)
        if nodes[1] > MAX_FRAME:
            raise SandboxRejected("typed protocol aggregate byte limit")
    def child(item: Any) -> Any:
        return pack(item, registry, depth=depth + 1, nodes=nodes)
    if value is None or type(value) in (str, bool):
        return value
    if type(value) is int:
        _integer(value, -(2**127), 2**127 - 1)
        return {"integer": str(value)}
    if type(value) is bytes:
        return {"bytes": base64.b64encode(value).decode("ascii")}
    if type(value) is Decimal:
        if not value.is_finite() or len(value.as_tuple().digits) > 128 or abs(value.as_tuple().exponent) > 128:
            raise SandboxRejected("bounded Decimal required")
        return {"decimal": str(value)}
    if type(value) is datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise SandboxRejected("aware datetime required")
        return {"datetime": value.isoformat()}
    if type(value) in (tuple, list):
        return {"tuple" if type(value) is tuple else "list": [child(item) for item in value]}
    if type(value) is dict and all(type(key) is str for key in value):
        if len(value) > 100_000:
            raise SandboxRejected("typed protocol mapping limit")
        return {"mapping": [[child(key), child(item)] for key, item in sorted(value.items())]}
    if is_dataclass(value) and registry.get(type(value).__name__) is type(value):
        return {"record": type(value).__name__, "fields": {field.name: child(getattr(value, field.name)) for field in fields(value)}}
    raise SandboxRejected("unsupported typed protocol value")


def unpack(value: Any, registry: dict[str, type], *, depth: int = 0, nodes: list[int] | None = None) -> Any:
    nodes = [0] if nodes is None else nodes
    nodes[0] += 1
    if depth > 64 or nodes[0] > 250_000:
        raise SandboxRejected("typed protocol graph limit")
    def child(item: Any) -> Any:
        return unpack(item, registry, depth=depth + 1, nodes=nodes)
    if value is None or type(value) in (str, bool):
        return value
    if type(value) is not dict:
        raise SandboxRejected("typed envelope required")
    if set(value) == {"record", "fields"}:
        cls = registry.get(value["record"]) if type(value["record"]) is str else None
        if cls is None or type(value["fields"]) is not dict or set(value["fields"]) != {f.name for f in fields(cls)}:
            raise SandboxRejected("unknown record or fields")
        supplied = {key: child(item) for key, item in value["fields"].items()}
        result = cls(**{field.name: supplied[field.name] for field in fields(cls) if field.init})
        for field in fields(cls):
            if not field.init and protocol_bytes(pack(getattr(result, field.name), registry)) != protocol_bytes(pack(supplied[field.name], registry)):
                raise SandboxRejected("computed record field mismatch")
        return result
    if len(value) != 1:
        raise SandboxRejected("invalid typed envelope")
    key, item = next(iter(value.items()))
    if key == "integer" and type(item) is str and len(item) <= 40:
        result = int(item)
        if str(result) != item:
            raise SandboxRejected("noncanonical protocol integer")
        return _integer(result, -(2**127), 2**127 - 1)
    if key == "bytes" and type(item) is str:
        return base64.b64decode(item, validate=True)
    if key == "datetime" and type(item) is str:
        result = datetime.fromisoformat(item)
        if result.tzinfo is None or result.utcoffset() is None:
            raise SandboxRejected("aware timestamp required")
        return result
    if key == "decimal" and type(item) is str and len(item) <= 256:
        result = Decimal(item)
        pack(result, registry)
        return result
    if key in ("tuple", "list") and type(item) is list:
        result = [child(part) for part in item]
        return tuple(result) if key == "tuple" else result
    if key == "mapping" and type(item) is list:
        result = {}
        for pair in item:
            if type(pair) is not list or len(pair) != 2 or type(pair[0]) is not str or pair[0] in result:
                raise SandboxRejected("invalid mapping entry")
            result[pair[0]] = child(pair[1])
        return result
    raise SandboxRejected("unknown typed envelope")


@dataclass(frozen=True, slots=True)
class RuntimeFilePin:
    path: str
    sha256: str
    size: int

    def __post_init__(self) -> None:
        if type(self.path) is not str or not self.path.startswith("/") or str(Path(self.path)) != self.path or ".." in Path(self.path).parts:
            raise ValueError("normalized absolute runtime path required")
        _hash(self.sha256)
        _integer(self.size, 0, 1_000_000_000)


@dataclass(frozen=True, slots=True)
class NativeResearchProfile:
    """Explicit reviewed ABI selection, not a claim of runtime qualification."""
    profile: str
    libc: RuntimeFilePin

    def __post_init__(self) -> None:
        if self.profile != NATIVE_RESEARCH_PROFILE or type(self.libc) is not RuntimeFilePin:
            raise ValueError("only the reviewed two-task glibc 2.44 research ABI is supported")
        if not self.libc.path.endswith("/libc.so.6") or self.libc.size == 0:
            raise ValueError("exact regular libc runtime file pin required")


@dataclass(frozen=True, slots=True)
class ReviewedSandboxConfig:
    """No defaults enable execution; all files/provenance are explicit review pins.

    rootfs contains Python 3.12.11, fixed host/execution/research/dependency trees,
    and empty /proc, /dev, /tmp, /vertex-cgroup, /vertex-cgroup.procs mountpoints.
    An administrator must provision a root-owned tree and delegate cgroup v2
    cpu/memory/pids controllers; this module never enables an ancestor controller.
    """
    rootfs: str
    bwrap_path: str
    bwrap_sha256: str
    bwrap_size: int
    runtime_files: tuple[RuntimeFilePin, ...]
    cgroup_root: str
    review_digest: str
    maximum_wire_bytes: int = 32_000_000
    maximum_rpc_calls: int = 1024
    maximum_stderr_bytes: int = 16_384
    native_research: NativeResearchProfile | None = None

    def __post_init__(self) -> None:
        for value in (self.rootfs, self.bwrap_path, self.cgroup_root):
            if type(value) is not str or not value.startswith("/") or str(Path(value)) != value or ".." in Path(value).parts:
                raise ValueError("normalized reviewed absolute path required")
        if not self.cgroup_root.startswith("/sys/fs/cgroup/"):
            raise ValueError("delegated cgroup v2 path required")
        _hash(self.bwrap_sha256)
        _hash(self.review_digest)
        _integer(self.bwrap_size, 1, 32_000_000)
        object.__setattr__(self, "runtime_files", tuple(self.runtime_files))
        paths = {pin.path for pin in self.runtime_files}
        if sum(pin.size for pin in self.runtime_files) > 4_000_000_000:
            raise ValueError("reviewed runtime total size exceeds bound")
        if len(paths) != len(self.runtime_files) or not 1 <= len(paths) <= 50_000:
            raise ValueError("bounded exact runtime file inventory required")
        if not {PYTHON_PATH, WORKER_PATH}.issubset(paths):
            raise ValueError("pinned Python and worker files required")
        _integer(self.maximum_wire_bytes, 65_536, MAX_FRAME)
        _integer(self.maximum_rpc_calls, 1, 4096)
        _integer(self.maximum_stderr_bytes, 1, 65_536)
        if self.native_research is not None:
            if type(self.native_research) is not NativeResearchProfile or self.native_research.libc not in self.runtime_files:
                raise ValueError("native research libc must be in the exact reviewed runtime inventory")

    @property
    def policy_digest(self) -> str:
        # Private policy byte identity, not Vertex public canonicalization.
        record = asdict(self)
        record.update(protocol=PROTOCOL, python=PYTHON_VERSION, network="deny", execution="deny", architecture="x86_64")
        return hashlib.sha256(protocol_bytes(record)).hexdigest()

    def task_limit(self, mode: str) -> int:
        if mode in ("decode", "candle-fold-v1"):
            return 1
        if mode == NATIVE_RESEARCH_PROFILE and self.native_research is not None:
            return 2
        raise SandboxUnavailable("explicit reviewed native research profile is absent")


@dataclass(frozen=True, slots=True)
class WorkerObservation:
    session_id: str
    policy_digest: str
    process_id: int
    namespaces: tuple[tuple[str, str], ...]
    cgroup_path: str
    memory_max: int
    pids_max: int
    cpu_max: str
    no_new_privs: int
    seccomp: int
    effective_capabilities: str
    root_read_only: bool
    worker_sha256: str
    review_digest: str
    thread_profile: str = "decode"
    native_profile: NativeResearchProfile | None = None


@dataclass(frozen=True, slots=True)
class WorkerRunReceipt:
    observation: WorkerObservation
    output_sha256: str
    peak_memory_bytes: int
    cpu_ms: int
    wall_ms: int
    memory_events: tuple[tuple[str, int], ...]
    process_exited: bool
    cgroup_empty: bool
    isolation_content_bytes: bytes | None = None
    start_attestation: bytes | None = None
    finish_attestation: bytes | None = None
    input_bytes: int | None = None
    output_bytes: int | None = None
    operation: str | None = None
    request_sha256: str | None = None
    admission_sha256: str | None = None


def _read_small(path: Path, maximum: int = 65_536) -> str:
    with path.open("rb") as source:
        data = source.read(maximum + 1)
    if len(data) > maximum:
        raise SandboxUnavailable("OS observation exceeds limit")
    return data.decode("ascii")


def _key_values(path: Path) -> dict[str, int]:
    result = {}
    for row in _read_small(path).splitlines():
        key, value = row.split()
        if key in result:
            raise SandboxRejected("duplicate OS counter")
        result[key] = _integer(int(value), 0, 2**63 - 1)
    return result


def _root_owned(path: Path, *, directory: bool = False) -> os.stat_result:
    meta = path.lstat()
    if meta.st_uid != 0 or meta.st_mode & 0o022 or stat.S_ISLNK(meta.st_mode):
        raise SandboxUnavailable("runtime must be root-owned and non-writable by job principals")
    if directory and not stat.S_ISDIR(meta.st_mode):
        raise SandboxUnavailable("real runtime directory required")
    if not directory and (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1):
        raise SandboxUnavailable("single-link runtime regular file required")
    return meta


def _verify_file(path: Path, digest: str, size: int, guard: Callable[[], None] | None = None) -> None:
    meta = _root_owned(path)
    if meta.st_size != size:
        raise SandboxUnavailable("runtime pin size mismatch")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        h = hashlib.sha256()
        consumed = 0
        while True:
            if guard is not None:
                guard()
            part = os.read(fd, 1_048_576)
            if not part:
                break
            consumed += len(part)
            if consumed > size:
                raise SandboxUnavailable("runtime changed while pinning")
            h.update(part)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
        ) or consumed != size or h.hexdigest() != digest:
            raise SandboxUnavailable("runtime content pin mismatch")
    finally:
        os.close(fd)


def _require_static_launcher(path: Path) -> None:
    """A launcher hash must not silently depend on unpinned host shared objects."""
    import struct
    with path.open("rb") as source:
        header = source.read(64)
        if len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01" or struct.unpack_from("<H", header, 18)[0] != 62:
            raise SandboxUnavailable("reviewed static ELF64 x86_64 launcher required")
        offset = struct.unpack_from("<Q", header, 32)[0]
        size, count = struct.unpack_from("<HH", header, 54)
        if size != 56 or not 1 <= count <= 128 or offset > 1_048_576:
            raise SandboxUnavailable("bounded launcher program headers required")
        source.seek(offset)
        table = source.read(size * count)
        if len(table) != size * count or any(struct.unpack_from("<I", table, index * size)[0] in (2, 3) for index in range(count)):
            raise SandboxUnavailable("launcher must not load unpinned interpreter/shared objects")


def _require_readonly_runtime_mount(root: Path) -> None:
    mounts = []
    for row in _read_small(Path("/proc/self/mountinfo"), 1_000_000).splitlines():
        parts = row.split()
        mount = Path(parts[4])
        # Escaped mountpoints are deliberately unsupported rather than guessed.
        if "\\" not in str(mount) and (mount == root or mount in root.parents):
            mounts.append((len(mount.parts), parts[5].split(",")))
    if not mounts or "ro" not in max(mounts, key=lambda item: item[0])[1]:
        raise SandboxUnavailable("reviewed runtime must already be on a read-only host mount")


def _verify_runtime(config: ReviewedSandboxConfig, guard: Callable[[], None] | None = None) -> None:
    if os.uname().sysname != "Linux" or os.uname().machine != "x86_64" or os.geteuid() == 0:
        raise SandboxUnavailable("unprivileged Linux x86_64 job owner required")
    root = Path(config.rootfs)
    if root.resolve(strict=True) != root or Path(config.bwrap_path).resolve(strict=True) != Path(config.bwrap_path):
        raise SandboxUnavailable("runtime paths must not contain symlinks")
    _require_readonly_runtime_mount(root)
    for ancestor in (root, *root.parents):
        _root_owned(ancestor, directory=True)
    for ancestor in Path(config.bwrap_path).parents:
        _root_owned(ancestor, directory=True)
    _verify_file(Path(config.bwrap_path), config.bwrap_sha256, config.bwrap_size, guard)
    if Path(config.bwrap_path).stat().st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise SandboxUnavailable("setuid/setgid launcher is not permitted")
    _require_static_launcher(Path(config.bwrap_path))
    expected = {pin.path: pin for pin in config.runtime_files}
    found: set[str] = set()
    directories = 0
    def inventory_failure(error: OSError) -> None:
        raise SandboxUnavailable("runtime inventory traversal failed") from error
    for base, dirs, names in os.walk(root, followlinks=False, onerror=inventory_failure):
        if guard is not None:
            guard()
        directories += 1
        if directories > 50_000:
            raise SandboxUnavailable("runtime directory inventory exceeds limit")
        _root_owned(Path(base), directory=True)
        for name in dirs:
            _root_owned(Path(base) / name, directory=True)
        for name in names:
            path = Path(base) / name
            relative = "/" + path.relative_to(root).as_posix()
            pin = expected.get(relative)
            if pin is None:
                raise SandboxUnavailable("unreviewed runtime file")
            _verify_file(path, pin.sha256, pin.size, guard)
            found.add(relative)
    if found != set(expected):
        raise SandboxUnavailable("incomplete runtime inventory")


class LinuxSandboxSupervisor:
    """Outer process supervisor; local callbacks belong to the worker supervisor.

    run_worker is the only spawning boundary. Cancellation is a caller-owned
    Event, not a provider/broker operation. A timed-out authority RPC quarantines
    this instance until its single daemon thread exits; no unbounded thread pool.
    """
    def __init__(self, config: ReviewedSandboxConfig | None = None) -> None:
        self.config = config
        self.last_receipt: WorkerRunReceipt | None = None
        self._lock = threading.Lock()
        self._authority_thread: threading.Thread | None = None
        self._quarantined = False

    @property
    def quarantined(self) -> bool:
        return self._quarantined

    @staticmethod
    def _deadline_guard(deadline: int, cancellation: Any) -> None:
        if time.monotonic_ns() >= deadline or (cancellation is not None and cancellation.is_set()):
            raise SandboxRejected("sandbox cancelled or deadline expired")

    def execute(self, binding: Any, operation: Callable[..., Any]) -> Any:
        raise SandboxUnavailable("parent callbacks are not isolated; use IsolatedResearchSimulationEngine")

    def run_worker(self, request: Any, descriptor: Any, model: Any, authority: ContractAuthority,
                   *, cancellation: threading.Event | None = None) -> Any:
        from backtesting.planner import SimulationOutput, SimulationRequest
        if type(request) is not SimulationRequest or request.plan.request.replay_evidence is not None:
            raise SandboxUnavailable("sealed simulation request without supplied-outcome replay required")
        config = self.config
        if config is None:
            raise SandboxUnavailable("reviewed Linux sandbox configuration is absent")
        config.task_limit(NATIVE_RESEARCH_PROFILE)
        budget = request.plan.request.budget
        if budget.network_allowed is not False or budget.execution_allowed is not False:
            raise SandboxRejected("provider-enabled or execution-enabled jobs are separate")
        if descriptor.sandbox_policy_digest != config.policy_digest:
            raise SandboxRejected("sandbox policy pin mismatch")
        if not self._lock.acquire(blocking=False):
            raise SandboxUnavailable("sandbox already running")
        leaf: Path | None = None
        process: subprocess.Popen[bytes] | None = None
        self.last_receipt = None
        started = time.monotonic_ns()
        deadline = started + budget.maximum_wall_ms * 1_000_000
        try:
            if self._quarantined:
                raise SandboxUnavailable("sandbox termination previously failed; host quarantined")
            if self._authority_thread is not None and self._authority_thread.is_alive():
                raise SandboxUnavailable("authority call from prior job is still outstanding")
            if cancellation is not None and cancellation.is_set():
                raise SandboxRejected("sandbox cancelled before launch")
            _verify_runtime(config, lambda: self._deadline_guard(deadline, cancellation))
            session_id = "research-" + uuid.uuid4().hex
            leaf = self._create_cgroup(session_id, budget, mode=NATIVE_RESEARCH_PROFILE)
            registry = wire_registry()
            body = protocol_bytes({
                "type": "request", "protocol": PROTOCOL, "session": session_id,
                "policy": config.policy_digest, "request": pack(request, registry),
                "descriptor": pack(descriptor, registry), "model": model.record(),
                "budget": asdict(budget), "maximumWireBytes": config.maximum_wire_bytes,
                "maximumRpcCalls": config.maximum_rpc_calls,
            }, config.maximum_wire_bytes)
            worker_pin = next(pin.sha256 for pin in config.runtime_files if pin.path == WORKER_PATH)
            args = self._argv(leaf, budget, session_id, worker_pin, mode=NATIVE_RESEARCH_PROFILE)
            if time.monotonic_ns() >= deadline:
                raise SandboxRejected("sandbox preparation exhausted wall budget")
            process = subprocess.Popen(
                args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={}, cwd="/", close_fds=True, start_new_session=True, shell=False, bufsize=0,
            )
            observation, response = self._exchange(process, leaf, body, authority, budget, deadline,
                                                    cancellation, session_id, worker_pin, mode=NATIVE_RESEARCH_PROFILE)
            if process.returncode != 0:
                raise SandboxRejected("worker did not exit successfully")
            measured = self._measure(leaf, budget, started)
            if _key_values(leaf / "cgroup.events").get("populated") != 0:
                raise SandboxRejected("worker descendants remain alive")
            if set(response) != {"type", "protocol", "session", "output", "outputSha256", "isolationContent", "startAttestation", "finishAttestation"} or response["protocol"] != PROTOCOL or response["session"] != session_id:
                raise SandboxRejected("worker result identity mismatch")
            raw_output = protocol_bytes(response["output"], config.maximum_wire_bytes)
            if hashlib.sha256(raw_output).hexdigest() != response["outputSha256"]:
                raise SandboxRejected("worker result digest mismatch")
            output = unpack(response["output"], registry)
            if type(output) is not SimulationOutput or not output.sandbox.qualified(descriptor, budget):
                raise SandboxRejected("worker did not produce a qualified typed sandbox result")
            if (output.lineage_digest != request.plan.lineage.digest or output.strategy_digest != request.plan.strategy.digest
                    or output.engine_pin != descriptor.pin or output.dataset_content_digests != tuple(d.decode()["contentHash"] for d in request.plan.datasets)):
                raise SandboxRejected("worker changed sealed research binding")
            isolation = base64.b64decode(response["isolationContent"], validate=True)
            start_proof = base64.b64decode(response["startAttestation"], validate=True)
            finish_proof = base64.b64decode(response["finishAttestation"], validate=True)
            if not 0 < len(isolation) <= 60_000 or not 0 < len(start_proof) <= 65_536 or not 0 < len(finish_proof) <= 65_536:
                raise SandboxRejected("bounded actual worker attestations required")
            enforcement = protocol_record(isolation, 60_000)
            if protocol_bytes(enforcement["enforcement"]["parentObservation"]) != protocol_bytes(asdict(observation)):
                raise SandboxRejected("worker evidence differs from parent OS observation")
            evidence_hash = hashlib.sha256(isolation).hexdigest()
            matching = [protocol_record(raw, budget.maximum_input_bytes) for raw in output.evidence_bytes]
            if not any(item.get("evidenceId") == output.sandbox.isolation_evidence_id and item.get("contentHash") == evidence_hash for item in matching):
                raise SandboxRejected("worker output evidence omitted actual isolation content")
            peak, cpu, wall, events = measured
            final = replace(output, sandbox=replace(output.sandbox, peak_memory_bytes=peak, cpu_ms=cpu, wall_ms=wall))
            if not final.sandbox.qualified(descriptor, budget):
                raise SandboxRejected("outer measured resource accounting exceeds budget")
            self.last_receipt = WorkerRunReceipt(observation, response["outputSha256"], peak, cpu, wall,
                                                  tuple(sorted(events.items())), True, True, isolation, start_proof, finish_proof)
            return final
        except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError) as exc:
            raise SandboxUnavailable("sandbox capability, protocol, or immutable runtime unavailable") from exc
        finally:
            # BaseException (including KeyboardInterrupt/caller cancellation) also
            # stops the child before control is returned. No retry/fallback.
            try:
                self._stop(process, leaf)
            except BaseException:
                self.last_receipt = None
                self._quarantined = True
                raise
            finally:
                self._lock.release()

    def _create_cgroup(self, session_id: str, budget: Any, *, mode: str = "decode") -> Path:
        assert self.config is not None
        task_limit = self.config.task_limit(mode)
        root = Path(self.config.cgroup_root)
        if root.resolve(strict=True) != root:
            raise SandboxUnavailable("cgroup delegation contains symlinks")
        mounts = _read_small(Path("/proc/self/mountinfo"), 1_000_000).splitlines()
        if not any(" - cgroup2 " in row and row.split()[4] == "/sys/fs/cgroup" for row in mounts):
            raise SandboxUnavailable("unified cgroup v2 mount required")
        enabled = set(_read_small(root / "cgroup.subtree_control").split())
        if not {"cpu", "memory", "pids"}.issubset(enabled):
            raise SandboxUnavailable("cpu/memory/pids must already be delegated")
        leaf = root / session_id
        leaf.mkdir(mode=0o700)
        try:
            controls = {"memory.max": str(budget.maximum_memory_bytes), "memory.swap.max": "0",
                        "memory.oom.group": "1", "pids.max": str(task_limit), "cpu.max": "100000 100000"}
            for name, value in controls.items():
                (leaf / name).write_text(value, encoding="ascii")
                if _read_small(leaf / name).strip() != value:
                    raise SandboxUnavailable("kernel resource control readback mismatch")
            for name in ("cgroup.kill", "memory.peak", "cpu.stat", "memory.events", "pids.events"):
                if not (leaf / name).exists():
                    raise SandboxUnavailable("required kernel accounting/termination capability absent")
            return leaf
        except BaseException:
            leaf.rmdir()
            raise

    def _argv(self, leaf: Path, budget: Any, session_id: str, worker_pin: str, *, mode: str = "decode") -> list[str]:
        assert self.config is not None
        config = self.config
        config.task_limit(mode)
        return [config.bwrap_path, "--unshare-all", "--die-with-parent", "--new-session",
                "--cap-drop", "ALL", "--disable-userns", "--ro-bind", config.rootfs, "/",
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                "--ro-bind", str(leaf), "/vertex-cgroup",
                "--bind", str(leaf / "cgroup.procs"), "/vertex-cgroup.procs",
                "--chdir", "/", "--clearenv", "--setenv", "LC_ALL", "C.UTF-8",
                PYTHON_PATH, "-I", "-S", "-B", WORKER_PATH,
                session_id, config.policy_digest, worker_pin, str(budget.maximum_memory_bytes),
                str(budget.maximum_cpu_ms), str(config.maximum_wire_bytes), mode]

    def _observe(self, process: subprocess.Popen[bytes], leaf: Path, budget: Any,
                 session_id: str, worker_pin: str, *, mode: str = "decode") -> WorkerObservation:
        assert self.config is not None
        task_limit = self.config.task_limit(mode)
        members = _read_small(leaf / "cgroup.procs").split()
        if len(members) != 1:
            raise SandboxRejected("exactly one isolated worker process required")
        pid = int(members[0])
        ancestor = pid
        for _ in range(32):
            if ancestor == process.pid:
                break
            status = _read_small(Path(f"/proc/{ancestor}/status"))
            values = dict(row.split(":", 1) for row in status.splitlines() if ":" in row)
            ancestor = int(values["PPid"].strip())
            if ancestor <= 1:
                raise SandboxRejected("cgroup process is not the launched worker")
        else:
            raise SandboxRejected("worker ancestry exceeds bound")
        status = dict(row.split(":", 1) for row in _read_small(Path(f"/proc/{pid}/status")).splitlines() if ":" in row)
        if status.get("NoNewPrivs", "").strip() != "1" or status.get("Seccomp", "").strip() != "2" or int(status["CapEff"].strip(), 16) != 0:
            raise SandboxRejected("worker kernel security state not enforced")
        namespaces = []
        for name in ("net", "mnt", "pid", "user", "ipc", "uts", "cgroup"):
            child = os.readlink(f"/proc/{pid}/ns/{name}")
            if child == os.readlink(f"/proc/self/ns/{name}"):
                raise SandboxRejected("worker namespace was not isolated")
            namespaces.append((name, child))
        mounts = _read_small(Path(f"/proc/{pid}/mountinfo"), 1_000_000).splitlines()
        root_ro = any(row.split()[4] == "/" and "ro" in row.split()[5].split(",") for row in mounts)
        if not root_ro:
            raise SandboxRejected("worker root is not read-only")
        if _read_small(leaf / "memory.max").strip() != str(budget.maximum_memory_bytes) or _read_small(leaf / "pids.max").strip() != str(task_limit):
            raise SandboxRejected("worker limits changed")
        return WorkerObservation(session_id, self.config.policy_digest, pid, tuple(namespaces), str(leaf),
                                 budget.maximum_memory_bytes, task_limit, _read_small(leaf / "cpu.max").strip(),
                                 1, 2, status["CapEff"].strip(), root_ro, worker_pin, self.config.review_digest,
                                 mode, self.config.native_research if mode == NATIVE_RESEARCH_PROFILE else None)

    def _measure(self, leaf: Path, budget: Any, started: int) -> tuple[int, int, int, dict[str, int]]:
        peak = int(_read_small(leaf / "memory.peak").strip())
        cpu = (_key_values(leaf / "cpu.stat")["usage_usec"] + 999) // 1000
        wall = (time.monotonic_ns() - started + 999_999) // 1_000_000
        events = _key_values(leaf / "memory.events")
        if peak > budget.maximum_memory_bytes or cpu > budget.maximum_cpu_ms or wall > budget.maximum_wall_ms:
            raise SandboxRejected("sandbox exhausted measured resource budget")
        if any(events.get(key, 0) for key in ("oom", "oom_kill", "oom_group_kill", "max")) or _key_values(leaf / "pids.events").get("max", 0):
            raise SandboxRejected("kernel denied a resource request")
        return peak, cpu, wall, events

    def _exchange(self, process: subprocess.Popen[bytes], leaf: Path, body: bytes,
                  authority: ContractAuthority | None, budget: Any, deadline: int,
                  cancellation: threading.Event | None, session_id: str, worker_pin: str,
                  *, output_limit: int | None = None, mode: str = "decode") -> tuple[WorkerObservation, dict[str, Any]]:
        assert self.config is not None and process.stdin and process.stdout and process.stderr
        config = self.config
        streams = (process.stdin, process.stdout, process.stderr)
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "out")
        selector.register(process.stderr, selectors.EVENT_READ, "err")
        pending = bytearray()
        incoming = bytearray()
        stdout_total = stderr_total = rpc_calls = 0
        observation = None
        response = None
        rpc_result: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)
        rpc_waiting = False
        stdin_registered = False
        stage = "ready"
        wire_total_limit = output_limit if output_limit is not None else config.maximum_wire_bytes * 16
        try:
            while True:
                now = time.monotonic_ns()
                if now >= deadline or (cancellation is not None and cancellation.is_set()):
                    raise SandboxRejected("sandbox cancelled or wall deadline expired")
                self._measure(leaf, budget, deadline - budget.maximum_wall_ms * 1_000_000)
                if rpc_waiting:
                    try:
                        ok, reply = rpc_result.get_nowait()
                    except queue.Empty:
                        pass
                    else:
                        rpc_waiting = False
                        if not ok:
                            raise SandboxUnavailable("authoritative contract call failed")
                        pending.extend(protocol_bytes({"type": "authority-result", "id": rpc_calls, "value": reply}, config.maximum_wire_bytes) + b"\n")
                if pending and not stdin_registered:
                    selector.register(process.stdin, selectors.EVENT_WRITE, "in")
                    stdin_registered = True
                if not pending and stdin_registered:
                    selector.unregister(process.stdin)
                    stdin_registered = False
                for key, _ in selector.select(0.01):
                    if key.data == "in":
                        try:
                            count = os.write(process.stdin.fileno(), pending[:65_536])
                        except BlockingIOError:
                            continue
                        del pending[:count]
                        continue
                    try:
                        data = os.read(key.fileobj.fileno(), 65_536)
                    except BlockingIOError:
                        continue
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == "err":
                        stderr_total += len(data)
                        if stderr_total > config.maximum_stderr_bytes:
                            raise SandboxRejected("worker stderr limit exceeded")
                        continue  # never log payload-bearing child diagnostics
                    stdout_total += len(data)
                    if stdout_total > wire_total_limit:
                        raise SandboxRejected("worker aggregate output limit exceeded")
                    incoming.extend(data)
                    while b"\n" in incoming:
                        line, _, rest = incoming.partition(b"\n")
                        incoming = bytearray(rest)
                        message = protocol_record(bytes(line), config.maximum_wire_bytes)
                        kind = message.get("type")
                        if stage == "ready" and message == {"type": "ready", "protocol": PROTOCOL, "session": session_id}:
                            observation = self._observe(process, leaf, budget, session_id, worker_pin, mode=mode)
                            pending.extend(protocol_bytes({"type": "enforcement", "observation": asdict(observation)}, config.maximum_wire_bytes) + b"\n" + body + b"\n")
                            stage = "running"
                        elif stage == "running" and kind == "authority" and not rpc_waiting and authority is not None:
                            if set(message) != {"type", "id", "method", "args"} or message["id"] != rpc_calls + 1:
                                raise SandboxRejected("authority request sequence mismatch")
                            rpc_calls += 1
                            if rpc_calls > config.maximum_rpc_calls:
                                raise SandboxRejected("authority request budget exceeded")
                            rpc_waiting = True
                            self._authority_thread = threading.Thread(target=self._authority_call,
                                args=(authority, message, rpc_result, config.maximum_wire_bytes,
                                      mode == "candle-fold-v1"), daemon=True)
                            self._authority_thread.start()
                        elif stage == "running" and kind == "result" and not rpc_waiting and not pending:
                            response = message
                            stage = "finished"
                            if stdin_registered:
                                selector.unregister(process.stdin)
                                stdin_registered = False
                            process.stdin.close()
                        else:
                            raise SandboxRejected("unexpected worker protocol transition")
                    if len(incoming) > config.maximum_wire_bytes:
                        raise SandboxRejected("worker frame limit exceeded")
                if process.poll() is not None:
                    # Drain both pipes after exit; poll alone does not establish EOF.
                    if not any(key.data in ("out", "err") for key in selector.get_map().values()):
                        if incoming or response is None or observation is None or rpc_waiting:
                            raise SandboxRejected("worker exited without a complete bounded result")
                        return observation, response
        finally:
            selector.close()

    @staticmethod
    def _authority_call(authority: ContractAuthority, message: dict[str, Any], replies: queue.Queue,
                        maximum: int, candle_fold: bool = False) -> None:
        try:
            method, args = message["method"], message["args"]
            if type(args) is not list:
                raise SandboxRejected("invalid authority arguments")
            contracts = {"StrategySpec", "BacktestRun", "DatasetManifest", "ResearchEvidence"}
            if candle_fold:
                contracts.add("Candle")
            if method == "validate" and len(args) == 3 and args[0] in contracts and args[2] == "1.0.0":
                value = authority.validate(args[0], args[1], schema_version=args[2])
                if type(value) is not bool:
                    raise SandboxRejected("authority validation is not boolean")
            elif method == "encode" and len(args) == 1:
                raw = authority.encode(args[0])
                if type(raw) is not bytes or len(raw) > maximum // 2:
                    raise SandboxRejected("authority encoding limit")
                value = {"bytes": base64.b64encode(raw).decode("ascii")}
            elif method == "digest" and len(args) == 1:
                value = _hash(authority.digest(args[0]))
            elif method == "epoch_ns" and len(args) == 1 and type(args[0]) is str and len(args[0]) <= 128:
                value = str(_integer(authority.epoch_ns(args[0]), 0, 2**127 - 1))
            else:
                raise SandboxRejected("authority method not allowed")
            protocol_bytes(value, maximum)
            replies.put_nowait((True, value))
        except BaseException:
            replies.put_nowait((False, None))

    @staticmethod
    def _stop(process: subprocess.Popen[bytes] | None, leaf: Path | None) -> None:
        failure = False
        if leaf is not None:
            try:
                (leaf / "cgroup.kill").write_text("1", encoding="ascii")
            except OSError:
                failure = True
        if process is not None:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                failure = True
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        if leaf is not None:
            end = time.monotonic() + 5
            while _key_values(leaf / "cgroup.events").get("populated") != 0 and time.monotonic() < end:
                time.sleep(0.01)
            if _key_values(leaf / "cgroup.events").get("populated") != 0:
                failure = True
            else:
                leaf.rmdir()
        if failure:
            raise SandboxUnavailable("sandbox termination could not be established; quarantine host")


class ConfiguredSandbox(LinuxSandboxSupervisor):
    """Lease-local facade for separate fixed research and decoder job classes."""
    def __init__(self, config: ReviewedSandboxConfig | None, authority: ContractAuthority,
                 clock: Any, cancellation: Any) -> None:
        super().__init__(config)
        self.authority = authority
        self.clock = clock
        self.cancellation = cancellation

    def create_engine(self, descriptor: Any, model: Any) -> Any:
        from .research_engine import IsolatedResearchSimulationEngine
        return IsolatedResearchSimulationEngine(descriptor=descriptor, model=model,
            authority=self.authority, sandbox=self, cancellation=self.cancellation)

    def run_fold_worker(self, job: Any, *, deadline_ns: int, cancellation: Any) -> Any:
        """One closed selection/recomputation in the existing measured worker.

        No caller closure runs in the parent and no process is retained. Both
        the actual lease/authority expiry and the requested monotonic budget
        fence preparation, exchange, termination and acceptance.
        """
        from backtesting.ports import PublicBoundary
        from .fold_selection import (
            FOLD_MODE, CandleFoldJob, CandleFoldWorkerOutput, check_fold_job, make_fold_binding,
        )
        if type(job) is not CandleFoldJob or self.config is None:
            raise SandboxUnavailable("reviewed candle fold worker unavailable")
        config = self.config
        budget = job.request.budget
        descriptor = job.selector if job.operation == "candle.select-v1" else job.verifier
        if descriptor.sandbox_policy_digest != config.policy_digest:
            raise SandboxRejected("fold sandbox policy pin mismatch")
        started = time.monotonic_ns()
        started_epoch = self.clock.now_ns()
        authority_expiry = self.authority.epoch_ns(job.admission.decode()["expiresAt"])
        epoch_deadline = min(_integer(deadline_ns, 0, 2**127 - 1), authority_expiry)
        deadline = min(started + budget.maximum_wall_ms * 1_000_000,
                       started + epoch_deadline - started_epoch)
        owner = self

        class Cancelled:
            def is_set(self) -> bool:
                now = owner.clock.now_ns()
                return (owner.cancellation.is_set() or cancellation.is_set()
                        or now < started_epoch or now >= epoch_deadline)

        cancelled = Cancelled()
        self._deadline_guard(deadline, cancelled)
        if not self._lock.acquire(blocking=False):
            raise SandboxUnavailable("sandbox already running")
        leaf = process = None
        self.last_receipt = None
        try:
            if self._quarantined or (self._authority_thread is not None and self._authority_thread.is_alive()):
                raise SandboxUnavailable("sandbox quarantine or outstanding authority call")
            boundary = PublicBoundary(validator=self.authority, codec=self.authority,
                                      maximum_bytes=budget.maximum_input_bytes)
            check_fold_job(job, boundary)
            _verify_runtime(config, lambda: self._deadline_guard(deadline, cancelled))
            session_id = "fold-" + uuid.uuid4().hex
            registry = fold_wire_registry()
            body = protocol_bytes({
                "type": "candle-fold", "protocol": PROTOCOL, "session": session_id,
                "policy": config.policy_digest, "job": pack(job, registry), "budget": asdict(budget),
                "maximumWireBytes": config.maximum_wire_bytes, "maximumRpcCalls": config.maximum_rpc_calls,
            }, min(config.maximum_wire_bytes, budget.maximum_input_bytes))
            binding = make_fold_binding(job, len(body))
            binding_digest = hashlib.sha256(protocol_bytes(pack(binding, registry))).hexdigest()
            leaf = self._create_cgroup(session_id, budget, mode=FOLD_MODE)
            worker_pin = next(pin.sha256 for pin in config.runtime_files if pin.path == WORKER_PATH)
            self._deadline_guard(deadline, cancelled)
            process = subprocess.Popen(
                self._argv(leaf, budget, session_id, worker_pin, mode=FOLD_MODE),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={}, cwd="/", close_fds=True, start_new_session=True, shell=False, bufsize=0,
            )
            observation, response = self._exchange(process, leaf, body, self.authority, budget,
                deadline, cancelled, session_id, worker_pin, mode=FOLD_MODE,
                output_limit=min(config.maximum_wire_bytes, budget.maximum_input_bytes) * 16)
            self._deadline_guard(deadline, cancelled)
            if (process.returncode != 0 or set(response) != {"type", "protocol", "session", "output",
                    "outputSha256", "isolationContent", "startAttestation", "finishAttestation"}
                    or response["protocol"] != PROTOCOL or response["session"] != session_id):
                raise SandboxRejected("fold worker result identity mismatch")
            raw_output = protocol_bytes(response["output"], min(config.maximum_wire_bytes, budget.maximum_input_bytes))
            if hashlib.sha256(raw_output).hexdigest() != response["outputSha256"]:
                raise SandboxRejected("fold worker result digest mismatch")
            output = unpack(response["output"], registry)
            if type(output) is not CandleFoldWorkerOutput or output.request_digest != job.request.binding.digest:
                raise SandboxRejected("typed bound fold output required")
            if (job.operation == "candle.select-v1" and (output.verified is not False or output.candidate is None)
                    or job.operation == "candle.verify-v1" and (output.verified is not True or output.candidate is not None
                        or output.subject_digest != job.sealed_selection.digest)):
                raise SandboxRejected("fold operation result mismatch")
            isolation = base64.b64decode(response["isolationContent"], validate=True)
            start_proof = base64.b64decode(response["startAttestation"], validate=True)
            finish_proof = base64.b64decode(response["finishAttestation"], validate=True)
            if not 0 < len(isolation) <= 60_000 or not 0 < len(start_proof) <= 65_536 or not 0 < len(finish_proof) <= 65_536:
                raise SandboxRejected("bounded actual fold attestations required")
            enforcement = protocol_record(isolation, 60_000)
            if (enforcement["bindingDigest"] != binding_digest
                    or protocol_bytes(enforcement["enforcement"]["parentObservation"]) != protocol_bytes(asdict(observation))):
                raise SandboxRejected("fold evidence differs from measured parent binding")
            for proof, expected in ((start_proof, {"phase": "start", "bindingDigest": binding_digest,
                    "enforcementDigest": hashlib.sha256(isolation).hexdigest()}),
                    (finish_proof, {"phase": "finish", "bindingDigest": binding_digest,
                    "outputDigest": response["outputSha256"], "enforcementDigest": hashlib.sha256(isolation).hexdigest()})):
                wrapped = protocol_record(proof, 65_536)
                if set(wrapped) != {"payload", "mac"} or protocol_record(base64.b64decode(wrapped["payload"], validate=True), 60_000) != expected:
                    raise SandboxRejected("fold attestation binding mismatch")
                _hash(wrapped["mac"])  # MAC was verified inside the pinned child.
            receipt = output.sandbox
            if (receipt.policy_digest != descriptor.sandbox_policy_digest or receipt.budget != budget
                    or receipt.limits_enforced is not True or receipt.network_used is not False
                    or receipt.execution_authority_used is not False or receipt.input_bytes != len(body)
                    or receipt.events_processed != sum(item.declared_events for item in job.request.sources)
                    or not 0 < receipt.events_processed <= budget.maximum_events
                    or not output.evidence_bytes or len(output.evidence_bytes) > 64
                    or sum(len(raw) for raw in output.evidence_bytes) > budget.maximum_input_bytes):
                raise SandboxRejected("fold measured receipt binding mismatch")
            evidence = [boundary.public("ResearchEvidence", protocol_record(raw, budget.maximum_input_bytes))
                        for raw in output.evidence_bytes]
            if (any(item.decode()["acceptanceStatus"] != "unreviewed" for item in evidence)
                    or not any(item.decode()["evidenceId"] == receipt.isolation_evidence_id
                        and item.decode()["contentHash"] == hashlib.sha256(isolation).hexdigest() for item in evidence)):
                raise SandboxRejected("fold output omitted actual unreviewed isolation evidence")
            peak, cpu, wall, events = self._measure(leaf, budget, started)
            if _key_values(leaf / "cgroup.events").get("populated") != 0:
                raise SandboxRejected("fold worker descendants remain alive")
            self._deadline_guard(deadline, cancelled)
            final = replace(output, sandbox=replace(receipt, peak_memory_bytes=peak, cpu_ms=cpu, wall_ms=wall))
            self.last_receipt = WorkerRunReceipt(observation, response["outputSha256"], peak, cpu, wall,
                tuple(sorted(events.items())), True, True, isolation, start_proof, finish_proof,
                len(body), len(raw_output), job.operation, job.request.binding.digest, job.admission.digest)
            return final
        except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError) as exc:
            raise SandboxUnavailable("fold worker capability or exact wire unavailable") from exc
        finally:
            try:
                self._stop(process, leaf)
            except BaseException:
                self.last_receipt = None
                self._quarantined = True
                raise
            finally:
                self._lock.release()

    def call(self, operation: str, payload: dict[str, Any], *, deadline_ns: int,
             max_output_bytes: int) -> dict[str, Any]:
        """Pure decoder child; never a provider fetch or network-enabled job.

        deadline_ns is UTC epoch nanoseconds supplied by the host lease clock.
        This synchronous method belongs on the caller's bounded worker thread.
        """
        from backtesting.ports import ResourceBudget
        if operation not in {"adapters.decode-csv", "adapters.decode-arrow", "adapters.decode-pdf"}:
            raise SandboxUnavailable("operation is not a fixed offline decoder")
        config = self.config
        if config is None or config.maximum_wire_bytes < 43_000_000:
            raise SandboxUnavailable("reviewed decoder runtime/wire limit unavailable")
        _integer(max_output_bytes, 1, 16_000_000)
        _integer(deadline_ns, 0, 2**127 - 1)
        remaining = min(30_000, (deadline_ns - self.clock.now_ns()) // 1_000_000)
        if remaining < 1 or self.cancellation.is_set():
            raise SandboxRejected("decoder cancelled or deadline expired")
        if not self._lock.acquire(blocking=False):
            raise SandboxUnavailable("sandbox already running")
        budget = ResourceBudget(maximum_input_bytes=43_000_000, maximum_memory_bytes=256 * 1024 * 1024,
                                maximum_cpu_ms=30_000, maximum_wall_ms=remaining)
        leaf = process = None
        started = time.monotonic_ns()
        deadline = started + remaining * 1_000_000
        self.last_receipt = None
        try:
            if self._quarantined:
                raise SandboxUnavailable("sandbox termination previously failed; host quarantined")
            if self._authority_thread is not None and self._authority_thread.is_alive():
                raise SandboxUnavailable("prior authoritative call remains outstanding")
            _verify_runtime(config, lambda: self._deadline_guard(deadline, self.cancellation))
            session_id = "decode-" + uuid.uuid4().hex
            leaf = self._create_cgroup(session_id, budget)
            body = protocol_bytes({"type": "decode", "protocol": PROTOCOL, "session": session_id,
                "policy": config.policy_digest, "operation": operation, "payload": payload,
                "budget": asdict(budget), "maximumOutputBytes": max_output_bytes}, 43_000_000)
            worker_pin = next(pin.sha256 for pin in config.runtime_files if pin.path == WORKER_PATH)
            if time.monotonic_ns() >= deadline or self.cancellation.is_set():
                raise SandboxRejected("decoder preparation exhausted deadline")
            process = subprocess.Popen(self._argv(leaf, budget, session_id, worker_pin, mode="decode"),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={}, cwd="/", close_fds=True, start_new_session=True, shell=False, bufsize=0)
            observed, response = self._exchange(process, leaf, body, None, budget, deadline,
                self.cancellation, session_id, worker_pin, output_limit=max_output_bytes + 65_536)
            if process.returncode != 0 or set(response) != {"type", "protocol", "session", "output", "outputSha256"}:
                raise SandboxRejected("decoder did not finish its fixed protocol")
            if response["protocol"] != PROTOCOL or response["session"] != session_id or type(response["output"]) is not dict:
                raise SandboxRejected("decoder result identity mismatch")
            raw = protocol_bytes(response["output"], max_output_bytes)
            if hashlib.sha256(raw).hexdigest() != response["outputSha256"]:
                raise SandboxRejected("decoder result digest mismatch")
            peak, cpu, wall, events = self._measure(leaf, budget, started)
            if _key_values(leaf / "cgroup.events").get("populated") != 0:
                raise SandboxRejected("decoder descendants remain alive")
            self.last_receipt = WorkerRunReceipt(observed, response["outputSha256"], peak, cpu, wall,
                                                tuple(sorted(events.items())), True, True)
            return response["output"]
        except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError) as exc:
            raise SandboxUnavailable("offline decoder capability unavailable") from exc
        finally:
            try:
                self._stop(process, leaf)
            except BaseException:
                self.last_receipt = None
                self._quarantined = True
                raise
            finally:
                self._lock.release()


def load_sandbox(config: Any, authority: ContractAuthority, clock: Any, cancellation: Any) -> ConfiguredSandbox:
    """Metadata-only explicit host configuration; never probes/launches at load."""
    from collections.abc import Mapping
    if config is None:
        return ConfiguredSandbox(None, authority, clock, cancellation)
    required = {field.name for field in fields(ReviewedSandboxConfig)} - {"native_research"}
    if not isinstance(config, Mapping) or set(config) not in (required, required | {"native_research"}):
        raise SandboxUnavailable("exact reviewed sandbox configuration fields required")
    values = dict(config)
    pins = values["runtime_files"]
    if type(pins) not in (list, tuple) or not 1 <= len(pins) <= 50_000:
        raise SandboxUnavailable("exact runtime file pins required")
    values["runtime_files"] = tuple(RuntimeFilePin(**dict(pin)) for pin in pins)
    native = values.get("native_research")
    if native is not None:
        if not isinstance(native, Mapping) or set(native) != {"profile", "libc"}:
            raise SandboxUnavailable("exact native research profile and libc pin required")
        values["native_research"] = NativeResearchProfile(native["profile"], RuntimeFilePin(**dict(native["libc"])))
    return ConfiguredSandbox(ReviewedSandboxConfig(**values), authority, clock, cancellation)
