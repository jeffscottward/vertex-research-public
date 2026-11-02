"""Authored, unexecuted owner regressions; explicitly NOT native conformance.

Authority, artifact, risk, permissions and transport doubles below are synthetic
and deliberately do not implement native schemas, pricing, rights or simulation.
Only the real journal/owner atomicity and defensive bindings are under test. No
broker/network/runtime bootstrap is configured or implied by these fixtures.
"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from vertex_execution.batch_owner import AtomicBatchOwner
from vertex_execution.exact import decimal, timestamp, units
from vertex_execution.journal import Journal, reserved
from vertex_execution.owner import PaperExecutionOwner, digest_reference, reference
from vertex_execution.ports import Artifact, ExecutionError, MutationGrant, PortfolioObservation, RiskPlan


class NonConformanceAuthority:
    """Synthetic canonical JSON/hash helper, never a native contract validator."""
    def __init__(self):
        self.validations = []
        self.reject = None
        self.result = True

    def validate(self, name, value, schema_version="1.0.0"):
        self.validations.append(name)
        if name == self.reject:
            raise ExecutionError("synthetic-validation-rejection")
        return self.result

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, value):
        # Every synthetic test timestamp lies within the first UTC epoch second.
        if (type(value) is not str or len(value) != 30 or value[:20] != "1970-01-01T00:00:00."
                or value[-1] != "Z" or not value[20:29].isascii() or not value[20:29].isdecimal()):
            raise AssertionError("fixture-time-out-of-scope")
        return int(value[20:29])

    def validate_native_journal_proof(self, projection, proof_bytes, schema_version="1.0.0"):
        """Fixture-only binding checks, NOT the native schema implementation.

        Mirrors the byte/content relationship in vertex-native-facts.civet.
        Journal separately proves this event identity/head belongs to its actual
        persisted events; this synthetic authority cannot confer that ownership.
        """
        try:
            if (schema_version != "1.0.0" or type(proof_bytes) is not bytes
                    or not 0 < len(proof_bytes) <= 1_048_576 or type(projection) is not dict):
                raise ValueError("proof-byte-bound")
            proof = json.loads(proof_bytes)
            if type(proof) is not dict or set(proof) != {
                "schemaVersion", "proofKind", "accountAlias", "environment", "streamId", "ownerEpoch",
                "sourceEventId", "journalSequence", "journalHeadHash", "factOrdinal", "occurredAt", "eventType", "payload",
            }:
                raise ValueError("proof-envelope")
            if (self.validate("NativeFactProjection", projection, schema_version) is not True
                    or self.validate("NativeJournalProof", proof, schema_version) is not True
                    or self.encode(proof) != proof_bytes
                    or proof["schemaVersion"] != schema_version or projection["schemaVersion"] != schema_version
                    or proof["proofKind"] != "native-journal-event"
                    or proof["environment"] != "paper" or projection["sourceKind"] != "paper-simulation"
                    or projection["authoritative"] is not False or projection["executionAuthorized"] is not False
                    or projection["reservationAuthority"] != "native-owner-only"):
                raise ValueError("proof-canonical-mode")
            identity = projection["proof"]
            if type(identity) is not dict or set(identity) != {"artifactId", "sha256", "sourceEventId"}:
                raise ValueError("proof-reference")
            for identifier in (identity["artifactId"], identity["sourceEventId"], proof["sourceEventId"],
                               projection["projectionId"], projection["actorId"], projection["idempotencyKey"],
                               proof["accountAlias"], proof["streamId"]):
                reference(identifier)
            for digest in (identity["sha256"], proof["journalHeadHash"], projection["proofJournalHeadHash"],
                           projection["previousEventHash"], projection["eventHash"]):
                digest_reference(digest)
            body = {key: value for key, value in projection.items() if key != "eventHash"}
            if (hashlib.sha256(proof_bytes).hexdigest() != identity["sha256"]
                    or self.digest(body) != projection["eventHash"]
                    or proof["sourceEventId"] != identity["sourceEventId"]
                    or proof["journalSequence"] != projection["proofJournalSequence"]
                    or proof["journalHeadHash"] != projection["proofJournalHeadHash"]
                    or any(proof[field] != projection[field] for field in
                           ("accountAlias", "environment", "streamId", "ownerEpoch", "occurredAt", "factOrdinal"))):
                raise ValueError("proof-observation-binding")
            for sequence in (proof["ownerEpoch"], proof["journalSequence"],
                             projection["ownerEpoch"], projection["proofJournalSequence"], projection["sequence"]):
                if (type(sequence) is not str or not sequence.isascii() or not sequence.isdecimal()
                        or not 1 <= len(sequence) <= 30 or sequence.startswith("0")):
                    raise ValueError("proof-positive-sequence")
            if int(projection["sequence"]) < 2:
                raise ValueError("proof-before-genesis")
            if any(type(ordinal) is not int or not 0 <= ordinal <= 63
                   for ordinal in (proof["factOrdinal"], projection["factOrdinal"])):
                raise ValueError("proof-fact-ordinal")
            occurred = self.epoch_ns(proof["occurredAt"])
            if not (occurred <= self.epoch_ns(projection["receivedAt"])
                    and occurred < self.epoch_ns(projection["expiresAt"])):
                raise ValueError("proof-chronology")
            payload = proof["payload"]
            if (type(payload) is not dict or self.encode(payload) != self.encode(projection["fact"])
                    or proof["eventType"] != payload["kind"]
                    or proof["eventType"] not in {"checkpoint", "cash-settlement", "assignment", "exercise",
                                                  "option-expiry", "corporate-action", "reconciliation", "kill-state"}):
                raise ValueError("proof-payload")
            if payload["kind"] == "checkpoint" and (
                    payload["journalSequence"] != proof["journalSequence"]
                    or payload["journalHeadHash"] != proof["journalHeadHash"]):
                raise ValueError("proof-checkpoint-head")
            if payload["kind"] in {"assignment", "exercise", "option-expiry"}:
                if payload["settlementState"] not in {"pending", "settled"}:
                    raise ValueError("proof-settlement-state")
                if payload["settlementState"] == "settled" and self.epoch_ns(payload["dueAt"]) > occurred:
                    raise ValueError("proof-settlement-chronology")
            if "fillEventIds" in payload:
                identifiers = payload["fillEventIds"]
                if (type(identifiers) is not list or not 1 <= len(identifiers) <= 512
                        or len(set(identifiers)) != len(identifiers)):
                    raise ValueError("proof-fill-identity")
                for identifier in identifiers:
                    reference(identifier)
            return True
        except (AssertionError, KeyError, TypeError, ValueError, ExecutionError) as error:
            raise ExecutionError("synthetic-native-proof-binding-rejection") from error


class NonConformanceArtifacts:
    def __init__(self, authority):
        self.authority = authority
        self.items = {}

    def put(self, identifier, contract, value):
        self.items[identifier] = Artifact(identifier, contract, self.authority.digest(value), self.authority.encode(value))

    def get(self, identifier):
        return self.items[identifier]

    def value(self, identifier):
        return json.loads(self.items[identifier].canonical_bytes)

    def mutate(self, identifier, **changes):
        item = self.items[identifier]
        self.put(identifier, item.contract_name, {**self.value(identifier), **changes})


class NonConformanceRights:
    def __init__(self):
        self.revoked = set()
        self.calls = []

    def permits(self, *, admission, review, now_ns):
        self.calls.append((admission["admissionId"], review["reviewId"], now_ns))
        return admission["admissionId"] not in self.revoked

    def verify(self, value, *, now_ns):
        return True


class NonConformanceRisk:
    """Handwritten bounds expose owner checks; no financial-risk conformance."""
    def __init__(self, authority):
        self.authority = authority
        self.calls = []
        self.transform = lambda plan: plan

    def assess(self, *, intent, admission, **kwargs):
        return self.assess_batch(batch_submission_key="single-fixture", intents=(intent,), admissions=(admission,), **kwargs)

    def assess_batch(self, *, batch_submission_key, intents, admissions, strategy,
                     ledger, ledger_sequence, ledger_sha256, now_ns):
        self.calls.append(deepcopy({"key": batch_submission_key, "intents": intents, "admissions": admissions,
                                   "ledger": ledger, "sequence": ledger_sequence, "hash": ledger_sha256}))
        ordered = [{"intentSha256": self.authority.digest(intent), "admissionSha256": self.authority.digest(admission),
                    "instrumentId": intent["instrumentId"], "side": intent["side"], "quantity": intent["quantity"],
                    "maximumLoss": "40", "maximumNotional": "70", "cashReservation": "40",
                    "costReservation": "2", "settlementCash": "0", "settlementRequired": False}
                   for intent, admission in zip(intents, admissions, strict=True)]
        for leg, intent in zip(ordered, intents, strict=True):
            leg["qualifiedLegSha256"] = self.authority.digest({"syntheticQualifiedLeg": intent["instrumentId"]})
            leg["nativeLegPlan"] = {
                "instrument_id": leg["instrumentId"], "intent_hash": leg["intentSha256"], "quantity": leg["quantity"],
                "limit_price": intent["limitPrice"], "maximum_loss": leg["maximumLoss"], "gross_notional": leg["maximumNotional"],
                "cash_reservation": leg["cashReservation"], "cost_reservation": leg["costReservation"],
                "settlement_cash": leg["settlementCash"], "settlement_at_ns": None, "expiry_ns": None, "covered_shares": {},
            }
        command = {"nonConformanceFixture": True, "orderedLegs": ordered}
        cash = decimal(sum(units(leg["cashReservation"]) for leg in ordered))
        loss = decimal(sum(units(leg["maximumLoss"]) for leg in ordered))
        notional = decimal(sum(units(leg["maximumNotional"]) for leg in ordered))
        reservation = {"reservation_id": batch_submission_key, "strategy_artifact_id": admissions[0]["strategyVersion"],
                       "proposal_hashes": [leg["intentSha256"] for leg in ordered], "cash": cash,
                       "covered_shares": {}, "maximum_loss": loss, "gross_notional": notional}
        plan = RiskPlan(intent_sha256=ordered[0]["intentSha256"], strategy_artifact_id=admissions[0]["strategyVersion"],
                        ledger_sequence=ledger_sequence, ledger_sha256=ledger_sha256,
                        policy_version=admissions[0]["policyVersion"], cash_reserve=cash, share_reserve=(),
                        maximum_loss=loss, maximum_notional=notional, command_bytes=self.authority.encode(command),
                        legs=tuple((leg["instrumentId"], leg["side"], leg["quantity"]) for leg in ordered),
                        settlement_required=False, valid_until_ns=min(self.authority.epoch_ns(a["expiresAt"]) for a in admissions),
                        kernel_reservation_bytes=self.authority.encode(reservation),
                        batch_evidence_bytes=self.authority.encode({"commandSha256": self.authority.digest(command), "orderedLegs": ordered}))
        return self.transform(plan)


class NonConformanceTransport:
    simulation_only = True
    broker_submission_allowed = False

    def __init__(self, journal):
        self.journal = journal
        self.calls = []
        self.failure = None

    def submit(self, key, payload_sha256, command_bytes, *, now_ns):
        order = self.journal.state["orders"][key]
        # The durable reducer must already say UNKNOWN before any transport work.
        if not order["dispatchMarked"] or order["status"] != "unknown":
            raise AssertionError("transport-before-durable-dispatch")
        self.calls.append((key, payload_sha256, command_bytes, now_ns))
        if self.failure is not None:
            raise self.failure
        return ()


class AtomicBatchOwnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "paper.sqlite"
        self.authority = NonConformanceAuthority()
        self.artifacts = NonConformanceArtifacts(self.authority)
        self.rights = NonConformanceRights()
        self.risk = NonConformanceRisk(self.authority)
        self.journal = self.open_journal()
        self.transport = NonConformanceTransport(self.journal)
        self.owner = self.open_owner(now_ns=1)
        self.owner.observe(PortfolioObservation(
            observation_id="owned-snapshot", account_alias="paper-account", environment="paper", simulator_id="paper-simulator",
            source_sequence=1, observed_ns=10, received_ns=11, valid_until_ns=20000, currency="USD", cash="1000",
            positions=(), evidence_sha256="a" * 64, journal_sequence=self.journal.sequence,
            journal_sha256=self.journal.event_hash, seed_policy_artifact_id="simulation-capital-policy",
            seed_policy_sha256="d" * 64), now_ns=11)
        self.owner.finish_reconciliation(now_ns=12)
        self.owner.record_genesis("owned-snapshot", 1, now_ns=12)
        self.owner.reset_new_risk(self.grant("reset-new-risk"), now_ns=13)
        # Genesis and subsequent reset NativeFact are both durable setup output.
        # Drain by actual publication order, not a hard-coded stream sequence.
        while pending := self.journal.next_projection():
            self.journal.acknowledge_projection(pending[0], pending[1])
        self.artifacts.put("strategy-1", "StrategySpec", {"syntheticStrategyArtifact": "strategy-1"})
        self.legs = (self.add_leg(1), self.add_leg(2))
        self.baseline = self.journal.sequence

    def open_journal(self):
        journal = Journal(self.path, authority=self.authority, account_alias="paper-account", simulator_id="paper-simulator", currency="USD")
        self.addCleanup(journal.close)
        return journal

    def open_owner(self, now_ns):
        return AtomicBatchOwner(journal=self.journal, authority=self.authority, artifacts=self.artifacts, risk=self.risk,
                                admission_authority=self.rights, observation_authority=self.rights, mutation_authority=self.rights,
                                stream_id="paper-stream", native_emitter_actor_id="native-emitter",
                                native_policy_version="1.0.0", projection_ttl_ns=1000,
                                now_ns=now_ns, transport=self.transport)

    def grant(self, action, key=None):
        return MutationGrant(f"grant-{action}-{self.journal.sequence}", action, "paper-account", "paper", self.owner.epoch, key,
                             "human-reviewer", 1, 20000, "b" * 64)

    def add_leg(self, number):
        intent_id, admission_id, review_id = f"intent-{number}", f"admission-{number}", f"review-{number}"
        intent = {"intentId": intent_id, "idempotencyKey": f"leg-{number}", "instrumentId": f"instrument-{number}",
                  "side": "buy", "quantity": "1", "accountAlias": "paper-account", "environment": "paper",
                  "strategyVersion": "strategy-1", "proposedAt": timestamp(20), "expiresAt": timestamp(10000),
                  "orderType": "limit", "limitPrice": "38", "tickSize": "0.01", "timeInForce": "DAY",
                  "maxLossBudget": "100", "proposalOnly": True, "executionAuthorized": False}
        self.artifacts.put(intent_id, "TradeIntent", intent)
        intent_hash = self.authority.digest(intent)
        review = {"reviewId": review_id, "accountAlias": "paper-account", "environment": "paper", "collectionId": None,
                  "artifactId": intent_id, "artifactSha256": intent_hash, "reviewVersion": "1.0.0", "decision": "accepted",
                  "purpose": "paper-simulation", "actorId": "human-reviewer", "reviewedAt": timestamp(30),
                  "expiresAt": timestamp(10000), "policyVersion": "1.0.0", "strategyVersion": "strategy-1"}
        self.artifacts.put(review_id, "AcceptedReview", review)
        admission = {"admissionId": admission_id, "accountAlias": "paper-account", "environment": "paper",
                     "simulatorId": "paper-simulator", "streamId": "paper-stream", "ownerEpoch": str(self.owner.epoch),
                     "intentId": intent_id, "intentSha256": intent_hash, "reviewedArtifactSha256": intent_hash,
                     "reviewId": review_id, "reviewVersion": "1.0.0", "actorId": "human-reviewer", "policyVersion": "1.0.0",
                     "strategyVersion": "strategy-1", "portfolioSnapshotId": self.journal.state["portfolioCheckpoint"]["snapshotId"],
                     "portfolioSequence": self.journal.state["portfolioCheckpoint"]["sequence"],
                     "maximumLoss": "100", "maximumNotional": "100", "admittedAt": timestamp(40),
                     "expiresAt": timestamp(10000), "idempotencyKey": f"leg-{number}"}
        self.artifacts.put(admission_id, "PaperSimulationAdmission", admission)
        return intent_id, admission_id

    def rebind_intent(self, number, **changes):
        self.artifacts.mutate(f"intent-{number}", **changes)
        digest = self.artifacts.get(f"intent-{number}").sha256
        self.artifacts.mutate(f"admission-{number}", intentSha256=digest, reviewedArtifactSha256=digest)
        self.artifacts.mutate(f"review-{number}", artifactSha256=digest)

    def admit(self, key="batch-1", legs=None):
        return self.owner.admit_batch(key, self.legs if legs is None else legs, now_ns=100)

    def assert_unchanged(self):
        self.assertEqual(self.journal.sequence, self.baseline)
        self.assertEqual(self.journal.state["orders"], {})
        self.assertIsNone(self.journal.next_projection())
        self.assertEqual(self.transport.calls, [])

    def evidence_transform(self, transform):
        def apply(plan):
            evidence = json.loads(plan.batch_evidence_bytes)
            transform(evidence)
            return replace(plan, batch_evidence_bytes=self.authority.encode(evidence))
        self.risk.transform = apply

    def test_one_atomic_reservation_preserves_every_ordered_identity(self):
        key = self.admit()
        self.assertEqual(key, "batchsubmission-" + self.authority.digest({"accountAlias": "paper-account", "environment": "paper", "idempotencyKey": "batch-1"}))
        self.assertEqual(self.journal.sequence, self.baseline + 1)
        order = self.journal.state["orders"][key]
        self.assertEqual(order["payloadSha256"], order["batchDigest"])
        self.assertEqual(order["batchDigest"], self.authority.digest(order["batch"]))
        self.assertEqual([r["intentArtifactId"] for r in order["batchLegs"]], ["intent-1", "intent-2"])
        self.assertEqual(order["qualifiedKeys"], ["submission-" + self.authority.digest({"accountAlias": "paper-account", "environment": "paper", "idempotencyKey": f"leg-{i}"}) for i in (1, 2)])
        self.assertEqual(order["kernelReservation"]["proposal_hashes"], [r["intentSha256"] for r in order["batchLegs"]])
        self.assertEqual(order["cashReserve"], "80")
        self.assertEqual(order["maximumNotional"], "140")  # aggregate exceeds primary cap, but neither leg does
        self.assertEqual(reserved(self.journal.state), (units("80"), {}))
        self.assertEqual(len(self.risk.calls), 1)
        self.assertEqual(self.risk.calls[0]["sequence"], self.baseline)
        self.assertEqual(self.risk.calls[0]["ledger"]["orders"], {})
        self.assertNotIn("dispatchReservationKey", self.risk.calls[0]["ledger"])
        self.assertEqual(self.transport.calls, [])
        projection = json.loads(self.journal.next_projection()[2])
        self.assertFalse(projection["authoritative"])
        self.assertTrue(projection["receipt"]["observationOnly"])
        self.assertEqual(projection["receipt"]["intentId"], "intent-1")
        self.assertEqual(projection["actorId"], "native-emitter")
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM projections WHERE kind='execution'").fetchone()[0], 1)

    def test_every_leg_is_natively_validated_before_risk(self):
        self.authority.validations.clear()
        self.admit()
        for name in ("TradeIntent", "PaperSimulationAdmission", "AcceptedReview", "StrategySpec"):
            self.assertEqual(self.authority.validations.count(name), 2)
        self.assertEqual([call[0] for call in self.rights.calls], ["admission-1", "admission-2"])

    def test_false_or_truthy_non_true_native_validation_is_rejected(self):
        for result in (False, 1, None):
            with self.subTest(result=result):
                self.authority.result = result
                with self.assertRaisesRegex(ExecutionError, "native-validation-required"):
                    self.admit()
                self.assert_unchanged()
        self.assertEqual(self.risk.calls, [])

    def test_second_leg_failure_cannot_leave_primary_reservation(self):
        self.rights.revoked.add("admission-2")
        with self.assertRaisesRegex(ExecutionError, "batch-admission-binding"):
            self.admit()
        self.assert_unchanged()
        self.assertEqual(self.risk.calls, [])

    def test_duplicate_exact_batch_is_observation_even_after_expiry_or_revocation(self):
        key = self.admit()
        sequence = self.journal.sequence
        self.rights.revoked.update(("admission-1", "admission-2"))
        self.assertEqual(self.owner.admit_batch("batch-1", self.legs, now_ns=12000), key)
        self.assertEqual(self.journal.sequence, sequence)
        self.assertEqual(len(self.risk.calls), 1)
        self.assertEqual(self.transport.calls, [])

    def test_reordering_or_mutating_batch_under_same_key_conflicts(self):
        self.admit()
        sequence = self.journal.sequence
        with self.assertRaisesRegex(ExecutionError, "payload-conflict"):
            self.admit(legs=tuple(reversed(self.legs)))
        self.artifacts.mutate("admission-2", maximumNotional="101")
        with self.assertRaisesRegex(ExecutionError, "payload-conflict"):
            self.admit()
        self.assertEqual(self.journal.sequence, sequence)

    def test_batch_then_batch_cannot_reuse_constituent_identity(self):
        self.admit()
        sequence = self.journal.sequence
        with self.assertRaisesRegex(ExecutionError, "qualified-leg-already-owned"):
            self.admit("different-batch-key")
        self.assertEqual(self.journal.sequence, sequence)
        self.assertEqual(len(self.risk.calls), 1)

    def test_single_then_batch_cannot_reuse_constituent_identity(self):
        self.owner.admit(*self.legs[0], now_ns=100)
        sequence = self.journal.sequence
        with self.assertRaisesRegex(ExecutionError, "qualified-leg-already-owned"):
            self.admit()
        self.assertEqual(self.journal.sequence, sequence)

    def test_batch_then_single_is_rejected_by_generic_journal_ownership(self):
        self.admit()
        self.owner.record_portfolio_checkpoint("new-checkpoint", 1, now_ns=100)
        self.artifacts.mutate("admission-2", portfolioSnapshotId="new-checkpoint",
                              portfolioSequence=self.journal.state["portfolioCheckpoint"]["sequence"])
        sequence = self.journal.sequence
        with self.assertRaisesRegex(ExecutionError, "qualified-leg-already-admitted"):
            self.owner.admit(*self.legs[1], now_ns=101)
        self.assertEqual(self.journal.sequence, sequence)
        self.assertEqual(len(self.journal.state["orders"]), 1)

    def test_released_batch_retains_identities_forever(self):
        key = self.admit()
        self.owner.cancel_simulation(key, self.grant("cancel-simulation", key), now_ns=101)
        order = self.journal.state["orders"][key]
        self.assertEqual(order["reservationState"], "released")
        self.assertEqual(len(order["batchLegs"]), 2)
        with self.assertRaisesRegex(ExecutionError, "qualified-leg-already-owned"):
            self.admit("new-batch-key")
        with self.assertRaisesRegex(ExecutionError, "batch-reservation-not-dispatchable"):
            self.owner.dispatch_once(key, now_ns=102)
        self.assertEqual(self.transport.calls, [])

    def test_empty_oversized_or_non_tuple_batch_rejected_without_risk(self):
        cases = ((), self.legs * 5, list(self.legs), (("intent-1",),), (["intent-1", "admission-1"],))
        for legs in cases:
            with self.subTest(legs=legs), self.assertRaises(ExecutionError):
                self.admit(legs=legs)
            self.assert_unchanged()
        self.assertEqual(self.risk.calls, [])

    def test_duplicate_artifact_and_instrument_legs_are_never_netted(self):
        with self.assertRaisesRegex(ExecutionError, "duplicate-reviewed-batch-leg"):
            self.admit(legs=(self.legs[0], self.legs[0]))
        self.rebind_intent(2, instrumentId="instrument-1", side="sell")
        with self.assertRaisesRegex(ExecutionError, "duplicate-reviewed-batch-leg"):
            self.admit()
        self.assert_unchanged()

    def test_mixed_scope_policy_actor_epoch_snapshot_and_strategy_rejected(self):
        original = self.artifacts.items.copy()
        changes = {"accountAlias": "other-account", "environment": "research", "simulatorId": "other-simulator",
                   "streamId": "other-stream", "ownerEpoch": "2", "actorId": "other-human", "policyVersion": "2.0.0",
                   "portfolioSnapshotId": "other-snapshot", "portfolioSequence": "2", "reviewVersion": "2.0.0"}
        for field, value in changes.items():
            with self.subTest(field=field):
                self.artifacts.items = original.copy()
                self.artifacts.mutate("admission-2", **{field: value})
                with self.assertRaisesRegex(ExecutionError, "batch-mixed-review-context"):
                    self.admit()
                self.assert_unchanged()
        self.artifacts.items = original.copy()
        self.artifacts.put("strategy-2", "StrategySpec", {"syntheticStrategyArtifact": "strategy-2"})
        self.artifacts.mutate("admission-2", strategyVersion="strategy-2")
        with self.assertRaisesRegex(ExecutionError, "batch-mixed-strategy"):
            self.admit()
        self.assert_unchanged()

    def test_equal_but_stale_review_snapshot_is_not_spendable_authority(self):
        for number in (1, 2):
            self.artifacts.mutate(f"admission-{number}", portfolioSnapshotId="cloud-snapshot")
        with self.assertRaisesRegex(ExecutionError, "batch-admission-binding"):
            self.admit()
        self.assert_unchanged()
        with self.assertRaisesRegex(ExecutionError, "public-portfolio-projection-is-not-authority"):
            self.owner.observe({"cash": "999999"}, now_ns=100)
        self.assertEqual(self.journal.state["cash"], "1000")

    def test_mismatched_review_actor_hash_context_or_decision_rejects(self):
        original = self.artifacts.items.copy()
        for changes in ({"actorId": "different-human"}, {"artifactSha256": "c" * 64}, {"artifactId": "intent-1"},
                        {"purpose": "research"}, {"decision": "rejected"}, {"collectionId": "different-collection"}):
            with self.subTest(changes=changes):
                self.artifacts.items = original.copy()
                self.artifacts.mutate("review-2", **changes)
                with self.assertRaises(ExecutionError):
                    self.admit()
                self.assert_unchanged()

    def test_immutable_artifact_hash_or_encoding_mismatch_rejects(self):
        original = self.artifacts.get("intent-2")
        self.artifacts.items["intent-2"] = replace(original, sha256="d" * 64)
        with self.assertRaisesRegex(ExecutionError, "immutable-artifact-hash-mismatch"):
            self.admit()
        self.artifacts.items["intent-2"] = replace(original, canonical_bytes=original.canonical_bytes + b"\n")
        with self.assertRaisesRegex(ExecutionError, "immutable-artifact-hash-mismatch"):
            self.admit()
        self.assert_unchanged()

    def test_expired_or_future_dated_individual_review_intent_admission_rejects(self):
        original = self.artifacts.items.copy()
        for kind, start in (("intent", "proposedAt"), ("admission", "admittedAt"), ("review", "reviewedAt")):
            for field, value in ((start, timestamp(101)), ("expiresAt", timestamp(100))):
                with self.subTest(kind=kind, field=field):
                    self.artifacts.items = original.copy()
                    if kind == "intent":
                        self.rebind_intent(2, **{field: value})
                    else:
                        self.artifacts.mutate(f"{kind}-2", **{field: value})
                    with self.assertRaisesRegex(ExecutionError, "batch-admission-binding"):
                        self.admit()
                    self.assert_unchanged()

    def test_native_plan_hidden_dropped_reordered_wrong_side_or_quantity_rejects(self):
        for change in (lambda legs: legs + (("hidden", "buy", "1"),), lambda legs: legs[:1],
                       lambda legs: tuple(reversed(legs)), lambda legs: (legs[0], (legs[1][0], "sell", "1")),
                       lambda legs: (legs[0], (legs[1][0], "buy", "2"))):
            self.risk.transform = lambda plan: replace(plan, legs=change(plan.legs))
            with self.assertRaisesRegex(ExecutionError, "batch-risk-plan-mismatch-or-limit"):
                self.admit()
            self.assert_unchanged()

    def test_wrong_native_context_cannot_reserve(self):
        for field, value in (("intent_sha256", "e" * 64), ("ledger_sequence", 0), ("ledger_sha256", "f" * 64),
                             ("strategy_artifact_id", "other-strategy"), ("policy_version", "2.0.0"),
                             ("valid_until_ns", 100), ("valid_until_ns", 10001)):
            with self.subTest(field=field):
                self.risk.transform = lambda plan: replace(plan, **{field: value})
                with self.assertRaisesRegex(ExecutionError, "batch-risk-plan-mismatch-or-limit"):
                    self.admit()
                self.assert_unchanged()

    def test_ordered_evidence_cannot_hide_reorder_or_retarget_a_leg(self):
        transforms = (lambda e: e["orderedLegs"].pop(), lambda e: e["orderedLegs"].reverse(),
                      lambda e: e["orderedLegs"][1].update(admissionSha256="a" * 64),
                      lambda e: e["orderedLegs"][1].update(instrumentId="hidden"),
                      lambda e: e.update(commandSha256="b" * 64))
        for transform in transforms:
            self.evidence_transform(transform)
            with self.assertRaises(ExecutionError):
                self.admit()
            self.assert_unchanged()

    def test_no_per_leg_cap_can_be_borrowed_from_another_admission(self):
        self.artifacts.mutate("admission-2", maximumNotional="50", maximumLoss="30")
        # Total admitted caps (150 notional, 130 loss) exceed the plan totals;
        # only the SECOND per-leg checks detect unauthorized borrowed capacity.
        with self.assertRaisesRegex(ExecutionError, "batch-native-leg-exceeds-reviewed-cap"):
            self.admit()
        self.assert_unchanged()

    def test_native_cost_settlement_and_aggregate_bounds_must_all_be_present(self):
        changes = (lambda e: e["orderedLegs"][1].pop("costReservation"),
                   lambda e: e["orderedLegs"][1].update(costReservation="41"),
                   lambda e: e["orderedLegs"][1].update(settlementCash="1"),
                   lambda e: e["orderedLegs"][1].update(settlementRequired=True),
                   lambda e: e["orderedLegs"][1].update(cashReservation="39"),
                   lambda e: e["orderedLegs"][1].update(maximumNotional="69"))
        for change in changes:
            self.evidence_transform(change)
            with self.assertRaises(ExecutionError):
                self.admit()
            self.assert_unchanged()

    def test_cash_already_contains_costs_and_settlement_no_double_count(self):
        def option_plan(plan):
            evidence = json.loads(plan.batch_evidence_bytes)
            for leg in evidence["orderedLegs"]:
                leg.update(settlementCash="30", settlementRequired=True)
                leg["nativeLegPlan"].update(settlement_cash="30", settlement_at_ns="18000", expiry_ns="15000")
            command = {"nonConformanceFixture": True, "orderedLegs": evidence["orderedLegs"]}
            evidence["commandSha256"] = self.authority.digest(command)
            return replace(plan, settlement_required=True, batch_evidence_bytes=self.authority.encode(evidence),
                           command_bytes=self.authority.encode(command))
        self.risk.transform = option_plan
        key = self.admit()
        self.assertEqual(self.journal.state["orders"][key]["cashReserve"], "80")
        self.assertTrue(self.journal.state["orders"][key]["settlementRequired"])

    def test_missing_or_reordered_kernel_proposal_lineage_rejects(self):
        for transform in (lambda r: r["proposal_hashes"].pop(), lambda r: r["proposal_hashes"].reverse(),
                          lambda r: r.update(cash="79"), lambda r: r.update(reservation_id="different-batch")):
            def corrupt(plan):
                reservation = json.loads(plan.kernel_reservation_bytes)
                transform(reservation)
                return replace(plan, kernel_reservation_bytes=self.authority.encode(reservation))
            self.risk.transform = corrupt
            with self.assertRaisesRegex(ExecutionError, "batch-native-aggregate-evidence-mismatch"):
                self.admit()
            self.assert_unchanged()

    def test_noncanonical_or_absent_native_evidence_rejects(self):
        for field in ("command_bytes", "batch_evidence_bytes", "kernel_reservation_bytes"):
            for malformed in (b"", b"{} ", b"[]", b"{broken", b"x" * 2_000_001):
                with self.subTest(field=field, size=len(malformed)):
                    self.risk.transform = lambda plan: replace(plan, **{field: malformed})
                    with self.assertRaises(ExecutionError):
                        self.admit()
                    self.assert_unchanged()

    def test_projection_failure_rolls_back_entire_reserve_and_outbox(self):
        self.authority.reject = "ExecutionProjection"
        with self.assertRaisesRegex(ExecutionError, "synthetic-validation-rejection"):
            self.admit()
        self.assert_unchanged()
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM events").fetchone()[0], self.baseline)

    def test_exact_concurrent_duplicates_append_only_one_reservation(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            keys = list(pool.map(lambda _: self.admit(), range(2)))
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(self.journal.sequence, self.baseline + 1)
        self.assertEqual(len(self.risk.calls), 1)
        self.assertEqual(self.journal.connection.execute("SELECT COUNT(*) FROM projections WHERE kind='execution'").fetchone()[0], 1)

    def test_dispatch_reruns_all_legs_on_owned_ledger_and_excludes_only_itself(self):
        first = self.admit()
        self.owner.record_portfolio_checkpoint("second-review-checkpoint", 1, now_ns=100)
        other_legs = (self.add_leg(3), self.add_leg(4))
        second = self.admit("batch-2", other_legs)
        before = self.journal.sequence
        self.rights.calls.clear()
        self.owner.dispatch_once(first, now_ns=101)
        self.assertEqual(self.journal.sequence, before + 1)
        call = self.risk.calls[-1]
        self.assertEqual(call["ledger"]["dispatchReservationKey"], first)
        self.assertEqual(set(call["ledger"]["orders"]), {first, second})
        self.assertEqual(len(call["intents"]), 2)
        self.assertEqual([c[0] for c in self.rights.calls], ["admission-1", "admission-2"])
        self.assertEqual(self.journal.state["orders"][first]["status"], "unknown")
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.owner.dispatch_once(first, now_ns=102), ())
        self.assertEqual(len(self.transport.calls), 1)

    def test_dispatch_second_leg_revocation_leaves_whole_reservation_undispatched(self):
        key = self.admit()
        sequence = self.journal.sequence
        self.rights.revoked.add("admission-2")
        with self.assertRaisesRegex(ExecutionError, "batch-admission-binding"):
            self.owner.dispatch_once(key, now_ns=101)
        self.assertEqual(self.journal.sequence, sequence)
        self.assertFalse(self.journal.state["orders"][key]["dispatchMarked"])
        self.assertEqual(reserved(self.journal.state)[0], units("80"))
        self.assertEqual(self.transport.calls, [])

    def test_dispatch_reloads_every_immutable_artifact_before_marking(self):
        key = self.admit()
        original = self.artifacts.items.copy()
        for identifier, changes in (("intent-2", {"quantity": "2"}), ("admission-2", {"actorId": "other"}),
                                    ("review-2", {"decision": "rejected"}), ("strategy-1", {"changed": True})):
            with self.subTest(identifier=identifier):
                self.artifacts.items = original.copy()
                self.artifacts.mutate(identifier, **changes)
                with self.assertRaisesRegex(ExecutionError, "pinned-batch-artifacts-changed"):
                    self.owner.dispatch_once(key, now_ns=101)
                self.assertFalse(self.journal.state["orders"][key]["dispatchMarked"])
        self.assertEqual(self.transport.calls, [])

    def test_dispatch_expiry_and_current_risk_failure_leave_no_marker(self):
        key = self.admit()
        sequence = self.journal.sequence
        with self.assertRaisesRegex(ExecutionError, "dispatch-admission-expired"):
            self.owner.dispatch_once(key, now_ns=10000)
        self.risk.transform = lambda plan: replace(plan, legs=plan.legs[:1])
        with self.assertRaisesRegex(ExecutionError, "batch-risk-plan-mismatch-or-limit"):
            self.owner.dispatch_once(key, now_ns=101)
        self.assertEqual(self.journal.sequence, sequence)
        self.assertEqual(self.transport.calls, [])

    def test_dispatch_changed_command_even_with_rehashed_evidence_is_rejected(self):
        key = self.admit()
        def changed(plan):
            command = json.loads(plan.command_bytes)
            command["differentRecipe"] = True
            evidence = json.loads(plan.batch_evidence_bytes)
            evidence["commandSha256"] = self.authority.digest(command)
            return replace(plan, command_bytes=self.authority.encode(command), batch_evidence_bytes=self.authority.encode(evidence))
        self.risk.transform = changed
        with self.assertRaisesRegex(ExecutionError, "reservation-no-longer-covers-current-risk"):
            self.owner.dispatch_once(key, now_ns=101)
        self.assertFalse(self.journal.state["orders"][key]["dispatchMarked"])
        self.assertEqual(self.transport.calls, [])

    def test_transport_failure_retains_unknown_and_never_retries_after_restart(self):
        key = self.admit()
        self.transport.failure = RuntimeError("synthetic-post-marker-failure")
        with self.assertRaisesRegex(ExecutionError, "simulation-outcome-unknown-no-resubmit"):
            self.owner.dispatch_once(key, now_ns=101)
        self.assertTrue(self.journal.state["pausedNewRisk"])
        self.assertEqual(self.journal.state["orders"][key]["status"], "unknown")
        self.assertEqual(reserved(self.journal.state)[0], units("80"))
        self.assertEqual(self.owner.dispatch_once(key, now_ns=102), ())
        self.assertEqual(len(self.transport.calls), 1)
        original = deepcopy(self.journal.state["orders"][key])
        self.journal.close()
        self.journal = self.open_journal()
        self.transport = NonConformanceTransport(self.journal)
        self.owner = self.open_owner(now_ns=103)
        self.assertEqual(self.journal.state["orders"][key], original)
        self.assertEqual(self.owner.dispatch_once(key, now_ns=104), ())
        self.assertEqual(self.admit(), key)
        self.assertEqual(self.transport.calls, [])

    def test_unmarked_old_epoch_batch_cannot_dispatch_after_restart(self):
        key = self.admit()
        self.journal.close()
        self.journal = self.open_journal()
        self.transport = NonConformanceTransport(self.journal)
        self.owner = self.open_owner(now_ns=101)
        self.owner.finish_reconciliation(now_ns=102)
        self.owner.record_genesis("restarted-snapshot", 1, now_ns=102)
        self.owner.reset_new_risk(self.grant("reset-new-risk"), now_ns=103)
        with self.assertRaisesRegex(ExecutionError, "batch-owned-review-checkpoint-required"):
            self.owner.dispatch_once(key, now_ns=104)
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(reserved(self.journal.state)[0], units("80"))

    def test_pause_and_liquidation_are_inherited_no_batch_bypass(self):
        self.owner.pause_new_risk("operator-pause", now_ns=90)
        with self.assertRaisesRegex(ExecutionError, "new-risk-paused-or-unreconciled"):
            self.admit()
        self.owner.reset_new_risk(self.grant("reset-new-risk"), now_ns=91)
        key = self.admit()
        self.owner.request_liquidation(self.grant("request-liquidation"), now_ns=101)
        with self.assertRaisesRegex(ExecutionError, "new-risk-paused-or-unreconciled"):
            self.owner.dispatch_once(key, now_ns=102)
        self.assertEqual(len(self.journal.state["liquidationRequests"]), 1)
        self.assertEqual(self.transport.calls, [])

    def test_single_dispatch_path_delegates_without_batch_reinterpretation(self):
        key = self.owner.admit(*self.legs[0], now_ns=100)
        with patch.object(PaperExecutionOwner, "dispatch_once", return_value=()) as dispatch:
            self.assertEqual(self.owner.dispatch_once(key, now_ns=101), ())
        dispatch.assert_called_once_with(key, now_ns=101)

    def test_unknown_submission_preserves_parent_failure(self):
        with self.assertRaisesRegex(ExecutionError, "unknown-submission"):
            self.owner.dispatch_once("missing", now_ns=100)

    def test_eight_distinct_legs_are_one_reservation_not_eight_orders(self):
        legs = self.legs + tuple(self.add_leg(i) for i in range(3, 9))
        key = self.admit(legs=legs)
        order = self.journal.state["orders"][key]
        self.assertEqual(len(order["batchLegs"]), 8)
        self.assertEqual(len(order["legs"]), 8)
        self.assertEqual(order["cashReserve"], "320")
        self.assertEqual(len(self.journal.state["orders"]), 1)
        self.assertEqual(self.journal.sequence, self.baseline + 1)

    def test_one_leg_batch_retains_distinct_batch_identity(self):
        key = self.admit(legs=self.legs[:1])
        order = self.journal.state["orders"][key]
        self.assertTrue(key.startswith("batchsubmission-"))
        self.assertTrue(order["qualifiedKeys"][0].startswith("submission-"))
        self.assertEqual(len(order["batchLegs"]), 1)
        self.owner.dispatch_once(key, now_ns=101)
        self.assertEqual(len(self.transport.calls), 1)

    def test_new_batch_needs_checkpoint_for_current_economic_revision(self):
        self.admit()
        other_legs = (self.add_leg(3), self.add_leg(4))
        sequence = self.journal.sequence
        with self.assertRaisesRegex(ExecutionError, "current-native-review-checkpoint-required"):
            self.admit("new-batch", other_legs)
        self.assertEqual(self.journal.sequence, sequence)
        self.assertEqual(len(self.risk.calls), 1)

    def test_observation_cannot_reseed_cash_even_before_first_batch(self):
        with self.assertRaisesRegex(ExecutionError, "observation-ledger-disagreement"):
            self.owner.observe(PortfolioObservation(
                observation_id="smaller-owned-observation", account_alias="paper-account", environment="paper",
                simulator_id="paper-simulator", source_sequence=2, observed_ns=50, received_ns=51,
                valid_until_ns=20000, currency="USD", cash="79", positions=(), evidence_sha256="c" * 64,
                journal_sequence=self.journal.sequence, journal_sha256=self.journal.event_hash), now_ns=51)
        self.assert_unchanged()

    def test_native_leg_plan_cannot_omit_or_change_any_instrument_cost_settlement_bound(self):
        transforms = (
            lambda e: e["orderedLegs"][1].pop("nativeLegPlan"),
            lambda e: e["orderedLegs"][1].update(qualifiedLegSha256="unqualified"),
            lambda e: e["orderedLegs"][1]["nativeLegPlan"].update(limit_price="39"),
            lambda e: e["orderedLegs"][1]["nativeLegPlan"].update(cash_reservation="39"),
            lambda e: e["orderedLegs"][1]["nativeLegPlan"].update(cost_reservation="1"),
            lambda e: e["orderedLegs"][1]["nativeLegPlan"].update(settlement_cash="1"),
            lambda e: e["orderedLegs"][1]["nativeLegPlan"].update(expiry_ns="9000"),
            lambda e: e["orderedLegs"][1]["nativeLegPlan"].update(covered_shares={"hidden-collateral": "1"}),
        )
        for transform in transforms:
            self.evidence_transform(transform)
            with self.assertRaises(ExecutionError):
                self.admit()
            self.assert_unchanged()

    def test_risk_rejection_after_reading_whole_batch_appends_nothing(self):
        def reject(plan):
            raise ExecutionError("synthetic-independent-partial-leg-risk-rejected")
        self.risk.transform = reject
        with self.assertRaisesRegex(ExecutionError, "synthetic-independent-partial-leg-risk-rejected"):
            self.admit()
        self.assertEqual(len(self.risk.calls), 1)
        self.assertEqual(len(self.risk.calls[0]["intents"]), 2)
        self.assert_unchanged()

    def test_native_covered_share_sum_cannot_spend_missing_owned_shares(self):
        def reserve_missing_shares(plan):
            evidence = json.loads(plan.batch_evidence_bytes)
            for leg in evidence["orderedLegs"]:
                leg["nativeLegPlan"]["covered_shares"] = {"unowned-underlying": "1"}
            command = {"nonConformanceFixture": True, "orderedLegs": evidence["orderedLegs"]}
            evidence["commandSha256"] = self.authority.digest(command)
            reservation = json.loads(plan.kernel_reservation_bytes)
            reservation["covered_shares"] = {"unowned-underlying": "2"}
            return replace(plan, share_reserve=(("unowned-underlying", "2"),),
                           command_bytes=self.authority.encode(command),
                           batch_evidence_bytes=self.authority.encode(evidence),
                           kernel_reservation_bytes=self.authority.encode(reservation))
        self.risk.transform = reserve_missing_shares
        with self.assertRaisesRegex(ExecutionError, "insufficient-unreserved-covered-shares"):
            self.admit()
        self.assert_unchanged()

    def test_atomic_batch_cash_cannot_exceed_owned_ledger_even_with_admitted_caps(self):
        for number in (1, 2):
            self.rebind_intent(number, maxLossBudget="1000")
            self.artifacts.mutate(f"admission-{number}", maximumLoss="1000", maximumNotional="1000")
        def expensive_plan(plan):
            evidence = json.loads(plan.batch_evidence_bytes)
            for leg in evidence["orderedLegs"]:
                leg.update(cashReservation="600", maximumLoss="600", maximumNotional="700")
                leg["nativeLegPlan"].update(cash_reservation="600", maximum_loss="600", gross_notional="700")
            command = {"nonConformanceFixture": True, "orderedLegs": evidence["orderedLegs"]}
            evidence["commandSha256"] = self.authority.digest(command)
            reservation = json.loads(plan.kernel_reservation_bytes)
            reservation.update(cash="1200", maximum_loss="1200", gross_notional="1400")
            return replace(plan, cash_reserve="1200", maximum_loss="1200", maximum_notional="1400",
                           command_bytes=self.authority.encode(command),
                           batch_evidence_bytes=self.authority.encode(evidence),
                           kernel_reservation_bytes=self.authority.encode(reservation))
        self.risk.transform = expensive_plan
        with self.assertRaisesRegex(ExecutionError, "insufficient-unreserved-cash"):
            self.admit()
        self.assert_unchanged()

    def test_operational_native_facts_do_not_invalidate_economically_current_review(self):
        checkpoint = deepcopy(self.journal.state["portfolioCheckpoint"])
        prior_head = self.journal.projection_head()[0]
        self.owner.pause_new_risk("operator-pause", now_ns=90)
        self.owner.reset_new_risk(self.grant("reset-new-risk"), now_ns=91)
        self.assertGreater(self.journal.projection_head()[0], prior_head)
        self.assertEqual(self.journal.state["portfolioCheckpoint"], checkpoint)
        self.assertEqual(checkpoint["portfolioRevision"], self.journal.state["portfolioRevision"])
        key = self.admit()
        self.assertEqual(self.journal.state["orders"][key]["reviewCheckpoint"], checkpoint)
        self.assertGreater(self.journal.projection_head()[0], int(checkpoint["sequence"]))
