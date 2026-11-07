"""The frozen host script that called IBKR placeOrder directly is disabled.

The frozen host transmit script (sha256 a12a52da...) built
its own TWS API client and called ``client.placeOrder``, bypassing the owner
arm gate and the options-only order policy in ``nautilus/arm_gate.py``. The
owned replacement refuses every invocation and never connects to IBKR. Since
card move-close-off-charan-scripts it lives at ``scripts/position_close.py``
(portfolio-ui's close button runs it); its stderr and exit code are pinned to the
refusal of the previous path, so the close button behaves identically.
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
SCRIPT = HERE / "runtime" / "scripts" / "position_close.py"
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

    def test_refusal_is_identical_to_the_previous_close_script(self) -> None:
        # stderr sha256 and exit code of the owned refusal at its previous path (commit 7d7c2d69).
        result = subprocess.run([sys.executable, "-B", "-I", str(SCRIPT), *LIVE_ARGS],
                                capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(hashlib.sha256(result.stderr.encode()).hexdigest(),
                         "2bc9f7f26401a811d88ef0325c08c7fd5c8fcbe416b76259070bb46db18ba010")

    def test_portfolio_ui_close_runs_this_script(self) -> None:
        server = (HERE / "runtime" / "portfolio-ui" / "server.mjs").read_text(encoding="utf-8")
        self.assertIn('path.join(repoRoot, "scripts", "position_close.py")', server)
        self.assertNotIn("charan", server.lower())

    def test_replaces_the_frozen_script(self) -> None:
        self.assertNotEqual(hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), FROZEN_SHA256)
        self.assertIn(FROZEN_SHA256, SCRIPT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
