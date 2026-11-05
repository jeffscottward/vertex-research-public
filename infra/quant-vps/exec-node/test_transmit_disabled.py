"""The frozen host script that called IBKR placeOrder directly is disabled.

``scripts/transmit_charan_approved_drafts.py`` (frozen sha256 a12a52da...) built
its own TWS API client and called ``client.placeOrder``, bypassing the owner
arm gate and the options-only order policy in ``nautilus/arm_gate.py``. The
owned replacement refuses every invocation and never connects to IBKR.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import io
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "runtime" / "scripts" / "transmit_charan_approved_drafts.py"
FROZEN_SHA256 = "a12a52dae6828e8c770f085289119c65fbadbba701b75e1e0f3466502d53bead"
# The arguments portfolio-ui's close button passes (server.mjs), plus the flags
# the frozen script required for a live transmit.
LIVE_ARGS = [
    "/tmp/approval.json",
    "--account-snapshot",
    "/tmp/snapshot.json",
    "--env-file",
    "/tmp/.env",
    "--operator",
    "portfolio-ui",
    "--enable-live-transmit",
    "--i-understand-this-places-real-orders",
    "--extra-approved-source",
    "VERTEX_UI",
    "--client-id",
    "52",
]


def load_script():
    sys.dont_write_bytecode = True  # no __pycache__ under runtime/ (test_exec_node.py lists it)
    spec = importlib.util.spec_from_file_location("transmit_disabled", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TransmitScriptDisabledTest(unittest.TestCase):
    def test_every_invocation_is_refused_with_a_clear_message(self) -> None:
        for args in ([], ["--help"], ["--preflight-only"], LIVE_ARGS):
            with self.subTest(args=args[:2]):
                result = subprocess.run(
                    [sys.executable, "-B", "-I", str(SCRIPT), *args],
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("is disabled", result.stderr)
                self.assertIn("No order was sent", result.stderr)
                self.assertIn("arm_gate.py", result.stderr)

    def test_main_returns_the_disabled_code(self) -> None:
        module = load_script()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(module.main(LIVE_ARGS), module.EXIT_DISABLED)
        self.assertEqual(module.EXIT_DISABLED, 2)
        self.assertIn(module.REFUSAL, stderr.getvalue())

    def test_script_cannot_reach_a_broker(self) -> None:
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"__future__", "sys"})
        called = {
            node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
        }
        for name in ("placeOrder", "connect", "run", "reqIds", "cancelOrder"):
            self.assertNotIn(name, called)

    def test_replaces_the_frozen_script(self) -> None:
        self.assertNotEqual(hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), FROZEN_SHA256)
        self.assertIn(FROZEN_SHA256, SCRIPT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
