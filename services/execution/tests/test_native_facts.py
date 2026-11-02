"""Unexecuted native fact boundary regressions with local authority doubles.

The double is deliberately not a second public schema implementation. Contract
acceptance belongs to the injected native validator and its separate suite.
"""
from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
import json
import unittest

from vertex_execution.native_facts import build_native_fact, build_native_fact_bundle
from vertex_execution.ports import ExecutionError


OCCURRED = 1_700_000_000_123_456_789
RECEIVED = OCCURRED + 17
TTL = 1001
PREVIOUS = "a" * 64
JOURNAL_PREVIOUS = "b" * 64


class LocalAuthority:
    """Records canonical-codec calls and an explicit native validation verdict."""

    def __init__(self, verdict=True):
        self.verdict = verdict
        self.contract_verdicts = {}
        self.hashed = []
        self.validated = []

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        self.hashed.append(deepcopy(value))
        return sha256(self.encode(value)).hexdigest()

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.validated.append((contract_name, deepcopy(payload), schema_version))
        return self.contract_verdicts.get(contract_name, self.verdict)


def inputs():
    return {
        "authority": LocalAuthority(),
        "owned_state": {
            "accountAlias": "paper-account", "environment": "paper",
            "simulatorId": "local-simulator", "ownerEpoch": "4",
            "orders": {}, "cash": "500", "positions": {},
            "pausedNewRisk": True, "reconciled": False,
        },
        "stream_id": "paper-owner-stream",
        "owner_epoch": 4,
        "sequence": 8,
        "previous_event_hash": PREVIOUS,
        "native_emitter_actor_id": "native-paper-owner",
        "policy_version": "1.0.0",
        "occurred_ns": OCCURRED,
        "received_ns": RECEIVED,
        "ttl_ns": TTL,
        "event_id": "native-fact-idempotency:journal-event-40:0",
        "fact_ordinal": 0,
        "journal_event": {
            "sequence": "40", "previousHash": JOURNAL_PREVIOUS,
            "ownerEpoch": "4", "eventId": "journal-event-40",
            "occurredNs": str(OCCURRED), "kind": "pause",
            "data": {"reason": "manual-pause"},
        },
        "fact": {
            "kind": "kill-state", "action": "pause-new-risk",
            "reasonCodes": ["manual-pause"], "grantId": None,
        },
    }


def hash_body(value):
    body = deepcopy(value)
    del body["eventHash"]
    return body


class NativeFactTests(unittest.TestCase):
    def test_native_validation_gets_complete_projection_and_no_shadow_contract(self):
        args = inputs()
        value, proof_bytes = build_native_fact_bundle(**args)
        proof = json.loads(proof_bytes)
        self.assertEqual(args["authority"].validated, [
            ("NativeJournalProof", proof, "1.0.0"),
            ("NativeFactProjection", value, "1.0.0"),
        ])
        self.assertEqual(args["authority"].hashed, [args["journal_event"], proof, hash_body(value)])
        self.assertEqual(value["projectionId"], "native-fact-4-8")
        self.assertEqual(value["sequence"], "8")
        self.assertEqual(value["proofJournalSequence"], "40")
        self.assertNotEqual(value["proofJournalSequence"], value["sequence"])
        self.assertEqual(value["proofJournalHeadHash"], proof["journalHeadHash"])
        self.assertEqual(value["factOrdinal"], 0)
        self.assertEqual(value["factOrdinal"], proof["factOrdinal"])
        self.assertEqual(value["previousEventHash"], PREVIOUS)
        self.assertEqual(value["policyVersion"], args["policy_version"])

    def test_proof_binds_complete_actual_journal_envelope(self):
        args = inputs()
        value, proof_bytes = build_native_fact_bundle(**args)
        proof = json.loads(proof_bytes)
        expected = sha256(proof_bytes).hexdigest()
        journal_digest = sha256(args["authority"].encode(args["journal_event"])).hexdigest()
        self.assertEqual(proof, {
            "schemaVersion": "1.0.0", "proofKind": "native-journal-event",
            "accountAlias": "paper-account", "environment": "paper",
            "streamId": "paper-owner-stream", "ownerEpoch": "4",
            "sourceEventId": "journal-event-40", "journalSequence": "40",
            "journalHeadHash": journal_digest, "occurredAt": value["occurredAt"],
            "factOrdinal": 0,
            "eventType": "kill-state", "payload": args["fact"],
        })
        self.assertEqual(proof_bytes, args["authority"].encode(proof))
        self.assertNotEqual(expected, journal_digest)
        self.assertEqual(value["proof"], {
            "artifactId": "journalproof-" + expected,
            "sha256": expected,
            "sourceEventId": "journal-event-40",
        })
        self.assertLessEqual(len(value["proof"]["artifactId"]), 160)
        self.assertNotEqual(expected, args["authority"].digest(args["journal_event"]["data"]))
        self.assertEqual(value["idempotencyKey"], args["event_id"])
        self.assertNotEqual(value["proof"]["sourceEventId"], value["idempotencyKey"])
        self.assertNotIn("accountAlias", args["journal_event"])

    def test_repeated_build_preserves_first_received_time_and_full_hash(self):
        args = inputs()
        first = build_native_fact(**args)
        retry = build_native_fact(**args)
        self.assertEqual(first, retry)
        self.assertEqual(first["receivedAt"], "2023-11-14T22:13:20.123456806Z")
        self.assertEqual(first["occurredAt"], "2023-11-14T22:13:20.123456789Z")
        self.assertEqual(first["expiresAt"], "2023-11-14T22:13:20.123457807Z")
        self.assertEqual(first["eventHash"], args["authority"].digest(hash_body(first)))

    def test_fresh_receipt_time_is_not_an_equivalent_retry(self):
        args = inputs()
        first = build_native_fact(**args)
        args["received_ns"] += 1
        later = build_native_fact(**args)
        self.assertEqual(first["proof"], later["proof"])
        self.assertNotEqual(first["receivedAt"], later["receivedAt"])
        self.assertNotEqual(first["eventHash"], later["eventHash"])

    def test_key_order_does_not_change_canonical_proof_or_projection(self):
        args = inputs()
        first = build_native_fact(**args)
        args["journal_event"] = dict(reversed(list(args["journal_event"].items())))
        args["fact"] = dict(reversed(list(args["fact"].items())))
        self.assertEqual(first, build_native_fact(**args))

    def test_each_journal_envelope_field_is_bound_by_proof(self):
        first = build_native_fact(**inputs())
        for field, replacement in (
            ("sequence", "41"), ("previousHash", "c" * 64),
            ("ownerEpoch", "5"), ("eventId", "journal-event-41"),
            ("occurredNs", str(OCCURRED + 1)), ("kind", "reconciled"),
            ("data", {"reason": "reconciliation-required"}),
        ):
            with self.subTest(field=field):
                args = inputs()
                args["journal_event"][field] = replacement
                if field == "ownerEpoch":
                    args["owner_epoch"] = 5
                    args["owned_state"]["ownerEpoch"] = "5"
                if field == "occurredNs":
                    args["occurred_ns"] += 1
                changed = build_native_fact(**args)
                self.assertNotEqual(first["proof"]["sha256"], changed["proof"]["sha256"])
                self.assertNotEqual(first["eventHash"], changed["eventHash"])

    def test_hash_covers_every_field_except_itself(self):
        args = inputs()
        value = build_native_fact(**args)
        for field, original in hash_body(value).items():
            with self.subTest(field=field):
                changed = hash_body(value)
                if type(original) is bool:
                    changed[field] = not original
                elif type(original) is dict:
                    changed[field]["altered"] = True
                else:
                    changed[field] = str(original) + "-altered"
                self.assertNotEqual(value["eventHash"], args["authority"].digest(changed))
        altered_self_hash = deepcopy(value)
        altered_self_hash["eventHash"] = "f" * 64
        self.assertEqual(hash_body(altered_self_hash), hash_body(value))

    def test_altered_proof_or_fact_cannot_retain_original_hash(self):
        args = inputs()
        value = build_native_fact(**args)
        for field in ("artifactId", "sha256", "sourceEventId"):
            with self.subTest(field=field):
                forged = deepcopy(value)
                forged["proof"][field] = "altered"
                self.assertNotEqual(forged["eventHash"], args["authority"].digest(hash_body(forged)))
        forged = deepcopy(value)
        forged["fact"]["reasonCodes"].append("altered")
        self.assertNotEqual(forged["eventHash"], args["authority"].digest(hash_body(forged)))

    def test_same_journal_event_can_have_distinct_fact_ordinals(self):
        args = inputs()
        first = build_native_fact(**args)
        args.update(sequence=9, previous_event_hash=first["eventHash"],
                    event_id="native-fact-idempotency:journal-event-40:1", fact_ordinal=1)
        second = build_native_fact(**args)
        self.assertNotEqual(first["proof"], second["proof"])
        self.assertEqual(first["proofJournalSequence"], second["proofJournalSequence"])
        self.assertEqual(first["proofJournalHeadHash"], second["proofJournalHeadHash"])
        self.assertEqual(first["proof"]["sourceEventId"], second["proof"]["sourceEventId"])
        self.assertEqual((first["factOrdinal"], second["factOrdinal"]), (0, 1))
        self.assertNotEqual(first["projectionId"], second["projectionId"])
        self.assertNotEqual(first["idempotencyKey"], second["idempotencyKey"])
        self.assertEqual(second["previousEventHash"], first["eventHash"])
        self.assertLessEqual(len(second["idempotencyKey"]), 160)

    def test_fact_ordinal_is_required_and_exact_for_both_apis(self):
        for build in (build_native_fact, build_native_fact_bundle):
            args = inputs()
            del args["fact_ordinal"]
            with self.subTest(api=build.__name__, case="missing"):
                with self.assertRaises(TypeError):
                    build(**args)
            for invalid in (-1, 64, True, False, 0.0, "0", Decimal("0"), None):
                with self.subTest(api=build.__name__, ordinal=repr(invalid)):
                    args = inputs()
                    args["fact_ordinal"] = invalid
                    with self.assertRaisesRegex(ExecutionError, "native-fact-ordinal-invalid"):
                        build(**args)
                    self.assertEqual(args["authority"].hashed, [])
                    self.assertEqual(args["authority"].validated, [])

    def test_fact_ordinal_endpoints_are_bound_into_both_outputs(self):
        for ordinal in (0, 63):
            with self.subTest(ordinal=ordinal):
                args = inputs()
                args["fact_ordinal"] = ordinal
                projection, proof_bytes = build_native_fact_bundle(**args)
                self.assertEqual(projection["factOrdinal"], ordinal)
                self.assertEqual(json.loads(proof_bytes)["factOrdinal"], ordinal)
                self.assertEqual(projection["proofJournalSequence"], args["journal_event"]["sequence"])
                self.assertEqual(projection["proofJournalHeadHash"], args["authority"].digest(args["journal_event"]))

    def test_ordinal_alone_changes_both_proof_and_projection_hash(self):
        args = inputs()
        first, first_bytes = build_native_fact_bundle(**args)
        args["fact_ordinal"] = 1
        second, second_bytes = build_native_fact_bundle(**args)
        self.assertEqual(first["proofJournalHeadHash"], second["proofJournalHeadHash"])
        self.assertEqual(first["proofJournalSequence"], second["proofJournalSequence"])
        self.assertNotEqual(first_bytes, second_bytes)
        self.assertNotEqual(first["proof"]["sha256"], second["proof"]["sha256"])
        self.assertNotEqual(first["eventHash"], second["eventHash"])

    def test_restart_epoch_has_distinct_projection_identity(self):
        args = inputs()
        first = build_native_fact(**args)
        args["owner_epoch"] = 5
        args["owned_state"]["ownerEpoch"] = "5"
        args["journal_event"]["ownerEpoch"] = "5"
        self.assertNotEqual(first["projectionId"], build_native_fact(**args)["projectionId"])

    def test_native_validators_must_each_return_literal_true(self):
        for contract, error, calls in (
            ("NativeJournalProof", "native-journal-proof-validation-required", 1),
            ("NativeFactProjection", "native-fact-validation-required", 2),
        ):
            for verdict in (False, None, 1, "true", [], {}, object()):
                with self.subTest(contract=contract, verdict=repr(verdict)):
                    args = inputs()
                    args["authority"].contract_verdicts[contract] = verdict
                    with self.assertRaisesRegex(ExecutionError, error):
                        build_native_fact(**args)
                    self.assertEqual(len(args["authority"].validated), calls)

    def test_unsupported_fact_rejected_by_native_validator(self):
        args = inputs()
        args["fact"] = {"kind": "model-permission", "executionAuthorized": True}
        args["authority"].verdict = False
        with self.assertRaisesRegex(ExecutionError, "native-journal-proof-validation-required"):
            build_native_fact(**args)
        candidate = args["authority"].validated[0][1]
        self.assertEqual(candidate["payload"], args["fact"])
        self.assertEqual(args["authority"].validated[0][0], "NativeJournalProof")

    def test_clocks_require_exact_integer_nanoseconds_including_ttl(self):
        for field in ("occurred_ns", "received_ns", "ttl_ns"):
            for invalid in (True, False, 1.0, "1", Decimal("1"), None):
                with self.subTest(field=field, invalid=repr(invalid)):
                    args = inputs()
                    args[field] = invalid
                    with self.assertRaisesRegex(ExecutionError, "integer-nanoseconds-required"):
                        build_native_fact(**args)
                    self.assertEqual(args["authority"].hashed, [])

    def test_invalid_chronology_and_expiry_overflow_fail_before_hashing(self):
        for replacements in (
            {"occurred_ns": -1}, {"received_ns": OCCURRED - 1},
            {"ttl_ns": 0}, {"ttl_ns": -1}, {"ttl_ns": 10 ** 40},
        ):
            with self.subTest(replacements=replacements):
                args = inputs()
                args.update(replacements)
                with self.assertRaises(ExecutionError):
                    build_native_fact(**args)
                self.assertEqual(args["authority"].hashed, [])

    def test_genesis_and_inexact_publication_ordinals_rejected(self):
        for invalid in (0, 1, -1, True, 2.0, "2", None):
            with self.subTest(sequence=invalid):
                args = inputs()
                args["sequence"] = invalid
                with self.assertRaisesRegex(ExecutionError, "native-fact-genesis-required"):
                    build_native_fact(**args)
        for invalid in (None, "", "a" * 63, "A" * 64, "g" * 64, 1):
            with self.subTest(predecessor=invalid):
                args = inputs()
                args["previous_event_hash"] = invalid
                with self.assertRaisesRegex(ExecutionError, "native-fact-invalid-digest"):
                    build_native_fact(**args)

    def test_paper_owned_scope_required(self):
        for field, value in (("environment", "live"), ("environment", None),
                             ("accountAlias", ""), ("simulatorId", "")):
            with self.subTest(field=field, value=value):
                args = inputs()
                args["owned_state"][field] = value
                with self.assertRaisesRegex(ExecutionError, "owned-paper-scope-required"):
                    build_native_fact(**args)
                self.assertEqual(args["authority"].hashed, [])

    def test_epoch_and_source_clock_must_match_owned_transition(self):
        for invalid in (0, -1, True, 4.0, "4", None):
            with self.subTest(owner_epoch=invalid):
                args = inputs()
                args["owner_epoch"] = invalid
                with self.assertRaisesRegex(ExecutionError, "owner-epoch-mismatch"):
                    build_native_fact(**args)
        args = inputs()
        args["owned_state"]["ownerEpoch"] = "3"
        with self.assertRaisesRegex(ExecutionError, "owner-epoch-mismatch"):
            build_native_fact(**args)
        for field, invalid in (("ownerEpoch", "3"), ("occurredNs", str(OCCURRED + 1)),
                               ("occurredNs", OCCURRED)):
            with self.subTest(field=field, invalid=invalid):
                args = inputs()
                args["journal_event"][field] = invalid
                with self.assertRaisesRegex(ExecutionError, "journal-lineage-mismatch"):
                    build_native_fact(**args)

    def test_actual_envelope_is_required_not_an_external_proof_claim(self):
        for field in inputs()["journal_event"]:
            with self.subTest(missing=field):
                args = inputs()
                del args["journal_event"][field]
                with self.assertRaisesRegex(ExecutionError, "journal-envelope-required"):
                    build_native_fact(**args)
        for field, value in (("accountAlias", "paper-account"), ("sha256", "e" * 64)):
            with self.subTest(extra=field):
                args = inputs()
                args["journal_event"][field] = value
                with self.assertRaisesRegex(ExecutionError, "journal-envelope-required"):
                    build_native_fact(**args)
        for field, value in (("kind", "epoch-claimed"), ("kind", ""), ("data", []),
                             ("eventId", ""), ("eventId", None)):
            with self.subTest(field=field, value=value):
                args = inputs()
                args["journal_event"][field] = value
                with self.assertRaisesRegex(ExecutionError, "journal-envelope-required"):
                    build_native_fact(**args)

    def test_internal_journal_sequence_is_canonical_positive_string(self):
        for invalid in ("", "0", "01", "-1", "1.0", "１２", 40, True, None):
            with self.subTest(sequence=invalid):
                args = inputs()
                args["journal_event"]["sequence"] = invalid
                with self.assertRaisesRegex(ExecutionError, "invalid-journal-sequence"):
                    build_native_fact(**args)
        args = inputs()
        args["journal_event"]["previousHash"] = None
        with self.assertRaisesRegex(ExecutionError, "native-fact-invalid-digest"):
            build_native_fact(**args)

    def test_explicit_source_scope_cannot_override_native_owner_scope(self):
        for field, invalid in (("accountAlias", "other-account"), ("environment", "live"),
                               ("simulatorId", "other-simulator"), ("ownerEpoch", "3")):
            with self.subTest(field=field):
                args = inputs()
                args["journal_event"]["data"][field] = invalid
                with self.assertRaisesRegex(ExecutionError, "journal-scope-mismatch"):
                    build_native_fact(**args)
        args = inputs()
        for field in ("accountAlias", "environment", "simulatorId", "ownerEpoch"):
            args["journal_event"]["data"][field] = args["owned_state"][field]
        self.assertEqual(build_native_fact(**args)["accountAlias"], "paper-account")

    def test_builder_does_not_mutate_or_alias_input_fields(self):
        args = inputs()
        before = {key: deepcopy(args[key]) for key in ("owned_state", "journal_event", "fact")}
        value = build_native_fact(**args)
        for key, original in before.items():
            self.assertEqual(args[key], original)
        args["fact"]["reasonCodes"].append("later-input-change")
        self.assertEqual(value["fact"]["reasonCodes"], ["manual-pause"])
        value["fact"]["reasonCodes"].append("later-output-change")
        self.assertEqual(args["fact"]["reasonCodes"], ["manual-pause", "later-input-change"])
        original_hash = value["proof"]["sha256"]
        args["journal_event"]["data"]["reason"] = "later-event-change"
        self.assertEqual(value["proof"]["sha256"], original_hash)

    def test_rejected_native_fact_also_preserves_all_inputs(self):
        args = inputs()
        args["authority"].verdict = False
        before = {key: deepcopy(args[key]) for key in ("owned_state", "journal_event", "fact")}
        with self.assertRaises(ExecutionError):
            build_native_fact(**args)
        for key, original in before.items():
            self.assertEqual(args[key], original)

    def test_native_emitter_and_retention_never_copy_human_admission_authority(self):
        args = inputs()
        args["owned_state"]["orders"] = {"expired-order": {"admission": {
            "actorId": "human-reviewer", "policyVersion": "expired-policy",
            "expiresAt": "1970-01-01T00:00:00.000000001Z", "executionAuthorized": True,
        }, "reservationState": "settlement-held"}}
        original_state = deepcopy(args["owned_state"])
        value = build_native_fact(**args)
        self.assertEqual(value["actorId"], "native-paper-owner")
        self.assertEqual(value["policyVersion"], "1.0.0")
        self.assertIs(value["authoritative"], False)
        self.assertIs(value["executionAuthorized"], False)
        self.assertEqual(value["reservationAuthority"], "native-owner-only")
        self.assertEqual(args["owned_state"], original_state)
        self.assertNotIn("admissionId", value)
        self.assertNotIn("orders", value)
        self.assertNotIn("cash", value)

    def test_pending_and_settled_fact_fields_are_forwarded_to_native_validation(self):
        for kind in ("assignment", "exercise", "option-expiry"):
            for settlement_state, due_at in (
                ("pending", "2030-01-01T00:00:00.000000001Z"),
                ("settled", "2023-11-14T22:13:20.123456789Z"),
            ):
                with self.subTest(kind=kind, settlement_state=settlement_state):
                    args = inputs()
                    args["fact"] = {
                        "kind": kind, "settlementId": "settlement-1",
                        "instrumentId": "option-1", "underlyingId": "underlying-1",
                        "settlementKind": "cash", "settlementState": settlement_state,
                        "quantity": "1", "currency": "USD", "cashDelta": "0",
                        "shareDelta": "0", "dueAt": due_at, "fillEventIds": ["fill-1"],
                    }
                    value = build_native_fact(**args)
                    self.assertEqual(value["fact"], args["fact"])
                    self.assertEqual(args["authority"].validated[0][1]["payload"], args["fact"])
                    self.assertEqual(args["authority"].validated[1][1]["fact"], args["fact"])
                    self.assertIs(value["executionAuthorized"], False)

    def test_pending_positive_obligation_does_not_increase_owned_balances(self):
        args = inputs()
        args["fact"] = {
            "kind": "assignment", "settlementId": "settlement-1", "instrumentId": "option-1",
            "underlyingId": "underlying-1", "settlementKind": "cash", "settlementState": "pending",
            "quantity": "1", "currency": "USD", "cashDelta": "100", "shareDelta": "0",
            "dueAt": "2030-01-01T00:00:00.000000001Z", "fillEventIds": ["fill-1"],
        }
        before = deepcopy(args["owned_state"])
        value, proof_bytes = build_native_fact_bundle(**args)
        self.assertEqual(value["fact"]["cashDelta"], "100")
        self.assertEqual(json.loads(proof_bytes)["payload"], value["fact"])
        self.assertEqual(args["owned_state"], before)
        self.assertIs(value["executionAuthorized"], False)

    def test_projection_only_api_matches_atomic_bundle_projection(self):
        args = inputs()
        projection, proof_bytes = build_native_fact_bundle(**args)
        self.assertEqual(build_native_fact(**args), projection)
        self.assertEqual(projection["proof"]["sha256"], sha256(proof_bytes).hexdigest())

    def test_proof_payload_and_each_scope_field_are_hash_bound(self):
        args = inputs()
        projection, proof_bytes = build_native_fact_bundle(**args)
        proof = json.loads(proof_bytes)
        for field, original in proof.items():
            with self.subTest(field=field):
                changed = deepcopy(proof)
                if type(original) is dict:
                    changed[field]["altered"] = True
                else:
                    changed[field] = str(original) + "-altered"
                changed_bytes = args["authority"].encode(changed)
                self.assertNotEqual(projection["proof"]["sha256"], sha256(changed_bytes).hexdigest())
        # Canonically equivalent JSON with extra whitespace is not the sealed artifact.
        self.assertNotEqual(projection["proof"]["sha256"], sha256(proof_bytes + b" ").hexdigest())

    def test_fact_variants_from_one_transition_have_distinct_proof_artifacts(self):
        args = inputs()
        first, first_bytes = build_native_fact_bundle(**args)
        args["fact"]["reasonCodes"].append("reconciliation-required")
        second, second_bytes = build_native_fact_bundle(**args)
        self.assertEqual(json.loads(first_bytes)["journalHeadHash"], json.loads(second_bytes)["journalHeadHash"])
        self.assertNotEqual(first["proof"]["sha256"], second["proof"]["sha256"])

    def test_native_canonical_codec_must_match_returned_proof_bytes(self):
        class InconsistentCodec(LocalAuthority):
            def digest(self, value):
                canonical = LocalAuthority.encode(self, value)
                return sha256(canonical).hexdigest()

            def encode(self, value):
                canonical = super().encode(value)
                return canonical + b" " if value.get("proofKind") == "native-journal-event" else canonical

        args = inputs()
        args["authority"] = InconsistentCodec()
        with self.assertRaisesRegex(ExecutionError, "native-journal-proof-codec-mismatch"):
            build_native_fact_bundle(**args)
        self.assertEqual([call[0] for call in args["authority"].validated], ["NativeJournalProof"])

    def test_checkpoint_payload_must_match_actual_journal_sequence_and_head(self):
        args = inputs()
        digest = args["authority"].digest(args["journal_event"])
        args["fact"] = {
            "kind": "checkpoint", "snapshotId": "checkpoint-1",
            "snapshotSha256": "c" * 64, "journalSequence": "40", "journalHeadHash": digest,
        }
        projection, proof_bytes = build_native_fact_bundle(**args)
        proof = json.loads(proof_bytes)
        self.assertEqual(projection["fact"]["journalHeadHash"], proof["journalHeadHash"])
        self.assertEqual(projection["fact"]["journalSequence"], proof["journalSequence"])
        for field, changed in (("journalSequence", "39"), ("journalHeadHash", "d" * 64)):
            with self.subTest(field=field):
                invalid = dict(args)
                invalid["fact"] = {**args["fact"], field: changed}
                with self.assertRaisesRegex(ExecutionError, "native-fact-checkpoint-head-mismatch"):
                    build_native_fact_bundle(**invalid)


if __name__ == "__main__":
    unittest.main()
