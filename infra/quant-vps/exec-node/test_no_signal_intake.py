"""The exec node has no trade-intent source (owner 2026-11-04, card remove-charan-signals).

Static checks of runtime/nautilus/run_live.py: it must not import the CHARAN signal
module, poll a trade-intent feed or own a live order transmitter. Standard library
only; the file is parsed, never imported or run.
"""

import ast
import re
import unittest
from pathlib import Path

RUN_LIVE = Path(__file__).resolve().parent / "runtime" / "nautilus" / "run_live.py"


class NoSignalIntakeTests(unittest.TestCase):
    source = RUN_LIVE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    def test_no_charan_import(self):
        for node in ast.walk(self.tree):
            if isinstance(node, ast.ImportFrom):
                self.assertNotIn("charan", (node.module or "").lower())
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn("charan", alias.name.lower())

    def test_no_charan_or_signal_reference(self):
        # Only the legacy config key name may remain, so old config files still load.
        self.assertEqual(re.findall(r"(?i)\w*charan\w*", self.source), ["charan"])
        self.assertNotIn("trade_intents", self.source)
        self.assertNotIn("fetch_trade_intents", self.source)

    def test_runner_has_no_intake_or_transmit_methods(self):
        names = {
            node.name
            for node in ast.walk(self.tree)
            if isinstance(node, (ast.FunctionDef, ast.ClassDef))
        }
        for removed in (
            "CharanLiveOrderTransmitter",
            "CharanConfig",
            "poll_charan_trade_intents",
            "process_charan_trade_intents",
            "submit_charan_live_order",
            "process_auth_retry_queue",
        ):
            self.assertNotIn(removed, names)

    def test_legacy_config_section_is_dropped_not_rejected(self):
        self.assertIn("_drop_removed_signal_section", self.source)


if __name__ == "__main__":
    unittest.main()
