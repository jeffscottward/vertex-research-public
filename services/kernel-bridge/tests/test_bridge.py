"""Authored only. Fake native functions never load or execute an ELF image."""
import asyncio
import ctypes
from dataclasses import replace
import hashlib
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from vertex_kernel_bridge import KernelBridge, KernelBridgeError, KernelBridgeUnavailable, ReviewedKernelConfig
from vertex_kernel_bridge import bridge as implementation


BUNDLE = b"synthetic-pinned-fixture-not-a-contract-authority"
RESPONSE = b'{"broker_submission_allowed":false,"live_authorization":false,"status":"rejected"}'


def config() -> ReviewedKernelConfig:
    return ReviewedKernelConfig(Path("/explicit/synthetic.so"), "1" * 64, "synthetic-test-build",
                                "2" * 64, "3" * 64, hashlib.sha256(BUNDLE).hexdigest())


class FakeNative:
    def __init__(self) -> None:
        self.commands: list[bytes] = []
        self.capacities: list[int] = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False
        self.status = 0
        self.authority_status = 0
        self.invalid_length = False

    def validate(self, *_: object) -> int:
        return self.authority_status

    def evaluate(self, bundle, bundle_len, pin, pin_len, command, command_len, output, capacity, written) -> int:
        self.commands.append(bytes(command[:command_len]))
        self.capacities.append(capacity)
        self.entered.set()
        if self.block and not self.release.wait(3):
            raise RuntimeError("synthetic worker timeout")
        if self.status:
            return self.status
        length = len(RESPONSE) if not self.invalid_length else capacity + 1
        ctypes.cast(written, ctypes.POINTER(ctypes.c_size_t))[0] = length
        if self.invalid_length:
            return 0
        if len(RESPONSE) > capacity:
            return 3
        ctypes.memmove(output, RESPONSE, len(RESPONSE))
        return 0


def load_fake(native: FakeNative, *, identity: bytes | None = None) -> KernelBridge:
    selected = config()
    image = implementation._Image(-1, None, identity if identity is not None else implementation._canonical_identity(selected),
                                  native.evaluate, native.validate)
    with patch.object(implementation.sys, "platform", "linux"), patch.object(implementation.sys, "version_info", (3, 12, 11)), patch.object(implementation, "_load_image", return_value=image):
        return KernelBridge.load(config=selected, contract_bundle=BUNDLE)


class BridgeRegression(unittest.TestCase):
    def test_config_and_constructor_never_select_default_library(self) -> None:
        with self.assertRaises(KernelBridgeUnavailable):
            KernelBridge()
        for changes in ({"library_path": Path("relative.so")}, {"library_sha256": ""}, {"build_id": "bad id"}, {"contract_source_sha256": "A" * 64}):
            with self.assertRaises(KernelBridgeUnavailable):
                replace(config(), **changes)

    def test_bundle_pin_rejected_before_native_loader(self) -> None:
        with patch.object(implementation.sys, "platform", "linux"), patch.object(implementation.sys, "version_info", (3, 12, 11)), patch.object(implementation, "_load_image") as loader:
            with self.assertRaisesRegex(KernelBridgeUnavailable, "bundle-sha256"):
                KernelBridge.load(config=config(), contract_bundle=b"tampered")
            loader.assert_not_called()

    def test_exact_build_identity_and_authority_are_required(self) -> None:
        with self.assertRaisesRegex(KernelBridgeUnavailable, "build-identity"):
            load_fake(FakeNative(), identity=b"{}")
        native = FakeNative()
        native.authority_status = 4
        with self.assertRaisesRegex(KernelBridgeUnavailable, "authority-unavailable"):
            load_fake(native)

    def test_sync_is_exact_bytes_and_closed_means_unavailable(self) -> None:
        native = FakeNative()
        bridge = load_fake(native)
        self.assertEqual(bridge.evaluate_json(b"not rewritten"), RESPONSE)
        self.assertEqual(native.commands, [b"not rewritten"])
        bridge.close()
        bridge.close()
        with self.assertRaisesRegex(KernelBridgeUnavailable, "closed"):
            bridge.evaluate_json(b"{}")

    def test_input_bound_and_mutable_input_rejected_without_native_call(self) -> None:
        native = FakeNative()
        bridge = load_fake(native)
        for command in (bytearray(b"{}"), "{}", b"x" * (implementation.MAX_INPUT_BYTES + 1)):
            with self.assertRaisesRegex(KernelBridgeError, "command-bound"):
                bridge.evaluate_json(command)
        self.assertEqual(native.commands, [])
        bridge.close()

    def test_status_and_bad_lengths_are_not_success(self) -> None:
        native = FakeNative()
        bridge = load_fake(native)
        for status in (1, 2, 3, 4, 5, 6, 7, 999):
            native.status = status
            with self.assertRaises(KernelBridgeError):
                bridge.evaluate_json(b"{}")
        native.status = 0
        native.invalid_length = True
        with self.assertRaisesRegex(KernelBridgeError, "response-length"):
            bridge.evaluate_json(b"{}")
        bridge.close()

    def test_image_mismatch_never_calls_dlopen(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "synthetic.so"
            image.write_bytes(b"not-an-elf")
            selected = replace(config(), library_path=image)
            with patch.object(implementation.ctypes, "CDLL") as loader:
                with self.assertRaisesRegex(KernelBridgeUnavailable, "library-sha256"):
                    implementation._load_image(selected)
                loader.assert_not_called()

    def test_symlink_and_nonregular_library_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "synthetic.so"
            source.write_bytes(b"not-an-elf")
            link = Path(directory) / "link.so"
            link.symlink_to(source)
            for target in (link, Path(directory)):
                with self.assertRaises(KernelBridgeUnavailable):
                    implementation._sealed_image(replace(config(), library_path=target))


class AsyncBridgeRegression(unittest.IsolatedAsyncioTestCase):
    async def test_per_call_response_bound_and_no_implicit_retry(self) -> None:
        native = FakeNative()
        bridge = load_fake(native)
        for capacity in (0, -1, True, implementation.MAX_OUTPUT_BYTES + 1):
            with self.assertRaisesRegex(KernelBridgeError, "response-bound"):
                await bridge.evaluate(b"{}", maximum_response_bytes=capacity)
        self.assertEqual(native.commands, [])
        with self.assertRaisesRegex(KernelBridgeError, "native-response-bound"):
            await bridge.evaluate(b"{}", maximum_response_bytes=2)
        self.assertEqual(native.capacities, [2])
        self.assertEqual(await bridge.evaluate(b"{}", maximum_response_bytes=len(RESPONSE)), RESPONSE)
        bridge.close()

    async def test_cancellation_does_not_release_running_native_slot(self) -> None:
        native = FakeNative()
        native.block = True
        bridge = load_fake(native)
        pending = asyncio.create_task(bridge.evaluate(b"{}"))
        try:
            self.assertTrue(await asyncio.to_thread(native.entered.wait, 3))
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            with self.assertRaisesRegex(KernelBridgeError, "busy"):
                bridge.evaluate_json(b"{}")
            with self.assertRaisesRegex(KernelBridgeError, "busy"):
                bridge.close()
        finally:
            native.release.set()
            acquired = await asyncio.to_thread(bridge._gate.acquire, True, 3)
            if acquired:
                bridge._gate.release()
            self.assertTrue(acquired)
            bridge.close()
