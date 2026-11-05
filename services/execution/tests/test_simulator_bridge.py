"""Author-only regression specifications: no test or native runtime was run.

Synthetic models/evidence below are explicit test fixtures, never deployment
calibration. FixtureAuthority is a call-wiring double, NOT a public validator or
an alternative native codec; native qualification remains an integration gate.
The durability scenarios use the real local Journal and real pure simulator.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from vertex_execution.exact import timestamp
from vertex_execution.journal import Journal
from vertex_execution.ports import ExecutionError, MutationGrant
from vertex_execution.simulator import (
    AcceptanceResolution, AdmittedLimits, BookLevel, DepthSnapshot,
    QualifiedInstrument, QualifiedLeg, SessionModel, SimulationBounds, SubmitCommand,
)
from vertex_execution.simulator_bridge import (
    DurablePaperTransport, _CheckpointCodec, _fixed, _read_json,
)

D = Decimal
PAYLOAD = "a" * 64
KEY = "fixture-order-1"
PROVENANCE = "fixture-qualified-paper-stream-v1"


class FixtureAuthority:
    def __init__(self):
        self.validation_result = True
        self.validated = []
        self.times = {timestamp(value): value for value in (50, 10000)}

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.validated.append((contract_name, payload, schema_version))
        return self.validation_result

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, value):
        return self.times[value]


class FixtureDecoder:
    """Reversible private fixture record, not a copied public contract schema."""

    def __init__(self, authority):
        self.authority = authority
        self.transform = lambda value: value

    def encode(self, command):
        value = _CheckpointCodec().pack(command)
        for field in ("submission_key", "payload_hash", "submitted_at_ns"):
            del value["fields"][field]
        return self.authority.encode(value)

    def decode(self, *, command_bytes, submission_key, payload_sha256, now_ns):
        value = json.loads(command_bytes)
        value["fields"].update(submission_key=submission_key, payload_hash=payload_sha256,
                               submitted_at_ns={"integer": str(now_ns)})
        return self.transform(_CheckpointCodec().unpack(value))


class FixtureMutationAuthority:
    def __init__(self):
        self.allowed = True

    def verify(self, grant, *, now_ns):
        return self.allowed


def qualified_model(**changes):
    model = SessionModel(
        model_id="fixture-model", instrument_id="fixture-instrument", symbol="FIXTURE",
        session_id="fixture-session", session_open_ns=100, session_close_ns=10000,
        submit_latency_ns=10, cancel_latency_ns=20, quote_ttl_ns=1000,
        participation_rate=D("0.25"), depth_fraction=D("0.5"), maximum_fill_quantity=D("20"),
        fee_per_unit=D("0.1"), fee_rate=D("0.001"), minimum_fee=D("0.25"),
        slippage_bps=D("0"), slippage_ticks=1, acceptance="accepted",
    )
    return replace(model, **changes)


def qualified_command(*, side="buy", multiplier="1", **changes):
    instrument = QualifiedInstrument(
        "fixture-instrument", "FIXTURE", "fixture-session", "USD", "equity",
        D("0.01"), D("1"), D(multiplier), "fixture-qualification-v1",
    )
    leg = QualifiedLeg("fixture-leg", instrument, side, D("1"),
                       D("10.10") if side == "buy" else D("9.80"), "fixture-model")
    command = SubmitCommand(KEY, PAYLOAD, (leg,), D("10"),
        AdmittedLimits(D("10"), D("100000"), D("1000"), D("10"), 100, 9500),
        "fixture-strategy-immutable-v1", "fixture-policy-v1", 100, 9000)
    return replace(command, **changes)


def qualified_depth(*, at=110, sequence=1, volume="40", quantity="20"):
    return DepthSnapshot("fixture-instrument", "FIXTURE", "fixture-session", at, sequence,
        (BookLevel(D("9.90"), D(quantity)),), (BookLevel(D("10.00"), D(quantity)),), D(volume))


class DurablePaperTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "paper.sqlite"
        self.authority = FixtureAuthority()
        self.decoder = FixtureDecoder(self.authority)
        self.mutations = FixtureMutationAuthority()
        self.journal = self.open_journal()
        self.journal.claim(now_ns=1)
        self.journal.append("observation", {"sourceSequence": "1", "cash": "1000000", "positions": {}},
                            now_ns=2, event_id="fixture-observation")
        self.journal.append("reconciled", {}, now_ns=3, event_id="fixture-reconciled")
        self.journal.append("reset", {}, now_ns=4, event_id="fixture-reset")
        self.bridge = self.make_bridge()

    def tearDown(self):
        self.journal.close()
        self.directory.cleanup()

    def open_journal(self):
        return Journal(self.path, authority=self.authority, account_alias="fixture-paper-account",
                       simulator_id="fixture-paper-simulator", currency="USD")

    def make_bridge(self, **changes):
        options = dict(journal=self.journal, models=(qualified_model(),), provenance_id=PROVENANCE,
                       decoder=self.decoder, mutation_authority=self.mutations)
        options.update(changes)
        return DurablePaperTransport(**options)

    def reserve_and_mark(self, command=None, *, mark=True, extra=None):
        command = command or qualified_command()
        encoded = self.decoder.encode(command)
        data = {
            "submissionKey": command.submission_key, "payloadSha256": command.payload_hash,
            "intent": {"fixtureOnly": "not-a-native-admission-fixture"},
            "admission": {"strategyVersion": command.strategy_artifact_id, "policyVersion": command.policy_id,
                          "maximumNotional": "100000", "maximumLoss": "100000",
                          "admittedAt": timestamp(50), "expiresAt": timestamp(10000)},
            "strategyArtifactId": command.strategy_artifact_id, "strategySha256": "b" * 64,
            "cashReserve": "100000", "shareReserve": {}, "maximumLoss": "100000",
            "maximumNotional": "100000", "command": json.loads(encoded), "riskValidUntilNs": "9500",
            "legs": {leg.instrument.instrument_id: {"side": leg.side,
                      "maximumQuantity": _fixed(Fraction(command.maximum_quantity) * Fraction(leg.ratio)),
                      "filled": "0"} for leg in command.legs},
            "settlementRequired": True, "reservationState": "reserved", "status": "not-submitted",
            "dispatchMarked": False, "cancelRequested": False, "finalityProven": False,
            "reconciledEpoch": str(self.journal.epoch), "orderRef": None, "events": {}, "fills": {},
        }
        if extra is not None:
            data.update(extra)
        self.journal.append("reserve", data, now_ns=90, event_id="reserve-" + command.submission_key)
        if mark:
            self.journal.append("dispatch", {"submissionKey": command.submission_key,
                "payloadSha256": command.payload_hash}, now_ns=command.submitted_at_ns,
                event_id="dispatch-" + command.submission_key)
        return encoded

    def submit(self, command=None):
        command = command or qualified_command()
        encoded = self.reserve_and_mark(command)
        return self.bridge.submit(command.submission_key, command.payload_hash, encoded,
                                  now_ns=command.submitted_at_ns)

    def ingest(self, events):
        for event in events:
            self.journal.append("paper-event", DurablePaperTransport._event_data(event),
                                now_ns=event.occurred_ns, event_id="fixture-ingest-" + event.event_id)

    def committed(self, sql):
        # Independent read-only view of committed bytes. A SQLite failure inside
        # Journal.transaction poisons the owner instance, so failure-path checks
        # must not read through it.
        connection = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        try:
            return connection.execute(sql).fetchone()
        finally:
            connection.close()

    def row(self):
        return self.committed("SELECT generation,owner_epoch,sha256,payload FROM paper_simulator_checkpoint WHERE slot=1")

    def restore_row(self, row):
        with self.journal.transaction():
            self.journal._db().execute(
                "UPDATE paper_simulator_checkpoint SET generation=?,owner_epoch=?,sha256=?,payload=? WHERE slot=1", row)

    def decoded_checkpoint(self):
        return _CheckpointCodec().unpack(_read_json(self.row()[3])["simulator"])

    def batch_fixture(self, *, first_notional="100000"):
        command = qualified_command()
        second = replace(command.legs[0], leg_id="fixture-second-leg", model_id="fixture-second-model",
                         instrument=replace(command.legs[0].instrument, instrument_id="fixture-second",
                                            symbol="SECOND", qualification_id="fixture-second-qualification"))
        gross_cap = _fixed(Fraction(D(first_notional)) + Fraction(100000))
        command = replace(command, legs=command.legs + (second,),
                          admitted_limits=replace(command.admitted_limits,
                                                  maximum_gross_notional=D(gross_cap), maximum_total_fees=D("2000")))
        second_model = replace(qualified_model(), model_id="fixture-second-model",
                               instrument_id="fixture-second", symbol="SECOND")
        self.bridge = self.make_bridge(models=(qualified_model(), second_model))
        records, bounds = [], []
        for index, leg in enumerate(command.legs):
            intent_id, review_id = f"fixture-intent-{index}", f"fixture-review-{index}"
            intent = {"accountAlias": "fixture-paper-account", "environment": "paper",
                      "strategyVersion": command.strategy_artifact_id, "intentId": intent_id,
                      "idempotencyKey": f"fixture-leg-{index}", "instrumentId": leg.instrument.instrument_id,
                      "side": leg.side, "quantity": "10", "maxLossBudget": "100000",
                      "proposedAt": timestamp(50), "expiresAt": timestamp(10000)}
            intent_hash = self.authority.digest(intent)
            review = {"reviewId": review_id, "reviewVersion": "1", "artifactId": intent_id,
                      "artifactSha256": intent_hash, "actorId": "fixture-human",
                      "accountAlias": "fixture-paper-account", "environment": "paper",
                      "strategyVersion": command.strategy_artifact_id, "policyVersion": command.policy_id,
                      "decision": "accepted", "purpose": "paper-simulation", "collectionId": "fixture-collection",
                      "reviewedAt": timestamp(50), "expiresAt": timestamp(10000)}
            admission = {"accountAlias": "fixture-paper-account", "environment": "paper",
                         "simulatorId": "fixture-paper-simulator", "streamId": "fixture-stream",
                         "ownerEpoch": str(self.journal.epoch), "actorId": "fixture-human",
                         "strategyVersion": command.strategy_artifact_id, "policyVersion": command.policy_id,
                         "portfolioSnapshotId": "fixture-observation", "portfolioSequence": "1",
                         "reviewId": review_id, "reviewVersion": "1", "intentId": intent_id,
                         "idempotencyKey": intent["idempotencyKey"], "intentSha256": intent_hash,
                         "reviewedArtifactSha256": intent_hash, "maximumLoss": "100000",
                         "maximumNotional": "100000", "admittedAt": timestamp(50), "expiresAt": timestamp(10000)}
            record = {"intentArtifactId": intent_id, "intentSha256": intent_hash,
                      "admissionArtifactId": f"fixture-admission-{index}",
                      "admissionSha256": self.authority.digest(admission),
                      "reviewArtifactId": review_id, "reviewSha256": self.authority.digest(review),
                      "strategyArtifactId": command.strategy_artifact_id, "strategySha256": "b" * 64,
                      "intent": intent, "admission": admission, "review": review}
            records.append(record)
            bounds.append({"intentSha256": intent_hash, "admissionSha256": record["admissionSha256"],
                           "instrumentId": leg.instrument.instrument_id, "side": leg.side, "quantity": "10",
                           "maximumLoss": "100000", "maximumNotional": first_notional if index == 0 else "100000",
                           "cashReservation": "100000", "costReservation": "1000",
                           "settlementCash": "0", "settlementRequired": True})
        metadata = [{name: value for name, value in record.items() if name not in {"intent", "admission", "review"}}
                    for record in records]
        batch = {"accountAlias": "fixture-paper-account", "environment": "paper",
                 "idempotencyKey": "fixture-atomic-batch", "legs": metadata}
        digest = self.authority.digest(batch)
        command = replace(command, payload_hash=digest)
        evidence = {"commandSha256": self.authority.digest(json.loads(self.decoder.encode(command))),
                    "orderedLegs": bounds}
        extra = {"batch": batch, "batchDigest": digest, "batchLegs": records, "batchEvidence": evidence,
                 "intent": records[0]["intent"], "admission": records[0]["admission"],
                 "maximumLoss": "200000", "maximumNotional": gross_cap, "cashReserve": "200000"}
        return command, extra

    def test_constructor_does_not_start_engine_or_create_private_table(self):
        with patch("vertex_execution.simulator_bridge.PaperSimulator") as engine:
            bridge = self.make_bridge()
        engine.assert_not_called()
        self.assertIsNone(self.journal._db().execute(
            "SELECT name FROM sqlite_master WHERE name='paper_simulator_checkpoint'"
        ).fetchone())
        self.assertFalse(bridge.reconcile(KEY, PAYLOAD, now_ns=100).recovered_state_proven)
        self.assertTrue(bridge.simulation_only)
        self.assertFalse(bridge.broker_submission_allowed)

    def test_accepted_state_is_durable_before_submit_returns(self):
        self.bridge.initialize()
        events = self.submit()
        checkpoint = self.decoded_checkpoint()
        self.assertEqual(checkpoint.orders[0].events[0].event_id, events[0].event_id)
        self.assertEqual(events[0].kind, "accepted")
        self.assertEqual(self.row()[0], 2)
        self.assertFalse(self.journal._db().in_transaction)
        self.assertEqual({name for name, _, _ in self.authority.validated},
                         {"PaperSimulationAdmission", "TradeIntent"})

    def test_fill_cash_is_exact_qualified_multiplier_and_fee_is_separate(self):
        self.bridge.initialize()
        self.submit(qualified_command(multiplier="25"))
        with localcontext() as context:
            context.prec = 4
            fills = self.bridge.advance((qualified_depth(),), 110)
        self.assertEqual(len(fills), 1)
        self.assertEqual((fills[0].quantity, fills[0].cash_delta, fills[0].fee), ("10", "-2502.5", "3.5025"))
        self.assertEqual(self.decoded_checkpoint().orders[0].events[-1].fill_id, fills[0].fill_id)
        result = self.bridge.reconcile(KEY, PAYLOAD, now_ns=110)
        self.assertEqual(result.status, "filled")
        self.assertEqual(result.cumulative_fills, (("fixture-instrument", "10"),))
        self.assertTrue(result.terminal and result.finality_proven and result.recovered_state_proven)
        self.assertEqual(set(result.final_event_ids), {event.event_id for event in result.events})

    def test_sell_credit_has_positive_gross_and_does_not_net_fees(self):
        self.bridge.initialize()
        self.submit(qualified_command(side="sell", multiplier="25"))
        fills = self.bridge.advance((qualified_depth(),), 110)
        self.assertEqual((fills[0].cash_delta, fills[0].fee), ("2472.5", "3.4725"))
        # The transport never books or matures balances itself.
        self.assertEqual(self.journal.state["cash"], "1000000")
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_decimal_scale_loss_or_overflow_is_rejected_not_rounded(self):
        with self.assertRaisesRegex(ExecutionError, "journal-scale"):
            _fixed(D("0.0000000000000000001"))
        with self.assertRaisesRegex(ExecutionError, "overflow"):
            _fixed(D("1000000000000000000000000000000"))

    def test_missing_durable_dispatch_rejects_before_engine_submission(self):
        self.bridge.initialize()
        encoded = self.reserve_and_mark(mark=False)
        before = self.row()
        with self.assertRaisesRegex(ExecutionError, "dispatch"):
            self.bridge.submit(KEY, PAYLOAD, encoded, now_ns=100)
        self.assertEqual(self.row(), before)
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_decoder_exact_inverse_identity_and_native_true_only_are_required(self):
        variants = (
            (lambda command: replace(command, payload_hash="c" * 64), True),
            (lambda command: replace(command, submission_key="wrong-key"), True),
            (lambda command: replace(command, strategy_artifact_id="wrong-strategy"), True),
            (lambda command: replace(command, maximum_quantity=D("9")), True),
            (lambda command: command, 1),
        )
        self.bridge.initialize()
        encoded = self.reserve_and_mark()
        before = self.row()
        for transform, validation_result in variants:
            with self.subTest(transform=transform, validation_result=validation_result):
                # Restore after the dispatch intentionally cannot submit the old
                # marker; exercise independent qualification at its pure seam.
                command = self.decoder.decode(command_bytes=encoded, submission_key=KEY,
                                              payload_sha256=PAYLOAD, now_ns=100)
                self.authority.validation_result = validation_result
                with self.assertRaises(ExecutionError):
                    self.bridge._binding(transform(command), KEY, PAYLOAD, encoded, 100)
        self.assertEqual(self.row(), before)

    def test_admitted_caps_leg_direction_and_strategy_are_independent_of_inverse(self):
        self.bridge.initialize()
        encoded = self.reserve_and_mark()
        command = qualified_command()
        changed = (
            replace(command, admitted_limits=replace(command.admitted_limits, maximum_gross_notional=D("100001"))),
            replace(command, admitted_limits=replace(command.admitted_limits, valid_until_ns=9501)),
            replace(command, strategy_artifact_id="wrong-strategy"),
            replace(command, policy_id="wrong-policy"),
            replace(command, legs=(replace(command.legs[0], side="sell"),)),
        )
        with patch.object(self.decoder, "encode", return_value=encoded):
            for value in changed:
                with self.subTest(value=value), self.assertRaises(ExecutionError):
                    self.bridge._binding(value, KEY, PAYLOAD, encoded, 100)

    def test_repeated_submit_never_calls_pure_engine_again(self):
        self.bridge.initialize()
        accepted = self.submit()
        with self.assertRaisesRegex(ExecutionError, "resubmit"):
            self.bridge.submit(KEY, PAYLOAD, self.decoder.encode(qualified_command()), now_ns=101)
        self.assertEqual(self.bridge.reconcile(KEY, PAYLOAD, now_ns=101).events, accepted)

    def test_persist_failure_poisons_instance_retains_reservation_and_no_retry(self):
        self.bridge.initialize()
        encoded = self.reserve_and_mark()
        before = self.row()
        with patch.object(self.bridge, "_persist", side_effect=sqlite3.OperationalError("fixture-disk-full")):
            with self.assertRaises(sqlite3.OperationalError):
                self.bridge.submit(KEY, PAYLOAD, encoded, now_ns=100)
        self.assertEqual(self.row(), before)
        self.assertFalse(self.bridge.reconcile(KEY, PAYLOAD, now_ns=100).recovered_state_proven)
        with self.assertRaisesRegex(ExecutionError, "retain-reservations"):
            self.bridge.submit(KEY, PAYLOAD, encoded, now_ns=100)
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")
        self.assertTrue(self.journal.state["orders"][KEY]["dispatchMarked"])

    def test_advance_commit_rollback_exposes_no_fills(self):
        self.bridge.initialize()
        self.submit()
        before = self.row()
        transaction = self.journal.transaction

        @contextmanager
        def rollback_at_commit():
            with transaction():
                yield
                raise sqlite3.OperationalError("fixture-commit-failed")

        with patch.object(self.journal, "transaction", rollback_at_commit):
            with self.assertRaises(sqlite3.OperationalError):
                self.bridge.advance((qualified_depth(),), 110)
        self.assertEqual(self.row(), before)
        self.assertFalse(self.bridge.reconcile(KEY, PAYLOAD, now_ns=110).finality_proven)
        self.assertEqual(self.journal.state["cash"], "1000000")

    def test_uncertain_successful_commit_recovers_history_without_retry(self):
        self.bridge.initialize()
        accepted = self.submit()
        transaction = self.journal.transaction

        @contextmanager
        def commit_then_disconnect():
            with transaction():
                yield
            raise sqlite3.OperationalError("fixture-lost-commit-acknowledgement")

        with patch.object(self.journal, "transaction", commit_then_disconnect):
            with self.assertRaises(sqlite3.OperationalError):
                self.bridge.advance((qualified_depth(),), 110)
        self.assertFalse(self.bridge.reconcile(KEY, PAYLOAD, now_ns=110).recovered_state_proven)
        recovered = self.make_bridge()
        recovered.restore()
        result = recovered.reconcile(KEY, PAYLOAD, now_ns=110)
        self.assertEqual(result.events[0], accepted[0])
        self.assertEqual([event.kind for event in result.events], ["accepted", "fill"])
        self.assertTrue(result.finality_proven)
        with self.assertRaisesRegex(ExecutionError, "resubmit"):
            recovered.submit(KEY, PAYLOAD, self.decoder.encode(qualified_command()), now_ns=110)

    def test_real_journal_reopen_new_epoch_preserves_event_identity_and_all_history(self):
        self.bridge.initialize()
        accepted = self.submit()
        fills = self.bridge.advance((qualified_depth(),), 110)
        self.ingest(accepted + fills)
        self.journal.close()
        self.journal = self.open_journal()
        self.journal.claim(now_ns=120)
        recovered = self.make_bridge()
        recovered.restore()
        result = recovered.reconcile(KEY, PAYLOAD, now_ns=120)
        self.assertEqual(result.events, accepted + fills)
        self.assertTrue(result.recovered_state_proven)
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_checkpoint_at_epoch_claim_anchor_restores(self):
        self.journal.claim(now_ns=5)
        self.bridge.initialize()
        recovered = self.make_bridge()
        recovered.restore()
        self.assertFalse(recovered.reconcile(KEY, PAYLOAD, now_ns=100).recovered_state_proven)

    def test_crash_after_dispatch_before_checkpoint_is_unknown_forever_not_absence(self):
        self.bridge.initialize()
        encoded = self.reserve_and_mark()
        recovered = self.make_bridge()
        recovered.restore()
        result = recovered.reconcile(KEY, PAYLOAD, now_ns=100)
        self.assertEqual(result.status, "unknown")
        self.assertFalse(result.terminal or result.finality_proven or result.recovered_state_proven)
        self.assertEqual(result.events, ())
        with self.assertRaisesRegex(ExecutionError, "unseen-dispatch"):
            recovered.submit(KEY, PAYLOAD, encoded, now_ns=100)
        with self.assertRaisesRegex(ExecutionError, "existing-dispatch"):
            self.make_bridge().initialize()
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_restore_missing_table_never_initializes_replacement_engine(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.bridge.restore()
        self.assertFalse(self.bridge.reconcile(KEY, PAYLOAD, now_ns=100).recovered_state_proven)
        self.assertIsNone(self.committed("SELECT name FROM sqlite_master WHERE name='paper_simulator_checkpoint'"))
        with self.assertRaisesRegex(ExecutionError, "closed-forked-or-uncertain-owner"):
            self.journal._db()

    def test_existing_checkpoint_cannot_be_initialized_over(self):
        self.bridge.initialize()
        before = self.row()
        with self.assertRaisesRegex(ExecutionError, "requires-restore"):
            self.make_bridge().initialize()
        self.assertEqual(self.row(), before)

    def test_model_provenance_and_bounds_changes_fail_closed_on_restore(self):
        self.bridge.initialize()
        self.submit()
        options = (
            {"models": (qualified_model(fee_rate=D("0.002")),)},
            {"provenance_id": "wrong-stream"},
            {"bounds": SimulationBounds(max_orders=255)},
        )
        for changes in options:
            with self.subTest(changes=changes), self.assertRaises((ExecutionError, ValueError)):
                self.make_bridge(**changes).restore()

    def test_corrupt_envelope_hash_or_foreign_scope_cannot_restore(self):
        self.bridge.initialize()
        before = self.row()
        tampered = (before[0], before[1], "f" * 64, before[3])
        self.restore_row(tampered)
        with self.assertRaisesRegex(ExecutionError, "integrity"):
            self.make_bridge().restore()
        envelope = _read_json(before[3])
        envelope["scope"]["accountAlias"] = "another-account"
        self.restore_row((before[0], before[1], self.authority.digest(envelope), self.authority.encode(envelope)))
        with self.assertRaisesRegex(ExecutionError, "scope"):
            self.make_bridge().restore()

    def test_old_checkpoint_cannot_forget_already_journaled_fills(self):
        self.bridge.initialize()
        accepted = self.submit()
        before = self.row()
        fills = self.bridge.advance((qualified_depth(),), 110)
        self.ingest(accepted + fills)
        self.restore_row(before)
        with self.assertRaisesRegex(ExecutionError, "behind-journal-effects"):
            self.make_bridge().restore()
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_stale_epoch_and_competing_checkpoint_writer_are_fenced(self):
        self.bridge.initialize()
        self.submit()
        other = self.make_bridge()
        other.restore()
        self.bridge.advance((), 101)
        with self.assertRaisesRegex(ExecutionError, "writer-conflict"):
            other.advance((), 102)
        self.journal.claim(now_ns=103)
        with self.assertRaisesRegex(ExecutionError, "stale-simulator-owner-epoch"):
            self.bridge.advance((), 104)

    def test_cancel_ack_is_not_final_and_racing_fills_are_in_final_history(self):
        self.bridge.initialize()
        self.submit()
        self.bridge.advance((qualified_depth(volume="8"),), 110)
        grant = MutationGrant("fixture-cancel", "cancel-simulation", "fixture-paper-account", "paper",
                              self.journal.epoch, KEY, "fixture-human", 111, 1000, "d" * 64)
        self.journal.append("cancel-request", {"submissionKey": KEY, "payloadSha256": PAYLOAD,
                            "grantId": grant.grant_id}, now_ns=111, event_id="cancel-" + grant.grant_id)
        acknowledgement = self.bridge.cancel(KEY, grant, now_ns=111)
        self.assertEqual(len(acknowledgement), 1)
        self.assertFalse(self.bridge.reconcile(KEY, PAYLOAD, now_ns=111).terminal)
        self.bridge.advance((qualified_depth(at=120, sequence=2, volume="8"),), 120)
        self.bridge.advance((), 131)
        result = self.bridge.reconcile(KEY, PAYLOAD, now_ns=131)
        self.assertEqual(result.status, "cancelled")
        self.assertTrue(result.finality_proven)
        self.assertEqual(result.cumulative_fills, (("fixture-instrument", "4"),))
        self.assertEqual(len(result.events), 5)
        self.assertEqual(result.final_event_ids, tuple(event.event_id for event in result.events))
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_cancel_requires_exact_scope_verified_authority_and_durable_marker(self):
        self.bridge.initialize()
        self.submit()
        grant = MutationGrant("fixture-cancel", "cancel-simulation", "fixture-paper-account", "paper",
                              self.journal.epoch, KEY, "fixture-human", 111, 1000, "d" * 64)
        for invalid in (replace(grant, environment="live"), replace(grant, owner_epoch=0),
                        replace(grant, submission_key="wrong-order"), replace(grant, expires_ns=111)):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ExecutionError, "grant-invalid"):
                self.bridge.cancel(KEY, invalid, now_ns=111)
        self.mutations.allowed = 1
        with self.assertRaisesRegex(ExecutionError, "grant-invalid"):
            self.bridge.cancel(KEY, grant, now_ns=111)
        self.mutations.allowed = True
        with self.assertRaisesRegex(ExecutionError, "durable-marker"):
            self.bridge.cancel(KEY, grant, now_ns=111)

    def test_known_unknown_acceptance_stays_nonfinal_until_explicit_resolution(self):
        self.bridge = self.make_bridge(models=(qualified_model(acceptance="unknown"),))
        self.bridge.initialize()
        self.submit()
        result = self.bridge.reconcile(KEY, PAYLOAD, now_ns=100)
        self.assertEqual(result.status, "unknown")
        self.assertTrue(result.recovered_state_proven)
        self.assertFalse(result.terminal or result.finality_proven)
        self.bridge.advance((AcceptanceResolution(KEY, PAYLOAD, 120, "accepted", "fixture-resolution"),), 120)
        resolved = self.bridge.reconcile(KEY, PAYLOAD, now_ns=120)
        self.assertEqual(resolved.status, "submitted")
        self.assertFalse(resolved.terminal)

    def test_atomic_batch_uses_aggregate_notional_and_replays_both_reviewed_legs(self):
        command, extra = self.batch_fixture()
        self.bridge.initialize()
        encoded = self.reserve_and_mark(command, extra=extra)
        accepted = self.bridge.submit(KEY, command.payload_hash, encoded, now_ns=100)
        second = replace(qualified_depth(), instrument_id="fixture-second", symbol="SECOND")
        fills = self.bridge.advance((qualified_depth(), second), 110)
        result = self.bridge.reconcile(KEY, command.payload_hash, now_ns=110)
        self.assertTrue(result.finality_proven)
        self.assertEqual(result.events, accepted + fills)
        self.assertEqual(result.cumulative_fills, (("fixture-instrument", "10"), ("fixture-second", "10")))
        self.assertEqual({event.instrument_id for event in fills}, {"fixture-instrument", "fixture-second"})
        self.assertIn("AcceptedReview", {name for name, _, _ in self.authority.validated})
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")

    def test_atomic_batch_rejects_reordering_hash_mismatch_and_independent_cap_breach(self):
        command, extra = self.batch_fixture()
        self.bridge.initialize()
        encoded = self.reserve_and_mark(command, extra=extra)
        order = self.journal.state["orders"][KEY]
        reordered = deepcopy(order["batchEvidence"])
        reordered["orderedLegs"].reverse()
        excessive = deepcopy(order["batchEvidence"])
        excessive["orderedLegs"][1]["maximumNotional"] = "100001"
        wrong_hash = deepcopy(order["batchEvidence"])
        wrong_hash["commandSha256"] = "f" * 64
        wrong_review = deepcopy(order["batchLegs"])
        wrong_review[1]["review"]["decision"] = "rejected"
        for changed in ({"batchEvidence": reordered}, {"batchEvidence": excessive},
                        {"batchEvidence": wrong_hash}, {"batchLegs": wrong_review}):
            with self.subTest(changed=changed), patch.dict(order, changed):
                with self.assertRaises(ExecutionError):
                    self.bridge._binding(command, KEY, command.payload_hash, encoded, 100)

    def test_multileg_command_without_independently_reviewed_batch_is_rejected(self):
        command, _ = self.batch_fixture()
        self.bridge.initialize()
        encoded = self.reserve_and_mark(command)
        with self.assertRaisesRegex(ExecutionError, "unreviewed-extra"):
            self.bridge.submit(KEY, command.payload_hash, encoded, now_ns=100)

    def test_atomic_batch_does_not_allow_one_leg_to_spend_another_leg_cap(self):
        command, extra = self.batch_fixture(first_notional="50")
        self.bridge.initialize()
        encoded = self.reserve_and_mark(command, extra=extra)
        self.bridge.submit(KEY, command.payload_hash, encoded, now_ns=100)
        before = self.row()
        with self.assertRaisesRegex(ExecutionError, "independent-leg-cap"):
            self.bridge.advance((qualified_depth(),), 110)
        self.assertEqual(self.row(), before)
        self.assertFalse(self.bridge.reconcile(KEY, command.payload_hash, now_ns=110).recovered_state_proven)
        self.assertEqual(self.journal.state["orders"][KEY]["reservationState"], "reserved")


class BoundedCheckpointCodecTests(unittest.TestCase):
    def test_decimal_dataclasses_round_trip_without_pickle_or_dynamic_import(self):
        command = qualified_command(multiplier="25")
        encoded = _CheckpointCodec().pack(command)
        self.assertEqual(_CheckpointCodec().unpack(encoded), command)

    def test_non_allowlisted_type_extra_fields_and_wrong_scalar_types_fail(self):
        invalid = (
            {"record": "os.system", "fields": {}}, {"integer": True},
            {"decimal": "NaN"}, {"decimal": "1E+999999"}, {"decimal": 1.0},
            {"tuple": "not-a-list"}, {"integer": "01"}, {"integer": "9223372036854775808"},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ExecutionError):
                _CheckpointCodec().unpack(value)
        encoded = _CheckpointCodec().pack(qualified_command())
        encoded["fields"]["submitted_at_ns"] = True
        with self.assertRaisesRegex(ExecutionError, "field-type"):
            _CheckpointCodec().unpack(encoded)
        encoded = _CheckpointCodec().pack(qualified_command())
        encoded["fields"]["unexpected"] = "field"
        with self.assertRaisesRegex(ExecutionError, "field-set"):
            _CheckpointCodec().unpack(encoded)

    def test_depth_tuple_node_and_byte_bounds_fail_closed(self):
        nested = "leaf"
        for _ in range(34):
            nested = {"tuple": [nested]}
        with self.assertRaisesRegex(ExecutionError, "resource-bound"):
            _CheckpointCodec().unpack(nested)
        with self.assertRaisesRegex(ExecutionError, "tuple-bound"):
            _CheckpointCodec().pack((None,) * 65_537)
        codec = _CheckpointCodec()
        codec.remaining = 0
        with self.assertRaisesRegex(ExecutionError, "resource-bound"):
            codec.pack(None)
        with self.assertRaisesRegex(ExecutionError, "byte-bound"):
            _read_json(b" " * (16 * 1024 * 1024 + 1))

    def test_json_duplicate_keys_numbers_and_deep_input_rejected(self):
        invalid = (b'{"x":null,"x":null}', b'{"x":NaN}', b'{"x":1}', b'{"x":0.1}',
                   b"[" * 100 + b"null" + b"]" * 100)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ExecutionError):
                _read_json(value)
