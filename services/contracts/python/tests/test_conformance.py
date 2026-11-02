"""Deferred runner tests use synthetic engine fixtures, not public schema copies."""

import unittest

from vertex_contracts import ContractError, rawSHA256
from vertex_contracts.codec import canonical_encode
from vertex_contracts.conformance import run_conformance
from test_authority import synthetic_bundle


def synthetic_fixtures():
    return {
        "fixtureFormat": "vertex-native-contract-fixtures-v1",
        "schemaVersion": "1.0.0",
        "cases": [
            {"name": "empty", "contract": "Fixture", "payload": {}, "valid": True},
            {"name": "extra-field", "contract": "Fixture", "payload": {"unexpected": True}, "valid": False},
        ],
        "rawByteReject": [{"name": "invalid-utf8", "hex": "22c32822"}],
        "codec": [{"name": "empty", "value": {}, "canonicalUtf8": "{}", "sha256": rawSHA256(b"{}")}],
        "timestamps": [
            {"timestamp": "1969-12-31T23:59:59.999999999Z", "epochNanoseconds": "-1"},
            {"timestamp": "1900-02-29T00:00:00Z", "epochNanoseconds": None},
        ],
    }


class DeferredConformanceCases(unittest.TestCase):
    def test_explicit_pinned_inputs_and_true_only_validation(self):
        bundle = canonical_encode(synthetic_bundle())
        fixtures = canonical_encode(synthetic_fixtures())
        result = run_conformance(bundle, rawSHA256(bundle), fixtures, rawSHA256(fixtures))
        self.assertEqual(result["attempted"], 6)
        self.assertEqual(result["passed"], 6)
        self.assertEqual(result["failed"], [])
        self.assertIs(result["executionAuthorized"], False)

    def test_wrong_fixture_digest_rejects_without_discovery(self):
        bundle = canonical_encode(synthetic_bundle())
        fixtures = canonical_encode(synthetic_fixtures())
        with self.assertRaises(ContractError):
            run_conformance(bundle, rawSHA256(bundle), fixtures, "0" * 64)

    def test_mismatch_is_not_reported_as_pass(self):
        bundle = canonical_encode(synthetic_bundle())
        document = synthetic_fixtures()
        document["timestamps"][0]["epochNanoseconds"] = "0"
        fixtures = canonical_encode(document)
        result = run_conformance(bundle, rawSHA256(bundle), fixtures, rawSHA256(fixtures))
        self.assertEqual(result["failed"], ["timestamp:0"])
        self.assertEqual(result["passed"], 5)


if __name__ == "__main__":
    unittest.main()
