"""Source-authored regressions for required WHATWG support; not executed."""

import unittest
from unittest.mock import patch

from vertex_contracts import ContractUnavailable
from vertex_contracts.whatwg import public_https, require_whatwg_backend


class WhatwgAvailabilityCases(unittest.TestCase):
    def setUp(self):
        require_whatwg_backend.cache_clear()

    def tearDown(self):
        require_whatwg_backend.cache_clear()

    def test_wrong_backend_version_fails_closed_without_import(self):
        with patch("vertex_contracts.whatwg.metadata.version", return_value="3.0.0"), patch("vertex_contracts.whatwg.import_module") as imported:
            with self.assertRaises(ContractUnavailable):
                require_whatwg_backend()
            imported.assert_not_called()

    def test_missing_native_library_never_falls_back_to_urllib(self):
        with patch("vertex_contracts.whatwg.metadata.version", return_value="4.0.0"), patch("vertex_contracts.whatwg.import_module", side_effect=OSError("native backend unavailable")):
            with self.assertRaises(ContractUnavailable):
                require_whatwg_backend()

    def test_missing_component_api_is_unavailable(self):
        with patch("vertex_contracts.whatwg.metadata.version", return_value="4.0.0"), patch("vertex_contracts.whatwg.import_module", return_value=object()):
            with self.assertRaises(ContractUnavailable):
                require_whatwg_backend()

    def test_utf16_budget_precedes_backend_parsing(self):
        value = "https://example.com/" + "\U0001f600" * 1100
        with patch("vertex_contracts.whatwg.require_whatwg_backend") as backend:
            self.assertFalse(public_https(value))
            backend.assert_not_called()

    def test_real_backend_keeps_valid_idna_and_recovery_forms(self):
        for value in ["https://Bücher.example/", "https://xn--bcher-kva.example/",
                      "https://%65xample.com/", "https:example.com", "https://127.1/",
                      "\tHTTPS://example.com/\r\n", "https://example.com/?#"]:
            self.assertTrue(public_https(value), value)


if __name__ == "__main__":
    unittest.main()
