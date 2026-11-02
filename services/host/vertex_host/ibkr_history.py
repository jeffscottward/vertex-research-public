"""Exclusive research-owner composition; no import-time/native/session effects.

The opt-in source patch must be built INTO the reviewed rc5 native image. This
module never installs it, loads an ambient wheel, or constructs a per-job client.
Only start(), explicitly called from authorized host startup with fresh control
selection, imports the measured image and calls its existing-registry bootstrap.
No API here grants dataset rights, admission, execution or broker session trust.
"""
from __future__ import annotations

import asyncio
import base64
from hashlib import sha256
import importlib
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any, Callable, Mapping
from uuid import uuid4

from providers.ibkr_history import HistoricalRequest

from .cache import HostUnavailable, canonical_object, thaw
from .nautilus import ReviewedDistribution, ReviewedNautilusLoader, _NATIVE_IMPORT_LOCK

_BINDING = ("vertex-nautilus-history-owner-v1", "2.0.0rc5", "ibapi=3.3.0", "vertex-history-strict-v1")


def _require(condition: bool) -> None:
    if not condition:
        raise HostUnavailable("ibkr-history-owner-unavailable")


def _object(value: Any, keys: str) -> dict[str, Any]:
    _require(type(value) is dict and set(value) == set(keys.split()))
    return value


async def _join_thread(operation: Callable[..., Any], *args: Any,
                       on_cancel: Callable[[], None] | None = None) -> Any:
    # Never abandon a native startup/drain/ACK running in a thread. The caller
    # checks current authority again after startup; cancellation is not success.
    task = asyncio.create_task(asyncio.to_thread(operation, *args))
    interrupted = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            interrupted = True
            if on_cancel is not None:
                on_cancel()
    result = task.result()
    if interrupted:
        raise asyncio.CancelledError
    return result


class _HistoryLoader(ReviewedNautilusLoader):
    """Reuse exact distribution measurement, not the offline engine activation."""

    def load_history_class(self) -> Any:
        with _NATIVE_IMPORT_LOCK:
            _require(not self._attempted)
            self._attempted = True
            self.current()
            root = Path(self._root)
            _require(self._contracts.digest({"name": "nautilus-trader", "version": self._distribution.version,
                "files": dict(self._distribution.files)}) == self._distribution.build_sha256)
            self._measure(root)
            _require(not any(name == "nautilus_trader" or name.startswith("nautilus_trader.")
                             for name in sys.modules))
            previous_path, previous_no_bytecode = sys.path[:], sys.dont_write_bytecode
            try:
                sys.dont_write_bytecode = True
                sys.path.insert(0, str(root))
                spec = importlib.util.spec_from_file_location("nautilus_trader", root / "nautilus_trader/__init__.py",
                    submodule_search_locations=[str(root / "nautilus_trader")])
                _require(spec is not None and spec.loader is not None)
                package = importlib.util.module_from_spec(spec)
                sys.modules["nautilus_trader"] = package
                spec.loader.exec_module(package)
                _require(getattr(package, "__version__", None) == "2.0.0rc5")
                native = importlib.import_module("nautilus_trader._libnautilus")
                _require(isinstance(native.__loader__, importlib.machinery.ExtensionFileLoader))
                origin = Path(native.__file__).resolve(strict=True)
                _require(origin.is_relative_to(root)
                    and origin.relative_to(root).as_posix() in dict(self._distribution.files))
                binding = native.interactive_brokers.VertexHistoryOwner
                _require(tuple(binding.identity()) == _BINDING)
                # The exact reviewed compiled inventory, not this identity string,
                # binds the installed implementation and its same-link dependency.
                self._measure(root)
                self.current()
                return binding
            finally:
                sys.path[:] = previous_path
                sys.dont_write_bytecode = previous_no_bytecode


class NativeHistoryOwner:
    """Actual restricted port; source-authored, not currently built or activated.

    At most eight native outcomes remain retained pending a verified stage ACK.
    Memory retention is NOT crash durability. Missing ACK/uncertain dispatch
    blocks clean drain. A source-complete capture is still not dataset admission.
    """

    def __init__(self, *, loader: _HistoryLoader, profile: dict[str, Any], endpoint: dict[str, Any],
                 selection_sha256: str, current: Callable[[], bool], clock: Any) -> None:
        self._loader, self._profile, self._endpoint = loader, profile, endpoint
        self._selection_sha256, self._current, self._clock = selection_sha256, current, clock
        self._native: Any = None
        self._attempted = False
        self._bootstrap_called = False
        self._closing = False
        self._pending: dict[str, str | None] = {}
        self._active: set[asyncio.Task[Any]] = set()
        self._lock = asyncio.Lock()

    @property
    def startup_budget_seconds(self) -> int:
        return self._endpoint["connectionTimeoutSeconds"] + 6 * len(self._profile["qualifications"]) + 2

    def matches_selection(self, selection: Mapping[str, Any]) -> bool:
        return selection["selectionSha256"] == self._selection_sha256

    def permits_request(self, request: HistoricalRequest) -> bool:
        value = request.decode()
        if value["contract_ref"] not in {row["contract_ref"] for row in self._profile["qualifications"]}:
            return False
        capabilities, kind = self._profile["capabilities"], value["kind"]
        if kind["type"] == "bars":
            return capabilities["bars"] and (kind["what_to_show"] != "ADJUSTED_LAST" or capabilities["adjusted_last"])
        return capabilities["bid_ask_ticks"]

    def _owner_current(self) -> bool:
        return not self._closing and self._current()

    def _cancel_startup(self) -> None:
        self._closing = True

    def _bootstrap(self) -> None:
        # Assignment to self._native occurs INSIDE the joined thread so even an
        # external cancellation after successful startup cannot lose the handle.
        binding = self._loader.load_history_class()
        config = {"generation": "history-" + uuid4().hex,
            "endpoint_ref": self._profile["endpointRef"],
            "build_ref": self._profile["distribution"]["buildSha256"],
            "qualifications": self._profile["qualifications"], **self._profile["capabilities"]}
        self._bootstrap_called = True
        self._native = binding.bootstrap(self._endpoint["host"], self._endpoint["port"],
            self._endpoint["clientId"], self._endpoint["connectionTimeoutSeconds"],
            json.dumps(config, separators=(",", ":"), allow_nan=False).encode(), self._owner_current)

    async def start(self) -> None:
        _require(not self._attempted and not self._closing and self._current())
        self._attempted = True
        await _join_thread(self._bootstrap, on_cancel=self._cancel_startup)
        _require(self._native is not None and self._current())

    async def acquire(self, request_json: bytes, *, cancellation: Any) -> bytes:
        request = HistoricalRequest(request_json)
        _require(self._native is not None and not self._closing and self._current()
                 and not cancellation.is_set() and self.permits_request(request))
        self._loader.current()
        async with self._lock:
            _require(request.sha256 not in self._pending and len(self._pending) < 8)
            key = self._native.begin(request.data)
            _require(key == request.sha256)
            self._pending[key] = None
        # The shielded, retained local waiter translates task/event cancellation
        # but still returns the native partial capture for ordinary stage handling.
        task = asyncio.create_task(self._collect(key, cancellation), name="ibkr-history-retained-capture")
        self._active.add(task)
        try:
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    self._native.cancel(key)
            return task.result()
        finally:
            self._active.discard(task)

    async def _collect(self, key: str, cancellation: Any) -> bytes:
        while True:
            if self._closing or cancellation.is_set() or not self._current():
                self._native.cancel(key)
            raw = self._native.capture(key)
            if raw is not None:
                _require(type(raw) is bytes and 0 < len(raw) <= 4_194_304)
                self._pending[key] = sha256(raw).hexdigest()
                return raw
            await asyncio.sleep(0.02)

    async def acknowledge_capture(self, *, request_sha256: str, capture_sha256: str,
                                  stage_artifact_id: str) -> None:
        # Trusted handler has ALREADY verified real accepted/duplicate stage ACK.
        # This is exact local evidence release, not a fresh broker/rights action.
        async with self._lock:
            _require(self._native is not None and self._pending.get(request_sha256) == capture_sha256
                     and type(capture_sha256) is str and len(capture_sha256) == 64
                     and stage_artifact_id == "blob-" + capture_sha256)
            def release() -> None:
                self._native.acknowledge(request_sha256, capture_sha256)
                # Keep both retention ledgers consistent even if the Python
                # caller is cancelled just after the native join/ACK completes.
                del self._pending[request_sha256]
            await _join_thread(release)

    async def close(self) -> None:
        self._closing = True
        if self._native is None:
            # Bootstrap may have dispatched qualification before failing. Without
            # its handle there is no safe fictional clean-drain/reconnect receipt.
            _require(not self._bootstrap_called)
            return
        for key in tuple(self._pending):
            self._native.cancel(key)
        if self._active:
            await asyncio.shield(asyncio.gather(*self._active, return_exceptions=True))
        unresolved = await _join_thread(self._native.drain)
        _require(unresolved == 0 and not self._pending)


class StartupHistoryPort:
    """Inert mount of the host's once-per-generation startup phase.

    The trusted dataset handler calls acquire only AFTER current rights, exact
    selection and durable intent ACK. The host callback rechecks current control
    authority before the first effectful startup; failures never auto-reconnect.
    """

    def __init__(self, start_owner: Callable[..., Any]) -> None:
        self._start_owner = start_owner
        self._owner: NativeHistoryOwner | None = None

    async def acquire(self, request_json: bytes, *, cancellation: Any) -> bytes:
        request = HistoricalRequest(request_json)
        _require(not cancellation.is_set())
        self._owner = await self._start_owner(request)
        return await self._owner.acquire(request.data, cancellation=cancellation)

    async def acknowledge_capture(self, *, request_sha256: str, capture_sha256: str,
                                  stage_artifact_id: str) -> None:
        _require(self._owner is not None)
        await self._owner.acknowledge_capture(request_sha256=request_sha256,
            capture_sha256=capture_sha256, stage_artifact_id=stage_artifact_id)


def compose_history_owner(*, selection: Mapping[str, Any], cache: Any, contracts: Any,
                          clock: Any, config: dict[str, Any], current: Callable[[], bool]) -> NativeHistoryOwner:
    """Inert composition from actual current-control selected original profile.

    Called only by explicit host startup after load_selection. Local config
    selects the mounted directory/address; it cannot supply cloud authority.
    """
    selected = thaw(selection)
    _require(contracts.validate("RuntimePolicySelection", selected) is True
        and contracts.digest({key: value for key, value in selected.items() if key != "selectionSha256"})
        == selected["selectionSha256"] and selected["environment"] == "research")
    _object(config, "distributionRoot endpoint profileArtifactId profileEvidenceArtifactId profileCollectionId")
    endpoint = _object(config["endpoint"], "endpointRef host port clientId connectionTimeoutSeconds")
    _require(type(endpoint["host"]) is str and 0 < len(endpoint["host"]) <= 253
        and all(ord(c) >= 32 and ord(c) != 127 for c in endpoint["host"])
        and type(endpoint["port"]) is int and 1 <= endpoint["port"] <= 65535
        and type(endpoint["clientId"]) is int and 0 <= endpoint["clientId"] <= 2_147_483_647
        and type(endpoint["connectionTimeoutSeconds"]) is int and 1 <= endpoint["connectionTimeoutSeconds"] <= 30)
    pins = [row["artifact"] for row in selected["artifacts"] if row["role"] == "dependency"
        and row["artifact"]["artifactId"] == config["profileArtifactId"]]
    _require(len(pins) == 1)
    pin = pins[0]
    _require(pin["contractName"] == "HostIBKRHistoryProfile" and pin["schemaVersion"] == "1.0.0")
    raw = cache.private_bytes(pin["artifactId"], pin["artifactSha256"])
    _require(sha256(raw).hexdigest() == pin["artifactSha256"])
    profile = canonical_object(contracts, raw)
    _object(profile, "format accountAlias environment collectionId endpointRef distribution binding qualifications capabilities")
    _require(profile["format"] == "vertex-ibkr-history-owner-v1"
        and profile["accountAlias"] == selected["accountAlias"] and profile["environment"] == "research"
        and profile["collectionId"] == config["profileCollectionId"] and profile["endpointRef"] == endpoint["endpointRef"]
        and type(profile["binding"]) is list and tuple(profile["binding"]) == _BINDING)
    distribution = _object(profile["distribution"], "name version buildSha256 files")
    _require(distribution["name"] == "nautilus-trader" and type(distribution["files"]) is dict)
    reviewed = ReviewedDistribution(distribution["version"], distribution["buildSha256"],
        tuple(sorted(distribution["files"].items())))
    _require(contracts.digest({key: value for key, value in distribution.items() if key != "buildSha256"})
        == reviewed.build_sha256)
    _require(type(profile["qualifications"]) is list and 1 <= len(profile["qualifications"]) <= 16)
    refs = set()
    for row in profile["qualifications"]:
        _object(row, "contract_ref contract expected_stable_sha256 price_precision volume_unit calendar_ref")
        _require(type(row["contract_ref"]) is str and row["contract_ref"] not in refs
            and type(row["contract"]) is dict and type(row["expected_stable_sha256"]) is str
            and len(row["expected_stable_sha256"]) == 64 and type(row["price_precision"]) is int
            and 0 <= row["price_precision"] <= 18 and row["volume_unit"] in ("shares", "lots", "unqualified")
            and type(row["calendar_ref"]) is str and bool(row["calendar_ref"]))
        # Units/calendar are reviewed profile refs, not inferred from rolling
        # contract_details hours; dataset admission must independently qualify use.
        refs.add(row["contract_ref"])
    capabilities = _object(profile["capabilities"], "bars adjusted_last bid_ask_ticks")
    _require(all(type(value) is bool for value in capabilities.values())
        and (capabilities["bars"] or capabilities["bid_ask_ticks"])
        and (not capabilities["adjusted_last"] or capabilities["bars"]))
    issued, expires = contracts.epoch_ns(selected["issuedAt"]), contracts.epoch_ns(selected["expiresAt"])
    _require(issued <= clock.now_ns() < expires)
    loader = _HistoryLoader(distribution=reviewed, root=config["distributionRoot"], contracts=contracts,
        clock=clock, issued_ns=issued, expires_ns=expires)
    return NativeHistoryOwner(loader=loader, profile=profile, endpoint=endpoint,
        selection_sha256=selected["selectionSha256"], current=current, clock=clock)


async def require_current_profile_review(*, selection: Mapping[str, Any], originals: Mapping[str, bytes],
        config: dict[str, Any], control: Any, contracts: Any, lease_fence: dict[str, Any],
        clock: Any, max_age_ns: int) -> int:
    """Existing current acceptedEvidence join, never local-file review authority."""
    profile_pins = [row["artifact"] for row in selection["artifacts"] if row["role"] == "dependency"
        and row["artifact"]["artifactId"] == config["profileArtifactId"]]
    evidence_pins = [row["artifact"] for row in selection["artifacts"] if row["role"] == "dependency"
        and row["artifact"]["artifactId"] == config["profileEvidenceArtifactId"]]
    _require(len(profile_pins) == len(evidence_pins) == 1)
    profile, pin = profile_pins[0], evidence_pins[0]
    _require(profile["contractName"] == "HostIBKRHistoryProfile"
        and pin["contractName"] == "ResearchEvidence" and pin["schemaVersion"] == "1.0.0")
    original = originals[pin["artifactId"]]
    evidence = canonical_object(contracts, original)
    _require(sha256(original).hexdigest() == pin["artifactSha256"]
        and contracts.validate("ResearchEvidence", evidence) is True
        and evidence["collectionId"] == config["profileCollectionId"]
        and evidence["sourceLocator"] == profile["artifactId"]
        and evidence["sourceIdentity"]["sourceId"] == profile["artifactId"]
        and evidence["contentHash"] == evidence["sourceIdentity"]["contentHash"] == profile["artifactSha256"])
    started = clock.now_ns()
    result = await control.accepted_evidence(**lease_fence, collectionId=config["profileCollectionId"], evidenceId=evidence["evidenceId"])
    _require(contracts.validate("WorkerAcceptedEvidenceOutput", result) is True)
    review, rights = result["review"], result["rights"]
    now = clock.now_ns()
    _require(result["artifact"] == {"artifactId": pin["artifactId"], "artifactSha256": pin["artifactSha256"]}
        and base64.b64decode(result["contentBase64"], validate=True) == original and result["evidence"] == evidence
        and review["artifactId"] == pin["artifactId"] and review["artifactSha256"] == pin["artifactSha256"]
        and review["collectionId"] == config["profileCollectionId"] and review["accountAlias"] == lease_fence["accountAlias"]
        and review["environment"] == "research" and review["purpose"] == "research"
        and review["decision"] == "accepted"
        and contracts.epoch_ns(review["reviewedAt"]) <= started <= now < contracts.epoch_ns(review["expiresAt"])
        and rights["policyId"] == evidence["rightsPolicyId"] and rights["status"] == "granted"
        and {"read", "derive", "export"}.issubset(rights["allowedUses"])
        and rights["expiresAt"] is not None
        and started <= contracts.epoch_ns(rights["checkedAt"]) <= now < contracts.epoch_ns(rights["expiresAt"]))
    return min(contracts.epoch_ns(review["expiresAt"]), contracts.epoch_ns(rights["expiresAt"]),
               contracts.epoch_ns(rights["checkedAt"]) + max_age_ns)
