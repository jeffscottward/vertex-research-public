"""Synthetic engine tests, not replacement schemas for production contracts.

Production interoperability fixtures are generated from the authoritative Civet
registries in the deferred generation/conformance stage, never by these tests.
"""

import copy
from pathlib import Path
import re
import unittest

from vertex_contracts import ContractAuthority, ContractError, ContractUnavailable, rawSHA256
from vertex_contracts import authority as authority_module
from vertex_contracts.codec import canonical_encode
from vertex_contracts.schema import public_https


SOURCE_PATHS = ["packages/api/src/contracts/vertex.ts",
                "packages/api/src/contracts/vertex-control.ts",
                "packages/api/src/contracts/vertex-native-facts.ts",
                "packages/api/src/contracts/vertex-worker.ts",
                "packages/api/src/contracts/vertex-worker-experiment.ts",
                "packages/api/src/contracts/vertex-model-privacy-rendezvous.ts",
                "packages/api/src/contracts/vertex-policy.ts",
                "packages/api/src/contracts/vertex-model-use.ts",
                "packages/api/src/contracts/vertex-worker-epoch.ts",
                "packages/shared/src/vertex/index.ts",
                "scripts/vertex-native-contracts/invariants-v1.json"]


def synthetic_bundle(program=True, schema=None):
    sources = {path: "0" * 64 for path in SOURCE_PATHS}
    programs = {"Fixture": program}
    return {"bundleFormat": "vertex-native-contract-bundle-v1", "schemaVersion": "1.0.0",
            "hashProfile": "gamma-json-utf8-safe-integer-v1", "semanticProfile": "vertex-invariants-v1",
            "sources": sources, "schemas": {"Fixture": schema if schema is not None else {"type": "object", "properties": {}, "additionalProperties": False}},
            "programs": programs, "contractRules": {"Fixture": "Fixture"},
            "programDigest": rawSHA256(canonical_encode(programs)), "sourceDigest": rawSHA256(canonical_encode(sources))}


def authority(document):
    data = canonical_encode(document)
    return ContractAuthority(data, rawSHA256(data))


def rebind_programs(document):
    document["programDigest"] = rawSHA256(canonical_encode(document["programs"]))
    return document


class AuthorityBoundaryCases(unittest.TestCase):
    def test_source_bindings_match_the_bundle_generator(self):
        generator = Path(__file__).resolve().parents[4] / "scripts/vertex-native-contracts/generate.ts"
        block = re.search(r"AUTHORITATIVE_SOURCE_PATHS = \[(.*?)\] as const", generator.read_text(), re.S)
        self.assertIsNotNone(block)
        generated = set(re.findall(r'"([^"]+)"', block.group(1))) | {"scripts/vertex-native-contracts/invariants-v1.json"}
        self.assertEqual(set(authority_module._SOURCE_FILES), generated)
        self.assertEqual(set(SOURCE_PATHS), generated)

    def test_validate_is_true_only_and_never_authorizes(self):
        codec = authority(synthetic_bundle())
        self.assertIs(codec.validate("Fixture", {}), True)
        with self.assertRaises(ContractError):
            codec.validate("Fixture", {"executionAuthorized": True})
        with self.assertRaises(ContractUnavailable):
            codec.validate("Missing", {})
        with self.assertRaises(ContractUnavailable):
            codec.validate("Fixture", {}, "2.0.0")
        with self.assertRaises(ContractError):
            codec.digest(b"original bytes")
        self.assertNotEqual(codec.digest("x"), rawSHA256(b"x"))

    def test_bundle_and_component_hash_binding(self):
        document = synthetic_bundle()
        encoded = canonical_encode(document)
        with self.assertRaises(ContractUnavailable):
            ContractAuthority(encoded, "f" * 64)
        for field in ["sourceDigest", "programDigest"]:
            changed = copy.deepcopy(document)
            changed[field] = "f" * 64
            with self.subTest(field=field), self.assertRaises(ContractUnavailable):
                authority(changed)
        with self.assertRaises(ContractUnavailable):
            ContractAuthority(encoded + b"\n", rawSHA256(encoded + b"\n"))

    def test_unsupported_metadata_and_structural_keywords_fail_closed(self):
        mutations = [lambda d: d.update(semanticProfile="unknown"),
                     lambda d: d["contractRules"].clear(),
                     lambda d: d["schemas"]["Fixture"].update(unevaluatedProperties=False),
                     lambda d: d["schemas"]["Fixture"].update(format="email"),
                     lambda d: d["schemas"]["Fixture"].update(pattern="^(a+)+$"),
                     lambda d: d["programs"].update(Fixture=["parent", ""]),
                     lambda d: d["programs"].update(Fixture=["exec", "anything"]),
                     lambda d: d["programs"].update(Fixture=["call", "missing", ["get", ""]]),
                     lambda d: d["programs"].update(Fixture=["call", "Fixture", ["get", ""]])]
        for mutation in mutations:
            document = synthetic_bundle()
            mutation(document)
            rebind_programs(document)
            with self.assertRaises(ContractUnavailable):
                authority(document)

    def test_new_source_patterns_remain_exact_and_bounded(self):
        for pattern in (r"^[1-9][0-9]{0,29}$", r"^[1-9]\d{0,29}$"):
            codec = authority(synthetic_bundle(schema={"type": "string", "pattern": pattern}))
            self.assertIs(codec.validate("Fixture", "9" * 30), True)
            for value in ("0", "01", "9" * 31, "\u0661"):
                with self.subTest(pattern=pattern, value=value), self.assertRaises(ContractError):
                    codec.validate("Fixture", value)
        alias = authority(synthetic_bundle(schema={"type": "string", "pattern": r"^[A-Z][A-Z0-9_]{0,127}$"}))
        self.assertIs(alias.validate("Fixture", "MODEL_2"), True)
        with self.assertRaises(ContractError):
            alias.validate("Fixture", "model_2")
        binary = authority(synthetic_bundle(schema={
            "type": "string", "maxLength": 1_398_104,
            "pattern": r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        }))
        self.assertIs(binary.validate("Fixture", "A" * 1_398_100 + "AA=="), True)
        # Source structural regex deliberately does not validate pad bits or
        # content hashes; the worker service/client owns those separate checks.
        self.assertIs(binary.validate("Fixture", "AB=="), True)
        for value in ("A===", "A" * 1_398_108):
            with self.subTest(valueLength=len(value)), self.assertRaises(ContractError):
                binary.validate("Fixture", value)

    def test_duplicate_and_noncanonical_bytes_never_reach_schema(self):
        codec = authority(synthetic_bundle(schema={"type": "object"}))
        for data in [b'{"a":1,"a":1}', b'{"b":1,"a":2}', b" {}", b'{"x":-0}']:
            with self.subTest(data=data), self.assertRaises(ContractError):
                codec.validate("Fixture", data)

    def test_relational_parent_and_call_reset(self):
        program = ["every", ["get", "rows"], ["some", ["root", "canonical"],
                   ["and", ["eq", ["get", "id"], ["parent", "id"]],
                    ["eq", ["get", "hash"], ["parent", "hash"]]]]]
        codec = authority(synthetic_bundle(program=program, schema={"type": "object"}))
        value = {"rows": [{"id": "one", "hash": "a"}], "canonical": [{"id": "one", "hash": "a"}]}
        self.assertIs(codec.validate("Fixture", value), True)
        value["canonical"][0]["hash"] = "b"
        with self.assertRaises(ContractError):
            codec.validate("Fixture", value)

    def test_decimal_tick_and_exact_nanosecond_comparison(self):
        program = ["and", ["eq", ["mod", ["decimal", ["get", "price"]], ["decimal", ["get", "tick"]]], 0],
                   ["eq", ["sub", ["epoch", ["get", "end"]], ["epoch", ["get", "start"]]], 1]]
        codec = authority(synthetic_bundle(program=program, schema={"type": "object"}))
        value = {"price": "0.3", "tick": "0.1", "start": "1969-12-31T23:59:59.999999999Z", "end": "1970-01-01T00:00:00Z"}
        self.assertIs(codec.validate("Fixture", value), True)
        value["price"] = "0.31"
        with self.assertRaises(ContractError):
            codec.validate("Fixture", value)

    def test_projection_hash_includes_stable_received_at(self):
        program = ["eq", ["get", "eventHash"], ["hashOmit", ["get", ""], ["lit", ["eventHash"]]]]
        codec = authority(synthetic_bundle(program=program, schema={"type": "object"}))
        payload = {"receivedAt": "2026-09-22T00:00:00.000000001Z", "sequence": "1"}
        payload["eventHash"] = codec.digest(payload)
        self.assertIs(codec.validate("Fixture", payload), True)
        payload["receivedAt"] = "2026-09-22T00:00:00.000000002Z"
        with self.assertRaises(ContractError):
            codec.validate("Fixture", payload)

    def test_genesis_nested_hash_omits_only_two_identity_fields(self):
        paths = ["sourceEventHash", "continuity.highWaterEventHash"]
        program = ["eq", ["get", "sourceEventHash"], ["hashOmitPaths", ["get", ""], ["lit", paths]]]
        codec = authority(synthetic_bundle(program=program, schema={"type": "object"}))
        body = {"sequence": "1", "cash": "25", "continuity": {"highWaterSequence": "1"}}
        digest = codec.digest(body)
        value = {**body, "sourceEventHash": digest, "continuity": {**body["continuity"], "highWaterEventHash": digest}}
        before = copy.deepcopy(value)
        self.assertIs(codec.validate("Fixture", value), True)
        self.assertEqual(value, before)
        value["cash"] = "26"
        with self.assertRaises(ContractError):
            codec.validate("Fixture", value)
        for invalid in [["continuity", "continuity.highWaterEventHash"], ["sourceEventHash", "sourceEventHash"], ["missing"]]:
            malformed = ["eq", ["get", "sourceEventHash"], ["hashOmitPaths", ["get", ""], ["lit", invalid]]]
            with self.assertRaises(ContractUnavailable):
                authority(synthetic_bundle(program=malformed, schema={"type": "object"}))

    def test_uri_matches_whatwg_recovery_and_empty_component_semantics(self):
        for value in ["https://example.com/paper", "HTTPS://EXAMPLE.com:443/path",
                      "https://éxample.com/", "https://xn--bcher-kva.example/",
                      "https://%65xample.com/", "https://%31%32%37.0.0.1/",
                      "https://127.1/", "https://0x7f000001/", "https://[::1]/",
                      "https://[::ffff:192.0.2.1]/", "https:example.com",
                      "https://@example.com/", "https://:@example.com/",
                      "https://example.com/?", "https://example.com/#",
                      "https://example.com/?#", "https://example.com:/",
                      " https://example.com/\\n", "https://example.com/\\p"]:
            self.assertTrue(public_https(value), value)
        for value in ["http://example.com", "https://u:p@example.com/",
                      "https://u@example.com/", "https://:p@example.com/",
                      "https://example.com/?q=1", "https://example.com/#f",
                      "https://evil%zz/", "https://a.123/", "https://[::1%zone]/",
                      "https://example.com:65536/", "https://", "not-a-url"]:
            self.assertFalse(public_https(value), value)


if __name__ == "__main__":
    unittest.main()
