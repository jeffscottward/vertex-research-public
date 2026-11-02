"""Adapter orchestration tests; production schemas remain source-generated."""

import base64
import unittest
from unittest.mock import patch

from vertex_contracts import ContractError, rawSHA256
from vertex_contracts.codec import canonical_encode
from vertex_contracts.replay import validate_replay_artifacts


def encoded(value):
    raw = canonical_encode(value)
    return raw, base64.b64encode(raw).decode("ascii")


class RecordingRules:
    def __init__(self):
        self.rows = []
        self.transitions = []

    def validate(self, name, value):
        if name == "NativeReplayRowBinding":
            self.rows.append(value)
        elif name == "NativeReplayRetainedTransitionBinding":
            self.transitions.append(value)
        else:
            raise AssertionError("Unexpected private rule")


class RecordingAuthority:
    def __init__(self):
        self._programs = RecordingRules()
        self.contracts = []
        self.proofs = []

    def encode(self, value):
        return canonical_encode(value)

    def validate(self, name, raw, version):
        self.contracts.append((name, raw, version))
        return True

    def validate_native_journal_proof(self, projection, proof, version):
        self.proofs.append((projection, proof, version))
        return True


class ReplayAdapterCases(unittest.TestCase):
    def fixture(self):
        kinds = ["portfolio-genesis", "portfolio-snapshot", "order", "native-fact"]
        rows, identities = [], []
        for index, kind in enumerate(kinds):
            raw, text = encoded({"synthetic": index})
            proof, proof_text = encoded({"syntheticProof": index})
            identities.append({"kind": kind, "eventHash": str(index), "projectionRawSha256": rawSHA256(raw),
                               "proofSha256": rawSHA256(proof) if kind == "native-fact" else None})
            rows.append({"kind": kind, "projectionBase64": text,
                         "proofBase64": proof_text if kind == "native-fact" else None})
        return {"grant": {"approvalBase64": "YQ==", "startingEventHash": None, "rows": identities,
                          "retainedEpochTransitionSha256": None},
                "retainedEpochTransitionBase64": None, "rows": rows}

    def test_only_fixed_source_contracts_and_snapshot_does_not_advance(self):
        authority = RecordingAuthority()
        replay = self.fixture()
        validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual([item[0] for item in authority.contracts],
                         ["PortfolioGenesis", "PortfolioSnapshot", "ExecutionProjection", "NativeFactProjection"])
        self.assertEqual([item["priorHash"] for item in authority._programs.rows], [None, "0", "0", "2"])
        self.assertEqual(len(authority.proofs), 1)
        for row in authority._programs.rows:
            self.assertEqual(set(row), {"grant", "identity", "value", "priorHash"})

    def test_raw_projection_mismatch_fails_before_nested_validation(self):
        authority = RecordingAuthority()
        replay = self.fixture()
        replay["grant"]["rows"][0]["projectionRawSha256"] = "0" * 64
        with self.assertRaises(ContractError):
            validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual(authority.contracts, [])

    def test_noncanonical_original_bytes_reject_even_when_raw_hash_matches(self):
        authority = RecordingAuthority()
        replay = self.fixture()
        raw = b'{"x":1,"x":1}'
        replay["grant"]["rows"][0]["projectionRawSha256"] = rawSHA256(raw)
        replay["rows"][0]["projectionBase64"] = base64.b64encode(raw).decode("ascii")
        with self.assertRaises(ContractError):
            validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual(authority.contracts, [])

    def test_fact_proof_raw_hash_is_independent_of_projection_event_hash(self):
        authority = RecordingAuthority()
        replay = self.fixture()
        replay["grant"]["rows"][-1]["proofSha256"] = "0" * 64
        with self.assertRaises(ContractError):
            validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual(authority.proofs, [])

    def retained_fixture(self):
        replay = self.fixture()
        raw, text = encoded({"snapshot": {"synthetic": 0}, "historicalTransition": "1-to-2"})
        replay["retainedEpochTransitionBase64"] = text
        replay["grant"]["retainedEpochTransitionSha256"] = rawSHA256(raw)
        return replay

    def test_retained_original_transition_validates_before_replay_rows(self):
        authority = RecordingAuthority()
        validate_replay_artifacts(authority, self.retained_fixture(), "1.0.0")
        self.assertEqual(authority.contracts[0][0], "PortfolioEpochTransition")
        self.assertEqual(authority.contracts[1][0], "PortfolioGenesis")
        self.assertEqual(set(authority._programs.transitions[0]), {"grant", "transition"})
        self.assertEqual(authority._programs.rows[0]["priorHash"], None)

    def test_retained_raw_hash_mismatch_rejects_before_child_validation(self):
        authority = RecordingAuthority()
        replay = self.retained_fixture()
        replay["grant"]["retainedEpochTransitionSha256"] = "0" * 64
        with self.assertRaises(ContractError):
            validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual(authority.contracts, [])

    def test_retained_original_noncanonical_bytes_cannot_be_reencoded_to_accept(self):
        authority = RecordingAuthority()
        replay = self.retained_fixture()
        raw = b'{"snapshot": {"synthetic":0}}'
        replay["retainedEpochTransitionBase64"] = base64.b64encode(raw).decode("ascii")
        replay["grant"]["retainedEpochTransitionSha256"] = rawSHA256(raw)
        with self.assertRaises(ContractError):
            validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual(authority.contracts, [])

    def test_retained_snapshot_requires_exact_original_first_projection_bytes(self):
        authority = RecordingAuthority()
        replay = self.retained_fixture()
        raw, text = encoded({"synthetic": 9})
        replay["rows"][0]["projectionBase64"] = text
        replay["grant"]["rows"][0]["projectionRawSha256"] = rawSHA256(raw)
        with self.assertRaises(ContractError):
            validate_replay_artifacts(authority, replay, "1.0.0")
        self.assertEqual([item[0] for item in authority.contracts], ["PortfolioEpochTransition"])

    def test_retained_pair_nullity_is_not_an_optional_missing_binding(self):
        for field in ("retainedEpochTransitionBase64", "retainedEpochTransitionSha256"):
            replay = self.retained_fixture()
            owner = replay["grant"] if field.endswith("Sha256") else replay
            owner[field] = None
            with self.subTest(field=field), self.assertRaises(ContractError):
                validate_replay_artifacts(RecordingAuthority(), replay, "1.0.0")

    def test_retained_bytes_are_charged_inside_existing_aggregate_limit(self):
        replay = self.retained_fixture()
        texts = [replay["grant"]["approvalBase64"], replay["retainedEpochTransitionBase64"]]
        for row in replay["rows"]:
            texts.append(row["projectionBase64"])
            if row["proofBase64"] is not None:
                texts.append(row["proofBase64"])
        total = sum(len(base64.b64decode(text)) for text in texts)
        # Scale only the unit-test guard; shared source capacity fixtures retain
        # the real 8MiB boundary and do not use synthetic contract acceptance.
        with patch("vertex_contracts.replay.MAX_REPLAY_DECODED_BYTES", total):
            validate_replay_artifacts(RecordingAuthority(), replay, "1.0.0")
        with patch("vertex_contracts.replay.MAX_REPLAY_DECODED_BYTES", total - 1):
            with self.assertRaises(ContractError):
                validate_replay_artifacts(RecordingAuthority(), replay, "1.0.0")


if __name__ == "__main__":
    unittest.main()
