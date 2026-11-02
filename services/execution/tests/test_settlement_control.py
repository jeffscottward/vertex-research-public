"""Source-only settlement boundary proofs; no disk, native engine, or broker IO.

The journal double applies the production reducer atomically to copied state.
Evidence/authority doubles are intentionally local test capabilities, not public
schema replacements or a deployable qualification implementation.
"""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
import json
from threading import RLock
import unittest

from vertex_execution.journal import apply_event, initial_state, reserved
from vertex_execution.native_risk import NativeRiskPort, QualifiedRiskInputs
from vertex_execution.owner import PaperExecutionOwner
from vertex_execution.ports import ExecutionError
from vertex_execution.settlement import (
    ExerciseInstruction,
    OptionPosition,
    SettlementPolicy,
    SettlementRequest,
    UnderlyingObservation,
    settle_option,
)
from vertex_execution.settlement_control import SettlementController, TradeSettlementProof
from vertex_execution.simulator import ExpirySchedule, OptionTerms, QualifiedInstrument

D = Decimal
NS = 1_000_000_000
HASH = "a" * 64
PAYLOAD = "b" * 64
KEY = "submission:option"


def epoch_ns(value):
    delta = datetime.fromisoformat(value) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * NS + delta.microseconds * 1000


FIXING = epoch_ns("2026-09-18T16:00:00-04:00")
CUTOFF = epoch_ns("2026-09-18T16:30:00-04:00")
DUE = epoch_ns("2026-09-21T09:30:00-04:00")
FILL_TIME = FIXING - 3600 * NS


class LocalAuthority:
    """Deterministic test double for the injected authority, not schema logic."""

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()


class ReducerJournal:
    def __init__(self, state):
        self.state = deepcopy(state)
        self.mutex = RLock()
        self.epoch = 1
        self.sequence = 0
        self.event_hash = "0" * 64
        self.events = []

    def _db(self):
        # Healthy synthetic owner-scope sentinel; no SQLite or filesystem access.
        return self

    def snapshot(self):
        return deepcopy(self.state), self.sequence, self.event_hash

    def append(self, kind, data, *, now_ns, event_id):
        for previous in self.events:
            if previous["eventId"] == event_id:
                if previous["kind"] != kind or previous["data"] != data:
                    raise ExecutionError("journal-idempotency-conflict")
                return self.sequence, self.event_hash
        candidate = deepcopy(self.state)
        event = {"kind": kind, "data": deepcopy(data), "eventId": event_id, "occurredNs": str(now_ns)}
        apply_event(candidate, event)
        self.state = candidate
        self.events.append(event)
        self.sequence += 1
        self.event_hash = LocalAuthority().digest(event)
        return self.sequence, self.event_hash


class QualifiedEvidence:
    def __init__(self):
        self.trade_result = True
        self.option_result = True
        self.requalification_result = True
        self.expected_trade_due = DUE
        self.trade_calls = []
        self.option_calls = []

    def verify_trade(self, proof, *, ledger, now_ns):
        self.trade_calls.append((proof, deepcopy(ledger), now_ns))
        if proof.due_ns != self.expected_trade_due:
            return False
        return self.trade_result

    def verify_options(self, events, *, submission_key, ledger, evidence_sha256, now_ns):
        self.option_calls.append((events, submission_key, deepcopy(ledger), evidence_sha256, now_ns))
        return self.option_result

    def verify_requalification(self, **kwargs):
        return self.requalification_result


def new_owner(*, cash="30000", shares="200"):
    state = initial_state("paper-account", "local-simulator", "USD")
    state.update(ownerEpoch="1", pausedNewRisk=False, reconciled=True, pauseReasons=[], cash=cash,
                 positions={"ABC": shares} if shares != "0" else {},
                 observation={"observedNs": str(FILL_TIME), "receivedNs": str(FILL_TIME)})
    # Constructor claims persistent ownership. This in-memory unit fixture uses
    # the real _scope method with an already-claimed, synthetic journal epoch.
    owner = object.__new__(PaperExecutionOwner)
    owner.journal = ReducerJournal(state)
    owner.authority = LocalAuthority()
    owner.epoch = 1
    owner._disruption_held = False
    return owner


def order_record(instrument_id, *, side="sell", quantity="2", settlement_required=True, cash_reserve="0", shares=None):
    return {
        "submissionKey": KEY,
        "payloadSha256": PAYLOAD,
        "strategyArtifactId": "immutable-strategy:1",
        "cashReserve": cash_reserve,
        "shareReserve": {} if shares is None else shares,
        "reservationState": "held",
        "settlementRequired": settlement_required,
        "dispatchMarked": False,
        "finalityProven": False,
        "status": "not-submitted",
        "cancelRequested": False,
        "orderRef": None,
        "reconciledEpoch": "1",
        "events": {},
        "fills": {},
        "kernelReservation": None,
        "legs": {instrument_id: {"side": side, "filled": "0", "maximumQuantity": quantity}},
    }


def seed_fill(owner, instrument_id, *, side="sell", quantity="2", cash_delta="1000", fee="1", settlement_required=True, cash_reserve="0", shares=None):
    record = order_record(instrument_id, side=side, quantity=quantity, settlement_required=settlement_required, cash_reserve=cash_reserve, shares=shares)
    journal = owner.journal
    journal.append("reserve", record, now_ns=FILL_TIME - 2, event_id="reserve:1")
    identity = {"submissionKey": KEY, "payloadSha256": PAYLOAD}
    journal.append("dispatch", identity, now_ns=FILL_TIME - 1, event_id="dispatch:1")
    fill = {**identity, "eventId": "source-fill:1", "eventKind": "fill", "fillId": "fill:1",
            "instrumentId": instrument_id, "quantity": quantity, "price": "5", "fee": fee,
            "cashDelta": cash_delta, "occurredNs": str(FILL_TIME), "orderRef": "paper-order:1"}
    journal.append("paper-event", fill, now_ns=FILL_TIME, event_id="paper-event:1")
    journal.append("finalized", {**identity, "finalEventIds": ["source-fill:1"], "evidenceSha256": HASH},
                   now_ns=FILL_TIME, event_id="finalized:1")
    return KEY + ":fill:1"


def option_request(*, right="call", settlement="physical", price="105", signed="-2"):
    expiry = ExpirySchedule("XNYS", "calendar:2026", "America/New_York", -14400,
                            "2026-09-18", "2026-09-18", (), "previous-business-day", "PM",
                            FIXING, FIXING, CUTOFF, DUE)
    terms = OptionTerms("ABC", right, D("100"), "american", settlement, D("100"), expiry)
    instrument = QualifiedInstrument("ABC:2026-09-18:" + right, "ABC-option-" + right, "2026-09-18:regular",
                                     "USD", "option", D("0.01"), D("1"), D("100"), "qualification:1", terms)
    observation = UnderlyingObservation("ABC", D(price), FIXING, "fixing:1", "PM", True)
    return SettlementRequest("settlement-request:1", OptionPosition("option-position:1", instrument, D(signed)), CUTOFF, observation)


def option_policy():
    return SettlementPolicy("settlement-policy:1", D("0.01"), D("0.05"), 86400 * NS, 60 * NS,
                            D("0.02"), D("0.5"), D("1000"), "conservative-economic")


def filled_option(*, right="call", settlement="physical", price="105", cash="30000", shares="200"):
    request = option_request(right=right, settlement=settlement, price=price)
    owner = new_owner(cash=cash, shares=shares)
    reserve_cash = "20000" if right == "put" and settlement == "physical" else "0"
    reserve_shares = {"ABC": "200"} if right == "call" and settlement == "physical" else {}
    seed_fill(owner, request.position.instrument.instrument_id, cash_reserve=reserve_cash, shares=reserve_shares)
    evidence = QualifiedEvidence()
    return owner, SettlementController(owner, evidence), evidence, request


def trade_proof(key, **changes):
    return replace(TradeSettlementProof("trade-proof:1", (key,), "paper-account", "local-simulator", 1,
                                        DUE, DUE, "calendar:2026", HASH), **changes)


class SettlementControllerTests(unittest.TestCase):
    def assert_unchanged(self, owner, before):
        self.assertEqual(owner.journal.snapshot(), before)

    def test_sale_fill_proceeds_are_unsettled_and_cannot_fund_new_reservation(self):
        owner = new_owner(cash="1", shares="2")
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", fee="1", settlement_required=False)
        ledger = owner.journal.state
        self.assertEqual(ledger["cash"], "0")
        self.assertEqual(ledger["unsettledCredits"], {fill_key: "5"})
        self.assertFalse(ledger["fillLineage"][fill_key]["settled"])
        self.assertEqual(ledger["positions"]["ABC"], "1")
        candidate = order_record("XYZ", side="buy", quantity="1", settlement_required=False, cash_reserve="1")
        candidate["submissionKey"] = "next-order"
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            owner.journal.append("reserve", candidate, now_ns=FILL_TIME + 1, event_id="cannot-spend-sale")
        self.assert_unchanged(owner, before)

    def test_bought_shares_are_positions_but_not_covered_share_authority(self):
        owner = new_owner(shares="0")
        fill_key = seed_fill(owner, "ABC", side="buy", quantity="10", cash_delta="-100", settlement_required=False)
        self.assertEqual(owner.journal.state["positions"]["ABC"], "10")
        self.assertEqual(owner.journal.state["unsettledPositions"][fill_key]["quantity"], "10")
        candidate = order_record("new-call", shares={"ABC": "10"})
        candidate["submissionKey"] = "next-covered-call"
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            owner.journal.append("reserve", candidate, now_ns=FILL_TIME + 1, event_id="cannot-cover-pending")
        self.assert_unchanged(owner, before)

    def test_trade_cash_and_shares_mature_at_exact_nanosecond_not_one_before(self):
        for side, cash_delta in (("sell", "100"), ("buy", "-100")):
            with self.subTest(side=side):
                owner = new_owner(shares="10")
                fill_key = seed_fill(owner, "ABC", side=side, quantity="1", cash_delta=cash_delta, settlement_required=False)
                controller = SettlementController(owner, QualifiedEvidence())
                proof = trade_proof(fill_key)
                before = owner.journal.snapshot()
                with self.assertRaises(ExecutionError):
                    controller.settle_trades(proof, now_ns=DUE - 1)
                self.assert_unchanged(owner, before)
                controller.settle_trades(proof, now_ns=DUE)
                ledger = owner.journal.state
                self.assertTrue(ledger["fillLineage"][fill_key]["settled"])
                self.assertNotIn(fill_key, ledger["unsettledCredits"])
                self.assertNotIn(fill_key, ledger["unsettledPositions"])
                self.assertEqual(ledger["cash"], "30099" if side == "sell" else "29899")

    def test_trade_maturity_requires_actual_calendar_evidence_not_a_fabricated_due(self):
        owner = new_owner()
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
        controller = SettlementController(owner, QualifiedEvidence())
        before = owner.journal.snapshot()
        forged = trade_proof(fill_key, due_ns=FILL_TIME, observed_ns=FILL_TIME)
        with self.assertRaises(ExecutionError):
            controller.settle_trades(forged, now_ns=FILL_TIME)
        self.assert_unchanged(owner, before)

    def test_trade_proof_account_simulator_epoch_and_exact_true_are_required(self):
        owner = new_owner()
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
        evidence = QualifiedEvidence()
        controller = SettlementController(owner, evidence)
        for proof in (trade_proof(fill_key, account_alias="wrong"), trade_proof(fill_key, simulator_id="wrong"),
                      trade_proof(fill_key, owner_epoch=2), trade_proof(fill_key, fill_keys=(fill_key, fill_key))):
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                controller.settle_trades(proof, now_ns=DUE)
            self.assert_unchanged(owner, before)
        for invalid in (False, 1, None, "verified"):
            evidence.trade_result = invalid
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                controller.settle_trades(trade_proof(fill_key), now_ns=DUE)
            self.assert_unchanged(owner, before)

    def test_unknown_or_mixed_fill_lineage_cannot_partially_mature_batch(self):
        owner = new_owner()
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
        controller = SettlementController(owner, QualifiedEvidence())
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_trades(trade_proof(fill_key, fill_keys=(fill_key, "missing-fill")), now_ns=DUE)
        self.assert_unchanged(owner, before)

    def test_repeated_trade_maturity_never_double_credits_cash(self):
        owner = new_owner()
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
        controller = SettlementController(owner, QualifiedEvidence())
        controller.settle_trades(trade_proof(fill_key), now_ns=DUE)
        cash = owner.journal.state["cash"]
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_trades(trade_proof(fill_key, proof_id="second-proof"), now_ns=DUE)
        self.assertEqual(owner.journal.state["cash"], cash)
        self.assert_unchanged(owner, before)

    def test_trade_epoch_and_nanosecond_fields_do_not_accept_bool_or_float_aliases(self):
        for changes in ({"owner_epoch": True}, {"owner_epoch": 1.0},
                        {"due_ns": float(DUE)}, {"observed_ns": float(DUE)}):
            owner = new_owner()
            fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
            controller = SettlementController(owner, QualifiedEvidence())
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                controller.settle_trades(trade_proof(fill_key, **changes), now_ns=DUE)
            self.assert_unchanged(owner, before)
        owner = new_owner()
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
        controller = SettlementController(owner, QualifiedEvidence())
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_trades(trade_proof(fill_key), now_ns=float(DUE))
        self.assert_unchanged(owner, before)

    def test_short_call_lifecycle_nets_fee_once_and_keeps_premium_unsettled(self):
        owner, controller, _, request = filled_option()
        event = settle_option(request, option_policy())
        self.assertEqual(event.cash_delta, D("19999"))
        self.assertEqual(event.fees, D("1"))
        self.assertEqual(owner.journal.state["orders"][KEY]["reservationState"], "settlement-held")
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        ledger = owner.journal.state
        self.assertEqual(ledger["cash"], "49998")
        self.assertEqual(ledger["positions"]["ABC"], "0")
        self.assertEqual(ledger["positions"][event.instrument_id], "0")
        self.assertEqual(ledger["unsettledCredits"][KEY + ":fill:1"], "1000")
        self.assertEqual(ledger["orders"][KEY]["reservationState"], "released")
        self.assertEqual(reserved(ledger), (0, {}))

    def test_short_put_lifecycle_pays_purchase_and_nets_fee_once(self):
        owner, controller, _, request = filled_option(right="put", price="95", shares="0")
        event = settle_option(request, option_policy())
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        ledger = owner.journal.state
        self.assertEqual(ledger["cash"], "9998")
        self.assertEqual(ledger["positions"]["ABC"], "200")
        self.assertEqual(ledger["positions"][event.instrument_id], "0")
        self.assertEqual(ledger["orders"][KEY]["reservationState"], "released")
        self.assertNotIn(event.event_id, ledger["unsettledPositions"])

    def test_cash_option_intrinsic_never_creates_delivery_and_fee_is_not_doubled(self):
        owner, controller, _, request = filled_option(settlement="cash", shares="0")
        event = settle_option(request, option_policy())
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        ledger = owner.journal.state
        self.assertEqual(ledger["cash"], "28998")
        self.assertEqual(ledger["positions"].get("ABC", "0"), "0")
        self.assertEqual(ledger["positions"][event.instrument_id], "0")

    def test_option_facts_preserve_explicit_kind_status_and_actual_fill_event_lineage(self):
        cases = (("-2", "105", "assignment"), ("2", "105", "exercise"), ("2", "90", "option-expiry"))
        for settlement_kind in ("cash", "physical"):
            for signed, price, fact_kind in cases:
                with self.subTest(settlement_kind=settlement_kind, fact_kind=fact_kind):
                    request = option_request(settlement=settlement_kind, signed=signed, price=price)
                    owner = new_owner()
                    buy = signed == "2"
                    seed_fill(owner, request.position.instrument.instrument_id, side="buy" if buy else "sell",
                              cash_delta="-1000" if buy else "1000")
                    controller = SettlementController(owner, QualifiedEvidence())
                    event = settle_option(request, option_policy())
                    source_event = owner.journal.state["orders"][KEY]["events"]["source-fill:1"]
                    self.assertEqual(source_event["eventKind"], "fill")
                    self.assertEqual(source_event["instrumentId"], event.instrument_id)
                    controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
                    record = owner.journal.events[-1]["data"]
                    self.assertEqual(record["strategyArtifactId"], "immutable-strategy:1")
                    self.assertEqual(len(record["optionFacts"]), 1)
                    fact = record["optionFacts"][0]
                    self.assertEqual(fact["kind"], fact_kind)
                    self.assertEqual(fact["settlementKind"], settlement_kind)
                    self.assertEqual(fact["settlementState"], "settled")
                    self.assertEqual(fact["settlementId"], event.event_id)
                    self.assertEqual(fact["instrumentId"], event.instrument_id)
                    self.assertEqual(fact["underlyingId"], event.underlying_id)
                    self.assertEqual(fact["quantity"], "2")
                    self.assertEqual(fact["currency"], "USD")
                    self.assertEqual(fact["fillEventIds"], [source_event["eventId"]])
                    self.assertEqual(fact["dueAt"], "2026-09-21T13:30:00.000000000Z")
                    self.assertEqual(D(fact["cashDelta"]), event.cash_delta)
                    self.assertEqual(D(fact["shareDelta"]), event.underlying_delta)
                    if fact_kind == "option-expiry":
                        self.assertEqual((fact["cashDelta"], fact["shareDelta"]), ("0", "0"))

    def test_option_fact_lineage_rejects_missing_wrong_instrument_and_unbounded_sources(self):
        for mode in ("missing", "wrong-instrument", "too-many"):
            with self.subTest(mode=mode):
                owner, controller, _, request = filled_option()
                events = owner.journal.state["orders"][KEY]["events"]
                original = deepcopy(events["source-fill:1"])
                if mode == "missing":
                    events.clear()
                elif mode == "wrong-instrument":
                    events["source-fill:1"]["instrumentId"] = "other-option"
                else:
                    for index in range(512):
                        identifier = "extra-fill:" + str(index)
                        events[identifier] = {**original, "eventId": identifier, "fillId": identifier}
                before = owner.journal.snapshot()
                with self.assertRaisesRegex(ExecutionError, "bounded-option-fill-lineage-required"):
                    controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)
                self.assert_unchanged(owner, before)

    def test_trade_settlement_fact_batch_rejects_more_than_512_fill_keys(self):
        owner = new_owner()
        fill_key = seed_fill(owner, "ABC", quantity="1", cash_delta="5", settlement_required=False)
        evidence = QualifiedEvidence()
        controller = SettlementController(owner, evidence)
        keys = (fill_key,) + tuple("source:" + str(index) for index in range(512))
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_trades(trade_proof(fill_key, fill_keys=keys), now_ns=DUE)
        self.assert_unchanged(owner, before)
        self.assertEqual(evidence.trade_calls, [])

    def test_recorded_pending_delivery_does_not_move_cash_shares_or_release_collateral(self):
        for right, price, shares in (("call", "105", "200"), ("put", "95", "0")):
            with self.subTest(right=right):
                owner, controller, _, request = filled_option(right=right, price=price, shares=shares)
                event = settle_option(request, option_policy())
                before = deepcopy(owner.journal.state)
                controller.record_option_obligations(KEY, (event,), evidence_sha256=HASH, now_ns=CUTOFF)
                ledger = owner.journal.state
                for field in ("cash", "positions", "unsettledCredits", "unsettledPositions", "fillLineage"):
                    self.assertEqual(ledger[field], before[field])
                self.assertEqual(reserved(ledger), reserved(before))
                self.assertEqual(ledger["orders"][KEY]["reservationState"], "settlement-held")
                self.assertTrue(ledger["pausedNewRisk"])
                self.assertFalse(ledger["reconciled"])
                self.assertEqual(len(ledger["optionObligations"]), 1)
                obligation = next(iter(ledger["optionObligations"].values()))
                fact = obligation["optionFacts"][0]
                self.assertEqual(fact["settlementState"], "pending")
                self.assertEqual(fact["settlementKind"], "physical")
                self.assertEqual(fact["fillEventIds"], ["source-fill:1"])
                self.assertEqual(D(fact["cashDelta"]), event.cash_delta)
                self.assertEqual(D(fact["shareDelta"]), event.underlying_delta)
                # The pending fact is durable evidence only, not an executable
                # transition and not permission to trade expected proceeds.
                fresh = order_record("NEW-risk", side="buy", quantity="1", cash_reserve="1")
                fresh["submissionKey"] = "new-risk-after-obligation"
                paused = owner.journal.snapshot()
                with self.assertRaises(ExecutionError):
                    owner.journal.append("reserve", fresh, now_ns=CUTOFF + 1, event_id="blocked-pending-risk")
                self.assert_unchanged(owner, paused)

    def test_pending_option_obligation_clears_only_at_full_exact_maturity(self):
        owner, controller, _, request = filled_option()
        event = settle_option(request, option_policy())
        controller.record_option_obligations(KEY, (event,), evidence_sha256=HASH, now_ns=CUTOFF)
        before = owner.journal.snapshot()
        # Same event is idempotent; it cannot compound the pending obligation.
        controller.record_option_obligations(KEY, (event,), evidence_sha256=HASH, now_ns=CUTOFF)
        self.assert_unchanged(owner, before)
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE - 1)
        self.assert_unchanged(owner, before)
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        ledger = owner.journal.state
        self.assertEqual(ledger["optionObligations"], {})
        self.assertEqual(ledger["cash"], "49998")
        self.assertEqual(ledger["positions"]["ABC"], "0")
        self.assertEqual(ledger["orders"][KEY]["reservationState"], "released")
        self.assertEqual(owner.journal.events[-1]["data"]["optionFacts"][0]["settlementState"], "settled")
        # Settlement does not bypass explicit reconciliation and new-risk reset.
        self.assertTrue(ledger["pausedNewRisk"])
        self.assertFalse(ledger["reconciled"])

    def test_partial_pending_assignment_stays_nonspendable_and_blocks_final_release(self):
        owner, controller, _, request = filled_option()
        decision = ExerciseInstruction("pending-partial:1", "assign", D("1"), CUTOFF)
        event = settle_option(replace(request, instruction=decision), option_policy())
        self.assertFalse(event.final)
        before_cash = owner.journal.state["cash"]
        before_positions = deepcopy(owner.journal.state["positions"])
        controller.record_option_obligations(KEY, (event,), evidence_sha256=HASH, now_ns=CUTOFF)
        pending = owner.journal.snapshot()
        fact = next(iter(owner.journal.state["optionObligations"].values()))["optionFacts"][0]
        self.assertEqual(fact["quantity"], "1")
        self.assertEqual(fact["settlementState"], "pending")
        self.assertEqual(owner.journal.state["cash"], before_cash)
        self.assertEqual(owner.journal.state["positions"], before_positions)
        self.assertEqual(owner.journal.state["orders"][KEY]["shareReserve"], {"ABC": "200"})
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        self.assert_unchanged(owner, pending)
        self.assertEqual(len(owner.journal.state["optionObligations"]), 1)

    def test_option_result_remains_nonspendable_until_calendar_maturity(self):
        owner, controller, _, request = filled_option()
        event = settle_option(request, option_policy())
        self.assertFalse(event.spendable_authority)
        before = owner.journal.snapshot()
        for now in (CUTOFF, DUE - 1):
            with self.assertRaises(ExecutionError):
                controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=now)
            self.assert_unchanged(owner, before)
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        self.assertEqual(owner.journal.state["orders"][KEY]["reservationState"], "released")

    def test_expired_contracts_close_at_explicit_qualified_due_without_delivery(self):
        owner, controller, _, request = filled_option(price="90")
        event = settle_option(request, option_policy())
        self.assertEqual(event.status, "expired")
        self.assertEqual(event.contracts, D("2"))
        self.assertEqual(event.remaining_contracts, D("0"))
        self.assertEqual(event.settlement_due_ns, request.position.instrument.option.schedule.settlement_due_ns)
        self.assertEqual(event.cash_delta, D("0"))
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE - 1)
        self.assert_unchanged(owner, before)
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        ledger = owner.journal.state
        self.assertEqual(ledger["positions"][event.instrument_id], "0")
        self.assertEqual(ledger["positions"]["ABC"], "200")
        self.assertEqual(ledger["cash"], "29999")
        self.assertEqual(ledger["orders"][KEY]["reservationState"], "released")

    def test_explicit_nonexercise_carries_closed_contracts_and_calendar_due(self):
        owner, controller, _, request = filled_option()
        instruction = ExerciseInstruction("no-assignment:1", "no-assignment", D("2"), CUTOFF)
        event = settle_option(replace(request, instruction=instruction), option_policy())
        self.assertEqual((event.status, event.contracts, event.remaining_contracts, event.settlement_due_ns),
                         ("expired", D("2"), D("0"), DUE))
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        self.assertEqual(owner.journal.state["positions"]["ABC"], "200")

    def test_pin_risk_and_partial_assignment_retain_all_collateral(self):
        for pin in (True, False):
            with self.subTest(pin=pin):
                owner, controller, _, request = filled_option(price="100.02" if pin else "105")
                if not pin:
                    request = replace(request, instruction=ExerciseInstruction("partial-assignment:1", "assign", D("1"), CUTOFF))
                event = settle_option(request, option_policy())
                self.assertFalse(event.final)
                before = owner.journal.snapshot()
                with self.assertRaises(ExecutionError):
                    controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
                self.assert_unchanged(owner, before)
                self.assertEqual(owner.journal.state["orders"][KEY]["shareReserve"], {"ABC": "200"})
                self.assertEqual(owner.journal.state["orders"][KEY]["reservationState"], "settlement-held")

    def test_option_settlement_requires_final_fill_lineage_full_quantity_and_currency(self):
        for change in ({"contracts": D("1")}, {"currency": "EUR"}, {"remaining_contracts": D("-1")},
                       {"settlement_due_ns": None}, {"occurred_at_ns": DUE + 1}, {"instrument_id": "wrong-option"}):
            owner, controller, _, request = filled_option()
            event = replace(settle_option(request, option_policy()), **change)
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
            self.assert_unchanged(owner, before)
        owner, controller, _, request = filled_option()
        owner.journal.state["orders"][KEY]["finalityProven"] = False
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)
        self.assert_unchanged(owner, before)

    def test_option_money_and_quantities_reject_float_coercion(self):
        for field, value in (("cash_delta", 19999.0), ("fees", 1.0), ("contracts", 2.0),
                             ("remaining_contracts", 0.0), ("underlying_delta", -200.0)):
            owner, controller, _, request = filled_option()
            event = replace(settle_option(request, option_policy()), **{field: value})
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
            self.assert_unchanged(owner, before)

    def test_options_require_verifier_exact_true_and_native_owner_epoch(self):
        for invalid in (False, 1, None, "yes"):
            owner, controller, evidence, request = filled_option()
            evidence.option_result = invalid
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)
            self.assert_unchanged(owner, before)
        owner, controller, _, request = filled_option()
        owner.epoch = 2
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)

    def test_short_call_cannot_deliver_unsettled_replacement_shares(self):
        owner, controller, _, request = filled_option()
        owner.journal.state["unsettledPositions"]["new-purchase"] = {"instrumentId": "ABC", "quantity": "1"}
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)
        self.assert_unchanged(owner, before)

    def test_short_call_cannot_consume_another_open_orders_reserved_shares(self):
        owner, controller, _, request = filled_option()
        other = order_record("OTHER-call", shares={"ABC": "1"})
        other["submissionKey"] = "other-held-order"
        # Deliberate collateral drift fixture: the release boundary must stop
        # even when an injected verifier wrongly returns true for stale lots.
        owner.journal.state["orders"]["other-held-order"] = other
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)
        self.assert_unchanged(owner, before)

    def test_short_put_cannot_consume_other_reserved_cash_or_unsettled_credit(self):
        for other_hold in (False, True):
            with self.subTest(other_hold=other_hold):
                initial_cash = "20002" if other_hold else "20001"
                owner, controller, _, request = filled_option(right="put", price="95", cash=initial_cash, shares="0")
                if other_hold:
                    other = order_record("OTHER", cash_reserve="1")
                    other["submissionKey"] = "other-held-order"
                    owner.journal.state["orders"]["other-held-order"] = other
                # Without the other hold, the second fixture has exactly enough
                # settled cash for delivery+fee. Premium remains unavailable.
                before = owner.journal.snapshot()
                with self.assertRaises(ExecutionError):
                    controller.settle_options(KEY, (settle_option(request, option_policy()),), evidence_sha256=HASH, now_ns=DUE)
                self.assert_unchanged(owner, before)
                self.assertEqual(owner.journal.state["unsettledCredits"][KEY + ":fill:1"], "1000")

    def test_duplicate_option_settlement_never_releases_or_credits_twice(self):
        owner, controller, _, request = filled_option()
        event = settle_option(request, option_policy())
        controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.settle_options(KEY, (event,), evidence_sha256=HASH, now_ns=DUE)
        self.assert_unchanged(owner, before)

    def test_requalification_requires_evidence_and_does_not_unpause_new_risk(self):
        owner = new_owner()
        owner.journal.append("qualification-invalidated", {"instrumentId": "ABC"}, now_ns=FILL_TIME,
                             event_id="qualification-invalidated:1")
        evidence = QualifiedEvidence()
        controller = SettlementController(owner, evidence)
        evidence.requalification_result = False
        before = owner.journal.snapshot()
        with self.assertRaises(ExecutionError):
            controller.restore_qualification("ABC", previous_evidence_sha256=HASH,
                                             replacement_evidence_sha256=PAYLOAD, now_ns=DUE)
        self.assert_unchanged(owner, before)
        evidence.requalification_result = True
        controller.restore_qualification("ABC", previous_evidence_sha256=HASH,
                                         replacement_evidence_sha256=PAYLOAD, now_ns=DUE)
        self.assertEqual(owner.journal.state["invalidQualifications"], [])
        self.assertTrue(owner.journal.state["pausedNewRisk"])
        self.assertFalse(owner.journal.state["reconciled"])


class NativeSettlementSpendabilityTests(unittest.TestCase):
    def risk_fixture(self, owner, positions):
        authority = owner.authority
        intent = {"side": "buy"}
        admission = {"accountAlias": "paper-account", "idempotencyKey": "risk-check:1", "strategyVersion": "immutable-strategy:1"}
        inputs = QualifiedRiskInputs({}, ({"intent_hash": authority.digest(intent)},), tuple(positions), HASH)

        class Evidence:
            def resolve(self, **kwargs):
                return inputs

            def verify(self, value, **kwargs):
                return value is inputs

        class CaptureNativeRequest(RuntimeError):
            pass

        captured = []

        def evaluate(encoded):
            captured.append(json.loads(encoded))
            raise CaptureNativeRequest()

        risk = NativeRiskPort(authority=authority, evaluate=evaluate, evidence=Evidence(), journal_id="journal:1")
        arguments = {"intent": intent, "admission": admission, "strategy": {}, "ledger": owner.journal.state,
                     "ledger_sequence": owner.journal.sequence, "ledger_sha256": owner.journal.event_hash, "now_ns": FILL_TIME + 1}
        return risk, arguments, captured, CaptureNativeRequest

    def test_native_adapter_rejects_unsettled_shares_even_when_evidence_claims_settled(self):
        owner = new_owner(shares="0")
        seed_fill(owner, "ABC", side="buy", quantity="10", cash_delta="-100", settlement_required=False)
        risk, arguments, captured, _ = self.risk_fixture(owner, [{"instrument_id": "ABC", "quantity": "10", "settled_quantity": "10"}])
        with self.assertRaisesRegex(ExecutionError, "native-evidence-spends-unsettled-shares"):
            risk.assess(**arguments)
        self.assertEqual(captured, [])

    def test_native_adapter_passes_only_settled_cash_not_unsettled_sale_proceeds(self):
        owner = new_owner(shares="10")
        seed_fill(owner, "ABC", side="sell", quantity="1", cash_delta="100", settlement_required=False)
        risk, arguments, captured, stop = self.risk_fixture(owner, [{"instrument_id": "ABC", "quantity": "9", "settled_quantity": "9"}])
        with self.assertRaises(stop):
            risk.assess(**arguments)
        self.assertEqual(captured[0]["journal"]["settled_cash"], "29999")
        self.assertEqual(owner.journal.state["unsettledCredits"][KEY + ":fill:1"], "100")

    def test_native_adapter_accepts_share_maturity_only_after_qualified_trade_settlement(self):
        owner = new_owner(shares="0")
        fill_key = seed_fill(owner, "ABC", side="buy", quantity="10", cash_delta="-100", settlement_required=False)
        controller = SettlementController(owner, QualifiedEvidence())
        controller.settle_trades(trade_proof(fill_key), now_ns=DUE)
        risk, arguments, captured, stop = self.risk_fixture(owner, [{"instrument_id": "ABC", "quantity": "10", "settled_quantity": "10"}])
        arguments["now_ns"] = DUE
        with self.assertRaises(stop):
            risk.assess(**arguments)
        self.assertEqual(captured[0]["journal"]["positions"][0]["settled_quantity"], "10")
        self.assertEqual(owner.journal.state["unsettledPositions"], {})


if __name__ == "__main__":
    unittest.main()
