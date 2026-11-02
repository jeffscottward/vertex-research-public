"""Bounded local transport; never grants broker or live trading authority.

The reviewed image is trusted native code, NOT sandboxed by ctypes. Its complete
ELF dependency closure and host loader environment must be sealed by the release
owner. This bridge binds the primary image bytes, build identity, kernel sources
and authority bundle; it cannot make an arbitrary shared library safe to load.
"""
from __future__ import annotations

import asyncio
import ctypes
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading
from typing import Any

MAX_INPUT_BYTES = 4_194_304
MAX_OUTPUT_BYTES = 2_000_000
MAX_BUNDLE_BYTES = 8_388_608
MAX_IDENTITY_BYTES = 4_096
MAX_LIBRARY_BYTES = 67_108_864
MAX_LOADED_IMAGES = 8
_DIGEST = re.compile(r"[0-9a-f]{64}", re.ASCII)
_BUILD_ID = re.compile(r"[A-Za-z0-9_.-]{1,128}", re.ASCII)
_STATUS = {
    1: "invalid-abi-argument", 2: "native-input-bound", 3: "native-response-bound",
    4: "native-authority-unavailable", 5: "native-kernel-failure",
    6: "native-panic", 7: "native-response-bound",
}
_U8 = ctypes.c_uint8
_U8P = ctypes.POINTER(_U8)
_SIZE = ctypes.c_size_t
_SIZEP = ctypes.POINTER(_SIZE)


class KernelBridgeError(RuntimeError):
    """Sanitized bounded error code, never command/bundle/native diagnostic data."""


class KernelBridgeUnavailable(KernelBridgeError):
    """No admitted image/authority; caller must fail closed without fallback."""


@dataclass(frozen=True, slots=True)
class ReviewedKernelConfig:
    """All identities come from independent reviewed release configuration.

    Never derive library_sha256 or bundle_sha256 from untrusted inputs just to
    satisfy this constructor. contract_source_sha256 is the bundle sourceDigest,
    not the bundle file hash. kernel_source_sha256 uses build.rs's v1 algorithm.
    """
    library_path: Path
    library_sha256: str
    build_id: str
    kernel_source_sha256: str
    contract_source_sha256: str
    bundle_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.library_path, Path) or not self.library_path.is_absolute():
            raise KernelBridgeUnavailable("absolute-reviewed-library-path-required")
        for value in (self.library_sha256, self.kernel_source_sha256,
                      self.contract_source_sha256, self.bundle_sha256):
            if type(value) is not str or _DIGEST.fullmatch(value) is None:
                raise KernelBridgeUnavailable("reviewed-sha256-required")
        if type(self.build_id) is not str or _BUILD_ID.fullmatch(self.build_id) is None:
            raise KernelBridgeUnavailable("reviewed-build-identity-required")


def _buffer(value: bytes) -> Any:
    # Always separate caller-owned storage, even when equal byte objects were
    # interned or alias. Empty input is legal for the exact kernel JSON adapter.
    return (_U8 * max(1, len(value))).from_buffer_copy(value or b"\0")


def _check_status(status: int) -> None:
    if type(status) is not int or status != 0:
        raise KernelBridgeError(_STATUS.get(status, "unknown-native-status"))


def _response(api: Any, args: tuple[Any, ...], capacity: int) -> bytes:
    output = (_U8 * capacity)()
    written = _SIZE(0)
    status = api(*args, output, capacity, ctypes.byref(written))
    _check_status(status)
    if not 0 < written.value <= capacity:
        raise KernelBridgeError("invalid-native-response-length")
    return bytes(output[:written.value])


def _expected_identity(config: ReviewedKernelConfig) -> dict[str, Any]:
    return {
        "abi_version": 1, "bridge_version": "0.1.0", "build_id": config.build_id,
        "contract_source_sha256": config.contract_source_sha256,
        "kernel_request_version": "vertex.execution-kernel.v1",
        "kernel_source_sha256": config.kernel_source_sha256,
        "max_bundle_bytes": MAX_BUNDLE_BYTES, "max_input_bytes": MAX_INPUT_BYTES,
        "max_output_bytes": MAX_OUTPUT_BYTES,
    }


@dataclass(frozen=True, slots=True)
class _Image:
    descriptor: int
    library: Any
    identity_bytes: bytes
    evaluate: Any
    validate_bundle: Any


# Native mappings and descriptors intentionally stay process-owned. ctypes has
# no safe portable unload contract. Retaining descriptors also prevents dlopen's
# /proc/self/fd/N name cache from aliasing a later file after descriptor reuse.
# At most eight image loads, including a loaded image rejected during inspection.
# close() retires a bridge's authority bytes, not process-global executable code.
_IMAGES: dict[str, _Image] = {}
_MAPPINGS: list[tuple[int, Any]] = []
_IMAGES_LOCK = threading.Lock()


def _sealed_image(config: ReviewedKernelConfig) -> int:
    source = -1
    snapshot = -1
    try:
        source = os.open(config.library_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        metadata = os.fstat(source)
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= MAX_LIBRARY_BYTES:
            raise KernelBridgeUnavailable("reviewed-library-file-bound")
        snapshot = os.memfd_create("vertex-reviewed-kernel", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(source, min(131_072, MAX_LIBRARY_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_LIBRARY_BYTES:
                raise KernelBridgeUnavailable("reviewed-library-file-bound")
            digest.update(chunk)
            remaining = memoryview(chunk)
            while remaining:
                count = os.write(snapshot, remaining)
                if count <= 0:
                    raise KernelBridgeUnavailable("reviewed-library-snapshot-failed")
                remaining = remaining[count:]
        if total != metadata.st_size or digest.hexdigest() != config.library_sha256:
            raise KernelBridgeUnavailable("reviewed-library-sha256-mismatch")
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(snapshot, fcntl.F_ADD_SEALS, seals)
        if fcntl.fcntl(snapshot, fcntl.F_GET_SEALS) & seals != seals:
            raise KernelBridgeUnavailable("reviewed-library-sealing-unavailable")
        os.lseek(snapshot, 0, os.SEEK_SET)
        result, snapshot = snapshot, -1
        return result
    except KernelBridgeError:
        raise
    except (OSError, ValueError, AttributeError):
        raise KernelBridgeUnavailable("reviewed-library-snapshot-unavailable") from None
    finally:
        if source >= 0:
            os.close(source)
        if snapshot >= 0:
            os.close(snapshot)


def _load_image(config: ReviewedKernelConfig) -> _Image:
    with _IMAGES_LOCK:
        if config.library_sha256 in _IMAGES:
            return _IMAGES[config.library_sha256]
        if len(_MAPPINGS) >= MAX_LOADED_IMAGES:
            raise KernelBridgeUnavailable("native-image-lifetime-bound")
        descriptor = _sealed_image(config)
        mapped = False
        try:
            # No dlopen until the full immutable snapshot matches the external
            # pin. Constructors execute here; library trust precedes this point.
            library = ctypes.CDLL(f"/proc/self/fd/{descriptor}", mode=os.RTLD_LOCAL | os.RTLD_NOW)
            _MAPPINGS.append((descriptor, library))
            mapped = True
            identity = library.vertex_kernel_bridge_identity_v1
            identity.argtypes, identity.restype = [_U8P, _SIZE, _SIZEP], ctypes.c_int32
            validate = library.vertex_kernel_bridge_validate_bundle_v1
            validate.argtypes, validate.restype = [_U8P, _SIZE, _U8P, _SIZE], ctypes.c_int32
            evaluate = library.vertex_kernel_bridge_evaluate_v1
            evaluate.argtypes = [_U8P, _SIZE, _U8P, _SIZE, _U8P, _SIZE, _U8P, _SIZE, _SIZEP]
            evaluate.restype = ctypes.c_int32
            identity_bytes = _response(identity, (), MAX_IDENTITY_BYTES)
            image = _Image(descriptor, library, identity_bytes, evaluate, validate)
            _IMAGES[config.library_sha256] = image
            return image
        except KernelBridgeError:
            raise
        except (OSError, AttributeError, TypeError, ValueError):
            raise KernelBridgeUnavailable("reviewed-native-abi-unavailable") from None
        finally:
            if not mapped:
                os.close(descriptor)


def _canonical_identity(config: ReviewedKernelConfig) -> bytes:
    return json.dumps(_expected_identity(config), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


class KernelBridge:
    """One admitted call per instance; synchronous bytes or asynchronous bytes.

    No implicit library selection. Await cancellation does NOT cancel a native
    call. The slot stays reserved until the actual call ends, including after
    cancellation; close fails busy instead of unloading code under a worker.
    There is no native deadline/kill guarantee. Use parent process supervision
    for hard limits. No IO/callback is delegated to native evaluation.
    """
    __slots__ = ("_image", "_bundle", "_pin", "_gate", "_closed")

    def __init__(self) -> None:
        raise KernelBridgeUnavailable("explicit-reviewed-load-required")

    @classmethod
    def load(cls, *, config: ReviewedKernelConfig, contract_bundle: bytes) -> KernelBridge:
        if type(config) is not ReviewedKernelConfig:
            raise KernelBridgeUnavailable("reviewed-kernel-config-required")
        if sys.platform != "linux" or sys.version_info[:3] != (3, 12, 11):
            raise KernelBridgeUnavailable("linux-python-3.12.11-required")
        if type(contract_bundle) is not bytes or not 0 < len(contract_bundle) <= MAX_BUNDLE_BYTES:
            raise KernelBridgeUnavailable("contract-bundle-bound")
        if hashlib.sha256(contract_bundle).hexdigest() != config.bundle_sha256:
            raise KernelBridgeUnavailable("contract-bundle-sha256-mismatch")
        image = _load_image(config)
        # Byte equality rejects extra fields, duplicate keys and bool/int aliases
        # without adding another JSON interpretation at the trust boundary.
        if image.identity_bytes != _canonical_identity(config):
            raise KernelBridgeUnavailable("reviewed-native-build-identity-mismatch")
        bundle_buffer, pin_buffer = _buffer(contract_bundle), _buffer(config.bundle_sha256.encode("ascii"))
        try:
            _check_status(image.validate_bundle(bundle_buffer, len(contract_bundle), pin_buffer, 64))
        except KernelBridgeError:
            raise KernelBridgeUnavailable("reviewed-native-authority-unavailable") from None
        instance = object.__new__(cls)
        instance._image, instance._bundle, instance._pin = image, contract_bundle, config.bundle_sha256.encode("ascii")
        instance._gate, instance._closed = threading.Lock(), False
        return instance

    def _reserve(self, command: bytes, maximum_response_bytes: int) -> None:
        if type(command) is not bytes or len(command) > MAX_INPUT_BYTES:
            raise KernelBridgeError("kernel-command-bound")
        if type(maximum_response_bytes) is not int or not 1 <= maximum_response_bytes <= MAX_OUTPUT_BYTES:
            raise KernelBridgeError("kernel-response-bound")
        if not self._gate.acquire(blocking=False):
            raise KernelBridgeError("kernel-bridge-busy")
        if self._closed:
            self._gate.release()
            raise KernelBridgeUnavailable("kernel-bridge-closed")

    def _evaluate_reserved(self, command: bytes, maximum_response_bytes: int) -> bytes:
        try:
            bundle_buffer, pin_buffer, input_buffer = _buffer(self._bundle), _buffer(self._pin), _buffer(command)
            return _response(self._image.evaluate, (
                bundle_buffer, len(self._bundle), pin_buffer, len(self._pin), input_buffer, len(command),
            ), maximum_response_bytes)
        finally:
            self._gate.release()

    def evaluate_json(self, command: bytes) -> bytes:
        """Exact Callable[[bytes], bytes] for NativeRiskPort; no reinterpretation."""
        self._reserve(command, MAX_OUTPUT_BYTES)
        return self._evaluate_reserved(command, MAX_OUTPUT_BYTES)

    async def evaluate(self, command: bytes, *, maximum_response_bytes: int = MAX_OUTPUT_BYTES) -> bytes:
        """Off-loop local call; reject queueing while any call is still in flight."""
        self._reserve(command, maximum_response_bytes)
        try:
            future = asyncio.get_running_loop().run_in_executor(
                None, self._evaluate_reserved, command, maximum_response_bytes,
            )
        except BaseException:
            self._gate.release()
            raise
        # Retrieve exceptions even if the awaiting caller cancels. Shield keeps
        # queued native work alive so its finally owns the sole slot release.
        future.add_done_callback(lambda completed: None if completed.cancelled() else completed.exception())
        return await asyncio.shield(future)

    def close(self) -> None:
        if not self._gate.acquire(blocking=False):
            raise KernelBridgeError("kernel-bridge-busy")
        try:
            self._closed = True
            self._bundle, self._pin = b"", b""
        finally:
            self._gate.release()

    def __enter__(self) -> KernelBridge:
        if self._closed:
            raise KernelBridgeUnavailable("kernel-bridge-closed")
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
