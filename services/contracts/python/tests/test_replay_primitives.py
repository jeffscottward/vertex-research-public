"""Source-authored finite replay primitive regressions; execution is deferred."""

import base64
import unittest

from vertex_contracts import ContractError, ContractUnavailable
from vertex_contracts.binary import MAX_REPLAY_BLOB_BYTES, decode_canonical_base64
from vertex_contracts.semantics import SemanticPrograms


class CanonicalReplayBinaryCases(unittest.TestCase):
    def test_canonical_bytes_preserved_and_pad_aliases_reject(self):
        for data in (b"a", b"ab", b"abc", bytes(range(256))):
            text = base64.b64encode(data).decode("ascii")
            self.assertEqual(decode_canonical_base64(text), data)
        for text in ("", "AB==", "AAB=", "YQ", "YQ===", "Y Q==", "YQ==\n", "YWJj-___", "é==="):
            with self.subTest(text=text), self.assertRaises(ContractError):
                decode_canonical_base64(text)

    def test_actual_per_blob_limit_is_distinct_from_string_budget(self):
        allowed = b"x" * MAX_REPLAY_BLOB_BYTES
        self.assertEqual(decode_canonical_base64(base64.b64encode(allowed).decode("ascii")), allowed)
        oversized = base64.b64encode(allowed + b"x").decode("ascii")
        with self.assertRaises(ContractError):
            decode_canonical_base64(oversized)


class IndexedReplayProgramCases(unittest.TestCase):
    def test_sum_at_index_use_lexical_iteration_and_original_order(self):
        program = ["and", ["eq", ["sum", ["get", "rows"], ["base64Length", ["get", "body"]]], 3],
                   ["every", ["get", "rows"], ["eq", ["get", "id"], ["call", "ReadId", ["at", ["root", "identities"], ["index"]]]]]]
        rules = SemanticPrograms({"Fixture": program, "ReadId": ["get", "id"]})
        good = {"rows": [{"id": "a", "body": "YQ=="}, {"id": "b", "body": "YmM="}],
                "identities": [{"id": "a"}, {"id": "b"}]}
        rules.validate("Fixture", good)
        good["identities"].reverse()
        with self.assertRaises(ContractError):
            rules.validate("Fixture", good)

    def test_empty_sum_zero_and_indices_cannot_escape_rule_scope(self):
        SemanticPrograms({"Empty": ["eq", ["sum", ["get", ""], 1], 0]}).validate("Empty", [])
        with self.assertRaises(ContractUnavailable):
            SemanticPrograms({"Bad": ["index"]})
        with self.assertRaises(ContractUnavailable):
            SemanticPrograms({"Outer": ["every", ["get", ""], ["call", "Inner", ["get", ""]]], "Inner": ["eq", ["index"], 0]})

    def test_at_rejects_negative_noninteger_and_out_of_range(self):
        for index in (-1, 1, True, "0"):
            rules = SemanticPrograms({"Bad": ["eq", ["at", ["get", ""], index], 0]})
            with self.subTest(index=index), self.assertRaises(ContractError):
                rules.validate("Bad", [0])

    def test_parent_and_inner_index_are_scoped_independently(self):
        rules = SemanticPrograms({"Nested": ["every", ["get", ""],
                    ["every", ["get", "values"],
                     ["eq", ["get", ""], ["at", ["parent", "values"], ["index"]]]]]})
        rules.validate("Nested", [{"values": [2, 7]}, {"values": [3]}])


if __name__ == "__main__":
    unittest.main()
