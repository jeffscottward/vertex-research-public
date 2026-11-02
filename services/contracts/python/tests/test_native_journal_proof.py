"""Synthetic wrapper regression source; actual source semantics use generated fixtures."""

import unittest

from vertex_contracts import ContractError, ContractUnavailable, rawSHA256
from vertex_contracts.codec import canonical_encode
from test_authority import authority, rebind_programs, synthetic_bundle


def synthetic_proof_authority(*, binding=True):
    document = synthetic_bundle()
    for name in ("NativeFactProjection", "NativeJournalProof"):
        document["schemas"][name] = {"type": "object"}
        document["contractRules"][name] = name
        document["programs"][name] = True
    if binding:
        document["programs"]["NativeJournalProofBinding"] = ["eq", ["get", "projection.fact"], ["get", "proof.payload"]]
    return authority(rebind_programs(document))


class NativeJournalProofWrapperCases(unittest.TestCase):
    def test_original_canonical_bytes_and_private_binding_are_required(self):
        codec = synthetic_proof_authority()
        proof = canonical_encode({"payload": {"kind": "synthetic-fixture"}})
        projection = {"proof": {"sha256": rawSHA256(proof)}, "fact": {"kind": "synthetic-fixture"}}
        self.assertIs(codec.validate_native_journal_proof(projection, proof), True)
        self.assertIs(codec.validate_native_journal_proof(codec.encode(projection), proof), True)
        projection["fact"]["kind"] = "changed"
        with self.assertRaises(ContractError):
            codec.validate_native_journal_proof(projection, proof)

    def test_raw_hash_is_over_original_bytes_not_decoded_string(self):
        codec = synthetic_proof_authority()
        proof = canonical_encode({"payload": {}})
        projection = {"proof": {"sha256": codec.digest(proof.decode())}, "fact": {}}
        with self.assertRaises(ContractError):
            codec.validate_native_journal_proof(projection, proof)

    def test_noncanonical_duplicate_proof_rejects_even_with_matching_raw_hash(self):
        codec = synthetic_proof_authority()
        proof = b'{"payload":{},"payload":{}}'
        projection = {"proof": {"sha256": rawSHA256(proof)}, "fact": {}}
        with self.assertRaises(ContractError):
            codec.validate_native_journal_proof(projection, proof)

    def test_standalone_proof_validation_is_not_paired_binding(self):
        codec = synthetic_proof_authority(binding=False)
        proof = canonical_encode({"payload": {}})
        projection = {"proof": {"sha256": rawSHA256(proof)}, "fact": {}}
        self.assertIs(codec.validate("NativeJournalProof", proof), True)
        with self.assertRaises(ContractUnavailable):
            codec.validate_native_journal_proof(projection, proof)

    def test_byte_limit_rejects_before_projection_processing(self):
        codec = synthetic_proof_authority()
        for proof in (b"", b"x" * (1_048_576 + 1), "not-bytes", bytearray(b"{}")):
            with self.subTest(kind=type(proof)), self.assertRaises(ContractError):
                codec.validate_native_journal_proof(object(), proof)


if __name__ == "__main__":
    unittest.main()
