"""Source-only projection regression fixtures; no native runtime or journal IO.

RecordingAuthority is a wiring double, NOT another public schema validator.
Cross-language PortfolioGenesis fixtures own actual native/Civet equivalence.
"""

from copy import deepcopy
import hashlib
import json
import unittest

from vertex_execution.portfolio_projection import build_genesis, build_snapshot, validate_genesis
from vertex_execution.ports import ExecutionError


OBSERVED = "2026-09-22T12:00:00.000000001Z"
RECEIVED = "2026-09-22T12:00:00.000000002Z"
EVALUATED = "2026-09-22T12:00:00.000000003Z"
LATER = "2026-09-22T12:00:00.000000004Z"
EXPIRED = "2026-09-22T12:00:00.001000004Z"
BASE = 1790078400000000000


class RecordingAuthority:
    def __init__(self):
        self.validations = []
        self.digests = []
        self.validation_result = True
        self.clocks = {OBSERVED: BASE + 1, RECEIVED: BASE + 2, EVALUATED: BASE + 3,
                       LATER: BASE + 4, EXPIRED: BASE + 1_000_004}

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.validations.append((contract_name, deepcopy(payload), schema_version))
        return self.validation_result

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        self.digests.append(deepcopy(value))
        return hashlib.sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, value):
        return self.clocks[value]


def state_fixture():
    return {
        "accountAlias": "paper-account", "environment": "paper", "simulatorId": "simulator-1",
        "currency": "USD", "ownerEpoch": "3", "pausedNewRisk": True, "reconciled": True,
        "cash": "1000.000000000000000001", "positions": {"instrument-b": "-2", "instrument-a": "3"},
        "orders": {}, "unsettledCredits": {"unsettled-credit": "9000000"},
        "unsettledPositions": {}, "fillLineage": {}, "corporateActions": {},
        "settlements": {}, "invalidQualifications": [], "liquidationRequests": [],
        "observation": {
            "observationId": "native-observation", "sourceSequence": "1",
            "observedNs": str(BASE + 1), "receivedNs": str(BASE + 2), "validUntilNs": str(BASE + 1_000_004),
            "cash": "1000.000000000000000001", "positions": {"instrument-b": "-2", "instrument-a": "3"},
            "evidenceSha256": "a" * 64,
        },
    }


def order_fixture():
    return {
        "submissionKey": "submission-1", "reservationEventId": "reserve-submission-1",
        "cashReserve": "250.000000000000000001", "shareReserve": {"instrument-a": "2"},
        "reservationState": "reserved", "status": "submitted", "dispatchMarked": True,
        "cancelRequested": False, "finalityProven": False, "reconciledEpoch": "3",
        "admission": {"accountAlias": "paper-account", "environment": "paper", "simulatorId": "simulator-1", "ownerEpoch": "2"},
    }


class PortfolioProjectionTests(unittest.TestCase):
    def setUp(self):
        self.authority = RecordingAuthority()
        self.state = state_fixture()
        self.arguments = {
            "authority": self.authority, "owned_state": self.state, "stream_id": "native-stream",
            "owner_epoch": 3, "observed_at": OBSERVED, "received_at": RECEIVED,
            "evaluated_at": EVALUATED, "max_age_ms": 1, "snapshot_id": "snapshot-genesis",
        }

    def genesis(self, **changes):
        return build_genesis(**{**self.arguments, **changes})

    def test_genesis_is_observation_only_with_exact_owned_cash_and_no_invented_valuation(self):
        snapshot = self.genesis()
        self.assertEqual(snapshot["cash"], "1000.000000000000000001")
        self.assertNotEqual(snapshot["cash"], self.state["unsettledCredits"]["unsettled-credit"])
        self.assertIsNone(snapshot["netAssetValue"])
        self.assertEqual([row["instrumentId"] for row in snapshot["positions"]], ["instrument-a", "instrument-b"])
        self.assertEqual(snapshot["positions"][1]["quantity"], "-2")
        for row in snapshot["positions"]:
            for field in ("marketValue", "costBasis", "priceAsOf", "sleeveId"):
                self.assertIsNone(row[field])
        self.assertEqual(snapshot["lots"], [])
        self.assertEqual(snapshot["reservations"], [])
        self.assertEqual(snapshot["sleeveAllocations"], [])
        self.assertEqual(snapshot["sourceKind"], "paper-simulation")
        self.assertEqual(snapshot["sequence"], "1")
        self.assertEqual(snapshot["continuity"]["expectedNextSequence"], "2")
        self.assertIs(snapshot["observationOnly"], True)
        self.assertIs(snapshot["executionAuthorized"], False)
        self.assertIs(snapshot["researchNotionalIncluded"], False)
        self.assertIs(snapshot["continuity"]["newRiskInhibited"], True)
        self.assertIs(snapshot["continuity"]["authoritative"], False)

    def test_placeholder_shape_then_native_genesis_validation(self):
        snapshot = self.genesis()
        self.assertEqual([entry[0] for entry in self.authority.validations], ["PortfolioSnapshot", "PortfolioGenesis"])
        placeholder = self.authority.validations[0][1]
        self.assertEqual(placeholder["sourceEventHash"], "0" * 64)
        self.assertEqual(placeholder["continuity"]["highWaterEventHash"], "0" * 64)
        self.assertEqual(snapshot["sourceEventHash"], snapshot["continuity"]["highWaterEventHash"])
        self.assertEqual(validate_genesis(self.authority, snapshot), snapshot["sourceEventHash"])

    def test_hash_omits_only_two_self_fields(self):
        snapshot = self.genesis()
        expected = deepcopy(snapshot)
        del expected["sourceEventHash"]
        del expected["continuity"]["highWaterEventHash"]
        self.assertEqual(self.authority.digests[0], expected)
        self.assertEqual(snapshot["sourceEventHash"], hashlib.sha256(self.authority.encode(expected)).hexdigest())
        self.assertIn("evaluatedAt", expected["continuity"])
        self.assertIn("freshness", expected["continuity"])
        self.assertIn("receivedAt", expected)
        self.assertIn("positions", expected)

    def test_tampered_economic_observation_or_freshness_invalidates_hash(self):
        original = self.genesis()
        for mutate in (
            lambda value: value.update(cash="1001"),
            lambda value: value.update(snapshotId="other"),
            lambda value: value.update(receivedAt=EVALUATED),
            lambda value: value["continuity"].update(evaluatedAt=LATER),
            lambda value: value["continuity"]["freshness"].update(maxAgeMs=2),
            lambda value: value["positions"][0].update(quantity="4"),
        ):
            snapshot = deepcopy(original)
            mutate(snapshot)
            with self.assertRaises(ExecutionError):
                validate_genesis(self.authority, snapshot)

    def test_hash_scope_rejects_live_research_noninitial_or_gap(self):
        for change in ({"environment": "live"}, {"environment": "research"}, {"sourceKind": "broker-observation"}, {"sequence": "2"}):
            snapshot = self.genesis()
            snapshot.update(change)
            with self.subTest(change=change), self.assertRaises(ExecutionError):
                validate_genesis(self.authority, snapshot)
        snapshot = self.genesis()
        snapshot["continuity"]["state"] = "gap"
        with self.assertRaises(ExecutionError):
            validate_genesis(self.authority, snapshot)
        snapshot = self.genesis()
        snapshot["continuity"]["highWaterEventHash"] = "0" * 64
        with self.assertRaises(ExecutionError):
            validate_genesis(self.authority, snapshot)

    def test_native_validator_requires_literal_true(self):
        for result in (False, 1, "true", None):
            self.authority.validation_result = result
            with self.subTest(result=result), self.assertRaises(ExecutionError):
                self.genesis()

    def test_cloud_projection_is_never_an_owned_capital_source(self):
        snapshot = self.genesis()
        with self.assertRaises(ExecutionError):
            self.genesis(owned_state=snapshot)
        for forbidden in ("sourceKind", "continuity", "netAssetValue", "reservations", "sleeveAllocations"):
            state = state_fixture()
            state[forbidden] = None
            with self.subTest(field=forbidden), self.assertRaises(ExecutionError):
                self.genesis(owned_state=state)

    def test_scope_epoch_and_observation_provenance_fail_closed(self):
        for field, value in (("environment", "live"), ("ownerEpoch", "2"), ("observation", None), ("reconciled", 1)):
            state = state_fixture()
            state[field] = value
            with self.subTest(field=field), self.assertRaises(ExecutionError):
                self.genesis(owned_state=state)
        for field, value in (("cash", "999"), ("evidenceSha256", "not-a-hash"), ("sourceSequence", "0")):
            state = state_fixture()
            state["observation"][field] = value
            with self.subTest(field=field), self.assertRaises(ExecutionError):
                self.genesis(owned_state=state)
        with self.assertRaises(ExecutionError):
            self.genesis(owner_epoch=True)

    def test_genesis_clocks_are_exact_qualified_observation_and_fresh(self):
        for changes in (
            {"observed_at": RECEIVED}, {"received_at": EVALUATED},
            {"evaluated_at": OBSERVED}, {"evaluated_at": EXPIRED},
            {"max_age_ms": True}, {"max_age_ms": -1}, {"max_age_ms": 0},
        ):
            with self.subTest(changes=changes), self.assertRaises(ExecutionError):
                self.genesis(**changes)

    def test_restart_unknown_obligations_remain_visible_and_inhibited(self):
        self.state["reconciled"] = False
        order = order_fixture()
        order["status"] = "unknown"
        order["reconciledEpoch"] = "2"
        self.state["orders"]["submission-1"] = order
        snapshot = self.genesis()
        rows = snapshot["reservations"]
        self.assertEqual(len(rows), 2)
        self.assertEqual([row["state"] for row in rows], ["unknown", "unknown"])
        self.assertEqual(rows[0]["cashAmount"], order["cashReserve"])
        self.assertEqual(rows[0]["shareQuantity"], "0")
        self.assertIsNone(rows[0]["instrumentId"])
        self.assertEqual(rows[1]["cashAmount"], "0")
        self.assertEqual(rows[1]["shareQuantity"], "2")
        self.assertEqual(rows[1]["instrumentId"], "instrument-a")
        self.assertEqual({row["sourceEventId"] for row in rows}, {"reserve-submission-1"})
        self.assertEqual(len({row["reservationId"] for row in rows}), 2)
        self.assertTrue(all(row["authoritative"] is False for row in rows))
        self.state["pausedNewRisk"] = False
        with self.assertRaises(ExecutionError):
            self.genesis()

    def test_settlement_held_is_not_spent_or_released(self):
        order = order_fixture()
        order.update(reservationState="settlement-held", status="filled", finalityProven=True)
        self.state["orders"]["submission-1"] = order
        self.assertEqual({row["state"] for row in self.genesis()["reservations"]}, {"reserved"})
        order["reservationState"] = "released"
        self.assertEqual({row["state"] for row in self.genesis()["reservations"]}, {"released"})
        order["finalityProven"] = False
        with self.assertRaises(ExecutionError):
            self.genesis()

    def test_missing_reservation_lineage_or_wrong_account_rejects(self):
        order = order_fixture()
        self.state["orders"]["submission-1"] = order
        del order["reservationEventId"]
        with self.assertRaises(ExecutionError):
            self.genesis()
        order["reservationEventId"] = "reserve-submission-1"
        order["admission"]["accountAlias"] = "other-account"
        with self.assertRaises(ExecutionError):
            self.genesis()

    def test_owned_lots_preserve_cost_and_lineage_never_default(self):
        lot = {"lotId": "lot-1", "instrumentId": "instrument-a", "quantity": "3", "unitCost": "12.345",
               "currency": "USD", "openedAt": OBSERVED, "sourceEventId": "owned-fill-event"}
        self.state["lots"] = {"lot-1": lot}
        snapshot = self.genesis()
        self.assertEqual(snapshot["lots"], [lot])
        del lot["unitCost"]
        with self.assertRaises(ExecutionError):
            self.genesis()

    def test_build_is_detached_and_does_not_mutate_owned_journal(self):
        self.state["orders"]["submission-1"] = order_fixture()
        before = deepcopy(self.state)
        snapshot = self.genesis()
        self.assertEqual(self.state, before)
        snapshot["positions"][0]["quantity"] = "9000"
        snapshot["reservations"][0]["cashAmount"] = "0"
        self.assertEqual(self.state, before)

    def test_exact_decimal_only_no_float_coercion_or_unsettled_cash_credit(self):
        for bad in (1.0, True, "1.00", "-1", "NaN"):
            state = state_fixture()
            state["cash"] = state["observation"]["cash"] = bad
            with self.subTest(bad=bad), self.assertRaises(ExecutionError):
                self.genesis(owned_state=state)

    def test_subsequent_snapshot_preserves_durable_hash_without_genesis_rehash(self):
        expected_hash = "b" * 64
        snapshot = build_snapshot(**self.arguments, sequence=8, source_event_hash=expected_hash)
        self.assertEqual(snapshot["sequence"], "8")
        self.assertEqual(snapshot["sourceEventHash"], expected_hash)
        self.assertEqual(snapshot["continuity"]["highWaterEventHash"], expected_hash)
        self.assertEqual(snapshot["continuity"]["highWaterSequence"], "8")
        self.assertEqual(snapshot["continuity"]["expectedNextSequence"], "9")
        self.assertEqual(self.authority.digests, [])
        self.assertEqual([entry[0] for entry in self.authority.validations], ["PortfolioSnapshot"])

    def test_snapshot_event_clock_can_precede_or_follow_confirming_observation(self):
        arguments = {**self.arguments, "observed_at": RECEIVED, "received_at": EVALUATED, "evaluated_at": LATER}
        later_event = build_snapshot(**arguments, sequence=2, source_event_hash="c" * 64)
        self.assertEqual(later_event["asOfAt"], RECEIVED)
        self.state["observation"].update(observedNs=str(BASE + 3), receivedNs=str(BASE + 4))
        arguments = {**self.arguments, "evaluated_at": LATER}
        earlier_event = build_snapshot(**arguments, sequence=3, source_event_hash="d" * 64)
        self.assertEqual(earlier_event["asOfAt"], OBSERVED)

    def test_snapshot_rejects_inexact_sequence_hash_and_stale_seed_even_if_event_fresh(self):
        for sequence, digest in ((True, "a" * 64), (0, "a" * 64), (1.0, "a" * 64), (2, "invalid")):
            with self.subTest(sequence=sequence, digest=digest), self.assertRaises(ExecutionError):
                build_snapshot(**self.arguments, sequence=sequence, source_event_hash=digest)
        self.state["observation"]["observedNs"] = str(BASE - 2_000_000)
        with self.assertRaises(ExecutionError):
            build_snapshot(**self.arguments, sequence=2, source_event_hash="a" * 64)
